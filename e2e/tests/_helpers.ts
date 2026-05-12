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
   *  call for the pattern. The 'meta' domain covers non-engine cards
   *  (sticky notes, future paper-like utilities). */
  domain?: 'audio' | 'video' | 'meta';
}

export interface SpawnEdge {
  id: string;
  from: { nodeId: string; portId: string };
  to: { nodeId: string; portId: string };
  sourceType?: string;
  targetType?: string;
}

/**
 * Match the Playwright/CDP errors thrown when the page's execution context
 * is torn down out-of-band during an `evaluate` / `waitForFunction` — most
 * commonly because Vite's HMR client lost its websocket under CPU pressure
 * (parallel-worker stress) and triggered a full reload (`[vite] connecting...`),
 * or because a navigation interrupted an in-flight evaluate. None of these
 * indicate a test-logic failure: the page recovers on its own, we just have
 * to redo the page-side work after it does.
 */
function isTransientPageError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('Execution context was destroyed') ||
    msg.includes('Target closed') ||
    msg.includes('Target page, context or browser has been closed') ||
    msg.includes('frame was detached') ||
    msg.includes('Cannot find context with specified id')
  );
}

/**
 * Spawn a set of nodes + edges into the patch graph atomically.
 * Requires the dev-only window globals (Canvas exposes them under `import.meta.env.DEV`).
 *
 * The whole sequence (wait-for-globals → ensureEngine → transact → wait-for-DOM)
 * is wrapped in a bounded retry loop so the helper survives a Vite-HMR full
 * reload mid-spawn: under `--workers=4 --repeat-each=10`+ stress, the dev
 * server's HMR websocket occasionally drops and reconnects, which destroys
 * the page's execution context out from under an in-flight `page.evaluate`.
 * Each retry re-waits for `__ensureEngine` to be re-bound by Canvas's $effect
 * after the reload, then restarts the sequence from scratch. Pre-existing
 * latent flake; Playwright's CI `retries: 1` masked it but it still slowed
 * stress runs. The retry is *not* a band-aid for an avoidable race — HMR
 * reload is async to the test and outside the helper's control; handling it
 * here is the correct seam.
 */
export async function spawnPatch(
  page: Page,
  nodes: SpawnNode[],
  edges: SpawnEdge[] = []
): Promise<void> {
  const MAX_ATTEMPTS = 3;
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
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
      return;
    } catch (err) {
      lastErr = err;
      if (!isTransientPageError(err) || attempt === MAX_ATTEMPTS) throw err;
      // HMR full-reload tore down the context. Wait for the new document to
      // be parsed (so __ensureEngine can re-bind via Canvas's $effect) before
      // retrying. networkidle is too strict here (HMR ws stays open).
      await page.waitForLoadState('domcontentloaded').catch(() => {});
    }
  }
  // Unreachable — the loop either returns or throws — but TypeScript can't
  // see that, and we want a useful message if it ever does fall through.
  throw lastErr ?? new Error('spawnPatch: exhausted retries with no error captured');
}

/** Read a status-bar field value (e.g., readStatus(page, 'nodes') → '5'). */
export async function readStatus(page: Page, field: string): Promise<string> {
  const text = (await page.locator('.bottombar').textContent()) ?? '';
  const m = text.match(new RegExp(`${field}\\s*(\\S+)`));
  return m?.[1] ?? '';
}
