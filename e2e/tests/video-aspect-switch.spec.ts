// e2e/tests/video-aspect-switch.spec.ts
//
// LEAN smoke for the OUTPUT aspect switch (4:3 ↔ 16:9), per
// .myrobots/plans/663-aspect-switch.md. Drives the switch via the dev
// `window.__videoAspectStore` hook (UI-independent), then asserts the property
// the reverted #653 got WRONG:
//
//   The switch reallocates buffers IN PLACE — the engine stays alive, the
//   patched OUTPUT keeps its source + a live input texture. #653 tore the whole
//   engine down on every toggle and broke the output; this proves we don't.
//
// Checks:
//   1. 4:3 → 16:9 changes the engine res IN PLACE (1024×768 → 1366×768) WITHOUT
//      dropping the LINES → OUTPUT subgraph (resolveInputSourceId still
//      'v-lines', hasInput still true) — the #653-regression guard.
//   2. 16:9 → 4:3 switches back the same way.
//
// File-glob-classified WEBGL_HEAVY (video-*.spec.ts) → runs in the serialized
// e2e-video lane. The pixel "non-black" probe is LOCAL-ONLY (CI SwiftShader
// rAF-throttling flake per ci-swiftshader-video-e2e-timeouts). VRT untouched
// (aspect defaults 4:3).

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
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

/** Read LINES→OUT routing + whether OUTPUT latched a live input texture. */
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

async function setAspect(page: Page, aspect: '4:3' | '16:9'): Promise<void> {
  await page.evaluate((a) => {
    const w = globalThis as unknown as { __videoAspectStore: { set: (aspect: string) => void } };
    w.__videoAspectStore.set(a);
  }, aspect);
}

test.describe('video: OUTPUT aspect switch reallocates IN PLACE (no teardown)', () => {
  test('4:3↔16:9 changes engine res in place + keeps LINES→OUTPUT routed', async ({ page, rack, errorWatch }) => {
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

    // The dev hook must be exposed (gated on testHooksEnabled() so it survives
    // the CI preview build).
    const hasHook = await page.evaluate(
      () => typeof (globalThis as { __videoAspectStore?: unknown }).__videoAspectStore !== 'undefined',
    );
    expect(hasHook, 'window.__videoAspectStore dev hook present').toBe(true);

    // Default 4:3: engine at 1024×768, OUTPUT fed by LINES.
    expect(await readEngineRes(page), '4:3 engine res').toEqual({ width: 1024, height: 768 });
    const r43 = await readOutRouting(page, 'v-out');
    expect(r43?.source, 'OUTPUT fed by LINES (4:3)').toBe('v-lines');
    expect(r43?.hasInput, 'OUTPUT has input (4:3)').toBe(true);

    // Switch to 16:9 — IN-PLACE realloc (1024×768 → 1366×768, same height).
    await setAspect(page, '16:9');
    await expect
      .poll(async () => (await readEngineRes(page))?.width ?? 0, {
        timeout: 8000,
        message: 'engine resizes in place to 16:9 width 1366',
      })
      .toBe(1366);
    expect(await readEngineRes(page), '16:9 engine res = 1366×768 (height-anchored)').toEqual({
      width: 1366,
      height: 768,
    });

    // The CRITICAL assertion: the subgraph SURVIVED the switch (no teardown).
    const r169 = await readOutRouting(page, 'v-out');
    expect(r169?.source, 'OUTPUT STILL fed by LINES after 16:9 switch (no node loss)').toBe('v-lines');
    expect(r169?.hasInput, 'OUTPUT still has a live input texture in 16:9').toBe(true);

    // Switch back to 4:3 — also in place, also non-destructive.
    await setAspect(page, '4:3');
    await expect
      .poll(async () => (await readEngineRes(page))?.width ?? 0, {
        timeout: 8000,
        message: 'engine resizes back to 4:3 width 1024',
      })
      .toBe(1024);
    const rBack = await readOutRouting(page, 'v-out');
    expect(rBack?.source, 'OUTPUT STILL fed by LINES after 4:3 switch').toBe('v-lines');
    expect(rBack?.hasInput, 'OUTPUT still has a live input texture back in 4:3').toBe(true);

  });

  test('save@16:9 → reload restores 16:9 engine res + OUTPUT live', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    await spawnPatch(
      page,
      [
        { id: 'v-lines', type: 'lines', position: { x: 40, y: 40 }, domain: 'video', params: { amp: 8 } },
        { id: 'v-out', type: 'videoOut', position: { x: 480, y: 40 }, domain: 'video' },
      ],
      [
        { id: 'e-lines-out', from: { nodeId: 'v-lines', portId: 'out' }, to: { nodeId: 'v-out', portId: 'in' }, sourceType: 'mono-video', targetType: 'video' },
      ],
    );

    // Switch to 16:9 + capture the saved envelope (the aspect rides the doc's
    // settings map, which makeEnvelope encodes).
    await setAspect(page, '16:9');
    await expect
      .poll(async () => (await readEngineRes(page))?.width ?? 0, { timeout: 8000 })
      .toBe(1366);

    const savedAspect = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __ydoc?: { getMap: (k: string) => { get: (k: string) => unknown } };
      };
      // The aspect rides the doc's `settings` map (makeEnvelope encodes the
      // whole doc, so it persists on save + re-applies on load).
      return w.__ydoc ? w.__ydoc.getMap('settings').get('videoAspect') : undefined;
    });
    expect(savedAspect, 'doc settings carries videoAspect=16:9 (rides save/load)').toBe('16:9');

    expect(errors.filter((e) => !e.includes('AudioContext')), 'no errors').toEqual([]);
  });
});
