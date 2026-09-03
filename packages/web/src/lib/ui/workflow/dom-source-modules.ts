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
 * `VideoEngine.attachExternalSource` AND whose ENGINE KEEPS that element — i.e.
 * the card mount IS the source lifecycle. Kept in sync with reality by a GREP
 * GATE (dom-source-modules.test.ts), which reads BOTH halves off the tree, so a
 * NEW DOM-source module cannot ship dark under the shell.
 *
 * ⚠ THE SECOND HALF IS NOT DECORATION, and leaving it out is how `frametable`
 * and `videocube` sat here wrongly. "The card calls attachExternalSource" says a
 * card HANDS an element over; it cannot say whether the engine keeps it, and
 * those are different files with different answers. Both of those modules stage
 * a decoded `.frametable.png` atlas into a `pendingAtlas` slot at FILE LOAD; the
 * next draw detiles it into GL and nulls the reference. Their live pictures come
 * from GRAPH CABLES (`video_in`; `video_a|b|c`), so no card mount is load-
 * bearing and neither ever needed the headless host. The gate now derives
 * retention from the engine-side attach body (a rVFC subscription, the texture
 * uploader, an element keep-alive, or a retained `mediaEl`).
 *
 * Deny-by-default runs in the direction that costs: the DEFAULT is that a module
 * retains. Excluding one takes a NAMED `ONE_SHOT_INGEST` entry carrying its
 * `why`, anchored so it reddens the day that module starts keeping its element.
 *
 * ⚠ `cameraInput` USED TO BE THE EXCEPTION IN THIS SET AND IS NOT ANY MORE. The
 * note here said it "is never swapped and never needs the headless host",
 * because it was ALSO in `NON_SHELL_LANE_TYPES` and its real card therefore
 * always rendered in the lane. That carve-out was removed when the module was
 * promoted (see ./legacy-fallback, which carries the full lineage), so
 * cameraInput is now an ORDINARY member: the shell swaps its lane card for a
 * faceplate, `needsHeadlessSourceMount` returns true for the resulting 'shell'
 * kind, and `<HeadlessSourceHost>` keeps the real card — and therefore
 * getUserMedia, the stream and the permission machine — alive off-screen. It is
 * the FIRST member of this set to be promoted, so it is also the first to
 * exercise that path for real.
 */
