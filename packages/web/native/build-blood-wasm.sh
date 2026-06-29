#!/usr/bin/env bash
#
# build-blood-wasm.sh — compile NBlood's Build-engine + Blood game core to
# WebAssembly (packages/web/static/blood/blood.{js,wasm}). Mirrors
# build-doom-wasm.sh: output is .gitignored (we don't ship pre-built WASM
# in git — too noisy on diffs, and the build is reproducible from a pinned
# upstream commit).
#
#   ──────────────────────────────────────────────────────────────────────
#   PHASE-0 SPIKE STATUS — READ native/nblood/PHASE0-STATUS.md FIRST.
#
#   This recipe is the *feasibility scaffold*, NOT a finished build. The
#   Phase-0 spike PROVED the toolchain path works (emcc 5.x + emscripten's
#   own SDL2 port compiles the Build software renderer engine.cpp, the GL
#   renderer polymost.cpp, the Blood game TUs blood.cpp/db.cpp, and the
#   audiolib mixer multivoc.cpp — see PHASE0-STATUS.md §2 for the exact
#   per-TU results). What's NOT yet done (the Phase-1 work):
#     1. A platform shim (bloodgeneric_patchtogether.cpp) that replaces
#        NBlood's SDL2 window/input/audio/timing main loop with the same
#        bpt_* C-export seam the DOOM module uses (dgpt_* → bpt_*), driving
#        the engine a-tic-at-a-time from JS and exposing `frameplace`
#        (the Build software-render framebuffer) + the palette.
#     2. The two small upstream porting patches the spike identified
#        (endianness define + a couple POSIX/mprotect __EMSCRIPTEN__
#        guards — see PHASE0-STATUS.md §2.3). These will be applied as a
#        patch series against the pinned commit (NOT vendored wholesale),
#        OR upstreamed to NBlood.
#     3. The full link step (this script currently stops at "compile a
#        representative TU set" so CI/devs can reproduce the spike result
#        without a finished port).
#
#   So: running this script TODAY reproduces the Phase-0 compile feasibility
#   check (BLOOD_SPIKE=1, the default). It does NOT yet emit a playable
#   blood.wasm — that is Phase 1.
#   ──────────────────────────────────────────────────────────────────────
#
# Usage:
#   bash packages/web/native/build-blood-wasm.sh            # spike compile-check (default)
#   BLOOD_SPIKE=0 bash packages/web/native/build-blood-wasm.sh   # (Phase 1) full link — NOT YET IMPLEMENTED
#
# Requirements:
#   emcc (Emscripten) on PATH — the flox env provides 5.0.6 (the DOOM build
#       is verified with 3.1.61+; the Build engine spike was verified with
#       5.0.6). https://emscripten.org/docs/getting_started/downloads.html
#   git (to fetch NBlood at the pinned commit).
#   bash 4+ (for `set -o pipefail`).
#
# WHY WE DON'T VENDOR NBLOOD INTO THIS REPO (cf. how we DO vendor doomgeneric):
#   doomgeneric is ~85 small .c files purpose-built as a platform-abstraction
#   layer, so vendoring it + a tiny shim is clean. NBlood is ~184 translation
#   units (engine.cpp alone is 15k lines) carrying TWO licenses — the Blood/
#   Duke game code under GPL-2.0 *with EDuke32's linking exception*, and the
#   Build engine under Ken Silverman's custom BUILDLIC.TXT (non-commercial,
#   internet-only). For the Phase-0 spike we FETCH it at a pinned commit
#   rather than committing the whole engine. Phase 1 will make the
#   vendor-vs-fetch + license-bundling call deliberately (see
#   PHASE0-STATUS.md §1) and ship the matching NOTICE.md, exactly like
#   native/doomgeneric/NOTICE.md does for DOOM.
#
# ASSETS: BLOOD.RFF / TILES.ART / *.DAT are NOT bundled (proprietary, NOT
#   redistributable — unlike the DOOM shareware WAD). The Blood module loads
#   them at runtime from /blood/ (user-provided via `task setup:blood`). See
#   packages/web/static/blood/README.md.

set -euo pipefail

# ── NBlood upstream pin ────────────────────────────────────────────────────
# Pinned for reproducibility (the spike was verified at this exact commit).
NBLOOD_REPO="${NBLOOD_REPO:-https://github.com/NBlood/NBlood.git}"
NBLOOD_COMMIT="${NBLOOD_COMMIT:-f08c32f5ca6248f452427d4495ee9475bc6c72aa}"  # 2026-06-13

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="$SCRIPT_DIR/../static/blood"
# Scratch checkout of NBlood — NOT committed (sibling of the repo, gitignored
# by being outside the tree). Override with NBLOOD_SRC to reuse a clone.
NBLOOD_SRC="${NBLOOD_SRC:-$SCRIPT_DIR/nblood/.upstream}"

