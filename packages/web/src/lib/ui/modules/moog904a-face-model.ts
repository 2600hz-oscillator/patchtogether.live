// packages/web/src/lib/ui/modules/moog904a-face-model.ts
//
// What the MOOG 904A's CUTOFF dial actually delivers, and which side of the
// filter/oscillator line the module is on.
//
// ⚠ THE MULTIPLIER IS IMPORTED, NOT RE-STATED. `rangeMultiplier` is a real
// export of the SHIPPING ladder lib — the same function the worklet calls on
// every block — so there is one source and nothing to drift. That is
// deliberately unlike `moog902-face-model.ts`, which had no choice but to
// re-state its law (that worklet top-level-exports nothing), and unlike the ART
// scenario for THIS module, which hand-copies `DRIVE = 0.5 + REGEN * 0.8` out
// of the worklet and can therefore drift silently (#1913).

import type { AudioModuleDef } from '$lib/audio/module-registry';
import { moog904aDef } from '$lib/audio/modules/moog904a';
import { rangeMultiplier } from '../../../../../dsp/src/lib/moog-ladder-dsp';

// RELATIVE path, not the `@patchtogether.live/dsp/src/...` alias, for the reason
// `ninelives-face-model.ts` / `moog921-face-model.ts` both document: a worktree
// may not symlink the workspace package under node_modules, and the TS
// path-alias rules do not reliably resolve TS source out of there.

/** The worklet's own hard clamp on the delivered cutoff, in Hz. */
export const MOOG904A_CUTOFF_MIN_HZ = 20;
export const MOOG904A_CUTOFF_MAX_HZ = 20000;

/**
 * The REGENERATION setting at which a silent, unpatched 904A starts emitting.
 *
 * ⚠ MEASURED, NOT DECLARED — nothing in the DSP names this number. Bisected on
 * the shipping worklet by rendering with NOTHING patched and reading the peak:
 * below it the tail peaks at 4.9018e-7 (a dead filter's noise floor), above it
 * at 1.6934e-1. That is a change of CLASS, not of degree — the module stops
 * being a filter and becomes an oscillator — which is why the face prints it as
 * a NAME rather than as a number.
 *
 * ⚠ IT IS A PROPERTY OF A LADDER WITH TANH FEEDBACK, not of resonance in
 * general. `resofilter`'s Q never reaches self-oscillation at all, so this
 * model must not be copied to it.
 */
export const MOOG904A_SELF_OSC_REGEN = 0.665231;

export interface Moog904aParams {
  readonly cutoff: number;
  readonly range: number;
  readonly regeneration: number;
}

/**
 * Read one param, resolving the DEF DEFAULT for anything untouched and for any
 * non-finite value the live engine can hand back mid-boot. A readout runs on
 * every render, so a NaN reaching the arithmetic takes the faceplate down
 * mid-drag rather than printing a wrong number.
 */
function readOr(
  def: AudioModuleDef,
  read: (paramId: string) => number | undefined,
  id: string,
): number {
  const v = read(id);
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const p = def.params.find((q) => q.id === id);
  if (!p) throw new Error(`moog904a-face-model: ${def.type} has no param '${id}'`);
  return p.defaultValue;
}

export function moog904aFaceParams(
  read: (paramId: string) => number | undefined,
): Moog904aParams {
  return {
    cutoff: readOr(moog904aDef, read, 'cutoff'),
    range: readOr(moog904aDef, read, 'range'),
    regeneration: readOr(moog904aDef, read, 'regeneration'),
  };
}

