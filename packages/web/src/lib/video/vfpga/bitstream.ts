// packages/web/src/lib/video/vfpga/bitstream.ts
//
// The VFPGA BITSTREAM codec (hardware-accuracy plan A3). Until now the authored
// `VfpgaFabric` object was BRANDED "the bitstream" but is structurally a
// post-synthesis NETLIST — no config frames, no frame addresses, no CRC. This
// module adds the real thing:
//
//   pack(fabric)   → a binary IMAGE that mirrors real FPGA bitstream SHAPE
//                    (iCE40-style sync preamble + magic, per-tile config FRAMES
//                    with a frame-address word + a presence/mode flag word + a
//                    16-bit LUT-INIT field, a symbol table, a CRC-32 trailer).
//   unpack(bytes)  → the exact `VfpgaFabric` back.
//
// TWO HARD PROPERTIES (the whole point — pinned by bitstream.test.ts):
//   1. ROUND-TRIP:      unpack(pack(x)) deep-equals x for every fabric.
//   2. EFFECT-IDENTITY: fabricToEffect(unpack(pack(x))) is byte-identical to
//                       fabricToEffect(x) → VRT/attest hold with zero rebaseline
//                       from the codec. (Falls out of #1: fabricToEffect reads
//                       the fabric by field NAME + array ORDER, both preserved.)
//   + the CRC-32 DETECTS a single flipped byte (throws), which is also the seam
//     for the future "flip a real config-frame bit before compile" bend.
//
// Design = the adversarially-verified A3 format (judge panel, 2026-06-27):
// minimal-but-authentic core (every numeric leaf is an UNCONDITIONAL f64 →
// bit-exact over the whole IEEE-754 domain, the most obviously-lossless choice)
// with grafts: a literal iCE40 SYNC word + 'VFG1' magic + a decorative
// frame-address register (authentic hexdump shape), per-symbol UTF-8/UTF-16LE
// fallback (total-lossless interning incl. lone surrogates), and a version +
// reserved-bits-must-be-zero gate (cheap forward-compat). The two PACKED integer
// paths (LUT-INIT u16, bit-plane mask) are taken ONLY when an encode→decode→
// Object.is compare proves them reversible — so -0 / fractional / out-of-range
// fall to the f64 escape and stay lossless. NOTE: no current spec uses
// config.lutInit/bitPlanes/taps (the 'uLutInit' in databend-cvbs is a bind
// UNIFORM NAME string, not config.lutInit); they are encoded for forward-compat
// and exercised only by synthetic tests.
//
// Pure: Uint8Array / DataView / TextEncoder only — runs in the vitest node lane
// AND the browser worker (no Buffer, no Node APIs). Deterministic. No eval.

import type { VfpgaFabric, VfpgaTile, VfpgaTileBind, VfpgaTileType } from './types';

const LE = true;

// iCE40 configuration preamble bytes (authentic signature) + our format magic.
const SYNC = Uint8Array.of(0x7e, 0xaa, 0x99, 0x7e);
const MAGIC = Uint8Array.of(0x56, 0x46, 0x47, 0x31); // 'VFG1'
const VERSION = 1;
const U16_MAX = 0xffff;

// configFlags (per-tile presence/mode word). Reserved bits 14-15 MUST be 0.
const F_POS = 1 << 0;
const F_OP = 1 << 1;
const F_CONSTS = 1 << 2;
const F_BIND = 1 << 3;
const F_INPUTS = 1 << 4;
const F_LUT_INIT = 1 << 5;
const F_LUT_INIT_PACKED = 1 << 6;
const F_BIT_PLANES = 1 << 7;
const F_BIT_PLANES_PACKED = 1 << 8;
const F_TAPS = 1 << 9;
const F_ROWS = 1 << 10;
const F_CLOCKDIV = 1 << 11;
const F_KIND = 1 << 12;
const F_KIND_FLOAT = 1 << 13;
const CONFIG_RESERVED = 0xc000; // bits 14-15

// Bijective tile-type ↔ code (config-frame tileType field).
const TILE_TYPES: VfpgaTileType[] = ['clb', 'dsp', 'bram', 'reg', 'lut16', 'iob_in', 'iob_out'];
function tileTypeToCode(t: VfpgaTileType): number {
  const i = TILE_TYPES.indexOf(t);
  if (i < 0) throw new Error(`vfpga bitstream: unknown tile type "${t}"`);
  return i;
}
function codeToTileType(n: number): VfpgaTileType {
  const t = TILE_TYPES[n];
  if (!t) throw new Error(`vfpga bitstream: unknown tile-type code ${n}`);
  return t;
}

