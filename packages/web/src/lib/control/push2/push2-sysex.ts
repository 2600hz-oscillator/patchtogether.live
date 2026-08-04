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
// (deferred). We map an RGB colour to a STOCK palette entry, so the STATE
// distinctions the clip brain paints (empty / loaded / queued / playing) stay
// visible. Approximate — the exact hue language is refined on hardware later
// (research §2: "v1 use the stock palette by velocity index"). PURE.
//
// ── WHY THIS IS TWO-TIER AND NOT A FLAT NEAREST-ANCHOR SEARCH ──────────────
//
// The original mapping was ONE flat nearest-anchor search over a table whose
// entries were all FULL brightness except black. Squared-Euclidean distance in
// linear RGB then put every DIM colour nearer BLACK than any lit anchor, so the
// whole "dim" half of the Launchpad's design language was EXTINGUISHED:
//
//   RGB_VIEW_IDLE  [16,6,30] → 0   the 3 view buttons you are not on
//   RGB_SHIFT_OFF  [24,20,0] → 0   the SHIFT button at rest
//   RGB_SYS_DIM    [22,10,0] → 0   undo/redo with an empty stack
//   RGB_SCENE_DIM  [24,17,4] → 0   a scene-scroll button at its clamp
//   a lane hue × 0.30        → 0   every UNSELECTED channel-select button
//   a lane hue × 0.32        → 0   every LOADED-but-not-playing clip pad
//
// and the survivors (RGB_PATTERN, RGB_STOP_IDLE, RGB_TIMING) collapsed onto the
// neutral grey at index 1, losing their hue. The LAUNCHPAD never had this bug
// because it takes true per-LED RGB (`encodeLedRgb`, spec type 3, R/G/B each
// 0..127) — it renders [16,6,30] as an actual dim purple. Both surfaces consume
// the SAME LaunchpadFrame; the divergence was entirely in this encoder. That is
// the whole of the owner's "the launch keys are dark except for clip mode / the
// channel row doesn't show the channel colour" report — in clip (grid) view the
// scene column uses full-brightness RGB_SCENE, which survived.
//
// So the mapping now separates the two things the palette index conflates:
//   1. HUE  — matched on the BRIGHTNESS-NORMALISED colour, so a dim purple and a
//      bright purple pick the SAME hue row instead of one of them picking black.
//   2. LEVEL — selects that row's `bright`, `mid` or `dim` palette entry.
// A colour is OFF only when it is TRUE black, which is the invariant the three
// LED zones actually depend on.
//
// THREE levels, not two, and the third is not padding: the surface genuinely
// paints three brightnesses of one hue. RGB_FUNC_ON/RGB_FUNC/RGB_FUNC_DIM
// (peaks 122/70/14) is a three-step ladder, and RGB_MONO_ON [8,78,92] vs
// RGB_MONO_OFF [4,16,20] are both BELOW a two-tier cut, so a two-tier mapping
// collapsed mono-engaged onto poly and lost the state. `pushColorTiers` in
// push2-sysex.test.ts sweeps every RGB_* constant launchpad-map exports and
// fails if any semantic pair collides, so this is enforced rather than asserted.
// ---------------------------------------------------------------------------

/** One hue row of the stock palette: a reference full-brightness colour plus the
 *  palette entry to use for it at each of three brightness levels. */
export interface PushPaletteHue {
  readonly name: string;
  /** Reference FULL-brightness RGB (0..127) — the hue-match target only. */
  readonly rgb: readonly [number, number, number];
  /** Stock palette index for this hue at full brightness. */
  readonly bright: number;
  /** Stock palette index for the SAME hue at medium brightness. */
  readonly mid: number;
  /** Stock palette index for the SAME hue at low brightness. */
  readonly dim: number;
}

/**
 * The stock-palette hue rows.
 *
 * ⚠ PROVENANCE, stated so it is not read as more confirmed than it is. Only the
 * BRIGHT entries 0 / 125 / 126 / 127 (black / blue / green / red) are
 * research-confirmed defaults. The remaining bright entries (122 white, 8 amber,
 * 13 yellow, 37 cyan, 49 purple) are unchanged from the shipped table — the
 * owner's hardware reports say the full-brightness colours read correctly, so
 * they are left exactly as they are and every full-brightness golden is
 * untouched by this change.
 *
 * The `mid` and `dim` columns are INFERRED, not confirmed, from the layout the
 * shipped indices already follow: the Launchpad-family palette groups each hue
 * into FOUR consecutive entries running bright→dim, which is exactly why 13 is
 * yellow, 37 is cyan, 49 is purple and 1 is a dim neutral — four independent
 * corroborations of the same 4-wide grouping. Stepping WITHIN a hue's group is
 * therefore the same hue, darker. For the three pure colours that sit at the TOP
 * of the palette (125/126/127) there is no group to step within, so their mid
 * and dim entries are taken from that hue's low-index group instead.
 *
 * CONFIRM ON HARDWARE. If a mid/dim entry shows the WRONG HUE that is a one-line
 * fix here and nothing else changes — and it is still strictly better than the
 * black it replaced. The gates in push2-sysex.test.ts assert the properties that
 * hold whatever the indices turn out to be: a lit colour never goes dark, and
 * the levels of one hue never collide with each other.
 */
