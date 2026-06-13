// e2e/tests/cable-z-order.spec.ts
//
// Regression for the "cables sometimes render in front of modules" bug.
// We rely on the structural CSS contract — `.svelte-flow__edges` sits in
// a stacking-context layer below `.svelte-flow__nodes` — rather than a
// pixel scan. Pixel testing is fragile here: cables are anti-aliased
// strokes (sub-pixel hue blending against any backdrop), the canvas's
// own pink/magenta cable-color border on OUTPUT shares hue with the
// `--cable-video` palette, and skin theming changes both. A computed-
// style assertion catches the actual root cause (CSS layer order +
// opaque card root) and is stable across themes.
//
// Two states are covered:
//   - Idle: layer split is active so cables stay below cards.
//   - Dragging: layer split is intentionally DROPPED so cables can
//     float over neighbor cards as the dragged module sweeps past them.
//     Per product direction, the drag-time UX must be preserved — this
//     spec guards against a future agent globally re-pinning cables and
//     killing that affordance.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe('cable z-order: cables under cards in idle, free during drag', () => {
  test('idle: edges layer paints below nodes layer', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Three modules in a row with a cable from the leftmost to the
    // rightmost — the cable's bezier path crosses the middle card body.
    await spawnPatch(
      page,
      [
        // Spread wide enough that the rack-sized cards (analogVco is 3u/hp2 =
        // 360px wide) don't overlap — an overlapping neighbor would intercept
        // the pointer over the middle card (#759).
        { id: 'a-vco',   type: 'analogVco', position: { x: 60,  y: 200 } },
        { id: 'a-vca',   type: 'vca',       position: { x: 520, y: 200 } },
        { id: 'a-out',   type: 'audioOut',  position: { x: 800, y: 200 } },
      ],
      [
        {
          id: 'e-vco-out',
          from: { nodeId: 'a-vco', portId: 'sine' },
          to:   { nodeId: 'a-out', portId: 'L' },
          sourceType: 'audio',
          targetType: 'audio',
        },
      ],
    );

    await expect(page.locator('.svelte-flow__edge')).toHaveCount(1);
    await expect(page.locator('.svelte-flow__node')).toHaveCount(3);

    const layers = await page.evaluate(() => {
      const edges = document.querySelector('.svelte-flow__edges') as HTMLElement | null;
      const nodes = document.querySelector('.svelte-flow__nodes') as HTMLElement | null;
      if (!edges || !nodes) return null;
      return {
        edgesZ: getComputedStyle(edges).zIndex,
        nodesZ: getComputedStyle(nodes).zIndex,
      };
    });
    expect(layers).not.toBeNull();
    const ez = Number(layers!.edgesZ);
    const nz = Number(layers!.nodesZ);
    expect(
      Number.isFinite(ez) && Number.isFinite(nz),
      `edges=${layers!.edgesZ} nodes=${layers!.nodesZ}`,
    ).toBe(true);
    expect(nz, 'nodes layer must paint above edges layer').toBeGreaterThan(ez);
  });

  test('dragging: layer split is dropped so cables can float over neighbors', async ({ page }) => {
    // Guard rail: cables-in-front-of-cards during drag is intentional UX.
    // If a future agent globally pins cables under cards, this assertion
    // will fail — flagging the drag-time regression before it ships.
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(
      page,
      [
        // Spread wide enough that the rack-sized cards (analogVco is 3u/hp2 =
        // 360px wide) don't overlap — an overlapping neighbor would intercept
        // the pointer over the middle card (#759).
        { id: 'a-vco',   type: 'analogVco', position: { x: 60,  y: 200 } },
        { id: 'a-vca',   type: 'vca',       position: { x: 520, y: 200 } },
        { id: 'a-out',   type: 'audioOut',  position: { x: 800, y: 200 } },
      ],
      [
        {
          id: 'e-vco-out',
          from: { nodeId: 'a-vco', portId: 'sine' },
          to:   { nodeId: 'a-out', portId: 'L' },
          sourceType: 'audio',
          targetType: 'audio',
        },
      ],
    );

    const middle = page.locator('.svelte-flow__node[data-id="a-vca"]');
    await middle.waitFor();
    const box = await middle.boundingBox();
    if (!box) throw new Error('middle node has no bounding box');
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    // Begin a drag without releasing — Svelte Flow toggles `.dragging`
    // on the node wrapper while the pointer is down + moving.
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 40, cy + 40, { steps: 8 });

    try {
      await expect(middle).toHaveClass(/dragging/);

      const layers = await page.evaluate(() => {
        const edges = document.querySelector('.svelte-flow__edges') as HTMLElement | null;
        const nodes = document.querySelector('.svelte-flow__nodes') as HTMLElement | null;
        if (!edges || !nodes) return null;
        return {
          edgesZ: getComputedStyle(edges).zIndex,
          nodesZ: getComputedStyle(nodes).zIndex,
        };
      });

      expect(layers).not.toBeNull();
      // During drag, the :not(:has(.dragging)) guard fails so neither
      // layer carries our explicit z-index — both fall back to xyflow's
      // default `auto`. That's the contract the drag-time UX depends on.
      expect(layers!.edgesZ).toBe('auto');
      expect(layers!.nodesZ).toBe('auto');
    } finally {
      await page.mouse.up();
    }
  });

  test('OUTPUT card root is fully opaque (no cable bleed-through)', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(
      page,
      [
        { id: 'v-lines', type: 'lines',     position: { x: 60,  y: 60 }, domain: 'video' },
        { id: 'v-out',   type: 'videoOut',  position: { x: 600, y: 60 }, domain: 'video' },
      ],
      [
        {
          id: 'e-lines-out',
          from: { nodeId: 'v-lines', portId: 'out' },
          to:   { nodeId: 'v-out',   portId: 'in' },
          sourceType: 'mono-video',
          targetType: 'video',
        },
      ],
    );

    const outCard = page.locator('[data-testid="video-out-card"]');
    await expect(outCard).toBeVisible();

    // The OUTPUT card root must be fully opaque so a cable routed beneath
    // it can never bleed through. We allow either a solid background-color
    // OR a layered background-image — both are opaque under the same
    // contract.
    const opacity = await outCard.evaluate((el) => {
      const cs = getComputedStyle(el);
      const bg = cs.backgroundColor;
      const bgImage = cs.backgroundImage;
      const m = bg.match(/^rgba?\(([^)]+)\)$/);
      let alpha = 1;
      if (m) {
        const parts = m[1].split(',').map((s) => s.trim());
        if (parts.length === 4) alpha = Number(parts[3]);
      }
      return { bg, bgImage, alpha };
    });
    const hasImage = opacity.bgImage && opacity.bgImage !== 'none';
    expect(
      opacity.alpha === 1 || hasImage,
      `OUTPUT card bg must be opaque — got bg=${opacity.bg} bgImage=${opacity.bgImage}`,
    ).toBe(true);
  });
});
