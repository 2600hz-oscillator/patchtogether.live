// packages/web/src/lib/doom/cheat-sequence.ts
//
// DOOM cheat-code injection helpers used by the IDDQD / IDKFA gate inputs on
// the DOOM module. The contract is intentionally tiny + pure so it's
// unit-testable without the WASM shim:
//
//   - `cheatCodeSequence(name)` returns the lowercase ASCII characters DOOM's
//     m_cheat.c sequence checker wants to see in `event_t.data2` (the engine's
//     i_input.c writes the typed character there for an `ev_keydown`). The
//     sequences match the originals: 'iddqd' = god mode, 'idkfa' = all
//     keys/weapons/full ammo. We deliberately ship just these two — adding
//     more later is one line on the table.
//
//   - `makeRisingEdgeState()` / `detectRisingEdge(state, value)` is a pure
//     boolean rising-edge detector. We deliberately do NOT reuse `cv-gate-edge`
//     here: that detector tracks `pressed: boolean` with hysteresis (a 0.4..0.6
//     dead band) and emits BOTH key-down AND key-up events. For the cheat
//     injection we only want a one-shot trigger on the LOW→HIGH transition;
//     holding the gate high must never re-trigger and lowering does nothing.
//     The same single-threshold + sticky-flag pattern shows up in the engine's
//     event-gate edge detectors (evt_kill / evt_door consumers); centralising
//     it here keeps both the detector AND the cheat list in one auditable
//     place.
//
// The actual WASM-side injection lives in the DOOM video module factory
// (packages/web/src/lib/video/modules/doom.ts) — it consumes this module's
// outputs + drives `runtime.setKey` on a small JS timer.

/** The two cheat codes wired to gate inputs on the DOOM module. Extend this
 *  union — and `CHEAT_CHARS` below — to add more. */
export type DoomCheatName = 'iddqd' | 'idkfa';

/** Lowercase ASCII char arrays for each cheat. The engine's i_input.c writes
 *  the lowercase byte into `event_t.data2`, and `cht_CheckCheat` compares
 *  against the sequence stored as a lowercase string in st_stuff.c. Matching
 *  this exactly (no caps, no shifts) means the cheat parser accepts the
 *  stream without any case translation. */
const CHEAT_CHARS: Readonly<Record<DoomCheatName, readonly string[]>> = {
  iddqd: ['i', 'd', 'd', 'q', 'd'],
  idkfa: ['i', 'd', 'k', 'f', 'a'],
};

/** Returns the 5-character lowercase ASCII sequence for a cheat name. The
 *  returned array is FROZEN — callers that need mutability should copy it. */
export function cheatCodeSequence(name: DoomCheatName): readonly string[] {
  return CHEAT_CHARS[name];
}

/** Single-threshold rising-edge state. Tiny on purpose — one boolean. */
export interface RisingEdgeState {
  high: boolean;
}

/** Threshold above which the gate is considered HIGH. DOOM's CV/gate ports
 *  receive ConstantSourceNode-style 0/1 pulses + LFO-style 0..1 ramps; 0.5 is
 *  the same midpoint other gate-style consumers use (clock-edge.ts, the
 *  evt_kill subscribers). Single threshold, NOT the hysteresis pair used in
 *  cv-gate-edge.ts: a cheat code is a one-shot; we don't need anti-chatter on
 *  the falling edge because we never act on the fall. */
export const RISING_EDGE_THRESHOLD = 0.5;

/** Build a fresh edge state. The contract is `{ high: false }` — both
 *  documentation and to play well with `new Map(ports.map(...))`. */
export function makeRisingEdgeState(): RisingEdgeState {
  return { high: false };
}

/**
 * Update `state` with a new sample. Returns true iff this sample is the
 * LOW→HIGH transition (i.e. the rising edge). Holding `value >= threshold`
 * after a true result does NOT re-fire; the gate must first cross back
 * below the threshold to re-arm.
 *
 * Pure aside from the in-place mutation on `state`; identical inputs always
 * produce the same output.
 */
export function detectRisingEdge(
  state: RisingEdgeState,
  value: number,
  threshold: number = RISING_EDGE_THRESHOLD,
): boolean {
  if (!state.high && value >= threshold) {
    state.high = true;
    return true;
  }
  if (state.high && value < threshold) {
    state.high = false;
  }
  return false;
}

// ---- Injection timing (shipped constants) ----
//
// DOOM polls the JS-driven key queue once per tic via `DG_GetKey` (see
// `i_input.c::I_GetEvent`); a tic is ~28.5 ms (35 Hz). A 50 ms inter-character
// delay leaves enough headroom for one full tic + the WASM-side
// `cht_CheckCheat` advance between consecutive characters. The 10 ms key-down
// hold matches the polyseqz/score event-gate pulse width — long enough for the
// I_GetEvent drain to see both the ev_keydown and the subsequent ev_keyup as
// distinct events without losing either to a single-tic drain.

/** Milliseconds between the START of consecutive character key-downs. 50 ms ≈
 *  1.75 DOOM tics, so each character lands in its own tic with a comfortable
 *  margin. Tunable here only — there's no card-facing knob (cheats are pulse
 *  triggers, not user-shaped CV). */
export const CHEAT_CHAR_INTERVAL_MS = 50;

/** Milliseconds the key is held DOWN before the key-up is scheduled. 10 ms is
 *  short enough that the next character can land 50 ms later (gap = 40 ms)
 *  and long enough that the I_GetEvent drain sees the down-edge in one tic
 *  and the up-edge in a later tic. */
export const CHEAT_KEY_DOWN_MS = 10;
