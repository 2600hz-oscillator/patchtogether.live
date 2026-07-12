// art/scenarios/tidy-vco/profile.test.ts
//
// AUDIO PROFILE for TIDY VCO (id `tidyVco` — the flagship VA subtractive
// voice: 2 polyBLEP morph oscillators + sub → nonlinear ZDF diode ladder
// @2× oversampling → dual RC-punch ADSRs → OTA VCA → stereo). Ships with
// the module per the audio-profile gate: every new audio def lands with
// ≥1 committed baseline.
//
// Category: gated poly/mono SOURCE. Driver: a 3-phrase program over 3.0 s
// that is MUSICALLY REPRESENTATIVE — it exercises the filter-EG sweep,
// the poly chord bus, the resonance squelch + drive, and the stereo
// unison, so the pinned golden covers the voice's corners, not one
// default note:
//
//   phrase 1 @ 0.00 s — MONO A2, shipping defaults (FOLD 0 = folder
//                        BYPASSED, so this phrase also pins the unchanged
//                        default voice), WIDTH 0.7: the 2-voice unison
//                        stereo beat + the default filter-EG pluck sweep.
//                        Gate off at 0.70 s.
//   phrase 2 @ 1.00 s — POLY C4/E4/G4 chord (lanes 0-2), res 0.6,
//                        cutoff 1200, FOLD 0.6 + SYM +0.4: the squelchy
//                        chord stab with the WIDTH pan fan, now folded
//                        (stereo decorrelation + asymmetric even harmonics).
//                        Gates off at 1.80 s.
//   phrase 3 @ 2.10 s — MONO A1 acid stab: res 0.92 (deep squelch just
//                        under self-osc), drive 0.8, env +0.9, short decay,
//                        FOLD 0.85 + SYM −0.5 (heavy asymmetric fold INTO
//                        the ladder — the West-Coast timbre voice). Gate off
//                        at 2.60 s.
//
// Param changes land at exact sample indexes (deterministic; the pure
// core has no smoothing — the worklet's block smoother is a wrapper
// concern, not part of the pinned per-sample math). BOTH stereo outputs
// are captured: out_l/out_r differ by construction (unison pan in phrase
// 1, the chord pan fan in phrase 2) and the pin proves the stereo story.
//
// The .sha pin covers the worklet entry AND every lib the per-sample math
// flows through (tidy-vco-dsp + its dsp-utils / oversample imports), so a
// coefficient change in ANY of them forces an intentional
// `task art:update` re-capture. Re-pin the .sha LAST (memory
// `art-sha-pin-regenerate-last`).

import { describe, expect, it } from 'vitest';
import {
  TIDY_VCO_DEFAULTS,
  makeTidyVcoState,
  renderTidyVco,
  type TidyVcoBus,
  type TidyVcoParams,
} from '../../../packages/dsp/src/lib/tidy-vco-dsp';
import { dspSourceSha, pinAll, SAMPLE_RATE } from '../../setup/capture';

const SR = SAMPLE_RATE;
const DURATION_S = 3.0;
const N = Math.round(SR * DURATION_S);

const A2 = Math.log2(110 / 261.626);
const A1 = A2 - 1;

interface Segment {
  from: number; // sample index (inclusive)
  to: number; // sample index (exclusive)
  params?: Partial<TidyVcoParams>;
  poly?: number[]; // 10-lane snapshot
  monoPitch?: number;
  monoGate?: number;
}

/** The 3-phrase program (see header). Segments apply at exact samples. */
const SEGMENTS: readonly Segment[] = [
  // phrase 1 — mono unison pluck (defaults, WIDTH 0.7)
  { from: 0, to: Math.round(0.7 * SR), params: { width: 0.7 }, monoPitch: A2, monoGate: 1 },
  { from: Math.round(0.7 * SR), to: Math.round(1.0 * SR), monoPitch: A2, monoGate: 0 },
  // phrase 2 — poly chord stab (res 0.6, cutoff 1200)
  {
    from: Math.round(1.0 * SR),
    to: Math.round(1.8 * SR),
    params: { res: 0.6, cutoff: 1200, width: 0.7, fold: 0.6, sym: 0.4 },
    poly: [0, 1, 4 / 12, 1, 7 / 12, 1, 0, 0, 0, 0],
  },
  {
    from: Math.round(1.8 * SR),
    to: Math.round(2.1 * SR),
    poly: [0, 0, 4 / 12, 0, 7 / 12, 0, 0, 0, 0, 0],
  },
  // phrase 3 — mono acid stab (deep squelch + drive)
  {
    from: Math.round(2.1 * SR),
    to: Math.round(2.6 * SR),
    params: { res: 0.92, drive: 0.8, env: 0.9, fdec: 0.18, fsus: 0, cutoff: 700, width: 0.4, fold: 0.85, sym: -0.5 },
    monoPitch: A1,
    monoGate: 1,
  },
  { from: Math.round(2.6 * SR), to: N, monoPitch: A1, monoGate: 0 },
];

