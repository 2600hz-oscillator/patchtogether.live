// e2e/tests/cellshade-functional.spec.ts
//
// FUNCTIONAL validation of CELLSHADE against CEL-SHADING THEORY — phase 1 of
// the cellshade-rebuild program (design doc:
// .myrobots/plans/cellshade-rebuild-2026-07-11.md).
//
// Unlike the render-smoke bespoke spec (cellshade.spec.ts — "some colour, some
// ink" over an animated ACIDWARP frame), every test here asserts EXPECTED
// OUTPUT PIXELS derived from what cel/toon shading of live video actually IS —
// not from the implementation. The canonical reference pipeline is
// Winnemöller, Olsen & Gooch, "Real-Time Video Abstraction" (SIGGRAPH 2006,
// ACM TOG 25(3) 1221–1226):
//
//   1. edge-preserving smoothing (iterated bilateral filter) → flat regions,
//   2. SOFT LUMINANCE QUANTIZATION — the LUMINANCE channel (CIELab L) is
//      stepped into a small number of bands with a smooth (tanh) transition
//      width; CHROMA (hue) passes through UNQUANTIZED → flat tonal bands of
//      consistent hue,
//   3. DoG edge lines composited as dark outlines.
//
// The visual signatures that make an image read as "cel": large flat regions,
// discrete BRIGHTNESS bands whose ordering follows perceived luminance, hue
// held constant across a band, dark contour lines. Game-style toon shading
// (Lake et al. 2000; Unity/Unreal toon post-filters) agrees on the invariant:
// quantize LIGHTING/LUMINANCE into 2–4 bands (often via a 1D ramp), never the
// hue axis.
//
// DETERMINISM: identical to keyer-functional.spec.ts (feat/keyer-framework) —
// the DRS hooks pause the rAF loop + pin the engine clock, every fixture is a
// pure function of UV (SHAPEDRAMPS h_lin identity ramp; CHROMA as a solid via
// tintMix=1; FADER in WIPE mode as a two-region splitter), and probes read
// exact texels off the module's own FBO (gl.readPixels) after a fixed
// synchronous burst of engine.step()s. Assertions use SwiftShader-tolerant
// BANDS (±TOL on 0..255), and every probe u is placed ≥0.07 (in quantizer
// input units) away from a floor() band boundary so 8-bit input rounding can
// never flip a band. NOTE: the probe helpers are deliberately duplicated from
// keyer-functional.spec.ts (that branch is unmerged); when both land, extract
// a shared e2e/tests/_video-probe.ts (tracked in the design doc, §coordination).
//
// EXPECTED-FAIL tests are marked test.fixme with a FINDING reference — each is
// a live divergence between cel-shading theory and the current shader,
// catalogued in the design doc. They stay fixme until the phase-4 rebuild
// makes them pass (then each fixme flips to a hard assertion).
//
// FINDINGS referenced below (full evidence + rebuild plan in the design doc):
//   F-CS1  DEFAULT-setting HUE COLLAPSE: at bits idx 2 (16 colours) hue is
//          quantized with a LINEAR endpoint quantizer (floor(h*3)/2 → h ∈
//          {0, ½, 1}) on a CIRCULAR quantity: 0 and 1 are both RED, so the
//          entire hue wheel collapses to {red, cyan}. Yellow, magenta AND
//          blue all emerge PURE RED (255,0,0); green emerges cyan. (Verified
//          against the module's own CPU mirror cellshadeQuantize.)
//   F-CS2  DEFAULT-setting SATURATION BINARIZATION: satSteps=2 → floor(s*2)/1
//          maps s<0.5 → 0, s≥0.5 → 1. A skin tone (0.8,0.6,0.5) → pure GRAY
//          (204,204,204); a pastel → white. Theory: chroma passes through a
//          cel quantizer untouched (Winnemöller quantizes L only).
//   F-CS3  BANDS FOLLOW HSV V (max RGB), NOT LUMINANCE: saturated blue
//          (luma 0.114 — near-black to the eye) has V=1 and lands in the TOP
//          band at every low depth; the tonal (shadow/light) structure of the
//          scene is destroyed for saturated colours. Theory: bands are
//          LUMINANCE bands.
//   F-CS4  HARD quantization: floor() with zero transition width. Theory
//          (Winnemöller §3.2): SOFT quantization (tanh transition) — a
//          luminance step across a band boundary transitions smoothly; hard
//          steps alias spatially and shimmer temporally on live video.
//   F-CS5  8/16-bit steps are PER-CHANNEL RGB posterize (3-3-2 / 5-6-5) with
//          UNEQUAL level counts per channel → NEUTRAL GRAYS acquire hue tints
//          (the tell-tale per-channel-posterizer failure; a luminance-domain
//          quantizer never tints neutrals). Characterized by a PASSING test
//          below — the retro-console look is documented intent, but it is
//          posterization, not cel shading.
//   F-CS6  (code-derived, no pixel test — see design doc) There is NO
//          edge-preserving smoothing / abstraction stage at all: quantization
//          is per-pixel on the raw input, so sensor noise & texture fracture
//          the bands into speckle; Winnemöller's step 1 is absent.
//   F-CS7  (code-derived) The "total colour budget" model is false at low
//          depths: at "4 colours" hue/sat pass through untouched, so the
//          output palette is unbounded (every input hue × 4 V-bands).
//
// The three PASSING behaviours proven here (neutral-ramp banding, contrast-
// boundary ink + gate, and the F-CS5 characterization) pin down what a
// rebuild must NOT lose.

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch, type SpawnNode, type SpawnEdge } from './_helpers';
import { installRenderSmokeHooks } from './_render-smoke';

