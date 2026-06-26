// bloodgeneric_patchtogether.cpp
//
// Platform shim for the patchtogether.live BLOOD video module — the NBlood
// analogue of doomgeneric/doomgeneric_patchtogether.c. It exposes a thin
// `bpt_*` ("Blood PatchTogether") C-export seam to JavaScript so the
// VideoEngine can blit Build's software-rendered framebuffer into a GL
// texture, the keyboard/CV listener can inject keys, and (later) an
// AudioWorklet can pull PCM.
//
// ───────────────────────────────────────────────────────────────────────
// WHY THIS DIFFERS FROM THE DOOM SHIM (the load-bearing design note)
//
// doomgeneric was *designed* with a cooperative per-tic seam
// (doomgeneric_Tick()): you call it once, it runs ONE tick + paints ONE
// frame + returns. NBlood is the full EDuke32/Build stack, and its entry
// point `app_main()` (source/blood/src/blood.cpp) is a BLOCKING main loop
// (`while (!gQuitGame) { …; videoNextPage(); }` with a `goto RESTART`).
// There is NO per-tic return seam.
//
// Two ways to drive a blocking loop a-frame-at-a-time from JS:
//   (A) Refactor app_main into a step function — enormous, fragile surgery
//       on a 15k-line file we don't own. Rejected.
//   (B) ASYNCIFY: compile with -sASYNCIFY so the C call stack can be
//       suspended/resumed across an emscripten_sleep(). We replace the
//       per-frame paint (videoShowFrame, called by videoNextPage) with a
//       version that snapshots the framebuffer + YIELDS back to JS. JS
//       resumes app_main for the next frame. This is the canonical way the
//       real EDuke32/Build web ports run.
//
// We take (B). The seam is:
//   bpt_init(rffLen)   → kick off app_main on the (asyncify) call stack.
//                        app_main runs until the FIRST videoShowFrame, where
//                        our shim snapshots the frame + suspends. Returns to
//                        JS with one frame ready (or with whatever pre-game
//                        screen the engine reached if data is missing).
//   bpt_tick()         → resume app_main; it runs exactly to the NEXT
//                        videoShowFrame, snapshots, suspends, returns.
//   bpt_get_framebuffer() → RGBA8 dest buffer (xdim*ydim*4), produced by
//                        softsurface_blitBuffer into our own buffer (so the
//                        accessor is SDL-independent — the doomgeneric
//                        DG_ScreenBuffer analogue).
//   bpt_get_resx/resy()  → current xdim/ydim.
//   bpt_set_key(sc, down) → push a Build scancode event into our queue,
//                        drained by our handleevents replacement.
//
// PLATFORM LAYER: we KEEP emscripten's SDL2 port (-sUSE_SDL=2), which the
// Phase-0 spike proved resolves NBlood's SDL-typed mutex/video/audio/input
// layer with no shim. We do NOT replace sdlayer.cpp wholesale (unlike the
// DOOM shim replacing the SDL shim). Instead we OVERRIDE the two seam
// functions we need to intercept — videoShowFrame (frame snapshot + yield)
// — by compiling sdlayer.cpp with BLOOD_PT_SHIM defined so its
// videoShowFrame is renamed and ours wins. (See build-blood-wasm.sh.)
//
// SELF-MODIFYING-ASM WALL (PHASE0-STATUS.md §2.4): resolved upstream-free by
// building the whole engine with -DNOASM. That (1) compiles out
// baselayer.cpp's nx_unprotect/mprotect/#error block entirely
// (`#if !defined(NOASM)`), and (2) selects the portable C software
// rasteriser a-c.cpp via ENGINE_USING_A_C (a.h auto-defines it under NOASM).
// No manual stub of B_PROT_* needed.
//
// ASSETS: BLOOD.RFF / TILES000.ART / *.DAT are user-supplied (NOT
// redistributable — PHASE0-STATUS.md §3). JS writes them into MEMFS before
// bpt_init. With no data the engine reaches its pre-game/error screen, which
// still paints a frame — enough to validate the render path (the kill-gate).

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

// Build-engine public surface. These are C++ headers (the engine is C++);
// we are a .cpp TU so we include them directly (no extern "C" wrapper).
#include "compat.h"
#include "build.h"        // xdim, ydim, bpp, frameplace, …
#include "baselayer.h"    // videoShowFrame prototype
#include "softsurface.h"  // softsurface_blitBuffer / getBufferResolution / setPalette
#include "palette.h"      // curpalettefaded[256]

// app_main lives in blood.cpp.
extern int app_main(int argc, char const * const * argv);

// ───────────────────────── framebuffer snapshot ─────────────────────────
//
// Our own RGBA dest buffer, (re)allocated to match xdim*ydim. The engine's
// software renderer writes 8-bit paletted pixels into the softsurface; we
// blit them to RGBA on demand via softsurface_blitBuffer (the same call
// sdlayer's software path makes into the SDL surface). This is the
// SDL-independent DG_ScreenBuffer analogue.

