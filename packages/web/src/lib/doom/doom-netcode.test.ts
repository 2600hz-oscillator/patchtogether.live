// packages/web/src/lib/doom/doom-netcode.test.ts
//
// Slice-2 unit coverage for DoomNetcode. Everything runs against STUBBED
// transports — there is NO real WebRTC here (real-WebRTC e2e is slice 7).
// We mock:
//   - the Hocuspocus awareness object (a tiny in-memory multi-client store
//     that fans setLocalStateField updates to all attached netcodes), so we
//     can drive arbiter election + signaling + relay deterministically;
//   - RTCPeerConnection (a no-op stub whose data channel we open/close by
//     hand), so the WebRTC promotion + fallback paths are observable; and
//   - the WASM Module + runtime (records injectNetPacket calls + exposes a
//     HEAPU8 the send() path copies from).
//
// What's asserted:
//   - lex-min arbiter election + re-election when the arbiter leaves
//   - peer-id ↔ user-id mapping is stable + deterministic across peers
//   - send / inbound round-trips through a stubbed channel (bytes injected
//     to C via the mocked dgpt_net_inject_packet)
//   - WS-relay fallback triggers after the 3s WebRTC timeout (fake timers)
//   - broadcast (0xFFFF) fans out to all peers

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DoomNetcode,
  PT_BROADCAST_PEER,
  RTC_CONNECT_TIMEOUT_MS,
  relayFieldFor,
  serializeGameSettings,
  parseGameSettings,
  type NetcodeRuntime,
  type NetcodeModule,
  type DoomGameSettings,
  type GameStartEnvelope,
  type TiccmdEnvelope,
} from './doom-netcode';
import type { HocuspocusProvider } from '@hocuspocus/provider';

// ─────────────────────────────────────────────────────────────────────────
//  Fake awareness: a shared bus so multiple netcodes can "see" each other.
// ─────────────────────────────────────────────────────────────────────────

interface FakeAwarenessClient {
  clientID: number;
  state: Record<string, unknown>;
  listeners: Set<() => void>;
}

class FakeAwarenessBus {
  private nextId = 1;
  readonly clients = new Map<number, FakeAwarenessClient>();

  create(): FakeAwareness {
    const client: FakeAwarenessClient = {
      clientID: this.nextId++,
      state: {},
      listeners: new Set(),
    };
    this.clients.set(client.clientID, client);
    return new FakeAwareness(this, client);
  }

  /** Notify every client (all share the same global view). */
  broadcast(): void {
    for (const c of this.clients.values()) {
      for (const l of [...c.listeners]) l();
    }
  }

  remove(clientID: number): void {
    this.clients.delete(clientID);
    this.broadcast();
  }

  getStates(): Map<number, Record<string, unknown>> {
    const out = new Map<number, Record<string, unknown>>();
    for (const c of this.clients.values()) out.set(c.clientID, c.state);
    return out;
  }
}

class FakeAwareness {
  constructor(
    private readonly bus: FakeAwarenessBus,
    private readonly client: FakeAwarenessClient,
  ) {}
  get clientID(): number {
    return this.client.clientID;
  }
  getStates(): Map<number, Record<string, unknown>> {
    return this.bus.getStates();
  }
  getLocalState(): Record<string, unknown> {
    return this.client.state;
  }
  setLocalStateField(field: string, value: unknown): void {
    this.client.state = { ...this.client.state, [field]: value };
    this.bus.broadcast();
  }
  setLocalState(s: Record<string, unknown> | null): void {
    this.client.state = s ?? {};
    this.bus.broadcast();
  }
  on(_ev: 'update', cb: () => void): void {
    this.client.listeners.add(cb);
  }
  off(_ev: 'update', cb: () => void): void {
    this.client.listeners.delete(cb);
  }
}

function makeProvider(aw: FakeAwareness): HocuspocusProvider {
  return { awareness: aw } as unknown as HocuspocusProvider;
}

