// art/scenarios/analog-vco/hard-sync.test.ts
//
// ART scenario for the ANALOG VCO HARD-SYNC (feat/analog-vco-sync).
//
// Patch under test: masterVco.sync_out → slaveVco.sync_in. The slave
// free-runs at a higher frequency than the master; each master cycle the
// master emits a one-sample sync pulse that hard-resets the slave's phase
// to 0 — producing the characteristic hard-sync timbre (the slave's tone
// re-pitches toward the master's fundamental with a bright, fixed-formant
// edge).
//
// node-web-audio-api cannot host the Faust AudioWorklet directly (same
// constraint documented in meowbox/voct-tracking + note-pitch + the saw-c4
// scenario), so we render the SLAVE'S synced SAW output from a faithful TS
// mirror of the exact per-sample recurrences in packages/dsp/src/analog-vco
// .dsp. The mirror is the load-bearing artifact; the source SHA pin asserts
// the baseline is regenerated whenever the .dsp changes (D17 / D19; memory:
// ART SHA-pin regenerate LAST).
//
// Coverage:
//   1. SHA matches between source and built artifact (DSP rebuild required).
//   2. A real .f32 baseline of the hard-synced slave saw (the characteristic
//      synced waveform) — RMS tier B against the committed baseline.
//   3. The synced slave waveform DIFFERS materially from the same slave
//      free-running (no sync) — the whole point of hard sync.
//   4. The synced slave's phase is forced to 0 on every master cycle pulse.
//   5. No NaN / Inf in the rendered output.

import { describe, expect, it } from 'vitest';
import {
  readBaseline,
  writeBaseline,
  readBaselineSha,
  writeBaselineSha,
  builtSha,
  moduleSourceSha,
  compareBuffers,
  SHOULD_UPDATE_BASELINES,
} from '../../setup/render';

const SR = 48000;
const DURATION_S = 0.5;
const frac = (x: number) => x - Math.floor(x);

// ── TS mirror of packages/dsp/src/analog-vco.dsp (sync path) ──
//   freqHz(pitch, fm)     = 261.626 * 2^(pitch + tune/12 + fine/1200 + fmAmount*fm)
//   syncEdge(sync)        = (sync > 0) & (sync' <= 0)
//   phasorReset(f, reset) = loop ~ _ ; loop(prev) = (1-reset)*frac(prev + f/SR)
//   saw(p)                = 2p - 1
//   syncPulse(pRaw)       = (pRaw < pRaw') * 1.0
// At the default knobs (tune=fine=fmAmount=pmAmount=0, no pitch CV) the
// frequency is just 261.626 * 2^0 = C4 for pitch 0; we pass an explicit
// V/oct so master and slave run at different pitches.
const C4 = 261.626;
const freqFromVolts = (volts: number) => {
  const f = C4 * Math.pow(2, volts);
  return Math.min(20000, Math.max(1, f));
};

interface SlaveRender {
  saw: Float32Array;     // slave's synced saw output
  phase: Float32Array;   // slave's phase (for the reset assertion)
  resets: number;        // count of hard-sync resets applied to the slave
}

/** Render master.sync_out → slave.sync_in for `n` samples and return the
 *  slave's saw output + phase + reset count. If `syncEnabled` is false the
 *  slave free-runs (sync_in held silent) — used for the differs-from-free
 *  assertion. */
function renderHardSync(masterVolts: number, slaveVolts: number, n: number, syncEnabled: boolean): SlaveRender {
  const fMaster = freqFromVolts(masterVolts);
  const fSlave = freqFromVolts(slaveVolts);
  const dM = fMaster / SR;
  const dS = fSlave / SR;

  const saw = new Float32Array(n);
  const phase = new Float32Array(n);
  let resets = 0;

  // Master phasor (un-synced) + its sync_out pulse train.
  let masterPhase = 0;
  let masterPrev = 0; // for wrap detection (pRaw')
  // Slave state.
  let slavePhase = 0;
  let syncPrev = 0; // for the slave's rising-edge detector (sync')

  for (let i = 0; i < n; i++) {
    // Advance master, then derive sync_out = phase wrapped down this sample.
    masterPhase = frac(masterPhase + dM);
    const masterSyncOut = masterPhase < masterPrev ? 1 : 0;
    masterPrev = masterPhase;

    // The slave's sync_in is the master's sync_out (or silence if disabled).
    const syncIn = syncEnabled ? masterSyncOut : 0;
    const reset = syncIn > 0 && syncPrev <= 0 ? 1 : 0;
    syncPrev = syncIn;
    if (reset) resets++;

    slavePhase = (1 - reset) * frac(slavePhase + dS);
    phase[i] = slavePhase;
    saw[i] = 2 * slavePhase - 1;
  }
  return { saw, phase, resets };
}

