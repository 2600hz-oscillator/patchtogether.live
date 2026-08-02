// packages/web/src/lib/control/push2/push2-display-frame.ts
//
// Ableton Push 2 DISPLAY protocol CODEC — PURE, hardware-free. The display half
// of the Push stack, and the exact sibling of `push2-sysex.ts`: bytes in, bytes
// out, no `navigator`, no DOM, no timers. Everything here is golden-vector
// tested, because the failure mode of a framebuffer format is a picture that is
// *nearly* right — a channel swap or a one-line stride error still produces a
// plausible image, and "plausible" is the hardest kind of wrong to notice.
//
// HARDWARE REFERENCE — Ableton `push-interface`,
// `doc/AbletonPush2MIDIDisplayInterface.asc`, cross-checked against
// `ffont/push2-python` (display.py) and `halfbyte/ableton-push-canvas-display`:
//
//   · Composite USB device, VID 0x2982 / PID 0x1967. The display is a
//     VENDOR-SPECIFIC (class 0xFF) interface — interface 0, bulk OUT endpoint 1,
//     configuration 1 — separate from the Audio-class MIDI interface. Class 0xFF
//     is NOT on Chrome's WebUSB blocklist, which is exactly why WebUSB (screen)
//     and WebMIDI (pads) can coexist on one page.
//   · Frame = 960 × 160 px, 16 bits/px, **BGR565 LITTLE-ENDIAN**.
//     ⚠ B and R are SWAPPED vs the usual RGB565: bits 15..11 = BLUE,
//     10..5 = green, 4..0 = RED.  word = ((b>>3)<<11) | ((g>>2)<<5) | (r>>3),
//     low byte first.
//   · Line = 2048 bytes = 1920 visible (960 px × 2) + 128 FILLER bytes. The
//     filler is part of the line and is shaped like everything else.
//   · Frame = 160 × 2048 = 327,680 bytes, preceded by a 16-byte header
//     `FF CC AA 88` + twelve `00`.
//   · Signal shaping: every byte is XORed with the repeating 4-byte pattern
//     `E7 F3 E7 FF` (i.e. the 32-bit LE mask 0xFFE7F3E7, or the 16-bit LE word
//     pair 0xF3E7 / 0xFFE7 that push2-python applies to its 1024 uint16 line).
//
// WHAT ONLY HARDWARE CAN CONFIRM (no Push 2 was attached when this was written):
//   · that the XOR shaping covers the 128 filler bytes as well as the 1920
//     visible ones. push2-python XORs a full 1024-uint16 line (filler included),
//     which is what we do; if a real device syncs wrong, this is the FIRST
//     byte-level thing to flip.
//   · the 16-byte header bytes and the ~2 s no-frame blackout timeout, both of
//     which come from the documented protocol rather than a measurement here.
//
// PERF NOTE: packing is ~153,600 pixels of scalar work per frame (~1 ms on a
// modern machine, ~5 % of one core at 30 fps). The research plan's eventual
// worker/WASM offload is a later optimisation; this stays on the main thread and
// stays pure so it can be moved wholesale into a worker without changes.

// ---------------------------------------------------------------------------
// Device identity (USB topology — the transport's only magic numbers)
// ---------------------------------------------------------------------------

/** Ableton vendor id. */
export const PUSH2_USB_VENDOR_ID = 0x2982;
/** Push 2 product id. */
export const PUSH2_USB_PRODUCT_ID = 0x1967;
/** The vendor-specific (class 0xFF) display interface. */
export const PUSH2_USB_INTERFACE = 0;
/** Bulk OUT endpoint carrying the framebuffer. */
export const PUSH2_USB_ENDPOINT = 1;
/** USB configuration value to select before claiming the interface. */
export const PUSH2_USB_CONFIGURATION = 1;

// ---------------------------------------------------------------------------
// Frame geometry
// ---------------------------------------------------------------------------

