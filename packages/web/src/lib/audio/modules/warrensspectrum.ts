// packages/web/src/lib/audio/modules/warrensspectrum.ts
//
// WARREN'S SPECTRUM — spectral-resynth engine, PHASE 1.
//
// A port of the SPECTRAL engine of the Warren's Spectrum VST (CMake project
// id `callsine`; `PRODUCT_NAME` is already "Warren's Spectrum"), MIT-licensed:
//   Upstream:   https://github.com/2600hz-oscillator/callsine
//   Copyright (c) 2026 callsine contributors  (MIT — one-way compatible with our AGPL)
//
// This module REPLACES two retired modules:
//   * `callsine`       — ALIASED here (persistence.ts RETIRED_TYPE_ALIASES).
//                        Four ports survive with matching semantics; see the
//                        PORT-ID CONTRACT below.
//   * `warrenspectrum` — DROPPED (it was a stereo 8-band vactrol-ping
//                        resonator bank: 0 of its 43 ports and 0 of its 16
//                        params map onto a mono spectral contract, so an
//                        alias would be a different instrument wearing the
//                        old node's id). Old nodes take the visible
//                        unknown-type drop path.
//   Design + the full migration argument: .myrobots/plans/warrens-spectrum-2026-08-02.md
//
// ── ⚠ PORT-ID CONTRACT (load-bearing, not cosmetic) ───────────────────────
// `audio_in` / `pitch` / `gate` / `out` are the FOUR ports a saved `callsine`
// node keeps across the alias. Renaming any of them silently voids the
// migration — every cable on a migrated node would be dropped by
// validateEdge and the alias would deliver nothing. `warrensspectrum.test.ts`
// asserts all four by exact id, so a rename fails a test rather than a user's
// rack.
//
// ── PHASE 1 SCOPE ─────────────────────────────────────────────────────────
// SPECTRAL engine only, MONO. NOT in phase 1: the 8-band filterbank (and so
// no stereo — pan lives in the bank), the WAVETABLE and MASSPASS engines, the
// feedback loop, the two FX slots, the master filter, host-tempo SLICE, and
// `.wspr` fingerprint interchange. That is ~11 of the plugin's 104 runtime
// params. Patch the rack for the rest — we have one.
//
// ── DELIBERATE DIVERGENCES FROM THE VST ───────────────────────────────────
// 1. SLICE is CORRECT, not faithful: the whole declared 2..200 ms range works
//    here. The VST clamps its analysis hop to fftSize*0.5 with fftOrder
//    hardcoded at 11, so ~90 % of its own declared VALUE range and the top
//    ~61 % of the knob's travel are unreachable. We ship its `setSliceMs`
//    with that one clamp deleted and nothing else changed — its sibling
//    engine MassPass already honours the full range with no FFT ceiling
//    (MassPass.cpp:206-214), so the intended range was never ambiguous.
//    The 10 ms DEFAULT is under the clamp upstream, so it is bit-identical
//    to the plugin (proved: removing the ceiling left all three ART `.f32`
//    baselines byte-for-byte unchanged). See the dsp lib's test for the
//    permanent negative control that sweeps the full range — including
//    non-round values — and proves SLICE still moves above 21.33 ms.
// 2. PARTIALS ceilings at 256, not 892 — 4× the plugin's own default (64),
//    2× its default cap (128). At 892 the O(peaks×tracks) matcher eats ~53 %
//    of one AudioWorklet quantum on a fast machine, for ONE instance.
// 3. The VST's separate PARTIAL CAP choice param is NOT ported: the 256
//    ceiling IS the cap, so a second control would only restate the range.
//
// Param ids deliberately match the VST's `RangedAudioParameter` ids
// (`src/PluginParams.h`) so a future `.wspr` fingerprint import/export
// (phase 5) is a straight key lookup rather than a mapping table.
//
// Inputs:
//   audio_in (audio): mono signal to analyse + resynthesize.
//   pitch (pitch): V/oct — transposes the resynth output post-analysis.
//   gate (gate): FREEZE while high (level-sensitive, both edges).
//   partials_cv (cv, linear, paramTarget=spectralPartials): displaces the partial count.
//   lock_cv (cv, linear, paramTarget=spectralLock): displaces harmonic-lock strength.
//   residual_cv (cv, linear, paramTarget=spectralResidual): displaces the noise-residual level.
//   shape_cv (cv, linear, paramTarget=spectralShape): displaces the voice waveform morph.
//   slice_cv (cv, linear, paramTarget=spectralSlice): displaces the analysis period.
//   center_cv (cv, linear, paramTarget=spectralCenter): displaces the transposition in cents.
//
// Outputs:
//   out (audio): the mono resynth — tracked partials plus the SMS residual.
//
// Params:
//   spectralPartials (discrete 1..256, default 64): oscillator-bank size.
//   spectralFloor (linear -90..-20 dB, default -42): peak threshold below the loudest bin.
//   spectralStab (discrete 1..16, default 3): frames a partial must persist before it sounds.
//   spectralLock (linear 0..1, default 0.75): harmonic-comb snap strength.
//   spectralResidual (linear 0..2, default 0.5): SMS noise-residual level.
//   spectralShape (linear 0..1, default 0): sine → saw → square voice morph.
//   spectralSlew (linear 0.02..4 s, default 0.6): partial amplitude/frequency smoothing.
//   spectralSlice (linear 2..200 ms, default 10): analysis period.
//   spectralCenter (linear -3600..3600 cents, default 0): output transposition.
//   engineFreeze (discrete 0..1, default 0): FREEZE latch.
//   gain (linear -60..12 dB, default 0): output level.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
// The engine's OWN constants, imported via a RELATIVE path (not the
// `@patchtogether.live/dsp/src/...` alias) for the same reason cube.ts /
// sample-hold.ts do: worktrees may not symlink the workspace package under
// node_modules, and the TS path-alias rules don't reliably resolve TS source
// out of node_modules/@patchtogether.live/dsp/src. Importing them is what
// keeps the def's declared ranges and the DSP's clamps from drifting apart.
import {
  WS_MAX_TRACKS,
  WS_SLICE_MAX_MS,
  WS_SLICE_MIN_MS,
} from '../../../../../dsp/src/lib/warrensspectrum-dsp';
import workletUrl from '@patchtogether.live/dsp/dist/warrensspectrum.js?url';

