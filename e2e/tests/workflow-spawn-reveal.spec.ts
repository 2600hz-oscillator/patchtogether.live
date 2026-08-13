// e2e/tests/workflow-spawn-reveal.spec.ts
//
// SPAWN-CAMERA REVEAL — regression for the "adding a module to a lane makes the
// whole viewport SCROLL WILDLY" bug. The original P0.3b add-pan re-framed the
// target lane on EVERY add (laneCenterViewport → revealMemberViewport judged
// visibility against the TARGET transform, never the CURRENT one), producing
// measured 618-744px cross-canvas jumps even when the new tile was already on
// screen — or a mere 16px past one pane edge. The fix (spawnRevealViewport)
// decides against the CURRENT viewport:
//
//   * tile already fully visible → the camera does not move AT ALL (the
//     before/after transforms are byte-equal — no setViewport is issued);
//   * tile off-screen → the MINIMAL translate that tucks it just inside the
//     violated edge(s): untouched axes hold exactly, zoom never changes, and
//     the pan is bounded by overhang + SPAWN_REVEAL_MARGIN_PX (16) — never a
//     lane re-center.
//
// Runs on BOTH mode=workflow (legacy 765px pitch) and mode=workflow&shell=1
// (tight 216px RACKLINE pitch) — the bug reproduced in both. Every scenario
// SETS the viewport explicitly first (the on-load camera differs per mode), so
// the assertions are exact-value, not tolerance-of-drift. Drives the REAL
// palette path (__setSpawnFlowPos + __spawnFromPalette → wcolDropTarget →
// columnFlushPositions slot → the spawn-reveal seam), same as
// workflow-channel-columns.spec.ts. Normal e2e lane (no DB/relay).

import { test, expect, type Page } from '@playwright/test';

// channel-columns.ts geometry (kept in sync with the pure module).
const COLUMN_W = 765; // legacy pitch: 34 × HP_UNIT(22.5)
const SHELL_COLUMN_W = 216; // tight ?shell=1 pitch
const COLUMN_BASELINE_Y = 4320; // COLUMN_SLOT_H(720) × COLUMN_MAX_SLOTS(6)
// `?shell=1` badge-clearance lift (channel-columns.ts SHELL_LANE_BADGE_CLEARANCE_Y):
// stack bottoms anchor 90 flow px ABOVE the baseline so the lane-number badge
// stays visible below the bottom tile. Legacy (shell off) anchors ON the baseline.
const SHELL_BADGE_CLEARANCE_Y = 90;
const SPAWN_REVEAL_MARGIN_PX = 16; // channel-columns.ts SPAWN_REVEAL_MARGIN_PX
const WCOL_PAN_MS = 220; // Canvas.svelte pan animation duration

// The spawned probe module: tidyVco. Legacy card = 3u × 4hp (540 × 720px);
// under ?shell=1 every lane tile is the uniform 192 × 180 RACKLINE box.
const TYPE = 'tidyVco';
const tileW = (shell: boolean) => (shell ? 192 : 720);
const tileH = (shell: boolean) => (shell ? 180 : 540);
const pitchOf = (shell: boolean) => (shell ? SHELL_COLUMN_W : COLUMN_W);

/** columnCardX — the persisted X of a width-w card centered in lane ch. */
const cardX = (ch: number, w: number, pitch: number) => (ch - 1) * pitch + (pitch - w) / 2;
/** First member of an empty lane: bottom edge on the ACTIVE stack anchor —
 *  the baseline legacy, the badge-clearance lift (baseline − 90) under ?shell=1. */
const firstSlotRect = (ch: number, shell: boolean) => {
  const w = tileW(shell);
  const h = tileH(shell);
  const anchorY = COLUMN_BASELINE_Y - (shell ? SHELL_BADGE_CLEARANCE_Y : 0);
  return { x: cardX(ch, w, pitchOf(shell)), y: anchorY - h, w, h };
};
/** A flow-space spawn anchor INSIDE lane ch's painted band, at the ACTIVE pitch.
 *  The hit-test is 2-D (laneTargetForFlowPoint): X picks the column, and Y must
 *  land in `[laneTopY, COLUMN_BASELINE_Y)` or the spawn is free canvas. Anchoring
 *  just above the baseline is inside the band at every lane height. */
