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
//     117        TRANSPOSE (0..48; 24 = middle C / no transpose, i.e. the
//                stored byte is the semitone offset BIASED BY +24, so the
//                engine plays `transpose - 24` semitones)
//     118..127   VOICE NAME (10 ASCII bytes, padded)
//
// The DX7 envelope numbers are the famous quirk — "rates" go 0..99 where 99 is
// fastest and 0 is slowest, and the decay segments run LINEAR IN dB at a speed
// that doubles every four steps of the quantised rate. The envelope both
// STARTS and ENDS at L4 and HOLDS at L3 for as long as the gate is high. See
// the mirrored law block at the bottom of this file for the derivation and its
// two authoritative sources. The frequency RATIO uses Yamaha's odd table (per
// dx7Ratio() below); a FIXED-mode operator ignores it entirely and runs at
// 10^((coarse & 3) + fine/100) Hz.
//
// Helpers exposed:
//   parseSyxBank(bytes: Uint8Array)         → { voices: DX7Voice[]; warnings: string[] }
//   dx7Ratio(coarse: number, fine: number)  → number (operator frequency multiplier)
//   dx7DetuneFactor(detune: number)         → number (cents → ratio)
//   dx7LevelToAmp / dx7LevelToDb            → operator level byte → amplitude / dB
//   dx7RateToDbPerSec                       → operator rate byte → dB per second
//   dx7EgTick                               → one operator-envelope step
//   dx7FixedHz / dx7FixedHzFromRatio        → fixed-mode operator frequency

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
  /** Whether the oscillator is FIXED-frequency: it ignores the note pitch and
   *  the detune ratio entirely and runs at `fixedHz`. */
  fixedMode: boolean;
  /** Fixed-mode frequency in Hz — `10^((coarse & 3) + fine/100)`, i.e. coarse
   *  picks the decade (1/10/100/1000 Hz) and fine sweeps it up to just under
   *  the next one. Only meaningful when `fixedMode` is true.
   *
   *  OPTIONAL because patches saved before the fixed-frequency fix stored only
   *  the derived `ratio`; consumers fall back to `dx7FixedHzFromRatio(ratio)`.
   *  (A future PR stores raw `coarse`/`fine` and this becomes derived.) */
  fixedHz?: number;
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
  /** RAW SYX transpose byte, 0..48, biased by +24: **24 = middle C / no
   *  transpose**. The engine plays `transpose - 24` semitones, so 12 is an
   *  octave DOWN and 36 an octave up. (This is the stored byte, not the
   *  signed offset — do not "fix" it to 0-centred without migrating every
   *  saved patch and every built-in in dx7-banks.ts.) */
  transpose: number;
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
      fixedHz: dx7FixedHz(coarse, fine),
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

