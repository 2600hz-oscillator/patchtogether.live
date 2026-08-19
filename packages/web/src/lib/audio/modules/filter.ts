// packages/web/src/lib/audio/modules/filter.ts
//
// FILTER — multi-mode resonant state-variable filter (LP / HP / BP).
//
// The bread-and-butter subtractive-synthesis filter. Faust-compiled DSP
// (packages/dsp/src/filter.dsp): three `fi.reson{lp,hp,bp}` 2-pole
// (12 dB/oct) sections run CONTINUOUSLY on the same input and `ba.selectn`
// picks one by the `mode` param — the Faust source's branch order is
// (lp, hp, bp), so mode 0 = LP, 1 = HP, 2 = BP (the card's MODES array
// agrees; the pre-2026-07 doc comment claiming 1 = BP / 2 = HP was wrong).
//
// CV inputs are routed through a ChannelMerger onto the Faust node's
// per-sample CV channels (rather than via the AudioParam fast path), so the
// Faust source's own mapping is what defines the sweep shape: cutoff CV is
// ±5 octaves around the knob, resonance CV is additive. BOTH derived values
// then pass through `si.smoo` — Faust's ~7 Hz one-pole UI smoother — so the
// CV path tracks at ENVELOPE / LFO rate, not audio rate. This is a clean
// utility VCF, NOT an FM filter: audio-rate signals patched into `cutoff`
// are filtered away rather than heard as sidebands.
//
// The two CV depths (`cutoff_cv_amt` / `res_cv_amt`) are ATTENUVERTERS in
// the engine graph, not DSP: each CV jack lands on a GainNode before the
// merger, so the depth knob scales (and, negative, inverts) the CV the Faust
// source sees. At the default +1 they are exact identities — a gain of 1.0
// is a bit-for-bit passthrough — so this is behaviour-neutral for every
// existing patch. Without them a plain 0..1 envelope drives the full +5
// octaves and pins the cutoff at the 20 kHz ceiling, which is why the module
// previously needed an external attenuator for the most common patch in the
// rack (EG → cutoff).
//
// Inputs:
//   audio (audio): signal to be filtered.
//   cutoff (cv, paramTarget=cutoff): cutoff CV. ±1 = ±5 octaves around the
//     cutoff knob, scaled first by `cutoff_cv_amt` (Faust-side exponential
//     mapping; engine-side cvScale is omitted on purpose).
//   res (cv): resonance CV; scaled by `res_cv_amt`, then summed into the
//     resonance value and clamped to 0..0.99.
//
// Outputs:
//   audio (audio): filtered output.
//
// Params:
//   cutoff (log 20..20000 Hz, default 1000): corner / centre frequency.
//   resonance (linear 0..0.99, default 0.1): emphasis; mapped to Q = res·20 + 0.7.
//   mode (discrete 0..2, default 0): 0=LP, 1=HP, 2=BP.
//   cutoff_cv_amt (linear -1..1, default 1): attenuverter on the cutoff CV jack.
//   res_cv_amt (linear -1..1, default 1): attenuverter on the res CV jack.

import { instantiateFaustModule } from '$lib/audio/faust-runtime';
import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import wasmUrl from '@patchtogether.live/dsp/dist/filter.wasm?url';
import metaUrl from '@patchtogether.live/dsp/dist/filter.json?url';
import workletUrl from '@patchtogether.live/dsp/dist/filter.worklet.js?url';

const PARAM_PREFIX = '/Filter';

