// e2e/tests/swolevco.spec.ts
//
// SWOLEVCO end-to-end, through the REAL AudioEngine — the seam the ART lane
// cannot reach, because ART drives `def.factory` directly and never builds an
// edge.
//
// ── WHY THIS FILE HAS BEEN REWRITTEN TWICE ────────────────────────────────
//
// v1 was titled "ratio knob change updates the rendered scope content" while
// its body set `timbre` and `fold` (never `ratio`) and asserted only that the
// scope canvas variance was > 5 — "something is still being drawn". It could
// not have failed for any of the reasons its title implies, and it was one of
// the four gates #1661 walked straight past.
//
// v2 read SAMPLES instead of pixels, which was the right move, and then made
// two measurement errors that BOTH passed locally and BOTH failed on CI. They
// are written out here because each is a re-usable trap:
//
//  1. THE CABLE WAS NEVER CONNECTED. The LFO's outputs are `phase0` /
//     `phase90` / `phase180` / `phase270`; v2 wired `{ nodeId: 'lfo', portId:
//     'out' }`. `AudioEngine.addEdge` throws on an unknown port and the
//     reconciler CATCHES that (deliberately — one bad edge must not abort a
//     whole pass), logs `[reconciler] skipping edge …` and carries on. So the
//     test that existed to prove "an LFO patched into timbre modulates the
//     audio" ran with NO LFO PATCHED IN, and still reported the ~24×
//     separation its comment quoted. Measured here, same page, same patch:
//     with the dead `lfo.out` edge the v2 statistic read sd 0.07393; with a
//     real `lfo.phase0` edge it read 0.07320. The two are indistinguishable
//     because NEITHER number came from modulation — see (2).
//     → the fix: `expectNoSkippedEdges`, asserted in BOTH tests. A cable that
//       does not materialise is now a LOUD failure, not a silent pass.
//
//  2. THE 24× SEPARATION WAS A COLD-START ARTEFACT. v2 took its 16 modulated
//     samples immediately after `spawnPatch` and its 16 control samples ~1 s
//     later. Sample #1 of the modulated block reads the SCOPE's 2048-sample
//     analyser ring before the audio thread has filled it: measured 0.2731
//     against ~0.5750 for every other sample in both blocks (peak was already
//     0.994, so it is a part-zero BUFFER, not a level ramp). One outlier in 16
//     is the whole of the "modulated sd", and the control block cannot see it
//     because the control never runs first.
//     → two fixes, both structural. `waitScopeFilled` gates on the OBSERVABLE
//       (no zero-run left in the ring + non-silent), and the CONTROL LEG NOW
//       RUNS FIRST, so any residual cold-start artefact lands on the control
//       and can only make this test HARDER to pass, never easier.
//
//  3. SPECTRAL CENTROID IS NOT A USABLE STATISTIC HERE, and v2's `ratio` test
//     compared ONE capture against ONE capture with a 25% relative bar.
//     Measured frame-to-frame at a FIXED ratio (N=2048, the same transform v2
//     used): mean ~1600–2270 Hz with sd 336–663 Hz, i.e. 15–40% RELATIVE SD
//     while nothing at all is changing. Comparing two single samples taken at
//     the SAME setting produced apparent "moves" of 0.276 and 0.414 — both
//     over the 25% bar — while the real 1 → 6 move measured 0.180 on two runs
//     of three. That is a coin flip, and CI simply called it the other way
//     (2305 Hz → 1837 Hz). v2's own comment had already measured this ("the
//     control's centroid spread is LARGER than the modulated signal's") and
//     rejected the metric for the OTHER test while leaving it in this one.
//     → the fix: measure what `ratio` is DEFINED to do. It is the modulator's
//       frequency as a multiple of the primary's, so read the modulator and
//       assert the LAW, quantitatively, in Hz.
//     ⚠ v2's stated physics was also backwards: raising ratio at a fixed
//       Timbre LOWERS the FM index (deviation is fixed in Hz, so index =
//       deviation / modulator-Hz falls as the modulator rises), so the
//       sidebands move OUT and get WEAKER. Measured on `out`: the HF-energy
//       ratio went 0.00682 → 0.00507 from ratio 1 → 6, against a 0.00682 →
//       0.00772 drift at the SAME setting. There is no cheap primary-side
//       statistic that separates those, which is why this test does not
//       pretend to have one.
//
// ── the observable, and why it is this one ────────────────────────────────
//
// `hfRatio` = RMS of the second difference ÷ RMS. A crude high-frequency
// energy measure, and FM SIDEBANDS ARE HIGH-FREQUENCY ENERGY — so it reads the
// FM index directly, which is exactly what Timbre sets. Measured over 32
// samples, three page instances, same patch:
//
//                            control sd     modulated sd     ratio
//   lfo.phase0 → timbre       0.000049        0.002590        53×
//   (v2's dead lfo.out edge)  0.000048        0.000046       0.95×
//
// The dead-path row is the point: this statistic reads a CV cable that reaches
// nothing as "no separation", which is the #1661 defect (peak |Δsample|
// exactly 0.0000e+0) and is what v2's statistic could not do. RMS was tried
// and kept as a diagnostic only — it separates 8.6× at best and its absolute
// value is NOT reproducible across page loads (measured 0.484 / 0.592 / 0.630
// at an identical Timbre = 1, because the RMS of an FM'd triangle depends on
// the carrier↔modulator start-phase relationship, which is arbitrary per
// AudioContext). Every comparison here is therefore WITHIN one page.
//
// Timbre sits at 0.5 — the CENTRE of its 0..1 range — so the ±1 CV sweeps the
// full natural range per docs/adr/004-cv-range-convention.md. At the 0 knob v2
// used, the scaling LUT clamps at the param floor and half the LFO cycle is
// rectified away, which cost an order of magnitude of separation (1.53×).

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { waitFrames } from '../_helpers/frames';

