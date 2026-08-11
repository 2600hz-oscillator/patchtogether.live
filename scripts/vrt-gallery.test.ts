// scripts/vrt-gallery.test.ts
//
// The gate for `e2e/vrt/build_gallery.py` — the docs/vrt baseline catalog.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// Nothing checked the gallery against the tree it claims to render, and the
// first thing that went wrong was invisible for exactly that reason: the
// inventory was keyed by the PNG's bare stem, so two baselines with the same
// stem collided, 416 files rendered as 282 cards, and the page reported a
// count of SCENES as a count of BASELINES.
//
// This checks it, from an INDEPENDENT instrument: the assertions below walk
// `__screenshots__` in TypeScript and compare against the Python script's own
// `coverage.json`. Two walkers, one answer, or red.
//
// ---------------------------------------------------------------------------
// THERE IS ONE BASELINE SET (2026-08-10)
// ---------------------------------------------------------------------------
// `snapshotPathTemplate` dropped its `{platform}` segment, so a scene is one
// PNG at `<spec>/<stem>.png` rather than a darwin/linux pair. Everything this
// file used to carry about PARITY went with it — the two-platform walk, the
// gap set, the darwin-only/linux-only assertions, and the stem-collision
// regression test, whose bug is now structurally impossible (see the comment
// where that test used to be).
//
// ---------------------------------------------------------------------------
// WHAT EACH TEST IS FOR — and what it is structurally unable to see
// ---------------------------------------------------------------------------
//  1. VACUITY      the tree is actually readable. See the long note on the
//                  first test: every other assertion here is an agreement
//                  between two walks, and two walks of an absent tree agree.
//  2. TOTALITY     every committed baseline appears; nothing rendered lacks a
//                  file on disk. Both directions, because a renderer that
//                  drops entries and one that invents them look identical from
//                  a single count.
//  3. MISSING      the one coverage verdict left: a module on the STRICT_FACES
//                  ratchet whose required tiers are not all pinned must render
//                  a loud MISSING tile, not simply be short a row.
//  4. CROSS-LANGUAGE the UI v2 tab is driven from `strict-faces.ts`, parsed by
//                  a Python REGEX. A regex that drifts returns [] and renders
//                  an empty tab that reads exactly like "no faces promoted
//                  yet". So the real TypeScript module is IMPORTED here and
//                  compared against what the parser produced.
//  5. NEGATIVE CONTROL on the INSTRUMENT, not the data. Every assertion above
//     is derived from the same walk; if the walk under-reports, they all agree
//     with each other and stay green. So synthetic trees are built where the
//     answer is known, and the number is checked to MOVE in both directions —
//     add a scene / drop a scene, pin a face tier / unpin it, plant a leftover
//     `linux/` subdirectory / don't.
//  6. FAIL-LOUD    the parser hard-fails rather than rendering an empty tab.
//
// ⚠ What NONE of this can see: whether a committed PNG still MATCHES today's
// render. The gallery reads the baseline TREE. Only a VRT run answers that, and
// a sub-tolerance drift is invisible to that run too.
//
// Drives the real .py via child_process against BOTH the real repo tree and
// synthetic fixtures in an OS temp dir. Pure stdlib on the Python side (no
// Pillow), so this runs in the ordinary `unit` lane.

import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { STRICT_FACES } from '../packages/web/src/lib/ui/workflow/strict-faces';
// The anchor for the VACUITY TRIPWIRE — see the first test for why this is a
// list of NAMES and not a floor. `vrt-exemptions.ts` is a dependency-free data
// module, so importing it here costs nothing and drags in no registry.
import { STRICT_VRT_MODULES } from '../e2e/vrt/vrt-exemptions';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'e2e', 'vrt', 'build_gallery.py');
const BASELINES = join(ROOT, 'e2e', 'vrt', '__screenshots__');
const STRICT_FACES_TS = join(
  ROOT,
  'packages/web/src/lib/ui/workflow/strict-faces.ts',
);

