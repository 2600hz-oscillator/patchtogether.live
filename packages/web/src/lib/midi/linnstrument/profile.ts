// DEFAULT LINNSTRUMENT PROFILE — transcribed from
// `.myrobots/linnstrument-mpe/contracts/device-profile.proposed.json`
// (status `proposal_not_frozen`, physical_verification `pending`).
//
// AUTHORITY. Only three facts here are OWNER rulings (decision-register.md):
//   D04  R/G/B are independent toggles, all eight masks legal → `defaultMask`
//        is a Record of three independent booleans, never a radio index.
//   D09  +1 semitone per column, +5 per row → `semisPerCol` / `semisPerRow`,
//        realised by the tree's `keyboardCellToMidi` (keyboard-map.ts:18-35).
//   D02  The LinnStrument 200 is 25 × 8 (manufacturer fact).
// Every entry in the profile's `owner_confirmation_open` list (:147-154) is a
// named switch below, defaulting to the package RECOMMENDATION and labelled
// as such. A recommendation is not a ruling: change the DATA, not the reducer.
//
// ⚠ PLAIN `.ts`, no runes (trails-device.ts:20-24).

import type { LinnLightingRoles, LinnProfile, MusicalRegion, Region, RegionRect, SelectorId } from './types';
// The shared DSP libs — node-importable IDENTICAL source the worklets bundle
// (the pentemelodica.ts precedent for reaching packages/dsp by relative path).
import { PENTE_VOICES } from '../../../../../dsp/src/lib/pentemelodica-dsp';
import { POLY_SUM_VOICES } from '../../../../../dsp/src/lib/poly-osc-sum';
import { SIXSTRUM_STRINGS } from '../../../../../dsp/src/lib/sixstrum-tuning';

/** RECOMMENDATION, not a ruling (`corrected_geometry`, D03). The request said
 *  16×16, which cannot fit an eight-row instrument; the package INFERS
 *  16×8 keys | 1×8 controls | 8×8 pad. Region rectangles are data: an owner
 *  ruling for a different split edits these four numbers per region. */
export const RECOMMENDED_REGIONS: Record<Region, RegionRect> = {
  keys: { left: 0, bottom: 0, width: 16, height: 8 },
  controls: { left: 16, bottom: 0, width: 1, height: 8 },
  pad: { left: 17, bottom: 0, width: 8, height: 8 },
};

/** RECOMMENDATION (`shared_pointer_policy`, D05): the first eligible fresh
 *  pad contact owns every selected pair; a second contact is ignored. */
export const RECOMMENDED_POINTER_POLICY = 'first_eligible_fresh_contact' as const;

/** RECOMMENDATION (`retention_and_selection_join`, D06/D07): retain on
 *  release; a newly selected pair joins on the next coherent XY sample. The
 *  jump-vs-soft-takeover preference is OPEN — both branches are implemented in
 *  `selection-reducer.ts`; this switch picks one. */
export const RECOMMENDED_SELECTION_JOIN = 'next_coherent_xy_sample' as const;

/** RECOMMENDATION (`extra_five_controls`, D17): ARP / HOLD / OCT− / OCT+ /
 *  PANIC on control rows 4..0. `false` leaves those cells inert and unlit. */
export const RECOMMENDED_EXTRA_CONTROLS_ENABLED = true;

/** RECOMMENDATION (`initial_roots`): keys root MIDI 36, pad root MIDI 60.
 *  Safe to change before first ship; after ship a default change rewrites
 *  saved racks (audio-runtime skill). */
export const RECOMMENDED_KEYS_ROOT = 36;
export const RECOMMENDED_PAD_ROOT = 60;

/** RECOMMENDATION (D08): R on, G/B off. A three-bit mask (D04 ruling: the
 *  bits are independent — this is the value 0b001, not "radio position 0"). */
export const RECOMMENDED_DEFAULT_MASK: Record<SelectorId, boolean> = { r: true, g: false, b: false };

/** RECOMMENDATION + ⚠ HARDWARE-VERIFY (design.md lighting table, D18): root
 *  cyan; other scale tones green ("green or lime after physical review");
 *  out-of-scale off — still playable, D09 owner ruling: scale affects
 *  LIGHTING, not playability; a played cell white ("white or pink, auditioned
 *  on device"). Palette keys: a physical review edits one word per role. */
export const RECOMMENDED_LIGHTING_ROLES: LinnLightingRoles = { root: 'cyan', inScale: 'green', outScale: 'off', played: 'white' };

/** HOW MANY ALLOCATOR LANES GET EXPRESSION JACKS (F03, owner ruling
 *  2026-09-15 "a build"): one `vel` / `press` / `timbre` cv jack per lane for
 *  the first N lanes of each region, N DERIVED from the widest per-voice
 *  reader the tree ships (PENTEMELODICA 5 voices, POLY-OSC-SUM 5,
 *  SIXSTRUM 6 strings; poly.ts:22-27 is the census) — never hand-typed. Lanes
 *  N..15 still play on the bus and simply have no jack. `polyCv_extension`
 *  (D14: per-voice mono pitch/gate through a new cable type + a breakout) is a
 *  GRAPH change with no profile switch and stays unbuilt until the owner rules
 *  on a cable type. */
