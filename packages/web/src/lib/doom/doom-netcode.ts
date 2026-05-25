// packages/web/src/lib/doom/doom-netcode.ts
//
// Slice 2 of the DOOM true-4-player plan: the TypeScript netcode layer
// that implements the C-side `Module.PTNet` transport contract (defined by
// slice 1's net_pt.c, on main) over WebRTC data channels with a Yjs-
// awareness WS-relay fallback. NO UI here (slice 3+), NO per-peer instance
// model (slice 3), NO real-WebRTC e2e (slice 7).
//
// ────────────────────────────────────────────────────────────────────────
//  What this layer owns
// ────────────────────────────────────────────────────────────────────────
//   1. Peer-id mapping       — rack user ids (strings) ↔ small ints. The C
//                              side only ever speaks in ints; 0xFFFF is the
//                              broadcast sentinel (PT_BROADCAST_PEER). The
//                              mapping is the lex-sorted member list index,
//                              so it is identical on every peer.
//   2. Arbiter election      — lex-min localUserId among rack members is the
//                              arbiter ("server" in DOOM parlance). Reuses
//                              pickHost from doom-presence.ts. onArbiter
//                              fires on transition.
//   3. WebRTC data channels  — star topology: every peer ↔ the arbiter (the
//                              arbiter aggregates TicSets in C — see #6 — so
//                              no full mesh needed). SDP offers/answers + ICE
//                              candidates ride on Yjs awareness fields. STUN
//                              only (Google public). No TURN (committed
//                              decision); WS-relay is the NAT fallback.
//   4. WS-relay fallback     — if an RTCPeerConnection doesn't reach
//                              'connected' within RTC_CONNECT_TIMEOUT_MS,
//                              that peer's packets relay through awareness
//                              (`doom-net:<moduleId>:to:<peerId>` =
//                              {seq, bytesB64}). Bandwidth-heavy, NAT-proof.
//   5. PTNet wiring          — send() routes a packet (WebRTC or relay) to
//                              the target peer(s); inbound (data-channel
//                              message OR relay field) copies bytes into a
//                              WASM heap buffer and calls
//                              dgpt_net_inject_packet. poll() pumps queued
//                              inbound + drives the relay receive scan.
//   6. TicSet aggregation    — NOT done here. The vendored chocolate-doom
//                              net_server.c already aggregates per-tic
//                              ticcmds into TicSets internally once packets
//                              flow through the transport. This layer is
//                              pure reliable packet transport + arbiter
//                              routing; we do not reimplement lockstep in JS.
//
// Everything is structured so the unit suite can drive it with a STUBBED
// RTCPeerConnection + a mocked WASM Module/runtime. No real WebRTC ever runs
// in vitest (that's slice 7's Playwright job).

import type { HocuspocusProvider } from '@hocuspocus/provider';
import { pickHost } from './doom-presence';

// ────────────────────────────────────────────────────────────────────────
//  Constants
// ────────────────────────────────────────────────────────────────────────

/** Broadcast sentinel. Mirrors net_pt.c's PT_BROADCAST_PEER (0xFFFF). When
 *  the C side calls send(0xFFFF, ...) we fan the packet to every connected
 *  peer. */
export const PT_BROADCAST_PEER = 0xffff;

/** STUN server for ICE. Public Google STUN; no TURN per the committed
 *  no-native-helper / WS-relay-fallback decision. */
export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
];

/** If an RTCPeerConnection to a peer doesn't reach 'connected' within this
 *  many ms, fall back to relaying that peer's packets over Yjs awareness. */
export const RTC_CONNECT_TIMEOUT_MS = 3000;

/** Awareness field name carrying signaling (SDP/ICE) for module `mid`. We
 *  namespace by moduleId so two DOOM cards in the same rack don't collide. */
export function signalFieldFor(moduleId: string): string {
  return `doom-net:${moduleId}:signal`;
}

/** Awareness field name carrying a WS-relay packet from the local user TO
 *  peer `peerId`, for module `mid`. */
export function relayFieldFor(moduleId: string, peerId: number): string {
  return `doom-net:${moduleId}:to:${peerId}`;
}

/** Awareness field name carrying the arbiter's GAMESTART broadcast (the
 *  agreed net_gamesettings_t the arbiter picked in the New Game dialog) for
 *  module `mid`. Only the arbiter ever writes it; every joined peer reads it
 *  and calls dgpt_start_netgame with these settings + its own slot. */
export function gameStartFieldFor(moduleId: string): string {
  return `doom-net:${moduleId}:gamestart`;
}

/** Awareness field name carrying a peer's per-tic ticcmd (slice 5 cross-peer
 *  feed) for module `mid`. Each joined peer writes its own latest ticcmd here
 *  every tic; every OTHER joined peer reads it + injects it into its sim so
 *  all players' marines move in every peer's world. A single sticky field
 *  overwritten each tic (last-value wins) — see DoomNetcode.broadcastLocalTiccmd. */
export function ticcmdFieldFor(moduleId: string): string {
  return `doom-net:${moduleId}:ticcmd`;
}

// ────────────────────────────────────────────────────────────────────────
//  net_gamesettings_t (the launch payload)
// ────────────────────────────────────────────────────────────────────────

