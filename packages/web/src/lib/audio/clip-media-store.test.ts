// packages/web/src/lib/audio/clip-media-store.test.ts
//
// The clip media store, running for real against a fake OPFS + fake-indexeddb.
// Four properties, and each one is a way a take gets lost if it is wrong:
//
//   1. A chunked write round-trips byte-for-byte at the right offsets.
//   2. The manifest is durable BEFORE the first byte — with a positive control
//      showing the instrument catches the other ordering.
//   3. A crashed take recovers TRUNCATED TO A WHOLE LOOP, never to a partial.
//   4. The GC frees only unreferenced ids — with the negative control that a
//      referenced one survives, and the in-flight guard that keeps the take
//      being recorded RIGHT NOW from being collected mid-take.

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installFakeOpfs, type InstalledOpfs } from './__fixtures__/opfs-fake';
import {
  CLIP_MEDIA_DIR,
  beginClipMediaTake,
  clipMediaBytesPerFrame,
  clipMediaPath,
  coerceClipMediaManifest,
  deleteClipMediaManifest,
  finishClipMediaTake,
  gcClipMedia,
  getClipMediaManifest,
  hasClipMediaStore,
  listClipMediaManifests,
  listRecoverableClipMedia,
  newClipMediaId,
  noteClipMediaProgress,
  putClipMediaManifest,
  readClipMedia,
  recoverableFrames,
  referencedClipMediaIds,
  removeClipMedia,
  resetClipMediaSweepMemo,
  setClipMediaWriterFactory,
  sweepClipMedia,
  type ClipMediaManifest,
  type ClipMediaWriter,
} from './clip-media-store';
import { ClipMediaDrain } from './clip-media-drain';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let opfs: InstalledOpfs;
let restoreWriter: ReturnType<typeof setClipMediaWriterFactory>;
/** Every write the fake writer performed, in the order it performed them. */
let writeLog: { mediaId: string; position: number; length: number }[] = [];
/** Delay injected into the fake writer, to make the disk "fall behind". */
let writeDelayMs = 0;
/** Positions the fake writer should reject, to exercise the failure path. */
let failAtPositions = new Set<number>();

function makeFakeWriter(mediaId: string): ClipMediaWriter {
  return {
    mediaId,
    async write(bytes, position) {
      if (writeDelayMs > 0) await new Promise((r) => setTimeout(r, writeDelayMs));
      if (failAtPositions.has(position)) throw new Error(`injected write failure @${position}`);
      const root = await navigator.storage.getDirectory();
      const parts = clipMediaPath(mediaId).split('/').filter(Boolean);
      const name = parts.pop()!;
      let dir = root;
      for (const p of parts) dir = await dir.getDirectoryHandle(p, { create: true });
      await dir.getFileHandle(name, { create: true });
      // Reach through the fake to do the positioned write the real worker does.
      const fake = (dir as unknown as { files: Map<string, { writeAt(b: Uint8Array, p: number): void }> })
        .files.get(name)!;
      fake.writeAt(bytes, position);
      writeLog.push({ mediaId, position, length: bytes.length });
    },
    async close() {},
  };
}

function manifest(over: Partial<ClipMediaManifest> = {}): ClipMediaManifest {
  return {
    mediaId: 'm-1',
    nodeId: 'cp1',
    lane: 0,
    slot: 0,
    startedAt: 1_700_000_000_000,
    status: 'recording',
    format: 'pcm-f32',
    sampleRate: 48_000,
    channels: 2,
    frames: 0,
    unitFrames: 96_000,
    lengthSteps: 16,
    ...over,
  };
}

/** A deterministic chunk: `frames` frames of a byte pattern seeded by `seed`. */
function chunkBytes(frames: number, bytesPerFrame: number, seed: number): Uint8Array {
  const b = new Uint8Array(frames * bytesPerFrame);
  for (let i = 0; i < b.length; i++) b[i] = (seed + i) & 0xff;
  return b;
}

