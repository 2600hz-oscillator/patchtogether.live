// packages/web/src/lib/ui/modules/warrensspectrum-face-model.ts
//
// The PURE model behind the WARREN'S SPECTRUM faceplate — the arithmetic for
// its four derived readouts.
//
// WHY A MODEL AT ALL. This module is TWO DSP CLASSES behind one MODE switch,
// and that is not a stylistic detail: five of its thirteen dials describe
// peak-tracking machinery MASSPASS does not have, one describes a filterbank
// SPECTRAL does not have, and the PARTIALS dial means something DIFFERENT in
// each engine. So on this module more than most, "what does that dial say"
// and "what will I hear" are separate questions:
//
//   · HOW MANY VOICES you actually hear. `spectralPartials` prints `64` in
//     both engines. In SPECTRAL that is the answer. In MASSPASS the same knob
//     is the ACTIVE-BAND limiter, re-clamped to `1..BANDS`
//     (`WsMassPass.setActiveBands`), so at the shipped band count you hear 24
//     and at the smallest you hear 16 — while the dial still says 64. The
//     PARTIALS readback is blind to BOTH `engineMode` and `spectralBandCount`.
//   · HOW MUCH RESIDUAL is actually applied. `spectralResidual` prints `0.50`
//     and the DSP multiplies it by `cbrt((PARTIALS − 1) / 47)` before using it
//     (`warrensspectrum-dsp.ts`, mirroring SpectralResynth.cpp:898-907). At
//     PARTIALS 1 that factor is exactly ZERO and the residual is bit-exactly
//     absent — measured in `art/scenarios/warrensspectrum/cv-path.test.ts`:
//     sweeping RESIDUAL 0 → 2 at PARTIALS 1 moves the output by `0.0000e+0`,
//     against `1.4299e-3` at PARTIALS 64. The dial reads `0.50` in both.
//     And MASSPASS never picks peaks, so it has no residual at all.
//   · HOW LONG a new partial takes to arrive. `spectralStab` prints `3` and
//     what that costs is `(STAB − 1) × SLICE` — the birth ramp is counted in
//     COMMITS, not in time (`stabilityGain = frames / minBirth`). At the
//     shipped SLICE that is 20 ms; at SLICE 200 it is 400 ms, a 20× difference
//     the dial cannot show. MASSPASS bands are permanent, so there is no birth
//     to gate at all.
//   · HOW LOUD the output can get. `gain` prints `0.0 dB` and INPUT MIX is
//     ADDITIVE and un-normalised (`finishSample`: `(wet·bank + (1−wet)·dry +
//     mix·input) · gain`), so a full-scale source at INPUT MIX 1 leaves the
//     module +6.02 dB hot with every dial apparently neutral. BANK WET, by
//     contrast, is a CROSSFADE — it changes which paths are live and cannot
//     change this number, which is what makes the two halves of this readout
//     each other's control.
//
// EVERY FORMULA HERE MIRRORS `packages/dsp/src/lib/warrensspectrum-dsp.ts` /
// `-masspass.ts`, AND THE MIRROR IS ASSERTED. `warrensspectrum-face-model.
// test.ts` imports the shipping engine AND the def and re-derives each closed
// form against them on every run, with negative controls in both directions —
// so a DSP change or a def re-range turns a stale faceplate claim RED instead
// of leaving the panel insisting on it.
//
// ⚠ THE CONSTANTS ARE MIRRORED, NOT IMPORTED, and that is deliberate. This
// file sits inside the SHELL's static import closure (`face-readout-values.ts`
// is a declared boundary entry), and `module-shell-import-guard.test.ts` keeps
// that closure free of module def paths. The sidecar precedent applies: mirror
// the numbers here, and make the ORACLE assert the mirror — a re-typed
// constant that drifts is then a RED test, not a silent lie on a faceplate.
//
// PURE: no DOM, no engine, no store, no fs. Every function is a pure function
// of the live params.

// ── THE MIRRORED DSP / DEF CONSTANTS ────────────────────────────────────────

/** `warrensspectrum-dsp.ts` `WS_ENGINE_SPECTRAL` / `WS_ENGINE_MASSPASS`. Our
 *  indices append in IMPLEMENTATION order and are deliberately not the VST's. */
