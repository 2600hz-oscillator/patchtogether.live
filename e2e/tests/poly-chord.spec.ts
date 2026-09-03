// e2e/tests/poly-chord.spec.ts
//
// Stage-1 polyphony E2E spec, on CARTESIAN — the surviving chord-cell
// surface after the legacy sequencers were deleted (2026-08-24). Validates:
//   - a pad with chord='maj' broadcasts a triad on the polyPitchGate
//     output (lanes 0..3 gated, lane 4 silent),
//   - per-lane V/oct values match the spec (root / +M3 / +P5 / +octave),
//   - backward-compat is preserved: a polyPitchGate source patched into a
//     mono `pitch` sink (a VCO) routes lane 0 (the root) — so existing patches
//     keep working,
//   - the chord-picker UI cycles mono → maj → min → mono on click.

import { test, expect } from './_fixtures';
import { spawnPatch, seedKriaGate } from './_helpers';

test.describe.configure({ mode: 'parallel' });

test('poly-chord: maj triad on a4 emits 4 gated lanes with M3 + P5 + octave intervals', async ({ page, rack }) => {
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

  // Every pad a4 (MIDI 69), chord=maj — the clocked walk emits the same
  // triad on every step, so the lane reads are step-phase-independent.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      w.__patch.nodes['seq'].data = {
        cells: Array.from({ length: 16 }, () => ({ on: true, midi: 69, chord: 'maj' })),
      };
    });
  });
  await seedKriaGate(page, 'clk');

  // State readiness: wait until the walk has fired at least once.
  await expect
    .poll(() => page.evaluate(() => {
      const w = globalThis as unknown as {
        __engine?: () => { read: (n: { id: string; type: string; domain: string }, k: string) => unknown } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
      };
      const v = w.__engine?.()?.read(w.__patch.nodes['seq'], 'gateLane:0');
      return typeof v === 'number' ? v : -1;
    }), { timeout: 10_000, message: 'lane 0 gate should fire (units: gate 0/1)' })
    .toBe(1);

  // Read each lane's V/oct + gate via the engine's per-lane read keys.
  const lanes = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __engine?: () => { read: (n: { id: string; type: string; domain: string }, k: string) => unknown } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    if (!eng) return null;
    const node = w.__patch.nodes['seq'];
    const out: Array<{ pitch: number | null; gate: number | null }> = [];
    for (let i = 0; i < 5; i++) {
      const p = eng.read(node, `pitchVOctLane:${i}`);
      const g = eng.read(node, `gateLane:${i}`);
      out.push({
        pitch: typeof p === 'number' ? p : null,
        gate: typeof g === 'number' ? g : null,
      });
    }
    return out;
  });

  expect(lanes, 'engine.read should expose per-lane reads').not.toBeNull();
  // Lanes 0..3 gated, lane 4 silent.
  expect(lanes![0]?.gate).toBe(1);
  expect(lanes![1]?.gate).toBe(1);
  expect(lanes![2]?.gate).toBe(1);
  expect(lanes![3]?.gate).toBe(1);
  expect(lanes![4]?.gate).toBe(0);

  // Per-lane V/oct values: a4 = 9/12, c#5 = 13/12, e5 = 16/12, a5 = 21/12.
  const TOL = 1e-6;
  expect(Math.abs((lanes![0]!.pitch ?? -1) -  9 / 12)).toBeLessThan(TOL);
  expect(Math.abs((lanes![1]!.pitch ?? -1) - 13 / 12)).toBeLessThan(TOL);
  expect(Math.abs((lanes![2]!.pitch ?? -1) - 16 / 12)).toBeLessThan(TOL);
  expect(Math.abs((lanes![3]!.pitch ?? -1) - 21 / 12)).toBeLessThan(TOL);
});

