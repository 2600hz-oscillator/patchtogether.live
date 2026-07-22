// packages/web/src/lib/control/push2/push2-map.ts
//
// Push 2 PLACEMENT ADAPTER — the one file that knows the Push 2's physical
// layout AND how it maps onto the shipped Launchpad control brain. Two jobs:
//
//   1. INBOUND  (Push MIDI → an action): a decoded Push2RxEvent is classified
//      into either a `launchpad` event — a LaunchpadRxEvent in the EXACT vocab
//      `launchpad-control` already consumes (pad (x,y) / scene / top CC 91-98) —
//      so the Push drives the full clip-launch / note-editor / scene / KEYS
//      PARITY surface through logic that already ships (decision A, the plan
//      §3), OR one of the three ADDITIVE Push-only actions (channel-select,
//      encoder→mixer, D-Pad→nav) that `push2-control` handles directly.
//
//   2. OUTBOUND (a LaunchpadFrame → Push LEDs): the LED frame the control layer
//      paints (indexed by Launchpad programmer indices — pads 11..88, top CCs
//      91..98, scene CCs) is translated to Push pad palette-index colours + the
//      mapped display/transport button LEDs.
//
// The 8×8 pad grid maps DIRECTLY: Push (x,y) bottom-origin ↔ Launchpad (x,y)
// bottom-origin (both 8-wide, bottom-left = origin) — the note-number bases
// differ (Push 36.., Launchpad 11..) but the codecs already resolve those to
// (x,y), so the surfaces line up cell-for-cell.
//
// The button CC numbers are the OWNER-CONFIRMED map (hardware-tested on the
// owner's Push 2):
//   · 8×8 pads               notes 36..99 (bottom-left 36, top-right 99)
//   · Play (transport)       CC 85
//   · Undo                   CC 119
//   · Shift                  CC 49            (CONFIRM ON HARDWARE — unconfirmed)
//   · D-Pad ←/→/↑/↓          CC 44 / 45 / 46 / 47
//   · above-display ×8       CC 102..109      → select channel 1..8
//   · permanent-controls ×8  CC 20..27        → Launchpad top row 91..98 (views)
//   · scene-launch ×8        CC 36..43        (TOP 43 … BOTTOM 36) → scene column
//   · encoders               CC 71..78 (vol), 14/15 (send1/2), 79 (master)
// Only WHICH permanent-row button maps to which view stays `CONFIRM ON HARDWARE`;
// the CC ranges themselves are confirmed. NOTE the CC↔note overlap is harmless:
// scene CCs 36..43 are MIDI CC messages; pad notes 36..99 are MIDI NOTE messages —
// the codec branches on the status byte, so they never collide.

import type { LaunchpadRxEvent, LaunchpadFrame } from './push2-types';
import { pushPadNote, pushColorIndex, decodeRelativeCc, type Push2RxEvent } from './push2-sysex';
import {
  noteToPad,
  CC_UP,
  CC_TOP_SPARE_6,
  CC_TOP_SPARE_8,
  SCENE_CCS,
} from '$lib/control/launchpad/launchpad-sysex';

// ---------------------------------------------------------------------------
// Push 2 physical control → MIDI CC numbers. These are the OWNER-CONFIRMED map
// (hardware-tested on the owner's Push 2), except where a `// CONFIRM ON HARDWARE`
// marker remains (WHICH permanent-row button is which view; the Shift CC).
// ---------------------------------------------------------------------------

/** Transport Play → START/STOP (moved here from the grid). CONFIRMED. */
export const PUSH_CC_PLAY = 85;
/** Undo button → undo. CONFIRMED (owner-requested mapping). */
export const PUSH_CC_UNDO = 119;
/** Shift button → the SHIFT modifier (editor ×8 windowing + arm gestures). */
export const PUSH_CC_SHIFT = 49; // CONFIRM ON HARDWARE (owner did not confirm Shift)

/** D-Pad arrows → CLIP-view nav (± window; +SHIFT = ×8 full screen). CONFIRMED. */
export const PUSH_CC_DPAD_UP = 46;
export const PUSH_CC_DPAD_DOWN = 47;
export const PUSH_CC_DPAD_LEFT = 44;
export const PUSH_CC_DPAD_RIGHT = 45;

