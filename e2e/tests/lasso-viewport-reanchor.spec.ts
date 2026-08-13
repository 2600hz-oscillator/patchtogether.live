// e2e/tests/lasso-viewport-reanchor.spec.ts
//
// The lasso overlay's ORIGIN is anchored in FLOW space, so panning the viewport
// mid-lasso must move its SCREEN position by the same delta. The cursor end is
// anchored in SCREEN space and must NOT move — that asymmetry is the whole point
// and is what makes this testable.
//
// Why this spec exists (#1551): `Canvas.svelte`'s re-anchor effect says
//
//     // Re-anchor the overlay's screen-space origin whenever flow-space coords
//     // OR VIEWPORT TRANSFORM change. Keeps the rectangle glued to its initial
//     // click point even while the user pans/zooms mid-lasso.
//     $effect(() => {
//       if (!lassoMode || !flowApi || !lassoOriginFlow) return;
//       lassoOriginScreen = flowApi.flowToScreenPosition(lassoOriginFlow);
//     });
//
// but the viewport transform is NOT among its tracked dependencies — it reads
// only `lassoMode`, `flowApi` and `lassoOriginFlow`. `flowToScreenPosition()` is
// an opaque call, so Svelte cannot see the viewport through it. The file carries
// a viewport heartbeat (`wcolViewportTick`, bumped in `onViewportMove`) and this
// effect does not read it.
//
// Reachability: a lasso is driven by pointer, but XYFlow pans on wheel/trackpad,
// so a two-finger scroll or wheel-zoom DURING a lasso drag reaches this. It is
// not an exotic path.
//
// The existing `lasso-group.spec.ts` never separates the two coordinate spaces —
// it drags without panning — which is why this survived. A test invariant to the
// dimension under test returns a clean result.

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

interface Vp {
  x: number;
  y: number;
  zoom: number;
}

test.describe('lasso origin stays glued to flow space across a pan', () => {
  test('panning mid-lasso moves the origin corner by the pan delta', async ({ page }) => {
    await page.goto('/rack?seed=none');
    await spawnPatch(
      page,
      [{ id: 'lfo-1', type: 'lfo', position: { x: 100, y: 100 }, domain: 'audio' }],
      [],
    );
    await expect(page.locator('.svelte-flow__node[data-id="lfo-1"]')).toBeVisible();

    // Origin up-left of the cursor, so the overlay's (left, top) IS the origin
    // corner and reading its box reads the origin directly.
    const ORIGIN = { x: 300, y: 300 };
    const CURSOR = { x: 700, y: 600 };

    await page.evaluate(
      ({ o, c }) => {
        const w = globalThis as unknown as {
          __lasso?: { enter(x: number, y: number): void; setCursor(x: number, y: number): void };
        };
        w.__lasso!.enter(o.x, o.y);
        w.__lasso!.setCursor(c.x, c.y);
      },
      { o: ORIGIN, c: CURSOR },
    );

    const overlay = page.locator('[data-testid="lasso-overlay"]');
    await expect(overlay, 'lasso overlay renders once lasso mode is entered').toBeVisible();

    const before = await overlay.boundingBox();
    expect(before, 'overlay has a box before the pan').toBeTruthy();

    // Pan by a known delta through XYFlow's own API — the same path a wheel /
    // trackpad pan takes, without synthesising wheel events (which are
    // notoriously timing-sensitive through the pane handler; the existing lasso
    // spec avoids them for the same reason).
    const DX = 120;
    const DY = 80;
    await page.evaluate(
      ({ dx, dy }) => {
        const w = globalThis as unknown as {
          __flow?: { getViewport(): Vp; setViewport(v: Vp): void };
        };
        const vp = w.__flow!.getViewport();
        w.__flow!.setViewport({ x: vp.x + dx, y: vp.y + dy, zoom: vp.zoom });
      },
      { dx: DX, dy: DY },
    );

    // The origin is a FLOW-space point: pan the viewport by (DX, DY) and its
    // screen projection must move by exactly (DX, DY). The cursor end is a
    // SCREEN-space point and stays put, so the box grows rather than translating
    // — which is why only the origin corner is asserted here.
    await expect
      .poll(async () => (await overlay.boundingBox())?.x, {
        message: `lasso origin X must follow a ${DX}px pan (flow-anchored); it is stale if the re-anchor effect does not track the viewport`,
      })
      .toBeCloseTo(before!.x + DX, 0);

    const after = await overlay.boundingBox();
    expect(
      after!.y,
      `lasso origin Y must follow a ${DY}px pan (flow-anchored)`,
    ).toBeCloseTo(before!.y + DY, 0);
  });
});
