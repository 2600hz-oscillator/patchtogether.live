# BLOOD port — Phase 0 feasibility spike — STATUS

**Target engine:** [NBlood](https://github.com/NBlood/NBlood) — the
reverse-engineered, EDuke32-based Build-engine port of Blood. It has a native
35 Hz ticcmd lockstep model that will reuse our existing DOOM multiplayer
stack (`doom-lockstep.ts` / `doom-netcode.ts`), unlike "Transfusion" (the
SourceForge `blood` project), which is a **DarkPlaces/Quake** fan remake with
the wrong netcode for our relay. We **never** vendor or reference the leaked
1996 Blood source.

**Pinned NBlood commit for the spike:** `f08c32f5ca6248f452427d4495ee9475bc6c72aa`
(2026-06-13). Build recipe: `packages/web/native/build-blood-wasm.sh`.

**Toolchain:** Emscripten `emcc 5.0.6` (from the flox env). The DOOM build is
verified at 3.1.61+; the Build-engine spike below was run at 5.0.6.

**Bottom line:** **GO (with caveats)** for Phase 1. The two gates that could
have killed the port are both clear: (1) the license is compatible by the
exact same reasoning that lets us ship DOOM, and (2) the WASM build path is
real — emcc compiled the Build software-renderer core, the GL renderer, the
Blood game code, and the audio mixer with only two trivial source patches.

---

## 1. LICENSE GATE — verdict: COMPATIBLE (GO), by the DOOM precedent

### Our repo
`LICENSE` (top level) = **GNU AGPL-3.0**. AGPL-3.0 is compatible with GPL-2.0
and GPL-3.0 code **when the two are aggregated** (distributed together but not
combined into one statically-linked work). It is *not* compatible with
GPL-2.0-only code if you **statically link** AGPL and GPL-2.0-only into a
single binary. The distinction is the whole ballgame, and the DOOM precedent
resolves it.

### The DOOM precedent (already shipping in THIS repo)
- `packages/web/native/doomgeneric/LICENSE` = **GPL v2** (verbatim).
- `packages/web/native/doomgeneric/NOTICE.md` documents the compatibility
  argument we already rely on: the GPLv2 DOOM sources compile to a **separate
  WebAssembly blob** (`doom.wasm`) that the AGPL-3.0 web app loads at runtime
  via `fetch()` + an ES-module shim. **No static linking, no shared address
  space, no combined work** — this is **aggregation** in the FSF sense
  (<https://www.gnu.org/licenses/gpl-faq.html#MereAggregation>). The
  TypeScript shim talks to the WASM only over the documented `dgpt_*` C-export
  ABI and contains no DOOM source.
- doomgeneric's DOOM engine is **GPL-2.0** (the headers say "version 2"; the
  upstream is chocolate-doom which is GPLv2). It is shipped the
  runtime-loaded-WASM way, and we already treat that as fine.

### NBlood's actual license (read from the repo)
NBlood carries **two** licenses, split by directory:

| Component                         | License                                            | Evidence |
| --------------------------------- | -------------------------------------------------- | -------- |
| Blood game code (`source/blood/`) | **GPL-2.0 (version 2, NO "or later")**             | per-file headers in `blood.cpp`/`db.cpp`: *"redistribute … under the terms of the GNU General Public License version 2"*; `source/blood/gpl-2.0.txt` is verbatim GPLv2 |
| Duke3D game code (`source/duke3d/`) | **GPL-2.0 (version 2)**                           | `game.cpp` header: same "version 2" wording |
| Build engine (`source/build/`, `source/kenbuild/`) | **Ken Silverman BUILDLIC** (custom, non-commercial, internet-only distribution, attribution required) | `engine.cpp` header → *"See the included license file BUILDLIC.TXT"*; `source/build/buildlic.txt` |

So NBlood is **GPL-2.0-only** for the game code (the "GPL trap" the research
dossier flagged), **plus** a non-GPL Build engine. On its face GPL-2.0-only +
BUILDLIC cannot legally be combined, *and* GPL-2.0-only static-linked with
AGPL-3.0 would be a violation.

### How EDuke32/NBlood already resolve this — the GPL **linking exception**
EDuke32 (which NBlood derives from) ships an **additional permission under GPL
§7 (a "linking exception")** specifically to combine its GPL code with the
non-GPL Build engine:

> *"As a special exception, you may link this software with non-GPL rendering
> and engine tech by Ken Silverman and distribute the resulting executable
> under terms of your choice, provided that you also meet the terms and
> conditions of the BUILDLIC."*

(Source: EDuke32's documented licensing; discussed at
<https://forums.duke4.net/topic/12527-eduke32-is-under-gnu-gpl-and-build-but-how/>.)
This is the standard mechanism (<https://en.wikipedia.org/wiki/GPL_linking_exception>)
and is why EDuke32/NBlood are legally distributable at all.

### Why this is fine for us — by the DOOM precedent
We ship the engine **exactly the DOOM way**: NBlood compiles to a **separate
`blood.wasm` blob** loaded at runtime by the AGPL-3.0 app over a documented
`bpt_*` C-export ABI. That is **aggregation, not static linking** — there is
no combined AGPL+GPL binary, so:

1. **AGPL-3.0 ↔ GPL-2.0-only is a non-issue here.** The
   GPL-2.0-only-vs-AGPL-3.0 conflict only bites under *static linking into one
   work*. We aggregate (runtime-loaded WASM), identical to how DOOM's GPLv2
   blob coexists with our AGPL app today. The FSF's mere-aggregation rule
   covers it; our own `doomgeneric/NOTICE.md` already makes this argument and
   the project accepts it.
2. **The BUILDLIC requirements travel with the blob, not our app.** The
   EDuke32 linking exception lets the GPL code combine with the Build engine
   provided we also satisfy BUILDLIC. BUILDLIC's load-bearing conditions are
   **(a) free of charge / no commercial exploitation of the derivative,
   (b) attribution (ship BUILDLIC.TXT + Ken Silverman's notice),
   (c) internet-only distribution.** We serve the module free over the
   internet — all three are satisfied. The **one item to confirm with the
   owner before Phase 1 ships** is (a): patchtogether.live must not *sell* the
   Blood module / charge for the Blood data path. (Free tier + a paid product
   tier is the normal EDuke32-port situation; the constraint is specifically
   on commercial exploitation of the *Build-derived* work. Flag for owner.)

**Difference from the DOOM precedent, stated honestly:** DOOM's engine is
"clean" GPLv2 with no extra license. NBlood adds the BUILDLIC layer + a
GPL-2.0-**only** (not "or later") game core. The DOOM precedent still carries
because our compatibility argument never depended on "or later" — it depends
on **aggregation via runtime-loaded WASM**, which neutralises the AGPL/GPL2
linking concern, and the EDuke32 linking exception neutralises the GPL/BUILDLIC
concern. We must, however, ship a NBlood `NOTICE.md` mirroring
`doomgeneric/NOTICE.md` that records: GPLv2 game code, BUILDLIC engine, the
linking exception, and the BUILDLIC attribution + non-commercial + internet
conditions. (Phase 1 deliverable.)

**Verdict: license is GO.** Single owner action item: confirm we will not
charge for the Blood module (BUILDLIC non-commercial-derivative condition).

---

## 2. WASM BUILD SPIKE — verdict: PATH CONFIRMED (the renderer/game/audio compile)

### What "compile" had to overcome
NBlood is **not** a platform-abstraction layer like doomgeneric. doomgeneric
was *designed* with a tiny `DG_*` shim seam; NBlood is the full EDuke32/Build
stack (~184 translation units; `engine.cpp` alone is 15,115 lines,
`polymost.cpp` is 10,230). Its platform layer (`sdlayer.cpp`, 2,899 lines) is
SDL2, and even `mutex.h` types the engine's locks as `SDL_SpinLock` with **no
portable branch** — so the *entire* engine transitively needs a working
platform layer to compile at all.

**Key enabler:** `emcc -sUSE_SDL=2`. Emscripten ships its **own SDL2 port**
(it auto-fetched + built `libSDL2.a` for wasm32 on first use). That single
flag satisfies the engine's mutex / video / audio / input / timing layers for
the spike, with no shim written. (Phase 1 will likely *replace* SDL with a
`bpt_*` tick seam for the per-tic lockstep drive, but SDL2 is the fastest
proof-of-feasibility and a valid fallback.)

### Result — representative TU compile matrix (all green)
`build-blood-wasm.sh` (default `BLOOD_SPIKE=1`) compiles this cross-section to
WASM object files. **All 12 pass** on a clean checkout with the two patches in
§2.3 applied:

| Translation unit                    | Lines | Role                                   | Result |
| ----------------------------------- | ----- | -------------------------------------- | ------ |
| `build/src/compat.cpp`              | —     | foundational compat layer              | ✓ (needs both patches) |
| `build/src/engine.cpp`              | 15115 | **Build software renderer CORE**       | ✓ |
| `build/src/polymost.cpp`            | 10230 | GL renderer (→ WebGL via emscripten)   | ✓ |
| `build/src/a-c.cpp`                 | 702   | **C software rasteriser** (no nasm)    | ✓ |
| `build/src/softsurface.cpp`         | —     | framebuffer surface (the `bpt` seam)   | ✓ |
| `build/src/cache1d.cpp`             | —     | resource cache / file I/O              | ✓ |
| `build/src/palette.cpp`             | —     | palette / colour                       | ✓ |
| `build/src/pragmas.cpp`             | —     | fixed-point / intrinsics               | ✓ |
| `build/src/clip.cpp`                | —     | collision / clipping                   | ✓ |
| `blood/src/db.cpp`                  | —     | **Blood game data layer**              | ✓ |
| `blood/src/blood.cpp`               | —     | **Blood game entry**                   | ✓ |
| `audiolib/src/multivoc.cpp`         | —     | **audio mixer**                        | ✓ |

This is the load-bearing result: the **Build software renderer, the Blood game
code, and the audio mixer all cross-compile to WASM**. The classic-render core
needs no x86 assembly (`a.nasm`) — `a-c.cpp` is the portable C rasteriser, and
it compiles. There is a clean software-render framebuffer seam to expose to JS
(`baselayer.h`: `intptr_t frameplace`, `bytesperline`, `xres/yres/bpp`,
`videoUpdatePalette`) — the direct analogue of doomgeneric's `DG_ScreenBuffer`.

### 2.3 — The two source patches the spike needed (small, mechanical)
Both are `__EMSCRIPTEN__`-guarded, applied by `build-blood-wasm.sh` to the
throwaway checkout (NOT vendored). They are the **complete** set needed to get
the matrix above green:

1. **Endianness** (`build/include/compat.h`): upstream has no branch for the
   emscripten/wasm32 target → `#error Unknown endianness`. Fix: add
   `|| defined(__EMSCRIPTEN__)` to the little-endian `#elif` (wasm32 is LE).
   One token.
2. **`getpwuid()` home-dir fallback** (`build/src/compat.cpp`): emscripten
   libc has no passwd DB / `struct passwd`. Fix: under `__EMSCRIPTEN__`, the
   `$HOME`-env path is used (MEMFS), else bail — a 3-line guarded block.

### 2.4 — The one real porting wall found (bounded, Phase-1 work)
`build/src/baselayer.cpp` does **not** compile as-is:
`#error "Don't know how to unprotect the self-modifying assembly on this
platform!"` (it `mprotect()`s its hand-written x86 ASM to RWX at runtime).
WASM has no RWX/executable-memory protection, **and** we use the C software
renderer (`a-c.cpp`) which has no self-modifying ASM, so the unprotect is a
**no-op** under WASM. Fix is a small `__EMSCRIPTEN__` stub of the `B_PROT_*`
block. This is part of the **platform/main-loop layer that the Phase-1 shim
replaces wholesale**, so the spike does not compile it — it's documented here
rather than patched.

### 2.5 — What the spike did NOT do (honest scope)
- **No full link / no playable `blood.wasm`.** The spike stops at "compile a
  representative TU set." A full link needs the Phase-1 platform shim
  (`bloodgeneric_patchtogether.cpp`) replacing `sdlayer.cpp`'s window/input/
  audio/main-loop with a `bpt_*` C-export seam (init / tick-one / get
  framebuffer / set key / drain audio), mirroring
  `doomgeneric/doomgeneric_patchtogether.c`.
- **No determinism proof yet.** The DOOM MP stack relies on a C-side proof
  that two WASM instances fed identical TicSets produce identical per-tic
  checksums (`dgpt_state_checksum`). Blood/NBlood MUST get an equivalent
  `bpt_state_checksum` + a 2-instance replay harness **before** MP ships — RNG
  seeding (per-peer vs shared) is the classic silent-desync trap. This is the
  Phase-1/2 BLOCKER (not a Phase-0 item, but called out so it isn't forgotten).
- **No render-a-frame screenshot.** Producing one frame needs the shim + the
  user-provided `BLOOD.RFF` (which we can't ship). Feasibility was therefore
  demonstrated at the **compile** level across the renderer/game/audio, which
  is the decisive signal at Phase 0.

### Reproduce
```sh
flox activate -- bash packages/web/native/build-blood-wasm.sh
# → "[build-blood-wasm] PHASE-0 RESULT: ✓ all representative TUs compiled to WASM"
```

---

## 3. SHAREWARE REDISTRIBUTION — verdict: NOT redistributable (assets are user-supplied)

- **Blood IP owner:** Warner Bros. Games (via Monolith). GT Interactive
  (→ Infogrames → Atari) held only **publishing** rights, not the IP. Monolith
  sold publishing rights but kept the IP, which passed to WB.
  (<https://en.wikipedia.org/wiki/Blood_(video_game)>)
- **No source ever officially released** (unlike Duke3D/Shadow Warrior); the
  1996 leak is legally questionable and we never touch it.
- **No free-redistribution grant for the data.** The DOOM shareware case is
  special: id Software's shareware license *explicitly* permits free
  redistribution of `DOOM1.WAD`, which is why this repo fetches it for users.
  **No equivalent affirmative grant exists for Blood.** The Blood shareware
  episode ("The Way of All Flesh", `SHARE000.ART`) circulates on Archive.org /
  ModDB in a legally-gray *abandonware* status; period shareware license files
  commonly **restricted** third-party redistribution (e.g. no CD-compilation
  inclusion without permission). No site that hosts it states an affirmative
  redistribution license (RGB Classic Games' own page disclaims: "All software
  is © its respective owner").
  (<https://www.classicdosgames.com/game/Blood.html>,
  <https://www.moddb.com/games/blood/downloads/blood-shareware>)

**Conclusion:** we treat **all** Blood data — full *and* shareware — as **not
redistributable by us**. The project never ships or auto-fetches it; assets
are strictly **user-provided** (own a copy: GOG/Steam *One Unit Whole Blood* /
*Fresh Supply*). This matches the QBERT/SNES9X "user-supplied ROM" pattern,
**not** the DOOM "we fetch the shareware WAD" pattern. (Out-of-box play is
therefore not possible the way it is for DOOM.)

---

## 4. ASSET + SCAFFOLD STATE (done this PR)

- **`Taskfile.yml` → `setup:blood`**: validates a user-provided Blood install
  dir (requires `BLOOD.RFF`), copies the recognised data files
  (`*.RFF/*.ART/*.DAT/*.MAP`, excludes EXE/cfg) into `static/blood/`. Tested:
  graceful error on missing dir / missing `BLOOD.RFF`, correct selective copy
  on a synthetic install.
- **`packages/web/static/blood/README.md`**: required files, where-to-buy,
  SHA-1 table (TODOs until a Phase-1 loader exists to pin against a legally
  owned copy), and the full legal-status rationale for "user-supplied only."
- **`.gitignore`**: `packages/web/static/blood/*` + `!…/README.md`, appended
  after the SNES9X block. Also ignores the build script's NBlood scratch
  checkout (`packages/web/native/nblood/.upstream/`). Verified via
  `git check-ignore` (data ignored, README tracked).
- **`packages/web/native/build-blood-wasm.sh`**: the spike build recipe
  (fetch NBlood @ pinned commit → apply the 2 patches → compile-feasibility
  check). Mirrors `build-doom-wasm.sh`'s structure. Runs green + idempotent.

---

## 5. PHASE-1 RECOMMENDATION — **GO (with caveats)**

Proceed to Phase 1 (the single-player BLOOD video module). Both kill-gates are
clear: licensing is compatible by the DOOM-precedent aggregation argument, and
the WASM build path is proven at the compile level for the renderer, the game
code, and the audio mixer.

**Caveats / Phase-1 entry conditions:**
1. **Owner confirms non-commercial** for the Blood module (BUILDLIC condition
   on the Build-derived work). The only licensing action item.
2. **Write `native/nblood/NOTICE.md`** mirroring `doomgeneric/NOTICE.md`:
   GPLv2 game code + BUILDLIC engine + the EDuke32 linking exception +
   BUILDLIC attribution/non-commercial/internet conditions, and the
   vendor-vs-fetch decision for the engine sources.
3. **Build the platform shim** (`bloodgeneric_patchtogether.cpp`) exposing the
   `bpt_*` seam (init / tick-one / framebuffer / set-key / drain-audio), then
   the full link, plus the `__EMSCRIPTEN__` `baselayer.cpp` mprotect stub
   (§2.4). Mirror `doomgeneric_patchtogether.c`.
4. **Plan the determinism proof early** (§2.5): `bpt_state_checksum` + a
   2-instance scripted-TicSet replay harness, and an RNG-seeding audit, are
   the BLOCKER before the MP slice — Blood reuses our lockstep stack
   (`doom-lockstep.ts`/`doom-netcode.ts`) but the engine determinism must be
   re-proven on NBlood.
5. **Assets stay user-supplied forever** (§3) — no out-of-box play; the module
   shows a graceful "Blood data missing — run `task setup:blood`" card.

Engine reuse map (from the DOOM module): `build-doom-wasm.sh →
build-blood-wasm.sh` (started), `doom-runtime.ts → blood-runtime.ts`,
`doom.ts → blood.ts`, `doomkeys.ts → blood-keys.ts`, `DoomCard.svelte →
BloodCard.svelte`; reuse `doom-lockstep.ts` / `doom-netcode.ts` /
`doom-pcm-worklet.js` largely as-is. Note the framebuffer aspect differs
(DOOM 640×400; Blood Build is typically 320×200 → the shader letterbox math
adapts via the existing per-`ctx.res` uniform).
