// packages/web/src/lib/ui/modules/analog-vco-face-model.ts
//
// THE PURE MODEL BEHIND ANALOG VCO's FACEPLATE — the readouts and the hero
// picture's geometry, mirroring `packages/dsp/src/analog-vco.dsp` line for line.
//
// ⚠ THE DSP IS FAUST, so nothing can be imported: the tap laws are RE-TYPED
// from the .dsp and pinned by a source grep in the model test (the kickdrum
// `splitHz` precedent). Every constant below cites the line it came from.
//
// ⚠ EVERY NUMBER IS KNOB-ONLY, and the LABELS say so where it matters. A
// registered `FaceReadoutValue` is handed a DURABLE-param reader, so it cannot
// see the `pitch` jack, an `fm` cable, or CV on tune/fine — which is exactly
// why the hero's first readout is captioned `knob pitch` rather than `pitch`.
//
// PURE — no DOM, no Svelte, no engine. Node-testable.

import { analogVcoDef } from '$lib/audio/modules/analog-vco';

/** The DSP's own literal (analog-vco.dsp:25). */
export const VCO_C4_HZ = 261.626;

/** ⚠ STATED IN A READOUT LABEL, NEVER HIDDEN IN A VALUE. The first aliased
 *  harmonic is `floor(SR / 2·f0)` and therefore SAMPLE-RATE dependent;
 *  `FaceReadoutValue` cannot see the real rate, so the caption carries the
 *  assumption instead of the number quietly being wrong by 2× at 96 kHz. */
export const VCO_ASSUMED_SR = 48000;

export interface VcoFaceParams {
  tune: number;
  fine: number;
  fmAmount: number;
  pw: number;
  shape: number;
}

export const VCO_FACE_PARAM_IDS = [
  'tune', 'fine', 'fmAmount', 'pw', 'shape',
] as const satisfies readonly (keyof VcoFaceParams)[];

/** Live values in, resolving the DEF DEFAULT for anything untouched.
 *  `node.params` is a sparse overlay of what has been TOUCHED — reading it bare
 *  is the bug that made the crossover panel print `WIDTH 0%` beside a dial
 *  reading 0.20. */
export function vcoFaceParams(
  read: (paramId: string) => number | undefined,
): VcoFaceParams {
  const val = (id: string): number => {
    const v = read(id);
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    const pd = analogVcoDef.params.find((p) => p.id === id);
    if (!pd) throw new Error(`analog-vco-face-model: analogVco has no param '${id}'`);
    return pd.defaultValue;
  };
  return {
    tune: val('tune'),
    fine: val('fine'),
    fmAmount: val('fmAmount'),
    pw: val('pw'),
    shape: val('shape'),
  };
}

/** The sounding pitch from the KNOBS ALONE — blind to the pitch jack, to FM and
 *  to CV on tune/fine, exactly like the factory's own `currentFreqHz()`. The
 *  clamp is the DSP's (analog-vco.dsp:26-27). */
export function vcoKnobHz(p: VcoFaceParams): number {
  const hz = VCO_C4_HZ * Math.pow(2, p.tune / 12 + p.fine / 1200);
  return Math.min(20000, Math.max(1, hz));
}

/** FM's reach in CENTS. `fmAmount` is in OCTAVES (it lands inside the same
 *  pow2 as tune and fine), so the span is 1200 × |amount| — and it is |·|
 *  because a NEGATIVE fmAmount inverts the MODULATOR (a 180° flip,
 *  analog-vco.dsp:10-12), it does not reverse the sweep direction. */
export function vcoFmSpanCents(p: VcoFaceParams): number {
  return 1200 * Math.abs(p.fmAmount);
}

/** FM's reach in Hz against a ±1 modulator — asymmetric, because the exponent
 *  is. Scales with the fundamental, which is what a dial readback cannot say. */
export function vcoFmSpanHz(p: VcoFaceParams): { up: number; down: number } {
  const a = Math.abs(p.fmAmount);
  const f0 = vcoKnobHz(p);
  return { up: f0 * (Math.pow(2, a) - 1), down: f0 * (1 - Math.pow(2, -a)) };
}

