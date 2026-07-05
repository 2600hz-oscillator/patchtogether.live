// packages/web/src/lib/video/modules/tempest.ts
//
// TEMPEST (P1) — the vector well + player claw.
//
// A faithful Tempest-style tube shooter as a video module (owner-specced; plan in
// .myrobots/plans/tempest-module-plan-2026-06-27.md). This phase is the first
// VISIBLE tube: a glowing additive-line "well" (the QuadraScan vector look) with
// the player claw riding the near rim, its position driven by a CV input (the
// authentic rotary-spinner control → a gamepad joystick axis). Enemies, fire,
// scoring, the audio-breathing tube, and the video-textured surface land in
// P2–P6; the pure geometry/projection core (tempest-core.ts) is already in place.
//
// Rendering: like RUTTETRA, the vector look is REAL line geometry, not a
// fullscreen-quad fragment pass — so we build our own tiny program via ctx.gl and
// draw into the per-instance FBO. But 1px gl.LINES are a trap: `lineWidth>1` is
// clamped to 1 on the real GPU, so thin diagonals anti-alias into a dim DOTTED
// stipple (the owner's "dim/dotted" feedback). Instead every line segment is
// EXPANDED on the CPU into a glowing QUAD (2 triangles): an additive fragment
// shader paints a bright solid core feathering to a soft halo across the stroke,
// so the QuadraScan web reads SOLID + GLOWING at any orientation. Vertices (rim
// ring + pit ring + radial lane lines + the player claw) are computed each frame
// from tempest-core and uploaded to an interleaved [x,y,across,r,g,b] VBO. The
// set is tiny (≈16 lanes), so per-frame rebuild is cheap and keeps the claw live
// with the CV.
//
// Inputs:
//   rim (cv, linear, paramTarget=rim): claw position around the rim, 0..1 (wraps).
//
// Outputs:
//   out (video): the additive-line well render.
//
// Params:
//   rim   (linear 0..1): claw position (also the CV target).
//   shape (discrete 0..2): tube cross-section (circle / square / star).

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';
import {
  DEFAULT_LANES,
  TUBE_SHAPES,
  type TubeShape,
  rimVertices,
  projectToScreen,
  cvToLane,
  buildClawSegments,
  type Vec2,
} from '$lib/video/tempest/tempest-core';

const LANES = DEFAULT_LANES;

interface TempestParams {
  rim: number;
  shape: number;
}
const DEFAULTS: TempestParams = { rim: 0, shape: 0 };

// ── LOOK constants (owner-tunable from a preview) ───────────────────────────
// Colours are ADDITIVE; the glow shader brightens the line core well past these,
// so they read as the QuadraScan vivid-blue web + a hot-yellow claw.
const TUBE_RGB: [number, number, number] = [0.25, 0.55, 1.0]; // vivid Tempest blue (rim + lane lines)
const PIT_RGB: [number, number, number] = [0.1, 0.22, 0.5]; // dimmer far ring → depth
const CLAW_RGB: [number, number, number] = [1.0, 0.85, 0.1]; // hot yellow claw

// Line HALF-widths in NDC (the wider visual axis). The renderer expands every
// segment into a glowing quad — `lineWidth>1` is clamped to 1 on the real GPU, so
// 1px gl.LINES anti-aliased thin diagonals into a dim dotted stipple; quads make
// the web SOLID + bright at any orientation. Bump these to fatten the glow.
const LINE_W = 0.009; // rim + lane lines (~7px at 1024×768)
const CLAW_W = 0.016; // claw — thickest, brightest (~12px)

const FIT = 0.86; // leave a margin so the rim doesn't touch the frame edge

