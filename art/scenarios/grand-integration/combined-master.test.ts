// art/scenarios/grand-integration/combined-master.test.ts
//
// THE offline, deterministic, byte-stable "combined-master" ART for the
// GRAND-INTEGRATION scenario (.myrobots/plans/grand-integration-e2e-art-2026-07-
// 19.md §7). This is the DETERMINISTIC AUDIO PIN (owner-confirmed) — NOT
// recorderbox: an H.264/AAC (or even raw-PCM real-time) capture is
// encoder-/jitter-dependent and cannot be a `.sha` baseline, whereas this
// fixed-SR / 128-block / no-event-loop offline render is bit-reproducible.
//
// It replays the ONE shared clip fixture (e2e/fixtures/grand-integration/clips.ts
// — the SAME file the browser attest spec seeds) through the pure clip driver
// (art/setup/clip-driver.ts, which reuses the real clip step math), then sums the
// FOUR instruments' pure-TS DSP cores into one combined master:
//
//   ch1 kickdrum (trigger)  +  ch2 snaredrum (trigger)
//   +  ch3 tidyVco (MONO, with the seeded CUTOFF automation played back)
//   +  ch4 sixstrum (poly chords)
//
// Runs on the NORMAL CI ART lane (no GPU, no encoder, bit-stable). Because the
// four cores are already in the ART/DSP source basis, a change to any of them
// correctly forces BOTH an ART re-pin AND (via scripts/grand-attest-lib.ts) a
// grand re-attest — the desired coupling. Re-pin the `.sha` LAST (memory
// `art-sha-pin-regenerate-last`); confirm ONLY `.sha` moved on a pure re-pin.

import { describe, expect, it } from 'vitest';

import {
  KICKDRUM_P1_DEFAULTS,
  kickdrumStepStereo,
  makeKickdrumState,
} from '../../../packages/dsp/src/lib/kickdrum-dsp';
import {
  SNAREDRUM_DEFAULTS,
  makeSnaredrumState,
  snaredrumStepStereo,
} from '../../../packages/dsp/src/lib/snaredrum-dsp';
import {
  TIDY_VCO_DEFAULTS,
  makeTidyVcoState,
  renderTidyVco,
  type TidyVcoBus,
  type TidyVcoParams,
} from '../../../packages/dsp/src/lib/tidy-vco-dsp';
import {
  SIXSTRUM_DEFAULTS,
  SS_STRINGS,
  makeSixStrumState,
  prepSixStrumBlock,
  sixStrumStep,
  type SixStrumFrame,
  type SixStrumParams,
} from '../../../packages/dsp/src/lib/sixstrum-dsp';
import { captureOutputs, pinAll, repoSourceSha, SAMPLE_RATE } from '../../setup/capture';
import { renderClipSchedule } from '../../setup/clip-driver';
import {
  GRAND_AUTO,
  GRAND_BPM,
  GRAND_CLIP_IDX,
  GRAND_CLIPS,
  GRAND_STEP_DIV_INDEX,
  GRAND_TIDY_CUTOFF_KEY,
  grandDenormCutoff,
} from '../../../e2e/fixtures/grand-integration/clips';

const SR = SAMPLE_RATE;
const DURATION_S = 1.6; // ~5 four-step loops @ 200 bpm (loop ≈ 0.30 s)
const N = Math.round(SR * DURATION_S);
const BLOCK = 128;

/** Slot-0 clip index each lane plays in the combined render. */
const LANE_CLIPS = {
  kick: GRAND_CLIP_IDX.kick[0],
  snare: GRAND_CLIP_IDX.snare[0],
  tidy: GRAND_CLIP_IDX.tidy[0],
  sixstrum: GRAND_CLIP_IDX.sixstrum[0],
};