const BLOCK = 128;

/** Render the 3-phrase program through the pure core (block-driven, the
 *  worklet's own granularity). */
function renderProfile(): Record<string, Float32Array> {
  const p: TidyVcoParams = { ...TIDY_VCO_DEFAULTS };
  const st = makeTidyVcoState();
  const outL = new Float32Array(N);
  const outR = new Float32Array(N);
  const bus: TidyVcoBus = {
    poly: new Float32Array(10),
    monoPitch: 0,
    monoGate: 0,
    resCv: 0,
    driveCv: 0,
  };
  for (let i = 0; i < N; i += BLOCK) {
    const to = Math.min(i + BLOCK, N);
    const seg = SEGMENTS.find((s) => i >= s.from && i < s.to);
    if (seg) {
      if (seg.params) Object.assign(p, seg.params);
      (bus.poly as Float32Array).set(seg.poly ?? [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
      bus.monoPitch = seg.monoPitch ?? 0;
      bus.monoGate = seg.monoGate ?? 0;
    }
    renderTidyVco(p, bus, outL, outR, i, to, SR, st);
  }
  return { out_l: outL, out_r: outR };
}

function rms(b: Float32Array, s = 0, e = b.length): number {
  let x = 0;
  for (let i = s; i < e; i++) x += b[i]! * b[i]!;
  return Math.sqrt(x / Math.max(1, e - s));
}

describe('ART tidy-vco / audio profile (mono unison → poly chord → acid stab)', () => {
  it('renders a finite, audible, deterministic, truly-stereo phrase', () => {
    const { out_l, out_r } = renderProfile();
    const l = out_l!;
    const r = out_r!;
    expect(l.length).toBe(N);
    expect(l.every(Number.isFinite)).toBe(true);
    expect(r.every(Number.isFinite)).toBe(true);
    // Audible + true-peak bounded (the core ends in tanh, so |out| < 1).
    let peak = 0;
    for (const v of l) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeGreaterThan(0.15);
    expect(peak).toBeLessThan(1);
    // ALL three phrases landed.
    expect(rms(l, Math.round(0.1 * SR), Math.round(0.6 * SR)), 'mono pluck').toBeGreaterThan(0.02);
    expect(rms(l, Math.round(1.1 * SR), Math.round(1.7 * SR)), 'poly chord').toBeGreaterThan(0.02);
    expect(rms(l, Math.round(2.15 * SR), Math.round(2.5 * SR)), 'acid stab').toBeGreaterThan(0.02);
    // …and the gaps release.
    expect(rms(l, Math.round(0.95 * SR), Math.round(1.0 * SR))).toBeLessThan(0.02);
    // TRUE STEREO: the unison phrase differs between channels.
    let maxd = 0;
    for (let i = Math.round(0.2 * SR); i < Math.round(0.6 * SR); i++) {
      maxd = Math.max(maxd, Math.abs(l[i]! - r[i]!));
    }
    expect(maxd, 'unison L≠R').toBeGreaterThan(0.01);
    // DC ≈ 0 (the core's own 20 Hz DC block).
    let sum = 0;
    for (const v of l) sum += v;
    expect(Math.abs(sum / l.length)).toBeLessThan(0.01);
    // Deterministic: a second render is bit-identical.
    const again = renderProfile();
    let diff = 0;
    for (let i = 0; i < l.length; i++) diff = Math.max(diff, Math.abs(l[i]! - again.out_l![i]!));
    for (let i = 0; i < r.length; i++) diff = Math.max(diff, Math.abs(r[i]! - again.out_r![i]!));
    expect(diff).toBe(0);
  });

  it('pins the out_l/out_r profile baselines (SHA-gated)', async () => {
    const srcSha = await dspSourceSha(
      'tidy-vco.ts',
      'lib/tidy-vco-dsp.ts',
      'lib/dsp-utils.ts',
      'lib/oversample.ts',
    );
    await pinAll('tidy-vco', srcSha, renderProfile());
  });
});
