// packages/web/src/lib/doom/wad-sprites.test.ts
//
// Unit tests for the PURE WAD lump reader + DOOM picture decoder + sprite
// resolution. Builds a tiny synthetic IWAD in memory (no DOOM1.WAD needed) so
// the decoder logic is exercised deterministically + license-free.

import { describe, it, expect } from 'vitest';
import {
  parseWadDirectory,
  indexLumps,
  readPlaypal,
  decodePicture,
  flipSpriteFrame,
  resolveSpriteFrame,
  extractGibSprites,
  type WadLump,
} from './wad-sprites';

// ── Synthetic-WAD builder ──────────────────────────────────────────────────

interface LumpInput {
  name: string;
  data: Uint8Array;
}

/** Assemble a minimal IWAD: header (12) + lump data + 16-byte directory
 *  entries. Mirrors the on-disk format the decoder reads. */
function buildWad(lumps: LumpInput[]): Uint8Array {
  const HEADER = 12;
  const DIRENT = 16;
  let dataSize = 0;
  for (const l of lumps) dataSize += l.data.byteLength;
  const total = HEADER + dataSize + lumps.length * DIRENT;
  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);

  // Header.
  buf.set([0x49, 0x57, 0x41, 0x44], 0); // "IWAD"
  view.setInt32(4, lumps.length, true);
  const infoTableOfs = HEADER + dataSize;
  view.setInt32(8, infoTableOfs, true);

  // Lump data + directory.
  let dataPos = HEADER;
  let dirPos = infoTableOfs;
  for (const l of lumps) {
    buf.set(l.data, dataPos);
    view.setInt32(dirPos, dataPos, true);          // filepos
    view.setInt32(dirPos + 4, l.data.byteLength, true); // size
    const name = l.name.toUpperCase().slice(0, 8);
    for (let i = 0; i < 8; i++) {
      buf[dirPos + 8 + i] = i < name.length ? name.charCodeAt(i) : 0;
    }
    dataPos += l.data.byteLength;
    dirPos += DIRENT;
  }
  return buf;
}

/** A 256-colour palette where index i = (i, 255-i, i/2). Distinct + invertible
 *  so we can assert exact RGBA after decode. */
function buildPlaypal(): Uint8Array {
  const pal = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    pal[i * 3] = i & 0xff;
    pal[i * 3 + 1] = (255 - i) & 0xff;
    pal[i * 3 + 2] = (i >> 1) & 0xff;
  }
  return pal;
}

/**
 * Build a DOOM picture lump for a SOLID rectangle of palette index `palIdx`
 * (one full-height post per column). width×height, offsets 0.
 */
function buildSolidPicture(width: number, height: number, palIdx: number): Uint8Array {
  // header(8) + columnofs(width*4) + per-column post:
  //   topdelta(1)+length(1)+pad(1)+pixels(height)+pad(1) + terminator(1)
  const colBytes = 1 + 1 + 1 + height + 1 + 1; // post + 0xFF terminator
  const headerSize = 8 + width * 4;
  const buf = new Uint8Array(headerSize + width * colBytes);
  const view = new DataView(buf.buffer);
  view.setInt16(0, width, true);
  view.setInt16(2, height, true);
  view.setInt16(4, 0, true); // leftoffset
  view.setInt16(6, 0, true); // topoffset
  for (let col = 0; col < width; col++) {
    const colStart = headerSize + col * colBytes;
    view.setInt32(8 + col * 4, colStart, true); // columnofs (absolute from lump start)
    let p = colStart;
    buf[p++] = 0;        // topdelta
    buf[p++] = height;   // length
    buf[p++] = 0;        // pad
    for (let row = 0; row < height; row++) buf[p++] = palIdx;
    buf[p++] = 0;        // pad
    buf[p++] = 0xff;     // column terminator
  }
  return buf;
}

/**
 * Build a picture where the LEFT half is palette index `palIdx` and the RIGHT
 * half is TRANSPARENT (no posts). Used to prove flip mirrors correctly.
 */
function buildLeftHalfPicture(width: number, height: number, palIdx: number): Uint8Array {
  const colBytesSolid = 1 + 1 + 1 + height + 1 + 1;
  const colBytesEmpty = 1; // just the 0xFF terminator
  const headerSize = 8 + width * 4;
  const half = Math.floor(width / 2);
  const totalCol = half * colBytesSolid + (width - half) * colBytesEmpty;
  const buf = new Uint8Array(headerSize + totalCol);
  const view = new DataView(buf.buffer);
  view.setInt16(0, width, true);
  view.setInt16(2, height, true);
  view.setInt16(4, 4, true); // leftoffset (so flip math is testable)
  view.setInt16(6, 0, true);
  let p = headerSize;
  for (let col = 0; col < width; col++) {
    view.setInt32(8 + col * 4, p, true);
    if (col < half) {
      buf[p++] = 0; buf[p++] = height; buf[p++] = 0;
      for (let row = 0; row < height; row++) buf[p++] = palIdx;
      buf[p++] = 0;
      buf[p++] = 0xff;
    } else {
      buf[p++] = 0xff; // empty column
    }
  }
  return buf;
}

