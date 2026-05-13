// e2e/vrt/playhead.spec.ts
//
// Per-step playhead VRT. Asserts that for each lookahead-scheduling
// sequencer, the visual highlight lands on the SOUNDING-NOW step (not the
// next-to-be-scheduled one). Distinct from vrt.spec.ts which only captures
// the idle/default card.
//
// Strategy (deterministic):
//   1. Spawn the sequencer.
//   2. Manually queue (idx, atTime) entries into the playhead tracker via a
//      test-only path: we set isPlaying=1 with a very slow BPM (30) so each
//      step lasts ~2 s, then waitForFunction(currentStep === N), then
//      immediately set isPlaying=0 to freeze the highlight where it lies.
//   3. Screenshot.
//
// The freeze trick relies on the tracker's `lastSounding` sticking around
// when the queue drains naturally (no playhead.reset() is called on stop).
// The Card re-renders on the next rAF and the highlight stays put.
//
// We capture step 0 and step 1 — that's enough to prove the playhead
// follows audio time (vs. the old bug where step 1 would already be
// highlighted at t=0). Step 15 is also captured as a "deep into pattern"
// proof point.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from '../tests/_helpers';

test.describe.configure({ mode: 'serial' });

interface SetPlayingArgs {
  id: string;
  playing: number;
}

async function setPlaying(page: Page, id: string, playing: 0 | 1): Promise<void> {
  await page.evaluate(
    ({ id: nodeId, playing: v }: SetPlayingArgs) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params?: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const live = w.__patch.nodes[nodeId];
        if (live?.params) live.params.isPlaying = v;
      });
    },
    { id, playing } satisfies SetPlayingArgs,
  );
}

async function waitForStep(page: Page, id: string, target: number, timeoutMs = 8000): Promise<void> {
  await page.waitForFunction(
    ({ id: nid, t }) => {
      const w = globalThis as unknown as {
        __engine?: () => { read: (n: { id: string; type: string; domain: string }, k: string) => unknown } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
      };
      const eng = w.__engine?.();
      const node = w.__patch.nodes[nid];
      if (!eng || !node) return false;
      const v = eng.read(node, 'currentStep');
      return typeof v === 'number' && v === t;
    },
    { id, t: target },
    { timeout: timeoutMs, polling: 50 },
  );
}

test('polyseqz: per-step playhead baselines (step 0, 1, 7)', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(page, [
    {
      id: 'p',
      type: 'polyseqz',
      // BPM 30 → 8th note = 1 second per step. Plenty of slack for the
      // waitForFunction + freeze + screenshot dance.
      params: { bpm: 30, length: 8, isPlaying: 0, gateLength: 0.5, humanize: 0 },
    },
  ]);

  // 8 maj-triad steps so each cell is visually busy + active highlight is
  // easy to see (filled vs not).
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const steps = Array.from({ length: 8 }, (_, i) => ({
        on: true,
        root: 60 + i,
        quality: 'maj',
        inversion: 0,
        voicing: 'closed',
      }));
      w.__patch.nodes['p'].data = { steps };
    });
  });

  const card = page.locator('.svelte-flow__node-polyseqz').first();
  await card.waitFor({ state: 'visible', timeout: 10_000 });

  // Start playing → wait for sounding step to be 0 → freeze.
  await setPlaying(page, 'p', 1);
  await waitForStep(page, 'p', 0);
  await setPlaying(page, 'p', 0);
  // One rAF for the Card to repaint with the latest tracker value.
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
  await expect(card).toHaveScreenshot('polyseqz-step-0.png', { animations: 'disabled' });

  // Advance to step 1.
  await setPlaying(page, 'p', 1);
  await waitForStep(page, 'p', 1);
  await setPlaying(page, 'p', 0);
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
  await expect(card).toHaveScreenshot('polyseqz-step-1.png', { animations: 'disabled' });

  // Advance to step 7 (final step of the 8-step pattern).
  await setPlaying(page, 'p', 1);
  await waitForStep(page, 'p', 7);
  await setPlaying(page, 'p', 0);
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
  await expect(card).toHaveScreenshot('polyseqz-step-7.png', { animations: 'disabled' });
});

test('sequencer: per-step playhead baselines (step 0, 1, 15)', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(page, [
    {
      id: 's',
      type: 'sequencer',
      // BPM 30 → 16th note = 500 ms per step. Plenty for the waitForStep
      // dance (typical polling cycle ~50 ms).
      params: { bpm: 30, length: 16, isPlaying: 0, gateLength: 0.5, swing: 0 },
    },
  ]);
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const steps = Array.from({ length: 16 }, (_, i) => ({
        on: true,
        midi: 60 + (i % 12),
        chord: 'mono',
      }));
      w.__patch.nodes['s'].data = { steps };
    });
  });

  const card = page.locator('.svelte-flow__node-sequencer').first();
  await card.waitFor({ state: 'visible', timeout: 10_000 });

  for (const step of [0, 1, 15]) {
    await setPlaying(page, 's', 1);
    await waitForStep(page, 's', step);
    await setPlaying(page, 's', 0);
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
    await expect(card).toHaveScreenshot(`sequencer-step-${step}.png`, { animations: 'disabled' });
  }
});

test('drumseqz: per-step playhead baselines (step 0, 1, 15)', async ({ page }) => {
  // DrumseqzCard.svelte conditions `isActive={i === currentStep && isPlaying}`
  // on isPlaying, so the freeze-via-stop trick the other sequencers use would
  // wipe the highlight. Use a very slow BPM (10 → 1.5 s per step) instead and
  // snapshot mid-step while playback is still running. Animations are frozen
  // for the screenshot capture itself.
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(page, [
    {
      id: 'd',
      type: 'drumseqz',
      params: { bpm: 30, length: 16, isPlaying: 0, gateLength: 0.5, swing: 0 },
    },
  ]);
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const tracks = Array.from({ length: 4 }, () =>
        Array.from({ length: 16 }, () => ({ on: true, midi: null })),
      );
      w.__patch.nodes['d'].data = { tracks };
    });
  });

  const card = page.locator('.svelte-flow__node-drumseqz').first();
  await card.waitFor({ state: 'visible', timeout: 10_000 });

  // Start playing once, capture each step as the playhead passes it.
  await setPlaying(page, 'd', 1);
  for (const step of [0, 1, 15]) {
    await waitForStep(page, 'd', step, /* timeoutMs */ 30_000);
    // No stop — sound is still playing; the screenshot freezes at the
    // moment waitForStep resolves. At BPM 10 we have ~1.5 s before the
    // next step advance, way more than the screenshot path takes (<200 ms).
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
    await expect(card).toHaveScreenshot(`drumseqz-step-${step}.png`, { animations: 'disabled' });
  }
  await setPlaying(page, 'd', 0);
});
