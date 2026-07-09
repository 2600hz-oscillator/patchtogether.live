// e2e/tests/instrument-exposed-port-patching.spec.ts
//
// Regression for the user-reported bug:
//   "Cables won't connect to or from ports exposed on a grouped instrument."
//
// Repro: a `DMT_WARP` instrument containing 6 modules exposed the LUMAKEY
// child's `out` port as `OUT--LUMAKEY-FD8329B3--OUT`. Dragging from that
// exposed handle to VIDEOOUT2.IN did not create a cable.
//
// Root cause: Canvas.svelte's `handleConnect` resolved `srcDef`/`dstDef`
// via `getModuleDef ?? getVideoModuleDef` only — neither knows about the
// meta-domain `group` def. For a connection whose source OR target was a
// group node, both lookups returned undefined and the function bailed
// before it added the edge to the patch (`if (!srcDef || !dstDef) return`).
// Same flaw existed in the right-click "patch to" cascade commit path
// (`pickPortMenuTarget`).
//
// Fix: resolve a group-node endpoint through `resolveExposedPort(node,
// handleId)` first — it returns the underlying child's cable type so the
// cable-type fallback still picks the right transport. The edge is still
// addressed to the GROUP node + exposed-handle id; the snapshot-projection
// layer (`group-projection.ts`) rewrites the endpoints to the real child
// before the reconciler sees them.
//
// What we assert (the user's repro, minimised):
//   1. spawn TWO source modules (LFO + FILTER) on the canvas.
//   2. group them with the FILTER's `audio` output exposed.
//   3. spawn AUDIOOUT.
//   4. drive a connect-commit from group.<exposed> → audioOut.L by
//      invoking the SAME `handleConnect(Connection)` callback xyflow
//      would fire on a real pointer drag (via the dev-only
//      `window.__handleConnect` hook).
//   5. assert: an edge for that connection exists in window.__patch.edges
//      AND its source is { nodeId: group, portId: exposedId } (the
//      canvas-side representation — projection rewrites to flt-1.audio
//      before the engine sees it).
//
// Also asserts the symmetric "exposed INPUT fed by external source" case
// so both edge directions are covered.

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

interface PatchNode {
  id: string;
  type: string;
  domain: string;
  position: { x: number; y: number };
  params: Record<string, number>;
  data?: Record<string, unknown>;
}
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

/** Drive Canvas.handleConnect via the dev-only window hook. Mirrors xyflow's
 *  `Connection` envelope exactly so we exercise the real production code
 *  path (no test-only branch). */
async function driveConnect(
  page: Page,
  src: { nodeId: string; handleId: string },
  dst: { nodeId: string; handleId: string },
): Promise<void> {
  await page.evaluate(
    ({ src, dst }) => {
      const w = window as unknown as {
        __handleConnect: (c: {
          source: string;
          target: string;
          sourceHandle: string;
          targetHandle: string;
        }) => void;
      };
      w.__handleConnect({
        source: src.nodeId,
        target: dst.nodeId,
        sourceHandle: src.handleId,
        targetHandle: dst.handleId,
      });
    },
    { src, dst },
  );
}

/** Boot the page + spawn LFO + FILTER, then group them with FILTER's audio
 *  output exposed. Returns the group + exposed-port ids the test will use. */
