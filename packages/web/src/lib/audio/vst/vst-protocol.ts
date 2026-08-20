// packages/web/src/lib/audio/vst/vst-protocol.ts
//
// VST bridge protocol v1 codec — the wire contract with the vst-bridge
// native helper (spec: patchtogether.nativeapps
// Sources/VSTBridgeCore/VSTProtocol.swift — its header carries the full
// message flow — plus Sources/BridgeKit/BridgeWire.swift for 0x01 and
// Sources/BridgeKit/MidiWire.swift for 0x02). Constants are DUPLICATED here
// rather than imported across repos, per the provider.ts rejection-code
// convention; the 0x01 layout is byte-identical to the es9 bridge's
// (es9-protocol.ts), because both helpers share BridgeKit.
//
// SESSION MODEL: ONE WebSocket connection = ONE plugin instance (cap 16).
// `hello.clientId` = the card's graph node id; on disconnect the instance
// parks for 90 s (plugin + state intact, notes silenced) and a reconnect
// with the same clientId adopts it — the bridge replays `mounted`. A hello
// whose clientId is held by a live socket evicts that socket
// (status "stopped") — crashed-tab reclaim. No takeover message (that was
// the es9 single-client policy); `busy` = the instance cap.
//
// One localhost WebSocket, dispatch binary frames on byte 0:
//   TEXT frames  — JSON control (types below).
//   BINARY 0x01  — audio block, little-endian, planar Float32:
//     offset size  field
//     0      1     type        0x01
//     1      1     flags       bit0 = planar float32 (always set)
//     2      2     seq         u16, wrapping, per-sender
//     4      8     sampleTime  u64, sender's running frame counter
//     12     4     channelMask u32, bit c set => channel c plane present
//     16     2     frameCount  u16 (1..4096)
//     18     2     reserved
//     20     ...   one frameCount×f32 plane per set mask bit, ascending
//     card→bridge = plugin input (stereo mask 0b11; mask 0 legal = "clock
//     block": frames advance, no planes — how the instrument card pulls
//     rendering). bridge→card = plugin output, always stereo mask 0b11,
//     SAME sampleTime as the input block that pulled it. Nothing mounted ⇒
//     bit-transparent bypass.
//   BINARY 0x02  — MIDI event block (card→bridge only in v1):
//     offset size  field
//     0      1     type        0x02
//     1      1     flags       0 in v1
//     2      2     seq         u16, wrapping, per-sender
//     4      2     count       u16 (≤ 1024)
//     6      2     reserved
//     8      ...   count × 12-byte events:
//                    0  8  sampleTime  u64 — the sender's sample clock at
//                          which the event should sound (SAME clock as the
//                          sampleTime in its audio blocks)
//                    8  1  length      1..3
//                    9  3  data        MIDI bytes, zero-padded
//     Channel-voice/realtime only; no SysEx. Late events clamp to offset 0
//     of the bridge's next rendered block.

export const VST_PROTOCOL_VERSION = 1;
/** 9209/9210 are the es9 bridge; 1234/1235/5173/4173 are reserved
 *  elsewhere in this repo. 9309 collides with none of them. */
export const VST_DEFAULT_URL = 'ws://127.0.0.1:9309/ws';
export const VST_HEADER_SIZE = 20;
export const VST_AUDIO_FRAME_TYPE = 0x01;
export const VST_MIDI_FRAME_TYPE = 0x02;
export const VST_FLAG_PLANAR_F32 = 0x01;
export const VST_MAX_BLOCK_FRAMES = 4096;
export const VST_MIDI_HEADER_SIZE = 8;
export const VST_MIDI_EVENT_SIZE = 12;
export const VST_MAX_MIDI_EVENTS = 1024;

// ---------------------------------------------------------------------------
// Control plane (JSON text frames) — bridge → card
// ---------------------------------------------------------------------------

export type VstPluginKind = 'instrument' | 'effect' | 'musicEffect' | 'generator';

/** One installed plugin. `id` is the stable mount key — treat it as an
 *  OPAQUE string (fourCC ids can contain spaces, e.g. "au:aumu:dls :appl"). */
export interface VstPluginInfo {
  id: string;
  name: string;
  manufacturer: string;
  version: string;
  kind: VstPluginKind;
  format: string; // "au" in v1
}

