// packages/web/src/lib/audio/vst/vst-ring.ts
//
// Web-side MIRROR of the SharedArrayBuffer SPSC rings in
// packages/dsp/src/lib/vst-bridge-core.ts (and, for the audio ring,
// es9-bridge-core.ts — the layout is the same one the es9 seam proved).
// This is the bridge Worker's half; the worklet's half ships inside the
// built dsp bundle. Duplicated on purpose: packages/web only consumes
// packages/dsp's BUILT dist artifacts, and the repo convention is
// duplicated constants over cross-package source imports
// (multiplayer/provider.ts documents the same choice for rejection codes).
//
// AUDIO ring layout (byte-for-byte the dsp core's):
//   header: SharedArrayBuffer(8) as Int32Array → [0]=head, [1]=tail,
//           monotonically increasing FRAME counters (int32 wrap;
//           occupancy = (head - tail) | 0).
//   data:   SharedArrayBuffer(channels * capacity * 4) as Float32Array,
//           plane-per-channel: sample(ch, i) = data[ch * capacity + i],
//           i = counter & (capacity - 1). capacity is a power of two.
//
// MIDI ring layout (byte-for-byte the dsp core's — twin tests pin the same
// raw-byte sequence on both sides):
//   header: SharedArrayBuffer(8) as Int32Array → [0]=head, [1]=tail,
//           monotonically increasing RECORD counters.
//   data:   capacity × 16-byte records:
//             bytes 0-3   sampleTime lo (u32)     bytes 4-7  sampleTime hi
//             byte  8     len (1-3)               bytes 9-11 MIDI data
//             bytes 12-15 reserved (0)
//
// A unit test (vst-transport.test.ts) pins both mirrors against the same
// sequences the dsp-side test pins, so drift fails fast.

export interface RingSpec {
  header: SharedArrayBuffer;
  data: SharedArrayBuffer;
  channels: number;
  /** Frames per channel; power of two. */
  capacity: number;
}

export class RingIO {
  readonly channels: number;
  readonly capacity: number;
  private readonly mask: number;
  private readonly header: Int32Array;
  private readonly data: Float32Array;

  constructor(spec: RingSpec) {
    this.channels = spec.channels;
    this.capacity = spec.capacity;
    this.mask = spec.capacity - 1;
    this.header = new Int32Array(spec.header);
    this.data = new Float32Array(spec.data);
  }

  get occupancy(): number {
    return (Atomics.load(this.header, 0) - Atomics.load(this.header, 1)) | 0;
  }

  get free(): number {
    return this.capacity - this.occupancy;
  }

  write(frames: number, src: (ch: number, frame: number) => number): number {
    const head = Atomics.load(this.header, 0);
    const n = Math.min(frames, this.capacity - (((head - Atomics.load(this.header, 1)) | 0)));
    if (n <= 0) return 0;
    for (let ch = 0; ch < this.channels; ch++) {
      const base = ch * this.capacity;
      for (let i = 0; i < n; i++) {
        this.data[base + ((head + i) & this.mask)] = src(ch, i);
      }
    }
    Atomics.store(this.header, 0, (head + n) | 0);
    return n;
  }

  read(frames: number, dst: (ch: number, frame: number, value: number) => void): number {
    const tail = Atomics.load(this.header, 1);
    const n = Math.min(frames, ((Atomics.load(this.header, 0) - tail) | 0));
    if (n <= 0) return 0;
    for (let ch = 0; ch < this.channels; ch++) {
      const base = ch * this.capacity;
      for (let i = 0; i < n; i++) {
        dst(ch, i, this.data[base + ((tail + i) & this.mask)] ?? 0);
      }
    }
    Atomics.store(this.header, 1, (tail + n) | 0);
    return n;
  }

  skip(frames: number): number {
    const tail = Atomics.load(this.header, 1);
    const n = Math.min(frames, ((Atomics.load(this.header, 0) - tail) | 0));
    if (n <= 0) return 0;
    Atomics.store(this.header, 1, (tail + n) | 0);
    return n;
  }
}

/** Allocate the two SharedArrayBuffers for an audio ring (capacity rounded
 *  up to a power of two). Requires crossOriginIsolated — feature-detect with
 *  `sharedArrayBufferAvailable()` before calling. */