const STEPS = 4;   // fixed frame burst per read (loop paused)
const TOL = 14;    // ±band on 0..255 — clears renderer low-bit noise
const LOW = 24;    // "this channel is ~0" ceiling
const HIGH = 231;  // "this channel is ~255" floor

// CELLSHADE's dilation-loop shader first-paints slowly on CI's SwiftShader —
// same WebGL-heavy headroom as the bespoke cellshade.spec.ts.
const HEAVY_MOUNT_TIMEOUT = 30_000;

/** One probe: read the RGBA texel at normalized (u, v) of a node's output. */
interface Probe {
  nodeId: string;
  portId?: string;
  u: number;
  v: number;
}

/** Drive the engine a fixed burst SYNCHRONOUSLY (single evaluate — the DRS
 *  pattern from _render-smoke.ts), then read one texel per probe off each
 *  node's OWN output FBO. Returns [r,g,b,a] per probe (0..255), or throws on
 *  an incomplete FBO / GL error so failures are readable. */
async function stepAndSample(
  page: Page,
  probes: Probe[],
  steps = STEPS,
): Promise<Array<[number, number, number, number]>> {
  return page.evaluate(
    ({ probes, steps }) => {
      const w = globalThis as unknown as {
        __engine: () => {
          getDomain: (d: string) => {
            gl: WebGL2RenderingContext;
            step: () => void;
            outputTexture: (id: string, port?: string) => WebGLTexture | null;
            res: { width: number; height: number };
          };
        };
      };
      const vid = w.__engine().getDomain('video');
      const gl = vid.gl;
      while (gl.getError() !== gl.NO_ERROR) { /* drain pre-existing */ }

      for (let i = 0; i < steps; i++) vid.step();

      const { width: W, height: H } = vid.res;
      const fb = gl.createFramebuffer()!;
      const out: Array<[number, number, number, number]> = [];
      for (const p of probes) {
        const tex = vid.outputTexture(p.nodeId, p.portId);
        if (!tex) throw new Error(`no output texture for ${p.nodeId}:${p.portId ?? 'out'}`);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
          throw new Error(`FBO incomplete for ${p.nodeId}`);
        }
        const px = new Uint8Array(4);
        const x = Math.min(W - 1, Math.max(0, Math.round(p.u * W)));
        const y = Math.min(H - 1, Math.max(0, Math.round(p.v * H)));
        gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        out.push([px[0]!, px[1]!, px[2]!, px[3]!]);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fb);
      const errs: number[] = [];
      let e: number;
      while ((e = gl.getError()) !== gl.NO_ERROR) errs.push(e);
      if (errs.length) throw new Error(`GL errors during sample: [${errs.join(',')}]`);
      return out;
    },
    { probes, steps },
  );
}

