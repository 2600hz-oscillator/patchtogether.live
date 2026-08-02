// packages/web/src/lib/ui/modules/snaredrum-strike-actions.ts
//
// SNARE DRUM's AUDITION — and it is TWO auditions, because the module has TWO
// strike inputs with DIFFERENT declared semantics:
//
//   HIT  → `trigger_in`, edge:'trigger' — ONE hit per rising edge.
//   ROLL → `gate_in`,    edge:'gate'    — the two-hand roll runs WHILE high.
//
// That distinction is the repo's own (CLAUDE.md "Triggers vs gates"), the def
// declares it on the ports, and a face that collapsed both into one button
// would be the face disagreeing with its def about the one thing this voice
// exists for. So there are two families, two pads, two seams.
//
// Neither writes to the graph. No value moves, nothing persists into the Y.Doc,
// nothing reaches the undo stack, nothing is shared with the rackspace: each
// fires a host-side ConstantSource summed into the SAME worklet input a cable
// feeds (snaredrum.ts's factory), so a real patch cable on trigger_in/gate_in
// keeps working while you use them, and the audible result is identical to a
// sequencer driving the jack.
//
// SPLIT IN THREE, deliberately:
//   * `resolveManualStrike` / `resolveManualRoll` are PURE over their injected
//     engine + node, so the interesting half (when is the audition genuinely
//     unavailable?) is unit-testable with fakes;
//   * `snaredrum-roll-latch.ts` is the PURE held-gate state machine — see its
//     header for why a boolean was not enough;
//   * the `fire*` / `set*` functions below are the thin process-wide wiring the
//     shell cell and the legacy card both call, so there is ONE implementation.
//
// `getActiveEngine()` rather than the Svelte engine CONTEXT: shell-cells.ts
// specs are plain data invoked from ModuleShell, not components, so they cannot
// `getContext`. Reading the engine at the moment of the press is exactly right
// — that is when a non-null engine is required.

import { getActiveEngine } from '$lib/audio/engine-ref';
import { patch } from '$lib/graph/store';
import type { ModuleNode } from '$lib/graph/types';
import {
  closeRoll,
  emptyRollLatch,
  openRoll,
  panicRoll,
  type RollLatchState,
} from './snaredrum-roll-latch';

/** The `read(node, key)` half of a PatchEngine — all this seam needs. */
export interface StrikeEngineLike {
  read(node: ModuleNode, key: string): unknown;
}

/** The read key the factory answers with a ONE-SHOT trigger firing. */
export const SNAREDRUM_HIT_KEY = 'manualTrigger';
/** The read key the factory answers with a HELD-GATE setter. */
export const SNAREDRUM_ROLL_KEY = 'manualGate';

/**
 * Resolve the node's one-shot HIT function, or `null` when the audition is
 * genuinely unavailable. THREE branches, each a real state:
 *   * no engine (the AudioContext has not booted — nothing can sound yet);
 *   * no node (the module was removed between render and press);
 *   * the handle answers the read key with something that is not callable —
 *     a half-implemented seam (a number) or no `read` at all (`undefined`).
 *     Those last two are ONE branch, not two: both fall through the same
 *     `typeof fn === 'function'` guard.
 *
 * Returning null rather than throwing is deliberate: an audition that cannot
 * fire is a no-op, never an error dialog over a rack. PURE.
 */
export function resolveManualStrike(
  engine: StrikeEngineLike | null | undefined,
  node: ModuleNode | undefined,
): (() => void) | null {
  if (!engine || !node) return null;
  const fn = engine.read(node, SNAREDRUM_HIT_KEY);
  return typeof fn === 'function' ? (fn as () => void) : null;
}

/**
 * Resolve the node's HELD-GATE setter — `(high: boolean) => void` — or `null`
 * on the same three unavailable states as above. Separate key from the hit:
 * a handle that implements only the one-shot must NOT silently answer the roll,
 * because a roll that opens and never closes is the worst failure this module
 * has (snaredrum-roll-latch.ts). PURE.
 */
export function resolveManualRoll(
  engine: StrikeEngineLike | null | undefined,
  node: ModuleNode | undefined,
): ((high: boolean) => void) | null {
  if (!engine || !node) return null;
  const fn = engine.read(node, SNAREDRUM_ROLL_KEY);
  return typeof fn === 'function' ? (fn as (high: boolean) => void) : null;
}

/**
 * Fire ONE hit at the live node — the action both faces call (the shell's
 * `snaredrum-hit` cell and SnaredrumCard's HIT pad). Silently does nothing when
 * the audition is unavailable. Returns whether a hit actually fired, so a
 * caller can drive a press flash off the truth instead of off the click.
 */
