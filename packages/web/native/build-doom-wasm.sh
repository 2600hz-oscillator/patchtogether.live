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

# Output basename + emcc -sENVIRONMENT. Both default to the production
# single-player target; the slice-1 Node acceptance harness overrides them
# (DOOM_OUT=doom-mp-node, DOOM_ENVIRONMENT=web,worker,node) to emit a
# separate, Node-loadable MP artifact without touching the prod build.
OUT_NAME="${DOOM_OUT:-doom}"
DOOM_ENVIRONMENT="${DOOM_ENVIRONMENT:-web}"
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
  # We use the bare null-audio i_sound.c (in doomgeneric) PLUS our own
  # portable mixer i_pcmgen.c (slice 8: SFX path; music is a stub).
  "$VENDOR_DIR/i_sound.c"
  "$VENDOR_DIR/i_pcmgen.c"
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

# Multiplayer (netplay) sources — chocolate-doom 2.1.0 net_*.c, vendored
# verbatim, plus our own net_pt.c (the real WASM<->JS transport, slice 1)
# and net_pt_stub.c (a no-op NET_WaitForLaunch — the curses lobby loop we
# replace with the DoomCard UI). net_pt.c provides net_pt_module, the
# net_module_t the netcode registers as its active transport.
#
# These are ONLY compiled when DOOM_MP=1. In the default single-player
# build they are not passed to emcc at all, so:
#   - the output WASM is byte-for-byte the current single-player binary;
#   - dummy.c keeps providing the net_client_connected / drone globals
#     (its #ifndef FEATURE_MULTIPLAYER stubs), which d_loop.c / d_main.c /
#     d_net.c reference even in single-player.
# When DOOM_MP=1, net_client.c owns those globals and FEATURE_MULTIPLAYER
# switches dummy.c's stubs off, avoiding a duplicate-symbol link error.
if [ "${DOOM_MP:-}" = "1" ]; then
  SRCS+=(
    "$VENDOR_DIR/net_client.c"
    "$VENDOR_DIR/net_common.c"
    "$VENDOR_DIR/net_io.c"
    "$VENDOR_DIR/net_loop.c"
    "$VENDOR_DIR/net_packet.c"
    "$VENDOR_DIR/net_pt.c"
    "$VENDOR_DIR/net_pt_stub.c"
    "$VENDOR_DIR/net_query.c"
    "$VENDOR_DIR/net_server.c"
    "$VENDOR_DIR/net_structrw.c"
  )
fi

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
  "_dg_get_pcm_buffer",
  "_dg_get_pcm_buffered_frames",
  "_dg_get_pcm_sample_rate",
  "_dgpt_get_player_x",
  "_dgpt_get_player_y",
  "_dgpt_get_player_angle",
  "_dgpt_has_player_mobj",
  "_dgpt_start_netgame",
  "_dgpt_get_gamestate",
  "_dgpt_exit_level",
  "_dgpt_get_console_player",
  "_dgpt_get_console_player_x",
  "_dgpt_get_console_player_y",
  "_dgpt_has_console_player_mobj",
  "_dgpt_get_player_slot_x",
  "_dgpt_get_player_slot_y",
  "_dgpt_has_player_slot_mobj",
  "_dgpt_has_local_ticcmd",
  "_dgpt_local_ticcmd_forwardmove",
  "_dgpt_local_ticcmd_sidemove",
  "_dgpt_local_ticcmd_angleturn",
  "_dgpt_local_ticcmd_buttons",
  "_dgpt_inject_remote_ticcmd",
  "_dgpt_set_scripted",
  "_dgpt_set_lockstep",
  "_dgpt_set_input_delay",
  "_dgpt_receive_ticset",
  "_dgpt_get_maketic",
  "_dgpt_get_gametic",
  "_dgpt_get_recvtic",
  "_dgpt_local_ticcmd_at",
  "_dgpt_local_ticcmd_at_forwardmove",
  "_dgpt_local_ticcmd_at_sidemove",
  "_dgpt_local_ticcmd_at_angleturn",
  "_dgpt_local_ticcmd_at_buttons",
  "_dgpt_state_checksum",
  "_dgpt_drain_events",
  "_dgpt_evt_head_get",
  "_dgpt_evt_tail_get",
  "_malloc",
  "_free"
]'