async function wipeManifests(): Promise<void> {
  for (const m of await listClipMediaManifests()) await deleteClipMediaManifest(m.mediaId);
}

beforeEach(async () => {
  opfs = installFakeOpfs();
  restoreWriter = setClipMediaWriterFactory(makeFakeWriter);
  writeLog = [];
  writeDelayMs = 0;
  failAtPositions = new Set();
  resetClipMediaSweepMemo();
  await wipeManifests(); // fake-indexeddb state is process-global
});

afterEach(async () => {
  await wipeManifests();
  if (restoreWriter) setClipMediaWriterFactory(restoreWriter);
  opfs?.restore();
  resetClipMediaSweepMemo();
});

// ---------------------------------------------------------------------------

describe('names + capability', () => {
  it('paths are a pure function of the mediaId, under one directory', () => {
    expect(clipMediaPath('m-1')).toBe(`${CLIP_MEDIA_DIR}/m-1`);
    expect(clipMediaPath('m-1')).toBe(clipMediaPath('m-1'));
  });

  it('sanitises an id that arrived from stored data', () => {
    // Six leading `../..` characters plus the inner slash become underscores —
    // the point is that NO id can escape the clipmedia directory.
    expect(clipMediaPath('../../etc/passwd')).toBe(`${CLIP_MEDIA_DIR}/______etc_passwd`);
    expect(clipMediaPath('')).toBe(`${CLIP_MEDIA_DIR}/media`);
    expect(clipMediaPath('a/b')).not.toContain('a/b');
    for (const evil of ['../../etc/passwd', 'a/b', '..', './x']) {
      expect(clipMediaPath(evil).split('/').length, evil).toBe(2);
    }
  });

  it('ids are unique', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newClipMediaId()));
    expect(ids.size).toBe(200);
  });

  it('reports capability only when OPFS *and* Worker are both present', () => {
    expect(hasClipMediaStore()).toBe(true);
    const g = globalThis as unknown as Record<string, unknown>;
    const w = g.Worker;
    delete g.Worker;
    // createSyncAccessHandle is worker-only: OPFS alone cannot write a take,
    // and half-working is worse than saying so.
    expect(hasClipMediaStore()).toBe(false);
    g.Worker = w;
  });
});

describe('chunked write round-trip', () => {
  it('writes chunks at their own offsets and reads back byte-for-byte', async () => {
    const m = manifest({ mediaId: 'm-round', unitFrames: 4 });
    const bpf = clipMediaBytesPerFrame(m.format, m.channels); // 8
    const writer = await beginClipMediaTake(m);
    const drain = new ClipMediaDrain(writer, { bytesPerFrame: bpf });

    const c0 = chunkBytes(4, bpf, 1);
    const c1 = chunkBytes(4, bpf, 100);
    const c2 = chunkBytes(4, bpf, 200);
    await drain.add({ firstFrame: 0, frames: 4, bytes: c0 });
    await drain.add({ firstFrame: 4, frames: 4, bytes: c1 });
    await drain.add({ firstFrame: 8, frames: 4, bytes: c2 });
    await drain.flush();
    await writer.close();
    await finishClipMediaTake(m.mediaId, drain.framesWritten);

    const file = await readClipMedia(m.mediaId);
    expect(file).not.toBeNull();
    const got = new Uint8Array(await file!.arrayBuffer());
    const want = new Uint8Array([...c0, ...c1, ...c2]);
    expect(got.length).toBe(want.length);
    expect([...got]).toEqual([...want]);
    expect(drain.framesWritten).toBe(12);
  });

  it('a chunk lands at ITS OWN frame offset, not at "wherever we are"', async () => {
    // The producer addresses every chunk by its own firstFrame, so a re-ordered
    // or re-delivered chunk cannot smear the take. Deliver them out of order.
    const m = manifest({ mediaId: 'm-order' });
    const bpf = clipMediaBytesPerFrame(m.format, m.channels);
    const writer = await beginClipMediaTake(m);
    const drain = new ClipMediaDrain(writer, { bytesPerFrame: bpf });
    const late = chunkBytes(2, bpf, 9);
    const early = chunkBytes(2, bpf, 3);
    await drain.add({ firstFrame: 2, frames: 2, bytes: late });
    await drain.add({ firstFrame: 0, frames: 2, bytes: early });
    await drain.flush();
    const bytes = opfs.bytesAt(clipMediaPath(m.mediaId))!;
    expect([...bytes.slice(0, 2 * bpf)]).toEqual([...early]);
    expect([...bytes.slice(2 * bpf)]).toEqual([...late]);
  });

  it('reads null for a mediaId with no file', async () => {
    expect(await readClipMedia('never-written')).toBeNull();
  });
});

