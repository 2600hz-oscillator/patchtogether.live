// packages/web/src/lib/blood/blood-keys.ts
//
// TypeScript mirror of the NBlood / Build-engine `sc_*` SCANCODE constants
// (build/include/scancodes.h) that the engine's keyboard layer reads. The
// BLOOD analogue of doomkeys.ts. Pure-data (no imports) so it unit-tests
// without the WASM shim.
//
// NOTE: unlike DOOM (whose DG_GetKey takes ASCII-ish doomkeys), the Build
// engine's input is SCANCODE-based (KB_KeyDown[scancode] / the CONTROL layer).
// The bpt_set_key shim takes a Build scancode; these are those values.

// Movement / action scancodes (from build/include/scancodes.h).
export const SC_UP_ARROW = 0xc8;
export const SC_DOWN_ARROW = 0xd0;
export const SC_LEFT_ARROW = 0xcb;
export const SC_RIGHT_ARROW = 0xcd;
export const SC_LEFT_CONTROL = 0x1d; // default FIRE
export const SC_RIGHT_CONTROL = 0x9d;
export const SC_SPACE = 0x39; // default OPEN / USE
export const SC_LEFT_ALT = 0x38; // strafe modifier / JUMP in Blood defaults
export const SC_ENTER = 0x1c; // sc_Return
export const SC_ESCAPE = 0x01;
export const SC_TAB = 0x0f;
export const SC_Z = 0x2c; // crouch (Blood default)
export const SC_X = 0x2d;
export const SC_C = 0x2e;
// Weapon cycle: Blood binds these to the mouse-wheel / [ ] by default; for CV
// we expose the comma/period weapon prev/next bindings the engine also accepts.
export const SC_COMMA = 0x33; // weapon prev
export const SC_PERIOD = 0x34; // weapon next

// Letter/number/modifier scancodes (standard PC set-1, build/include/scancodes.h)
// added so the keyboard map can send each PHYSICAL key's OWN scancode — matching
// Blood's ACTUAL default bindings (the in-game KEY SETUP), instead of the prior
// map's guesses (W→up-arrow, Space→use, LCtrl→fire) which didn't match the engine.
export const SC_W = 0x11; // MOVE FORWARD
export const SC_E = 0x12; // OPEN / USE
export const SC_A = 0x1e; // STRAFE LEFT
export const SC_S = 0x1f; // MOVE BACKWARD
export const SC_D = 0x20; // STRAFE RIGHT
export const SC_LSHIFT = 0x2a; // RUN
export const SC_RSHIFT = 0x36; // RUN
export const SC_CAPSLOCK = 0x3a; // AUTORUN
export const SC_RIGHT_ALT = 0xb8; // STRAFE (modifier)
export const SC_BACKSPACE = 0x0e; // TURN AROUND
// Weapon-select number row 1..0.
export const SC_1 = 0x02;
export const SC_2 = 0x03;
export const SC_3 = 0x04;
export const SC_4 = 0x05;
export const SC_5 = 0x06;
export const SC_6 = 0x07;
export const SC_7 = 0x08;
export const SC_8 = 0x09;
export const SC_9 = 0x0a;
export const SC_0 = 0x0b;

// ---------------- CV-gate port id → Build scancode ----------------
//
// The Phase-1 BLOOD module exposes these semantic CV-gate inputs (single
// player — one input group, unlike DOOM's 4 per-slot groups). A rising edge on
// `up` feels like holding ArrowUp. esc/enter drive the menu. Mirrors the plan's
// port list.
// Scancodes corrected to Blood's ACTUAL default bindings (the in-game KEY SETUP):
// FIRE=RCTRL, SPECIAL FIRE=X, OPEN/USE=E, JUMP=SPACE, CROUCH=LCTRL. (The prior
// values had fire→LCtrl=crouch, use→Space=jump, etc. — gates fired the wrong
// action.) up/down/left/right stay the arrow keys (turn + menu); dedicated
// forward/back/strafe movement gates are a follow-up port-set expansion.
export const SCANCODE_FOR_CV_GATE: Readonly<Record<string, number>> = {
  up: SC_UP_ARROW,
  down: SC_DOWN_ARROW,
  left: SC_LEFT_ARROW,
  right: SC_RIGHT_ARROW,
  fire: SC_RIGHT_CONTROL,
  altfire: SC_X,
  use: SC_E,
  jump: SC_SPACE,
  crouch: SC_LEFT_CONTROL,
  weapnext: SC_PERIOD,
  weapprev: SC_COMMA,
  esc: SC_ESCAPE,
  enter: SC_ENTER,
};

/** The base cv-gate semantic ids — drive the def's `inputs` + the edge map. */
export const CV_GATE_PORT_IDS = [
  'up', 'down', 'left', 'right',
  'fire', 'altfire', 'use', 'jump', 'crouch',
  'weapnext', 'weapprev', 'esc', 'enter',
] as const;
export type BloodCvGatePortId = (typeof CV_GATE_PORT_IDS)[number];

