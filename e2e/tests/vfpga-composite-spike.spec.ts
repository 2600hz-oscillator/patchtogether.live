// e2e/tests/vfpga-composite-spike.spec.ts
//
// COMPOSITE FILL-RATE SPIKE — the vfpga hardware-accuracy C3 go/no-go.
//
// The plan names "subcarrier supersampling" as the one fill-rate FAIL risk for an
// authentic composite encode→decode (rendering to an N×-oversampled FBO multiplies
// the fragment count). b3ntb0x already SHIPS that exact profile: RGB →
// 8×-oversampled FLOAT composite FBO → 13-tap (N=6) quadrature demod → CRT. So it
// is the faithful proxy for the GL cost a vfpga FABRIC composite would incur.
//
// This spike MEASURES b3ntb0x's per-frame wall-clock ON THE SwiftShader SOFTWARE
// renderer (the e2e default — `--use-angle=swiftshader`; this is what CI runs, and
// the worst case vs any real GPU) by timing a fixed run of SYNCHRONOUS engine
// steps (no rAF → no scheduler noise), and logs the achieved fps. Read the number
// from the test log:
//   • comfortably > ~10 fps  ⇒ the vfpga composite path (C3) is clearly viable.
//   • ~1–5 fps               ⇒ marginal — cap the subcarrier sample count.
//   • < 1 fps                ⇒ the named FAIL — composite stays main-thread / dropped.
// The assertion is only a CATASTROPHE floor (>1 fps); the real deliverable is the
// logged fps. (e2e specs are OUTSIDE the WebGL attest basis → attest-free.)

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { installRenderSmokeHooks } from './_render-smoke';

const WARMUP = 5; // discard the first frames (shader compile + FBO alloc)
const MEASURE = 40; // timed frames

async function bootComposite(page: Page): Promise<void> {
  // Pin BOTH clocks before boot (engine rAF/clock + b3ntb0x's subcarrier clock)
  // so the work per step is the steady-state composite pipeline, not warm-up.
  await installRenderSmokeHooks(page);
  await page.addInitScript(() => {
    (window as unknown as { __b3ntb0xFreezeTimeSec?: number }).__b3ntb0xFreezeTimeSec = 2.0;
  });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [
      { id: 'src', type: 'shapes', position: { x: 100, y: 100 }, domain: 'video', params: { shape: 0, zoom: 1.4 } },
      { id: 'bb', type: 'b3ntb0x', position: { x: 540, y: 100 }, domain: 'video', params: { tbc: 1, feedback: 0, sub_drift: 0 } },
    ],
    [
      { id: 'e_src', from: { nodeId: 'src', portId: 'out' }, to: { nodeId: 'bb', portId: 'in' }, sourceType: 'mono-video', targetType: 'video' },
    ],
  );
  await expect(page.locator('[data-testid="b3ntb0x-canvas"]'), 'composite canvas mounted').toHaveCount(1);
}

test('composite fill-rate spike: b3ntb0x SwiftShader fps (vfpga C3 go/no-go)', async ({ page }) => {
  test.setTimeout(120_000);
  await bootComposite(page);

  const m = await page.evaluate(
    ({ warmup, measure }) => {
      const w = globalThis as unknown as {
        __engine: () => {
          getDomain: (d: string) => {
            gl: WebGL2RenderingContext;
            step: () => void;
            currentFrameCount: () => number;
            outputTexture: (id: string, port?: string) => WebGLTexture | null;
            res: { width: number; height: number };
          };
        };
      };
      const vid = w.__engine().getDomain('video');
      const gl = vid.gl;
      const { width: W, height: H } = vid.res;
      const px = new Uint8Array(W * H * 4);
      const fb = gl.createFramebuffer()!;
      // step `n` frames, then readPixels the output — a HARD GPU sync that forces
      // all queued render work (step() alone only queues / renders lazily) to
      // complete before returning. The readback cost is FIXED, so it cancels in
      // the differential below.
      const renderAndSync = (n: number): number => {
        const before = vid.currentFrameCount();
        for (let i = 0; i < n; i++) vid.step();
        const tex = vid.outputTexture('bb');
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return vid.currentFrameCount() - before;
      };

      for (let i = 0; i < warmup; i++) renderAndSync(1); // prime (shader compile / FBO alloc)

      // Differential: (K steps + 1 readback) − (1 step + 1 readback) cancels the
      // fixed readback overhead → pure per-extra-frame render cost.
      const a0 = performance.now();
      renderAndSync(1);
      const a1 = performance.now();
      const b0 = performance.now();
      const framesDelta = renderAndSync(measure);
      const b1 = performance.now();
      gl.deleteFramebuffer(fb);

      const perFrameMs = (b1 - b0 - (a1 - a0)) / (measure - 1);
      return {
        framesDelta,
        readbackMs: a1 - a0,
        bulkMs: b1 - b0,
        msPerFrame: perFrameMs,
        fps: 1000 / perFrameMs,
        res: { width: W, height: H },
      };
    },
    { warmup: WARMUP, measure: MEASURE },
  );

  // THE DELIVERABLE — printed for the CI/local log.
  // eslint-disable-next-line no-console
  console.log(
    `[composite-spike] b3ntb0x (8× oversample + 13-tap demod) @ ${m.res.width}×${m.res.height}: ` +
      `${m.fps.toFixed(1)} fps (${m.msPerFrame.toFixed(2)} ms/frame, differential over ${MEASURE} steps; ` +
      `readback ${m.readbackMs.toFixed(1)} ms, bulk ${m.bulkMs.toFixed(1)} ms).`,
  );

  expect(m.framesDelta, 'engine advanced exactly the measured frames').toBe(MEASURE);
  // Catastrophe floor only — the real signal is the logged fps above.
  expect(m.fps, 'composite renders faster than 1 fps on SwiftShader').toBeGreaterThan(1);
});
