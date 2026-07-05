// packages/web/src/lib/audio/modules/moog905.ts
//
// MOOG 905 SPRING REVERBERATION — a slice of the Moog System 55 / 35 clone
// initiative (.myrobots/MOOG/). The 905 is the classic Moog spring-reverb
// tank: metallic, dispersive, with the characteristic "boing" / chirp on
// transients. Its wet output is a spring-reverb of the audio input, blended
// dry↔wet by the MIX knob.
//
// DSP is an IN-HOUSE dispersive-allpass spring model (own code, permissive) —
// a cascade of Schroeder all-pass sections (the frequency-dependent group
// delay = the spring dispersion / chirp) feeding a modulated feedback delay
// line with in-loop low-pass damping. NOT a literal physical PDE and NOT a
// port of any GPL / CC-BY-SA reverb. The tank lives in the testable lib
// packages/dsp/src/lib/spring-reverb-dsp.ts; the worklet entry
// packages/dsp/src/moog905.ts wraps it + applies the dry/wet mix.
//
// Inputs:
//   audio (audio): the dry signal to reverberate.
//
// Outputs:
//   audio (audio): the dry/wet mix (dry + spring-reverb wet, ratio = mix).
//
// Params:
//   mix   (linear 0..1, default 0.35): dry↔wet blend (0 = dry, 1 = wet).
//   decay (linear 0..1, default 0.6):  tail length / feedback.
//   size  (linear 0..1, default 0.5):  spring length / dispersion + chirp.
//
// Categorized under Moog → SYS55 (the shared SYS55/SYS35 bucket, mirroring the
// CP3 / 921A / 992). Category 'processors' (the audio-effect bucket the
// RESOFILTER uses), since the 905 is an audio processor.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/moog905.js?url';

const PROCESSOR_NAME = 'moog905';
const loadedContexts = new WeakSet<BaseAudioContext>();

export const moog905Def: AudioModuleDef = {
  type: 'moog905',
  palette: { top: 'Moog System 35/55 Clones', sub: 'Moog System 35/55 Clones' },
  card: 'Moog905Card',
  domain: 'audio',
  label: '905 spring reverb',
  category: 'processors',

  inputs: [{ id: 'audio', type: 'audio' }],
  outputs: [{ id: 'audio', type: 'audio' }],
  params: [
    { id: 'mix',   label: 'Mix',   defaultValue: 0.35, min: 0, max: 1, curve: 'linear' },
    { id: 'decay', label: 'Decay', defaultValue: 0.6,  min: 0, max: 1, curve: 'linear' },
    { id: 'size',  label: 'Size',  defaultValue: 0.5,  min: 0, max: 1, curve: 'linear' },
  ],

  docs: {
    explanation:
      "A recreation of the Moog 905 spring reverberation tank — the classic metallic, splashy spring reverb with the characteristic boing and chirp on transients. It is an in-house dispersive-allpass model (own code, not a physical PDE or a port of any reverb): a cascade of Schroeder all-pass sections gives the frequency-dependent group delay that IS the spring's dispersion and chirp, feeding a modulated feedback delay line with in-loop damping for the tail. The MIX knob blends the dry input with the spring's wet output, DECAY sets how long the tail rings, and SIZE sets the spring length — short and tight, or long and boingy. Patch a signal in and dial MIX up for a splash of vintage spring on drums, guitar, or synth.",
    inputs: {
      audio: "The dry signal to reverberate — the audio fed into the spring tank.",
    },
    outputs: {
      audio: "The dry/wet mix: the dry input blended with the spring-reverb wet tail, ratio set by the MIX knob.",
    },
    controls: {
      mix: "Dry↔wet blend — 0 is fully dry (the spring is silent), 1 is fully wet (only the reverberated tail). Lower for a subtle ambience, higher for a drenched, surfy spring. Defaults to 0.35.",
      decay: "Tail length / feedback — how long the spring rings before fading. Low gives a short metallic splash; high gives a long, sustained wash. Defaults to 0.6.",
      size: "Spring length / dispersion — how much chirp and boing the tank has. Small is a tight, bright spring; large stretches the dispersion for the long, wobbly, more dramatic spring character. Defaults to 0.5.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });

    // Keep the node alive when nothing is patched in.
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    silence.connect(workletNode, 0, 0);

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of moog905Def.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['audio', { node: workletNode, input: 0 }],
      ]),
      outputs: new Map([
        ['audio', { node: workletNode, output: 0 }],
      ]),
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      dispose() {
        try { silence.stop(); } catch { /* already stopped */ }
        try { silence.disconnect(); } catch { /* */ }
        try { workletNode.disconnect(); } catch { /* */ }
      },
    };
  },
};
