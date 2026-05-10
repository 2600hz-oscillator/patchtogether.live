// packages/web/src/lib/video/modules/monoglitch.ts
//
// MONOGLITCH — luma → vertical-scanline displacement OUTPUT. Originally
// shipped as RUTTETRA (PR-99) but renamed when the actual Rutt/Etra
// raster-coordinate-remap model landed in its own module. MONOGLITCH is
// NOT a true Rutt/Etra raster-scan processor — it's a luma-driven
// scanline-displacement glitch effect (a useful aesthetic in its own
// right, just a different abstraction). For the real raster-coord
// remap, see packages/web/src/lib/video/modules/ruttetra.ts.
//
// Architecture parity with OUTPUT (videoOut, post-PR-85):
//   - Renders into its own per-instance FBO. The card driving the visible
//     <canvas> calls `engine.blitOutputToDrawingBuffer(nodeId)` right
//     before its `drawImage(engine.canvas, ...)` blit so each card pulls
//     its own per-instance content (multi-MONOGLITCH + multi-OUTPUT patches
//     stay independent — no last-output-wins coupling on the shared FB).
//   - CHAINABLE OUTPUT: exposes its FBO texture via the standard `out`
//     port (same surface.texture used by the on-card preview), so users
//     can chain MONOGLITCH into downstream video modules.
//
// Render approach: per-scanline displacement in a fragment shader. We
// sample the input video, derive luminance per pixel, and for each
// horizontal scanline draw a thin band whose vertical position is
// shifted by luminance × intensity. The H/V CV inputs act as additional
// pan/zoom-style sweep offsets so plugging in saw LFOs makes the canvas
// pan as expected.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';

const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uTex;
uniform float uHasInput;
uniform float uHRamp;       // -1..1 — horizontal pan from external CV
uniform float uVRamp;       // -1..1 — vertical pan from external CV
uniform float uIntensity;   // 0..1 — luminance → displacement magnitude
uniform float uLines;       // 8..240 — scanline count
uniform float uSpacing;     // 0..1 — extra row gap (visual line separation)
uniform float uTintR;
uniform float uTintG;
uniform float uTintB;

float luma(vec3 rgb) {
  return dot(rgb, vec3(0.299, 0.587, 0.114));
}

