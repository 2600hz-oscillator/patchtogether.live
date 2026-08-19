// e2e/tests/videoout-drop-patch.spec.ts
//
// PER-MODULE DROP-GESTURE COVERAGE for `videoOut` (#1819, alongside its face in
// #1821). The generic gesture is covered by `card-drop-patch.spec.ts`; this is
// the module the owner named — *"i want to get our Video Output"* — because it
// is the natural SINK of the gesture and the case they called *"very intensive
// on the patch menus"*.
//
// ⚠ EXPLICITLY NOT A SWEEP (#1819, by name — the `cv-param-reach` precedent).
// One module, one file, landing with the module.
//
// What this owes, from #1819:
//   * the real card on the real canvas — real pointer drags, not the
//     `__handleNodeDragStop` hook (which skips the drag-origin capture)
//   * an ACCEPTED drop AND a REFUSED one
//   * a real committed edge asserted in `patch.edges`, not just a modal
//   * single-⌘Z undo of the whole session
//
// ⚠ videoOut HAS EXACTLY ONE INPUT, which shapes two of the legs and is worth
// stating so a later edit does not "fix" them:
//   * the accepted drop stages exactly ONE row (`data-staged="1"`) — the
//     generic spec's stage-two-rows shape is impossible here;
//   * a video source ▸ videoOut offers 1 of 1 and refuses NOTHING, so the
//     refused-row leg has to come from the OTHER direction (Tab), where
//     videoOut's `out` meets a module's cv inputs. Reaching for a refusal on
//     videoOut's own input side would be reaching for a row that cannot exist.

import { test, expect, type Page } from '@playwright/test';

const RACK = '/rack?shell=legacy&seed=none';

/** Far enough apart that nothing overlaps at rest — the first overlap in each
 *  test is the one the test itself creates. */
const AT = [
  { x: 0, y: 0 },
  { x: 520, y: 0 },
] as const;

interface PatchWindow {
  __patch: {
    nodes: Record<string, { type: string; position: { x: number; y: number } }>;
    edges: Record<string, { source: { nodeId: string; portId: string }; target: { nodeId: string; portId: string } }>;
  };
  __spawnAtFlowPos: (type: string, pos: { x: number; y: number }) => void;
}

/** Spawn `partner` and a `videoOut` through the REAL palette path. */
async function seedPair(page: Page, partner: string): Promise<{ partnerId: string; voId: string }> {
  await page.goto(RACK);
  await page.waitForFunction(() => !!(window as unknown as PatchWindow).__patch);

  // Boot the engine BEFORE any interaction, so engine state is deterministic
  // rather than racing the first pointer gesture. #1844 mounted AudioGate on
  // /rack, and the first gesture now dismisses it through ensureEngine() —
  // AudioContext, AWAIT resume(), then the VideoEngine. Doing it here removes
  // that async work from inside the drag.
  //
  // ⚠ THIS IS NOT A CONFIRMED FIX for the CI-only failure of the REFUSED ROWS
  // case (30 s timeout, BOTH attempts, 0 flaky, while all five pass locally).
  // The hypothesis that a still-present focusable gate swallowed the Tab was
  // DISPROVEN by a positive control: asserting the gate is present here fails
  // locally 15/15, so the gate is not up at this point. The mechanism is still
  // unknown. Get the trace artifact from the failing CI job before theorising
  // further — do not raise the timeout.
  await page.waitForFunction(() => {
    const w = globalThis as unknown as { __ensureEngine?: () => Promise<unknown> };
    return typeof w.__ensureEngine === 'function';
  });
  await page.evaluate(async () => {
    await (globalThis as unknown as { __ensureEngine: () => Promise<unknown> }).__ensureEngine();
  });
  await page.evaluate(
    ([p, a, b]) => {
      const w = window as unknown as PatchWindow;
      w.__spawnAtFlowPos(p as string, a as { x: number; y: number });
      w.__spawnAtFlowPos('videoOut', b as { x: number; y: number });
    },
    [partner, AT[0], AT[1]] as const,
  );
  await expect
    .poll(() => page.evaluate(() => Object.keys((window as unknown as PatchWindow).__patch.nodes).length))
    .toBeGreaterThanOrEqual(2);
  const ids = await page.evaluate(() =>
    Object.entries((window as unknown as PatchWindow).__patch.nodes).map(([id, n]) => ({ id, type: n.type })),
  );
  const partnerId = ids.find((n) => n.type === partner)!.id;
  const voId = ids.find((n) => n.type === 'videoOut')!.id;
  await expect(page.locator(`.svelte-flow__node[data-id="${voId}"]`)).toBeVisible();
  await expect(page.locator(`.svelte-flow__node[data-id="${partnerId}"]`)).toBeVisible();
  return { partnerId, voId };
}

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