const loadedContexts = new WeakSet<BaseAudioContext>();

/**
 * The FOUR port ids a saved `callsine` node carries across the alias. Exported
 * so the migration test and the def read the SAME list — a gate that re-types
 * the strings could not see a rename here.
 */
export const WARRENSSPECTRUM_ALIASED_PORT_IDS = ['audio_in', 'pitch', 'gate', 'out'] as const;

/** Param ranges live HERE and nowhere else. The card imports them rather than
 *  re-typing the numbers (CLAUDE.md: "a control's range must come from ONE
 *  place" — the backdraft XyPad defect). */
export const WARRENSSPECTRUM_RANGES = {
  spectralPartials: { min: 1, max: WS_MAX_TRACKS, defaultValue: 64 },
  spectralFloor: { min: -90, max: -20, defaultValue: -42 },
  spectralStab: { min: 1, max: 16, defaultValue: 3 },
  spectralLock: { min: 0, max: 1, defaultValue: 0.75 },
  spectralResidual: { min: 0, max: 2, defaultValue: 0.5 },
  spectralShape: { min: 0, max: 1, defaultValue: 0 },
  spectralSlew: { min: 0.02, max: 4, defaultValue: 0.6 },
  spectralSlice: { min: WS_SLICE_MIN_MS, max: WS_SLICE_MAX_MS, defaultValue: 10 },
  spectralCenter: { min: -3600, max: 3600, defaultValue: 0 },
  engineFreeze: { min: 0, max: 1, defaultValue: 0 },
  gain: { min: -60, max: 12, defaultValue: 0 },
} as const satisfies Record<string, { min: number; max: number; defaultValue: number }>;

