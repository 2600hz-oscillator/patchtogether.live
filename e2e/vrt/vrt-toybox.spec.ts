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
// Informational lane (`task vrt`, FULL_MATCH).
// Baselines are authored by LINUX CI — one set, no {platform} segment (see
// vrt.config.ts). `task vrt:commit` dispatches the capture; a local macOS run
// is a smoke test, not a capture.
//
// Output: e2e/vrt/__screenshots__/vrt-toybox.spec.ts/<id>.png

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch, ensureCombineOpen } from '../tests/_helpers';
import { pinVrtFonts, awaitVrtFonts } from './_fonts';

// The four bundled content ids + the layer `kind` each maps to (GEN → 'gen',
// FX → 'shader'). Frozen iTime is fixed per id so the captured frame is
// reproducible; different times per shader keep the baselines visually
// distinct + interesting.
const CONTENTS: Array<{ id: string; kind: 'gen' | 'shader'; time: number }> = [
  { id: 'noise-fbm',        kind: 'gen',    time: 3.0 },
  { id: 'worley-cells',     kind: 'gen',    time: 2.0 },
  { id: 'hsv-plasma',       kind: 'shader', time: 4.0 },
  { id: 'cos-gradient',     kind: 'shader', time: 5.0 },
  // Shadertoy single-pass GEN port (mainImage->main shim, iResolution vec3).
  { id: 'synthwave-sunset', kind: 'gen',    time: 3.0 },
  // Representative baseline for the expanded GEN bank (content-bank PR): one
  // animated procedural pattern proves the new GEN shaders compile + render
  // real frozen content. The rest of the new GEN/FRAG shaders are covered by
  // the manifest-integrity unit (file-exists + uniform/param cross-check) +
  // the live compile-smoke e2e; per-asset VRT baselines would bloat the gate.
  { id: 'truchet',          kind: 'gen',    time: 2.0 },
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
  // Representative baseline for the expanded BUILTIN bank (content-bank PR):
  // the icosahedron ("d20") proves a NEW procedural primitive generates valid
  // lit geometry through the OBJ pass. The other new builtins (tetra/octa/
  // cylinder/cone/torus-knot) are covered by primitives.test.ts (non-degenerate
  // + unit normals + makePrimitive dispatch); per-asset VRT would bloat.
  { id: 'icosahedron', matcap: 0, time: 1.0 }, // CHROME (builtin primitive)
  // A CC0 bird OBJ (the flighty hero mesh) — proves the added bird meshes parse
  // + render as recognizable lit geometry through the OBJ pass. spin=0 + no flap
  // field → a fully deterministic static pose (this MODELS path sets no flap).
  { id: 'bird-ernest', matcap: 1, time: 1.0 }, // CLAY
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

      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });

      // Pin the bundled Inter/JetBrains Mono BEFORE the first navigation and
      // await their decode after load — the app resolves card text through
      // GENERIC stacks (system-ui / ui-monospace) that fontconfig picks
      // nondeterministically, and document.fonts.ready can't see them. Without
      // this the captured text metrics differ run-to-run and platform-to-platform.
      // Full root cause: e2e/vrt/_fonts.ts.
      await pinVrtFonts(page);
      await page.goto('/rack?seed=none');
      await page.waitForLoadState('networkidle');
      await awaitVrtFonts(page);

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

      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (msg) => {
        if (msg.type() === 'error') errors.push(msg.text());
      });

      await pinVrtFonts(page);
      await page.goto('/rack?seed=none');
      await page.waitForLoadState('networkidle');
      await awaitVrtFonts(page);

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

// ── Phase 4: the user-EDITABLE combine GRAPH. Two baselines:
//   1. combine-composite — a NON-DEFAULT combine graph (a MAP op multiplying
//      layer 0 × layer 1, routed to OUTPUT) frozen at a fixed iTime; proves the
//      DAG engine evaluates an edited graph to the expected composite (distinct
//      from the layer-0-only default).
//   2. combine-editor — the bespoke SVG node editor itself in a DETERMINISTIC
//      state (default graph, freshly seeded, editor open); proves the boxes +
//      ports + cables render. The SVG is static data (no animation) so it's
//      pixel-stable.

/** Set a NON-DEFAULT combine graph that reroutes the OUTPUT to a different
 *  source than the layer-0 default: layer 1 (worley) → a FADE pass → OUTPUT.
 *  This proves the DAG engine honours an edited graph (the output is layer 1,
 *  not the default base layer 0). A single source shader keeps the frozen
 *  composite pixel-deterministic across page loads (a multiply of two shaders
 *  raced on compile order; one shader does not). */
async function setCombineAndFreeze(page: Page, time: number): Promise<void> {
  await page.evaluate(() => {
    const g = globalThis as unknown as { __toyboxFreeze?: (t?: number) => void };
    g.__toyboxFreeze?.();
  });
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['tb'];
      if (!n) return;
      if (!n.data) n.data = {};
      // Layer 0 (the default base) is a plain noise; layer 1 (worley) is the
      // one we REROUTE to the output via the edited graph.
      n.data.layers = [
        { kind: 'gen', contentId: 'noise-fbm', params: {} },
        { kind: 'gen', contentId: 'worley-cells', params: {} },
        { kind: 'off', contentId: null, params: {} },
        { kind: 'off', contentId: null, params: {} },
      ];
      // Edited GRAPH: src1 → FADE(t 0 = pass-through) → OUTPUT. The OUTPUT now
      // shows LAYER 1, not the default layer-0 base — a clearly non-default
      // composite proving the engine evaluates the user's graph.
      n.data.combine = {
        nodes: [
          { id: 'src0', kind: 'source', layer: 0, x: 14, y: 14 },
          { id: 'src1', kind: 'source', layer: 1, x: 14, y: 66 },
          { id: 'src2', kind: 'source', layer: 2, x: 14, y: 118 },
          { id: 'src3', kind: 'source', layer: 3, x: 14, y: 170 },
          { id: 'passop', kind: 'fade', x: 120, y: 60, params: { amount: 0 } },
          { id: 'out', kind: 'output', x: 286, y: 66 },
        ],
        edges: [
          { id: 'e1', from: 'src1', to: 'passop', toPort: 'in0' },
          { id: 'e3', from: 'passop', to: 'out', toPort: 'in0' },
        ],
      };
    });
  });
  // Poll until the FROZEN composite is STABLE — both layer shaders compiled +
  // rendered AND two consecutive freeze captures match. (A single ">lit"
  // threshold can snapshot a frame where only layer 0 has compiled, so the
  // multiply composite differs run-to-run; requiring stability gates that out.)
  await page.waitForFunction(
    ({ time }) => {
      const g = globalThis as unknown as {
        __toyboxFreeze?: (t?: number) => void;
        __toyboxPrevSig?: string;
      };
      g.__toyboxFreeze?.(time);
      const canvas = document.querySelector('[data-testid="toybox-canvas"]') as HTMLCanvasElement | null;
      if (!canvas) return false;
      const c2d = canvas.getContext('2d');
      if (!c2d) return false;
      const { data } = c2d.getImageData(0, 0, canvas.width, canvas.height);
      let lit = 0;
      let r = 0, gg = 0, b = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i]! > 16 || data[i + 1]! > 16 || data[i + 2]! > 16) lit++;
        r += data[i]!; gg += data[i + 1]!; b += data[i + 2]!;
      }
      if (lit <= canvas.width * canvas.height * 0.05) return false;
      // Coarse signature (rounded average) — stable once both shaders rendered.
      const sig = `${Math.round(r / 5000)},${Math.round(gg / 5000)},${Math.round(b / 5000)}`;
      const prev = g.__toyboxPrevSig;
      g.__toyboxPrevSig = sig;
      return prev === sig;
    },
    { time },
    { timeout: 10_000 },
  );
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
}