test.describe.configure({ mode: 'parallel' });

type EngineWindow = {
  __engine?: () => { read: (n: unknown, k: string) => unknown } | null;
  __patch: { nodes: Record<string, unknown> };
  __ydoc: { transact: (fn: () => void) => void };
};

/** Cap on the cold-start wait, in FRAMES. Bounds the failure; it is not the
 *  gate — the gate is the buffer-filled predicate itself. Measured: the ring
 *  fills in 10 frames locally, and it fills in AUDIO time (2048 samples ≈
 *  42.7 ms at 48 kHz), so a slow renderer needs FEWER frames, not more. */
const FILL_FRAME_CAP = 600;

/** Samples per leg. Each is one analyser window; the gaps between them are
 *  irregular (0/1/2 frames, cycling) so a periodic subject cannot alias
 *  against a fixed frame cadence — CLAUDE.md's "sample at co-prime /
 *  irregular offsets" rule. 32 covers ≥ 4 LFO cycles at 3.7 Hz on a 60 fps
 *  renderer and many more on a slow one. */
const SAMPLES_PER_LEG = 32;

/** LFO rate for the modulation leg, in Hz. Deliberately NOT an integer and
 *  not a simple fraction of any plausible frame rate (60 fps on a real GPU,
 *  ~7.9 fps under SwiftShader — a 6 Hz LFO sampled at ~8 fps is one aliasing
 *  accident away from reading as a constant). */
const LFO_RATE_HZ = 3.7;

/**
 * Fail if the reconciler skipped ANY edge in this page.
 *
 * `AudioEngine.addEdge` throws on an unknown/mismatched port and
 * `reconciler.ts` deliberately swallows that so one bad edge cannot abort a
 * whole pass — correct for the product, silent death for a test. Install this
 * BEFORE `spawnPatch` and assert it after: a cable this spec asks for and does
 * not get is now a failure with the engine's own message attached.
 *
 * Deny by default and unconditional (`toEqual([])`) — there is no allowance
 * for "one expected skip", because a spec that expects a skipped edge is a
 * spec asking for a cable it does not want.
 */
