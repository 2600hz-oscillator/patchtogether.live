// packages/web/src/lib/audio/gate-edge-worklet.test.ts
//
// The audio-thread gate-edge accumulator, tested by EVALUATING THE SHIPPED
// SOURCE STRING. `GATE_EDGE_WORKLET_SOURCE` is what `ensureGateEdgeWorklet`
// hands to `addModule`, and it is what these tests drive — so the tested code
// and the shipped code cannot drift.
//
// These are the two proofs the gate rework owes:
//
//   PROOF 2 (no double-counting) — this is the repo's oldest edge bug class:
//   NUMPAD+/HYDROGEN/ATLANTIS-CATALYST all shipped "one clock pulse advances
//   TWO steps" because a whole-buffer rescan of the analyser ring overlapped
//   the scheduler tick. Counting per-sample in the audio thread is correct by
//   construction, but "by construction" is not evidence — so the counts here
//   are EXACT (`toBe`, never `toBeGreaterThan`), a pulse is deliberately
//   straddled across a process() block boundary, and an off-by-one-per-block
//   defect is given its own negative control.
//
//   PROOF 1 (held gates survive) — the repo standard is explicit: "Do NOT
//   convert a gate consumer to edge-only." A held gate must read HIGH for as
//   long as it is held. Here that means: exactly ONE rising edge for the whole
//   hold, `level: 1` on the rise, no chatter while held, and `level: 0` landing
//   on release.
//
// Zero wall-clock, zero rAF: the processor is driven block-by-block with
// synthesized sample data.

import { describe, it, expect } from 'vitest';
import {
  GATE_EDGE_WORKLET_SOURCE,
  GATE_EDGE_PROCESSOR,
  type GateEdgeMessage,
} from './gate-edge-worklet';
import { GATE_HI } from './gate-trigger';

const BLOCK = 128;

interface Harness {
  /** Feed one 128-sample block; `level(i)` returns the sample value. */
  block(level: (i: number) => number): void;
  /** Feed `n` blocks all at a constant value. */
  hold(value: number, n: number): void;
  messages: GateEdgeMessage[];
  /** Registered processor name, as seen by registerProcessor. */
  name: string;
}

/** Evaluate the shipped worklet source with shimmed AudioWorkletGlobalScope
 *  globals and return a driveable processor instance. */
function makeProcessor(): Harness {
  const messages: GateEdgeMessage[] = [];
  let Ctor: (new () => { process(inputs: Float32Array[][]): boolean }) | undefined;
  let name = '';
  const g = globalThis as unknown as Record<string, unknown>;
  const prevBase = g.AudioWorkletProcessor;
  const prevReg = g.registerProcessor;
  g.AudioWorkletProcessor = class {
    port = { postMessage: (m: GateEdgeMessage) => { messages.push(m); } };
  };
  g.registerProcessor = (n: string, c: unknown) => {
    name = n;
    Ctor = c as new () => { process(inputs: Float32Array[][]): boolean };
  };
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    new Function(GATE_EDGE_WORKLET_SOURCE)();
  } finally {
    g.AudioWorkletProcessor = prevBase;
    g.registerProcessor = prevReg;
  }
  if (!Ctor) throw new Error('worklet source did not registerProcessor');
  const proc = new Ctor();
  return {
    name,
    messages,
    block(level) {
      const ch = new Float32Array(BLOCK);
      for (let i = 0; i < BLOCK; i++) ch[i] = level(i);
      proc.process([[ch]]);
    },
    hold(value, n) {
      for (let k = 0; k < n; k++) {
        const ch = new Float32Array(BLOCK).fill(value);
        proc.process([[ch]]);
      }
    },
  };
}

/** Latest monotonic count the processor has reported (0 if it never spoke). */
function total(h: Harness): number {
  return h.messages.at(-1)?.count ?? 0;
}