/** The 8 buttons ABOVE the display → select channel 1..8 (CC 102..109). CONFIRMED. */
export const PUSH_CC_ABOVE_DISPLAY_BASE = 102;
/** The "permanent controls" row (8 buttons BELOW the display, ABOVE the grid) →
 *  the Launchpad permanent TOP ROW (view-switch + function surface), CC 20..27
 *  left→right = Launchpad CC 91..98. CONFIRMED range; the per-button view
 *  assignment is CONFIRM ON HARDWARE. */
export const PUSH_CC_PERMANENT_BASE = 20;
/** Scene-launch column (8 buttons to the RIGHT of the 8×8 grid) → the Launchpad
 *  SCENE column. CONFIRMED: CC 36..43, TOP button = 43 … BOTTOM = 36. */
export const PUSH_CC_SCENE_BASE = 36;

/** The 8 display encoders → MixMasters ch{1..8}_volume (relative CC 71..78). CONFIRMED. */
export const PUSH_CC_ENCODER_BASE = 71;
/** Tempo encoder → send1 of the SELECTED channel (relative CC 14). CONFIRMED. */
export const PUSH_CC_ENCODER_TEMPO = 14;
/** Swing encoder → send2 of the SELECTED channel (relative CC 15). CONFIRMED. */
export const PUSH_CC_ENCODER_SWING = 15;
/** Master encoder → MixMasters master_volume (relative CC 79). CONFIRMED. */
export const PUSH_CC_ENCODER_MASTER = 79;

// ---------------------------------------------------------------------------
// Inbound classification — Push2RxEvent → a typed action.
// ---------------------------------------------------------------------------

/** Which MixMasters param an encoder addresses. */
export type EncoderTarget =
  | { param: 'volume'; channel: number } // display encoder n → ch{n+1}_volume (0-based channel)
  | { param: 'send1' } // Tempo → ch{sel}_send1
  | { param: 'send2' } // Swing → ch{sel}_send2
  | { param: 'master' }; // Master → master_volume

/** A classified Push action: either a Launchpad-vocabulary event routed into the
 *  shipped control brain (parity), or a Push-only additive action. */
export type Push2Action =
  | { kind: 'launchpad'; ev: LaunchpadRxEvent } // parity — into launchpad-control.handleKey
  | { kind: 'selectChannel'; channel: number } // 0..7 — Push-local selected channel (press only)
  | { kind: 'encoder'; target: EncoderTarget; delta: number } // relative mixer nudge
  | { kind: 'dpad'; dir: 'up' | 'down' | 'left' | 'right' }; // clip-view nav (press only)

/** Is this Push CC one of the (relative) encoders? Helps the device layer /
 *  control keep encoder + button handling separate. PURE. */
export function isEncoderCc(cc: number): boolean {
  return (
    (cc >= PUSH_CC_ENCODER_BASE && cc < PUSH_CC_ENCODER_BASE + 8) ||
    cc === PUSH_CC_ENCODER_TEMPO ||
    cc === PUSH_CC_ENCODER_SWING ||
    cc === PUSH_CC_ENCODER_MASTER
  );
}

/** The Launchpad top-row CC a mapped Push function button drives, or null. The
 *  Push reaches the parity view-switching / transport / undo / shift on TWO
 *  surfaces: (1) the "permanent controls" row (CC 20..27, left→right) mirrors the
 *  Launchpad permanent TOP ROW (CC 91..98) cell-for-cell; (2) the dedicated Play /
 *  Undo / Shift hardware buttons ALSO reach transport / undo / shift (redundant
 *  with the row — real Push buttons the owner will press). PURE. */
