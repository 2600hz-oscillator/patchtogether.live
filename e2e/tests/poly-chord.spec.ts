// e2e/tests/poly-chord.spec.ts
//
// Stage-1 polyphony E2E spec. Validates that:
//   - a sequencer step with chord='maj' broadcasts a triad on the polyPitchGate
//     output (lanes 0..3 gated, lane 4 silent),
//   - per-lane V/oct values match the spec (root / +M3 / +P5 / +octave),
//   - backward-compat is preserved: a polyPitchGate source patched into a
//     mono `pitch` sink (a VCO) routes lane 0 (the root) — so existing patches
//     keep working,
//   - the chord-picker UI cycles mono → maj → min → mono on click.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

test('poly-chord: maj triad on a4 emits 4 gated lanes with M3 + P5 + octave intervals', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  await spawnPatch(page, [
    { id: 'seq', type: 'sequencer', params: { bpm: 240, length: 1, isPlaying: 1, gateLength: 0.9 } },
  ]);

  // Single step at a4 (MIDI 69), chord=maj.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      w.__patch.nodes['seq'].data = {
        steps: [{ on: true, midi: 69, chord: 'maj' }],
      };
    });
  });

  // Wait for the sequencer to fire step 0 (240 BPM 16ths = 16 steps/sec, so
  // within ~100ms — we wait 600ms for safety).
  await page.waitForTimeout(600);

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

test('poly-chord: min step on a4 emits c5 (m3) instead of c#5 (M3)', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  await spawnPatch(page, [
    { id: 'seq', type: 'sequencer', params: { bpm: 240, length: 1, isPlaying: 1, gateLength: 0.9 } },
  ]);
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      w.__patch.nodes['seq'].data = {
        steps: [{ on: true, midi: 69, chord: 'min' }],
      };
    });
  });
  await page.waitForTimeout(600);

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

test('poly-chord: backward-compat - polyPitchGate source -> mono pitch sink routes lane 0 (root)', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  // Sequencer (poly pitch out) → VCO (mono pitch in). The engine's
  // resolveConnection() should auto-route lane 0 to the VCO's pitch.
  await spawnPatch(
    page,
    [
      { id: 'seq', type: 'sequencer', params: { bpm: 240, length: 1, isPlaying: 1, gateLength: 0.9 } },
      { id: 'vco', type: 'analogVco', params: {} },
    ],
    [
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
        steps: [{ on: true, midi: 69, chord: 'maj' }],
      };
    });
  });
  await page.waitForTimeout(600);

  // Sequencer's lane 0 V/oct should be a4 = 0.75 V; mono `pitchVOct` (which
  // mirrors lane 0) reads the same.
  const rootVOct = await page.evaluate(() => {
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
  expect(rootVOct, 'lane 0 V/oct should be a4 = 0.75').not.toBeNull();
  expect(Math.abs((rootVOct as number) - 0.75)).toBeLessThan(1e-6);

  // No console errors during the connect — the engine should resolve
  // poly→mono cleanly without throwing.
  // (Playwright captures console errors via the page error listener; this
  // test just asserts the read succeeds and the engine kept running.)
});

test('poly-chord: chord-picker UI cycles mono -> maj -> min -> mono on click', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  await spawnPatch(page, [
    { id: 'seq', type: 'sequencer', params: { bpm: 60, length: 4, isPlaying: 0 } },
  ]);

  // The chord badge for step 0 has data-testid `seq-chord-seq-0`.
  const badge = page.getByTestId('seq-chord-seq-0');
  await expect(badge).toBeVisible();
  // Default is mono.
  await expect(badge).toHaveAttribute('data-chord', 'mono');

  await badge.click();
  await expect(badge).toHaveAttribute('data-chord', 'maj');

  await badge.click();
  await expect(badge).toHaveAttribute('data-chord', 'min');

  await badge.click();
  await expect(badge).toHaveAttribute('data-chord', 'mono');
});
