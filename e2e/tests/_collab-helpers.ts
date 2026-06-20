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

// ---------------------------------------------------------------------------
// Cross-context sync budget (the @collab de-flake — task #69).
//
// The @collab lane's chronic CI flake was NOT a real multiplayer regression: a
// cross-context Yjs update (A mutates → relay → B observes) is CORRECT but can
// be SLOW when the single-process Hocuspocus relay's event loop is starved by
// the co-tenant CPU load on a contended GitHub-Actions runner (DOOM WASM, vite
// preview, two browser contexts all share 2–4 vCPU). A flat short budget
// (4s/5s/8s) on the `expect.poll(...)` that waits for B to see A's change then
// times out on a slow-but-correct sync → the whole spec eventually trips its
// test timeout. The relay is already isolated PER CI JOB (Playwright boots its
// own `npm run dev -w packages/server` on :1235 + a per-job Postgres service),
// so there is no shared-relay contention to remove — the fix is to give every
// cross-context CONVERGENCE poll a generous, DETERMINISTIC budget so a correct
// sync that arrives late still passes, while a genuinely-broken sync (never
// converges) still fails at the budget.
//
// SYNC_BUDGET_MS is that single budget. It stays comfortably BELOW each spec's
// test timeout (default 30s; the heavier collab specs set 60s) so a failing
// poll surfaces as a clear assertion failure (not an opaque test timeout). 20s
// gives the relay ~5–10× the headroom a calm relay needs (~1–4s observed)
// without approaching the 30s default.
export const SYNC_BUDGET_MS = 20_000;

// Poll cadence for the convergence waits: back off quickly so we don't hammer
// the (possibly-starved) relay with cross-context `evaluate` round-trips, but
// stay responsive enough that a fast converge returns promptly.
export const SYNC_POLL_INTERVALS = [100, 250, 500, 1000];

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
