import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { waitFrames } from '../_helpers/frames';
import { installRenderSmokeHooks, stepAndReadStats, assertRenderStats } from './_render-smoke';
import { writeFile } from 'node:fs/promises';

// Keep the expensive physical-loop probes sequential within this file. Other
// CI specs still run alongside them on the shared software renderer.
test.describe.configure({ mode: 'default' });

// Real factory/shaders; fixed frame counts and equal starting histories.
// The profile coefficient tests cannot see a disconnected shader uniform.
const BASE = { tvMode: 3, mix: 0, feedback: 1.1, zoom: 0.93, rotate: 6,
  sensorLag: 0.08, sensorVariation: 0.8, contrast: 1, exposure: 2, blackLevel: 0.08 };

async function boot(page: Page, variants: Record<string, number>[]) {
  await page.setViewportSize({ width: 1280, height: 1100 });
  await installRenderSmokeHooks(page);
  await page.goto('/rack?seed=none');
  await spawnPatch(page, [
    { id: 'src', type: 'shapes', position: { x: 40, y: 40 }, domain: 'video',
      params: { shape: 0, tile: 1, tileN: 4, zoom: 0.6 } },
    ...variants.flatMap((params, i) => [
      { id: `m${i}`, type: 'backdraft', position: { x: 450, y: 80 + i * 300 }, domain: 'video' as const, params: { ...BASE, ...params } },
      { id: `o${i}`, type: 'videoOut', position: { x: 900, y: 80 + i * 300 }, domain: 'video' as const },
    ]),
  ], variants.flatMap((_, i) => [
    { id: `s${i}`, from: { nodeId: 'src', portId: 'out' }, to: { nodeId: `m${i}`, portId: 'in_a' }, sourceType: 'mono-video' as const, targetType: 'video' as const },
    { id: `e${i}`, from: { nodeId: `m${i}`, portId: 'out' }, to: { nodeId: `o${i}`, portId: 'in' }, sourceType: 'video' as const, targetType: 'video' as const },
  ]));
  // The probe consumes every output, including off-screen variants. Preview
  // watches expire after 1.5 s; a synchronous SwiftShader frame burst can
  // outlast that TTL. Own hard leases, as an actual presentation surface does,
  // and prove PER-NODE draws rather than only the engine's global tick count.
  const counts = await page.evaluate((count) => {
    const w = window as unknown as { __engine: () => { getDomain(d: string): {
      acquireRenderLease(id: string): () => void;
      pullStats(): { framesDrawn: Record<string, number> };
    } } };
    const ve = w.__engine().getDomain('video');
    for (let i = 0; i < count; i++) ve.acquireRenderLease(`m${i}`);
    return ve.pullStats().framesDrawn;
  }, variants.length);
  let driven = 0;
  return async (nodeId: string, steps: number) => {
    const stats = await stepAndReadStats(page, { nodeId, steps });
    driven += steps;
    const drawn = await page.evaluate(() => {
      const w = window as unknown as { __engine: () => { getDomain(d: string): {
        pullStats(): { framesDrawn: Record<string, number> };
      } } };
      return w.__engine().getDomain('video').pullStats().framesDrawn;
    });
    for (let i = 0; i < variants.length; i++) {
      const id = `m${i}`;
      expect((drawn[id] ?? 0) - (counts[id] ?? 0), `${id}: every requested field was drawn`).toBe(driven);
    }
    return stats;
  };
}

/** Spatial probe after the shared harness drives frames. Reads the actual
 * output texture, validates its instrument, and never polls an animation. */
async function pictures(page: Page, count: number) {
  return page.evaluate((count) => {
    const w = window as unknown as { __engine: () => { getDomain(d: string): {
      gl: WebGL2RenderingContext; res: { width: number; height: number };
      outputTexture(id: string): WebGLTexture | null;
    } } };
    const ve = w.__engine().getDomain('video'), gl = ve.gl;
    const { width, height } = ve.res;
    const fbo = gl.createFramebuffer()!;
    const result: number[][] = [];
    try {
      for (let n = 0; n < count; n++) {
        const texture = ve.outputTexture(`m${n}`);
        if (!texture) throw new Error(`Missing output m${n}`);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Unreadable output');
        const pixels = new Uint8Array(width * height * 4);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        const samples: number[] = [];
        for (let y = 0; y < height; y += 12) for (let x = 0; x < width; x += 12) {
          const i = (y * width + x) * 4;
          samples.push(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!);
        }
        if (!samples.length) throw new Error('Zero samples');
        result.push(samples);
      }
      if (gl.getError() !== gl.NO_ERROR) throw new Error('Readback GL error');
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.deleteFramebuffer(fbo);
    }
    return result;
  }, count);
}