// ── Phase 5: CV-ROUTE proof. A TOYBOX with cv2 routed to a FADE op's `t`
// (amount) crossfading layer 0 (noise) ↔ layer 1 (cos-gradient). We drive the
// GENERIC cv2 port through the ENGINE's real setParam(cv2, ±1) — the exact
// Phase-5 path — which resolves cvRoutes.cv2, re-scales the ±1 across the fade
// param's 0..1 range (centred on the op's amount=0.5), and writes it into the
// live combine param. Two baselines: cv2 = -1 (→ amount 0, shows layer 0) vs
// cv2 = +1 (→ amount 1, shows layer 1). They MUST differ — proving a CV moves
// the composite via the generic pool + per-param routing.

/** Seed the cv2→fade.t patch, drive the generic cv2 port to `raw` through the
 *  engine's setParam (the real bridge path), freeze + wait for a stable frame. */
async function setCvRouteAndFreeze(page: Page, raw: number, time: number): Promise<void> {
  await page.evaluate(() => {
    const g = globalThis as unknown as { __toyboxFreeze?: (t?: number) => void };
    g.__toyboxFreeze?.();
  });
  // Seed layers + a crossfade combine graph + the cv2→fade.t route (once;
  // re-seeding is idempotent for the same content).
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['tb'];
      if (!n) return;
      if (!n.data) n.data = {};
      n.data.layers = [
        { kind: 'gen', contentId: 'noise-fbm', params: {} },
        { kind: 'gen', contentId: 'cos-gradient', params: {} },
        { kind: 'off', contentId: null, params: {} },
        { kind: 'off', contentId: null, params: {} },
      ];
      // FADE crossfade: src0 (base) ↔ src1 (top), amount seeded at 0.5 (the
      // modulation centre cv2 sweeps around). cv2 = -1 → 0 (base), +1 → 1 (top).
      n.data.combine = {
        nodes: [
          { id: 'src0', kind: 'source', layer: 0, x: 14, y: 14 },
          { id: 'src1', kind: 'source', layer: 1, x: 14, y: 66 },
          { id: 'src2', kind: 'source', layer: 2, x: 14, y: 118 },
          { id: 'src3', kind: 'source', layer: 3, x: 14, y: 170 },
          { id: 'xf', kind: 'fade', x: 120, y: 40, params: { amount: 0.5 } },
          { id: 'out', kind: 'output', x: 286, y: 40 },
        ],
        edges: [
          { id: 'e0', from: 'src0', to: 'xf', toPort: 'in0' },
          { id: 'e1', from: 'src1', to: 'xf', toPort: 'in1' },
          { id: 'e2', from: 'xf', to: 'out', toPort: 'in0' },
        ],
      };
      // Route the generic cv2 port → the FADE op's amount (t).
      n.data.cvRoutes = { cv2: { target: 'combine', nodeId: 'xf', param: 'amount' } };
    });
  });
  // Drive the GENERIC cv2 port via the engine's real setParam path (resolves
  // the route + re-scales + writes the live combine param).
  await page.evaluate(
    ({ raw }) => {
      const w = globalThis as unknown as {
        __engine?: () => unknown;
      };
      type VE = { setParam: (nodeId: string, paramId: string, value: number) => void };
      type Eng = { getDomain: <T>(d: string) => T };
      const e = (w.__engine ? (w.__engine() as Eng) : undefined);
      try {
        e?.getDomain<VE>('video')?.setParam('tb', 'cv2', raw);
      } catch { /* */ }
    },
    { raw },
  );
  // Poll until the frozen composite stabilises (both shaders compiled +
  // rendered AND two consecutive captures match). Re-drive cv2 each poll so the
  // route keeps writing the live param while shaders finish compiling.
  await page.waitForFunction(
    ({ time, raw }) => {
      const w = globalThis as unknown as {
        __toyboxFreeze?: (t?: number) => void;
        __toyboxPrevSig?: string;
        __engine?: () => unknown;
      };
      type VE = { setParam: (nodeId: string, paramId: string, value: number) => void };
      type Eng = { getDomain: <T>(d: string) => T };
      try {
        const e = w.__engine ? (w.__engine() as Eng) : undefined;
        e?.getDomain<VE>('video')?.setParam('tb', 'cv2', raw);
      } catch { /* */ }
      w.__toyboxFreeze?.(time);
      const canvas = document.querySelector('[data-testid="toybox-canvas"]') as HTMLCanvasElement | null;
      if (!canvas) return false;
      const c2d = canvas.getContext('2d');
      if (!c2d) return false;
      const { data } = c2d.getImageData(0, 0, canvas.width, canvas.height);
      let lit = 0, r = 0, gg = 0, b = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i]! > 16 || data[i + 1]! > 16 || data[i + 2]! > 16) lit++;
        r += data[i]!; gg += data[i + 1]!; b += data[i + 2]!;
      }
      if (lit <= canvas.width * canvas.height * 0.05) return false;
      const sig = `${Math.round(r / 5000)},${Math.round(gg / 5000)},${Math.round(b / 5000)}`;
      const prev = w.__toyboxPrevSig;
      w.__toyboxPrevSig = sig;
      return prev === sig;
    },
    { time, raw },
    { timeout: 10_000 },
  );
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
}