/** Set the `user.id` membership field the way multiplayer/presence.ts does. */
function joinAs(aw: FakeAwareness, userId: string): void {
  aw.setLocalStateField('user', { id: userId, displayName: userId, color: '#fff' });
}

// ─────────────────────────────────────────────────────────────────────────
//  Fake runtime + Module (records injection; exposes a HEAPU8 for send()).
// ─────────────────────────────────────────────────────────────────────────

interface InjectCall {
  bytes: Uint8Array;
  srcPeerId: number;
}

function makeRuntime(): {
  runtime: NetcodeRuntime;
  module: NetcodeModule;
  injected: InjectCall[];
} {
  const heap = new Uint8Array(1024);
  const injected: InjectCall[] = [];
  const module: NetcodeModule = {
    HEAPU8: heap,
    ccall: vi.fn(() => 1),
  };
  const runtime: NetcodeRuntime = {
    getModule: () => module,
    injectNetPacket: (bytes, srcPeerId) => {
      injected.push({ bytes: bytes.slice(), srcPeerId });
      return true;
    },
  };
  return { runtime, module, injected };
}

// ─────────────────────────────────────────────────────────────────────────
//  Fake RTCPeerConnection + RTCDataChannel.
//
//  Channels start in 'connecting' readyState; tests call channel._open() to
//  simulate negotiation completing. The pc records created channels so the
//  arbiter-side data channel is reachable.
// ─────────────────────────────────────────────────────────────────────────

class FakeDataChannel {
  readyState: RTCDataChannelState = 'connecting';
  binaryType = 'arraybuffer';
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: ArrayBuffer | Uint8Array | string }) => void) | null =
    null;
  sent: Uint8Array[] = [];
  send(data: Uint8Array | ArrayBuffer): void {
    this.sent.push(data instanceof Uint8Array ? data.slice() : new Uint8Array(data));
  }
  close(): void {
    this.readyState = 'closed';
    this.onclose?.();
  }
  _open(): void {
    this.readyState = 'open';
    this.onopen?.();
  }
  _recv(bytes: Uint8Array): void {
    this.onmessage?.({ data: bytes });
  }
}

class FakePeerConnection {
  connectionState: RTCPeerConnectionState = 'new';
  onicecandidate: ((ev: { candidate: RTCIceCandidate | null }) => void) | null =
    null;
  onconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((ev: { channel: FakeDataChannel }) => void) | null = null;
  channels: FakeDataChannel[] = [];
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  closed = false;

  static all: FakePeerConnection[] = [];
  constructor() {
    FakePeerConnection.all.push(this);
  }
  createDataChannel(): FakeDataChannel {
    const ch = new FakeDataChannel();
    this.channels.push(ch);
    return ch;
  }
  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: 'fake-offer-sdp' };
  }
  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: 'fake-answer-sdp' };
  }
  async setLocalDescription(d: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = d;
  }
  async setRemoteDescription(d: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = d;
  }
  async addIceCandidate(): Promise<void> {}
  close(): void {
    this.closed = true;
  }
  /** Drive connectionState → connected (and open the first channel). */
  _connect(): void {
    this.connectionState = 'connected';
    this.onconnectionstatechange?.();
    for (const ch of this.channels) ch._open();
  }
  _fail(): void {
    this.connectionState = 'failed';
    this.onconnectionstatechange?.();
  }
}

function installFakeRTC(): void {
  (globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection =
    FakePeerConnection as unknown;
}
function uninstallRTC(): void {
  delete (globalThis as unknown as { RTCPeerConnection?: unknown })
    .RTCPeerConnection;
}

// ─────────────────────────────────────────────────────────────────────────
//  Tests
// ─────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  FakePeerConnection.all = [];
});
afterEach(() => {
  uninstallRTC();
  vi.useRealTimers();
});

