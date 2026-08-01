// packages/web/src/lib/ui/workflow/settle-commit.test.ts
//
// PF-13's storm guard. Every clause below is a value stream shaped like a real
// input device, and the assertion is the COMMIT COUNT — because the whole point
// of the guard is that one gesture costs one 46-param transaction rather than
// sixty.
//
// The clock is a hand-rolled scheduler, not vitest fake timers: the guard takes
// `schedule`/`cancel` as injected seams precisely so its behaviour can be
// stated in "how many timers fired", with no global timer state and no
// possibility of a test passing because a real timer happened to be slow.

import { describe, expect, it } from 'vitest';
import { createSettleCommit, MACRO_SETTLE_MS } from './settle-commit';

/** A manual scheduler: `run()` fires every armed timer, once. */
function makeClock() {
  const timers = new Map<number, () => void>();
  let next = 1;
  return {
    schedule(cb: () => void): unknown {
      const h = next++;
      timers.set(h, cb);
      return h;
    },
    cancel(h: unknown): void {
      timers.delete(h as number);
    },
    /** Fire everything currently armed. */
    run(): void {
      const armed = [...timers.entries()];
      timers.clear();
      for (const [, cb] of armed) cb();
    },
    get armed(): number {
      return timers.size;
    },
  };
}

function harness() {
  const clock = makeClock();
  const commits: [string, number][] = [];
  const guard = createSettleCommit<number>(
    (k, v) => commits.push([k, v]),
    { schedule: clock.schedule, cancel: clock.cancel },
  );
  return { clock, commits, guard };
}

describe('createSettleCommit — coalescing', () => {
  it('a lone write commits once, on settle', () => {
    const { clock, commits, guard } = harness();
    guard.write('n1', 2);
    expect(commits, 'nothing commits before the window closes').toEqual([]);
    clock.run();
    expect(commits).toEqual([['n1', 2]]);
  });

  it('a SWEEP (0→1→2→3) inside one window commits ONCE, at the last value', () => {
    // The knob-drag / hot-CC shape. Sixty distinct values in, one 46-param
    // transaction out.
    const { clock, commits, guard } = harness();
    for (const v of [1, 2, 3]) guard.write('n1', v);
    clock.run();
    expect(commits).toEqual([['n1', 3]]);
  });

  it('a REPEAT does not re-arm the window — a stuck CC commits once and goes quiet', () => {
    const { clock, commits, guard } = harness();
    guard.write('n1', 2);
    guard.write('n1', 2);
    guard.write('n1', 2);
    expect(clock.armed, 'one timer, not three').toBe(1);
    clock.run();
    expect(commits).toEqual([['n1', 2]]);
    // Still repeating after the commit: now the intent equals the last commit.
    guard.write('n1', 2);
    guard.write('n1', 2);
    expect(clock.armed).toBe(0);
    clock.run();
    expect(commits).toEqual([['n1', 2]]);
  });

  it('AWAY-AND-BACK lands where the user stopped (the dedupe-target bug)', () => {
    // THE clause this file exists for. Deduping against the LAST COMMIT alone
    // would swallow the write of 0 here as "already 0" and then commit the
    // stale pending 1 — the opposite of what the user did. The intent is the
    // PENDING value when one is staged.
    const { clock, commits, guard } = harness();
    guard.write('n1', 0);
    clock.run();
    expect(commits).toEqual([['n1', 0]]);
    guard.write('n1', 1);
    guard.write('n1', 0);
    clock.run();
    expect(commits).toEqual([['n1', 0], ['n1', 0]]);
  });

  it('two NODES coalesce independently', () => {
    const { clock, commits, guard } = harness();
    guard.write('a', 1);
    guard.write('b', 3);
    guard.write('a', 2);
    clock.run();
    expect(commits.sort()).toEqual([['a', 2], ['b', 3]]);
  });

  it('a SECOND gesture after the window commits again', () => {
    const { clock, commits, guard } = harness();
    guard.write('n1', 1);
    clock.run();
    guard.write('n1', 3);
    clock.run();
    expect(commits).toEqual([['n1', 1], ['n1', 3]]);
  });
});

describe('createSettleCommit — flush / reset / introspection', () => {
  it('flush() commits the staged value immediately and disarms', () => {
    const { clock, commits, guard } = harness();
    guard.write('n1', 2);
    guard.flush();
    expect(commits).toEqual([['n1', 2]]);
    expect(clock.armed, 'the timer was cancelled, not left to double-fire').toBe(0);
    clock.run();
    expect(commits).toEqual([['n1', 2]]);
  });

  it('reset() drops staged values WITHOUT committing', () => {
    const { clock, commits, guard } = harness();
    guard.write('n1', 2);
    guard.reset();
    clock.run();
    expect(commits).toEqual([]);
  });

  it('pendingKeys() reports what is staged', () => {
    const { clock, guard } = harness();
    expect(guard.pendingKeys()).toEqual([]);
    guard.write('n1', 2);
    expect(guard.pendingKeys()).toEqual(['n1']);
    clock.run();
    expect(guard.pendingKeys()).toEqual([]);
  });

  it('the default settle window is short enough to feel like a click', () => {
    // 80 ms: longer than a pointer frame (~16 ms) and a hot CC gap (~3-10 ms),
    // well under the ~100 ms where a commit stops feeling immediate.
    expect(MACRO_SETTLE_MS).toBeLessThanOrEqual(100);
    expect(MACRO_SETTLE_MS).toBeGreaterThanOrEqual(32);
  });
});
