// scripts/vrt-png-verify.test.ts
//
// The collector's PNG integrity check (scripts/vrt-png-verify.mjs). Run
// 33198943725 committed a baseline whose zlib stream failed its Adler-32
// check; every CI run on the branch then reddened in the cable-stripe gate.
// These tests pin the verifier's two obligations: a real screenshot-shaped
// PNG passes, and each corruption class the wild has produced is CAUGHT —
// including the exact one from that run (a bit-flip inside IDAT that leaves
// signature and chunk structure intact).

import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertDecodablePng } from './vrt-png-verify.mjs';

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A minimal valid 2×2 RGBA PNG, built from primitives (no fixtures). */
function makePng(): Buffer {
  const sig = Buffer.from('89504e470d0a1a0a', 'hex');
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0); // width
  ihdr.writeUInt32BE(2, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  // 2 rows × (1 filter byte + 2px × 4ch)
  const raw = Buffer.alloc(2 * (1 + 2 * 4), 0x7f);
  raw[0] = 0;
  raw[9] = 0;
  const idat = deflateSync(raw);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('vrt-png-verify', () => {
  it('a well-formed PNG decodes clean', () => {
    expect(() => assertDecodablePng(makePng())).not.toThrow();
  });

  it('catches the run-33198943725 class: a bit-flip inside IDAT (structure intact, Adler-32 wrong)', () => {
    const png = makePng();
    // Flip one byte in the MIDDLE of the deflate stream — past the zlib
    // header, before the trailing checksum — the shape of transport bit-rot.
    const idatDataStart = 8 + (12 + 13) + 8; // sig + IHDR chunk + IDAT len/type
    png[idatDataStart + 6] = png[idatDataStart + 6]! ^ 0xff;
    expect(() => assertDecodablePng(png)).toThrow();
  });

  it('catches truncation (a partial artifact download)', () => {
    const png = makePng();
    expect(() => assertDecodablePng(png.subarray(0, png.length - 6))).toThrow(/truncated|no IEND/);
  });

  it('catches a non-PNG (an LFS pointer stub committed as-is)', () => {
    const pointer = Buffer.from(
      'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 1\n',
      'utf8',
    );
    expect(() => assertDecodablePng(pointer)).toThrow(/signature/);
  });

  it('CLI contract: prints ONLY corrupt paths on stdout, exits 0 (a report, not an error)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vrt-png-verify-'));
    const good = join(dir, 'good.png');
    const bad = join(dir, 'bad.png');
    writeFileSync(good, makePng());
    const corrupt = makePng();
    corrupt[corrupt.length - 10] = corrupt[corrupt.length - 10]! ^ 0xff;
    writeFileSync(bad, corrupt);
    const out = execFileSync('node', ['scripts/vrt-png-verify.mjs', good, bad], {
      encoding: 'utf8',
    });
    expect(out.trim().split('\n')).toEqual([bad]);
  });
});
