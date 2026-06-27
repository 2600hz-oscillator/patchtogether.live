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
  # (3) baselayer.cpp self-modifying-asm mprotect: WASM has no RWX memory and
  #     we use the C software renderer (a-c.cpp), so the unprotect is a no-op.
  #     The Phase-0 spike does NOT compile baselayer.cpp (it's part of the
  #     platform/main-loop layer the Phase-1 shim replaces wholesale), so this
  #     patch is documented but deferred to the Phase-1 shim patch series.
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
)
CFLAGS=(
  -O1
  -DNORMALUNIX
  -DRENDERTYPESDL
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

if [ "$BLOOD_SPIKE" = "1" ]; then
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
  exit 0
fi

# ── Phase 1 (NOT YET IMPLEMENTED): full link to blood.{js,wasm} ─────────────
echo "error: full link (BLOOD_SPIKE=0) is Phase 1 and not implemented in this spike." >&2
echo "       It needs the bloodgeneric_patchtogether.cpp platform shim (bpt_* exports)" >&2
echo "       mirroring doomgeneric_patchtogether.c. See native/nblood/PHASE0-STATUS.md." >&2
exit 2