describe('DoomNetcode — arbiter election', () => {
  it('elects the lex-min member as arbiter', () => {
    const bus = new FakeAwarenessBus();
    const awA = bus.create();
    const awB = bus.create();
    joinAs(awA, 'user-b');
    joinAs(awB, 'user-a');

    const onArbiterA = vi.fn();
    const onArbiterB = vi.fn();
    const { runtime: rtA } = makeRuntime();
    const { runtime: rtB } = makeRuntime();

    const ncA = new DoomNetcode({
      provider: makeProvider(awA),
      moduleId: 'm',
      localUserId: 'user-b',
      runtime: rtA,
      onArbiter: onArbiterA,
    });
    const ncB = new DoomNetcode({
      provider: makeProvider(awB),
      moduleId: 'm',
      localUserId: 'user-a',
      runtime: rtB,
      onArbiter: onArbiterB,
    });
    ncA.start();
    ncB.start();

    // user-a is lex-min → B (localUserId user-a) is the arbiter.
    expect(ncB.isArbiter()).toBe(true);
    expect(ncA.isArbiter()).toBe(false);
    expect(onArbiterB).toHaveBeenLastCalledWith(true);
    expect(onArbiterA).toHaveBeenLastCalledWith(false);

    ncA.stop();
    ncB.stop();
  });

  it('re-elects a new arbiter when the current arbiter leaves', () => {
    const bus = new FakeAwarenessBus();
    const awA = bus.create();
    const awB = bus.create();
    const awC = bus.create();
    joinAs(awA, 'user-a');
    joinAs(awB, 'user-b');
    joinAs(awC, 'user-c');

    const onArbiterB = vi.fn();
    const { runtime: rtB } = makeRuntime();
    const ncB = new DoomNetcode({
      provider: makeProvider(awB),
      moduleId: 'm',
      localUserId: 'user-b',
      runtime: rtB,
      onArbiter: onArbiterB,
    });
    ncB.start();

    // user-a is arbiter; B is not.
    expect(ncB.isArbiter()).toBe(false);

    // user-a leaves the rack.
    bus.remove(awA.clientID);

    // Now user-b is lex-min → B becomes arbiter, and onArbiter fired with true.
    expect(ncB.isArbiter()).toBe(true);
    expect(onArbiterB).toHaveBeenLastCalledWith(true);

    ncB.stop();
  });

  // ── split-brain-proof owner authority ───────────────────────────────────
  // The net arbiter must equal the rack host: the RACK OWNER, derived from
  // reliable local ownership (user.isRackOwner), NOT a lex-min count. A guest
  // — even one whose id sorts lex-smallest — must NEVER elect itself arbiter.
  it('seats the OWNER as arbiter even when its id is NOT lex-smallest', () => {
    const bus = new FakeAwarenessBus();
    const awOwner = bus.create();
    const awGuest = bus.create();
    // owner id sorts lex-LARGE; guest id sorts lex-small.
    awOwner.setLocalStateField('user', { id: 'zzz-owner', displayName: 'O', color: '#fff', isRackOwner: true });
    awGuest.setLocalStateField('user', { id: 'aaa-guest', displayName: 'G', color: '#fff', isRackOwner: false });

    const { runtime: rtO } = makeRuntime();
    const { runtime: rtG } = makeRuntime();
    const ncOwner = new DoomNetcode({ provider: makeProvider(awOwner), moduleId: 'm', localUserId: 'zzz-owner', runtime: rtO });
    const ncGuest = new DoomNetcode({ provider: makeProvider(awGuest), moduleId: 'm', localUserId: 'aaa-guest', runtime: rtG });
    ncOwner.start();
    ncGuest.start();

    // EXACTLY one arbiter, and it's the owner — never the lex-min guest.
    expect(ncOwner.isArbiter()).toBe(true);
    expect(ncGuest.isArbiter()).toBe(false);

    ncOwner.stop();
    ncGuest.stop();
  });

  it('a confirmed guest never elects itself arbiter even with only ITSELF visible', () => {
    // Simulate the live split-brain: the guest is the ONLY state its awareness
    // has (the owner hasn't propagated yet). A lex-min count over [guest] would
    // pick the guest — the bug. With reliable local ownership it stays a guest.
    const bus = new FakeAwarenessBus();
    const awGuest = bus.create();
    awGuest.setLocalStateField('user', { id: 'lonely-guest', displayName: 'G', color: '#fff', isRackOwner: false });

    const { runtime } = makeRuntime();
    const ncGuest = new DoomNetcode({ provider: makeProvider(awGuest), moduleId: 'm', localUserId: 'lonely-guest', runtime });
    ncGuest.start();

    expect(ncGuest.isArbiter()).toBe(false);

    ncGuest.stop();
  });
});

