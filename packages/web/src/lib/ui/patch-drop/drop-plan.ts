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

// ── ROUND 2: THE VIDEO FILTER BECAME THE COLLAPSE ────────────────────────
// The owner, on the refusal recommendation:
//
//   "if the data to be dimmed and explained is very large then there are
//    screen real estate concerns … default to showing that information in a
//    collapsed div or similar, with a UI option to expand it so that if we're
//    missing anything we can see why it is not being given as an option, but
//    default to less screen clutter"
//
// MEASURED, on the real defs: the large data is not the refused rows — across
// every ordered pair of the six video modules the refused-row count peaked at
// ONE. The large data was what the VIDEO FILTER was hiding. Dropping backdraft
// on anything showed 4 inputs and silently dropped 29; colourofmagic showed 16
// and dropped 15. And the "show all" button offered next to that sentence was
// `disabled` — the count was the only thing you could ever learn.
//
// So the partition is no longer BY DOMAIN, it is BY THE COMPATIBILITY
// PREDICATE ITSELF, which is the thing the user is actually asking about:
//
//   offered  → shown, as now.
//   refused  → collapsed behind "▸ N not compatible", expandable, each row
//              still carrying its reason and its repair.
//
// This satisfies the owner's original filter in effect — carrying a video
// cable, the compatible inputs ARE the video-ish ones, so the default view is
// the same short list — while making the omission recoverable instead of
// terminal. It also removes a conflation the previous round flagged in its own
// prose but still shipped: "video ports" and "ports that can carry this patch"
// are different sets (`canConnect('cv', <video>)` is true), and a DOMAIN filter
// gets that wrong in both directions.
//
// ⚠ The count on the summary row is load-bearing and is never a bare chevron.
// A chevron alone is indistinguishable from "nothing here", which is the exact
// failure the dimmed-not-hidden recommendation exists to prevent. The invariant
// the census asserts — offered + refused === every declared input — is what
// makes "nothing is ever silently absent" a checkable property rather than a
// promise.

import { effectiveOutputType, type AdoptionGraph } from '$lib/graph/adopted-type';
export type { AdoptionGraph };
import { canConnectToPort } from '$lib/graph/types';
// The lattice lives in `graph/` (#1780): `graph/types.ts` derives canConnect's
// video quadrant from it and must not reach up into `ui/`, so the modal and the
// type rule now read the SAME predicate rather than two copies of it.
import {
  isVideoShape,
  refusalReason,
  REFUSAL_TEXT,
  type RefusalReason,
} from '$lib/graph/signal-lattice';

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
  /** OUTPUT jacks only: this port emits whatever is patched into the named
   *  INPUT (PortDef.adoptsUpstreamFrom). Carried here so the drop plan can ask
   *  the shared walk what the jack ACTUALLY emits instead of offering rows
   *  against a declared fallback that is wrong the moment a CV is upstream. */
  adoptsUpstreamFrom?: string;
}

/** Which way the modal is currently reading the drop. */
export type DropDirection = 'downstream' | 'upstream';

/**
 * Why a row is refused, in the user's vocabulary.
 *
 * The three lattice reasons name the AXIS that failed, which is what lets a
 * refusal suggest its own repair. `different-domain` is the fourth case and it
 * lives HERE rather than in the lattice on purpose: the lattice's stated scope
 * is cable types that have a position in it, and cross-domain reach (cv →
 * video) is an ADAPTER question, not a widening — "belongs to the caller", in
 * its own words. Putting it there would also have made the lattice's
 * every-text-is-reachable assertion vacuous, since no video pair can produce it.
 */
export type DropRefusal = RefusalReason | 'different-domain';

/** One place for the refusal wording, so the modal and any future tooltip
 *  cannot word the same rule two ways. Extends the lattice's own table rather
 *  than restating it. */
export const DROP_REFUSAL_TEXT: Readonly<Record<DropRefusal, string>> = {
  ...REFUSAL_TEXT,
  'different-domain':
    'different signal domain — this jack does not take a video signal at all',
};

/** The refusal reason for any ordered pair, video or not. */
export function dropRefusal(src: string, dst: string): DropRefusal {
  if (isVideoShape(src) && isVideoShape(dst)) {
    // Inside the lattice the axis is knowable. `refusalReason` returns
    // undefined for a LEGAL pair; callers only ask about refused rows, but a
    // defensive fallback beats emitting undefined into the UI.
    return refusalReason(src, dst) ?? 'different-domain';
  }
  return 'different-domain';
}

export interface DropEndpoint {
  nodeId: string;
  def: DropDefLike;
  /**
   * Display name. Defaults to the def's label (or its type), but a caller may
   * override — and MUST when two instances of the same type are involved, or
   * the modal header reads "backdraft ▶ backdraft" and the direction it is
   * trying to show becomes unreadable. The shipped `moduleDisplayName` does
   * exactly this — the user's rename verbatim when one exists, else a " #N"
   * suffix (#2264); a real implementation would call it.
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
  reason?: DropRefusal;
  /** True when the row is only legal because the PORT opted in via `accepts`,
   *  i.e. the global rule would have refused it. Worth surfacing: it is the
   *  module telling you it knows how to reduce, which is different from the
   *  signal already fitting. */
  viaPortOptIn?: boolean;
}

