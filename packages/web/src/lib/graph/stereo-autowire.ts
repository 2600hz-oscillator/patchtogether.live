// packages/web/src/lib/graph/stereo-autowire.ts
//
// THE UNIVERSAL AUDIO COMMIT PLANNER — pure, framework-free.
//
// Every audio cable the app writes is a LEG GROUP: one or two ordinary `Edge`
// records that together carry one stereo signal. This module is the ONE place
// that decides which legs a patch gesture produces, which existing legs it
// evicts, and which legs a deletion must take with it. Canvas's three commit
// paths, the AI driver and the unpatch menu all route through here — a writer
// that does not is a writer that ships single-leg cables.
//
// THE POLICY MATRIX (owner-locked 2026-08-07; .myrobots/stereo-audio-plan/plan.md
// §0b DUAL-MONO, which REVERSED the earlier unity-sum decision):
//
//   | source → target   | legs written                                      |
//   |-------------------|---------------------------------------------------|
//   | stereo → stereo   | L→L, R→R                                          |
//   | mono   → stereo   | the one out DOUBLE-PATCHED into both target legs  |
//   | stereo → mono     | BOTH legs into the mono input — NOT a sum, NOT one |
//   | mono   → mono     | one leg                                           |
//
// ⚠ ONE NAMED EXCEPTION: a MONO AUDIO POINT target (`MONO_AUDIO_POINT_MODULES`
// in stereo-pairs.ts — the ES-9, and per the owner nothing else ever). Its
// audio ports are independent PHYSICAL JACKS, so the `stereo → mono` row would
// sum two legs into one hardware output. At most one leg lands on such a port;
// see the MONO AUDIO POINT trim below.
//
// ⚠ THE DELETED SPECIAL CASE. The pre-reversal design wrote ONE leg when a
// mono source round-tripped back into a mono input, so a correlated signal
// would not gain +6 dB from the sum. **It is deliberately NOT ported.**
// Dual-mono never sums, so the hazard it guarded is gone — and the guard
// itself was a runtime heuristic asking "are these two legs really the same
// signal?", which §0b rules out by name ("ALWAYS two instances. No 'is the
// input really stereo?' detection"). There is no correlation check, no
// same-source check, and no round-trip check anywhere in this file. Pairing is
// read off the DEF and nothing else. `stereo-autowire.test.ts` asserts the
// absence, not just the presence, of the collapse.
//
// ⚠ SCOPE BOUNDARY. This module decides what is WRITTEN TO THE GRAPH. It does
// NOT change what the audio does. Until PR-3b lands the engine's dual-mono
// wrapper, two legs into one mono input still SUM in the Web Audio graph
// exactly as they did before — that window is deliberate and the two PRs land
// adjacently.
//
// PAIRING comes from `$lib/graph/stereo-pairs` — the single source of truth:
// declared `stereoPairs` ∪ the L/R id-token fallback, AUDIO-typed ports only,
// resolved PER DIRECTION. This module NEVER re-derives a pair from a name.
//
// ⚠ It reads the WIRING entry point (`wiringPairForPort` → `allStereoPairs`),
// NOT the collapse one (`stereoPairForPort` → `derivedStereoPairs`). The two
// differ by `COLLAPSE_EXEMPT`, and `rings` is the whole reason that list is
// consulted separately: `odd`/`even` are two TIMBRES that must render as two
// jacks, and are also a declared pair whose autowire is shipped behaviour
// pinned by e2e/tests/stereo-autowire.spec.ts. Reading the collapse list here
// would delete that autowire — quietly, since a one-leg plan is a perfectly
// valid-looking plan.
//
// PURITY — no Svelte / SvelteFlow / Yjs imports. Consumes only the data-model
// types, the shared `canConnectToPort` gate, and stereo-pairs.

import type { Edge, PortDef, CableType } from './types';
import { canConnectToPort } from './types';
import {
  isMonoAudioPointModule,
  wiringPairForPort,
  type StereoPairDefLike,
} from './stereo-pairs';

