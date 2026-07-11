// packages/web/src/lib/media/ingest.test.ts
//
// Unit coverage for the drop-ingestion core: the kind-sniffing table, plain
// multi-file drops, recursive FOLDER drops (nested dirs, >batch-size listings,
// per-entry read errors), and mixed file+folder drops. FileSystemEntry trees
// are mocked against the structural `*Like` interfaces — Playwright cannot
// fake webkitGetAsEntry, so folder traversal is covered HERE, not in e2e
// (see e2e/tests/media-loader.spec.ts).

import { describe, expect, it } from 'vitest';
import {
  ingestDrop,
  ingestFiles,
  sniffKind,
  type DataTransferItemLike,
  type DataTransferLike,
  type FileSystemEntryLike,
} from './ingest';

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function makeFile(name: string, type = '', bytes = 4): File {
  return new File([new Uint8Array(bytes)], name, { type, lastModified: 1_700_000_000_000 });
}

/** A FileSystemFileEntry that resolves to `file` (or errors when given one). */
function fileEntry(file: File, err?: unknown): FileSystemEntryLike {
  return {
    isFile: true,
    isDirectory: false,
    name: file.name,
    file(onSuccess, onError) {
      // Deliver async like the real API does.
      queueMicrotask(() => (err !== undefined ? onError?.(err) : onSuccess(file)));
    },
  };
}

/** A FileSystemDirectoryEntry serving `children` in `batchSize`d readEntries
 *  batches (Chromium batches at 100 — the drain-until-empty contract). */
function dirEntry(
  name: string,
  children: FileSystemEntryLike[],
  opts: { batchSize?: number; readError?: unknown } = {},
): FileSystemEntryLike {
  const batchSize = opts.batchSize ?? 100;
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader() {
      let cursor = 0;
      return {
        readEntries(onSuccess, onError) {
          queueMicrotask(() => {
            if (opts.readError !== undefined) {
              onError?.(opts.readError);
              return;
            }
            const batch = children.slice(cursor, cursor + batchSize);
            cursor += batch.length;
            onSuccess(batch);
          });
        },
      };
    },
  };
}

function itemForEntry(entry: FileSystemEntryLike): DataTransferItemLike {
  return {
    kind: 'file',
    getAsFile: () => null,
    webkitGetAsEntry: () => entry,
  };
}

function itemForFile(file: File, withEntryApi = true): DataTransferItemLike {
  const item: DataTransferItemLike = {
    kind: 'file',
    getAsFile: () => file,
  };
  if (withEntryApi) item.webkitGetAsEntry = () => fileEntry(file);
  return item;
}

function dt(items: DataTransferItemLike[]): DataTransferLike {
  return { items };
}

// ---------------------------------------------------------------------------
// sniffKind — the classification table
// ---------------------------------------------------------------------------

