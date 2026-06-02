// art/scenarios/analog-vco/fm-sync-model.test.ts
//
// ART scenario validating the ANALOG VCO FM×SYNC INTERACTION MODEL.
//
// Setup (per the validation spec): two Analog VCOs.
//   VCO A = sine carrier.
//   VCO B = morphing sine→square→saw modulator.
//   B's audio output → A's FM input.
//   sync_out = a once-per-cycle phase-wrap reset pulse.
//   sync_in  = a hard phase reset on a rising edge.
//
// Four configurations are captured to real .f32 baselines + asserted against
// the model's qualitative signature:
//
//   Config 1 — B→FM A, no sync: A stays sinusoidal in SHAPE but its cycle
//     lengths stretch/compress (phase-velocity FM). Low depth = vibrato; higher
//     = FM sidebands; B morph square→saw richens A's spectrum.
//   Config 2 — B sync→A + B→FM A (B master): every B cycle hard-resets A; A's
//     period LOCKS to B's; FM colours it.
//   Config 3 — A sync→B + B→FM A (feedback): B FMs A, A resets B → coupled
//     feedback; non-degenerate, more complex than Config 2.
//   Config 4 — mutual sync (A↔B) + B→FM A: coupled nonlinear oscillators.
//
// DIGITAL CAVEAT (the load-bearing design): a naive SAME-SAMPLE mutual/feedback
// reset deadlocks both phases to 0 (silence) and is order-dependent. We model a
// 1-SAMPLE SYNC-PROPAGATION DELAY: a sync pulse emitted at sample n resets the
// OTHER oscillator on sample n+1, never the same sample. This breaks the
// symmetry so configs 3 & 4 are DETERMINISTIC and produce real coupled
// pulling/locking instead of silence. (In the live engine the same one-sample
// separation arises naturally from AudioNode block buffering; here we make it
// explicit + deterministic.)
//
// node-web-audio-api can't host the Faust worklet, so — as with the saw-c4 /
// hard-sync scenarios — we render from a faithful TS mirror of the exact
// per-sample recurrences in packages/dsp/src/analog-vco.dsp. The source SHA pin
// asserts the baseline is regenerated whenever the .dsp changes (memory: ART
// SHA-pin regenerate LAST).

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
const C4 = 261.626;
const DURATION_S = 0.5;
const frac = (x: number) => x - Math.floor(x);

// ── TS mirror of packages/dsp/src/analog-vco.dsp shape primitives ──
const sn = (p: number) => Math.sin(2 * Math.PI * p);
const sawTap = (p: number) => 2 * p - 1;
const sqr = (p: number, pw: number) => (p < pw ? 1 : -1);
function morph(p: number, shape: number, pw = 0.5): number {
  if (shape < 0.5) {
    const lo = 2 * shape;
    return sn(p) * lo + sawTap(p) * (1 - lo);
  }
  const hi = 2 * shape - 1;
  return sqr(p, pw) * hi + sn(p) * (1 - hi);
}
// freqHz(volts, fmAmount, fm) = 261.626 * 2^(volts + fmAmount*fm), clamped.
const freqHz = (volts: number, fmAmount: number, fm: number) =>
  Math.min(20000, Math.max(1, C4 * Math.pow(2, volts + fmAmount * fm)));

interface TwoVcoOpts {
  aV?: number;        // VCO A V/oct (carrier)
  bV?: number;        // VCO B V/oct (modulator)
  bShape?: number;    // B morph position: 0=saw, 0.5=sine, 1=square
  fmDepth?: number;   // A's fmAmount (B audio → A FM)
  aSyncB?: boolean;   // A.sync_out → B.sync_in
  bSyncA?: boolean;   // B.sync_out → A.sync_in
}

interface TwoVcoRender {
  a: Float32Array;      // VCO A output (sine carrier)
  b: Float32Array;      // VCO B output (morph)
  aFreq: Float32Array;  // A's instantaneous frequency (Hz) per sample
}

/**
 * Render the two-VCO patch for `n` samples.
 *
 * Implements the 1-sample sync-propagation delay: each oscillator's sync_out
 * pulse (raw-phase wrap) is LATCHED and applied as the OTHER oscillator's reset
 * on the NEXT sample (`pendingReset*`). B's audio FMs A using B's PREVIOUS
 * sample (same one-sample separation) so there is no same-sample algebraic
 * loop — making feedback (cfg 3) + mutual sync (cfg 4) deterministic.
 */
