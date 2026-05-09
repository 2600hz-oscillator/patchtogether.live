// packages/web/src/lib/audio/dx7-syx.ts
//
// DX7 SYX (System Exclusive) bank parser.
//
// The standard "32-voice cartridge" format the original Yamaha DX7 emits and
// reads is a 4104-byte block:
//
//   offset   bytes  meaning
//   ------   -----  -------
//   0        1      0xF0  status (sysex-start)
//   1        1      0x43  manufacturer (Yamaha)
//   2        1      0x00  sub-status / channel (lower nibble = channel)
//   3        1      0x09  format = 9 (32-voice bulk)
//   4        2      0x20 0x00  byte count = 4096 (= 32 voices × 128 bytes)
//   6        4096   payload (32 packed voices, 128 bytes each)
//   4102     1      checksum (~sum(payload) + 1) & 0x7F
//   4103     1      0xF7  EOX (sysex-end)
//
// Each packed voice is 128 bytes (the format calls this the "compressed"
// voice; the un-packed "uncompressed" voice format is 155 bytes).
//
//   per-op (6 ops, each 17 bytes, packed bits per the 1983 manual):
//     0..3   R1..R4   (rates 0..99)
//     4..7   L1..L4   (levels 0..99)
//     8      KBD LVL SCL BREAK POINT (0..99)
//     9      KBD LVL SCL LEFT DEPTH (0..99)
//     10     KBD LVL SCL RIGHT DEPTH (0..99)
//     11     bit 0..1 = LEFT CURVE, bit 2..3 = RIGHT CURVE
//     12     bit 0..2 = RATE SCALING (0..7), bit 3..6 = DETUNE (0..14, 7 = 0)
//     13     bit 0..1 = AMP MOD SENS (0..3), bit 2..4 = KEY VELOCITY SENS (0..7)
//     14     OP OUTPUT LEVEL (0..99)
//     15     bit 0 = OSC MODE (0=ratio, 1=fixed),
//            bits 1..5 = FREQ COARSE (0..31)
//     16     OP FREQ FINE (0..99)
//   then global-per-voice (32 bytes):
//     102..109   PITCH EG R1..R4, L1..L4
//     110        ALGORITHM (0..31)
//     111        bit 0..2 = FEEDBACK, bit 3 = OSC SYNC
//     112        LFO SPEED
//     113        LFO DELAY
//     114        LFO PITCH MOD DEPTH
//     115        LFO AMP MOD DEPTH
//     116        bit 0 = LFO SYNC, bit 1..3 = LFO WAVE,
//                bit 4..6 = PITCH MOD SENS
//     117        TRANSPOSE (0..48; 12 = middle C / no transpose)
//     118..127   VOICE NAME (10 ASCII bytes, padded)
//
// The DX7 envelope numbers are the famous quirk — "rates" go 0..99 where
// 99 is fastest and 0 is slowest; the response is not linear (the relationship
// to seconds is roughly exponential). The frequency RATIO uses Yamaha's odd
// table (per dx7Ratio() below).
//
// Helpers exposed:
//   parseSyxBank(bytes: Uint8Array)         → { voices: DX7Voice[]; warnings: string[] }
//   dx7Ratio(coarse: number, fine: number)  → number (operator frequency multiplier)
//   dx7DetuneFactor(detune: number)         → number (cents → ratio)

export interface DX7OpData {
  /** 0..3 = attack/decay envelope rates; 4..7 = ascending levels. */
  r: [number, number, number, number];
  l: [number, number, number, number];
  /** Frequency ratio relative to note pitch (operator carrier or modulator). */
  ratio: number;
  /** Operator output level 0..99 (the famous DX7 op-level scale). */
  level: number;
  /** ±cents detune (computed via dx7DetuneFactor; we store the raw 0..14
   *  byte and the precomputed factor for convenience). */
  detune: number;
  detuneFactor: number;
  /** Velocity sensitivity 0..7. */
  velocitySens: number;
  /** Whether oscillator is fixed-frequency (rare; we still synthesize but
   *  ignore the pitch CV when true). */
  fixedMode: boolean;
}