/** Display width in pixels. */
export const PUSH_DISPLAY_W = 960;
/** Display height in pixels. */
export const PUSH_DISPLAY_H = 160;
/** Bytes per pixel (16-bit BGR565). */
export const PUSH_DISPLAY_BPP = 2;
/** VISIBLE bytes per line: 960 px × 2 = 1920. */
export const PUSH_DISPLAY_VISIBLE_LINE_BYTES = PUSH_DISPLAY_W * PUSH_DISPLAY_BPP; // 1920
/** Total bytes per line INCLUDING the 128 filler bytes the device expects. */
export const PUSH_DISPLAY_LINE_BYTES = 2048;
/** Filler bytes at the end of every line (never visible, still XOR-shaped). */
export const PUSH_DISPLAY_FILLER_BYTES =
  PUSH_DISPLAY_LINE_BYTES - PUSH_DISPLAY_VISIBLE_LINE_BYTES; // 128
/** A whole frame: 160 lines × 2048 bytes. */
export const PUSH_DISPLAY_FRAME_BYTES = PUSH_DISPLAY_H * PUSH_DISPLAY_LINE_BYTES; // 327680
/** Length of the RGBA source buffer a frame is packed FROM (canvas ImageData). */
export const PUSH_DISPLAY_RGBA_BYTES = PUSH_DISPLAY_W * PUSH_DISPLAY_H * 4; // 614400

/** The 16-byte frame header sent immediately before each frame. */
export const PUSH_DISPLAY_HEADER: readonly number[] = [
  0xff, 0xcc, 0xaa, 0x88, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
];

/** Signal-shaping XOR pattern, applied byte-wise and repeating every 4 bytes.
 *  Equals the 32-bit little-endian mask 0xFFE7F3E7. */
export const PUSH_DISPLAY_XOR_MASK: readonly number[] = [0xe7, 0xf3, 0xe7, 0xff];

/** Bulk-transfer chunk size. 327680 / 16384 = 20 chunks exactly. */
export const PUSH_DISPLAY_CHUNK_BYTES = 16384;

/** The device repeats its last frame but BLANKS after ~2 s of silence, so a
 *  static card still needs a heartbeat. Re-send the last frame this often. */
export const PUSH_DISPLAY_KEEPALIVE_MS = 500;

/** Minimum spacing between frames (~30 Hz). A push card is nearly static; this
 *  only bounds the burst while an encoder is being spun. */
export const PUSH_DISPLAY_MIN_FRAME_MS = 33;

// ---------------------------------------------------------------------------
// Pixel packing
// ---------------------------------------------------------------------------

/** Clamp an arbitrary number to an 8-bit channel value (NaN → 0). */
function clamp8(v: number): number {
  if (!Number.isFinite(v)) return 0;
  const n = v | 0;
  return n < 0 ? 0 : n > 255 ? 255 : n;
}

/**
 * Pack one 8-bit-per-channel RGB triple into the Push 2's 16-bit **BGR565**
 * word: bits 15..11 BLUE, 10..5 green, 4..0 RED.
 *
 * ⚠ THE CHANNEL ORDER IS THE WHOLE POINT. Red and blue are swapped relative to
 * the RGB565 everyone reaches for by reflex. The golden vectors —
 * (255,0,0) → 0x001F, (0,255,0) → 0x07E0, (0,0,255) → 0xF800 — are the guard:
 * a B/R swap turns red's word into 0xF800 and the test goes red immediately.
 * PURE.
 */
export function packBgr565(r: number, g: number, b: number): number {
  const rr = clamp8(r);
  const gg = clamp8(g);
  const bb = clamp8(b);
  return ((bb & 0xf8) << 8) | ((gg & 0xfc) << 3) | (rr >> 3);
}

/**
 * Inverse of packBgr565 — a 16-bit BGR565 word back to 8-bit channels, with the
 * usual bit-replication expansion (5-bit 31 → 255, 0 → 0). LOSSY for anything
 * that wasn't already quantised, so it is a READ-BACK helper for tests and the
 * simulated device, never a round-trip proof of the format: a symmetric error
 * in pack+unpack would round-trip perfectly and still be wrong on hardware.
 * The golden vectors in packBgr565 are the actual format gate. PURE.
 */
export function unpackBgr565(word: number): { r: number; g: number; b: number } {
  const w = word & 0xffff;
  const b5 = (w >> 11) & 0x1f;
  const g6 = (w >> 5) & 0x3f;
  const r5 = w & 0x1f;
  return {
    r: (r5 << 3) | (r5 >> 2),
    g: (g6 << 2) | (g6 >> 4),
    b: (b5 << 3) | (b5 >> 2),
  };
}

