// packages/web/src/lib/audio/clip-recorder-node.test.ts
//
// The main-thread half of the clip recorder: the graph wiring off the
// mixmstrs tap seam, the port-protocol spelling, and the chunk pump into the
// slice-2 store's drain.
//
// THE WIRING TEST IS TOPOLOGY BY VALUE. Every fake node records its connects,
// so "lane N's worklet input is fed by channel N's leg pair" is asserted as
// (node, output, input) triples — the exact mistake class this guards is a
// second copy of the splitter-index maths metering channel 4 while recording
// channel 5, which is why the roster pick goes through `mixmstrsRecTapPair`
// and nothing here recomputes an index.
//
// THE PUMP TEST USES THE REAL ClipMediaDrain. Chunks flow through the real
// promise chain into a fake writer that records (bytes, position), so the
// stall-never-skip property is exercised, not stubbed: ordering, positions as
// a pure function of firstFrame, and `dropped === 0` are read off the drain
// itself.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CLIP_RECORDER_BYTES_PER_FRAME,
  CLIP_RECORDER_LANES,
  CLIP_RECORDER_PROCESSOR,
  armClipRecorderLane,
  attachClipRecorderSink,
  cancelClipRecorderLane,
  clipChunkToMediaChunk,
  coerceClipRecorderMsg,
  disconnectClipRecorderWiring,
  ensureClipRecorderWorklet,
  interleaveClipChunk,
  stopClipRecorderLane,
  wireClipRecorder,
  type ClipRecorderChunkMsg,
} from './clip-recorder-node';
import { CLIP_LANES } from './clip-types';
import type { MixmstrsRecTaps, MixmstrsTapLeg } from './mixmstrs';
import { ClipMediaDrain } from '../clip-media-drain';
import { clipMediaBytesPerFrame, type ClipMediaWriter } from '../clip-media-store';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface Connect {
  to: unknown;
  output: number;
  input: number;
}

class FakeNode {
  connections: Connect[] = [];
  disconnected = false;
  constructor(public label: string) {}
  connect(to: unknown, output = 0, input = 0): void {
    this.connections.push({ to, output, input });
  }
  disconnect(): void {
    this.disconnected = true;
  }
}

class FakeGain extends FakeNode {
  gain = { value: 1 };
}

class FakeCtx {
  destination = new FakeNode('destination');
  mergers: FakeNode[] = [];
  gains: FakeGain[] = [];
  addModuleCalls: string[] = [];
  addModuleFail = 0;
  audioWorklet = {
    addModule: async (url: string): Promise<void> => {
      this.addModuleCalls.push(url);
      if (this.addModuleFail > 0) {
        this.addModuleFail--;
        throw new Error('load failed');
      }
    },
  };
  createChannelMerger(n: number): FakeNode {
    const m = new FakeNode(`merger${this.mergers.length}(${n})`);
    this.mergers.push(m);
    return m;
  }
  createGain(): FakeGain {
    const g = new FakeGain(`gain${this.gains.length}`);
    this.gains.push(g);
    return g;
  }
}

class FakeWorkletNode extends FakeNode {
  static instances: FakeWorkletNode[] = [];
  port = {
    onmessage: null as ((e: MessageEvent) => void) | null,
    postMessage: vi.fn(),
  };
  constructor(
    public ctx: unknown,
    public name: string,
    public options: Record<string, unknown> | undefined,
  ) {
    super('worklet');
    FakeWorkletNode.instances.push(this);
  }
}

const g = globalThis as unknown as Record<string, unknown>;
let prevAWN: unknown;

beforeEach(() => {
  prevAWN = g.AudioWorkletNode;
  g.AudioWorkletNode = FakeWorkletNode;
  FakeWorkletNode.instances = [];
});
afterEach(() => {
  g.AudioWorkletNode = prevAWN;
});

/** A tap-roster fake: 16 distinct board legs, 16 splitter legs (one node,
 *  distinct output indices), one master pair on the same splitter. */
