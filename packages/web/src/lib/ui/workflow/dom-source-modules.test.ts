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
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import '$lib/audio/modules';
import '$lib/video/modules';
import '$lib/meta/modules';

import { listModuleDefs } from '$lib/audio/module-registry';
import { listVideoModuleDefs } from '$lib/video/module-registry';
import { listMetaModuleDefs } from '$lib/meta/module-registry';
import { conventionalCardName, type CardDefLike } from '$lib/ui/modules-card-map';

import {
  CARD_PRODUCER_LANE_TYPES,
  DOM_SOURCE_LANE_TYPES,
  HEADLESS_MOUNT_LANE_TYPES,
  needsHeadlessSourceMount,
} from './dom-source-modules';
import { NON_SHELL_LANE_TYPES, laneRenderKind, type LaneRenderKind } from './legacy-fallback';

/** The card directory the glob resolver reads (../modules relative to here). */
const CARD_DIR = fileURLToPath(new URL('../modules/', import.meta.url));

/** A REAL call, not a mention in prose: `attachExternalSource(` / `?.(`.
 *  (Comments in these cards say "attachExternalSource" without parens, and the
 *  card-side calls always look like `ve?.attachExternalSource(` /
 *  `engine.attachExternalSource(`.) */
const CALL_RE = /attachExternalSource\s*\(/;

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

/** Every `*Card.svelte` in the glob directory, as (basename, source). */
function cardSources(): Array<{ base: string; src: string }> {
  const out: Array<{ base: string; src: string }> = [];
  for (const file of readdirSync(CARD_DIR)) {
    if (!file.endsWith('Card.svelte')) continue;
    out.push({
      base: file.replace(/\.svelte$/, ''),
      src: readFileSync(new URL(file, `file://${CARD_DIR}`), 'utf8'),
    });
  }
  return out;
}

/** Module types whose card matches ANY producer seam, plus the cards that
 *  matched but resolve to no registered def (a hole the set cannot cover). */
function derivedProducerTypes(): { found: Set<string>; unmapped: string[]; hits: string[] } {
  const byName = cardNameToType();
  const found = new Set<string>();
  const unmapped: string[] = [];
  const hits: string[] = [];
  for (const { base, src } of cardSources()) {
    const seam = PRODUCER_SEAMS.find((s) => s.re.test(src));
    if (!seam) continue;
    hits.push(`${base} → ${seam.id}`);
    const type = byName.get(base);
    if (!type) {
      unmapped.push(base);
      continue;
    }
    found.add(type);
  }
  return { found, unmapped, hits };
}

describe('DOM_SOURCE_LANE_TYPES — the grep gate (a new source module cannot ship dark)', () => {
  it('is EXACTLY the set of module types whose card calls attachExternalSource()', () => {
    const byName = cardNameToType();
    const found = new Set<string>();
    const unmapped: string[] = [];

    for (const file of readdirSync(CARD_DIR)) {
      if (!file.endsWith('Card.svelte')) continue;
      const src = readFileSync(new URL(file, `file://${CARD_DIR}`), 'utf8');
      if (!CALL_RE.test(src)) continue;
      const base = file.replace(/\.svelte$/, '');
      const type = byName.get(base);
      if (!type) {
        unmapped.push(base);
        continue;
      }
      found.add(type);
    }

    // Every card that attaches a DOM source must resolve to a registered def —
    // otherwise the set below can't possibly be complete.
    expect(unmapped, `card(s) calling attachExternalSource resolve to no module def: ${unmapped.join(', ')}`)
      .toEqual([]);

    // Sanity: the grep found SOMETHING (a refactor that renames the engine hook
    // must fail loudly here rather than silently emptying the set).
    expect(found.size).toBeGreaterThan(0);

    expect([...found].sort()).toEqual([...DOM_SOURCE_LANE_TYPES].sort());
  });

  it('lists the known capture/media-source modules (readable failure if one is dropped)', () => {
    for (const t of ['cameraInput', 'videobox', 'videovarispeed', 'archivist', 'peertube', 'tvLibrarian', 'loopback', 'frametable', 'videocube']) {
      expect(DOM_SOURCE_LANE_TYPES.has(t), `${t} is a DOM-source module`).toBe(true);
    }
    // Boundary: a pure-GPU generator is NOT one (acidwarp renders from a shader
    // only — it needs no card, which is why acidwarp → OUTPUT survived the bug).
    for (const t of ['acidwarp', 'lines', 'backdraft', 'ruttetra', 'videoOut']) {
      expect(DOM_SOURCE_LANE_TYPES.has(t), `${t} is NOT a DOM-source module`).toBe(false);
    }
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
    const dead = PRODUCER_SEAMS.filter((s) => !sources.some((c) => s.re.test(c.src))).map((s) => s.id);
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
    for (const kind of KINDS) {
      const want = kind === 'shell' || kind === 'placeholder';
      expect(needsHeadlessSourceMount({ kind, type: 'videobox' }), `videobox @ ${kind}`).toBe(want);
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
      expect(needsHeadlessSourceMount({ kind, type })).toBe(false);
    }
  });
});

describe('cameraInput — the CAPTURE-SOURCE carve-out (source + device picker live on the card)', () => {
  it('keeps its REAL card in the lane under the faceplate default', () => {
    expect(NON_SHELL_LANE_TYPES.has('cameraInput')).toBe(true);
    expect(
      laneRenderKind({
        shellFaces: true,
        userDocked: false,
        type: 'cameraInput',
        // isShellSwappable() returns false for a NON_SHELL type — Canvas passes
        // that through as hasCard.
        hasCard: false,
        migrated: false,
      }),
    ).toBe('legacy');
  });

  it('is therefore never headless-hosted (no double getUserMedia)', () => {
    expect(needsHeadlessSourceMount({ kind: 'legacy', type: 'cameraInput' })).toBe(false);
  });

  it('leaves every OTHER headless-hosted module on the uniform tile (the shell look is preserved)', () => {
    for (const t of HEADLESS_MOUNT_LANE_TYPES) {
      if (t === 'cameraInput') continue;
      expect(NON_SHELL_LANE_TYPES.has(t), `${t} still swaps to a tile`).toBe(false);
      expect(needsHeadlessSourceMount({ kind: 'placeholder', type: t })).toBe(true);
    }
  });
});
