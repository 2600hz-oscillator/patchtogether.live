// e2e/vrt/vrt-toybox.spec.ts
//
// Dedicated per-content VRT for TOYBOX (Phase 1). Spawns a TOYBOX, points
// layer 0 at each of the four bundled shaders in turn, FREEZES the engine
// clock deterministically (window.__toyboxFreeze(time) pins iTime to a
// constant + forces one render + holds the on-card preview), and snapshots
// the card's live preview canvas.
//
// Proves each shader renders REAL content (not black) AND that the four
// render DISTINCTLY: the baselines are captured per content id, so a
// regression that (e.g.) compiles the wrong GLSL or drops a uniform shows
// up as a pixel diff against the right shader's frozen frame.
//
// Determinism: a fragment shader at a FIXED iTime is a pure function of the
// pixel coords + its float uniforms, so pinning iTime makes the FBO pixel-
// stable across runs. We wait until the freeze-rendered canvas is non-black
// (the async GLSL fetch+compile has landed) before screenshotting.
//
// Informational lane (`task vrt`, FULL_MATCH) — darwin baseline captured
// locally; linux pending a `task vrt:update` on CI (see EXEMPT_BASELINE_PAIRS
// → linux/toybox + the linux/toybox-<id> pairs below).
//
// Output: e2e/vrt/__screenshots__/vrt-toybox.spec.ts/{platform}/<id>.png

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from '../tests/_helpers';

const VRT_PLATFORM = process.platform === 'darwin' ? 'darwin' : 'linux';

// The four bundled content ids + the layer `kind` each maps to (GEN → 'gen',
// FX → 'shader'). Frozen iTime is fixed per id so the captured frame is
// reproducible; different times per shader keep the baselines visually
// distinct + interesting.
const CONTENTS: Array<{ id: string; kind: 'gen' | 'shader'; time: number }> = [
  { id: 'noise-fbm',    kind: 'gen',    time: 3.0 },
  { id: 'worley-cells', kind: 'gen',    time: 2.0 },
  { id: 'hsv-plasma',   kind: 'shader', time: 4.0 },
  { id: 'cos-gradient', kind: 'shader', time: 5.0 },
];

test.describe.configure({ mode: 'default' });

/**
 * Pin the Svelte Flow viewport to a fixed transform (scale 1) so the captured
 * canvas DOM box is always the same pixel size. Without this, `fitView`
 * auto-zooms to fit the single spawned node at a zoom that depends on
 * layout/paint timing, so the screenshot element size drifts run-to-run
 * (340×255 vs 372×279). We freeze the transform AND kill the zoom transition
 * so the canvas renders at its intrinsic 200×150 (× devicePixelRatio).
 */
async function pinViewport(page: Page): Promise<void> {
  await page.evaluate(() => {
    const vp = document.querySelector('.svelte-flow__viewport') as HTMLElement | null;
    if (!vp) return;
    vp.style.transition = 'none';
    vp.style.transform = 'translate(0px, 0px) scale(1)';
  });
  // Settle one rAF so the new transform is applied before capture.
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
}

/** Point TOYBOX layer 0 at `id`, freeze iTime to `time`, wait until the
 *  frozen preview canvas is non-black (shader compiled + rendered). */
async function setContentAndFreeze(page: Page, id: string, kind: string, time: number): Promise<void> {
  // Resume the clock first (clears any prior freeze) so step() advances and
  // the new content compiles + renders before we re-pin.
  await page.evaluate(() => {
    const g = globalThis as unknown as { __toyboxFreeze?: (t?: number) => void };
    g.__toyboxFreeze?.();
  });

  // Mutate the live node's layer 0 to the new content (the factory reads the
  // live node each frame + lazily compiles the new GLSL).
  await page.evaluate(
    ({ id, kind }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['tb'];
        if (!n) return;
        if (!n.data) n.data = {};
        n.data.layers = [
          { kind, contentId: id, params: {} },
          { kind: 'shader', contentId: null, params: {} },
          { kind: 'shader', contentId: null, params: {} },
          { kind: 'shader', contentId: null, params: {} },
        ];
      });
    },
    { id, kind },
  );

  // Poll until the live preview shows non-black pixels (async fetch+compile
  // done + at least one render landed), then freeze.
  await page.waitForFunction(
    ({ time }) => {
      const g = globalThis as unknown as { __toyboxFreeze?: (t?: number) => void };
      // Freeze renders one frame at the pinned time + blits it to the canvas.
      g.__toyboxFreeze?.(time);
      const canvas = document.querySelector(
        '[data-testid="toybox-canvas"]',
      ) as HTMLCanvasElement | null;
      if (!canvas) return false;
      const c2d = canvas.getContext('2d');
      if (!c2d) return false;
      const { data } = c2d.getImageData(0, 0, canvas.width, canvas.height);
      // Count clearly-non-black pixels — a compiled shader fills the frame.
      let lit = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i]! > 16 || data[i + 1]! > 16 || data[i + 2]! > 16) lit++;
      }
      // Require a healthy fraction lit so we don't snapshot a half-painted
      // (still-clearing) frame. ~10% of the 200×150 preview is plenty.
      return lit > (canvas.width * canvas.height) * 0.1;
    },
    { time },
    { timeout: 10_000 },
  );

  // Settle one rAF so the (frozen) canvas is fully painted before capture.
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
}

