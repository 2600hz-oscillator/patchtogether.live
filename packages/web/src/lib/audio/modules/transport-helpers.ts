// packages/web/src/lib/audio/modules/transport-helpers.ts
//
// Shared transport + quicksave logic used by Sequencer / DRUMSEQZ / SCORE.
//
// Spec: .myrobots/plans/sequencer-transport-and-quicksave.md
//
// Three concerns live here:
//
// 1. **Slot data shape** — every sequencer-style module persists 4 quicksave
//    slots in `node.data.slots` ({ '1': snapshot|null, '2': ..., '3': ...,
//    '4': ... }). The snapshot type is module-specific; this file only
//    defines the slot envelope + coercion + defaults.
//
// 2. **Pending-mode state machine** — the SAVE / LOAD / QUEUE buttons arm
//    the next 1-4 click. State lives on `node.data.pendingMode` (sync'd
//    over Y.Doc so collaborators see the armed action), and is consumed
//    on the slot button press.
//
// 3. **Rising-edge detector** — the play_cv / reset_cv / queue{1..4}_cv
//    inputs all share the same Float32Array → rising-edge scan that the
//    existing clock_cv input uses. We extract it here so each module's
//    factory doesn't re-implement it 6 times.
//
// All helpers are pure (no AudioContext, no Y.Doc) so vitest runs in a
// node env without additional plumbing.

// feat/seq 8-slots: the slot envelope widened from 4 → 8. This is
// backward-compatible — old 4-slot saves coerce with keys 5..8 defaulting
// to null (coerceSlots iterates SLOT_KEYS), and modules that only render 4
// slots are unaffected (QuicksaveControls renders SLOT_KEYS, so they all
// pick up the extra buttons; no spec pins an exactly-4 count). Sequencer +
// MACSEQ are the modules that actively USE all 8 + the NEXT/PREV/RANDOM nav.
export type SlotKey = '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8';
export const SLOT_KEYS: readonly SlotKey[] = ['1', '2', '3', '4', '5', '6', '7', '8'] as const;

/** A snapshot is whatever shape the module wants to persist into a slot.
 *  We don't care about the inner shape here — just that it's serializable. */
export type Snapshot = Record<string, unknown>;

export type SlotMap = Record<SlotKey, Snapshot | null>;

/** Pending button-mode (transient): null when idle. */
export type PendingMode = 'save' | 'load' | 'queue' | null;

/** Default slots for a fresh module — all null. */
export function defaultSlots(): SlotMap {
  return { '1': null, '2': null, '3': null, '4': null, '5': null, '6': null, '7': null, '8': null };
}

/** Coerce arbitrary input back into a SlotMap. Used both for migration
 *  (old patches without `slots`) and for runtime reads (collaborator
 *  edits arrive over the wire as `unknown`). Slots that aren't an object
 *  (or are arrays / primitives) become null. */
export function coerceSlots(raw: unknown): SlotMap {
  const out = defaultSlots();
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  for (const k of SLOT_KEYS) {
    const v = r[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = v as Snapshot;
    } else {
      out[k] = null;
    }
  }
  return out;
}

/** Coerce an arbitrary value into a PendingMode (or null). */
export function coercePendingMode(raw: unknown): PendingMode {
  if (raw === 'save' || raw === 'load' || raw === 'queue') return raw;
  return null;
}

/** Coerce an arbitrary value into a SlotKey (or null). Accepts numbers. */
export function coerceSlotKey(raw: unknown): SlotKey | null {
  if (typeof raw === 'string' && SLOT_KEYS.includes(raw as SlotKey)) return raw as SlotKey;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= SLOT_KEYS.length) {
    return String(raw) as SlotKey;
  }
  return null;
}

