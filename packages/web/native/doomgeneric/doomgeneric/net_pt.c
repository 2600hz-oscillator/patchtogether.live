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
//     patchtogether.live custom net_module_t transport ("net_pt").
//
//     This is the WASM<->JS bridge that replaces chocolate-doom's SDL_net
//     UDP transport (net_sdl.c) in the multiplayer build. Instead of real
//     sockets, the C side marshals net_packet_t bytes to/from JavaScript,
//     where the slice-2 TS netcode layer owns the actual transport
//     (WebRTC data channels with a WS-relay fallback). The C side never
//     does any real networking; it only:
//
//       - serializes outgoing net_packet_t into a flat byte buffer and
//         hands it to JS  (Module.PTNet.send), and
//       - drains a non-blocking recv queue that JS fills by calling the
//         exported dgpt_net_inject_packet().
//
//     Peers are identified by a small integer "peer id" (the JS netcode
//     maps these 1:1 to rack user ids; the C side never sees the string
//     id, only the int). A tiny fixed-size table maps peer id -> net_addr_t
//     so the netcode and ResolveAddress/AddrToString/FreeAddress can speak
//     in terms of stable net_addr_t pointers.
//
//     This file is ONLY compiled when FEATURE_MULTIPLAYER (DOOM_MP=1); the
//     default single-player build never sees it, keeping that binary
//     byte-for-byte identical (slice-0 invariant).
//
//
// =====================================================================
//  Module.PTNet JS interface contract (slice 2 must provide this object)
// =====================================================================
//
//  The C side calls OUT to a global `Module.PTNet` object via EM_JS. The
//  JS netcode layer (slice 2) installs this object BEFORE the netcode is
//  initialized — either by setting `Module.PTNet = {...}` directly after
//  the WASM module instantiates, or by calling the exported
//  `dgpt_net_register()` once it is set (which simply asserts presence and
//  is a convenient post-load hook). All functions are synchronous from the
//  C caller's perspective; the JS side must not block.
//
//    Module.PTNet.send(peerId: number, ptr: number, len: number): void
//        Send `len` bytes starting at WASM-heap byte offset `ptr` to the
//        peer identified by `peerId`. The JS side must COPY the bytes out
//        of the heap synchronously (the C buffer is reused after the call
//        returns) and queue/transmit them on its transport. A peerId of
//        PT_BROADCAST_PEER (0xFFFF / 65535) means "broadcast to all peers
//        currently connected to this instance".
//
//    Module.PTNet.poll(): void   [OPTIONAL]
//        Called once at the top of every NET_PT_RecvPacket. Gives the JS
//        transport a chance to pump its event loop and deliver any pending
//        inbound packets via dgpt_net_inject_packet() before the C side
//        drains the recv queue. May be omitted (no-op) when the transport
//        delivers packets eagerly (e.g. the in-process loopback test, or a
//        WebRTC onmessage handler that injects immediately).
//
//    Module.PTNet.resolve(peerId: number): void   [OPTIONAL]
//        Called from NET_PT_ResolveAddress when a NEW peer id is first
//        seen, so the JS side can lazily open a channel to that peer. May
//        be omitted.
//
//    Module.PTNet.free(peerId: number): void   [OPTIONAL]
//        Called from NET_PT_FreeAddress when the C side drops the last
//        reference to a peer's address. May be omitted.
//
//  Inbound (JS -> C) uses the exported C function (NOT a Module.PTNet
//  method), because JS owns the heap pointer lifecycle:
//
//    _dgpt_net_inject_packet(ptr: number, len: number, srcPeerId: number)
//        Copy `len` bytes from heap offset `ptr` into a freshly allocated
//        C-side net_packet_t and enqueue it as having arrived from
//        `srcPeerId`. Non-blocking; NET_PT_RecvPacket drains the queue.
//        Returns 1 on success, 0 if the queue was full (packet dropped).
//
//    _dgpt_net_register()
//        Optional post-load hook. Returns 1 if Module.PTNet is present and
//        looks usable, 0 otherwise. The netcode does not strictly need to
//        call this (send/poll resolve Module.PTNet lazily each call), but
//        it's a cheap sanity check for slice-2's init path.
//
//    _dgpt_net_peer_id_for_addr(addr: number) / _dgpt_net_reset()
//        Test/debug helpers (see below).
//

#include <stdint.h>
#include <string.h>

#include "doomtype.h"
#include "doomdef.h"
#include "d_mode.h"
#include "i_system.h"
#include "net_defs.h"
#include "net_client.h"
#include "net_server.h"
#include "net_io.h"
#include "net_packet.h"
#include "m_misc.h"
#include "z_zone.h"

