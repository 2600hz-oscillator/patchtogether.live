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
import { conventionalCardName, type CardDefLike } from '$lib/ui/modules-card-map';
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

/** card component BASENAME → module type id, exactly the way buildNodeTypes
 *  resolves it (explicit `def.card` wins, else the PascalCase convention). */
function cardNameToType(): Map<string, string> {
  const defs: CardDefLike[] = [
    ...(listModuleDefs() as unknown as CardDefLike[]),
    ...(listVideoModuleDefs() as unknown as CardDefLike[]),
    ...(listMetaModuleDefs() as unknown as CardDefLike[]),
  ];
  const map = new Map<string, string>();
  for (const def of defs) map.set(def.card ?? conventionalCardName(def.type), def.type);
  return map;
}

// ── #1724: THE WALK, and what the old one was structurally unable to see ─────
//
// The seam patterns were RIGHT and the file set was WRONG. CUBE installs a frame
// drawer — `installCubeFrameDrawer`, matched letter for letter by the
// `install*FrameDrawer` seam below — from `modules/cube/CubeVizSurface.svelte`,
// and the walk read `readdirSync(CARD_DIR)` (non-recursive) filtered to
// `*Card.svelte`. Either filter alone hid the file. So the gate was green while
// `CUBE.video_out → VIDEO OUT` was solid black on a rack nobody had touched
// (MEASURED, never-mounted: nonBlack 0/3072 px, maxLuma 0; with the card mounted
// in the dock full-view: 3072/3072, maxLuma 212 — the same probe, the same port).
//
// ⚠ THE ENTRY-POINT FILTER WAS NOT THE BUG, and copying it here was the bug.
// `modules-card-components.ts` resolves cards with `import.meta.glob(
// './modules/*Card.svelte')` — flat, `*Card.svelte`. That IS the set of cards,
// exactly, and it is anchored below. What went wrong is that the walk then read
// ONLY those files, when the subject of the check is "what does this card MOUNT"
// — and a card's producer can live in any component in its subtree. So the entry
// points stay the resolver's, and the SEAM SEARCH widens to the subtree.
//
// ⚠ WHY `.svelte` AND NOT THE WHOLE IMPORT CLOSURE. Measured, both ways, before
// choosing: following every `.ts` edge too enrols **all 195 cards**, because
// every card reaches `$lib/video/engine.ts` — which DEFINES
// `attachExternalSource`. That is the blind-gate failure inverted (a filter so
// wide the subject is redefined to "everything"), and it is not an accident of
// this repo: a `.ts` module reached from a card is either the ENGINE API itself
// or a NODE-KEYED registry that already survives a card unmount by construction
// (`ui/media/node-media-registry.ts`, the #1583 fix — the one other `.ts` seam
// hit, reached by ToyboxCard, and precisely a module that must NOT enrol a type).
// A `.svelte` component, by contrast, shares its parent's MOUNT LIFETIME, which
// is the thing this set is about. The component subtree is the honest boundary.
//
// MEASURED DELTA of the widening over the whole card set: exactly TWO
// attributions the flat walk could not make — `CubeCard → cube/CubeVizSurface`
// (the real defect) and `GroupCard → ScopeCard` (a wrong attribution, named and
// exempted below). Nothing else moved.

/** `*Card.svelte`, FLAT — the card ENTRY POINTS, and deliberately the same
 *  filter `modules-card-components.ts` globs with. Anchored by
 *  `the card entry points are exactly the glob the app resolves` below, so this
 *  cannot drift away from the resolver in either direction. */
function cardEntryPoints(): string[] {
  return readdirSync(CARD_DIR)
    .filter((f) => f.endsWith('Card.svelte'))
    .map((f) => join(CARD_DIR, f));
}

/** Resolve a `.svelte` import specifier to a real path, or null. Relative and
 *  `$lib/`-aliased only: a bare package specifier is a dependency, never a card
 *  subtree member. */
function resolveComponentImport(fromFile: string, spec: string): string | null {
  if (!spec.endsWith('.svelte')) return null;
  let base: string;
  if (spec.startsWith('$lib/')) base = join(LIB_DIR, spec.slice('$lib/'.length));
  else if (spec.startsWith('.')) base = resolve(dirname(fromFile), spec);
  else return null;
  return existsSync(base) && statSync(base).isFile() ? base : null;
}

const IMPORT_RE = /(?:^|\n)\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g;

/**
 * A card's COMPONENT SUBTREE — the card file plus every `.svelte` component it
 * transitively mounts, at any depth and in any directory.
 *
 * This is the file set the seams are searched over. Exported shape (a plain
 * array of absolute paths) so the negative controls can call the SAME function
 * on a fixture the test builds, rather than a re-implementation of it.
 */
function componentSubtree(entry: string): string[] {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    let src: string;
    try {
      src = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const m of src.matchAll(IMPORT_RE)) {
      const child = resolveComponentImport(file, m[1]!);
      if (child && !seen.has(child)) stack.push(child);
    }
  }
  return [...seen];
}

/** A path printed the way a reader can find it: relative to the card dir. */
function rel(file: string): string {
  return relative(CARD_DIR, file).split(sep).join('/');
}

/** Every card, with its whole component subtree read. */
function cardSources(): Array<{ base: string; entry: string; files: Array<{ path: string; src: string }> }> {
  return cardEntryPoints().map((entry) => ({
    base: entry.slice(CARD_DIR.length).replace(/\.svelte$/, ''),
    entry,
    files: componentSubtree(entry).map((path) => ({ path, src: readFileSync(path, 'utf8') })),
  }));
}

