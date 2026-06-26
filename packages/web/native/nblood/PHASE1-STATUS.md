# BLOOD port — Phase 1 (platform shim + full link) — STATUS

**Read `PHASE0-STATUS.md` first** (feasibility + license + the build recipe).

**Bottom line:** **KILL-GATE PASSED — the engine renders a REAL frame (the BLOOD
main menu) from the bundled 1997 shareware.** Link = PASS; first-frame = PASS.

- `blood.wasm` (≈5.8 MB) + `blood.js` glue **fully link** from 152 NBlood TUs
  (software renderer, `-DNOASM`, `-sASYNCIFY`, emscripten SDL2). Reproduce:
  ```sh
  BLOOD_LINK=1 flox activate -- bash packages/web/native/build-blood-wasm.sh
  # → [build-blood-wasm] LINK OK — wrote: …/static/blood/blood.{js,wasm}
  ```
- A node headless harness boots the engine **all the way through** palette init,
  data load, weapon/choke init, and game init into the **main MENU loop**, and
  `bpt_get_framebuffer` returns the real 640×480 **BLOOD main menu** (≈15 243
  non-black pixels, ≈32 colors: the "BLOOD" title + NEW GAME / MULTIPLAYER /
  OPTIONS / LOAD GAME / HELP / CREDITS / QUIT). Reproduce:
  ```sh
  BLOOD_LINK=1 BLOOD_OUT=blood-node BLOOD_ENVIRONMENT=node \
    flox activate -- bash packages/web/native/build-blood-wasm.sh
  BLOOD_DATA=packages/web/static/blood \
    flox activate -- node packages/web/native/nblood/blood-frame-harness.mjs
  # → [blood-harness] PASS: blood.wasm linked + rendered a real content frame (main menu).
  ```

---

## 0. The palette-init OOB (root cause + fix) — the Phase-1 first-frame blocker

With the shareware data bundled (so the RFF/INI/DAT/ART all load), the engine hit
a `memory access out of bounds` during Build's palette-table init, right after
`screen.cpp:242 "Loading translucency table"`. Pinpointed with `-sSAFE_HEAP=1`:

```
palettePostLoadTables → paletteGetClosestColorWithBlacklist
                      → paletteGetClosestColorWithBlacklistNoCache   ← OOB read
```

**Root cause — a `char`-signedness bounds bug, NOT a memory ceiling.** Build's
closest-color matcher (`colmatch.cpp`) indexes its `rdist`/`gdist`/`bdist`
distance LUTs by raw palette BYTES, e.g. `rdist[pal1[0]+r]` where `pal1` is a
`char const *` into the 768-byte palette. **NBlood's upstream `Common.mak`
compiles the whole engine with `-funsigned-char`**, so those bytes read 0..255
and the index stays in `[0, 512]` (the LUT is `FASTPALCOLDEPTH*2+1 = 513` wide).
`build-blood-wasm.sh` did NOT pass `-funsigned-char`, and **wasm32's default
`char` is SIGNED** — so any palette component ≥128 read as a NEGATIVE index →
out-of-bounds heap read. (This is the platform-dependent footgun the CLAUDE.md
"capability/renderer-dependent" lesson warns about, in `char`-signedness form.)

**Fix:** add `-funsigned-char` to `build-blood-wasm.sh`'s `CFLAGS` + `LINK_CFLAGS`
(matching upstream). No source patch needed for the OOB. After this the engine
sails past palette init.

### Two follow-on SHAREWARE-data walls fixed (the bundled set differs from the
full game), as minimal `__EMSCRIPTEN__`-style upstream patches in the build script:

1. **`BLOOD.INI` missing** → `levels.cpp:71 "Initialization: BLOOD.INI does not
   exist"`. The episode/level descriptor is a plain-text file the engine reads on
   boot; it is NOT inside `BLOOD.RFF` (the shareware ships it separately) and was
   absent from the bundle. **Fix (data, not code):** added the shareware
   `BLOOD.INI` (Episode1 = E1M1..E1M8, the 8 maps the shareware RFF actually
   contains — verified from the RFF directory) to `static/blood/`, the
   `.gitignore` un-ignore list, and `BLOOD_BUNDLED_FILES` in `blood-runtime.ts`.
