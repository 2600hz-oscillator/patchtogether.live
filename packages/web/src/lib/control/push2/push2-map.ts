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
//      §3), OR one of the three ADDITIVE Push-only actions (lane-select,
//      encoder→push-card, D-Pad→nav) that `push2-control` handles directly.
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
//   · "Shift" (lower right)  CC 49            → ELECTRA CONTROL MODE toggle
//   · D-Pad ←/→/↑/↓          CC 44 / 45 / 46 / 47
//   · above-display ×8       CC 102..109      → select LANE 1..8 (the push card)
//   · permanent-controls ×8  CC 20..27        → Launchpad top row 91..98 (views)
//   · scene-launch ×8        CC 36..43        (TOP 43 … BOTTOM 36) → scene column
//   · encoders               CC 71..78 (the 8 push-card strips),
//                            14 (unbound) / 15 (flip cards), 79 (master volume)
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

/**
 * THE SHIFT MODIFIER — the button ABOVE THE CHANNEL-8 COLUMN, in the
 * permanent-controls row. It is `PUSH_CC_PERMANENT_BASE + 7` **by construction**,
 * not by an independent number: the permanent row mirrors the Launchpad top row
 * cell-for-cell (20→91 … 27→98) and Launchpad CC 98 IS `action: 'shift'` (see
 * `TOP_ROW_BINDINGS`), so this constant cannot drift away from the row it lives
 * in — change the base and it follows.
 *
 * ⚠ THE PHYSICAL BUTTON LABELLED "Shift" (lower right) IS **NOT** THIS ONE.
 * That button is CC 49 and it is now `PUSH_CC_ELECTRA_MODE` (below). Until
 * 2026-08-03 CC 49 was a SECOND, duplicate route to the same Launchpad shift —
 * so the SHIFT function had two owners and CC 49 had no identity of its own.
 * The owner reassigned CC 49; the shift function did not move, it merely stopped
 * being reachable from two places. Everything that keys off SHIFT — the D-Pad ×8
 * window, the encoder fine-nudge, the LEGEND shift layer, the per-lane arm
 * gestures — now keys off THIS CC and behaves exactly as before.
 */
export const PUSH_CC_SHIFT = 27; // = PUSH_CC_PERMANENT_BASE + 7; asserted in push2-map.test.ts

/**
 * ELECTRA CONTROL MODE — the physical button labelled "Shift" in the LOWER RIGHT
 * of the Push (CC 49). A PLAIN PRESS TOGGLE: press enters the mode, press again
 * leaves it. The release edge is deliberately not reported (a toggle that fired
 * on both edges would enter and immediately leave).
 *
 * In this mode the six LEFTMOST display encoders drive one ROW of the rack's
 * ELECTRA CONTROL 6×6 grid and the screen shows that row — see
 * `push-electra-model.ts`. It is a LATCHED DISPLAY+ENCODER mode, unlike LEGEND
 * (momentary, display-only): the pads, the scene column, the function row and
 * the D-Pad keep routing exactly as they do outside it.
 *
 * ⚠ CC 49 was previously a duplicate inbound route to Launchpad shift AND an
 * outbound LED mirror of it. Both are gone: 49 now reports only this action, and
 * its LED shows whether the mode is ON (a Push-LOCAL state, never a Launchpad
 * frame mirror). `pushCcToLaunchpadTopCc(49)` returns null — asserted.
 */
export const PUSH_CC_ELECTRA_MODE = 49;

