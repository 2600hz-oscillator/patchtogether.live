// e2e/vrt/vrt-annotated.spec.ts
//
// Numbered-control DEVICE-FACE generator for the docs-overhaul "numbered face"
// section (.myrobots/plans/docs-overhaul-plan-2026-06-23.md §4a).
//
// Reuses the VRT card harness (spawn / settle / font-pin from vrt.spec.ts) to
// render each module card deterministically, injects a TRANSIENT numbered SVG
// overlay (annotate-controls.ts), screenshots the annotated face to
//   e2e/vrt/__annotated__/{platform}/{type}.png
// and emits the number→control legend to
//   e2e/vrt/__annotated__/{type}.legend.json
// which the doc page (/docs/modules/[id]) renders as the legend table beside
// the numbered face.
//
// SCOPE (Phase-1 infra proof): this generates the annotated face for the
// modules listed in ANNOTATED_MODULES below — a small sample (adsr / sequencer
// / fader) that exercises the pipeline. Phase 2 (content) widens the list /
// drives it off the registry. The legend JSON join to ParamDef labels comes
// from the schemaVersion-2 registry manifest (REGISTRY.params), so the legend
// shows "1  attack  fader" without re-deriving labels here.
//
// This spec lives in e2e/vrt/ (NOT e2e/tests/), so it is OUTSIDE the WebGL
// heavy-attest basis (webgl-heavy-globs.ts scans e2e/tests/*.spec.ts only) —
// no real-GPU re-attest is triggered by adding it.

import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnPatch } from '../tests/_helpers';
import { REGISTRY } from '../tests/_registry';
import { pinVrtFonts, awaitVrtFonts } from './_fonts';
import { annotateControlsOnCard, removeControlOverlay } from './annotate-controls';

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

test.describe('VRT-annotated: numbered control device-faces', () => {
  for (const type of ANNOTATED_MODULES) {
    const mod = REGISTRY.find((m) => m.type === type)!;

    test(`${type} annotated face + legend`, async ({ page }) => {
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

      // Inject the numbered overlay; capture the number→control map.
      const entries = await annotateControlsOnCard(card);
      expect(entries.length, `${type}: at least one numbered control`).toBeGreaterThan(0);

      // Snap the annotated face. This baseline is a DOC ASSET (committed under
      // __annotated__/), NOT a VRT regression baseline, so we don't diff it
      // here — `--update-snapshots` writes it and the doc build serves it.
      await expect(card).toHaveScreenshot(`${type}.png`, {
        animations: 'disabled',
      });

      await removeControlOverlay(card);

      // Join each control to its ParamDef label from the registry manifest so
      // the legend reads "1  attack  fader". A `control-<paramId>` testid maps
      // straight to the param id; anything else keeps its raw key.
      const legend = entries.map((e) => {
        const paramId = e.testid.startsWith('control-')
          ? e.testid.slice('control-'.length)
          : undefined;
        const param = paramId ? mod.params.find((p) => p.id === paramId) : undefined;
        return {
          n: e.n,
          testid: e.testid,
          kind: e.kind,
          label: param?.label ?? paramId ?? e.testid,
          ...(param?.units ? { units: param.units } : {}),
        };
      });

      const legendPath = resolve(annotatedDir(), `${type}.legend.json`);
      mkdirSync(dirname(legendPath), { recursive: true });
      writeFileSync(
        legendPath,
        JSON.stringify({ type, platform: VRT_PLATFORM, controls: legend }, null, 2) + '\n',
        'utf8',
      );

      expect(errors, `${type}: no console / page errors`).toEqual([]);
    });
  }
});
