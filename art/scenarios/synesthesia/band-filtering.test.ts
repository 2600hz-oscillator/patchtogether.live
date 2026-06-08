// art/scenarios/synesthesia/band-filtering.test.ts
//
// ART scenario for SYNESTHESIA. Two layers:
//
//   1. Repo-standard checks (like analog-vco/saw-c4): the compiled worklet
//      artifact exists + the built .sha still matches the source .ts.
//   2. REAL per-band baselines: render each band's audio output for its test
//      tone via the pure renderSynesthesia() helper (NOT the stub render()),
//      assert it's filtered to the correct band, and pin the rendered waveform
//      as a .f32 baseline so a future DSP change is caught by a waveform diff.
//
// On first run (or UPDATE_BASELINES=1) the .f32 baselines are written; later
// runs compare (RMS tier B). Regenerate with `npm run art:update -w art`.

import { describe, it, expect } from 'vitest';
import { renderSynesthesia } from '../../../packages/dsp/src/lib/synesthesia-dsp';
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

function rmsTail(buf: Float32Array): number {
  const start = Math.floor(buf.length / 2);
  let s = 0;
  for (let i = start; i < buf.length; i++) s += buf[i]! * buf[i]!;
  return Math.sqrt(s / (buf.length - start));
}

// MUSICAL bands: 65→band1(20-200), 400→band2(200-1k), 2000→band3(1k-4k),
// 8000→band4(4k+). Tones sit well inside each band so the 24 dB/oct slopes
// keep the target band dominant.
const BANDS = [
  { n: 1, idx: 0, freq: 65 },
  { n: 2, idx: 1, freq: 400 },
  { n: 3, idx: 2, freq: 2000 },
  { n: 4, idx: 3, freq: 8000 },
] as const;

describe('synesthesia / band-filtering', () => {
  it('compiled worklet artifact exists + built SHA matches source', async () => {
    const result = await render({ moduleName: 'synesthesia', durationS: 0.2 });
    expect(result.buffer.length).toBeGreaterThan(0);
    expect(result.buffer.findIndex((v) => !Number.isFinite(v))).toBe(-1);
    const src = await moduleSourceSha('synesthesia');
    const built = await builtSha('synesthesia');
    expect(built, 'forgot `npm run build -w packages/dsp`?').toBe(src);
  });

  for (const { n, idx, freq } of BANDS) {
    it(`band ${n} (${freq} Hz): filtered to its band + matches .f32 baseline`, async () => {
      const r = renderSynesthesia(sine(freq, 0.1), { sr: SR });
      const bandAudio = r.audio[idx]!;

      // Filtered: the target band carries the most energy.
      const rms = r.audio.map(rmsTail);
      expect(rms[idx], `band ${n} should dominate for ${freq} Hz`).toBe(Math.max(...rms));

      // Pin the rendered band waveform as a regression baseline.
      const scenarioId = `synesthesia/band${n}-${freq}hz`;
      const existing = await readBaseline(scenarioId);
      if (SHOULD_UPDATE_BASELINES || !existing) {
        await writeBaseline(scenarioId, bandAudio);
        return;
      }
      const cmp = compareBuffers(bandAudio, existing, 'B');
      expect(cmp.pass, cmp.detail).toBe(true);
    });
  }
});