/** The spec dir + tiers the UI v2 tab is built from. Names, mirrored from
 *  `build_gallery.py`'s `REQUIRED_FACE_TIERS` — the OPTIONAL `rear` tier is
 *  deliberately absent: it renders only when a baseline exists, so it can never
 *  contribute a MISSING tile. */
const FACES_SPEC = 'workflow-shell-faces.spec.ts';
const REQUIRED_FACE_TIERS = ['compact', 'dock'] as const;

/** The smallest legal PNG — a 1×1 transparent pixel. The gallery COPIES image
 *  bytes and never decodes them, so a fixture needs no encoder. */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

interface Coverage {
  scenes: number;
  specDirs: string[];
  rendered: string[];
  byCategory: Record<string, string[]>;
  orphanFaceScenes: string[];
  unexpectedSubdirs: string[];
  uiV2: {
    strictFaces: string[];
    fullParity: string[];
    gapped: Record<string, string[]>;
  };
}

interface Built {
  coverage: Coverage;
  html: string;
  outDir: string;
}

function build(baselineDir: string, opts: { strictFaces?: string } = {}): Built {
  const outDir = mkdtempSync(join(tmpdir(), 'vrt-gallery-'));
  const args = [
    SCRIPT,
    '--baseline-dir',
    baselineDir,
    '--output-dir',
    outDir,
    '--strict-faces',
    opts.strictFaces ?? STRICT_FACES_TS,
  ];
  try {
    execFileSync('python3', args, { cwd: ROOT, encoding: 'utf8' });
  } catch (e) {
    const err = e as { status?: number; stderr?: string; message: string };
    throw new Error(
      `build_gallery.py failed (exit ${err.status}). If python3 is missing this ` +
        'test FAILS rather than skipping on purpose — a gate that cannot run is ' +
        `decoration.\n${err.stderr ?? err.message}`,
    );
  }
  return {
    coverage: JSON.parse(readFileSync(join(outDir, 'coverage.json'), 'utf8')),
    html: readFileSync(join(outDir, 'index.html'), 'utf8'),
    outDir,
  };
}

/** INDEPENDENT walk of the baseline tree — deliberately NOT sharing code with
 *  the Python side. `<spec>/<stem>.png` → the scene key `<spec>/<stem>`.
 *  Non-recursive on purpose: a spec dir holds PNGs and nothing else, and a
 *  directory found inside one is the gallery's `unexpectedSubdirs` finding
 *  rather than more baselines (asserted below, in both directions). */
function walkBaselines(root: string): Set<string> {
  const out = new Set<string>();
  for (const spec of readdirSync(root, { withFileTypes: true })) {
    if (!spec.isDirectory()) continue;
    for (const f of readdirSync(join(root, spec.name))) {
      if (!f.endsWith('.png')) continue;
      out.add(`${spec.name}/${f.slice(0, -'.png'.length)}`);
    }
  }
  return out;
}

/** A fixture tree in the CURRENT flat layout: `<spec>/<stem>.png`.
 *  `legacy` plants `<spec>/<subdir>/<stem>.png` — the pre-collapse shape, used
 *  only to prove the leftover-subdirectory tripwire fires. */
function fixtureTree(
  scenes: Array<[string, string]>,
  legacy: Array<[string, string, string]> = [],
): string {
  const root = mkdtempSync(join(tmpdir(), 'vrt-fixture-'));
  for (const [spec, stem] of scenes) {
    mkdirSync(join(root, spec), { recursive: true });
    writeFileSync(join(root, spec, `${stem}.png`), PNG_1PX);
  }
  for (const [spec, subdir, stem] of legacy) {
    mkdirSync(join(root, spec, subdir), { recursive: true });
    writeFileSync(join(root, spec, subdir, `${stem}.png`), PNG_1PX);
  }
  return root;
}

