// packages/web/src/lib/grid/mext.ts
//
// monome grid "mext" (monome extended) serial-protocol CODEC — PURE, hardware-
// free. This is the byte layer the WebSerial grid-device (grid-device.svelte.ts)
// uses to talk to a 2011+ varibright grid 128. No DOM, no `navigator.serial`,
// no Web Audio — just encode LED frames → bytes and decode the inbound key
// stream → events, so it is fully unit-testable with golden vectors and reused
// unchanged by the device layer + the simulated-device test hook.
//
// SCOPE (Phase 1): the rock-solid, consensus subset every monome grid app
// agrees on (libmonome, the grid-studies examples, dessertplanet/viii):
//   - led set          0x18 [0x18, x, y, level(0-15)]
//   - led all          0x19 [0x19, level(0-15)]
//   - key down/up (RX) 0x21/0x20 [cmd, x, y]
//   - handshake (TX)   query 0x00 / request-id 0x01 / request-size 0x05
//   - handshake (RX)   query-resp 0x00 / id-resp 0x01 / size-resp 0x05
//
// DEFERRED (needs Phase-0 confirmation on real hardware): the 0x1A full-quadrant
// "led level map" command. Sources DISAGREE on its payload — the official monome
// serial.txt + the okyeron mirror say 64 bytes (one 8-bit intensity per LED),
// while libmonome's mext.c packs to 32 bytes (two 4-bit nibbles per byte). Since
// guessing wrong garbles every full repaint, we DON'T ship it blind: full
// repaints batch single-LED 0x18 writes instead (a 128-LED repaint = 512 bytes
// ≈ 44 ms at 115200 baud — perfectly fine for the rare connect/mode-switch
// case), and the incremental common case is already a single 0x18 per change.
// Add 0x1A as an optimization once the byte form is confirmed on the grid.
//
// Series/40h fallback codec (≤2010 monobright units, §1.5 of the plan) is a
// SEPARATE module added only if Phase 0 finds such a unit; this file is mext.

// ---------------------------------------------------------------------------
// Hardware constants
// ---------------------------------------------------------------------------

/** FTDI USB vendor id — every classic (non-USB-C) monome grid is an FTDI UART. */
export const FTDI_VENDOR_ID = 0x0403;
/** Stock FTDI product ids: FT232R (older grids) / FT-X/FT231X (newer). The user
 *  still picks the port from the WebSerial prompt, so this only narrows the list. */
export const FTDI_PRODUCT_IDS = [0x6001, 0x6015] as const;
/** mext runs at the FTDI default 115200 8N1. */
export const GRID_BAUD_RATE = 115200;
/** USB bulk packet size. The dessertplanet/viii prior art pads writes to a
 *  64-byte boundary with 0xFF (a mext no-op) so the FTDI buffer flushes promptly
 *  instead of waiting on its latency timer. We batch commands and pad the final
 *  chunk — see padToPacket / batchFrames. */
export const USB_PACKET_BYTES = 64;
/** mext no-op pad byte. */
export const PAD_BYTE = 0xff;

/** A grid 128 is 16 wide × 8 tall (two horizontally-adjacent 8×8 quadrants). */
export const GRID_WIDTH = 16;
export const GRID_HEIGHT = 8;
export const GRID_CELLS = GRID_WIDTH * GRID_HEIGHT; // 128
/** Varibright LED levels: 0 (off) .. 15 (full). 2012+ shows all 16; the 2011
 *  walnut rounds to 4 visible steps but accepts the same 0-15 command. */
export const LED_LEVEL_MAX = 15;