function watchSkippedEdges(page: Page): () => void {
  const skipped: string[] = [];
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('[reconciler] skipping edge')) skipped.push(text);
  });
  return () => {
    expect(
      skipped,
      'the AudioEngine refused a cable this test asked for, so the test ran on a '
      + 'patch it did not describe (this is exactly how the #1661 regression test '
      + 'came to pass with no LFO connected)',
    ).toEqual([]);
  };
}

/**
 * Wait until the SCOPE's analyser ring holds a full window of real audio.
 *
 * Gates on the OBSERVABLE, not on a frame budget: the ring starts as zeros and
 * is filled by the audio thread, so "still cold" is visible as a run of exact
 * zeros. `peak` guards the degenerate case where the patch is genuinely silent
 * (all-zero would otherwise satisfy "no partial fill" trivially). Returns the
 * frames it actually took so a failure downstream can be attributed.
 */
async function waitScopeFilled(page: Page, channel: 'ch1' | 'ch2'): Promise<number> {
  return await page.evaluate(
    async ({ chan, cap }) => {
      const w = globalThis as unknown as EngineWindow;
      const node = w.__patch.nodes['sc'];
      let frames = 0;
      return await new Promise<number>((resolve, reject) => {
        const tick = (): void => {
          frames++;
          const eng = w.__engine?.();
          const snap = eng?.read(node, 'snapshot') as Record<string, Float32Array> | null;
          const buf = snap?.[chan];
          if (buf && buf.length > 0) {
            let zeros = 0;
            let peak = 0;
            for (let i = 0; i < buf.length; i++) {
              if (buf[i] === 0) zeros++;
              const a = Math.abs(buf[i]!);
              if (a > peak) peak = a;
            }
            if (peak >= 0.05 && zeros / buf.length < 0.01) { resolve(frames); return; }
          }
          if (frames >= cap) {
            reject(new Error(
              `SCOPE.${chan} never held a full non-silent window within ${cap} frames`,
            ));
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    },
    { chan: channel, cap: FILL_FRAME_CAP },
  );
}

type Leg = {
  /** RMS of the second difference ÷ RMS — a high-frequency energy measure. */
  hfRatio: number[];
  /** Sign changes per analyser window. */
  zeroCrossings: number[];
  /** Peak |sample| per window — proves the leg was not measuring silence. */
  peak: number[];
  sampleRate: number;
  windowLength: number;
  samples: number;
  elapsedMs: number;
};

/**
 * Accumulate per-window statistics INSIDE the page.
 *
 * One `page.evaluate` for the whole leg, never one round trip per sample:
 * a Playwright-side poll shares the main thread with the subject it is
 * sampling, so on a loaded runner "frozen" and "never looked" are
 * indistinguishable from the output (CLAUDE.md's instrument rule). The counts
 * and elapsed time come back with the data so an assertion can print them.
 *
 * `SCOPE.read('snapshot')` calls `getFloatTimeDomainData` on every invocation,
 * so each frame here is a genuinely fresh window regardless of how fast the
 * card renders.
 */
async function sampleScope(page: Page, channel: 'ch1' | 'ch2', count: number): Promise<Leg> {
  return await page.evaluate(
    async ({ chan, n }) => {
      const w = globalThis as unknown as EngineWindow;
      const node = w.__patch.nodes['sc'];
      const hfRatio: number[] = [];
      const zeroCrossings: number[] = [];
      const peak: number[] = [];
      let sampleRate = 0;
      let windowLength = 0;
      const t0 = performance.now();
      await new Promise<void>((resolve) => {
        let skip = 0;
        const tick = (): void => {
          if (skip > 0) { skip--; requestAnimationFrame(tick); return; }
          const eng = w.__engine?.();
          const snap = eng?.read(node, 'snapshot') as
            | (Record<string, Float32Array> & { sampleRate?: number })
            | null;
          const buf = snap?.[chan];
          if (buf && buf.length > 2) {
            sampleRate = snap!.sampleRate ?? 0;
            windowLength = buf.length;
            let energy = 0;
            let hfEnergy = 0;
            let crossings = 0;
            let pk = 0;
            for (let i = 0; i < buf.length; i++) {
              energy += buf[i]! * buf[i]!;
              const a = Math.abs(buf[i]!);
              if (a > pk) pk = a;
            }
            for (let i = 2; i < buf.length; i++) {
              const d2 = buf[i]! - 2 * buf[i - 1]! + buf[i - 2]!;
              hfEnergy += d2 * d2;
            }
            for (let i = 1; i < buf.length; i++) {
              if ((buf[i]! >= 0) !== (buf[i - 1]! >= 0)) crossings++;
            }
            const rms = Math.sqrt(energy / buf.length);
            hfRatio.push(Math.sqrt(hfEnergy / (buf.length - 2)) / Math.max(rms, 1e-9));
            zeroCrossings.push(crossings);
            peak.push(pk);
          }
          if (hfRatio.length >= n) { resolve(); return; }
          // Irregular gap (0, 1, 2, 0, 1, 2, …) — see SAMPLES_PER_LEG.
          skip = hfRatio.length % 3;
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      return {
        hfRatio, zeroCrossings, peak, sampleRate, windowLength,
        samples: hfRatio.length, elapsedMs: performance.now() - t0,
      };
    },
    { chan: channel, n: count },
  );
}

const mean = (xs: number[]): number => xs.reduce((a, v) => a + v, 0) / xs.length;
/** Standard deviation, not max−min: a range is an extreme-value estimator
 *  whose expectation grows with sample count, which is the wrong property for
 *  a noise-floor comparison. */
const sd = (xs: number[]): number => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, v) => a + (v - m) ** 2, 0) / xs.length);
};

async function setParams(page: Page, nodeId: string, params: Record<string, number>): Promise<void> {
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

/** C4 — the module's 0 V/oct anchor, and the primary's pitch at tune=fine=0.
 *  Imported by value rather than from the module because this spec asserts the
 *  DOCUMENTED contract ("modulator frequency = primary × Ratio"), and a test
 *  that reads the same constant the code reads cannot catch the code changing
 *  it. */
const C4_HZ = 261.626;

/** Relative tolerance on a modulator-frequency reading. Zero-crossing counting
 *  quantises to one crossing per window = sampleRate / (2 × 2048) ≈ 11.7 Hz,
 *  which is 4.5% at C4 and 0.7% at 6×C4 — so the floor is set by quantisation
 *  at the LOW end, and 8% clears it with margin while being ~75× smaller than
 *  the 6× separation actually under test. */
const HZ_TOLERANCE = 0.08;

/** Measured modulator frequency in Hz from a leg's zero-crossing counts. A
 *  sine crosses zero twice per cycle, so f = crossings / (2 × windowSeconds). */
function measuredHz(leg: Leg): number {
  return (mean(leg.zeroCrossings) * leg.sampleRate) / (2 * leg.windowLength);
}

test('SWOLEVCO ratio sets the modulator frequency — tracked, and free-running at 0', async ({
  page,
  rack: _rack,
}) => {
  const assertNoSkippedEdges = watchSkippedEdges(page);

  // `mod_out` (the modulator's raw sine) is the port `ratio` is DEFINED
  // against: "modulator frequency = the primary's frequency × this value
  // (1 = unison, 2 = octave up); at 0 the modulator free-runs at its own
  // M.Tune / M.Fine pitch". Reading it directly turns this test from "did some
  // spectrum move" into an assertion about the mapping itself, in Hz.
  //
  // `mod_tune: 12` (one octave up) is what makes the ratio=0 leg meaningful:
  // with the default 0 the free-run pitch would be C4, indistinguishable from
  // ratio=1. The free-run leg exercises the `wsRatioFree` gate, which is new
  // code — the whole ratio mapping moved out of `setParam` and into a
  // WaveShaper/GainNode chain in this PR.
  //
  // `out` is on ch2 purely so the primary cannot go silent unnoticed while the
  // modulator behaves.
  await spawnPatch(
    page,
    [
      { id: 's-vco', type: 'swolevco', domain: 'audio', position: { x: 60, y: 60 },
        params: { timbre: 0.7, symmetry: 0.5, fold: 0, ratio: 1, mod_tune: 12 } },
      { id: 'sc', type: 'scope', domain: 'audio', position: { x: 560, y: 60 } },
    ],
    [
      { id: 'e1', from: { nodeId: 's-vco', portId: 'mod_out' }, to: { nodeId: 'sc', portId: 'ch1' },
        sourceType: 'audio', targetType: 'audio' },
      { id: 'e2', from: { nodeId: 's-vco', portId: 'out' }, to: { nodeId: 'sc', portId: 'ch2' },
        sourceType: 'audio', targetType: 'audio' },
    ],
  );
  assertNoSkippedEdges();
  await waitScopeFilled(page, 'ch1');
  await waitScopeFilled(page, 'ch2');

  const readLegs = async (): Promise<{ modulator: Leg; primary: Leg }> => ({
    modulator: await sampleScope(page, 'ch1', 12),
    primary: await sampleScope(page, 'ch2', 4),
  });

  // ratio 1 → unison; ratio 6 → six times up; ratio 0 → free-run at M.Tune;
  // then BACK to 1, which is the control that the mapping is a function of the
  // knob and not a one-way latch.
  const readings: { ratio: number; expectedHz: number; hz: number; primaryPeak: number }[] = [];
  for (const { ratio, expectedHz } of [
    { ratio: 1, expectedHz: C4_HZ },
    { ratio: 6, expectedHz: C4_HZ * 6 },
    { ratio: 0, expectedHz: C4_HZ * 2 }, // free-run: mod_tune = +12 st
    { ratio: 1, expectedHz: C4_HZ },
  ]) {
    if (readings.length > 0) {
      await setParams(page, 's-vco', { ratio });
      await waitFrames(page, 15);
    }
    const { modulator, primary } = await readLegs();
    readings.push({ ratio, expectedHz, hz: measuredHz(modulator), primaryPeak: mean(primary.peak) });
  }

  const report = readings
    .map((r) => `ratio ${r.ratio} → ${r.hz.toFixed(1)} Hz (expected ${r.expectedHz.toFixed(1)} Hz)`)
    .join('; ');

  for (const r of readings) {
    expect(
      Math.abs(r.hz - r.expectedHz) / r.expectedHz,
      `MOD OUT frequency is wrong at ratio ${r.ratio}: measured ${r.hz.toFixed(1)} Hz, `
      + `contract says primary × ratio = ${r.expectedHz.toFixed(1)} Hz `
      + `(tolerance ${(HZ_TOLERANCE * 100).toFixed(0)}% relative, of which ~4.5% is `
      + `zero-crossing quantisation at C4). All readings: ${report}`,
    ).toBeLessThan(HZ_TOLERANCE);
    expect(
      r.primaryPeak,
      `the PRIMARY (out) fell silent at ratio ${r.ratio}: peak |sample| ${r.primaryPeak.toFixed(4)}. `
      + `Ratio must move the modulator without muting the voice. All readings: ${report}`,
    ).toBeGreaterThan(0.05);
  }
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
  // trace changes every frame regardless. It is that the HIGH-FREQUENCY
  // ENERGY (i.e. the FM sideband content, which is what Timbre sets) SWINGS
  // while the LFO runs and holds still when it does not. That is the
  // user-visible gesture the module exists for (LFO into TIMBRE), so a pass
  // here means the gesture works and not merely that something moved.
  const assertNoSkippedEdges = watchSkippedEdges(page);

  // NOTE THE SOURCE PORT. The LFO publishes `phase0` / `phase90` / `phase180`
  // / `phase270` and NO port called `out`; naming a port that does not exist
  // is how the previous version of this test ran with no cable at all.
  // `assertNoSkippedEdges` below is what makes that failure loud.
  //
  // The LFO spawns at depth 0 so the CONTROL leg is measured FIRST, from the
  // same page and the same patch, before any modulation is switched on.
  await spawnPatch(
    page,
    [
      { id: 's-vco', type: 'swolevco', domain: 'audio', position: { x: 60, y: 60 },
        params: { timbre: 0.5, symmetry: 0.5, fold: 0, ratio: 2 } },
      { id: 'lfo', type: 'lfo', domain: 'audio', position: { x: 60, y: 380 },
        params: { rate: LFO_RATE_HZ, shape: 0, depth: 0 } },
      { id: 'sc', type: 'scope', domain: 'audio', position: { x: 560, y: 60 } },
    ],
    [
      { id: 'e1', from: { nodeId: 's-vco', portId: 'out' }, to: { nodeId: 'sc', portId: 'ch1' },
        sourceType: 'audio', targetType: 'audio' },
      { id: 'e2', from: { nodeId: 'lfo', portId: 'phase0' }, to: { nodeId: 's-vco', portId: 'timbre' },
        sourceType: 'cv', targetType: 'cv' },
    ],
  );
  assertNoSkippedEdges();
  const fillFrames = await waitScopeFilled(page, 'ch1');

  // NEGATIVE CONTROL FIRST, in the same page and the same patch: the cable is
  // connected and carries no modulation. Whatever residual jitter the
  // instrument has shows up HERE, so the comparison is against this run's own
  // noise floor rather than a hand-tuned constant — and any cold-start
  // artefact that survives `waitScopeFilled` inflates the CONTROL, which can
  // only make this test harder to pass. Without this ordering, "the CV works"
  // and "the first sample was taken too early" are indistinguishable: that is
  // precisely how the previous version reported a 24× separation with the
  // cable disconnected.
  const control = await sampleScope(page, 'ch1', SAMPLES_PER_LEG);
  const controlSd = sd(control.hfRatio);

  await setParams(page, 'lfo', { depth: 1 });
  await waitFrames(page, 10);
  const modulated = await sampleScope(page, 'ch1', SAMPLES_PER_LEG);
  const modulatedSd = sd(modulated.hfRatio);

  const detail =
    `hfRatio (dimensionless: RMS of the 2nd difference ÷ RMS) over ${modulated.samples} `
    + `windows of ${modulated.windowLength} samples @ ${modulated.sampleRate} Hz. `
    + `MODULATED sd=${modulatedSd.toFixed(6)} mean=${mean(modulated.hfRatio).toFixed(6)} `
    + `(${Math.round(modulated.elapsedMs)} ms wall) vs DEPTH-0 CONTROL `
    + `sd=${controlSd.toFixed(6)} mean=${mean(control.hfRatio).toFixed(6)} `
    + `(${control.samples} windows, ${Math.round(control.elapsedMs)} ms wall). `
    + `Scope ring filled after ${fillFrames} frames.`;

  // A dead CV path reads as modulatedSd ≈ controlSd — that was #1661, peak
  // |Δsample| exactly 0.0000e+0. MEASURED on this patch: a live cable
  // separates 53×, and the previous version's non-existent `lfo.out` cable
  // separates 0.95×. The 8× bar sits an order of magnitude above the dead
  // path and well under the live one.
  expect(
    modulatedSd,
    `LFO → timbre did not swing the FM sideband content. ${detail} A dead CV path `
    + `reads as modulatedSd ≈ controlSd (measured 0.95× with the cable removed; `
    + `53× with it connected).`,
  ).toBeGreaterThan(controlSd * 8);

  // Absolute floor, so a collapsed instrument (both legs → 0, e.g. a frozen
  // analyser) cannot satisfy the ratio above by dividing two noise numbers.
  // Measured: control 0.000049, modulated 0.002590.
  expect(
    modulatedSd,
    `the modulated leg has no absolute swing at all, which reads as a frozen or `
    + `silent instrument rather than an unmodulated one. ${detail}`,
  ).toBeGreaterThan(0.0005);
});