/** Game modes the New Game dialog offers. The numeric `deathmatch` value
 *  matches DOOM's global: 0 = coop, 1 = deathmatch, 2 = deathmatch-2.0.
 *  "survival" is coop with respawning monsters + no item respawn — there is
 *  no distinct DOOM global for it, so it maps to deathmatch=0 + a flag the
 *  card sets (respawn_monsters), kept here for the UI label only. */
export type DoomGameMode = 'coop' | 'deathmatch' | 'deathmatch-2.0' | 'survival';

/** The settings the arbiter picks + broadcasts; mirrors the subset of
 *  chocolate-doom's net_gamesettings_t that dgpt_start_netgame consumes.
 *  Fields are the C-call argument order so serialization is mechanical. */
export interface DoomGameSettings {
  /** 0 = coop, 1 = deathmatch, 2 = deathmatch-2.0. */
  deathmatch: number;
  /** 1..3 (shareware DOOM1 = episode 1 only). */
  episode: number;
  /** 1..9. */
  map: number;
  /** DOOM skill_t, 0-based: 0 = ITYTD .. 4 = Nightmare. */
  skill: number;
  /** 0/1 — no monsters. */
  nomonsters: number;
  /** 0/1 — fast monsters (-fast). */
  fastMonsters: number;
  /** 0/1 — respawning monsters (-respawn; survival mode sets this). */
  respawnMonsters: number;
  /** How many player slots are live this game (= roster size at Launch). */
  numPlayers: number;
}

/** The launch envelope as it rides on awareness. Carries the settings +
 *  a monotonic launch id so peers ignore a re-broadcast of a launch they
 *  already started, and detect a NEW launch (next-map at intermission). */
export interface GameStartEnvelope {
  /** Monotonically increasing per arbiter; the start of a NEW level bumps
   *  it so peers re-run dgpt_start_netgame for the next map. */
  launchId: number;
  settings: DoomGameSettings;
}

/** A peer's per-tic ticcmd as it rides on awareness (slice 5). Carries the
 *  sender's slot so the receiver injects it at the right player index, plus a
 *  monotonic `seq` so a sticky re-broadcast of an unchanged ticcmd is applied
 *  at most once per new value (and stale re-fires on unrelated awareness
 *  updates are ignored). Fields mirror DoomTiccmd. */
export interface TiccmdEnvelope {
  /** The sender's player slot (0..3). */
  slot: number;
  forwardmove: number;
  sidemove: number;
  angleturn: number;
  buttons: number;
  /** Monotonic per-sender; receiver dedupes on it. */
  seq: number;
}

/** Stable field order for serialization (the round-trip unit test pins it).
 *  We serialize to a compact JSON string leaf (same primitive-leaf-syncs-
 *  reliably rationale as the roster). */
const GAME_SETTINGS_FIELDS = [
  'deathmatch',
  'episode',
  'map',
  'skill',
  'nomonsters',
  'fastMonsters',
  'respawnMonsters',
  'numPlayers',
] as const satisfies readonly (keyof DoomGameSettings)[];

/** Serialize settings to a deterministic JSON string (sorted-by-known-order
 *  so identical settings yield identical strings — no redundant Yjs writes). */
export function serializeGameSettings(s: DoomGameSettings): string {
  const ordered: Record<string, number> = {};
  for (const k of GAME_SETTINGS_FIELDS) ordered[k] = s[k];
  return JSON.stringify(ordered);
}

/** Parse settings from the string (or object) form, defensively. Returns
 *  null if any field is missing / non-numeric (a malformed broadcast must
 *  not start a half-configured game). */
