// packages/web/src/lib/audio/arp-engine.ts
//
// PURE, dependency-light arpeggiator generator + state machine for the
// Launchpad KEYS view. Given a held-note set, params, and a monotonic clock
// that ticks it forward one "arp step" at a time, it emits the ordered
// sequence of MIDI notes to play (a note-on for the current step + the
// note-off for the previous step).
//
// WHY THIS FILE IS FRAMEWORK-FREE: the control layer (launchpad-*) wires the
// output into the existing `pushAudition(nodeId, {lane, midi, velocity, on})`
// poly seam — this engine produces ONLY the note sequence + timing decisions,
// so it imports no launchpad/clipplayer/engine code and is trivially unit
// testable. It carries no velocity (a control-layer concern) and no scheduler
// (the caller drives one `arpAdvance` per transport-projected arp tick).
//
// ---------------------------------------------------------------------------
// CONTRACT (see .myrobots/plans/launchpad-single-rework-2026-07-12.md
// "ARP ENGINE CONTRACT"):
//
//  • Direction: 'up' | 'down' | 'updown'. up-and-down is an EXCLUSIVE
//    pendulum — each extreme is played ONCE (held {C,E,G} → C E G E C E G E …,
//    never C E G G E C). 1- and 2-note sets fall out of the same code with no
//    stutter/duplication.
//  • Octave range: index into ARP_OCTAVE_RANGES [1, 2, 3] = "1 oct" /
//    "+1..-1" / "+2..-2". The pool is the held notes octave-expanded then
//    SORTED ASCENDING; the direction walks that pool.
//      SYMMETRY NOTE: the owner asked for SYMMETRIC ranges (±N octaves around
//      the played notes). The common HARDWARE norm is upward-only 1–4 octaves;
//      switching to that is a one-line change in `octaveOffsets()` (emit
//      0..(span-1) instead of -(span-1)..(span-1)).
//  • Division: index into ARP_DIVISIONS [8,4,2,1,0.5,0.25,0.125] = a
//    multiplier on the caller's base clock step. `arpStepPeriod` maps an index
//    → step period in the caller's own unit (beats/ticks/seconds — abstract;
//    the caller supplies the base period).
//      RESOLUTION NOTE: 8x can demand a period below the scheduler's tick
//      resolution. This generator is agnostic — it advances exactly one
//      arp-note per `arpAdvance` the caller drives; validating 8x against the
//      real tick grid is the caller's job.
//  • Latch/hold: while latch is ON the last non-empty held set survives after
//    all keys release (arp keeps running); a fresh press after a FULL release
//    REPLACES the set, a press while any key is still down ADDS (accumulate —
//    releasing individual keys does NOT shrink the set; only a full release
//    ends the hold session). With latch OFF, releasing all notes stops the arp.
//  • Cursor stability: adding/removing a note while running keeps the cursor
//    advancing sensibly — it is clamped into range on every pool change, never
//    reset to 0, and never indexes an empty pool.
//
// API SHAPE: an immutable `ArpState` plus pure transitions —
//   createArpState(params?)              → fresh state
//   arpSetHeld(state, physicalKeys[])    → apply a new physically-held set
//   arpSetParams(state, partialParams)   → change direction/division/range/latch
//   arpAdvance(state) → { noteOn?, noteOff?, state }   → drive one arp step
// Every function returns a NEW state; nothing is mutated in place.
// ---------------------------------------------------------------------------

/** Lowest / highest valid MIDI note. Octave expansion that would leave this
 *  range is dropped (not clamped — clamping would fold copies onto the edge). */
export const ARP_MIDI_MIN = 0;
export const ARP_MIDI_MAX = 127;

// ---------------- Division (rate) table ----------------

/** Step-rate multipliers, in display order (index = the stored param value).
 *  >1 is faster (shorter period), <1 slower. See ARP_DIVISION_LABELS. */
export const ARP_DIVISIONS = [8, 4, 2, 1, 0.5, 0.25, 0.125] as const;

