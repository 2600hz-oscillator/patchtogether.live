// packages/web/src/lib/ui/controls/drag-commit.ts
//
// rAF-coalesced commit helper for continuous drag inputs (Fader, Knob).
//
// Why this exists
// ---------------
// Pointer events fire at 120–240 Hz on modern hardware. Every event the
// fader / knob handler dispatches `onchange(v)` synchronously, and
// `onchange` in turn mutates the SyncedStore patch graph:
//   patch.nodes[id].params[paramId] = v
//
// That single assignment is cheap *in isolation*, but it triggers a Yjs
// `update` event, which causes the snapshot bus to recompute a fresh
// PatchSnapshot (O(nodes + edges)) and push it to every subscriber —
// the audio reconciler (which walks the snapshot looking for diffs) and
// the Canvas UI (which has many `$derived` blocks that re-run on every
// snapshot tick + ultimately drives Svelte Flow's node-array prop).
//
// User-visible symptom: dragging a fader by hand causes audible tempo
// drift / glitches. LFOs driving the same AudioParam don't glitch
// because Web Audio's `.connect(audioParam)` path is wholly inside the
// audio thread — it never touches the JS patch graph. The contrast
// (user-reported) localised the bug to the manual-modulation code path.
//
// Fix
// ---
// `createDragCommit()` returns `{ commit, flush, dispose }`:
//   - During a drag, the handler calls `commit(v)` on every pointermove.
//     The helper stores `v` and schedules a rAF callback (idempotent).
//     The rAF callback invokes the real onchange with the *latest*
//     value — coalescing N pointermoves per frame into ONE patch
//     mutation.
//   - On `pointerup` the handler calls `flush()` to make absolutely
//     sure the final value reaches the patch store (otherwise a
//     trailing rAF could be cancelled by component unmount).
//   - On component teardown the handler calls `dispose()` to cancel
//     any pending rAF.
//
// Visual feedback is unaffected: the fader/knob still mutates its
// local `liveValue` synchronously inside `pointermove`, so the thumb
// still moves at full pointer rate. Only the patch-store commit (and
// the cascade of work it triggers) is coalesced.
//
// Drop-tail values cannot be lost: the helper always commits the most
// recent value passed to `commit()`. If a frame already has a pending
// commit, the new value simply replaces the pending one and the rAF
// fires once at the next paint.

export interface DragCommit {
  /** Stage a value for commit at the next animation frame. Idempotent
   *  within a frame — only the last value passed wins. */
  commit(value: number): void;
  /** Force-commit any staged value synchronously and cancel the rAF.
   *  Call this from pointerup so the final drag position reaches the
   *  patch store immediately on release, before any teardown. */
  flush(): void;
  /** Cancel any pending rAF without committing. Call from onDestroy.
   *  (Pending values are intentionally discarded — the surrounding
   *  component is going away anyway.) */
  dispose(): void;
}

/**
 * Build a rAF-coalesced commit pump bound to a real onchange callback.
 *
 * Optional `raf` / `cancel` parameters are an injection seam for tests —
 * jsdom doesn't run rAF, so unit tests pass synchronous stand-ins. The
 * defaults are resolved LAZILY (not via default-param assignment) so the
 * helper can be constructed in a jsdom test that never schedules a real
 * frame — referencing `requestAnimationFrame` at construction time
 * would throw `ReferenceError` there.
 */
export function createDragCommit(
  onchange: (value: number) => void,
  raf?: (cb: () => void) => number,
  cancel?: (id: number) => void,
): DragCommit {
  const scheduleFrame: (cb: () => void) => number =
    raf ?? ((cb) => requestAnimationFrame(cb));
  const cancelFrame: (id: number) => void =
    cancel ?? ((id) => cancelAnimationFrame(id));
  let pendingValue: number | null = null;
  let rafId: number | null = null;

  function fire(): void {
    rafId = null;
    if (pendingValue === null) return;
    const v = pendingValue;
    pendingValue = null;
    onchange(v);
  }

  return {
    commit(value: number): void {
      pendingValue = value;
      if (rafId !== null) return; // already scheduled
      rafId = scheduleFrame(fire);
    },
    flush(): void {
      if (rafId !== null) {
        cancelFrame(rafId);
        rafId = null;
      }
      if (pendingValue === null) return;
      const v = pendingValue;
      pendingValue = null;
      onchange(v);
    },
    dispose(): void {
      if (rafId !== null) {
        cancelFrame(rafId);
        rafId = null;
      }
      pendingValue = null;
    },
  };
}
