// e2e/vrt/vrt.spec.ts
//
// Visual Regression Test suite. One test per registered module type.
// Spawns the module via the dev __ydoc/__patch globals, waits for first
// paint, screenshots the card element, asserts byte-equal (under the
// tolerance budget set in vrt.config.ts) against the committed baseline.
//
// Why iterate at module-load time, not via test.describe.each at runtime:
//   Playwright resolves the test list at file-parse time. We can't await
//   page.evaluate() before declaring tests, so the module list is a
//   compile-time constant mirroring io-spec-consistency.spec.ts. The
//   vrt-meta vitest test in packages/web asserts this list stays in sync
//   with the registry — drift fails fast in the unit pass, well before
//   anyone burns a CI minute on Playwright.

import { test, expect } from '@playwright/test';
import { spawnPatch } from '../tests/_helpers';

// Mirror of e2e/tests/io-spec-consistency.spec.ts MODULE_TYPES. Two
// modules are intentionally absent here:
//   - cameraInput: needs a real (or fake) MediaStream + getUserMedia
//     permission. The flag --use-fake-device-for-media-stream from the
//     main e2e playwright config isn't applied to the VRT project, and
//     adding it would bake the synthetic-camera frame into the baseline.
//     Cover CAMERA via its dedicated functional spec instead.
//   - videoOut / audioOut: kept; they render a deterministic, animation-free
//     card body. The audio-out level meter freezes at 0 with no input.
interface VrtModule {
  type: string;
  domain: 'audio' | 'video' | 'meta';
  /** Pixels on the card whose contents are inherently non-deterministic
   *  (free-running canvas viz, scope sweep, etc.). When set, Playwright
   *  fills these rects with a uniform colour in both baseline + actual
   *  before diffing, so the static chrome around them still asserts. */
  mask?: { selector: string }[];
}

const MODULES: VrtModule[] = [
  // ----- audio domain -----
  { type: 'analogVco', domain: 'audio' },
  { type: 'audioOut', domain: 'audio' },
  { type: 'vca', domain: 'audio' },
  { type: 'mixer', domain: 'audio' },
  { type: 'adsr', domain: 'audio' },
  { type: 'filter', domain: 'audio' },
  { type: 'reverb', domain: 'audio' },
  // SCOPE shows a free-running waveform when sampleRate is non-zero —
  // mask the canvas. The header + knobs + ports around it still diff.
  { type: 'scope', domain: 'audio', mask: [{ selector: 'canvas' }] },
  { type: 'sequencer', domain: 'audio' },
  { type: 'wavetableVco', domain: 'audio' },
  { type: 'lfo', domain: 'audio' },
  { type: 'cartesian', domain: 'audio' },
  { type: 'destroy', domain: 'audio' },
  { type: 'qbrt', domain: 'audio' },
  { type: 'drummergirl', domain: 'audio' },
  { type: 'meowbox', domain: 'audio' },
  { type: 'mixmstrs', domain: 'audio' },
  { type: 'timelorde', domain: 'audio' },
  { type: 'charlottesEchos', domain: 'audio' },
  { type: 'riotgirls', domain: 'audio' },
  { type: 'score', domain: 'audio' },
  { type: 'drumseqz', domain: 'audio' },
  { type: 'polyseqz', domain: 'audio' },
  // VIZVCO / WAVVIZ / SWOLEVCO carry a video-out preview canvas — mask it.
  { type: 'vizvco', domain: 'audio', mask: [{ selector: 'canvas' }] },
  { type: 'wavviz', domain: 'audio', mask: [{ selector: 'canvas' }] },
  { type: 'swolevco', domain: 'audio', mask: [{ selector: 'canvas' }] },
  { type: 'illogic', domain: 'audio' },
  { type: 'unityscalemathematik', domain: 'audio' },
  { type: 'dx7', domain: 'audio' },
  { type: 'noise', domain: 'audio' },
  { type: 'buggles', domain: 'audio' },
  // WAVECEL has a 3D wavetable viz canvas.
  { type: 'wavecel', domain: 'audio', mask: [{ selector: 'canvas' }] },
  // WARRENSPECTRUM has the acidwarp video viz canvas.
  { type: 'warrenspectrum', domain: 'audio', mask: [{ selector: 'canvas' }] },
  { type: 'stereovca', domain: 'audio' },
  // ----- video domain -----
  // Every video module renders a preview canvas. Mask it; assert the
  // chrome (title, ports, knobs).
  { type: 'lines', domain: 'video', mask: [{ selector: 'canvas' }] },
  { type: 'videoOut', domain: 'video', mask: [{ selector: 'canvas' }] },
  { type: 'inwards', domain: 'video', mask: [{ selector: 'canvas' }] },
  { type: 'picturebox', domain: 'video', mask: [{ selector: 'canvas' }] },
  { type: 'destructor', domain: 'video', mask: [{ selector: 'canvas' }] },
  { type: 'chroma', domain: 'video', mask: [{ selector: 'canvas' }] },
  { type: 'luma', domain: 'video', mask: [{ selector: 'canvas' }] },
  { type: 'colorizer', domain: 'video', mask: [{ selector: 'canvas' }] },
  { type: 'feedback', domain: 'video', mask: [{ selector: 'canvas' }] },
  { type: 'videoMixer', domain: 'video', mask: [{ selector: 'canvas' }] },
  { type: 'shapes', domain: 'video', mask: [{ selector: 'canvas' }] },
  { type: 'monoglitch', domain: 'video', mask: [{ selector: 'canvas' }] },
  { type: 'ruttetra', domain: 'video', mask: [{ selector: 'canvas' }] },
  { type: 'shapedramps', domain: 'video', mask: [{ selector: 'canvas' }] },
  { type: 'vdelay', domain: 'video', mask: [{ selector: 'canvas' }] },
  // ----- meta domain -----
  // STICKY — paper-style sticky note (no engine binding). Default size +
  // empty textarea render deterministically.
  { type: 'sticky', domain: 'meta' },
];

