// packages/web/src/lib/ui/modules/manual-strike-actions.ts
//
// THE AUDITION SEAM — "make this voice sound with nothing patched into it" —
// as ONE implementation for every externally-struck voice in the rack, in BOTH
// of the edge shapes the repo's own vocabulary already distinguishes.
//
// An externally-struck voice has no internal exciter: with nothing patched into
// its strike input it is SILENT, on the lane tile and in the RACKLINE dock
// alike. kickdrum, karplus, snaredrum, sixstrum and samsloop all answer the SAME
// engine read keys, so the host side of "audition it" is not per-module
// behaviour — it is these functions and a nodeId.
//
// TWO SHAPES, BECAUSE THE PORTS HAVE TWO SHAPES:
//
//   STRIKE → read key `manualTrigger`, a `() => void`.
//            ONE hit per call. Drives a port declared `edge: 'trigger'`.
//            kickdrum STRIKE, karplus PLUCK, snaredrum HIT.
//   GATE   → read key `manualGate`, a `(high: boolean) => void`.
//            Runs WHILE high. Drives a port declared `edge: 'gate'`.
//            snaredrum ROLL (the two-hand roll engine).
//
// ⚠ THE HISTORY, BECAUSE IT IS THE WHOLE ARGUMENT FOR THIS FILE'S SHAPE.
// This was `kickdrum-strike-actions.ts`; karplus renamed it (already generic —
// same key, same resolver, same wiring). IN PARALLEL snaredrum landed its own
// `snaredrum-strike-actions.ts` + `snaredrum-roll-latch.ts`, because it needed
// the HELD shape and this file modelled only the one-shot. The result was two
// modules whose one-shot halves were identical down to the read-key STRING
// (`SNAREDRUM_HIT_KEY === MANUAL_STRIKE_KEY === 'manualTrigger'`) — a copy, not
// a variant — plus a genuinely-new held gate stranded behind a module-named
// import. Merged here, deliberately, on this reasoning:
//
//   1. A held audition is NOT a snaredrum concept. It is the repo's second edge
//      semantic, already modelled on BOTH sides of this layer:
//      `PortDef.edge: 'trigger' | 'gate'` below it and
//      `ShellActionCell.mode: 'trigger' | 'gate'` above it. A seam that carries
//      only the trigger shape is strictly less expressive than the layers it
//      sits between, so a gate audition can only ever be implemented in a
//      module-named file. THAT is the duplication generator, and it would have
//      fired again: adsr's `manualGate` is already queued.
//   2. The held machinery is FREE to a one-shot module. `ensurePanicListeners()`
//      is called only from the `high` branch of `setManualGate`, so a module
//      that never opens a gate installs zero listeners and pays one empty array.
//   3. There is now exactly ONE import target. A thin re-export shim would have
//      left two, which is precisely how this started.
//
// Neither shape is a PARAM. They write nothing to the graph — no value moves,
// nothing is persisted, nothing is shared with the rackspace, nothing lands in
// the undo stack — each fires a host-side ConstantSource summed into the SAME
// worklet input a cable feeds (each module's factory). So the audible effect is
// identical to a patched sequencer, and a real cable keeps working alongside it.
//
// SPLIT DELIBERATELY:
//   * `resolveManualStrike` / `resolveManualGate` are PURE over their injected
//     engine + node — no store, no globals, no DOM — so the interesting half
//     (which of the ways this can be unavailable actually returns null) is
//     unit-testable without a browser or an AudioContext;
//   * `manual-gate-latch.ts` is the PURE held-gate state machine (see its
//     header for why a boolean was not enough);
//   * `fireManualStrike` / `setManualGate` / `panicManualGates` are the thin
//     process-wide wiring the shell cells call.
//
// `getActiveEngine()` rather than the Svelte engine CONTEXT, because
// shell-cells.ts specs are plain data called from ModuleShell — they are not
// components and cannot `getContext`. Reading the engine at the moment of the
// press is exactly right: that is when a non-null engine is required.
//
// The caller↔seam wiring itself is pinned by `manual-strike-wiring.test.ts`,
// which drives the REAL shell-cell registry and asserts each audition cell's
// declared `mode` matches the read key it actually reaches.