describe('the manifest is durable BEFORE the first byte', () => {
  it('a read started at writer-creation time already finds the manifest', async () => {
    const m = manifest({ mediaId: 'm-order-ok' });
    let probe: Promise<ClipMediaManifest | null> | null = null;
    setClipMediaWriterFactory((mediaId) => {
      // `beginClipMediaTake` awaits the manifest put BEFORE calling us, so a
      // read issued from here must already see the record.
      probe = getClipMediaManifest(mediaId);
      return makeFakeWriter(mediaId);
    });
    await beginClipMediaTake(m);
    expect(probe).not.toBeNull();
    expect(await probe!).toMatchObject({ mediaId: 'm-order-ok', status: 'recording' });
    // ...and no byte has been written yet, so a crash HERE leaves a recover
    // candidate pointing at an empty file rather than an unnameable one.
    expect(writeLog).toEqual([]);
  });

  it('POSITIVE CONTROL: the same probe CATCHES a writer-first ordering', async () => {
    // Hand-roll the wrong order — the writer created before the manifest lands.
    // If this probe could not tell the two apart, the test above would be
    // proving nothing.
    const m = manifest({ mediaId: 'm-order-bad' });
    const probe = getClipMediaManifest(m.mediaId);
    makeFakeWriter(m.mediaId);
    await putClipMediaManifest(m);
    expect(await probe).toBeNull();
  });

  it('a writer that cannot be constructed ROLLS THE MANIFEST BACK', async () => {
    // Otherwise a take that never started would sit in the recovery list
    // forever, offering to restore nothing.
    const m = manifest({ mediaId: 'm-rollback' });
    setClipMediaWriterFactory(() => {
      throw new Error('no worker here');
    });
    await expect(beginClipMediaTake(m)).rejects.toThrow('no worker here');
    expect(await getClipMediaManifest(m.mediaId)).toBeNull();
    expect(await listRecoverableClipMedia()).toEqual([]);
  });

  it('progress updates the in-flight frame count; finish stamps done', async () => {
    const m = manifest({ mediaId: 'm-progress' });
    await beginClipMediaTake(m);
    await noteClipMediaProgress(m.mediaId, 4096);
    expect(await getClipMediaManifest(m.mediaId)).toMatchObject({ frames: 4096, status: 'recording' });
    await finishClipMediaTake(m.mediaId, 8192);
    expect(await getClipMediaManifest(m.mediaId)).toMatchObject({ frames: 8192, status: 'done' });
    // A finished take is no longer a recover candidate.
    expect(await listRecoverableClipMedia()).toEqual([]);
    // And progress on a FINISHED take is ignored — a late chunk must not
    // re-open a committed take.
    await noteClipMediaProgress(m.mediaId, 99);
    expect(await getClipMediaManifest(m.mediaId)).toMatchObject({ frames: 8192, status: 'done' });
  });
});

