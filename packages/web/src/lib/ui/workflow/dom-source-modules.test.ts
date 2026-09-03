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

import {
  CARD_PRODUCER_LANE_TYPES,
  DOM_SOURCE_LANE_TYPES,
  FACE_MOUNTS_PRODUCER,
  HEADLESS_MOUNT_LANE_TYPES,
  needsHeadlessSourceMount,
} from './dom-source-modules';
// The OTHER side of the ownership question (LEG-02, #1511). Imported here rather
// than asserted from a second copy of the list, so "who owns this module's
// source" has exactly one answer per module and this gate can check it.
import { NODE_VIDEO_SOURCE_TYPES } from '$lib/ui/media/node-video-source-registry';
import { NODE_VARISPEED_TYPES } from '$lib/ui/media/node-varispeed-registry';
import { NODE_HLS_SOURCE_TYPES } from '$lib/ui/media/node-hls-source-registry';
import { NODE_LOOPBACK_SOURCE_TYPES } from '$lib/ui/media/node-loopback-source-registry';

/** Every node-scoped source owner there is. Read as ONE set wherever the
 *  question is "has SOMETHING taken ownership of this module's source", so a
 *  fifth registry joins by being imported here rather than by an edit at each
 *  of the four sites below. */
const NODE_OWNED_SOURCE_TYPES: ReadonlySet<string> = new Set<string>([
  ...NODE_VIDEO_SOURCE_TYPES,
  ...NODE_VARISPEED_TYPES,
  ...NODE_HLS_SOURCE_TYPES,
  ...NODE_LOOPBACK_SOURCE_TYPES,
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

const SUBTREE_SEAM_EXEMPTIONS: readonly SubtreeSeamExemption[] = [
  {
    card: 'GroupCard',
    component: 'ScopeCard.svelte',
    why:
      'GroupCard mounts a HIDDEN ScopeCard per viz-passthrough CHILD (`<ScopeCard ' +
      '{...hiddenCardProps(vc.childNode)} />`), so the `write(node, …)` it reaches writes to the ' +
      "CHILD's node — `scope`, already a member in its own right — and never to the group's. " +
      'Enrolling `group` would headless-mount an organizational container that is a ' +
      'NON_SHELL_LANE_TYPE and is never swapped away in the first place, buying an off-screen ' +
      'mount for a node whose engine state does not exist.',
  },
];

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
    // Direction 1 — the widening is LOAD-BEARING. Run the identical predicate
    // with the pre-#1724 filters reinstated and require the answer to be
    // strictly smaller. A revert to a flat, suffix-filtered walk fails HERE
    // rather than silently going green with cube's picture black again.
    const byName = cardNameToType();
    const wide = derivedProducerTypes().found;
    const flatOnly = new Set<string>();
    for (const card of cardSources()) {
      const own = card.files.find((f) => f.path === card.entry)!;
      if (!PRODUCER_SEAMS.some((s) => s.re.test(own.src))) continue;
      const t = byName.get(card.base);
      if (t) flatOnly.add(t);
    }
    const gained = [...wide].filter((t) => !flatOnly.has(t)).sort();
    expect(
      gained,
      'the card-file-only walk found the SAME set as the subtree walk. Either the walk has been ' +
        'narrowed back to one file per card, or every producer now lives in its card — in which ' +
        'case this leg has stopped measuring anything and needs a decision, not a deletion.',
    ).not.toEqual([]);
    // …and the widening only ever ADDS. A subtree walk that lost a member would
    // mean the exemption list is eating real coverage.
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
    const cubeCard = join(CARD_DIR, 'CubeCard.svelte');
    const subtree = componentSubtree(cubeCard).map((p) => rel(p));
    expect(subtree, 'the entry itself is always in its own subtree').toContain('CubeCard.svelte');
    expect(
      subtree,
      'CubeCard mounts cube/CubeVizSurface.svelte by a RELATIVE specifier — the edge #1724 was about',
    ).toContain('cube/CubeVizSurface.svelte');
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
    //    it). This gate cannot follow that edge, and does not need to HERE: the
    //    panel's own renderer is CubeVizSurface, which the card DOES reach. But
    //    a module whose producer is ONLY in a dynamically-mounted panel would be
    //    invisible — the e2e (card-producer-lifetime.spec.ts) is the net.
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

    // Sanity: the grep found SOMETHING (a refactor that renames the engine hook
    // must fail loudly here rather than silently emptying the set).
    expect(attaching.size).toBeGreaterThan(0);

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
    expect(evidence, 'no DOM-source module produced retention evidence').not.toEqual([]);
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
    for (const t of ['cameraInput', 'archivist']) {
      expect(DOM_SOURCE_LANE_TYPES.has(t), `${t} is a DOM-source module`).toBe(true);
    }
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
    for (const t of ['videobox', 'videovarispeed', 'peertube', 'tvLibrarian', 'loopback']) {
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

    // VACUITY GUARD, in both halves. If a rename ever empties the seam regexes
    // the derived set goes empty and an `toEqual` against an emptied declared
    // set would pass while the gate measured nothing.
    expect(PRODUCER_SEAMS.length, 'at least one producer seam is declared').toBeGreaterThan(0);
    expect(found.size, `no card matched any producer seam — did a seam get renamed? seams: ${PRODUCER_SEAMS.map((s) => s.id).join(', ')}`)
      .toBeGreaterThan(0);

    expect([...found].sort(), `derived from card sources: ${hits.join(' | ')}`)
      .toEqual([...CARD_PRODUCER_LANE_TYPES].sort());
  });

  it('every producer seam actually MATCHES a card — a dead seam is a silent hole', () => {
    // ANCHORED TO THE ARTIFACT: a seam whose regex no longer resolves to any
    // card is either a rename nobody followed or a mechanism that is gone.
    // Either way the entry must not sit here reading as coverage.
    const sources = cardSources();
    const dead = PRODUCER_SEAMS.filter(
      (s) => !sources.some((c) => c.files.some((f) => s.re.test(f.src))),
    ).map((s) => s.id);
    expect(dead, `producer seam(s) matching NO card: ${dead.join(', ')}`).toEqual([]);
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

  it('HEADLESS_MOUNT_LANE_TYPES is exactly the union — the host filter cannot drift from either half', () => {
    expect([...HEADLESS_MOUNT_LANE_TYPES].sort()).toEqual(
      [...new Set([...DOM_SOURCE_LANE_TYPES, ...CARD_PRODUCER_LANE_TYPES])].sort(),
    );
    for (const t of HEADLESS_MOUNT_LANE_TYPES) {
      expect(
        needsHeadlessSourceMount({ kind: 'placeholder', type: t }),
        `${t} is headless-mounted when the shell swaps its card away`,
      ).toBe(true);
    }
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

describe('needsHeadlessSourceMount — the pure headless-mount decision', () => {
  const KINDS: LaneRenderKind[] = ['legacy', 'shell', 'placeholder', 'stub'];

  it('mounts ONLY when the shell swapped the card away (shell | placeholder)', () => {
    // ⚠ SUBJECT MOVED TWICE NOW (#1511): `videobox` in P1, then
    // `videovarispeed` in P2 — each conversion retires whatever this leg was
    // pointed at, which is the epic working rather than the test being fragile.
    // The repair is always a LIVE subject, never a relaxed expectation:
    // `archivist` is still card-owned and exercises the same arm. When it
    // converts, re-point again — and when the set finally empties, this leg's
    // subject is gone for good and the leg goes with it.
    //
    // ⚠ SUBJECT MOVED A THIRD TIME (P3): it pointed at `tvLibrarian`, which this
    // phase converted along with `peertube`. The remaining card-owned DOM
    // sources are archivist, cameraInput and loopback — all three CAPTURE-ish,
    // which is a real change in the character of what is left rather than three
    // arbitrary names.
    for (const kind of KINDS) {
      const want = kind === 'shell' || kind === 'placeholder';
      expect(
        needsHeadlessSourceMount({ kind, type: 'archivist' }),
        `archivist @ ${kind}`,
      ).toBe(want);
    }
  });

  it('NEVER mounts a module whose source moved to a node controller, on ANY lane kind', () => {
    // The inverse of the leg above, and the property that makes the conversion
    // worth anything: a converted module must not keep paying the off-screen
    // mount. Derived from the ownership set rather than naming videobox, so the
    // next conversion inherits the assertion instead of needing a new one.
    for (const type of NODE_OWNED_SOURCE_TYPES) {
      for (const kind of KINDS) {
        expect(
          needsHeadlessSourceMount({ kind, type }),
          `${type} @ ${kind}: its lifecycle is node-owned, so nothing should keep a card alive for it`,
        ).toBe(false);
      }
      // ...including the two arms that are NOT about the lane kind at all.
      expect(needsHeadlessSourceMount({ kind: 'shell', type, laneOmitsNode: true }), `${type} in a collapsed group`).toBe(false);
      expect(needsHeadlessSourceMount({ kind: 'placeholder', type, hostedElsewhere: false }), `${type} hosted nowhere`).toBe(false);
    }
  });

  it('mounts a CARD-PRODUCER module on the same two kinds (#1587)', () => {
    for (const kind of KINDS) {
      const want = kind === 'shell' || kind === 'placeholder';
      expect(needsHeadlessSourceMount({ kind, type: 'wavesculpt' }), `wavesculpt @ ${kind}`).toBe(want);
      expect(needsHeadlessSourceMount({ kind, type: 'timelorde' }), `timelorde @ ${kind}`).toBe(want);
    }
  });

  it('never mounts a module in NEITHER set, whatever the lane renders', () => {
    for (const kind of KINDS) {
      expect(needsHeadlessSourceMount({ kind, type: 'acidwarp' })).toBe(false);
      expect(needsHeadlessSourceMount({ kind, type: 'tidyvco' })).toBe(false);
    }
  });

  it("never DOUBLE-mounts: 'legacy' (card in the lane) and 'stub' (card in the dock rail) are excluded", () => {
    // Two live <video> elements for one node would each getUserMedia, and
    // whichever unmounted first would detach the survivor's source.
    expect(needsHeadlessSourceMount({ kind: 'legacy', type: 'cameraInput' })).toBe(false);
    expect(needsHeadlessSourceMount({ kind: 'stub', type: 'videobox' })).toBe(false);
  });

  it('is a strict NO-OP under ?shell=legacy (that path can only produce legacy/stub)', () => {
    for (const type of HEADLESS_MOUNT_LANE_TYPES) {
      const kind = laneRenderKind({
        shellFaces: false,
        userDocked: false,
        type,
        hasCard: true,
        migrated: false,
      });
      expect(kind).toBe('legacy');
      // ⚠ NO `laneOmitsNode` HERE, deliberately: that arm is the one exception
      // to this claim and has its own describe below. Adding it to this loop
      // would quietly convert a true statement about the SHELL into a false one
      // about the whole decision.
      expect(needsHeadlessSourceMount({ kind, type })).toBe(false);
    }
  });
});

describe("laneOmitsNode — a COLLAPSED GROUP's child, in BOTH shells (#1721)", () => {
  const KINDS: LaneRenderKind[] = ['legacy', 'shell', 'placeholder', 'stub'];

  it('hosts EXACTLY the producer half — membership derived, never listed here', () => {
    // DERIVED MEMBERSHIP, both directions, over the whole union: a type is
    // hosted under this arm IF AND ONLY IF it is a CARD_PRODUCER. Nothing in
    // this test names a module, so a sixth producer enrols itself and a tenth
    // DOM-source module stays out, with no edit here.
    for (const type of HEADLESS_MOUNT_LANE_TYPES) {
      for (const kind of KINDS) {
        expect(
          needsHeadlessSourceMount({ kind, type, laneOmitsNode: true }),
          `${type} @ ${kind} with the lane emitting no node`,
        ).toBe(CARD_PRODUCER_LANE_TYPES.has(type));
      }
    }
  });

  it('is SHELL-INDEPENDENT — the same answer on the legacy kind as on the shell kinds', () => {
    // THE CLAIM THAT MAKES #1721 DIFFERENT from every other row of #1583. The
    // collapsed-child skip lives in the flowNodes derivation OUTSIDE its
    // `shellFaces` branch, so the defect exists under `?shell=legacy` too, and
    // a fix that only ran under the shell would leave half of it standing.
    // MEASURED on the pre-fix tree, wavesculpt.video_out → VIDEO OUT: before
    // grouping `nonBlack 170/3072 maxLuma 203, 20 distinct signatures in 20
    // frames` (default shell) and `172/3072, 206, 20` (?shell=legacy); once the
    // group collapsed, `0/3072, 0, 1 signature` in BOTH.
    for (const type of CARD_PRODUCER_LANE_TYPES) {
      const legacyKind = laneRenderKind({
        shellFaces: false,
        userDocked: false,
        type,
        hasCard: true,
        migrated: false,
      });
      expect(legacyKind).toBe('legacy');
      expect(
        needsHeadlessSourceMount({ kind: legacyKind, type, laneOmitsNode: true }),
        `${type} in a collapsed group under ?shell=legacy`,
      ).toBe(true);
      expect(
        needsHeadlessSourceMount({ kind: 'placeholder', type, laneOmitsNode: true }),
        `${type} in a collapsed group under the faceplate shell`,
      ).toBe(true);
    }
  });

  it('leaves the DOM-SOURCE half exactly as it was — a camera is not opened off-screen', () => {
    // The half of the original author's parity argument that still stands on
    // its own: `node-media-registry` already owns those elements across a card
    // unmount, and hosting a capture module because a GROUP is collapsed would
    // run getUserMedia with no UI anywhere. Asserted over the derived set.
    for (const type of DOM_SOURCE_LANE_TYPES) {
      for (const kind of KINDS) {
        expect(
          needsHeadlessSourceMount({ kind, type, laneOmitsNode: true }),
          `${type} @ ${kind} must NOT be hosted just because its group collapsed`,
        ).toBe(false);
      }
    }
  });

  it('never mounts a module in NEITHER set, collapsed or not', () => {
    for (const kind of KINDS) {
      for (const laneOmitsNode of [true, false]) {
        expect(needsHeadlessSourceMount({ kind, type: 'acidwarp', laneOmitsNode })).toBe(false);
        expect(needsHeadlessSourceMount({ kind, type: 'tidyvco', laneOmitsNode })).toBe(false);
      }
    }
  });

  it('hostedElsewhere OVERRIDES every arm — no node is mounted twice', () => {
    // GroupCard hidden-mounts a viz-passthrough child's real card for exactly
    // as long as the group is collapsed ($lib/ui/modules/group-viz-hosts), which
    // is precisely the window `laneOmitsNode` is true in. Two live mounts of one
    // node is the hazard the 'stub' and dock-full-view arms already exist for.
    for (const type of HEADLESS_MOUNT_LANE_TYPES) {
      for (const kind of KINDS) {
        for (const laneOmitsNode of [true, false]) {
          expect(
            needsHeadlessSourceMount({ kind, type, laneOmitsNode, hostedElsewhere: true }),
            `${type} @ ${kind} (laneOmitsNode=${laneOmitsNode}) is already hosted elsewhere`,
          ).toBe(false);
        }
      }
    }
  });

  it('PERMANENT NEGATIVE CONTROL: every new input actually MOVES the decision, both ways', () => {
    // A decision that ignored its new inputs would satisfy some of the above by
    // accident. Each of these pairs differs in exactly ONE input and must differ
    // in the answer — so a constant-returning implementation reddens here first.
    const producer = [...CARD_PRODUCER_LANE_TYPES][0]!;
    const domSource = [...DOM_SOURCE_LANE_TYPES].find((t) => !NON_SHELL_LANE_TYPES.has(t))!;

    // laneOmitsNode: false → true flips a producer ON, on a kind that never mounts.
    expect(needsHeadlessSourceMount({ kind: 'legacy', type: producer })).toBe(false);
    expect(needsHeadlessSourceMount({ kind: 'legacy', type: producer, laneOmitsNode: true })).toBe(true);

    // ...and true → false flips it back OFF again, which is the direction that
    // proves the arm is not simply "always true for a producer".
    expect(needsHeadlessSourceMount({ kind: 'stub', type: producer, laneOmitsNode: true })).toBe(true);
    expect(needsHeadlessSourceMount({ kind: 'stub', type: producer, laneOmitsNode: false })).toBe(false);

    // hostedElsewhere: false → true flips a mounting case OFF...
    expect(needsHeadlessSourceMount({ kind: 'placeholder', type: producer })).toBe(true);
    expect(
      needsHeadlessSourceMount({ kind: 'placeholder', type: producer, hostedElsewhere: true }),
    ).toBe(false);
    // ...and back ON when it is false again.
    expect(
      needsHeadlessSourceMount({ kind: 'placeholder', type: producer, hostedElsewhere: false }),
    ).toBe(true);

    // The CHANNEL split is real: same inputs, different half of the union.
    expect(needsHeadlessSourceMount({ kind: 'legacy', type: domSource, laneOmitsNode: true })).toBe(false);
    expect(needsHeadlessSourceMount({ kind: 'legacy', type: producer, laneOmitsNode: true })).toBe(true);
  });

  it('SCOPE: this arm reads a FLAG the caller computes, never the graph', () => {
    // Stated inside the gate. `needsHeadlessSourceMount` cannot see a group, a
    // collapsed flag or a node — Canvas computes `laneOmitsNode` from
    // `collapsedGroupIds` + `data.parentGroupId` and `hostedElsewhere` from the
    // GroupCard registry, and NOTHING here proves it computes either correctly.
    // That wiring is proven by e2e/tests/card-producer-lifetime.spec.ts's #1721
    // leg, which reads the real DOM in both shells; and the CANVAS-HIDDEN arm
    // (pinned singletons / hiddenCard cameras — #1754) reaches this decision
    // only because Canvas folds it INTO `laneOmitsNode`, which is a caller fact
    // this function still cannot see.
    expect(typeof needsHeadlessSourceMount).toBe('function');
  });
});

describe('FACE_MOUNTS_PRODUCER — the dock-open exemption, anchored both ways', () => {
  // ⚠ AN EXEMPTION LIST THAT NAMES A VANISHED SUBJECT IS RED, and both
  // directions matter here for different reasons. A member that stops being a
  // CARD_PRODUCER is a dead entry; a member that stops being FACED is worse than
  // dead, because `fullViewShowsFaceInstead` only consults this set for migrated
  // types — the entry would read as a live decision while deciding nothing.

  it('every member is a CARD_PRODUCER — the only population the flag is consulted for', () => {
    const strays = [...FACE_MOUNTS_PRODUCER].filter((t) => !CARD_PRODUCER_LANE_TYPES.has(t));
    expect(
      strays,
      'a FACE_MOUNTS_PRODUCER entry names a type that is not a card-owned producer, so the ' +
        'exemption it claims can never be reached. Delete it.',
    ).toEqual([]);
  });

  it('every member is FACED — an unfaced entry is a decision that never fires', () => {
    const unfaced = [...FACE_MOUNTS_PRODUCER].filter((t) => !STRICT_FACES.has(t));
    expect(
      unfaced,
      'a FACE_MOUNTS_PRODUCER entry names an UNPROMOTED module. `fullViewShowsFaceInstead` ' +
        'requires `migrated(type)`, so the entry is inert — and if that module is ever promoted ' +
        'it inherits an exemption nobody re-argued.',
    ).toEqual([]);
  });

  it('it is a PROPER SUBSET — the default is "keep the host", and something uses it', () => {
    // ⚠ THE VACUITY LEG. If every producer were exempt, the deny-by-default this
    // set inverted would be gone and the change that introduced it would be
    // undone in silence. timelorde is the module that must NOT be in here: its
    // face only BLITS `video_out`, so hosting is the only thing that keeps the
    // picture alive while the faceplate is open.
    const facedProducers = [...CARD_PRODUCER_LANE_TYPES].filter((t) => STRICT_FACES.has(t));
    const keepsHost = facedProducers.filter((t) => !FACE_MOUNTS_PRODUCER.has(t));
    expect(
      keepsHost,
      'EVERY faced producer claims to mount its own producer, so no module exercises the ' +
        'default — the exemption has quietly become the rule',
    ).not.toEqual([]);
    expect(
      keepsHost,
      'timelorde must keep its headless host while its dock full view is open: its faceplate ' +
        'blits `video_out` and mounts no renderer of its own',
    ).toContain('timelorde');
  });
});

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
describe('cameraInput — PROMOTED, and kept alive by the headless host instead', () => {
  it('is a DOM-source module, which is what makes the host apply', () => {
    expect(DOM_SOURCE_LANE_TYPES.has('cameraInput')).toBe(true);
    expect(HEADLESS_MOUNT_LANE_TYPES.has('cameraInput')).toBe(true);
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

  it('and is THEREFORE headless-hosted — the source is not orphaned', () => {
    expect(needsHeadlessSourceMount({ kind: 'shell', type: 'cameraInput' })).toBe(true);
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
    expect(
      needsHeadlessSourceMount({ kind, type: 'cameraInput' }),
      'the card is IN the lane there, so a host would be a double mount',
    ).toBe(false);
  });

  it('a DOCKED camera is not hosted either — DockCardHost has the real card', () => {
    expect(needsHeadlessSourceMount({ kind: 'stub', type: 'cameraInput' })).toBe(false);
  });

  it('EVERY headless-hosted module is now uniform — no member needs a skip', () => {
    // ⚠ THIS LOOP USED TO CARRY `if (t === 'cameraInput') continue;`. Dropping
    // the skip is the assertion: the one module that needed an exception is now
    // covered by the same rule as the other fourteen, so the sweep is strictly
    // stronger than it was rather than merely re-pointed.
    for (const t of HEADLESS_MOUNT_LANE_TYPES) {
      expect(NON_SHELL_LANE_TYPES.has(t), `${t} must swap to a tile`).toBe(false);
      expect(needsHeadlessSourceMount({ kind: 'placeholder', type: t })).toBe(true);
      expect(needsHeadlessSourceMount({ kind: 'shell', type: t })).toBe(true);
    }
  });
});

describe('the DOCK FULL VIEW hosts the real card only for an UN-MIGRATED module', () => {
  // ⚠ A GATE WHOSE PRECONDITION WAS THE ABSENCE OF THE FEATURE. Canvas excluded
  // every full-view node from the headless host unconditionally, on the stated
  // premise that "DockFullView already mounts its real card". `DockFullView` is
  // `{#if migrated} <ModuleShell/> {:else} <CardComponent/>`, so that premise
  // held only while NO card-owned-source module was promoted — which was true
  // for every member of this set until cameraInput.
  //
  // The fix routes it through `hostedElsewhere`, whose contract already says
  // exactly this ("SOME OTHER live surface already mounts this node's REAL
  // card"). `needsHeadlessSourceMount` is unchanged; the CALLER's answer to that
  // question is what was wrong.
  //
  // ⚠ THE PURE DECISION CANNOT SEE `migrated`, BY DESIGN — it reads a flag the
  // caller computes, exactly as it does for `laneOmitsNode`. So these legs pin
  // the DECISION's behaviour given each answer; that Canvas computes the answer
  // correctly is proven in e2e/tests/camerainput-shell-source.spec.ts, which
  // opens the dock faceplate and asserts the picture survives it.
  it('an un-migrated full-view occupant is hosted ELSEWHERE and gets no second mount', () => {
    expect(
      needsHeadlessSourceMount({ kind: 'shell', type: 'cameraInput', hostedElsewhere: true }),
    ).toBe(false);
  });

  it('a MIGRATED one still needs the host while its faceplate is open', () => {
    expect(
      needsHeadlessSourceMount({ kind: 'shell', type: 'cameraInput', hostedElsewhere: false }),
    ).toBe(true);
  });
});