test.describe('VRT: TOYBOX Phase-5 CV-route proof', () => {
  for (const drive of [
    { name: 'cv2-low', raw: -1 },   // fade t → 0 : shows layer 0 (noise)
    { name: 'cv2-high', raw: 1 },   // fade t → 1 : shows layer 1 (cos-gradient)
  ]) {
    test(`cv2 → fade.t driven ${drive.name} composites distinctly`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });

      await pinVrtFonts(page);
      await page.goto('/rack?seed=none');
      await page.waitForLoadState('networkidle');
      await awaitVrtFonts(page);
      await spawnPatch(
        page,
        [{ id: 'tb', type: 'toybox', position: { x: 80, y: 40 }, domain: 'video' }],
        [],
      );
      const card = page.locator('.svelte-flow__node-toybox').first();
      await card.waitFor({ state: 'visible', timeout: 10_000 });
      await pinViewport(page);

      await setCvRouteAndFreeze(page, drive.raw, 2.0);

      const canvas = page.locator('[data-testid="toybox-canvas"]');
      await expect(canvas).toHaveScreenshot(`${drive.name}.png`, { maskColor: '#ff00ff' });

      expect(
        errors.filter((e) => !e.includes('AudioContext')),
        'no console / page errors',
      ).toEqual([]);
    });
  }
});

// ── Phase 6: the bundled PRESETS — the headline proof that load → layers
// (incl video/obj substitutes + gen + shader) → combine DAG → cv renders an
// end-to-end composite. Each baseline LOADS a preset via the debug hook
// window.__toyboxLoadPreset(id) (the same in-place Yjs mutation the dropdown
// fires), freezes iTime, and waits until the composited preview is STABLE (the
// async GLSL/OBJ fetches landed + two consecutive captures match), then
// snapshots. The four presets MUST be visibly distinct (different sources +
// combine ops).

const PRESETS: Array<{ id: string; time: number }> = [
  { id: 'plasma-dissolve', time: 4.0 },
  { id: 'cow-on-camera',   time: 1.0 },
  { id: 'worley-bloom',    time: 2.0 },
  { id: 'textured-sphere', time: 2.0 }, // Phase-6 texmap showcase
  { id: 'reactor-field',   time: 3.0 },
  // The FLIGHTY hero: a CC0 bird flapping over the animated flighty-sky GEN.
  // time chosen at a clear mid-flap phase (wings raised, not the flat sin=0
  // frame) so the frozen baseline actually proves the procedural wing-flap —
  // both the sky (iTime) and the flap (uTime) read the SAME freeze-aware time.
  { id: 'flighty',         time: 2.36 },
];

/** Load a bundled preset via the debug hook, freeze iTime, wait until the
 *  composited preview is non-black AND stable across two captures. */
async function loadPresetAndFreeze(page: Page, presetId: string, time: number): Promise<void> {
  // Resume the clock first so newly-referenced GLSL/OBJ compile + render.
  await page.evaluate(() => {
    const g = globalThis as unknown as { __toyboxFreeze?: (t?: number) => void };
    g.__toyboxFreeze?.();
  });
  // Wait for the hook to exist (catalog loaded), then load the preset.
  await page.waitForFunction(
    () => typeof (globalThis as unknown as { __toyboxLoadPreset?: unknown }).__toyboxLoadPreset === 'function',
    undefined,
    { timeout: 10_000 },
  );
  await page.evaluate(async (presetId) => {
    const g = globalThis as unknown as { __toyboxLoadPreset?: (id: string) => Promise<boolean> };
    await g.__toyboxLoadPreset?.(presetId);
  }, presetId);
  // Reset the stability tracker so it can't carry a prior preset's signature.
  await page.evaluate(() => {
    (globalThis as unknown as { __toyboxPrevSig?: string }).__toyboxPrevSig = '';
  });
  // Poll until the FROZEN composite is non-black AND stable (two consecutive
  // freeze captures match → all sources compiled + the DAG settled).
  await page.waitForFunction(
    ({ time }) => {
      const g = globalThis as unknown as {
        __toyboxFreeze?: (t?: number) => void;
        __toyboxPrevSig?: string;
      };
      g.__toyboxFreeze?.(time);
      const canvas = document.querySelector('[data-testid="toybox-canvas"]') as HTMLCanvasElement | null;
      if (!canvas) return false;
      const c2d = canvas.getContext('2d');
      if (!c2d) return false;
      const { data } = c2d.getImageData(0, 0, canvas.width, canvas.height);
      let lit = 0, r = 0, gg = 0, b = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i]! > 16 || data[i + 1]! > 16 || data[i + 2]! > 16) lit++;
        r += data[i]!; gg += data[i + 1]!; b += data[i + 2]!;
      }
      // ≥2% lit covers the framed-OBJ presets (cow / reactor) too.
      if (lit <= canvas.width * canvas.height * 0.02) return false;
      const sig = `${Math.round(r / 5000)},${Math.round(gg / 5000)},${Math.round(b / 5000)}`;
      const prev = g.__toyboxPrevSig;
      g.__toyboxPrevSig = sig;
      return prev === sig;
    },
    { time },
    { timeout: 15_000 },
  );
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
}

test.describe('VRT: TOYBOX Phase-6 presets', () => {
  for (const p of PRESETS) {
    test(`preset ${p.id} composites end-to-end`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });

      await pinVrtFonts(page);
      await page.goto('/rack?seed=none');
      await page.waitForLoadState('networkidle');
      await awaitVrtFonts(page);
      await spawnPatch(
        page,
        [{ id: 'tb', type: 'toybox', position: { x: 80, y: 40 }, domain: 'video' }],
        [],
      );
      const card = page.locator('.svelte-flow__node-toybox').first();
      await card.waitFor({ state: 'visible', timeout: 10_000 });
      await pinViewport(page);

      await loadPresetAndFreeze(page, p.id, p.time);

      const canvas = page.locator('[data-testid="toybox-canvas"]');
      await expect(canvas).toHaveScreenshot(`preset-${p.id}.png`, { maskColor: '#ff00ff' });

      expect(
        errors.filter((e) => !e.includes('AudioContext')),
        'no console / page errors',
      ).toEqual([]);
    });
  }
});

