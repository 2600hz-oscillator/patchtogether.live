// e2e/tests/adsr-poly-midilane.spec.ts
//
// Bespoke E2E for the per-voice ADSR feature on CUBE / WAVECEL / DX7.
// Validates in the REAL worklet (the pure-fn + worklet-unit tests cover the
// envelope math; this proves the end-to-end audio path):
//   - DX7 master-ADSR swell: a gated note through the master VCA carries audio.
//   - CUBE/WAVECEL mono TRIGGER gates the per-voice envelope (audio opens when
//     the TRIGGER fires).
//   - back-compat: a TRULY-UNPATCHED TRIGGER (no poly either) keeps CUBE/WAVECEL
//     droning as a continuous raw VCO (env idle, base_vol=1 → byte-identical).
//   - no-stray-drone (Bug 1): a TRIGGER patched but NEVER gated (sequencer parked,
//     isPlaying=0) is SILENT — patching poly/trigger puts the module into GATED
//     mode, so a never-gated voice does NOT fall through to the legacy drone.
//   - a poly chord (POLYSEQZ) into `poly` drives the per-voice envelopes → the
//     stereo OUT carries audio.
//
// CI is on a software renderer; audio-capture e2e is slow there, so timeouts
// scale with the number of capture windows rather than a flat value, and we keep
// the capture count modest.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { readScopePeakOverWindow } from './_module-coverage-helpers';

test.describe.configure({ mode: 'parallel' });

// Each audio-capture window polls ~0.6s. Scale the per-test timeout by the
// number of windows a test runs (CI SwiftShader is slow on audio-capture e2e).
const CAPTURE_MS = 600;
function timeoutFor(captureWindows: number): number {
  return 30_000 + captureWindows * 8_000;
}

/** Seed a SEQUENCER with always-on C4 steps so its gate fires every step. */
async function seedSeqSteps(page: import('@playwright/test').Page, seqId: string): Promise<void> {
  await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const t = w.__patch.nodes[id];
      if (!t) return;
      if (!t.data) t.data = {};
      (t.data as Record<string, unknown>).steps = Array.from({ length: 32 }, () => ({ on: true, midi: 60, chord: 'mono' }));
    });
  }, seqId);
}

test('dx7 master-ADSR: a gated poly note carries audio through the master VCA', async ({ page }) => {
  test.setTimeout(timeoutFor(1));
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  // Drive DX7 via the poly bus (the proven dx7.spec path): SEQUENCER.pitch →
  // DX7.poly, with seeded always-on steps so a gate fires every step. Each gate
  // rising edge fires noteOn → the master VCA shapes the voice on top of the
  // operator EGs. A slow master attack + held sustain keeps the OUT alive.
  await spawnPatch(
    page,
    [
      { id: 'seq', type: 'sequencer', position: { x: 40, y: 60 }, domain: 'audio', params: { bpm: 240, length: 4, isPlaying: 1 } },
      { id: 'dx', type: 'dx7', position: { x: 360, y: 60 }, domain: 'audio', params: { algorithm: 5, voiceCount: 5, attack: 0.05, decay: 0.2, sustain: 0.9, release: 0.3, level: 1 } },
      { id: 'sc', type: 'scope', position: { x: 900, y: 60 }, domain: 'audio', params: { timeMs: 50 } },
    ],
    [
      { id: 'e_seq_dx', from: { nodeId: 'seq', portId: 'pitch' }, to: { nodeId: 'dx', portId: 'poly' }, sourceType: 'polyPitchGate', targetType: 'polyPitchGate' },
      { id: 'e_dx_sc',  from: { nodeId: 'dx', portId: 'out' },    to: { nodeId: 'sc', portId: 'ch1' },  sourceType: 'audio', targetType: 'audio' },
    ],
  );

  // Seed always-on steps so the sequencer's gate fires (default steps may be off).
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const t = w.__patch.nodes['seq'];
      if (!t) return;
      if (!t.data) t.data = {};
      (t.data as Record<string, unknown>).steps = Array.from({ length: 32 }, () => ({ on: true, midi: 60, chord: 'mono' }));
    });
  });

  const { peak } = await readScopePeakOverWindow(page, 'sc', CAPTURE_MS);
  expect(peak, 'DX7 OUT should carry audio when gated (master ADSR open)').toBeGreaterThan(0.01);
  expect(errors, 'no console / page errors').toEqual([]);
});

