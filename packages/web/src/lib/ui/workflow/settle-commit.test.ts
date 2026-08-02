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

/**
 * The same harness plus a stand-in for the GRAPH: a mutable world the commit
 * writes into and the guard's `readCurrent` reads back. `world` can also be
 * moved from OUTSIDE the guard — which is the whole point, because
 * `preset_index` really is moved from outside by undo, by a rack-mate and by a
 * rack load.
 */
function worldHarness() {
  const clock = makeClock();
  const commits: [string, number][] = [];
  const world = new Map<string, number>();
  const guard = createSettleCommit<number>(
    (k, v) => {
      commits.push([k, v]);
      world.set(k, v);
    },
    { schedule: clock.schedule, cancel: clock.cancel, readCurrent: (k) => world.get(k) },
  );
  return { clock, commits, world, guard };
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

describe('createSettleCommit — the dedupe target is REALITY, not memory', () => {
  // ⚠ THIS BLOCK IS THE REGRESSION FOR A REPRODUCED, SILENT, TOTAL NO-OP.
  // The guard used to fall back to its own page-lifetime `committed` memory
  // when nothing was staged. That memory is never reconciled against anything,
  // and the guarded value moves by paths the guard cannot see. When they
  // disagree, a write of the REMEMBERED value was dropped entirely — not
  // deferred, not partial. Measured in a browser on cloudseed: recall
  // `short room`, ⌘Z, click `short room` again → nothing happens at all.

  it('a RE-PICK after the world moved underneath us COMMITS (undo / rack-mate / load)', () => {
    const { clock, commits, world, guard } = worldHarness();
    guard.write('n1', 1);
    clock.run();
    expect(commits).toEqual([['n1', 1]]);

    // Somebody else moves it — undo, a rack-mate, a rack load. The guard's own
    // memory still says 1; the world says 0.
    world.set('n1', 0);

    guard.write('n1', 1); // the user clicks `short room` again
    expect(guard.pendingKeys(), 'the re-pick must be STAGED, not swallowed').toEqual(['n1']);
    clock.run();
    expect(commits, 'and it must actually land').toEqual([['n1', 1], ['n1', 1]]);
    expect(world.get('n1')).toBe(1);
  });

  it('…and a genuine REPEAT is still dropped, so the storm guard still holds', () => {
    // The reason memory-based dedupe existed at all. Reality-based dedupe keeps
    // the property (after a commit the world really IS that value) WITHOUT
    // being blind to an external change — which is the distinction memory
    // structurally cannot make.
    const { clock, commits, guard } = worldHarness();
    guard.write('n1', 1);
    clock.run();
    for (let i = 0; i < 20; i++) guard.write('n1', 1); // a stuck CC
    expect(clock.armed, 'no timer re-armed by a repeat').toBe(0);
    clock.run();
    expect(commits).toEqual([['n1', 1]]);
  });

  it('a write matching the world but NOT yet committed by us is still dropped', () => {
    // Boot case: the graph already holds slot 2 (loaded rack) and the user
    // clicks the segment that is already active. Nothing to do — and `Segmented`
    // blocks it anyway; this pins that the guard agrees.
    const { clock, commits, world, guard } = worldHarness();
    world.set('n1', 2);
    guard.write('n1', 2);
    expect(guard.pendingKeys()).toEqual([]);
    clock.run();
    expect(commits).toEqual([]);
  });

  it('AWAY-AND-BACK still wins over the world read (pending outranks current)', () => {
    // Rule 1 must survive rule 2: mid-gesture the staged value is the intent,
    // so a sweep 0→1→0 within one window commits 0, not the stale 1.
    const { clock, commits, world, guard } = worldHarness();
    world.set('n1', 0);
    guard.write('n1', 1);
    guard.write('n1', 0);
    clock.run();
    expect(commits).toEqual([['n1', 0]]);
  });

  it('an UNREADABLE world (node gone / not booted) falls back to memory, not to a storm', () => {
    const { clock, commits, guard } = harness(); // no readCurrent at all
    guard.write('n1', 1);
    clock.run();
    guard.write('n1', 1);
    expect(clock.armed).toBe(0);
    expect(commits).toEqual([['n1', 1]]);
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