/** Human labels aligned 1:1 with ARP_DIVISIONS. */
export const ARP_DIVISION_LABELS = ['8x', '4x', '2x', '1x', '1/2', '1/4', '1/8'] as const;

/** Default division index — '1x' (one arp note per base clock step). */
export const ARP_DIVISION_DEFAULT_INDEX = 3;

/** Clamp/round an arbitrary persisted value to a valid division index.
 *  Non-numeric (missing/corrupt) falls back to '1x'. */
export function coerceDivisionIndex(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return ARP_DIVISION_DEFAULT_INDEX;
  return Math.max(0, Math.min(ARP_DIVISIONS.length - 1, Math.round(v)));
}

/** The arp step period for a division index, from the caller's BASE step
 *  period (any unit — beats, ticks, seconds). 8x → base/8 (faster), 1/8 →
 *  base/0.125 = base*8 (slower). The unit is whatever the caller passes in;
 *  this file makes no assumption about wall-clock time. */
export function arpStepPeriod(basePeriod: number, divisionIndex: number): number {
  return basePeriod / ARP_DIVISIONS[coerceDivisionIndex(divisionIndex)];
}

// ---------------- Octave-range table ----------------

/** Octave-range SPAN per index: 1 = the held notes only, 2 = ±1 octave,
 *  3 = ±2 octaves. (Owner-directed SYMMETRIC ranges — see the SYMMETRY NOTE
 *  in the file header for the one-line switch to the upward-only hardware
 *  norm.) */
export const ARP_OCTAVE_RANGES = [1, 2, 3] as const;

/** Human labels aligned 1:1 with ARP_OCTAVE_RANGES. */
export const ARP_OCTAVE_RANGE_LABELS = ['1 oct', '+1..-1', '+2..-2'] as const;

/** Default octave-range index — '1 oct' (play the held notes as-is). */
export const ARP_OCTAVE_RANGE_DEFAULT_INDEX = 0;

/** Clamp/round an arbitrary persisted value to a valid octave-range index. */
export function coerceOctaveRangeIndex(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return ARP_OCTAVE_RANGE_DEFAULT_INDEX;
  return Math.max(0, Math.min(ARP_OCTAVE_RANGES.length - 1, Math.round(v)));
}

/** The octave offsets (in whole octaves) emitted for a range index. SYMMETRIC:
 *  span 1 → [0], span 2 → [-1,0,1], span 3 → [-2,-1,0,1,2]. For the hardware
 *  upward-only norm, change the loop bound to `0..reach`. */
function octaveOffsets(octaveRangeIndex: number): number[] {
  const reach = ARP_OCTAVE_RANGES[coerceOctaveRangeIndex(octaveRangeIndex)] - 1; // 0,1,2
  const out: number[] = [];
  for (let o = -reach; o <= reach; o++) out.push(o);
  return out;
}

/**
 * Expand a held-note set into the sorted MIDI pool the direction walks:
 * octave-copy each note by the range's offsets, drop anything outside the MIDI
 * range, dedupe, and SORT ASCENDING. Pure — safe to call standalone.
 */
export function expandPool(held: readonly number[], octaveRangeIndex: number): number[] {
  const offsets = octaveOffsets(octaveRangeIndex);
  const out = new Set<number>();
  for (const n of held) {
    for (const o of offsets) {
      const m = n + 12 * o;
      if (m >= ARP_MIDI_MIN && m <= ARP_MIDI_MAX) out.add(m);
    }
  }
  return [...out].sort((a, b) => a - b);
}

// ---------------- State model ----------------

export type ArpDirection = 'up' | 'down' | 'updown';

export interface ArpParams {
  direction: ArpDirection;
  /** Index into ARP_DIVISIONS. */
  divisionIndex: number;
  /** Index into ARP_OCTAVE_RANGES. */
  octaveRangeIndex: number;
  /** Hold the last non-empty set after full release (see latch semantics). */
  latch: boolean;
}

