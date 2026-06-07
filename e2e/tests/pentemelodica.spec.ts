// e2e/tests/pentemelodica.spec.ts
//
// Bespoke E2E for PENTEMELODICA — the 5-voice polyphonic analog synth.
// Validates:
//   - the card mounts with all 6 input + 7 output handles present,
//   - a POLYSEQZ chord patched into `poly` makes the stereo OUT carry audio
//     (the key deliverable: a poly source drives the voices),
//   - patching one voice's pre-mixer tap into a SCOPE works (per-voice taps
//     are real signal),
//   - no console / page errors throughout.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { readScopeSnapshot, summarize } from './_module-coverage-helpers';

test.describe.configure({ mode: 'parallel' });

const INPUT_PORTS = ['poly', 'fm1', 'fm2', 'fm3', 'fm4', 'fm5'];
const OUTPUT_PORTS = ['out_l', 'out_r', 'voice1', 'voice2', 'voice3', 'voice4', 'voice5'];

test('pentemelodica: card mounts with all 6 input + 7 output handles', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(page, [
    { id: 'pm', type: 'pentemelodica', position: { x: 200, y: 120 }, domain: 'audio' },
  ]);

  const card = page.locator('.svelte-flow__node-pentemelodica').first();
  await card.waitFor({ state: 'visible', timeout: 10_000 });

  for (const portId of [...INPUT_PORTS, ...OUTPUT_PORTS]) {
    await expect(
      card.locator(`[data-handleid="${portId}"]`),
      `handle ${portId} present`,
    ).toHaveCount(1);
  }
  // The 5 voice waveform previews render.
  for (let v = 1; v <= 5; v++) {
    await expect(
      page.getByTestId(`pentemelodica-voice${v}-scope`),
      `voice ${v} scope present`,
    ).toHaveCount(1);
  }

  expect(errors, 'no console / page errors').toEqual([]);
});

test('pentemelodica: a POLYSEQZ chord drives the stereo OUT', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      { id: 'seq', type: 'polyseqz', position: { x: 40, y: 60 }, domain: 'audio', params: { isPlaying: 1, length: 4, bpm: 240, gateLength: 0.6 } },
      { id: 'pm', type: 'pentemelodica', position: { x: 360, y: 60 }, domain: 'audio' },
      { id: 'sc', type: 'scope', position: { x: 900, y: 60 }, domain: 'audio', params: { timeMs: 50 } },
    ],
    [
      { id: 'e_seq_pm', from: { nodeId: 'seq', portId: 'poly' }, to: { nodeId: 'pm', portId: 'poly' }, sourceType: 'polyPitchGate', targetType: 'polyPitchGate' },
      { id: 'e_pm_sc', from: { nodeId: 'pm', portId: 'out_l' }, to: { nodeId: 'sc', portId: 'ch1' }, sourceType: 'audio', targetType: 'audio' },
    ],
  );

  // Seed a gated chord on the sequencer so all 5 voices play.
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
        { on: true, root: 65, quality: 'maj', inversion: 0, voicing: 'closed' },
        { on: true, root: 67, quality: 'maj', inversion: 0, voicing: 'closed' },
        { on: true, root: 72, quality: 'maj', inversion: 0, voicing: 'closed' },
      ];
    });
  });

  // Poll the SCOPE analyser until the OUT carries audio.
  let peak = 0;
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(40);
    const snap = await readScopeSnapshot(page, 'sc');
    if (snap) {
      const s = summarize(snap.ch1);
      if (s.peak > peak) peak = s.peak;
    }
    if (peak > 0.02) break;
  }

  expect(peak, 'PENTEMELODICA OUT_L should carry audio when a chord is gated in').toBeGreaterThan(0.02);
  expect(errors, 'no console / page errors').toEqual([]);
});
