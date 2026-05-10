// art/scenarios/dx7/syx-spectra.test.ts
//
// Regression: "uploaded SYX patches all sound like the bundled E.PIANO 1".
// Loads the AAAHGOOD.SYX cartridge fixture (32 named voices, 14 distinct
// algorithms) and renders four spaced-out patches (1, 8, 16, 24) through
// the pure-TS dx7-render. Asserts that:
//
//   1. Each patch produces audible (non-silent, non-NaN) output at C4.
//   2. The four patches are spectrally DISTINCT — no pair has identical
//      energy at the fundamental + a handful of harmonics. If the fix
//      regresses (i.e. SYX voices are silently substituted for E.PIANO 1),
//      every "patch" would render as the same waveform and this gate
//      would fail.
//
// dx7-render mirrors the worklet's render loop (see dx7-render.ts header
// for the SYNC PARTNER contract). If the worklet diverges from this
// renderer, the worklet is the bug — not this test.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  renderDx7Note,
  goertzel,
  hann,
  midiToHz,
  rms,
} from '../../../packages/web/src/lib/audio/dx7-render';
import { parseSyxBank, type DX7Voice } from '../../../packages/web/src/lib/audio/dx7-syx';

const SAMPLE_RATE = 48000;
const DURATION_S = 0.5;
const __dirname = dirname(fileURLToPath(import.meta.url));
const AAAHGOOD_SYX = join(
  __dirname,
  '..',
  '..',
  '..',
  'packages',
  'web',
  'src',
  'lib',
  'audio',
  '__fixtures__',
  'AAAHGOOD.SYX',
);

/** Spectral fingerprint at the fundamental + harmonics 2..10 of a held note. */
function spectralFingerprint(buf: Float32Array, fund: number): number[] {
  const win = hann(buf);
  const out: number[] = [];
  for (let h = 1; h <= 10; h++) {
    out.push(goertzel(win, SAMPLE_RATE, fund * h));
  }
  return out;
}

/** Sample-wise normalized L2 distance between two equally-sized buffers.
 *  Returns 0 for identical buffers, positive for any divergence — perfect
 *  for catching the SYX-load-falls-back-to-E.PIANO regression where the
 *  bug's symptom is "every patch renders byte-identical audio". */
function l2Normalized(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error('length mismatch');
  let diffSq = 0;
  let normSq = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i]! - b[i]!;
    diffSq += d * d;
    normSq += a[i]! * a[i]! + b[i]! * b[i]!;
  }
  return Math.sqrt(diffSq) / Math.max(Math.sqrt(normSq), 1e-9);
}

describe('DX7 ART: AAAHGOOD.SYX patches are spectrally distinct', () => {
  const bytes = new Uint8Array(readFileSync(AAAHGOOD_SYX));
  const result = parseSyxBank(bytes);
  const voices: DX7Voice[] = result.voices;
  // We pick four spread-out indices. AAAHGOOD voice 16 is RHODES1 RH (algo
  // 5 — actually the closest to the bundled E.PIANO), so we deliberately
  // include it: if "everything sounds like E.PIANO" is back, RHODES1 + the
  // others would all collapse to one fingerprint and the distinct-pairs
  // assertion fails.
  const probe = [0, 7, 15, 23];

  it('all 4 probe patches render audible signal at C4', () => {
    for (const idx of probe) {
      const v = voices[idx]!;
      const buf = renderDx7Note(v, {
        midi: 60,
        durationS: DURATION_S,
        sampleRate: SAMPLE_RATE,
        holdGate: true,
      });
      const energy = rms(buf);
      expect(energy, `voice ${idx} (${v.name}) should produce audible energy`).toBeGreaterThan(0.001);
      const bad = buf.findIndex((s) => !Number.isFinite(s));
      expect(bad, `voice ${idx} (${v.name}) non-finite sample`).toBe(-1);
    }
  });

  it('all 4×4 patch pairs render measurably different waveforms', () => {
    // The bug we're catching: SYX upload silently falls back to bundled
    // E.PIANO 1 → every patch renders byte-identical audio → L2 distance
    // would be 0. A normalized-L2 ≥ 0.3 is comfortably above the noise
    // floor for any pair of genuinely different patches at 0.5s of held
    // C4, while a regression would land at exactly 0.
    const renders = probe.map((idx) => {
      const v = voices[idx]!;
      return {
        idx,
        name: v.name,
        buf: renderDx7Note(v, {
          midi: 60,
          durationS: DURATION_S,
          sampleRate: SAMPLE_RATE,
          holdGate: true,
        }),
      };
    });
    for (let i = 0; i < renders.length; i++) {
      for (let j = i + 1; j < renders.length; j++) {
        const d = l2Normalized(renders[i]!.buf, renders[j]!.buf);
        expect(
          d,
          `${renders[i]!.name} vs ${renders[j]!.name}: normalized L2 distance ${d.toFixed(3)} (regression: bug renders byte-identical audio → distance ≈ 0)`,
        ).toBeGreaterThan(0.3);
      }
    }
  });

  it('also: spectral fingerprints at harmonics 1..10 differ between patches', () => {
    // Lighter sanity check: for the very first pair (Trombones vs Elec
    // Brass, deliberately different timbres) the spectral fingerprint
    // must not collapse. We use a generous threshold — the bug's symptom
    // is "everything sounds like E.PIANO 1" which means fingerprints are
    // identical (distance 0). Any non-zero distance proves we're not
    // collapsing.
    const fund = midiToHz(60);
    const v0 = voices[0]!; // Trombones (algo 18)
    const v1 = voices[1]!; // Elec Brass (algo 2)
    const buf0 = renderDx7Note(v0, { midi: 60, durationS: DURATION_S, sampleRate: SAMPLE_RATE, holdGate: true });
    const buf1 = renderDx7Note(v1, { midi: 60, durationS: DURATION_S, sampleRate: SAMPLE_RATE, holdGate: true });
    const fp0 = spectralFingerprint(buf0, fund);
    const fp1 = spectralFingerprint(buf1, fund);
    // At least one harmonic bin should differ by ≥10% of the louder
    // patch's max bin energy. Catches "stuck on one patch" regression.
    const maxEnergy = Math.max(...fp0, ...fp1);
    let saw = false;
    for (let h = 0; h < 10; h++) {
      if (Math.abs(fp0[h]! - fp1[h]!) / Math.max(maxEnergy, 1e-12) > 0.1) {
        saw = true;
        break;
      }
    }
    expect(saw, 'Trombones vs Elec Brass: at least one harmonic bin differs ≥10%').toBe(true);
  });
});
