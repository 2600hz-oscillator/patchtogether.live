// e2e/tests/vfpga-patchpanel-presets.spec.ts
//
// vfpga-runner — two user-reported regressions (review-gated PR), re-pointed at
// the default shell by the S2 legacy-removal inversion:
//
//   BUG 1: the legacy card once rendered a raw vertical column of <Handle> side
//          jacks (VIN1-4, CV2-4, G2-4, …) instead of the post-#767 yellow
//          drill-down PatchPanel. The surviving shell claim: the tile keeps the
//          PatchPanel drill-down trigger AND every declared port still renders
//          as a handle, all collapsed at the SAME corner point (not spread down
//          a side) — the handle-presence sweep parity.
//
//   BUG 2: loading a non-default preset still rendered only the smpte-bars test
//          pattern. Root cause: the preview pulled a CPU read('snapshot') that
//          only existed for smpte-bars (null for every other spec → the canvas
//          kept the last-drawn bars). The preview now blits THIS node's real
//          engine output, so switching presets visibly changes the
//          preview/output. We assert the OUTPUT pixels (the videoOut tile
//          thumb — the downstream chain) DIFFER measurably from the smpte
//          baseline after loading a non-default preset. Pixel reads are gated
//          on a WebGL2 probe (CI's SwiftShader renders, but we keep the
//          assertion renderer-tolerant — a structural DIFFERENCE, not exact
//          colours).

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

/** videoOut tile thumb stats — reads what vfpga-runner produced through the
 *  downstream chain. */
async function outputStats(page: Page): Promise<{ nonZeroFrac: number; variance: number; mean: number } | null> {
  const canvas = page.locator('.svelte-flow__node[data-id="out"] [data-testid="video-tile-thumb"]');
  await expect(canvas, 'videoOut tile thumb mounted').toHaveCount(1);
  return canvas.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let n = 0, sum = 0, sumSq = 0, nonZero = 0;
    for (let i = 0; i < data.length; i += 16) {
      const v = (data[i]! + data[i + 1]! + data[i + 2]!) / 3;
      sum += v; sumSq += v * v; n++;
      if (v > 8) nonZero++;
    }
    const mean = sum / n;
    return { nonZeroFrac: nonZero / n, variance: sumSq / n - mean * mean, mean };
  });
}

/** Poll until the OUTPUT shows structured content (first-frame latency varies). */
async function settleOutput(page: Page) {
  let stats = await outputStats(page);
  for (let i = 0; i < 40 && (!stats || stats.nonZeroFrac <= 0.05); i++) {
    await page.waitForTimeout(150);
    stats = await outputStats(page);
  }
  return stats;
}

