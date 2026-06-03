// packages/web/src/lib/audio/modules/bluebox.ts
//
// BLUEBOX — DTMF dialer with phreaker buttons.
//
// 12 push-to-talk keys (digits 0..9 + the two phreaker buttons BLUEBOX
// and REDBOX). While a key is "held" — either via the on-card pointerdown
// or via a gate cable patched into its `gate_<name>` input — that key's
// tone(s) play; release drops them out. No envelope, no attack/decay —
// bare on/off sines with a ~1 ms anti-click ramp at the boundary.
//
// Digits emit the Bell-System dual tone (row + col):
//
//        col1=1209   col2=1336   col3=1477
//   row1=697     |  1    |  2    |  3    |
//   row2=770     |  4    |  5    |  6    |
//   row3=852     |  7    |  8    |  9    |
//   row4=941     |       |  0    |       |
//
// BLUEBOX emits a single 2600 Hz sine — the in-band supervisory tone
// AT&T used on long-distance trunks (the basis of the 1970s phone-
// phreaking lineage that begat Captain Crunch / Wozniak's blue boxes /
// the original Apple).
//
// REDBOX emits 1700 + 2200 Hz simultaneously — the US payphone
// coin-acceptance tone pair.
//
// Multiple held keys sum. Sharing-frequency buttons (e.g. '1' and '4'
// both pull col=1209) collapse onto the same shared phase accumulator
// inside the worklet so two simultaneous presses produce a single,
// louder tone — NOT two oscillators beating against each other.
//
// I/O:
//   inputs:  gate_0..gate_9, gate_bluebox, gate_redbox  (12 audio-rate
//            gate inputs; ≥0.5 == button held, <0.5 == released)
//   outputs: out  (mono sum)
//
// Params (auto-exposed to Instruments/Groups via the registry; per the
// project's auto-instrument convention every param on every module is
// surfaceable on a containing group's bar):
//   btn_0..btn_9, btn_bluebox, btn_redbox  (each 0 or 1; ≥0.5 == held)

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/bluebox.js?url';

import {
  BLUEBOX_BUTTON_NAMES,
  BLUEBOX_TONES,
  DTMF_TABLE,
  REDBOX_TONES,
  buttonGateId,
  buttonParamId,
  dtmfFreqs,
  tonesForButton,
  type BlueboxButtonName,
} from '../../../../../dsp/src/lib/bluebox-dsp';

// Re-export the pure-math helpers so the card + tests can reach them via
// the web-side module path without doubling the import surface area.
export {
  BLUEBOX_BUTTON_NAMES,
  BLUEBOX_TONES,
  DTMF_TABLE,
  REDBOX_TONES,
  buttonGateId,
  buttonParamId,
  dtmfFreqs,
  tonesForButton,
  type BlueboxButtonName,
};

// Standard Bell-System phone-keypad letters under each digit. Lives here
// (UI side) rather than in dsp/ because it's purely a visual affordance for
// the card — no DTMF math depends on it. Digits 1 and 0 carry no letters
// on a real phone keypad; we expose them as empty strings so the card can
// uniformly render every cell without conditional logic.
//
//   1: ''      2: 'ABC'   3: 'DEF'
//   4: 'GHI'   5: 'JKL'   6: 'MNO'
//   7: 'PQRS'  8: 'TUV'   9: 'WXYZ'
//              0: ''
export const BLUEBOX_DIGIT_LETTERS: Readonly<Record<string, string>> = Object.freeze({
  '1': '',
  '2': 'ABC',
  '3': 'DEF',
  '4': 'GHI',
  '5': 'JKL',
  '6': 'MNO',
  '7': 'PQRS',
  '8': 'TUV',
  '9': 'WXYZ',
  '0': '',
});

const loadedContexts = new WeakSet<BaseAudioContext>();

export const blueboxDef: AudioModuleDef = {
  type: 'bluebox',
  palette: { top: 'Audio modules', sub: 'VCOs' },
  domain: 'audio',
  label: 'BLUEBOX',
  // BLUEBOX is a sound source (12 audio-rate gate ins → 1 audio out), so
  // it lives in the "VCOs" sub-bucket alongside the other gate-triggered
  // pitched voices (drummergirl, meowbox, dx7).
  category: 'sources',
  schemaVersion: 1,

  inputs: BLUEBOX_BUTTON_NAMES.map((name) => ({
    id: buttonGateId(name),
    type: 'gate' as const,
  })),
  outputs: [{ id: 'out', type: 'audio' as const }],
  params: BLUEBOX_BUTTON_NAMES.map((name) => ({
    id: buttonParamId(name),
    label: name === 'bluebox' || name === 'redbox' ? name.toUpperCase() : name,
    defaultValue: 0,
    min: 0,
    max: 1,
    curve: 'linear' as const,
  })),

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    // 12 audio-rate inputs (one per button gate). Single mono output.
    const workletNode = new AudioWorkletNode(ctx, 'bluebox', {
      numberOfInputs: BLUEBOX_BUTTON_NAMES.length,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of blueboxDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    const inputMap = new Map<string, { node: AudioNode; input: number; param?: AudioParam }>();
    BLUEBOX_BUTTON_NAMES.forEach((name, i) => {
      inputMap.set(buttonGateId(name), { node: workletNode, input: i });
    });

    return {
      domain: 'audio',
      inputs: inputMap,
      outputs: new Map([['out', { node: workletNode, output: 0 }]]),
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      dispose() {
        try { workletNode.disconnect(); } catch { /* */ }
      },
    };
  },
};
