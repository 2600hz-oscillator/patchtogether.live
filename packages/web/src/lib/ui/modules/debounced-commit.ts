// debounced-commit.ts
//
// A debounced writer that CANNOT silently drop the edit it is holding.
//
// THE BUG THIS EXISTS FOR (#1583, found auditing the #1574 defect class): both code
// editors debounced their commit by 250 ms and then did this on unmount:
//
//     onDestroy(() => {
//       if (commitTimer) clearTimeout(commitTimer);   // <- the pending edit dies here
//       editor?.destroy();
//     });
//
// `scheduleCommit` is the ONLY writer of `node.data.text` (LIVECODE) and
// `node.data.source` (CLOCKED RUNNER). So typing and then collapsing the faceplate within
// 250 ms silently discarded the last edit: the module kept running the PREVIOUS script and
// re-expanding showed the old text, with nothing to indicate anything had been lost.
//
// That is worse than it sounds under the faceplate shell, because an un-migrated module's
// card exists only inside the dock full-view — so COLLAPSE unmounts it, and the dock also
// LRU-EVICTS a pane when a third module is expanded. The user need not touch the editor at
// all for its unmount to fire.
//
// ── WHY THIS IS A MODULE AND NOT TWO LOCAL FIXES ──────────────────────────────
//
// The same eight lines were duplicated in both cards and both were wrong in the same way.
// A shared seam means the next debounced editor inherits the correct behaviour instead of
// re-deriving it, and it gives the guard below one place to live.
//
// ── THE STRUCTURAL GUARD ──────────────────────────────────────────────────────
//
// This deliberately exposes `schedule` and `flush` and NOT `cancel`. The absence is the
// guard, the same way the node registries' missing `dispose()` is (#1531/#1574): a card
// physically cannot drop a pending edit, because there is no method that does that, and
// `tsc` refuses the attempt before any test runs. Teardown has exactly one correct
// spelling — `flush()` — and it is also the only one available.
//
// `commit` must be idempotent for an unchanged value (both call sites already early-return
// when the stored value equals the new one), because flush() may commit a value the
// debounce would have committed anyway.

export interface DebouncedCommit<T> {
  /** Record `value` and (re)start the debounce window. */
  schedule(value: T): void;
  /**
   * Commit any pending value NOW and clear the timer.
   *
   * This is the ONLY teardown. Call it from `onDestroy` — never reach for a bare
   * `clearTimeout`, which is what #1583 was.
   */
  flush(): void;
  /** Test/introspection: is a write currently pending? */
  readonly hasPending: boolean;
}

/**
 * @param commit  the real write (must no-op when the value is unchanged)
 * @param delayMs debounce window
 * @param deps    injectable timers, for tests
 */
export function createDebouncedCommit<T>(
  commit: (value: T) => void,
  delayMs: number,
  deps: {
    setTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clearTimeout?: (h: ReturnType<typeof setTimeout>) => void;
  } = {},
): DebouncedCommit<T> {
  const setT = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = deps.clearTimeout ?? ((h) => clearTimeout(h));

  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { value: T } | null = null;

  function flush(): void {
    if (timer !== null) {
      clearT(timer);
      timer = null;
    }
    if (!pending) return;
    const { value } = pending;
    // Clear BEFORE committing: `commit` can re-enter (it writes the store, which can
    // notify a subscriber that schedules again), and a stale `pending` would then be
    // re-committed over the newer value.
    pending = null;
    commit(value);
  }

  return {
    schedule(value: T): void {
      pending = { value };
      if (timer !== null) clearT(timer);
      timer = setT(() => {
        timer = null;
        flush();
      }, delayMs);
    },
    flush,
    get hasPending(): boolean {
      return pending !== null;
    },
  };
}
