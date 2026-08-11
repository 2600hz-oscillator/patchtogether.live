// e2e/vrt/vrt-legacy-mask-audit.spec.ts
//
// MEASUREMENT TOOL, not a gate. `VRT_PROBE=1` only, so it costs CI nothing.
//
// Enumerates the LIVE entries of `VRT_MODULE_MASKS` — the PRE-REGISTRY canvas-
// mask table — and prints, for each, how much of the card the mask actually
// deletes. Those masks carry NO companion: the module is free to render
// nothing at all and still pass forever, which is the precise vacuous-
// assertion class the live-surface registry exists to close.
//
// A count is not a size, which is why `LEGACY_UNCOMPANIONED_MASK_CEILING` was
// deleted (2026-08-10): it knew there were twelve and could not tell anyone
// whether they were 3 % slivers or half-cards. What replaced it is a REQUIRED
// `MaskRect.why` naming the cause, gated in vrt-live-surfaces.test.ts. This
// spec prints the SIZE — run it whenever a `why` claims a mask is small.
//
//   VRT_PROBE=1 npx playwright test --config=vrt/vrt.config.ts \
//     vrt-legacy-mask-audit
//
// Output, one line per masked element, greppable:
//   [legacy-mask] type=<module> sel=<selector> n=<count> \
//     card=WxH mask=WxH area=<fraction>

import { test } from '@playwright/test';
import { spawnPatch } from '../tests/_helpers';
import { REGISTRY } from '../tests/_registry';
import { VRT_MODULE_MASKS, EXEMPT_FROM_VRT } from './vrt-exemptions';
import { VRT_SCENES, applyVrtScene } from './vrt-scenes';
import { pinVrtFonts, awaitVrtFonts } from './_fonts';

/** The subset vrt.spec.ts ACTUALLY applies: a module that is exempt from VRT
 *  never runs, and a module with a VRT_SCENES entry has its legacy mask
 *  dropped at capture time. Mirrors `liveLegacyMaskTypes()` in the guard. */
const LIVE_LEGACY = Object.keys(VRT_MODULE_MASKS).filter(
  (t) => !(t in EXEMPT_FROM_VRT) && !(t in VRT_SCENES),
);

test.describe.configure({ mode: 'default' });

test('legacy uncompanioned mask audit', async ({ page }) => {
  test.setTimeout(300_000);
  // eslint-disable-next-line no-console
  console.log(`[legacy-mask] ${LIVE_LEGACY.length} live entries: ${LIVE_LEGACY.join(', ')}`);

  for (const type of LIVE_LEGACY) {
    const mod = REGISTRY.find((m) => m.type === type);
    if (!mod) {
      // eslint-disable-next-line no-console
      console.log(`[legacy-mask] type=${type} NOT IN REGISTRY (dead table entry)`);
      continue;
    }
    await pinVrtFonts(page);
    await page.goto('/rack?shell=legacy&seed=none');
    await page.waitForLoadState('networkidle');
    await awaitVrtFonts(page);
    await page.addStyleTag({
      content:
        '.svelte-flow__minimap,.svelte-flow__controls,.svelte-flow__attribution{display:none !important;}',
    });
    const used = await applyVrtScene(page, type);
    if (!used) {
      await spawnPatch(page, [
        { id: 'vrt-1', type, position: { x: 80, y: 80 }, domain: mod.domain },
      ]);
    }
    const card = page.locator(`.svelte-flow__node-${type}`).first();
    try {
      await card.waitFor({ state: 'visible', timeout: 10_000 });
    } catch {
      // eslint-disable-next-line no-console
      console.log(`[legacy-mask] type=${type} CARD DID NOT MOUNT`);
      continue;
    }
    // Height-settle, same as the real capture path, so the card box is the one
    // the mask fraction is actually computed against.
    await card.evaluate(
      (el) =>
        new Promise<void>((resolve) => {
          let lastH = -1;
          let stable = 0;
          const tick = (): void => {
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

    for (const rect of VRT_MODULE_MASKS[type] ?? []) {
      const m = await card.evaluate(
        (el, sel) => {
          const cr = el.getBoundingClientRect();
          const els = Array.from(el.querySelectorAll(sel));
          const boxes = els.map((e) => {
            const r = e.getBoundingClientRect();
            return { w: r.width, h: r.height };
          });
          const masked = boxes.reduce((a, b) => a + b.w * b.h, 0);
          return {
            n: els.length,
            card: { w: cr.width, h: cr.height },
            boxes,
            area: cr.width * cr.height > 0 ? masked / (cr.width * cr.height) : 0,
          };
        },
        rect.selector,
      );
      const dims = m.boxes.map((b) => `${Math.round(b.w)}x${Math.round(b.h)}`).join('+');
      // eslint-disable-next-line no-console
      console.log(
        `[legacy-mask] type=${type} sel="${rect.selector}" n=${m.n} ` +
          `card=${Math.round(m.card.w)}x${Math.round(m.card.h)} ` +
          `mask=${dims || '(none)'} area=${(m.area * 100).toFixed(1)}%`,
      );
    }
  }
});