/** A one-module STRICT_FACES source, so a fixture's UI v2 tab is FULLY covered
 *  and every MISSING tile in the page is attributable to the scene under test.
 *  Using the REAL 28-module set against a fixture tree would paint dozens of
 *  unrelated MISSING tiles and make the tile count meaningless as an
 *  instrument. */
function tinyFacesSource(module = 'adsr'): string {
  const p = join(tmpdir(), `strict-faces-${module}-${Math.random().toString(36).slice(2)}.ts`);
  writeFileSync(
    p,
    `export const STRICT_FACES: ReadonlySet<string> = new Set<string>(['${module}']);\n`,
  );
  return p;
}

/** The `face-<m>-{compact,dock}` scenes — the fully-pinned face every fixture
 *  starts from. */
function coveredFaceScenes(module = 'adsr'): Array<[string, string]> {
  return REQUIRED_FACE_TIERS.map(
    (tier) => [FACES_SPEC, `face-${module}-${tier}`] as [string, string],
  );
}

/** Count rendered MISSING TILES — matched on the tile's full class attribute,
 *  NOT on the bare token `thumb-missing`, which also appears once in the inlined
 *  `<style>` block. A bare-token count is off by exactly one on every page and
 *  reads as a real result; caught by asserting an exact 0 on the all-covered
 *  control, which is what that control is for. */
const countMissingTiles = (html: string): number =>
  (html.match(/class="thumb thumb-missing"/g) ?? []).length;

// The real tree is walked once — the script is ~1 s over it.
const real = build(BASELINES);
const onDisk = walkBaselines(BASELINES);

// The real build COPIES every baseline PNG into a temp dir. Every fixture build
// below cleans up after itself; this one has no owning `it`, so without this it
// leaks a full copy of the tree per invocation — on every unit lane, and on
// every local `task test` while iterating.
afterAll(() => rmSync(real.outDir, { recursive: true, force: true }));