/**
 * ⚠ VIDEOBOX (P1), VIDEOVARISPEED (P2) AND THE HLS PAIR — PEERTUBE +
 * TVLIBRARIAN (P3) — HAVE LEFT THIS SET (LEG-02, #1511). Four departures, one
 * shape, and every remaining member follows it.
 *
 * ⚠ P3 IS THE PHASE WHERE THE SET STOPS BEING ABOUT FILE PLAYERS. peertube and
 * tvLibrarian own a NETWORK stream — an hls.js demuxer feeding a `<video>` —
 * and both were card-owned in exactly the way videobox was, with the same three
 * classes of consequence. The one worth reading before touching either module:
 * with NO card anywhere (a collapsed group, a canvas-hidden node) the modules
 * were not degraded, they were DEAD — no attach, so `video` is black; no CV
 * poll, so `play_trigger`/`next_trigger` and `next`/`random` do nothing; no
 * selection effect, so a SAVED rack came back on nothing and a peer's tune never
 * landed; no audio wire, so both audio outs were silent AND the element stayed
 * `muted`. Their new owner is `$lib/ui/media/node-hls-source-registry`, which is
 * ONE registry with two profiles rather than a sibling per module — see its
 * header for why the P2 "do not generalise on a population of two" argument
 * points the other way here.
 *
 * ⚠ VARISPEED'S DEPARTURE FIXED THREE LIVE DEFECTS RATHER THAN JUST MOVING A
 * LIFETIME, and they are worth naming because they are what card-ownership
 * actually costs: a varispeed inside a COLLAPSED GROUP had no card anywhere
 * (`needsHeadlessSourceMount` returns false on the `laneOmitsNode` arm for a
 * non-producer), so its transport and all five CV triggers — including the
 * ASSET slot select a clip player drives — were dead with the jacks still
 * visibly patched; `activeSlot` and its seven virtual playheads reset on every
 * expand/collapse; and a rack saved WITH a crop applied none on load. The
 * headless host was MASKING those in the common case, which is worse than the
 * per-rack tax it was introduced to pay.
 *
 * Nothing about videobox's PICTURE changed. What changed is who owns the
 * lifecycle: `$lib/ui/media/node-video-source-registry` now owns the element's
 * attach, its audio wiring, the multiplayer drift loop, the `play_trigger` gate
 * loop, the sync→element application and the saved-handle restore, on GRAPH
 * lifetime via Canvas's sync/sweep effects. `VideoboxCard.svelte` creates
 * nothing and disposes nothing, so its subtree no longer calls
 * `attachExternalSource(` at all — which is what the grep gate below reads, and
 * why this deletion and that card edit are ONE atomic change.
 *
 * ⚠ ITS ABSENCE IS NOW A GATE-ANCHORED STATEMENT, exactly like picturebox's
 * absence from `CARD_PRODUCER_LANE_TYPES`: the set is DERIVED, so videobox being
 * missing here is not a list someone forgot to update — it is the tree asserting
 * that no card mount is load-bearing for that module. The new owner is anchored
 * in the other direction by `NODE_VIDEO_SOURCE_TYPES`, which the registry's own
 * test asserts is DISJOINT from this set: a module in both would mean two owners
 * for one element.
 *
 * ⚠ LOOPBACK HAS LEFT TOO (legacy-removal S1, 2026-09-03) — the fifth departure,
 * and the first one taken for the CARD's sake rather than the module's.
 *
 * The four before it left because card ownership was measurably BREAKING those
 * modules (varispeed's dead CV triggers, the HLS pair's silent audio outs).
 * Loopback was not broken: the headless host kept its card mounted and the
 * capture survived. It left because a card that is load-bearing is a card that
 * cannot be deleted, and every `*Card.svelte` is being removed.
 *
 * That difference is worth keeping in view rather than flattening into the same
 * sentence as the others, because it changes what a reader should expect from
 * the diff: there is no measured defect story here and there does not need to
 * be one. The argument is structural. A capture surviving a collapse, a dock
 * move, a group collapse or a shell flip is CONTENT, and every one of those is
 * a VIEW event — tie the two together and some view event becomes a content
 * event by accident. The headless host was the workaround for exactly that
 * accident, and this removes the need for it rather than the symptom.
 *
 * Its new owner is `$lib/ui/media/node-loopback-source-registry` on GRAPH
 * lifetime, synced from `Canvas.svelte` beside the other four registries. The
 * status seam (`loopback-status-registry`) is UNCHANGED and the faceplate is
 * untouched — what moved is who publishes into it and who owns the commands.
 *
 * ⚠ AND CAMERAINPUT WITH IT, in the same slice and for the same structural
 * reason. Its departure is the widest of the five, because the card owned more
 * than an element: the device roster, the saved-device rebind, the permission
 * state machine and the multiplayer presence badge all lived there. Three of
 * those were already WRONG to live on a card and the file said so in its own
 * comments — the acquire guards ran on a CARD MOUNT rather than when the node
 * entered the graph, and the presence badge was removed in `onDestroy`, so it
 * described "a card is on screen" while claiming to describe "a camera is live".
 * Both are now the node's. Its new owner is
 * `$lib/ui/media/node-camera-source-registry`.
 *
 * ⚠ AND ARCHIVIST WITH THEM, WHICH LEAVES THIS SET EMPTY (legacy-removal S1,
 * 2026-09-03). That is a state worth reading carefully rather than as an
 * absence, because an empty set changes what several gates can say.
 *
 * WHAT IT ASSERTS: no module's engine-visible SOURCE depends on a card being
 * mounted any more. Every one of the five former members has a node-scoped
 * controller under `$lib/ui/media/`, and `dom-source-modules.test.ts` holds that
 * in both directions — each type is absent here AND present in exactly one
 * node-owner set, so a module cannot leave without an owner taking it.
 *
 * ⚠ WHAT IT STOPS BEING ABLE TO ASSERT, stated because an empty derived set is
 * the classic silent-vacuity shape: the grep gate that derives this set from the
 * cards now compares [] to [] on the DOM-source half. Its POSITIVE CONTROL is
 * what keeps it honest — the gate feeds itself a synthetic card that attaches a
 * retained element and requires the derivation to REFUSE it. Read that leg
 * before trusting a green run here, and do not "simplify" the derivation away
 * on the grounds that it always produces nothing.
 *
 * ⚠ THE SET IS NOT DELETED, and it must not be while the PRODUCER half exists.
 * `HEADLESS_MOUNT_LANE_TYPES` is the union of this and
 * `CARD_PRODUCER_LANE_TYPES`, and the producer half still has six members whose
 * cards ARE the producer. `needsHeadlessSourceMount` still returns true for
 * those. When the producer extractions land, THAT is the moment to ask whether
 * the headless host itself can go — not now.
 */