function difference(a: number[], b: number[]) {
  expect(a.length).toBeGreaterThan(0);
  expect(b.length).toBe(a.length);
  return a.reduce((sum, value, i) => sum + Math.abs(value - b[i]!), 0) / a.length;
}

test('sensor seed is reproducible and reroll changes the live camera response', async ({ page }) => {
  test.setTimeout(120_000);
  const step = await boot(page, [{ sensorSeed: 167 }, { sensorSeed: 167 }, { sensorSeed: 49820 }]);
  assertRenderStats(await step('m0', 8), 8);
  const p = await pictures(page, 3);
  expect(difference(p[0]!, p[1]!), 'same seed + same input/history').toBe(0);
  expect(difference(p[0]!, p[2]!), 'rerolled physical response reaches GPU pixels').toBeGreaterThan(0.2);
  // The third camera has proved seed separation. Freeze it before testing the
  // face action: only the matching pair is needed to observe the reroll.
  await page.evaluate(() => {
    const w = window as unknown as { __engine: () => { getDomain(d: string): { setParam(id: string, key: string, value: number): void } } };
    w.__engine().getDomain('video').setParam('m2', 'freeze', 1);
  });
  // Exercise the shipping ModuleShell action and verify its actual effect.
  await page.evaluate(() => {
    (window as unknown as { __openDockFullView(id: string): void }).__openDockFullView('m0');
  });
  const reroll = page.getByTestId('backdraft-reroll-sensor');
  await expect(reroll).toBeVisible();
  await reroll.click();
  await page.waitForFunction(() => {
    const w = window as unknown as { __patch: { nodes: Record<string, { params: Record<string, number> }> } };
    return w.__patch.nodes.m0?.params.sensorSeed !== 167;
  });
  // Two fields expose the changed sensor response; waiting for eight keeps
  // iterating the same difference and dominated the software-renderer bill.
  await step('m0', 2);
  const rerolled = await pictures(page, 2);
  expect(difference(rerolled[0]!, rerolled[1]!), 'face action changes the live feedback response').toBeGreaterThan(0.05);
  const data = await page.evaluate(() => {
    const w = window as unknown as { __engine: () => { getDomain(d: string): {
      blitOutputToDrawingBuffer(id: string): void; canvas: OffscreenCanvas;
    } } };
    const ve = w.__engine().getDomain('video');
    ve.blitOutputToDrawingBuffer('m0');
    const canvas = document.createElement('canvas');
    canvas.width = ve.canvas.width; canvas.height = ve.canvas.height;
    canvas.getContext('2d')!.drawImage(ve.canvas, 0, 0);
    return canvas.toDataURL('image/png').split(',')[1]!;
  });
  await writeFile(test.info().outputPath('crutchfield-output.png'), Buffer.from(data, 'base64'));
  // Let the real preview paint the held output, then inspect the new page.
  await page.evaluate(() => {
    const w = window as unknown as {
      __videoEnginePause: boolean;
      __engine: () => { getDomain(d: string): { setParam(id: string, key: string, value: number): void } };
    };
    const ve = w.__engine().getDomain('video');
    for (let i = 0; i < 3; i++) ve.setParam(`m${i}`, 'freeze', 1);
    w.__videoEnginePause = false;
  });
  await page.getByRole('tab', { name: 'crutchfield', exact: true }).click();
  await waitFrames(page, 4);
  await page.screenshot({ path: test.info().outputPath('crutchfield-face.png') });
  // Engine-local gate cycling must also update the action's visibility.
  await page.evaluate(() => {
    const w = window as unknown as { __engine: () => { getDomain(d: string): { setParam(id: string, key: string, value: number): void } } };
    const ve = w.__engine().getDomain('video');
    ve.setParam('m0', 'tvGate', 0); ve.setParam('m0', 'tvGate', 1);
  });
  await expect(reroll).toBeHidden();
});

// Keep this independent negative control in its own rack. Carrying these two
// extra cameras through the UI reroll check rendered 5 loops where 2 sufficed;
// CI traces measured 57–66 s just for that rack's initial eight fields.
test('zero variation makes sensor seed inert', async ({ page }) => {
  test.setTimeout(90_000);
  const step = await boot(page, [{ sensorSeed: 167, sensorVariation: 0 },
    { sensorSeed: 49820, sensorVariation: 0 }]);
  assertRenderStats(await step('m0', 8), 8);
  const p = await pictures(page, 2);
  expect(difference(p[0]!, p[1]!), 'negative control: seed cannot act when variation is zero').toBe(0);
});