const BIND_TO: Array<'p' | 'cv' | 'gate'> = ['p', 'cv', 'gate'];
function bindToCode(to: 'p' | 'cv' | 'gate'): number {
  const i = BIND_TO.indexOf(to);
  if (i < 0) throw new Error(`vfpga bitstream: unknown bind.to "${to}"`);
  return i;
}
function codeToBindTo(n: number): 'p' | 'cv' | 'gate' {
  const v = BIND_TO[n];
  if (!v) throw new Error(`vfpga bitstream: unknown bind.to code ${n}`);
  return v;
}

// ----------------------------------------------------------------------
// CRC-32/ISO-HDLC (reflected poly 0xEDB88820, init/xorout 0xFFFFFFFF).
// ----------------------------------------------------------------------
const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88820 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ----------------------------------------------------------------------
// Growable little-endian writer / reader.
// ----------------------------------------------------------------------
class ByteWriter {
  private buf = new Uint8Array(256);
  private view = new DataView(this.buf.buffer);
  private len = 0;
  private ensure(n: number) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.view = new DataView(this.buf.buffer);
  }
  u8(n: number) { this.ensure(1); this.view.setUint8(this.len, n & 0xff); this.len += 1; }
  u16(n: number) { this.ensure(2); this.view.setUint16(this.len, n & 0xffff, LE); this.len += 2; }
  u32(n: number) { this.ensure(4); this.view.setUint32(this.len, n >>> 0, LE); this.len += 4; }
  f64(n: number) { this.ensure(8); this.view.setFloat64(this.len, n, LE); this.len += 8; }
  bytes(arr: Uint8Array) { this.ensure(arr.length); this.buf.set(arr, this.len); this.len += arr.length; }
  toUint8Array(): Uint8Array { return this.buf.slice(0, this.len); }
  get length() { return this.len; }
}

class ByteReader {
  private view: DataView;
  private pos = 0;
  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  u8(): number { const v = this.view.getUint8(this.pos); this.pos += 1; return v; }
  u16(): number { const v = this.view.getUint16(this.pos, LE); this.pos += 2; return v; }
  u32(): number { const v = this.view.getUint32(this.pos, LE); this.pos += 4; return v; }
  f64(): number { const v = this.view.getFloat64(this.pos, LE); this.pos += 8; return v; }
  raw(len: number): Uint8Array { const v = this.bytes.subarray(this.pos, this.pos + len); this.pos += len; return v; }
}

// ----------------------------------------------------------------------
// Symbol table — every string (tile id, op, consts key, bind knob/uniform,
// input name, net endpoint, output id) interned ONCE, referenced by u16 index.
// Built by a single deterministic first-appearance traversal so pack() is
// byte-stable (the determinism golden catches a field added to pack but not
// this walk).
// ----------------------------------------------------------------------
function buildSymbolTable(fabric: VfpgaFabric): { symbols: string[]; idOf: (s: string) => number } {
  const symbols: string[] = [];
  const index = new Map<string, number>();
  const intern = (s: string): number => {
    let i = index.get(s);
    if (i === undefined) {
      i = symbols.length;
      if (i > U16_MAX) throw new Error('vfpga bitstream: symbol table exceeds 65535 entries');
      symbols.push(s);
      index.set(s, i);
    }
    return i;
  };
  for (const t of fabric.tiles) {
    intern(t.id);
    if (t.config.op !== undefined) intern(t.config.op);
    if (t.config.consts) for (const k of Object.keys(t.config.consts)) intern(k);
    if (t.config.bind) for (const b of t.config.bind) { intern(b.knob); intern(b.uniform); }
    if (t.inputs) for (const inp of t.inputs) intern(inp);
  }
  for (const net of fabric.nets) { intern(net.from); intern(net.to); }
  intern(fabric.outputs.vout1);
  if (fabric.outputs.vout2 !== undefined) intern(fabric.outputs.vout2);
  return { symbols, idOf: (s) => index.get(s)! };
}

