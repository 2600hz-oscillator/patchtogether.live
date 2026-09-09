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
  CLIP_RECORDER_MAX_ARM_SLIP_FRAMES as MAX_ARM_SLIP,
  CLIP_RECORDER_MAX_GAP_FRAMES as MAX_GAP,
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
  /** Advance the clock by `frames` WITHOUT rendering them — an output-device
   *  underrun, as the worklet sees one: `currentFrame` jumps past audio that
   *  was never asked for. Deliberately not a multiple of the quantum in the
   *  tests below, because that is the real shape (one Chromium/Linux output
   *  buffer = 480 frames) and the shape that tells a clock gap from every
   *  other shortfall. */
  skip(frames: number): void;
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
    skip(frames) {
      frameNow += frames;
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

// ---------------------------------------------------------------------------
// ⚠ THE CASE THIS FILE DID NOT HAVE — and the reason a real take was lost.
//
// The window is resolved on the MAIN thread from `ctx.currentTime` plus a fixed
// lead, so an `arm` can drain AFTER this thread has already rendered past its
// own `startFrame`. The old slice clamped its offset (`Math.max(0, start − q0)`)
// and silently dropped the head: 95872 of 96000 frames, exactly one quantum,
// scaling with lateness — and the commit demands the length byte-exactly, so
// the take was refused and no clip was ever written.
//
// EVERY ASSERTION BELOW FAILS AGAINST THE OLD SLICE. That is the positive
// control: `frames` came back short by 128×N, and the head samples were the
// ones missing, so the take was out of phase with its own loop as well.
// ---------------------------------------------------------------------------

/** Arm `lane` for a `len`-frame take whose `arm` message drains `lateQuanta`
 *  quanta after its own punch-in — the message losing its race with the audio
 *  thread, spelled as the harness's own clock rather than as a wall-clock
 *  delay. Returns the punch-in the main thread ASKED for and the slip it cost.
 *  `len: null` arms an ENDLESS take (no resolved stop). */
function armLate(
  h: Harness,
  lane: number,
  opts: { start: number; len: number | null; lateQuanta: number },
): { start: number; slip: number } {
  const { start, len, lateQuanta } = opts;
  // Render up to and PAST the punch-in while the arm is still in the queue.
  const before = Math.ceil(start / BLOCK) + lateQuanta;
  for (let q = 0; q < before; q++) h.quantum([lane]);
  h.send({
    type: 'arm',
    lane,
    startFrame: start,
    stopFrame: len === null ? null : start + len,
  });
  return { start, slip: before * BLOCK - start };
}

describe('⚠ a LATE arm SLIDES, never truncates', () => {
  it('an ON-TIME arm is untouched: exact length, exact first sample, done reports the requested start', () => {
    // The control. `startFrame` lands inside the quantum that is about to
    // render, so the slide's guard (`q0 > startFrame`) cannot fire.
    const h = makeHarness();
    h.quantum([0]);
    const start = 2 * BLOCK + 41;
    h.send({ type: 'arm', lane: 0, startFrame: start, stopFrame: start + 700 });
    for (let q = 0; q < 8; q++) h.quantum([0]);
    const done = h.doneFor(0);
    expect(done).toHaveLength(1);
    expect(done[0]!.frames).toBe(700);
    expect(done[0]!.startFrame).toBe(start); // no slip — the take got what it asked for
    const L = takeL(h.chunksFor(0));
    expect(L[0]).toBe(sampleAt(0, start));
    expect(L[699]).toBe(sampleAt(0, start + 699));
  });

  it.each([1, 2, 5, 20, 32])(
    'an arm drained %i quanta late still captures EXACTLY stopFrame − startFrame',
    (lateQuanta) => {
      const h = makeHarness();
      const { start, slip } = armLate(h, 1, { start: 3 * BLOCK, len: 9600, lateQuanta });
      expect(slip).toBe(lateQuanta * BLOCK); // the miss, spelled out
      for (let q = 0; q < 9600 / BLOCK + lateQuanta + 2; q++) h.quantum([1]);
      const done = h.doneFor(1);
      expect(done).toHaveLength(1);
      // THE LENGTH IS THE CONTRACT. Under the old slice this was 9600 − slip.
      expect(done[0]!.frames).toBe(9600);
      // …and the take is not a truncation: it is the same window, moved.
      expect(done[0]!.startFrame).toBe(start + slip);
      const L = takeL(h.chunksFor(1));
      expect(L).toHaveLength(9600);
      expect(L[0]).toBe(sampleAt(1, start + slip)); // the HEAD survived
      expect(L[9599]).toBe(sampleAt(1, start + slip + 9599));
    },
  );

  it('reports the ACTUAL start on done, so a slip is observable rather than inferred', () => {
    // Without this field the main thread cannot tell a punched-on-time take
    // from a slid one — every take now reports the exact requested LENGTH.
    const h = makeHarness();
    const { start, slip } = armLate(h, 2, { start: 4 * BLOCK, len: 1024, lateQuanta: 3 });
    for (let q = 0; q < 16; q++) h.quantum([2]);
    expect(h.doneFor(2)[0]!.startFrame - start).toBe(slip);
    expect(slip).toBe(3 * BLOCK);
  });

  it('lanes armed late in ONE task still share a first frame (multitrack stays sample-aligned)', () => {
    const h = makeHarness();
    const lanes = [3, 4, 5];
    const start = 2 * BLOCK;
    for (let q = 0; q < 2 + 4; q++) h.quantum(lanes); // 4 quanta past the punch-in
    for (const lane of lanes) {
      h.send({ type: 'arm', lane, startFrame: start, stopFrame: start + 2048 });
    }
    for (let q = 0; q < 24; q++) h.quantum(lanes);
    const starts = lanes.map((lane) => h.doneFor(lane)[0]!.startFrame);
    expect(new Set(starts).size).toBe(1); // ONE slid punch-in, shared
    for (const lane of lanes) {
      expect(h.doneFor(lane)[0]!.frames).toBe(2048);
      // Alignment by VALUE, not by agreement: every lane's first captured
      // sample is that lane's sample at the SAME global frame.
      expect(takeL(h.chunksFor(lane))[0]).toBe(sampleAt(lane, starts[0]!));
    }
  });

  it('⚠ REFUSES past the slide bound: zero frames, no chunks, and the frame it had reached', () => {
    // The bound is what keeps a loud, recoverable failure from becoming a
    // silent musical one. 33 quanta = 4224 frames > MAX_ARM_SLIP (4096).
    const h = makeHarness();
    const { start } = armLate(h, 6, { start: 2 * BLOCK, len: 4800, lateQuanta: 33 });
    for (let q = 0; q < 60; q++) h.quantum([6]);
    const done = h.doneFor(6);
    expect(done).toHaveLength(1);
    expect(done[0]!.frames).toBe(0); // REFUSED — not a short take, and not a slid one
    expect(done[0]!.startFrame).toBe(start + 33 * BLOCK); // where the thread actually was
    expect(h.chunksFor(6)).toHaveLength(0); // nothing was captured at all
    expect(MAX_ARM_SLIP).toBe(4096); // the bound these numbers straddle
  });

  it('slides EXACTLY at the bound (the boundary is honoured, not approximated)', () => {
    const h = makeHarness();
    const { start } = armLate(h, 7, { start: 2 * BLOCK, len: 2048, lateQuanta: 32 });
    for (let q = 0; q < 60; q++) h.quantum([7]);
    const done = h.doneFor(7)[0]!;
    expect(32 * BLOCK).toBe(MAX_ARM_SLIP); // 4096 — the last honoured miss
    expect(done.frames).toBe(2048);
    expect(done.startFrame).toBe(start + MAX_ARM_SLIP);
  });

  it('⚠ an ENDLESS take that slid still stops on a WHOLE unit (the stopAt rebase)', () => {
    // The main thread resolves an endless stop from the start it REQUESTED
    // (`clipRecEndlessStopFrame` = requestedStart + n × unitFrames) and posts
    // it as an ABSOLUTE frame. Against a slid take, a naive compare would take
    // that earlier frame — "never EXTEND a resolved stop" — and truncate by
    // exactly the slip: this very defect, re-created in the other mode.
    const h = makeHarness();
    const unit = 512;
    const { start, slip } = armLate(h, 0, { start: 3 * BLOCK, len: null, lateQuanta: 6 });
    h.quantum([0]); // the slide happens here
    h.send({ type: 'stopAt', lane: 0, stopFrame: start + 2 * unit }); // n = 2 units
    for (let q = 0; q < 20; q++) h.quantum([0]);
    const done = h.doneFor(0);
    expect(done).toHaveLength(1);
    expect(done[0]!.frames).toBe(2 * unit); // TWO WHOLE UNITS, not 1024 − slip
    expect(done[0]!.startFrame).toBe(start + slip);
  });

  it('an endless stopAt that arrives BEFORE the slide is carried by the slide itself', () => {
    // The other message order: both arm and stopAt drain in one task, so the
    // stop is already resolved when the window moves — and the window moves
    // whole, stop included. Both orders must give the same take.
    const h = makeHarness();
    const start = 3 * BLOCK;
    for (let q = 0; q < 3 + 6; q++) h.quantum([1]);
    h.send({ type: 'arm', lane: 1, startFrame: start, stopFrame: null });
    h.send({ type: 'stopAt', lane: 1, stopFrame: start + 1024 });
    for (let q = 0; q < 20; q++) h.quantum([1]);
    const done = h.doneFor(1)[0]!;
    expect(done.frames).toBe(1024);
    expect(done.startFrame).toBe(start + 6 * BLOCK);
  });
});

// ---------------------------------------------------------------------------
// ⚠ THE RENDER CLOCK IS NOT GAP-FREE — and the reason a second real take was
// lost. When the output device underruns, `currentFrame` jumps past audio this
// thread was never asked to render. The old slice kept counting `to − from`
// per callback and fell behind the absolute window by exactly the skip:
// 287520 of 288000 frames, 480 short — one Chromium/Linux output buffer, and
// NOT a multiple of 128, which is what ruled out every other cause. The commit
// refused the short take and the whole take went to the recovery pile.
//
// The take is now padded with SILENCE at the frames the device dropped — the
// missing-input rule — bounded by one chunk, refused past it, and `gapFrames`
// on `done` says how much. EVERY `frames`/`gapFrames`/offset ASSERTION BELOW
// FAILS AGAINST THE OLD SLICE: it returned `frames` short by the skip, and the
// samples after the skip landed `skip` frames early. The phase half is
// asserted BY VALUE — a test that only checked the count would pass on an
// implementation that appended the silence at the end.
// ---------------------------------------------------------------------------

/** 480 frames: one Chromium/Linux output buffer at 48 k, the exact shortfall
 *  the CI failure reported. 480 = 3.75 quanta, so it is not a shape any
 *  quantum-shaped bug could produce. */
const DEVICE_BUFFER = 480;

describe('⚠ a render-clock GAP is padded as SILENCE at the right frames', () => {
  it('POSITIVE CONTROL — a gap-free take is bit-identical: every sample is its own planted value, gapFrames 0', () => {
    // Nothing moved for the path that ships on a contiguous clock. The pad's
    // guard needs `q0` to run AHEAD of the next expected sample; here it never
    // does, so the take is the same bytes it always was — checked at EVERY
    // sample of a multi-chunk take, not at the ends.
    const h = makeHarness();
    h.quantum([0]);
    const start = 2 * BLOCK + 41;
    const len = 2 * CHUNK_FRAMES + 700;
    h.send({ type: 'arm', lane: 0, startFrame: start, stopFrame: start + len });
    for (let q = 0; q * BLOCK < start + len + BLOCK; q++) h.quantum([0]);
    const done = h.doneFor(0);
    expect(done).toHaveLength(1);
    expect(done[0]!.frames).toBe(len);
    expect(done[0]!.startFrame).toBe(start);
    const L = takeL(h.chunksFor(0));
    expect(L).toHaveLength(len);
    let mismatches = 0;
    for (let i = 0; i < len; i++) if (L[i] !== sampleAt(0, start + i)) mismatches++;
    expect(mismatches).toBe(0);
    // Last on purpose: every assertion above this line also holds against the
    // pre-pad worklet (checked by swapping it in), so this is the ONE line
    // that separates "the new field exists" from "the samples moved".
    expect(done[0]!.gapFrames).toBe(0);
  });

  it('a 480-frame jump mid-take yields the FULL length with exactly 480 zero frames at the skipped offset, and the stream resumes AT ITS OWN FRAME', () => {
    const h = makeHarness();
    const start = 3 * BLOCK;
    const len = 9600; // 200 ms — the shape of a real clip take
    h.send({ type: 'arm', lane: 1, startFrame: start, stopFrame: start + len });
    for (let q = 0; q < 3 + 10; q++) h.quantum([1]); // 10 quanta captured: 1280 frames
    const gapAt = 10 * BLOCK; // take-relative frame of the hole
    h.skip(DEVICE_BUFFER); // the device underran: 480 frames never rendered
    for (let q = 0; q < len / BLOCK + 4; q++) h.quantum([1]);
    const done = h.doneFor(1);
    expect(done).toHaveLength(1);
    // THE LENGTH IS THE CONTRACT. Under the old slice this was len − 480.
    expect(done[0]!.frames).toBe(len);
    expect(done[0]!.startFrame).toBe(start); // no slip — the punch-in was on time
    expect(done[0]!.gapFrames).toBe(DEVICE_BUFFER); // …and the glitch is a number
    const L = takeL(h.chunksFor(1));
    expect(L).toHaveLength(len);
    // The sample BEFORE the hole is the last one the device rendered…
    expect(L[gapAt - 1]).toBe(sampleAt(1, start + gapAt - 1));
    // …the hole is digital silence, all of it…
    let nonZero = 0;
    for (let i = gapAt; i < gapAt + DEVICE_BUFFER; i++) if (L[i] !== 0) nonZero++;
    expect(nonZero).toBe(0);
    // …and the sample AFTER it is the frame the clock actually resumed at —
    // NOT `start + gapAt` (which is what a skip-and-shift would put there).
    expect(L[gapAt + DEVICE_BUFFER]).toBe(sampleAt(1, start + gapAt + DEVICE_BUFFER));
    expect(L[len - 1]).toBe(sampleAt(1, start + len - 1)); // the tail is in phase
  });

  it('⚠ THE CI SHAPE — an ENDLESS take that lost one device buffer still stops on a WHOLE unit', () => {
    // 288000 demanded, 287520 captured. The stop lands from the main thread at
    // requestedStart + n × unit; the pad is what makes the count reach it.
    const h = makeHarness();
    const unit = 2048;
    const start = 2 * BLOCK;
    h.send({ type: 'arm', lane: 2, startFrame: start, stopFrame: null });
    for (let q = 0; q < 2 + 20; q++) h.quantum([2]);
    h.skip(DEVICE_BUFFER);
    for (let q = 0; q < 10; q++) h.quantum([2]);
    h.send({ type: 'stopAt', lane: 2, stopFrame: start + 3 * unit });
    for (let q = 0; q < 3 * unit / BLOCK; q++) h.quantum([2]);
    const done = h.doneFor(2);
    expect(done).toHaveLength(1);
    expect(done[0]!.frames).toBe(3 * unit); // THREE WHOLE UNITS, not 3 × unit − 480
    expect(done[0]!.gapFrames).toBe(DEVICE_BUFFER);
    const L = takeL(h.chunksFor(2));
    expect(L[3 * unit - 1]).toBe(sampleAt(2, start + 3 * unit - 1)); // in phase to the end
  });

  it('a hole that straddles a chunk boundary flushes mid-pad and the chunks still tile', () => {
    // 30 quanta = 3840 frames captured; the 480-frame hole covers 3840..4320,
    // crossing the 4096 chunk edge — so the pad itself must post a chunk.
    const h = makeHarness();
    const len = 6000;
    h.send({ type: 'arm', lane: 3, startFrame: 0, stopFrame: len });
    for (let q = 0; q < 30; q++) h.quantum([3]);
    h.skip(DEVICE_BUFFER);
    for (let q = 0; q < len / BLOCK + 2; q++) h.quantum([3]);
    const chunks = h.chunksFor(3);
    expect(chunks.map((c) => c.frames)).toEqual([CHUNK_FRAMES, len - CHUNK_FRAMES]);
    const L = takeL(chunks); // takeL asserts firstFrame contiguity
    expect(L).toHaveLength(len);
    expect(L[3839]).toBe(sampleAt(3, 3839));
    expect(L[3840]).toBe(0);
    expect(L[4095]).toBe(0); // last sample of chunk 1 — silence
    expect(L[4096]).toBe(0); // first sample of chunk 2 — still silence
    expect(L[4319]).toBe(0);
    expect(L[4320]).toBe(sampleAt(3, 4320));
    expect(h.doneFor(3)[0]!.frames).toBe(len);
    expect(h.doneFor(3)[0]!.gapFrames).toBe(DEVICE_BUFFER);
  });

  it('a jump past a RESOLVED stop pads only up to the stop and finishes exactly there', () => {
    // 30 quanta = 3840 captured, stop at 4000: the 480-frame jump overshoots
    // the window by 320. Only the 160 frames the window still owed are padded.
    const h = makeHarness();
    h.send({ type: 'arm', lane: 4, startFrame: 0, stopFrame: 4000 });
    for (let q = 0; q < 30; q++) h.quantum([4]);
    h.skip(DEVICE_BUFFER);
    h.quantum([4]); // the finishing quantum
    const done = h.doneFor(4);
    expect(done).toHaveLength(1);
    expect(done[0]!.frames).toBe(4000); // exact — never over
    expect(done[0]!.gapFrames).toBe(160);
    const L = takeL(h.chunksFor(4));
    expect(L[3839]).toBe(sampleAt(4, 3839));
    expect(L[3840]).toBe(0);
    expect(L[3999]).toBe(0);
  });

  it('a gap AT the punch-in goes through the SLIDE, not the pad (the two are mutually exclusive)', () => {
    // Nothing captured yet, so the clock running past `startFrame` is
    // indistinguishable from a late arm — and is handled as one: the window
    // moves whole, `slip` is reported via startFrame, `gapFrames` stays 0.
    const h = makeHarness();
    const start = 4 * BLOCK;
    h.send({ type: 'arm', lane: 5, startFrame: start, stopFrame: start + 1024 });
    for (let q = 0; q < 4; q++) h.quantum([5]); // up to the punch-in, nothing captured
    h.skip(DEVICE_BUFFER); // the device drops the buffer that held the punch-in
    for (let q = 0; q < 12; q++) h.quantum([5]);
    const done = h.doneFor(5)[0]!;
    expect(done.frames).toBe(1024);
    expect(done.startFrame).toBe(start + DEVICE_BUFFER); // slid, not padded
    expect(done.gapFrames).toBe(0);
    expect(takeL(h.chunksFor(5))[0]).toBe(sampleAt(5, start + DEVICE_BUFFER));
  });

  it('⚠ REFUSES past the pad bound: zero frames, the punch-in it really got, and the hole that broke it', () => {
    // Past one chunk the hole is not a click, it is a ruined take, and a loud
    // refusal beats a silent hole. 4097 > MAX_GAP (4096).
    const h = makeHarness();
    const start = 2 * BLOCK;
    h.send({ type: 'arm', lane: 6, startFrame: start, stopFrame: start + 19_200 });
    for (let q = 0; q < 2 + 8; q++) h.quantum([6]);
    const before = h.chunksFor(6).length;
    h.skip(MAX_GAP + 1);
    for (let q = 0; q < 200; q++) h.quantum([6]);
    const done = h.doneFor(6);
    expect(done).toHaveLength(1);
    expect(done[0]!.frames).toBe(0); // REFUSED — not a short take, and not a padded one
    expect(done[0]!.gapFrames).toBe(MAX_GAP + 1); // the cause, named
    // The punch-in was ON TIME; a refusal must not report it as a slip.
    expect(done[0]!.startFrame).toBe(start);
    expect(h.chunksFor(6)).toHaveLength(before); // nothing more was posted
    expect(MAX_GAP).toBe(4096); // the bound these numbers straddle
    expect(MAX_GAP).toBe(MAX_ARM_SLIP); // symmetric with the slide bound
  });

  it('pads EXACTLY at the bound (the boundary is honoured, not approximated)', () => {
    const h = makeHarness();
    const len = 3 * CHUNK_FRAMES;
    h.send({ type: 'arm', lane: 7, startFrame: 0, stopFrame: len });
    for (let q = 0; q < 8; q++) h.quantum([7]);
    h.skip(MAX_GAP);
    for (let q = 0; q < len / BLOCK + 2; q++) h.quantum([7]);
    const done = h.doneFor(7)[0]!;
    expect(done.frames).toBe(len);
    expect(done.gapFrames).toBe(MAX_GAP);
  });

  it('the bound is CUMULATIVE over the take — two small gaps that add up past it refuse', () => {
    // Symmetric with the slide bound (`slip + miss > MAX_ARM_SLIP`): a take
    // that has already absorbed most of a chunk of silence does not get a
    // fresh allowance for the next glitch.
    const h = makeHarness();
    h.send({ type: 'arm', lane: 0, startFrame: 0, stopFrame: 48_000 });
    for (let q = 0; q < 8; q++) h.quantum([0]);
    h.skip(MAX_GAP - 100);
    for (let q = 0; q < 8; q++) h.quantum([0]);
    expect(h.doneFor(0)).toHaveLength(0); // still recording after the first gap
    h.skip(101); // 4096 − 100 + 101 = 4097 > MAX_GAP
    h.quantum([0]);
    const done = h.doneFor(0);
    expect(done).toHaveLength(1);
    expect(done[0]!.frames).toBe(0);
    expect(done[0]!.gapFrames).toBe(MAX_GAP + 1);
  });

  it('eight lanes glitched by ONE clock all pad the same hole and stay sample-aligned', () => {
    const h = makeHarness();
    const lanes = [0, 1, 2, 3, 4, 5, 6, 7];
    for (const lane of lanes) h.send({ type: 'arm', lane, startFrame: 0, stopFrame: 2048 });
    for (let q = 0; q < 5; q++) h.quantum(lanes);
    h.skip(DEVICE_BUFFER);
    for (let q = 0; q < 16; q++) h.quantum(lanes);
    for (const lane of lanes) {
      const done = h.doneFor(lane)[0]!;
      expect(done.frames).toBe(2048);
      expect(done.gapFrames).toBe(DEVICE_BUFFER);
      const L = takeL(h.chunksFor(lane));
      expect(L[640]).toBe(0);
      expect(L[640 + DEVICE_BUFFER]).toBe(sampleAt(lane, 640 + DEVICE_BUFFER));
    }
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
    expect(h.doneFor(4)[0]!.frames).toBe(512); // exact — silence at its own frames, never a skip
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
