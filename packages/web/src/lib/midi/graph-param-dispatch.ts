// packages/web/src/lib/midi/graph-param-dispatch.ts
//
// #1727 — THE GRAPH-RESOLVED DELIVERY PATH FOR AN INBOUND MIDI MESSAGE.
//
// ── THE DEFECT THIS EXISTS FOR ──────────────────────────────────────────────
// A MIDI binding is persisted, keyed `nodeId:paramId`. Its SETTER was not: every
// control registered one in `onMount` and dropped it in `onDestroy`, and
// dispatch fired only where "binding present" and "setter registered"
// intersected. On the DEFAULT shell an un-migrated module renders as
// <ModuleShellPlaceholder>, which mounts no param control at all — so a binding
// to any module outside STRICT_FACES survived, exported, round-tripped through
// localStorage, showed the bound badge, and DELIVERED NOTHING. Worse than
// inert: the param LATCHED at whatever the hardware last successfully wrote
// (measured in `e2e/tests/midi-binding-node-lifetime.spec.ts` — 0.5039… before
// and after a full-scale CC, with `injected=true` and the binding present).
//
// The trigger is not "the user collapsed something", either. The dock holds
// MAX_FULLVIEW_PANES panes, so expanding a THIRD module evicts the first — the
// bound module goes silent with no user action against it at all.
//
// ── THE SHAPE, AND WHY IT IS NOT A REGISTRY ─────────────────────────────────
// The sibling fixes in this family (#1531 projector, #1574/#1729 recorderbox)
// are NODE-KEYED REGISTRIES: a resource with a real lifetime is re-keyed from
// the card to the graph and swept against `liveNodeIds`, and the structural
// guard is that the registry has no teardown method for a card to call.
//
// A MIDI setter is not a resource. It is a pure FUNCTION OF (live node, param
// def) — the node's domain says which engine to poke, and the def says the
// range. There is nothing to own, so there is nothing to lease: the right shape
// is to RESOLVE AT DISPATCH TIME rather than to hold anything at all. That is
// strictly stronger than a registry here, because it removes the lifetime
// instead of relocating it.
//
// The structural guard follows from that and is asserted in the test beside
// this file: THIS MODULE EXPORTS NO register / unregister / dispose / release.
// There is no handle to hold and therefore nothing a view can revoke. A control
// that mounts is an OPTIMISATION (it owns the on-screen visual and any bespoke
// commit), never the delivery path's licence to exist.
//
// ── WHAT IT DELIBERATELY DOES NOT COVER ─────────────────────────────────────
//   * A `paramId` that is NOT a declared `ParamDef` — TOYBOX's layer-qualified
//     ids, and any card-local pseudo-param. `resolveCcTarget` returns null and
//     delivery DECLINES rather than inventing a graph key. Asserted, both
//     directions, in graph-param-dispatch.test.ts.
//   * A NOTE bound to a card BUTTON (a synthetic action id such as 'play').
//     An action is not a graph write; making those node-scoped needs an action
//     registry, which is the #1531-family shape and a separate design pass.
//     NOTE bindings on gate INPUT PORTS are covered here, and are additionally
//     already safe on every lane render because <PatchPanel> — which registers
//     those gate setters — mounts in ModuleShell AND ModuleShellPlaceholder.
//   * The RANGE a mounted control uses. This path reads the DEF, which is the
//     single source of truth the repo standard requires; a card that re-typed
//     different numbers next to its knob would deliver a different value while
//     mounted. That divergence is a card bug (the ±0.2-vs-±1 class), visible to
//     no runtime gate, and is not created or hidden here.

import { patch } from '$lib/graph/store';
import { setNodeParam } from '$lib/graph/mutate';
import { getModuleDef } from '$lib/audio/module-registry';
import { getVideoModuleDef } from '$lib/video/module-registry';
import { getMetaModuleDef } from '$lib/meta/module-registry';
import { getActiveEngine } from '$lib/audio/engine-ref';
import { createCcCommit, type CcCommit } from '$lib/ui/controls/cc-commit';
import { getCcBatcher } from '$lib/ui/controls/cc-batch-store';
import { shellParamWrite } from '$lib/ui/workflow/shell-param-writes';
import { notifyAutomationTouch, notifyAutomationRelease } from '$lib/audio/automation-touch';
import type { ModuleNode, ParamDef, PortDef } from '$lib/graph/types';

