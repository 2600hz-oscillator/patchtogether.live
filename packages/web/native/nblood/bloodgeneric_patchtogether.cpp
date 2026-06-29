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
#include <stdio.h>
#include <unistd.h>

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

// ──────────────────────────── keyboard injection ────────────────────────
//
// bpt_set_key feeds a Build scancode event STRAIGHT into the engine's keyboard
// layer (build/src/baselayer.cpp) — exactly what sdlayer.cpp's handleevents
// does for a real SDL_KEYDOWN/KEYUP. This is what makes the front-end keyboard
// capture AND the CV-gate ports actually drive the game + the in-game menus.
//
// We are called from JS (Module.ccall) while app_main is SUSPENDED inside our
// videoShowFrame asyncify yield. wasm is single-threaded, so app_main is not
// running concurrently — writing the engine's keyboard globals here is race
// free, and the engine observes them the instant it resumes (gameHandleEvents /
// CGameMenuMgr::Process run on the resumed stack). We deliberately do NOT queue
// + drain at bpt_tick time: with r_maxfps=-2 the engine FREE-RUNS across the JS
// event loop on each emscripten_sleep(0) yield (it is not gated by bpt_tick), so
// a tick-time drain would be poorly timed. Applying the key immediately is both
// simpler and correctly ordered.
//
// We mirror BOTH of sdlayer's keyboard sinks:
//   * keySetState(sc, pressed): sets keystatus[sc] (the held-key poll the
//     gameplay/CONTROL layer reads) and, on key-DOWN, pushes the scancode into
//     the SCAN fifo g_keyFIFO that keyGetScan() drains. Blood's menu
//     (CGameMenuMgr::Process -> keyGetScan, gamemenu.cpp) reads BOTH navigation
//     (arrows) AND confirm (sc_Enter) from THIS fifo — so feeding it is what
//     makes ENTER / ESC / every menu key register. (The earlier Phase-1
//     scaffold queued scancodes then DISCARDED them, so this fifo was never fed
//     and "no keys worked".)
//   * keyBufferInsert(ascii): on key-DOWN for keys that carry a character, push
//     into the ASCII fifo g_keyAsciiFIFO that keyGetChar() drains (text-entry
//     screens — save-game names, console). Enter='\r', Esc=27, Tab='\t', etc.

static int s_app_started = 0;

// Build scancode -> ASCII char for the keys the front-end can emit (0 = none).
// Mirrors sdlayer.cpp's special-key chars (Enter/Esc/Tab/Backspace) plus the
// printable keys in blood-keys.ts (SCANCODE_FOR_KEYBOARD_CODE / _CV_GATE).
static char bpt_scancode_ascii(int sc)
{
    switch (sc)
    {
        case 0x1c: return '\r';  // sc_Enter
        case 0x01: return 27;    // sc_Escape
        case 0x0f: return '\t';  // sc_Tab
        case 0x0e: return '\b';  // sc_BackSpace
        case 0x39: return ' ';   // sc_Space
        case 0x33: return ',';   // sc_comma
        case 0x34: return '.';   // sc_period
        case 0x2c: return 'z';
        case 0x2d: return 'x';
        case 0x2e: return 'c';
        default:   return 0;
    }
}

extern "C" void bpt_set_key(int scancode, int pressed)
{
    if (!s_app_started) return;          // keyboard layer is not up before bpt_init
    scancode &= 0xff;
    if (scancode == 0) return;

    // keystatus[] poll + (on press) the scan fifo keyGetScan() drains.
    keySetState(scancode, pressed ? 1 : 0);

    // On press, also feed the ASCII char fifo keyGetChar() drains (text entry).
    if (pressed)
    {
        char const ascii = bpt_scancode_ascii(scancode);
        if (ascii && !keyBufferFull())
            keyBufferInsert(ascii);
    }
}

// ───────────────────────────── bpt_* exports ────────────────────────────

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

// r_maxfps (baselayer.cpp) is the engine's frame-rate limiter. -2 is the special
// "no throttle — engineFPSLimit() always returns true" value, so app_main's main
// loop DRAWS + presents on EVERY iteration. We need this for the ASYNCIFY seam:
// our videoShowFrame yields the call stack on each present (emscripten_sleep(0)),
// and JS controls pacing by when it resumes. With the default wall-clock limiter
// (-1), the loop SPINS between presents without ever calling videoShowFrame, so
// the asyncify stack never suspends → the JS event loop is starved and the engine
// never yields a frame (the menu/title would never appear). Setting -2 makes the
// loop cooperative: one present (one yield) per iteration.
extern int r_maxfps;

