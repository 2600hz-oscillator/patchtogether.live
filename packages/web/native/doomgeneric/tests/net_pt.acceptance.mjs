// net_pt.acceptance.mjs — slice-1 acceptance harness for the net_pt.c
// WASM<->JS transport.
//
// Copyright(C) 2026 patchtogether.live contributors. GPLv2 (lives in the
// GPLv2 doomgeneric tree).
//
// WHAT THIS PROVES (the slice-1 bar from the plan):
//
//   1. Packet marshalling round-trip: bytes handed to Module.PTNet.send on
//      one WASM instance arrive byte-identical via dgpt_net_inject_packet ->
//      NET_PT_RecvPacket on another instance, tagged with the right peer id.
//
//   2. Real handshake: two DOOM_MP=1 WASM instances cross-wired with an
//      in-process loopback transport run NET_SV_Init() (instance A = server /
//      arbiter) and NET_CL_Connect() (instance B = client) and complete the
//      chocolate-doom connection handshake — instance A SENDS a SYN-ACK and
//      instance B RECEIVES it, with the C-side packet-type instrumentation
//      confirming NET_PACKET_TYPE_SYN went out from B and NET_PACKET_TYPE_ACK
//      came back. (NET_CL_Connect returning true == CONNECTED state reached.)
//
// WHY A STANDALONE NODE SCRIPT (not vitest): the vitest unit suite
// (`npm test`) only globs src/**/*.test.ts and runs in a WASM-free `node`
// env with no emcc/WASM build step — building + loading the ~424 KB MP WASM
// there would blow the unit-suite budget. This harness builds the
// Node-loadable MP artifact on demand (emcc is in the flox manifest) and is
// run explicitly:
//
//   flox activate -- node packages/web/native/doomgeneric/tests/net_pt.acceptance.mjs
//
// It exits non-zero on failure so it can be wired into a task/CI step later
// (slice 2+), but is intentionally NOT part of the default `npm test` run.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = resolve(__dirname, '..', '..', '..');           // packages/web
const BUILD_SCRIPT = resolve(WEB_DIR, 'native', 'build-doom-wasm.sh');
const ARTIFACT_JS = resolve(WEB_DIR, 'static', 'doom', 'doom-mp-node.js');

// net_packet_type_t enum (must match net_defs.h ordering).
const NET_PACKET_TYPE_SYN = 0;
const NET_PACKET_TYPE_ACK = 1;

// Broadcast sentinel from net_pt.c.
const PT_BROADCAST_PEER = 0xffff;

let failures = 0;
function check(cond, msg) {
  if (cond) {
    console.log(`  ok   - ${msg}`);
  } else {
    console.error(`  FAIL - ${msg}`);
    failures += 1;
  }
}

// --- build the Node-loadable MP WASM if it's not already present ----------

function ensureArtifact() {
  if (existsSync(ARTIFACT_JS)) {
    console.log(`[net_pt] using existing artifact ${ARTIFACT_JS}`);
    return;
  }
  console.log('[net_pt] building DOOM_MP=1 Node artifact (doom-mp-node.*)...');
  const res = spawnSync('bash', [BUILD_SCRIPT], {
    cwd: WEB_DIR,
    stdio: 'inherit',
    env: {
      ...process.env,
      DOOM_MP: '1',
      DOOM_OUT: 'doom-mp-node',
      DOOM_ENVIRONMENT: 'node',
    },
  });
  if (res.status !== 0) {
    console.error('[net_pt] build failed (is emcc on PATH? run via `flox activate --`)');
    process.exit(1);
  }
}

// --- a thin JS wrapper around one WASM instance + its net_pt transport ----

class PtInstance {
  constructor(Module, selfPeerId) {
    this.M = Module;
    this.selfPeerId = selfPeerId;
    this.peers = new Map(); // peerId -> PtInstance (where its packets go)
    // Bring up the zone allocator (Z_Init) without loading a WAD; the
    // transport + handshake need Z_Malloc but no game state.
    Module.ccall('dgpt_net_test_init', null, [], []);
    // The Module.PTNet contract slice 2 must implement. Here it's an
    // in-process loopback: send() copies bytes out of this instance's heap
    // and injects them into the destination instance, then pumps the
    // destination's server so a blocking NET_CL_Connect on THIS instance
    // sees the response within its own spin loop.
    Module.PTNet = {
      send: (peerId, ptr, len) => this._send(peerId, ptr, len),
      poll: () => {},
      resolve: () => {},
      free: () => {},
    };
    Module.ccall('dgpt_net_register', 'number', [], []);
  }

  link(peerId, instance) {
    this.peers.set(peerId, instance);
  }

  _send(peerId, ptr, len) {
    // Copy bytes out of the sender's heap synchronously (contract: the C
    // buffer is reused after send returns).
    const bytes = this.M.HEAPU8.slice(ptr, ptr + len);
    const targets =
      peerId === PT_BROADCAST_PEER
        ? [...this.peers.entries()]
        : this.peers.has(peerId)
          ? [[peerId, this.peers.get(peerId)]]
          : [];
    for (const [, target] of targets) {
      target.inject(bytes, this.selfPeerId);
      // Let the receiving instance process inbound packets immediately, so a
      // blocking NET_CL_Connect on the sender sees the reply this same tick.
      target.runServer();
      target.runClient();
    }
  }

  inject(bytes, srcPeerId) {
    const ptr = this.M._malloc(bytes.length || 1);
    this.M.HEAPU8.set(bytes, ptr);
    const ok = this.M.ccall(
      'dgpt_net_inject_packet',
      'number',
      ['number', 'number', 'number'],
      [ptr, bytes.length, srcPeerId],
    );
    this.M._free(ptr);
    return ok === 1;
  }