const PAL = buildPlaypal();

describe('parseWadDirectory', () => {
  it('reads the header + directory of a synthetic IWAD', () => {
    const wad = buildWad([
      { name: 'PLAYPAL', data: PAL },
      { name: 'TROOA1', data: buildSolidPicture(4, 4, 10) },
    ]);
    const lumps = parseWadDirectory(wad);
    expect(lumps.map((l) => l.name)).toEqual(['PLAYPAL', 'TROOA1']);
    expect(lumps[0]!.size).toBe(768);
  });

  it('rejects a non-WAD buffer', () => {
    expect(() => parseWadDirectory(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).toThrow();
  });

  it('rejects a too-small buffer', () => {
    expect(() => parseWadDirectory(new Uint8Array(4))).toThrow();
  });

  it('indexLumps: last duplicate name wins (IWAD-then-PWAD precedence)', () => {
    const lumps: WadLump[] = [
      { name: 'X', filepos: 0, size: 0 },
      { name: 'X', filepos: 99, size: 0 },
    ];
    expect(indexLumps(lumps).get('X')).toBe(1);
  });
});

describe('readPlaypal', () => {
  it('returns palette 0 (768 bytes) from the PLAYPAL lump', () => {
    const wad = buildWad([{ name: 'PLAYPAL', data: PAL }]);
    const lumps = parseWadDirectory(wad);
    const pal = readPlaypal(wad, lumps);
    expect(pal.byteLength).toBe(768);
    expect(pal[0]).toBe(0);
    expect(pal[10 * 3]).toBe(10);
    expect(pal[10 * 3 + 1]).toBe(245);
  });

  it('throws when PLAYPAL is missing', () => {
    const wad = buildWad([{ name: 'TROOA1', data: buildSolidPicture(2, 2, 1) }]);
    expect(() => readPlaypal(wad, parseWadDirectory(wad))).toThrow(/PLAYPAL/);
  });
});

describe('decodePicture', () => {
  it('decodes a solid rectangle to opaque RGBA via the palette', () => {
    const palIdx = 10;
    const wad = buildWad([
      { name: 'PLAYPAL', data: PAL },
      { name: 'TROOA1', data: buildSolidPicture(3, 2, palIdx) },
    ]);
    const lumps = parseWadDirectory(wad);
    const li = lumps.findIndex((l) => l.name === 'TROOA1');
    const lump = lumps[li]!;
    const f = decodePicture(wad, lump.filepos, lump.size, readPlaypal(wad, lumps));
    expect(f.width).toBe(3);
    expect(f.height).toBe(2);
    // Every texel is opaque + the mapped palette colour.
    for (let i = 0; i < f.width * f.height; i++) {
      expect(f.rgba[i * 4]).toBe(palIdx);          // R = i
      expect(f.rgba[i * 4 + 1]).toBe(255 - palIdx); // G
      expect(f.rgba[i * 4 + 2]).toBe(palIdx >> 1);  // B
      expect(f.rgba[i * 4 + 3]).toBe(255);          // opaque
    }
  });

  it('leaves gaps between posts fully transparent', () => {
    // Left-half picture: right columns have NO posts → alpha 0 there.
    const width = 6, height = 3, palIdx = 20;
    const wad = buildWad([
      { name: 'PLAYPAL', data: PAL },
      { name: 'TROOA1', data: buildLeftHalfPicture(width, height, palIdx) },
    ]);
    const lumps = parseWadDirectory(wad);
    const lump = lumps.find((l) => l.name === 'TROOA1')!;
    const f = decodePicture(wad, lump.filepos, lump.size, readPlaypal(wad, lumps));
    // Left half opaque, right half transparent.
    const alphaAt = (x: number, y: number) => f.rgba[(y * width + x) * 4 + 3];
    expect(alphaAt(0, 0)).toBe(255);
    expect(alphaAt(width - 1, 0)).toBe(0);
  });
});

describe('flipSpriteFrame', () => {
  it('mirrors columns and the left offset', () => {
    const width = 6, height = 2, palIdx = 30;
    const wad = buildWad([
      { name: 'PLAYPAL', data: PAL },
      { name: 'TROOA1', data: buildLeftHalfPicture(width, height, palIdx) },
    ]);
    const lumps = parseWadDirectory(wad);
    const lump = lumps.find((l) => l.name === 'TROOA1')!;
    const f = decodePicture(wad, lump.filepos, lump.size, readPlaypal(wad, lumps));
    const flipped = flipSpriteFrame(f);
    // After flip the OPAQUE half moves to the RIGHT.
    const alphaAt = (img: typeof f, x: number, y: number) => img.rgba[(y * width + x) * 4 + 3];
    expect(alphaAt(flipped, width - 1, 0)).toBe(255);
    expect(alphaAt(flipped, 0, 0)).toBe(0);
    // leftOffset mirrors to (width-1-original) = 6-1-4 = 1.
    expect(flipped.leftOffset).toBe(width - 1 - 4);
  });
});

describe('resolveSpriteFrame', () => {
  it('resolves an exact <actor><frame><rot> lump', () => {
    const wad = buildWad([
      { name: 'PLAYPAL', data: PAL },
      { name: 'TROOA3', data: buildSolidPicture(4, 4, 40) },
    ]);
    const lumps = parseWadDirectory(wad);
    const f = resolveSpriteFrame(wad, lumps, readPlaypal(wad, lumps), 'TROO', 'A', 3);
    expect(f).not.toBeNull();
    expect(f!.width).toBe(4);
  });

  it('falls back to the all-angles <actor><frame>0 lump', () => {
    const wad = buildWad([
      { name: 'PLAYPAL', data: PAL },
      { name: 'POSSA0', data: buildSolidPicture(5, 5, 50) },
    ]);
    const lumps = parseWadDirectory(wad);
    const f = resolveSpriteFrame(wad, lumps, readPlaypal(wad, lumps), 'POSS', 'A', 3);
    expect(f).not.toBeNull();
    expect(f!.width).toBe(5);
  });

  it('resolves the FLIPPED second pair of an 8-char dual lump', () => {
    // "TROOA2A8" = frame A rot 2, plus frame A rot 8 as a horizontal mirror.
    const width = 6, height = 2, palIdx = 60;
    const wad = buildWad([
      { name: 'PLAYPAL', data: PAL },
      { name: 'TROOA2A8', data: buildLeftHalfPicture(width, height, palIdx) },
    ]);
    const lumps = parseWadDirectory(wad);
    const pal = readPlaypal(wad, lumps);
    // rot 2 = the lump as-authored (opaque LEFT).
    const f2 = resolveSpriteFrame(wad, lumps, pal, 'TROO', 'A', 2);
    expect(f2).not.toBeNull();
    expect(f2!.rgba[(0 * width + 0) * 4 + 3]).toBe(255); // opaque left
    // rot 8 = the FLIP (opaque RIGHT).
    const f8 = resolveSpriteFrame(wad, lumps, pal, 'TROO', 'A', 8);
    expect(f8).not.toBeNull();
    expect(f8!.rgba[(0 * width + (width - 1)) * 4 + 3]).toBe(255); // opaque right
  });

  it('returns null when no lump matches the actor/frame', () => {
    const wad = buildWad([{ name: 'PLAYPAL', data: PAL }]);
    const lumps = parseWadDirectory(wad);
    expect(resolveSpriteFrame(wad, lumps, readPlaypal(wad, lumps), 'TROO', 'A', 1)).toBeNull();
  });
});

describe('extractGibSprites — runner faces forward (right)', () => {
  // The marine RUNS to the RIGHT (toward the upcoming obstacles); enemies ride
  // IN from the right toward the marine. DOOM's side rotation (3) is the
  // LEFT-facing profile, so the marine must be flipped (face right) while the
  // enemies stay as-authored (face left, toward the marine). We build a WAD
  // whose rot-3 lumps are LEFT-half-opaque and assert the opaque half lands on
  // the RIGHT for the marine (flipped) and on the LEFT for the enemies (not).
  const opaqueHalf = (frame: ReturnType<typeof decodePicture>): 'left' | 'right' => {
    const { width, height, rgba } = frame;
    const alphaAt = (x: number, y: number) => rgba[(y * width + x) * 4 + 3]!;
    const yMid = Math.floor(height / 2);
    return alphaAt(0, yMid) >= 128 ? 'left' : 'right';
  };

  it('flips the marine run cycle to face right; leaves enemies facing left', () => {
    const W = 6, H = 4;
    const wad = buildWad([
      { name: 'PLAYPAL', data: PAL },
      // Marine run cycle A..D at side rotation 3 (left-half-opaque source).
      { name: 'PLAYA3', data: buildLeftHalfPicture(W, H, 30) },
      { name: 'PLAYB3', data: buildLeftHalfPicture(W, H, 31) },
      { name: 'PLAYC3', data: buildLeftHalfPicture(W, H, 32) },
      { name: 'PLAYD3', data: buildLeftHalfPicture(W, H, 33) },
      // Enemy walk frame at rotation 3 (left-half-opaque source).
      { name: 'TROOA3', data: buildLeftHalfPicture(W, H, 40) },
      { name: 'POSSA3', data: buildLeftHalfPicture(W, H, 50) },
    ]);
    const sprites = extractGibSprites(wad);

    // The marine run cycle exists and EVERY frame faces right (opaque RIGHT).
    expect(sprites.marineRun.length).toBe(4);
    for (const f of sprites.marineRun) expect(opaqueHalf(f)).toBe('right');

    // Enemies are NOT flipped — they still face left (opaque LEFT), toward the
    // marine / their own direction of travel.
    expect(sprites.impWalk.length).toBeGreaterThan(0);
    expect(opaqueHalf(sprites.impWalk[0]!)).toBe('left');
    expect(sprites.zombieWalk.length).toBeGreaterThan(0);
    expect(opaqueHalf(sprites.zombieWalk[0]!)).toBe('left');
  });
});
