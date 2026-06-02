// e2e/tests/analog-vco-hard-sync.spec.ts
//
// ANALOG VCO hard-sync end-to-end. Two analog VCOs:
//   master.sync (out) → slave.sync (in)   — hard sync
//   slave.saw         → scope.ch1          — observe the slave
//
// Classic hard sync forces the slave to restart its cycle every time the
// master completes one, so the SLAVE'S perceived FUNDAMENTAL locks to the
// MASTER'S frequency (the slave's free-run pitch becomes the formant/timbre,
// not the pitch). We tune the two oscillators to clearly different pitches
// via the `tune` knob (semitones) — this avoids the audio-rate pitch-CV
// routing quirk noted in vco-pitch-tracking.spec.ts — then assert:
//
//   CONTROL (no sync wire): the slave's scope fundamental ≈ the slave's own
//     free-run frequency.
//   SYNCED  (sync wired):   the slave's scope fundamental LOCKS to the
//     master's frequency, and is clearly DIFFERENT from the control.
//
// This is the frontend-integration backstop for the worklet's hard-sync path
// that the Faust ART (node-web-audio-api can't host the worklet) can't cover.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

const C4 = 261.6256;
// tune is in semitones; freq = C4 * 2^(semis/12).
const freqAtSemis = (semis: number) => C4 * Math.pow(2, semis / 12);

const MASTER_SEMIS = -12; // C3 ≈ 130.81 Hz
const SLAVE_SEMIS = 7;    // G4 ≈ 392.00 Hz (a free-run fifth-plus above master)
const MASTER_HZ = freqAtSemis(MASTER_SEMIS);
const SLAVE_HZ = freqAtSemis(SLAVE_SEMIS);

function dominantHz(buf: Float32Array, sampleRate: number): number {
  const n = buf.length;
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const win = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
    w[i] = buf[i]! * win;
  }
  function goertzel(samples: Float32Array, sr: number, freq: number): number {
    const k = (samples.length * freq) / sr;
    const omega = (2 * Math.PI * k) / samples.length;
    const c = Math.cos(omega);
    const coeff = 2 * c;
    let q1 = 0, q2 = 0;
    for (let i = 0; i < samples.length; i++) {
      const q0 = coeff * q1 - q2 + samples[i]!;
      q2 = q1;
      q1 = q0;
    }
    return q1 * q1 + q2 * q2 - q1 * q2 * coeff;
  }
  let bestF = 100, bestMag = -Infinity;
  for (let f = 60; f <= 2000; f += 2) {
    const m = goertzel(w, sampleRate, f);
    if (m > bestMag) { bestMag = m; bestF = f; }
  }
  for (let f = bestF - 2; f <= bestF + 2; f += 0.1) {
    const m = goertzel(w, sampleRate, f);
    if (m > bestMag) { bestMag = m; bestF = f; }
  }
  return bestF;
}

async function measureSlave(page: Page, syncWired: boolean): Promise<number> {
  await page.goto('/');
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

  // Let the worklets load, params smooth in, and the analyser warm up.
  await page.waitForTimeout(500);

  const result = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __engine?: () => { read: (n: unknown, k: string) => unknown } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    if (!eng) return { buf: [] as number[], sr: 0 };
    const snap = eng.read(w.__patch.nodes['sc']!, 'snapshot') as {
      ch1?: Float32Array; sampleRate?: number;
    } | null;
    if (!snap?.ch1) return { buf: [] as number[], sr: 0 };
    return { buf: Array.from(snap.ch1), sr: snap.sampleRate ?? 44100 };
  });
  if (result.buf.length === 0) throw new Error('no scope snapshot');
  return dominantHz(new Float32Array(result.buf), result.sr);
}

test.describe('Analog VCO hard sync (two VCOs → scope)', () => {
  test('control: un-synced slave runs at its own free-run frequency', async ({ page }) => {
    const f = await measureSlave(page, /* syncWired */ false);
    // Within ±12% (FFT bin slack + a saw's strong harmonics fighting the peak).
    expect(
      f,
      `free-run slave dominant ${f.toFixed(1)} Hz vs expected ~${SLAVE_HZ.toFixed(1)} Hz`,
    ).toBeGreaterThan(SLAVE_HZ * 0.88);
    expect(f).toBeLessThan(SLAVE_HZ * 1.12);
  });

  test('synced: slave fundamental LOCKS to the master and differs from free-run', async ({ page }) => {
    const free = await measureSlave(page, /* syncWired */ false);
    const synced = await measureSlave(page, /* syncWired */ true);

    // Hard-sync collapses the slave's perceived fundamental onto the master's
    // frequency — the defining behaviour. Allow ±15% for the saw's harmonic
    // structure shifting the peak bin.
    expect(
      synced,
      `synced slave dominant ${synced.toFixed(1)} Hz should lock to master ~${MASTER_HZ.toFixed(1)} Hz`,
    ).toBeGreaterThan(MASTER_HZ * 0.85);
    expect(synced).toBeLessThan(MASTER_HZ * 1.15);

    // And it must be clearly different from the un-synced slave — proof the
    // sync wire actually changed the output (not a no-op).
    expect(
      Math.abs(synced - free),
      `synced (${synced.toFixed(1)} Hz) too close to free-run (${free.toFixed(1)} Hz) — sync had no effect`,
    ).toBeGreaterThan(SLAVE_HZ * 0.3);
  });
});
