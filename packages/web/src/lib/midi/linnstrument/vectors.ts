// ACCEPTANCE VECTORS V01–V16 — machine-readable.
//
// ⚠ PROVENANCE: SYNTHETIC. Translated from
// `.myrobots/linnstrument-mpe/contracts/acceptance-vectors.synthetic.json`
// (`evidence_kind: synthetic_specification_not_device_capture`, :3) and the
// prose table in `research/implementation-plan.md:111-132`. No LinnStrument
// was connected; these bytes are what the FIRMWARE DOCUMENTATION says the
// instrument sends, not what one was observed to send. A hardware capture
// session replaces bytes here; the ids stay.
//
// Every byte is a literal built from status nibbles this file spells itself —
// nothing imports a decoder constant, so the corpus cannot agree with the
// decoder by construction (the trails-decode precedent). `negativeControl`
// names one byte per vector whose corruption MUST fail that vector; the test
// proves the instrument can see red.
//
// Ids V12/V13/V16 carry a `deferred` expectation naming the WP that owns the
// audible half (arp sequence, gate-low samples, silent gated topology); their
// state-level half is asserted here so they are never vacuous. V15's audible
// half (pressure → level at a real jack, cable pulled as the control) is
// OWNED by e2e/tests/linnstrument-expression.spec.ts and named as `audible`.

import type { LinnProfile, MusicalRegion, RawRejection, SelectorId, XyPair } from './types';
import type { MpeEndReason, MpeVoice } from '../mpe-state';

export const VECTOR_EVIDENCE_KIND = 'synthetic_specification_not_device_capture' as const;

export type VectorPipeline = 'user_mode' | 'stock_mpe';

export type VectorExpectation =
  /** Some raw event deep-matches `match` (`count` = exactly that many, default ≥ 1). */
  | { kind: 'raw'; match: Record<string, unknown>; count?: number }
  | { kind: 'raw_rejected'; reason: RawRejection; count: number }
  /** Some runtime (surface) event deep-matches `match`. */
  | { kind: 'surface'; match: Record<string, unknown>; count?: number }
  /** Selection state — optionally at the snapshot `after` message index. */
  | { kind: 'selection'; after?: number; mask?: Partial<Record<SelectorId, boolean>>; pairs?: Partial<Record<SelectorId, XyPair>>; pointerFree?: boolean }
  /** Active voice count in a region (user_mode) or the single state (stock_mpe). */
  | { kind: 'voice_active'; region?: MusicalRegion; count: number; after?: number }
  /** An active voice deep-matches `match`; `pitchCv` compares (n−60+bend)/12. */
  | { kind: 'voice'; region?: MusicalRegion; match: Partial<MpeVoice>; pitchCv?: number; count?: number }
  /** Voice events of `event` whose voice deep-matches `voice` (and `reason`). */
  | { kind: 'voice_event'; region?: MusicalRegion; event: 'voice_start' | 'voice_expression' | 'voice_end'; voice?: Partial<MpeVoice>; reason?: MpeEndReason; count?: number }
  /** Owned by a later WP — listed so the id is never mistaken for shipped. */
  | { kind: 'deferred'; to: 'WP-C' | 'WP-D'; claim: string }
  /** The audible half is SHIPPED and owned by the named e2e spec (a file
   *  under e2e/tests/); the pure ops assert the state half here. */
  | { kind: 'audible'; spec: string; claim: string };

export interface AcceptanceVector {
  id: string;
  name: string;
  evidenceKind: typeof VECTOR_EVIDENCE_KIND;
  pipeline: VectorPipeline;
  profile?: Partial<LinnProfile>;
  /** Allocator lanes for the stock_mpe pipeline (default 16). */
  lanes?: number;
  /** One MIDI message per entry, in wire order. */
  bytes: number[][];
  /** One source timestamp (s) per message. */
  sourceTime: number[];
  /** Open a new session epoch after this message index. */
  reconnectAfter?: number;
  /** Persist + reload selection (and rebuild voice state) after this index (V05). */
  roundTripAfter?: number;
  expected: VectorExpectation[];
  /** Corrupting this byte must make the vector FAIL. */
  negativeControl: { message: number; byte: number; value: number };
}