import { getActiveEngine } from '$lib/audio/engine-ref';
import {
  momentaryRest,
  stuckMomentaryIds,
  type MomentaryDefLike,
} from '$lib/audio/momentary-params';
import { setNodeParam } from '$lib/graph/mutate';
import { patch } from '$lib/graph/store';
import type { ModuleNode } from '$lib/graph/types';
import { recordAudition } from './audition-ledger';
import {
  closeGate,
  emptyGateLatch,
  openGate,
  panicGates,
  type GateLatchState,
} from './manual-gate-latch';

/** The `read(node, key)` half of a PatchEngine — all this seam needs. */
export interface StrikeEngineLike {
  read(node: ModuleNode, key: string): unknown;
}

/** The read key a struck voice's factory answers with a ONE-SHOT firing. */
export const MANUAL_STRIKE_KEY = 'manualTrigger';
/** The read key a struck voice's factory answers with a HELD-GATE setter. */
export const MANUAL_GATE_KEY = 'manualGate';

/**
 * Resolve a callable off the node's engine handle, or `null` when the audition
 * is genuinely unavailable. THREE branches, each a real state:
 *   * no engine (the AudioContext has not booted — nothing can sound yet);
 *   * no node (the module was removed between render and press);
 *   * the handle answers the read key with something that is not callable —
 *     a half-implemented seam (a number), or no `read` at all (`undefined`).
 *     ⚠ Those last two are ONE branch, not two: both fall through the same
 *     `typeof fn === 'function'` guard. The doc used to call them distinct and
 *     the test listed "the FOUR distinct unavailable states", which reads as
 *     more coverage than the code has.
 *
 * Returning null rather than throwing is deliberate: an audition that cannot
 * fire is a no-op, never an error dialog over a rack. PURE — the engine and
 * node are injected, so the resolution is testable with fakes.
 */
function resolveKey<T>(
  engine: StrikeEngineLike | null | undefined,
  node: ModuleNode | undefined,
  key: string,
): T | null {
  if (!engine || !node) return null;
  const fn = engine.read(node, key);
  return typeof fn === 'function' ? (fn as T) : null;
}

/** The node's ONE-SHOT strike function, or null (see `resolveKey`). PURE. */
export function resolveManualStrike(
  engine: StrikeEngineLike | null | undefined,
  node: ModuleNode | undefined,
): (() => void) | null {
  return resolveKey<() => void>(engine, node, MANUAL_STRIKE_KEY);
}

/**
 * The node's HELD-GATE setter — `(high: boolean) => void` — or null on the same
 * three unavailable states. SEPARATE KEY from the strike, and it must stay
 * separate: a handle that implements only the one-shot must NOT silently answer
 * the gate, because a gate that opens and never closes is the worst failure this
 * seam has (manual-gate-latch.ts). PURE.
 */
export function resolveManualGate(
  engine: StrikeEngineLike | null | undefined,
  node: ModuleNode | undefined,
): ((high: boolean) => void) | null {
  return resolveKey<(high: boolean) => void>(engine, node, MANUAL_GATE_KEY);
}

/**
 * Fire ONE strike at the live node — the action every surface calls through
 * (a module's shell `action` cell). Silently does
 * nothing when the audition is unavailable (see `resolveKey`). Returns whether a
 * strike actually fired, so a caller can drive a press flash off the truth
 * instead of off the click.
 */
export function fireManualStrike(nodeId: string): boolean {
  const node = patch.nodes[nodeId] as ModuleNode | undefined;
  const strike = resolveManualStrike(getActiveEngine(), node);
  if (!strike) {
    // ⚠ RECORDED, NOT SILENT. `delivered: false` is the state the whole
    // action-cell probe turns on: "pressed and reached nothing" must be
    // distinguishable from "never pressed", and returning early without a
    // record would collapse them (audition-ledger.ts).
    recordAudition({ nodeId, seam: 'manual-strike', delivered: false });
    return false;
  }
  strike();
  recordAudition({ nodeId, seam: 'manual-strike', delivered: true });
  return true;
}

