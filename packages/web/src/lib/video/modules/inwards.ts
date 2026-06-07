// packages/web/src/lib/video/modules/inwards.ts
//
// INWARDS — inward-zooming radial pattern generator (Phase-1 source module).
//
// The spec at .myrobots/plans/video-modules-mvp.md §3.1 originally framed
// INWARDS as a webcam source. For the Phase-1 module set we re-purpose the
// name (per the "8 modules to ship" plan in the agent kickoff): it is now
// a procedural source that draws concentric rings zooming inward, giving
// users a deterministic visual that doesn't depend on getUserMedia /
// device permissions. Webcam input belongs to a future INWARDS-CAM module
// once getUserMedia plumbing lands.
//
// What this draws: alternating bright/dark concentric rings centered on
// the canvas, with their phase scrolling inward over time. The `speed`
// param sets the zoom rate (positive = inward), `density` controls how
// many rings fit on screen, `thickness` controls the duty cycle.
//
// Output: mono-video. Cheap procedural shader; no input textures.
//
// Inputs:
//   speed / density / thickness (cv, paramTarget=…): per-param CV.
//
// Outputs:
//   out (mono-video): the concentric-rings render.
//
// Params:
//   speed (linear -2..2): zoom rate (positive = inward, negative = outward).
//   density (linear 1..50): rings-per-screen.
//   thickness (linear 0..1): bright-ring duty cycle.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';

const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform float uTime;
uniform float uSpeed;     // zoom rate; positive = inward sweep
uniform float uDensity;   // rings per screen
uniform float uThickness; // 0..1 — band duty cycle

void main() {
  // Centered radial coordinate. We rescale so radius ~= 1.0 at the
  // canvas edge along the longer dimension, and then offset by time so
  // rings appear to zoom INTO the center as uTime increases.
  vec2 c = vUv - 0.5;
  float r = length(c);

  // Phase moves inward (subtract time*speed) so each ring contracts
  // toward the center over time. Scale density so a sane default
  // (~10) gives a pleasant ring count.
  float phase = r * uDensity - uTime * uSpeed;
  float wave = abs(sin(6.2831853 * phase));

  // Soft band around zero crossings, identical shaping to LINES so the
  // two source modules feel like siblings.
  float edge = max(0.005, uThickness * 0.5);
  float band = 1.0 - smoothstep(uThickness - edge, uThickness + edge, wave);

  outColor = vec4(band, band, band, 1.0);
}`;

interface InwardsParams {
  speed: number;
  density: number;
  thickness: number;
}

const DEFAULTS: InwardsParams = {
  speed: 0.5,
  density: 10,
  thickness: 0.35,
};

export const inwardsDef: VideoModuleDef = {
  type: 'inwards',
  palette: { top: 'Video modules', sub: 'Sources' },
  domain: 'video',
  label: 'inwards',
  category: 'sources',
  schemaVersion: 1,
  inputs: [
    // Per-param CV inputs. Mirrors the LINES CV pattern (PR-65): the
    // cross-domain CV bridge in PatchEngine routes audio-side cv signals
    // into VideoEngine.setParam, where the target param id == this input
    // port id. So the port ids MUST match the param ids exactly
    // (`speed`, `density`, `thickness`).
    { id: 'speed',     type: 'cv', paramTarget: 'speed' },
    { id: 'density',   type: 'cv', paramTarget: 'density' },
    { id: 'thickness', type: 'cv', paramTarget: 'thickness' },
  ],
  outputs: [
    { id: 'out', type: 'mono-video' },
  ],
  params: [
    { id: 'speed',     label: 'Speed',     defaultValue: DEFAULTS.speed,     min: -2,   max: 2,   curve: 'linear' },
    { id: 'density',   label: 'Density',   defaultValue: DEFAULTS.density,   min: 1,    max: 50,  curve: 'linear' },
    { id: 'thickness', label: 'Thickness', defaultValue: DEFAULTS.thickness, min: 0,    max: 1,   curve: 'linear' },
  ],

  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);

    const uTime      = gl.getUniformLocation(program, 'uTime');
    const uSpeed     = gl.getUniformLocation(program, 'uSpeed');
    const uDensity   = gl.getUniformLocation(program, 'uDensity');
    const uThickness = gl.getUniformLocation(program, 'uThickness');

    const { fbo, texture } = ctx.createFbo();

    const params: InwardsParams = { ...DEFAULTS, ...(node.params as Partial<InwardsParams>) };

    const surface: VideoNodeSurface = {
      fbo,
      texture,
      draw(frame) {
        const g = frame.gl;
        g.bindFramebuffer(g.FRAMEBUFFER, fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.useProgram(program);

        g.uniform1f(uTime,      frame.time);
        g.uniform1f(uSpeed,     params.speed);
        g.uniform1f(uDensity,   params.density);
        g.uniform1f(uThickness, params.thickness);

        ctx.drawFullscreenQuad();
        g.bindFramebuffer(g.FRAMEBUFFER, null);
      },
      dispose() {
        gl.deleteFramebuffer(fbo);
        gl.deleteTexture(texture);
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
      dispose() { surface.dispose(); },
    };
  },
};