#include <stdlib.h>  // atoi

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#else
// Allow native (non-emscripten) compilation for host-side static analysis /
// future native test harnesses. The EM_JS hooks become no-ops; the C-side
// inject queue still works, which is enough for a pure-C round-trip test.
#define EM_JS(ret, name, params, body) ret name params { }
#define EMSCRIPTEN_KEEPALIVE
#endif

// Broadcast sentinel peer id. net_io.c's NET_SendBroadcast sends to
// &net_broadcast_addr, whose handle we tag with this value so JS can
// fan the packet out to every connected peer.
#define PT_BROADCAST_PEER 0xFFFF

// Max distinct remote peers we track addresses for. A rack caps at 4
// players; 16 gives generous headroom (matches MAXNETNODES) plus the
// broadcast slot.
#define PT_MAX_PEERS 16

// Depth of the inbound packet ring buffer. Each entry holds one fully
// received packet from JS. BACKUPTICS-ish headroom so a burst of inbound
// tic packets doesn't drop under load before NET_PT_RecvPacket drains.
#define PT_RECV_QUEUE_SIZE 64

// ---------------------------------------------------------------------------
// EM_JS hooks — typed C signatures that call into Module.PTNet.
//
// We resolve Module.PTNet lazily on each call so the netcode can install /
// swap it any time before the first send. Missing optional methods are
// tolerated (guarded with typeof checks).
// ---------------------------------------------------------------------------

EM_JS(void, pt_js_send, (int peer_id, const uint8_t *ptr, int len), {
    var net = Module["PTNet"];
    if (!net || typeof net.send !== "function") {
        return;
    }
    net.send(peer_id, ptr, len);
});

EM_JS(void, pt_js_poll, (void), {
    var net = Module["PTNet"];
    if (net && typeof net.poll === "function") {
        net.poll();
    }
});

EM_JS(void, pt_js_resolve, (int peer_id), {
    var net = Module["PTNet"];
    if (net && typeof net.resolve === "function") {
        net.resolve(peer_id);
    }
});

EM_JS(void, pt_js_free, (int peer_id), {
    var net = Module["PTNet"];
    if (net && typeof net.free === "function") {
        net.free(peer_id);
    }
});

EM_JS(int, pt_js_have_module, (void), {
    var net = Module["PTNet"];
    return (net && typeof net.send === "function") ? 1 : 0;
});

// ---------------------------------------------------------------------------
// Peer address table.
//
// net_addr_t.handle stores the peer id (cast through intptr_t). Entries are
// allocated lazily by ResolveAddress and reused for the same peer id so a
// given peer always maps to ONE stable net_addr_t* (the netcode compares
// addresses by pointer identity in places).
// ---------------------------------------------------------------------------

typedef struct
{
    boolean in_use;
    int peer_id;
    net_addr_t addr;
} pt_peer_entry_t;

static pt_peer_entry_t pt_peers[PT_MAX_PEERS];

// net_io.c owns net_broadcast_addr; we point its module at us and tag its
// handle with the broadcast sentinel so SendPacket recognises it.
extern net_addr_t net_broadcast_addr;

// ---------------------------------------------------------------------------
// Inbound recv queue. dgpt_net_inject_packet (called from JS) pushes;
// NET_PT_RecvPacket pops.
// ---------------------------------------------------------------------------

typedef struct
{
    net_packet_t *packet;
    int src_peer_id;
} pt_recv_entry_t;

static pt_recv_entry_t pt_recv_queue[PT_RECV_QUEUE_SIZE];
static int pt_recv_head = 0;   // oldest (read here)
static int pt_recv_tail = 0;   // next free (write here)

// ---------------------------------------------------------------------------
// Test/debug instrumentation. We OR each observed net_packet_type_t into a
// bitmask as packets cross the C<->JS boundary, so a test can assert that a
// SYN went out and an ACK came back (and vice-versa) without reaching into
// the static server/client connection state. Cheap and inert in production.
// ---------------------------------------------------------------------------

static unsigned int pt_sent_type_mask = 0;  // packet types we handed to JS
static unsigned int pt_recv_type_mask = 0;  // packet types JS injected into us
static unsigned int pt_sent_count = 0;
static unsigned int pt_recv_count = 0;

