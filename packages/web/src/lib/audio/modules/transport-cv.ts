// packages/web/src/lib/audio/modules/transport-cv.ts
//
// Engine-side wiring for the shared transport CV inputs (play_cv, reset_cv,
// queue1_cv..queue4_cv). Each input is a GainNode → AnalyserNode tap that
// the host module's tick() polls each iteration to scan for rising edges.
//
// The host module owns its tick loop; this helper just gives it a uniform
// way to:
//   - create the 6 CV input nodes (matching the engine's input-port shape)
//   - drain the analysers each tick and return what events fired
//
// The host then dispatches:
//   - PLAY edge   → toggle livePatch.nodes[id].params.isPlaying
//   - RESET edge  → reset its own stepIndex / tickIndex
//   - QUEUE-N edge → write livePatch.nodes[id].data.queuedSlot = N
//
// We don't centralize the dispatch because each module's "stepIndex reset"
// looks slightly different (sequencer + drumseqz use stepIndex, score uses
// tickIndex / nextStepTime).

import { createRisingEdgeDetector, type RisingEdgeDetector, type SlotKey } from './transport-helpers';

export interface TransportCvNodes {
  /** Map of input-port id → { node, input, param? } shape that the engine
   *  expects from `AudioDomainNodeHandle.inputs`. Includes all 6 ports. */
  inputs: Map<string, { node: AudioNode; input: number }>;
  /** Drain all 6 analysers and return how many rising edges fired since
   *  the last call. Updates internal state to track cross-tick last-sample. */
  drain(elapsedSec: number): TransportCvEvents;
  /** Disconnect + free the underlying nodes. */
  dispose(): void;
  /** Reset all per-port edge detectors (e.g. on PLAY transition). */
  resetEdges(): void;
}

export interface TransportCvEvents {
  play: number;   // # of rising edges since last drain
  reset: number;
  queue1: number;
  queue2: number;
  queue3: number;
  queue4: number;
  // feat/seq 8-slots — present only when createTransportCv was opened with
  // { extended: true } (Sequencer + MACSEQ). 0 otherwise.
  queue5: number;
  queue6: number;
  queue7: number;
  queue8: number;
  // feat/seq quantized nav gates — also extended-only.
  next: number;
  prev: number;
  random: number;
}

// The base 6 ports every sequencer-style module declares via
// TRANSPORT_CV_PORT_DEFS. Sequencer + MACSEQ ALSO opt into the extended set
// (queue5..8 + next/prev/random) — see EXTENDED_PORT_IDS.
const BASE_PORT_IDS = ['play_cv', 'reset_cv', 'queue1_cv', 'queue2_cv', 'queue3_cv', 'queue4_cv'] as const;
const EXTENDED_PORT_IDS = [
  'queue5_cv', 'queue6_cv', 'queue7_cv', 'queue8_cv',
  'next_cv', 'prev_cv', 'random_cv',
] as const;

interface PortEntry {
  gain: GainNode;
  analyser: AnalyserNode;
  // Tightly-typed Float32Array<ArrayBuffer> so AnalyserNode#getFloatTimeDomainData
  // accepts it under the recent TS lib defs (which made Float32Array generic
  // over ArrayBuffer | SharedArrayBuffer; the WebAudio API only accepts the
  // ArrayBuffer arm).
  buf: Float32Array<ArrayBuffer>;
  silence: ConstantSourceNode;
  detector: RisingEdgeDetector;
  lastSampleTime: number;
}

export interface TransportCvOptions {
  /** Include the extended ports (queue5..8_cv + next/prev/random_cv).
   *  Default false — only Sequencer + MACSEQ opt in. The other consumers
   *  (DRUMSEQZ / SCORE / POLYSEQZ) keep the
   *  legacy 6-port shape untouched. */
  extended?: boolean;
}

