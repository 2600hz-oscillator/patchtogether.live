// packages/web/src/lib/audio/modules/moog961.ts
//
// MOOG 961 INTERFACE — trigger/gate format converter (Moog System 55 clone,
// batch 5). The 961 bridges S-trigger (switch) and V-trigger (voltage) formats
// between a Moog modular and the outside world. In OUR graph every trigger is a
// plain `gate` cable, so polarity is COSMETIC — we model only the TIMING
// behaviours. The conversion DSP lives in the worklet
// (packages/dsp/src/moog961.ts → dist/moog961.js), built on the pure +
// unit-tested ./lib/trigger-convert-dsp.ts.
//
// Circuits (see the lib header for per-circuit detail):
//   (1) audio_in level over `sensitivity` → fire v_out1 AND v_out2 (rising-
//       edge on the rectified audio crossing the threshold).
//   (2) s_in passes straight through onto v_out1 AND v_out2 (format
//       passthrough — an external trigger drives the same V outs).
//   (3) v_in_a → s_out_a, the gate passed through with its INPUT width.
//   (4) v_in_b → s_out_b as a FIXED-WIDTH one-shot of `switchOnTime` seconds
//       on each rising edge (the column-B "switch-on time" pulse).
//
// CV-style inputs: s_in / v_in_a / v_in_b are GATE inputs (the signals being
// converted, not knob modulators), so they're plain node connections — no
// cvScale / paramTarget (PASSTHROUGH_BY_DESIGN, same shape as FLIPPER.in1).
// audio_in is an audio signal feeding the level detector.
//
// Inputs:  audio_in (audio), s_in (gate), v_in_a (gate), v_in_b (gate).
// Outputs: v_out1 (gate), v_out2 (gate), s_out_a (gate), s_out_b (gate).
// Params:  sensitivity (linear 0..1 default 0.5), switchOnTime (log 0.04..4s
//          default 0.2).

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/moog961.js?url';

const PROCESSOR_NAME = 'moog961';
// Per-context cache so addModule isn't called twice on the same context.
const loadedContexts = new WeakSet<BaseAudioContext>();

export const moog961Def: AudioModuleDef = {
  type: 'moog961',
  palette: { top: 'Moog System 35/55 Clones', sub: 'Moog System 35/55 Clones' },
  card: 'Moog961Card',
  domain: 'audio',
  label: '961 interface',
  category: 'utilities',

  inputs: [
    { id: 'audio_in', type: 'audio' },
    // Gate inputs — the signals being format-converted, not knob modulators
    // (PASSTHROUGH_BY_DESIGN: no cvScale / paramTarget, like FLIPPER's gates).
    { id: 's_in',     type: 'gate' },
    { id: 'v_in_a',   type: 'gate' },
    { id: 'v_in_b',   type: 'gate' },
  ],
  outputs: [
    { id: 'v_out1',   type: 'gate' },
    { id: 'v_out2',   type: 'gate' },
    { id: 's_out_a',  type: 'gate' },
    { id: 's_out_b',  type: 'gate' },
  ],
  params: [
    // sensitivity — audio→trigger threshold (linear 0..1).
    { id: 'sensitivity',  label: 'Sensitivity',     defaultValue: 0.5, min: 0,    max: 1, curve: 'linear' },
    // switchOnTime — column-B fixed pulse width in seconds (log fader).
    { id: 'switchOnTime', label: 'Switch-On Time',  defaultValue: 0.2, min: 0.04, max: 4, curve: 'log', units: 's' },
  ],

  docs: {
    explanation:
      "A clean-room recreation of the Moog 961 Interface — the trigger/gate format converter that bridges a Moog modular's S-trigger (switch) and V-trigger (voltage) worlds, plus an audio-to-trigger detector. On the hardware these are different electrical polarities; here every trigger is just a plain gate cable, so polarity is cosmetic and we model the TIMING behaviours. Four little circuits run in parallel: (1) AUDIO IN crossing the SENSITIVITY threshold fires both V outputs; (2) the S input passes straight through to both V outputs; (3) V IN A passes through to S OUT A keeping its incoming width; and (4) V IN B fires S OUT B as a fixed-width one-shot of SWITCH-ON TIME seconds. Mental model: the glue that lets envelopes/clocks/triggers from one part of a patch (or from audio) drive another, reshaping or regenerating the pulse along the way.",
    inputs: {
      audio_in:
        "An audio (or any) signal whose level is watched: when it rises past the SENSITIVITY threshold it fires a trigger pulse on BOTH v_out1 and v_out2 — turn an audio transient or an LFO peak into a trigger.",
      s_in:
        "A trigger input (the 'S' format): it passes straight through to BOTH v_out1 and v_out2, so one incoming trigger drives both V outputs (a format pass-through / fan-out).",
      v_in_a:
        "A gate input (the 'V' format) routed to s_out_a: it passes through carrying its OWN width — while v_in_a is high, s_out_a is high (a width-preserving pass-through).",
      v_in_b:
        "A trigger input routed to s_out_b: each rising edge fires a FIXED-WIDTH one-shot of SWITCH-ON TIME seconds on s_out_b, regardless of how long v_in_b stays high — it re-times the pulse to a set length.",
    },
    outputs: {
      v_out1: "A trigger output fired by either the audio level detector (audio_in over SENSITIVITY) or the s_in pass-through — one of the two parallel V outputs.",
      v_out2: "The second V trigger output, fired by the same sources as v_out1 (audio detector OR s_in), so you get two simultaneous copies to drive two destinations.",
      s_out_a: "Mirrors v_in_a with its incoming width — high while v_in_a is high (a width-preserving gate pass-through).",
      s_out_b: "A fixed-width one-shot: each rising edge on v_in_b emits a pulse of exactly SWITCH-ON TIME seconds here, so you can standardize ragged triggers to a known gate length.",
    },
    controls: {
      sensitivity:
        "The threshold the AUDIO IN level must cross to fire the V outputs, 0 to 1. Lower = more sensitive (quiet sounds trigger); higher = only loud transients fire.",
      switchOnTime:
        "The fixed pulse width (in seconds, 0.04 to 4 on a log taper) of the s_out_b one-shot fired by v_in_b — sets how long that regenerated gate stays high.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    // 4 inputs (audio_in, s_in, v_in_a, v_in_b) → 4 gate outputs, 1 ch each.
    const workletNode = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: 4,
      numberOfOutputs: 4,
      outputChannelCount: [1, 1, 1, 1],
    });

    // Feed silence into input 0 so the node stays in the active processing
    // graph even when nothing is externally patched (mirrors the FLIPPER /
    // 921 VCO silence-keepalive pattern).
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    silence.connect(workletNode, 0, 0);

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of moog961Def.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['audio_in', { node: workletNode, input: 0 }],
        ['s_in',     { node: workletNode, input: 1 }],
        ['v_in_a',   { node: workletNode, input: 2 }],
        ['v_in_b',   { node: workletNode, input: 3 }],
      ]),
      outputs: new Map([
        ['v_out1',  { node: workletNode, output: 0 }],
        ['v_out2',  { node: workletNode, output: 1 }],
        ['s_out_a', { node: workletNode, output: 2 }],
        ['s_out_b', { node: workletNode, output: 3 }],
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