/**
 * ATTRIBUTIONS THE SUBTREE WALK GETS WRONG — deny by default, one NAMED entry
 * per `(card, component)` PAIR.
 *
 * ⚠ A PAIR, never a filename. A new seam appearing in `GroupCard.svelte` ITSELF
 * still reddens; only the one edge named here is excused. And every field is
 * required, so `tsc` refuses an entry added without its reason.
 *
 * ANCHORED TO THE ARTIFACT (see the test): an entry whose card no longer exists,
 * whose component is no longer in that card's subtree, or whose component no
 * longer carries a seam, is RED — it cannot sit here reading as coverage for
 * something that is gone.
 */
interface SubtreeSeamExemption {
  /** Card basename, exactly as the glob resolver names it. */
  readonly card: string;
  /** The seam-carrying component, relative to CARD_DIR. */
  readonly component: string;
  /** Why the seam does NOT make this card the sole writer of THIS module's
   *  engine state. */
  readonly why: string;
}

/**
 * ⚠ EMPTY AS OF legacy-removal S1, AND THE WAY IT EMPTIED IS THE POINT.
 *
 * The one entry was `GroupCard → ScopeCard.svelte`: the group hidden-mounted a
 * viz-passthrough child's whole REAL card to obtain one `<canvas
 * data-viz-passthrough>` it could portal into its body, so the walk correctly
 * found scope's producer seam in `GroupCard`'s subtree and would have enrolled
 * `group` — an organizational container with no engine state at all.
 *
 * It is DELETED rather than re-pointed because the EDGE is gone: `GroupCard`
 * mounts `scope/ScopeTraceSurface.svelte` now, which paints and writes nothing.
 * A wrong attribution that needed an exemption became a right attribution that
 * needs none, which is the outcome an exemption list should be aiming for.
 *
 * Deny by default still holds and the anchor below still runs: a NEW entry must
 * name a live `(card, component)` pair whose component really does carry a seam.
 */
const SUBTREE_SEAM_EXEMPTIONS: readonly SubtreeSeamExemption[] = [];

/** The FIRST seam any file in a card's subtree matches, with the file that
 *  carried it — `null` when the card produces nothing, and `null` when the only
 *  match is a NAMED wrong attribution (deny by default: the pair must be
 *  listed, not the file). */
function seamHitFor(card: {
  base: string;
  entry: string;
  files: Array<{ path: string; src: string }>;
}, seams: readonly { id: string; re: RegExp }[]): { seam: string; file: string } | null {
  for (const { path, src } of card.files) {
    const seam = seams.find((s) => s.re.test(src));
    if (!seam) continue;
    const component = rel(path);
    if (
      path !== card.entry &&
      SUBTREE_SEAM_EXEMPTIONS.some((x) => x.card === card.base && x.component === component)
    ) {
      continue;
    }
    return { seam: seam.id, file: component };
  }
  return null;
}

/** Module types whose card SUBTREE matches ANY producer seam, plus the cards
 *  that matched but resolve to no registered def (a hole the set cannot cover). */
function derivedProducerTypes(): { found: Set<string>; unmapped: string[]; hits: string[] } {
  const byName = cardNameToType();
  const found = new Set<string>();
  const unmapped: string[] = [];
  const hits: string[] = [];
  for (const card of cardSources()) {
    const hit = seamHitFor(card, PRODUCER_SEAMS);
    if (!hit) continue;
    hits.push(`${card.base} → ${hit.seam} @ ${hit.file}`);
    const type = byName.get(card.base);
    if (!type) {
      unmapped.push(card.base);
      continue;
    }
    found.add(type);
  }
  return { found, unmapped, hits };
}

