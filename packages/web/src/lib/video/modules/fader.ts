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

  // docs-hash-ignore:start
  docs: {
    explanation: "A two-source video mixer with a built-in send/return FX loop, made of two stacked crossfaders. The first fader crossfades IN A and IN B into a mix that is also copied out the SEND jack (patch it through external video FX and return it); the second fader then blends that dry mix against the wet RETURN into the main OUT. Each fader has its own transition-shape dropdown so the crossfade can be a uniform fade or a wipe/dissolve/star/checkerboard sweep, and the whole thing renders as two GPU passes (pass 1 = A/B mix = SEND, pass 2 = dry/wet = OUT).",
    inputs: {
      in_a: "The A video source — what shows when the A/B fader is at 0. Left unpatched it reads as opaque black, so an unpatched A with the fader toward A gives a black frame.",
      in_b: "The B video source — what shows when the A/B fader is at 1. Left unpatched it reads as opaque black.",
      return: "The wet RETURN of the send/return loop: bring the processed video back in here after sending the A/B mix out SEND through external FX. It becomes the wet side of the dry/wet fader. Unpatched it reads as opaque black, so raising DRY/WET toward WET with nothing returned fades to black.",
    },
    outputs: {
      out: "The main mix output: the dry A/B mix blended against the wet RETURN by the dry/wet fader and its transition shape (the second render pass, the module's canonical surface). With nothing patched into any input this is black.",
      send: "A pre-FX copy of the A/B mix (the first render pass, taken before the dry/wet stage): patch this out to an external video FX chain and bring the result back into RETURN to build a send/return loop. Reflects only the A/B fader and its transition shape; with no A/B sources patched it is black.",
    },
    controls: {
      fader: "The A↔B crossfade position: 0 shows only IN A, 1 shows only IN B, and in between the two are blended by the amount the A/B FX dropdown's shape allows (a plain fade at the 0.5 default is a 50/50 mix). Clamped to 0..1, and the result is the mix that feeds both the SEND output and the dry side of the dry/wet stage.",
      abTransition: "Picks the SHAPE of the A→B crossfade as the fader moves: 0 fade (uniform dissolve across the whole frame), 1 wipe (a soft vertical edge sweeping left→right), 2 dissolve (a fixed random per-cell reveal that fills in more B as the fader rises), 3 star (a 5-point star iris of B growing from the centre outward), 4 checkerboard (even cells switch over during the first half of the fader travel, odd cells during the second). The stored value is rounded and clamped to 0..4, so anything out of range snaps to the nearest valid shape; at the very ends (fader fully A or fully B) every shape collapses to a clean A or B regardless of the dropdown.",
      dryWet: "The dry↔wet blend that produces the final OUT: 0 shows only the dry A/B mix, 1 shows only the wet signal coming back into RETURN, with the in-between shaped by the D/W FX dropdown. Defaults to 0 (fully dry), so the send/return loop has no effect until you raise it. Clamped to 0..1, letting you fade an external effect in and out or transition into it with a wipe/dissolve.",
      dwTransition: "Picks the SHAPE of the dry→wet blend, the same five options as the A/B shape: 0 fade, 1 wipe (left→right), 2 dissolve (per-cell random), 3 star iris, 4 checkerboard. Rounded and clamped to 0..4. Lets you transition into the returned/processed image with a hard wipe or dissolve instead of a flat crossfade.",
    },
  },
  // docs-hash-ignore:end
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