/**
 * LEGEND MODE — hold to turn the 960×160 display into on-device documentation of
 * the current view's buttons. DISPLAY-ONLY and MOMENTARY: it changes nothing
 * about what any button does, and releasing restores whatever was on screen.
 *
 * ✅ CONFIRMED ON HARDWARE (owner, 2026-08-03). The owner pressed the button they
 * wanted and read the CC off the app's own MIDI-bind flow: it is **CC 48**, in the
 * lower-right cluster beside SHIFT (49) and just past the D-pad (44..47).
 *
 * ⚠ The previous value (28) was a paper identification and it was WRONG. It was
 * inferred from Ableton's MIDI implementation chart (CC 28 = "master button") plus
 * a Sound On Sound review placing the navigation controls on the right — reasoning
 * that pinned the NUMBER from one source and the POSITION from another and got a
 * button at the TOP-right rather than the lower-right one the owner meant. The
 * comment that shipped with it said so ("best-evidence identification, not a
 * hardware confirmation") and predicted this fix: "If the owner's button turns out
 * to be a different CC, this ONE line changes." It did, and it was.
 *
 * CC 48 steals nothing, on the same test the old comment applied to 28:
 * `classifyPush2` falls through to null for it, and no LED path addresses it — it
 * is absent from `RGB_BUTTON_CCS` (20..27, 36..43, 102..109).
 *
 * Sitting next to SHIFT is a feature, not a hazard: LEGEND is momentary and
 * display-only, so holding 48 with 49 is how you read the SHIFTED legend — the
 * two are separate CCs and compose.
 */
export const PUSH_CC_LEGEND = 48;

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

/** The 8 display encoders → the 8 CONTROL STRIPS of the current PUSH CARD
 *  (relative CC 71..78, left→right). CONFIRMED CC range. Encoder n turns the
 *  param drawn in strip n — see push-card-schema.ts for which param that is. */
export const PUSH_CC_ENCODER_BASE = 71;
/** Tempo encoder — the #1-from-the-left encoder. DELIBERATELY UNBOUND in v1:
 *  the owner's spec names only the #2 encoder, and a global tempo control is a
 *  separate decision (obvious future home: timelorde bpm). */
export const PUSH_CC_ENCODER_TEMPO = 14;
/**
 * The "Swing" encoder (relative CC 15) — the SCROLL encoder. It FLIPS THROUGH
 * THE PUSH CARDS of the selected lane outside ElectraControl mode, and SCROLLS
 * THE ROW 1..6 inside it. One physical knob, one job: "step through the list on
 * screen".
 *
 * ⚠ ITS PHYSICAL POSITION IS NOT HARDWARE-CONFIRMED, AND THE BINDING DOES NOT
 * REST ON ONE. The owner identifies this knob BY FUNCTION — "the same one that
 * scrolls through instruments in our other view" — and that function is
 * unambiguously CC 15 in this file. The owner describes it as the UPPER-RIGHTMOST
 * encoder; an earlier revision of this comment asserted it was the #2-from-the-
 * LEFT encoder, inferred from the encoder-row order (Tempo 14, Swing 15, then
 * the display encoders 71..78, then Master 79). NEITHER position has been
 * verified by turning the knob, so no position claim is made here.
 *
 * If the owner turns it and it reports a different CC, THIS ONE LINE changes —
 * `push2-control` logs the CC of any unbound button press, and an encoder's CC
 * is equally readable from a port dump.
 *
 * ⚠ Do NOT "fix" this by binding to the Master encoder (CC 79) on the grounds
 * that it is the upper-rightmost by this file's own ordering: CC 79 is CONFIRMED
 * bound to mixmstrs `master_volume` and sits beside the physical master level.
 */
export const PUSH_CC_ENCODER_SWING = 15;
/** Master encoder → MixMasters master_volume (relative CC 79). CONFIRMED.
 *  The ONE mixer binding that survives the push-card rework: the physical
 *  master encoder sits next to the master volume knob, so it is not part of
 *  the "8 knobs as a mixer" function the owner dropped. */
export const PUSH_CC_ENCODER_MASTER = 79;

// ---------------------------------------------------------------------------
// Inbound classification — Push2RxEvent → a typed action.
// ---------------------------------------------------------------------------

/**
 * What an encoder addresses, in the PUSH CARD world.
 *
 * This REPLACES the old `EncoderTarget` (`volume`/`send1`/`send2`/`master`),
 * which turned the 8 display encoders into a MixMasters channel-volume strip.
 * The owner dropped "8 knobs as an audio mixer": the display encoders now drive
 * the 8 controls of whatever PUSH CARD is on screen, and the #2-from-the-left
 * encoder flips between the cards of the selected lane.
 */