describe('recovery truncates to a WHOLE loop', () => {
  it('recoverableFrames is a table, stated', () => {
    const base = { format: 'pcm-f32' as const, channels: 2 as const, unitFrames: 100, frames: 1_000_000 };
    const bpf = 8;
    const rows = [0, 99, 100, 199, 250, 300].map(
      (frames) => `${frames} frames on disk → ${recoverableFrames(base, frames * bpf)}`,
    );
    expect(rows).toEqual([
      '0 frames on disk → 0',
      '99 frames on disk → 0',
      '100 frames on disk → 100',
      '199 frames on disk → 100',
      '250 frames on disk → 200',
      '300 frames on disk → 300',
    ]);
  });

  it('NEVER returns a partial loop, for any byte count', () => {
    const base = { format: 'pcm-i16' as const, channels: 1 as const, unitFrames: 7, frames: 1e9 };
    for (let bytes = 0; bytes < 400; bytes++) {
      const got = recoverableFrames(base, bytes);
      expect(got % 7, `bytes=${bytes}`).toBe(0);
      expect(got * 2, `bytes=${bytes}`).toBeLessThanOrEqual(bytes);
    }
  });

  it('trusts the BYTES over the manifest — the manifest can only over-claim', () => {
    // After a crash the manifest names frames whose chunks never reached the
    // disk. Believing it would hand back a clip longer than its own file.
    const base = { format: 'pcm-f32' as const, channels: 2 as const, unitFrames: 10 };
    expect(recoverableFrames({ ...base, frames: 1000 }, 25 * 8)).toBe(20);
    // NEGATIVE CONTROL: the manifest's number, if believed, would be 1000.
    expect(recoverableFrames({ ...base, frames: 1000 }, 25 * 8)).not.toBe(1000);
  });

  it('claims NOTHING for a format that is not frame-addressable', () => {
    // Opus is variable-rate: byte offset does not map to a frame count, so an
    // exact recovered length cannot be computed from the file size.
    expect(clipMediaBytesPerFrame('opus', 2)).toBe(0);
    expect(recoverableFrames({ format: 'opus', channels: 2, unitFrames: 10, frames: 500 }, 4096)).toBe(0);
  });

  it('a degenerate unitFrames recovers nothing rather than dividing by zero', () => {
    for (const unitFrames of [0, -4, NaN, Infinity]) {
      expect(
        recoverableFrames({ format: 'pcm-f32', channels: 2, unitFrames, frames: 100 }, 4096),
      ).toBe(0);
    }
  });

  it('END TO END: a crashed take is listed, and truncates to whole loops', async () => {
    const m = manifest({ mediaId: 'm-crash', unitFrames: 4, frames: 0 });
    const bpf = clipMediaBytesPerFrame(m.format, m.channels);
    const writer = await beginClipMediaTake(m);
    const drain = new ClipMediaDrain(writer, {
      bytesPerFrame: bpf,
      onProgress: (f) => void noteClipMediaProgress(m.mediaId, f),
    });
    // 2.5 loops of a 4-frame unit = 10 frames. Then the tab dies: no
    // finishClipMediaTake, no close().
    await drain.add({ firstFrame: 0, frames: 10, bytes: chunkBytes(10, bpf, 5) });
    await drain.flush();

    const candidates = await listRecoverableClipMedia('cp1');
    expect(candidates.map((c) => c.mediaId)).toEqual(['m-crash']);
    const file = await readClipMedia('m-crash');
    expect(file!.size).toBe(10 * bpf);
    // 10 frames of a 4-frame loop → 8. The half loop is discarded, which is
    // exactly what Arm-Endless promises.
    expect(recoverableFrames(candidates[0]!, file!.size)).toBe(8);
  });

  it('scopes the candidate list to the asking node', async () => {
    await putClipMediaManifest(manifest({ mediaId: 'a', nodeId: 'cp1' }));
    await putClipMediaManifest(manifest({ mediaId: 'b', nodeId: 'cp2' }));
    await putClipMediaManifest(manifest({ mediaId: 'c', nodeId: 'cp1', status: 'done' }));
    expect((await listRecoverableClipMedia('cp1')).map((m) => m.mediaId)).toEqual(['a']);
    expect((await listRecoverableClipMedia('cp2')).map((m) => m.mediaId)).toEqual(['b']);
    expect((await listRecoverableClipMedia()).map((m) => m.mediaId).sort()).toEqual(['a', 'b']);
  });
});

