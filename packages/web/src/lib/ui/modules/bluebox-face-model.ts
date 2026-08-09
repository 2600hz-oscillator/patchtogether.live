// packages/web/src/lib/ui/modules/bluebox-face-model.ts
//
// THE PURE MODEL BEHIND BLUEBOX's FACEPLATE — every number the faceplate prints
// or draws, derived here and nowhere else, from the WORKLET'S OWN tone table
// (`packages/dsp/src/lib/bluebox-dsp`, imported by relative path exactly as
// clap-face-model imports its core).
//
// ── WHAT THIS MODULE IS, in one sentence ─────────────────────────────────────
//
// There is NO oscillator per key. There is one fixed BANK of ten sine
// oscillators, and a held key raises the target amplitude of every frequency it
// lights. Two keys that share a frequency drive ONE slot twice as hard instead
// of running two independent voices — `ampTarget[f] += BUTTON_VOICE_AMP` in
// packages/dsp/src/bluebox.ts. That `+=` is the entire module and it is
// invisible on every other surface, which is why this model exists.
//
// ── ⚠ THE SCALE CONSTANT IS MIRRORED FROM THE WORKLET, AND PINNED BY MEASURING
//      THE REAL PROCESSOR ─────────────────────────────────────────────────────
//
// `BUTTON_VOICE_AMP` (0.25) and `OUTPUT_NORM` (0.25) are private `const`s inside
// packages/dsp/src/bluebox.ts, which is a worklet ENTRY: it registers a
// processor at import and deliberately exports nothing at module scope (memory
// `dsp-worklet-no-top-level-export` — a top-level export breaks the ART
// classic-script eval). So the faceplate cannot import them.
//
// MOVING them into the shared lib would be the textbook single-source fix, and
// it was rejected here for a stated reason: the ART baseline pins BOTH dsp
// files by `combinedSourceSha`, so a pure code move re-pins `bluebox/out.sha`
// — a DSP-package edit and an ART re-pin folded into a faceplate PR, which this
// repo forbids (CLAUDE.md, and it is the right rule: a byte-identical `.f32`
// under a moved `.sha` is exactly the diff a reviewer stops reading).
//
// So ONE number is mirrored — `BLUEBOX_ACTIVATION_PEAK`, the product the model
// actually needs — and it is ANCHORED TO THE ARTIFACT rather than to a comment:
// `bluebox-face-model.test.ts` renders the REAL processor class through the
// registerProcessor shim and asserts the measured peak and RMS match what this
// file predicts, on twelve key sets. A worklet-side change to either constant
// turns that test red. That is a stronger claim than a shared import, which
// would pin the NUMBER and say nothing about the FORMULA.
//
// PURE — no DOM, no Svelte, no engine, no store. Node-testable.

import {
  BLUEBOX_BUTTON_NAMES,
  BLUEBOX_TONES,
  DTMF_TABLE,
  REDBOX_TONES,
  buttonParamId,
  tonesForButton,
  type BlueboxButtonName,
} from '../../../../../dsp/src/lib/bluebox-dsp';

// ── THE BANK ────────────────────────────────────────────────────────────────

/** The four DTMF ROW frequencies (Bell/ITU-T Q.23), ascending. */
export const BLUEBOX_ROW_HZ: readonly number[] = Object.freeze([697, 770, 852, 941]);
/** The three DTMF COLUMN frequencies, ascending. */
export const BLUEBOX_COL_HZ: readonly number[] = Object.freeze([1209, 1336, 1477]);

/**
 * The bank's ten oscillator slots, ASCENDING — derived the same way the worklet
 * derives `UNIQUE_FREQS` (every key's tone list poured into a Set and sorted),
 * from the same table, so the two cannot disagree about membership or order.
 *
 * `[697, 770, 852, 941, 1209, 1336, 1477, 1700, 2200, 2600]` — 4 DTMF rows,
 * 3 DTMF columns, the REDBOX coin pair and the BLUEBOX supervisory tone.
 */
export const BLUEBOX_SLOT_HZ: readonly number[] = Object.freeze(
  [
    ...new Set<number>([
      ...Object.values(DTMF_TABLE).flatMap((pair) => [pair[0], pair[1]]),
      ...BLUEBOX_TONES,
      ...REDBOX_TONES,
    ]),
  ].sort((a, b) => a - b),
);

