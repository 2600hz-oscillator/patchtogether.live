// packages/web/src/lib/audio/es9/es9-protocol.ts
//
// Bridge protocol v1 codec — the wire contract with the es9-bridge native
// app (spec: patchtogether.es9/Sources/ES9Core/BridgeProtocol.swift; summary
// in that repo's docs/DESIGN.md). Constants are DUPLICATED here rather than
// imported across repos, per the provider.ts rejection-code convention.
//
// One localhost WebSocket:
//   TEXT frames  — JSON control: hello → deviceInfo, config, meters (~8 Hz),
//                  status, ping/pong.
//   BINARY frames — audio/CV blocks, little-endian, planar Float32:
//     offset size  field
//     0      1     type        0x01 = audio block
//     1      1     flags       bit0 = planar float32 (always set)
//     2      2     seq         u16, wrapping, per-sender
//     4      8     sampleTime  u64, sender's running frame counter
//     12     4     channelMask u32, bit c set => channel c plane present
//     16     2     frameCount  u16 (≤ 4096)
//     18     2     reserved
//     20     ...   one frameCount×f32 plane per set mask bit, ascending
//   bridge→client blocks carry ES-9 INPUT channels; client→bridge blocks
//   carry ES-9 OUTPUT channels. Floats are RAW hardware full scale
//   (±1.0 ≙ ±10 V) — class scaling happens in the worklet.

export const ES9_PROTOCOL_VERSION = 1;
export const ES9_DEFAULT_URL = 'ws://127.0.0.1:9209/ws';
export const ES9_HEADER_SIZE = 20;
export const ES9_AUDIO_FRAME_TYPE = 0x01;
export const ES9_FLAG_PLANAR_F32 = 0x01;
export const ES9_MAX_BLOCK_FRAMES = 4096;

export interface Es9DeviceInfo {
  type: 'deviceInfo';
  protocolVersion: number;
  name: string;
  uid: string;
  rate: number;
  inputChannels: number;
  outputChannels: number;
  bufferFrames: number;
  inputLabels: string[];
  outputLabels: string[];
}

export interface Es9Meters {
  type: 'meters';
  inputRMS: number[];
  outputRMS: number[];
  underruns: number;
  overruns: number;
  outputBufferFrames: number;
}

export interface Es9Status {
  type: 'status';
  state: string;
  detail?: string;
}

export interface Es9DecodedBlock {
  seq: number;
  frameCount: number;
  /** Channel index → its plane (a view into the received buffer). */
  planes: Map<number, Float32Array>;
}

/** Decode one binary audio block. Returns null on any malformed input —
 *  the worker drops bad frames rather than throwing off the socket. */
export function decodeBlock(buf: ArrayBuffer): Es9DecodedBlock | null {
  if (buf.byteLength < ES9_HEADER_SIZE) return null;
  const dv = new DataView(buf);
  if (dv.getUint8(0) !== ES9_AUDIO_FRAME_TYPE) return null;
  if ((dv.getUint8(1) & ES9_FLAG_PLANAR_F32) === 0) return null;
  const seq = dv.getUint16(2, true);
  const mask = dv.getUint32(12, true);
  const frameCount = dv.getUint16(16, true);
  if (frameCount === 0 || frameCount > ES9_MAX_BLOCK_FRAMES) return null;
  const chans: number[] = [];
  for (let c = 0; c < 32; c++) if (mask & (1 << c)) chans.push(c);
  if (buf.byteLength !== ES9_HEADER_SIZE + chans.length * frameCount * 4) return null;
  const planes = new Map<number, Float32Array>();
  let off = ES9_HEADER_SIZE;
  for (const c of chans) {
    planes.set(c, new Float32Array(buf, off, frameCount));
    off += frameCount * 4;
  }
  return { seq, frameCount, planes };
}

/** Encode one client→bridge audio block from a per-channel sample source.
 *  `channels` must be ascending; `mask` is derived from it. */
export function encodeBlock(
  seq: number,
  sampleTime: number,
  channels: number[],
  frameCount: number,
  src: (ch: number, frame: number) => number,
): ArrayBuffer {
  const buf = new ArrayBuffer(ES9_HEADER_SIZE + channels.length * frameCount * 4);
  const dv = new DataView(buf);
  dv.setUint8(0, ES9_AUDIO_FRAME_TYPE);
  dv.setUint8(1, ES9_FLAG_PLANAR_F32);
  dv.setUint16(2, seq & 0xffff, true);
  dv.setBigUint64(4, BigInt(Math.max(0, Math.floor(sampleTime))), true);
  let mask = 0;
  for (const c of channels) mask |= 1 << c;
  dv.setUint32(12, mask >>> 0, true);
  dv.setUint16(16, frameCount, true);
  let off = ES9_HEADER_SIZE;
  for (const c of channels) {
    const plane = new Float32Array(buf, off, frameCount);
    for (let i = 0; i < frameCount; i++) plane[i] = src(c, i);
    off += frameCount * 4;
  }
  return buf;
}

/** Bit mask helper: [0, 1, 4] → 0b10011. */
export function channelsToMask(channels: number[]): number {
  let mask = 0;
  for (const c of channels) mask |= 1 << c;
  return mask >>> 0;
}
