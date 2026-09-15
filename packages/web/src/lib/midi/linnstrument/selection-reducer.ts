// SELECTION REDUCER — R/G/B selection, the single XY pointer and the three
// retained joystick pairs. ONE reducer for hardware edges, the DOM pads and
// patch hydration, so displayed selection, CV and LEDs cannot disagree
// (records/ui-specification.md:18).
//
// Authority, per intent:
//   selector_edge / set_selector  D04 OWNER RULING — three independent bits,
//                                 all eight masks legal, never a radio group.
//   pointer                       D05 RECOMMENDATION — first eligible fresh
//                                 contact owns every selected pair; a second
//                                 contact is ignored (`profile.pointerPolicy`).
//   join on selection             D07 RECOMMENDATION — `profile.selectionJoin`
//                                 picks `next_coherent_xy_sample` (the pair
//                                 jumps to the next sample) or `soft_takeover`
//                                 (the pair waits until the pointer picks it
//                                 up within `softTakeoverRadius`). Both are
//                                 implemented; the switch decides.
//   release                       D06 RECOMMENDATION — every pair HOLDS.
//   center                        selected pairs → (0,0); the finger is not moved.
//   panic                         an EFFECT only — gates close in the runtime,
//                                 XY is retained (ui-specification.md:20).
//   extra_control                 D17 RECOMMENDATION — inert unless
//                                 `profile.extraControlsEnabled`.
//
// PURE, immutable: a new state object on every accepted change, the SAME
// object when nothing changed (so `$derived` equality holds). ⚠ Plain `.ts`.

import { SELECTORS, type ControlIntent, type ReduceResult, type RuntimeEvent, type SelectionState, type SelectorId, type LinnProfile, type XyPair } from './types';

const pair = (x: number, y: number): XyPair => ({ x, y });
const clamp = (n: number): number => Math.min(1, Math.max(-1, n));
const isFinitePair = (x: number, y: number): boolean => Number.isFinite(x) && Number.isFinite(y);

export function createSelectionState(profile: LinnProfile, epoch = 1): SelectionState {
  return {
    mask: { ...profile.defaultMask },
    pairs: { r: pair(0, 0), g: pair(0, 0), b: pair(0, 0) },
    held: { r: false, g: false, b: false },
    armed: { r: false, g: false, b: false },
    pointer: { touch: null, u: 0.5, v: 0.5 },
    epoch,
    revision: 0,
  };
}

/** The durable subset: mask + pairs. Held touches, the pointer and arming are
 *  transient and never persisted (design.md:264). */
export function persistedSelection(state: SelectionState): { mask: Record<SelectorId, boolean>; pairs: Record<SelectorId, XyPair> } {
  return { mask: { ...state.mask }, pairs: { r: { ...state.pairs.r }, g: { ...state.pairs.g }, b: { ...state.pairs.b } } };
}

/** Bipolar joystick CV from a unipolar pointer sample (design.md:121). */
export const pointerToPair = (u: number, v: number): XyPair => pair(clamp(2 * u - 1), clamp(2 * v - 1));

function bump(state: SelectionState, patch: Partial<SelectionState>): SelectionState {
  return { ...state, ...patch, revision: state.revision + 1 };
}

/** Apply one coherent pointer sample to every selected pair, honouring the
 *  join policy for pairs that are armed for pickup. */
function applySample(state: SelectionState, profile: LinnProfile, u: number, v: number): SelectionState {
  const target = pointerToPair(u, v);
  const pairs = { ...state.pairs };
  const armed = { ...state.armed };
  let changed = false;
  for (const id of SELECTORS) {
    if (!state.mask[id]) continue;
    if (profile.selectionJoin === 'soft_takeover' && armed[id]) {
      const d = Math.hypot(target.x - pairs[id].x, target.y - pairs[id].y);
      if (d > profile.softTakeoverRadius) continue; // not picked up yet: hold
      armed[id] = false;
    }
    if (pairs[id].x !== target.x || pairs[id].y !== target.y) {
      pairs[id] = target;
      changed = true;
    }
  }
  const armedChanged = SELECTORS.some((id) => armed[id] !== state.armed[id]);
  if (!changed && !armedChanged) return state;
  return { ...state, pairs, armed };
}

function setSelector(state: SelectionState, profile: LinnProfile, id: SelectorId, on: boolean): SelectionState {
  if (state.mask[id] === on) return state;
  const mask = { ...state.mask, [id]: on };
  // Joining: under soft_takeover a newly selected pair waits for pickup while
  // a pointer is live; under next_coherent_xy_sample it follows the next
  // sample automatically because every selected pair is written per sample.
  const armed = { ...state.armed, [id]: on && profile.selectionJoin === 'soft_takeover' && state.pointer.touch !== null };
  return bump(state, { mask, armed });
}

/**
 * Reduce one intent. Returns `{ state, effects }`; `state` is the input
 * object when the intent changed nothing.
 */
