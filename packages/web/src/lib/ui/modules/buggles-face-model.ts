// packages/web/src/lib/ui/modules/buggles-face-model.ts
//
// THE PURE MODEL behind BUGGLES's five derived readouts — the arithmetic the
// faceplate prints, kept out of the shell and out of the def so both can import
// it and neither can hold a second copy.
//
// WHY EVERY ONE OF THESE IS DERIVED RATHER THAN A KNOB RELABELLED. BUGGLES has
// five params and five jacks, and the mapping between them is not one-to-one in
// either direction: RATE alone changes what comes out of ALL FIVE holes, and
// three of the five jacks are governed by a product of two knobs. Named per
// readout:
//
//   woggle Hz    RATE is a normalised 0..1 dial over a LOG map spanning 500x
//                (0.1 -> 50 Hz). The dial reads `0.40`; the clock is 1.20 Hz.
//                No control on the module prints a frequency.
//   smooth glide THE KICK-DRUM TAIL SHAPE, verbatim. The nearest knob is
//                SMOOTH and it does move when you turn SMOOTH — and it is
//                BLIND TO RATE, which changes the answer 36.5x. At SMOOTH 0.5
//                the glide is 2895 ms at RATE 0.2 and 79 ms at RATE 0.8, with
//                the SMOOTH dial bit-identical in both.
//   stepped hold RATE *and* CHAOS: the hold is 1/rateHz and CHAOS widens it by
//                +/-50% x chaos. A `rate` readback is invariant to the second
//                term entirely.
//   burst rate   RATE, BURST *and* a TRUNCATION term no naive formula has. The
//                cluster is cut by the next woggle event, so E[delivered] falls
//                5.00 -> 1.00 across the top of the RATE travel and the obvious
//                `p x rate x 5` is 5x wrong at RATE 1 (250/s claimed, 50/s
//                real). See the BURST TRUNCATION block in `buggles.ts`.
//   ring Hz      the carrier is rate/4 and therefore SUB-AUDIO at every knob
//                position (0.025 .. 12.5 Hz). This is the readout that puts the
//                audit's finding on the panel: the docs claimed "audio-rate"
//                for as long as the module existed.
//
// ⚠ NOTHING HERE IS RE-TYPED FROM THE DSP. Every constant is imported from
// `buggles.ts` — the rate map, the burst geometry, the cluster bounds, the ring
// divisor — so a change to the module moves the printed numbers with it and
// `buggles-face-model.test.ts` re-derives the claims from the same imports.
//
// PURE: no DOM, no engine, no store.

import {
  BUGGLES_BURST_GAP_MS,
  BUGGLES_BURST_MAX_PULSES,
  BUGGLES_BURST_MIN_PULSES,
  BUGGLES_BURST_PULSE_MS,
  BUGGLES_RING_DIVISOR,
  bugglesDef,
  bugglesMath,
} from '$lib/audio/modules/buggles';

export interface BugglesFaceParams {
  rate: number;
  chaos: number;
  smoothness: number;
  burst_probability: number;
  level: number;
}

/** The param ids this model reads. DERIVED from the def, so a rename is a
 *  compile-or-test failure rather than a silent `undefined`. */
export const BUGGLES_FACE_PARAM_IDS: readonly string[] = bugglesDef.params.map((p) => p.id);

/**
 * Resolve the live params a readout sees: the def's own default for anything
 * untouched (`node.params` is a SPARSE overlay), and a CLAMP to the declared
 * range for anything a corrupt save or a mid-drag NaN hands us. A readout runs
 * on every render, so a non-finite must never reach the arithmetic.
 */
export function bugglesFaceParams(
  read: (paramId: string) => number | undefined,
): BugglesFaceParams {
  const out: Record<string, number> = {};
  for (const p of bugglesDef.params) {
    const raw = read(p.id);
    const v = typeof raw === 'number' && Number.isFinite(raw) ? raw : p.defaultValue;
    out[p.id] = Math.max(p.min, Math.min(p.max, v));
  }
  return out as unknown as BugglesFaceParams;
}

// ── The quantities ───────────────────────────────────────────────────────────

/** The internal woggle clock, in Hz. The log map the 0..1 dial hides. */
export function bugglesWoggleHz(p: BugglesFaceParams): number {
  return bugglesMath.rateKnobToHz(p.rate);
}

/** The woggle PERIOD, in seconds — the interval STEPPED holds a value for and
 *  the interval CLOCK pulses at, before CHAOS jitters it. */
export function bugglesWogglePeriodS(p: BugglesFaceParams): number {
  return 1 / bugglesWoggleHz(p);
}

/**
 * SMOOTH's glide time, in seconds — `fireWoggleEvent` step 3's
 * `slewS = 0.01 + smoothness * 2 * periodS`.
 *
 * ⚠ THE 0.01 FLOOR IS LOAD-BEARING and it is why this is not simply
 * proportional to the period: at SMOOTH 0 the glide is 10 ms at EVERY rate, so
 * a model that scaled the whole expression by 1/rate would be wrong on the one
 * setting a player is most likely to check.
 */
export function bugglesSmoothGlideS(p: BugglesFaceParams): number {
  return 0.01 + p.smoothness * 2 * bugglesWogglePeriodS(p);
}

/** The fraction CHAOS jitters the woggle period by, either side (`nextPeriodS`
 *  draws `(rand*2-1) * 0.5 * chaos`). 0 at CHAOS 0, +/-50% at CHAOS 1. */
