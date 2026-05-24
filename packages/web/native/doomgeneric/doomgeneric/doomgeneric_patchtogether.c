// doomgeneric_patchtogether.c
//
// Platform shim for the patchtogether.live DOOM video module. Replaces the
// upstream doomgeneric_emscripten.c (which assumes SDL2 + SDL2_mixer +
// browser-owned input + browser-owned audio); we want a thin layer that
// just exposes raw frame + input + audio buffers to JavaScript so the
// VideoEngine can blit pixels into a GL texture, the keyboard listener can
// push key events, and (slice 8) the AudioWorklet can pull PCM samples.
//
// Public C API (all extern "C"-equivalent; the linker exports these via
// the EXPORTED_FUNCTIONS list in build-doom-wasm.sh):
//
//   void dgpt_init(int wad_len);
//     Caller has already written `wad_len` bytes of DOOM1.WAD into the
//     module's filesystem (Emscripten MEMFS path '/doom1.wad'). We call
//     doomgeneric_Create(2, ["doom", "-iwad", "/doom1.wad"]).
//
//   void dgpt_tick();
//     Run one game tick. Engine reads input from our queue (DG_GetKey),
//     paints into DG_ScreenBuffer (BGRA32 at 640x400), and audio samples
//     into our internal PCM ring buffer (slice 8 — disabled in v1).
//
//   uint8_t* dgpt_get_framebuffer();
//     Pointer to DG_ScreenBuffer (BGRA32 at DOOMGENERIC_RESX *
//     DOOMGENERIC_RESY * 4 bytes). The JS shim wraps a Uint8ClampedArray
//     view directly over WASM HEAPU8 starting at this offset (zero-copy).
//
//   int dgpt_get_framebuffer_size();
//     Convenience: DOOMGENERIC_RESX * DOOMGENERIC_RESY * 4. JS-side could
//     compute this from constants but exposing it via an export removes a
//     duplicated source-of-truth.
//
//   void dgpt_set_key(int doomkey, int pressed);
//     Push one key event into our queue. JS shim maps from KeyboardEvent
//     codes / CV-gate edges to the doomkeys.h constants and calls this.
//     The next dgpt_tick() drains the queue via DG_GetKey.
//
//   uint8_t* dgpt_get_pcm_buffer();
//     Pointer to our PCM ring buffer (Float32Array of N samples). Stub
//     in v1 — see slice-8 TODO at i_sound stubs below.
//
//   int dgpt_get_pcm_buffer_size();
//     Sample count of the PCM ring buffer. 0 in v1.
//
// Why a custom shim and not the upstream emscripten one?
//   1. Upstream requires SDL2 (mixer + video) — a 2 MB-ish runtime
//      dependency we don't want; we already own the rendering surface.
//   2. Upstream uses --preload-file doom1.wad — wires the WAD into the
//      .data sidecar at build time. We want runtime loading so users can
//      swap WADs later (open follow-up: user-WAD upload) without rebuilding.
//   3. Upstream couples input to SDL's main loop; we push key events from
//      JS (keyboard + CV gates + Yjs awareness relay), so a queue is the
//      right abstraction.
//
// The actual emcc invocation (build-doom-wasm.sh) lists this file
// alongside the upstream core .c files.

#include <stdlib.h>
#include <stdint.h>
#include <string.h>

#include "doomgeneric.h"
#include "doomkeys.h"

// ---- Key event queue ----
//
// Bounded ring buffer. Each event is two bytes: high bit = pressed,
// low 7 bits = doomkey. Lossy on overflow (oldest wins) — under normal
// human typing the queue never fills; under stress (held-key autorepeat
// + frame-rate stall) we'd rather drop than block.

#define DGPT_KEY_QUEUE_SIZE 256

static uint16_t s_key_queue[DGPT_KEY_QUEUE_SIZE];
static int s_key_q_head = 0;  // index of oldest entry (read here)
static int s_key_q_tail = 0;  // index of next free slot (write here)

static uint32_t s_ms_at_start = 0;  // wall-clock-equivalent base
static uint32_t s_ms_now = 0;       // bumped by DG_GetTicksMs via JS

void dgpt_set_key(int doomkey, int pressed) {
  uint16_t entry = (uint16_t)((doomkey & 0x7f) | ((pressed ? 1 : 0) << 7));
  int next_tail = (s_key_q_tail + 1) % DGPT_KEY_QUEUE_SIZE;
  if (next_tail == s_key_q_head) {
    // Full — drop oldest.
    s_key_q_head = (s_key_q_head + 1) % DGPT_KEY_QUEUE_SIZE;
  }
  s_key_queue[s_key_q_tail] = entry;
  s_key_q_tail = next_tail;
}