// ── Wire spelling (User Mode): channel nibble = ROW 0..7, note = WIRE COLUMN 1..25
const on = (row: number, wireCol: number, vel: number): number[] => [0x90 | row, wireCol, vel];
const off = (row: number, wireCol: number, vel: number): number[] => [0x80 | row, wireCol, vel];
const xLo = (row: number, wireCol: number, v: number): number[] => [0xb0 | row, wireCol + 32, v];
const xHi = (row: number, wireCol: number, v: number): number[] => [0xb0 | row, wireCol, v];
const yCc = (row: number, wireCol: number, v: number): number[] => [0xb0 | row, wireCol + 64, v];
const slide = (row: number, fromWireCol: number): number[] => [0xb0 | row, 119, fromWireCol];
// ── Wire spelling (stock MPE): channel nibble = wire channel − 1
const mOn = (ch1: number, note: number, vel: number): number[] => [0x90 | (ch1 - 1), note, vel];
const mOff = (ch1: number, note: number, vel: number): number[] => [0x80 | (ch1 - 1), note, vel];
const mBend = (ch1: number, lsb: number, msb: number): number[] => [0xe0 | (ch1 - 1), lsb, msb];
const mPressure = (ch1: number, v: number): number[] => [0xd0 | (ch1 - 1), v];
const mCc = (ch1: number, cc: number, v: number): number[] => [0xb0 | (ch1 - 1), cc, v];

const times = (n: number): number[] => Array.from({ length: n }, (_, i) => i * 0.01);

// The pad's raw-X prior: 25 columns over 0…4265 → pad (app cols 17–24) spans
// 2900.2…4265. u = 0.75 ⇒ x ≈ 3924 = hi 30, lo 84 (3924 = 30·128 + 84).
const PAD_X_U75_HI = 30;
const PAD_X_U75_LO = 84;

const RESERVED_WIRE_R_COL = 17; // app col 16 — the selector column
const ROW_R = 7;
const ROW_B = 5;

const v04Bytes = [
  on(ROW_B, RESERVED_WIRE_R_COL, 100), // fresh B press → mask r+b
  off(ROW_B, RESERVED_WIRE_R_COL, 0),
  on(2, 20, 90), // pad touch, app (19,2)
  xLo(2, 20, PAD_X_U75_LO),
  xHi(2, 20, PAD_X_U75_HI), // completes the pair → u ≈ .75
  yCc(2, 20, 0), // local Y 0 on row 2 → v = 2/8 = .25
];

