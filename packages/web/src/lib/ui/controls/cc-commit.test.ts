// packages/web/src/lib/ui/controls/cc-commit.test.ts
//
// Unit gate for the streaming-CC coalescer (the MIDI-CC render-starvation
// fix). Uses injected fake timers/now — no real setTimeout, no rAF, fully
// deterministic. The load-bearing invariants:
//
//   1. TRANSIENT per message: every push() reaches the transient callback
//      (engine handle + knob visual) — full-rate motion, zero store writes.
//   2. COALESCED durable commits: a burst produces a leading-edge commit +
//      at most one commit per activeCommitMs window — never one per message.
//   3. FINAL-VALUE CONVERGENCE: the trailing settle flush ALWAYS lands the
//      last pushed value (collab peers / persistence see the settled knob).
//   4. flush()/dispose() land any pending value unconditionally.
//   5. A single cold poke commits IMMEDIATELY (store never lags a lone CC).

import { describe, it, expect } from 'vitest';
import { createCcCommit, flushAllCcCommits } from './cc-commit';

/** Deterministic fake clock + timer queue (ordered by due time, FIFO ties). */
class FakeTimers {
  private t = 0;
  private seq = 0;
  private timers: { at: number; seq: number; cb: () => void }[] = [];

  now = (): number => this.t;

  schedule = (cb: () => void, ms: number): unknown => {
    const h = { at: this.t + ms, seq: this.seq++, cb };
    this.timers.push(h);
    return h;
  };

  cancel = (h: unknown): void => {
    this.timers = this.timers.filter((x) => x !== h);
  };

  /** Advance the clock, firing due timers in order. */
  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      const due = this.timers
        .filter((x) => x.at <= target)
        .sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!due) break;
      this.timers = this.timers.filter((x) => x !== due);
      this.t = due.at;
      due.cb();
    }
    this.t = target;
  }
}

function harness(opts: { activeCommitMs?: number; settleMs?: number } = {}) {
  const timers = new FakeTimers();
  const commits: number[] = [];
  const transients: number[] = [];
  const activeLog: boolean[] = [];
  const pump = createCcCommit({
    commit: (v) => commits.push(v),
    transient: (v) => transients.push(v),
    onActiveChange: (a) => activeLog.push(a),
    activeCommitMs: opts.activeCommitMs ?? 150,
    settleMs: opts.settleMs ?? 200,
    now: timers.now,
    schedule: timers.schedule,
    cancel: timers.cancel,
  });
  return { timers, commits, transients, activeLog, pump };
}

