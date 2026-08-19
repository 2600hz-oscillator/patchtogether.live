// packages/dsp/src/vst-bridge.ts
//
// VST BRIDGE — AudioWorklet half, shared by BOTH cards (vstInstrument +
// vstFx). Moves 128-frame quanta between the Web Audio graph and three
// SharedArrayBuffer rings that the bridge Worker (web-side, owns the
// ws://127.0.0.1:9309 socket to the vst-bridge native helper) drains/fills,
// and runs the poly-CV → MIDI conversion PER SAMPLE — the fidelity upgrade
// over the analyser-polling midiOutBuddy path. Everything stays off the
// main thread.
//
//   inRing   (worker writes ← WS 0x01)  → this worklet → outputs 0/1
//   inputs 0..5 → this worklet → outRing (worker → WS 0x01 planes/clock)
//                              → midiRing (worker → WS 0x02)
//
// I/O map (one worklet index per port; both cards use the same processor,
// each card only patches its own def's ports):
//   inputs  0/1 = in_l / in_r   (vstFx: plugin audio input)
//   input   2   = poly          (vstInstrument: 32-ch polyPitchGate —
//                                ch 2i = lane i pitch V/oct, ch 2i+1 = gate)
//   input   3   = pitch         (mono V/oct fallback)
//   input   4   = gate          (mono gate fallback / the clip lane's
//                                gate{n}, also patched in poly mode — poly
//                                wins whenever the poly cable is present)
//   input   5   = vel           (mono velocity cv 0..1; UNPATCHED ⇒ the
//                                DEFAULT_VELOCITY rule — detected as an
//                                empty channel array, which is why this
//                                worklet is pinned via a zero-gain tap
//                                rather than a silence fan-in)
//   outputs 0/1 = out_l / out_r (plugin audio return)
//
// ORDERING CONTRACT (plan §5c): each quantum writes the MIDI ring BEFORE
// the audio ring; the worker drains MIDI before audio each tick. MIDI
// events are stamped with THIS worklet's outgoing-frame counter — the same
// counter the worker's audio-block sampleTimes advance through the ring —
// so the bridge places each event at the exact sample its gate crossed.
// (A drain-tick interleave can still land an event one tick late; the
// bridge clamps late events to offset 0 of its next block — bounded, and
// stated in the wire spec.)
//
// LIVE vs LOCAL BYPASS: while the transport is CONNECTED the bridge is the
// audio path even when nothing is mounted (bit-transparent bypass server-
// side). When NOT connected, an fx card must not mute its lane: 'live'
// false switches to a LOCAL input→output bypass (instrument mode: silence).
//
// NOT top-level-exported by design (a worklet entry must not leak into the
// esbuild ESM bundle / break ART's classic-script eval — see seq-clock.ts).

import {
  MidiRingIO,
  PolyMidiVoice,
  RingIO,
  UnderrunFiller,
  type MidiRingSpec,
  type RingSpec,
} from './lib/vst-bridge-core';

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

const IN_L = 0;
const IN_R = 1;
const POLY = 2;
const PITCH = 3;
const GATE = 4;
const VEL = 5;
const POLY_PAIRS = 16;

/** Steady-state depth the incoming jitter buffer re-centers to (es9 value). */
const IN_TARGET_FRAMES = 512;
/** Occupancy past which we slip (skip) back down to the target. */
const IN_SLIP_LIMIT = 4096;

interface RingsMessage {
  type: 'rings';
  in: RingSpec;
  out: RingSpec;
  midi: MidiRingSpec;
  /** 'fx' bypasses input→output when not live; 'instrument' goes silent. */
  mode: 'fx' | 'instrument';
}
interface LiveMessage {
  type: 'live';
  live: boolean;
}
interface DetachMessage {
  type: 'detach';
}
type Msg = RingsMessage | LiveMessage | DetachMessage;

