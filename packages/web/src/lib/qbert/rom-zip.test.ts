// packages/web/src/lib/qbert/rom-zip.test.ts
//
// Pinning: parseRomZip happy + sad path. We use fflate's `zipSync` to
// synthesize the input on the fly so the test owns the bytes-in-, bytes-
// out-loop (no fixture file in git).

import { describe, it, expect } from 'vitest';
import { zipSync } from 'fflate';
import { parseRomZip } from './rom-zip';

describe('parseRomZip — happy path', () => {
  it('extracts a synthetic 2-file zip into a filename → bytes map', () => {
    const rom0 = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
    const rom1 = new Uint8Array([0xAA, 0xBB, 0xCC]);
    const zipped = zipSync({
      'qb-rom0.bin': rom0,
      'qb-rom1.bin': rom1,
    });
    const { roms } = parseRomZip(zipped);
    expect(roms.size).toBe(2);
    expect(roms.get('qb-rom0.bin')).toEqual(rom0);
    expect(roms.get('qb-rom1.bin')).toEqual(rom1);
  });

  it('flattens nested subdirectory entries to the bare filename', () => {
    const rom0 = new Uint8Array([0x10, 0x20]);
    const zipped = zipSync({
      'qbert/qb-rom0.bin': rom0,
    });
    const { roms } = parseRomZip(zipped);
    expect(roms.size).toBe(1);
    expect(roms.get('qb-rom0.bin')).toEqual(rom0);
  });
});

describe('parseRomZip — error path', () => {
  it('throws a clear error on a corrupt (random-bytes) zip', () => {
    const bogus = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF, 0xCA, 0xFE]);
    expect(() => parseRomZip(bogus)).toThrowError(/QBERT ROM zip is corrupt/);
  });

  it('throws on empty input', () => {
    expect(() => parseRomZip(new Uint8Array(0))).toThrowError(/QBERT ROM zip is empty/);
  });
});
