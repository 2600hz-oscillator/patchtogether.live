//
// Copyright(C) 1993-1996 Id Software, Inc.
// Copyright(C) 2005-2014 Simon Howard
// Copyright(C) 2008 David Flater
// Copyright(C) 2026 patchtogether.live contributors
//
// This program is free software; you can redistribute it and/or
// modify it under the terms of the GNU General Public License
// as published by the Free Software Foundation; either version 2
// of the License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// DESCRIPTION:
//     Portable PCM mixer for the patchtogether.live DOOM video module.
//
//     This is a from-scratch reimplementation of the chocolate-doom
//     i_sdlsound.c sound module, stripped of SDL/SDL_mixer dependencies
//     and reduced to the bare minimum the doomgeneric core needs:
//
//       * Implements the sound_module_t interface (i_sound.h) so it
//         drops into doomgeneric's I_InitSound dispatch unchanged.
//       * Reads DMX-format sound lumps directly from the WAD (3-byte
//         format header + uint16 sample rate + uint32 sample count +
//         16 bytes padding + 8-bit unsigned PCM).
//       * Mixes 8 channels (Doom standard NUM_CHANNELS) into an
//         internal ring buffer at 44100 Hz mono, linearly resampling
//         from each sample's native rate (usually 11025 Hz).
//       * Exposes a single pull-style entry point dg_get_pcm_buffer()
//         that the JS layer (AudioWorklet pump) calls each audio
//         callback to drain frames into Web Audio output.
//
//     Music is NOT implemented in this slice — DG_music_module is a
//     no-op stub. Adding MUS/MIDI playback is an open follow-up.
//
//     The implementation deliberately avoids libsamplerate, allocators
//     outside of doomgeneric's Z_Malloc, and any threading primitives
//     (Emscripten's main-thread WASM model doesn't need them).
//
//     Why a fresh impl instead of vendoring i_sdlsound.c verbatim?
//
//       1. i_sdlsound.c is 1076 lines of tightly-coupled SDL_mixer +
//          libsamplerate code. Stripping the SDL bits leaves <40% of
//          the file and a confusing diff.
//       2. We don't need SDL_mixer's many-channel mixer — Doom only
//          opens 8 channels in vanilla play.
//       3. We don't need libsamplerate's high-quality resampler —
//          DOOM SFX are 11025 Hz "blocky" by design.
//
// PUBLIC C ENTRY POINTS (export via build-doom-wasm.sh):
//
//   void dg_get_pcm_buffer(int16_t* dest, int frames);
//     Drain `frames` mono samples (interleaved channels NOT used; we
//     emit mono — Doom's vanilla mixer is mono) from the internal
//     ring buffer into `dest`. Underrun pads with zeros. Called from
//     the JS-side AudioWorklet's audio callback at audio-callback
//     cadence (typically 128 frames / 2.9 ms at 44100 Hz).
//
// LICENSE
//   GPLv2 (or any later), matching the rest of doomgeneric.
//

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

#include "config.h"
#include "doomtype.h"
#include "i_sound.h"
#include "i_system.h"
#include "deh_str.h"
#include "m_misc.h"
#include "w_wad.h"
#include "z_zone.h"

#ifndef NUM_CHANNELS
#define NUM_CHANNELS 8
#endif

// Output sample rate must match the AudioContext on the JS side. 44100
// is what the browser uses by default; if/when we expose a knob, the
// number lives here AND in the JS-side AudioContext construction —
// keep them in lockstep.
#define DG_OUTPUT_RATE 44100

// Ring buffer that mixed samples accumulate into. The audio callback
// drains it; if the JS side falls behind we overwrite the head (loss
// is preferable to OOM on a stuck tab). Sized for ~46 ms at 44100 Hz —
// long enough to absorb a janky video frame, short enough that latency
// stays gameplay-tolerable. (~2048 samples = 46.4 ms.)
#define DG_RING_FRAMES 2048
static int16_t s_ring[DG_RING_FRAMES];
static int s_ring_write = 0;  // next write index (mixer side)
static int s_ring_read = 0;   // next read index (callback side)

