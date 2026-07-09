// e2e/tests/polyseqz.spec.ts
//
// POLYSEQZ end-to-end coverage.
//
//   1. Spawn the module → 32-cell grid renders + every per-step badge defaults
//      to maj/0/closed.
//   2. Set a 4-step Cmaj→Dmin→Em→Fmaj progression, hit play, assert per-lane
//      V/oct values match the expected chord voicings.
//   3. Backward-compat: POLYSEQZ.poly → analogVco.pitch (mono) auto-routes
//      lane 0 (root) through the engine's resolveConnection path.

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

test('polyseqz: drop module → 16-cell page-0 grid renders + defaults shown', async ({ page, rack }) => {
  await spawnPatch(page, [
    { id: 'p', type: 'polyseqz', params: { isPlaying: 0 } },
  ]);

  // Post-pages PR the grid renders one page (16 cell-slots) at a time. Each
  // .cell-slot carries data-step; its inner badges also carry data-step.
  // Count .cell-slot wrappers specifically so the assertion isn't sensitive
  // to badge-count drift.
  const cells = await page
    .locator('[data-testid="polyseqz-grid-p"] .cell-slot')
    .count();
  expect(cells).toBe(16);

  // Default for every quality badge is 'maj'.
  await expect(page.getByTestId('polyseqz-quality-p-0')).toHaveAttribute('data-quality', 'maj');
  await expect(page.getByTestId('polyseqz-quality-p-15')).toHaveAttribute('data-quality', 'maj');
  // Default inversion 0, voicing closed.
  await expect(page.getByTestId('polyseqz-inv-p-0')).toHaveAttribute('data-inversion', '0');
  await expect(page.getByTestId('polyseqz-voicing-p-0')).toHaveAttribute('data-voicing', 'closed');
});

test('polyseqz: per-step UI cycles quality (maj→min→...) and inversion (0→1→2→0)', async ({ page, rack }) => {
  await spawnPatch(page, [
    { id: 'p', type: 'polyseqz', params: { isPlaying: 0 } },
  ]);

  const qualityBadge = page.getByTestId('polyseqz-quality-p-0');
  await expect(qualityBadge).toHaveAttribute('data-quality', 'maj');
  await qualityBadge.click();
  await expect(qualityBadge).toHaveAttribute('data-quality', 'min');

  const invBadge = page.getByTestId('polyseqz-inv-p-0');
  await expect(invBadge).toHaveAttribute('data-inversion', '0');
  await invBadge.click();
  await expect(invBadge).toHaveAttribute('data-inversion', '1');
  await invBadge.click();
  await expect(invBadge).toHaveAttribute('data-inversion', '2');
  await invBadge.click();
  await expect(invBadge).toHaveAttribute('data-inversion', '0');

  const voicingBadge = page.getByTestId('polyseqz-voicing-p-0');
  await expect(voicingBadge).toHaveAttribute('data-voicing', 'closed');
  await voicingBadge.click();
  await expect(voicingBadge).toHaveAttribute('data-voicing', 'open');
  await voicingBadge.click();
  await expect(voicingBadge).toHaveAttribute('data-voicing', 'spread');
});

test('polyseqz: Cmaj step emits 5 gated lanes with C/E/G/C/E V/oct', async ({ page, rack }) => {
  await spawnPatch(page, [
    {
      id: 'p',
      type: 'polyseqz',
      params: { bpm: 240, length: 1, isPlaying: 1, gateLength: 0.9, humanize: 0 },
    },
  ]);

  // Single Cmaj step (root C4 = 60, quality maj, closed voicing, inv 0).
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      w.__patch.nodes['p'].data = {
        steps: [{ on: true, root: 60, quality: 'maj', inversion: 0, voicing: 'closed' }],
      };
    });
  });

  // 240 BPM 8th-notes = 8 steps/sec → first step within ~125ms; wait 600ms safe.
  await page.waitForTimeout(600);

  const lanes = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __engine?: () => { read: (n: { id: string; type: string; domain: string }, k: string) => unknown } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    if (!eng) return null;
    const node = w.__patch.nodes['p'];
    const out: Array<{ pitch: number | null; gate: number | null }> = [];
    for (let i = 0; i < 5; i++) {
      const pi = eng.read(node, `pitchVOctLane:${i}`);
      const gi = eng.read(node, `gateLane:${i}`);
      out.push({
        pitch: typeof pi === 'number' ? pi : null,
        gate: typeof gi === 'number' ? gi : null,
      });
    }
    return out;
  });

  expect(lanes).not.toBeNull();
  // All 5 lanes gated (closed voicing fills all slots for triads).
  for (let i = 0; i < 5; i++) expect(lanes![i]?.gate).toBe(1);

  // Expected V/oct: C4=0, E4=4/12, G4=7/12, C5=12/12, E5=16/12.
  const TOL = 1e-6;
  expect(Math.abs((lanes![0]!.pitch ?? -1) - 0     )).toBeLessThan(TOL);
  expect(Math.abs((lanes![1]!.pitch ?? -1) - 4 / 12)).toBeLessThan(TOL);
  expect(Math.abs((lanes![2]!.pitch ?? -1) - 7 / 12)).toBeLessThan(TOL);
  expect(Math.abs((lanes![3]!.pitch ?? -1) -      1)).toBeLessThan(TOL);
  expect(Math.abs((lanes![4]!.pitch ?? -1) - 16 / 12)).toBeLessThan(TOL);
});

