// per-module-per-port-handles.spec.ts
//
// SPLIT from per-module-per-port.spec.ts (#1538). That file was 3,370 CPU-s —
// 1.74x a whole balanced shard's budget — so no cost-based scheduler could
// place it. Splitting at its three existing top-level `test.describe`s makes a
// balanced partition possible; the shared prelude moved verbatim to
// `_per-module-per-port-shared.ts`. No test logic changed.
//
// Measured cost of this dimension: 703.9 s / 196 tests

import { test, expect } from '@playwright/test';
import {
  REGISTRY,
  SKIP_SPAWN,
  freezeVideoRender,
  spawnSolo,
  touchesVideo,
} from './_per-module-per-port-shared';

test.describe.configure({ mode: 'parallel' });

test.describe('per-module per-port: handle presence', () => {
  for (const mod of REGISTRY) {
    const skipReason = SKIP_SPAWN[mod.type];
    const title = `${mod.type}: every declared input + output renders as a handle`;
    if (skipReason) {
      test.fixme(`${title} [SKIPPED: ${skipReason}]`, () => {});
      continue;
    }
    test(title, async ({ page }) => {
      // Suppress the heavy per-frame video GL render for the whole iteration.
      // This sweep asserts only DOM-level handle presence; the engine still
      // mounts the card (shaders compiled, FBOs allocated → handles render),
      // it just skips the (SwiftShader-bound) per-frame draw passes that
      // otherwise dominate the wall-time of heavy WebGL cards. See
      // VideoEngine.step()'s __videoEngineFreezeRender branch. No-op for
      // non-video modules (only the video engine reads the flag). Keyed on
      // touchesVideo (any video port), NOT domain — so audio-domain modules
      // with a GL viewport (WAVESCULPT) also skip the per-frame draw.
      if (touchesVideo(mod)) await freezeVideoRender(page);

      await page.goto('/rack?shell=legacy&seed=none');

      await spawnSolo(page, mod);

      const card = page.locator(`.svelte-flow__node-${mod.type}`);
      await expect(card, `${mod.type} card visible`).toBeVisible();

      // Partition rendered handles into inputs (target) vs outputs (source).
      // SOME modules (sequencer, score) declare an input AND an output with
      // the SAME id ("clock" for both) — `[data-handleid="clock"]` matches
      // BOTH, so we can't assert .toHaveCount(1) per id without first
      // separating by Svelte Flow's source/target class. Same partition as
      // io-spec-consistency.spec.ts.
      const rendered = await card.locator('.svelte-flow__handle').evaluateAll((els) => {
        const inputs: string[] = [];
        const outputs: string[] = [];
        for (const el of els) {
          const id = el.getAttribute('data-handleid');
          if (!id) continue;
          const cls = el.getAttribute('class') ?? '';
          if (cls.includes('source')) outputs.push(id);
          else inputs.push(id); // 'target' or unspecified
        }
        return { inputs, outputs };
      });
      const renderedInputs = new Set(rendered.inputs);
      const renderedOutputs = new Set(rendered.outputs);

      // Per-port pinpoint assertion so failure messages name the offending
      // port directly (rather than "expected 27 handles, got 26"). This is
      // the regression net for the DOOM PR #393 class: drop a port from the
      // def, this test fails by name.
      for (const port of mod.inputs) {
        expect(
          renderedInputs.has(port.id),
          `${mod.type}.${port.id} (input, type=${port.type}): handle present in card UI (rendered inputs: ${[...renderedInputs].sort().join(', ')})`,
        ).toBe(true);
      }
      for (const port of mod.outputs) {
        expect(
          renderedOutputs.has(port.id),
          `${mod.type}.${port.id} (output, type=${port.type}): handle present in card UI (rendered outputs: ${[...renderedOutputs].sort().join(', ')})`,
        ).toBe(true);
      }
    });
  }
});
