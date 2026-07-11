// e2e/vrt/vrt-tidy-vco.spec.ts
//
// Composite-state VRT for TIDY VCO — the card captured at three
// SONICALLY-DISTINCT non-default settings (the vrt-clap per-state
// pattern: pure deterministic fader chrome, no canvas, so a spawn +
// settle is pixel-stable by construction).
//
// Why this exists on top of the default vrt.spec.ts card baseline: the
// default baseline locks the card at SHIPPING DEFAULTS only — every fader
// at its default position. These three scenes park all 22 faders + the
// HOLD pad at clearly DIFFERENT positions per scene (three corners the
// DSP sonic-range proofs pin: acid squelch / lush pad / unison bass), so
// the param→fader-position render path is regression-locked across the
// control ranges, not just at the defaults. The acid scene also latches
// HOLD=1, locking the pad's held styling.
//
//   tidyvco-acid   — narrow pulse, deep squelch just under self-osc, hot
//                    drive, plucky filter EG, HOLD latched (the 303 drone).
//   tidyvco-pad    — detuned saw/pulse pair an octave apart, slow EGs,
//                    full width (the lush stereo pad).
//   tidyvco-bass   — dark tracked filter, heavy sub, tight EGs, unison
//                    width (the mono-unison bass stab).
//
// Informational lane (`task vrt`) — darwin baselines captured locally;
// linux needs a `vrt-update.yml` workflow_dispatch (the
// EXEMPT_BASELINE_PAIRS gate in vrt-exemptions.ts skips linux until that
// runs). Audio-only card, no WebGL — negligible CI cost.
//
// Output: e2e/vrt/__screenshots__/vrt-tidy-vco.spec.ts/{platform}/<id>.png

import { test, expect } from '@playwright/test';
import { spawnPatch } from '../tests/_helpers';
import { EXEMPT_BASELINE_PAIRS } from './vrt-exemptions';

const VRT_PLATFORM = process.platform === 'darwin' ? 'darwin' : 'linux';

test.describe.configure({ mode: 'default' });

interface TidyVcoScene {
  id: string;
  params: Record<string, number>;
}

// Every fader lands at a clearly different position in each scene (and
// away from its default), so a param→fader regression on ANY knob flips
// at least one baseline.
const SCENES: TidyVcoScene[] = [
  {
    id: 'tidyvco-acid',
    params: {
      shape1: 1, shape2: 0.8, pw: 0.12, detune: -12, oct2: 0, mix: 0.2, sub: 0.5,
      cutoff: 700, res: 0.92, drive: 0.8, env: 0.9, track: 0.7,
      fatk: 0.001, fdec: 0.18, fsus: 0, frel: 0.08,
      atk: 0.001, dec: 0.4, sus: 0.35, rel: 0.08,
      width: 0.2, level: 3, hold: 1,
    },
  },
  {
    id: 'tidyvco-pad',
    params: {
      shape1: 0.3, shape2: 1, pw: 0.35, detune: 18, oct2: -1, mix: 0.6, sub: 0.25,
      cutoff: 2500, res: 0.15, drive: 0.1, env: 0.3, track: 0.2,
      fatk: 1.2, fdec: 2, fsus: 0.7, frel: 1.5,
      atk: 0.8, dec: 1, sus: 1, rel: 2.5,
      width: 1, level: -6, hold: 0,
    },
  },
  {
    id: 'tidyvco-bass',
    params: {
      shape1: 0.6, shape2: 0.4, pw: 0.25, detune: 30, oct2: 1, mix: 0.4, sub: 0.85,
      cutoff: 300, res: 0.55, drive: 0.5, env: -0.4, track: 1,
      fatk: 0.02, fdec: 0.08, fsus: 0.45, frel: 0.5,
      atk: 0.01, dec: 0.12, sus: 0.55, rel: 0.4,
      width: 0.7, level: 6, hold: 0,
    },
  },
];

test.describe('VRT: TIDY VCO composite control states', () => {
  for (const scene of SCENES) {
    test(`${scene.id} matches baseline`, async ({ page }) => {
      test.skip(
        EXEMPT_BASELINE_PAIRS.has(`${VRT_PLATFORM}/${scene.id}`),
        `${scene.id} on ${VRT_PLATFORM}: baseline pending (see EXEMPT_BASELINE_PAIRS)`,
      );

      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));

      await page.goto('/rack');
      await page.waitForLoadState('networkidle');

      await spawnPatch(
        page,
        [
          {
            id: 'vrt-tidyvco',
            type: 'tidyVco',
            position: { x: 120, y: 80 },
            domain: 'audio',
            params: scene.params,
          },
        ],
        [],
      );

      const card = page.locator('.svelte-flow__node-tidyVco').first();
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
