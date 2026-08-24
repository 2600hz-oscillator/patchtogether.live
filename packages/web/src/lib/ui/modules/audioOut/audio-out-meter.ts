// packages/web/src/lib/ui/modules/audioOut/audio-out-meter.ts
//
// THE TERMINAL METER'S ARITHMETIC — pure, so the face's one picture is
// assertable without a browser.
//
// ⚠ IT LIVES BESIDE THE BODY IT FEEDS, NOT IN `audio/modules/`, and that is not
// filing preference: the docs manifest globs `audio/modules/*.ts` and warns on
// any file there that declares no ModuleDef, absorbing the exceptions into a
// hand-kept per-file denylist. This is a DRAWING model for one faceplate, so
// the right answer was to put it where it belongs rather than to grow that
// list by one more name.
//
// The face body draws two bars from these numbers and paints NO text. That is
// the whole reason the maths lives in its own file: a picture cannot be
// asserted, and the resting faceplate is not allowed to print the measurement,
// so the only place "the meter is right" can be a checkable claim is here plus
// the `aria-valuetext` these functions produce.
//
// ⚠ AND IT READS THE PER-CHANNEL KEYS, WHICH IS NOT A DETAIL. `audio-out.ts`
// spends twenty lines on why: an `AnalyserNode` analyses a MONO DOWNMIX, so on
// the stereo terminal bus `read('outputSnapshot')` cannot tell only-L from
// only-R (both read exactly half level) and reads ~0 for an anti-phase pair —
// "perfectly silent" and "perfectly cancelling" are the same number. The
// per-channel taps were added to fix exactly that, and a meter built on the
// mono key would reproduce the blindness they exist to remove.
//
// `readTerminalLevels` therefore takes the READ FUNCTION rather than an engine:
// the model test hands it a fake that records which keys were asked for, so
// "the body reads the per-channel keys" is a measured property and a regression
// to the mono key is a red test rather than a subtly wrong picture.

// The SAME import path `audio-out.ts` uses, deliberately: the def imports the
// ceiling from the DSP core rather than re-typing it "so the worklet and the
// fallback cannot disagree", and the meter's mark has to be the same number by
// the same route or the picture lies about where the brickwall is.
import { MASTER_CEILING_DB } from '../../../../../../dsp/src/lib/master-limiter-dsp';

/**
 * The bottom of the meter's scale, in dBFS. A meter needs a floor to have a
 * geometry at all; −60 dBFS is roughly the point below which a terminal output
 * is inaudible on consumer playback, so the bar hits bottom when the rack is
 * effectively silent rather than crawling toward negative infinity.
 *
 * NOT a population count and not a policy threshold on a derived measurement —
 * a physical axis endpoint, like a graticule.
 */
export const AUDIO_OUT_METER_FLOOR_DB = -60;

/**
 * The engine keys the meter reads, in L, R order.
 *
 * ⚠ `'outputSnapshot'` — the MONO key — is deliberately absent. See the header.
 */
export const AUDIO_OUT_METER_KEYS = ['outputSnapshotL', 'outputSnapshotR'] as const;

/** What `read('outputSnapshot*')` returns. */
export interface TerminalSnapshot {
  samples: Float32Array;
  sampleRate: number;
}

/** One channel's terminal level, in dBFS, clamped to the meter's floor. */
export function peakDbOf(samples: Float32Array | undefined): number {
  if (!samples || samples.length === 0) return AUDIO_OUT_METER_FLOOR_DB;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]!);
    if (a > peak) peak = a;
  }
  if (peak <= 0) return AUDIO_OUT_METER_FLOOR_DB;
  const db = 20 * Math.log10(peak);
  return db < AUDIO_OUT_METER_FLOOR_DB ? AUDIO_OUT_METER_FLOOR_DB : db;
}

/**
 * Where a dBFS value sits on the bar, 0 (floor) … 1 (0 dBFS).
 *
 * Linear in dB rather than in amplitude, which is the only scale on which the
 * useful part of a master meter — the last 12 dB — occupies useful width.
 */
export function meterFraction(db: number): number {
  const span = 0 - AUDIO_OUT_METER_FLOOR_DB;
  const f = (db - AUDIO_OUT_METER_FLOOR_DB) / span;
  return f < 0 ? 0 : f > 1 ? 1 : f;
}

/** The ceiling mark's position on the bar — `MASTER_CEILING_DB`, IMPORTED from
 *  the DSP core, never re-typed. The def imports it from the same place rather
 *  than re-typing it so the worklet and the fallback cannot disagree;
 *  re-typing it here would re-create that class one layer out. */
export function ceilingFraction(): number {
  return meterFraction(MASTER_CEILING_DB);
}

/** Terminal levels for both channels, in dBFS. */
export interface TerminalLevels {
  l: number;
  r: number;
  /** At or above the brickwall ceiling. The tap is measured AFTER the limiter,
   *  so the terminal peak cannot EXCEED the ceiling — sitting on it is what
   *  limiting looks like from here. */
  limiting: boolean;
}

/**
 * Read both terminal channels through `read`.
 *
 * Returns `null` when the per-channel keys are unavailable — an un-booted
 * engine, or a caller that answers only the mono key. `null` means "draw the
 * idle field", never "draw silence": a blank canvas and a body that failed to
 * mount must not look the same.
 */
export function readTerminalLevels(read: (key: string) => unknown): TerminalLevels | null {
  const left = read(AUDIO_OUT_METER_KEYS[0]) as TerminalSnapshot | undefined;
  const right = read(AUDIO_OUT_METER_KEYS[1]) as TerminalSnapshot | undefined;
  if (!left?.samples || !right?.samples) return null;
  const l = peakDbOf(left.samples);
  const r = peakDbOf(right.samples);
  // Within a quarter-dB of the ceiling. A brickwall reaches the ceiling and
  // stops, so an exact compare would miss it on every quantisation.
  const limiting = l >= MASTER_CEILING_DB - 0.25 || r >= MASTER_CEILING_DB - 0.25;
  return { l, r, limiting };
}

/** One channel's dB, spoken. `-Infinity` never appears — the floor reads as
 *  silence, which is what it means. */
function speakDb(db: number): string {
  if (db <= AUDIO_OUT_METER_FLOOR_DB) return 'silent';
  return `${db.toFixed(1)} dBFS`;
}

/**
 * The meter's `aria-valuetext` — the ONLY surface the measurement appears on.
 *
 * Nothing is painted: no dB readout, no peak value, no ceiling label. A
 * labelled row of derived values under a picture is the hero readout strip that
 * was deleted fleet-wide, and this face is not going to reintroduce it under a
 * different name. The value is speakable and assertable and unpainted.
 */
export function meterValueText(levels: TerminalLevels | null): string {
  if (!levels) return 'output level unavailable';
  if (levels.l <= AUDIO_OUT_METER_FLOOR_DB && levels.r <= AUDIO_OUT_METER_FLOOR_DB) {
    return 'silent';
  }
  const tail = levels.limiting ? ', limiting' : ', not limiting';
  return `left ${speakDb(levels.l)}, right ${speakDb(levels.r)}${tail}`;
}
