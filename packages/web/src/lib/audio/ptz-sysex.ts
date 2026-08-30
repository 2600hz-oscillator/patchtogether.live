// PT-PTZ sysex protocol — the app side of the framing spoken by the native
// helper `tools/pt-ptz/pt-ptz.c` (documented in docs/pt-ptz-midi-protocol.md;
// keep all three in sync). Pure byte-level encode/decode, no MIDI, no DOM.
//
// val35: a 35-bit two's-complement integer packed into five 7-bit groups,
// least-significant group first — covers the full int32 range UVC
// PanTilt(Absolute) carries. Arithmetic uses Math ops, not bitwise, because JS
// bitwise operators truncate to 32 bits.

export const PTZ_SYSEX_HEADER = [0xf0, 0x7d, 0x50, 0x54, 0x5a, 0x01] as const;

export const PTZ_CMD = {
  capsRequest: 0x01,
  setAbs: 0x02,
  capsReply: 0x41,
  error: 0x42,
} as const;

export const PTZ_CONTROL_IDS = { pan: 0x01, tilt: 0x02, zoom: 0x03 } as const;
export type PtzControl = keyof typeof PTZ_CONTROL_IDS;

export interface PtzControlCaps {
  readonly min: number;
  readonly max: number;
  readonly res: number;
  readonly cur: number;
}

export interface PtzCaps {
  readonly pan: PtzControlCaps;
  readonly tilt: PtzControlCaps;
  readonly zoom: PtzControlCaps;
}

export type PtzInboundFrame =
  | { readonly kind: 'caps'; readonly caps: PtzCaps }
  | { readonly kind: 'error'; readonly code: number; readonly name: string };

const VAL35_MOD = 2 ** 35;
const VAL35_SIGN = 2 ** 34;

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

/** Parse one complete sysex frame from the helper. Returns null for anything
 *  that is not a well-formed PT-PTZ reply (foreign 0x7D traffic is legal). */
export function parsePtzFrame(data: ArrayLike<number>): PtzInboundFrame | null {
  const len = data.length;
  if (len < 8 || data[len - 1] !== 0xf7) return null;
  for (let i = 0; i < PTZ_SYSEX_HEADER.length; i++) {
    if (data[i] !== PTZ_SYSEX_HEADER[i]) return null;
  }
  const cmd = data[6];
  if (cmd === PTZ_CMD.capsReply) {
    const count = data[7]!;
    const controls: Partial<Record<PtzControl, PtzControlCaps>> = {};
    let off = 8;
    for (let c = 0; c < count; c++) {
      if (off + 21 > len - 1) return null;
      const id = data[off]!;
      const caps: PtzControlCaps = {
        min: decodeVal35(data, off + 1),
        max: decodeVal35(data, off + 6),
        res: decodeVal35(data, off + 11),
        cur: decodeVal35(data, off + 16),
      };
      off += 21;
      const name = (Object.keys(PTZ_CONTROL_IDS) as PtzControl[]).find(
        (k) => PTZ_CONTROL_IDS[k] === id,
      );
      if (name) controls[name] = caps;
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
