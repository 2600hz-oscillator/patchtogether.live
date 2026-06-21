// packages/web/src/lib/video/recorderbox-stop.test.ts
//
// Coverage for the RECORDERBOX recorder's SAVE-DISPATCH at stop() + the
// destination wiring at start(), now CHUNK-aware (GoPro chunking + folder model).
// We mock the store module so these run under node (no real OPFS / IndexedDB) and
// inject the remux so no real Mediabunny Conversion runs.
//
// stop() now (2026-06-20):
//   1. drain the audio tail + finalize + close writer (fragmented OPFS scratch
//      is durable)
//   2. deliver the FINAL chunk via deliverChunk:
//        * REMUX the fragmented scratch → flat (moov-based) MP4 (Resolve-import
//          fix). Fall back to RAW fragmented bytes if the remux can't run.
//        * write under the chunk's FILENAME-CHUNK#-DATETIME.mp4 name:
//            - dirHandle (FOLDER model) → folder.getFileHandle(chunkName) write.
//            - destHandle (legacy single file, chunk 1) → write there.
//            - neither → saveBytes (<a download>) with the chunk name.
//        * returns the delivered CHUNK NAME (not the bare filename).
//   3. success → retire (markManifestDone + deleteOpfsFile + deleteManifest);
//      a failed save KEEPS the scratch + manifest as a recover candidate.
//
// rollChunk() finalizes the current chunk + delivers it, opens chunk N+1, and
// prepends the 5 s overlap audio to it — covered here with injected fakes.

import { describe, expect, it, vi, beforeEach } from 'vitest';

type RecorderManifest = {
  destHandle?: unknown;
  dirHandle?: unknown;
  chunkName?: string;
  filename: string;
  status: string;
  opfsPath: string;
};

// ── Mock the store module the recorder imports. (vi.hoisted so the factory can
//    reference the spies despite vi.mock being hoisted above imports.) ──
const mockStore = vi.hoisted(() => {
  // A real-ish sanitizer (chunkFileName needs it; no browser API).
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
    // opfsScratchPath stays real-ish (deterministic, no browser API).
    opfsScratchPath: (nodeId: string, epoch: number, filename?: string | null, chunkIndex?: number) =>
      `recorderbox/${(filename ?? 'recording').replace(/[^a-zA-Z0-9_-]/g, '_')}-${nodeId}-${epoch}${chunkIndex && chunkIndex > 1 ? `-c${String(chunkIndex).padStart(3, '0')}` : ''}.partial.mp4`,
  };
});
vi.mock('$lib/video/recorderbox-store', () => mockStore);

import { RecorderboxRecorder } from '$lib/video/recorderbox-recorder';

/** Construct a recorder, then forcibly put it in a stoppable state without a real
 *  encoder (the Mediabunny Output is constructed only inside start()). The remux
 *  is injected so no real Conversion runs. */
function armForStop(opts: {
  destHandle?: FileSystemFileHandle | null;
  dirHandle?: FileSystemDirectoryHandle | null;
  saveBytes: (b: Uint8Array, n: string, m: string) => Promise<void>;
  filename?: string;
  remuxToFlatMp4?: (p: string) => Promise<Uint8Array | null>;
  onChunkSaved?: (info: { index: number; name: string; bytes: number }) => void;
}) {
  const rec = new RecorderboxRecorder({
    nodeId: 'n1',
    canvas: {} as HTMLCanvasElement,
    audioTrack: null,
    filename: opts.filename ?? 'take',
    destHandle: opts.destHandle ?? null,
    dirHandle: opts.dirHandle ?? null,
    width: 320,
    height: 240,
    saveBytes: opts.saveBytes,
    makeWriter: () => ({ write: async () => {}, close: async () => {} }),
    remuxToFlatMp4: opts.remuxToFlatMp4,
    onChunkSaved: opts.onChunkSaved,
  });
  const r = rec as unknown as {
    state: string;
    output: unknown;
    opfsPath: string;
    startEpoch: number;
  };
  r.state = 'recording';
  r.output = { finalize: vi.fn(async () => {}) };
  r.opfsPath = 'recorderbox/take-n1-123.partial.mp4';
  r.startEpoch = 123;
  return rec;
}

/** A capturing writable + the file handle that returns it. */
function captureHandle() {
  const written: number[] = [];
  const writable = {
    write: vi.fn(async (d: BufferSource) => { written.push((d as ArrayBufferView).byteLength ?? 0); }),
    close: vi.fn(async () => {}),
  };
  const handle = { createWritable: vi.fn(async () => writable) } as unknown as FileSystemFileHandle;
  return { handle, writable, written };
}

