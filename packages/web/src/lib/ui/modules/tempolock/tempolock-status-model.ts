// packages/web/src/lib/ui/modules/tempolock/tempolock-status-model.ts
//
// The TEMPOLOCK status surface's pure model — every string its two lamps can
// produce, and the ONE place the tracked tempo is allowed to become words.
//
// PURE by design (the cv-buddy-status-model shape): no Svelte, no store, no
// engine. The component reads the engine snapshot and hands the ANSWERS here,
// so every sentence this face can produce is decidable in the unit lane. That
// matters more than usual, because ALL of these strings are UNPAINTED — they
// live in `aria-label`/`title` per the resting-text rulings (#1957 + the
// 2026-08-19 four): a BPM readout is derived state, TIMELORDE's own face
// deleted its BPM footer for exactly this reason, and the value's home is the
// lamp's detail attribute — speakable, assertable, hoverable, never a text
// node.

import type { TempolockState } from '$lib/audio/modules/tempolock';

/** One decimal is the honest precision: the tracker's own wobble on real
 *  material is a few tenths of a BPM, so a second decimal would print noise. */
export function tempolockBpmText(bpm: number): string {
  return `${bpm.toFixed(1)} BPM`;
}

/** The LOCK lamp's picture: lit iff confidently locked. */
export function tempolockLockLit(state: TempolockState | null): boolean {
  return state?.locked === true;
}

/**
 * The LOCK lamp's detail — where the tracked BPM lives. Three modes, three
 * different sentences, because a dark LOCK lamp is ambiguous between "never
 * had input" and "input went away mid-set" and those need different player
 * responses (patch something in vs. wait/rescue), exactly the ambiguity the
 * cvBuddy ROUTED lamp's detail exists to resolve.
 */
export function tempolockLockDetail(state: TempolockState | null): string {
  if (!state || state.mode === 'cold') {
    return 'No lock yet: the clock stays silent until a steady onset train arrives at IN '
      + '(about four consistent gaps declare the first lock).';
  }
  if (state.mode === 'coast') {
    const bpm = state.bpm === null ? '' : ` at the last locked ${tempolockBpmText(state.bpm)}`;
    return `Coasting: the input went quiet, so the clock free-runs${bpm} — nothing synced to it `
      + 'stops — and relocks when onsets return.';
  }
  const bpm = state.bpm === null ? 'the tracked tempo' : tempolockBpmText(state.bpm);
  return `Locked at ${bpm} — steady quarter-note clocks on the CLOCK jack.`;
}

/** The BEAT lamp's picture: a clock rising edge landed within ~150 ms. */
export function tempolockBeatLit(state: TempolockState | null): boolean {
  return state?.beatRecent === true;
}

/** The BEAT lamp's detail. The skip counter rides here (the cv-buddy LATE
 *  discipline: a count may not paint, but it must be reachable). */
export function tempolockBeatDetail(state: TempolockState | null): string {
  const head = 'Blinks on each emitted quarter-note clock pulse.';
  if (!state || state.skips <= 0) return head;
  return `${head} ${state.skips} pulse${state.skips === 1 ? '' : 's'} could not be scheduled by a `
    + 'late tick (main-thread stall) since this node was created.';
}
