// packages/web/src/lib/video/modules/onetonine.ts
//
// ONE TO NINE — a fixed 3×3 screen splitter. ONE video input is divided into a
// 3×3 grid of nine equal sub-rectangles; each grid cell is exposed on its own
// output (out1..out9), scaled to FILL the output frame. Used ALONGSIDE (but NOT
// wired to) MAPPY — feed each of nine projectors a different ninth of one
// source.
//
// ──────────────────────────────────────────────────────────────────────────
// CELL NUMBERING (reading order)
// ──────────────────────────────────────────────────────────────────────────
//   1 2 3      1 = top-left     2 = top-center    3 = top-right
//   4 5 6      4 = mid-left     5 = CENTRE        6 = mid-right
//   7 8 9      7 = bottom-left  8 = bottom-center 9 = bottom-right
//
// Output N carries ONLY the content of cell N (a 1/9 sub-rectangle of the
// input), magnified to the full output frame — so each output is a low-res crop
// (expected + fine). The crops are CLEAN: no grid lines / numbers.
//
// ──────────────────────────────────────────────────────────────────────────
// MONITOR (canonical surface + on-card preview)
// ──────────────────────────────────────────────────────────────────────────
// The MONITOR fbo (= surface.texture) shows the input with a 3×3 GRID overlaid
// and a big readable DIGIT 1..9 drawn in each cell, so the operator sees which
// cell feeds which output. The grid + numbers appear ONLY on the monitor — NOT
// in the nine outputs. A showGrid toggle hides the overlay on the monitor
// (the raw input passthrough) when off.
//
// ──────────────────────────────────────────────────────────────────────────
// Y-AXIS (this bit MAPPY hard)
// ──────────────────────────────────────────────────────────────────────────
// The engine's shared vertex shader sets vUv = aPos*0.5+0.5, so vUv is y-UP:
// v == 1 is the canvas TOP. Therefore:
//   * cell 1 (TOP-left) samples the input where v is HIGH and u is LOW.
//   * the row index r=0 (top) maps to the HIGH-v band [2/3, 1].
//   * the drawn digits must be UPRIGHT — we flip the per-cell digit-box y with
//     `1.0 - cellV` so glyphs aren't upside-down (the MAPPY digit lesson).
// The pure cell→source-rect math lives in `cellSourceRect` below and is the
// single source of truth shared by the crop shader, the monitor digits, and the
// unit test.
//
// ──────────────────────────────────────────────────────────────────────────
// GL FEEDBACK-LOOP RULE
// ──────────────────────────────────────────────────────────────────────────
// We NEVER bind our own output/monitor FBO texture as an input/placeholder
// (read+write the same texture is a feedback loop, garbage on Chrome — see
// 4plexvid.ts / mappy.ts). A 1×1 black sentinel covers the nothing-patched
// sampler binding.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';

// ───────────────────────── constants ─────────────────────────

/** Grid dimension — fixed 3×3. */
export const GRID = 3;
/** Number of cells / outputs (9). */
export const CELL_COUNT = GRID * GRID;
/** Output port ids, in reading order (out1 = top-left … out9 = bottom-right). */
export const OUTPUT_IDS = [
  'out1', 'out2', 'out3', 'out4', 'out5', 'out6', 'out7', 'out8', 'out9',
] as const;

// ───────────────────────── pure cell→rect math ─────────────────────────

/** A source sub-rectangle in the input's vUv space (y-UP, v=1 == TOP). */
export interface CellRect {
  /** left edge in u (0..1). */
  u0: number;
  /** right edge in u (0..1). */
  u1: number;
  /** bottom edge in v (0..1) — the LOWER v of the band. */
  v0: number;
  /** top edge in v (0..1) — the HIGHER v of the band. */
  v1: number;
}

/** Column 0..2 of cell N (1..9) — reading order, left→right. */
export function cellCol(cell1: number): number {
  return (cell1 - 1) % GRID;
}

/** Row 0..2 of cell N (1..9) — reading order, TOP row = 0. */
export function cellRow(cell1: number): number {
  return Math.floor((cell1 - 1) / GRID);
}

