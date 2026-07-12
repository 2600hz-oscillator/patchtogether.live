// e2e/tests/posterbox-functional.spec.ts
//
// FUNCTIONAL validation of POSTERBOX against PALETTE-CRUSH THEORY — the
// house theory-derived-pixels pattern (cellshade-functional.spec.ts /
// keyer-functional.spec.ts): every test asserts EXPECTED OUTPUT PIXELS
// derived from what retro palette quantization actually IS, not from the
// implementation. The reference model:
//
//   1. PER-CHANNEL floor quantization to an authentic bit allocation
//      (RGB 3-3-2 truecolor, RGB565 hi-colour, …) — classic posterization;
//      the SAME floor(v*n)/(n-1) math the legacy CELLSHADE "8-bit"/"16-bit"
//      retro modes used (this module is their dedicated home after the
//      cellshade rebuild dropped them).
//   2. ORDERED DITHERING (Bayer 1973): a screen-position threshold from
//      the standard Bayer 4×4 index matrix perturbs the quantizer decision
//      — the classic companion to palette crush (the PlayStation applied
//      exactly this offset-before-truncate scheme ahead of its 15-bit
//      output), turning gradient banding into cross-hatch.
//   3. Dry/wet MIX is a straight lerp.
//
// LINEAGE — CONTINUITY ANCHORS: the pinned values from the old CELLSHADE
// characterization (gray 0.2 → (36,36,0) at 3-3-2; gray 0.6 → (146,146,170))
// are asserted here as regression anchors, proving an old cellshade retro
// patch recreates byte-exact (within the SwiftShader band) by swapping in
// POSTERBOX. "Tints neutral grays" is the documented feature under test,
// not a bug.
//
// DETERMINISM: identical to the DRS pattern — installRenderSmokeHooks
// pauses the rAF loop + pins the engine clock, every fixture is a pure
// function of UV (SHAPEDRAMPS h_lin identity ramp; CHROMA as a solid via
// tintMix=1), and probes read exact texels off the module's own FBO
// (gl.readPixels) after a fixed synchronous burst of engine.step()s.
// Assertions use SwiftShader-tolerant BANDS (±TOL on 0..255); solid-colour
// fixtures are chosen so 8-bit input rounding can never flip a quantizer
// band (each probe value sits ≥3 code values from a band threshold).
//
// LANE: this file is enrolled in WEBGL_HEAVY_GLOBS (it readPixels()es real
// FBOs), so it runs on the serialized e2e-video lane, never a sharded
// SwiftShader shard.

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch, type SpawnNode, type SpawnEdge } from './_helpers';
import { installRenderSmokeHooks } from './_render-smoke';

const STEPS = 4;   // fixed frame burst per read (loop paused)
const TOL = 14;    // ±band on 0..255 — clears renderer low-bit noise
const LOW = 24;    // "this channel is ~0" ceiling
const HIGH = 231;  // "this channel is ~255" floor

// Single-pass shader, but the module still mounts through the WebGL card
// pipeline — same CI SwiftShader first-paint headroom as the other video
// effects.
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

/** Rect variant: step the engine, then read a w×h texel BLOCK centred at
 *  normalized (u, v) off one node's output FBO. Returns row-major rows of
 *  [r,g,b] triples — the dither-pattern probes need spatial structure, not
 *  single texels. */
async function stepAndSampleRect(
  page: Page,
  opts: { nodeId: string; u: number; v: number; w: number; h: number },
  steps = STEPS,
): Promise<number[][][]> {
  return page.evaluate(
    ({ nodeId, u, v, rw, rh, steps }) => {
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
      const x0 = Math.min(W - rw, Math.max(0, Math.round(u * W) - Math.floor(rw / 2)));
      const y0 = Math.min(H - rh, Math.max(0, Math.round(v * H) - Math.floor(rh / 2)));
      const tex = vid.outputTexture(nodeId);
      if (!tex) throw new Error(`no output texture for ${nodeId}`);
      const fb = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error(`FBO incomplete for ${nodeId}`);
      }
      const px = new Uint8Array(rw * rh * 4);
      gl.readPixels(x0, y0, rw, rh, gl.RGBA, gl.UNSIGNED_BYTE, px);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fb);
      const errs: number[] = [];
      let e: number;
      while ((e = gl.getError()) !== gl.NO_ERROR) errs.push(e);
      if (errs.length) throw new Error(`GL errors during rect sample: [${errs.join(',')}]`);

      const rows: number[][][] = [];
      for (let y = 0; y < rh; y++) {
        const row: number[][] = [];
        for (let x = 0; x < rw; x++) {
          const i = (y * rw + x) * 4;
          row.push([px[i]!, px[i + 1]!, px[i + 2]!]);
        }
        rows.push(row);
      }
      return rows;
    },
    { nodeId: opts.nodeId, u: opts.u, v: opts.v, rw: opts.w, rh: opts.h, steps },
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

