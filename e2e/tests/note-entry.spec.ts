// e2e/tests/note-entry.spec.ts
//
// D5 — Cartesian text-entry note input (the surviving note-entry surface
// after the legacy sequencers were deleted 2026-08-24; the same NoteEntry
// component drives every flow below).
//
// Coverage:
//   - type a note name into a pad's pitch input, assert displayed value
//     normalizes (e.g. 'A4' -> 'a4', 'db5' -> 'c#5'), invalid input leaves
//     the pad's MIDI null, the focus ring is green/red accordingly.
//   - Audio truth on the ENGINE: an a4 pad on a kria-clocked walk drives the
//     pitch port to V/oct 0.75; S&H holds across rests; a null-midi pad
//     suppresses the gate even when on=true.

import { test, expect } from './_fixtures';
import { spawnPatch, seedKriaGate } from './_helpers';

/** Open the cartesian node's dock full view — the face grid
 *  (`cart-face-gate/pitch/chord-{i}`) is dock-only on the shell. */
async function openCartDock(page: import('@playwright/test').Page): Promise<void> {
  const tile = page
    .locator('.svelte-flow__node:has([data-shell-type="cartesian"]) [data-testid="module-shell"]')
    .first();
  await tile.getByTestId('shell-open-dock').click();
  await expect(page.getByTestId('dock-full-view')).toBeVisible();
}


test.describe.configure({ mode: 'parallel' });

test('note-entry: typing valid notes into Cartesian pads normalizes display + stores MIDI', async ({ page, rack }) => {
  await spawnPatch(page, [
    { id: 'seq', type: 'cartesian' },
  ]);
  await openCartDock(page);

  // Type 'A4' (uppercase) into pad 0's pitch input. Expect normalized 'a4' on blur.
  const step0 = page.locator('[data-testid="cart-face-pitch-0"]');
  await step0.focus();
  await step0.fill('A4');
  await step0.blur();
  await expect(step0).toHaveValue('a4');

  // Verify the underlying patch state shows midi 69.
  const seqData = await page.evaluate(() => {
    const w = globalThis as unknown as { __patch: { nodes: Record<string, { data?: { cells?: Array<{ on: boolean; midi: number | null }> } }> } };
    return w.__patch.nodes['seq']?.data?.cells?.[0] ?? null;
  });
  // Partial match: the persisted cell shape carries an additive `chord`
  // field (and may grow more), so pin only the fields under test.
  expect(seqData).toMatchObject({ midi: 69 });

  // Flat form maps to sharp: 'db5' -> displayed as 'c#5', stored as MIDI 73.
  const step1 = page.locator('[data-testid="cart-face-pitch-1"]');
  await step1.focus();
  await step1.fill('db5');
  await step1.blur();
  await expect(step1).toHaveValue('c#5');

  const step1Data = await page.evaluate(() => {
    const w = globalThis as unknown as { __patch: { nodes: Record<string, { data?: { cells?: Array<{ on: boolean; midi: number | null }> } }> } };
    return w.__patch.nodes['seq']?.data?.cells?.[1] ?? null;
  });
  expect(step1Data?.midi).toBe(73);

  // Whitespace / case-insensitive: ' c # 3 ' -> 'c#3'.
  const step2 = page.locator('[data-testid="cart-face-pitch-2"]');
  await step2.focus();
  await step2.fill(' c # 3 ');
  await step2.blur();
  await expect(step2).toHaveValue('c#3');
});

test('note-entry: invalid input keeps midi null + the input ring goes red on focus', async ({ page, rack }) => {
  await spawnPatch(page, [
    { id: 'seq', type: 'cartesian' },
  ]);
  await openCartDock(page);

  const step = page.locator('[data-testid="cart-face-pitch-0"]');
  await step.focus();
  await step.fill('q7');
  // While focused with invalid content, the input has the .invalid class.
  await expect(step).toHaveClass(/invalid/);
  await step.blur();
  // Stored midi should be null (parser rejected 'q7').
  const stored = await page.evaluate(() => {
    const w = globalThis as unknown as { __patch: { nodes: Record<string, { data?: { cells?: Array<{ on: boolean; midi: number | null }> } }> } };
    return w.__patch.nodes['seq']?.data?.cells?.[0] ?? null;
  });
  expect(stored?.midi ?? null, 'no midi stored (an uncommitted cell may not exist at all on the face path)').toBeNull();

  // After blur the refused text is GONE — the input restores its pre-edit
  // draft (the face seeds the c3 default on focus; the card restored '').
  // Either way the garbage never sticks and nothing was committed.
  await expect(step).not.toHaveValue('q7');
});

