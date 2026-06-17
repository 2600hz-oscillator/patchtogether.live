// packages/web/src/lib/video/recorderbox-stop.test.ts
//
// Coverage for the RECORDERBOX recorder's SAVE-DISPATCH at stop() + the
// destination-handle wiring at start(). We mock the store module so these run
// under node (no real OPFS / IndexedDB) and inject the remux so no real
// Mediabunny Conversion runs.
//
// stop() now (2026-06-17):
//   1. finalize + close writer (the fragmented OPFS scratch is durable)
//   2. REMUX the fragmented scratch → a flat (moov-based) MP4 for delivery (the
//      DaVinci-Resolve-import fix). If the remux can't run, fall back to the RAW
//      fragmented bytes so a take is never lost.
//   3. deliver:
//        * destHandle present → write the flat bytes to the chosen path
//          (createWritable), NEVER calling saveBytes.
//        * destHandle absent  → saveBytes (the <a download> blob fallback).
//   4. success → retire (markManifestDone + deleteOpfsFile + deleteManifest);
//      a failed save KEEPS the scratch + manifest as a recover candidate.

import { describe, expect, it, vi, beforeEach } from 'vitest';

type RecorderManifest = { destHandle?: unknown; filename: string; status: string; opfsPath: string };

// ── Mock the store module the recorder imports. (vi.hoisted so the factory can
//    reference the spies despite vi.mock being hoisted above imports.) ──
const mockStore = vi.hoisted(() => {
  return {
    putManifest: vi.fn((_m: RecorderManifest): Promise<void> => Promise.resolve()),
    markManifestDone: vi.fn((_p: string): Promise<void> => Promise.resolve()),
    deleteManifest: vi.fn((_p: string): Promise<void> => Promise.resolve()),
    deleteOpfsFile: vi.fn((_p: string): Promise<void> => Promise.resolve()),
    readOpfsBytes: vi.fn((_p: string): Promise<Uint8Array | null> => Promise.resolve(null)),
    getOpfsFileForRead: vi.fn((_p: string): Promise<File | null> => Promise.resolve(null)),
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

/** Construct a recorder, then forcibly put it in a stoppable state without a real
 *  encoder (the Mediabunny Output is constructed only inside start()). The remux
 *  is injected so no real Conversion runs. */
function armForStop(opts: {
  destHandle?: FileSystemFileHandle | null;
  saveBytes: (b: Uint8Array, n: string, m: string) => Promise<void>;
  filename?: string;
  remuxToFlatMp4?: (p: string) => Promise<Uint8Array | null>;
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
    remuxToFlatMp4: opts.remuxToFlatMp4,
  });
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

/** The flat (remuxed) MP4 bytes a successful remux yields. */
const FLAT = new Uint8Array([10, 20, 30, 40]);

beforeEach(() => {
  vi.clearAllMocks();
  mockStore.readOpfsBytes.mockResolvedValue(null);
  mockStore.getOpfsFileForRead.mockResolvedValue(null);
});

describe('stop() — destination-handle present → write the FLAT remux', () => {
  it('writes the remuxed (flat) bytes to the handle + never calls saveBytes', async () => {
    const written: number[] = [];
    const writable = {
      write: vi.fn(async (d: BufferSource) => { written.push((d as ArrayBufferView).byteLength ?? 0); }),
      close: vi.fn(async () => {}),
    };
    const destHandle = { createWritable: vi.fn(async () => writable) } as unknown as FileSystemFileHandle;
    const saveBytes = vi.fn(async () => {});

    const rec = armForStop({
      destHandle,
      saveBytes,
      filename: 'mytake',
      remuxToFlatMp4: async () => FLAT,
    });
    const name = await rec.stop();

    expect(name).toBe('mytake');
    expect(destHandle.createWritable).toHaveBeenCalledTimes(1);
    // The flat bytes reached the handle's writable (one write of the remux).
    expect(written).toEqual([FLAT.byteLength]);
    expect(writable.close).toHaveBeenCalled();
    // The download fallback was NOT used.
    expect(saveBytes).not.toHaveBeenCalled();
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
    const rec = armForStop({ destHandle, saveBytes, remuxToFlatMp4: async () => FLAT });
    const name = await rec.stop();
    expect(name).toBeNull();
    // Did NOT retire — the manifest stays a recover candidate.
    expect(mockStore.deleteManifest).not.toHaveBeenCalled();
    expect(mockStore.deleteOpfsFile).not.toHaveBeenCalled();
    expect(saveBytes).not.toHaveBeenCalled();
  });
});

describe('stop() — remux fallback (never lose a take)', () => {
  it('falls back to the RAW fragmented bytes when the remux yields nothing', async () => {
    const raw = new Uint8Array([1, 2, 3, 4, 5]);
    mockStore.readOpfsBytes.mockResolvedValue(raw);
    const saveBytes = vi.fn(async () => {});
    // remux returns null (e.g. corrupt scratch / Mediabunny unavailable).
    const rec = armForStop({ destHandle: null, saveBytes, filename: 'fallback', remuxToFlatMp4: async () => null });
    const name = await rec.stop();
    expect(name).toBe('fallback');
    // Delivered the RAW bytes (fragmented but still playable).
    expect(saveBytes).toHaveBeenCalledWith(raw, 'fallback', 'video/mp4');
    expect(mockStore.deleteManifest).toHaveBeenCalled();
  });

  it('returns null + KEEPS the scratch when BOTH remux and raw read are empty', async () => {
    mockStore.readOpfsBytes.mockResolvedValue(null);
    const saveBytes = vi.fn(async () => {});
    const rec = armForStop({ destHandle: null, saveBytes, remuxToFlatMp4: async () => null });
    const name = await rec.stop();
    expect(name).toBeNull();
    expect(saveBytes).not.toHaveBeenCalled();
    expect(mockStore.deleteManifest).not.toHaveBeenCalled();
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
  it('delivers the flat remux to saveBytes with the filename + mime', async () => {
    const saveBytes = vi.fn(async () => {});
    const rec = armForStop({ destHandle: null, saveBytes, filename: 'ffsafari', remuxToFlatMp4: async () => FLAT });
    const name = await rec.stop();
    expect(name).toBe('ffsafari');
    expect(saveBytes).toHaveBeenCalledTimes(1);
    expect(saveBytes).toHaveBeenCalledWith(FLAT, 'ffsafari', 'video/mp4');
    expect(mockStore.deleteManifest).toHaveBeenCalled();
  });

  it('KEEPS the candidate when the download save throws (e.g. blocked)', async () => {
    const saveBytes = vi.fn(async () => { throw new Error('blocked'); });
    const rec = armForStop({ destHandle: null, saveBytes, remuxToFlatMp4: async () => FLAT });
    const name = await rec.stop();
    expect(name).toBeNull();
    expect(mockStore.deleteManifest).not.toHaveBeenCalled();
  });
});
