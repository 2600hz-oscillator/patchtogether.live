// packages/web/src/lib/audio/dx7-envelope-mirror.test.ts
//
// THE ENVELOPE MIRROR GATE.
//
// `packages/dsp/src/dx7.ts` (the worklet) and this workspace's
// `dx7-syx.ts` + `dx7-render.ts` are declared SYNC PARTNERS: the worklet
// bundle cannot import from the web workspace, so the operator-envelope and
// fixed-frequency law is duplicated verbatim. ART reads the RENDER path, so a
// one-sided edit means ART keeps passing on stale expectations while the
// audible engine drifts — the exact failure mode PR 0 added the algorithm-table
// mirror for.
//
// This gate is the envelope half. Three layers, each independently able to
// fail:
//
//   1. TEXT.       Both `dx7-envelope-mirror:start/end` regions, normalised
//                  (strip `export `, collapse whitespace), must be identical.
//   2. BEHAVIOUR.  The worklet's copy is EVALUATED off disk and swept against
//                  the imported web functions — so a mis-extraction cannot
//                  make layer 1 pass vacuously, and a semantic divergence
//                  that survived normalisation still fails.
//   3. WIRING.     `dx7-render.ts` must consume the shared helpers rather than
//                  re-implementing them, and neither engine may still carry
//                  the old τ-based law or the `ratio * C4_HZ` fixed-mode bug.
//
// Layers 1 and 2 are negative-controlled below: a perturbed copy of the
// worklet block is required to FAIL both, so a green run is evidence the gate
// can actually see a change.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DX7_DB_PER_OCTAVE,
  DX7_EG_ATTACK_CEIL_DB,
  DX7_EG_ATTACK_JUMP_DB,
  DX7_EG_ATTACK_SPEEDUP,
  DX7_EG_FLOOR_DB,
  DX7_EG_LEVEL_DB_PER_STEP,
  DX7_EG_RATE0_FULL_SCALE_S,
  DX7_EG_RATE_UNIT_DB_PER_S,
  dx7EgAmpFromDb,
  dx7EgTick,
  dx7FixedHz,
  dx7FixedHzFromRatio,
  dx7LevelToDb,
  dx7RateToDbPerSec,
} from './dx7-syx';

const WORKLET = fileURLToPath(new URL('../../../../dsp/src/dx7.ts', import.meta.url));
const WEB_LAW = fileURLToPath(new URL('./dx7-syx.ts', import.meta.url));
const RENDER = fileURLToPath(new URL('./dx7-render.ts', import.meta.url));

const START = '// dx7-envelope-mirror:start';
const END = '// dx7-envelope-mirror:end';

/** Pull the delimited law block out of a file. */
function extractBlock(path: string): string {
  const src = readFileSync(path, 'utf8');
  const a = src.indexOf(START);
  const b = src.indexOf(END);
  expect(a, `${START} not found in ${path}`).toBeGreaterThan(-1);
  expect(b, `${END} not found in ${path}`).toBeGreaterThan(a);
  return src.slice(a + START.length, b);
}

