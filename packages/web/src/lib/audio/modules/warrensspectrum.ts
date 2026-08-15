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
// ── SCOPE (phase 1 + phase 2 + phase 4) ───────────────────────────────────
// PHASE 1 shipped the SPECTRAL engine, MONO.
// PHASE 2 adds the 8-band resonant FILTERBANK — and with it STEREO, because
// the per-band equal-power pan is the only stage in the plugin's whole chain
// that makes an image (`PluginProcessor::processBlock` sums to mono before
// the engine and `resynthBuf_` is one channel). It also adds the bank's two
// routing controls, FILTERBANK WET (`resynthLevel`) and INPUT MIX.
// PHASE 4 adds the SECOND ENGINE, MASSPASS (`engineMode`), plus its band-count
// choice (`spectralBandCount`). MASSPASS is a separate 326-line DSP class
// upstream and a separate module here (`warrensspectrum-masspass.ts`) — no
// FFT, no peak tracking: N log-spaced bandpasses each reporting their own
// level and zero-crossing pitch, sampled and held at SLICE. Everything
// downstream of the DRY bus (wet crossfade, input mix, filterbank, gain) is
// mode-agnostic and shared, exactly as it is upstream.
//
// STILL ABSENT: the WAVETABLE engine, the feedback loop, the two FX slots
// (and so the bands' `fx1Send`/`fx2Send`, which would be controls with
// nowhere to send), the master filter, host-tempo SLICE, and `.wspr`
// fingerprint interchange. Patch the rack for the rest — we have one.
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
// 4. FILTERBANK WET (`resynthLevel`) defaults to **0**; upstream it is 1.
//    This is the one divergence that is about OUR history rather than the
//    plugin's: the bank is always in circuit upstream because it has always
//    been there, whereas this module SHIPPED without one, so defaulting it
//    in would silently re-voice every rack saved against phase 1. Opt-in
//    keeps a saved rack sounding exactly as recorded; turn it to 1 and the
//    routing is the plugin's. Evidence, not assertion: adding the bank left
//    all three ART `.f32` baselines byte-for-byte identical (only the `.sha`
//    pins moved), and `warrensspectrum-filterbank.test.ts` proves at the
//    unit level that a scrambled band table cannot move ONE sample at WET 0
//    while moving it a great deal at WET 1.
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
//   engineMode (discrete 0..1, default 0): 0 = SPECTRAL, 1 = MASSPASS.
//   spectralBandCount (discrete 0..5, default 1): MASSPASS band count, as an
//     INDEX into {16,24,33,48,66,99}. Inert in SPECTRAL.
//   gain (linear -60..12 dB, default 0): output level.
//
// ── PHASE-4 DIVERGENCES (in addition to 1-4 above) ────────────────────────
// 5. `engineMode`'s INDICES are ours, not the VST's (upstream MASSPASS is 2,
//    behind WAVETABLE at 1). Reserving the gap would have left index 1 live
//    but inert — dead control travel, which divergence 1 exists to refuse.
//    Ours append in implementation order; WAVETABLE takes 2.
// 6. FREEZE and the V/oct PITCH input WORK IN MASSPASS. Upstream both are
//    silently inert there (`PluginProcessor.cpp:219` freezes `resynth_`
//    only, and `MassPass` has no transposition at all). We expose FREEZE as
//    a gate INPUT PORT and pitch as a V/oct PORT, and a port that accepts a
//    cable and does nothing is a worse lie than a dead knob — it is
//    invisible until patched.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
// The engine's OWN constants, imported via a RELATIVE path (not the
// `@patchtogether.live/dsp/src/...` alias) for the same reason cube.ts /
// sample-hold.ts do: worktrees may not symlink the workspace package under
// node_modules, and the TS path-alias rules don't reliably resolve TS source
// out of node_modules/@patchtogether.live/dsp/src. Importing them is what
// keeps the def's declared ranges and the DSP's clamps from drifting apart.
import {
  WS_BAND_COUNT_IDX_DEFAULT,
  WS_BAND_COUNT_IDX_MAX,
  WS_BAND_COUNT_IDX_MIN,
  WS_ENGINE_MASSPASS,
  WS_ENGINE_MODE_MAX,
  WS_ENGINE_MODE_MIN,
  WS_ENGINE_SPECTRAL,
  WS_INPUT_MIX_MAX,
  WS_INPUT_MIX_MIN,
  WS_MASSPASS_BAND_COUNTS,
  WS_MAX_TRACKS,
  WS_SLICE_MAX_MS,
  WS_SLICE_MIN_MS,
  WS_WET_MAX,
  WS_WET_MIN,
} from '../../../../../dsp/src/lib/warrensspectrum-dsp';
import {
  WS_BAND_CUTOFF_MAX_HZ,
  WS_BAND_CUTOFF_MIN_HZ,
  WS_BAND_Q_MAX,
  WS_BAND_Q_MIN,
  WS_BAND_SEND_MAX,
  WS_BAND_SEND_MIN,
  WS_NUM_BANDS,
  wsDefaultBands,
  wsNormalizeBands,
  type WsBandSettings,
} from '../../../../../dsp/src/lib/warrensspectrum-filterbank';

