// e2e/tests/toybox-disk-loading.spec.ts
//
// TOYBOX disk-loading of CUSTOM shaders + OBJ models — end-to-end pixel proofs.
//
//   1. a layer with an inline custom GEN shader (layer.shaderSrc, void main +
//      out vec4) renders the expected solid MAGENTA — proving the engine
//      compiles + draws the disk-loaded source instead of the bundled content;
//   2. a layer with an inline custom Shadertoy shader (mainImage convention)
//      renders solid CYAN — proving Shadertoy-vs-GEN auto-detection on a custom
//      src goes through the mainImage->main shim;
//   3. an OBJ layer with an inline custom cube (layer.objSrc) renders NON-BLACK —
//      proving the in-house OBJ parser parses the disk-loaded text directly;
//   4. a bad/garbage custom shader src degrades gracefully — the layer renders
//      its prior content (or black), NO page crash.
//
// DETERMINISTIC BY DESIGN: assertions read the live node.data (Yjs) + COARSE
// canvas colour signatures (solid-fill colour buckets, lit-pixel ratios) — NO
// fragile pixel-diffs — so they survive the CI SwiftShader renderer. iTime is
// pinned via window.__toyboxFreeze; generous cold-SwiftShader budgets per the
// `ci-swiftshader-video-e2e-timeouts` discipline.
//
// SwiftShader-cheap (GPU-attest rebuild, glsmoke-floor-expansion): TOYBOX is
// renderLocus:'worker-experimental' (PR V2), and the experimental tier only
// engages under the EXPLICIT flag (__videoWorkerEnabled / ?videoworker=1 —
// only the dedicated render-worker-*.spec.ts files set it), so this spec
// renders TOYBOX on the MAIN thread via its standard factory. The pixels it reads come from the on-card
// 2D `toybox-canvas`, populated by __toyboxFreeze's DIRECT engine.step() +
// blitOutputToDrawingBuffer — NOT from a free-running worker. The only reason this
// blew its budget on CI's software renderer was TOYBOX's live main-thread rAF
// render loop grinding UNPAUSED underneath the deterministic __toyboxFreeze frames.
// spawnToybox() now calls installRenderSmokeHooks(page) BEFORE page.goto — it sets
// __videoEnginePause (the background rAF loop IDLES, so step() never auto-advances
// on the tick → the slow background render cost is gone) + __videoEngineFreezeTime
// (pins the engine clock). DIRECT step() calls — the __toyboxFreeze path this spec
// drives every frame — are explicitly UNAFFECTED (engine.ts step() runs in full
// when called directly), so the engine still compiles the disk-loaded shader/OBJ
// and blits a real frame. NO assertion changed: every node.data / lit-pixel /
// colour-channel / no-crash / recovery check is byte-identical. This spec no longer
// needs the serialized real-GPU heavy lane — it runs in the normal parallel shards.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { installRenderSmokeHooks } from './_render-smoke';

type DLGlobal = {
  __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
  __ydoc: { transact: (fn: () => void) => void };
  __toyboxFreeze?: (t?: number) => void;
};

