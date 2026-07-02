// e2e/tests/sequencer-pages.spec.ts
//
// Page-nav + LEN-128 + HOLD-view-lock end-to-end for the step-based
// sequencers (DRUMSEQZ, POLYSEQZ, MACSEQ, Sequencer). Headline scenarios:
//
//   1. Spawn DRUMSEQZ, crank LEN to 64, assert page-nav shows 4 pages.
//   2. Click > to step page 0 → 1, mutate a step on page 1, click <
//      back to page 0, then > again, assert the mutation persisted.
//   3. Start playback, toggle HOLD on, assert the visible page stays put
//      while the playhead crosses the page boundary. Then toggle HOLD off
//      and assert the visible page catches up to the playhead.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

test('drumseqz: LEN=64 reveals 4 pages of nav', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  await spawnPatch(page, [
    { id: 'drum', type: 'drumseqz', params: { isPlaying: 0, length: 64 } },
  ]);

  // Page-nav label = "p1/4" after LEN=64 (ceil(64/16)=4 pages, starting on
  // page 0 = label "p1/4").
  const label = page.getByTestId('drumseqz-drum-nav').locator(`[data-testid="drumseqz-drum-label"]`);
  await expect(label).toHaveText(/p1\/4/);
});

test('drumseqz: > / < nav crosses page boundary; per-page edits persist', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  await spawnPatch(page, [
    { id: 'drum', type: 'drumseqz', params: { isPlaying: 0, length: 64 } },
  ]);

  // Wait for the test hook the card installs.
  await page.waitForFunction(() => {
    const w = globalThis as unknown as { __drumseqzSetCell?: unknown };
    return typeof w.__drumseqzSetCell === 'function';
  });

  // Click > to advance to page 1 (steps 16..31). Clicking > also flips
  // HOLD on so the user-selected page is sticky.
  await page.getByTestId('drumseqz-drum-next').click();
  const label = page.getByTestId('drumseqz-drum-label');
  await expect(label).toHaveText(/p2\/4/);

  // Toggle step 17 (track 0) by writing via the test hook. Page 1 is
  // visible so step 17 = the 2nd cell of the visible row.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __drumseqzSetCell: (
        id: string, t: number, s: number, c: { on?: boolean; midi?: number | null },
      ) => boolean;
    };
    w.__drumseqzSetCell('drum', 0, 17, { on: true, midi: 60 });
  });

  // The grid is rendering page 1 (steps 16..31). Confirm step 17's cell
  // is in the DOM with the expected data-step (4 tracks × 1 cell each).
  await expect(
    page.locator('[data-testid="drumseqz-grid-drum"] [data-step="17"]'),
  ).toHaveCount(4);

  // < back to page 0.
  await page.getByTestId('drumseqz-drum-prev').click();
  await expect(label).toHaveText(/p1\/4/);
  // Step 17's cell is NOT in the DOM on page 0.
  await expect(
    page.locator('[data-testid="drumseqz-grid-drum"] [data-step="17"]'),
  ).toHaveCount(0);

  // > forward to page 1 — step 17 should still be on.
  await page.getByTestId('drumseqz-drum-next').click();
  const cell17 = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __drumseqzCellAt: (id: string, t: number, s: number) => { on: boolean; midi: number | null } | null;
    };
    return w.__drumseqzCellAt('drum', 0, 17);
  });
  expect(cell17?.on).toBe(true);
});

test('drumseqz: HOLD freezes visible page while playhead advances', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  // BPM=600 so the 16th-note step is 25 ms — playhead crosses page 0 → page 1
  // in <500 ms. length=32 = 2 pages.
  await spawnPatch(page, [
    { id: 'drum', type: 'drumseqz', params: { isPlaying: 0, length: 32, bpm: 600 } },
  ]);

  // Turn HOLD on while stopped, sitting on page 0.
  const holdBtn = page.getByTestId('drumseqz-drum-hold');
  await holdBtn.click();

  const label = page.getByTestId('drumseqz-drum-label');
  await expect(label).toHaveText(/p1\/2/);

  // Start playback.
  await page.getByTestId('drumseqz-play-drum').click();

  // Wait for the playhead to be past step 15 (i.e. on page 1) by polling
  // engine.read(node, 'currentStep'). Bound the wait — the worker tick
  // can take a hundred ms on cold start.
  await page.waitForFunction(
    () => {
      const w = globalThis as unknown as {
        __engine?: () => {
          read: (n: { id: string; type: string; domain: string }, k: string) => unknown;
        } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
      };
      const e = w.__engine?.();
      const n = w.__patch.nodes['drum'];
      if (!e || !n) return false;
      const cs = e.read(n, 'currentStep');
      return typeof cs === 'number' && cs >= 16;
    },
    null,
    { timeout: 5000 },
  );

  // Visible page label still says p1/2 — HOLD is on.
  await expect(label).toHaveText(/p1\/2/);

  // Toggle HOLD off. Visible page should immediately catch up to the
  // playhead's current page. At BPM=600 (800ms/cycle) CI interaction
  // overhead can cause the playhead to wrap back to page 1 between the
  // waitForFunction detection and the holdBtn.click(); read both
  // atomically inside waitForFunction to avoid the race.
  await holdBtn.click();
  await page.waitForFunction(
    () => {
      const w = globalThis as unknown as {
        __engine?: () => {
          read: (n: { id: string; type: string; domain: string }, k: string) => unknown;
        } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
      };
      const e = w.__engine?.();
      const n = w.__patch.nodes['drum'];
      if (!e || !n) return false;
      const cs = e.read(n, 'currentStep');
      if (typeof cs !== 'number') return false;
      const expectedPage = Math.floor(cs / 16) + 1;
      const lbl = document.querySelector('[data-testid="drumseqz-drum-label"]');
      return lbl?.textContent?.includes(`p${expectedPage}/2`) ?? false;
    },
    null,
    { timeout: 3000 },
  );

  // Sanity: HOLD did NOT affect playhead advancement — currentStep is still
  // moving. Sample twice with a 200 ms gap and assert the index changed.
  const cs1 = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __engine: () => {
        read: (n: { id: string; type: string; domain: string }, k: string) => unknown;
      };
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    return w.__engine().read(w.__patch.nodes['drum'], 'totalAdvances') as number;
  });
  await page.waitForTimeout(200);
  const cs2 = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __engine: () => {
        read: (n: { id: string; type: string; domain: string }, k: string) => unknown;
      };
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    return w.__engine().read(w.__patch.nodes['drum'], 'totalAdvances') as number;
  });
  expect(cs2).toBeGreaterThan(cs1);
});