export interface ArpState {
  params: ArpParams;
  /** Currently physically-held keys (sorted, deduped) — tracked separately from
   *  `held` so a full-release → next-press transition can be detected (latch). */
  physical: number[];
  /** The EFFECTIVE note set the arp walks (post-latch), pre octave-expansion. */
  held: number[];
  /** `held` octave-expanded + sorted ascending. The direction walks this. */
  pool: number[];
  /** Index into `pool` of the note the NEXT `arpAdvance` will play. */
  cursor: number;
  /** Pendulum travel direction for 'updown' (+1 rising, -1 falling). */
  dir: 1 | -1;
  /** MIDI note currently sounding (for the note-off on the next step), or null. */
  playing: number | null;
}

/** The result of one `arpAdvance`: the caller sends `noteOff` (previous note),
 *  THEN `noteOn` (this step's note) through `pushAudition`. Either may be
 *  absent (start of run → no noteOff; empty pool → no noteOn). */
export interface ArpStep {
  noteOn?: number;
  noteOff?: number;
  state: ArpState;
}

export const DEFAULT_ARP_PARAMS: ArpParams = {
  direction: 'up',
  divisionIndex: ARP_DIVISION_DEFAULT_INDEX,
  octaveRangeIndex: ARP_OCTAVE_RANGE_DEFAULT_INDEX,
  latch: false,
};

/** Fresh, silent arp state. Partial `params` override the defaults (coerced). */
export function createArpState(params: Partial<ArpParams> = {}): ArpState {
  return {
    params: {
      direction: params.direction ?? DEFAULT_ARP_PARAMS.direction,
      divisionIndex: coerceDivisionIndex(params.divisionIndex ?? DEFAULT_ARP_PARAMS.divisionIndex),
      octaveRangeIndex: coerceOctaveRangeIndex(
        params.octaveRangeIndex ?? DEFAULT_ARP_PARAMS.octaveRangeIndex,
      ),
      latch: params.latch ?? DEFAULT_ARP_PARAMS.latch,
    },
    physical: [],
    held: [],
    pool: [],
    cursor: 0,
    dir: 1,
    playing: null,
  };
}

// ---------------- Note-set helpers ----------------

/** Round to int, drop non-finite + out-of-range, dedupe, sort ascending. */
function normalize(notes: readonly number[]): number[] {
  const out = new Set<number>();
  for (const n of notes) {
    if (typeof n !== 'number' || !Number.isFinite(n)) continue;
    const m = Math.round(n);
    if (m >= ARP_MIDI_MIN && m <= ARP_MIDI_MAX) out.add(m);
  }
  return [...out].sort((a, b) => a - b);
}

/** Sorted union of two note sets. */
function union(a: readonly number[], b: readonly number[]): number[] {
  return normalize([...a, ...b]);
}

// ---------------- Cursor math ----------------

/** Seed the cursor at the direction's FIRST step when a run (re)starts from
 *  silence: up/updown begin at the bottom rising, down begins at the top
 *  falling. (Only used on empty→non-empty; a live add/remove keeps the cursor.) */
function seedCursor(n: number, direction: ArpDirection): { cursor: number; dir: 1 | -1 } {
  if (direction === 'down') return { cursor: n - 1, dir: -1 };
  return { cursor: 0, dir: 1 };
}

/** Advance the cursor one step for the given direction. 'updown' is the
 *  EXCLUSIVE pendulum: it turns around BEFORE repeating an extreme, so a 3-note
 *  pool reads 0,1,2,1,0,1,2,1,… (C E G E …) and a 2-note pool reads 0,1,0,1,…
 *  A single-note pool holds at 0 (retrigger, no crash). */
function stepCursor(
  n: number,
  cursor: number,
  dir: 1 | -1,
  direction: ArpDirection,
): { cursor: number; dir: 1 | -1 } {
  if (n <= 1) return { cursor: 0, dir };
  if (direction === 'up') return { cursor: (cursor + 1) % n, dir: 1 };
  if (direction === 'down') return { cursor: (cursor - 1 + n) % n, dir: -1 };
  // 'updown' pendulum — bounce one short of each extreme so it plays once.
  let d = dir;
  let next = cursor + d;
  if (next >= n) { d = -1; next = n - 2; }
  else if (next < 0) { d = 1; next = 1; }
  return { cursor: next, dir: d };
}