// ── Phase 6: TEXMAP — an OBJ layer UV-mapping ANOTHER layer's rendered output
// as a SURFACE TEXTURE (material.surfaceSource) instead of a flat matcap. Each
// baseline seeds layer 1 = a deterministic shader (worley) and layer 0 = an OBJ
// (sphere → authored-uv-less primitive uv path; teapot → the zero-vt PLANAR-UV
// fallback) with material.surfaceSource = 1, spin = 0. The combine OUTPUT shows
// layer 0 (the textured mesh). Proves the mesh shows the shader field on its
// surface (NOT a flat matcap), the render-order pass renders layer 1 before the
// OBJ pass binds it, and the planar-uv fallback gives the teapot real texels.

const TEXMAP_MODELS: Array<{ id: string; time: number }> = [
  { id: 'sphere', time: 2.0 }, // builtin primitive
  { id: 'teapot', time: 2.0 }, // zero-vt OBJ → planar-uv fallback
];

/** Seed layer 1 = worley shader + layer 0 = OBJ with surfaceSource=1, the
 *  combine OUTPUT = layer 0, freeze iTime, wait for a stable lit frame. */
async function setObjTexturedAndFreeze(page: Page, modelId: string, time: number): Promise<void> {
  await page.evaluate(() => {
    const g = globalThis as unknown as { __toyboxFreeze?: (t?: number) => void };
    g.__toyboxFreeze?.();
  });
  await page.evaluate(
    ({ modelId }) => {
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
            material: {
              modelId,
              rotX: 0.5,
              rotY: 0.7,
              rotZ: 0,
              scale: 1,
              spin: 0,
              matcap: 0,
              tintR: 1,
              tintG: 1,
              tintB: 1,
              surfaceSource: 1, // ← UV-map layer 1's rendered output
              surfaceMix: 1,
            },
          },
          { kind: 'gen', contentId: 'worley-cells', params: { density: 6, edge: 1, speed: 0.6 } },
          { kind: 'off', contentId: null, params: {} },
          { kind: 'off', contentId: null, params: {} },
        ];
        // OUTPUT shows layer 0 (the textured mesh): fade amount 0 passes the base.
        n.data.combine = {
          nodes: [
            { id: 'src0', kind: 'source', layer: 0, x: 14, y: 14 },
            { id: 'src1', kind: 'source', layer: 1, x: 14, y: 66 },
            { id: 'src2', kind: 'source', layer: 2, x: 14, y: 118 },
            { id: 'src3', kind: 'source', layer: 3, x: 14, y: 170 },
            { id: 'pass', kind: 'fade', x: 120, y: 40, params: { amount: 0 } },
            { id: 'out', kind: 'output', x: 286, y: 40 },
          ],
          edges: [
            { id: 'e0', from: 'src0', to: 'pass', toPort: 'in0' },
            { id: 'e1', from: 'src1', to: 'pass', toPort: 'in1' },
            { id: 'e2', from: 'pass', to: 'out', toPort: 'in0' },
          ],
        };
      });
    },
    { modelId },
  );
  // Poll until the FROZEN composite is non-black AND stable (the worley shader
  // compiled + rendered, the OBJ mesh loaded, and two consecutive captures
  // match → the texmap pass settled).
  await page.evaluate(() => {
    (globalThis as unknown as { __toyboxPrevSig?: string }).__toyboxPrevSig = '';
  });
  await page.waitForFunction(
    ({ time }) => {
      const g = globalThis as unknown as {
        __toyboxFreeze?: (t?: number) => void;
        __toyboxPrevSig?: string;
      };
      g.__toyboxFreeze?.(time);
      const canvas = document.querySelector('[data-testid="toybox-canvas"]') as HTMLCanvasElement | null;
      if (!canvas) return false;
      const c2d = canvas.getContext('2d');
      if (!c2d) return false;
      const { data } = c2d.getImageData(0, 0, canvas.width, canvas.height);
      let lit = 0, r = 0, gg = 0, b = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i]! > 16 || data[i + 1]! > 16 || data[i + 2]! > 16) lit++;
        r += data[i]!; gg += data[i + 1]!; b += data[i + 2]!;
      }
      if (lit <= canvas.width * canvas.height * 0.02) return false;
      const sig = `${Math.round(r / 5000)},${Math.round(gg / 5000)},${Math.round(b / 5000)}`;
      const prev = g.__toyboxPrevSig;
      g.__toyboxPrevSig = sig;
      return prev === sig;
    },
    { time },
    { timeout: 15_000 },
  );
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
}

test.describe('VRT: TOYBOX OBJ surface-texture', () => {
  for (const m of TEXMAP_MODELS) {
    test(`obj ${m.id} shows a layer's rendered output as a surface texture`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (msg) => {
        if (msg.type() === 'error') errors.push(msg.text());
      });

      await pinVrtFonts(page);
      await page.goto('/rack?seed=none');
      await page.waitForLoadState('networkidle');
      await awaitVrtFonts(page);
      await spawnPatch(
        page,
        [{ id: 'tb', type: 'toybox', position: { x: 80, y: 40 }, domain: 'video' }],
        [],
      );
      const card = page.locator('.svelte-flow__node-toybox').first();
      await card.waitFor({ state: 'visible', timeout: 10_000 });
      await pinViewport(page);

      await setObjTexturedAndFreeze(page, m.id, m.time);

      const canvas = page.locator('[data-testid="toybox-canvas"]');
      await expect(canvas).toHaveScreenshot(`obj-tex-${m.id}.png`, { maskColor: '#ff00ff' });

      expect(
        errors.filter((e) => !e.includes('AudioContext')),
        'no console / page errors',
      ).toEqual([]);
    });
  }
});

