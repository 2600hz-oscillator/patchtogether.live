// e2e/tests/joystick.spec.ts
//
// JOYSTICK — the XY CV utility, on BOTH renderers.
//
// ⚠ THE SNAP-BACK LEG WAS INVERTED, NOT DELETED (owner ruling on #1963,
// verbatim "1 - persist"). It used to drag the pad, release, and assert both
// axes had returned to 0. Releasing now LEAVES THE STICK WHERE YOU DROPPED IT,
// so the same drag + release drives the opposite assertion — and that is the
// stronger test, because "the value went back to its default" is also what a
// broken write path produces, while "the value I dragged to is still there
// after release" can only be true if the write landed and stuck.
//
// ⚠ joystick is NOT faced — Q43 was built and HELD on the shared `xy` cell,
// which painted a resting decimal and put the value nowhere speakable. ⚠ THAT
// HOLD IS LIFTED (#2038): the pad's readout row is deleted and its values live
// in `aria-label`. Q43 is UNBLOCKED, not done — the promotion is still its own
// work, and until it lands this spec covers the LEGACY card, which is what both
// surfaces still render.
//
// ⚠ `joystick-readout` BELOW IS THE CARD'S OWN ROW, NOT THE SHARED PAD'S, and
// the distinction is why #2038 did not touch it. This card hand-rolls its pad
// (its own `role="application"` div, a STATIC aria-label, its own `.readout`)
// rather than mounting `XyPad`. The resting-text ruling is about FACEPLATES —
// legacy cards print values and are deliberately untouched — so removing this
// row would be scope the ruling does not ask for. It goes when the FACE lands
// and replaces the card, not before.

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';

/** The stored position, read off the patch store — the persisted value both
 *  surfaces write and the thing the ruling is about. */
async function storedPos(page: import('@playwright/test').Page, nodeId: string) {
  return page.evaluate((id) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params: Record<string, number> }> };
    };
    const n = w.__patch.nodes[id];
    return { pos_x: n?.params.pos_x ?? 99, pos_y: n?.params.pos_y ?? 99 };
  }, nodeId);
}

test.describe('JOYSTICK — XY CV utility (legacy card)', () => {
  test('spawns + pad mounts + no console errors', async ({ page, rack, errorWatch }) => {
    await spawnPatch(page, [
      { id: 'j1', type: 'joystick', position: { x: 200, y: 100 }, domain: 'audio' },
    ]);

    await expect(page.locator('[data-testid="joystick-card"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="joystick-pad"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="joystick-dot"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="joystick-readout"]')).toHaveCount(1);
  });

  test('drag updates pos_x + pos_y, and RELEASE LEAVES THEM THERE', async ({ page, rack }) => {
    await spawnPatch(page, [
      { id: 'j1', type: 'joystick', position: { x: 200, y: 100 }, domain: 'audio' },
    ]);

    const pad = page.locator('[data-testid="joystick-pad"]');
    await expect(pad).toHaveCount(1);
    const box = await pad.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;

    // Drag from centre toward the upper-right corner. Expect pos_x > 0.3 and
    // pos_y > 0.3 (positive y is "up").
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const tx = box.x + box.width * 0.85;
    const ty = box.y + box.height * 0.15;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(tx, ty, { steps: 6 });

    // Still holding. The write is rAF-coalesced now (createDragCommit), so poll
    // the real subject rather than racing a single frame.
    await expect
      .poll(async () => (await storedPos(page, 'j1')).pos_x, {
        message: 'pos_x positive while dragging right',
      })
      .toBeGreaterThan(0.3);
    const held = await storedPos(page, 'j1');
    expect(held.pos_y, 'pos_y positive after drag up (Y flipped)').toBeGreaterThan(0.3);

    // Release — and the position STAYS. #1963: "1 - persist".
    await page.mouse.up();
    const released = await storedPos(page, 'j1');
    expect(released.pos_x, 'pos_x survives the release').toBeCloseTo(held.pos_x, 3);
    expect(released.pos_y, 'pos_y survives the release').toBeCloseTo(held.pos_y, 3);

    // The negative control on the leg above: it must be a value the OLD
    // snap-back would have destroyed, i.e. genuinely off-centre. Without this
    // the assertion would also pass on a stick that never moved.
    expect(Math.abs(released.pos_x), 'and it is not merely centred').toBeGreaterThan(0.3);
  });

  test('double-click re-centres — the gesture that REPLACED the snap-back', async ({ page, rack }) => {
    await spawnPatch(page, [
      { id: 'j1', type: 'joystick', position: { x: 200, y: 100 }, domain: 'audio' },
    ]);

    const pad = page.locator('[data-testid="joystick-pad"]');
    const box = await pad.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;

    await page.mouse.move(box.x + box.width * 0.85, box.y + box.height * 0.15);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.85, box.y + box.height * 0.15, { steps: 2 });
    await page.mouse.up();
    await expect.poll(async () => Math.abs((await storedPos(page, 'j1')).pos_x)).toBeGreaterThan(0.3);

    await pad.dblclick();
    await expect
      .poll(async () => (await storedPos(page, 'j1')).pos_x, { message: 'pos_x re-centred' })
      .toBeCloseTo(0, 3);
    expect((await storedPos(page, 'j1')).pos_y, 'pos_y re-centred').toBeCloseTo(0, 3);
  });
});
