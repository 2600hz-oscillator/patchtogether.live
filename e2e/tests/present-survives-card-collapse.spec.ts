// e2e/tests/present-survives-card-collapse.spec.ts
//
// THE PROJECTOR OUTLIVES THE CARD (owner P0, dev: "backdraft on dev when card
// is not expanded and its been sent to a projector, the output stops").
//
// WHAT "not expanded" MEANS, mechanically. Under the faceplate shell (the
// default — `?shell=legacy` is the escape hatch) BACKDRAFT's OUTPUT SURFACE
// exists in exactly one place: the dock FULL-VIEW that the tile's EXPAND opens.
// The "Present on <display>" menu lives on that surface. So the owner's
// sequence is expand -> present -> COLLAPSE, and the collapse UNMOUNTS the host.
//
// ⚠ WHICH HOST, since backdraft became the first VIDEO FACE (2026-08-17): the
// dock now mounts <ModuleShell>, and the output surface is the face's
// `fullViewBody` extension, `BackdraftOutputBody`. Before promotion it was
// BackdraftCard, mounted in the dock for the same reason. The mechanism, the
// three things that died with the unmount, and every assertion below are
// unchanged — the surface that owns `createPresent` simply has a new name, and
// it is the CURRENT one that needs this proof.
// present-second-display.spec.ts cannot see any of this: it runs
// `?shell=legacy`, where the card sits in the lane forever and is never swapped.
//
// THREE CARD-OWNED THINGS DIED WITH THAT UNMOUNT, and a fix for any one of them
// alone still leaves a dead projector — which is why this spec asserts the
// end-to-end pixel consequence rather than any single mechanism:
//   1. the POPUP — `onDestroy -> present.dispose()` closed the window outright;
//   2. the RENDER LEASE — `attachRenderLease`'s $effect cleanup released the
//      hard pull-eval root, so the engine stopped drawing the node;
//   3. the BLIT SOURCE — the popup's per-frame `drawImage` read the CARD's
//      <canvas>, which the unmount detached, so even an open popup with a
//      rendering node would have frozen on its last frame.
//
// THE INSTRUMENT, and why it is causal rather than statistical. "Is the
// projector live" is asserted by CHANGING THE GRAPH and waiting for the popup's
// pixels to follow: mutate the source's `shape`, poll the popup canvas hash
// until it differs. That single assertion covers all three mechanisms at once —
// a closed popup cannot be sampled, a released lease freezes the node, and a
// detached source canvas freezes the blit — and it needs NO animated content
// and NO wall-clock frame budget, so it does not care that CI's SwiftShader
// runs backdraft at ~8 fps (the frames-not-milliseconds rule).
//
// ⚠ THE PRE-COLLAPSE LEG IS A PERMANENT POSITIVE CONTROL, not a warm-up. It
// runs the identical change-then-follow probe while the card IS mounted. If the
// probe could never observe a change — wrong canvas, wrong hash region, a param
// the renderer ignores — the control goes red FIRST and the post-collapse leg
// cannot pass vacuously. (A negative control on the same probe lives in the
// unit lane: node-present-registry.test.ts drives sweep() and asserts the
// popup+lease DO tear down on node deletion, so "never tears down" cannot pass
// as a fix.)
//
// Real multi-monitor / the Window Management API cannot run in headless CI, so
// the fake `getScreenDetails` from the sibling present spec is reused; the popup
// itself is REAL (window.open -> the /present sink route, captured via
// Playwright's page event), so the blit pipeline under test is the production
// one end to end.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

/** Fake Window Management API with two displays, so the card's OUTPUT menu
 *  capability-gates the "Present on …" entry ON and getScreenRect() can place
 *  the popup. window.open is deliberately NOT stubbed — the real popup must
 *  open so its canvas can be read. */
async function injectScreens(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const fakeScreens = [
      { label: 'Built-in Retina', isPrimary: true, availLeft: 0, availTop: 0, availWidth: 1280, availHeight: 720 },
      { label: 'PROJECTOR', isPrimary: false, availLeft: 0, availTop: 0, availWidth: 1280, availHeight: 720 },
    ];
    const details: EventTarget & { screens: unknown[]; currentScreen: unknown } =
      Object.assign(new EventTarget(), { screens: fakeScreens, currentScreen: fakeScreens[0] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).getScreenDetails = () => Promise.resolve(details);
  });
}