export function fireSnaredrumHit(nodeId: string): boolean {
  const node = patch.nodes[nodeId] as ModuleNode | undefined;
  const strike = resolveManualStrike(getActiveEngine(), node);
  if (!strike) return false;
  strike();
  return true;
}

// ── The HELD ROLL, and its leak guard ───────────────────────────────────────
//
// Module-scope, process-wide, because the thing being tracked IS process-wide:
// a ConstantSource in the live audio graph. The pure reducer owns the
// bookkeeping; everything below is the impure edge (the engine call + the
// window listeners that catch a release the button never saw).

let rollLatch: RollLatchState = emptyRollLatch();
let panicInstalled = false;

/** Close ONE node's gate on the engine, ignoring an already-gone handle. */
function closeOnEngine(nodeId: string): void {
  const node = patch.nodes[nodeId] as ModuleNode | undefined;
  const setGate = resolveManualRoll(getActiveEngine(), node);
  try { setGate?.(false); } catch { /* the handle went away with the node */ }
}

/**
 * Close EVERY open audition roll — the panic path. Exported so a test (and a
 * future teardown) can invoke it directly rather than synthesizing DOM events.
 * Returns the node ids it closed.
 */
export function panicSnaredrumRolls(): string[] {
  const p = panicRoll(rollLatch);
  rollLatch = p.state;
  for (const id of p.closed) closeOnEngine(id);
  return p.closed;
}

/**
 * Install the window-level release listeners ONCE, lazily (never at import:
 * this module is imported by shell-cells.ts, which the unit lane loads in a
 * node environment with no `window`).
 *
 * WHY THESE FOUR. `<Button>` captures the pointer, so an ordinary release
 * always reaches it — but pointer capture protects a MOVING pointer, not a
 * DELETED element. Close the dock, delete the module, or hide the tab mid-hold
 * and the button unmounts with the gate still open and the roll never stops.
 * The node's own `dispose()` covers deletion; these cover the rest.
 */
function ensurePanicListeners(): void {
  if (panicInstalled) return;
  // ⚠ FEATURE-DETECT, don't existence-check. `typeof window === 'undefined'`
  // is NOT enough: the unit lane runs 630 files in one process and some of them
  // leave a PARTIAL `window` stub behind, so this threw `addEventListener is
  // not a function` in the full sweep while passing when the file ran alone.
  // A guard that is right only in isolation is not a guard.
  const w = typeof window === 'undefined' ? undefined : window;
  if (typeof w?.addEventListener !== 'function') return;
  panicInstalled = true;
  const panic = () => { panicSnaredrumRolls(); };
  w.addEventListener('pointerup', panic);
  w.addEventListener('pointercancel', panic);
  w.addEventListener('blur', panic);
  const d = typeof document === 'undefined' ? undefined : document;
  if (typeof d?.addEventListener === 'function') {
    d.addEventListener('visibilitychange', () => {
      if (d.visibilityState === 'hidden') panic();
    });
  }
}

/**
 * Open (high) or close (low) the node's ROLL audition gate — the action both
 * faces call (the shell's `snaredrum-roll` cell and SnaredrumCard's ROLL pad).
 * Returns whether an edge was actually sent to the engine: `false` means either
 * the audition is unavailable OR the latch already held that state, and in both
 * cases nothing was scheduled.
 */
export function setSnaredrumRoll(nodeId: string, high: boolean): boolean {
  const node = patch.nodes[nodeId] as ModuleNode | undefined;
  const setGate = resolveManualRoll(getActiveEngine(), node);
  if (!setGate) {
    // The audition cannot run — but if the latch thinks this node is rolling,
    // forget it, or a later panic would try to close a gate that never opened.
    if (!high) rollLatch = closeRoll(rollLatch, nodeId).state;
    return false;
  }
  if (high) {
    ensurePanicListeners();
    const r = openRoll(rollLatch, nodeId);
    rollLatch = r.state;
    if (!r.opened) return false;
    setGate(true);
    return true;
  }
  const r = closeRoll(rollLatch, nodeId);
  rollLatch = r.state;
  if (!r.closed) return false;
  setGate(false);
  return true;
}

/** TEST SEAM: forget all latch state (and the once-only listener install)
 *  without touching the engine. Never called from app code. */
export function __resetSnaredrumRollLatch(): void {
  rollLatch = emptyRollLatch();
  panicInstalled = false;
}
