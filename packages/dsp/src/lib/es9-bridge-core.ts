// packages/dsp/src/lib/es9-bridge-core.ts
//
// Pure core for the ES-9 native-bridge worklet: SharedArrayBuffer ring I/O,
// per-jack signal-class scaling, and the underrun policies. Unit-tested here
// (no Web Audio); the worklet in ../es9-bridge.ts is a thin block-mover over
// these primitives.
//
// SIGNAL MODEL (see the native side: patchtogether.es9/docs/DESIGN.md). The
// bridge app moves RAW hardware-full-scale floats — float ±1.0 ≙ ±10 V at the
// ES-9's DC-coupled jacks — and this layer converts between hardware volts
// and patchtogether's signal conventions per the user's per-jack CLASS:
//
//   class   hw → browser              browser → hw           app convention
//   audio   ×1 (raw)                  ×1 (raw)               full-scale audio
//   cv      ×2   (±5 V → ±1)          ×0.5  (±1 → ±5 V)      cv is bipolar ±1
//   pitch   ×10  (1 V/oct → 1.0/oct)  ×0.1  (1.0/oct → 1 V)  pitch is 1.0/oct, 0 V ≙ C4
//   gate    comparator w/ hysteresis  0/1 → 0 V/+5 V         gate is 0|1, GATE_HI = 0.5
//           (rise ≥ 2 V, fall < 1 V)
//
// The mirror-image ring implementation lives web-side in
// $lib/audio/es9/es9-ring.ts (the bridge Worker's half). They are duplicated
// on purpose — packages/web only consumes packages/dsp's BUILT dist bundles,
// and the repo convention is duplicated constants over cross-package source
// imports (see multiplayer/provider.ts's rejection-code note). The layouts
// must match byte-for-byte; both files carry this warning.

/** Per-jack signal class (persisted as a discrete module param, 0..3). */
export const CLASS_AUDIO = 0;
export const CLASS_CV = 1;
export const CLASS_PITCH = 2;
export const CLASS_GATE = 3;
export type SignalClass =
  | typeof CLASS_AUDIO
  | typeof CLASS_CV
  | typeof CLASS_PITCH
  | typeof CLASS_GATE;

/** Hardware full scale is ±10 V ≙ float ±1.0 (ES-9 nominal). */
export const VOLTS_FULL_SCALE = 10;

/** Gate comparator hysteresis, in hardware-float units: rise at ≥2 V,
 *  fall below 1 V — solid against slew/noise around a +5 V gate edge. */
export const GATE_RISE = 2 / VOLTS_FULL_SCALE;   // 0.2
export const GATE_FALL = 1 / VOLTS_FULL_SCALE;   // 0.1
/** Browser gate 0|1 emits 0 V / +5 V at the jack (+5 V = 0.5 raw). */
export const GATE_OUT_LEVEL = 5 / VOLTS_FULL_SCALE;

/** Audio-class underrun fade length (frames), mirroring the native bridge. */
export const FADE_FRAMES = 64;

/** hw→browser multiplicative scale for non-gate classes. */
export function hwToBrowserScale(cls: number): number {
  switch (cls) {
    case CLASS_CV: return VOLTS_FULL_SCALE / 5;    // ±5 V → ±1
    case CLASS_PITCH: return VOLTS_FULL_SCALE;     // 1 V/oct → 1.0/oct
    default: return 1;                             // audio raw (gate: comparator)
  }
}

/** browser→hw multiplicative scale for non-gate classes. */
export function browserToHwScale(cls: number): number {
  switch (cls) {
    case CLASS_CV: return 5 / VOLTS_FULL_SCALE;    // ±1 → ±5 V
    case CLASS_PITCH: return 1 / VOLTS_FULL_SCALE; // 1.0/oct → 1 V/oct
    default: return 1;
  }
}

/** One browser→hw sample. Gate: anything at/above the app's GATE_HI (0.5)
 *  emits +5 V, else 0 V. Other classes scale linearly. */
