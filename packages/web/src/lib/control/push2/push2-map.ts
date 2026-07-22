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
// The button CC numbers (Play / Session / Note / Undo / Shift / Layout / Device
// / below-display / above-display / encoders / D-Pad) are the STANDARD Ableton
// Push 2 map. Every one is marked `// CONFIRM ON HARDWARE` — the owner has the
// unit and confirms them via the console port dump on connect (the numbers are
// the documented map, not guesses, but hardware is the source of truth; carry
// the launchpad-windows-dual-port discipline: never trust a number/name matcher
// until the real device is dumped).

import type { LaunchpadRxEvent, LaunchpadFrame } from './push2-types';
import { pushPadNote, pushColorIndex, decodeRelativeCc, type Push2RxEvent } from './push2-sysex';
import {
  noteToPad,
  CC_UP,
  CC_DOWN,
  CC_LEFT,
  CC_RIGHT,
  CC_SESSION,
  CC_TOP_SPARE_6,
  CC_TOP_SPARE_7,
  CC_TOP_SPARE_8,
  SCENE_CCS,
} from '$lib/control/launchpad/launchpad-sysex';

// ---------------------------------------------------------------------------
// Push 2 physical control → MIDI CC numbers (the standard Ableton map). Every
// one is CONFIRM ON HARDWARE (see the file header).
// ---------------------------------------------------------------------------

/** Transport Play → START/STOP (moved here from the grid, per the owner spec). */
export const PUSH_CC_PLAY = 85; // CONFIRM ON HARDWARE
/** Session button → GRID (clip-launch) view. */
export const PUSH_CC_SESSION = 51; // CONFIRM ON HARDWARE
/** Note button → CLIP (note-editor) view. */
export const PUSH_CC_NOTE = 50; // CONFIRM ON HARDWARE
/** Layout button → ARRANGER view. */
export const PUSH_CC_LAYOUT = 31; // CONFIRM ON HARDWARE
/** Device button → CONTROL view. */
export const PUSH_CC_DEVICE = 110; // CONFIRM ON HARDWARE
/** Undo button → undo. */
export const PUSH_CC_UNDO = 119; // CONFIRM ON HARDWARE
/** Shift button → the SHIFT modifier (editor ×8 windowing + arm gestures). */
export const PUSH_CC_SHIFT = 49; // CONFIRM ON HARDWARE

/** D-Pad arrows → CLIP-view nav (± window; +SHIFT = ×8 full screen). */
export const PUSH_CC_DPAD_UP = 46; // CONFIRM ON HARDWARE
export const PUSH_CC_DPAD_DOWN = 47; // CONFIRM ON HARDWARE
export const PUSH_CC_DPAD_LEFT = 44; // CONFIRM ON HARDWARE
export const PUSH_CC_DPAD_RIGHT = 45; // CONFIRM ON HARDWARE

/** The 8 buttons ABOVE the display → select channel 1..8 (CC 102..109). */
export const PUSH_CC_ABOVE_DISPLAY_BASE = 102; // CONFIRM ON HARDWARE
/** The 8 buttons BELOW the display → the Launchpad SCENE column (CC 20..27). */
export const PUSH_CC_BELOW_DISPLAY_BASE = 20; // CONFIRM ON HARDWARE

/** The 8 display encoders → MixMasters ch{1..8}_volume (relative CC 71..78). */
export const PUSH_CC_ENCODER_BASE = 71; // CONFIRM ON HARDWARE
/** Tempo encoder → send1 of the SELECTED channel (relative CC 14). */
export const PUSH_CC_ENCODER_TEMPO = 14; // CONFIRM ON HARDWARE
/** Swing encoder → send2 of the SELECTED channel (relative CC 15). */
export const PUSH_CC_ENCODER_SWING = 15; // CONFIRM ON HARDWARE
/** Master encoder → MixMasters master_volume (relative CC 79). */
export const PUSH_CC_ENCODER_MASTER = 79; // CONFIRM ON HARDWARE

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

