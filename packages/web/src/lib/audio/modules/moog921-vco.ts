// packages/web/src/lib/audio/modules/moog921-vco.ts
//
// MOOG 921 VCO — the first module of the Moog System 55 / 35 clone
// initiative (.myrobots/MOOG/). Voltage-controlled oscillator faithful to
// the original 921: ONE oscillator core presenting four simultaneous
// waveform jacks (sine / triangle / sawtooth / rectangular with variable
// pulse width), 1V/oct + linear frequency-control inputs, and a
// hard/soft/off sync switch. Shared by SYS55 + SYS35 (categorized under
// Ports → moogafakkin per the plan's resolved Q4).
//
// DSP: own-code polyBLEP oscillator (packages/dsp/src/moog921-vco.ts +
// lib/moog-vco-dsp.ts) — permissive, not a port of any Moog schematic or
// copyleft source.
//
// Inputs:
//   pitch (pitch): V/oct pitch input, 0 V = C4. Exponential frequency control.
//   lin_fm (audio): audio-rate LINEAR frequency-control input (the 921's
//     dedicated linear input), scaled by the linFmAmount param.
//   sync (audio): external sync source; rising edges reset/nudge the phase
//     per the sync mode switch.
//   width_cv (cv, paramTarget=width): audio-rate pulse-width CV summed onto
//     the WIDTH knob (PASSTHROUGH — summed per-sample in the worklet).
//   octave (cv, linear, paramTarget=octave): displaces the RANGE knob (octaves).
//   tune (cv, linear, paramTarget=tune): displaces the FREQUENCY fine knob.
//   linFmAmount (cv, linear, paramTarget=linFmAmount): displaces lin-FM depth.
//   level (cv, linear, paramTarget=level): displaces the output level.
//
// Outputs:
//   sine (audio): sine tap.
//   triangle (audio): triangle tap.
//   sawtooth (audio): band-limited sawtooth tap.
//   rectangular (audio): pulse/rectangular tap; duty cycle = WIDTH.
//
// Params:
//   octave (linear -5..5, default 0): RANGE coarse, in octaves.
//   tune (linear -12..12, default 0): FREQUENCY fine, in semitones.
//   width (linear 0.02..0.98, default 0.5): rectangular pulse width / duty.
//   linFmAmount (linear -1..1, default 0): linear-FM input depth.
//   sync (discrete -1..1, default 0): sync switch, a THREE-POSITION comparator
//     (-1 SOFT / 0 OFF / +1 HARD) with a named `options` roster — not a dial.
//   level (linear 0..2, default 1): output gain.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import type { ParamOption } from '$lib/graph/types';
import workletUrl from '@patchtogether.live/dsp/dist/moog921-vco.js?url';

import { createWorkletNode } from '$lib/audio/worklet-guard';
// Per-context cache so addModule isn't called twice on the same context.
const loadedContexts = new WeakSet<BaseAudioContext>();