// Pull the net_packet_type_t out of a raw packet's leading 16-bit big-endian
// header (NET_WriteInt16 is MSB-first; bit 15 is the reliable flag).
static unsigned int PtPacketType(const uint8_t *bytes, int len)
{
    unsigned int hdr;

    if (bytes == NULL || len < 2)
    {
        return 0xFFFFFFFFu;  // "no type" sentinel
    }
    hdr = ((unsigned int) bytes[0] << 8) | (unsigned int) bytes[1];
    return hdr & ~((unsigned int) NET_RELIABLE_PACKET);
}

static void PtNoteType(unsigned int *mask, const uint8_t *bytes, int len)
{
    unsigned int type = PtPacketType(bytes, len);
    if (type < 32)  // packet types are a small enum; guard the shift
    {
        *mask |= (1u << type);
    }
}

// Forward declares for the module struct.
static boolean NET_PT_InitClient(void);
static boolean NET_PT_InitServer(void);
static void NET_PT_SendPacket(net_addr_t *addr, net_packet_t *packet);
static boolean NET_PT_RecvPacket(net_addr_t **addr, net_packet_t **packet);
static void NET_PT_AddrToString(net_addr_t *addr, char *buffer, int buffer_len);
static void NET_PT_FreeAddress(net_addr_t *addr);
static net_addr_t *NET_PT_ResolveAddress(char *address);

net_module_t net_pt_module =
{
    NET_PT_InitClient,
    NET_PT_InitServer,
    NET_PT_SendPacket,
    NET_PT_RecvPacket,
    NET_PT_AddrToString,
    NET_PT_FreeAddress,
    NET_PT_ResolveAddress,
};

// ---------------------------------------------------------------------------
// Peer table helpers
// ---------------------------------------------------------------------------

static net_addr_t *PeerAddrForId(int peer_id, boolean create)
{
    int i;
    int free_slot = -1;

    for (i = 0; i < PT_MAX_PEERS; ++i)
    {
        if (pt_peers[i].in_use && pt_peers[i].peer_id == peer_id)
        {
            return &pt_peers[i].addr;
        }
        if (!pt_peers[i].in_use && free_slot < 0)
        {
            free_slot = i;
        }
    }

    if (!create || free_slot < 0)
    {
        return NULL;
    }

    pt_peers[free_slot].in_use = true;
    pt_peers[free_slot].peer_id = peer_id;
    pt_peers[free_slot].addr.module = &net_pt_module;
    pt_peers[free_slot].addr.handle = (void *) (intptr_t) peer_id;

    // Let JS lazily open a channel to this newly-seen peer.
    pt_js_resolve(peer_id);

    return &pt_peers[free_slot].addr;
}

static int PeerIdForAddr(net_addr_t *addr)
{
    if (addr == NULL)
    {
        return -1;
    }
    if (addr == &net_broadcast_addr)
    {
        return PT_BROADCAST_PEER;
    }
    return (int) (intptr_t) addr->handle;
}

// ---------------------------------------------------------------------------
// net_module_t implementation
// ---------------------------------------------------------------------------

static boolean NET_PT_InitClient(void)
{
    // The JS transport (Module.PTNet) is set up out-of-band by the slice-2
    // netcode layer before NET init runs. There is nothing socket-like to
    // open here, so we simply report success.
    return true;
}

static boolean NET_PT_InitServer(void)
{
    return true;
}

static void NET_PT_SendPacket(net_addr_t *addr, net_packet_t *packet)
{
    int peer_id;

    peer_id = PeerIdForAddr(addr);

    if (peer_id < 0)
    {
        return;
    }

    // packet->data / packet->len are already a flat, ready-to-ship byte
    // buffer (the netcode wrote the protocol bytes into it). We hand the
    // heap pointer + length straight to JS, which copies the bytes out
    // synchronously. No extra framing is needed: the peer id is the
    // routing key and the byte payload is the whole packet.
    PtNoteType(&pt_sent_type_mask, packet->data, (int) packet->len);
    ++pt_sent_count;
    pt_js_send(peer_id, packet->data, (int) packet->len);
}

static boolean NET_PT_RecvPacket(net_addr_t **addr, net_packet_t **packet)
{
    pt_recv_entry_t entry;
    net_addr_t *peer_addr;

    // Give JS a chance to deliver inbound packets before we drain.
    pt_js_poll();

    if (pt_recv_head == pt_recv_tail)
    {
        // queue empty
        return false;
    }

    entry = pt_recv_queue[pt_recv_head];
    pt_recv_head = (pt_recv_head + 1) % PT_RECV_QUEUE_SIZE;

    peer_addr = PeerAddrForId(entry.src_peer_id, true);

    if (peer_addr == NULL)
    {
        // Peer table full — drop the packet rather than leak it.
        NET_FreePacket(entry.packet);
        return false;
    }

    *addr = peer_addr;
    *packet = entry.packet;

    return true;
}

