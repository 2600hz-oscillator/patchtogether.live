/* snes9x_bridge.c
 *
 * Minimal libretro frontend + Emscripten export bridge around the vendored
 * snes9x2005 (CAT SFC) libretro core (MIT, libretro team relicense — see
 * ./copyright). Mirrors the doomgeneric integration shape: a tiny C shim
 * that implements the host-side libretro callbacks (environ / video /
 * audio / input / poll) and exposes a handful of EMSCRIPTEN_KEEPALIVE
 * functions the TS runtime (snes9x-runtime.ts) drives:
 *
 *   snes_init()                       - one-time core init
 *   snes_load_rom(ptr, len)           - load a .sfc/.smc ROM from a WASM
 *                                       heap blob (LOAD_FROM_MEMORY path);
 *                                       returns 1 on success, 0 on failure
 *   snes_run_frame()                  - advance one emulated frame; fills the
 *                                       framebuffer + audio ring
 *   snes_get_framebuffer()            - ptr to a packed RGBA8888 256x224
 *                                       (or 256x239) framebuffer (host-
 *                                       converted from the core's RGB565)
 *   snes_get_fb_width()/height()      - current rendered dimensions
 *   snes_get_audio_buffer()           - ptr to interleaved S16 stereo audio
 *                                       written THIS frame
 *   snes_get_audio_frames()           - # stereo frames written this frame
 *   snes_set_input(mask)              - set the player-1 joypad button mask
 *                                       (bit layout = RETRO_DEVICE_ID_JOYPAD_*)
 *   snes_get_wram()                   - ptr to the 128 KB SNES WRAM
 *                                       (Memory.RAM == retro_get_memory_data(
 *                                        RETRO_MEMORY_SYSTEM_RAM)); REQUIRED
 *                                       for game-event detection
 *   snes_read_wram(addr)              - read one WRAM byte (addr & 0x1FFFF)
 *
 * The WRAM pointer is the load-bearing piece for the SNES9X module's
 * CV/GATE game-event outputs: the TS side reads documented SMW RAM
 * addresses ($7E.... -> WRAM offset addr & 0x1FFFF) every frame to detect
 * kills/deaths/level changes.
 *
 * Video LOCK: we always present 256-wide frames at the core's native
 * height (224 or 239), upconverted from RGB565 to RGBA8888 so the JS side
 * can upload straight to a GL texture. No user-facing video-mode control.
 *
 * Audio LOCK: the core runs at 32 kHz stereo S16 (Settings.SoundPlaybackRate
 * = 32000); we forward whatever the core's audio_batch_cb emits per frame.
 */

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include <libretro.h>
#include <emscripten.h>

#include "source/snes9x.h"
#include "source/memmap.h"

/* --- libretro symbols implemented by the vendored core (libretro.c) --- */
extern void retro_init(void);
extern void retro_deinit(void);
extern void retro_set_environment(retro_environment_t);
extern void retro_set_video_refresh(retro_video_refresh_t);
extern void retro_set_audio_sample(retro_audio_sample_t);
extern void retro_set_audio_sample_batch(retro_audio_sample_batch_t);
extern void retro_set_input_poll(retro_input_poll_t);
extern void retro_set_input_state(retro_input_state_t);
extern bool retro_load_game(const struct retro_game_info*);
extern void retro_run(void);
extern void* retro_get_memory_data(unsigned);
extern size_t retro_get_memory_size(unsigned);

/* --- Frame buffers exposed to JS --- */
#define SNES_W 256
#define SNES_H_MAX 239
static uint32_t s_fb[SNES_W * SNES_H_MAX]; /* RGBA8888, host-converted */
static int s_fb_w = SNES_W;
static int s_fb_h = 224;

/* Audio: interleaved S16 stereo. One frame at 32 kHz / 60 fps is ~534
 * stereo frames; cap generously. */
#define SNES_AUDIO_CAP 4096
static int16_t s_audio[SNES_AUDIO_CAP * 2];
static int s_audio_frames = 0;

/* Player-1 joypad mask (RETRO_DEVICE_ID_JOYPAD_* bit positions). */
static int16_t s_input_mask = 0;

static int s_rom_loaded = 0;

/* --- libretro frontend callbacks --- */

static bool env_cb(unsigned cmd, void* data)
{
   switch (cmd)
   {
      case RETRO_ENVIRONMENT_GET_CAN_DUPE:
         if (data) *(bool*)data = true;
         return true;
      case RETRO_ENVIRONMENT_SET_PIXEL_FORMAT:
         /* Force RGB565 — the core prefers it and our converter assumes it. */
         return data && (*(enum retro_pixel_format*)data == RETRO_PIXEL_FORMAT_RGB565);
      case RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY:
      case RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY:
         if (data) *(const char**)data = ".";
         return true;
      case RETRO_ENVIRONMENT_GET_VARIABLE:
      {
         /* No core options — return NULL so the core uses its defaults. */
         if (data) ((struct retro_variable*)data)->value = NULL;
         return false;
      }
      case RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE:
         if (data) *(bool*)data = false;
         return true;
      case RETRO_ENVIRONMENT_GET_AUDIO_VIDEO_ENABLE:
         /* bit0 = video, bit1 = audio. Enable both, no hard-disable. */
         if (data) *(int*)data = 0x3;
         return true;
      default:
         return false;
   }
}

