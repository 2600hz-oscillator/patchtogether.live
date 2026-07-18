// packages/web/src/lib/ui/modules/clipplayer-keyboard.ts
//
// PURE computer-keyboard → clip-player CONTROL-STRIP mapping (Part B). The card's
// 8-button control strip mirrors the single-pad Launchpad's PERMANENT top row
// (CC 91..98); computer digits 1..8 drive those SAME eight buttons, in the SAME
// order:
//
//   1 → transport   2 → grid   3 → clip   4 → arranger
//   5 → control     6 → undo   7 → redo   8 → shift (HOLD)
//
// This module owns ONLY the pure decisions — the digit↔action map + the
// "should this keystroke be ignored" guard. The stateful hold semantics
// (shift-down/up, key-repeat suppression, the window-capture listener + the
// stuck-shift release-on-blur) live on the card, which is where the DOM +
// $state are; they are covered by e2e. Keeping the map pure lets the mapping
// and the coexistence guard be unit-tested with zero DOM.

/** The eight control-strip actions, in strip order (= CC 91..98 order). */
export type StripAction =
  | 'transport'
  | 'grid'
  | 'clip'
  | 'arranger'
  | 'control'
  | 'undo'
  | 'redo'
  | 'shift';

/** Strip order — index 0 = button 1 (transport) … index 7 = button 8 (shift).
 *  Byte-identical to the launchpad's topRowAction(CC 91..98) ordering. */
export const STRIP_ACTIONS: readonly StripAction[] = [
  'transport',
  'grid',
  'clip',
  'arranger',
  'control',
  'undo',
  'redo',
  'shift',
] as const;

/** The 1-based control-strip button a digit key addresses ('1'..'8'), or null
 *  for any other key. */
export function keyToStripIndex(key: string): number | null {
  if (key.length !== 1) return null;
  if (key < '1' || key > '8') return null;
  return Number(key);
}

/** A digit key ('1'..'8') → the strip action it fires, mirroring CC 91..98.
 *  null for any non-digit key. PURE. */
export function keyToStripAction(key: string): StripAction | null {
  const i = keyToStripIndex(key);
  return i === null ? null : STRIP_ACTIONS[i - 1];
}

/** Button 8 (shift) is the lone HOLD control — it reacts to BOTH edges
 *  (keydown = held, keyup = released). Buttons 1..7 fire once on the down edge. */
export function isHoldAction(action: StripAction): boolean {
  return action === 'shift';
}

// The editable-target selector: focus on one of these means the user is TYPING
// (or picking a colour / dragging a range), so the 1..8 mapping must step aside
// and let the key through. `color` / `range` inputs don't consume digit keys
// meaningfully, but skipping while they're focused is the safe, predictable
// rule (matches the design doc §B.3).
const EDITABLE_SELECTOR =
  'input:not([type=color]):not([type=range]), textarea, select, [contenteditable=""], [contenteditable="true"]';

/** Is `el` (an event target or document.activeElement) inside an editable
 *  control? Used to keep the digit mapping from hijacking typing into the
 *  module title rename, per-lane colour, or per-lane rate select. Duck-typed on
 *  `.closest` (not `instanceof Element`) so it works in the DOM-free unit
 *  environment as well as the browser. */
export function isEditableTarget(el: EventTarget | null): boolean {
  const closest = (el as { closest?: (sel: string) => unknown } | null)?.closest;
  if (typeof closest !== 'function') return false;
  return !!closest.call(el, EDITABLE_SELECTOR);
}

/** Modifier snapshot the guard reads (a subset of KeyboardEvent so it stays
 *  DOM-free and unit-testable). Shift is intentionally ABSENT — a shifted digit
 *  is still a digit here (shift-8 is not a distinct chord), so shift never
 *  excludes the mapping. */
export interface DigitGuardEvent {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
}

/**
 * Whether a keydown/keyup carrying a digit should be IGNORED for the 1..8
 * mapping (let it pass through to the browser / app / a focused field):
 *   - an OS/app modifier (Cmd/Ctrl/Alt) is down (leave cmd-1 etc. alone), OR
 *   - the event target OR the current `activeElement` is an editable control.
 * PURE — `activeEl` is passed in so this needs no DOM.
 */
export function shouldIgnoreDigit(e: DigitGuardEvent, activeEl: EventTarget | null): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey) return true;
  if (isEditableTarget(e.target)) return true;
  if (isEditableTarget(activeEl)) return true;
  return false;
}