// ── Phase 3: OBJ models. Each baseline freezes a FIXED matcap + FIXED
// rotation (spin = 0, so the model pose is fully deterministic at any pinned
// iTime), proving the OBJ pass renders recognizable LIT 3D geometry into the
// layer FBO and the combine stage carries it to the module output. `spot`
// (a bundled CC0 OBJ with computed flat normals + quad fan-triangulation),
// `teapot` (a bundled CC0 OBJ with explicit normals), and `sphere` (a built-
// in procedural primitive, no asset file) cover all three mesh sources.
const MODELS: Array<{ id: string; matcap: number; time: number }> = [
  { id: 'teapot', matcap: 0, time: 1.0 }, // CHROME
  { id: 'spot',   matcap: 1, time: 1.0 }, // CLAY
  { id: 'sphere', matcap: 2, time: 1.0 }, // NEON (builtin primitive)
];

/** Point TOYBOX layer 0 at an OBJ model with a fixed pose + matcap, freeze
 *  iTime, wait until the frozen preview canvas shows lit geometry. */
async function setObjAndFreeze(
  page: Page,
  modelId: string,
  matcap: number,
  time: number,
): Promise<void> {
  await page.evaluate(() => {
    const g = globalThis as unknown as { __toyboxFreeze?: (t?: number) => void };
    g.__toyboxFreeze?.();
  });

  await page.evaluate(
    ({ modelId, matcap }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['tb'];
        if (!n) return;
        if (!n.data) n.data = {};
        n.data.layers = [
          {
            kind: 'obj',
            contentId: null,
            params: {},
            // Fixed pose (spin = 0 → deterministic) + fixed matcap/tint.
            material: {
              modelId,
              rotX: 0.5,
              rotY: 0.7,
              rotZ: 0,
              scale: 1,
              spin: 0,
              matcap,
              tintR: 1,
              tintG: 1,
              tintB: 1,
            },
          },
          { kind: 'off', contentId: null, params: {} },
          { kind: 'off', contentId: null, params: {} },
          { kind: 'off', contentId: null, params: {} },
        ];
      });
    },
    { modelId, matcap },
  );

  // Poll until the frozen preview shows lit (non-black) geometry — the async
  // OBJ fetch+parse+upload (or primitive build) has landed + a frame rendered.
  await page.waitForFunction(
    ({ time }) => {
      const g = globalThis as unknown as { __toyboxFreeze?: (t?: number) => void };
      g.__toyboxFreeze?.(time);
      const canvas = document.querySelector(
        '[data-testid="toybox-canvas"]',
      ) as HTMLCanvasElement | null;
      if (!canvas) return false;
      const c2d = canvas.getContext('2d');
      if (!c2d) return false;
      const { data } = c2d.getImageData(0, 0, canvas.width, canvas.height);
      let lit = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i]! > 16 || data[i + 1]! > 16 || data[i + 2]! > 16) lit++;
      }
      // A framed 3D model fills a smaller fraction than a fullscreen shader;
      // require a visible-but-modest lit area (≥2% of the preview).
      return lit > (canvas.width * canvas.height) * 0.02;
    },
    { time },
    { timeout: 10_000 },
  );

  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
}

test.describe('VRT: TOYBOX per-content frozen render', () => {
  for (const c of CONTENTS) {
    test(`${c.id} renders real frozen content`, async ({ page }) => {
      test.skip(
        VRT_PLATFORM === 'linux',
        `linux/toybox-${c.id}: darwin baseline only; linux pending a vrt:update on CI`,
      );

      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });

      await page.goto('/');
      await page.waitForLoadState('networkidle');

      await spawnPatch(
        page,
        [{ id: 'tb', type: 'toybox', position: { x: 80, y: 40 }, domain: 'video' }],
        [],
      );

      const card = page.locator('.svelte-flow__node-toybox').first();
      await card.waitFor({ state: 'visible', timeout: 10_000 });
      await pinViewport(page);

      await setContentAndFreeze(page, c.id, c.kind, c.time);

      const canvas = page.locator('[data-testid="toybox-canvas"]');
      await expect(canvas).toHaveScreenshot(`${c.id}.png`, {
        maskColor: '#ff00ff',
      });

      expect(
        errors.filter((e) => !e.includes('AudioContext')),
        'no console / page errors',
      ).toEqual([]);
    });
  }
});

test.describe('VRT: TOYBOX OBJ layer frozen render', () => {
  for (const m of MODELS) {
    test(`obj ${m.id} renders recognizable lit 3D geometry`, async ({ page }) => {
      test.skip(
        VRT_PLATFORM === 'linux',
        `linux/toybox-obj-${m.id}: darwin baseline only; linux pending a vrt:update on CI`,
      );

      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (msg) => {
        if (msg.type() === 'error') errors.push(msg.text());
      });

      await page.goto('/');
      await page.waitForLoadState('networkidle');

      await spawnPatch(
        page,
        [{ id: 'tb', type: 'toybox', position: { x: 80, y: 40 }, domain: 'video' }],
        [],
      );

      const card = page.locator('.svelte-flow__node-toybox').first();
      await card.waitFor({ state: 'visible', timeout: 10_000 });
      await pinViewport(page);

      await setObjAndFreeze(page, m.id, m.matcap, m.time);

      const canvas = page.locator('[data-testid="toybox-canvas"]');
      await expect(canvas).toHaveScreenshot(`obj-${m.id}.png`, {
        maskColor: '#ff00ff',
      });

      expect(
        errors.filter((e) => !e.includes('AudioContext')),
        'no console / page errors',
      ).toEqual([]);
    });
  }
});
