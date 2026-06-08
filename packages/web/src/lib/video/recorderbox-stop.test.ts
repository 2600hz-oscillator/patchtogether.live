// packages/web/src/lib/video/recorderbox-stop.test.ts
//
// Coverage for the RECORDERBOX recorder's SAVE-DISPATCH at stop() + the
// destination-handle wiring at start() — the prompt-at-start / stream-to-chosen-
// path refactor. We mock the store module so these run under node (no real OPFS
// / IndexedDB): we drive what streamOpfsToWritable "wrote" + what bytes a full
// read returns, and assert which save path the recorder takes.
//
//   * destHandle present  → stop() STREAMS the OPFS scratch into the handle
//     (createWritable → streamOpfsToWritable), NEVER calling saveBytes.
//   * destHandle absent   → stop() reads bytes + calls saveBytes (download).
//   * stream/save failure → KEEP the scratch + manifest (recover candidate);
//     success → retire (markManifestDone + deleteOpfsFile + deleteManifest).
//   * start() persists the destHandle into the manifest (recovery restores it).

import { describe, expect, it, vi, beforeEach } from 'vitest';

type StreamSink = { write: (d: BufferSource) => Promise<void>; close: () => Promise<void> };
type RecorderManifest = { destHandle?: unknown; filename: string; status: string; opfsPath: string };

// ── Mock the store module the recorder imports. (vi.hoisted so the factory can
//    reference the spies despite vi.mock being hoisted above imports.) ──
const mockStore = vi.hoisted(() => {
  // Note: explicit fn types so .mockImplementation can take the real arity.
  return {
    putManifest: vi.fn((_m: RecorderManifest): Promise<void> => Promise.resolve()),
    markManifestDone: vi.fn((_p: string): Promise<void> => Promise.resolve()),
    deleteManifest: vi.fn((_p: string): Promise<void> => Promise.resolve()),
    deleteOpfsFile: vi.fn((_p: string): Promise<void> => Promise.resolve()),
    streamOpfsToWritable: vi.fn((_p: string, _sink: StreamSink): Promise<number> => Promise.resolve(0)),
    readOpfsBytes: vi.fn((_p: string): Promise<Uint8Array | null> => Promise.resolve(null)),
    hasOpfs: () => true,
    // opfsScratchPath stays real-ish (deterministic, no browser API).
    opfsScratchPath: (nodeId: string, epoch: number, filename?: string | null) =>
      `recorderbox/${(filename ?? 'recording').replace(/[^a-zA-Z0-9_-]/g, '_')}-${nodeId}-${epoch}.partial.mp4`,
  };
});
vi.mock('$lib/video/recorderbox-store', () => mockStore);

import { RecorderboxRecorder } from '$lib/video/recorderbox-recorder';

/** A minimal Mediabunny Output double so start()/stop() drive cleanly without a
 *  real encoder. We never call frame(), so video/audio sources aren't needed. */
function makeFakeOutput() {
  return {
    addVideoTrack: vi.fn(),
    addAudioTrack: vi.fn(),
    start: vi.fn(async () => {}),
    finalize: vi.fn(async () => {}),
  };
}

/** Patch the recorder instance's private Mediabunny output + writer so start()
 *  doesn't construct the real pipeline. We can't inject the Output via opts, so
 *  we monkey-patch start to install our doubles right after the manifest write.
 *  Simpler: drive through the public API but stub the writer (makeWriter) and
 *  replace output via the private field after start() resolves is awkward — so
 *  instead we override start() construction by spying on the module's Output.
 *  Easiest robust approach: construct, call start(), then forcibly set state +
 *  output to a fake so stop() runs the save dispatch we care about. */
function armForStop(opts: {
  destHandle?: FileSystemFileHandle | null;
  saveBytes: (b: Uint8Array, n: string, m: string) => Promise<void>;
  filename?: string;
}) {
  const rec = new RecorderboxRecorder({
    nodeId: 'n1',
    canvas: {} as HTMLCanvasElement,
    audioTrack: null,
    filename: opts.filename ?? 'take',
    destHandle: opts.destHandle ?? null,
    width: 320,
    height: 240,
    saveBytes: opts.saveBytes,
    makeWriter: () => ({ write: async () => {}, close: async () => {} }),
  });
  // Reach into the instance to put it in a stoppable state without a real
  // encoder (the Mediabunny Output is constructed only inside start()).
  const r = rec as unknown as {
    state: string;
    output: unknown;
    opfsPath: string;
    startEpoch: number;
  };
  r.state = 'recording';
  r.output = makeFakeOutput();
  r.opfsPath = 'recorderbox/take-n1-123.partial.mp4';
  r.startEpoch = 123;
  return rec;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockStore.streamOpfsToWritable.mockResolvedValue(0);
  mockStore.readOpfsBytes.mockResolvedValue(null);
});