/** Normalized hue (0..1) of an 8-bit RGB triple — for the hue-order assert. */
function hueOf(px: readonly number[]): number {
  const r = px[0]! / 255, g = px[1]! / 255, b = px[2]! / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d <= 0) return 0;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h /= 6;
  return h < 0 ? h + 1 : h;
}

// ── shared fixture nodes ────────────────────────────────────────────────────
//
// ramp      SHAPEDRAMPS h_lin — pure horizontal identity ramp (R=G=B = u): a
//           NEUTRAL luminance gradient.
// solid(c)  CHROMA with tintMix=1 outputs the flat tint colour exactly; it
//           only needs SOME input patched to clear its uHasInput guard (ramp
//           serves).

const rampNode: SpawnNode = { id: 'f-ramp', type: 'shapedramps', position: { x: 40, y: 40 }, domain: 'video' };

function solidNode(id: string, r: number, g: number, b: number): SpawnNode {
  return {
    id, type: 'chroma', position: { x: 40, y: 260 }, domain: 'video',
    params: { hue: 0, saturation: 1, tintR: r, tintG: g, tintB: b, tintMix: 1 },
  };
}

function crushNode(id: string, params: Record<string, number>): SpawnNode {
  return { id, type: 'posterbox', position: { x: 700, y: 40 }, domain: 'video', params };
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

/** solid(r,g,b) → posterbox(params) → out, ready for centre probes. */
async function spawnSolidChain(
  page: Page,
  rgb: [number, number, number],
  params: Record<string, number>,
): Promise<void> {
  await bootRack(page);
  await spawnPatch(
    page,
    [rampNode, solidNode('f-solid', ...rgb), crushNode('f-crush', params), sinkNode],
    [
      feedEdge('e-r1', 'f-solid', 'in'),
      videoEdge('e-in', 'f-solid', 'out', 'f-crush', 'in'),
      videoEdge('e-o', 'f-crush', 'out', 'f-out', 'in'),
    ],
    { mountTimeout: HEAVY_MOUNT_TIMEOUT },
  );
  await expect(page.locator('.svelte-flow__node-posterbox'), 'POSTERBOX visible').toBeVisible();
}

/** ramp → posterbox(params) → out. */
async function spawnRampChain(page: Page, params: Record<string, number>): Promise<void> {
  await bootRack(page);
  await spawnPatch(
    page,
    [rampNode, crushNode('f-crush', params), sinkNode],
    [feedEdge('e-in', 'f-crush', 'in'), videoEdge('e-o', 'f-crush', 'out', 'f-out', 'in')],
    { mountTimeout: HEAVY_MOUNT_TIMEOUT },
  );
  await expect(page.locator('.svelte-flow__node-posterbox'), 'POSTERBOX visible').toBeVisible();
}

const centreProbe = { nodeId: 'f-crush', u: 0.5, v: 0.5 } as const;

test.describe('POSTERBOX functional validation (palette-crush-theory-derived pixels)', () => {
  // ── 1. LEGACY CONTINUITY ANCHORS + the MIX dry/wet sweep ──────────────────
  //
  // THEORY: RGB 3-3-2 has different level grids per channel (8/8/4), so a
  // NEUTRAL gray tints — the period-correct channel-clipped cast. The pinned
  // legacy values: gray 0.2 → (36,36,0) (dark olive) and gray 0.6 →
  // (146,146,170) (bluish) — the SAME bytes the old CELLSHADE 8-bit mode
  // produced (floor(v·8)/7, floor(v·4)/3). MIX lerps back to the source:
  // at 0.5 the B channel sits exactly between crush (0) and dry (51).
  test('continuity anchors: the legacy 3-3-2 crush is byte-exact, and MIX sweeps dry→wet', async ({ page, errorWatch }) => {
    test.setTimeout(120_000);
    await spawnSolidChain(page, [0.2, 0.2, 0.2], { depth: 2, dither: 0, mix: 1 });

    // full crush: THE anchor — gray 0.2 → (36,36,0).
    const [wet] = await stepAndSample(page, [centreProbe]);
    expectNear(wet![0]!, 36, `anchor R ${fmt(wet!)}`);
    expectNear(wet![1]!, 36, `anchor G ${fmt(wet!)}`);
    expect(wet![2]!, `anchor B crushes to 0 ${fmt(wet!)}`).toBeLessThanOrEqual(LOW - 10);

    // half mix: linear midpoint — B at (0+51)/2.
    await setNodeParam(page, 'f-crush', 'mix', 0.5);
    const [half] = await stepAndSample(page, [centreProbe]);
    expectNear(half![0]!, 44, `half-mix R ${fmt(half!)}`);
    expectNear(half![2]!, 26, `half-mix B ${fmt(half!)}`);

    // dry: the untouched source gray.
    await setNodeParam(page, 'f-crush', 'mix', 0);
    const [dry] = await stepAndSample(page, [centreProbe]);
    for (let c = 0; c < 3; c++) expectNear(dry![c]!, 51, `dry ch${c} ${fmt(dry!)}`);

    // the second anchor: gray 0.6 → (146,146,170) — the tint swings BLUE
    // above (B's 4-level grid lands HIGHER than R/G's 8-level grid there).
    await setNodeParam(page, 'f-crush', 'mix', 1);
    await setNodeParam(page, 'f-solid', 'tintR', 0.6);
    await setNodeParam(page, 'f-solid', 'tintG', 0.6);
    await setNodeParam(page, 'f-solid', 'tintB', 0.6);
    const [wet6] = await stepAndSample(page, [centreProbe]);
    expectNear(wet6![0]!, 146, `anchor2 R ${fmt(wet6!)}`);
    expectNear(wet6![1]!, 146, `anchor2 G ${fmt(wet6!)}`);
    expectNear(wet6![2]!, 170, `anchor2 B ${fmt(wet6!)}`);
    expect(wet6![2]! - wet6![0]!, `anchor2 tints blue ${fmt(wet6!)}`).toBeGreaterThanOrEqual(10);
  });

  // ── 2. the DEPTH ladder's two ends: brutal 1-bit vs subtle 5-6-5 ──────────
  //
  // THEORY: at 1-1-1 a neutral ramp collapses to TWO hard bands (black below
  // v=0.5, white above) and stays neutral (symmetric grids can't tint). At
  // 5-6-5 the crush is NEAR-INVISIBLE on a gray (max per-channel error
  // 255/31 ≈ 8 codes) — the subtle end of the same knob, far from the 255
  // the 1-bit step produced at the same probe.
  test('DEPTH range: 1-bit collapses the ramp to 2 neutral bands; 5-6-5 is a subtle rounding', async ({ page, errorWatch }) => {
    test.setTimeout(120_000);
    await spawnRampChain(page, { depth: 0, dither: 0, mix: 1 });

    const probes = [0.1, 0.35, 0.65, 0.9].map((u) => ({ nodeId: 'f-crush', u, v: 0.5 }));
    const [b0, b1, w0, w1] = await stepAndSample(page, probes);
    for (const px of [b0, b1]) {
      for (let c = 0; c < 3; c++) expect(px![c]!, `dark band ch${c} ${fmt(px!)}`).toBeLessThanOrEqual(LOW);
    }
    for (const px of [w0, w1]) {
      for (let c = 0; c < 3; c++) expect(px![c]!, `light band ch${c} ${fmt(px!)}`).toBeGreaterThanOrEqual(HIGH);
    }

    // the subtle end: 5-6-5 at u=0.6 → (156,154,156) per the CPU mirror
    // (floor(0.6·32)/31, floor(0.6·64)/63) — near the source gray 153,
    // ~100 codes away from the 255 the brutal step showed here.
    await setNodeParam(page, 'f-crush', 'depth', 4);
    const [subtle] = await stepAndSample(page, [{ nodeId: 'f-crush', u: 0.6, v: 0.5 }]);
    expectNear(subtle![0]!, 156, `565 R ${fmt(subtle!)}`);
    expectNear(subtle![1]!, 154, `565 G ${fmt(subtle!)}`);
    expectNear(subtle![2]!, 156, `565 B ${fmt(subtle!)}`);
    expect(subtle![0]!, `565 is NOT the 1-bit white ${fmt(subtle!)}`).toBeLessThanOrEqual(200);
  });

  // ── 3. a hue ramp keeps hue ORDER but shows palette steps ─────────────────
  //
  // THEORY: per-channel floor quantization is MONOTONE per channel, so
  // sweeping a hue path (red → yellow-orange → chartreuse → spring → azure)
  // yields outputs whose hues keep the SAME ORDER — but nearby hues COLLAPSE
  // onto the same palette entry (the "steps"). Expected outputs at 3-3-2 are
  // computed from the CPU mirror (0.55 → floor(0.55·8)/7 = 146; 0.55 →
  // floor(0.55·4)/3 = 170 on B).
  test('hue sweep: order preserved through the crush, nearby hues collapse onto one palette step', async ({ page, errorWatch }) => {
    test.setTimeout(120_000);
    await spawnSolidChain(page, [1, 0, 0], { depth: 2, dither: 0, mix: 1 });

    const sweep: Array<{ tint: [number, number, number]; want: [number, number, number] }> = [
      { tint: [1, 0, 0],    want: [255, 0, 0] },
      { tint: [1, 0.55, 0], want: [255, 146, 0] },
      { tint: [0.55, 1, 0], want: [146, 255, 0] },
      { tint: [0, 1, 0.55], want: [0, 255, 170] },
      { tint: [0, 0.55, 1], want: [0, 146, 255] },
    ];
    const hues: number[] = [];
    for (const [i, step] of sweep.entries()) {
      await setNodeParam(page, 'f-solid', 'tintR', step.tint[0]);
      await setNodeParam(page, 'f-solid', 'tintG', step.tint[1]);
      await setNodeParam(page, 'f-solid', 'tintB', step.tint[2]);
      const [px] = await stepAndSample(page, [centreProbe]);
      for (let c = 0; c < 3; c++) expectNear(px![c]!, step.want[c]!, `hue${i} ch${c} ${fmt(px!)}`);
      hues.push(hueOf(px!));
    }
    for (let i = 1; i < hues.length; i++) {
      expect(hues[i]!, `hue order preserved at step ${i} (${hues.map((h) => h.toFixed(3)).join(' → ')})`)
        .toBeGreaterThan(hues[i - 1]!);
    }

    // palette STEPS: two nearby oranges (G 0.30 vs 0.36) land in the SAME
    // 8-level G band → the SAME palette colour (255,73,0)…
    await setNodeParam(page, 'f-solid', 'tintR', 1);
    await setNodeParam(page, 'f-solid', 'tintG', 0.30);
    await setNodeParam(page, 'f-solid', 'tintB', 0);
    const [stepA] = await stepAndSample(page, [centreProbe]);
    await setNodeParam(page, 'f-solid', 'tintG', 0.36);
    const [stepB] = await stepAndSample(page, [centreProbe]);
    for (let c = 0; c < 3; c++) {
      expect(Math.abs(stepA![c]! - stepB![c]!), `collapsed step ch${c} ${fmt(stepA!)} vs ${fmt(stepB!)}`)
        .toBeLessThanOrEqual(8);
    }
    expectNear(stepA![1]!, 73, `collapsed step G ${fmt(stepA!)}`);
    // …while the next band over (G 0.55 → 146) is a clearly different colour.
    expect(146 - stepB![1]!, 'the adjacent palette step is far away').toBeGreaterThanOrEqual(40);
  });

  // ── 4. DITHER at 1.0 turns band edges into checkered cross-hatch ──────────
  //
  // THEORY (Bayer ordered dithering): at the 1-bit band boundary (v=0.5) a
  // full-amount 4×4 ordered dither makes adjacent texels alternate between
  // the two band values (the Bayer matrix places consecutive thresholds in
  // alternating columns), while WITHOUT dither the same region is a single
  // hard step. And a mid-band flat (v=0.25) NEVER sparkles — the dither
  // offset (±half step) cannot reach a band boundary from dead centre.
  test('dither 1.0: the 1-bit band edge renders as alternating checkered pixels; hard step at 0; no mid-band sparkle', async ({ page, errorWatch }) => {
    test.setTimeout(120_000);
    await spawnRampChain(page, { depth: 0, dither: 0, mix: 1 });

    const block = { nodeId: 'f-crush', u: 0.5, v: 0.5, w: 32, h: 4 };
    const binarize = (rows: number[][][]): number[][] =>
      rows.map((row) => row.map((px) => (px[0]! >= 128 ? 1 : 0)));
    const rowTransitions = (bin: number[][]): number[] =>
      bin.map((row) => row.reduce((n, v, i) => (i > 0 && v !== row[i - 1]! ? n + 1 : n), 0));

    // dither 0: a HARD band edge — each row crosses 0→1 at most once.
    const hard = binarize(await stepAndSampleRect(page, block));
    for (const [i, t] of rowTransitions(hard).entries()) {
      expect(t, `hard row ${i} has a single step (row: ${hard[i]!.join('')})`).toBeLessThanOrEqual(1);
    }

    // dither 1: the SAME region dissolves into cross-hatch — every row
    // alternates repeatedly and carries BOTH band values.
    await setNodeParam(page, 'f-crush', 'dither', 1);
    const hatch = binarize(await stepAndSampleRect(page, block));
    for (const [i, row] of hatch.entries()) {
      const t = rowTransitions([row])[0]!;
      expect(t, `dithered row ${i} checkers (row: ${row.join('')})`).toBeGreaterThanOrEqual(6);
      expect(row.includes(0) && row.includes(1), `dithered row ${i} carries both bands`).toBe(true);
    }

    // mid-band flat at full dither: NO sparkle (solid blacks stay solid —
    // the ±half-step offset cannot reach a boundary from band centre).
    const flat = await stepAndSampleRect(page, { ...block, u: 0.25 });
    for (const row of flat) {
      for (const px of row) {
        expect(px[0]!, `mid-band stays solid (got ${px[0]})`).toBeLessThanOrEqual(LOW);
      }
    }
  });
});