/** Byte offset of pixel (x, y) within a packed frame — the 2048-byte line
 *  stride, NOT the 1920 visible bytes. Getting this wrong shifts every line by
 *  128 bytes and skews the whole picture. PURE. */
export function pushFrameByteOffset(x: number, y: number): number {
  return y * PUSH_DISPLAY_LINE_BYTES + x * PUSH_DISPLAY_BPP;
}

// ---------------------------------------------------------------------------
// Frame packing
// ---------------------------------------------------------------------------

/**
 * Pack a 960×160 RGBA buffer (canvas `ImageData.data` layout) into a ready-to-
 * send Push 2 frame: BGR565 LE, 2048-byte line stride with the 128 filler bytes
 * present, every byte XOR-shaped with `E7 F3 E7 FF`. Alpha is IGNORED (the panel
 * is opaque).
 *
 * Writes into `out` (length must be PUSH_DISPLAY_FRAME_BYTES) and returns it, so
 * a 30 Hz repaint can reuse one buffer instead of churning 320 KB per frame.
 *
 * THROWS RangeError on a wrong-sized input. That is deliberate and is NOT a
 * violation of "a missing display is never an error": a mis-sized buffer is a
 * caller bug, not a hardware condition. The transport catches it and degrades.
 * PURE.
 */
export function packPushFrameInto(rgba: ArrayLike<number>, out: Uint8Array): Uint8Array {
  if (rgba.length !== PUSH_DISPLAY_RGBA_BYTES) {
    throw new RangeError(
      `push2 display: RGBA source must be ${PUSH_DISPLAY_RGBA_BYTES} bytes ` +
        `(${PUSH_DISPLAY_W}×${PUSH_DISPLAY_H}×4), got ${rgba.length}`,
    );
  }
  if (out.length !== PUSH_DISPLAY_FRAME_BYTES) {
    throw new RangeError(
      `push2 display: frame buffer must be ${PUSH_DISPLAY_FRAME_BYTES} bytes, got ${out.length}`,
    );
  }
  const m0 = PUSH_DISPLAY_XOR_MASK[0];
  const m1 = PUSH_DISPLAY_XOR_MASK[1];
  const m2 = PUSH_DISPLAY_XOR_MASK[2];
  const m3 = PUSH_DISPLAY_XOR_MASK[3];
  // The line stride (2048) is a multiple of the 4-byte mask period, so the mask
  // phase is a function of the byte's offset within the line AND within the
  // whole frame — `dst & 3` is correct either way.
  for (let y = 0; y < PUSH_DISPLAY_H; y++) {
    let src = y * PUSH_DISPLAY_W * 4;
    let dst = y * PUSH_DISPLAY_LINE_BYTES;
    const lineEnd = dst + PUSH_DISPLAY_LINE_BYTES;
    const visibleEnd = dst + PUSH_DISPLAY_VISIBLE_LINE_BYTES;
    while (dst < visibleEnd) {
      const word = packBgr565(rgba[src], rgba[src + 1], rgba[src + 2]);
      src += 4;
      // Little-endian: low byte first.
      out[dst] = (word & 0xff) ^ (dst & 2 ? m2 : m0);
      out[dst + 1] = (word >> 8) ^ (dst & 2 ? m3 : m1);
      dst += 2;
    }
    // Filler: 128 bytes of zero, shaped like the rest → the bare mask pattern.
    while (dst < lineEnd) {
      out[dst] = PUSH_DISPLAY_XOR_MASK[dst & 3];
      dst++;
    }
  }
  return out;
}

/** Allocate-and-pack convenience wrapper around packPushFrameInto. PURE. */
export function packPushFrame(rgba: ArrayLike<number>): Uint8Array {
  return packPushFrameInto(rgba, new Uint8Array(PUSH_DISPLAY_FRAME_BYTES));
}

/** A fresh copy of the 16-byte frame header (never hand out the shared const —
 *  protocol bytes must not be mutable by a caller). PURE. */
export function pushDisplayHeader(): Uint8Array {
  return new Uint8Array(PUSH_DISPLAY_HEADER);
}