const colPos = (ch: number, shell: boolean) => ({
  x: (ch - 1) * pitchOf(shell) + 60,
  y: COLUMN_BASELINE_Y - 40,
});

async function gotoWorkflow(page: Page, shell: boolean): Promise<void> {
  await page.goto(shell ? '/rack' : '/rack?shell=legacy');
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
  await page.waitForFunction(
    () => {
      const w = globalThis as unknown as {
        __setSpawnFlowPos?: unknown;
        __spawnFromPalette?: unknown;
        __flow?: unknown;
        __patch?: { nodes: Record<string, { data?: { pinned?: boolean } } | undefined> };
      };
      return (
        typeof w.__setSpawnFlowPos === 'function' &&
        typeof w.__spawnFromPalette === 'function' &&
        !!w.__flow &&
        !!w.__patch &&
        ['pinned-mixmstrs', 'pinned-clipplayer', 'pinned-audioOut'].every(
          (id) => w.__patch!.nodes[id]?.data?.pinned === true,
        )
      );
    },
    undefined,
    { timeout: 20_000 },
  );
}

/** The flow PANE rect — the SAME element Canvas's readWorkflowViewportMetrics
 *  measures (div.flow / flowEl), so the test's visibility math matches the app's. */
async function paneRect(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.locator('.flow:visible').first().boundingBox();
  expect(box, 'the flow pane should be laid out').toBeTruthy();
  return box!;
}

async function getViewport(page: Page): Promise<{ x: number; y: number; zoom: number }> {
  return page.evaluate(() => (globalThis as any).__flow.getViewport());
}

async function setViewport(page: Page, vp: { x: number; y: number; zoom: number }): Promise<void> {
  await page.evaluate((v) => (globalThis as any).__flow.setViewport(v, { duration: 0 }), vp);
}

/** Wait until the viewport transform holds still across two consecutive frames
 *  spaced a full pan-duration apart — any WCOL_PAN_MS animation has finished. */
async function settledViewport(page: Page): Promise<{ x: number; y: number; zoom: number }> {
  let prev = await getViewport(page);
  for (let i = 0; i < 25; i++) {
    await page.waitForTimeout(WCOL_PAN_MS + 60);
    const cur = await getViewport(page);
    if (cur.x === prev.x && cur.y === prev.y && cur.zoom === prev.zoom) return cur;
    prev = cur;
  }
  return prev;
}

/** Drive the REAL palette-drop path into lane `ch` and return the new node id. */
async function spawnIntoLane(page: Page, ch: number, shell: boolean): Promise<string> {
  const before = await page.evaluate(() =>
    Object.keys((globalThis as any).__patch.nodes as Record<string, unknown>),
  );
  await page.evaluate(
    ({ type, pos }) => {
      const w = globalThis as unknown as {
        __setSpawnFlowPos: (p: { x: number; y: number }) => void;
        __spawnFromPalette: (t: string) => void;
      };
      w.__setSpawnFlowPos(pos);
      w.__spawnFromPalette(type);
    },
    { type: TYPE, pos: colPos(ch, shell) },
  );
  const id = await page.evaluate(async (prev) => {
    const w = globalThis as unknown as { __patch: { nodes: Record<string, unknown> } };
    for (let i = 0; i < 40; i++) {
      const added = Object.keys(w.__patch.nodes).filter((k) => !prev.includes(k));
      if (added.length) return added[0]!;
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
    }
    return '';
  }, before);
  expect(id, 'a new node id materialized').toBeTruthy();
  return id;
}

