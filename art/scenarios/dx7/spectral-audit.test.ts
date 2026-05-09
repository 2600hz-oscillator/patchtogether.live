// art/scenarios/dx7/spectral-audit.test.ts
//
// Diagnostic — for each bundled preset, print the top 8 spectral peaks
// at C4 (or its register-appropriate note). Useful for hand-tuning the
// bank during development; passes as long as each preset has a
// recognizable (top peak ≥ 5x noise floor) tone.

import { describe, it, expect } from 'vitest';
import { renderDx7Note, goertzel, hann, midiToHz, rms } from '../../../packages/web/src/lib/audio/dx7-render';
import { DX7_BUILTIN_BANK } from '../../../packages/web/src/lib/audio/dx7-banks';

const SAMPLE_RATE = 48000;

interface SpectralPeak { hz: number; mag: number; }

function topPeaks(buf: Float32Array, midi: number, count = 8): SpectralPeak[] {
  const win = hann(buf);
  const fund = midiToHz(midi);
  const peaks: SpectralPeak[] = [];
  // Sweep harmonics 1..30 + a couple of inharmonic probes (1.5x, 2.5x).
  const targets: number[] = [];
  for (let n = 1; n <= 30; n++) targets.push(fund * n);
  targets.push(fund * 1.5, fund * 2.5, fund * 3.5);
  for (const f of targets) {
    if (f > SAMPLE_RATE / 2) continue;
    const mag = goertzel(win, SAMPLE_RATE, f);
    peaks.push({ hz: f, mag });
  }
  peaks.sort((a, b) => b.mag - a.mag);
  return peaks.slice(0, count);
}

describe('DX7 spectral audit (diagnostic)', () => {
  // Per-preset register: BASS at C2, others at C4.
  const REGISTER: Record<string, number> = {
    'BASS 1': 36,
  };

  for (const patch of DX7_BUILTIN_BANK) {
    it(`${patch.name}: top spectral peaks`, () => {
      const midi = REGISTER[patch.name] ?? 60;
      const buf = renderDx7Note(patch, { midi, durationS: 0.5, sampleRate: SAMPLE_RATE, holdGate: true });
      const r = rms(buf);
      const peaks = topPeaks(buf, midi, 6);
      const fund = midiToHz(midi);
      // Print to stderr so it surfaces in vitest output (not console.log
      // for non-noisy mode — we vit.run with --reporter=verbose if needed).
      const summary = peaks
        .map((p) => `${(p.hz / fund).toFixed(2)}x@${p.hz.toFixed(0)}Hz=${p.mag.toExponential(2)}`)
        .join(' | ');
      // eslint-disable-next-line no-console
      console.log(`[${patch.name}] rms=${r.toFixed(4)} | peaks: ${summary}`);
      // Dominant peak must be at least 5x the median peak — i.e. there's a
      // clear spectral character, not just white noise.
      const sorted = [...peaks].sort((a, b) => b.mag - a.mag);
      const median = sorted[Math.floor(sorted.length / 2)]!.mag;
      const top = sorted[0]!.mag;
      expect(top / median, `${patch.name} top/median peak ratio`).toBeGreaterThan(5);
    });
  }
});