// ─────────────── stop SDL2 from grabbing the GLOBAL keyboard ──────────────
//
// emscripten's SDL2 port (SDL_emscriptenevents.c Emscripten_RegisterEventHandlers)
// registers a keydown/keyup handler on EMSCRIPTEN_EVENT_TARGET_WINDOW (window,
// BUBBLE phase) and `Emscripten_HandleKey` returns prevent_default=true for nearly
// every key (true unless SDL_TEXTINPUT is enabled). emscripten's keyEventHandler
// then calls `e.preventDefault()` — which SWALLOWS keystrokes destined for OTHER
// page elements (most visibly the +Add-module palette's <input> search box: a
// preventDefault'd keydown cancels the character insertion). Because the handler
// is bound to `window` for the whole lifetime of the WASM module, the swallow
// persists the entire time a BLOOD module exists. DOOM has NO analogue of this bug
// because doomgeneric registers no DOM keyboard handler at all (input is 100% the
// dgpt_set_key seam).
//
// BLOOD likewise does NOT need SDL's keyboard: every key reaches the engine via
// the bpt_set_key seam below (keySetState + the keyGetScan / keyGetChar fifos), so
// SDL's keyboard registration is pure redundancy. We disable it by pointing SDL's
// keyboard element (SDL_HINT_EMSCRIPTEN_KEYBOARD_ELEMENT, read in
// Emscripten_RegisterEventHandlers) at a CSS selector that matches NO element.
// emscripten's findEventTarget() then returns null and registerOrRemoveHandler()
// no-ops (returns -4, adds NO addEventListener) — so SDL never touches the global
// keyboard and palette/other-input typing flows through untouched. The hint must
// be set BEFORE SDL initialises its video (which happens inside app_main); we set
// it at the top of bpt_init. SDL_SetHint + SDL_HINT_EMSCRIPTEN_KEYBOARD_ELEMENT
// are already in scope here — baselayer.h (above) pulls in <SDL2/SDL.h> via
// timer.h/osd.h (this TU links against emscripten's -sUSE_SDL=2 port).

// ─────────────────────── shareware ART → TILES alias ────────────────────
//
// The Build engine loads its tile art from "tiles%03i.art" (build.cpp:
// artLoadFiles("tiles%03i.art")) — i.e. TILES000.ART. The 1997 Blood SHAREWARE
// ships its tile art as SHARE000.ART instead, so on shareware data NO game ART
// tiles load: tilesiz[*] stays 0, and every art-backed sprite (the main-menu
// blood-drip border + framed title + animated droplets, every HUD/backdrop pic)
// renders BLACK — the menu shows only the RFF-resident bitmap font on a void.
// (Diagnosed: with the ART present as TILES000.ART, tilesiz[2046]=320x200 and
// the drip chrome appears; without it tilesiz[2046]=0 and the screen is black.)
//
// The cwd is the data dir (JS chdir'd to /blood before bpt_init), and the files
// JS wrote are already on MEMFS. Symlink SHARE00x.ART → TILES00x.ART so the
// engine's default loader finds the art. This is data-agnostic: FULL-game data
// already ships TILES000.ART (SHARE absent → no alias), shareware ships SHARE
// (aliased). Idempotent + harmless if neither exists.
static void bpt_alias_shareware_art(void)
{
    for (int i = 0; i < 20; i++)
    {
        char share[24], tiles[24];
        snprintf(share, sizeof share, "SHARE%03d.ART", i);
        snprintf(tiles, sizeof tiles, "TILES%03d.ART", i);
        if (access(share, F_OK) == 0 && access(tiles, F_OK) != 0)
            symlink(share, tiles);
    }
}

extern "C" void bpt_init(int rff_len)
{
    (void)rff_len;
    if (s_app_started) return;
    s_app_started = 1;
#ifdef __EMSCRIPTEN__
    // Disable SDL2's global keyboard grab BEFORE app_main triggers SDL video init
    // (see the SDL_SetHint note above). Input reaches the engine via bpt_set_key.
    SDL_SetHint(SDL_HINT_EMSCRIPTEN_KEYBOARD_ELEMENT, "#__blood_no_sdl_keyboard__");
#endif
    bpt_alias_shareware_art();   // shareware SHARE000.ART -> TILES000.ART (see above)
    engineSetupAllocator();   // create g_sm_heap before any Xmalloc/Xstrdup
    r_maxfps = -2;            // present-per-iteration; JS drives pacing (see above)
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
    // No body needed: keyboard input is applied immediately in bpt_set_key (the
    // engine free-runs across the JS event loop, so there is nothing to drain
    // here), and the asyncify rewind happens because app_main is still on the
    // (suspended) stack. bpt_tick is the JS re-entry point; the actual
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