/* RGB565 -> RGBA8888. The core emits a pitch-strided buffer; honour pitch. */
static void video_refresh(const void* data, unsigned width, unsigned height, size_t pitch)
{
   if (!data) return; /* duped frame — keep the previous framebuffer */
   if (width > SNES_W) width = SNES_W;
   if (height > SNES_H_MAX) height = SNES_H_MAX;
   s_fb_w = (int)width;
   s_fb_h = (int)height;

   const uint8_t* src = (const uint8_t*)data;
   for (unsigned y = 0; y < height; y++)
   {
      const uint16_t* row = (const uint16_t*)(src + y * pitch);
      uint32_t* out = &s_fb[y * SNES_W];
      for (unsigned x = 0; x < width; x++)
      {
         uint16_t p = row[x];
         uint32_t r = (p >> 11) & 0x1F;
         uint32_t g = (p >> 5) & 0x3F;
         uint32_t b = p & 0x1F;
         /* 5/6-bit -> 8-bit with bit replication for full-range. */
         r = (r << 3) | (r >> 2);
         g = (g << 2) | (g >> 4);
         b = (b << 3) | (b >> 2);
         /* RGBA little-endian = 0xAABBGGRR. */
         out[x] = 0xFF000000u | (b << 16) | (g << 8) | r;
      }
   }
}

static void audio_sample(int16_t left, int16_t right)
{
   if (s_audio_frames >= SNES_AUDIO_CAP) return;
   s_audio[s_audio_frames * 2] = left;
   s_audio[s_audio_frames * 2 + 1] = right;
   s_audio_frames++;
}

static size_t audio_sample_batch(const int16_t* data, size_t frames)
{
   if (s_audio_frames + (int)frames > SNES_AUDIO_CAP)
      frames = SNES_AUDIO_CAP - s_audio_frames;
   if (frames > 0)
   {
      memcpy(&s_audio[s_audio_frames * 2], data, frames * 2 * sizeof(int16_t));
      s_audio_frames += (int)frames;
   }
   return frames;
}

static void input_poll(void) { /* state set via snes_set_input */ }

static int16_t input_state(unsigned port, unsigned device, unsigned index, unsigned id)
{
   (void)device; (void)index;
   if (port != 0) return 0;
   if (id == RETRO_DEVICE_ID_JOYPAD_MASK) return s_input_mask;
   return (s_input_mask >> id) & 1;
}

/* --- Exported API --- */

EMSCRIPTEN_KEEPALIVE
void snes_init(void)
{
   retro_set_environment(env_cb);
   retro_set_video_refresh(video_refresh);
   retro_set_audio_sample(audio_sample);
   retro_set_audio_sample_batch(audio_sample_batch);
   retro_set_input_poll(input_poll);
   retro_set_input_state(input_state);
   retro_init();
}

EMSCRIPTEN_KEEPALIVE
int snes_load_rom(uint8_t* ptr, int len)
{
   struct retro_game_info info;
   memset(&info, 0, sizeof(info));
   info.data = ptr;
   info.size = (size_t)len;
   info.path = "game.sfc";
   s_rom_loaded = retro_load_game(&info) ? 1 : 0;
   return s_rom_loaded;
}

EMSCRIPTEN_KEEPALIVE
int snes_rom_loaded(void) { return s_rom_loaded; }

EMSCRIPTEN_KEEPALIVE
void snes_run_frame(void)
{
   if (!s_rom_loaded) return;
   s_audio_frames = 0;
   retro_run();
}

EMSCRIPTEN_KEEPALIVE uint32_t* snes_get_framebuffer(void) { return s_fb; }
EMSCRIPTEN_KEEPALIVE int snes_get_fb_width(void) { return s_fb_w; }
EMSCRIPTEN_KEEPALIVE int snes_get_fb_height(void) { return s_fb_h; }

EMSCRIPTEN_KEEPALIVE int16_t* snes_get_audio_buffer(void) { return s_audio; }
EMSCRIPTEN_KEEPALIVE int snes_get_audio_frames(void) { return s_audio_frames; }

EMSCRIPTEN_KEEPALIVE
void snes_set_input(int mask) { s_input_mask = (int16_t)mask; }

EMSCRIPTEN_KEEPALIVE
uint8_t* snes_get_wram(void)
{
   return (uint8_t*)retro_get_memory_data(RETRO_MEMORY_SYSTEM_RAM);
}

EMSCRIPTEN_KEEPALIVE
int snes_get_wram_size(void)
{
   return (int)retro_get_memory_size(RETRO_MEMORY_SYSTEM_RAM);
}

EMSCRIPTEN_KEEPALIVE
int snes_read_wram(int addr)
{
   uint8_t* ram = (uint8_t*)retro_get_memory_data(RETRO_MEMORY_SYSTEM_RAM);
   if (!ram) return 0;
   return ram[addr & 0x1FFFF];
}