/** Which BAND a slot belongs to. The two `inband` slots are the whole point of
 *  the module's name: 1700/2200/2600 are outside the DTMF grid, so no receiver
 *  decodes them — which is exactly why a blue box worked. */
export type BlueboxSlotBand = 'row' | 'col' | 'inband';

/** Per-slot band, parallel to `BLUEBOX_SLOT_HZ`. */
export const BLUEBOX_SLOT_BAND: readonly BlueboxSlotBand[] = Object.freeze(
  BLUEBOX_SLOT_HZ.map((hz): BlueboxSlotBand =>
    BLUEBOX_ROW_HZ.includes(hz) ? 'row' : BLUEBOX_COL_HZ.includes(hz) ? 'col' : 'inband',
  ),
);

/** For each slot, EVERY key that lights it — in keypad order. This is the Bell
 *  grid read BACKWARDS, and it is the direct answer to "why did those two
 *  stack": column 1336 names four keys (2, 5, 8, 0). */
export const BLUEBOX_SLOT_KEYS: readonly (readonly BlueboxButtonName[])[] = Object.freeze(
  BLUEBOX_SLOT_HZ.map((hz) =>
    Object.freeze(BLUEBOX_BUTTON_NAMES.filter((k) => tonesForButton(k).includes(hz))),
  ),
);

/**
 * The most keys any ONE slot can stack — 4, column 1336 with 2, 5, 8 and 0 all
 * down. DERIVED, not typed: it is the tone bank picture's fixed vertical scale,
 * so a bar growing is a bar growing rather than the axis rescaling under the
 * player's hand.
 */
export const BLUEBOX_MAX_SLOT_KEYS: number = Math.max(
  ...BLUEBOX_SLOT_KEYS.map((keys) => keys.length),
);

/**
 * The peak the OUTPUT sees per tone ACTIVATION — `BUTTON_VOICE_AMP × OUTPUT_NORM`
 * = 0.25 × 0.25. See the ⚠ block at the top of this file for why it is mirrored
 * rather than imported, and how it is pinned.
 *
 * MEASURED against the real processor class at 48 kHz: holding BLUEBOX (one
 * activation) peaks at exactly 0.0625; holding one digit (two activations) at
 * 0.1250.
 */
export const BLUEBOX_ACTIVATION_PEAK = 0.0625;

// ── READING THE LIVE KEYS ───────────────────────────────────────────────────

/**
 * The keys currently held, at the WORKLET'S OWN threshold.
 *
 * `packages/dsp/src/bluebox.ts` hard-thresholds every key at `>= 0.5`, so 0.00
 * to 0.49 is one state and 0.50 to 1.00 is the other. There is not one
 * continuous control on this module — which is what `curve: 'discrete'` now
 * says on the def, and what no linear readback of a `btn_*` value could.
 *
 * ⚠ IT READS THE DURABLE PARAM, because that is the only thing the faceplate
 * has. `ModuleShell.readoutValue` reads `params.paramVal` by deliberate
 * platform design (an engine reader polled from markup is not reactive), a
 * `face.momentary` press writes the ENGINE ONLY ($lib/audio/momentary-params:
 * a rack must not be saveable with a pad held down), and a gate cable is a
 * worklet NODE INPUT that no host-side reader can see at all. So every number
 * in this file is live for the DURABLE routes into the keys — the auto-exposed
 * group/instrument bar, a MIDI-learned CC, an automation lane, a preset recall,
 * the legacy card — and dark for the two transient ones. Stated on the def and
 * filed as a platform follow-up (a live-engine reader for `FaceReadout`); the
 * alternative, pointing the PANEL at the live engine while the readouts beside
 * it stayed at zero, trades one honest source for two that disagree.
 */
export function blueboxHeld(
  read: (paramId: string) => number | undefined,
): ReadonlySet<BlueboxButtonName> {
  const held = new Set<BlueboxButtonName>();
  for (const name of BLUEBOX_BUTTON_NAMES) {
    const v = read(buttonParamId(name));
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0.5) held.add(name);
  }
  return held;
}

/** How many keys are down. THE FOIL — it reads 2 for `{1,4}` and for `{1,5}`,
 *  which differ by 1.76 dB. Published beside the real numbers on purpose. */
