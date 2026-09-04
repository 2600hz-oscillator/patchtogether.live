// packages/web/src/lib/audio/modules/bluebox.ts
//
// BLUEBOX — DTMF dialer with phreaker buttons.
//
// 12 push-to-talk keys (digits 0..9 + the two phreaker buttons BLUEBOX
// and REDBOX). While a key is "held" — either via the on-card pointerdown
// or via a gate cable patched into its `gate_<name>` input — that key's
// tone(s) play; release drops them out. No MUSICAL envelope you can dial —
// bare on/off sines through a one-pole anti-click ramp (τ ≈ 1 ms).
//
// ⚠ "No envelope, no attack, no decay" was asserted here (and in three other
// places) until 2026-08-09, and it was never true of a one-pole: `a += k·(tgt−a)`
// with `k = 1 − exp(−1/(τ·sr))` IS an exponential AR envelope. It is inaudibly
// fast on the way up, but a released key keeps contributing until its amplitude
// falls under the 1e-7 render threshold. MEASURED against the shipping processor
// class at 48 kHz: **707 samples = 14.73 ms** to hard zero, identical for a
// one-tone key (BLUEBOX) and a two-tone one (a digit). That is a short AD tail,
// not a 1 ms ramp, and ~15 ms is the number the faceplate prints.
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

