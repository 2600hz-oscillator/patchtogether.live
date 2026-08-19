// packages/web/src/lib/ui/modules/moog911a-face-model.ts
//
// The PURE model behind the MOOG 911A faceplate — the two numbers a trigger
// delay cannot print from any one of its knobs.
//
// WHY A MODEL FOR A THREE-KNOB MODULE. Because the most consequential number on
// this module is not a knob at all: it is the clock rate ABOVE WHICH THE OUTPUT
// GOES COMPLETELY SILENT.
//
// `TriggerDelay.step` arms a countdown on a rising edge and RE-ARMS it if
// another edge arrives while it is running (`trigger-delay-dsp.ts`) — there is
// no queue. So a clock whose period is shorter than the delay never lets a
// countdown reach zero, and the channel emits NOTHING. Measured on the SHIPPING
// worklet with `delay1` at its 0.1 s default, counting rising edges on `out1`
// over a 3.0 s render:
//
//   4 Hz -> 12 in / 12 out     10 Hz   -> 30 in /  0 out
//   8 Hz -> 24 in / 24 out     16 Hz   -> 48 in /  0 out
//   9.9 Hz -> 30 in / 29 out   32 Hz   -> 96 in /  0 out
//
// A CLIFF, not a rolloff, bisected to 9.998958 Hz against a predicted
// 1/0.1 = 10.000000. Positive control: the same 16 and 32 Hz clocks at the
// 0.002 s minimum delay give 48/48 and 96/96, so it is the delay and not the
// clock. That behaviour is #1886 and is NOT changed by the faceplate — adding a
// queue is an audio-semantics decision for the owner's ears. What the face does
// is stop the module from hiding it.
//
// The second readout needs all THREE params, which is what makes it more than a
// relabelled knob: the MODE switch decides which outputs fire at all, so "when
// does the last output land after one trigger on TRIG 1" is 100 / 100 / 200 ms
// at the shipped defaults across OFF / PARALLEL / SERIES while NEITHER delay
// dial moves.
//
// PURE: no DOM, no engine, no store, no fs, and no sample rate — both functions
// are closed forms in seconds, so the numbers hold at 44.1 and 48 kHz.
// ⚠ ONE APPROXIMATION, stated: in SERIES the real wait is delay1 + delay2 plus
// ONE SAMPLE (20.83 µs at 48 kHz, measured identically at three delay pairs),
// because the chain reads OUT 1 from the previous sample to stay causal. That
// is 0.01 % of the shipped default and below the readout's own precision, so
// the model states the exact sum and the def's `docs.outputs.out2` carries the
// correction. The ART oracle asserts the residual is exactly one sample, so it
// cannot grow unnoticed.

import { moog911aDef, MOOG911A_MODE_NAMES } from '$lib/audio/modules/moog911a';

// ── THE LIVE PARAMS ─────────────────────────────────────────────────────────

/** The three params both readouts are a function of. */
export interface Moog911aFaceParams {
  delay1: number;
  delay2: number;
  mode: number;
}

function paramDefault(id: keyof Moog911aFaceParams): number {
  const p = moog911aDef.params.find((q) => q.id === id);
  if (!p) throw new Error(`moog911a-face-model: no param '${id}' on moog911aDef`);
  return p.defaultValue;
}

/** The def's own spawn defaults — DERIVED, never re-typed. */
const DEFAULTS: Moog911aFaceParams = {
  delay1: paramDefault('delay1'),
  delay2: paramDefault('delay2'),
  mode: paramDefault('mode'),
};

/**
 * Read the three params off a live reader. Anything missing or non-finite falls
 * back to the def's declared default — a fresh node has written nothing yet,
 * and `FaceReadoutValue` runs on EVERY render.
 */
export function moog911aFaceParams(
  read: (paramId: string) => number | undefined,
): Moog911aFaceParams {
  const one = (k: keyof Moog911aFaceParams): number => {
    const v = read(k);
    return typeof v === 'number' && Number.isFinite(v) ? v : DEFAULTS[k];
  };
  return { delay1: one('delay1'), delay2: one('delay2'), mode: one('mode') };
}

/**
 * The mode index the DSP acts on.
 *
 * ⚠ `Math.round`, MIRRORED FROM THE WORKLET rather than from the pure core.
 * `packages/dsp/src/moog911a.ts` rounds the k-rate param BEFORE handing it to
 * `DualTriggerDelay.step`, whose own `mode <= 0 … mode >= 2` clamp therefore
 * never sees a fractional value. Reading the CORE instead would predict
 * PARALLEL across the whole open interval and put the boundaries at 0 and 2;
 * reading the CONSUMER puts them at 0.5 and 1.5, which is what the shipping
 * module does (bisected: 0.4999999851 and 1.4999999404) and what the legacy
 * card has always printed.
 */