export function createTransportCv(ctx: AudioContext, opts: TransportCvOptions = {}): TransportCvNodes {
  const ports = new Map<string, PortEntry>();
  const portIds = opts.extended ? [...BASE_PORT_IDS, ...EXTENDED_PORT_IDS] : BASE_PORT_IDS;

  for (const id of portIds) {
    const gain = ctx.createGain();
    const analyser = ctx.createAnalyser();
    // 2048 samples ≈ 46 ms at 44.1 kHz — must comfortably exceed TICK_MS (25 ms).
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0;
    gain.connect(analyser);
    // Silence keeps the gain + analyser in the active graph even when nothing
    // is patched in (same trick the existing clock-in uses).
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    silence.connect(gain);
    ports.set(id, {
      gain,
      analyser,
      buf: new Float32Array(2048),
      silence,
      detector: createRisingEdgeDetector(0.5),
      lastSampleTime: ctx.currentTime,
    });
  }

  function drainOne(id: string, elapsedSec: number): number {
    const p = ports.get(id);
    if (!p) return 0;
    p.analyser.getFloatTimeDomainData(p.buf);
    const newSamples = Math.min(
      p.buf.length,
      Math.max(1, Math.ceil(elapsedSec * ctx.sampleRate)),
    );
    const start = p.buf.length - newSamples;
    return p.detector.scan(p.buf, start, p.buf.length);
  }

  return {
    inputs: new Map(
      Array.from(ports.entries()).map(([id, p]) => [
        id,
        { node: p.gain as AudioNode, input: 0 },
      ]),
    ),
    drain(elapsedSec) {
      // drainOne returns 0 for ports that don't exist (non-extended), so the
      // extended fields are safe to always read.
      return {
        play: drainOne('play_cv', elapsedSec),
        reset: drainOne('reset_cv', elapsedSec),
        queue1: drainOne('queue1_cv', elapsedSec),
        queue2: drainOne('queue2_cv', elapsedSec),
        queue3: drainOne('queue3_cv', elapsedSec),
        queue4: drainOne('queue4_cv', elapsedSec),
        queue5: drainOne('queue5_cv', elapsedSec),
        queue6: drainOne('queue6_cv', elapsedSec),
        queue7: drainOne('queue7_cv', elapsedSec),
        queue8: drainOne('queue8_cv', elapsedSec),
        next: drainOne('next_cv', elapsedSec),
        prev: drainOne('prev_cv', elapsedSec),
        random: drainOne('random_cv', elapsedSec),
      };
    },
    resetEdges() {
      for (const p of ports.values()) p.detector.reset();
    },
    dispose() {
      for (const p of ports.values()) {
        try { p.silence.stop(); } catch { /* already stopped */ }
        p.silence.disconnect();
        p.gain.disconnect();
        p.analyser.disconnect();
      }
      ports.clear();
    },
  };
}

/** Decode the queue events into the slot key that fired most recently
 *  (highest-numbered if multiple fired in one drain — rare in practice).
 *  Handles queue1..8 (5..8 are 0 / absent on non-extended instances). */
export function pickQueuedSlotFromEvents(ev: TransportCvEvents): SlotKey | null {
  if (ev.queue8 > 0) return '8';
  if (ev.queue7 > 0) return '7';
  if (ev.queue6 > 0) return '6';
  if (ev.queue5 > 0) return '5';
  if (ev.queue4 > 0) return '4';
  if (ev.queue3 > 0) return '3';
  if (ev.queue2 > 0) return '2';
  if (ev.queue1 > 0) return '1';
  return null;
}

/** Decode the NEXT / PREV / RANDOM nav gate events into a NavDirection (or
 *  null if none fired). Highest-priority order: random > prev > next — rare
 *  to fire >1 in a single drain. Returns null on non-extended instances
 *  (those fields are always 0). */
export function pickNavFromEvents(ev: TransportCvEvents): 'next' | 'prev' | 'random' | null {
  if (ev.random > 0) return 'random';
  if (ev.prev > 0) return 'prev';
  if (ev.next > 0) return 'next';
  return null;
}

/** The 6 input-port descriptors module defs need to declare (shared by all
 *  sequencer-style modules). LITERAL ARRAY — the module-manifest static
 *  extractor inlines this spread; keep it a flat array of object literals. */
export const TRANSPORT_CV_PORT_DEFS = [
  { id: 'play_cv',   type: 'gate' as const },
  { id: 'reset_cv',  type: 'gate' as const },
  { id: 'queue1_cv', type: 'gate' as const },
  { id: 'queue2_cv', type: 'gate' as const },
  { id: 'queue3_cv', type: 'gate' as const },
  { id: 'queue4_cv', type: 'gate' as const },
];

/** The EXTENDED transport CV ports — queue5..8 + NEXT/PREV/RANDOM nav gates.
 *  Spread INTO a def's inputs AFTER TRANSPORT_CV_PORT_DEFS by modules that
 *  opt into 8 slots + quantized nav (Sequencer + MACSEQ). LITERAL ARRAY for
 *  the manifest extractor — see note on TRANSPORT_CV_PORT_DEFS. The
 *  manifest parser inlines both spreads (module-manifest.ts parsePortList). */
export const EXTENDED_TRANSPORT_CV_PORT_DEFS = [
  { id: 'queue5_cv', type: 'gate' as const },
  { id: 'queue6_cv', type: 'gate' as const },
  { id: 'queue7_cv', type: 'gate' as const },
  { id: 'queue8_cv', type: 'gate' as const },
  { id: 'next_cv',   type: 'gate' as const },
  { id: 'prev_cv',   type: 'gate' as const },
  { id: 'random_cv', type: 'gate' as const },
];