static uint32_t *s_fb = nullptr;       // RGBA8 dest (xdim*ydim)
static int       s_fb_w = 0;
static int       s_fb_h = 0;
static int       s_have_frame = 0;

static void bpt_ensure_fb(int w, int h)
{
    if (w <= 0 || h <= 0) return;
    if (s_fb && s_fb_w == w && s_fb_h == h) return;
    free(s_fb);
    s_fb = (uint32_t *)malloc((size_t)w * (size_t)h * 4);
    s_fb_w = w;
    s_fb_h = h;
    if (s_fb) memset(s_fb, 0, (size_t)w * (size_t)h * 4);
}

// Snapshot the current software frame into s_fb as RGBA8. Called from our
// videoShowFrame override (below) every time the engine presents a frame.
static void bpt_snapshot_frame(void)
{
    // Only the 8-bit software path has a softsurface to read. (USE_OPENGL is
    // OFF in the BLOOD_LINK build, so bpp is always 8 here.)
    vec2_t res = softsurface_getBufferResolution();
    if (res.x <= 0 || res.y <= 0) return;
    bpt_ensure_fb(res.x, res.y);
    if (!s_fb) return;
    // RGBA byte order: red in low byte. softsurface masks select the byte
    // each component lands on; we want R=0x000000FF, G=0x0000FF00, B=0x00FF0000.
    softsurface_setPalette((void *)curpalettefaded, 0x000000FF, 0x0000FF00, 0x00FF0000);
    softsurface_blitBuffer(s_fb, 32);
    s_have_frame = 1;
}

// ───────────────────── videoShowFrame override (frame yield) ─────────────
//
// sdlayer.cpp is compiled with -DBLOOD_PT_SHIM which renames its
// videoShowFrame to videoShowFrame_sdl (see the build script's sed patch),
// so OUR videoShowFrame is the one the engine + videoNextPage call. We
// snapshot, then YIELD the asyncify stack back to JS so the module can
// upload the texture + the next bpt_tick resumes the loop.
extern "C" void videoShowFrame(int32_t w)
{
    (void)w;
    bpt_snapshot_frame();
#ifdef __EMSCRIPTEN__
    // Suspend the (blocking) app_main call stack and return control to JS.
    // The next bpt_tick() (which itself just returns into the resumed stack)
    // continues app_main from right here. 0ms = yield without real delay.
    emscripten_sleep(0);
#endif
}

// ───────────────────────────── input queue ──────────────────────────────
//
// Bounded ring of Build scancode events. Each entry: low 8 bits = scancode,
// bit 8 = pressed. Drained into KB_KeyDown[] by our handleevents tap. For
// the kill-gate (render-one-frame) input is inert; it exists so the JS API
// surface is stable for Phase-1 card wiring.

#define BPT_KEY_QUEUE_SIZE 256
static uint16_t s_keyq[BPT_KEY_QUEUE_SIZE];
static int s_keyq_head = 0;
static int s_keyq_tail = 0;

extern "C" void bpt_set_key(int scancode, int pressed)
{
    uint16_t e = (uint16_t)((scancode & 0xff) | ((pressed ? 1 : 0) << 8));
    int next = (s_keyq_tail + 1) % BPT_KEY_QUEUE_SIZE;
    if (next == s_keyq_head) s_keyq_head = (s_keyq_head + 1) % BPT_KEY_QUEUE_SIZE; // drop oldest
    s_keyq[s_keyq_tail] = e;
    s_keyq_tail = next;
}

// Drain queued keys. Phase-1 will route these into Build's keyboard state
// (mact keystatus[] / the CONTROL layer) so CV gates + the keyboard drive
// the marine. For the kill-gate (render-one-frame) input is inert, so we
// just clear the queue — keeping the bpt_set_key API surface stable for the
// card wiring without coupling the shim to the mact keyboard global yet.
static void bpt_drain_keys(void)
{
    s_keyq_head = s_keyq_tail;
}

// ───────────────────────────── bpt_* exports ────────────────────────────

static int s_app_started = 0;

// Boot the engine. JS has already written the user-supplied data files into
// MEMFS (/blood/…). We chdir there + start app_main. Under ASYNCIFY,
// app_main runs to the first videoShowFrame, snapshots a frame, and
// suspends — so this call "returns" (via the asyncify unwind) with one
// frame ready.
// engineSetupAllocator (baselayer.cpp) creates the smmalloc custom heap
// (g_sm_heap) that Xmalloc/Xstrdup route through. The real NBlood entry point
// calls it in the platform bootstrap BEFORE app_main. We bypass that bootstrap,
// so we MUST call it first — otherwise the very first allocation in app_main
// (OSD_SetLogFile → xstrdup → _sm_malloc(g_sm_heap=null)) faults. (Diagnosed:
// PHASE1-STATUS.md — "memory access out of bounds in sm::Allocator::Allocate".)
extern void engineSetupAllocator(void);

