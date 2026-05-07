// e2e/tests/note-entry.spec.ts
//
// D5 — Sequencer + Cartesian text-entry note input.
//
// Coverage:
//   - Sequencer: type a note name into a step's pitch input, assert displayed
//     value normalizes (e.g. 'A4' -> 'a4', 'db5' -> 'c#5'), invalid input
//     leaves the step's MIDI null, the focus ring is green/red accordingly.
//   - Cartesian: same flow on the 4x4 grid.
//   - Migration: a legacy step shape ({on, pitch}) loaded into the patch is
//     normalized to {on, midi} on read, and the underlying audio param value
//     reflects the correct V/oct.
//   - Audio truth: a Sequencer with one step at 'a4' fires a 440 Hz tone
//     through the wavetable VCO; we verify the V/oct on the pitch ConstantSource
//     output equals (69-60)/12 = 0.75 V.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

test('note-entry: typing valid notes into Sequencer steps normalizes display + drives V/oct', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(page, [
    { id: 'seq', type: 'sequencer', params: { bpm: 120, length: 4, isPlaying: 0 } },
  ]);

  // Type 'A4' (uppercase) into step 0's pitch input. Expect normalized 'a4' on blur.
  const step0 = page.locator('[data-testid="seq-pitch-seq-0"]');
  await step0.focus();
  await step0.fill('A4');
  await step0.blur();
  await expect(step0).toHaveValue('a4');

  // Verify the underlying patch state shows midi 69.
  const seqData = await page.evaluate(() => {
    const w = globalThis as unknown as { __patch: { nodes: Record<string, { data?: { steps?: Array<{ on: boolean; midi: number | null }> } }> } };
    return w.__patch.nodes['seq']?.data?.steps?.[0] ?? null;
  });
  expect(seqData).toEqual({ on: false, midi: 69 });

  // Flat form maps to sharp: 'db5' -> displayed as 'c#5', stored as MIDI 73.
  const step1 = page.locator('[data-testid="seq-pitch-seq-1"]');
  await step1.focus();
  await step1.fill('db5');
  await step1.blur();
  await expect(step1).toHaveValue('c#5');

  const step1Data = await page.evaluate(() => {
    const w = globalThis as unknown as { __patch: { nodes: Record<string, { data?: { steps?: Array<{ on: boolean; midi: number | null }> } }> } };
    return w.__patch.nodes['seq']?.data?.steps?.[1] ?? null;
  });
  expect(step1Data?.midi).toBe(73);

  // Whitespace / case-insensitive: ' c # 3 ' -> 'c#3'.
  const step2 = page.locator('[data-testid="seq-pitch-seq-2"]');
  await step2.focus();
  await step2.fill(' c # 3 ');
  await step2.blur();
  await expect(step2).toHaveValue('c#3');
});

test('note-entry: invalid input keeps midi null + the input ring goes red on focus', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(page, [
    { id: 'seq', type: 'sequencer', params: { bpm: 120, length: 4, isPlaying: 0 } },
  ]);

  const step = page.locator('[data-testid="seq-pitch-seq-0"]');
  await step.focus();
  await step.fill('q7');
  // While focused with invalid content, the input has the .invalid class.
  await expect(step).toHaveClass(/invalid/);
  await step.blur();
  // Stored midi should be null (parser rejected 'q7').
  const stored = await page.evaluate(() => {
    const w = globalThis as unknown as { __patch: { nodes: Record<string, { data?: { steps?: Array<{ on: boolean; midi: number | null }> } }> } };
    return w.__patch.nodes['seq']?.data?.steps?.[0] ?? null;
  });
  expect(stored?.midi).toBeNull();

  // After commit, displayed value should be empty (no canonical name for null).
  await expect(step).toHaveValue('');
});

test('note-entry: out-of-range note (g8 above f#8) becomes null', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'seq', type: 'sequencer', params: { bpm: 120, length: 4 } }]);

  const step = page.locator('[data-testid="seq-pitch-seq-0"]');
  await step.focus();
  await step.fill('g8');
  await step.blur();
  const stored = await page.evaluate(() => {
    const w = globalThis as unknown as { __patch: { nodes: Record<string, { data?: { steps?: Array<{ on: boolean; midi: number | null }> } }> } };
    return w.__patch.nodes['seq']?.data?.steps?.[0] ?? null;
  });
  expect(stored?.midi).toBeNull();
});

test('note-entry: Cartesian cell accepts text-entry note names', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(page, [
    { id: 'cart', type: 'cartesian', params: { mode: 0 } },
  ]);

  const c0 = page.locator('[data-testid="cart-pitch-cart-0"]');
  await c0.focus();
  await c0.fill('a4');
  await c0.blur();
  await expect(c0).toHaveValue('a4');

  const c5 = page.locator('[data-testid="cart-pitch-cart-5"]');
  await c5.focus();
  await c5.fill('F#8');
  await c5.blur();
  await expect(c5).toHaveValue('f#8');

  const cellsData = await page.evaluate(() => {
    const w = globalThis as unknown as { __patch: { nodes: Record<string, { data?: { cells?: Array<{ on: boolean; midi: number | null }> } }> } };
    return w.__patch.nodes['cart']?.data?.cells ?? null;
  });
  expect(cellsData?.[0]?.midi).toBe(69);
  expect(cellsData?.[5]?.midi).toBe(114);
});