export function browserToHwSample(cls: number, v: number): number {
  if (cls === CLASS_GATE) return v >= 0.5 ? GATE_OUT_LEVEL : 0;
  return v * browserToHwScale(cls);
}

/**
 * Stateful hw→browser converter for ONE channel. Non-gate classes are a
 * multiply; gate runs the hysteresis comparator (so a wobbly analog gate
 * edge can't double-trigger a downstream edge-detector).
 */
export class InScaler {
  private cls: number = CLASS_AUDIO;
  private gateLevel = 0;

  setClass(cls: number): void {
    if (cls !== this.cls) {
      this.cls = cls;
      this.gateLevel = 0;
    }
  }

  get signalClass(): number {
    return this.cls;
  }

  process(v: number): number {
    if (this.cls === CLASS_GATE) {
      if (this.gateLevel === 0) {
        if (v >= GATE_RISE) this.gateLevel = 1;
      } else if (v < GATE_FALL) {
        this.gateLevel = 0;
      }
      return this.gateLevel;
    }
    return v * hwToBrowserScale(this.cls);
  }
}

/**
 * Per-channel underrun policy for the hw→browser stream, mirroring the
 * native bridge's output policy: audio fades to 0 over FADE_FRAMES (carried
 * across process() calls), everything CV-ish (cv / pitch / gate) HOLDS the
 * last value — a modulation source snapping to 0 on a network hiccup would
 * yank every patched parameter.
 */
export class UnderrunFiller {
  private last = 0;
  private fadeStep = 0;
  private fadeRemaining = 0;

  /** Note a real (post-scale) sample was emitted. */
  feed(v: number): void {
    this.last = v;
    this.fadeStep = 0;
    this.fadeRemaining = 0;
  }

  /** Produce one fill sample while starved. */
  fill(cls: number): number {
    if (cls === CLASS_AUDIO) {
      // Count-based fade: exactly FADE_FRAMES samples, last one snapped to
      // a true 0 (an incremental `last -= step` leaves float residue).
      if (this.fadeRemaining === 0 && this.fadeStep === 0 && this.last !== 0) {
        this.fadeStep = this.last / FADE_FRAMES;
        this.fadeRemaining = FADE_FRAMES;
      }
      if (this.fadeRemaining > 0) {
        this.fadeRemaining--;
        this.last = this.fadeRemaining === 0 ? 0 : this.last - this.fadeStep;
      } else {
        this.last = 0;
      }
      return this.last;
    }
    return this.last; // cv / pitch / gate: hold
  }
}

// ---------------------------------------------------------------------------
// SharedArrayBuffer SPSC ring — planar Float32 frames, one producer thread,
// one consumer thread, Atomics head/tail. Byte layout (MUST match the web
// mirror in $lib/audio/es9/es9-ring.ts):
//   header: SharedArrayBuffer(8) as Int32Array → [0]=head, [1]=tail, both
//           monotonically increasing frame counters (int32 two's-complement
//           wrap; occupancy = (head - tail) | 0, valid while < 2^31).
//   data:   SharedArrayBuffer(channels * capacity * 4) as Float32Array,
//           plane-per-channel: sample(ch, i) = data[ch * capacity + i],
//           i = counter & (capacity - 1). capacity is a power of two.
// ---------------------------------------------------------------------------

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

  /** Producer: append up to `frames` frames, sourcing each sample from
   *  `src(ch, frame)`. Returns frames written (short when full). */
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

  /** Consumer: read up to `frames` frames into `dst(ch, frame, value)`.
   *  Returns frames read (short on underrun). */
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

  /** Consumer: discard up to `frames` frames (jitter-buffer re-centering). */
  skip(frames: number): number {
    const tail = Atomics.load(this.header, 1);
    const n = Math.min(frames, ((Atomics.load(this.header, 0) - tail) | 0));
    if (n <= 0) return 0;
    Atomics.store(this.header, 1, (tail + n) | 0);
    return n;
  }
}

/** Allocate the two SharedArrayBuffers for a ring. Rounds capacity up to a
 *  power of two. Throws where SAB is unavailable (non-crossOriginIsolated) —
 *  callers feature-detect first. */
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
