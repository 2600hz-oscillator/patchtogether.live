# BLOOD port — Phase 1 (platform shim + full link) — STATUS

**Read `PHASE0-STATUS.md` first** (feasibility + license + the build recipe).

**Bottom line:** **KILL-GATE: LINK = PASS; FIRST-FRAME = blocked ONLY by the
non-redistributable Blood data, NOT by any engine/WASM/link defect.**

- `blood.wasm` (≈5.8 MB) + `blood.js` glue **fully link** from 152 NBlood TUs
  (software renderer, `-DNOASM`, `-sASYNCIFY`, emscripten SDL2). The Phase-0
  §2.4 self-modifying-asm `mprotect` wall is gone (`-DNOASM`). Reproduce:
  ```sh
  BLOOD_LINK=1 flox activate -- bash packages/web/native/build-blood-wasm.sh
  # → [build-blood-wasm] LINK OK — wrote: …/static/blood/blood.{js,wasm}
  ```
- A node headless harness boots the engine **all the way through** loguru
  logging, SDL2 video init (`Using 'emscripten' video driver`), and OSD init,
  into the Blood game **resource loader** — where it deliberately aborts
  because the user-supplied, **non-redistributable** game data is absent.

So both halves of the kill-gate are addressed: the link is real and the engine
runs in WASM; the only thing standing between this and a rendered frame is
lawfully-owned Blood data, which by design we never ship (PHASE0-STATUS §3).

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
… loguru.cpp INFO| Started …
… blood.cpp:1658 INFO| NBlood r(?)
… print.h:196  INFO| Built …, clang 22.1.2, 32-bit
… sdlayer.cpp:679 INFO| Initializing SDL 2.32.10
… sdlayer.cpp:747 INFO| Using 'emscripten' video driver.   ← SDL2 video init OK
… common.cpp:185 WARN| Could not find main data file "nblood.pk3"!
… blood.cpp:1724 INFO| Initializing OSD...                 ← OSD init OK
… resource.cpp(99): File not found BLOOD.RFF               ← deliberate engine abort
Aborted(native code called abort())
  _ThrowError → raise → abort   (Resource::Init, the game's RFF loader)
```

So the engine boots through platform + SDL2 + OSD and into `Resource::Init`,
then **`_ThrowError("File not found BLOOD.RFF")` → `abort()`** — a clean,
deliberate engine abort on **missing, non-redistributable** data, not a fault.

**Data is a CHAIN, all in the RFF (which holds the palette + menu art):**
`blood.cpp` loads `BLOOD.RFF` → `GUI.RFF` → `SOUNDS.RFF` in sequence
(`gSysRes/gGuiRes/gSoundRes.Init`), each hard-aborting via `_ThrowError`.
Confirmed empirically: feeding a **valid empty `BLOOD.RFF`** (correct
`"RFF\x1a"` header, version 0x300, 0 files) gets past the first check — the
engine then aborts on **`GUI.RFF`**. Because Blood's **menu/console art + the
palette live inside the RFFs**, there is **no pre-game (menu/console) frame to
render without real assets** — unlike DOOM (whose IWAD we may ship a shareware
copy of, and whose title screen renders from that WAD). This is the
PHASE0-STATUS §3 "user-supplied only, no out-of-box play" reality, now confirmed
at runtime.

**Therefore the "render ONE valid frame" half of the kill-gate is blocked
strictly by the lawful-data requirement, with a precise, deliberate engine
abort as the boundary — exactly the documented-blocker outcome the task's STOP
CONDITION calls a success.** When a user supplies a real `BLOOD.RFF`/`GUI.RFF`/
`SOUNDS.RFF` (via `task setup:blood`), the harness should drive the engine to
the real menu render; the `bpt_*` framebuffer path + the JS module are wired for
exactly that (§4). The headless harness
(`packages/web/native/nblood/blood-frame-harness.mjs`) takes a `BLOOD_DATA` dir
and asserts a non-empty, multi-color frame — runnable the moment a tester drops
in owned data.

---

## 3. Runtime faults found + fixed on the boot path (all real, all resolved)

| Fault (with `-sASSERTIONS`) | Cause | Fix |
| --- | --- | --- |
| `memory access out of bounds` in `sm::Allocator::Allocate`, from `OSD_SetLogFile → xstrdup` | smmalloc heap `g_sm_heap` not yet created — the real entry calls `engineSetupAllocator()` in its bootstrap BEFORE `app_main`; we bypass that bootstrap | shim calls `engineSetupAllocator()` at the top of `bpt_init` |
| `screen is not defined` in `_emscripten_get_screen_size` (SDL `Emscripten_VideoInit`) | **node-harness only** — node has no DOM `screen`. In a browser this exists | harness injects `globalThis.screen = {width,height}`. NOT a wasm/engine issue (a browser has `screen`) |
| `_ThrowError → abort` on `BLOOD.RFF` / `GUI.RFF` | **missing, non-redistributable game data** | by design — user-supplied (PHASE0-STATUS §3). This is the data wall, not a defect |

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

## 5. Remaining blockers / recommended next moves (NO-GO items are only data)

1. **Data (the only hard blocker to a frame):** none lawfully shippable. A
   tester with *One Unit Whole Blood* / *Fresh Supply* runs `task setup:blood`,
   then the harness/card render. (Owner tests Blood manually, like DOOM.)
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
