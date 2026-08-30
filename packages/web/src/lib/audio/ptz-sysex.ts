// PT-PTZ sysex protocol v2 — the app side of the framing spoken by the native
// helper `tools/pt-ptz/pt-ptz.c` (documented in docs/pt-ptz-midi-protocol.md;
// keep all three in sync). Pure byte-level encode/decode, no MIDI, no DOM.
//
// v2 carries a per-axis MODE in the caps reply: 'abs' (absolute position with
// min/max/res/cur — the NexiGo P610's three axes), 'vel' (velocity drive with
// a speed range — the Logitech PTZ Pro 2's pan/tilt, fixed speed 1..1), or
// 'none'. SET_VEL is signed: sign is direction, magnitude clamps into the
// speed range, zero is an explicit STOP; STOP_ALL halts all motion.
//
// val35: a 35-bit two's-complement integer packed into five 7-bit groups,
// least-significant group first. Math ops, not bitwise — JS bitwise truncates
// to 32 bits.

export const PTZ_SYSEX_HEADER = [0xf0, 0x7d, 0x50, 0x54, 0x5a, 0x02] as const;

export const PTZ_CMD = {
  capsRequest: 0x01,
  setAbs: 0x02,
  setVel: 0x03,
  stopAll: 0x04,
  capsReply: 0x41,
  error: 0x42,
} as const;

export const PTZ_CONTROL_IDS = { pan: 0x01, tilt: 0x02, zoom: 0x03 } as const;
export type PtzControl = keyof typeof PTZ_CONTROL_IDS;

export type PtzAxisCaps =
  | { readonly mode: 'abs'; readonly min: number; readonly max: number; readonly res: number; readonly cur: number }
  | { readonly mode: 'vel'; readonly speedMin: number; readonly speedMax: number; readonly speedRes: number }
  | { readonly mode: 'none' };

export interface PtzCaps {
  readonly pan: PtzAxisCaps;
  readonly tilt: PtzAxisCaps;
  readonly zoom: PtzAxisCaps;
}

export type PtzInboundFrame =
  | { readonly kind: 'caps'; readonly caps: PtzCaps }
  | { readonly kind: 'error'; readonly code: number; readonly name: string };

const VAL35_MOD = 2 ** 35;
const VAL35_SIGN = 2 ** 34;
const MODE_BYTE = { none: 0x00, abs: 0x01, vel: 0x02 } as const;

export function encodeVal35(v: number): number[] {
  let u = Math.round(v);
  if (u < 0) u += VAL35_MOD;
  const out: number[] = [];
  for (let i = 0; i < 5; i++) {
    out.push(Math.floor(u / 128 ** i) % 128);
  }
  return out;
}

export function decodeVal35(bytes: ArrayLike<number>, offset: number): number {
  let u = 0;
  for (let i = 0; i < 5; i++) u += (bytes[offset + i]! & 0x7f) * 128 ** i;
  return u >= VAL35_SIGN ? u - VAL35_MOD : u;
}

export function buildCapsRequest(): Uint8Array {
  return Uint8Array.from([...PTZ_SYSEX_HEADER, PTZ_CMD.capsRequest, 0xf7]);
}

export function buildSetAbs(control: PtzControl, value: number): Uint8Array {
  return Uint8Array.from([
    ...PTZ_SYSEX_HEADER,
    PTZ_CMD.setAbs,
    PTZ_CONTROL_IDS[control],
    ...encodeVal35(value),
    0xf7,
  ]);
}

export function buildSetVel(control: PtzControl, value: number): Uint8Array {
  return Uint8Array.from([
    ...PTZ_SYSEX_HEADER,
    PTZ_CMD.setVel,
    PTZ_CONTROL_IDS[control],
    ...encodeVal35(value),
    0xf7,
  ]);
}

export function buildStopAll(): Uint8Array {
  return Uint8Array.from([...PTZ_SYSEX_HEADER, PTZ_CMD.stopAll, 0xf7]);
}

function parseAxis(
  data: ArrayLike<number>,
  off: number,
  end: number,
): { axis: PtzAxisCaps; next: number } | null {
  const mode = data[off];
  if (mode === MODE_BYTE.none) return { axis: { mode: 'none' }, next: off + 1 };
  if (mode === MODE_BYTE.abs) {
    if (off + 21 > end) return null;
    return {
      axis: {
        mode: 'abs',
        min: decodeVal35(data, off + 1),
        max: decodeVal35(data, off + 6),
        res: decodeVal35(data, off + 11),
        cur: decodeVal35(data, off + 16),
      },
      next: off + 21,
    };
  }
  if (mode === MODE_BYTE.vel) {
    if (off + 16 > end) return null;
    return {
      axis: {
        mode: 'vel',
        speedMin: decodeVal35(data, off + 1),
        speedMax: decodeVal35(data, off + 6),
        speedRes: decodeVal35(data, off + 11),
      },
      next: off + 16,
    };
  }
  return null;
}

/** Parse one complete sysex frame from the helper. Returns null for anything
 *  that is not a well-formed PT-PTZ v2 reply (foreign 0x7D traffic is legal). */
export function parsePtzFrame(data: ArrayLike<number>): PtzInboundFrame | null {
  const len = data.length;
  if (len < 8 || data[len - 1] !== 0xf7) return null;
  for (let i = 0; i < PTZ_SYSEX_HEADER.length; i++) {
    if (data[i] !== PTZ_SYSEX_HEADER[i]) return null;
  }
  const cmd = data[6];
  if (cmd === PTZ_CMD.capsReply) {
    const count = data[7]!;
    const controls: Partial<Record<PtzControl, PtzAxisCaps>> = {};
    let off = 8;
    for (let c = 0; c < count; c++) {
      if (off + 2 > len - 1) return null;
      const id = data[off]!;
      const parsed = parseAxis(data, off + 1, len - 1);
      if (!parsed) return null;
      off = parsed.next;
      const name = (Object.keys(PTZ_CONTROL_IDS) as PtzControl[]).find(
        (k) => PTZ_CONTROL_IDS[k] === id,
      );
      if (name) controls[name] = parsed.axis;
    }
    const { pan, tilt, zoom } = controls;
    if (!pan || !tilt || !zoom) return null;
    return { kind: 'caps', caps: { pan, tilt, zoom } };
  }
  if (cmd === PTZ_CMD.error) {
    let name = '';
    for (let i = 8; i < len - 1; i++) name += String.fromCharCode(data[i]! & 0x7f);
    return { kind: 'error', code: data[7]!, name };
  }
  return null;
}
