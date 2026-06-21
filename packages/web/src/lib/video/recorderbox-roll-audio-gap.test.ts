// packages/web/src/lib/video/recorderbox-roll-audio-gap.test.ts
//
// REGRESSION: NO audio is lost across a chunk roll — including samples the
// long-lived AudioCaptureDrain pops DURING the finishing chunk's (slow)
// finalize() window.
//
// ── The bug this guards ──────────────────────────────────────────────────────
// rollChunk() used to set `currentAudioSource = null` BEFORE `await finalize()`
// and only install the new source afterwards. The single long-lived drain keeps
// running across that await: each loop pops the queue (next()) then calls
// addAudioToCurrentChunk(init), which EARLY-RETURNED while the source was null —
// so every sample captured during the finalize window (tens-to-hundreds ms, at
// each ~10-min boundary) was written to NEITHER chunk, NOR the overlap ring, NOR
// re-queued = a real audio GAP. The original roll test never posted audio during
// the finalize window, so it missed this.
//
// ── What's asserted ──────────────────────────────────────────────────────────
// With a SLOW (gated) finalize and live samples posted WHILE it's in flight:
//   * chunk N+1's audio source receives the overlap tail FIRST (timestamp 0),
//   * then EVERY during-finalize live sample, in capture order,
//   * none dropped, none duplicated, on a contiguous per-chunk audio clock.
//
// PURE: fakes for Output / CanvasSource / AudioSampleSource + a stubbed
// performance.now — the whole roll runs under node with NO real encoder. (Real
// mediabunny AudioSample is constructed in addAudioToCurrentChunk; it builds
// fine under node and exposes numberOfFrames/timestamp, which the fake source
// records.)

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

/** A fake Output whose finalize() can be GATED open: the first chunk's finalize
 *  blocks on an externally-resolved promise so the test can post live audio
 *  WHILE it's in flight (the finalize window). */
function gatedOutput(onFinalize?: () => Promise<void>) {
  const audioSources: unknown[] = [];
  let finalized = false;
  const out: MuxOutputLike = {
    addVideoTrack: vi.fn(),
    addAudioTrack: vi.fn((s: unknown) => { audioSources.push(s); }),
    start: vi.fn(async () => {}),
    finalize: vi.fn(async () => { if (onFinalize) await onFinalize(); finalized = true; }),
  };
  return { out, audioSources, get finalized() { return finalized; } };
}

/** A fake audio source recording every add()'d sample's (frames, timestamp) +
 *  a marker for the L/R sentinel values so we can verify ORDER + identity. */
function fakeAudioSource() {
  const added: Array<{ frames: number; timestamp: number; l: number; r: number }> = [];
  const src: AudioSampleSourceLike = {
    async add(sample: { numberOfFrames: number; timestamp: number; toAudioBuffer?: unknown }) {
      // The recorder builds `new AudioSample({ data:[L…,R…], ... })`. We can't
      // read its planar data back trivially, so the test tags identity via the
      // FRAME COUNT it posts (each during-finalize chunk has a unique size).
      added.push({ frames: sample.numberOfFrames, timestamp: sample.timestamp, l: 0, r: 0 });
    },
  };
  return { src, added };
}