/** Mutate one param through the real chain (ydoc → reconciler →
 *  engine.setParam). */
async function setNodeParam(page: Page, nodeId: string, paramId: string, value: number): Promise<void> {
  await page.evaluate(
    ({ nodeId, paramId, value }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> } | undefined> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const target = w.__patch.nodes[nodeId];
        if (target) target.params[paramId] = value;
      });
    },
    { nodeId, paramId, value },
  );
}

function fmt(px: readonly number[]): string {
  return `(${px[0]},${px[1]},${px[2]})`;
}

/** assert channel ~= expected within ±TOL. */
function expectNear(actual: number, expected: number, label: string): void {
  expect(Math.abs(actual - expected), `${label}: got ${actual}, want ${expected}±${TOL}`).toBeLessThanOrEqual(TOL);
}

// ── shared fixture nodes ────────────────────────────────────────────────────
//
// ramp      SHAPEDRAMPS h_lin — pure horizontal identity ramp (R=G=B = u): a
//           NEUTRAL luminance gradient (for a gray, luma = the channel value).
// solid(c)  CHROMA with tintMix=1 outputs the flat tint color exactly; it only
//           needs SOME input patched to clear its uHasInput guard (ramp serves).
// split     FADER in WIPE mode at fader=0.5: LEFT half = in_b, RIGHT = in_a,
//           soft edge ±0.02 around x=0.5 (a 41-texel smoothstep at 1024 wide —
//           peak normalized Sobel magnitude ≈ 0.065 for a blue↔white step).
//           FADER's factory ignores initial node.params, so the two params are
//           pushed post-spawn via setNodeParam (the reconciler path).

const rampNode: SpawnNode = { id: 'f-ramp', type: 'shapedramps', position: { x: 40, y: 40 }, domain: 'video' };

function solidNode(id: string, r: number, g: number, b: number, x = 40, y = 260): SpawnNode {
  return {
    id, type: 'chroma', position: { x, y }, domain: 'video',
    params: { hue: 0, saturation: 1, tintR: r, tintG: g, tintB: b, tintMix: 1 },
  };
}

function celNode(id: string, params: Record<string, number>, x = 700, y = 40): SpawnNode {
  return { id, type: 'cellshade', position: { x, y }, domain: 'video', params };
}

function feedEdge(id: string, toNode: string, toPort: string): SpawnEdge {
  return {
    id,
    from: { nodeId: 'f-ramp', portId: 'h_lin' },
    to: { nodeId: toNode, portId: toPort },
    sourceType: 'mono-video',
    targetType: 'video',
  };
}

function videoEdge(id: string, fromNode: string, fromPort: string, toNode: string, toPort: string): SpawnEdge {
  return {
    id,
    from: { nodeId: fromNode, portId: fromPort },
    to: { nodeId: toNode, portId: toPort },
    sourceType: 'video',
    targetType: 'video',
  };
}

const sinkNode: SpawnNode = { id: 'f-out', type: 'videoOut', position: { x: 980, y: 40 }, domain: 'video' };

async function bootRack(page: Page): Promise<void> {
  await installRenderSmokeHooks(page);
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
}

/** ramp → cellshade(params) → out, probed at the given u positions. */
async function rampThroughCellshade(
  page: Page,
  params: Record<string, number>,
  us: number[],
): Promise<Array<[number, number, number, number]>> {
  await bootRack(page);
  await spawnPatch(
    page,
    [rampNode, celNode('f-cel', params), sinkNode],
    [feedEdge('e-in', 'f-cel', 'in'), videoEdge('e-o', 'f-cel', 'out', 'f-out', 'in')],
    { mountTimeout: HEAVY_MOUNT_TIMEOUT },
  );
  await expect(page.locator('.svelte-flow__node-cellshade'), 'CELLSHADE visible').toBeVisible();
  return stepAndSample(page, us.map((u) => ({ nodeId: 'f-cel', u, v: 0.5 })));
}

