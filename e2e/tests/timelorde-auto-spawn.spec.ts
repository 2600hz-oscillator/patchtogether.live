// e2e/tests/timelorde-auto-spawn.spec.ts
//
// TIMELORDE auto-spawn (the long-promised one-per-rack singleton):
// when a rackspace mounts (Hocuspocus provider 'synced' fires) and the
// Yjs doc contains no TIMELORDE node, Canvas drops one in automatically.
// Multiplayer-safe because the predicate runs after sync, so a remote-
// originated TIMELORDE in the doc is observable before we'd duplicate
// it; the engine's maxInstances=1 is the ultimate safety net.
//
// SCOPE: the public `/` demo canvas is intentionally NOT covered here —
// auto-spawn only fires when a provider is bound (`/r/[id]` route or
// the `/`+`__attachProvider` collab-test pattern). That keeps the demo
// "literally empty until you click Load example" workflow intact.
//
// Tagged @collab because the runtime gate (provider 'synced') only
// trips under the same provider-attached harness the @collab suite uses.

import { test, expect } from '@playwright/test';

interface PatchSnapshot {
  nodes: Record<string, { type: string } | undefined>;
}

/** Vite-HMR-tolerant page bootstrap. Under stress (parallel workers
 *  hammering the shared dev server) the HMR websocket occasionally
 *  drops and triggers a full reload mid-test; the Canvas script then
 *  re-runs but our previous `await __attachProvider` is on the dead
 *  context. Detect via the missing pre-effect marker + retry the
 *  attach sequence on a freshly-reloaded page. */
async function attachFreshRackspace(page: import('@playwright/test').Page, id: string): Promise<void> {
  const MAX_ATTEMPTS = 3;
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await page.goto('/');
      await page.waitForLoadState('networkidle');
      await page.waitForFunction(
        () =>
          typeof (window as unknown as { __attachProvider?: unknown }).__attachProvider === 'function'
          && typeof (window as unknown as { __ensureEngine?: unknown }).__ensureEngine === 'function',
        undefined,
        { timeout: 10_000 },
      );
      // Bootstrap the engine before attaching so the reconciler picks up the
      // auto-spawn write.
      await page.evaluate(async () => {
        const w = window as unknown as { __ensureEngine: () => Promise<unknown> };
        await w.__ensureEngine();
      });
      await page.evaluate(async (rid) => {
        const w = window as unknown as { __attachProvider: (id: string) => Promise<unknown> };
        await w.__attachProvider(rid);
      }, id);
      // Final sanity: the Canvas script must have run + its dev marker
      // exists. If it doesn't, HMR likely reloaded the page during
      // __attachProvider; retry.
      await page.waitForFunction(
        () =>
          (window as unknown as { __timelordeAutospawnDebug?: unknown }).__timelordeAutospawnDebug != null,
        undefined,
        { timeout: 5_000 },
      );
      return;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const isTransient =
        msg.includes('Execution context was destroyed')
        || msg.includes('Target closed')
        || msg.includes('frame was detached')
        || msg.includes('Cannot find context')
        || msg.includes('__timelordeAutospawnDebug');
      if (!isTransient || attempt === MAX_ATTEMPTS) throw err;
      await page.waitForLoadState('domcontentloaded').catch(() => {});
    }
  }
  throw lastErr ?? new Error('attachFreshRackspace: exhausted retries');
}

function readPatchNodes(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const w = window as unknown as { __patch: PatchSnapshot };
    return Object.values(w.__patch.nodes ?? {}).map((n) => n?.type ?? null);
  });
}