// ---------------- Occupied-slot navigation (NEXT / PREV / RANDOM) ----------------
//
// feat/seq quantized nav: the NEXT / PREV / RANDOM gate inputs jump the
// playing pattern to another OCCUPIED slot at the next pattern end. A slot
// is "occupied" iff it holds a saved snapshot. These helpers are pure (no
// AudioContext, no Y.Doc) so the engine's sequence-end path + the unit
// tests share one implementation.

export type NavDirection = 'next' | 'prev' | 'random';

/** Compute the ordered list of occupied slot keys from a SlotMap (a slot is
 *  occupied iff its snapshot is non-null). Order follows SLOT_KEYS. */
export function occupiedSlots(slots: SlotMap): SlotKey[] {
  return SLOT_KEYS.filter((k) => slots[k] !== null);
}

/**
 * Resolve the slot a NEXT / PREV / RANDOM nav lands on, given the set of
 * occupied slots and the currently-playing slot.
 *
 * Contract (occupied-slot-aware):
 *   - NO occupied slots                  → null (no-op).
 *   - exactly ONE occupied slot          → always that slot (any direction).
 *   - NEXT                               → the next occupied slot after
 *                                          `current` in occupied order, WRAPPING
 *                                          last → first.
 *   - PREV                               → the prior occupied slot before
 *                                          `current`, WRAPPING first → last.
 *   - RANDOM                             → a (caller-supplied RNG) pick among
 *                                          the occupied slots. Always within
 *                                          the occupied set.
 *
 * `current` may be null (nothing loaded yet) or a slot that is no longer
 * occupied (its snapshot was cleared). In those cases NEXT starts from the
 * first occupied slot and PREV from the last — the wrap math degrades
 * gracefully so a nav still lands somewhere occupied.
 *
 * `rng` defaults to Math.random; tests inject a deterministic generator.
 */
export function resolveNavTarget(
  occupied: readonly SlotKey[],
  current: SlotKey | null,
  dir: NavDirection,
  rng: () => number = Math.random,
): SlotKey | null {
  if (occupied.length === 0) return null;
  if (occupied.length === 1) return occupied[0]!;

  if (dir === 'random') {
    const i = Math.min(occupied.length - 1, Math.max(0, Math.floor(rng() * occupied.length)));
    return occupied[i]!;
  }

  // NEXT / PREV are circular over the occupied list. Find where `current`
  // sits in that list; if it's not present (null or no longer occupied),
  // anchor so NEXT yields the first occupied slot + PREV yields the last.
  const curIdx = current === null ? -1 : occupied.indexOf(current);
  const n = occupied.length;
  if (dir === 'next') {
    // curIdx===-1 → (−1+1)%n = 0 → first occupied slot.
    return occupied[(curIdx + 1 + n) % n]!;
  }
  // prev. curIdx===-1 → (−1−1+n)%n = n−2; bump the anchor to n so it lands on
  // the LAST occupied slot when nothing is loaded.
  const anchor = curIdx === -1 ? n : curIdx;
  return occupied[(anchor - 1 + n) % n]!;
}

// ---------------- Rising-edge detector ----------------

/**
 * Returned by `createRisingEdgeDetector`: hold cross-tick state (the last
 * sample we observed) and a `scan(buffer, fromIdx)` method that returns
 * how many rising edges crossed the threshold inside [fromIdx, end).
 *
 * fromIdx exists because each module's tick observes the analyser's full
 * 2048-sample ring buffer but only the last `elapsed * sampleRate` samples
 * are "new" since the previous tick — scanning from anywhere else
 * double-counts.
 */
export interface RisingEdgeDetector {
  /** Reset cross-tick state (e.g. after PLAY transitions). */
  reset(): void;
  /** Scan a window of samples. Returns how many rising edges crossed
   *  the threshold. Updates internal state to remember the last sample
   *  so the next call's first comparison uses it. */
  scan(samples: ArrayLike<number>, fromIdx: number, endIdx: number): number;
}