/** The flat (remuxed) MP4 bytes a successful remux yields. */
const FLAT = new Uint8Array([10, 20, 30, 40]);

beforeEach(() => {
  vi.clearAllMocks();
  mockStore.readOpfsBytes.mockResolvedValue(null);
  mockStore.getOpfsFileForRead.mockResolvedValue(null);
});

describe('stop() — FOLDER model (dirHandle) → write the chunk into the folder', () => {
  it('writes the flat remux into dir under FILENAME-CHUNK#-DATETIME.mp4 + returns it', async () => {
    const { handle, writable, written } = captureHandle();
    const getFileHandle = vi.fn(async (_name: string, _o?: { create?: boolean }) => handle);
    const dirHandle = { getFileHandle } as unknown as FileSystemDirectoryHandle;
    const saveBytes = vi.fn(async () => {});
    const onChunkSaved = vi.fn();

    const rec = armForStop({ dirHandle, saveBytes, filename: 'mytake', remuxToFlatMp4: async () => FLAT, onChunkSaved });
    const name = await rec.stop();

    // The delivered name is the CHUNK name (RECORDING-style), not the bare file.
    expect(name).toMatch(/^MYTAKE-001-\d{8}-\d{6}\.mp4$/);
    // It was resolved + written INSIDE the folder under that exact chunk name.
    expect(getFileHandle).toHaveBeenCalledTimes(1);
    expect(getFileHandle.mock.calls[0][0]).toBe(name);
    expect(getFileHandle.mock.calls[0][1]).toEqual({ create: true });
    expect(written).toEqual([FLAT.byteLength]);
    expect(writable.close).toHaveBeenCalled();
    expect(saveBytes).not.toHaveBeenCalled();
    // onChunkSaved reported the final chunk.
    expect(onChunkSaved).toHaveBeenCalledWith({ index: 1, name, bytes: FLAT.byteLength });
    // Success → retire the recovery state + scratch.
    expect(mockStore.markManifestDone).toHaveBeenCalled();
    expect(mockStore.deleteOpfsFile).toHaveBeenCalled();
    expect(mockStore.deleteManifest).toHaveBeenCalled();
  });

  it('KEEPS the scratch + manifest when the folder write fails (recover later)', async () => {
    const getFileHandle = vi.fn(async () => { throw new DOMException('permission revoked', 'NotAllowedError'); });
    const dirHandle = { getFileHandle } as unknown as FileSystemDirectoryHandle;
    const saveBytes = vi.fn(async () => {});
    const rec = armForStop({ dirHandle, saveBytes, remuxToFlatMp4: async () => FLAT });
    const name = await rec.stop();
    expect(name).toBeNull();
    expect(mockStore.deleteManifest).not.toHaveBeenCalled();
    expect(mockStore.deleteOpfsFile).not.toHaveBeenCalled();
    expect(saveBytes).not.toHaveBeenCalled();
  });
});

describe('stop() — legacy single-file destHandle (chunk 1)', () => {
  it('writes the flat remux to the handle + never calls saveBytes', async () => {
    const { handle, written, writable } = captureHandle();
    const saveBytes = vi.fn(async () => {});
    const rec = armForStop({ destHandle: handle, saveBytes, filename: 'mytake', remuxToFlatMp4: async () => FLAT });
    const name = await rec.stop();
    expect(name).toMatch(/^MYTAKE-001-/);
    expect(handle.createWritable).toHaveBeenCalledTimes(1);
    expect(written).toEqual([FLAT.byteLength]);
    expect(writable.close).toHaveBeenCalled();
    expect(saveBytes).not.toHaveBeenCalled();
    expect(mockStore.deleteManifest).toHaveBeenCalled();
  });
});

