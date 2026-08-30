// packages/web/src/lib/ui/vrt-comparator-band.test.ts
//
// THE VRT TOLERANCE BAND, DRIVEN THROUGH THE REAL COMPARATOR — the permanent
// negative-control leg of the 2026-08-29 owner ruling (vrt.config.ts's
// tolerance block carries the full history and the bar math).
//
// ─────────────────────────────────────────────────────────────────────────
// WHAT THIS EXISTS FOR
//
// `vrt.config.ts` moved `threshold` 0 → 0.01 so the gate absorbs the ±2-LSB
// per-CPU-model AA raster band measured across the heterogeneous hosted-runner
// fleet (seven incidents over 2026-08-28/29, each 3-7 px per scene, max
// channel delta 2), while `maxDiffPixelRatio` and the per-scene
// COMPACT_MAX_DIFF / DOCK_MAX_DIFF stay 0 — zero differing pixels, with
// "differing" meaning beyond-the-band. That claim is ARITHMETIC about a
// third-party comparator (`35215 * threshold²` on pixelmatch's YIQ delta), and
// CLAUDE.md's instrument rule applies: when the fix is to the INSTRUMENT,
// negative-control it in BOTH directions, and make one of those a PERMANENT
// leg. This file is that leg, and it calls THE SAME predicate the gate calls —
// playwright-core's `getComparator('image/png')`, the function
// `toHaveScreenshot` compares through — never a re-typed copy of its formula
// (a re-typed copy in the self-test is how a previous gate went blind).
//
// Both directions, on every unit run:
//   PASS side — identical images; one pixel shifted ±2 LSB on all channels
//     (the fleet's own noise shape); the EXACT 7-pixel scatter measured off
//     the face-moog904a-compact incident (run 33282588837).
//   FAIL side — one pixel at ±3 LSB (1 differing pixel > the 0 allowed); a
//     gross 100-px change (the comparator still reds on real edits); the same
//     ±2 pixel at threshold 0 (proving the PASS side is the threshold's doing,
//     not a dead comparator); the measured scatter at threshold 0 (the
//     synthetic reconstruction reproduces the incident's red).
//
// The gate's settings are PARSED OUT OF vrt.config.ts and the per-scene
// budgets IMPORTED from _shell-faces.ts — nothing here restates a number the
// gate owns, so this test follows a threshold change instead of silently
// pinning the old one, and a change that widens the band past ±3 LSB reddens
// the FAIL side until the band is consciously re-derived.
//
// ⚠ WHAT THIS GATE IS STRUCTURALLY UNABLE TO SEE, stated inside the gate: it
// validates the COMPARATOR PREDICATE at the configured settings, over
// synthetic pairs. It cannot see the capture pipeline (fonts, AA pins,
// viewport, settle), whether baselines exist or are stale (vrt-meta and the
// capture own that), or a real regression on a real scene (vrt-strict owns
// that). And the band itself is a DECLARED blind spot of the product gate: a
// real change confined everywhere to ±2 LSB/channel (up to ±4 on a single
// channel, the honest YIQ reading) is invisible by design — that band is
// where identical code already renders differently per CPU model, so no
// comparison on this fleet could attribute it anyway.
//
// Pure-unit, file-reading, zero flake, ~0 CI wall-time.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { COMPACT_MAX_DIFF, DOCK_MAX_DIFF } from '../../../../../e2e/vrt/_shell-faces';

function repoRoot(): string {
  return resolve(import.meta.dirname, '../../../../..');
}

// ── THE REAL PREDICATE ─────────────────────────────────────────────────────
//
// playwright-core's exports map does not export `./lib/server/utils/*`, so
// this loads by ABSOLUTE FILE PATH — which also means a playwright bump that
// moves the module fails LOUDLY here (require throws) rather than silently
// testing nothing. vrt.config.ts's tolerance block names this same file as
// the mechanics reference; if it moves, both must follow it together.
const COMPARATORS_PATH = resolve(
  repoRoot(),
  'node_modules/playwright-core/lib/server/utils/comparators.js',
);
// The PNG codec is playwright-core's own bundled one — encode with the exact
// decoder family the comparator reads through, not a second codec.
const UTILS_BUNDLE_PATH = resolve(repoRoot(), 'node_modules/playwright-core/lib/utilsBundle.js');

