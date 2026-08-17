// packages/web/src/lib/dev/video-patch-drop/drop-plan.ts
//
// ⛔ MOCK / PROPOSAL — nothing in the engine imports this.
//
// The pure model behind the drop-patch modal: given the two modules involved in
// a faceplate-on-faceplate drop and which way round we are looking at them,
// produce the rows the modal shows.
//
// ── THE GESTURE ──────────────────────────────────────────────────────────
//   "when we drop module A on top of module B, we see by default a modal
//    showing us how A can be patched downstream of B, with B's outs going to A.
//    if we hit tab, the modal logic inverts."
//
// So the modal has ONE carried output and a list of candidate inputs, and Tab
// swaps which module supplies which. That is deliberately the SAME shape as the
// shipped click-click carry seam (connectDragState.pickup → a rear card whose
// holes compat-dim), not a new interaction: a drop is just a carry whose source
// and target were chosen by where you let go.
//
// ── THE SUBSET RULE ──────────────────────────────────────────────────────
//   "i think we only need to consider video ins and outs"
//   "our existing UI for faceplate drawer backpanels is fine for this with the
//    caveat that we're only showing a subset of video outs."
//
// `videoPortsOf` implements that filter AND REPORTS WHAT IT HID. The reporting
// is not decoration — a filter that silently drops ports is how "backdraft has
// 33 inputs" becomes "backdraft has 4 inputs" in a user's head, and the CV
// inputs it hides are legally patchable (canConnect('cv', <video>) is true, so
// a CV out really can reach a video-typed in). The modal therefore shows the
// count it is not showing, and offers to drop the filter.
//
// ── DIRECTION SYMMETRY IS THE POINT ──────────────────────────────────────
// ⚠ The shipped right-click cascade is NOT symmetric. `compatibleTargetPorts`
// honours a port's `accepts` widening when the source is an OUTPUT
// (`canConnectToPort(srcType, p)`) but drops it when the source is an INPUT
// (`canConnect(p.type, srcType)` — the port descriptor is gone, so its
// `accepts` cannot be consulted). Measured: with a `mono-video` input declaring
// `accepts: ['keys','image','video']`, dragging a `video` cable in is LEGAL,
// while starting from that same input offers ZERO sources.
//
// Tab makes that asymmetry USER-VISIBLE for the first time — it is precisely a
// gesture for flipping between the two directions — so this model routes BOTH
// directions through `canConnectToPort` with the full port descriptor on the
// destination side. That is the shape `rearHoleAcceptsCarry` (rear-card-model)
// already gets right; only the cascade disagrees.

import { canConnectToPort } from '$lib/graph/types';
import { isVideoShape, refusalReason, type RefusalReason } from './signal-lattice';

/** The minimum a module def has to expose for this model — structurally
 *  satisfied by AudioModuleDef / VideoModuleDef / MetaModuleDef alike, so the
 *  model never imports a registry and stays domain-agnostic. */
export interface DropDefLike {
  type: string;
  label?: string;
  inputs?: readonly DropPortLike[];
  outputs?: readonly DropPortLike[];
}
export interface DropPortLike {
  id: string;
  type: string;
  label?: string;
  accepts?: readonly string[];
  paramTarget?: string;
}

/** Which way the modal is currently reading the drop. */
export type DropDirection = 'downstream' | 'upstream';

export interface DropEndpoint {
  nodeId: string;
  def: DropDefLike;
  /**
   * Display name. Defaults to the def's label (or its type), but a caller may
   * override — and MUST when two instances of the same type are involved, or
   * the modal header reads "backdraft ▶ backdraft" and the direction it is
   * trying to show becomes unreadable. The shipped `moduleDisplayName` does
   * exactly this with a " #N" suffix; a real implementation would call it.
   */
  label: string;
}

/** One side of the drop, as the caller supplies it. */
export interface DropSideInput {
  nodeId: string;
  def: DropDefLike;
  label?: string;
}

/** One candidate INPUT on the receiving side, for the currently carried out. */
export interface DropRow {
  portId: string;
  label: string;
  cable: string;
  /**
   * `offered`  — a click here commits a legal edge.
   * `refused`  — the type rule rejects it. Carries `reason`.
   *
   * There is deliberately no `hidden` state: see the modal's note on why a
   * refusal is SHOWN. A row the user cannot see is a question they cannot ask.
   */
  state: 'offered' | 'refused';
  reason?: RefusalReason;
  /** True when the row is only legal because the PORT opted in via `accepts`,
   *  i.e. the global rule would have refused it. Worth surfacing: it is the
   *  module telling you it knows how to reduce, which is different from the
   *  signal already fitting. */
  viaPortOptIn?: boolean;
}

/** What the video-only filter removed, so the modal can say so. */
export interface SubsetReport {
  /** Ports whose cable type has a position in the video lattice. */
  shownOutputs: number;
  shownInputs: number;
  /** Ports the filter dropped, split by whether they could still carry a patch. */
  hiddenCvInputs: number;
  hiddenOtherInputs: number;
  hiddenOutputs: number;
  /** ⚠ The LANE RAIL separately shows only the first `railCap` outputs in
   *  DECLARATION ORDER, whatever the count — the literal reading of "we're only
   *  showing a subset of video outs". Reported so the modal can state the real
   *  number instead of inheriting the rail's truncation. */
  totalOutputs: number;
}

export interface DropPlan {
  direction: DropDirection;
  /** The module whose OUT is carried. */
  from: DropEndpoint;
  /** The module whose INS are the candidates. */
  into: DropEndpoint;
  /** The carried output, or undefined when `from` has no video output at all. */
  carried?: { portId: string; label: string; cable: string };
  /** Every video output on `from`, so the modal can offer a different one. */
  carriable: { portId: string; label: string; cable: string }[];
  rows: DropRow[];
  subset: SubsetReport;
}