// ==============================================================
// THE OPERATOR ENVELOPE + FIXED-FREQUENCY LAW.
//
// MIRRORED VERBATIM into `packages/dsp/src/dx7.ts` (the worklet bundle cannot
// import from the web workspace). The region between the two
// `dx7-envelope-mirror` markers must be TEXTUALLY IDENTICAL on both sides
// modulo the `export ` keyword — `dx7-envelope-mirror.test.ts` extracts both
// blocks, normalises them, requires equality, AND evaluates the worklet's copy
// to cross-check it numerically against these functions. Edit one side only
// and that gate goes red.
//
// PROVENANCE — decoded from two INDEPENDENT authoritative reimplementations of
// the hardware and cross-validated against each other:
//
//   (a) Dexed / Google music-synthesizer-for-android `Source/msfa/env.cc`
//       (Raph Levien's measurement-derived model; the engine ajxs.me's
//       "Yamaha DX7 Technical Analysis" cites for the EGS/OPS numeric
//       formats). It gives the closed-form rate law and the segment machine:
//         · `keydown(d)` → `advance(d ? 0 : 3)`  — note-on enters segment 0,
//           note-off jumps straight to segment 3.
//         · `getsample()` runs only `if (ix_ < 3 || ((ix_ < 4) && !down_))` —
//           so on reaching segment index 3 with the key still DOWN the
//           envelope FREEZES. That freeze is the sustain: it HOLDS AT L3.
//         · falling: `level_ -= inc_` — LINEAR IN dB.
//         · rising:  jump to `jumptarget = 1716` if below, then
//           `level_ += (((17 << 24) - level_) >> 24) * inc_` — an asymptotic
//           approach in the log domain, i.e. NOT the same law as the decay.
//         · `inc_ = (4 + (qrate & 3)) << (2 + LG_N + (qrate >> 2))` with
//           `qrate = (rate * 41) >> 6` clamped to 63. (The `LG_N` block-size
//           terms cancel against the blocks-per-second factor, so the law is
//           block-size independent: dB/s ∝ (4 + (q&3)) · 2^(q>>2).)
//
//   (b) hexter (Sean Bolton), `src/dx7_voice.c` + `src/dx7_voice_data.c` —
//       an independent emulation whose EG tables were MEASURED off real
//       DX7/TX7 hardware. It confirms each of the above separately:
//         · `dx7_op_envelope_prepare`: `op->eg.value = INT_TO_FP(op->eg.level[3])`
//           — the envelope's starting value on note-on is **L4**.
//         · `dx7_op_eg_set_next_phase` `case 2: eg->mode = DX7_EG_SUSTAINING;
//           eg->increment = 0; eg->duration = -1;` — HOLDS at L3.
//         · `dx7_voice_set_release_phase` → phase 3 — release targets L4.
//           L4 is therefore both the START and the END of the envelope.
//         · rising from level ≤ 31 "rise[s] quickly to 31, then continue[s]
//           normally" — the same attack compensation msfa spells `jumptarget
//           = 1716`, which back-converts to EG level ≈ 31. Same constant.
//         · `dx7_voice_eg_rate_decay_duration[]` — measured seconds for a
//           full-scale decay at every rate 0..99.
//
// CROSS-VALIDATION (this is the bar PR 0 set: two sources that agree):
//   · Rate law. msfa's closed form predicts a full-scale decay time of
//     `span / ((4 + (q&3))·2^(q>>2)·K)`. Fitting K to hexter's measured
//     `decay_duration[0] = 317.487 s` reproduces hexter's ENTIRE measured
//     table to ~1 % for rates 0..92 across a 55 000:1 dynamic range
//     (rate 10: 105.81 vs 105.81 · rate 25: 19.85 vs 19.85 · rate 40: 3.968
//     vs 3.968 · rate 50: 1.240 vs 1.240 · rate 70: 0.1558 vs 0.1558). Only
//     the top ~6 rates diverge, where hexter's table saturates at its
//     measurement floor. Two independent derivations, one law.
//   · Attack. msfa gives the FORM (asymptotic in the log domain) and the
//     level-31 jump; hexter's measured `decay_duration[r] / rise_duration[r]`
//     is a flat **8.01** across rates 0..70, which pins the one free constant
//     (the ceiling). The result reproduces hexter's ENTIRE measured
//     `rise_duration[]` table to <0.5 % for rates 0..70 as well — and the
//     fitted ceiling, 13.92 dB, falls INSIDE the 12.04–18.06 dB bracket the
//     two defensible msfa anchorings give. Neither table was fitted beyond
//     its single anchor row.
//
// WHAT WE DELIBERATELY KEEP: the project's own `(level - 99) · 0.75 dB` level
// scale (`dx7LevelToAmp`, unchanged). The rate law is absolute (dB per
// second), so it drops straight onto that scale; only the FULL-SCALE span
// differs (74.25 dB here vs ~90 dB in msfa's internal units), which is why
// the rate calibration below is anchored on hexter's measured seconds rather
// than on msfa's internal level units.
// ==============================================================

// dx7-envelope-mirror:start

/** 20·log10(2) — one octave of amplitude, in dB. */
export const DX7_DB_PER_OCTAVE = 6.020599913279624;

/** dB per unit of the 0..99 operator LEVEL scale; level 99 = 0 dB = unity. */
export const DX7_EG_LEVEL_DB_PER_STEP = 0.75;

/** Level 0 — the envelope's silence floor, in dB. Reaching it means zero. */
export const DX7_EG_FLOOR_DB = (0 - 99) * DX7_EG_LEVEL_DB_PER_STEP;

/** The attack-compensation floor: a rising segment starting below this snaps
 *  up to it first. msfa's `jumptarget = 1716` back-converts to EG level 31,
 *  which is exactly hexter's "rise quickly to 31, then continue normally"
 *  (and why hexter's `rise_percent[0..31]` are all 1e-5 — levels below 31
 *  cost no time). */
export const DX7_EG_ATTACK_JUMP_DB = (31 - 99) * DX7_EG_LEVEL_DB_PER_STEP;

/** hexter's MEASURED ratio of full-scale decay time to full-scale attack time
 *  at the SAME rate byte: `decay_duration[r] / rise_duration[r]`, a flat 8.01
 *  across rates 0..70 (it drifts only where the measurement resolution runs
 *  out). This is the attack's one calibration constant. */
export const DX7_EG_ATTACK_SPEEDUP = 8.01;

/** The rising asymptote. msfa's rising law is
 *  `level_ += (((17 << 24) - level_) >> 24) * inc_` — the increment scales
 *  with the distance to a ceiling — but WHERE that ceiling lands on OUR level
 *  scale is ambiguous, because ours spans 74.25 dB and msfa's ~90: pinning our
 *  level 99 to msfa's unity-gain reference (`14 << 24`) gives 18.06 dB, and
 *  pinning it to msfa's maximum EG output gives 12.04 dB. So we take the form
 *  from msfa and the CALIBRATION from hexter's hardware measurement, solving
 *    -FLOOR / (DB_PER_OCTAVE · ln(1 - JUMP/CEIL)) = ATTACK_SPEEDUP
 *  for the ceiling. The answer, 13.92 dB, sits inside the msfa bracket — which
 *  is the cross-check that the two sources describe the same curve. */
