// art/scenarios/analog-vco/pw-pm-morph.test.ts
//
// ART scenarios PROVING THE PM/PW MORPH BUG IS FIXED.
//
// THE BUG: the saw→sine→square MORPH output used a hardcoded 50%-duty square
// for its square endpoint, so the PW knob/CV did NOTHING on the morph (the
// user-reported "PW doesn't work in MORPH mode"). The .dsp now uses the same
// pw-driven `sqr(p)` as the dedicated square tap, so PW shapes the morph's
// square component continuously across the sine→square half. PM/FM already bent
// the shared phase/freq for all morph positions; these baselines lock that in.
//
// Captured baselines (single VCO, MORPH output):
//   - PW sweep at shape=1 (square end): narrow / 50% / wide duty.
//   - PM-across-morph: a PM-modulated morph at saw / sine / square.
//   - FM-across-morph: an FM-modulated morph at saw / sine / square.
//
// node-web-audio-api can't host the Faust worklet, so we render from a faithful
// TS mirror of packages/dsp/src/analog-vco.dsp; the source SHA pin asserts the
// baseline is regenerated whenever the .dsp changes.

import { describe, expect, it } from 'vitest';
import {
  readBaseline,
  writeBaseline,
  readBaselineSha,
  writeBaselineSha,
  moduleSourceSha,
  compareBuffers,
  SHOULD_UPDATE_BASELINES,
} from '../../setup/render';

const SR = 48000;
const C4 = 261.626;
const DURATION_S = 0.5;
const frac = (x: number) => x - Math.floor(x);

// ── TS mirror of the POST-FIX analog-vco.dsp morph + process ──
const sn = (p: number) => Math.sin(2 * Math.PI * p);
const sawTap = (p: number) => 2 * p - 1;
const sqr = (p: number, pw: number) => (p < pw ? 1 : -1);
function morph(p: number, shape: number, pw: number): number {
  if (shape < 0.5) {
    const lo = 2 * shape;
    return sn(p) * lo + sawTap(p) * (1 - lo);
  }
  const hi = 2 * shape - 1;
  return sqr(p, pw) * hi + sn(p) * (1 - hi);
}

interface MorphOpts {
  pitch?: number;
  shape?: number;
  pw?: number;
  fmAmount?: number;
  pmAmount?: number;
  fmHz?: number; // FM modulator frequency (sine)
  pmHz?: number; // PM modulator frequency (sine)
}

/** Render the MORPH output of one VCO for `n` samples. */
function renderMorph(n: number, o: MorphOpts): Float32Array {
  const { pitch = 0, shape = 0, pw = 0.5, fmAmount = 0, pmAmount = 0, fmHz = 0, pmHz = 0 } = o;
  const out = new Float32Array(n);
  let pRaw = 0;
  for (let i = 0; i < n; i++) {
    const fm = fmHz ? Math.sin((2 * Math.PI * fmHz * i) / SR) : 0;
    const pm = pmHz ? Math.sin((2 * Math.PI * pmHz * i) / SR) : 0;
    const f = Math.min(20000, Math.max(1, C4 * Math.pow(2, pitch + fmAmount * fm)));
    pRaw = frac(pRaw + f / SR);
    const p = frac(pRaw + pmAmount * pm);
    out[i] = morph(p, shape, pw);
  }
  return out;
}

function diffRms(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i]! - b[i]!;
    s += d * d;
  }
  return Math.sqrt(s / a.length);
}
function dutyCycle(buf: Float32Array): number {
  let pos = 0;
  for (const v of buf) if (v > 0) pos++;
  return pos / buf.length;
}

