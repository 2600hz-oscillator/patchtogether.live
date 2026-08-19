// packages/web/src/lib/ui/modules/swolevco-face-model.ts
//
// The PURE model behind the SWOLEVCO faceplate — the arithmetic for its three
// derived readouts.
//
// WHY DERIVED AND NOT THREE KNOB READBACKS. Because the one question a player
// has about a complex oscillator — "what is the modulator actually doing?" —
// is not answerable from any single dial on the module, and the dial that
// looks like the answer is the one that is wrong:
//
//   MOD HZ    The modulator's real frequency is `primary × RATIO` in one mode
//             and `M.TUNE / M.FINE` in the other. A `mod_tune` readback prints
//             a moving number in the mode where that control does NOTHING —
//             measured `max|x − x_ref| = 0.000e+0` on all three audio outputs
//             across the full ±36 st / ±100 ¢ range, at the SHIPPED DEFAULT
//             `ratio = 1`. That is the kick-drum TAIL trap with a mode switch
//             in front of it: the readout looks right and is blind to the only
//             control that decides whether it means anything.
//   LOCK      Which of those two modes is live. It is the piece of information
//             that makes the OTHER two dials legible, and no dial carries it —
//             `ratio` reads `1.00`, which does not say "M.TUNE is asleep".
//   SHAPE     Where SYMMETRY actually is. Measured spectral centroid across
//             the sweep: 3750 / 3126 / 1986 / 637 / 1925 / 2832 / 3258 Hz at
//             0 / 0.25 / 0.4 / 0.5 / 0.6 / 0.75 / 1. THE TRIANGLE IS A SINGLE
//             POINT — a 0.1 move off centre TRIPLES the brightness — and a
//             linear fader gives no detent to find it by. The name does.
//
// ANCHORED TO THE FACTORY'S OWN FUNCTIONS. `tuneFineToHz` and `symmetryGains`
// are imported from the def, not re-derived here, so the readout computes the
// frequency and the crossfade weights through the SAME code the audio graph
// runs. A pitch-law change moves both surfaces together or neither.
//
// PURE: no DOM, no engine, no store. Every function is a pure function of the
// live param values.

import { symmetryGains, tuneFineToHz } from '$lib/audio/modules/swolevco';

/** Live param values the three readouts need, with the def's own defaults
 *  filled in. `node.params` is a SPARSE overlay of what has been TOUCHED, so
 *  reading it bare prints the wrong answer on a fresh spawn. */
export interface SwolevcoFaceParams {
  tune: number;
  fine: number;
  mod_tune: number;
  mod_fine: number;
  ratio: number;
  symmetry: number;
}

const DEFAULTS: SwolevcoFaceParams = {
  tune: 0,
  fine: 0,
  mod_tune: 0,
  mod_fine: 0,
  ratio: 1,
  symmetry: 0.5,
};

/** Read the six params the readouts depend on off a live reader. Anything
 *  missing or non-finite falls back to the def's declared default. */
export function swolevcoFaceParams(
  read: (paramId: string) => number | undefined,
): SwolevcoFaceParams {
  const one = (k: keyof SwolevcoFaceParams): number => {
    const v = read(k);
    return typeof v === 'number' && Number.isFinite(v) ? v : DEFAULTS[k];
  };
  return {
    tune: one('tune'),
    fine: one('fine'),
    mod_tune: one('mod_tune'),
    mod_fine: one('mod_fine'),
    ratio: one('ratio'),
    symmetry: one('symmetry'),
  };
}

/**
 * THE MODULATOR'S ACTUAL FREQUENCY, in Hz.
 *
 * The factory gates two mutually-exclusive legs on the ratio shadow
 * (`swolevco.ts`, "The modulator's base frequency, as a SIGNAL summed from two
 * mutually exclusive legs"):
 *
 *   ratio > 0   →  primary base Hz × ratio      (ratio-locked)
 *   ratio <= 0  →  the modulator's own M.TUNE / M.FINE pitch (free run)
 *
 * VERIFIED against the shipping factory under an OfflineAudioContext, by
 * interpolated zero-crossing over a 4 s render: `ratio = 0.005` measures
 * 1.3082 Hz against a prediction of 1.3081; `ratio = 1` measures 261.62601 Hz
 * against 261.62600, at tune 0 / -7.2 / -12 / +12.
 *
 * ⚠ ONE HONEST LIMIT. The two gates cross over a LUT cell (`CV_STEP_BAND` wide
 * in ratio-normalised units) rather than switching instantaneously, so for a
 * narrow band of ratios just above zero the real modulator is a BLEND of both
 * legs and this function reports only the locked one — measured 194.9 Hz at
 * `ratio = 0.001`, where free-run is 261.6 and locked is 0.26. The band is
 * under 0.07 % of the fader's travel and closes by `ratio ~ 0.005`, where the
 * locked prediction is exact again. It is reachable by CV, not by hand, and
 * the alternative (interpolating across it) would print a number that is
 * wrong everywhere instead of a number that is wrong in one unreachable band.
 */
