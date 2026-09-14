// Behavioral test for the ES-9 BRIDGE WORKLET (../es9-bridge.ts) — the block
// mover the es9 module actually ships — captured through the registerProcessor
// shim (the mandelbulb-osc.test.ts / cube.test.ts pattern) and driven with
// REAL SharedArrayBuffer rings. es9-bridge-core.test.ts pins the scale
// FUNCTIONS; this file pins that the worklet APPLIES them on the right
// channels: which output index gets the audio-scaled sample, which gets the
// class-scaled twin, which input channel is a jack and which is a USB feed.
//
// THE LEVEL CONTRACT under test (ADR-019, owner report 2026-09-14 "es-9 is
// really really quiet"): a ±5 V modular signal is 0.5 on the wire (the wire
// is ±1.0 ≙ ±10 V) and must read ±1.0 at the raw `in{n}` port — the same
// unity every internal module uses. Before the fix it read 0.5 (−6 dB), so
// the first test here is the one that FAILS on the old constant.

import { beforeAll, describe, expect, it } from 'vitest';
import {
  CLASS_AUDIO,
  CLASS_CV,
  CLASS_GATE,
  CLASS_PITCH,
  FADE_FRAMES,
  GATE_OUT_LEVEL,
  RingIO,
  createRingSpec,
  type RingSpec,
} from './es9-bridge-core';

const SR = 48000;
const BLOCK = 128;
const HW = 16;
const CV_TWIN_BASE = 16;
const N_OUT = 32;

beforeAll(() => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
});

type Msg = { data: unknown };
type ProcInstance = {
  process: (i: Float32Array[][], o: Float32Array[][], p: Record<string, Float32Array>) => boolean;
  port: { onmessage: ((e: Msg) => void) | null; postMessage: (m: unknown) => void };
};
type ProcCtor = new () => ProcInstance;
let captured: ProcCtor | null = null;
async function loadProcessor(): Promise<ProcCtor> {
  if (captured) return captured;
  const g = globalThis as unknown as { registerProcessor?: (n: string, c: ProcCtor) => void };
  const prev = g.registerProcessor;
  let registered: ProcCtor | null = null;
  g.registerProcessor = (_n, ctor) => { registered = ctor; };
  await import('../es9-bridge');
  g.registerProcessor = prev;
  if (!registered) throw new Error('es9-bridge processor did not register');
  captured = registered;
  return captured;
}

interface Rig {
  proc: ProcInstance;
  inSpec: RingSpec;
  outSpec: RingSpec;
  inRing: RingIO;   // we PRODUCE here (the Worker's role)
  outRing: RingIO;  // we CONSUME here (the Worker's role)
}

async function rig(classes?: { inClasses?: number[]; outClasses?: number[] }): Promise<Rig> {
  const Proc = await loadProcessor();
  const proc = new Proc();
  const inSpec = createRingSpec(HW, 4096);
  const outSpec = createRingSpec(HW, 4096);
  proc.port.onmessage?.({ data: { type: 'rings', in: inSpec, out: outSpec } });
  if (classes) proc.port.onmessage?.({ data: { type: 'classes', ...classes } });
  return { proc, inSpec, outSpec, inRing: new RingIO(inSpec), outRing: new RingIO(outSpec) };
}

function io(): { inputs: Float32Array[][]; outputs: Float32Array[][] } {
  return {
    inputs: Array.from({ length: HW }, () => [new Float32Array(BLOCK)]),
    outputs: Array.from({ length: N_OUT }, () => [new Float32Array(BLOCK)]),
  };
}

function peak(buf: ArrayLike<number>): number {
  let p = 0;
  for (let i = 0; i < buf.length; i++) p = Math.max(p, Math.abs(buf[i]!));
  return p;
}

/** Fill the hardware→graph ring with `frames` of a 1 kHz sine at `amp` on
 *  channel `ch` (silence elsewhere). */
function feedSine(r: Rig, ch: number, amp: number, frames: number): void {
  r.inRing.write(frames, (c, i) => (c === ch ? amp * Math.sin((2 * Math.PI * 1000 * i) / SR) : 0));
}

function fullClasses(inCls: number, outCls: number): { inClasses: number[]; outClasses: number[] } {
  return {
    inClasses: new Array(HW).fill(inCls),
    outClasses: new Array(HW).fill(outCls),
  };
}

