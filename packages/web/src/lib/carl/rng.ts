// packages/web/src/lib/carl/rng.ts
//
// Mulberry32 seeded PRNG — identical algorithm to e2e/chaos/lib/seed-rng.ts.
// Lives inside packages/web so the in-browser Rackspace Carl can import it
// without pulling Playwright. Keep the two copies bit-for-bit identical so
// any seed reproduces between chaos runner and rackspace runs.

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

export function defaultSeed(): number {
  return Math.floor(Date.now() % 0x7fffffff);
}