test('cube mono TRIGGER gates the per-voice envelope (audio opens on trigger)', async ({ page }) => {
  test.setTimeout(timeoutFor(1));
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      { id: 'seq', type: 'sequencer', position: { x: 40, y: 60 }, domain: 'audio', params: { bpm: 240, length: 4, isPlaying: 1, gateLength: 0.6 } },
      { id: 'cb', type: 'cube', position: { x: 360, y: 60 }, domain: 'audio', params: { attack: 0.02, decay: 0.1, sustain: 0.9, release: 0.2, level: 1 } },
      { id: 'sc', type: 'scope', position: { x: 900, y: 60 }, domain: 'audio', params: { timeMs: 50 } },
    ],
    [
      { id: 'e_seq_cb', from: { nodeId: 'seq', portId: 'gate' }, to: { nodeId: 'cb', portId: 'trigger' }, sourceType: 'gate', targetType: 'gate' },
      { id: 'e_cb_sc', from: { nodeId: 'cb', portId: 'L' }, to: { nodeId: 'sc', portId: 'ch1' }, sourceType: 'audio', targetType: 'audio' },
    ],
  );
  await seedSeqSteps(page, 'seq');

  const { peak } = await readScopePeakOverWindow(page, 'sc', CAPTURE_MS);
  expect(peak, 'CUBE L should carry audio when the TRIGGER gate fires').toBeGreaterThan(0.01);
  expect(errors, 'no console / page errors').toEqual([]);
});

test('cube back-compat: an unpatched TRIGGER keeps CUBE droning (env skipped)', async ({ page }) => {
  test.setTimeout(timeoutFor(1));
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  // CUBE with NOTHING patched to TRIGGER (and no poly) → free-running drone.
  await spawnPatch(
    page,
    [
      { id: 'cb', type: 'cube', position: { x: 360, y: 60 }, domain: 'audio', params: { level: 1 } },
      { id: 'sc', type: 'scope', position: { x: 900, y: 60 }, domain: 'audio', params: { timeMs: 50 } },
    ],
    [
      { id: 'e_cb_sc', from: { nodeId: 'cb', portId: 'L' }, to: { nodeId: 'sc', portId: 'ch1' }, sourceType: 'audio', targetType: 'audio' },
    ],
  );

  const { peak } = await readScopePeakOverWindow(page, 'sc', CAPTURE_MS);
  expect(peak, 'CUBE must keep droning with no TRIGGER patched (legacy free-run)').toBeGreaterThan(0.01);
  expect(errors, 'no console / page errors').toEqual([]);
});

test('cube no-stray-drone: a TRIGGER patched but NEVER gated is SILENT (gated, not droning)', async ({ page }) => {
  test.setTimeout(timeoutFor(1));
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  // TRIGGER patched from a sequencer that is NOT playing (gate stays 0) → the
  // gate is PATCHED but NEVER goes high. Per the no-stray-drone fix, a patched
  // TRIGGER puts CUBE into GATED mode: a voice sounds only while gated-or-
  // releasing, so a never-gated TRIGGER is SILENT (it does NOT fall through to
  // the legacy drone — that was the bug). The continuous raw VCO is only the
  // truly-unpatched case (covered by the back-compat test above).
  await spawnPatch(
    page,
    [
      { id: 'seq', type: 'sequencer', position: { x: 40, y: 60 }, domain: 'audio', params: { bpm: 240, length: 4, isPlaying: 0, gateLength: 0.6 } },
      { id: 'cb', type: 'cube', position: { x: 360, y: 60 }, domain: 'audio', params: { level: 1 } },
      { id: 'sc', type: 'scope', position: { x: 900, y: 60 }, domain: 'audio', params: { timeMs: 50 } },
    ],
    [
      { id: 'e_seq_cb', from: { nodeId: 'seq', portId: 'gate' }, to: { nodeId: 'cb', portId: 'trigger' }, sourceType: 'gate', targetType: 'gate' },
      { id: 'e_cb_sc', from: { nodeId: 'cb', portId: 'L' }, to: { nodeId: 'sc', portId: 'ch1' }, sourceType: 'audio', targetType: 'audio' },
    ],
  );

  const { peak } = await readScopePeakOverWindow(page, 'sc', CAPTURE_MS);
  expect(peak, 'a patched-but-never-gated TRIGGER must keep CUBE SILENT (no stray drone)').toBeLessThan(0.01);
  expect(errors, 'no console / page errors').toEqual([]);
});