2. **Reduced shareware arsenal** → `weapon.cpp:235 "Could not load QAV 113"` and
   `choke.cpp "Could not load QAV 518"`. The shareware RFF has QAV ids 0..112
   (+512..515) only; ids 113..124 (full-game weapons) and 518 (the choke overlay)
   are absent. `WeaponInit` / `CChoke::Init` hard-`ThrowError` on the first
   missing one. **Fix (build-script source patch):** make both shareware-tolerant
   — a missing QAV logs a warning and leaves the slot NULL instead of aborting.
   Safe: every consumer already NULL-guards (`WeaponPrecache`, `CChoke::Draw`),
   and those weapons/overlays can never be selected on shareware data. Full-game
   data still loads all ids unchanged.

### The ASYNCIFY frame-drive fix (shim)
After init, app_main's main loop only presents (→ our `videoShowFrame` → snapshot
+ `emscripten_sleep(0)` yield) when the wall-clock FPS limiter
(`engineFPSLimit`, default `r_maxfps=-1`) allows it; between presents the loop
SPINS without yielding, starving the JS event loop so the asyncify stack never
resumes and the menu never paints. **Fix:** the shim sets `r_maxfps = -2` in
`bpt_init` (the "no-throttle, always present" mode), so the engine yields one
frame per iteration and JS drives pacing. With this, the menu renders.

---

## 1. What links, and how (the platform shim)

`bloodgeneric_patchtogether.cpp` is the NBlood analogue of
`doomgeneric/doomgeneric_patchtogether.c`. Key design difference, stated
honestly: doomgeneric has a cooperative per-tic seam (`doomgeneric_Tick()`);
NBlood's `app_main()` (blood.cpp) is a **blocking** main loop
(`while (!gQuitGame){ …; videoNextPage(); }` + `goto RESTART`). So the shim:

- Keeps emscripten's **SDL2** port (`-sUSE_SDL=2`) for the window / input /
  audio / timing layer (Phase-0 proved it resolves NBlood's SDL-typed
  mutex/video/audio). It does **not** rewrite `sdlayer.cpp` wholesale.
- Uses **`-sASYNCIFY`** so the blocking `app_main` can suspend at each frame.
  The shim **overrides `videoShowFrame`** (the per-frame present that
  `videoNextPage` calls): snapshot the software frame, then `emscripten_sleep(0)`
  to yield back to JS. `bpt_tick()` resumes the suspended `app_main` to the next
  frame. `sdlayer.cpp`'s own `videoShowFrame` is renamed `videoShowFrame_sdl`
  (a build patch) so ours wins with no duplicate symbol.
- Exposes the framebuffer via `softsurface_blitBuffer()` into our own RGBA8
  buffer — the SDL-independent `DG_ScreenBuffer` analogue.

**`bpt_*` seam (exported):** `bpt_init` / `bpt_tick` / `bpt_get_framebuffer` /
`bpt_get_framebuffer_size` / `bpt_get_resx` / `bpt_get_resy` / `bpt_has_frame` /
`bpt_set_key` / `bpt_get_pcm_buffer` / `bpt_get_pcm_buffer_size` (+ malloc/free).

### The build patches the link needed (all in `build-blood-wasm.sh`, applied to
the throwaway checkout — NOT vendored)

1. **`-DNOASM`** (compile flag): removes `baselayer.cpp`'s
   `nx_unprotect`/`mprotect`/`#error` block entirely (`#if !defined(NOASM)`) and
   selects the portable C software rasteriser `a-c.cpp` (`ENGINE_USING_A_C`,
   auto-defined by `a.h` under NOASM). This *replaces* the manual stub that
   PHASE0-STATUS §2.4 anticipated — no source edit to baselayer needed.
2. `sdlayer.cpp` **`videoShowFrame` → `videoShowFrame_sdl`** (so the shim's
   override is the linked one).
3. `sdlayer.cpp` **execinfo guard**: its SIGSEGV backtrace pulls in
   `<execinfo.h>` (glibc-only) under `__GNUC__`; emscripten sets `__GNUC__` but
   has no execinfo, so the guard gets `&& !defined __EMSCRIPTEN__`.
4. (Phase-0 patches still apply: endianness `__EMSCRIPTEN__` LE branch +
   `getpwuid` MEMFS fallback.)

