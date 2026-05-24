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
//     d_loop.c reference two symbols that live in upstream source
//     files we deliberately do NOT vendor, because they pull in
//     SDL2 / SDL_net (net_sdl.c) and the textscreen/curses GUI
//     library (net_gui.c) — neither of which exists in the WASM
//     build:
//
//       - net_sdl_module   (net_sdl.c)  — the UDP transport. Only
//         referenced by net_query.c's master-server browser, which
//         patchtogether.live does not use (peer discovery is done via
//         Yjs awareness, not the DOOM master server). The slice-1
//         net_pt.c transport will register its own net_module_t.
//
//       - NET_WaitForLaunch (net_gui.c) — the textscreen "waiting for
//         players" lobby loop. patchtogether.live replaces this with
//         the DoomCard UI, so this is a no-op here.
//
//     This file is compiled into BOTH build variants but is inert in
//     the default single-player build: nothing references these
//     symbols unless FEATURE_MULTIPLAYER is defined (DOOM_MP=1). It is
//     our own code (not vendored), hence the patchtogether copyright;
//     it remains GPLv2 to match the engine it links against.
//

#include "doomtype.h"
#include "net_defs.h"

// ---------------------------------------------------------------------------
// net_sdl_module — placeholder for the SDL_net UDP transport (net_sdl.c).
//
// Provides the symbol so net_query.c links, but every entry point is a
// safe no-op: InitClient/InitServer report failure, RecvPacket reports
// "no packet", and the address helpers do nothing. The real transport
// for multiplayer is net_pt.c (slice 1), registered directly by the
// JS/WASM bridge rather than through this module.
// ---------------------------------------------------------------------------

static boolean NET_PT_Stub_InitClient(void)
{
    return false;
}

static boolean NET_PT_Stub_InitServer(void)
{
    return false;
}

static void NET_PT_Stub_SendPacket(net_addr_t *addr, net_packet_t *packet)
{
    (void) addr;
    (void) packet;
}

static boolean NET_PT_Stub_RecvPacket(net_addr_t **addr, net_packet_t **packet)
{
    (void) addr;
    (void) packet;
    return false;
}

static void NET_PT_Stub_AddrToString(net_addr_t *addr, char *buffer,
                                     int buffer_len)
{
    (void) addr;
    if (buffer != NULL && buffer_len > 0)
    {
        buffer[0] = '\0';
    }
}

static void NET_PT_Stub_FreeAddress(net_addr_t *addr)
{
    (void) addr;
}

static net_addr_t *NET_PT_Stub_ResolveAddress(char *address)
{
    (void) address;
    return NULL;
}

net_module_t net_sdl_module =
{
    NET_PT_Stub_InitClient,
    NET_PT_Stub_InitServer,
    NET_PT_Stub_SendPacket,
    NET_PT_Stub_RecvPacket,
    NET_PT_Stub_AddrToString,
    NET_PT_Stub_FreeAddress,
    NET_PT_Stub_ResolveAddress,
};

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
