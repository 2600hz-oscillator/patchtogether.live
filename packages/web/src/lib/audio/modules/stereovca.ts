// packages/web/src/lib/audio/modules/stereovca.ts
//
// STEREOVCA — stereo VCA + ring modulator with independent stereo
// normalling on the audio AND strength halves.
//
// out_l = in_l * (strength_l + offset) * level
// out_r = in_r * (strength_r + offset) * level
//
// The same per-channel multiply behaves as a VCA gain control when the
// strength input is slow (CV / LFO / envelope) and as a ring modulator
// when the strength input is audio-rate. No mode toggle — the perceptual
// difference is purely a function of signal frequency content, matching
// Eurorack hardware convention (CV is just slow audio). The strength
// inputs declare cable type `cv` (raw bipolar carrier consumed directly
// in the per-sample multiply with NO scaling — listed in the
// PASSTHROUGH_BY_DESIGN ledger in cv-scale-registry.test.ts), so any
// cv-typed source (LFO, ADSR, sequencer step CV) lands without a
// cross-type cast. Audio-rate ring mod is achieved by patching
// audio-rate signals into the in_l/in_r audio carriers and any
// modulator into strength_*.
//
// Normalling rules (independent for the two domains):
//   in_r unpatched       → in_r := in_l        (mono → stereo)
//   strength_r unpatched → strength_r := strength_l (one knob both VCAs)
// Either side can be normalled without forcing the other to be.
//
// `level` (0..1, default 1.0) is a master output gain post-multiply.
// `offset` (-1..+1, default 0, BIPOLAR) is a DC term added to the
// strength signal before multiplying. With offset=0, strength=+1 gives
// unity output, strength=0 mutes; offset=+1 lifts the strength's
// effective range so an unpatched (0V) strength still passes audio at
// unity. Useful for "always-on with optional duck" patches.
//
// Inputs:
//   in_l / in_r (audio): stereo audio in.
//   strength_l / strength_r (cv): per-channel multiplier (CV or audio-rate carrier).
//     Slow signals → VCA, audio-rate signals → ring modulator.
//
// Outputs:
//   out_l (audio): in_l * (strength_l + offset) * level.
//   out_r (audio): in_r * (strength_r + offset) * level.
//
// Params:
//   level (linear 0..1, default 1.0): master output gain.
//   offset (linear -1..1, default 0.0): DC offset added to each strength input.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/stereovca.js?url';

const PROCESSOR_NAME = 'stereovca';
const loadedContexts = new WeakSet<BaseAudioContext>();

/** Pure helpers extracted so unit tests can pin the math without spinning
 *  up Web Audio. Mirrors the per-sample loop in stereovca.ts (DSP) — any
 *  drift here means the worklet and the unit-test reference disagree. */
export const stereoVcaMath = {
  /** Per-channel multiply: out = in * (strength + offset) * level. */
  sample(inSample: number, strengthSample: number, offset: number, level: number): number {
    return inSample * (strengthSample + offset) * level;
  },

  /** Apply normalling rules and run the per-sample multiply over a pair
   *  of channel buffers. Returns { outL, outR } as fresh Float32Arrays.
   *  Pass `null` (NOT a silent buffer) for any unpatched input — that's
   *  the same convention the worklet uses to detect normalling targets. */
  render(
    inL: Float32Array | null,
    inR: Float32Array | null,
    sL: Float32Array | null,
    sR: Float32Array | null,
    offset: number,
    level: number,
    frames: number,
  ): { outL: Float32Array; outR: Float32Array } {
    const inRNorm = inR ?? inL;
    const sRNorm  = sR  ?? sL;
    const outL = new Float32Array(frames);
    const outR = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      const xL  = inL      ? (inL[i]      ?? 0) : 0;
      const xR  = inRNorm  ? (inRNorm[i]  ?? 0) : 0;
      const stL = sL       ? (sL[i]       ?? 0) : 0;
      const stR = sRNorm   ? (sRNorm[i]   ?? 0) : 0;
      outL[i] = stereoVcaMath.sample(xL, stL, offset, level);
      outR[i] = stereoVcaMath.sample(xR, stR, offset, level);
    }
    return { outL, outR };
  },
};

export const stereovcaDef: AudioModuleDef = {
  type: 'stereovca',
  palette: { top: 'Audio modules', sub: 'Utility' },
  domain: 'audio',
  label: 'stereovca',
  category: 'utilities',
  schemaVersion: 1,
  // Rack: the canonical 1u reference (1 square tile). Phase-1 rack sizing.
  size: '1u',
  hp: 1,

  inputs: [
    { id: 'in_l',       type: 'audio' },
    { id: 'in_r',       type: 'audio' },
    { id: 'strength_l', type: 'cv' },
    { id: 'strength_r', type: 'cv' },
  ],
  outputs: [
    { id: 'out_l', type: 'audio' },
    { id: 'out_r', type: 'audio' },
  ],
  params: [
    { id: 'level',  label: 'Level',  defaultValue: 1.0, min:  0, max: 1, curve: 'linear' },
    { id: 'offset', label: 'Offset', defaultValue: 0.0, min: -1, max: 1, curve: 'linear' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const worklet = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: 4,
      numberOfOutputs: 2,
      outputChannelCount: [1, 1],
    });

    const params = worklet.parameters as unknown as Map<string, AudioParam>;
    const initial = node.params ?? {};
    for (const def of stereovcaDef.params) {
      const v = initial[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    const pLevel  = params.get('level')!;
    const pOffset = params.get('offset')!;

    return {
      domain: 'audio',
      inputs: new Map([
        ['in_l',       { node: worklet, input: 0 }],
        ['in_r',       { node: worklet, input: 1 }],
        ['strength_l', { node: worklet, input: 2 }],
        ['strength_r', { node: worklet, input: 3 }],
      ]),
      outputs: new Map([
        ['out_l', { node: worklet, output: 0 }],
        ['out_r', { node: worklet, output: 1 }],
      ]),
      setParam(paramId, value) {
        switch (paramId) {
          case 'level':  pLevel.setValueAtTime(value, ctx.currentTime); return;
          case 'offset': pOffset.setValueAtTime(value, ctx.currentTime); return;
        }
      },
      readParam(paramId) {
        switch (paramId) {
          case 'level':  return pLevel.value;
          case 'offset': return pOffset.value;
        }
        return undefined;
      },
      dispose() {
        try { worklet.disconnect(); } catch { /* */ }
      },
    };
  },
};