// Per-symbol UTF-8, falling back to UTF-16LE when UTF-8 is not a faithful
// round-trip (a lone surrogate) → total-lossless for any JS string.
const TE = new TextEncoder();
const TD8 = new TextDecoder('utf-8');
function encodeSymbol(s: string): { symFlags: number; bytes: Uint8Array } {
  const utf8 = TE.encode(s);
  if (TD8.decode(utf8) === s) return { symFlags: 0, bytes: utf8 };
  const u16 = new Uint8Array(s.length * 2);
  const dv = new DataView(u16.buffer);
  for (let i = 0; i < s.length; i++) dv.setUint16(i * 2, s.charCodeAt(i), LE);
  return { symFlags: 1, bytes: u16 };
}
function decodeSymbol(symFlags: number, bytes: Uint8Array): string {
  if ((symFlags & 1) === 0) return new TextDecoder('utf-8').decode(bytes);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let s = '';
  for (let i = 0; i + 1 < bytes.byteLength + 1 && i * 2 < bytes.byteLength; i++) {
    s += String.fromCharCode(dv.getUint16(i * 2, LE));
  }
  return s;
}

// Packed-integer gates: take the compact path ONLY when reading it back is
// Object.is-equal to the input (so -0 / fractional / out-of-range fall to f64).
function tryPackLutInit(v: number): number | null {
  if (!Number.isInteger(v) || v < 0 || v > U16_MAX) return null;
  const back = v & 0xffff;
  return Object.is(back, v) ? back : null;
}
function reconstructBitPlanes(mask: number): number[] {
  const out: number[] = [];
  for (let i = 0; i <= 15; i++) if (mask & (1 << i)) out.push(i);
  return out;
}
function tryPackBitPlanes(planes: number[]): number | null {
  let mask = 0;
  for (const p of planes) {
    if (!Number.isInteger(p) || p < 0 || p > 15) return null;
    mask |= 1 << p;
  }
  const recon = reconstructBitPlanes(mask);
  if (recon.length !== planes.length) return null;
  for (let i = 0; i < planes.length; i++) if (!Object.is(recon[i], planes[i]!)) return null;
  return mask;
}

function checkCount(n: number, what: string): number {
  if (n > U16_MAX) throw new Error(`vfpga bitstream: ${what} exceeds 65535`);
  return n;
}

