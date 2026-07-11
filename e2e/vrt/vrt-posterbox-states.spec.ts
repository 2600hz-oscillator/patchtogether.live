// e2e/vrt/vrt-posterbox-states.spec.ts
//
// COMPOSITE-STATE VRTs for POSTERBOX (retro palette-crush video processor).
//
// The per-card sweep (vrt.spec.ts) locks the card at its DEFAULT state only
// (DEPTH 3-3-2 / DITHER 0 / MIX 1); these scenes lock the card at the three
// signature corners of the control space — a Fader regression (value
// readout, discrete DEPTH tick mapping, extreme positions), a params→card
// wiring break, or a DEPTH-readout regression ("1-bit · 8 COL" vs "5-6-5 ·
// 65536 COL") is caught as pixels. Same category as the KARPLUS/TOM DRUM
// state scenes (vrt-karplus-tomtom-states.spec.ts).
//
// The live OUT preview canvas is MASKED (same as the module's default-card
// entry in VRT_MODULE_MASKS) — the deterministic chrome is the gate; the
// pixel correctness of each state is proven by posterbox.test.ts (CPU
// mirror) + e2e/tests/posterbox-functional.spec.ts (readPixels probes).
// Height-stability settle loop guards the ±1 px text-raster flake
// (memory: vrt-flake-1px-layout-rounding).
//
// Informational lane (`task vrt`). Darwin baselines captured locally; linux
// pending a `vrt-update.yml` workflow_dispatch on the PR branch — gated via
// EXEMPT_BASELINE_PAIRS + the linux-deficit ratchet, exactly like the
// module's default card (the darwin-first new-module pattern).
//
// Output: e2e/vrt/__screenshots__/vrt-posterbox-states.spec.ts/{platform}/<id>.png

import { test, expect } from '@playwright/test';
import { spawnPatch } from '../tests/_helpers';
import { EXEMPT_BASELINE_PAIRS } from './vrt-exemptions';

const VRT_PLATFORM = process.platform === 'darwin' ? 'darwin' : 'linux';

test.describe.configure({ mode: 'default' });

interface StateScene {
  id: string;
  blurb: string;
  params: Record<string, number>;
}

const SCENES: StateScene[] = [
  {
    id: 'posterbox-brutal-1bit',
    blurb:
      'The brutal floor of the DEPTH ladder: 1-1-1 (8 colours), hard bands, ' +
      'full crush. Locks the discrete DEPTH fader at its bottom tick + the ' +
      '"1-bit · 8 COL" readout.',
    params: { depth: 0, dither: 0, mix: 1 },
  },
  {
    id: 'posterbox-dither-hatch',
    blurb:
      'The retro cross-hatch state: 2-2-2 (EGA 64) with DITHER maxed — the ' +
      'Bayer companion look. Locks DITHER at its top against a non-default ' +
      'DEPTH tick + the "2-2-2 · 64 COL" readout.',
    params: { depth: 1, dither: 1, mix: 1 },
  },
  {
    id: 'posterbox-subtle-565',
    blurb:
      'The subtle ceiling: 5-6-5 (RGB565 hi-colour) at half MIX — the ' +
      '"barely there" end of the same knob set. Locks the DEPTH fader at ' +
      'its top tick, MIX mid-travel + the "5-6-5 · 65536 COL" readout.',
    params: { depth: 4, dither: 0, mix: 0.5 },
  },
];

test.describe('VRT: POSTERBOX composite states', () => {
  for (const scene of SCENES) {
    test(`${scene.id} matches baseline`, async ({ page }) => {
      test.skip(
        EXEMPT_BASELINE_PAIRS.has(`${VRT_PLATFORM}/${scene.id}`),
        `${scene.id} on ${VRT_PLATFORM}: baseline pending (see EXEMPT_BASELINE_PAIRS)`,
      );

      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });

      await page.goto('/rack');
      await page.waitForLoadState('networkidle');

      await spawnPatch(page, [
        {
          id: 'crush',
          type: 'posterbox',
          position: { x: 80, y: 80 },
          domain: 'video',
          params: scene.params,
        },
      ]);

      const card = page.locator('.svelte-flow__node-posterbox').first();
      await card.waitFor({ state: 'visible', timeout: 15_000 });

      // Height-stability settle: text-row raster determinism (the ±1 px
      // layout-rounding flake class — see vrt.spec.ts / the memory note).
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

      // Suspend the AudioContext (house belt-and-braces before capture).
      await page.evaluate(async () => {
        const w = globalThis as unknown as { __engine?: () => { ctx: AudioContext } | null };
        const eng = w.__engine?.();
        if (eng) {
          try {
            await eng.ctx.suspend();
          } catch {
            /* already suspended */
          }
        }
      });
      await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));

      // MASK the live OUT preview canvas — the unpatched module renders a
      // black frame, but the blit loop is engine-clock-timed; the chrome
      // (faders, ticks, DEPTH readout, PatchPanel) is the deterministic gate.
      await expect(card).toHaveScreenshot(`${scene.id}.png`, {
        mask: [card.locator('canvas')],
        maskColor: '#ff00ff',
      });

      expect(
        errors.filter((e) => !e.includes('AudioContext')),
        `${scene.id}: no console / page errors`,
      ).toEqual([]);
    });
  }
});