OUT_NAME="${BLOOD_OUT:-blood}"
BLOOD_ENVIRONMENT="${BLOOD_ENVIRONMENT:-web}"
BLOOD_SPIKE="${BLOOD_SPIKE:-1}"
mkdir -p "$OUT_DIR"

if ! command -v emcc >/dev/null 2>&1; then
  echo "error: emcc not found on PATH" >&2
  echo "install Emscripten per https://emscripten.org/docs/getting_started/downloads.html" >&2
  echo "(the flox env provides it: \`flox activate -- bash packages/web/native/build-blood-wasm.sh\`)" >&2
  exit 127
fi

# ── Fetch NBlood at the pinned commit (shallow) ────────────────────────────
if [ ! -d "$NBLOOD_SRC/.git" ]; then
  echo "[build-blood-wasm] fetching NBlood @ $NBLOOD_COMMIT ..."
  git clone --filter=blob:none "$NBLOOD_REPO" "$NBLOOD_SRC"
fi
git -C "$NBLOOD_SRC" fetch --depth 1 origin "$NBLOOD_COMMIT" 2>/dev/null || true
git -C "$NBLOOD_SRC" checkout -q "$NBLOOD_COMMIT" 2>/dev/null \
  || { echo "error: could not check out NBlood @ $NBLOOD_COMMIT" >&2; exit 1; }
echo "[build-blood-wasm] NBlood at $(git -C "$NBLOOD_SRC" rev-parse --short HEAD)"

