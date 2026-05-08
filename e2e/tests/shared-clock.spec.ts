// e2e/tests/shared-clock.spec.ts
//
// Phase 0/1 of the shared-state-sync plan: a real two-context test that
// boots two browsers, attaches both to the same Hocuspocus rackspace,
// drops in an LFO, and confirms both clients agree on the LFO's
// deterministic phase to within 1 degree (~3 ms at 1 Hz). After the
// owner triggers resetEpoch() both clients re-anchor and see phase 0
// within the smoothing window.
//
// Tagged @clock-sync so it can be selected with --grep when iterating.

import { test, expect } from '@playwright/test';

interface ClockSession {
  pageA: import('@playwright/test').Page;
  pageB: import('@playwright/test').Page;
  ctxA: import('@playwright/test').BrowserContext;
  ctxB: import('@playwright/test').BrowserContext;
  rackspaceId: string;
  close: () => Promise<void>;
}

async function openTwoContextsWithClock(
  browser: import('@playwright/test').Browser,
): Promise<ClockSession> {
  const rackspaceId = `clock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  for (const p of [pageA, pageB]) {
    await p.goto('/');
    await p.waitForLoadState('networkidle');
    await p.waitForFunction(
      () => typeof (window as unknown as { __attachProvider?: unknown }).__attachProvider === 'function',
    );
  }

  await Promise.all(
    [pageA, pageB].map((p) =>
      p.evaluate(async (id) => {
        const w = window as unknown as { __attachProvider: (id: string) => Promise<unknown> };
        await w.__attachProvider(id);
      }, rackspaceId),
    ),
  );

  // Boot the engine + the shared clock on each tab. The engine is
  // needed so the LFO factory actually instantiates the worklet (and
  // its init message exercises the shared-clock pull).
  await Promise.all(
    [pageA, pageB].map((p) =>
      p.evaluate(async () => {
        const w = window as unknown as {
          __ensureEngine: () => Promise<unknown>;
          __createSharedClock: () => unknown;
        };
        await w.__ensureEngine();
        w.__createSharedClock();
      }),
    ),
  );

  return {
    pageA,
    pageB,
    ctxA,
    ctxB,
    rackspaceId,
    async close() {
      await Promise.all([ctxA.close(), ctxB.close()]);
    },
  };
}

test.describe('@clock-sync', () => {
  test('two tabs converge on a shared clock and agree on LFO phase within 1°', async ({ browser }) => {
    const s = await openTwoContextsWithClock(browser);
    try {
      // Page A creates the LFO; Page B sees it via Yjs sync.
      await s.pageA.evaluate(() => {
        const w = window as unknown as {
          __patch: { nodes: Record<string, unknown>; edges: Record<string, unknown> };
          __ydoc: { transact: (fn: () => void) => void };
        };
        w.__ydoc.transact(() => {
          w.__patch.nodes['shared-lfo'] = {
            id: 'shared-lfo',
            type: 'lfo',
            domain: 'audio',
            position: { x: 100, y: 100 },
            params: { rate: 1.0, shape: 0 },
          };
        });
      });

      // Wait for B to see the node.
      await expect
        .poll(async () =>
          s.pageB.evaluate(() => {
            const w = window as unknown as { __patch: { nodes: Record<string, unknown> } };
            return Object.keys(w.__patch.nodes).includes('shared-lfo');
          }),
        )
        .toBe(true);

      // Wait for both clocks to converge (8 burst @ 125 ms = 1 s, plus
      // a generous slack for the awareness propagation + first epoch
      // bootstrap).
      await expect
        .poll(
          async () =>
            Promise.all(
              [s.pageA, s.pageB].map((p) =>
                p.evaluate(() => {
                  const w = window as unknown as { __sharedClock?: () => { snapshot?: { converged?: boolean }; epoch_ms?: number | null } | null };
                  const c = w.__sharedClock?.();
                  return !!c && !!c.snapshot?.converged && c.epoch_ms !== null;
                }),
              ),
            ).then((res) => res.every((v) => v)),
          { timeout: 10_000 },
        )
        .toBe(true);

      // Probe phase on both clients within a tight window so the phase
      // delta is purely "did the shared clock land us at the same
      // shared-time?" — sample times are pulled in parallel.
      const [phaseA, phaseB] = await Promise.all(
        [s.pageA, s.pageB].map((p) =>
          p.evaluate(async () => {
            const w = window as unknown as { __lfoPhase: (id: string) => Promise<number | null> };
            return await w.__lfoPhase('shared-lfo');
          }),
        ),
      );

      expect(phaseA, 'phase A').not.toBeNull();
      expect(phaseB, 'phase B').not.toBeNull();
      const a = phaseA as number;
      const b = phaseB as number;
      const wrap = Math.min(Math.abs(a - b), 1 - Math.abs(a - b));
      expect(
        wrap,
        `phases A=${a.toFixed(6)} B=${b.toFixed(6)} delta=${wrap.toFixed(6)} (>1°/360 = ${(1 / 360).toFixed(6)})`,
      ).toBeLessThan(1 / 360);
    } finally {
      await s.close();
    }
  });

  test('resetEpoch on one tab snaps the other tab to phase ≈ 0', async ({ browser }) => {
    const s = await openTwoContextsWithClock(browser);
    try {
      await s.pageA.evaluate(() => {
        const w = window as unknown as {
          __patch: { nodes: Record<string, unknown> };
          __ydoc: { transact: (fn: () => void) => void };
        };
        w.__ydoc.transact(() => {
          w.__patch.nodes['reset-lfo'] = {
            id: 'reset-lfo',
            type: 'lfo',
            domain: 'audio',
            position: { x: 100, y: 100 },
            // 0.5 Hz so a phase reset is large vs. measurement jitter.
            params: { rate: 0.5, shape: 0 },
          };
        });
      });

      await expect
        .poll(async () =>
          s.pageB.evaluate(() => {
            const w = window as unknown as { __patch: { nodes: Record<string, unknown> } };
            return Object.keys(w.__patch.nodes).includes('reset-lfo');
          }),
        )
        .toBe(true);

      // Let phases run forward a bit so a snap-to-zero is meaningful.
      await s.pageA.waitForTimeout(1500);

      // A triggers reset; both clients should observe a fresh epoch.
      await s.pageA.evaluate(() => {
        const w = window as unknown as { __sharedClock?: () => { resetEpoch: () => void } | null };
        w.__sharedClock?.()?.resetEpoch();
      });

      // Both clients should see their LFO phase ≈ 0 (within the resync
      // smoothing window — give it 500 ms slack).
      await expect
        .poll(
          async () => {
            const [a, b] = await Promise.all(
              [s.pageA, s.pageB].map((p) =>
                p.evaluate(async () => {
                  const w = window as unknown as { __lfoPhase: (id: string) => Promise<number | null> };
                  return await w.__lfoPhase('reset-lfo');
                }),
              ),
            );
            if (a === null || b === null) return false;
            const near = (v: number) => v < 0.05 || v > 0.95; // ≈ 0 wrapped
            return near(a) && near(b);
          },
          { timeout: 5000 },
        )
        .toBe(true);
    } finally {
      await s.close();
    }
  });
});