// ── The HELD GATE, and its leak guard ───────────────────────────────────────
//
// Module-scope, process-wide, because the thing being tracked IS process-wide:
// a ConstantSource in the live audio graph. The pure reducer owns the
// bookkeeping; everything below is the impure edge (the engine call + the
// window listeners that catch a release the button never saw).

let gateLatch: GateLatchState = emptyGateLatch();
/** The PRESS-PARAM latch. Same pure reducer, a second instance, keyed by
 *  `${nodeId}\u0000${paramId}` — see `setMomentaryParam` for why this is a
 *  separate latch rather than a shared one with encoded keys. */
let pressLatch: GateLatchState = emptyGateLatch();
let panicInstalled = false;

/** Close ONE node's gate on the engine, ignoring an already-gone handle. */
function closeOnEngine(nodeId: string): void {
  const node = patch.nodes[nodeId] as ModuleNode | undefined;
  const setGate = resolveManualGate(getActiveEngine(), node);
  try { setGate?.(false); } catch { /* the handle went away with the node */ }
}

/**
 * Close EVERY open audition gate AND release every held press-pad — the panic
 * path. Exported so a test (and a future teardown) can invoke it directly
 * rather than synthesizing DOM events. Returns the keys it closed: bare node
 * ids for gates, `${nodeId} ${paramId}` for press-pads.
 */
export function panicManualGates(): string[] {
  const p = panicGates(gateLatch);
  gateLatch = p.state;
  for (const id of p.closed) closeOnEngine(id);
  const pp = panicGates(pressLatch);
  pressLatch = pp.state;
  for (const key of pp.closed) releasePressOnEngine(key);
  return [...p.closed, ...pp.closed];
}

/**
 * Install the window-level release listeners ONCE, lazily (never at import:
 * this module is imported by shell-cells.ts, which the unit lane loads in a
 * node environment with no `window`). Lazily ALSO means a rack with no held
 * audition in it never installs anything at all.
 *
 * WHY THESE FOUR. `<Button>` captures the pointer, so an ordinary release
 * always reaches it — but pointer capture protects a MOVING pointer, not a
 * DELETED element. Close the dock, delete the module, or hide the tab mid-hold
 * and the button unmounts with the gate still open and the module never stops.
 * The node's own `dispose()` covers deletion; these cover the rest.
 */
function ensurePanicListeners(): void {
  if (panicInstalled) return;
  // ⚠ FEATURE-DETECT, don't existence-check. `typeof window === 'undefined'`
  // is NOT enough: the unit lane runs 630 files in one process and some of them
  // leave a PARTIAL `window` stub behind, so this threw `addEventListener is
  // not a function` in the full sweep while passing when the file ran alone.
  // A guard that is right only in isolation is not a guard.
  const w = typeof window === 'undefined' ? undefined : window;
  if (typeof w?.addEventListener !== 'function') return;
  panicInstalled = true;
  const panic = () => { panicManualGates(); };
  w.addEventListener('pointerup', panic);
  w.addEventListener('pointercancel', panic);
  w.addEventListener('blur', panic);
  const d = typeof document === 'undefined' ? undefined : document;
  if (typeof d?.addEventListener === 'function') {
    d.addEventListener('visibilitychange', () => {
      if (d.visibilityState === 'hidden') panic();
    });
  }
}

/**
 * Open (high) or close (low) the node's HELD audition gate — the action both
 * surfaces call (a module's `mode:'gate'` shell cell). Returns whether an edge
 * was actually sent to the engine:
 * `false` means either the audition is unavailable OR the latch already held
 * that state, and in both cases nothing was scheduled.
 */