/** Build the shared clip schedule once (pure — reused across renders). */
function schedule() {
  return renderClipSchedule({
    clips: GRAND_CLIPS,
    auto: GRAND_AUTO,
    laneClips: LANE_CLIPS,
    bpm: GRAND_BPM,
    stepDivIndex: GRAND_STEP_DIV_INDEX,
    sampleRate: SR,
    durationS: DURATION_S,
    polyVoices: SS_STRINGS,
    tidyCutoffClipIdx: LANE_CLIPS.tidy,
    tidyCutoffKey: GRAND_TIDY_CUTOFF_KEY,
    defaultCutoffNorm: 0.5,
  });
}

function makeSixFrame(): SixStrumFrame {
  return {
    strum: new Float32Array(SS_STRINGS),
    mute: new Float32Array(SS_STRINGS),
    polyPitch: new Float32Array(SS_STRINGS),
    polyGate: new Float32Array(SS_STRINGS),
    accent: 0.6,
  };
}

/**
 * Render the combined master: pre-render the block-driven tidy core, then sum
 * the per-sample kick + snare + tidy + sixstrum into one mono `combined-master`.
 * Deterministic by construction (each core's strike resets phase + reseeds its
 * PRNG; every driver frame is epoch-pinned to sample 0).
 */
function renderCombined(): Record<string, Float32Array> {
  const f = schedule();

  // (a) tidy — block-driven (renderTidyVco writes a whole [i,to) span). Cutoff
  //     is set per block from the automation frame at the block boundary (the
  //     worklet's own block-rate control granularity).
  const tp: TidyVcoParams = { ...TIDY_VCO_DEFAULTS };
  const tst = makeTidyVcoState();
  const tidyL = new Float32Array(N);
  const tidyR = new Float32Array(N);
  const bus: TidyVcoBus = {
    poly: new Float32Array(10),
    monoPitch: 0,
    monoGate: 0,
    resCv: 0,
    driveCv: 0,
  };
  for (let i = 0; i < N; i += BLOCK) {
    const to = Math.min(i + BLOCK, N);
    bus.monoPitch = f.tidyPitch[i]!;
    bus.monoGate = f.tidyGate[i]!;
    tp.cutoff = grandDenormCutoff(f.tidyCutoffNorm[i]!);
    renderTidyVco(tp, bus, tidyL, tidyR, i, to, SR, tst);
  }

  // (b) kick / snare / sixstrum — per-sample; sum with the pre-rendered tidy L.
  const kp = { ...KICKDRUM_P1_DEFAULTS };
  const kst = makeKickdrumState();
  const klr = new Float32Array(2);
  const sp = { ...SNAREDRUM_DEFAULTS };
  const sst = makeSnaredrumState();
  const slr = new Float32Array(2);
  const xp: SixStrumParams = { ...SIXSTRUM_DEFAULTS, polyConnected: 1 };
  const xst = makeSixStrumState(SR);
  const xframe = makeSixFrame();

  return captureOutputs({ durationS: DURATION_S, outputs: ['combined-master'], sampleRate: SR }, (i) => {
    kickdrumStepStereo(f.kickTrig[i]!, 0, kp, SR, kst, klr);
    snaredrumStepStereo(f.snareTrig[i]!, 0, 0, sp, SR, sst, slr);
    if (i % BLOCK === 0) prepSixStrumBlock(xp, 60, SR, xst); // chord root C4
    for (let n = 0; n < SS_STRINGS; n++) {
      xframe.polyPitch[n] = f.sixPitch[n]![i]!;
      xframe.polyGate[n] = f.sixGate[n]![i]!;
    }
    const six = sixStrumStep(xframe, xp, SR, xst);
    return { 'combined-master': klr[0]! + slr[0]! + tidyL[i]! + six };
  });
}

function rms(b: Float32Array, s = 0, e = b.length): number {
  let x = 0;
  for (let i = s; i < e; i++) x += b[i]! * b[i]!;
  return Math.sqrt(x / Math.max(1, e - s));
}

