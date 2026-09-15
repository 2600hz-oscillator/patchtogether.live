// LINNSTRUMENT CONTRACTS — the shared vocabulary every LinnStrument layer
// speaks: the device layer (raw User-Mode bytes → surface events), the module
// runtime (surface events → selection state + poly voices) and the face.
//
// Provenance. Shapes are transcribed from the design record
// `.myrobots/linnstrument-mpe/research/design.md` ("Canonical application
// events", "Physical layout and interaction") and its proposed device profile
// `contracts/device-profile.proposed.json`. That package sits BELOW code,
// AGENTS.md, the skills and docs/ in the authority order; the only OWNER
// rulings it carries are D01 (standard MIDI transport), D04 (R/G/B are
// INDEPENDENT toggles, all eight masks legal) and D09 (+1/+5 fourths layout).
// Everything else — the 16×8 | 1×8 | 8×8 split, the single-pointer policy, the
// join policy, the lower five controls, the initial roots — is a package
// RECOMMENDATION and is therefore a SWITCH on `LinnProfile`, never a constant
// baked into a reducer. See `profile.ts` for the switches and their defaults.
//
// ⚠ PLAIN `.ts`, no runes: audio defs import this file and the ART workspace's
// node vitest loads every def with no Svelte compiler (trails-device.ts:20-24).

import type { ScaleName } from '$lib/mike/music-theory';

// ── Geometry ──────────────────────────────────────────────────────────────

/** A region of the playing surface as a rectangle in APPLICATION coordinates
 *  (bottom-left origin, columns 0..24, rows 0..7). Data, not code: swapping
 *  the profile moves the split with no reducer change. */
export interface RegionRect {
  left: number;
  bottom: number;
  width: number;
  height: number;
}

/** The three surface regions. `keys` and `pad` are musical (each owns an MPE
 *  voice stream); `controls` is the selector column. */
export type Region = 'keys' | 'controls' | 'pad';

/** The two regions that produce voices. */
export type MusicalRegion = 'keys' | 'pad';

/** The three joystick selectors, top-down on the control column. */
export type SelectorId = 'r' | 'g' | 'b';
export const SELECTORS: readonly SelectorId[] = ['r', 'g', 'b'];

/** Every cell of the control column by name. The lower five are a package
 *  RECOMMENDATION (D17) and are gated by `LinnProfile.extraControlsEnabled`. */
export type ControlName =
  | SelectorId
  | 'keyboard_arp'
  | 'keyboard_hold'
  | 'octave_down'
  | 'octave_up'
  | 'panic';

/** Pointer ownership on the XY pad. Only one policy is designed; it is named
 *  so an owner ruling can add another without re-typing the reducer. */
export type PointerPolicy = 'first_eligible_fresh_contact';

/** How a joystick pair that becomes selected while a pointer is live joins
 *  the gesture. D07: recommendation is `next_coherent_xy_sample`; the
 *  jump-vs-soft-takeover preference is OPEN, so both are implemented. */
export type SelectionJoin = 'next_coherent_xy_sample' | 'soft_takeover';

/** Raw-X calibration. `xLeft`/`xRight` are the measured raw-X values at the
 *  pad's physical edges; `null` until a capture session measures them, in which
 *  case the whole-device prior is scaled by the pad rectangle. */
export interface LinnCalibration {
  status: 'unmeasured' | 'measured';
  /** Whole-device raw X span. The firmware reference gives 0…4265 for the 200
   *  (design.md:123) despite the 14-bit encoding — a PRIOR to verify. */
  wholeDeviceXPrior: readonly [number, number];
  padLeftRaw: number | null;
  padRightRaw: number | null;
  /** Row-seam finger identity for the single pointer — `unproven` until a
   *  physical capture says otherwise (D12). */
  verticalSeamIdentity: 'unproven' | 'proven' | 'disproven';
}

/** Fixed hardware LED colour ids (firmware table; pink = 11 accepted by the
 *  executable handler, design.md:190). Approximations — no photometry. */
export interface LinnPalette {
  red: number;
  yellow: number;
  green: number;
  cyan: number;
  blue: number;
  magenta: number;
  off: number;
  white: number;
  orange: number;
  lime: number;
  pink: number;
}

/** Which palette entry each LIGHTING ROLE of the two musical regions uses
 *  (design.md lighting table: root cyan, other scale tones "green or lime
 *  after physical review", out-of-scale off but still playable — D09 —,
 *  played "white or pink, auditioned on device"). Palette KEYS, so a physical
 *  review changes one word per role. ⚠ HARDWARE-VERIFY (D18). */
export interface LinnLightingRoles {
  root: keyof LinnPalette;
  inScale: keyof LinnPalette;
  outScale: keyof LinnPalette;
  played: keyof LinnPalette;
}

/** What the MODULE tells the source to light the keys and the pad with: ITS
 *  roots and ITS scale (the `keys_root` / `pad_root` / `scale` params), so
 *  the lights can never disagree with the notes the runtime derives (WP-C
 *  open item 3c). `scale` undefined = chromatic — only the roots are
 *  landmarks; nothing is out of scale (keyboard-map.ts `noteRole`). */
