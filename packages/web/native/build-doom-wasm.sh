#!/usr/bin/env bash
#
# build-doom-wasm.sh — compile vendored doomgeneric to WebAssembly
# (packages/web/static/doom/doom.{js,wasm}). Run once per source-tree
# change; the output is .gitignored (we don't ship pre-built WASM in
# git — too noisy on diffs and the build is deterministic enough that
# CI can produce it on demand).
#
# Usage:
#   bash packages/web/native/build-doom-wasm.sh
#
# Requirements:
#   emcc (Emscripten) installed and on PATH.
#       https://emscripten.org/docs/getting_started/downloads.html
#       (verified with emsdk 3.1.61 — older versions may not export
#        ccall properly; bump if you hit "ccall is not a function").
#   bash 4+ (for `set -o pipefail`).
#
# Output:
#   packages/web/static/doom/doom.js   — ES module shim emcc generates
#   packages/web/static/doom/doom.wasm — the actual binary
#
# DOOM1.WAD is NOT bundled into the .data sidecar — it's loaded at
# runtime from /doom/DOOM1.WAD (see DOWNLOAD_INSTRUCTIONS.md). Keeps
# the WASM build deterministic without a 4 MB binary input.

set -euo pipefail

# Resolve script dir → repo paths.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENDOR_DIR="$SCRIPT_DIR/doomgeneric/doomgeneric"
OUT_DIR="$SCRIPT_DIR/../static/doom"
mkdir -p "$OUT_DIR"

if ! command -v emcc >/dev/null 2>&1; then
  echo "error: emcc not found on PATH" >&2
  echo "install Emscripten per https://emscripten.org/docs/getting_started/downloads.html" >&2
  exit 127
fi

# C sources to compile. List excludes the platform-specific shims
# (allegro/sdl/linuxvt/etc.) — we use our own doomgeneric_patchtogether.c.
# Order doesn't matter at -O3 LTO time but keep it alphabetical for diff
# stability.
SRCS=(
  "$VENDOR_DIR/am_map.c"
  "$VENDOR_DIR/d_event.c"
  "$VENDOR_DIR/d_items.c"
  "$VENDOR_DIR/d_iwad.c"
  "$VENDOR_DIR/d_loop.c"
  "$VENDOR_DIR/d_main.c"
  "$VENDOR_DIR/d_mode.c"
  "$VENDOR_DIR/d_net.c"
  "$VENDOR_DIR/doomdef.c"
  "$VENDOR_DIR/doomgeneric.c"
  "$VENDOR_DIR/doomgeneric_patchtogether.c"
  "$VENDOR_DIR/doomstat.c"
  "$VENDOR_DIR/dstrings.c"
  "$VENDOR_DIR/dummy.c"
  "$VENDOR_DIR/f_finale.c"
  "$VENDOR_DIR/f_wipe.c"
  "$VENDOR_DIR/g_game.c"
  "$VENDOR_DIR/gusconf.c"
  "$VENDOR_DIR/hu_lib.c"
  "$VENDOR_DIR/hu_stuff.c"
  "$VENDOR_DIR/i_cdmus.c"
  "$VENDOR_DIR/i_endoom.c"
  "$VENDOR_DIR/i_input.c"
  "$VENDOR_DIR/i_joystick.c"
  "$VENDOR_DIR/i_scale.c"
  # i_sdlmusic, i_sdlsound, i_allegro{music,sound} require SDL/Allegro.
  # We use the bare null-audio i_sound.c (in doomgeneric) — slice-8
  # audio uses our own implementation when it lands.
  "$VENDOR_DIR/i_sound.c"
  "$VENDOR_DIR/i_system.c"
  "$VENDOR_DIR/i_timer.c"
  "$VENDOR_DIR/i_video.c"
  "$VENDOR_DIR/icon.c"
  "$VENDOR_DIR/info.c"
  "$VENDOR_DIR/m_argv.c"
  "$VENDOR_DIR/m_bbox.c"
  "$VENDOR_DIR/m_cheat.c"
  "$VENDOR_DIR/m_config.c"
  "$VENDOR_DIR/m_controls.c"
  "$VENDOR_DIR/m_fixed.c"
  "$VENDOR_DIR/m_menu.c"
  "$VENDOR_DIR/m_misc.c"
  "$VENDOR_DIR/m_random.c"
  "$VENDOR_DIR/memio.c"
  "$VENDOR_DIR/mus2mid.c"
  "$VENDOR_DIR/p_ceilng.c"
  "$VENDOR_DIR/p_doors.c"
  "$VENDOR_DIR/p_enemy.c"
  "$VENDOR_DIR/p_floor.c"
  "$VENDOR_DIR/p_inter.c"
  "$VENDOR_DIR/p_lights.c"
  "$VENDOR_DIR/p_map.c"
  "$VENDOR_DIR/p_maputl.c"
  "$VENDOR_DIR/p_mobj.c"
  "$VENDOR_DIR/p_plats.c"
  "$VENDOR_DIR/p_pspr.c"
  "$VENDOR_DIR/p_saveg.c"
  "$VENDOR_DIR/p_setup.c"
  "$VENDOR_DIR/p_sight.c"
  "$VENDOR_DIR/p_spec.c"
  "$VENDOR_DIR/p_switch.c"
  "$VENDOR_DIR/p_telept.c"
  "$VENDOR_DIR/p_tick.c"
  "$VENDOR_DIR/p_user.c"
  "$VENDOR_DIR/r_bsp.c"
  "$VENDOR_DIR/r_data.c"
  "$VENDOR_DIR/r_draw.c"
  "$VENDOR_DIR/r_main.c"
  "$VENDOR_DIR/r_plane.c"
  "$VENDOR_DIR/r_segs.c"
  "$VENDOR_DIR/r_sky.c"
  "$VENDOR_DIR/r_things.c"
  "$VENDOR_DIR/s_sound.c"
  "$VENDOR_DIR/sha1.c"
  "$VENDOR_DIR/sounds.c"
  "$VENDOR_DIR/st_lib.c"
  "$VENDOR_DIR/st_stuff.c"
  "$VENDOR_DIR/statdump.c"
  "$VENDOR_DIR/tables.c"
  "$VENDOR_DIR/v_video.c"
  "$VENDOR_DIR/w_checksum.c"
  "$VENDOR_DIR/w_file.c"
  "$VENDOR_DIR/w_file_stdc.c"
  "$VENDOR_DIR/w_main.c"
  "$VENDOR_DIR/w_wad.c"
  "$VENDOR_DIR/wi_stuff.c"
  "$VENDOR_DIR/z_zone.c"
)