export const LINN_EXPRESSION_LANES = Math.max(PENTE_VOICES, POLY_SUM_VOICES, SIXSTRUM_STRINGS);

/** The three per-lane expression dimensions with a jack (F03). `bend` has
 *  none: it is already IN the bus pitch. Declared HERE (plain data, no engine
 *  import) so the runtime, the def and the docs manifest's `?raw` parser —
 *  which cannot run the def's spread — all derive the same ids. */
export type ExpressionDim = 'vel' | 'press' | 'timbre';
export const EXPRESSION_DIMS: readonly ExpressionDim[] = ['vel', 'press', 'timbre'];
/** `keys_press3` = lane index 2 of `keys_poly` — 1-based like `voice1`. */
export const expressionPortId = (r: MusicalRegion, d: ExpressionDim, lane: number): string => `${r}_${d}${lane + 1}`;
/** Every expression jack id, in def order: region-major, then dim, then lane. */
export function expressionPortIds(): { region: MusicalRegion; dim: ExpressionDim; lane: number; id: string }[] {
  return (['keys', 'pad'] as const).flatMap((region) =>
    EXPRESSION_DIMS.flatMap((dim) => Array.from({ length: LINN_EXPRESSION_LANES }, (_, lane) => ({ region, dim, lane, id: expressionPortId(region, dim, lane) }))),
  );
}

export const DEFAULT_LINN_PROFILE: LinnProfile = {
  columns: 25,
  rows: 8,
  regions: RECOMMENDED_REGIONS,
  // control_rows (:70-79): R/G/B descend from the top; the lower five are D17.
  controlRows: {
    r: 7,
    g: 6,
    b: 5,
    keyboard_arp: 4,
    keyboard_hold: 3,
    octave_down: 2,
    octave_up: 1,
    panic: 0,
  },
  // keyboard_mapping (:31-37) — D09 owner reuse request.
  semisPerCol: 1,
  semisPerRow: 5,
  keysRoot: RECOMMENDED_KEYS_ROOT,
  padRoot: RECOMMENDED_PAD_ROOT,
  // joysticks (:38-69).
  defaultMask: RECOMMENDED_DEFAULT_MASK,
  pointerPolicy: RECOMMENDED_POINTER_POLICY,
  selectionJoin: RECOMMENDED_SELECTION_JOIN,
  softTakeoverRadius: 0.1,
  extraControlsEnabled: RECOMMENDED_EXTRA_CONTROLS_ENABLED,
  // mpe_endpoints (:80-123): ±48 member, ±2 master (RPN 0/0 negotiable).
  memberBendSemitones: 48,
  masterBendSemitones: 2,
  lanesPerRegion: 16,
  // calibration (:124-133): priors, unmeasured; no LinnStrument was connected.
  calibration: {
    status: 'unmeasured',
    wholeDeviceXPrior: [0, 4265],
    padLeftRaw: null,
    padRightRaw: null,
    verticalSeamIdentity: 'unproven',
  },
  // hardware_palette (:134-146): fixed firmware colour ids, approximations.
  palette: {
    red: 1,
    yellow: 2,
    green: 3,
    cyan: 4,
    blue: 5,
    magenta: 6,
    off: 7,
    white: 8,
    orange: 9,
    lime: 10,
    pink: 11,
  },
  lighting: RECOMMENDED_LIGHTING_ROLES,
};

/** Which region an application cell belongs to, or null when it lands
 *  outside every rectangle. Rectangles are consulted in declaration order;
 *  a well-formed profile has no overlaps (asserted by surface-map.test). */
export function regionAt(profile: LinnProfile, col: number, row: number): Region | null {
  for (const region of ['keys', 'controls', 'pad'] as const) {
    const r = profile.regions[region];
    if (col >= r.left && col < r.left + r.width && row >= r.bottom && row < r.bottom + r.height) return region;
  }
  return null;
}

/** Raw-X span of the pad. Measured endpoints win; otherwise the whole-device
 *  prior is scaled by the pad rectangle's share of the columns. */
export function padXSpan(profile: LinnProfile): { left: number; right: number } {
  const { padLeftRaw, padRightRaw, wholeDeviceXPrior } = profile.calibration;
  if (padLeftRaw !== null && padRightRaw !== null && padRightRaw > padLeftRaw) {
    return { left: padLeftRaw, right: padRightRaw };
  }
  const [lo, hi] = wholeDeviceXPrior;
  const perCol = (hi - lo) / profile.columns;
  const pad = profile.regions.pad;
  return { left: lo + pad.left * perCol, right: lo + (pad.left + pad.width) * perCol };
}

/** Raw-X units per semitone column — bend displacement divides by this. */
export function semitoneWidthRaw(profile: LinnProfile): number {
  const [lo, hi] = profile.calibration.wholeDeviceXPrior;
  return (hi - lo) / profile.columns;
}

/** Control name on a control-column row, or null for an unassigned row. */
export function controlAtRow(profile: LinnProfile, row: number): keyof LinnProfile['controlRows'] | null {
  for (const name of Object.keys(profile.controlRows) as (keyof LinnProfile['controlRows'])[]) {
    if (profile.controlRows[name] === row) return name;
  }
  return null;
}