async function setupInstrumentWithExposedOutput(page: Page): Promise<{
  groupId: string;
  exposedOutId: string;
}> {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  // Three real-engine modules: LFO + FILTER (will be grouped) + AUDIOOUT
  // (external — the cable target).
  await spawnPatch(
    page,
    [
      { id: 'lfo-1', type: 'lfo',      position: { x: 100, y: 100 }, domain: 'audio' },
      { id: 'flt-1', type: 'filter',   position: { x: 400, y: 100 }, domain: 'audio' },
      { id: 'out-1', type: 'audioOut', position: { x: 800, y: 100 }, domain: 'audio' },
    ],
    // Internal cable kept intentionally so the group has live audio.
    [
      { id: 'e-int', from: { nodeId: 'lfo-1', portId: 'phase0' }, to: { nodeId: 'flt-1', portId: 'cutoff' }, sourceType: 'cv', targetType: 'cv' },
    ],
  );

  // Drive the create-group action (same shape as GroupBuilderModal commits).
  const groupId = 'g-instr-1';
  const exposedOutId = 'OUT--FILTER--AUDIO';
  await page.evaluate(
    ({ groupId, exposedOutId }) => {
      const w = window as unknown as {
        __patch: { nodes: Record<string, PatchNode> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        w.__patch.nodes[groupId] = {
          id: groupId,
          type: 'group',
          domain: 'meta',
          position: { x: 250, y: 100 },
          params: {},
          data: {
            childIds: ['lfo-1', 'flt-1'],
            exposedPorts: [
              {
                id: exposedOutId,
                childId: 'flt-1',
                childPortId: 'audio',
                direction: 'output',
                cableType: 'audio',
              },
            ],
          },
        } as PatchNode;
        for (const cid of ['lfo-1', 'flt-1']) {
          const n = w.__patch.nodes[cid];
          if (n) {
            if (!n.data) n.data = {};
            (n.data as { parentGroupId?: string }).parentGroupId = groupId;
          }
        }
      });
    },
    { groupId, exposedOutId },
  );

  // Wait for the GroupCard to render (collapses lfo + flt out of the DOM).
  await expect(page.locator(`[data-testid="group-card"][data-node-id="${groupId}"]`)).toBeVisible();
  return { groupId, exposedOutId };
}

test('exposed group OUTPUT → external INPUT: cable lands in patch.edges (regression)', async ({ page }) => {
  const { groupId, exposedOutId } = await setupInstrumentWithExposedOutput(page);

  // Pre-condition: only the internal lfo→flt edge exists.
  expect(await readEdges(page)).toHaveLength(1);

  // The exact failing user gesture: drag from group's exposed OUT to
  // audioOut.L. Pre-fix, this returned silently from handleConnect
  // because getModuleDef('group') ?? getVideoModuleDef('group') was
  // undefined and the function bailed at `if (!srcDef || !dstDef) return`.
  await driveConnect(
    page,
    { nodeId: groupId, handleId: exposedOutId },
    { nodeId: 'out-1', handleId: 'L' },
  );

  // The edge must now exist in patch.edges, addressed to the GROUP node
  // + exposed handle id (group-projection.ts rewrites it to flt-1.audio
  // before the reconciler sees it; that's tested in the unit suite).
  const edges = await readEdges(page);
  const ext = edges.find((e) => e.source.nodeId === groupId);
  expect(ext, 'expected new edge sourced from group exposed port').toBeDefined();
  expect(ext!.source).toEqual({ nodeId: groupId, portId: exposedOutId });
  expect(ext!.target).toEqual({ nodeId: 'out-1', portId: 'L' });
  // Cable type was resolved via the exposed port's declared `cableType`
  // (audio) — not the audioOut.L input's type (which would also be audio
  // here, but the point is the fallback chain ran, not bailed).
  expect(ext!.sourceType).toBe('audio');
});

