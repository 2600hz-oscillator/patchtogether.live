// packages/web/src/lib/control/push2/push2-sysex.ts
//
// Ableton Push 2 "User mode" protocol CODEC — PURE, hardware-free. The Push 2
// analogue of `launchpad-sysex.ts`: it encodes the SysEx the host sends (enter
// User mode) + the per-pad / per-button LED messages, and decodes the inbound
// Note/CC stream (pad presses, encoder turns, the display + transport + D-Pad
// buttons). NO Web MIDI, no DOM — just bytes ⇄ events, so it is fully unit-
// testable with golden vectors (like launchpad-sysex.ts) and reused unchanged by
// the Web-MIDI device layer + a simulated-device test hook.
//
// HARDWARE REFERENCE — from the Ableton "Push 2 MIDI and Display Interface"
// spec + `ffont/push2-python` (cross-checked). The MIDI CC map for the D-Pad /
// Shift / Play / display buttons is the STANDARD Ableton Push 2 map; it is
// re-verified on the owner's unit (see the `// CONFIRM ON HARDWARE` markers in
// push2-map.ts — the numbers are the documented map, but the owner has the
// physical device and confirms them via the console port dump on connect).
//
//   - Manufacturer ID (Ableton):              00 21 1D
//   - Device / model bytes:                   01 01
//   - "Set User / Live mode" command:         0A   (01 = User, 00 = Live)
//   - 8×8 pads (Note-On/Off):                 36 + row*8 + col,
//                                               bottom-left = 36, top-right = 99
//   - Pad colour = Note-On VELOCITY (0-127) indexes a 128-entry palette
//     (channel selects an LED animation; channel 0 = static/none). v1 uses the
//     stock palette by velocity index (see pushColorIndex — approximate,
//     owner-refinable on hardware).
//   - Encoders (relative 2's-complement CC): right = 1..63, left = 64..127.

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------

/** Ableton SysEx manufacturer id. */
export const PUSH2_MFR_ID = [0x00, 0x21, 0x1d] as const;
/** Push 2 device / model bytes (follow the mfr id in every command frame). */
export const PUSH2_DEVICE_MODEL = [0x01, 0x01] as const;

const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
/** "Set User / Live mode" command byte (01 = User mode, 00 = Live mode). */
const CMD_MODE = 0x0a;

/** The 8×8 grid: 8 wide × 8 tall. */
export const PUSH_WIDTH = 8;
export const PUSH_HEIGHT = 8;
export const PUSH_CELLS = PUSH_WIDTH * PUSH_HEIGHT; // 64
/** The bottom-left pad's note number (top-right = PUSH_PAD_BASE + 63 = 99). */
export const PUSH_PAD_BASE = 36;
/** Palette-index range for pad colour (7-bit velocity). */
export const PUSH_PALETTE_MAX = 127;

// MIDI status nibbles (Push uses ch 1 for pad/CC I/O in User mode).
const NOTE_ON = 0x90; // 0x9n
const NOTE_OFF = 0x80; // 0x8n
const CC = 0xb0; // 0xBn

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Clamp a coordinate into [0, max). */
function clampCoord(v: number, max: number): number {
  if (!Number.isFinite(v)) return 0;
  const n = Math.trunc(v);
  if (n < 0) return 0;
  if (n >= max) return max - 1;
  return n;
}

/** Clamp + integerize a 7-bit value to 0..127. */
export function clamp7(v: number): number {
  if (!Number.isFinite(v)) return 0;
  const n = Math.round(v);
  if (n < 0) return 0;
  if (n > 127) return 127;
  return n;
}

/**
 * Pad NOTE number for an 8×8 cell (x, y), with **y measured from the BOTTOM**
 * (y=0 = bottom row). Returns `36 + y*8 + x` → bottom-left (0,0) = 36, top-right
 * (7,7) = 99.
 */
export function pushPadNote(x: number, y: number): number {
  const cx = clampCoord(x, PUSH_WIDTH);
  const cy = clampCoord(y, PUSH_HEIGHT);
  return PUSH_PAD_BASE + cy * PUSH_WIDTH + cx;
}

/** Inverse of pushPadNote: a note number → its (x,y) cell, or null if it isn't
 *  an 8×8 pad (note < 36 or > 99). */