describe('vrt gallery — TOTALITY (every committed baseline appears, nothing invented)', () => {
  it('the baseline tree is READABLE — refusing to pass vacuously', () => {
    // MUST come first, and it is deliberately NOT A COUNT.
    //
    // Every other assertion in this file is an AGREEMENT between two walks of
    // `__screenshots__` — the TypeScript one above and the Python one inside
    // build_gallery.py. On an absent, empty or partially-checked-out tree both
    // return nothing, they agree perfectly, and the whole suite goes green
    // having measured nothing at all.
    //
    // The tripwire this replaces lived in `e2e/vrt/vrt-platform-gaps.ts`
    // (deleted with the platform dimension) and was three hand-typed FLOORS:
    // "≥25 spec dirs / ≥240 darwin / ≥100 linux". CLAUDE.md now forbids that
    // shape outright — "NEVER hand-type a population count" — and it was the
    // wrong instrument besides: it went stale on every capture, and it could
    // not have survived this PR, which deliberately drops 146 scenes' worth of
    // darwin-only baselines pending a linux recapture.
    //
    // So the anchor is NAMES. `STRICT_VRT_MODULES` is the deterministic subset
    // that gates the REQUIRED `vrt-strict` lane, and `vrt-meta.test.ts`
    // separately asserts each one has a committed `vrt.spec.ts/<type>.png` —
    // so "a strict module's baseline is readable" is a property the repo
    // already guarantees, stated here as a tripwire. A name is checkable
    // against the tree where a number is not: this cannot pass on an empty
    // tree, it needs no maintenance as baselines are added or removed, and a
    // rename or demotion fails with the name in the message rather than with
    // an arithmetic complaint.
    expect(
      [...STRICT_VRT_MODULES],
      'STRICT_VRT_MODULES is empty, so the filter below is vacuous and this ' +
        'tripwire measures nothing — the anchor itself must be non-empty',
    ).not.toEqual([]);

    const unreadable = [...STRICT_VRT_MODULES]
      .map((type) => `vrt.spec.ts/${type}`)
      .filter((key) => !onDisk.has(key));
    expect(
      unreadable,
      'these STRICT_VRT_MODULES baselines are NOT readable under ' +
        `${BASELINES}. Every assertion in this file compares two walks of that ` +
        'tree, so an unreadable tree makes them agree on nothing and pass. If ' +
        'this is a partial/lfs:false checkout, this lane cannot run the gate ' +
        'and must not pretend otherwise; if the baselines were deliberately ' +
        'removed, vrt-meta.test.ts is red for the same reason and is the place ' +
        `to start: ${unreadable.join(', ')}`,
    ).toEqual([]);

    // …and the PYTHON walk found the same names. The tripwire above proves the
    // tree is there; this proves the script SAW it, which is the half that
    // would otherwise still be an agreement about nothing.
    const notRendered = [...STRICT_VRT_MODULES]
      .map((type) => `vrt.spec.ts/${type}`)
      .filter((key) => !real.coverage.rendered.includes(key));
    expect(
      notRendered,
      `build_gallery.py rendered no card for: ${notRendered.join(', ')}`,
    ).toEqual([]);
  });

  it('renders exactly the scenes on disk, across EVERY spec directory', () => {
    // Both directions in one assertion. A gallery that DROPS entries and one
    // that INVENTS them are indistinguishable from a bare count.
    expect(real.coverage.rendered.slice().sort()).toEqual([...onDisk].sort());
    expect(real.coverage.scenes).toBe(onDisk.size);
  });

  // ⚠ THE "counts every PNG, not one per stem" TEST LIVED HERE and is gone
  // (2026-08-10). It pinned the platform-collapse regression: darwin and linux
  // shared a dict key, so 416 PNGs reported as 282 scenes. With one baseline
  // per scene the two numbers are the same number — `images` is no longer even
  // emitted in coverage.json — so there is nothing left to disagree. The
  // surviving half of that bug is the `(spec, stem)` key, which still stops two
  // spec dirs sharing a stem from overwriting each other, and it is covered by
  // the exact-set assertion above rather than by a count.

  it('every rendered image resolves to a real file in the output tree', () => {
    // The other direction: a card whose <img> 404s looks like a broken render,
    // not like a missing baseline, so it would be read as a display glitch.
    for (const key of real.coverage.rendered) {
      const cut = key.lastIndexOf('/');
      const [spec, stem] = [key.slice(0, cut), key.slice(cut + 1)];
      expect(
        existsSync(join(real.outDir, 'baselines', spec, `${stem}.png`)),
        `${key} is listed but no file was copied`,
      ).toBe(true);
    }
  });

  it('assigns every scene to exactly one declared tab', () => {
    // `categorize()` is TOTAL by contract. A scene in no tab renders nowhere
    // and the page is simply short a few cards, with no error anywhere.
    const buckets = Object.values(real.coverage.byCategory);
    const flat = buckets.flat();
    expect(flat.slice().sort()).toEqual(real.coverage.rendered.slice().sort());
    expect(new Set(flat).size, 'a scene appears in two tabs').toBe(flat.length);
  });

  it('reports no unexpected SUBDIRECTORY and no orphan face scene', () => {
    // A directory inside a spec dir holds PNGs that every loop walks past with
    // the counts staying internally consistent — post-collapse that means a
    // leftover `darwin/` or `linux/`. An orphan `face-<x>-dock` is a baseline
    // for a module that left the ratchet.
    expect(real.coverage.unexpectedSubdirs).toEqual([]);
    expect(real.coverage.orphanFaceScenes).toEqual([]);
  });
});