// ----------------------------------------------------------------------
// pack
// ----------------------------------------------------------------------
export function pack(fabric: VfpgaFabric): Uint8Array {
  const { symbols, idOf } = buildSymbolTable(fabric);
  const w = new ByteWriter();

  // HEADER (32 B)
  w.bytes(SYNC);
  w.bytes(MAGIC);
  w.u16(VERSION);
  w.u16(0); // headerFlags (reserved)
  w.f64(fabric.grid.rows);
  w.f64(fabric.grid.cols);
  w.u16(checkCount(fabric.tiles.length, 'tile count'));
  w.u16(checkCount(fabric.nets.length, 'net count'));

  // SYMBOL TABLE
  w.u16(checkCount(symbols.length, 'symbol count'));
  for (const s of symbols) {
    const { symFlags, bytes } = encodeSymbol(s);
    w.u8(symFlags);
    w.u16(checkCount(bytes.length, 'symbol byte length'));
    w.bytes(bytes);
  }

  // TILE CONFIG FRAMES (in tiles[] order)
  for (let ti = 0; ti < fabric.tiles.length; ti++) {
    const t = fabric.tiles[ti]!;
    const c = t.config;

    // presence/mode flag word
    let flags = 0;
    if (t.pos) flags |= F_POS;
    if (c.op !== undefined) flags |= F_OP;
    if (c.consts) flags |= F_CONSTS;
    if (c.bind) flags |= F_BIND;
    if (t.inputs) flags |= F_INPUTS;
    let lutPacked: number | null = null;
    if (c.lutInit !== undefined) {
      flags |= F_LUT_INIT;
      lutPacked = tryPackLutInit(c.lutInit);
      if (lutPacked !== null) flags |= F_LUT_INIT_PACKED;
    }
    let planesMask: number | null = null;
    if (c.bitPlanes !== undefined) {
      flags |= F_BIT_PLANES;
      planesMask = tryPackBitPlanes(c.bitPlanes);
      if (planesMask !== null) flags |= F_BIT_PLANES_PACKED;
    }
    if (c.taps !== undefined) flags |= F_TAPS;
    if (c.rows !== undefined) flags |= F_ROWS;
    if (c.clockDiv !== undefined) flags |= F_CLOCKDIV;
    if (c.kind !== undefined) { flags |= F_KIND; if (c.kind === 'float') flags |= F_KIND_FLOAT; }

    // frame head: decorative frame-address register, type, id
    const frameAddr = t.pos
      ? (((t.pos.row & 0xff) << 8) | (t.pos.col & 0xff)) & 0xffff
      : (0x8000 | (ti & 0x7fff));
    w.u16(frameAddr);
    w.u8(tileTypeToCode(t.type));
    w.u16(idOf(t.id));
    w.u16(flags);

    // payload (FIXED order — must mirror unpack)
    if (flags & F_POS) { w.f64(t.pos!.row); w.f64(t.pos!.col); }
    if (flags & F_OP) w.u16(idOf(c.op!));
    if (flags & F_LUT_INIT) { if (lutPacked !== null) w.u16(lutPacked); else w.f64(c.lutInit!); }
    if (flags & F_BIT_PLANES) {
      if (planesMask !== null) w.u16(planesMask);
      else { w.u16(checkCount(c.bitPlanes!.length, 'bitPlanes length')); for (const p of c.bitPlanes!) w.f64(p); }
    }
    if (flags & F_TAPS) { w.u16(checkCount(c.taps!.length, 'taps length')); for (const tap of c.taps!) w.f64(tap); }
    if (flags & F_ROWS) w.f64(c.rows!);
    if (flags & F_CLOCKDIV) w.f64(c.clockDiv!);
    if (flags & F_CONSTS) {
      const keys = Object.keys(c.consts!);
      w.u16(checkCount(keys.length, 'consts count'));
      for (const k of keys) { w.u16(idOf(k)); w.f64(c.consts![k]!); }
    }
    if (flags & F_BIND) {
      w.u16(checkCount(c.bind!.length, 'bind count'));
      for (const b of c.bind!) {
        w.u16(idOf(b.knob));
        w.u8(bindToCode(b.to));
        if (b.slot !== undefined) { w.u8(1); w.f64(b.slot); } else w.u8(0);
        w.u16(idOf(b.uniform));
      }
    }
    if (flags & F_INPUTS) { w.u16(checkCount(t.inputs!.length, 'inputs count')); for (const inp of t.inputs!) w.u16(idOf(inp)); }
  }

  // ROUTING TABLE (in nets[] order)
  for (const net of fabric.nets) { w.u16(idOf(net.from)); w.u16(idOf(net.to)); }

  // OUTPUTS DESCRIPTOR
  w.u16(idOf(fabric.outputs.vout1));
  if (fabric.outputs.vout2 !== undefined) { w.u8(1); w.u16(idOf(fabric.outputs.vout2)); } else w.u8(0);

  // BUDGET DESCRIPTOR
  const b = fabric.budget;
  if (b) {
    w.u8(1);
    let fieldFlags = 0;
    if (b.dsp !== undefined) fieldFlags |= 1 << 0;
    if (b.bramRows !== undefined) fieldFlags |= 1 << 1;
    if (b.passes !== undefined) fieldFlags |= 1 << 2;
    w.u8(fieldFlags);
    if (b.dsp !== undefined) w.f64(b.dsp);
    if (b.bramRows !== undefined) w.f64(b.bramRows);
    if (b.passes !== undefined) w.f64(b.passes);
  } else w.u8(0);

  // CRC TRAILER over everything written so far
  const body = w.toUint8Array();
  const out = new Uint8Array(body.length + 4);
  out.set(body, 0);
  new DataView(out.buffer).setUint32(body.length, crc32(body), LE);
  return out;
}

