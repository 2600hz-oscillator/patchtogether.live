// e2e/vrt/vrt-aspect-16x9.spec.ts
//
// Dedicated VRT for the OUTPUT aspect switch at 16:9. The default-4:3 baselines
// (the main vrt.spec.ts per-card sweep) are unchanged by this PR — 16:9 is
// opt-in. Here we spawn each canvas-preview card fed a DETERMINISTIC static
// SHAPES source, flip the OUTPUT aspect to 16:9 via the dev __videoAspectStore
// hook, settle, and snapshot the card — proving the in-rack thumbnail
// letterboxes at the LIVE 16:9 aspect (the fitRect → liveEngineAspect fix) and
// the wider 1366×768 engine buffer renders without artifacts.
//
// Determinism: SHAPES at fixed params is a static procedural fill (no time
// term), so the blitted preview is pixel-stable across runs. We settle the
// card layout + a couple of rAF blits before snapshotting.
//
// Informational lane (`task vrt`) — darwin baseline captured locally; linux
// pending a `vrt-update.yml` workflow_dispatch (see EXEMPT_BASELINE_PAIRS →
// linux/aspect16x9-*).
//
// Output: e2e/vrt/__screenshots__/vrt-aspect-16x9.spec.ts/{platform}/<id>.png

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from '../tests/_helpers';
import { EXEMPT_BASELINE_PAIRS } from './vrt-exemptions';
import { pinVrtFonts, awaitVrtFonts } from './_fonts';

const VRT_PLATFORM = process.platform === 'darwin' ? 'darwin' : 'linux';

// A fixed-param SHAPES (a centered triangle) — a static, time-independent
// procedural fill, so the blit is pixel-stable.
const SHAPES_PARAMS = { shape: 2, tile: 0, rotate: 0, zoom: 2.2 };

test.describe.configure({ mode: 'default' });

/** Spawn SHAPES → <sinkType>, flip to 16:9, settle the card box, blit a few
 *  frames, return the card locator. */
async function setup16x9(
  page: Page,
  sinkType: 'videoOut',
  sinkCardClass: string,
): Promise<ReturnType<Page['locator']>> {
  await pinVrtFonts(page);
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  await awaitVrtFonts(page);

  await spawnPatch(
    page,
    [
      { id: 'src', type: 'shapes', position: { x: 40, y: 40 }, domain: 'video', params: SHAPES_PARAMS },
      { id: 'sink', type: sinkType, position: { x: 520, y: 40 }, domain: 'video' },
    ],
    [{ id: 'e1', from: { nodeId: 'src', portId: 'out' }, to: { nodeId: 'sink', portId: 'in' }, sourceType: 'mono-video', targetType: 'video' }],
  );

  const card = page.locator(`.svelte-flow__node-${sinkCardClass}`).first();
  await card.waitFor({ state: 'visible', timeout: 10_000 });

  // Flip the OUTPUT aspect to 16:9 (in-place engine realloc → 1366×768).
  await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__videoAspectStore.set('16:9');
  });
  await expect
    .poll(async () => page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const vid = (window as any).__engine?.()?.getDomain?.('video');
      return vid?.canvas?.width ?? 0;
    }), { timeout: 8000, message: 'engine resized to 16:9' })
    .toBe(1366);

  // Settle: let the card mirror the new engine dims + blit a few frames, then
  // wait for the card box height to stabilise (the broad-text VRT flake guard).
  await page.waitForTimeout(500);
  await card.evaluate(
    (el) =>
      new Promise<void>((resolve) => {
        let lastH = -1;
        let stable = 0;
        const tick = () => {
          const h = Math.round(el.getBoundingClientRect().height);
          if (h === lastH) {
            if (++stable >= 3) return resolve();
          } else {
            stable = 0;
            lastH = h;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
  return card;
}

// OUTPUT fed a STATIC SHAPES triangle → a pixel-stable plain blit, so we diff
// the full card incl. the letterboxed canvas content — proving the in-rack
// thumbnail letterboxes at the live 16:9 aspect. (BENTBOX + B3NTB0X are omitted:
// their CRT/NTSC passes animate every frame regardless of a static source —
// per-line time drift + feedback — so their previews never settle for
// toHaveScreenshot; both are EXEMPT_FROM_VRT at 4:3 for exactly this reason. The
// aspect geometry for the animated sinks is covered functionally by
// e2e/tests/video-aspect-switch.spec.ts + the fitRect unit math.)
const CARDS: Array<{ id: string; sinkType: 'videoOut'; cardClass: string }> = [
  { id: 'aspect16x9-output', sinkType: 'videoOut', cardClass: 'videoOut' },
];

test.describe('VRT: OUTPUT aspect 16:9 — preview cards letterbox at the live aspect', () => {
  for (const c of CARDS) {
    test(`${c.id} card renders at 16:9`, async ({ page }) => {
      test.skip(
        EXEMPT_BASELINE_PAIRS.has(`${VRT_PLATFORM}/${c.id}`),
        `${c.id} on ${VRT_PLATFORM}: baseline pending (see EXEMPT_BASELINE_PAIRS)`,
      );
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });

      const card = await setup16x9(page, c.sinkType, c.cardClass);
      await expect(card).toHaveScreenshot(`${c.id}.png`, { maskColor: '#ff00ff' });

      expect(
        errors.filter((e) => !e.includes('AudioContext')),
        'no console / page errors',
      ).toEqual([]);
    });
  }
});
