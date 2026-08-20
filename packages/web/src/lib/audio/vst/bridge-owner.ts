// packages/web/src/lib/audio/vst/bridge-owner.ts
//
// WHO OWNS A VST BRIDGE CONNECTION — a per-NODE registry that outlives every
// view, cloned from es9/bridge-owner.ts (whose header carries the full case
// history: card-owned connections died on dock collapse; listeners keyed off
// the entry missed the subscribe-before-reconcile ordering; page unloads
// leaked sockets until the bridge wedged). Same rules here:
//
//   - the connection is owned per NODE ID, created by the ENGINE FACTORY,
//     released only when the node's engine handle is disposed (the node
//     leaves the graph) — never by a component unmount;
//   - views SUBSCRIBE; the listener set lives OUTSIDE the entry so a view
//     can subscribe before, during or after the connection exists;
//   - pagehide/beforeunload closes every socket (a clean close is the
//     contract we owe the helper — parked instances survive 90 s anyway).
//
// ONE DELTA vs es9: PER-CARD CONNECTIONS. The helper's session model is one
// WebSocket = one plugin instance (cap 16), so every acquire creates its
// own client/worker/rings keyed by its node id — no single-client logic, no
// takeover. The clientId sent in hello IS the node id, which is what makes
// a page refresh adopt the parked instance and replay `mounted`.

import {
  VstBridgeClient,
  type VstBridgeConfig,
  type VstConnectionState,
} from './bridge-client';
import type {
  VstEditor,
  VstHelperInfo,
  VstMeters,
  VstMountError,
  VstMounted,
  VstPluginInfo,
  VstState,
  VstStateSet,
} from './vst-protocol';
import type { MidiRingSpec, RingSpec } from './vst-ring';

/** Everything a VIEW (or the factory's live-state relay) needs to render,
 *  and nothing it needs to own. */
export interface VstOwnerSnapshot {
  state: VstConnectionState;
  detail: string | undefined;
  helper: VstHelperInfo | null;
  plugins: VstPluginInfo[];
  /** The live mount (replayed by the bridge when a reconnect adopts a
   *  parked instance). Null = nothing mounted (bridge is bit-transparent). */
  mounted: VstMounted | null;
  /** Last mount failure — cleared by the next successful mount/unmount. */
  mountError: VstMountError | null;
  editorOpen: boolean;
  /** Last `state` reply (base64 plugin state — persistence reads this). */
  pluginState: VstState | null;
  stateSet: VstStateSet | null;
  meters: VstMeters | null;
  rtt: number | null;
  supported: boolean;
}

export type VstBridgeConfigLike = VstBridgeConfig;

type Listener = (s: VstOwnerSnapshot) => void;

interface Entry {
  client: VstBridgeClient;
  snap: VstOwnerSnapshot;
  /** Kept for restart (the manual connect button re-sends the same shape). */
  config: VstBridgeConfig;
}

const IDLE: VstOwnerSnapshot = {
  state: 'idle',
  detail: undefined,
  helper: null,
  plugins: [],
  mounted: null,
  mountError: null,
  editorOpen: false,
  pluginState: null,
  stateSet: null,
  meters: null,
  rtt: null,
  supported: true,
};

const entries = new Map<string, Entry>();

/** View listeners — OUTSIDE `entries`, keyed by node id, so subscribing
 *  before the engine reconciles the node still works (the es9 regression). */
const listeners = new Map<string, Set<Listener>>();

/** Can this environment host the bridge at all? (Node/vitest/ART have no
 *  Worker/SAB; the engine factory calls in unconditionally.) */
export function vstBridgeAvailable(): boolean {
  return typeof Worker === 'function' && typeof SharedArrayBuffer === 'function';
}

function emit(nodeId: string, snap: VstOwnerSnapshot): void {
  const set = listeners.get(nodeId);
  if (!set) return;
  for (const l of set) l(snap);
}

/**
 * Ensure a connection exists for `nodeId` and return its ring specs, or null
 * when the environment can't host one. Idempotent per node: calling again
 * returns the SAME client's rings. Distinct nodes get DISTINCT connections —
 * an instrument card and an fx card in one lane each mount their own plugin.
 */
