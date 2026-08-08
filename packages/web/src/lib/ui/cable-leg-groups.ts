// packages/web/src/lib/ui/cable-leg-groups.ts
//
// ONE CABLE PER LEG GROUP — the rendering half of the projection.
//
// A stereo cable is TWO `Edge` records (the leg group `planAudioCommit`
// writes). Drawing both would put two beziers between the same two cards,
// anchored at the same hidden corner handle stack — visually one fat cable that
// deletes half at a time. This module decides, for every edge in the graph:
//
//   * does it RENDER, or is it the sibling its partner already draws?
//   * is the group a SINGLE leg of a stereo pair — an only-L / only-R cable
//     the user asked for, or a LEGACY edge from a rack saved before leg
//     groups existed? Those render dashed with an L / R tag.
//
// A single-leg stereo cable is audio-identical to what it always was; the
// dashes are the app finally SAYING that half the image is silent.
//
// GROUPING IS STRUCTURAL — same source node, same target node, endpoints that
// are each other's pair siblings. Never an id convention (`wcol-e-…` edges and
// hand-authored fixture ids do not follow the `e-…` template), and never "do
// these two carry the same signal?". Two independent cables from DIFFERENT
// sources into the two halves of one stereo input are therefore NOT a group —
// they stay two cables, which is Q4's leg-level occupancy made visible.
//
// ⚠ IT READS BOTH PAIR LISTS, FOR TWO DIFFERENT QUESTIONS. This is the one
// place in the app where the distinction is not academic:
//
//   * GROUPING asks the WIRING list (`wiringPairForPort`) — "did one gesture
//     write these two edges?". `rings`' odd+even auto-wire is a shipped,
//     e2e-pinned pair, so odd→inL together with even→inR is ONE cable and must
//     draw as one, or deletion (which expands leg groups) disagrees with the
//     picture.
//   * The DASHED SOLO TAG asks the COLLAPSE list (`stereoPairForPort`) — "is
//     this half of a stereo IMAGE?". `rings` is COLLAPSE_EXEMPT: odd and even
//     are two TIMBRES, so a lone `odd → mixer` cable is a complete, meaningful
//     patch, not a broken half — and tagging it "L" would be a plain lie about
//     what that jack carries.
//
// Using one list for both would be wrong in one direction or the other, and
// both wrongs render as a perfectly plausible-looking cable.
//
// COST — one pass, O(E). The naive form (`siblingLegIds` per edge) is O(E²)
// and this runs on every graph pump.

import type { Edge } from '$lib/graph/types';
import { stereoPairForPort, wiringPairForPort, type StereoPair } from '$lib/graph/stereo-pairs';
import type { StereoDef } from '$lib/graph/stereo-autowire';

/** How ONE edge participates in its leg group. */
export interface LegGroupView {
  /** True for the edge that draws the group's bezier (the LEFT leg of a pair,
   *  or the only edge). False ⇒ the caller must not emit a FlowEdge for it. */
  render: boolean;
  /** 'left' / 'right' when the group is a SINGLE leg of a stereo pair — the
   *  dashed only-L / only-R treatment. Null for a complete pair and for any
   *  cable with no stereo image at all (mono audio, cv, gate, poly, video). */
  soloChannel: 'left' | 'right' | null;
  /**
   * Which leg of the pair THIS edge is, whether or not its sibling exists.
   *
   * ⚠ THIS MUST EQUAL `legChannelOfEdge(edge)` FOR EVERY EDGE. Since #1408 the
   * ENGINE places a cable on a dual-mono wrapper's left/right input using
   * exactly that function, so this field and the audio routing are two readings
   * of one derivation. If they ever diverged, a cable would RENDER as one
   * bezier while its two legs landed on different inputs — a picture that lies
   * about the signal. Pinned edge-for-edge in cable-leg-groups.test.ts against
   * `legChannelOfEdge` itself, so the two cannot drift apart.
   */
  channel: 'left' | 'right' | null;
  /** Every edge id in the group, the rendering one first. */
  groupIds: string[];
}

/**
 * Composite-key separator for the endpoint index. A NUL can never occur in a
 * node or port id, so a key cannot be forged by an id containing the
 * delimiter.
 *
 * WRITTEN AS AN ESCAPE, NEVER AS A RAW BYTE. A literal NUL in the source makes
 * git classify the whole FILE as binary: no line diff for a human to review,
 * a merge conflict nothing can resolve, and `git blame` / grep / code search
 * silently skipping it. `cable-leg-groups.test.ts` asserts the source text
 * contains no raw NUL so this cannot come back.
 */
export const LEG_KEY_SEP = '\u0000';

function endpointKey(nodeId: string, portId: string, toNodeId: string, toPortId: string): string {
  return [nodeId, portId, toNodeId, toPortId].join(LEG_KEY_SEP);
}

/** Memoised pair lookups. Def objects are registry singletons, and these are
 *  called up to four times per edge on every pump. */
const PAIR_CACHE = new WeakMap<object, Map<string, StereoPair | null>>();