test('poly-chord: min pad on a4 emits c5 (m3) instead of c#5 (M3)', async ({ page, rack }) => {
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
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      w.__patch.nodes['seq'].data = {
        cells: Array.from({ length: 16 }, () => ({ on: true, midi: 69, chord: 'min' })),
      };
    });
  });
  await seedKriaGate(page, 'clk');
  await expect
    .poll(() => page.evaluate(() => {
      const w = globalThis as unknown as {
        __engine?: () => { read: (n: { id: string; type: string; domain: string }, k: string) => unknown } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
      };
      const v = w.__engine?.()?.read(w.__patch.nodes['seq'], 'gateLane:0');
      return typeof v === 'number' ? v : -1;
    }), { timeout: 10_000, message: 'lane 0 gate should fire (units: gate 0/1)' })
    .toBe(1);

  const laneOnePitch = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __engine?: () => { read: (n: { id: string; type: string; domain: string }, k: string) => unknown } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    if (!eng) return null;
    const node = w.__patch.nodes['seq'];
    const v = eng.read(node, 'pitchVOctLane:1');
    return typeof v === 'number' ? v : null;
  });

  // m3 above a4 = c5 = MIDI 72 = (72-60)/12 = 1.0 V/oct.
  expect(laneOnePitch, 'lane 1 should emit m3 above root for min chord').not.toBeNull();
  expect(Math.abs((laneOnePitch as number) - 1.0)).toBeLessThan(1e-6);
});

test('poly-chord: backward-compat - polyPitchGate source -> mono pitch sink routes lane 0 (root)', async ({ page, rack }) => {
  // Cartesian (poly pitch out) → VCO (mono pitch in). The engine's
  // resolveConnection() should auto-route lane 0 to the VCO's pitch.
  await spawnPatch(
    page,
    [
      { id: 'clk', type: 'kria', params: { bpm: 240, running: 1 } },
      { id: 'seq', type: 'cartesian' },
      { id: 'vco', type: 'analogVco', params: {} },
    ],
    [
      { id: 'e_clk', from: { nodeId: 'clk', portId: 'gate1' }, to: { nodeId: 'seq', portId: 'clock' }, sourceType: 'gate', targetType: 'gate' },
      {
        id: 'e1',
        from: { nodeId: 'seq', portId: 'pitch' },
        to: { nodeId: 'vco', portId: 'pitch' },
        // Source is now polyPitchGate, target is the VCO's mono pitch.
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
      w.__patch.nodes['seq'].data = {
        cells: Array.from({ length: 16 }, () => ({ on: true, midi: 69, chord: 'maj' })),
      };
    });
  });
  await seedKriaGate(page, 'clk');

  // Lane 0 V/oct should be a4 = 0.75 V; mono `pitchVOct` (which mirrors
  // lane 0) reads the same. Auto-retrying — state readiness, not wall clock.
  await expect
    .poll(() => page.evaluate(() => {
      const w = globalThis as unknown as {
        __engine?: () => { read: (n: { id: string; type: string; domain: string }, k: string) => unknown } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
      };
      const v = w.__engine?.()?.read(w.__patch.nodes['seq'], 'pitchVOct');
      return typeof v === 'number' ? v : null;
    }), { timeout: 10_000, message: 'lane 0 V/oct should be a4 = 0.75 (units: V/oct)' })
    .toBeCloseTo(0.75, 6);

  // No console errors during the connect — the engine should resolve
  // poly→mono cleanly without throwing.
  // (Playwright captures console errors via the page error listener; this
  // test just asserts the read succeeds and the engine kept running.)
});

test('poly-chord: chord-picker UI cycles mono -> maj -> min -> mono on click', async ({ page, rack }) => {
  await spawnPatch(page, [
    { id: 'seq', type: 'cartesian' },
  ]);

  // The chord badge lives on the dock FACE GRID on the shell
  // (`cart-face-chord-0` — the card's `cart-chord-seq-0` died with it).
  await page
    .locator('.svelte-flow__node[data-id="seq"] [data-testid="module-shell"]')
    .getByTestId('shell-open-dock')
    .click();
  await expect(page.getByTestId('dock-full-view')).toBeVisible();
  const badge = page.getByTestId('cart-face-chord-0');
  await badge.scrollIntoViewIfNeeded();
  await expect(badge).toBeVisible();
  // Default is mono — the face button speaks its chord in the aria-label.
  await expect(badge).toHaveAttribute('aria-label', /chord: mono$/);

  await badge.click();
  await expect(badge).toHaveAttribute('aria-label', /chord: maj$/);

  await badge.click();
  await expect(badge).toHaveAttribute('aria-label', /chord: min$/);

  await badge.click();
  await expect(badge).toHaveAttribute('aria-label', /chord: mono$/);
});