export interface VstHelperInfo {
  type: 'helperInfo';
  protocolVersion: number;
  name: string;
  version: string;
  /** The rate the bridge accepted and renders at (echo of hello.rate). */
  rate: number;
  maxBlockFrames: number;
  formats: string[];
}

export interface VstPluginList {
  type: 'pluginList';
  plugins: VstPluginInfo[];
}

/** Sent after a successful mount, and REPLAYED on reconnect when the
 *  clientId adopted a parked instance with a plugin mounted. */
export interface VstMounted {
  type: 'mounted';
  plugin: VstPluginInfo;
  /** Plugin-reported processing latency in samples at the render rate. */
  latencySamples: number;
  tailSeconds: number;
  /** 0 for instruments/generators → send mask-0 clock blocks; else 1-2. */
  audioInputChannels: number;
  audioOutputChannels: number;
  acceptsMidi: boolean;
}

export interface VstMountError {
  type: 'mountError';
  pluginId: string;
  message: string;
}

export interface VstUnmounted {
  type: 'unmounted';
}

/** Also sent when the user closes the native editor window themselves. */
export interface VstEditor {
  type: 'editor';
  open: boolean;
  /** true = the plugin's own UI; false = the generic parameter view. */
  custom?: boolean;
}

export interface VstState {
  type: 'state';
  pluginId: string;
  /** base64 of the AU's fullState — OPAQUE; round-trips through setState. */
  data: string;
}

export interface VstStateSet {
  type: 'stateSet';
  ok: boolean;
  detail?: string;
}

/** ~8 Hz while a client is active. */
export interface VstMeters {
  type: 'meters';
  /** dBFS per channel over the last meter window; -120 = silence floor. */
  inputRMS: number[];
  outputRMS: number[];
  renderErrors: number;
  droppedBlocks: number;
  /** MIDI events currently waiting for their sampleTime. */
  midiQueued: number;
  /** Plugin render time as % of audio time rendered (100 ⇒ can't keep up). */
  loadPct: number;
}

export interface VstStatus {
  type: 'status';
  state: string; // 'busy' (instance cap) | 'stopped' (evicted) | ...
  detail?: string;
}

// ---------------------------------------------------------------------------
// 0x01 audio blocks
// ---------------------------------------------------------------------------

export interface VstDecodedBlock {
  seq: number;
  /** Sender's sample clock for frame 0 of this block. */
  sampleTime: number;
  frameCount: number;
  /** Channel index → its plane (a view into the received buffer). */
  planes: Map<number, Float32Array>;
}

/** Decode one binary audio block. Returns null on any malformed input —
 *  the worker drops bad frames rather than throwing off the socket. */
export function decodeBlock(buf: ArrayBuffer): VstDecodedBlock | null {
  if (buf.byteLength < VST_HEADER_SIZE) return null;
  const dv = new DataView(buf);
  if (dv.getUint8(0) !== VST_AUDIO_FRAME_TYPE) return null;
  if ((dv.getUint8(1) & VST_FLAG_PLANAR_F32) === 0) return null;
  const seq = dv.getUint16(2, true);
  const sampleTime = Number(dv.getBigUint64(4, true));
  const mask = dv.getUint32(12, true);
  const frameCount = dv.getUint16(16, true);
  if (frameCount === 0 || frameCount > VST_MAX_BLOCK_FRAMES) return null;
  const chans: number[] = [];
  for (let c = 0; c < 32; c++) if (mask & (1 << c)) chans.push(c);
  if (buf.byteLength !== VST_HEADER_SIZE + chans.length * frameCount * 4) return null;
  const planes = new Map<number, Float32Array>();
  let off = VST_HEADER_SIZE;
  for (const c of chans) {
    planes.set(c, new Float32Array(buf, off, frameCount));
    off += frameCount * 4;
  }
  return { seq, sampleTime, frameCount, planes };
}

/** Encode one card→bridge audio block from a per-channel sample source.
 *  `channels` must be ascending; `mask` is derived from it. `channels: []`
 *  encodes a mask-0 CLOCK block — frames advance, no planes (how the
 *  instrument card pulls the plugin without sending audio). */
