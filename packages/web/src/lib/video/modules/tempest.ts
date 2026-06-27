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
// draw additive gl.LINES into the per-instance FBO. Vertices (rim ring + pit ring
// + radial lane lines + the claw bracket) are computed CPU-side from tempest-core
// each frame and uploaded to an interleaved pos+color VBO. The set is tiny (≈16
// lanes), so per-frame rebuild is cheap and keeps the claw live with the CV.
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
  wrapLane,
} from '$lib/video/tempest/tempest-core';

const LANES = DEFAULT_LANES;

interface TempestParams {
  rim: number;
  shape: number;
}
const DEFAULTS: TempestParams = { rim: 0, shape: 0 };

// Colours (additive). Tube = dim cyan vector; claw = bright yellow.
const TUBE_RGB: [number, number, number] = [0.1, 0.55, 0.75];
const PIT_RGB: [number, number, number] = [0.06, 0.3, 0.45];
const CLAW_RGB: [number, number, number] = [1.0, 0.85, 0.15];
const FIT = 0.86; // leave a margin so the rim doesn't touch the frame edge

const VERT_SRC = `#version 300 es
precision highp float;
in vec2 aPos;
in vec3 aColor;
out vec3 vColor;
void main() {
  vColor = aColor;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG_SRC = `#version 300 es
precision highp float;
in vec3 vColor;
out vec4 outColor;
void main() { outColor = vec4(vColor, 1.0); }`;

/** Resolve the discrete shape param (0..2) to a tube cross-section. */
export function shapeOf(shapeParam: number): TubeShape {
  const i = Math.min(TUBE_SHAPES.length - 1, Math.max(0, Math.round(shapeParam)));
  return TUBE_SHAPES[i]!;
}

/** Build the well + claw as an interleaved [x,y, r,g,b] LINE vertex list (pairs).
 *  Pure (no GL) so the geometry is unit-testable; the factory just uploads it.
 *  `aspect` = width/height of the target viewport (so the tube stays round). */
export function buildTempestLines(rimParam: number, shapeParam: number, aspect: number): Float32Array {
  const shape = shapeOf(shapeParam);
  const rim = rimVertices(shape, LANES);
  const out: number[] = [];
  // Aspect-fit: scale the wider axis in so a circle reads round, then FIT margin.
  const sx = (aspect >= 1 ? 1 / aspect : 1) * FIT;
  const sy = (aspect >= 1 ? 1 : aspect) * FIT;
  const push = (p: { x: number; y: number }, c: readonly number[]) => {
    out.push(p.x * sx, p.y * sy, c[0]!, c[1]!, c[2]!);
  };
  const seg = (a: { x: number; y: number }, b: { x: number; y: number }, c: readonly number[]) => {
    push(a, c);
    push(b, c);
  };

  // Rim ring (near, z=1) + pit ring (far, z≈0) + one radial line per lane boundary.
  for (let i = 0; i < LANES; i++) {
    const rimA = projectToScreen(rim, i, 1);
    const rimB = projectToScreen(rim, i + 1, 1);
    const pitA = projectToScreen(rim, i, 0);
    const pitB = projectToScreen(rim, i + 1, 0);
    seg(rimA, rimB, TUBE_RGB); // rim ring
    seg(pitA, pitB, PIT_RGB); // pit ring
    seg(pitA, rimA, TUBE_RGB); // radial lane line
  }

  // Claw: a bright bracket on the rim segment the CV selects, drawn slightly
  // inboard so it reads as the player sitting in its lane.
  const clawLane = cvToLane(rimParam, LANES);
  const li = Math.floor(wrapLane(clawLane, LANES));
  const a = projectToScreen(rim, li, 1);
  const b = projectToScreen(rim, li + 1, 1);
  const aIn = projectToScreen(rim, li, 0.82);
  const bIn = projectToScreen(rim, li + 1, 0.82);
  seg(a, b, CLAW_RGB); // outer edge on the rim
  seg(a, aIn, CLAW_RGB); // sides angling inward → the claw "V"
  seg(b, bIn, CLAW_RGB);
  seg(aIn, bIn, CLAW_RGB); // inner edge

  return new Float32Array(out);
}

export const tempestDef: VideoModuleDef = {
  type: 'tempest',
  palette: { top: 'Video modules', sub: 'Games' },
  domain: 'video',
  label: 'tempest',
  category: 'output',
  schemaVersion: 1,
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
    const aColor = gl.getAttribLocation(program, 'aColor');

    const vao = gl.createVertexArray();
    const vbo = gl.createBuffer();
    if (!vao || !vbo) throw new Error('TEMPEST: VAO / VBO alloc failed');
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    const STRIDE = 5 * 4; // x,y,r,g,b → 5 floats
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, STRIDE, 0);
    gl.enableVertexAttribArray(aColor);
    gl.vertexAttribPointer(aColor, 3, gl.FLOAT, false, STRIDE, 2 * 4);
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
        gl.drawArrays(gl.LINES, 0, verts.length / 5);
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