export const PUSH_PALETTE_HUES: readonly PushPaletteHue[] = [
  { name: 'red', rgb: [127, 0, 0], bright: 127, mid: 6, dim: 7 }, // bright research-confirmed
  { name: 'amber', rgb: [127, 80, 0], bright: 8, mid: 9, dim: 10 },
  { name: 'yellow', rgb: [127, 127, 0], bright: 13, mid: 14, dim: 15 },
  { name: 'green', rgb: [0, 127, 0], bright: 126, mid: 22, dim: 23 }, // bright research-confirmed
  { name: 'cyan', rgb: [0, 127, 127], bright: 37, mid: 38, dim: 39 },
  { name: 'blue', rgb: [0, 0, 127], bright: 125, mid: 46, dim: 47 }, // bright research-confirmed
  { name: 'purple', rgb: [80, 0, 127], bright: 49, mid: 50, dim: 51 },
  { name: 'white', rgb: [127, 127, 127], bright: 122, mid: 2, dim: 1 }, // 1 = the shipped dim neutral
];

/**
 * Peak-component cuts between the three brightness tiers: a colour whose peak
 * component is `> PUSH_BRIGHT_PEAK_MIN` is BRIGHT, `> PUSH_MID_PEAK_MIN` is MID,
 * otherwise DIM.
 *
 * MEASURED against every `RGB_*` constant `launchpad-map.ts` exports rather than
 * picked round — the sweep in push2-sysex.test.ts recomputes it, so these cannot
 * drift away from the colours they separate. The tight ones are:
 *   · BRIGHT/MID at 95: RGB_TIMING (peak 84) must not read as RGB_TIMING_ARMED
 *     (127), and RGB_STOP_ACTIVE (104) must not read as RGB_STOP_IDLE (69).
 *   · MID/DIM at 55: RGB_MONO_ON (92) must not read as RGB_MONO_OFF (20), and
 *     RGB_FUNC (70) must not read as RGB_FUNC_DIM (14).
 */
export const PUSH_BRIGHT_PEAK_MIN = 95;
export const PUSH_MID_PEAK_MIN = 55;

/** The palette index for OFF. A colour maps here only when it is TRUE black. */
export const PUSH_PALETTE_OFF = 0;

/** The brightness tier a colour renders at. Exported so the tier sweep can name
 *  the tier in its failure message instead of printing a bare index. */
export type PushColorTier = 'off' | 'dim' | 'mid' | 'bright';

/** The tier a colour's PEAK COMPONENT falls in. PURE. */
export function pushColorTier(r: number, g: number, b: number): PushColorTier {
  const peak = Math.max(clamp7(r), clamp7(g), clamp7(b));
  if (peak === 0) return 'off';
  if (peak > PUSH_BRIGHT_PEAK_MIN) return 'bright';
  if (peak > PUSH_MID_PEAK_MIN) return 'mid';
  return 'dim';
}

/** The hue row a colour matches, ignoring its brightness. PURE. Exported so a
 *  test can assert hue PRESERVATION independently of which index a tier picks. */
export function pushColorHue(r: number, g: number, b: number): PushPaletteHue {
  const rr = clamp7(r), gg = clamp7(g), bb = clamp7(b);
  const peak = Math.max(rr, gg, bb);
  // Normalise to full brightness before matching, so the hue search is not also
  // a brightness search — which is exactly what used to drag every dim colour
  // onto the black anchor and extinguish it.
  const k = peak === 0 ? 0 : 127 / peak;
  const nr = rr * k, ng = gg * k, nb = bb * k;
  let best = PUSH_PALETTE_HUES[0];
  let bestD = Infinity;
  for (const h of PUSH_PALETTE_HUES) {
    const dr = nr - h.rgb[0], dg = ng - h.rgb[1], db = nb - h.rgb[2];
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) { bestD = d; best = h; }
  }
  return best;
}

/**
 * Map an RGB colour (each 0..127, the Launchpad frame's component range) to a
 * stock Push palette index.
 *
 * HUE is matched on the brightness-normalised colour (so dim and bright variants
 * of one colour agree on the hue), and the peak component then selects that
 * hue's bright / mid / dim palette entry. Only TRUE black maps to 0 — a lit
 * colour is never extinguished, which is the property the scene column, the
 * function row and the channel-select row all depend on. PURE. Approximate —
 * CONFIRM/refine the exact palette on hardware.
 */
export function pushColorIndex(r: number, g: number, b: number): number {
  const tier = pushColorTier(r, g, b);
  if (tier === 'off') return PUSH_PALETTE_OFF; // true black — the ONLY way to go dark
  const hue = pushColorHue(r, g, b);
  return tier === 'bright' ? hue.bright : tier === 'mid' ? hue.mid : hue.dim;
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