test('polyseqz: backward-compat — poly → mono pitch auto-routes lane 0 (root)', async ({ page, rack }) => {
  await spawnPatch(
    page,
    [
      {
        id: 'p',
        type: 'polyseqz',
        params: { bpm: 240, length: 1, isPlaying: 1, gateLength: 0.9, humanize: 0 },
      },
      { id: 'vco', type: 'analogVco', params: {} },
    ],
    [
      {
        id: 'e1',
        from: { nodeId: 'p', portId: 'poly' },
        to: { nodeId: 'vco', portId: 'pitch' },
        sourceType: 'polyPitchGate',
        targetType: 'pitch',
      },
    ],
  );
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      w.__patch.nodes['p'].data = {
        steps: [{ on: true, root: 69, quality: 'maj', inversion: 0, voicing: 'closed' }],
      };
    });
  });
  await page.waitForTimeout(600);

  const root = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __engine?: () => { read: (n: { id: string; type: string; domain: string }, k: string) => unknown } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    if (!eng) return null;
    const node = w.__patch.nodes['p'];
    const v = eng.read(node, 'pitchVOct');
    return typeof v === 'number' ? v : null;
  });
  // a4 V/oct = (69-60)/12 = 0.75.
  expect(root).not.toBeNull();
  expect(Math.abs((root as number) - 0.75)).toBeLessThan(1e-6);
});

test('polyseqz: humanize=0 keeps gates synchronous; humanize=1 spreads them', async ({ page, rack }) => {
  // First: humanize=0. All voices gate-on simultaneously, so every
  // humanizeOffset:N read should be exactly 0.
  await spawnPatch(page, [
    {
      id: 'p',
      type: 'polyseqz',
      params: { bpm: 120, length: 1, isPlaying: 1, gateLength: 0.9, humanize: 0 },
    },
  ]);
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      w.__patch.nodes['p'].data = {
        steps: [{ on: true, root: 60, quality: 'maj', inversion: 0, voicing: 'closed' }],
      };
    });
  });
  await page.waitForTimeout(800);

  const offsetsAtZero = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __engine?: () => { read: (n: { id: string; type: string; domain: string }, k: string) => unknown } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    if (!eng) return null;
    const node = w.__patch.nodes['p'];
    const out: number[] = [];
    for (let i = 0; i < 5; i++) {
      const v = eng.read(node, `humanizeOffset:${i}`);
      out.push(typeof v === 'number' ? v : Number.NaN);
    }
    return out;
  });
  expect(offsetsAtZero).not.toBeNull();
  for (const o of offsetsAtZero!) expect(o).toBe(0);

  // Now set humanize=1 and look again — should see non-zero offsets, with
  // a notable spread between voices (some negative, some positive in
  // distribution; over a few step samples we expect the spread set to
  // contain at least one non-zero value).
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params: Record<string, number> }> };
    };
    w.__patch.nodes['p'].params.humanize = 1;
  });
  await page.waitForTimeout(800);

  // Read offsets across several samples (different ticks) — humanize is
  // per-step random so a single read could rarely be all-zero.
  const observations: number[][] = [];
  for (let attempt = 0; attempt < 6; attempt++) {
    const o = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __engine?: () => { read: (n: { id: string; type: string; domain: string }, k: string) => unknown } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
      };
      const eng = w.__engine?.();
      if (!eng) return null;
      const node = w.__patch.nodes['p'];
      const arr: number[] = [];
      for (let i = 0; i < 5; i++) {
        const v = eng.read(node, `humanizeOffset:${i}`);
        arr.push(typeof v === 'number' ? v : Number.NaN);
      }
      return arr;
    });
    if (o) observations.push(o);
    await page.waitForTimeout(120);
  }

  // At least one observation should contain at least one non-zero offset.
  const sawNonZero = observations.some((arr) => arr.some((v) => Math.abs(v) > 1e-6));
  expect(sawNonZero, `expected at least one non-zero humanize offset across ${observations.length} samples; got ${JSON.stringify(observations)}`).toBe(true);

  // No observed offset should exceed the documented HUMANIZE_MAX_DELAY_S (50ms).
  for (const arr of observations) {
    for (const v of arr) {
      if (!Number.isFinite(v)) continue;
      expect(Math.abs(v)).toBeLessThanOrEqual(0.05 + 1e-9);
    }
  }
});