// A minimal valid GEN custom shader in the engine's GLSL ES 300 convention
// (#version 300 es + out vec4 + void main); paints solid magenta.
const CUSTOM_GEN_MAGENTA = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform float iTime;
uniform vec2 iResolution;
void main() {
  outColor = vec4(1.0, 0.0, 1.0, 1.0);
}
`;

// A minimal valid CUSTOM Shadertoy shader (mainImage convention); paints solid
// cyan. Exercises the auto-detected mainImage->main shim path on a custom src.
const CUSTOM_ST_CYAN = `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  fragColor = vec4(0.0, 1.0, 1.0, 1.0);
}
`;

// A tiny unit cube as inline OBJ text (8 verts, 12 tris). No normals — the parser
// computes flat normals. Auto-framed to ~unit at the origin so it fills the view.
const CUSTOM_OBJ_CUBE = `# inline cube
v -1 -1 -1
v  1 -1 -1
v  1  1 -1
v -1  1 -1
v -1 -1  1
v  1 -1  1
v  1  1  1
v -1  1  1
f 1 2 3
f 1 3 4
f 5 6 7
f 5 7 8
f 1 5 8
f 1 8 4
f 2 6 7
f 2 7 3
f 4 8 7
f 4 7 3
f 1 5 6
f 1 6 2
`;

async function pinViewport(page: Page): Promise<void> {
  await page.evaluate(() => {
    const vp = document.querySelector('.svelte-flow__viewport') as HTMLElement | null;
    if (!vp) return;
    vp.style.transition = 'none';
    vp.style.transform = 'translate(8px, -24px) scale(1)';
  });
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
}

async function spawnToybox(page: Page): Promise<void> {
  // SwiftShader-cheap: pause the engine's background rAF render loop + pin the
  // engine clock BEFORE boot so TOYBOX's live main-thread render doesn't grind the
  // software renderer under this deterministic pixel spec (the sole cause of the CI
  // budget overrun). The DIRECT step() calls the spec drives via __toyboxFreeze are
  // unaffected, so every disk-loaded shader/OBJ render + lit-pixel/colour assertion
  // below still holds, byte-identical.
  await installRenderSmokeHooks(page);
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [{ id: 'tb', type: 'toybox', position: { x: 80, y: 40 }, domain: 'video' }],
    [],
  );
  await page.locator('.svelte-flow__node-toybox').first().waitFor({ state: 'visible', timeout: 10_000 });
  await pinViewport(page);
}

/** Set TOYBOX layer 0 directly on the live node — supports inline shaderSrc /
 *  objSrc, exactly as the card's setLayerShaderSource / setLayerObjSource writes.
 *  Resumes the clock so the new content compiles on the next step. */
async function setLayer0(
  page: Page,
  layer: Record<string, unknown>,
): Promise<void> {
  await page.evaluate((layer) => {
    const w = globalThis as unknown as DLGlobal;
    w.__toyboxFreeze?.(); // resume the clock so the new content compiles
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['tb'];
      if (!n) return;
      if (!n.data) n.data = {};
      n.data.layers = [
        layer,
        { kind: 'off', contentId: null, params: {} },
        { kind: 'off', contentId: null, params: {} },
        { kind: 'off', contentId: null, params: {} },
      ];
    });
  }, layer);
}

/** Sample the preview canvas: lit-pixel count + a coarse mean colour signature
 *  (0..255 per channel) + the per-channel means, for solid-fill colour asserts. */
async function sampleCanvas(
  page: Page,
): Promise<{ lit: number; total: number; r: number; g: number; b: number }> {
  return page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="toybox-canvas"]') as HTMLCanvasElement | null;
    if (!canvas) return { lit: 0, total: 0, r: 0, g: 0, b: 0 };
    const c2d = canvas.getContext('2d');
    if (!c2d) return { lit: 0, total: 0, r: 0, g: 0, b: 0 };
    const { data } = c2d.getImageData(0, 0, canvas.width, canvas.height);
    let lit = 0, r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i]! > 16 || data[i + 1]! > 16 || data[i + 2]! > 16) lit++;
      r += data[i]!; g += data[i + 1]!; b += data[i + 2]!; n++;
    }
    return {
      lit,
      total: canvas.width * canvas.height,
      r: Math.round(r / n),
      g: Math.round(g / n),
      b: Math.round(b / n),
    };
  });
}

/** Pin iTime + advance engine steps until `pred(sample)` holds (so a cold
 *  SwiftShader compile/first-draw lag never one-shot flakes). */
async function waitForCanvas(
  page: Page,
  pred: (s: { lit: number; total: number; r: number; g: number; b: number }) => boolean,
  timeout = 30_000,
): Promise<void> {
  await expect
    .poll(
      async () => {
        await page.evaluate(() => {
          (globalThis as unknown as DLGlobal).__toyboxFreeze?.(1.5);
        });
        return pred(await sampleCanvas(page));
      },
      { timeout, intervals: [250, 250, 500, 500, 1000] },
    )
    .toBe(true);
}

test.describe('TOYBOX disk-loading (custom shaders + OBJ)', () => {
  test('a custom GEN shaderSrc renders the expected MAGENTA + no errors', async ({ page }) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await spawnToybox(page);
    await setLayer0(page, { kind: 'gen', contentId: null, shaderSrc: CUSTOM_GEN_MAGENTA, shaderName: 'mag.glsl', params: {} });

    // Solid magenta: R high, G low, B high, fully lit.
    await waitForCanvas(page, (s) => s.lit > s.total * 0.9 && s.r > 150 && s.g < 80 && s.b > 150);
    const s = await sampleCanvas(page);
    expect(s.lit, 'custom GEN fills the frame').toBeGreaterThan(s.total * 0.9);
    expect(s.r, 'red channel high').toBeGreaterThan(150);
    expect(s.g, 'green channel low').toBeLessThan(80);
    expect(s.b, 'blue channel high').toBeGreaterThan(150);
    expect(errors.filter((e) => !e.includes('AudioContext')), 'no console / page errors').toEqual([]);
  });

  test('a custom Shadertoy shaderSrc (mainImage) renders CYAN via the shim', async ({ page }) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await spawnToybox(page);
    await setLayer0(page, { kind: 'gen', contentId: null, shaderSrc: CUSTOM_ST_CYAN, shaderName: 'cyan.frag', params: {} });

    // Solid cyan: R low, G high, B high.
    await waitForCanvas(page, (s) => s.lit > s.total * 0.9 && s.r < 80 && s.g > 150 && s.b > 150);
    const s = await sampleCanvas(page);
    expect(s.r, 'red channel low').toBeLessThan(80);
    expect(s.g, 'green channel high').toBeGreaterThan(150);
    expect(s.b, 'blue channel high').toBeGreaterThan(150);
    expect(errors.filter((e) => !e.includes('AudioContext')), 'no console / page errors').toEqual([]);
  });

  test('an OBJ layer with inline objSrc (cube) renders NON-BLACK', async ({ page }) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await spawnToybox(page);
    // OBJ layer: a material (matcap-shaded) + the inline cube text. Spin held at 0
    // and a default rotation so a face is visible regardless of iTime.
    await setLayer0(page, {
      kind: 'obj',
      contentId: null,
      objSrc: CUSTOM_OBJ_CUBE,
      objName: 'cube.obj',
      params: {},
      material: {
        modelId: 'cube', rotX: 0.5, rotY: 0.6, rotZ: 0, scale: 1.4, spin: 0,
        matcap: 0, tintR: 1, tintG: 1, tintB: 1,
      },
    });

    // The matcap-shaded cube lights a meaningful fraction of the frame (it sits at
    // the origin auto-framed to ~unit). Not a solid fill (it's geometry on black),
    // so assert a healthy lit fraction rather than a colour.
    await waitForCanvas(page, (s) => s.lit > s.total * 0.1);
    const s = await sampleCanvas(page);
    expect(s.lit, 'custom OBJ cube renders non-black').toBeGreaterThan(s.total * 0.1);
    expect(errors.filter((e) => !e.includes('AudioContext')), 'no console / page errors').toEqual([]);
  });

  test('a BAD custom shaderSrc degrades gracefully (no crash)', async ({ page }) => {
    test.setTimeout(90_000);
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    await spawnToybox(page);
    // Garbage that cannot compile. The failedShader guard must console.warn + skip
    // — the layer renders nothing, but the page must NOT crash.
    await setLayer0(page, { kind: 'gen', contentId: null, shaderSrc: 'this is not glsl at all {{{', shaderName: 'bad.glsl', params: {} });

    // Advance several frames; the engine must keep running (no pageerror / crash).
    for (let i = 0; i < 8; i++) {
      await page.evaluate(() => (globalThis as unknown as DLGlobal).__toyboxFreeze?.(1.0));
      await page.waitForTimeout(80);
    }
    // The card + canvas are still alive (no white-screen crash).
    await expect(page.locator('[data-testid="toybox-canvas"]')).toBeVisible();
    expect(pageErrors, 'a bad uploaded shader does not crash the page').toEqual([]);

    // Swapping back to a GOOD custom shader recovers (the cache is per-source).
    await setLayer0(page, { kind: 'gen', contentId: null, shaderSrc: CUSTOM_GEN_MAGENTA, shaderName: 'mag.glsl', params: {} });
    await waitForCanvas(page, (s) => s.r > 150 && s.g < 80 && s.b > 150);
    expect(pageErrors).toEqual([]);
  });
});