export function setManualGate(nodeId: string, high: boolean): boolean {
  const node = patch.nodes[nodeId] as ModuleNode | undefined;
  const setGate = resolveManualGate(getActiveEngine(), node);
  const record = (delivered: boolean) =>
    recordAudition({ nodeId, seam: 'manual-gate', high, delivered });
  if (!setGate) {
    // The audition cannot run — but if the latch thinks this node is open,
    // forget it, or a later panic would try to close a gate that never opened.
    if (!high) gateLatch = closeGate(gateLatch, nodeId).state;
    record(false);
    return false;
  }
  if (high) {
    ensurePanicListeners();
    const r = openGate(gateLatch, nodeId);
    gateLatch = r.state;
    if (!r.opened) {
      record(false);
      return false;
    }
    setGate(true);
    record(true);
    return true;
  }
  const r = closeGate(gateLatch, nodeId);
  gateLatch = r.state;
  if (!r.closed) {
    record(false);
    return false;
  }
  setGate(false);
  record(true);
  return true;
}

// ── THE PRESS-PARAM PAD, and why it lives here ──────────────────────────────
//
// A `face.momentary` pad (tomtom STRIKE, tidyVco HOLD) is the THIRD audition
// shape, and until 2026-08-02 it was the only one that wrote to the Y.Doc.
// Both cards and ModuleShell did `setNodeParam(id, pid, 1)` on press and `…, 0`
// on release, on the stated reasoning that "the release always writes REST
// back, so nothing latched survives". The release is not guaranteed — pointer
// capture protects a MOVING pointer, not a DELETED element — and the value it
// leaves behind is DURABLE: it saves, it syncs, it survives reload, and on
// tomtom it masks `trigger_in` permanently (see $lib/audio/momentary-params).
//
// The `manualGate` seam ten lines up has never had that failure mode, for one
// reason: it writes no param at all. So the press pad adopts the same
// discipline rather than inventing a fourth one — the ENGINE gets the value,
// the graph gets nothing, and the same window-level panic listeners that catch
// a lost gate release catch a lost press release.
//
// ⚠ A SEPARATE LATCH, deliberately. `manual-gate-latch.ts`'s header states the
// constraint it was written under: "THE LATCH KEY IS THE NODE ID, so a module
// gets exactly ONE held audition… a module that genuinely needs two must key
// this by node+read-key". A press pad IS a second held thing on the same node
// (tidyVco has both a `hold` pad and, in principle, a gate audition), so
// sharing one latch would alias them and the second pad would steal the
// first's release. Two instances of the same pure reducer, one panic path over
// both — no key encoding, no ambiguity, and `panicGates` stays exactly as
// tested.

/** Latch key for a press-pad. A space is safe: param ids are identifiers. */
function pressKey(nodeId: string, paramId: string): string {
  return `${nodeId} ${paramId}`;
}

/** Push a value straight at the node's AudioParam. Returns whether it landed —
 *  `false` when the engine or the node is gone, which is a no-op, never an
 *  error over a rack. */
function pushParamOnEngine(nodeId: string, paramId: string, value: number): boolean {
  const engine = getActiveEngine();
  const node = patch.nodes[nodeId] as ModuleNode | undefined;
  if (!engine || !node) return false;
  try {
    (engine as unknown as { setParam(n: ModuleNode, p: string, v: number): void })
      .setParam(node, paramId, value);
    return true;
  } catch {
    return false;
  }
}

/** The rest value a press-pad returns to, resolved from the LIVE def rather
 *  than assumed to be 0 — the same source `momentaryValue(high, defaultValue)`
 *  reads on the render side. Cached per key at press time so the release can
 *  restore it without re-resolving a def that may have gone. */
const pressRest = new Map<string, number>();

/** Release ONE press-pad on the engine (the panic path's per-key close). */
function releasePressOnEngine(key: string): void {
  const sep = key.lastIndexOf(' ');
  if (sep < 0) return;
  const nodeId = key.slice(0, sep);
  const paramId = key.slice(sep + 1);
  pushParamOnEngine(nodeId, paramId, pressRest.get(key) ?? 0);
  pressRest.delete(key);
}