describe('createCcCommit — streaming-CC coalescer', () => {
  it('single cold poke commits immediately (store never lags a lone CC)', () => {
    const { commits, transients, pump } = harness();
    pump.push(0.5);
    expect(commits).toEqual([0.5]);
    expect(transients).toEqual([0.5]);
    pump.dispose();
  });

  it('a tight burst = every message transient, ONE leading commit, settle lands the final value', () => {
    const { timers, commits, transients, pump } = harness();
    // 100 messages inside one instant (same fake-clock tick).
    for (let i = 0; i < 100; i++) pump.push(i);
    expect(transients).toHaveLength(100); // full-rate transient motion
    expect(commits).toEqual([0]); // leading edge only — 1 store write, not 100
    expect(pump.active).toBe(true);
    // Settle flush 200ms after the last message lands the FINAL value.
    timers.advance(200);
    expect(commits).toEqual([0, 99]);
    expect(pump.active).toBe(false);
    pump.dispose();
  });

  it('a paced 250 msg/s stream commits at most once per activeCommitMs window', () => {
    const { timers, commits, transients, pump } = harness();
    // 100 messages, 4ms apart = 396ms of stream (the owner-report cadence).
    for (let i = 0; i < 100; i++) {
      pump.push(i);
      timers.advance(4);
    }
    expect(transients).toHaveLength(100);
    // Leading commit at t=0, then one per 150ms window: t≈150, t≈300 — and
    // nothing else while the stream is hot.
    expect(commits.length).toBeLessThanOrEqual(4);
    expect(commits.length).toBeGreaterThanOrEqual(3);
    expect(commits[0]).toBe(0);
    // Settle lands the last value exactly once.
    timers.advance(300);
    expect(commits[commits.length - 1]).toBe(99);
    expect(commits.length).toBeLessThanOrEqual(5);
    // No further commits after settle.
    const settled = commits.length;
    timers.advance(2000);
    expect(commits.length).toBe(settled);
    expect(pump.active).toBe(false);
    pump.dispose();
  });

  it('active toggles true on first message and false only at settle', () => {
    const { timers, activeLog, pump } = harness();
    pump.push(1);
    expect(activeLog).toEqual([true]);
    timers.advance(100);
    pump.push(2); // keeps the stream hot — settle re-arms
    timers.advance(150);
    expect(activeLog).toEqual([true]); // not yet settled (200ms after LAST msg)
    timers.advance(60);
    expect(activeLog).toEqual([true, false]);
    pump.dispose();
  });

  it('flush() lands the pending value immediately and never double-commits', () => {
    const { timers, commits, pump } = harness();
    pump.push(1); // leading commit
    pump.push(2); // pending (inside the window)
    expect(commits).toEqual([1]);
    pump.flush();
    expect(commits).toEqual([1, 2]);
    pump.flush(); // no pending → no-op
    expect(commits).toEqual([1, 2]);
    // The settle timer still fires but has nothing left to commit.
    timers.advance(500);
    expect(commits).toEqual([1, 2]);
    pump.dispose();
  });

  it('dispose() flushes pending, deactivates, and cancels all timers', () => {
    const { timers, commits, activeLog, pump } = harness();
    pump.push(1);
    pump.push(7);
    expect(commits).toEqual([1]);
    pump.dispose();
    expect(commits).toEqual([1, 7]); // unconditional flush on unmount
    expect(activeLog).toEqual([true, false]);
    timers.advance(5000); // no timer fires post-dispose
    expect(commits).toEqual([1, 7]);
  });

  it('a push after dispose degrades to a direct commit (never loses a value)', () => {
    const { commits, pump } = harness();
    pump.dispose();
    pump.push(3);
    expect(commits).toEqual([3]);
  });

  it('flushAllCcCommits() flushes every live pump (the before-save hook)', () => {
    const a = harness();
    const b = harness();
    a.pump.push(1);
    a.pump.push(2); // pending on a
    b.pump.push(10);
    b.pump.push(20); // pending on b
    flushAllCcCommits();
    expect(a.commits).toEqual([1, 2]);
    expect(b.commits).toEqual([10, 20]);
    a.pump.dispose();
    b.pump.dispose();
  });

  it('interleaved values: the engine sees every message, the store sees the coalesced tail', () => {
    const { timers, commits, transients, pump } = harness();
    const sent: number[] = [];
    for (let i = 0; i < 40; i++) {
      const v = Math.round(63.5 + 63.5 * Math.sin(i * 0.11));
      sent.push(v);
      pump.push(v);
      timers.advance(4);
    }
    timers.advance(400);
    expect(transients).toEqual(sent); // per-message engine motion
    expect(commits[commits.length - 1]).toBe(sent[sent.length - 1]); // convergence
    expect(commits.length).toBeLessThan(sent.length / 4); // and it actually coalesced
    pump.dispose();
  });
});

// ───────────────────── Batched mode (the shared two-lane batcher) ─────────────────────
//
// With a `batcher` injected, the pump must route EVERY durable commit
// through it (never its private timer): leading edge → enqueue, hot →
// markHot (the shared ticker drains via takeDue), settle → enqueue +
// markCold, flush/dispose → enqueue + flushNow. Fake batcher — the real
// sink's transaction/origin behavior is pinned in cc-batch-store.test.ts.

import type { CcBatcher, CcLane, CcTickClient } from './cc-commit-batch';

interface FakeBatcher extends CcBatcher {
  log: string[];
  enqueued: Array<{ lane: CcLane; run: () => void }>;
  hot: Set<CcTickClient>;
  drainQueued(): void;
  drainHot(): void;
}

