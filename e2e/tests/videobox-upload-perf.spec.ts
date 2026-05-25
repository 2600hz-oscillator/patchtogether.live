// e2e/tests/videobox-upload-perf.spec.ts
//
// Perf regression guard + measurement for the VIDEOBOX few-FPS output fix.
//
// Root cause (pre-fix): the engine sampled the card-owned <video> into the
// `out` GL texture with a FULL-RESOLUTION texImage2D(<video>) on EVERY engine
// rAF tick (~60/sec), re-speccing the whole texture each call. For a
// 1080p-class clip that's ~8 MB/frame x 60 fps ~= 480 MB/s of GPU texture
// traffic -> a few FPS downstream.
//
// Fix: the upload is driven off requestVideoFrameCallback (the <video>'s own
// decode cadence, ~24-30 fps) and the frame is downscaled to engine
// resolution (640x360) before upload. See video-frame-upload.ts.
//
// What we measure here (after-fix, asserted). We drive the engine's render
// step() OURSELVES in a fixed wall-clock window with gl.finish() after each
// step (so the GPU upload cost is on the clock). This is deterministic and
// immune to headless Chromium's background-rAF throttling, which otherwise
// starves the engine's rAF loop to ~1/sec under parallel workers and makes
// any rAF-driven FPS read meaningless:
//   - uploadsPerStep << 1: the engine step is DECOUPLED from the upload — we
//     do NOT pay a texImage2D per step (pre-fix this was exactly 1.0).
//   - msPerStep within the 24fps budget + achievableFps >= 24: the per-step
//     cost (incl. upload + downstream pass) leaves ample headroom for smooth
//     output.
//   - uploads still advance as the clip plays (texture live, not frozen).
//
// The before/after numbers in the PR body come from running this spec's
// glFinish step-throughput probe against HEAD vs. the pre-fix revision.
//
// Fixture: prefers the local 1080p-class clip (24 MB) when present on the dev
// machine, else the small committed fixture (still exercises the path; the
// upload-count assertion holds at any resolution).

import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { spawnPatch } from './_helpers';

const LOCAL_CLIP =
  "/Users/2600hz/Documents/workspace/vid_resize/Let's All Go To The Lobby [TH2j1YnIne0].webm";
const SMALL_FIXTURE = fileURLToPath(new URL('../fixtures/lobby-clip.webm', import.meta.url));
const FIXTURE = existsSync(LOCAL_CLIP) ? LOCAL_CLIP : SMALL_FIXTURE;

async function setup(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
}

/** Read a videobox handle `read(key)` value via the dev engine global. */
async function readVbox(
  page: import('@playwright/test').Page,
  nodeId: string,
  key: string,
): Promise<unknown> {
  return await page.evaluate(
    ({ nodeId, key }) => {
      const w = globalThis as unknown as {
        __engine?: () => {
          getDomain: (d: string) => { read: (id: string, k: string) => unknown };
        };
      };
      const eng = w.__engine?.();
      if (!eng) return undefined;
      return eng.getDomain('video').read(nodeId, key);
    },
    { nodeId, key },
  );
}

async function loadAndPlay(page: import('@playwright/test').Page) {
  await page.setInputFiles('[data-testid="videobox-file-input"]', FIXTURE);
  await expect(page.locator('[data-testid="videobox-card"]')).toHaveAttribute(
    'data-has-local-file', 'true', { timeout: 10_000 },
  );
  await page.click('[data-testid="videobox-play-btn"]');
  await expect(page.locator('[data-testid="videobox-card"]')).toHaveAttribute(
    'data-is-playing', 'true', { timeout: 4000 },
  );
}