export function pushNoteToPad(note: number): { x: number; y: number } | null {
  const idx = note - PUSH_PAD_BASE;
  if (idx < 0 || idx >= PUSH_CELLS) return null;
  return { x: idx % PUSH_WIDTH, y: Math.floor(idx / PUSH_WIDTH) };
}

/**
 * Decode a relative-encoder CC value (2's-complement) → a signed delta:
 * value 1..63 = clockwise (+1..+63), 64..127 = counter-clockwise (-64..-1),
 * 0 = no motion. PURE.
 */
export function decodeRelativeCc(value: number): number {
  const v = value & 0x7f;
  return v < 64 ? v : v - 128;
}

// ---------------------------------------------------------------------------
// Stock-palette colour mapping. The Push pad LED takes a VELOCITY (0..127) that
// indexes a 128-entry palette; arbitrary per-pad RGB needs palette reprogramming
// (deferred). v1 maps an RGB colour to the nearest of a small set of STOCK
// palette anchors, so the STATE distinctions the clip brain paints
// (empty / loaded / queued / playing) stay visible. Approximate — the exact hue
// language is refined on hardware later (research §2: "v1 use the stock palette
// by velocity index"). PURE.
// ---------------------------------------------------------------------------

/** Stock-palette anchors: { index, [r,g,b] } — the reference colours we snap to.
 *  0/125/126/127 are the research-confirmed defaults (black/blue/green/red);
 *  white + the mixed hues are the common stock entries (CONFIRM ON HARDWARE). */
export const PUSH_PALETTE_ANCHORS: readonly { i: number; rgb: readonly [number, number, number] }[] = [
  { i: 0, rgb: [0, 0, 0] }, // black / off (research-confirmed)
  { i: 127, rgb: [127, 0, 0] }, // red (research-confirmed)
  { i: 126, rgb: [0, 127, 0] }, // green (research-confirmed)
  { i: 125, rgb: [0, 0, 127] }, // blue (research-confirmed)
  { i: 122, rgb: [127, 127, 127] }, // white
  { i: 8, rgb: [127, 80, 0] }, // amber / orange
  { i: 13, rgb: [127, 127, 0] }, // yellow
  { i: 37, rgb: [0, 127, 127] }, // cyan
  { i: 49, rgb: [80, 0, 127] }, // purple / violet
  { i: 1, rgb: [40, 40, 40] }, // dim grey (dim/idle states)
];

/**
 * Map an RGB colour (each 0..127, the Launchpad frame's component range) to the
 * nearest stock Push palette index. Nearest by squared Euclidean distance over
 * the anchor table. PURE. Approximate — CONFIRM/refine the exact palette on
 * hardware.
 */
export function pushColorIndex(r: number, g: number, b: number): number {
  const rr = clamp7(r), gg = clamp7(g), bb = clamp7(b);
  let best = PUSH_PALETTE_ANCHORS[0];
  let bestD = Infinity;
  for (const a of PUSH_PALETTE_ANCHORS) {
    const dr = rr - a.rgb[0], dg = gg - a.rgb[1], db = bb - a.rgb[2];
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) { bestD = d; best = a; }
  }
  return best.i;
}

// ---------------------------------------------------------------------------
// TX — encode commands (host → Push). Golden-vector tested.
// ---------------------------------------------------------------------------

/** Wrap a SysEx body in a full Push 2 frame (mfr id + device/model header). */
function sysex(...body: number[]): Uint8Array {
  return new Uint8Array([
    SYSEX_START,
    ...PUSH2_MFR_ID,
    ...PUSH2_DEVICE_MODEL,
    ...body,
    SYSEX_END,
  ]);
}

/**
 * Set the Push to LIVE mode (the DEFAULT for a standalone browser app):
 * `F0 00 21 1D 01 01 0A 00 F7`. In Live mode the pad presses come IN and the pad
 * LED Note-Ons go OUT on the LIVE port with NO further SysEx — the model the
 * proven greyivy/learn-push2-with-svelte WebMIDI reference uses. Sent on bind to
 * reliably recover a device someone left in User mode (setting LIVE is reliable;
 * setting USER outside Ableton Live is the finicky path). PURE.
 */
