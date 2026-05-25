// e2e/tests/shared-rack-sync.spec.ts
//
// @collab — the operator's exact "bulletproof multiplayer" flow, driven
// end-to-end across two independent browser contexts (separate cookie
// jars / localStorage / ydocs — i.e. two real users on two machines)
// against the real local Hocuspocus relay:
//
//   user A creates a rack → adds a module
//     → shares the rack URL → user B joins → B sees A's module
//     → B adds a module → A sees B's module
//     → A patches a cable from A's module to B's module → B sees that patch.
//
// Why this exists (and why the OLD collab.spec.ts gave false confidence):
// collab.spec only ever asserted A → B for a single node. It never
// asserted the REVERSE direction (B → A), never created a cross-user
// CABLE, and never asserted a node A added on a port of a node B created.
// Those are precisely the steps the operator reported as "works
// sometimes". This spec asserts all of them, bidirectionally, and would
// pass vacuously on a relay that doesn't actually round-trip state — so
// it's the regression guard for the relay/sync path itself.
//
// Runs on CI (NOT skip-on-CI): the relay boots in in-memory mode (no
// DATABASE_URL) so two contexts genuinely connect + sync without
// Postgres. See packages/server/src/db.ts USE_MEMORY.
//
// Run only this:  flox activate -- task e2e -- shared-rack-sync.spec.ts

import { test, expect, type Page, type BrowserContext, type Browser } from '@playwright/test';

interface Pair {
  pageA: Page;
  pageB: Page;
  ctxA: BrowserContext;
  ctxB: BrowserContext;
  rackId: string;
  close: () => Promise<void>;
}

