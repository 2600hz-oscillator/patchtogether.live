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
    id: 'engine.write(node, …)',
    re: /\bwrite\s*\(\s*node\s*,/,
    why:
      'the card pushes state INTO the module handle every rAF — TIMELORDE its composited ' +
      "display (`write(node,'displayFrame')`, the only writer of what video_out passes on) " +
      "and SYNESTHESIA its per-band video levels (`write(node,'video_levels_a'/'_b')`, the " +
      'only writer of what its AUDIO outputs carry). Unmount the card and the module keeps ' +
      'drawing/emitting its idle value forever.',
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
    const write = PRODUCER_SEAMS.find((s) => s.id === 'engine.write(node, …)')!.re;
    const drawer = PRODUCER_SEAMS.find((s) => s.id === 'install*FrameDrawer(…)')!.re;

    // Fires on the real call shapes these cards use…
    expect(write.test("if (eng && node) eng.write(node, 'displayFrame', bmp);")).toBe(true);
    expect(write.test("if (lv) eng.write(node, 'video_levels_a', lv);")).toBe(true);
    expect(drawer.test('installWavesculptFrameDrawer(id, myFrameDrawer);')).toBe(true);
    expect(drawer.test('function installBridgeFrameDrawer(): void {')).toBe(true);

    // …and NOT on the prose/adjacent-API forms that really occur in these cards.
    // `writable.write(blob)` is FrametableCard's File System Access save path —
    // it writes a FILE, not engine state, and pulling it in would give
    // frametable a second, wrong reason to be headless-mounted.
    expect(write.test('await writable.write(blob);')).toBe(false);
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
    // (pinned singletons / hiddenCard cameras — #1754) is a different exclusion
    // that this decision never sees at all.
    expect(typeof needsHeadlessSourceMount).toBe('function');
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