test.describe('VRT: TOYBOX Phase-4 combine graph', () => {
  test('a non-default combine graph composites the expected frozen output', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    await pinVrtFonts(page);
    await page.goto('/rack?seed=none');
    await page.waitForLoadState('networkidle');
    await awaitVrtFonts(page);
    await spawnPatch(
      page,
      [{ id: 'tb', type: 'toybox', position: { x: 80, y: 40 }, domain: 'video' }],
      [],
    );
    const card = page.locator('.svelte-flow__node-toybox').first();
    await card.waitFor({ state: 'visible', timeout: 10_000 });
    await pinViewport(page);

    await setCombineAndFreeze(page, 2.0);

    const canvas = page.locator('[data-testid="toybox-canvas"]');
    await expect(canvas).toHaveScreenshot('combine-composite.png', { maskColor: '#ff00ff' });

    expect(
      errors.filter((e) => !e.includes('AudioContext')),
      'no console / page errors',
    ).toEqual([]);
  });

  test('the bespoke SVG node editor renders the default graph deterministically', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    await pinVrtFonts(page);
    await page.goto('/rack?seed=none');
    await page.waitForLoadState('networkidle');
    await awaitVrtFonts(page);
    await spawnPatch(
      page,
      [{ id: 'tb', type: 'toybox', position: { x: 80, y: 40 }, domain: 'video' }],
      [],
    );
    const card = page.locator('.svelte-flow__node-toybox').first();
    await card.waitFor({ state: 'visible', timeout: 10_000 });
    await pinViewport(page);

    // Open the editor on the DEFAULT graph (seed it deterministically), so the
    // SVG shows the 4 sources + 3 fade ops + OUTPUT with their cables.
    // Idempotent — the section defaults open in the wide 3-column card.
    await ensureCombineOpen(page);
    const svg = page.locator('[data-testid="toybox-graph-svg"]');
    await svg.waitFor({ state: 'visible', timeout: 5_000 });
    // Seed the default graph (the first add seeds + the SVG re-renders with it).
    // We do NOT add a node — instead force the default seed via the engine read:
    // touching the combine through a no-op param set on an existing default op.
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      // Seed the default graph explicitly (deterministic content) so the SVG is
      // identical run-to-run regardless of any prior edits.
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['tb'];
        if (!n) return;
        if (!n.data) n.data = {};
        // ── PIN THE PANEL HEIGHT, OR THIS BASELINE'S DIMENSIONS ARE A RACE ──
        //
        // `.graph-wrap` carries an inline `height: ${combineViewH}px` fed by
        // `node.data.combineView.h`, AND a ResizeObserver (persistResize) that
        // writes the OBSERVED height back into that same field after a 200 ms
        // debounce. Layout → state → layout is a closed loop, and its gain is
        // below 1: the wrap RENDERS shorter than it REQUESTS (the section
        // clamps it), so each cycle shrinks it. MEASURED 2026-08-01 by sampling
        // the wrap from card birth (e2e/vrt/vrt-geom-probe.spec.ts):
        //
        //     0 ms  style=230px rect=175  persisted=unset
        //   263 ms  style=175px rect=133  persisted=175
        //   582 ms  style=133px rect=101  persisted=133
        //   907 ms  style=120px rect=91   persisted=120   ← min-height floor
        //
        // The panel COLLAPSES from 230 px to the 120 px floor in ~0.9 s, one
        // rung per debounce, with no user input. The capture lands on whichever
        // rung it happens to reach — which is why the committed PNG's HEIGHT has
        // oscillated for months across commits that never touched this card:
        //   138 → 185 → 150 → 150 → 121 → 119 → 148 → 119 → 148 → 119 → 134 →
        //   119 → 134  (decoded from every revision of the baseline; the card's
        //   source is byte-identical from #790, 2026-06-14, to today).
        // A design change does not oscillate. Every "re-pin" of this file has
        // been laundering a race into a baseline — six times.
        //
        // ⚠ `git diff --name-status` CANNOT SEE THIS. A same-name PNG that
        // changed SIZE is an "M", indistinguishable from a recolour, so the
        // previous round's "0 added / 0 deleted, so nothing structural" check
        // was invariant to the very thing it claimed to rule out. Decoding the
        // IHDR is the instrument that sees it: scripts/vrt-geom-audit.sh.
        //
        // Writing combineView.h explicitly wins the loop — the observed height
        // then equals the requested one, so persistResize has nothing to
        // correct (verified: pinned to 200, the wrap held 200 px for 1.5 s,
        // well past the 200 ms debounce). The PRODUCT bug — a node-editor panel
        // that silently collapses to its minimum on every fresh spawn, for
        // users, not just for screenshots — is real and is NOT fixed here; it
        // needs a persistResize that distinguishes a user drag from a layout
        // clamp, which is a card behaviour change wanting its own review.
        (n.data as { combineView?: { h: number } }).combineView = { h: 230 };
        n.data.combine = {
          nodes: [
            { id: 'src0', kind: 'source', layer: 0, x: 14, y: 14 },
            { id: 'src1', kind: 'source', layer: 1, x: 14, y: 66 },
            { id: 'src2', kind: 'source', layer: 2, x: 14, y: 118 },
            { id: 'src3', kind: 'source', layer: 3, x: 14, y: 170 },
            { id: 'op1', kind: 'fade', x: 120, y: 14, params: { amount: 0 } },
            { id: 'op2', kind: 'fade', x: 120, y: 66, params: { amount: 0 } },
            { id: 'op3', kind: 'fade', x: 120, y: 118, params: { amount: 0 } },
            { id: 'out', kind: 'output', x: 286, y: 66 },
          ],
          edges: [
            { id: 'e1', from: 'src0', to: 'op1', toPort: 'in0' },
            { id: 'e2', from: 'src1', to: 'op1', toPort: 'in1' },
            { id: 'e3', from: 'op1', to: 'op2', toPort: 'in0' },
            { id: 'e4', from: 'src2', to: 'op2', toPort: 'in1' },
            { id: 'e5', from: 'op2', to: 'op3', toPort: 'in0' },
            { id: 'e6', from: 'src3', to: 'op3', toPort: 'in1' },
            { id: 'e7', from: 'op3', to: 'out', toPort: 'in0' },
          ],
        };
      });
    });
    // Settle so the SVG reflects the seeded graph. The seed is an EXTERNAL Yjs
    // write (no local layersRev bump), so the card's node-label derivation runs
    // off the svelte-flow `node` snapshot wrapper, which propagates a tick or two
    // AFTER the transact. Wait for the unique ordinal labels (#56/#58: "L1",
    // "FADE 1") to actually render before snapshotting — one rAF can race ahead
    // of the snapshot push.
    await expect(page.locator('[data-testid="toybox-graph-svg"] .gnode-label').first()).toHaveText('L1', { timeout: 5_000 });
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
    await expect(svg).toHaveScreenshot('combine-editor.png', { maskColor: '#ff00ff' });

    expect(
      errors.filter((e) => !e.includes('AudioContext')),
      'no console / page errors',
    ).toEqual([]);
  });
});