function pairFor(
  def: StereoDef | undefined,
  portId: string,
  direction: 'input' | 'output',
  list: 'wiring' | 'collapse',
): StereoPair | null {
  if (!def) return null;
  let byPort = PAIR_CACHE.get(def as object);
  if (!byPort) PAIR_CACHE.set(def as object, (byPort = new Map()));
  const key = `${list}:${direction}:${portId}`;
  const hit = byPort.get(key);
  if (hit !== undefined) return hit;
  const pair =
    list === 'wiring'
      ? wiringPairForPort(def, portId, direction)
      : stereoPairForPort(def, portId, direction);
  byPort.set(key, pair);
  return pair;
}

/**
 * Classify every edge for rendering.
 *
 * Returns a map keyed by edge id. An edge missing from the map (impossible for
 * an edge in `edges`, but a caller iterating a different list may hit it)
 * should be treated as `{ render: true, soloChannel: null }` — draw it plainly
 * rather than drop it, because a cable that is not drawn cannot be deleted.
 */
export function computeLegGroups(
  edges: Iterable<Edge>,
  defForNode: (nodeId: string) => StereoDef | undefined,
): Map<string, LegGroupView> {
  const list: Edge[] = [];
  const byEndpoint = new Map<string, Edge>();
  for (const e of edges) {
    if (!e?.source || !e?.target || !e.id) continue;
    list.push(e);
    byEndpoint.set(
      endpointKey(e.source.nodeId, e.source.portId, e.target.nodeId, e.target.portId),
      e,
    );
  }

  // ---- pass 1: each edge's channel + its sibling's endpoint key ----
  interface Classified {
    edge: Edge;
    /** null ⇒ no PAIR at either end: an ordinary, always-solid cable. This is
     *  the path every cv / gate / pitch / poly / video cable and every
     *  mono→mono audio cable takes, which is why they are untouched here. */
    channel: 'left' | 'right' | null;
    siblingKey: string | null;
    /** True when the pair that named `channel` is also a COLLAPSE pair — i.e.
     *  the two legs really are one stereo IMAGE, so a lone leg is half of
     *  something and earns the dashed L / R treatment. False for a
     *  wiring-only pair (`rings` odd/even), where a single cable is complete. */
    isStereoImage: boolean;
  }
  const classified: Classified[] = list.map((e) => {
    const srcDef = defForNode(e.source.nodeId);
    const dstDef = defForNode(e.target.nodeId);
    const srcPair = pairFor(srcDef, e.source.portId, 'output', 'wiring');
    const dstPair = pairFor(dstDef, e.target.portId, 'input', 'wiring');
    if (!srcPair && !dstPair)
      return { edge: e, channel: null, siblingKey: null, isStereoImage: false };

    // The SOURCE side names the channel when the source is paired (that is the
    // image being carried); otherwise the TARGET side does. Identical to
    // `legChannelOfEdge` and to `planAudioCommit`'s `clickedChannel`.
    const channel: 'left' | 'right' = srcPair
      ? srcPair.left === e.source.portId
        ? 'left'
        : 'right'
      : dstPair!.left === e.target.portId
        ? 'left'
        : 'right';
    const siblingFrom = srcPair
      ? srcPair.left === e.source.portId
        ? srcPair.right
        : srcPair.left
      : e.source.portId;
    const siblingTo = dstPair
      ? dstPair.left === e.target.portId
        ? dstPair.right
        : dstPair.left
      : e.target.portId;
    // The side that NAMED the channel is the side that has to be a real stereo
    // image for the dashes to be honest.
    const isStereoImage = srcPair
      ? pairFor(srcDef, e.source.portId, 'output', 'collapse') !== null
      : pairFor(dstDef, e.target.portId, 'input', 'collapse') !== null;
    return {
      edge: e,
      channel,
      siblingKey: endpointKey(e.source.nodeId, siblingFrom, e.target.nodeId, siblingTo),
      isStereoImage,
    };
  });
  const channelById = new Map(classified.map((c) => [c.edge.id, c.channel]));

  // ---- pass 2: who draws the group ----
  const out = new Map<string, LegGroupView>();
  for (const { edge: e, channel, siblingKey, isStereoImage } of classified) {
    if (!channel || !siblingKey) {
      out.set(e.id, { render: true, soloChannel: null, channel: null, groupIds: [e.id] });
      continue;
    }
    const partner = byEndpoint.get(siblingKey);
    if (!partner || partner.id === e.id) {
      // A LONE leg. Dashed + tagged only if it is half a stereo IMAGE; a lone
      // `rings.odd` is a complete cable and stays solid.
      out.set(e.id, {
        render: true,
        soloChannel: isStereoImage ? channel : null,
        channel,
        groupIds: [e.id],
      });
      continue;
    }
    // Complete group. The LEFT leg draws it. The id tie-break covers only the
    // degenerate case where the two legs claim the SAME side — impossible from
    // any planner (the sibling mapping is an involution that flips the side of
    // whichever end is paired) but reachable from a hand-authored graph. It is
    // here so that exactly ONE of the two renders in every case: two renderers
    // would draw a double cable, ZERO renderers would make a live cable
    // invisible and therefore undeletable.
    const partnerChannel = channelById.get(partner.id) ?? null;
    const isRenderer =
      partnerChannel === channel ? e.id < partner.id : channel === 'left';
    out.set(e.id, {
      render: isRenderer,
      soloChannel: null,
      channel,
      groupIds: isRenderer ? [e.id, partner.id] : [partner.id, e.id],
    });
  }
  return out;
}
