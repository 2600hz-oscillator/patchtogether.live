// packages/web/src/lib/control/launchpad/launchpad-sysex.ts
//
// Novation Launchpad Mini Mk3 PROGRAMMER-MODE protocol CODEC — PURE, hardware-
// free. The Launchpad analogue of the monome `mext.ts`: it encodes the SysEx /
// MIDI messages the host sends (enter/exit programmer mode, per-LED RGB + by
// palette, a whole-surface repaint) and decodes the inbound Note/CC stream
// (pad presses, the ▲▼◀▶/Session top buttons, the right scene column). NO Web
// MIDI, no DOM — just bytes ⇄ events, so it is fully unit-testable with golden
// vectors (like mext.test.ts) and reused unchanged by the (future) Web-MIDI
// device layer + a simulated-device test hook.
//
// SCOPE (foundation phase): the byte layer ONLY. The 8×8 placement adapter
// (`launchpad-map.ts`), the stateful binding, the pairing handshake, and the
// Web-MIDI singleton are LATER phases that build on this — see the proposal
// (.myrobots/plans/clip-launcher-launchpad/launchpad-mk3-proposal.md §9).
//
// HARDWARE REFERENCE — every number below is from the Novation **Launchpad Mini
// MK3 Programmer's Reference Manual** (cross-checked with the lpminimk3 +
// launchpad.py implementations). Items the proposal flagged VERIFY-ON-HW (the
// `0E` mode command byte, the 11..88 layout, the scene/logo CCs) are the
// consistent MK3-family convention; the owner's §10 hardware spike pins them.
//
//   - Manufacturer ID (Novation/Focusrite):  00 20 29
//   - Mini Mk3 product bytes:                 02 0D   (Launchpad X = 02 0C;
//                                                       Pro Mk3 = 02 0E)
//   - Programmer/Live mode select command:    0E   (mode 01 = programmer,
//                                                       mode 00 = Live)
//   - LED-lighting SysEx command:             03   (each spec = <type> <index>
//                                                       <data…>; type 3 = RGB,
//                                                       R/G/B each 0-127)
//   - 8×8 pad note numbers (programmer):      row*10 + col, bottom-left = 11,
//                                                       top-right = 88
//   - Top-row buttons (▲▼◀▶ … Session):       CC 91-98 (left → right)
//   - Right scene-column buttons:             CC 89,79,69,59,49,39,29,19
//                                                       (top → bottom)
//   - Logo LED:                               CC 99
//   - Note/CC lighting channel:               ch 1 = static, ch 2 = flashing,
//                                                       ch 3 = pulsing

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------

/** Novation/Focusrite SysEx manufacturer id. */
export const NOVATION_MFR_ID = [0x00, 0x20, 0x29] as const;
/** Launchpad Mini Mk3 product bytes (device byte differs per model). */
export const LP_MINI_MK3_PRODUCT = [0x02, 0x0d] as const;
/** Launchpad X / Pro Mk3 product bytes (for reference / future model support). */
export const LP_X_PRODUCT = [0x02, 0x0c] as const;
export const LP_PRO_MK3_PRODUCT = [0x02, 0x0e] as const;

const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
/** "Programmer / Live mode select" command byte. */
const CMD_MODE = 0x0e;
/** LED-lighting (per-LED colour) command byte. */
const CMD_LIGHTING = 0x03;
/** Lighting spec type 3 = full RGB (R,G,B each 0-127). */
const LIGHTING_TYPE_RGB = 0x03;

/** The 8×8 grid: 8 wide × 8 tall (one Launchpad unit). */
export const LP_WIDTH = 8;
export const LP_HEIGHT = 8;
export const LP_CELLS = LP_WIDTH * LP_HEIGHT; // 64
/** RGB component range in the lighting SysEx (7-bit). */
export const LP_RGB_MAX = 127;

// MIDI status nibbles (channel 0 = the programmer-mode channel for our I/O).
const NOTE_ON = 0x90; // 0x9n
const NOTE_OFF = 0x80; // 0x8n
const CC = 0xb0; // 0xBn