# ── Phase-0 porting patches (applied to the scratch checkout, NOT committed) ─
# These are the minimal source patches the Phase-0 spike identified. They are
# applied in-place to the throwaway checkout. Phase 1 will formalise them as a
# proper patch series (or upstream them). See PHASE0-STATUS.md §2.3.
# All three are SURGICAL, __EMSCRIPTEN__-guarded, and reversible. They are the
# COMPLETE set the Phase-0 spike needed to get the representative TU set green.
apply_phase0_patches() {
  local INC="$NBLOOD_SRC/source/build/include/compat.h"
  local COMPAT="$NBLOOD_SRC/source/build/src/compat.cpp"
  # (1) Endianness: emscripten/wasm32 is little-endian; upstream has no branch.
  if ! grep -q '__EMSCRIPTEN__' "$INC"; then
    perl -0pi -e 's/(#elif defined\(_WIN32\) \|\| defined\(SKYOS\) \|\| defined\(__SYLLABLE__\))/$1 || defined(__EMSCRIPTEN__)/' "$INC"
    echo "[build-blood-wasm] patched compat.h endianness for __EMSCRIPTEN__"
  fi
  # (2) compat.cpp getpwuid() home-dir fallback: emscripten libc has no passwd
  #     db. We're patching the THROWAWAY WASM checkout only, so a flat one-line
  #     swap (no nested preprocessor) is safest: getpwuid(getuid()) → a null
  #     passwd*, so the existing `if (pw == NULL ...) return NULL;` handles the
  #     no-HOME case under MEMFS. (Phase 1's shim formalises this with a real
  #     __EMSCRIPTEN__ guard in the patch series.)
  if ! grep -q 'spike: WASM has no passwd db' "$COMPAT"; then
    perl -0pi -e 's{        auto const pw = getpwuid\(getuid\(\)\);\n        if \(pw == NULL \|\| \(e = pw->pw_dir\) == NULL \|\| e\[0\] == .\\0.\)\n            return NULL;}{\x23ifdef __EMSCRIPTEN__\n        return NULL;  // spike: WASM has no passwd db (MEMFS uses \$HOME)\n\x23else\n        auto const pw = getpwuid(getuid());\n        if (pw == NULL || (e = pw->pw_dir) == NULL || e[0] == \x27\\0\x27)\n            return NULL;\n\x23endif}' "$COMPAT"
    echo "[build-blood-wasm] patched compat.cpp getpwuid for __EMSCRIPTEN__"
  fi
  # (3) baselayer.cpp self-modifying-asm mprotect (PHASE0-STATUS.md §2.4):
  #     RESOLVED upstream-free by building with -DNOASM (see CFLAGS). NOASM
  #     compiles out baselayer.cpp's whole nx_unprotect/mprotect/#error block
  #     (`#if !defined(NOASM)`) AND selects the portable C software rasteriser
  #     a-c.cpp via ENGINE_USING_A_C (a.h auto-defines it under NOASM). No
  #     source patch needed — the Phase-1 full link below builds baselayer.cpp
  #     directly with -DNOASM and it compiles clean.

  # ── Phase-1 LINK patch: rename sdlayer's videoShowFrame ──────────────────
  # The full-link path (BLOOD_LINK=1) keeps emscripten's SDL2 sdlayer.cpp
  # (window/input/audio/timing) but needs OUR videoShowFrame
  # (bloodgeneric_patchtogether.cpp) to win — it snapshots the software frame
  # + yields the asyncify stack to JS. sdlayer.cpp also DEFINES videoShowFrame,
  # so we rename sdlayer's copy to videoShowFrame_sdl (unused) to avoid a
  # duplicate-symbol link error. Surgical, reversible, throwaway-checkout only.
  local SDL="$NBLOOD_SRC/source/build/src/sdlayer.cpp"
  if ! grep -q 'videoShowFrame_sdl' "$SDL"; then
    perl -0pi -e 's/\bvoid videoShowFrame\(int32_t w\)/void videoShowFrame_sdl(int32_t w)/' "$SDL"
    echo "[build-blood-wasm] patched sdlayer.cpp videoShowFrame -> videoShowFrame_sdl (Phase-1 link)"
  fi
  # sdlayer's SIGSEGV-backtrace block pulls in <execinfo.h> (glibc-only) when
  # __GNUC__ is set — emscripten defines __GNUC__ but has no execinfo. Exclude
  # __EMSCRIPTEN__ from the PRINTSTACKONSEGV guard (we don't backtrace in wasm).
  if ! grep -q 'defined __EMSCRIPTEN__ /\* no execinfo' "$SDL"; then
    perl -0pi -e 's/(#if !defined _WIN32 && defined __GNUC__ && !defined __OpenBSD__)/$1 && !defined __EMSCRIPTEN__ \/* no execinfo *\//' "$SDL"
    echo "[build-blood-wasm] patched sdlayer.cpp execinfo guard for __EMSCRIPTEN__"
  fi

  # ── ENGINE CLOCK fix: CLOCK_MONOTONIC_RAW is UNSUPPORTED by emscripten ────
  # timer.cpp picks `CLOCK_TYPE = CLOCK_MONOTONIC_RAW` whenever the *macro* is
  # defined (`#ifdef CLOCK_MONOTONIC_RAW`). emscripten DEFINES the macro but its
  # clock_gettime(CLOCK_MONOTONIC_RAW) returns -1 and leaves the timespec
  # untouched — so the engine's whole timebase (timerGetNanoTicks →
  # timerUpdateClock → `totalclock`) reads stack garbage that never advances.
  # A frozen `totalclock` FREEZES every time-driven thing: the main-menu
  # selection-cursor pulse (CGameMenuItemChain::Draw shade = 32-(totalclock&63),
  # so the focused item is INDISTINGUISHABLE from the rest → "menu won't
  # navigate"), all menu/HUD animation, AND the gameplay tic loop
  # (`totalclock >= gNetFifoClock` in app_main → a started game never advances).
  # Verified empirically: clock_gettime(CLOCK_MONOTONIC) DOES advance on
  # emscripten while CLOCK_MONOTONIC_RAW returns -1. So force the portable
  # CLOCK_MONOTONIC under __EMSCRIPTEN__. Surgical + reversible (throwaway
  # checkout); native builds keep CLOCK_MONOTONIC_RAW.
  local TIMER="$NBLOOD_SRC/source/build/src/timer.cpp"
  if ! grep -q 'EMSCRIPTEN.*CLOCK_MONOTONIC_RAW unsupported' "$TIMER"; then
    perl -0pi -e 's/#ifdef CLOCK_MONOTONIC_RAW\n# define CLOCK_TYPE CLOCK_MONOTONIC_RAW/#if defined CLOCK_MONOTONIC_RAW \&\& !defined __EMSCRIPTEN__ \/* CLOCK_MONOTONIC_RAW unsupported on wasm *\/\n# define CLOCK_TYPE CLOCK_MONOTONIC_RAW/' "$TIMER"
    echo "[build-blood-wasm] patched timer.cpp CLOCK_TYPE -> CLOCK_MONOTONIC for __EMSCRIPTEN__"
  fi

  # ── SHAREWARE-tolerant weapon QAV init ───────────────────────────────────
  # WeaponInit (weapon.cpp) hard-loops QAV ids 0..kQAVEndVanilla-1 (=124) and
  # ThrowError()s on the FIRST one missing from the RFF. The 1997 Blood
  # SHAREWARE BLOOD.RFF ships a REDUCED arsenal: it contains QAV ids 0..112
  # only — the full-game-exclusive weapon animations 113..124 are absent. So on
  # shareware data the engine aborts at weapon.cpp:235 "Could not load QAV 113".
  # Those 12 QAVs belong to weapons the shareware player can never equip, the
  # weaponQAV[] slots are NULL-initialised globals, and every consumer already
  # NULL-guards (WeaponPrecache: `if (weaponQAV[i])`; WeaponRaise/-Lower index
  # by the player's CURRENT weapon, which on shareware never selects a missing
  # id). So we make WeaponInit shareware-TOLERANT: a missing vanilla QAV logs a
  # warning and leaves the slot NULL instead of aborting. Surgical + reversible
  # (throwaway checkout only); full-game data still loads all ids unchanged.
  local WEAP="$NBLOOD_SRC/source/blood/src/weapon.cpp"
  if ! grep -q 'shareware: missing QAV' "$WEAP"; then
    perl -0pi -e 's/        hRes = gSysRes\.Lookup\(i, "QAV"\);\n        if \(!hRes\)\n            ThrowError\("Could not load QAV %d\\n", i\);\n        weaponQAV\[i\] = \(QAV\*\)gSysRes\.Lock\(hRes\);\n        weaponQAV\[i\]->nSprite = -1;/        hRes = gSysRes.Lookup(i, "QAV");\n        if (!hRes)\n        {\n            \/\/ shareware: missing QAV (full-game-only arsenal 113..124 absent\n            \/\/ from the shareware RFF). Leave the slot NULL (consumers NULL-guard)\n            \/\/ instead of aborting, so shareware data boots to the menu + E1Mx.\n            LOG_F(WARNING, "weapon QAV %d not in RFF (shareware data?) - skipping", i);\n            weaponQAV[i] = NULL;\n            continue;\n        }\n        weaponQAV[i] = (QAV*)gSysRes.Lock(hRes);\n        weaponQAV[i]->nSprite = -1;/' "$WEAP"
    echo "[build-blood-wasm] patched weapon.cpp WeaponInit for shareware-tolerant QAV load"
  fi

  # ── SHAREWARE-tolerant choke-hand QAV init ───────────────────────────────
  # blood.cpp calls gChoke.Init(518, playerHandChoke) — the "drowning/choking"
  # hand overlay animation (QAV id 518). The shareware RFF has QAV ids 512..515
  # but NOT 518 (full-game-only), so CChoke::Init(int,…) ThrowError()s "Could
  # not load QAV 518" right after the weapon QAVs. CChoke::Draw already
  # NULL-guards (`if (!hQav) return;`) and the choke overlay can only trigger in
  # gameplay (never at the title/menu), so on a missing QAV we leave hQav NULL
  # (the animation is simply absent) instead of aborting — same shareware-
  # tolerance rationale as the weapon-QAV patch. Surgical + reversible.
  local CHOKE="$NBLOOD_SRC/source/blood/src/choke.cpp"
  if ! grep -q 'shareware: choke QAV' "$CHOKE"; then
    perl -0pi -e 's/        hQav = gSysRes\.Lookup\(qavId, "QAV"\);\n        if \(!hQav\)\n            ThrowError\("Could not load QAV %d\\n", qavId\);\n        pQav = \(QAV\*\)gSysRes\.Lock\(hQav\);/        hQav = gSysRes.Lookup(qavId, "QAV");\n        if (!hQav)\n        {\n            \/\/ shareware: choke QAV (id 518) absent from the shareware RFF. Leave\n            \/\/ hQav NULL (CChoke::Draw already NULL-guards) instead of aborting.\n            LOG_F(WARNING, "choke QAV %d not in RFF (shareware data?) - disabling", qavId);\n            return;\n        }\n        pQav = (QAV*)gSysRes.Lock(hQav);/' "$CHOKE"
    echo "[build-blood-wasm] patched choke.cpp CChoke::Init for shareware-tolerant QAV load"
  fi

  # ── SHAREWARE-tolerant SEQ load (the IN-GAME black-screen fix) ────────────
  # Starting a level BLACK-SCREENS on the bundled 1997 shareware data. Root cause:
  # StartLevel -> playerStart calls seqSpawn(pDudeInfo->seqStartID=12032, ...) and
  # seqSpawn ThrowError()s "Missing sequence #12032" -> abort() KILLS the wasm.
  # The video module's per-frame runFrame() try/catch then swallows the trap, so
  # JS keeps presenting a DEAD (black) framebuffer — exactly the "menu renders but
  # the game is black" report. The player's seqStartID 12032 (and 51 of 59 dude
  # seqStartIDs) are FULL-GAME-only ids: the 1997 shareware BLOOD.RFF (RFF version
  # 0x200, uncrypted) only carries SEQ ids 0..4124, so NBlood's hard-coded v1.21
  # dudeInfo SEQ ids are simply absent from this older shareware set. (Verified by
  # dumping the RFF dictionary: 263 SEQ entries, max id 4124, no 12000-range ids.)
  #
  # Fix (same shareware-tolerance pattern as the weapon/choke QAV patches above):
  # on a missing SEQ, seqSpawn logs a warning and RETURNS instead of aborting, so
  # the level loads + the 3D scene renders. The SEQINST simply stays not-playing
  # (an un-animated sprite) — cosmetic, and harmless in first person where the
  # player sprite isn't drawn. This is a NO-OP once full-game data (One Unit Whole
  # Blood / Fresh Supply, loaded via the card's picker) is present, since every SEQ
  # then resolves. We patch BOTH "Missing sequence" abort sites (seqSpawn + the
  # savegame-restore loop) so neither a fresh start nor a load black-screens.
  # Surgical + reversible (throwaway checkout only).
  local SEQ="$NBLOOD_SRC/source/blood/src/seq.cpp"
  if ! grep -q 'shareware data?) - skipping seqSpawn' "$SEQ"; then
    # (a) seqSpawn: 4/4/8-space, brace-less `if (!hSeq) ThrowError(...)`.
    perl -0pi -e 's/    DICTNODE \*hSeq = gSysRes\.Lookup\(nSeq, "SEQ"\);\n    if \(!hSeq\)\n        ThrowError\("Missing sequence \x23%d", nSeq\);/    DICTNODE *hSeq = gSysRes.Lookup(nSeq, "SEQ");\n    if (!hSeq)\n    {\n        \/\/ shareware: full-game-only SEQ (e.g. the player start seq \x2312032) is\n        \/\/ absent from the 1997 shareware RFF (SEQ ids top out at \x234124). Aborting\n        \/\/ here BLACK-SCREENS a started game (playerStart -> seqSpawn). Skip the\n        \/\/ missing animation instead so the level loads + renders; the SEQINST stays\n        \/\/ not-playing. No-op once full-game data is loaded. (weapon\/choke pattern.)\n        \/\/ Log ONCE: the player start seq is re-requested every tic, so an\n        \/\/ unguarded warning would flood the browser console ~30x\/s.\n        static bool bWarnedMissingSeq = false;\n        if (!bWarnedMissingSeq) { bWarnedMissingSeq = true;\n            LOG_F(WARNING, "SEQ %d not in RFF (shareware data?) - skipping seqSpawn (further warnings suppressed)", nSeq); }\n        return;\n    }/' "$SEQ"
    # (b) savegame-restore loop: 12-space `if (!hSeq) {` with a following `continue;`.
    perl -0pi -e 's/            if \(!hSeq\) \{\n                ThrowError\("Missing sequence \x23%d", nSeq\);\n                continue;\n            \}/            if (!hSeq) {\n                LOG_F(WARNING, "SEQ %d not in RFF (shareware data?) - skipping restore", nSeq);\n                continue;\n            }/' "$SEQ"
    echo "[build-blood-wasm] patched seq.cpp seqSpawn/restore for shareware-tolerant SEQ load"
  fi
}
apply_phase0_patches

