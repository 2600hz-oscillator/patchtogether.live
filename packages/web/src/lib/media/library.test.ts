// packages/web/src/lib/media/library.test.ts
//
// Unit coverage for the centralized media library: add/duplicate-skip,
// object-URL lifecycle (revoke-on-remove/clear — leaks here pin whole files
// in memory), and the probe status machine ('probing' → 'ready' | 'failed',
// including the removed-while-probing race). URL factory + probe are injected
// (the library's test seam), so this runs in plain node with spies — the
// DOM-based default probe is exercised by the /media e2e in a real browser.

import { describe, expect, it, vi } from 'vitest';
import { createMediaLibrary, type MediaLibraryOptions } from './library.svelte.js';
import type { AcceptedMedia, MediaKind } from './ingest';
import type { ProbedMeta } from './probe';

function makeFile(name: string, type = 'audio/wav', bytes = 8, lastModified = 42): File {
  return new File([new Uint8Array(bytes)], name, { type, lastModified });
}

function accepted(file: File, kind: MediaKind = 'audio', relativePath = file.name): AcceptedMedia {
  return { file, kind, relativePath };
}

/** A probe whose settlement the test controls per-call. */
function controlledProbe() {
  const pending: Array<{
    kind: MediaKind;
    resolve: (m: ProbedMeta) => void;
    reject: (e: unknown) => void;
  }> = [];
  const probe = (kind: MediaKind): Promise<ProbedMeta> =>
    new Promise<ProbedMeta>((resolve, reject) => {
      pending.push({ kind, resolve, reject });
    });
  return { probe, pending };
}

function libWithSpies(extra: Partial<MediaLibraryOptions> = {}) {
  let n = 0;
  const createObjectUrl = vi.fn(() => `blob:test/${++n}`);
  const revokeObjectUrl = vi.fn();
  const { probe, pending } = controlledProbe();
  const lib = createMediaLibrary({ createObjectUrl, revokeObjectUrl, probe, ...extra });
  return { lib, createObjectUrl, revokeObjectUrl, pending };
}

