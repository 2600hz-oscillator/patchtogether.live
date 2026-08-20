// packages/web/src/lib/audio/modules/meowbox.ts
//
// MEOWBOX — gate-triggered cat-vocal synth voice. Faust DSP — formant bank +
// harmonic+noise excitation + stereo decorrelation tail. See drummergirl.ts
// for the closest reference (similar gate-triggered all-in-one voice shape).
//
// Schema v2 (PR fix/meowbox-voct): the `pitch` input is now a true 1V/oct
// audio-rate input — type changed from 'cv' (semitone-scaled AudioParam) to
// 'pitch' (V/oct audio-rate). The DSP's `process(gate, pitch)` consumes the
// volts directly; the `pitch` knob (semitones) is now a transposition added
// on top of the CV (mirrors analog-vco's `tune` knob). Old saves load
// unchanged — the knob default (0) and CV default (silence = 0V) reproduce
// the previous "C4 with no input" behavior.
//
// Inputs:
//   gate (gate, edge:'gate'): the voice sounds WHILE this is high. See below.
//   pitch (pitch): V/oct pitch input, 0V = C4. Summed with the pitch knob (transposition).
//   morph (cv, linear, paramTarget=morph): displaces the anchor morph (0..1).
//   decay (cv, log, paramTarget=decay): scales the tail decay symmetrically.
//   level (cv, linear, paramTarget=level): displaces the output level.
//
// Outputs:
//   L (audio): left channel of the stereo-decorrelated meow.
//   R (audio): right channel.
//
// Params:
//   pitch (linear -36..36 semi, default 0): transposition added on top of pitch CV.
//   morph (linear 0..1, default 0.25): the five-anchor macro (kitten/adult/purr/yowl/hiss).
//   decay (log 0.05..2 s, default 0.4): tail decay time, MULTIPLIED by the anchor's own scale.
//   level (linear 0..2, default 1): output level.
//
// ⚠ `gate` IS A GATE, NOT A TRIGGER, and the def said the opposite until
// 2026-08-08. `ampEnv = en.adsr(0.005, 0.05, 0.4, …)` (meowbox.dsp:109) SUSTAINS
// AT 0.4 while the gate is non-zero, so the meow's length is gate-high time PLUS
// the release — it is level-sensitive on both edges. Nothing caught it because
// the port declared no `edge:` at all and module-docs-lint's vocabulary check
// does `if (!p.edge) continue` — the one gate that owns this vocabulary was
// structurally unable to see the module whose prose was wrong about it. Declared
// now, which is a contract-lock move. (Faust's `adsr` additionally runs its
// attack at `atime = +(gate) ~ *(gate' >= gate)`, so a gate held at 0.5 runs the
// attack and decay at HALF SPEED and releases only at exactly 0 — the repo's
// GATE_HI = 0.5 threshold is never applied inside the DSP.)
//
// ⚠ THE AUDITION IS A HELD PAD, for that same reason. `meowbox-meow-{n}` is a
// `mode: 'gate'` action on BOTH surfaces (the card pad and the shell cell),
// driving the factory's `manualGate` read key — never `manualTrigger`. The shared
// TRIGGER_PULSE_S is 5 ms, which would release the envelope 5 ms into a 400 ms
// tail and audition a blip rather than a meow.

import { instantiateFaustModule } from '$lib/audio/faust-runtime';
import { closeGate, openGate } from '$lib/audio/gate-trigger';
import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import wasmUrl from '@patchtogether.live/dsp/dist/meowbox.wasm?url';
import metaUrl from '@patchtogether.live/dsp/dist/meowbox.json?url';
import workletUrl from '@patchtogether.live/dsp/dist/meowbox.worklet.js?url';

const PARAM_PREFIX = '/MEOWBOX';

/** Base frequency at 0V/oct + 0-semi knob = C4 = 261.6256 Hz.
 *  Matches the constant in packages/dsp/src/meowbox.dsp. */
export const MEOWBOX_C4_HZ = 261.6256;