const VERT_SRC = `#version 300 es
precision highp float;
in vec2 aPos;
in float aAcross;   // -1..+1 across the expanded line width
in vec3 aColor;
out float vAcross;
out vec3 vColor;
void main() {
  vAcross = aAcross;
  vColor = aColor;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// Additive GLOW: a bright solid core that feathers to a soft halo across the
// quad's width, so overlapping segments + the bloom pass read as fat, luminous
// QuadraScan vector strokes rather than hairlines. Tune the falloff to taste.
const FRAG_SRC = `#version 300 es
precision highp float;
in float vAcross;
in vec3 vColor;
out vec4 outColor;
void main() {
  float a = abs(vAcross);
  float core = smoothstep(1.0, 0.0, a);   // 1 at centre → 0 at the edge
  float g = pow(core, 0.5) + 0.6 * exp(-vAcross * vAcross * 6.0); // solid core + halo
  outColor = vec4(vColor * g, 1.0);       // additive (gl.ONE, gl.ONE)
}`;

/** Resolve the discrete shape param (0..2) to a tube cross-section. */
export function shapeOf(shapeParam: number): TubeShape {
  const i = Math.min(TUBE_SHAPES.length - 1, Math.max(0, Math.round(shapeParam)));
  return TUBE_SHAPES[i]!;
}

/** Number of CLAW line segments (see buildClawSegments): 2 prongs + back bar +
 *  2 body blades. Exposed so the unit test can assert the exact vertex count. */
export const CLAW_SEGMENTS = 5;
/** Floats per vertex in the interleaved triangle buffer: [x, y, across, r,g,b]. */
export const TEMPEST_STRIDE = 6;

/** Build the well + claw as an interleaved [x,y, across, r,g,b] TRIANGLE vertex
 *  list — every line segment is EXPANDED into a glowing quad (6 verts / 2 tris),
 *  because 1px gl.LINES clamp to a thin, dotted stipple on the real GPU. `across`
 *  ∈ [-1,+1] runs the width of each stroke and drives the additive glow falloff.
 *  Pure (no GL) so the geometry is unit-testable; the factory just uploads it.
 *  `aspect` = width/height of the target viewport (so the tube stays round AND
 *  every stroke keeps a UNIFORM visual width regardless of orientation). */
export function buildTempestLines(rimParam: number, shapeParam: number, aspect: number): Float32Array {
  const shape = shapeOf(shapeParam);
  const rim = rimVertices(shape, LANES);
  const out: number[] = [];

  // Aspect-fit: scale the wider axis in so a circle reads round, then FIT margin.
  const sx = (aspect >= 1 ? 1 / aspect : 1) * FIT;
  const sy = (aspect >= 1 ? 1 : aspect) * FIT;

  // Expand one line segment a→b into a glow quad. Width is computed in an
  // ISOTROPIC "view" space (multiply x by aspect) so the perpendicular is a true
  // screen-perpendicular and the stroke is uniformly wide at any angle; a small
  // longitudinal CAP (±halfW along the segment) overlaps neighbours so the ring
  // joints fill instead of leaving gaps. `ca`/`cb` colour the two ends (a
  // gradient — e.g. dim pit → bright rim along the radial lanes).
  const seg = (
    a: Vec2,
    b: Vec2,
    halfW: number,
    ca: readonly number[],
    cb: readonly number[] = ca,
  ) => {
    // NDC endpoints (after aspect-fit).
    const ax = a.x * sx, ay = a.y * sy;
    const bx = b.x * sx, by = b.y * sy;
    // Direction in isotropic view space (x weighted by aspect).
    let dx = (bx - ax) * aspect;
    let dy = by - ay;
    let len = Math.hypot(dx, dy);
    if (len < 1e-9) { dx = 1; dy = 0; len = 1; } // degenerate guard
    dx /= len; dy /= len;
    const px = -dy, py = dx; // perpendicular (view space)
    // Offsets back in NDC (undo the x*aspect weighting on the x component).
    const ox = (px * halfW) / aspect, oy = py * halfW; // across the width
    const cx = (dx * halfW) / aspect, cy = dy * halfW; // longitudinal cap
    // 4 corners (NDC): a∓ (cap back), b± (cap forward).
    const v = (x: number, y: number, across: number, c: readonly number[]) =>
      out.push(x, y, across, c[0]!, c[1]!, c[2]!);
    const aMx = ax - cx - ox, aMy = ay - cy - oy; // a, across -1
    const aPx = ax - cx + ox, aPy = ay - cy + oy; // a, across +1
    const bPx = bx + cx + ox, bPy = by + cy + oy; // b, across +1
    const bMx = bx + cx - ox, bMy = by + cy - oy; // b, across -1
    // Two triangles spanning the quad.
    v(aMx, aMy, -1, ca); v(aPx, aPy, +1, ca); v(bPx, bPy, +1, cb);
    v(aMx, aMy, -1, ca); v(bPx, bPy, +1, cb); v(bMx, bMy, -1, cb);
  };

  // Rim ring (near, z=1) + pit ring (far, z≈0) + one radial line per lane
  // boundary. The radials gradient from the dim pit colour up to the bright rim,
  // so the well glows brighter as it nears the player (depth cue).
  for (let i = 0; i < LANES; i++) {
    const rimA = projectToScreen(rim, i, 1);
    const rimB = projectToScreen(rim, i + 1, 1);
    const pitA = projectToScreen(rim, i, 0);
    const pitB = projectToScreen(rim, i + 1, 0);
    seg(rimA, rimB, LINE_W, TUBE_RGB); // bright rim ring
    seg(pitA, pitB, LINE_W, PIT_RGB); // dim pit ring
    seg(pitA, rimA, LINE_W, PIT_RGB, TUBE_RGB); // radial lane line (pit→rim gradient)
  }

  // Player CLAW: thick, hot-yellow, spanning the rim lane the CV selects.
  const clawLane = cvToLane(rimParam, LANES);
  for (const s of buildClawSegments(rim, clawLane, LANES)) {
    seg(s.a, s.b, CLAW_W, CLAW_RGB);
  }

  return new Float32Array(out);
}

export const tempestDef: VideoModuleDef = {
  type: 'tempest',
  palette: { top: 'Games', sub: 'Arcade' },
  domain: 'video',
  label: 'tempest',
  category: 'output',
  inputs: [
    // Claw rim position as CV (the rotary-spinner control → a gamepad joystick
    // axis). port id == param id so the cross-domain CV bridge routes to setParam.
    { id: 'rim', type: 'cv', paramTarget: 'rim', cvScale: { mode: 'linear' } },
  ],
  outputs: [{ id: 'out', type: 'video' }],
  params: [
    { id: 'rim', label: 'Rim', defaultValue: DEFAULTS.rim, min: 0, max: 1, curve: 'linear' },
    { id: 'shape', label: 'Shape', defaultValue: DEFAULTS.shape, min: 0, max: TUBE_SHAPES.length - 1, curve: 'discrete' },
  ],
  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;

    const compile = (type: number, src: string): WebGLShader => {
      const sh = gl.createShader(type);
      if (!sh) throw new Error('TEMPEST: createShader failed');
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(sh);
        gl.deleteShader(sh);
        throw new Error(`TEMPEST: shader compile failed: ${log}`);
      }
      return sh;
    };
    const vs = compile(gl.VERTEX_SHADER, VERT_SRC);
    const fs = compile(gl.FRAGMENT_SHADER, FRAG_SRC);
    const program = gl.createProgram();
    if (!program) throw new Error('TEMPEST: createProgram failed');
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`TEMPEST: program link failed: ${log}`);
    }
    const aPos = gl.getAttribLocation(program, 'aPos');
    const aAcross = gl.getAttribLocation(program, 'aAcross');
    const aColor = gl.getAttribLocation(program, 'aColor');

    const vao = gl.createVertexArray();
    const vbo = gl.createBuffer();
    if (!vao || !vbo) throw new Error('TEMPEST: VAO / VBO alloc failed');
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    const STRIDE = TEMPEST_STRIDE * 4; // x,y,across,r,g,b → 6 floats
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, STRIDE, 0);
    gl.enableVertexAttribArray(aAcross);
    gl.vertexAttribPointer(aAcross, 1, gl.FLOAT, false, STRIDE, 2 * 4);
    gl.enableVertexAttribArray(aColor);
    gl.vertexAttribPointer(aColor, 3, gl.FLOAT, false, STRIDE, 3 * 4);
    gl.bindVertexArray(null);

    const { fbo, texture } = ctx.createFbo();
    const params: TempestParams = { ...DEFAULTS, ...(node.params as Partial<TempestParams>) };

    const surface: VideoNodeSurface = {
      fbo,
      texture,
      draw() {
        const aspect = ctx.res.width / Math.max(1, ctx.res.height);
        const verts = buildTempestLines(params.rim, params.shape, aspect);

        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.viewport(0, 0, ctx.res.width, ctx.res.height);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        gl.blendEquation(gl.FUNC_ADD);

        gl.useProgram(program);
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
        gl.drawArrays(gl.TRIANGLES, 0, verts.length / TEMPEST_STRIDE);
        gl.bindVertexArray(null);
        gl.disable(gl.BLEND);
      },
      dispose() {
        gl.deleteFramebuffer(fbo);
        gl.deleteTexture(texture);
        gl.deleteBuffer(vbo);
        gl.deleteVertexArray(vao);
        gl.deleteProgram(program);
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
        if (key === 'fboTexture') return texture;
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};