export const DX7_EG_ATTACK_CEIL_DB =
  -DX7_EG_ATTACK_JUMP_DB /
  (Math.exp(-DX7_EG_FLOOR_DB / (DX7_DB_PER_OCTAVE * DX7_EG_ATTACK_SPEEDUP)) - 1);

/** hexter's MEASURED seconds for a full-scale decay at rate 0
 *  (`dx7_voice_eg_rate_decay_duration[0]`). The rate law's one calibration
 *  constant; the shape of the curve is msfa's closed form. */
export const DX7_EG_RATE0_FULL_SCALE_S = 317.487;

/** dB/s contributed by one unit of the quantised rate's mantissa. */
export const DX7_EG_RATE_UNIT_DB_PER_S =
  -DX7_EG_FLOOR_DB / DX7_EG_RATE0_FULL_SCALE_S / 4;

/** Envelope LEVEL byte (0..99) → dB, on the same scale `dx7LevelToAmp` uses. */
export function dx7LevelToDb(level: number): number {
  return (clampInt(level, 0, 99) - 99) * DX7_EG_LEVEL_DB_PER_STEP;
}

/** Envelope RATE byte (0..99) → dB per second, LINEAR IN dB (msfa's
 *  `inc_ = (4 + (qrate & 3)) << (2 + LG_N + (qrate >> 2))`). Quantised: the
 *  99 rate bytes collapse onto 64 distinct speeds, exactly as on the hardware. */
export function dx7RateToDbPerSec(rate: number): number {
  const q = Math.min(63, (clampInt(rate, 0, 99) * 41) >> 6);
  return (4 + (q & 3)) * Math.pow(2, q >> 2) * DX7_EG_RATE_UNIT_DB_PER_S;
}

/** Envelope dB → linear amplitude. The floor is hard zero, so a segment that
 *  lands on level 0 is truly silent and the voice allocator can free the slot. */
export function dx7EgAmpFromDb(db: number): number {
  return db <= DX7_EG_FLOOR_DB ? 0 : Math.pow(10, db / 20);
}

/**
 * Advance ONE operator's envelope by `dt` seconds, in place.
 *
 * `envSeg[i]` is the DX7 segment index: 0..2 run while the gate is high, 3 is
 * the release (entered only on note-off), 4 means finished. Reaching 3 with
 * the gate still high is the SUSTAIN — the envelope holds at L3 and this
 * function is a no-op until `releasing` goes true.
 *
 * `envDb` must be a Float64Array: at rate 0 the per-sample step is ~5e-6 dB,
 * which is below float32 epsilon at these magnitudes and would stall.
 */
export function dx7EgTick(
  envDb: Float64Array,
  envSeg: Int32Array,
  i: number,
  levelsDb: readonly number[],
  ratesDbPerSec: readonly number[],
  releasing: boolean,
  dt: number,
): void {
  let seg = envSeg[i]!;
  if (seg >= 4) return;                  // finished
  if (seg === 3 && !releasing) return;   // HOLD at L3 while the gate is high
  let db = envDb[i]!;
  const target = levelsDb[seg]!;
  const rate = ratesDbPerSec[seg]!;
  if (db < target) {
    // RISING — msfa's asymptotic log-domain attack, after the level-31 jump.
    if (db < DX7_EG_ATTACK_JUMP_DB) db = DX7_EG_ATTACK_JUMP_DB;
    db += rate * ((DX7_EG_ATTACK_CEIL_DB - db) / DX7_DB_PER_OCTAVE) * dt;
    if (db >= target) {
      db = target;
      seg += 1;
    }
  } else {
    // FALLING (and the degenerate already-at-target case) — linear in dB.
    db -= rate * dt;
    if (db <= target) {
      db = target;
      seg += 1;
    }
  }
  envDb[i] = db;
  envSeg[i] = seg;
}

/** FIXED-frequency operator pitch in Hz: `10^((coarse & 3) + fine/100)`, so
 *  1 Hz .. 9.772 kHz. msfa: `logfreq = (4458616 * ((coarse & 3) * 100 + fine))
 *  >> 3` in Q24 log2 — 4458616/8 = 557327 ≈ (1<<24)·log2(10)/100. The note
 *  pitch, the ratio table and detune are ALL ignored in this mode. */
export function dx7FixedHz(coarse: number, fine: number): number {
  return Math.pow(10, (coarse & 3) + clampInt(fine, 0, 99) / 100);
}

/** Legacy fallback for patches saved before `fixedHz` existed, which stored
 *  only `dx7Ratio(coarse, fine) = base · (1 + fine/100)`. Exact whenever
 *  fine = 0 (the overwhelmingly common cartridge case) and for coarse 0/1;
 *  genuinely ambiguous above that (ratio 3.0 is both coarse 3 / fine 0 and
 *  coarse 2 / fine 50), where we take the largest integer base ≤ ratio. */
export function dx7FixedHzFromRatio(ratio: number): number {
  const r = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  const base = r < 1 ? 0 : Math.min(31, Math.floor(r));
  const fine = clampInt((r / (base === 0 ? 0.5 : base) - 1) * 100, 0, 99);
  return dx7FixedHz(base, fine);
}

// dx7-envelope-mirror:end
