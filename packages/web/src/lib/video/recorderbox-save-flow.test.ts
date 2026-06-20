// packages/web/src/lib/video/recorderbox-save-flow.test.ts
//
// Coverage for the RECORDERBOX save-FLOW glue (recorderbox-save-flow.ts) the
// card uses: prompt-for-destination-at-START + stream-to-chosen-handle. Browser
// APIs are injected so these run under node with no real picker / OPFS.
//
//   * promptSaveDestination: picker success → handle; user dismiss → 'cancel'
//     (caller must NOT start recording → no manifest/scratch); no-picker
//     browser → null (download path).
//   * streamToHandle: opens a writable + streams the OPFS scratch in chunks.

import { describe, expect, it, vi } from 'vitest';
import {
  promptSaveDestination,
  streamToHandle,
  promptSaveFolder,
  fileExistsInDir,
  fileHandleInDir,
} from '$lib/video/recorderbox-save-flow';
import type { ChunkSink } from '$lib/video/recorderbox-store';

describe('promptSaveFolder — pick the destination FOLDER once (Tweak 1 + 3)', () => {
  it('returns the directory handle on picker success (readwrite mode)', async () => {
    const dir = { getFileHandle: vi.fn() } as unknown as FileSystemDirectoryHandle;
    let opts: { id?: string; mode?: string } | undefined;
    const picker = vi.fn(async (o?: { id?: string; mode?: 'read' | 'readwrite' }) => { opts = o; return dir; });
    const got = await promptSaveFolder({ picker, hasPicker: () => true });
    expect(got).toBe(dir);
    expect(opts?.mode).toBe('readwrite');
  });

  it('returns "cancel" when the user DISMISSES the picker (AbortError)', async () => {
    const picker = vi.fn(async () => { throw new DOMException('aborted', 'AbortError'); });
    expect(await promptSaveFolder({ picker, hasPicker: () => true })).toBe('cancel');
  });

  it('returns "cancel" on any other rejection too (fail safe → revert toggle)', async () => {
    const picker = vi.fn(async () => { throw new Error('weird'); });
    expect(await promptSaveFolder({ picker, hasPicker: () => true })).toBe('cancel');
  });

  it('returns null on a no-directory-picker browser (Firefox/Safari → download)', async () => {
    const picker = vi.fn();
    expect(await promptSaveFolder({ picker, hasPicker: () => false })).toBeNull();
    expect(picker).not.toHaveBeenCalled();
  });
});

describe('fileExistsInDir — the OVERWRITE check', () => {
  it('returns true when getFileHandle(create:false) RESOLVES (file exists)', async () => {
    const getFileHandle = vi.fn(async (_n: string, o?: { create?: boolean }) => {
      expect(o).toEqual({ create: false }); // never CREATE during the existence probe
      return {} as FileSystemFileHandle;
    });
    const dir = { getFileHandle } as unknown as FileSystemDirectoryHandle;
    expect(await fileExistsInDir(dir, 'RECORDING-001-20260620-143005.mp4')).toBe(true);
  });

  it('returns false on NotFoundError (does not exist)', async () => {
    const getFileHandle = vi.fn(async () => { throw new DOMException('nope', 'NotFoundError'); });
    const dir = { getFileHandle } as unknown as FileSystemDirectoryHandle;
    expect(await fileExistsInDir(dir, 'nope.mp4')).toBe(false);
  });

  it('returns false (never throws) on any probe error — do not block recording', async () => {
    const getFileHandle = vi.fn(async () => { throw new Error('flaky'); });
    const dir = { getFileHandle } as unknown as FileSystemDirectoryHandle;
    expect(await fileExistsInDir(dir, 'x.mp4')).toBe(false);
  });
});

describe('fileHandleInDir — resolve (create) a chunk file handle', () => {
  it('creates the named file inside the folder', async () => {
    const fh = {} as FileSystemFileHandle;
    const getFileHandle = vi.fn(async (n: string, o?: { create?: boolean }) => {
      expect(n).toBe('RECORDING-002-20260620-144005.mp4');
      expect(o).toEqual({ create: true });
      return fh;
    });
    const dir = { getFileHandle } as unknown as FileSystemDirectoryHandle;
    expect(await fileHandleInDir(dir, 'RECORDING-002-20260620-144005.mp4')).toBe(fh);
  });
});

describe('promptSaveDestination — prompt at recording START', () => {
  it('returns the chosen handle on picker success, with the sanitized name', async () => {
    const handle = { createWritable: vi.fn() } as unknown as FileSystemFileHandle;
    let suggested: string | undefined;
    const picker = vi.fn(async (o: { suggestedName?: string }) => {
      suggested = o.suggestedName;
      return handle;
    });
    const dest = await promptSaveDestination('My Take', { picker, hasPicker: () => true });
    expect(dest).toBe(handle);
    // Suggested name is sanitized + carries the .mp4 extension.
    expect(suggested).toBe('My Take.mp4');
  });

  it('returns "cancel" when the user DISMISSES the picker (AbortError)', async () => {
    const picker = vi.fn(async () => {
      throw new DOMException('The user aborted a request.', 'AbortError');
    });
    const dest = await promptSaveDestination('x', { picker, hasPicker: () => true });
    // 'cancel' is the signal the caller uses to NOT start recording (no manifest,
    // no OPFS scratch — start() is never reached).
    expect(dest).toBe('cancel');
  });

  it('returns "cancel" on any other picker rejection too (fail safe)', async () => {
    const picker = vi.fn(async () => { throw new Error('weird'); });
    const dest = await promptSaveDestination('x', { picker, hasPicker: () => true });
    expect(dest).toBe('cancel');
  });

  it('returns null on a no-picker browser (Firefox/Safari → download path)', async () => {
    const picker = vi.fn();
    const dest = await promptSaveDestination('x', { picker, hasPicker: () => false });
    expect(dest).toBeNull();
    expect(picker).not.toHaveBeenCalled();
  });
});

describe('streamToHandle — open writable + chunked OPFS copy', () => {
  it('opens createWritable + streams the scratch into it, returning total bytes', async () => {
    const writes: number[] = [];
    let closed = false;
    const writable = {
      write: vi.fn(async (d: BufferSource) => { writes.push((d as ArrayBufferView).byteLength ?? 0); }),
      close: vi.fn(async () => { closed = true; }),
    };
    const handle = { createWritable: vi.fn(async () => writable) } as unknown as FileSystemFileHandle;

    // Inject a streaming copy that delivers two chunks through the sink it's
    // handed (the same sink wired to the writable).
    const stream = vi.fn(async (path: string, sink: ChunkSink) => {
      expect(path).toBe('recorderbox/take.partial.mp4');
      await sink.write(new Uint8Array(1000) as unknown as BufferSource);
      await sink.write(new Uint8Array(500) as unknown as BufferSource);
      await sink.close();
      return 1500;
    });

    const written = await streamToHandle('recorderbox/take.partial.mp4', handle, { stream });
    expect(written).toBe(1500);
    expect(handle.createWritable).toHaveBeenCalledTimes(1);
    // Chunked through to the real writable — not one full-buffer write.
    expect(writes).toEqual([1000, 500]);
    expect(closed).toBe(true);
  });
});
