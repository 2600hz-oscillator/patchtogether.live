// Pure core for the ES-9 native-bridge worklet: SharedArrayBuffer ring I/O,
// per-jack signal-class scaling, and the underrun policies. Unit-tested here
// (no Web Audio); the worklet in ../es9-bridge.ts is a thin block-mover over
// these primitives.
//
// SIGNAL MODEL (see the native side: patchtogether.es9/docs/DESIGN.md). The
// bridge app moves RAW hardware-full-scale floats — float ±1.0 ≙ ±10 V at the
// ES-9's DC-coupled jacks (the WIRE scale; VOLTS_FULL_SCALE) — and this layer
// converts between hardware volts and patchtogether's signal conventions per
// the user's per-jack CLASS. The app's audio unity is Eurorack NOMINAL: ±1.0 in
// the graph ≙ ±5 V at a DC-coupled jack (NOMINAL_VOLTS), the same scale as cv.
// Before 2026-09-14 audio was ×1 (±1.0 ≙ ±10 V), which landed a ±5 V modular
// signal at −6 dB and +4 dBu line gear at −15 dB under every internal module
// (owner report: "es-9 is really really quiet"); see docs/adr/019.
//
//   class   ref      hw → browser               browser → hw             app convention
//   audio   modular  ×2     (±5 V → ±1)         ×0.5   (±1 → ±5 V)      ±1.0 audio ≙ ±5 V (same scale as cv;
//                                                                         class still selects the underrun
//                                                                         policy and the port type)
//   audio   line     ×5.76  (±1.736 V → ±1)     ×0.174 (±1 → ±1.736 V)  ±1.0 audio ≙ +4 dBu peak (owner,
//                                                                         2026-09-14: "add a toggle on the
//                                                                         card to set it to line per jack";
//                                                                         docs/adr/020)
//   cv      —        ×2     (±5 V → ±1)         ×0.5   (±1 → ±5 V)      cv is bipolar ±1; ref ignored
//   pitch   —        ×10    (1 V/oct → 1.0/oct) ×0.1   (1.0/oct → 1 V)  pitch is 1.0/oct, 0 V ≙ C4; ref ignored
//   gate    —        comparator w/ hysteresis   0/1 → 0 V/+5 V          gate is 0|1, GATE_HI = 0.5; ref ignored
//                    (rise ≥ 2 V, fall < 1 V)
//
// The REFERENCE (REF_MODULAR / REF_LINE) is a second per-jack param that only
// the AUDIO class reads; cv/pitch/gate carry volts and ignore it. Default is
// modular, which reproduces the table's first row exactly (no saved rack moves).
//
// DIGITAL channels are the exception and pass ×1 in both directions, because
// there 0 dBFS really is 1.0: the S/PDIF return (input channels 14/15) and the
// USB 1-8 feeds (output channels 0-7: main/phones/S-PDIF/ES-5 under the ES-9's
// default routing). `rawInSample` / `outSample` carry those jack-kind guards.
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

/** Hardware full scale is ±10 V ≙ float ±1.0 on the WIRE (ES-9 nominal —
 *  the manual's "approximately ±10 V" for 0 dBFS; assumed, not yet metered —
 *  the hardware-verify DC-meter step is the one place it can be pinned). */
export const VOLTS_FULL_SCALE = 10;
/** Eurorack nominal signal level: app ±1.0 ≙ ±5 V at a DC-coupled jack, for
 *  BOTH the audio and the cv class. (The gate-high level below is a separate
 *  convention that merely shares the number — do not fold them together.) */
export const NOMINAL_VOLTS = 5;

/** Per-jack audio REFERENCE (persisted as a discrete module param, 0..1):
 *  which jack voltage the app's ±1.0 means when the class is AUDIO. Owner,
 *  2026-09-14: "can we do eurorack nominal but add a toggle on the card to
 *  set it to line per jack" (docs/adr/020). MIRRORED in
 *  packages/web/src/lib/audio/modules/es9.ts (ES9_REF_*). */