/**
 * THE FREQUENCY THE DIAL DOES NOT PRINT — `cutoff × rangeMultiplier(range)`,
 * through the worklet's own 20 Hz / 20 kHz clamp.
 *
 * ⚠ THIS IS THE MODULE'S HEADLINE FACT. The CUTOFF param declares
 * `units: 'Hz'`, so the dial prints a number that reads like an answer — and
 * the RANGE switch multiplies it by ×1 / ×4 / ×16 before it reaches the ladder.
 * With the dial pinned at 1000 Hz the filter is placed at 1000 / 4000 / 16000
 * Hz, a 16× spread, and NOTHING on the module said so.
 *
 * ⚠ AND THE CLAMP IS WHY THIS READOUT EARNS ITS PLACE TWICE. Because the clamp
 * lands on the PRODUCT, the top of the dial goes dead at higher RANGE settings
 * — measured on the shipping worklet by bit-comparing SETTLED TAILS, the dial
 * is bit-identical to its maximum from 5000 Hz up at RANGE 2 (the top 20.07 %
 * of the log taper) and from 1250 Hz up at RANGE 3 (the top 40.14 %), with the
 * boundaries landing exactly on 20000 ÷ ×4 and 20000 ÷ ×16. This readout PINS
 * at `20.0 kHz` across precisely that dead span, so the faceplate shows the
 * user why the knob stopped doing anything instead of leaving them to find out.
 */
export function moog904aCutoffHz(p: Moog904aParams): number {
  const hz = p.cutoff * rangeMultiplier(p.range);
  if (!Number.isFinite(hz)) return MOOG904A_CUTOFF_MIN_HZ;
  if (hz < MOOG904A_CUTOFF_MIN_HZ) return MOOG904A_CUTOFF_MIN_HZ;
  if (hz > MOOG904A_CUTOFF_MAX_HZ) return MOOG904A_CUTOFF_MAX_HZ;
  return hz;
}

// ⚠ DELIBERATELY NOT THE −3 dB CORNER, AND THE REASON IS MEASURED.
//
// The queue spec proposed `cutoff · rangeMultiplier · 0.43419` for this
// readout, describing it as carrying a 0.19 % bias. That constant is the
// LOW-FREQUENCY LIMIT of the 4-pole cascade, and this ladder is a TPT/ZDF
// design whose `tan` prewarp compresses the mapping as the corner approaches
// Nyquist — so the bias is not a bias, it is a function of where you are.
// Measured against the SHIPPING worklet with a Hann-windowed single-bin DFT
// over the SETTLED TAIL, dial pinned at 1000:
//
//   RANGE 1   internal fc  1000 Hz   corner   434.02 Hz   spec form  −0.04 %
//   RANGE 2   internal fc  4000 Hz   corner  1766.87 Hz   spec form  −1.70 %
//   RANGE 3   internal fc 16000 Hz   corner  9840.59 Hz   spec form −29.40 %
//
// So the proposed formula is wrong by nearly half an octave exactly where this
// module's headline claim lives, and its stated error is true only in the range
// where nobody would notice. The prewarped closed form
// `(sr/π)·atan(tan(π·fc/sr)·√(2^¼−1))` tracks the measurement to 0.25–0.34 %
// across all three — but it needs the SAMPLE RATE, and `FaceReadoutValue`
// receives a param reader and nothing else, so a corner readout would have to
// hard-code 48 kHz and be silently wrong at 44.1 kHz.
//
// `moog904aCutoffHz` above avoids both problems: it is EXACT, it is
// rate-independent, and it is the frequency the self-oscillation actually sings
// at (measured 197.645 Hz where that function says 200) rather than the corner,
// which sits well below it (86.838 Hz at the same setting).

/** `1.0 kHz` / `434 Hz` — whole Hz below 1 kHz, one decimal above. */
export function moog904aCutoffText(p: Moog904aParams): string {
  const hz = moog904aCutoffHz(p);
  return hz >= 1000 ? `${(hz / 1000).toFixed(1)} kHz` : `${Math.round(hz)} Hz`;
}

/**
 * `filter` or `osc` — WHICH SIDE OF THE CLASS CHANGE the module is on.
 *
 * ⚠ A NAME, NOT A NUMBER, AND THAT IS THE POINT. The owner ruling permits a
 * readout whose text is a declared landmark NAME precisely because a name
 * disambiguates otherwise-identical states: the REGEN dial reads a plausible
 * `0.66` on BOTH sides of a boundary across which the module's unpatched output
 * jumps by five and a half orders of magnitude. A number here would restate the
 * dial; the name says what the dial cannot.
 */
export function moog904aStateText(p: Moog904aParams): string {
  return p.regeneration > MOOG904A_SELF_OSC_REGEN ? 'osc' : 'filter';
}
