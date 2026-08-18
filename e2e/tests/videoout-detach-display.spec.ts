// e2e/tests/videoout-detach-display.spec.ts
//
// videoOut: RIGHT-CLICK → DETACH DISPLAY, and BRIDGE-ON-DELETE (#1821).
//
// Raw `@playwright/test` + `__spawnAtFlowPos`, the `card-drop-patch.spec.ts`
// shape: real cards on the real canvas, real pointer gestures, and every
// assertion made against `window.__patch` — the graph the engine actually reads
// — rather than against the DOM alone.
//
// ⚠ WHY EACH LEG NEEDS A BROWSER. The pure tiers already pin the model
// (`detached-display.test.ts` — the flag, the clamp, the scope;
// `delete-bridge.test.ts` / `delete-bridge-ydoc.test.ts` — the plan and its ONE
// undo entry). What only a browser can show is that the panel is genuinely NOT A
// FLOW NODE (so "no patch wires" is structural), that the two right-click entry
// points really are the same action, that BOTH delete directions destroy both
// representations, and that the real Backspace key path bridges — a different
// code path from the context menu's, which is exactly how one of them would have
// been left unwired.
//
// ⚠ NO `waitForTimeout` ANYWHERE. Every wait here is on an observable — a
// locator count, or a value in `__patch` — through an auto-retrying `expect` /
// `expect.poll`.

import { test, expect, type Page } from '@playwright/test';

const RACK = '/rack?shell=legacy&seed=none';

interface PatchWindow {
  __patch: {
    nodes: Record<string, { type: string; data?: Record<string, unknown> }>;
    edges: Record<string, { source: { nodeId: string; portId: string }; target: { nodeId: string; portId: string } }>;
  };
  __spawnAtFlowPos: (type: string, pos: { x: number; y: number }) => void;
}

/** Spawn `types` through the REAL palette path and return their assigned ids. */
async function seed(page: Page, types: readonly string[]): Promise<Record<string, string>> {
  await page.goto(RACK);
  await page.waitForFunction(() => !!(window as unknown as PatchWindow).__patch);
  await page.evaluate((list) => {
    const w = window as unknown as PatchWindow;
    list.forEach((t, i) => w.__spawnAtFlowPos(t, { x: i * 520, y: 0 }));
  }, types);
  await expect
    .poll(() =>
      page.evaluate(() => Object.keys((window as unknown as PatchWindow).__patch.nodes).length),
    )
    .toBeGreaterThanOrEqual(types.length);
  const ids = await page.evaluate(() =>
    Object.entries((window as unknown as PatchWindow).__patch.nodes).map(([id, n]) => ({ id, type: n.type })),
  );
  const out: Record<string, string> = {};
  for (const t of types) out[t] = ids.find((n) => n.type === t)!.id;
  // The cards must be laid out before any geometry is read.
  await expect(page.locator(`.svelte-flow__node[data-id="${out[types[0]!]}"]`)).toBeVisible();
  return out;
}

const card = (page: Page, id: string) =>
  page.locator(`.svelte-flow__node[data-id="${id}"] [data-testid="video-out-card"]`);
const picture = (page: Page, id: string) =>
  page.locator(`.svelte-flow__node[data-id="${id}"] [data-testid="video-out-fs-wrap"]`);
const panel = (page: Page) => page.locator('[data-testid="detached-display"]');

/** Open the NODE context menu (Docs / Duplicate / Delete) — right-click the card
 *  CHROME, not the picture: the video surface claims its own right-click with
 *  `stopPropagation`, which is deliberate and is why the two menus never fight. */
async function nodeMenu(page: Page, id: string): Promise<void> {
  await page.locator(`.svelte-flow__node[data-id="${id}"]`).click({ button: 'right', position: { x: 6, y: 6 } });
  // Addressed by ARIA, like the two shipped node-menu specs: this menu carries
  // no root testid and adding one for a test is not a reason to touch it.
  await expect(page.getByRole('menu', { name: 'Module actions' })).toBeVisible();
}

/** The node menu's Delete item is addressed by ROLE + TEXT, the shape the two
 *  shipped node-menu specs already use (it carries no testid of its own). */
async function deleteViaNodeMenu(page: Page): Promise<void> {
  await page.locator('[role="menuitem"]', { hasText: 'Delete' }).click();
}

const nodeIds = (page: Page) =>
  page.evaluate(() => Object.keys((window as unknown as PatchWindow).__patch.nodes));
