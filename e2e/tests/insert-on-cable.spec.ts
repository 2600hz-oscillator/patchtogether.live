// e2e/tests/insert-on-cable.spec.ts
//
// Proposal B2 — releasing a palette-spawned card within ~12px of an
// existing cable's midpoint splices the new card into the cable:
//   - Removes the original edge.
//   - Adds source→new.firstCompatibleInput.
//   - Adds new.firstCompatibleOutput→target.
// When the new card has no compatible input OR no compatible output for
// the cable's type, the splice is refused and a normal spawn-at-cursor
// happens instead.

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

interface PatchEdge {
  id: string;
  source: { nodeId: string; portId: string };
  target: { nodeId: string; portId: string };
  sourceType: string;
  targetType: string;
}

async function readEdges(page: Page): Promise<PatchEdge[]> {
  return await page.evaluate(() => {
    const w = window as unknown as { __patch: { edges: Record<string, PatchEdge> } };
    return Object.values(w.__patch.edges).filter(Boolean) as PatchEdge[];
  });
}

async function readNodeIds(page: Page): Promise<string[]> {
  return await page.evaluate(() => {
    const w = window as unknown as { __patch: { nodes: Record<string, unknown> } };
    return Object.keys(w.__patch.nodes);
  });
}

/** Compute the geometric midpoint of an edge in flow-space, reading
 *  xyflow's measured handle bounds. Mirrors Canvas.svelte's edgeMidpoint
 *  helper so the test pins behavior independently of the Canvas code. */
async function midpointOfEdge(page: Page, edgeId: string): Promise<{ x: number; y: number }> {
  return await page.evaluate((id) => {
    const w = window as unknown as {
      __patch: { edges: Record<string, PatchEdge> };
      __flow: {
        getInternalNode: (id: string) => {
          measured?: { width?: number; height?: number };
          position?: { x: number; y: number };
          internals?: {
            positionAbsolute?: { x: number; y: number };
            handleBounds?: {
              source?: Array<{ id: string | null; x: number; y: number; width: number; height: number }>;
              target?: Array<{ id: string | null; x: number; y: number; width: number; height: number }>;
            };
          };
        } | undefined;
      };
    };
    const e = w.__patch.edges[id]!;
    const sn = w.__flow.getInternalNode(e.source.nodeId)!;
    const dn = w.__flow.getInternalNode(e.target.nodeId)!;
    const pointFor = (
      n: typeof sn,
      side: 'source' | 'target',
      portId: string,
    ): { x: number; y: number } => {
      const pa = n.internals?.positionAbsolute ?? { x: n.position?.x ?? 0, y: n.position?.y ?? 0 };
      const bucket = n.internals?.handleBounds?.[side];
      const h = bucket?.find((b) => b.id === portId);
      if (h) return { x: pa.x + h.x + h.width / 2, y: pa.y + h.y + h.height / 2 };
      const w_ = n.measured?.width ?? 240;
      const h_ = n.measured?.height ?? 200;
      return { x: pa.x + (side === 'source' ? w_ : 0), y: pa.y + h_ / 2 };
    };
    const a = pointFor(sn, 'source', e.source.portId);
    const b = pointFor(dn, 'target', e.target.portId);
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }, edgeId);
}

test('palette drop within 12px of cable midpoint splices a compatible module', async ({ page, rack }) => {
  // LFO (cv outputs) → FILTER (cv input on cutoff). Wide separation so
  // the midpoint is comfortably inside the canvas.
  await spawnPatch(
    page,
    [
      { id: 'lfo-a', type: 'lfo', position: { x: 80, y: 200 } },
      { id: 'fil-a', type: 'filter', position: { x: 800, y: 200 } },
    ],
    [
      {
        id: 'e-lfo-fil',
        from: { nodeId: 'lfo-a', portId: 'phase0' },
        to: { nodeId: 'fil-a', portId: 'cutoff' },
        sourceType: 'cv',
        targetType: 'cv',
      },
    ],
  );

  // Wait for the cable to render so handleBounds are measured.
  await expect(page.locator('.svelte-flow__edge')).toHaveCount(1);
  // Give xyflow a frame to measure handle positions.
  await page.waitForFunction(() => {
    const w = window as unknown as {
      __flow: { getInternalNode: (id: string) => { internals?: { handleBounds?: unknown } } | undefined };
    };
    const n = w.__flow.getInternalNode('lfo-a');
    return !!n?.internals?.handleBounds;
  });

  const mid = await midpointOfEdge(page, 'e-lfo-fil');
  const idsBefore = await readNodeIds(page);

  // Spawn UNITYSCALEMATHEMATIK directly at the cable midpoint — its
  // u_in/u_out ports are cv↔cv so the splice is permitted.
  await page.evaluate(({ pos }) => {
    const w = window as unknown as { __spawnAtFlowPos: (type: string, p: { x: number; y: number }) => void };
    w.__spawnAtFlowPos('unityscalemathematik', pos);
  }, { pos: mid });

  await expect(page.locator('.svelte-flow__node-unityscalemathematik')).toHaveCount(1);

  const edges = await readEdges(page);
  // Original LFO → FILTER edge is gone.
  expect(edges.find((e) => e.id === 'e-lfo-fil'), 'original cable removed').toBeUndefined();
  // The new node id is whatever we just added.
  const newIds = (await readNodeIds(page)).filter((id) => !idsBefore.includes(id));
  expect(newIds.length).toBe(1);
  const newId = newIds[0]!;

  const lfoToNew = edges.find(
    (e) => e.source.nodeId === 'lfo-a' && e.target.nodeId === newId,
  );
  const newToFilter = edges.find(
    (e) => e.source.nodeId === newId && e.target.nodeId === 'fil-a',
  );
  expect(lfoToNew, 'LFO → new card edge exists').toBeDefined();
  expect(newToFilter, 'new card → FILTER edge exists').toBeDefined();
  expect(lfoToNew!.sourceType).toBe('cv');
  expect(newToFilter!.targetType).toBe('cv');
});