// Per-channel mixing state. We hold a pointer to the original sound
// data (cached via Z_Malloc + ChangeTag so it survives until purged)
// and a fractional read cursor that advances by (src_rate / output_rate)
// each output frame.
typedef struct
{
    sfxinfo_t *sfxinfo;        // backref for I_SoundIsPlaying
    const uint8_t *pcm;        // 8-bit unsigned PCM, points into WAD lump cache
    int length;                // total source-rate sample count
    double pos;                // fractional read cursor (source-rate samples)
    double rate_ratio;         // src_rate / DG_OUTPUT_RATE
    int active;                // 1 = playing, 0 = idle slot
    int volume_l;              // 0..127 (post-pan)
    int volume_r;              // 0..127 (post-pan; we still mix MONO, see note)
} dg_channel_t;

// NOTE: stereo separation. Vanilla Doom honours `sep` (0..254, 128 =
// centre) by panning per-channel between L/R amplitude. We compute the
// L/R gains but then COLLAPSE TO MONO at the output stage — the
// patchtogether.live audio bridge currently publishes a single
// AudioNode per port (stereo would mean two), and we duplicate the
// mono mix into both L and R on the JS side. When/if we upgrade the
// bridge to native stereo, the volume_l / volume_r values are already
// right — just write to two ring buffers instead of one. For now we
// average the L/R gain so panning at least affects total amplitude.

static dg_channel_t s_channels[NUM_CHANNELS];
static boolean s_use_sfx_prefix = true;
static boolean s_initialized = false;

// i_sound.c's I_BindSoundVariables() references these under
// #ifdef FEATURE_SOUND. They're conventional config knobs from the
// libsamplerate path in chocolate-doom's i_sdlsound.c; we don't honour
// them (we use a simple linear resampler) but we define them so the
// M_BindVariable call links cleanly.
int use_libsamplerate = 0;
float libsamplerate_scale = 0.65f;

// ---------------- WAD lump → channel ----------------

static void GetSfxLumpName(sfxinfo_t *sfx, char *buf, size_t buf_len)
{
    if (sfx->link != NULL) sfx = sfx->link;
    if (s_use_sfx_prefix)
    {
        M_snprintf(buf, buf_len, "ds%s", DEH_String(sfx->name));
    }
    else
    {
        M_StringCopy(buf, DEH_String(sfx->name), buf_len);
    }
}

static int I_PcmGen_GetSfxLumpNum(sfxinfo_t *sfx)
{
    char namebuf[9];
    GetSfxLumpName(sfx, namebuf, sizeof(namebuf));
    return W_GetNumForName(namebuf);
}

// Decode a DMX sound lump header.
// Returns 1 on success + fills out_*. Returns 0 if the lump is too short
// or carries an unknown format code (we silently skip — chocolate-doom
// also tolerates this).
//
// DMX lump layout (little-endian):
//   uint16  format    (3 = unsigned 8-bit PCM)
//   uint16  rate      (samples per second)
//   uint32  num       (total sample count, INCLUDING 16-byte head + tail pad)
//   byte    padding[16]   (silence — undocumented header pad)
//   byte    pcm[num - 32]
//   byte    padding[16]   (silence tail pad)
//
// We tolerate lumps where `num` already excludes the padding (some PWADs
// in the wild do this); if num + 8 > lump_len we treat num as the raw
// payload size and skip the pad math.
static int DecodeDmxHeader(const uint8_t *lump, int lump_len,
                           int *out_rate, const uint8_t **out_pcm,
                           int *out_pcm_len)
{
    if (lump_len < 8) return 0;
    int format = lump[0] | (lump[1] << 8);
    int rate = lump[2] | (lump[3] << 8);
    int num = lump[4] | (lump[5] << 8) | (lump[6] << 16) | (lump[7] << 24);
    if (format != 3) return 0;
    if (rate <= 0 || rate > 192000) return 0;

    int header = 8;
    int pad_head = 16;
    int pad_tail = 16;
    int payload_off = header + pad_head;
    int payload_len = num - pad_head - pad_tail;

    // Defensive: if the declared `num` exceeds the lump we have, fall
    // back to "use everything after the 8-byte header".
    if (payload_off + payload_len > lump_len)
    {
        payload_off = header;
        payload_len = lump_len - header;
    }
    if (payload_len <= 0) return 0;

    *out_rate = rate;
    *out_pcm = lump + payload_off;
    *out_pcm_len = payload_len;
    return 1;
}