/**
 * The SYNC switch's three named states (#1887).
 *
 * ⚠ `sync` IS A COMPARATOR, NOT A DIAL, AND IT SHIPPED DECLARED AS ONE. The DSP
 * thresholds it at ±0.5 (`syncModeFromParam`, `lib/moog-vco-dsp.ts:48-52`:
 * `v >= 0.5 → hard`, `v <= -0.5 → soft`, else `off`), so the `off` state is the
 * OPEN interval (−0.5, 0.5) — EXACTLY 50 % of the declared −1..1 travel, and
 * nothing between the detents exists. It shipped `curve: 'linear'`, so a
 * def-driven face painted a continuous rotary printing `0.00` over a
 * three-position switch, and `options` cannot be declared on a non-discrete
 * curve (`param-vocabulary.test.ts` refuses a def carrying both). The two edits
 * are therefore SEQUENCED and land together — `discrete` first, then the roster.
 * This is `moog921b.syncMode`'s fix (MOOG921B_SYNC_OPTIONS) applied to the
 * monolith, which the pair's PR could not reach.
 *
 * ⚠ MEASURED, not assumed, through the SHIPPING worklet at 48 kHz with a 200 Hz
 * sine on the `sync` jack, comparing against an unpatched render and reporting
 * the LAST DIVERGENT SAMPLE rather than a windowed RMS: at `sync = 0.3` — a
 * value the card's three buttons cannot produce but a Push 2 encoder can, since
 * `push-card-encoder.ts:86` maps encoder motion through
 * `knobFracToValue(frac, min, max, curve)` — the render is BIT-IDENTICAL to
 * leaving the jack unpatched. The dead zone was reachable and silent.
 *
 * ⚠ CHECKED AGAINST THE CONSUMERS BEFORE CHANGING THE CURVE (CLAUDE.md's
 * "before fixing a declaration to satisfy a gate, check the consumer reads it"):
 * the DSP quantizes it already (`syncModeFromParam` is a comparator, so no
 * rendered sample moves), no input declares `paramTarget: 'sync'` so no CV
 * bridge reads the curve, and `Moog921VcoCard.svelte` paints it as a button row
 * rather than a `<Knob>`, so no legacy pixel moves either. What DOES change:
 * the faceplate's control steps to −1 / 0 / +1 instead of stopping anywhere in a
 * band that means the same thing, and it paints the three NAMES.
 *
 * ⚠ THE VOCABULARY IS THIS MODULE'S OWN, and it deliberately differs from
 * `moog921b`'s `LO`/`OFF`/`HI`. These three names are what `Moog921VcoCard`
 * has always painted; a face that renamed the control the player already knows
 * would be dropping an affordance, not recovering one. The card now MAPS this
 * roster instead of restating it, so the names have exactly one copy.
 *
 * ⚠ THE `soft` TITLE STATES WHAT THE CODE DOES, NOT WHAT ITS COMMENT CLAIMS.
 * `moog-vco-dsp.ts:180-183` says soft sync "reflects rather than hard-zeroes";
 * the statement under that comment is `if (this.phase > 0.5) this.phase = 0`,
 * which is the same assignment as the `hard` branch with a guard in front. That
 * is #1883 — measured bit-identical to HARD at 67.77 % of pitches — and it is
 * an AUDIO-SEMANTICS question filed for owner ears, deliberately NOT fixed here.
 * New prose must not restate a claim that has been disproven, so this title
 * describes the guard.
 */
export const MOOG921VCO_SYNC_OPTIONS: readonly ParamOption[] = [
  { value: -1, label: 'SOFT', title: 'soft sync — a rising edge zeroes the phase only when it is already past the half-cycle' },
  { value: 0, label: 'OFF', title: 'the sync input is ignored' },
  { value: 1, label: 'HARD', title: 'hard sync — every rising edge resets the phase to 0' },
];