// Re-exported so the CARD imports its band ranges from the DEF, never from
// the dsp package directly — same one-place-only rule as
// WARRENSSPECTRUM_RANGES, and the same relative-path reason the import above
// avoids the `@patchtogether.live/dsp` alias (a worktree may not symlink the
// workspace package into node_modules).
export { WS_NUM_BANDS, wsDefaultBands };
// The card needs the MASSPASS mode index to decide what to DIM. It reads it
// from the DEF (which re-exports the engine's constant) rather than writing
// `=== 1` — a re-typed literal is the same drift class as a re-typed range.
export { WS_ENGINE_MASSPASS, WS_ENGINE_SPECTRAL, WS_MASSPASS_BAND_COUNTS };
export type { WsBandSettings };
import workletUrl from '@patchtogether.live/dsp/dist/warrensspectrum.js?url';

import { createWorkletNode } from '$lib/audio/worklet-guard';
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
  // ENGINE MODE (phase 4). Range 0..1 — EVERY index in it is implemented.
  // Our numbering appends in implementation order and is deliberately not the
  // VST's; see WS_ENGINE_MASSPASS in the engine for why.
  engineMode: { min: WS_ENGINE_MODE_MIN, max: WS_ENGINE_MODE_MAX, defaultValue: WS_ENGINE_SPECTRAL },
  // MASSPASS BAND COUNT — an INDEX into WS_MASSPASS_BAND_COUNTS, exactly as
  // the VST declares it. Declaring the raw counts (16..99) instead would
  // require an 84-entry options roster to satisfy param-vocabulary's
  // "every discrete step is named" rule.
  spectralBandCount: {
    min: WS_BAND_COUNT_IDX_MIN,
    max: WS_BAND_COUNT_IDX_MAX,
    defaultValue: WS_BAND_COUNT_IDX_DEFAULT,
  },
  // ⚠ FILTERBANK WET defaults to 0, NOT the VST's 1.0. See the DIVERGENCES
  // block at the top of this file (divergence 4).
  resynthLevel: { min: WS_WET_MIN, max: WS_WET_MAX, defaultValue: 0 },
  inputMix: { min: WS_INPUT_MIX_MIN, max: WS_INPUT_MIX_MAX, defaultValue: 0 },
  gain: { min: -60, max: 12, defaultValue: 0 },
} as const satisfies Record<string, { min: number; max: number; defaultValue: number }>;

/**
 * The five per-band controls, declared ONCE — ranges, curve, units and label.
 *
 * These are NOT `ParamDef`s (the bank is a control FAMILY, not 40 params), so
 * `paramSpec()` cannot serve them and the card would otherwise hand-type
 * `min={20} max={20000} curve="log" units="Hz"`. That is precisely the
 * divergence class `card-range-source.test.ts` exists to stop, and it does
 * not care whether the control is backed by a ParamDef — a re-typed `curve`
 * puts the fader's midpoint a decade away from where the DSP's clamp is,
 * ParamDef or no ParamDef. So the family gets the same single source of
 * truth a param would have, with the bounds imported from the engine.
 */
export const WARRENSSPECTRUM_BAND_SPEC = {
  cutoffHz: { min: WS_BAND_CUTOFF_MIN_HZ, max: WS_BAND_CUTOFF_MAX_HZ, curve: 'log', units: 'Hz', label: 'Cutoff' },
  q: { min: WS_BAND_Q_MIN, max: WS_BAND_Q_MAX, curve: 'log', units: undefined, label: 'Res' },
  type: { min: 0, max: 1, curve: 'linear', units: undefined, label: 'Type' },
  pan: { min: -1, max: 1, curve: 'linear', units: undefined, label: 'Pan' },
  send: { min: WS_BAND_SEND_MIN, max: WS_BAND_SEND_MAX, curve: 'linear', units: undefined, label: 'Send' },
} as const satisfies Record<
  keyof WsBandSettings,
  { min: number; max: number; curve: 'log' | 'linear'; units: string | undefined; label: string }
