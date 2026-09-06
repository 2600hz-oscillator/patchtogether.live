// e2e/tests/face-mappy.spec.ts
//
// THE MAPPY FACE, driven for real on the DEFAULT shell — the seams no other
// gate can see.
//
// ⚠ THE FILENAME AND ITS LANE. `e2e/webgl-heavy-globs.ts` classifies by PREFIX,
// and a spec swept into the heavy lane runs NOWHERE in PR CI (that lane was
// deleted in #839; the attest job skips it whenever the hash is unchanged) —
// green forever. Checked against the live glob list rather than assumed:
// `mappy-*` matches NO heavy glob today, so BOTH `mappy-face.spec.ts` and this
// name land in the sharded `e2e` matrix. `face-mappy.spec.ts` is chosen for
// consistency with `face-videobox.spec.ts` and because a `face-*` prefix cannot
// collide with a future module-named glob. Nothing here is WebGL-heavy: it
// reads DOM facts and graph state and samples no pixels.
//
// `mappy-face-model.test.ts` pins the ranking, the two curve corrections, the
// roster, the override registry and every source-level claim.
// `mappy-edit-ydoc.test.ts` drives the edit seam against a real Y.Doc.
// `face-rack-status-source.test.ts` proves the body declares what it paints,
// `video-face-screen-source.test.ts` that it OWNS a screen switch, and the
// shared `face-screen-render-*` suite drives that switch. None of them can see:
//
//  1. ⚠ THAT THE MODULE CAN BE AIMED AT ALL UNDER THE SHELL. Promotion stops
//     both default surfaces rendering `MappyCard`, and the corner pin — the
//     module's entire reason to exist — was card-only. This file asserts the
//     card is absent AND that a drag in the DOCK BODY moves the persisted quad.
//  2. ⚠ THE INERT-CONTROL TRAP, from the outside. The factory used to prefer a
//     `node.data` mirror over the param for both ranked controls while every
//     shell cell writes the param alone, so on any node a card had touched the
//     faceplate was dead with every def-reading gate green. The legs below
//     drive the SHELL'S OWN CELLS on a node SEEDED WITH THAT STALE MIRROR.
//  3. ⚠ THAT THE SURFACES CELL MAKES THE CARD'S WRITE, not merely the card's
//     NUMBER. A bare param write leaves every added surface at the full-frame
//     UNIT_QUAD stacked on the one below it: the composite is pixel-identical,
//     the handles land on top of each other, and the control looks dead.
//  4. ⚠ THAT THE THIRD SURFACE AGREES. The MAP editor reads the GRID override
//     too, and a repair that landed only on the body would print "GRID OFF"
//     over a screen full of grid with its first press a no-op.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { BOOT_MS, SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';

/** One surface's persisted quad, read off the live graph. */
type Corners = [number, number][];

async function boot(page: Page): Promise<void> {
  // Plain /rack — the shipping shell, which is the whole subject of this file.
  await page.goto('/rack?seed=none');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: BOOT_MS });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

/** Open this node's dock faceplate (the auto-retrying tv-librarian pattern —
 *  the tile button is hit-testable while a previous pane is still tearing
 *  down, so one click can land on nothing). */
async function openDock(page: Page, nodeId: string) {
  const shell = page.locator(`.svelte-flow__node[data-id="${nodeId}"] [data-testid="module-shell"]`);
  await expect(shell).toBeVisible({ timeout: BOOT_MS });
  const dockShell = page
    .getByTestId('dock-full-view')
    .locator(`[data-testid="module-shell"][data-shell-tier="dock"][data-shell-node="${nodeId}"]`);
  await expect(async () => {
    if (await dockShell.count() === 0) {
      await shell.getByTestId('shell-open-dock').click();
    }
    await expect(dockShell).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
  return dockShell;
}

/** The persisted state the ENGINE reads, in one page round-trip. */
async function nodeState(page: Page, nodeId: string) {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params?: Record<string, number>; data?: Record<string, unknown> }> };
    };
    const n = w.__patch.nodes[id];
    const surfaces = (n?.data?.surfaces ?? []) as { corners: [number, number][] }[];
    return {
      showGrid: n?.params?.showGrid,
      surfaceCount: n?.params?.surfaceCount,
      // Copied out of the Y proxies so the assertion compares values.
      corners: surfaces.map((s) => (s?.corners ?? []).map((c) => [c[0], c[1]] as [number, number])),
      // The dead mirror, if a rack still carries one.
      dataShowGrid: n?.data?.showGrid,
      dataSurfaceCount: n?.data?.surfaceCount,
    };
  }, nodeId);
}