export const warrensspectrumDef: AudioModuleDef = {
  // ⚠ DOUBLE-S, deliberately. The retired resonator bank was `warrenspectrum`
  // (one s). Re-using that string would make every old resonator node resolve
  // SILENTLY against this def — no alias entry, no diagnostic — reinstating by
  // accident the exact "present but a different instrument" outcome the
  // migration rejects on purpose, and doing it below the layer that would have
  // reported it. The distinct id is what makes the drop observable.
  type: 'warrensspectrum',
  palette: { top: 'Audio modules', sub: 'Effects' },
  domain: 'audio',
  label: "warren's spectrum",
  category: 'effects',
  ossAttribution: { author: "callsine contributors (Warren's Spectrum)" },

  // NO chainWiring override. Unlike its `callsine` predecessor (a pitch+gate
  // VOICE whose lone audio input was an exciter, hence role:'source'), this is
  // an EFFECT: `audio_in` IS the signal-chain insert. The port inference reads
  // that correctly on its own, and declaring 'source' here would make the
  // reconciler treat a silent, unpatched analyser as a chain head.

  inputs: [
    // Audio under analysis. Mono.
    { id: 'audio_in', type: 'audio' },
    // V/oct → transposes the entire resynth output post-analysis, on top of
    // the CENTER control. Same function `pitch` had on callsine.
    { id: 'pitch', type: 'pitch' },
    // FREEZE while HIGH. Declared `edge: 'gate'` because it is genuinely
    // level-sensitive — the VST's engineFreeze is a held boolean, and
    // CLAUDE.md forbids converting a gate consumer to edge-only.
    { id: 'gate', type: 'gate', edge: 'gate', label: 'FREEZE' },
    // CV → AudioParam fast paths on the six performative controls.
    { id: 'partials_cv', type: 'cv', paramTarget: 'spectralPartials', cvScale: { mode: 'linear' } },
    { id: 'lock_cv', type: 'cv', paramTarget: 'spectralLock', cvScale: { mode: 'linear' } },
    { id: 'residual_cv', type: 'cv', paramTarget: 'spectralResidual', cvScale: { mode: 'linear' } },
    { id: 'shape_cv', type: 'cv', paramTarget: 'spectralShape', cvScale: { mode: 'linear' } },
    { id: 'slice_cv', type: 'cv', paramTarget: 'spectralSlice', cvScale: { mode: 'linear' } },
    { id: 'center_cv', type: 'cv', paramTarget: 'spectralCenter', cvScale: { mode: 'linear' } },
  ],
  outputs: [{ id: 'out', type: 'audio' }],
  params: [
    { id: 'spectralPartials', label: 'Partials', ...WARRENSSPECTRUM_RANGES.spectralPartials, curve: 'discrete' },
    { id: 'spectralLock', label: 'Lock', ...WARRENSSPECTRUM_RANGES.spectralLock, curve: 'linear' },
    { id: 'spectralResidual', label: 'Residual', ...WARRENSSPECTRUM_RANGES.spectralResidual, curve: 'linear' },
    { id: 'spectralSlice', label: 'Slice', ...WARRENSSPECTRUM_RANGES.spectralSlice, curve: 'linear', units: 'ms' },
    { id: 'engineFreeze', label: 'Freeze', ...WARRENSSPECTRUM_RANGES.engineFreeze, curve: 'discrete',
      format: (v) => (v >= 0.5 ? 'FREEZE' : 'LIVE'),
      options: [
        { value: 0, label: 'LIVE', title: 'The analyser keeps tracking the input' },
        { value: 1, label: 'FREEZE', title: 'Hold the current partials — the bank drones on them' },
      ] },
    { id: 'spectralShape', label: 'Shape', ...WARRENSSPECTRUM_RANGES.spectralShape, curve: 'linear',
      landmarks: [
        { value: 0, label: 'SINE' },
        { value: 0.5, label: 'SAW' },
        { value: 1, label: 'SQUARE' },
      ] },
    { id: 'spectralFloor', label: 'Floor', ...WARRENSSPECTRUM_RANGES.spectralFloor, curve: 'linear', units: 'dB' },
    { id: 'spectralStab', label: 'Stability', ...WARRENSSPECTRUM_RANGES.spectralStab, curve: 'discrete' },
    { id: 'spectralSlew', label: 'Slew', ...WARRENSSPECTRUM_RANGES.spectralSlew, curve: 'linear', units: 's' },
    { id: 'spectralCenter', label: 'Center', ...WARRENSSPECTRUM_RANGES.spectralCenter, curve: 'linear', units: 'cents' },
    { id: 'gain', label: 'Gain', ...WARRENSSPECTRUM_RANGES.gain, curve: 'linear', units: 'dB' },
  ],

  docs: {
    explanation:
      "A spectral-analysis resynthesizer — a port of the SPECTRAL engine of the Warren's Spectrum VST. It listens to whatever audio you patch into AUDIO IN, runs a rolling 2048-point FFT, finds the loudest sinusoidal peaks, tracks them from frame to frame, and rebuilds the sound as a bank of up to 256 oscillators. Crucially it ALSO rebuilds the part a partial tracker normally throws away: the energy left over after the peaks are claimed is measured in 16 log-spaced bands and replayed as filtered noise (the SMS \"residual\"). That residual is what keeps breath, air and sibilance in the sound — the plugin's own source calls it the number-one fix for the vocoder/robot vibe — so at RESIDUAL 0 an \"sss\" vanishes and at RESIDUAL 2 it comes back. Because the rebuild is an oscillator bank you can transpose it cleanly (CENTER, or a V/oct cable), thin it out (PARTIALS), recolour every partial from sine through saw to square (SHAPE), snap the partials onto a harmonic series (LOCK), smear it in time (SLEW), change how often it re-analyses (SLICE), or hold the current spectrum forever (FREEZE). It is an EFFECT, not a synth: with nothing patched into AUDIO IN it is silent. It is also mono and monophonic — N voices means N instances.",
    inputs: {
      audio_in:
        'The mono audio to analyse and rebuild — a synth voice, a drum loop, a vocal, a whole mix. Nothing patched here means no output: this module resynthesizes what it hears, it does not generate on its own.',
      pitch:
        'A 1V/oct pitch input that transposes the whole rebuilt spectrum after analysis, so it shifts pitch without time-stretching. It multiplies with the CENTER control rather than replacing it.',
      gate:
        'FREEZE while the gate is HIGH. Hold it and the oscillator bank keeps playing the frequencies and amplitudes it last acquired — a sustain, not a buffer loop — so SHAPE, CENTER and SLEW still work on the held spectrum. Let it fall and analysis resumes from live audio. It reacts to the LEVEL, not just the edge, so a long gate is a long freeze.',
      partials_cv: 'CV that adds to PARTIALS, opening the bank up or collapsing it toward the fundamental.',
      lock_cv: 'CV that adds to LOCK, sweeping between the raw analysed frequencies and an exact harmonic comb.',
      residual_cv: 'CV that adds to RESIDUAL, fading the noise half of the resynthesis in and out.',
      shape_cv: 'CV that adds to SHAPE, morphing every partial between sine, saw and square.',
      slice_cv: 'CV that adds to SLICE, modulating how often the spectrum is re-analysed — the rhythmic axis.',
      center_cv: 'CV that adds to CENTER, transposing the output in cents.',
    },
    outputs: {
      out: 'The mono resynthesis: the tracked partials rendered by the oscillator bank, plus the 16-band noise residual, transposed and levelled. Held steady while FREEZE is engaged.',
    },
    controls: {
      spectralPartials:
        'How many tracked partials the oscillator bank plays, 1 to 256, ranked by SALIENCE rather than raw loudness — so turning it down collapses toward the fundamental and its low harmonics instead of toward whichever formant happened to be loudest. It is also the CPU dial, and it scales the residual by the cube root of (PARTIALS−1)/47, so thinning the bank cleans up the noise too. 1 is a bare fundamental; 64 (the plugin default) is a full rebuild.',
      spectralLock:
        'Pulls each tracked partial toward the nearest exact multiple of the detected fundamental. 0 leaves partials where the analysis found them (faithful, inharmonic, a bit warbly on voice); 1 snaps them onto a harmonic comb (musical, more synthetic). Only partials already within about 100 cents of a harmonic are moved, so formants and noise are left alone — and the whole effect is multiplied by the pitch-detector confidence, so it self-disengages on unpitched material.',
      spectralResidual:
        'Level of the SMS noise residual: the energy left in the spectrum after every tracked peak is masked out, measured in 16 log-spaced bands from 80 Hz up and replayed through band-passed noise. 0 gives you the pure sinusoidal bank (the classic vocoder/robot sound); 0.5 is the plugin default; 2 puts back more breath and air than the input had. This is the control that decides whether the module sounds like a machine or like the source.',
      spectralSlice:
        'How often the spectrum is re-analysed, 2 to 200 ms. Short values track transients and make the module chatter with the source; long values sample it and hold, which is where the stuttering, stepping, pad-like character lives. The analysis WINDOW is always 2048 samples (about 43 ms), so a long SLICE slows the update rate without blurring what each frame sees. Note: the original plugin declares this same 2–200 ms range but internally clamps it at about 21 ms, so most of its knob does nothing — here the whole range works.',
      engineFreeze:
        'Holds the current set of partials — their frequencies and amplitudes — so the bank drones on that spectrum no matter what the input does. It holds oscillator state rather than looping a buffer, which is why it sustains rather than stutters, and why SHAPE, CENTER and SLEW still change a frozen sound. The GATE input does the same thing while it is high; the two OR together.',
      spectralShape:
        'The waveform every partial uses: sine at 0, band-limited saw at 0.5, band-limited square at 1, crossfading smoothly in between. At 0 this is a faithful additive resynthesis; past that each partial sprouts its own harmonic series, which thickens and dirties the whole rebuild.',
      spectralFloor:
        'The peak-detection threshold, in dB BELOW THE LOUDEST BIN of each frame — not an absolute level. Stricter (toward −20 dB) admits only the dominant peaks and starves the bank; more permissive (toward −90 dB) lets quiet detail and noise floor become tracked partials. Works together with STABILITY: FLOOR decides what is loud enough, STABILITY decides what has lasted long enough.',
      spectralStab:
        'How many consecutive analysis frames a partial must survive before it is allowed to make sound, 1 to 16. It fades in over that window rather than hard-unmuting. Low values track fast and chirp on noisy material; high values suppress the short-lived flickering peaks that make a partial tracker sound like beeping robots.',
      spectralSlew:
        'Smoothing time for each partial, 0.02 to 4 seconds — applied to amplitude per sample and to frequency per analysis frame. Short values follow the input crisply; long values glide partials between analyses, smearing the resynthesis into an evolving pad. Frequency smoothing is also why a partial drifting between FFT bins glides instead of chirping.',
      spectralCenter:
        'Transposes the rebuilt spectrum by up to ±3600 cents (±3 octaves), applied after analysis so the whole bank moves coherently and the tracking is unaffected. Adds to whatever the V/oct PITCH input contributes.',
      gain: 'Output level in dB, −60 to +12.',
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    // Three audio-rate inputs: audio (0), pitch (1), gate (2). The CV →
    // AudioParam routings ride into input 0; the engine attaches them to the
    // AudioParam directly via the `param:` field below.
    const workletNode = new AudioWorkletNode(ctx, 'warrensspectrum', {
      numberOfInputs: 3,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of warrensspectrumDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['audio_in', { node: workletNode, input: 0 }],
        ['pitch', { node: workletNode, input: 1 }],
        ['gate', { node: workletNode, input: 2 }],
        ['partials_cv', { node: workletNode, input: 0, param: params.get('spectralPartials')! }],
        ['lock_cv', { node: workletNode, input: 0, param: params.get('spectralLock')! }],
        ['residual_cv', { node: workletNode, input: 0, param: params.get('spectralResidual')! }],
        ['shape_cv', { node: workletNode, input: 0, param: params.get('spectralShape')! }],
        ['slice_cv', { node: workletNode, input: 0, param: params.get('spectralSlice')! }],
        ['center_cv', { node: workletNode, input: 0, param: params.get('spectralCenter')! }],
      ]),
      outputs: new Map([['out', { node: workletNode, output: 0 }]]),
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      dispose() {
        try {
          workletNode.disconnect();
        } catch {
          /* */
        }
      },
    };
  },
};
