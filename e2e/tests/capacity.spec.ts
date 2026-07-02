// e2e/tests/capacity.spec.ts
//
// @capacity tests: per-rackspace concurrent-connection cap (Stage B PR B-d).
// Cap is 4 total; the 5th visitor is rejected at the auth handshake and
// gets surfaced as `rackspace-full` to the client.
//
// Run only @capacity:  flox activate -- task e2e -- --grep @capacity

import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

interface CapacitySession {
  contexts: BrowserContext[];
  pages: Page[];
  close: () => Promise<void>;
}

async function openContexts(browser: Browser, n: number): Promise<CapacitySession> {
  const contexts: BrowserContext[] = [];
  const pages: Page[] = [];
  for (let i = 0; i < n; i++) {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await p.goto('/rack');
    await p.waitForLoadState('networkidle');
    await p.waitForFunction(
      () =>
        typeof (window as unknown as { __attachProvider?: unknown }).__attachProvider === 'function',
    );
    contexts.push(ctx);
    pages.push(p);
  }
  return {
    contexts,
    pages,
    // Teardown is best-effort: by the time finally{} runs, some contexts
    // may already have been closed explicitly inside the test body (see
    // the "frees a slot on disconnect" case at line ~86) OR torn down by
    // Playwright after a worker timeout. Promise.all rejects-fast on the
    // first close() that lands on an already-disposed context with
    // "Target page, context or browser has been closed" / "Failed to
    // find context with id ..." — which then crashes the test from
    // inside finally{}, masking any earlier real failure and showing up
    // as the chronic shard-1 flake. Switch to allSettled + swallow the
    // expected "already closed" errors so teardown is idempotent.
    close: async () => {
      const results = await Promise.allSettled(
        // Snapshot `contexts` here so the session.close() seen by the
        // test reflects the contexts owned at close-time (the test may
        // splice this array — see s.contexts.splice(0, 1) in the
        // disconnect test).
        contexts.slice().map(async (c) => {
          try {
            await c.close();
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            // Already-closed sentinels — safe to ignore in teardown.
            if (
              /Target (?:page|context|browser) (?:has been |is )closed/i.test(msg) ||
              /Failed to find context with id/i.test(msg) ||
              /Browser has been closed/i.test(msg)
            ) {
              return;
            }
            throw e;
          }
        }),
      );
      // If any non-tolerated error came through (re-thrown above and
      // turned into a rejection), surface the first one so a real
      // teardown bug is still visible.
      const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failed) throw failed.reason;
    },
  };
}

async function attach(page: Page, rackspaceId: string): Promise<{ ok: boolean; reason?: string }> {
  return await page.evaluate(async (id) => {
    const w = window as unknown as { __attachProvider: (id: string) => Promise<unknown> };
    try {
      await w.__attachProvider(id);
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }, rackspaceId);
}

test.describe('@capacity', () => {
  test('admits 4 concurrent connections, rejects the 5th with rackspace-full', async ({
    browser,
  }) => {
    const rackspaceId = `cap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const s = await openContexts(browser, 5);
    try {
      // First four should sync without error.
      for (let i = 0; i < 4; i++) {
        const r = await attach(s.pages[i], rackspaceId);
        expect(r.ok, `context ${i} attach: ${r.reason ?? 'ok'}`).toBe(true);
      }

      // Fifth should reject with rackspace-full.
      const fifth = await attach(s.pages[4], rackspaceId);
      expect(fifth.ok).toBe(false);
      expect(fifth.reason).toBe('rackspace-full');
    } finally {
      await s.close();
    }
  });

  test('frees a slot on disconnect; the previously-rejected context can attach next', async ({
    browser,
  }) => {
    const rackspaceId = `cap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const s = await openContexts(browser, 4);
    try {
      for (let i = 0; i < 4; i++) {
        const r = await attach(s.pages[i], rackspaceId);
        expect(r.ok).toBe(true);
      }

      // Close one context (releases its slot on disconnect). Wait briefly
      // so the server's onDisconnect lands before the next attach.
      await s.contexts[0].close();
      s.contexts.splice(0, 1);
      s.pages.splice(0, 1);
      await new Promise((r) => setTimeout(r, 500));

      // Open a fresh fifth context and attach — should succeed now.
      const ctx = await browser.newContext();
      const p = await ctx.newPage();
      await p.goto('/rack');
      await p.waitForLoadState('networkidle');
      await p.waitForFunction(
        () =>
          typeof (window as unknown as { __attachProvider?: unknown }).__attachProvider ===
          'function',
      );
      s.contexts.push(ctx);
      s.pages.push(p);

      const r = await attach(p, rackspaceId);
      expect(r.ok, `re-attach after disconnect: ${r.reason ?? 'ok'}`).toBe(true);
    } finally {
      await s.close();
    }
  });
});