/**
 * Press (`high`) or release a MOMENTARY param pad. Writes the ENGINE ONLY —
 * nothing reaches the Y.Doc, so nothing persists, nothing syncs and nothing
 * lands on the undo stack. The pad's own lit state is LOCAL to the surface
 * that owns the finger, which is what it always was in substance.
 *
 * `restValue` is where the pad sits released — the param's `defaultValue`,
 * passed in by the caller that already has the ParamDef.
 *
 * Returns whether an edge actually reached the engine: `false` means either
 * the engine/node was unavailable OR the latch already held that state, and in
 * both cases nothing was scheduled (a repeated pointerdown from keyboard
 * auto-repeat must not re-fire a strike).
 *
 * ⚠ AND IT RECORDS, ON BOTH EDGES. Writing the engine only is what makes this
 * seam safe, and it is ALSO what makes it invisible: `readParam` returns null
 * for a param that never reaches the Y.Doc, so every graph-shaped oracle is now
 * structurally blind to a press-pad — exactly the position the `action` cell was
 * in before the ledger existed (audition-ledger.ts). The release edge is the
 * dangerous half: with the param permanently absent, faces-parity's
 * `readParam(…) ?? rest → toBe(rest)` release check reduced to `rest === rest`,
 * so the headline "a momentary pad must not latch" assertion became
 * unconditionally true the moment this function stopped writing. Both edges are
 * recorded so both legs can fail again.
 */
export function setMomentaryParam(
  nodeId: string,
  paramId: string,
  high: boolean,
  restValue = 0,
): boolean {
  const key = pressKey(nodeId, paramId);
  const record = (delivered: boolean) =>
    recordAudition({ nodeId, seam: 'manual-press', paramId, high, delivered });
  if (high) {
    ensurePanicListeners();
    const r = openGate(pressLatch, key);
    pressLatch = r.state;
    if (!r.opened) {
      record(false);
      return false;
    }
    pressRest.set(key, restValue);
    if (!pushParamOnEngine(nodeId, paramId, 1)) {
      // The engine was not there to take it — forget the latch entry, or a
      // later panic would "release" a pad that never pressed.
      pressLatch = closeGate(pressLatch, key).state;
      pressRest.delete(key);
      record(false);
      return false;
    }
    record(true);
    return true;
  }
  const r = closeGate(pressLatch, key);
  pressLatch = r.state;
  if (!r.closed) {
    record(false);
    return false;
  }
  pressRest.delete(key);
  const landed = pushParamOnEngine(nodeId, paramId, restValue);
  record(landed);
  return landed;
}

/**
 * REPAIR a node whose press-pads were persisted stuck — the other half of the
 * fix, for racks saved BEFORE presses stopped being durable.
 *
 * `AudioEngine.addNode` already refuses to APPLY such a value, so the module
 * works again on the next load without this; what this adds is removing the
 * dead value from the document, so a re-save is clean and no future reader can
 * be misled by it. One origin-tagged transaction, and deliberately NOT on the
 * undo stack: repairing corrupt state is not a user edit, and a Cmd-Z that
 * restores `strike: 1` would re-brick the module.
 *
 * Returns the ids it repaired (empty for the overwhelmingly common no-op), so
 * a caller can log a repair rather than perform one invisibly.
 */
export function clearStuckMomentaryParams(
  nodeId: string,
  def: MomentaryDefLike | undefined,
): string[] {
  const node = patch.nodes[nodeId] as ModuleNode | undefined;
  const stuck = stuckMomentaryIds(def, node?.params);
  for (const paramId of stuck) {
    setNodeParam(nodeId, paramId, momentaryRest(def, paramId), { origin: REPAIR_ORIGIN });
  }
  return stuck;
}

/** Transaction origin for the repair above. NOT `LOCAL_ORIGIN`: the
 *  UndoManager tracks only that one, so an untracked origin keeps a
 *  data-integrity repair out of the user's undo history. */
const REPAIR_ORIGIN = Symbol('momentary-param-repair');

/** TEST SEAM: forget all latch state (and the once-only listener install)
 *  without touching the engine. Never called from app code. */
export function __resetManualGateLatch(): void {
  gateLatch = emptyGateLatch();
  pressLatch = emptyGateLatch();
  pressRest.clear();
  panicInstalled = false;
}