export function bugglesJitterFraction(p: BugglesFaceParams): number {
  return 0.5 * p.chaos;
}

/**
 * How many pulses of a rolled cluster of `len` actually REACH the jack at these
 * settings. Pulse `i` starts at `i * GAP` and ends at `i * GAP + PULSE`; the
 * next woggle event cancels everything still scheduled, so a pulse survives
 * only if it has finished inside one woggle period.
 */
export function bugglesDeliveredBurstPulses(p: BugglesFaceParams, len: number): number {
  const periodMs = bugglesWogglePeriodS(p) * 1000;
  let n = 0;
  for (let i = 0; i < len; i++) {
    if (i * BUGGLES_BURST_GAP_MS + BUGGLES_BURST_PULSE_MS <= periodMs) n++;
  }
  return n;
}

/** E[delivered pulses] over the UNIFORM cluster length `rollBurst` draws.
 *  Enumerated from the module's own bounds, never a typed mean. */
export function bugglesExpectedDeliveredPulses(p: BugglesFaceParams): number {
  let sum = 0;
  let lengths = 0;
  for (let len = BUGGLES_BURST_MIN_PULSES; len <= BUGGLES_BURST_MAX_PULSES; len++) {
    sum += bugglesDeliveredBurstPulses(p, len);
    lengths++;
  }
  return lengths === 0 ? 0 : sum / lengths;
}

/** BURST triggers per second that actually reach the jack:
 *  probability x woggle rate x E[delivered]. */
export function bugglesBurstTriggersPerS(p: BugglesFaceParams): number {
  return p.burst_probability * bugglesWoggleHz(p) * bugglesExpectedDeliveredPulses(p);
}

/** The naive rate a reader would write — probability x rate x E[ROLLED]. Kept
 *  here, and only here, so the test can assert the truncation term is real
 *  rather than describing it. */
export function bugglesNaiveBurstTriggersPerS(p: BugglesFaceParams): number {
  const meanRolled = (BUGGLES_BURST_MIN_PULSES + BUGGLES_BURST_MAX_PULSES) / 2;
  return p.burst_probability * bugglesWoggleHz(p) * meanRolled;
}

/** The RING carrier, in Hz. Sub-audio across the whole travel — see the
 *  BUGGLES_RING_* block in `buggles.ts`. */
export function bugglesRingHz(p: BugglesFaceParams): number {
  return bugglesWoggleHz(p) / BUGGLES_RING_DIVISOR;
}

// ── Formatters ───────────────────────────────────────────────────────────────

/** Hz, with the precision the VALUE needs rather than one fixed shape: the
 *  carrier is 0.025 Hz at one end of the dial and the clock is 50 Hz at the
 *  other, and `0.03 Hz` / `50.00 Hz` would be wrong in opposite directions. */
export function fmtBugglesHz(hz: number): string {
  if (!Number.isFinite(hz) || hz <= 0) return 'still';
  if (hz >= 10) return `${hz.toFixed(1)} Hz`;
  if (hz >= 1) return `${hz.toFixed(2)} Hz`;
  return `${hz.toFixed(3)} Hz`;
}

/** A duration, in the unit a player thinks in at that magnitude. */
export function fmtBugglesTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const ms = seconds * 1000;
  if (ms < 10) return `${ms.toFixed(1)} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (seconds < 60) return `${seconds.toFixed(2)} s`;
  return `${(seconds / 60).toFixed(1)} min`;
}

// ── The five printed strings ─────────────────────────────────────────────────

export function bugglesWoggleText(p: BugglesFaceParams): string {
  return fmtBugglesHz(bugglesWoggleHz(p));
}

export function bugglesSmoothGlideText(p: BugglesFaceParams): string {
  return fmtBugglesTime(bugglesSmoothGlideS(p));
}

/** The hold time, and how far CHAOS moves it either side. The `+/-` half is the
 *  term a `rate` readback cannot see. */
export function bugglesSteppedHoldText(p: BugglesFaceParams): string {
  const hold = fmtBugglesTime(bugglesWogglePeriodS(p));
  const jitter = bugglesJitterFraction(p);
  if (jitter <= 0) return `${hold} steady`;
  return `${hold} ±${Math.round(jitter * 100)}%`;
}

/** Triggers per second, and — once the next woggle starts cutting the cluster —
 *  what fraction of the rolled pulses is actually getting out. */
export function bugglesBurstText(p: BugglesFaceParams): string {
  if (p.burst_probability <= 0) return 'never';
  const perS = bugglesBurstTriggersPerS(p);
  const delivered = bugglesExpectedDeliveredPulses(p);
  const rolled = (BUGGLES_BURST_MIN_PULSES + BUGGLES_BURST_MAX_PULSES) / 2;
  const rate = perS >= 10 ? `${perS.toFixed(0)}/s` : `${perS.toFixed(1)}/s`;
  // Only say it when it is TRUE — a permanent "5.0 of 5.0" would be noise on
  // the four fifths of the dial where nothing is being cut.
  if (delivered >= rolled - 1e-9) return rate;
  return `${rate} · ${delivered.toFixed(1)} of ${rolled.toFixed(1)} cut`;
}

/** The carrier, plus the word that is the whole point of the readout. */
export function bugglesRingText(p: BugglesFaceParams): string {
  return `${fmtBugglesHz(bugglesRingHz(p))} sub-audio`;
}
