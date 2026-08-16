// packages/web/src/lib/ui/workflow/dom-source-modules.ts
//
// THE DOM-SOURCE SEAM — why a video module can go DARK when the shell swaps its
// lane card, and the pure decision that keeps it alive.
//
// THE BUG (owner P0, `/rack?mode=workflow&shell=1`: "no video at all"):
// most video modules are self-contained GPU passes — the reconciler materializes
// them from the GRAPH (`VideoEngine.addNode`, $lib/audio/reconciler) and they
// render whether or not anything is mounted. A MINORITY are different: their
// pixels come from a DOM media element (`<video>` / `<img>`) that the module's
// own *Card.svelte creates, feeds (getUserMedia / a File blob / a URL) and hands
// to the engine handle via `VideoEngine.attachExternalSource(id, kind, el)`.
// For those, the ENGINE NODE exists but its SOURCE is null until the card mounts
// — and `onDestroy` explicitly detaches it again.
//
// Under `?shell=1` the lane renders <ModuleShellPlaceholder> / <ModuleShell>
// INSTEAD of the legacy card (see ./legacy-fallback). So for a DOM-source module
// the card never mounts, `attachExternalSource` never runs, the node emits a
// blank texture, and EVERY consumer downstream of it is black — the chain looks
// patched and is dead. Switching an already-running rack INTO the shell is worse:
// the card unmounts and actively DETACHES the live source.
//
// THE SECOND HALF (#1587, owner P0 "wavesculpt/timelorde render BLACK unless
// the card happens to be open"): a module can fail this way WITHOUT owning a
// DOM media element. WAVESCULPT, TIMELORDE and SYNESTHESIA attach no source at
// all — their CARD runs the rAF loop that PRODUCES the picture (or the analysis
// of it) and pushes it into the module's own engine handle. The card is not the
// source's lifecycle; the card IS the producer. Swap it away and the module's
// own drawFrame paints solid black / its idle field, so a SAVED rack with
// `WAVESCULPT.video_out → VIDEO OUT` is black ON LOAD, before the user touches
// anything. Collapse is merely how you notice it. Same rule, same host, second
// derived set — see CARD_PRODUCER_LANE_TYPES.
//
// THE RULE THIS FILE ENCODES: the ENGINE-VISIBLE state of a rack must not depend
// on which UI renders a module. Node registration already satisfies that (it is
// graph-driven). Source ATTACHMENT does not — so when the shell swaps a
// DOM-source module's lane card away, Canvas keeps that module's REAL card
// mounted in an off-screen host (<HeadlessSourceHost>), exactly the way the
// workflow camera manager already keeps `hiddenCard` cameras alive
// (./CameraSurface: "Hidden hosts park OFF-SCREEN (fixed, left:-9999px) rather
// than display:none/visibility:hidden: an off-screen video element is the same
// scenario as a canvas card scrolled out of view — decode + rVFC keep running").
//
// SCOPE — this is deliberately about REGISTRATION, not rendering. The pull-eval
// visibility gating ($lib/video/pull-eval) is untouched: an off-screen tile still
// costs zero draws, the chain still only runs when something OBSERVES it. What
// changes is that the source is ATTACHED and therefore CAN run.
//
// PURE + registry-free (a plain string set + one boolean), so it unit-tests with
// no GL, no DOM and no engine — and it lives OUTSIDE `lib/video/**`, so it is
// hash-transparent to the WebGL attest.

import type { LaneRenderKind } from './legacy-fallback';

/**
 * Video module TYPES whose engine handle is fed by a CARD-OWNED DOM element via
 * `VideoEngine.attachExternalSource` — i.e. the card mount IS the source
 * lifecycle. Kept in sync with reality by a GREP GATE
 * (dom-source-modules.test.ts): the set must equal exactly the set of module
 * types whose resolved card component calls `attachExternalSource`, so a NEW
 * DOM-source module cannot ship dark under the shell.
 *
 * Note `cameraInput` is listed here even though it is ALSO a
 * NON_SHELL_LANE_TYPE (its real card always renders in the lane, so it is never
 * swapped and never needs the headless host — see `needsHeadlessSourceMount`,
 * which returns false for the 'legacy' kind). It stays in the set because the
 * set documents "this module's source lives on its card", which is true of
 * cameraInput and is exactly WHY it earned the carve-out.
 */
export const DOM_SOURCE_LANE_TYPES: ReadonlySet<string> = new Set<string>([
  'archivist',
  'cameraInput',
  'frametable',
  'loopback',
  'peertube',
  'tvLibrarian',
  'videobox',
  'videocube',
  'videovarispeed',
]);