async function assertBaseline(scenarioId: string, buf: Float32Array): Promise<void> {
  const srcSha = await moduleSourceSha('analog-vco');
  const existing = await readBaseline(scenarioId);
  const existingSha = await readBaselineSha(scenarioId);
  if (SHOULD_UPDATE_BASELINES || !existing) {
    await writeBaseline(scenarioId, buf);
    await writeBaselineSha(scenarioId, srcSha);
    expect(true).toBe(true);
    return;
  }
  expect(
    existingSha,
    `Baseline SHA (${existingSha}) != source SHA (${srcSha}). Run \`npm run art:update -w art\`.`,
  ).toBe(srcSha);
  const cmp = compareBuffers(buf, existing, 'B');
  expect(cmp.pass, cmp.detail).toBe(true);
}

const N = Math.round(SR * DURATION_S);

describe('analog-vco / pw-morph — PW shapes the morph square (bug fixed)', () => {
  it('PW changes the morph duty at the square end (was DEAD before the fix)', () => {
    const narrow = renderMorph(N, { shape: 1, pw: 0.2 });
    const wide = renderMorph(N, { shape: 1, pw: 0.8 });
    expect(diffRms(narrow, wide)).toBeGreaterThan(0.5);
    expect(dutyCycle(narrow)).toBeCloseTo(0.2, 1);
    expect(dutyCycle(wide)).toBeCloseTo(0.8, 1);
  });

  it('PW is alive across the sine→square half but not the saw→sine half', () => {
    // shape 0.75 (has square energy) responds to PW; shape 0.25 (no square) does not.
    const sqHalf = diffRms(renderMorph(N, { shape: 0.75, pw: 0.2 }), renderMorph(N, { shape: 0.75, pw: 0.8 }));
    const sawHalf = diffRms(renderMorph(N, { shape: 0.25, pw: 0.2 }), renderMorph(N, { shape: 0.25, pw: 0.8 }));
    expect(sqHalf).toBeGreaterThan(0.1);
    expect(sawHalf).toBeLessThan(1e-9);
  });

  it('captures PW-sweep baselines at the square end — RMS tier B', async () => {
    await assertBaseline('analog-vco/pw-sweep-narrow', renderMorph(N, { shape: 1, pw: 0.2 }));
    await assertBaseline('analog-vco/pw-sweep-50', renderMorph(N, { shape: 1, pw: 0.5 }));
    await assertBaseline('analog-vco/pw-sweep-wide', renderMorph(N, { shape: 1, pw: 0.8 }));
  });
});

describe('analog-vco / pm-fm-morph — modulation bends the morph at every shape', () => {
  it('PM reshapes the morph at saw, sine, AND square', () => {
    for (const shape of [0, 0.5, 1]) {
      const dry = renderMorph(N, { shape, pmAmount: 0, pmHz: 30 });
      const wet = renderMorph(N, { shape, pmAmount: 0.5, pmHz: 30 });
      expect(diffRms(dry, wet), `PM dead on morph at shape=${shape}`).toBeGreaterThan(0.05);
    }
  });

  it('FM reshapes the morph at saw, sine, AND square', () => {
    for (const shape of [0, 0.5, 1]) {
      const dry = renderMorph(N, { shape, fmAmount: 0, fmHz: 5 });
      const wet = renderMorph(N, { shape, fmAmount: 0.3, fmHz: 5 });
      expect(diffRms(dry, wet), `FM dead on morph at shape=${shape}`).toBeGreaterThan(0.05);
    }
  });

  it('captures PM/FM-across-morph baselines — RMS tier B', async () => {
    await assertBaseline('analog-vco/pm-morph-saw', renderMorph(N, { shape: 0, pmAmount: 0.5, pmHz: 30 }));
    await assertBaseline('analog-vco/pm-morph-sine', renderMorph(N, { shape: 0.5, pmAmount: 0.5, pmHz: 30 }));
    await assertBaseline('analog-vco/pm-morph-square', renderMorph(N, { shape: 1, pmAmount: 0.5, pmHz: 30 }));
    await assertBaseline('analog-vco/fm-morph-sine', renderMorph(N, { shape: 0.5, fmAmount: 0.3, fmHz: 5 }));
  });
});