/**
 * The minimal def shape the planner needs: the directional port lists (so a
 * module that reuses `L`/`R` for BOTH rails — charlottes-echos — resolves the
 * correct port in the correct direction), plus whatever `stereo-pairs` reads.
 * Any AudioModuleDef / VideoModuleDef is assignable.
 */
export interface StereoDef extends StereoPairDefLike {
  inputs: readonly PortDef[];
  outputs: readonly PortDef[];
}

type EdgeMap = Partial<Record<string, Edge>> | Record<string, Edge>;

/**
 * Which legs of a stereo cable to write.
 *   * `both`  — the whole stereo image (the default, and every path today).
 *   * `left` / `right` — a SINGLE leg: PR-4's "patch only L" / "patch only R"
 *     right-click rows. The seam exists now so the planner, its tests and the
 *     leg-level occupancy rule are settled before the UI arrives; PR-4 adds
 *     only the menu rows and threads the value through Canvas.
 */
export type ChannelMode = 'both' | 'left' | 'right';

/**
 * Which side of the stereo image a planned leg carries. `mono` means NEITHER
 * endpoint is a member of a derived stereo pair — there is no image to take a
 * side of, and a `channelMode` of `left`/`right` therefore does not filter it
 * out (selecting a channel of a signal that has none would silently produce an
 * empty plan, which reads exactly like a rejected patch).
 */
export type LegChannel = 'left' | 'right' | 'mono';

/** One `Edge` the commit must write. */
export interface PlannedLeg {
  /** Deterministic edge id — the SAME `e-…` template every commit path uses. */
  id: string;
  channel: LegChannel;
  fromPortId: string;
  toPortId: string;
  sourceType: CableType;
  targetType: CableType;
  /** True for the leg whose endpoints are the ports the user actually picked.
   *  Its cable types come from the caller (which can resolve group exposed
   *  ports); the sibling leg's come from the defs. */
  clicked: boolean;
}

export interface AudioCommitPlan {
  /** The legs to write, LEFT before RIGHT (a lone `mono` leg is the only leg).
   *  Empty when nothing is committable — the caller writes nothing. */
  legs: PlannedLeg[];
  /**
   * Existing edge ids the commit must DELETE first — LEG-LEVEL OCCUPANCY
   * (owner decision Q4): every edge seated on a target port THIS PLAN writes
   * to, minus the plan's own ids. A full-stereo patch therefore replaces both
   * legs of the target, while an only-L patch replaces only the L leg — so
   * "A only-L" and "B only-R" into one stereo input coexist.
   */
  replaceEdgeIds: string[];
}

/** THE canonical edge id for a hand-committed cable. One template, one place —
 *  the id is endpoint-derived so two peers writing the same cable converge on
 *  one Y.Map key, and so `replaceEdgeIds` can exclude the plan's own legs. */
export function audioEdgeId(
  fromNodeId: string,
  fromPortId: string,
  toNodeId: string,
  toPortId: string,
): string {
  return `e-${fromNodeId}-${fromPortId}-${toNodeId}-${toPortId}`;
}

export interface PlanAudioCommitArgs {
  fromNodeId: string;
  /** The OUTPUT port the user picked on the source module. */
  fromPortId: string;
  /** The source def, or undefined when the endpoint has none the planner can
   *  read (a group exposed port). Undefined ⇒ the source is treated as
   *  unpaired, which is the safe direction: one leg, never an invented one. */
  fromDef?: StereoDef;
  toNodeId: string;
  /** The INPUT port the user picked on the target module. */
  toPortId: string;
  toDef?: StereoDef;
  /** The live edge set — the basis of the leg-level occupancy computation. */
  edges: EdgeMap;
  /** Cable types for the CLICKED leg, already resolved by the caller (it may
   *  have chased a group exposed port's declared cableType, which no def read
   *  can reproduce). The sibling leg resolves its own from the defs. */
  sourceType: CableType;
  targetType: CableType;
  /** Default `both`. */
  channelMode?: ChannelMode;
}