class VstBridgeProcessor extends AudioWorkletProcessor {
  private inRing: RingIO | null = null;    // bridge → graph
  private outRing: RingIO | null = null;   // graph → bridge
  private midiRing: MidiRingIO | null = null;
  private mode: 'fx' | 'instrument' = 'fx';
  private live = false;
  /** Frames written to the OUT ring since ring adoption — the sampleTime
   *  domain of the outgoing audio blocks AND of every MIDI stamp. */
  private outSampleTime = 0;
  private voices = Array.from({ length: POLY_PAIRS }, () => new PolyMidiVoice());
  private monoVoice = new PolyMidiVoice();
  private fill = [new UnderrunFiller(), new UnderrunFiller()];

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent) => {
      const m = e.data as Msg;
      if (!m || typeof m !== 'object') return;
      if (m.type === 'rings') {
        this.inRing = new RingIO(m.in);
        this.outRing = new RingIO(m.out);
        this.midiRing = new MidiRingIO(m.midi);
        this.mode = m.mode;
        this.outSampleTime = 0;
      } else if (m.type === 'live') {
        if (this.live && !m.live) this.flushVoices();
        this.live = m.live;
      } else if (m.type === 'detach') {
        this.flushVoices();
        this.inRing = null;
        this.outRing = null;
        this.midiRing = null;
      }
    };
  }

  /** NoteOff anything sounding so no stuck note survives a detach or a
   *  transport drop (the bridge also silences parked instances — belt and
   *  suspenders, and it keeps the voice machines consistent). */
  private flushVoices(): void {
    const ring = this.midiRing;
    const emit = ring
      ? (t: number, d0: number, d1: number, d2: number, len: number) => {
          ring.write(t, d0, d1, d2, len);
        }
      : () => {};
    for (const v of this.voices) v.flush(this.outSampleTime, emit);
    this.monoVoice.flush(this.outSampleTime, emit);
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const outL = outputs[0]?.[0];
    const outR = outputs[1]?.[0];
    const frames = outL?.length ?? 128;
    // MONO NORMAL (fx path): a mono patch into IN L must not leave the
    // plugin's right input — and therefore OUT R — at digital silence.
    // The right channel falls back to the left when unpatched, in BOTH the
    // ring write and the local bypass (mono-normal-not-defeated gate).
    const inL = inputs[IN_L]?.[0];
    const inR = inputs[IN_R]?.[0] ?? inL;

    // ---- 1. poly/mono CV → MIDI (BEFORE the audio ring write — §5c) -------
    if (this.midiRing) {
      const ring = this.midiRing;
      const emit = (t: number, d0: number, d1: number, d2: number, len: number) => {
        ring.write(t, d0, d1, d2, len);
      };
      const poly = inputs[POLY];
      const vel = inputs[VEL]?.[0]; // empty array when unpatched → undefined
      const base = this.outSampleTime;
      if (poly && poly.length >= 2) {
        const pairs = Math.min(POLY_PAIRS, poly.length >> 1);
        for (let s = 0; s < frames; s++) {
          const velCv = vel ? (vel[s] ?? 0) : Number.NaN;
          for (let i = 0; i < pairs; i++) {
            this.voices[i]!.process(
              poly[2 * i]?.[s] ?? 0,
              poly[2 * i + 1]?.[s] ?? 0,
              velCv,
              base + s,
              emit,
            );
          }
        }
      } else {
        // Mono fallback: gate (+ optional pitch) hand-patched, no poly cable.
        const gate = inputs[GATE]?.[0];
        const pitch = inputs[PITCH]?.[0];
        if (gate) {
          for (let s = 0; s < frames; s++) {
            this.monoVoice.process(
              pitch?.[s] ?? 0,
              gate[s] ?? 0,
              vel ? (vel[s] ?? 0) : Number.NaN,
              base + s,
              emit,
            );
          }
        }
      }
    }

    // ---- 2. graph → bridge (audio-out ring; the frame clock) --------------
    if (this.outRing && this.outRing.free >= frames) {
      this.outRing.write(frames, (ch, i) =>
        ch === 0 ? (inL?.[i] ?? 0) : (inR?.[i] ?? 0),
      );
      this.outSampleTime += frames;
    }
    // Ring full (worker gone / not draining): drop the block and do NOT
    // advance the counter — the counter tracks frames the worker can see.

    // ---- 3. bridge → graph (audio-in ring with slip + underrun fade) ------
    if (this.live && this.inRing) {
      if (this.inRing.occupancy > IN_SLIP_LIMIT) {
        this.inRing.skip(this.inRing.occupancy - IN_TARGET_FRAMES);
      }
      const got = this.inRing.read(frames, (ch, i, v) => {
        const dst = ch === 0 ? outL : outR;
        if (dst) {
          dst[i] = v;
          this.fill[ch]?.feed(v);
        }
      });
      if (got < frames) {
        for (let i = got; i < frames; i++) {
          if (outL) outL[i] = this.fill[0]?.fill(0) ?? 0; // 0 = CLASS_AUDIO fade
          if (outR) outR[i] = this.fill[1]?.fill(0) ?? 0;
        }
      }
    } else if (this.mode === 'fx') {
      // LOCAL bypass: transport down must not mute the lane.
      for (let i = 0; i < frames; i++) {
        if (outL) outL[i] = inL?.[i] ?? 0;
        if (outR) outR[i] = inR?.[i] ?? 0;
      }
    }
    // instrument + not live: outputs stay at the zeros the UA pre-fills.

    return true;
  }
}

registerProcessor('vst-bridge', VstBridgeProcessor);
