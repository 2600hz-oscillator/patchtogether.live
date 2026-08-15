// e2e/tests/swolevco.spec.ts
//
// SWOLEVCO end-to-end, through the REAL AudioEngine — the seam the ART lane
// cannot reach, because ART drives `def.factory` directly and never builds an
// edge.
//
// This file used to be titled "ratio knob change updates the rendered scope
// content" while its body set `timbre` and `fold` (never `ratio`) and asserted
// only that the scope canvas variance was > 5 — i.e. "something is still being
// drawn". It could not have failed for any of the reasons its title implies,
// and it was one of the four gates #1661 walked straight past. Both tests below
// read SAMPLES (SCOPE's `snapshot`), not pixels.

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';
import { waitFrames } from '../_helpers/frames';

test.describe.configure({ mode: 'parallel' });

/** Energy-weighted mean frequency. Rises when FM sidebands appear, which is
 *  the audible signature of both knobs under test here. */
function spectralCentroid(buf: Float32Array, sampleRate: number): number {
  const n = 2048;
  const slice = buf.subarray(0, Math.min(n, buf.length));
  let num = 0;
  let den = 0;
  for (let k = 1; k < slice.length / 2; k++) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < slice.length; i++) {
      const phi = (-2 * Math.PI * k * i) / slice.length;
      re += slice[i]! * Math.cos(phi);
      im += slice[i]! * Math.sin(phi);
    }
    const mag = Math.sqrt(re * re + im * im);
    num += mag * ((k * sampleRate) / slice.length);
    den += mag;
  }
  return den > 0 ? num / den : 0;
}

/** Pull one non-silent ch1 buffer out of the live SCOPE. */
async function captureScope(page: import('@playwright/test').Page): Promise<{
  buf: Float32Array;
  sr: number;
}> {
  const handle = await page.waitForFunction(() => {
    const w = globalThis as unknown as {
      __engine?: () => { read: (n: unknown, k: string) => unknown } | null;
      __patch: { nodes: Record<string, unknown> };
    };
    const eng = w.__engine?.();
    if (!eng) return null;
    const snap = eng.read(w.__patch.nodes['sc'], 'snapshot') as
      | { ch1?: Float32Array; sampleRate?: number }
      | null;
    if (!snap?.ch1) return null;
    let peak = 0;
    for (const v of snap.ch1) if (Math.abs(v) > peak) peak = Math.abs(v);
    if (peak < 0.05) return null;
    return { buf: Array.from(snap.ch1), sr: snap.sampleRate ?? 44100 };
  }, { timeout: 10_000, polling: 150 });
  const v = (await handle.jsonValue()) as { buf: number[]; sr: number };
  return { buf: new Float32Array(v.buf), sr: v.sr };
}

async function setParams(
  page: import('@playwright/test').Page,
  nodeId: string,
  params: Record<string, number>,
): Promise<void> {
  await page.evaluate(({ nodeId: id, params: p }) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params: Record<string, number> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes[id];
      if (n) for (const [k, val] of Object.entries(p)) n.params[k] = val;
    });
  }, { nodeId, params });
}

test('SWOLEVCO ratio knob change moves the primary spectrum through the FM path', async ({
  page,
  rack: _rack,
}) => {
  // `ratio` sets the MODULATOR's frequency, and the modulator only reaches the
  // primary through the timbre FM path — so at the spawn default (timbre 0) the
  // ratio knob is inaudible ON `out` BY DESIGN. Open timbre first; otherwise
  // this test would assert nothing, which is precisely what its predecessor did.
  await spawnPatch(
    page,
    [
      { id: 's-vco', type: 'swolevco', domain: 'audio', position: { x: 60, y: 60 },
        params: { timbre: 0.7, symmetry: 0.5, fold: 0, ratio: 1 } },
      { id: 'sc', type: 'scope', domain: 'audio', position: { x: 560, y: 60 } },
    ],
    [
      { id: 'e1', from: { nodeId: 's-vco', portId: 'out' }, to: { nodeId: 'sc', portId: 'ch1' },
        sourceType: 'audio', targetType: 'audio' },
    ],
  );

  const before = await captureScope(page);
  await setParams(page, 's-vco', { ratio: 6 });
  await waitFrames(page, 12);
  const after = await captureScope(page);

  const cBefore = spectralCentroid(before.buf, before.sr);
  const cAfter = spectralCentroid(after.buf, after.sr);
  // Moving the modulator from unison to 6× while FM is open moves the sideband
  // structure a long way up. A 25% floor is far below the measured move and far
  // above frame-to-frame jitter of a steady tone.
  expect(
    Math.abs(cAfter - cBefore) / Math.max(cBefore, 1),
    `ratio 1 → 6 did not move the primary spectrum (centroid ${cBefore.toFixed(0)} Hz → ${cAfter.toFixed(0)} Hz)`,
  ).toBeGreaterThan(0.25);
});

