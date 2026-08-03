// scripts/vrt-gallery.test.ts
//
// The gate for `e2e/vrt/build_gallery.py` — the docs/vrt baseline catalog.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// The gallery keyed every entry by the PNG's BARE STEM, so
// `<spec>/darwin/adsr.png` and `<spec>/linux/adsr.png` collided and the second
// one walked silently overwrote the first. 416 committed PNGs rendered as 282
// cards, each showing ONE arbitrary platform, and the page printed "282
// baselines" — a count of SCENES presented as a count of BASELINES.
//
// Nothing could have caught that, because nothing checked the gallery against
// the tree it claims to render. This does, from an INDEPENDENT instrument: the
// assertions below walk `__screenshots__` in TypeScript and compare against the
// Python script's own `coverage.json`. Two walkers, one answer, or red.
//
// ---------------------------------------------------------------------------
// WHAT EACH TEST IS FOR — and what it is structurally unable to see
// ---------------------------------------------------------------------------
//  1. TOTALITY      every committed baseline appears; nothing rendered lacks a
//                   file on disk. Both directions, because a renderer that
//                   drops entries and one that invents them look identical from
//                   a single count.
//  2. PARITY        the gaps the gallery reports equal the gaps on disk.
//  3. CROSS-LANGUAGE the UI v2 tab is driven from `strict-faces.ts`, parsed by
//                   a Python REGEX. A regex that drifts returns [] and renders
//                   an empty tab that reads exactly like "no faces promoted
//                   yet". So the real TypeScript module is IMPORTED here and
//                   compared against what the parser produced.
//  4. NEGATIVE CONTROL on the INSTRUMENT, not the data. Every assertion above
//     is derived from the same walk; if the walk under-reports, they all agree
//     with each other and stay green. So a synthetic tree is built where the
//     answer is known: a darwin-only scene MUST report as a gap and MUST render
//     a MISSING tile, and adding the linux sibling MUST make the gap
//     disappear. Perturb the thing the metric claims to measure and confirm the
//     number moves — in BOTH directions.
//  5. FAIL-LOUD     the parser hard-fails rather than rendering an empty tab.
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
// The VACUITY TRIPWIRE, reused rather than re-invented. Every assertion in the
// "real tree" blocks below compares two walks of `__screenshots__` — so with
// that tree ABSENT or a partial checkout, both walks return empty, they agree
// perfectly, and the whole file goes green while measuring nothing. That is the
// same hole `vrt-platform-gaps.ts` documents for the vrt-meta ratchets, and it
// already owns the floors; a second set of numbers here would only drift from
// them.
import { assertBaselineTreeIsReadable } from '../e2e/vrt/vrt-platform-gaps';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'e2e', 'vrt', 'build_gallery.py');
const BASELINES = join(ROOT, 'e2e', 'vrt', '__screenshots__');
const STRICT_FACES_TS = join(
  ROOT,
  'packages/web/src/lib/ui/workflow/strict-faces.ts',
);
const PLATFORMS = ['darwin', 'linux'] as const;

/** The smallest legal PNG — a 1×1 transparent pixel. The gallery COPIES image
 *  bytes and never decodes them, so a fixture needs no encoder. */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

interface Coverage {
  scenes: number;
  images: number;
  specDirs: string[];
  rendered: string[];
  gaps: string[];
  byPlatform: Record<string, number>;
  byCategory: Record<string, string[]>;
  orphanFaceScenes: string[];
  unexpectedPlatformDirs: string[];
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
 *  the Python side. `<spec>/<platform>/<stem>.png` → `<spec>/<stem>`. */
function walkBaselines(root: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const spec of readdirSync(root, { withFileTypes: true })) {
    if (!spec.isDirectory()) continue;
    for (const platform of PLATFORMS) {
      const dir = join(root, spec.name, platform);
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.png')) continue;
        const key = `${spec.name}/${f.slice(0, -'.png'.length)}`;
        if (!out.has(key)) out.set(key, new Set());
        out.get(key)!.add(platform);
      }
    }
  }
  return out;
}