function renderTwoVco(n: number, o: TwoVcoOpts): TwoVcoRender {
  const { aV = 0, bV = 0.07, bShape = 1, fmDepth = 0.4, aSyncB = false, bSyncA = false } = o;
  const a = new Float32Array(n);
  const b = new Float32Array(n);
  const aFreq = new Float32Array(n);
  let aP = 0;
  let bP = 0;
  let aPrev = 0;
  let bPrev = 0;
  let pendingResetA = 0; // reset to apply to A this sample (from B's prior pulse)
  let pendingResetB = 0; // reset to apply to B this sample (from A's prior pulse)
  for (let i = 0; i < n; i++) {
    const bAudioPrev = i > 0 ? b[i - 1] : 0; // 1-sample FM separation
    const fA = freqHz(aV, fmDepth, bAudioPrev);
    const fB = freqHz(bV, 0, 0);
    aFreq[i] = fA;
    aP = (1 - pendingResetA) * frac(aP + fA / SR);
    bP = (1 - pendingResetB) * frac(bP + fB / SR);
    const aPulse = aP < aPrev ? 1 : 0; // A.sync_out (raw-phase wrap)
    const bPulse = bP < bPrev ? 1 : 0; // B.sync_out
    aPrev = aP;
    bPrev = bP;
    // Latch the propagation-delayed resets for the NEXT sample.
    pendingResetA = bSyncA ? bPulse : 0;
    pendingResetB = aSyncB ? aPulse : 0;
    a[i] = sn(aP); // A is the sine carrier
    b[i] = morph(bP, bShape); // B morphs
  }
  return { a, b, aFreq };
}

// ── helpers ──
function rms(buf: Float32Array): number {
  let s = 0;
  for (const v of buf) s += v * v;
  return Math.sqrt(s / buf.length);
}
function diffRms(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i]! - b[i]!;
    s += d * d;
  }
  return Math.sqrt(s / a.length);
}
function allFinite(buf: Float32Array): boolean {
  return buf.every(Number.isFinite);
}
/** Mean samples between rising zero-crossings (a robust period estimate). */
function meanPeriodSamples(buf: Float32Array): number {
  const zc: number[] = [];
  for (let i = 1; i < buf.length; i++) if (buf[i - 1]! < 0 && buf[i]! >= 0) zc.push(i);
  if (zc.length < 2) return NaN;
  let s = 0;
  for (let i = 1; i < zc.length; i++) s += zc[i]! - zc[i - 1]!;
  return s / (zc.length - 1);
}
/** Coarse single-bin DFT magnitude at `hz`. */
function binMag(buf: Float32Array, hz: number): number {
  let re = 0;
  let im = 0;
  for (let i = 0; i < buf.length; i++) {
    const ph = (2 * Math.PI * hz * i) / SR;
    re += buf[i]! * Math.cos(ph);
    im -= buf[i]! * Math.sin(ph);
  }
  return Math.hypot(re, im) / buf.length;
}

/** Spectral centroid (Hz) over a coarse 50..6000 Hz DFT grid. Higher centroid =
 *  brighter / richer spectrum. Independent of the modulator fundamental, so it
 *  is robust where a fixed sideband grid is not (FM creates many sidebands). */
function spectralCentroid(buf: Float32Array): number {
  let num = 0;
  let den = 0;
  for (let hz = 50; hz <= 6000; hz += 50) {
    const m = binMag(buf, hz);
    num += m * hz;
    den += m;
  }
  return num / den;
}

const N = Math.round(SR * DURATION_S);

/** Shared baseline round-trip: write on update/first-run, else SHA-gate +
 *  tier-B compare against the committed .f32. */
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
    `Baseline SHA (${existingSha}) != source SHA (${srcSha}). Run \`npm run art:update -w art\` if the .dsp change was intentional.`,
  ).toBe(srcSha);
  const cmp = compareBuffers(buf, existing, 'B');
  expect(cmp.pass, cmp.detail).toBe(true);
}

describe('analog-vco / fm-sync-model — toolchain', () => {
  it('SHA matches between source and built artifact (DSP rebuild required)', async () => {
    const srcSha = await moduleSourceSha('analog-vco');
    const built = await builtSha('analog-vco');
    expect(built, `Built SHA (${built}) != source SHA (${srcSha}). Rebuild via \`task dsp:build\`.`).toBe(srcSha);
  });
});

