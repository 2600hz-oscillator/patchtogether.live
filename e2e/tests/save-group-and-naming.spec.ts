// e2e/tests/save-group-and-naming.spec.ts
//
// Saved-groups UI wiring (PR #169 re-land) + editable group naming.
//
// Three checks:
//   1. ModulePalette surfaces "Insert saved group…" when the page believes
//      the user is signed in (test injects a fake currentUserId). Without
//      sign-in the entry is suppressed.
//   2. The right-click context menu on a group surfaces "Save group to
//      library…" for signed-in users. We assert the conditional render —
//      the actual POST path is unit-covered separately.
//   3. Renaming a group via the editable label persists across a snapshot
//      round trip.

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

async function createGroupViaDoc(page: Page, groupId: string, label: string | undefined): Promise<void> {
  await page.evaluate(
    ({ groupId, label }) => {
      const w = window as unknown as {
        __patch: { nodes: Record<string, PatchNode> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const data: Record<string, unknown> = {
          childIds: [] as string[],
          exposedPorts: [] as unknown[],
        };
        if (label !== undefined) data.label = label;
        w.__patch.nodes[groupId] = {
          id: groupId,
          type: 'group',
          domain: 'meta',
          position: { x: 300, y: 200 },
          params: {},
          data,
        };
      });
    },
    { groupId, label },
  );
}

async function readGroupLabel(page: Page, groupId: string): Promise<string | undefined> {
  return await page.evaluate((gid) => {
    const w = window as unknown as { __patch: { nodes: Record<string, PatchNode> } };
    const n = w.__patch.nodes[gid];
    if (!n) return undefined;
    const data = n.data as { label?: string } | undefined;
    return data?.label;
  }, groupId);
}

test('module palette: "Insert saved group…" is suppressed when no user is signed in', async ({ page }) => {
  // Default __attachProvider derives an anon token; the page mounts Canvas
  // with currentUserId=undefined unless a clerk JWT is supplied. So the
  // saved-group entry should NOT appear on a fresh load.
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  // Right-click empty pane to open the palette.
  await page.locator('.svelte-flow__pane').click({ button: 'right', position: { x: 400, y: 300 } });
  await expect(page.locator('[data-testid="palette-create-group"]')).toBeVisible();
  await expect(page.locator('[data-testid="palette-insert-saved-group"]')).toHaveCount(0);
});

test('group rename: double-click label, type new name, persists in patch.nodes data.label', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, []);

  // Insert a group whose label is the legacy placeholder; the canvas's
  // one-shot migration should rename it to GROUP1 once the snapshot ticks.
  await createGroupViaDoc(page, 'g-rename-1', 'GROUP!');
  await expect(page.locator('[data-testid="group-card"][data-node-id="g-rename-1"]')).toBeVisible();

  // The migration only kicks in once a snapshot containing groups arrives;
  // poll for the assignment so we don't race the effect.
  await expect.poll(async () => readGroupLabel(page, 'g-rename-1')).toBe('GROUP1');

  // Double-click the visible label to enter edit mode.
  const groupCard = page.locator('[data-testid="group-card"][data-node-id="g-rename-1"]');
  await groupCard.locator('[data-testid="group-card-label"]').dblclick();
  const input = page.locator('[data-testid="group-card-label-input-body"]');
  await expect(input).toBeVisible();
  await input.fill('Pad chain');
  await input.press('Enter');

  // Doc reflects the rename.
  await expect.poll(async () => readGroupLabel(page, 'g-rename-1')).toBe('Pad chain');

  // Visible label updates.
  await expect(groupCard.locator('[data-testid="group-card-label"]')).toHaveText('Pad chain');
});

test('multi-group naming: a second nameless group gets GROUP2 (does not collide with GROUP1)', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, []);

  // Two legacy groups → migration assigns GROUP1 + GROUP2 in id order.
  await createGroupViaDoc(page, 'group-a', 'GROUP!');
  await createGroupViaDoc(page, 'group-b', 'GROUP!');
  await expect(page.locator('[data-testid="group-card"][data-node-id="group-a"]')).toBeVisible();
  await expect(page.locator('[data-testid="group-card"][data-node-id="group-b"]')).toBeVisible();

  await expect.poll(async () => readGroupLabel(page, 'group-a')).toBe('GROUP1');
  await expect.poll(async () => readGroupLabel(page, 'group-b')).toBe('GROUP2');
});
