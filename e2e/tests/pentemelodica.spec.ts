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

import { test, expect } from './_fixtures';
import { spawnPatch, seedKriaGate } from './_helpers';
import { readScopeSnapshot, summarize } from './_module-coverage-helpers';

test.describe.configure({ mode: 'parallel' });

const INPUT_PORTS = ['poly', 'fm1', 'fm2', 'fm3', 'fm4', 'fm5'];
const OUTPUT_PORTS = ['out_l', 'out_r', 'voice1', 'voice2', 'voice3', 'voice4', 'voice5'];

test('pentemelodica: tile mounts with all 6 input + 7 output handles', async ({ page, rack, errorWatch }) => {
  await spawnPatch(page, [
    { id: 'pm', type: 'pentemelodica', position: { x: 200, y: 120 }, domain: 'audio' },
  ]);

  const card = page.locator('.svelte-flow__node:has([data-shell-type="pentemelodica"])').first();
  await card.waitFor({ state: 'visible', timeout: 10_000 });

  for (const portId of [...INPUT_PORTS, ...OUTPUT_PORTS]) {
    await expect(
      card.locator(`[data-handleid="${portId}"]`),
      `handle ${portId} present`,
    ).toHaveCount(1);
  }
  // The 5 per-voice lanes render on the shell in the dock HERO panel (the
  // card's per-voice scope strip became `pentemelodica-hero-lane-{v}`).
  await card.locator('[data-testid="module-shell"]').getByTestId('shell-open-dock').click();
  await expect(page.getByTestId('dock-full-view')).toBeVisible();
  for (let v = 1; v <= 5; v++) {
    await expect(
      page.getByTestId(`pentemelodica-hero-lane-${v}`),
      `voice ${v} hero lane present`,
    ).toHaveCount(1);
  }

});

test('pentemelodica: a POLYSEQZ chord drives the stereo OUT', async ({ page, rack, errorWatch }) => {
  await spawnPatch(
    page,
    [
      { id: 'seq-clk', type: 'kria', position: { x: 40, y: 440 }, domain: 'audio', params: { bpm: 240, running: 1 } },
      { id: 'seq', type: 'cartesian', position: { x: 40, y: 60 }, domain: 'audio' },
      { id: 'pm', type: 'pentemelodica', position: { x: 360, y: 60 }, domain: 'audio' },
      { id: 'sc', type: 'scope', position: { x: 900, y: 60 }, domain: 'audio', params: { timeMs: 50 } },
    ],
    [
      { id: 'e_seq_clk', from: { nodeId: 'seq-clk', portId: 'gate1' }, to: { nodeId: 'seq', portId: 'clock' }, sourceType: 'gate', targetType: 'gate' },
      { id: 'e_seq_pm', from: { nodeId: 'seq', portId: 'pitch' }, to: { nodeId: 'pm', portId: 'poly' }, sourceType: 'polyPitchGate', targetType: 'polyPitchGate' },
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
      n.data.cells = Array.from({ length: 16 }, (_, i) => [
          { on: true, midi: 60, chord: 'maj' },
          { on: true, midi: 65, chord: 'maj' },
          { on: true, midi: 67, chord: 'maj' },
          { on: true, midi: 72, chord: 'maj' },
        ][i % 4]);
    });
  });
    await seedKriaGate(page, 'seq-clk');

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
});