>;

/** `node.data` key holding the 8-band table. */
export const WARRENSSPECTRUM_BANDS_KEY = 'wsBands';
/** `node.data` key holding the band-table revision counter — bumped by the
 *  card on every edit. The factory polls it, exactly as DX7 polls `voiceRev`,
 *  because a Yjs map mutation from a REMOTE peer arrives with no local
 *  callback and would otherwise never reach the worklet. */
export const WARRENSSPECTRUM_BANDS_REV_KEY = 'wsBandsRev';

/** Read the band table off a node, normalized. The card, the factory and the
 *  tests all come through here so an old/absent/partial table resolves to the
 *  SAME 8 bands everywhere. */
export function warrensspectrumBands(node: { data?: Record<string, unknown> } | undefined): WsBandSettings[] {
  const raw = node?.data?.[WARRENSSPECTRUM_BANDS_KEY];
  // A Yjs array proxy is not `Array.isArray`, so unwrap it to a plain array
  // first — `wsNormalizeBands` would otherwise fall back to the defaults for
  // a table that is genuinely present (the DX7 structured-clone scar).
  const arr = Array.isArray(raw) ? raw : raw && typeof (raw as { toJSON?: unknown }).toJSON === 'function'
    ? (raw as { toJSON(): unknown }).toJSON()
    : raw;
  return wsNormalizeBands(arr);
}

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
    // ENGINE MODE first: it selects between two different DSP CLASSES, so no
    // other control on the module changes more (plan §5.2 ranks it 1).
    //
    // ⚠ The roster names EVERY reachable index, and the range stops at the
    // last implemented one. The VST declares three modes and we ship two, so
    // rather than reserving its WAVETABLE slot (index 1) and leaving a live
    // control position that does nothing, our indices append in
    // implementation order — WAVETABLE will be 2. `param-vocabulary.test.ts`
    // enforces exactly this and caught the first draft, which had reserved
    // the gap.
    { id: 'engineMode', label: 'Mode', ...WARRENSSPECTRUM_RANGES.engineMode, curve: 'discrete',
      format: (v) => (Math.round(v) === WS_ENGINE_MASSPASS ? 'MASSPASS' : 'SPECTRAL'),
      options: [
        { value: WS_ENGINE_SPECTRAL, label: 'SPECTRAL',
          title: 'FFT peak-tracking resynthesis — follows a pitch, rebuilds it as tracked partials plus noise residual' },
        { value: WS_ENGINE_MASSPASS, label: 'MASSPASS',
          title: 'Filterbank resynthesis — N tuned resonators, each reporting what it hears, sampled and held at SLICE' },
      ] },
    { id: 'spectralBandCount', label: 'Bands', ...WARRENSSPECTRUM_RANGES.spectralBandCount, curve: 'discrete',
      format: (v) => String(WS_MASSPASS_BAND_COUNTS[Math.max(0, Math.min(WS_MASSPASS_BAND_COUNTS.length - 1, Math.round(v)))]),
      options: WS_MASSPASS_BAND_COUNTS.map((count, i) => ({
        value: i,
        label: String(count),
        title: `${count} bandpass filters, 50 Hz to 12 kHz — MASSPASS only`,
      })) },
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
    { id: 'resynthLevel', label: 'Bank Wet', ...WARRENSSPECTRUM_RANGES.resynthLevel, curve: 'linear' },
    { id: 'inputMix', label: 'Input Mix', ...WARRENSSPECTRUM_RANGES.inputMix, curve: 'linear' },
    { id: 'gain', label: 'Gain', ...WARRENSSPECTRUM_RANGES.gain, curve: 'linear', units: 'dB' },
  ],

  // The 8-band filterbank is ONE panel, not 40 cells. Per the plan's §5.3
  // ("the only honest way to fit this module"), the bank's five per-band
  // values live in `node.data` and are edited by a single addressable strip,
  // so they cost one doc blob and one face cell instead of forty.
  controlFamilies: [
    {
      id: 'ws-filterbank',
      label: 'Filterbank — 8 bands',
      kind: 'cell',
      testidPrefix: 'ws-band',
    },
  ],

  // ── THE CURATED FACEPLATE (PF-20) ────────────────────────────────────────
  //
  // WHAT THIS MODULE IS FOR, musically, in one paragraph — every rank below
  // descends from it. Warren's Spectrum is the rack's RE-BUILDER: you play it
  // something and it hands back a SYNTHESIZED copy of what it heard. Nothing
  // else here does that. A vocoder imposes one signal's envelope on another; a
  // filter subtracts; a granular chops and replays the recording itself. This
  // one ANALYSES and RE-SYNTHESIZES, so what comes back is an instrument: it
  // transposes cleanly, thins to a bare fundamental, morphs from sine to
  // square, snaps onto a harmonic comb, or freezes into a drone. The verb is
  // *patch a sound in, then decide how much of what it heard survives.*
  //
  // THE RANKING ARGUMENT, and it is one this module's siblings could not make:
  // there are TWO DSP CLASSES behind MODE, and FIVE of the thirteen dials
  // describe peak-tracking machinery MASSPASS does not have while a sixth
  // describes a bank SPECTRAL does not have. So the ladder is drawn on
  // UNCONDITIONAL APPLICABILITY: ranks 1-6 are EXACTLY the controls that are
  // live in both engines, and every mode-scoped control is demoted below them
  // regardless of how much authority it has in its own engine. `spectralLock`
  // moves the output more than `spectralShape` does (measured 8.2960e-1 vs
  // 5.9738e-1, art/scenarios/warrensspectrum/cv-path.test.ts) and still ranks
  // below it, because half the time it does nothing at all.
  //
  // Tier ladder as a sentence: *mini shows MODE — the one control that decides
  // what every other control means; compact adds PARTIALS; the six-cell lane
  // plate is the module in both engines (mode · partials · shape · slice ·
  // freeze · center); and the dock adds the two engines' private machinery,
  // the filterbank and the output trims.*
  //
  // ⚠ NO `hero.cell`. The filterbank is the obvious picture and it is BYPASSED
  // AT SPAWN (`resynthLevel` defaults to 0, divergence 4), so promoting it to
  // the hero slot would put an inert surface where the module's identity
  // belongs — the inertness-at-spawn check, doing real work. It ranks after
  // its own enabler instead.
  face: {
    order: [
      // 1-6: LIVE IN BOTH ENGINES. This is the whole lane budget.
      // Selects between two DSP CLASSES and re-defines five other controls.
      'engineMode',
      // The module's verb. Bank size in SPECTRAL, the active-band limiter in
      // MASSPASS — one knob, two meanings, and the CPU dial in both.
      'spectralPartials',
      // The voice waveform. The two engines render through the SAME shared
      // morph function, so this is the one timbre control that means exactly
      // the same thing whichever is selected.
      'spectralShape',
      // The rhythmic axis: the re-analysis period in SPECTRAL, the whole
      // sample-and-hold stepping in MASSPASS.
      'spectralSlice',
      // The module's one GESTURE, and the only control with a cable of its own
      // (the `gate` port ORs with it).
      'engineFreeze',
      // Transposition. Largest measured authority of any control here
      // (1.2228e+0) and honoured in both engines, unlike upstream.
      'spectralCenter',
      // 7+: MODE-SCOPED, so dock-only however much they do.
      // SPECTRAL's signature — the plugin's own header calls the residual the
      // "#1 fix for the vocaler/robot vibe".
      'spectralResidual',
      'spectralLock',
      // MASSPASS's identity control and its CPU dial (99 bands costs ~6x 16).
      'spectralBandCount',
      'spectralFloor',
      'spectralStab',
      'spectralSlew',
      // The bank's ENABLER, ranked immediately above the bank: at 0 the eight
      // SVFs are not merely quiet, `finishSample` returns before them.
      'resynthLevel',
      'ws-filterbank-{n}',
      'inputMix',
      'gain',
    ],

    // BY FUNCTION, in the DSP's own signal order — and DELIBERATELY DISAGREEING
    // with `order` in four places, because priority and signal flow genuinely
    // differ here:
    //   * `spectralBandCount` is rank 9 and sits in the FIRST band: it is part
    //     of choosing the engine, not part of tuning one.
    //   * `spectralLock` is rank 8 and sits with three lower-ranked controls,
    //     because LOCK is a property of the peak TRACKER, not of the voice.
    //   * `spectralCenter` is rank 6 and sits in `resynth`, because transposition
    //     is applied to the rendered bank, after everything else.
    //   * `resynthLevel` is rank 13 and HEADS the output band, because the rest
    //     of that band is inaudible until it moves.
    // The last band is `finishSample`'s own sequence (wet -> bank -> mix ->
    // gain), which is why the trims are not a page of their own.
    pages: [
      { id: 'engine', label: 'engine', controls: ['engineMode', 'spectralPartials', 'spectralBandCount'] },
      { id: 'analysis', label: 'analysis', controls: ['spectralFloor', 'spectralStab', 'spectralLock', 'spectralSlew'] },
      // ⚠ `resynth`, NOT `voice`. `rearFieldPlan` names the LEADING rear band
      // `voice` whenever the module's plain input ports carry gate/pitch drive
      // — which these do (`pitch` + `gate`) — so a page called `voice` would put
      // two adjacent bands with the same heading on the rear card, one of them
      // the jack field and the other three CV holes. `resynth` is also the
      // DSP's own word for this bus (`resynthBuf_` upstream, `resynthLevel`
      // here) and what the `out` readout prints for that path.
      { id: 'resynth', label: 'resynth', controls: ['spectralShape', 'spectralResidual', 'spectralCenter'] },
      { id: 'time', label: 'time', controls: ['spectralSlice', 'engineFreeze'] },
      { id: 'output', label: 'output', controls: ['resynthLevel', 'ws-filterbank-{n}', 'inputMix', 'gain'] },
    ],

    // A live tap on the output. UNLIT on a silent rack, which is correct AND
    // deterministic here rather than merely hoped: this is an EFFECT, and with
    // nothing patched into `audio_in` the output is bit-exactly zero (measured,
    // art/scenarios/warrensspectrum/cv-path.test.ts). No free-running voice, so
    // no analogVco-class VRT instability.
    glyph: 'meter',

    // A FADER where the control is a LEVEL or a THRESHOLD you mix between; a
    // KNOB where it is a morph, a time or a pitch. The card draws all fifteen
    // as faders, but that is a 360 px card-layout constraint (seven controls in
    // one row) and not a claim about the controls — and `fader` is
    // discrete-never, so the three rostered switches could not take it anyway.
    paramCells: {
      spectralResidual: 'fader',
      spectralFloor: 'fader',
      resynthLevel: 'fader',
      inputMix: 'fader',
      gain: 'fader',
    },

    hero: {
      // The module's VERB, not its rank-1 switch: PARTIALS is what a player
      // reaches for once the engine is chosen, it is live in both engines, and
      // it is the dial whose READING most needs the row beneath it — in
      // MASSPASS the same knob is re-clamped to the band count, so `64` can
      // mean 16. It MOVES out of the `engine` band, leaving MODE + BANDS there
      // (still two controls, so the band keeps its header).
      control: 'spectralPartials',
      // NO `cell` — see the note above the face: the bank is inert at spawn.
      readouts: [
        // FOUR derived values, each negative-controlled PERMANENTLY on the
        // input a knob readback is blind to
        // (`warrensspectrum-face-model.test.ts`), and each other's controls
        // where the arithmetic allows it.
        //
        // `spectralPartials` prints 64 in SPECTRAL, in MASSPASS at 99 bands and
        // in MASSPASS at 16 bands — where the answer is 16.
        { label: 'voices', valueId: 'warrensspectrum-voices' },
        // `spectralResidual` prints 0.50 at PARTIALS 1, where the residual is
        // bit-exactly absent (the cbrt((n-1)/47) factor is 0), and at PARTIALS
        // 64, where it is fully 0.50.
        { label: 'residual', valueId: 'warrensspectrum-residual' },
        // `spectralStab` prints 3 whether that costs 20 ms or 400 ms; the birth
        // ramp is counted in COMMITS, so its duration is SLICE-scaled.
        { label: 'fade in', valueId: 'warrensspectrum-fade-in' },
        // `gain` prints 0.0 dB while INPUT MIX 1 leaves the module +6.02 dB
        // hot; BANK WET moves the PATH half and cannot move the number.
        { label: 'out', valueId: 'warrensspectrum-out' },
      ],
    },
  },

  docs: {
    explanation:
      "A resynthesizer with TWO different engines behind one MODE switch — a port of the Warren's Spectrum VST. MODE picks between them and they are separate DSP code, not two settings of one algorithm. MASSPASS is the other engine: it never runs an FFT at all, instead splitting the input across 16 to 99 log-spaced bandpass filters from 50 Hz to 12 kHz and letting each band report its own level (a 3 ms / 80 ms envelope follower) and its own pitch (a smoothed zero-crossing rate). Those per-band readings are sampled and HELD at the SLICE interval, and each band's oscillator runs on the held values — that sample-and-hold is the engine's signature stepping, and it makes SLICE far more dramatic here than in SPECTRAL. Only the loudest PARTIALS-many bands sound; the rest keep tracking and keep their phase advancing so nothing pops when they return. It is coarser and more vocoder-like than SPECTRAL, and at low band counts it is also cheaper, because there is no FFT and no partial matcher. BANDS sets the count and is a timbre control, not a level one (the bank is normalised by 1/sqrt(N)). SHAPE, SLICE, FREEZE, CENTER and the V/oct input all work in both modes; LOCK, RESIDUAL, FLOOR, STABILITY and SLEW are SPECTRAL-only, because they describe peak-tracking machinery MASSPASS does not have. Switching modes is click-free: the output dips to silence for about 6 ms and returns on the new engine. The default engine is SPECTRAL, described next.\n\nA spectral-analysis resynthesizer — a port of the SPECTRAL engine of the Warren's Spectrum VST. It listens to whatever audio you patch into AUDIO IN, runs a rolling 2048-point FFT, finds the loudest sinusoidal peaks, tracks them from frame to frame, and rebuilds the sound as a bank of up to 256 oscillators. Crucially it ALSO rebuilds the part a partial tracker normally throws away: the energy left over after the peaks are claimed is measured in 16 log-spaced bands and replayed as filtered noise (the SMS \"residual\"). That residual is what keeps breath, air and sibilance in the sound — the plugin's own source calls it the number-one fix for the vocoder/robot vibe — so at RESIDUAL 0 an \"sss\" vanishes and at RESIDUAL 2 it comes back. Because the rebuild is an oscillator bank you can transpose it cleanly (CENTER, or a V/oct cable), thin it out (PARTIALS), recolour every partial from sine through saw to square (SHAPE), snap the partials onto a harmonic series (LOCK), smear it in time (SLEW), change how often it re-analyses (SLICE), or hold the current spectrum forever (FREEZE). It is an EFFECT, not a synth: with nothing patched into AUDIO IN it is silent. It is also mono and monophonic — N voices means N instances.",
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
      out: 'The resynthesis: the tracked partials rendered by the oscillator bank, plus the 16-band noise residual, transposed and levelled. Held steady while FREEZE is engaged. It is a STEREO output, but it only carries a stereo image once BANK WET is up and the filterbank\'s bands are panned — the spectral engine ahead of it is mono, so with the bank out of circuit both channels carry the identical signal.',
    },
    controls: {
      engineMode:
        'Which of the two resynthesis engines is running — they are different DSP code, not two settings of one algorithm, so this changes more than any other control here. SPECTRAL runs a 2048-point FFT, finds and tracks sinusoidal peaks, and rebuilds the sound as tracked partials plus a noise residual; it follows pitch and sounds like the source rebuilt. MASSPASS never transforms anything: it splits the input across 16 to 99 tuned bandpass filters and lets each band report its own level and its own zero-crossing pitch, sampled and held at SLICE. The result is coarser, more vocoder-like and much more obviously stepped, and because MASSPASS has no FFT it is also cheaper at low band counts. Switching is click-free — the output dips to silence for about 6 ms and comes back on the new engine. The original plugin also has a WAVETABLE mode, which is not implemented here yet; a preset saved in it opens in SPECTRAL rather than silent, and it will be added as a third position rather than renumbering these two.',
      spectralBandCount:
        'How many bandpass filters MASSPASS splits the input across — 16, 24, 33, 48, 66 or 99, log-spaced from 50 Hz to 12 kHz. Used ONLY in MASSPASS mode; it does nothing in SPECTRAL. Higher counts narrow each band (Q rises to about 10 at 66 bands and 17 at 99), which sharpens the resynthesis toward a classic vocoder and resolves closely-spaced partials, while low counts are broader, blurrier and cheaper. It is not a volume control — the bank is normalised by 1/sqrt(N) so changing it changes timbre and not level. It is the engine\'s CPU dial: 99 bands costs roughly six times what 16 does.',
      spectralPartials:
        'In SPECTRAL: how many tracked partials the oscillator bank plays, 1 to 256, ranked by SALIENCE rather than raw loudness — so turning it down collapses toward the fundamental and its low harmonics instead of toward whichever formant happened to be loudest. It is also the CPU dial, and it scales the residual by the cube root of (PARTIALS−1)/47, so thinning the bank cleans up the noise too. 1 is a bare fundamental; 64 (the plugin default) is a full rebuild. In MASSPASS the SAME knob becomes the active-band limiter, re-clamped to 1..BANDS: only the loudest that many bands sound, and the rest keep tracking and keep their oscillator phase advancing so that a band coming back does not pop. Turning it down there thins the vocoder to its strongest formants.',
      spectralLock:
        'Pulls each tracked partial toward the nearest exact multiple of the detected fundamental. 0 leaves partials where the analysis found them (faithful, inharmonic, a bit warbly on voice); 1 snaps them onto a harmonic comb (musical, more synthetic). Only partials already within about 100 cents of a harmonic are moved, so formants and noise are left alone — and the whole effect is multiplied by the pitch-detector confidence, so it self-disengages on unpitched material. Used only in SPECTRAL mode: MASSPASS has no global pitch detector to snap to, because each band estimates its own frequency independently.',
      spectralResidual:
        'Level of the SMS noise residual: the energy left in the spectrum after every tracked peak is masked out, measured in 16 log-spaced bands from 80 Hz up and replayed through band-passed noise. 0 gives you the pure sinusoidal bank (the classic vocoder/robot sound); 0.5 is the plugin default; 2 puts back more breath and air than the input had. This is the control that decides whether the module sounds like a machine or like the source. Used only in SPECTRAL mode: the residual is what is left over after peak-picking, and MASSPASS never picks peaks.',
      spectralSlice:
        'The rate at which the engine re-reads the input, 2 to 200 ms — and it means something different, and much stronger, in each mode. In SPECTRAL it is how often the spectrum is re-analysed: short values track transients and chatter with the source, long values sample and hold. The analysis WINDOW is always 2048 samples (about 43 ms), so a long SLICE slows the update rate without blurring what each frame sees. In MASSPASS it is the sample-and-hold interval on every band\'s level and pitch at once — between snapshots each band\'s oscillator is literally frozen in amplitude and frequency, which is where that engine\'s hard stepping comes from. Note: the original plugin declares this same 2–200 ms range but internally clamps SPECTRAL at about 21 ms, so most of its knob does nothing there — here the whole range works in both modes.',
      engineFreeze:
        'Holds the current picture so the module drones on it no matter what the input does. In SPECTRAL that is the tracked partials — their frequencies and amplitudes — held as oscillator state rather than a looped buffer, which is why it sustains rather than stutters, and why SHAPE, CENTER and SLEW still change a frozen sound. In MASSPASS it holds the per-band level and pitch snapshot instead, with the oscillators still running, so it sustains the same way. The GATE input does the same thing while it is high; the two OR together. Note: in the original plugin FREEZE is wired to the spectral engine only and does nothing in MASSPASS — here it works in both, because a gate input that accepts a cable and silently ignores it is worse than a missing feature.',
      spectralShape:
        'The waveform every voice uses: sine at 0, band-limited saw at 0.5, band-limited square at 1, crossfading smoothly in between. At 0 this is a faithful additive resynthesis; past that each voice sprouts its own harmonic series, which thickens and dirties the whole rebuild. It works identically in both modes — the two engines render their voices through the same shared waveform function, so the knob means exactly the same thing whichever is selected.',
      spectralFloor:
        'The peak-detection threshold, in dB BELOW THE LOUDEST BIN of each frame — not an absolute level. Stricter (toward −20 dB) admits only the dominant peaks and starves the bank; more permissive (toward −90 dB) lets quiet detail and noise floor become tracked partials. Works together with STABILITY: FLOOR decides what is loud enough, STABILITY decides what has lasted long enough. Used only in SPECTRAL mode — MASSPASS has no peak detector, so nothing reads this.',
      spectralStab:
        'How many consecutive analysis frames a partial must survive before it is allowed to make sound, 1 to 16. It fades in over that window rather than hard-unmuting. Low values track fast and chirp on noisy material; high values suppress the short-lived flickering peaks that make a partial tracker sound like beeping robots. Used only in SPECTRAL mode — MASSPASS bands are permanent, so there is no birth to gate.',
      spectralSlew:
        'Smoothing time for each partial, 0.02 to 4 seconds — applied to amplitude per sample and to frequency per analysis frame. Short values follow the input crisply; long values glide partials between analyses, smearing the resynthesis into an evolving pad. Frequency smoothing is also why a partial drifting between FFT bins glides instead of chirping. Used only in SPECTRAL mode: MASSPASS does its own smoothing with a fixed 3 ms attack / 80 ms release envelope follower per band, which this knob does not reach.',
      spectralCenter:
        'Transposes the rebuilt spectrum by up to ±3600 cents (±3 octaves), applied after analysis so the whole bank moves coherently and the tracking is unaffected. Adds to whatever the V/oct PITCH input contributes. Works in both modes — in MASSPASS it transposes every band\'s oscillator while leaving the analysis filters where they are, so the resynthesis moves in pitch but keeps reading the same part of the spectrum. (The original plugin has no transposition in MASSPASS at all; ours honours it so the PITCH input is never a dead jack.)',
      resynthLevel:
        'How much of the output comes through the 8-band FILTERBANK: 0 is the bare resynthesis, 1 is the resynthesis heard ONLY through the bands. It is a crossfade, not a level — turning it up does not make the module louder, it swaps one path for the other. It also decides whether this module is mono or stereo, because the per-band PAN is the only stage in the whole chain that makes a stereo image. NOTE: the original plugin ships this at 1, with the bank always in circuit; here it defaults to 0 so that adding the filterbank cannot change how a rack you already saved sounds. Turn it up and the bank is exactly the plugin\'s.',
      inputMix:
        'Adds the RAW audio from AUDIO IN straight onto the output, on top of everything else. Independent of BANK WET — it is the only way to hear the unprocessed source, so it is what you reach for to blend a little of the real signal back under a heavily-thinned resynthesis, or to use the module as a parallel effect rather than an insert. It arrives equally in both channels, since the input is mono.',
      'ws-filterbank-{n}':
        'One of the 8 parallel resonant bands the output passes through when BANK WET is up. Each band is a filter with its own CUTOFF (20 Hz–20 kHz), RESONANCE (0.5–20), TYPE (a continuous morph from low-pass through band-pass to high-pass), PAN and SEND. SEND is the band\'s level into the output and doubles as its on/off switch — a band at 0 is skipped entirely and costs nothing. PAN is where stereo comes from: the engine ahead of this is mono, so spreading the bands across the image is the only way to widen the module. The defaults are the plugin\'s own opening layout — cutoffs log-spaced at 60/120/250/500 Hz and 1/2/4/8 kHz, the three lowest bands high-pass, the two middle band-pass, the three highest low-pass — which reads as a broad EQ rather than a resonator comb until you raise RESONANCE.',
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
    const workletNode = createWorkletNode(node, ctx, 'warrensspectrum', {
      numberOfInputs: 3,
      numberOfOutputs: 1,
      // STEREO from phase 2 — the filterbank's per-band pan needs somewhere
      // to put an image. Both channels carry the identical sample while
      // BANK WET is 0 (the default), so a mono rack is unaffected.
      outputChannelCount: [2],
    });

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of warrensspectrumDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    // ---- the 8-band table (NOT AudioParams — see the worklet header) ----
    //
    // Sent once at boot so a saved rack starts on ITS bands rather than the
    // defaults, then re-sent whenever the revision counter moves. The poll
    // mirrors DX7's `voiceRev`: a band edited by a REMOTE collaborator lands
    // in the Y.Doc with no local callback, so a change-event subscription
    // would deliver local edits and silently drop everyone else's.
    let lastBandsRev = -1;
    function pushBands(): void {
      const bands = warrensspectrumBands(node);
      // Hand-built plain objects: `postMessage` structured-clones, and a Yjs
      // proxy throws "could not be cloned" — the exact failure that left DX7
      // playing a stale patch while the UI showed the new one.
      workletNode.port.postMessage({
        type: 'bands',
        bands: bands.map((b) => ({
          cutoffHz: Number(b.cutoffHz),
          q: Number(b.q),
          type: Number(b.type),
          pan: Number(b.pan),
          send: Number(b.send),
        })),
      });
    }
    pushBands();
    const BANDS_POLL_MS = 120;
    let bandsTimer: ReturnType<typeof setTimeout> | undefined;
    function pollBands(): void {
      const rev = Number(node.data?.[WARRENSSPECTRUM_BANDS_REV_KEY] ?? 0);
      if (rev !== lastBandsRev) {
        lastBandsRev = rev;
        pushBands();
      }
      bandsTimer = setTimeout(pollBands, BANDS_POLL_MS);
    }
    lastBandsRev = Number(node.data?.[WARRENSSPECTRUM_BANDS_REV_KEY] ?? 0);
    bandsTimer = setTimeout(pollBands, BANDS_POLL_MS);

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
        if (bandsTimer !== undefined) clearTimeout(bandsTimer);
        try {
          workletNode.disconnect();
        } catch {
          /* */
        }
      },
    };
  },
};
