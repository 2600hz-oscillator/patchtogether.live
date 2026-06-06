#!/usr/bin/env bash
#
# build-snes9x-wasm.sh — compile the vendored snes9x2005 (CAT SFC) libretro
# core + our snes9x_bridge.c to WebAssembly
# (packages/web/static/snes9x/snes9x.{js,wasm}). Run once per source-tree
# change; the output is .gitignored (we don't ship pre-built WASM in git —
# too noisy on diffs + the build is deterministic, CI can produce on demand).
# Mirrors build-doom-wasm.sh.
#
# Usage:
#   bash packages/web/native/build-snes9x-wasm.sh
#
# Requirements:
#   emcc (Emscripten) on PATH (verified with the flox-provided emsdk;
#   emcc --version 5.0.6-git in this repo's flox env).
#
# Output:
#   packages/web/static/snes9x/snes9x.js   — ES module shim emcc generates
#   packages/web/static/snes9x/snes9x.wasm — the actual binary
#
# The ROM is NOT bundled — it's loaded at runtime from a user-supplied
# .sfc/.smc (see static/roms/snes9x/README.md + `task setup:snes9x`).
#
# License: the vendored core is the libretro-team MIT relicense of
# snes9x2005 / CAT SFC (see native/snes9x/copyright). MIT is AGPL-
# compatible — same convention as the vendored doomgeneric.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SNES_DIR="$SCRIPT_DIR/snes9x"
CORE_DIR="$SNES_DIR/source"
COMM_DIR="$SNES_DIR/libretro-common"
OUT_DIR="$SCRIPT_DIR/../static/snes9x"
OUT_NAME="snes9x"

mkdir -p "$OUT_DIR"

if ! command -v emcc >/dev/null 2>&1; then
  echo "error: emcc not found on PATH" >&2
  echo "install Emscripten per https://emscripten.org/docs/getting_started/downloads.html" >&2
  exit 127
fi

# snes9x2005 core sources (from Makefile.common SOURCES_C, minus the
# file-stream + compat deps — we build with -DLOAD_FROM_MEMORY so the core
# never touches the filesystem). USE_BLARGG_APU is OFF (default), so the
# blargg apu_blargg.c is excluded and apu.c/soundux.c/spc700.c are used.
SRCS=(
  "$CORE_DIR/c4.c"
  "$CORE_DIR/c4emu.c"
  "$CORE_DIR/cheats2.c"
  "$CORE_DIR/cheats.c"
  "$CORE_DIR/clip.c"
  "$CORE_DIR/cpu.c"
  "$CORE_DIR/cpuexec.c"
  "$CORE_DIR/cpuops.c"
  "$CORE_DIR/data.c"
  "$CORE_DIR/dma.c"
  "$CORE_DIR/dsp1.c"
  "$CORE_DIR/fxemu.c"
  "$CORE_DIR/fxinst.c"
  "$CORE_DIR/gfx.c"
  "$CORE_DIR/getset.c"
  "$CORE_DIR/globals.c"
  "$CORE_DIR/memmap.c"
  "$CORE_DIR/obc1.c"
  "$CORE_DIR/ppu.c"
  "$CORE_DIR/sa1.c"
  "$CORE_DIR/sa1cpu.c"
  "$CORE_DIR/sdd1.c"
  "$CORE_DIR/sdd1emu.c"
  "$CORE_DIR/seta010.c"
  "$CORE_DIR/seta011.c"
  "$CORE_DIR/seta018.c"
  "$CORE_DIR/seta.c"
  "$CORE_DIR/spc7110.c"
  "$CORE_DIR/spc7110dec.c"
  "$CORE_DIR/srtc.c"
  "$CORE_DIR/tile.c"
  # default (non-blargg) APU
  "$CORE_DIR/apu.c"
  "$CORE_DIR/soundux.c"
  "$CORE_DIR/spc700.c"
  # libretro frontend (the core's libretro.c) + our bridge
  "$SNES_DIR/libretro.c"
  "$SNES_DIR/snes9x_bridge.c"
)

# Exported C functions (snes9x_bridge.c). emscripten needs the leading "_".
EXPORTS='[
  "_snes_init",
  "_snes_load_rom",
  "_snes_rom_loaded",
  "_snes_run_frame",
  "_snes_get_framebuffer",
  "_snes_get_fb_width",
  "_snes_get_fb_height",
  "_snes_get_audio_buffer",
  "_snes_get_audio_frames",
  "_snes_set_input",
  "_snes_get_wram",
  "_snes_get_wram_size",
  "_snes_read_wram",
  "_malloc",
  "_free"
]'

RUNTIME_METHODS='["HEAPU8","HEAPU16","HEAPU32","HEAP16","HEAPF32","ccall","cwrap"]'

# -DLOAD_FROM_MEMORY: core takes ROM bytes from game->data (no file IO).
# -DRIGHTSHIFT_IS_SAR + -DFAST_LSB_WORD_ACCESS: standard snes9x2005 perf
#   defines (wasm is little-endian, arithmetic shift). -Wno-everything: the
#   core is a large 3rd-party C codebase, warnings are noise not signal.
CFLAGS=(
  -O3
  -DLOAD_FROM_MEMORY
  -DRIGHTSHIFT_IS_SAR
  -DFAST_LSB_WORD_ACCESS
  -DHAVE_STDINT_H
  -I"$CORE_DIR"
  -I"$COMM_DIR/include"
  -Wno-everything
)

LDFLAGS=(
  -sMODULARIZE=1
  -sEXPORT_ES6=1
  -sEXPORT_NAME=loadSnes9x
  -sALLOW_MEMORY_GROWTH=1
  -sINITIAL_MEMORY=67108864        # 64 MB — SNES RAM + ROM (up to ~6 MB) + core state
  -sENVIRONMENT=web,worker
  -sSTRICT=0
  -sEXIT_RUNTIME=0
  -sEXPORTED_FUNCTIONS="$EXPORTS"
  -sEXPORTED_RUNTIME_METHODS="$RUNTIME_METHODS"
)

echo "[build-snes9x-wasm] compiling ${#SRCS[@]} sources -> ${OUT_NAME}.{js,wasm}..."
emcc \
  "${CFLAGS[@]}" \
  "${LDFLAGS[@]}" \
  "${SRCS[@]}" \
  -o "$OUT_DIR/$OUT_NAME.js"

echo "[build-snes9x-wasm] wrote:"
ls -lh "$OUT_DIR/$OUT_NAME.js" "$OUT_DIR/$OUT_NAME.wasm"
