// art/scenarios/featurecv/feature-extract.test.ts
//
// ART scenario for FEATURECV (audio→CV feature extractor). Two layers, mirroring
// synesthesia/band-filtering:
//
//   1. Repo-standard checks: the compiled worklet artifact exists + the built
//      .sha still matches the source .ts (so a worklet change forces a rebuild).
//   2. REAL feature renders via the pure renderFeatureCv() helper on the four
//      canonical signals from the module spec — pure sine (LOW crest + LOW-ish
//      ZCR), white noise (HIGH ZCR brightness), an amplitude ramp (MONOTONE
//      loud), and a transient burst (an ONSET pulse) — asserting the headline
//      behaviour AND pinning the rendered feature waveform as a .f32 baseline
//      so a future DSP change is caught by a waveform diff.
//
// On first run (or UPDATE_BASELINES=1) the .f32 baselines are written; later
// runs compare (RMS tier B). Regenerate with `npm run art:update -w art`.

import { describe, it, expect } from 'vitest';
import { renderFeatureCv, GATE_HI } from '../../../packages/dsp/src/lib/featurecv-dsp';
import {
  render,
  readBaseline,
  writeBaseline,
  compareBuffers,
  builtSha,
  moduleSourceSha,
  SHOULD_UPDATE_BASELINES,
  SAMPLE_RATE,
} from '../../setup/render';

const SR = SAMPLE_RATE;

function sine(freq: number, secs: number, amp = 0.8): Float32Array {
  const n = Math.round(secs * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
}

// Deterministic pseudo-noise (mulberry32) so the baseline is reproducible.
function noise(secs: number, amp = 0.8, seed = 0x51ee): Float32Array {
  const n = Math.round(secs * SR);
  const out = new Float32Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    out[i] = (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 * amp - amp;
  }
  return out;
}

function ampRamp(freq: number, secs: number): Float32Array {
  const n = Math.round(secs * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (i / n) * Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
}

function transient(secs: number, hitS: number, freq = 1200): Float32Array {
  const n = Math.round(secs * SR);
  const out = new Float32Array(n);
  const hit = Math.round(hitS * SR);
  for (let i = hit; i < n; i++) {
    const env = Math.exp(-(i - hit) / (0.03 * SR));
    out[i] = env * Math.sin((2 * Math.PI * freq * i) / SR);
  }
  return out;
}

function meanTail(buf: Float32Array): number {
  const start = Math.floor(buf.length / 2);
  let s = 0;
  for (let i = start; i < buf.length; i++) s += buf[i]!;
  return s / (buf.length - start);
}

function countPulses(buf: Float32Array): number {
  let count = 0;
  let prev = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i]! >= GATE_HI && prev < GATE_HI) count++;
    prev = buf[i]!;
  }
  return count;
}

async function pinBaseline(scenarioId: string, data: Float32Array): Promise<void> {
  const existing = await readBaseline(scenarioId);
  if (SHOULD_UPDATE_BASELINES || !existing) {
    await writeBaseline(scenarioId, data);
    return;
  }
  const cmp = compareBuffers(data, existing, 'B');
  expect(cmp.pass, cmp.detail).toBe(true);
}

describe('featurecv / feature-extract', () => {
  it('compiled worklet artifact exists + built SHA matches source', async () => {
    const result = await render({ moduleName: 'featurecv', durationS: 0.2 });
    expect(result.buffer.length).toBeGreaterThan(0);
    expect(result.buffer.findIndex((v) => !Number.isFinite(v))).toBe(-1);
    const src = await moduleSourceSha('featurecv');
    const built = await builtSha('featurecv');
    expect(built, 'forgot `npm run build -w packages/dsp`?').toBe(src);
  });

  it('white noise → HIGH bright; pure sine → LOW bright (+ baseline)', async () => {
    const nz = renderFeatureCv(noise(0.3, 0.8), { sr: SR, bipolar: false });
    const sn = renderFeatureCv(sine(1000, 0.3, 0.8), { sr: SR, bipolar: false });
    expect(meanTail(nz.bright)).toBeGreaterThan(0.6);
    expect(meanTail(sn.bright)).toBeLessThan(0.2);
    expect(meanTail(nz.bright)).toBeGreaterThan(meanTail(sn.bright) + 0.4);
    await pinBaseline('featurecv/noise-bright', nz.bright);
  });

  it('pure sine → LOW punch (crest); noise is punchier (+ baseline)', async () => {
    const sn = renderFeatureCv(sine(1000, 0.3, 0.8), { sr: SR, bipolar: false });
    const nz = renderFeatureCv(noise(0.3, 0.8), { sr: SR, bipolar: false });
    expect(meanTail(sn.punch)).toBeLessThan(0.15);
    expect(meanTail(nz.punch)).toBeGreaterThan(meanTail(sn.punch));
    await pinBaseline('featurecv/sine-punch', sn.punch);
  });

  it('amplitude ramp → MONOTONE-rising loud (+ baseline)', async () => {
    const r = renderFeatureCv(ampRamp(500, 0.6), { sr: SR, bipolar: false });
    const n = r.loud.length;
    const early = r.loud[Math.floor(n * 0.2)]!;
    const mid = r.loud[Math.floor(n * 0.55)]!;
    const late = r.loud[Math.floor(n * 0.9)]!;
    expect(mid).toBeGreaterThan(early);
    expect(late).toBeGreaterThan(mid);
    await pinBaseline('featurecv/ramp-loud', r.loud);
  });

  it('transient burst → at least one ONSET pulse crossing GATE_HI (+ baseline)', async () => {
    const r = renderFeatureCv(transient(0.5, 0.25), { sr: SR, onsetSens: 0.7 });
    expect(countPulses(r.onset)).toBeGreaterThanOrEqual(1);
    await pinBaseline('featurecv/transient-onset', r.onset);
  });
});
