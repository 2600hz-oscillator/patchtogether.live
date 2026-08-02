// packages/web/src/lib/ui/workflow/settle-commit.ts
//
// PF-13's storm guard — a PURE, timer-injectable coalescer for a MACRO param
// write: one gesture-shaped stream of values in, ONE durable commit out.
//
// WHY IT EXISTS. A normal param write is one number into one key. A macro write
// (`SHELL_PARAM_WRITES` — cloudseed's `preset_index`) is one number into
// FORTY-SIX keys, as a single `mutateNode` transaction. That is exactly the
// right shape for one deliberate pick and exactly the wrong shape for a stream:
//   * a KnobConic drag rides `createDragCommit` (rAF-coalesced — up to ~60
//     commits/s),
//   * a learned MIDI CC rides `createCcCommit` (~7 commits/s while hot, plus a
//     settle flush),
// and either one multiplied by a 46-param transaction is the write storm the
// `midi-cc-write-storm-fix` memo is about. The per-control pumps already
// coalesce the STREAM; this coalesces the AMPLIFICATION the macro adds on top.
//
// THE THREE RULES, and why they are these three:
//
//   1. DEDUPE AGAINST THE CURRENT INTENT, not against the last commit. The
//      intent is the pending value when one is staged, else the CURRENT state
//      of the world. Deduping against the last COMMIT alone is a real bug:
//      with `lastCommitted = 0` and `pending = 1`, a write of 0 would be
//      swallowed as "already 0" and the guard would go on to commit 1 — the
//      opposite of what the user did. A sweep away-and-back must land where it
//      stopped.
//   2. THE "CURRENT STATE" IS READ, NOT REMEMBERED. `readCurrent` asks the
//      caller for the value that is REALLY there right now.
//
//      ⚠ THIS IS A FIX FOR A REPRODUCED, SILENT BUG, not a refinement. The
//      guard used to fall back to its own page-lifetime `committed` memory,
//      which is never reconciled against anything. The value it guards moves by
//      paths the guard cannot see — undo, a rack-mate's edit, a rack load, the
//      legacy card's direct write — and the moment memory and reality disagree,
//      a write of the REMEMBERED value is dropped ENTIRELY: not deferred, not
//      partially applied, nothing happens at all. Measured on cloudseed in a
//      real browser: click `short room` → ⌘Z (the graph is back at slot 0, and
//      the segment row correctly shows `divine inspiration`) → click
//      `short room` again → `preset_index` stays 0 and the reverb never
//      changes. The user cannot redo their own pick by clicking it.
//      Reality-based dedupe drops a genuine repeat (rule 3 still holds, because
//      after a commit the world really IS that value) while letting a re-pick
//      through, which memory-based dedupe structurally cannot distinguish.
//      `committed` survives only as the fallback for a caller with no reader.
//   3. COMMIT ON SETTLE, not on every distinct value. A repeat does NOT
//      re-arm the timer, so a stuck CC repeating one value commits ONCE and
//      then goes quiet instead of holding the window open forever.
//
// Everything time-shaped is injected (`schedule` / `cancel`), so the unit test
// drives a manual clock and no test anywhere depends on a real timer.

/** Injection seams + tuning for `createSettleCommit`. */
export interface SettleCommitOptions<T = number> {
  /** Quiet period after the last write before the durable commit fires. */
  settleMs?: number;
  /** Timer scheduler (defaults to `setTimeout`). */
  schedule?: (cb: () => void, ms: number) => unknown;
  /** Timer canceller (defaults to `clearTimeout`). */
  cancel?: (handle: unknown) => void;
  /**
   * The value REALLY held by `key` right now, or `undefined` when it cannot be
   * read (node gone, store not booted). Rule 2 — supply this whenever the
   * guarded value can move by a path other than this guard, which for anything
   * living in the patch graph is always (undo / collab / load).
   */
  readCurrent?: (key: string) => T | undefined;
}

export interface SettleCommit<T> {
  /** Stage a value for `key`. Deduped + coalesced per the rules above. */
  write(key: string, value: T): void;
  /** Force any staged value(s) to commit NOW — one key, or all of them. */
  flush(key?: string): void;
  /** Keys with a staged, not-yet-committed value (test/introspection). */
  pendingKeys(): string[];
  /** Drop every staged value + timer WITHOUT committing (teardown). */
  reset(): void;
}

/**
 * 80 ms. Long enough that a pointer drag (a new value every ~16 ms) and a hot
 * CC stream (a message every ~3–10 ms) both collapse to one commit, short
 * enough that a single deliberate click still feels immediate — a segment click
 * commits within one animation frame plus change.
 */
export const MACRO_SETTLE_MS = 80;

/** Build a settle-coalescing committer. `commit` runs at most once per settle
 *  window per key, with the LAST value staged for that key. Pure apart from the
 *  injected timer. */
export function createSettleCommit<T>(
  commit: (key: string, value: T) => void,
  opts: SettleCommitOptions<T> = {},
): SettleCommit<T> {
  const settleMs = opts.settleMs ?? MACRO_SETTLE_MS;
  const schedule = opts.schedule ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
  const cancel = opts.cancel ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const readCurrent = opts.readCurrent;

  interface Entry {
    pending?: { value: T };
    committed?: { value: T };
    timer?: unknown;
  }
  const entries = new Map<string, Entry>();

  function fire(key: string): void {
    const e = entries.get(key);
    if (!e?.pending) return;
    const { value } = e.pending;
    e.pending = undefined;
    e.timer = undefined;
    e.committed = { value };
    commit(key, value);
  }

  return {
    write(key, value) {
      const e = entries.get(key) ?? {};
      entries.set(key, e);
      // Rules 1 + 2 — the CURRENT INTENT is the staged value if one is staged,
      // else the value REALLY there now. `committed` is consulted only when no
      // reader was supplied: it is page-lifetime memory of what this guard did,
      // and treating it as the state of the world is what silently swallowed a
      // whole recall (see the header).
      const live = readCurrent?.(key);
      const intent = e.pending ?? (live !== undefined ? { value: live } : e.committed);
      if (intent && Object.is(intent.value, value)) return;
      e.pending = { value };
      if (e.timer !== undefined) cancel(e.timer);
      e.timer = schedule(() => fire(key), settleMs);
    },
    flush(key) {
      const keys = key === undefined ? [...entries.keys()] : [key];
      for (const k of keys) {
        const e = entries.get(k);
        if (e?.timer !== undefined) cancel(e.timer);
        fire(k);
      }
    },
    pendingKeys() {
      return [...entries.entries()].filter(([, e]) => e.pending !== undefined).map(([k]) => k);
    },
    reset() {
      for (const e of entries.values()) {
        if (e.timer !== undefined) cancel(e.timer);
      }
      entries.clear();
    },
  };
}
