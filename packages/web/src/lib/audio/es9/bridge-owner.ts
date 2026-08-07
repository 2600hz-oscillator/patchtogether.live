// packages/web/src/lib/audio/es9/bridge-owner.ts
//
// WHO OWNS THE ES-9 CONNECTION — a per-NODE registry that outlives every view.
//
// THE BUG THIS DISSOLVES. `Es9Card.svelte` used to construct the
// `Es9BridgeClient` in an `$effect` and tear it down in `onDestroy`, so the live
// hardware stream's lifetime was the lifetime of a Svelte component. Under
// `?shell=1` the lane may render a compact tile instead of the card, and the
// dock full-view mounts the real card only while its pane is open — so
// collapsing the pane KILLED the stream (owner report 2026-08-05: "ES-9 stops
// sending data until the card is expanded again").
//
// The 2026-08-05 fix bought "always mounted" by making `es9` a
// NON_SHELL_LANE_TYPE, which kept the card in the lane at full size and cost
// BOTH the compact tile and the dock EXPAND affordance. That was the wrong
// trade; this replaces it.
//
// THE RULE, already stated for video in `$lib/ui/workflow/dom-source-modules`:
// **the engine-visible state of a rack must not depend on which UI renders a
// module.** Node registration is graph-driven and already satisfies it. The
// SAB ring source did not. Now it does: the connection is owned per NODE ID,
// created by whoever asks first, and released only when the node's ENGINE
// handle is disposed — i.e. when the node leaves the graph. Mount, unmount,
// dock, collapse, switch to `?shell=1` mid-session: all invisible to it.
//
// WHY A REGISTRY AND NOT `HeadlessSourceHost`. The headless host keeps a real
// card mounted off-screen, which works for `getUserMedia` because two <video>
// elements are merely wasteful. The ES-9 native app accepts a SINGLE client, so
// the expand-time double mount (headless + dock full-view) would wedge the
// bridge on 'busy'. A refcounted single owner has no such failure mode: N views
// attach to ONE client.
//
// WHY NOT DOM-FREE-NESS: `Es9BridgeClient` touches no DOM at all — `Worker` +
// `SharedArrayBuffer`, nothing else. It only ever lived on the card because it
// was modelled on `AudioinCard`, which genuinely needs the DOM for
// `getUserMedia`. That constraint was inherited, not real.

import {
  Es9BridgeClient,
  type Es9BridgeConfig,
  type Es9ConnectionState,
} from './bridge-client';
import type { Es9DeviceInfo, Es9Meters } from './es9-protocol';
import type { RingSpec } from './es9-ring';

/** Everything a VIEW needs to render, and nothing it needs to own. */
export interface Es9OwnerSnapshot {
  state: Es9ConnectionState;
  detail: string | undefined;
  device: Es9DeviceInfo | null;
  meters: Es9Meters | null;
  rtt: number | null;
  /** False when the environment cannot support the bridge at all (no
   *  SharedArrayBuffer — a non-crossOriginIsolated document). Views render the
   *  "unsupported" affordance instead of a dead Connect button. */
  supported: boolean;
}

/** Re-exported rather than re-declared: a second hand-written copy of the
 *  config shape is exactly how a caller ends up passing something the client
 *  silently ignores (the first draft of this file got `outputModes` wrong and
 *  only svelte-check caught it). */
export type Es9BridgeConfigLike = Es9BridgeConfig;

type Listener = (s: Es9OwnerSnapshot) => void;

interface Entry {
  client: Es9BridgeClient;
  snap: Es9OwnerSnapshot;
}

const IDLE: Es9OwnerSnapshot = {
  state: 'idle', detail: undefined, device: null, meters: null, rtt: null, supported: true,
};

const entries = new Map<string, Entry>();

/**
 * VIEW LISTENERS, deliberately kept OUTSIDE `entries` and keyed by node id.
 *
 * ⚠ THE REGRESSION THIS EXISTS TO PREVENT (owner-reported showstopper,
 * 2026-08-07). Listeners used to live ON the entry, so `subscribeEs9` did
 * `entries.get(nodeId)` and RETURNED A NO-OP when there was none. But the CARD
 * mounts when the node spawns and the ENGINE FACTORY creates the entry later,
 * through the reconciler — so in the real ordering the view ALWAYS subscribes
 * first, always found nothing, and never subscribed at all. The card sat frozen
 * on its initial `idle` snapshot while the bridge behind it connected happily:
 * "clicking connect does nothing, no console errors, no connection."
 *
 * Keeping the listener set independent of the entry's lifetime means a view can
 * subscribe before, during or after the connection exists, and in every case
 * receives the current snapshot immediately and every update after it. Which is
 * the entire premise of this module — the connection outlives the view, so the
 * view must also be allowed to outlive (and pre-date) the connection.
 */