/**
 * A solid-colour frame — the "blank the panel" payload (and a cheap fixture).
 * Equivalent to packing a uniformly-coloured RGBA buffer, without building the
 * 614 KB source. PURE.
 */
export function solidPushFrame(r = 0, g = 0, b = 0, out?: Uint8Array): Uint8Array {
  const buf = out ?? new Uint8Array(PUSH_DISPLAY_FRAME_BYTES);
  if (buf.length !== PUSH_DISPLAY_FRAME_BYTES) {
    throw new RangeError(
      `push2 display: frame buffer must be ${PUSH_DISPLAY_FRAME_BYTES} bytes, got ${buf.length}`,
    );
  }
  const word = packBgr565(r, g, b);
  const lo = word & 0xff;
  const hi = word >> 8;
  for (let y = 0; y < PUSH_DISPLAY_H; y++) {
    let dst = y * PUSH_DISPLAY_LINE_BYTES;
    const lineEnd = dst + PUSH_DISPLAY_LINE_BYTES;
    const visibleEnd = dst + PUSH_DISPLAY_VISIBLE_LINE_BYTES;
    while (dst < visibleEnd) {
      buf[dst] = lo ^ PUSH_DISPLAY_XOR_MASK[dst & 3];
      buf[dst + 1] = hi ^ PUSH_DISPLAY_XOR_MASK[(dst + 1) & 3];
      dst += 2;
    }
    while (dst < lineEnd) {
      buf[dst] = PUSH_DISPLAY_XOR_MASK[dst & 3];
      dst++;
    }
  }
  return buf;
}

/**
 * Read a pixel back OUT of a packed frame (un-XOR + unpack). The inverse the
 * simulated device and the tests use to prove a frame carries the picture the
 * caller drew. Out-of-range coordinates return black. PURE.
 */
export function readPushFramePixel(
  frame: ArrayLike<number>,
  x: number,
  y: number,
): { r: number; g: number; b: number } {
  if (x < 0 || x >= PUSH_DISPLAY_W || y < 0 || y >= PUSH_DISPLAY_H) return { r: 0, g: 0, b: 0 };
  const off = pushFrameByteOffset(x, y);
  const lo = (frame[off] ?? 0) ^ PUSH_DISPLAY_XOR_MASK[off & 3];
  const hi = (frame[off + 1] ?? 0) ^ PUSH_DISPLAY_XOR_MASK[(off + 1) & 3];
  return unpackBgr565(((hi & 0xff) << 8) | (lo & 0xff));
}

/**
 * Split a packed frame into bulk-transfer chunks (zero-copy subarrays — the
 * caller must not mutate the source while a transfer is in flight; the transport
 * double-buffers for exactly this reason). PURE.
 */
export function pushFrameChunks(frame: Uint8Array, chunkBytes = PUSH_DISPLAY_CHUNK_BYTES): Uint8Array[] {
  const size = chunkBytes > 0 ? Math.floor(chunkBytes) : PUSH_DISPLAY_CHUNK_BYTES;
  const chunks: Uint8Array[] = [];
  for (let off = 0; off < frame.length; off += size) {
    chunks.push(frame.subarray(off, Math.min(off + size, frame.length)));
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Pacing (pure decisions — the timers live in the transport)
// ---------------------------------------------------------------------------

/**
 * How long (ms) the next frame must wait to respect the ~30 Hz floor. 0 = send
 * it now. `lastSentAt` of -Infinity (nothing sent yet) is always 0. PURE.
 */
export function frameGateDelayMs(
  now: number,
  lastSentAt: number,
  minMs = PUSH_DISPLAY_MIN_FRAME_MS,
): number {
  if (!Number.isFinite(lastSentAt)) return 0;
  const wait = minMs - (now - lastSentAt);
  return wait > 0 ? Math.ceil(wait) : 0;
}

/**
 * Is a keepalive re-send due? The panel blanks after ~2 s of silence, so a
 * static card re-sends its last frame every PUSH_DISPLAY_KEEPALIVE_MS. PURE.
 */
export function keepaliveDue(
  now: number,
  lastSentAt: number,
  everyMs = PUSH_DISPLAY_KEEPALIVE_MS,
): boolean {
  if (!Number.isFinite(lastSentAt)) return false; // nothing to repeat yet
  return now - lastSentAt >= everyMs;
}
