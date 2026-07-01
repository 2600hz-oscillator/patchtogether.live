// e2e/tests/analog-vco-hard-sync.spec.ts
//
// ANALOG VCO hard-sync end-to-end. Two analog VCOs:
//   master.sync (out) → slave.sync (in)   — hard sync
//   slave.saw         → scope.ch1          — observe the slave
//
// Classic hard sync forces the slave to restart its cycle every time the
// master completes one, so the synced slave's waveform becomes PERIODIC AT
// THE MASTER'S period — its spectrum grows a strong component at the master
// fundamental (a sub-harmonic relative to the slave's own free-run pitch),
// while the slave's free-run pitch survives as a bright formant. That is the
// characteristic hard-sync timbre.
//
// We tune the two oscillators to clearly different pitches via the `tune`
// knob (semitones) — this avoids the audio-rate pitch-CV routing quirk noted
// in vco-pitch-tracking.spec.ts. Then we assert, against the SLAVE'S scope
// trace:
//
//   CONTROL (no sync wire): the slave runs at its OWN free-run frequency and
//     carries ~no energy at the master fundamental.
//   SYNCED  (sync wired):   the slave grows a STRONG component at the master
//     fundamental (it now repeats at the master period) — and the whole
//     waveform is materially DIFFERENT from the un-synced capture, proving
//     the sync wire is consumed (not a no-op).
//
// This is the frontend-integration backstop for the worklet's hard-sync path
// that the Faust ART (node-web-audio-api can't host the worklet) can't cover.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

const C4 = 261.6256;
// tune is in semitones; freq = C4 * 2^(semis/12).
const freqAtSemis = (semis: number) => C4 * Math.pow(2, semis / 12);

// Pitches are chosen so the slave/master frequency RATIO is clearly
// NON-INTEGER (≈ 2.67). An integer ratio (e.g. a perfect 3:1) would leave the
// slave already near phase 0 at every reset, so hard sync would barely change
// the waveform; a non-integer ratio makes the reset chop the slave mid-cycle,
// producing the strong master-period periodicity that defines the effect.
const MASTER_SEMIS = -12; // C3 ≈ 130.81 Hz
const SLAVE_SEMIS = 5;    // F4 ≈ 349.23 Hz  (ratio ≈ 2.67, non-integer)
const MASTER_HZ = freqAtSemis(MASTER_SEMIS);
const SLAVE_HZ = freqAtSemis(SLAVE_SEMIS);

/** Goertzel power at a single target frequency over a Hann-windowed buffer. */
function powerAt(buf: Float32Array, sampleRate: number, freq: number): number {
  const n = buf.length;
  const k = (n * freq) / sampleRate;
  const omega = (2 * Math.PI * k) / n;
  const coeff = 2 * Math.cos(omega);
  let q1 = 0, q2 = 0;
  for (let i = 0; i < n; i++) {
    const win = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
    const q0 = coeff * q1 - q2 + buf[i]! * win;
    q2 = q1;
    q1 = q0;
  }
  return q1 * q1 + q2 * q2 - q1 * q2 * coeff;
}

/** Dominant fundamental via a coarse-then-fine Goertzel grid. */
function dominantHz(buf: Float32Array, sampleRate: number): number {
  let bestF = 100, bestMag = -Infinity;
  for (let f = 60; f <= 2000; f += 2) {
    const m = powerAt(buf, sampleRate, f);
    if (m > bestMag) { bestMag = m; bestF = f; }
  }
  for (let f = bestF - 2; f <= bestF + 2; f += 0.1) {
    const m = powerAt(buf, sampleRate, f);
    if (m > bestMag) { bestMag = m; bestF = f; }
  }
  return bestF;
}

interface SlaveCapture {
  buf: Float32Array;
  sr: number;
}