// ---------------- KeyboardEvent.code → Build scancode ----------------
//
// The card's focused keyboard listener maps KeyboardEvent.code → scancode.
// Layout-stable (physical positions). We stay off the numpad (NUMPAD+'s
// exclusive collision surface — same rule as doomkeys.ts).
// Each physical key sends its OWN Build scancode so Blood's default bindings
// (the in-game KEY SETUP) fire the right action. WASD = forward/strafe, arrows =
// turn (+ menu nav), and the action keys match the KEY SETUP exactly. (up-arrow
// → in-game MOVE FORWARD specifically depends on the engine's gamefunc bindings
// — if Blood doesn't bind the up-arrow to forward by default, that's the
// fully-editable-layout follow-up; W always moves forward.)
export const SCANCODE_FOR_KEYBOARD_CODE: Readonly<Record<string, number>> = {
  // Movement
  KeyW: SC_W, // MOVE FORWARD
  KeyS: SC_S, // MOVE BACKWARD
  KeyA: SC_A, // STRAFE LEFT
  KeyD: SC_D, // STRAFE RIGHT
  ArrowUp: SC_UP_ARROW, // forward (if bound) / menu up
  ArrowDown: SC_DOWN_ARROW, // back (if bound) / menu down
  ArrowLeft: SC_LEFT_ARROW, // TURN LEFT
  ArrowRight: SC_RIGHT_ARROW, // TURN RIGHT
  // Actions — match the in-game KEY SETUP
  ControlLeft: SC_LEFT_CONTROL, // CROUCH
  ControlRight: SC_RIGHT_CONTROL, // WEAPON FIRE
  Space: SC_SPACE, // JUMP
  KeyE: SC_E, // OPEN / USE
  KeyX: SC_X, // WEAPON SPECIAL FIRE
  KeyZ: SC_Z,
  ShiftLeft: SC_LSHIFT, // RUN
  ShiftRight: SC_RSHIFT, // RUN
  AltLeft: SC_LEFT_ALT, // STRAFE (modifier)
  AltRight: SC_RIGHT_ALT, // STRAFE (modifier)
  Backspace: SC_BACKSPACE, // TURN AROUND
  CapsLock: SC_CAPSLOCK, // AUTORUN
  // Weapon select 1..0
  Digit1: SC_1, Digit2: SC_2, Digit3: SC_3, Digit4: SC_4, Digit5: SC_5,
  Digit6: SC_6, Digit7: SC_7, Digit8: SC_8, Digit9: SC_9, Digit0: SC_0,
  // Weapon cycle + menu/system
  Comma: SC_COMMA,
  Period: SC_PERIOD,
  Enter: SC_ENTER,
  Escape: SC_ESCAPE,
  Tab: SC_TAB,
};

// ---------------- Focused-card keyboard-capture gating ----------------
//
// BloodCard installs a window-level CAPTURE-phase keydown/keyup listener (it
// fires BEFORE SvelteFlow's node-keyboard-move + the canvas pan/zoom shortcuts,
// the same load-bearing trick as DoomCard). These PURE predicates decide whether
// that listener should CLAIM an event (preventDefault + stopPropagation + route
// it to the engine) vs. let it through. They live here — not inside the .svelte
// component — so the gating logic unit-tests without mounting the (engine-bound)
// card; the BLOOD analogue of doom-input-mode.ts's `isCvGatePatched`.

/** Structural subset of a DOM element this predicate reads. Duck-typed (instead
 *  of `instanceof HTMLElement`) so it unit-tests in the node env while still
 *  accepting a real DOM `EventTarget` / `Element` at runtime. */
export interface EditableLike {
  tagName?: string;
  isContentEditable?: boolean;
  getAttribute?(name: string): string | null;
}

/** True iff `target` is a text-editable element — a real <input>/<textarea>/
 *  <select>, a contenteditable host, or an ARIA textbox/searchbox/combobox. The
 *  capture listener must NEVER swallow keys headed for one of these, so typing in
 *  the right-click "new module" SEARCH box (or a module-title rename) keeps
 *  working while a BLOOD card is on screen. Mirrors Canvas.svelte's shouldIgnore. */
export function isEditableTarget(
  target: EditableLike | EventTarget | null | undefined,
): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as EditableLike;
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable === true) return true;
  const role = el.getAttribute?.('role') ?? null;
  return role === 'textbox' || role === 'searchbox' || role === 'combobox';
}

/** Inputs to the capture-gating decision (pure mirror of DoomCard.shouldClaimKey). */
export interface BloodKeyClaim {
  /** loadStatus === 'ready' — a game is running to receive the key. */
  ready: boolean;
  /** The card is the focused/selected SF node (focus-within OR the SvelteFlow
   *  `.selected` wrapper — SF's arrow-key node-move fires on the selected node
   *  regardless of focus, so we must claim then too to stop the card sliding). */
  focused: boolean;
  /** The event target (or active element) is an editable element. */
  editableTarget: boolean;
  /** The KeyboardEvent.code. */
  code: string;
}

/** Decide whether BloodCard's capture listener should CLAIM this key event:
 *    - editableTarget ⇒ never claim (let the text field keep the key);
 *    - the runtime must be `ready`;
 *    - the card must be `focused`/selected;
 *    - the code must be one BLOOD actually consumes.
 *  All four must hold — any miss lets the event flow through untouched. */
export function shouldClaimBloodKey({
  ready,
  focused,
  editableTarget,
  code,
}: BloodKeyClaim): boolean {
  if (editableTarget) return false;
  if (!ready) return false;
  if (!focused) return false;
  return SCANCODE_FOR_KEYBOARD_CODE[code] !== undefined;
}