# ── Emscripten flags ───────────────────────────────────────────────────────
# -sUSE_SDL=2 is the KEY enabler: emscripten ships its own SDL2 port, which
# satisfies the engine's mutex (SDL_AtomicLock), video, audio, input and
# timing layers without us writing a platform shim for the spike. (The real
# Phase-1 module will likely REPLACE SDL with a bpt_* tick seam, but SDL2 is
# the fastest proof-of-feasibility and a valid fallback path.)
INCLUDES=(
  -I "$NBLOOD_SRC/source/build/include"
  -I "$NBLOOD_SRC/source/glad/include"
  -I "$NBLOOD_SRC/source/blood/src"
  -I "$NBLOOD_SRC/source/mact/include"
  -I "$NBLOOD_SRC/source/audiolib/include"
  # sdlayer.cpp pulls in dear-imgui unconditionally under SDL2; NBlood vendors
  # it here. (The Phase-1 link compiles a minimal imgui subset; see LINK_DIRS.)
  -I "$NBLOOD_SRC/source/imgui/include"
)
CFLAGS=(
  -O1
  -DNORMALUNIX
  -DRENDERTYPESDL
  -funsigned-char   # REQUIRED: upstream builds the whole engine -funsigned-char
                    # (Common.mak). The Build palette color-match code indexes
                    # rdist/gdist/bdist by raw palette BYTES (`rdist[pal1[0]+r]`
                    # in paletteGetClosestColorWithBlacklistNoCache). On wasm32
                    # `char` is SIGNED, so palette bytes >=128 read negative and
                    # the index goes out of bounds → OOB read in palette init
                    # (palettePostLoadTables). See build-blood-wasm comment block.
  -sUSE_SDL=2
  -Wno-everything   # 1997 codebase; warnings here are noise, not signal
)