export const REF_MODULAR = 0; // app ±1.0 ≙ ±NOMINAL_VOLTS (±5 V) — the default, today's behaviour
export const REF_LINE = 1;    // app ±1.0 ≙ +4 dBu peak (pro line level)
export type AudioReference = typeof REF_MODULAR | typeof REF_LINE;

/** dBu reference: 0 dBu = 1 mW into 600 Ω = sqrt(0.6) V RMS = 0.774597 V RMS. */
export const DBU_REF_VOLTS_RMS = Math.sqrt(0.6);
/** Pro line nominal is +4 dBu: 0.774597 × 10^(4/20) = 1.22765 V RMS. */
export const LINE_NOMINAL_VOLTS_RMS = DBU_REF_VOLTS_RMS * 10 ** (4 / 20);
/** A sine's peak is RMS × √2: 1.22765 × 1.41421 = 1.73616 V peak. This is the
 *  jack voltage that reads ±1.0 under REF_LINE. (ADR-019 rounded it to
 *  "1.737 V" — one ulp high; the constant here is the derivation, not the
 *  rounding.) Against the ±5 V modular reference that is a
 *  20·log10(5 / 1.73616) = 9.19 dB gap: line in is ×5.76 on the wire, line
 *  out ×0.174 — both DERIVED below from this constant and VOLTS_FULL_SCALE,
 *  never typed. */
export const LINE_NOMINAL_VOLTS_PEAK = LINE_NOMINAL_VOLTS_RMS * Math.SQRT2;

/** The jack voltage app ±1.0 means for the AUDIO class under `ref`. */
function audioReferenceVolts(ref: number): number {
  return ref === REF_LINE ? LINE_NOMINAL_VOLTS_PEAK : NOMINAL_VOLTS;
}

/** Gate comparator hysteresis, in hardware-float units: rise at ≥2 V,
 *  fall below 1 V — solid against slew/noise around a +5 V gate edge. */
export const GATE_RISE = 2 / VOLTS_FULL_SCALE;   // 0.2
export const GATE_FALL = 1 / VOLTS_FULL_SCALE;   // 0.1
/** Browser gate 0|1 emits 0 V / +5 V at the jack (+5 V = 0.5 raw). */
export const GATE_OUT_LEVEL = 5 / VOLTS_FULL_SCALE;

/** Audio-class underrun fade length (frames), mirroring the native bridge. */
export const FADE_FRAMES = 64;

/** hw→browser multiplicative scale for non-gate classes. `ref` is read by the
 *  AUDIO class only (modular ×2, line ×5.76); cv/pitch/gate ignore it. */
export function hwToBrowserScale(cls: number, ref: number = REF_MODULAR): number {
  switch (cls) {
    case CLASS_AUDIO: return VOLTS_FULL_SCALE / audioReferenceVolts(ref); // ±5 V → ±1 (×2) | ±1.736 V → ±1 (×5.76)
    case CLASS_CV: return VOLTS_FULL_SCALE / NOMINAL_VOLTS;              // ±5 V → ±1 (×2)
    case CLASS_PITCH: return VOLTS_FULL_SCALE;                           // 1 V/oct → 1.0/oct
    default: return 1;                                                   // gate: comparator
  }
}

/** browser→hw multiplicative scale for non-gate classes. `ref` is read by the
 *  AUDIO class only (modular ×0.5, line ×0.174); cv/pitch/gate ignore it. */
export function browserToHwScale(cls: number, ref: number = REF_MODULAR): number {
  switch (cls) {
    case CLASS_AUDIO: return audioReferenceVolts(ref) / VOLTS_FULL_SCALE; // ±1 → ±5 V (×0.5) | ±1 → ±1.736 V (×0.174)
    case CLASS_CV: return NOMINAL_VOLTS / VOLTS_FULL_SCALE;              // ±1 → ±5 V (×0.5)
    case CLASS_PITCH: return 1 / VOLTS_FULL_SCALE;                       // 1.0/oct → 1 V/oct
    default: return 1;
  }
}

