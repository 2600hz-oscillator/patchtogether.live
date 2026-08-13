// e2e/tests/dock-tray-shrink-to-content.spec.ts
//
// #1573 — an expanded card's tray must be only as WIDE AS ITS CONTENT NEEDS.
//
// Owner, on dev: expanding a ~300 px SOURCERY card opened a tray spanning the whole
// viewport, so ~900 px of empty chrome sat on top of the canvas and the ⤡/✕ controls
// were parked a screen-width away from the card they act on.
//
// ── Why these assertions and not a width number ───────────────────────────────
//
// The requirement is not "the tray is N px". It is "the space the tray does not need
// shows the canvas beneath". So the load-bearing assertion is a HIT TEST, not a
// measurement: `elementFromPoint` beside the tray must reach the canvas.
//
// That distinction is not pedantic — it is the actual failure mode. `.dock-fullview-drawer`
// still spans the viewport for POSITIONING, so a width-only fix leaves a full-width
// invisible drawer swallowing clicks: the canvas would LOOK exposed and not be clickable.
// A pixel assertion passes on that broken state. The hit test does not.
//
// Widths are asserted only as RELATIONS (tray < viewport, tray >= its own content), never
// as literals, so the test does not need re-tuning when a card's design changes.
//
// ── The constraint this must not re-break ─────────────────────────────────────
//
// `.faceplate-body`'s 900 px min-width exists so a half-width split pane still gets
// horizontal SCROLL rather than dragging the title bar and ✕ out of view — an
// owner-reported fix. Shrink-wrapping must not resurrect that: the ✕ has to stay visible
// AND clickable in every pane, front and flipped. Re-breaking it is worse than the wasted
// space, so it is asserted here in all four combinations rather than assumed.

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';

/** Geometry of the dock trays, read in one page round-trip. */
async function trayGeometry(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const panes = [...document.querySelectorAll('[data-testid="dock-fullview-pane"]')];
    return {
      vw: window.innerWidth,
      panes: panes.map((pane) => {
        const face = pane.querySelector('.faceplate') as HTMLElement;
        const ctrls = pane.querySelector('[data-testid="faceplate-win-ctrls"]') as HTMLElement;
        const frame = pane.querySelector('.fp-card-frame') as HTMLElement | null;
        const f = face.getBoundingClientRect();
        const c = ctrls.getBoundingClientRect();
        return {
          left: Math.round(f.left),
          right: Math.round(f.right),
          top: Math.round(f.top),
          width: Math.round(f.width),
          // Content width the tray is wrapping: a legacy card's frame, else the
          // curated face's kit (which legitimately asks for its full kit width).
          contentWidth: frame ? Math.round(frame.getBoundingClientRect().width) : Math.round(f.width),
          isLegacyCard: !!frame,
          ctrlsInsetRight: Math.round(f.right - c.right),
          ctrlsInsetTop: Math.round(c.top - f.top),
          ctrlsVisible: c.width > 0 && c.height > 0,
        };
      }),
    };
  });
}

/**
 * Does a click at (x, y) reach the canvas, or is it swallowed by dock chrome?
 *
 * This is the assertion the requirement actually names. Reported as the offending
 * element's identity so a failure says WHAT is covering the canvas, not just "false".
 */
async function whatIsAt(page: import('@playwright/test').Page, x: number, y: number) {
  return page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    if (!el) return { desc: '<null>', inDrawer: false };
    const inDrawer = !!el.closest('[data-testid="dock-fullview-drawer"]');
    const id = el.getAttribute('data-testid') ?? el.className ?? el.tagName;
    return { desc: `${el.tagName}.${String(id).slice(0, 60)}`, inDrawer };
  }, { x, y });
}