// ---------------- Keyboard navigation parity ----------------
//
// POLYSEQZ matches Sequencer/DRUMSEQZ/SCORE keyboard nav semantics:
//   - Left/Right move between steps in the same role (clamp at edges).
//   - Up/Down move within a step through the role stack:
//       gate → pitch → quality → inversion → voicing (clamp at edges).
//   - Space/Enter on gate, quality, inv, or voicing cycles/toggles that field.
//   - Enter on pitch commits + advances to next step's pitch.
//   - Tab moves between steps in same role.

test('keyboard-nav POLYSEQZ: Right/Left across steps in same role', async ({ page, rack }) => {
  await spawnPatch(page, [{ id: 'p', type: 'polyseqz', params: { isPlaying: 0 } }]);

  const pitch0 = page.locator('[data-testid="polyseqz-root-p-0"]');
  await pitch0.focus();
  await pitch0.press('ArrowLeft');
  await expect(pitch0).toBeFocused();
  await pitch0.press('ArrowRight');
  await expect(page.locator('[data-testid="polyseqz-root-p-1"]')).toBeFocused();
});

test('keyboard-nav POLYSEQZ: Down cycles gate → pitch → quality → inversion → voicing', async ({ page, rack }) => {
  await spawnPatch(page, [{ id: 'p', type: 'polyseqz', params: { isPlaying: 0 } }]);

  const gate2 = page.locator('[data-testid="polyseqz-gate-p-2"]');
  await gate2.focus();
  await expect(gate2).toBeFocused();

  await gate2.press('ArrowDown');
  await expect(page.locator('[data-testid="polyseqz-root-p-2"]')).toBeFocused();

  await page.locator('[data-testid="polyseqz-root-p-2"]').press('ArrowDown');
  await expect(page.locator('[data-testid="polyseqz-quality-p-2"]')).toBeFocused();

  await page.locator('[data-testid="polyseqz-quality-p-2"]').press('ArrowDown');
  await expect(page.locator('[data-testid="polyseqz-inv-p-2"]')).toBeFocused();

  await page.locator('[data-testid="polyseqz-inv-p-2"]').press('ArrowDown');
  await expect(page.locator('[data-testid="polyseqz-voicing-p-2"]')).toBeFocused();

  // ArrowDown from the bottom-most role clamps (focus stays on voicing).
  await page.locator('[data-testid="polyseqz-voicing-p-2"]').press('ArrowDown');
  await expect(page.locator('[data-testid="polyseqz-voicing-p-2"]')).toBeFocused();
});

test('keyboard-nav POLYSEQZ: Up reverses the role stack and clamps at gate', async ({ page, rack }) => {
  await spawnPatch(page, [{ id: 'p', type: 'polyseqz', params: { isPlaying: 0 } }]);

  const voicing0 = page.locator('[data-testid="polyseqz-voicing-p-0"]');
  await voicing0.focus();
  await voicing0.press('ArrowUp');
  await expect(page.locator('[data-testid="polyseqz-inv-p-0"]')).toBeFocused();
  await page.locator('[data-testid="polyseqz-inv-p-0"]').press('ArrowUp');
  await expect(page.locator('[data-testid="polyseqz-quality-p-0"]')).toBeFocused();
  await page.locator('[data-testid="polyseqz-quality-p-0"]').press('ArrowUp');
  await expect(page.locator('[data-testid="polyseqz-root-p-0"]')).toBeFocused();
  await page.locator('[data-testid="polyseqz-root-p-0"]').press('ArrowUp');
  const gate0 = page.locator('[data-testid="polyseqz-gate-p-0"]');
  await expect(gate0).toBeFocused();
  // Clamp at the top.
  await gate0.press('ArrowUp');
  await expect(gate0).toBeFocused();
});