/**
 * Recompute `pool` from a new `held` set + the current octave range, and place
 * the cursor: SEED at the direction's first step when the pool (re)starts from
 * empty, otherwise CLAMP the existing cursor into range (stable across
 * add/remove; never reset to 0, never out of bounds).
 */
function rebuild(prev: ArpState, held: number[], physical: number[]): ArpState {
  const pool = expandPool(held, prev.params.octaveRangeIndex);
  let cursor = prev.cursor;
  let dir = prev.dir;
  if (pool.length === 0) {
    cursor = 0;
  } else if (prev.pool.length === 0) {
    const seeded = seedCursor(pool.length, prev.params.direction);
    cursor = seeded.cursor;
    dir = seeded.dir;
  } else {
    cursor = Math.max(0, Math.min(pool.length - 1, prev.cursor));
  }
  return { ...prev, physical, held, pool, cursor, dir };
}

// ---------------- Public transitions ----------------

/**
 * Apply a new PHYSICALLY-held key set (e.g. the live `keysPressed`). Resolves
 * the effective `held` set through the latch rules, then rebuilds the pool:
 *  • latch OFF → `held` mirrors the physical set (release all ⇒ stop).
 *  • latch ON, all keys up → `held` FROZEN (arp keeps running).
 *  • latch ON, fresh press after a full release → REPLACE.
 *  • latch ON, press while any key still down → ADD (accumulate; releasing
 *    individual keys does not shrink `held`).
 */
export function arpSetHeld(state: ArpState, physicalKeys: readonly number[]): ArpState {
  const physical = normalize(physicalKeys);
  const wasAllReleased = state.physical.length === 0;

  let held: number[];
  if (!state.params.latch) {
    held = physical;
  } else if (physical.length === 0) {
    held = state.held; // freeze the sustained set
  } else if (wasAllReleased) {
    held = physical; // fresh press → replace
  } else {
    held = union(state.held, physical); // hold + press → add
  }
  return rebuild(state, held, physical);
}

/**
 * Change one or more params. A division change is cursor-transparent; an
 * octave-range change re-expands the pool and clamps the cursor. Turning latch
 * OFF collapses a frozen set back to the physically-held keys (so an
 * all-released latched arp stops the moment latch is disabled).
 */
export function arpSetParams(state: ArpState, partial: Partial<ArpParams>): ArpState {
  const params: ArpParams = {
    direction: partial.direction ?? state.params.direction,
    divisionIndex: partial.divisionIndex !== undefined
      ? coerceDivisionIndex(partial.divisionIndex)
      : state.params.divisionIndex,
    octaveRangeIndex: partial.octaveRangeIndex !== undefined
      ? coerceOctaveRangeIndex(partial.octaveRangeIndex)
      : state.params.octaveRangeIndex,
    latch: partial.latch ?? state.params.latch,
  };
  // A frozen (sustained) set only survives while latch is on; when latch turns
  // off the effective set drops back to whatever is physically held.
  const held = state.params.latch && !params.latch ? state.physical : state.held;
  return rebuild({ ...state, params }, held, state.physical);
}

/**
 * Drive ONE arp step. Reads the note at the cursor, emits its note-on plus the
 * previous note's note-off, then advances the cursor for the next call. On an
 * empty pool it emits only the pending note-off (if any) and stays silent.
 *
 * The caller should apply `noteOff` BEFORE `noteOn` (they can be the same MIDI
 * value — a 1-note pool retriggers the same note each step, which is correct).
 */
export function arpAdvance(state: ArpState): ArpStep {
  const off = state.playing;

  if (state.pool.length === 0) {
    if (off === null) return { state };
    return { noteOff: off, state: { ...state, playing: null } };
  }

  const note = state.pool[state.cursor];
  const advanced = stepCursor(state.pool.length, state.cursor, state.dir, state.params.direction);
  const next: ArpState = { ...state, cursor: advanced.cursor, dir: advanced.dir, playing: note };

  const step: ArpStep = { noteOn: note, state: next };
  if (off !== null) step.noteOff = off;
  return step;
}
