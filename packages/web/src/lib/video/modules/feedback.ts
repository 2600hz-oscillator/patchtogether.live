// packages/web/src/lib/video/modules/feedback.ts
//
// FEEDBACK — analog-video-style feedback loop with affine warp.
//
// Per spec §3.6: read the previous frame from a ping-pong FBO, sample it
// with a small zoom + rotate + offset transform, multiply by `decay`,
// add `(1-decay) * input`, write to the other ping-pong, then mix with
// the input by `wet` to produce `out`. Output is clamped to [0, 1] in
// the shader so destructive `decay > 1.0` settings don't NaN out.
//
// We use two FBOs (`prevA`, `prevB`) in alternation. Each frame, the one
// that was written *last* frame becomes the "prev" texture sampled by
// the shader; the other receives this frame's accumulator. The
// surface.texture pointer flips at the end of draw() so downstream
// modules sample the just-written frame.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';

const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uPrev;
uniform sampler2D uIn;
uniform float uHasInput;
uniform float uWet;     // 0..1 — output mix
uniform float uDecay;   // 0..2 — feedback gain (>1 = destructive)
uniform float uZoom;    // ~0.9..1.1
uniform float uRotate;  // -π..π
uniform float uOffsetX; // -1..1
uniform float uOffsetY; // -1..1