static void NET_PT_AddrToString(net_addr_t *addr, char *buffer, int buffer_len)
{
    int peer_id = PeerIdForAddr(addr);

    if (peer_id == PT_BROADCAST_PEER)
    {
        M_snprintf(buffer, buffer_len, "all-peers");
    }
    else
    {
        M_snprintf(buffer, buffer_len, "peer:%d", peer_id);
    }
}

static void NET_PT_FreeAddress(net_addr_t *addr)
{
    int i;
    int peer_id = PeerIdForAddr(addr);

    if (peer_id < 0 || peer_id == PT_BROADCAST_PEER)
    {
        return;
    }

    for (i = 0; i < PT_MAX_PEERS; ++i)
    {
        if (pt_peers[i].in_use && pt_peers[i].peer_id == peer_id)
        {
            pt_peers[i].in_use = false;
            pt_js_free(peer_id);
            return;
        }
    }
}

static net_addr_t *NET_PT_ResolveAddress(char *address)
{
    // Addresses are peer ids encoded as a decimal string (the netcode and
    // the JS transport agree on this). A NULL address has no meaning for
    // net_pt (there is no "default server" the way net_loop has) so we
    // return NULL, which lets net_query.c / d_loop.c fall through cleanly.
    int peer_id;

    if (address == NULL)
    {
        return NULL;
    }

    peer_id = atoi(address);

    return PeerAddrForId(peer_id, true);
}

// ---------------------------------------------------------------------------
// C<->JS bridge exports (called from JS; underscore-exported via the
// build script's EXPORTED_FUNCTIONS list).
// ---------------------------------------------------------------------------

// Deliver an inbound packet from JS into the C-side recv queue without
// blocking. `bytes` points at `len` bytes in the WASM heap; we copy them
// into a fresh net_packet_t. Returns 1 on success, 0 if the queue was full.
EMSCRIPTEN_KEEPALIVE
int dgpt_net_inject_packet(const uint8_t *bytes, int len, int src_peer_id)
{
    int new_tail;
    net_packet_t *packet;

    if (len < 0)
    {
        return 0;
    }

    new_tail = (pt_recv_tail + 1) % PT_RECV_QUEUE_SIZE;
    if (new_tail == pt_recv_head)
    {
        // Queue full — drop (caller may retry / the netcode will resend).
        return 0;
    }

    packet = NET_NewPacket(len);
    if (len > 0 && bytes != NULL)
    {
        memcpy(packet->data, bytes, len);
    }
    packet->len = (size_t) len;
    packet->pos = 0;

    PtNoteType(&pt_recv_type_mask, bytes, len);
    ++pt_recv_count;

    pt_recv_queue[pt_recv_tail].packet = packet;
    pt_recv_queue[pt_recv_tail].src_peer_id = src_peer_id;
    pt_recv_tail = new_tail;

    return 1;
}

// Optional post-load hook: confirm Module.PTNet is installed and usable.
// Also points net_broadcast_addr at this module so NET_SendBroadcast routes
// through net_pt. Returns 1 if Module.PTNet looks usable, else 0.
EMSCRIPTEN_KEEPALIVE
int dgpt_net_register(void)
{
    net_broadcast_addr.module = &net_pt_module;
    net_broadcast_addr.handle = (void *) (intptr_t) PT_BROADCAST_PEER;
    return pt_js_have_module();
}

// Test/debug: peer id stored in a given net_addr_t (or -1).
EMSCRIPTEN_KEEPALIVE
int dgpt_net_peer_id_for_addr(net_addr_t *addr)
{
    return PeerIdForAddr(addr);
}

// Test/debug: clear all transport state (recv queue + peer table) so a
// single WASM instance can be reused across test cases.
EMSCRIPTEN_KEEPALIVE
void dgpt_net_reset(void)
{
    int i;

    while (pt_recv_head != pt_recv_tail)
    {
        NET_FreePacket(pt_recv_queue[pt_recv_head].packet);
        pt_recv_head = (pt_recv_head + 1) % PT_RECV_QUEUE_SIZE;
    }
    pt_recv_head = 0;
    pt_recv_tail = 0;

    for (i = 0; i < PT_MAX_PEERS; ++i)
    {
        pt_peers[i].in_use = false;
    }

    pt_sent_type_mask = 0;
    pt_recv_type_mask = 0;
    pt_sent_count = 0;
    pt_recv_count = 0;
}