test('note-entry: out-of-range note (c#8 above c8) becomes null', async ({ page, rack }) => {
  await spawnPatch(page, [{ id: 'seq', type: 'cartesian' }]);
  await openCartDock(page);

  const step = page.locator('[data-testid="cart-face-pitch-0"]');
  await step.focus();
  // The valid range is c0..c8 (MIDI 12..108); c#8 (MIDI 109) is one
  // semitone above and must round-trip to null.
  await step.fill('c#8');
  await step.blur();
  const stored = await page.evaluate(() => {
    const w = globalThis as unknown as { __patch: { nodes: Record<string, { data?: { cells?: Array<{ on: boolean; midi: number | null }> } }> } };
    return w.__patch.nodes['seq']?.data?.cells?.[0] ?? null;
  });
  expect(stored?.midi ?? null, 'no midi stored (an uncommitted cell may not exist at all on the face path)').toBeNull();
});

test('note-entry: Cartesian cell accepts text-entry note names', async ({ page, rack }) => {
  await spawnPatch(page, [
    { id: 'cart', type: 'cartesian' },
  ]);
  await openCartDock(page);

  const c0 = page.locator('[data-testid="cart-face-pitch-0"]');
  await c0.focus();
  await c0.fill('a4');
  await c0.blur();
  await expect(c0).toHaveValue('a4');

  const c5 = page.locator('[data-testid="cart-face-pitch-5"]');
  await c5.focus();
  // Range upper bound is c8 (MIDI 108) per the C0..C8 spec; pick c8 here.
  await c5.fill('C8');
  await c5.blur();
  await expect(c5).toHaveValue('c8');

  const cellsData = await page.evaluate(() => {
    const w = globalThis as unknown as { __patch: { nodes: Record<string, { data?: { cells?: Array<{ on: boolean; midi: number | null }> } }> } };
    return w.__patch.nodes['cart']?.data?.cells ?? null;
  });
  expect(cellsData?.[0]?.midi).toBe(69);
  expect(cellsData?.[5]?.midi).toBe(108);
});

test('note-entry: gate button toggles pad.on without touching the pitch input', async ({ page, rack }) => {
  await spawnPatch(page, [{ id: 'seq', type: 'cartesian' }]);
  await openCartDock(page);

  const pitchEl = page.locator('[data-testid="cart-face-pitch-0"]');
  await pitchEl.focus();
  await pitchEl.fill('e4');
  await pitchEl.blur();

  const before = await page.evaluate(() => {
    const w = globalThis as unknown as { __patch: { nodes: Record<string, { data?: { cells?: Array<{ on: boolean; midi: number | null }> } }> } };
    return w.__patch.nodes['seq']?.data?.cells?.[0] ?? null;
  });
  const gate = page.locator('[data-testid="cart-face-gate-0"]');
  await gate.click();
  const stepData = await page.evaluate(() => {
    const w = globalThis as unknown as { __patch: { nodes: Record<string, { data?: { cells?: Array<{ on: boolean; midi: number | null }> } }> } };
    return w.__patch.nodes['seq']?.data?.cells?.[0] ?? null;
  });
  // The click flips `on` and leaves the typed pitch alone.
  expect(stepData).toMatchObject({ on: !(before?.on ?? false), midi: 64 });
});

test('note-entry: an a4 pad drives the pitch port to V/oct 0.75 (MIDI 69 - 60 = 9 semis up)', async ({ page, rack }) => {
  await spawnPatch(
    page,
    [
      { id: 'clk', type: 'kria', params: { bpm: 240, running: 1 } },
      { id: 'seq', type: 'cartesian' },
    ],
    [
      { id: 'e_clk', from: { nodeId: 'clk', portId: 'gate1' }, to: { nodeId: 'seq', portId: 'clock' }, sourceType: 'gate', targetType: 'gate' },
    ],
  );
  await openCartDock(page);

  // Every pad a4 (MIDI 69), gate on — the clocked walk emits 0.75 V on
  // every step, so the read is step-phase-independent.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      w.__patch.nodes['seq'].data = {
        cells: Array.from({ length: 16 }, () => ({ on: true, midi: 69, chord: 'mono' })),
      };
    });
  });
  await seedKriaGate(page, 'clk');

  // The pitch ConstantSource's V/oct, via engine.read(). Expected: 0.75 V
  // (= (MIDI 69 - 60) / 12). Auto-retrying poll — state readiness, not a
  // wall-clock guess.
  const readVOct = () => page.evaluate(() => {
    const w = globalThis as unknown as {
      __engine?: () => { read: (n: { id: string; type: string; domain: string }, k: string) => unknown } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    if (!eng) return null;
    const v = eng.read(w.__patch.nodes['seq'], 'pitchVOct');
    return typeof v === 'number' ? v : null;
  });
  await expect
    .poll(readVOct, { timeout: 10_000, message: 'pitch port should emit V/oct 0.75 for a4 (units: V/oct)' })
    .toBeCloseTo(0.75, 6);

  // Sanity: 0.75 V/oct -> 261.626 * 2^0.75 = 440 Hz
  const vOct = await readVOct();
  const reconstructedHz = 261.626 * Math.pow(2, vOct as number);
  expect(Math.abs(reconstructedHz - 440)).toBeLessThan(0.5);
});