/**
 * Plan the complete set of edges one audio commit writes.
 *
 * The CLICKED leg is always leg #1 — whatever the user picked is what gets
 * patched, including a deliberate cross-patch (out_r → in_l stays out_r → in_l,
 * and its sibling is then out_l → in_r). The SECOND leg is the pair-sibling of
 * each endpoint: the source's sibling when the source is paired (else the same
 * output, double-patched), and the target's sibling when the target is paired
 * (else the same input — DUAL-MONO).
 *
 * Non-audio cables (cv / gate / pitch / poly / video) fall out of this with
 * exactly one leg and no special-casing, because `derivedStereoPairs` is
 * audio-typed-ports-only by construction.
 */
export function planAudioCommit(args: PlanAudioCommitArgs): AudioCommitPlan {
  const {
    fromNodeId,
    fromPortId,
    fromDef,
    toNodeId,
    toPortId,
    toDef,
    edges,
    sourceType,
    targetType,
  } = args;
  const channelMode: ChannelMode = args.channelMode ?? 'both';

  const srcPair = fromDef ? wiringPairForPort(fromDef, fromPortId, 'output') : null;
  const dstPair = toDef ? wiringPairForPort(toDef, toPortId, 'input') : null;

  // The clicked leg's channel. The SOURCE side wins when the source is paired
  // (that is the image being carried); otherwise the TARGET side names the leg
  // (a mono source double-patched into a stereo input fills a left and a right);
  // with neither paired there is no image at all.
  const clickedChannel: LegChannel = srcPair
    ? srcPair.left === fromPortId
      ? 'left'
      : 'right'
    : dstPair
      ? dstPair.left === toPortId
        ? 'left'
        : 'right'
      : 'mono';

  const siblingFromPortId = srcPair
    ? srcPair.left === fromPortId
      ? srcPair.right
      : srcPair.left
    : fromPortId;
  const siblingToPortId = dstPair
    ? dstPair.left === toPortId
      ? dstPair.right
      : dstPair.left
    : toPortId;

  interface Candidate {
    channel: LegChannel;
    fromPortId: string;
    toPortId: string;
    clicked: boolean;
  }
  const candidates: Candidate[] = [
    { channel: clickedChannel, fromPortId, toPortId, clicked: true },
  ];
  // A second leg exists exactly when at least one endpoint is paired — i.e.
  // whenever the clicked leg carries a SIDE. No occupancy test gates it: a
  // stereo cable is ONE cable, and it REPLACES what it lands on (Q4), rather
  // than half-patching around an existing leg the way the old autowire did.
  if (clickedChannel !== 'mono') {
    candidates.push({
      channel: clickedChannel === 'left' ? 'right' : 'left',
      fromPortId: siblingFromPortId,
      toPortId: siblingToPortId,
      clicked: false,
    });
  }

  const legs: PlannedLeg[] = [];
  for (const c of candidates) {
    if (channelMode !== 'both' && c.channel !== 'mono' && c.channel !== channelMode) continue;

    let legSourceType: CableType;
    let legTargetType: CableType;
    if (c.clicked) {
      // The caller resolved these through seams this module cannot see.
      legSourceType = sourceType;
      legTargetType = targetType;
    } else {
      // The sibling must resolve to REAL ports on the correct rails and pass
      // the SAME type gate the primary passed. A pair whose sibling port is
      // missing or incompatible yields no second leg — never a broken edge.
      const outPort = fromDef?.outputs.find((p) => p.id === c.fromPortId);
      const inPort = toDef?.inputs.find((p) => p.id === c.toPortId);
      if (!outPort || !inPort) continue;
      if (!canConnectToPort(outPort.type, inPort)) continue;
      legSourceType = outPort.type;
      legTargetType = inPort.type;
    }

    legs.push({
      id: audioEdgeId(fromNodeId, c.fromPortId, toNodeId, c.toPortId),
      channel: c.channel,
      fromPortId: c.fromPortId,
      toPortId: c.toPortId,
      sourceType: legSourceType,
      targetType: legTargetType,
      clicked: c.clicked,
    });
  }

  // ---- MONO AUDIO POINT trim (ES-9) ----
  //
  // The DUAL-MONO rule sends BOTH legs to the SAME `toPortId` when the target
  // is unpaired. Into an ES-9 physical output jack that is two signals summing
  // into one hardware output — a patching error with no musical reading, not a
  // stereo cable (`MONO_AUDIO_POINT_MODULES`). So at most ONE leg may land on
  // any one such port, and the one kept is the CLICKED leg: what the user
  // actually named is what gets patched.
  //
  // ⚠ IT MUST RUN AFTER the channelMode filter, not instead of the sibling
  // candidate. For a mono target the R side IS the sibling leg (both legs share
  // the port), so refusing to PLAN the sibling would make "patch only R" into
  // an ES-9 jack write nothing at all — silently, since an empty plan is a
  // perfectly valid-looking plan. Here every mode still yields exactly one leg.
  //
  // ⚠ AND it is keyed on the PORT, not the module: `spdif_l`/`spdif_r` is a
  // genuine declared pair on the same ES-9, resolves two DIFFERENT ports, and
  // still wires as one stereo cable.
  if (legs.length > 1 && isMonoAudioPointModule(toDef?.type)) {
    const claimed = new Set<string>();
    // Clicked first, so it is the leg that survives a collision; the array is
    // re-sorted into L-before-R order immediately below.
    const byPreference = [...legs].sort((a, b) => Number(b.clicked) - Number(a.clicked));
    const kept = new Set<string>();
    for (const leg of byPreference) {
      if (claimed.has(leg.toPortId)) continue;
      claimed.add(leg.toPortId);
      kept.add(leg.id);
    }
    for (let i = legs.length - 1; i >= 0; i--) if (!kept.has(legs[i]!.id)) legs.splice(i, 1);
  }

  // LEFT before RIGHT, deterministically, whichever side was clicked.
  legs.sort((a, b) => legOrder(a.channel) - legOrder(b.channel));

  // ---- leg-level occupancy ----
  const written = new Set(legs.map((l) => l.id));
  const claimedInputs = new Set(legs.map((l) => `${toNodeId}\u0000${l.toPortId}`));
  const replaceEdgeIds: string[] = [];
  for (const [key, e] of Object.entries(edges)) {
    if (!e?.target) continue;
    if (!claimedInputs.has(`${e.target.nodeId}\u0000${e.target.portId}`)) continue;
    const id = e.id ?? key;
    if (written.has(id)) continue; // the plan's own leg — keep it, don't churn it
    replaceEdgeIds.push(id);
  }
  replaceEdgeIds.sort();

  return { legs, replaceEdgeIds };
}