export const WSF_ENGINE_SPECTRAL = 0;
export const WSF_ENGINE_MASSPASS = 1;

/** `warrensspectrum-masspass.ts` `WS_MASSPASS_BAND_COUNTS` — the roster
 *  `spectralBandCount` indexes into. */
export const WSF_BAND_COUNTS: readonly number[] = [16, 24, 33, 48, 66, 99];

/** `warrensspectrum-dsp.ts` `WS_MAX_TRACKS` — the oscillator-bank ceiling. */
export const WSF_MAX_TRACKS = 256;

/** `warrensspectrum-dsp.ts` `WS_SLICE_MIN_MS` / `WS_SLICE_MAX_MS`. */
export const WSF_SLICE_MIN_MS = 2;
export const WSF_SLICE_MAX_MS = 200;

/**
 * The residual's PARTIALS scaling denominator — `(partials − 1) / 47`, clamped
 * to `0..1`, then cube-rooted (`SpectralResynth.cpp:898-907`).
 *
 * ⚠ 47, not 48 and not 64. It is the plugin's own constant and it means the
 * scaling reaches 1 at PARTIALS 48, i.e. the residual is at FULL knob value for
 * the whole top 82 % of the dial and collapses only below it. Getting this
 * wrong would make the readout agree with the knob in the region a reviewer
 * would check and disagree in the region that matters.
 */
export const WSF_RESIDUAL_SPAN = 47;

/** `warrensspectrum-dsp.ts` — below this the residual branch is skipped
 *  entirely, so the noise half is not merely quiet, it is absent. */
export const WSF_RESIDUAL_EPSILON = 1e-4;

// ── THE LIVE PARAMS ─────────────────────────────────────────────────────────

export interface WarrensspectrumFaceParams {
  /** 0 = SPECTRAL, 1 = MASSPASS. Anything else falls back to SPECTRAL, exactly
   *  as `setEngineMode` does — a `.wspr` preset saved in the VST's unimplemented
   *  WAVETABLE slot opens in SPECTRAL rather than silent. */
  engineMode: number;
  /** INDEX into `WSF_BAND_COUNTS`, 0..5. MASSPASS only. */
  spectralBandCount: number;
  /** 1..256. Bank size in SPECTRAL; the active-band limiter in MASSPASS. */
  spectralPartials: number;
  /** 0..2. SMS noise-residual level, before the PARTIALS scaling. */
  spectralResidual: number;
  /** 1..16 frames a partial must survive before it is at full level. */
  spectralStab: number;
  /** 2..200 ms — the analysis period, and so the unit STABILITY counts in. */
  spectralSlice: number;
  /** 0..1 crossfade, resynth → filterbank. Also the bank's ENABLER at 0. */
  resynthLevel: number;
  /** 0..1. The RAW input, added on top. Not a crossfade. */
  inputMix: number;
  /** dB, −60..+12. The output trim. */
  gain: number;
}

/** The def's own defaults, restated so a fresh node (whose `node.params` is a
 *  SPARSE overlay of what has been TOUCHED) prints the shipped answer rather
 *  than zeros. Mirrors `WARRENSSPECTRUM_RANGES`; the oracle asserts the mirror. */
export const WARRENSSPECTRUM_FACE_DEFAULTS: WarrensspectrumFaceParams = {
  engineMode: 0,
  spectralBandCount: 1,
  spectralPartials: 64,
  spectralResidual: 0.5,
  spectralStab: 3,
  spectralSlice: 10,
  resynthLevel: 0,
  inputMix: 0,
  gain: 0,
};