/** A stub worklet MessagePort + a helper to inject captured chunks. */
function stubPort() {
  const port = {
    onmessage: null as ((e: MessageEvent) => void) | null,
    postMessage(_m: { type: string }) { /* arm/disarm — ignored */ },
  };
  return {
    port: port as unknown as MessagePort,
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

/** Pump the microtask queue so the drain loop can pop + process pushes. */
async function pumpMicro(n = 40) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}
/** Pump a macrotask (the drain's idle() when its queue is momentarily empty). */
async function pumpMacro() {
  await new Promise((r) => setTimeout(r, 0));
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

function tick(rec: RecorderboxRecorder, atMs: number) {
  nowMs = atMs;
  rec.frame();
}

const SR = 48_000;
const FLAT = new Uint8Array([1, 2, 3, 4]);

describe('roll audio gap — samples popped DURING a slow finalize are not lost', () => {
  it('every live sample captured during the finalize window lands in chunk 002 AFTER the overlap, in order', async () => {
    const outputs: ReturnType<typeof gatedOutput>[] = [];
    const audioSources: ReturnType<typeof fakeAudioSource>[] = [];
    const sp = stubPort();

    // Gate ONLY chunk 001's finalize so the test controls the finalize window.
    let releaseFinalize!: () => void;
    const finalizeGate = new Promise<void>((res) => { releaseFinalize = res; });
    let outIdx = 0;

    const rec = new RecorderboxRecorder({
      nodeId: 'gap1',
      canvas: {} as HTMLCanvasElement,
      audioTrack: null,
      audioCapture: { port: sp.port, sampleRate: SR },
      filename: 'recording',
      width: 320,
      height: 240,
      maxChunkSeconds: 1, // roll after 1 s
      saveBytes: async () => {},
      makeWriter: () => ({ write: async () => {}, close: async () => {} }),
      makeOutput: () => {
        const isFirst = outIdx++ === 0;
        const o = gatedOutput(isFirst ? () => finalizeGate : undefined);
        outputs.push(o);
        return o.out;
      },
      makeCanvasSource: () => ({ add: async () => {} } as CanvasSourceLike),
      makeAudioSampleSource: () => { const a = fakeAudioSource(); audioSources.push(a); return a.src; },
      remuxToFlatMp4: async () => FLAT,
    });

    await rec.start();
    expect(outputs).toHaveLength(1);
    expect(audioSources).toHaveLength(1);

    // ── Phase 1: fill chunk 001 with audio (also fills the 5 s overlap ring). ──
    // Three 100 ms blocks (4800 frames each) → drained into chunk 001. Pump a
    // MACROtask after each post so the drain wakes from its idle() (it parks on a
    // macrotask when its queue is momentarily empty) and processes the push.
    const PRE = SR / 10; // 4800
    for (let i = 0; i < 3; i++) {
      nowMs += 100;
      sp.post(chunk(PRE, 0.1 * (i + 1), -0.1 * (i + 1)), PRE);
      await pumpMicro();
      await pumpMacro();
      await pumpMicro();
    }
    // All 3 pre-roll blocks reached chunk 001's source.
    expect(audioSources[0].added.length).toBe(3);
    const chunk1Frames = audioSources[0].added.map((a) => a.frames);
    expect(chunk1Frames).toEqual([PRE, PRE, PRE]);

    // ── Phase 2: cross the roll boundary → rollChunk() starts + BLOCKS in
    //    finalize() (gate held). It has already snapshotted the overlap + armed
    //    the hold + nulled currentAudioSource at this point. ──
    tick(rec, 1100); // elapsed 1.1 s ≥ maxChunkSeconds(1) → rollChunk fires
    await pumpMicro(); // let rollChunk reach `await finalize()` (the gate)
    // The finishing output is mid-finalize: NOT yet finalized (gate still held).
    expect(outputs[0].finalized).toBe(false);

    // ── Phase 3: post live audio WHILE finalize is in flight. Each block has a
    //    UNIQUE frame count so we can assert order + identity downstream. These
    //    are exactly the samples the old code DROPPED. ──
    const DURING = [1000, 1500, 800, 2000]; // distinct sizes (frames)
    for (const f of DURING) {
      sp.post(chunk(f, 0.9, -0.9), f);
      await pumpMicro(); // drain pops + HOLDS each (source is null mid-roll)
      await pumpMacro(); // wake the drain from idle() if it parked
      await pumpMicro();
    }

    // Still mid-finalize; chunk 002's source isn't even built yet → it must have
    // received NOTHING so far (nothing leaked early/out of order).
    // (audioSources may still be length 1 here — chunk 002 source builds after the
    // gate releases.)
    expect(audioSources.length).toBe(1);

    // ── Phase 4: release finalize → roll completes: builds chunk 002, prepends
    //    the overlap, then FLUSHES the held during-finalize samples in order. ──
    releaseFinalize();
    await pumpMicro();
    await pumpMacro();
    await pumpMicro();
    await pumpMacro();
    await pumpMicro();

    // A second chunk session opened + chunk 001 finalized.
    expect(outputs.length).toBeGreaterThanOrEqual(2);
    expect(outputs[0].finalized).toBe(true);
    expect(audioSources.length).toBeGreaterThanOrEqual(2);

    const chunk2 = audioSources[1].added;
    // First sample = the prepended overlap tail (timestamp 0). Overlap = the last
    // ≤5 s of chunk 001 = all 3 PRE blocks (3*4800 = 14400 frames < 5 s @ 48k).
    expect(chunk2.length).toBeGreaterThan(0);
    expect(chunk2[0].timestamp).toBe(0);
    const overlapFrames = chunk2[0].frames;
    expect(overlapFrames).toBe(3 * PRE); // the whole captured tail (< 5 s)

    // After the overlap: EXACTLY the during-finalize blocks, in capture order,
    // none dropped, none duplicated.
    const afterOverlap = chunk2.slice(1).map((a) => a.frames);
    expect(afterOverlap).toEqual(DURING);

    // Contiguous per-chunk audio clock: timestamp[k] = (sum of prior frames)/SR,
    // strictly increasing, no gap/overlap — proves sample-accuracy across the roll.
    let acc = 0;
    for (const s of chunk2) {
      expect(s.timestamp).toBeCloseTo(acc / SR, 9);
      acc += s.frames;
    }
    // Total frames in chunk 002 = overlap + every during-finalize sample (zero loss).
    const totalAfter = afterOverlap.reduce((a, b) => a + b, 0);
    expect(acc).toBe(overlapFrames + totalAfter);
    expect(totalAfter).toBe(DURING.reduce((a, b) => a + b, 0));

    await rec.stop();
  });

  it('live samples popped AFTER the new source is installed but before the hold flushes still stay ORDERED behind the held ones', async () => {
    // Tighter ordering guard: a sample the drain pops in the brief window between
    // `currentAudioSource = newSrc` and heldDuringRoll being nulled must still be
    // held (appended to a fresh hold) — never reordered ahead of the overlap or
    // the earlier-held samples. We approximate by posting a steady stream around
    // the gate release and asserting strict monotonic timestamps + frame-count
    // order overall.
    const outputs: ReturnType<typeof gatedOutput>[] = [];
    const audioSources: ReturnType<typeof fakeAudioSource>[] = [];
    const sp = stubPort();
    let releaseFinalize!: () => void;
    const finalizeGate = new Promise<void>((res) => { releaseFinalize = res; });
    let outIdx = 0;

    const rec = new RecorderboxRecorder({
      nodeId: 'gap2',
      canvas: {} as HTMLCanvasElement,
      audioTrack: null,
      audioCapture: { port: sp.port, sampleRate: SR },
      filename: 'rec',
      width: 320,
      height: 240,
      maxChunkSeconds: 1,
      saveBytes: async () => {},
      makeWriter: () => ({ write: async () => {}, close: async () => {} }),
      makeOutput: () => {
        const isFirst = outIdx++ === 0;
        const o = gatedOutput(isFirst ? () => finalizeGate : undefined);
        outputs.push(o);
        return o.out;
      },
      makeCanvasSource: () => ({ add: async () => {} } as CanvasSourceLike),
      makeAudioSampleSource: () => { const a = fakeAudioSource(); audioSources.push(a); return a.src; },
      remuxToFlatMp4: async () => FLAT,
    });

    await rec.start();
    const PRE = SR / 20; // 2400 (50 ms)
    for (let i = 0; i < 2; i++) {
      nowMs += 50;
      sp.post(chunk(PRE, 0.2, -0.2), PRE);
      await pumpMicro();
      await pumpMacro();
      await pumpMicro();
    }
    tick(rec, 1100);
    await pumpMicro(); // let rollChunk reach the gated finalize (source now null)
    expect(outputs[0].finalized).toBe(false);

    // Stream during finalize (these are the samples the bug DROPPED).
    const DURING = [700, 900];
    for (const f of DURING) {
      sp.post(chunk(f, 0.5, -0.5), f);
      await pumpMicro();
      await pumpMacro();
      await pumpMicro();
    }

    // Release + immediately post a couple more (these race the new-source install).
    releaseFinalize();
    const AFTER = [600, 1100];
    for (const f of AFTER) {
      sp.post(chunk(f, 0.7, -0.7), f);
      await pumpMicro();
      await pumpMacro();
      await pumpMicro();
    }
    await pumpMacro();
    await pumpMicro();
    await pumpMacro();
    await pumpMicro();

    const chunk2 = audioSources[1].added;
    // Overlap first.
    expect(chunk2[0].timestamp).toBe(0);
    // STRICTLY increasing, CONTIGUOUS timestamps (no reorder, no gap, no dup).
    let acc = 0;
    for (const s of chunk2) {
      expect(s.timestamp).toBeCloseTo(acc / SR, 9);
      acc += s.frames;
    }
    // Every during + after sample is present (none dropped); they appear in the
    // order captured, after the overlap.
    const tail = chunk2.slice(1).map((a) => a.frames);
    for (const f of [...DURING, ...AFTER]) expect(tail).toContain(f);
    // The during-finalize ones precede the after-release ones (ordering preserved).
    const idxLastDuring = tail.lastIndexOf(DURING[DURING.length - 1]);
    const idxFirstAfter = tail.indexOf(AFTER[0]);
    expect(idxLastDuring).toBeLessThan(idxFirstAfter);

    await rec.stop();
  });
});