export function createRingSpec(channels: number, capacityFrames: number): RingSpec {
  let cap = 2;
  while (cap < capacityFrames) cap <<= 1;
  return {
    header: new SharedArrayBuffer(8),
    data: new SharedArrayBuffer(channels * cap * 4),
    channels,
    capacity: cap,
  };
}

// ---------------------------------------------------------------------------
// MIDI event ring — the worker's (consumer) half.
// ---------------------------------------------------------------------------

export const MIDI_RECORD_BYTES = 16;
const MIDI_RECORD_WORDS = 4;

export interface MidiRingSpec {
  header: SharedArrayBuffer;
  data: SharedArrayBuffer;
  /** Records; power of two. */
  capacity: number;
}

export class MidiRingIO {
  readonly capacity: number;
  private readonly mask: number;
  private readonly header: Int32Array;
  private readonly words: Int32Array;
  private readonly bytes: Uint8Array;

  constructor(spec: MidiRingSpec) {
    this.capacity = spec.capacity;
    this.mask = spec.capacity - 1;
    this.header = new Int32Array(spec.header);
    this.words = new Int32Array(spec.data);
    this.bytes = new Uint8Array(spec.data);
  }

  get occupancy(): number {
    return (Atomics.load(this.header, 0) - Atomics.load(this.header, 1)) | 0;
  }

  get free(): number {
    return this.capacity - this.occupancy;
  }

  /** Producer: append one event; false = full, event dropped. (The web half
   *  only produces in tests — the worklet is the real producer — but the
   *  mirror keeps both operations so the twin layout tests can drive it.) */
  write(sampleTime: number, d0: number, d1: number, d2: number, len: number): boolean {
    const head = Atomics.load(this.header, 0);
    if (((head - Atomics.load(this.header, 1)) | 0) >= this.capacity) return false;
    const rec = head & this.mask;
    const w = rec * MIDI_RECORD_WORDS;
    this.words[w] = sampleTime % 0x1_0000_0000 | 0;
    this.words[w + 1] = Math.floor(sampleTime / 0x1_0000_0000) | 0;
    const b = rec * MIDI_RECORD_BYTES;
    this.bytes[b + 8] = len & 0xff;
    this.bytes[b + 9] = d0 & 0xff;
    this.bytes[b + 10] = len > 1 ? d1 & 0xff : 0;
    this.bytes[b + 11] = len > 2 ? d2 & 0xff : 0;
    this.bytes[b + 12] = 0;
    this.bytes[b + 13] = 0;
    this.bytes[b + 14] = 0;
    this.bytes[b + 15] = 0;
    Atomics.store(this.header, 0, (head + 1) | 0);
    return true;
  }

  /** Consumer: drain up to `max` events into `dst`. Returns events read. */
  read(
    max: number,
    dst: (sampleTime: number, d0: number, d1: number, d2: number, len: number) => void,
  ): number {
    const tail = Atomics.load(this.header, 1);
    const n = Math.min(max, ((Atomics.load(this.header, 0) - tail) | 0));
    if (n <= 0) return 0;
    for (let i = 0; i < n; i++) {
      const rec = (tail + i) & this.mask;
      const w = rec * MIDI_RECORD_WORDS;
      const lo = (this.words[w] ?? 0) >>> 0;
      const hi = (this.words[w + 1] ?? 0) >>> 0;
      const b = rec * MIDI_RECORD_BYTES;
      dst(
        hi * 0x1_0000_0000 + lo,
        this.bytes[b + 9] ?? 0,
        this.bytes[b + 10] ?? 0,
        this.bytes[b + 11] ?? 0,
        this.bytes[b + 8] ?? 0,
      );
    }
    Atomics.store(this.header, 1, (tail + n) | 0);
    return n;
  }
}

/** Allocate the SharedArrayBuffers for a MIDI ring (capacity rounded up to a
 *  power of two). Same SAB requirement as the audio rings. */
export function createMidiRingSpec(capacityRecords: number): MidiRingSpec {
  let cap = 2;
  while (cap < capacityRecords) cap <<= 1;
  return {
    header: new SharedArrayBuffer(8),
    data: new SharedArrayBuffer(cap * MIDI_RECORD_BYTES),
    capacity: cap,
  };
}

export function sharedArrayBufferAvailable(): boolean {
  return typeof SharedArrayBuffer === 'function' &&
    (typeof crossOriginIsolated === 'undefined' || crossOriginIsolated === true);
}
