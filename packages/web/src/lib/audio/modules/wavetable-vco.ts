// packages/web/src/lib/audio/modules/wavetable-vco.ts
//
// WAVETABLE VCO — one-shot wavetable oscillator with continuous
// frame-morph control. The DSP is a custom JS AudioWorklet
// (packages/dsp/src/wavetable-vco.ts). The factory generates a synthetic
// 16-frame "basic" wavetable that morphs saw → square → triangle → sine
// and hands it to the worklet through `processorOptions` at CONSTRUCTION — not
// by a later port message, which used to leave a window in which the processor
// rendered silence (see the race-fix note on the factory below).
// The `wavePos` param picks the morph position into the 16-frame table;
// the wavetable is a fixed sequence shipped with the module, NOT a user-
// uploaded set (see WAVECEL or WAVVIZ for those).
//
// Inputs:
//   pitch (pitch): V/oct pitch input, 0V = C4.
//   fm (audio): audio-rate frequency modulator, scaled by fmAmount.
//   wavePos (cv, paramTarget=wavePos): displaces the wavetable morph position.
//   pm (audio): audio-rate phase modulator, scaled by pmAmount.
//   tune (cv, linear, paramTarget=tune): displaces tune knob (semitones).
//   fine (cv, linear, paramTarget=fine): displaces fine knob (cents).
//   fmAmount (cv, linear, paramTarget=fmAmount): displaces FM-depth knob.
//   pmAmount (cv, linear, paramTarget=pmAmount): displaces PM-depth knob.
//
// Outputs:
//   audio (audio): the morphed wavetable signal.
//
// Params:
//   tune (linear -36..36 st, default 0): coarse tune semitones.
//   fine (linear -100..100 ¢, default 0): fine tune cents.
//   wavePos (linear 0..1, default 0): position into the 16-frame table (0 = first frame, 1 = last).
//   fmAmount (linear -1..1, default 0): FM input depth.
//   pmAmount (linear -1..1, default 0): PM input depth.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/wavetable-vco.js?url';

import { createWorkletNode } from '$lib/audio/worklet-guard';
const FRAME_SIZE = 2048;
const FRAME_COUNT = 16;

// Per-context cache so addModule isn't called twice on the same context.
const loadedContexts = new WeakSet<BaseAudioContext>();

function generateBasicTable(): Float32Array {
  const table = new Float32Array(FRAME_SIZE * FRAME_COUNT);
  for (let f = 0; f < FRAME_COUNT; f++) {
    const t = f / (FRAME_COUNT - 1); // 0..1
    for (let s = 0; s < FRAME_SIZE; s++) {
      const phase = s / FRAME_SIZE; // 0..1
      let v: number;
      if (t < 1 / 3) {
        // Saw → Square morph
        const m = t * 3;
        const saw = phase < 0.5 ? 2 * phase : 2 * phase - 2;
        const sqr = phase < 0.5 ? 1 : -1;
        v = saw * (1 - m) + sqr * m;
      } else if (t < 2 / 3) {
        // Square → Triangle morph
        const m = (t - 1 / 3) * 3;
        const sqr = phase < 0.5 ? 1 : -1;
        const tri =
          phase < 0.25 ? 4 * phase :
          phase < 0.75 ? 2 - 4 * phase :
          -4 + 4 * phase;
        v = sqr * (1 - m) + tri * m;
      } else {
        // Triangle → Sine morph
        const m = (t - 2 / 3) * 3;
        const tri =
          phase < 0.25 ? 4 * phase :
          phase < 0.75 ? 2 - 4 * phase :
          -4 + 4 * phase;
        const sn = Math.sin(2 * Math.PI * phase);
        v = tri * (1 - m) + sn * m;
      }
      table[f * FRAME_SIZE + s] = v;
    }
  }
  return table;
}