describe('vrt gallery — an UNPINNED required face tier is VISIBLE, not silent', () => {
  it('renders exactly one MISSING tile per unpinned required tier', () => {
    // The UI v2 tab enumerates the STRICT_FACES RATCHET, not the disk, so a
    // face promoted before its baselines land owes a MISSING row. Every other
    // card on the page exists BECAUSE its PNG does and can never paint one —
    // which is what makes an EXACT count the right assertion here rather than
    // a floor: the expectation is derived from the same two names (the ratchet
    // and the tree) that the gallery derives it from, independently.
    const expected = [...STRICT_FACES].flatMap((module) =>
      REQUIRED_FACE_TIERS.filter(
        (tier) => !onDisk.has(`${FACES_SPEC}/face-${module}-${tier}`),
      ),
    );
    expect(
      countMissingTiles(real.html),
      `expected one MISSING tile per unpinned required tier (${expected.length} of ` +
        'them on this tree). A mismatch means either a scene card is painting a ' +
        'MISSING tile — it cannot, by construction — or the UI v2 tab dropped a row.',
    ).toBe(expected.length);
    // ⚠ NOT `toBeGreaterThan(0)`. Asserting the tree HAS a gap would make this
    // go RED on the day every promoted face is pinned — a test that fails when
    // the work succeeds. That the tile renders at all is proven by the fixture
    // negative controls below, at exact counts, on trees whose answer is known.
  });

  it('names the unpinned tiers in coverage.json, module by module', () => {
    // The page and the machine summary must agree about WHICH faces are short,
    // not just how many tiles were painted.
    for (const module of STRICT_FACES) {
      const unpinned = REQUIRED_FACE_TIERS.filter(
        (tier) => !onDisk.has(`${FACES_SPEC}/face-${module}-${tier}`),
      );
      if (unpinned.length === 0) {
        expect(real.coverage.uiV2.fullParity, `${module} is fully pinned`).toContain(
          module,
        );
        continue;
      }
      const reasons = real.coverage.uiV2.gapped[module] ?? [];
      for (const tier of unpinned) {
        expect(
          reasons.some((r) => r.startsWith(`${tier}:`)),
          `${module} has no ${tier} baseline but coverage.json does not say so ` +
            `(reasons: ${JSON.stringify(reasons)})`,
        ).toBe(true);
      }
    }
  });
});