const requireCjs = createRequire(import.meta.url);

type CompareResult = { errorMessage: string; diff?: Buffer } | null;
type Comparator = (
  actual: Buffer,
  expected: Buffer,
  options: { threshold?: number; maxDiffPixels?: number; maxDiffPixelRatio?: number },
) => CompareResult;

function loadComparator(): Comparator {
  const { getComparator } = requireCjs(COMPARATORS_PATH) as {
    getComparator: (mime: string) => Comparator;
  };
  return getComparator('image/png');
}

// ── THE GATE'S OWN SETTINGS, read from the artifact that declares them ─────

const VRT_CONFIG_PATH = resolve(repoRoot(), 'e2e/vrt/vrt.config.ts');

/** Strip comments so a number in prose is never read as a setting. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** The literal body of the config's `toHaveScreenshot: { … }` block. */
function toHaveScreenshotBlock(src: string): string {
  const start = src.search(/^\s*toHaveScreenshot:\s*\{/m);
  if (start < 0) throw new Error('vrt.config.ts: no `toHaveScreenshot: {` block found');
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error('vrt.config.ts: unbalanced braces in `toHaveScreenshot`');
}

/** A numeric literal (int or decimal) declared for `key` in a block. */
function numberIn(block: string, key: string): number | null {
  const m = new RegExp(`^\\s*${key}:\\s*([\\d_.]+)`, 'm').exec(stripComments(block));
  return m ? Number(m[1]!.replace(/_/g, '')) : null;
}

const CONFIG_SRC = readFileSync(VRT_CONFIG_PATH, 'utf8');
const GATE_THRESHOLD = numberIn(toHaveScreenshotBlock(CONFIG_SRC), 'threshold');
const GATE_RATIO = numberIn(toHaveScreenshotBlock(CONFIG_SRC), 'maxDiffPixelRatio');

// ── SYNTHETIC PAIRS, built from primitives (vrt-png-verify convention) ─────

/** (x, y, [Δr, Δg, Δb]) — LSB deltas applied to the flat base. */
type PixelDelta = readonly [x: number, y: number, d: readonly [number, number, number]];

/**
 * THE MEASURED INCIDENT, verbatim. face-moog904a-compact, CI run 33282588837
 * (2026-08-29, branch feat/record-cv-automation, shard 1): the committed
 * baseline vs the run's actual differed in exactly these 7 of 88×82 pixels,
 * every channel delta within ±2 — the AA band the fleet's CPU mix produces
 * from identical code. Reproduced here as deltas on a flat base: pixelmatch's
 * YIQ delta is linear in the channel difference, so the SCORE of each pixel is
 * the incident's score regardless of the base level.
 */
const MOOG904A_W = 88;
const MOOG904A_H = 82;
const MOOG904A_SCATTER: readonly PixelDelta[] = [
  [16, 38, [0, -1, -1]],
  [14, 39, [0, -1, -1]],
  [15, 39, [0, -1, -1]],
  [37, 39, [0, 1, 1]],
  [38, 39, [0, 0, 1]],
  [37, 40, [0, 2, 1]],
  [32, 44, [0, 1, 1]],
];

const BASE_LEVEL = 128;

function makePng(width: number, height: number, deltas: readonly PixelDelta[] = []): Buffer {
  const { PNG } = requireCjs(UTILS_BUNDLE_PATH) as {
    PNG: new (opts: { width: number; height: number }) => {
      data: Buffer;
    } & Record<string, unknown>;
  } & { PNG: { sync: { write(png: unknown): Buffer } } };
  const img = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    img.data[i * 4] = BASE_LEVEL;
    img.data[i * 4 + 1] = BASE_LEVEL;
    img.data[i * 4 + 2] = BASE_LEVEL;
    img.data[i * 4 + 3] = 255;
  }
  for (const [x, y, [dr, dg, db]] of deltas) {
    const i = (y * width + x) * 4;
    img.data[i] = BASE_LEVEL + dr;
    img.data[i + 1] = BASE_LEVEL + dg;
    img.data[i + 2] = BASE_LEVEL + db;
  }
  return (PNG as unknown as { sync: { write(png: unknown): Buffer } }).sync.write(img);
}

