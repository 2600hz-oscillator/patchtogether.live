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
//
// Inputs:
//   in (video): input being fed back.
//   wet / decay / zoom / rotate / offsetX / offsetY (cv, paramTarget=…): per-param CV.
//
// Outputs:
//   out (video): wet+dry feedback render.
//
// Params:
//   wet (linear 0..1): wet/dry balance.
//   decay (linear 0..2): per-frame multiplier on the previous-frame texture.
//   zoom (linear 0.9..1.1): per-frame zoom applied to the prev tap.
//   rotate (linear -π..π): per-frame rotation.
//   offsetX / offsetY (linear -1..1): per-frame translation.

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
  palette: { top: 'Video modules', sub: 'Processors' },
  domain: 'video',
  label: 'feedback',
  category: 'effects',
  schemaVersion: 1,
  inputs: [
    { id: 'in',      type: 'video' },
    // paramTarget == port.id keeps docs manifest in sync; bridge uses
    // port id directly so the runtime works either way.
    { id: 'wet',     type: 'cv', paramTarget: 'wet', cvScale: { mode: 'linear' } },
    { id: 'decay',   type: 'cv', paramTarget: 'decay', cvScale: { mode: 'linear' } },
    { id: 'zoom',    type: 'cv', paramTarget: 'zoom', cvScale: { mode: 'linear' } },
    { id: 'rotate',  type: 'cv', paramTarget: 'rotate', cvScale: { mode: 'linear' } },
    { id: 'offsetX', type: 'cv', paramTarget: 'offsetX', cvScale: { mode: 'linear' } },
    { id: 'offsetY', type: 'cv', paramTarget: 'offsetY', cvScale: { mode: 'linear' } },
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

  // docs-hash-ignore:start
  docs: {
    explanation:
      "Analog-video-style feedback loop, the on-screen equivalent of pointing a camera at its own monitor. Each frame it re-samples its OWN previous output from a ping-pong framebuffer through a small affine warp — rotate and scale the UV about the canvas center, plus a tiny XY offset — multiplies that warped tap by Decay, then adds the fresh input (weighted by 1 minus the clamped decay) to form a recursive accumulator. That accumulator is cross-faded against the dry input by Wet and clamped to [0,1] so destructive Decay over 1.0 saturates white instead of NaN-ing. With Zoom slightly above 1 and a touch of Rotate you get the classic infinite spiraling \"tunnel\"; the prior frame is sampled black outside the canvas (no edge smear) so trails decay into darkness rather than melting along the borders. Patch a camera or any video source into IN, feed OUT back to a monitor, and modulate the warp via the CV inputs for evolving, self-oscillating imagery.",
    inputs: {
      in: "Video input — the source frame fed into the feedback ring each render. When unpatched the loop runs dry (uHasInput=0, input ignored) and only the recirculating prior frame contributes, so it can self-oscillate from whatever residue is already in the buffer.",
      wet: "CV that modulates the Wet control (wet/dry mix between the raw input and the recursive accumulator).",
      decay: "CV that modulates the Decay control (the per-frame gain on the previous-frame tap, i.e. how long trails persist).",
      zoom: "CV that modulates the Zoom control (per-frame scale of the feedback tap about center — the tunnel push/pull).",
      rotate: "CV that modulates the Rotate control (per-frame rotation of the feedback tap about the canvas center).",
      offsetX: "CV that modulates the OffsX control (horizontal drift of the feedback tap each frame).",
      offsetY: "CV that modulates the OffsY control (vertical drift of the feedback tap each frame).",
    },
    outputs: {
      out: "Video output — the wet/dry feedback render (recursive accumulator mixed with the input by Wet), clamped to [0,1]. This is also the just-written ping-pong frame that becomes next frame's feedback source.",
    },
    controls: {
      wet: "Wet — wet/dry mix from 0 to 1. At 0 the output is the pure input passthrough; at 1 it is the pure recursive feedback accumulator. Default 0.5.",
      decay: "Decay — per-frame multiplier on the previous-frame tap, 0 to 2. Below 1 trails fade out; near 1 they persist for a long tunnel; above 1 the loop is destructive and saturates toward clipped white (output is clamped so it can't blow up). Default 0.95.",
      zoom: "Zoom — per-frame scale of the feedback tap about the canvas center, 0.9 to 1.1. The shader divides the sample UV by Zoom, so above 1 the recirculating image magnifies and content flows outward toward the edges (the classic infinite zoom-in tunnel); below 1 it shrinks toward center; 1.0 holds size. Default 1.02.",
      rotate: "Rotate — per-frame rotation of the feedback tap about center, -π to π radians (≈ -3.14159 to 3.14159). Small values spin trails into spirals; large values whip the tunnel hard each frame. Default 0.05.",
      offsetX: "OffsX — horizontal translation of the feedback tap per frame, -1 to 1 (scaled to a small ±0.05 UV shift), drifting the recirculating image sideways. Default 0.",
      offsetY: "OffsY — vertical translation of the feedback tap per frame, -1 to 1 (scaled to a small ±0.05 UV shift), drifting the recirculating image up or down. Default 0.",
    },
  },
  // docs-hash-ignore:end
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
