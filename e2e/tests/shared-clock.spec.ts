// e2e/tests/shared-clock.spec.ts
//
// Phase 0/1 of the shared-state-sync plan: a real two-context test that
// boots two browsers, attaches both to the same Hocuspocus rackspace,
// drops in an LFO, and confirms both clients agree on the LFO's
// deterministic phase to within 0.5 degrees (was 1° → bumped to 1.05°
// in PR-55 → root-caused + tightened to 0.5° in May 2026). After the
// owner triggers resetEpoch() both clients re-anchor and see phase 0
// within the smoothing window.
//
// PR-55 history: the test sampled `clock.sharedTimeNow()` independently
// in each tab. Because Playwright's CDP round-trips per-tab and
// JS-engine pauses interleave the `Promise.all` legs, the two tabs
// landed 5–10 ms apart in shared-time — at 1 Hz that's up to 3.6° of
// phase jitter. The threshold bump fixed CI for a few weeks until
// runner contention spiked latency further. May 2026 fix: pass an
// explicit shared-time both tabs evaluate at, eliminating sample-time
// drift entirely (see __lfoPhaseAt in routes/+layout.svelte).
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
  test('two tabs converge on a shared clock and agree on LFO phase within 0.5°', async ({ browser }) => {
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

      // ROOT-CAUSE FIX (May 2026): the previous version of this test asked
      // each tab to sample its own `clock.sharedTimeNow()` inside a
      // `Promise.all` — but Playwright's CDP round-trips happen on
      // independent connections per tab, and JS-engine pauses interleave
      // the two `evaluate()` legs. The two tabs ended up sampling shared-
      // time 5–10 ms apart, which at 1 Hz is 1.8°–3.6° of phase. The
      // test was effectively measuring CDP-jitter, not the shared clock.
      // We bumped the tolerance to 1.05° in PR-55 as a band-aid, but it
      // still failed when CDP latency spiked.
      //
      // The pure fix: pick ONE shared-time and ask both tabs what the LFO
      // phase WOULD be at that time. The phase function is deterministic
      // in (epoch, t_shared, rate); if both tabs agree on the epoch, they
      // MUST produce identical phases for the same t_shared. The only
      // remaining tolerance covers epoch_ms agreement (which is itself
      // sub-millisecond after Yjs settles the meta map — but we still
      // allow a small slack because the meta-map propagation may run
      // a microtask behind awareness).
      //
      // We pick t = epoch + 2000 (2s past the rack epoch) on tab A so
      // it's post-bootstrap, then send that exact shared-time to both
      // tabs via __lfoPhaseAt. Since 2s @ 1 Hz wraps to phase 0, we
      // additionally drift forward by 1234 ms inside the test so we land
      // at a non-trivial phase (~0.234) — this catches a regression
      // where a future refactor accidentally returns a constant.
      const sharedTimeForProbe = await s.pageA.evaluate(() => {
        const w = window as unknown as {
          __sharedClock?: () => { epoch_ms: number | null } | null;
        };
        const c = w.__sharedClock?.();
        if (!c || c.epoch_ms === null) return null;
        return c.epoch_ms + 2000 + 1234;
      });
      expect(sharedTimeForProbe, 'shared-time probe instant').not.toBeNull();

      const [phaseA, phaseB] = await Promise.all(
        [s.pageA, s.pageB].map((p) =>
          p.evaluate(async (t) => {
            const w = window as unknown as {
              __lfoPhaseAt: (id: string, sharedTimeMs: number) => Promise<number | null>;
            };
            return await w.__lfoPhaseAt('shared-lfo', t as number);
          }, sharedTimeForProbe),
        ),
      );

      expect(phaseA, 'phase A').not.toBeNull();
      expect(phaseB, 'phase B').not.toBeNull();
      const a = phaseA as number;
      const b = phaseB as number;
      const wrap = Math.min(Math.abs(a - b), 1 - Math.abs(a - b));
      // With caller-supplied shared-time, the phase delta is now bounded
      // by epoch_ms agreement — typically 0 (both tabs read the same
      // Yjs meta value) but can drift up to RESYNC_SMOOTHING_MS (200 ms)
      // mid-resync. Bound at 0.5°/360 — well below the previous 1°
      // perceptual threshold and 50× tighter than the old 1.05° band-aid.
      const PHASE_TOLERANCE = 0.5 / 360;
      expect(
        wrap,
        `phases A=${a.toFixed(6)} B=${b.toFixed(6)} delta=${wrap.toFixed(6)} (>0.5°/360 = ${PHASE_TOLERANCE.toFixed(6)})`,
      ).toBeLessThan(PHASE_TOLERANCE);
    } finally {
      await s.close();
    }
  });

  // ROOT-CAUSE FIX (June 2026): this test used to sample each tab's
  // `__lfoPhase()` (which reads `clock.sharedTimeNow()` per-tab) and poll
  // for phase ≈ 0 within a 5 s window. But after a resetEpoch the new
  // epoch == "now in shared-time", so the phase is only WITHIN 0.05 of
  // zero for the first 100 ms (rate=0.5 Hz → 0.05/0.5 = 0.1 s). The test
  // was racing a ~100 ms phase window against cross-context Yjs
  // propagation + a per-tab CDP-jittered "now" sample — under the 8-shard
  // split's concurrent dev-server load that window routinely closed
  // before the poll caught it, so the test was effectively measuring
  // propagation latency, not the snap-to-zero behaviour. It was
  // quarantined as flaky.
  //
  // The deterministic fix mirrors `__lfoPhaseAt` (used by the sibling
  // test above): instead of polling a fleeting timing window, we (1)
  // trigger the reset on A and capture the fresh epoch it anchored to,
  // (2) AWAIT a deterministic resync-complete signal — B's reactive
  // `epoch_ms` adopting A's new epoch via the Yjs meta-map observer
  // (this is the "epoch reset propagated" state flag, not a clock-time
  // poll), then (3) evaluate the LFO phase on BOTH tabs AT the epoch
  // instant itself. By construction `computeStateAt(epoch - epoch) =
  // computeStateAt(0)` is phase EXACTLY 0, with zero dependence on
  // sample-time or propagation latency. We additionally assert the epoch
  // actually changed, so a regression where resetEpoch no-ops is caught
  // (a constant-epoch impl would never propagate the new value to B and
  // the resync-complete await would time out).
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

      // Wait for both clocks to converge + publish an epoch before we
      // reset — otherwise resetEpoch() bails early (effectiveOffset null).
      await expect
        .poll(
          async () =>
            Promise.all(
              [s.pageA, s.pageB].map((p) =>
                p.evaluate(() => {
                  const w = window as unknown as {
                    __sharedClock?: () => { snapshot?: { converged?: boolean }; epoch_ms?: number | null } | null;
                  };
                  const c = w.__sharedClock?.();
                  return !!c && !!c.snapshot?.converged && c.epoch_ms !== null;
                }),
              ),
            ).then((res) => res.every((v) => v)),
          { timeout: 10_000 },
        )
        .toBe(true);

      // Record the epoch both tabs share BEFORE the reset, so we can prove
      // the reset actually moved it (a no-op resetEpoch would be a silent
      // regression the phase-0 assertion alone wouldn't catch).
      const epochBefore = await s.pageA.evaluate(() => {
        const w = window as unknown as { __sharedClock?: () => { epoch_ms: number | null } | null };
        return w.__sharedClock?.()?.epoch_ms ?? null;
      });
      expect(epochBefore, 'epoch before reset').not.toBeNull();

      // Let phases run forward a bit so a snap-to-zero is meaningful — the
      // pre-reset LFO is mid-cycle, so re-anchoring to phase 0 is a real
      // observable change rather than a no-op.
      await s.pageA.waitForTimeout(1500);

      // A triggers reset; it anchors a fresh epoch in the Yjs meta map.
      const newEpoch = await s.pageA.evaluate(() => {
        const w = window as unknown as {
          __sharedClock?: () => { resetEpoch: () => void; epoch_ms: number | null } | null;
        };
        const c = w.__sharedClock?.();
        c?.resetEpoch();
        return c?.epoch_ms ?? null;
      });
      expect(newEpoch, 'epoch after reset').not.toBeNull();
      expect(newEpoch, 'reset must advance the epoch').not.toBe(epochBefore);

      // DETERMINISTIC resync-complete signal: await B's reactive epoch_ms
      // adopting A's new epoch through the Yjs meta-map observer. This is
      // the cross-context "the reset propagated" state flag — no clock-time
      // poll, no phase window. Once it's true on both tabs, the snap is
      // fully realized on both clients.
      await expect
        .poll(
          async () =>
            Promise.all(
              [s.pageA, s.pageB].map((p) =>
                p.evaluate((expected) => {
                  const w = window as unknown as { __sharedClock?: () => { epoch_ms: number | null } | null };
                  return w.__sharedClock?.()?.epoch_ms === expected;
                }, newEpoch),
              ),
            ).then((res) => res.every((v) => v)),
          { timeout: 10_000 },
        )
        .toBe(true);

      // Now evaluate each tab's LFO phase AT the new epoch instant. Both
      // tabs agree on epoch_ms (just asserted), so each computes
      // computeStateAt(newEpoch - newEpoch) = computeStateAt(0) = phase 0
      // deterministically — independent of sample-time, CDP jitter, or
      // propagation latency.
      const [a, b] = await Promise.all(
        [s.pageA, s.pageB].map((p) =>
          p.evaluate(async (t) => {
            const w = window as unknown as {
              __lfoPhaseAt: (id: string, sharedTimeMs: number) => Promise<number | null>;
            };
            return await w.__lfoPhaseAt('reset-lfo', t as number);
          }, newEpoch),
        ),
      );

      expect(a, 'phase A at epoch instant').not.toBeNull();
      expect(b, 'phase B at epoch instant').not.toBeNull();
      const near = (v: number) => v < 0.05 || v > 0.95; // ≈ 0 wrapped
      expect(near(a as number), `phase A snapped to 0 (got ${a})`).toBe(true);
      expect(near(b as number), `phase B snapped to 0 (got ${b})`).toBe(true);
    } finally {
      await s.close();
    }
  });
});