extern "C" void bpt_init(int rff_len)
{
    (void)rff_len;
    if (s_app_started) return;
    s_app_started = 1;
    engineSetupAllocator();   // create g_sm_heap before any Xmalloc/Xstrdup
    // argv lives in static storage so it outlives the (suspended) call.
    static char arg0[] = "blood";
    static char arg1[] = "-nosetup";
    static char *argv[] = { arg0, arg1, nullptr };
    app_main(2, argv);
}

// Resume the suspended app_main for ONE more presented frame. With ASYNCIFY,
// returning from bpt_init/bpt_tick unwinds to JS; calling bpt_tick again
// rewinds into app_main right after the emscripten_sleep(0) in our
// videoShowFrame, runs to the next videoShowFrame, snapshots, suspends.
extern "C" void bpt_tick(void)
{
    bpt_drain_keys();
    // No body needed: the asyncify rewind happens because app_main is still
    // on the (suspended) stack. bpt_tick is the JS re-entry point; the actual
    // continuation runs inside the resumed videoShowFrame. (If app_main has
    // exited, this is a harmless no-op.)
}

extern "C" uint8_t *bpt_get_framebuffer(void)
{
    return (uint8_t *)s_fb;
}

extern "C" int bpt_get_framebuffer_size(void)
{
    return s_fb_w * s_fb_h * 4;
}

extern "C" int bpt_get_resx(void) { return s_fb_w; }
extern "C" int bpt_get_resy(void) { return s_fb_h; }

// 1 once at least one frame has been presented. The headless harness asserts
// this + a non-empty framebuffer — the kill-gate.
extern "C" int bpt_has_frame(void) { return s_have_frame; }

// ───────────────────── platform symbols sdlayer expects ─────────────────
//
// These are normally provided by per-app / per-arch TUs we don't compile:
//   * sdlappicon  — the window icon, defined per-game (blood has its own art
//     source we don't ship). We provide an empty icon (sdlayer guards on the
//     pixels pointer, so a 0×0 icon is a harmless no-op on wasm).
//   * sysReadCPUID — x86 CPUID probe (cpuid.cpp, all inline asm; skipped on
//     wasm). sdlayer only logs the result; a zeroed struct is fine.

#include "sdlappicon.h"
extern "C" { struct sdlappicon sdlappicon = { 0, 0, nullptr }; }

// build_cpuid.h: `extern cpuinfo_t cpu;` + `void sysReadCPUID(void);` — both are
// normally defined in cpuid.cpp (all x86 inline asm, skipped on wasm). Provide
// the global + a no-op probe so sdlayer's (logged-only) CPU report links.
#include "build_cpuid.h"
cpuinfo_t cpu = {};
void sysReadCPUID(void) { /* no CPUID on wasm */ }

// connecthead / connectpoint2 — the Build engine's player-connection list,
// normally defined in mmulti.cpp (the netplay transport, which we DON'T link on
// wasm — Phase 1 is single-player). The Blood AI/actor code iterates connected
// players via these EVEN in single-player. We define them in the single-player
// state: one player (head 0), no next (terminator -1). Phase-2 MP will replace
// this with the real connection list driven by our lockstep transport.
#include "mmulti.h"
int connecthead = 0;
int connectpoint2[MAXMULTIPLAYERS];
// The rest of the mmulti.cpp single-player connection state the game reads:
//   myconnectindex — THIS peer's player index (0 in single-player)
//   numplayers     — number of players in the game (1)
//   syncstate      — netplay desync flag (0 = in sync)
int myconnectindex = 0;
int numplayers = 1;
char syncstate = 0;   // mmulti.h declares this as char
// Static initializer for the single-player connection terminator.
struct BptConnInit { BptConnInit() {
    for (int i = 0; i < MAXMULTIPLAYERS; ++i) connectpoint2[i] = -1;
} };
static BptConnInit s_bpt_conn_init;

// credits.cpp stubs. The real credits.cpp drives the DOS intro logos +
// Smacker (.SMK) cutscenes via libsmackerdec — which we DON'T link (no intro
// video on wasm; PHASE0-STATUS.md treats movies as out of scope). blood.cpp +
// the menu reference these three; we stub them so the game skips the intro
// straight to the menu (credLogosDos returns immediately; credPlaySmk reports
// "not played" so the caller proceeds). Phase-1 has no cutscenes.
//
// These are C++ functions (credits.h has no extern "C"), so we define them
// with matching C++ signatures + linkage so the callers' mangled names resolve.
#include "credits.h"
void credLogosDos(void) { /* skip DOS intro logos */ }
void credReset(void) { /* no cutscene state to reset */ }
char credPlaySmk(const char *, const char *, int) { return 0; /* not played */ }

// ───────────────────────────── audio stub ───────────────────────────────
// v1 ships audio DISABLED (mirrors the DOOM slice-8 stub). The stereo PCM
// ring exists so the JS API surface (audio_l/audio_r) is stable.
#define BPT_PCM_SAMPLES 4096
static float s_pcm[BPT_PCM_SAMPLES * 2];
extern "C" uint8_t *bpt_get_pcm_buffer(void) { return (uint8_t *)s_pcm; }
extern "C" int bpt_get_pcm_buffer_size(void) { return BPT_PCM_SAMPLES; }