// Top-row CC numbers (left → right): ▲ ▼ ◀ ▶ … Session(▣).
export const CC_UP = 91;
export const CC_DOWN = 92;
export const CC_LEFT = 93;
export const CC_RIGHT = 94;
export const CC_SESSION = 95; // the proposal's SHIFT button
export const CC_TOP_SPARE_6 = 96;
export const CC_TOP_SPARE_7 = 97;
export const CC_TOP_SPARE_8 = 98;
/** Logo LED CC. */
export const CC_LOGO = 99;
/** Right scene-column CCs, top (row 7) → bottom (row 0). */
export const SCENE_CCS = [89, 79, 69, 59, 49, 39, 29, 19] as const;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Clamp + integerize an RGB component to 0..127. */
export function clampRgb(v: number): number {
  if (!Number.isFinite(v)) return 0;
  const n = Math.round(v);
  if (n < 0) return 0;
  if (n > LP_RGB_MAX) return LP_RGB_MAX;
  return n;
}

/** Clamp a coordinate into [0, max). */
function clampCoord(v: number, max: number): number {
  if (!Number.isFinite(v)) return 0;
  const n = Math.trunc(v);
  if (n < 0) return 0;
  if (n >= max) return max - 1;
  return n;
}

/**
 * Programmer-mode pad NOTE number for an 8×8 cell (x,y), with **y measured from
 * the BOTTOM** (y=0 = bottom row, matching the hardware's row*10+col). Returns
 * `(y+1)*10 + (x+1)` → bottom-left (0,0) = 11, top-right (7,7) = 88.
 */
export function padNote(x: number, y: number): number {
  const cx = clampCoord(x, LP_WIDTH);
  const cy = clampCoord(y, LP_HEIGHT);
  return (cy + 1) * 10 + (cx + 1);
}

/** Inverse of padNote: a note number → its (x,y) cell, or null if not an 8×8
 *  pad (e.g. a scene CC, or an out-of-range/garbage note). */
export function noteToPad(note: number): { x: number; y: number } | null {
  const col = (note % 10) - 1; // x
  const row = Math.floor(note / 10) - 1; // y (from bottom)
  if (col < 0 || col >= LP_WIDTH || row < 0 || row >= LP_HEIGHT) return null;
  return { x: col, y: row };
}

// ---------------------------------------------------------------------------
// TX — encode commands (host → Launchpad). Golden-vector tested.
// ---------------------------------------------------------------------------

/** Wrap a SysEx body (the bytes AFTER the manufacturer/product header, BEFORE
 *  the F7 terminator) in a full Mini Mk3 SysEx frame. */
function sysex(...body: number[]): Uint8Array {
  return new Uint8Array([
    SYSEX_START,
    ...NOVATION_MFR_ID,
    ...LP_MINI_MK3_PRODUCT,
    ...body,
    SYSEX_END,
  ]);
}

/** Enter programmer mode (we own every LED): F0 00 20 29 02 0D 0E 01 F7. */
export function encodeEnterProgrammerMode(): Uint8Array {
  return sysex(CMD_MODE, 0x01);
}
/** Exit to Live mode: F0 00 20 29 02 0D 0E 00 F7. */
export function encodeExitProgrammerMode(): Uint8Array {
  return sysex(CMD_MODE, 0x00);
}

/**
 * Light ONE LED (by its programmer-mode index — a pad note 11..88, a top/scene
 * CC, or the logo CC 99) to a full RGB colour via the lighting SysEx:
 *   F0 00 20 29 02 0D 03  03 <index> <r> <g> <b>  F7
 */
export function encodeLedRgb(index: number, r: number, g: number, b: number): Uint8Array {
  return sysex(
    CMD_LIGHTING,
    LIGHTING_TYPE_RGB,
    index & 0x7f,
    clampRgb(r),
    clampRgb(g),
    clampRgb(b),
  );
}

/** Light a pad CELL (x,y from bottom-left) to an RGB colour. */
export function encodePadRgb(x: number, y: number, r: number, g: number, b: number): Uint8Array {
  return encodeLedRgb(padNote(x, y), r, g, b);
}

/** An RGB triple for the whole-surface repaint. */
export interface RgbSpec {
  index: number; // a pad note / CC / logo index
  r: number;
  g: number;
  b: number;
}

/**
 * Repaint a whole batch of LEDs in ONE lighting SysEx: the command carries any
 * number of `03 <index> <r> <g> <b>` specs back-to-back (the Mini accepts a
 * whole-surface repaint, up to ~81 specs, in a single message). Empty input
 * returns an empty array (nothing to send).
 */
export function encodeLedRgbBatch(specs: readonly RgbSpec[]): Uint8Array {
  if (specs.length === 0) return new Uint8Array(0);
  const body: number[] = [CMD_LIGHTING];
  for (const s of specs) {
    body.push(LIGHTING_TYPE_RGB, s.index & 0x7f, clampRgb(s.r), clampRgb(s.g), clampRgb(s.b));
  }
  return sysex(...body);
}