import { createWorkletNode } from '$lib/audio/worklet-guard';
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

  inputs: BLUEBOX_BUTTON_NAMES.map((name) => ({
    id: buttonGateId(name),
    type: 'gate' as const,
    // GATE, not trigger — declared 2026-08-09, and it was already true. The
    // worklet reads the LEVEL every sample (`gateVal >= 0.5`, OR'd with the
    // param) and detects no edge anywhere; the authored prose has said
    // "Level-sensitive, not edge-triggered" since the module shipped. Until this
    // declaration existed, `module-docs-lint`'s edge-vocabulary check skipped
    // all twelve ports (`if (!p.edge) continue`), so that sentence was asserted
    // by nothing. (The ledger that then parked them is gone — the check is now
    // an unconditional deny.)
    edge: 'gate' as const,
  })),
  outputs: [{ id: 'out', type: 'audio' as const }],
  params: BLUEBOX_BUTTON_NAMES.map((name) => ({
    id: buttonParamId(name),
    label: name === 'bluebox' || name === 'redbox' ? name.toUpperCase() : name,
    defaultValue: 0,
    min: 0,
    max: 1,
    // DISCRETE, not linear. The worklet hard-thresholds at `>= 0.5`, so
    // 0.00→0.49 is one state and 0.50→1.00 is the other: there is not one
    // continuous control on this module, and `linear` was a claim about
    // resolution that made the auto-expose path paint twelve 0..1 ROTARIES for
    // twelve buttons (`looksLikeToggle` requires `discrete` —
    // $lib/graph/exposable-controls). It is also what lets the face's
    // switch-classification ratchet see them at all: `looksLikeSwitch` is
    // `looksLikeToggle && defaultValue === 0`, so with `linear` these twelve
    // press-pads were invisible to module-face-lint's "every switch-shaped
    // param is classified momentary or acknowledged latching" clause.
    curve: 'discrete' as const,
  })),

  /** The hero picture — the ten-slot tone bank. See `face.hero` + shell-cells. */
  controlFamilies: [
    {
      id: 'bluebox-tonebank',
      label: 'Tone bank',
      kind: 'cell' as const,
      testidPrefix: 'bluebox-tonebank',
    },
  ],

  // ── THE FACEPLATE ─────────────────────────────────────────────────────────
  //
  // Authored from what this module IS: a DIALER — twelve momentary keys into
  // ONE bank of ten sine oscillators.
  //
  // ⚠ 1 · THE RANKING PROBLEM, AND WHAT THIS FACE DOES ABOUT IT.
  //
  // `face.order` is a PRIORITY ranking for the tiers that show a subset (the
  // lane plate is six cells, the compact tile two). A telephone keypad has no
  // priority: there is no honest answer to "which six of twelve interchangeable
  // keys matter most", and ranking `1 2 3 4 5 6` while calling it importance
  // would be declaration order wearing a justification.
  //
  // So this face does not rank by priority. **It ranks by LAYOUT**, and the
  // property that buys is real and checkable: EVERY PREFIX OF THE RANKING IS
  // STILL A RECOGNISABLE KEYPAD FRAGMENT. The 6-cell lane plate is the top two
  // rows of a phone; the compact tile is `1 2`. Every alternative ranking
  // produces a truncation that is NOT a keypad and is no more true — including
  // the one genuinely principled subset available here, the minimal bank cover
  // {1, 5, 9, 0, BLUEBOX, REDBOX}, which really is the smallest set of keys
  // that lights all ten oscillators (checked) and which reads, in a lane tile,
  // as a broken phone.
  //
  // The order is therefore DERIVED from `BLUEBOX_BUTTON_NAMES` — the same array
  // the card lays the pad out from — rather than typed, so it cannot drift into
  // a hand-written order that merely looks like one. `bluebox-face-model.test.ts`
  // asserts that derivation.
  //
  // ⚠ 2 · AND BECAUSE NO PREFIX CAN CARRY THE MODULE'S INFORMATION, the
  // information goes elsewhere. The LANE gets a `meter` glyph — the module's
  // actual hazard is how hot it is (eight simultaneous digits is exactly full
  // scale) — and the DOCK gets the ten-bar TONE BANK, which is the only surface
  // anywhere that makes the shared-oscillator `+=` visible.
  //
  // ⚠ 3 · THE KEYS ARE MOMENTARY, AND THE READOUTS CANNOT SEE A PRESS. Stated
  // here because it is this faceplate's honest limit, not hidden. `face.momentary`
  // is the correct classification (the card writes 1 on pointerdown and 0 on
  // pointerup, `docs.controls` says "held = 1, released = 0", and it is what
  // makes `restedParams` repair a rack the legacy card saved mid-hold). But a
  // momentary press writes the ENGINE ONLY by design ($lib/audio/momentary-params
  // — a rack must not be saveable with a pad held down) and a GATE CABLE is a
  // worklet node input, so NEITHER reaches `node.params`, which is the single
  // source `ModuleShell.readoutValue` and this face's panel both read. The bank
  // and the readouts are therefore live for every DURABLE route into the keys
  // (the auto-exposed group/instrument bar, a MIDI-learned CC, an automation
  // lane, a preset recall, the legacy card) and dark for the two transient ones.
  // Latching the keys instead would have made everything live and was rejected:
  // it contradicts the card, the docs and the tidyVco `hold` precedent. Filed as
  // a platform follow-up (a live-engine reader for `FaceReadout`); the numbers
  // themselves are exact and negative-controlled today.
  face: {
    // Ranks 1-12: the pad, in the order it is printed on a telephone. Rank 13:
    // the hero picture — a panel's first legal rank is 7 (module-face-lint fails
    // any panel SELECTED at a lane tier: "a 380px panel in a 46px knob column"),
    // and the twelve keys already fill 1-12.
    order: [...BLUEBOX_BUTTON_NAMES.map(buttonParamId), 'bluebox-tonebank-{n}'],

    // TWO BANDS, and the split is the one the DSP makes: ten keys that pair a
    // ROW tone with a COLUMN tone into a digit a receiver can decode, and two
    // that emit frequencies outside the DTMF grid entirely — which is the whole
    // reason a blue box worked.
    //
    // ⚠ THE PROMOTED PANEL IS LISTED IN BAND 1, and it must be. `face.hero`
    // does not ADD a cell — it MOVES one, and `heroFacePlan` can only move a key
    // some band already claims. Band 1 keeps its ten keys, so nothing empties.
    pages: [
      {
        id: 'keypad',
        label: '1 · the bell grid',
        hint:
          'each digit lights ONE row tone (697/770/852/941) and ONE column tone ' +
          '(1209/1336/1477) in the shared bank — so two digits in the same column are not two ' +
          'tones, they are one tone twice as tall.',
        controls: [
          'bluebox-tonebank-{n}',
          'btn_1', 'btn_2', 'btn_3',
          'btn_4', 'btn_5', 'btn_6',
          'btn_7', 'btn_8', 'btn_9',
          'btn_0',
        ],
      },
      {
        id: 'inband',
        label: '2 · in-band — the two no receiver decodes',
        hint:
          '2600 Hz alone, AT&T’s supervisory tone, one slot of its own shared with nothing; and ' +
          'the 1700 + 2200 Hz payphone coin pair. Neither is on the DTMF grid, which is exactly ' +
          'why holding one changes the level and changes nothing a receiver would decode.',
        controls: ['btn_bluebox', 'btn_redbox'],
      },
    ],

    // A VuMeter on `out`. Deliberately NOT the bank: painting ten slots into a
    // 64 px tile would need a new glyph kind, which the faces design program
    // demotes for good reason, and the bank belongs where there is room for it.
    // What a compact tile can honestly say about this module is HOW HOT IT IS.
    glyph: 'meter',

    // All twelve. Every key is a press-pad: the card writes 1 on pointerdown and
    // 0 on pointerup, the worklet ORs the param with the gate as LEVELS, and
    // nothing anywhere latches. (Not ACKNOWLEDGED_LATCHING: these are not a
    // state you leave engaged — the tidyVco `hold` correction is the precedent.)
    momentary: BLUEBOX_BUTTON_NAMES.map(buttonParamId),

    title: 'Dialer',
    hint:
      'Twelve momentary keys into ONE bank of ten sine oscillators. A digit lights a ROW tone ' +
      'and a COLUMN tone; two keys that share a tone stack into the SAME oscillator, which is ' +
      'why {1,4} is 1.76 dB louder than {1,5} even though both hold two keys, both make four ' +
      'tone activations and both peak at the same level.',

    // THE HERO. No `control` — promoting one key would contradict the ranking
    // note above, and no key outranks another. No `action` either: every key IS
    // an audition, so picking one for the hero would be the same arbitrary
    // choice in a bigger font.
    //
    // ⚠ AND NO `readouts`, WHICH IS THE ONE DECLARATION THIS FACE HAD TO GIVE
    // UP — deliberately, on a measurement. The five numbers about this module
    // (level, headroom, decodes, keys held, tones lit) are all functions of the
    // KEY STATE, and `ModuleShell.readoutValue` reads `params.paramVal`, the
    // DURABLE value, by deliberate platform design. On this module that reader
    // is not merely incomplete, it is CONSTANT ZERO FOREVER: every param is
    // momentary, a press writes the engine only, AND any durable write from the
    // group bar / MIDI / automation / preset / legacy card is scrubbed back to
    // rest within a frame by ModuleShell's own `clearStuckMomentaryParams`
    // `$effect` (it reads `node.params`, so it re-fires on every write —
    // MEASURED: `btn_1 = 1` through `__ydoc.transact` reads back 0). Declaring
    // them here would ship five captions that print `silent` on every render
    // forever. The numbers therefore live INSIDE the hero panel, which reads
    // the LIVE ENGINE (measured: `readParam` reads 1 while a key is held) —
    // one source, one component, rather than a moving picture beside three
    // dead labels. The platform follow-up is a live-engine reader for
    // `FaceReadout`; until then this is where the truth is.
    hero: {
      cell: 'bluebox-tonebank-{n}',
    },

    // REAR CARD. Twelve gate jacks is a wall, so the two clusters give the back
    // the same shape the front has — the pad, then the two tones no receiver
    // decodes. Every one is an AUDIO-RATE worklet node input (no port on this
    // module declares a `paramTarget`, and the factory makes every one of the
    // twelve a plain node connection), so they all take the `~` tick.
    rear: {
      groups: [
        {
          id: 'voice',
          label: 'key gates',
          ports: BLUEBOX_BUTTON_NAMES.map(buttonGateId),
        },
      ],
      clusters: [
        {
          group: 'voice',
          label: 'digits · one per keypad position',
          ports: BLUEBOX_BUTTON_NAMES.filter((n) => n !== 'bluebox' && n !== 'redbox').map(
            buttonGateId,
          ),
        },
        {
          group: 'voice',
          label: 'in-band · outside the grid',
          ports: ['gate_bluebox', 'gate_redbox'],
        },
      ],
      audioRate: BLUEBOX_BUTTON_NAMES.map(buttonGateId),
    },
  },

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
          'Hold gate for the BLUEBOX key: while the level is high the single 2600 Hz supervisory sine plays, and it stops on the falling edge. ORs with the on-card BLUEBOX button — either source can hold the tone open. Level-sensitive, not edge-triggered: the worklet reads the LEVEL every sample and detects no edge anywhere. There is no musical envelope you can dial — just a one-pole anti-click ramp (\u03c4 \u2248 1 ms) that is inaudibly fast on the way up and takes about 15 ms to reach silence on release.';
        controls[param] =
          'The BLUEBOX key (held = 1, released = 0): plays a single 2600 Hz sine — the in-band supervisory tone AT&T used on long-distance trunks, the basis of the 1970s blue-box phreaking lineage. Held by the on-card button or by a gate patched into BLUEBOX in; multiple held keys sum.';
      } else if (name === 'redbox') {
        inputs[gate] =
          'Hold gate for the REDBOX key: while the level is high the 1700 Hz + 2200 Hz coin-tone pair plays and it stops on the falling edge. ORs with the on-card REDBOX button. Level-sensitive, not edge-triggered \u2014 the worklet reads the level, never an edge. No musical envelope: a one-pole anti-click ramp only (\u03c4 \u2248 1 ms up, about 15 ms to silence on release).';
        controls[param] =
          'The REDBOX key (held = 1, released = 0): plays 1700 Hz + 2200 Hz together — the US payphone coin-acceptance tone pair. Held by the on-card button or by a gate patched into REDBOX in; sums with any other held keys.';
      } else {
        const letters = BLUEBOX_DIGIT_LETTERS[name];
        const letterNote = letters ? ` (keypad letters ${letters})` : '';
        inputs[gate] =
          `Hold gate for digit ${name}${letterNote}: while the level is high this digit's Bell dual tone (${toneStr(name)}) plays, stopping on the falling edge. ORs with the on-card "${name}" key — either path holds it down. Level-sensitive, not edge-triggered \u2014 the worklet reads the level, never an edge. No musical envelope: a one-pole anti-click ramp only (\u03c4 \u2248 1 ms up, about 15 ms to silence on release). Keys that share a frequency collapse onto one phase accumulator inside the worklet, so two simultaneous presses of frequency-sharing digits make a single louder tone rather than two beating oscillators.`;
        controls[param] =
          `Digit ${name}${letterNote} (held = 1, released = 0): plays the Bell-System dual tone for this keypad position (${toneStr(name)}). Held by the on-card key or by a gate into the matching gate input; multiple held keys sum into the single mono OUT.`;
      }
    }
    controls['bluebox-tonebank-{n}'] =
      'THE TONE BANK — ten bars, one per oscillator, and the picture of what this module actually is. There is no oscillator per key: there is ONE fixed bank of ten sines (the four DTMF rows 697/770/852/941, the three columns 1209/1336/1477, and 1700 / 2200 / 2600), and a held key raises the target amplitude of each frequency it lights by a quarter. That word "raises" is the module: two keys that share a tone drive ONE bar twice as hard instead of running two independent voices, which is why holding 1 and 4 (both pull column 1209) is 1.76 dB louder than holding 1 and 5 — even though both hold two keys, both make four tone activations, and both peak at the same level. A bar carrying more than one held key is marked with its count, so the stacking is labelled rather than inferred, and every bar is outlined to its CAPACITY — how many keys could ever light it — so column 1336 reads as the tall one (2, 5, 8 and 0 all pull it) before anything is pressed. The bars are tinted by band: DTMF rows, DTMF columns, and the in-band tones that belong to no digit at all. The vertical scale is FIXED at four keys, the most any one slot can stack, so a bar growing is a bar growing rather than the axis rescaling under your hand. The label button flips the captions between each oscillator\'s frequency and the keys that light it, which is the Bell grid read backwards and the direct answer to "why did those two stack"; it is a display setting, private to your screen, not shared with the rackspace and not saved with the patch. Every height is computed from the live key state through the worklet\'s own frequency table, so it is the target the bank is heading for rather than an analyser reading. It does NOT move while you hold a key down on the faceplate or drive one from a gate cable: a momentary press writes only the audio engine and a gate is an audio-rate input, so neither is visible to any host-side reader — the bank lights when the keys are set durably (an instrument or group bar, a MIDI-mapped control, an automation lane, a preset recall, or the classic card).';
    return {
      explanation:
        "A DTMF telephone dialer with two phone-phreaking buttons. BLUEBOX is a 12-key touch-tone pad — digits 0–9 plus BLUEBOX and REDBOX — where every key is a press-and-hold tone source with no musical envelope: hold it down and its tone(s) sound, release and they stop (a one-pole ramp at each edge kills the click; it is inaudibly fast on the way up and takes about 15 ms to reach silence on the way down). Each digit emits the standard Bell-System dual tone (a row frequency 697/770/852/941 Hz plus a column frequency 1209/1336/1477 Hz); BLUEBOX emits a single 2600 Hz supervisory sine (the classic trunk-seizing tone) and REDBOX emits the 1700 + 2200 Hz payphone coin pair. You can hold a key with the mouse OR by patching a gate cable into its gate input — the worklet ORs the two as levels, so either drives it and neither detects an edge. Held keys sum into one mono output through a fixed divide-by-four, and keys that share a frequency (e.g. 1 and 4 both use 1209 Hz) collapse onto a single shared oscillator so they reinforce instead of beating — which also makes them LOUDER than a pair that shares nothing. Watch the headroom: one digit sits 18 dB below full scale, eight simultaneous digits reach it, and all twelve keys overshoot by about 2.5 dB.",
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
    const workletNode = createWorkletNode(node, ctx, 'bluebox', {
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
