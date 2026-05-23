// packages/web/src/lib/video/modules/acidwarp-patterns.ts
//
// ACIDWARP plasma-pattern engine + palette generators.
//
// Algorithm port of Noah Spurrier's ACIDWARP (1992-1993, GPL), with
// Linux + SDL ports by Steven Wills and Boris Gjenero, expressed here in
// modern TypeScript using standard Math primitives instead of the
// original's lookup-table fixed-point arithmetic. Visual output matches
// the original (same scene formulas, same palette construction); the
// rewrite is in our own code style. Project license: AGPL-3.0-or-later,
// which is GPL-compatible.
//
// Two halves:
//   - generatePattern(scene, width, height) → Uint8Array(width × height)
//     of palette indices. Recomputed on scene change only.
//   - buildPalette(type) → Uint8Array(256 × 3) RGB triples (each byte
//     0..255). Rotated per-frame by the host module by shifting the
//     active-palette offset uniform.

/** Number of distinct scenes (0..SCENE_COUNT-1). The original ships 41. */
export const SCENE_COUNT = 41;

/** Palette types (4 base × 2 sparkle variants = 8 total). */
export const PALETTE_COUNT = 8;

/** Match the original's sin amplitude: the C code's `lut_sin` returns
 *  values scaled to ~±511, so a formula like `lut_sin(x) / 32` contributes
 *  ±16 to the running colour. We multiply Math.sin by the same factor so
 *  the integer divisions in each scene formula produce equivalent shifts. */
const SIN_SCALE = 511;

/** Angle units per full circle — matches the original's ANGLE_UNIT so that
 *  formulas referencing `ANGLE_UNIT / width * 2` etc. produce the same
 *  spatial frequency at our 320 × 240 output. */
const ANGLE_UNIT = 256;

/** Scaled sin/cos. Input angle is in ANGLE_UNIT units (256 = one cycle). */
function sn(a: number): number {
  return Math.sin((a / ANGLE_UNIT) * Math.PI * 2) * SIN_SCALE;
}
function cs(a: number): number {
  return Math.cos((a / ANGLE_UNIT) * Math.PI * 2) * SIN_SCALE;
}

/** Distance from origin. */
function dst(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}

/** Angle from origin in ANGLE_UNIT units (0..256). */
function ang(x: number, y: number): number {
  if (x === 0 && y === 0) return 0;
  // atan2 returns -π..+π; rescale to 0..ANGLE_UNIT.
  let a = (Math.atan2(y, x) / (Math.PI * 2)) * ANGLE_UNIT;
  if (a < 0) a += ANGLE_UNIT;
  return a;
}

/** Bitwise integer helpers — keep operands ≤ 32-bit for safety. */
function xor32(a: number, b: number): number {
  return ((a | 0) ^ (b | 0)) | 0;
}
function mod(a: number, n: number): number {
  // Match HP-28S / mathematician's convention: result has same sign as n.
  const r = a - Math.floor(a / n) * n;
  return r;
}

/** Mulberry32 — small deterministic PRNG so a scene re-render with the
 *  same seed yields the same offsets / rain noise (useful for tests). */