export function createRisingEdgeDetector(threshold = 0.5): RisingEdgeDetector {
  let last = 0;
  return {
    reset() {
      last = 0;
    },
    scan(samples, fromIdx, endIdx) {
      let count = 0;
      const start = Math.max(0, fromIdx);
      const end = Math.min(samples.length, endIdx);
      for (let i = start; i < end; i++) {
        const cur = samples[i] ?? 0;
        if (last < threshold && cur >= threshold) {
          count++;
        }
        last = cur;
      }
      return count;
    },

  };
}

/** Pure rising-edge predicate for unit tests / one-off comparisons. */
export function isRisingEdge(prev: number, cur: number, threshold = 0.5): boolean {
  return prev < threshold && cur >= threshold;
}

// ---------------- Pending-mode state transitions ----------------

/** Result of a click on a slot 1-4 button.
 *  - 'save'  → write current snapshot into slot N, clear pendingMode
 *  - 'load'  → apply slot N's snapshot immediately (no step reset),
 *              clear pendingMode + queuedSlot
 *  - 'queue' → set queuedSlot = N, clear pendingMode
 *  - 'noop'  → no pendingMode armed; click is ignored
 */
export type SlotClickAction =
  | { kind: 'save'; slot: SlotKey }
  | { kind: 'load'; slot: SlotKey }
  | { kind: 'queue'; slot: SlotKey }
  | { kind: 'noop' };

export function resolveSlotClick(pending: PendingMode, slot: SlotKey): SlotClickAction {
  if (pending === 'save') return { kind: 'save', slot };
  if (pending === 'load') return { kind: 'load', slot };
  if (pending === 'queue') return { kind: 'queue', slot };
  return { kind: 'noop' };
}

// ---------------- Port-connected query ----------------

/**
 * Minimal edge shape we read for connectivity checks. We accept anything that
 * has a `target.{nodeId, portId}` so callers can pass either the live patch
 * edge map (Object.values(livePatch.edges)) or a hand-built array in tests.
 */
export interface EdgeLike {
  target: { nodeId: string; portId: string };
}

/**
 * Returns true iff some edge in `edges` terminates at (nodeId, portId).
 * Used by sequencers to detect "is the clock input patched?" / "is the
 * play_cv input patched?" — both of which gate the transport state.
 *
 * Pure (no AudioContext, no Y.Doc reads) so vitest can exercise it without
 * spinning up the engine. Callers pass `Object.values(livePatch.edges)`.
 */
export function isInputPortConnected(
  edges: ReadonlyArray<EdgeLike | undefined | null>,
  nodeId: string,
  portId: string,
): boolean {
  for (const edge of edges) {
    if (!edge) continue;
    if (edge.target.nodeId === nodeId && edge.target.portId === portId) {
      return true;
    }
  }
  return false;
}

// ---------------- Sequencer transport predicate ----------------

/**
 * The shared "should this sequencer be advancing right now?" predicate.
 * Encodes the desired truth table for the transport state machine:
 *
 *   | playing | clockConnected | playCvConnected | shouldRun |
 *   |---------|----------------|-----------------|-----------|
 *   | true    | *              | *               | true      |  ← Play button OR play_cv high
 *   | false   | true           | false           | true      |  ← clock-only mode: clock pulses ARE the play signal
 *   | false   | true           | true            | false     |  ← play_cv patched + low → respect play_cv
 *   | false   | false          | *               | false     |  ← stopped
 *
 * The clock-only case is the bug PR-82 introduced: previously, gating the
 * sequencer's tick on `playing` alone meant a patched-but-unplayed clock
 * couldn't drive the sequencer. play_cv and clock are now orthogonal: when
 * play_cv is unpatched, the clock's mere presence means "run".
 *
 * Pure (no AudioContext) — exercised by transport-helpers.test.ts.
 */
export function shouldSequencerRun(
  playing: boolean,
  clockConnected: boolean,
  playCvConnected: boolean,
): boolean {
  if (playing) return true;
  return clockConnected && !playCvConnected;
}
