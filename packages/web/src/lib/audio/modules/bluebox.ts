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
  label: 'bluebox',
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

  docs: (() => {
    /** "row Hz + col Hz" description of a key's emitted tones. */
    const toneStr = (name: BlueboxButtonName): string =>
      tonesForButton(name).map((f) => `${f} Hz`).join(' + ');
    const inputs: Record<string, string> = {};
    const controls: Record<string, string> = {};
    for (const name of BLUEBOX_BUTTON_NAMES) {
      const gate = buttonGateId(name);
      const param = buttonParamId(name);
      if (name === 'bluebox') {
        inputs[gate] =
          'Hold gate for the BLUEBOX key: while the level is high the single 2600 Hz supervisory sine plays, and it stops on the falling edge. ORs with the on-card BLUEBOX button — either source can hold the tone open. Level-sensitive, not edge-triggered (there is no envelope; the worklet just adds a ~1 ms anti-click ramp at each boundary).';
        controls[param] =
          'The BLUEBOX key (held = 1, released = 0): plays a single 2600 Hz sine — the in-band supervisory tone AT&T used on long-distance trunks, the basis of the 1970s blue-box phreaking lineage. Held by the on-card button or by a gate patched into BLUEBOX in; multiple held keys sum.';
      } else if (name === 'redbox') {
        inputs[gate] =
          'Hold gate for the REDBOX key: while the level is high the 1700 Hz + 2200 Hz coin-tone pair plays and it stops on the falling edge. ORs with the on-card REDBOX button. Level-sensitive (no envelope; ~1 ms anti-click ramp only).';
        controls[param] =
          'The REDBOX key (held = 1, released = 0): plays 1700 Hz + 2200 Hz together — the US payphone coin-acceptance tone pair. Held by the on-card button or by a gate patched into REDBOX in; sums with any other held keys.';
      } else {
        const letters = BLUEBOX_DIGIT_LETTERS[name];
        const letterNote = letters ? ` (keypad letters ${letters})` : '';
        inputs[gate] =
          `Hold gate for digit ${name}${letterNote}: while the level is high this digit's Bell dual tone (${toneStr(name)}) plays, stopping on the falling edge. ORs with the on-card "${name}" key — either path holds it down. Level-sensitive (no envelope; ~1 ms anti-click ramp only). Keys that share a frequency collapse onto one phase accumulator inside the worklet, so two simultaneous presses of frequency-sharing digits make a single louder tone rather than two beating oscillators.`;
        controls[param] =
          `Digit ${name}${letterNote} (held = 1, released = 0): plays the Bell-System dual tone for this keypad position (${toneStr(name)}). Held by the on-card key or by a gate into the matching gate input; multiple held keys sum into the single mono OUT.`;
      }
    }
    return {
      explanation:
        "A DTMF telephone dialer with two phone-phreaking buttons. BLUEBOX is a 12-key touch-tone pad — digits 0–9 plus BLUEBOX and REDBOX — where every key is a press-and-hold tone source with no envelope: hold it down and its tone(s) sound, release and they stop (a ~1 ms ramp at each edge kills the click). Each digit emits the standard Bell-System dual tone (a row frequency 697/770/852/941 Hz plus a column frequency 1209/1336/1477 Hz); BLUEBOX emits a single 2600 Hz supervisory sine (the classic trunk-seizing tone) and REDBOX emits the 1700 + 2200 Hz payphone coin pair. You can hold a key with the mouse OR by patching a gate cable into its gate input — the worklet ORs the two so either drives it. Held keys sum into one mono output, and keys that share a frequency (e.g. 1 and 4 both use 1209 Hz) collapse onto a single shared oscillator so they reinforce instead of beating.",
      inputs,
      outputs: {
        out: 'Mono sum of every currently-held key. With nothing held it is silent; each held digit/phreaker key adds its tone(s) (frequency-sharing keys reinforce on a shared oscillator rather than detuning against each other). Patch it into a mixer, an effect, or straight to the output.',
      },
      controls,
    };
  })(),

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
