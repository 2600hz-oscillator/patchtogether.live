// packages/web/src/lib/audio/modules/analog-vco.ts
//
// ANALOG VCO — classic analog-style voltage-controlled oscillator.
//
// One pitched oscillator emitting four simultaneous classic waveforms
// (saw, square, triangle, sine) PLUS a continuous saw→sine→square MORPH
// output driven by the `shape` knob (0=saw, 0.5=sine, 1=square) and its
// CV input — V/oct pitch tracking, audio-rate FM and PM inputs, plus the
// standard tune / fine / pulse-width controls.
// The DSP is Faust-compiled (see packages/dsp/src/analog-vco.dsp) and
// hosted in a Faust AudioWorklet. A ChannelMerger routes the pitch /
// FM / PM ports onto distinct input channels so per-port modulation
// stays isolated; a 6-channel ChannelSplitter exposes the four fixed
// waveform tap-offs PLUS the morph tap and the sync pulse on separate
// output ports. (It said "four" for two years while the splitter was
// created with 6 — corrected 2026-08-08.) This is the project's bread-and-butter
// pitched source — patch one into VCA → ADSR → AUDIO OUT for a one-osc
// voice, or stack saw + square through a filter for a chorused bass.
//
// Inputs:
//   pitch (pitch): V/oct pitch input, 0V = C4. Drives oscillator frequency.
//   fm (audio): audio-rate frequency modulator, scaled by the fmAmount param.
//   pm (audio): audio-rate phase modulator, scaled by the pmAmount param.
//   sync (audio): hard-sync input. A rising edge (zero-crossing) hard-resets
//     this oscillator's phase to 0 — wire master.sync_out → slave.sync. When
//     UNPATCHED the VCO output is byte-identical to a VCO with no sync port.
//   tune (cv, linear, paramTarget=tune): displaces the tune knob (semitones).
//   fine (cv, linear, paramTarget=fine): displaces the fine knob (cents).
//   fmAmount (cv, linear, paramTarget=fmAmount): displaces the FM-depth knob.
//   pmAmount (cv, linear, paramTarget=pmAmount): displaces the PM-depth knob.
//   shape (cv, linear, paramTarget=shape): displaces the morph knob (0..1).
//
// Outputs:
//   saw (audio): naive sawtooth tap.
//   square (audio): pulse/square tap; duty cycle set by the pw param.
//   triangle (audio): triangle tap.
//   sine (audio): sine tap.
//   morph (audio): continuous saw→sine→square crossfade set by the shape knob.
//   sync (audio): hard-sync OUTPUT. A one-sample +1 pulse at each cycle
//     boundary (phase wrap) so it can drive another VCO's sync input.
//
// Params:
//   tune (linear -36..36, default 0): coarse tune in semitones.
//   fine (linear -100..100, default 0): fine tune in cents.
//   fmAmount (linear -1..1, default 0): depth of the FM input.
//   pmAmount (linear -1..1, default 0): depth of the PM input.
//   pw (linear 0.05..0.95, default 0.5): square-wave pulse width / duty.
//   shape (linear 0..1, default 0): morph output waveform. 0=saw, 0.5=sine,
//     1=square. At 0 the morph output equals the saw tap (back-compat).

import { instantiateFaustModule } from '$lib/audio/faust-runtime';
import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import wasmUrl from '@patchtogether.live/dsp/dist/analog-vco.wasm?url';
import metaUrl from '@patchtogether.live/dsp/dist/analog-vco.json?url';
import workletUrl from '@patchtogether.live/dsp/dist/analog-vco.worklet.js?url';

const PARAM_PREFIX = '/Analog_VCO';