test('#1661 — an LFO patched into the timbre CV input actually modulates the audio', async ({
  page,
  rack: _rack,
}) => {
  // THE REGRESSION. Before the fix, `timbre`'s published AudioParam was the
  // `.gain` of a GainNode connected to nothing: this exact patch animated the
  // motorized fader and changed the sound by a peak |Δsample| of 0.0000e+0.
  //
  // The discriminator is deliberately NOT "the audio changed" — a live scope
  // trace changes every frame regardless. It is that the spectrum SWINGS over
  // time while the LFO runs, and holds still when it does not. That is the
  // user-visible gesture the module exists for (LFO into TIMBRE), so a pass
  // here means the gesture works and not merely that something moved.
  await spawnPatch(
    page,
    [
      { id: 's-vco', type: 'swolevco', domain: 'audio', position: { x: 60, y: 60 },
        params: { timbre: 0, symmetry: 0.5, fold: 0, ratio: 2 } },
      { id: 'lfo', type: 'lfo', domain: 'audio', position: { x: 60, y: 380 },
        params: { rate: 6, shape: 0, depth: 1 } },
      { id: 'sc', type: 'scope', domain: 'audio', position: { x: 560, y: 60 } },
    ],
    [
      { id: 'e1', from: { nodeId: 's-vco', portId: 'out' }, to: { nodeId: 'sc', portId: 'ch1' },
        sourceType: 'audio', targetType: 'audio' },
      { id: 'e2', from: { nodeId: 'lfo', portId: 'out' }, to: { nodeId: 's-vco', portId: 'timbre' },
        sourceType: 'cv', targetType: 'cv' },
    ],
  );

  // OBSERVABLE: RMS spread, not spectral centroid — MEASURED, not assumed.
  //
  // This assertion used to compare the RANGE of 8 spectral centroids against a
  // depth-0 control, and it could not have worked. Measured over 3 runs of this
  // exact patch (16 samples each):
  //
  //   centroid sd   modulated 493 / 493 / 527   control 575 / 541 / 537
  //   rms sd        modulated 0.0738 x3         control 0.0031 / 0.0031 / 0.0030
  //
  // The control's centroid spread is LARGER than the modulated signal's: this
  // waveshaped output moves its centroid violently on tiny phase differences,
  // so the metric is blind to the thing under test and the old test passed or
  // failed on which extreme its 8 samples happened to catch. RMS separates the
  // two conditions by ~24x and reproduces to the 4th decimal.
  //
  // Statistic is the STANDARD DEVIATION, not max-min: a range is an
  // extreme-value estimator whose expectation grows with sample count, which is
  // exactly the wrong property for a noise-floor comparison.
  const rmsOf = (b: Float32Array) => Math.sqrt(b.reduce((a, v) => a + v * v, 0) / b.length);
  const sd = (xs: number[]) => {
    const m = xs.reduce((a, v) => a + v, 0) / xs.length;
    return Math.sqrt(xs.reduce((a, v) => a + (v - m) ** 2, 0) / xs.length);
  };
  const modRms: number[] = [];
  for (let i = 0; i < 16; i++) {
    modRms.push(rmsOf((await captureScope(page)).buf));
    await waitFrames(page, 6);
  }
  const modSd = sd(modRms);

  // NEGATIVE CONTROL, in the same page and the same patch: pull the LFO's depth
  // to 0 so the cable stays connected but carries no modulation. Whatever
  // residual jitter the instrument has shows up HERE, so the comparison is
  // against this run's own noise floor rather than a hand-tuned constant.
  // Without it, "the CV works" and "the scope trace is noisy" are
  // indistinguishable — and a DEAD CV path (the #1661 defect: peak |Δsample|
  // exactly 0.0000e+0) reads as modSd ≈ ctrlSd.
  await setParams(page, 'lfo', { depth: 0 });
  await waitFrames(page, 20);
  const ctrlRms: number[] = [];
  for (let i = 0; i < 16; i++) {
    ctrlRms.push(rmsOf((await captureScope(page)).buf));
    await waitFrames(page, 6);
  }
  const ctrlSd = sd(ctrlRms);

  expect(
    modSd,
    `LFO → timbre produced an RMS spread of sd=${modSd.toFixed(4)} against a depth-0 `
    + `control of sd=${ctrlSd.toFixed(4)} (measured separation is ~24x; the bar is 5x). `
    + `A dead CV path reads as modSd ≈ ctrlSd — that was #1661, peak |Δsample| `
    + `exactly 0.0000e+0.`,
  ).toBeGreaterThan(Math.max(ctrlSd * 5, 0.005));
});