/**
 * The source sub-rectangle (in y-UP vUv space) that output `cell1` (1..9) crops
 * from the input. Reading order, with the y-UP flip baked in:
 *   col c → u band [c/3, (c+1)/3]            (left→right, normal)
 *   row r → v band where row 0 (TOP) is the HIGH-v band [2/3, 1]
 *           i.e. v1 (top edge) = 1 - r/3, v0 (bottom edge) = 1 - (r+1)/3.
 * So cell 1 → {u:[0,1/3], v:[2/3,1]} (top-left, high v / low u) and
 *    cell 9 → {u:[2/3,1], v:[0,1/3]} (bottom-right, low v / high u).
 */
export function cellSourceRect(cell1: number): CellRect {
  const c = cellCol(cell1);
  const r = cellRow(cell1);
  const cell = 1 / GRID;
  return {
    u0: c * cell,
    u1: (c + 1) * cell,
    v0: 1 - (r + 1) * cell, // bottom edge (lower v)
    v1: 1 - r * cell,       // top edge (higher v)
  };
}

// ───────────────────────── crop shader ─────────────────────────
//
// CROP: remap the full-frame output vUv [0,1] into one cell's source sub-rect
// and sample the input there. No grid / numbers — a clean magnified ninth.

const CROP_FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;            // OUTPUT uv in [0,1] (y-UP)
out vec4 outColor;

uniform sampler2D uTex; // the (single) input texture
uniform float uHas;     // 1.0 when the input is connected, else 0
uniform vec2 uOrigin;   // (u0, v0) — the cell's lower-left source corner
uniform vec2 uSpan;     // (1/3, 1/3) — the cell's source extent

void main() {
  if (uHas < 0.5) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  vec2 s = uOrigin + vUv * uSpan; // full-frame output → this cell's source rect
  outColor = vec4(texture(uTex, s).rgb, 1.0);
}`;

// ───────────────────────── monitor shader ─────────────────────────
//
// MONITOR: the input passthrough, with (when uShowGrid) a 3×3 grid + a big
// upright digit 1..9 per cell. Digits use a 7-segment coverage function. The
// digit BOX is laid out in cell-local space with the y FLIPPED (`1.0 - cellV`)
// so glyphs render UPRIGHT despite vUv being y-UP — the MAPPY lesson.

const MONITOR_FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;            // OUTPUT uv in [0,1] (y-UP, v=1 == TOP)
out vec4 outColor;

uniform sampler2D uTex; // the input texture
uniform float uHas;     // 1.0 when the input is connected, else 0
uniform float uShowGrid;// >0.5 → draw grid + numbers

// 7-segment coverage for a digit 0..9 at local box coords p in [0,1]^2 with
// p.y UP (0 = bottom, 1 = top). Returns 1.0 inside a lit segment, else 0.0.
// Segment layout (standard):
//    aaa
//   f   b
//    ggg
//   e   c
//    ddd
float seg(vec2 p, vec2 a, vec2 b, float t) {
  // distance from point p to the segment a-b; lit if within thickness t and
  // within the segment's extent.
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - ba * h) < t ? 1.0 : 0.0;
}

float digit(int d, vec2 p) {
  // Which of the 7 segments are lit for d (a,b,c,d,e,f,g).
  bool A, B, C, D, E, F, G;
  if (d == 1) { A=false; B=true;  C=true;  D=false; E=false; F=false; G=false; }
  else if (d == 2) { A=true;  B=true;  C=false; D=true;  E=true;  F=false; G=true; }
  else if (d == 3) { A=true;  B=true;  C=true;  D=true;  E=false; F=false; G=true; }
  else if (d == 4) { A=false; B=true;  C=true;  D=false; E=false; F=true;  G=true; }
  else if (d == 5) { A=true;  B=false; C=true;  D=true;  E=false; F=true;  G=true; }
  else if (d == 6) { A=true;  B=false; C=true;  D=true;  E=true;  F=true;  G=true; }
  else if (d == 7) { A=true;  B=true;  C=true;  D=false; E=false; F=false; G=false; }
  else if (d == 8) { A=true;  B=true;  C=true;  D=true;  E=true;  F=true;  G=true; }
  else if (d == 9) { A=true;  B=true;  C=true;  D=true;  E=false; F=true;  G=true; }
  else { A=true; B=true; C=true; D=true; E=true; F=true; G=false; } // 0
  // Segment endpoints in the [0,1]^2 box (y UP).
  vec2 tl = vec2(0.15, 0.92), tr = vec2(0.85, 0.92);
  vec2 ml = vec2(0.15, 0.50), mr = vec2(0.85, 0.50);
  vec2 bl = vec2(0.15, 0.08), br = vec2(0.85, 0.08);
  float t = 0.10;
  float v = 0.0;
  if (A) v = max(v, seg(p, tl, tr, t));
  if (B) v = max(v, seg(p, tr, mr, t));
  if (C) v = max(v, seg(p, mr, br, t));
  if (D) v = max(v, seg(p, bl, br, t));
  if (E) v = max(v, seg(p, ml, bl, t));
  if (F) v = max(v, seg(p, ml, tl, t));
  if (G) v = max(v, seg(p, ml, mr, t));
  return v;
}

void main() {
  vec3 base = (uHas > 0.5) ? texture(uTex, vUv).rgb : vec3(0.04);
  if (uShowGrid < 0.5) {
    outColor = vec4(base, 1.0);
    return;
  }

  // Which cell does this fragment fall in? Columns left→right (u), rows
  // TOP→bottom in READING order. vUv is y-UP, so the TOP row (reading row 0)
  // is the HIGH-v band → row = floor((1 - v) * 3).
  float fu = clamp(vUv.x, 0.0, 0.99999);
  float fv = clamp(vUv.y, 0.0, 0.99999);
  int col = int(floor(fu * 3.0));
  int row = int(floor((1.0 - fv) * 3.0)); // reading row 0 = top
  int cell = row * 3 + col + 1;           // 1..9

  // Grid lines on every third boundary.
  vec2 g = abs(fract(vUv * 3.0) - 0.5);
  float line = (min(g.x, g.y) > 0.47) ? 1.0 : 0.0;

  // Cell-local coords. cellU is normal; cellV must be FLIPPED so the digit box
  // is y-UP-in-the-box → glyph renders UPRIGHT (the MAPPY 1.0 - s.y lesson).
  float cellU = fract(fu * 3.0);
  float cellVtop = 1.0 - fract((1.0 - fv) * 3.0); // 0 at cell bottom, 1 at top
  // Place the digit box centred in the cell (inset).
  vec2 box = (vec2(cellU, cellVtop) - vec2(0.32, 0.30)) / vec2(0.36, 0.40);
  float dCov = 0.0;
  if (box.x >= 0.0 && box.x <= 1.0 && box.y >= 0.0 && box.y <= 1.0) {
    dCov = digit(cell, box);
  }

  vec3 col3 = base;
  col3 = mix(col3, vec3(1.0, 0.85, 0.1), line * 0.85);     // amber grid lines
  col3 = mix(col3, vec3(1.0, 1.0, 1.0), dCov);             // white digits
  outColor = vec4(col3, 1.0);
}`;

