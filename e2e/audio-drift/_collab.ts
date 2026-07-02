// e2e/audio-drift/_collab.ts
//
// Multi-context wiring for the audio-drift research harness. Mirrors the
// pattern in clear-load-multiwindow.spec.ts: bring up the engine on both
// sides BEFORE attaching the Yjs provider, so the reconciler is awake and
// instantiates modules the moment Yjs syncs them in.

import type { Browser, BrowserContext, Page } from '@playwright/test';

export interface CollabPair {
  pageA: Page;
  pageB: Page;
  ctxA: BrowserContext;
  ctxB: BrowserContext;
  rackspaceId: string;
  close: () => Promise<void>;
}

export async function openTwoContexts(browser: Browser): Promise<CollabPair> {
  const rackspaceId = `drift-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  for (const p of [pageA, pageB]) {
    await p.goto('/rack');
    await p.waitForLoadState('networkidle');
    await p.waitForFunction(
      () =>
        typeof (window as unknown as { __attachProvider?: unknown }).__attachProvider === 'function' &&
        typeof (window as unknown as { __ensureEngine?: unknown }).__ensureEngine === 'function',
    );
  }

  // Engine first. Critical: instantiating audio modules requires the AudioContext
  // to exist, which in turn requires either a user gesture or the autoplay-policy
  // launch flag (set in playwright.config.ts).
  await Promise.all(
    [pageA, pageB].map((p) =>
      p.evaluate(async () => {
        const w = window as unknown as { __ensureEngine: () => Promise<unknown> };
        await w.__ensureEngine();
      }),
    ),
  );

  // Provider attach happens in parallel — both contexts join the same rackspace.
  await Promise.all(
    [pageA, pageB].map((p) =>
      p.evaluate(async (id) => {
        const w = window as unknown as {
          __attachProvider: (id: string) => Promise<unknown>;
        };
        await w.__attachProvider(id);
      }, rackspaceId),
    ),
  );

  return {
    pageA,
    pageB,
    ctxA,
    ctxB,
    rackspaceId,
    async close() {
      await Promise.all([ctxA.close().catch(() => {}), ctxB.close().catch(() => {})]);
    },
  };
}

export interface PatchSpec {
  nodes: Array<{
    id: string;
    type: string;
    position?: { x: number; y: number };
    params?: Record<string, number>;
    data?: Record<string, unknown>;
  }>;
  edges: Array<{
    id: string;
    from: { nodeId: string; portId: string };
    to: { nodeId: string; portId: string };
    sourceType?: string;
    targetType?: string;
  }>;
}

/**
 * Author the patch on pageA via a single Yjs transact, then wait for pageB's
 * graph to converge. Returns when both contexts have all nodes + edges.
 */
export async function authorPatchAndAwaitSync(
  pair: CollabPair,
  patch: PatchSpec,
  options: { syncTimeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.syncTimeoutMs ?? 10_000;
  await pair.pageA.evaluate((p) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, unknown>; edges: Record<string, unknown> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      for (const id of Object.keys(w.__patch.edges)) delete w.__patch.edges[id];
      for (const id of Object.keys(w.__patch.nodes)) delete w.__patch.nodes[id];
      for (const n of p.nodes) {
        w.__patch.nodes[n.id] = {
          id: n.id,
          type: n.type,
          domain: 'audio',
          position: n.position ?? { x: 100, y: 100 },
          params: n.params ?? {},
          ...(n.data ? { data: n.data } : {}),
        };
      }
      for (const e of p.edges) {
        w.__patch.edges[e.id] = {
          id: e.id,
          source: e.from,
          target: e.to,
          sourceType: e.sourceType ?? 'audio',
          targetType: e.targetType ?? 'audio',
        };
      }
    });
  }, patch);

  // Wait for pageB to see all nodes and pageA to fully spawn them. Both pages
  // also need engine.nodes populated (the reconciler is async).
  const expectedIds = patch.nodes.map((n) => n.id).sort();
  for (const page of [pair.pageA, pair.pageB]) {
    await page.waitForFunction(
      (ids: string[]) => {
        const w = globalThis as unknown as {
          __engine?: () => {
            getDomain: (d: string) => { nodes: Map<string, unknown> };
          } | null;
        };
        const eng = w.__engine?.();
        if (!eng) return false;
        const audio = eng.getDomain('audio');
        const have = [...audio.nodes.keys()].sort();
        if (have.length !== ids.length) return false;
        for (let i = 0; i < ids.length; i++) {
          if (have[i] !== ids[i]) return false;
        }
        return true;
      },
      expectedIds,
      { timeout: timeoutMs },
    );
  }
}
