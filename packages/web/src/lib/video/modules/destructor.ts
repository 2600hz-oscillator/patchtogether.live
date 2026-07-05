// packages/web/src/lib/video/modules/destructor.ts
//
// DESTRUCTOR — mangle/glitch effect. video → video.
//
// Phase-1 reinterpretation of the §3.3 DESTRUCTOR spec (which originally
// split RGB into 3 keys). The agent kickoff prefers a glitch-effect
// reading: chromatic aberration (RGB shifts), scanline disruption, and
// posterization. Splitting RGB into 3 outputs is deferred to a future
// RGBSPLIT helper — keeping DESTRUCTOR in→out keeps the cable graph
// straightforward.
//
// Three knob-driven effects compose in a single shader pass:
//   - shift: horizontal R/B channel offset (scaled by mangle)
//   - scanline: every Nth row gets darkened / shifted, controlled by mangle
//   - posterize: quantizes the output color to N levels per channel
// `mangle` is a master CV input that scales all three.
//
// Inputs:
//   in (video): RGB video input.
//   mangle (cv, paramTarget=mangle): master CV scaling shift+scanline+posterize.
//
// Outputs:
//   out (video): mangled RGB output.
//
// Params:
//   shift (linear 0..1): per-channel horizontal R/B shift amount.
//   scanline (linear 0..1): scanline-disruption intensity.
//   posterize (linear 0..1): per-channel quantization levels (0 = none, 1 = harshest).
//   mangle (linear 0..1): master scale across all three effects.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';

const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uTex;
uniform float uHasInput;
uniform float uShift;     // 0..1 — chromatic aberration amount
uniform float uScanline;  // 0..1 — scanline disruption depth
uniform float uPosterize; // 0..1 — 1=full passthrough, 0=2 levels
uniform float uMangle;    // 0..1 — master modifier

void main() {
  if (uHasInput < 0.5) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  float k = uMangle;

  // RGB shift: pull R left, B right by shift*k. G stays put.
  float dx = uShift * k * 0.05;
  vec3 col;
  col.r = texture(uTex, vec2(vUv.x - dx, vUv.y)).r;
  col.g = texture(uTex, vUv).g;
  col.b = texture(uTex, vec2(vUv.x + dx, vUv.y)).b;

  // Scanline disruption: every other line darkens by scanline*k.
  float scan = step(0.5, fract(vUv.y * 240.0));
  col *= 1.0 - (uScanline * k * 0.7) * scan;

  // Posterize: quantize each channel to N levels. Higher uPosterize
  // means MORE levels (less posterized); we map [0..1] → [2..32].
  float levels = mix(2.0, 32.0, uPosterize);
  col = floor(col * levels + 0.5) / levels;

  outColor = vec4(col, 1.0);
}`;

interface DestructorParams {
  shift: number;
  scanline: number;
  posterize: number;
  mangle: number;
}

const DEFAULTS: DestructorParams = {
  shift: 0.5,
  scanline: 0.5,
  posterize: 0.7,
  mangle: 1.0,
};

export const destructorDef: VideoModuleDef = {
  type: 'destructor',
  palette: { top: 'Video modules', sub: 'Processors' },
  domain: 'video',
  label: 'destructor',
  category: 'effects',
  inputs: [
    { id: 'in',     type: 'video' },
    // paramTarget == port.id keeps docs manifest in sync; bridge uses
    // port id directly so the runtime works either way.
    { id: 'mangle', type: 'cv', paramTarget: 'mangle', cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'out', type: 'video' },
  ],
  params: [
    { id: 'shift',     label: 'Shift',     defaultValue: DEFAULTS.shift,     min: 0, max: 1, curve: 'linear' },
    { id: 'scanline',  label: 'Scanline',  defaultValue: DEFAULTS.scanline,  min: 0, max: 1, curve: 'linear' },
    { id: 'posterize', label: 'Posterize', defaultValue: DEFAULTS.posterize, min: 0, max: 1, curve: 'linear' },
    { id: 'mangle',    label: 'Mangle',    defaultValue: DEFAULTS.mangle,    min: 0, max: 1, curve: 'linear' },
  ],

  // docs-hash-ignore:start
  docs: {
    explanation: "DESTRUCTOR is a single-pass glitch/mangle effect that runs RGB video in and out. The fragment shader stacks three classic digital-decay artifacts: chromatic aberration (the red channel is sampled slightly left and the blue channel slightly right while green stays put, smearing color along the horizontal axis), scanline disruption (alternating rows of a 240-band horizontal grid are darkened), and posterization (each channel is quantized to a discrete number of levels, crushing smooth gradients into hard color steps). The master Mangle amount scales the chromatic aberration and scanline darkening only — posterization is applied independently from the Posterize control and is NOT affected by Mangle. With no input connected the module outputs solid black. Patch it after a source for a CRT/VHS-style decay, or sweep Mangle with an LFO for a pulsing shift/scanline glitch over a steady posterized base.",
    inputs: {
      in: "Video input. The RGB source frame that gets mangled. With nothing patched here the module outputs solid black.",
      mangle: "CV input that modulates the Mangle control — the master amount scaling chromatic aberration and scanline darkening together (posterization is not affected by Mangle).",
    },
    outputs: {
      out: "Video output carrying the mangled RGB frame: channel-shifted, scanline-darkened, and posterized per the controls.",
    },
    controls: {
      shift: "Chromatic aberration amount (0..1, default 0.5). Pulls the red channel left and the blue channel right by up to ~5% of width; at 0 the channels stay aligned. Effective amount is scaled by Mangle.",
      scanline: "Scanline disruption depth (0..1, default 0.5). Darkens every other row of a 240-band horizontal grid by up to ~70%; at 0 no scanlines appear. Effective depth is scaled by Mangle.",
      posterize: "Color quantization (0..1, default 0.7). Maps to 2..32 levels per channel — counterintuitively, 0 is the harshest (2 levels, heavy banding) and 1 is near passthrough (32 levels). Lower values crush gradients into hard steps. NOT scaled by Mangle — posterization is always applied.",
      mangle: "Master amount (0..1, default 1.0) that scales Shift and Scanline together; at 0 both the channel shift and scanline darkening vanish, but Posterize still applies. CV-controllable via the MANGLE input.",
    },
  },
  // docs-hash-ignore:end
  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);

    const uTex       = gl.getUniformLocation(program, 'uTex');
    const uHasInput  = gl.getUniformLocation(program, 'uHasInput');
    const uShift     = gl.getUniformLocation(program, 'uShift');
    const uScanline  = gl.getUniformLocation(program, 'uScanline');
    const uPosterize = gl.getUniformLocation(program, 'uPosterize');
    const uMangle    = gl.getUniformLocation(program, 'uMangle');

    const { fbo, texture } = ctx.createFbo();

    const params: DestructorParams = { ...DEFAULTS, ...(node.params as Partial<DestructorParams>) };

    const surface: VideoNodeSurface = {
      fbo,
      texture,
      draw(frame) {
        const g = frame.gl;
        g.bindFramebuffer(g.FRAMEBUFFER, fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.useProgram(program);

        const inputTex = frame.getInputTexture(node.id, 'in');
        g.uniform1f(uHasInput, inputTex ? 1.0 : 0.0);
        if (inputTex) {
          g.activeTexture(g.TEXTURE0);
          g.bindTexture(g.TEXTURE_2D, inputTex);
          g.uniform1i(uTex, 0);
        }

        g.uniform1f(uShift,     params.shift);
        g.uniform1f(uScanline,  params.scanline);
        g.uniform1f(uPosterize, params.posterize);
        g.uniform1f(uMangle,    params.mangle);

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
