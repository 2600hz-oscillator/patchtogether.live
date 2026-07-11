// e2e/tests/keyer-functional.spec.ts
//
// FUNCTIONAL validation of the keyer/compositor family (LUMA / LUMAKEY /
// CHROMA / CHROMAKEY) — phase 1 of the keyer-framework program (design doc:
// .myrobots/plans/keyer-framework-2026-07-11.md).
//
// Unlike the render-smoke suite (which asserts "something structured renders"
// and "a param moves pixels"), every test here asserts EXPECTED OUTPUT PIXELS
// derived from keying THEORY — not from the implementation:
//
//   - luma key:   alpha = soft ramp around a luma threshold on Y' (Rec.601
//                 here, consistently across the app); invert flips.
//   - chroma key: pixels whose color is close to the key color become
//                 background; kept subject pixels keep their color; spill
//                 suppression removes key-color contamination from KEPT
//                 pixels (the industry-standard despill is a green-limit,
//                 e.g. g' = min(g, f(r,b)) — Ben McEwan, "Deconstructing
//                 Despill Algorithms"; Nuke/Ultimatte spill controls).
//   - composite:  out = mix(bg, fg, alpha); an unpatched bg is defined
//                 (documented: opaque black), never garbage.
//
// DETERMINISM: the DRS hooks pause the rAF loop + pin the engine clock, and
// every fixture source is a pure function of UV (SHAPEDRAMPS h_lin ramp,
// CHROMA-as-solid-color via tintMix=1, FADER in WIPE mode as a two-region
// splitter), so a burst of engine.step()s renders bit-stable frames and the
// probes read exact pixels off the module's own FBO (gl.readPixels — no 2D
// blit, no wall clock). Assertions use SwiftShader-tolerant BANDS (±TOL on
// 0..255), never exact equality: CI's software renderer and a real GPU may
// disagree on low bits, never on a 14/255 band.
//
// PHASE-4 STATUS (the keying-core rebuild, design doc §4 + §11): every
// phase-1 finding is now RESOLVED and the former test.fixme rows below are
// hard assertions pinning the fixed behavior:
//   F-L1  LUMA "gamma" uses the inverse (Levels) convention pow(l, 1/gamma).
//         RESOLVED AS DOCS: the convention is deliberate and now explicit in
//         luma.ts docs ("Levels-style, >1 brightens"); the passing
//         "documented transfer" test pins it. (Its fixme was DELETED — the
//         display-gamma expectation was the doc-bug, not the shader.)
//   F-L2  LUMA posterizeLevels=16 (default AND max) is now a TRUE BYPASS, so
//         the documented "defaults pass the picture through untouched"
//         identity actually holds; 2..15 keep the floor-quantize banding.
//   F-C1  CHROMAKEY now keys on KEY-RELATIVE CHROMA-PLANE (CbCr) DISTANCE
//         (kcChromaMask in $lib/video/keying-core) — the low-chroma
//         green-cast subject survives the key (kept + despilled) while the
//         backdrop is replaced. Default threshold recalibrated 0.15 -> 0.5
//         (chroma distance scales with brightness; see the probe rows).
//   F-C2  CHROMAKEY spill suppression is now a dominant-channel min-limit
//         (kcDespill) acting on KEPT pixels — exactly where spill is
//         visible. Exact identity at spillSuppress = 0.
//   F-F1  FADER's factory now reads node.params at spawn, so persisted
//         fader/dryWet/transition positions survive a patch reload (the
//         reconciler only pushes params on CHANGE).

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch, type SpawnNode, type SpawnEdge } from './_helpers';
import { installRenderSmokeHooks } from './_render-smoke';

const STEPS = 4;          // fixed frame burst per read (loop paused)
const TOL = 14;           // ±band on 0..255 — clears renderer low-bit noise
const LOW = 24;           // "this channel is ~0" ceiling
const HIGH = 231;         // "this channel is ~255" floor

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
        // vUv maps 1:1 onto FBO texel space (procedural sources write R = u
        // etc.), and readPixels shares that origin — no flip needed.
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
 *  engine.setParam) — same helper video-controls.spec.ts proved. */
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
// ramp        SHAPEDRAMPS — h_lin output is a pure horizontal identity ramp
//             (R=G=B = u): a luminance gradient whose Rec.601 luma at any
//             probe is simply u (gray ⇒ luma = the channel value).
// solid(c)    CHROMA with tintMix=1 outputs the flat tint color exactly
//             (mix(shifted, tint, 1.0) == tint) — it only needs SOME input
//             patched to clear its uHasInput guard; the ramp serves.
// split(A|B)  FADER in WIPE mode at fader=0.5: LEFT half = in_b, RIGHT half
//             = in_a, soft edge only ±0.02 around x=0.5 (probes sit at
//             0.25/0.75, far outside it). The fixture pushes the two params
//             post-spawn via setNodeParam (the reconciler path) — that also
//             keeps the live-param chain covered; the F-F1 test below covers
//             the factory's spawn-time param read.

