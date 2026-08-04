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
import { renderFaustOffline } from '../../setup/faust-offline';
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
// ── RENDER FROM THE SHIPPED WASM — the TS mirror is GONE ──
//
// This file used to hand-port analog-vco.dsp into TS and pin its `.f32`
// baselines from THAT. Two independent defects lived in the hand-port, and
// neither could be seen by anything that only rendered the mirror:
//
//   1. `sqr = p < pw ? 1 : -1`, but Faust's `select2(c, a, b)` yields `a` when
//      c is FALSE — so the shipped square is `(p < pw) ? -1 : +1`. The mirror
//      was POLARITY-INVERTED, and so were the baselines it produced: measured
//      correlation between the committed pw-sweep-50.f32 and the real wasm was
//      **-0.9996** (and +0.9996 against its negation).
//   2. Every knob is `: si.smoo` starting from ZERO, so the first ~100 ms of a
//      real render is a parameter RAMP. The mirror applied knobs instantly and
//      modelled none of it.
//
// The offline harness renders the real thing (#1376/#1377 established it for
// this very module), so the mirror is deleted rather than corrected — a
// hand-port has to model smoothing, float widths and Faust semantics traps, and
// two of those three were silently wrong for as long as it existed.
//
// ⚠ ALL SEVEN BASELINES IN THIS FILE ARE RE-PINNED. That is not a regression:
// they were rendered from provably wrong maths and are now rendered from the
// module itself. The MODULE is unchanged — nothing a user hears moves.

interface MorphOpts {
  shape?: number;
  pw?: number;
  fmAmount?: number;
  pmAmount?: number;
  fmHz?: number;
  pmHz?: number;
}

/** Render the morph tap from the SHIPPED wasm. `process(pitch, fm, pm, sync)`
 *  -> (saw, sqr, tri, sn, morph, syncPulse); morph is output index 4. */
async function renderMorph(n: number, o: MorphOpts = {}): Promise<Float32Array> {
  const { shape = 0, pw = 0.5, fmAmount = 0, pmAmount = 0, fmHz = 0, pmHz = 0 } = o;
  const mk = (hz: number) => {
    if (!hz) return null;
    const b = new Float32Array(n);
    for (let i = 0; i < n; i++) b[i] = Math.sin((2 * Math.PI * hz * i) / SR);
    return b;
  };
  const r = await renderFaustOffline({
    name: 'analog-vco',
    totalSamples: n,
    inputs: [new Float32Array(n), mk(fmHz), mk(pmHz), null],
    params: { shape, pw, fmAmount, pmAmount },
    outputs: ['saw', 'sqr', 'tri', 'sn', 'morph', 'syncPulse'],
  });
  return r.morph!;
}

function diffRms(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i]! - b[i]!;
    s += d * d;
  }
  return Math.sqrt(s / a.length);
}

/** Fraction of samples above zero. NOTE: with the real wasm the square is
 *  `(p < pw) ? -1 : +1`, so the POSITIVE fraction is `1 - pw`, not `pw` — the
 *  mirror had this inverted, which is the defect this file's migration fixes. */
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
  it('PW changes the morph duty at the square end (was DEAD before the fix)', async () => {
    const narrow = await renderMorph(N, { shape: 1, pw: 0.2 });
    const wide = await renderMorph(N, { shape: 1, pw: 0.8 });
    expect(diffRms(narrow, wide)).toBeGreaterThan(0.5);
    // The shipped square is `select2(p < pw, 1, -1)` = `(p < pw) ? -1 : +1`, so
    // the POSITIVE fraction is `1 - pw`. These assertions read `pw` directly
    // before the migration — written against the inverted mirror, and green
    // because the mirror was the only thing they ever rendered.
    expect(dutyCycle(narrow)).toBeCloseTo(1 - 0.2, 1);
    expect(dutyCycle(wide)).toBeCloseTo(1 - 0.8, 1);
  });

  it('PW is alive across the sine→square half but not the saw→sine half', async () => {
    // shape 0.75 (has square energy) responds to PW; shape 0.25 (no square) does not.
    const sqHalf = diffRms(await renderMorph(N, { shape: 0.75, pw: 0.2 }), await renderMorph(N, { shape: 0.75, pw: 0.8 }));
    const sawHalf = diffRms(await renderMorph(N, { shape: 0.25, pw: 0.2 }), await renderMorph(N, { shape: 0.25, pw: 0.8 }));
    expect(sqHalf).toBeGreaterThan(0.1);
    expect(sawHalf).toBeLessThan(1e-9);
  });

  it('captures PW-sweep baselines at the square end — RMS tier B', async () => {
    await assertBaseline('analog-vco/pw-sweep-narrow', await renderMorph(N, { shape: 1, pw: 0.2 }));
    await assertBaseline('analog-vco/pw-sweep-50', await renderMorph(N, { shape: 1, pw: 0.5 }));
    await assertBaseline('analog-vco/pw-sweep-wide', await renderMorph(N, { shape: 1, pw: 0.8 }));
  });
});

describe('analog-vco / pm-fm-morph — modulation bends the morph at every shape', () => {
  it('PM reshapes the morph at saw, sine, AND square', async () => {
    for (const shape of [0, 0.5, 1]) {
      const dry = await renderMorph(N, { shape, pmAmount: 0, pmHz: 30 });
      const wet = await renderMorph(N, { shape, pmAmount: 0.5, pmHz: 30 });
      expect(diffRms(dry, wet), `PM dead on morph at shape=${shape}`).toBeGreaterThan(0.05);
    }
  });

  it('FM reshapes the morph at saw, sine, AND square', async () => {
    for (const shape of [0, 0.5, 1]) {
      const dry = await renderMorph(N, { shape, fmAmount: 0, fmHz: 5 });
      const wet = await renderMorph(N, { shape, fmAmount: 0.3, fmHz: 5 });
      expect(diffRms(dry, wet), `FM dead on morph at shape=${shape}`).toBeGreaterThan(0.05);
    }
  });

  it('captures PM/FM-across-morph baselines — RMS tier B', async () => {
    await assertBaseline('analog-vco/pm-morph-saw', await renderMorph(N, { shape: 0, pmAmount: 0.5, pmHz: 30 }));
    await assertBaseline('analog-vco/pm-morph-sine', await renderMorph(N, { shape: 0.5, pmAmount: 0.5, pmHz: 30 }));
    await assertBaseline('analog-vco/pm-morph-square', await renderMorph(N, { shape: 1, pmAmount: 0.5, pmHz: 30 }));
    await assertBaseline('analog-vco/fm-morph-sine', await renderMorph(N, { shape: 0.5, fmAmount: 0.3, fmHz: 5 }));
  });
});