const listeners = new Map<string, Set<Listener>>();

/**
 * Can this environment host the bridge at all? `Es9BridgeClient` needs a real
 * `Worker` and a `SharedArrayBuffer`; a Node/vitest/ART context has neither, and
 * the ENGINE FACTORY now calls into here, so an unguarded construction would
 * break every headless harness that merely instantiates the module. Checked
 * here rather than at each call site so there is one answer.
 */
export function es9BridgeAvailable(): boolean {
  return typeof Worker === 'function' && typeof SharedArrayBuffer === 'function';
}

function emit(nodeId: string, snap: Es9OwnerSnapshot): void {
  const set = listeners.get(nodeId);
  if (!set) return;
  for (const l of set) l(snap);
}

/**
 * Ensure a connection exists for `nodeId` and return its ring specs, or null
 * when the environment can't host one. Idempotent: calling it again returns the
 * SAME client's rings rather than opening a second connection — which is the
 * whole point, since the native app accepts one client.
 *
 * `sampleRate` and `config` are only honoured on the call that actually creates
 * the entry; a later caller gets the existing connection. Use `updateConfig` to
 * change a live one.
 */
export function acquireEs9Bridge(
  nodeId: string,
  sampleRate: number,
  config: Es9BridgeConfigLike,
): { inRing: RingSpec; outRing: RingSpec } | null {
  if (!es9BridgeAvailable()) return null;
  const existing = entries.get(nodeId);
  if (existing) return { inRing: existing.client.inRing, outRing: existing.client.outRing };

  if (!unloadTeardownInstalled) { installUnloadTeardown(); unloadTeardownInstalled = true; }
  const entry: Entry = {
    client: null as unknown as Es9BridgeClient,
    snap: { ...IDLE },
  };
  entry.client = new Es9BridgeClient({
    onState: (state, detail) => {
      entry.snap = {
        ...entry.snap,
        state,
        detail,
        // A non-connected state invalidates the device + round-trip readout;
        // leaving stale values on screen would misreport a dead bridge as live.
        ...(state === 'connected' ? {} : { device: null, rtt: null }),
      };
      emit(nodeId, entry.snap);
    },
    onDeviceInfo: (device) => { entry.snap = { ...entry.snap, device }; emit(nodeId, entry.snap); },
    onMeters: (meters) => { entry.snap = { ...entry.snap, meters }; emit(nodeId, entry.snap); },
    onRtt: (rtt) => { entry.snap = { ...entry.snap, rtt }; emit(nodeId, entry.snap); },
  });
  entry.snap = { ...entry.snap, supported: entry.client.supported };
  entries.set(nodeId, entry);
  if (!entry.client.supported) {
    emit(nodeId, entry.snap);
    return null;
  }
  entry.client.start(sampleRate, config);
  // Tell any view that subscribed BEFORE this node reconciled that a connection
  // now exists. Without this an early subscriber waits for the first transport
  // callback — which may be slow, or never arrive if the worker cannot reach
  // the bridge — and meanwhile shows a stale idle state it has no way to leave.
  emit(nodeId, entry.snap);
  return { inRing: entry.client.inRing, outRing: entry.client.outRing };
}

/** Push a new channel/mode config to a LIVE connection (the card's class
 *  selectors). No-op when the node has no connection. */
export function updateEs9Config(nodeId: string, config: Es9BridgeConfigLike): void {
  entries.get(nodeId)?.client.updateConfig(config);
}

/**
 * Tear down `nodeId`'s connection. Called from the ENGINE handle's `dispose()`
 * — i.e. when the node leaves the graph — and NEVER from a component unmount,
 * which is the entire fix.
 */
export function releaseEs9Bridge(nodeId: string): void {
  const e = entries.get(nodeId);
  if (!e) return;
  entries.delete(nodeId);
  e.client.stop();
  // Listeners are NOT cleared: a view may still be mounted (and may outlive the
  // node by a frame). Tell it the connection is gone rather than leaving the
  // last live snapshot on screen, which would misreport a dead bridge as up.
  emit(nodeId, es9Snapshot(nodeId));
}

/** Current snapshot for a node — `idle`/unsupported placeholder when there is
 *  no entry yet (a view can render before the engine reconciles). */
export function es9Snapshot(nodeId: string): Es9OwnerSnapshot {
  return entries.get(nodeId)?.snap ?? { ...IDLE, supported: es9BridgeAvailable() };
}

