// packages/web/src/lib/video/recorderbox-roll.test.ts
//
// Coverage for GoPro CHUNKING: the recorder rolls to a NEW file every
// `maxChunkSeconds`, with a 5-SECOND AUDIO OVERLAP (the last 5 s of chunk N
// prepended as the start of chunk N+1), and chunks are named
// FILENAME-CHUNK#-DATETIME.mp4. We inject fakes for the Output / CanvasSource /
// AudioSampleSource + a stubbed performance.now so the WHOLE roll runs under node
// with NO real encoder. Asserts:
//   * a roll finalizes chunk N, delivers it under chunk name 001, opens 002;
//   * the 5 s overlap audio is PREPENDED to chunk 002 first;
//   * each chunk's audio clock restarts at 0;
//   * a take under the threshold yields exactly ONE chunk (001);
//   * stop() finalizes the final chunk normally (no empty trailing file).

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

type RecorderManifest = { chunkName?: string; dirHandle?: unknown; opfsPath: string; filename: string; status: string };

const mockStore = vi.hoisted(() => {
  const sanitizeRecordingFilename = (raw: string | null | undefined, ext = 'mp4') => {
    let name = (raw ?? '').trim().replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
    name = name.replace(/\.(mp4|webm|mov|m4v)$/i, '');
    if (!name) name = 'recording-x';
    return `${name}.${ext}`;
  };
  return {
    putManifest: vi.fn((_m: RecorderManifest): Promise<void> => Promise.resolve()),
    markManifestDone: vi.fn((_p: string): Promise<void> => Promise.resolve()),
    deleteManifest: vi.fn((_p: string): Promise<void> => Promise.resolve()),
    deleteOpfsFile: vi.fn((_p: string): Promise<void> => Promise.resolve()),
    readOpfsBytes: vi.fn((_p: string): Promise<Uint8Array | null> => Promise.resolve(null)),
    getOpfsFileForRead: vi.fn((_p: string): Promise<File | null> => Promise.resolve(null)),
    hasOpfs: () => true,
    sanitizeRecordingFilename,
    opfsScratchPath: (nodeId: string, epoch: number, filename?: string | null, chunkIndex?: number) =>
      `recorderbox/${(filename ?? 'recording').replace(/[^a-zA-Z0-9_-]/g, '_')}-${nodeId}-${epoch}${chunkIndex && chunkIndex > 1 ? `-c${String(chunkIndex).padStart(3, '0')}` : ''}.partial.mp4`,
  };
});
vi.mock('$lib/video/recorderbox-store', () => mockStore);

import {
  RecorderboxRecorder,
  type MuxOutputLike,
  type CanvasSourceLike,
  type AudioSampleSourceLike,
} from '$lib/video/recorderbox-recorder';

/** A fake Output that records its lifecycle + which audio source(s) it received. */
function fakeOutput() {
  const audioSources: unknown[] = [];
  let finalized = false;
  const out: MuxOutputLike = {
    addVideoTrack: vi.fn(),
    addAudioTrack: vi.fn((s: unknown) => { audioSources.push(s); }),
    start: vi.fn(async () => {}),
    finalize: vi.fn(async () => { finalized = true; }),
  };
  return { out, audioSources, get finalized() { return finalized; } };
}

/** A fake audio source that records every add()'d sample's (frames, timestamp). */
function fakeAudioSource() {
  const added: Array<{ frames: number; timestamp: number }> = [];
  const src: AudioSampleSourceLike = {
    async add(sample: { numberOfFrames: number; timestamp: number }) {
      added.push({ frames: sample.numberOfFrames, timestamp: sample.timestamp });
    },
  };
  return { src, added };
}

/** A stub worklet MessagePort + a helper to inject captured chunks. */
function stubPort() {
  const posts: Array<{ type: string }> = [];
  const port = {
    onmessage: null as ((e: MessageEvent) => void) | null,
    postMessage(m: { type: string }) { posts.push(m); },
  };
  return {
    port: port as unknown as MessagePort,
    posts,
    post(data: Float32Array, frames: number) { port.onmessage?.({ data: { data, frames } } as MessageEvent); },
  };
}

/** A planar stereo chunk: L plane filled `lv`, R plane `rv`. */
function chunk(frames: number, lv: number, rv: number): Float32Array {
  const data = new Float32Array(frames * 2);
  data.fill(lv, 0, frames);
  data.fill(rv, frames, frames * 2);
  return data;
}

let nowMs = 0;
let realNow: () => number;

beforeEach(() => {
  vi.clearAllMocks();
  nowMs = 0;
  realNow = performance.now.bind(performance);
  performance.now = () => nowMs;
});
afterEach(() => {
  performance.now = realNow;
});

/** Drive enough rAF ticks to advance the recorder past a roll boundary. The CFR
 *  frame() reads performance.now() (our stub); advance time + call frame(). */
function tickTo(rec: RecorderboxRecorder, targetMs: number, stepMs = 33) {
  for (let t = nowMs + stepMs; t <= targetMs; t += stepMs) {
    nowMs = t;
    rec.frame();
  }
  nowMs = targetMs;
  rec.frame();
}

const SR = 48_000;
const FLAT = new Uint8Array([1, 2, 3, 4]);