/**
 * Module TYPES whose card is the SOLE WRITER of engine-visible state that is
 * not a DOM media element — the PRODUCER half of the same rule (#1587).
 *
 * The DOM-source set above is about a `<video>`/`<img>` the card ATTACHES.
 * These modules attach nothing: their card runs a rAF loop that PUSHES the
 * picture (or an analysis of it) into the module's own engine handle. Same
 * invariant, different seam — and the same failure when the shell swaps the
 * card away, except worse, because there is no "the user loaded a file" step
 * to make it look like a user action caused it. A SAVED rack renders dark on
 * LOAD, before anything is touched:
 *
 *   wavesculpt   the card installs a frame drawer
 *                (`installWavesculptFrameDrawer`) that blits its WebGL ribbon
 *                render into the canvas the audio→video texture bridge hands
 *                it. With no drawer installed the module's own `drawFrame`
 *                fills the canvas SOLID BLACK, so `WAVESCULPT.video_out →
 *                VIDEO OUT` is a black screen. MEASURED with the card never
 *                mounted: nonBlack 0/3072 px, maxLuma 0, ONE distinct frame
 *                signature across 42 rAF frames.
 *   timelorde    the card composites its big display (the patched video_in
 *                feed, else the beat-pulsing owl) and pushes it with
 *                `write(node,'displayFrame')`. Unpushed, `drawFrame` paints
 *                the #07090d idle field. MEASURED never-mounted: nonBlack 0,
 *                maxLuma 8 (that idle colour), 1 distinct signature / 42
 *                frames; with the card mounted: nonBlack 2944/3072, maxLuma
 *                232, 4 distinct signatures over 6 samples.
 *   synesthesia  the card samples the two video inputs and pushes
 *                `write(node,'video_levels_a'/'_b')` — the AUDIO-domain
 *                outputs of a video→audio module. Unmounted, the levels
 *                freeze at whatever was last sampled (or never leave zero),
 *                so its audio outs are dead in the common case. Same seam,
 *                same fix; it is a DERIVED member of this set, not a
 *                judgement call (see the gate).
 *   scope        the card reads `readParam` (the knob PLUS the engine's own
 *   rasterize    per-port CV tap) and pushes `write(node,'cvCombined')`, which
 *                is how a SAME-DOMAIN cv cable reaches a DISPLAY param at all:
 *                `AudioEngine.addEdge` connects to the AudioParam and never
 *                calls `setParam`, and the per-frame CV bridge exists only on
 *                the video side (#1664).
 *
 *                ⚠ THESE TWO DEGRADE, THEY DO NOT GO DARK, and the distinction
 *                is load-bearing rather than a hedge. Both render their picture
 *                inside the MODULE from its own analysers, so an unmounted card
 *                still produces a full, moving, correct trace/raster. So they
 *                are members for the LIFETIME half of this rule (keep the card
 *                alive in the headless host and the cable is honoured) and NOT
 *                for the "renders black" half. A future reader comparing them
 *                against wavesculpt's measured `nonBlack 0/3072` should expect
 *                a normal picture here, not a black one; that is not this set
 *                being wrong.
 *
 *                ⚠⚠ CORRECTED (#1583 verify pass). This paragraph used to say
 *                an unmounted card "draws every display param at its KNOB,
 *                ignoring any patched cv cable". THAT IS NOT WHAT HAPPENS, and
 *                the error mattered in the direction this epic cares about.
 *                `$lib/audio/cv-shadow` `read()` returns `combined ??
 *                knobValue`, and `combined` is cleared ONLY by `set()` — a
 *                KNOB MOVE. Nothing clears it when the pump stops. So a param
 *                that was under CV when the card went away LATCHES AT ITS LAST
 *                MODULATED VALUE indefinitely; it does not fall back to the
 *                knob. "Degrades to the knob" is a graceful story with a
 *                self-limiting failure; "latches wherever the LFO happened to
 *                be" is the stuck-value shape, and it is what ships. The
 *                picture is still full and moving either way, so the black-vs-
 *                degrade distinction above stands — only the description of
 *                the degraded VALUE was wrong.
 *
 *                The durable fix is an engine-side same-domain equivalent of
 *                `addCrossDomainCvBridge`, which would take both out of this
 *                set entirely — the node-lifetime EPIC #1583 is the right home.
 *
 * DERIVED, never hand-maintained: dom-source-modules.test.ts greps every card
 * component for these producer seams and asserts this set is EXACTLY what it
 * finds, so a new producer-on-the-card module cannot ship dark either.
 *
 * ⚠ This is deliberately NOT folded into DOM_SOURCE_LANE_TYPES. That set has
 * other consumers with genuinely media-specific meaning — the collapse-keeps-
 * playing sweep (spawns each member as a video-domain node and drives a file
 * player) and the face-migration inventory (asserts every member declares the
 * `needs-media-controller` blocker). None of these three owns a media element,
 * and none of them is blocked from a face by one.
 */
export const CARD_PRODUCER_LANE_TYPES: ReadonlySet<string> = new Set<string>([
  'rasterize',
  'scope',
  'synesthesia',
  'timelorde',
  'wavesculpt',
]);

/**
 * The union: every type whose ENGINE-VISIBLE state depends on its card being
 * mounted somewhere, for either reason. This is what the headless host filters
 * on — the decision below is the same for both halves, because the rule is the
 * same: the engine state of a rack must not depend on which UI renders it.
 */
