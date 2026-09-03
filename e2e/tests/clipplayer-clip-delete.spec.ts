// e2e/tests/clipplayer-clip-delete.spec.ts
//
// DELETING A CLIP FROM THE LAUNCH GRID — the one case that is about the ENGINE
// rather than the menu: a PLAYING clip must not be deleted out from under the
// lane that is playing it. Leaving `playing[lane]` (or a pending `queued[lane]`)
// pointing at a slot whose clip no longer exists strands the lane on a dangling
// index — the pad reads lit while nothing sounds. Delete stops the lane FIRST,
// through the same immediate-stop seam ■ STOP-ALL uses, so the engine clears
// `playing[lane]` via its single owner instead of the card writing it behind the
// engine's back.
//
// ⚠ The menu row itself (it is `clear`, it targets the RIGHT-CLICKED pad, it
// removes the whole clip RECORD, ↶ restores it, and an empty pad offers it
// DISABLED) is asserted in clipplayer-right-click-menu.spec.ts, which owns the
// menu on both surfaces. This file deliberately keeps only the engine invariant
// so the two do not pay for the same coverage twice.

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

type Page = import('@playwright/test').Page;
type ClipData = {
  clips?: Record<string, unknown>;
  auto?: Record<string, unknown>;
  playing?: (number | null)[];
  queued?: (number | 'stop' | null)[];
};
type W = { __patch: { nodes: Record<string, { data?: ClipData }> } };

/** Seed a real clip at flat index `idx`. Mutates node.data IN PLACE —
 *  syncedStore rejects reassigning an object already in the tree. */
async function seedClip(page: Page, idx: number) {
  await page.evaluate((i) => {
    const d = ((globalThis as unknown as W).__patch.nodes['cp'].data ?? {}) as {
      clips?: Record<string, unknown>;
    };
    if (!d.clips) d.clips = {};
    d.clips[String(i)] = { kind: 'note', lengthSteps: 16, root: 60, steps: [{ step: 3, midi: 64, vel: 100 }] };
  }, idx);
}

async function readData(page: Page): Promise<ClipData> {
  return page.evaluate(
    () => JSON.parse(JSON.stringify((globalThis as unknown as W).__patch.nodes['cp'].data ?? {})) as ClipData,
  );
}

test('deleting a PLAYING clip stops its lane — no lane left pointing at a clip that is gone', async ({
  page,
  rackLegacy,
}) => {
  await spawnPatch(page, [
    { id: 'tl', type: 'timelorde', position: { x: 40, y: 40 }, domain: 'audio' },
    { id: 'cp', type: 'clipplayer', position: { x: 420, y: 40 }, domain: 'audio' },
  ]);
  await expect(page.locator('[data-clip="0"]')).toBeVisible();
  await seedClip(page, 0); // lane 0, slot 0

  // Launch it for real through the pad (single click → the 220ms debounce →
  // launchPad), then wait for the ENGINE to report it playing.
  await page.locator('[data-clip="0"]').click();
  await expect(page.locator('[data-clip="0"]')).toHaveAttribute('data-state', 'playing', { timeout: 10_000 });
  expect((await readData(page)).playing?.[0], 'engine reports lane 0 playing slot 0').toBe(0);

  await page.locator('[data-clip="0"]').click({ button: 'right' });
  await page.getByTestId('clipplayer-menu-clear-cp').click();

  expect((await readData(page)).clips?.['0']).toBeUndefined();
  // THE INVARIANT: lane 0 must not still be pointing at slot 0.
  await expect
    .poll(async () => (await readData(page)).playing?.[0] ?? null, {
      message: 'lane 0 must not stay parked on the deleted slot (a lit pad driving nothing)',
      timeout: 10_000,
    })
    .not.toBe(0);
  await expect(page.locator('[data-clip="0"]')).toHaveAttribute('data-state', 'empty');
});