describe('the garbage collector', () => {
  async function seedTake(mediaId: string, status: ClipMediaManifest['status']): Promise<void> {
    await putClipMediaManifest(manifest({ mediaId, status }));
    const writer = makeFakeWriter(mediaId);
    await writer.write(new Uint8Array([1, 2, 3, 4]), 0);
  }

  it('frees an unreferenced take — and the NEGATIVE CONTROL, a referenced one survives', async () => {
    await seedTake('keep-me', 'done');
    await seedTake('drop-me', 'done');

    const res = await gcClipMedia(['keep-me']);
    expect(res.ids).toEqual(['drop-me']);
    expect(res.freed).toBe(1);

    // ⚠ THE NEGATIVE CONTROL. A GC that frees everything would pass a
    // "frees the unreferenced one" assertion just as well.
    expect(await readClipMedia('keep-me')).not.toBeNull();
    expect(await getClipMediaManifest('keep-me')).not.toBeNull();
    // ...and the collected one is gone from BOTH stores, not just one.
    expect(await readClipMedia('drop-me')).toBeNull();
    expect(await getClipMediaManifest('drop-me')).toBeNull();
  });

  it('SPARES an in-flight take — it has no clip record YET, by construction', async () => {
    // The clip record is written at COMMIT, so the take being recorded right
    // now is absent from the live set. Collecting on membership alone would
    // delete it mid-take.
    await seedTake('recording-now', 'recording');
    const res = await gcClipMedia([]);
    expect(res.ids).toEqual([]);
    expect(res.inFlight).toBe(1);
    expect(await readClipMedia('recording-now')).not.toBeNull();
  });

  it('spares a CRASHED take, so the recovery affordance still has something to offer', async () => {
    await seedTake('crashed', 'recording');
    await gcClipMedia([]);
    expect((await listRecoverableClipMedia()).map((m) => m.mediaId)).toEqual(['crashed']);
  });

  it('collects an ORPHAN file that has no manifest at all', async () => {
    // The manifest is written before the file is opened, so a file with no
    // manifest cannot be a take in progress. recorderbox cannot reach these at
    // all — nothing in it enumerates its OPFS directory — so they leak forever.
    const writer = makeFakeWriter('orphan');
    await writer.write(new Uint8Array([9]), 0);
    expect(opfs.namesIn(CLIP_MEDIA_DIR)).toContain('orphan');
    const res = await gcClipMedia([]);
    expect(res.ids).toEqual(['orphan']);
    expect(opfs.namesIn(CLIP_MEDIA_DIR)).not.toContain('orphan');
  });

  it('is idempotent and cheap on a second pass', async () => {
    await seedTake('a', 'done');
    expect((await gcClipMedia([])).freed).toBe(1);
    expect((await gcClipMedia([])).freed).toBe(0);
  });

  it('referencedClipMediaIds reads audio clips out of every clipplayer', () => {
    const nodes = [
      {
        type: 'clipplayer',
        data: {
          clips: {
            '0': { kind: 'audio', mediaId: 'a1' },
            '1': { kind: 'note', steps: [] },
            '2': null,
            '3': { kind: 'audio', mediaId: 'a2', videoMediaId: 'v2' },
          },
        },
      },
      { type: 'clipplayer', data: { clips: { '0': { kind: 'audio', mediaId: 'b1' } } } },
      { type: 'mixmstrs', data: { clips: { '0': { kind: 'audio', mediaId: 'nope' } } } },
      { type: 'clipplayer' },
    ];
    expect([...referencedClipMediaIds(nodes)].sort()).toEqual(['a1', 'a2', 'b1', 'v2']);
  });

  it('referencedClipMediaIds is RAW — a malformed clip still protects its bytes', () => {
    // Over-retention is a wasted file; under-retention is a lost take. A record
    // that fails validation is still a record someone might repair, so the GC
    // must not free the bytes behind it on a technicality.
    const nodes = [{ type: 'clipplayer', data: { clips: { '0': { kind: 'audio', mediaId: 'half-broken' } } } }];
    expect(referencedClipMediaIds(nodes).has('half-broken')).toBe(true);
  });

  it('the sweep memo skips a repeat call and re-fires on a real change', async () => {
    // The graph-lifetime pass re-runs on EVERY graph edit; the other sweeps in
    // it are Map deletes, this one touches IDB and enumerates a directory.
    await seedTake('x', 'done');
    sweepClipMedia(['keep']);
    sweepClipMedia(['keep']); // memoised — must not start a second sweep
    await new Promise((r) => setTimeout(r, 0));
    expect(await readClipMedia('x')).toBeNull();

    await seedTake('y', 'done');
    sweepClipMedia(['keep']); // same key → skipped, so y survives
    await new Promise((r) => setTimeout(r, 0));
    expect(await readClipMedia('y')).not.toBeNull();

    sweepClipMedia(['keep', 'other']); // a real change → sweeps
    await new Promise((r) => setTimeout(r, 0));
    expect(await readClipMedia('y')).toBeNull();
  });

  it('the memo is order-insensitive — a reordered live set is not a change', async () => {
    sweepClipMedia(['a', 'b']);
    await new Promise((r) => setTimeout(r, 0));
    await seedTake('z', 'done');
    sweepClipMedia(['b', 'a']);
    await new Promise((r) => setTimeout(r, 0));
    expect(await readClipMedia('z')).not.toBeNull();
  });

  it('two DIFFERENT live sets never memo to the same key', async () => {
    // The classic join-key collision: `['a','b']` and `['a b']` are different
    // sets that a naive separator maps onto one string, so the second sweep
    // would be silently suppressed and a deleted clip's bytes would stay on
    // disk forever. The separator is a character `sanitizeMediaId` can never
    // emit — and it is spelled as an ESCAPE in the source, because writing it
    // literally would put a NUL byte in the file and make every `grep` over
    // that file report no matches, silently.
    sweepClipMedia(['a', 'b']);
    await new Promise((r) => setTimeout(r, 0));
    await seedTake('collide', 'done');
    sweepClipMedia(['a b']); // a DIFFERENT set — must not be memo-suppressed
    await new Promise((r) => setTimeout(r, 0));
    expect(await readClipMedia('collide')).toBeNull();
  });
});