const rampNode: SpawnNode = { id: 'f-ramp', type: 'shapedramps', position: { x: 40, y: 40 }, domain: 'video' };

function solidNode(id: string, r: number, g: number, b: number, x = 40, y = 260): SpawnNode {
  return {
    id, type: 'chroma', position: { x, y }, domain: 'video',
    params: { hue: 0, saturation: 1, tintR: r, tintG: g, tintB: b, tintMix: 1 },
  };
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

const sinkNode: SpawnNode = { id: 'f-out', type: 'videoOut', position: { x: 900, y: 40 }, domain: 'video' };

async function bootRack(page: Page): Promise<void> {
  await installRenderSmokeHooks(page);
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
}

test.describe('keyer functional validation (theory-derived pixels)', () => {
  // ── 0. fixture sanity ─────────────────────────────────────────────────────
  test('fixtures: ramp, solid and wipe-split frames read back as constructed', async ({ page, errorWatch }) => {
    test.setTimeout(60_000);
    await bootRack(page);
    await spawnPatch(
      page,
      [
        rampNode,
        solidNode('f-red', 1, 0, 0, 40, 260),
        solidNode('f-green', 0, 1, 0, 40, 480),
        { id: 'f-split', type: 'fader', position: { x: 420, y: 260 }, domain: 'video' },
        sinkNode,
      ],
      [
        feedEdge('e-r1', 'f-red', 'in'),
        feedEdge('e-r2', 'f-green', 'in'),
        videoEdge('e-a', 'f-green', 'out', 'f-split', 'in_a'),
        videoEdge('e-b', 'f-red', 'out', 'f-split', 'in_b'),
        videoEdge('e-o', 'f-split', 'out', 'f-out', 'in'),
      ],
    );
    await expect(page.locator('.svelte-flow__node-fader'), 'FADER visible').toBeVisible();
    // Push the split params through the live chain (ydoc → reconciler →
    // setParam) — deliberately NOT via spawn params, so this fixture keeps
    // covering the live-mutation path (the F-F1 test covers spawn-time init).
    await setNodeParam(page, 'f-split', 'abTransition', 1); // WIPE
    await setNodeParam(page, 'f-split', 'fader', 0.5);

    const [ramp25, ramp75, red, splitL, splitR] = await stepAndSample(page, [
      { nodeId: 'f-ramp', portId: 'h_lin', u: 0.25, v: 0.5 },
      { nodeId: 'f-ramp', portId: 'h_lin', u: 0.75, v: 0.5 },
      { nodeId: 'f-red', u: 0.5, v: 0.5 },
      { nodeId: 'f-split', u: 0.25, v: 0.5 },
      { nodeId: 'f-split', u: 0.75, v: 0.5 },
    ]);

    // ramp: R=G=B=u.
    for (let c = 0; c < 3; c++) {
      expectNear(ramp25![c]!, 64, `ramp@0.25 ch${c} ${fmt(ramp25!)}`);
      expectNear(ramp75![c]!, 191, `ramp@0.75 ch${c} ${fmt(ramp75!)}`);
    }
    // solid red: exactly the tint.
    expect(red![0], `solid red R ${fmt(red!)}`).toBeGreaterThanOrEqual(HIGH);
    expect(red![1], `solid red G ${fmt(red!)}`).toBeLessThanOrEqual(LOW);
    expect(red![2], `solid red B ${fmt(red!)}`).toBeLessThanOrEqual(LOW);
    // split: left = in_b (red), right = in_a (green).
    expect(splitL![0], `split left is red ${fmt(splitL!)}`).toBeGreaterThanOrEqual(HIGH);
    expect(splitL![1], `split left no green ${fmt(splitL!)}`).toBeLessThanOrEqual(LOW);
    expect(splitR![1], `split right is green ${fmt(splitR!)}`).toBeGreaterThanOrEqual(HIGH);
    expect(splitR![0], `split right no red ${fmt(splitR!)}`).toBeLessThanOrEqual(LOW);
  });

  // ── FADER (F-F1: factory reads node.params at spawn) ─────────────────────
  test('FADER: [F-F1] spawn-time params take effect without a live param write', async ({ page, errorWatch }) => {
    test.setTimeout(60_000);
    await bootRack(page);
    // Spawn the FADER WITH its params — NO setNodeParam afterwards. Before
    // the F-F1 fix the factory initialized literals (fader 0.5 / FADE), so a
    // persisted WIPE split silently reset to a 50/50 FADE blend on reload.
    await spawnPatch(
      page,
      [
        rampNode,
        solidNode('f-red', 1, 0, 0, 40, 260),
        solidNode('f-green', 0, 1, 0, 40, 480),
        { id: 'f-split', type: 'fader', position: { x: 420, y: 260 }, domain: 'video',
          params: { fader: 0.5, abTransition: 1, dryWet: 0, dwTransition: 0 } },
        sinkNode,
      ],
      [
        feedEdge('e-r1', 'f-red', 'in'),
        feedEdge('e-r2', 'f-green', 'in'),
        videoEdge('e-a', 'f-green', 'out', 'f-split', 'in_a'),
        videoEdge('e-b', 'f-red', 'out', 'f-split', 'in_b'),
        videoEdge('e-o', 'f-split', 'out', 'f-out', 'in'),
      ],
    );
    await expect(page.locator('.svelte-flow__node-fader'), 'FADER visible').toBeVisible();

    const [left, right] = await stepAndSample(page, [
      { nodeId: 'f-split', u: 0.25, v: 0.5 },
      { nodeId: 'f-split', u: 0.75, v: 0.5 },
    ]);
    // WIPE at 0.5 from spawn params alone: left = in_b (pure red), right =
    // in_a (pure green). The pre-fix failure mode is unmistakable: FADE at
    // 0.5 gives (128,128,0) on BOTH probes.
    expect(left![0], `left is red ${fmt(left!)}`).toBeGreaterThanOrEqual(HIGH);
    expect(left![1], `left no green ${fmt(left!)}`).toBeLessThanOrEqual(LOW);
    expect(right![1], `right is green ${fmt(right!)}`).toBeGreaterThanOrEqual(HIGH);
    expect(right![0], `right no red ${fmt(right!)}`).toBeLessThanOrEqual(LOW);
  });

  // ── LUMA (single-input luminance processor) ───────────────────────────────
  test('LUMA: shader implements its DOCUMENTED transfer (pow(l,1/gamma); floor-posterize below the 16-level bypass)', async ({ page, errorWatch }) => {
    test.setTimeout(60_000);
    await bootRack(page);
    await spawnPatch(
      page,
      [
        rampNode,
        { id: 'f-luma', type: 'luma', position: { x: 420, y: 40 }, domain: 'video',
          params: { gamma: 2, contrast: 1, posterizeLevels: 16, bias: 0 } },
        sinkNode,
      ],
      [feedEdge('e-in', 'f-luma', 'in'), videoEdge('e-o', 'f-luma', 'out', 'f-out', 'in')],
    );
    await expect(page.locator('.svelte-flow__node-luma'), 'LUMA visible').toBeVisible();

    // Documented chain at gamma=2, posterize 16 = BYPASS (the probes are also
    // quantizer fixed points, so these exact values pinned the OLD 16-level
    // path too — the F-L2 bypass did not move them):
    //   l=0.36 → sqrt=0.600 → 153
    //   l=0.64 → sqrt=0.800 → 204
    // The gamma CONVENTION pinned here is the documented Levels-style INVERSE
    // pow(l, 1/gamma) — gamma 2 BRIGHTENS (0.36 → 0.60), the resolution of
    // finding F-L1 (display-gamma out=in^γ was the doc-bug, not the shader).
    const [p36, p64] = await stepAndSample(page, [
      { nodeId: 'f-luma', u: 0.36, v: 0.5 },
      { nodeId: 'f-luma', u: 0.64, v: 0.5 },
    ]);
    for (let c = 0; c < 3; c++) {
      expectNear(p36![c]!, 153, `luma(gamma2)@0.36 ch${c} ${fmt(p36!)}`);
      expectNear(p64![c]!, 204, `luma(gamma2)@0.64 ch${c} ${fmt(p64!)}`);
    }
    // chroma preservation: a gray input stays gray (equal channels).
    expect(Math.abs(p36![0]! - p36![1]!), 'gray in → gray out').toBeLessThanOrEqual(6);

    // Below the bypass the floor-posterize still bands (F-L2 kept 2..15
    // intact). levels=8 at gamma 2 (probes mid-quantizer-interval):
    //   l=0.36 → 0.600 → ·8=4.8 → floor 4 → 4/7≈0.571 → 146
    //   l=0.64 → 0.800 → ·8=6.4 → floor 6 → 6/7≈0.857 → 219
    await setNodeParam(page, 'f-luma', 'posterizeLevels', 8);
    const [q36, q64] = await stepAndSample(page, [
      { nodeId: 'f-luma', u: 0.36, v: 0.5 },
      { nodeId: 'f-luma', u: 0.64, v: 0.5 },
    ]);
    expectNear(q36![0]!, 146, `luma(gamma2,post8)@0.36 ${fmt(q36!)}`);
    expectNear(q64![0]!, 219, `luma(gamma2,post8)@0.64 ${fmt(q64!)}`);
  });

  // (The former F-L1 fixme — "gamma=2 darkens mid-gray to 0.25" — was DELETED:
  //  the finding resolved as a DOC-BUG. The shader's Levels-style inverse
  //  convention is deliberate, now explicit in luma.ts docs, and pinned by the
  //  documented-transfer test above.)

  // F-L2 (FIXED by the posterize-16 bypass): defaults are a true identity.
  test('LUMA: [F-L2] default params are an identity transfer', async ({ page, errorWatch }) => {
    test.setTimeout(60_000);
    await bootRack(page);
    await spawnPatch(
      page,
      [
        rampNode,
        { id: 'f-luma', type: 'luma', position: { x: 420, y: 40 }, domain: 'video',
          params: { gamma: 1, contrast: 1, posterizeLevels: 16, bias: 0 } },
        sinkNode,
      ],
      [feedEdge('e-in', 'f-luma', 'in'), videoEdge('e-o', 'f-luma', 'out', 'f-out', 'in')],
    );
    await expect(page.locator('.svelte-flow__node-luma'), 'LUMA visible').toBeVisible();
    const [hi, lo] = await stepAndSample(page, [
      { nodeId: 'f-luma', u: 0.95, v: 0.5 },  // in 242 → out 242 (pre-fix: crushed to 255)
      { nodeId: 'f-luma', u: 0.06, v: 0.5 },  // in 15  → out 15  (pre-fix: crushed to 0)
    ]);
    expect(Math.abs(hi![0]! - 242), `identity@0.95 ${fmt(hi!)}, want ≈242`).toBeLessThanOrEqual(8);
    expect(Math.abs(lo![0]! - 15), `identity@0.06 ${fmt(lo!)}, want ≈15`).toBeLessThanOrEqual(8);
  });

  // ── LUMAKEY (two-input luminance keyer) ───────────────────────────────────
  test('LUMAKEY: threshold splits a luma ramp between bg and fg; softness ramps; invert flips', async ({ page, errorWatch }) => {
    test.setTimeout(60_000);
    await bootRack(page);
    await spawnPatch(
      page,
      [
        rampNode,
        solidNode('f-red', 1, 0, 0),
        { id: 'f-lk', type: 'lumakey', position: { x: 420, y: 40 }, domain: 'video',
          params: { threshold: 0.5, softness: 0.05, invert: 0 } },
        sinkNode,
      ],
      [
        feedEdge('e-fg', 'f-lk', 'fg'),
        feedEdge('e-r1', 'f-red', 'in'),
        videoEdge('e-bg', 'f-red', 'out', 'f-lk', 'bg'),
        videoEdge('e-o', 'f-lk', 'out', 'f-out', 'in'),
      ],
    );
    await expect(page.locator('.svelte-flow__node-lumakey'), 'LUMAKEY visible').toBeVisible();

    const [dark, mid, bright] = await stepAndSample(page, [
      { nodeId: 'f-lk', u: 0.25, v: 0.5 },
      { nodeId: 'f-lk', u: 0.5, v: 0.5 },
      { nodeId: 'f-lk', u: 0.75, v: 0.5 },
    ]);
    // theory: luma 0.25 < thr-soft → alpha 0 → pure BG (red).
    expect(dark![0], `dark side shows bg (red) ${fmt(dark!)}`).toBeGreaterThanOrEqual(HIGH);
    expect(dark![1], `dark side no fg bleed ${fmt(dark!)}`).toBeLessThanOrEqual(LOW);
    // theory: luma 0.75 > thr+soft → alpha 1 → pure FG (0.75 gray).
    for (let c = 0; c < 3; c++) expectNear(bright![c]!, 191, `bright side is fg gray ch${c} ${fmt(bright!)}`);
    // theory: AT the threshold the soft ramp is half-open → ≈50/50 mix:
    // mix(red, 0.5-gray, ~0.5) ≈ (188, 68, 68). Wider band (smoothstep slope
    // is steep here: ±1 input byte ≈ ∓7 output).
    expect(Math.abs(mid![0]! - 188), `soft edge R ${fmt(mid!)}`).toBeLessThanOrEqual(20);
    expect(Math.abs(mid![1]! - 68), `soft edge G ${fmt(mid!)}`).toBeLessThanOrEqual(20);

    // invert=1 through the live param chain: matte flips.
    await setNodeParam(page, 'f-lk', 'invert', 1);
    const [iDark, iBright] = await stepAndSample(page, [
      { nodeId: 'f-lk', u: 0.25, v: 0.5 },
      { nodeId: 'f-lk', u: 0.75, v: 0.5 },
    ]);
    for (let c = 0; c < 3; c++) expectNear(iDark![c]!, 64, `inverted dark side is fg gray ch${c} ${fmt(iDark!)}`);
    expect(iBright![0], `inverted bright side shows bg ${fmt(iBright!)}`).toBeGreaterThanOrEqual(HIGH);
    expect(iBright![1], `inverted bright side no fg ${fmt(iBright!)}`).toBeLessThanOrEqual(LOW);
  });

  test('LUMAKEY: unpatched bg composites against opaque black (documented fallback)', async ({ page, errorWatch }) => {
    test.setTimeout(60_000);
    await bootRack(page);
    await spawnPatch(
      page,
      [
        rampNode,
        { id: 'f-lk', type: 'lumakey', position: { x: 420, y: 40 }, domain: 'video',
          params: { threshold: 0.5, softness: 0.05, invert: 0 } },
        sinkNode,
      ],
      [feedEdge('e-fg', 'f-lk', 'fg'), videoEdge('e-o', 'f-lk', 'out', 'f-out', 'in')],
    );
    await expect(page.locator('.svelte-flow__node-lumakey'), 'LUMAKEY visible').toBeVisible();
    const [dark, bright] = await stepAndSample(page, [
      { nodeId: 'f-lk', u: 0.25, v: 0.5 },
      { nodeId: 'f-lk', u: 0.75, v: 0.5 },
    ]);
    for (let c = 0; c < 3; c++) {
      expect(dark![c]!, `keyed-out region is black ${fmt(dark!)}`).toBeLessThanOrEqual(LOW);
      expectNear(bright![c]!, 191, `kept region is fg ch${c} ${fmt(bright!)}`);
    }
  });

  // ── CHROMAKEY (two-input chroma keyer) ────────────────────────────────────
  test('CHROMAKEY: green regions become bg, non-green fg is kept, no residue', async ({ page, errorWatch }) => {
    test.setTimeout(60_000);
    await bootRack(page);
    await spawnPatch(
      page,
      [
        rampNode,
        solidNode('f-green', 0, 1, 0, 40, 260),
        solidNode('f-red', 1, 0, 0, 40, 480),
        solidNode('f-blue', 0, 0, 1, 40, 700),
        { id: 'f-split', type: 'fader', position: { x: 420, y: 260 }, domain: 'video' },
        { id: 'f-ck', type: 'chromakey', position: { x: 700, y: 260 }, domain: 'video',
          params: { keyR: 0, keyG: 1, keyB: 0, threshold: 0.15, softness: 0.08, spillSuppress: 0.5 } },
        sinkNode,
      ],
      [
        feedEdge('e-r1', 'f-green', 'in'),
        feedEdge('e-r2', 'f-red', 'in'),
        feedEdge('e-r3', 'f-blue', 'in'),
        videoEdge('e-a', 'f-green', 'out', 'f-split', 'in_a'),
        videoEdge('e-b', 'f-red', 'out', 'f-split', 'in_b'),
        videoEdge('e-fg', 'f-split', 'out', 'f-ck', 'fg'),
        videoEdge('e-bg', 'f-blue', 'out', 'f-ck', 'bg'),
        videoEdge('e-o', 'f-ck', 'out', 'f-out', 'in'),
      ],
    );
    await expect(page.locator('.svelte-flow__node-chromakey'), 'CHROMAKEY visible').toBeVisible();
    await setNodeParam(page, 'f-split', 'abTransition', 1); // WIPE
    await setNodeParam(page, 'f-split', 'fader', 0.5);

    const [redSide, greenSide] = await stepAndSample(page, [
      { nodeId: 'f-ck', u: 0.25, v: 0.5 },  // fg = red   → kept
      { nodeId: 'f-ck', u: 0.75, v: 0.5 },  // fg = green → keyed to bg (blue)
    ]);
    // theory: red is far from the green key → kept, unmodified.
    expect(redSide![0], `red fg kept ${fmt(redSide!)}`).toBeGreaterThanOrEqual(HIGH);
    expect(redSide![2], `no bg bleed into kept fg ${fmt(redSide!)}`).toBeLessThanOrEqual(LOW);
    // theory: pure key color → pure background, with NO green residue.
    expect(greenSide![2], `green region shows bg (blue) ${fmt(greenSide!)}`).toBeGreaterThanOrEqual(HIGH);
    expect(greenSide![1], `no green residue over bg ${fmt(greenSide!)}`).toBeLessThanOrEqual(LOW);
    expect(greenSide![0], `no red in keyed region ${fmt(greenSide!)}`).toBeLessThanOrEqual(LOW);
  });

  // F-C1 (FIXED by kcChromaMask; assertion REWRITTEN per §11 change 1): a
  // mildly green-cast SUBJECT pixel — (0.6, 0.75, 0.55), the color of
  // foliage-bounce on skin/cloth — sat 0.27, hue within 0.042 of the key: the
  // OLD hue-angle metric keyed it out entirely (bg flooded through). Under
  // the chroma-plane metric it sits at normalized d = 0.828 — far outside
  // the key band — so it is KEPT and despilled, while the actual green
  // screen next to it IS replaced by the background. NOTE the original fixme
  // asserted B ≤ 120, which no correct keyer can satisfy: the KEPT subject's
  // OWN blue channel is 140. The rewritten bands assert the theory-derived
  // kept color (153, 172, 140) = despill(subject, green, 0.5) — "no bg
  // flood" means B ≈ the subject's own 140, far below the bg's 255.
  test('CHROMAKEY: [F-C1] green-cast subject survives the key while the green screen is replaced', async ({ page, errorWatch }) => {
    test.setTimeout(60_000);
    await bootRack(page);
    await spawnPatch(
      page,
      [
        rampNode,
        solidNode('f-green', 0, 1, 0, 40, 260),
        solidNode('f-subj', 0.6, 0.75, 0.55, 40, 480),
        solidNode('f-blue', 0, 0, 1, 40, 700),
        { id: 'f-split', type: 'fader', position: { x: 420, y: 260 }, domain: 'video' },
        // Params = the SHIPPED defaults (thr 0.5 / soft 0.08 / spill 0.5) —
        // this row doubles as the default-calibration pin for the subject.
        { id: 'f-ck', type: 'chromakey', position: { x: 700, y: 260 }, domain: 'video',
          params: { keyR: 0, keyG: 1, keyB: 0, threshold: 0.5, softness: 0.08, spillSuppress: 0.5 } },
        sinkNode,
      ],
      [
        feedEdge('e-r1', 'f-green', 'in'),
        feedEdge('e-r2', 'f-subj', 'in'),
        feedEdge('e-r3', 'f-blue', 'in'),
        videoEdge('e-a', 'f-subj', 'out', 'f-split', 'in_a'),
        videoEdge('e-b', 'f-green', 'out', 'f-split', 'in_b'),
        videoEdge('e-fg', 'f-split', 'out', 'f-ck', 'fg'),
        videoEdge('e-bg', 'f-blue', 'out', 'f-ck', 'bg'),
        videoEdge('e-o', 'f-ck', 'out', 'f-out', 'in'),
      ],
    );
    await expect(page.locator('.svelte-flow__node-chromakey'), 'CHROMAKEY visible').toBeVisible();
    await setNodeParam(page, 'f-split', 'abTransition', 1); // WIPE
    await setNodeParam(page, 'f-split', 'fader', 0.5);

    const [screen, subj] = await stepAndSample(page, [
      { nodeId: 'f-ck', u: 0.25, v: 0.5 },  // fg = green screen → replaced by bg
      { nodeId: 'f-ck', u: 0.75, v: 0.5 },  // fg = subject      → kept + despilled
    ]);
    // bg-replacement where the green was: pure blue, no green residue.
    expect(screen![2], `green screen shows bg (blue) ${fmt(screen!)}`).toBeGreaterThanOrEqual(HIGH);
    expect(screen![1], `no green residue over bg ${fmt(screen!)}`).toBeLessThanOrEqual(LOW);
    // subject kept at its despilled color (0.6, 0.675, 0.55) → (153,172,140):
    expectNear(subj![0]!, 153, `subject R kept ${fmt(subj!)}`);
    expectNear(subj![2]!, 140, `subject B is its OWN blue (no bg flood) ${fmt(subj!)}`);
    expectNear(subj![1]!, 172, `subject G despilled ${fmt(subj!)}`);
    // and G stays below ~180 — the undespilled subject would read 191, so
    // this proves kcDespill acted on a fully-KEPT (alpha=1) pixel.
    expect(subj![1], `despill acted on the kept pixel ${fmt(subj!)}`).toBeLessThanOrEqual(180);
  });

  // §11 change 2 — the realistic-screen probes at TRUE DEFAULTS (the node is
  // spawned WITHOUT params, so this pins the shipped defaultValue path):
  // chroma-plane distance scales with brightness, so the default threshold
  // was recalibrated 0.15 → 0.5 to key real-world screen variation:
  //   realistic screen green (0.2, 0.8, 0.3) → d = 0.454 → keyed
  //   half-brightness key green (0, 0.5, 0)  → d = 0.500 → keyed
  test('CHROMAKEY: realistic screen variation keys out at DEFAULT settings', async ({ page, errorWatch }) => {
    test.setTimeout(60_000);
    await bootRack(page);
    await spawnPatch(
      page,
      [
        rampNode,
        solidNode('f-real', 0.2, 0.8, 0.3, 40, 260),
        solidNode('f-half', 0, 0.5, 0, 40, 480),
        solidNode('f-blue', 0, 0, 1, 40, 700),
        { id: 'f-split', type: 'fader', position: { x: 420, y: 260 }, domain: 'video' },
        { id: 'f-ck', type: 'chromakey', position: { x: 700, y: 260 }, domain: 'video' }, // NO params
        sinkNode,
      ],
      [
        feedEdge('e-r1', 'f-real', 'in'),
        feedEdge('e-r2', 'f-half', 'in'),
        feedEdge('e-r3', 'f-blue', 'in'),
        videoEdge('e-a', 'f-half', 'out', 'f-split', 'in_a'),
        videoEdge('e-b', 'f-real', 'out', 'f-split', 'in_b'),
        videoEdge('e-fg', 'f-split', 'out', 'f-ck', 'fg'),
        videoEdge('e-bg', 'f-blue', 'out', 'f-ck', 'bg'),
        videoEdge('e-o', 'f-ck', 'out', 'f-out', 'in'),
      ],
    );
    await expect(page.locator('.svelte-flow__node-chromakey'), 'CHROMAKEY visible').toBeVisible();
    await setNodeParam(page, 'f-split', 'abTransition', 1); // WIPE
    await setNodeParam(page, 'f-split', 'fader', 0.5);

    const [real, half] = await stepAndSample(page, [
      { nodeId: 'f-ck', u: 0.25, v: 0.5 },  // fg = realistic screen → keyed
      { nodeId: 'f-ck', u: 0.75, v: 0.5 },  // fg = half-brightness key → keyed
    ]);
    for (const [label, px] of [['realistic screen', real], ['half-brightness key', half]] as const) {
      expect(px![2], `${label} keyed to bg (blue) ${fmt(px!)}`).toBeGreaterThanOrEqual(HIGH);
      expect(px![1], `${label} no green residue ${fmt(px!)}`).toBeLessThanOrEqual(LOW);
      expect(px![0], `${label} no red residue ${fmt(px!)}`).toBeLessThanOrEqual(LOW);
    }
  });

  // F-C2 (FIXED by kcDespill): spill suppression now reaches KEPT pixels.
  // fg = (0.8, 0.9, 0.3) — a kept, green-contaminated pixel (chroma-plane
  // d = 0.787, outside the key band → alpha = 1; green dominates max(r,b)).
  // Despill = dominant-channel min-limit on the kept fg: spillSuppress 0 → 1
  // pulls G from 0.9 down to max(r,b) = 0.8 (230 → 204, Δ = 26/255). At
  // spillSuppress 0 the passthrough is EXACT (bit-identical, no fudge).
  test('CHROMAKEY: [F-C2] spillSuppress removes green contamination from kept fg', async ({ page, errorWatch }) => {
    test.setTimeout(60_000);
    await bootRack(page);
    await spawnPatch(
      page,
      [
        rampNode,
        solidNode('f-spill', 0.8, 0.9, 0.3, 40, 260),
        solidNode('f-blue', 0, 0, 1, 40, 480),
        { id: 'f-ck', type: 'chromakey', position: { x: 700, y: 260 }, domain: 'video',
          params: { keyR: 0, keyG: 1, keyB: 0, threshold: 0.15, softness: 0.08, spillSuppress: 0 } },
        sinkNode,
      ],
      [
        feedEdge('e-r1', 'f-spill', 'in'),
        feedEdge('e-r2', 'f-blue', 'in'),
        videoEdge('e-fg', 'f-spill', 'out', 'f-ck', 'fg'),
        videoEdge('e-bg', 'f-blue', 'out', 'f-ck', 'bg'),
        videoEdge('e-o', 'f-ck', 'out', 'f-out', 'in'),
      ],
    );
    await expect(page.locator('.svelte-flow__node-chromakey'), 'CHROMAKEY visible').toBeVisible();
    const [noSpill] = await stepAndSample(page, [{ nodeId: 'f-ck', u: 0.5, v: 0.5 }]);
    // sanity: pixel is kept and green-dominant at spill=0.
    expect(noSpill![1], `kept spill pixel G ${fmt(noSpill!)}`).toBeGreaterThanOrEqual(215);
    await setNodeParam(page, 'f-ck', 'spillSuppress', 1);
    const [fullSpill] = await stepAndSample(page, [{ nodeId: 'f-ck', u: 0.5, v: 0.5 }]);
    // THEORY: full spill suppression reduces the green channel measurably.
    expect(
      noSpill![1]! - fullSpill![1]!,
      `spill 0→1 must reduce G on a kept pixel: ${fmt(noSpill!)} → ${fmt(fullSpill!)}`,
    ).toBeGreaterThanOrEqual(13);
  });

  // ── CHROMA (single-input hue-shifter — the processor half of the split) ──
  test('CHROMA: hue=120° rotates red to green; saturation=0 collapses to HSV value-gray', async ({ page, errorWatch }) => {
    test.setTimeout(60_000);
    await bootRack(page);
    await spawnPatch(
      page,
      [
        rampNode,
        solidNode('f-red', 1, 0, 0),
        { id: 'f-fx', type: 'chroma', position: { x: 700, y: 40 }, domain: 'video',
          params: { hue: 120, saturation: 1, tintR: 1, tintG: 1, tintB: 1, tintMix: 0 } },
        sinkNode,
      ],
      [
        feedEdge('e-r1', 'f-red', 'in'),
        videoEdge('e-in', 'f-red', 'out', 'f-fx', 'in'),
        videoEdge('e-o', 'f-fx', 'out', 'f-out', 'in'),
      ],
    );
    await expect(page.locator('.svelte-flow__node-chroma').nth(0), 'CHROMA visible').toBeVisible();

    const [rot] = await stepAndSample(page, [{ nodeId: 'f-fx', u: 0.5, v: 0.5 }]);
    // theory: hue 0° (red) + 120° = 120° (green), s/v preserved.
    expect(rot![1], `red+120° is green ${fmt(rot!)}`).toBeGreaterThanOrEqual(HIGH);
    expect(rot![0], `red+120° no red left ${fmt(rot!)}`).toBeLessThanOrEqual(LOW);
    expect(rot![2], `red+120° no blue ${fmt(rot!)}`).toBeLessThanOrEqual(LOW);

    // characterization (documented HSV semantics, NOT a finding): saturation=0
    // collapses to the HSV VALUE gray — red becomes WHITE (v=1), not its
    // luma gray (~76). A luma-preserving desaturate would return ~0.30 gray;
    // the docs say "HSV" and "0 collapses to grayscale", which this satisfies.
    await setNodeParam(page, 'f-fx', 'hue', 0);
    await setNodeParam(page, 'f-fx', 'saturation', 0);
    const [desat] = await stepAndSample(page, [{ nodeId: 'f-fx', u: 0.5, v: 0.5 }]);
    for (let c = 0; c < 3; c++) {
      expect(desat![c]!, `desat red is HSV value-white ch${c} ${fmt(desat!)}`).toBeGreaterThanOrEqual(HIGH);
    }
  });
});