/** `export ` is the only permitted difference between the two copies. */
function normalise(block: string): string {
  return block
    .replace(/^\s*export\s+/gm, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

/**
 * Evaluate a law block as JavaScript and hand back its exported surface.
 * The block is pure and self-contained except for `clampInt`, which both
 * files define identically outside the mirrored region.
 */
function evaluateBlock(block: string): Record<string, (...a: never[]) => unknown> {
  const js = block
    .replace(/^\s*export\s+/gm, '')
    // Strip TS type annotations: parameter types, return types, `readonly`.
    .replace(/:\s*readonly number\[\]/g, '')
    .replace(/:\s*(Float64Array|Int32Array|number|boolean|void)\b/g, '')
    // Non-null assertions only — NEVER a blanket `!` strip, which would turn
    // `!releasing` into `releasing` and silently delete the L3 hold.
    .replace(/\]!/g, ']');
  // Concatenated, not a template literal: the block's comments contain
  // backticks.
  const factory = new Function(
    'function clampInt(v, lo, hi) {\n' +
    '  const i = Math.round(v);\n' +
    '  if (i < lo) return lo;\n' +
    '  if (i > hi) return hi;\n' +
    '  return i;\n' +
    '}\n' +
    js + '\n' +
    'return {\n' +
    '  DX7_DB_PER_OCTAVE, DX7_EG_LEVEL_DB_PER_STEP, DX7_EG_FLOOR_DB,\n' +
    '  DX7_EG_ATTACK_CEIL_DB, DX7_EG_ATTACK_JUMP_DB, DX7_EG_ATTACK_SPEEDUP,\n' +
    '  DX7_EG_RATE0_FULL_SCALE_S,\n' +
    '  DX7_EG_RATE_UNIT_DB_PER_S, dx7LevelToDb, dx7RateToDbPerSec,\n' +
    '  dx7EgAmpFromDb, dx7EgTick, dx7FixedHz, dx7FixedHzFromRatio,\n' +
    '};\n',
  );
  return factory() as Record<string, (...a: never[]) => unknown>;
}

/** The subset of a law block the behavioural sweep drives. */
interface LawModule {
  dx7LevelToDb: typeof dx7LevelToDb;
  dx7RateToDbPerSec: typeof dx7RateToDbPerSec;
  dx7EgTick: typeof dx7EgTick;
}

/** This workspace's copy, as a LawModule — the reference side of every sweep. */
const WEB: LawModule = { dx7LevelToDb, dx7RateToDbPerSec, dx7EgTick };

/**
 * Run a whole 4-segment envelope through ONE law module — level→dB, rate→dB/s
 * AND the state machine, so a divergence anywhere in the block shows up — and
 * return its dB trace, decimated.
 */
function trace(
  mod: LawModule,
  levels: readonly number[],
  rates: readonly number[],
  releaseAt: number,
  n: number,
): number[] {
  const levelsDb = levels.map((l) => mod.dx7LevelToDb(l));
  const ratesDbPerSec = rates.map((r) => mod.dx7RateToDbPerSec(r));
  const envDb = new Float64Array(1);
  const envSeg = new Int32Array(1);
  envDb[0] = levelsDb[3]!;
  const dt = 1 / 48000;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i === releaseAt) envSeg[0] = 3; // note-off, as both engines do it
    mod.dx7EgTick(envDb, envSeg, 0, levelsDb, ratesDbPerSec, i >= releaseAt, dt);
    if (i % 64 === 0) out.push(envDb[0]!);
  }
  return out;
}