describe('analog-vco / fm-sync — Config 1: B→FM A, no sync', () => {
  // A carrier @ C4; B modulator a touch above. Captured baselines:
  //   B=sine/square/saw at FM depth 0.5; plus a light-depth vibrato baseline.
  it('A stays sinusoidal in shape, but cycles stretch/compress (phase-velocity FM)', () => {
    const { a, aFreq } = renderTwoVco(N, { bShape: 0.5, fmDepth: 0.5 });
    // Unit-sine RMS (~0.707): the SHAPE stays sinusoidal even as freq bends.
    expect(rms(a)).toBeGreaterThan(0.6);
    expect(rms(a)).toBeLessThan(0.72);
    // Instantaneous frequency genuinely swings (cycles stretch/compress).
    let fmin = Infinity;
    let fmax = -Infinity;
    for (const f of aFreq) {
      fmin = Math.min(fmin, f);
      fmax = Math.max(fmax, f);
    }
    expect(fmax - fmin).toBeGreaterThan(100); // ~[185,370] Hz at depth 0.5
    expect(allFinite(a)).toBe(true);
  });

  it("A's instantaneous frequency tracks B sample-for-sample (FM follows B)", () => {
    const { aFreq, b } = renderTwoVco(N, { bShape: 0, fmDepth: 0.5 }); // B=saw
    // freqHz is monotonic in B's prior sample → freq rises iff B rose.
    let checked = 0;
    for (let i = 2; i < 2000; i++) {
      if (b[i - 1]! === b[i - 2]!) continue;
      const bRose = b[i - 1]! > b[i - 2]!;
      const fRose = aFreq[i]! > aFreq[i - 1]!;
      expect(fRose, `freq didn't track B at sample ${i}`).toBe(bRose);
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('FM depth scales sideband energy; B morph shape changes the spectrum', () => {
    // Spectral centroid (brightness) grows with FM depth — the sideband fan
    // widens. And B's morph shape changes A's FM spectrum: a square modulator
    // (two-frequency switching) drives A to a BRIGHTER spectrum than a pure
    // sine modulator at the same depth, while a saw modulator (continuous
    // ramp→jump "siren") produces a DISTINCT spectrum from both.
    const centroidAt = (bShape: number, depth: number) =>
      spectralCentroid(renderTwoVco(N, { bShape, fmDepth: depth }).a);
    // Depth: more FM = brighter spectrum.
    expect(centroidAt(0.5, 0.5)).toBeGreaterThan(centroidAt(0.5, 0.1));
    // Square modulator → brighter than sine modulator (two-freq switching).
    expect(centroidAt(1, 0.5)).toBeGreaterThan(centroidAt(0.5, 0.5));
    // Saw modulator → a materially different spectrum than sine (not equal).
    expect(Math.abs(centroidAt(0, 0.5) - centroidAt(0.5, 0.5))).toBeGreaterThan(50);
    expect(allFinite(renderTwoVco(N, { bShape: 0, fmDepth: 0.5 }).a)).toBe(true);
  });

  it('captures Config 1 baselines (B sine/square/saw @ depth 0.5) — RMS tier B', async () => {
    await assertBaseline('analog-vco/fm-sync-c1-bsine', renderTwoVco(N, { bShape: 0.5, fmDepth: 0.5 }).a);
    await assertBaseline('analog-vco/fm-sync-c1-bsquare', renderTwoVco(N, { bShape: 1, fmDepth: 0.5 }).a);
    await assertBaseline('analog-vco/fm-sync-c1-bsaw', renderTwoVco(N, { bShape: 0, fmDepth: 0.5 }).a);
    await assertBaseline('analog-vco/fm-sync-c1-vibrato', renderTwoVco(N, { bShape: 0.5, fmDepth: 0.1 }).a);
  });
});

describe('analog-vco / fm-sync — Config 2: B sync→A + B→FM A (B master)', () => {
  it("A's period LOCKS to B's period under hard sync", () => {
    const { a, b } = renderTwoVco(N, { bShape: 1, fmDepth: 0.4, bSyncA: true });
    const pA = meanPeriodSamples(a);
    const pB = meanPeriodSamples(b);
    expect(pA / pB).toBeGreaterThan(0.95);
    expect(pA / pB).toBeLessThan(1.05);
  });

  it('sync reshapes A (synced A differs materially from the un-synced FM-only A)', () => {
    const synced = renderTwoVco(N, { bShape: 1, fmDepth: 0.4, bSyncA: true }).a;
    const free = renderTwoVco(N, { bShape: 1, fmDepth: 0.4, bSyncA: false }).a;
    expect(diffRms(synced, free)).toBeGreaterThan(0.3);
    expect(allFinite(synced)).toBe(true);
  });

  it('captures the Config 2 baseline — RMS tier B', async () => {
    await assertBaseline('analog-vco/fm-sync-c2-bmaster', renderTwoVco(N, { bShape: 1, fmDepth: 0.4, bSyncA: true }).a);
  });
});

describe('analog-vco / fm-sync — Config 3: A sync→B + B→FM A (feedback)', () => {
  it('produces a non-degenerate, non-silent coupled output (both VCOs alive)', () => {
    const { a, b } = renderTwoVco(N, { bShape: 1, fmDepth: 0.4, aSyncB: true });
    expect(rms(a)).toBeGreaterThan(0.01);
    expect(rms(b)).toBeGreaterThan(0.01);
    expect(allFinite(a) && allFinite(b)).toBe(true);
  });

  it('differs from Config 2 (feedback ≠ one-way B-master sync)', () => {
    const cfg3 = renderTwoVco(N, { bShape: 1, fmDepth: 0.4, aSyncB: true }).a;
    const cfg2 = renderTwoVco(N, { bShape: 1, fmDepth: 0.4, bSyncA: true }).a;
    expect(diffRms(cfg3, cfg2)).toBeGreaterThan(0.1);
  });

  it('is DETERMINISTIC (1-sample sync-propagation delay makes feedback reproducible)', () => {
    const r1 = renderTwoVco(N, { bShape: 1, fmDepth: 0.4, aSyncB: true });
    const r2 = renderTwoVco(N, { bShape: 1, fmDepth: 0.4, aSyncB: true });
    expect(diffRms(r1.a, r2.a)).toBe(0);
    expect(diffRms(r1.b, r2.b)).toBe(0);
  });

  it('captures the Config 3 baselines (A + B) — RMS tier B', async () => {
    const r = renderTwoVco(N, { bShape: 1, fmDepth: 0.4, aSyncB: true });
    await assertBaseline('analog-vco/fm-sync-c3-feedback-a', r.a);
    await assertBaseline('analog-vco/fm-sync-c3-feedback-b', r.b);
  });
});

describe('analog-vco / fm-sync — Config 4: mutual sync (A↔B) + B→FM A', () => {
  it('coupled oscillators produce non-silent, BOUNDED output (no deadlock to 0)', () => {
    const { a, b } = renderTwoVco(N, { bShape: 1, fmDepth: 0.4, aSyncB: true, bSyncA: true });
    // NOT silent — the 1-sample propagation delay breaks the same-sample
    // deadlock that would otherwise pin both phases at 0.
    expect(rms(a)).toBeGreaterThan(0.005);
    expect(rms(b)).toBeGreaterThan(0.01);
    // Bounded.
    let mx = 0;
    for (const v of a) mx = Math.max(mx, Math.abs(v));
    expect(mx).toBeLessThanOrEqual(1.0000001);
    expect(allFinite(a) && allFinite(b)).toBe(true);
  });

  it("exhibits frequency pulling — A's mean frequency is dragged off its free-run", () => {
    const coupled = renderTwoVco(N, { bShape: 1, fmDepth: 0.4, aSyncB: true, bSyncA: true });
    const free = renderTwoVco(N, { bShape: 1, fmDepth: 0, aSyncB: false, bSyncA: false });
    const mean = (f: Float32Array) => f.reduce((s, v) => s + v, 0) / f.length;
    // The coupling pulls A's effective frequency away from its un-coupled C4.
    expect(Math.abs(mean(coupled.aFreq) - mean(free.aFreq))).toBeGreaterThan(10);
  });

  it('is DETERMINISTIC (the propagation delay makes mutual sync reproducible)', () => {
    const r1 = renderTwoVco(N, { bShape: 1, fmDepth: 0.4, aSyncB: true, bSyncA: true });
    const r2 = renderTwoVco(N, { bShape: 1, fmDepth: 0.4, aSyncB: true, bSyncA: true });
    expect(diffRms(r1.a, r2.a)).toBe(0);
    expect(diffRms(r1.b, r2.b)).toBe(0);
  });

  it('is non-silent across a range of B pitches (robust, not a knife-edge)', () => {
    for (const bV of [0.03, 0.13, 0.21, 0.37]) {
      const { a } = renderTwoVco(N, { bShape: 1, fmDepth: 0.4, aSyncB: true, bSyncA: true, bV });
      expect(rms(a), `silent at bV=${bV}`).toBeGreaterThan(0.005);
    }
  });

  it('captures the Config 4 baselines (A + B) — RMS tier B', async () => {
    const r = renderTwoVco(N, { bShape: 1, fmDepth: 0.4, aSyncB: true, bSyncA: true });
    await assertBaseline('analog-vco/fm-sync-c4-mutual-a', r.a);
    await assertBaseline('analog-vco/fm-sync-c4-mutual-b', r.b);
  });
});