export function pushCcToLaunchpadTopCc(cc: number): number | null {
  // The permanent-controls row → the 8 Launchpad top-row functions, in order.
  if (cc >= PUSH_CC_PERMANENT_BASE && cc < PUSH_CC_PERMANENT_BASE + 8) {
    return CC_UP + (cc - PUSH_CC_PERMANENT_BASE); // 20→91 (transport) … 27→98 (shift)
  }
  // Dedicated hardware buttons.
  switch (cc) {
    case PUSH_CC_PLAY:
      return CC_UP; // 91 transport
    case PUSH_CC_UNDO:
      return CC_TOP_SPARE_6; // 96 undo
    case PUSH_CC_SHIFT:
      return CC_TOP_SPARE_8; // 98 shift
    default:
      return null;
  }
}

/** The scene-column ROW (0 = bottom, 7 = top; bottom-origin) a Push scene-launch
 *  CC addresses, or null. Push scene CCs run 36 (BOTTOM) … 43 (TOP). PURE. */
export function sceneRowForCc(cc: number): number | null {
  if (cc >= PUSH_CC_SCENE_BASE && cc < PUSH_CC_SCENE_BASE + 8) return cc - PUSH_CC_SCENE_BASE;
  return null;
}

/** The D-Pad direction a CC addresses, or null. PURE. */
export function dpadDir(cc: number): 'up' | 'down' | 'left' | 'right' | null {
  switch (cc) {
    case PUSH_CC_DPAD_UP:
      return 'up';
    case PUSH_CC_DPAD_DOWN:
      return 'down';
    case PUSH_CC_DPAD_LEFT:
      return 'left';
    case PUSH_CC_DPAD_RIGHT:
      return 'right';
    default:
      return null;
  }
}

/** The MixMasters encoder target a CC addresses, or null. PURE. */
export function encoderTarget(cc: number): EncoderTarget | null {
  if (cc >= PUSH_CC_ENCODER_BASE && cc < PUSH_CC_ENCODER_BASE + 8) {
    return { param: 'volume', channel: cc - PUSH_CC_ENCODER_BASE };
  }
  if (cc === PUSH_CC_ENCODER_TEMPO) return { param: 'send1' };
  if (cc === PUSH_CC_ENCODER_SWING) return { param: 'send2' };
  if (cc === PUSH_CC_ENCODER_MASTER) return { param: 'master' };
  return null;
}

/**
 * Classify a decoded Push event → a Push2Action, or null when it is unbound
 * (out-of-Phase-1 controls: touch strip, aftertouch, Record, unmapped buttons).
 *
 * PURE — no state. The SHIFT hold is tracked separately by push2-control (from
 * the raw event, keyed on PUSH_CC_SHIFT) for the D-Pad ×8, and ALSO routed here
 * to the Launchpad top row (CC 98) so the parity editor windowing works.
 */
export function classifyPush2(ev: Push2RxEvent): Push2Action | null {
  if (ev.type === 'pad') {
    // 8×8 grid maps directly (bottom-origin ↔ bottom-origin).
    return { kind: 'launchpad', ev: { type: 'pad', x: ev.x, y: ev.y, s: ev.s, velocity: ev.velocity } };
  }

  // ev.type === 'cc'
  const cc = ev.cc;

  // ENCODERS (relative). Fire on any non-zero delta (no press/release semantics).
  if (isEncoderCc(cc)) {
    const target = encoderTarget(cc);
    const delta = decodeRelativeCc(ev.value);
    if (!target || delta === 0) return null;
    return { kind: 'encoder', target, delta };
  }

  // ABOVE-display buttons → select channel 1..8 (press only).
  if (cc >= PUSH_CC_ABOVE_DISPLAY_BASE && cc < PUSH_CC_ABOVE_DISPLAY_BASE + 8) {
    if (ev.s !== 1) return null; // press-only
    return { kind: 'selectChannel', channel: cc - PUSH_CC_ABOVE_DISPLAY_BASE };
  }

  // D-Pad → clip-view nav (press only; SHIFT ×8 handled by push2-control).
  const dir = dpadDir(cc);
  if (dir) {
    if (ev.s !== 1) return null;
    return { kind: 'dpad', dir };
  }

  // SCENE-launch column (CC 36..43, TOP 43 … BOTTOM 36) → the Launchpad SCENE
  // column (scene launch / editor functions / KEYS scale). Push row is
  // bottom-origin; SCENE_CCS is top→bottom, so row r → SCENE_CCS[len-1-r].
  const sceneRow = sceneRowForCc(cc);
  if (sceneRow !== null) {
    const sceneCc = SCENE_CCS[SCENE_CCS.length - 1 - sceneRow];
    return { kind: 'launchpad', ev: { type: 'scene', row: sceneRow, cc: sceneCc, s: ev.s } };
  }

  // The "permanent controls" row (CC 20..27) + the dedicated Play / Undo / Shift
  // buttons → the Launchpad permanent top row (view / transport / undo / shift).
  // This is how the Push reaches the parity view-switching.
  const topCc = pushCcToLaunchpadTopCc(cc);
  if (topCc !== null) {
    return { kind: 'launchpad', ev: { type: 'top', cc: topCc, s: ev.s } };
  }

  return null; // out-of-Phase-1: leave unbound
}