test('keyboard-nav POLYSEQZ: Space/Enter on quality badge cycles quality', async ({ page, rack }) => {
  await spawnPatch(page, [{ id: 'p', type: 'polyseqz', params: { isPlaying: 0 } }]);

  const quality = page.locator('[data-testid="polyseqz-quality-p-1"]');
  await quality.focus();
  await expect(quality).toHaveAttribute('data-quality', 'maj');
  await quality.press(' ');
  await expect(quality).toHaveAttribute('data-quality', 'min');
  await quality.press('Enter');
  await expect(quality).toHaveAttribute('data-quality', 'maj7');
});

test('keyboard-nav POLYSEQZ: Space on inversion + voicing cycles each field', async ({ page, rack }) => {
  await spawnPatch(page, [{ id: 'p', type: 'polyseqz', params: { isPlaying: 0 } }]);

  const inv = page.locator('[data-testid="polyseqz-inv-p-3"]');
  await inv.focus();
  await expect(inv).toHaveAttribute('data-inversion', '0');
  await inv.press(' ');
  await expect(inv).toHaveAttribute('data-inversion', '1');
  await inv.press(' ');
  await expect(inv).toHaveAttribute('data-inversion', '2');
  await inv.press(' ');
  await expect(inv).toHaveAttribute('data-inversion', '0');

  const voicing = page.locator('[data-testid="polyseqz-voicing-p-3"]');
  await voicing.focus();
  await expect(voicing).toHaveAttribute('data-voicing', 'closed');
  await voicing.press(' ');
  await expect(voicing).toHaveAttribute('data-voicing', 'open');
  await voicing.press(' ');
  await expect(voicing).toHaveAttribute('data-voicing', 'spread');
});

test('keyboard-nav POLYSEQZ: Space on gate toggles step on (matches Sequencer)', async ({ page, rack }) => {
  await spawnPatch(page, [{ id: 'p', type: 'polyseqz', params: { isPlaying: 0 } }]);

  const gate1 = page.locator('[data-testid="polyseqz-gate-p-1"]');
  await gate1.focus();
  await gate1.press(' ');
  const stepOn = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: { steps?: Array<{ on: boolean }> } }> };
    };
    return w.__patch.nodes['p']?.data?.steps?.[1]?.on ?? null;
  });
  expect(stepOn).toBe(true);
});

test('keyboard-nav POLYSEQZ: rapid-add (type root, ArrowRight, type root, ...)', async ({ page, rack }) => {
  await spawnPatch(page, [
    { id: 'p', type: 'polyseqz', params: { bpm: 90, length: 4, isPlaying: 0 } },
  ]);

  const roots = ['c3', 'e3', 'g3', 'b3'];
  const cur0 = page.locator('[data-testid="polyseqz-root-p-0"]');
  await cur0.focus();
  for (let i = 0; i < roots.length; i++) {
    const cur = page.locator(`[data-testid="polyseqz-root-p-${i}"]`);
    await expect(cur).toBeFocused();
    await cur.fill(roots[i]!);
    if (i < roots.length - 1) await cur.press('ArrowRight');
  }
  await page.locator(`[data-testid="polyseqz-root-p-${roots.length - 1}"]`).blur();

  const stored = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: { steps?: Array<{ root: number | null }> } }> };
    };
    return w.__patch.nodes['p']?.data?.steps?.slice(0, 4).map((s) => s.root) ?? [];
  });
  // c3 e3 g3 b3 -> 48 52 55 59
  expect(stored).toEqual([48, 52, 55, 59]);
});

test('keyboard-nav POLYSEQZ: ArrowLeft/Right inside pitch input never moves caret', async ({ page, rack }) => {
  await spawnPatch(page, [{ id: 'p', type: 'polyseqz', params: { isPlaying: 0 } }]);

  const step0 = page.locator('[data-testid="polyseqz-root-p-0"]');
  await step0.focus();
  await step0.fill('a4');
  await step0.press('ArrowLeft'); // clamped at step 0
  await expect(step0).toBeFocused();
  await expect(step0).toHaveValue('a4');
});