// ── Shadertoy MULTI-BUFFER runtime: the growing-peak preset (Common +
// BufferA self-feedback heightmap + Image raymarch, RGBA32F feedback). The
// feedback buffer needs MANY frames to converge (the heightmap eases toward the
// ridge target), so we advance N engine step()s BEFORE freezing — a single-frame
// freeze would snapshot an unconverged (run-to-run-varying) buffer. Deterministic
// once converged: at a fixed iTime + no mouse the grown peak is the same each run.

type VideoEngineStep = { step: () => void };

/** Load the growing-peak preset, advance N steps so the feedback buffer
 *  converges, then freeze at a fixed iTime and wait for a stable lit frame. */
async function loadErosionAndFreeze(page: Page, time: number): Promise<void> {
  await page.evaluate(() => {
    const g = globalThis as unknown as { __toyboxFreeze?: (t?: number) => void };
    g.__toyboxFreeze?.();
  });
  await page.waitForFunction(
    () => typeof (globalThis as unknown as { __toyboxLoadPreset?: unknown }).__toyboxLoadPreset === 'function',
    undefined,
    { timeout: 10_000 },
  );
  await page.evaluate(async () => {
    const g = globalThis as unknown as { __toyboxLoadPreset?: (id: string) => Promise<boolean> };
    await g.__toyboxLoadPreset?.('growing-peak');
  });
  await page.evaluate(() => {
    (globalThis as unknown as { __toyboxPrevSig?: string }).__toyboxPrevSig = '';
  });
  // Poll: drive a batch of engine steps so the feedback converges, freeze at the
  // fixed time, require non-black AND a stable signature across two captures.
  await page.waitForFunction(
    ({ time }) => {
      const w = globalThis as unknown as {
        __toyboxFreeze?: (t?: number) => void;
        __toyboxPrevSig?: string;
        __engine?: () => { getDomain: <T>(d: string) => T };
      };
      const ve = w.__engine?.().getDomain<VideoEngineStep>('video');
      for (let i = 0; i < 20; i++) ve?.step();
      w.__toyboxFreeze?.(time);
      const canvas = document.querySelector('[data-testid="toybox-canvas"]') as HTMLCanvasElement | null;
      if (!canvas) return false;
      const c2d = canvas.getContext('2d');
      if (!c2d) return false;
      const { data } = c2d.getImageData(0, 0, canvas.width, canvas.height);
      let lit = 0, r = 0, gg = 0, b = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i]! > 16 || data[i + 1]! > 16 || data[i + 2]! > 16) lit++;
        r += data[i]!; gg += data[i + 1]!; b += data[i + 2]!;
      }
      if (lit <= canvas.width * canvas.height * 0.1) return false;
      const sig = `${Math.round(r / 5000)},${Math.round(gg / 5000)},${Math.round(b / 5000)}`;
      const prev = w.__toyboxPrevSig;
      w.__toyboxPrevSig = sig;
      return prev === sig;
    },
    { time },
    { timeout: 60_000 },
  );
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
}

test.describe('VRT: TOYBOX Shadertoy multi-buffer growing peak', () => {
  test('the growing-peak preset raymarches a converged frozen frame', async ({ page }) => {
    // The multi-pass float raymarch is the heaviest TOYBOX path on SwiftShader.
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await pinVrtFonts(page);
    await page.goto('/rack?seed=none');
    await page.waitForLoadState('networkidle');
    await awaitVrtFonts(page);
    await spawnPatch(
      page,
      [{ id: 'tb', type: 'toybox', position: { x: 80, y: 40 }, domain: 'video' }],
      [],
    );
    const card = page.locator('.svelte-flow__node-toybox').first();
    await card.waitFor({ state: 'visible', timeout: 10_000 });
    await pinViewport(page);

    await loadErosionAndFreeze(page, 2.0);

    const canvas = page.locator('[data-testid="toybox-canvas"]');
    await expect(canvas).toHaveScreenshot('preset-growing-peak.png', { maskColor: '#ff00ff' });

    expect(
      errors.filter((e) => !e.includes('AudioContext')),
      'no console / page errors',
    ).toEqual([]);
  });
});

// ── Content-bank expansion: a representative FRAG baseline. A FRAG shader
// RECEIVES the composited layer below as iChannel0 — so we seed layer 0 = a
// deterministic GEN base (worley) + layer 1 = the FRAG (frag-kaleido) and route
// the combine OUTPUT through the FRAG layer. The frozen capture proves the FRAG
// shim wires iChannel0 to the layer beneath AND the FRAG visibly transforms it
// (a kaleidoscope fold of the worley field, clearly distinct from the raw
// worley GEN baseline). One FRAG baseline is representative; the other 5 new
// FRAG shaders are covered by the manifest-integrity unit (mainImage + reads
// iChannel0 + uniform/param cross-check) + the live compile-smoke e2e.

/** Seed layer 0 = worley GEN, layer 1 = a FRAG shader, output through the FRAG
 *  layer (so its iChannel0 = layer 0). Freeze + wait for a stable lit frame. */
async function setFragOverBaseAndFreeze(page: Page, fragId: string, time: number): Promise<void> {
  await page.evaluate(() => {
    const g = globalThis as unknown as { __toyboxFreeze?: (t?: number) => void };
    g.__toyboxFreeze?.();
  });
  await page.evaluate(
    ({ fragId }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['tb'];
        if (!n) return;
        if (!n.data) n.data = {};
        n.data.layers = [
          { kind: 'gen', contentId: 'worley-cells', params: { density: 6, edge: 1, speed: 0.6 } },
          { kind: 'frag', contentId: fragId, params: {} },
          { kind: 'off', contentId: null, params: {} },
          { kind: 'off', contentId: null, params: {} },
        ];
        // OUTPUT shows layer 1 (the FRAG, which itself samples layer 0 as
        // iChannel0): fade amount 0 passes the in0 source (src1) through.
        n.data.combine = {
          nodes: [
            { id: 'src0', kind: 'source', layer: 0, x: 14, y: 14 },
            { id: 'src1', kind: 'source', layer: 1, x: 14, y: 66 },
            { id: 'src2', kind: 'source', layer: 2, x: 14, y: 118 },
            { id: 'src3', kind: 'source', layer: 3, x: 14, y: 170 },
            { id: 'pass', kind: 'fade', x: 120, y: 40, params: { amount: 0 } },
            { id: 'out', kind: 'output', x: 286, y: 40 },
          ],
          edges: [
            { id: 'e0', from: 'src1', to: 'pass', toPort: 'in0' },
            { id: 'e1', from: 'pass', to: 'out', toPort: 'in0' },
          ],
        };
      });
    },
    { fragId },
  );
  await page.evaluate(() => {
    (globalThis as unknown as { __toyboxPrevSig?: string }).__toyboxPrevSig = '';
  });
  await page.waitForFunction(
    ({ time }) => {
      const g = globalThis as unknown as {
        __toyboxFreeze?: (t?: number) => void;
        __toyboxPrevSig?: string;
      };
      g.__toyboxFreeze?.(time);
      const canvas = document.querySelector('[data-testid="toybox-canvas"]') as HTMLCanvasElement | null;
      if (!canvas) return false;
      const c2d = canvas.getContext('2d');
      if (!c2d) return false;
      const { data } = c2d.getImageData(0, 0, canvas.width, canvas.height);
      let lit = 0, r = 0, gg = 0, b = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i]! > 16 || data[i + 1]! > 16 || data[i + 2]! > 16) lit++;
        r += data[i]!; gg += data[i + 1]!; b += data[i + 2]!;
      }
      if (lit <= canvas.width * canvas.height * 0.05) return false;
      const sig = `${Math.round(r / 5000)},${Math.round(gg / 5000)},${Math.round(b / 5000)}`;
      const prev = g.__toyboxPrevSig;
      g.__toyboxPrevSig = sig;
      return prev === sig;
    },
    { time },
    { timeout: 15_000 },
  );
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
}

