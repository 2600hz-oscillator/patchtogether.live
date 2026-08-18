// e2e/tests/card-drop-patch.spec.ts
//
// DROP ONE CARD ONTO ANOTHER → THE PATCH MODAL.
//
// The owner's problem, verbatim: "patching video is very intensive on the patch
// menus". A video patch costs one drill-down per cable; this makes it one drag
// plus one click per cable, with every compatible destination visible at once.
//
// ── WHY THIS SPEC IS SHAPED THE WAY IT IS ────────────────────────────────
// `handleNodeDragStop` now serves THREE outcomes from one gesture, and two of
// them shipped long before this one:
//
//   1. drop on empty canvas  → reposition
//   2. drop into a lane/send → lane assignment
//   3. drop onto another card → the modal          ← new
//
// So every assertion that the modal OPENED is paired with an assertion that it
// STAYED SHUT for a drag that should not have claimed it, and the pair is
// driven through the SAME real pointer sequence. A spec that only tested (3)
// would pass against an implementation that opened the modal on every drag —
// which is precisely the regression that matters, because plain dragging is the
// most-used gesture in the app.
//
// ⚠ The `moved` / `did not move` legs are load-bearing for the same reason:
// "the modal did not open" and "the drag did nothing at all" are the same
// observation from the outside, so the position is read on both paths.
//
// Real pointer drags throughout — NOT the `__handleNodeDragStop` hook. The hook
// passes a synthetic position and would skip the drag-origin capture that
// snap-back depends on, so it cannot see this feature's main failure mode.

import { test, expect, type Page } from '@playwright/test';

const RACK = '/rack?shell=legacy&seed=none';

/** Two VIDEO modules, far enough apart that nothing overlaps at rest — the
 *  first overlap in each test is the one the test itself creates. */
const CAM_AT = { x: 0, y: 0 };
const BD_AT = { x: 460, y: 0 };

interface PatchWindow {
  __patch: {
    nodes: Record<string, { type: string; position: { x: number; y: number }; data?: { channel?: number } }>;
    edges: Record<string, { source: { nodeId: string; portId: string }; target: { nodeId: string; portId: string } }>;
  };
  __spawnAtFlowPos: (type: string, pos: { x: number; y: number }) => void;
}
declare const window: Window & PatchWindow;

async function seedTwoVideoCards(page: Page): Promise<{ camId: string; bdId: string }> {
  await page.goto(RACK);
  await page.waitForFunction(() => !!(window as unknown as PatchWindow).__patch);
  await page.evaluate(
    ([cam, bd]) => {
      const w = window as unknown as PatchWindow;
      w.__spawnAtFlowPos('cameraInput', cam);
      w.__spawnAtFlowPos('backdraft', bd);
    },
    [CAM_AT, BD_AT] as const,
  );
  await expect
    .poll(() => page.evaluate(() => Object.keys((window as unknown as PatchWindow).__patch.nodes).length))
    .toBeGreaterThanOrEqual(2);
  const ids = await page.evaluate(() =>
    Object.entries((window as unknown as PatchWindow).__patch.nodes).map(([id, n]) => ({ id, type: n.type })),
  );
  const camId = ids.find((n) => n.type === 'cameraInput')!.id;
  const bdId = ids.find((n) => n.type === 'backdraft')!.id;
  // The cards must be laid out before any geometry is read.
  await expect(page.locator(`.svelte-flow__node[data-id="${bdId}"]`)).toBeVisible();
  return { camId, bdId };
}

const nodePos = (page: Page, id: string) =>
  page.evaluate((i) => ({ ...(window as unknown as PatchWindow).__patch.nodes[i]!.position }), id);

const edgeIds = (page: Page) =>
  page.evaluate(() => Object.keys((window as unknown as PatchWindow).__patch.edges));

/** A REAL pointer drag of a card, grabbed by its header — the realistic grab
 *  point, and the one that makes the pointer disagree with the card's centre
 *  (which is why the drop rule tests the CENTRE, not the cursor). */
