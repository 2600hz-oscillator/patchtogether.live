import { describe, it, expect, vi } from 'vitest';
import { syncedStore, getYjsDoc } from '@syncedstore/core';
import {
  savePerformanceZip,
  savePerformanceZipStreaming,
  ensureZipName,
  DEFAULT_PERF_ZIP_NAME,
  type ZipSavePicker,
} from './performance-save';
import { parsePerformanceZip, type PerformanceZipBundle } from './performance-zip';
import { makeEnvelope } from './persistence';
import { makePerformanceBundle } from './performance-bundle';

const BYTES = new Uint8Array([1, 2, 3, 4]);

describe('ensureZipName', () => {
  it('appends .zip when missing', () => {
    expect(ensureZipName('my show')).toBe('my_show.zip');
  });
  it('keeps an existing .zip (case-insensitive) without doubling it', () => {
    expect(ensureZipName('set1.zip')).toBe('set1.zip');
    expect(ensureZipName('SET1.ZIP')).toBe('SET1.ZIP');
  });
  it('strips path separators and reserved characters', () => {
    expect(ensureZipName('a/b\\c:d*e?f')).toBe('a_b_c_d_e_f.zip');
  });
  it('falls back to performance for an empty / dots-only name', () => {
    expect(ensureZipName('')).toBe('performance.zip');
    expect(ensureZipName('   ')).toBe('performance.zip');
    expect(ensureZipName('...')).toBe('performance.zip');
  });
  it('caps very long names', () => {
    const out = ensureZipName('x'.repeat(500));
    expect(out.endsWith('.zip')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(124);
  });
});

describe('savePerformanceZip — picker path (Chromium)', () => {
  it('writes the bytes to the chosen handle and reports saved', async () => {
    const writes: BufferSource[] = [];
    let closed = false;
    const handle = {
      createWritable: async () => ({
        write: async (d: BufferSource) => {
          writes.push(d);
        },
        close: async () => {
          closed = true;
        },
      }),
    };
    const picker = vi.fn<ZipSavePicker>(async () => handle as unknown as FileSystemFileHandle);

    const outcome = await savePerformanceZip(BYTES, { picker });

    expect(outcome).toBe('saved');
    expect(picker).toHaveBeenCalledTimes(1);
    // suggested name + a .zip accept type are offered to the dialog
    const arg = picker.mock.calls[0]![0];
    expect(arg.suggestedName).toBe(DEFAULT_PERF_ZIP_NAME);
    expect(arg.types).toBeTruthy();
    expect(writes).toEqual([BYTES]);
    expect(closed).toBe(true);
  });

  it('returns cancelled (no throw) when the user dismisses the picker', async () => {
    const picker = vi.fn<ZipSavePicker>(async () => {
      throw new DOMException('The user aborted a request.', 'AbortError');
    });
    const download = vi.fn();
    const outcome = await savePerformanceZip(BYTES, { picker, download });
    expect(outcome).toBe('cancelled');
    expect(download).not.toHaveBeenCalled(); // does NOT fall through to a forced download
  });

  it('honours a custom suggested name', async () => {
    const handle = { createWritable: async () => ({ write: async () => {}, close: async () => {} }) };
    const picker = vi.fn<ZipSavePicker>(async () => handle as unknown as FileSystemFileHandle);
    await savePerformanceZip(BYTES, { picker, suggestedName: 'tonight.zip' });
    expect(picker.mock.calls[0]![0].suggestedName).toBe('tonight.zip');
  });
});

describe('savePerformanceZip — fallback path (no picker)', () => {
  it('prompts for a name, ensures .zip, and downloads it', async () => {
    const download = vi.fn();
    const prompt = vi.fn(() => 'my live set');
    const outcome = await savePerformanceZip(BYTES, { picker: null, prompt, download });
    expect(outcome).toBe('saved');
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(download).toHaveBeenCalledWith(BYTES, 'my_live_set.zip');
  });

  it('returns cancelled when the prompt is dismissed', async () => {
    const download = vi.fn();
    const prompt = vi.fn(() => null);
    const outcome = await savePerformanceZip(BYTES, { picker: null, prompt, download });
    expect(outcome).toBe('cancelled');
    expect(download).not.toHaveBeenCalled();
  });
});

// ── STREAMING SAVE — the whole path, not just the compressor ──────────────
//
// The review this fixes said "test the ENTIRE save path, not only
// compression", and it was right: the suite above proved a fixed 4-byte buffer
// reached a fake handle, which is true of every implementation including the
// one that duplicated hundreds of MB. These cases drive the real
// `savePerformanceZipStreaming` end to end — pick, write, and the rollback.

/** A real (tiny) performance bundle so the archive going through the sink is
 *  an actual parseable .ptperf.zip and not a stand-in buffer. */
function realInput(): PerformanceZipBundle {
  const store = syncedStore<{ nodes: Record<string, unknown>; edges: Record<string, unknown> }>({
    nodes: {},
    edges: {},
  });
  const ydoc = getYjsDoc(store);
  ydoc.transact(() => {
    (store.nodes as Record<string, unknown>)['v1'] = {
      id: 'v1',
      type: 'videobox',
      position: { x: 1, y: 2 },
      data: {},
      params: {},
    };
  });
  const bundle = makePerformanceBundle({
    envelope: makeEnvelope(ydoc),
    nodes: { v1: { id: 'v1', type: 'videobox', data: {}, params: {} } },
    midiBindings: [],
    resolveMidiDevice: () => null,
    resolveGamepad: () => null,
  });
  const bytes = new Uint8Array(64 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) & 0xff;
  return {
    bundle,
    media: [{ nodeId: 'v1', handleId: 'h1', role: 'video', name: 'clip.webm', bytes }],
    savedAt: 1_700_000_000_000,
  };
}

/** A fake picker target that records everything the save path does to it. */
function makeHandle(opts: { existingSize?: number; hasRemove?: boolean } = {}) {
  const state = {
    chunks: [] as Uint8Array[],
    closed: false,
    aborted: false,
    removed: false,
  };
  const handle = {
    createWritable: async () => ({
      write: async (d: Uint8Array) => {
        state.chunks.push(d.slice());
      },
      close: async () => {
        state.closed = true;
      },
      abort: async () => {
        state.aborted = true;
      },
    }),
    getFile: async () => ({ size: opts.existingSize ?? 0 }),
    ...(opts.hasRemove === false
      ? {}
      : {
          remove: async () => {
            state.removed = true;
          },
        }),
  };
  return { handle, state };
}

function bytesOf(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

describe('savePerformanceZipStreaming — the whole save path', () => {
  it('streams a PARSEABLE archive into the picked handle, in many chunks', async () => {
    const input = realInput();
    const { handle, state } = makeHandle();
    const picker = vi.fn<ZipSavePicker>(async () => handle as unknown as FileSystemFileHandle);

    const outcome = await savePerformanceZipStreaming(input, { picker });

    expect(outcome).toBe('saved');
    expect(state.closed).toBe(true);
    expect(state.aborted).toBe(false);
    expect(state.removed).toBe(false);
    // Chunked, not one buffer — that IS the fix.
    expect(state.chunks.length).toBeGreaterThan(1);
    // ...and what landed is a real performance bundle, not a plausible blob.
    const parsed = parsePerformanceZip(bytesOf(state.chunks));
    expect(parsed.bundle.patch).toBeDefined();
    expect(parsed.media.map((m) => [m.nodeId, m.bytes.length])).toEqual([['v1', 64 * 1024]]);
  });

  it('CANCEL MID-WRITE: aborts the swap file, removes the empty target, reports cancelled', async () => {
    const input = realInput();
    const { handle, state } = makeHandle({ existingSize: 0 });
    const picker = vi.fn<ZipSavePicker>(async () => handle as unknown as FileSystemFileHandle);
    const signal = { aborted: false };
    // Cancel as soon as the first chunk lands.
    const orig = handle.createWritable;
    handle.createWritable = async () => {
      const w = await orig();
      return {
        ...w,
        write: async (d: Uint8Array) => {
          await w.write(d);
          signal.aborted = true;
        },
      };
    };

    const outcome = await savePerformanceZipStreaming(input, { picker, signal });

    expect(outcome).toBe('cancelled'); // never throws for a user cancel
    expect(state.aborted).toBe(true); // the partial swap file is discarded
    expect(state.closed).toBe(false); // closing would COMMIT a truncated file
    expect(state.removed).toBe(true); // the 0-byte target the picker created
  });

  it('⚠ NEVER deletes a file that already had content (overwrite + cancel)', async () => {
    // The hardening must not become the worse bug: someone overwriting tonight's
    // show file and hitting cancel keeps the file they already had. abort()
    // alone is the correct cleanup there — the swap file never commits.
    const input = realInput();
    const { handle, state } = makeHandle({ existingSize: 2_000_000 });
    const picker = vi.fn<ZipSavePicker>(async () => handle as unknown as FileSystemFileHandle);

    const outcome = await savePerformanceZipStreaming(input, {
      picker,
      signal: { aborted: true },
    });

    expect(outcome).toBe('cancelled');
    expect(state.aborted).toBe(true);
    expect(state.removed).toBe(false); // ← the assertion this test exists for
  });

  it('a WRITE FAILURE rolls back and rethrows (a failed save is not a save)', async () => {
    const input = realInput();
    const { handle, state } = makeHandle({ existingSize: 0 });
    handle.createWritable = async () => ({
      write: async () => {
        throw new Error('disk full');
      },
      close: async () => {
        state.closed = true;
      },
      abort: async () => {
        state.aborted = true;
      },
    });
    const picker = vi.fn<ZipSavePicker>(async () => handle as unknown as FileSystemFileHandle);

    await expect(savePerformanceZipStreaming(input, { picker })).rejects.toThrow(/disk full/);
    expect(state.aborted).toBe(true);
    expect(state.removed).toBe(true);
    expect(state.closed).toBe(false);
  });

  it('cleanup survives a browser with no remove() and no abort()', async () => {
    // Chromium <110 has no FileSystemHandle.remove; a stray 0-byte file is
    // acceptable, a thrown cleanup masking the real error is not.
    const input = realInput();
    let closed = false;
    const handle = {
      createWritable: async () => ({
        write: async () => {},
        close: async () => {
          closed = true;
        },
      }),
    };
    const picker = vi.fn<ZipSavePicker>(async () => handle as unknown as FileSystemFileHandle);
    const outcome = await savePerformanceZipStreaming(input, {
      picker,
      signal: { aborted: true },
    });
    expect(outcome).toBe('cancelled');
    expect(closed).toBe(true); // no abort() → close() is the best we can do
  });

  it('a dismissed picker is cancelled, and nothing is built', async () => {
    const picker = vi.fn<ZipSavePicker>(async () => {
      throw new DOMException('The user aborted a request.', 'AbortError');
    });
    const download = vi.fn();
    expect(await savePerformanceZipStreaming(realInput(), { picker, download })).toBe('cancelled');
    expect(download).not.toHaveBeenCalled();
  });

  it('NO PICKER (Firefox/Safari): falls back to build + download, still parseable', async () => {
    const download = vi.fn();
    const prompt = vi.fn(() => 'tonight');
    const seen: number[] = [];
    const outcome = await savePerformanceZipStreaming(realInput(), {
      picker: null,
      prompt,
      download,
      onProgress: (n) => seen.push(n),
    });
    expect(outcome).toBe('saved');
    expect(download).toHaveBeenCalledTimes(1);
    const [bytes, name] = download.mock.calls[0]! as [Uint8Array, string];
    expect(name).toBe('tonight.zip');
    expect(parsePerformanceZip(bytes).media).toHaveLength(1);
    // Progress still lands once, so a caller's "saved N KB" is not 0 here.
    expect(seen).toEqual([bytes.length]);
  });

  it('a CANCELLED fallback reports no progress at all', async () => {
    const seen: number[] = [];
    const outcome = await savePerformanceZipStreaming(realInput(), {
      picker: null,
      prompt: () => null,
      download: vi.fn(),
      onProgress: (n) => seen.push(n),
    });
    expect(outcome).toBe('cancelled');
    expect(seen).toEqual([]);
  });

  it('reports progress that ends at the archive size actually written', async () => {
    const input = realInput();
    const { handle, state } = makeHandle();
    const picker = vi.fn<ZipSavePicker>(async () => handle as unknown as FileSystemFileHandle);
    const seen: number[] = [];
    await savePerformanceZipStreaming(input, { picker, onProgress: (n) => seen.push(n) });
    expect(seen.length).toBeGreaterThan(1);
    expect(seen[seen.length - 1]).toBe(bytesOf(state.chunks).length);
  });
});