/** Let in-flight probe continuations run. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

describe('MediaLibrary — add + ids + duplicates', () => {
  it('adds items with stable monotonic ids and immediate object URLs', () => {
    const { lib, createObjectUrl } = libWithSpies();
    const res = lib.add([
      accepted(makeFile('a.wav')),
      accepted(makeFile('b.png', 'image/png'), 'image'),
    ]);
    expect(res.added.map((i) => i.id)).toEqual(['media-1', 'media-2']);
    expect(res.skipped).toEqual([]);
    expect(lib.count).toBe(2);
    expect(createObjectUrl).toHaveBeenCalledTimes(2);
    expect(lib.items[0].objectUrl).toBe('blob:test/1');
    expect(lib.get('media-2')?.kind).toBe('image');
  });

  it('skips duplicates (same name+size+lastModified) with a notice', () => {
    const { lib } = libWithSpies();
    lib.add([accepted(makeFile('a.wav', 'audio/wav', 8, 42))]);
    const res = lib.add([
      accepted(makeFile('a.wav', 'audio/wav', 8, 42), 'audio', 'stems/a.wav'), // dupe
      accepted(makeFile('a.wav', 'audio/wav', 9, 42)), // different size → not a dupe
    ]);
    expect(res.added).toHaveLength(1);
    expect(res.skipped).toEqual([
      {
        name: 'a.wav',
        relativePath: 'stems/a.wav',
        reason: 'already in library (same name, size and modification time)',
      },
    ]);
    expect(lib.count).toBe(2);
  });

  it('skips duplicates WITHIN one batch too', () => {
    const { lib } = libWithSpies();
    const res = lib.add([accepted(makeFile('a.wav')), accepted(makeFile('a.wav'))]);
    expect(res.added).toHaveLength(1);
    expect(res.skipped).toHaveLength(1);
  });

  it('allows re-adding a file after it was removed (dupe key released)', () => {
    const { lib } = libWithSpies();
    const [item] = lib.add([accepted(makeFile('a.wav'))]).added;
    lib.remove(item.id);
    const res = lib.add([accepted(makeFile('a.wav'))]);
    expect(res.added).toHaveLength(1);
    expect(res.added[0].id).toBe('media-2'); // ids never reused
  });
});

describe('MediaLibrary — object-URL lifecycle', () => {
  it('revokes the object URL on remove', () => {
    const { lib, revokeObjectUrl } = libWithSpies();
    const [item] = lib.add([accepted(makeFile('a.wav'))]).added;
    expect(revokeObjectUrl).not.toHaveBeenCalled();
    expect(lib.remove(item.id)).toBe(true);
    expect(revokeObjectUrl).toHaveBeenCalledExactlyOnceWith('blob:test/1');
    expect(lib.count).toBe(0);
  });

  it('remove of an unknown id is a no-op (no revoke)', () => {
    const { lib, revokeObjectUrl } = libWithSpies();
    lib.add([accepted(makeFile('a.wav'))]);
    expect(lib.remove('media-999')).toBe(false);
    expect(revokeObjectUrl).not.toHaveBeenCalled();
    expect(lib.count).toBe(1);
  });

  it('revokes EVERY object URL on clear', () => {
    const { lib, revokeObjectUrl } = libWithSpies();
    lib.add([
      accepted(makeFile('a.wav')),
      accepted(makeFile('b.mp4', 'video/mp4'), 'video'),
      accepted(makeFile('c.png', 'image/png'), 'image'),
    ]);
    lib.clear();
    expect(lib.count).toBe(0);
    expect(revokeObjectUrl.mock.calls.map((c) => c[0]).sort()).toEqual([
      'blob:test/1',
      'blob:test/2',
      'blob:test/3',
    ]);
    // And the dupe keys were released:
    expect(lib.add([accepted(makeFile('a.wav'))]).added).toHaveLength(1);
  });

  it('defaults wire URL.createObjectURL/revokeObjectURL', () => {
    const create = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:real/1');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    try {
      const { probe } = controlledProbe();
      const lib = createMediaLibrary({ probe }); // default URL factory, mocked probe
      const [item] = lib.add([accepted(makeFile('a.wav'))]).added;
      expect(create).toHaveBeenCalledExactlyOnceWith(item.file);
      lib.clear();
      expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:real/1');
    } finally {
      create.mockRestore();
      revoke.mockRestore();
    }
  });
});

describe('MediaLibrary — probe status machine', () => {
  it("items start 'probing' and flip to 'ready' with meta on probe success", async () => {
    const { lib, pending } = libWithSpies();
    const [item] = lib.add([accepted(makeFile('a.mp4', 'video/mp4'), 'video')]).added;
    expect(item.status).toBe('probing');
    expect(pending).toHaveLength(1);
    expect(pending[0].kind).toBe('video');

    pending[0].resolve({ durationS: 12.5, width: 640, height: 360 });
    await settle();
    expect(item.status).toBe('ready');
    expect(item.meta).toEqual({ durationS: 12.5, width: 640, height: 360 });
  });

  it("flips to 'failed' (item KEPT + URL intact) on probe failure", async () => {
    const { lib, pending, revokeObjectUrl } = libWithSpies();
    const [item] = lib.add([accepted(makeFile('a.wav'))]).added;
    pending[0].reject(new Error('audio metadata failed to load'));
    await settle();
    expect(item.status).toBe('failed');
    expect(item.probeError).toBe('audio metadata failed to load');
    // Failed ≠ removed: still listed, still playable via its object URL.
    expect(lib.count).toBe(1);
    expect(revokeObjectUrl).not.toHaveBeenCalled();
  });

  it('a probe settling AFTER the item was removed is a no-op', async () => {
    const { lib, pending } = libWithSpies();
    const [item] = lib.add([accepted(makeFile('a.wav'))]).added;
    lib.remove(item.id);
    pending[0].resolve({ durationS: 1 });
    await settle(); // must not throw / resurrect the item
    expect(lib.count).toBe(0);
    expect(lib.get(item.id)).toBeUndefined();
  });

  it('probes settle independently across items', async () => {
    const { lib, pending } = libWithSpies();
    const [a, b] = lib.add([
      accepted(makeFile('a.png', 'image/png'), 'image'),
      accepted(makeFile('b.png', 'image/png'), 'image'),
    ]).added;
    pending[1].resolve({ width: 2, height: 2 }); // b first
    await settle();
    expect(a.status).toBe('probing');
    expect(b.status).toBe('ready');
    pending[0].reject(new Error('nope'));
    await settle();
    expect(a.status).toBe('failed');
    expect(b.status).toBe('ready');
  });
});

describe('MediaLibrary — poster URL lifecycle (P3 video thumbnails)', () => {
  it('revokes meta.posterUrl alongside objectUrl on remove', async () => {
    const { lib, pending, revokeObjectUrl } = libWithSpies();
    const [item] = lib.add([accepted(makeFile('a.mp4', 'video/mp4'), 'video')]).added;
    pending[0].resolve({ durationS: 3, posterUrl: 'blob:poster/1' });
    await settle();
    expect(item.meta.posterUrl).toBe('blob:poster/1');
    lib.remove(item.id);
    expect(revokeObjectUrl.mock.calls.map((c) => c[0]).sort()).toEqual([
      'blob:poster/1',
      'blob:test/1',
    ]);
  });

  it('revokes poster URLs on clear too', async () => {
    const { lib, pending, revokeObjectUrl } = libWithSpies();
    lib.add([
      accepted(makeFile('a.mp4', 'video/mp4'), 'video'),
      accepted(makeFile('b.wav')),
    ]);
    pending[0].resolve({ durationS: 3, posterUrl: 'blob:poster/1' });
    pending[1].resolve({ durationS: 1 }); // audio — no poster
    await settle();
    lib.clear();
    expect(revokeObjectUrl.mock.calls.map((c) => c[0]).sort()).toEqual([
      'blob:poster/1',
      'blob:test/1',
      'blob:test/2',
    ]);
  });

  it('a poster minted for an already-removed item is revoked, not leaked', async () => {
    const { lib, pending, revokeObjectUrl } = libWithSpies();
    const [item] = lib.add([accepted(makeFile('a.mp4', 'video/mp4'), 'video')]).added;
    lib.remove(item.id); // revokes blob:test/1; probe still in flight
    pending[0].resolve({ durationS: 3, posterUrl: 'blob:poster/ghost' });
    await settle();
    expect(revokeObjectUrl.mock.calls.map((c) => c[0]).sort()).toEqual([
      'blob:poster/ghost',
      'blob:test/1',
    ]);
  });
});