function fixtureTree(scenes: Array<[string, string, string[]]>): string {
  const root = mkdtempSync(join(tmpdir(), 'vrt-fixture-'));
  for (const [spec, stem, platforms] of scenes) {
    for (const p of platforms) {
      const dir = join(root, spec, p);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${stem}.png`), PNG_1PX);
    }
  }
  return root;
}

/** A one-module STRICT_FACES source, so a fixture's UI v2 tab is FULLY covered
 *  and every MISSING tile in the page is attributable to the scene under test.
 *  Using the REAL 18-module set against a fixture tree would paint 36 unrelated
 *  MISSING tiles and make the tile count meaningless as an instrument. */
function tinyFacesSource(module = 'adsr'): string {
  const p = join(tmpdir(), `strict-faces-${module}-${Math.random().toString(36).slice(2)}.ts`);
  writeFileSync(
    p,
    `export const STRICT_FACES: ReadonlySet<string> = new Set<string>(['${module}']);\n`,
  );
  return p;
}

/** The `face-<m>-{compact,dock}` scenes on both platforms — the covered baseline
 *  every fixture starts from. */
function coveredFaceScenes(module = 'adsr'): Array<[string, string, string[]]> {
  return [
    ['workflow-shell-faces.spec.ts', `face-${module}-compact`, ['darwin', 'linux']],
    ['workflow-shell-faces.spec.ts', `face-${module}-dock`, ['darwin', 'linux']],
  ];
}

/** Count rendered MISSING TILES — matched on the tile's full class attribute,
 *  NOT on the bare token `thumb-missing`, which also appears once in the inlined
 *  `<style>` block. A bare-token count is off by exactly one on every page and
 *  reads as a real result; caught by asserting an exact 0 on the all-covered
 *  control, which is what that control is for. */
const countMissingTiles = (html: string): number =>
  (html.match(/class="thumb thumb-missing"/g) ?? []).length;

// The real tree is walked once — it is ~416 files and the script is ~1 s.
const real = build(BASELINES);
const onDisk = walkBaselines(BASELINES);

// The real build COPIES all 416 baseline PNGs (~14 MB) into a temp dir. Every
// fixture build below cleans up after itself; this one has no owning `it`, so
// without this it leaks a full copy of the tree per invocation — on every unit
// lane, and on every local `task test` while iterating.
afterAll(() => rmSync(real.outDir, { recursive: true, force: true }));

describe('vrt gallery — TOTALITY (every committed baseline appears, nothing invented)', () => {
  it('the baseline tree is READABLE — refusing to pass vacuously', () => {
    // MUST come first. Two walks of an empty tree agree on `[]`, and every
    // other assertion in this file is an agreement between those two walks — so
    // a deleted or partially-checked-out `__screenshots__` turns the entire
    // suite green with zero coverage. Measured floors live in
    // vrt-platform-gaps.ts (30 dirs / 282 darwin / 134 linux today).
    const totals = assertBaselineTreeIsReadable();
    expect(totals.darwin + totals.linux).toBe(real.coverage.images);
    expect(totals.specs).toBeGreaterThanOrEqual(real.coverage.specDirs.length);
  });

  it('renders exactly the scenes on disk, across EVERY spec directory', () => {
    // Both directions in one assertion. A gallery that DROPS entries and one
    // that INVENTS them are indistinguishable from a bare count, and the bug
    // this replaces dropped 134 of them while the count looked fine.
    expect(real.coverage.rendered.slice().sort()).toEqual(
      [...onDisk.keys()].sort(),
    );
    expect(real.coverage.scenes).toBe(onDisk.size);
  });

  it('counts every PNG, not one per stem (the platform-collapse regression)', () => {
    // THE regression under test. Pre-fix this read 282 for a 416-file tree,
    // because darwin and linux shared a dict key.
    const pngs = [...onDisk.values()].reduce((n, s) => n + s.size, 0);
    expect(real.coverage.images).toBe(pngs);
    expect(real.coverage.images).toBeGreaterThan(real.coverage.scenes);
    for (const p of PLATFORMS) {
      expect(real.coverage.byPlatform[p]).toBe(
        [...onDisk.values()].filter((s) => s.has(p)).length,
      );
    }
  });

  it('every rendered image resolves to a real file in the output tree', () => {
    // The other direction: a card whose <img> 404s looks like a broken render,
    // not like a missing baseline, so it would be read as a display glitch.
    for (const key of real.coverage.rendered) {
      const [spec, stem] = [
        key.slice(0, key.lastIndexOf('/')),
        key.slice(key.lastIndexOf('/') + 1),
      ];
      for (const p of onDisk.get(key)!) {
        expect(
          existsSync(join(real.outDir, 'baselines', p, spec, `${stem}.png`)),
          `${key} on ${p} is listed but no file was copied`,
        ).toBe(true);
      }
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

  it('reports no unexpected platform directory and no orphan face scene', () => {
    // A third platform dir would be dropped by every loop with the counts still
    // internally consistent; an orphan `face-<x>-dock` is a baseline for a
    // module that left the ratchet.
    expect(real.coverage.unexpectedPlatformDirs).toEqual([]);
    expect(real.coverage.orphanFaceScenes).toEqual([]);
  });
});

describe('vrt gallery — PARITY (a darwin/linux gap is VISIBLE, not silent)', () => {
  it('reports exactly the scenes that lack a linux sibling', () => {
    const expected = [...onDisk.entries()]
      .filter(([, p]) => p.size !== PLATFORMS.length)
      .map(([k]) => k)
      .sort();
    expect(real.coverage.gaps.slice().sort()).toEqual(expected);
  });

  it('renders a MISSING tile for every absent platform', () => {
    // One tile per missing platform. Without this the gallery could report the
    // gap in coverage.json and still render a card that LOOKS complete — which
    // is exactly the failure mode being fixed.
    const absent = [...onDisk.values()].reduce(
      (n, p) => n + (PLATFORMS.length - p.size),
      0,
    );
    // ≥ rather than ==: a module promoted into STRICT_FACES before its
    // baselines land has NO file on disk to be counted by `absent`, yet the UI
    // v2 tab still owes it a MISSING row. Both are real gaps; only the first is
    // visible from the tree.
    expect(countMissingTiles(real.html)).toBeGreaterThanOrEqual(absent);
    // ⚠ DELIBERATELY NOT `toBeGreaterThan(0)`. Asserting the real tree HAS a
    // gap would make this gate go RED on the day parity is finally reached —
    // a test that fails when the work succeeds, which is worse than no test.
    // That the MISSING tile renders at all is proven by the fixture negative
    // controls below, at exact counts, on trees whose answer is known.
  });
});

describe('vrt gallery — the UI v2 tab is driven from the LIVE STRICT_FACES', () => {
  it("the Python parse equals the TypeScript module, entry for entry", () => {
    // THE cross-language gate. `strict-faces.ts` is the single source; the
    // gallery reads it with a regex and this test reads it with a real import.
    // A drifted regex is red here instead of a quietly empty tab.
    expect(real.coverage.uiV2.strictFaces).toEqual([...STRICT_FACES].sort());
    expect(real.coverage.uiV2.strictFaces.length).toBeGreaterThan(0);
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
      ['workflow-shell-faces.spec.ts', 'face-adsr-compact', ['darwin', 'linux']],
      ['workflow-shell-faces.spec.ts', 'face-adsr-dock', ['darwin', 'linux']],
      ['workflow-shell-faces.spec.ts', 'face-notaface-dock', ['darwin', 'linux']],
    ]);
    try {
      const faces = join(tmpdir(), `strict-faces-${Date.now()}.ts`);
      writeFileSync(
        faces,
        "export const STRICT_FACES: ReadonlySet<string> = new Set<string>(['adsr']);\n",
      );
      const built = build(tree, { strictFaces: faces });
      expect(built.coverage.uiV2.strictFaces).toEqual(['adsr']);
      expect(built.coverage.orphanFaceScenes).toEqual([
        'workflow-shell-faces.spec.ts/face-notaface-dock',
      ]);
      expect(built.coverage.byCategory['ui-v2'].sort()).toEqual([
        'workflow-shell-faces.spec.ts/face-adsr-compact',
        'workflow-shell-faces.spec.ts/face-adsr-dock',
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
  // green while measuring nothing. These two tests build a tree whose answer is
  // known independently and check the number MOVES in both directions.
  // Each fixture is IDENTICAL except for the one scene under test, and the
  // MISSING-tile count is asserted EXACTLY — not `toContain`. An exact count is
  // what makes "the number moved" mean something; a substring check passes just
  // as happily on a page painting tiles for unrelated reasons.
  const faces = tinyFacesSource();

  it('all-covered is the CONTROL: zero gaps, zero MISSING tiles', () => {
    const tree = fixtureTree([
      ...coveredFaceScenes(),
      ['vrt.spec.ts', 'covered', ['darwin', 'linux']],
      ['vrt.spec.ts', 'alsocovered', ['darwin', 'linux']],
    ]);
    try {
      const built = build(tree, { strictFaces: faces });
      expect(built.coverage.scenes).toBe(4);
      expect(built.coverage.images).toBe(8);
      expect(built.coverage.gaps).toEqual([]);
      expect(countMissingTiles(built.html)).toBe(0);
      expect(built.coverage.uiV2.fullParity).toEqual(['adsr']);
      rmSync(built.outDir, { recursive: true, force: true });
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });

  it('DROPPING one linux PNG makes exactly one gap and one MISSING tile appear', () => {
    // The perturbation: the control tree with `alsocovered`'s linux sibling
    // removed. Nothing else changes, so any movement is attributable.
    const tree = fixtureTree([
      ...coveredFaceScenes(),
      ['vrt.spec.ts', 'covered', ['darwin', 'linux']],
      ['vrt.spec.ts', 'alsocovered', ['darwin']],
    ]);
    try {
      const built = build(tree, { strictFaces: faces });
      expect(built.coverage.scenes).toBe(4);
      expect(built.coverage.images).toBe(7);
      expect(built.coverage.gaps).toEqual(['vrt.spec.ts/alsocovered']);
      expect(countMissingTiles(built.html)).toBe(1);
      expect(built.html).toContain('darwin-only');
      rmSync(built.outDir, { recursive: true, force: true });
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });

  it('a linux-only scene is a gap too — parity is SYMMETRIC, not linux-blind', () => {
    // A detector wired to "does a linux file exist" would also report this, but
    // one wired to "is darwin present and linux absent" would call it covered.
    const tree = fixtureTree([
      ...coveredFaceScenes(),
      ['vrt.spec.ts', 'linuxonly', ['linux']],
    ]);
    try {
      const built = build(tree, { strictFaces: faces });
      expect(built.coverage.gaps).toEqual(['vrt.spec.ts/linuxonly']);
      expect(countMissingTiles(built.html)).toBe(1);
      expect(built.html).toContain('linux-only');
      rmSync(built.outDir, { recursive: true, force: true });
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });

  it('a promoted face with NO baseline at all is a UI v2 gap, not an absence', () => {
    // The face tab is driven from the ratchet, so a module can be promoted
    // before its baselines land. That must read as a GAP — the tab enumerating
    // only what happens to be on disk is how a missing face goes unnoticed.
    const tree = fixtureTree([['vrt.spec.ts', 'covered', ['darwin', 'linux']]]);
    try {
      const built = build(tree, { strictFaces: faces });
      expect(built.coverage.uiV2.fullParity).toEqual([]);
      expect(Object.keys(built.coverage.uiV2.gapped)).toEqual(['adsr']);
      // compact + dock, each absent on both platforms.
      expect(countMissingTiles(built.html)).toBe(4);
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
    const tree = fixtureTree([['vrt.spec.ts', 'x', ['darwin', 'linux']]]);
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
    const tree = fixtureTree([['vrt.spec.ts', 'x', ['darwin', 'linux']]]);
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
    // `__screenshots__/vrt.spec.ts/`.
    expect(real.html).toContain('Directory scope');
    expect(real.html).toContain('spec directories below, not just');
    expect(real.coverage.specDirs.length).toBeGreaterThan(1);
    for (const spec of real.coverage.specDirs) {
      expect(real.html, `coverage table omits ${spec}`).toContain(spec);
    }
  });
});