const edgeList = (page: Page) =>
  page.evaluate(() =>
    Object.values((window as unknown as PatchWindow).__patch.edges).map(
      (e) => `${e.source.nodeId}.${e.source.portId}→${e.target.nodeId}.${e.target.portId}`,
    ),
  );

/** Patch `from.out → to.<port>` directly in the doc — this spec is about DELETE
 *  and DETACH, so the wiring is arrangement, not the subject. */
async function wire(page: Page, from: string, fromPort: string, to: string, toPort: string): Promise<void> {
  await page.evaluate(
    ([f, fp, t, tp]) => {
      const w = window as unknown as PatchWindow & { __ydoc: { transact: (fn: () => void) => void } };
      w.__ydoc.transact(() => {
        w.__patch.edges[`e-${f}-${fp}-${t}-${tp}`] = {
          source: { nodeId: f!, portId: fp! },
          target: { nodeId: t!, portId: tp! },
          // The writers re-derive these from the live ports; carried so the
          // stored edge matches the shape every other writer produces.
          id: `e-${f}-${fp}-${t}-${tp}`,
          sourceType: 'video',
          targetType: 'video',
        } as never;
      });
    },
    [from, fromPort, to, toPort] as const,
  );
  await expect.poll(() => edgeList(page)).toContain(`${from}.${fromPort}→${to}.${toPort}`);
}

// ─────────────────────────────────────────────────────────────────────────────