test('exposed group INPUT ← external SOURCE: cable lands in patch.edges (regression)', async ({ page, rack }) => {
  // VCO + FILTER will be grouped (FILTER.cutoff exposed). External LFO
  // will feed the exposed cutoff.
  await spawnPatch(
    page,
    [
      { id: 'lfo-ext', type: 'lfo',    position: { x: 50,  y: 50  }, domain: 'audio' },
      { id: 'vco-1',   type: 'analogVco', position: { x: 200, y: 200 }, domain: 'audio' },
      { id: 'flt-1',   type: 'filter', position: { x: 500, y: 200 }, domain: 'audio' },
    ],
    [],
  );

  const groupId = 'g-instr-2';
  const exposedInId = 'IN--FILTER--CUTOFF';
  await page.evaluate(
    ({ groupId, exposedInId }) => {
      const w = window as unknown as {
        __patch: { nodes: Record<string, PatchNode> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        w.__patch.nodes[groupId] = {
          id: groupId,
          type: 'group',
          domain: 'meta',
          position: { x: 350, y: 200 },
          params: {},
          data: {
            childIds: ['vco-1', 'flt-1'],
            exposedPorts: [
              {
                id: exposedInId,
                childId: 'flt-1',
                childPortId: 'cutoff',
                direction: 'input',
                cableType: 'cv',
              },
            ],
          },
        } as PatchNode;
        for (const cid of ['vco-1', 'flt-1']) {
          const n = w.__patch.nodes[cid];
          if (n) {
            if (!n.data) n.data = {};
            (n.data as { parentGroupId?: string }).parentGroupId = groupId;
          }
        }
      });
    },
    { groupId, exposedInId },
  );
  await expect(page.locator(`[data-testid="group-card"][data-node-id="${groupId}"]`)).toBeVisible();

  // Pre-condition: no edges.
  expect(await readEdges(page)).toHaveLength(0);

  // Drive: external LFO → group's exposed INPUT.
  await driveConnect(
    page,
    { nodeId: 'lfo-ext', handleId: 'phase0' },
    { nodeId: groupId, handleId: exposedInId },
  );

  const edges = await readEdges(page);
  const ext = edges.find((e) => e.target.nodeId === groupId);
  expect(ext, 'expected new edge targeting group exposed port').toBeDefined();
  expect(ext!.source).toEqual({ nodeId: 'lfo-ext', portId: 'phase0' });
  expect(ext!.target).toEqual({ nodeId: groupId, portId: exposedInId });
  // Cable type follows the exposed port's declared cableType (cv).
  expect(ext!.targetType).toBe('cv');
});

test('connect with both endpoints on (different) groups: cable still lands (sanity)', async ({ page, rack }) => {
  // Edge case: two grouped instruments wired together. Source group's
  // exposed OUTPUT → dest group's exposed INPUT. Pre-fix, neither def
  // resolved + the connect bailed. This catches a regression where the
  // fix accidentally short-circuited only one side of the lookup.
  await spawnPatch(
    page,
    [
      { id: 'src-vco', type: 'analogVco', position: { x: 100, y: 100 }, domain: 'audio' },
      { id: 'dst-flt', type: 'filter',    position: { x: 600, y: 100 }, domain: 'audio' },
    ],
    [],
  );
  await page.evaluate(() => {
    const w = window as unknown as {
      __patch: { nodes: Record<string, PatchNode> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      w.__patch.nodes['g-src'] = {
        id: 'g-src',
        type: 'group',
        domain: 'meta',
        position: { x: 100, y: 100 },
        params: {},
        data: {
          childIds: ['src-vco'],
          exposedPorts: [
            { id: 'OUT--VCO', childId: 'src-vco', childPortId: 'sine', direction: 'output', cableType: 'audio' },
          ],
        },
      } as PatchNode;
      w.__patch.nodes['g-dst'] = {
        id: 'g-dst',
        type: 'group',
        domain: 'meta',
        position: { x: 600, y: 100 },
        params: {},
        data: {
          childIds: ['dst-flt'],
          exposedPorts: [
            { id: 'IN--FLT', childId: 'dst-flt', childPortId: 'audio', direction: 'input', cableType: 'audio' },
          ],
        },
      } as PatchNode;
      for (const [cid, gid] of [['src-vco', 'g-src'], ['dst-flt', 'g-dst']]) {
        const n = w.__patch.nodes[cid];
        if (n) {
          if (!n.data) n.data = {};
          (n.data as { parentGroupId?: string }).parentGroupId = gid;
        }
      }
    });
  });
  await expect(page.locator('[data-testid="group-card"][data-node-id="g-src"]')).toBeVisible();
  await expect(page.locator('[data-testid="group-card"][data-node-id="g-dst"]')).toBeVisible();

  await driveConnect(
    page,
    { nodeId: 'g-src', handleId: 'OUT--VCO' },
    { nodeId: 'g-dst', handleId: 'IN--FLT' },
  );

  const edges = await readEdges(page);
  const ext = edges.find((e) => e.source.nodeId === 'g-src' && e.target.nodeId === 'g-dst');
  expect(ext, 'expected edge between two groups').toBeDefined();
  expect(ext!.source).toEqual({ nodeId: 'g-src', portId: 'OUT--VCO' });
  expect(ext!.target).toEqual({ nodeId: 'g-dst', portId: 'IN--FLT' });
});