/** The Launchpad top-row CC a mapped Push function button drives, or null. This
 *  is how the Push reaches the parity view-switching / transport / undo / shift
 *  that live on the Launchpad permanent top row (CC 91..98). PURE. */
export function pushCcToLaunchpadTopCc(cc: number): number | null {
  switch (cc) {
    case PUSH_CC_PLAY:
      return CC_UP; // 91 transport
    case PUSH_CC_SESSION:
      return CC_DOWN; // 92 GRID view
    case PUSH_CC_NOTE:
      return CC_LEFT; // 93 CLIP view
    case PUSH_CC_LAYOUT:
      return CC_RIGHT; // 94 ARRANGER view
    case PUSH_CC_DEVICE:
      return CC_SESSION; // 95 CONTROL view
    case PUSH_CC_UNDO:
      return CC_TOP_SPARE_6; // 96 undo
    // 97 (redo) has no natural Push home in Phase 1 — left unmapped.
    case PUSH_CC_SHIFT:
      return CC_TOP_SPARE_8; // 98 shift
    default:
      return null;
  }
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

  // BELOW-display buttons → the Launchpad SCENE column (scene launch / editor
  // functions / KEYS scale). SCENE_CCS is top→bottom; below-display is left→right.
  if (cc >= PUSH_CC_BELOW_DISPLAY_BASE && cc < PUSH_CC_BELOW_DISPLAY_BASE + 8) {
    const idx = cc - PUSH_CC_BELOW_DISPLAY_BASE;
    const sceneCc = SCENE_CCS[idx];
    // The Launchpad decoder maps SCENE_CCS[i] → row = LP_HEIGHT-1-i (bottom-origin).
    const row = SCENE_CCS.length - 1 - idx;
    return { kind: 'launchpad', ev: { type: 'scene', row, cc: sceneCc, s: ev.s } };
  }

  // Mapped FUNCTION buttons → the Launchpad permanent top row (view / transport
  // / undo / shift). This is how the Push reaches the parity view-switching.
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

/** The Push button CC that mirrors a Launchpad top-row CC 91..98, or null. */
function launchpadTopCcToPushCc(cc: number): number | null {
  switch (cc) {
    case CC_UP:
      return PUSH_CC_PLAY;
    case CC_DOWN:
      return PUSH_CC_SESSION;
    case CC_LEFT:
      return PUSH_CC_NOTE;
    case CC_RIGHT:
      return PUSH_CC_LAYOUT;
    case CC_SESSION:
      return PUSH_CC_DEVICE;
    case CC_TOP_SPARE_6:
      return PUSH_CC_UNDO;
    case CC_TOP_SPARE_7:
      return null; // redo — unmapped in Phase 1
    case CC_TOP_SPARE_8:
      return PUSH_CC_SHIFT;
    default:
      return null;
  }
}

/** The Push below-display button CC that mirrors a Launchpad scene CC, or null. */
function launchpadSceneCcToPushCc(cc: number): number | null {
  const i = SCENE_CCS.indexOf(cc as (typeof SCENE_CCS)[number]);
  return i >= 0 ? PUSH_CC_BELOW_DISPLAY_BASE + i : null;
}

/**
 * Translate a LaunchpadFrame (the shipped control brain's LED output, indexed by
 * Launchpad programmer indices) into the Push LED specs the device sends. Pads
 * become palette-index colours; the mapped top-row + scene buttons become CC
 * on/off (0 = off, 127 = lit — the Push function buttons are 2-state / white).
 * Indices with no Push home (the logo, redo) are dropped. PURE.
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
    const topCc = launchpadTopCcToPushCc(index);
    if (topCc !== null) {
      out.push({ kind: 'button', cc: topCc, value: lit });
      continue;
    }
    const sceneCc = launchpadSceneCcToPushCc(index);
    if (sceneCc !== null) {
      out.push({ kind: 'button', cc: sceneCc, value: lit });
      continue;
    }
    // no Push home (logo 99, redo) — drop.
  }
  return out;
}
