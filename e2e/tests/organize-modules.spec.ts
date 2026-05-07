// e2e/tests/organize-modules.spec.ts
//
// Two related canvas UX features:
//
//   1. Right-click → "Add Module > X" should anchor the new node at the
//      flow-position of the click, not at a default coord. Validates
//      screenToFlowPosition wiring through the FlowBridge child component.
//
//   2. Right-click → "Organize modules" should declutter overlapping cards,
//      preserving overall layout while expanding the bbox as needed.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

test('add module anchors near right-click flow position', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  const pane = page.locator('.svelte-flow__pane');
  const box = await pane.boundingBox();
  if (!box) throw new Error('no pane');
  const clickClientX = box.x + 320;
  const clickClientY = box.y + 240;

  await page.mouse.click(clickClientX, clickClientY, { button: 'right' });
  await expect(page.locator('.module-palette')).toBeVisible();
  await page.getByRole('button', { name: 'Reverb', exact: true }).click();

  const reverb = page.locator('.svelte-flow__node-reverb');
  await expect(reverb).toHaveCount(1);

  const nodeBox = await reverb.boundingBox();
  if (!nodeBox) throw new Error('node not laid out');
  // The node's screen-space top-left should be within ~16px of the click
  // (xyflow snaps + a small offset is OK; the bug was a viewport-translation
  // offset of hundreds of px).
  expect(Math.abs(nodeBox.x - clickClientX)).toBeLessThan(16);
  expect(Math.abs(nodeBox.y - clickClientY)).toBeLessThan(16);
});

test('add module clicked on top of existing node offsets the new node', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [
    { id: 'a', type: 'mixer', position: { x: 200, y: 200 } },
  ]);
  await expect(page.locator('.svelte-flow__node-mixer')).toHaveCount(1);
  const a = page.locator('.svelte-flow__node-mixer').first();
  const aBox = await a.boundingBox();
  if (!aBox) throw new Error('mixer not laid out');
  // Right-click in the middle of the existing mixer card.
  const cx = aBox.x + aBox.width / 2;
  const cy = aBox.y + aBox.height / 2;
  await page.mouse.click(cx, cy, { button: 'right' });
  await expect(page.locator('.module-palette')).toBeVisible();
  await page.getByRole('button', { name: 'Reverb', exact: true }).click();

  await expect(page.locator('.svelte-flow__node-reverb')).toHaveCount(1);
  const reverb = page.locator('.svelte-flow__node-reverb').first();
  const rBox = await reverb.boundingBox();
  if (!rBox) throw new Error('reverb not laid out');
  // The new card should NOT be perfectly stacked on the mixer.
  const dx = Math.abs(rBox.x - aBox.x);
  const dy = Math.abs(rBox.y - aBox.y);
  expect(Math.max(dx, dy)).toBeGreaterThan(8);
});

test('Organize modules separates two stacked cards', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  // Two modules at the exact same position — fully stacked.
  await spawnPatch(page, [
    { id: 'a', type: 'mixer', position: { x: 200, y: 200 } },
    { id: 'b', type: 'reverb', position: { x: 200, y: 200 } },
  ]);
  await expect(page.locator('.svelte-flow__node')).toHaveCount(2);

  const aBefore = await page.locator('.svelte-flow__node-mixer').first().boundingBox();
  const bBefore = await page.locator('.svelte-flow__node-reverb').first().boundingBox();
  if (!aBefore || !bBefore) throw new Error('cards not laid out');
  // Sanity: they should be heavily overlapping before organize.
  const xOverlapBefore = Math.min(aBefore.x + aBefore.width, bBefore.x + bBefore.width)
    - Math.max(aBefore.x, bBefore.x);
  const yOverlapBefore = Math.min(aBefore.y + aBefore.height, bBefore.y + bBefore.height)
    - Math.max(aBefore.y, bBefore.y);
  expect(xOverlapBefore).toBeGreaterThan(0);
  expect(yOverlapBefore).toBeGreaterThan(0);

  // Right-click empty pane → Organize modules.
  const pane = page.locator('.svelte-flow__pane');
  const paneBox = await pane.boundingBox();
  if (!paneBox) throw new Error('no pane');
  await page.mouse.click(paneBox.x + 600, paneBox.y + 50, { button: 'right' });
  await expect(page.locator('.module-palette')).toBeVisible();
  await page.locator('[data-testid="palette-organize"]').click();
  await expect(page.locator('.module-palette')).not.toBeVisible();

  // Wait for the layout pass + Yjs update + re-render.
  await page.waitForTimeout(250);

  const aAfter = await page.locator('.svelte-flow__node-mixer').first().boundingBox();
  const bAfter = await page.locator('.svelte-flow__node-reverb').first().boundingBox();
  if (!aAfter || !bAfter) throw new Error('post-organize cards not laid out');
  const xOverlapAfter = Math.min(aAfter.x + aAfter.width, bAfter.x + bAfter.width)
    - Math.max(aAfter.x, bAfter.x);
  const yOverlapAfter = Math.min(aAfter.y + aAfter.height, bAfter.y + bAfter.height)
    - Math.max(aAfter.y, bAfter.y);
  // After organize, at least one axis must show no positive overlap.
  expect(Math.min(xOverlapAfter, yOverlapAfter)).toBeLessThanOrEqual(0);
});

test('Organize modules is a no-op on a single module', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [
    { id: 'only', type: 'mixer', position: { x: 200, y: 200 } },
  ]);
  await expect(page.locator('.svelte-flow__node')).toHaveCount(1);
  const before = await page.locator('.svelte-flow__node-mixer').first().boundingBox();
  if (!before) throw new Error('mixer not laid out');

  const pane = page.locator('.svelte-flow__pane');
  const paneBox = await pane.boundingBox();
  if (!paneBox) throw new Error('no pane');
  await page.mouse.click(paneBox.x + 700, paneBox.y + 60, { button: 'right' });
  await page.locator('[data-testid="palette-organize"]').click();
  await page.waitForTimeout(150);

  const after = await page.locator('.svelte-flow__node-mixer').first().boundingBox();
  if (!after) throw new Error('mixer not laid out post-organize');
  expect(Math.abs(after.x - before.x)).toBeLessThan(2);
  expect(Math.abs(after.y - before.y)).toBeLessThan(2);
});