// Vol/sep → per-side gain. Replicates chocolate-doom's vanilla formula:
// volume in [0..127], sep in [0..254] with 128 = centre. Output gains
// stay in [0..127] — we apply them in MixOneFrame.
static void ComputePanGains(int vol, int sep, int *out_l, int *out_r)
{
    if (vol < 0) vol = 0;
    if (vol > 127) vol = 127;
    if (sep < 0) sep = 0;
    if (sep > 254) sep = 254;

    int left = vol * (254 - sep) / 254;
    int right = vol * sep / 254;
    if (left < 0) left = 0;
    if (right < 0) right = 0;
    *out_l = left;
    *out_r = right;
}

// ---------------- sound_module_t implementation ----------------

static boolean I_PcmGen_InitSound(boolean use_sfx_prefix)
{
    s_use_sfx_prefix = use_sfx_prefix;
    memset(s_channels, 0, sizeof(s_channels));
    memset(s_ring, 0, sizeof(s_ring));
    s_ring_read = 0;
    s_ring_write = 0;
    s_initialized = true;
    return true;
}

static void I_PcmGen_ShutdownSound(void)
{
    if (!s_initialized) return;
    memset(s_channels, 0, sizeof(s_channels));
    s_initialized = false;
}

static int I_PcmGen_StartSound(sfxinfo_t *sfxinfo, int channel,
                               int vol, int sep)
{
    if (!s_initialized || channel < 0 || channel >= NUM_CHANNELS)
    {
        return -1;
    }
    if (sfxinfo == NULL) return -1;

    // Resolve the lump.
    int lumpnum = sfxinfo->lumpnum;
    if (lumpnum < 0) return -1;
    int lump_len = W_LumpLength(lumpnum);
    if (lump_len <= 8) return -1;

    // Cache the lump bytes via Z_Malloc + PU_STATIC. We don't free per
    // channel-stop — the WAD cache treats this as a normal lump cache
    // entry; the zone allocator purges on memory pressure.
    const uint8_t *lump = (const uint8_t *)W_CacheLumpNum(lumpnum, PU_STATIC);
    int rate;
    const uint8_t *pcm;
    int pcm_len;
    if (!DecodeDmxHeader(lump, lump_len, &rate, &pcm, &pcm_len))
    {
        return -1;
    }

    int vl, vr;
    ComputePanGains(vol, sep, &vl, &vr);

    dg_channel_t *ch = &s_channels[channel];
    ch->sfxinfo = sfxinfo;
    ch->pcm = pcm;
    ch->length = pcm_len;
    ch->pos = 0.0;
    ch->rate_ratio = (double)rate / (double)DG_OUTPUT_RATE;
    ch->volume_l = vl;
    ch->volume_r = vr;
    ch->active = 1;
    return channel;
}

static void I_PcmGen_StopSound(int channel)
{
    if (channel < 0 || channel >= NUM_CHANNELS) return;
    s_channels[channel].active = 0;
    s_channels[channel].sfxinfo = NULL;
}

static boolean I_PcmGen_SoundIsPlaying(int channel)
{
    if (channel < 0 || channel >= NUM_CHANNELS) return false;
    return s_channels[channel].active != 0;
}

