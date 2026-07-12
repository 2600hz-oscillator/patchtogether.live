// e2e/tests/cellshade-functional.spec.ts
//
// FUNCTIONAL validation of CELLSHADE against CEL-SHADING THEORY — phases 1+4
// of the cellshade-rebuild program (design doc:
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
//   2. SOFT LUMINANCE QUANTIZATION — the LUMINANCE channel is stepped into a
//      small number of bands with a smooth transition width; CHROMA (hue)
//      passes through UNQUANTIZED → flat tonal bands of consistent hue,
//   3. edge lines composited as dark outlines.
//
// PHASE-4 STATUS: the rebuild landed — the findings tests below (F-CS1..F-CS4)
// are now HARD assertions against the new 4-pass engine (P1/P2 separable
// bilateral, P3 soft luminance quantization with additive chroma-preserving
// reconstruction, P4 EDGES Sobel ink with an INK strength). Every expected
// pixel below is computed from the module's own CPU mirror
// (cellshadeQuantizeY etc. — see cellshade.test.ts), with §12-of-the-design
// corrections applied:
//   * F-CS3 asserts the OUTPUT LUMA (≤ ~38/255) + hue retention, NOT
//     per-channel darkness — the additive reconstruction sends pure blue to
//     (0,0,226) because the gamut clamp eats what the dark band demands
//     (§12 R1: no chroma-preserving YCbCr scheme can pass all-channels≤60).
//   * the neutral-ramp anchor moved to bits: 2 (the NEW {2,3,4,6,8} band
//     remap makes idx 2 = 4 bands, reproducing the historic 0/85/170/255
//     values) and pins softness: 0 + smooth: 0 (§12 R2).
//   * F-CS4's ≤30 straddle assertion sets an EXPLICIT softness 0.8 (the
//     module default 0.25 yields a ~71 jump by design — §12 R3), with a
//     softness: 0 companion asserting the full hard ~85 jump.
//   * the old F-CS5 characterization test (8-bit RGB-3-3-2 tints neutral
//     grays) was DELETED with the retro per-channel posterize modes
//     themselves (reconcile = fix or delete): they were posterization, not
//     cel — a future POSTERBOX module is the right home for that look.
//
// DETERMINISM: identical to keyer-functional.spec.ts (feat/keyer-framework) —
// the DRS hooks pause the rAF loop + pin the engine clock, every fixture is a
// pure function of UV (SHAPEDRAMPS h_lin identity ramp; CHROMA as a solid via
// tintMix=1; FADER in WIPE mode as a two-region splitter; LINES as a static
// frozen-phase grating), and probes read exact texels off the module's own
// FBO (gl.readPixels) after a fixed synchronous burst of engine.step()s.
// Assertions use SwiftShader-tolerant BANDS (±TOL on 0..255), and every probe
// u is placed ≥0.07 (in quantizer input units) away from a band threshold so
// 8-bit input rounding can never flip a band. NOTE: the probe helpers are
// deliberately duplicated from keyer-functional.spec.ts (that branch is
// unmerged); when both land, extract a shared e2e/tests/_video-probe.ts
// (tracked in the design doc, §coordination).
//
// LANE: this file is enrolled in WEBGL_HEAVY_GLOBS (it readPixels()es real
// FBOs), so it runs on the serialized e2e-video lane, never a sharded
// SwiftShader shard (§12 R7).

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch, type SpawnNode, type SpawnEdge } from './_helpers';
import { installRenderSmokeHooks, stepAndReadStats } from './_render-smoke';

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
// grating   LINES (frozen-phase static stripes under the DRS clock pin) →
//           CHROMA (tintMix < 1 compresses the contrast so the bilateral's
//           range weights bite) — the SMOOTH-abstraction texture fixture.

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

  // ── 1. the hard-band regression anchor: neutral-ramp banding ──────────────
  //
  // Theory (Winnemöller step 2, game toon banding): a smooth NEUTRAL luminance
  // ramp must emerge as N discrete flat bands with MONOTONE band values, and a
  // neutral input stays neutral. §12 R2: under the {2,3,4,6,8} band remap the
  // 4-band step is now INDEX 2, and the SOFT quantizer reproduces the historic
  // hard values ONLY at softness 0 — so the anchor pins bits: 2 + softness: 0
  // (+ smooth: 0 for hygiene). Probes sit mid-band (boundaries at
  // 0.25/0.5/0.75; nearest probe ≥ 0.1 away). Expected bands: floor(v·4)/3 →
  // 0, 1/3 (85), 2/3 (170), 1 (255). The ramp's per-texel Sobel magnitude
  // (≈0.002) is far below the default 0.2 gate, so no ink fires.
  test('neutral luminance ramp emerges as 4 discrete monotone neutral bands (hard anchor: bits 2, softness 0)', async ({ page, errorWatch }) => {
    test.setTimeout(120_000);
    const [b0, b1, b2, b3] = await rampThroughCellshade(
      page,
      { threshold: 0.2, thickness: 2, bits: 2, softness: 0, smooth: 0, ink: 1 },
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

  // ── 2. contour ink at a contrast boundary + the gate + the INK strength ──
  //
  // Theory (Winnemöller step 3 / toon outlines): a high-contrast boundary
  // acquires a dark contour line; flat regions never do; the gate scales the
  // line set; the new INK knob scales the composite (0 = no lines). Fixture:
  // FADER WIPE splits white (left) | saturated blue (right) — a 0.886 luma
  // step spread across the ±0.02 smoothstep edge (peak normalized Sobel
  // magnitude ≈ 0.065). smooth: 0 + softness: 0 isolate P4's EDGES-verbatim
  // semantics. NOTE the right flat's expected value: the LUMINANCE-domain
  // quantizer (bits 2 → 4 bands) sends saturated blue (luma 0.114) to the
  // DARK band → (0,0,226) per the CPU mirror — blue STAYS blue but darkens
  // (the F-CS3 fix; the clamp eats the unrealizable remainder).
  test('a high-contrast boundary acquires a black contour line; the gate and INK strength remove it', async ({ page, errorWatch }) => {
    test.setTimeout(120_000);
    await bootRack(page);
    await spawnPatch(
      page,
      [
        rampNode,
        solidNode('f-blue', 0, 0, 1, 40, 260),
        solidNode('f-white', 1, 1, 1, 40, 480),
        { id: 'f-split', type: 'fader', position: { x: 420, y: 260 }, domain: 'video' },
        celNode('f-cel', { threshold: 0.02, thickness: 2, bits: 2, softness: 0, smooth: 0, ink: 1 }, 700, 260),
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
    expectNear(right![2]!, 226, `right flat is dark-band blue ${fmt(right!)}`);
    expect(right![0], `right flat not inked ${fmt(right!)}`).toBeLessThanOrEqual(LOW);
    expect(right![1], `right flat keeps hue (G ~0) ${fmt(right!)}`).toBeLessThanOrEqual(LOW);
    // the boundary is a black contour line.
    for (let c = 0; c < 3; c++) expect(boundary![c]!, `boundary inked black ${fmt(boundary!)}`).toBeLessThanOrEqual(LOW);

    // gate to 0.35 (≈5× the boundary's peak gradient) → the line disappears.
    await setNodeParam(page, 'f-cel', 'threshold', 0.35);
    const [openGate] = await stepAndSample(page, [{ nodeId: 'f-cel', u: 0.5, v: 0.5 }]);
    expect(openGate![0]! + openGate![1]! + openGate![2]!,
      `boundary un-inked at high gate ${fmt(openGate!)}`).toBeGreaterThan(200);

    // gate back down but INK to 0 → the line disappears again (the strength
    // scales the composite, not the detection).
    await setNodeParam(page, 'f-cel', 'threshold', 0.02);
    await setNodeParam(page, 'f-cel', 'ink', 0);
    const [inkOff] = await stepAndSample(page, [{ nodeId: 'f-cel', u: 0.5, v: 0.5 }]);
    expect(inkOff![0]! + inkOff![1]! + inkOff![2]!,
      `boundary un-inked at ink 0 ${fmt(inkOff!)}`).toBeGreaterThan(200);
  });

  // ── 3. F-CS1 FIXED: the default setting preserves hue ─────────────────────
  //
  // THEORY: cel quantization bands LUMINANCE and preserves hue — a yellow
  // stays yellow, a magenta stays magenta (Winnemöller: chroma channels are
  // never quantized). REBUILD: chroma rides through the additive luma shift.
  // CPU-mirror expected values at the default (bands 4, softness 0.25):
  // yellow (255,255,0) → (255,255,29); magenta (255,0,255) → (235,0,235).
  // §12 R5: magenta's floor is 220 (computed 235 — keep a real margin; the
  // generic HIGH=231 floor would leave only 4 codes).
  test('[F-CS1] default setting preserves hue: yellow stays yellow, magenta stays magenta', async ({ page, errorWatch }) => {
    test.setTimeout(120_000);
    const yellow = await solidThroughCellshade(page, [1, 1, 0], { threshold: 0.2, thickness: 2, bits: 2, softness: 0.25, smooth: 0.35, ink: 1 });
    // a bright-band yellow — R and G high together, B low.
    expect(yellow[0], `yellow keeps R ${fmt(yellow)}`).toBeGreaterThanOrEqual(HIGH);
    expect(yellow[1], `yellow keeps G ${fmt(yellow)}`).toBeGreaterThanOrEqual(HIGH);
    expect(yellow[2], `yellow keeps B low ${fmt(yellow)}`).toBeLessThanOrEqual(80);

    const magenta = await solidThroughCellshade(page, [1, 0, 1], { threshold: 0.2, thickness: 2, bits: 2, softness: 0.25, smooth: 0.35, ink: 1 });
    expect(magenta[0], `magenta keeps R ${fmt(magenta)}`).toBeGreaterThanOrEqual(220);
    expect(magenta[2], `magenta keeps B ${fmt(magenta)}`).toBeGreaterThanOrEqual(220);
    expect(magenta[1], `magenta keeps G low ${fmt(magenta)}`).toBeLessThanOrEqual(LOW);
  });

  // ── 4. F-CS2 FIXED: moderate chroma survives the default setting ──────────
  //
  // THEORY: chroma survives cel quantization (only LUMINANCE is banded), so a
  // clearly-saturated subject keeps a visible hue cast. REBUILD: the skin
  // tone (0.8,0.6,0.5) lands in the 2/3 band with a tiny +0.018 luma lift →
  // ≈(209,158,132) per the CPU mirror; the pastel blue (0.55,0.55,1.0) keeps
  // its blue cast at ≈(157,157,255).
  test('[F-CS2] default setting keeps moderate saturation: a skin tone stays warm, not gray', async ({ page, errorWatch }) => {
    test.setTimeout(120_000);
    const skin = await solidThroughCellshade(page, [0.8, 0.6, 0.5], { threshold: 0.2, thickness: 2, bits: 2, softness: 0.25, smooth: 0.35, ink: 1 });
    expectNear(skin[0]!, 209, `skin R ${fmt(skin)}`);
    expectNear(skin[1]!, 158, `skin G ${fmt(skin)}`);
    expectNear(skin[2]!, 132, `skin B ${fmt(skin)}`);
    expect(skin[0]! - skin[2]!, `skin keeps its warm cast ${fmt(skin)}`).toBeGreaterThanOrEqual(30);

    const pastel = await solidThroughCellshade(page, [0.55, 0.55, 1], { threshold: 0.2, thickness: 2, bits: 2, softness: 0.25, smooth: 0.35, ink: 1 });
    expect(pastel[2]! - pastel[0]!, `pastel keeps its blue cast ${fmt(pastel)}`).toBeGreaterThanOrEqual(30);
  });

  // ── 5. F-CS3 FIXED: tonal bands follow LUMINANCE, not max(R,G,B) ──────────
  //
  // THEORY: cel banding quantizes PERCEIVED brightness (Rec.601 luma — the
  // same luma the ink pass uses). Saturated blue (0,0,1) has luma 0.114: at a
  // 2-band depth it belongs in the DARK band. §12 R1: the additive
  // chroma-preserving reconstruction realizes the band IN LUMA TERMS — the
  // output is (0,0,226): out-luma 25.8/255 (near-black to the eye, because
  // blue barely carries luma) with the HUE fully retained. Assert the output
  // LUMA ≤ 38/255 (25.8 + TOL headroom) + B ≫ R,G — NOT per-channel ≤ 60,
  // which no chroma-preserving YCbCr scheme can satisfy.
  test('[F-CS3] 2-band quantization sends dark-luma saturated blue to the DARK band (in luma terms)', async ({ page, errorWatch }) => {
    test.setTimeout(120_000);
    const blue = await solidThroughCellshade(page, [0, 0, 1], { threshold: 0.2, thickness: 2, bits: 0, softness: 0, smooth: 0, ink: 1 });
    const outLuma = 0.299 * blue[0]! + 0.587 * blue[1]! + 0.114 * blue[2]!;
    expect(outLuma, `sat blue lands in the dark band: out-luma ${outLuma.toFixed(1)} ${fmt(blue)}`).toBeLessThanOrEqual(38);
    // hue retained: B ≫ R, G (the dark band is realized by dimming, not by
    // desaturating to black — chroma is never quantized).
    expect(blue[2], `blue keeps its hue ${fmt(blue)}`).toBeGreaterThanOrEqual(200);
    expect(blue[0], `R stays ~0 ${fmt(blue)}`).toBeLessThanOrEqual(LOW);
    expect(blue[1], `G stays ~0 ${fmt(blue)}`).toBeLessThanOrEqual(LOW);
  });

  // ── 6. F-CS4 FIXED: quantization is SOFT (finite transition width) ────────
  //
  // THEORY (Winnemöller §3.2): luminance quantization uses a smooth
  // transition between bands — a small luminance neighbourhood straddling a
  // band boundary maps to nearby outputs (what keeps live video from
  // shimmering at band edges). Probes at u=0.48 / 0.52 straddle the 4-band
  // boundary at 0.5 by ±0.02 of luminance (§12 R3: bits 2 puts a threshold
  // EXACTLY at 0.5; the old bits-1 probes sat mid-band and asserted nothing).
  // The ≤30 assertion needs an EXPLICIT softness ≥ 0.7 — at softness 0.8 the
  // CPU mirror gives a ≈25-code jump (the module default 0.25 gives ≈71 BY
  // DESIGN: default bands must still read as bands; do NOT raise the default
  // to satisfy the test).
  test('[F-CS4] band transitions are soft at high softness: ±0.02 luma straddle maps to nearby outputs', async ({ page, errorWatch }) => {
    test.setTimeout(120_000);
    const [below, above] = await rampThroughCellshade(
      page,
      { threshold: 0.2, thickness: 2, bits: 2, softness: 0.8, smooth: 0, ink: 1 },
      [0.48, 0.52],
    );
    const jump = Math.abs(above![0]! - below![0]!);
    expect(jump, `soft band-boundary jump ${fmt(below!)} → ${fmt(above!)}`).toBeLessThanOrEqual(30);
  });

  // companion HARD anchor: the SAME probes at softness 0 jump the full band
  // step (85) — proving the ≤30 result above is the SOFTNESS knob's doing,
  // not a dead quantizer.
  test('[F-CS4] companion: the same straddle at softness 0 jumps the full hard band step', async ({ page, errorWatch }) => {
    test.setTimeout(120_000);
    const [below, above] = await rampThroughCellshade(
      page,
      { threshold: 0.2, thickness: 2, bits: 2, softness: 0, smooth: 0, ink: 1 },
      [0.48, 0.52],
    );
    const jump = Math.abs(above![0]! - below![0]!);
    expect(jump, `hard band-boundary jump ${fmt(below!)} → ${fmt(above!)}`).toBeGreaterThanOrEqual(70);
  });

  // ── 7. F-CS6 FIXED: the SMOOTH abstraction stage exists and is live ───────
  //
  // THEORY (Winnemöller step 1): an edge-preserving smoothing stage flattens
  // low-contrast texture into the large flat regions that read as painted.
  // Fixture: LINES fine grating (static under the DRS clock pin) → CHROMA
  // tintMix 0.7 (compresses contrast so the bilateral's range weights bite)
  // → CELLSHADE with ink 0 + near-continuous quantization (bands 8,
  // softness 1) so the measurement isolates P1/P2. smooth 0 is the TRUE
  // BYPASS (the passes are skipped in JS — §12 R4); smooth 1 must measurably
  // flatten the texture: full-frame variance drops.
  test('[F-CS6] SMOOTH flattens low-contrast texture (and smooth 0 bypasses the stage)', async ({ page, errorWatch }) => {
    test.setTimeout(120_000);
    await bootRack(page);
    await spawnPatch(
      page,
      [
        { id: 'f-lines', type: 'lines', position: { x: 40, y: 40 }, domain: 'video', params: { orient: 0, amp: 50, thickness: 0.35, phase: 0 } },
        { id: 'f-tint', type: 'chroma', position: { x: 360, y: 40 }, domain: 'video', params: { hue: 0, saturation: 1, tintR: 0.6, tintG: 0.45, tintB: 0.7, tintMix: 0.7 } },
        celNode('f-cel', { threshold: 0.95, thickness: 1, bits: 4, softness: 1, smooth: 0, ink: 0 }, 700, 40),
        sinkNode,
      ],
      [
        { id: 'e-l', from: { nodeId: 'f-lines', portId: 'out' }, to: { nodeId: 'f-tint', portId: 'in' }, sourceType: 'mono-video', targetType: 'video' },
        videoEdge('e-in', 'f-tint', 'out', 'f-cel', 'in'),
        videoEdge('e-o', 'f-cel', 'out', 'f-out', 'in'),
      ],
      { mountTimeout: HEAVY_MOUNT_TIMEOUT },
    );
    await expect(page.locator('.svelte-flow__node-cellshade'), 'CELLSHADE visible').toBeVisible();

    const raw = await stepAndReadStats(page, { nodeId: 'f-cel', steps: STEPS });
    expect(raw.glErrors, 'no GL errors (bypass path)').toEqual([]);
    expect(raw.variance, 'the grating carries real texture at smooth 0').toBeGreaterThan(20);

    await setNodeParam(page, 'f-cel', 'smooth', 1);
    const smoothed = await stepAndReadStats(page, { nodeId: 'f-cel', steps: STEPS });
    expect(smoothed.glErrors, 'no GL errors (bilateral path)').toEqual([]);
    expect(
      smoothed.variance,
      `smooth 1 flattens the texture (variance ${raw.variance.toFixed(1)} → ${smoothed.variance.toFixed(1)})`,
    ).toBeLessThan(raw.variance * 0.85);
  });
});