// ---------------------------------------------------------------------------
// RX — decode the inbound MIDI stream (Launchpad → host). Programmer mode sends
// pad presses as Note-On/Off and the top-row/scene buttons as CC. A single MIDI
// message is 3 bytes ([status, data1, data2]); a Note-On with velocity 0 is a
// Note-Off (the running convention). We decode ONE message and classify it.
// ---------------------------------------------------------------------------

export type LaunchpadRxEvent =
  | { type: 'pad'; x: number; y: number; s: 0 | 1; velocity: number } // 8×8 grid
  | { type: 'top'; cc: number; s: 0 | 1 } // ▲▼◀▶ / Session top row
  | { type: 'scene'; row: number; cc: number; s: 0 | 1 } // right scene column
  | { type: 'cc'; cc: number; s: 0 | 1 }; // any other CC (e.g. logo)

/** Which scene-column ROW (0 = bottom … 7 = top) a CC addresses, or null. */
export function sceneRowForCc(cc: number): number | null {
  const i = SCENE_CCS.indexOf(cc as (typeof SCENE_CCS)[number]);
  if (i < 0) return null;
  // SCENE_CCS is top→bottom, so index 0 = top (row 7).
  return LP_HEIGHT - 1 - i;
}
/** Is a CC one of the top-row (▲▼◀▶ … Session) buttons? */
export function isTopCc(cc: number): boolean {
  return cc >= CC_UP && cc <= CC_TOP_SPARE_8;
}

/**
 * Decode a single 3-byte MIDI message into a Launchpad event, or null if it
 * isn't a press/release we care about (e.g. a clock byte, an unknown status).
 * Channel is ignored (programmer mode uses ch 1 for our I/O; lighting channels
 * 2/3 are TX-only). Defensive: bad lengths / statuses → null.
 */
export function decodeMidiMessage(msg: Uint8Array | number[] | ArrayLike<number>): LaunchpadRxEvent | null {
  if (msg.length < 3) return null;
  const status = msg[0] & 0xf0;
  const d1 = msg[1] & 0x7f;
  const d2 = msg[2] & 0x7f;

  if (status === NOTE_ON || status === NOTE_OFF) {
    // Note-On vel 0 == Note-Off.
    const s: 0 | 1 = status === NOTE_ON && d2 > 0 ? 1 : 0;
    const pad = noteToPad(d1);
    if (!pad) return null; // a note outside the 8×8 grid
    return { type: 'pad', x: pad.x, y: pad.y, s, velocity: s === 1 ? d2 : 0 };
  }

  if (status === CC) {
    const s: 0 | 1 = d2 > 0 ? 1 : 0;
    const sceneRow = sceneRowForCc(d1);
    if (sceneRow !== null) return { type: 'scene', row: sceneRow, cc: d1, s };
    if (isTopCc(d1)) return { type: 'top', cc: d1, s };
    return { type: 'cc', cc: d1, s };
  }

  return null;
}

// ---------------------------------------------------------------------------
// MONITOR mapping — the 9×9 RGB-video surface ("out to launch"). The Mini Mk3's
// FULL addressable surface is a 9×9 grid: the 8×8 pads (11..88) PLUS the top CC
// row (91..98), the right scene column (19..89) and the corner logo (99). In the
// programmer-mode numbering EVERY one of those 81 buttons is exactly `row*10 +
// col` for row/col 1..9 — so a downsampled 9×9 video frame maps DIRECTLY onto
// the hardware with no special-casing. PURE (bytes ⇄ indices), so the whole
// video→LED map is unit-testable with synthetic grids.
// ---------------------------------------------------------------------------

/** The monitor surface is 9 wide × 9 tall (pads + top row + scene col + logo). */
export const LP_MONITOR_COLS = 9;
export const LP_MONITOR_ROWS = 9;
/** Addressable LEDs on the full surface (64 pads + 8 top + 8 scene + 1 logo). */
export const LP_MONITOR_CELLS = LP_MONITOR_COLS * LP_MONITOR_ROWS; // 81

/**
 * Programmer-mode LED index for a monitor cell (`col` 0..8 LEFT→right, `row`
 * 0..8 BOTTOM→top) — the natural extension of {@link padNote} to the full 9×9
 * addressable surface. Returns `(row+1)*10 + (col+1)`:
 *   - col/row 0..7 → the 8×8 pads (11..88, bottom-left = 11),
 *   - row 8 (top), col 0..7 → the top CC row (91..98),
 *   - col 8 (right), row 0..7 → the right scene column (19..89),
 *   - col 8 & row 8 → the corner LOGO (99, top-right).
 * Out-of-range coords clamp into the surface.
 */
