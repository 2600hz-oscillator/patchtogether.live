// packages/web/src/lib/audio/modules/swolevco.ts
//
// SWOLEVCO — Buchla 259-style complex waveform generator. The "swoleVCO"
// of the patchtogether.live oscillator lineup: two oscillators in one
// module, audio-rate cross-modulation ("timbre"), waveform morph
// ("symmetry"), West-Coast wavefolder, plus a mono-video scope output of
// the primary signal. Pure JS Web Audio — no Faust DSP — modeled after
// ILLOGIC's structure.
//
// Architecture:
//
//   PRIMARY OSC (3 OscillatorNodes — saw, triangle, square, all on the
//   SAME frequency) → 3-way symmetry crossfade GainNodes → wavefolder
//   (4x oversampled WaveShaperNode, shared buildFoldCurve helper)
//   → output bus.
//
//   MODULATOR OSC (single OscillatorNode, sine) → modulator output port
//   AND → timbreGain (×timbre amount × 200 Hz of deviation) → connected
//   to each PRIMARY OSC's .frequency AudioParam (audio-rate FM).
//
//   SUM OUT = output bus + modulator (summed via a GainNode bus).
//
//   SCOPE = AnalyserNode tap on the output bus (post-fold, pre-sum). The
//   shared waveform-video.ts renderer in the VideoEngine consumes this
//   when a video edge is patched to the `scope` port.
//
// Pitch convention (matches the project, see analog-vco.dsp):
//   pitch CV is 1V/oct, 0V = C4 = 261.626 Hz. We compute base Hz from
//   the (tune semitones + fine cents) knobs as a MULTIPLIER of 261.626;
//   the pitch-CV connection then routes through a "voct → freqMul"
//   audio-rate processor (a WaveShaperNode whose curve is
//   261.626 * 2^(x*K)) such that each volt = one octave shift. We don't
//   have an AudioWorkletProcessor for that — the cleanest pure-JS path
//   is to drive .frequency directly from a ConstantSource on a base Hz
//   and let the user CV input modulate via a parallel scaling network.
//
//   Pragmatic reality for v1: we set the OscillatorNode's intrinsic
//   .frequency from (tune+fine) on knob change; pitch CV input feeds an
//   intermediate WaveShaperNode that converts V/oct → Hz multiplier
//   (centered around 261.626 Hz baseline). The output of that goes to
//   .frequency as additional Hz. This gives correct V/oct behavior for
//   the common case where pitch CV is the dominant driver (sequencer,
//   keyboard).
//
// Timbre = audio-rate FM amount. modulator → timbreGain (range 0..200 Hz
// of deviation per fully-open knob) → primary .frequency AudioParam.
//
// Symmetry = 0..1, three-way crossfade across saw / triangle / square:
//   * 0.0  → saw only
//   * 0.5  → triangle only
//   * 1.0  → square only
//   * In between, linear blend between adjacent shapes.
// Implementation: each shape oscillator feeds its own GainNode whose
// .gain is computed JS-side from `symmetry` and updated via setParam.
//
// Fold = 0..1, shared helper with WAVVIZ (4x oversample WaveShaperNode
// with sin foldback curve).
//
// Inputs:
//   pitch (pitch): V/oct pitch input, drives the primary oscillator.
//   mod_pitch (pitch): V/oct pitch input for the modulator oscillator.
//   fm (audio): external audio-rate FM modulator routed to the primary.
//   timbre (cv, linear, paramTarget=timbre): displaces the timbre (FM) amount.
//   symmetry (cv, linear, paramTarget=symmetry): displaces the saw↔tri↔square crossfade.
//   fold (cv, linear, paramTarget=fold): displaces the wavefold amount.
//   ratio (cv, linear, paramTarget=ratio): displaces the modulator-to-primary ratio.
//
// Outputs:
//   out (audio): primary post-fold waveform.
//   mod_out (audio): the modulator oscillator's sine output (patchable as a clean sine source).
//   sum_out (audio): primary + modulator summed (mix tap).
//   scope (mono-video): live oscilloscope trace of `out`.
//
// Params:
//   tune (linear -36..36 st, default 0): primary coarse tune.
//   fine (linear -100..100 ¢, default 0): primary fine tune.
//   mod_tune (linear -36..36 st, default 0): modulator coarse tune.
//   mod_fine (linear -100..100 ¢, default 0): modulator fine tune.
//   ratio (linear 0..8, default 1.0): modulator-to-primary frequency ratio.
//   timbre (linear 0..1, default 0): audio-rate FM amount from modulator → primary.
//   symmetry (linear 0..1, default 0.5): three-way crossfade saw / tri / square.
//   fold (linear 0..1, default 0): West-Coast wavefolder amount.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { buildFoldCurve } from '$lib/audio/fold-curve';