export const ACCEPTANCE_VECTORS: readonly AcceptanceVector[] = [
  {
    id: 'V01',
    name: 'geometry',
    evidenceKind: VECTOR_EVIDENCE_KIND,
    pipeline: 'user_mode',
    bytes: [on(0, 1, 100), on(7, 17, 100), on(7, 25, 100)],
    sourceTime: times(3),
    expected: [
      { kind: 'raw', match: { kind: 'cell_down', col: 1, row: 0 } },
      { kind: 'raw', match: { kind: 'cell_down', col: 17, row: 7 } },
      { kind: 'raw', match: { kind: 'cell_down', col: 25, row: 7 } },
      { kind: 'surface', match: { kind: 'touch_start', region: 'keys', col: 0, row: 0, localCol: 0, localRow: 0 } },
      { kind: 'surface', match: { kind: 'control_edge', control: 'r', down: true } },
      { kind: 'surface', match: { kind: 'touch_start', region: 'pad', col: 24, row: 7, localCol: 7, localRow: 7 } },
    ],
    negativeControl: { message: 1, byte: 1, value: 18 },
  },
  {
    id: 'V02',
    name: 'mapping',
    evidenceKind: VECTOR_EVIDENCE_KIND,
    pipeline: 'user_mode',
    bytes: [on(0, 1, 100), on(0, 6, 100), on(1, 1, 100), on(7, 16, 100)],
    sourceTime: times(4),
    expected: [
      { kind: 'surface', match: { kind: 'touch_start', col: 0, row: 0, note: 36 } },
      { kind: 'surface', match: { kind: 'touch_start', col: 5, row: 0, note: 41 } },
      { kind: 'surface', match: { kind: 'touch_start', col: 0, row: 1, note: 41 } },
      { kind: 'surface', match: { kind: 'touch_start', col: 15, row: 7, note: 86 } },
      { kind: 'voice_active', region: 'keys', count: 4 },
      { kind: 'voice', region: 'keys', match: { note: 41 }, count: 2 },
    ],
    negativeControl: { message: 1, byte: 1, value: 7 },
  },
  {
    id: 'V03',
    name: 'mask',
    evidenceKind: VECTOR_EVIDENCE_KIND,
    pipeline: 'user_mode',
    bytes: [
      on(ROW_R, RESERVED_WIRE_R_COL, 100), // fresh R press: flip (default on → off)
      on(ROW_R, RESERVED_WIRE_R_COL, 100), // repeated R down: no change
      off(ROW_R, RESERVED_WIRE_R_COL, 0), // R up: no change
      on(ROW_R, RESERVED_WIRE_R_COL, 100), // fresh R press: flip (off → on)
    ],
    sourceTime: times(4),
    expected: [
      { kind: 'selection', after: 0, mask: { r: false, g: false, b: false } },
      { kind: 'selection', after: 1, mask: { r: false } },
      { kind: 'selection', after: 2, mask: { r: false } },
      { kind: 'selection', after: 3, mask: { r: true, g: false, b: false } },
      { kind: 'raw_rejected', reason: 'duplicate_press', count: 1 },
      { kind: 'surface', match: { kind: 'control_edge', control: 'r', down: true }, count: 2 },
    ],
    negativeControl: { message: 3, byte: 2, value: 0 },
  },
  {
    id: 'V04',
    name: 'fan-out',
    evidenceKind: VECTOR_EVIDENCE_KIND,
    pipeline: 'user_mode',
    bytes: v04Bytes,
    sourceTime: times(v04Bytes.length),
    expected: [
      { kind: 'selection', after: 1, mask: { r: true, g: false, b: true } },
      { kind: 'selection', pairs: { r: { x: 0.5, y: -0.5 }, b: { x: 0.5, y: -0.5 }, g: { x: 0, y: 0 } } },
      { kind: 'voice_active', region: 'pad', count: 1 },
    ],
    negativeControl: { message: 4, byte: 2, value: 20 },
  },
  {
    id: 'V05',
    name: 'retention',
    evidenceKind: VECTOR_EVIDENCE_KIND,
    pipeline: 'user_mode',
    bytes: [...v04Bytes, off(2, 20, 0)],
    sourceTime: times(v04Bytes.length + 1),
    roundTripAfter: v04Bytes.length,
    expected: [
      { kind: 'selection', pairs: { r: { x: 0.5, y: -0.5 }, b: { x: 0.5, y: -0.5 }, g: { x: 0, y: 0 } }, mask: { r: true, g: false, b: true }, pointerFree: true },
      { kind: 'voice_active', region: 'pad', count: 0 },
      { kind: 'voice_active', region: 'keys', count: 0 },
    ],
    negativeControl: { message: 4, byte: 2, value: 20 },
  },
  {
    id: 'V06',
    name: 'independent bend',
    evidenceKind: VECTOR_EVIDENCE_KIND,
    pipeline: 'stock_mpe',
    bytes: [mOn(2, 60, 100), mOn(3, 60, 100), mBend(2, 0x00, 0x50)], // E1 00 50 = raw 10240
    sourceTime: times(3),
    expected: [
      { kind: 'voice_active', count: 2 },
      { kind: 'voice', match: { channel: 1, note: 60 }, pitchCv: 1 },
      { kind: 'voice', match: { channel: 2, note: 60 }, pitchCv: 0 },
    ],
    negativeControl: { message: 2, byte: 2, value: 0x40 },
  },
  {
    id: 'V07',
    name: 'independent expression',
    evidenceKind: VECTOR_EVIDENCE_KIND,
    pipeline: 'stock_mpe',
    bytes: [mOn(2, 60, 100), mOn(3, 64, 100), mPressure(2, 64), mPressure(3, 96), mCc(2, 74, 32)],
    sourceTime: times(5),
    expected: [
      { kind: 'voice', match: { channel: 1, pressure: 64 / 127, timbre: 32 / 127 } },
      { kind: 'voice', match: { channel: 2, pressure: 96 / 127, timbre: 64 / 127 } },
    ],
    negativeControl: { message: 4, byte: 2, value: 64 },
  },
  {
    id: 'V08',
    name: 'slide',
    evidenceKind: VECTOR_EVIDENCE_KIND,
    pipeline: 'user_mode',
    // Row 3, wire column 12 (app 11, note 36+11+15 = 62) slides right to 13.
    bytes: [on(3, 12, 100), slide(3, 12), on(3, 13, 100), off(3, 12, 13)],
    sourceTime: times(4),
    expected: [
      { kind: 'raw', match: { kind: 'cell_slide', fromCol: 12, toCol: 13, row: 3 } },
      { kind: 'surface', match: { kind: 'touch_slide', region: 'keys', fromCol: 11, toCol: 12, row: 3 } },
      { kind: 'surface', match: { kind: 'touch_start' }, count: 1 },
      { kind: 'surface', match: { kind: 'touch_end' }, count: 0 },
      { kind: 'voice_event', region: 'keys', event: 'voice_start', count: 1 },
      { kind: 'voice_active', region: 'keys', count: 1 },
      { kind: 'voice', region: 'keys', match: { note: 62, held: true } },
    ],
    negativeControl: { message: 1, byte: 2, value: 11 },
  },
  {
    id: 'V09',
    name: 'release ambiguity',
    evidenceKind: VECTOR_EVIDENCE_KIND,
    pipeline: 'user_mode',
    bytes: [on(0, 5, 100), off(0, 5, 90)], // nonzero release velocity, no CC119
    sourceTime: times(2),
    expected: [
      { kind: 'surface', match: { kind: 'touch_end', reason: 'release' }, count: 1 },
      { kind: 'surface', match: { kind: 'touch_slide' }, count: 0 },
      { kind: 'raw_rejected', reason: 'malformed_slide', count: 0 },
      { kind: 'voice_active', region: 'keys', count: 0 },
    ],
    negativeControl: { message: 1, byte: 1, value: 6 },
  },
  {
    id: 'V10',
    name: 'stolen lane',
    evidenceKind: VECTOR_EVIDENCE_KIND,
    pipeline: 'stock_mpe',
    lanes: 1,
    bytes: [mOn(2, 60, 100), mOn(3, 64, 100), mOff(2, 60, 0)], // A → lane 0; B steals it; A releases
    sourceTime: times(3),
    expected: [
      { kind: 'voice_event', event: 'voice_end', reason: 'stolen', voice: { note: 60 }, count: 1 },
      { kind: 'voice_event', event: 'voice_end', reason: 'release', count: 0 },
      { kind: 'voice_active', count: 1 },
      { kind: 'voice', match: { channel: 2, note: 64, lane: 0, held: true } },
    ],
    negativeControl: { message: 1, byte: 2, value: 0 },
  },
  {
    id: 'V11',
    name: 'boundary',
    evidenceKind: VECTOR_EVIDENCE_KIND,
    pipeline: 'user_mode',
    // Keys-origin touch at wire 16 (app 15, row 7) slides into the selector column.
    bytes: [on(7, 16, 100), slide(7, 16), on(7, 17, 100), off(7, 16, 17)],
    sourceTime: times(4),
    expected: [
      { kind: 'surface', match: { kind: 'control_edge' }, count: 0 },
      { kind: 'surface', match: { kind: 'touch_start' }, count: 1 },
      { kind: 'surface', match: { kind: 'touch_end', region: 'keys', reason: 'boundary' }, count: 1 },
      { kind: 'selection', mask: { r: true, g: false, b: false } },
      { kind: 'voice_active', region: 'keys', count: 0 },
    ],
    negativeControl: { message: 0, byte: 1, value: 17 },
  },
  {
    id: 'V12',
    name: 'arp',
    evidenceKind: VECTOR_EVIDENCE_KIND,
    pipeline: 'stock_mpe',
    bytes: [mOn(2, 60, 100), mOn(3, 64, 100), mOn(4, 67, 100)],
    sourceTime: times(3),
    expected: [
      { kind: 'voice_active', count: 3 },
      { kind: 'voice', match: { note: 60 } },
      { kind: 'voice', match: { note: 64 } },
      { kind: 'voice', match: { note: 67 } },
      { kind: 'deferred', to: 'WP-C', claim: 'updown over held C/E/G plays C E G E C; one source touch owns expression per generated note' },
    ],
    negativeControl: { message: 2, byte: 1, value: 68 },
  },
  {
    id: 'V13',
    name: 'retrigger',
    evidenceKind: VECTOR_EVIDENCE_KIND,
    pipeline: 'stock_mpe',
    bytes: [mOn(2, 60, 100)],
    sourceTime: times(1),
    expected: [
      { kind: 'voice_active', count: 1 },
      { kind: 'deferred', to: 'WP-C', claim: 'a one-note arp emits real gate-low samples between attacks (scheduleStep gateOffSec > 0)' },
    ],
    negativeControl: { message: 0, byte: 2, value: 0 },
  },
  {
    id: 'V14',
    name: 'epoch',
    evidenceKind: VECTOR_EVIDENCE_KIND,
    pipeline: 'user_mode',
    bytes: [on(0, 3, 100), off(0, 3, 0)], // reconnect between: the Note Off is a stale queued event
    sourceTime: times(2),
    reconnectAfter: 0,
    expected: [
      { kind: 'surface', match: { kind: 'touch_end', reason: 'session' }, count: 1 },
      { kind: 'voice_event', region: 'keys', event: 'voice_end', reason: 'session', count: 1 },
      { kind: 'raw_rejected', reason: 'no_contact', count: 1 },
      { kind: 'voice_active', region: 'keys', count: 0 },
      { kind: 'surface', match: { kind: 'session', state: 'mode_changed' }, count: 1 },
    ],
    negativeControl: { message: 0, byte: 0, value: 0x80 },
  },
  {
    id: 'V15',
    name: 'observer control',
    evidenceKind: VECTOR_EVIDENCE_KIND,
    pipeline: 'stock_mpe',
    bytes: [mOn(2, 60, 100), mPressure(2, 64), mPressure(2, 100)],
    sourceTime: times(3),
    expected: [
      { kind: 'voice', match: { channel: 1, pressure: 100 / 127, held: true } },
      { kind: 'voice_event', event: 'voice_expression', count: 2 },
      { kind: 'audible', spec: 'linnstrument-expression.spec.ts', claim: 'unpatching the pressure path removes level modulation while note audio remains' },
    ],
    negativeControl: { message: 2, byte: 1, value: 64 },
  },
  {
    id: 'V16',
    name: 'stopped source',
    evidenceKind: VECTOR_EVIDENCE_KIND,
    pipeline: 'stock_mpe',
    bytes: [mPressure(2, 64), mCc(2, 74, 100), mBend(2, 0, 64)], // expression, never a Note On
    sourceTime: times(3),
    expected: [
      { kind: 'voice_active', count: 0 },
      { kind: 'voice_event', event: 'voice_start', count: 0 },
      { kind: 'deferred', to: 'WP-D', claim: 'gated topology with no Note On is silent for the whole observation while a positive reference reads nonzero' },
    ],
    negativeControl: { message: 2, byte: 0, value: 0x91 },
  },
];

export const VECTOR_IDS: readonly string[] = ACCEPTANCE_VECTORS.map((v) => v.id);
