// packages/web/src/lib/audio/modules/aquatank.ts
//
// AQUATANK — 4-channel Hadamard FDN feedback matrix.
// One of the three ATLANTIS-PATCH support modules; useful as a standalone
// reverb / chorus / feedback-resonance unit too.
//
// DSP lives in packages/dsp/src/aquatank.ts.
//
// Inputs:
//   in1..in4 (audio): four audio channel inputs feeding the Hadamard FDN matrix.
//   fb1..fb4_cv (cv, linear, paramTarget=fb{N}): per-channel feedback ratio CV.
//   tilt_cv (cv, linear, paramTarget=tilt): displaces the LF/HF tilt of the loop.
//
// Outputs:
//   out1..out4 (audio): per-channel post-matrix outputs (use these for parallel routing).
//   mix_l / mix_r (audio): stereo mix bus of out1..4 (spread-controlled stereo placement).
//
// Params:
//   fb1..fb4 (linear 0..0.95, default 0.4): per-channel feedback ratio.
//   tilt (linear -1..1, default 0): LF/HF balance in the loop.
//   damp (linear 0..1, default 0.4): HF damping inside the matrix.
//   crossMix (linear 0..1, default 0.5): inter-channel matrix coupling.
//   spread (linear 0..1, default 0.7): per-channel stereo-pan width on the mix bus.
//   outLevel (linear 0..1, default 0.6): mix-bus output gain.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/aquatank.js?url';

const loadedContexts = new WeakSet<BaseAudioContext>();

