// packages/web/src/lib/audio/fourplexer-select.ts
//
// Pure selector-advance logic for 4PLEXER, shared between the UI (gate-
// advance preview, direct knob clicks) and the unit test. The DSP worklet
// (packages/dsp/src/fourplexer.ts) carries an inlined mirror of
// fourplexerNextSelector — this is the canonical, unit-tested definition.

/** Number of signal inputs (and therefore selector positions). */
export const FOURPLEXER_INPUTS = 4;

/**
 * Advance a selector index to the NEXT input, wrapping 3 → 0
 * (1-based: 1→2→3→4→1). `cur` is the 0-based index 0..3; non-integer or
 * out-of-range values are normalised first so a corrupt saved value can't
 * desync the selector. Returns the next 0-based index 0..3.
 */
export function fourplexerNextSelector(cur: number): number {
  const norm = ((Math.round(cur) % FOURPLEXER_INPUTS) + FOURPLEXER_INPUTS) % FOURPLEXER_INPUTS;
  return (norm + 1) % FOURPLEXER_INPUTS;
}

/** Clamp + round an arbitrary number into a valid selector index 0..3. */
export function fourplexerClampSelector(idx: number): number {
  if (!Number.isFinite(idx)) return 0;
  return ((Math.round(idx) % FOURPLEXER_INPUTS) + FOURPLEXER_INPUTS) % FOURPLEXER_INPUTS;
}

/**
 * Apply `n` gate pulses to a selector starting at `start`, returning the
 * resulting 0-based index. Used by tests to assert multi-pulse wrap
 * behaviour deterministically.
 */
export function fourplexerAdvanceBy(start: number, n: number): number {
  let cur = fourplexerClampSelector(start);
  for (let i = 0; i < n; i++) cur = fourplexerNextSelector(cur);
  return cur;
}
