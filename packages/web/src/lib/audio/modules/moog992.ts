// packages/web/src/lib/audio/modules/moog992.ts
//
// MOOG 992 CONTROL VOLTAGE PANEL — a slice of the Moog System 55 / 35 clone
// initiative (.myrobots/MOOG/). The 992 is a passive CV utility: a 4-into-1
// CONTROL-VOLTAGE summing/attenuating panel. Each of the four inputs has its
// own attenuator; the summed result appears at a single CV output. The 4th
// channel is SIGNAL-INVERTING — its attenuator subtracts from the sum, so the
// panel can both add and (with channel 4) subtract control voltages.
//
// PASSIVE / PURE Web Audio: no AudioWorklet, no Faust DSP. The whole module is
// a small GainNode graph — one attenuating GainNode per channel feeding one
// unity summing GainNode → cv_out. (Web Audio fan-in is additive, so four
// gains connected to a single node sum naturally.) Channel 4's gain is NEGATED
// so it inverts.
//
// CV-ONLY: NO audio inputs, NO audio outputs. The four inputs are CV cables
// being summed (PASSTHROUGH — they're the signals being routed, not knob
// modulators, so no cvScale / paramTarget).
//
// Inputs:
//   cv1 / cv2 / cv3 / cv4 (cv): the four control-voltage inputs to sum.
//     cv4 is summed with INVERTED polarity.
//
// Outputs:
//   cv_out (cv): the summed control voltage
//     (cv1*atten1 + cv2*atten2 + cv3*atten3 − cv4*atten4).
//
// Params:
//   atten1..atten4 (linear 0..1, default 1): per-channel attenuator. At 1.0
//     the channel passes at unity. atten4 is applied as a NEGATIVE gain
//     (−atten4) so channel 4 inverts.
//
// Categorized under Ports → moogafakkin (the shared SYS55/SYS35 bucket, mirroring the
// CP3 / 921A). Category 'modulation' because it routes CV.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';

export const moog992Def: AudioModuleDef = {
  type: 'moog992',
  palette: { top: 'Ports', sub: 'moogafakkin' },
  card: 'Moog992Card',
  domain: 'audio',
  label: '992 Control Voltage Panel',
  category: 'modulation',
  schemaVersion: 1,

  inputs: [
    // The four CV inputs being summed. PASSTHROUGH (the signal being routed,
    // not a knob modulator) → no cvScale / paramTarget.
    { id: 'cv1', type: 'cv' },
    { id: 'cv2', type: 'cv' },
    { id: 'cv3', type: 'cv' },
    { id: 'cv4', type: 'cv' },
  ],
  outputs: [
    // The summed control voltage. cv4 contributes with inverted polarity.
    { id: 'cv_out', type: 'cv' },
  ],
  params: [
    { id: 'atten1', label: 'Att 1', defaultValue: 1, min: 0, max: 1, curve: 'linear' },
    { id: 'atten2', label: 'Att 2', defaultValue: 1, min: 0, max: 1, curve: 'linear' },
    { id: 'atten3', label: 'Att 3', defaultValue: 1, min: 0, max: 1, curve: 'linear' },
    { id: 'atten4', label: 'Att 4', defaultValue: 1, min: 0, max: 1, curve: 'linear' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    // One attenuating GainNode per channel. Channel 4 inverts (−atten4).
    const initial = node.params ?? {};
    const attenOf = (id: string): number =>
      initial[id] ?? moog992Def.params.find((p) => p.id === id)!.defaultValue;

    const gain1 = ctx.createGain();
    const gain2 = ctx.createGain();
    const gain3 = ctx.createGain();
    const gain4 = ctx.createGain();
    gain1.gain.value = attenOf('atten1');
    gain2.gain.value = attenOf('atten2');
    gain3.gain.value = attenOf('atten3');
    // Channel 4 is signal-inverting: negate the attenuator.
    gain4.gain.value = -attenOf('atten4');

    // One unity summing node. Web Audio fan-in is additive, so all four
    // channel gains connected here produce the sum.
    const summer = ctx.createGain();
    summer.gain.value = 1;
    gain1.connect(summer);
    gain2.connect(summer);
    gain3.connect(summer);
    gain4.connect(summer);

    // gainN.gain for each channel, keyed by param id (atten4 stores the
    // NEGATED value so we read its magnitude back via readParam).
    const gainByChannel: Record<string, GainNode> = {
      atten1: gain1,
      atten2: gain2,
      atten3: gain3,
      atten4: gain4,
    };

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['cv1', { node: gain1, input: 0 }],
        ['cv2', { node: gain2, input: 0 }],
        ['cv3', { node: gain3, input: 0 }],
        ['cv4', { node: gain4, input: 0 }],
      ]),
      outputs: new Map([
        ['cv_out', { node: summer, output: 0 }],
      ]),
      setParam(paramId, value) {
        const g = gainByChannel[paramId];
        if (!g) return;
        // Channel 4 inverts: store −value so the summed channel subtracts.
        g.gain.value = paramId === 'atten4' ? -value : value;
      },
      readParam(paramId) {
        const g = gainByChannel[paramId];
        if (!g) return undefined;
        // atten4's live gain is negated; return its (positive) attenuator
        // magnitude so the fader UI tracks the knob, not the polarity.
        return paramId === 'atten4' ? -g.gain.value : g.gain.value;
      },
      dispose() {
        try { gain1.disconnect(); } catch { /* */ }
        try { gain2.disconnect(); } catch { /* */ }
        try { gain3.disconnect(); } catch { /* */ }
        try { gain4.disconnect(); } catch { /* */ }
        try { summer.disconnect(); } catch { /* */ }
      },
    };
  },
};