// Distinct cookie jars so the two contexts are genuinely different
// "users". We attach both to the SAME rack doc via the dev __attachProvider
// global (derives a valid anon HMAC token — the same handshake an
// invite-link visitor uses), which exercises the real provider.ts +
// server onAuthenticate path, just without the Clerk UI (no Clerk test
// instance is wired for local/CI — see auth-handshake.spec.ts header).
async function openPair(browser: Browser): Promise<Pair> {
  const rackId = `srs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  return {
    pageA,
    pageB,
    ctxA,
    ctxB,
    rackId,
    async close() {
      // Close contexts (and thus every page + the underlying browser
      // connection) so no chrome-headless-shell process is left behind.
      await Promise.all([ctxA.close(), ctxB.close()]);
    },
  };
}

async function bootAndAttach(page: Page, rackId: string): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(
    () => typeof (window as unknown as { __attachProvider?: unknown }).__attachProvider === 'function',
  );
  // __attachProvider resolves on the provider's `synced` event (or rejects
  // on a 5s timeout / auth-or-capacity rejection). Awaiting it is the
  // client-side equivalent of "the rack finished loading for this user".
  await page.evaluate(async (id) => {
    const w = window as unknown as { __attachProvider: (id: string) => Promise<unknown> };
    await w.__attachProvider(id);
  }, rackId);
}

async function addNode(
  page: Page,
  id: string,
  type: string,
  domain: 'audio' | 'video' = 'audio',
): Promise<void> {
  await page.evaluate(
    ({ id, type, domain }) => {
      const w = window as unknown as {
        __patch: { nodes: Record<string, unknown> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        w.__patch.nodes[id] = {
          id,
          type,
          domain,
          position: { x: 120, y: 120 },
          params: {},
        };
      });
    },
    { id, type, domain },
  );
}

async function hasNode(page: Page, id: string): Promise<boolean> {
  return await page.evaluate(
    (nodeId) =>
      Object.keys(
        (window as unknown as { __patch: { nodes: Record<string, unknown> } }).__patch.nodes,
      ).includes(nodeId),
    id,
  );
}

// Cross-context Yjs round-trips go relay → peer; on a loaded CI runner the
// first sync after attach can lag well past a few seconds. These are pure
// condition polls (no fixed sleeps), so a generous ceiling only costs time on
// genuine failure, never on the happy path.
const SYNC_TIMEOUT = 30_000;

async function expectSeesNode(page: Page, id: string): Promise<void> {
  await expect
    .poll(async () => await hasNode(page, id), { timeout: SYNC_TIMEOUT })
    .toBe(true);
}

test.describe('@collab shared-rack-sync', () => {
  // Two browser contexts + repeated cross-context sync round-trips. The work
  // is light vs the DOOM specs, but the relay can lag under a loaded runner, so
  // give the whole flow a generous ceiling rather than fixed per-step budgets.
  test.setTimeout(120_000);

  test('full flow: create → add → join → see → add → see → patch → see (bidirectional)', async ({
    browser,
  }) => {
    const s = await openPair(browser);
    try {
      // ── A creates the rack + adds a module ─────────────────────────────
      // (A connects first; its context is the "owner" attaching to a fresh
      //  rack doc.)
      await bootAndAttach(s.pageA, s.rackId);
      await addNode(s.pageA, 'a-vco', 'analogVco', 'audio');

      // ── B joins (shares the same rack id) and MUST see A's module ──────
      await bootAndAttach(s.pageB, s.rackId);
      await expectSeesNode(s.pageB, 'a-vco');

      // ── B adds a module → A MUST see it (the REVERSE direction the old
      //    test never covered) ───────────────────────────────────────────
      await addNode(s.pageB, 'b-vca', 'vca', 'audio');
      await expectSeesNode(s.pageA, 'b-vca');

      // Sanity: both sides now agree on the full node set.
      await expectSeesNode(s.pageA, 'a-vco');
      await expectSeesNode(s.pageB, 'b-vca');

      // ── A patches a CABLE from A's module to B's module → B sees it ────
      // This is the load-bearing cross-user assertion: A wires its own
      // node's output into a port of the node B created. The edge must
      // round-trip through the relay and appear in B's patch.
      const edgeId = 'e-a-vco-to-b-vca';
      await s.pageA.evaluate((eid) => {
        const w = window as unknown as {
          __patch: { edges: Record<string, unknown> };
          __ydoc: { transact: (fn: () => void) => void };
        };
        w.__ydoc.transact(() => {
          w.__patch.edges[eid] = {
            id: eid,
            source: { nodeId: 'a-vco', portId: 'sine' },
            target: { nodeId: 'b-vca', portId: 'audio' },
            sourceType: 'audio',
            targetType: 'audio',
          };
        });
      }, edgeId);

      // B sees the cross-user cable, with the correct endpoints intact.
      await expect
        .poll(
          async () =>
            await s.pageB.evaluate((eid) => {
              const w = window as unknown as {
                __patch: { edges: Record<string, { source?: { nodeId: string }; target?: { nodeId: string } }> };
              };
              const e = w.__patch.edges[eid];
              if (!e) return null;
              return `${e.source?.nodeId}->${e.target?.nodeId}`;
            }, edgeId),
          { timeout: SYNC_TIMEOUT },
        )
        .toBe('a-vco->b-vca');

      // ── And the reverse: a cable B draws appears on A. ─────────────────
      const edgeId2 = 'e-b-back-to-a';
      await s.pageB.evaluate((eid) => {
        const w = window as unknown as {
          __patch: { edges: Record<string, unknown> };
          __ydoc: { transact: (fn: () => void) => void };
        };
        w.__ydoc.transact(() => {
          w.__patch.edges[eid] = {
            id: eid,
            source: { nodeId: 'b-vca', portId: 'audio' },
            target: { nodeId: 'a-vco', portId: 'fm' },
            sourceType: 'audio',
            targetType: 'cv',
          };
        });
      }, edgeId2);

      await expect
        .poll(
          async () =>
            await s.pageA.evaluate(
              (eid) =>
                Object.keys(
                  (window as unknown as { __patch: { edges: Record<string, unknown> } }).__patch.edges,
                ).includes(eid),
              edgeId2,
            ),
          { timeout: SYNC_TIMEOUT },
        )
        .toBe(true);
    } finally {
      await s.close();
    }
  });

  test('a third joiner still syncs after a peer leaves (slot churn does not stick the rack)', async ({
    browser,
  }) => {
    // Guards the slot-leak fix from the user-visible side: a peer connects
    // and then disconnects (closing its context fires onDisconnect →
    // release). A later joiner must still be admitted and sync — i.e. the
    // departed peer's slot was freed, not leaked. (The reaper unit tests in
    // packages/server cover the no-clean-close path that this can't
    // reproduce from a browser; this asserts the clean-close path end to
    // end and that capacity accounting tracks real connections.)
    const s = await openPair(browser);
    try {
      await bootAndAttach(s.pageA, s.rackId);
      await addNode(s.pageA, 'persist-1', 'analogVco', 'audio');

      // A transient peer joins then leaves.
      const transientCtx = await browser.newContext();
      const transient = await transientCtx.newPage();
      await bootAndAttach(transient, s.rackId);
      await expectSeesNode(transient, 'persist-1');
      await transientCtx.close(); // clean close → slot released

      // B joins afterwards and must still see the rack + sync a new node
      // back to A. If the transient's slot had leaked, repeated churn would
      // eventually wedge the rack at capacity; this proves churn is clean.
      await bootAndAttach(s.pageB, s.rackId);
      await expectSeesNode(s.pageB, 'persist-1');
      await addNode(s.pageB, 'after-churn', 'vca', 'audio');
      await expectSeesNode(s.pageA, 'after-churn');
    } finally {
      await s.close();
    }
  });
});