describe('GoPro chunking — roll + 5 s audio overlap', () => {
  it('rolls at maxChunkSeconds: finalizes chunk 001, opens 002, prepends overlap', async () => {
    const outputs: ReturnType<typeof fakeOutput>[] = [];
    const audioSources: ReturnType<typeof fakeAudioSource>[] = [];
    // Per-chunk video adds (one capturing CanvasSource built per chunk).
    const videoAdds: Array<Array<{ ts: number; dur: number }>> = [];
    const sp = stubPort();
    const savedChunks: Array<{ index: number; name: string }> = [];

    const rec = new RecorderboxRecorder({
      nodeId: 'roll1',
      canvas: {} as HTMLCanvasElement,
      audioTrack: null,
      audioCapture: { port: sp.port, sampleRate: SR },
      filename: 'recording',
      width: 320,
      height: 240,
      // Roll after just 1 s of recording so the test is fast + deterministic.
      maxChunkSeconds: 1,
      saveBytes: async () => {},
      makeWriter: () => ({ write: async () => {}, close: async () => {} }),
      makeOutput: () => { const o = fakeOutput(); outputs.push(o); return o.out; },
      makeCanvasSource: () => {
        const adds: Array<{ ts: number; dur: number }> = [];
        videoAdds.push(adds);
        return { add: async (ts: number, dur?: number) => { adds.push({ ts, dur: dur ?? 0 }); } } as CanvasSourceLike;
      },
      makeAudioSampleSource: () => { const a = fakeAudioSource(); audioSources.push(a); return a.src; },
      remuxToFlatMp4: async () => FLAT,
      onChunkSaved: ({ index, name }) => { savedChunks.push({ index, name }); },
    });

    await rec.start();
    expect(outputs).toHaveLength(1);          // chunk 001's output built
    expect(audioSources).toHaveLength(1);     // chunk 001's audio source built

    // Feed ~1.2 s of audio into chunk 001 (so the 5 s ring has content; even <5 s
    // is fine — the overlap is "as much as we have"). 100 ms blocks.
    const blockFrames = SR / 10; // 100 ms
    for (let i = 0; i < 12; i++) {
      nowMs += 100;
      sp.post(chunk(blockFrames, 0.5, -0.5), blockFrames);
      await Promise.resolve(); // let the drain process the push
    }

    // Cross the 1 s roll boundary via rAF ticks.
    tickTo(rec, 1100);
    // Let the async roll settle (finalize + buildChunkSession + prepend).
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 20; i++) await Promise.resolve();

    // A roll happened: chunk 001 finalized + a SECOND session opened.
    expect(outputs.length).toBeGreaterThanOrEqual(2);
    expect(outputs[0].finalized).toBe(true);
    expect(audioSources.length).toBeGreaterThanOrEqual(2);

    // Chunk 001 was delivered under FILENAME-001-DATETIME.mp4.
    expect(savedChunks.some((c) => c.index === 1 && /^RECORDING-001-/.test(c.name))).toBe(true);

    // OVERLAP PREPEND: chunk 002's audio source received its FIRST sample at
    // timestamp 0 (the per-chunk clock restarts) and it carries the overlap tail.
    const chunk2 = audioSources[1].added;
    expect(chunk2.length).toBeGreaterThan(0);
    expect(chunk2[0].timestamp).toBe(0); // chunk 002 audio starts at 0, not the global clock.
    // The prepended overlap frame count is bounded by what we captured (≤ 5 s).
    expect(chunk2[0].frames).toBeGreaterThan(0);

    // Drive ~0.3 s of video into chunk 002 (well after the 1 s roll boundary) +
    // assert its PTS is CHUNK-RELATIVE: starts at 0 + on the even index/fps grid
    // (the regression for "rolled chunk thinks it's behind → floods catch-up").
    tickTo(rec, 1400, 33);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    const v2 = videoAdds[1];
    expect(v2.length).toBeGreaterThan(0);
    expect(v2[0].ts).toBe(0);                 // chunk 002 video PTS starts at 0
    v2.forEach((a, i) => expect(a.ts).toBeCloseTo(i / 30, 9)); // even grid, no flood
    // ~0.3 s @ 30 fps ≈ 9-10 frames — NOT a flooded 3×-per-tick burst.
    expect(v2.length).toBeLessThanOrEqual(14);

    await rec.stop();
  });

  it('a take UNDER the threshold yields exactly ONE chunk (001)', async () => {
    const outputs: ReturnType<typeof fakeOutput>[] = [];
    const sp = stubPort();
    const savedChunks: Array<{ index: number; name: string }> = [];
    const rec = new RecorderboxRecorder({
      nodeId: 'one1',
      canvas: {} as HTMLCanvasElement,
      audioTrack: null,
      audioCapture: { port: sp.port, sampleRate: SR },
      filename: 'jam',
      width: 320,
      height: 240,
      maxChunkSeconds: 600, // the real ~10-min default — never hit in this test.
      saveBytes: async () => {},
      makeWriter: () => ({ write: async () => {}, close: async () => {} }),
      makeOutput: () => { const o = fakeOutput(); outputs.push(o); return o.out; },
      makeCanvasSource: () => ({ add: async () => {} } as CanvasSourceLike),
      makeAudioSampleSource: () => fakeAudioSource().src,
      remuxToFlatMp4: async () => FLAT,
      onChunkSaved: ({ index, name }) => { savedChunks.push({ index, name }); },
    });
    await rec.start();
    // Record ~3 s of frames — well under the 600 s threshold → no roll.
    tickTo(rec, 3000);
    const name = await rec.stop();

    // Exactly one chunk session was ever built + delivered as 001.
    expect(outputs).toHaveLength(1);
    expect(name).toMatch(/^JAM-001-/);
    expect(savedChunks).toHaveLength(1);
    expect(savedChunks[0].index).toBe(1);
  });
});
