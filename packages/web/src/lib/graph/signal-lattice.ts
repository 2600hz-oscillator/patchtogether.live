// packages/web/src/lib/graph/signal-lattice.ts
//
// THE VIDEO WIDENING RULE. `canConnect` (./types.ts) derives its video quadrant
// from `videoWidensTo` below, so this file and every patch surface agree BY
// CONSTRUCTION rather than by two lists being maintained in step.
//
// It lives in `graph/` and not in `ui/` for exactly that reason: `graph/types.ts`
// is the bottom of the import graph and must never reach up into `ui/`. The file
// is a pure leaf — it imports NOTHING — so every consumer (the graph type rule,
// the drop-modal plan, a future patch surface) can depend on it freely.
//
// ── THE OWNER'S REQUIREMENT ───────────────────────────────────────────────
//   "mono video outs can be patched into color ins no problem, but color ins
//    cannot be patched into the handful of mono ins. i want that to be handled
//    with intelligent logic and not with a brittle list of what is what."
//
// ── WHAT THIS REPLACED (#1780) ───────────────────────────────────────────
// The mono/colour asymmetry was already derived from the declarations — it was
// never a list of module names. What WAS a list is the SHAPE `canConnect` used
// to express it: a hand-written edge table
//
//     keys:        ['mono-video', 'image'],
//     image:       ['video'],
//     'mono-video':['video'],
//
// An edge table has to be TRANSITIVELY CLOSED BY HAND, and that one was not.
// `keys → video` was refused even though `keys → mono-video → video` was legal
// in two hops and the widening is free at the shader layer. That missing
// diagonal is the brittleness the owner named, and it was measured rather than
// theorised — the divergence test beside this file sweeps every ordered pair and
// pinned the disagreement at exactly one.
//
// ⚠ AND IT HAD ALREADY COST US A DECLARATION. No port anywhere in the repo is
// typed `keys` — it is a declared-but-unpopulated cable type — so the gap looked
// harmless. It was not: BACKDRAFT's two KEY-MASK inputs are typed `video`
// instead, and the def says why in as many words —
//
//     // KEY masks. 'video' so any source (LINES / SHAPES / a key) patches in.
//     { id: 'lighten', type: 'video' },
//     { id: 'darken',  type: 'video' },
//
// ⚠ Those INPUTS are correct as `video` and must STAY that way: widening runs
// source→input, so a `video` input accepts EVERY video source while a `keys`
// input would accept only `keys` ones. Re-typing them to `keys` would NARROW
// them and break existing patches — the opposite of what the def asked for. The
// half that was actually broken is the other direction: a `keys` SOURCE could
// not reach a `video` input. Closing the diagonal fixes that, and it is what
// makes `keys` a usable type for a future mask OUTPUT. `mapper.key` is the same
// shape and reads the same way.
//
// ── THE DERIVATION ───────────────────────────────────────────────────────
// The four video cable types are not four things. They are TWO INDEPENDENT
// BOOLEAN AXES, and the type names already say so — read the union's own
// comment in ./types.ts:
//
//     keys       — single-channel still mono image (no time axis)
//     image      — RGB still image (no time axis)
//     mono-video — single-channel animated video stream
//     video      — RGB animated video stream
//
//                    still            animated
//     mono          keys       →      mono-video
//                    ↓                    ↓
//     colour        image      →      video
//
// Widening is free along EITHER axis (broadcast one channel to three; hold one
// frame over time) and lossy against either (which is exactly why colour → mono
// is refused: it needs a reduction the patcher never asked for).
//
// So the predicate is the PRODUCT ORDER over the two axes:
//
//     widensTo(a, b)  ⟺  channels(a) ≤ channels(b)  ∧  motion(a) ≤ motion(b)
//
// A product order is TRANSITIVELY CLOSED BY CONSTRUCTION. There is no diagonal
// to remember, because there is no edge list. Adding a fifth video type means
// giving it two ranks, not auditing N² edges.
//
// ── WHY THIS SHAPE EXTENDS TO AUDIO ──────────────────────────────────────
// The owner: "a paradigm for video, which we might extend to audio later."
// Compatibility here is ONE function over port declarations with THREE clauses,
// none of them video-specific:
//
//   1. WIDENING  — free + lossless, derived from facets, order-closed. The
//      video lattice is one instance. The CV family (cv/pitch/gate, declared
//      "freely interchangeable") is another: three types with IDENTICAL facets,
//      so they mutually widen and CV_FAMILY falls out instead of being listed.
//   2. ADAPTER   — a declared conversion that INTERPOSES something (the poly
//      splitter/merger, the cv→video frame-rate sample-and-hold, the audio
//      envelope-follower into a modsignal input). Lossy or bridged, so it must
//      be named and carry its reason. This is the honest home for everything
//      that is NOT a free widening.
//   3. PORT OPT-IN — the existing `PortDef.accepts`, unchanged. A port that
//      knows how to reduce says so itself (COLOUR OF MAGIC's channel inputs
//      already do exactly this), so the knowledge lives on the port that has
//      it rather than in a central table.
//
// `canConnectToPort` is (3) layered on (1)+(2); `canConnect` is (1)+(2), and
// this file IS its (1) for the video domain.
//
// ── SCOPE: WHAT THIS FILE IS STRUCTURALLY UNABLE TO SEE ──────────────────
// It knows about CABLE TYPES only. It cannot see a port's `accepts`, cannot see
// module identity, and cannot see whether a bridge is actually implemented for
// a pair it calls legal. Callers layer those on — which is the point: the ONE
// thing that should never be per-module is the type rule itself. In particular
// it deliberately does NOT model the cv→video ADAPTER: `canConnect` allows that
// pair and `videoWidensTo` refuses it, and the test beside this file pins that
// disagreement permanently so "the lattice IS canConnect" can never be assumed.