describe('es9-bridge worklet — hardware → graph level', () => {
  it('a ±5 V modular signal (0.5 on the wire) reads ±1.0 at the raw in1 port, for in1_class=cv AND =audio', async () => {
    for (const inCls of [CLASS_CV, CLASS_AUDIO]) {
      const r = await rig(fullClasses(inCls, CLASS_AUDIO));
      feedSine(r, 0, 0.5, BLOCK * 4);
      let rawPeak = 0;
      let twinPeak = 0;
      for (let b = 0; b < 4; b++) {
        const { inputs, outputs } = io();
        r.proc.process(inputs, outputs, {});
        rawPeak = Math.max(rawPeak, peak(outputs[0]![0]!));
        twinPeak = Math.max(twinPeak, peak(outputs[CV_TWIN_BASE]![0]!));
      }
      // THE LEVEL GAP. Old constant: 0.5 (−6.02 dBFS). New: 1.0 (0 dBFS).
      expect(rawPeak, `raw in1 peak, in1_class=${inCls}`).toBeCloseTo(1.0, 3);
      // The twin at class audio or cv is the SAME scale as the raw port.
      expect(twinPeak, `in1_cv peak, in1_class=${inCls}`).toBeCloseTo(1.0, 3);
    }
  });

  it('twin invariant: the twin scales the WIRE value, never the audio-scaled raw sample', async () => {
    // pitch ×10: wire 0.1 (1 V) → 1.0 on the twin, and raw reads 0.2 (not 2.0).
    const r = await rig({ inClasses: [CLASS_PITCH, CLASS_GATE, ...new Array(HW - 2).fill(CLASS_CV)] });
    // ch0: DC 0.1 (1 V); ch1: a gate that sits at 1.5 V then steps to 2 V.
    r.inRing.write(BLOCK, (c, i) => (c === 0 ? 0.1 : c === 1 ? (i < 64 ? 0.15 : 0.2) : 0));
    const { inputs, outputs } = io();
    r.proc.process(inputs, outputs, {});
    expect(outputs[CV_TWIN_BASE]![0]![10]).toBeCloseTo(1.0, 6);   // pitch: 1 V → 1.0/oct (×10 of the wire)
    expect(outputs[0]![0]![10]).toBeCloseTo(0.2, 6);              // raw: 1 V → 0.2 (×2 of the wire)
    // Gate comparator thresholds are WIRE volts: 1.5 V stays low, 2 V rises.
    expect(outputs[CV_TWIN_BASE + 1]![0]![10]).toBe(0);
    expect(outputs[CV_TWIN_BASE + 1]![0]![100]).toBe(1);
    // A scaled twin would have tripped at 1.5 V (0.15 × 2 = 0.3 ≥ 0.2).
  });

  it('the S/PDIF return (channels 14/15) is digital: 0.5 on the wire reads 0.5, not 1.0', async () => {
    const r = await rig();
    r.inRing.write(BLOCK, (c) => (c === 14 ? 0.5 : c === 15 ? -0.25 : 0));
    const { inputs, outputs } = io();
    r.proc.process(inputs, outputs, {});
    expect(outputs[14]![0]![5]).toBeCloseTo(0.5, 6);
    expect(outputs[15]![0]![5]).toBeCloseTo(-0.25, 6);
  });

  it('underrun: the raw fade starts from the EMITTED (scaled) level and reaches exactly 0 after FADE_FRAMES', async () => {
    const r = await rig(fullClasses(CLASS_AUDIO, CLASS_AUDIO));
    // Exactly 64 frames of DC 0.5 (→ 1.0 emitted), then starvation.
    r.inRing.write(64, (c) => (c === 0 ? 0.5 : 0));
    const { inputs, outputs } = io();
    r.proc.process(inputs, outputs, {});
    const raw = outputs[0]![0]!;
    expect(raw[63]).toBeCloseTo(1.0, 6);
    // First fill sample: one step down from 1.0 (not from the wire's 0.5).
    expect(raw[64]).toBeCloseTo(1.0 - 1.0 / FADE_FRAMES, 6);
    expect(raw[64]).toBeGreaterThan(0.5);
    // Monotone to a true zero exactly FADE_FRAMES after the last real sample.
    for (let i = 65; i < 64 + FADE_FRAMES; i++) {
      expect(Math.abs(raw[i]!)).toBeLessThanOrEqual(Math.abs(raw[i - 1]!) + 1e-9);
    }
    expect(raw[64 + FADE_FRAMES - 1]).toBe(0);
  });

  it('negative control: with no rings adopted every output stays at zero', async () => {
    const Proc = await loadProcessor();
    const proc = new Proc();
    const { inputs, outputs } = io();
    inputs[8]![0]!.fill(1.0);
    proc.process(inputs, outputs, {});
    for (let o = 0; o < N_OUT; o++) expect(peak(outputs[o]![0]!), `output ${o}`).toBe(0);
  });
});