/**
 * The whole population, split the way the modal splits it.
 *
 * ⚠ Every field is DERIVED from the defs at call time — none is a stored or
 * typed count. The load-bearing property is the identity
 * `offeredInputs + refusedInputs === declaredInputs`: it is what makes the
 * collapsed summary honest, because it says every declared port is in exactly
 * one of the two groups and therefore nothing is silently absent.
 */
export interface DropCensus {
  declaredInputs: number;
  offeredInputs: number;
  refusedInputs: number;
  /** ⚠ The LANE RAIL separately shows only the first `railCap` outputs in
   *  DECLARATION ORDER, whatever the count — the literal reading of "we're only
   *  showing a subset of video outs". Reported so the modal can state the real
   *  number instead of inheriting the rail's truncation. */
  declaredOutputs: number;
  /** Outputs that reach at least ONE input on the receiving side. An output
   *  that reaches nothing here is not illegal — it is just useless for THIS
   *  drop, which is a different sentence and gets its own group. */
  reachingOutputs: number;
}

export interface DropPlan {
  direction: DropDirection;
  /** The module whose OUT is carried. */
  from: DropEndpoint;
  /** The module whose INS are the candidates. */
  into: DropEndpoint;
  /** The carried output, or undefined when `from` declares no output at all. */
  carried?: CarriableOut;
  /** EVERY output on `from`, so the modal can offer a different one. Split by
   *  `reaches` rather than filtered, for the same reason the rows are. */
  carriable: CarriableOut[];
  rows: DropRow[];
  census: DropCensus;
}

export interface CarriableOut {
  portId: string;
  label: string;
  cable: string;
  /** True when at least one input on the receiving side accepts this cable. */
  reaches: boolean;
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
  opts: { carriedPortId?: string; adoption?: AdoptionGraph } = {},
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

  // ⚠ NO DOMAIN FILTER on either side. Every declared port participates; the
  // compatibility predicate does the partitioning. See the header note.
  const allOuts = [...(from.def.outputs ?? [])];
  const allIns = [...(into.def.inputs ?? [])];

  /** The ONE predicate — the same one the drag validator and the rear card's
   *  compat-dim use, with the full port descriptor so a port's own `accepts`
   *  is honoured. Routed identically in BOTH directions, which is the property
   *  the shipped cascade lacks. */
  const accepts = (cable: string, p: DropPortLike) =>
    canConnectToPort(cable, { type: p.type, accepts: p.accepts });

  // A TYPE-TRANSPARENT output (`adoptsUpstreamFrom`) carries what is patched
  // into the input it adopts from, so that is what the modal must offer rows
  // against — judged on the declaration, a SCALER already fed by an LFO showed
  // every CV input as REFUSED. `effectiveOutputType` falls back to the declared
  // type with nothing upstream (and with no `adoption` supplied at all), so a
  // caller that cannot see the graph keeps exactly today's behaviour.
  const emits = (p: DropPortLike) => effectiveOutputType(from.nodeId, p, opts.adoption) as string;

  const carriable: CarriableOut[] = allOuts.map((p) => {
    const cable = emits(p);
    return {
      portId: p.id,
      label: portLabel(p),
      cable,
      reaches: allIns.some((i) => accepts(cable, i)),
    };
  });
  // Prefer an output that can actually land somewhere: opening on a dead carry
  // when a live one exists would make the modal look empty for no reason. The
  // user's explicit pick still wins over the preference.
  const carried =
    carriable.find((c) => c.portId === opts.carriedPortId) ??
    carriable.find((c) => c.reaches) ??
    carriable[0] ??
    undefined;

  const rows: DropRow[] = carried
    ? allIns.map((p) => {
        const ok = accepts(carried.cable, p);
        const globalOk = canConnectToPort(carried.cable, { type: p.type });
        return {
          portId: p.id,
          label: portLabel(p),
          cable: p.type,
          state: ok ? 'offered' : 'refused',
          reason: ok ? undefined : dropRefusal(carried.cable, p.type),
          viaPortOptIn: ok && !globalOk ? true : undefined,
        } satisfies DropRow;
      })
    : [];

  return {
    direction,
    from,
    into,
    carried,
    carriable,
    rows,
    census: {
      declaredInputs: allIns.length,
      offeredInputs: rows.filter((r) => r.state === 'offered').length,
      refusedInputs: rows.filter((r) => r.state === 'refused').length,
      declaredOutputs: allOuts.length,
      reachingOutputs: carriable.filter((c) => c.reaches).length,
    },
  };
}

/** Flip helper — the Tab gesture, as a pure function so the modal's key
 *  handler has nothing to get wrong. */
export function invertDirection(d: DropDirection): DropDirection {
  return d === 'downstream' ? 'upstream' : 'downstream';
}

/**
 * One staged or committed edge. It names the SUPPLYING node+port and the
 * RECEIVING node+port, never "the dropped one" and "the one underneath" — so
 * the same edge is the same edge on both sides of a Tab flip, which is what
 * lets a feedback loop be built across the flip without the modal closing.
 */
export interface DropEdge {
  fromNode: string;
  fromPort: string;
  intoNode: string;
  intoPort: string;
}

/** Identity for an edge. ONE definition, so the staged set, the committed set
 *  and the sandbox's edge list cannot key the same edge three ways. */
export function dropEdgeKey(e: DropEdge): string {
  return `${e.fromNode}.${e.fromPort}→${e.intoNode}.${e.intoPort}`;
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