function fakeBatcher(): FakeBatcher {
  const log: string[] = [];
  const enqueued: Array<{ lane: CcLane; run: () => void }> = [];
  const hot = new Set<CcTickClient>();
  return {
    log,
    enqueued,
    hot,
    enqueue(lane, run) {
      log.push(`enqueue:${lane}`);
      enqueued.push({ lane, run });
    },
    markHot(c) {
      log.push('markHot');
      hot.add(c);
    },
    markCold(c) {
      log.push('markCold');
      hot.delete(c);
    },
    flushNow() {
      log.push('flushNow');
      this.drainHot();
      this.drainQueued();
    },
    drainQueued() {
      for (const e of enqueued.splice(0)) e.run();
    },
    drainHot() {
      for (const c of [...hot]) {
        const t = c.takeDue();
        if (t) t();
      }
    },
  };
}

function batchedHarness(opts: { lane?: CcLane } = {}) {
  const timers = new FakeTimers();
  const batcher = fakeBatcher();
  const commits: number[] = [];
  const transients: number[] = [];
  const pump = createCcCommit({
    commit: (v) => commits.push(v),
    transient: (v) => transients.push(v),
    lane: opts.lane,
    batcher,
    now: timers.now,
    schedule: timers.schedule,
    cancel: timers.cancel,
  });
  return { timers, batcher, commits, transients, pump };
}

describe('createCcCommit + shared batcher', () => {
  it('cold poke: the leading commit goes through enqueue (end-of-microtask), not a direct write', () => {
    const h = batchedHarness();
    h.pump.push(0.4);
    expect(h.transients).toEqual([0.4]); // transient stays per-message + synchronous
    expect(h.commits).toEqual([]); // durable commit deferred to the batcher flush
    expect(h.batcher.log).toEqual(['enqueue:undoable']);
    h.batcher.drainQueued();
    expect(h.commits).toEqual([0.4]);
  });

  it('hot stream: joins the shared ticker; drains via takeDue once per window; settle enqueues + goes cold', () => {
    const h = batchedHarness();
    h.pump.push(0.1); // leading → enqueue
    h.batcher.drainQueued();
    h.timers.advance(20);
    h.pump.push(0.2); // hot → markHot (NO private throttle timer)
    h.timers.advance(20);
    h.pump.push(0.3);
    expect(h.batcher.log).toEqual(['enqueue:undoable', 'markHot', 'markHot']);
    expect(h.batcher.hot.size).toBe(1); // markHot idempotent

    h.batcher.drainHot(); // the shared tick
    expect(h.commits).toEqual([0.1, 0.3]); // latest pending only
    h.batcher.drainHot(); // due-less tick → nothing
    expect(h.commits).toEqual([0.1, 0.3]);

    h.pump.push(0.5);
    h.timers.advance(300); // settle fires
    expect(h.batcher.log.at(-2)).toBe('enqueue:undoable');
    expect(h.batcher.log.at(-1)).toBe('markCold');
    expect(h.batcher.hot.size).toBe(0);
    h.batcher.drainQueued();
    expect(h.commits).toEqual([0.1, 0.3, 0.5]); // settled value always lands
    expect(h.pump.active).toBe(false);
  });

  it('flush() + dispose() enqueue any pending value and flushNow synchronously', () => {
    const h = batchedHarness();
    h.pump.push(0.1);
    h.batcher.drainQueued();
    h.timers.advance(20);
    h.pump.push(0.9); // hot, pending
    h.pump.flush();
    expect(h.batcher.log.at(-2)).toBe('enqueue:undoable');
    expect(h.batcher.log.at(-1)).toBe('flushNow');
    expect(h.commits).toEqual([0.1, 0.9]);

    h.timers.advance(10);
    h.pump.push(0.95);
    h.pump.dispose();
    expect(h.commits).toEqual([0.1, 0.9, 0.95]);
    expect(h.batcher.hot.size).toBe(0); // markCold on dispose
  });

  it("the Electra pump's lane rides through as 'bare'", () => {
    const h = batchedHarness({ lane: 'bare' });
    h.pump.push(0.7);
    expect(h.batcher.log).toEqual(['enqueue:bare']);
    h.timers.advance(20);
    h.pump.push(0.8);
    const client = [...h.batcher.hot][0]!;
    expect(client.lane).toBe('bare');
  });
});