describe('dx7 envelope law — the packages/dsp/src/dx7.ts worklet MIRROR', () => {
  const workletBlock = extractBlock(WORKLET);
  const webBlock = extractBlock(WEB_LAW);

  it('layer 1 — the two law blocks are textually identical modulo `export`', () => {
    expect(normalise(workletBlock)).toEqual(normalise(webBlock));
  });

  it('layer 1 — the block is not empty (a vacuous match cannot pass)', () => {
    const n = normalise(webBlock);
    expect(n.length).toBeGreaterThan(1500);
    for (const sym of [
      'DX7_EG_RATE_UNIT_DB_PER_S', 'DX7_EG_ATTACK_SPEEDUP', 'dx7LevelToDb',
      'dx7RateToDbPerSec', 'dx7EgAmpFromDb', 'dx7EgTick', 'dx7FixedHz',
      'dx7FixedHzFromRatio',
    ]) {
      expect(n, `${sym} must live inside the mirrored block`).toContain(sym);
    }
  });

  it('layer 2 — the worklet copy, evaluated, agrees numerically with the web copy', () => {
    const w = evaluateBlock(workletBlock) as unknown as {
      DX7_DB_PER_OCTAVE: number; DX7_EG_LEVEL_DB_PER_STEP: number;
      DX7_EG_FLOOR_DB: number; DX7_EG_ATTACK_CEIL_DB: number;
      DX7_EG_ATTACK_JUMP_DB: number; DX7_EG_ATTACK_SPEEDUP: number;
      DX7_EG_RATE0_FULL_SCALE_S: number;
      DX7_EG_RATE_UNIT_DB_PER_S: number;
      dx7LevelToDb: typeof dx7LevelToDb;
      dx7RateToDbPerSec: typeof dx7RateToDbPerSec;
      dx7EgAmpFromDb: typeof dx7EgAmpFromDb;
      dx7EgTick: typeof dx7EgTick;
      dx7FixedHz: typeof dx7FixedHz;
      dx7FixedHzFromRatio: typeof dx7FixedHzFromRatio;
    };

    expect(w.DX7_DB_PER_OCTAVE).toBe(DX7_DB_PER_OCTAVE);
    expect(w.DX7_EG_LEVEL_DB_PER_STEP).toBe(DX7_EG_LEVEL_DB_PER_STEP);
    expect(w.DX7_EG_FLOOR_DB).toBe(DX7_EG_FLOOR_DB);
    expect(w.DX7_EG_ATTACK_CEIL_DB).toBe(DX7_EG_ATTACK_CEIL_DB);
    expect(w.DX7_EG_ATTACK_JUMP_DB).toBe(DX7_EG_ATTACK_JUMP_DB);
    expect(w.DX7_EG_ATTACK_SPEEDUP).toBe(DX7_EG_ATTACK_SPEEDUP);
    expect(w.DX7_EG_RATE0_FULL_SCALE_S).toBe(DX7_EG_RATE0_FULL_SCALE_S);
    expect(w.DX7_EG_RATE_UNIT_DB_PER_S).toBe(DX7_EG_RATE_UNIT_DB_PER_S);

    // Every level and every rate byte, exactly.
    for (let v = 0; v <= 99; v++) {
      expect(w.dx7LevelToDb(v), `level ${v}`).toBe(dx7LevelToDb(v));
      expect(w.dx7RateToDbPerSec(v), `rate ${v}`).toBe(dx7RateToDbPerSec(v));
      expect(w.dx7FixedHz(v & 31, v), `fixedHz ${v}`).toBe(dx7FixedHz(v & 31, v));
    }
    for (const r of [0.25, 0.5, 1, 1.5, 2, 3, 3.5, 7, 14, 30.99]) {
      expect(w.dx7FixedHzFromRatio(r), `ratio ${r}`).toBe(dx7FixedHzFromRatio(r));
    }
    for (const db of [-100, DX7_EG_FLOOR_DB, -74, -51, -12, -0.75, 0]) {
      expect(w.dx7EgAmpFromDb(db), `amp ${db}`).toBe(dx7EgAmpFromDb(db));
    }

    // And the whole state machine, over patches that exercise every branch:
    // fast/slow, rising-to-a-lower-target, a sustaining L3, an L4 > 0 idle.
    const CASES: Array<{ l: number[]; r: number[]; rel: number }> = [
      { l: [99, 80, 60, 0], r: [99, 50, 30, 60], rel: 12000 },  // mid-decay release
      { l: [99, 80, 60, 0], r: [99, 99, 99, 60], rel: 40000 },  // long L3 HOLD
      { l: [99, 90, 80, 0], r: [25, 20, 18, 30], rel: 40000 },  // released mid-attack
      { l: [50, 60, 70, 40], r: [0, 99, 12, 7], rel: 30000 },   // rising targets, L4 > 0
      { l: [0, 0, 0, 0], r: [40, 40, 40, 40], rel: 5000 },      // degenerate, all floor
      { l: [99, 99, 99, 99], r: [70, 70, 70, 70], rel: 2000 },  // degenerate, all unity
    ];
    for (const c of CASES) {
      expect(
        trace(w, c.l, c.r, c.rel, 48000),
        `envelope trace for l=${c.l} r=${c.r}`,
      ).toEqual(trace(WEB, c.l, c.r, c.rel, 48000));
    }
  });

  it('NEGATIVE CONTROL — a perturbed worklet block fails both layers', () => {
    // Change ONE digit of the calibration constant. If the gate cannot see
    // this, it is decoration.
    const perturbed = workletBlock.replace(
      'DX7_EG_RATE0_FULL_SCALE_S = 317.487',
      'DX7_EG_RATE0_FULL_SCALE_S = 317.488',
    );
    expect(perturbed, 'the perturbation must actually apply').not.toEqual(workletBlock);

    // Layer 1 sees it.
    expect(normalise(perturbed)).not.toEqual(normalise(webBlock));

    // Layer 2 sees it too, independently.
    const bad = evaluateBlock(perturbed) as unknown as LawModule;
    expect(bad.dx7RateToDbPerSec(50)).not.toBe(dx7RateToDbPerSec(50));
    expect(trace(bad, [99, 80, 60, 0], [99, 50, 30, 60], 12000, 48000))
      .not.toEqual(trace(WEB, [99, 80, 60, 0], [99, 50, 30, 60], 12000, 48000));

    // A behaviour-only perturbation that leaves every constant untouched —
    // dropping the L3 hold, the exact bug this PR fixes — must ALSO be caught.
    const noHold = workletBlock.replace(
      'if (seg === 3 && !releasing) return;   // HOLD at L3 while the gate is high',
      'if (false) return;',
    );
    expect(noHold, 'the hold perturbation must actually apply').not.toEqual(workletBlock);
    const unheld = evaluateBlock(noHold) as unknown as LawModule;
    // Fast rates so segments 0..2 are done in ~3 ms and the gate is still high
    // for another 0.8 s — the window the hold is supposed to own.
    expect(trace(unheld, [99, 80, 60, 0], [99, 99, 99, 60], 40000, 48000))
      .not.toEqual(trace(WEB, [99, 80, 60, 0], [99, 99, 99, 60], 40000, 48000));

    // And an idle-level perturbation (start at silence instead of L4) — caught
    // by layer 1 alone, since it lives outside the tick function.
    const noIdle = workletBlock.replace(
      'let db = envDb[i]!;',
      'let db = envDb[i]! * 0 + DX7_EG_FLOOR_DB;',
    );
    expect(noIdle).not.toEqual(workletBlock);
    expect(normalise(noIdle)).not.toEqual(normalise(webBlock));
  });

  it('layer 3 — the render mirror CONSUMES the shared law, never re-implements it', () => {
    const render = readFileSync(RENDER, 'utf8');
    expect(render).toMatch(/import\s*\{[^}]*dx7EgTick[^}]*\}\s*from\s*'\.\/dx7-syx'/s);
    // No private copy of the state machine.
    expect(render).not.toContain('dx7-envelope-mirror:start');
    expect(render).not.toMatch(/envSeg\[opIdx\]\s*=\s*seg\s*\+\s*1/);
  });

  it('layer 3 — the superseded laws are gone from BOTH engines', () => {
    const worklet = readFileSync(WORKLET, 'utf8');
    const render = readFileSync(RENDER, 'utf8');
    const web = readFileSync(WEB_LAW, 'utf8');
    for (const [name, src] of [['worklet', worklet], ['render', render], ['dx7-syx', web]] as const) {
      // The old τ = 8·exp(-0.09·r) rate law.
      expect(src, `${name} still carries the tau rate law`).not.toMatch(/8\s*\*\s*Math\.exp\(\s*-0\.09/);
      expect(src, `${name} still exports dx7RateToCoef`).not.toContain('dx7RateToCoef');
      // The old "advance when within 1% of target" auto-sustain-skip.
      expect(src, `${name} still auto-advances on proximity`).not.toMatch(/diff\s*\/\s*range\s*<\s*0\.01/);
      // The old fixed-frequency bug.
      expect(src, `${name} still computes fixed mode as ratio * C4_HZ`)
        .not.toMatch(/fixedMode\s*\?\s*\w*\.?ratio\s*\*\s*C4_HZ/);
    }
  });
});