test.describe('VRT: TOYBOX FRAG over a base layer (content-bank)', () => {
  test('frag-kaleido folds the layer below (iChannel0) into a mandala', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await pinVrtFonts(page);
    await page.goto('/rack?seed=none');
    await page.waitForLoadState('networkidle');
    await awaitVrtFonts(page);
    await spawnPatch(
      page,
      [{ id: 'tb', type: 'toybox', position: { x: 80, y: 40 }, domain: 'video' }],
      [],
    );
    const card = page.locator('.svelte-flow__node-toybox').first();
    await card.waitFor({ state: 'visible', timeout: 10_000 });
    await pinViewport(page);

    await setFragOverBaseAndFreeze(page, 'frag-kaleido', 2.0);

    const canvas = page.locator('[data-testid="toybox-canvas"]');
    await expect(canvas).toHaveScreenshot('frag-kaleido.png', { maskColor: '#ff00ff' });

    expect(
      errors.filter((e) => !e.includes('AudioContext')),
      'no console / page errors',
    ).toEqual([]);
  });
});

// ── FEEDBACK — the first STATEFUL combine op. Each baseline wires src0 (noise)
// → a FEEDBACK(mode) node → OUTPUT, then advances the ping-pong until it reaches
// a FIXED POINT (a self-feedback loop fed by a STATIC frozen-iTime source settles
// to a steady state) — so the captured frame is pixel-stable. The stability poll
// (two consecutive freeze captures matching) IS the converge-to-fixed-point loop:
// each __toyboxFreeze advances one feedback frame, and we keep going until the
// coarse signature repeats. TUNNEL (recursive zoom) and BLUR (diffusion) reach
// distinct steady states, proving the per-mode shader branch renders + the
// ping-pong loop is wired. (ADDITIVE etc. saturate to a flat frame — less
// interesting as a baseline; the e2e covers the saturating/reset dynamics.)

const FEEDBACK_MODES_VRT: Array<{ name: string; mode: number; time: number }> = [
  { name: 'tunnel', mode: 0, time: 2.0 }, // Droste / infinite zoom
  { name: 'blur',   mode: 5, time: 2.0 }, // smoke / diffusion
];

/** Seed src0(noise) → FEEDBACK(mode) → OUTPUT, then advance the ping-pong until
 *  it reaches a stable fixed point (two consecutive coarse signatures match). */