describe('es9-bridge worklet — graph → hardware level', () => {
  function drain(r: Rig, frames: number): Float32Array[] {
    const planes = Array.from({ length: HW }, () => new Float32Array(frames));
    r.outRing.read(frames, (c, i, v) => { planes[c]![i] = v; });
    return planes;
  }

  it('internal ±1.0 into out1 (worklet input 8, class audio) lands at 0.5 on the wire = ±5 V; cv the same; pitch ×0.1', async () => {
    const outClasses = new Array(HW).fill(CLASS_AUDIO);
    outClasses[9] = CLASS_CV;
    outClasses[10] = CLASS_PITCH;
    const r = await rig({ outClasses });
    const { inputs, outputs } = io();
    inputs[8]![0]!.fill(1.0);   // out1, audio
    inputs[9]![0]!.fill(1.0);   // out2, cv
    inputs[10]![0]!.fill(1.0);  // out3, pitch
    r.proc.process(inputs, outputs, {});
    const wire = drain(r, BLOCK);
    expect(wire[8]![7]).toBeCloseTo(0.5, 6);   // was 1.0 (±10 V) before the fix
    expect(wire[9]![7]).toBeCloseTo(0.5, 6);
    expect(wire[10]![7]).toBeCloseTo(0.1, 6);
  });

  it('gate class at a jack: ≥ 0.5 emits +5 V (GATE_OUT_LEVEL), below emits 0 V', async () => {
    const outClasses = new Array(HW).fill(CLASS_AUDIO);
    outClasses[15] = CLASS_GATE;
    const r = await rig({ outClasses });
    const { inputs, outputs } = io();
    const g = inputs[15]![0]!;
    for (let i = 0; i < BLOCK; i++) g[i] = i < 64 ? 0.49 : 1.0;
    r.proc.process(inputs, outputs, {});
    const wire = drain(r, BLOCK);
    expect(wire[15]![10]).toBe(0);
    expect(wire[15]![100]).toBe(GATE_OUT_LEVEL);
  });

  it('usb1-8 (worklet inputs 0..7) are digital feeds: internal 1.0 lands at 1.0 on the wire, whatever class the message says', async () => {
    // The module forces AUDIO on 0..7, but the guard must not depend on it:
    // send the WRONG class for those channels and they still pass ×1.
    const r = await rig(fullClasses(CLASS_CV, CLASS_CV));
    const { inputs, outputs } = io();
    for (let c = 0; c < 8; c++) inputs[c]![0]!.fill(1.0);
    r.proc.process(inputs, outputs, {});
    const wire = drain(r, BLOCK);
    for (let c = 0; c < 8; c++) expect(wire[c]![3], `usb${c + 1}`).toBeCloseTo(1.0, 6);
  });

  it('round trip: a jack driven at 1.0 and looped back on the wire reads 1.0 at the raw port', async () => {
    const r = await rig(fullClasses(CLASS_AUDIO, CLASS_AUDIO));
    const { inputs, outputs } = io();
    inputs[8]![0]!.fill(1.0);
    r.proc.process(inputs, outputs, {});
    const wire = drain(r, BLOCK);
    // Loop the wire back: what left out1 arrives on in1.
    r.inRing.write(BLOCK, (c, i) => (c === 0 ? wire[8]![i]! : 0));
    const pass2 = io();
    r.proc.process(pass2.inputs, pass2.outputs, {});
    expect(pass2.outputs[0]![0]![50]).toBeCloseTo(1.0, 6);
  });
});