export const aquaTankDef: AudioModuleDef = {
  type: 'aquaTank',
  palette: { top: 'Audio modules', sub: 'Effects' },
  domain: 'audio',
  label: 'aquatank',
  category: 'effects',
  schemaVersion: 1,
  inputs: [
    { id: 'in1',     type: 'audio' },
    { id: 'in2',     type: 'audio' },
    { id: 'in3',     type: 'audio' },
    { id: 'in4',     type: 'audio' },
    { id: 'fb1_cv',  type: 'cv', paramTarget: 'fb1', cvScale: { mode: 'linear' } },
    { id: 'fb2_cv',  type: 'cv', paramTarget: 'fb2', cvScale: { mode: 'linear' } },
    { id: 'fb3_cv',  type: 'cv', paramTarget: 'fb3', cvScale: { mode: 'linear' } },
    { id: 'fb4_cv',  type: 'cv', paramTarget: 'fb4', cvScale: { mode: 'linear' } },
    { id: 'tilt_cv', type: 'cv', paramTarget: 'tilt', cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'out1',  type: 'audio' },
    { id: 'out2',  type: 'audio' },
    { id: 'out3',  type: 'audio' },
    { id: 'out4',  type: 'audio' },
    { id: 'mix_l', type: 'audio' },
    { id: 'mix_r', type: 'audio' },
  ],
  stereoPairs: [['mix_l', 'mix_r']],
  params: [
    { id: 'fb1',      label: 'F1',    defaultValue: 0.4,  min: 0,  max: 0.95, curve: 'linear' },
    { id: 'fb2',      label: 'F2',    defaultValue: 0.4,  min: 0,  max: 0.95, curve: 'linear' },
    { id: 'fb3',      label: 'F3',    defaultValue: 0.4,  min: 0,  max: 0.95, curve: 'linear' },
    { id: 'fb4',      label: 'F4',    defaultValue: 0.4,  min: 0,  max: 0.95, curve: 'linear' },
    { id: 'tilt',     label: 'Tilt',  defaultValue: 0,    min: -1, max: 1,    curve: 'linear' },
    { id: 'damp',     label: 'Damp',  defaultValue: 0.4,  min: 0,  max: 1,    curve: 'linear' },
    { id: 'crossMix', label: 'Cross', defaultValue: 0.5,  min: 0,  max: 1,    curve: 'linear' },
    { id: 'spread',   label: 'Sprd',  defaultValue: 0.7,  min: 0,  max: 1,    curve: 'linear' },
    { id: 'outLevel', label: 'Out',   defaultValue: 0.6,  min: 0,  max: 1,    curve: 'linear' },
  ],

  docs: {
    explanation:
      "A 4-channel Hadamard feedback-delay-network (FDN) — a feedback matrix that takes four audio inputs, runs them through delay lines whose outputs are mixed back into each other through a Hadamard matrix, and recirculates them. Depending on settings it behaves as a dense reverb, a metallic resonator, a chorus, or a self-oscillating feedback-resonance instrument. Each channel has its own feedback ratio (F1..F4) and a direct out, plus there's a stereo MIX bus that spreads the four channels across the field. TILT shapes the LF/HF balance in the loop, DAMP rolls off the highs, CROSS sets how strongly channels couple through the matrix, and SPREAD/OUT shape the stereo mix. It's one of the three ATLANTIS-PATCH support modules but stands alone as a reverb/feedback box.",
    inputs: {
      in1: 'Audio input to channel 1 of the Hadamard FDN matrix.',
      in2: 'Audio input to channel 2.',
      in3: 'Audio input to channel 3.',
      in4: 'Audio input to channel 4. (Patch fewer than four — empty channels still resonate via the matrix coupling.)',
      fb1_cv: 'CV that displaces the F1 feedback-ratio knob, modulating channel 1\'s loop gain (resonance / decay).',
      fb2_cv: "CV that displaces the F2 knob, modulating channel 2's feedback ratio.",
      fb3_cv: "CV that displaces the F3 knob, modulating channel 3's feedback ratio.",
      fb4_cv: "CV that displaces the F4 knob, modulating channel 4's feedback ratio.",
      tilt_cv: 'CV that displaces the TILT knob, modulating the LF/HF balance inside the feedback loop.',
    },
    outputs: {
      out1: "Channel 1's direct post-matrix output — use these four for parallel/multi-tap routing of the resonator.",
      out2: "Channel 2's direct post-matrix output.",
      out3: "Channel 3's direct post-matrix output.",
      out4: "Channel 4's direct post-matrix output.",
      mix_l: 'Left side of the stereo MIX bus: out1..4 summed and panned across the field by SPREAD, scaled by OUT.',
      mix_r: 'Right side of the stereo MIX bus.',
    },
    controls: {
      fb1: "Channel 1 feedback ratio (0..0.95): how much of the loop recirculates. Low = short decay / subtle ambience; near 0.95 = long ringing resonance approaching self-oscillation.",
      fb2: 'Channel 2 feedback ratio (0..0.95).',
      fb3: 'Channel 3 feedback ratio (0..0.95).',
      fb4: 'Channel 4 feedback ratio (0..0.95).',
      tilt: 'LF/HF balance in the loop (-1..+1): negative tilts the recirculating energy toward the lows (darker, boomier resonance), positive toward the highs (brighter, more metallic).',
      damp: 'High-frequency damping inside the matrix (0..1): higher values bleed off the highs each pass, taming harshness and shortening bright resonances.',
      crossMix: 'Inter-channel matrix coupling (0..1): how strongly the four channels feed into each other through the Hadamard mix. Low keeps channels independent (parallel combs); high binds them into a dense, diffuse reverb.',
      spread: 'Per-channel stereo-pan width on the MIX bus (0..1): 0 collapses the four channels to center, 1 spreads them wide across the stereo field.',
      outLevel: 'Output gain of the stereo MIX bus (0..1). The direct out1..4 taps are unaffected by this.',
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = new AudioWorkletNode(ctx, 'aquatank', {
      numberOfInputs: 4,
      numberOfOutputs: 6,
      outputChannelCount: [1, 1, 1, 1, 1, 1],
    });

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of aquaTankDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    return {
      domain: 'audio',
      inputs: new Map([
        ['in1', { node: workletNode, input: 0 }],
        ['in2', { node: workletNode, input: 1 }],
        ['in3', { node: workletNode, input: 2 }],
        ['in4', { node: workletNode, input: 3 }],
        ['fb1_cv',  { node: workletNode, input: 0, param: params.get('fb1')!  }],
        ['fb2_cv',  { node: workletNode, input: 0, param: params.get('fb2')!  }],
        ['fb3_cv',  { node: workletNode, input: 0, param: params.get('fb3')!  }],
        ['fb4_cv',  { node: workletNode, input: 0, param: params.get('fb4')!  }],
        ['tilt_cv', { node: workletNode, input: 0, param: params.get('tilt')! }],
      ]),
      outputs: new Map([
        ['out1',  { node: workletNode, output: 0 }],
        ['out2',  { node: workletNode, output: 1 }],
        ['out3',  { node: workletNode, output: 2 }],
        ['out4',  { node: workletNode, output: 3 }],
        ['mix_l', { node: workletNode, output: 4 }],
        ['mix_r', { node: workletNode, output: 5 }],
      ]),
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      dispose() {
        workletNode.disconnect();
      },
    };
  },
};