void main() {
  // Affine warp on the previous-frame sample. We rotate and scale UV
  // around the canvas center so the feedback "tunnel" looks centered
  // by default.
  vec2 c = vUv - 0.5;
  float cs = cos(uRotate);
  float sn = sin(uRotate);
  vec2 r = vec2(c.x * cs - c.y * sn, c.x * sn + c.y * cs);
  r /= max(0.001, uZoom);
  vec2 prevUv = r + 0.5 + vec2(uOffsetX, uOffsetY) * 0.05;

  // Sample previous frame; zero outside the canvas (the engine's CLAMP_
  // TO_EDGE wrap mode means we'd otherwise smear the edges, which
  // accentuates the feedback in a noisy way).
  vec3 prev = vec3(0.0);
  if (prevUv.x >= 0.0 && prevUv.x <= 1.0 && prevUv.y >= 0.0 && prevUv.y <= 1.0) {
    prev = texture(uPrev, prevUv).rgb * uDecay;
  }

  vec3 inSample = uHasInput > 0.5 ? texture(uIn, vUv).rgb : vec3(0.0);
  vec3 acc = prev + (1.0 - clamp(uDecay, 0.0, 1.0)) * inSample;
  // Wet/dry: 0 = pure input passthrough, 1 = pure recursive accumulator.
  vec3 mixed = mix(inSample, acc, uWet);

  outColor = vec4(clamp(mixed, 0.0, 1.0), 1.0);
}`;

interface FeedbackParams {
  wet: number;
  decay: number;
  zoom: number;
  rotate: number;
  offsetX: number;
  offsetY: number;
}

const DEFAULTS: FeedbackParams = {
  wet: 0.5,
  decay: 0.95,
  zoom: 1.02,
  rotate: 0.05,
  offsetX: 0.0,
  offsetY: 0.0,
};

export const feedbackDef: VideoModuleDef = {
  type: 'feedback',
  domain: 'video',
  label: 'FEEDBACK',
  category: 'effects',
  schemaVersion: 1,
  inputs: [
    { id: 'in',      type: 'video' },
    { id: 'wet',     type: 'cv' },
    { id: 'decay',   type: 'cv' },
    { id: 'zoom',    type: 'cv' },
    { id: 'rotate',  type: 'cv' },
    { id: 'offsetX', type: 'cv' },
    { id: 'offsetY', type: 'cv' },
  ],
  outputs: [
    { id: 'out', type: 'video' },
  ],
  params: [
    { id: 'wet',     label: 'Wet',    defaultValue: DEFAULTS.wet,     min: 0,    max: 1,      curve: 'linear' },
    { id: 'decay',   label: 'Decay',  defaultValue: DEFAULTS.decay,   min: 0,    max: 2,      curve: 'linear' },
    { id: 'zoom',    label: 'Zoom',   defaultValue: DEFAULTS.zoom,    min: 0.9,  max: 1.1,    curve: 'linear' },
    { id: 'rotate',  label: 'Rotate', defaultValue: DEFAULTS.rotate,  min: -3.14159, max: 3.14159, curve: 'linear' },
    { id: 'offsetX', label: 'OffsX',  defaultValue: DEFAULTS.offsetX, min: -1,   max: 1,      curve: 'linear' },
    { id: 'offsetY', label: 'OffsY',  defaultValue: DEFAULTS.offsetY, min: -1,   max: 1,      curve: 'linear' },
  ],

  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);

    const uPrev    = gl.getUniformLocation(program, 'uPrev');
    const uIn      = gl.getUniformLocation(program, 'uIn');
    const uHasInput = gl.getUniformLocation(program, 'uHasInput');
    const uWet     = gl.getUniformLocation(program, 'uWet');
    const uDecay   = gl.getUniformLocation(program, 'uDecay');
    const uZoom    = gl.getUniformLocation(program, 'uZoom');
    const uRotate  = gl.getUniformLocation(program, 'uRotate');
    const uOffsetX = gl.getUniformLocation(program, 'uOffsetX');
    const uOffsetY = gl.getUniformLocation(program, 'uOffsetY');

    const fboA = ctx.createFbo();
    const fboB = ctx.createFbo();

    // We always render INTO `dst` and SAMPLE from `src`, then swap.
    // Initial state: both FBOs are empty (RGBA8 cleared on creation).
    let src = fboA;
    let dst = fboB;

    const params: FeedbackParams = { ...DEFAULTS, ...(node.params as Partial<FeedbackParams>) };

    // Surface returns whichever FBO we LAST wrote to (so downstream
    // modules sample the correct frame). We mutate the surface.texture
    // pointer at the end of draw() — the engine reads it via
    // lookupInput() on the next module's draw call.
    const surface: VideoNodeSurface = {
      fbo: fboB.fbo,
      texture: fboB.texture,
      draw(frame) {
        const g = frame.gl;
        g.bindFramebuffer(g.FRAMEBUFFER, dst.fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.useProgram(program);

        // Bind previous-frame texture on unit 0, current input on unit 1.
        g.activeTexture(g.TEXTURE0);
        g.bindTexture(g.TEXTURE_2D, src.texture);
        g.uniform1i(uPrev, 0);

        const inputTex = frame.getInputTexture(node.id, 'in');
        g.activeTexture(g.TEXTURE1);
        // If unpatched, bind a known texture (`src.texture`) just so the
        // sampler isn't pointing at a dangling unit; uHasInput=0 makes
        // the shader ignore the sample.
        g.bindTexture(g.TEXTURE_2D, inputTex ?? src.texture);
        g.uniform1i(uIn, 1);
        g.uniform1f(uHasInput, inputTex ? 1.0 : 0.0);

        g.uniform1f(uWet,     params.wet);
        g.uniform1f(uDecay,   params.decay);
        g.uniform1f(uZoom,    params.zoom);
        g.uniform1f(uRotate,  params.rotate);
        g.uniform1f(uOffsetX, params.offsetX);
        g.uniform1f(uOffsetY, params.offsetY);

        ctx.drawFullscreenQuad();
        g.bindFramebuffer(g.FRAMEBUFFER, null);

        // Flip ping-pong. The just-written FBO becomes the next frame's
        // source AND becomes our published texture so downstream draws
        // sample the freshest output.
        const tmp = src;
        src = dst;
        dst = tmp;
        // Update surface.texture (and fbo, for completeness — engine
        // doesn't use it for sampling but a reader might).
        surface.texture = src.texture;
        surface.fbo = src.fbo;
      },
      dispose() {
        gl.deleteFramebuffer(fboA.fbo);
        gl.deleteTexture(fboA.texture);
        gl.deleteFramebuffer(fboB.fbo);
        gl.deleteTexture(fboB.texture);
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