export function lpMonitorIndex(col: number, row: number): number {
  const c = clampCoord(col, LP_MONITOR_COLS);
  const r = clampCoord(row, LP_MONITOR_ROWS);
  return (r + 1) * 10 + (c + 1);
}

/** All 81 surface indices, in BOTTOM-origin readback order (i = row*9 + col of
 *  a GL `readPixels` of a 9×9 FBO, row 0 = bottom). */
export const LP_MONITOR_INDICES: readonly number[] = (() => {
  const out: number[] = [];
  for (let row = 0; row < LP_MONITOR_ROWS; row++) {
    for (let col = 0; col < LP_MONITOR_COLS; col++) out.push(lpMonitorIndex(col, row));
  }
  return out;
})();

export interface MonitorMapOpts {
  /** Overall brightness 0..1 (default 1). Scales each channel before quantising. */
  bright?: number;
  /** Gamma exponent applied to each 0..1 channel before scaling (default 1 =
   *  linear). >1 deepens the mids/blacks (usually flatters the very-bright LEDs);
   *  <1 lifts them. */
  gamma?: number;
  /** Include the corner logo (index 99)? Default true — it is the top-right cell
   *  of a true 9×9. Set false to leave the odd-shaped logo LED dark. */
  includeLogo?: boolean;
}

/**
 * Convert ONE 8-bit colour channel (0..255) to a 7-bit Launchpad LED value
 * (0..127) applying brightness then gamma. PURE — shared by BOTH the LED push
 * and the on-card preview so what you see on the card matches the hardware.
 */
export function rgb8ToLp(v8: number, bright = 1, gamma = 1): number {
  let x = (Number.isFinite(v8) ? v8 : 0) / 255;
  if (x < 0) x = 0;
  else if (x > 1) x = 1;
  const g = Number.isFinite(gamma) && gamma > 0 ? gamma : 1;
  const b = Number.isFinite(bright) ? Math.max(0, Math.min(1, bright)) : 1;
  return clampRgb(Math.pow(x, g) * b * LP_RGB_MAX);
}

/**
 * Map a BOTTOM-origin 9×9 RGBA readback (`rgba`, length ≥ 81*4 = 324, one byte
 * per channel, row 0 = bottom, col 0 = left — exactly what a GL `readPixels` of
 * a 9×9 FBO yields) to a per-LED colour map: programmer index → [r,g,b] each
 * 0..127. The bottom-left pixel lands on pad 11, the top-right pixel on the logo
 * (99). PURE — the single source of truth for the video→LED colour transform,
 * used by the module's LED push AND its card preview.
 */
export function monitorGridToLeds(
  rgba: ArrayLike<number>,
  opts: MonitorMapOpts = {},
): Map<number, [number, number, number]> {
  const { bright = 1, gamma = 1, includeLogo = true } = opts;
  const leds = new Map<number, [number, number, number]>();
  for (let row = 0; row < LP_MONITOR_ROWS; row++) {
    for (let col = 0; col < LP_MONITOR_COLS; col++) {
      const index = lpMonitorIndex(col, row);
      if (index === CC_LOGO && !includeLogo) continue;
      const p = (row * LP_MONITOR_COLS + col) * 4;
      const r = rgb8ToLp(Number(rgba[p]) || 0, bright, gamma);
      const g = rgb8ToLp(Number(rgba[p + 1]) || 0, bright, gamma);
      const b = rgb8ToLp(Number(rgba[p + 2]) || 0, bright, gamma);
      leds.set(index, [r, g, b]);
    }
  }
  return leds;
}

/**
 * Detect whether a SysEx frame is a Mini Mk3 frame addressed to our product
 * (header `F0 00 20 29 02 0D …`). Used by the device layer to ignore unrelated
 * SysEx (e.g. a co-resident Launchpad X). PURE.
 */
export function isMiniMk3Sysex(bytes: Uint8Array | number[] | ArrayLike<number>): boolean {
  if (bytes.length < 7) return false;
  if (bytes[0] !== SYSEX_START) return false;
  if (bytes[1] !== NOVATION_MFR_ID[0] || bytes[2] !== NOVATION_MFR_ID[1] || bytes[3] !== NOVATION_MFR_ID[2]) {
    return false;
  }
  return bytes[4] === LP_MINI_MK3_PRODUCT[0] && bytes[5] === LP_MINI_MK3_PRODUCT[1];
}
