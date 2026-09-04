// packages/web/src/lib/ui/workflow/dom-source-modules.test.ts
//
// The DOM-SOURCE drift GATE — pure-unit, zero-flake, no GL / no DOM.
//
// The owner P0 it pins: under `?shell=1` the lane renders a tile INSTEAD of a
// module's legacy card, and for the minority of video modules whose pixels come
// from a CARD-OWNED `<video>`/`<img>` handed to the engine via
// `attachExternalSource`, that silently killed the SOURCE — camera → OUTPUT (and
// videobox / archivist / … → OUTPUT) was patched-but-black while the engine node
// itself existed. The fix keeps those cards mounted off-screen
// (<HeadlessSourceHost>) or, for cameraInput, keeps the real card in the lane
// (NON_SHELL_LANE_TYPES).
//
// Both fixes are driven off DOM_SOURCE_LANE_TYPES, so the ONE way this can
// regress is a NEW (or renamed) DOM-source module missing from the set. Test 1
// closes that hole MECHANICALLY: it greps every card component for a real
// `attachExternalSource(` call and asserts the derived type set is EXACTLY the
// declared set — a new source module cannot ship dark under the shell.
//
// ── #1587: THE SAME HOLE, A DIFFERENT SEAM ────────────────────────────────────
// `attachExternalSource` turned out to be one of THREE ways a card can be the
// only reason a module's engine state exists. WAVESCULPT installs a frame
// DRAWER; TIMELORDE and SYNESTHESIA `write()` state straight into the node. All
// three shipped black/frozen under the shell, and this gate — which read one
// seam — was structurally unable to see any of them.
//
// ⚠ THE LESSON, stated so the next widening is done the same way: the predicate
// is now a NAMED, TYPED list of seams (PRODUCER_SEAMS), each carrying its own
// `why`, and BOTH sets are re-derived from the card sources and asserted
// EXACTLY. Adding a seam re-derives membership — you do not hand-add a type.
//
// WHAT THIS GATE STILL CANNOT SEE, stated inside the gate (see the SCOPE test):
//   * a card that produces engine state through a seam not in PRODUCER_SEAMS —
//     a genuinely new fourth mechanism. Nothing here can invent that name; the
//     e2e (e2e/tests/card-producer-lifetime.spec.ts) is the behavioural net.
//   * a MENTION of a seam inside a comment or a string literal. These are
//     regexes, not a parser. The NEGATIVE CONTROL below pins the prose forms
//     that actually occur in these cards.
//   * whether the mounted card's producer WORKS. That is pixels, and it is the
//     e2e's job.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import '$lib/audio/modules';
import '$lib/video/modules';
import '$lib/meta/modules';

import { listModuleDefs } from '$lib/audio/module-registry';
import { listVideoModuleDefs } from '$lib/video/module-registry';
import { listMetaModuleDefs } from '$lib/meta/module-registry';
// ONE string-aware implementation, imported rather than re-written — see codeOf().
import { stripComments } from '$lib/ui/media/card-media-lifetime.test';

import { CARD_PRODUCER_LANE_TYPES, DOM_SOURCE_LANE_TYPES } from './dom-source-modules';
// The OTHER side of the ownership question (LEG-02, #1511). Imported here rather
// than asserted from a second copy of the list, so "who owns this module's
// source" has exactly one answer per module and this gate can check it.
import { NODE_VIDEO_SOURCE_TYPES } from '$lib/ui/media/node-video-source-registry';
import { NODE_VARISPEED_TYPES } from '$lib/ui/media/node-varispeed-registry';
import { NODE_HLS_SOURCE_TYPES } from '$lib/ui/media/node-hls-source-registry';
import { NODE_LOOPBACK_SOURCE_TYPES } from '$lib/ui/media/node-loopback-source-registry';
import { NODE_CAMERA_SOURCE_TYPES } from '$lib/ui/media/node-camera-source-registry';
import { NODE_ARCHIVIST_SOURCE_TYPES } from '$lib/ui/media/node-archivist-source-registry';
// ⚠ AND THE PRODUCER SIDE (legacy-removal S1). The six above own a module's
// SOURCE — an element, a stream, a transport. This one owns its per-frame PUSH,
// which is the OTHER half of `HEADLESS_MOUNT_LANE_TYPES` and needs exactly the
// same two-directional check: a type that leaves `CARD_PRODUCER_LANE_TYPES` must
// be owned here, and a type owned here must have left. Importing it is what
// makes a producer extraction atomic — neither half can land alone.
import { NODE_FRAME_PRODUCER_TYPES } from '$lib/ui/media/frame-producers';
// ⚠ AND THE PRODUCERS THAT ARE A MOUNTED COMPONENT rather than a callback
// (legacy-removal S1). Same two-directional obligation as the line above; the
// only difference is HOW the node owns the work. See
// `$lib/ui/media/node-viz-surface-registry` for why wavesculpt's WebGL2 renderer
// could not become a `FrameProducer`.
import { NODE_VIZ_SURFACE_TYPES } from '$lib/ui/media/node-viz-surfaces';

