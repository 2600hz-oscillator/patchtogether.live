// packages/web/src/lib/ui/modules/moog-filterbank-face-model.ts
//
// THE PURE MODEL BEHIND BOTH MOOG FIXED-FILTER-BANK FACEPLATES — the 907A and
// the 914. ONE file for TWO modules, for the same reason they are one queue
// entry: they share `moog-filterbank-dsp`'s centre-frequency grid and
// `buildFilterBank`'s wiring VERBATIM and differ only in which slice of the grid
// they import. A second copy of this arithmetic would guarantee two different
// answers to one question.
//
// ── WHY A MODEL AT ALL FOR A BANK OF IDENTICAL LEVEL KNOBS ──────────────────
//
// Because every one of those knobs LIES about what reaches the output, and it
// lies by an amount no knob can print. The sections are summed by Web Audio
// fan-in, which is a COHERENT (complex) sum, and adjacent 1/3-octave bands at
// Q = 4 overlap — so a band's contribution at its own centre is its own gain
// PLUS its neighbours', with their phase. Measured on the shipping graph with
// every knob identically at its 0.5 default:
//
//   914   band1 (125 Hz)  −10.97 dB      band7 (1 kHz)   −3.85 dB     spread 7.1 dB
//   907A  band1 (250 Hz)   −9.48 dB      band6 (1.4 kHz) −4.05 dB     spread 5.4 dB
//
// Fourteen knobs in the same place, and the spectrum they produce is not flat —
// it is a comb with 20.9 dB (914) / 17.5 dB (907A) between its peak and its
// deepest notch. The end bands are quiet because they have neighbours on ONE
// side; the middle bands are loud because they have neighbours on both. That is
// a property of the bank, not of the patch, and there is no knob whose readback
// contains it.
//
// ── THE TRANSFER FUNCTION IS THE WEB AUDIO SPEC'S, AND IT IS VALIDATED ──────
//
// `biquadH` below is the BiquadFilterNode formula from the Web Audio spec, not
// a textbook RBJ approximation of it, and the difference is load-bearing:
//
//   ⚠ `BiquadFilterNode.Q` IS READ IN DIFFERENT UNITS BY DIFFERENT TYPES.
//     `bandpass` uses alphaQ = sin(w0)/(2·Q)          — Q is LINEAR.
//     `lowpass`/`highpass` use alphaQdB = sin(w0)/(2·10^(Q/20)) — Q is DECIBELS.
//
//   The shared lib hands ONE constant, `FILTERBANK_Q = 4`, to all three, and
//   documents it with a linear-Q argument ("a 1/3-octave band has Q ≈ 2.2 …").
//   For the twelve bandpasses that argument is right. For the two end shelves
//   the same 4 means FOUR DECIBELS of corner resonance — measured +4.000 dB at
//   7500 Hz and at 100 Hz on the real graph, where a linear reading predicts
//   +12.04 dB. A model that used the linear form for all three would be wrong by
//   8 dB at exactly the two sections this face ranks first and last.
//
// VALIDATED, not asserted: `moog-filterbank-face-model.test.ts` renders the
// REAL def factory's impulse response under node-web-audio-api and compares this
// model's coherent sum against it at every grid point — worst error 1.2e-6 dB
// (914) / 8.1e-7 dB (907A) — and carries a NEGATIVE CONTROL in which one level
// is falsified and the same comparison must go 9+ dB apart. A model that agreed
// with the graph no matter what it was told is not a model.
//
// PURE — no DOM, no Svelte, no engine, no fs. Node-testable.

import type { AudioModuleDef } from '$lib/audio/module-registry';
import { moog914Def } from '$lib/audio/modules/moog914';
import { moog907aDef } from '$lib/audio/modules/moog907a';
import {
  FILTERBANK_907A_CENTERS,
  FILTERBANK_907A_HP_HZ,
  FILTERBANK_907A_LP_HZ,
  FILTERBANK_914_CENTERS,
  FILTERBANK_914_HP_HZ,
  FILTERBANK_914_LP_HZ,
  FILTERBANK_Q,
  bandParamId,
} from '../../../../../dsp/src/lib/moog-filterbank-dsp';

// RELATIVE path, not the `@patchtogether.live/dsp/src/...` alias, for the reason
// `ninelives-face-model.ts` / `sidecar-face-model.ts` both document: a worktree
// may not symlink the workspace package under node_modules, and the TS
// path-alias rules do not reliably resolve TS source out of there.