// ----------------------------------------------------------------------
// unpack
// ----------------------------------------------------------------------
export function unpack(bytes: Uint8Array): VfpgaFabric {
  if (bytes.length < 36) throw new Error('vfpga bitstream: too short');
  // CRC verify FIRST (unsigned compare) over bytes[0 .. len-4].
  const bodyEnd = bytes.length - 4;
  const want = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(bodyEnd, LE) >>> 0;
  const got = crc32(bytes, 0, bodyEnd) >>> 0;
  if (want !== got) throw new Error('vfpga bitstream: CRC mismatch (corrupted image)');

  const r = new ByteReader(bytes);
  // header
  const sync = r.raw(4);
  if (sync[0] !== SYNC[0] || sync[1] !== SYNC[1] || sync[2] !== SYNC[2] || sync[3] !== SYNC[3]) {
    throw new Error('vfpga bitstream: bad sync preamble');
  }
  const magic = r.raw(4);
  if (magic[0] !== MAGIC[0] || magic[1] !== MAGIC[1] || magic[2] !== MAGIC[2] || magic[3] !== MAGIC[3]) {
    throw new Error('vfpga bitstream: bad magic');
  }
  const version = r.u16();
  if (version !== VERSION) throw new Error(`vfpga bitstream: unsupported version ${version}`);
  const headerFlags = r.u16();
  if (headerFlags !== 0) throw new Error('vfpga bitstream: reserved header flags set');
  const gridRows = r.f64();
  const gridCols = r.f64();
  const tileCount = r.u16();
  const netCount = r.u16();

  // symbol table
  const symCount = r.u16();
  const symbols: string[] = new Array(symCount);
  for (let i = 0; i < symCount; i++) {
    const symFlags = r.u8();
    const byteLen = r.u16();
    symbols[i] = decodeSymbol(symFlags, r.raw(byteLen));
  }
  const sym = (i: number): string => {
    const s = symbols[i];
    if (s === undefined) throw new Error(`vfpga bitstream: symbol index ${i} out of range`);
    return s;
  };

  // tiles
  const tiles: VfpgaTile[] = new Array(tileCount);
  for (let ti = 0; ti < tileCount; ti++) {
    r.u16(); // frameAddr — decorative, ignored (pos is the source of truth)
    const type = codeToTileType(r.u8());
    const id = sym(r.u16());
    const flags = r.u16();
    if (flags & CONFIG_RESERVED) throw new Error('vfpga bitstream: reserved config flags set');

    const config: VfpgaTile['config'] = {};
    let pos: { row: number; col: number } | undefined;
    let inputs: string[] | undefined;

    if (flags & F_POS) pos = { row: r.f64(), col: r.f64() };
    if (flags & F_OP) config.op = sym(r.u16());
    if (flags & F_LUT_INIT) config.lutInit = flags & F_LUT_INIT_PACKED ? r.u16() : r.f64();
    if (flags & F_BIT_PLANES) {
      if (flags & F_BIT_PLANES_PACKED) config.bitPlanes = reconstructBitPlanes(r.u16());
      else { const n = r.u16(); const a: number[] = new Array(n); for (let i = 0; i < n; i++) a[i] = r.f64(); config.bitPlanes = a; }
    }
    if (flags & F_TAPS) { const n = r.u16(); const a: number[] = new Array(n); for (let i = 0; i < n; i++) a[i] = r.f64(); config.taps = a; }
    if (flags & F_ROWS) config.rows = r.f64();
    if (flags & F_CLOCKDIV) config.clockDiv = r.f64();
    if (flags & F_CONSTS) {
      const n = r.u16();
      const consts: Record<string, number> = {};
      for (let i = 0; i < n; i++) { const k = sym(r.u16()); consts[k] = r.f64(); }
      config.consts = consts;
    }
    if (flags & F_BIND) {
      const n = r.u16();
      const bind: VfpgaTileBind[] = new Array(n);
      for (let i = 0; i < n; i++) {
        const knob = sym(r.u16());
        const to = codeToBindTo(r.u8());
        const hasSlot = r.u8() === 1;
        const slot = hasSlot ? r.f64() : undefined;
        const uniform = sym(r.u16());
        bind[i] = hasSlot ? { knob, to, slot, uniform } : { knob, to, uniform };
      }
      config.bind = bind;
    }
    if (flags & F_INPUTS) { const n = r.u16(); const a: string[] = new Array(n); for (let i = 0; i < n; i++) a[i] = sym(r.u16()); inputs = a; }
    if (flags & F_KIND) config.kind = flags & F_KIND_FLOAT ? 'float' : 'rgba8';

    const tile: VfpgaTile = { id, type, config };
    if (pos) tile.pos = pos;
    if (inputs) tile.inputs = inputs;
    tiles[ti] = tile;
  }

  // routing
  const nets = new Array(netCount);
  for (let i = 0; i < netCount; i++) nets[i] = { from: sym(r.u16()), to: sym(r.u16()) };

  // outputs
  const vout1 = sym(r.u16());
  const outputs: VfpgaFabric['outputs'] = { vout1 };
  if (r.u8() === 1) outputs.vout2 = sym(r.u16());

  // budget
  const fabric: VfpgaFabric = { grid: { rows: gridRows, cols: gridCols }, tiles, nets, outputs };
  if (r.u8() === 1) {
    const fieldFlags = r.u8();
    const budget: NonNullable<VfpgaFabric['budget']> = {};
    if (fieldFlags & (1 << 0)) budget.dsp = r.f64();
    if (fieldFlags & (1 << 1)) budget.bramRows = r.f64();
    if (fieldFlags & (1 << 2)) budget.passes = r.f64();
    fabric.budget = budget;
  }
  return fabric;
}