function finite(v: number | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Read the face's params off a live reader, defaulting each one INDEPENDENTLY
 *  (a node that has touched only SLICE must still print the right stability). */
export function warrensspectrumFaceParams(
  read: (paramId: string) => number | undefined,
): WarrensspectrumFaceParams {
  const d = WARRENSSPECTRUM_FACE_DEFAULTS;
  return {
    engineMode: finite(read('engineMode'), d.engineMode),
    spectralBandCount: finite(read('spectralBandCount'), d.spectralBandCount),
    spectralPartials: finite(read('spectralPartials'), d.spectralPartials),
    spectralResidual: finite(read('spectralResidual'), d.spectralResidual),
    spectralStab: finite(read('spectralStab'), d.spectralStab),
    spectralSlice: finite(read('spectralSlice'), d.spectralSlice),
    resynthLevel: finite(read('resynthLevel'), d.resynthLevel),
    inputMix: finite(read('inputMix'), d.inputMix),
    gain: finite(read('gain'), d.gain),
  };
}

// ── THE ENGINE'S OWN COERCIONS, MIRRORED ────────────────────────────────────

/** `setEngineMode`: anything that is not exactly MASSPASS is SPECTRAL. */
export function wsIsMassPass(p: WarrensspectrumFaceParams): boolean {
  return Math.round(p.engineMode) === WSF_ENGINE_MASSPASS;
}

/** `wsBandCountForIndex` — clamp the INDEX, then look the count up. */
export function wsBandCount(p: WarrensspectrumFaceParams): number {
  const i = clamp(Math.round(p.spectralBandCount), 0, WSF_BAND_COUNTS.length - 1);
  return WSF_BAND_COUNTS[i]!;
}

/** `setPartials`: `max(1, min(WS_MAX_TRACKS, round(n)))`. */
export function wsPartials(p: WarrensspectrumFaceParams): number {
  return clamp(Math.round(p.spectralPartials), 1, WSF_MAX_TRACKS);
}

/** `setSliceMs`: clamped to the declared range before anything reads it. */
export function wsSliceMs(p: WarrensspectrumFaceParams): number {
  return clamp(p.spectralSlice, WSF_SLICE_MIN_MS, WSF_SLICE_MAX_MS);
}

/** `setStabilityFrames`: `max(1, round(n))`. */
export function wsStabilityFrames(p: WarrensspectrumFaceParams): number {
  return Math.max(1, Math.round(p.spectralStab));
}

// ── 1. VOICES — how many oscillators can actually sound ─────────────────────

/**
 * The number of voices the selected engine will actually run.
 *
 * SPECTRAL: the bank size, `PARTIALS` (`setPartials`).
 * MASSPASS: the ACTIVE-BAND limit, `clamp(PARTIALS, 1, BANDS)` — the same knob,
 * re-clamped by `WsMassPass.setActiveBands`, and re-applied whenever the band
 * count changes so growing the bank can re-widen it (`setBandCountIndex`).
 *
 * THE PARTIALS READBACK IS BLIND TO BOTH OTHER INPUTS: it prints `64` in
 * SPECTRAL (where 64 is right), in MASSPASS at 99 bands (where 64 is right) and
 * in MASSPASS at 16 bands (where the answer is 16).
 */
export function wsVoiceCount(p: WarrensspectrumFaceParams): number {
  const n = wsPartials(p);
  return wsIsMassPass(p) ? clamp(n, 1, wsBandCount(p)) : n;
}

/** `64` in SPECTRAL. `24 of 24` in MASSPASS — the second number is the bank
 *  size, because "how many are sounding" is only half the sentence when the
 *  other half is the ceiling the knob is being clamped to. */
export function wsVoiceText(p: WarrensspectrumFaceParams): string {
  const n = wsVoiceCount(p);
  if (!Number.isFinite(n)) return '—';
  if (!wsIsMassPass(p)) return String(n);
  const bands = wsBandCount(p);
  return `${n} of ${bands}`;
}

// ── 2. RESIDUAL — the noise level actually applied ──────────────────────────

/**
 * The residual level the DSP multiplies the noise bank by:
 * `RESIDUAL × cbrt(clamp((PARTIALS − 1) / 47, 0, 1))`, and ZERO in MASSPASS
 * (which never picks peaks, so there is no left-over energy to replay).
 *
 * THE RESIDUAL READBACK IS BLIND TO PARTIALS. Measured on the shipping worklet:
 * sweeping RESIDUAL 0 → 2 at PARTIALS 1 moves the output by a bit-exact
 * `0.0000e+0`; the same sweep at PARTIALS 64 moves it by `1.4299e-3`. The dial
 * prints the same string in both.
 */
export function wsEffectiveResidual(p: WarrensspectrumFaceParams): number {
  if (wsIsMassPass(p)) return 0;
  const fraction = clamp((wsPartials(p) - 1) / WSF_RESIDUAL_SPAN, 0, 1);
  return Math.max(0, p.spectralResidual) * Math.cbrt(fraction);
}

/**
 * `0.50` at the shipped defaults. `off` once the effective level falls under
 * the DSP's own `1e-4` branch guard — which is a stronger claim than "quiet":
 * below it the residual code does not run at all. `none` in MASSPASS, where the
 * dial is inert by construction rather than merely small.
 */
export function wsResidualText(p: WarrensspectrumFaceParams): string {
  if (wsIsMassPass(p)) return 'none';
  const v = wsEffectiveResidual(p);
  if (!Number.isFinite(v)) return '—';
  return v > WSF_RESIDUAL_EPSILON ? v.toFixed(2) : 'off';
}

// ── 3. FADE IN — how long a new partial takes to reach full level ───────────

/**
 * Milliseconds from a partial's first committed frame to full level.
 *
 * The birth ramp is `stabilityGain = frames / minBirth` and `frames` counts
 * COMMITS, so the ramp completes `(STAB − 1)` analysis periods after the
 * partial is born — and the analysis period is SLICE. At STAB 1 the guard
 * (`minBirth > 1`) never engages and a partial is at full level immediately.
 *
 * THE STABILITY READBACK IS BLIND TO SLICE, and by a wide margin: `3` costs
 * 20 ms at the shipped SLICE and 400 ms at SLICE 200. And the SLICE readback is
 * blind to STABILITY: `10.0 ms` costs 0 ms at STAB 1 and 150 ms at STAB 16.
 * Neither dial can print this and both move it.
 *
 * MASSPASS has no birth gate — its bands are permanent — so this is `none`
 * there, which is also what makes MODE the readout's third blind input.
 */
export function wsFadeInMs(p: WarrensspectrumFaceParams): number {
  return (wsStabilityFrames(p) - 1) * wsSliceMs(p);
}

/** `20 ms` at the shipped defaults; `instant` at STABILITY 1; `none` in
 *  MASSPASS. */
export function wsFadeInText(p: WarrensspectrumFaceParams): string {
  if (wsIsMassPass(p)) return 'none';
  const v = wsFadeInMs(p);
  if (!Number.isFinite(v)) return '—';
  if (v <= 0) return 'instant';
  return v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${v.toFixed(v < 10 ? 1 : 0)} ms`;
}

// ── 4. OUT — which paths are live, and how hot the output can get ───────────

/**
 * The output's gain at a full-scale input, in dB: `20·log10(1 + INPUT MIX) +
 * GAIN`.
 *
 * `finishSample` is `(wet·bank + (1 − wet)·dry + mix·input) · gainLinear`. The
 * first two terms are a CROSSFADE and sum to one path's worth of signal at
 * every WET, so BANK WET cannot move this number; `mix·input` is an un-
 * normalised ADD, so INPUT MIX can and does — a full-scale source at INPUT MIX
 * 1 puts the module 6.02 dB over with every dial apparently neutral.
 *
 * THE GAIN READBACK IS BLIND TO INPUT MIX and vice versa; and BANK WET moves
 * the PATH half of this readout while being unable to move this number, which
 * is what makes the two halves each other's control.
 */
export function wsOutputHeadroomDb(p: WarrensspectrumFaceParams): number {
  const mix = clamp(p.inputMix, 0, 1);
  return 20 * Math.log10(1 + mix) + p.gain;
}

/** Which of the three summed paths carry signal, in the DSP's own order
 *  (`finishSample`: bank ← wet, dry ← 1−wet, raw ← mix). */
export function wsLivePaths(p: WarrensspectrumFaceParams): string[] {
  const wet = clamp(p.resynthLevel, 0, 1);
  const mix = clamp(p.inputMix, 0, 1);
  const paths: string[] = [];
  if (wet < 1) paths.push('resynth');
  if (wet > 0) paths.push('bank');
  if (mix > 0) paths.push('raw');
  return paths;
}

/** `resynth · 0.0 dB` at the shipped defaults. */
export function wsOutText(p: WarrensspectrumFaceParams): string {
  const db = wsOutputHeadroomDb(p);
  const paths = wsLivePaths(p);
  const level = Number.isFinite(db)
    ? `${db > 0.05 ? '+' : ''}${Math.abs(db) < 0.05 ? '0.0' : db.toFixed(1)} dB`
    : '—';
  return `${paths.length ? paths.join('+') : 'silent'} · ${level}`;
}