describe('DoomNetcode — peer-id mapping', () => {
  it('is stable + deterministic (lex-sort index) across peers', () => {
    const bus = new FakeAwarenessBus();
    const awA = bus.create();
    const awB = bus.create();
    const awC = bus.create();
    joinAs(awA, 'charlie');
    joinAs(awB, 'alice');
    joinAs(awC, 'bob');

    const ncs = [
      { aw: awA, uid: 'charlie' },
      { aw: awB, uid: 'alice' },
      { aw: awC, uid: 'bob' },
    ].map(({ aw, uid }) => {
      const { runtime } = makeRuntime();
      const nc = new DoomNetcode({
        provider: makeProvider(aw),
        moduleId: 'm',
        localUserId: uid,
        runtime,
      });
      nc.start();
      return nc;
    });

    // lex-sort: alice=0, bob=1, charlie=2 — identical on every peer.
    for (const nc of ncs) {
      expect(nc.peerIdForUser('alice')).toBe(0);
      expect(nc.peerIdForUser('bob')).toBe(1);
      expect(nc.peerIdForUser('charlie')).toBe(2);
      expect(nc.userForPeerId(0)).toBe('alice');
      expect(nc.userForPeerId(2)).toBe('charlie');
    }

    for (const nc of ncs) nc.stop();
  });
});

describe('DoomNetcode — send / inbound round-trip over a stubbed channel', () => {
  it('sends bytes over the data channel + injects inbound bytes to C', () => {
    installFakeRTC();
    const bus = new FakeAwarenessBus();
    const awArb = bus.create(); // arbiter (alice)
    const awPeer = bus.create(); // peer (bob)
    joinAs(awArb, 'alice');
    joinAs(awPeer, 'bob');

    const { runtime: rtArb, module: modArb, injected: injArb } = makeRuntime();
    const ncArb = new DoomNetcode({
      provider: makeProvider(awArb),
      moduleId: 'm',
      localUserId: 'alice',
      runtime: rtArb,
    });
    ncArb.start();

    expect(ncArb.isArbiter()).toBe(true);
    // Arbiter dialled bob → one pc with one channel.
    const pc = FakePeerConnection.all[0]!;
    const ch = pc.channels[0]!;
    // Simulate negotiation completing.
    pc._connect();
    expect(ncArb.debugStats().transport).toBe('webrtc');

    // C side asks PTNet to send 4 bytes at heap offset 10 to bob (peerId 1).
    modArb.HEAPU8.set([0xde, 0xad, 0xbe, 0xef], 10);
    const bobPeerId = ncArb.peerIdForUser('bob')!;
    modArb.PTNet!.send(bobPeerId, 10, 4);
    expect(ch.sent).toHaveLength(1);
    expect([...ch.sent[0]!]).toEqual([0xde, 0xad, 0xbe, 0xef]);

    // Inbound: the channel receives bytes from bob → injected to C as
    // srcPeerId = bob.
    ch._recv(new Uint8Array([1, 2, 3]));
    expect(injArb).toHaveLength(1);
    expect([...injArb[0]!.bytes]).toEqual([1, 2, 3]);
    expect(injArb[0]!.srcPeerId).toBe(bobPeerId);

    ncArb.stop();
  });

  it('broadcast (0xFFFF) fans out to all connected peers', () => {
    installFakeRTC();
    const bus = new FakeAwarenessBus();
    const awArb = bus.create();
    const awB = bus.create();
    const awC = bus.create();
    joinAs(awArb, 'aaa'); // arbiter
    joinAs(awB, 'bbb');
    joinAs(awC, 'ccc');

    const { runtime, module } = makeRuntime();
    const nc = new DoomNetcode({
      provider: makeProvider(awArb),
      moduleId: 'm',
      localUserId: 'aaa',
      runtime,
    });
    nc.start();
    expect(nc.isArbiter()).toBe(true);

    // Two peers dialled → two pcs, each with a channel. Connect both.
    expect(FakePeerConnection.all).toHaveLength(2);
    const channels = FakePeerConnection.all.map((pc) => {
      pc._connect();
      return pc.channels[0]!;
    });

    module.HEAPU8.set([0x42], 0);
    module.PTNet!.send(PT_BROADCAST_PEER, 0, 1);

    for (const ch of channels) {
      expect(ch.sent).toHaveLength(1);
      expect([...ch.sent[0]!]).toEqual([0x42]);
    }

    nc.stop();
  });
});