/** Pure mirror of the DSP's `baseFreq(pVolt, pSemi)` formula:
 *
 *    freqHz = 261.6256 × 2^(pVolt + pSemi / 12)
 *
 *  Exposed for unit testing and for any UI/preset code that needs to
 *  predict the rendered fundamental from a (V/oct CV, transposition knob)
 *  pair. Mirrors the analog-vco convention.
 */
export function meowboxBaseFreqHz(pitchVolts: number, pitchSemis = 0): number {
  return MEOWBOX_C4_HZ * Math.pow(2, pitchVolts + pitchSemis / 12);
}

export const meowboxDef: AudioModuleDef = {
  type: 'meowbox',
  palette: { top: 'Audio modules', sub: 'VCOs' },
  domain: 'audio',
  label: 'meowbox',
  category: 'sources',
  // The `pitch` input port type changed from 'cv' (semis-as-AudioParam) to
  // 'pitch' (V/oct audio-rate); no persisted-data shape change, so no migration
  // callback (or version bump) is needed.
  inputs: [
    // edge:'gate' — LEVEL-sensitive, both edges. See the header: the amp
    // envelope sustains at 0.4 while this is high, so this is not a trigger and
    // the module's own docs claimed it was.
    { id: 'gate',  type: 'gate', edge: 'gate' },
    // `pitch` is a true 1V/octave audio-rate input (PR fix/meowbox-voct):
    // the DSP consumes the volts directly from a merger channel — NOT
    // routed via the CV→AudioParam fast path. cvScale therefore does
    // not apply (the cv-scale registry treats `pitch` typed inputs as
    // out-of-scope; the DSP's exp2 mapping is the V/oct standard).
    //
    // morph / decay / level remain CV→AudioParam — cvScale per
    // docs/adr/004-cv-range-convention.md so an LFO at ±1 sweeps the
    // full natural range:
    //   morph: linear (0..1).
    //   decay: log    (0.05..2s).
    //   level: linear (0..2).
    { id: 'pitch', type: 'pitch' },
    { id: 'morph', type: 'cv',    paramTarget: 'morph', cvScale: { mode: 'linear' } },
    { id: 'decay', type: 'cv',    paramTarget: 'decay', cvScale: { mode: 'log' } },
    { id: 'level', type: 'cv',    paramTarget: 'level', cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'L', type: 'audio' },
    { id: 'R', type: 'audio' },
  ],
  params: [
    // The pitch knob is a transposition in semitones, added on top of the
    // V/oct pitch CV inside the DSP's baseFreq. A patch with no `pitch` cable
    // (CV silent at 0V) and pitch knob = 0 ⇒ 0V + 0 semis = C4 (261.63 Hz),
    // matching the old default behavior.
    { id: 'pitch', label: 'Ptch',  defaultValue: 0,    min: -36,   max: 36,  curve: 'linear', units: 'semi' },
    { id: 'morph', label: 'Morph', defaultValue: 0.25, min: 0,     max: 1,   curve: 'linear' },
    { id: 'decay', label: 'Dcy',   defaultValue: 0.4,  min: 0.05,  max: 2,   curve: 'log',    units: 's' },
    { id: 'level', label: 'Lvl',   defaultValue: 1,    min: 0,     max: 2,   curve: 'linear' },
  ],

  // THE ONE NON-PARAM CONTROL — the audition. A `mode:'gate'` pad, not a
  // one-shot (see the header). It is a control FAMILY rather than a fifth
  // ParamDef because it writes NOTHING to the graph: it drives a host-side
  // ConstantSource summed into the same merger channel a cable feeds, so a real
  // gate keeps working alongside it and nothing is persisted, synced or undoable.
  // A `strike` param would additionally need a row in the Faust DSP's parameter
  // list, which is a re-pin of three ART scenarios for a control that is not
  // part of the patch.
  controlFamilies: [
    { id: 'meowbox-meow', label: 'Meow — hold to audition the voice', kind: 'other', testidPrefix: 'meowbox-meow' },
  ],

  // ── FACE — RACKLINE UI curation (PF-20). UI metadata, NOT the I/O contract
  // (see ModuleFace in $lib/graph/types).
  //
  // WHAT THIS MODULE IS. Four table-lookup sines at F·2F·3F·4F crossfaded
  // against white noise, through three parallel resonant band-passes, under one
  // ADSR. FOUR knobs — and one of them indexes THIRTEEN five-entry tables
  // (meowbox.dsp:29-63), so MORPH alone moves all three formant frequencies, all
  // three Qs, all three weights, the voiced/noise balance, the pitch contour's
  // rise AND fall, and the decay scale. The legacy card presents that fader and
  // an output trim as peers in one knob row.
  //
  // THREE OF THOSE THIRTEEN CHANGE NUMBERS THE OTHER KNOBS ARE LABELLED WITH,
  // which is what the hero strip is for and why not one of its three readouts is
  // a knob read back:
  //   * the note SETTLES 1.80 semitones SHARP of what PITCH asks for at the
  //     shipped default, and stays there while the gate is held, because
  //     `en.are` sustains at 1.0. PITCH reads 0 throughout.
  //   * the DECAY dial is MULTIPLIED by `decayScaleOf(morph)` (0.6× at hiss,
  //     2.0× at yowl) before it reaches the envelope, so its seconds are the
  //     truth at exactly ONE morph position out of a continuum.
  //   * a formant's effective peak is `aN·qN`, not `aN` — and `A1` is 1.0 across
  //     the whole of morph 0..0.75, so the amplitude table sits FLAT across a
  //     move that changes band 1 by +7.36 dB.
  // Each is negative-controlled, permanently, in meowbox-face-model.test.ts.
  //
  // ⚠ NO `hero.cell`, AND THE REASON IS ARITHMETIC RATHER THAN TASTE.
  // `module-face-lint` refuses a PANEL cell SELECTED at a lane tier, and the
  // 'full' lane cap is SIX (LANE_PLATE_MAX_CELLS). meowbox has FOUR params; with
  // the audition at rank 5 a picture can only reach rank 6, which is inside the
  // plate. A panel's first legal rank is 7 and there is no sixth rankable key.
  // drummergirl hit this exact wall and deferred its picture AND its audition
  // together. The way past it: a `sidebar` `custom` block carries no
  // `face.order` key and therefore no rank at all — so the picture ships as
  // `formant-bank` in the sidebar, and the audition ships here.
  //
  // glyph 'scope' STAYS, and the audition is what makes it honest. This voice is
  // SILENT with nothing patched — `g = 0` ⇒ `ampEnv = 0` ⇒ both channels are
  // bit-zero — so before the pad every screenshot of it was a flat line.
  face: {
    order: [
      // ── the lane budget: ranks 1–4 are the four knobs, in the order a player
      //    reaches for them on a VOICE. ──
      'morph',   // 1 — the only timbre control, and it drives thirteen tables.
      'pitch',   // 2 — the register. ±36 st, summed with the V/oct volts.
      'decay',   // 3 — the tail. Scaled by MORPH; see above.
      'level',   // 4 — the trim. L only; R inherits it through the delay.
      // rank 5: THE AUDITION, and it is deliberately LAST. Rank only decides the
      // mini (1 cell) and compact (2 beside the glyph) tiles, and a momentary pad
      // in a 46 px knob column is a bare glyph — the clap/sixstrum argument. At 5
      // it never reaches either, while still always painting on the 6-cell plate,
      // where this module has two slots spare.
      'meowbox-meow-{n}',
    ],

    // TWO BANDS. ⚠ BOTH PROMOTED KEYS ARE DECLARED IN BAND 1 AND THEY MUST BE:
    // `face.hero` MOVES a key, it does not copy one, and heroFacePlan can only
    // move a key some band already claims. Band 1 renders ['pitch'] after the
    // split — NOT empty, which matters: a band the promotion empties is DROPPED,
    // taking its hint with it, and then fails the annotation-reachability clause
    // (the drummergirl scar).
    //
    // ⚠ AND THAT IS WHY BAND 1 IS NAMED FOR WHAT THE VOICE IS MADE OF rather
    // than for MORPH. Every label here is audited with its hint HIDDEN, because
    // that is the resting state — and a band labelled "the five anchors" whose
    // only surviving control is PITCH would read as a mistake. Named this way,
    // the survivor is exactly what the label describes: PITCH is the F that the
    // four partials are built on.
    pages: [
      {
        id: 'source',
        label: '1 · four sines and a noise bed',
        hint:
          'the excitation is F · 2F · 3F · 4F at 1 / 0.5 / 0.25 / 0.125, crossfaded against white ' +
          'noise by the anchor’s VOICED value — 85 percent voiced at kitten and adult, 15 percent at ' +
          'hiss. MORPH decides both that blend and the three formants that filter it; PITCH is the F ' +
          'the partials are built on, but the contour settles SHARP of it by an amount MORPH sets.',
        controls: ['meowbox-meow-{n}', 'morph', 'pitch'],
      },
      {
        id: 'tail',
        label: '2 · the tail, and what scales it',
        hint:
          'DECAY is MULTIPLIED by the anchor’s own decay scale before it reaches the envelope — 0.6× ' +
          'at hiss, 2.0× at yowl — so the dial’s seconds are the truth at exactly one MORPH position. ' +
          'LEVEL scales the LEFT channel only; the right inherits it through the delay.',
        controls: ['decay', 'level'],
      },
    ],
    glyph: 'scope',

    // ⚠ `title` AND `hint` ARE BOTH ANNOTATION AND BOTH GATED — `facePageHeader`
    // returns null with the switch off, title included (owner decision
    // 2026-08-03). At rest this faceplate paints its NAME, its two band labels
    // and its numbers, and nothing else.
    title: 'Voice',
    hint:
      'Four harmonic sines and a noise bed through three resonant band-passes, under one ADSR that ' +
      'SUSTAINS while the gate is held. MORPH is not a tone knob — it crossfades five cat anchors ' +
      '(kitten, adult, purr, yowl, hiss), moving all three formant frequencies, all three Qs, their ' +
      'weights, the voiced/noise balance, the pitch contour AND the decay scale together.',

    // THE HERO. MORPH is PROMOTED out of band 1, not copied, and it leads
    // because it IS the module. The pad rides beside it because this voice makes
    // no sound at all until something gates it.
    //
    // ⚠ ALL THREE READOUTS ARE `valueId`, NOT `paramId`, and that is the whole
    // point. `settles` would read `0 st` off the PITCH knob while the voice holds
    // 290.29 Hz against a notated 261.63; `tail` would read `0.40 s` off the
    // DECAY knob at every morph position, while the real tail runs 240 ms at hiss
    // and 800 ms at yowl; and `formants` has no knob to read at all — MORPH's own
    // readback is `0.25`, which cannot express that 0.375 puts you at
    // 315 · 825 · 1750 Hz, a triple in no anchor row.
    hero: {
      control: 'morph',
      action: 'meowbox-meow-{n}',
    },

    // REAR CARD curation. The three per-knob CVs need none — each one's
    // paramTarget files it under its own face page. GATE and PITCH have no
    // paramTarget (they are raw merger channels), so they are named here, and
    // both carry the `~` tick because both genuinely are audio-rate.
    rear: {
      groups: [{ id: 'voice', label: 'play', ports: ['gate', 'pitch'] }],
      audioRate: ['gate', 'pitch'],
    },
  },

  docs: {
    explanation:
      "A gate-held cat-vocal synth voice: hold a gate and it sings one 'meow' at the patched pitch. Under the hood it's a formant synth — four harmonic sines (F, 2F, 3F, 4F) crossfaded against white noise, pushed through three parallel resonant band-passes, with the right channel a short delayed copy of the left so the result spreads across the L/R outputs. MORPH crossfades FIVE CAT ANCHORS — kitten, adult meow, purr, yowl, hiss — and it is far more than a tone control: one fader moves all three formant frequencies, all three resonances, their three weights, the voiced/noise balance, the pitch contour and the decay scale together, interpolating linearly between whichever two anchors you are between. Decay sets the release, but the anchor multiplies it (0.6x at hiss, 2.0x at yowl), so the same dial is a different number of seconds at every morph position. Pitch tracks a true 1V/oct input so you can play it from a keyboard or sequencer like any other oscillator, with the Pitch knob acting as a transposition on top — though the voice's own contour settles slightly SHARP of the note you ask for, by an amount MORPH decides.",
    inputs: {
      gate: "The GATE, and it is level-sensitive on BOTH edges: the amplitude envelope attacks, decays to a sustain of 0.4 and HOLDS there for as long as you keep the level up, then releases when it falls. So the meow's length is how long you hold it PLUS the Decay tail — not Decay alone. (A short trigger pulse works too and gives a clipped chirp; it is the same envelope, released early.) Patch a sequencer gate, a keyboard gate or a clock here — or hold the card's MEOW pad, which drives the same input.",
      pitch: "A true 1V/oct pitch input (0 V = middle C). The DSP reads the volts directly and the Pitch knob is added on top as a transposition, so patch a sequencer or keyboard pitch CV here to play melodies; with nothing patched it sits at C4.",
      morph: "CV that adds to the Morph control, walking the voice between the five cat anchors in real time — so an envelope here can start a note as a yowl and land it as a purr. Remember what it moves: the formants, their resonances, the noise balance, the pitch contour AND the decay scale, all at once.",
      decay: "CV that scales the tail Decay time (logarithmic), for shorter chirps or longer wails. It scales the knob, which the current anchor then multiplies again.",
      level: "CV that adds to the output Level for per-hit dynamics.",
    },
    outputs: {
      L: "Left channel. LEVEL is applied here, and the right channel is taken FROM this one — so L is the whole voice and R is its delayed copy.",
      R: "Right channel: L put through a short delay line, 0 to 0.6 ms, moving INVERSELY to the amplitude envelope so the pair spreads apart as the note dies. It is not a second voice. That matters if you sum to mono — the two channels comb, with the first null at 833 Hz when the envelope is at rest and 1.4 kHz while it sustains, which is straight through the formant region. Keep them split unless you want that.",
    },
    controls: {
      pitch: "Transposes the voice in semitones (-36 to +36), summed on top of the 1V/oct pitch input — use it to set the cat's register or to offset an incoming melody. Note that the voice's own contour starts flat and settles SHARP of what you set: at the shipped morph it holds 1.8 semitones above the note.",
      morph: "The five-anchor macro (0..1): kitten at 0, adult meow at 0.25, purr at 0.5, yowl at 0.75, hiss at 1, linearly interpolated in Hz between neighbours. It is the only timbre control on the module and it moves thirteen things at once — the three formant frequencies, the three resonances, the three weights, the voiced/noise balance, the pitch contour's rise and fall, and the multiplier on Decay. Anywhere except exactly on an anchor you are hearing a crossfade of two of them.",
      decay: "Tail decay time (0.05-2 s, log-tapered) — but the current anchor MULTIPLIES it before it reaches the envelope, 0.6x at hiss up to 2.0x at yowl. At the shipped morph the multiplier is exactly 1, which is the only position where the dial's seconds are the real tail. Short for a clipped chirp, long for a drawn-out wail; the full reachable span is 30 ms to 4 s.",
      level: "Output level from silence to 2x, applied to the LEFT channel; the right inherits it through the delay. The Level CV input adds to this.",
      'meowbox-meow-{n}': "MEOW — the audition. HOLD it to gate the voice exactly as a patched cable would, release to let it go. It is a held pad and not a one-shot on purpose: the amplitude envelope sustains while the gate is high, so a click would release it milliseconds in and you would hear a blip instead of a meow. It writes nothing to the patch — nothing is saved, synced or undoable — and a real gate cable keeps working alongside it.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const f = await instantiateFaustModule(ctx, { name: 'meowbox', wasmUrl, metaUrl, workletUrl }, node);
    // Two audio-rate inputs: channel 0 = gate, channel 1 = pitch (V/oct).
    // Mirrors analog-vco's pattern. The merger feeds Faust's multi-channel
    // input so a sequencer's pitch CV writes to the pitch channel only,
    // without bleeding into gate.
    const merger = ctx.createChannelMerger(2);
    merger.connect(f);
    // Feed silence to every merger input so the worklet stays in the active
    // processing graph even when nothing's externally patched.
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    silence.connect(merger, 0, 0);
    silence.connect(merger, 0, 1);

    // THE AUDITION (the MEOW pad on both faces). A DEDICATED ConstantSource
    // summed into merger channel 0 — the same channel the `gate` jack feeds — so
    // Web Audio adds them and the DSP cannot tell the pad from a cable. It
    // writes NOTHING to the graph: no param, nothing persisted, nothing synced,
    // nothing on the undo stack.
    //
    // ⚠ A SEPARATE SOURCE FROM `silence`, deliberately. `silence` is the
    // keep-alive that holds BOTH channels in the processing graph; driving its
    // offset would also drive the PITCH channel, transposing the voice by one
    // volt every time you auditioned it.
    //
    // The HIGH level comes from the shared $lib/audio/gate-trigger seam, never
    // re-derived here, so the pad's level is the repo's and not this module's.
    const meowCs = ctx.createConstantSource();
    meowCs.offset.value = 0;
    meowCs.start();
    meowCs.connect(merger, 0, 0);

    const splitter = ctx.createChannelSplitter(2);
    f.connect(splitter);

    const params = f.parameters as unknown as Map<string, AudioParam>;
    for (const def of meowboxDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(`${PARAM_PREFIX}/${def.id}`)?.setValueAtTime(v, ctx.currentTime);
    }
    const pMorph = params.get(`${PARAM_PREFIX}/morph`);
    const pDecay = params.get(`${PARAM_PREFIX}/decay`);
    const pLevel = params.get(`${PARAM_PREFIX}/level`);

    return {
      domain: 'audio',
      inputs: new Map([
        ['gate',  { node: merger, input: 0 }],
        ['pitch', { node: merger, input: 1 }],
        ['morph', { node: f, input: 0, param: pMorph! }],
        ['decay', { node: f, input: 0, param: pDecay! }],
        ['level', { node: f, input: 0, param: pLevel! }],
      ]),
      outputs: new Map([
        ['L', { node: splitter, output: 0 }],
        ['R', { node: splitter, output: 1 }],
      ]),
      setParam(paramId, value) {
        params.get(`${PARAM_PREFIX}/${paramId}`)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(`${PARAM_PREFIX}/${paramId}`)?.value;
      },
      // The AUDITION seam — the karplus/snaredrum `read(key)` idiom.
      //
      // ⚠ `manualGate` ONLY, and the OMISSION of `manualTrigger` is load-bearing.
      // `resolveManualStrike` and `resolveManualGate` are two separate read keys
      // precisely so a handle that implements one does not silently answer the
      // other (manual-strike-actions.ts). meowbox's envelope sustains at 0.4
      // while the gate is high, so the one-shot shape is WRONG for it: the
      // shared 5 ms trigger pulse would release the envelope 5 ms into a 400 ms
      // tail. A caller asking for `manualTrigger` here gets `undefined` and the
      // ledger records `delivered: false`, which is the honest answer.
      read(key: string): unknown {
        if (key === 'manualGate') {
          return (high: boolean) => {
            try {
              if (high) openGate(meowCs, ctx.currentTime);
              else closeGate(meowCs, ctx.currentTime);
            } catch { /* the context went away with the node */ }
          };
        }
        return undefined;
      },
      dispose() {
        // ⚠ CLOSE THE GATE BEFORE STOPPING ITS SOURCE. A node deleted mid-hold
        // is one of the release edges the pad itself can never see (its <Button>
        // unmounts with the pane), and a gate left open is a cat that never stops
        // — see ui/modules/manual-gate-latch.ts.
        try { closeGate(meowCs, ctx.currentTime); } catch { /* */ }
        try { silence.stop(); } catch { /* */ }
        try { meowCs.stop(); } catch { /* */ }
        silence.disconnect();
        meowCs.disconnect();
        merger.disconnect();
        splitter.disconnect();
        f.disconnect();
      },
    };
  },
};