export function moog911aModeIndex(mode: number): number {
  if (!Number.isFinite(mode)) return DEFAULTS.mode;
  const i = Math.round(mode);
  return i < 0 ? 0 : i > MOOG911A_MODE_NAMES.length - 1 ? MOOG911A_MODE_NAMES.length - 1 : i;
}

/** `OFF` / `PARALLEL` / `SERIES`. */
export function moog911aModeName(mode: number): string {
  return MOOG911A_MODE_NAMES[moog911aModeIndex(mode)]!;
}

// ── THE TWO DERIVED NUMBERS ─────────────────────────────────────────────────

/**
 * MAX RATE — the highest trigger rate channel 1 can pass, in Hz.
 *
 * `1/delay1`, because a countdown re-armed before it finishes never fires. This
 * is the module's merit argument as a number: at the shipped 0.1 s default a
 * 9.9 Hz clock passes 29 of 30 triggers and a 10 Hz clock passes NONE.
 *
 * ⚠ Deliberately about DELAY 1 ONLY, and that is what makes it the other
 * readout's negative control: it is invariant to DELAY 2 and to MODE, both of
 * which move `last out`. Channel 2 has its own ceiling of `1/delay2`, which is
 * the same law rather than a second fact — and in SERIES it cannot bind first,
 * because channel 2 is fed by OUT 1, which is already rate-limited.
 */
export function moog911aMaxRateHz(p: Moog911aFaceParams): number {
  const d = p.delay1;
  if (!Number.isFinite(d) || d <= 0) return Number.POSITIVE_INFINITY;
  return 1 / d;
}

/**
 * LAST OUT — how long after ONE trigger on TRIG 1 the LAST output fires, in ms.
 *
 * The MODE switch decides which outputs fire at all, so this needs all three
 * params and no single dial can show it:
 *
 *   OFF       `delay1` — channel 2 is driven by TRIG 2, so OUT 2 never fires
 *             from this trigger at all. MEASURED, not assumed: a trigger on
 *             TRIG 1 in OFF gives 1 pulse on out1 and 0 on out2.
 *   PARALLEL  `max(delay1, delay2)` — one trigger in, two staggered outs.
 *   SERIES    `delay1 + delay2` — OUT 1 re-triggers delay 2.
 */
export function moog911aLastOutMs(p: Moog911aFaceParams): number {
  const d1 = Number.isFinite(p.delay1) ? Math.max(0, p.delay1) : DEFAULTS.delay1;
  const d2 = Number.isFinite(p.delay2) ? Math.max(0, p.delay2) : DEFAULTS.delay2;
  switch (moog911aModeIndex(p.mode)) {
    case 2:
      return 1000 * (d1 + d2);
    case 1:
      return 1000 * Math.max(d1, d2);
    default:
      return 1000 * d1;
  }
}

// ── FORMATTING ──────────────────────────────────────────────────────────────

/**
 * A RATE spanning `1/10` … `1/0.002` Hz — 0.1 Hz to 500 Hz. One decimal below
 * 100 so the 10.0 Hz default reads as a rate rather than as a bare integer, and
 * integer above it where the fraction is noise.
 */
export function fmtRateHz(hz: number): string {
  if (!Number.isFinite(hz)) return `${hz}`;
  if (hz >= 100) return `${Math.round(hz)} Hz`;
  return `${hz.toFixed(1)} Hz`;
}

/**
 * A DELAY spanning 2 ms … 20 s (SERIES doubles the maximum). Local rather than
 * shared for the reason `moog911-face-model`'s ladder is: one instance is not a
 * pattern, and these two modules disagree about the interesting decade.
 */
export function fmtDelayMs(ms: number): string {
  if (!Number.isFinite(ms)) return `${ms}`;
  const v = ms < 0 ? 0 : ms;
  if (v < 100) return `${v.toFixed(1)} ms`;
  if (v < 1000) return `${Math.round(v)} ms`;
  return `${(v / 1000).toFixed(2)} s`;
}

/** `max rate` — the clock above which this channel emits nothing. */
export function moog911aMaxRateText(p: Moog911aFaceParams): string {
  return fmtRateHz(moog911aMaxRateHz(p));
}

/** `last out` — when the last output lands after one trigger on TRIG 1. */
export function moog911aLastOutText(p: Moog911aFaceParams): string {
  return fmtDelayMs(moog911aLastOutMs(p));
}