export interface DX7Voice {
  name: string;        // 10-char ASCII (trimmed)
  algorithm: number;   // 1..32 (we expose 1-indexed; SYX is 0-indexed)
  feedback: number;    // 0..7
  operators: DX7OpData[]; // length 6 (op 1 first)
  pitchEg: { r: [number, number, number, number]; l: [number, number, number, number] };
  lfo: {
    speed: number;     // 0..99
    delay: number;     // 0..99
    pmd: number;       // pitch mod depth 0..99
    amd: number;       // amp mod depth 0..99
    sync: boolean;
    waveform: number;  // 0..5
    pitchModSens: number; // 0..7
  };
  transpose: number;   // semitones offset (0 = middle C, ±24 typical)
}

export interface ParseResult {
  voices: DX7Voice[];
  warnings: string[];
}

// ---------------- Constants ----------------

const SYSEX_START = 0xf0;
const YAMAHA_ID = 0x43;
const FORMAT_32_VOICE = 0x09;
const SYSEX_END = 0xf7;
const PAYLOAD_SIZE = 4096;
const VOICE_SIZE_PACKED = 128;
const VOICE_COUNT = 32;
const FULL_BANK_SIZE = 4104;

// ---------------- Math helpers ----------------

/**
 * Yamaha DX7 frequency ratio. coarse 0..31 selects a base ratio; fine 0..99
 * scales it linearly to the next integer ratio.
 *
 *   coarse=0 → 0.5  (special: half pitch)
 *   coarse=1 → 1.00
 *   coarse=2 → 2.00
 *   coarse=3 → 3.00
 *   coarse=N → N    (N = 1..31)
 *
 * Fine is encoded such that ratio = baseRatio * (1 + fine/100).
 *
 * Reference: bryc gist / Reverb Machine "Exploring the DX7" §2c (and the
 * Yamaha DX7 service manual table A-1).
 */
export function dx7Ratio(coarse: number, fine: number): number {
  const c = clampInt(coarse, 0, 31);
  const f = clampInt(fine, 0, 99);
  const base = c === 0 ? 0.5 : c;
  return base * (1 + f / 100);
}

/**
 * DX7 operator detune. Stored as 0..14; the table is symmetric around 7
 * (= no detune). Each step is roughly ±0.42 Hz at A4 in the original
 * hardware, but we model it as a multiplicative factor in cents to scale
 * with pitch — close enough for "DX7 character".
 *
 *   detune byte → cents:  -7 → -7c, ... 0 → 0c, ... +7 → +7c
 */
export function dx7DetuneFactor(detune: number): number {
  const d = clampInt(detune, 0, 14) - 7; // -7..+7 (raw -> centered)
  // ~0.6 cents per step (very subtle on the original; we slightly exaggerate
  // so detune is audible without being out-of-tune).
  const cents = d * 1.5;
  return Math.pow(2, cents / 1200);
}