function makeTaps(): { taps: MixmstrsRecTaps; board: FakeNode[]; splitter: FakeNode } {
  const board = Array.from({ length: 16 }, (_, i) => new FakeNode(`board${i}`));
  const splitter = new FakeNode('splitter');
  const leg = (node: FakeNode, output: number): MixmstrsTapLeg =>
    ({ node: node as unknown as AudioNode, output });
  const taps: MixmstrsRecTaps = {
    board: board.map((n) => leg(n, 0)),
    postFader: Array.from({ length: 16 }, (_, i) => leg(splitter, 6 + i)),
    master: [leg(splitter, 0), leg(splitter, 1)],
  };
  return { taps, board, splitter };
}

// ---------------------------------------------------------------------------
// Module registration
// ---------------------------------------------------------------------------

describe('ensureClipRecorderWorklet', () => {
  it('adds the module ONCE per context — concurrent callers share the registration', async () => {
    const ctx = new FakeCtx();
    const c = ctx as unknown as BaseAudioContext;
    await Promise.all([ensureClipRecorderWorklet(c), ensureClipRecorderWorklet(c)]);
    await ensureClipRecorderWorklet(c);
    expect(ctx.addModuleCalls).toHaveLength(1);
  });
  it('a failed load does not poison the context — the next attempt retries', async () => {
    const ctx = new FakeCtx();
    ctx.addModuleFail = 1;
    const c = ctx as unknown as BaseAudioContext;
    await expect(ensureClipRecorderWorklet(c)).rejects.toThrow('load failed');
    await ensureClipRecorderWorklet(c); // retries and succeeds
    expect(ctx.addModuleCalls).toHaveLength(2);
  });
  it('rejects cleanly when the context has no audioWorklet', async () => {
    await expect(
      ensureClipRecorderWorklet({} as unknown as BaseAudioContext),
    ).rejects.toThrow(/AudioWorklet unavailable/);
  });
});

// ---------------------------------------------------------------------------
// Graph wiring
// ---------------------------------------------------------------------------