/** FNV-1a over a stride-sampled sweep of the WHOLE popup sink canvas, plus a
 *  non-black flag. Whole-canvas rather than a crop so a change ANYWHERE in the
 *  projected frame registers; strided so the read stays cheap enough to poll.
 *  Returns null when the popup is gone — a CLOSED popup and a FROZEN one must be
 *  distinguishable in the failure message, because "the output stops" has two
 *  very different causes and they need opposite fixes. */
async function popupFrame(popup: Page): Promise<{ hash: number; nonBlack: boolean } | null> {
  if (popup.isClosed()) return null;
  return popup
    .evaluate(() => {
      const c = document.querySelector<HTMLCanvasElement>('[data-testid="present-canvas"]');
      if (!c || c.width < 2 || c.height < 2) return null;
      const ctx = c.getContext('2d');
      if (!ctx) return null;
      const { data } = ctx.getImageData(0, 0, c.width, c.height);
      let hash = 2166136261;
      let nonBlack = false;
      // Stride 8 pixels (32 bytes) — ~1/8 of the frame, enough to key on.
      for (let i = 0; i < data.length; i += 32) {
        hash = Math.imul(hash ^ data[i]!, 16777619);
        hash = Math.imul(hash ^ data[i + 1]!, 16777619);
        hash = Math.imul(hash ^ data[i + 2]!, 16777619);
        if (data[i]! > 16 || data[i + 1]! > 16 || data[i + 2]! > 16) nonBlack = true;
      }
      return { hash: hash >>> 0, nonBlack };
    })
    .catch(() => null);
}

/** Write a param on a node through the live Y.Doc, exactly as a control would. */
async function setParam(page: Page, nodeId: string, key: string, value: number): Promise<void> {
  await page.evaluate(
    ({ nodeId: id, key: k, value: v }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes[id];
        if (n) n.params[k] = v;
      });
    },
    { nodeId, key, value },
  );
}

/** The pull-eval roots the engine currently honours, so a failure can name
 *  WHICH mechanism went (a missing lease vs. a dead blit source). */
async function leasedNodes(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const w = globalThis as unknown as {
      __engine: () => { getDomain: (d: string) => { pullStats: () => { leased: string[] } } };
    };
    try {
      return w.__engine().getDomain('video').pullStats().leased;
    } catch {
      return [];
    }
  });
}