/** Widening axis 1 — how many channels the signal carries. */
export const CHANNEL_RANK = { mono: 0, colour: 1 } as const;
/** Widening axis 2 — whether the signal has a time dimension. */
export const MOTION_RANK = { still: 0, animated: 1 } as const;

export type Channels = keyof typeof CHANNEL_RANK;
export type Motion = keyof typeof MOTION_RANK;

/**
 * ONE row per VIDEO cable type, giving its position on the two axes.
 *
 * ⚠ This is a definition of the four types, NOT an enumeration of which ports
 * or modules are mono. It is closed by the `StandardCableType` union: a video
 * type that is not listed here has no position in the lattice and
 * `videoShape()` returns undefined for it, which callers must treat as "not a
 * video type" rather than as "incompatible".
 */
export const VIDEO_SHAPE: Readonly<Record<string, { channels: Channels; motion: Motion }>> = {
  keys: { channels: 'mono', motion: 'still' },
  image: { channels: 'colour', motion: 'still' },
  'mono-video': { channels: 'mono', motion: 'animated' },
  video: { channels: 'colour', motion: 'animated' },
};

export function videoShape(type: string): { channels: Channels; motion: Motion } | undefined {
  return VIDEO_SHAPE[type];
}

/** True when `type` has a position in the video lattice. */
export function isVideoShape(type: string): boolean {
  return videoShape(type) !== undefined;
}

/**
 * THE PREDICATE. True when a signal of `src` is, without any conversion, also
 * a valid signal of `dst`.
 *
 * Reflexive (equal types widen to themselves), transitive by construction, and
 * antisymmetric — i.e. a partial order, which is exactly what "a mono signal IS
 * a colour signal but not vice versa" means formally.
 *
 * Returns false when either side is not a video type; cross-domain reach
 * (cv → video) is an ADAPTER, not a widening, and belongs to the caller.
 */
export function videoWidensTo(src: string, dst: string): boolean {
  const a = videoShape(src);
  const b = videoShape(dst);
  if (!a || !b) return false;
  return (
    CHANNEL_RANK[a.channels] <= CHANNEL_RANK[b.channels] &&
    MOTION_RANK[a.motion] <= MOTION_RANK[b.motion]
  );
}

/**
 * WHY a widening was refused, in the user's vocabulary — the text a refused row
 * in the drop modal shows. Returns undefined when the widening is legal.
 *
 * Naming the AXIS (not just "incompatible") is the whole reason a refusal can
 * suggest its own repair: a channels-axis refusal has a fix (reduce to luma), a
 * motion-axis refusal has a different one (hold a frame), and a caller that
 * only knows "false" can offer neither.
 */
export function refusalReason(src: string, dst: string): RefusalReason | undefined {
  const a = videoShape(src);
  const b = videoShape(dst);
  if (!a || !b) return undefined;
  const channelsFail = CHANNEL_RANK[a.channels] > CHANNEL_RANK[b.channels];
  const motionFail = MOTION_RANK[a.motion] > MOTION_RANK[b.motion];
  if (!channelsFail && !motionFail) return undefined;
  if (channelsFail && motionFail) return 'colour-and-motion';
  return channelsFail ? 'colour-into-mono' : 'motion-into-still';
}

export type RefusalReason = 'colour-into-mono' | 'motion-into-still' | 'colour-and-motion';

/** Human sentence for a refusal — one place, so the modal and any future
 *  tooltip cannot word the same rule two ways. */
export const REFUSAL_TEXT: Readonly<Record<RefusalReason, string>> = {
  'colour-into-mono':
    'this jack takes ONE channel; a colour signal would have to be reduced, and nothing here says how',
  'motion-into-still': 'this jack takes a still frame; a moving signal would have to be held',
  'colour-and-motion': 'this jack takes ONE channel and a still frame; both would have to be reduced',
};