export function swolevcoModHz(p: SwolevcoFaceParams): number {
  return p.ratio > 0
    ? tuneFineToHz(p.tune, p.fine) * p.ratio
    : tuneFineToHz(p.mod_tune, p.mod_fine);
}

/** Below this the modulator has stopped being a pitch and become a sweep. The
 *  usual bottom of human hearing; it is a LABELLING threshold on a readout,
 *  not a DSP constant, and nothing in the audio path reads it. */
const SUB_AUDIO_HZ = 20;

/**
 * THE MODE WORD — `free-run` or `xN.NN`, plus `sub-audio` when the locked
 * modulator has dropped below hearing.
 *
 * This is the readout that makes `mod_tune` / `mod_fine` legible: while it
 * reads `xN.NN` those two dials are bit-exactly inert, and while it reads
 * `free-run` they are the modulator's entire pitch.
 *
 * ⚠ It is a NAME, not a number, and that is the point — a number here would
 * restate the RATIO dial (owner ruling on face readouts). `free-run` and
 * `x1.00` are two states a dial reading `0.00` vs `1.00` cannot distinguish
 * from each other in meaning, only in position.
 */
export function swolevcoLockText(p: SwolevcoFaceParams): string {
  if (!(p.ratio > 0)) return 'free-run';
  const mult = `x${p.ratio.toFixed(2)}`;
  const hz = swolevcoModHz(p);
  return Number.isFinite(hz) && hz < SUB_AUDIO_HZ ? `${mult} sub-audio` : mult;
}

/** Format the modulator frequency: sub-Hz rates get a decimal, pitches do not. */
export function swolevcoModHzText(p: SwolevcoFaceParams): string {
  const hz = swolevcoModHz(p);
  if (!Number.isFinite(hz)) return '—';
  if (hz < 10) return `${hz.toFixed(2)} Hz`;
  if (hz < 1000) return `${hz.toFixed(1)} Hz`;
  return `${(hz / 1000).toFixed(2)} kHz`;
}

/** A shape is called by its own name only when the crossfade has essentially
 *  collapsed onto it. Chosen so `triangle` names the point the centroid
 *  measurement says it is (637 Hz at exactly 0.5, 1986 Hz at 0.4) and not the
 *  neighbourhood around it. */
const PURE_SHAPE_GAIN = 0.995;

type ShapeKey = 'saw' | 'triangle' | 'square';

const SHAPE_LABEL: Readonly<Record<ShapeKey, string>> = {
  saw: 'saw',
  triangle: 'triangle',
  square: 'square',
};
const SHAPE_SHORT: Readonly<Record<ShapeKey, string>> = {
  saw: 'saw',
  triangle: 'tri',
  square: 'sqr',
};
/** SIGNAL order of the three-way crossfade, low brightness to high at the
 *  ends — the order the fader itself sweeps through. */
const SHAPE_ORDER: readonly ShapeKey[] = ['saw', 'triangle', 'square'];

/**
 * WHERE SYMMETRY ACTUALLY IS — `saw`, `saw+tri 60/40`, `triangle`,
 * `tri+sqr 30/70`, `square`.
 *
 * Computed from `symmetryGains`, the def's OWN crossfade helper, so the name
 * cannot drift from the weights the audio graph applies. A blend prints both
 * contributors and their percentages, because the measurement says the blend
 * region is where all the brightness lives and "somewhere between saw and
 * triangle" is not enough to find your way back to 0.5 by.
 *
 * ⚠ INVARIANT TO `fold` BY CONSTRUCTION, and that is its permanent negative
 * control: FOLD moves the measured centroid by 5.12x (637 -> 3264 Hz) and
 * moves this readout by nothing, because the folder sits AFTER the crossfade.
 * A readout that tracked "brightness" would move with both and tell you which
 * neither.
 */
export function swolevcoShapeText(p: SwolevcoFaceParams): string {
  const g = symmetryGains(p.symmetry);
  const live = SHAPE_ORDER.map((key) => ({ key, gain: g[key] }))
    .filter((s) => Number.isFinite(s.gain) && s.gain > 0)
    .sort((a, b) => b.gain - a.gain);
  if (live.length === 0) return '—';

  const top = live[0]!;
  if (live.length === 1 || top.gain >= PURE_SHAPE_GAIN) return SHAPE_LABEL[top.key];

  const second = live[1]!;
  const total = top.gain + second.gain;
  if (!(total > 0)) return SHAPE_LABEL[top.key];

  // Name the pair in SIGNAL order, not dominance order, so the caption does
  // not swap ends as the fader crosses a midpoint.
  const [first, last] =
    SHAPE_ORDER.indexOf(top.key) < SHAPE_ORDER.indexOf(second.key)
      ? [top, second]
      : [second, top];
  const pctFirst = Math.round((first.gain / total) * 100);
  return `${SHAPE_SHORT[first.key]}+${SHAPE_SHORT[last.key]} ${pctFirst}/${100 - pctFirst}`;
}
