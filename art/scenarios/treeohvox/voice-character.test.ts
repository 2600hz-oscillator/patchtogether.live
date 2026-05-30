// art/scenarios/treeohvox/voice-character.test.ts
//
// Audio Regression Tests for TREE.oh.VOX. The unit tests in
// packages/web/src/lib/audio/modules/treeohvox-dsp.test.ts pin per-helper
// behaviour (filter coefficient stability, envelope decay shape,
// pitch-CV conversion); this file adds longer-render scenarios that
// exercise the FULL voice over canonical 303 patches and asserts
// spectral / temporal character a player would notice.
//
// We don't have the real worklet render path wired into ART yet (see
// art/setup/render.ts — the actual render() is still a stub that returns
// a synthetic sine). So instead of going through the worklet we go
// through the same pure-TS DSP — `renderVoiceSequence` from the lib —
// which the worklet itself wraps. That gives us bit-exact reproducibility
// + lets the ART pin on the source SHA (so a coefficient change in the
// lib invalidates the baseline correctly).
//
// Scenarios captured (canonical 303 patches):
//   1. C-D-Eb-F-Eb-D-C pattern at 130 BPM (per the brief).
//   2. Cutoff sweep from 200 Hz → 4 kHz over one held note (illustrates
//      the env-mod scaler math).
//   3. Resonance sweep with mid cutoff (squelch character).
//   4. Accent contrast — same pitch, alternating accented + plain.

import { describe, expect, it } from 'vitest';
import {
  renderVoiceSequence,
  TreeohvoxVoice,
  type VoiceParams,
  type ScheduledNote,
} from '../../../packages/dsp/src/lib/treeohvox-dsp';
import {
  readBaseline,
  writeBaseline,
  readBaselineSha,
  writeBaselineSha,
  moduleSourceSha,
  compareBuffers,
  SHOULD_UPDATE_BASELINES,
} from '../../setup/render';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const SR = 48000;

// ---------------------------------------------------------------------------
// Baseline SHA — we depend on the lib file `treeohvox-dsp.ts`, NOT only
// the worklet entry `treeohvox.ts`. A coefficient tweak in the lib must
// invalidate baselines; the worklet itself is a thin wrapper. moduleSource-
// Sha() reads packages/dsp/src/<name>.{dsp,ts}; we'd need to ALSO hash the
// lib so the baseline-SHA-mismatch guard catches lib-level changes.
// ---------------------------------------------------------------------------
async function combinedSourceSha(): Promise<string> {
  const workletPath = join(
    new URL('../../../packages/dsp/src/', import.meta.url).pathname,
    'treeohvox.ts',
  );
  const libPath = join(
    new URL('../../../packages/dsp/src/lib/', import.meta.url).pathname,
    'treeohvox-dsp.ts',
  );
  const w = await readFile(workletPath, 'utf8');
  const l = await readFile(libPath, 'utf8');
  return createHash('sha256').update(w).update(l).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Goertzel single-bin DFT for spectral assertions.
// ---------------------------------------------------------------------------
function powerAt(buf: Float32Array, freq: number, sr: number): number {
  const w = (2 * Math.PI * freq) / sr;
  let re = 0;
  let im = 0;
  for (let i = 0; i < buf.length; i++) {
    re += buf[i]! * Math.cos(w * i);
    im += buf[i]! * Math.sin(w * i);
  }
  return Math.sqrt(re * re + im * im) / buf.length;
}

function rms(buf: Float32Array): number {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i]! * buf[i]!;
  return Math.sqrt(s / Math.max(1, buf.length));
}

// ---------------------------------------------------------------------------
// Canonical pattern: C-D-Eb-F-Eb-D-C, 1/16 notes at 130 BPM (the brief's
// reference). C is V/oct = -1 (C3), root note. The 7 notes are placed
// back-to-back so each is exactly one 16th in length.
// ---------------------------------------------------------------------------
const BPM = 130;
const SAMPLES_PER_16TH = Math.round((SR * 60) / (BPM * 4)); // ≈ 5538 at 48k