export function encodeBlock(
  seq: number,
  sampleTime: number,
  channels: number[],
  frameCount: number,
  src: (ch: number, frame: number) => number,
): ArrayBuffer {
  const buf = new ArrayBuffer(VST_HEADER_SIZE + channels.length * frameCount * 4);
  const dv = new DataView(buf);
  dv.setUint8(0, VST_AUDIO_FRAME_TYPE);
  dv.setUint8(1, VST_FLAG_PLANAR_F32);
  dv.setUint16(2, seq & 0xffff, true);
  dv.setBigUint64(4, BigInt(Math.max(0, Math.floor(sampleTime))), true);
  let mask = 0;
  for (const c of channels) mask |= 1 << c;
  dv.setUint32(12, mask >>> 0, true);
  dv.setUint16(16, frameCount, true);
  let off = VST_HEADER_SIZE;
  for (const c of channels) {
    const plane = new Float32Array(buf, off, frameCount);
    for (let i = 0; i < frameCount; i++) plane[i] = src(c, i);
    off += frameCount * 4;
  }
  return buf;
}

// ---------------------------------------------------------------------------
// 0x02 MIDI blocks
// ---------------------------------------------------------------------------

/** One event for the encoder — the allocation-free shape the worker drains
 *  out of the MIDI ring. Trailing data bytes are ignored when len < 3. */
export interface VstMidiEventIn {
  sampleTime: number;
  d0: number;
  d1: number;
  d2: number;
  /** 1..3 */
  len: number;
}

export interface VstDecodedMidiEvent {
  sampleTime: number;
  /** 1-3 raw MIDI bytes (status + data). */
  bytes: number[];
}

export interface VstDecodedMidiBlock {
  seq: number;
  events: VstDecodedMidiEvent[];
}

/** Encode one card→bridge MIDI block. Caller keeps batches ≤
 *  VST_MAX_MIDI_EVENTS (the worker drains the ring in capped chunks). */
export function encodeMidiBlock(seq: number, events: readonly VstMidiEventIn[]): ArrayBuffer {
  const count = Math.min(events.length, VST_MAX_MIDI_EVENTS);
  const buf = new ArrayBuffer(VST_MIDI_HEADER_SIZE + count * VST_MIDI_EVENT_SIZE);
  const dv = new DataView(buf);
  dv.setUint8(0, VST_MIDI_FRAME_TYPE);
  dv.setUint8(1, 0);
  dv.setUint16(2, seq & 0xffff, true);
  dv.setUint16(4, count, true);
  dv.setUint16(6, 0, true);
  let off = VST_MIDI_HEADER_SIZE;
  for (let i = 0; i < count; i++) {
    const ev = events[i]!;
    const len = Math.max(1, Math.min(3, ev.len | 0));
    dv.setBigUint64(off, BigInt(Math.max(0, Math.floor(ev.sampleTime))), true);
    dv.setUint8(off + 8, len);
    dv.setUint8(off + 9, ev.d0 & 0xff);
    dv.setUint8(off + 10, len > 1 ? ev.d1 & 0xff : 0);
    dv.setUint8(off + 11, len > 2 ? ev.d2 & 0xff : 0);
    off += VST_MIDI_EVENT_SIZE;
  }
  return buf;
}

/** Decode one MIDI block (tests + any future bridge→card MIDI). Null on any
 *  malformed input, same drop-don't-throw policy as decodeBlock. */
export function decodeMidiBlock(buf: ArrayBuffer): VstDecodedMidiBlock | null {
  if (buf.byteLength < VST_MIDI_HEADER_SIZE) return null;
  const dv = new DataView(buf);
  if (dv.getUint8(0) !== VST_MIDI_FRAME_TYPE) return null;
  const seq = dv.getUint16(2, true);
  const count = dv.getUint16(4, true);
  if (count > VST_MAX_MIDI_EVENTS) return null;
  if (buf.byteLength !== VST_MIDI_HEADER_SIZE + count * VST_MIDI_EVENT_SIZE) return null;
  const events: VstDecodedMidiEvent[] = [];
  let off = VST_MIDI_HEADER_SIZE;
  for (let i = 0; i < count; i++) {
    const sampleTime = Number(dv.getBigUint64(off, true));
    const len = dv.getUint8(off + 8);
    if (len < 1 || len > 3) return null;
    const bytes: number[] = [];
    for (let b = 0; b < len; b++) bytes.push(dv.getUint8(off + 9 + b));
    events.push({ sampleTime, bytes });
    off += VST_MIDI_EVENT_SIZE;
  }
  return { seq, events };
}

/** Bit mask helper: [0, 1] → 0b11. */
export function channelsToMask(channels: number[]): number {
  let mask = 0;
  for (const c of channels) mask |= 1 << c;
  return mask >>> 0;
}