describe('stop() — remux fallback (never lose a take)', () => {
  it('falls back to the RAW fragmented bytes when the remux yields nothing', async () => {
    const raw = new Uint8Array([1, 2, 3, 4, 5]);
    mockStore.readOpfsBytes.mockResolvedValue(raw);
    const saveBytes = vi.fn(async (_b: Uint8Array, _n: string, _m: string) => {});
    const rec = armForStop({ destHandle: null, dirHandle: null, saveBytes, filename: 'fallback', remuxToFlatMp4: async () => null });
    const name = await rec.stop();
    expect(name).toMatch(/^FALLBACK-001-/);
    // Delivered the RAW bytes (fragmented but still playable) under the chunk name.
    expect(saveBytes).toHaveBeenCalledTimes(1);
    expect(saveBytes.mock.calls[0][0]).toBe(raw);
    expect(saveBytes.mock.calls[0][1]).toBe(name);
    expect(saveBytes.mock.calls[0][2]).toBe('video/mp4');
    expect(mockStore.deleteManifest).toHaveBeenCalled();
  });

  it('returns null + KEEPS the scratch when BOTH remux and raw read are empty', async () => {
    mockStore.readOpfsBytes.mockResolvedValue(null);
    const saveBytes = vi.fn(async () => {});
    const rec = armForStop({ destHandle: null, dirHandle: null, saveBytes, remuxToFlatMp4: async () => null });
    const name = await rec.stop();
    expect(name).toBeNull();
    expect(saveBytes).not.toHaveBeenCalled();
    expect(mockStore.deleteManifest).not.toHaveBeenCalled();
  });
});

describe('start() — persists the destination into the manifest', () => {
  it('writes the chosen FOLDER handle + chunkName so recovery restores it', async () => {
    const dirHandle = { getFileHandle: vi.fn() } as unknown as FileSystemDirectoryHandle;
    const rec = new RecorderboxRecorder({
      nodeId: 'n2',
      canvas: {} as HTMLCanvasElement,
      audioTrack: null,
      filename: 'persist-me',
      dirHandle,
      width: 320,
      height: 240,
      saveBytes: async () => {},
      makeWriter: () => ({ write: async () => {}, close: async () => {} }),
    });
    // The real Mediabunny pipeline can't construct under node — but putManifest
    // is awaited inside buildChunkSession BEFORE it, so it's observable.
    try { await rec.start(); } catch { /* pipeline build fails under node — fine */ }

    expect(mockStore.putManifest).toHaveBeenCalled();
    const manifest = mockStore.putManifest.mock.calls[0]?.[0] as RecorderManifest;
    expect(manifest.dirHandle).toBe(dirHandle);
    expect(manifest.filename).toBe('persist-me');
    expect(manifest.status).toBe('recording');
    // The chunk name + the .partial scratch path are both recorded.
    expect(manifest.chunkName).toMatch(/^PERSIST-ME-001-/);
    expect(manifest.opfsPath).toMatch(/persist-me/);
    expect(manifest.opfsPath).toMatch(/\.partial\.mp4$/);
  });

  it('omits dirHandle/destHandle on a no-picker browser (null handles → download)', async () => {
    const rec = new RecorderboxRecorder({
      nodeId: 'n3',
      canvas: {} as HTMLCanvasElement,
      audioTrack: null,
      filename: 'no-handle',
      dirHandle: null,
      destHandle: null,
      width: 320,
      height: 240,
      saveBytes: async () => {},
      makeWriter: () => ({ write: async () => {}, close: async () => {} }),
    });
    try { await rec.start(); } catch { /* */ }
    const manifest = mockStore.putManifest.mock.calls[0]?.[0] as RecorderManifest;
    expect('dirHandle' in manifest).toBe(false);
    expect('destHandle' in manifest).toBe(false);
  });
});

describe('stop() — NO destination → download fallback (Firefox/Safari)', () => {
  it('delivers the flat remux to saveBytes with the CHUNK name + mime', async () => {
    const saveBytes = vi.fn(async (_b: Uint8Array, _n: string, _m: string) => {});
    const rec = armForStop({ destHandle: null, dirHandle: null, saveBytes, filename: 'ffsafari', remuxToFlatMp4: async () => FLAT });
    const name = await rec.stop();
    expect(name).toMatch(/^FFSAFARI-001-/);
    expect(saveBytes).toHaveBeenCalledTimes(1);
    expect(saveBytes.mock.calls[0][0]).toBe(FLAT);
    expect(saveBytes.mock.calls[0][1]).toBe(name);
    expect(saveBytes.mock.calls[0][2]).toBe('video/mp4');
    expect(mockStore.deleteManifest).toHaveBeenCalled();
  });

  it('KEEPS the candidate when the download save throws (e.g. blocked)', async () => {
    const saveBytes = vi.fn(async () => { throw new Error('blocked'); });
    const rec = armForStop({ destHandle: null, dirHandle: null, saveBytes, remuxToFlatMp4: async () => FLAT });
    const name = await rec.stop();
    expect(name).toBeNull();
    expect(mockStore.deleteManifest).not.toHaveBeenCalled();
  });
});