describe('THE WALK (#1724) — the gate reads what a card MOUNTS, not one file', () => {
  it('the card ENTRY POINTS are exactly the glob the app itself resolves', () => {
    // ANCHORED TO THE RESOLVER, not to a comment about it. If
    // `modules-card-components.ts` ever globs a different shape (recursive, or a
    // second suffix), this fails and the walk is corrected WITH it — the entry
    // set and the app's card set are one truth.
    const resolverSrc = readFileSync(
      fileURLToPath(new URL('../modules-card-components.ts', import.meta.url)),
      'utf8',
    );
    const glob = /import\.meta\.glob<[^>]*>\(\s*'([^']+)'/.exec(resolverSrc)?.[1];
    expect(glob, 'could not read the card glob out of modules-card-components.ts').toBe(
      './modules/*Card.svelte',
    );
    // …and the entry points this file derives match that glob's shape exactly.
    const entries = cardEntryPoints().map((p) => rel(p));
    expect(entries.filter((p) => p.includes('/')), 'a card entry point in a SUBDIRECTORY').toEqual([]);
    expect(entries.filter((p) => !p.endsWith('Card.svelte')), 'a non-Card entry point').toEqual([]);
    expect(entries.length).toBeGreaterThan(0);
  });

  it('REACHES a component in a SUBDIRECTORY and one that is not a *Card.svelte', () => {
    // THE PERMANENT NEGATIVE-CONTROL LEG the flat walk needed and did not have.
    // The pre-#1724 vacuity guard could not fire here: the other members still
    // matched, so "found something" stayed true while cube was invisible. This
    // asserts the PROPERTY that was missing instead — that the walk leaves the
    // card's own file at all, in BOTH the ways the old filters blocked.
    //
    // Slack is real and deliberate, so this is a vacuity guard and not a
    // population count: it needs ONE subdirectory component and ONE non-Card
    // component, out of the many the card tree mounts.
    const reached = new Set<string>();
    for (const card of cardSources()) for (const f of card.files) reached.add(rel(f.path));
    const inSubdir = [...reached].filter((p) => p.includes('/'));
    const notACard = [...reached].filter((p) => !p.endsWith('Card.svelte'));
    expect(
      inSubdir,
      'the walk read no component in a subdirectory of the card dir — a NON-RECURSIVE walk is ' +
        'exactly how #1724 hid cube/CubeVizSurface.svelte',
    ).not.toEqual([]);
    expect(
      notACard,
      'the walk read no component outside the `*Card.svelte` suffix — that filter is the OTHER ' +
        'half of what hid cube/CubeVizSurface.svelte',
    ).not.toEqual([]);
  });

  it('NEGATIVE CONTROL, both directions: the subtree walk finds a seam the flat walk cannot', () => {
    // ⚠ RE-ANCHORED OFF THE POPULATION (legacy-removal S1.5). Direction 1 used
    // to run the pre-#1724 flat walk against the live tree and require the
    // subtree walk to find MORE — its one live gain was `CubeCard →
    // cube/CubeVizSurface.svelte`, and cube's renderer now belongs to the
    // NODE, so both walks legitimately find the same (empty) set. Its own
    // failure message asked for "a decision, not a deletion"; the decision is
    // the same one the seam-liveness leg took — anchor the instrument on a
    // SYNTHETIC card whose seam lives ONLY in a child component, fed through
    // the SAME `seamHitFor` the derivation runs. A walk narrowed back to
    // one-file-per-card cannot be simulated here (the FS walk is what
    // `componentSubtree` owns, next leg) — what this pins is that ATTRIBUTION
    // FROM A CHILD FILE works, which is the half a flat SEARCH lost.
    const entry = '/synthetic/SyntheticCard.svelte';
    const child = '/synthetic/synthetic/SyntheticVizSurface.svelte';
    const card = {
      base: 'SyntheticCard',
      entry,
      files: [
        { path: entry, src: '<div class="clean-card" />' },
        { path: child, src: "installSyntheticFrameDrawer(nodeId, draw);" },
      ],
    };
    const hit = seamHitFor(card, PRODUCER_SEAMS);
    expect(
      hit,
      'a seam in a CHILD component no longer attributes to its card — the #1724 blindness is back',
    ).not.toBeNull();
    expect(hit!.file, 'the hit names the child file, so a reviewer can find it').toContain(
      'SyntheticVizSurface.svelte',
    );
    // Direction 2 is unchanged and still runs on the live tree: the subtree
    // walk may only ever ADD relative to the flat one. With zero producers
    // anywhere both sides are empty, and a member appearing on the flat side
    // alone would still red here.
    const byName = cardNameToType();
    const wide = derivedProducerTypes().found;
    const flatOnly = new Set<string>();
    for (const c of cardSources()) {
      const own = c.files.find((f) => f.path === c.entry)!;
      if (!PRODUCER_SEAMS.some((se) => se.re.test(own.src))) continue;
      const t = byName.get(c.base);
      if (t) flatOnly.add(t);
    }
    expect(
      [...flatOnly].filter((t) => !wide.has(t)).sort(),
      'the subtree walk LOST a type the card-file walk found — an exemption is over-broad',
    ).toEqual([]);
  });

  it('NEGATIVE CONTROL: componentSubtree resolves relative AND $lib edges, and stops at .ts', () => {
    // Direction 2, on the MECHANISM rather than the population, over a fixture
    // this test builds — so it stays true whatever the card tree does next.
    // ⚠ `$lib/video/engine.ts` is the measured reason `.ts` edges are NOT
    // followed: it DEFINES attachExternalSource and every one of the cards
    // reaches it, so a `.ts`-following walk enrols the entire registry.
    // ⚠ SUBJECT MOVED (legacy-removal S1.5): this used to walk CubeCard and
    // require `cube/CubeVizSurface.svelte` in its subtree — the exact edge
    // #1724 was about — but that edge is deliberately GONE (the NODE mounts
    // the renderer now, and the card only claims its element). ToyboxCard
    // mounts its console by the same relative-subdirectory shape, so the
    // MECHANISM keeps a live witness; the day toybox converts too, re-point at
    // any card with a `./<dir>/X.svelte` import, or build the fixture on disk.
    const toyboxCard = join(CARD_DIR, 'ToyboxCard.svelte');
    const subtree = componentSubtree(toyboxCard).map((p) => rel(p));
    expect(subtree, 'the entry itself is always in its own subtree').toContain('ToyboxCard.svelte');
    expect(
      subtree,
      'ToyboxCard mounts toybox/ToyboxConsole.svelte by a RELATIVE specifier — the edge shape ' +
        '#1724 was about',
    ).toContain('toybox/ToyboxConsole.svelte');
    expect(
      subtree.some((p) => p.startsWith('../')),
      'a card mounts shared components through the $lib alias; a walk that resolved only relative ' +
        'specifiers would stop at the first aliased edge',
    ).toBe(true);
    expect(
      subtree.filter((p) => !p.endsWith('.svelte')),
      'the walk followed a NON-component edge — see the header: following .ts enrols all cards ' +
        'through $lib/video/engine.ts',
    ).toEqual([]);
  });

  it('every subtree-seam EXEMPTION still names a live, seam-carrying edge', () => {
    // ANCHORED TO THE ARTIFACT in all three ways an entry can go stale, so a
    // name that no longer resolves is RED rather than quiet coverage.
    const cards = new Map(cardSources().map((c) => [c.base, c]));
    const stale: string[] = [];
    for (const x of SUBTREE_SEAM_EXEMPTIONS) {
      const card = cards.get(x.card);
      if (!card) {
        stale.push(`${x.card}: no such card`);
        continue;
      }
      const file = card.files.find((f) => rel(f.path) === x.component);
      if (!file) {
        stale.push(`${x.card} → ${x.component}: not in that card's subtree`);
        continue;
      }
      if (file.path === card.entry) {
        stale.push(`${x.card} → ${x.component}: that IS the card's own file — never exemptible`);
        continue;
      }
      const seams = [...PRODUCER_SEAMS, { id: 'attachExternalSource(…)', re: CALL_RE }];
      if (!seams.some((s) => s.re.test(file.src))) {
        stale.push(`${x.card} → ${x.component}: carries no seam any more`);
      }
    }
    expect(stale, `stale subtree-seam exemption(s): ${stale.join(' | ')}`).toEqual([]);
    // The `why` is the only thing a future reviewer of a widening actually
    // needs, so an empty one is not an exemption.
    for (const x of SUBTREE_SEAM_EXEMPTIONS) {
      expect(x.why.length, `${x.card} → ${x.component} needs a real why`).toBeGreaterThan(40);
    }
  });

  it('SCOPE: what this walk still cannot see, stated as an assertion', () => {
    // 1. A producer reached through a `.ts` module. DELIBERATE and measured —
    //    following .ts enrols all cards via $lib/video/engine.ts — and safe for
    //    the one real case: `ui/media/node-media-registry.ts` is the NODE-KEYED
    //    registry from #1583, which survives a card unmount BY CONSTRUCTION and
    //    must not enrol anything. Asserted, not assumed:
    const registry = readFileSync(
      fileURLToPath(new URL('../media/node-media-registry.ts', import.meta.url)),
      'utf8',
    );
    expect(
      CALL_RE.test(registry),
      'node-media-registry no longer calls attachExternalSource — the argument above for not ' +
        'following .ts edges has changed and needs re-deriving',
    ).toBe(true);
    // 2. A DYNAMIC mount — `import()`, or a component resolved out of a registry
    //    (the shell-cells PANEL seam is exactly that shape: `shell-cells.ts` maps
    //    cube's hero to CubeHeroPanel, and no static import from CubeCard reaches
    //    it). This gate cannot follow that edge, and since legacy-removal S1.5
    //    it does not need to for cube AT ALL: the panel no longer mounts a
    //    renderer — the NODE does (`NodeVizSurfaceHost`), and both the card and
    //    the panel only CLAIM its element. But a module whose producer is ONLY
    //    in a dynamically-mounted panel would still be invisible here — the e2e
    //    (card-producer-lifetime.spec.ts) is the net.
    const shellCells = readFileSync(
      fileURLToPath(new URL('./shell-cells.ts', import.meta.url)),
      'utf8',
    );
    expect(
      /CubeHeroPanel/.test(shellCells),
      'shell-cells no longer resolves a cube panel — the dynamic-mount blind spot named here ' +
        'has moved and the statement is stale',
    ).toBe(true);
    // 3. Whether the mounted producer WORKS. Pixels are the e2e's job.
  });
});