# ── Phase-0 compile-feasibility check ──────────────────────────────────────
# Compiles a representative cross-section of the engine to prove the toolchain
# path. This is what `bash build-blood-wasm.sh` does today (BLOOD_SPIKE=1).
# These exact TUs were green in the Phase-0 spike (see PHASE0-STATUS.md §2).
SPIKE_TUS=(
  source/build/src/compat.cpp          # foundational (needs patch (1)+(3) — see note)
  source/build/src/engine.cpp          # 15k-line Build software renderer CORE
  source/build/src/polymost.cpp        # GL renderer (→ WebGL via emscripten)
  source/build/src/a-c.cpp             # C software rasteriser (no nasm needed)
  source/build/src/softsurface.cpp     # framebuffer surface (the bpt seam)
  source/build/src/cache1d.cpp
  source/build/src/palette.cpp
  source/build/src/pragmas.cpp
  source/build/src/clip.cpp
  source/blood/src/db.cpp              # Blood game data layer
  source/blood/src/blood.cpp           # Blood game entry
  source/audiolib/src/multivoc.cpp     # audio mixer
)

if [ "$BLOOD_SPIKE" = "1" ] && [ "${BLOOD_LINK:-0}" != "1" ]; then
  echo "[build-blood-wasm] PHASE-0 spike: compile-feasibility check of ${#SPIKE_TUS[@]} representative TUs ..."
  TMP_OBJ="$(mktemp -d)"
  trap 'rm -rf "$TMP_OBJ"' EXIT
  fail=0
  for tu in "${SPIKE_TUS[@]}"; do
    obj="$TMP_OBJ/$(basename "$tu" .cpp).o"
    if emcc -c "${CFLAGS[@]}" "${INCLUDES[@]}" "$NBLOOD_SRC/$tu" -o "$obj" 2>"$TMP_OBJ/err.txt"; then
      printf '  OK   %s\n' "$tu"
    else
      printf '  FAIL %s\n' "$tu"
      grep 'error:' "$TMP_OBJ/err.txt" | head -3 | sed 's/^/         /'
      fail=1
    fi
  done
  if [ "$fail" = 0 ]; then
    echo "[build-blood-wasm] PHASE-0 RESULT: ✓ all representative TUs compiled to WASM — toolchain path CONFIRMED."
    echo "[build-blood-wasm] Next: Phase 1 = platform shim (bpt_* seam) + full link. See PHASE0-STATUS.md."
  else
    echo "[build-blood-wasm] PHASE-0 RESULT: some TUs failed — see errors above + PHASE0-STATUS.md §2.3." >&2
    exit 1
  fi
  if [ "${BLOOD_LINK:-0}" != "1" ]; then
    exit 0
  fi
  echo "[build-blood-wasm] BLOOD_LINK=1 → proceeding to Phase-1 full link ..."