test('camera angle, focus and colour gain change the iterated image', async ({ page }) => {
  test.setTimeout(120_000);
  const step = await boot(page, [{}, { camTiltX: 0.13, camTiltY: -0.08 }, { focus: 1 }, { r: 0.4, b: 1.5 }]);
  assertRenderStats(await step('m0', 8), 8);
  const p = await pictures(page, 4);
  for (let i = 1; i < p.length; i++) expect(difference(p[0]!, p[i]!), `physical stage ${i}`).toBeGreaterThan(0.2);
});

test('closing the iris exposes charge decay; freeze holds both physical histories', async ({ page }) => {
  test.setTimeout(90_000);
  const step = await boot(page, [{ sensorLag: 0.025 }, { sensorLag: 0 }]);
  assertRenderStats(await step('m0', 8), 8);
  await page.evaluate(() => {
    const w = window as unknown as { __engine: () => { getDomain(d: string): { setParam(id: string, key: string, value: number): void } } };
    const ve = w.__engine().getDomain('video');
    ve.setParam('m0', 'exposure', 0); ve.setParam('m1', 'exposure', 0);
  });
  const fading = await step('m0', 1);
  const closed = await step('m1', 0);
  expect(closed.mean).toBe(0);
  expect(fading.mean).toBeGreaterThan(5);
  await page.evaluate(() => {
    const w = window as unknown as { __engine: () => { getDomain(d: string): { setParam(id: string, key: string, value: number): void } } };
    w.__engine().getDomain('video').setParam('m0', 'freeze', 1);
  });
  const held = await step('m0', 8);
  expect(held.mean).toBe(fading.mean);
  expect(held.glErrors).toEqual([]);
  await page.evaluate(() => {
    const w = window as unknown as { __engine: () => { getDomain(d: string): { setParam(id: string, key: string, value: number): void } } };
    w.__engine().getDomain('video').setParam('m0', 'freeze', 0);
  });
  // Ten fields cover >6 time constants at 25 ms, including the slowest RGB
  // channel; this measures the same exponential tail without 36 GPU draws.
  const decayed = await step('m0', 10);
  expect(decayed.mean).toBeLessThan(fading.mean * 0.01);
  expect(decayed.glErrors).toEqual([]);
});

test('monitor decay changes the transient independently of sensor charge', async ({ page }) => {
  test.setTimeout(90_000);
  const step = await boot(page, [{ tubeDecay: 0, sensorLag: 0 }, { tubeDecay: 0.5, sensorLag: 0 }]);
  assertRenderStats(await step('m0', 8), 8);
  await page.evaluate(() => {
    const w = window as unknown as { __engine: () => { getDomain(d: string): { setParam(id: string, key: string, value: number): void } } };
    const ve = w.__engine().getDomain('video');
    for (const id of ['m0', 'm1']) for (const [key, value] of Object.entries({ feedback: 0, room: 0, blackLevel: -0.3 })) ve.setParam(id, key, value);
  });
  const fast = await step('m0', 1);
  const slow = await step('m1', 0);
  expect(fast.mean, 'zero emission + zero sensor memory is black immediately').toBe(0);
  expect(slow.mean, 'only monitor history remains after cutting the drive').toBeGreaterThan(1);
  expect(slow.glErrors).toEqual([]);
});

test('the physical loop restarts after mode re-entry and reallocates at the current aspect', async ({ page }) => {
  test.setTimeout(90_000);
  const step = await boot(page, [{}]);
  assertRenderStats(await step('m0', 8), 8);
  await page.evaluate(() => {
    const w = window as unknown as { __engine: () => { getDomain(d: string): { setParam(id: string, key: string, value: number): void } } };
    w.__engine().getDomain('video').setParam('m0', 'tvMode', 0);
  });
  expect((await step('m0', 2)).glErrors).toEqual([]);
  await page.evaluate(() => {
    const w = window as unknown as { __engine: () => { getDomain(d: string): {
      setParam(id: string, key: string, value: number): void;
      setResolution(width: number, height: number): boolean;
    } } };
    const ve = w.__engine().getDomain('video');
    ve.setParam('m0', 'tvMode', 3);
    ve.setResolution(1366, 768);
  });
  assertRenderStats(await step('m0', 8), 8);
});
