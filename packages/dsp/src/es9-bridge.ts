// packages/dsp/src/es9-bridge.ts
//
// ES-9 — AudioWorklet half of the native-bridge module. Moves 128-frame
// quanta between the Web Audio graph and two SharedArrayBuffer rings that
// the bridge Worker (web-side, owns the ws://127.0.0.1 socket to the
// es9-bridge native app) fills/drains. Everything stays OFF the main thread:
// a canvas-drag stall can never glitch the hardware stream
// (.myrobots/plans/clock-drag-jank-analysis-2026-06-29.md is why).
//
//   inRing  (worker writes ← WebSocket)  → this worklet → 32 outputs
//   16 inputs → this worklet → outRing   (worker drains → WebSocket)
//
// I/O map (one mono worklet index per jack, attenumix-style):
//   inputs  0..7  = OUT 1..8 jacks (browser → ES-9 DC-coupled outs)
//   inputs  8..15 = MIX 9..16 (browser → ES-9 USB outs 9-16, internal mixer)
//   outputs 0..13 = IN 1..14 raw audio (ES-9 DC-coupled inputs, ±1 = ±10 V)
//   outputs 14/15 = S/PDIF L/R raw audio (ES-9 USB inputs 15/16)
//   outputs 16..29 = IN 1..14 class-scaled CV twins (cv/pitch/gate per the
//                    per-jack class param; see lib/es9-bridge-core.ts)
//   outputs 30/31 = reserved (silent) — keeps the cv-twin index math
//                   uniform (16 + n) without a sparse output map.
//
// Config arrives via port messages on EDIT (rings adopt/detach, per-jack
// classes) — never per block. Underrun policy mirrors the native bridge:
// audio-class fades over 64 frames, CV-ish classes hold the last value.
//
// NOT top-level-exported by design (a worklet entry must not leak into the
// esbuild ESM bundle / break ART's classic-script eval — see seq-clock.ts).

import {
  CLASS_AUDIO,
  CLASS_CV,
  InScaler,
  RingIO,
  UnderrunFiller,
  browserToHwSample,
  type RingSpec,
} from './lib/es9-bridge-core';

declare class AudioWorkletProcessor {
  port: MessagePort;
  constructor(options?: { processorOptions?: unknown });
  process?(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}
declare function registerProcessor(
  name: string,
  ctor: typeof AudioWorkletProcessor,
): void;

// Shim the worklet globals when running outside AudioWorkletGlobalScope
// (vitest). Guarded so the real runtime is untouched.
const G = globalThis as unknown as {
  AudioWorkletProcessor?: unknown;
  registerProcessor?: unknown;
};
if (typeof G.AudioWorkletProcessor === 'undefined') {
  G.AudioWorkletProcessor = class {
    port = { onmessage: null, postMessage() {} } as unknown as MessagePort;
  };
}
if (typeof G.registerProcessor === 'undefined') {
  G.registerProcessor = () => {};
}

const HW_CHANNELS = 16;
const CV_TWIN_BASE = 16;
/** Steady-state depth we let the incoming jitter buffer re-center to. */
const IN_TARGET_FRAMES = 512;
/** Occupancy past which we slip (skip) back down to the target. */
const IN_SLIP_LIMIT = 4096;

interface RingsMessage {
  type: 'rings';
  in: RingSpec;
  out: RingSpec;
}
interface ClassesMessage {
  type: 'classes';
  /** Per ES-9 INPUT channel (16 entries; 14/15 = S/PDIF, class ignored). */
  inClasses: number[];
  /** Per ES-9 OUTPUT channel (16 entries; 8..15 = mix, class ignored). */
  outClasses: number[];
}
interface DetachMessage {
  type: 'detach';
}
type Msg = RingsMessage | ClassesMessage | DetachMessage;

class Es9BridgeProcessor extends AudioWorkletProcessor {
  private inRing: RingIO | null = null;    // hardware → graph
  private outRing: RingIO | null = null;   // graph → hardware
  private inClasses: number[] = new Array(HW_CHANNELS).fill(CLASS_CV);
  private outClasses: number[] = new Array(HW_CHANNELS).fill(CLASS_AUDIO);
  private scalers = Array.from({ length: HW_CHANNELS }, () => new InScaler());
  private rawFill = Array.from({ length: HW_CHANNELS }, () => new UnderrunFiller());
  private cvFill = Array.from({ length: HW_CHANNELS }, () => new UnderrunFiller());

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent) => {
      const m = e.data as Msg;
      if (!m || typeof m !== 'object') return;
      if (m.type === 'rings') {
        this.inRing = new RingIO(m.in);
        this.outRing = new RingIO(m.out);
      } else if (m.type === 'detach') {
        this.inRing = null;
        this.outRing = null;
      } else if (m.type === 'classes') {
        if (Array.isArray(m.inClasses)) {
          for (let c = 0; c < HW_CHANNELS; c++) {
            const cls = m.inClasses[c] ?? CLASS_CV;
            this.inClasses[c] = cls;
            this.scalers[c]?.setClass(cls);
          }
        }
        if (Array.isArray(m.outClasses)) {
          for (let c = 0; c < HW_CHANNELS; c++) {
            this.outClasses[c] = m.outClasses[c] ?? CLASS_AUDIO;
          }
        }
      }
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const frames = outputs[0]?.[0]?.length ?? 128;

    // ---- hardware → graph -------------------------------------------------
    if (this.inRing) {
      // Slip back to target if the buffer ran away (tab jank burst).
      if (this.inRing.occupancy > IN_SLIP_LIMIT) {
        this.inRing.skip(this.inRing.occupancy - IN_TARGET_FRAMES);
      }
      const got = this.inRing.read(frames, (ch, i, v) => {
        const raw = outputs[ch]?.[0];
        if (raw) {
          raw[i] = v;
          this.rawFill[ch]?.feed(v);
        }
        const twin = outputs[CV_TWIN_BASE + ch]?.[0];
        if (twin && ch < 14) {
          const scaled = this.scalers[ch]?.process(v) ?? v;
          twin[i] = scaled;
          this.cvFill[ch]?.feed(scaled);
        }
      });
      if (got < frames) {
        for (let ch = 0; ch < HW_CHANNELS; ch++) {
          const raw = outputs[ch]?.[0];
          const twin = outputs[CV_TWIN_BASE + ch]?.[0];
          const cls = this.inClasses[ch] ?? CLASS_CV;
          for (let i = got; i < frames; i++) {
            // Raw jack: audio semantics (fade) — it is the audio port.
            if (raw) raw[i] = this.rawFill[ch]?.fill(CLASS_AUDIO) ?? 0;
            // CV twin: the jack's class decides fade-vs-hold.
            if (twin && ch < 14) twin[i] = this.cvFill[ch]?.fill(cls) ?? 0;
          }
        }
      }
    }
    // No ring: outputs stay at the zeros the UA pre-fills.

    // ---- graph → hardware -------------------------------------------------
    if (this.outRing && this.outRing.free >= frames) {
      this.outRing.write(frames, (ch, i) => {
        const src = inputs[ch]?.[0];
        if (!src) return 0;
        return browserToHwSample(this.outClasses[ch] ?? CLASS_AUDIO, src[i] ?? 0);
      });
    }
    // Ring full (worker gone / not draining): drop the block — the native
    // bridge's own underrun policy handles the far side.

    return true;
  }
}

registerProcessor('es9-bridge', Es9BridgeProcessor);
