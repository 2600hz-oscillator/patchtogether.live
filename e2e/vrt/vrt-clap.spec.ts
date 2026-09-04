// e2e/vrt/vrt-clap.spec.ts
//
// Composite-state VRT for CLAP — the card captured at three
// SONICALLY-DISTINCT non-default settings (the vrt-quadralogical per-state
// pattern, minus the WebGL freeze machinery: the clap card is pure
// deterministic fader chrome, no canvas, so a spawn + settle is
// pixel-stable by construction).
//
// Why this exists on top of the default vrt.spec.ts card baseline: the
// default baseline locks the card at SHIPPING DEFAULTS only — every fader
// at its default position. These three scenes park every one of the nine
// faders at a clearly DIFFERENT position per scene (the three corners the
// DSP sonic-range proofs pin: 909-dense / linn-room / dry-snap), so the
// param→fader-position render path is regression-locked across the
// control ranges, not just at the defaults.
//
//   clap-909-dense — 5 fast bright pulses, white noise, burst-forward,
//                    driven hot (the TR-909 machine clap).
//   clap-linn-room — 2 slow pulses, dark noise, room-dominant, long tail
//                    (the LinnDrum-era dark room clap).
//   clap-dry-snap  — 4 pulses, narrow ringy filter, tail off, snap full,
//                    max drive (the bone-dry tuned machine burst).
//
// Informational lane (`task vrt`). Audio-only card, no WebGL — negligible CI
// cost.
// Baselines are authored by LINUX CI — one set, no {platform} segment (see
// vrt.config.ts). `task vrt:commit` dispatches the capture; a local macOS run
// is a smoke test, not a capture.
//
// Output: e2e/vrt/__screenshots__/vrt-clap.spec.ts/<id>.png

import { test, expect } from '@playwright/test';
import { spawnPatch } from '../tests/_helpers';
import { pinVrtFonts, awaitVrtFonts } from './_fonts';

test.describe.configure({ mode: 'default' });

interface ClapScene {
  id: string;
  params: Record<string, number>;
}

// Every fader lands at a clearly different position in each scene (and
// away from its default), so a param→fader regression on ANY knob flips
// at least one baseline.
const SCENES: ClapScene[] = [
  {
    id: 'clap-909-dense',
    params: { pulses: 5, spread: 5, snap: 0.85, tone: 2400, width: 0.8, color: 0, tail: 60, drive: 0.6, level: 3 },
  },
  {
    id: 'clap-linn-room',
    params: { pulses: 2, spread: 22, snap: 0.2, tone: 550, width: 0.3, color: 0.9, tail: 650, drive: 0, level: -6 },
  },
  {
    id: 'clap-dry-snap',
    params: { pulses: 4, spread: 8, snap: 1, tone: 1400, width: 0.1, color: 0.3, tail: 30, drive: 1, level: 6 },
  },
];

test.describe('VRT: CLAP composite control states', () => {
  for (const scene of SCENES) {
    test(`${scene.id} matches baseline`, async ({ page }) => {

      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));

      // Pin the bundled Inter/JetBrains Mono BEFORE the first navigation and
      // await their decode after load — the app resolves card text through
      // GENERIC stacks (system-ui / ui-monospace) that fontconfig picks
      // nondeterministically, and document.fonts.ready can't see them. Without
      // this the captured text metrics differ run-to-run and platform-to-platform.
      // Full root cause: e2e/vrt/_fonts.ts.
      await pinVrtFonts(page);
      await page.goto('/rack?seed=none');
      await page.waitForLoadState('networkidle');
      await awaitVrtFonts(page);

      await spawnPatch(
        page,
        [
          { id: 'vrt-clap', type: 'clap', position: { x: 120, y: 80 }, domain: 'audio', params: scene.params },
        ],
        [],
      );

      const card = page.locator('.svelte-flow__node-clap').first();
      await card.waitFor({ state: 'visible', timeout: 15_000 });
      // The faders poll readLive each rAF; give the card a couple of frames
      // to settle on the spawned param values before snapping.
      for (let i = 0; i < 3; i++) {
        await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
      }
      await page.waitForTimeout(150);

      await expect(card).toHaveScreenshot(`${scene.id}.png`, {
        maskColor: '#ff00ff',
      });
      expect(errors, `page errors during ${scene.id}: ${errors.join('; ')}`).toEqual([]);
    });
  }
});