// ---- jack-kind guards --------------------------------------------------------
// MIRRORS of the channel-map constants in
// packages/web/src/lib/audio/modules/es9.ts (DC_INPUT_JACKS / JACK_CHANNEL_BASE)
// — duplicated on purpose (see the header); the two must agree.

/** ES-9 input channels 0..13 are the DC-coupled jacks; 14/15 are the S/PDIF
 *  return (digital, 0 dBFS = 1.0, no volts to scale). */
export const DC_INPUT_JACKS = 14;
/** First ES-9 OUTPUT channel (0-based) that drives a physical DC-coupled jack
 *  under the default routing (USB 9-16). Channels 0..7 feed the internal
 *  mixer / phones / S-PDIF / ES-5 header — digital, always ×1. */
export const JACK_CHANNEL_BASE = 8;

/** One hw→browser sample for the RAW `in{n}` audio port. DC jacks scale
 *  ±5 V → ±1 (the audio class) or ±1.736 V → ±1 under the jack's line `ref`;
 *  the S/PDIF pair passes ×1 whatever `ref` says (digital, 0 dBFS = 1.0). */
export function rawInSample(ch: number, v: number, ref: number = REF_MODULAR): number {
  return ch < DC_INPUT_JACKS ? v * hwToBrowserScale(CLASS_AUDIO, ref) : v;
}

/** One browser→hw sample for OUTPUT channel `ch`: usb1-8 (channels 0..7) pass
 *  ×1 regardless of class OR reference; the physical jacks (8..15) are
 *  class-scaled, and an audio-class jack reads its `ref`. */
export function outSample(ch: number, cls: number, v: number, ref: number = REF_MODULAR): number {
  return ch < JACK_CHANNEL_BASE ? v : browserToHwSample(cls, v, ref);
}

/** One browser→hw sample. Gate: anything at/above the app's GATE_HI (0.5)
 *  emits +5 V, else 0 V (the reference plays no part). Other classes scale
 *  linearly; only audio reads `ref`. */
export function browserToHwSample(cls: number, v: number, ref: number = REF_MODULAR): number {
  if (cls === CLASS_GATE) return v >= 0.5 ? GATE_OUT_LEVEL : 0;
  return v * browserToHwScale(cls, ref);
}

/**
 * Stateful hw→browser converter for ONE channel. Non-gate classes are a
 * multiply; gate runs the hysteresis comparator (so a wobbly analog gate
 * edge can't double-trigger a downstream edge-detector).
 */
export class InScaler {
  private cls: number = CLASS_AUDIO;
  private ref: number = REF_MODULAR;
  private gateLevel = 0;

  setClass(cls: number): void {
    if (cls !== this.cls) {
      this.cls = cls;
      this.gateLevel = 0;
    }
  }

  /** The jack's audio REFERENCE. Read only when the class is AUDIO; it never
   *  resets the gate comparator, because the gate does not read it. */
  setReference(ref: number): void {
    this.ref = ref;
  }

  get signalClass(): number {
    return this.cls;
  }

  get reference(): number {
    return this.ref;
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
    return v * hwToBrowserScale(this.cls, this.ref);
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

// SharedArrayBuffer SPSC ring — planar Float32 frames, one producer thread,
// one consumer thread, Atomics head/tail. Byte layout (MUST match the web
// mirror in $lib/audio/es9/es9-ring.ts):
//   header: SharedArrayBuffer(8) as Int32Array → [0]=head, [1]=tail, both
//           monotonically increasing frame counters (int32 two's-complement
//           wrap; occupancy = (head - tail) | 0, valid while < 2^31).
//   data:   SharedArrayBuffer(channels * capacity * 4) as Float32Array,
//           plane-per-channel: sample(ch, i) = data[ch * capacity + i],
//           i = counter & (capacity - 1). capacity is a power of two.

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
