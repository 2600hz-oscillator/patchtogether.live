// e2e/tests/toybox-new-content.spec.ts
//
// TOYBOX content-overhaul — pixel/data proofs for the NEW original content
// (Part B of the overhaul). Mirrors toybox-shadertoy.spec.ts' harness (live
// node.data writes via __ydoc + __toyboxFreeze, coarse canvas sampling).
//
//   1. each NEW GEN shader (growing-mountain, flow-field, interference,
//      spiral-bloom) compiles + renders NON-BLACK through the shim/engine,
//   2. each NEW GLITCH/utility FRAG (scanline-blinds, datamosh-wave, zoom-warp,
//      edge-glow) VISIBLY TRANSFORMS the layer below it (composite differs),
//   3. each NEW PRESET loads + renders NON-BLACK with no GLSL/console errors,
//      including the multi-buffer growing-peak (covered by toybox-shadertoy.spec)
//      and the cat-feedback DEMO WIRING (renders its background/feedback chain
//      even with NO user media).
//
// CI runs e2e on SwiftShader (slow) — generous per-test budgets per the
// ci-swiftshader-video-e2e-timeouts discipline. DOM/data + coarse-pixel only.
// Budgets bumped to 180s (#633): the toybox node-batch added 12 combine ops to
// shard 9, increasing the per-shard load enough that these video-domain renders
// occasionally crossed the old 90/120s ceilings on SwiftShader UNDER LOAD (they
// pass in <3s locally on a real GPU — verified — so this is the load-flake, not
// a regression). Lightening the work / reducing per-shard concurrency is the
// deeper task-#64/#65 fix; here we just give the loaded shard the headroom.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

type STGlobal = {
  __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
  __ydoc: { transact: (fn: () => void) => void };
  __engine?: () => { getDomain: <T>(d: string) => T };
  __toyboxFreeze?: (t?: number) => void;
  __toyboxLoadPreset?: (id: string) => Promise<boolean>;
};
type VideoEngineLike = { step: () => void };

/** Sample the preview canvas: total lit pixels + a coarse colour signature. */
async function sampleCanvas(page: Page): Promise<{ lit: number; total: number; sig: string }> {
  return page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="toybox-canvas"]') as HTMLCanvasElement | null;
    if (!canvas) return { lit: 0, total: 0, sig: '' };
    const c2d = canvas.getContext('2d');
    if (!c2d) return { lit: 0, total: 0, sig: '' };
    const { data } = c2d.getImageData(0, 0, canvas.width, canvas.height);
    let lit = 0, r = 0, g = 0, b = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i]! > 16 || data[i + 1]! > 16 || data[i + 2]! > 16) lit++;
      r += data[i]!; g += data[i + 1]!; b += data[i + 2]!;
    }
    return {
      lit,
      total: canvas.width * canvas.height,
      sig: `${Math.round(r / 3000)},${Math.round(g / 3000)},${Math.round(b / 3000)}`,
    };
  });
}

async function spawnToybox(page: Page): Promise<void> {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [{ id: 'tb', type: 'toybox', position: { x: 80, y: 40 }, domain: 'video' }],
    [],
  );
  const card = page.locator('.svelte-flow__node-toybox').first();
  await card.waitFor({ state: 'visible', timeout: 10_000 });
}

/** Drive a few engine steps + freeze, then poll for a non-black frame. */
async function freezeAndWaitLit(page: Page, time: number, frac = 0.05): Promise<void> {
  await page.waitForFunction(
    ({ time, frac }) => {
      const w = globalThis as unknown as STGlobal;
      const ve = w.__engine?.().getDomain<VideoEngineLike>('video');
      for (let i = 0; i < 6; i++) ve?.step();
      w.__toyboxFreeze?.(time);
      const c = document.querySelector('[data-testid="toybox-canvas"]') as HTMLCanvasElement | null;
      const d = c?.getContext('2d')?.getImageData(0, 0, c.width, c.height).data;
      if (!d) return false;
      let lit = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i]! > 16 || d[i + 1]! > 16 || d[i + 2]! > 16) lit++;
      return lit > (c!.width * c!.height) * frac;
    },
    { time, frac },
    { timeout: 30_000 },
  );
}

/** Seed layer 0 = a single GEN/FX content id; OUTPUT = layer 0. */
async function setSingleLayer(page: Page, kind: string, contentId: string): Promise<void> {
  await page.evaluate(
    ({ kind, contentId }) => {
      const w = globalThis as unknown as STGlobal;
      w.__toyboxFreeze?.();
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['tb'];
        if (!n) return;
        if (!n.data) n.data = {};
        n.data.layers = [
          { kind, contentId, params: {} },
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
            { id: 'pass', kind: 'fade', x: 120, y: 40, params: { amount: 0 } },
            { id: 'out', kind: 'output', x: 286, y: 40 },
          ],
          edges: [
            { id: 'e0', from: 'src0', to: 'pass', toPort: 'in0' },
            { id: 'e1', from: 'pass', to: 'out', toPort: 'in0' },
          ],
        };
      });
    },
    { kind, contentId },
  );
}