/** Every module type whose card subtree HANDS an element to the engine — the
 *  first half of the predicate, unchanged from #1724. */
function attachingTypes(): { found: Set<string>; unmapped: string[] } {
  const byName = cardNameToType();
  const found = new Set<string>();
  const unmapped: string[] = [];
  // #1724: the SUBTREE, not the card file. This half's population does not move
  // today (measured: every attachExternalSource call is in the card's own file),
  // and that is the point — the widening removes the structural blindness
  // without changing the answer, so the next DOM-source module that puts its
  // `<video>` in a child component is caught rather than missed.
  for (const card of cardSources()) {
    const hit = seamHitFor(card, [{ id: 'attachExternalSource(…)', re: CALL_RE }]);
    if (!hit) continue;
    const type = byName.get(card.base);
    if (!type) {
      unmapped.push(card.base);
      continue;
    }
    found.add(type);
  }
  return { found, unmapped };
}

describe('DOM_SOURCE_LANE_TYPES — the grep gate (a new source module cannot ship dark)', () => {
  it('is EXACTLY the types whose card attaches AND whose ENGINE keeps the element', () => {
    const { found: attaching, unmapped } = attachingTypes();

    // Every card that attaches a DOM source must resolve to a registered def —
    // otherwise the set below can't possibly be complete.
    expect(unmapped, `card(s) calling attachExternalSource resolve to no module def: ${unmapped.join(', ')}`)
      .toEqual([]);

    // ⚠ THIS USED TO BE `expect(attaching.size).toBeGreaterThan(0)` — "a refactor
    // that renames the engine hook must fail loudly here rather than silently
    // emptying the set". `DOM_SOURCE_LANE_TYPES` is now legitimately EMPTY
    // (legacy-removal S1: all five members have node-scoped owners), so that
    // check would fail forever for the right reason at the wrong time, and
    // deleting it would leave the comparison below as `[] === []` — a gate that
    // cannot fail.
    //
    // The replacement is a control over the INSTRUMENT rather than over the
    // population, which is the shape that survives a population reaching zero:
    // the reader must still be able to FIND an attaching card, proven by feeding
    // it one. `seamHitFor` is the same function the derivation uses, so a
    // rename that broke the real scan breaks this too.
    expect(
      CALL_RE.test('ve?.attachExternalSource(id, \'video\', el);'),
      'the attach matcher no longer recognises a real call — the derivation above ' +
        'is comparing an empty set to an empty set and cannot fail',
    ).toBe(true);
    expect(
      cardSources().length,
      'the card reader resolved NO cards at all, so "no card attaches" is a statement ' +
        'about the reader rather than about the tree',
    ).toBeGreaterThan(0);

    // SECOND HALF: drop only the modules NAMED as one-shot imports. Deny by
    // default — an unnamed module stays in even if it matches no seam, and the
    // positive-control leg below is what turns that into a red instead of a
    // silent pass.
    const derived = [...attaching].filter((t) => !oneShotModules.has(t)).sort();
    expect(derived).toEqual([...DOM_SOURCE_LANE_TYPES].sort());
  });

  it('POSITIVE CONTROL: every DOM-source module\'s engine really does RETAIN its element', () => {
    // The leg that keeps the set HONEST in the direction that costs a P0. If a
    // module in the set stops wiring per-frame delivery, this reddens and
    // someone decides — rather than the module quietly keeping a headless mount
    // it no longer needs, or (worse) a future edit dropping it on a guess.
    //
    // It is also the both-directions anchor for ONE_SHOT_INGEST: loopback must
    // classify as card-owned HERE, derived from its own source, not asserted by
    // name anywhere.
    const notRetaining: string[] = [];
    const evidence: string[] = [];
    for (const type of [...DOM_SOURCE_LANE_TYPES].sort()) {
      const file = engineFileFor(type);
      if (!file) {
        // A DOM-source module with no engine module file of its own is outside
        // what this leg can read; say so rather than passing quietly.
        evidence.push(`${type}: no engine module file (not readable here)`);
        continue;
      }
      const body = engineAttachBody(file);
      if (body === null) {
        notRetaining.push(`${type} (${file}): no engine-side attachExternalSource implementation`);
        continue;
      }
      const hits = SOURCE_RETENTION_SEAMS.filter((s) => s.re.test(codeOf(body))).map((s) => s.id);
      if (hits.length === 0) {
        notRetaining.push(`${type} (${file}): matches NO retention seam`);
        continue;
      }
      evidence.push(`${type} → ${hits.join(' + ')}`);
    }
    expect(
      notRetaining,
      'in DOM_SOURCE_LANE_TYPES but the engine does not keep the element — either it became a ' +
        `one-shot import (name it in ONE_SHOT_INGEST) or it retains a new way (add the seam). ` +
        `Retaining today: ${evidence.join(' | ')}`,
    ).toEqual([]);
    // VACUITY: the seam set must actually match something, or "retains" is a
    // claim nothing checked.
    expect(SOURCE_RETENTION_SEAMS.length, 'at least one retention seam is declared').toBeGreaterThan(0);
    // ⚠ THIS USED TO REQUIRE `evidence` TO BE NON-EMPTY, which was the right
    // control while the set had members and is unsatisfiable now that it is
    // empty (legacy-removal S1). Deleting it would leave the loop above running
    // zero times — a gate that cannot fail — so the control moves from the
    // POPULATION to the MATCHER, which is what still has something to say.
    // Fed a synthetic engine-side attach body that retains its element, the
    // seams must recognise it.
    const syntheticRetaining = `attachExternalSource(kind, el) {
      this.mediaEl = el;
      el.requestVideoFrameCallback(() => this.upload());
    }`;
    expect(
      SOURCE_RETENTION_SEAMS.some((seam) => seam.re.test(syntheticRetaining)),
      'no retention seam matches a body that plainly retains its element — the loop above ' +
        'is iterating an empty set with a matcher that could not fire either way',
    ).toBe(true);
  });

  it('every ONE_SHOT_INGEST entry still describes a live, non-retaining module', () => {
    // ANCHORED TO THE ARTIFACT in every way the entry can go stale, so a name
    // that stopped being true is RED rather than a quiet exclusion.
    const stale: string[] = [];
    for (const x of ONE_SHOT_INGEST) {
      const src = engineSource(x.engineFile);
      if (src === null) {
        stale.push(`${x.module}: no engine file ${x.engineFile}`);
        continue;
      }
      const body = engineAttachBody(x.engineFile);
      if (body === null) {
        stale.push(`${x.module}: ${x.engineFile} has no attachExternalSource implementation any more`);
        continue;
      }
      const hits = SOURCE_RETENTION_SEAMS.filter((s) => s.re.test(codeOf(body))).map((s) => s.id);
      if (hits.length > 0) {
        stale.push(`${x.module}: now RETAINS its element (${hits.join(' + ')}) — it is a DOM source again`);
      }
      if (!x.dropSite.test(src)) {
        stale.push(`${x.module}: the declared drop site ${x.dropSite} is gone — it may no longer drop the element`);
      }
      // The module must still be one the CARD attaches to; an entry for a module
      // that stopped attaching is describing nothing.
      if (!CALL_RE.test(src) && !attachingTypes().found.has(x.module)) {
        stale.push(`${x.module}: nothing attaches to it any more — delete the entry`);
      }
    }
    expect(stale, `stale ONE_SHOT_INGEST entry/entries: ${stale.join(' | ')}`).toEqual([]);
    for (const x of ONE_SHOT_INGEST) {
      expect(x.why.length, `${x.module} needs a real why`).toBeGreaterThan(40);
    }
  });

  it('NEGATIVE CONTROL: the retention matcher separates the two shapes on synthetic bodies', () => {
    // On fixtures this test builds, so it stays true whatever the real modules
    // do next — and it fails if a seam regex is broadened into "matches
    // anything" or narrowed into "matches nothing".
    const retaining = `attachExternalSource(kind, el) {
      if (kind !== 'video') return;
      detachRvfc();
      videoEl = (el as HTMLVideoElement) ?? null;
      if (videoEl) { attachRvfc(); wireKeepAlive(); }
    }`;
    const oneShot = `attachExternalSource(kind, el) {
      if (kind !== 'image') return;
      pendingAtlas = (el as unknown as TexImageSource) ?? null;
    }`;
    const matches = (body: string) => SOURCE_RETENTION_SEAMS.filter((s) => s.re.test(codeOf(body))).map((s) => s.id);
    expect(matches(retaining), 'a retaining body must match at least one seam').not.toEqual([]);
    expect(matches(oneShot), 'a one-shot staging body must match NO seam').toEqual([]);
    // …and a body that merely TALKS about the wiring is not a body that does it.
    const prose = `attachExternalSource(kind, el) {
      // NOTE: we do NOT attachRvfc() here, and no uploader.attach(el) — the
      // atlas is staged and detiled on the next draw. mediaEl = null.
      pendingAtlas = el;
    }`;
    expect(
      matches(prose).filter((id) => id !== 'attachRvfc()' && id !== 'uploader.attach(el)'),
      'a seam matched something other than a real call in a prose-only body',
    ).toEqual([]);
  });

  it('lists the known capture/media-source modules (readable failure if one is dropped)', () => {
    // ⚠ `peertube` AND `tvLibrarian` USED TO BE IN THIS LIST and moved to
    // BOUNDARY 3 below in P3 — the list of modules whose source is genuinely
    // live and which are still NOT members, because their lifecycle left the
    // card. They did not stop being media sources; they stopped being CARD-owned
    // ones, and asserting the same thing about them in the same place would have
    // been a name kept while the claim inverted.
    // ⚠ `loopback` LEFT THIS LIST TOO (legacy-removal S1, 2026-09-03) and is now
    // in Boundary 3 below, for a reason unlike the four already there: nothing
    // was broken. The other departures fixed measured defects; this one removes
    // the CARD's load-bearingness so the card can be deleted. Same destination,
    // different argument — see the set's own header.
    // ⚠ THIS LIST IS NOW EMPTY, AND IT IS KEPT AS AN EMPTY LOOP ON PURPOSE. Every
    // former member (archivist last, 2026-09-03) is asserted in Boundary 3
    // below — absent HERE and present in exactly one node-owner set. Writing the
    // departure as a positive claim about where each module went is what makes
    // an empty set a STATEMENT rather than a list someone stopped maintaining.
    for (const t of [] as string[]) {
      expect(DOM_SOURCE_LANE_TYPES.has(t), `${t} is a DOM-source module`).toBe(true);
    }
    expect(
      DOM_SOURCE_LANE_TYPES.size,
      'DOM_SOURCE_LANE_TYPES has a member again — add it to the list above and say what ' +
        'makes its CARD the owner of its source, because nothing has been card-owned since ' +
        'legacy-removal S1',
    ).toBe(0);
    // Boundary 1: a pure-GPU generator is NOT one (acidwarp renders from a shader
    // only — it needs no card, which is why acidwarp → OUTPUT survived the bug).
    for (const t of ['acidwarp', 'lines', 'backdraft', 'ruttetra', 'videoOut']) {
      expect(DOM_SOURCE_LANE_TYPES.has(t), `${t} is NOT a DOM-source module`).toBe(false);
    }
    // Boundary 2: a FILE IMPORT is not a source. These two attach an element and
    // are still not DOM-source modules, which is the whole point of the second
    // half of the predicate — their pictures come from graph cables.
    for (const t of ['frametable', 'videocube']) {
      expect(
        DOM_SOURCE_LANE_TYPES.has(t),
        `${t} attaches a ONE-SHOT atlas import, not a live source — it must NOT be a DOM-source module`,
      ).toBe(false);
    }
    // Boundary 3 (LEG-02 P1, #1511): a module whose source is genuinely LIVE and
    // genuinely file-backed, and which is still not a member — because its
    // lifecycle moved OFF the card to a node-scoped controller. This is the
    // boundary every remaining member is meant to cross, so it is asserted in
    // BOTH directions rather than as a deleted name: absent here AND present in
    // the registry that took over. Membership of both would mean two owners for
    // one element, which is the failure mode `nodeMedia`'s owner-checked
    // adoption exists to make impossible — and the one this epic could
    // reintroduce at a higher level.
    //
    // ⚠ P3 ADDED THE HLS PAIR, and it widens what this boundary demonstrates. The
    // first two were FILE players, so "the bytes came from a user gesture" was
    // available as a reason the card had to own them. peertube and tvLibrarian
    // are NETWORK tuners with no gesture in the acquisition path at all, and
    // they were card-owned anyway — which is the honest statement of the epic:
    // the card was never the right owner, it was just the file the code was
    // written in.
    //
    // ⚠ THE LEGACY-REMOVAL ADDITION (S1, 2026-09-03) IS `loopback`, and it is
    // the one member whose departure was NOT driven by a defect. The other four
    // were measurably broken by card ownership. Loopback worked: the headless
    // host kept its card mounted and the capture survived every collapse. It is
    // here because the card must become deletable, and a load-bearing card
    // cannot be. The boundary demonstrates the same thing either way — the card
    // was never the right owner — but a reader looking for the bug this one
    // fixed will not find one, and should not go hunting.
    for (const t of [
      'videobox', 'videovarispeed', 'peertube', 'tvLibrarian', 'loopback', 'cameraInput', 'archivist',
    ]) {
      expect(
        DOM_SOURCE_LANE_TYPES.has(t),
        `${t}'s attach, audio wiring and loops belong to a node-scoped controller under ` +
          '$lib/ui/media/ on graph lifetime — its card mount is not load-bearing, so it must NOT ' +
          'be a DOM-source module',
      ).toBe(false);
      expect(
        NODE_OWNED_SOURCE_TYPES.has(t),
        `${t} left DOM_SOURCE_LANE_TYPES, so something must have taken ownership — it is absent from ` +
          'EVERY node-owner set, which would mean NOBODY owns its source',
      ).toBe(true);
    }
  });

  it('the two OWNERSHIP sets are DISJOINT — a module has exactly one source owner', () => {
    // The direction that costs. `DOM_SOURCE_LANE_TYPES` means "the CARD attaches
    // and the engine keeps it"; `NODE_VIDEO_SOURCE_TYPES` means "a node-scoped
    // controller attaches". A type in both would be two attach sites for one
    // element, and whichever ran last would win non-deterministically — the
    // double-mount hazard, one level up from the one `nodeMedia` already solved.
    //
    // ⚠ This is what makes a conversion ATOMIC rather than merely conventional:
    // a PR that adds a controller without removing the card's attach reddens
    // here, and one that removes the card's attach without adding a controller
    // reddens on the derivation leg above. Neither half can land alone.
    const both = [...NODE_OWNED_SOURCE_TYPES].filter((t) => DOM_SOURCE_LANE_TYPES.has(t));
    expect(
      both,
      `type(s) claimed by BOTH a card attach and a node controller: ${both.join(', ')}`,
    ).toEqual([]);
    // VACUITY: the disjointness above is trivially true of an empty controller
    // set, which is exactly what it looks like the day someone deletes the
    // registry import. Anchor it to a real member.
    expect(
      NODE_OWNED_SOURCE_TYPES.size,
      'no module has a node-owned video source',
    ).toBeGreaterThan(0);
    // ...and the FOUR registries are disjoint from EACH OTHER too, which is the
    // direction P3 introduced: one module cannot be claimed by two controllers
    // any more than by a controller and a card.
    const owners = [
      ['NODE_VIDEO_SOURCE_TYPES', NODE_VIDEO_SOURCE_TYPES],
      ['NODE_VARISPEED_TYPES', NODE_VARISPEED_TYPES],
      ['NODE_HLS_SOURCE_TYPES', NODE_HLS_SOURCE_TYPES],
      ['NODE_LOOPBACK_SOURCE_TYPES', NODE_LOOPBACK_SOURCE_TYPES],
      ['NODE_CAMERA_SOURCE_TYPES', NODE_CAMERA_SOURCE_TYPES],
      ['NODE_ARCHIVIST_SOURCE_TYPES', NODE_ARCHIVIST_SOURCE_TYPES],
      ['NODE_FRAME_PRODUCER_TYPES', NODE_FRAME_PRODUCER_TYPES],
      ['NODE_VIZ_SURFACE_TYPES', NODE_VIZ_SURFACE_TYPES],
    ] as const;
    const doubleOwned: string[] = [];
    for (let i = 0; i < owners.length; i++) {
      for (let j = i + 1; j < owners.length; j++) {
        for (const t of owners[i]![1]) {
          if (owners[j]![1].has(t)) doubleOwned.push(`${t}: ${owners[i]![0]} + ${owners[j]![0]}`);
        }
      }
    }
    expect(doubleOwned, `type(s) claimed by TWO node controllers: ${doubleOwned.join(' | ')}`)
      .toEqual([]);
  });
});