export function encodeSetLiveMode(): Uint8Array {
  return sysex(CMD_MODE, 0x00);
}
/**
 * Set the Push to USER mode (the host owns the pads/LEDs):
 * `F0 00 21 1D 01 01 0A 01 F7`. Reserved for the future "running alongside
 * Ableton Live" toggle — Phase 1 drives LIVE mode on the Live port. PURE.
 */
export function encodeSetUserMode(): Uint8Array {
  return sysex(CMD_MODE, 0x01);
}
/** @deprecated alias — the USER-mode set (kept for the golden vector). */
export const encodeEnterUserMode = encodeSetUserMode;
/** @deprecated alias — the LIVE-mode set (kept for the golden vector). */
export const encodeExitUserMode = encodeSetLiveMode;

/** Light a PAD (by its note number) to a stock-palette index via a static
 *  Note-On on channel 1: `90 <note> <paletteIndex>`. A palette index of 0 is
 *  "off" (black). PURE — the device layer diffs + sends these. */
export function encodePadColor(note: number, paletteIndex: number): Uint8Array {
  return new Uint8Array([NOTE_ON, note & 0x7f, clamp7(paletteIndex)]);
}

/** Light a display / transport / D-Pad BUTTON (by its CC number) via a CC:
 *  `B0 <cc> <value>` (0 = off, 127 = on — many are white-only or 2-state). PURE. */
export function encodeButtonLed(cc: number, value: number): Uint8Array {
  return new Uint8Array([CC, cc & 0x7f, clamp7(value)]);
}

// ---------------------------------------------------------------------------
// RX — decode the inbound MIDI stream (Push → host). User mode sends pad presses
// as Note-On/Off, encoder turns + button presses as CC. A single MIDI message is
// 3 bytes; a Note-On with velocity 0 is a Note-Off (running convention). Decode
// ONE message and classify it.
// ---------------------------------------------------------------------------

export type Push2RxEvent =
  | { type: 'pad'; x: number; y: number; s: 0 | 1; velocity: number } // 8×8 grid
  | { type: 'cc'; cc: number; s: 0 | 1; value: number }; // any CC (button or encoder)

/**
 * Decode a single 3-byte MIDI message into a Push event, or null if it isn't a
 * pad/CC we care about (a clock byte, an unknown status, an out-of-grid note).
 * Channel is ignored. Defensive: bad lengths / statuses → null. Encoder CCs
 * (relative) are surfaced as `cc` with their raw value; the MAP decodes the
 * relative delta (via decodeRelativeCc) — the codec stays action-agnostic.
 */
export function decodePush2Message(
  msg: Uint8Array | number[] | ArrayLike<number>,
): Push2RxEvent | null {
  if (msg.length < 3) return null;
  const status = msg[0] & 0xf0;
  const d1 = msg[1] & 0x7f;
  const d2 = msg[2] & 0x7f;

  if (status === NOTE_ON || status === NOTE_OFF) {
    const s: 0 | 1 = status === NOTE_ON && d2 > 0 ? 1 : 0;
    const pad = pushNoteToPad(d1);
    if (!pad) return null; // a note outside the 8×8 grid (e.g. the touch strip)
    return { type: 'pad', x: pad.x, y: pad.y, s, velocity: s === 1 ? d2 : 0 };
  }

  if (status === CC) {
    // A button is 127-press / 0-release; an encoder value is a relative delta.
    // We surface value + a press/release flag; the MAP knows which CCs are
    // encoders vs momentary buttons.
    const s: 0 | 1 = d2 > 0 ? 1 : 0;
    return { type: 'cc', cc: d1, s, value: d2 };
  }

  return null;
}

/**
 * Detect whether a SysEx frame is a Push 2 frame addressed to our device
 * (header `F0 00 21 1D 01 01 …`). Used by the device layer to ignore unrelated
 * SysEx. PURE.
 */
export function isPush2Sysex(bytes: Uint8Array | number[] | ArrayLike<number>): boolean {
  if (bytes.length < 7) return false;
  if (bytes[0] !== SYSEX_START) return false;
  if (bytes[1] !== PUSH2_MFR_ID[0] || bytes[2] !== PUSH2_MFR_ID[1] || bytes[3] !== PUSH2_MFR_ID[2]) {
    return false;
  }
  return bytes[4] === PUSH2_DEVICE_MODEL[0] && bytes[5] === PUSH2_DEVICE_MODEL[1];
}