void main() {
  if (uHasInput < 0.5) {
    // Idle pattern matches OUTPUT — dark navy with a faint sweep so the
    // user can see the card is alive even when nothing's patched in.
    float v = vUv.y * 0.05;
    outColor = vec4(0.04, 0.06, 0.10 + v, 1.0);
    return;
  }

  // Apply ramp offsets (pan). Wrap at the edges so a saw LFO produces
  // smooth horizontal/vertical scrolling instead of clipping.
  vec2 srcUv = vec2(
    fract(vUv.x + uHRamp * 0.5 + 1.0),
    fract(vUv.y + uVRamp * 0.5 + 1.0)
  );

  // Quantize to N scanlines along Y. For each pixel, find which
  // scanline it belongs to + how close it is to the line center after
  // luminance displacement. The "line center" is the scanline's base Y
  // shifted upward by luminance × intensity.
  float n = max(8.0, uLines);
  float scanIdx = floor(srcUv.y * n);
  // Sample luminance once per scanline at the row's horizontal position
  // (matching the source pixel for this fragment).
  vec2 sampleUv = vec2(srcUv.x, (scanIdx + 0.5) / n);
  vec3 src = texture(uTex, sampleUv).rgb;
  float l = luma(src);

  // Each scanline's nominal Y in the destination canvas, biased upward
  // by luminance × intensity so bright pixels lift the line. The 0.4
  // factor caps maximum displacement so even at uIntensity=1 a fully-
  // bright scanline can't overlap the line above by more than ~half a
  // band.
  float baseY = (scanIdx + 0.5) / n;
  float displacedY = baseY - l * uIntensity * 0.4;

  // Distance of THIS fragment from the displaced line center, in
  // canvas-Y units. Compare against a thin band whose height shrinks
  // as line count grows so dense scanlines stay readable.
  float bandHeight = (1.0 / n) * (1.0 - clamp(uSpacing, 0.0, 0.95)) * 0.5;
  float d = abs(vUv.y - displacedY);
  float intensity = 1.0 - smoothstep(bandHeight * 0.5, bandHeight, d);

  // Color: tint × intensity, with a subtle brightness bonus from the
  // source luminance so a "bright" pixel reads brighter than a "dim"
  // displaced one.
  vec3 col = vec3(uTintR, uTintG, uTintB) * intensity * (0.4 + l * 0.8);
  outColor = vec4(col, 1.0);
}`;

interface MonoglitchParams {
  hRamp: number;
  vRamp: number;
  intensity: number;
  lines: number;
  spacing: number;
  tintR: number;
  tintG: number;
  tintB: number;
}

const DEFAULTS: MonoglitchParams = {
  hRamp: 0,
  vRamp: 0,
  intensity: 0.6,
  lines: 96,
  spacing: 0.2,
  // Default tint: classic green phosphor.
  tintR: 0.4,
  tintG: 1.0,
  tintB: 0.5,
};

export const monoglitchDef: VideoModuleDef = {
  type: 'monoglitch',
  domain: 'video',
  label: 'MONOGLITCH',
  category: 'output',
  schemaVersion: 1,
  inputs: [
    // Video source. `video` is the polymorphic type so users can patch
    // mono-video / image / keys via the engine's implicit upcasts.
    { id: 'in',        type: 'video' },
    // CV inputs — port id == param id so the cross-domain CV bridge in
    // PatchEngine routes audio cv signals into setParam(portId).
    { id: 'hRamp',     type: 'cv', paramTarget: 'hRamp' },
    { id: 'vRamp',     type: 'cv', paramTarget: 'vRamp' },
    { id: 'intensity', type: 'cv', paramTarget: 'intensity' },
  ],
  outputs: [
    { id: 'out', type: 'video' },
  ],
  params: [
    { id: 'hRamp',     label: 'H Ramp',    defaultValue: DEFAULTS.hRamp,     min: -1, max: 1, curve: 'linear' },
    { id: 'vRamp',     label: 'V Ramp',    defaultValue: DEFAULTS.vRamp,     min: -1, max: 1, curve: 'linear' },
    { id: 'intensity', label: 'Z',         defaultValue: DEFAULTS.intensity, min: 0,  max: 1, curve: 'linear' },
    { id: 'lines',     label: 'Lines',     defaultValue: DEFAULTS.lines,     min: 8,  max: 240, curve: 'linear' },
    { id: 'spacing',   label: 'Spacing',   defaultValue: DEFAULTS.spacing,   min: 0,  max: 0.95, curve: 'linear' },
    { id: 'tintR',     label: 'Tint R',    defaultValue: DEFAULTS.tintR,     min: 0,  max: 1, curve: 'linear' },
    { id: 'tintG',     label: 'Tint G',    defaultValue: DEFAULTS.tintG,     min: 0,  max: 1, curve: 'linear' },
    { id: 'tintB',     label: 'Tint B',    defaultValue: DEFAULTS.tintB,     min: 0,  max: 1, curve: 'linear' },
  ],

  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);

    const uTex       = gl.getUniformLocation(program, 'uTex');
    const uHasInput  = gl.getUniformLocation(program, 'uHasInput');
    const uHRamp     = gl.getUniformLocation(program, 'uHRamp');
    const uVRamp     = gl.getUniformLocation(program, 'uVRamp');
    const uIntensity = gl.getUniformLocation(program, 'uIntensity');
    const uLines     = gl.getUniformLocation(program, 'uLines');
    const uSpacing   = gl.getUniformLocation(program, 'uSpacing');
    const uTintR     = gl.getUniformLocation(program, 'uTintR');
    const uTintG     = gl.getUniformLocation(program, 'uTintG');
    const uTintB     = gl.getUniformLocation(program, 'uTintB');

    // Own FBO for test-harness reads + future per-OUTPUT visible-canvas
    // routing. Mirrors videoOut's pattern.
    const { fbo, texture } = ctx.createFbo();

    const params: MonoglitchParams = { ...DEFAULTS, ...(node.params as Partial<MonoglitchParams>) };
    let lastInputTexture: WebGLTexture | null = null;

    function bindInputAndUniforms(inputTex: WebGLTexture | null) {
      gl.uniform1f(uHasInput, inputTex ? 1.0 : 0.0);
      if (inputTex) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, inputTex);
        gl.uniform1i(uTex, 0);
      }
      gl.uniform1f(uHRamp,     params.hRamp);
      gl.uniform1f(uVRamp,     params.vRamp);
      gl.uniform1f(uIntensity, params.intensity);
      gl.uniform1f(uLines,     params.lines);
      gl.uniform1f(uSpacing,   params.spacing);
      gl.uniform1f(uTintR,     params.tintR);
      gl.uniform1f(uTintG,     params.tintG);
      gl.uniform1f(uTintB,     params.tintB);
    }

    const surface: VideoNodeSurface = {
      fbo,
      texture,
      draw(frame) {
        const g = frame.gl;
        const inputTex = frame.getInputTexture(node.id, 'in');
        lastInputTexture = inputTex;

        // Render into our own per-instance FBO. The card's draw() calls
        // engine.blitOutputToDrawingBuffer(nodeId) right before its
        // drawImage(engine.canvas) blit, so each MONOGLITCH card shows its
        // own input rather than racing other OUTPUTs through the shared
        // default framebuffer (PR-85 multi-OUTPUT pattern).
        g.bindFramebuffer(g.FRAMEBUFFER, fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.useProgram(program);
        bindInputAndUniforms(inputTex);
        ctx.drawFullscreenQuad();
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
      read(key) {
        if (key === 'hasInput') return lastInputTexture !== null;
        if (key === 'fboTexture') return texture;
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};