/** Base Hz at 0V/oct = C4 = 261.626 Hz (matches analog-vco.dsp). */
const C4_HZ = 261.626;

/** Maximum FM deviation (Hz) at timbre = 1.0. 200Hz at C4 is roughly
 *  ±4 semitones — enough to reach Buchla territory without veering
 *  into noise. */
const TIMBRE_MAX_HZ = 200;

/** V/oct → Hz table size. Range: ±5 octaves around C4 covers MIDI 12..108
 *  which is more than the project's MIN_MIDI..MAX_MIDI range. */
const VOCT_LUT_LEN = 4096;
const VOCT_RANGE = 5; // ±5 V

/** Build a curve mapping V/oct (in [-VOCT_RANGE, +VOCT_RANGE]) to Hz
 *  delta (relative to baseHz at 0V). The WaveShaperNode applies this to
 *  any audio-rate signal patched to the pitch input.
 *
 *  curve[i] = baseHz * (2^v - 1)
 *  where v = (i / (N-1)) * 2 * VOCT_RANGE - VOCT_RANGE.
 *
 *  At v=0V: curve = 0  (no contribution; baseHz handled separately).
 *  At v=1V: curve = baseHz × 1 = baseHz (one octave up = 2× freq, i.e.
 *           +baseHz Hz of additional frequency).
 *
 *  The OscillatorNode's intrinsic .frequency is set to baseHz, so:
 *    finalFreq = baseHz + curve(voct) = baseHz × 2^voct  ✓
 *
 *  Returned as Float32Array on a fresh ArrayBuffer (TS strict typed-array
 *  signature requirement for WaveShaperNode.curve).
 */
export function buildVoctCurve(baseHz: number): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(new ArrayBuffer(VOCT_LUT_LEN * 4));
  for (let i = 0; i < VOCT_LUT_LEN; i++) {
    const v = (i / (VOCT_LUT_LEN - 1)) * 2 * VOCT_RANGE - VOCT_RANGE;
    curve[i] = baseHz * (Math.pow(2, v) - 1);
  }
  return curve;
}

/** Compute the per-shape gains for a given symmetry value ∈ [0, 1].
 *  Three-way crossfade: saw (s=0) → triangle (s=0.5) → square (s=1).
 *  Linear blends between adjacent shapes; ALWAYS sums to 1.0.
 *
 *  Pure helper extracted so the unit test can pin the math.
 */
export function symmetryGains(symmetry: number): {
  saw: number;
  triangle: number;
  square: number;
} {
  const s = Math.max(0, Math.min(1, symmetry));
  if (s <= 0.5) {
    // Saw → triangle blend.
    const t = s * 2; // [0, 1]
    return { saw: 1 - t, triangle: t, square: 0 };
  } else {
    // Triangle → square blend.
    const t = (s - 0.5) * 2; // [0, 1]
    return { saw: 0, triangle: 1 - t, square: t };
  }
}

/** Compute the BASE frequency (Hz) from tune (semitones) + fine (cents). */
export function tuneFineToHz(tuneSt: number, fineCents: number): number {
  return C4_HZ * Math.pow(2, tuneSt / 12 + fineCents / 1200);
}