/** Seed the STALE `node.data` mirror an old rack (or a collaborator on an
 *  older build) leaves behind, and set it to the OPPOSITE of the param — the
 *  arrangement in which the pre-fix factory ignored the faceplate entirely. */
async function seedStaleMirror(page: Page, nodeId: string): Promise<void> {
  await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
    };
    const n = w.__patch.nodes[id];
    if (!n) throw new Error(`no node ${id}`);
    if (!n.data) n.data = {};
    n.data.showGrid = true;
    n.data.surfaceCount = 6;
  }, nodeId);
}

const CELL = (key: string) => `[data-cell-key="${key}"]`;

test.describe('MAPPY face — the promotion is what makes it aimable', () => {
  // ⚠ A PAGE ERROR FAILS EVERY TEST IN THIS FILE. A TypeError inside a
  // `$derived` does not surface as a thrown assertion — it takes the subtree's
  // render down and the symptom lands somewhere else entirely (a shared
  // derivation repaired on the placeholder can still throw in ModuleShell, and
  // only promoting reveals it).
  test.beforeEach(({ page }) => {
    page.on('pageerror', (err) => {
      throw new Error(`uncaught page error during a mappy face test: ${err.message}`);
    });
  });

  test('the shell replaces the card, and a CORNER PIN still commits from the face', async ({ page }) => {
    // Serialises the dock's lazy body chunk behind the boot — bounded from the
    // one export site, never a flat literal.
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 2);
    await boot(page);
    await spawnPatch(page, [{ id: 'fm1', type: 'mappy', domain: 'video' }], [], {
      mountTimeout: BOOT_MS,
    });

    // ⚠ THE PRECONDITION THIS FILE RESTS ON: on the default shell no mappy card
    // is mounted anywhere. If this ever finds one, nothing below proves
    // anything about the face.
    await expect(page.locator('[data-testid="mappy-card"]')).toHaveCount(0);

    const dock = await openDock(page, 'fm1');
    const body = dock.locator('[data-testid="mappy-map-body"]');
    await expect(body).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

    // Nothing patched: the empty-state hint names this surface's own condition,
    // and surface 1 is live and focused with its four handles on the frame.
    await expect(body.locator('[data-testid="mappy-face-empty-hint"]')).toBeVisible();
    await expect(body.locator('[data-testid="mappy-face-canvas"]')).toBeVisible();
    await expect(body.locator('[data-testid="mappy-face-legend-1"]')).toBeVisible();
    for (let ci = 0; ci < 4; ci++) {
      await expect(body.locator(`[data-testid="mappy-face-handle-1-${ci}"]`)).toBeVisible();
    }

    // ── ⚠ THE LOAD-BEARING LEG: DRAG A CORNER IN THE DOCK BODY ──────────────
    // The persisted quad must MOVE. This is the module's entire purpose and it
    // was card-only before the promotion.
    // ⚠ A FRESH NODE HAS NO `node.data.surfaces` AT ALL — `ensureSurfaces`
    // seeds the canonical six on the FIRST edit, and every reader fills the
    // full-frame default from `normalizeSurfaces(undefined)` until then. So the
    // pre-state is "absent, or already the unit quad", and asserting a seeded
    // array here would be asserting a fact about the fixture rather than about
    // the drag.
    const before = await nodeState(page, 'fm1');
    expect(before.corners[0] ?? [[0, 0], [1, 0], [1, 1], [0, 1]])
      .toEqual([[0, 0], [1, 0], [1, 1], [0, 1]]);

    // ⚠ THE GRAB POINT IS COMPUTED FROM THE OVERLAY, NOT FROM THE HANDLE'S
    // BOUNDING BOX. Corner 2 is BR in uv (1,1), which the y-UP mapping paints
    // at the frame's TOP-RIGHT — so its 8 px circle is HALF OUTSIDE the frame,
    // which `overflow: hidden` clips. The visual centre of that box is a point
    // `elementFromPoint` does not resolve to the overlay, so a press there
    // reaches nothing and the drag is a silent no-op. Pressing a few pixels
    // INSIDE the frame lands on the SVG (which owns all hit-testing, the shapes
    // being `pointer-events: none` by design) and is still well inside the
    // grab radius.
    const overlay = body.locator('[data-testid="mappy-face-overlay"]');
    const ob = await overlay.boundingBox();
    expect(ob, 'the overlay must be laid out').not.toBeNull();
    const INSET = 4;
    await page.mouse.move(ob!.x + ob!.width - INSET, ob!.y + INSET);
    await page.mouse.down();
    // A long way inward in both axes — far beyond any rounding or grab slop.
    await page.mouse.move(ob!.x + ob!.width * 0.6, ob!.y + ob!.height * 0.35, { steps: 8 });
    await page.mouse.up();

    await expect
      .poll(async () => (await nodeState(page, 'fm1')).corners[0]?.[2]?.[0] ?? 1, {
        message:
          'dragging the BR corner handle in the DOCK BODY must commit into '
          + 'node.data.surfaces[0].corners[2] — the corner pin is the module, and it was '
          + 'card-only before this promotion',
        timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
      })
      .toBeLessThan(0.95);

    const after = await nodeState(page, 'fm1');
    expect(
      after.corners[0]![2],
      `BR corner after the drag: ${JSON.stringify(after.corners[0]![2])} — it must have left `
        + 'the unit quad corner [1,1]',
    ).not.toEqual([1, 1]);
    // The OTHER three corners are untouched: this is a corner PIN, not a move.
    expect(after.corners[0]![0]).toEqual([0, 0]);
    expect(after.corners[0]![1]).toEqual([1, 0]);
    expect(after.corners[0]![3]).toEqual([0, 1]);
  });

  test('the ranked SURFACES cell makes the CARD’S WRITE, over a stale node.data mirror', async ({ page }) => {
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 2);
    await boot(page);
    await spawnPatch(page, [{ id: 'fm2', type: 'mappy', domain: 'video' }], [], {
      mountTimeout: BOOT_MS,
    });
    // ⚠ THE POSITIVE CONTROL FOR THE INERT-CONTROL TRAP. Before the fix the
    // factory preferred these two keys over the params, so a node carrying them
    // ignored every faceplate write. Seed them, then drive the shell's own cell.
    await seedStaleMirror(page, 'fm2');

    const dock = await openDock(page, 'fm2');
    await expect(dock.locator('[data-testid="mappy-map-body"]')).toBeVisible({
      timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
    });

    // The dock paints `surfaceCount` as a six-state row (the honest replacement
    // for the card's −/+ stepper), and the roster is what keeps the count
    // READABLE — the card printed it between its buttons.
    const cell = dock.locator(CELL('surfaceCount'));
    await expect(cell).toHaveAttribute('data-cell-control', 'segmented');
    const group = cell.locator('[data-testid="control-surfaceCount"]');
    await expect(group).toBeVisible();
    await group.getByRole('radio', { name: '3', exact: true }).click();

    await expect
      .poll(async () => (await nodeState(page, 'fm2')).surfaceCount, {
        message:
          'the faceplate SURFACES cell must reach the param even on a node carrying the stale '
          + 'node.data.surfaceCount mirror an older rack left behind',
        timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
      })
      .toBe(3);

    // ⚠ AND THE WRITE SHAPE, WHICH IS THE HALF A PARAM ASSERTION CANNOT SEE.
    // Each newly-live surface must drop in as a staggered INSET quad. A bare
    // `setNodeParam` leaves them at the full-frame default, stacked exactly on
    // surface 1 — the composite would be pixel-identical and the handles would
    // land on top of each other, i.e. a control that looks dead while its value
    // is perfectly correct.
    const st = await nodeState(page, 'fm2');
    for (const idx of [1, 2]) {
      expect(
        st.corners[idx],
        `surface ${idx + 1} must drop in as a staggered inset quad, not a full-frame duplicate`,
      ).not.toEqual([[0, 0], [1, 0], [1, 1], [0, 1]]);
    }
    // …and each newly-live surface is now editable on the picture.
    const body = dock.locator('[data-testid="mappy-map-body"]');
    await expect(body.locator('[data-testid="mappy-face-legend-3"]')).toBeVisible();
    await expect(body.locator('[data-testid="mappy-face-handle-3-0"]')).toBeVisible();
  });

  test('the ranked EXPORT cell downloads the map and reports itself IN THE BODY', async ({ page }) => {
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 2);
    await boot(page);
    await spawnPatch(page, [{ id: 'fm4', type: 'mappy', domain: 'video' }], [], {
      mountTimeout: BOOT_MS,
    });
    const dock = await openDock(page, 'fm4');
    const body = dock.locator('[data-testid="mappy-map-body"]');
    await expect(body).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

    // ⚠ THE OUTCOME CROSSES SURFACES, AND NOTHING ELSE CAN SEE THAT IT DOES.
    // ModuleShell paints a status/error line under a `file` cell and NOTHING
    // under an `action` cell, so a ranked EXPORT has nowhere of its own to say
    // what it did — and "the download failed" and "the button is dead" are the
    // same picture without it. The body owns the line; the cell fires the
    // action; `mappy-map-outcome.svelte` is the only thing joining them.
    await expect(body.locator('[data-testid="mappy-face-map-status"]')).toHaveCount(0);

    const cell = dock.locator(CELL('mappy-export-map-{n}'));
    await expect(cell).toHaveAttribute('data-cell-control', 'action');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      cell.locator('button').first().click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^mappy-map-\d+\.json$/);

    const status = body.locator('[data-testid="mappy-face-map-status"]');
    await expect(status).toHaveAttribute('data-status-kind', 'ok', {
      timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
    });
    // A fresh mappy is one live full-frame surface, and the line says so — the
    // export is honest on a bare rack rather than failing for want of a subject.
    await expect(status).toHaveText('exported 1 surface');
  });

  test('the ranked GRID toggle reaches the param, and the MAP EDITOR agrees', async ({ page }) => {
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 2);
    await boot(page);
    await spawnPatch(page, [{ id: 'fm3', type: 'mappy', domain: 'video' }], [], {
      mountTimeout: BOOT_MS,
    });
    await seedStaleMirror(page, 'fm3');

    const dock = await openDock(page, 'fm3');
    const body = dock.locator('[data-testid="mappy-map-body"]');
    await expect(body).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

    // ⚠ A TOGGLE, NOT A DIAL — the curve correction, observed at the render.
    // While `showGrid` said `curve: 'linear'` this cell was a KnobConic: a
    // ~200 px drag to flip a two-state override, and no gate said so.
    const cell = dock.locator(CELL('showGrid'));
    await expect(cell).toHaveAttribute('data-cell-control', 'toggle');
    const sw = cell.locator('[data-testid="control-showGrid"]');
    await expect(sw).toHaveAttribute('role', 'switch');
    await expect(sw).toHaveAttribute('aria-checked', 'false');

    await sw.click();
    await expect
      .poll(async () => (await nodeState(page, 'fm3')).showGrid, {
        message:
          'the faceplate GRID toggle must reach the param even on a node carrying the stale '
          + 'node.data.showGrid mirror the factory used to prefer',
        timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
      })
      .toBe(1);

    // ── ⚠ THE THIRD SURFACE AGREES ─────────────────────────────────────────
    // The MAP editor reads the override too. Repairing only the surface in
    // front of you leaves the editor reading the old source: it would print
    // "GRID OFF" over a screen full of grid, and its first press would be a
    // no-op that appeared to do nothing.
    await body.locator('[data-testid="mappy-face-open-editor"]').click();
    const editor = page.getByTestId('mappy-editor');
    await expect(editor).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
    await expect(editor.locator('[data-testid="mappy-editor-grid"]')).toHaveText('GRID ON');

    // and back the other way, from the editor's own button
    await editor.locator('[data-testid="mappy-editor-grid"]').click();
    await expect(editor.locator('[data-testid="mappy-editor-grid"]')).toHaveText('GRID OFF');
    await editor.locator('[data-testid="mappy-editor-close"]').click();
    await expect(editor).toHaveCount(0);
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    expect((await nodeState(page, 'fm3')).showGrid).toBe(0);
  });
});