describe('coerceClipMediaManifest', () => {
  it('accepts a complete manifest', () => {
    expect(coerceClipMediaManifest(manifest())).toMatchObject({ mediaId: 'm-1', status: 'recording' });
  });

  it('drops a manifest it cannot trust', () => {
    for (const [why, over] of [
      ['no mediaId', { mediaId: '' }],
      ['no nodeId', { nodeId: '' }],
      ['an unknown format', { format: 'flac' }],
      ['channels 3', { channels: 3 }],
      ['sampleRate 0', { sampleRate: 0 }],
    ] as [string, Record<string, unknown>][]) {
      expect(coerceClipMediaManifest({ ...manifest(), ...over }), why).toBeNull();
    }
    expect(coerceClipMediaManifest(null)).toBeNull();
    expect(coerceClipMediaManifest('nope')).toBeNull();
  });

  it('an unknown status reads as RECORDING — the safe direction', () => {
    // `recording` is protected by the GC and offered by recovery. Reading a
    // corrupt status as `done` would make the GC eat a take it could not name.
    expect(coerceClipMediaManifest({ ...manifest(), status: 'weird' })!.status).toBe('recording');
  });
});

describe('explicit removal', () => {
  it('removes bytes and manifest together', async () => {
    await putClipMediaManifest(manifest({ mediaId: 'gone' }));
    const w = makeFakeWriter('gone');
    await w.write(new Uint8Array([1]), 0);
    await removeClipMedia('gone');
    expect(await readClipMedia('gone')).toBeNull();
    expect(await getClipMediaManifest('gone')).toBeNull();
  });

  it('is safe on a mediaId that was never stored', async () => {
    await expect(removeClipMedia('never')).resolves.toBeUndefined();
  });
});