test.describe('VIDEOBOX upload perf (rVFC-driven)', () => {
  test('decode-rate uploads + engine sustains a smooth frame budget', async ({ page }) => {
    await setup(page);
    await spawnPatch(page,
      [
        { id: 'vb',  type: 'videobox', position: { x: 40,  y: 40 }, domain: 'video' },
        { id: 'out', type: 'videoOut', position: { x: 560, y: 40 }, domain: 'video' },
      ],
      [{ id: 'e1', from: { nodeId: 'vb', portId: 'video' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'video', targetType: 'video' }],
    );

    await loadAndPlay(page);
    // Let playback settle so the decode pipeline is in steady state.
    await page.waitForTimeout(700);

    const clipDims = await page.locator('[data-testid="videobox-video"]').evaluate(
      (el) => {
        const v = el as HTMLVideoElement;
        return { w: v.videoWidth, h: v.videoHeight };
      },
    );
    const rvfcSupported = await readVbox(page, 'vb', 'rvfcSupported');

    // We drive the engine's render step() OURSELVES in a fixed wall-clock
    // window, with gl.finish() after each step so the GPU texture-upload cost
    // is on the clock. This is deterministic and immune to headless
    // Chromium's background-rAF throttling (which otherwise starves the
    // engine's own rAF loop to ~1/sec and makes any rAF-based FPS read
    // meaningless under parallel workers). The "achievable engine fps" we get
    // is a faithful proxy for downstream smoothness: every step() runs the
    // full topo draw incl. the VIDEOBOX upload + VIDEO-OUT pass.
    const r = await page.evaluate(async () => {
      const w = globalThis as unknown as {
        __engine: () => { getDomain: (d: string) => {
          gl: WebGL2RenderingContext;
          step: () => void;
          read: (id: string, k: string) => unknown;
        } };
      };
      const vid = w.__engine().getDomain('video');
      const gl = vid.gl;
      const u0 = vid.read('vb', 'uploadCount') as number;
      let steps = 0;
      const t0 = performance.now();
      while (performance.now() - t0 < 1500) {
        vid.step();
        gl.finish(); // block until the GPU has drained this step's uploads
        steps++;
      }
      const elapsed = (performance.now() - t0) / 1000;
      const u1 = vid.read('vb', 'uploadCount') as number;
      return {
        achievableFps: steps / elapsed,
        msPerStep: (elapsed * 1000) / steps,
        uploads: u1 - u0,
        uploadsPerStep: (u1 - u0) / steps,
      };
    });

    // Separately: confirm uploads DO still happen as the clip plays (the
    // texture isn't frozen). We step() with a macrotask gap so the event loop
    // can service rVFC decode callbacks, then check uploadCount advanced. We
    // assert LIVENESS (advanced at all) rather than a precise rate: under
    // parallel headless workers the page is backgrounded and both timers and
    // rVFC are throttled, so a rate floor would flake. The decode-cadence
    // number is reported for the record (the standalone, foregrounded run
    // shows ~30/sec for this 30fps clip — see the PR body).
    const decode = await page.evaluate(async () => {
      const w = globalThis as unknown as {
        __engine: () => { getDomain: (d: string) => {
          step: () => void;
          read: (id: string, k: string) => unknown;
        } };
      };
      const vid = w.__engine().getDomain('video');
      const u0 = vid.read('vb', 'uploadCount') as number;
      const t0 = performance.now();
      while (performance.now() - t0 < 1500) {
        vid.step();
        await new Promise<void>((res) => setTimeout(res, 8));
      }
      const elapsed = (performance.now() - t0) / 1000;
      const u1 = vid.read('vb', 'uploadCount') as number;
      return { uploadsDelta: u1 - u0, uploadsPerSec: (u1 - u0) / elapsed };
    });

    // eslint-disable-next-line no-console
    console.log(
      `[videobox-perf] clip=${clipDims.w}x${clipDims.h} rvfc=${rvfcSupported} ` +
      `achievableFps=${r.achievableFps.toFixed(0)} msPerStep=${r.msPerStep.toFixed(3)} ` +
      `uploadsPerStep=${r.uploadsPerStep.toFixed(3)} decodeUploadsPerSec=${decode.uploadsPerSec.toFixed(1)}`,
    );

    // The whole point of the fix: the engine does NOT pay a full-res
    // texImage2D(<video>) on every step. Because we drive step() far faster
    // than the clip's ~30fps decode (and rVFC only marks a frame dirty at
    // decode rate), the steady-state uploads-per-step must be well under 1.
    // (Pre-fix this was exactly 1.0 — every step re-uploaded the full frame.)
    expect(r.uploadsPerStep, `uploadsPerStep ${r.uploadsPerStep.toFixed(3)} << 1 (not every step)`).toBeLessThan(0.5);

    // Uploads still HAPPEN as the clip plays (texture refreshes, not frozen).
    expect(decode.uploadsDelta, `uploads advanced (${decode.uploadsDelta}) — texture live`).toBeGreaterThan(0);

    // And the per-step budget must leave plenty of headroom for >=24fps: each
    // engine step (incl. upload + downstream pass) must complete in well under
    // the 41.6ms a 24fps frame budget allows. Generous ceiling for slow CI
    // GPUs while still catching a regression back to the ~480MB/s firehose.
    expect(r.msPerStep, `msPerStep ${r.msPerStep.toFixed(2)} within 24fps budget`).toBeLessThan(20);
    expect(r.achievableFps, `achievableFps ${r.achievableFps.toFixed(0)} >= 24`).toBeGreaterThanOrEqual(24);
  });
});