export const analogVcoDef: AudioModuleDef = {
  type: 'analogVco',
  palette: { top: 'Audio modules', sub: 'VCOs' },
  domain: 'audio',
  label: 'analog vco',
  category: 'sources',
  // Chain-role (Design-D declarative override): a DECLARED source. Its audio
  // inputs (fm / pm / sync) are MODULATION, not a signal-chain insert, so the
  // workflow column classifier must treat it as a head-eligible SOURCE, not FX.
  chainWiring: { role: 'source' },

  inputs: [
    { id: 'pitch', type: 'pitch' },
    { id: 'fm',    type: 'audio' },
    { id: 'pm',    type: 'audio' },
    // Hard-sync input (audio-rate). A rising edge resets the phase to 0.
    { id: 'sync',  type: 'audio' },
    { id: 'tune',     type: 'cv', paramTarget: 'tune',     cvScale: { mode: 'linear' } },
    { id: 'fine',     type: 'cv', paramTarget: 'fine',     cvScale: { mode: 'linear' } },
    { id: 'fmAmount', type: 'cv', paramTarget: 'fmAmount', cvScale: { mode: 'linear' } },
    { id: 'pmAmount', type: 'cv', paramTarget: 'pmAmount', cvScale: { mode: 'linear' } },
    { id: 'shape',    type: 'cv', paramTarget: 'shape',    cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'saw',      type: 'audio' },
    { id: 'square',   type: 'audio' },
    { id: 'triangle', type: 'audio' },
    { id: 'sine',     type: 'audio' },
    { id: 'morph',    type: 'audio' },
    // Hard-sync output: a one-sample pulse at each cycle boundary.
    { id: 'sync',     type: 'audio' },
  ],
  params: [
    { id: 'tune',     label: 'Tune', defaultValue: 0,   min: -36,   max: 36,   curve: 'linear', units: 'semi' },
    { id: 'fine',     label: 'Fine', defaultValue: 0,   min: -100,  max: 100,  curve: 'linear', units: 'cent' },
    { id: 'fmAmount', label: 'FM',   defaultValue: 0,   min: -1,    max: 1,    curve: 'linear' },
    { id: 'pmAmount', label: 'PM',   defaultValue: 0,   min: -1,    max: 1,    curve: 'linear' },
    { id: 'pw',       label: 'PW',   defaultValue: 0.5, min: 0.05,  max: 0.95, curve: 'linear' },
    { id: 'shape',    label: 'Wave', defaultValue: 0,   min: 0,     max: 1,    curve: 'linear' },
  ],

  // ── FACE — PF-20 faceplate (batch-3 promotion, RECOVERED) ─────────────────
  //
  // THE ONE FACT THIS FACE EXISTS TO STATE. analogVco is ONE phase accumulator
  // with SIX taps, and its six knobs do NOT all address the same tap — the
  // legacy card puts all six in one undifferentiated Fader row with nothing
  // saying which jack each one reaches. Read off the DSP rather than off the
  // old card:
  //
  //   tune / fine / fmAmount  → ALL SIX outputs. They are three terms of ONE
  //                             exponent (analog-vco.dsp:24-27, `261.626 *
  //                             pow(2, pitch + tune/12 + fine/1200 +
  //                             fmAmount*fm)`), so FM is a PITCH control, in
  //                             octaves, not a separate "modulation" idea.
  //   pmAmount                → the FIVE wave taps and NOT sync out. PM is
  //                             added at the READ (`p = frac(pRaw + pmAmount *
  //                             pm)`, :103) while the accumulator advances on
  //                             pRaw, which is what syncPulse uses (:93).
  //   pw                      → the SQUARE tap ALWAYS (:57), and the morph only
  //                             in proportion to `hi = 2*shape - 1` (:80,83).
  //   shape                   → the MORPH tap and NOTHING ELSE (:98 selects the
  //                             four fixed taps independently).
  //
  // ⚠ "SHAPE and PW touch only the MORPH tap" IS HALF WRONG and the face must
  // not repeat it: `sqr(p)` IS output 2, so PW is live on the SQUARE tap from
  // spawn regardless of SHAPE. What is true is the sharper, stranger fact: at
  // the shipped `shape = 0` PW's contribution to the MORPH tap is EXACTLY ZERO
  // (the crossfade weight is `max(0, 2*shape-1)` — pinned in
  // analog-vco-morph.test.ts, rms < 1e-9 for shape in {0, 0.1, 0.25, 0.4}),
  // which is why "PW doesn't work" is a reasonable thing for a user to
  // conclude. The `pw on morph` hero readout says so in a number.
  //
  // RANKING (the lane budget is six, and this module has exactly six params, so
  // NOTHING is cut and ranks 1-6 only decide the mini/compact tile and the 3×2
  // plate layout):
  //   1 TUNE   nothing about an oscillator is knowable before its pitch, and it
  //            is the one control that moves every one of the six taps.
  //   2 SHAPE  the tap-selector in disguise — the only control whose IDENTITY
  //            changes with the patch (a no-op on four outputs, the whole
  //            timbre of the fifth). Rank 2 so the compact tile is pitch +
  //            character rather than pitch + duty cycle.
  //   3 FM     the deep-modulation lever, in OCTAVES. Inert at spawn (default 0
  //            AND the `fm` node input is pinned to a 0-offset ConstantSource),
  //            so it ranks on REACH, not on liveness.
  //   4 PW     live and audible on the square tap from spawn; 0 % authority on
  //            the morph tap at the shipped default.
  //   5 FINE   ±1 semitone. Alone a sub-1 % trim; against a second oscillator
  //            it is the beat rate.
  //   6 PM     doubly inert (default 0 AND an unpatched input), and the rarer of
  //            the two modulation idioms.
  //   7 the hero picture. A `panel` cell's first LEGAL rank is 7 —
  //     module-face-lint fails any panel SELECTED at a lane tier ("a 380px
  //     panel in a 46px knob column") — and 7 is also its place in the story.
  face: {
    order: [
      // ranks 1-6 ARE the lane budget; nothing here is dock-only.
      'tune',
      'shape',
      'fmAmount',
      'pw',
      'fine',
      'pmAmount',
      // THE HERO PICTURE — one cycle of all five wave taps, drawn from the live
      // knobs through the DSP's own tap laws. Rank 7 = the first rank a panel
      // can legally hold (see above).
      'analogvco-cycle-{n}',
    ],
    // TWO bands, not three, and the split is by WHAT THE KNOB REACHES rather
    // than by knob-vs-modulation. Filing FM under "modulation" would be wrong:
    // FM lands in the same exponent as TUNE and FINE (analog-vco.dsp:25), so it
    // is a pitch control, and PM does not touch the pitch at all. Splitting
    // them apart is the whole teaching; lumping them as "modulation" is the
    // thing the DSP says is wrong.
    //
    // ⚠ THE PER-KNOB REACH IS CARRIED BY CLUSTERS, NOT BY HINTS. Every hint on
    // this face is OFF by default (annotations are per-viewer), so a band that
    // needs its hint to explain which tap each knob addresses says nothing at
    // rest — which is the exact defect this face was promoted to fix. A cluster
    // sub-header is ~14px and paints ALWAYS (ModuleShell renders `.page-cluster`
    // outside the annotations gate), so the three reaches are stated at rest,
    // per knob, for the price of one band.
    pages: [
      {
        id: 'pitch',
        label: '1 · pitch — all six outputs',
        hint:
          'V/OCT, TUNE (semitones), FINE (cents) and FM all land in ONE exponent before the ' +
          'pow2: 261.626 Hz x 2^(v/oct + tune/12 + fine/1200 + FM x fm). FM is exponential too, ' +
          'so FM at 1.0 against a +/-1 modulator is +/-12 semitones — and a negative FM inverts ' +
          'the MODULATOR (a 180 degree flip), it does not reverse the sweep direction. SYNC OUT ' +
          'fires once per cycle, so it tracks this band as well.',
        controls: ['tune', 'fine', 'fmAmount'],
      },
      {
        id: 'wave',
        label: '2 · waveform — tap by tap',
        hint:
          'One accumulator, read three different ways. SHAPE crossfades saw to sine to square on ' +
          'the MORPH tap alone (the four fixed taps are selected independently). PW is the SQUARE ' +
          'tap duty ALWAYS, and reaches the morph only in proportion to 2 x SHAPE - 1 — at the ' +
          'shipped SHAPE of 0 that is exactly zero, which is why PW can look dead there. PM ' +
          'offsets the read phase on all five wave taps; SYNC OUT is driven from the pre-PM ' +
          'accumulator, so PM never moves it. Nothing in this band is band-limited.',
        controls: ['analogvco-cycle-{n}', 'shape', 'pw', 'pmAmount'],
        clusters: [
          { label: 'morph tap only', controls: ['shape'] },
          { label: 'square tap · morph square end', controls: ['pw'] },
          { label: 'all five wave taps', controls: ['pmAmount'] },
        ],
      },
    ],
    glyph: 'scope',

    title: 'Oscillator',
    hint:
      'One phase accumulator, six taps. SAW, TRIANGLE and SINE are always themselves; PW sets ' +
      'the SQUARE duty; SHAPE crossfades the MORPH tap alone. FM is exponential (octaves) and ' +
      'moves the pitch; PM is a phase offset (cycles) applied at the read, so it never moves ' +
      'SYNC OUT.',

    // THE HERO. The picture and TUNE are PROMOTED out of their bands, not
    // copied — `heroFacePlan` removes them, so the param multiset faces-parity
    // asserts is unchanged. Band 2's flat control row empties (the panel was its
    // only unclustered cell) and the band SURVIVES on its three clusters.
    hero: {
      cell: 'analogvco-cycle-{n}',
      control: 'tune',
    },

    // REAR CARD. Derivation is already total here (four non-CV inputs into the
    // leading band, the five CV holes into their page bands, the six outputs
    // into the rail); only two things are curated.
    //
    // The leading band's derived label is `voice`, which says nothing a patcher
    // can act on. These four are the ports that reach the oscillator CORE per
    // sample — the DSP's own `process(pitch, fm, pm, sync)` — as opposed to the
    // five CV jacks, which displace a knob through an `si.smoo` AudioParam.
    // That distinction IS the band, so the band is named for it.
    //
    // audioRate: exactly those four, and the citation is the DSP signature, not
    // a habit. The five CV jacks are deliberately NOT listed: every knob passes
    // `si.smoo` (analog-vco.dsp:8-20), tau ~ 22.7 ms at 48 kHz, so a `~` tick on
    // them would promise per-sample FM on a 23 ms slew.
    rear: {
      groups: [{ id: 'voice', label: 'core inputs', ports: ['pitch', 'fm', 'pm', 'sync'] }],
      audioRate: ['pitch', 'fm', 'pm', 'sync'],
    },
  },

  // The ONE BESPOKE PANEL (PF-14) this faceplate needs: one cycle of all five
  // wave taps, drawn from the live knobs through the DSP's own tap laws — the
  // four fixed taps as thin ghosts, MORPH in the domain hue. No amount of def
  // introspection synthesises "what one cycle of the morph looks like at shape
  // 0.62 and pw 0.31", and drawing the five together is what makes "SHAPE moves
  // exactly one of these" VISIBLE instead of written.
  //
  // Declared as a one-member control family for the same reason kickdrum's is:
  // a real control with no backing ParamDef, so the face can RANK it, the docs
  // can key prose to it, and shell-cells can name the component. It writes no
  // param and emits no `control-<paramId>` testid.
  controlFamilies: [
    { id: 'analogvco-cycle', label: 'Single-cycle taps', kind: 'cell', testidPrefix: 'analogvco-cycle' },
  ],

  docs: {
    explanation:
      "The analog VCO is a classic-topology voltage-controlled oscillator: ONE phase accumulator read six different ways. Four fixed taps (sawtooth, square, triangle, sine) sound simultaneously on separate outputs, a fifth crossfades saw → sine → square under the shape parameter, and a sixth emits a one-sample pulse at every cycle boundary for chaining hard sync. It accepts V/oct pitch CV with coarse/fine tuning, exponential audio-rate frequency modulation and phase modulation with bipolar depth controls, and a hard-sync input that resets the phase. The mental model is a single oscillator core with multiple simultaneous taps plus an interactive waveform morpher — patch the raw waveforms to filters/mixers, use morph for smooth real-time texture, and chain sync ports for rich polysynth interactions. ⚠ It is analog in TOPOLOGY only, not in modelling: the taps are computed naively with no band-limiting (no PolyBLEP, no oversampling), and no drift, noise, saturation or DC blocker anywhere — so it aliases audibly high in its range and stays perfectly, un-analog-ly stable at the bottom of it.",
    inputs: {
      pitch:
        "V/oct pitch input (0V = C4) that drives the oscillator frequency; modulated by the tune, fine, and FM inputs together to set the final sounding pitch.",
      fm: "Audio-rate frequency modulation input (typically an LFO or envelope), scaled by the fmAmount parameter to add wobble, vibrato, or dramatic pitch sweeps without changing the coarse tuning.",
      pm: "Audio-rate phase modulation input (typically an LFO or envelope), scaled by the pmAmount parameter to add timbre modulation and metallic character, especially effective on the square and triangle taps.",
      sync: "Hard-sync input that resets this oscillator's phase to zero on every rising edge, allowing you to lock its waveform to a master oscillator for rich, metallic, or aliased tones. When unpatched, the VCO output is unchanged from a version with no sync port.",
      tune: "CV modulation of the tune parameter (semitones); displaces the coarse pitch knob left/right so an external LFO or sequencer can transpose in whole-step intervals without affecting fine tuning.",
      fine: "CV modulation of the fine parameter (cents); displaces the fine tuning knob left/right for subtle pitch micro-adjustments or vibrato-style modulation around the coarse pitch.",
      fmAmount:
        "CV modulation of the FM depth; displaces the FM-depth knob left/right to dynamically scale how much the fm input affects the pitch — turn it up to let an envelope open the frequency sweep, or down to tighten it.",
      pmAmount:
        "CV modulation of the PM depth; displaces the PM-depth knob left/right to dynamically scale how much the pm input affects the phase and timbre — open it up from an envelope to add evolving color.",
      shape:
        "CV modulation of the morph output waveform (0 = sawtooth, 0.5 = sine, 1 = square); displaces the shape knob left/right so an external LFO, envelope, or sequencer can crossfade the morph output through the three classic waveforms in real time.",
    },
    outputs: {
      saw: "The raw sawtooth waveform (rich harmonic content, bright and buzzy), always sounding at the pitch CV regardless of the shape or morph knob.",
      square:
        "The raw square/pulse waveform (hollow, woody tone), pulse width set by the pw parameter — use this tap to feed a filter or as-is for bright synth bass.",
      triangle:
        "The raw triangle waveform (softer than square, more mellow), useful for warmth or blended with other taps through a mixer.",
      sine: "The pure sine waveform (no harmonics, pure fundamental), ideal for clean sub-bass, tone modulation, or as a base mixed with other waveforms.",
      morph:
        "Continuous morphing output that sweeps from sawtooth (shape = 0) through sine (shape = 0.5) to square (shape = 1) as the shape parameter changes; shaped by the shape knob and its CV input, and reflects any FM/PM modulation in real time. The on-card scope displays this output live so you see the crossfade happening.",
      sync: "Hard-sync output — a one-sample +1 pulse at each cycle boundary (phase wrap) so it can clock another VCO's sync input for chained oscillator interactions or external gear. When unplugged, the sync output is silent.",
    },
    controls: {
      "analogvco-cycle-{n}":
        "One cycle of all five wave taps, drawn from the live knobs rather than from the audio: SAW, SQUARE, TRIANGLE and SINE as thin ghosts with MORPH picked out in the audio hue, every one read off the same phase the DSP uses. It is the fastest way to see what the knob row hides — turn WAVE and only the MORPH trace moves; turn PW and SQUARE moves with it, while MORPH follows only once WAVE is past its midpoint. The CYCLES button switches the window between one and two periods and relabels the axis with the period the knobs currently imply; that is a private view setting, so zooming your own plot changes nothing for anyone else in the rackspace.",
      tune: "Coarse pitch in semitones (−36 to +36) — shift the whole oscillator up or down by whole-step intervals. With CV modulation on, knob + CV add together, so a sequencer can select octaves while the knob sets a base pitch.",
      fine: "Fine tuning in cents (−100 to +100, one cent = 1/100 of a semitone) — apply a perfectly-tuned unison detune when stacked with another oscillator, or dial in an exact note without coarse octave shifts.",
      fmAmount:
        "Depth of frequency modulation from the FM input (−1 to +1) — 0 means the fm input has no effect. The modulation is EXPONENTIAL and measured in octaves: it lands in the same exponent as tune and fine, so a depth of 1.0 against a ±1 modulator is ±12 semitones. The sign INVERTS THE MODULATOR (a 180° phase flip), it does not choose a direction — against the bipolar LFO you would normally patch here, +0.5 and −0.5 sweep the same distance up and down and differ only in phase. (Only for a strictly unipolar modulator does the sign read as up-versus-down.) Patch an LFO here for vibrato, or ramp it from an envelope for dramatic pitch drops.",
      pmAmount:
        "Depth of phase modulation from the PM input (−1 to +1) — 0 means the pm input has no effect. Higher values shift the morph timbre more dramatically per unit of PM signal; use this to add envelope-driven color changes.",
      pw: "Pulse width of the square waveform (0.05 to 0.95, duty cycle) — 0.5 is a perfect square, lower values create thin nasal pulses, higher values create inverted thin pulses. It is live on the SQUARE output from the moment the module spawns; it reaches the MORPH output only in proportion to 2 x Wave - 1, so at the shipped Wave of 0 it does nothing to the morph at all. Note there is no PW CV jack (the five CV inputs are tune, fine, fmAmount, pmAmount and shape), so a PWM sweep has to come from automation or MIDI-learn rather than from a cable.",
      shape:
        "Waveform selector for the morph output (0 to 1) — 0 = sawtooth, 0.5 = sine, 1 = square. Knob + CV modulation add together, so a sequencer or LFO can smoothly sweep through all three classic waveforms.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const faustNode = await instantiateFaustModule(ctx, { name: 'analog-vco', wasmUrl, metaUrl, workletUrl }, node);

    // ChannelMerger routes per-port mono signals to distinct channels of
    // Faust's single multi-channel input. This is what makes sequencer.pitch
    // affect ONLY the pitch channel without bleeding into fm/pm/sync.
    // Channel map mirrors the DSP's process(pitch, fm, pm, sync):
    //   0 = pitch, 1 = fm, 2 = pm, 3 = sync.
    const merger = ctx.createChannelMerger(4);
    merger.connect(faustNode);
    // Feed silence to every merger input so the node stays in the active
    // processing graph even when nothing's externally patched. Without this,
    // a fresh module (no inputs connected) doesn't process and there's no audio.
    // Silence on the sync channel (3) is what guarantees backward-compat: the
    // DSP's rising-edge detector never fires on a constant 0, so phase reset is
    // never triggered and the output is identical to a VCO with no sync port.
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    silence.connect(merger, 0, 0);
    silence.connect(merger, 0, 1);
    silence.connect(merger, 0, 2);
    silence.connect(merger, 0, 3);

    // Splitter for the 6-channel output (saw / square / triangle / sine /
    // morph / sync_out).
    const splitter = ctx.createChannelSplitter(6);
    faustNode.connect(splitter);

    // Live single-cycle waveform tap. An AnalyserNode hangs off the MORPH
    // output (channel 4) so the on-card scope draws exactly what the morph
    // emits — reflecting both the `shape` knob/CV AND any FM / pitch / PM
    // modulation in real time (the analyser sees the post-DSP signal). It's a
    // pure sink (never connected onward), so it adds no load to the audio path.
    const scopeAnalyser = ctx.createAnalyser();
    scopeAnalyser.fftSize = 2048;
    scopeAnalyser.smoothingTimeConstant = 0;
    splitter.connect(scopeAnalyser, 4);
    const scopeBuf = new Float32Array(scopeAnalyser.fftSize);

    const params = faustNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of analogVcoDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(`${PARAM_PREFIX}/${def.id}`)?.setValueAtTime(v, ctx.currentTime);
    }

    // Current oscillator frequency in Hz, used by the card to size one period.
    // Mirrors the DSP's freqHz(): 261.626 Hz (C4) × 2^(pitch + tune/12 +
    // fine/1200). pitch is the live V/oct CV (audio-rate) which we can't read
    // here, so the card falls back to zero-crossing windowing when the morph
    // is FM'd / pitched away from the knob-implied frequency.
    function currentFreqHz(): number {
      const tune = params.get(`${PARAM_PREFIX}/tune`)?.value ?? 0;
      const fine = params.get(`${PARAM_PREFIX}/fine`)?.value ?? 0;
      const f = 261.626 * Math.pow(2, tune / 12 + fine / 1200);
      return Math.min(20000, Math.max(1, f));
    }

    return {
      domain: 'audio',
      inputs: new Map([
        ['pitch', { node: merger, input: 0 }],
        ['fm',    { node: merger, input: 1 }],
        ['pm',    { node: merger, input: 2 }],
        ['sync',  { node: merger, input: 3 }],
        // CV → AudioParam routing. The engine's addEdge fast-path uses `param`
        // to interpose the cvScale chain so an LFO ±1 sweeps the param's
        // natural range centered on the knob position.
        ['tune',     { node: faustNode, input: 0, param: params.get(`${PARAM_PREFIX}/tune`)!     }],
        ['fine',     { node: faustNode, input: 0, param: params.get(`${PARAM_PREFIX}/fine`)!     }],
        ['fmAmount', { node: faustNode, input: 0, param: params.get(`${PARAM_PREFIX}/fmAmount`)! }],
        ['pmAmount', { node: faustNode, input: 0, param: params.get(`${PARAM_PREFIX}/pmAmount`)! }],
        ['shape',    { node: faustNode, input: 0, param: params.get(`${PARAM_PREFIX}/shape`)!    }],
      ]),
      outputs: new Map([
        ['saw',      { node: splitter, output: 0 }],
        ['square',   { node: splitter, output: 1 }],
        ['triangle', { node: splitter, output: 2 }],
        ['sine',     { node: splitter, output: 3 }],
        ['morph',    { node: splitter, output: 4 }],
        ['sync',     { node: splitter, output: 5 }],
      ]),
      setParam(paramId, value) {
        params.get(`${PARAM_PREFIX}/${paramId}`)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(`${PARAM_PREFIX}/${paramId}`)?.value;
      },
      // The on-card single-cycle scope reads this snapshot on rAF. `freqHz` is
      // the knob-implied frequency for window sizing; the buffer is the live
      // morph output so the trace reflects shape + modulation as it happens.
      read(key) {
        if (key !== 'waveform') return undefined;
        scopeAnalyser.getFloatTimeDomainData(scopeBuf);
        return { data: scopeBuf, sampleRate: ctx.sampleRate, freqHz: currentFreqHz() };
      },
      dispose() {
        try { silence.stop(); } catch { /* already stopped */ }
        silence.disconnect();
        merger.disconnect();
        faustNode.disconnect();
        splitter.disconnect();
        scopeAnalyser.disconnect();
      },
    };
  },
};

/** Shape of the live waveform snapshot read via `engine.read(node, 'waveform')`.
 *  Exported so the card + tests share one type. */
export interface VcoWaveformSnapshot {
  /** Float time-domain samples from the morph-output analyser ([-1, 1)). */
  data: Float32Array;
  sampleRate: number;
  /** Knob-implied fundamental in Hz (tune/fine only — used to size one period
   *  when zero-crossing detection can't lock a cycle). */
  freqHz: number;
}
