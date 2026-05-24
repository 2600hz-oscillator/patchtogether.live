//
// Copyright(C) 2026 patchtogether.live contributors
//
// This program is free software; you can redistribute it and/or
// modify it under the terms of the GNU General Public License
// as published by the Free Software Foundation; either version 2
// of the License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// DESCRIPTION:
//     Dependency stubs for the vendored chocolate-doom net_*.c sources.
//
//     The chocolate-doom networking code we vendor (net_client.c,
//     net_server.c, net_query.c, ...) and doomgeneric's patched
//     d_loop.c reference NET_WaitForLaunch, which lives in an upstream
//     source file we deliberately do NOT vendor because it pulls in the
//     textscreen/curses GUI library (net_gui.c), which does not exist in
//     the WASM build:
//
//       - NET_WaitForLaunch (net_gui.c) — the textscreen "waiting for
//         players" lobby loop. patchtogether.live replaces this with
//         the DoomCard UI, so this is a no-op here.
//
//     (The UDP transport net_sdl.c is also not vendored; slice 1's
//     net_pt.c provides the real net_module_t transport — net_pt_module —
//     that the d_loop.c / net_query.c call sites now reference directly.)
//
//     This file is compiled into BOTH build variants but is inert in
//     the default single-player build: nothing references this symbol
//     unless FEATURE_MULTIPLAYER is defined (DOOM_MP=1). It is our own
//     code (not vendored), hence the patchtogether copyright; it remains
//     GPLv2 to match the engine it links against.
//

#include "doomtype.h"
#include "net_defs.h"

// ---------------------------------------------------------------------------
// NET_WaitForLaunch — placeholder for the textscreen lobby loop
// (net_gui.c). doomgeneric's d_loop.c calls this after connecting, to
// block until the server sends NET_PACKET_TYPE_LAUNCH. The DoomCard UI
// owns the lobby experience in patchtogether.live, so this returns
// immediately. The slice-2 TS netcode layer drives launch via the
// arbiter "New Game" dialog instead.
// ---------------------------------------------------------------------------

void NET_WaitForLaunch(void)
{
}