function legOrder(c: LegChannel): number {
  return c === 'left' ? 0 : c === 'mono' ? 1 : 2;
}

// ---------------- leg-group DELETION ----------------

/**
 * The OTHER legs of the leg group `edge` belongs to, as ids present in `edges`.
 *
 * Deletion has to expand: once PR-4 dedupes sibling legs into ONE rendered
 * cable, deleting "the cable" that is really two edges must take both, or
 * Backspace silently orphans a dangling only-R leg the user can no longer see.
 * The same expansion keeps the unpatch menu honest.
 *
 * A leg group is identified STRUCTURALLY — same source node, same target node,
 * endpoints that are the pair-siblings of these — never by an id convention and
 * never by asking whether the two legs "carry the same signal". Two independent
 * cables from DIFFERENT sources into the two halves of one stereo input are
 * therefore NOT a group, and are not co-deleted.
 */
export function siblingLegIds(
  edge: Edge,
  edges: EdgeMap,
  defForNode: (nodeId: string) => StereoDef | undefined,
): string[] {
  if (!edge?.source || !edge?.target) return [];
  const fromDef = defForNode(edge.source.nodeId);
  const toDef = defForNode(edge.target.nodeId);
  const srcPair = fromDef ? wiringPairForPort(fromDef, edge.source.portId, 'output') : null;
  const dstPair = toDef ? wiringPairForPort(toDef, edge.target.portId, 'input') : null;
  if (!srcPair && !dstPair) return [];

  const siblingFrom = srcPair
    ? srcPair.left === edge.source.portId
      ? srcPair.right
      : srcPair.left
    : edge.source.portId;
  const siblingTo = dstPair
    ? dstPair.left === edge.target.portId
      ? dstPair.right
      : dstPair.left
    : edge.target.portId;
  if (siblingFrom === edge.source.portId && siblingTo === edge.target.portId) return [];

  const found: string[] = [];
  for (const [key, e] of Object.entries(edges)) {
    if (!e?.source || !e?.target) continue;
    const id = e.id ?? key;
    if (id === (edge.id ?? '')) continue;
    if (e.source.nodeId !== edge.source.nodeId || e.target.nodeId !== edge.target.nodeId) continue;
    if (e.source.portId !== siblingFrom || e.target.portId !== siblingTo) continue;
    found.push(id);
  }
  return found.sort();
}