test.describe('@collab timelorde auto-spawn', () => {
  test('fresh rackspace gets a TIMELORDE within 2s of provider sync', async ({ browser }) => {
    const rackspaceId = `timelorde-autospawn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await attachFreshRackspace(page, rackspaceId);

      // Wait for the auto-spawn $effect to fire post-sync. Generous
      // budget so the assertion doesn't catch the gap between provider
      // 'synced' + Svelte $effect tick on a slow CI runner.
      await page.waitForFunction(
        () => {
          const w = window as unknown as { __patch?: { nodes?: Record<string, { type?: string } | undefined> } };
          if (!w.__patch?.nodes) return false;
          for (const n of Object.values(w.__patch.nodes)) {
            if (n?.type === 'timelorde') return true;
          }
          return false;
        },
        undefined,
        { timeout: 4000 },
      );

      const types = await readPatchNodes(page);
      const timelordeCount = types.filter((t) => t === 'timelorde').length;
      expect(timelordeCount, 'exactly one TIMELORDE auto-spawned').toBe(1);
    } finally {
      await ctx.close().catch(() => {});
    }
  });

  test('rack that already has TIMELORDE: no duplicate spawned on second mount', async ({ browser }) => {
    // First mount creates TIMELORDE via auto-spawn; second mount on the
    // same rackspaceId attaches to the existing Y.Doc + observes the
    // existing TIMELORDE, so the predicate short-circuits.
    const rackspaceId = `timelorde-existing-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    try {
      await attachFreshRackspace(pageA, rackspaceId);
      await pageA.waitForFunction(
        () => {
          const w = window as unknown as { __patch?: { nodes?: Record<string, { type?: string } | undefined> } };
          for (const n of Object.values(w.__patch?.nodes ?? {})) {
            if (n?.type === 'timelorde') return true;
          }
          return false;
        },
        undefined,
        { timeout: 4000 },
      );

      // Second context on the same rackspaceId. After provider sync, it
      // should see the existing TIMELORDE and NOT add another.
      const ctxB = await browser.newContext();
      const pageB = await ctxB.newPage();
      try {
        await attachFreshRackspace(pageB, rackspaceId);
        // Give the auto-spawn $effect a fair chance to fire (and find
        // the existing TIMELORDE → no-op).
        await pageB.waitForFunction(
          () => {
            const w = window as unknown as { __patch?: { nodes?: Record<string, { type?: string } | undefined> } };
            for (const n of Object.values(w.__patch?.nodes ?? {})) {
              if (n?.type === 'timelorde') return true;
            }
            return false;
          },
          undefined,
          { timeout: 4000 },
        );

        // Modest wait so a late spawn would have time to land. 750ms is
        // ~30 scheduler-clock ticks; if duplicate-spawn were going to
        // happen it would happen well before that.
        await pageB.waitForTimeout(750);

        const typesA = await readPatchNodes(pageA);
        const typesB = await readPatchNodes(pageB);
        const countA = typesA.filter((t) => t === 'timelorde').length;
        const countB = typesB.filter((t) => t === 'timelorde').length;
        expect(countA, 'page A still has exactly one TIMELORDE').toBe(1);
        expect(countB, 'page B sees the same single TIMELORDE, no dup').toBe(1);
      } finally {
        await ctxB.close().catch(() => {});
      }
    } finally {
      await ctxA.close().catch(() => {});
    }
  });

  // Phase 4c — post-merge singleton cleanup. A merge-race can leave the
  // converged doc with TWO TIMELORDE nodes (each peer inserted one before
  // seeing the other's write). TIMELORDE is undeletable, so without the
  // cleanup the duplicate is an unrecoverable ghost. We reproduce the
  // CONVERGED end-state deterministically — inject a second TIMELORDE
  // straight into the live Yjs doc (what the merge would produce) — and
  // assert the Canvas cleanup $effect deletes the lex-larger duplicate,
  // converging back to EXACTLY ONE (never zero, never two).
  test('post-merge cleanup removes a duplicate TIMELORDE, converging to exactly one', async ({ browser }) => {
    const rackspaceId = `timelorde-dedupe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await attachFreshRackspace(page, rackspaceId);

      // Wait for the auto-spawn to land the canonical TIMELORDE.
      await page.waitForFunction(
        () => {
          const w = window as unknown as { __patch?: { nodes?: Record<string, { type?: string } | undefined> } };
          for (const n of Object.values(w.__patch?.nodes ?? {})) {
            if (n?.type === 'timelorde') return true;
          }
          return false;
        },
        undefined,
        { timeout: 4000 },
      );

      // Inject a SECOND TIMELORDE with a deterministically lex-LARGER id than
      // any auto-spawned one (the auto id is `timelorde-<8 hex>`; "zzzzzzzz"
      // sorts after every lowercase-hex suffix). This is exactly what a
      // merged-in remote duplicate looks like in the converged doc. Written
      // through the live Yjs doc so the snapshot bus + Canvas cleanup $effect
      // observe it.
      await page.evaluate(() => {
        const w = window as unknown as {
          __ydoc: { transact: (fn: () => void) => void };
          __patch: { nodes: Record<string, unknown> };
        };
        w.__ydoc.transact(() => {
          w.__patch.nodes['timelorde-zzzzzzzz'] = {
            id: 'timelorde-zzzzzzzz',
            type: 'timelorde',
            domain: 'audio',
            position: { x: 999, y: 999 },
            params: {},
            data: {},
          };
        });
      });

      // The cleanup $effect should fire on the next snapshot and delete the
      // lex-larger duplicate. Wait for the count to return to exactly one.
      await page.waitForFunction(
        () => {
          const w = window as unknown as { __patch?: { nodes?: Record<string, { type?: string } | undefined> } };
          const count = Object.values(w.__patch?.nodes ?? {}).filter((n) => n?.type === 'timelorde').length;
          return count === 1;
        },
        undefined,
        { timeout: 4000 },
      );

      const types = await readPatchNodes(page);
      const count = types.filter((t) => t === 'timelorde').length;
      expect(count, 'exactly one TIMELORDE after cleanup (duplicate removed)').toBe(1);

      // The survivor must NOT be the injected lex-larger one — the deterministic
      // lex-survivor keeps the lex-smallest id.
      const survived = await page.evaluate(() => {
        const w = window as unknown as { __patch: { nodes: Record<string, { id?: string; type?: string } | undefined> } };
        return Object.values(w.__patch.nodes)
          .filter((n) => n?.type === 'timelorde')
          .map((n) => n?.id ?? null);
      });
      expect(survived).not.toContain('timelorde-zzzzzzzz');
    } finally {
      await ctx.close().catch(() => {});
    }
  });
});