/** Every node-scoped owner there is — SOURCES and per-frame PRODUCERS alike.
 *  Read as ONE set wherever the question is "has SOMETHING taken ownership of
 *  the engine state this module's card used to own", so a new registry joins by
 *  being imported here rather than by an edit at each of the sites below. */
const NODE_OWNED_SOURCE_TYPES: ReadonlySet<string> = new Set<string>([
  ...NODE_VIDEO_SOURCE_TYPES,
  ...NODE_VARISPEED_TYPES,
  ...NODE_HLS_SOURCE_TYPES,
  ...NODE_LOOPBACK_SOURCE_TYPES,
  ...NODE_CAMERA_SOURCE_TYPES,
  ...NODE_ARCHIVIST_SOURCE_TYPES,
  ...NODE_FRAME_PRODUCER_TYPES,
  ...NODE_VIZ_SURFACE_TYPES,
]);
import { STRICT_FACES } from './strict-faces';
import { NON_SHELL_LANE_TYPES, laneRenderKind, type LaneRenderKind } from './legacy-fallback';

/** The card directory the glob resolver reads (../modules relative to here). */
const CARD_DIR = fileURLToPath(new URL('../modules/', import.meta.url));
/** `$lib` — a card may mount a child component through the alias rather than a
 *  relative path (`$lib/ui/controls/Knob.svelte`), and a walk that resolved only
 *  relative specifiers would stop at the first aliased edge. */
const LIB_DIR = fileURLToPath(new URL('../../', import.meta.url));

/** A REAL call, not a mention in prose: `attachExternalSource(` / `?.(`.
 *  (Comments in these cards say "attachExternalSource" without parens, and the
 *  card-side calls always look like `ve?.attachExternalSource(` /
 *  `engine.attachExternalSource(`.) */