describe('sniffKind', () => {
  it('classifies by MIME prefix first', () => {
    expect(sniffKind('clip.bin', 'video/mp4')).toBe('video');
    expect(sniffKind('pic.bin', 'image/png')).toBe('image');
    expect(sniffKind('song.bin', 'audio/mpeg')).toBe('audio');
    expect(sniffKind('QT.BIN', 'VIDEO/QUICKTIME')).toBe('video'); // case-insensitive
  });

  it('falls back to the extension when the MIME is empty or generic', () => {
    const table: Array<[string, string]> = [
      ['a.mp4', 'video'],
      ['a.webm', 'video'],
      ['a.mov', 'video'],
      ['a.png', 'image'],
      ['a.jpg', 'image'],
      ['a.jpeg', 'image'],
      ['a.webp', 'image'],
      ['a.gif', 'image'],
      ['a.wav', 'audio'],
      ['a.mp3', 'audio'],
      ['a.ogg', 'audio'],
      ['a.flac', 'audio'],
      ['a.m4a', 'audio'],
      ['a.aiff', 'audio'],
    ];
    for (const [name, kind] of table) {
      expect(sniffKind(name, ''), name).toBe(kind);
      expect(sniffKind(name.toUpperCase(), 'application/octet-stream'), name).toBe(kind);
    }
  });

  it('rejects what it cannot classify', () => {
    expect(sniffKind('notes.txt', 'text/plain')).toBeNull();
    expect(sniffKind('archive.zip', 'application/zip')).toBeNull();
    expect(sniffKind('noext', '')).toBeNull();
    expect(sniffKind('.DS_Store', '')).toBeNull(); // dotfile ≠ extension
    expect(sniffKind('weird.xyz', 'application/octet-stream')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ingestFiles — the <input> browse fallback
// ---------------------------------------------------------------------------

describe('ingestFiles', () => {
  it('classifies a plain FileList and reports unsupported files', () => {
    const res = ingestFiles([
      makeFile('kick.wav', 'audio/wav'),
      makeFile('readme.txt', 'text/plain'),
    ]);
    expect(res.accepted).toHaveLength(1);
    expect(res.accepted[0]).toMatchObject({ kind: 'audio', relativePath: 'kick.wav' });
    expect(res.rejected).toEqual([
      {
        name: 'readme.txt',
        relativePath: 'readme.txt',
        reason: 'unsupported type (text/plain)',
      },
    ]);
  });

  it('preserves webkitRelativePath from a webkitdirectory input', () => {
    const f = makeFile('loop.wav', 'audio/wav');
    Object.defineProperty(f, 'webkitRelativePath', { value: 'stems/drums/loop.wav' });
    const res = ingestFiles([f]);
    expect(res.accepted[0].relativePath).toBe('stems/drums/loop.wav');
  });
});

// ---------------------------------------------------------------------------
// ingestDrop — plain files
// ---------------------------------------------------------------------------

describe('ingestDrop — plain file drops', () => {
  it('ingests a multi-file drop via items + webkitGetAsEntry', async () => {
    const res = await ingestDrop(
      dt([
        itemForFile(makeFile('a.mp4', 'video/mp4')),
        itemForFile(makeFile('b.png', 'image/png')),
        itemForFile(makeFile('c.txt', 'text/plain')),
      ]),
    );
    expect(res.accepted.map((a) => [a.file.name, a.kind, a.relativePath])).toEqual([
      ['a.mp4', 'video', 'a.mp4'],
      ['b.png', 'image', 'b.png'],
    ]);
    expect(res.rejected).toHaveLength(1);
    expect(res.rejected[0].name).toBe('c.txt');
  });

  it('falls back to getAsFile when webkitGetAsEntry is unavailable', async () => {
    const res = await ingestDrop(dt([itemForFile(makeFile('a.webm', 'video/webm'), false)]));
    expect(res.accepted).toHaveLength(1);
    expect(res.accepted[0].relativePath).toBe('a.webm');
  });

  it('falls back to dt.files when items is empty (synthetic events)', async () => {
    const res = await ingestDrop({ items: [], files: [makeFile('a.flac', 'audio/flac')] });
    expect(res.accepted).toHaveLength(1);
    expect(res.accepted[0].kind).toBe('audio');
  });

  it('ignores non-file items (dragged text/HTML fragments)', async () => {
    const stringItem: DataTransferItemLike = { kind: 'string', getAsFile: () => null };
    const res = await ingestDrop(dt([stringItem, itemForFile(makeFile('a.gif', 'image/gif'))]));
    expect(res.accepted).toHaveLength(1);
    expect(res.rejected).toHaveLength(0);
  });

  it('returns empty results for an empty DataTransfer', async () => {
    expect(await ingestDrop({})).toEqual({ accepted: [], rejected: [] });
  });
});

// ---------------------------------------------------------------------------
// ingestDrop — folder drops (the traversal Playwright can't reach)
// ---------------------------------------------------------------------------

describe('ingestDrop — folder drops', () => {
  it('recursively traverses nested directories with folder-relative paths', async () => {
    const tree = dirEntry('shoot', [
      fileEntry(makeFile('cover.jpg', 'image/jpeg')),
      dirEntry('day1', [
        fileEntry(makeFile('take1.mov', 'video/quicktime')),
        dirEntry('audio', [fileEntry(makeFile('room.wav', 'audio/wav'))]),
      ]),
      fileEntry(makeFile('notes.txt', 'text/plain')),
    ]);
    const res = await ingestDrop(dt([itemForEntry(tree)]));
    expect(res.accepted.map((a) => a.relativePath)).toEqual([
      'shoot/cover.jpg',
      'shoot/day1/take1.mov',
      'shoot/day1/audio/room.wav',
    ]);
    expect(res.rejected).toEqual([
      {
        name: 'notes.txt',
        relativePath: 'shoot/notes.txt',
        reason: 'unsupported type (text/plain)',
      },
    ]);
  });

  it('drains readEntries in batches (Chromium caps a batch at 100)', async () => {
    const children = Array.from({ length: 250 }, (_, i) =>
      fileEntry(makeFile(`f${String(i).padStart(3, '0')}.png`, 'image/png')),
    );
    const res = await ingestDrop(dt([itemForEntry(dirEntry('big', children, { batchSize: 100 }))]));
    expect(res.accepted).toHaveLength(250); // a non-draining reader would stop at 100
  });

  it('handles a mixed file+folder drop', async () => {
    const res = await ingestDrop(
      dt([
        itemForFile(makeFile('solo.mp3', 'audio/mpeg')),
        itemForEntry(dirEntry('imgs', [fileEntry(makeFile('a.webp', 'image/webp'))])),
      ]),
    );
    expect(res.accepted.map((a) => a.relativePath)).toEqual(['solo.mp3', 'imgs/a.webp']);
  });

  it('rejects PER-ENTRY on file() errors (symlink/permission) and keeps siblings', async () => {
    const tree = dirEntry('mixed', [
      fileEntry(makeFile('good.png', 'image/png')),
      // Empty-message DOMException — the realistic permission/symlink shape;
      // the reason must fall back to the exception NAME, not be blank.
      fileEntry(makeFile('broken-link.wav', 'audio/wav'), new DOMException('', 'NotFoundError')),
      fileEntry(makeFile('also-good.mp4', 'video/mp4')),
    ]);
    const res = await ingestDrop(dt([itemForEntry(tree)]));
    expect(res.accepted.map((a) => a.file.name)).toEqual(['good.png', 'also-good.mp4']);
    expect(res.rejected).toEqual([
      {
        name: 'broken-link.wav',
        relativePath: 'mixed/broken-link.wav',
        reason: 'file read failed: NotFoundError',
      },
    ]);
  });

  it('rejects PER-DIRECTORY on readEntries errors and keeps sibling roots', async () => {
    const res = await ingestDrop(
      dt([
        itemForEntry(dirEntry('locked', [], { readError: new Error('EACCES') })),
        itemForFile(makeFile('ok.ogg', 'audio/ogg')),
      ]),
    );
    expect(res.accepted.map((a) => a.file.name)).toEqual(['ok.ogg']);
    expect(res.rejected).toEqual([
      { name: 'locked', relativePath: 'locked', reason: 'directory read failed: EACCES' },
    ]);
  });

  it('rejects entries that are neither file nor directory (exotic fs objects)', async () => {
    const weird: FileSystemEntryLike = { isFile: false, isDirectory: false, name: 'socket' };
    const res = await ingestDrop(dt([itemForEntry(dirEntry('d', [weird]))]));
    expect(res.rejected).toEqual([
      {
        name: 'socket',
        relativePath: 'd/socket',
        reason: 'unsupported entry (neither readable file nor directory)',
      },
    ]);
  });
});
