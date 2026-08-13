// debounced-commit.test.ts
//
// #1583 — a debounced writer must not lose the edit it is holding when its card unmounts.
//
// The property is "no write is ever silently dropped", so the tests are about which events
// can end a pending write. Exactly one may: flush(). There is deliberately no cancel().

import { describe, expect, it, vi } from 'vitest';

import { createDebouncedCommit } from './debounced-commit';

/** Manual clock, so nothing here depends on real time. */
function fakeClock() {
  let next = 1;
  const pending = new Map<number, () => void>();
  return {
    setTimeout: (fn: () => void) => {
      const h = next++;
      pending.set(h, fn);
      return h as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (h: ReturnType<typeof setTimeout>) => {
      pending.delete(h as unknown as number);
    },
    /** Fire every armed timer, as the event loop would. */
    tick() {
      const fns = [...pending.values()];
      pending.clear();
      for (const fn of fns) fn();
    },
    get armed() {
      return pending.size;
    },
  };
}

function harness() {
  const clock = fakeClock();
  const commits: string[] = [];
  const d = createDebouncedCommit<string>((v) => commits.push(v), 250, {
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  return { clock, commits, d };
}

describe('the pending edit cannot be silently dropped', () => {
  it('exposes NO cancel — the absence IS the guard', () => {
    // #1583 was `clearTimeout(commitTimer)` in onDestroy. The fix is not "remember to
    // flush", it is that dropping a pending write has no spelling. If someone adds a
    // cancel/discard/abort here, this fails and the review conversation happens.
    const { d } = harness();
    const surface = new Set(Object.keys(d));
    for (const k of ['cancel', 'discard', 'abort', 'clear', 'reset', 'dispose']) {
      expect(surface.has(k), `createDebouncedCommit().${k}() would re-enable the #1583 data loss`).toBe(false);
    }
    // POSITIVE CONTROL: the probe can see the methods that DO exist, so the assertions
    // above are not passing against an empty object.
    expect(surface.has('schedule')).toBe(true);
    expect(surface.has('flush')).toBe(true);
  });

  it('flush() commits the pending value — the unmount path', () => {
    const { d, commits } = harness();
    d.schedule('hello');
    expect(commits, 'nothing written yet — still inside the debounce window').toEqual([]);
    expect(d.hasPending).toBe(true);
    d.flush();
    expect(commits, 'the edit survives the unmount').toEqual(['hello']);
    expect(d.hasPending).toBe(false);
  });

  it('the timer still commits on its own when nothing unmounts', () => {
    // NEGATIVE CONTROL for the leg above: proves flush() is not the ONLY way a value
    // lands, i.e. the ordinary debounce still works and the test is not passing because
    // schedule() writes through immediately.
    const { d, commits, clock } = harness();
    d.schedule('typed');
    expect(commits).toEqual([]);
    clock.tick();
    expect(commits).toEqual(['typed']);
    expect(d.hasPending).toBe(false);
  });

  it('only the LATEST value is committed, once', () => {
    const { d, commits, clock } = harness();
    d.schedule('a');
    d.schedule('ab');
    d.schedule('abc');
    expect(clock.armed, 'each keystroke re-arms rather than stacking timers').toBe(1);
    clock.tick();
    expect(commits).toEqual(['abc']);
  });

  it('flush() with nothing pending writes nothing', () => {
    const { d, commits } = harness();
    d.flush();
    expect(commits).toEqual([]);
    d.schedule('x');
    d.flush();
    d.flush();
    expect(commits, 'a second flush must not re-commit').toEqual(['x']);
  });

  it('flush() disarms the timer, so the value is not committed twice', () => {
    const { d, commits, clock } = harness();
    d.schedule('once');
    d.flush();
    clock.tick();
    expect(commits).toEqual(['once']);
  });

  it('a re-entrant commit does not resurrect a stale value', () => {
    // commit() writes the store, which can notify a subscriber that schedules again.
    // If `pending` were cleared AFTER commit, that newer value would be clobbered by the
    // stale one. Ordering is asserted rather than assumed.
    const clock = fakeClock();
    const commits: string[] = [];
    let reentered = false;
    const d = createDebouncedCommit<string>(
      (v) => {
        commits.push(v);
        if (!reentered) {
          reentered = true;
          d.schedule('newer');
        }
      },
      250,
      { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
    );
    d.schedule('older');
    d.flush();
    expect(commits).toEqual(['older']);
    expect(d.hasPending, 'the re-entrant schedule survived').toBe(true);
    d.flush();
    expect(commits).toEqual(['older', 'newer']);
  });

  it('scheduling after a flush starts a fresh window', () => {
    const { d, commits, clock } = harness();
    d.schedule('one');
    d.flush();
    d.schedule('two');
    expect(commits).toEqual(['one']);
    clock.tick();
    expect(commits).toEqual(['one', 'two']);
  });

  it('an idempotent commit makes flush-then-timer harmless', () => {
    // Both call sites early-return when the stored value is unchanged, which is what
    // makes an extra flush safe. Modelled here so the contract is recorded.
    const clock = fakeClock();
    let stored = '';
    const writes: string[] = [];
    const d = createDebouncedCommit<string>(
      (v) => {
        if (v === stored) return;
        stored = v;
        writes.push(v);
      },
      250,
      { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
    );
    d.schedule('v1');
    d.flush();
    d.schedule('v1');
    clock.tick();
    expect(writes, 'the unchanged re-commit is a no-op').toEqual(['v1']);
  });
});