static void I_PcmGen_UpdateSoundParams(int channel, int vol, int sep)
{
    if (channel < 0 || channel >= NUM_CHANNELS) return;
    if (!s_channels[channel].active) return;
    int vl, vr;
    ComputePanGains(vol, sep, &vl, &vr);
    s_channels[channel].volume_l = vl;
    s_channels[channel].volume_r = vr;
}

// Render up to `frames` mono int16 samples into the ring buffer. We
// stop early if the ring fills (the audio callback will get whatever's
// available). Called from I_PcmGen_UpdateSound, which doomgeneric
// invokes once per tic (35 Hz).
static void MixIntoRing(int frames)
{
    for (int f = 0; f < frames; f++)
    {
        int next_write = (s_ring_write + 1) % DG_RING_FRAMES;
        if (next_write == s_ring_read)
        {
            // Ring full — stop mixing; the callback hasn't drained yet.
            // Better to leave the buffer "fresh" than overwrite.
            return;
        }

        int32_t accum = 0;
        for (int c = 0; c < NUM_CHANNELS; c++)
        {
            dg_channel_t *ch = &s_channels[c];
            if (!ch->active) continue;
            int idx = (int)ch->pos;
            if (idx >= ch->length)
            {
                ch->active = 0;
                ch->sfxinfo = NULL;
                continue;
            }
            // Linear interpolate between consecutive 8-bit unsigned samples.
            // Range: 0..255 → centre at 128 → signed [-128..127].
            int s0 = (int)ch->pcm[idx] - 128;
            int s1 = (idx + 1 < ch->length)
                ? ((int)ch->pcm[idx + 1] - 128)
                : s0;
            double frac = ch->pos - (double)idx;
            double sample = s0 + (s1 - s0) * frac;

            // Mono mix: average L and R pan-weighted contributions.
            // (See "stereo separation" note at top.)
            int gain = (ch->volume_l + ch->volume_r) / 2;
            accum += (int32_t)(sample * gain);

            ch->pos += ch->rate_ratio;
        }

        // accum range: NUM_CHANNELS * 128 * 127 ≈ 130k → fits int16 only
        // after a divide. We shift down by 6 (≈ /64) so a single channel
        // at full volume is ~127*128/64 ≈ 254 — comfortably below int16
        // clipping and giving headroom for 8 simultaneous channels.
        int32_t out = accum >> 6;
        if (out > 32767) out = 32767;
        if (out < -32768) out = -32768;
        s_ring[s_ring_write] = (int16_t)out;
        s_ring_write = next_write;
    }
}

static void I_PcmGen_UpdateSound(void)
{
    if (!s_initialized) return;
    // Compute how much room is in the ring; mix that much. doomgeneric
    // calls us at 35 Hz (one tic), so we want to top up about 1260
    // samples per call (44100 / 35) — but ring fill depends on JS drain
    // cadence, so we drive to "ring half-full or as much as fits".
    int used = (s_ring_write - s_ring_read + DG_RING_FRAMES) % DG_RING_FRAMES;
    int free_slots = DG_RING_FRAMES - 1 - used;
    int target = DG_RING_FRAMES / 2;
    int to_mix = (free_slots < target) ? free_slots : target;
    if (to_mix > 0) MixIntoRing(to_mix);
}

static void I_PcmGen_CacheSounds(sfxinfo_t *sounds, int num_sounds)
{
    // Pre-resolve lump numbers. Lazy-load PCM on first play — a full
    // precache of all 100ish vanilla SFX would touch ~1 MB of WAD that
    // many users never trigger.
    char namebuf[9];
    for (int i = 0; i < num_sounds; i++)
    {
        GetSfxLumpName(&sounds[i], namebuf, sizeof(namebuf));
        sounds[i].lumpnum = W_CheckNumForName(namebuf);
    }
}

// ---------------- Exports + module table ----------------