test.describe('videoOut — detach display', () => {
  test('right-click → detach floats a resizable, draggable picture that is NOT a flow node', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const { videoOut } = await seed(page, ['videoOut']);
    await expect(card(page, videoOut)).toBeVisible();

    await expect(panel(page), 'nothing floats before the gesture').toHaveCount(0);
    await picture(page, videoOut).click({ button: 'right' });
    await expect(page.getByTestId('video-canvas-context-menu')).toBeVisible();
    await page.getByTestId('ctx-detach-display').click();

    await expect(panel(page)).toHaveCount(1);
    await expect(panel(page)).toHaveAttribute('data-node-id', videoOut);

    // ⚠ NO PATCH WIRES — asserted STRUCTURALLY, not by looking for absent lines.
    // The panel is mounted outside <SvelteFlow>, so it is not a flow node: there
    // is no handle for a cable to attach to and nothing for the edge layer to
    // draw. A styled-away wire would pass a "no visible edge" check; this cannot.
    expect(
      await page.evaluate(
        () => !!document.querySelector('[data-testid="detached-display"]')?.closest('.svelte-flow__node'),
      ),
      'the detached display must not be a flow node',
    ).toBe(false);
    await expect(panel(page).locator('.svelte-flow__handle')).toHaveCount(0);

    // THE VIOLET BORDER COMES FROM THE DOMAIN CHAIN. Asserted against the token
    // the app resolves for the VIDEO cable rather than a literal, so re-tuning
    // the skin re-tunes this test with it instead of reddening it.
    const want = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--cable-video').trim(),
    );
    const got = await panel(page).evaluate((el) => getComputedStyle(el).borderTopColor);
    const asRgb = await page.evaluate((hex) => {
      const d = document.createElement('div');
      d.style.color = hex;
      document.body.appendChild(d);
      const v = getComputedStyle(d).color;
      d.remove();
      return v;
    }, want);
    expect(got, `panel border should be --cable-video (${want})`).toBe(asRgb);

    // RESIZE via the corner grip — a real pointer drag.
    const before = (await panel(page).boundingBox())!;
    const grip = page.getByTestId('detached-display-resize');
    const gb = (await grip.boundingBox())!;
    await page.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) {
      await page.mouse.move(gb.x + (150 * i) / 8, gb.y + (110 * i) / 8);
    }
    await page.mouse.up();
    await expect
      .poll(async () => (await panel(page).boundingBox())!.width, {
        message: 'CSS px — the grip must grow the panel',
      })
      .toBeGreaterThan(before.width);

    // DRAG by the header.
    const mid = (await panel(page).boundingBox())!;
    const bar = page.getByTestId('detached-display-bar');
    const bb = (await bar.boundingBox())!;
    await page.mouse.move(bb.x + 40, bb.y + bb.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) {
      await page.mouse.move(bb.x + 40 - (180 * i) / 8, bb.y + bb.height / 2 + (100 * i) / 8);
    }
    await page.mouse.up();
    await expect
      .poll(async () => (await panel(page).boundingBox())!.x, { message: 'CSS px — the header drags the panel' })
      .toBeLessThan(mid.x);

    expect(errors, `pageerrors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('RE-ATTACH is reachable from BOTH the floating output and the underlying card', async ({ page }) => {
    // The owner asked for both entries. They are the same menu component with
    // the same handler, but "the same code" is the CLAIM — this is the check.
    const { videoOut } = await seed(page, ['videoOut']);
    await expect(card(page, videoOut)).toBeVisible();

    // (a) from the FLOATING OUTPUT.
    await picture(page, videoOut).click({ button: 'right' });
    await page.getByTestId('ctx-detach-display').click();
    await expect(panel(page)).toHaveCount(1);
    await page.getByTestId('detached-display-wrap').click({ button: 'right' });
    await expect(page.getByTestId('ctx-reattach-display')).toBeVisible();
    await page.getByTestId('ctx-reattach-display').click();
    await expect(panel(page), 're-attach from the panel').toHaveCount(0);
    await expect(page.getByTestId('video-out-detached-plate')).toHaveCount(0);

    // (b) from the UNDERLYING CARD, which while detached shows the plate the
    // right-click lands on.
    await picture(page, videoOut).click({ button: 'right' });
    await page.getByTestId('ctx-detach-display').click();
    await expect(panel(page)).toHaveCount(1);
    await expect(page.getByTestId('video-out-detached-plate')).toHaveCount(1);
    await picture(page, videoOut).click({ button: 'right' });
    await expect(page.getByTestId('ctx-reattach-display')).toBeVisible();
    await page.getByTestId('ctx-reattach-display').click();
    await expect(panel(page), 're-attach from the card').toHaveCount(0);
  });

  test('DELETING THE CARD takes the floating output with it', async ({ page }) => {
    // Direction 1 of 2. ⚠ Both directions are tested because a half-wired
    // version looks correct from whichever side you happen to try first.
    const { videoOut } = await seed(page, ['videoOut']);
    await expect(card(page, videoOut)).toBeVisible();
    await picture(page, videoOut).click({ button: 'right' });
    await page.getByTestId('ctx-detach-display').click();
    await expect(panel(page)).toHaveCount(1);

    // Delete through the NODE's own menu — the ordinary way a user removes a
    // module, with no knowledge of the detached panel anywhere in that path.
    await nodeMenu(page, videoOut);
    await deleteViaNodeMenu(page);

    await expect.poll(() => nodeIds(page)).not.toContain(videoOut);
    await expect(panel(page), 'the floating output goes with the card').toHaveCount(0);
  });

  test('DELETING FROM THE FLOATING OUTPUT takes the card with it', async ({ page }) => {
    // Direction 2 of 2.
    const { videoOut } = await seed(page, ['videoOut']);
    await expect(card(page, videoOut)).toBeVisible();
    await picture(page, videoOut).click({ button: 'right' });
    await page.getByTestId('ctx-detach-display').click();
    await expect(panel(page)).toHaveCount(1);

    await page.getByTestId('detached-display-wrap').click({ button: 'right' });
    await page.getByTestId('ctx-delete-module').click();

    await expect.poll(() => nodeIds(page)).not.toContain(videoOut);
    await expect(panel(page)).toHaveCount(0);
    await expect(card(page, videoOut), 'the card goes with the floating output').toHaveCount(0);
  });

  test('detaching MOVES the picture rather than cloning it — the card stops blitting', async ({ page }) => {
    // ⚠ THE #1802 LEG. A detached display is a second live surface; if the card
    // kept its own preview blit the node would pay the GL readback twice for one
    // picture. The observable is the card's own state flag, which gates the blit
    // in `draw()` — asserted both ways so a flag that never moves cannot pass.
    const { videoOut } = await seed(page, ['videoOut']);
    await expect(picture(page, videoOut)).toHaveAttribute('data-detached', 'false');
    await picture(page, videoOut).click({ button: 'right' });
    await page.getByTestId('ctx-detach-display').click();
    await expect(picture(page, videoOut)).toHaveAttribute('data-detached', 'true');
    await page.getByTestId('detached-display-wrap').click({ button: 'right' });
    await page.getByTestId('ctx-reattach-display').click();
    await expect(picture(page, videoOut)).toHaveAttribute('data-detached', 'false');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

test.describe('videoOut — bridge on delete', () => {
  test('source ▸ OUTPUT ▸ sink: deleting the OUTPUT patches source straight into the sink, in ONE undo', async ({ page }) => {
    const ids = await seed(page, ['lines', 'videoOut', 'sourcery']);
    await wire(page, ids.lines!, 'out', ids.videoOut!, 'in');
    await wire(page, ids.videoOut!, 'out', ids.sourcery!, 'a');

    await nodeMenu(page, ids.videoOut!);
    await deleteViaNodeMenu(page);

    await expect.poll(() => nodeIds(page)).not.toContain(ids.videoOut);
    await expect
      .poll(() => edgeList(page), { message: 'the chain is maintained across the deleted OUTPUT' })
      .toEqual([`${ids.lines}.out→${ids.sourcery}.a`]);

    // ⚠ ONE undo, not two: the node and the bridge move together.
    await page.keyboard.press('Meta+z');
    await expect.poll(() => nodeIds(page)).toContain(ids.videoOut);
    await expect.poll(() => edgeList(page).then((l) => l.sort())).toEqual(
      [`${ids.lines}.out→${ids.videoOut}.in`, `${ids.videoOut}.out→${ids.sourcery}.a`].sort(),
    );
  });

  test('the KEYBOARD delete bridges too — a different code path from the menu', async ({ page }) => {
    // `handleDelete` (xyflow's ondelete) does NOT go through `removePatchNode`,
    // so wiring only the context menu would make Backspace and right-click →
    // Delete do different things to the same rack.
    const ids = await seed(page, ['lines', 'videoOut', 'sourcery']);
    await wire(page, ids.lines!, 'out', ids.videoOut!, 'in');
    await wire(page, ids.videoOut!, 'out', ids.sourcery!, 'a');

    await page.locator(`.svelte-flow__node[data-id="${ids.videoOut}"]`).click({ position: { x: 6, y: 6 } });
    await page.keyboard.press('Backspace');

    await expect.poll(() => nodeIds(page)).not.toContain(ids.videoOut);
    await expect.poll(() => edgeList(page)).toEqual([`${ids.lines}.out→${ids.sourcery}.a`]);
  });

  test('ONE SIDE FREE is an ordinary delete — no invented cable', async ({ page }) => {
    const ids = await seed(page, ['lines', 'videoOut', 'sourcery']);
    await wire(page, ids.lines!, 'out', ids.videoOut!, 'in'); // output left free

    await nodeMenu(page, ids.videoOut!);
    await deleteViaNodeMenu(page);

    await expect.poll(() => nodeIds(page)).not.toContain(ids.videoOut);
    await expect.poll(() => edgeList(page), 'no cable is invented between two modules the user never joined').toEqual([]);
  });

  test("the SELF-PATCH case: an OUTPUT wired to itself deletes plainly, leaving no self-edge", async ({ page }) => {
    // The owner's "silly edge case". Both sides read as patched, so this must be
    // DETECTED rather than fall out of the both-sides-patched precondition.
    const ids = await seed(page, ['videoOut']);
    await wire(page, ids.videoOut!, 'out', ids.videoOut!, 'in');

    await nodeMenu(page, ids.videoOut!);
    await deleteViaNodeMenu(page);

    await expect.poll(() => nodeIds(page)).not.toContain(ids.videoOut);
    await expect.poll(() => edgeList(page), 'no self-edge, no orphan').toEqual([]);
  });

  test('FAN-OUT: the bridge ADDS an edge per target and leaves the source’s other cables alone', async ({ page }) => {
    const ids = await seed(page, ['lines', 'videoOut', 'sourcery', 'recorderbox']);
    // lines already feeds recorderbox directly — the sibling that must survive.
    await wire(page, ids.lines!, 'out', ids.recorderbox!, 'in');
    await wire(page, ids.lines!, 'out', ids.videoOut!, 'in');
    await wire(page, ids.videoOut!, 'out', ids.sourcery!, 'a');

    await nodeMenu(page, ids.videoOut!);
    await deleteViaNodeMenu(page);

    await expect.poll(() => nodeIds(page)).not.toContain(ids.videoOut);
    await expect.poll(() => edgeList(page).then((l) => l.sort())).toEqual(
      [`${ids.lines}.out→${ids.recorderbox}.in`, `${ids.lines}.out→${ids.sourcery}.a`].sort(),
    );
  });
});