describe('ART grand-integration / combined master (kick+snare+tidy+sixstrum)', () => {
  it('renders a finite, audible, deterministic combined stream driven by the shared fixture', () => {
    const { 'combined-master': buf } = renderCombined();
    expect(buf!.length).toBe(N);
    expect(buf!.every(Number.isFinite)).toBe(true);

    // Audible overall energy (four instruments summed).
    let peak = 0;
    for (const v of buf!) peak = Math.max(peak, Math.abs(v));
    expect(peak, 'combined master is audible').toBeGreaterThan(0.2);
    // Bounded — every core ends in a soft ceiling; the sum of four is finite and
    // well under a runaway (loose upper bound, not a mix-gain assertion).
    expect(peak).toBeLessThan(12);

    // Energy is present across the whole render (all lanes loop continuously —
    // no long silent gap once the transport is running).
    const win = Math.round(0.1 * SR);
    let minWin = Infinity;
    for (let w = 0; w + win <= N; w += win) minWin = Math.min(minWin, rms(buf!, w, w + win));
    expect(minWin, 'no silent gap across the running loops').toBeGreaterThan(1e-3);

    // Deterministic: a second render is BIT-identical (the pin's precondition).
    const again = renderCombined()['combined-master']!;
    let diff = 0;
    for (let i = 0; i < N; i++) diff = Math.max(diff, Math.abs(buf![i]! - again[i]!));
    expect(diff, 'combined render is bit-identical across runs').toBe(0);
  });

  it('pins the combined-master baseline (SHA-gated, RMS tier B)', async () => {
    // Combined source SHA over EVERY file whose per-sample math the combined
    // render flows through: the four cores + their sub-libs, the pure clip step
    // math, the shared fixture, and the driver. A change in ANY forces an
    // intentional `task art:update` re-capture. Re-pin `.sha` LAST.
    const srcSha = await repoSourceSha(
      // instrument cores + their sub-libs (the union of the four profiles' pins)
      'packages/dsp/src/lib/kickdrum-dsp.ts',
      'packages/dsp/src/lib/snaredrum-dsp.ts',
      'packages/dsp/src/lib/snare-roll-dsp.ts',
      'packages/dsp/src/lib/tidy-vco-dsp.ts',
      'packages/dsp/src/lib/sixstrum-dsp.ts',
      'packages/dsp/src/lib/sixstrum-tuning.ts',
      'packages/dsp/src/lib/karplus-dsp.ts',
      'packages/dsp/src/lib/analog-delay-core.ts',
      'packages/dsp/src/lib/adsr-env.ts',
      'packages/dsp/src/lib/moog-vco-dsp.ts',
      'packages/dsp/src/lib/dsp-utils.ts',
      'packages/dsp/src/lib/oversample.ts',
      'packages/dsp/src/lib/rbj-biquad.ts',
      // pure clip step math + the shared fixture + the driver
      'packages/web/src/lib/audio/modules/clip-types.ts',
      'packages/web/src/lib/audio/modules/clip-clock.ts',
      'e2e/fixtures/grand-integration/clips.ts',
      'art/setup/clip-driver.ts',
    );
    // Tier B, but a slightly RELAXED threshold (1e-3, vs the 1e-4 default): the
    // combined master SUMS four independent DSP cores, so each core's tiny
    // cross-platform libm drift (Math.sin/exp/tanh/pow differ in the last ULPs
    // between the macOS machine that generates the baseline and the Linux CI that
    // compares it) ACCUMULATES across the sum. 1e-3 RMS on a ~0.3-RMS signal is
    // still ≈ −50 dB — it catches any real DSP change (which moves the render by
    // ≫ 1e-3) while tolerating platform float drift, avoiding the local-passes-
    // CI-fails trap (CLAUDE.md: capability/renderer-dependent numerics).
    await pinAll('grand-integration', srcSha, renderCombined(), { threshold: 1e-3 });
  });
});
