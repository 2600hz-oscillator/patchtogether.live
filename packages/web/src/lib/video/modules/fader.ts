// packages/web/src/lib/video/modules/fader.ts
//
// FADER — a simple two-source video mixer with a send/return FX loop.
//
// ── SIGNAL FLOW
//   in_a, in_b ──▶ [A/B fader · transition] ──▶ mix ──▶ SEND out (a copy)
//                                                 │
//                                  return in ─────┤
//                                                 ▼
//                              [dry/wet fader · transition] ──▶ OUT
//
//   * The A/B fader crossfades in_a → in_b by `fader` (0 = A, 1 = B) using the
//     `abTransition` shape (fade / wipe / dissolve / star / checkerboard).
//   * That A/B mix is exposed on the SEND output (a copy) — patch it through an
//     external FX chain and bring the result back into `return`.
//   * The dry/wet fader blends the DRY mix (0) ↔ the WET return (1) by `dryWet`
//     using the `dwTransition` shape, producing the main OUT.
//
// ── ARCHITECTURE (multi-output video module, cf. QUADRALOGICAL Mix/Preview)
//   Two FBOs, ONE transition program run twice:
//     pass 1 → mixFbo  = transition(in_a, in_b, fader, abTransition)   [= SEND]
//     pass 2 → outFbo  = transition(mixFbo, return, dryWet, dwTransition) [= OUT]
//   OUT is the canonical `surface.texture`; SEND is exposed per-port via
//   read('outputTexture:send') (engine.outputTexture checks that before the
//   canonical surface). Unpatched inputs sample an opaque-black 1×1 texture, so
//   with nothing patched both outputs are black (see EXEMPT_OUTPUT_EMIT_MODULES).
//
// The blend math (the 5 transition shapes) is pure + unit-tested in
// fader-transitions.ts; the GLSL `transitionFactor` below is a line-for-line port.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';
import { coerceMode, type TransitionMode } from './fader-transitions';

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

// Fragment shader. `transitionFactor` mirrors fader-transitions.ts EXACTLY.
const FRAG_SRC = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTexA;
uniform sampler2D uTexB;
uniform float uT;
uniform int uMode;

float hash21(vec2 p) {
  float h = sin(p.x * 127.1 + p.y * 311.7) * 43758.5453;
  return fract(h);
}

float transitionFactor(float t, int mode, vec2 uv) {
  if (t <= 0.0) return 0.0;
  if (t >= 1.0) return 1.0;
  if (mode == 0) {                 // FADE
    return t;
  } else if (mode == 1) {          // WIPE — soft edge, left → right
    float e = 0.02;
    return smoothstep(uv.x - e, uv.x + e, t);
  } else if (mode == 2) {          // DISSOLVE — random per-cell threshold
    float n = hash21(floor(uv * 120.0));
    return n < t ? 1.0 : 0.0;
  } else if (mode == 3) {          // STAR — 5-point iris from centre
    vec2 p = uv - 0.5;
    float ang = atan(p.y, p.x);
    float rad = length(p) / 0.7071;
    float starF = 0.6 - 0.4 * cos(5.0 * ang);
    float s = clamp(rad * starF, 0.0, 1.0);
    float e = 0.03;
    return 1.0 - smoothstep(t - e, t + e, s);
  } else {                          // CHECKERBOARD — even cells first half, odd second
    vec2 c = floor(uv * 8.0);
    float even = mod(c.x + c.y, 2.0) < 0.5 ? 1.0 : 0.0;
    float phase = even > 0.5 ? t * 2.0 : t * 2.0 - 1.0;
    return clamp(phase, 0.0, 1.0);
  }
}