test('wavecel mono TRIGGER gates the per-voice envelope (audio opens on trigger)', async ({ page }) => {
  test.setTimeout(timeoutFor(1));
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      { id: 'seq', type: 'sequencer', position: { x: 40, y: 60 }, domain: 'audio', params: { bpm: 240, length: 4, isPlaying: 1, gateLength: 0.6 } },
      { id: 'wc', type: 'wavecel', position: { x: 360, y: 60 }, domain: 'audio', params: { attack: 0.02, decay: 0.1, sustain: 0.9, release: 0.2 } },
      { id: 'sc', type: 'scope', position: { x: 900, y: 60 }, domain: 'audio', params: { timeMs: 50 } },
    ],
    [
      { id: 'e_seq_wc', from: { nodeId: 'seq', portId: 'gate' }, to: { nodeId: 'wc', portId: 'trigger' }, sourceType: 'gate', targetType: 'gate' },
      { id: 'e_wc_sc', from: { nodeId: 'wc', portId: 'out_l' }, to: { nodeId: 'sc', portId: 'ch1' }, sourceType: 'audio', targetType: 'audio' },
    ],
  );
  await seedSeqSteps(page, 'seq');

  const { peak } = await readScopePeakOverWindow(page, 'sc', CAPTURE_MS);
  expect(peak, 'WAVECEL out_l should carry audio when the TRIGGER gate fires').toBeGreaterThan(0.01);
  expect(errors, 'no console / page errors').toEqual([]);
});

test('cube poly chord (POLYSEQZ → poly) drives the per-voice envelopes', async ({ page }) => {
  test.setTimeout(timeoutFor(1));
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      { id: 'seq', type: 'polyseqz', position: { x: 40, y: 60 }, domain: 'audio', params: { isPlaying: 1, length: 4, bpm: 240, gateLength: 0.6 } },
      { id: 'cb', type: 'cube', position: { x: 360, y: 60 }, domain: 'audio', params: { attack: 0.02, decay: 0.1, sustain: 0.9, release: 0.2, level: 1 } },
      { id: 'sc', type: 'scope', position: { x: 900, y: 60 }, domain: 'audio', params: { timeMs: 50 } },
    ],
    [
      { id: 'e_seq_cb', from: { nodeId: 'seq', portId: 'poly' }, to: { nodeId: 'cb', portId: 'poly' }, sourceType: 'polyPitchGate', targetType: 'polyPitchGate' },
      { id: 'e_cb_sc', from: { nodeId: 'cb', portId: 'L' }, to: { nodeId: 'sc', portId: 'ch1' }, sourceType: 'audio', targetType: 'audio' },
    ],
  );

  // Seed a gated chord so multiple voices play (each lane drives its own env).
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['seq'];
      if (!n) return;
      if (!n.data) n.data = {};
      n.data.steps = [
        { on: true, root: 60, quality: 'maj', inversion: 0, voicing: 'closed' },
        { on: true, root: 64, quality: 'min', inversion: 0, voicing: 'closed' },
        { on: true, root: 67, quality: 'maj', inversion: 0, voicing: 'closed' },
        { on: true, root: 72, quality: 'maj', inversion: 0, voicing: 'closed' },
      ];
    });
  });

  const { peak } = await readScopePeakOverWindow(page, 'sc', CAPTURE_MS);
  expect(peak, 'CUBE L should carry audio when a poly chord gates the voices').toBeGreaterThan(0.01);
  expect(errors, 'no console / page errors').toEqual([]);
});