test.describe('present on a second display SURVIVES the card collapsing', () => {
  // Generous BOUNDED-FAILURE cap, not a budget: backdraft is a software-
  // rasterised feedback loop on CI's SwiftShader shard and every Playwright
  // action paces on its rAF (see the COST note in backdraft-full-output.spec.ts).
  test.describe.configure({ timeout: 120_000 });

  test('collapsing the expanded card leaves the projector open AND live', async ({ page, context }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await injectScreens(page);
    // DEFAULT shell (faceplates) — this is the configuration the bug needs.
    await page.goto('/rack?seed=none');
    await page.waitForLoadState('networkidle');

    await spawnPatch(
      page,
      [
        { id: 'src', type: 'shapes', position: { x: 40, y: 40 }, domain: 'video', params: { shape: 2, tile: 0, rotate: 0, zoom: 2.2 } },
        { id: 'bd', type: 'backdraft', position: { x: 520, y: 40 }, domain: 'video' },
      ],
      [{ id: 'e1', from: { nodeId: 'src', portId: 'out' }, to: { nodeId: 'bd', portId: 'in_a' }, sourceType: 'mono-video', targetType: 'video' }],
    );

    // ⚠ THE HOST UNDER TEST IS NO LONGER THE LEGACY CARD. `backdraft` became
    // the first VIDEO FACE, so the dock full-view mounts `<ModuleShell>` and the
    // OUTPUT surface arrives through the face's `fullViewBody` extension
    // (`BackdraftOutputBody`) instead of `BackdraftCard`. The BEHAVIOUR under
    // test is unchanged and the coverage is strictly better: the thing that
    // owns `createPresent` and then unmounts on collapse is now that component,
    // which is exactly the seam that needed proving. Only the selectors move —
    // `backdraft-output-menu` is deliberately the SAME testid on both hosts.
    const outputHost = '[data-testid="backdraft-face-output"]';

    // Nothing mounts the OUTPUT surface in the lane — a 192px tile cannot carry
    // a module surface (`extBody` is dock-gated by `dockFullViewHeadPlan`).
    await expect(
      page.locator(outputHost),
      'the lane tile carries no output surface, only the dock does',
    ).toHaveCount(0);

    // EXPAND — the dock full-view, where the output surface (and its OUTPUT
    // menu) lives. Same call the tile's EXPAND button makes.
    await page.evaluate(() => {
      (globalThis as unknown as { __openDockFullView: (id: string) => void }).__openDockFullView('bd');
    });
    await expect(page.locator(outputHost), 'output surface mounted in the dock full-view').toHaveCount(1);

    // PRESENT on display 2.
    await page.locator('[data-testid="backdraft-output-menu"]').click();
    const presentItem = page.locator('[data-testid="ctx-present-display-1"]');
    await expect(presentItem, 'Present entry offered for the secondary display').toBeVisible();

    const popupPromise = context.waitForEvent('page');
    await presentItem.click();
    const popup = await popupPromise;
    await popup.waitForLoadState('domcontentloaded');
    expect(popup.url()).toContain('/present');
    await expect(popup.locator('[data-testid="present-canvas"]')).toBeAttached();

    // The blit pipeline is running: the projector shows a picture.
    await expect
      .poll(async () => (await popupFrame(popup))?.nonBlack ?? false, { timeout: 30_000 })
      .toBe(true);

    // ── POSITIVE CONTROL (permanent): while the card IS mounted, a graph change
    // reaches the projector. If this leg cannot go green the probe is blind and
    // the post-collapse leg below would pass for the wrong reason.
    const before = await popupFrame(popup);
    expect(before, 'popup sampled while expanded').not.toBeNull();
    // SHAPES' zoom is a log-curve 0.05..10 control: 2.2 -> 0.15 shrinks the
    // primitive from frame-filling to a speck, so essentially every sampled
    // pixel of the projected frame moves. (A value OUTSIDE a param's declared
    // range is silently clamped and makes a control leg vacuous — the first
    // draft of this probe wrote shape=6 against a 0..2 range and "changed"
    // nothing.)
    await setParam(page, 'src', 'zoom', 0.15);
    await expect
      .poll(async () => (await popupFrame(popup))?.hash ?? before!.hash, { timeout: 30_000 })
      .not.toBe(before!.hash);

    // ── THE BUG: COLLAPSE the full view. The card unmounts.
    await page.locator('[data-testid="faceplate-collapse"]').click();
    await expect(page.locator(outputHost), 'the output surface really did unmount').toHaveCount(0);

    // 1. THE POPUP STILL EXISTS. (Pre-fix this is where it died: onDestroy ->
    //    present.dispose() -> popup.close().)
    expect(popup.isClosed(), 'the projector window survived the collapse').toBe(false);

    // 2. THE NODE IS STILL A PULL ROOT. Named explicitly so a future regression
    //    reports WHICH half broke instead of just "pixels stopped".
    expect(await leasedNodes(page), 'backdraft still holds a hard render lease while presenting').toContain('bd');

    // 3. THE PROJECTOR IS STILL LIVE — the same causal probe as the control.
    const collapsed = await popupFrame(popup);
    expect(collapsed, 'popup still sampleable after collapse').not.toBeNull();
    await setParam(page, 'src', 'zoom', 8);
    await expect
      .poll(async () => (await popupFrame(popup))?.hash ?? collapsed!.hash, { timeout: 30_000 })
      .not.toBe(collapsed!.hash);

    // ── THE NEGATIVE CONTROL, IN SITU. "Never closes" is a trivially passing
    // implementation of everything above, and it is its own bug: a deleted
    // module would leave a projector lit on a wall with nothing driving it. The
    // ONE event that still ends a session is the node leaving the GRAPH, which
    // Canvas reconciles through nodePresent.sweep — asserted here rather than
    // only in the unit lane, because the sweep's wiring is what could be
    // omitted. Deleting through the Y.Doc covers every delete route at once
    // (menu, lasso, undo, a peer's CRDT delete, Clear, a patch load).
    const popupClosed = popup.waitForEvent('close', { timeout: 20_000 });
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, unknown>; edges: Record<string, unknown> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        delete w.__patch.edges['e1'];
        delete w.__patch.nodes['bd'];
      });
    });
    await popupClosed;
    expect(popup.isClosed(), 'deleting the node closes its projector').toBe(true);
    expect(await leasedNodes(page), 'and drops its render lease').not.toContain('bd');

    expect(errors).toEqual([]);
  });
});