export function parseGameSettings(raw: unknown): DoomGameSettings | null {
  let obj: unknown = raw;
  if (typeof obj === 'string') {
    try {
      obj = JSON.parse(obj);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object') return null;
  const rec = obj as Record<string, unknown>;
  const out: Partial<DoomGameSettings> = {};
  for (const k of GAME_SETTINGS_FIELDS) {
    const v = rec[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    out[k] = v;
  }
  return out as DoomGameSettings;
}

// ────────────────────────────────────────────────────────────────────────
//  Runtime contract (subset of DoomRuntime this layer needs)
// ────────────────────────────────────────────────────────────────────────

/** The slice-1 export surface this netcode drives. We deliberately depend
 *  on a narrow structural interface (not the full DoomRuntime class) so the
 *  unit tests can pass a tiny mock. The real DoomRuntime satisfies this via
 *  the methods added in slice 3's wiring; for slice 2 we only need:
 *    - a Module handle to install `Module.PTNet` on (so the C EM_JS hooks
 *      find it), and
 *    - injectNetPacket() to deliver inbound bytes into the C recv queue. */
export interface NetcodeRuntime {
  /** The emcc Module object. We install `Module.PTNet` here and call the
   *  `dgpt_net_*` exports through it. */
  getModule(): NetcodeModule | null;
  /** Copy `bytes` into a WASM heap buffer and call dgpt_net_inject_packet
   *  with the given source peer id. Returns true if the C recv queue
   *  accepted the packet (false if it was full). This is the JS→C inbound
   *  path. */
  injectNetPacket(bytes: Uint8Array, srcPeerId: number): boolean;
}

/** The minimal emcc Module surface we touch. `PTNet` is the object the C
 *  EM_JS hooks read (`Module["PTNet"].send(...)` etc.). HEAPU8 lets send()
 *  read the bytes the C side wrote at `ptr`. */
export interface NetcodeModule {
  HEAPU8: Uint8Array;
  PTNet?: PTNet;
  ccall?: (
    name: string,
    returnType: 'number' | 'string' | null,
    argTypes: Array<'number' | 'string'>,
    args: Array<number | string>,
  ) => number;
}

/** The object the C side calls into (see net_pt.c's contract block). All
 *  methods are SYNCHRONOUS from C's perspective; none may block. */
export interface PTNet {
  /** Read `len` bytes from the WASM heap at `ptr` and transmit to `peerId`
   *  (0xFFFF = broadcast). Copy synchronously — the C buffer is reused on
   *  return. */
  send(peerId: number, ptr: number, len: number): void;
  /** Pump the transport + deliver any pending inbound packets before C
   *  drains. Called at the top of every C RecvPacket. */
  poll(): void;
  /** Optional: a new peer id was first seen; open a channel to it. */
  resolve(peerId: number): void;
  /** Optional: the C side dropped the last reference to a peer; close. */
  free(peerId: number): void;
}

// ────────────────────────────────────────────────────────────────────────
//  Per-peer transport state
// ────────────────────────────────────────────────────────────────────────

export type PeerTransport = 'webrtc' | 'ws-relay' | 'connecting';

interface PeerState {
  userId: string;
  peerId: number;
  /** Null until we (as arbiter, or as a peer answering the arbiter) create
   *  one. Peers that talk to each other only via relay never create a pc. */
  pc: RTCPeerConnection | null;
  channel: RTCDataChannel | null;
  transport: PeerTransport;
  /** Timer that, on fire, demotes this peer to ws-relay. Cleared once the
   *  connection state hits 'connected'. */
  fallbackTimer: ReturnType<typeof setTimeout> | null;
  /** Monotonic per-peer outbound sequence for the relay path (lets the
   *  receiver dedupe sticky awareness re-broadcasts). */
  relayTxSeq: number;
  /** Highest relay seq we've already injected from this peer (dedupe). */
  relayRxSeq: number;
}

// ────────────────────────────────────────────────────────────────────────
//  Awareness signaling envelopes (rides on a single per-module field)
// ────────────────────────────────────────────────────────────────────────

type SignalKind = 'offer' | 'answer' | 'ice';

interface SignalEnvelope {
  kind: SignalKind;
  /** Who sent it (rack user id). */
  from: string;
  /** Who it's for (rack user id). */
  to: string;
  /** SDP for offer/answer; JSON ICE candidate for 'ice'. */
  sdp?: string;
  candidate?: RTCIceCandidateInit;
  /** Monotonic seq so the receiver ignores re-broadcasts of an envelope it
   *  already consumed (awareness state is sticky). */
  seq: number;
}

interface RelayEnvelope {
  seq: number;
  bytesB64: string;
}

// ────────────────────────────────────────────────────────────────────────
//  DoomNetcode
// ────────────────────────────────────────────────────────────────────────

export interface DoomNetcodeOpts {
  provider: HocuspocusProvider;
  moduleId: string;
  localUserId: string;
  runtime: NetcodeRuntime;
  onArbiter?: (isArbiter: boolean) => void;
  /** Fired (on every peer, arbiter included) when a NEW launch envelope
   *  arrives from the arbiter — i.e. the arbiter hit Launch (or picked the
   *  next map at intermission). The card responds by calling
   *  runtime.startNetGame(settings) with its own slot as consoleplayer.
   *  Deduped on launchId so a sticky re-broadcast fires the callback once. */
  onGameStart?: (env: GameStartEnvelope) => void;
  /** Slice 5: fired for each REMOTE peer's latest ticcmd (deduped on the
   *  sender's seq). The card injects it into its runtime so that peer's
   *  marine moves in this peer's world. Never fired for the local peer's own
   *  ticcmd. */
  onRemoteTiccmd?: (env: TiccmdEnvelope) => void;
}

export class DoomNetcode {
  private readonly provider: HocuspocusProvider;
  private readonly moduleId: string;
  private readonly localUserId: string;
  private readonly runtime: NetcodeRuntime;
  private readonly onArbiter?: (isArbiter: boolean) => void;
  private readonly onGameStart?: (env: GameStartEnvelope) => void;
  private readonly onRemoteTiccmd?: (env: TiccmdEnvelope) => void;

  /** Monotonic per-tic seq the local peer stamps on each broadcast ticcmd. */
  private ticcmdTxSeq = 0;
  /** Highest ticcmd seq we've already delivered to onRemoteTiccmd, keyed by
   *  sender user id (dedupe the sticky awareness re-broadcast). */
  private ticcmdRxSeq = new Map<string, number>();

  /** Monotonic launch id the arbiter stamps on each GAMESTART broadcast. */
  private launchTxId = 0;
  /** Highest launchId we've already delivered to onGameStart (dedupe the
   *  sticky awareness re-broadcast). */
  private launchRxId = -1;

  /** lex-sorted member user ids → index = peerId. Rebuilt on membership
   *  change; identical on every peer. */
  private peerIdByUser = new Map<string, number>();
  private userByPeerId = new Map<number, string>();
  private peers = new Map<number, PeerState>();

  private arbiterUserId: string | null = null;
  private started = false;

  private signalTxSeq = 0;
  /** Per-(from,kind,...) seqs we've already consumed from awareness. Keyed
   *  by `${from}:${seq}` for the signal field. */
  private consumedSignalSeq = new Set<string>();

  private awarenessUpdateHandler: (() => void) | null = null;

  constructor(opts: DoomNetcodeOpts) {
    this.provider = opts.provider;
    this.moduleId = opts.moduleId;
    this.localUserId = opts.localUserId;
    this.runtime = opts.runtime;
    this.onArbiter = opts.onArbiter;
    this.onGameStart = opts.onGameStart;
    this.onRemoteTiccmd = opts.onRemoteTiccmd;
  }

  // ── lifecycle ──────────────────────────────────────────────────────────

  start(): void {
    if (this.started) return;
    this.started = true;

    this.installPTNet();
    this.recomputeMembership();

    const aw = this.provider.awareness;
    if (aw) {
      const handler = (): void => {
        this.recomputeMembership();
        this.drainInboundSignals();
        this.drainInboundRelay();
        this.drainInboundGameStart();
        this.drainInboundTiccmds();
      };
      aw.on('update', handler);
      this.awarenessUpdateHandler = () => aw.off('update', handler);
      // One initial drain in case state is already present.
      handler();
    }
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;

    if (this.awarenessUpdateHandler) {
      try {
        this.awarenessUpdateHandler();
      } catch {
        /* provider may be gone */
      }
      this.awarenessUpdateHandler = null;
    }

    for (const peer of this.peers.values()) {
      this.teardownPeer(peer);
    }
    this.peers.clear();
    this.peerIdByUser.clear();
    this.userByPeerId.clear();

    const mod = this.runtime.getModule();
    if (mod && mod.PTNet) {
      delete mod.PTNet;
    }
  }

  // ── debug / test surface ─────────────────────────────────────────────────

  debugStats(): {
    peers: string[];
    isArbiter: boolean;
    ticLag: number;
    transport: 'webrtc' | 'ws-relay' | 'mixed';
  } {
    const peerUsers = [...this.peers.values()].map((p) => p.userId).sort();
    const transports = new Set(
      [...this.peers.values()]
        .map((p) => p.transport)
        .filter((t): t is 'webrtc' | 'ws-relay' => t !== 'connecting'),
    );
    let transport: 'webrtc' | 'ws-relay' | 'mixed';
    if (transports.size <= 1) {
      transport = (transports.values().next().value ?? 'webrtc') as
        | 'webrtc'
        | 'ws-relay';
    } else {
      transport = 'mixed';
    }
    return {
      peers: peerUsers,
      isArbiter: this.isArbiter(),
      // ticLag is owned by the C net_server.c aggregation; the JS layer
      // does not track lockstep, so we report 0 here (slice 4+ may surface
      // a real value via a dgpt export).
      ticLag: 0,
      transport,
    };
  }

  /** True if the local user is the arbiter (lex-min member). */
  isArbiter(): boolean {
    return this.arbiterUserId !== null && this.arbiterUserId === this.localUserId;
  }

  /** Exposed for tests + slice 3 wiring: stable peerId for a rack user id,
   *  or undefined if the user is not a current member. */
  peerIdForUser(userId: string): number | undefined {
    return this.peerIdByUser.get(userId);
  }

  userForPeerId(peerId: number): string | undefined {
    return this.userByPeerId.get(peerId);
  }

  // ── peer-id mapping + arbiter election ──────────────────────────────────

  /** Read the live rack-member user ids from awareness (the `user.id`
   *  convention set by multiplayer/presence.ts), rebuild the deterministic
   *  peer-id map, run arbiter election, and open/close peers to match. */
  private recomputeMembership(): void {
    const members = this.readMembers();

    // Deterministic peer-id assignment: lex-sort, index = peerId. Identical
    // on every peer because the input set + sort are identical. We skip
    // PT_BROADCAST_PEER (0xFFFF) implicitly — index space is 0..n-1.
    const sorted = [...members].sort();
    const nextByUser = new Map<string, number>();
    const nextByPeerId = new Map<number, string>();
    sorted.forEach((uid, idx) => {
      nextByUser.set(uid, idx);
      nextByPeerId.set(idx, uid);
    });
    this.peerIdByUser = nextByUser;
    this.userByPeerId = nextByPeerId;

    // Arbiter election (reuse pickHost: keep current if still present, else
    // lex-min). Fire onArbiter on transition.
    const prevArbiter = this.arbiterUserId;
    const nextArbiter = pickHost(this.arbiterUserId, members);
    this.arbiterUserId = nextArbiter;
    if (prevArbiter !== nextArbiter) {
      this.onArbiter?.(this.isArbiter());
    }

    // Reconcile peer set: a "peer" is every OTHER member. We don't create a
    // peer entry for ourselves.
    const wanted = new Set(sorted.filter((uid) => uid !== this.localUserId));

    // Remove peers that left.
    for (const [peerId, peer] of [...this.peers.entries()]) {
      if (!wanted.has(peer.userId)) {
        this.teardownPeer(peer);
        this.peers.delete(peerId);
      }
    }

    // Add peers that joined. Topology is a star around the arbiter: the
    // arbiter dials every other member; everyone else only maintains a peer
    // entry for the arbiter (they receive the arbiter's offer). Non-arbiter
    // ↔ non-arbiter pairs never connect (the arbiter aggregates TicSets).
    for (const uid of wanted) {
      const peerId = nextByUser.get(uid);
      if (peerId === undefined) continue;
      if (this.peers.has(peerId)) continue;

      const isPeerTheArbiter = uid === this.arbiterUserId;
      const localIsArbiter = this.isArbiter();
      if (!localIsArbiter && !isPeerTheArbiter) {
        // Star topology: a non-arbiter peer only talks to the arbiter.
        continue;
      }

      const peer = this.makePeerState(uid, peerId);
      this.peers.set(peerId, peer);

      // The arbiter is the offerer (dials each peer). The non-arbiter side
      // waits for the offer to arrive over awareness (handled in
      // drainInboundSignals). This keeps glare impossible.
      if (localIsArbiter) {
        this.dialPeer(peer);
      } else {
        // We are a non-arbiter and `uid` is the arbiter: start the fallback
        // timer so that if the arbiter's offer never arrives / never
        // connects, we drop to relay.
        this.armFallbackTimer(peer);
      }
    }
  }

  /** Live rack-member user ids from awareness, always including self. */
  private readMembers(): string[] {
    const aw = this.provider.awareness;
    const ids = new Set<string>([this.localUserId]);
    if (aw) {
      for (const [, state] of aw.getStates()) {
        const uid = (state as { user?: { id?: string } } | undefined)?.user?.id;
        if (typeof uid === 'string') ids.add(uid);
      }
    }
    return [...ids];
  }

  // ── PTNet install + send/poll ────────────────────────────────────────────

  private installPTNet(): void {
    const mod = this.runtime.getModule();
    if (!mod) return;
    const ptnet: PTNet = {
      send: (peerId, ptr, len) => this.ptSend(peerId, ptr, len),
      poll: () => this.ptPoll(),
      resolve: (peerId) => this.ptResolve(peerId),
      free: (peerId) => this.ptFree(peerId),
    };
    mod.PTNet = ptnet;
    // Optional post-load sanity hook (net_pt.c's dgpt_net_register also
    // points net_broadcast_addr at the module). Tolerate its absence.
    try {
      mod.ccall?.('dgpt_net_register', 'number', [], []);
    } catch {
      /* harness may stub ccall away */
    }
  }

  /** C→JS: send `len` bytes from heap offset `ptr` to `peerId`. We COPY the
   *  bytes synchronously (the C buffer is reused on return). */
  private ptSend(peerId: number, ptr: number, len: number): void {
    const mod = this.runtime.getModule();
    if (!mod) return;
    // Synchronous copy out of the heap. .slice() makes an owned copy.
    const bytes = mod.HEAPU8.slice(ptr, ptr + len);
    if (peerId === PT_BROADCAST_PEER) {
      for (const peer of this.peers.values()) {
        this.transmit(peer, bytes);
      }
      return;
    }
    const peer = this.peers.get(peerId);
    if (peer) {
      this.transmit(peer, bytes);
    }
    // Unknown peer id: drop (the C side will resend; or the peer left).
  }

  /** C→JS: pump the transport. Inbound WebRTC packets are injected eagerly
   *  in the data-channel onmessage handler, so the main work here is the
   *  relay-receive scan (in case an awareness update fired between C tics).
   *  Idempotent + cheap. */
  private ptPoll(): void {
    this.drainInboundRelay();
  }

  private ptResolve(peerId: number): void {
    // The C side saw a new peer id. Our membership recompute already creates
    // peer entries proactively, so this is mostly a no-op; but if the peer
    // exists and has no channel yet and we're the arbiter, (re)dial.
    const peer = this.peers.get(peerId);
    if (peer && this.isArbiter() && !peer.channel && !peer.pc) {
      this.dialPeer(peer);
    }
  }

  private ptFree(peerId: number): void {
    const peer = this.peers.get(peerId);
    if (peer) {
      this.teardownPeer(peer);
      this.peers.delete(peerId);
    }
  }

  // ── transmit (WebRTC or relay) ───────────────────────────────────────────

  private transmit(peer: PeerState, bytes: Uint8Array): void {
    if (
      peer.transport === 'webrtc' &&
      peer.channel &&
      peer.channel.readyState === 'open'
    ) {
      try {
        // Send the exact byte range as an ArrayBuffer (the DataChannel.send
        // overloads don't accept a Uint8Array<ArrayBufferLike> cleanly; an
        // ArrayBuffer is unambiguous and copies the precise window).
        peer.channel.send(
          bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ) as ArrayBuffer,
        );
        return;
      } catch {
        // Channel went bad mid-flight — drop to relay for this + future
        // packets.
        this.demoteToRelay(peer);
      }
    }
    // ws-relay (or connecting/failed webrtc): relay over awareness.
    this.relaySend(peer, bytes);
  }

  // ── WebRTC dialing + signaling over awareness ────────────────────────────

  private makePeerState(userId: string, peerId: number): PeerState {
    return {
      userId,
      peerId,
      pc: null,
      channel: null,
      transport: 'connecting',
      fallbackTimer: null,
      relayTxSeq: 0,
      relayRxSeq: -1,
    };
  }

  /** Arbiter side: create the RTCPeerConnection + data channel, make an
   *  offer, and ship it over awareness. */
  private dialPeer(peer: PeerState): void {
    const pc = this.newPeerConnection();
    if (!pc) {
      // No WebRTC in this environment — go straight to relay.
      peer.transport = 'ws-relay';
      return;
    }
    peer.pc = pc;
    const channel = pc.createDataChannel('doom-tics', {
      ordered: true,
    });
    this.wireChannel(peer, channel);
    this.wirePeerConnection(peer, pc);
    this.armFallbackTimer(peer);

    void (async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this.sendSignal({
          kind: 'offer',
          from: this.localUserId,
          to: peer.userId,
          sdp: offer.sdp,
          seq: this.signalTxSeq++,
        });
      } catch {
        this.demoteToRelay(peer);
      }
    })();
  }

  private newPeerConnection(): RTCPeerConnection | null {
    const Ctor = (
      globalThis as unknown as {
        RTCPeerConnection?: new (cfg?: RTCConfiguration) => RTCPeerConnection;
      }
    ).RTCPeerConnection;
    if (!Ctor) return null;
    try {
      return new Ctor({ iceServers: DEFAULT_ICE_SERVERS });
    } catch {
      return null;
    }
  }

  private wirePeerConnection(peer: PeerState, pc: RTCPeerConnection): void {
    pc.onicecandidate = (ev) => {
      if (!ev.candidate) return;
      this.sendSignal({
        kind: 'ice',
        from: this.localUserId,
        to: peer.userId,
        candidate: ev.candidate.toJSON
          ? ev.candidate.toJSON()
          : (ev.candidate as unknown as RTCIceCandidateInit),
        seq: this.signalTxSeq++,
      });
    };
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === 'connected') {
        this.promoteToWebrtc(peer);
      } else if (st === 'failed' || st === 'disconnected' || st === 'closed') {
        this.demoteToRelay(peer);
      }
    };
    // Answer side: the channel arrives via ondatachannel rather than being
    // created locally.
    pc.ondatachannel = (ev) => {
      this.wireChannel(peer, ev.channel);
    };
  }

  private wireChannel(peer: PeerState, channel: RTCDataChannel): void {
    peer.channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => this.promoteToWebrtc(peer);
    channel.onclose = () => {
      if (peer.transport === 'webrtc') this.demoteToRelay(peer);
    };
    channel.onmessage = (ev) => {
      const data = ev.data as ArrayBuffer | Uint8Array | string;
      const bytes = this.coerceBytes(data);
      if (bytes) this.runtime.injectNetPacket(bytes, peer.peerId);
    };
  }

  private coerceBytes(
    data: ArrayBuffer | Uint8Array | string,
  ): Uint8Array | null {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    return null;
  }

  private promoteToWebrtc(peer: PeerState): void {
    if (peer.fallbackTimer) {
      clearTimeout(peer.fallbackTimer);
      peer.fallbackTimer = null;
    }
    // Only flip to webrtc once the channel is actually open.
    if (peer.channel && peer.channel.readyState === 'open') {
      peer.transport = 'webrtc';
    }
  }

  private demoteToRelay(peer: PeerState): void {
    if (peer.fallbackTimer) {
      clearTimeout(peer.fallbackTimer);
      peer.fallbackTimer = null;
    }
    peer.transport = 'ws-relay';
  }

  /** Start (or restart) the 3s timer that drops `peer` to ws-relay if WebRTC
   *  hasn't connected. */
  private armFallbackTimer(peer: PeerState): void {
    if (peer.fallbackTimer) clearTimeout(peer.fallbackTimer);
    peer.fallbackTimer = setTimeout(() => {
      peer.fallbackTimer = null;
      if (peer.transport !== 'webrtc') {
        this.demoteToRelay(peer);
      }
    }, RTC_CONNECT_TIMEOUT_MS);
  }

  private sendSignal(env: SignalEnvelope): void {
    const aw = this.provider.awareness;
    if (!aw) return;
    aw.setLocalStateField(signalFieldFor(this.moduleId), env);
  }

  /** Scan awareness for signaling envelopes addressed to us + apply them. */
  private drainInboundSignals(): void {
    const aw = this.provider.awareness;
    if (!aw) return;
    const field = signalFieldFor(this.moduleId);
    for (const [, state] of aw.getStates()) {
      const env = (state as Record<string, unknown> | undefined)?.[field] as
        | SignalEnvelope
        | undefined;
      if (!env || env.to !== this.localUserId || env.from === this.localUserId) {
        continue;
      }
      const key = `${env.from}:${env.kind}:${env.seq}`;
      if (this.consumedSignalSeq.has(key)) continue;
      this.consumedSignalSeq.add(key);
      void this.handleSignal(env);
    }
  }

  private async handleSignal(env: SignalEnvelope): Promise<void> {
    const peerId = this.peerIdByUser.get(env.from);
    if (peerId === undefined) return;
    let peer = this.peers.get(peerId);

    if (env.kind === 'offer') {
      // We are the answerer (non-arbiter). Lazily create the pc if needed.
      if (!peer) {
        peer = this.makePeerState(env.from, peerId);
        this.peers.set(peerId, peer);
      }
      if (!peer.pc) {
        const pc = this.newPeerConnection();
        if (!pc) {
          this.demoteToRelay(peer);
          return;
        }
        peer.pc = pc;
        this.wirePeerConnection(peer, pc);
        this.armFallbackTimer(peer);
      }
      try {
        await peer.pc.setRemoteDescription({ type: 'offer', sdp: env.sdp });
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        this.sendSignal({
          kind: 'answer',
          from: this.localUserId,
          to: env.from,
          sdp: answer.sdp,
          seq: this.signalTxSeq++,
        });
      } catch {
        this.demoteToRelay(peer);
      }
    } else if (env.kind === 'answer') {
      if (!peer || !peer.pc) return;
      try {
        await peer.pc.setRemoteDescription({ type: 'answer', sdp: env.sdp });
      } catch {
        this.demoteToRelay(peer);
      }
    } else if (env.kind === 'ice') {
      if (!peer || !peer.pc || !env.candidate) return;
      try {
        await peer.pc.addIceCandidate(env.candidate);
      } catch {
        /* late / duplicate candidate — ignore */
      }
    }
  }

  // ── GAMESTART broadcast (the Launch payload) ─────────────────────────────
  //
  // The settings blob is small + must reach every joined peer reliably, so
  // it rides on awareness (a sticky per-arbiter field) rather than the
  // unreliable-ordered tic data channel. Only the arbiter ever calls
  // broadcastGameStart; every peer (arbiter included) picks it up in
  // drainInboundGameStart and fires onGameStart. This is the "arbiter
  // broadcasts net_gamesettings_t → all peers call D_StartNetGame" wiring.

  /** Arbiter-only: broadcast a launch. No-op (returns false) on a non-
   *  arbiter — the dialog is arbiter-gated in the card, but we guard here
   *  too so a stray call can't desync the rack. Bumps the launchId each
   *  call so a re-launch (next map at intermission) is seen as new. Returns
   *  the launchId on success. */
  broadcastGameStart(settings: DoomGameSettings): number | false {
    if (!this.isArbiter()) return false;
    const aw = this.provider.awareness;
    if (!aw) return false;
    const launchId = ++this.launchTxId;
    const env: GameStartEnvelope = { launchId, settings };
    aw.setLocalStateField(gameStartFieldFor(this.moduleId), env);
    // The arbiter also runs the launch locally (it is a player too): fire
    // our own onGameStart synchronously so the arbiter's WASM starts without
    // waiting on an awareness round-trip back to itself.
    if (launchId > this.launchRxId) {
      this.launchRxId = launchId;
      this.onGameStart?.(env);
    }
    return launchId;
  }

  /** Scan awareness for the arbiter's GAMESTART envelope + fire onGameStart
   *  for a launchId we haven't delivered yet. We only honour a launch from
   *  the CURRENT arbiter (ignoring a stale field left by a former arbiter
   *  who has since lost the role). */
  private drainInboundGameStart(): void {
    const aw = this.provider.awareness;
    if (!aw) return;
    const field = gameStartFieldFor(this.moduleId);
    for (const [, state] of aw.getStates()) {
      const s = state as Record<string, unknown> | undefined;
      if (!s) continue;
      const fromUid = (s as { user?: { id?: string } }).user?.id;
      if (typeof fromUid !== 'string') continue;
      // Only the arbiter's broadcast counts.
      if (fromUid !== this.arbiterUserId) continue;
      const env = s[field] as GameStartEnvelope | undefined;
      if (!env || typeof env.launchId !== 'number') continue;
      const settings = parseGameSettings(env.settings);
      if (!settings) continue;
      if (env.launchId <= this.launchRxId) continue;
      this.launchRxId = env.launchId;
      this.onGameStart?.({ launchId: env.launchId, settings });
    }
  }

  // ── Slice 5: cross-peer ticcmd feed ──────────────────────────────────────
  //
  // The per-tic ticcmd is tiny (4 small ints) + must reach every other joined
  // peer, so it rides a single sticky awareness field per peer, overwritten
  // each tic (last-value-wins). A monotonic seq lets receivers apply each new
  // value once + ignore the sticky re-broadcast on unrelated awareness
  // updates. This is the practical lockstep cross-feed for our transport (see
  // the rationale block in d_loop.c) — NOT routed through the chocolate-doom
  // net_client packet path, which never connects in our JS-driven start flow.

  /** Broadcast THIS peer's latest local ticcmd, tagged with its slot. Called
   *  by the card each tic after reading runtime.readLocalTiccmd(). Skips the
   *  write when nothing changed since the last broadcast (same field bytes →
   *  no redundant awareness churn) by always bumping seq but letting the
   *  receiver dedupe; we still avoid a write if there is no awareness. */
  broadcastLocalTiccmd(slot: number, cmd: {
    forwardmove: number;
    sidemove: number;
    angleturn: number;
    buttons: number;
  }): void {
    const aw = this.provider.awareness;
    if (!aw) return;
    const env: TiccmdEnvelope = {
      slot,
      forwardmove: cmd.forwardmove,
      sidemove: cmd.sidemove,
      angleturn: cmd.angleturn,
      buttons: cmd.buttons,
      seq: this.ticcmdTxSeq++,
    };
    aw.setLocalStateField(ticcmdFieldFor(this.moduleId), env);
  }

  /** Scan awareness for OTHER joined peers' ticcmd envelopes + fire
   *  onRemoteTiccmd for each new (per-sender seq) value. Deduped so a sticky
   *  re-broadcast injects once; we read by sender user id so two peers'
   *  fields never collide. */
  private drainInboundTiccmds(): void {
    const aw = this.provider.awareness;
    if (!aw) return;
    const field = ticcmdFieldFor(this.moduleId);
    for (const [, state] of aw.getStates()) {
      const s = state as Record<string, unknown> | undefined;
      if (!s) continue;
      const fromUid = (s as { user?: { id?: string } }).user?.id;
      if (typeof fromUid !== 'string' || fromUid === this.localUserId) continue;
      const env = s[field] as TiccmdEnvelope | undefined;
      if (!env || typeof env.seq !== 'number' || typeof env.slot !== 'number') {
        continue;
      }
      const last = this.ticcmdRxSeq.get(fromUid) ?? -1;
      if (env.seq <= last) continue;
      this.ticcmdRxSeq.set(fromUid, env.seq);
      this.onRemoteTiccmd?.({
        slot: env.slot,
        forwardmove: env.forwardmove,
        sidemove: env.sidemove,
        angleturn: env.angleturn,
        buttons: env.buttons,
        seq: env.seq,
      });
    }
  }

  // ── WS-relay fallback (packets over awareness) ───────────────────────────

  private relaySend(peer: PeerState, bytes: Uint8Array): void {
    const aw = this.provider.awareness;
    if (!aw) return;
    const env: RelayEnvelope = {
      seq: peer.relayTxSeq++,
      bytesB64: bytesToB64(bytes),
    };
    aw.setLocalStateField(relayFieldFor(this.moduleId, peer.peerId), env);
  }

  /** Scan awareness for relay packets addressed to us (i.e. fields named
   *  `doom-net:<mid>:to:<myPeerId>` written by other peers) + inject them.
   *  Dedupe by per-peer seq so sticky re-broadcasts inject once. */
  private drainInboundRelay(): void {
    const aw = this.provider.awareness;
    if (!aw) return;
    const myPeerId = this.peerIdByUser.get(this.localUserId);
    if (myPeerId === undefined) return;
    const field = relayFieldFor(this.moduleId, myPeerId);

    for (const [, state] of aw.getStates()) {
      const s = state as Record<string, unknown> | undefined;
      if (!s) continue;
      const fromUid = (s as { user?: { id?: string } }).user?.id;
      if (typeof fromUid !== 'string' || fromUid === this.localUserId) continue;
      const env = s[field] as RelayEnvelope | undefined;
      if (!env || typeof env.seq !== 'number' || typeof env.bytesB64 !== 'string') {
        continue;
      }
      const srcPeerId = this.peerIdByUser.get(fromUid);
      if (srcPeerId === undefined) continue;
      const peer = this.peers.get(srcPeerId);
      // Track dedupe per source peer; create a lightweight rx-tracking entry
      // even if we don't have a full peer (relay-only paths).
      const lastSeq = peer ? peer.relayRxSeq : this.relayRxSeqFallback(srcPeerId);
      if (env.seq <= lastSeq) continue;
      if (peer) {
        peer.relayRxSeq = env.seq;
      } else {
        this.setRelayRxSeqFallback(srcPeerId, env.seq);
      }
      const bytes = b64ToBytes(env.bytesB64);
      this.runtime.injectNetPacket(bytes, srcPeerId);
    }
  }

  /** Dedupe bookkeeping for relay sources we have no PeerState for (can
   *  happen transiently during membership churn). */
  private relayRxFallback = new Map<number, number>();
  private relayRxSeqFallback(peerId: number): number {
    return this.relayRxFallback.get(peerId) ?? -1;
  }
  private setRelayRxSeqFallback(peerId: number, seq: number): void {
    this.relayRxFallback.set(peerId, seq);
  }

  // ── teardown ─────────────────────────────────────────────────────────────

  private teardownPeer(peer: PeerState): void {
    if (peer.fallbackTimer) {
      clearTimeout(peer.fallbackTimer);
      peer.fallbackTimer = null;
    }
    if (peer.channel) {
      try {
        peer.channel.close();
      } catch {
        /* */
      }
      peer.channel = null;
    }
    if (peer.pc) {
      try {
        peer.pc.close();
      } catch {
        /* */
      }
      peer.pc = null;
    }
  }
}

// ────────────────────────────────────────────────────────────────────────
//  base64 helpers (chunked; mirrors doom-presence.ts so Safari's call-stack
//  limit on String.fromCharCode(...bigArray) is respected).
// ────────────────────────────────────────────────────────────────────────

function bytesToB64(buf: Uint8Array): string {
  const SLICE = 8192;
  let binary = '';
  for (let i = 0; i < buf.length; i += SLICE) {
    binary += String.fromCharCode(...buf.subarray(i, i + SLICE));
  }
  return globalThis.btoa(binary);
}

function b64ToBytes(b64: string): Uint8Array {
  const binary = globalThis.atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