// mext command bytes (the subset we implement).
const CMD_SYS_QUERY = 0x00;
const CMD_SYS_ID = 0x01;
const CMD_SYS_SIZE = 0x05;
const CMD_LED_SET = 0x18;
const CMD_LED_ALL = 0x19;
const CMD_KEY_UP = 0x20;
const CMD_KEY_DOWN = 0x21;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Clamp + integerize an LED level to the 0..15 varibright range. */
export function clampLevel(level: number): number {
  if (!Number.isFinite(level)) return 0;
  const n = Math.round(level);
  if (n < 0) return 0;
  if (n > LED_LEVEL_MAX) return LED_LEVEL_MAX;
  return n;
}

/** Clamp a coordinate into [0, max). Defensive — a bad x/y must never write
 *  out-of-range bytes that desync the firmware's frame parser. */
function clampCoord(v: number, max: number): number {
  if (!Number.isFinite(v)) return 0;
  const n = Math.trunc(v);
  if (n < 0) return 0;
  if (n >= max) return max - 1;
  return n;
}

// ---------------------------------------------------------------------------
// TX — encode commands (host → grid). Each returns the MINIMAL protocol frame
// (no USB padding); the device layer batches + pads. Golden-vector tested.
// ---------------------------------------------------------------------------

/** Set a single LED (x,y) to a varibright level (0-15). The common case for
 *  incremental updates (one clip pad changes state). */
export function encodeLedSet(x: number, y: number, level: number): Uint8Array {
  return new Uint8Array([
    CMD_LED_SET,
    clampCoord(x, GRID_WIDTH),
    clampCoord(y, GRID_HEIGHT),
    clampLevel(level),
  ]);
}

/** Set every LED to one level (0-15). Used to blank/flood the grid. */
export function encodeLedAll(level: number): Uint8Array {
  return new Uint8Array([CMD_LED_ALL, clampLevel(level)]);
}

/** TX handshake messages. Sent on connect to identify + size the device. */
export const MSG_QUERY = new Uint8Array([CMD_SYS_QUERY]);
export const MSG_REQUEST_ID = new Uint8Array([CMD_SYS_ID]);
export const MSG_REQUEST_SIZE = new Uint8Array([CMD_SYS_SIZE]);

/**
 * Render a full 128-cell LED frame (Uint8Array of levels, row-major
 * index = y*GRID_WIDTH + x) into batched single-LED 0x18 writes, padded to a
 * 64-byte boundary so the FTDI buffer flushes. Used for the rare full repaint
 * (connect / mode switch / scene change). Incremental updates should diff and
 * emit only the changed cells via encodeLedSet (see grid-device).
 *
 * (This is the 0x1A-map stand-in until that command's byte form is confirmed on
 * hardware — see the file header. Functionally identical result, ~512 bytes.)
 */
export function encodeFullFrame(levels: Uint8Array): Uint8Array {
  const frames: Uint8Array[] = [];
  const n = Math.min(levels.length, GRID_CELLS);
  for (let i = 0; i < n; i++) {
    const x = i % GRID_WIDTH;
    const y = Math.floor(i / GRID_WIDTH);
    frames.push(encodeLedSet(x, y, levels[i]));
  }
  return padToPacket(batchFrames(frames));
}

/** Concatenate minimal frames into one byte run (for a batched write). */
export function batchFrames(frames: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const f of frames) total += f.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const f of frames) {
    out.set(f, off);
    off += f.length;
  }
  return out;
}

/**
 * Pad a byte run up to the next multiple of USB_PACKET_BYTES with the mext no-op
 * PAD_BYTE (0xFF), so the FTDI USB bulk transfer flushes immediately. An empty
 * input stays empty (nothing to flush). The grid firmware ignores 0xFF bytes
 * between frames, so this never corrupts the command stream.
 */
export function padToPacket(bytes: Uint8Array, packet = USB_PACKET_BYTES): Uint8Array {
  if (bytes.length === 0) return bytes;
  const padded = Math.ceil(bytes.length / packet) * packet;
  if (padded === bytes.length) return bytes;
  const out = new Uint8Array(padded);
  out.set(bytes, 0);
  out.fill(PAD_BYTE, bytes.length);
  return out;
}