export interface LinnLighting {
  keysRoot: number;
  padRoot: number;
  scale: ScaleName | undefined;
}

export interface LinnProfile {
  /** Physical playing surface (LinnStrument 200: 25 × 8). */
  columns: number;
  rows: number;
  /** Region rectangles — DATA (D03 is a recommendation, owner confirmation open). */
  regions: Record<Region, RegionRect>;
  /** Control-column assignments by ROW (0 = bottom). */
  controlRows: Record<ControlName, number>;
  /** +1 per column / +5 per row (D09, owner reuse request) and the roots. */
  semisPerCol: number;
  semisPerRow: number;
  keysRoot: number;
  padRoot: number;
  /** Selection defaults and policies. */
  defaultMask: Record<SelectorId, boolean>;
  pointerPolicy: PointerPolicy;
  selectionJoin: SelectionJoin;
  /** Pickup radius (bipolar units) for `soft_takeover`. */
  softTakeoverRadius: number;
  /** Lower five control cells live (D17 recommendation). OFF leaves them inert. */
  extraControlsEnabled: boolean;
  /** MPE bend ranges the stock-MPE decoder starts from (RPN 0/0 overrides). */
  memberBendSemitones: number;
  masterBendSemitones: number;
  /** Poly lanes per musical region (the poly cable's lane count). */
  lanesPerRegion: number;
  calibration: LinnCalibration;
  palette: LinnPalette;
  /** Palette entry per lighting role of the keys / pad regions (D18 approximations). */
  lighting: LinnLightingRoles;
}

// ── Identity ──────────────────────────────────────────────────────────────

/** A touch generation id: monotonically increasing per decoder, never reused,
 *  never reset across epochs. It is the `NoteKey` handed to
 *  `createVoiceAllocator`, so two touches of the SAME pitch are two voices. */
export type TouchId = number;

/** A session epoch: bumped on (re)connect / mode change. Events carrying an
 *  older epoch are rejected downstream — no resurrection of a pre-disconnect
 *  voice (V14). */
export type Epoch = number;

// ── Raw decoder output (WIRE coordinates, region-agnostic) ────────────────

/** Why a raw message produced nothing. Surfaced (not thrown) so the corpus can
 *  assert rejection and the device layer can count it. */
export type RawRejection =
  | 'malformed'
  | 'high_bit_data'
  | 'unknown_status'
  | 'row_out_of_range'
  | 'column_out_of_range'
  | 'no_contact'
  | 'duplicate_press'
  | 'unmapped_cc'
  | 'malformed_slide'
  /** User-Mode cell vocabulary (a note = a column, a CC = a coordinate) while
   *  the instrument has NOT confirmed User Firmware Mode — unconfirmed, OFF or
   *  silent. In any other mode those same bytes are ordinary musical MIDI and
   *  must not become cell presses. Management traffic (NRPN) still decodes. */
  | 'mode_unconfirmed';

export type RawEvent =
  | { kind: 'cell_down'; epoch: Epoch; touch: TouchId; col: number; row: number; velocity: number; time: number }
  | { kind: 'cell_up'; epoch: Epoch; touch: TouchId; col: number; row: number; releaseVelocity: number; reason?: 'session'; time: number }
  /** Global X, assembled from the CC lo/hi pair (design.md:180). `initialX` is
   *  the first complete pair of this touch — bend is displacement from it. */
  | { kind: 'cell_x'; epoch: Epoch; touch: TouchId; col: number; row: number; x: number; initialX: number; time: number }
  | { kind: 'cell_y'; epoch: Epoch; touch: TouchId; col: number; row: number; y: number; time: number }
  | { kind: 'cell_z'; epoch: Epoch; touch: TouchId; col: number; row: number; z: number; time: number }
  /** A completed horizontal transfer: same touch, new column, no new attack. */
  | { kind: 'cell_slide'; epoch: Epoch; touch: TouchId; fromCol: number; toCol: number; row: number; time: number }
  /** Firmware mode notification (NRPN 245 readback). `changed` says whether
   *  it REPORTED A TRANSITION (the epoch advanced, every contact ended) or
   *  merely acknowledged the mode the decoder already knew — the second
   *  answer of a healthy entry (echo on channel 9, then the 299 read's answer)
   *  invalidates nothing. */
  | { kind: 'mode'; epoch: Epoch; userMode: boolean; changed: boolean; time: number }
  | { kind: 'rejected'; epoch: Epoch; reason: RawRejection; bytes: readonly number[]; time: number };

// ── Surface events (APPLICATION coordinates, region-attributed) ───────────

export type TouchEndReason = 'release' | 'boundary' | 'session' | 'panic';