// ───────────────────────── params / defaults ─────────────────────────

interface OneToNineParams {
  // showGrid is a 0/1 param so it threads through param/CV/persistence like
  // every numeric param; the card surfaces it as a toggle (mirrored to
  // node.data.showGrid). ON by default — the grid+numbers ARE the point of the
  // monitor.
  showGrid: number;
}

const DEFAULTS: OneToNineParams = {
  showGrid: 1,
};

export const oneToNineDef: VideoModuleDef = {
  type: 'onetonine',
  palette: { top: 'Video modules', sub: 'Utilities' },
  card: 'OneToNineCard',
  domain: 'video',
  label: 'one to nine',
  category: 'utilities',
  schemaVersion: 1,
  inputs: [{ id: 'in', type: 'video' }],
  outputs: OUTPUT_IDS.map((id) => ({ id, type: 'video' as const })),
  params: [
    { id: 'showGrid', label: 'Grid', defaultValue: DEFAULTS.showGrid, min: 0, max: 1, curve: 'linear' },
  ],

  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;

    const cropProgram = ctx.compileFragment(CROP_FRAG_SRC);
    const cu = {
      tex: gl.getUniformLocation(cropProgram, 'uTex'),
      has: gl.getUniformLocation(cropProgram, 'uHas'),
      origin: gl.getUniformLocation(cropProgram, 'uOrigin'),
      span: gl.getUniformLocation(cropProgram, 'uSpan'),
    };

    const monitorProgram = ctx.compileFragment(MONITOR_FRAG_SRC);
    const mu = {
      tex: gl.getUniformLocation(monitorProgram, 'uTex'),
      has: gl.getUniformLocation(monitorProgram, 'uHas'),
      showGrid: gl.getUniformLocation(monitorProgram, 'uShowGrid'),
    };

    // The canonical MONITOR surface (preview + VRT) + one CROP fbo per output.
    const monitorFbo = ctx.createFbo();
    const cropFbos = OUTPUT_IDS.map(() => ctx.createFbo());

    // 1×1 black sentinel for the nothing-patched sampler binding. NEVER bind
    // our own monitor/crop fbo texture (GL feedback loop).
    const emptyTex = gl.createTexture();
    if (!emptyTex) throw new Error('ONETONINE: createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, emptyTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const rawParams = node.params as Record<string, unknown>;
    const params: OneToNineParams = {
      showGrid: typeof rawParams.showGrid === 'number' ? rawParams.showGrid : DEFAULTS.showGrid,
    };

    /** showGrid is mirrored on node.data so the card toggle + the param agree;
     *  prefer node.data when present, else the param. */
    function gridOn(): boolean {
      const data = node.data as { showGrid?: unknown } | undefined;
      if (data && typeof data.showGrid === 'boolean') return data.showGrid;
      return params.showGrid >= 0.5;
    }

    const span = 1 / GRID;

    const surface: VideoNodeSurface = {
      fbo: monitorFbo.fbo,
      texture: monitorFbo.texture,
      draw(frame) {
        const g = frame.gl;
        const inputTex = frame.getInputTexture(node.id, 'in');
        const has = inputTex ? 1.0 : 0.0;

        // 1) The nine CLEAN crops (no grid/numbers) — one FBO per output.
        g.useProgram(cropProgram);
        for (let i = 0; i < CELL_COUNT; i++) {
          const rect = cellSourceRect(i + 1);
          g.bindFramebuffer(g.FRAMEBUFFER, cropFbos[i]!.fbo);
          g.viewport(0, 0, ctx.res.width, ctx.res.height);
          g.activeTexture(g.TEXTURE0);
          g.bindTexture(g.TEXTURE_2D, inputTex ?? emptyTex);
          g.uniform1i(cu.tex, 0);
          g.uniform1f(cu.has, has);
          g.uniform2f(cu.origin, rect.u0, rect.v0);
          g.uniform2f(cu.span, span, span);
          ctx.drawFullscreenQuad();
        }

        // 2) The MONITOR (input + grid + numbers) — the canonical surface.
        g.useProgram(monitorProgram);
        g.bindFramebuffer(g.FRAMEBUFFER, monitorFbo.fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.activeTexture(g.TEXTURE0);
        g.bindTexture(g.TEXTURE_2D, inputTex ?? emptyTex);
        g.uniform1i(mu.tex, 0);
        g.uniform1f(mu.has, has);
        g.uniform1f(mu.showGrid, gridOn() ? 1.0 : 0.0);
        ctx.drawFullscreenQuad();

        g.bindFramebuffer(g.FRAMEBUFFER, null);
        g.activeTexture(g.TEXTURE0);
      },
      dispose() {
        gl.deleteFramebuffer(monitorFbo.fbo);
        gl.deleteTexture(monitorFbo.texture);
        for (const f of cropFbos) {
          gl.deleteFramebuffer(f.fbo);
          gl.deleteTexture(f.texture);
        }
        gl.deleteTexture(emptyTex);
        gl.deleteProgram(cropProgram);
        gl.deleteProgram(monitorProgram);
      },
    };

    return {
      domain: 'video',
      surface,
      setParam(paramId, value) {
        if (paramId in params) (params as unknown as Record<string, number>)[paramId] = value;
      },
      readParam(paramId) {
        return (params as unknown as Record<string, number>)[paramId];
      },
      read(key) {
        // Per-output crop textures (the documented multi-output escape hatch).
        for (let i = 0; i < CELL_COUNT; i++) {
          if (key === `outputTexture:${OUTPUT_IDS[i]}`) return cropFbos[i]!.texture;
        }
        // The monitor is the canonical surface; also reachable by name for
        // parity with single-output consumers.
        if (key === 'outputTexture:monitor') return monitorFbo.texture;
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};