describe('CARD_PRODUCER_LANE_TYPES — the second seam (#1587: the card IS the producer)', () => {
  it('is EXACTLY the set of module types whose card writes engine state through a PRODUCER seam', () => {
    const { found, unmapped, hits } = derivedProducerTypes();

    // A producing card that resolves to no registered def is a hole the set
    // cannot possibly cover — fail on it rather than dropping it silently.
    expect(unmapped, `card(s) matching a producer seam resolve to no module def: ${unmapped.join(', ')}`)
      .toEqual([]);

    // VACUITY GUARD. The set is legitimately EMPTY since legacy-removal S1.5
    // (cube was the last member out), so `[] toEqual []` is the CORRECT green —
    // what keeps it from being a blind green is the seam-liveness leg below,
    // which feeds a synthetic producer card through the SAME `seamHitFor` and
    // requires the derivation to classify it. A seam-regex rename therefore
    // reds THERE rather than silently emptying both sides of this comparison.
    expect(PRODUCER_SEAMS.length, 'at least one producer seam is declared').toBeGreaterThan(0);

    expect([...found].sort(), `derived from card sources: ${hits.join(' | ')}`)
      .toEqual([...CARD_PRODUCER_LANE_TYPES].sort());
  });

  it('every producer seam still FIRES on the call shape it was written for — the instrument is live', () => {
    // ⚠ RE-ANCHORED OFF THE POPULATION (legacy-removal S1.5). This leg used to
    // require every seam to match a LIVE card, which was right while cards
    // carried producers and a non-matching seam meant a rename nobody followed.
    // The producer extractions drain that population BY DESIGN — rasterize's
    // departure left the `write` seam with no card to match, on a commit where
    // the rule had not changed — and the population reaching zero is the
    // epic's goal state, not a hole. What must stay true forever is that each
    // seam CLASSIFIES a producer card correctly the day one returns, so the
    // anchor moves from the population to the INSTRUMENT: a synthetic card
    // body per seam, fed through the SAME `seamHitFor` the derivation runs.
    const SYNTHETIC_PRODUCERS: Record<string, string> = {
      'engine.write(node|id, …)':
        "const bmp = compose();\neng.write(node, 'displayFrame', bmp);",
      'install*FrameDrawer(…)':
        'installSomethingFrameDrawer(nodeId, drawIntoBridge);',
    };
    for (const seam of PRODUCER_SEAMS) {
      const body = SYNTHETIC_PRODUCERS[seam.id];
      expect(
        body,
        `${seam.id}: every declared seam carries a synthetic body here — a seam this leg ` +
          'cannot exercise is a seam nothing controls',
      ).toBeTruthy();
      const hit = seamHitFor(
        { base: 'SyntheticCard', entry: '/synthetic/SyntheticCard.svelte', files: [
          { path: '/synthetic/SyntheticCard.svelte', src: body! },
        ] },
        PRODUCER_SEAMS,
      );
      expect(
        hit?.seam,
        `${seam.id}: the derivation must classify a card carrying this call as a producer`,
      ).toBe(seam.id);
    }
    // …and the map cannot hoard entries for seams that no longer exist.
    const ids = new Set(PRODUCER_SEAMS.map((s) => s.id));
    const stale = Object.keys(SYNTHETIC_PRODUCERS).filter((id) => !ids.has(id));
    expect(stale, `synthetic bodies for retired seam(s): ${stale.join(', ')}`).toEqual([]);
  });

  it('the two sets are DISJOINT — a card growing both seams is a decision, not a merge', () => {
    // The sets have different downstream consumers (the collapse-keeps-playing
    // sweep and the face-migration inventory read the DOM-source one and mean
    // "media element" by it). If a card ever both attaches a source AND
    // produces state, which set it joins changes what those gates assert about
    // it — so surface it here instead of absorbing it.
    const overlap = [...CARD_PRODUCER_LANE_TYPES].filter((t) => DOM_SOURCE_LANE_TYPES.has(t));
    expect(overlap, `type(s) in BOTH lane sets: ${overlap.join(', ')}`).toEqual([]);
  });

  it('BOTH halves are EMPTY — the state the headless-mount retirement rests on', () => {
    // ⚠ `HEADLESS_MOUNT_LANE_TYPES` (the union), `needsHeadlessSourceMount` and
    // `<HeadlessSourceHost>` retired together in legacy-removal S1.5, exactly
    // as the decision legs' own anchors prescribed ("retired with the host
    // itself, not re-pointed at a synthetic type"). This leg is the surviving
    // population statement: a member returning to EITHER set reddens here, and
    // whoever brings one back needs a node-scoped owner — not a host revival.
    expect(
      DOM_SOURCE_LANE_TYPES.size,
      'a card-owned DOM source exists again — it needs a node-scoped owner (see the departures ' +
        'recorded on the set), because nothing keeps a card mounted for it any more',
    ).toBe(0);
    expect(
      CARD_PRODUCER_LANE_TYPES.size,
      'a card producer exists again — same consequence, producer half',
    ).toBe(0);
  });

  it('NEGATIVE CONTROL: each seam regex fires on the CALL and not on the PROSE around it', () => {
    const write = PRODUCER_SEAMS.find((s) => s.id === 'engine.write(node|id, …)')!.re;
    const drawer = PRODUCER_SEAMS.find((s) => s.id === 'install*FrameDrawer(…)')!.re;

    // Fires on the real call shapes these cards use…
    expect(write.test("if (eng && node) eng.write(node, 'displayFrame', bmp);")).toBe(true);
    expect(write.test("if (lv) eng.write(node, 'video_levels_a', lv);")).toBe(true);
    // …and the OTHER engine overload, which the pre-#1720 pattern missed: the
    // DOMAIN engine takes a node ID, and produces identical engine state.
    expect(write.test("ve.write(id, 'displayFrame', bmp);")).toBe(true);
    expect(write.test("videoEngine.write(nodeId, 'displayFrame', bmp);")).toBe(true);
    expect(drawer.test('installWavesculptFrameDrawer(id, myFrameDrawer);')).toBe(true);
    expect(drawer.test('function installBridgeFrameDrawer(): void {')).toBe(true);

    // …and NOT on the prose/adjacent-API forms that really occur in these cards.
    // `writable.write(blob)` is FrametableCard's File System Access save path —
    // it writes a FILE, not engine state, and pulling it in would give
    // frametable a second, wrong reason to be headless-mounted.
    expect(write.test('await writable.write(blob);')).toBe(false);
    // The widening must not swallow an unrelated first argument that merely
    // STARTS with one of the names — `idx`, `nodeIds`, `identity`.
    expect(write.test("port.write(idx, 'x');")).toBe(false);
    expect(write.test("bus.write(nodeIds, 'x');")).toBe(false);
    expect(write.test("log.write(identity, 'x');")).toBe(false);
    // TimelordeCard's own comment naming the API without the `node` argument.
    expect(write.test("// PUSHES that same frame back into the node (handle.write('displayFrame', …))")).toBe(false);
    expect(write.test('const rewritten = rewrite(nodes, edges);')).toBe(false);
    expect(drawer.test('// the card installs a frame drawer for the bridge')).toBe(false);
    expect(drawer.test('uninstallWavesculptFrameDrawer(id, myFrameDrawer);')).toBe(false);
  });

  it('SCOPE: this gate reads SEAMS, never behaviour — the e2e owns "does the picture move"', () => {
    // Stated as an assertion so it cannot rot into a comment nobody reads: the
    // declared set is a set of TYPE IDS, every one of which must resolve to a
    // registered module def. Nothing here observes a pixel, a rAF or a mount.
    const known = new Set(cardNameToType().values());
    const ghosts = [...CARD_PRODUCER_LANE_TYPES].filter((t) => !known.has(t));
    expect(ghosts, `declared producer type(s) with no registered module def: ${ghosts.join(', ')}`).toEqual([]);
  });
});

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
      laneRenderKind({
        shellFaces: true,
        userDocked: false,
        type: 'cameraInput',
        // isShellSwappable() is now TRUE for it — Canvas passes that through as
        // hasCard. This is the leg that flipped.
        hasCard: true,
        migrated: true,
      }),
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

  it('still keeps its real card under ?shell=legacy, where nothing changed', () => {
    const kind = laneRenderKind({
      shellFaces: false,
      userDocked: false,
      type: 'cameraInput',
      hasCard: true,
      migrated: true,
    });
    expect(kind).toBe('legacy');
    // (The decision half of this leg — "and no host mounts beside it" —
    // retired with the decision; no host mounts beside ANYTHING now.)
  });

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