export function blueboxKeyCount(held: ReadonlySet<BlueboxButtonName>): number {
  return held.size;
}

/** The bank's state: per-slot key count, how many slots are LIT, and how many
 *  tone ACTIVATIONS the held keys made. `lit < activations` IS the collapse. */
export interface BlueboxBankState {
  /** Per slot, parallel to `BLUEBOX_SLOT_HZ`: how many held keys light it. */
  counts: readonly number[];
  /** Slots with a non-zero count — DISTINCT oscillators running. */
  lit: number;
  /** Σ over held keys of |tones(key)| — how many times a key lit a slot. */
  activations: number;
}

/** The bank, from the held keys. The ONE place `+=` is modelled. */
export function blueboxSlotCounts(held: ReadonlySet<BlueboxButtonName>): BlueboxBankState {
  const counts = BLUEBOX_SLOT_HZ.map(() => 0);
  let activations = 0;
  for (const key of held) {
    for (const hz of tonesForButton(key)) {
      const i = BLUEBOX_SLOT_HZ.indexOf(hz);
      if (i < 0) continue;
      counts[i] = (counts[i] ?? 0) + 1;
      activations++;
    }
  }
  return { counts, lit: counts.filter((c) => c > 0).length, activations };
}

// ── THE THREE NUMBERS, each blind to something another one sees ─────────────

/**
 * OUTPUT LEVEL, dBFS RMS — the ONLY surface anywhere on which the shared-slot
 * `+=` becomes observable.
 *
 *   RMS = P · sqrt(½ · Σ_f n_f²)
 *
 * where `n_f` is the number of held keys lighting slot `f` and `P` is
 * `BLUEBOX_ACTIVATION_PEAK`. The ten frequencies are mutually incommensurate so
 * the cross-terms average to zero over any window longer than a few cycles;
 * VERIFIED to five decimals against the real processor on twelve key sets.
 *
 * ⚠ THE HEADLINE: `{1,4}` and `{1,5}` both hold TWO keys, both make FOUR tone
 * activations, and both peak at the same level. `1` and `4` share column 1209,
 * so that one slot runs at 2·A and carries FOUR times the power of two
 * independent voices. MEASURED: −19.312 dB vs −21.073 dB — **1.76 dB apart**,
 * and every naive readback of this module returns the identical number for both.
 *
 * `-Infinity` when nothing is held (the caller prints `silent`).
 */
export function blueboxLevelDb(held: ReadonlySet<BlueboxButtonName>): number {
  const { counts } = blueboxSlotCounts(held);
  let sumSq = 0;
  for (const n of counts) sumSq += n * n;
  if (sumSq === 0) return -Infinity;
  return 20 * Math.log10(BLUEBOX_ACTIVATION_PEAK * Math.sqrt(sumSq / 2));
}

/**
 * HEADROOM below full scale, in dB — and it is deliberately the COUNT-based one.
 *
 *   peak_bound = P · (tone activations)
 *
 * because the coherent worst case sums every slot's amplitude, and moving
 * amplitude BETWEEN slots (which is all a shared oscillator does) cannot change
 * that total. So headroom is IDENTICAL for `{1,4}` and `{1,5}` while `level` is
 * 1.76 dB apart, and 6.02 dB apart for `{1}` and `{BLUEBOX}` while `keys held`
 * reads 1 for both. **The two readouts are each other's negative control**, and
 * `bluebox-face-model.test.ts` asserts exactly that, permanently, in both
 * directions.
 *
 * ⚠ IT IS A BOUND, NOT A PREDICTION, and the difference grows with the key
 * count. Every slot reaches its own peak, but ten incommensurate sines do not
 * all align inside any window a player waits through. MEASURED against the real
 * processor: one digit hits the bound exactly (0.1250), four digits reach
 * 0.4865 of a 0.5000 bound, and all twelve keys reach 1.3304 of 1.4375. Reading
 * it as "the level is guaranteed not to exceed this" is correct at every count;
 * reading it as "the level IS this" is correct only for a few keys. One digit
 * sits 18.06 dB down, EIGHT simultaneous digits reach full scale, and all twelve
 * overshoot (+2.48 dBFS measured).
 *
 * `+Infinity` when nothing is held.
 */
