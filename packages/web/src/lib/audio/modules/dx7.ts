// packages/web/src/lib/audio/modules/dx7.ts
//
// Module def for DX7 — the **canonical FM module** for patchtogether.live.
// Wraps Plaits' SixOpEngine (the same 6-op DX7-emulation engine that ships
// in eurorack/plaits/dsp/engine2/), compiled to wasm alongside the 2-op
// FMEngine (PlaitsFM, engine_id=9 — different module).
//
// Macro-knob mapping (per the implementation brief): the SixOpEngine takes
// a 144-byte DX7 patch and exposes only 4 high-level controls in its
// ::Render() entry-point. We expose those plus level:
//
//   algorithm  → Plaits' `harmonics` field, which selects 1/32 patch slots
//                in the loaded user_data bank. Our default bank stamps the
//                same baseline patch into all 32 slots and varies only the
//                algorithm byte 0..31, so this knob effectively picks the
//                DX7 algorithm 1..32.
//   brightness → Plaits' `timbre` field, which scales the modulator
//                operators' level (faux "filter cutoff" feel).
//   envelope   → Plaits' `morph` field. SixOpEngine repurposes this as
//                "envelope_control" — a single knob that scrubs all
//                operator envelopes' overall A/D/R timing. Lower values
//                = slower attack + longer release; mid = roughly DX7
//                stock; higher = snappier/percussive.
//   velocity   → Plaits' `accent` field, the per-trigger velocity. The
//                default patches have velocity_sensitivity=0 so this is
//                a no-op until the user loads a velocity-aware patch.
//   level      → Worklet output gain (post-engine).
//
// Inputs: pitch (1V/oct, summed into note) + trigger (gate). Same as
// PlaitsFM — the wasm is engine-agnostic, only `processorOptions.engineId`
// differs.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/plaits.worklet.js?url';

const ENGINE_DX7 = 10;

const loadedContexts = new WeakSet<BaseAudioContext>();

export const dx7Def: AudioModuleDef = {
  type: 'dx7',
  domain: 'audio',
  label: 'DX7',
  category: 'sources',
  schemaVersion: 1,

  inputs: [
    { id: 'pitch',   type: 'pitch' },
    { id: 'trigger', type: 'gate' },
  ],
  outputs: [
    { id: 'audio', type: 'audio' },
    // SixOpEngine writes the same buffer to both out + aux, so the aux
    // here is identical to audio. Exposed for symmetry with PlaitsFM and
    // future stereo work.
    { id: 'aux',   type: 'audio' },
  ],
  params: [
    { id: 'note',       label: 'Note',       defaultValue: 60,  min: 0,   max: 127, curve: 'linear', units: 'st' },
    // 0..31 fits a discrete knob; we present it as 0..1 so it shares the
    // standard Fader and the underlying AudioParam stays a-rate.
    // Plaits internally quantizes harmonics * 1.02 → 0..31 patch index.
    { id: 'algorithm',  label: 'Algorithm',  defaultValue: 0,   min: 0,   max: 1,   curve: 'linear' },
    { id: 'brightness', label: 'Brightness', defaultValue: 0.5, min: 0,   max: 1,   curve: 'linear' },
    { id: 'envelope',   label: 'Envelope',   defaultValue: 0.5, min: 0,   max: 1,   curve: 'linear' },
    { id: 'velocity',   label: 'Velocity',   defaultValue: 0.5, min: 0,   max: 1,   curve: 'linear' },
    { id: 'level',      label: 'Level',      defaultValue: 1,   min: 0,   max: 1,   curve: 'linear' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      try {
        await ctx.audioWorklet.addModule(workletUrl);
      } catch (err) {
        console.error(
          '[dx7] failed to load worklet — has dist/plaits.worklet.js been built?\n' +
            '  Run: flox activate -- task dsp:build:plaits',
          err,
        );
        throw err;
      }
      loadedContexts.add(ctx);
    }

    const workletNode = new AudioWorkletNode(ctx, 'plaits', {
      numberOfInputs: 2,
      numberOfOutputs: 2,
      outputChannelCount: [1, 1],
      processorOptions: { engineId: ENGINE_DX7 },
    });

    workletNode.port.onmessage = (e: MessageEvent) => {
      const m = e.data as { type?: string; error?: string };
      if (m?.type === 'plaits-error') {
        console.error('[dx7] worklet error:', m.error);
      }
    };

    // The processor exposes the same generic AudioParam names as PlaitsFM
    // (note/harmonics/timbre/morph/level). We re-label them on the JS side:
    //   algorithm  → 'harmonics'
    //   brightness → 'timbre'
    //   envelope   → 'morph'
    //   velocity   → handled by SixOpEngine as `accent` (param name 'accent'
    //                isn't an AudioParam in the worklet — it's a constant
    //                that the processor writes via writeParams. Until we
    //                surface it as a real AudioParam, we treat the knob as a
    //                no-op write to a virtual param).
    const PARAM_MAP: Record<string, string | null> = {
      note: 'note',
      algorithm: 'harmonics',
      brightness: 'timbre',
      envelope: 'morph',
      velocity: null, // placeholder; processor uses a hardcoded 0.5 today
      level: 'level',
    };

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of dx7Def.params) {
      const dest = PARAM_MAP[def.id];
      if (!dest) continue;
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(dest)?.setValueAtTime(v, ctx.currentTime);
    }

    return {
      domain: 'audio',
      inputs: new Map([
        ['pitch',   { node: workletNode, input: 0 }],
        ['trigger', { node: workletNode, input: 1 }],
      ]),
      outputs: new Map([
        ['audio', { node: workletNode, output: 0 }],
        ['aux',   { node: workletNode, output: 1 }],
      ]),
      setParam(paramId, value) {
        const dest = PARAM_MAP[paramId];
        if (!dest) return;
        params.get(dest)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        const dest = PARAM_MAP[paramId];
        if (!dest) return undefined;
        return params.get(dest)?.value;
      },
      dispose() {
        workletNode.disconnect();
      },
    };
  },
};