describe('stop() — destination-handle present → STREAM to the chosen path', () => {
  it('streams the OPFS scratch into the handle + never calls saveBytes', async () => {
    const written: number[] = [];
    const writable = {
      write: vi.fn(async (d: BufferSource) => { written.push((d as ArrayBufferView).byteLength ?? 0); }),
      close: vi.fn(async () => {}),
    };
    const destHandle = { createWritable: vi.fn(async () => writable) } as unknown as FileSystemFileHandle;
    const saveBytes = vi.fn(async () => {});

    // The recorder hands the handle's writable to streamOpfsToWritable; emulate a
    // real streamed copy by driving the sink it's given.
    mockStore.streamOpfsToWritable.mockImplementation(async (_path: string, sink: { write: (d: BufferSource) => Promise<void>; close: () => Promise<void> }) => {
      await sink.write(new Uint8Array(4096) as unknown as BufferSource);
      await sink.write(new Uint8Array(2048) as unknown as BufferSource);
      await sink.close();
      return 6144;
    });

    const rec = armForStop({ destHandle, saveBytes, filename: 'mytake' });
    const name = await rec.stop();

    expect(name).toBe('mytake');
    expect(destHandle.createWritable).toHaveBeenCalledTimes(1);
    expect(mockStore.streamOpfsToWritable).toHaveBeenCalledTimes(1);
    // The chunks reached the handle's writable, in pieces (not one full read).
    expect(written).toEqual([4096, 2048]);
    expect(writable.close).toHaveBeenCalled();
    // The download fallback was NOT used.
    expect(saveBytes).not.toHaveBeenCalled();
    expect(mockStore.readOpfsBytes).not.toHaveBeenCalled();
    // Success → retire the recovery state + scratch.
    expect(mockStore.markManifestDone).toHaveBeenCalled();
    expect(mockStore.deleteOpfsFile).toHaveBeenCalled();
    expect(mockStore.deleteManifest).toHaveBeenCalled();
  });

  it('KEEPS the scratch + manifest when the handle write fails (recover later)', async () => {
    const destHandle = {
      createWritable: vi.fn(async () => { throw new DOMException('permission revoked', 'NotAllowedError'); }),
    } as unknown as FileSystemFileHandle;
    const saveBytes = vi.fn(async () => {});
    const rec = armForStop({ destHandle, saveBytes });
    const name = await rec.stop();
    expect(name).toBeNull();
    // Did NOT retire — the manifest stays a recover candidate.
    expect(mockStore.deleteManifest).not.toHaveBeenCalled();
    expect(mockStore.deleteOpfsFile).not.toHaveBeenCalled();
    expect(saveBytes).not.toHaveBeenCalled();
  });
});

describe('start() — persists the destination handle into the manifest', () => {
  it('writes the chosen handle so crash-recovery can restore the same path', async () => {
    const destHandle = { createWritable: vi.fn() } as unknown as FileSystemFileHandle;
    const rec = new RecorderboxRecorder({
      nodeId: 'n2',
      canvas: {} as HTMLCanvasElement,
      audioTrack: null,
      filename: 'persist-me',
      destHandle,
      width: 320,
      height: 240,
      saveBytes: async () => {},
      makeWriter: () => ({ write: async () => {}, close: async () => {} }),
    });
    // The real Mediabunny pipeline can't construct under node — but putManifest
    // is awaited BEFORE it, so the manifest write is observable regardless.
    try { await rec.start(); } catch { /* pipeline build fails under node — fine */ }

    expect(mockStore.putManifest).toHaveBeenCalled();
    const manifest = mockStore.putManifest.mock.calls[0]?.[0] as RecorderManifest;
    expect(manifest.destHandle).toBe(destHandle);
    expect(manifest.filename).toBe('persist-me');
    expect(manifest.status).toBe('recording');
    // The scratch path bakes in the (sanitized) filename + the .partial marker.
    expect(manifest.opfsPath).toMatch(/persist-me/);
    expect(manifest.opfsPath).toMatch(/\.partial\.mp4$/);
  });

  it('omits destHandle from the manifest on a no-picker browser (null handle)', async () => {
    const rec = new RecorderboxRecorder({
      nodeId: 'n3',
      canvas: {} as HTMLCanvasElement,
      audioTrack: null,
      filename: 'no-handle',
      destHandle: null,
      width: 320,
      height: 240,
      saveBytes: async () => {},
      makeWriter: () => ({ write: async () => {}, close: async () => {} }),
    });
    try { await rec.start(); } catch { /* */ }
    const manifest = mockStore.putManifest.mock.calls[0]?.[0] as RecorderManifest;
    expect('destHandle' in manifest).toBe(false);
  });
});

describe('stop() — NO destination handle → download fallback (Firefox/Safari)', () => {
  it('reads bytes + calls saveBytes with the filename + mime', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    mockStore.readOpfsBytes.mockResolvedValue(bytes);
    const saveBytes = vi.fn(async () => {});
    const rec = armForStop({ destHandle: null, saveBytes, filename: 'ffsafari' });
    const name = await rec.stop();
    expect(name).toBe('ffsafari');
    expect(mockStore.streamOpfsToWritable).not.toHaveBeenCalled();
    expect(saveBytes).toHaveBeenCalledTimes(1);
    expect(saveBytes).toHaveBeenCalledWith(bytes, 'ffsafari', 'video/mp4');
    expect(mockStore.deleteManifest).toHaveBeenCalled();
  });

  it('KEEPS the candidate when the download save throws (e.g. blocked)', async () => {
    mockStore.readOpfsBytes.mockResolvedValue(new Uint8Array([9, 9, 9]));
    const saveBytes = vi.fn(async () => { throw new Error('blocked'); });
    const rec = armForStop({ destHandle: null, saveBytes });
    const name = await rec.stop();
    expect(name).toBeNull();
    expect(mockStore.deleteManifest).not.toHaveBeenCalled();
  });
});