function makeRng(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Generate one full-screen pattern for a given scene id.
 *
 *  Pattern selection: scene mod SCENE_COUNT picks one of the 41 formulas
 *  from Spurrier's original (case 0..40). Each is a per-pixel math
 *  expression mixing distance, angle, and sin/cos of x/y modulators.
 *  The final `color` value is reduced mod 255 to fit the palette range;
 *  index 0 is reserved (black) so all output indices are 1..255.
 *
 *  Recompute cost: ~76,800 ops for 320 × 240; trivial at scene-change
 *  cadence (every few seconds at normal speed).
 */
export function generatePattern(args: {
  scene: number;
  width: number;
  height: number;
  /** Optional seed for the per-scene random offsets (default: derived
   *  from scene id so each scene is reproducible across renders). */
  seed?: number;
}): Uint8Array {
  const { width, height } = args;
  const scene = ((args.scene % SCENE_COUNT) + SCENE_COUNT) % SCENE_COUNT;
  const rng = makeRng(args.seed ?? (scene + 1) * 2654435761);

  const xc = width / 2;
  const yc = height / 2;
  const COLORS = 256;

  // Per-scene random offsets some formulas use to place sub-centers.
  // Match the original's range: each in [-20, +20].
  const o = Array.from({ length: 8 }, () => Math.floor(rng() * 40) - 20);
  const [x1, x2, x3, x4, y1, y2, y3, y4] = o as [number, number, number, number, number, number, number, number];

  const out = new Uint8Array(width * height);
  // For scenes that read previous-row neighbours (rain variants), we need
  // a signed buffer of the unwrapped `color` value before final modulo —
  // otherwise the wrapped 0..255 indices feed back chaotic noise. The
  // original used the same 8-bit cells; we follow suit.
  const raw = new Int32Array(width * height);

  for (let y = 0; y < height; y++) {
    const dy = y - yc;
    for (let x = 0; x < width; x++) {
      const dx = x - xc;
      const d = dst(dx, dy);
      const a = ang(dx, dy);
      let col = 0;

      switch (scene) {
        case 0:
          col = a + sn(d * 10) / 64 + cs((x * ANGLE_UNIT) / width * 2) / 32 + cs((y * ANGLE_UNIT) / height * 2) / 32;
          break;
        case 1:
          col = a + sn(d * 10) / 16 + cs((x * ANGLE_UNIT) / width * 2) / 8 + cs((y * ANGLE_UNIT) / height * 2) / 8;
          break;
        case 2:
          col = sn(dst(dx + x1, dy + y1) * 4) / 32 + sn(dst(dx + x2, dy + y2) * 8) / 32
              + sn(dst(dx + x3, dy + y3) * 16) / 32 + sn(dst(dx + x4, dy + y4) * 32) / 32;
          break;
        case 3:
          // Peacock — angle plus two off-center distance rings.
          col = a + sn(dst(dx + 20, dy) * 10) / 32 + a + sn(dst(dx - 20, dy) * 10) / 32;
          break;
        case 4:
          col = sn(d) / 16;
          break;
        case 5:
          col = cs((x * ANGLE_UNIT) / width) / 8 + cs((y * ANGLE_UNIT) / height) / 8 + a + sn(d) / 32;
          break;
        case 6:
          col = sn(dst(dx,      dy - 20) * 4) / 32
              + sn(dst(dx + 20, dy + 20) * 4) / 32
              + sn(dst(dx - 20, dy + 20) * 4) / 32;
          break;
        case 7:
          col = a + sn(dst(dx,      dy - 20) * 8) / 32
                  + sn(dst(dx + 20, dy + 20) * 8) / 32
                  + sn(dst(dx - 20, dy + 20) * 8) / 32;
          break;
        case 8:
          col = sn(dst(dx,      dy - 20) * 12) / 32
              + sn(dst(dx + 20, dy + 20) * 12) / 32
              + sn(dst(dx - 20, dy + 20) * 12) / 32;
          break;
        case 9: // five-arm star
          col = d + sn(5 * a) / 64;
          break;
        case 10:
          col = cs((x * ANGLE_UNIT) / width * 2) / 4 + cs((y * ANGLE_UNIT) / height * 2) / 4;
          break;
        case 11:
          col = cs((x * ANGLE_UNIT) / width) / 8 + cs((y * ANGLE_UNIT) / height) / 8;
          break;
        case 12: // concentric rings
          col = d;
          break;
        case 13: // simple rays
          col = a;
          break;
        case 14:
          col = a + sn(d * 8) / 32;
          break;
        case 15:
          col = sn(d * 4) / 32;
          break;
        case 16:
          col = d + sn(d * 4) / 32;
          break;
        case 17:
          col = sn(cs((2 * x * ANGLE_UNIT) / width)) / (20 + d)
              + sn(cs((2 * y * ANGLE_UNIT) / height)) / (20 + d);
          break;
        case 18:
          col = cs((7 * x * ANGLE_UNIT) / width) / (20 + d)
              + cs((7 * y * ANGLE_UNIT) / height) / (20 + d);
          break;
        case 19:
          col = cs((17 * x * ANGLE_UNIT) / width) / (20 + d)
              + cs((17 * y * ANGLE_UNIT) / height) / (20 + d);
          break;
        case 20:
          col = cs((17 * x * ANGLE_UNIT) / width) / 32 + cs((17 * y * ANGLE_UNIT) / height) / 32 + d + a;
          break;
        case 21:
          col = cs((7 * x * ANGLE_UNIT) / width) / 32 + cs((7 * y * ANGLE_UNIT) / height) / 32 + d;
          break;
        case 22:
          col = cs((7 * x * ANGLE_UNIT) / width) / 32  + cs((7 * y * ANGLE_UNIT) / height) / 32
              + cs((11 * x * ANGLE_UNIT) / width) / 32 + cs((11 * y * ANGLE_UNIT) / height) / 32;
          break;
        case 23:
          col = sn(a * 7) / 32;
          break;
        case 24:
          col = sn(dst(dx + x1, dy + y1) * 2) / 12
              + sn(dst(dx + x2, dy + y2) * 4) / 12
              + sn(dst(dx + x3, dy + y3) * 6) / 12
              + sn(dst(dx + x4, dy + y4) * 8) / 12;
          break;
        case 25:
          col = a + sn(dst(dx + x1, dy + y1) * 2) / 16
              + a + sn(dst(dx + x2, dy + y2) * 4) / 16
              +     sn(dst(dx + x3, dy + y3) * 6) /  8
              +     sn(dst(dx + x4, dy + y4) * 8) /  8;
          break;
        case 26:
          col = a + sn(dst(dx + x1, dy + y1) * 2) / 12
              + a + sn(dst(dx + x2, dy + y2) * 4) / 12
              + a + sn(dst(dx + x3, dy + y3) * 6) / 12
              + a + sn(dst(dx + x4, dy + y4) * 8) / 12;
          break;
        case 27:
          col = sn(dst(dx + x1, dy + y1) * 2) / 32
              + sn(dst(dx + x2, dy + y2) * 4) / 32
              + sn(dst(dx + x3, dy + y3) * 6) / 32
              + sn(dst(dx + x4, dy + y4) * 8) / 32;
          break;
        case 28: { // rain (uses previously-stored cells)
          if (y === 0 || x === 0) col = Math.floor(rng() * 16);
          else {
            const left = raw[y * width + (x - 1)]!;
            const up   = raw[(y - 1) * width + x]!;
            col = (left + up) / 2 + Math.floor(rng() * 16) - 8;
          }
          break;
        }
        case 29: {
          if (y === 0 || x === 0) col = Math.floor(rng() * 1024);
          else {
            const left = raw[y * width + (x - 1)]!;
            const up   = raw[(y - 1) * width + x]!;
            col = d / 6 + (left + up) / 2 + Math.floor(rng() * 16) - 8;
          }
          break;
        }
        case 30:
          col = xor32(
            xor32(sn(dst(dx,      dy - 20) * 4) / 32, sn(dst(dx + 20, dy + 20) * 4) / 32),
            sn(dst(dx - 20, dy + 20) * 4) / 32,
          );
          break;
        case 31:
          col = xor32(mod(a, ANGLE_UNIT / 4), d);
          break;
        case 32:
          col = xor32(dy, dx);
          break;
        case 33: { // rain variation 1
          if (y === 0 || x === 0) col = Math.floor(rng() * 16);
          else {
            const left = raw[y * width + (x - 1)]!;
            const up   = raw[(y - 1) * width + x]!;
            col = (left + up) / 2;
          }
          col += Math.floor(rng() * 2) - 1;
          if (col < 64) col += Math.floor(rng() * 16) - 8;
          break;
        }
        case 34: { // rain variation 2
          if (y === 0 || x === 0) col = Math.floor(rng() * 16);
          else {
            const left = raw[y * width + (x - 1)]!;
            const up   = raw[(y - 1) * width + x]!;
            col = (left + up) / 2;
          }
          if (col < 100) col += Math.floor(rng() * 16) - 8;
          break;
        }
        case 35: {
          let c = a + sn(d * 8) / 32;
          const dy2 = (y - yc) * 2;
          const d2 = dst(dx, dy2);
          const a2 = ang(dx, dy2);
          col = (c + a2 + sn(d2 * 8) / 32) / 2;
          break;
        }
        case 36: {
          let c = a + sn(d * 10) / 16 + cs((x * ANGLE_UNIT) / width * 2) / 8 + cs((y * ANGLE_UNIT) / height * 2) / 8;
          const dy2 = (y - yc) * 2;
          const d2 = dst(dx, dy2);
          const a2 = ang(dx, dy2);
          col = (c + a2 + sn(d2 * 8) / 32) / 2;
          break;
        }
        case 37: {
          let c = a + sn(d * 10) / 16 + cs((x * ANGLE_UNIT) / width * 2) / 8 + cs((y * ANGLE_UNIT) / height * 2) / 8;
          const dy2 = (y - yc) * 2;
          const d2 = dst(dx, dy2);
          const a2 = ang(dx, dy2);
          col = (c + a2 + sn(d2 * 10) / 16 + cs((x * ANGLE_UNIT) / width * 2) / 8 + cs((y * ANGLE_UNIT) / height * 2) / 8) / 2;
          break;
        }
        case 38: { // interlaced two-screen
          let dy2 = dy;
          let d2 = d;
          let a2 = a;
          if (y & 1) {
            dy2 = dy * 2;
            d2 = dst(dx, dy2);
            a2 = ang(dx, dy2);
          }
          col = a2 + sn(d2 * 8) / 32;
          break;
        }
        case 39: {
          let c = xor32(mod(a, ANGLE_UNIT / 4), d);
          const dy2 = (y - yc) * 2;
          const d2 = dst(dx, dy2);
          const a2 = ang(dx, dy2);
          col = (c + xor32(mod(a2, ANGLE_UNIT / 4), d2)) / 2;
          break;
        }
        case 40: {
          let c = xor32(dy, dx);
          const dy2 = (y - yc) * 2;
          col = (c + xor32(dy2, dx)) / 2;
          break;
        }
      }

      raw[y * width + x] = col | 0;

      // Wrap into 1..(COLORS-1). Index 0 is reserved (kept black). The
      // original handled negative values the HP-28S way; we match it.
      let idx = Math.trunc(col) % (COLORS - 1);
      if (idx < 0) idx += COLORS - 1;
      out[y * width + x] = (idx + 1) & 0xff;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
//  Palette generators — port of Spurrier's palinit.c. Each builds 256 × 3
//  bytes (RGB triples). Color 0 is kept at black. The original wrote 6-bit
//  VGA values; we scale to full 8-bit by multiplying by 4.
// ---------------------------------------------------------------------------

const VGA_TO_RGB8 = 4; // 0..63 → 0..252 (close enough to 255)

/** 4 base palette types: RGBW (rainbow), W (greyscale), W_HALF, PASTEL.
 *  Adding 4 to a type id ORs in the "lightning" sparkle pass. */
export type PaletteType = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** Build an RGB8 palette (256×3 = 768 bytes). */
export function buildPalette(type: PaletteType): Uint8Array {
  const pal = new Uint8Array(256 * 3);
  switch (type & 3) {
    case 0: paletteRGBW(pal); break;
    case 1: paletteGrey(pal); break;
    case 2: paletteHalfGrey(pal); break;
    case 3: palettePastel(pal); break;
  }
  if (type & 4) addSparkles(pal, 9);
  return pal;
}

function set6bit(pal: Uint8Array, idx: number, r: number, g: number, b: number) {
  pal[idx * 3]     = Math.min(252, Math.max(0, r)) * VGA_TO_RGB8;
  pal[idx * 3 + 1] = Math.min(252, Math.max(0, g)) * VGA_TO_RGB8;
  pal[idx * 3 + 2] = Math.min(252, Math.max(0, b)) * VGA_TO_RGB8;
}

/** Four-quadrant rainbow: red / green / blue / white ramps, each 64 entries
 *  long (rising 32 then falling 32). Matches Spurrier's RGBW layout. */
function paletteRGBW(pal: Uint8Array) {
  for (let i = 0; i < 32; i++) {
    const v = i * 2;
    set6bit(pal, i,        v, 0, 0); // red quadrant rising
    set6bit(pal, i + 64,   0, v, 0); // green
    set6bit(pal, i + 128,  0, 0, v); // blue
    set6bit(pal, i + 192,  v, v, v); // white
  }
  for (let i = 32; i < 64; i++) {
    const v = (63 - i) * 2;
    set6bit(pal, i,        v, 0, 0);
    set6bit(pal, i + 64,   0, v, 0);
    set6bit(pal, i + 128,  0, 0, v);
    set6bit(pal, i + 192,  v, v, v);
  }
}

/** Linear black → mid-grey ramp on the low 128, mirrored grey → black
 *  on the upper 128. The triangle-wave palette is half-amplitude (peak
 *  at index 127 = 63/2 = ~31 grey out of 63). */
function paletteGrey(pal: Uint8Array) {
  for (let i = 0; i < 128; i++) {
    const v = (i >> 1);
    set6bit(pal, i, v, v, v);
  }
  for (let i = 128; i < 256; i++) {
    const v = ((255 - i) >> 1);
    set6bit(pal, i, v, v, v);
  }
}

/** Half-grey: same triangle but contained in the first 128 entries (the
 *  upper half stays at black so palette rotation produces gaps). */
function paletteHalfGrey(pal: Uint8Array) {
  for (let i = 0; i < 64; i++) {
    set6bit(pal, i,      i,             i,             i);
    set6bit(pal, i + 64, (63 - i),      (63 - i),      (63 - i));
  }
  for (let i = 128; i < 256; i++) {
    set6bit(pal, i, 0, 0, 0);
  }
}

/** Pastel: never reaches pure black — the value is biased up by 31. */
function palettePastel(pal: Uint8Array) {
  for (let i = 0; i < 128; i++) {
    set6bit(pal, i,        31 + (i >> 2),         31 + (i >> 2),         31 + (i >> 2));
    set6bit(pal, i + 128,  31 + ((127 - i) >> 2), 31 + ((127 - i) >> 2), 31 + ((127 - i) >> 2));
  }
}

/** "Lightning" pass — brighten every fourth entry by +`amt` (clamped 0..63
 *  in 6-bit space). Produces the sparkle that overlays the base palette. */
function addSparkles(pal: Uint8Array, amt: number) {
  for (let i = 1; i < 256; i += 4) {
    pal[i * 3]     = Math.min(252, pal[i * 3]!     + amt * VGA_TO_RGB8);
    pal[i * 3 + 1] = Math.min(252, pal[i * 3 + 1]! + amt * VGA_TO_RGB8);
    pal[i * 3 + 2] = Math.min(252, pal[i * 3 + 2]! + amt * VGA_TO_RGB8);
  }
}

/** Rotate the palette by `offset` slots (positive = forward).
 *  Pure helper — returns a new array so the host can hot-swap the GL
 *  uniform texture without aliasing the canonical palette. */
export function rotatePalette(pal: Uint8Array, offset: number): Uint8Array {
  const out = new Uint8Array(pal.length);
  const N = 256;
  // Rotation cycles over the 255 non-zero slots (slot 0 is reserved).
  const cycle = N - 1;
  const o = ((offset % cycle) + cycle) % cycle;
  out[0] = 0; out[1] = 0; out[2] = 0;
  for (let i = 1; i < N; i++) {
    const src = ((i - 1 + o) % cycle) + 1;
    out[i * 3]     = pal[src * 3]!;
    out[i * 3 + 1] = pal[src * 3 + 1]!;
    out[i * 3 + 2] = pal[src * 3 + 2]!;
  }
  return out;
}
