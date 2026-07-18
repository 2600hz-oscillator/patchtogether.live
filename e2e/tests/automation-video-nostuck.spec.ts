// e2e/tests/automation-video-nostuck.spec.ts
//
// (Named `automation-*`, NOT `video-*`, so it runs in the normal sharded e2e
// lane — it is LIGHT: a paused engine stepped a few frames, reading the engine
// PARAM VALUE, never pixels. It deliberately does not match the heavy-WebGL
// globs in e2e/webgl-heavy-globs.ts, which route GPU-bound pixel/screenshot
// specs to the serialized e2e-video lane.)
//
// Real-browser coverage for fix/video-automation against a REAL video module
// (LINES) + the REAL VideoEngine (worker or main-thread fallback), not a stub.
//
// Proves, renderer-independently (reads the engine's param value, never pixels,
// so it's green on CI SwiftShader):
//   1. Clip-automation PLAYBACK drive reaches a video param. VideoEngine now
//      implements scheduleParam/holdParam/setDisplayParam (previously only
//      setParam existed, so the clip-player's drive seams silently no-op'd for
//      the video domain — video automation never played back).
//   2. NO STUCK CONTROL: after the driver stops, the param returns to its
//      manual base within a few frames, and a fresh manual write takes effect —
//      the fader is never left dead (the reconciler-dedup stuck-control bug).
//
// Drives the SAME public engine seams the clip-player automation lane drives
// (engine.scheduleParam / setParam / step), through the app's __engine hook.

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';
import { installRenderSmokeHooks } from './_render-smoke';

const HOLD_FRAMES = 10; // mirrors VideoEngine.TRANSIENT_HOLD_FRAMES

test.describe('video automation — drive + no stuck control', () => {
  test('automation drives a LINES param and manual control always returns', async ({ page, errorWatch }) => {
    test.setTimeout(60_000);

    // Pause the rAF loop + pin the clock so the test owns the exact frame count.
    await installRenderSmokeHooks(page);
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    await spawnPatch(
      page,
      [
        { id: 'm',   type: 'lines',    position: { x: 100, y: 100 }, domain: 'video' },
        { id: 'out', type: 'videoOut', position: { x: 540, y: 100 }, domain: 'video' },
      ],
      [
        { id: 'e', from: { nodeId: 'm', portId: 'out' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'video', targetType: 'video' },
      ],
    );

    const result = await page.evaluate((HOLD) => {
      const w = globalThis as unknown as {
        __engine: () => { getDomain: (d: string) => {
          step: () => void;
          setParam: (n: string, p: string, v: number) => void;
          scheduleParam: (n: string, p: string, v: number, at: number, ramp: boolean) => void;
          readParam: (n: string, p: string) => number | undefined;
        } };
      };
      const vid = w.__engine().getDomain('video');
      const read = () => vid.readParam('m', 'orient');

      // Manual base.
      vid.setParam('m', 'orient', 0.15);
      const afterManual = read();

      // Clip-automation playback drive → must reach the video param.
      vid.scheduleParam('m', 'orient', 0.85, 0, false);
      const afterDrive = read();

      // Driver STOPS: step frames with no further drive → base must restore.
      for (let i = 0; i < HOLD + 4; i++) vid.step();
      const afterStop = read();

      // Manual control must work again immediately.
      vid.setParam('m', 'orient', 0.5);
      const afterManual2 = read();
      for (let i = 0; i < HOLD + 4; i++) vid.step();
      const afterManual2Held = read();

      return { afterManual, afterDrive, afterStop, afterManual2, afterManual2Held };
    }, HOLD_FRAMES);

    expect(result.afterManual, 'manual base applied').toBeCloseTo(0.15, 3);
    expect(result.afterDrive, 'automation drive reached the video param').toBeCloseTo(0.85, 3);
    expect(result.afterStop, 'NO STUCK: param returned to manual base after the driver stopped').toBeCloseTo(0.15, 3);
    expect(result.afterManual2, 'manual control works again after automation').toBeCloseTo(0.5, 3);
    expect(result.afterManual2Held, 'manual value is not re-clobbered by a ghost driver').toBeCloseTo(0.5, 3);

    errorWatch.assertClean();
  });
});