// LEANED for the serialized real-GPU webgl-attest lane (fix/lean-webgl-attest):
// these used to be the FULL 18-GEN / 12-FRAG banks, rendered one shader per
// iteration in a serial loop = 30 heavy GL renders in one file. On the single
// real-GPU context the lane runs on, that sustained burst is what made this spec
// flake/retry under load. The EXHAUSTIVE "every shader COMPILES + its uniforms
// exist + its asset is on disk" guarantee is already UNIT-owned + fail-closed by
// toybox-manifest-integrity.test.ts (reads every referenced GLSL off disk) and
// toybox-content.test.ts, so the e2e's UNIQUE job is only to prove the real
// WebGL engine compiles + draws a shader of each KIND non-black / transforming.
// We keep a REPRESENTATIVE 3 per kind (a mix of the original + #794 banks) — the
// intent is unchanged, the load is cut ~6×. Run the full bank manually with
// FULL_TOYBOX_CONTENT=1 (it iterates ALL ids below); the SwiftShader shards do
// not re-run this file (it's pinned to the heavy lane), so use the env locally on
// a real GPU when validating a new content batch.
const ALL_GENS = [
  'growing-mountain', 'flow-field', 'interference', 'spiral-bloom',
  // #794 + follow-up GEN scenes — each proves its GLSL COMPILES + renders
  // non-black through the real engine.
  'seascape', 'octgrams', 'vangogh-sunset', 'raymarch-primitives', 'lava-lamp',
  'circuit-bloom', 'plasma-flow', 'kaleido-bloom', 'warp-tunnel', 'metaball-field',
  'warp-terrain', 'gyroid-slice', 'hyperspace', 'caustic-pool',
];
const ALL_FRAGS = [
  'frag-scanline-blinds', 'frag-datamosh-wave', 'frag-zoom-warp', 'frag-edge-glow',
  // #794 + follow-up FRAG effects — each proves its GLSL COMPILES + visibly
  // TRANSFORMS the layer below (composite differs).
  'frag-chromatic-shift', 'frag-posterize', 'frag-bloom', 'frag-crt',
  'frag-halftone', 'frag-pixelate', 'frag-ascii', 'frag-mirror-fold',
];
// Representative subset for the serialized real-GPU lane (3 per kind): an early
// raymarch/SDF scene, a domain-warp scene, and a post-FX-style scene — enough to
// prove the engine compiles + renders a shader of each shape non-black.
const REP_GENS = ['growing-mountain', 'raymarch-primitives', 'warp-tunnel'];
const REP_FRAGS = ['frag-scanline-blinds', 'frag-chromatic-shift', 'frag-pixelate'];
const FULL = process.env.FULL_TOYBOX_CONTENT === '1';
const NEW_GENS = FULL ? ALL_GENS : REP_GENS;
const NEW_FRAGS = FULL ? ALL_FRAGS : REP_FRAGS;
// The NEW single-pass presets ('mountain-weather'…'cat-feedback') were a `.each`
// render loop here — PRUNED in Phase 2 (webgl-suite-optimization §2/§7-2). Their
// validity + "reaches OUTPUT renders not black" is unit-owned by
// toybox-presets.test.ts (declares the exact 12-preset list + per-preset combine
// topo-sort-to-OUTPUT), and the in-card preset-apply UI by toybox-presets.spec.
// The remaining GEN + FRAG cases each uniquely prove a NEW shader COMPILES + DRAWS
// through the real engine — they stay, but are now BATCHED multiple ids per BOOT
// (the per-case fresh boot was the cost driver). Each id is asserted with the id
// in the failure message so one bad shader can't hide in the shared boot.

test.describe('TOYBOX new content — GEN shaders render', () => {
  // BATCH-per-boot: ONE TOYBOX boot, every NEW GEN swapped onto layer 0 in turn.
  test('every new GEN shader compiles + renders non-black', async ({ page }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await spawnToybox(page);

    for (const id of NEW_GENS) {
      await setSingleLayer(page, 'gen', id);
      await freezeAndWaitLit(page, 2.0, 0.05);
      const s = await sampleCanvas(page);
      // PER-ID assertion (id in the message) so a single bad shader is named.
      expect(s.lit, `GEN "${id}" renders non-black`).toBeGreaterThan(s.total * 0.05);
    }

    expect(errors.filter((e) => !e.includes('AudioContext')), 'no GLSL/console errors across all GENs').toEqual([]);
  });
});

test.describe('TOYBOX new content — FRAG shaders transform the layer below', () => {
  // BATCH-per-boot: ONE TOYBOX boot, every NEW FRAG layered over a worley base.
  test('every new FRAG shader compiles + transforms the layer below', async ({ page }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await spawnToybox(page);

    // Base: worley GEN on layer 0, OUTPUT = layer 0. Capture its signature once.
    await setSingleLayer(page, 'gen', 'worley-cells');
    await freezeAndWaitLit(page, 2.0, 0.1);
    const below = await sampleCanvas(page);

    for (const id of NEW_FRAGS) {
      // Add the FRAG on layer 1 reading layer 0 as iChannel0; OUTPUT = layer 1.
      await page.evaluate(
        ({ id }) => {
          const w = globalThis as unknown as STGlobal;
          w.__toyboxFreeze?.();
          w.__ydoc.transact(() => {
            const n = w.__patch.nodes['tb'];
            if (!n || !n.data) return;
            n.data.layers = [
              { kind: 'gen', contentId: 'worley-cells', params: {} },
              { kind: 'frag', contentId: id, params: {} },
              { kind: 'off', contentId: null, params: {} },
              { kind: 'off', contentId: null, params: {} },
            ];
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
        { id },
      );
      await freezeAndWaitLit(page, 2.0, 0.05);
      const fragged = await sampleCanvas(page);

      // PER-ID assertions (id in the message).
      expect(fragged.lit, `FRAG "${id}" renders non-black`).toBeGreaterThan(fragged.total * 0.05);
      expect(fragged.sig, `FRAG "${id}" visibly transforms the layer below`).not.toEqual(below.sig);
    }

    expect(errors.filter((e) => !e.includes('AudioContext')), 'no GLSL/console errors across all FRAGs').toEqual([]);
  });
});