async function dragCardTo(page: Page, id: string, to: { x: number; y: number }): Promise<void> {
  const box = (await page.locator(`.svelte-flow__node[data-id="${id}"]`).boundingBox())!;
  const gx = box.x + box.width / 2;
  const gy = box.y + 14;
  await page.mouse.move(gx, gy);
  await page.mouse.down();
  for (let i = 1; i <= 16; i++) {
    await page.mouse.move(gx + ((to.x - gx) * i) / 16, gy + ((to.y - gy) * i) / 16);
  }
  await page.mouse.up();
}

/** Screen-space centre of a card. */
async function centreOf(page: Page, id: string): Promise<{ x: number; y: number }> {
  const b = (await page.locator(`.svelte-flow__node[data-id="${id}"]`).boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

const scrim = (page: Page) => page.locator('[data-testid="patch-drop-scrim"]');

/** The SHIPPED carry singleton's mode, read straight off the page. The point
 *  of reading it is that "the ghost is not drawn" and "the carry was thrown
 *  away" look identical from the outside, and only one of them is the fix. */
const pickupMode = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __connectDragState?: { mode: string } }).__connectDragState?.mode ??
      'idle',
  );

/** Start an ORDINARY click-click carry from a card's first output row — the
 *  gesture the ghost exists for, with no modal anywhere near it. */
async function carryFirstOutputOf(page: Page, nodeId: string): Promise<void> {
  const chrome = page.locator(`[data-patch-panel-chrome="${nodeId}"]`);
  await page.locator(`.svelte-flow__node[data-id="${nodeId}"] [data-testid="patch-trigger"]`).click();
  await expect(chrome).toHaveAttribute('aria-hidden', 'false');
  await chrome.locator('[data-testid="patch-panel-nav"][data-nav="outputs"]').click();
  await chrome.locator('[data-testid="patch-panel-port-row"]').first().click();
}