/** solid(r,g,b) → cellshade(params), probed at frame center. */
async function solidThroughCellshade(
  page: Page,
  rgb: [number, number, number],
  params: Record<string, number>,
): Promise<[number, number, number, number]> {
  await bootRack(page);
  await spawnPatch(
    page,
    [rampNode, solidNode('f-solid', ...rgb), celNode('f-cel', params), sinkNode],
    [
      feedEdge('e-r1', 'f-solid', 'in'),
      videoEdge('e-in', 'f-solid', 'out', 'f-cel', 'in'),
      videoEdge('e-o', 'f-cel', 'out', 'f-out', 'in'),
    ],
    { mountTimeout: HEAVY_MOUNT_TIMEOUT },
  );
  await expect(page.locator('.svelte-flow__node-cellshade'), 'CELLSHADE visible').toBeVisible();
  const [px] = await stepAndSample(page, [{ nodeId: 'f-cel', u: 0.5, v: 0.5 }]);
  return px!;
}

test.describe('CELLSHADE functional validation (cel-shading-theory-derived pixels)', () => {
  // ── 0. fixture sanity ─────────────────────────────────────────────────────
  test('fixtures: ramp and solid frames read back as constructed', async ({ page, errorWatch }) => {
    test.setTimeout(120_000);
    await bootRack(page);
    await spawnPatch(
      page,
      [rampNode, solidNode('f-blue', 0, 0, 1), sinkNode],
      [feedEdge('e-r1', 'f-blue', 'in'), videoEdge('e-o', 'f-blue', 'out', 'f-out', 'in')],
    );
    await expect(page.locator('.svelte-flow__node-chroma'), 'CHROMA visible').toBeVisible();
    const [ramp25, ramp75, blue] = await stepAndSample(page, [
      { nodeId: 'f-ramp', portId: 'h_lin', u: 0.25, v: 0.5 },
      { nodeId: 'f-ramp', portId: 'h_lin', u: 0.75, v: 0.5 },
      { nodeId: 'f-blue', u: 0.5, v: 0.5 },
    ]);
    for (let c = 0; c < 3; c++) {
      expectNear(ramp25![c]!, 64, `ramp@0.25 ch${c} ${fmt(ramp25!)}`);
      expectNear(ramp75![c]!, 191, `ramp@0.75 ch${c} ${fmt(ramp75!)}`);
    }
    expect(blue![2], `solid blue B ${fmt(blue!)}`).toBeGreaterThanOrEqual(HIGH);
    expect(blue![0], `solid blue R ${fmt(blue!)}`).toBeLessThanOrEqual(LOW);
    expect(blue![1], `solid blue G ${fmt(blue!)}`).toBeLessThanOrEqual(LOW);
  });

  // ── 1. the cel property that DOES hold: neutral-ramp banding ──────────────
  //
  // Theory (Winnemöller step 2, game toon banding): a smooth NEUTRAL luminance
  // ramp must emerge as N discrete flat bands with MONOTONE band values, and a
  // neutral input stays neutral. At the "2-bit / 4 colour" step the module
  // banding IS 4 V-bands, and for a gray input V == luminance, so this is the
  // one configuration where the implementation coincides with theory. Probes
  // sit mid-band (boundaries at 0.25/0.5/0.75; nearest probe ≥ 0.1 away).
  // Expected bands: floor(v*4)/3 → 0, 1/3 (85), 2/3 (170), 1 (255). The ramp's
  // per-texel Sobel magnitude (≈0.002) is far below the default 0.2 gate, so
  // no ink fires.
  test('neutral luminance ramp emerges as 4 discrete monotone neutral bands (2-bit step)', async ({ page, errorWatch }) => {
    test.setTimeout(120_000);
    const [b0, b1, b2, b3] = await rampThroughCellshade(
      page,
      { threshold: 0.2, thickness: 2, bits: 1 },
      [0.1, 0.35, 0.6, 0.9],
    );
    const expected = [0, 85, 170, 255];
    [b0, b1, b2, b3].forEach((px, i) => {
      for (let c = 0; c < 3; c++) expectNear(px![c]!, expected[i]!, `band${i} ch${c} ${fmt(px!)}`);
      // neutral in → neutral out (no per-channel divergence on the luma path).
      expect(Math.max(px![0]!, px![1]!, px![2]!) - Math.min(px![0]!, px![1]!, px![2]!),
        `band${i} stays neutral ${fmt(px!)}`).toBeLessThanOrEqual(6);
    });
  });

  // ── 2. contour ink at a contrast boundary + the gate ─────────────────────
  //
  // Theory (Winnemöller step 3 / toon outlines): a high-contrast boundary
  // acquires a dark contour line; flat regions never do; the gate scales the
  // line set. Fixture: FADER WIPE splits white (left) | saturated blue (right)
  // — a 0.886 luma step spread across the ±0.02 smoothstep edge (peak
  // normalized Sobel magnitude ≈ 0.065). With threshold=0.02 the boundary
  // inks BLACK; the flat solids (zero gradient) never ink at any gate > 0.
  // Raising the gate to 0.35 (5× the boundary's peak magnitude) through the
  // live param chain removes the line.
  test('a high-contrast boundary acquires a black contour line; the gate removes it', async ({ page, errorWatch }) => {
    test.setTimeout(120_000);
    await bootRack(page);
    await spawnPatch(
      page,
      [
        rampNode,
        solidNode('f-blue', 0, 0, 1, 40, 260),
        solidNode('f-white', 1, 1, 1, 40, 480),
        { id: 'f-split', type: 'fader', position: { x: 420, y: 260 }, domain: 'video' },
        celNode('f-cel', { threshold: 0.02, thickness: 2, bits: 1 }, 700, 260),
        sinkNode,
      ],
      [
        feedEdge('e-r1', 'f-blue', 'in'),
        feedEdge('e-r2', 'f-white', 'in'),
        videoEdge('e-a', 'f-blue', 'out', 'f-split', 'in_a'),   // right half
        videoEdge('e-b', 'f-white', 'out', 'f-split', 'in_b'),  // left half
        videoEdge('e-in', 'f-split', 'out', 'f-cel', 'in'),
        videoEdge('e-o', 'f-cel', 'out', 'f-out', 'in'),
      ],
      { mountTimeout: HEAVY_MOUNT_TIMEOUT },
    );
    await expect(page.locator('.svelte-flow__node-cellshade'), 'CELLSHADE visible').toBeVisible();
    await setNodeParam(page, 'f-split', 'abTransition', 1); // WIPE
    await setNodeParam(page, 'f-split', 'fader', 0.5);

    const [left, boundary, right] = await stepAndSample(page, [
      { nodeId: 'f-cel', u: 0.25, v: 0.5 },
      { nodeId: 'f-cel', u: 0.5, v: 0.5 },
      { nodeId: 'f-cel', u: 0.75, v: 0.5 },
    ]);
    // flat interiors: quantized colour, NOT inked.
    for (let c = 0; c < 3; c++) expect(left![c]!, `left flat is white ${fmt(left!)}`).toBeGreaterThanOrEqual(HIGH);
    expect(right![2], `right flat is blue ${fmt(right!)}`).toBeGreaterThanOrEqual(HIGH);
    expect(right![0], `right flat not inked ${fmt(right!)}`).toBeLessThanOrEqual(LOW);
    // the boundary is a black contour line.
    for (let c = 0; c < 3; c++) expect(boundary![c]!, `boundary inked black ${fmt(boundary!)}`).toBeLessThanOrEqual(LOW);

    // gate to 0.35 (≈5× the boundary's peak gradient) → the line disappears.
    await setNodeParam(page, 'f-cel', 'threshold', 0.35);
    const [openGate] = await stepAndSample(page, [{ nodeId: 'f-cel', u: 0.5, v: 0.5 }]);
    expect(openGate![2], `boundary un-inked at high gate ${fmt(openGate!)}`).toBeGreaterThanOrEqual(HIGH);
  });

  // ── 3. F-CS5 characterization: the 8-bit step tints NEUTRAL grays ─────────
  //
  // PASSING test that pins the ACTUAL per-channel behaviour — the tell-tale
  // divergence between per-channel RGB posterization and luminance-domain
  // banding. RGB 3-3-2 quantizes B on 4 levels but R/G on 8, so a NEUTRAL
  // gray ramp acquires hue tints that flip along the ramp:
  //   gray 0.2  → floor: R=G=1/7 (36), B=0        → yellow-tinted "gray"
  //   gray 0.45 → floor: R=G=3/7 (109), B=1/3 (85) → still yellow-shifted
  // A cel quantizer (luminance-domain) can never tint a neutral. This is the
  // documented retro-console intent — the test exists so the rebuild keeps the
  // behaviour honest under whatever param exposes it (see design doc §params).
  test('characterization [F-CS5]: 8-bit RGB-3-3-2 step tints neutral grays (per-channel posterize tell)', async ({ page, errorWatch }) => {
    test.setTimeout(120_000);
    const [g20, g45] = await rampThroughCellshade(
      page,
      { threshold: 0.2, thickness: 2, bits: 3 },
      [0.2, 0.45],
    );
    expectNear(g20![0]!, 36, `gray0.2 R ${fmt(g20!)}`);
    expectNear(g20![1]!, 36, `gray0.2 G ${fmt(g20!)}`);
    expect(g20![2]!, `gray0.2 B crushed to 0 ${fmt(g20!)}`).toBeLessThanOrEqual(LOW);
    expect(g20![0]! - g20![2]!, `neutral input emerges TINTED ${fmt(g20!)}`).toBeGreaterThanOrEqual(10);
    expectNear(g45![0]!, 109, `gray0.45 R ${fmt(g45!)}`);
    expectNear(g45![2]!, 85, `gray0.45 B ${fmt(g45!)}`);
    expect(g45![0]! - g45![2]!, `neutral input emerges TINTED ${fmt(g45!)}`).toBeGreaterThanOrEqual(10);
  });

  // ── 4. F-CS1: the DEFAULT setting collapses the hue wheel to red/cyan ─────
  //
  // THEORY: cel quantization bands LUMINANCE and preserves hue — a yellow
  // stays yellow, a magenta stays magenta (Winnemöller: chroma channels are
  // never quantized; game toon ramps modulate lighting, not hue).
  // ACTUAL (CPU-mirror-verified): at the DEFAULT bits step (idx 2, "16
  // colours") hue is floor-quantized to 3 steps of a linear 0..1 quantizer —
  // but hue is CIRCULAR and the quantizer's endpoints 0 and 1 are BOTH red, so
  // the whole wheel maps to {red, cyan}: yellow (255,255,0) → (255,0,0),
  // magenta (255,0,255) → (255,0,0), blue → (255,0,0), green → (0,255,255).
  // (Yellow/magenta probes chosen over blue/green: their hues sit mid-interval
  // in the quantizer, so no float-boundary degeneracy — blue's hue 2/3 lands
  // EXACTLY on a floor() boundary and may flip red/cyan per renderer.)
  test.fixme('[F-CS1] default setting preserves hue: yellow stays yellow, magenta stays magenta', async ({ page, errorWatch }) => {
    test.setTimeout(120_000);
    const yellow = await solidThroughCellshade(page, [1, 1, 0], { threshold: 0.2, thickness: 2, bits: 2 });
    // THEORY: a bright-band yellow — R and G high together, B low.
    expect(yellow[0], `yellow keeps R ${fmt(yellow)}`).toBeGreaterThanOrEqual(HIGH);
    expect(yellow[1], `yellow keeps G ${fmt(yellow)}`).toBeGreaterThanOrEqual(150); // ACTUAL: 0
    expect(yellow[2], `yellow keeps B low ${fmt(yellow)}`).toBeLessThanOrEqual(80);

    const magenta = await solidThroughCellshade(page, [1, 0, 1], { threshold: 0.2, thickness: 2, bits: 2 });
    expect(magenta[0], `magenta keeps R ${fmt(magenta)}`).toBeGreaterThanOrEqual(HIGH);
    expect(magenta[2], `magenta keeps B ${fmt(magenta)}`).toBeGreaterThanOrEqual(150); // ACTUAL: 0
    expect(magenta[1], `magenta keeps G low ${fmt(magenta)}`).toBeLessThanOrEqual(80);
  });

  // ── 5. F-CS2: the DEFAULT setting erases moderate chroma entirely ─────────
  //
  // THEORY: chroma survives cel quantization (only LUMINANCE is banded), so a
  // clearly-saturated subject keeps a visible hue cast.
  // ACTUAL (CPU-mirror-verified): satSteps=2 floor-binarizes saturation at
  // 0.5 — a skin tone (0.8,0.6,0.5), s=0.375, emerges PURE GRAY (204,204,204);
  // a pastel blue (0.55,0.55,1.0), s=0.45, emerges PURE WHITE. Faces through
  // the default setting are colourless.
  test.fixme('[F-CS2] default setting keeps moderate saturation: a skin tone stays warm, not gray', async ({ page, errorWatch }) => {
    test.setTimeout(120_000);
    const skin = await solidThroughCellshade(page, [0.8, 0.6, 0.5], { threshold: 0.2, thickness: 2, bits: 2 });
    // THEORY: banded brightness, hue/chroma retained → R clearly above B.
    expect(skin[0]! - skin[2]!, `skin keeps its warm cast ${fmt(skin)}`).toBeGreaterThanOrEqual(30); // ACTUAL: 0 (gray)

    const pastel = await solidThroughCellshade(page, [0.55, 0.55, 1], { threshold: 0.2, thickness: 2, bits: 2 });
    expect(pastel[2]! - pastel[0]!, `pastel keeps its blue cast ${fmt(pastel)}`).toBeGreaterThanOrEqual(30); // ACTUAL: 0 (white)
  });

  // ── 6. F-CS3: tonal bands must follow LUMINANCE, not max(R,G,B) ───────────
  //
  // THEORY: cel banding quantizes PERCEIVED brightness (CIELab L / Rec.601
  // luma — the same luma this module's own Sobel pass uses). Saturated blue
  // (0,0,1) has luma 0.114: at a 2-band depth it belongs in the DARK band
  // (near-black), exactly as a 0.114 gray would.
  // ACTUAL: quantization runs on HSV V = max(R,G,B) = 1.0 → blue lands in the
  // TOP band and emerges FULL-BRIGHTNESS (0,0,255). Shadow/light structure is
  // inverted for saturated colours — the scene's tonal read is destroyed.
  test.fixme('[F-CS3] 1-bit banding sends dark-luma saturated blue to the DARK band', async ({ page, errorWatch }) => {
    test.setTimeout(120_000);
    const blue = await solidThroughCellshade(page, [0, 0, 1], { threshold: 0.2, thickness: 2, bits: 0 });
    // THEORY: luma 0.114 < 0.5 → dark band → near-black output.
    for (let c = 0; c < 3; c++) {
      expect(blue[c]!, `sat blue lands in the dark band ch${c} ${fmt(blue)}`).toBeLessThanOrEqual(60); // ACTUAL: B=255
    }
  });

  // ── 7. F-CS4: quantization must be SOFT (finite transition width) ─────────
  //
  // THEORY (Winnemöller §3.2): luminance quantization uses a smooth (tanh)
  // transition between bands — a small luminance neighbourhood straddling a
  // band boundary maps to nearby outputs, which is what keeps live video from
  // shimmering at band edges. Probes at u=0.48 / 0.52 straddle the 2-bit
  // boundary at 0.5 by ±0.02 of luminance: under soft quantization their
  // outputs differ by a fraction of the band step.
  // ACTUAL: hard floor() — the pair jumps a full band step (85 → 170).
  test.fixme('[F-CS4] band transitions are soft: ±0.02 luma straddle maps to nearby outputs', async ({ page, errorWatch }) => {
    test.setTimeout(120_000);
    const [below, above] = await rampThroughCellshade(
      page,
      { threshold: 0.2, thickness: 2, bits: 1 },
      [0.48, 0.52],
    );
    const jump = Math.abs(above![0]! - below![0]!);
    // THEORY: a soft transition spreads the 85-step over ≥0.1 of luminance —
    // a ±0.02 straddle sees well under half the band step. ACTUAL: 85.
    expect(jump, `band-boundary jump ${fmt(below!)} → ${fmt(above!)}`).toBeLessThanOrEqual(30);
  });
});