  runServer() {
    this.M.ccall('NET_SV_Run', null, [], []);
  }
  runClient() {
    this.M.ccall('NET_CL_Run', null, [], []);
  }
  svInit() {
    this.M.ccall('NET_SV_Init', null, [], []);
    this.M.ccall('dgpt_net_sv_add_pt_module', null, [], []);
  }
  clConnect(peerId, drone = 0) {
    return this.M.ccall(
      'dgpt_net_cl_connect',
      'number',
      ['number', 'number'],
      [peerId, drone],
    );
  }
  sentMask() {
    return this.M.ccall('dgpt_net_sent_type_mask', 'number', [], []) >>> 0;
  }
  recvMask() {
    return this.M.ccall('dgpt_net_recv_type_mask', 'number', [], []) >>> 0;
  }
  reset() {
    this.M.ccall('dgpt_net_reset', null, [], []);
  }

  // Drain one packet through the real NET_PT_RecvPacket path; returns
  // { bytes, peerId } or null if the queue is empty.
  drainOne(maxLen = 512) {
    const outPtr = this.M._malloc(maxLen);
    const peerPtr = this.M._malloc(4);
    const n = this.M.ccall(
      'dgpt_net_test_drain_one',
      'number',
      ['number', 'number', 'number'],
      [outPtr, maxLen, peerPtr],
    );
    let result = null;
    if (n >= 0) {
      const bytes = this.M.HEAPU8.slice(outPtr, outPtr + n);
      const peerId = this.M.HEAPU32[peerPtr >> 2] | 0; // int written by C
      result = { bytes, peerId };
    }
    this.M._free(outPtr);
    this.M._free(peerPtr);
    return result;
  }
}

async function loadInstance() {
  const mod = await import(ARTIFACT_JS + '?t=' + Math.random());
  const loadDoom = mod.default;
  return loadDoom();
}

// --- test 1: raw marshalling round-trip -----------------------------------

async function testMarshallingRoundTrip() {
  console.log('[test] packet marshalling round-trips bytes correctly');
  const B = new PtInstance(await loadInstance(), 2);
  B.reset();

  // JS -> C inject -> NET_PT_RecvPacket: a known byte pattern (including
  // 0x00 and 0xFF edge bytes) must arrive byte-for-byte intact through the
  // genuine recv code path, attributed to the right source peer id.
  const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x42, 0xff, 0x01]);
  const ok = B.inject(payload, /*srcPeerId*/ 7);
  check(ok, 'dgpt_net_inject_packet accepts a known payload');

  const drained = B.drainOne();
  check(drained !== null, 'NET_PT_RecvPacket surfaces the injected packet');
  if (drained) {
    const same =
      drained.bytes.length === payload.length &&
      drained.bytes.every((b, i) => b === payload[i]);
    check(same, 'recovered bytes are byte-for-byte identical to the payload');
    check(drained.peerId === 7, 'packet is attributed to src peer id 7');
  }

  // Queue drains fully: a second drain finds nothing.
  check(B.drainOne() === null, 'recv queue is empty after draining the one packet');

  // The C->JS send boundary (NET_PT_SendPacket -> Module.PTNet.send) is
  // exercised end-to-end by the real SYN/ACK in test 2.
}

// --- test 2: real SYN/ACK handshake across two instances ------------------

async function testHandshake() {
  console.log('[test] NET_SV_Init + NET_CL_Connect exchange SYN/ACK');

  const PEER_SERVER = 10; // id by which the client addresses the server
  const PEER_CLIENT = 20; // id by which the server addresses the client

  const server = new PtInstance(await loadInstance(), PEER_SERVER);
  const client = new PtInstance(await loadInstance(), PEER_CLIENT);
  server.reset();
  client.reset();

  // Cross-wire: client.send(PEER_SERVER) delivers to `server` (tagged as
  // coming from PEER_CLIENT); server.send(PEER_CLIENT) delivers to `client`
  // (tagged as coming from PEER_SERVER).
  client.link(PEER_SERVER, server);
  server.link(PEER_CLIENT, client);

  // Start the server (arbiter) and register net_pt as its transport.
  server.svInit();

  // Client connects to the server peer. NET_CL_Connect blocks in its own
  // spin loop; client._send pumps the server instance synchronously so the
  // SYN-ACK comes back within that loop.
  const connected = client.clConnect(PEER_SERVER, /*drone*/ 0);

  check(connected === 1, 'NET_CL_Connect returns true (CONNECTED reached)');

  const clientSent = client.sentMask();
  const clientRecv = client.recvMask();
  const serverSent = server.sentMask();
  const serverRecv = server.recvMask();

  check(
    (clientSent & (1 << NET_PACKET_TYPE_SYN)) !== 0,
    'client SENT a NET_PACKET_TYPE_SYN over net_pt',
  );
  check(
    (serverRecv & (1 << NET_PACKET_TYPE_SYN)) !== 0,
    'server RECEIVED the SYN (marshalled JS->C intact)',
  );
  check(
    (serverSent & (1 << NET_PACKET_TYPE_ACK)) !== 0,
    'server SENT a NET_PACKET_TYPE_ACK over net_pt',
  );
  check(
    (clientRecv & (1 << NET_PACKET_TYPE_ACK)) !== 0,
    'client RECEIVED the ACK (marshalled back C->JS->C intact)',
  );
}

async function main() {
  ensureArtifact();
  await testMarshallingRoundTrip();
  await testHandshake();

  console.log('');
  if (failures === 0) {
    console.log('net_pt acceptance: ALL CHECKS PASSED');
    process.exit(0);
  } else {
    console.error(`net_pt acceptance: ${failures} CHECK(S) FAILED`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('net_pt acceptance: harness error', e);
  process.exit(1);
});