static snddevice_t s_sound_devices[] =
{
    SNDDEVICE_SB,
    SNDDEVICE_PAS,
    SNDDEVICE_GUS,
    SNDDEVICE_WAVEBLASTER,
    SNDDEVICE_SOUNDCANVAS,
    SNDDEVICE_AWE32,
};

sound_module_t DG_sound_module =
{
    s_sound_devices,
    (int)(sizeof(s_sound_devices) / sizeof(*s_sound_devices)),
    I_PcmGen_InitSound,
    I_PcmGen_ShutdownSound,
    I_PcmGen_GetSfxLumpNum,
    I_PcmGen_UpdateSound,
    I_PcmGen_UpdateSoundParams,
    I_PcmGen_StartSound,
    I_PcmGen_StopSound,
    I_PcmGen_SoundIsPlaying,
    I_PcmGen_CacheSounds,
};

// Stub music module so i_sound.c finds the symbol it expects when
// FEATURE_SOUND is defined. Music output is a follow-up (MUS/MIDI
// requires a soft synth — OPL emulator or a portable equivalent).
static snddevice_t s_music_devices[] =
{
    SNDDEVICE_PAS, SNDDEVICE_GUS, SNDDEVICE_WAVEBLASTER,
    SNDDEVICE_SOUNDCANVAS, SNDDEVICE_AWE32, SNDDEVICE_GENMIDI,
};
static boolean I_DG_MusicInit(void) { return true; }
static void I_DG_MusicShutdown(void) { }
static void I_DG_MusicSetVolume(int v) { (void)v; }
static void I_DG_MusicPause(void) { }
static void I_DG_MusicResume(void) { }
static void *I_DG_MusicRegister(void *d, int l) { (void)d; (void)l; return NULL; }
static void I_DG_MusicUnregister(void *h) { (void)h; }
static void I_DG_MusicPlay(void *h, boolean loop) { (void)h; (void)loop; }
static void I_DG_MusicStop(void) { }
static boolean I_DG_MusicIsPlaying(void) { return false; }
static void I_DG_MusicPoll(void) { }

music_module_t DG_music_module =
{
    s_music_devices,
    (int)(sizeof(s_music_devices) / sizeof(*s_music_devices)),
    I_DG_MusicInit,
    I_DG_MusicShutdown,
    I_DG_MusicSetVolume,
    I_DG_MusicPause,
    I_DG_MusicResume,
    I_DG_MusicRegister,
    I_DG_MusicUnregister,
    I_DG_MusicPlay,
    I_DG_MusicStop,
    I_DG_MusicIsPlaying,
    I_DG_MusicPoll,
};

// ---------------- JS-facing exports ----------------

// Drain `frames` mono int16 samples from the ring into `dest`. Pads
// with silence on underrun. Called by the JS-side AudioWorklet pump
// each audio callback.
//
// Returns the number of frames actually drawn from live mixer output
// (the rest is silent). Useful for the JS side to detect "we've never
// produced audio yet" vs "we're momentarily underrun".
int dg_get_pcm_buffer(int16_t *dest, int frames)
{
    if (!dest || frames <= 0) return 0;
    int produced = 0;
    for (int i = 0; i < frames; i++)
    {
        if (s_ring_read == s_ring_write)
        {
            dest[i] = 0;
            continue;
        }
        dest[i] = s_ring[s_ring_read];
        s_ring_read = (s_ring_read + 1) % DG_RING_FRAMES;
        produced++;
    }
    return produced;
}

// Convenience: how many frames are currently buffered. JS can use this
// to detect overruns + underruns; not required for normal operation.
int dg_get_pcm_buffered_frames(void)
{
    return (s_ring_write - s_ring_read + DG_RING_FRAMES) % DG_RING_FRAMES;
}

// Return the output sample rate (so the JS side doesn't have to keep
// a duplicated constant). The AudioContext init must match.
int dg_get_pcm_sample_rate(void)
{
    return DG_OUTPUT_RATE;
}