/** Subscribe a VIEW. Returns an unsubscribe. Unsubscribing removes the
 *  listener and NOTHING else — the connection is untouched, which is what lets
 *  a card mount and unmount freely. */
export function subscribeEs9(nodeId: string, fn: Listener): () => void {
  let set = listeners.get(nodeId);
  if (!set) { set = new Set(); listeners.set(nodeId, set); }
  set.add(fn);
  // Deliver the CURRENT state immediately — `es9Snapshot` answers for an
  // unknown node too, so a view that mounts before the engine reconciles gets a
  // sane idle snapshot now and the real one the moment the connection appears.
  fn(es9Snapshot(nodeId));
  return () => {
    const cur = listeners.get(nodeId);
    if (!cur) return;
    cur.delete(fn);
    if (cur.size === 0) listeners.delete(nodeId);
  };
}

/**
 * MANUAL stop / restart for the card's disconnect+connect buttons.
 *
 * These do NOT create or destroy the owner entry — the node still owns the
 * connection either way, so pressing "disconnect" and then unmounting the card
 * does not orphan anything, and pressing "connect" from a freshly-mounted card
 * reaches the same client.
 *
 * SAFE ACROSS A RESTART because the RINGS live on the client, not on the
 * worker: `stop()` only terminates the worker and nulls it, so `start()` brings
 * a new worker up against the SAME SharedArrayBuffers the worklet is already
 * reading. That is why the engine node does not need to be re-handed its rings
 * after a manual reconnect — a detail worth stating, because getting it wrong
 * would look like "reconnect succeeds but there is no audio".
 */
export function stopEs9Bridge(nodeId: string): void {
  entries.get(nodeId)?.client.stop();
}

export function restartEs9Bridge(
  nodeId: string,
  sampleRate: number,
  config: Es9BridgeConfigLike,
): void {
  const e = entries.get(nodeId);
  if (!e) {
    // No connection yet (the engine has not reconciled this node, or the user
    // hit CONNECT after a release). "Connect" must CONNECT — silently doing
    // nothing here is half of what made the button look dead.
    acquireEs9Bridge(nodeId, sampleRate, config);
    return;
  }
  if (!e.client.supported) return;
  e.client.stop();
  e.client.start(sampleRate, config);
}

/** Is there a live owner for this node? (Tests + the card's status line.) */
export function hasEs9Bridge(nodeId: string): boolean {
  return entries.has(nodeId);
}

/**
 * CLOSE EVERY CONNECTION WHEN THE PAGE GOES AWAY.
 *
 * ⚠ THE SHOWSTOPPER THIS FIXES (owner-reported 2026-08-07: "clicking connect
 * does nothing, no console errors, no connection", with the bridge running).
 *
 * Measured on the owner's machine: the es9-bridge process was holding NINE
 * leaked sockets (`lsof -iTCP:9209` → FDs 5-13, all CLOSED, never reaped). The
 * app accepts a SINGLE client, so it answered `busy` to everything — forever,
 * until restarted. `busy` is a normal state and not an error, which is exactly
 * why the console was clean.
 *
 * WE CAUSED THE CHURN. Before ownership moved onto the engine node, the card's
 * `onDestroy` called `disconnect()`, so a socket was closed on every unmount —
 * view change, dock collapse, navigation. Now teardown runs only from the
 * engine handle's `dispose()`, i.e. when the node leaves the GRAPH — and a page
 * reload never does that. So each page load opened a connection and abandoned
 * it, and roughly nine loads wedged the bridge.
 *
 * `pagehide` is the right event (it fires for bfcache and mobile tab-kill where
 * `beforeunload` does not); both are registered because neither is guaranteed
 * on every path, and a double close is harmless — `stop()` is idempotent.
 *
 * This does NOT make us dependent on the app reaping FDs correctly: a clean
 * WebSocket close is simply the contract we owe a single-client server.
 */
function installUnloadTeardown(): void {
  // ⚠ CAPABILITY CHECK, NOT AN ENVIRONMENT GUESS. `typeof window === 'undefined'`
  // was not enough: the unit lane provides a PARTIAL `window` with no
  // `addEventListener`, so the guard passed and the call threw. Probe for the
  // thing actually being used.
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  const closeAll = () => {
    for (const id of [...entries.keys()]) releaseEs9Bridge(id);
  };
  window.addEventListener('pagehide', closeAll);
  window.addEventListener('beforeunload', closeAll);
}
let unloadTeardownInstalled = false;

/** TEST-ONLY: drop every entry. Never called by app code. */
export function __resetEs9Owners(): void {
  for (const id of [...entries.keys()]) releaseEs9Bridge(id);
  listeners.clear();
}