function clampInt(v: number, lo: number, hi: number): number {
  const i = Math.round(v);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

// ---------------- Voice parser ----------------

/** Parse one packed 128-byte voice block. */
function parsePackedVoice(buf: Uint8Array, off: number): DX7Voice {
  // Per-operator: SYX stores ops in REVERSE order (op6, op5, ... op1) in some
  // dumps and forward in others; the standard "32-voice bulk" format stores
  // them in op6→op1 order. We reverse so operators[0] = op1.
  const ops: DX7OpData[] = [];
  for (let opIdx = 0; opIdx < 6; opIdx++) {
    const o = off + opIdx * 17;
    const r0 = buf[o + 0]! & 0x7f;
    const r1 = buf[o + 1]! & 0x7f;
    const r2 = buf[o + 2]! & 0x7f;
    const r3 = buf[o + 3]! & 0x7f;
    const l0 = buf[o + 4]! & 0x7f;
    const l1 = buf[o + 5]! & 0x7f;
    const l2 = buf[o + 6]! & 0x7f;
    const l3 = buf[o + 7]! & 0x7f;

    const b12 = buf[o + 12]!;
    const detune = (b12 >> 3) & 0x0f;
    const b13 = buf[o + 13]!;
    const velocitySens = (b13 >> 2) & 0x07;
    const level = buf[o + 14]! & 0x7f;
    const b15 = buf[o + 15]!;
    const fixedMode = (b15 & 0x01) !== 0;
    const coarse = (b15 >> 1) & 0x1f;
    const fine = buf[o + 16]! & 0x7f;

    ops.push({
      r: [r0, r1, r2, r3],
      l: [l0, l1, l2, l3],
      ratio: dx7Ratio(coarse, fine),
      level,
      detune,
      detuneFactor: dx7DetuneFactor(detune),
      velocitySens,
      fixedMode,
    });
  }
  // Reverse so operators[0] = op1 (musical convention; SYX stores op6 first).
  ops.reverse();

  const pe = off + 102;
  const pitchEg = {
    r: [buf[pe]!, buf[pe + 1]!, buf[pe + 2]!, buf[pe + 3]!] as [number, number, number, number],
    l: [buf[pe + 4]!, buf[pe + 5]!, buf[pe + 6]!, buf[pe + 7]!] as [number, number, number, number],
  };
  const algorithm = (buf[off + 110]! & 0x1f) + 1; // 1..32
  const fbByte = buf[off + 111]!;
  const feedback = fbByte & 0x07;
  const lfoSpeed = buf[off + 112]! & 0x7f;
  const lfoDelay = buf[off + 113]! & 0x7f;
  const lfoPmd = buf[off + 114]! & 0x7f;
  const lfoAmd = buf[off + 115]! & 0x7f;
  const lfoByte = buf[off + 116]!;
  const lfoSync = (lfoByte & 0x01) !== 0;
  const lfoWave = (lfoByte >> 1) & 0x07;
  const pitchModSens = (lfoByte >> 4) & 0x07;
  const transpose = buf[off + 117]! & 0x7f;
  // Voice name: 10 ASCII bytes; the DX7 character ROM has a few non-ASCII
  // glyphs but we coerce them to '?' for safety.
  let name = '';
  for (let i = 0; i < 10; i++) {
    const c = buf[off + 118 + i]!;
    name += c >= 32 && c < 127 ? String.fromCharCode(c) : '?';
  }

  return {
    name: name.trim(),
    algorithm,
    feedback,
    operators: ops,
    pitchEg,
    lfo: {
      speed: lfoSpeed,
      delay: lfoDelay,
      pmd: lfoPmd,
      amd: lfoAmd,
      sync: lfoSync,
      waveform: lfoWave,
      pitchModSens,
    },
    transpose,
  };
}

/**
 * Parse a 32-voice DX7 SYX cartridge dump. Lenient: we accept either the full
 * 4104-byte sysex frame (with start/end + checksum), or just the 4096-byte
 * payload, or even just one 128-byte packed voice.
 *
 * Warnings (non-fatal):
 *   - Checksum mismatch (still parses; some dumps have garbage checksums).
 *   - Wrong manufacturer / format byte (still parses if size matches one of
 *     the known shapes).
 */
export function parseSyxBank(bytes: Uint8Array): ParseResult {
  const warnings: string[] = [];

  let payload: Uint8Array | null = null;

  if (bytes.length === FULL_BANK_SIZE) {
    if (bytes[0] !== SYSEX_START) warnings.push(`expected SysEx start 0xF0, got 0x${bytes[0]!.toString(16)}`);
    if (bytes[1] !== YAMAHA_ID) warnings.push(`expected Yamaha 0x43, got 0x${bytes[1]!.toString(16)}`);
    if (bytes[3] !== FORMAT_32_VOICE) warnings.push(`expected format 0x09 (32-voice), got 0x${bytes[3]!.toString(16)}`);
    if (bytes[FULL_BANK_SIZE - 1] !== SYSEX_END) warnings.push(`expected EOX 0xF7, got 0x${bytes[FULL_BANK_SIZE - 1]!.toString(16)}`);

    payload = bytes.subarray(6, 6 + PAYLOAD_SIZE);

    const declaredChecksum = bytes[FULL_BANK_SIZE - 2]!;
    const sum = computeChecksum(payload);
    if (declaredChecksum !== sum) {
      warnings.push(`checksum mismatch: declared 0x${declaredChecksum.toString(16)}, computed 0x${sum.toString(16)}`);
    }
  } else if (bytes.length === PAYLOAD_SIZE) {
    payload = bytes;
    warnings.push('input is raw 4096-byte payload (no SysEx envelope) — parsed without checksum check');
  } else if (bytes.length === VOICE_SIZE_PACKED) {
    // Single voice — wrap into a 1-voice payload.
    return { voices: [parsePackedVoice(bytes, 0)], warnings: ['input is a single 128-byte voice'] };
  } else {
    throw new Error(
      `unsupported SYX size ${bytes.length}; expected ${FULL_BANK_SIZE} (full bank), ${PAYLOAD_SIZE} (raw payload), or ${VOICE_SIZE_PACKED} (single voice)`,
    );
  }

  const voices: DX7Voice[] = [];
  for (let i = 0; i < VOICE_COUNT; i++) {
    voices.push(parsePackedVoice(payload, i * VOICE_SIZE_PACKED));
  }
  return { voices, warnings };
}

/** Yamaha checksum: 2's complement of the lower 7 bits of the payload sum. */
export function computeChecksum(payload: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < payload.length; i++) s = (s + payload[i]!) & 0xff;
  return (-s) & 0x7f;
}

