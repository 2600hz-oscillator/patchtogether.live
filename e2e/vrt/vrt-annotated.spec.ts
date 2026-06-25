// e2e/vrt/vrt-annotated.spec.ts
//
// CLEAN card-FACE generator for the docs site (/docs/modules/[id]).
//
// Reuses the VRT card harness (spawn / settle / font-pin from vrt.spec.ts) to
// render each module card deterministically and screenshots a CLEAN device face
// (no overlay) to
//   e2e/vrt/__annotated__/{platform}/{type}.png
// which the doc page renders as the card visual. (The old numbered-overlay +
// testid `{type}.legend.json` were removed — the doc page now documents every
// control from the authored, drift-gated `docs.controls`, not a raw-testid
// legend.)
//
// SCOPE: generates faces for the modules in ANNOTATED_MODULES below — a small
// sample (adsr / lfo / sequencer). Override with ANNOTATED_MODULES="adsr,lfo"
// to regenerate a subset locally.
//
// This spec lives in e2e/vrt/ (NOT e2e/tests/), so it is OUTSIDE the WebGL
// heavy-attest basis (webgl-heavy-globs.ts scans e2e/tests/*.spec.ts only) —
// no real-GPU re-attest is triggered by adding it.

import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnPatch } from '../tests/_helpers';
import { REGISTRY } from '../tests/_registry';
import { pinVrtFonts, awaitVrtFonts } from './_fonts';

const VRT_PLATFORM = process.platform === 'darwin' ? 'darwin' : 'linux';

// Phase-1 sample set — proves the pipeline end-to-end across a knob/fader
// utility (adsr), a knob modulation module (lfo), and a numbered-step
// sequencer (sequencer). Override with ANNOTATED_MODULES="adsr,lfo" to
// regenerate a subset locally; Phase 2 drives the full registry.
const DEFAULT_SAMPLE = ['adsr', 'lfo', 'sequencer'];
const ANNOTATED_MODULES = (process.env.ANNOTATED_MODULES
  ? process.env.ANNOTATED_MODULES.split(',').map((s) => s.trim()).filter(Boolean)
  : DEFAULT_SAMPLE
).filter((type) => REGISTRY.some((m) => m.type === type));

/** Repo-root-relative output dir for the committed annotated faces + legends. */
function annotatedDir(): string {
  // This file: e2e/vrt/vrt-annotated.spec.ts → repo root is two hops up.
  return resolve(import.meta.dirname, '..', '..', 'e2e', 'vrt', '__annotated__');
}

test.describe.configure({ mode: 'default' });

test.describe('VRT card-faces: clean card screenshots for the docs site', () => {
  for (const type of ANNOTATED_MODULES) {
    const mod = REGISTRY.find((m) => m.type === type)!;

    test(`${type} card face`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });

      // Deterministic fonts + viewport (same as vrt.spec.ts).
      await pinVrtFonts(page);
      await page.goto('/');
      await page.waitForLoadState('networkidle');
      await awaitVrtFonts(page);
      await page.addStyleTag({
        content:
          '.svelte-flow__minimap,.svelte-flow__controls,.svelte-flow__attribution{display:none !important;}',
      });

      await spawnPatch(page, [
        { id: 'annot-1', type, position: { x: 80, y: 80 }, domain: mod.domain },
      ]);

      const card = page.locator(`.svelte-flow__node-${type}`).first();
      await card.waitFor({ state: 'visible', timeout: 10_000 });

      // Height-settle loop (identical to vrt.spec.ts) so boundingBox() reads a
      // stable layout before we measure control positions + snap.
      await card.evaluate(
        (el) =>
          new Promise<void>((res) => {
            let lastH = -1;
            let stable = 0;
            const tick = () => {
              const h = Math.round(el.getBoundingClientRect().height);
              if (h === lastH) {
                if (++stable >= 3) return res();
              } else {
                stable = 0;
                lastH = h;
              }
              requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          }),
      );

      // Snap the CLEAN card face. This is a generated DOC ASSET, NOT a VRT
      // regression baseline, so we WRITE it unconditionally with a plain
      // element screenshot. (Do NOT use toHaveScreenshot here: even with
      // --update-snapshots it only rewrites the file when the new render
      // differs from the old one beyond the comparator tolerance — and the
      // doc-asset config is deliberately lenient [maxDiffPixelRatio 0.1], so a
      // small render change stays under tolerance and the committed PNG
      // silently never updates.)
      const facePath = resolve(annotatedDir(), VRT_PLATFORM, `${type}.png`);
      mkdirSync(dirname(facePath), { recursive: true });
      await card.screenshot({ path: facePath, animations: 'disabled' });

      expect(errors, `${type}: no console / page errors`).toEqual([]);
    });
  }
});
