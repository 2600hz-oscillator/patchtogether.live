// packages/web/src/lib/video/modules/mixer.ts
//
// MIXER — 4-channel video mixer with per-channel amount + CV control.
//
// Phase-1 simplification of §3.10 (which spec'd a 6-channel + 6-color-wheel
// composer). The 4-input, single-mode-per-instance shape covers the most
// common use cases (cross-fade two sources, additively combine four),
// keeps the card UI manageable, and parallels the audio-side mixer.
//
// Modes:
//   - 'blend' (default): out = sum(in[i] * amount[i]); compositing falls
//     out naturally if amounts sum to 1.0.
// Future: 'multiply', 'screen', 'darken', 'lighten' — will be added once
// users have asked for them. Single-mode for Phase 1 keeps the shader
// trivial and the I/O surface clean.
//
// Inputs:
//   in1..in4 (video): four channel inputs.
//   amount1..amount4 (cv, paramTarget=…): per-channel amount CV.
//
// Outputs:
//   out (video): summed RGB output (sum(in[i] * amount[i])).
//
// Params:
//   amount1..amount4 (linear 0..1): per-channel level.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';

const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uTex0;
uniform sampler2D uTex1;
uniform sampler2D uTex2;
uniform sampler2D uTex3;
uniform float uHas0;
uniform float uHas1;
uniform float uHas2;
uniform float uHas3;
uniform float uAmount0;
uniform float uAmount1;
uniform float uAmount2;
uniform float uAmount3;

vec3 sampleOrZero(sampler2D s, float has, vec2 uv) {
  return has > 0.5 ? texture(s, uv).rgb : vec3(0.0);
}

