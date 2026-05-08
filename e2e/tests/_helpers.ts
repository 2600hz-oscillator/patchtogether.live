// e2e/tests/_helpers.ts
//
// Shared test helpers for spawning arbitrary modules + edges via the dev-mode
// `__patch` and `__ydoc` window globals (Canvas.svelte exposes these in dev).

import type { Page } from '@playwright/test';

export interface SpawnNode {
  id: string;
  type: string;
  position?: { x: number; y: number };
  params?: Record<string, number>;
  /** Phase 0 video spike — when omitted, defaults to 'audio'. Tests that
   *  spawn video modules (LINES, OUTPUT) pass 'video' explicitly. The
   *  io-spec consistency test infers it from the registered module def
   *  by reading window.__moduleSpecs first; see that test's spawnPatch
   *  call for the pattern. */
  domain?: 'audio' | 'video';
}

export interface SpawnEdge {
  id: string;
  from: { nodeId: string; portId: string };
  to: { nodeId: string; portId: string };
  sourceType?: string;
  targetType?: string;
}

/**
 * Spawn a set of nodes + edges into the patch graph atomically.
 * Requires the dev-only window globals (Canvas exposes them under `import.meta.env.DEV`).
 * Bootstraps the engine by clicking the "Load example" button (the click
 * counts as the user gesture AudioContext needs); the example's nodes are
 * cleared in the same transact that adds the test's patch.
 */
export async function spawnPatch(
  page: Page,
  nodes: SpawnNode[],
  edges: SpawnEdge[] = []
): Promise<void> {
  // Bootstrap the engine directly via the dev __ensureEngine global. We
  // intentionally don't click "Load example" — its auto-playing Sequencer
  // races spawnPatch's clear-then-add and leaves stale DOM. The browser
  // launch flag --autoplay-policy=no-user-gesture-required (in
  // playwright.config.ts) lets AudioContext start without a user gesture,
  // so no click is needed.
  await page.waitForFunction(() => {
    const w = globalThis as unknown as { __ensureEngine?: () => Promise<unknown> };
    return typeof w.__ensureEngine === 'function';
  });
  await page.evaluate(async () => {
    const w = globalThis as unknown as { __ensureEngine: () => Promise<unknown> };
    await w.__ensureEngine();
  });

  // Clear + rebuild the patch in a single page.evaluate to avoid race conditions
  // with the auto-reconciler. We bypass the Clear button (which has been seen
  // to flake under Playwright when the topbar re-renders mid-click) and mutate
  // the patch graph directly via the dev-mode window globals.
  await page.evaluate(
    ({ nodes, edges }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, unknown>; edges: Record<string, unknown> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        for (const id of Object.keys(w.__patch.edges)) delete w.__patch.edges[id];
        for (const id of Object.keys(w.__patch.nodes)) delete w.__patch.nodes[id];
        for (const n of nodes) {
          w.__patch.nodes[n.id] = {
            id: n.id,
            type: n.type,
            domain: (n as { domain?: string }).domain ?? 'audio',
            position: n.position ?? { x: 100, y: 100 },
            params: n.params ?? {},
          };
        }
        for (const e of edges) {
          w.__patch.edges[e.id] = {
            id: e.id,
            source: e.from,
            target: e.to,
            sourceType: e.sourceType ?? 'audio',
            targetType: e.targetType ?? 'audio',
          };
        }
      });
    },
    { nodes, edges }
  );

  // Wait for Svelte Flow to render the requested nodes.
  await page.waitForFunction(
    (n) => document.querySelectorAll('.svelte-flow__node').length === n,
    nodes.length,
    { timeout: 5000 }
  );
}

/** Read a status-bar field value (e.g., readStatus(page, 'nodes') → '5'). */
export async function readStatus(page: Page, field: string): Promise<string> {
  const text = (await page.locator('.bottombar').textContent()) ?? '';
  const m = text.match(new RegExp(`${field}\\s*(\\S+)`));
  return m?.[1] ?? '';
}