describe('analog-vco / hard-sync — toolchain', () => {
  it('SHA matches between source and built artifact (DSP rebuild required)', async () => {
    const srcSha = await moduleSourceSha('analog-vco');
    const built = await builtSha('analog-vco');
    expect(
      built,
      `Built analog-vco SHA (${built}) != source SHA (${srcSha}). Rebuild via \`task dsp:build\`.`,
    ).toBe(srcSha);
  });
});

describe('analog-vco / hard-sync — master.sync_out → slave.sync_in', () => {
  const scenarioId = 'analog-vco/hard-sync';
  // Master at C4 (0V), slave a fifth + an octave up (+1.583V ≈ G5) so the
  // free-run vs synced waveforms are clearly distinct.
  const MASTER_V = 0;
  const SLAVE_V = 1.5833; // ~G#5-ish; non-integer so it doesn't accidentally lock

  it('renders the hard-synced slave saw to a baseline (RMS tier B)', async () => {
    const n = Math.round(SR * DURATION_S);
    const { saw, resets } = renderHardSync(MASTER_V, SLAVE_V, n, true);
    // Sanity: the master (~261.6 Hz over 0.5 s ≈ 130 cycles) reset the slave
    // roughly that many times.
    expect(resets).toBeGreaterThan(120);
    expect(resets).toBeLessThan(140);

    const srcSha = await moduleSourceSha('analog-vco');
    const existing = await readBaseline(scenarioId);
    const existingSha = await readBaselineSha(scenarioId);

    if (SHOULD_UPDATE_BASELINES || !existing) {
      await writeBaseline(scenarioId, saw);
      await writeBaselineSha(scenarioId, srcSha);
      expect(true).toBe(true);
      return;
    }

    expect(
      existingSha,
      `Baseline SHA (${existingSha}) doesn't match source SHA (${srcSha}).\n` +
        `Run \`npm run art:update -w art\` if the change to analog-vco.dsp was intentional.`,
    ).toBe(srcSha);

    const cmp = compareBuffers(saw, existing, 'B');
    expect(cmp.pass, cmp.detail).toBe(true);
  });

  it('the hard-synced slave differs materially from the same slave free-running', async () => {
    const n = Math.round(SR * DURATION_S);
    const synced = renderHardSync(MASTER_V, SLAVE_V, n, true).saw;
    const free = renderHardSync(MASTER_V, SLAVE_V, n, false).saw;
    // RMS of the difference must be well above the tier-B noise floor — hard
    // sync visibly reshapes the slave waveform.
    const cmp = compareBuffers(synced, free, 'B');
    expect(
      cmp.pass,
      `synced and free-running slave are within tier B (rms ${cmp.rms}) — sync had no audible effect`,
    ).toBe(false);
    expect(cmp.rms).toBeGreaterThan(0.05);
  });

  it('the slave phase is forced to 0 on every master sync pulse', () => {
    const n = SR; // 1 s for a robust pulse count
    const fMaster = freqFromVolts(MASTER_V);
    const dM = fMaster / SR;
    const { phase } = renderHardSync(MASTER_V, SLAVE_V, n, true);
    // Recompute the master's sync_out independently and assert the slave's
    // phase is exactly 0 at each pulse.
    let mp = 0, mPrev = 0;
    let checked = 0;
    for (let i = 0; i < n; i++) {
      mp = frac(mp + dM);
      const pulse = mp < mPrev ? 1 : 0;
      mPrev = mp;
      if (pulse) {
        expect(phase[i], `slave phase not 0 at master pulse sample ${i}`).toBe(0);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(250); // ~261 pulses in 1 s
  });

  it('produces no NaN / Inf in the synced output', () => {
    const n = Math.round(SR * DURATION_S);
    const { saw } = renderHardSync(MASTER_V, SLAVE_V, n, true);
    const bad = saw.findIndex((v) => !Number.isFinite(v));
    expect(bad, `non-finite sample at index ${bad}`).toBe(-1);
  });
});