/** A port participates in the VIDEO view when its cable type is one of the
 *  four video types. Derived from the lattice — never a module-name list. */
export function isVideoPort(p: DropPortLike): boolean {
  return isVideoShape(p.type);
}

export function videoPortsOf(
  def: DropDefLike,
  direction: 'inputs' | 'outputs',
): DropPortLike[] {
  return [...(def[direction] ?? [])].filter(isVideoPort);
}

function portLabel(p: DropPortLike): string {
  return (p.label ?? p.id).toUpperCase();
}

function endpointLabel(def: DropDefLike): string {
  return def.label ?? def.type;
}

/**
 * Build the modal's model.
 *
 * `dropped` is the faceplate the user was dragging; `onto` is the one under the
 * cursor. In the DEFAULT (`downstream`) direction the dropped module ends up
 * downstream — `onto`'s outs feed `dropped`'s ins, which is the owner's
 * "drop backdraft onto camera ⇒ patch camera's output into backdraft". Tab
 * flips to `upstream` and the two swap roles wholesale; nothing else changes,
 * which is what makes the flip legible.
 */
export function buildDropPlan(
  dropped: DropSideInput,
  onto: DropSideInput,
  direction: DropDirection,
  opts: { carriedPortId?: string } = {},
): DropPlan {
  const fromSide = direction === 'downstream' ? onto : dropped;
  const intoSide = direction === 'downstream' ? dropped : onto;

  const from: DropEndpoint = {
    nodeId: fromSide.nodeId,
    def: fromSide.def,
    label: fromSide.label ?? endpointLabel(fromSide.def),
  };
  const into: DropEndpoint = {
    nodeId: intoSide.nodeId,
    def: intoSide.def,
    label: intoSide.label ?? endpointLabel(intoSide.def),
  };

  const outs = videoPortsOf(from.def, 'outputs');
  const carriable = outs.map((p) => ({
    portId: p.id,
    label: portLabel(p),
    cable: p.type,
  }));
  const carried =
    carriable.find((c) => c.portId === opts.carriedPortId) ?? carriable[0] ?? undefined;

  const candidateIns = videoPortsOf(into.def, 'inputs');
  const rows: DropRow[] = carried
    ? candidateIns.map((p) => {
        // The SAME predicate the drag validator and the rear card's compat-dim
        // use, with the full port descriptor so `accepts` is honoured — in
        // BOTH directions, which the shipped cascade does not do.
        const ok = canConnectToPort(carried.cable, { type: p.type, accepts: p.accepts });
        const globalOk = canConnectToPort(carried.cable, { type: p.type });
        return {
          portId: p.id,
          label: portLabel(p),
          cable: p.type,
          state: ok ? 'offered' : 'refused',
          reason: ok ? undefined : refusalReason(carried.cable, p.type),
          viaPortOptIn: ok && !globalOk ? true : undefined,
        } satisfies DropRow;
      })
    : [];

  const allIns = [...(into.def.inputs ?? [])];
  const allOuts = [...(from.def.outputs ?? [])];
  const hiddenIns = allIns.filter((p) => !isVideoPort(p));

  return {
    direction,
    from,
    into,
    carried,
    carriable,
    rows,
    subset: {
      shownOutputs: outs.length,
      shownInputs: candidateIns.length,
      hiddenCvInputs: hiddenIns.filter((p) => p.type === 'cv').length,
      hiddenOtherInputs: hiddenIns.filter((p) => p.type !== 'cv').length,
      hiddenOutputs: allOuts.length - outs.length,
      totalOutputs: allOuts.length,
    },
  };
}

/** Flip helper — the Tab gesture, as a pure function so the modal's key
 *  handler has nothing to get wrong. */
export function invertDirection(d: DropDirection): DropDirection {
  return d === 'downstream' ? 'upstream' : 'downstream';
}

/**
 * A REPAIR for a refused row: a registered module that takes the carried
 * cable and emits something the refused input accepts, i.e. the reduction the
 * type rule says is missing. DERIVED by searching the candidate defs — there is
 * no list of "converter modules", because being a converter is a property of a
 * def's ports, not a label someone remembered to apply.
 *
 * Returns the first match in the supplied order; callers pass the live registry
 * listing, so a new module that happens to reduce colour to mono becomes an
 * offered repair the day it lands.
 */
export function findRepair(
  carriedCable: string,
  refusedIn: DropPortLike,
  candidates: readonly DropDefLike[],
): DropRepair | undefined {
  for (const def of candidates) {
    const inPort = (def.inputs ?? []).find((p) =>
      canConnectToPort(carriedCable, { type: p.type, accepts: p.accepts }),
    );
    if (!inPort) continue;
    const outPorts = (def.outputs ?? []).filter((p) =>
      canConnectToPort(p.type, { type: refusedIn.type, accepts: refusedIn.accepts }),
    );
    if (outPorts.length === 0) continue;
    return {
      type: def.type,
      label: endpointLabel(def),
      inPortId: inPort.id,
      // ⚠ EVERY qualifying output, not the first one. A reducer generally has
      // several — COLOUR OF MAGIC emits 16 mono taps — and picking one for the
      // user would be the app inventing an answer to a question only they can
      // answer (a red channel and a luma are both "a mono signal" and mean
      // completely different pictures). The repair names the module and offers
      // the taps; choosing stays a click.
      outPortIds: outPorts.map((p) => p.id),
    };
  }
  return undefined;
}

export interface DropRepair {
  type: string;
  label: string;
  inPortId: string;
  outPortIds: string[];
}