### Shim-provided symbols (replacing TUs we don't link)
The shim defines small bits the skipped platform/editor TUs would otherwise
provide: `sdlappicon` (empty icon), `cpu` + `sysReadCPUID()` (no CPUID on wasm),
the single-player mmulti connection globals (`connecthead`/`connectpoint2`/
`myconnectindex`/`numplayers`/`syncstate`), and the credits/Smacker-intro stubs
(`credLogosDos`/`credReset`/`credPlaySmk` — no cutscenes on wasm). It also calls
`engineSetupAllocator()` **before** `app_main` (see §3, the first runtime fault
found + fixed).

### Source set: what's linked vs skipped
The link sweeps `build/src`, `blood/src`, `mact/src`, `audiolib/src`,
`imgui/src` (`.cpp` + the vendored `.c`: lz4/miniz/xxhash), minus a SKIP list
(see `SKIP_REGEX` in the script): the **GL renderer** (USE_OPENGL off:
polymost/polymer/glbuild/glsurface/mdsprite/texcache/voxmodel/dxtfilter/animvpx),
**non-wasm platform** layers (winlayer/gtk/wii/sdlayer12/cpuid/rawinput),
**editor** TUs (`build.cpp`, mapedit, m32*, tilepacker), the **mmulti** netplay
transport (Phase-2; globals stubbed), **music_external** (alt MIDI backend),
imgui GL3/win32/demo backends, and the OS audio-output drivers (keep `driver_sdl`
+ the OPL3 software-synth `driver_adlib`).

---

## 2. The kill-gate result, exactly

```
[blood-harness] bpt_init …
… sdlayer.cpp:747 INFO| Using 'emscripten' video driver.   ← SDL2 video init OK
… blood.cpp:1747 INFO| Initializing Build 3D engine
… screen.cpp:210  INFO| Loading palettes
… screen.cpp:242  INFO| Loading translucency table          ← (was) the palette OOB
… screen.cpp:327  INFO| Loading gamma correction table      ← now PAST palette init
… blood.cpp:1753  INFO| Loading tiles
… cache1d.cpp:98  INFO| Initialized 96.0M cache
… blood.cpp:1789  INFO| Initializing view subsystem
… weapon.cpp:239  WARN| weapon QAV 113..124 not in RFF (shareware data?) - skipping
… choke.cpp:65    WARN| choke QAV 518 not in RFF (shareware data?) - disabling
… blood.cpp:1866  INFO| Waiting for network players!        ← into the MENU loop
[blood-harness] best frame: 640x480, fbPtr=…, fbSize=1228800
[blood-harness] non-black pixels: 15243/307200 (5.0%), distinct colors (sampled): 32
[blood-harness] PASS: blood.wasm linked + rendered a real content frame (main menu).
```

So the engine boots through platform + SDL2 + OSD + the WHOLE Build 3D engine +
Blood game init, into the **main menu loop**, and renders the real **BLOOD main
menu** (the "BLOOD" title + the NEW GAME / MULTIPLAYER / OPTIONS / LOAD GAME /
HELP / CREDITS / QUIT items). The frame is read SDL-independently via
`softsurface_blitBuffer` through `bpt_get_framebuffer` (RGBA8). The render is
deterministic across runs (exactly 15 243 non-black pixels). **Both halves of the
kill-gate now PASS: the link is real AND a real frame renders.**

(The `SDL Audio: error in Init` and `window gamma ramp not supported` lines are
benign node-headless SDL noise — audio is the silent v1 stub, gamma is cosmetic.)

---

## 3. Runtime faults found + fixed on the boot path (all real, all resolved)

