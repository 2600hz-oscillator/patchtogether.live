// packages/dsp/src/clip-recorder.test.ts
//
// THE CLIP-RECORDER WORKLET, captured through the registerProcessor shim (the
// featurecv-snapshot / dx7-messages pattern — the worklet entry never
// top-level-exports its class, because that would break the ART harness's
// classic-script eval).
//
// EVERY COUNT HERE IS EXACT (`toBe`, never `toBeGreaterThan`). The worklet's
// one promise is frame-exactness: a take is `stopFrame − startFrame` samples,
// starting at the exact sample, whatever the quantum boundaries were doing —
// so the tests straddle windows across quanta on purpose (a mid-quantum
// punch-in, a mid-quantum stop) and identify samples BY VALUE (each input
// sample carries its own global frame index), so an off-by-one is a wrong
// number, not a feeling.
//
// The multitrack guarantee is asserted the way it is built: eight lanes armed
// together, sliced inside one process() against one `currentFrame`, capture
// the SAME first frame — alignment by construction, checked by value.

import { describe, it, expect, beforeAll } from 'vitest';
import {
  CLIP_RECORDER_CHUNK_FRAMES as CHUNK_FRAMES,
  CLIP_RECORDER_LANES as NUM_LANES,
  CLIP_RECORDER_PROCESSOR,
  type ClipRecorderChunkMsg as ChunkMsg,
  type ClipRecorderDoneMsg as DoneMsg,
  type ClipRecorderOutMsg as OutMsg,
} from './lib/clip-recorder-protocol';

const SR = 48_000;
const BLOCK = 128;

interface ProcInstance {
  port: {
    onmessage: ((e: { data: unknown }) => void) | null;
    postMessage: (m: unknown, t?: unknown[]) => void;
  };
  process: (inputs: Float32Array[][]) => boolean;
}
type ProcCtor = new () => ProcInstance;

let Recorder: ProcCtor | null = null;
let registeredName = '';
/** Every posted message, in order, with its transfer list. */
let posted: { m: OutMsg; transfer: unknown[] | undefined }[] = [];

/** The worklet clock — advanced by the harness, read via the global getter. */
let frameNow = 0;