describe('DoomNetcode — WS-relay fallback', () => {
  it('falls back to awareness relay after the 3s WebRTC timeout', () => {
    vi.useFakeTimers();
    installFakeRTC();
    const bus = new FakeAwarenessBus();
    const awArb = bus.create();
    const awPeer = bus.create();
    joinAs(awArb, 'alice'); // arbiter
    joinAs(awPeer, 'bob');

    const { runtime, module } = makeRuntime();
    const nc = new DoomNetcode({
      provider: makeProvider(awArb),
      moduleId: 'm',
      localUserId: 'alice',
      runtime,
    });
    nc.start();

    // Dialled bob, but never connect the pc.
    const pc = FakePeerConnection.all[0]!;
    expect(pc.connectionState).toBe('new');
    // Before connect, bob's transport is 'connecting' (filtered out of the
    // summary → defaults to 'webrtc'). The packet would still go over the
    // open channel if it existed, but here the channel is not open.

    // Advance past the fallback timeout → peer demotes to ws-relay.
    vi.advanceTimersByTime(RTC_CONNECT_TIMEOUT_MS + 1);
    expect(nc.debugStats().transport).toBe('ws-relay');

    // Now a send goes over the relay (awareness field), not the channel.
    const bobPeerId = nc.peerIdForUser('bob')!;
    module.HEAPU8.set([9, 9, 9], 0);
    module.PTNet!.send(bobPeerId, 0, 3);

    const relayField = relayFieldFor('m', bobPeerId);
    const arbState = awArb.getLocalState();
    expect(arbState[relayField]).toBeDefined();
    expect((arbState[relayField] as { bytesB64: string }).bytesB64).toBe(
      btoa(String.fromCharCode(9, 9, 9)),
    );

    nc.stop();
  });

  it('delivers relay packets inbound (awareness → dgpt_net_inject_packet)', () => {
    vi.useFakeTimers();
    installFakeRTC();
    const bus = new FakeAwarenessBus();
    const awArb = bus.create();
    const awPeer = bus.create();
    joinAs(awArb, 'alice'); // arbiter; peerId 0
    joinAs(awPeer, 'bob'); // peerId 1

    // Set up the arbiter's netcode (the receiver).
    const { runtime, injected } = makeRuntime();
    const nc = new DoomNetcode({
      provider: makeProvider(awArb),
      moduleId: 'm',
      localUserId: 'alice',
      runtime,
    });
    nc.start();

    const alicePeerId = nc.peerIdForUser('alice')!; // 0
    // Bob writes a relay packet addressed to alice's peerId on his own
    // awareness state.
    const field = relayFieldFor('m', alicePeerId);
    awPeer.setLocalStateField(field, {
      seq: 0,
      bytesB64: btoa(String.fromCharCode(7, 7)),
    });

    // The awareness 'update' fired drainInboundRelay → injected once.
    expect(injected).toHaveLength(1);
    expect([...injected[0]!.bytes]).toEqual([7, 7]);
    expect(injected[0]!.srcPeerId).toBe(nc.peerIdForUser('bob'));

    // Re-broadcast of the SAME seq must not double-inject (awareness is
    // sticky). Trigger another update with no new field change.
    awPeer.setLocalStateField('noise', Date.now());
    expect(injected).toHaveLength(1);

    // A NEW seq injects again.
    awPeer.setLocalStateField(field, {
      seq: 1,
      bytesB64: btoa(String.fromCharCode(8)),
    });
    expect(injected).toHaveLength(2);
    expect([...injected[1]!.bytes]).toEqual([8]);

    nc.stop();
  });
});