describe('vrt gallery — the UI v2 tab is driven from the LIVE STRICT_FACES', () => {
  it('the Python parse equals the TypeScript module, entry for entry', () => {
    // THE cross-language gate. `strict-faces.ts` is the single source; the
    // gallery reads it with a regex and this test reads it with a real import.
    // A drifted regex is red here instead of a quietly empty tab.
    expect(real.coverage.uiV2.strictFaces).toEqual([...STRICT_FACES].sort());
    expect(real.coverage.uiV2.strictFaces).not.toEqual([]);
  });

  it('classifies every promoted face as 1:1 or names what it is missing', () => {
    const { fullParity, gapped, strictFaces } = real.coverage.uiV2;
    expect([...fullParity, ...Object.keys(gapped)].sort()).toEqual(strictFaces);
    for (const [module, reasons] of Object.entries(gapped)) {
      expect(reasons.length, `${module} is gapped but says why`).toBeGreaterThan(0);
    }
  });

  it('gives every promoted face a section anchor in the page', () => {
    // A face that is in the set but renders no section would be invisible in
    // exactly the way a hand-copied list is.
    for (const type of STRICT_FACES) {
      expect(real.html, `no UI v2 section for ${type}`).toContain(
        `id="face-${type}"`,
      );
    }
  });

  it('a face NOT on the ratchet claims no UI v2 slot — it is an ORPHAN', () => {
    // The direction a hand-copied list can never fail in: a demoted module
    // leaves its baselines behind, and they must not keep rendering as curated.
    const tree = fixtureTree([
      ...coveredFaceScenes(),
      [FACES_SPEC, 'face-notaface-dock'],
    ]);
    try {
      const faces = tinyFacesSource();
      const built = build(tree, { strictFaces: faces });
      expect(built.coverage.uiV2.strictFaces).toEqual(['adsr']);
      expect(built.coverage.orphanFaceScenes).toEqual([
        `${FACES_SPEC}/face-notaface-dock`,
      ]);
      expect(built.coverage.byCategory['ui-v2'].sort()).toEqual([
        `${FACES_SPEC}/face-adsr-compact`,
        `${FACES_SPEC}/face-adsr-dock`,
      ]);
      rmSync(built.outDir, { recursive: true, force: true });
      rmSync(faces, { force: true });
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });
});

describe('vrt gallery — NEGATIVE CONTROL on the instrument', () => {
  // Everything above is derived from ONE walk of the tree. If that walk
  // under-reports, every assertion agrees with every other and the suite is
  // green while measuring nothing. These tests build trees whose answer is
  // known independently and check the number MOVES in both directions.
  // Each fixture is IDENTICAL except for the one thing under test, and counts
  // are asserted EXACTLY — not `toContain`. An exact count is what makes "the
  // number moved" mean something; a substring check passes just as happily on a
  // page painting tiles for unrelated reasons.
  const faces = tinyFacesSource();

  it('all-covered is the CONTROL: every scene rendered, zero MISSING tiles', () => {
    const tree = fixtureTree([
      ...coveredFaceScenes(),
      ['vrt.spec.ts', 'covered'],
      ['vrt.spec.ts', 'alsocovered'],
    ]);
    try {
      const built = build(tree, { strictFaces: faces });
      // `rendered` is sorted by `(spec, stem)`, so vrt.spec.ts precedes
      // workflow-shell-faces.spec.ts — asserted as a LIST, not a set, because
      // the ordering is part of what a stable machine summary promises.
      expect(built.coverage.rendered).toEqual([
        'vrt.spec.ts/alsocovered',
        'vrt.spec.ts/covered',
        `${FACES_SPEC}/face-adsr-compact`,
        `${FACES_SPEC}/face-adsr-dock`,
      ]);
      expect(built.coverage.scenes).toBe(4);
      expect(countMissingTiles(built.html)).toBe(0);
      expect(built.coverage.uiV2.fullParity).toEqual(['adsr']);
      expect(built.coverage.uiV2.gapped).toEqual({});
      rmSync(built.outDir, { recursive: true, force: true });
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });

  it('DROPPING one scene PNG drops exactly that scene — nothing else moves', () => {
    // The perturbation on the WALK: the control tree with `alsocovered`
    // removed. Nothing else changes, so any movement is attributable. A walker
    // that under-reports would have failed the control above; one that
    // over-reports (a stale copy, an invented card) fails here.
    const tree = fixtureTree([...coveredFaceScenes(), ['vrt.spec.ts', 'covered']]);
    try {
      const built = build(tree, { strictFaces: faces });
      expect(built.coverage.rendered).toEqual([
        'vrt.spec.ts/covered',
        `${FACES_SPEC}/face-adsr-compact`,
        `${FACES_SPEC}/face-adsr-dock`,
      ]);
      expect(built.coverage.scenes).toBe(3);
      expect(countMissingTiles(built.html)).toBe(0);
      rmSync(built.outDir, { recursive: true, force: true });
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });

  it('UNPINNING one required face tier makes exactly one MISSING tile appear', () => {
    // The perturbation on the MISSING-tile instrument: the control tree with
    // adsr's DOCK baseline removed and nothing else touched.
    const tree = fixtureTree([
      [FACES_SPEC, 'face-adsr-compact'],
      ['vrt.spec.ts', 'covered'],
    ]);
    try {
      const built = build(tree, { strictFaces: faces });
      expect(countMissingTiles(built.html)).toBe(1);
      expect(built.coverage.uiV2.fullParity).toEqual([]);
      expect(built.coverage.uiV2.gapped).toEqual({
        adsr: ['dock: no baseline committed'],
      });
      rmSync(built.outDir, { recursive: true, force: true });
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });

  it('a promoted face with NO baseline at all is a UI v2 gap, not an absence', () => {
    // The face tab is driven from the ratchet, so a module can be promoted
    // before its baselines land. That must read as a GAP — the tab enumerating
    // only what happens to be on disk is how a missing face goes unnoticed.
    // This is the state 146 scenes are in as the single-baseline collapse
    // lands, so it is the case that matters most right now.
    const tree = fixtureTree([['vrt.spec.ts', 'covered']]);
    try {
      const built = build(tree, { strictFaces: faces });
      expect(built.coverage.uiV2.fullParity).toEqual([]);
      expect(Object.keys(built.coverage.uiV2.gapped)).toEqual(['adsr']);
      // compact + dock, one tile each.
      expect(countMissingTiles(built.html)).toBe(2);
      rmSync(built.outDir, { recursive: true, force: true });
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });

  it('a leftover platform SUBDIRECTORY is REPORTED, and its PNGs are not rendered', () => {
    // The repurposed tripwire, negative-controlled. `unexpectedSubdirs()` took
    // over from `unexpected_platform_dirs()`: pre-collapse a THIRD platform dir
    // would be silently dropped by every loop, post-collapse it is a leftover
    // `darwin/`/`linux/` doing the same thing. Both shapes are "baselines no
    // loop reads while every count stays internally consistent", which is why
    // the guard was repurposed rather than deleted.
    //
    // The control leg is the fixture above with no subdirectory at all
    // (`unexpectedSubdirs` is asserted `[]` on the real tree and implicitly on
    // every other fixture here), so this leg is the perturbation: plant one and
    // the report must move — AND the scene inside it must NOT appear as a card,
    // because "reported" and "quietly rendered anyway" are different bugs.
    const tree = fixtureTree(
      [...coveredFaceScenes(), ['vrt.spec.ts', 'covered']],
      [['vrt.spec.ts', 'linux', 'stranded']],
    );
    try {
      const built = build(tree, { strictFaces: faces });
      expect(built.coverage.unexpectedSubdirs).toEqual(['vrt.spec.ts/linux']);
      expect(built.coverage.rendered).not.toContain('vrt.spec.ts/stranded');
      expect(built.coverage.scenes).toBe(3);
      rmSync(built.outDir, { recursive: true, force: true });
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });
});

describe('vrt gallery — FAIL LOUD rather than render an empty UI v2 tab', () => {
  it('refuses to build when STRICT_FACES cannot be parsed', () => {
    // A silent [] here renders an empty tab that reads as "no promoted faces
    // yet" — indistinguishable from the truth, and wrong. It must be an error.
    const tree = fixtureTree([['vrt.spec.ts', 'x']]);
    const bogus = join(tmpdir(), `strict-faces-bogus-${Date.now()}.ts`);
    writeFileSync(bogus, 'export const SOMETHING_ELSE = 1;\n');
    try {
      expect(() => build(tree, { strictFaces: bogus })).toThrow(
        /STRICT_FACES|new Set<string>/,
      );
    } finally {
      rmSync(tree, { recursive: true, force: true });
      rmSync(bogus, { force: true });
    }
  });

  it('refuses to build when the STRICT_FACES source is absent', () => {
    const tree = fixtureTree([['vrt.spec.ts', 'x']]);
    try {
      expect(() =>
        build(tree, { strictFaces: join(tmpdir(), 'definitely-not-here.ts') }),
      ).toThrow(/not found/);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });
});

describe('vrt gallery — the page STATES its directory scope', () => {
  it('names the baseline root and every spec directory it walked', () => {
    // An unstated scope reads as full coverage — the exact omission that let
    // two narrow gates in this repo pass for months while resolving only
    // `__screenshots__/vrt.spec.ts/`. The table is built from the DISK, so a
    // spec dir whose baselines are all pending a recapture still gets a row
    // (reading 0) instead of vanishing off the page.
    expect(real.html).toContain('Directory scope');
    expect(real.html).toContain('spec directories below, not just');
    expect(real.coverage.specDirs.length).toBeGreaterThan(1);
    for (const spec of readdirSync(BASELINES, { withFileTypes: true })) {
      if (!spec.isDirectory()) continue;
      expect(real.html, `coverage table omits ${spec.name}`).toContain(spec.name);
    }
  });
});