// ---- doomgeneric callbacks ----

void DG_Init() {
  // Nothing to do — the JS side already wrote the WAD into MEMFS before
  // calling dgpt_init.
}

void DG_DrawFrame() {
  // No-op: JS reads DG_ScreenBuffer directly via dgpt_get_framebuffer().
  // We don't blit ANYWHERE on the C side — that's the VideoEngine's job.
}

void DG_SleepMs(uint32_t ms) {
  // We can't actually block the JS thread — there's no syscall sleep
  // available from inside WASM. But doomgeneric's TryRunTics() spins
  // on I_Sleep(1) while waiting for the simulated wall-clock to
  // advance past the next tic boundary (see d_loop.c:784). With a
  // strictly-zero clock advance, that loop never exits and dgpt_init
  // hangs the whole browser tab during the WASM init path.
  //
  // The pragmatic fix: bump the virtual clock by `ms` here so that
  // `I_GetTime()` increases inside the spin loop and the wait exits
  // naturally. Net effect during init is the same as a real sleep
  // would have produced — wall-clock advances ~1 ms per spin — minus
  // the actual real-time delay, which we don't want anyway (we'd
  // rather complete init promptly and let the JS-driven dgpt_tick
  // drive subsequent frames at video rate).
  s_ms_now += ms;
}

uint32_t DG_GetTicksMs() {
  return s_ms_now - s_ms_at_start;
}

int DG_GetKey(int *pressed, unsigned char *doomKey) {
  if (s_key_q_head == s_key_q_tail) return 0;
  uint16_t entry = s_key_queue[s_key_q_head];
  s_key_q_head = (s_key_q_head + 1) % DGPT_KEY_QUEUE_SIZE;
  *pressed = (entry >> 7) & 0x1;
  *doomKey = (unsigned char)(entry & 0x7f);
  return 1;
}

void DG_SetWindowTitle(const char *title) {
  // No-op. The card UI shows our own title; engine's "DOOM" string is
  // not surfaced.
  (void)title;
}

// ---- WASM-side exports ----

extern pixel_t *DG_ScreenBuffer;

void dgpt_init(int wad_len) {
  (void)wad_len;  // Caller already wrote the file; size is for diagnostics
                  // (and will become relevant when we add user-WAD upload).
  s_ms_at_start = 0;
  s_ms_now = 0;
  // doomgeneric_Create takes argc/argv; we pretend we got "-iwad /doom1.wad".
  // argv lives in static storage so it outlives the call.
  static char arg0[] = "doom";
  static char arg1[] = "-iwad";
  static char arg2[] = "/doom1.wad";
  static char *argv[] = { arg0, arg1, arg2, NULL };
  doomgeneric_Create(3, argv);
}

void dgpt_tick() {
  doomgeneric_Tick();
}

void dgpt_advance_clock(uint32_t ms_delta) {
  // JS bumps the wall clock by `ms_delta` per video frame so the engine's
  // internal timing (tick rate, demo loop) tracks real time. Separate from
  // dgpt_tick because slice 8's audio path may want to advance the clock
  // at audio rate while ticking the game at video rate.
  s_ms_now += ms_delta;
}

uint8_t *dgpt_get_framebuffer() {
  return (uint8_t *)DG_ScreenBuffer;
}

int dgpt_get_framebuffer_size() {
  return DOOMGENERIC_RESX * DOOMGENERIC_RESY * 4;
}

int dgpt_get_resx() {
  return DOOMGENERIC_RESX;
}

int dgpt_get_resy() {
  return DOOMGENERIC_RESY;
}

// ---- Slice-8 audio stubs ----
//
// v1 ships with audio DISABLED — DOOM's i_sound.c is the upstream "null"
// implementation, no PCM is ever generated. When slice 8 lands we'll:
//   1. Wire i_sdlsound.c (or a fresh i_pcmgen.c) into the build
//   2. Have it write into the buffer below
//   3. Have the JS shim's AudioWorkletProcessor pull from this buffer at
//      audio rate
//
// For now these exist so the JS shim's API surface is stable (the audio
// output ports already declare audio_l/audio_r — they just push silence).

#define DGPT_PCM_BUFFER_SAMPLES 4096
static float s_pcm_buffer[DGPT_PCM_BUFFER_SAMPLES * 2];  // stereo

uint8_t *dgpt_get_pcm_buffer() {
  return (uint8_t *)s_pcm_buffer;
}

int dgpt_get_pcm_buffer_size() {
  return DGPT_PCM_BUFFER_SAMPLES;
}