async function captureSlave(page: Page, syncWired: boolean): Promise<SlaveCapture> {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  const edges = [
    {
      id: 'e_slave_scope',
      from: { nodeId: 'slave', portId: 'saw' },
      to:   { nodeId: 'sc',    portId: 'ch1' },
      sourceType: 'audio',
      targetType: 'audio',
    },
  ];
  if (syncWired) {
    edges.push({
      id: 'e_master_slave_sync',
      from: { nodeId: 'master', portId: 'sync' },
      to:   { nodeId: 'slave',  portId: 'sync' },
      sourceType: 'audio',
      targetType: 'audio',
    });
  }

  await spawnPatch(
    page,
    [
      { id: 'master', type: 'analogVco', params: { tune: MASTER_SEMIS }, position: { x: 100, y: 100 } },
      { id: 'slave',  type: 'analogVco', params: { tune: SLAVE_SEMIS },  position: { x: 450, y: 100 } },
      { id: 'sc',     type: 'scope',     position: { x: 800, y: 100 } },
    ],
    edges,
  );

  // Let the worklets load + params smooth in. The audio context can take a
  // beat to reach `running` on a cold dev server, so poll the scope until it
  // delivers a non-silent snapshot rather than racing a fixed timeout.
  await page.waitForTimeout(500);
  const result = await page.waitForFunction(() => {
    const w = globalThis as unknown as {
      __engine?: () => { read: (n: unknown, k: string) => unknown } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    if (!eng) return null;
    const snap = eng.read(w.__patch.nodes['sc']!, 'snapshot') as {
      ch1?: Float32Array; sampleRate?: number;
    } | null;
    if (!snap?.ch1) return null;
    // Require a meaningfully non-silent buffer (the slave saw rings ~±1).
    let peak = 0;
    for (const v of snap.ch1) if (Math.abs(v) > peak) peak = Math.abs(v);
    if (peak < 0.3) return null;
    return { buf: Array.from(snap.ch1), sr: snap.sampleRate ?? 44100 };
  }, { timeout: 8000, polling: 150 });
  const value = (await result.jsonValue()) as { buf: number[]; sr: number };
  return { buf: new Float32Array(value.buf), sr: value.sr };
}

test.describe('Analog VCO hard sync (two VCOs → scope)', () => {
  test('control: un-synced slave runs at its own free-run frequency', async ({ page }) => {
    const { buf, sr } = await captureSlave(page, /* syncWired */ false);
    const f = dominantHz(buf, sr);
    // Within ±12% (FFT bin slack + a saw's strong harmonics fighting the peak).
    expect(
      f,
      `free-run slave dominant ${f.toFixed(1)} Hz vs expected ~${SLAVE_HZ.toFixed(1)} Hz`,
    ).toBeGreaterThan(SLAVE_HZ * 0.88);
    expect(f).toBeLessThan(SLAVE_HZ * 1.12);
  });

  test('synced: slave grows a master-frequency component and differs from free-run', async ({ page }) => {
    const free = await captureSlave(page, /* syncWired */ false);
    const synced = await captureSlave(page, /* syncWired */ true);

    // Hard sync makes the slave repeat at the MASTER period, so its spectrum
    // grows a strong component at the master fundamental that is essentially
    // absent in the free-run slave (whose only periodicity is its own pitch).
    // Compare the master-fundamental power normalised by each capture's own
    // slave-fundamental power (so loudness / gain differences cancel out).
    const masterRatioFree   = powerAt(free.buf,   free.sr,   MASTER_HZ) / (powerAt(free.buf,   free.sr,   SLAVE_HZ) + 1e-12);
    const masterRatioSynced = powerAt(synced.buf, synced.sr, MASTER_HZ) / (powerAt(synced.buf, synced.sr, SLAVE_HZ) + 1e-12);

    // The free-run slave should have very little energy at the master pitch.
    expect(
      masterRatioFree,
      `free-run slave already has master-pitch energy (ratio ${masterRatioFree.toExponential(2)})`,
    ).toBeLessThan(0.5);

    // The synced slave must have MUCH more energy at the master pitch than the
    // free-run one — proof hard sync is engaging (the slave re-periodicised
    // onto the master). At least a 10x relative jump.
    expect(
      masterRatioSynced,
      `synced master-pitch ratio ${masterRatioSynced.toExponential(2)} not >> free-run ${masterRatioFree.toExponential(2)} — sync had no effect`,
    ).toBeGreaterThan(masterRatioFree * 10 + 0.1);

    // Belt-and-suspenders: the synced waveform must also differ materially
    // from the free-run one (the RMS of the per-sample difference is a large
    // fraction of the signal RMS). This catches a no-op sync wire directly.
    const n = Math.min(free.buf.length, synced.buf.length);
    let diffSq = 0, sigSq = 0;
    for (let i = 0; i < n; i++) {
      const d = synced.buf[i]! - free.buf[i]!;
      diffSq += d * d;
      sigSq += free.buf[i]! * free.buf[i]!;
    }
    const diffRms = Math.sqrt(diffSq / n);
    const sigRms = Math.sqrt(sigSq / n) + 1e-12;
    expect(
      diffRms / sigRms,
      `synced waveform too close to free-run (diffRMS/sigRMS ${(diffRms / sigRms).toFixed(3)}) — sync had no effect`,
    ).toBeGreaterThan(0.2);
  });
});
