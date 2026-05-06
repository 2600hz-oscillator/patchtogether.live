// In-page driver for the chaos runner.
//
// Personalities emit Intents in Node; this module funnels them into a single
// page.evaluate per intent that mutates the patch graph via __patch / __ydoc.
// Mirrors the pattern in e2e/tests/_helpers.ts spawnPatch but applies one
// intent at a time so per-intent invariants can run between calls.

import type { Page } from '@playwright/test';
import type { Intent } from './intent';

/** Boot the engine once. Mirrors the helpers.ts pattern. */
export async function ensureEngineBooted(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const w = globalThis as unknown as { __ensureEngine?: () => Promise<unknown> };
    return typeof w.__ensureEngine === 'function';
  });
  await page.evaluate(async () => {
    const w = globalThis as unknown as { __ensureEngine: () => Promise<unknown> };
    await w.__ensureEngine();
  });
}

/** Wipe nodes + edges so each chaos run starts from a clean slate. */
export async function clearPatch(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, unknown>; edges: Record<string, unknown> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      for (const id of Object.keys(w.__patch.edges)) delete w.__patch.edges[id];
      for (const id of Object.keys(w.__patch.nodes)) delete w.__patch.nodes[id];
    });
  });
}

export async function applyIntent(page: Page, intent: Intent): Promise<void> {
  if (intent.kind === 'sleep') {
    await page.waitForTimeout(intent.ms);
    return;
  }
  await page.evaluate((i: Intent) => {
    if (i.kind === 'sleep') return;
    const w = globalThis as unknown as {
      __patch: {
        nodes: Record<string, {
          id: string;
          type: string;
          domain: string;
          position: { x: number; y: number };
          params: Record<string, number>;
        }>;
        edges: Record<string, {
          id: string;
          source: { nodeId: string; portId: string };
          target: { nodeId: string; portId: string };
          sourceType: string;
          targetType: string;
        }>;
      };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      switch (i.kind) {
        case 'addNode': {
          if (w.__patch.nodes[i.id]) return; // idempotent
          w.__patch.nodes[i.id] = {
            id: i.id,
            type: i.type,
            domain: 'audio',
            position: { x: 100, y: 100 },
            params: {},
          };
          return;
        }
        case 'addEdge': {
          if (w.__patch.edges[i.id]) return;
          w.__patch.edges[i.id] = {
            id: i.id,
            source: { nodeId: i.sourceNodeId, portId: i.sourcePortId },
            target: { nodeId: i.targetNodeId, portId: i.targetPortId },
            sourceType: i.sourceCableType,
            targetType: i.targetCableType,
          };
          return;
        }
        case 'setParam': {
          const n = w.__patch.nodes[i.nodeId];
          if (n) n.params[i.paramId] = i.value;
          return;
        }
        case 'deleteNode': {
          // Drop any edges touching this node first.
          for (const [eid, e] of Object.entries(w.__patch.edges)) {
            if (e.source.nodeId === i.id || e.target.nodeId === i.id) {
              delete w.__patch.edges[eid];
            }
          }
          delete w.__patch.nodes[i.id];
          return;
        }
        case 'deleteEdge': {
          delete w.__patch.edges[i.id];
          return;
        }
      }
    });
  }, intent);
}
