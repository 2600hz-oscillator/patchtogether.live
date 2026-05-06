// e2e/tests/_collab-helpers.ts
//
// Multi-context test harness for the multi-user (@collab) flow. Wired in
// Phase 2 so that Phase 4 (Hocuspocus + WebRTC mesh) lands with the test
// infrastructure already in place — at that point we flip `test.skip` to
// `test` and the asserts come alive.
//
// Each call opens N independent browser contexts on the same canvasId. Each
// context has its own cookie jar, localStorage, and AudioContext, so they
// behave like separate "users on different machines" sharing one canvas.

import type { Browser, Page, BrowserContext } from '@playwright/test';

export interface CollabSession {
  contexts: BrowserContext[];
  pages: Page[];
  canvasId: string;
  /** Close every context. Call this at end of test. */
  close: () => Promise<void>;
}

/**
 * Open `count` browser contexts on the same canvasId and load the app in each.
 * Until Phase 4 wires the Yjs provider, every context starts with an empty
 * patch (no cross-context sync) — tests that depend on convergence are
 * `test.skip`'d via the `@collab` tag.
 */
export async function openCollab(
  browser: Browser,
  count: number,
  options: { baseURL?: string; canvasId?: string } = {},
): Promise<CollabSession> {
  const baseURL = options.baseURL ?? process.env.E2E_BASE_URL ?? 'http://localhost:5173';
  const canvasId = options.canvasId ?? `collab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const contexts: BrowserContext[] = [];
  const pages: Page[] = [];
  for (let i = 0; i < count; i++) {
    const ctx = await browser.newContext({ baseURL });
    const page = await ctx.newPage();
    // Phase 4+ will read this query param and pass it to attachProvider().
    await page.goto(`/?canvas=${encodeURIComponent(canvasId)}`);
    await page.waitForLoadState('networkidle');
    contexts.push(ctx);
    pages.push(page);
  }

  return {
    contexts,
    pages,
    canvasId,
    async close() {
      await Promise.all(contexts.map((c) => c.close()));
    },
  };
}