describe('gate-edge worklet — audio-thread rising-edge accumulator', () => {
  it('registers under the name the engine constructs', () => {
    expect(makeProcessor().name).toBe(GATE_EDGE_PROCESSOR);
  });

  it('is silent while the signal never crosses (an off-by-one-per-block would post)', () => {
    const h = makeProcessor();
    h.hold(0, 200);
    expect(h.messages, '200 blocks of pure LOW must produce NO messages').toEqual([]);
    expect(total(h)).toBe(0);
  });

  // ---- PROOF 2: exact counting, no double-count -------------------------
  it('PROOF 2: counts a known pulse train EXACTLY', () => {
    const h = makeProcessor();
    // 40 pulses, each 3 blocks HIGH then 7 blocks LOW. Nothing here is a
    // multiple of anything the consumer does — the count must be exactly 40.
    for (let p = 0; p < 40; p++) {
      h.hold(1, 3);
      h.hold(0, 7);
    }
    expect(total(h), 'exactly one edge per pulse — not 39, not 41, not 80').toBe(40);
  });

  it('PROOF 2: a pulse STRADDLING a process() block boundary counts ONCE', () => {
    const h = makeProcessor();
    // Rise in the last sample of a block, stay high across the next two
    // blocks, fall mid-block. The naive whole-buffer rescan bug counted the
    // same edge on every block that still contained it.
    h.block((i) => (i === BLOCK - 1 ? 1 : 0));
    h.hold(1, 2);
    h.block((i) => (i < 40 ? 1 : 0));
    h.hold(0, 2);
    expect(total(h), 'one physical edge → one count, however many blocks it spans').toBe(1);
  });

  it('PROOF 2: back-to-back pulses inside ONE block are each counted', () => {
    const h = makeProcessor();
    // Three separate 10-sample pulses within a single 128-sample block. A
    // per-block (rather than per-sample) detector would report 1.
    h.block((i) => ((i >= 10 && i < 20) || (i >= 50 && i < 60) || (i >= 90 && i < 100) ? 1 : 0));
    expect(total(h), 'per-SAMPLE detection: three pulses in one block = three edges').toBe(3);
  });

  it('PROOF 2: the count is monotonic and never rewinds', () => {
    const h = makeProcessor();
    for (let p = 0; p < 25; p++) { h.hold(1, 1); h.hold(0, 1); }
    const counts = h.messages.map((m) => m.count);
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]!, 'monotonic').toBeGreaterThanOrEqual(counts[i - 1]!);
    }
    expect(total(h)).toBe(25);
  });

  // ---- PROOF 1: held gates stay HIGH ------------------------------------
  it('PROOF 1: a gate HELD across many blocks reports level 1 and does NOT chatter', () => {
    const h = makeProcessor();
    h.hold(0, 5);
    h.hold(1, 500); // a long held gate — ~1.3 s of audio at 48 kHz
    expect(total(h), 'a held gate is ONE edge, not one per block').toBe(1);
    expect(h.messages.length, 'exactly one transition message while held').toBe(1);
    expect(h.messages[0]!.level, 'the rise reports level HIGH').toBe(1);
  });

  it('PROOF 1: release lands — the falling edge reports level 0 without a new edge', () => {
    const h = makeProcessor();
    h.hold(1, 100);
    expect(h.messages.at(-1)!.level).toBe(1);
    h.hold(0, 100);
    const last = h.messages.at(-1)!;
    expect(last.level, 'release must be reported').toBe(0);
    expect(last.count, 'a FALLING edge must not increment the rising count').toBe(1);
    expect(total(h)).toBe(1);
  });

  it('PROOF 1: a long hold then a re-trigger gives exactly two edges', () => {
    const h = makeProcessor();
    h.hold(1, 300); // held
    h.hold(0, 10);  // released
    h.hold(1, 300); // held again
    expect(total(h)).toBe(2);
    expect(h.messages.at(-1)!.level, 'still held at the end → HIGH').toBe(1);
  });

  // ---- threshold ---------------------------------------------------------
  it('uses the canonical GATE_HI threshold (>= is HIGH, below is LOW)', () => {
    const h = makeProcessor();
    h.hold(GATE_HI - 0.01, 10);
    expect(total(h), 'just below GATE_HI must not fire').toBe(0);
    h.hold(GATE_HI, 10);
    expect(total(h), 'exactly GATE_HI counts as HIGH').toBe(1);
  });

  it('tolerates a missing input channel (an unconnected tap) without throwing', () => {
    const messages: GateEdgeMessage[] = [];
    let Ctor: (new () => { process(inputs: Float32Array[][]): boolean }) | undefined;
    const g = globalThis as unknown as Record<string, unknown>;
    const prevBase = g.AudioWorkletProcessor;
    const prevReg = g.registerProcessor;
    g.AudioWorkletProcessor = class {
      port = { postMessage: (m: GateEdgeMessage) => { messages.push(m); } };
    };
    g.registerProcessor = (_n: string, c: unknown) => {
      Ctor = c as new () => { process(inputs: Float32Array[][]): boolean };
    };
    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
      new Function(GATE_EDGE_WORKLET_SOURCE)();
    } finally {
      g.AudioWorkletProcessor = prevBase;
      g.registerProcessor = prevReg;
    }
    const proc = new Ctor!();
    expect(proc.process([])).toBe(true);
    expect(proc.process([[]])).toBe(true);
    expect(messages).toEqual([]);
  });
});