/** The three-registry def lookup every consumer of a raw `node.type` does
 *  (Canvas, PatchPanel, ModuleShell, snapshot, …). Kept local rather than
 *  importing a barrel: this module must not force every module def into
 *  midi-learn's import graph. */
function defFor(type: string):
  | { params?: readonly ParamDef[]; inputs?: readonly PortDef[] }
  | undefined {
  return (getModuleDef(type) ?? getVideoModuleDef(type) ?? getMetaModuleDef(type)) as
    | { params?: readonly ParamDef[]; inputs?: readonly PortDef[] }
    | undefined;
}

/** The live node, or undefined. Read through the LIVE `patch` ESM binding —
 *  `bindRackspace()` reassigns it, so it must never be captured. */
function liveNode(nodeId: string): ModuleNode | undefined {
  return patch?.nodes?.[nodeId] as ModuleNode | undefined;
}

/** A CC-deliverable target: the DEF's declared range for `paramId` on the live
 *  node `nodeId`. Null when the node is absent, its type resolves to no def, or
 *  the param is not declared (a card-local pseudo-param). PURE. */
export function resolveCcTarget(
  nodeId: string,
  paramId: string,
): { min: number; max: number; moduleType: string } | null {
  const node = liveNode(nodeId);
  if (!node) return null;
  return resolveCcTargetForType(node.type, paramId);
}

/** The type-level half of `resolveCcTarget`, so the registry-wide coverage gate
 *  can assert it without standing a graph up. PURE. */
export function resolveCcTargetForType(
  moduleType: string,
  paramId: string,
): { min: number; max: number; moduleType: string } | null {
  const pd = defFor(moduleType)?.params?.find((p) => p.id === paramId);
  if (!pd) return null;
  return { min: pd.min, max: pd.max, moduleType };
}

/** A NOTE-deliverable target: `portId` is a declared `gate`-cabled INPUT of the
 *  live node. Null otherwise (an output, a non-gate port, a card action id).
 *  PURE. */
export function resolveGateTarget(nodeId: string, portId: string): { moduleType: string } | null {
  const node = liveNode(nodeId);
  if (!node) return null;
  const port = defFor(node.type)?.inputs?.find((p) => p.id === portId);
  if (!port || port.type !== 'gate') return null;
  return { moduleType: node.type };
}

/**
 * Split a binding key back into `(moduleId, paramId)`.
 *
 * ⚠ ANCHORED ON THE LIVE GRAPH, not on a delimiter guess. `bindingKey()` joins
 * with ':' and neither half is guaranteed to be ':'-free, so "split on the
 * first colon" is a rule about a string rather than about the thing the string
 * names. Matching against real node ids (longest wins) makes the answer a fact
 * about the graph — and a key whose node has left the graph correctly resolves
 * to null, because there is nothing left to deliver to.
 */
export function splitBindingKey(key: string): { moduleId: string; paramId: string } | null {
  const nodes = patch?.nodes ?? {};
  let best: string | null = null;
  for (const id of Object.keys(nodes)) {
    if (!key.startsWith(`${id}:`)) continue;
    if (best === null || id.length > best.length) best = id;
  }
  if (best === null) return null;
  return { moduleId: best, paramId: key.slice(best.length + 1) };
}

// ---------------- Streaming-CC coalescing ----------------
//
// A hardware CC stream arrives at 100-300 msg/s and each durable write
// detonates a full snapshot / flowNodes / reconciler cascade. The mounted-card
// path has ridden `createCcCommit` since the write-storm fix; this path MUST
// too, or "the fix for the silent binding" becomes "the fix that starves the
// render loop" the first time somebody twists a real encoder.
//
// One pump per binding key, created ON DEMAND at first delivery. This is NOT a
// lease: nothing outside this file can hold, name or revoke one, the pump is
// only ever reachable through a delivery, and a pump whose node has since left
// the graph commits through `setNodeParam`, which no-ops on an absent node.
// Its size is bounded by the number of bindings the user has actually made.
const pumps = new Map<string, CcCommit>();