test.describe('#1573 expanded tray hugs its content', () => {
  test('a narrow legacy card leaves the canvas exposed AND clickable beside it', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/rack');
    await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 30_000 });
    await spawnPatch(page, [{ id: 'p1', type: 'sourcery', domain: 'video' }], [], { mountTimeout: 30_000 });

    await page.evaluate((id) => (globalThis as never as { __openDockFullView(i: string): void }).__openDockFullView(id), 'p1');
    await expect(page.getByTestId('dock-full-view')).toHaveCount(1, { timeout: 20_000 });

    const g = await trayGeometry(page);
    const [tray] = g.panes;
    expect(tray.isLegacyCard, 'sourcery is un-migrated, so it renders a legacy card frame').toBe(true);

    // The tray wraps its content rather than the viewport. Stated as a relation:
    // it must not be consuming space its content did not ask for.
    expect(
      tray.width,
      `tray ${tray.width}px vs viewport ${g.vw}px — a content-sized tray cannot need most of the screen for a ${tray.contentWidth}px card`,
    ).toBeLessThan(g.vw / 2);
    expect(tray.width, 'the tray must still fully contain its card').toBeGreaterThanOrEqual(tray.contentWidth);

    // THE LOAD-BEARING ASSERTION: the space the tray gave back is really the canvas.
    // Sampled at the vertical middle of the tray, where the full-width drawer used to sit.
    const probeX = Math.round((tray.right + g.vw) / 2);
    const probeY = tray.top + 40;
    const hit = await whatIsAt(page, probeX, probeY);
    expect(
      hit.inDrawer,
      `at x=${probeX} (right of the ${tray.width}px tray) the click lands on ${hit.desc} — dock chrome still covers the canvas, so it only LOOKS exposed`,
    ).toBe(false);

    // NEGATIVE CONTROL, permanent: the same probe INSIDE the tray must be swallowed.
    // Without this leg the assertion above would pass just as happily if the drawer had
    // vanished entirely, or if elementFromPoint were returning null for an unrelated
    // reason — i.e. it proves the probe can still see dock chrome when chrome is there.
    const insideHit = await whatIsAt(page, tray.left + Math.round(tray.width / 2), probeY);
    expect(
      insideHit.inDrawer,
      `the probe must still detect chrome INSIDE the tray, else it is not measuring what it claims (saw ${insideHit.desc})`,
    ).toBe(true);

    // The controls belong to the tray's upper right, next to the card.
    expect(tray.ctrlsVisible).toBe(true);
    expect(tray.ctrlsInsetRight, 'CSS px from the tray right edge to the ⤡/✕ cluster').toBeLessThan(48);
    expect(tray.ctrlsInsetRight).toBeGreaterThanOrEqual(0);
    expect(tray.ctrlsInsetTop, 'CSS px from the tray top to the ⤡/✕ cluster').toBeLessThan(64);
  });

  test('a curated face still gets its full kit width', async ({ page }) => {
    // POSITIVE CONTROL for the change: shrink-wrapping is scoped to legacy card frames.
    // A migrated face renders through ModuleShell and asks for the kit width by design;
    // if this shrank too, the fix would have broken every faceplate to fix one tray.
    test.setTimeout(120_000);
    await page.goto('/rack');
    await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 30_000 });
    await spawnPatch(page, [{ id: 'p1', type: 'adsr', domain: 'audio' }], [], { mountTimeout: 30_000 });

    await page.evaluate((id) => (globalThis as never as { __openDockFullView(i: string): void }).__openDockFullView(id), 'p1');
    await expect(page.getByTestId('dock-full-view')).toHaveCount(1, { timeout: 20_000 });

    const g = await trayGeometry(page);
    const [tray] = g.panes;
    expect(tray.isLegacyCard, 'adsr is migrated — no legacy card frame').toBe(false);
    // Derived from the element itself, not a typed constant: the kit's own min-width is
    // what the tray must honour, whatever that kit is.
    const kitMin = await page.evaluate(() =>
      parseInt(getComputedStyle(document.querySelector('.faceplate-body') as HTMLElement).minWidth, 10),
    );
    expect(kitMin, 'a curated face keeps a real kit min-width').toBeGreaterThan(0);
    expect(tray.width, 'a curated face is not shrink-wrapped below its kit').toBeGreaterThanOrEqual(kitMin);
    expect(tray.ctrlsInsetRight).toBeLessThan(48);
  });

  for (const flipped of [false, true]) {
    test(`split view: every pane's ✕ stays reachable (${flipped ? 'flipped' : 'front'})`, async ({ page }) => {
      // THE REGRESSION THIS GUARDS: the 900px body min-width was added so a half-width
      // split pane scrolls instead of pushing the ✕ off-screen. Shrink-wrapping must not
      // bring that back. Asserted by CLICKABILITY, not visibility — an element can be
      // painted and still be under something.
      test.setTimeout(120_000);
      await page.setViewportSize({ width: 900, height: 800 }); // deliberately cramped
      await page.goto('/rack');
      await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 30_000 });
      await spawnPatch(
        page,
        [
          { id: 'p1', type: 'sourcery', domain: 'video' },
          { id: 'p2', type: 'adsr', domain: 'audio' },
        ],
        [],
        { mountTimeout: 30_000 },
      );

      for (const id of ['p1', 'p2']) {
        await page.evaluate((i) => (globalThis as never as { __openDockFullView(x: string): void }).__openDockFullView(i), id);
      }
      await expect(page.getByTestId('dock-fullview-pane')).toHaveCount(2, { timeout: 20_000 });

      if (flipped) {
        // Bare Tab is the dock's flip shortcut while the full-view is open, and the
        // dock is its SINGLE owner in that state (Canvas.svelte:7803). Use the real
        // keystroke rather than a synthetic event so the guard is exercised too.
        await page.keyboard.press('Tab');
        await expect(page.locator('[data-fullview-flipped="true"]')).toHaveCount(1, { timeout: 10_000 });
      }

      const g = await trayGeometry(page);
      expect(g.panes.length, 'both panes render').toBe(2);

      // Panes stay inside the viewport — neither pushed off nor overlapping.
      for (const [i, p] of g.panes.entries()) {
        expect(p.left, `pane ${i} left edge is on-screen`).toBeGreaterThanOrEqual(0);
        expect(p.right, `pane ${i} right edge is on-screen (was the ✕-off-screen bug)`).toBeLessThanOrEqual(g.vw);
        expect(p.ctrlsVisible, `pane ${i} controls render`).toBe(true);
        expect(p.ctrlsInsetRight, `pane ${i}: ✕ sits inside its own tray`).toBeGreaterThanOrEqual(0);
      }

      // Every ✕ is actually hittable — Playwright's own actionability check, which
      // accounts for occlusion, is the assertion.
      const closes = page.getByTestId('faceplate-close');
      await expect(closes).toHaveCount(2);
      for (let i = 0; i < 2; i++) {
        const box = await closes.nth(i).boundingBox();
        expect(box, `pane ${i} ✕ has a hit box`).not.toBeNull();
        const at = await whatIsAt(page, box!.x + box!.width / 2, box!.y + box!.height / 2);
        expect(at.inDrawer, `pane ${i} ✕ is covered by ${at.desc}`).toBe(true);
      }
      // And it WORKS: closing one pane leaves exactly the other.
      await closes.first().click({ timeout: 10_000 });
      await expect(page.getByTestId('dock-fullview-pane')).toHaveCount(1, { timeout: 10_000 });
    });
  }
});
