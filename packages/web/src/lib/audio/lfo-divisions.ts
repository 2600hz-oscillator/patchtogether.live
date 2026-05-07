// packages/web/src/lib/audio/lfo-divisions.ts
//
// Standalone constants for the Cartesian-embedded LFO. Lives outside the
// audio-module factory so unit + ART tests can import the snap-points + math
// without dragging the SvelteKit `$lib/graph/store` import chain (which the
// node-only ART runner can't resolve).

/** Snap-points for the LFO division slider. Index 0..7. The displayed text
 *  shows the multiplier; the slider value is the index, not the multiplier. */
export const LFO_DIVISIONS: ReadonlyArray<{ label: string; mult: number }> = [
  { label: '1/8',  mult: 0.125 },
  { label: '1/4',  mult: 0.25 },
  { label: '1/2',  mult: 0.5 },
  { label: '1/1',  mult: 1.0 },
  { label: 'x1.5', mult: 1.5 },
  { label: 'x2',   mult: 2.0 },
  { label: 'x4',   mult: 4.0 },
  { label: 'x8',   mult: 8.0 },
];

/** Internal LFO fallback rate when no lfo_clock is patched (Hz). */
export const LFO_DEFAULT_RATE_HZ = 1;

/** Continuous waveform morph: 0=sine, 1=tri, 2=saw, 3=square. Phase is
 *  normalized [0, 1). Output is bounded [-1, 1]. The Cartesian audio module's
 *  internal lfoMorph function is identical (kept inline for hot-path clarity);
 *  this exported version is the one tested by ART. */
export function lfoMorph(phase: number, shape: number): number {
  const s = Math.max(0, Math.min(3, shape));
  const sine = Math.sin(2 * Math.PI * phase);
  const tri  = phase < 0.5 ? 4 * phase - 1 : 3 - 4 * phase;
  const saw  = 2 * phase - 1;
  const sq   = phase < 0.5 ? 1 : -1;
  if (s < 1)      { const m = s;     return sine * (1 - m) + tri * m; }
  else if (s < 2) { const m = s - 1; return tri  * (1 - m) + saw * m; }
  else            { const m = s - 2; return saw  * (1 - m) + sq  * m; }
}