# Functions we expose to JS. Underscore prefix is the emcc convention.
EXPORTS='[
  "_dgpt_init",
  "_dgpt_tick",
  "_dgpt_advance_clock",
  "_dgpt_get_framebuffer",
  "_dgpt_get_framebuffer_size",
  "_dgpt_get_resx",
  "_dgpt_get_resy",
  "_dgpt_set_key",
  "_dgpt_get_pcm_buffer",
  "_dgpt_get_pcm_buffer_size",
  "_malloc",
  "_free"
]'

# Runtime methods we need from the emcc-generated JS shim.
# FS is the MEMFS handle — we write DOOM1.WAD into it from JS before
# calling dgpt_init. emscripten ≥4 no longer exports it by default
# even with -sFORCE_FILESYSTEM=1, so we have to list it explicitly
# (else the runtime ships and `Module.FS` is undefined → "Cannot read
# properties of undefined (reading 'writeFile')").
RUNTIME_METHODS='["HEAPU32","HEAPU8","HEAPF32","ccall","cwrap","FS"]'

# Suppress doomgeneric's compile warnings (it's a 1993 codebase + we don't
# own the source — warnings here are noise, not signal).
CFLAGS=(
  -O3
  -DNORMALUNIX
  -Wno-everything
)

LDFLAGS=(
  -sMODULARIZE=1
  -sEXPORT_ES6=1
  -sEXPORT_NAME=loadDoom
  -sALLOW_MEMORY_GROWTH=1
  -sINITIAL_MEMORY=33554432       # 32 MB — enough for shareware WAD + game state
  -sFORCE_FILESYSTEM=1            # we write DOOM1.WAD into MEMFS at runtime
  -sFILESYSTEM=1
  -sENVIRONMENT=web
  -sSTRICT=0                      # doomgeneric uses non-strict CRT bits
  -sEXIT_RUNTIME=0
  -sEXPORTED_FUNCTIONS="$EXPORTS"
  -sEXPORTED_RUNTIME_METHODS="$RUNTIME_METHODS"
)

echo "[build-doom-wasm] compiling ${#SRCS[@]} sources..."
emcc \
  "${CFLAGS[@]}" \
  "${LDFLAGS[@]}" \
  "${SRCS[@]}" \
  -o "$OUT_DIR/doom.js"

echo "[build-doom-wasm] wrote:"
ls -lh "$OUT_DIR/doom.js" "$OUT_DIR/doom.wasm"