void main() {
  vec3 col = vec3(0.0);
  col += sampleOrZero(uTex0, uHas0, vUv) * uAmount0;
  col += sampleOrZero(uTex1, uHas1, vUv) * uAmount1;
  col += sampleOrZero(uTex2, uHas2, vUv) * uAmount2;
  col += sampleOrZero(uTex3, uHas3, vUv) * uAmount3;
  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

interface MixerParams {
  amount1: number;
  amount2: number;
  amount3: number;
  amount4: number;
}

const DEFAULTS: MixerParams = {
  amount1: 1.0,
  amount2: 0.0,
  amount3: 0.0,
  amount4: 0.0,
};

export const mixerVideoDef: VideoModuleDef = {
  // Type id is 'videoMixer' to avoid clashing with the audio 'mixer' module.
  type: 'videoMixer',
  palette: { top: 'Video modules', sub: 'Utilities' },
  domain: 'video',
  label: 'v-mixer',
  category: 'utilities',
  schemaVersion: 1,
  inputs: [
    { id: 'in1', type: 'video' },
    { id: 'in2', type: 'video' },
    { id: 'in3', type: 'video' },
    { id: 'in4', type: 'video' },
    // paramTarget == port.id keeps docs manifest in sync; bridge uses
    // port id directly so the runtime works either way.
    { id: 'amount1', type: 'cv', paramTarget: 'amount1', cvScale: { mode: 'linear' } },
    { id: 'amount2', type: 'cv', paramTarget: 'amount2', cvScale: { mode: 'linear' } },
    { id: 'amount3', type: 'cv', paramTarget: 'amount3', cvScale: { mode: 'linear' } },
    { id: 'amount4', type: 'cv', paramTarget: 'amount4', cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'out', type: 'video' },
  ],
  params: [
    { id: 'amount1', label: 'A1', defaultValue: DEFAULTS.amount1, min: 0, max: 1, curve: 'linear' },
    { id: 'amount2', label: 'A2', defaultValue: DEFAULTS.amount2, min: 0, max: 1, curve: 'linear' },
    { id: 'amount3', label: 'A3', defaultValue: DEFAULTS.amount3, min: 0, max: 1, curve: 'linear' },
    { id: 'amount4', label: 'A4', defaultValue: DEFAULTS.amount4, min: 0, max: 1, curve: 'linear' },
  ],

  // docs-hash-ignore:start
  docs: {
    explanation:
      "A 4-channel additive video mixer. Each frame it samples up to four input textures at the same UV and sums them, scaling each by its own amount fader: out = in1*A1 + in2*A2 + in3*A3 + in4*A4, with the final RGB clamped to [0,1] and alpha forced opaque. Unpatched inputs contribute pure black (they read a 1x1 sentinel texture, not the mixer's own output, so there is no feedback loop). Because the sum is linear, it doubles as a crossfader (push A1 up while pulling A2 down for a two-source dissolve) and as a brightness/level control on a single source. Bright sources or amounts summing above 1.0 clip to white per channel. Usage hint: keep the active amounts summing near 1.0 for clean compositing; drive amount1..amount4 from LFOs or envelopes for automated fades and pulses.",
    inputs: {
      in1: "Video input for channel 1. Sampled at the output UV and scaled by amount A1 into the sum. Unpatched contributes black.",
      in2: "Video input for channel 2. Sampled at the output UV and scaled by amount A2 into the sum. Unpatched contributes black.",
      in3: "Video input for channel 3. Sampled at the output UV and scaled by amount A3 into the sum. Unpatched contributes black.",
      in4: "Video input for channel 4. Sampled at the output UV and scaled by amount A4 into the sum. Unpatched contributes black.",
      amount1: "CV input that modulates A1 (channel 1 level), linearly scaled into the 0..1 range; patch an LFO or envelope here to automate channel 1's fade.",
      amount2: "CV input that modulates A2 (channel 2 level), linearly scaled into the 0..1 range; patch an LFO or envelope here to automate channel 2's fade.",
      amount3: "CV input that modulates A3 (channel 3 level), linearly scaled into the 0..1 range; patch an LFO or envelope here to automate channel 3's fade.",
      amount4: "CV input that modulates A4 (channel 4 level), linearly scaled into the 0..1 range; patch an LFO or envelope here to automate channel 4's fade.",
    },
    outputs: {
      out: "Video output carrying the per-channel weighted sum of the four inputs, clamped to [0,1] RGB with full opaque alpha.",
    },
    controls: {
      amount1: "A1 fader (linear 0..1, default 1.0) sets channel 1's mix level: 0 mutes it, 1 passes it at full brightness. CV at amount1 modulates this.",
      amount2: "A2 fader (linear 0..1, default 0.0) sets channel 2's mix level: 0 mutes it, 1 passes it at full brightness. CV at amount2 modulates this.",
      amount3: "A3 fader (linear 0..1, default 0.0) sets channel 3's mix level: 0 mutes it, 1 passes it at full brightness. CV at amount3 modulates this.",
      amount4: "A4 fader (linear 0..1, default 0.0) sets channel 4's mix level: 0 mutes it, 1 passes it at full brightness. CV at amount4 modulates this.",
    },
  },
  // docs-hash-ignore:end
  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);

    const uTex = [
      gl.getUniformLocation(program, 'uTex0'),
      gl.getUniformLocation(program, 'uTex1'),
      gl.getUniformLocation(program, 'uTex2'),
      gl.getUniformLocation(program, 'uTex3'),
    ];
    const uHas = [
      gl.getUniformLocation(program, 'uHas0'),
      gl.getUniformLocation(program, 'uHas1'),
      gl.getUniformLocation(program, 'uHas2'),
      gl.getUniformLocation(program, 'uHas3'),
    ];
    const uAmount = [
      gl.getUniformLocation(program, 'uAmount0'),
      gl.getUniformLocation(program, 'uAmount1'),
      gl.getUniformLocation(program, 'uAmount2'),
      gl.getUniformLocation(program, 'uAmount3'),
    ];

    const { fbo, texture } = ctx.createFbo();

    // Sentinel 1×1 black texture for unbound inputs. We can't bind our
    // OWN output texture as a "spare" sampler input — that creates a
    // GL feedback loop (reading from the same texture we're writing to)
    // which on Chrome silently produces garbage / black output across
    // all draw passes. Allocate a separate tiny texture instead.
    const emptyTex = gl.createTexture();
    if (!emptyTex) throw new Error('V-MIXER: createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, emptyTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const params: MixerParams = { ...DEFAULTS, ...(node.params as Partial<MixerParams>) };

    const surface: VideoNodeSurface = {
      fbo,
      texture,
      draw(frame) {
        const g = frame.gl;
        g.bindFramebuffer(g.FRAMEBUFFER, fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.useProgram(program);

        const inputs = ['in1', 'in2', 'in3', 'in4'];
        for (let i = 0; i < 4; i++) {
          const tex = frame.getInputTexture(node.id, inputs[i]!);
          g.activeTexture(g.TEXTURE0 + i);
          g.bindTexture(g.TEXTURE_2D, tex ?? emptyTex);
          g.uniform1i(uTex[i]!, i);
          g.uniform1f(uHas[i]!, tex ? 1.0 : 0.0);
        }
        g.uniform1f(uAmount[0]!, params.amount1);
        g.uniform1f(uAmount[1]!, params.amount2);
        g.uniform1f(uAmount[2]!, params.amount3);
        g.uniform1f(uAmount[3]!, params.amount4);

        ctx.drawFullscreenQuad();
        g.bindFramebuffer(g.FRAMEBUFFER, null);
      },
      dispose() {
        gl.deleteFramebuffer(fbo);
        gl.deleteTexture(texture);
        gl.deleteTexture(emptyTex);
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