test.describe('drop a card on a card → the patch modal', () => {
  test('a plain drag to empty canvas MOVES the card and opens NOTHING', async ({ page }) => {
    // OUTCOME 1, unchanged. This is the leg that fails if the drop rule is too
    // loose — and it is the single most-used gesture in the app.
    const { bdId } = await seedTwoVideoCards(page);
    const before = await nodePos(page, bdId);
    const box = (await page.locator(`.svelte-flow__node[data-id="${bdId}"]`).boundingBox())!;

    await dragCardTo(page, bdId, { x: box.x + box.width / 2 + 150, y: box.y + 14 + 90 });

    await expect.poll(() => nodePos(page, bdId)).not.toEqual(before);
    await expect(scrim(page)).toHaveCount(0);
  });

  test('a drag that only CLIPS another card still just moves it', async ({ page }) => {
    // The threshold's reason for existing. xyflow's own intersection default is
    // `overlappingArea > 0` — one square pixel — and the app's collision
    // resolver slides cards in 22.5px steps, so a rule at that default would
    // fire on ordinary tidying. The gate is the dragged card's CENTRE.
    const { camId, bdId } = await seedTwoVideoCards(page);
    const cam = (await page.locator(`.svelte-flow__node[data-id="${camId}"]`).boundingBox())!;
    const bd = (await page.locator(`.svelte-flow__node[data-id="${bdId}"]`).boundingBox())!;
    const before = await nodePos(page, bdId);

    // Land backdraft's centre just PAST camera's right edge: the two overlap,
    // but the centre is outside, so this is a move and not a drop.
    await dragCardTo(page, bdId, { x: cam.x + cam.width + bd.width / 2 - 60, y: cam.y + cam.height / 2 });

    await expect(scrim(page)).toHaveCount(0);
    await expect.poll(() => nodePos(page, bdId)).not.toEqual(before);
  });

  // ⏸ FLAKE-PARK #1847 — parked with `test.fixme`; the body and its assertions are UNCHANGED.
  // NONDETERMINISM: 1 recovered-on-retry observation(s) across 1 SHA(s) / 1 branch(es) in the
  // 96 h CI census to 2026-08-18 — never a hard failure, so every one of those jobs reported SUCCESS.
  // LOST WHILE PARKED: the entry point of the whole feature — a centre-drop onto another card opens the patch modal at all, and the dragged card returns to its origin instead of being left displaced.
  // Re-enable only on a root cause (#1847); "it passes now" is not one.
  test.fixme('dropping the CENTRE on another card opens the modal and SNAPS THE CARD BACK', { annotation: { type: 'fixme', description: 'FLAKE-PARK #1847 — nondeterministic on CI: 1 recovered-on-retry observations in the 96 h census to 2026-08-18; parked until root-caused' } }, async ({ page }) => {
    const { camId, bdId } = await seedTwoVideoCards(page);
    const before = await nodePos(page, bdId);

    await dragCardTo(page, bdId, await centreOf(page, camId));

    await expect(scrim(page)).toBeVisible();
    // ⚠ SNAP BACK. Not cosmetic: membership is derived from POSITION, so a card
    // left where it landed could be reparented into whatever lane it was over.
    // Restoring first means there is no new position to derive a reparent from.
    await expect.poll(() => nodePos(page, bdId)).toEqual(before);
  });

  // ⏸ FLAKE-PARK #1847 — parked with `test.fixme`; the body and its assertions are UNCHANGED.
  // NONDETERMINISM: 17 recovered-on-retry observation(s) across 17 SHA(s) / 9 branch(es) in the
  // 96 h CI census to 2026-08-18 — never a hard failure, so every one of those jobs reported SUCCESS.
  // LOST WHILE PARKED: that incompatible port pairs are refused and summarised rather than silently dropped — the affordance that tells the user WHY a cable they expected did not appear.
  // Re-enable only on a root cause (#1847); "it passes now" is not one.
  test.fixme('refusals are COLLAPSED behind a summary that carries its count', { annotation: { type: 'fixme', description: 'FLAKE-PARK #1847 — nondeterministic on CI: 17 recovered-on-retry observations in the 96 h census to 2026-08-18; parked until root-caused' } }, async ({ page }) => {
    const { camId, bdId } = await seedTwoVideoCards(page);
    await dragCardTo(page, bdId, await centreOf(page, camId));
    await expect(scrim(page)).toBeVisible();

    const toggle = scrim(page).locator('[data-testid="drop-refused-toggle"]');
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');

    // ⚠ THE COUNT IS THE AFFORDANCE. A bare chevron is indistinguishable from
    // "nothing here", which is the exact failure dimming-not-hiding prevents.
    const count = Number(await toggle.getAttribute('data-count'));
    expect(count).toBeGreaterThan(0);
    await expect(toggle).toContainText(String(count));

    // Collapsed means collapsed…
    const refusedRows = scrim(page).locator('[data-testid="drop-target-more"] [data-testid="drop-row"]');
    await expect(refusedRows).toHaveCount(0);
    // …and expanding really does produce every one of them, each with a reason.
    await toggle.click();
    await expect(refusedRows).toHaveCount(count);
    await expect(scrim(page).locator('[data-testid="drop-row-why"]').first()).not.toBeEmpty();

    // The offered rows were never hidden.
    await expect(scrim(page).locator('[data-testid="drop-row"][data-state="offered"]').first()).toBeVisible();
  });

  // ⏸ FLAKE-PARK #1847 — parked with `test.fixme`; the body and its assertions are UNCHANGED.
  // NONDETERMINISM: 27 recovered-on-retry observation(s) across 27 SHA(s) / 11 branch(es) in the
  // 96 h CI census to 2026-08-18 — never a hard failure, so every one of those jobs reported SUCCESS.
  // LOST WHILE PARKED: the commit path: staged rows become real edges in the graph, and the whole multi-cable session is a SINGLE undo — broken atomicity here leaves half a patch behind on Cmd-Z.
  // Re-enable only on a root cause (#1847); "it passes now" is not one.
  test.fixme('staged rows commit as REAL edges, and ONE undo removes the whole session', { annotation: { type: 'fixme', description: 'FLAKE-PARK #1847 — nondeterministic on CI: 27 recovered-on-retry observations in the 96 h census to 2026-08-18; parked until root-caused' } }, async ({ page }) => {
    const { camId, bdId } = await seedTwoVideoCards(page);
    const startEdges = await edgeIds(page);
    await dragCardTo(page, bdId, await centreOf(page, camId));
    await expect(scrim(page)).toBeVisible();

    const offered = scrim(page).locator('[data-testid="drop-row"][data-state="offered"]');
    await expect(offered.first()).toBeVisible();
    // Stage TWO — the point of the gesture is many cables per trip, and the
    // undo unit is the SESSION rather than the click.
    await offered.nth(0).click();
    await offered.nth(0).click();
    await expect(scrim(page).locator('[data-testid="drop-commit"]')).toHaveAttribute('data-staged', '2');

    await page.keyboard.press('Enter');
    await expect(scrim(page)).toHaveCount(0);
    await expect.poll(() => edgeIds(page)).toHaveLength(startEdges.length + 2);

    // Both edges really run camera → backdraft, in the graph the engine reads.
    const wired = await page.evaluate(() =>
      Object.values((window as unknown as PatchWindow).__patch.edges).map(
        (e) => `${e.source.nodeId}->${e.target.nodeId}`,
      ),
    );
    expect(wired.every((w) => w === `${camId}->${bdId}`)).toBe(true);

    // ⚠ ONE undo, not two. A half-applied patch set is the failure mode.
    await page.keyboard.press('Meta+z');
    await expect.poll(() => edgeIds(page)).toHaveLength(startEdges.length);
  });

  // ⏸ FLAKE-PARK #1847 — parked with `test.fixme`; the body and its assertions are UNCHANGED.
  // NONDETERMINISM: 37 recovered-on-retry observation(s) across 37 SHA(s) / 16 branch(es) in the
  // 96 h CI census to 2026-08-18 — never a hard failure, so every one of those jobs reported SUCCESS.
  // LOST WHILE PARKED: the paired 'stayed shut' half of the modal contract: cancelling a drop-to-patch writes NO edge and snaps the card back — without it, a modal that opens on every drag would go unnoticed.
  // Re-enable only on a root cause (#1847); "it passes now" is not one.
  test.fixme('cancelling writes no edge and leaves the card where it started', { annotation: { type: 'fixme', description: 'FLAKE-PARK #1847 — nondeterministic on CI: 37 recovered-on-retry observations in the 96 h census to 2026-08-18; parked until root-caused' } }, async ({ page }) => {
    const { camId, bdId } = await seedTwoVideoCards(page);
    const before = await nodePos(page, bdId);
    const startEdges = await edgeIds(page);

    await dragCardTo(page, bdId, await centreOf(page, camId));
    await expect(scrim(page)).toBeVisible();
    await scrim(page).locator('[data-testid="drop-cancel"]').click();

    await expect(scrim(page)).toHaveCount(0);
    await expect.poll(() => edgeIds(page)).toHaveLength(startEdges.length);
    await expect.poll(() => nodePos(page, bdId)).toEqual(before);
  });

  // ⏸ FLAKE-PARK #1847 — parked with `test.fixme`; the body and its assertions are UNCHANGED.
  // NONDETERMINISM: 39 recovered-on-retry observation(s) across 39 SHA(s) / 16 branch(es) in the
  // 96 h CI census to 2026-08-18 — never a hard failure, so every one of those jobs reported SUCCESS.
  // LOST WHILE PARKED: the escape hatch that keeps drop-to-patch from hijacking the most-used gesture in the app: a drop that was really a MOVE commits as a move, leaving the card where it landed and writing no edge.
  // Re-enable only on a root cause (#1847); "it passes now" is not one.
  test.fixme('"leave it there" is the escape hatch for a drop that really was a move', { annotation: { type: 'fixme', description: 'FLAKE-PARK #1847 — nondeterministic on CI: 39 recovered-on-retry observations in the 96 h census to 2026-08-18; parked until root-caused' } }, async ({ page }) => {
    // Snap-back is the safe default; this is the labelled, explicit override,
    // and it must NOT be what happens by accident.
    const { camId, bdId } = await seedTwoVideoCards(page);
    const before = await nodePos(page, bdId);

    await dragCardTo(page, bdId, await centreOf(page, camId));
    await expect(scrim(page)).toBeVisible();
    await scrim(page).locator('[data-testid="drop-cancel-keep"]').click();

    await expect(scrim(page)).toHaveCount(0);
    await expect.poll(() => nodePos(page, bdId)).not.toEqual(before);
  });

  // ⏸ FLAKE-PARK #1847 — parked with `test.fixme`; the body and its assertions are UNCHANGED.
  // NONDETERMINISM: 40 recovered-on-retry observation(s) across 40 SHA(s) / 16 branch(es) in the
  // 96 h CI census to 2026-08-18 — never a hard failure, so every one of those jobs reported SUCCESS.
  // LOST WHILE PARKED: that TAB — the app's core flip gesture — is captured by the patch modal and does not leak through to flip the rack behind it (an owner-protected gesture per the no-keyboard-a11y ruling).
  // Re-enable only on a root cause (#1847); "it passes now" is not one.
  test.fixme('TAB inverts the modal and does NOT flip the rack behind it', { annotation: { type: 'fixme', description: 'FLAKE-PARK #1847 — nondeterministic on CI: 40 recovered-on-retry observations in the 96 h census to 2026-08-18; parked until root-caused' } }, async ({ page }) => {
    // The third flip-key claimant. Precedence lives in FLIP_KEY_CLAIMANTS, so
    // the modal owns Tab while it is open and the canvas-wide flip must stay
    // put — the phase-divergence class this codebase has already had once.
    const { camId, bdId } = await seedTwoVideoCards(page);
    await dragCardTo(page, bdId, await centreOf(page, camId));
    await expect(scrim(page)).toBeVisible();

    const modal = scrim(page).locator('[data-testid="drop-patch-modal"]');
    await expect(modal).toHaveAttribute('data-direction', 'downstream');
    const rearBefore = await page.locator('.flow').getAttribute('data-rear-view');

    await page.keyboard.press('Tab');

    await expect(modal).toHaveAttribute('data-direction', 'upstream');
    expect(await page.locator('.flow').getAttribute('data-rear-view')).toBe(rearBefore);
  });

  // ⏸ FLAKE-PARK #1847 — parked with `test.fixme`; the body and its assertions are UNCHANGED.
  // NONDETERMINISM: 7 recovered-on-retry observation(s) across 7 SHA(s) / 5 branch(es) in the
  // 96 h CI census to 2026-08-18 — never a hard failure, so every one of those jobs reported SUCCESS.
  // LOST WHILE PARKED: the drag-origin capture the `__handleNodeDragStop` hook structurally cannot see — that the pickup ghost draws for a plain carry and is suppressed once the modal owns the gesture.
  // Re-enable only on a root cause (#1847); "it passes now" is not one.
  test.fixme('the pickup ghost draws for a PLAIN carry and is SUPPRESSED under the modal', { annotation: { type: 'fixme', description: 'FLAKE-PARK #1847 — nondeterministic on CI: 7 recovered-on-retry observations in the 96 h census to 2026-08-18; parked until root-caused' } }, async ({
    page,
  }) => {
    // #1838, owner: "in this view we do not want the dangling dotted patch
    // cable, it's clutter that's not helpful."
    //
    // ⚠ BOTH DIRECTIONS OR THIS TEST IS WORTHLESS. "no ghost while the modal
    // is open" alone passes just as happily against a DELETED <PickupCable>,
    // which is the opposite of the fix: the ordinary click-click carry is the
    // most-used patching gesture in the app. So the present leg runs first,
    // through the same real gesture, in the same rack.
    const { camId, bdId } = await seedTwoVideoCards(page);
    const ghost = page.getByTestId('pickup-cable');

    // ── PRESENT: an ordinary carry, no modal anywhere. ──
    await carryFirstOutputOf(page, camId);
    await page.mouse.move(520, 380);
    await expect(ghost).toBeVisible();
    await expect(scrim(page)).toHaveCount(0);

    await page.keyboard.press('Escape');
    await expect(ghost).toHaveCount(0);
    await expect.poll(() => pickupMode(page)).toBe('idle');

    // ── ABSENT: the same ghost, with the drop modal open over it. ──
    await dragCardTo(page, bdId, await centreOf(page, camId));
    await expect(scrim(page)).toBeVisible();
    // Move the cursor: the ghost is drawn from the carry to the LIVE cursor, so
    // a stale cursor is a second reason it could be missing. Rule it out.
    await page.mouse.move(520, 380);
    await expect(ghost).toHaveCount(0);

    // ⚠ PRESENTATION ONLY. The modal CLAIMS the carry deliberately — RearCard's
    // compatibility dim is driven by it, and staging / Tab / commit / one-⌘Z
    // undo all hang off the same state — so "the ghost is gone" must not mean
    // "the carry was cancelled". The singleton is still held while nothing is
    // drawn, which is exactly the difference between a presentation fix and a
    // state change.
    expect(await pickupMode(page)).toBe('pickup');
  });

  // ⏸ FLAKE-PARK #1847 — parked with `test.fixme`; the body and its assertions are UNCHANGED.
  // NONDETERMINISM: 7 recovered-on-retry observation(s) across 7 SHA(s) / 5 branch(es) in the
  // 96 h CI census to 2026-08-18 — never a hard failure, so every one of those jobs reported SUCCESS.
  // LOST WHILE PARKED: that the rear backpanel does not open by default — an expanded backpanel on every drop is the difference between one click per cable and the drill-down storm the feature exists to remove.
  // Re-enable only on a root cause (#1847); "it passes now" is not one.
  test.fixme('the rear backpanel is COLLAPSED by default behind a counted chevron', { annotation: { type: 'fixme', description: 'FLAKE-PARK #1847 — nondeterministic on CI: 7 recovered-on-retry observations in the 96 h census to 2026-08-18; parked until root-caused' } }, async ({ page }) => {
    // #1838, owner: "i would also like this content collapsed by default, with
    // a chevron to expand it? hiding the unpatchable connections by default.
    // this was part of the original spec" — the spec being the refusal
    // disclosure's idiom, which is why this asserts the COUNT and not just the
    // chevron.
    const { camId, bdId } = await seedTwoVideoCards(page);
    await dragCardTo(page, bdId, await centreOf(page, camId));
    await expect(scrim(page)).toBeVisible();

    const panel = scrim(page).locator('[data-testid="drop-rear-panel"]');
    const toggle = panel.locator('[data-testid="drop-rear-toggle"]');
    const holes = panel.locator('[data-testid="back-jack"]');

    // ── COLLAPSED on open ──
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(holes).toHaveCount(0);

    // ⚠ THE COUNT IS THE AFFORDANCE, same as the refusal summary. Collapsing to
    // a bare chevron would lose the fact that a backpanel exists at all, which
    // is worse than the clutter it replaced.
    const count = Number(await toggle.getAttribute('data-count'));
    expect(count).toBeGreaterThan(0);
    await expect(toggle).toContainText(String(count));

    // ⚠ THE HALF THAT ANSWERS THE QUESTION DID NOT COLLAPSE. "what can I
    // actually patch" stays on screen — offered rows, the refusal disclosure
    // and the census.
    await expect(scrim(page).locator('[data-testid="drop-row"][data-state="offered"]').first()).toBeVisible();
    await expect(scrim(page).getByTestId('drop-refused-toggle')).toBeVisible();
    await expect(scrim(page).getByTestId('drop-census')).toBeVisible();

    // ── EXPANDED by the chevron ── and the header's number is the panel's
    // real population, not a label that happens to sit next to it.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(panel.getByTestId('rear-card')).toBeVisible();
    await expect(holes).toHaveCount(count);
  });
});