export const moog921VcoDef: AudioModuleDef = {
  type: 'moog921Vco',
  palette: { top: 'Moog System 35/55 Clones', sub: 'Moog System 35/55 Clones' },
  domain: 'audio',
  label: '921 vco',
  category: 'sources',

  // Chain-role (Design-D declarative override): a DECLARED source. Its audio
  // inputs (lin_fm / sync) are MODULATION, not a signal-chain insert, so the
  // workflow column classifier must treat it as a head-eligible SOURCE, not FX.
  chainWiring: { role: 'source' },

  inputs: [
    { id: 'pitch',    type: 'pitch' },
    { id: 'lin_fm',   type: 'audio' },
    { id: 'sync',     type: 'audio' },
    // width_cv is audio-rate (the worklet sums width knob + CV per-sample),
    // so it doesn't go through the CV→AudioParam fast path. paramTarget keeps
    // docs labelling correct; no cvScale (PASSTHROUGH_BY_DESIGN, like
    // wavetableVco.wavePos).
    { id: 'width_cv', type: 'cv', paramTarget: 'width' },
    // CV → AudioParam routings (engine attaches a scaler so an LFO ±1 sweeps
    // the full natural range centered on the knob).
    { id: 'octave',      type: 'cv', paramTarget: 'octave',      cvScale: { mode: 'linear' } },
    { id: 'tune',        type: 'cv', paramTarget: 'tune',        cvScale: { mode: 'linear' } },
    { id: 'linFmAmount', type: 'cv', paramTarget: 'linFmAmount', cvScale: { mode: 'linear' } },
    { id: 'level',       type: 'cv', paramTarget: 'level',       cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'sine',        type: 'audio' },
    { id: 'triangle',    type: 'audio' },
    { id: 'sawtooth',    type: 'audio' },
    { id: 'rectangular', type: 'audio' },
  ],
  params: [
    { id: 'octave',      label: 'Range', defaultValue: 0,   min: -5,    max: 5,    curve: 'linear', units: 'oct' },
    { id: 'tune',        label: 'Freq',  defaultValue: 0,   min: -12,   max: 12,   curve: 'linear', units: 'st' },
    { id: 'width',       label: 'Width', defaultValue: 0.5, min: 0.02,  max: 0.98, curve: 'linear' },
    { id: 'linFmAmount', label: 'Lin FM',defaultValue: 0,   min: -1,    max: 1,    curve: 'linear' },
    { id: 'sync',        label: 'Sync',  defaultValue: 0,   min: -1,    max: 1,    curve: 'discrete', options: MOOG921VCO_SYNC_OPTIONS },
    { id: 'level',       label: 'Level', defaultValue: 1,   min: 0,     max: 2,    curve: 'linear' },
  ],

  // ── THE FACE ────────────────────────────────────────────────────────────────
  //
  // WHAT IT IS FOR, MUSICALLY: the 921A driver and the 921B slave packed into
  // ONE module, and the thing that buys you is the jack the pair does not have
  // between them — its OWN 1V/oct input. You patch a keyboard straight in and
  // take FOUR different timbres of the SAME note to four destinations at once,
  // phase-coherent off one core. The verb is TUNE, then TAP: set the note with
  // RANGE + FREQ, then choose how many of the four jacks you use.
  //
  // ⚠ THE RANK ARGUMENT, AND THE BOTTOM TWO ARE MEASURED RATHER THAN JUDGED.
  // Rendered through the SHIPPING worklet at 48 kHz, comparing a patched jack
  // against an unpatched render and reporting the LAST DIVERGENT SAMPLE (never
  // a windowed RMS — a window can only say "not much happened HERE"):
  //
  //   linFmAmount = 0 (shipped), 200 Hz sine on `lin_fm`  → BIT-IDENTICAL
  //   sync        = 0 (shipped), 200 Hz sine on `sync`    → BIT-IDENTICAL
  //
  // Both with positive controls that DO diverge: `linFmAmount = 0.01` (a ±20 Hz
  // span) and `sync = +1` each diverge through the final sample. So TWO of the
  // six controls, and the two jacks they gate, deliver bit-exactly nothing at
  // the factory settings — they rank last because they are inert at spawn, not
  // because they are less interesting. `octave` is the hero for the mirror-image
  // reason: it is the only control that moves the module across its whole
  // compass and it is never inert.
  //
  // The ladder, read back as a sentence: mini shows RANGE (which note), compact
  // adds FREQ beside the trace (so you can tune it), plate adds LEVEL — which
  // scales all four taps — then WIDTH, which shapes ONE of the four, and last
  // the two dead-at-spawn depths. `order` and `pages` disagree deliberately:
  // `order` is priority, and it interleaves the sections; `pages` is signal
  // order (what note → what modulates it → what leaves).
  face: {
    order: ['octave', 'tune', 'level', 'width', 'linFmAmount', 'sync'],

    pages: [
      {
        id: 'pitch',
        label: 'pitch',
        hint: 'RANGE and FREQ join into one frequency — 12 octaves, 4.09 Hz to 16.74 kHz',
        controls: ['octave', 'tune'],
      },
      {
        id: 'mod',
        label: 'mod',
        // ⚠ THIS BAND IS SOLO ON ITS ROW AND THAT IS DERIVED, NOT CHOSEN:
        // `PARAM_CELL_WIDTH_CLASS.segmented` is `'wide'` (dock-row-plan.ts:130),
        // so `bandIsPackable` refuses to pack any band carrying SYNC.
        hint: 'both of these gate a jack, and both are bit-exactly silent as shipped',
        controls: ['linFmAmount', 'sync'],
      },
      {
        id: 'out',
        label: 'out',
        // Measured: the rect tap's RMS is INVARIANT to WIDTH across the whole
        // declared span — every setting from 2 % to 98 % duty lands between
        // −0.044 and −0.045 dB, a spread of one thousandth of a dB — so these
        // two controls genuinely do different jobs — WIDTH is pure timbre on one
        // tap, LEVEL is gain on all four — and neither leaks into the other.
        hint: 'the duty of the rectangular tap, and the gain on all four',
        controls: ['width', 'level'],
      },
    ],

    // ⚠ IT RESOLVES, AND IT RESOLVES TO ONE TAP OF FOUR — SAY WHICH.
    // `primaryAudioOutPortId` takes the FIRST `type: 'audio'` output and this
    // def declares sine, triangle, sawtooth, rectangular in that order, so
    // `glyphBinding` returns `{ kind: 'live-audio', portId: 'sine' }` and the
    // trace is THE SINE TAP ONLY. Sweeping WIDTH will not change this picture,
    // because WIDTH reaches only the rectangular tap. (#1692's finding is a
    // glyph that resolves to NOTHING; the sibling failure is a glyph that
    // resolves to the WRONG thing, which is only visible if someone states which
    // thing.) Asserted with a negative control in moog921-face-model.test.ts.
    //
    // ⚠ AND THE FOUR TAPS ARE NOT LEVEL-MATCHED, so the trace is not a proxy for
    // what the patch hears. Measured steady-state at the shipped defaults with
    // LEVEL identical for all four: rect −0.044 dB, sine −3.011 dB, triangle
    // −4.771 dB, saw −4.834 dB — a 4.789 dB spread between the loudest and the
    // quietest jack. The glyph draws the one in the MIDDLE of that spread.
    //
    // ⚠ THIS IS A FREE-RUNNING VOICE — it sounds the instant it spawns, with no
    // gate and no note to wait for — so its lane tile EXERCISES #1420's
    // pre-frame audio freeze rather than being indifferent to it, like
    // analogVco, macrooscillator and its own sibling moog921b. See the roster
    // note in e2e/vrt/_shell-faces.
    glyph: 'scope',

    // THE HERO: the coarse octave dial, plus the four numbers this module
    // publishes that none of its knobs can print. Each is negative-controlled
    // PERMANENTLY on the input a knob readback is blind to
    // (moog921-face-model.test.ts), and the four have DISJOINT reach — `pitch`
    // moves on RANGE+FREQ, `out` on LEVEL alone, `fm` on LIN FM alone, `sync` on
    // SYNC alone — so each is the others' control on every run. ⚠ AND WIDTH
    // MOVES NONE OF THEM, which is the matrix's fifth leg and the one a
    // knob-relabelling would fail:
    //
    //   pitch  what it sings with the pitch jack AT REST:
    //          261.626 · 2^(octave + tune/12). A join over TWO dials plus the C4
    //          reference, evaluated through the SHIPPING core so the 0.01 Hz
    //          floor and the Nyquist ceiling are the DSP's; neither dial prints
    //          it and both read `0` at the defaults.
    //   out    LEVEL is a 0..2 LINEAR multiplier, so its own readback says
    //          `1.00` where the answer is `+0.0 dB` and `2.00` where it is
    //          `+6.0 dB`. Measured against the worklet at four settings.
    //   fm     the ±Hz a full-scale modulator buys at the current depth. `off`
    //          at the shipped depth, because `± 0.00 Hz` reads like a rounding
    //          artefact rather than a dead jack.
    //   sync   the comparator's state through the DSP's own ±0.5 thresholds. ⚠ At
    //          the DOCK tier the segmented cell names the same state, so this
    //          readout is redundant THERE; it earns its place at compact, where
    //          the tier cap puts SYNC off-screen entirely and this is the only
    //          thing that says whether the jack is live.
    //
    // ⚠ NO COMPASS READOUT, deliberately. `4.09 Hz … 16.74 kHz` is the module's
    // headline unprintable fact, but it is INVARIANT to every param — unlike the
    // sibling driver's, where the RANGE switch moves it — so as a readout it
    // could never move and would be decoration wearing a live number's clothes.
    // A constant belongs in `docs` and in this comment, which is where it is.
    hero: {
      control: 'octave',
    },
  },

  docs: {
    explanation:
      "A clean-room recreation of the Moog 921 Voltage Controlled Oscillator — the standalone, fully self-contained version of the System 55/35 oscillator (the 921A driver + 921B slave packed into one module). One oscillator core presents FOUR simultaneous waveform jacks off the same pitch — sine, triangle, sawtooth, and a rectangular pulse whose duty cycle you set with WIDTH — so you can take a pure sine to one place and a buzzy saw to another from a single voice. Pitch is exponential 1V/oct (0 V at the PITCH jack = C4), set by the RANGE (octave) and FREQ (fine) knobs: those two dials alone span 12 octaves, 4.09 Hz to 16.74 kHz, and the core clamps to 0.01 Hz at the bottom and to just under Nyquist at the top (23 520 Hz at a 48 kHz sample rate, 21 609 Hz at 44.1 kHz). There is a dedicated LINEAR FM input for clangorous FM and bell timbres — it adds Hz rather than octaves, and it is one-sided in practice, because the same 0.01 Hz floor means a negative excursion parks the oscillator instead of driving it through zero. A sync input locks the core's phase to an external source. Mental model: it's a normal analog VCO with the Moog-ladder oscillator's band-limited (polyBLEP) waveshapes, four taps instead of a waveform selector.",
    inputs: {
      pitch:
        "1V/oct exponential pitch CV: 0 V plays C4 and every +1.0 raises the oscillator one octave. Patch a keyboard, sequencer, or the 921A driver bus here to play it; it sums on top of the RANGE + FREQ knobs.",
      lin_fm:
        "Audio-rate LINEAR frequency modulation input — adds to the frequency in Hz (not exponentially), so the modulation depth stays constant in pitch terms across the keyboard rather than widening with pitch. Its depth is set by the LIN FM knob, and at the shipped depth of 0 this jack is bit-exactly silent: patching it changes nothing at all until you raise LIN FM. At full depth a full-scale input is worth ±2000 Hz. Patch another oscillator here for clangorous FM/bell timbres.",
      sync:
        "External sync source: each rising edge restarts the oscillator's phase to lock it to the incoming signal, per the SYNC switch — patch a second oscillator here and sweep this one's pitch for the classic hard-sync sweep. At the shipped SYNC setting of OFF this jack is bit-exactly silent, so it does nothing until you move the switch.",
      width_cv:
        "Pulse-width CV: summed onto the WIDTH knob per sample so an LFO here animates the rectangular output's duty cycle (pulse-width modulation). It only affects the rectangular tap; the sine/triangle/saw stay fixed.",
      octave:
        "CV that displaces the RANGE knob in octaves (coarse pitch); a bipolar LFO/envelope here transposes the oscillator by whole octaves around the knob setting.",
      tune:
        "CV that displaces the FREQ fine knob in semitones; use it for subtle vibrato or fine detune layered on top of the 1V/oct pitch.",
      linFmAmount:
        "CV that displaces the LIN FM depth knob, so you can modulate how much linear FM the lin_fm input applies (e.g. open the FM with an envelope for a percussive attack).",
      level:
        "CV that displaces the output LEVEL, acting as a built-in VCA on every waveform tap — patch an envelope here to shape the oscillator's amplitude without an external VCA.",
    },
    outputs: {
      sine: "The pure sine tap — the fundamental with no harmonics. Same pitch as the other three taps, but NOT the same level: measured at one LEVEL setting the four jacks sit −0.044 dB (rectangular), −3.011 dB (sine), −4.771 dB (triangle) and −4.834 dB (sawtooth), so swapping which tap you patch is worth up to 4.8 dB and you may need to re-trim downstream.",
      triangle: "The triangle tap — a soft, hollow tone with only odd harmonics rolling off steeply (mellower than the saw). The quietest tap but one: about 4.7 dB below the rectangular jack at the same LEVEL.",
      sawtooth: "The band-limited sawtooth tap — the brightest, fullest waveform (all harmonics), the staple for subtractive bass and leads. It is the QUIETEST of the four jacks, about 4.8 dB below the rectangular one at the same LEVEL.",
      rectangular:
        "The rectangular / pulse tap — its duty cycle is set by the WIDTH knob (and width_cv); a 50% square is hollow, off-square pulses get nasal and thin, and sweeping the width is pulse-width modulation. It is the LOUDEST of the four jacks, and its level does not change with WIDTH — a 2% sliver and a 50% square measure the same RMS, so WIDTH is a pure timbre control.",
    },
    controls: {
      octave: "Coarse pitch in whole octaves (RANGE), -5 to +5 around the patched 1V/oct pitch. Together with FREQ it spans 12 octaves — 4.09 Hz to 16.74 kHz — and neither dial prints that: both read 0 at the factory settings, where the oscillator sings C4. The octave CV input adds on top of this.",
      tune: "Fine pitch trim in semitones (FREQ), ±12 (one octave each way) for tuning the oscillator against others or detuning for thickness. It ADDS to RANGE, so the two together reach a full octave beyond either one alone.",
      width:
        "Duty cycle of the rectangular tap, 2% to 98% (0.5 = a 50% square). Only the rectangular output responds; sweep it (or modulate with width_cv) for pulse-width modulation. It is a pure timbre control — the tap's level does not change across the whole span. NOTE the width_cv jack carries more authority than the knob's span can absorb (a ±1 swing against a 0.96-wide range, 2.08x), so a full-scale LFO there spends about 68% of every cycle pinned at 2% or 98% rather than sweeping; attenuate it for smooth PWM.",
      linFmAmount: "How much the LINEAR FM input bends the pitch, ±1 — at the shipped 0 the lin_fm jack is bit-exactly silent; raise it for FM/bell timbres. Full depth is worth ±2000 Hz against a full-scale input. Negative depths do not invert through zero: the core clamps at a positive 0.01 Hz floor, so a large negative excursion parks the oscillator instead.",
      sync: "SYNC mode switch, a three-position centre-off switch rather than a dial: SOFT, OFF (shipped) and HARD. HARD resets the phase to 0 on every rising edge of the sync input. SOFT resets it only when the phase is already past the half-cycle — which is a conditional version of the same reset, not a gentler differently-shaped one, and on many slave pitches it converges to exactly what HARD produces (#1883). At OFF the sync jack is bit-exactly silent. The DSP compares against ±0.5, so there is nothing between the three detents.",
      level: "Output gain on every waveform tap, 0 to 2 (1 = unity). Acts as the oscillator's own VCA; the level CV input adds on top.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = createWorkletNode(node, ctx, 'moog921-vco', {
      numberOfInputs: 4,
      numberOfOutputs: 4,
      outputChannelCount: [1, 1, 1, 1],
    });

    // Feed silence into every input so the node stays in the active
    // processing graph even when nothing's externally patched (mirrors the
    // analogVco silence-keepalive pattern).
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    silence.connect(workletNode, 0, 0);
    silence.connect(workletNode, 0, 1);
    silence.connect(workletNode, 0, 2);
    silence.connect(workletNode, 0, 3);

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of moog921VcoDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['pitch',    { node: workletNode, input: 0 }],
        ['lin_fm',   { node: workletNode, input: 1 }],
        ['sync',     { node: workletNode, input: 2 }],
        ['width_cv', { node: workletNode, input: 3 }],
        // CV → AudioParam fast-path; engine sums the scaled CV into these.
        ['octave',      { node: workletNode, input: 0, param: params.get('octave')!      }],
        ['tune',        { node: workletNode, input: 0, param: params.get('tune')!        }],
        ['linFmAmount', { node: workletNode, input: 0, param: params.get('linFmAmount')! }],
        ['level',       { node: workletNode, input: 0, param: params.get('level')!       }],
      ]),
      outputs: new Map([
        ['sine',        { node: workletNode, output: 0 }],
        ['triangle',    { node: workletNode, output: 1 }],
        ['sawtooth',    { node: workletNode, output: 2 }],
        ['rectangular', { node: workletNode, output: 3 }],
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