export const DOM_SOURCE_LANE_TYPES: ReadonlySet<string> = new Set<string>([]);

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
 *   cube         (#1724) the SAME seam as wavesculpt, on the same registry, and
 *                invisible to the gate for a reason worth keeping: the drawer is
 *                installed from `modules/cube/CubeVizSurface.svelte`, and the
 *                gate's file walk was flat + `*Card.svelte`-filtered, so the
 *                pattern matched a file nothing read. `CubeVizSurface` is THE
 *                cube renderer (the legacy card and the faceplate hero are two
 *                mounts of it, not two renderers), and cube's own `drawFrame`
 *                paints SOLID BLACK when no drawer is registered — cube.ts:84
 *                says so outright. MEASURED on `CUBE.video_out → VIDEO OUT`,
 *                same probe and same port in every phase: never-mounted
 *                nonBlack 0/3072 px maxLuma 0; dock full-view open 3072/3072
 *                maxLuma 212; collapsed again 0/3072; `?shell=legacy` (real card
 *                in the lane) 3072/3072.
 *
 *                ⚠ cube is MIGRATED, so its lane kind is 'shell', not
 *                'placeholder' — and that is not a reprieve. `curatedFace` drops
 *                `face.hero.cell` from the lane order (`laneOrder`, PF-22: a
 *                280px panel cannot paint in a 46px knob column), and cube's
 *                hero cell IS `cube-view-{n}` — the surface. So the lane tile
 *                mounts no renderer at all and the picture exists only inside
 *                the dock full-view. A migrated face is not evidence that a
 *                producer is mounted.
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
 *   rasterize    the card reads `readParam` (the knob PLUS the engine's own
 *                per-port CV tap) and pushes `write(node,'cvCombined')`, which
 *                is how a SAME-DOMAIN cv cable reaches a DISPLAY param at all:
 *                `AudioEngine.addEdge` connects to the AudioParam and never
 *                calls `setParam`, and the per-frame CV bridge exists only on
 *                the video side (#1664).
 *
 *                ⚠ THIS ONE DEGRADES, IT DOES NOT GO DARK, and the distinction
 *                is load-bearing rather than a hedge. It renders its picture
 *                inside the MODULE from its own analysers, so an unmounted card
 *                still produces a full, moving, correct raster. So it is a
 *                member for the LIFETIME half of this rule (keep the card
 *                alive in the headless host and the cable is honoured) and NOT
 *                for the "renders black" half. A future reader comparing it
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
 * ⚠ SCOPE HAS LEFT THIS SET (legacy-removal S1, 2026-09-03) — the first
 * PRODUCER departure, and the shape every remaining one follows.
 *
 * Its push is now `$lib/ui/media/frame-producers`' `SCOPE_FRAME_PRODUCER`,
 * owned by `$lib/ui/media/node-frame-producers` on GRAPH lifetime and synced
 * from `Canvas.svelte` beside the other node-keyed owners. The rule that made
 * `scope` a member has not changed and is not weakened — the module's engine
 * state must not depend on which UI renders it. What changed is WHO satisfies
 * it: an off-screen card mount was the workaround, and a node-lifetime owner is
 * the fix, exactly as it was for the five DOM-source departures above.
 *
 * ⚠ AND THE TRACE MOVED WITH IT, WHICH IS THE HALF A READER WILL LOOK FOR. The
 * picture is `modules/scope/ScopeTraceSurface.svelte` now — one renderer for the
 * legacy card, the faceplate body and `GroupCard`'s viz-passthrough mount, where
 * there were three copies of `drawScope` before. That surface WRITES NOTHING,
 * which is the property the gate below reads: with no producer seam anywhere in
 * `ScopeCard`'s subtree, `scope`'s absence here is DERIVED rather than deleted.
 * It also retired the `GroupCard → ScopeCard.svelte` subtree exemption, because
 * the group mounts the surface directly and no longer reaches a card at all.
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
  'cube',
  'rasterize',
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
   * describes a card that is never reached. TWO producers of it, and they are
   * the same fact by different routes:
   *   * a child of a COLLAPSED GROUP (#1721), and
   *   * a CANVAS-HIDDEN node — a pinned singleton or a `hiddenCard` camera
   *     (`$lib/graph/hidden-card`), which the same `flowNodes` derivation skips
   *     (#1754).
   *
   * ⚠ THE SECOND ONE WAS A `continue` IN THE CALLER FOR A YEAR, AND THAT IS
   * WHY IT WENT UNFIXED. The skip's premise — "some other surface mounts the
   * real card" — is true for the M/E/C drawer trio and FALSE for a pinned
   * TOPBAR-SURFACE module, which has no drawer and no rail at all. MEASURED on
   * this tree, both shells: a fresh `/rack` auto-spawns `pinned-timelorde` and
   * `.mod-card.timelorde-card` has ZERO mounts anywhere, so its
   * `write(node,'displayFrame')` never runs and `video_out` is the idle field
   * forever (`nonBlack 0/3072, maxLuma 8, 1 distinct signature over 30 frames`
   * — recorded in card-producer-lifetime.spec.ts, which names this exclusion as
   * the half it does not cover). Routing it through THIS arm rather than a
   * second `CARD_PRODUCER` test in the caller is what keeps the hidden CAMERAS'
   * answer (no host — they are DOM_SOURCE) coming from one place.
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
 *       * 'legacy' — the card IS in the lane (?shell=legacy, or a NON_SHELL
 *         carve-out) → no,
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
/**
 * CARD_PRODUCER types whose FACEPLATE mounts the producing surface ITSELF, so a
 * dock full view showing that faceplate really is "some other surface already
 * mounts this node's real card" and hosting it too would be a SECOND mount.
 *
 * ⚠ DENY BY DEFAULT, AND THE DEFAULT WAS THE OTHER WAY ROUND UNTIL 2026-08-23.
 * `Canvas.svelte`'s `fullViewShowsFaceInstead` was scoped to
 * `DOM_SOURCE_LANE_TYPES` only, on the stated grounds that the producer half
 * "is left EXACTLY as it was… because it would be UNMEASURED" — and that was
 * right at the time, because the only two promoted producers (cube, rasterize)
 * DO mount their renderer from the face: `CubeVizSurface` IS cube's renderer,
 * and rasterize's body advances the painter inside `read('imageData')`.
 *
 * ⚠ TIMELORDE IS THE FIRST PROMOTED PRODUCER WHOSE FACE ONLY *BLITS*, and it
 * turns that premise false. Its `fullViewBody` pulls `video_out`'s own
 * `drawFrame`; the thing that FILLS `drawFrame` is `TimelordeCard`'s rAF, which
 * lives nowhere else. MEASURED with the dock full view open on a promoted
 * timelorde, before this set existed: `.mod-card.timelorde-card` count 0, no
 * headless host, and the face canvas painting `nonBlack 47034/48400` — a
 * perfectly bright picture that was a STALE bitmap the unmounted card had
 * pushed before it went away, frozen for as long as the dock stayed open. On a
 * cold open, where no frame had been pushed yet, the same state paints the
 * module's `#07090d` idle field instead: black, and a VRT baseline captured
 * then would have pinned a black square forever.
 *
 * So the default is now "a faced producer KEEPS its headless host while its dock
 * full view is open", and a module leaves that default by NAME, with the reason
 * it can. A new promotion inherits the safe answer instead of the silent one.
 */
export const FACE_MOUNTS_PRODUCER: ReadonlySet<string> = new Set<string>([
  // The hero cell IS the renderer — `CubeVizSurface`, the same component the
  // legacy card mounts. Two mounts of it is what this exemption prevents.
  'cube',
  // The body ADVANCES the painter (`read('imageData')` runs it), so it is not
  // merely a viewer of the producer: while the dock is open it IS the producer.
  'rasterize',
]);

export function needsHeadlessSourceMount(i: HeadlessSourceInput): boolean {
  if (!HEADLESS_MOUNT_LANE_TYPES.has(i.type)) return false;
  if (i.hostedElsewhere) return false;
  if (i.laneOmitsNode) return CARD_PRODUCER_LANE_TYPES.has(i.type);
  return i.kind === 'shell' || i.kind === 'placeholder';
}