fi

# ── Phase 1: full link to blood.{js,wasm} (BLOOD_LINK=1) ────────────────────
# Mirrors build-doom-wasm.sh's link step, scaled to the EDuke32/Build stack.
# Strategy (see bloodgeneric_patchtogether.cpp header for the full rationale):
#   * Software renderer ONLY: USE_OPENGL is NOT defined → polymost/glbuild/
#     glsurface/glad drop out; a-c.cpp (C rasteriser) is the render path.
#   * -DNOASM: no self-modifying-asm mprotect (PHASE0-STATUS.md §2.4 wall),
#     selects ENGINE_USING_A_C.
#   * Keep emscripten SDL2 (-sUSE_SDL=2) for window/input/audio/timing; our
#     shim overrides videoShowFrame (sdlayer's renamed to _sdl) to snapshot
#     the frame + yield via ASYNCIFY.
#   * -sASYNCIFY: lets the blocking app_main() loop suspend at each frame.
#
# This compiles the whole build-engine + Blood game + mact + audiolib source
# trees, EXCLUDING the GL/asm/platform-duplicate/optional TUs (see SKIP).
LINK_CFLAGS=(
  -O1
  -g2
  -DNORMALUNIX
  -DRENDERTYPESDL
  -DNOASM
  -DBLOOD_PT_SHIM
  # REQUIRED: upstream Common.mak builds the ENTIRE engine with -funsigned-char.
  # The Build palette closest-color matcher indexes the rdist/gdist/bdist
  # distance LUTs by raw palette BYTES (e.g. `rdist[pal1[0]+r]` in
  # paletteGetClosestColorWithBlacklistNoCache). wasm32's default `char` is
  # SIGNED, so any palette component >=128 reads as a NEGATIVE index → an
  # out-of-bounds heap read during palette init (palettePostLoadTables, right
  # after screen.cpp "Loading translucency table"). This flag — matching
  # upstream — keeps every `char` palette byte 0..255 so the index stays in
  # bounds. (Root cause of the Phase-1 palette-init OOB; do NOT drop it.)
  -funsigned-char
  -sUSE_SDL=2
  -fno-strict-aliasing
  -Wno-everything
  -std=gnu++17
)