function pumpFor(nodeId: string, paramId: string): CcCommit {
  const key = `${nodeId}:${paramId}`;
  let pump = pumps.get(key);
  if (pump) return pump;
  pump = createCcCommit({
    // DURABLE: the module's declared macro OVERRIDE (PF-13 — a param whose
    // write means more than its own key) or the ordinary flat write. The exact
    // pair <ModuleShell> uses for a param cell, so a graph-delivered CC and a
    // face-delivered knob commit through the same seam.
    commit: (v) => {
      const type = liveNode(nodeId)?.type;
      const override = type ? shellParamWrite(type, paramId) : null;
      if (override) override(nodeId, v);
      else setNodeParam(nodeId, paramId, v);
    },
    // TRANSIENT per message: the handle-local engine write + the automation
    // touch-suspend cross-wire, both zero-Y.Doc. Mirrors makeMidiAssignable's
    // `pushTransient` — an inbound CC is a live grab wherever it is delivered.
    transient: (v) => {
      notifyAutomationTouch({ nodeId, paramId }, 'midi');
      const engine = getActiveEngine();
      const node = liveNode(nodeId);
      if (!engine || !node) return;
      try {
        engine.setParam(node, paramId, v);
      } catch {
        /* no engine mapping for this param — the durable commit still lands */
      }
    },
    onActiveChange: (active) => {
      // The stream went cold: end the 'midi' holder's grip — the mirror of the
      // grab the transient leg fires per message.
      if (!active) notifyAutomationRelease({ nodeId, paramId }, 'midi');
    },
    lane: 'undoable',
    batcher: getCcBatcher(),
  });
  pumps.set(key, pump);
  return pump;
}

/** CC 0..127 → a param's declared range. Duplicated from midi-learn's
 *  `ccValueToParamValue` ONLY as an import direction: midi-learn imports this
 *  module, so this module cannot import midi-learn. Asserted identical to it in
 *  graph-param-dispatch.test.ts. */
function ccToValue(ccValue: number, min: number, max: number): number {
  return min + (Math.max(0, Math.min(127, ccValue)) / 127) * (max - min);
}

/**
 * Deliver an inbound CC to `(nodeId, paramId)` THROUGH THE GRAPH, with no
 * mounted control involved. Returns true when the message was delivered, false
 * when the target could not be resolved (absent node / undeclared param) — the
 * caller uses that to distinguish "declined" from "landed" in a failure
 * message, never to retry.
 *
 * Takes the RAW 7-bit value and scales it against the DEF, so the range this
 * path uses cannot drift from the contract.
 */
export function deliverCcToGraph(nodeId: string, paramId: string, ccValue: number): boolean {
  const target = resolveCcTarget(nodeId, paramId);
  if (!target) return false;
  pumpFor(nodeId, paramId).push(ccToValue(ccValue, target.min, target.max));
  return true;
}

/**
 * Deliver an inbound NOTE on/off to a declared `gate` INPUT port through the
 * engine — the same `setGateInput` seam <PatchPanel>'s gate rows drive, which
 * resolves the port's `paramTarget` and reuses the same-domain gate-edge
 * mechanism. Not coalesced: gates are EDGES, and dropping one is dropping the
 * event. Returns true when a gate was driven.
 */
export function deliverGateToGraph(nodeId: string, portId: string, high: boolean): boolean {
  if (!resolveGateTarget(nodeId, portId)) return false;
  return getActiveEngine()?.setGateInput(nodeId, portId, high) ?? false;
}

/**
 * Force every STAGED graph-delivered CC to commit NOW.
 *
 * ⚠ This is a FLUSH, never a teardown: it can only make a pending write land
 * SOONER, never make a future message silent. It exists for the control-mount
 * handoff — when a card registers a setter mid-stream it becomes the delivery
 * path, and a value this path staged up to `CC_SETTLE_MS` earlier must not
 * commit AFTER the control's newer one. Also the test/teardown seam, mirroring
 * `flushAllCcCommits` / `flushShellParamWrites`.
 */
export function flushGraphCcCommits(): void {
  // `active` filter, not decoration: `CcCommit.flush()` on a batched pump calls
  // `batcher.flushNow()` unconditionally, which drains the SHARED two-lane
  // batcher for every other knob in the rack. This runs on every control mount,
  // so an unfiltered loop would turn "a knob appeared" into a synchronous
  // rack-wide transaction flush. A pump is `active` from its first push until
  // its settle — exactly the window in which it can hold a value.
  for (const pump of pumps.values()) if (pump.active) pump.flush();
}