// Module-grouping Phase 3A: `vizPassthrough` is available on AudioModuleDef
// for SWOLEVCO's on-card scope-style viz canvas. Left UNSET until the
// card adopts the `data-viz-passthrough` <canvas> contract used by
// ScopeCard for GroupCard portal-hoisting.
export const swolevcoDef: AudioModuleDef = {
  type: 'swolevco',
  palette: { top: 'Hybrid', sub: 'Hybrid' },
  domain: 'audio',
  label: 'swolevco',
  category: 'sources',
  schemaVersion: 1,
  inputs: [
    { id: 'pitch',     type: 'pitch' },
    { id: 'mod_pitch', type: 'pitch' },
    { id: 'fm',        type: 'audio' },
    // CV scaling per .myrobots/plans/cv-range-standard.md (LFO ±1 sweeps
    // each param's full natural range centered on the knob).
    { id: 'timbre',    type: 'cv', paramTarget: 'timbre',   cvScale: { mode: 'linear' } },
    { id: 'symmetry',  type: 'cv', paramTarget: 'symmetry', cvScale: { mode: 'linear' } },
    { id: 'fold',      type: 'cv', paramTarget: 'fold',     cvScale: { mode: 'linear' } },
    { id: 'ratio',     type: 'cv', paramTarget: 'ratio',    cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'out',     type: 'audio' },
    { id: 'mod_out', type: 'audio' },
    { id: 'sum_out', type: 'audio' },
    { id: 'scope',   type: 'mono-video' },
  ],
  params: [
    { id: 'tune',     label: 'Tune',  defaultValue: 0,   min: -36,  max: 36,  curve: 'linear', units: 'st' },
    { id: 'fine',     label: 'Fine',  defaultValue: 0,   min: -100, max: 100, curve: 'linear', units: '¢' },
    { id: 'mod_tune', label: 'M.Tn',  defaultValue: 0,   min: -36,  max: 36,  curve: 'linear', units: 'st' },
    { id: 'mod_fine', label: 'M.Fn',  defaultValue: 0,   min: -100, max: 100, curve: 'linear', units: '¢' },
    // ratio = 0 means "free run" (modulator pitch is independent, driven by
    // mod_tune + mod_fine + mod_pitch CV). ratio > 0 means "modulator
    // frequency = primary frequency × ratio".
    { id: 'ratio',    label: 'Ratio', defaultValue: 1.0, min: 0,    max: 8,   curve: 'linear' },
    { id: 'timbre',   label: 'Tbr',   defaultValue: 0,   min: 0,    max: 1,   curve: 'linear' },
    { id: 'symmetry', label: 'Sym',   defaultValue: 0.5, min: 0,    max: 1,   curve: 'linear' },
    { id: 'fold',     label: 'Fold',  defaultValue: 0,   min: 0,    max: 1,   curve: 'linear' },
  ],

  docs: {
    explanation: "A complex / West-Coast-style dual oscillator: two oscillators in one module that interact to build harmonically rich timbres rather than just stacking simple shapes. A PRIMARY oscillator (crossfaded across saw / triangle / square by Symmetry, then run through a wavefolder) is the main voice; a sine MODULATOR oscillator, tuned either to a Ratio of the primary's pitch or to its own M.Tune / M.Fine, cross-modulates the primary via audio-rate FM (the Timbre amount). Mental model: start from a near-sine, then warp the wave with Symmetry, fold it with Fold, and pour FM in with Timbre to climb from sweet to screaming — all from one pitch. You can tap the primary alone (OUT), the clean modulator sine alone (MOD OUT), or the two summed together (SUM OUT), and a mono-video oscilloscope of the primary is available on SCOPE.",
    inputs: {
      pitch: "1V/oct pitch CV for the PRIMARY oscillator (0V = C4 = 261.626 Hz), summed on top of the Tune / Fine knobs. When Ratio is greater than 0 the modulator tracks this pitch (modulator frequency = primary × Ratio), so a sequencer or keyboard patched here moves both oscillators together.",
      mod_pitch: "1V/oct pitch CV for the MODULATOR oscillator (0V = C4), summed on top of M.Tune / M.Fine. Most useful in free-run mode (Ratio = 0) where the modulator has its own pitch; with Ratio greater than 0 the modulator is largely slaved to the primary and this adds on top of that base.",
      fm: "External audio-rate FM into the PRIMARY oscillator: an incoming audio signal is scaled (full-scale ±1 ≈ ±200 Hz of deviation) and summed into the primary's frequency, on top of the internal Timbre FM. Drive it from a VCA or another oscillator for cross-FM beyond the built-in modulator.",
      timbre: "CV that displaces the Timbre control (audio-rate FM amount from the modulator into the primary); an LFO or envelope here opens and closes the FM brightness over time.",
      symmetry: "CV that displaces the Symmetry control, sliding the saw → triangle → square waveform crossfade of the primary oscillator up or down.",
      fold: "CV that displaces the Fold control, modulating how hard the West-Coast wavefolder folds the primary signal — patch an envelope here for evolving fold timbres.",
      ratio: "CV that displaces the Ratio control, sweeping the modulator-to-primary frequency ratio. Pushing it through 0 toggles the modulator between free-run (its own M.Tune / M.Fine pitch) and ratio-locked (a multiple of the primary's pitch).",
    },
    outputs: {
      out: "The PRIMARY oscillator: the symmetry-crossfaded saw/tri/square wave after the wavefolder, including any Timbre / external FM. This is the main voice and the signal the SCOPE traces.",
      mod_out: "The MODULATOR oscillator's raw sine output, before it is mixed in — a clean sine tap you can patch anywhere as an independent oscillator (e.g. as an LFO or a second voice) at the modulator's pitch.",
      sum_out: "The PRIMARY and MODULATOR summed into one signal (each at half level to leave headroom). With Timbre up this is the cross-modulated mix — the primary already FM'd by the modulator, plus the modulator's own sine on top — for a thicker, two-oscillator blend.",
      scope: "A mono-video oscilloscope trace of the primary signal (OUT), tapped post-fold. Patch a video cable from here into a scope / display module to watch the waveform; it is a video output, not audio.",
    },
    controls: {
      tune: "Coarse tuning of the PRIMARY oscillator in semitones (-36 to +36, i.e. ±3 octaves) relative to C4; combines with Fine and any pitch CV to set the base pitch.",
      fine: "Fine tuning of the PRIMARY oscillator in cents (-100 to +100, ±1 semitone) for beating / detune against the modulator or other voices.",
      mod_tune: "Coarse tuning of the MODULATOR oscillator in semitones (±3 octaves). Active when Ratio = 0 (free-run); when Ratio is greater than 0 the modulator follows the primary × Ratio and this is ignored.",
      mod_fine: "Fine tuning of the MODULATOR oscillator in cents (±1 semitone), for free-run detune. Like M.Tune, it only takes effect when Ratio = 0.",
      ratio: "Modulator-to-primary frequency ratio (0 to 8). At 0 the modulator free-runs at its own M.Tune / M.Fine pitch; above 0 the modulator frequency is the primary's frequency × this value (1 = unison, 2 = octave up, etc.), so it tracks the primary's pitch for harmonically related FM.",
      timbre: "Audio-rate FM amount: how much the modulator deviates the primary's frequency (0 to 1, where 1 ≈ ±200 Hz at C4). 0 leaves the primary clean; turning it up grows the sidebands from a gentle vibrato-like shimmer into clangorous, bell-like and noisy Buchla-style timbres.",
      symmetry: "Morphs the PRIMARY waveform across a three-way crossfade (0 to 1): 0 = saw, 0.5 = triangle, 1 = square, with a linear blend of the two neighboring shapes in between. Default 0.5 (pure triangle).",
      fold: "West-Coast wavefolder amount on the primary (0 to 1): 0 is no folding; raising it folds the wave back on itself, adding harmonics and that characteristic complex-oscillator brightness/buzz even on a plain triangle.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const initialParams = node.params ?? {};
    const initial = {
      tune:     (initialParams.tune     ?? 0)   as number,
      fine:     (initialParams.fine     ?? 0)   as number,
      mod_tune: (initialParams.mod_tune ?? 0)   as number,
      mod_fine: (initialParams.mod_fine ?? 0)   as number,
      ratio:    (initialParams.ratio    ?? 1.0) as number,
      timbre:   (initialParams.timbre   ?? 0)   as number,
      symmetry: (initialParams.symmetry ?? 0.5) as number,
      fold:     (initialParams.fold     ?? 0)   as number,
    };

    // ---------------- Primary oscillators (3 shapes) ----------------
    //
    // OscillatorNode primitives (sawtooth/triangle/square/sine) are
    // bandlimited per the W3C spec — Web Audio implementations use BLEP
    // or polynomial-bandlimited tables under the hood. We get aliasing-
    // free shapes for free.
    const baseHz = tuneFineToHz(initial.tune, initial.fine);
    function makeOsc(type: OscillatorType): OscillatorNode {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(baseHz, ctx.currentTime);
      o.start();
      return o;
    }
    const oscSaw = makeOsc('sawtooth');
    const oscTri = makeOsc('triangle');
    const oscSqr = makeOsc('square');

    // Per-shape symmetry crossfade gains.
    const symGains = symmetryGains(initial.symmetry);
    const gSaw = ctx.createGain();
    gSaw.gain.value = symGains.saw;
    const gTri = ctx.createGain();
    gTri.gain.value = symGains.triangle;
    const gSqr = ctx.createGain();
    gSqr.gain.value = symGains.square;
    oscSaw.connect(gSaw);
    oscTri.connect(gTri);
    oscSqr.connect(gSqr);

    // Sum the three shape outputs into a primary bus.
    const primaryBus = ctx.createGain();
    primaryBus.gain.value = 1;
    gSaw.connect(primaryBus);
    gTri.connect(primaryBus);
    gSqr.connect(primaryBus);

    // ---------------- Wavefolder (post-symmetry) ----------------
    const folder = ctx.createWaveShaper();
    folder.oversample = '4x';
    let currentFold = initial.fold;
    folder.curve = buildFoldCurve(currentFold);
    primaryBus.connect(folder);

    // Output bus (post-fold). This is the `out` port AND the source for
    // the scope analyser AND one of the two summands for sum_out.
    const outBus = ctx.createGain();
    outBus.gain.value = 1;
    folder.connect(outBus);

    // ---------------- Modulator (sine) ----------------
    const modOsc = ctx.createOscillator();
    modOsc.type = 'sine';
    // Initial modulator frequency: if ratio > 0, modulator = primary × ratio;
    // if ratio = 0, modulator = its own (mod_tune + mod_fine).
    const initialModHz = initial.ratio > 0
      ? baseHz * initial.ratio
      : tuneFineToHz(initial.mod_tune, initial.mod_fine);
    modOsc.frequency.setValueAtTime(initialModHz, ctx.currentTime);
    modOsc.start();

    // Modulator output bus (kept as a buffer so we can fan-out to
    // mod_out, sum_out, and the timbre-FM path).
    const modBus = ctx.createGain();
    modBus.gain.value = 1;
    modOsc.connect(modBus);

    // ---------------- Timbre = audio-rate FM amount ----------------
    //
    // Modulator → timbreGain (×TIMBRE_MAX_HZ × timbre value) → primary
    // .frequency AudioParam. Web Audio sums modulator inputs into the
    // AudioParam, so this is true audio-rate FM with proper sample
    // accuracy. We connect ONCE per primary oscillator (saw/tri/sqr —
    // they all need the same FM input).
    const timbreGain = ctx.createGain();
    timbreGain.gain.setValueAtTime(initial.timbre * TIMBRE_MAX_HZ, ctx.currentTime);
    modBus.connect(timbreGain);
    timbreGain.connect(oscSaw.frequency);
    timbreGain.connect(oscTri.frequency);
    timbreGain.connect(oscSqr.frequency);

    // ---------------- External FM input → primary frequency ----------------
    //
    // The `fm` input port lets a user route an external audio signal as
    // an additional FM source. Same pattern as timbre, but no scaling
    // (1V of input = 1Hz of frequency deviation). For musically useful
    // amounts the user typically drives this from a VCA whose output is
    // already amplitude-shaped.
    const fmIn = ctx.createGain();
    fmIn.gain.value = TIMBRE_MAX_HZ; // scale 1.0 audio level → 200 Hz dev
    fmIn.connect(oscSaw.frequency);
    fmIn.connect(oscTri.frequency);
    fmIn.connect(oscSqr.frequency);

    // ---------------- Pitch CV (V/oct → Hz) ----------------
    //
    // Inbound pitch CV (V/oct, 0V = C4) is converted to a frequency
    // delta via a WaveShaper LUT. Output is connected to all three
    // primary oscillators' .frequency AudioParams (and to the modulator's
    // when ratio==0; otherwise the modulator tracks the primary).
    //
    // Note: when `tune`+`fine` change we rebuild the LUT (baseHz changes).
    // Knob updates are rare relative to audio rate, so the rebuild cost
    // is irrelevant.
    const pitchVoctShaper = ctx.createWaveShaper();
    pitchVoctShaper.curve = buildVoctCurve(baseHz);
    // WaveShaperNode reads input as [-1, +1] and maps proportionally to the
    // curve's index range. Our curve maps a V/oct input ∈ [-VOCT_RANGE,
    // +VOCT_RANGE] to a Hz delta, so the incoming V/oct CV has to be scaled
    // down by 1/VOCT_RANGE first or every input above ±1V saturates to the
    // curve's endpoint (= ±VOCT_RANGE octaves), giving the oscillator a
    // usable range of only ~2 semitones around C4. The fix: pitchScaler =
    // GainNode(gain = 1/VOCT_RANGE) interposed between input + shaper, so a
    // +1V input lands at the +1V point on the curve (= baseHz delta = one
    // octave up). The `pitch` input port now terminates on pitchScaler so
    // CV connections feed the scaled chain.
    const pitchScaler = ctx.createGain();
    pitchScaler.gain.value = 1 / VOCT_RANGE;
    pitchScaler.connect(pitchVoctShaper);
    pitchVoctShaper.connect(oscSaw.frequency);
    pitchVoctShaper.connect(oscTri.frequency);
    pitchVoctShaper.connect(oscSqr.frequency);

    // Same for the modulator pitch input — independent V/oct → Hz LUT,
    // routed to the modulator only when ratio==0 (free-run mode).
    let modBaseHz = initialModHz;
    const modPitchVoctShaper = ctx.createWaveShaper();
    modPitchVoctShaper.curve = buildVoctCurve(modBaseHz);
    const modPitchScaler = ctx.createGain();
    modPitchScaler.gain.value = 1 / VOCT_RANGE;
    modPitchScaler.connect(modPitchVoctShaper);
    // Always connect; when ratio>0 the modulator's frequency is overridden
    // (we'll set modOsc.frequency directly and the V/oct contribution adds
    // on top, which is correct: pitch CV always tracks).
    modPitchVoctShaper.connect(modOsc.frequency);

    // ---------------- Sum output bus ----------------
    const sumBus = ctx.createGain();
    sumBus.gain.value = 0.5; // scale to avoid clipping (out + mod can exceed ±1)
    outBus.connect(sumBus);
    modBus.connect(sumBus);

    // ---------------- Scope analyser tap ----------------
    const scopeAnalyser = ctx.createAnalyser();
    scopeAnalyser.fftSize = 2048;
    scopeAnalyser.smoothingTimeConstant = 0;
    outBus.connect(scopeAnalyser);

    // ---------------- CV-shadow gains (cv-tap analyser support) ----------------
    //
    // For the four scalar CV-modulated knobs (timbre / symmetry / fold /
    // ratio) the engine's per-param tap analyser needs an AudioParam to
    // observe modulator activity for the motorized fader rendering. We
    // expose the underlying gain.gain AudioParam of an internal
    // ConstantSource → GainNode pair. setParam still owns the actual
    // application of the value (timbre changes timbreGain.gain; symmetry
    // re-balances gSaw/gTri/gSqr; fold rebuilds the WaveShaper curve;
    // ratio recomputes modOsc.frequency).
    function makeShadow(initialValue: number): GainNode {
      const g = ctx.createGain();
      g.gain.setValueAtTime(initialValue, ctx.currentTime);
      const sink = ctx.createConstantSource();
      sink.offset.value = 0;
      sink.start();
      sink.connect(g);
      shadowSinks.push(sink);
      return g;
    }
    const shadowSinks: ConstantSourceNode[] = [];
    const sTimbre   = makeShadow(initial.timbre);
    const sSymmetry = makeShadow(initial.symmetry);
    const sFold     = makeShadow(initial.fold);
    const sRatio    = makeShadow(initial.ratio);

    // Track current param values so setParam handlers can read them when
    // they need cross-derivations (e.g. ratio change recomputes mod freq
    // from current baseHz).
    const live: Record<string, number> = { ...initial };

    function recomputePrimaryHz() {
      const bh = tuneFineToHz(live.tune ?? 0, live.fine ?? 0);
      oscSaw.frequency.setValueAtTime(bh, ctx.currentTime);
      oscTri.frequency.setValueAtTime(bh, ctx.currentTime);
      oscSqr.frequency.setValueAtTime(bh, ctx.currentTime);
      pitchVoctShaper.curve = buildVoctCurve(bh);
      // If modulator tracks via ratio, recompute its base too.
      if ((live.ratio ?? 1) > 0) {
        const mh = bh * (live.ratio ?? 1);
        modOsc.frequency.setValueAtTime(mh, ctx.currentTime);
        modBaseHz = mh;
        modPitchVoctShaper.curve = buildVoctCurve(mh);
      }
    }
    function recomputeModHz() {
      let mh: number;
      if ((live.ratio ?? 1) > 0) {
        const bh = tuneFineToHz(live.tune ?? 0, live.fine ?? 0);
        mh = bh * (live.ratio ?? 1);
      } else {
        mh = tuneFineToHz(live.mod_tune ?? 0, live.mod_fine ?? 0);
      }
      modOsc.frequency.setValueAtTime(mh, ctx.currentTime);
      modBaseHz = mh;
      modPitchVoctShaper.curve = buildVoctCurve(mh);
    }

    return {
      domain: 'audio',
      inputs: new Map([
        ['pitch',     { node: pitchScaler,    input: 0 }],
        ['mod_pitch', { node: modPitchScaler, input: 0 }],
        ['fm',        { node: fmIn,               input: 0 }],
        // CV-modulated params: route to the shadow GainNode whose .gain
        // is the AudioParam the engine sees. setParam pulls these into
        // the actual DSP nodes.
        ['timbre',   { node: sTimbre,   input: 0, param: sTimbre.gain   }],
        ['symmetry', { node: sSymmetry, input: 0, param: sSymmetry.gain }],
        ['fold',     { node: sFold,     input: 0, param: sFold.gain     }],
        ['ratio',    { node: sRatio,    input: 0, param: sRatio.gain    }],
      ]),
      outputs: new Map([
        ['out',     { node: outBus, output: 0 }],
        ['mod_out', { node: modBus, output: 0 }],
        ['sum_out', { node: sumBus, output: 0 }],
      ]),
      videoSources: new Map([
        ['scope', { analyser: scopeAnalyser, sampleRate: ctx.sampleRate }],
      ]),
      setParam(paramId, value) {
        switch (paramId) {
          case 'tune':
          case 'fine':
            live[paramId] = value;
            recomputePrimaryHz();
            return;
          case 'mod_tune':
          case 'mod_fine':
            live[paramId] = value;
            // Only relevant when ratio==0; the recompute checks.
            recomputeModHz();
            return;
          case 'ratio':
            live.ratio = value;
            sRatio.gain.setValueAtTime(value, ctx.currentTime);
            recomputeModHz();
            return;
          case 'timbre':
            live.timbre = value;
            sTimbre.gain.setValueAtTime(value, ctx.currentTime);
            timbreGain.gain.setValueAtTime(value * TIMBRE_MAX_HZ, ctx.currentTime);
            return;
          case 'symmetry': {
            live.symmetry = value;
            sSymmetry.gain.setValueAtTime(value, ctx.currentTime);
            const g = symmetryGains(value);
            gSaw.gain.setValueAtTime(g.saw, ctx.currentTime);
            gTri.gain.setValueAtTime(g.triangle, ctx.currentTime);
            gSqr.gain.setValueAtTime(g.square, ctx.currentTime);
            return;
          }
          case 'fold':
            live.fold = value;
            sFold.gain.setValueAtTime(value, ctx.currentTime);
            currentFold = value;
            folder.curve = buildFoldCurve(value);
            return;
        }
      },
      readParam(paramId) {
        switch (paramId) {
          case 'tune':     return live.tune;
          case 'fine':     return live.fine;
          case 'mod_tune': return live.mod_tune;
          case 'mod_fine': return live.mod_fine;
          case 'ratio':    return live.ratio;
          case 'timbre':   return live.timbre;
          case 'symmetry': return live.symmetry;
          case 'fold':     return currentFold;
        }
        return undefined;
      },
      dispose() {
        try { oscSaw.stop(); } catch { /* */ }
        try { oscTri.stop(); } catch { /* */ }
        try { oscSqr.stop(); } catch { /* */ }
        try { modOsc.stop(); } catch { /* */ }
        for (const s of shadowSinks) {
          try { s.stop(); } catch { /* */ }
          s.disconnect();
        }
        oscSaw.disconnect();
        oscTri.disconnect();
        oscSqr.disconnect();
        modOsc.disconnect();
        gSaw.disconnect();
        gTri.disconnect();
        gSqr.disconnect();
        primaryBus.disconnect();
        folder.disconnect();
        outBus.disconnect();
        modBus.disconnect();
        timbreGain.disconnect();
        fmIn.disconnect();
        pitchScaler.disconnect();
        pitchVoctShaper.disconnect();
        modPitchScaler.disconnect();
        modPitchVoctShaper.disconnect();
        sumBus.disconnect();
        scopeAnalyser.disconnect();
        sTimbre.disconnect();
        sSymmetry.disconnect();
        sFold.disconnect();
        sRatio.disconnect();
      },
    };
  },
};