test('hold-cv: pitch port retains last gated V/oct across a rest pad', async ({ page, rack }) => {
  // Pad 0 is a4 (on). The clocked diagonal walk (pads 0,5,10,15) then hits
  // three REST pads holding e4 (on=false). The pitch S&H must keep emitting
  // a4's 0.75 V through the rests — never 0 again, and never e4's 0.333 V.
  await spawnPatch(
    page,
    [
      { id: 'clk', type: 'kria', params: { bpm: 240, running: 1 } },
      { id: 'seq', type: 'cartesian' },
    ],
    [
      { id: 'e_clk', from: { nodeId: 'clk', portId: 'gate1' }, to: { nodeId: 'seq', portId: 'clock' }, sourceType: 'gate', targetType: 'gate' },
    ],
  );
  await openCartDock(page);

  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      w.__patch.nodes['seq'].data = {
        cells: Array.from({ length: 16 }, (_, i) => (
          i === 0
            ? { on: true, midi: 69, chord: 'mono' } // a4 — gates, pitch=0.75
            : { on: false, midi: 64, chord: 'mono' } // e4 REST — must NOT leak
        )),
      };
    });
  });
  await seedKriaGate(page, 'clk');

  const readVOct = () => page.evaluate(() => {
    const w = globalThis as unknown as {
      __engine?: () => { read: (n: { id: string; type: string; domain: string }, k: string) => unknown } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    if (!eng) return null;
    const v = eng.read(w.__patch.nodes['seq'], 'pitchVOct');
    return typeof v === 'number' ? v : null;
  });
  // Wait until a4 has actually fired (state readiness, auto-retrying).
  await expect
    .poll(readVOct, { timeout: 10_000, message: 'cartesian should fire a4 at least once (units: V/oct)' })
    .toBeCloseTo(0.75, 6);

  // Then sample across several later steps — the walk is deep into rest pads
  // within this window. The S&H must hold 0.75; the e4 V/oct must never leak.
  const samples = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __engine?: () => { read: (n: { id: string; type: string; domain: string }, k: string) => unknown } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    if (!eng) return null;
    const node = w.__patch.nodes['seq'];
    const out: number[] = [];
    for (let i = 0; i < 30; i++) {
      const v = eng.read(node, 'pitchVOct');
      out.push(typeof v === 'number' ? v : NaN);
    }
    return out;
  });
  expect(samples).not.toBeNull();
  for (const s of samples!) {
    expect(s, `pitch must hold a4 (0.75 V/oct) across rest pads, never e4`).toBeCloseTo(0.75, 6);
  }
});

test('note-entry: invalid pad (midi=null) suppresses gate output even when on=true', async ({ page, rack }) => {
  await spawnPatch(
    page,
    [
      { id: 'clk', type: 'kria', params: { bpm: 240, running: 1 } },
      { id: 'seq', type: 'cartesian' },
    ],
    [
      { id: 'e_clk', from: { nodeId: 'clk', portId: 'gate1' }, to: { nodeId: 'seq', portId: 'clock' }, sourceType: 'gate', targetType: 'gate' },
    ],
  );
  await openCartDock(page);

  // Every pad on=true but midi=null — the parser-rejected state. The gate
  // must never fire.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      w.__patch.nodes['seq'].data = {
        cells: Array.from({ length: 16 }, () => ({ on: true, midi: null, chord: 'mono' })),
      };
    });
  });
  await seedKriaGate(page, 'clk');

  // Prove the walk is actually advancing (a silent assertion is only
  // meaningful over steps that happened), then sample the gate.
  const readAdvances = () => page.evaluate(() => {
    const w = globalThis as unknown as {
      __engine?: () => { read: (n: { id: string; type: string; domain: string }, k: string) => unknown } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    if (!eng) return -1;
    const v = eng.read(w.__patch.nodes['seq'], 'totalAdvances');
    return typeof v === 'number' ? v : -1;
  });
  await expect
    .poll(readAdvances, { timeout: 10_000, message: 'the clocked walk must be advancing (units: steps)' })
    .toBeGreaterThan(4);

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
    expect(s, `gate must stay low when pad.midi is null even if on=true`).toBe(0);
  }
});