export const filterDef: AudioModuleDef = {
  type: 'filter',
  palette: { top: 'Audio modules', sub: 'Effects' },
  domain: 'audio',
  label: 'filter',
  category: 'filters',
  inputs: [
    { id: 'audio',  type: 'audio' },
    // CV inputs are routed through the channel merger (channels 1, 2)
    // so they sum into the Faust DSP's per-sample CV input — they are
    // NOT AudioParam-routed. paramTarget is declared so the docs
    // manifest renders "CV -> cutoff param." consistently with every
    // other CV input in the codebase. The runtime ignores paramTarget
    // on this module (the engine looks at the factory's inputs map,
    // where these ports are wired to the attenuverter gains).
    //
    // We intentionally do NOT request cvScale here because:
    //   1. These ports route through the merger as audio-rate signals,
    //      not via the CV→AudioParam fast path. The cv-scale registry
    //      treats this as PASSTHROUGH_BY_DESIGN.
    //   2. The Faust source already maps -1..+1 onto the param's full
    //      musical range (cutoff: ±5 octaves around knob; res additive),
    //      which is exactly the standard's intent — and `cutoff_cv_amt` /
    //      `res_cv_amt` are the user-facing depth trim on top of it.
    //
    // NOTE: port id 'res' is intentionally short for the panel; the
    // matching param is 'resonance'. `paramTarget` is deliberately left
    // off: the rear-card + patch-panel label tables already resolve the
    // stem `res` to the verbose 'RESONANCE', which reads better than the
    // 'RES' a paramTarget lookup would produce, and CV routing does not
    // depend on it (the merger wiring in the factory is what routes).
    { id: 'cutoff', type: 'cv', paramTarget: 'cutoff' },
    { id: 'res',    type: 'cv' },
  ],
  // `label: 'out'` — the rear card printed AUDIO on BOTH holes. `ModuleShell`
  // calls `portsFromDef(def.outputs)` with no override map (the legacy card
  // passes `{ audio: 'OUT' }`), so with no `PortDef.label` the stem falls to
  // `ABBREV_TO_VERBOSE.audio = 'AUDIO'` and the rear named the input and the
  // output identically, disambiguated only by rail side. CONTRACT-TRANSPARENT:
  // `portLine` (contract-signature.ts) has no label branch.
  outputs: [{ id: 'audio', type: 'audio', label: 'out' }],
  params: [
    { id: 'cutoff',        label: 'Cutoff',    defaultValue: 1000, min: 20,   max: 20000, curve: 'log',      units: 'Hz' },
    { id: 'resonance',     label: 'Res',       defaultValue: 0.1,  min: 0,    max: 0.99,  curve: 'linear' },
    // `options` NAMES the three states (PF-1). The legacy FilterCard painted
    // them as three labelled buttons in its own markup, which the migrated
    // shell could not see — so the one control that decides whether CUTOFF
    // makes the sound DARK, THIN or NARROW arrived on the faceplate as a
    // rotary printing "0.00", and the player had to know that 2 meant
    // bandpass. UI vocabulary only: `contract-signature.ts` projects
    // id/min/max/curve/default/units and nothing else, so naming a value moves
    // no contract line (same class as the `label` note above). The DSP mapping
    // is unchanged and still pinned by `min`/`max`/`curve`.
    //
    // `options`, NOT `landmarks`: these are three PARALLEL two-pole sections
    // and the mode control picks which one you hear — switching is
    // instantaneous and un-crossfaded, so there is genuinely nothing between
    // LP and HP. (Contrast lfo `shape` / qbrt `mode`, both `curve: 'linear'`
    // over a range whose in-between values are real blends: those are
    // `landmarks`. The vocabulary gate enforces the split off `curve`.)
    { id: 'mode',          label: 'Mode',      defaultValue: 0,    min: 0,    max: 2,     curve: 'discrete',
      // ⚠ HP AND BP ARE **NOT** 12 dB/oct, and these two strings used to say
      // they were — contradicting `docs.controls.mode` thirty lines below,
      // which had it right. All three sections are genuinely TWO-POLE; what
      // does not follow is a 12 dB/oct stopband. `fi.resonhp` is defined as
      // `gain*x - resonlp(x)`, which puts a SECOND numerator zero at f = fc/Q,
      // so the highpass's deep stopband tapers at 6 dB/oct — and at
      // resonance 0 (Q 0.70) that break sits at 1.43×fc, ABOVE the corner, so a
      // zero-resonance highpass is 6 dB/oct across its whole audible stopband.
      // `fi.resonbp` has a single `s` numerator ⇒ 6 dB/oct skirts both sides.
      // A player expecting −12 removes half the bass they asked for and
      // reaches for a second filter. The arithmetic is pinned in
      // `filter-face-model.test.ts` ("the PHYSICS the shipped tooltips got
      // wrong"), because a tooltip is asserted nowhere and can drift back.
      options: [
        { value: 0, label: 'LP', title: 'Lowpass — keeps the lows, rolls off above cutoff at 12 dB/oct' },
        { value: 1, label: 'HP', title: 'Highpass — keeps the highs; built as input-minus-lowpass, so the deep stopband tapers at 6 dB/oct' },
        { value: 2, label: 'BP', title: 'Bandpass — keeps only a slice around cutoff, 6 dB/oct skirts both sides' },
      ] },
    { id: 'cutoff_cv_amt', label: 'Cutoff CV', defaultValue: 1,    min: -1,   max: 1,     curve: 'linear' },
    { id: 'res_cv_amt',    label: 'Res CV',    defaultValue: 1,    min: -1,   max: 1,     curve: 'linear' },
  ],

  // RACKLINE curation (P1 batch-3 total rework). The design question for a VCF
  // is "what does a player's hand do?": it SWEEPS cutoff, RIDES resonance,
  // SETS the type once, and TRIMS how far a patched envelope/LFO throws the
  // sweep. That is the whole module, and it is exactly this ranking.
  //
  //   1 cutoff       — the hero. Mini tier shows this alone; nothing else on a
  //                    filter earns the single-knob slot.
  //   2 resonance    — the second hand. Compact = cutoff + res + the live trace.
  //   3 mode         — ranked ABOVE the CV depths deliberately: it re-frames
  //                    what the cutoff knob MEANS (dark vs. thin vs. narrow),
  //                    so a glance at a lane tile should answer it. It is a
  //                    set-once switch, not a performance control, which is why
  //                    it is not higher.
  //   4 cutoff_cv_amt / 5 res_cv_amt — kept ADJACENT on purpose: they read as
  //                    one modulation stage, and splitting the pair to push one
  //                    of them up the ranking would cost more than it buys.
  //
  // vs. the legacy card: it showed cutoff + res as FADERS and mode as a
  // three-button footer strip, with NO way to trim CV depth at all — a 0..1
  // envelope patched into `cutoff` asks for +5 octaves and pins at the 20 kHz
  // ceiling. The rework re-ranks mode UP next to the two knobs it re-frames
  // and adds the two missing attenuverters (engine-side gains, no new DSP).
  // Nothing from the legacy card was dropped: all three legacy controls are
  // ranked, paged, and rendered in the dock (faces-parity pins that).
  face: {
    order: ['cutoff', 'resonance', 'mode', 'cutoff_cv_amt', 'res_cv_amt'],
    // TWO dock bands, not three, on GROUPING SEMANTICS: `response · type` is
    // what the filter does to a signal and `cv depth` is how hard a patched
    // modulator pushes it — two ideas, two bands, and `mode` belongs with the
    // two knobs it re-frames rather than alone. (This comment used to defend
    // the split partly on a 720p fold measurement. The measurement was honest
    // but it is not a design argument, and it is now moot twice over: PF-21
    // packs consecutive bands onto one row, and the dock VRT scene unfolds the
    // pane before it captures. Grouping is the whole reason.)
    pages: [
      {
        id: 'response',
        label: 'response · type',
        // ⚠ PAGE IDS MUST NEVER BECOME 'signal' OR 'voice'. `rearFieldPlan`
        // gives a curated rear group with either id the LEADING band slot
        // unconditionally, so a page id colliding with it renders that band
        // TWICE (the dx7 scar). `rear.groups[0].id` here is 'signal'. The
        // 'modulation' collision with the NON-leading rear group is the
        // INTENDED claim path and is safe. Nothing enforces this.
        hint:
          'three two-pole sections run in parallel on the input and MODE picks one — the switch is ' +
          'instantaneous and un-crossfaded, so it can click under a loud signal. RES maps to ' +
          'Q = res × 20 + 0.7 and is NOT gain-compensated: the peak adds up to +26 dB on top of an ' +
          'unchanged passband. It rings; it never self-oscillates.',
        controls: ['cutoff', 'resonance', 'mode'],
      },
      {
        id: 'modulation',
        label: 'cv depth',
        hint:
          'attenuverters on the two CV jacks — and they are ENGINE gains on the jacks themselves, so ' +
          'with nothing patched both knobs do nothing at all. Full scale on CUTOFF CV is ±5 octaves; ' +
          'negative inverts. Both paths are smoothed at 7 Hz, so these are modulation inputs, not FM.',
        controls: ['cutoff_cv_amt', 'res_cv_amt'],
      },
    ],
    // 'scope' → glyphBinding 'live-audio' (a primary `audio` output exists):
    // the analyser trace on the filter's own output. For a filter this is the
    // one glyph that shows the module DOING its job — you watch the harmonics
    // get shaved off as cutoff drops and the resonant ring appear as res comes
    // up. A meter would only report level, which a filter barely changes.
    glyph: 'scope',
    // REAR CARD curation. One real exception the derivation cannot see: the
    // `res` port carries neither a `paramTarget` nor a `<param>_cv` id (its
    // stem 'res' ≠ the param id 'resonance' — the tidyVco pwm_cv/pw class), so
    // derivation files it into the leading voice band NEXT TO THE AUDIO INPUT,
    // which is exactly the wrong story. Both CV holes are therefore pinned to
    // the 'cv depth' band — the band whose two knobs set how hard each jack
    // pushes — leaving the signal band as the single audio hole it should be.
    //
    // Deliberately NO `audioRate` entries. Both CV values run through Faust's
    // `si.smoo` (= `si.smooth(1 - 44.1/SR)`, the documented ~7 Hz one-pole),
    // so neither jack is FM-able; a `~` tick would be a lie about the one
    // thing the tick exists to say.
    rear: {
      groups: [
        { id: 'signal',     label: 'audio in', ports: ['audio'] },
        { id: 'modulation', label: 'cv depth', ports: ['cutoff', 'res'] },
      ],
    },

    // ── PF-20 — THE FACEPLATE STRUCTURE ─────────────────────────────────────
    // DECLARATION ONLY. No param, no port, no ControlFamily: `face` is never
    // projected by contract-signature.ts, and the response picture is a
    // SIDEBAR panel precisely so it costs no family line. The contract golden
    // does not move by a single line for any of this.

    // ⚠ BOTH OF THESE ARE ANNOTATION-ONLY and neither paints at rest —
    // `facePageHeader` returns null before it reads anything unless the dock's
    // annotate switch is on (dock-faceplate-model.ts, owner 2026-08-02: two
    // names on one panel was the complaint). So NOTHING LOAD-BEARING IS PARKED
    // HERE. The one fact a player genuinely needs — that both CV depth knobs
    // are dead until a cable lands — lives in the readout strip below, where
    // `cv reach` collapses to `1.0 kHz · muted` the moment depth hits 0.
    title: 'Filter',
    hint:
      'A two-pole resonant filter in three characters. CUTOFF is the corner (LP/HP) or the centre ' +
      '(BP); RES lifts a peak of up to +26 dB on top of an unchanged passband and never ' +
      'self-oscillates. It is an INSERT — it makes no sound of its own.',

    // THE HERO. CUTOFF is PROMOTED out of band 1, not copied (heroFacePlan
    // removes it, so the param multiset faces-parity asserts is unchanged),
    // because it is the one knob a hand rides and the only value a player
    // wants readable across a room.
    //
    // NO `hero.cell`, and the reason is structural rather than aesthetic: a
    // hero picture is a PF-14 PANEL cell, `module-face-lint` refuses a panel
    // SELECTED at a lane tier, and with five params a sixth ranked key lands
    // at rank 6 — inside `faceTierCap('full') = 6`. So a hero picture on this
    // module fails the lint outright, and inventing a seventh control to make
    // room for it would be adding a control for a rank constraint. The picture
    // is a `custom` SIDEBAR panel instead (below): same drawing, zero contract
    // lines, no operability probe — and it does not suppress the `scope` glyph
    // the way a `hero.cell` would.
    //
    // NO `hero.action`: DECLARED ABSENT, not forgotten. A filter is an insert;
    // there is nothing to audition without an input, and synthesising a test
    // signal would be a DSP change in a face wave.
    //
    // ⚠ THE STRIP IS THREE GENUINELY DERIVED VALUES — none of them is a knob on
    // this panel. `cutoff` prints its own value on the hero dial, `resonance`
    // and `mode` are cells in band 1, and each entry below is negative-
    // controlled on an input its nearest dial is BLIND to
    // (filter-face-model.test.ts):
    //   `peak`      MODE moves it 5.2 dB at resonance 0 (0.0 / +2.1 / −3.1)
    //               while a `resonance` readback prints 0.00 for all three.
    //   `cv reach`  models the 20 kHz CLAMP: same depth of 1.00, and moving
    //               CUTOFF collapses the reachable span 9.32 → 6.32 octaves.
    //   `res reach` prints `· muted` at depth 0, which is the honest thing to
    //               say about a knob whose jack is doing nothing.
    //
    // A `Q` READOUT IS DELIBERATELY REFUSED. Q = 20·res + 0.7 is invariant to
    // everything except `resonance`, so no perturbation moves it while a
    // `resonance` readback stays put — it is a unit conversion, not a
    // derivation, and it does not meet this registry's bar. The Q law is on
    // the band-1 annotation and on the sidebar plot's legend instead.
    hero: {
      control: 'cutoff',
    },

  },

  docs: {
    explanation:
      "The bread-and-butter subtractive-synthesis filter: patch it between an oscillator and a VCA, sweep the cutoff, and a bright harmonic-rich tone turns into a musical gesture. Three characters share one panel — LOWPASS (mode 0) keeps the lows and rolls off above cutoff, HIGHPASS (mode 1) does the reverse, BANDPASS (mode 2) keeps only a slice around cutoff. All three are two-pole (12 dB/octave) Faust sections that run in parallel on the input; the mode control simply picks which one you hear, so switching is instantaneous and un-crossfaded (it can click under a loud signal). Resonance emphasises the corner rather than lifting the whole passband: it maps to Q = res × 20 + 0.7, so at maximum the response peaks about 26 dB above the passband — loud enough to overdrive whatever comes next, but this design never self-oscillates, so it is a filter, not a sine source. Both CV jacks are trimmed by their own attenuverter knob and then smoothed by the DSP's ~7 Hz one-pole, which makes envelope and LFO sweeps click-free and rules out audio-rate FM through the cutoff jack.",
    inputs: {
      audio:
        "The signal to be filtered — typically an oscillator, a drum voice, or a submix. It is fed to all three filter sections in parallel; you hear whichever one the mode control selects.",
      cutoff:
        "Cutoff CV. The value is scaled (and, at negative settings, inverted) by the Cutoff CV knob, then applied EXPONENTIALLY by the DSP: a full-scale +1 at depth +1 lifts the corner five octaves above the knob, −1 drops it five octaves below, and the result is clamped to the 20 Hz–20 kHz window (so from the 1000 Hz default the upward reach is really about 4.3 octaves before it hits the ceiling). Set depth to 0.2 for a one-octave envelope sweep. The mapping lives in the Faust source, so no external scaling stage is needed — but note the value is smoothed by a ~7 Hz one-pole, which is what keeps stepped sequencer CV click-free and what makes this a modulation input rather than an FM input.",
      res: "Resonance CV. Scaled (and optionally inverted) by the Res CV knob, then ADDED to the resonance value on its own 0..0.99 scale and clamped there — so a positive CV opens the peak up and a negative one closes it back toward flat, and no amount of CV can push past the 0.99 maximum. Like the cutoff path it is smoothed at ~7 Hz, so it tracks envelopes and LFOs, not audio.",
    },
    outputs: {
      audio:
        "The filtered signal for the selected mode. The passband sits at unity gain, so a low-resonance lowpass is roughly level with the input while a high-resonance setting adds a peak of up to about 26 dB at the corner — watch the level going into the next stage. Bandpass is the exception: its whole output scales with Q, so at low resonance it is both broad and quiet, and it gets louder and narrower as you turn resonance up.",
    },
    controls: {
      cutoff:
        "The corner (lowpass/highpass) or centre (bandpass) frequency, 20 Hz to 20 kHz on a log taper so the musically-useful range spreads evenly across the travel. This is the knob you sweep; everything else on the module exists to shape what that sweep does.",
      resonance:
        "Emphasis at the cutoff frequency, 0 to 0.99, mapped internally to Q = res × 20 + 0.7. At 0 the response is the plain gentle 12 dB/octave slope; turning it up narrows and lifts the peak at the corner to about +26 dB at maximum, which is where the classic vocal/formant quality and the squelchy sweep come from. Two things worth knowing: the passband does NOT drop as you raise it (unlike a ladder filter), so high resonance is a real level increase into the next stage; and this design does not self-oscillate — at maximum it rings hard but always needs an input signal.",
      mode: "The filter character, a three-position switch: 0 = LOWPASS (keeps lows, rolls off above cutoff at 12 dB/octave — the default subtractive-synthesis voice), 1 = HIGHPASS (keeps highs, thins out bass and rumble; it is built as input-minus-lowpass, so its deep stopband tapers at 6 dB/octave rather than 12), 2 = BANDPASS (keeps only the region around cutoff, 6 dB/octave skirts on both sides — a narrow, nasal, telephone-ish slice that tightens as resonance rises). All three sections run continuously and the switch just picks one, so a change lands instantly with no crossfade.",
      cutoff_cv_amt:
        "Attenuverter for the cutoff CV jack: how far, and in which direction, a patched modulator throws the sweep. At +1 a full-scale CV covers the whole ±5-octave range; at 0.2 it is about ±1 octave; at 0 the jack is muted; negative values invert the modulator, so a rising envelope closes the filter instead of opening it. This is the trim you reach for straight after patching an envelope in — without it a plain 0..1 envelope asks for five octaves and simply pins the cutoff at the ceiling.",
      res_cv_amt:
        "Attenuverter for the res CV jack, same idea on the resonance scale: +1 lets a full-scale CV cover the entire 0..0.99 range, smaller values give a subtler swell, 0 mutes the jack, and negative values invert so a rising modulator damps the peak instead of sharpening it. Pair a slow LFO here with a little cutoff modulation for the classic sweeping-formant motion.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const f = await instantiateFaustModule(ctx, { name: 'filter', wasmUrl, metaUrl, workletUrl }, node);
    const merger = ctx.createChannelMerger(3);
    merger.connect(f);
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    silence.connect(merger, 0, 0);
    silence.connect(merger, 0, 1);
    silence.connect(merger, 0, 2);

    // CV ATTENUVERTERS — the depth knobs live in the engine graph, not the
    // DSP: each CV jack terminates on its own GainNode, which feeds the
    // merger channel the Faust source reads. Gain 1.0 (the default) is an
    // exact identity multiply, so an untouched filter is bit-identical to
    // the pre-attenuverter build.
    const cutoffAtten = ctx.createGain();
    const resAtten = ctx.createGain();
    cutoffAtten.connect(merger, 0, 1);
    resAtten.connect(merger, 0, 2);
    const attenById = new Map<string, GainNode>([
      ['cutoff_cv_amt', cutoffAtten],
      ['res_cv_amt', resAtten],
    ]);

    const params = f.parameters as unknown as Map<string, AudioParam>;

    /** Route one param to its real destination: an attenuverter gain, else
     *  the Faust param map. */
    const applyParam = (paramId: string, value: number): void => {
      const gain = attenById.get(paramId);
      if (gain) gain.gain.setValueAtTime(value, ctx.currentTime);
      else params.get(`${PARAM_PREFIX}/${paramId}`)?.setValueAtTime(value, ctx.currentTime);
    };

    for (const def of filterDef.params) {
      applyParam(def.id, (node.params ?? {})[def.id] ?? def.defaultValue);
    }

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number }>([
        ['audio',  { node: merger,       input: 0 }],
        ['cutoff', { node: cutoffAtten,  input: 0 }],
        ['res',    { node: resAtten,     input: 0 }],
      ]),
      outputs: new Map([['audio', { node: f, output: 0 }]]),
      setParam(paramId, value) {
        applyParam(paramId, value);
      },
      readParam(paramId) {
        const gain = attenById.get(paramId);
        if (gain) return gain.gain.value;
        return params.get(`${PARAM_PREFIX}/${paramId}`)?.value;
      },
      dispose() {
        try { silence.stop(); } catch { /* already stopped */ }
        silence.disconnect();
        cutoffAtten.disconnect();
        resAtten.disconnect();
        merger.disconnect();
        f.disconnect();
      },
    };
  },
};
