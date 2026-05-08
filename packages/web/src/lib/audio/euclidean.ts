// packages/web/src/lib/audio/euclidean.ts
//
// Bjorklund's Euclidean rhythm algorithm. Distributes k pulses as evenly as
// possible across n steps, producing the classic "Euclidean" rhythms popular
// in modular sequencers (Pamela's Workout, Subharmonicon, etc).
//
// Reference: "The Euclidean Algorithm Generates Traditional Musical Rhythms"
// (Toussaint, 2005). The implementation here mirrors Bjorklund's original
// "pair-and-redistribute" recursion, which is what the spec's expected
// patterns assume:
//   E(4, 16) = 1000 1000 1000 1000
//   E(3, 8)  = 1001 0010
//   E(0, n)  = all zeros
//   E(n, n)  = all ones

/** Generate a Euclidean pattern of length n with k pulses, evenly distributed
 *  using Bjorklund's algorithm. k is clamped to [0, n]. Always starts on a 1
 *  when k > 0 (downbeat-aligned). */
export function bjorklund(k: number, n: number): number[] {
  if (!Number.isFinite(n) || n <= 0) return [];
  const total = Math.max(0, Math.floor(n));
  const pulses = Math.max(0, Math.min(total, Math.floor(k)));
  if (pulses === 0) return new Array<number>(total).fill(0);
  if (pulses === total) return new Array<number>(total).fill(1);

  // Bjorklund's pair-and-redistribute. Start with `pulses` groups of [1] and
  // `total - pulses` groups of [0]; on each pass, pair up groups from the
  // front with leftover groups from the back until at most one leftover
  // remains. Then flatten.
  let groups: number[][] = [];
  for (let i = 0; i < pulses; i++) groups.push([1]);
  for (let i = 0; i < total - pulses; i++) groups.push([0]);

  while (true) {
    let leftover = 0;
    // Count trailing groups whose first element matches the LAST group's
    // first element (the "remainder bucket").
    const last = groups[groups.length - 1]?.[0];
    for (let i = groups.length - 1; i >= 0; i--) {
      if (groups[i]?.[0] === last) leftover++;
      else break;
    }
    const head = groups.length - leftover;
    // Stop when we can't pair the head with any leftover (≤1 leftover left,
    // or head is empty: nothing to pair with).
    if (leftover <= 1 || head === 0) break;
    // Pair-up: combine each head group with one leftover group.
    const pairs = Math.min(head, leftover);
    const next: number[][] = [];
    for (let i = 0; i < pairs; i++) {
      const a = groups[i] ?? [];
      const b = groups[head + i] ?? [];
      next.push([...a, ...b]);
    }
    // Anything not paired keeps its place: the un-paired front (head -
    // pairs) followed by the un-paired tail (leftover - pairs).
    for (let i = pairs; i < head; i++) next.push(groups[i] ?? []);
    for (let i = pairs; i < leftover; i++) next.push(groups[head + i] ?? []);
    groups = next;
  }

  const out: number[] = [];
  for (const g of groups) out.push(...g);
  return out.slice(0, total);
}

/** Convenience: returns the indices of the 1-bits in bjorklund(k, n). */
export function bjorklundIndices(k: number, n: number): number[] {
  const pat = bjorklund(k, n);
  const out: number[] = [];
  for (let i = 0; i < pat.length; i++) if (pat[i] === 1) out.push(i);
  return out;
}