# Source dirs whose .cpp we sweep wholesale, minus SKIP below.
LINK_DIRS=(
  source/build/src
  source/blood/src
  source/mact/src
  source/audiolib/src
  source/imgui/src
)

# TUs to EXCLUDE from the link. Rationale per group:
#   GL renderer (USE_OPENGL off): polymost, polymer, glbuild, mdsprite,
#     texcache, hightile, glsurface, voxmodel(GL parts via build2d? keep 2d).
#   ASM: a.masm/a.nasm are not .cpp (sweep is .cpp only) — a-c.cpp stays.
#   Platform we DON'T want: winlayer/sdlayer12 (we use sdlayer.cpp), startgtk,
#     *_gtk, the editor TUs (build2d/buildvox/roach — editor-only).
#   Optional heavy: imgui glue, smacker (libsmackerdec), xmp, mimalloc
#     (smmalloc_generic), the various audio DRIVERS except SDL+null.
#   Duplicate mains / standalone tools.
# GL renderer (USE_OPENGL off, so engine.cpp never calls into these). voxmodel/
# mdsprite/texcache/glsurface/glbuild/polymost/polymer are the GL path; dxtfilter
# + animvpx are GL/vpx asset codecs. hightile/screenshot/communityapi/smmalloc
# are referenced UNCONDITIONALLY by baselayer/engine — KEEP them (do NOT skip).
SKIP_REGEX='polymost|polymer|glbuild|glsurface|mdsprite|texcache|voxmodel|dxtfilter|animvpx'
# Non-wasm platform layers (we keep sdlayer.cpp only).
SKIP_REGEX="$SKIP_REGEX"'|winlayer|winbits|rawinput|wiibits|dynamicgtk|gtkbits|startgtk|startwin|sdlayer12|sdlkeytrans|cpuid'
# Editor main + tile-packer asset tool.
SKIP_REGEX="$SKIP_REGEX"'|tilepacker|^build\.cpp$'
# Netplay transport mmulti.cpp (defer to Phase-2 MP; its single-player
# connection globals are stubbed in the shim). KEEP enet.cpp — blood/network.cpp
# calls into ENet even in single-player init; ENet is portable C and links on
# wasm (emscripten BSD sockets), so it's cheaper to link than to stub.
SKIP_REGEX="$SKIP_REGEX"'|mmulti'
# Editor-only Blood TUs + M32-script editor fragments + the Smacker intro
# (credits.cpp needs libsmackerdec). These are NOT part of the GAME link.
# m32structures/nnextsif are #include fragments, not standalone TUs.
SKIP_REGEX="$SKIP_REGEX"'|^mapedit\.cpp$|m32exec|m32common|m32def|m32structures|m32vars|nnextsif|^credits\.cpp$'
# OS-specific audio OUTPUT drivers we don't have on wasm (keep driver_sdl as the
# output backend). KEEP driver_adlib (the OPL3 FM SOFTWARE-synth MIDI driver) —
# fx_man.cpp references AL_*/AdLibDrv_* unconditionally + opl3.cpp is portable
# DSP that links on wasm.
SKIP_REGEX="$SKIP_REGEX"'|driver_alsa|driver_directsound|driver_winmm|driver_jack|driver_coreaudio|driver_rtaudio'
# music_external.cpp is an ALTERNATIVE MUSIC_* backend (external player); it
# collides with music.cpp's MUSIC_*. Keep music.cpp (the standard backend).
SKIP_REGEX="$SKIP_REGEX"'|music_external'
# Dear-imgui backends we don't use (GL3 / win32) + the demo window. Keep the
# core (imgui/draw/tables/widgets) + the SDL2 platform backend sdlayer uses.
SKIP_REGEX="$SKIP_REGEX"'|imgui_impl_opengl3|imgui_impl_win32|imgui_demo'

OUT_LINK_DIR="$OUT_DIR"
mkdir -p "$OUT_LINK_DIR"
LINK_SRCS=()
for d in "${LINK_DIRS[@]}"; do
  while IFS= read -r f; do
    base="$(basename "$f")"
    if echo "$base" | grep -qE "$SKIP_REGEX"; then continue; fi
    LINK_SRCS+=("$f")
  # Sweep BOTH .cpp and the vendored C libs (.c: lz4 / miniz / xxhash live in
  # build/src and are referenced unconditionally — cache1d/tiles compression).
  done < <(find "$NBLOOD_SRC/$d" -maxdepth 1 \( -name '*.cpp' -o -name '*.c' \) | sort)