beforeAll(async () => {
  const g = globalThis as unknown as {
    sampleRate?: number;
    AudioWorkletProcessor?: unknown;
    registerProcessor?: (n: string, c: ProcCtor) => void;
  };
  g.sampleRate = SR;
  // ALWAYS install a port-having stub base (never `if undefined`): the dsp
  // suite runs single-fork, so another worklet test may already have installed
  // a port-less stub.
  g.AudioWorkletProcessor = class {
    port = {
      onmessage: null as unknown,
      postMessage: (m: unknown, transfer?: unknown[]): void => {
        posted.push({ m: m as OutMsg, transfer });
      },
    };
  };
  g.registerProcessor = (n, ctor) => {
    registeredName = n;
    Recorder = ctor;
  };
  // `currentFrame` is an AudioWorkletGlobalScope ambient; the getter makes the
  // harness's clock the worklet's clock.
  Object.defineProperty(globalThis, 'currentFrame', {
    get: () => frameNow,
    configurable: true,
  });
  await import('./clip-recorder');
  if (!Recorder) throw new Error('clip-recorder did not registerProcessor');
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  proc: ProcInstance;
  send(msg: unknown): void;
  /** Run one 128-frame quantum. `laneInputs[lane]` supplies that lane's input
   *  channel array; an absent lane gets an EMPTY input (nothing connected). By
   *  default every listed lane's samples carry their own global frame index
   *  (value = lane * 1e7 + frame), so captures are identified by value. */
  quantum(lanes?: number[], opts?: { channels?: 1 | 2; missing?: boolean }): void;
  chunksFor(lane: number): ChunkMsg[];
  doneFor(lane: number): DoneMsg[];
}

/** The value planted at (lane, global frame) — L plane. R plane = value + 0.5
 *  so the planes are distinguishable. The base is 2^20 per lane so every
 *  planted value (max ≈ 7.36e6, and its +0.5 sibling) sits below 2^23 and is
 *  EXACTLY representable in float32 — the identity survives the Float32Array
 *  round-trip and `toBe` stays an exact comparison. */
const sampleAt = (lane: number, frame: number) => lane * 0x100000 + frame;

function makeHarness(): Harness {
  posted = [];
  frameNow = 0;
  const proc = new Recorder!();
  return {
    proc,
    send(msg) {
      (proc.port.onmessage as (e: { data: unknown }) => void)({ data: msg });
    },
    quantum(lanes = [], opts = {}) {
      const inputs: Float32Array[][] = Array.from({ length: NUM_LANES }, () => []);
      for (const lane of lanes) {
        if (opts.missing) continue;
        const l = new Float32Array(BLOCK);
        for (let i = 0; i < BLOCK; i++) l[i] = sampleAt(lane, frameNow + i);
        if (opts.channels === 1) {
          inputs[lane] = [l];
        } else {
          const r = new Float32Array(BLOCK);
          for (let i = 0; i < BLOCK; i++) r[i] = sampleAt(lane, frameNow + i) + 0.5;
          inputs[lane] = [l, r];
        }
      }
      proc.process(inputs);
      frameNow += BLOCK;
    },
    chunksFor(lane) {
      return posted.filter((p): p is { m: ChunkMsg; transfer: unknown[] | undefined } =>
        p.m.type === 'chunk' && p.m.lane === lane,
      ).map((p) => p.m);
    },
    doneFor(lane) {
      return posted.filter((p): p is { m: DoneMsg; transfer: unknown[] | undefined } =>
        p.m.type === 'done' && p.m.lane === lane,
      ).map((p) => p.m);
    },
  };
}

/** Concatenate a lane's chunk L planes into one take-ordered array, verifying
 *  the chunks tile the take contiguously by their own firstFrame. */
function takeL(chunks: ChunkMsg[]): Float32Array {
  let total = 0;
  for (const c of chunks) total += c.frames;
  const out = new Float32Array(total);
  let expectFirst = 0;
  for (const c of chunks) {
    expect(c.firstFrame).toBe(expectFirst); // contiguous, take-relative
    out.set(c.data.subarray(0, c.frames), c.firstFrame);
    expectFirst += c.frames;
  }
  return out;
}

// ---------------------------------------------------------------------------

describe('registration', () => {
  it("registers as 'clip-recorder' — the name the web wiring constructs", () => {
    // The worklet registers with a LITERAL (mono-normal-scan derives the
    // DSP→factory mapping from `registerProcessor('<literal>')`); the protocol
    // constant the web side constructs with must be the SAME string.
    expect(registeredName).toBe('clip-recorder');
    expect(CLIP_RECORDER_PROCESSOR).toBe(registeredName);
  });
});

describe('frame-exact windows', () => {
  it('captures EXACTLY stopFrame − startFrame samples across quantum boundaries, starting at the exact sample', () => {
    const h = makeHarness();
    // start mid-quantum 1 (frame 200 = 128 + 72), stop mid-quantum 7 (frame 1000).
    h.send({ type: 'arm', lane: 0, startFrame: 200, stopFrame: 1000 });
    for (let q = 0; q < 10; q++) h.quantum([0]);
    const done = h.doneFor(0);
    expect(done).toHaveLength(1);
    expect(done[0]!.frames).toBe(800); // exact
    const L = takeL(h.chunksFor(0));
    expect(L).toHaveLength(800);
    expect(L[0]).toBe(sampleAt(0, 200)); // first captured sample IS frame 200
    expect(L[799]).toBe(sampleAt(0, 999)); // last is frame 999 (stop exclusive)
  });

  it('punches in mid-quantum at the exact sample (arm inside an already-running stream)', () => {
    const h = makeHarness();
    // Let the clock run first — the arm lands with startFrame inside quantum 3.
    h.quantum([2]);
    const start = 3 * BLOCK + 37;
    h.send({ type: 'arm', lane: 2, startFrame: start, stopFrame: start + 300 });
    for (let q = 0; q < 6; q++) h.quantum([2]);
    expect(h.doneFor(2)[0]!.frames).toBe(300);
    const L = takeL(h.chunksFor(2));
    expect(L[0]).toBe(sampleAt(2, start));
    expect(L[299]).toBe(sampleAt(2, start + 299));
  });

  it('a take spanning multiple chunks tiles exactly: 4096-frame posts + the remainder, transferred', () => {
    const h = makeHarness();
    h.send({ type: 'arm', lane: 1, startFrame: 0, stopFrame: 10_000 });
    for (let q = 0; q * BLOCK < 10_240; q++) h.quantum([1]);
    const chunks = h.chunksFor(1);
    expect(chunks.map((c) => c.frames)).toEqual([4096, 4096, 10_000 - 2 * 4096]);
    expect(chunks.map((c) => c.firstFrame)).toEqual([0, 4096, 8192]);
    expect(CHUNK_FRAMES).toBe(4096); // the cadence this test is written against
    const L = takeL(chunks);
    expect(L[4096]).toBe(sampleAt(1, 4096)); // chunk-2 head is the right sample
    expect(L[9999]).toBe(sampleAt(1, 9999));
    expect(h.doneFor(1)[0]!.frames).toBe(10_000);
    // Chunks are TRANSFERRED (the buffer rides the transfer list).
    const postedChunks = posted.filter((p) => (p.m as ChunkMsg).type === 'chunk');
    for (const p of postedChunks) {
      expect(p.transfer).toEqual([(p.m as ChunkMsg).data.buffer]);
    }
  });

  it('R plane is captured as itself; a mono input duplicates L (recorderbox rule)', () => {
    const h = makeHarness();
    h.send({ type: 'arm', lane: 3, startFrame: 0, stopFrame: 100 });
    h.quantum([3]);
    const c = h.chunksFor(3)[0]!;
    expect(c.data[100]).toBe(sampleAt(3, 0) + 0.5); // R plane, own values

    const h2 = makeHarness();
    h2.send({ type: 'arm', lane: 3, startFrame: 0, stopFrame: 100 });
    h2.quantum([3], { channels: 1 });
    const m = h2.chunksFor(3)[0]!;
    expect(m.data[100]).toBe(m.data[0]); // R === L
    expect(m.data[0]).toBe(sampleAt(3, 0));
  });
});

describe('eight lanes share one currentFrame', () => {
  it('all 8 lanes armed together capture the SAME first frame and the same exact count', () => {
    const h = makeHarness();
    const lanes = [0, 1, 2, 3, 4, 5, 6, 7];
    for (const lane of lanes) {
      h.send({ type: 'arm', lane, startFrame: 300, stopFrame: 812 });
    }
    for (let q = 0; q < 8; q++) h.quantum(lanes);
    for (const lane of lanes) {
      expect(h.doneFor(lane)[0]!.frames).toBe(512);
      const L = takeL(h.chunksFor(lane));
      // The first captured sample of EVERY lane is that lane's frame-300
      // sample — zero-lag alignment by value, not by agreement.
      expect(L[0]).toBe(sampleAt(lane, 300));
      expect(L[511]).toBe(sampleAt(lane, 811));
    }
  });

  it('per-lane stop frames differ independently (polyrhythmic takes)', () => {
    const h = makeHarness();
    h.send({ type: 'arm', lane: 0, startFrame: 128, stopFrame: 128 + 256 });
    h.send({ type: 'arm', lane: 5, startFrame: 128, stopFrame: 128 + 640 });
    for (let q = 0; q < 8; q++) h.quantum([0, 5]);
    expect(h.doneFor(0)[0]!.frames).toBe(256);
    expect(h.doneFor(5)[0]!.frames).toBe(640);
  });
});

describe('a missing input records SILENCE at the right frames — never a skip', () => {
  it('keeps the count exact and later samples at their own frames (a skip would shift them)', () => {
    const h = makeHarness();
    h.send({ type: 'arm', lane: 4, startFrame: 0, stopFrame: 512 });
    h.quantum([4]);
    h.quantum([4]);
    h.quantum([4], { missing: true }); // frames 256..384: nothing connected
    h.quantum([4]);
    expect(h.doneFor(4)[0]!.frames).toBe(512); // exact — no third outcome
    const L = takeL(h.chunksFor(4));
    expect(L[255]).toBe(sampleAt(4, 255));
    expect(L[256]).toBe(0); // silence, not a skip
    expect(L[383]).toBe(0);
    expect(L[384]).toBe(sampleAt(4, 384)); // the stream resumes AT ITS OWN FRAME
  });
});

describe('stopAt', () => {
  it('resolves an open endless take to an exact mid-quantum frame', () => {
    const h = makeHarness();
    h.send({ type: 'arm', lane: 6, startFrame: 0, stopFrame: null });
    h.quantum([6]);
    h.quantum([6]);
    h.send({ type: 'stopAt', lane: 6, stopFrame: 300 }); // already past — finishes next quantum
    h.quantum([6]);
    const done = h.doneFor(6);
    expect(done).toHaveLength(1);
    // Frames 0..300 were owed; 0..256 were captured before the stop arrived,
    // 256..300 in the finishing quantum. Exactly 300.
    expect(done[0]!.frames).toBe(300);
    const L = takeL(h.chunksFor(6));
    expect(L[299]).toBe(sampleAt(6, 299));
  });

  it('⚠ NEVER EXTENDS a resolved stop — a later stopAt is structurally a no-op', () => {
    const h = makeHarness();
    h.send({ type: 'arm', lane: 7, startFrame: 0, stopFrame: null });
    h.quantum([7]);
    h.send({ type: 'stopAt', lane: 7, stopFrame: 200 });
    h.send({ type: 'stopAt', lane: 7, stopFrame: 500 }); // the double-STOP shape
    h.quantum([7]);
    expect(h.doneFor(7)[0]!.frames).toBe(200); // the FIRST stop stood
  });

  it('accepts an EARLIER stop (the budget cap-stop shortening a take)', () => {
    const h = makeHarness();
    h.send({ type: 'arm', lane: 7, startFrame: 0, stopFrame: 1000 });
    h.quantum([7]);
    h.send({ type: 'stopAt', lane: 7, stopFrame: 200 });
    h.quantum([7]);
    expect(h.doneFor(7)[0]!.frames).toBe(200);
  });
});

describe('cancel + re-arm', () => {
  it('cancel discards silently: no further chunks, NO done', () => {
    const h = makeHarness();
    h.send({ type: 'arm', lane: 0, startFrame: 0, stopFrame: 10_000 });
    h.quantum([0]);
    h.send({ type: 'cancel', lane: 0 });
    for (let q = 0; q < 40; q++) h.quantum([0]);
    expect(h.doneFor(0)).toHaveLength(0);
    expect(h.chunksFor(0)).toHaveLength(0); // 128 buffered frames never flushed
  });

  it('re-arm replaces the lane state wholesale — the new take starts clean', () => {
    const h = makeHarness();
    h.send({ type: 'arm', lane: 2, startFrame: 0, stopFrame: null });
    h.quantum([2]);
    const start2 = 2 * BLOCK + 10;
    h.send({ type: 'arm', lane: 2, startFrame: start2, stopFrame: start2 + 100 });
    h.quantum([2]);
    h.quantum([2]);
    const done = h.doneFor(2);
    expect(done).toHaveLength(1);
    expect(done[0]!.frames).toBe(100);
    expect(takeL(h.chunksFor(2))[0]).toBe(sampleAt(2, start2));
  });
});

describe('malformed messages are ignored (a recorder must not throw in onmessage)', () => {
  it('bad lanes, degenerate windows, junk types — nothing captures, nothing throws', () => {
    const h = makeHarness();
    h.send(null);
    h.send('arm');
    h.send({ type: 'arm', lane: -1, startFrame: 0, stopFrame: 100 });
    h.send({ type: 'arm', lane: 8, startFrame: 0, stopFrame: 100 });
    h.send({ type: 'arm', lane: 1.5, startFrame: 0, stopFrame: 100 });
    h.send({ type: 'arm', lane: 0, startFrame: NaN, stopFrame: 100 });
    h.send({ type: 'arm', lane: 0, startFrame: 100, stopFrame: 100 }); // empty window
    h.send({ type: 'arm', lane: 0, startFrame: 100, stopFrame: 50 }); // inverted
    h.send({ type: 'stopAt', lane: 0, stopFrame: 100 }); // nothing armed
    h.send({ type: 'cancel', lane: 3 }); // nothing armed
    for (let q = 0; q < 4; q++) h.quantum([0, 1]);
    expect(posted).toHaveLength(0);
  });
});