test('note-entry: gate button toggles step.on without touching the pitch input', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'seq', type: 'sequencer', params: { bpm: 120, length: 4 } }]);

  const pitchEl = page.locator('[data-testid="seq-pitch-seq-0"]');
  await pitchEl.focus();
  await pitchEl.fill('e4');
  await pitchEl.blur();

  const gate = page.locator('[data-testid="seq-gate-seq-0"]');
  await gate.click();
  const stepData = await page.evaluate(() => {
    const w = globalThis as unknown as { __patch: { nodes: Record<string, { data?: { steps?: Array<{ on: boolean; midi: number | null }> } }> } };
    return w.__patch.nodes['seq']?.data?.steps?.[0] ?? null;
  });
  expect(stepData).toEqual({ on: true, midi: 64 });
});

test('note-entry: legacy {on, pitch} step shape migrates to {on, midi} at read time', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(page, [
    { id: 'seq', type: 'sequencer', params: { bpm: 120, length: 4, isPlaying: 0 } },
  ]);

  // Inject legacy step shape directly into the SyncedStore. The card's
  // $derived(coerceToNoteStep) should normalize on read.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      w.__patch.nodes['seq'].data = {
        steps: [
          { on: true, pitch: 0 },   // legacy: pitch 0 = C4 = MIDI 60
          { on: true, pitch: 9 },   // legacy: A4 = pitch 9 from C4 = MIDI 69
          { on: false, pitch: 0 },
          { on: true, pitch: -12 }, // legacy: C3 = MIDI 48
        ],
      };
    });
  });

  // The card reads via coerceToNoteStep, so the displayed input should show
  // canonical sharp note names regardless of how the data was injected.
  await expect(page.locator('[data-testid="seq-pitch-seq-0"]')).toHaveValue('c4');
  await expect(page.locator('[data-testid="seq-pitch-seq-1"]')).toHaveValue('a4');
  await expect(page.locator('[data-testid="seq-pitch-seq-3"]')).toHaveValue('c3');
});

test('note-entry: a4 step drives the pitch port to V/oct 0.75 (MIDI 69 - 60 = 9 semis up)', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(page, [
    { id: 'seq', type: 'sequencer', params: { bpm: 240, length: 4, isPlaying: 1, gateLength: 0.9 } },
  ]);

  // Set step 0 to a4 (MIDI 69), gate on. Other steps off so pitch dwells at 0.75 V.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      w.__patch.nodes['seq'].data = {
        steps: [
          { on: true, midi: 69 },
          { on: false, midi: null },
          { on: false, midi: null },
          { on: false, midi: null },
        ],
      };
    });
  });

  // Wait for the sequencer to fire step 0 at least once. At 240 BPM 16th-notes
  // = 16 steps/sec, so within a few hundred ms we'll have hit step 0.
  await page.waitForTimeout(800);

  // Read the pitch ConstantSource's current offset.value via engine.read().
  // Expected: 0.75 V (= (MIDI 69 - 60) / 12 = 9/12). This is what the VCO
  // sees on its pitch input and which drives 261.626 * 2^0.75 = 440 Hz.
  const vOct = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __engine?: () => { read: (n: { id: string; type: string; domain: string }, k: string) => unknown } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    if (!eng) return null;
    const node = w.__patch.nodes['seq'];
    const v = eng.read(node, 'pitchVOct');
    return typeof v === 'number' ? v : null;
  });

  expect(vOct, `pitch port should emit V/oct 0.75 for a4`).not.toBeNull();
  expect(Math.abs((vOct as number) - 0.75)).toBeLessThan(1e-6);

  // Sanity: 0.75 V/oct -> 261.626 * 2^0.75 = 440 Hz
  const reconstructedHz = 261.626 * Math.pow(2, vOct as number);
  expect(Math.abs(reconstructedHz - 440)).toBeLessThan(0.5);
});

test('note-entry: invalid step (midi=null) suppresses gate output even when on=true', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(page, [
    { id: 'seq', type: 'sequencer', params: { bpm: 240, length: 1, isPlaying: 1, gateLength: 0.9 } },
  ]);

  // Single step with on=true but midi=null. Sequencer should skip the gate.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      w.__patch.nodes['seq'].data = {
        steps: [{ on: true, midi: null }],
      };
    });
  });

  // Sample the gate value over a few hundred ms — if the parser were emitting
  // anyway, we'd see the gate go high. Expect it to stay 0 the entire time.
  await page.waitForTimeout(400);
  const samples = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __engine?: () => { read: (n: { id: string; type: string; domain: string }, k: string) => unknown } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    if (!eng) return null;
    const node = w.__patch.nodes['seq'];
    const out: number[] = [];
    for (let i = 0; i < 6; i++) {
      const v = eng.read(node, 'gateValue');
      out.push(typeof v === 'number' ? v : NaN);
    }
    return out;
  });
  expect(samples).not.toBeNull();
  for (const s of samples!) {
    expect(s, `gate must stay low when step.midi is null even if on=true`).toBe(0);
  }
});
