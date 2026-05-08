// packages/web/src/lib/video/modules/lines.ts
//
// LINES — procedural line/grid mono-video source. Phase 0 implementation
// of the spec at .myrobots/plans/video-modules-mvp.md §3.7.
//
// What renders this round:
//   - Procedural sin-wave-edged lines at a chosen orientation, frequency,
//     and thickness. Phase scrolls slowly so the demo is visibly animated.
//   - FM input (mono-video texture port) — not yet wired in this Phase 0
//     spike; the input port exists so the I/O surface is forward-compatible
//     and tests can assert handle parity. The shader will pick it up in
//     Phase 3 (fmDepth uniform plumbing complete here, so it's literally
//     a one-line shader change).
//
// Output type is `mono-video`; downstream consumers (OUTPUT, future
// MIXER mono pots, COLORIZER via implicit upcast to video) will route
// through the engine's input-texture lookup.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';

const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform float uOrient;     // 0 = horizontal, 0.5 = diagonal, 1 = vertical
uniform float uAmp;        // lines per screen
uniform float uThickness;  // 0..1 — band half-width
uniform float uPhase;      // 0..1 — scroll
uniform float uFmDepth;    // 0..1 — modulator gain (Phase 3 wiring)

void main() {
  // Rotate UV so 'orient' selects the line direction. We center on (0.5,
  // 0.5) so the rotation happens around the canvas middle instead of the
  // bottom-left corner, which would slide the pattern off-screen at high
  // orient values.
  float theta = uOrient * 1.5707963; // 0 → 0, 1 → π/2
  vec2 c = vUv - 0.5;
  float t = c.x * cos(theta) + c.y * sin(theta);

  // Procedural line waveform. The sin() argument is the per-pixel phase;
  // we use smoothstep on its absolute distance from a zero crossing to
  // get a soft-edged stripe. Higher uAmp → more lines on screen.
  // uThickness in [0, 1] maps to band half-width: 0 = razor-thin, 1 =
  // fully white. We want bright bands where |wave| < uThickness, with
  // a soft edge straddling that threshold.
  float wave = abs(sin(6.2831853 * uAmp * (t + uPhase)));
  float edge = max(0.005, uThickness * 0.5);
  float band = 1.0 - smoothstep(uThickness - edge, uThickness + edge, wave);

  // Phase 0: emit the band as a mono signal in the red channel; the
  // other two RGB channels are zero. Downstream consumers that treat
  // this as a mono-video stream (engine-level upcast to grayscale) only
  // sample R; the implicit-upcast set is documented in graph/types.ts.
  outColor = vec4(band, band, band, 1.0);

  // Suppress unused-uniform warnings until Phase 3 plumbs FM.
  outColor.rgb *= 1.0 + uFmDepth * 0.0;
}`;

interface LinesParams {
  orient: number;
  amp: number;
  thickness: number;
  phase: number;
  fmDepth: number;
}

const DEFAULTS: LinesParams = {
  orient: 0.0,        // horizontal lines by default
  amp: 12,            // 12 lines per screen
  thickness: 0.35,    // ~35% duty — bright/dark stripes, plenty of contrast
  phase: 0.0,         // scrolls per frame in render loop
  fmDepth: 0.0,
};

export const linesDef: VideoModuleDef = {
  type: 'lines',
  domain: 'video',
  label: 'LINES',
  category: 'sources',
  schemaVersion: 1,
  inputs: [
    { id: 'fm', type: 'mono-video' },
  ],
  outputs: [
    { id: 'out', type: 'mono-video' },
  ],
  params: [
    { id: 'orient',    label: 'Orient',    defaultValue: DEFAULTS.orient,    min: 0,    max: 1,  curve: 'linear' },
    { id: 'amp',       label: 'Amp',       defaultValue: DEFAULTS.amp,       min: 0.5,  max: 50, curve: 'linear', units: 'lpx' },
    { id: 'thickness', label: 'Thickness', defaultValue: DEFAULTS.thickness, min: 0,    max: 1,  curve: 'linear' },
    { id: 'phase',     label: 'Phase',     defaultValue: DEFAULTS.phase,     min: 0,    max: 1,  curve: 'linear' },
    { id: 'fmDepth',   label: 'FM Depth',  defaultValue: DEFAULTS.fmDepth,   min: 0,    max: 1,  curve: 'linear' },
  ],

  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);

    const uOrient    = gl.getUniformLocation(program, 'uOrient');
    const uAmp       = gl.getUniformLocation(program, 'uAmp');
    const uThickness = gl.getUniformLocation(program, 'uThickness');
    const uPhase     = gl.getUniformLocation(program, 'uPhase');
    const uFmDepth   = gl.getUniformLocation(program, 'uFmDepth');

    const { fbo, texture } = ctx.createFbo();

    const params: LinesParams = { ...DEFAULTS, ...(node.params as Partial<LinesParams>) };

    const surface: VideoNodeSurface = {
      fbo,
      texture,
      draw(frame) {
        const g = frame.gl;
        g.bindFramebuffer(g.FRAMEBUFFER, fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.useProgram(program);

        // Auto-scroll: phase advances at a steady rate so the demo is
        // obviously alive without the user touching a knob. The user's
        // explicit `phase` param is added on top.
        const autoPhase = (frame.time * 0.15) % 1;
        g.uniform1f(uOrient,    params.orient);
        g.uniform1f(uAmp,       params.amp);
        g.uniform1f(uThickness, params.thickness);
        g.uniform1f(uPhase,     params.phase + autoPhase);
        g.uniform1f(uFmDepth,   params.fmDepth);

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