| Fault | Cause | Fix |
| --- | --- | --- |
| `memory access out of bounds` in `sm::Allocator::Allocate`, from `OSD_SetLogFile → xstrdup` | smmalloc heap `g_sm_heap` not yet created — the real entry calls `engineSetupAllocator()` BEFORE `app_main`; we bypass that bootstrap | shim calls `engineSetupAllocator()` at the top of `bpt_init` |
| `screen is not defined` in `_emscripten_get_screen_size` (SDL `Emscripten_VideoInit`) | **node-harness only** — node has no DOM `screen` (a browser does) | harness injects `globalThis.screen` |
| `memory access out of bounds` in `paletteGetClosestColorWithBlacklistNoCache` (from `palettePostLoadTables`), right after `screen.cpp:242 "Loading translucency table"` | **the Phase-1 palette OOB.** Build's colmatch indexes `rdist/gdist/bdist` by raw palette BYTES; wasm32's default SIGNED `char` makes bytes ≥128 a negative index. Upstream builds the engine `-funsigned-char` | add `-funsigned-char` to `build-blood-wasm.sh` CFLAGS + LINK_CFLAGS (§0) |
| `levels.cpp:71 BLOOD.INI does not exist` | shareware ships `BLOOD.INI` as a separate on-disk file (not in the RFF); it was missing from the bundle | bundle the shareware `BLOOD.INI` (§0.1) |
| `weapon.cpp:235 Could not load QAV 113`; `choke.cpp Could not load QAV 518` | shareware RFF has a reduced arsenal (QAV 0..112 only; 113..124 + 518 are full-game-only) and `WeaponInit`/`CChoke::Init` hard-abort on the first missing one | shareware-tolerant patches: missing QAV → warn + NULL slot, not abort (§0.2) |
| `document is not defined` in `Emscripten_RegisterEventHandlers` (SDL `SDL_CreateWindow`) | **node-harness only** — SDL2 registers pointerlock/fullscreen handlers on the DOM `document`/canvas; node has neither (a browser does) | harness injects a minimal headless `document`/`window`/canvas shim |
| engine reaches a paint but only the near-black CLEARED backbuffer; the menu never appears | the main loop's wall-clock FPS limiter (`engineFPSLimit`, `r_maxfps=-1`) SPINS between presents without yielding → starves the JS event loop so the ASYNCIFY stack never resumes | shim sets `r_maxfps = -2` (present-per-iteration); JS drives pacing (§0) |

---

## 4. What's testable now / state of the SECONDARY scaffold

- `blood.wasm` + `blood.js` build green (web) via `BLOOD_LINK=1`.
- A node-targeted variant (`BLOOD_OUT=blood-node BLOOD_ENVIRONMENT=node`) +
  `blood-frame-harness.mjs` boot the engine and (with user data in `BLOOD_DATA`)
  assert a rendered frame.
- The SP module scaffold (cloned from the DOOM seams): `blood.ts` def,
  `blood-runtime.ts` (the `bpt_*` shim, DoomRuntime analogue), `blood-keys.ts`,
  `BloodCard.svelte`. These compile + typecheck; the card renders a graceful
  "Blood data missing — run `task setup:blood`" overlay until data is present.

---

## 5. Remaining blockers / recommended next moves

0. **First frame — DONE.** The engine renders the real menu from the bundled
   shareware (§2). No data/engine/link blocker remains for the kill-gate. (Full
   episodes still need user-supplied *One Unit Whole Blood* / *Fresh Supply* via
   `task setup:blood` — the bundled set is shareware Episode 1 only.)
1. **Pacing/perf:** the shim runs `r_maxfps=-2` (present-per-iteration); the JS
   `bpt_tick` cadence governs the effective frame rate. A follow-up can pace this
   to the rack clock / rAF and re-evaluate whether to keep `-2` or set a real cap.
2. **Audio:** v1 ships the PCM stub silent (mirrors DOOM slice-8). Wire
   `driver_sdl`/`multivoc` output into the `bpt_get_pcm_buffer` ring + the
   reused doom PCM worklet in a follow-up.
3. **Input:** `bpt_set_key` queue exists; Phase-1 follow-up routes it into
   Build's `keystatus[]` / the CONTROL layer (today the drain is a no-op stub so
   the API is stable without coupling the shim to mact yet).
4. **Determinism / MP** (PHASE0-STATUS §2.5): `bpt_state_checksum` + a 2-instance
   replay harness + RNG-seed audit remain the Phase-2 MP blocker. `mmulti.cpp`
   is currently skipped (SP connection globals stubbed); MP re-links it.
5. **ASYNCIFY size/perf:** the whole engine is ASYNCIFY-instrumented; once the
   render path is exercised with real data, consider `ASYNCIFY_ONLY` /
   `ASYNCIFY_ADD` to shrink the instrumented set (smaller wasm, faster).
6. **License deliverable:** ship `native/nblood/NOTICE.md` (GPLv2 game code +
   BUILDLIC engine + EDuke32 linking exception) before this leaves draft —
   PHASE0-STATUS §1 caveat 2. (Tracked; not done in this Phase-1 spike PR.)

**This PR stays a DRAFT — do not merge.** A GPU/WebGL re-attest is pending
(the BLOOD video def adds a GL shader to the attest basis); not attempted here.