// ---------------------------------------------------------------------------
// Test/debug accessors + thin drivers. These let a Node harness exercise the
// real netcode (NET_SV_Init / NET_CL_Connect) and the SYN/ACK handshake
// without building net_module_t / net_connect_data_t structs from JS, and
// inspect what crossed the transport. They are force-exported only in the
// DOOM_MP build and are harmless in production (never called).
// ---------------------------------------------------------------------------

// Bitmask of net_packet_type_t values we have HANDED TO JS (outgoing).
EMSCRIPTEN_KEEPALIVE
unsigned int dgpt_net_sent_type_mask(void)
{
    return pt_sent_type_mask;
}

// Bitmask of net_packet_type_t values JS has INJECTED into us (incoming).
EMSCRIPTEN_KEEPALIVE
unsigned int dgpt_net_recv_type_mask(void)
{
    return pt_recv_type_mask;
}

EMSCRIPTEN_KEEPALIVE
unsigned int dgpt_net_sent_count(void)
{
    return pt_sent_count;
}

EMSCRIPTEN_KEEPALIVE
unsigned int dgpt_net_recv_count(void)
{
    return pt_recv_count;
}

// Drain ONE packet through the real net_module_t RecvPacket path and copy
// its bytes into out_ptr (up to max_len). Returns the byte length (>= 0), or
// -1 if the queue was empty. Writes the source peer id into *out_peer_id (if
// non-NULL). Used by the acceptance harness to assert byte-for-byte
// round-trip fidelity of the marshalling boundary via the genuine
// NET_PT_RecvPacket code path (not a separate test-only reader).
EMSCRIPTEN_KEEPALIVE
int dgpt_net_test_drain_one(uint8_t *out_ptr, int max_len, int *out_peer_id)
{
    net_addr_t *addr = NULL;
    net_packet_t *packet = NULL;
    int full_len;
    int n;

    if (!NET_PT_RecvPacket(&addr, &packet))
    {
        return -1;
    }

    full_len = (int) packet->len;
    n = full_len;
    if (n > max_len)
    {
        n = max_len;
    }
    if (out_ptr != NULL && n > 0)
    {
        memcpy(out_ptr, packet->data, (size_t) n);
    }
    if (out_peer_id != NULL)
    {
        *out_peer_id = PeerIdForAddr(addr);
    }

    NET_FreePacket(packet);

    return full_len;
}

// Minimal init for the netcode acceptance harness: bring up the zone
// allocator (Z_Malloc backs NET_NewPacket and the server/client contexts)
// WITHOUT loading a WAD or starting the renderer. The full game uses
// dgpt_init -> doomgeneric_Create -> Z_Init; the transport / handshake do
// not need any of the WAD-dependent state, so this lets a Node test drive
// NET_SV_Init / NET_CL_Connect without shipping DOOM1.WAD.
EMSCRIPTEN_KEEPALIVE
void dgpt_net_test_init(void)
{
    Z_Init();
}

// Register net_pt_module as a transport on the server context. Wraps
// NET_SV_AddModule(&net_pt_module) so JS does not need the module address.
EMSCRIPTEN_KEEPALIVE
void dgpt_net_sv_add_pt_module(void)
{
    NET_SV_AddModule(&net_pt_module);
}

// Connect this instance's client to the peer identified by `peer_id`, over
// net_pt. Builds a minimal valid net_connect_data_t (shareware DOOM, which
// matches DOOM1.WAD) and calls the real blocking NET_CL_Connect. Returns 1
// on a completed SYN/ACK handshake, 0 otherwise.
EMSCRIPTEN_KEEPALIVE
int dgpt_net_cl_connect(int peer_id, int as_drone)
{
    net_connect_data_t data;
    net_addr_t *addr;

    addr = PeerAddrForId(peer_id, true);
    if (addr == NULL)
    {
        return 0;
    }

    memset(&data, 0, sizeof(data));
    data.gamemode = shareware;
    data.gamemission = doom;
    data.lowres_turn = 0;
    data.drone = as_drone ? 1 : 0;
    data.max_players = NET_MAXPLAYERS;
    data.is_freedoom = 0;
    data.player_class = 0;
    // wad/deh sha1sums left zeroed: the first/only client's mode is adopted
    // by the server (num_players == 0 path), so no checksum match is needed.

    return NET_CL_Connect(addr, &data) ? 1 : 0;
}