/**
 * Expand a set of edge ids to the FULL leg groups they belong to.
 *
 * Returns the seeds (in the order given, deduped) followed by every sibling leg
 * found, so a caller iterating the result deletes the user's selection first and
 * the co-deleted legs after — which keeps a trace/undo entry readable.
 */
export function expandLegGroups(
  seedEdgeIds: readonly string[],
  edges: EdgeMap,
  defForNode: (nodeId: string) => StereoDef | undefined,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };
  for (const id of seedEdgeIds) push(id);
  for (const id of seedEdgeIds) {
    const e = (edges as Record<string, Edge | undefined>)[id];
    if (!e) continue;
    for (const sib of siblingLegIds(e, edges, defForNode)) push(sib);
  }
  return out;
}

/**
 * The side of the stereo image a single edge carries, or `null` when neither
 * endpoint is paired. Shared by the unpatch menu's "(L only)" labelling and by
 * anything else that has to describe a leg to a human.
 */
export function legChannelOfEdge(
  edge: Edge,
  defForNode: (nodeId: string) => StereoDef | undefined,
): 'left' | 'right' | null {
  if (!edge?.source || !edge?.target) return null;
  const fromDef = defForNode(edge.source.nodeId);
  const toDef = defForNode(edge.target.nodeId);
  const srcPair = fromDef ? wiringPairForPort(fromDef, edge.source.portId, 'output') : null;
  if (srcPair) return srcPair.left === edge.source.portId ? 'left' : 'right';
  const dstPair = toDef ? wiringPairForPort(toDef, edge.target.portId, 'input') : null;
  if (dstPair) return dstPair.left === edge.target.portId ? 'left' : 'right';
  return null;
}

// ---------------- legacy declared-pair sibling (autowire vocabulary) ----------------

/**
 * Given a def and a port id, return that port's DECLARED `stereoPairs` sibling,
 * or null.
 *
 * ⚠ This is NOT the pairing the commit planner uses — `planAudioCommit` reads
 * `derivedStereoPairs`, which is per-direction, audio-only and includes the
 * id-token fallback. `findStereoSibling` survives because `patch-convenience`'s
 * MAIN-pair resolvers still consult declarations directly (PR-5 moves them);
 * it is direction-blind on purpose, since a def carries ONE tuple set shared by
 * both rails.
 */
export function findStereoSibling(def: StereoPairDefLike, portId: string): string | null {
  const pairs = def.stereoPairs;
  if (!pairs) return null;
  for (const pair of pairs) {
    if (pair[0] === portId) return pair[1];
    if (pair[1] === portId) return pair[0];
  }
  return null;
}