export function acquireVstBridge(
  nodeId: string,
  sampleRate: number,
  config: VstBridgeConfigLike,
): { inRing: RingSpec; outRing: RingSpec; midiRing: MidiRingSpec } | null {
  if (!vstBridgeAvailable()) return null;
  const existing = entries.get(nodeId);
  if (existing) {
    return {
      inRing: existing.client.inRing,
      outRing: existing.client.outRing,
      midiRing: existing.client.midiRing,
    };
  }

  if (!unloadTeardownInstalled) { installUnloadTeardown(); unloadTeardownInstalled = true; }
  const entry: Entry = {
    client: null as unknown as VstBridgeClient,
    snap: { ...IDLE },
    config,
  };
  entry.client = new VstBridgeClient({
    onState: (state, detail) => {
      entry.snap = {
        ...entry.snap,
        state,
        detail,
        // A non-connected state invalidates the live readouts. The PLUGIN
        // side (mounted/pluginState) is kept: the helper parks the instance
        // and a reconnect adopts it — wiping it would misreport a parked
        // plugin as gone across every reconnect blip.
        ...(state === 'connected' ? {} : { helper: null, rtt: null, meters: null }),
      };
      emit(nodeId, entry.snap);
    },
    onHelperInfo: (helper) => {
      entry.snap = { ...entry.snap, helper };
      emit(nodeId, entry.snap);
    },
    onPluginList: (msg) => {
      entry.snap = { ...entry.snap, plugins: msg.plugins };
      emit(nodeId, entry.snap);
    },
    onMounted: (msg) => {
      entry.snap = { ...entry.snap, mounted: msg, mountError: null };
      emit(nodeId, entry.snap);
    },
    onMountError: (msg) => {
      entry.snap = { ...entry.snap, mountError: msg };
      emit(nodeId, entry.snap);
    },
    onUnmounted: () => {
      entry.snap = { ...entry.snap, mounted: null, mountError: null, editorOpen: false };
      emit(nodeId, entry.snap);
    },
    onEditor: (msg) => {
      entry.snap = { ...entry.snap, editorOpen: msg.open };
      emit(nodeId, entry.snap);
    },
    onPluginState: (msg) => {
      entry.snap = { ...entry.snap, pluginState: msg };
      emit(nodeId, entry.snap);
    },
    onStateSet: (msg) => {
      entry.snap = { ...entry.snap, stateSet: msg };
      emit(nodeId, entry.snap);
    },
    onMeters: (meters) => {
      entry.snap = { ...entry.snap, meters };
      emit(nodeId, entry.snap);
    },
    onRtt: (rtt) => {
      entry.snap = { ...entry.snap, rtt };
      emit(nodeId, entry.snap);
    },
  });
  entry.snap = { ...entry.snap, supported: entry.client.supported };
  entries.set(nodeId, entry);
  if (!entry.client.supported) {
    emit(nodeId, entry.snap);
    return null;
  }
  entry.client.start(sampleRate, config);
  // Tell any early subscriber a connection now exists (see es9 header).
  emit(nodeId, entry.snap);
  return {
    inRing: entry.client.inRing,
    outRing: entry.client.outRing,
    midiRing: entry.client.midiRing,
  };
}

/** Send one card→bridge control message on a node's live connection
 *  (mount/unmount/openEditor/closeEditor/getState/setState/rescanPlugins).
 *  No-op when the node has no connection. */
export function sendVstControl(nodeId: string, msg: Record<string, unknown>): void {
  entries.get(nodeId)?.client.sendControl(msg);
}

/** Tear down `nodeId`'s connection. Called from the ENGINE handle's
 *  `dispose()` — when the node leaves the graph — and NEVER from a
 *  component unmount. */
export function releaseVstBridge(nodeId: string): void {
  const e = entries.get(nodeId);
  if (!e) return;
  entries.delete(nodeId);
  e.client.stop();
  emit(nodeId, vstSnapshot(nodeId));
}

/** Current snapshot for a node — idle/unsupported placeholder when there is
 *  no entry yet (a view can render before the engine reconciles). */
export function vstSnapshot(nodeId: string): VstOwnerSnapshot {
  return entries.get(nodeId)?.snap ?? { ...IDLE, supported: vstBridgeAvailable() };
}

/** Subscribe a VIEW (or the factory's live-state relay). Returns an
 *  unsubscribe that removes the listener and NOTHING else. */
export function subscribeVst(nodeId: string, fn: Listener): () => void {
  let set = listeners.get(nodeId);
  if (!set) { set = new Set(); listeners.set(nodeId, set); }
  set.add(fn);
  fn(vstSnapshot(nodeId));
  return () => {
    const cur = listeners.get(nodeId);
    if (!cur) return;
    cur.delete(fn);
    if (cur.size === 0) listeners.delete(nodeId);
  };
}

/** MANUAL stop / restart for the card's disconnect/connect buttons. These
 *  never create or destroy the owner entry; the rings live on the client,
 *  so a restarted worker resumes against the SAME SharedArrayBuffers the
 *  worklet already holds (see the es9 header's "reconnect but no audio"
 *  note). Restart is also the recovery path from 'evicted'. */
export function stopVstBridge(nodeId: string): void {
  entries.get(nodeId)?.client.stop();
}

export function restartVstBridge(
  nodeId: string,
  sampleRate: number,
  config?: VstBridgeConfigLike,
): void {
  const e = entries.get(nodeId);
  if (!e) {
    // No connection yet (the engine has not reconciled this node, or the
    // user hit CONNECT after a release). "Connect" must CONNECT — silently
    // doing nothing here is half of what made the es9 button look dead.
    // Needs the caller's config, since only the card knows its mode.
    if (config) acquireVstBridge(nodeId, sampleRate, config);
    return;
  }
  if (!e.client.supported) return;
  e.client.stop();
  e.client.start(sampleRate, e.config);
}

/** Is there a live owner entry for this node? (Tests + status lines.) */
export function hasVstBridge(nodeId: string): boolean {
  return entries.has(nodeId);
}

/** Close every connection when the page goes away — the es9 leak lesson
 *  (nine abandoned sockets wedged the bridge). Parked instances make this
 *  cheap here: a clean close parks; the next load adopts. */
function installUnloadTeardown(): void {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  const closeAll = () => {
    for (const id of [...entries.keys()]) releaseVstBridge(id);
  };
  window.addEventListener('pagehide', closeAll);
  window.addEventListener('beforeunload', closeAll);
}
let unloadTeardownInstalled = false;

/** TEST-ONLY: drop every entry. Never called by app code. */
export function __resetVstOwners(): void {
  for (const id of [...entries.keys()]) releaseVstBridge(id);
  listeners.clear();
}
