// e2e/tests/clipplayer-clip-delete.spec.ts
//
// RIGHT-CLICK → DELETE CLIP on the launch grid (owner ask; card-only, no
// Launchpad/Push binding). The three cases that decide whether the affordance
// is safe, not just present:
//
//  * PLAYING clip — deleting the clip a lane is currently playing must not
//    strand the lane on a slot whose clip no longer exists (a lit pad driving
//    nothing). Delete stops the lane FIRST, through the same immediate-stop
//    seam the ■ STOP-ALL uses, so the engine clears `playing[lane]` via its
//    single owner instead of the card writing it behind the engine's back.
//  * UNDO — the reason there is no confirm dialog. The card's ↶ (control-strip
//    6 / computer key 6) must bring the clip back WITH ITS NOTES. (The seam
//    itself is pinned in clip-undo.test.ts; this proves the CARD is wired to
//    it.)
//  * EMPTY cell — Delete must be ABSENT, not a no-op that looks broken. The
//    menu refuses to open at all on a pad with no clip, so there is nothing to
//    click; the pad's own tooltip drops the right-click clause to match.

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

const NOTE = { step: 3, midi: 64, vel: 100 };

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

async function spawn(page: Page) {
  await spawnPatch(page, [
    { id: 'tl', type: 'timelorde', position: { x: 40, y: 40 }, domain: 'audio' },
    { id: 'cp', type: 'clipplayer', position: { x: 420, y: 40 }, domain: 'audio' },
  ]);
  await expect(page.locator('[data-clip="0"]')).toBeVisible();
}

test('right-click a loaded pad → Delete clip removes it; ↶ brings it back with its notes', async ({
  page,
  rack,
}) => {
  await spawn(page);
  await seedClip(page, 0);
  const pad = page.locator('[data-clip="0"]');
  await expect(pad).toHaveAttribute('data-state', 'loaded');

  // The tooltip advertises the right-click menu only where the menu opens.
  await expect(pad).toHaveAttribute('title', /Right-click: clip probability .* \+ delete clip/);

  await pad.click({ button: 'right' });
  const menu = page.getByTestId('clipplayer-clip-prob-menu-cp');
  await expect(menu).toBeVisible();
  const del = page.getByTestId('clipplayer-clip-delete-cp');
  await expect(del).toBeVisible();
  await expect(del, 'Delete targets the RIGHT-CLICKED pad, not the selected editor clip').toHaveAttribute(
    'data-clip-idx',
    '0',
  );
  // The menu row must NOT also answer to `[data-clip="0"]` — that is the grid
  // PAD selector, and a second match would make every existing pad locator
  // ambiguous while the menu is open.
  await expect(page.locator('[data-clip="0"]'), 'exactly one [data-clip="0"] with the menu open').toHaveCount(1);

  await del.click();
  await expect(menu, 'picking Delete closes the menu').toHaveCount(0);
  await expect(pad).toHaveAttribute('data-state', 'empty');
  expect((await readData(page)).clips?.['0'], 'the clip record is gone').toBeUndefined();

  // UNDO (control-strip 6) — the reason Delete needs no confirm.
  await page.getByTestId('clipplayer-strip-6-cp').click();
  await expect(pad).toHaveAttribute('data-state', 'loaded');
  const restored = (await readData(page)).clips?.['0'] as { steps?: unknown[] } | undefined;
  expect(restored?.steps, 'undo restores the clip CONTENTS, not an empty shell').toEqual([NOTE]);
});

test('deleting a PLAYING clip stops its lane — no lane left pointing at a clip that is gone', async ({
  page,
  rack,
}) => {
  await spawn(page);
  await seedClip(page, 0); // lane 0, slot 0

  // Launch it for real through the pad (single click → the 220ms debounce →
  // launchPad), then wait for the ENGINE to report it playing.
  await page.locator('[data-clip="0"]').click();
  await expect(page.locator('[data-clip="0"]')).toHaveAttribute('data-state', 'playing', { timeout: 10_000 });
  expect((await readData(page)).playing?.[0], 'engine reports lane 0 playing slot 0').toBe(0);

  await page.locator('[data-clip="0"]').click({ button: 'right' });
  await page.getByTestId('clipplayer-clip-delete-cp').click();

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

test('an EMPTY pad offers no clip menu at all — Delete is absent, not a broken no-op', async ({
  page,
  rack,
}) => {
  await spawn(page);
  const pad = page.locator('[data-clip="1"]');
  await expect(pad).toHaveAttribute('data-state', 'empty');
  await expect(pad, 'the tooltip drops the right-click clause where there is no menu').toHaveAttribute(
    'title',
    'Click: launch/stop · Double-click: edit',
  );

  await pad.click({ button: 'right' });
  await expect(page.getByTestId('clipplayer-clip-prob-menu-cp')).toHaveCount(0);
  await expect(page.getByTestId('clipplayer-clip-delete-cp')).toHaveCount(0);
});
