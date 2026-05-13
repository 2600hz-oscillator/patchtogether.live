// packages/web/src/lib/audio/breathe-mutation.ts
//
// BREATHE — alternating gate-density mutator shared across all 5 sequencer
// modules (Sequencer / DRUMSEQZ / SCORE / POLYSEQZ / Cartesian).
//
// Each call to breathePass() represents one "breath": flip N gates in a
// single direction, spread evenly across the available candidates, then
// return the direction the NEXT pass should use. The caller hooks this to
// each loop wrap so density oscillates: on, off, on, off — like inhale and
// exhale. Default first pass is 'off' (exhale) so a pattern starts dense
// and decays before refilling.
//
// Euclidean spread approach: we reuse the same closed-form even-distribution
// formula DRUMSEQZ's Bjorklund helper uses — `pulse on index i iff
// (i * k) mod n < k` — which is mathematically equivalent to Bjorklund's
// recursive subtraction up to rotation and is the same spread Pamela's-
// Workout-style hardware produces. We adapt it to "pick K out of N
// candidates" semantics so the breath always lifts/restores the most-evenly-
// spread subset of the currently-eligible gates.

/**
 * Even-distribution selection: pick K indices from [0, totalSteps) such that
 * the chosen indices are spread as evenly as possible across the range.
 *
 * Same closed-form mapping as `bjorklund()` in drumseqz.ts. Anchors on index
 * 0 and walks forward; matches hardware Euclidean sequencers' output.
 *
 *   k <= 0          → []
 *   k >= totalSteps → [0..totalSteps-1]
 *
 * Examples:
 *   euclideanIndices(8, 32) → [0, 4, 8, 12, 16, 20, 24, 28]
 *   euclideanIndices(3, 8)  → [0, 3, 5]   (pulse iff i*3 mod 8 < 3 → 0, 3, 5+
 *                                          modulo)
 */
export function euclideanIndices(k: number, totalSteps: number): number[] {
  if (totalSteps <= 0 || k <= 0) return [];
  if (k >= totalSteps) return Array.from({ length: totalSteps }, (_, i) => i);
  const out: number[] = [];
  for (let i = 0; i < totalSteps; i++) {
    if ((i * k) % totalSteps < k) out.push(i);
  }
  return out;
}

/**
 * One breathe pass. Given the current `gates` array, flip up to N gates
 * (N = round(breathPercent * gates.length)) in `direction`:
 *   - direction='off' → turn currently-on gates OFF (exhale)
 *   - direction='on'  → turn currently-off gates ON  (inhale)
 *
 * The selected indices are an Euclidean-spread subset of the CANDIDATES
 * (the gates that are eligible to flip). This means as the pattern
 * empties or fills, each successive pass continues to spread its impact
 * evenly across whatever is left.
 *
 * Returns the new gates array (length-stable) plus the direction the next
 * call should use (the opposite of this call's direction, regardless of
 * whether any flips actually happened — the alternation is unconditional).
 */
export function breathePass(
  gates: boolean[],
  direction: 'on' | 'off',
  breathPercent: number,
): { gates: boolean[]; nextDirection: 'on' | 'off' } {
  const next: 'on' | 'off' = direction === 'off' ? 'on' : 'off';
  const n = gates.length;
  if (n === 0) return { gates: gates.slice(), nextDirection: next };

  const pct = breathPercent < 0 ? 0 : breathPercent > 1 ? 1 : breathPercent;
  const targetCount = Math.round(pct * n);
  if (targetCount <= 0) return { gates: gates.slice(), nextDirection: next };

  // Candidates: indices currently in the OPPOSITE state of what we're moving
  // them to. direction='off' flips on→off, so candidates are currently-on.
  const candidates: number[] = [];
  for (let i = 0; i < n; i++) {
    const isOn = !!gates[i];
    if (direction === 'off' && isOn) candidates.push(i);
    else if (direction === 'on' && !isOn) candidates.push(i);
  }
  if (candidates.length === 0) {
    return { gates: gates.slice(), nextDirection: next };
  }

  // Pick min(targetCount, candidates.length) candidates spread evenly across
  // the candidate list. We Euclidean-pick INDICES INTO `candidates`, not raw
  // step indices — that way the flips remain spread across whatever's
  // eligible even when the eligible set is sparse + irregular.
  const pickCount = Math.min(targetCount, candidates.length);
  const picks = euclideanIndices(pickCount, candidates.length);

  const out = gates.slice();
  const newValue = direction === 'on';
  for (const p of picks) {
    const idx = candidates[p];
    if (idx !== undefined) out[idx] = newValue;
  }

  return { gates: out, nextDirection: next };
}

/**
 * Coerce + sanitize a stored breathe direction value into the canonical
 * 'on' | 'off' shape. Anything other than 'on' returns 'off' (the default
 * first-pass direction).
 */
export function coerceBreatheDirection(raw: unknown): 'on' | 'off' {
  return raw === 'on' ? 'on' : 'off';
}