describe('DoomNetcode — PTNet install', () => {
  it('installs Module.PTNet on start and removes it on stop', () => {
    const bus = new FakeAwarenessBus();
    const aw = bus.create();
    joinAs(aw, 'solo');
    const { runtime, module } = makeRuntime();
    const nc = new DoomNetcode({
      provider: makeProvider(aw),
      moduleId: 'm',
      localUserId: 'solo',
      runtime,
    });
    expect(module.PTNet).toBeUndefined();
    nc.start();
    expect(module.PTNet).toBeDefined();
    expect(typeof module.PTNet!.send).toBe('function');
    expect(module.ccall).toHaveBeenCalledWith(
      'dgpt_net_register',
      'number',
      [],
      [],
    );
    nc.stop();
    expect(module.PTNet).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
//  Slice 4: net_gamesettings serialization round-trip + GAMESTART broadcast
// ─────────────────────────────────────────────────────────────────────────

describe('DoomNetcode — game settings serialization', () => {
  const sample: DoomGameSettings = {
    deathmatch: 1,
    episode: 1,
    map: 5,
    skill: 3,
    nomonsters: 0,
    fastMonsters: 1,
    respawnMonsters: 0,
    numPlayers: 3,
  };

  it('round-trips a settings struct losslessly', () => {
    const wire = serializeGameSettings(sample);
    const back = parseGameSettings(wire);
    expect(back).toEqual(sample);
  });

  it('produces a deterministic string for identical settings (field order pinned)', () => {
    // Two structs with the SAME values but different key insertion order must
    // serialize to byte-identical strings (so a re-stamp doesn't churn Yjs).
    const reordered: DoomGameSettings = {
      numPlayers: 3,
      respawnMonsters: 0,
      fastMonsters: 1,
      nomonsters: 0,
      skill: 3,
      map: 5,
      episode: 1,
      deathmatch: 1,
    };
    expect(serializeGameSettings(reordered)).toBe(serializeGameSettings(sample));
  });

  it('parses the object form too (not just the string leaf)', () => {
    expect(parseGameSettings(sample)).toEqual(sample);
  });

  it('rejects malformed / incomplete payloads (returns null)', () => {
    expect(parseGameSettings(null)).toBeNull();
    expect(parseGameSettings('not json')).toBeNull();
    expect(parseGameSettings({ deathmatch: 0 })).toBeNull(); // missing fields
    expect(parseGameSettings({ ...sample, map: 'x' })).toBeNull(); // wrong type
  });
});

describe('DoomNetcode — GAMESTART broadcast (Launch)', () => {
  const settings: DoomGameSettings = {
    deathmatch: 0,
    episode: 1,
    map: 1,
    skill: 0,
    nomonsters: 0,
    fastMonsters: 0,
    respawnMonsters: 0,
    numPlayers: 2,
  };

  function twoPeers() {
    const bus = new FakeAwarenessBus();
    const awA = bus.create();
    const awB = bus.create();
    joinAs(awA, 'aaa');
    joinAs(awB, 'bbb');
    const startsA: GameStartEnvelope[] = [];
    const startsB: GameStartEnvelope[] = [];
    const { runtime: rtA } = makeRuntime();
    const { runtime: rtB } = makeRuntime();
    const ncA = new DoomNetcode({
      provider: makeProvider(awA), moduleId: 'm', localUserId: 'aaa',
      runtime: rtA, onGameStart: (e) => startsA.push(e),
    });
    const ncB = new DoomNetcode({
      provider: makeProvider(awB), moduleId: 'm', localUserId: 'bbb',
      runtime: rtB, onGameStart: (e) => startsB.push(e),
    });
    ncA.start();
    ncB.start();
    return { ncA, ncB, startsA, startsB };
  }

  it('arbiter broadcast fires onGameStart on the arbiter AND the peer', () => {
    const { ncA, startsA, startsB } = twoPeers();
    expect(ncA.isArbiter()).toBe(true); // aaa is lex-min
    const launchId = ncA.broadcastGameStart(settings);
    expect(launchId).toBe(1);
    // Arbiter fired locally (synchronous, no round-trip).
    expect(startsA).toHaveLength(1);
    expect(startsA[0]!.settings).toEqual(settings);
    // Peer B received it via the awareness bus.
    expect(startsB).toHaveLength(1);
    expect(startsB[0]!.settings).toEqual(settings);
    expect(startsB[0]!.launchId).toBe(1);
  });

  it('a non-arbiter cannot broadcast (returns false, no start)', () => {
    const { ncB, startsA, startsB } = twoPeers();
    expect(ncB.isArbiter()).toBe(false);
    const r = ncB.broadcastGameStart(settings);
    expect(r).toBe(false);
    expect(startsA).toHaveLength(0);
    expect(startsB).toHaveLength(0);
  });

  it('dedupes a re-broadcast of the same launchId (sticky awareness)', () => {
    const { ncA, startsB } = twoPeers();
    ncA.broadcastGameStart(settings);
    expect(startsB).toHaveLength(1);
    // An unrelated awareness churn re-runs the drain; the sticky GAMESTART
    // field is still present but must NOT re-fire (same launchId).
    joinAs((ncA as unknown as { provider: { awareness: FakeAwareness } }).provider.awareness, 'aaa');
    expect(startsB).toHaveLength(1);
  });

  it('a NEW launch (next map) bumps launchId + fires again', () => {
    const { ncA, startsB } = twoPeers();
    ncA.broadcastGameStart({ ...settings, map: 1 });
    ncA.broadcastGameStart({ ...settings, map: 2 });
    expect(startsB).toHaveLength(2);
    expect(startsB[0]!.launchId).toBe(1);
    expect(startsB[1]!.launchId).toBe(2);
    expect(startsB[1]!.settings.map).toBe(2);
  });
});

describe('DoomNetcode — cross-peer ticcmd feed (slice 5)', () => {
  function twoPeers() {
    const bus = new FakeAwarenessBus();
    const awA = bus.create();
    const awB = bus.create();
    joinAs(awA, 'aaa'); // slot 0 (lex-min)
    joinAs(awB, 'bbb'); // slot 1
    const ticsAonB: TiccmdEnvelope[] = []; // ticcmds A produced, seen by B
    const ticsBonA: TiccmdEnvelope[] = []; // ticcmds B produced, seen by A
    const { runtime: rtA } = makeRuntime();
    const { runtime: rtB } = makeRuntime();
    const ncA = new DoomNetcode({
      provider: makeProvider(awA), moduleId: 'm', localUserId: 'aaa',
      runtime: rtA, onRemoteTiccmd: (e) => ticsBonA.push(e),
    });
    const ncB = new DoomNetcode({
      provider: makeProvider(awB), moduleId: 'm', localUserId: 'bbb',
      runtime: rtB, onRemoteTiccmd: (e) => ticsAonB.push(e),
    });
    ncA.start();
    ncB.start();
    return { ncA, ncB, ticsAonB, ticsBonA };
  }

  it("delivers peer A's ticcmd to peer B (cross-peer visibility)", () => {
    const { ncA, ticsAonB } = twoPeers();
    ncA.broadcastLocalTiccmd(0, { forwardmove: 50, sidemove: 0, angleturn: 0, buttons: 0 });
    expect(ticsAonB).toHaveLength(1);
    expect(ticsAonB[0]!.slot).toBe(0);
    expect(ticsAonB[0]!.forwardmove).toBe(50);
  });

  it('does not echo a peer its own ticcmd', () => {
    const { ncA, ticsBonA } = twoPeers();
    ncA.broadcastLocalTiccmd(0, { forwardmove: 25, sidemove: 0, angleturn: 0, buttons: 0 });
    // A broadcast its own ticcmd; A's onRemoteTiccmd must NOT fire for it.
    expect(ticsBonA).toHaveLength(0);
  });

  it('both directions flow independently', () => {
    const { ncA, ncB, ticsAonB, ticsBonA } = twoPeers();
    ncA.broadcastLocalTiccmd(0, { forwardmove: 10, sidemove: 0, angleturn: 0, buttons: 0 });
    ncB.broadcastLocalTiccmd(1, { forwardmove: 0, sidemove: 20, angleturn: 0, buttons: 1 });
    expect(ticsAonB).toHaveLength(1);
    expect(ticsAonB[0]!.forwardmove).toBe(10);
    expect(ticsBonA).toHaveLength(1);
    expect(ticsBonA[0]!.slot).toBe(1);
    expect(ticsBonA[0]!.sidemove).toBe(20);
    expect(ticsBonA[0]!.buttons).toBe(1);
  });

  it('dedupes a sticky re-broadcast on unrelated awareness churn (seq)', () => {
    const { ncA, ticsAonB } = twoPeers();
    ncA.broadcastLocalTiccmd(0, { forwardmove: 50, sidemove: 0, angleturn: 0, buttons: 0 });
    expect(ticsAonB).toHaveLength(1);
    // Unrelated awareness update re-runs B's drain; the sticky ticcmd field is
    // still present but must NOT re-fire (same seq).
    joinAs((ncA as unknown as { provider: { awareness: FakeAwareness } }).provider.awareness, 'aaa');
    expect(ticsAonB).toHaveLength(1);
    // A NEW ticcmd (bumped seq) fires again.
    ncA.broadcastLocalTiccmd(0, { forwardmove: -50, sidemove: 0, angleturn: 0, buttons: 0 });
    expect(ticsAonB).toHaveLength(2);
    expect(ticsAonB[1]!.forwardmove).toBe(-50);
  });

  // ── write cap: bounded awareness writes (no per-frame storm) ─────────────
  it('does NOT write awareness when the ticcmd is unchanged frame-to-frame (idle player)', () => {
    const bus = new FakeAwarenessBus();
    const aw = bus.create();
    joinAs(aw, 'aaa');
    const { runtime } = makeRuntime();
    const nc = new DoomNetcode({ provider: makeProvider(aw), moduleId: 'm', localUserId: 'aaa', runtime });
    nc.start();

    // Count awareness writes to the ticcmd field via the FakeAwareness spy.
    const fakeAw = (nc as unknown as { provider: { awareness: FakeAwareness } }).provider.awareness;
    let ticcmdWrites = 0;
    const realSet = fakeAw.setLocalStateField.bind(fakeAw);
    fakeAw.setLocalStateField = (field: string, value: unknown) => {
      if (field.includes(':ticcmd')) ticcmdWrites += 1;
      realSet(field, value);
    };

    const idle = { forwardmove: 0, sidemove: 0, angleturn: 0, buttons: 0 };
    // Simulate 60 rAF frames of a standing-still player.
    for (let i = 0; i < 60; i++) nc.broadcastLocalTiccmd(0, { ...idle });

    // Exactly ONE write for the initial state — NOT 60. The remaining 59
    // identical frames are suppressed (the storm-prevention cap).
    expect(ticcmdWrites).toBe(1);

    // A real input change writes again (movement is never starved).
    nc.broadcastLocalTiccmd(0, { forwardmove: 50, sidemove: 0, angleturn: 0, buttons: 0 });
    expect(ticcmdWrites).toBe(2);
  });
});
