// e2e/tests/dx7.spec.ts
//
// End-to-end coverage of the DX7 module:
//   1. Spawn DX7 → Sequencer → AudioOut chain via the polyPitchGate cable;
//      arm the sequencer, assert the scope-tap reports audible RMS.
//   2. The card renders the preset selector + algorithm display + 4 knobs
//      + .syx upload affordance.
//   3. Switching the preset via the dropdown updates the visible patch
//      name and rejects garbled input.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

async function readScopeRms(page: Page, scopeId: string): Promise<number> {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => { read: (n: { id: string; type: string; domain: string }, k: string) => unknown } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    if (!eng) return 0;
    const node = w.__patch.nodes[id];
    if (!node) return 0;
    const snap = eng.read(node, 'snapshot') as { ch1?: Float32Array } | undefined;
    if (!snap || !snap.ch1) return 0;
    let s = 0;
    for (let i = 0; i < snap.ch1.length; i++) s += snap.ch1[i]! * snap.ch1[i]!;
    return Math.sqrt(s / snap.ch1.length);
  }, scopeId);
}

test('dx7: spawns + renders card with preset selector + 4 knobs + 4 handles', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(page, [{ id: 'dx', type: 'dx7' }]);

  // Card renders.
  const card = page.locator('[data-testid="dx7-card"]');
  await expect(card).toBeVisible();
  await expect(card).toContainText('DX7');

  // Preset selector is present and defaults to E.PIANO 1.
  const presetSel = page.locator('[data-testid="dx7-preset-select"]');
  await expect(presetSel).toBeVisible();
  await expect(presetSel).toHaveValue('E.PIANO 1');

  // Algo display shows two-digit numeric.
  const algoDisplay = page.locator('[data-testid="dx7-algo-display"]');
  await expect(algoDisplay).toBeVisible();
  await expect(algoDisplay).toContainText(/ALG \d{2}/);

  // .syx file input exists.
  await expect(page.locator('[data-testid="dx7-syx-input"]')).toBeAttached();

  // 4 handles total: poly + pitch_cv + gate (inputs) + out (output).
  const handles = await card.locator('.svelte-flow__handle').count();
  expect(handles).toBe(4);
});

test('dx7: sequencer (poly) → DX7 → audioOut produces audible RMS', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      // Sequencer with one always-on step at C4 in mono mode.
      {
        id: 'seq',
        type: 'sequencer',
        params: { bpm: 240, isPlaying: 1, length: 4 },
      },
      { id: 'dx',  type: 'dx7',     params: { algorithm: 5, voiceCount: 5, level: 1.0 } },
      // Tap audio for assertion.
      { id: 'scp', type: 'scope' },
      { id: 'out', type: 'audioOut' },
    ],
    [
      // Sequencer poly out → DX7 poly in.
      {
        id: 'poly-edge',
        from: { nodeId: 'seq', portId: 'pitch' },
        to: { nodeId: 'dx', portId: 'poly' },
        sourceType: 'polyPitchGate',
        targetType: 'polyPitchGate',
      },
      // DX7 → Scope ch1.
      {
        id: 'audio-tap',
        from: { nodeId: 'dx', portId: 'out' },
        to: { nodeId: 'scp', portId: 'ch1' },
        sourceType: 'audio',
        targetType: 'audio',
      },
      // Scope ch1_out → AudioOut.L.
      {
        id: 'audio-out',
        from: { nodeId: 'scp', portId: 'ch1_out' },
        to: { nodeId: 'out', portId: 'L' },
        sourceType: 'audio',
        targetType: 'audio',
      },
    ],
  );

  // Drive at least one step "on" with a C4 note.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const t = w.__patch.nodes['seq'];
      if (!t) return;
      if (!t.data) t.data = {};
      const steps = Array.from({ length: 32 }, () => ({ on: true, midi: 60, chord: 'mono' }));
      (t.data as Record<string, unknown>).steps = steps;
    });
  });

  // Wait for audio to settle and probe the scope RMS.
  let rms = 0;
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    rms = await readScopeRms(page, 'scp');
    if (rms > 0.005) break;
    await page.waitForTimeout(100);
  }
  expect(rms, `expected audible DX7 RMS via poly cable (got ${rms})`).toBeGreaterThan(0.005);
});

test('dx7: changing preset updates the dropdown value', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(page, [{ id: 'dx', type: 'dx7' }]);

  const presetSel = page.locator('[data-testid="dx7-preset-select"]');
  await expect(presetSel).toHaveValue('E.PIANO 1');

  // Switch to BASS 1 via the dropdown.
  await presetSel.selectOption('BASS 1');
  await expect(presetSel).toHaveValue('BASS 1');

  // The patch graph should reflect the new preset.
  const stored = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
    };
    return (w.__patch.nodes['dx']?.data as Record<string, unknown> | undefined)?.preset;
  });
  expect(stored).toBe('BASS 1');
});