/** One uniform-gray single-pixel shift — the AA band's worst-case direction
 *  (the YIQ luma axis), which is why ±2 here bounds every ±2 combination. */
function grayShift(delta: number): readonly PixelDelta[] {
  return [[7, 11, [delta, delta, delta]]];
}

const W = 64;
const H = 64;

describe('VRT comparator band: the gate predicate at its configured settings', () => {
  it('instrument check: the real comparator loads and the gate settings parse', () => {
    expect(
      existsSync(COMPARATORS_PATH),
      `playwright-core moved server/utils/comparators.js — this test AND the ` +
        `mechanics note in e2e/vrt/vrt.config.ts's tolerance block must follow it`,
    ).toBe(true);
    expect(typeof loadComparator(), 'getComparator("image/png") must yield a function').toBe(
      'function',
    );
    // The settings this file drives the predicate with are the GATE'S OWN.
    // A parse returning null would make every leg below vacuous — fail here,
    // in the direction that matters, with the units stated.
    expect(
      GATE_THRESHOLD,
      'could not parse a numeric `threshold` out of vrt.config.ts toHaveScreenshot',
    ).not.toBeNull();
    expect(
      GATE_RATIO,
      'could not parse a numeric `maxDiffPixelRatio` out of vrt.config.ts toHaveScreenshot',
    ).not.toBeNull();
    expect(
      GATE_THRESHOLD!,
      'threshold is a pixelmatch colour-distance fraction, not a pixel count — ' +
        'outside (0, 1) the band model below does not describe the gate',
    ).toBeGreaterThan(0);
    expect(GATE_THRESHOLD!).toBeLessThan(1);
    expect(
      GATE_RATIO,
      'the 2026-08-29 ruling keeps ZERO DIFFERING PIXELS: maxDiffPixelRatio must stay 0 — ' +
        'only the DEFINITION of "differing" moved (beyond the ±2-LSB band)',
    ).toBe(0);
    expect(
      COMPACT_MAX_DIFF,
      'the per-scene compact budget (maxDiffPixels) must stay 0 under the band ruling',
    ).toBe(0);
    expect(
      DOCK_MAX_DIFF,
      'the per-scene dock budget (maxDiffPixels) must stay 0 under the band ruling',
    ).toBe(0);
  });

  const gate = (actual: Buffer, expected: Buffer): CompareResult =>
    loadComparator()(actual, expected, {
      threshold: GATE_THRESHOLD!,
      maxDiffPixelRatio: GATE_RATIO!,
    });

  it('identical images PASS', () => {
    expect(gate(makePng(W, H), makePng(W, H))).toBeNull();
  });

  it('one pixel shifted ±2 LSB (all channels, gray/AA shape) PASSES — the fleet band', () => {
    for (const d of [2, -2] as const) {
      expect(
        gate(makePng(W, H, grayShift(d)), makePng(W, H)),
        `a single pixel at ${d} LSB/channel is INSIDE the ±2-LSB band the fleet's own ` +
          `CPU mix produces from identical code — the gate must not fail on it`,
      ).toBeNull();
    }
  });

  it('one pixel shifted ±3 LSB FAILS — one differing pixel is still one too many', () => {
    for (const d of [3, -3] as const) {
      const r = gate(makePng(W, H, grayShift(d)), makePng(W, H));
      expect(
        r,
        `a single pixel at ${d} LSB/channel is BEYOND the band; with ` +
          `maxDiffPixelRatio 0 the comparison must fail on that ONE pixel`,
      ).not.toBeNull();
      expect(r!.errorMessage).toContain('1 pixels');
    }
  });

  it('the measured moog904a scatter PASSES at the gate settings — the incident this band absorbs', () => {
    expect(
      gate(
        makePng(MOOG904A_W, MOOG904A_H, MOOG904A_SCATTER),
        makePng(MOOG904A_W, MOOG904A_H),
      ),
      '7 scattered AA pixels, every channel delta within ±2 LSB (run 33282588837, ' +
        'reproduced delta-exact) — the exact shape that was red three times on 2026-08-29',
    ).toBeNull();
  });

  it('negative control, both directions: threshold 0 reds the SAME pixels the band passes', () => {
    const cmp = loadComparator();
    // Direction 1 — the pass legs above are the THRESHOLD's doing, not a dead
    // comparator: the identical ±2 pixel fails when the threshold is 0 (the
    // superseded 2026-08-25 setting), through the same predicate.
    const one = cmp(makePng(W, H, grayShift(2)), makePng(W, H), {
      threshold: 0,
      maxDiffPixelRatio: 0,
    });
    expect(
      one,
      'at threshold 0 a +2 LSB pixel must fail — if this passes, the comparator is not ' +
        'measuring and every green above is vacuous',
    ).not.toBeNull();
    expect(one!.errorMessage).toContain('1 pixels');
    // …and the measured scatter reds at zero tolerance, as its incident did.
    // ⚠ THE COUNT IS NOT 7 HERE AND THAT IS THE INSTRUMENT SHOWING ITS OWN
    // GRAIN, found by this very leg on first run: pixelmatch classifies a
    // differing pixel as "antialiasing" and DISCOUNTS it (playwright passes no
    // `includeAA`, so the classifier is on) when the delta sits in a local
    // gradient — which the ADJACENT tuples of this scatter create on a flat
    // synthetic base (5 of 7 counted). On the REAL pair the same predicate at
    // threshold 0 printed `7 pixels` (verified against run 33282588837's
    // expected/actual during the 2026-08-29 calibration — recorded in the
    // restoration PR). The obligation this leg carries is the DIRECTION:
    // the reconstruction must FAIL at the superseded zero threshold.
    const scatter = cmp(
      makePng(MOOG904A_W, MOOG904A_H, MOOG904A_SCATTER),
      makePng(MOOG904A_W, MOOG904A_H),
      { threshold: 0, maxDiffPixelRatio: 0 },
    );
    expect(
      scatter,
      'the measured scatter must fail at threshold 0 — it is the incident the band absorbs',
    ).not.toBeNull();
    expect(scatter!.errorMessage).toMatch(/[1-9]\d* pixels/);
  });

  it('a gross change FAILS at the gate settings — the band does not blunt real edits', () => {
    // A 10×10 block moved far beyond any AA band (+64 LSB/channel). This is
    // the direction a too-wide threshold would break first, and the leg that
    // reddens if `threshold` is ever raised past real-edit territory.
    const block: PixelDelta[] = [];
    for (let y = 20; y < 30; y++)
      for (let x = 20; x < 30; x++) block.push([x, y, [64, 64, 64]]);
    const r = gate(makePng(W, H, block), makePng(W, H));
    expect(r).not.toBeNull();
    expect(r!.errorMessage).toContain('100 pixels');
  });

  it('the per-scene face budget rejects one over-band pixel too (the _shell-faces shape)', () => {
    // The face specs pass COMPACT_MAX_DIFF / DOCK_MAX_DIFF as per-assertion
    // maxDiffPixels ON TOP of the config ratio; comparators.js takes
    // min(maxDiffPixels, w*h*ratio). Drive that exact shape once so the
    // face lane's zero is validated through the same predicate, not assumed.
    const r = loadComparator()(makePng(W, H, grayShift(3)), makePng(W, H), {
      threshold: GATE_THRESHOLD!,
      maxDiffPixels: DOCK_MAX_DIFF,
      maxDiffPixelRatio: GATE_RATIO!,
    });
    expect(r, 'one +3 LSB pixel must fail the dock-scene budget (0 px allowed)').not.toBeNull();
    expect(r!.errorMessage).toContain('1 pixels');
  });
});