export const HEADLESS_MOUNT_LANE_TYPES: ReadonlySet<string> = new Set<string>([
  ...DOM_SOURCE_LANE_TYPES,
  ...CARD_PRODUCER_LANE_TYPES,
]);

/** Inputs to the headless-mount decision. */
export interface HeadlessSourceInput {
  /** What the lane decided to render for this node (./legacy-fallback). */
  kind: LaneRenderKind;
  /** The module type id. */
  type: string;
  /**
   * TRUE when the lane emits NO xyflow node at all for this node, so `kind`
   * describes a card that is never reached — today, a child of a COLLAPSED
   * GROUP (#1721).
   *
   * ⚠ THE ONE ARM THAT IS NOT SHELL-SPECIFIC. Every other input here is a
   * consequence of the faceplate shell, and the whole decision is a strict
   * no-op under `?shell=legacy`. This one is not: Canvas's `flowNodes`
   * derivation drops a collapsed group's children OUTSIDE its `shellFaces`
   * branch, so a producer in a collapsed group has no card in EITHER shell.
   * MEASURED on `main` (wavesculpt.video_out → VIDEO OUT, 64×48 probe of the
   * module's own `drawFrame`, 20 rAF frames): before grouping `nonBlack
   * 170/3072, maxLuma 203, 20 distinct signatures` under the default shell and
   * `172/3072, 206, 20` under `?shell=legacy`; after the group collapses,
   * `0/3072, 0, 1 signature` in BOTH.
   */
  laneOmitsNode?: boolean;
  /**
   * TRUE when SOME OTHER live surface already mounts this node's real card, so
   * hosting it here would be a second mount of one node. The caller owns the
   * question; the decision only has to honour it.
   *
   * Today's one producer of it: `GroupCard` hidden-mounts a viz-passthrough
   * child's real card for exactly as long as the group is COLLAPSED
   * (`$lib/ui/modules/group-viz-hosts` — SCOPE), which is precisely the window
   * `laneOmitsNode` is true in. Measured on `main`: collapsing a group around
   * SCOPE leaves `viz-hidden-mount` count 1 and its picture unchanged
   * (`nonBlack 3072/3072, maxLuma 151`) in both shells, so it needs no host and
   * must not get one.
   */
  hostedElsewhere?: boolean;
}

/**
 * Does this node need its REAL card kept alive in the off-screen host?
 *
 * TRUE only when BOTH hold:
 *   - the module's engine state lives on its card — either because the card
 *     ATTACHES the source (DOM_SOURCE_LANE_TYPES) or because the card IS the
 *     producer (CARD_PRODUCER_LANE_TYPES) — AND
 *   - no surface renders that card:
 *       * `laneOmitsNode` — the lane emits no node AT ALL (a collapsed group's
 *         child) → YES, but only for the PRODUCER half; see below,
 *       * 'shell' / 'placeholder' — the shell swapped it out  → YES,
 *       * 'legacy' — the card IS in the lane (?shell=legacy, or a
 *         NON_SHELL carve-out like cameraInput/videoOut) → no,
 *       * 'stub'   — the user DOCKED it, so the real card is mounted in the
 *         dock rail (DockCardHost) → no. Double-mounting would run TWO
 *         getUserMedia / two <video> elements for one node, and whichever
 *         unmounted last would detach the survivor's source.
 *
 * ⚠ WHY THE `laneOmitsNode` ARM IS CHANNEL-AWARE, AND WHY IT REVERSES NOTHING.
 * The collapsed-group skip it replaces (Canvas.svelte, 72e062cf1) was written
 * for THIS set when the set was DOM-SOURCE ONLY, and its stated reason —
 * "those render no lane card in preview-off EITHER, so hosting them would ADD
 * engine state the shell-off rack doesn't have" — is a PARITY argument, and it
 * is correct. Parity is two-sided, though: it requires the two shells to
 * AGREE, not to agree on the broken value. Skipping was one way to satisfy it
 * (both shells dark); hosting in BOTH is the other, and it is the only one that
 * also satisfies the rule THIS FILE encodes. #1587 then widened the set to
 * include the producer half without revisiting the skip.
 *
 * The DOM-source half keeps the old behaviour verbatim, and that half of the
 * original reasoning still stands on its own: `node-media-registry` already
 * owns those elements across a card unmount, and hosting a CAMERA off-screen
 * because a group is collapsed would run `getUserMedia` with no UI anywhere —
 * the concrete harm the author was avoiding.
 *
 * PURE — same inputs, same output, no side effects. `kind` can only be
 * 'legacy'/'stub' under `?shell=legacy`, so every arm EXCEPT `laneOmitsNode` is
 * still a strict no-op there.
 */
export function needsHeadlessSourceMount(i: HeadlessSourceInput): boolean {
  if (!HEADLESS_MOUNT_LANE_TYPES.has(i.type)) return false;
  if (i.hostedElsewhere) return false;
  if (i.laneOmitsNode) return CARD_PRODUCER_LANE_TYPES.has(i.type);
  return i.kind === 'shell' || i.kind === 'placeholder';
}