const CALL_RE = /attachExternalSource\s*\(/;

// ── #2149 follow-up: "THE CARD CALLS attachExternalSource" WAS THE WRONG HALF ──
//
// The card side says a card HANDS an element to the engine. It cannot say
// whether the engine KEEPS it. Those are different modules with different
// answers, and this set is about the second one: `HeadlessSourceHost` exists so
// a LIVE source keeps decoding when the shell swaps the card away. A module the
// engine consumes ONCE and drops needs nothing kept alive.
//
// MEASURED over all nine attaching modules, on the engine-side implementations:
//
//   archivist camera-input loopback peertube tv-librarian videobox
//   videovarispeed   → RETAIN. The element is stored and per-frame delivery is
//                      wired for it: `attachRvfc()` (a requestVideoFrameCallback
//                      subscription), `uploader.attach(el)` (the shared texture
//                      uploader), an audio keep-alive, or `mediaEl = el` for the
//                      audio graph. Unmount the card and the picture dies.
//   frametable videocube → ONE-SHOT. The element goes into a `pendingAtlas`
//                      STAGING slot, the next draw detiles it into GL and sets
//                      `pendingAtlas = null` (frametable.ts, videocube.ts). It
//                      is a FILE IMPORT, not a source. Both modules' live
//                      pictures come from GRAPH CABLES (`video_in`;
//                      `video_a|b|c`), which no card mount affects.
//
// ⚠ AN EARLIER PREDICATE FOR THIS WAS MEASURED AND DISCARDED, and it is written
// down because it looks right: "the module assigns its stored element `null`
// somewhere outside the attach body" — i.e. consume-and-drop. Run over all nine
// it returns TRUE FOR EVERY ONE, because they all null the reference on
// detach/dispose. It would have classified the whole set as one-shot and emptied
// the headless host. Retention has to be read from what the attach body WIRES,
// not from what the file later clears.
//
// ⚠ DENY-BY-DEFAULT IN THE DIRECTION THAT COSTS: the default is RETAINS. A
// module whose attach body matches no retention seam is NOT quietly dropped from
// the set — it must be NAMED in ONE_SHOT_INGEST with a `why`, or the derivation
// leg reddens. That way a genuinely new live source wired a fifth way gets the
// headless mount (the safe answer) instead of shipping dark, which is the P0
// this whole file exists for.

/** ONE way an engine-side `attachExternalSource` wires the element for
 *  PER-FRAME delivery — the property that makes a card's mount load-bearing.
 *  Typed, so `tsc` refuses a seam added without its `why`. */
interface RetentionSeam {
  readonly id: string;
  readonly re: RegExp;
  readonly why: string;
}

const SOURCE_RETENTION_SEAMS: readonly RetentionSeam[] = [
  {
    id: 'attachRvfc()',
    re: /\battachRvfc\s*\(/,
    why:
      'a requestVideoFrameCallback subscription ON the attached element — the module is pulled ' +
      'once per DECODED FRAME for as long as that element lives, which is the definition of a ' +
      'live source (camera-input, loopback, videovarispeed).',
  },
  {
    id: 'uploader.attach(el)',
    re: /\buploader\.attach\s*\(/,
    why:
      'the shared per-frame texture uploader is pointed AT the element, so every engine tick ' +
      'samples it into the module FBO (peertube, tv-librarian, videobox). NOT archivist — see ' +
      'codeOf(): the only `uploader.attach()` in its body is a comment saying it does not.',
  },
  {
    id: 'keep-alive on the element',
    re: /\bwireKeepAlive\s*\(|\bkeepAlives\.ensure\s*\(/,
    why:
      'an audio keep-alive is created FOR the element so its decode keeps running at full rate ' +
      'while other sources coexist — only meaningful for an element that must keep playing.',
  },
  {
    // ⚠ `\w` after the whitespace is LOAD-BEARING, not tidiness. Without it
    // `\s*` backtracks to consume ZERO spaces and the `(?!null\b)` lookahead
    // then tests the SPACE — which is trivially not `null` — so `mediaEl = null`
    // matched as a retention. The synthetic negative control below caught it.
    id: 'mediaEl = <element>',
    re: /\bmediaEl\s*=\s*(?!null\b)\w/,
    why:
      'the element is retained as the module\'s MEDIA element for the audio graph. archivist ' +
      'reaches this branch without texturing (archive.org video is CORS-tainted) — its picture ' +
      'is not sampled from the element but its AUDIO is, so the mount is still load-bearing. ' +
      'This is archivist\'s ONLY real retention seam: the `uploader.attach()` in its body is ' +
      'inside a comment saying it deliberately does NOT call it.',
  },
];

/**
 * ⚠ SEAMS ARE MATCHED AGAINST CODE, NEVER PROSE — and this is not a precaution,
 * it is a measured correction.
 *
 * ARCHIVIST's `attachExternalSource` body contains the literal text
 * `uploader.attach()` exactly once, inside the comment
 *
 *     // audio). We do NOT uploader.attach() a tainted element (that would
 *
 * — a sentence stating the OPPOSITE of what the seam claims to detect. Matched
 * raw, the gate reported archivist as retaining "uploader + mediaEl" when only
 * `mediaEl` is real. The verdict happened to survive; the evidence did not, and
 * a gate whose evidence is wrong is one edit from a wrong verdict.
 *
 * `stripComments` is IMPORTED rather than re-written: a `//`-stripping regex
 * eats `'https://…'`, and this repo has already paid for that once — there is
 * one string-aware implementation and this is a second caller of it, not a
 * second copy.
 */
function codeOf(body: string): string {
  return stripComments(body);
}

/**
 * Modules whose engine side treats the attached element as a ONE-SHOT IMPORT —
 * consumed into GPU state on the next draw and dropped. DENY BY DEFAULT: one
 * NAMED entry per module, every field required.
 *
 * ANCHORED TO THE ARTIFACT IN BOTH DIRECTIONS (see the tests): the engine file
 * must exist, its `attachExternalSource` must still match NO retention seam, and
 * the declared `dropSite` — the line that actually drops the element — must
 * still be in the file. If one of these modules ever starts retaining, its entry
 * goes RED and it returns to the DOM-source set rather than silently staying out
 * of it.
 */
interface OneShotIngest {
  /** Module type id. */
  readonly module: string;
  /** Its engine module file, relative to `$lib/video/modules/`. */
  readonly engineFile: string;
  /** The line that DROPS the staged element once consumed. */
  readonly dropSite: RegExp;
  /** Why a card unmount cannot cost this module anything. */
  readonly why: string;
}

const ONE_SHOT_INGEST: readonly OneShotIngest[] = [
  {
    module: 'frametable',
    engineFile: 'frametable.ts',
    dropSite: /\bpendingAtlas\s*=\s*null\b/,
    why:
      'FRAMETABLE\'s live picture is its `video_in` GRAPH CABLE, captured into a 60-layer ring. ' +
      'The card\'s only engine-visible write is a decoded .frametable.png atlas handed over at ' +
      'FILE LOAD; `detilePendingAtlas()` copies it into the ring on the next draw and nulls the ' +
      'reference. After that frame the card holds nothing the module reads — its rAF loop is a ' +
      'PREVIEW blit and writes nothing back.',
  },
  {
    module: 'videocube',
    engineFile: 'videocube.ts',
    dropSite: /\bpendingAtlas\[\s*slot\s*\]\s*=\s*null\b/,
    why:
      'the same shape as frametable, three times: VIDEOCUBE\'s live pictures are the `video_a` / ' +
      '`video_b` / `video_c` GRAPH CABLES, and the card mints a tagged atlas canvas per SLOT at ' +
      'file load (plus a 1x1 `videocubeClear` canvas to reset a slot to LIVE). `detilePending(slot)` ' +
      'consumes and nulls it. Its rAF loop is preview-only and writes nothing back.',
  },
];

/** The engine-module directory the retention check reads. */
const VIDEO_MODULE_DIR = fileURLToPath(new URL('../../video/modules/', import.meta.url));

/** The engine-side `attachExternalSource` METHOD body for a video module file,
 *  or null. Method-shaped on purpose: several of these files discuss
 *  `attachExternalSource(...)` in their header prose, and a looser match reads
 *  the COMMENT instead of the implementation. */
function engineAttachBody(engineFile: string): string | null {
  let src: string;
  try {
    src = readFileSync(join(VIDEO_MODULE_DIR, engineFile), 'utf8');
  } catch {
    return null;
  }
  const m = /^[ \t]*attachExternalSource\s*\(\s*\w+\s*,\s*\w+\s*\)\s*\{/m.exec(src);
  if (!m) return null;
  let depth = 0;
  let k = src.indexOf('{', m.index);
  for (; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return src.slice(m.index, k + 1);
}

/** The whole engine module source, for the drop-site anchor. */
function engineSource(engineFile: string): string | null {
  try {
    return readFileSync(join(VIDEO_MODULE_DIR, engineFile), 'utf8');
  } catch {
    return null;
  }
}

/** `<type>` → its engine module file, by the registry's own file naming. */
function engineFileFor(type: string): string | null {
  const kebab = type.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  for (const cand of [`${type}.ts`, `${kebab}.ts`]) {
    if (existsSync(join(VIDEO_MODULE_DIR, cand))) return cand;
  }
  return null;
}

const oneShotModules = new Set(ONE_SHOT_INGEST.map((x) => x.module));

/**
 * The PRODUCER seams — a card writing engine-visible state that is not a DOM
 * media element (#1587). Typed, so `tsc` refuses a seam added without its
 * `why`: the reason a seam belongs here is the only thing a reviewer of a
 * future widening actually needs, and a `why` that lives only in a commit
 * message is not available at the point of the edit.
 */
interface ProducerSeam {
  /** Short name, used in failure messages. */
  readonly id: string;
  /** Call-shaped, so a prose mention of the API name does not match. */
  readonly re: RegExp;
  /** Why a card matching this is the SOLE writer of some engine state. */
  readonly why: string;
}

const PRODUCER_SEAMS: readonly ProducerSeam[] = [
  {
    // ⚠ WIDENED FROM `write\s*\(\s*node\s*,` (#1720). That form was bound to
    // the IDENTIFIER `node`, and the engine ships TWO overloads —
    // `audio/engine.ts` `write(nodeId: string, …)` on the domain engine and
    // `write(node: ModuleNode, …)` on PatchEngine. A card reaching the domain
    // engine (`e.getDomain<VideoEngine>('video')`, which several already do) and
    // calling `ve.write(id, 'displayFrame', bmp)` produces IDENTICAL engine
    // state and matched nothing. No card did that at the time, so the set was
    // accurate — and one rename from silently emptying, with the vacuity guard
    // still green because the other members matched. The negative controls
    // below pin BOTH the widened matches and the shapes that must still miss.
    id: 'engine.write(node|id, …)',
    re: /\bwrite\s*\(\s*(?:node|id|nodeId)\s*,/,
    why:
      'the card pushes state INTO the module handle every rAF — TIMELORDE its composited ' +
      "display (`write(node,'displayFrame')`, the only writer of what video_out passes on) " +
      "and SYNESTHESIA its per-band video levels (`write(node,'video_levels_a'/'_b')`, the " +
      'only writer of what its AUDIO outputs carry). Unmount the card and the module keeps ' +
      'drawing/emitting its idle value forever. Matches BOTH engine overloads — the ' +
      'PatchEngine `write(node, …)` and the domain-engine `write(nodeId, …)`, which are the ' +
      'same engine state reached two ways.',
  },
  {
    id: 'install*FrameDrawer(…)',
    re: /\binstall\w*FrameDrawer\s*\(/,
    why:
      "the card registers a callback the module's own drawFrame delegates to — WAVESCULPT " +
      'blits its WebGL ribbon render through `installWavesculptFrameDrawer`. With no drawer ' +
      'registered the module fills the bridge canvas SOLID BLACK, so video_out is a black ' +
      'screen on a rack the user never touched.',
  },
];

// ⚠ THE CARD-WALK MACHINERY WENT WITH THE THREE DESCRIBES BELOW: the
// basename→type resolver, the recursive `CARD_DIR` subtree reader, the seam
// matcher and the two derivers built on them. Every one of them started from
// `readdirSync` over `*Card.svelte`, and that directory holds no cards.

// ─────────────────────────────────────────────────────────────────────────────
// ⚠ THREE DESCRIBES RETIRED WITH THE CARDS THEY WALKED (legacy-removal S4)
// ─────────────────────────────────────────────────────────────────────────────
//
// `THE WALK (#1724) — the gate reads what a card MOUNTS, not one file`,
// `DOM_SOURCE_LANE_TYPES — the grep gate (a new source module cannot ship dark)`
// and `CARD_PRODUCER_LANE_TYPES — the second seam (#1587: the card IS the
// producer)` all began by reading `*Card.svelte` off disk and resolving each
// basename back to a module type through the card map. Both are deleted, so all
// three walks resolve NOTHING — and an empty walk makes every set-equality below
// it agree about nothing and PASS. That is the vacuous-`all()` shape, and
// re-pointing the walk at the surviving surfaces would not have saved them:
// their SUBJECT is "does a CARD own this seam", and there is no card to own one.
//
// ⚠ WHAT IS NOT LOST, because it never depended on the walk. `DOM_SOURCE_LANE_TYPES`
// and `CARD_PRODUCER_LANE_TYPES` are still exported, still EMPTY, and still
// imported by ten face-model tests plus `node-frame-producer-registry.test.ts`,
// which asserts they are DISJOINT from `NODE_FRAME_PRODUCER_TYPES` — the gate
// that stops a producer being owned twice. That is the live half of #1724/#1587
// and it reads the live registries, not the filesystem.
//
// The rule this file encodes — the ENGINE-VISIBLE state of a rack must not
// depend on which UI renders a module — is not retired. It is satisfied
// STRUCTURALLY now: there is one UI.


// ─────────────────────────────────────────────────────────────────────────────
// ⚠ THREE DESCRIBES RETIRED WITH THE DECISION THEY DROVE (legacy-removal S1.5)
// ─────────────────────────────────────────────────────────────────────────────
//
// `needsHeadlessSourceMount — the pure headless-mount decision`,
// `laneOmitsNode — a COLLAPSED GROUP's child, in BOTH shells (#1721)` and
// `FACE_MOUNTS_PRODUCER — the dock-open exemption, anchored both ways` all
// exercised the pure decision behind `<HeadlessSourceHost>`. Their own anchors
// wrote the retirement condition down before it arrived:
//
//   * the decision anchor: "if the extractions have emptied the union, this
//     decision has no population and the legs that read it should be retired
//     with the host itself, not re-pointed at a synthetic type";
//   * the fifth re-point note: "when the union finally empties, the leg really
//     does go with it, because a decision with no population left is not a
//     decision";
//   * the FACE_MOUNTS vacuity leg had already lost its population twice and
//     survived on a synthetic subject borrowed from a real member — which no
//     longer exists to borrow from.
//
// The union emptied when cube's renderer moved to `NodeVizSurfaceHost`
// (rasterize's loop had moved to `RASTERIZE_FRAME_PRODUCER` one commit
// earlier), the host and the decision are DELETED, and what the three
// describes protected is now structural: NO module gets an off-screen card on
// ANY lane kind, in ANY shell, because there is nothing that mounts one. The
// surviving, red-able statements are:
//
//   * both populations EMPTY — the leg above in the CARD_PRODUCER describe;
//   * every former member owned by exactly ONE node registry — the
//     disjointness gate over the eight owner sets;
//   * the derivation still CLASSIFIES a producer card — the synthetic-seams
//     leg — so a card regrowing a seam re-enrols and reds the empty toEqual.
//
// What #1721 measured (a collapsed group's child producing in BOTH shells) is
// covered at the product level by card-producer-lifetime.spec.ts's collapsed-
// group legs, which survived the extractions by re-derivation.

// ⚠ THIS BLOCK USED TO ASSERT THE OPPOSITE, DELIBERATELY, AND THE REVERSAL IS
// THE POINT — so the old assertions are quoted rather than deleted.
//
// It was titled "cameraInput — the CAPTURE-SOURCE carve-out (source + device
// picker live on the card)" and pinned three things:
//   `expect(NON_SHELL_LANE_TYPES.has('cameraInput')).toBe(true)`,
//   that `laneRenderKind` returns 'legacy' for it whatever `migrated()` says,
//   and that it is "therefore never headless-hosted (no double getUserMedia)".
//
// THE LINEAGE MATTERS, because that carve-out was created in response to an
// owner P0 — "no video at all" under `?shell=1` — on a module CI cannot
// exercise. It is not a preference being overturned; it is a fix whose
// mechanism was superseded.
//
// WHY THE EXIT IS SAFE, in the order the chain actually runs:
//   1. cameraInput ∈ DOM_SOURCE_LANE_TYPES ⊂ HEADLESS_MOUNT_LANE_TYPES — the
//      first two legs below assert exactly that, so this is read off the sets
//      rather than remembered;
//   2. with the carve-out gone `isShellSwappable` is true, so `laneRenderKind`
//      returns 'shell' for a promoted module;
//   3. `needsHeadlessSourceMount` returns true for 'shell', so
//      <HeadlessSourceHost> mounts the REAL card off-screen and getUserMedia,
//      the MediaStream and the permission machine all keep running. The
//      `<video>` is node-owned ($lib/ui/media/node-media-registry), so the move
//      is a re-parent, not a teardown.
// The mechanism did not exist when the carve-out was written — that is the
// whole reason the carve-out was written.
//
// ⚠ WHAT THIS UNIT CANNOT SEE, and where the real proof is. Everything here is
// pure set membership plus two pure functions; NOTHING in this file proves that
// Canvas wires them, that the host mounts, or that a frame ever arrives. That is
// `e2e/tests/camerainput-shell-source.spec.ts`, which drives the DEFAULT shell,
// asserts the lane paints a faceplate (not a card), asserts the headless host
// holds the card, and reads real non-black pixels out of CAMERA → VIDEO OUT
// through the module's deterministic injected-frame seam.
//
// ⚠ AND THE CARD'S AFFORDANCES ARE A SEPARATE QUESTION FROM ITS SOURCE. An
// off-screen host is `pointer-events: none`, so the card's "Request access"
// gesture is unreachable in the default shell. Keeping the SOURCE alive does not
// keep the ACQUIRE alive, and conflating the two is how this promotion could
// have shipped a first-run dead end. `$lib/ui/media/camera-status-registry` is
// the answer and has its own unit coverage.
describe('cameraInput — PROMOTED, and now NODE-OWNED rather than headless-hosted', () => {
  // ⚠ THIS BLOCK ASSERTED THE OPPOSITE UNTIL 2026-09-03, and the inversion is
  // the legacy-removal S1 extraction rather than a relaxation. cameraInput was
  // the FIRST member of `DOM_SOURCE_LANE_TYPES` to be promoted, so it was the
  // first to exercise the headless host for real — the card stayed mounted
  // off-screen so getUserMedia, the stream and the permission machine survived
  // the lane swap. `$lib/ui/media/node-camera-source-registry` owns all three
  // now, on GRAPH lifetime, so the module needs no card anywhere and gets no
  // host. The legs below pin the NEW arrangement in both directions; the
  // `?shell=legacy` leg is unchanged because the card still renders there.
  it('is NOT a DOM-source module any more — a node controller owns its source', () => {
    expect(DOM_SOURCE_LANE_TYPES.has('cameraInput')).toBe(false);
  });

  it('is NO LONGER carved out of the shell swap', () => {
    expect(NON_SHELL_LANE_TYPES.has('cameraInput')).toBe(false);
  });

  it('renders a FACEPLATE in the lane once promoted', () => {
    expect(
      laneRenderKind({ userDocked: false, type: 'cameraInput', laneNative: false }),
    ).toBe('shell');
  });

  it('and is THEREFORE NOT headless-hosted — structurally, since S1.5', () => {
    // This leg used to read `needsHeadlessSourceMount`; the decision retired
    // with the host, so "not hosted" is true of every module by construction.
    // What makes cameraInput's case a STATEMENT rather than an absence is the
    // disjointness gate above (it must be in exactly one node-owner set) plus
    // `e2e/tests/camerainput-shell-source.spec.ts`, which asserts the picture
    // survives with no card mounted anywhere.
    expect(NODE_CAMERA_SOURCE_TYPES.has('cameraInput')).toBe(true);
  });

  // ⚠ THE `?shell=legacy` LEG IS GONE. It asserted this module "still keeps its
  // real card under the escape hatch, where nothing changed" — the reassurance
  // that made the promotion above safe to land. The hatch is removed, the card
  // with it, and `laneRenderKind` has no `'legacy'` arm to return. What the leg
  // guarded is now guarded by there being one surface: the faceplate assertion
  // above, plus `camerainput-shell-source.spec.ts`, which asserts the picture
  // survives with no card mounted anywhere.

  // ⚠ Two legs retired with the decision (S1.5): "a DOCKED camera is not
  // hosted either" and "EVERY headless-hosted module is now uniform" both read
  // `needsHeadlessSourceMount` over a population that is empty — the second
  // one's loop body had already stopped executing. Their claims are structural
  // now: no lane kind, dock state or membership produces an off-screen card.
});

// ⚠ THE `DOCK FULL VIEW hosts the real card only for an UN-MIGRATED module`
// DESCRIBE STOOD HERE and retired with the decision (legacy-removal S1.5). Its
// ANCHOR leg said, verbatim, that when the union emptied it "says retire the
// host, do not re-point at a synthetic type" — the union emptied, the host and
// `needsHeadlessSourceMount` are deleted, and `fullViewShowsFaceInstead` went
// with them from Canvas. What the pair pinned (a dock faceplate is not a card
// mount) is now vacuous in the strongest sense: no module has a card whose
// mount is engine-visible, so there is nothing for a dock state to orphan.