void main() {
  vec3 a = texture(uTexA, vUv).rgb;
  vec3 b = texture(uTexB, vUv).rgb;
  float f = transitionFactor(clamp(uT, 0.0, 1.0), uMode, vUv);
  outColor = vec4(mix(a, b, f), 1.0);
}`;

export const faderDef: VideoModuleDef = {
  type: 'fader',
  palette: { top: 'Video modules', sub: 'Utilities' },
  domain: 'video',
  label: 'fader',
  category: 'utilities',
  schemaVersion: 1,
  inputs: [
    { id: 'in_a',   type: 'video' },
    { id: 'in_b',   type: 'video' },
    // SEND/RETURN loop: SEND out the A/B mix, process it externally, bring it back.
    { id: 'return', type: 'video' },
  ],
  outputs: [
    { id: 'out',  type: 'video' }, // main mix (canonical surface)
    { id: 'send', type: 'video' }, // copy of the A/B mix for the FX loop
  ],
  params: [
    { id: 'fader',        label: 'A/B',     defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
    { id: 'abTransition', label: 'A/B Fx',  defaultValue: 0,   min: 0, max: 4, curve: 'linear' },
    { id: 'dryWet',       label: 'Dry/Wet', defaultValue: 0,   min: 0, max: 1, curve: 'linear' },
    { id: 'dwTransition', label: 'D/W Fx',  defaultValue: 0,   min: 0, max: 4, curve: 'linear' },
  ],

  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);
    const uTexA = gl.getUniformLocation(program, 'uTexA');
    const uTexB = gl.getUniformLocation(program, 'uTexB');
    const uT = gl.getUniformLocation(program, 'uT');
    const uMode = gl.getUniformLocation(program, 'uMode');

    const outFbo = ctx.createFbo(); // canonical OUT (pass 2)
    const mixFbo = ctx.createFbo(); // A/B mix = SEND  (pass 1)

    // Opaque-black 1×1 for any unpatched input.
    const emptyTex = gl.createTexture();
    if (!emptyTex) throw new Error('FADER: createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, emptyTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    let faderPos = 0.5;
    let abMode: TransitionMode = 0;
    let dryWet = 0;
    let dwMode: TransitionMode = 0;

    /** Run the transition shader: blend texA→texB by t/mode into targetFbo. */
    function pass(targetFbo: WebGLFramebuffer, texA: WebGLTexture, texB: WebGLTexture, t: number, mode: number): void {
      gl.bindFramebuffer(gl.FRAMEBUFFER, targetFbo);
      gl.viewport(0, 0, ctx.res.width, ctx.res.height);
      gl.useProgram(program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texA);
      gl.uniform1i(uTexA, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, texB);
      gl.uniform1i(uTexB, 1);
      gl.uniform1f(uT, t);
      gl.uniform1i(uMode, mode);
      ctx.drawFullscreenQuad();
    }

    const surface: VideoNodeSurface = {
      fbo: outFbo.fbo,
      texture: outFbo.texture,
      draw(frame) {
        const aTex = frame.getInputTexture(node.id, 'in_a') ?? emptyTex;
        const bTex = frame.getInputTexture(node.id, 'in_b') ?? emptyTex;
        const retTex = frame.getInputTexture(node.id, 'return') ?? emptyTex;
        // Pass 1: A/B mix → mixFbo (the SEND output).
        pass(mixFbo.fbo, aTex, bTex, faderPos, abMode);
        // Pass 2: dry (mix) ↔ wet (return) → outFbo (the canonical OUT).
        pass(outFbo.fbo, mixFbo.texture, retTex, dryWet, dwMode);
        frame.gl.bindFramebuffer(frame.gl.FRAMEBUFFER, null);
      },
      dispose() {
        gl.deleteFramebuffer(outFbo.fbo);
        gl.deleteTexture(outFbo.texture);
        gl.deleteFramebuffer(mixFbo.fbo);
        gl.deleteTexture(mixFbo.texture);
        gl.deleteTexture(emptyTex);
        gl.deleteProgram(program);
      },
    };

    return {
      domain: 'video',
      surface,
      setParam(paramId, value) {
        switch (paramId) {
          case 'fader': faderPos = clamp01(value); break;
          case 'abTransition': abMode = coerceMode(value); break;
          case 'dryWet': dryWet = clamp01(value); break;
          case 'dwTransition': dwMode = coerceMode(value); break;
        }
      },
      readParam(paramId) {
        switch (paramId) {
          case 'fader': return faderPos;
          case 'abTransition': return abMode;
          case 'dryWet': return dryWet;
          case 'dwTransition': return dwMode;
          default: return undefined;
        }
      },
      read(key) {
        // SEND output = the A/B mix FBO (engine.outputTexture checks this before
        // falling through to the canonical surface.texture for `out`).
        if (key === 'outputTexture:send') return mixFbo.texture;
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};