// ---------------------------------------------------------------------------
// Outbound — a LaunchpadFrame → Push LED specs. The device layer diffs these.
// ---------------------------------------------------------------------------

/** One Push LED write: a PAD (palette-index colour) or a BUTTON (CC value). */
export type Push2LedSpec =
  | { kind: 'pad'; note: number; palette: number }
  | { kind: 'button'; cc: number; value: number };

/** The Push button CC(s) that mirror a Launchpad top-row CC 91..98. The permanent
 *  row (20..27) always mirrors it; transport / undo / shift ALSO light their
 *  dedicated Play / Undo / Shift buttons. Empty for a non-top-row index. PURE. */
function launchpadTopCcToPushCcs(cc: number): number[] {
  if (cc < CC_UP || cc > CC_TOP_SPARE_8) return [];
  const out = [PUSH_CC_PERMANENT_BASE + (cc - CC_UP)]; // 91→20 … 98→27
  if (cc === CC_UP) out.push(PUSH_CC_PLAY);
  else if (cc === CC_TOP_SPARE_6) out.push(PUSH_CC_UNDO);
  else if (cc === CC_TOP_SPARE_8) out.push(PUSH_CC_SHIFT);
  return out;
}

/** The Push scene-launch button CC that mirrors a Launchpad scene CC, or null.
 *  SCENE_CCS is top→bottom (index 0 = top = row 7); the Push scene column is
 *  bottom-origin base 36 (TOP 43 … BOTTOM 36). PURE. */
function launchpadSceneCcToPushCc(cc: number): number | null {
  const i = SCENE_CCS.indexOf(cc as (typeof SCENE_CCS)[number]);
  if (i < 0) return null;
  return PUSH_CC_SCENE_BASE + (SCENE_CCS.length - 1 - i); // top(i0)→43 … bottom(i7)→36
}

/**
 * Translate a LaunchpadFrame (the shipped control brain's LED output, indexed by
 * Launchpad programmer indices) into the Push LED specs the device sends. Pads
 * become palette-index colours; the top-row indices become the permanent-controls
 * row (plus the dedicated Play/Undo/Shift), and scene CCs become the scene column
 * — CC on/off (0 = off, 127 = lit; the Push function buttons are 2-state / white).
 * Indices with no Push home (the logo) are dropped. PURE.
 */
export function push2FrameToLeds(frame: LaunchpadFrame): Push2LedSpec[] {
  const out: Push2LedSpec[] = [];
  for (const [index, [r, g, b]] of frame.leds) {
    const pad = noteToPad(index);
    if (pad) {
      out.push({ kind: 'pad', note: pushPadNote(pad.x, pad.y), palette: pushColorIndex(r, g, b) });
      continue;
    }
    const lit = r + g + b > 0 ? 127 : 0;
    const topCcs = launchpadTopCcToPushCcs(index);
    if (topCcs.length) {
      for (const c of topCcs) out.push({ kind: 'button', cc: c, value: lit });
      continue;
    }
    const sceneCc = launchpadSceneCcToPushCc(index);
    if (sceneCc !== null) {
      out.push({ kind: 'button', cc: sceneCc, value: lit });
      continue;
    }
    // no Push home (logo 99) — drop.
  }
  return out;
}
