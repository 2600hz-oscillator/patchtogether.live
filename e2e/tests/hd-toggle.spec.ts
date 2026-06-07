// e2e/tests/hd-toggle.spec.ts
//
// LIGHT smoke for the global HD toggle (.myrobots/plans/hd-toggle.md). Drives
// the toggle via the dev `window.__hdStore` hook (not the pill, to stay UI-
// independent), then asserts:
//   1. the video engine REBUILDS at the new HD res (640×480 → 1280×720), and
//   2. a video module is still routed + holds a live input texture after the
//      rebuild (deterministic on SwiftShader — same pattern as multi-output).
//
// Kept deliberately light: CI uses SwiftShader and heavy WebGL e2e blow flat
// timeouts (see ci-swiftshader-video-e2e-timeouts memory). The pixel-probe
// "non-black" check is LOCAL-ONLY; CI relies on the routing/hasInput assertion.
// VRT is NOT exercised here (HD defaults OFF; baselines unchanged).

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

/** Read the video engine's current render res via the dev __engine hook. */
async function readEngineRes(page: Page): Promise<{ width: number; height: number } | null> {
  return await page.evaluate(() => {
    const w = globalThis as unknown as {
      __engine?: () => { getDomain: (d: string) => { res?: { width: number; height: number } } } | null;
    };
    const eng = w.__engine?.();
    if (!eng) return null;
    try {
      const vid = eng.getDomain('video');
      return vid?.res ? { width: vid.res.width, height: vid.res.height } : null;
    } catch {
      return null;
    }
  });
}

/** Read LINES→OUT routing + whether the OUTPUT latched a live input texture. */
async function readOutRouting(
  page: Page,
  outId: string,
): Promise<{ source: string | null; hasInput: boolean } | null> {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => {
        getDomain: (d: string) => {
          step: () => void;
          read: (id: string, k: string) => unknown;
          resolveInputSourceId: (id: string, port: string) => string | null;
        };
      } | null;
    };
    const eng = w.__engine?.();
    if (!eng) return null;
    const vid = eng.getDomain('video');
    vid.step();
    vid.step();
    return {
      source: vid.resolveInputSourceId(id, 'in'),
      hasInput: vid.read(id, 'hasInput') === true,
    };
  }, outId);
}

test.describe('video: HD toggle rebuilds the engine at HD res', () => {
  test('toggling HD via __hdStore rebuilds at 1280×720 and a video module still renders', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // LINES (procedural source) → OUTPUT.
    await spawnPatch(
      page,
      [
        { id: 'v-lines', type: 'lines', position: { x: 40, y: 40 }, domain: 'video', params: { amp: 8, thickness: 0.4 } },
        { id: 'v-out', type: 'videoOut', position: { x: 480, y: 40 }, domain: 'video' },
      ],
      [
        { id: 'e-lines-out', from: { nodeId: 'v-lines', portId: 'out' }, to: { nodeId: 'v-out', portId: 'in' }, sourceType: 'mono-video', targetType: 'video' },
      ],
    );

    // The dev HD hook must be exposed.
    const hasHook = await page.evaluate(() => typeof (globalThis as { __hdStore?: unknown }).__hdStore !== 'undefined');
    expect(hasHook, 'window.__hdStore dev hook present').toBe(true);

    // Default OFF → engine at SD 640×480 (byte-for-byte today).
    const sdRes = await readEngineRes(page);
    expect(sdRes, 'SD engine res readable').not.toBeNull();
    expect(sdRes).toEqual({ width: 640, height: 480 });

    // Before the rebuild, LINES is routed into OUTPUT with a live texture.
    const before = await readOutRouting(page, 'v-out');
    expect(before?.source, 'OUTPUT fed by LINES (pre-toggle)').toBe('v-lines');
    expect(before?.hasInput, 'OUTPUT has input pre-toggle').toBe(true);

    // Toggle HD ON with an explicit deterministic res (so the test doesn't
    // depend on the headless viewport aspect). This disposes + rebuilds the
    // engine; the reconciler re-adds LINES + OUTPUT + the edge.
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __hdStore: { set: (on: boolean, res?: { width: number; height: number }) => void };
      };
      w.__hdStore.set(true, { width: 1280, height: 720 });
    });

    // Wait for the rebuild to land at the HD res. The rebuild is async (dispose
    // old, close AudioContext, reconstruct, reconcile) — poll until the engine
    // reports the new res.
    await expect
      .poll(async () => (await readEngineRes(page))?.width ?? 0, {
        timeout: 15000,
        message: 'engine rebuilds at HD width 1280',
      })
      .toBe(1280);
    const hdRes = await readEngineRes(page);
    expect(hdRes, 'HD engine res = 1280×720').toEqual({ width: 1280, height: 720 });

    // After the rebuild, LINES is STILL routed into OUTPUT with a live texture —
    // proves the reconciler re-added the subgraph + the module renders.
    await expect
      .poll(async () => (await readOutRouting(page, 'v-out'))?.hasInput ?? false, {
        timeout: 15000,
        message: 'OUTPUT re-latches a live input after the HD rebuild',
      })
      .toBe(true);
    const after = await readOutRouting(page, 'v-out');
    expect(after?.source, 'OUTPUT fed by LINES (post-rebuild)').toBe('v-lines');

    // LOCAL-ONLY visual confirmation: the OUTPUT canvas renders non-black after
    // the HD rebuild. CI-skipped (SwiftShader rAF throttling + sampled-FB flake).
    if (!process.env.CI) {
      await page.waitForTimeout(600);
      const stats = await page
        .locator('canvas[data-testid="video-out-canvas"][data-node-id="v-out"]')
        .evaluate((el) => {
          const c = el as HTMLCanvasElement;
          const ctx = c.getContext('2d');
          if (!ctx) return null;
          const img = ctx.getImageData(0, 0, c.width, c.height);
          let nonZero = 0;
          let n = 0;
          for (let i = 0; i < img.data.length; i += 16) {
            const v = (img.data[i]! + img.data[i + 1]! + img.data[i + 2]!) / 3;
            if (v > 8) nonZero++;
            n++;
          }
          return { nonZero, n };
        });
      expect(stats, 'canvas stats non-null').not.toBeNull();
      if (stats) {
        expect(stats.nonZero / stats.n, 'OUTPUT renders non-black after HD rebuild').toBeGreaterThan(0.02);
      }
    }

    // No uncaught page errors during the rebuild.
    expect(errors, `no page errors: ${errors.join(' | ')}`).toEqual([]);
  });
});
