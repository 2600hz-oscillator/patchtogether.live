// e2e/tests/connection-validate-edge.spec.ts
//
// Phase 4a (standards-refactor): enforce edge compatibility at the COMMIT
// point in Canvas.svelte's handleConnect, and reject invalid drags in the UI
// via SvelteFlow's isValidConnection prop — both using the now-merged FW3
// validator (graph/validate-edge.ts, PR #709).
//
// Before this change handleConnect resolved endpoints/types but wrote the
// edge WITHOUT a final canConnect / direction check, so an INCOMPATIBLE
// cable (e.g. an audio OUTPUT dropped onto a cv INPUT) could be dragged and
// committed. canConnect('audio','cv') === false, so that edge must never
// land in patch.edges.
//
// What we assert, driving the REAL production path (the dev-only
// window.__handleConnect hook — the exact xyflow `Connection` envelope a
// real pointer drag synthesizes):
//   1. INCOMPATIBLE: analogVco.saw (audio out) → filter.cutoff (cv in) is
//      REJECTED — handleConnect returns without writing an edge.
//   2. COMPATIBLE: analogVco.saw (audio out) → filter.audio (audio in) still
//      CONNECTS — normal patching is unaffected.
//   3. WRONG-DIRECTION: audioOut.L (an INPUT) used as a source is rejected
//      (direction check), proving the gate isn't only type-based.
//   4. The drag-time predicate (window.__isValidConnection, the same fn
//      wired to SvelteFlow's isValidConnection prop) returns false for the
//      incompatible pair and true for the compatible one — so SvelteFlow
//      visually rejects the drag BEFORE commit.

import { test, expect, type Page } from '@playwright/test';
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

/** Drive Canvas.handleConnect via the dev-only window hook — the same xyflow
 *  `Connection` envelope a real pointer drag would synthesize, so we exercise
 *  the real production commit path (no test-only branch). */
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

/** Call the drag-time gate (same fn wired to SvelteFlow's isValidConnection
 *  prop) so we can assert the visual drag-reject without a synthetic pointer
 *  drag. Returns the predicate's boolean verdict. */
async function isValidConnection(
  page: Page,
  src: { nodeId: string; handleId: string },
  dst: { nodeId: string; handleId: string },
): Promise<boolean> {
  return await page.evaluate(
    ({ src, dst }) => {
      const w = window as unknown as {
        __isValidConnection: (c: {
          source: string;
          target: string;
          sourceHandle: string;
          targetHandle: string;
        }) => boolean;
      };
      return w.__isValidConnection({
        source: src.nodeId,
        target: dst.nodeId,
        sourceHandle: src.handleId,
        targetHandle: dst.handleId,
      });
    },
    { src, dst },
  );
}

/** Boot + spawn an analogVco and a filter (no edges). analogVco.saw is an
 *  audio OUTPUT; filter has an `audio` INPUT (audio) and a `cutoff` INPUT
 *  (cv). audioOut gives us a port to exercise the direction check. */
async function setup(page: Page): Promise<void> {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [
      { id: 'vco-1', type: 'analogVco', position: { x: 100, y: 100 }, domain: 'audio' },
      { id: 'flt-1', type: 'filter',    position: { x: 500, y: 100 }, domain: 'audio' },
      { id: 'out-1', type: 'audioOut',  position: { x: 900, y: 100 }, domain: 'audio' },
    ],
    [],
  );
  // spawnPatch already waited for every node wrapper to mount
  // (.svelte-flow__node[data-id=...]) so __patch + __handleConnect are live.
  expect(await readEdges(page)).toHaveLength(0);
}

test('INCOMPATIBLE cable (audio out → cv in) is rejected at commit — no edge created', async ({ page }) => {
  await setup(page);

  // audio OUTPUT (vco saw) dropped onto a cv INPUT (filter cutoff).
  // canConnect('audio','cv') === false → handleConnect must bail.
  await driveConnect(
    page,
    { nodeId: 'vco-1', handleId: 'saw' },
    { nodeId: 'flt-1', handleId: 'cutoff' },
  );

  const edges = await readEdges(page);
  expect(
    edges.find((e) => e.target.nodeId === 'flt-1' && e.target.portId === 'cutoff'),
    'incompatible audio→cv cable must NOT be written to patch.edges',
  ).toBeUndefined();
  expect(edges).toHaveLength(0);

  // And the drag-time gate rejects it too (SvelteFlow visual reject).
  expect(
    await isValidConnection(page, { nodeId: 'vco-1', handleId: 'saw' }, { nodeId: 'flt-1', handleId: 'cutoff' }),
  ).toBe(false);
});

test('COMPATIBLE cable (audio out → audio in) still connects', async ({ page }) => {
  await setup(page);

  // audio OUTPUT (vco saw) → audio INPUT (filter audio). canConnect ok.
  await driveConnect(
    page,
    { nodeId: 'vco-1', handleId: 'saw' },
    { nodeId: 'flt-1', handleId: 'audio' },
  );

  const edges = await readEdges(page);
  const e = edges.find((x) => x.target.nodeId === 'flt-1' && x.target.portId === 'audio');
  expect(e, 'compatible audio→audio cable must be written to patch.edges').toBeDefined();
  expect(e!.source).toEqual({ nodeId: 'vco-1', portId: 'saw' });
  expect(e!.target).toEqual({ nodeId: 'flt-1', portId: 'audio' });

  // And the drag-time gate ACCEPTS it.
  expect(
    await isValidConnection(page, { nodeId: 'vco-1', handleId: 'saw' }, { nodeId: 'flt-1', handleId: 'audio' }),
  ).toBe(true);
});

test('WRONG-DIRECTION cable (input used as source) is rejected', async ({ page }) => {
  await setup(page);

  // audioOut.L is an INPUT, not an output. Using it as a connection source
  // must fail the validator's direction check — no edge written.
  await driveConnect(
    page,
    { nodeId: 'out-1', handleId: 'L' },
    { nodeId: 'flt-1', handleId: 'audio' },
  );

  expect(await readEdges(page)).toHaveLength(0);
  expect(
    await isValidConnection(page, { nodeId: 'out-1', handleId: 'L' }, { nodeId: 'flt-1', handleId: 'audio' }),
  ).toBe(false);
});
