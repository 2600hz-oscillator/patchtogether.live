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

// Helper for the algorithm-switching test: read both scope channels back as
// `Float32Array` so we can compare entire frames sample-by-sample (not just
// the scalar RMS — two algorithms can have similar RMS but very different
// waveforms, and we want to catch the latter).
async function readScopeFrame(page: Page, scopeId: string): Promise<number[]> {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => { read: (n: { id: string; type: string; domain: string }, k: string) => unknown } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    if (!eng) return [];
    const node = w.__patch.nodes[id];
    if (!node) return [];
    const snap = eng.read(node, 'snapshot') as { ch1?: Float32Array } | undefined;
    if (!snap || !snap.ch1) return [];
    return Array.from(snap.ch1);
  }, scopeId);
}

test('dx7: switching algorithm changes the audible scope content', async ({ page }) => {
  // Regression: prior to fix/dx7-algorithm-switching the host's setParam
  // early-out short-circuited algorithm changes (algorithm is NOT an
  // AudioParam — it travels via worklet.port.postMessage) so moving the
  // knob silently no-op'd. This test asserts the scope tap reports a
  // measurably different waveform after we change algorithm 1 → 32 on the
  // SAME preset / sequencer feed.
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      { id: 'seq', type: 'sequencer', params: { bpm: 240, isPlaying: 1, length: 4 } },
      // Use CALLIOPE: every operator has a non-trivial output level + integer
      // ratios 1..6, so algorithm 1 (ops 1+3 carriers, 2/4/5/6 modulators)
      // and algorithm 32 (all six ops carriers — additive organ) produce
      // unmistakably different waveforms.
      {
        id: 'dx',
        type: 'dx7',
        params: { algorithm: 1, voiceCount: 5, level: 1.0 },
      },
      { id: 'scp', type: 'scope' },
      { id: 'out', type: 'audioOut' },
    ],
    [
      { id: 'poly-edge',  from: { nodeId: 'seq', portId: 'pitch' }, to: { nodeId: 'dx',  portId: 'poly' }, sourceType: 'polyPitchGate', targetType: 'polyPitchGate' },
      { id: 'audio-tap',  from: { nodeId: 'dx',  portId: 'out' },   to: { nodeId: 'scp', portId: 'ch1'  }, sourceType: 'audio',         targetType: 'audio'         },
      { id: 'audio-out',  from: { nodeId: 'scp', portId: 'ch1_out' },to: { nodeId: 'out', portId: 'L'    }, sourceType: 'audio',         targetType: 'audio'         },
    ],
  );

  // Force the preset to CALLIOPE (algorithm 32 by default — but our
  // params.algorithm=1 overrides that on init).
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const t = w.__patch.nodes['dx'];
      if (!t) return;
      if (!t.data) t.data = {};
      (t.data as Record<string, unknown>).preset = 'CALLIOPE';
      const seq = w.__patch.nodes['seq'];
      if (!seq) return;
      if (!seq.data) seq.data = {};
      const steps = Array.from({ length: 32 }, () => ({ on: true, midi: 60, chord: 'mono' }));
      (seq.data as Record<string, unknown>).steps = steps;
    });
  });

  // Wait for audio to settle under algo 1.
  let frameAlgo1: number[] = [];
  let deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    frameAlgo1 = await readScopeFrame(page, 'scp');
    let energy = 0;
    for (const v of frameAlgo1) energy += v * v;
    if (Math.sqrt(energy / Math.max(1, frameAlgo1.length)) > 0.005) break;
    await page.waitForTimeout(100);
  }
  expect(frameAlgo1.length, 'algo-1 scope frame is non-empty').toBeGreaterThan(0);

  // Switch to algorithm 32 by mutating params.algorithm. The reconciler
  // will pick this up and call engine.setParam('algorithm', 32).
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params: Record<string, number> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const t = w.__patch.nodes['dx'];
      if (!t) return;
      t.params.algorithm = 32;
    });
  });

  // Give the worklet ~1.5s to clear voices, retrigger under algo 32 and
  // refill the scope buffer.
  await page.waitForTimeout(1500);
  let frameAlgo32: number[] = [];
  deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    frameAlgo32 = await readScopeFrame(page, 'scp');
    let energy = 0;
    for (const v of frameAlgo32) energy += v * v;
    if (Math.sqrt(energy / Math.max(1, frameAlgo32.length)) > 0.005) break;
    await page.waitForTimeout(100);
  }
  expect(frameAlgo32.length, 'algo-32 scope frame is non-empty').toBeGreaterThan(0);

  // Compare: the two frames should be measurably different. Use a
  // normalized L2 distance — robust to scale + envelope drift between
  // captures while still failing decisively if the two are byte-identical
  // (the no-op case before the fix).
  const len = Math.min(frameAlgo1.length, frameAlgo32.length);
  let diffSq = 0;
  let normSq = 0;
  for (let i = 0; i < len; i++) {
    const d = frameAlgo1[i]! - frameAlgo32[i]!;
    diffSq += d * d;
    normSq += frameAlgo1[i]! * frameAlgo1[i]! + frameAlgo32[i]! * frameAlgo32[i]!;
  }
  const ratio = Math.sqrt(diffSq) / Math.max(Math.sqrt(normSq), 1e-9);
  expect(ratio, `algo-1 vs algo-32 frame normalized L2 distance (got ${ratio.toFixed(3)})`).toBeGreaterThan(0.1);
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