async function centreOf(page: Page, id: string): Promise<{ x: number; y: number }> {
  const b = (await page.locator(`.svelte-flow__node[data-id="${id}"]`).boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

const nodePos = (page: Page, id: string) =>
  page.evaluate((i) => ({ ...(window as unknown as PatchWindow).__patch.nodes[i]!.position }), id);
const edgeIds = (page: Page) =>
  page.evaluate(() => Object.keys((window as unknown as PatchWindow).__patch.edges));
const wiredPairs = (page: Page) =>
  page.evaluate(() =>
    Object.values((window as unknown as PatchWindow).__patch.edges).map(
      (e) => `${e.source.nodeId}.${e.source.portId}→${e.target.nodeId}.${e.target.portId}`,
    ),
  );
const scrim = (page: Page) => page.locator('[data-testid="patch-drop-scrim"]');

// ─────────────────────────────────────────────────────────────────────────────

test.describe('videoOut — the card-drop patch gesture', () => {
  test('ACCEPTED: dropping OUTPUT onto a source commits a REAL edge, and ONE ⌘Z removes the session', async ({ page }) => {
    // The commonest patch a user wants: a generator into the monitor. Dropping
    // the OUTPUT onto the source reads `downstream` — the dropped module ends up
    // downstream — so the offered row is LINES.out ▸ OUTPUT.in.
    const { partnerId, voId } = await seedPair(page, 'lines');
    const startEdges = await edgeIds(page);

    await dragCardTo(page, voId, await centreOf(page, partnerId));
    await expect(scrim(page)).toBeVisible();
    await expect(page.locator('[data-testid="drop-patch-modal"]')).toHaveAttribute('data-direction', 'downstream');

    const offered = scrim(page).locator('[data-testid="drop-row"][data-state="offered"]');
    await expect(offered.first()).toBeVisible();
    await offered.first().click();
    // ⚠ EXACTLY ONE — videoOut declares a single input, so there is no second
    // row to stage. See the header.
    await expect(scrim(page).locator('[data-testid="drop-commit"]')).toHaveAttribute('data-staged', '1');

    await page.keyboard.press('Enter');
    await expect(scrim(page)).toHaveCount(0);
    await expect.poll(() => edgeIds(page)).toHaveLength(startEdges.length + 1);
    // The edge is REAL and runs the right way, in the graph the engine reads.
    await expect.poll(() => wiredPairs(page)).toContain(`${partnerId}.out→${voId}.in`);

    // ⚠ ONE undo. The unit is the modal SESSION, not the click.
    await page.keyboard.press('Meta+z');
    await expect.poll(() => edgeIds(page)).toHaveLength(startEdges.length);
  });

  test('REFUSED: an AUDIO partner offers nothing either way, so the drag stays a MOVE', async ({ page }) => {
    // The strongest refusal the feature has: `dropHasAnyOffer` never claims the
    // gesture, so the modal does not appear at all and the card simply moves.
    // ⚠ Paired with a position read, because "the modal did not open" and "the
    // drag did nothing" are the same observation from the outside.
    const { partnerId, voId } = await seedPair(page, 'analogVco');
    const before = await nodePos(page, voId);
    const startEdges = await edgeIds(page);

    await dragCardTo(page, voId, await centreOf(page, partnerId));

    await expect(scrim(page), 'an audio module offers OUTPUT nothing').toHaveCount(0);
    await expect.poll(() => nodePos(page, voId), 'the card still MOVED').not.toEqual(before);
    await expect.poll(() => edgeIds(page)).toHaveLength(startEdges.length);
  });

  test('REFUSED ROWS: the incompatible destinations are collapsed behind a counted summary', async ({ page }) => {
    // The other half of the refusal story — a partner where SOME rows are
    // offered and some are not. videoOut's own input side can never produce one
    // (1 of 1 takes video), so this reads the UPSTREAM direction, where
    // OUTPUT.out meets SOURCERY's cv inputs.
    const { partnerId, voId } = await seedPair(page, 'sourcery');
    await dragCardTo(page, voId, await centreOf(page, partnerId));
    await expect(scrim(page)).toBeVisible();

    const modal = page.locator('[data-testid="drop-patch-modal"]');
    await expect(modal).toHaveAttribute('data-direction', 'downstream');
    await page.keyboard.press('Tab');
    await expect(modal).toHaveAttribute('data-direction', 'upstream');

    const toggle = scrim(page).locator('[data-testid="drop-refused-toggle"]');
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const count = Number(await toggle.getAttribute('data-count'));
    expect(count, 'the refused count is load-bearing, not decoration').toBeGreaterThan(0);
    await expect(toggle).toContainText(String(count));

    const refusedRows = scrim(page).locator('[data-testid="drop-target-more"] [data-testid="drop-row"]');
    await expect(refusedRows).toHaveCount(0);
    await toggle.click();
    await expect(refusedRows).toHaveCount(count);
    // A refusal that does not say WHY is a dead end for the user.
    await expect(scrim(page).locator('[data-testid="drop-row-why"]').first()).not.toBeEmpty();

    // …and the legal destinations are still offered alongside them.
    await expect(scrim(page).locator('[data-testid="drop-row"][data-state="offered"]').first()).toBeVisible();
  });

  test('a plain drag of the OUTPUT to empty canvas MOVES it and opens NOTHING', async ({ page }) => {
    // The pair for every "modal opened" above: the most-used gesture in the app
    // must not be claimed by this feature.
    const { voId } = await seedPair(page, 'lines');
    const before = await nodePos(page, voId);
    const box = (await page.locator(`.svelte-flow__node[data-id="${voId}"]`).boundingBox())!;

    await dragCardTo(page, voId, { x: box.x + box.width / 2 + 140, y: box.y + 14 + 200 });

    await expect.poll(() => nodePos(page, voId)).not.toEqual(before);
    await expect(scrim(page)).toHaveCount(0);
  });

  test('CANCEL leaves no edge and snaps the OUTPUT back where it started', async ({ page }) => {
    const { partnerId, voId } = await seedPair(page, 'lines');
    const before = await nodePos(page, voId);
    const startEdges = await edgeIds(page);

    await dragCardTo(page, voId, await centreOf(page, partnerId));
    await expect(scrim(page)).toBeVisible();
    // The modal's own Cancel button, as the generic spec drives it. (Escape is
    // a window listener the modal installs; clicking the control is the gesture
    // a user performs and the one that cannot depend on where focus landed.)
    await scrim(page).locator('[data-testid="drop-cancel"]').click();

    await expect(scrim(page)).toHaveCount(0);
    await expect.poll(() => edgeIds(page)).toHaveLength(startEdges.length);
    await expect.poll(() => nodePos(page, voId), 'the card snapped back').toEqual(before);
  });
});