# When building the multiplayer variant, also force-export the top-level
# netcode entry points. Two reasons:
#   1. It proves (via wasm-objdump -x) that the vendored net_*.c actually
#      linked into the binary and FEATURE_MULTIPLAYER took effect.
#   2. The slice-1 net_pt.c transport + slice-2 JS netcode will need to
#      drive these from JS (NET_CL_Connect / NET_SV_Init / ...).
# These are NOT added to the default single-player build, so its export
# table — and therefore the emitted WASM — is unchanged.
if [ "${DOOM_MP:-}" = "1" ]; then
  EXPORTS="$(printf '%s' "$EXPORTS" | sed 's/\][[:space:]]*$//')"
  EXPORTS="$EXPORTS,
  \"_NET_CL_Init\",
  \"_NET_CL_Connect\",
  \"_NET_CL_Disconnect\",
  \"_NET_CL_Run\",
  \"_NET_CL_LaunchGame\",
  \"_NET_CL_StartGame\",
  \"_NET_SV_Init\",
  \"_NET_SV_Run\",
  \"_NET_SV_Shutdown\",
  \"_NET_SV_AddModule\",
  \"_NET_SV_RegisterWithMaster\",
  \"_dgpt_net_register\",
  \"_dgpt_net_inject_packet\",
  \"_dgpt_net_peer_id_for_addr\",
  \"_dgpt_net_reset\",
  \"_dgpt_net_sent_type_mask\",
  \"_dgpt_net_recv_type_mask\",
  \"_dgpt_net_sent_count\",
  \"_dgpt_net_recv_count\",
  \"_dgpt_net_test_init\",
  \"_dgpt_net_test_drain_one\",
  \"_dgpt_net_sv_add_pt_module\",
  \"_dgpt_net_cl_connect\"
]"
fi

# Runtime methods we need from the emcc-generated JS shim.
# FS is the MEMFS handle — we write DOOM1.WAD into it from JS before
# calling dgpt_init. emscripten ≥4 no longer exports it by default
# even with -sFORCE_FILESYSTEM=1, so we have to list it explicitly
# (else the runtime ships and `Module.FS` is undefined → "Cannot read
# properties of undefined (reading 'writeFile')").
RUNTIME_METHODS='["HEAPU32","HEAPU8","HEAPF32","ccall","cwrap","FS"]'

# Suppress doomgeneric's compile warnings (it's a 1993 codebase + we don't
# own the source — warnings here are noise, not signal).
#
# FEATURE_SOUND switches on i_sound.c's sound_module_t dispatch path so
# our DG_sound_module (from i_pcmgen.c) gets installed. DG_music_module
# is a no-op stub in the same file — see i_pcmgen.c head comment.
CFLAGS=(
  -O3
  -DNORMALUNIX
  -DFEATURE_SOUND
  -Wno-everything
)

# FEATURE_MULTIPLAYER switches on the netplay state machine in d_loop.c /
# d_net.c (the #ifdef FEATURE_MULTIPLAYER branches) so the vendored
# chocolate-doom net_*.c gets wired into the game-start / lockstep path.
# GATED behind DOOM_MP so the default build is byte-for-byte the current
# single-player WASM: prod stays untouched until the netcode is wired up
# end-to-end (slice 3). Build the MP variant with:
#
#   DOOM_MP=1 bash packages/web/native/build-doom-wasm.sh
#
if [ "${DOOM_MP:-}" = "1" ]; then
  echo "[build-doom-wasm] DOOM_MP=1 -> enabling FEATURE_MULTIPLAYER"
  CFLAGS+=(-DFEATURE_MULTIPLAYER)
fi

LDFLAGS=(
  -sMODULARIZE=1
  -sEXPORT_ES6=1
  -sEXPORT_NAME=loadDoom
  -sALLOW_MEMORY_GROWTH=1
  -sINITIAL_MEMORY=33554432       # 32 MB — enough for shareware WAD + game state
  -sFORCE_FILESYSTEM=1            # we write DOOM1.WAD into MEMFS at runtime
  -sFILESYSTEM=1
  -sENVIRONMENT="$DOOM_ENVIRONMENT"
  -sSTRICT=0                      # doomgeneric uses non-strict CRT bits
  -sEXIT_RUNTIME=0
  -sEXPORTED_FUNCTIONS="$EXPORTS"
  -sEXPORTED_RUNTIME_METHODS="$RUNTIME_METHODS"
)

echo "[build-doom-wasm] compiling ${#SRCS[@]} sources -> ${OUT_NAME}.{js,wasm} (env=$DOOM_ENVIRONMENT)..."
emcc \
  "${CFLAGS[@]}" \
  "${LDFLAGS[@]}" \
  "${SRCS[@]}" \
  -o "$OUT_DIR/$OUT_NAME.js"

echo "[build-doom-wasm] wrote:"
ls -lh "$OUT_DIR/$OUT_NAME.js" "$OUT_DIR/$OUT_NAME.wasm"
