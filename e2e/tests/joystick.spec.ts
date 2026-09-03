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
// ⚠ joystick IS FACED NOW (2026-09-01, wave 3 of the face program) — the
// owner's two-ordinary-cells fallback: the lane tile and the dock bands paint
// `pos_x`/`pos_y` as two plain knob cells, and the real pad is the extension's
// `fullViewBody` at the head of the dock (`JoystickPadBody.svelte`). The
// FACE legs below are the promotion's behavioural evidence — an existing
// green `?shell=legacy` leg is NEVER evidence about a face — and they drive
// the same #1963 drag-and-release contract through the shipping surface.
//
// ⚠ `joystick-readout` BELOW IS THE LEGACY CARD'S OWN ROW, and it survives
// there deliberately: the resting-text ruling is about FACEPLATES — legacy
// cards print values and are untouched. On the FACE that readout is the
// promotion's named DELETION (owner-decisions item 11): the pad body paints
// no decimals, and the values live on its `aria-label` and on the knob
// cells' `aria-valuetext`.

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';
import { SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';

// ⚠ THE PER-TEST BUDGET IS A BOUND, and without this line it is the invisible
// 30 s Playwright default (#2291's class). The face legs boot the DEFAULT
// shell — WorkflowTopbar, dock rails, pinned singletons — which on a loaded
// CI runner exceeds 30 s before the first assertion. A bound only costs
// wall-clock when exceeded, so this adds zero to a green run.
test.describe.configure({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

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
  test('spawns + pad mounts + no console errors', async ({ page, rackLegacy, errorWatch }) => {
    await spawnPatch(page, [
      { id: 'j1', type: 'joystick', position: { x: 200, y: 100 }, domain: 'audio' },
    ]);

    await expect(page.locator('[data-testid="joystick-card"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="joystick-pad"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="joystick-dot"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="joystick-readout"]')).toHaveCount(1);
  });

  test('drag updates pos_x + pos_y, and RELEASE LEAVES THEM THERE', async ({ page, rackLegacy }) => {
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

  test('double-click re-centres — the gesture that REPLACED the snap-back', async ({ page, rackLegacy }) => {
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

// ── THE FACE — the promoted surface every user actually gets ────────────────
//
// The wait discipline here differs from the legacy legs above on purpose: the
// stored position is a PAGE-side quantity, so the wait runs IN the page,
// counted in FRAMES, and the assertion runs on the SAME sample the wait
// validated (a re-read after a validated frame is an invariant to the subject
// — the "sample twice, assert on the second" class). The legacy legs' older
// `expect.poll` shape is left as it was: bounds only, no behaviour change.

/** Wait, in-page and frame-counted, until the stored position satisfies the
 *  named predicate (or the frame cap runs out), and return THE SAMPLE that
 *  satisfied it, plus how long that took — so "never moved" fails as itself,
 *  with the evidence, rather than as an opaque timeout. */
async function waitStoredPos(
  page: import('@playwright/test').Page,
  nodeId: string,
  pred: 'both-past-0.3' | 'centred',
) {
  return page.evaluate(
    async ({ id, pred }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
      };
      const read = () => {
        const n = w.__patch.nodes[id];
        return { pos_x: n?.params.pos_x ?? 99, pos_y: n?.params.pos_y ?? 99 };
      };
      const ok = (p: { pos_x: number; pos_y: number }) =>
        pred === 'both-past-0.3'
          ? p.pos_x > 0.3 && p.pos_y > 0.3
          : Math.abs(p.pos_x) < 0.001 && Math.abs(p.pos_y) < 0.001;
      let frames = 0;
      let sample = read();
      while (!ok(sample) && frames < 300) {
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        frames++;
        sample = read();
      }
      return { ok: ok(sample), frames, ...sample };
    },
    { id: nodeId, pred },
  );
}

test.describe('JOYSTICK — the FACE (default shell)', () => {
  test('the lane tile is a ModuleShell painting BOTH axis cells — and NOT the pad', async ({
    page,
    rack,
    errorWatch,
  }) => {
    // `errorWatch` is this spec's pageerror guard: a derivation repaired on
    // ModuleShellPlaceholder can still throw in ModuleShell, and only
    // promoting reveals it — the guard fails the leg on any page error.
    await spawnPatch(page, [
      { id: 'j1', type: 'joystick', position: { x: 200, y: 100 }, domain: 'audio' },
    ]);

    const tile = page.locator('.svelte-flow__node[data-id="j1"]');
    await expect(
      tile.locator('[data-testid="module-shell"]'),
      'the promoted face renders a ModuleShell tile, not the placeholder',
    ).toBeVisible();
    await expect(tile.locator('[data-testid="module-shell-placeholder"]')).toHaveCount(0);

    // The two-ordinary-cells shape, at the tier the player is looking at:
    // rank 1 (X) paints at every tier, so it is the tier-independent claim.
    await expect(tile.locator('[data-testid="control-pos_x"]')).toBeVisible();

    // …and the PAD is dock-only: the tile-vs-dock split is the half of the
    // owner decision a zoom level cannot change (the ptzcam lesson — never
    // assert a specific tier's cell count from the default viewport).
    await expect(tile.locator('[data-testid="joystick-face-pad"]')).toHaveCount(0);
  });

  test('dock: the pad body drags BOTH axes, release LEAVES them, dblclick re-centres', async ({
    page,
    rack,
    errorWatch,
  }) => {
    await spawnPatch(page, [
      { id: 'j1', type: 'joystick', position: { x: 200, y: 100 }, domain: 'audio' },
    ]);

    const tile = page.locator('.svelte-flow__node[data-id="j1"] [data-testid="module-shell"]');
    await expect(tile).toBeVisible();
    await tile.getByTestId('shell-open-dock').click();
    const dock = page.getByTestId('dock-full-view');
    await expect(dock).toBeVisible();

    // The twotracks redundancy, pinned as INTENDED: the pad body above, and
    // the two parity-credited knob cells beneath — each anchor EXACTLY once,
    // because the pad emits none (a second `control-pos_x` here is the
    // multiset failure faces-parity would only catch a lane later).
    const body = dock.locator('[data-testid="joystick-face-body"]');
    await expect(body, 'the fullViewBody paints at the dock').toBeVisible();
    await expect(dock.locator('[data-testid="control-pos_x"]')).toHaveCount(1);
    await expect(dock.locator('[data-testid="control-pos_y"]')).toHaveCount(1);

    // ── drag toward the upper-right corner, through the BODY pad ──
    const pad = body.locator('[data-testid="joystick-face-pad"]');
    await expect(pad).toBeVisible();
    const box = await pad.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.85, box.y + box.height * 0.15, { steps: 6 });

    // Still holding: the commit is rAF-coalesced, so wait in FRAMES, in-page,
    // and assert on the sample the wait validated.
    const held = await waitStoredPos(page, 'j1', 'both-past-0.3');
    expect(
      held.ok,
      `both axes must pass +0.3 while dragging (waited ${held.frames} frames; ` +
        `got x=${held.pos_x} y=${held.pos_y}) — X right and Y UP, so a dead Y flip fails here`,
    ).toBe(true);

    // Release — and the position STAYS (#1963 "1 - persist"). The flush is
    // synchronous on pointerup, so one read suffices; equality with the HELD
    // sample is the strong form (a snap-back writes 0, a dead flush loses the
    // tail of the drag).
    await page.mouse.up();
    const released = await storedPos(page, 'j1');
    expect(released.pos_x, 'pos_x survives the release').toBeCloseTo(held.pos_x, 3);
    expect(released.pos_y, 'pos_y survives the release').toBeCloseTo(held.pos_y, 3);
    expect(Math.abs(released.pos_x), 'and it is not merely centred').toBeGreaterThan(0.3);

    // ── double-click re-centres — the gesture that replaced the snap-back ──
    await pad.dblclick();
    const centred = await waitStoredPos(page, 'j1', 'centred');
    expect(
      centred.ok,
      `dblclick must re-centre both axes (waited ${centred.frames} frames; ` +
        `got x=${centred.pos_x} y=${centred.pos_y})`,
    ).toBe(true);

    // ── the deleted readout stays deleted, and the value stays speakable ──
    // (the promotion's owner-decisions item 11 line, held in the DOM: no
    // decimal text node anywhere on the face; the pad's accessible name
    // carries the live value instead.)
    await expect(dock.locator('[data-testid="joystick-readout"]')).toHaveCount(0);
    await expect(pad).toHaveAttribute('aria-label', /joystick pad: X 0\.00, Y 0\.00/);
  });
});