export const wavetableVcoDef: AudioModuleDef = {
  type: 'wavetableVco',
  palette: { top: 'Audio modules', sub: 'VCOs' },
  domain: 'audio',
  label: 'wavetable vco',
  category: 'sources',

  // Chain-role (Design-D declarative override): a DECLARED source. Its audio
  // inputs (fm / pm) are MODULATION, not a signal-chain insert, so the workflow
  // column classifier must treat it as a head-eligible SOURCE, not FX.
  chainWiring: { role: 'source' },

  inputs: [
    { id: 'pitch',   type: 'pitch' },
    { id: 'fm',      type: 'audio' },
    // wavePos is audio-rate (the worklet sums wpKnob + wpCv per-sample), so
    // it doesn't go through the CV→AudioParam fast path. paramTarget keeps
    // docs labelling correct; cvScale would do nothing here (the input is
    // not summed onto an AudioParam — see PASSTHROUGH_BY_DESIGN registry).
    { id: 'wavePos', type: 'cv', paramTarget: 'wavePos' },
    // pm: audio-rate phase modulation input. ±1 input × pmAmount = up to
    // ±1 cycle of phase shift at the wavetable readout.
    { id: 'pm',      type: 'audio' },
    // CV → AudioParam routings (engine attaches a WaveShaperNode scaler so
    // an LFO ±1 sweeps the full natural range centered on the knob).
    { id: 'tune',     type: 'cv', paramTarget: 'tune',     cvScale: { mode: 'linear' } },
    { id: 'fine',     type: 'cv', paramTarget: 'fine',     cvScale: { mode: 'linear' } },
    { id: 'fmAmount', type: 'cv', paramTarget: 'fmAmount', cvScale: { mode: 'linear' } },
    { id: 'pmAmount', type: 'cv', paramTarget: 'pmAmount', cvScale: { mode: 'linear' } },
  ],
  outputs: [{ id: 'audio', type: 'audio' }],
  params: [
    { id: 'tune',     label: 'Tune', defaultValue: 0,   min: -36,  max: 36,  curve: 'linear', units: 'st' },
    { id: 'fine',     label: 'Fine', defaultValue: 0,   min: -100, max: 100, curve: 'linear', units: '¢' },
    { id: 'wavePos',  label: 'Wave', defaultValue: 0,   min: 0,    max: 1,   curve: 'linear' },
    { id: 'fmAmount', label: 'FM',   defaultValue: 0,   min: -1,   max: 1,   curve: 'linear' },
    { id: 'pmAmount', label: 'PM',   defaultValue: 0,   min: -1,   max: 1,   curve: 'linear' },
  ],

  // ── THE FACEPLATE (PF-20) ───────────────────────────────────────────────────
  //
  // WHAT THIS MODULE IS FOR. Every other VCO in the rack decides its shape
  // BEFORE the note — tidyVco's four fixed jacks, analogVco's morph crossfade,
  // macrooscillator's fourteen engines. This one reads a 16-frame single-cycle
  // table that runs saw → square → triangle → sine and WAVE scans it WHILE IT
  // SOUNDS. The verb is *sweep the shape*: park an LFO or an envelope on WAVE
  // POSITION and the harmonics thin out over the note instead of being chosen
  // ahead of it. It is not a wavetable LOADER (that is WAVECEL) — the table is
  // fixed and WAVE only scans it.
  face: {
    // RANKS 1-6 ARE THE ENTIRE LANE BUDGET and this module has five keys, so the
    // plate and the dock both show everything: the ranking's whole authority is
    // at the top two, which is what mini (1) and compact (2 beside a glyph)
    // actually paint.
    //
    // Measurements are art/scenarios/wavetable-vco/cv-path.test.ts, peak
    // |Δsample| in LINEAR amplitude against the def's own spawn defaults.
    order: [
      // 1 — THE IDENTITY. The only control that changes the TIMBRE at all, and
      // the only thing this module does that its VCO siblings cannot. Frame 0
      // (saw) → frame 15 (sine) is a peak |Δ| of 9.9937e-1, a full-scale change.
      // It also ships at 0, the very bottom of the table, so a fresh module is a
      // plain saw and the whole point of it is one knob-turn away.
      'wavePos',
      // 2 — the pitch. 1.4999e+0 per octave.
      'tune',
      // 3 — ±1 semitone of trim: 1/72 of TUNE's travel, and ranked ABOVE the two
      // depths for one measured reason — it is UNCONDITIONALLY applicable and
      // they are not (see 4).
      'fine',
      // 4 — the second identity (audio-rate exponential FM, DX-style metallic
      // tones), but INERT until a cable lands in `fm`: measured bit-exactly
      // 0.0000e+0 at depth 1 with nothing patched. An enabler-gated control
      // cannot outrank one that always works.
      'fmAmount',
      // 5 — same enabler shape, ranked below FM because it never moves the pitch
      // AT ALL: `pma * pm` is added to the READ phase while the accumulator
      // advances on `freq/sr` alone, so a held offset shifts where the table is
      // read and leaves the period untouched.
      'pmAmount',
    ],

    // TWO bands, and the split is the WORKLET'S OWN ARITHMETIC rather than a
    // knob-versus-modulation habit. `semitones = pitch*12 + tune + fine/100 +
    // fma*fm*12` — FM lands in the SAME exponent as TUNE and FINE, so it is a
    // pitch control; PM does not appear in that expression at all. Filing the
    // two depths together under "modulation" would put the module's most
    // pitch-shifting control in the band that claims not to touch pitch.
    //
    // Measured, not inherited: a DC on `fm` at depth 1 moves C4 to 521.74 Hz; a
    // DC on `pm` at any depth leaves the period alone.
    //
    // `order` and `pages` DISAGREE on purpose. WAVE is rank 1 and sits in the
    // SECOND band, because priority and signal order genuinely differ here: the
    // frequency is decided before the table is read.
    pages: [
      { id: 'pitch', label: 'pitch', controls: ['tune', 'fine', 'fmAmount'] },
      { id: 'wave', label: 'wave', controls: ['wavePos', 'pmAmount'] },
    ],

    // ⚠ A FREE-RUNNING ENTRY IN THE VRT FACES ROSTER — the third, after
    // analogVco and macrooscillator. This module sounds the instant it spawns:
    // three of the four worklet inputs may be empty and the phase accumulator
    // still advances on `freq / sampleRate`. So its glyph tap is a MOVING trace,
    // the condition that measured 254/154/315 px across three captures of the
    // same analogVco tile before #1420. `_shell-faces.ts`'s
    // `freezeAudioContext` is what makes it deterministic. The glyph is kept
    // because on a WAVETABLE oscillator the trace IS the readout of the control
    // the hero promotes: it draws the frame WAVE is currently sitting on.
    glyph: 'scope',

    // THE HERO. WAVE is PROMOTED out of band 2, not copied — `heroFacePlan`
    // removes it and the band survives on `pmAmount`, so the multiset
    // faces-parity asserts is unchanged and `pages` stays 2 for the VRT roster.
    //
    // ⚠ BOTH READOUTS ARE DERIVED, and each is derived because the nearest knob
    // is BLIND to something that genuinely changes the answer:
    //
    //   knob pitch — TWO params, not one. Move FINE alone and a `tune` readback
    //     does not budge while the sounding pitch moves a full semitone
    //     (261.6 → 277.2 Hz). Neither dial prints Hz and neither prints the C4
    //     anchor the worklet hides in `261.626 * 2^(semitones/12)`. ⚠ THE LABEL
    //     SAYS `knob` DELIBERATELY: a FaceReadoutValue sees durable params only,
    //     so it is blind to the `pitch` jack and to CV on tune/fine — captioning
    //     it `pitch` while a sequencer drives the module two octaves away would
    //     be a lie the platform would happily paint.
    //   fm span — invariant to the FM DIAL in one direction and to TUNE in the
    //     other. Flip fmAmount's SIGN and a knob readback swings through zero
    //     while the span must NOT move (a negative depth inverts the MODULATOR,
    //     not the direction); move TUNE and the dial does not twitch while the
    //     Hz swing doubles per octave (+260/−131 Hz at C4 becomes +520/−261 an
    //     octave up). And it prints the ASYMMETRY, which is the one fact about
    //     exponential FM that no symmetric ± dial can express.
    hero: {
      control: 'wavePos',
    },

    // No `title`, no `hint`, no band hints, no sidebar — owner ruling
    // 2026-08-11 (marbles / resofilter): plain labels and values on the face;
    // the explanation lives in `docs` for right-click → annotate.

    // REAR CARD. Derivation is already total: the three audio-rate ports head
    // the leading band, the four CV holes whose stems match a param land in
    // their page bands. Only two things are curated.
    //
    // The leading band's derived label is `voice`, which says nothing a patcher
    // can act on. These three are the ports the PROCESSOR reads per sample —
    // `inputs[0..3]` in the worklet's own `process()` — as opposed to the CV
    // jacks, which displace a knob through an a-rate AudioParam. That
    // distinction IS the band, so the band is named for it.
    //
    // audioRate: FOUR, and `wavePos` is in the list even though it is a `cv`
    // port, because it is the one CV jack the worklet reads per sample off a
    // node INPUT (`wp = wpKnob + wpCv`, worklet input 2) rather than through the
    // AudioParam path. That is the same fact `PASSTHROUGH_BY_DESIGN` records,
    // stated where a patcher can see it.
    rear: {
      groups: [{ id: 'voice', label: 'core inputs', ports: ['pitch', 'fm', 'pm'] }],
      audioRate: ['pitch', 'fm', 'pm', 'wavePos'],
    },
  },

  docs: {
    explanation: "A single-cycle wavetable oscillator. Instead of one fixed shape, it reads from a built-in 16-frame table that morphs continuously saw → square → triangle → sine, and the WAVE control scans across those frames so you can sweep the timbre in real time (or modulate the scan with CV for a moving, evolving tone). Pitch is 1V/oct (0V = C4) trimmed by TUNE (coarse semitones) and FINE (cents). On top of the basic oscillator it has two audio-rate modulation inputs that make it sound complex or metallic: an FM input (frequency modulation, scaled by the FM AMT control) and a PM input (phase modulation, scaled by PM AMT). The table is the fixed shape set shipped with the module — there is no per-frame selector or upload here (use WAVECEL or WAVVIZ for custom wavetables); WAVE only scans the table that's already loaded.",
    inputs: {
      pitch: "1V/oct pitch input — 0V plays C4 and each ±1 shifts the oscillator a full octave. Sums with the TUNE and FINE controls (and the TUNE/FINE CV inputs) to set the playback frequency, which is clamped to roughly 1 Hz–20 kHz.",
      fm: "Audio-rate frequency-modulation input, depth set by the FM AMT control (FM AMT 0 = no effect). Modulation is EXPONENTIAL, not linear/through-zero: the incoming signal is added in the semitone domain (±1 in × FM AMT = up to ±12 semitones of pitch wobble), so a positive input raises pitch and a negative input lowers it, but the frequency is floored at 1 Hz and never crosses to the other side of zero. A negative FM AMT flips the modulator's polarity.",
      pm: "Audio-rate phase-modulation input, depth set by the PM AMT control (PM AMT 0 = no effect). It offsets where the oscillator reads into the wavetable without changing the underlying frequency: ±1 in × PM AMT = ±1 up to a full cycle of phase shift, which adds harmonics for FM/DX-style metallic and bell-like tones. A negative PM AMT inverts the direction of the offset.",
      wavePos: "CV that scans the wavetable, summing with the WAVE control to pick the morph frame (saw → square → triangle → sine). Audio-rate and clamped to 0..1, so an LFO or envelope here continuously sweeps the timbre; full-scale ±1 covers the whole table from the WAVE setting.",
      tune: "CV that displaces the TUNE control, shifting coarse pitch in semitones (its full natural range of about ±36 semitones, centered on the knob).",
      fine: "CV that displaces the FINE control, shifting pitch in cents (its full natural range of about ±100 cents, centered on the knob) for detuning.",
      fmAmount: "CV that displaces the FM AMT control, modulating how deep the FM input drives the pitch.",
      pmAmount: "CV that displaces the PM AMT control, modulating how deep the PM input shifts the readout phase.",
    },
    outputs: {
      audio: "The oscillator's audio output — the interpolated wavetable signal at the current pitch and WAVE position, including any FM and PM applied. Mono, roughly ±1 in level; patch it into a filter, VCA, or mixer.",
    },
    controls: {
      tune: "Coarse tuning in semitones, ±36 (±3 octaves), added to the 1V/oct pitch input. 0 leaves the incoming pitch untouched.",
      fine: "Fine tuning in cents, ±100 (±1 semitone), for detuning or beating against another oscillator. 0 is no offset.",
      wavePos: "Scans the position into the 16-frame table from 0 (the first frame) to 1 (the last), morphing the timbre saw → square → triangle → sine; the WAVE POSITION CV input sums on top of this. Sets where in the table the oscillator reads — the table itself is fixed.",
      fmAmount: "Depth of the FM input: how strongly the audio-rate signal at the FM input modulates pitch (up to ±12 semitones at full input). 0 ignores the FM input; negative values invert the modulator's polarity.",
      pmAmount: "Depth of the PM input: how strongly the audio-rate signal at the PM input offsets the wavetable readout phase (up to a full cycle at full input). 0 ignores the PM input; negative values invert the direction of the phase offset.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    // ⚠ THE TABLE IS PASSED AT CONSTRUCTION, NOT POSTED AFTERWARDS. This is a
    // RACE FIX. It used to be `workletNode.port.postMessage({type:'load', …})`
    // AFTER the node existed, and the processor emits `out.fill(0)` — digital
    // SILENCE — until a table arrives. Nothing sequenced that message against
    // rendering, so any block processed before delivery was silent.
    //
    // On a realtime context that is a block or two nobody hears. On an
    // `OfflineAudioContext`, which renders as fast as it can, whole renders came
    // out silent intermittently — MEASURED on CI (2026-08-23) as an ART inertness
    // assertion reporting `peak |Δsample| = 1.3953` against an expected 0, on a
    // signal documented as roughly ±1: silence against signal, not drift.
    //
    // ⚠ THE REAL COST WAS THE GREEN RUNS, NOT THE RED ONE. An ART render that
    // silently measures silence makes every assertion that would PASS on silence
    // green for the wrong reason. `processorOptions` reaches the processor
    // constructor synchronously, before its first `process()` call, so the window
    // does not exist rather than being made small.
    //
    // ⚠ COST: `processorOptions` is structured-CLONED, not transferred, so this
    // copies the table once per node (16 × 2048 × 4 B ≈ 128 KB) where the old
    // path transferred the buffer. A one-time construction cost, paid to remove a
    // correctness race.
    const table = generateBasicTable();
    const workletNode = createWorkletNode(node, ctx, 'wavetable-vco', {
      numberOfInputs: 4,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: {
        type: 'load',
        table: table.buffer,
        frameSize: FRAME_SIZE,
        frameCount: FRAME_COUNT,
      },
    });

    // Apply initial param values.
    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of wavetableVcoDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    return {
      domain: 'audio',
      inputs: new Map([
        ['pitch',   { node: workletNode, input: 0 }],
        ['fm',      { node: workletNode, input: 1 }],
        ['wavePos', { node: workletNode, input: 2 }],
        ['pm',      { node: workletNode, input: 3 }],
        // CV → AudioParam fast-path; engine sums the scaled CV into these AudioParams.
        ['tune',     { node: workletNode, input: 0, param: params.get('tune')!     }],
        ['fine',     { node: workletNode, input: 0, param: params.get('fine')!     }],
        ['fmAmount', { node: workletNode, input: 0, param: params.get('fmAmount')! }],
        ['pmAmount', { node: workletNode, input: 0, param: params.get('pmAmount')! }],
      ]),
      outputs: new Map([['audio', { node: workletNode, output: 0 }]]),
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      dispose() {
        workletNode.disconnect();
      },
    };
  },
};