/**
 * The sample rate this model evaluates the response AT.
 *
 * ⚠ A PHYSICAL CONSTANT WITH A STATED CONSEQUENCE, not a tuning knob and not a
 * population count. A digital biquad's response is a function of `f/sr`, so the
 * printed dB is very slightly rate-dependent; the readout cannot ask the live
 * AudioContext for its rate because `FaceReadoutValue` receives a param reader
 * and nothing else (`face-readout-values.ts`). 48 kHz is chosen because it is
 * the ART harness's rate and Chrome's default on every platform the app ships
 * to. The model test pins the 44.1 kHz delta so the size of the approximation is
 * a measured number rather than a shrug.
 */
export const MOOG_BANK_MODEL_SR = 48_000;

/** One bank's data — the slice of the shared grid a module imports. */
export interface MoogBankSpec {
  readonly centers: readonly number[];
  readonly lpHz: number;
  readonly hpHz: number;
  readonly q: number;
}

/** A bank = its data + the def that declares the levels over it. */
export interface MoogBank {
  readonly def: AudioModuleDef;
  readonly spec: MoogBankSpec;
}

export const MOOG914_BANK: MoogBank = {
  def: moog914Def,
  spec: {
    centers: FILTERBANK_914_CENTERS,
    lpHz: FILTERBANK_914_LP_HZ,
    hpHz: FILTERBANK_914_HP_HZ,
    q: FILTERBANK_Q,
  },
};

export const MOOG907A_BANK: MoogBank = {
  def: moog907aDef,
  spec: {
    centers: FILTERBANK_907A_CENTERS,
    lpHz: FILTERBANK_907A_LP_HZ,
    hpHz: FILTERBANK_907A_HP_HZ,
    q: FILTERBANK_Q,
  },
};

/** One filter section of a bank, resolved in FREQUENCY order. */
export interface MoogBankSection {
  /** The section's param id — `lp`, `band1`…`bandN`, `hp`. */
  readonly id: string;
  /** Its corner (shelves) or centre (bands) frequency, Hz. */
  readonly hz: number;
  readonly kind: 'lowpass' | 'bandpass' | 'highpass';
  /** The control's own label, READ OFF THE DEF — never re-typed here. */
  readonly label: string;
}

/**
 * Every section of a bank, LOW → HIGH: the low-pass shelf, the bandpasses in
 * grid order, then the high-pass shelf.
 *
 * ⚠ DERIVED, IN BOTH DIRECTIONS, AND THAT IS THE WHOLE POINT. The population
 * comes from the shared centre table; the ids come from the same `bandParamId`
 * the def's `params` array and the factory's gain map are built from; the labels
 * are read off the live `ParamDef`. So this list, `face.order`, the sidebar
 * table and the wiring cannot disagree, and there is no count in any of them —
 * add a thirteenth centre to the lib and every one of them grows together. The
 * model test asserts the id set here IS the def's param id set, both ways.
 */
export function moogBankSections(bank: MoogBank): readonly MoogBankSection[] {
  const labelOf = (id: string): string =>
    bank.def.params.find((p) => p.id === id)?.label ?? id;
  return [
    { id: 'lp', hz: bank.spec.lpHz, kind: 'lowpass', label: labelOf('lp') },
    ...bank.spec.centers.map((hz, i) => {
      const id = bandParamId(i + 1);
      return { id, hz, kind: 'bandpass' as const, label: labelOf(id) };
    }),
    { id: 'hp', hz: bank.spec.hpHz, kind: 'highpass', label: labelOf('hp') },
  ];
}

/** `face.order` for a bank: the section ids, low → high. */
export function moogBankOrder(bank: MoogBank): readonly string[] {
  return moogBankSections(bank).map((s) => s.id);
}

/**
 * Live level per section, resolving the DEF DEFAULT for anything untouched.
 * `node.params` is a SPARSE overlay of what has been TOUCHED, so reading it bare
 * prints `undefined`-shaped nonsense on a freshly spawned node.
 */
export function moogBankLevels(
  bank: MoogBank,
  read: (paramId: string) => number | undefined,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of moogBankSections(bank)) {
    const v = read(s.id);
    if (typeof v === 'number' && Number.isFinite(v)) {
      out[s.id] = v;
      continue;
    }
    const pd = bank.def.params.find((p) => p.id === s.id);
    if (!pd) throw new Error(`moog-filterbank-face-model: ${bank.def.type} has no param '${s.id}'`);
    out[s.id] = pd.defaultValue;
  }
  return out;
}