export function blueboxHeadroomDb(held: ReadonlySet<BlueboxButtonName>): number {
  const { activations } = blueboxSlotCounts(held);
  if (activations === 0) return Infinity;
  return -20 * Math.log10(BLUEBOX_ACTIVATION_PEAK * activations);
}

/**
 * What a real Bell receiver makes of the lit bank — the only readout here that
 * is not a function of COUNTS at all.
 *
 * Q.23 accepts exactly ONE row tone and ONE column tone. So:
 *   - `{1,4}` (two rows, one column) and `{1,2}` (one row, two columns) agree on
 *     keys held, on activations, on lit slots AND on peak — and read
 *     `2 rows · 1 col` versus `1 row · 2 cols`;
 *   - adding BLUEBOX to a held digit moves `keys held`, `level` and `headroom`
 *     and leaves this UNCHANGED, because 2600 Hz is outside the DTMF band
 *     entirely. That invariance is the historical fact the module is named
 *     after, printed as a readout.
 */
export function blueboxDecodeText(held: ReadonlySet<BlueboxButtonName>): string {
  if (held.size === 0) return 'silent';
  const { counts } = blueboxSlotCounts(held);
  const rows: number[] = [];
  const cols: number[] = [];
  BLUEBOX_SLOT_HZ.forEach((hz, i) => {
    if (!counts[i]) return;
    if (BLUEBOX_SLOT_BAND[i] === 'row') rows.push(hz);
    else if (BLUEBOX_SLOT_BAND[i] === 'col') cols.push(hz);
  });
  if (rows.length === 1 && cols.length === 1) {
    for (let d = 0; d <= 9; d++) {
      const pair = DTMF_TABLE[d];
      if (pair && pair[0] === rows[0] && pair[1] === cols[0]) return `digit ${d}`;
    }
    // Q.23 names 941/1209 = `*` and 941/1477 = `#`; no key on this pad can
    // produce either, so this branch is unreachable today and stays TOTAL
    // rather than throwing on a future key.
    return `${rows[0]} + ${cols[0]}`;
  }
  if (rows.length === 0 && cols.length === 0) return 'in-band only';
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  return `${plural(rows.length, 'row')} · ${plural(cols.length, 'col')}`;
}

// ── THE PICTURE ─────────────────────────────────────────────────────────────

/** One bar of the tone-bank hero panel. */
export interface BlueboxBankBar {
  hz: number;
  band: BlueboxSlotBand;
  /** How many HELD keys light this slot right now (0 at rest). */
  count: number;
  /** `count / BLUEBOX_MAX_SLOT_KEYS` — the FIXED scale, 0..1. */
  height: number;
  /** How many keys COULD light it — the bar's outline, always drawn. */
  capacity: number;
  /** Those keys, for the `keys` caption mode. */
  keys: readonly BlueboxButtonName[];
}

/**
 * The ten bars. Every slot is returned at every moment — a bar at zero still
 * carries its frequency, its band tint and its key list, so the picture shows
 * the module's ARCHITECTURE on a silent rack and lights up on top of it.
 */
export function blueboxBankBars(held: ReadonlySet<BlueboxButtonName>): BlueboxBankBar[] {
  const { counts } = blueboxSlotCounts(held);
  return BLUEBOX_SLOT_HZ.map((hz, i) => ({
    hz,
    band: BLUEBOX_SLOT_BAND[i]!,
    count: counts[i] ?? 0,
    height: (counts[i] ?? 0) / BLUEBOX_MAX_SLOT_KEYS,
    capacity: BLUEBOX_SLOT_KEYS[i]!.length,
    keys: BLUEBOX_SLOT_KEYS[i]!,
  }));
}

/** The caption under each bar, in the panel's two label modes. `hz` prints the
 *  oscillator's frequency; `keys` prints the keys that light it — the Bell grid
 *  read backwards, which is what answers "why did those two stack". */
export function blueboxBarCaption(bar: BlueboxBankBar, mode: 'hz' | 'keys'): string {
  if (mode === 'hz') return String(bar.hz);
  return bar.keys.map((k) => (k === 'bluebox' ? 'BB' : k === 'redbox' ? 'RB' : k)).join(' ');
}