export function reduceControls(state: SelectionState, intent: ControlIntent, profile: LinnProfile): ReduceResult {
  const none: ReduceResult = { state, effects: [] };
  // Epoch gate: a hardware intent from an older session is rejected (V14).
  if ('epoch' in intent && intent.epoch !== undefined && intent.kind !== 'session' && intent.epoch !== state.epoch) return none;

  switch (intent.kind) {
    case 'session': {
      if (intent.epoch === state.epoch) return none;
      // A new session drops the pointer and held cells; pairs and mask hold.
      return { state: bump(state, { epoch: intent.epoch, held: { r: false, g: false, b: false }, armed: { r: false, g: false, b: false }, pointer: { ...state.pointer, touch: null } }), effects: [] };
    }
    case 'selector_edge': {
      const id = intent.selector;
      if (intent.down) {
        if (state.held[id]) return none; // repeated down on a held cell: no flip (V03)
        const next = setSelector({ ...state, held: { ...state.held, [id]: true } }, profile, id, !state.mask[id]);
        return { state: next === state ? state : { ...next, revision: state.revision + 1 }, effects: [] };
      }
      if (!state.held[id]) return none;
      return { state: bump(state, { held: { ...state.held, [id]: false } }), effects: [] };
    }
    case 'set_selector':
      return { state: setSelector(state, profile, intent.selector, intent.on), effects: [] };
    case 'pointer': {
      if (!isFinitePair(intent.u, intent.v)) return none;
      const u = Math.min(1, Math.max(0, intent.u));
      const v = Math.min(1, Math.max(0, intent.v));
      const owner = state.pointer.touch;
      if (intent.phase === 'down') {
        // first_eligible_fresh_contact: an owner already exists → ignore (V08).
        if (owner !== null) return none;
        const owned = { ...state, pointer: { touch: intent.touch, u, v } };
        return { state: bump(applySample(owned, profile, u, v), {}), effects: [] };
      }
      if (owner !== intent.touch) return none;
      if (intent.phase === 'move') {
        const moved = { ...state, pointer: { touch: owner, u, v } };
        return { state: bump(applySample(moved, profile, u, v), {}), effects: [] };
      }
      // up: every pair HOLDS; the pointer is free for the next fresh contact.
      return { state: bump(state, { pointer: { touch: null, u: state.pointer.u, v: state.pointer.v }, armed: { r: false, g: false, b: false } }), effects: [] };
    }
    case 'set_pair': {
      if (!isFinitePair(intent.x, intent.y)) return none;
      const target = pair(clamp(intent.x), clamp(intent.y));
      const cur = state.pairs[intent.selector];
      if (cur.x === target.x && cur.y === target.y) return none;
      return { state: bump(state, { pairs: { ...state.pairs, [intent.selector]: target } }), effects: [] };
    }
    case 'center': {
      const pairs = { ...state.pairs };
      let changed = false;
      for (const id of SELECTORS) {
        if (!state.mask[id]) continue;
        if (pairs[id].x !== 0 || pairs[id].y !== 0) {
          pairs[id] = pair(0, 0);
          changed = true;
        }
      }
      return changed ? { state: bump(state, { pairs }), effects: [] } : none;
    }
    case 'panic':
      // Gates only — XY retained, selection retained, pointer retained.
      return { state, effects: [{ kind: 'panic' }] };
    case 'extra_control': {
      if (!profile.extraControlsEnabled || !intent.down) return none;
      return { state, effects: [{ kind: 'extra_control', control: intent.control }] };
    }
    case 'hydrate': {
      const mask = { ...state.mask };
      const pairs = { ...state.pairs };
      let changed = false;
      for (const id of SELECTORS) {
        const m = intent.mask?.[id];
        if (typeof m === 'boolean' && mask[id] !== m) {
          mask[id] = m;
          changed = true;
        }
        const p = intent.pairs?.[id];
        if (p && isFinitePair(p.x, p.y)) {
          const t = pair(clamp(p.x), clamp(p.y));
          if (pairs[id].x !== t.x || pairs[id].y !== t.y) {
            pairs[id] = t;
            changed = true;
          }
        }
      }
      return changed ? { state: bump(state, { mask, pairs }), effects: [] } : none;
    }
  }
}

/** Reduce a batch, threading state; effects are concatenated in order. */
export function reduceAll(state: SelectionState, intents: readonly ControlIntent[], profile: LinnProfile): ReduceResult {
  let next = state;
  const effects: ReduceResult['effects'] = [];
  for (const intent of intents) {
    const r = reduceControls(next, intent, profile);
    next = r.state;
    effects.push(...r.effects);
  }
  return { state: next, effects };
}

/** Translate a runtime event into the intents it carries for THIS reducer.
 *  Touch starts/ends/expression are voice events, not selection intents, and
 *  map to nothing here.
 *
 *  The HARDWARE PANIC cell is one of the lower five (D17) and is gated here,
 *  at the translation from the wire, by `profile.extraControlsEnabled`: with
 *  the switch OFF the cell is inert as well as unlit, like the other four.
 *  The `{ kind: 'panic' }` INTENT itself stays ungated — the face's PANIC
 *  cell dispatches it directly and is always live. */
export function intentsFromRuntimeEvent(event: RuntimeEvent, profile: LinnProfile): ControlIntent[] {
  switch (event.kind) {
    case 'control_edge': {
      const c = event.control;
      if (c === 'r' || c === 'g' || c === 'b') return [{ kind: 'selector_edge', selector: c, down: event.down, epoch: event.epoch }];
      if (c === 'panic') return event.down && profile.extraControlsEnabled ? [{ kind: 'panic' }] : [];
      return [{ kind: 'extra_control', control: c, down: event.down, epoch: event.epoch }];
    }
    case 'pointer':
      return [{ kind: 'pointer', touch: event.touch, phase: event.phase, u: event.u, v: event.v, epoch: event.epoch }];
    case 'session':
      return [{ kind: 'session', epoch: event.epoch }];
    default:
      return [];
  }
}