interface Complex {
  readonly re: number;
  readonly im: number;
}

/**
 * H(e^{jw}) for ONE Web Audio BiquadFilterNode — the spec's own coefficients.
 *
 * See the units warning in the file header: `lowpass`/`highpass` read `q` in
 * DECIBELS (alphaQdB), `bandpass` reads it LINEAR (alphaQ). Both forms are here
 * because the bank uses both, from one constant.
 */
export function biquadH(
  kind: MoogBankSection['kind'],
  f0: number,
  q: number,
  f: number,
  sr: number = MOOG_BANK_MODEL_SR,
): Complex {
  const w0 = (2 * Math.PI * f0) / sr;
  const cw = Math.cos(w0);
  const sw = Math.sin(w0);
  const alphaQ = sw / (2 * q);
  const alphaQdB = sw / (2 * Math.pow(10, q / 20));

  let b0: number;
  let b1: number;
  let b2: number;
  let a0: number;
  let a1: number;
  let a2: number;
  if (kind === 'lowpass') {
    b0 = (1 - cw) / 2;
    b1 = 1 - cw;
    b2 = (1 - cw) / 2;
    a0 = 1 + alphaQdB;
    a1 = -2 * cw;
    a2 = 1 - alphaQdB;
  } else if (kind === 'highpass') {
    b0 = (1 + cw) / 2;
    b1 = -(1 + cw);
    b2 = (1 + cw) / 2;
    a0 = 1 + alphaQdB;
    a1 = -2 * cw;
    a2 = 1 - alphaQdB;
  } else {
    b0 = alphaQ;
    b1 = 0;
    b2 = -alphaQ;
    a0 = 1 + alphaQ;
    a1 = -2 * cw;
    a2 = 1 - alphaQ;
  }

  const w = (2 * Math.PI * f) / sr;
  const c1 = Math.cos(w);
  const s1 = Math.sin(w);
  const c2 = Math.cos(2 * w);
  const s2 = Math.sin(2 * w);
  const nr = b0 + b1 * c1 + b2 * c2;
  const ni = -(b1 * s1 + b2 * s2);
  const dr = a0 + a1 * c1 + a2 * c2;
  const di = -(a1 * s1 + a2 * s2);
  const dd = dr * dr + di * di;
  return { re: (nr * dr + ni * di) / dd, im: (ni * dr - nr * di) / dd };
}

/**
 * The bank's SUMMED magnitude response at `f`, in dB.
 *
 * ⚠ COHERENT. Every section's gain multiplies its COMPLEX response and the
 * results are added as vectors, because Web Audio fan-in adds SIGNALS, not
 * magnitudes. A magnitude-only sum is not a rough version of this — it is a
 * different answer: measured against the real graph it is wrong by up to
 * 14.0 dB (914) / 11.4 dB (907A) at the defaults, and it is wrong in the
 * flattering direction, reading +1.8 dB where the graph delivers −3.9 dB.
 */
export function moogBankResponseDb(
  bank: MoogBank,
  levels: Record<string, number>,
  f: number,
  sr: number = MOOG_BANK_MODEL_SR,
): number {
  let re = 0;
  let im = 0;
  for (const s of moogBankSections(bank)) {
    const g = levels[s.id] ?? 0;
    if (g === 0) continue;
    const h = biquadH(s.kind, s.hz, bank.spec.q, f, sr);
    re += g * h.re;
    im += g * h.im;
  }
  return 20 * Math.log10(Math.max(Math.hypot(re, im), 1e-12));
}

/**
 * The frequencies the readouts evaluate the response at: every section
 * frequency, plus the GEOMETRIC MIDPOINT between each adjacent pair.
 *
 * ⚠ THERE IS NO RESOLUTION CONSTANT HERE, deliberately. A comb's maxima sit at
 * the section frequencies and its minima sit between them, so the grid the
 * question needs is exactly "the sections and the gaps" — which the centre table
 * already defines. A "sample the octave every N points" grid would have been a
 * tuned number that silently decides how deep a notch the face is able to see.
 */
export function moogBankGrid(bank: MoogBank): readonly number[] {
  const hz = moogBankSections(bank).map((s) => s.hz);
  const out: number[] = [];
  for (let i = 0; i < hz.length; i++) {
    out.push(hz[i]!);
    if (i + 1 < hz.length) out.push(Math.sqrt(hz[i]! * hz[i + 1]!));
  }
  return out;
}

