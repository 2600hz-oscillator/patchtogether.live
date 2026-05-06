// Seeded PRNG for chaos runs. Mulberry32 — small, fast, well-distributed for
// our purposes (driving intent selection, parameter randomization). Crucial
// for reproducibility: a found bug must replay deterministically given the
// same seed + intent stream.
//
// Not cryptographically secure — we don't need that here.

export class SeededRng {
  private state: number;
  readonly seed: number;

  constructor(seed: number) {
    this.seed = seed >>> 0;
    this.state = this.seed;
  }

  /** Next float in [0, 1). */
  next(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [lo, hi]. */
  int(lo: number, hi: number): number {
    return Math.floor(lo + this.next() * (hi - lo + 1));
  }

  /** Float in [lo, hi). */
  float(lo: number, hi: number): number {
    return lo + this.next() * (hi - lo);
  }

  /** Pick one element from a non-empty array. */
  pick<T>(arr: readonly T[]): T {
    if (arr.length === 0) throw new Error('SeededRng.pick: empty array');
    return arr[Math.floor(this.next() * arr.length)]!;
  }

  /** Weighted pick: array of [item, weight] tuples. */
  weighted<T>(entries: readonly [T, number][]): T {
    if (entries.length === 0) throw new Error('SeededRng.weighted: empty');
    const total = entries.reduce((s, [, w]) => s + w, 0);
    let r = this.next() * total;
    for (const [item, w] of entries) {
      r -= w;
      if (r <= 0) return item;
    }
    return entries[entries.length - 1]![0];
  }
}

/** Generate a default seed from current time, printable so logs can replay it. */
export function defaultSeed(): number {
  return Math.floor(Date.now() % 0x7fffffff);
}