test.describe('workflow spawn-camera reveal: adds never scroll the viewport wildly', () => {
  for (const shell of [false, true]) {
    const label = shell ? 'mode=workflow&shell=1' : 'mode=workflow';

    test(`ON-SCREEN lane add → the viewport transform is UNCHANGED, byte-equal (${label})`, async ({ page }) => {
      await gotoWorkflow(page, shell);
      const pane = await paneRect(page);

      // Frame lane 3 so its first slot is FULLY visible with clear margins:
      // lane band centered horizontally, baseline 40px above the pane bottom.
      const ch = 3;
      const zoom = shell ? 0.9 : 0.4;
      const rect = firstSlotRect(ch, shell);
      const laneCenter = (ch - 1) * pitchOf(shell) + pitchOf(shell) / 2;
      await setViewport(page, {
        x: pane.width / 2 - laneCenter * zoom,
        y: pane.height - 40 - COLUMN_BASELINE_Y * zoom,
        zoom,
      });
      const before = await settledViewport(page);
      // Sanity: the slot the new tile will occupy is fully inside the pane.
      expect(rect.x * zoom + before.x).toBeGreaterThanOrEqual(0);
      expect((rect.x + rect.w) * zoom + before.x).toBeLessThanOrEqual(pane.width);
      expect(rect.y * zoom + before.y).toBeGreaterThanOrEqual(0);
      expect((rect.y + rect.h) * zoom + before.y).toBeLessThanOrEqual(pane.height);

      const id = await spawnIntoLane(page, ch, shell);

      // Give any (buggy) pan animation ample time to fire, then compare EXACT
      // transforms: no setViewport must have been issued at all.
      await page.waitForTimeout(WCOL_PAN_MS * 3);
      const after = await getViewport(page);
      expect(after).toEqual(before);

      // …and the tile really is on screen where the slot math said.
      const box = await page.locator(`.svelte-flow__node[data-id="${id}"]`).boundingBox();
      expect(box).toBeTruthy();
      expect(box!.x).toBeGreaterThanOrEqual(pane.x - 1);
      expect(box!.y).toBeGreaterThanOrEqual(pane.y - 1);
      expect(box!.x + box!.width).toBeLessThanOrEqual(pane.x + pane.width + 1);
      expect(box!.y + box!.height).toBeLessThanOrEqual(pane.y + pane.height + 1);
    });

    test(`OFF-SCREEN lane add → MINIMAL bounded pan: X moves by exactly overhang+margin, Y+zoom hold, tile ends in-view (${label})`, async ({ page }) => {
      await gotoWorkflow(page, shell);
      const pane = await paneRect(page);

      // Frame lane 1 at a zoom where lane 6 is well OFF the right pane edge,
      // but the slot ROW is on-screen vertically → only the X axis may move.
      const zoom = shell ? 1.5 : 0.4;
      const target = 6;
      const rect = firstSlotRect(target, shell);
      const lane1Center = pitchOf(shell) / 2;
      await setViewport(page, {
        x: pane.width / 2 - lane1Center * zoom,
        y: pane.height - 40 - COLUMN_BASELINE_Y * zoom,
        zoom,
      });
      const before = await settledViewport(page);
      // Sanity: lane 6's slot is off the RIGHT edge, in-view vertically.
      const sx1 = (rect.x + rect.w) * zoom + before.x;
      expect(sx1).toBeGreaterThan(pane.width);
      expect(rect.y * zoom + before.y).toBeGreaterThanOrEqual(0);
      expect((rect.y + rect.h) * zoom + before.y).toBeLessThanOrEqual(pane.height);

      const id = await spawnIntoLane(page, target, shell);
      const after = await settledViewport(page);

      // Zoom NEVER changes; the vertical axis was already in view → holds exactly.
      expect(after.zoom).toBe(before.zoom);
      expect(after.y).toBe(before.y);
      // The horizontal pan is the MINIMAL correction: overhang + the 16px
      // comfort margin — not a lane re-center (which would be several 100px).
      const expectedDx = pane.width - SPAWN_REVEAL_MARGIN_PX - sx1;
      expect(Math.abs(after.x - before.x - expectedDx)).toBeLessThanOrEqual(1.5);
      // Bounded, explicitly: strictly smaller than re-centering lane 6 would be.
      const recenterDx = pane.width / 2 - ((target - 1) * pitchOf(shell) + pitchOf(shell) / 2) * zoom - before.x;
      expect(Math.abs(after.x - before.x)).toBeLessThan(Math.abs(recenterDx));

      // The tile ends FULLY in view (flush at the margin inside the right edge).
      const box = await page.locator(`.svelte-flow__node[data-id="${id}"]`).boundingBox();
      expect(box).toBeTruthy();
      expect(box!.x).toBeGreaterThanOrEqual(pane.x - 1);
      expect(box!.y).toBeGreaterThanOrEqual(pane.y - 1);
      expect(box!.x + box!.width).toBeLessThanOrEqual(pane.x + pane.width + 1);
      expect(box!.y + box!.height).toBeLessThanOrEqual(pane.y + pane.height + 1);
    });
  }
});