// 'default' mode = independent tests; one failing doesn't skip the rest.
// We keep workers: 1 in vrt.config.ts so paint-timing variability still
// stays bounded, but unlike 'serial' we get a full report of every drifted
// baseline in one CI run instead of bisecting them one-at-a-time.
test.describe.configure({ mode: 'default' });

test.describe('VRT: every module card matches its baseline', () => {
  for (const mod of MODULES) {
    test(`${mod.type} card matches baseline`, async ({ page }) => {
      // Capture page errors so a broken card fails the test before the
      // screenshot diff does — easier to debug than a thousand-pixel diff.
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });

      await page.goto('/');
      await page.waitForLoadState('networkidle');

      await spawnPatch(page, [
        {
          id: 'vrt-1',
          type: mod.type,
          position: { x: 80, y: 80 },
          domain: mod.domain,
        },
      ]);

      const card = page.locator(`.svelte-flow__node-${mod.type}`).first();
      await card.waitFor({ state: 'visible', timeout: 10_000 });

      // Settle: wait one rAF tick after the card mounts so any one-frame
      // post-mount layout shift (Svelte $effect fires async to DOM
      // attach) is done before we snap.
      await page.evaluate(
        () => new Promise<void>((r) => requestAnimationFrame(() => r())),
      );

      // Resolve the masking rects on the actual rendered card.
      const maskLocators = (mod.mask ?? []).map((m) =>
        card.locator(m.selector),
      );

      await expect(card).toHaveScreenshot(`${mod.type}.png`, {
        // Mask non-deterministic regions (canvases, scope sweep, etc.)
        // — Playwright fills them with maskColor in both baseline +
        // actual before diffing.
        mask: maskLocators,
        maskColor: '#ff00ff',
        // Animations frozen by config-level expect.toHaveScreenshot.
      });

      expect(errors, `${mod.type}: no console / page errors`).toEqual([]);
    });
  }
});
