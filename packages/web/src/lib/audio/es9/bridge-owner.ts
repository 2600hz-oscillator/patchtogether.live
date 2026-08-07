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
  listeners: Set<Listener>;
}

const IDLE: Es9OwnerSnapshot = {
  state: 'idle', detail: undefined, device: null, meters: null, rtt: null, supported: true,
};

const entries = new Map<string, Entry>();

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

function emit(e: Entry): void {
  for (const l of e.listeners) l(e.snap);
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

  const entry: Entry = {
    client: null as unknown as Es9BridgeClient,
    snap: { ...IDLE },
    listeners: new Set(),
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
      emit(entry);
    },
    onDeviceInfo: (device) => { entry.snap = { ...entry.snap, device }; emit(entry); },
    onMeters: (meters) => { entry.snap = { ...entry.snap, meters }; emit(entry); },
    onRtt: (rtt) => { entry.snap = { ...entry.snap, rtt }; emit(entry); },
  });
  entry.snap = { ...entry.snap, supported: entry.client.supported };
  entries.set(nodeId, entry);
  if (!entry.client.supported) {
    emit(entry);
    return null;
  }
  entry.client.start(sampleRate, config);
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
  e.listeners.clear();
  e.client.stop();
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
  const e = entries.get(nodeId);
  if (!e) return () => {};
  e.listeners.add(fn);
  fn(e.snap);
  return () => { e.listeners.delete(fn); };
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
  if (!e || !e.client.supported) return;
  e.client.stop();
  e.client.start(sampleRate, config);
}

/** Is there a live owner for this node? (Tests + the card's status line.) */
export function hasEs9Bridge(nodeId: string): boolean {
  return entries.has(nodeId);
}

/** TEST-ONLY: drop every entry. Never called by app code. */
export function __resetEs9Owners(): void {
  for (const id of [...entries.keys()]) releaseEs9Bridge(id);
}
