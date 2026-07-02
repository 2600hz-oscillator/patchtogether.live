// e2e/tests/saved-groups-wiring.spec.ts
//
// Wiring spec for the saved-groups library (PR #165 follow-up).
//
// The library has two user-facing entry points on the canvas:
//   1. NodeContextMenu → "Save group to library…" (testid `ctx-save-group`)
//      when right-clicking a group node — sign-in gated.
//   2. ModulePalette  → "Insert saved group…" (testid `palette-insert-saved-group`)
//      in the tools section — sign-in gated.
//
// Credentialed Clerk sign-in is out of scope here (see
// `auth-handshake.spec.ts` for the policy). What this spec locks in is:
//   • The base menu / palette still renders correctly with the new
//     prop names declared (regression-safe smoke).
//   • Both saved-groups entries are *absent* when running anonymously
//     (the only available e2e auth state today). This proves the
//     `canSaveGroup` / `oninsertsavedgroup` gating works; the testids
//     and Canvas wiring exist to flip them on once Clerk fixtures land.
//
// Test the components in their natural Canvas mount; no special hooks.

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

async function setupChain(page: Page): Promise<void> {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [
      { id: 'lfo-1', type: 'lfo',      position: { x: 100, y: 100 }, domain: 'audio' },
      { id: 'flt-1', type: 'filter',   position: { x: 400, y: 100 }, domain: 'audio' },
      { id: 'out-1', type: 'audioOut', position: { x: 800, y: 100 }, domain: 'audio' },
    ],
    [
      { id: 'e-flt-out', from: { nodeId: 'flt-1', portId: 'audio' }, to: { nodeId: 'out-1', portId: 'L' }, sourceType: 'audio', targetType: 'audio' },
    ],
  );
  await expect(page.locator('.svelte-flow__node[data-id="flt-1"]')).toBeVisible();
}

/** Create a group via direct Yjs write — same trick as grouping-phase2. */
async function createTestGroup(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __patch: { nodes: Record<string, PatchNode>; edges: Record<string, PatchEdge> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    const groupId = 'g-sg-1';
    w.__ydoc.transact(() => {
      w.__patch.nodes[groupId] = {
        id: groupId,
        type: 'group',
        domain: 'meta',
        position: { x: 250, y: 100 },
        params: {},
        data: {
          childIds: ['lfo-1', 'flt-1'],
          exposedPorts: [],
          label: 'sg-voice',
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
  });
  await expect(
    page.locator('[data-testid="group-card"][data-node-id="g-sg-1"]'),
  ).toBeVisible();
}

test('ModulePalette renders tools section without the saved-groups entry for anonymous users', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  const pane = page.locator('.svelte-flow__pane');
  const box = await pane.boundingBox();
  if (!box) throw new Error('no pane');
  await page.mouse.click(box.x + 200, box.y + 200, { button: 'right' });

  await expect(page.locator('.module-palette')).toBeVisible();
  // Regression guard: the base tools entries still render with the new
  // `oninsertsavedgroup` prop declared.
  await expect(page.locator('[data-testid="palette-create-group"]')).toBeVisible();
  // Sign-in-gated: Canvas does not pass `oninsertsavedgroup` for anon, so
  // the new entry is absent. Once Clerk fixtures land + Canvas flips the
  // prop on, this assertion can flip to `toBeVisible`.
  await expect(page.locator('[data-testid="palette-insert-saved-group"]')).toHaveCount(0);
});

test('NodeContextMenu on a group renders without the Save-to-library entry for anonymous users', async ({ page }) => {
  await setupChain(page);
  await createTestGroup(page);

  // Right-click the group card to open NodeContextMenu.
  const groupCard = page.locator('[data-testid="group-card"][data-node-id="g-sg-1"]');
  await groupCard.click({ button: 'right' });

  await expect(page.locator('[role="menu"][aria-label="Module actions"]')).toBeVisible();
  // Regression guard: existing group menu entries still render with the
  // new `onsavegroup` / `canSaveGroup` props declared.
  await expect(page.locator('[data-testid="ctx-duplicate-group"]')).toBeVisible();
  await expect(page.locator('[data-testid="ctx-ungroup"]')).toBeVisible();
  // Sign-in-gated: Canvas does not pass `canSaveGroup` / `onsavegroup`
  // for anon, so the new entry is absent. Once Clerk fixtures land, this
  // can flip to `toBeVisible`.
  await expect(page.locator('[data-testid="ctx-save-group"]')).toHaveCount(0);
});
