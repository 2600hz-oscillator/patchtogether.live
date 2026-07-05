// packages/web/src/lib/audio/modules/ringback.ts
//
// RINGBACK — stereo crush effect extracted from the TWOTRACKS record-time
// artifact. Stereo in (L/R) → stereo out (L/R). Wraps the `ringback` worklet
// (packages/dsp/src/ringback.ts), which runs the shared RingChannel crush core
// (ringback-core.ts): an integer-cell varispeed write into a small ring buffer
// + a fractional interpolated read-back at the same cursor + feedback, dry/wet
// at the output — the exact mechanism that made TWOTRACKS' monitor sound
// "bitcrushed" while recording, now a deliberate effect.
//
// Inputs:
//   in_l / in_r (audio) — stereo input (mono in → mirrored to both channels).
// Outputs:
//   out_l / out_r (audio) — stereo crushed output.
// Params (all a-rate → accept CV):
//   rate     (0.05..4,  default 0.5)  — crush amount: 1 = mildest, <1 stair-steps hardest.
//   size     (2..4096,  default 64)   — ring length in samples (comb ↔ grainy smear).
//   feedback (0..0.98,  default 0.3)  — read-back re-injected into the ring (regen tail).
//   mix      (0..1,     default 1)    — dry/wet (0 = clean, 1 = full crush).

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/ringback.js?url';

// Pure crush math re-exported from the worklet's shared core so the card + unit
// tests share ONE import surface (relative path, not the package alias —
// svelte-check only resolves the TS source out of node_modules via the dist
// build; cube.ts / twotracks.ts re-export the same way).
export {
  ringRead,
  ringWriteSpan,
  clampSize,
  clampFeedback,
  clampMix,
  mixSample,
  RingChannel,
  RINGBACK_MIN_SIZE,
  RINGBACK_MAX_SIZE,
  RINGBACK_MAX_FEEDBACK,
} from '../../../../../dsp/src/lib/ringback-core';

const PROCESSOR_NAME = 'ringback';
const loadedContexts = new WeakSet<BaseAudioContext>();

export const ringbackDef: AudioModuleDef = {
  type: 'ringback',
  label: 'ringback', // MUST be lowercase (card CSS uppercases for display)
  palette: { top: 'Audio modules', sub: 'Effects' },
  domain: 'audio',
  category: 'effects',

  inputs: [
    { id: 'in_l', type: 'audio' },
    { id: 'in_r', type: 'audio' },
    // CV inputs — the four params are a-rate worklet AudioParams, so a -1..+1
    // CV sweeps each param's natural range via the shared cvScale routing
    // (engine.addEdge → attachCvScale). cvScale.mode mirrors each knob's curve.
    { id: 'rate',     type: 'cv', paramTarget: 'rate',     cvScale: { mode: 'linear' } },
    { id: 'size',     type: 'cv', paramTarget: 'size',     cvScale: { mode: 'log' } },
    { id: 'feedback', type: 'cv', paramTarget: 'feedback', cvScale: { mode: 'linear' } },
    { id: 'mix',      type: 'cv', paramTarget: 'mix',      cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'out_l', type: 'audio' },
    { id: 'out_r', type: 'audio' },
  ],
  params: [
    { id: 'rate',     label: 'Rate',     defaultValue: 0.5, min: 0.05, max: 4,    curve: 'linear' },
    { id: 'size',     label: 'Size',     defaultValue: 64,  min: 2,    max: 4096, curve: 'log', units: 'smp' },
    { id: 'feedback', label: 'Feedback', defaultValue: 0.3, min: 0,    max: 0.98, curve: 'linear' },
    { id: 'mix',      label: 'Mix',      defaultValue: 1,   min: 0,    max: 1,    curve: 'linear' },
  ],

  docs: {
    explanation:
      "A stereo crush effect built from the exact glitch that used to make TWOTRACKS' monitor sound bitcrushed while recording, turned into a deliberate instrument. Each channel writes the input into a short ring buffer at an integer-cell varispeed (set by RATE) and reads it back with fractional interpolation at the same moving cursor, with FEEDBACK re-injecting the read-back into the ring. The mismatch between the stair-stepped write and the smooth read produces a crushed, comb-filtered, grainy texture whose character ranges from subtle aliasing to harsh digital smear. RATE sets the crush hardness, SIZE the ring length (comb pitch ↔ grainy smear), FEEDBACK the regenerating tail, and MIX the dry/wet. All four are a-rate, so every knob is CV-patchable.",
    inputs: {
      in_l: 'Left-channel audio into the crush ring buffer. (A mono source is mirrored to both channels.)',
      in_r: 'Right-channel audio into the crush ring buffer.',
      rate: 'CV that displaces the RATE knob (linear), modulating the varispeed write rate — sweep it for shifting crush intensity and pitched-comb artifacts.',
      size: 'CV that displaces the SIZE knob (log-scaled), modulating the ring length live (comb-filter pitch ↔ grain size).',
      feedback: 'CV that displaces the FEEDBACK knob, modulating how much read-back re-injects (the regenerating tail amount).',
      mix: 'CV that displaces the MIX knob, modulating the dry/wet crush balance.',
    },
    outputs: {
      out_l: 'Left channel of the crushed stereo output (dry blended with the crushed ring read-back per MIX).',
      out_r: 'Right channel of the crushed stereo output.',
    },
    controls: {
      rate: 'Crush amount via the varispeed write rate (0.05..4). 1 is the mildest (write and read nearly aligned); values below 1 stair-step the write hardest for the coarsest crush; higher values speed the cursor for brighter, pitched artifacts.',
      size: 'Ring buffer length in samples, log-scaled 2..4096. Tiny sizes give a high-pitched comb-filter tone; larger sizes spread into a grainy, smeared echo-like texture.',
      feedback: 'How much of the read-back is re-injected into the ring (0..0.98). 0 is a single pass; higher values build a regenerating, resonant crushed tail; near 0.98 it rings for a long time.',
      mix: 'Dry / wet balance (0..1): 0 is the clean input, 1 is full crush, between blends the two.',
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const worklet = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: 2, // [0]=L, [1]=R
      numberOfOutputs: 1,
      outputChannelCount: [2], // stereo
    });

    const params = worklet.parameters as unknown as Map<string, AudioParam>;
    const initial = node.params ?? {};
    for (const def of ringbackDef.params) {
      const v = initial[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    return {
      domain: 'audio',
      inputs: new Map([
        ['in_l', { node: worklet, input: 0 }],
        ['in_r', { node: worklet, input: 1 }],
        // CV → AudioParam (a-rate). node/input are placeholders required by the
        // handle type; the engine connects to `param` (cvScale interposed).
        ['rate',     { node: worklet, input: 0, param: params.get('rate')! }],
        ['size',     { node: worklet, input: 0, param: params.get('size')! }],
        ['feedback', { node: worklet, input: 0, param: params.get('feedback')! }],
        ['mix',      { node: worklet, input: 0, param: params.get('mix')! }],
      ]),
      outputs: new Map([
        ['out_l', { node: worklet, output: 0 }],
        ['out_r', { node: worklet, output: 0 }],
      ]),
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      dispose() {
        try { worklet.disconnect(); } catch { /* */ }
      },
    };
  },
};