async function setFeedbackAndFreeze(page: Page, mode: number, time: number): Promise<void> {
  await page.evaluate(() => {
    const g = globalThis as unknown as { __toyboxFreeze?: (t?: number) => void };
    g.__toyboxFreeze?.();
  });
  await page.evaluate(
    ({ mode }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['tb'];
        if (!n) return;
        if (!n.data) n.data = {};
        n.data.layers = [
          { kind: 'gen', contentId: 'noise-fbm', params: {} },
          { kind: 'off', contentId: null, params: {} },
          { kind: 'off', contentId: null, params: {} },
          { kind: 'off', contentId: null, params: {} },
        ];
        n.data.combine = {
          nodes: [
            { id: 'src0', kind: 'source', layer: 0, x: 14, y: 14 },
            { id: 'src1', kind: 'source', layer: 1, x: 14, y: 66 },
            { id: 'src2', kind: 'source', layer: 2, x: 14, y: 118 },
            { id: 'src3', kind: 'source', layer: 3, x: 14, y: 170 },
            { id: 'fb', kind: 'feedback', x: 120, y: 14, params: { mode } },
            { id: 'out', kind: 'output', x: 286, y: 66 },
          ],
          edges: [
            { id: 'e_src0_fb', from: 'src0', to: 'fb', toPort: 'in0' },
            { id: 'e_fb_out', from: 'fb', to: 'out', toPort: 'in0' },
          ],
        };
      });
    },
    { mode },
  );
  // Advance the ping-pong a FIXED NUMBER OF FRAMES, then assert it converged.
  //
  // ⚠ FRAMES, NOT MILLISECONDS, and not "stop as soon as it settles" either.
  // Both halves of that matter, and the old code got both wrong:
  //
  //     await page.waitForFunction(<advance one frame; converged?>,
  //                                { timeout: 15_000 })
  //
  // 1. WALL-CLOCK BUDGET. `__toyboxFreeze(time)` renders exactly ONE feedback
  //    frame synchronously (ToyboxCard.svelte: engine.step() → blitOnce()), so
  //    "how far has the loop advanced" is a FRAME COUNT. A 15 s budget buys a
  //    different number of frames on every renderer — the single highest-yield
  //    rule in CLAUDE.md — and here it bought enough for one mode and not the
  //    other. MEASURED under SwiftShader (the renderer CI uses, and the one a
  //    headless macOS run gets too — see vrt.config.ts), 400 frames per mode:
  //
  //        tunnel  converges at frame  9   (Droste zoom — snaps almost at once)
  //        blur    converges at frame 49   (diffusion — 5.4x slower to settle)
  //        both    bit-identical from frame 49 through frame 400
  //
  //    So `tunnel` passed on CI at 20.5 s and `blur` timed out, for a reason
  //    that has nothing to do with either shader: blur simply needs 5.4x the
  //    iterations, and the budget was denominated in the wrong unit. Note what
  //    this ISN'T — blur converges perfectly well and then stays converged for
  //    351 further frames. "Never settles" and "needs more frames than the
  //    clock bought" look identical from a timeout; they are not the same bug.
  //
  // 2. STOPPING ON CONVERGENCE MAKES THE CAPTURED FRAME RENDERER-DEPENDENT.
  //    Even fixed, a loop that halts the moment two signatures match pins
  //    whatever frame that happened to be — frame 49 here, some neighbouring
  //    frame under a different rasterizer's rounding — so the BASELINE itself
  //    becomes a function of the renderer. Advancing a constant number of
  //    frames pins the same frame index everywhere, which is what a baseline
  //    needs, and demotes convergence from a stopping condition to an
  //    ASSERTION with a real failure message.
  //
  // 120 frames = 2.4x the slowest measured convergence, deep inside the
  // proven-flat region. Cost is bounded and small: ~23 ms/frame locally, so
  // ~2.8 s per mode, replacing a wait that was up to 15 s.
  const FEEDBACK_CONVERGE_FRAMES = 120;
  // Bounds the FAILURE, never the gate (CLAUDE.md). A frame loop that has gone
  // pathological should report how far it got rather than hang to the test cap.
  const FEEDBACK_CONVERGE_MS = 60_000;

  const converge = await page.evaluate(
    ({ time, frames, maxMs }) => {
      const g = globalThis as unknown as { __toyboxFreeze?: (t?: number) => void };
      const canvas = document.querySelector(
        '[data-testid="toybox-canvas"]',
      ) as HTMLCanvasElement | null;
      // Uniform shape on every return path — the caller reads `trail` on all of
      // them, and a union of differently-shaped objects makes that a type error
      // the moment the e2e workspace gains a tsconfig (it has none today, which
      // is exactly why this is written out rather than relied upon).
      const bail = (why: string) => ({ ok: false, why, advanced: 0, trail: [] as string[], sig: '', elapsedMs: 0 });
      if (!canvas) return bail('no [data-testid="toybox-canvas"] in the DOM');
      const c2d = canvas.getContext('2d');
      if (!c2d) return bail('toybox canvas has no 2d context to sample');

      /** Coarse per-frame signature: the channel means, quantized. */
      const sample = () => {
        const { data } = c2d.getImageData(0, 0, canvas.width, canvas.height);
        let lit = 0, r = 0, gg = 0, b = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i]! > 16 || data[i + 1]! > 16 || data[i + 2]! > 16) lit++;
          r += data[i]!; gg += data[i + 1]!; b += data[i + 2]!;
        }
        return {
          lit,
          sig: `${Math.round(r / 5000)},${Math.round(gg / 5000)},${Math.round(b / 5000)}`,
        };
      };

      const started = Date.now();
      const trail: string[] = [];
      let last = { lit: 0, sig: '' };
      let advanced = 0;
      for (let i = 1; i <= frames; i++) {
        g.__toyboxFreeze?.(time);
        last = sample();
        advanced = i;
        // Keep a short trail for the failure message: the first frames (where a
        // ramp is visible) and the last few (where it should be flat).
        if (i <= 6 || i > frames - 4) trail.push(`f${i}:${last.sig}`);
        if (Date.now() - started > maxMs) {
          return {
            ok: false,
            why: `wall-clock cap: ${advanced}/${frames} frames in ${Date.now() - started} ms`,
            advanced, trail, sig: last.sig, elapsedMs: Date.now() - started,
          };
        }
      }
      // The convergence CLAIM, now an assertion: the final frame must be lit,
      // and must be identical to the one before it.
      g.__toyboxFreeze?.(time);
      const after = sample();
      const litFloor = canvas.width * canvas.height * 0.05;
      return {
        ok: after.lit > litFloor && after.sig === last.sig,
        why:
          after.lit <= litFloor
            ? `frame is DARK: ${after.lit} lit px <= ${litFloor} floor (5% of ${canvas.width}x${canvas.height})`
            : after.sig === last.sig
              ? ''
              : `still MOVING after ${frames} frames: f${frames}=${last.sig} then ${after.sig}`,
        advanced, trail, sig: after.sig,
        elapsedMs: Date.now() - started,
      };
    },
    { time, frames: FEEDBACK_CONVERGE_FRAMES, maxMs: FEEDBACK_CONVERGE_MS },
  );

  expect(
    converge.ok,
    `toybox feedback mode ${mode} did not reach a stable composite in ` +
      `${FEEDBACK_CONVERGE_FRAMES} frames (units: FEEDBACK FRAMES, one per ` +
      `__toyboxFreeze call, not milliseconds). ${converge.why}. ` +
      `signature trail: ${(converge.trail ?? []).join(' ')}. ` +
      `Measured convergence when this was written: tunnel 9 frames, blur 49. ` +
      `If a shader change made this genuinely slower, raise the frame budget; ` +
      `if the trail never flattens, the loop has no fixed point and that is a ` +
      `determinism bug, not a budget one.`,
  ).toBe(true);
  // Let the compositor present the final frozen frame before the capture, as
  // the waitForFunction version did on its way out.
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
}

test.describe('VRT: TOYBOX feedback (stateful combine op)', () => {
  for (const f of FEEDBACK_MODES_VRT) {
    test(`feedback ${f.name} converges to a stable composite`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });

      await pinVrtFonts(page);
      await page.goto('/rack?seed=none');
      await page.waitForLoadState('networkidle');
      await awaitVrtFonts(page);
      await spawnPatch(
        page,
        [{ id: 'tb', type: 'toybox', position: { x: 80, y: 40 }, domain: 'video' }],
        [],
      );
      const card = page.locator('.svelte-flow__node-toybox').first();
      await card.waitFor({ state: 'visible', timeout: 10_000 });
      await pinViewport(page);

      await setFeedbackAndFreeze(page, f.mode, f.time);

      const canvas = page.locator('[data-testid="toybox-canvas"]');
      await expect(canvas).toHaveScreenshot(`feedback-${f.name}.png`, { maskColor: '#ff00ff' });

      expect(
        errors.filter((e) => !e.includes('AudioContext')),
        'no console / page errors',
      ).toEqual([]);
    });
  }
});