async function spawnHostToOutput(page: Page) {
  await spawnPatch(
    page,
    [
      { id: 'vf', type: 'vfpgaRunner', position: { x: 80, y: 80 }, domain: 'video' },
      { id: 'out', type: 'videoOut', position: { x: 600, y: 80 }, domain: 'video' },
    ],
    [
      { id: 'e1', from: { nodeId: 'vf', portId: 'vout1' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'video', targetType: 'video' },
    ],
  );
  await expect(page.locator('.svelte-flow__node:has([data-shell-type="vfpgaRunner"])')).toHaveCount(1);
  await expect(page.locator('.svelte-flow__node:has([data-shell-type="videoOut"])')).toHaveCount(1);
}

test.describe('vfpga-runner — PatchPanel + presets', () => {
  test('BUG 1: the tile keeps the PatchPanel drill-down — no raw side-column jacks; all handles at the corner', async ({ page, rack }) => {
    test.setTimeout(45_000);
    await spawnHostToOutput(page);

    const wrapper = page.locator('.svelte-flow__node[data-id="vf"]');
    await expect(wrapper).toBeVisible();

    // The yellow drill-down PatchPanel trigger is present on the tile (proves
    // the shell mounts the PatchPanel affordance, not a raw-<Handle> layout).
    await expect(wrapper.locator('[data-testid="patch-trigger"]').first()).toHaveCount(1);

    // Every rendered handle is collapsed at the SAME affordance point — i.e.
    // NOT spread out in a vertical side column (the old bug). We read every
    // handle's bounding box and assert their spread is tiny. A raw side column
    // would span >100px.
    const spread = await wrapper.locator('.svelte-flow__handle').evaluateAll((els) => {
      if (els.length === 0) return { count: 0, topSpread: 0, leftSpread: 0 };
      const rects = els.map((el) => el.getBoundingClientRect());
      const tops = rects.map((r) => r.top);
      const lefts = rects.map((r) => r.left);
      return {
        count: els.length,
        topSpread: Math.max(...tops) - Math.min(...tops),
        leftSpread: Math.max(...lefts) - Math.min(...lefts),
      };
    });
    // 14 declared ports (vin1-4, cv1-4, g1-4, vout1, vout2) all render as handles.
    expect(spread.count, `every declared port renders as a handle (got ${spread.count})`).toBe(14);
    // The shell stacks them at one point → near-zero spread. A raw vertical
    // column (old bug) would be > 100px tall. Allow a small tolerance for AA.
    expect(spread.topSpread, `handles are NOT a vertical side column (topSpread=${spread.topSpread})`).toBeLessThan(20);
    expect(spread.leftSpread, `handles are NOT spread horizontally (leftSpread=${spread.leftSpread})`).toBeLessThan(20);
  });

  test('BUG 2: loading a non-default preset visibly changes OUTPUT away from the smpte test pattern', async ({ page, rack, errorWatch }) => {
    test.setTimeout(60_000);


    // Renderer probe: only assert pixels when WebGL2 actually renders (CI uses
    // SwiftShader, which DOES render — but skip cleanly on a context-less runtime
    // so a headless/GL-disabled box degrades to a no-op instead of a false red).
    const canRender = await page.evaluate(() => {
      try {
        const c = document.createElement('canvas');
        return !!(c.getContext('webgl2'));
      } catch { return false; }
    });
    test.skip(!canRender, 'WebGL2 not available in this runtime');

    await spawnHostToOutput(page);

    // Default smpte-bars is shown loaded (the selector cell's value span is the
    // loaded readout on the shell); capture the baseline output.
    const cell = page.locator('.svelte-flow__node[data-id="vf"] [data-testid="shell-cell-vfpga-preset"]');
    await expect(cell.locator('.val')).toHaveText('SMPTE bars');
    const base = await settleOutput(page);
    expect(base, 'OUTPUT readable on the default preset').not.toBeNull();
    // SMPTE bars fill the frame → high non-black fraction + spatial structure.
    expect(base!.nonZeroFrac, `smpte bars reach OUTPUT (nonZeroFrac=${base!.nonZeroFrac})`).toBeGreaterThan(0.3);
    expect(base!.variance, `smpte bars have structure (var=${base!.variance})`).toBeGreaterThan(50);

    // Load a NON-default preset (tmds-sparkle renders distinct output even with
    // no upstream video patched — proven non-flaky in the probe). The cell's
    // value span tracks the chosen spec. (Positive control, measured: with
    // 'SMPTE bars' re-selected here instead, the delta assertion below went red
    // at Δmean=0.0 Δvar=0.0 — the thumb instrument measures the hot-swap, not
    // its own noise.)
    await cell.click();
    const option = page.locator('[role="option"]', { hasText: 'tmds-sparkle' });
    await expect(option).toHaveCount(1);
    await option.click();
    await expect(cell.locator('.val')).toHaveText('tmds-sparkle');

    // Poll until the OUTPUT settles on the NEW spec's render, then assert it
    // DIFFERS measurably from the smpte baseline (the engine actually hot-swapped
    // + the preview/output tracks it — the bug was "always the smpte pattern").
    let after = await outputStats(page);
    for (let i = 0; i < 40; i++) {
      after = await outputStats(page);
      if (after && Math.abs(after.mean - base!.mean) > 10) break;
      await page.waitForTimeout(150);
    }
    expect(after, 'OUTPUT readable after preset change').not.toBeNull();
    const meanDelta = Math.abs(after!.mean - base!.mean);
    const varDelta = Math.abs(after!.variance - base!.variance);
    // Renderer-tolerant: a STRUCTURAL difference (mean luma OR variance shifts
    // well beyond noise), not exact colours. The probe measured mean 79→25 and
    // var 4658→1223 — orders of magnitude beyond this floor.
    expect(
      meanDelta > 10 || varDelta > 200,
      `OUTPUT changed from the smpte pattern (Δmean=${meanDelta.toFixed(1)} Δvar=${varDelta.toFixed(1)})`,
    ).toBe(true);

  });
});