export type SurfaceEvent =
  | {
      kind: 'touch_start';
      epoch: Epoch;
      touch: TouchId;
      region: MusicalRegion;
      /** Application column/row (0-based, bottom-left origin). */
      col: number;
      row: number;
      /** Column/row inside the region rectangle. */
      localCol: number;
      localRow: number;
      /** Pitch at note-on — fixed for the touch's lifetime (design.md:107). */
      note: number;
      velocity: number;
      time: number;
    }
  | {
      kind: 'touch_expression';
      epoch: Epoch;
      touch: TouchId;
      region: MusicalRegion;
      bendSemitones?: number;
      pressure?: number;
      timbre?: number;
      time: number;
    }
  | {
      kind: 'touch_slide';
      epoch: Epoch;
      touch: TouchId;
      region: MusicalRegion;
      fromCol: number;
      toCol: number;
      row: number;
      time: number;
    }
  | {
      kind: 'touch_end';
      epoch: Epoch;
      touch: TouchId;
      region: MusicalRegion;
      releaseVelocity?: number;
      reason: TouchEndReason;
      time: number;
    }
  /** The XY pointer candidate for a PAD-origin touch: unipolar u,v ∈ [0,1],
   *  positive v up. Every pad touch emits these; the reducer decides ownership. */
  | {
      kind: 'pointer';
      epoch: Epoch;
      touch: TouchId;
      phase: 'down' | 'move' | 'up';
      u: number;
      v: number;
      pressure: number;
      time: number;
    }
  /** A FRESH edge on a control cell. Only fresh contacts produce these — a
   *  touch sliding into the column from a musical region never does. */
  | { kind: 'control_edge'; epoch: Epoch; control: ControlName; down: boolean; time: number };

export type SessionEvent = {
  kind: 'session';
  epoch: Epoch;
  state: 'connected' | 'disconnected' | 'mode_changed';
  userMode: boolean;
  time: number;
};

/** What the source registry publishes: surface events plus session status. */
export type RuntimeEvent = SurfaceEvent | SessionEvent;

// ── Selection reducer ─────────────────────────────────────────────────────

export interface XyPair {
  x: number;
  y: number;
}

export interface SelectionState {
  /** Three INDEPENDENT bits (D04 — owner ruling). */
  mask: Record<SelectorId, boolean>;
  /** Retained bipolar pairs; hold on release (D06). */
  pairs: Record<SelectorId, XyPair>;
  /** Which selector cells are physically held — a repeated down never flips. */
  held: Record<SelectorId, boolean>;
  /** Which selectors are armed for soft-takeover pickup (join policy branch). */
  armed: Record<SelectorId, boolean>;
  /** The pointer: the one touch that owns the XY gesture, or null. */
  pointer: { touch: TouchId | null; u: number; v: number };
  /** Epoch the reducer is accepting; older intents are rejected. */
  epoch: Epoch;
  /** Monotonic revision, bumped on every accepted change — the LED writer's
   *  acknowledgement token. */
  revision: number;
}

/** Everything that can change selection state, from ANY origin — hardware
 *  edges, the DOM pads, patch hydration. One reducer, so displayed selection,
 *  CV and LEDs cannot disagree. */
export type ControlIntent =
  | { kind: 'selector_edge'; selector: SelectorId; down: boolean; epoch?: Epoch }
  | { kind: 'set_selector'; selector: SelectorId; on: boolean }
  | { kind: 'pointer'; touch: TouchId; phase: 'down' | 'move' | 'up'; u: number; v: number; epoch?: Epoch }
  /** A DOM pad or a patch write moves ONE pair directly, selection or not. */
  | { kind: 'set_pair'; selector: SelectorId; x: number; y: number }
  | { kind: 'center' }
  | { kind: 'panic' }
  | { kind: 'extra_control'; control: Exclude<ControlName, SelectorId | 'panic'>; down: boolean; epoch?: Epoch }
  | { kind: 'hydrate'; mask?: Partial<Record<SelectorId, boolean>>; pairs?: Partial<Record<SelectorId, XyPair>> }
  | { kind: 'session'; epoch: Epoch };

/** Side effects the runtime performs; the reducer never touches audio. */
export type ReducerEffect =
  | { kind: 'panic' }
  | { kind: 'extra_control'; control: Exclude<ControlName, SelectorId | 'panic'> };

export interface ReduceResult {
  state: SelectionState;
  effects: ReducerEffect[];
}

// ── Source seam ───────────────────────────────────────────────────────────

export type RuntimeEventListener = (event: RuntimeEvent) => void;

/** A publisher of LinnStrument runtime events — the real device layer, or an
 *  in-memory simulation driving the same decode path. */
export interface LinnstrumentSource {
  readonly id: string;
  readonly kind: 'user_mode' | 'stock_mpe' | 'simulated';
  /** Subscribe; the listener receives every subsequent event. */
  subscribe(listener: RuntimeEventListener): () => void;
  /** Current session status, for a late subscriber. */
  snapshot(): SessionEvent;
  /** ACKNOWLEDGED selection state from the reducer, for LED painting. The
   *  source paints; it never decides (design.md:154). Optional so a stock-MPE
   *  source without LED ownership can omit it. */
  onSelection?(state: SelectionState): void;
  /** The module's roots and scale for keys / pad LIGHTING (the D09 lighting
   *  half). Optional for the same reason as `onSelection`. */
  onLighting?(lighting: LinnLighting): void;
}