export type PushEncoderTarget =
  /** CC 71..78 → push-card strip 0..7 (encoder 1..8, left→right). */
  | { kind: 'strip'; index: number }
  /** CC 15 → step through the selected lane's modules, one card at a time. */
  | { kind: 'moduleScroll' }
  /** CC 79 → mixmstrs master_volume (the one surviving mixer binding). */
  | { kind: 'master' };

/** A classified Push action: either a Launchpad-vocabulary event routed into the
 *  shipped control brain (parity), or a Push-only additive action. */
export type Push2Action =
  | { kind: 'launchpad'; ev: LaunchpadRxEvent } // parity — into launchpad-control.handleKey
  | { kind: 'selectChannel'; channel: number } // 0..7 — Push-local selected lane (press only)
  | { kind: 'encoder'; target: PushEncoderTarget; delta: number } // relative encoder nudge
  | { kind: 'dpad'; dir: 'up' | 'down' | 'left' | 'right' } // clip-view nav (press only)
  | { kind: 'legend'; held: boolean } // DISPLAY-ONLY momentary overlay (both edges)
  | { kind: 'electraMode' }; // LATCHED ElectraControl mode toggle (press only)

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
 *  Launchpad permanent TOP ROW (CC 91..98) cell-for-cell — this is where SHIFT
 *  lives (27→98); (2) the dedicated Play / Undo hardware buttons ALSO reach
 *  transport / undo (redundant with the row — real Push buttons the owner will
 *  press).
 *
 *  ⚠ The lower-right "Shift" button (CC 49) is NO LONGER a third route to
 *  Launchpad shift — it is the ElectraControl mode toggle and returns null here.
 *  SHIFT itself is unchanged: CC 27 reaches it through the permanent-row branch
 *  exactly as it always did. PURE. */
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

/** The push-card encoder target a CC addresses, or null when the encoder is
 *  deliberately unbound (Tempo, CC 14). PURE. */