done
# Our platform shim.
LINK_SRCS+=("$SCRIPT_DIR/nblood/bloodgeneric_patchtogether.cpp")

echo "[build-blood-wasm] LINK: ${#LINK_SRCS[@]} TUs (software renderer, NOASM, ASYNCIFY) ..."

# Compile each TU to a cached .o first (so re-runs are fast + a compile error
# names the exact file instead of aborting the whole emcc invocation). Object
# cache lives in the gitignored scratch tree.
OBJ_DIR="$SCRIPT_DIR/nblood/.objcache"
mkdir -p "$OBJ_DIR"
OBJS=()
cfail=0
for src in "${LINK_SRCS[@]}"; do
  # Namespace the object name by its module dir (build/blood/mact/audiolib/
  # imgui) so build/src/common.cpp and blood/src/common.cpp (DIFFERENT files,
  # same basename) don't collide in the flat cache → a spurious wasm-ld
  # "duplicate symbol" at link. dirname twice strips the trailing /src.
  moddir="$(basename "$(dirname "$(dirname "$src")")")"
  base="${moddir}__$(basename "$src")"   # keep extension → .c/.cpp stay distinct
  obj="$OBJ_DIR/$base.o"
  # The vendored C libs (lz4/miniz/xxhash) must NOT get the C++ std flag.
  TU_FLAGS=("${LINK_CFLAGS[@]}")
  case "$src" in
    *.c) TU_FLAGS=("${LINK_CFLAGS[@]/-std=gnu++17/}") ;;
  esac
  # Recompile if the object is missing or older than the source.
  if [ ! -f "$obj" ] || [ "$src" -nt "$obj" ]; then
    if ! emcc -c "${TU_FLAGS[@]}" "${INCLUDES[@]}" "$src" -o "$obj" 2>"$OBJ_DIR/.err"; then
      printf '  CFAIL %s\n' "$base"
      grep -m3 'error:' "$OBJ_DIR/.err" | sed 's/^/          /'
      cfail=1
      continue
    fi
  fi
  OBJS+=("$obj")
done
if [ "$cfail" = 1 ]; then
  echo "[build-blood-wasm] LINK: some TUs failed to COMPILE (see CFAIL above) — fix SKIP_REGEX or patch." >&2
  exit 1
fi
echo "[build-blood-wasm] LINK: all ${#OBJS[@]} TUs compiled; linking ..."

BPT_EXPORTS='[
  "_bpt_init","_bpt_tick","_bpt_get_framebuffer","_bpt_get_framebuffer_size",
  "_bpt_get_resx","_bpt_get_resy","_bpt_has_frame","_bpt_set_key",
  "_bpt_get_pcm_buffer","_bpt_get_pcm_buffer_size","_malloc","_free"
]'
BPT_RUNTIME_METHODS='["HEAPU8","HEAPU32","HEAPF32","ccall","cwrap","FS"]'

# BLOOD_DEBUG=1 enables emscripten assertions + a JS stack on traps (for
# diagnosing engine-init faults like a divide-by-zero). Off by default.
DEBUG_FLAGS=()
if [ "${BLOOD_DEBUG:-0}" = "1" ]; then
  DEBUG_FLAGS=(-sASSERTIONS=2 -sSAFE_HEAP=0)
  echo "[build-blood-wasm] BLOOD_DEBUG=1 → assertions on"
fi

emcc \
  "${LINK_CFLAGS[@]}" \
  "${OBJS[@]}" \
  ${DEBUG_FLAGS[@]+"${DEBUG_FLAGS[@]}"} \
  -sMODULARIZE=1 \
  -sEXPORT_ES6=1 \
  -sEXPORT_NAME=loadBlood \
  -sALLOW_MEMORY_GROWTH=1 \
  -sINITIAL_MEMORY=134217728 \
  -sSTACK_SIZE=5242880 \
  -sFORCE_FILESYSTEM=1 \
  -sASYNCIFY=1 \
  -sASYNCIFY_STACK_SIZE=131072 \
  -sENVIRONMENT="$BLOOD_ENVIRONMENT" \
  -sEXIT_RUNTIME=0 \
  -sERROR_ON_UNDEFINED_SYMBOLS=1 \
  -sEXPORTED_FUNCTIONS="$BPT_EXPORTS" \
  -sEXPORTED_RUNTIME_METHODS="$BPT_RUNTIME_METHODS" \
  -o "$OUT_LINK_DIR/$OUT_NAME.js"

echo "[build-blood-wasm] LINK OK — wrote:"
ls -lh "$OUT_LINK_DIR/$OUT_NAME.js" "$OUT_LINK_DIR/$OUT_NAME.wasm"
exit 0