// ---------------------------------------------------------------------------
// RX — decode the inbound stream (grid → host). A grid only sends well-formed
// frames (the 0xFF padding is a TX-only concern), but we still resync defensively
// on any unknown byte so a single corrupt byte can't wedge the parser. Partial
// frames split across reads are buffered until complete.
// ---------------------------------------------------------------------------

export type GridRxEvent =
  | { type: 'key'; x: number; y: number; s: 0 | 1 } // s=1 down, 0 up
  | { type: 'id'; id: string }
  | { type: 'size'; x: number; y: number }
  | { type: 'query'; section: number; count: number };

/** Total frame length (incl. command byte) for each RX command we parse. */
const RX_FRAME_LEN: Record<number, number> = {
  [CMD_SYS_QUERY]: 3, // [0x00, section, count]
  [CMD_SYS_ID]: 33, // [0x01, ...32 ascii]
  [CMD_SYS_SIZE]: 3, // [0x05, x, y]
  [CMD_KEY_UP]: 3, // [0x20, x, y]
  [CMD_KEY_DOWN]: 3, // [0x21, x, y]
};

/**
 * Stateful streaming parser. Feed it whatever bytes a WebSerial read yields;
 * it returns the complete events decoded so far and buffers any trailing
 * partial frame for the next push(). The grid-device subscribes to `key`
 * events (clip/note interaction) and reads the `id` event once on connect to
 * pick the codec (mext vs series — see §1.5 of the plan).
 */
export function createGridRxParser() {
  let buf: number[] = [];
  return {
    push(bytes: Uint8Array | number[] | ArrayLike<number>): GridRxEvent[] {
      const out: GridRxEvent[] = [];
      for (let i = 0; i < bytes.length; i++) buf.push(bytes[i] & 0xff);
      while (buf.length > 0) {
        const cmd = buf[0];
        const len = RX_FRAME_LEN[cmd];
        if (len === undefined) {
          buf.shift(); // unknown byte → resync by dropping it
          continue;
        }
        if (buf.length < len) break; // wait for the rest of this frame
        const frame = buf.splice(0, len);
        switch (cmd) {
          case CMD_KEY_DOWN:
            out.push({ type: 'key', x: frame[1], y: frame[2], s: 1 });
            break;
          case CMD_KEY_UP:
            out.push({ type: 'key', x: frame[1], y: frame[2], s: 0 });
            break;
          case CMD_SYS_SIZE:
            out.push({ type: 'size', x: frame[1], y: frame[2] });
            break;
          case CMD_SYS_QUERY:
            out.push({ type: 'query', section: frame[1], count: frame[2] });
            break;
          case CMD_SYS_ID: {
            // 32 ascii bytes, trailing spaces/nulls stripped.
            let s = '';
            for (let i = 1; i < 33; i++) {
              const c = frame[i];
              if (c === 0) break;
              s += String.fromCharCode(c);
            }
            out.push({ type: 'id', id: s.trim() });
            break;
          }
        }
      }
      return out;
    },
    /** Drop any buffered partial frame (call on disconnect/reconnect). */
    reset() {
      buf = [];
    },
  };
}

/**
 * Classify a monome device-id string into a protocol family (§1.5). The id
 * comes from the 0x01 handshake response. Old 40h units report `m40h…`,
 * "series" 64/128/256 report `m64-`/`m128-`/`m256-` (both MONOBRIGHT → series
 * codec), and mext varibright units report `m` + digits (e.g. `m1000123`).
 * Defaults to 'mext' for anything unrecognized (the likely + richer case).
 */
export function gridFamilyFromId(id: string): 'mext' | 'series' {
  const s = id.trim().toLowerCase();
  if (s.startsWith('m40h')) return 'series';
  if (s.startsWith('m64-') || s.startsWith('m128-') || s.startsWith('m256-')) return 'series';
  return 'mext';
}