test('palette drop near cable falls back to normal spawn when new module has no compatible input', async ({ page, rack }) => {
  // Same cv-typed cable, but NOISE has no inputs at all — splice must
  // fall back to a plain spawn-at-cursor.
  await spawnPatch(
    page,
    [
      { id: 'lfo-b', type: 'lfo', position: { x: 80, y: 200 } },
      { id: 'fil-b', type: 'filter', position: { x: 800, y: 200 } },
    ],
    [
      {
        id: 'e-lfo-fil-b',
        from: { nodeId: 'lfo-b', portId: 'phase0' },
        to: { nodeId: 'fil-b', portId: 'cutoff' },
        sourceType: 'cv',
        targetType: 'cv',
      },
    ],
  );
  await expect(page.locator('.svelte-flow__edge')).toHaveCount(1);
  await page.waitForFunction(() => {
    const w = window as unknown as {
      __flow: { getInternalNode: (id: string) => { internals?: { handleBounds?: unknown } } | undefined };
    };
    const n = w.__flow.getInternalNode('lfo-b');
    return !!n?.internals?.handleBounds;
  });

  const mid = await midpointOfEdge(page, 'e-lfo-fil-b');

  await page.evaluate(({ pos }) => {
    const w = window as unknown as { __spawnAtFlowPos: (type: string, p: { x: number; y: number }) => void };
    w.__spawnAtFlowPos('noise', pos);
  }, { pos: mid });

  await expect(page.locator('.svelte-flow__node-noise')).toHaveCount(1);

  // Original cable still present — splice was refused (no inputs on NOISE).
  const edges = await readEdges(page);
  expect(edges.find((e) => e.id === 'e-lfo-fil-b'), 'original cable preserved').toBeDefined();
  expect(edges.length, 'exactly the original cable, no new edges from splice').toBe(1);
});

test('palette drop outside 12px tolerance does NOT splice', async ({ page, rack }) => {
  await spawnPatch(
    page,
    [
      { id: 'lfo-c', type: 'lfo', position: { x: 80, y: 200 } },
      { id: 'fil-c', type: 'filter', position: { x: 800, y: 200 } },
    ],
    [
      {
        id: 'e-lfo-fil-c',
        from: { nodeId: 'lfo-c', portId: 'phase0' },
        to: { nodeId: 'fil-c', portId: 'cutoff' },
        sourceType: 'cv',
        targetType: 'cv',
      },
    ],
  );
  await expect(page.locator('.svelte-flow__edge')).toHaveCount(1);
  await page.waitForFunction(() => {
    const w = window as unknown as {
      __flow: { getInternalNode: (id: string) => { internals?: { handleBounds?: unknown } } | undefined };
    };
    const n = w.__flow.getInternalNode('lfo-c');
    return !!n?.internals?.handleBounds;
  });

  const mid = await midpointOfEdge(page, 'e-lfo-fil-c');
  // 50px below the midpoint — well outside the 12px threshold.
  const far = { x: mid.x, y: mid.y + 50 };

  await page.evaluate(({ pos }) => {
    const w = window as unknown as { __spawnAtFlowPos: (type: string, p: { x: number; y: number }) => void };
    w.__spawnAtFlowPos('unityscalemathematik', pos);
  }, { pos: far });

  await expect(page.locator('.svelte-flow__node-unityscalemathematik')).toHaveCount(1);

  const edges = await readEdges(page);
  // Original edge preserved, no splice edges added.
  expect(edges.length, 'only original edge survives').toBe(1);
  expect(edges[0]!.id).toBe('e-lfo-fil-c');
});