/**
 * HOW MUCH OF THE MORPH TAP PW ACTUALLY OWNS — the crossfade weight `hi`
 * (analog-vco.dsp:80,83), clamped at zero.
 *
 * ⚠ THIS IS THE FACE'S SHARPEST FACT. At the shipped `shape = 0` it is EXACTLY
 * ZERO, which is why "PW doesn't work" is a reasonable thing for a user to
 * conclude — while PW is simultaneously live on the SQUARE output from spawn,
 * because `sqr(p)` IS output 2. Independently pinned in
 * analog-vco-morph.test.ts (rms < 1e-9 for shape ∈ {0, 0.1, 0.25, 0.4}).
 */
export function vcoPwAuthority(p: VcoFaceParams): number {
  return Math.max(0, 2 * p.shape - 1);
}

/** The DC the morph tap sits at — no DC blocker exists anywhere in the .dsp,
 *  so at shape 1 / pw 0.2 the morph rests at −0.6. (Modelled, currently unused
 *  by the face; see the sidebar note.) */
export function vcoMorphDc(p: VcoFaceParams): number {
  return vcoPwAuthority(p) * (2 * p.pw - 1);
}

/** The first harmonic that folds back — `floor(SR / 2f0)`. The .dsp has no
 *  PolyBLEP, no oversampling and no anti-alias filter anywhere in its 105
 *  lines, so every tap but the sine aliases above this. */
export function vcoFirstAliasedHarmonic(
  p: VcoFaceParams,
  sampleRate: number = VCO_ASSUMED_SR,
): number {
  return Math.max(1, Math.floor(sampleRate / (2 * vcoKnobHz(p))));
}

/** ⚠ NOT `kickdrum-format`'s `fmtHz`: that rounds to integer Hz, so C4 prints
 *  `262 Hz` and the +10-cent negative control (261.6 → 263.1) would be
 *  invisible at the printed precision. */
export function fmtVcoHz(v: number): string {
  if (!Number.isFinite(v)) return `${v}`;
  return Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(2)} kHz` : `${v.toFixed(1)} Hz`;
}

// ── the hero picture's geometry (analog-vco.dsp:56-84, exactly) ─────────────

export type VcoTap = 'saw' | 'square' | 'triangle' | 'sine' | 'morph';

/** Every tap, low→high in the .dsp's own declaration order. */
export const VCO_TAPS: readonly VcoTap[] = ['saw', 'square', 'triangle', 'sine', 'morph'];

/**
 * One sample of `tap` at `phase`.
 *
 * ⚠ TRIANGLE PEAKS AT p = 0 — `4·|p − 0.5| − 1` is polarity-inverted from the
 * textbook shape (analog-vco.dsp:58). Draw it that way; "fixing" it would make
 * the picture disagree with the audio.
 */
export function vcoTapSample(
  tap: VcoTap,
  phase: number,
  shape: number,
  pw: number,
): number {
  const p = phase - Math.floor(phase);
  const saw = 2 * p - 1;
  const sqr = p < pw ? 1 : -1;
  const tri = 4 * Math.abs(p - 0.5) - 1;
  const sn = Math.sin(2 * Math.PI * p);
  switch (tap) {
    case 'saw': return saw;
    case 'square': return sqr;
    case 'triangle': return tri;
    case 'sine': return sn;
    case 'morph': {
      const s = Math.max(0, Math.min(1, shape));
      // The two-segment crossfade. At s = 0 this is BIT-IDENTICAL to `saw`,
      // which is the back-compat identity the .dsp guarantees (:74-77).
      return s < 0.5
        ? sn * (2 * s) + saw * (1 - 2 * s)
        : sqr * (2 * s - 1) + sn * (2 - 2 * s);
    }
  }
}

/** `n + 1` points of `cycles` periods of one tap, in a 0..1 × −1..1 box. */
export function vcoCyclePoints(
  tap: VcoTap,
  shape: number,
  pw: number,
  cycles: number,
  n: number,
): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i <= n; i++) {
    const x = i / n;
    out.push({ x, y: vcoTapSample(tap, x * cycles, shape, pw) });
  }
  return out;
}
