// e2e/tests/grouping-phase3.spec.ts
//
// Module-grouping Phase 3 — SCOPE pass-through render in GroupCard (3B).
// The Y.Awareness soft-lock (3C) is a multi-user-only feature and lives
// in collab.spec.ts (@collab tag).

import { test, expect, type Page } from '@playwright/test';
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

async function setupScopeGroup(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [
      { id: 'lfo-1', type: 'lfo',      position: { x: 100, y: 100 }, domain: 'audio' },
      { id: 'sco-1', type: 'scope',    position: { x: 400, y: 100 }, domain: 'audio' },
      { id: 'out-1', type: 'audioOut', position: { x: 800, y: 100 }, domain: 'audio' },
    ],
    [
      { id: 'e-lfo-sco', from: { nodeId: 'lfo-1', portId: 'phase0' }, to: { nodeId: 'sco-1', portId: 'ch1' }, sourceType: 'cv',    targetType: 'audio' },
      { id: 'e-sco-out', from: { nodeId: 'sco-1', portId: 'ch1_out' }, to: { nodeId: 'out-1', portId: 'L' },  sourceType: 'audio', targetType: 'audio' },
    ],
  );

  // Drive the create-group commit, packaging the LFO + SCOPE into a
  // single group with the scope's audio output exposed.
  await page.evaluate(() => {
    const w = window as unknown as {
      __patch: { nodes: Record<string, PatchNode>; edges: Record<string, PatchEdge> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    const groupId = 'g-scope-1';
    const exposedId = 'out--sco-1--ch1_out';
    w.__ydoc.transact(() => {
      w.__patch.nodes[groupId] = {
        id: groupId,
        type: 'group',
        domain: 'meta',
        position: { x: 250, y: 100 },
        params: {},
        data: {
          childIds: ['lfo-1', 'sco-1'],
          exposedPorts: [
            { id: exposedId, childId: 'sco-1', childPortId: 'ch1_out', direction: 'output', cableType: 'audio' },
          ],
          label: 'scope group',
        },
      } as PatchNode;
      for (const cid of ['lfo-1', 'sco-1']) {
        const n = w.__patch.nodes[cid];
        if (n) {
          if (!n.data) n.data = {};
          (n.data as { parentGroupId?: string }).parentGroupId = groupId;
        }
      }
      const e = w.__patch.edges['e-sco-out'];
      if (e) e.source = { nodeId: groupId, portId: exposedId };
    });
  });
}

test('Phase 3B: SCOPE inside a group portals its canvas into the GroupCard body', async ({ page }) => {
  await setupScopeGroup(page);

  // The group renders, the children are hidden.
  await expect(page.locator('[data-testid="group-card"][data-node-id="g-scope-1"]')).toBeVisible();
  await expect(page.locator('.svelte-flow__node[data-id="sco-1"]')).toHaveCount(0);
  await expect(page.locator('.svelte-flow__node[data-id="lfo-1"]')).toHaveCount(0);

  // The group card knows it's in viz pass-through mode (data-viz="true").
  await expect(page.locator('[data-testid="group-card"][data-node-id="g-scope-1"]')).toHaveAttribute(
    'data-viz',
    'true',
  );

  // The viz body + at least one viz-slot is rendered.
  const vizBody = page.locator(
    '[data-testid="group-card"][data-node-id="g-scope-1"] [data-testid="group-viz-body"]',
  );
  await expect(vizBody).toBeVisible();

  // The portaled canvas has data-viz-passthrough + lives INSIDE the
  // group card's body (proves the appendChild move happened — the
  // hidden mount's wrapper is display:none + visibility:hidden, so a
  // visible canvas inside the group body comes only from the portal).
  const portaledCanvas = vizBody.locator('canvas[data-viz-passthrough]');
  await expect(portaledCanvas).toHaveCount(1);
  // The canvas keeps its rAF draw loop alive: width/height stays at the
  // ScopeCard's declared bitmap size (320×300 — the bigger 3u screen, see
  // ScopeCard.svelte). We can't easily diff pixels here, but we can assert the
  // canvas attribute survives the move + the element is visible.
  await expect(portaledCanvas).toHaveAttribute('width', '320');
  await expect(portaledCanvas).toHaveAttribute('height', '300');
  await expect(portaledCanvas).toBeVisible();
});

test('Phase 3B: expand mode short-circuits viz pass-through; children render in place', async ({ page }) => {
  await setupScopeGroup(page);

  // Expand the group — the viz portal should clear; children re-appear.
  await page.evaluate(() => {
    const w = window as unknown as {
      __patch: { nodes: Record<string, PatchNode> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const g = w.__patch.nodes['g-scope-1'];
      if (g) {
        if (!g.data) g.data = {};
        (g.data as { expanded?: boolean }).expanded = true;
      }
    });
  });
  await expect(page.locator('[data-testid="group-card"][data-node-id="g-scope-1"]')).toHaveAttribute(
    'data-expanded',
    'true',
  );
  await expect(page.locator('[data-testid="group-card"][data-node-id="g-scope-1"]')).toHaveAttribute(
    'data-viz',
    'false',
  );
  // The full SCOPE card now renders inline.
  await expect(page.locator('.svelte-flow__node[data-id="sco-1"]')).toBeVisible();
});