// ---------------- Envelope time helpers ----------------

/**
 * Convert a DX7 rate byte (0..99) to a per-second envelope coefficient.
 *
 * The original DX7 uses an exponential rate table — rate 99 is roughly 4 ms
 * to traverse the full level range; rate 0 is several seconds. We model it
 * as a 1-pole exponential decay with `tauSeconds = base * exp(-rate * k)`,
 * tuned so that:
 *   rate ≈ 99 → tau ≈ 0.001 s  (very fast)
 *   rate ≈ 50 → tau ≈ 0.05 s
 *   rate ≈ 0  → tau ≈ 8 s
 *
 * Returns the per-second time-constant (1/τ) suitable for `value += (target -
 * value) * (1 - exp(-coef * dt))` style integration.
 */
export function dx7RateToCoef(rate: number): number {
  const r = clampInt(rate, 0, 99);
  // Empirical: tauSeconds ≈ 8 * exp(-0.09 * r). Solving gives the coef table
  // used in many DX7 emulations (Dexed, hexter). The exact mapping isn't
  // documented; this is a "musically close" approximation.
  const tauSeconds = 8 * Math.exp(-0.09 * r);
  return 1 / Math.max(tauSeconds, 0.0005);
}

/** Convert a DX7 level byte (0..99) to linear amplitude 0..1.
 *  The DX7 exposes "operator output level" on a roughly logarithmic scale:
 *  level 99 = full output; ~6 dB per 8 units below that. */
export function dx7LevelToAmp(level: number): number {
  const l = clampInt(level, 0, 99);
  if (l === 0) return 0;
  // 99 → 1.0, 91 → ~0.5, 83 → ~0.25, ...
  const dB = (l - 99) * 0.75; // ~6 dB per 8 units
  return Math.pow(10, dB / 20);
}