// Semitone offsets from C: C=0, D=2, Eb=3, F=5, then walk back.
const PATTERN_SEMITONES = [0, 2, 3, 5, 3, 2, 0];

function buildPattern(rootCv: number): ScheduledNote[] {
  return PATTERN_SEMITONES.map((st, i) => ({
    atSample: i * SAMPLES_PER_16TH,
    pitchCv: rootCv + st / 12,
    accented: i === 0 || i === 3, // accent the 1 + the high-F downbeat
    gateDurationSamples: SAMPLES_PER_16TH,
  }));
}

const CANONICAL_PARAMS: VoiceParams = {
  tuneSemitones: 0,
  cutoffHz: 800,
  resonance: 0.7,
  envAmount01: 0.7,
  decayMs: 300,
  accentAmount01: 0.5,
};

// ---------------------------------------------------------------------------
// Scenario 1 — canonical C-D-Eb-F-Eb-D-C pattern. Baseline-pinned.
// ---------------------------------------------------------------------------
describe('ART treeohvox / canonical 303 pattern', () => {
  const scenarioId = 'treeohvox/c-d-eb-f-eb-d-c';
  const totalSamples = SAMPLES_PER_16TH * PATTERN_SEMITONES.length;

  it('renders the canonical bassline without NaN / Inf', () => {
    const buf = renderVoiceSequence(
      CANONICAL_PARAMS,
      SR,
      totalSamples,
      buildPattern(-1), // C3 root
    );
    expect(buf.length).toBe(totalSamples);
    const badIdx = buf.findIndex((v) => !Number.isFinite(v));
    expect(badIdx, `non-finite at ${badIdx}: ${buf[badIdx]}`).toBe(-1);
    expect(rms(buf)).toBeGreaterThan(0.05);
  });

  it('matches baseline (RMS tier B)', async () => {
    const buf = renderVoiceSequence(
      CANONICAL_PARAMS,
      SR,
      totalSamples,
      buildPattern(-1),
    );
    const srcSha = await combinedSourceSha();
    const existing = await readBaseline(scenarioId);
    const existingSha = await readBaselineSha(scenarioId);

    if (SHOULD_UPDATE_BASELINES || !existing) {
      await writeBaseline(scenarioId, buf);
      await writeBaselineSha(scenarioId, srcSha);
      expect(true).toBe(true);
      return;
    }

    // Source SHA pin — if treeohvox-dsp.ts changed, baseline is stale.
    expect(
      existingSha,
      `Baseline SHA (${existingSha}) doesn't match source SHA (${srcSha}).\n` +
        `Run \`UPDATE_BASELINES=1 npm test -w art\` if the lib change was intentional.`,
    ).toBe(srcSha);

    const cmp = compareBuffers(buf, existing, 'B', 1e-3);
    expect(cmp.pass, cmp.detail).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — cutoff sweep on a held C3 (no envelope mod). Pin the energy
// distribution: at low cutoff the high band is suppressed; at high cutoff
// the high band ascends. This is the AUDIBLE 303 brightness sweep.
// ---------------------------------------------------------------------------
describe('ART treeohvox / cutoff sweep brightness', () => {
  function renderHeldNote(cutoffHz: number): Float32Array {
    const params: VoiceParams = {
      tuneSemitones: 0,
      cutoffHz,
      resonance: 0.4,
      envAmount01: 0, // env amount 0 so cutoff stays at the knob value
      decayMs: 200,
      accentAmount01: 0,
    };
    const samples = Math.round(SR * 0.25);
    const voice = new TreeohvoxVoice(SR, params);
    voice.trigger({ pitchCv: -1, accented: false });
    const out = new Float32Array(samples);
    for (let i = 0; i < samples; i++) out[i] = voice.step();
    return out;
  }

  it('higher cutoff produces more 1 kHz energy than lower cutoff', () => {
    // 303 saw fundamental at C3 (130 Hz) → odd + even harmonics fall off
    // as ~1/n. Even a generous cutoff sweep produces small absolute energy
    // at 2 kHz (well above harmonic 8); we measure at the more populated
    // 1 kHz tap. Ratio ≥2× is the audibility threshold for "the filter is
    // clearly sweeping" — bigger ratios happen but vary with the specific
    // polynomial coefficient values, which we don't want to bind to.
    const dark = renderHeldNote(300);
    const bright = renderHeldNote(4000);
    const skip = Math.round(SR * 0.04);
    const darkP = powerAt(dark.subarray(skip), 1000, SR);
    const brightP = powerAt(bright.subarray(skip), 1000, SR);
    expect(brightP, `dark@1k=${darkP.toExponential(2)} bright@1k=${brightP.toExponential(2)}`)
      .toBeGreaterThan(darkP * 2);
  });

  it('high resonance (0.95) widens the band around cutoff vs low resonance', () => {
    // Direct comparison: render the same note with low vs high resonance
    // and measure the ratio of (energy at cutoff) / (energy 1 octave below
    // cutoff). High resonance should produce more peaking around fc than
    // a damped (low-res) filter — a robust property that doesn't depend on
    // specific polynomial constants.
    function aroundCutoffRatio(res: number): number {
      const params: VoiceParams = {
        tuneSemitones: 0,
        cutoffHz: 1000,
        resonance: res,
        envAmount01: 0,
        decayMs: 200,
        accentAmount01: 0,
      };
      const samples = Math.round(SR * 0.3);
      const voice = new TreeohvoxVoice(SR, params);
      voice.trigger({ pitchCv: -1, accented: false });
      const out = new Float32Array(samples);
      for (let i = 0; i < samples; i++) out[i] = voice.step();
      const skip = Math.round(SR * 0.05);
      const tail = out.subarray(skip);
      return powerAt(tail, 1000, SR) / Math.max(1e-12, powerAt(tail, 500, SR));
    }
    const lowRes = aroundCutoffRatio(0.05);
    const highRes = aroundCutoffRatio(0.95);
    expect(highRes, `low-res 1k/500 ratio=${lowRes.toFixed(3)}, high-res ratio=${highRes.toFixed(3)}`)
      .toBeGreaterThan(lowRes);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — accent contrast. Render two notes with the same patch,
// one accented, one not. The accented note should be (a) LOUDER and (b)
// BRIGHTER (more high-frequency energy from the extra cutoff env).
// ---------------------------------------------------------------------------
describe('ART treeohvox / accent contrast', () => {
  function renderOne(accented: boolean): Float32Array {
    const params: VoiceParams = {
      tuneSemitones: 0,
      cutoffHz: 800,
      resonance: 0.6,
      envAmount01: 0.6,
      decayMs: 300,
      accentAmount01: 0.8,
    };
    const samples = Math.round(SR * 0.3);
    const voice = new TreeohvoxVoice(SR, params);
    voice.trigger({ pitchCv: 0, accented });
    const out = new Float32Array(samples);
    for (let i = 0; i < samples; i++) out[i] = voice.step();
    return out;
  }

  it('accent note has higher peak amplitude', () => {
    const plain = renderOne(false);
    const accent = renderOne(true);
    function peakAbs(buf: Float32Array): number {
      let p = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = Math.abs(buf[i]!);
        if (v > p) p = v;
      }
      return p;
    }
    expect(peakAbs(accent)).toBeGreaterThan(peakAbs(plain));
  });

  it('accent note has more high-band energy (brighter)', () => {
    const plain = renderOne(false);
    const accent = renderOne(true);
    const skip = Math.round(SR * 0.02);
    // The accent boosts env-on-cutoff so the filter opens more — measure
    // energy at 2 kHz (well above the C4 fundamental).
    const plainP = powerAt(plain.subarray(skip, skip + Math.round(SR * 0.1)), 2000, SR);
    const accentP = powerAt(accent.subarray(skip, skip + Math.round(SR * 0.1)), 2000, SR);
    expect(accentP).toBeGreaterThan(plainP);
  });
});