describe('wireClipRecorder — topology by value', () => {
  it('creates ONE eight-stereo-input node under the registered name', () => {
    const ctx = new FakeCtx();
    const { taps } = makeTaps();
    const w = wireClipRecorder(ctx as unknown as BaseAudioContext, taps, 0);
    const node = w.node as unknown as FakeWorkletNode;
    expect(node.name).toBe(CLIP_RECORDER_PROCESSOR);
    expect(node.options).toMatchObject({
      numberOfInputs: CLIP_RECORDER_LANES,
      channelCount: 2,
      channelCountMode: 'explicit',
    });
    // ⚠ THE CROSS-PACKAGE IDENTITY: the worklet's lane count IS the launcher's
    // lane count. The worklet scope cannot import CLIP_LANES, so the identity
    // is asserted here, where both constants are in scope.
    expect(CLIP_RECORDER_LANES).toBe(CLIP_LANES);
  });

  it('BOARD IN (default): lane N is fed by board legs 2N (→L) and 2N+1 (→R), merger → worklet input N', () => {
    const ctx = new FakeCtx();
    const { taps, board } = makeTaps();
    const w = wireClipRecorder(ctx as unknown as BaseAudioContext, taps, 0);
    expect(w.mergers).toHaveLength(CLIP_LANES);
    for (let lane = 0; lane < CLIP_LANES; lane++) {
      const merger = w.mergers[lane] as unknown as FakeNode;
      expect(board[2 * lane]!.connections).toEqual([{ to: merger, output: 0, input: 0 }]);
      expect(board[2 * lane + 1]!.connections).toEqual([{ to: merger, output: 0, input: 1 }]);
      expect(merger.connections).toEqual([{ to: w.node, output: 0, input: lane }]);
    }
  });

  it('POST FADER: lane N reads splitter outputs 6+2N / 7+2N — the roster indices, never recomputed here', () => {
    const ctx = new FakeCtx();
    const { taps, splitter } = makeTaps();
    const w = wireClipRecorder(ctx as unknown as BaseAudioContext, taps, 1);
    for (let lane = 0; lane < CLIP_LANES; lane++) {
      const merger = w.mergers[lane] as unknown as FakeNode;
      expect(splitter.connections).toContainEqual({ to: merger, output: 6 + 2 * lane, input: 0 });
      expect(splitter.connections).toContainEqual({ to: merger, output: 7 + 2 * lane, input: 1 });
    }
  });

  it('MASTER: every lane is fed the same mix-bus pair (eight copies of the mix is what was asked for)', () => {
    const ctx = new FakeCtx();
    const { taps, splitter } = makeTaps();
    const w = wireClipRecorder(ctx as unknown as BaseAudioContext, taps, 2);
    for (let lane = 0; lane < CLIP_LANES; lane++) {
      const merger = w.mergers[lane] as unknown as FakeNode;
      expect(splitter.connections).toContainEqual({ to: merger, output: 0, input: 0 });
      expect(splitter.connections).toContainEqual({ to: merger, output: 1, input: 1 });
    }
  });

  it('⚠ the keep-alive is wired: worklet → gain(0) → destination, or process() never runs', () => {
    const ctx = new FakeCtx();
    const { taps } = makeTaps();
    const w = wireClipRecorder(ctx as unknown as BaseAudioContext, taps, 0);
    const keepAlive = w.keepAlive as unknown as FakeGain;
    expect(keepAlive.gain.value).toBe(0); // pulled, never audible
    expect((w.node as unknown as FakeNode).connections).toContainEqual({
      to: keepAlive,
      output: 0,
      input: 0,
    });
    expect(keepAlive.connections).toEqual([{ to: ctx.destination, output: 0, input: 0 }]);
  });

  it('disconnectClipRecorderWiring tears down the plumbing (mergers, node, keep-alive)', () => {
    const ctx = new FakeCtx();
    const { taps } = makeTaps();
    const w = wireClipRecorder(ctx as unknown as BaseAudioContext, taps, 0);
    disconnectClipRecorderWiring(w);
    for (const m of w.mergers) expect((m as unknown as FakeNode).disconnected).toBe(true);
    expect((w.node as unknown as FakeNode).disconnected).toBe(true);
    expect((w.keepAlive as unknown as FakeNode).disconnected).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Port protocol — senders (the ONE spelling on the web side)
// ---------------------------------------------------------------------------

describe('protocol senders', () => {
  it('arm / stopAt / cancel post the exact message shapes the worklet pins on its side', () => {
    const port = { onmessage: null, postMessage: vi.fn() };
    const node = { port } as unknown as Pick<AudioWorkletNode, 'port'>;
    armClipRecorderLane(node, 3, { startFrame: 100, stopFrame: 600, unitFrames: 500 });
    armClipRecorderLane(node, 4, { startFrame: 100, stopFrame: null, unitFrames: 500 });
    stopClipRecorderLane(node, 4, 1100);
    cancelClipRecorderLane(node, 3);
    expect(port.postMessage.mock.calls.map((c) => c[0])).toEqual([
      { type: 'arm', lane: 3, startFrame: 100, stopFrame: 600 },
      { type: 'arm', lane: 4, startFrame: 100, stopFrame: null },
      { type: 'stopAt', lane: 4, stopFrame: 1100 },
      { type: 'cancel', lane: 3 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Chunk conversion
// ---------------------------------------------------------------------------

describe('coerceClipRecorderMsg', () => {
  const chunk = (over: Record<string, unknown> = {}) => ({
    type: 'chunk',
    lane: 2,
    firstFrame: 4096,
    frames: 4,
    data: new Float32Array(8),
    ...over,
  });
  it('accepts well-formed chunk and done messages', () => {
    expect(coerceClipRecorderMsg(chunk())).toEqual(chunk());
    expect(
      coerceClipRecorderMsg({ type: 'done', lane: 7, frames: 96_000, startFrame: 5_760 }),
    ).toEqual({ type: 'done', lane: 7, frames: 96_000, startFrame: 5_760 });
    // A REFUSAL — the worklet declining an arm that drained further past its
    // punch-in than the slide may absorb — is a WELL-FORMED `done` carrying
    // zero frames, not a malformed message to drop on the floor.
    expect(
      coerceClipRecorderMsg({ type: 'done', lane: 3, frames: 0, startFrame: 12_800 }),
    ).toEqual({ type: 'done', lane: 3, frames: 0, startFrame: 12_800 });
  });
  it('rejects everything malformed instead of throwing mid-take', () => {
    expect(coerceClipRecorderMsg(null)).toBeNull();
    expect(coerceClipRecorderMsg('chunk')).toBeNull();
    expect(coerceClipRecorderMsg(chunk({ lane: 8 }))).toBeNull();
    expect(coerceClipRecorderMsg(chunk({ lane: -1 }))).toBeNull();
    expect(coerceClipRecorderMsg(chunk({ firstFrame: -1 }))).toBeNull();
    expect(coerceClipRecorderMsg(chunk({ frames: 0 }))).toBeNull();
    expect(coerceClipRecorderMsg(chunk({ data: new Float32Array(7) }))).toBeNull(); // short
    expect(coerceClipRecorderMsg(chunk({ data: [0, 0, 0, 0, 0, 0, 0, 0] }))).toBeNull();
    expect(coerceClipRecorderMsg({ type: 'done', lane: 0, frames: -1, startFrame: 0 })).toBeNull();
    // ⚠ `startFrame` is REQUIRED. A `done` without it is a worklet this build
    // did not ship, and defaulting it would report "punched in exactly on
    // time" for a take nobody measured — the silent slide, back again.
    expect(coerceClipRecorderMsg({ type: 'done', lane: 0, frames: 128 })).toBeNull();
    expect(
      coerceClipRecorderMsg({ type: 'done', lane: 0, frames: 128, startFrame: NaN }),
    ).toBeNull();
    expect(coerceClipRecorderMsg({ type: 'noise', lane: 0 })).toBeNull();
  });
});

describe('interleave + bytes', () => {
  it('planar [L…,R…] → interleaved [L0,R0,L1,R1,…], exactly', () => {
    const planar = Float32Array.of(1, 2, 3, /* R: */ -1, -2, -3);
    expect(Array.from(interleaveClipChunk(planar, 3))).toEqual([1, -1, 2, -2, 3, -3]);
  });
  it('bytes are positioned pcm-f32 stereo: length = frames × 8, value-exact round-trip', () => {
    const msg: ClipRecorderChunkMsg = {
      type: 'chunk',
      lane: 0,
      firstFrame: 4096,
      frames: 3,
      data: Float32Array.of(0.5, -0.25, 1, 0.125, -1, 0),
    };
    const mc = clipChunkToMediaChunk(msg);
    expect(mc.firstFrame).toBe(4096);
    expect(mc.frames).toBe(3);
    expect(mc.bytes).toHaveLength(3 * CLIP_RECORDER_BYTES_PER_FRAME);
    const back = new Float32Array(mc.bytes.buffer, mc.bytes.byteOffset, 6);
    expect(Array.from(back)).toEqual([0.5, 0.125, -0.25, -1, 1, 0]);
  });
  it('pins the byte stride to the STORE’s own pcm-f32 stereo arithmetic — two files, one number', () => {
    expect(CLIP_RECORDER_BYTES_PER_FRAME).toBe(clipMediaBytesPerFrame('pcm-f32', 2));
  });
});

// ---------------------------------------------------------------------------
// The pump — chunks flow to the REAL drain (stall-never-skip)
// ---------------------------------------------------------------------------

interface Write {
  position: number;
  values: number[];
}

function makeWriter(failOn?: number): { writer: ClipMediaWriter; writes: Write[] } {
  const writes: Write[] = [];
  let attempt = 0;
  const writer: ClipMediaWriter = {
    mediaId: 'm-test',
    async write(bytes, position) {
      if (attempt++ === failOn) throw new Error('disk full');
      writes.push({
        position,
        values: Array.from(new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4)),
      });
    },
    async close() {},
  };
  return { writer, writes };
}

const planarChunk = (lane: number, firstFrame: number, frames: number, base: number) => ({
  type: 'chunk',
  lane,
  firstFrame,
  frames,
  data: Float32Array.from({ length: frames * 2 }, (_, i) =>
    i < frames ? base + i : -(base + (i - frames)),
  ),
});

describe('attachClipRecorderSink', () => {
  it('routes chunks through the REAL drain: positions = firstFrame × 8, in order, dropped === 0, done after the last chunk', async () => {
    const { writer, writes } = makeWriter();
    const drain = new ClipMediaDrain(writer, { bytesPerFrame: CLIP_RECORDER_BYTES_PER_FRAME });
    const done: [number, number, number][] = [];
    const port = { onmessage: null as ((e: MessageEvent) => void) | null, postMessage: vi.fn() };
    const handler = attachClipRecorderSink({ port } as unknown as Pick<AudioWorkletNode, 'port'>, {
      drainFor: (lane) => (lane === 1 ? drain : null),
      onDone: (lane, frames, startFrame) => done.push([lane, frames, startFrame]),
    });
    expect(port.onmessage).toBe(handler);

    handler({ data: planarChunk(1, 0, 2, 10) } as MessageEvent);
    handler({ data: planarChunk(1, 2, 2, 20) } as MessageEvent);
    handler({ data: { type: 'done', lane: 1, frames: 4, startFrame: 640 } } as MessageEvent);
    await drain.flush();

    expect(writes.map((w) => w.position)).toEqual([0, 2 * CLIP_RECORDER_BYTES_PER_FRAME]);
    // Interleaved on disk: [L0,R0,L1,R1] per chunk.
    expect(writes[0]!.values).toEqual([10, -10, 11, -11]);
    expect(writes[1]!.values).toEqual([20, -20, 21, -21]);
    expect(drain.dropped).toBe(0); // the never-drop property, read off the drain
    expect(drain.framesWritten).toBe(4);
    // The ACTUAL punch-in rides through to the sink — it is what the registry
    // compares against the start it asked for to see a slid take.
    expect(done).toEqual([[1, 4, 640]]);
  });

  it('a lane with no armed take drops the stray chunk on the floor (a late post after cancel), not an error', async () => {
    const { writer, writes } = makeWriter();
    const drain = new ClipMediaDrain(writer, { bytesPerFrame: CLIP_RECORDER_BYTES_PER_FRAME });
    const handler = attachClipRecorderSink(
      { port: { onmessage: null, postMessage: vi.fn() } } as unknown as Pick<AudioWorkletNode, 'port'>,
      { drainFor: (lane) => (lane === 0 ? drain : null), onDone: () => {} },
    );
    handler({ data: planarChunk(5, 0, 2, 10) } as MessageEvent); // lane 5: nothing armed
    handler({ data: 'junk' } as MessageEvent); // malformed: ignored
    await drain.flush();
    expect(writes).toHaveLength(0);
  });

  it('a failing write never becomes an unhandled rejection, and the drain records it for the commit path', async () => {
    const { writer, writes } = makeWriter(0); // first write throws
    const drain = new ClipMediaDrain(writer, { bytesPerFrame: CLIP_RECORDER_BYTES_PER_FRAME });
    const handler = attachClipRecorderSink(
      { port: { onmessage: null, postMessage: vi.fn() } } as unknown as Pick<AudioWorkletNode, 'port'>,
      { drainFor: () => drain, onDone: () => {} },
    );
    handler({ data: planarChunk(0, 0, 2, 10) } as MessageEvent);
    handler({ data: planarChunk(0, 2, 2, 20) } as MessageEvent);
    await drain.flush();
    expect(drain.error).toBeInstanceOf(Error);
    expect(writes).toHaveLength(1); // the later chunk still ran — no poisoned chain
  });
});
