// packages/web/src/lib/audio/es9/es9-ring.ts
//
// Web-side MIRROR of the SharedArrayBuffer SPSC ring in
// packages/dsp/src/lib/es9-bridge-core.ts — the bridge Worker's half (the
// worklet's half ships inside the built dsp bundle). Duplicated on purpose:
// packages/web only consumes packages/dsp's BUILT dist artifacts, and the
// repo convention is duplicated constants over cross-package source imports
// (multiplayer/provider.ts documents the same choice for rejection codes).
//
// LAYOUT CONTRACT (must match the dsp core byte-for-byte):
//   header: SharedArrayBuffer(8) as Int32Array → [0]=head, [1]=tail,
//           monotonically increasing frame counters (int32 wrap;
//           occupancy = (head - tail) | 0).
//   data:   SharedArrayBuffer(channels * capacity * 4) as Float32Array,
//           plane-per-channel: sample(ch, i) = data[ch * capacity + i],
//           i = counter & (capacity - 1). capacity is a power of two.
// A unit test pins this mirror against the same sequences the dsp-side test
// pins, so drift fails fast.

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

/** Allocate the two SharedArrayBuffers for a ring (capacity rounded up to a
 *  power of two). Requires crossOriginIsolated — feature-detect with
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

export function sharedArrayBufferAvailable(): boolean {
  return typeof SharedArrayBuffer === 'function' &&
    (typeof crossOriginIsolated === 'undefined' || crossOriginIsolated === true);
}