export interface MoogBankExtreme {
  /** Hz at which the summed response is extremal over the grid. */
  readonly hz: number;
  readonly db: number;
}

function extreme(
  bank: MoogBank,
  levels: Record<string, number>,
  pick: (a: number, b: number) => boolean,
): MoogBankExtreme {
  let best: MoogBankExtreme | null = null;
  for (const f of moogBankGrid(bank)) {
    const db = moogBankResponseDb(bank, levels, f);
    if (!Number.isFinite(db)) continue;
    if (!best || pick(db, best.db)) best = { hz: f, db };
  }
  return best ?? { hz: Number.NaN, db: Number.NEGATIVE_INFINITY };
}

/** Where the bank is LOUDEST, and by how much. */
export function moogBankPeak(bank: MoogBank, levels: Record<string, number>): MoogBankExtreme {
  return extreme(bank, levels, (a, b) => a > b);
}

/** The bank's DEEPEST hole, and how deep. */
export function moogBankNotch(bank: MoogBank, levels: Record<string, number>): MoogBankExtreme {
  return extreme(bank, levels, (a, b) => a < b);
}

/**
 * The bank's SLOPE in dB: the summed response at the TOP bandpass centre minus
 * the response at the BOTTOM one.
 *
 * Reads only the two end centres, so it is invariant to a uniform level change
 * BY CONSTRUCTION (both terms scale by the same factor and the difference
 * cancels exactly) — which is what makes it the permanent negative control for
 * `peak`/`notch`, and them for it.
 */
export function moogBankTiltDb(bank: MoogBank, levels: Record<string, number>): number {
  const c = bank.spec.centers;
  if (c.length < 2) return 0;
  return (
    moogBankResponseDb(bank, levels, c[c.length - 1]!) - moogBankResponseDb(bank, levels, c[0]!)
  );
}

/** What the sidebar row for one section prints: the SUMMED response at that
 *  section's own frequency — its neighbours included, which is the whole
 *  difference between this and reading the knob. */
export function moogBankSectionDb(
  bank: MoogBank,
  levels: Record<string, number>,
  sectionId: string,
): number {
  const s = moogBankSections(bank).find((x) => x.id === sectionId);
  if (!s) return Number.NaN;
  return moogBankResponseDb(bank, levels, s.hz);
}

// ── formatting ──────────────────────────────────────────────────────────────

/** A frequency as the readouts print it — `125 Hz`, `1.0k`, `7.5k`. */
export function fmtBankHz(hz: number): string {
  if (!Number.isFinite(hz)) return '—';
  if (hz >= 1000) return `${(hz / 1000).toFixed(1)}k`;
  return `${Math.round(hz)} Hz`;
}

/** A level in dB, one decimal, `silent` below the model's floor. */
export function fmtBankDb(db: number): string {
  if (!Number.isFinite(db) || db <= -200) return 'silent';
  return `${db.toFixed(1)} dB`;
}

/** A SIGNED dB difference — a slope needs its direction printed. */
export function fmtBankTilt(db: number): string {
  if (!Number.isFinite(db)) return '—';
  const r = db.toFixed(1);
  return `${db >= 0 && !r.startsWith('-') ? '+' : ''}${r} dB`;
}

/** The `peak` hero readout: where the bank is loudest, and by how much. */
export function moogBankPeakText(bank: MoogBank, levels: Record<string, number>): string {
  const e = moogBankPeak(bank, levels);
  if (!Number.isFinite(e.db) || e.db <= -200) return 'silent';
  return `${fmtBankHz(e.hz)} ${fmtBankDb(e.db)}`;
}

/** The `notch` hero readout: the deepest hole in the summed response. */
export function moogBankNotchText(bank: MoogBank, levels: Record<string, number>): string {
  const e = moogBankNotch(bank, levels);
  if (!Number.isFinite(e.db) || e.db <= -200) return 'silent';
  return `${fmtBankHz(e.hz)} ${fmtBankDb(e.db)}`;
}

/** The `tilt` hero readout: bottom band centre → top band centre. */
export function moogBankTiltText(bank: MoogBank, levels: Record<string, number>): string {
  return fmtBankTilt(moogBankTiltDb(bank, levels));
}

/** One sidebar row: the summed response at that section's own frequency. */
export function moogBankSectionText(
  bank: MoogBank,
  levels: Record<string, number>,
  sectionId: string,
): string {
  return fmtBankDb(moogBankSectionDb(bank, levels, sectionId));
}