export function encoderTarget(cc: number): PushEncoderTarget | null {
  if (cc >= PUSH_CC_ENCODER_BASE && cc < PUSH_CC_ENCODER_BASE + 8) {
    return { kind: 'strip', index: cc - PUSH_CC_ENCODER_BASE };
  }
  if (cc === PUSH_CC_ENCODER_SWING) return { kind: 'moduleScroll' };
  if (cc === PUSH_CC_ENCODER_MASTER) return { kind: 'master' };
  return null; // PUSH_CC_ENCODER_TEMPO (14) — an encoder, but bound to nothing
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

  // LEGEND MODE — a MOMENTARY, DISPLAY-ONLY overlay. Classified FIRST and both
  // edges are reported (unlike the press-only buttons below): the release is
  // what restores the previous screen, so swallowing it would strand the
  // overlay. It never reaches launchpad-control, so it cannot change routing.
  if (cc === PUSH_CC_LEGEND) return { kind: 'legend', held: ev.s === 1 };

  // ELECTRA CONTROL MODE — a LATCHED toggle, so PRESS ONLY. Reporting the
  // release too would enter the mode and leave it again in one tap, which is
  // exactly the bug the LEGEND button's both-edges rule exists to avoid for the
  // opposite (momentary) case. Like LEGEND it never reaches launchpad-control.
  if (cc === PUSH_CC_ELECTRA_MODE) {
    if (ev.s !== 1) return null; // press-only
    return { kind: 'electraMode' };
  }

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

/**
 * The Push 2 control-button CCs that are full **RGB** (`Color:True` per
 * `ffont/push2-python` `push2_map.py` + the Ableton "Push 2 MIDI and Display
 * Interface" manual): their CC value is a PALETTE INDEX (same 128-entry palette
 * the pads use), NOT a plain brightness. These must be coloured through
 * `pushColorIndex` exactly like the pads — sending a raw `127` lights them RED
 * (127 = the palette's red anchor). The remaining lit buttons (Undo 119, Shift
 * 49, …) are white/mono, where the CC value IS a brightness and 127 = max white.
 */
const RGB_BUTTON_CCS = new Set<number>([
  20, 21, 22, 23, 24, 25, 26, 27, // lower-row display (permanent controls)
  36, 37, 38, 39, 40, 41, 42, 43, // scene / beat column
  102, 103, 104, 105, 106, 107, 108, 109, // upper-row display (channel-select)
  85, 86, 89, 29, 60, 61, // Play, Record, Automate, Stop, Mute, Solo
]);

/**
 * The CC value to send for a lit control button. RGB buttons (see
 * `RGB_BUTTON_CCS`) take a real palette index via `pushColorIndex` (so their
 * colour MATCHES the pads instead of collapsing to red); white/mono buttons take
 * a brightness where 127 = max white. Off (all-zero colour) is always 0. PURE.
 */
function buttonValue(cc: number, r: number, g: number, b: number): number {
  if (r + g + b === 0) return 0; // off
  return RGB_BUTTON_CCS.has(cc)
    ? pushColorIndex(r, g, b) // RGB → real palette index (matches the pads)
    : 127; // white/mono (Undo 119, Shift 49, …) → max-white brightness
}

/** The Push button CC(s) that mirror a Launchpad top-row CC 91..98. The permanent
 *  row (20..27) always mirrors it; transport / undo ALSO light their dedicated
 *  Play / Undo buttons. Empty for a non-top-row index.
 *
 *  ⚠ The lower-right "Shift" button (CC 49) is NOT in this fan-out any more.
 *  It is `PUSH_CC_ELECTRA_MODE`, whose LED reports a PUSH-LOCAL mode, not a
 *  Launchpad frame value — `push2-control` appends it to the LED specs the way
 *  it appends the channel-select row. Mirroring Launchpad shift onto it would
 *  light the button for a function it no longer performs. PURE. */
function launchpadTopCcToPushCcs(cc: number): number[] {
  if (cc < CC_UP || cc > CC_TOP_SPARE_8) return [];
  const out = [PUSH_CC_PERMANENT_BASE + (cc - CC_UP)]; // 91→20 … 98→27 (SHIFT)
  if (cc === CC_UP) out.push(PUSH_CC_PLAY);
  else if (cc === CC_TOP_SPARE_6) out.push(PUSH_CC_UNDO);
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
 * row (plus the dedicated Play/Undo/Shift), and scene CCs become the scene column.
 * The permanent-controls row (20..27), the scene column (36..43) and Play (85) are
 * full-RGB buttons, so their CC value is a PALETTE INDEX (via `buttonValue` →
 * `pushColorIndex`, matching the pads); the white/mono buttons (Undo 119, Shift 49)
 * take a brightness (127 = max white). Off = 0. Indices with no Push home (the
 * logo) are dropped. PURE.
 */
export function push2FrameToLeds(frame: LaunchpadFrame): Push2LedSpec[] {
  const out: Push2LedSpec[] = [];
  for (const [index, [r, g, b]] of frame.leds) {
    const pad = noteToPad(index);
    if (pad) {
      out.push({ kind: 'pad', note: pushPadNote(pad.x, pad.y), palette: pushColorIndex(r, g, b) });
      continue;
    }
    const topCcs = launchpadTopCcToPushCcs(index);
    if (topCcs.length) {
      for (const c of topCcs) out.push({ kind: 'button', cc: c, value: buttonValue(c, r, g, b) });
      continue;
    }
    const sceneCc = launchpadSceneCcToPushCc(index);
    if (sceneCc !== null) {
      out.push({ kind: 'button', cc: sceneCc, value: buttonValue(sceneCc, r, g, b) });
      continue;
    }
    // no Push home (logo 99) — drop.
  }
  return out;
}
