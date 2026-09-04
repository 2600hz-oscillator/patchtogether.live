// packages/web/src/lib/audio/modules/trails.ts
//
// TRAILS — the Bela Trails eurorack module as a rack-wide modulation source.
//
// Trails is a quad touch-gesture recorder: an 85 × 85 mm multitouch pad whose
// four channels each RECORD a gesture, loop it, and keep emitting X, Y and a
// gate long after the finger has left. Its USB-C port is class-compliant
// USB-MIDI, so the browser reads all of that directly — 14-bit CC per axis, one
// MIDI channel per axis, plus MIDI clock — with no helper app and no cables
// borrowed from the ES-9.
//
// ── WHY THE AUDIO DOMAIN ────────────────────────────────────────────────────
// The midi-cv-buddy / ptzcam argument verbatim: `meta` defs get no factory and
// therefore no engine handle, and the handle is where the ConstantSource
// outputs, the MIDI subscription and `dispose()` live; `video` would drag a
// module with no pixels into the WebGL attest basis.
//
// ── WHY THE CV/GATE OUTPUTS ARE cv AND gate — AND WHY THE POLY ONES ARE NOT ──
//
// The original rule here read: "a modulation source must never declare a
// pitch-typed or poly output: those make `isNoteSource` true". ⚠ THAT RULE IS
// NOW DELIBERATELY BROKEN, with owner approval, and the reversal is recorded
// rather than quietly edited away.
//
// X/Y stay `cv` and the contact gates stay `gate`, for the original reason: a
// touch POSITION is not a pitch, and a `cv` cable in this rack is a normalised
// modulation amount (ADR-004). Nothing about that changed.
//
// What was added is four `polyPitchGate` buses that exist ONLY in note mode,
// where the device really is emitting pitches. That flips `isNoteSource` true,
// and the cost of doing so was MEASURED rather than assumed:
//
//   `isNoteSource`'s only consumers are `resolveClipWiring` (returns null for a
//   note source → not clip-eligible) and the column note-tap pass (skips note
//   sources). BOTH describe wiring something INTO the module. TRAILS declares
//   `inputs: []`, so every branch of `resolveClipWiring` already returned null
//   and `isClipEligible(trailsDef)` was ALREADY false before this change.
//   Verified by running both predicates against the def with and without a poly
//   output: false → false. The contract flips; the behaviour does not.
//
// It does not touch audio-lane / mixer placement, which is decided by
// `isChainAudioParticipant` / `resolveMainAudioOut`, not by `isNoteSource`.
//
// ── THE DATA-FLOW LAW ───────────────────────────────────────────────────────
// A live gesture is 100–250 messages a second. Not one of them touches the
// Y.Doc: each becomes a `setValueAtTime` / `setTargetAtTime` on a
// ConstantSourceNode plus a mutation of a render-local snapshot the card polls.
// The synced store sees writes only when a player turns one of the three knobs,
// through the ordinary param path. This module makes NO `node.data` writes at
// all — there is nothing per-node to remember, because the device layer binds
// every Trails port it can see.
//
// ── LATENCY, HONESTLY ───────────────────────────────────────────────────────
// Web MIDI event → handler → setValueAtTime → audio thread ≈ 5–10 ms on a
// typical Chrome/macOS rig, the same budget MIDI-CV-BUDDY states. Each event's
// own `timeStamp` is projected onto the audio clock by the shared MIDI
// scheduler, so two samples of one gesture keep their real spacing however late
// their main-thread handlers ran.
//
// Inputs: none. Trails documents no MIDI IN; its clock/reset arrive as CV on
//   the module's own jacks, so rack→Trails sync is a hardware patch (CV BUDDY's
//   ES-9 clock out → Trails clock in) rather than anything this module sends.
//
// Outputs:
//   x1..x4, y1..y4 (cv): the four channels' pad positions.
//   g1..g4 (gate): the four channels' contact gates, RE-STRUCK once per loop
//     repetition (see TRAILS_LOOP_RETRIGGER_NOTCH_S).
//   clock (gate): a divided pulse train from the device's MIDI clock.
//   trig1..trig4 (gate, TRIGGER): one pulse per gesture STEP — what a drum
//     voice fires from. See TRAILS_TRIGGER_VS_GATE for why this is a separate
//     jack from g1..g4 rather than a notch cut into it.
//   poly1..poly4 (polyPitchGate): each channel's two axes as V/oct + gate,
//     voice 0 = X and voice 1 = Y. ⚠ NOTE MODE ONLY — see TRAILS_POLY_LANE.
//
// ⚠ THERE IS NO `bar` OUTPUT, and that is a finding rather than an omission.
// The device's MIDI table is eight rows of X/Y; the Bar is an assignable
// modifier of INTERNAL functions (Step Density, Gate Width, Smoothing, Volume,
// Portamento / waveshaping / Start-End, Speed, Nudge) with no MIDI message and
// no output jack on the hardware at all — so an ES-9 could not capture it
// either. A `bar` jack here could never carry data. The Bar is DRAWN on the pad
// mirror, greyed, so the picture matches the panel and says so.
//
// Params:
//   range   — UNI (0..1) or BI (−1..+1) for every X/Y jack.
//   smooth  — one-pole smoothing on the X/Y jacks.
//   divisor — MIDI ticks per CLOCK edge (24 = quarter note).

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import type { ModuleFace, ParamDef } from '$lib/graph/types';
import { createMidiScheduler } from '$lib/audio/midi-timing';
import { createPolySender, type PolySender } from '$lib/audio/poly';
import { midiToVOct } from '$lib/audio/note-entry';
import { TRIGGER_PULSE_S } from '$lib/audio/gate-trigger';
import { getSchedulerClock } from '$lib/audio/scheduler-clock';
import {
  CLOCK_DIVISORS,
  GATE_PULSE_S,
  divisorLabel,
  snapDivisor,
  type ClockDivisor,
} from '$lib/audio/modules/midiclock';
import {
  createTrailsDecoder,
  TRAILS_CHANNEL_COUNT,
  type TrailsAxis,
  type TrailsChannel,
  type TrailsEvent,
} from '$lib/midi/trails-decode';
import {
  createTrailsMonitor,
  type TrailsMonitorSnapshot,
} from '$lib/midi/trails-monitor';
import {
  connectTrails,
  subscribeTrailsMidi,
  trailsStatus,
  type TrailsStatus,
} from '$lib/midi/trails-device';

// ── The output roster ───────────────────────────────────────────────────────

/** The four channels as a list, derived from the count so nothing re-types
 *  `[1,2,3,4]`. */
export const TRAILS_CHANNELS: readonly TrailsChannel[] = Array.from(
  { length: TRAILS_CHANNEL_COUNT },
  (_, i) => (i + 1) as TrailsChannel,
);

/** Port id for one axis jack. ONE derivation, shared by the def, the factory
 *  and the card. */
export function trailsAxisPortId(channel: TrailsChannel, axis: 'x' | 'y'): string {
  return `${axis}${channel}`;
}
/** Port id for one gate jack. */
export function trailsGatePortId(channel: TrailsChannel): string {
  return `g${channel}`;
}
export const TRAILS_CLOCK_PORT_ID = 'clock';

/** Port id for one channel's step-trigger jack. */
export function trailsTrigPortId(channel: TrailsChannel): string {
  return `trig${channel}`;
}

/** Port id for one channel's poly note bus. */
export function trailsPolyPortId(channel: TrailsChannel): string {
  return `poly${channel}`;
}

/**
 * Which poly LANE each axis occupies: X is voice 0, Y is voice 1.
 *
 * ── WHY FOUR 2-VOICE PORTS AND NOT ONE 8-VOICE PORT ─────────────────────────
 *
 * The bus is wide enough for one global port — `POLY_CHANNEL_PAIRS` is 16, so
 * all eight of the device's simultaneous notes (4 channels x X and Y) would fit
 * with room to spare. Width is NOT the reason. Two things that are measurable
 * in this tree are:
 *
 *   1. ⚠ NO SHIPPED CONSUMER READS PAST LANE 4. `POLY_VOICES` in the CUBE
 *      worklet is 5, `POLY_SUM_VOICES` in the shared poly oscillator sum is 5,
 *      TIDY_VOICES is 5, sixstrum reads 6. A single global port would put
 *      channel 3's axes on lanes 4-5 and channel 4's on lanes 6-7, and every
 *      instrument in the rack would silently drop them — a jack that looks
 *      patched and carries nothing, which is the exact failure this repo names
 *      "green and silent". Per-channel puts X on lane 0 and Y on lane 1, inside
 *      every consumer's window.
 *   2. ROUTING IS THE POINT OF FOUR RECORDERS. Channel 1 into one voice and
 *      channel 2 into another is the reason the hardware has four channels at
 *      all; one merged bus would make that a patch you cannot express.
 */
export const TRAILS_POLY_LANE: Readonly<Record<TrailsAxis, number>> = { x: 0, y: 1 };

// ── Params ──────────────────────────────────────────────────────────────────

/**
 * POLARITY of the eight X/Y jacks. 0 = UNIPOLAR 0..1 (DEFAULT), 1 = BIPOLAR
 * −1..+1.
 *
 * ⚠ THE DEFAULT IS THE OPPOSITE OF FEATURECV'S, AND THAT IS DELIBERATE. A
 * feature CV is an amount, and bipolar makes a strong sweep move a centred
 * destination through its whole travel — so featurecv defaults to BI. A touch
 * position is a COORDINATE: the pad's bottom-left corner is (0, 0) and its
 * top-right is (1, 1), which is the same space a screen, a `cvScale`
 * absolute-position input and every 1:1 mapping already speak. Defaulting to BI
 * here would make "patch X into a video module's X position" land the finger
 * half a screen from where it physically is.
 *
 * The `options` roster is what keeps the two names on the surface: undeclared,
 * a 0..1 discrete param renders as an anonymous two-state toggle printing
 * `0` / `1`. It is contract-transparent (contract-signature reads
 * id/min/max/curve/defaultValue/units only), so naming the detents moves no
 * line in contract-lock.txt.
 */
export const TRAILS_RANGE_PARAM: ParamDef = {
  id: 'range',
  label: 'Range',
  defaultValue: 0,
  min: 0,
  max: 1,
  curve: 'discrete',
  options: [
    { value: 0, label: 'UNI', title: 'Unipolar 0..1 — the pad\'s own coordinates, 1:1 with a screen' },
    { value: 1, label: 'BI', title: 'Bipolar −1..+1 — centre of the pad is 0, for centred destinations' },
  ],
};

/**
 * The longest smoothing time constant the SMOOTH knob can reach, in seconds.
 *
 * Smoothing is a `setTargetAtTime` exponential rather than a per-sample filter,
 * so the knob picks the time constant τ directly: the jack covers ~63 % of the
 * distance to a new sample in τ seconds. 0 is OFF and steps instantly (a plain
 * `setValueAtTime`), which is what a 1:1 screen mapping wants; the far end is a
 * lazy, gliding follow that turns a jittery fingertip into a smooth sweep.
 *
 * 0.25 s is the point past which a gesture stops feeling connected to the hand
 * that made it — beyond it the jack is a slew limiter, which the rack already
 * has dedicated modules for.
 */
export const TRAILS_MAX_SMOOTH_TAU_S = 0.25;

export const TRAILS_SMOOTH_PARAM: ParamDef = {
  id: 'smooth',
  label: 'Smooth',
  defaultValue: 0,
  min: 0,
  max: 1,
  curve: 'linear',
};

/**
 * MIDI ticks per CLOCK edge — the same division roster MIDICLOCK offers, built
 * from ITS exported constants rather than re-typed here. MIDI is fixed at 24
 * pulses per quarter note, so the five whole-note divisions are the whole
 * musically meaningful set (see MIDICLOCK's own `optionsExhaustive` argument,
 * which is restated below because the clause requires a `why` in place).
 */
export const TRAILS_DIVISOR_PARAM: ParamDef = {
  id: 'divisor',
  label: 'Clock div',
  defaultValue: 24,
  min: 1,
  max: 24,
  curve: 'discrete',
  options: CLOCK_DIVISORS.map((d) => ({
    value: d as number,
    label: divisorLabel(d),
    title:
      d === 1
        ? 'raw — one pulse per incoming MIDI tick (the full 24 PPQN stream)'
        : `${divisorLabel(d)} note — one pulse every ${24 / d} MIDI tick${24 / d === 1 ? '' : 's'}`,
  })),
  optionsExhaustive: {
    why:
      'MIDI is fixed at 24 pulses per quarter note, so a division is only musically meaningful '
      + 'when it divides 24 evenly — these five are the whole-note-value divisions plus the '
      + 'undivided stream. The nineteen integers in between are not unnamed states this module '
      + 'has a meaning for: dividing by 7 emits an edge every 7/24 of a beat, which lands on no '
      + 'note value and drifts against every other clock in the rack. The roster is MIDICLOCK\'s '
      + 'own CLOCK_DIVISORS, so the two modules cannot come to disagree about what a division is.',
  },
};

// ── Card-visible state: the panel's proportions ─────────────────────────────
//
// The pad mirror is 1:1 with the hardware, so the numbers it is drawn from are
// the hardware's own millimetres rather than pixels chosen to look right. They
// live here, beside the module, because the card and its tests both need them
// and neither should re-type a measurement.

/** The multitouch pad: 85 × 85 mm. */
export const TRAILS_PAD_MM = 85;
/** The capacitive Touch Bar: 10 × 85 mm. */
export const TRAILS_BAR_MM = 10;
/** Panel gap between the pad and the Bar. Not a documented dimension — a
 *  drawing allowance, so the two read as separate surfaces at 140 px. */
export const TRAILS_BAR_GAP_MM = 3;

/**
 * Which edge of the pad the Bar runs along.
 *
 * `'bottom'`, CONFIRMED AGAINST THE HARDWARE (owner, 2026-08-31: "bar on
 * bottom") — not inferred, and not a placeholder.
 *
 * It is still a named constant because the DOCUMENTATION cannot support it:
 * neither the manual nor the product page states the Bar's position relative to
 * the pad, and the dimensions alone (10 × 85 mm beside an 85 × 85 mm pad on a
 * 22 HP / 111.8 mm panel) are satisfied by a side placement as easily as a
 * bottom one. The earlier integration report guessed "side slider" from exactly
 * that reading and was wrong. So the fact lives in one place, sourced to the
 * only authority there is — someone looking at the panel.
 */
export const TRAILS_BAR_EDGE: 'bottom' | 'top' | 'left' | 'right' = 'bottom';

/**
 * Is the Bar's position readable over USB-MIDI at all?
 *
 * ⚠ FALSE, AND IT IS A FINDING WITH A CITATION, NOT AN UNFINISHED FEATURE.
 * The quick reference states the transmit set as "Each X and Y output transmits
 * over its own channel", the manual's MIDI mapping table is exactly eight rows
 * (1.X … 4.Y on MIDI channels 1–8), and the module's physical outputs are 8 CV
 * (X/Y per channel) + 4 gate — so the Bar has neither a MIDI message nor an
 * output jack, and no ES-9 patch could capture it either. It is an assignable
 * modifier of INTERNAL functions ("In INPUT it can be assigned to Step Density,
 * Gate Width, Smoothing, Volume or Portamento"), whose effect reaches us only
 * in the shape of the X/Y/gate it modifies.
 *
 * The flag exists so the card can draw the Bar as INERT rather than absent —
 * a blank strip that silently never moves is the same picture as a broken one.
 * If a future firmware transmits it, this flips to true, a `bar` output joins
 * the def, and the card's strip already has a place to put the value.
 */
// Annotated `boolean` rather than left to infer the literal type `false`: this
// is a FLAG that a firmware finding flips, not a constant the type system should
// treat as permanently false and narrow every branch against.
export const TRAILS_BAR_TRANSMITS_MIDI: boolean = false;

/** One point of one channel's fading trail, in pad coordinates (0..1). */
export interface TrailsPoint {
  x: number;
  y: number;
}

/** Live per-channel state the pad view paints. TRANSIENT — it lives on the
 *  engine handle and dies with the node; nothing here is ever persisted. */
export interface TrailsChannelState {
  /** Pad coordinates, 0..1, INDEPENDENT of the range param — the view mirrors
   *  the physical surface, so it always speaks the surface's own space. */
  x: number;
  y: number;
  gate: boolean;
  /** Most recent points first-in-first-out; length ≤ TRAILS_TRAIL_LENGTH. */
  trail: TrailsPoint[];
}

/** How many past points each channel's fading trail keeps.
 *
 *  At a plausible 100 Hz axis stream this is a little under half a second of
 *  history, which is the length that reads as "the gesture you just made"
 *  rather than as a static scribble. It is a fixed-size ring: the cost of the
 *  view is bounded by this number and not by how long the device has been
 *  streaming. */
export const TRAILS_TRAIL_LENGTH = 48;

/**
 * How long a gate is held LOW to make a loop restart into a real rising edge.
 *
 * ── WHY A NOTCH AND NOT A LEVEL CHANGE ──────────────────────────────────────
 *
 * The device streams a recorded gesture's X/Y continuously, so across a loop
 * repetition the contact level never falls — there is nothing to make an edge
 * out of. A `'loop'` gate event therefore cannot be written as "set high": the
 * jack is already high and the rack would see no event at all, which is exactly
 * the reported defect. So the restart is written as low-then-high, and the
 * downstream envelope sees the rising edge the hardware's own gate out would
 * have given it ("The GATE output produces a trigger whenever the gesture
 * returns to the start of its loop").
 *
 * 5 ms is 240 samples at 48 kHz — long enough that an audio-rate gate consumer
 * cannot step over it between blocks, short enough to be inaudible as a hole in
 * a sustained gate. It is the width GATE_PULSE_S already uses for this repo's
 * triggers, restated as its own constant because it answers a different
 * question: GATE_PULSE_S is how long a trigger is HIGH, this is how long a gate
 * is LOW. A player whose envelope misses the retrigger widens THIS line.
 *
 * ⚠ AGENTS.md rule 7 holds: the gate jacks stay LEVEL-sensitive. This adds an
 * edge inside a level; it does not convert a level consumer to edge-only.
 */
export const TRAILS_LOOP_RETRIGGER_NOTCH_S = 0.005;

/**
 * WHY THE STEP ARTICULATION IS A NEW JACK AND NOT A NOTCH IN THE GATE.
 *
 * Owner: "in note mode (or not) i would like to be able to trigger kick drum
 * from trails. i think what i need is gate/pitch outputs that are functionally
 * the same as the ones on the device, and i don't think our gates are there?"
 *
 * ── WHAT THE DEVICE'S GATE ACTUALLY IS ──────────────────────────────────────
 *
 * The manual, verbatim and already quoted in `trails-decode.ts`:
 *
 *   "The GATE output produces a TRIGGER whenever the gesture returns to the
 *    start of its loop or after each silent section in the recording."
 *
 * A TRIGGER. Not "is high while touched". And the Bar's assignable roster —
 * "Step Density, GATE WIDTH, Smoothing, Volume or Portamento" — settles it: a
 * signal with a settable WIDTH is a pulse, and a signal with a settable step
 * DENSITY is a pulse TRAIN, one per step. The device's gate jack is a rhythm
 * generator. Ours was only ever a contact level, which is why a kick patched to
 * it fired once and never again.
 *
 * ── WHY NOT SIMPLY NOTCH g1..g4 ─────────────────────────────────────────────
 *
 * A notch was the obvious move — the `'loop'` retrigger above already cuts one —
 * and it is rejected for three reasons, stated so the choice can be argued with:
 *
 *   1. A NOTCH IN A LEVEL IS A HOLE. `g1..g4` are documented and shipped as
 *      level-sensitive contact gates; a player holding a pad through a VCA
 *      patched to `g1` would get a click on every step. The loop notch is
 *      tolerable at ONE per repetition and would not be at one per step.
 *   2. THEY ANSWER DIFFERENT QUESTIONS. "Is this channel sounding" and "a step
 *      just happened" are both real and neither substitutes for the other. On
 *      the hardware they are the same jack only because the hardware has one
 *      jack and a WIDTH knob to slide between the two behaviours; two jacks is
 *      that knob's two ends, both available at once.
 *   3. AGENTS.md rule 7 — gate consumers stay level-sensitive, and no shipped
 *      consumer of `g1..g4` is converted to edge-only by adding a jack beside
 *      it. Changing `g1`'s semantics would have converted every one of them.
 *
 * The cost, stated plainly: four more jacks on an already busy module, and a
 * player has to know which one to patch. The docs name it, and a drum voice
 * wants TRIG while an envelope or VCA wants GATE.
 */
export const TRAILS_TRIGGER_VS_GATE =
  'trig{n} is a per-step TRIGGER (what a drum fires from); g{n} is a contact LEVEL.';

/**
 * How long a step trigger stays high.
 *
 * The repo's shared `TRIGGER_PULSE_S` — 5 ms, "within the real-hardware 1-5 ms
 * band", the same width `archivist`, `peertube` and `tv-librarian` strike with.
 * Aliased rather than re-typed so every trigger in the rack keeps one width.
 *
 * ⚠ DELIBERATELY `TRIGGER_PULSE_S`, NOT the `GATE_PULSE_S` the CLOCK jack uses,
 * even though the two are both 5 ms today. They answer different questions —
 * one is how long a TRIGGER is high, the other how long a gate PULSE is — and
 * the constants are allowed to diverge. Picking the one that names this port's
 * semantics is what keeps a future change to either from silently moving both.
 *
 * ⚠ NOT the device's Bar-assignable GATE WIDTH. That is an internal function
 * with no MIDI message, so its value is unknowable here; what reaches us is the
 * step's TIMING, and the width is ours to choose.
 */
export const TRAILS_TRIGGER_PULSE_S = TRIGGER_PULSE_S;

export interface TrailsState {
  /** Device binding state, mirrored so a surface needs one read. */
  readonly status: TrailsStatus;
  /** Indexed 0..3 for channels 1..4. */
  readonly channels: readonly TrailsChannelState[];
  /** Axis messages decoded since construction — lets a test wait on "the
   *  stream arrived" instead of sleeping, and lets the card show that the
   *  module is RECEIVING (the two silent failure modes — nothing plugged in,
   *  and a port that matched but sends nothing — look identical otherwise). */
  readonly axisMessages: number;
  /** MIDI clock ticks seen. */
  readonly clockTicks: number;
  /**
   * Loop restarts (MIDI Start messages) seen since construction.
   *
   * The number the reported defect is ABOUT: it must advance once per loop
   * repetition, and `gateEdges` must advance with it. A card that shows both
   * lets a player confirm the 1:1 without patching anything.
   */
  readonly loopRestarts: number;
  /** RISING gate edges written to the four gate jacks, per channel (indexed
   *  0..3). The loop retrigger's whole purpose is to make this advance while a
   *  gesture plays back, so it is the counter a test asserts 1:1 against
   *  `loopRestarts`. */
  readonly gateEdges: readonly number[];
  /**
   * STEP TRIGGERS emitted per channel (indexed 0..3) — the count of times a
   * drum voice patched to `trig{n}` would have fired.
   *
   * Separate from `gateEdges` because they measure different things and the
   * difference IS the defect this port exists for: during one interleaved
   * gesture `gateEdges` advances ONCE (the contact level never falls) while
   * this advances once per step.
   */
  readonly stepTriggers: readonly number[];
  /**
   * Raw MIDI frames the bound ports have delivered, and how many of them the
   * decoder made nothing of.
   *
   * ⚠ CHEAP COUNTERS ONLY. The full monitor snapshot is deliberately NOT in
   * this object: `state()` is read once per animation frame to paint the pad,
   * and building the monitor's sorted rows and its summary string sixty times a
   * second — while a live gesture is also streaming — would make the diagnostic
   * the most expensive thing in the module. The snapshot lives behind
   * `engine.read(node, 'monitor')`, which the card calls only while MON is
   * open. These two integers are what a closed card needs: a non-zero
   * `midiFramesUnrecognised` is visible as a warning without paying for the
   * detail that explains it.
   */
  readonly midiFrames: number;
  readonly midiFramesUnrecognised: number;
}

export interface TrailsCardApi {
  /** Gesture-gated. Never throws; true only when a Trails port is attached. */
  connect(): Promise<boolean>;
  status(): TrailsStatus;
  state(): TrailsState;
  /** The MIDI monitor's full detail. Call it only when something is going to
   *  read the result — it sorts and renders a summary string. */
  monitor(): TrailsMonitorSnapshot;
  /** Zero the monitor's tallies, so a player can isolate one gesture. */
  resetMonitor(): void;
}

// ─────────────────────────── THE FACE ───────────────────────────────────────
//
// ⚠ CONNECT RANKS FIRST, ABOVE EVERY KNOB, and that ordering is the whole
// reason this module gets a `controlFamily` rather than three param cells and a
// dock-only button. trails is INERT before the gesture: Web MIDI publishes no
// port at all until the browser consents, so a fresh spawn is three knobs over
// twenty-one jacks that emit a flat zero. `faceTierCap` caps a glyph-less
// COMPACT tile at 3 cells (`LANE_ROW_MAX_CELLS`), so any rank below 3 loses the
// gesture from the lane tile entirely — which is exactly what made midiclock
// make it a cell (#2187) and ptzcam rank it first.
//
// CLOCK DIV falling off the compact tile is the ordinary ladder rather than a
// loss: it is the one control that means anything only once a transport is
// running, and the dock is one click away. Inverting the order to keep it would
// push CONNECT off the tile, which is the defect the ranking exists to avoid.
//
// ⚠ `glyph: 'none'` IS FORCED, NOT CHOSEN. Run through `glyphBinding`
// (`shell-glyph-live.ts`) rather than guessed: `primaryAudioOutPortId` is
// `outputs.find(o => o.type === 'audio')?.id`, and these 21 outputs are `cv` x 8,
// `gate` x 9 and `polyPitchGate` x 4 — so it resolves null, there is no
// `algorithm`/`envelope`/waveform-law param set, and every other literal falls
// through to `{ kind: 'static' }`, which `module-face-lint`'s dead-glyph clause
// reddens unconditionally. ⚠ And `'algorithm'` would RESOLVE (the
// `layoutSource: <ext>` branch fires for any def carrying a `face.extension`)
// and so pass that clause while painting an EMPTY topology plate, because this
// extension exports no `glyph` slot. `trails-face-model.test.ts` pins both.
//
// ⚠ AND THE GLYPH THIS MODULE WOULD WANT IS THE PAD MIRROR — which is why the
// mirror is a BODY. The `glyph` slot takes `{ num, numbers, testid }` and is a
// data-derived identity picture bound to a topology PARAM; the mirror is live
// transient state with no param behind it. See the shell extension's header.
//
// TWO BANDS, NOT A TAB RAIL: `DOCK_TAB_MIN_BANDS` is 7 and nothing here is
// padded to reach it (owner ruling: never pad pages to force the rail).
// `device` is the binding, `signal` is what the jacks emit — different KINDS of
// thing, which is what a band boundary is for.
export const TRAILS_FACE: ModuleFace = {
  glyph: 'none',
  order: ['trails-connect-{n}', 'range', 'smooth', 'divisor'],
  extension: 'trails',
  pages: [
    {
      id: 'device',
      label: 'device',
      hint:
        'CONNECT is the one-time-per-origin Web-MIDI grant plus the search for any port named '
        + 'like a Trails; until it is granted this module has no device to read and every jack '
        + 'below emits a flat zero. The pad mirror on the faceplate is READ-ONLY — it is a 1:1 '
        + 'picture of the physical panel, not a control — and MON beside it opens a live readout '
        + 'of every MIDI frame the device sends, including the ones this module does not '
        + 'recognise.',
      controls: ['trails-connect-{n}'],
    },
    {
      id: 'signal',
      label: 'signal',
      hint:
        'What the twenty-one jacks emit from the gesture the device is streaming. RANGE picks '
        + "whether the eight X/Y jacks carry the pad's own 0..1 coordinates or a bipolar signal "
        + 'centred on the pad; SMOOTH glides them toward each new sample instead of stepping, at '
        + 'the cost of trailing the hand; CLOCK DIV divides the device\'s own MIDI clock into the '
        + 'CLOCK pulse train. None of the three affects the pad view, which always mirrors the '
        + 'physical surface.',
      controls: ['range', 'smooth', 'divisor'],
    },
  ],
};

// ── The def ─────────────────────────────────────────────────────────────────

export const trailsDef: AudioModuleDef = {
  // String LITERALS, not references: module-manifest.ts extracts these fields
  // with a ?raw regex and cannot resolve an identifier.
  type: 'trails',
  palette: { top: 'MIDI', sub: 'MIDI' },
  domain: 'audio',
  label: 'trails',
  category: 'sources',
  // Declared on the DEF rather than added to RACK_SIZE_DEFAULTS — the bulk map
  // says in as many words that a new module should carry its own. `3u` because
  // the card owns a live screen (the pad mirror), which is the tier every
  // screen-bearing card sits at; `hp` 2 because the card is 260 px wide and one
  // 180 px tile would clip it.
  size: '3u',
  hp: 2,

  inputs: [],
  outputs: [
    // Inlined as literals rather than derived with a .map so the docs manifest
    // extractor can read them; `trails.test.ts` asserts 1:1 parity with the
    // TRAILS_CHANNELS derivation, so the two cannot drift.
    { id: 'x1', type: 'cv', label: 'x 1' },
    { id: 'y1', type: 'cv', label: 'y 1' },
    { id: 'x2', type: 'cv', label: 'x 2' },
    { id: 'y2', type: 'cv', label: 'y 2' },
    { id: 'x3', type: 'cv', label: 'x 3' },
    { id: 'y3', type: 'cv', label: 'y 3' },
    { id: 'x4', type: 'cv', label: 'x 4' },
    { id: 'y4', type: 'cv', label: 'y 4' },
    { id: 'g1', type: 'gate', edge: 'gate', label: 'gate 1' },
    { id: 'g2', type: 'gate', edge: 'gate', label: 'gate 2' },
    { id: 'g3', type: 'gate', edge: 'gate', label: 'gate 3' },
    { id: 'g4', type: 'gate', edge: 'gate', label: 'gate 4' },
    // A divided clock is a TRIGGER, not a level: it fires once per edge and the
    // pulse width carries no meaning, which is exactly MIDICLOCK's `clock`.
    { id: 'clock', type: 'gate', edge: 'trigger' },
    // The four per-channel STEP TRIGGERS — what a drum voice fires from. A
    // TRIGGER, not a level: see TRAILS_TRIGGER_VS_GATE.
    { id: 'trig1', type: 'gate', edge: 'trigger', label: 'trig 1' },
    { id: 'trig2', type: 'gate', edge: 'trigger', label: 'trig 2' },
    { id: 'trig3', type: 'gate', edge: 'trigger', label: 'trig 3' },
    { id: 'trig4', type: 'gate', edge: 'trigger', label: 'trig 4' },
    // The four per-channel note buses. NOTE-MODE ONLY — see the docs below and
    // TRAILS_POLY_LANE for why there are four of these rather than one.
    { id: 'poly1', type: 'polyPitchGate', label: 'poly 1' },
    { id: 'poly2', type: 'polyPitchGate', label: 'poly 2' },
    { id: 'poly3', type: 'polyPitchGate', label: 'poly 3' },
    { id: 'poly4', type: 'polyPitchGate', label: 'poly 4' },
  ],
  params: [TRAILS_RANGE_PARAM, TRAILS_SMOOTH_PARAM, TRAILS_DIVISOR_PARAM],

  face: TRAILS_FACE,

  // The CONNECT gesture is not a `ParamDef` — it writes nothing, it asks the
  // browser for permission — so it reaches `face.order` through the family
  // key-space, exactly as midiclock's and ptzcam's do. `testidPrefix` already
  // appears on the legacy card (`trails-connect-${id}`, TrailsCard.svelte:358),
  // so module-docs-lint's FAMILY↔CARD clause holds with no card edit.
  controlFamilies: [
    { id: 'trails-connect', label: 'Connect Trails', kind: 'other', testidPrefix: 'trails-connect' },
  ],

  docs: {
    explanation:
      "The Bela TRAILS eurorack module, read straight into the rack over its USB-C port. Trails is a quad touch-gesture recorder: an 85 by 85 mm multitouch pad whose four channels each record a finger gesture, loop it, and keep emitting an X position, a Y position and a contact gate long after you have taken your hand away. This module receives all of that as MIDI and hands it to the patch as twelve modulation jacks plus a clock. Mental model: your finger is a modulation source, and once you lift it the gesture keeps performing itself. The pad view on the faceplate mirrors the physical surface one to one — up to four coloured touch points with fading trails, in the same coordinates the jacks emit — so you can see what the rack is receiving without looking down at the hardware. RANGE picks whether the X and Y jacks are the pad's own 0..1 coordinates (the default, so patching X into a video module\'s horizontal position puts the picture where your finger is) or bipolar around the pad's centre. SMOOTH glides the X and Y jacks toward each new sample instead of stepping, which turns a jittery fingertip into a sweep at the cost of trailing the hand. CLOCK DIV divides the device's own MIDI clock into a pulse train, so a recorded gesture and the rack can share a tempo. Nothing is streamed into the saved patch: the touch data is live engine state, so a gesture never bloats the document or reaches collaborators. Connecting asks the browser for MIDI permission when you press CONNECT and not before, so loading a patch that contains this module never raises a prompt. There is no MIDI back to the device — Trails takes its clock and reset as CV on its own jacks, so to slave it to the rack, patch a clock out of CV BUDDY into the module\'s clock input. Two things about the hardware are worth knowing before you patch it. The device transmits its X and Y positions and its transport, and nothing else: the gate you see on the module\'s own gate jacks is not a MIDI message at all, so everything the GATE and TRIG jacks here emit is reconstructed from the position and note streams rather than read from the device. That reconstruction gives you two different signals, and picking the right one is the difference between a drone and a rhythm. GATE is contact: high while a channel is sounding, which through a gesture usually means high the whole way through, because a playing gesture never stops and, with quantisation on, the horizontal and vertical notes overlap almost continuously. TRIG is the step: a short pulse each time the gesture moves on, which is what a drum wants. You can patch both from one gesture and get a sustained layer and a rhythmic layer together. And the touch bar down the panel is not transmitted at all, and has no output jack of its own on the hardware either; it is an assignable modifier of the device's internal behaviour, so what it changes reaches this module in the shape of the X, Y and gate it shapes rather than as a signal you can patch. The bar is drawn on the pad view so the picture matches the panel, greyed to say it carries no data. MON opens a live readout of every MIDI message the device is sending, including any this module does not recognise, which is how to check what your firmware actually transmits. The third thing worth knowing is what happens when you turn on pitch quantisation. With both pitch and temporal quantisation enabled the device stops sending its continuous high-resolution positions and sends MIDI notes instead, quantised to the scale you picked. Those notes are the same two axes, on the same per-axis channels, so the X and Y jacks keep working: each note number is spread across the jack's travel, so playing up a scale walks the jack upward in even steps. Because a note number is already linear in semitones, the jack is a pitch-shaped signal in the same way a volt-per-octave control voltage is, just normalised into this rack's range rather than measured in volts. The travel a scale covers depends on how wide it is: the whole MIDI note range is spread across the jack, so a scale spanning an octave or two moves it by a tenth to a fifth of full scale rather than end to end. Turn RANGE to BI to double that swing, or use an attenuverter downstream to make a narrow scale reach further. And once you are in note mode you do not have to go through a control voltage at all: each channel has a POLY jack carrying that channel's two axes as actual notes, one voice for X and one for Y, which you can patch straight into any polyphonic instrument to hear the scale you picked without calibrating anything. Those jacks are silent in the ordinary continuous mode, because there are no notes to send. One thing this hardware will not give you is dynamics: every note it sends carries the same fixed velocity, measured on the device rather than assumed, so nothing here can tell a firm press from a light one. To strike a drum from a gesture, patch TRIG rather than GATE. GATE tells you whether a channel is sounding, and through a gesture the answer stays yes the whole way, because the two axes cross their quantiser steps at different moments and one of them is nearly always sounding; a drum patched there fires once and then waits forever. TRIG fires once per step instead, plus once each time the loop comes back round, which is what the gate jack on the hardware itself does. How much TRIG can tell you depends on the mode, and the difference is worth knowing rather than guessing at: with quantisation on, the device sends a note per step and the triggers are exact. In the continuous mode it sends only positions and keeps its step gate to itself, so the most that can honestly be produced is a pulse when a channel starts moving again after being still, and one per loop restart.",
    inputs: {},
    outputs: {
      x1: "Channel 1's horizontal pad position. 0 is the left edge of the pad and 1 the right, or −1..+1 about the centre when RANGE is BI. It keeps streaming while a recorded gesture plays back, and holds its last value when the channel is idle. With pitch quantisation switched on the device sends notes instead of continuous positions, and this jack follows those notes: each note number lands at its own point along the travel, so a scale steps the jack rather than sliding it, and a released note holds the last pitch rather than dropping to zero.",
      y1: "Channel 1's vertical pad position, 0 at the bottom edge through 1 at the top (or −1..+1 when RANGE is BI). Pair it with X1 to drive a two-axis destination from one finger.",
      x2: "Channel 2's horizontal pad position, in the same coordinates as X1.",
      y2: "Channel 2's vertical pad position, in the same coordinates as Y1.",
      x3: "Channel 3's horizontal pad position, in the same coordinates as X1.",
      y3: "Channel 3's vertical pad position, in the same coordinates as Y1.",
      x4: "Channel 4's horizontal pad position, in the same coordinates as X1.",
      y4: "Channel 4's vertical pad position, in the same coordinates as Y1.",
      g1: "Channel 1's CONTACT gate: high while the channel is sounding, low when it is idle. It answers \"is this channel in contact\", and during a gesture the answer is usually yes the whole way through, so expect a long held gate rather than a rhythm. That is deliberate and it is worth understanding before you patch it. In the continuous mode the device streams positions without a pause while a recorded gesture plays back, so contact never ends; the gate is re-struck once at the top of each loop repetition, as a brief dip to zero and back, so a looping gesture articulates an envelope again each time round. With quantisation on, the channel is counted as sounding while EITHER its horizontal or its vertical note is held, and because those two are quantised separately they overlap almost continuously — one is nearly always sounding — so the gate stays up for the whole gesture and the loop dip is not applied, because the notes themselves are already the articulation. If you want a drone that follows a gesture, this is the jack. If you want to strike a drum once per step, patch TRIG instead. Two limits are worth knowing. The loop dip is driven by the device's transport, and the device reports only one playhead, its first channel's: with clock-synchronised recording every channel shares the cycle and they re-strike together, but a channel running a different step count re-strikes at channel 1's rate rather than its own. And the hardware's own gate jacks are not transmitted over MIDI at all, so everything on this jack is reconstructed from the position and note streams rather than read from the device.",
      g2: "Channel 2's contact gate, in the same form as GATE 1 — high while that channel is sounding, and long-held through a gesture rather than rhythmic. See GATE 1 for what it does in each mode, why it holds, and what the device does and does not transmit.",
      g3: "Channel 3's contact gate, in the same form as GATE 1 — high while that channel is sounding. See GATE 1 for the mode differences and the limits.",
      g4: "Channel 4's contact gate, in the same form as GATE 1 — high while that channel is sounding. See GATE 1 for the mode differences and the limits.",
      clock:
        "A pulse train derived from the MIDI clock the device transmits, divided by the CLOCK DIV setting — at the default 24 that is one pulse per quarter note, the division TIMELORDE expects. It is a trigger: each pulse is a short fixed-width rising edge and the level between pulses carries no meaning. Silent until the device's transport is running.",
      trig1:
        "A short pulse every time channel 1's gesture steps — this is the jack to patch into a drum. It fires once per step of the recorded or played gesture, plus once each time the loop returns to its start, which is what the module\'s own gate jack does on the hardware. Use it wherever you want something struck rather than held: a kick, a snare, a sampler, an envelope you want re-articulated. It is deliberately not the same jack as GATE 1. GATE 1 answers \"is this channel sounding\", and during a gesture that answer stays yes the whole time, because the horizontal and vertical positions cross their quantiser steps at different moments and one of them is essentially always sounding. A drum patched there fires once at the start of a gesture and then never again, which is the problem this jack fixes. How much it can tell you depends on the mode. With pitch and temporal quantisation on, the device sends a note for every step and this jack is exact, one pulse per step. In the ordinary continuous mode the device sends only positions, and its own step gate is not transmitted at all, so all this can honestly fire on is the moment a channel starts moving again after being still, and each loop restart. If you want steady triggers from a gesture, turn quantisation on.",
      trig2: "Channel 2's step trigger, in the same form as TRIG 1 — a short pulse per gesture step and per loop restart, for striking a drum or re-articulating an envelope.",
      trig3: "Channel 3's step trigger, in the same form as TRIG 1.",
      trig4: "Channel 4's step trigger, in the same form as TRIG 1.",
      poly1:
        "Channel 1's two axes as a note bus, for playing an instrument directly instead of reconstructing pitch from a control voltage. Voice 1 is the X axis and voice 2 is the Y axis, each carrying a pitch and its own gate, so one finger plays a two-note chord that moves as you move. Patch it into any polyphonic voice. Only alive when the device is sending notes: turn on both pitch and temporal quantisation and this starts playing, and in the ordinary continuous mode it sits silent while the X, Y and gate jacks carry everything as usual. The pitch is the real quantised note the device chose, so it lands in tune with whatever scale you picked on the panel rather than being a voltage you have to calibrate. The gate stays up for as long as you hold the position, so a sustained touch sustains the note. Velocity is not part of it: this hardware sends the same fixed velocity for every note, so the bus carries no dynamics and a voice that responds to how hard you play will always hear the same thing.",
      poly2: "Channel 2's two axes as a note bus, in the same form as POLY 1 — voice 1 is X, voice 2 is Y, and it is alive only when the device is sending notes. Each channel has its own bus so you can play a different instrument from each recorded gesture.",
      poly3: "Channel 3's two axes as a note bus, in the same form as POLY 1 — voice 1 is X, voice 2 is Y, and it is alive only when the device is sending notes.",
      poly4: "Channel 4's two axes as a note bus, in the same form as POLY 1 — voice 1 is X, voice 2 is Y, and it is alive only when the device is sending notes.",
    },
    controls: {
      range:
        "Whether the eight X and Y jacks emit the pad's own coordinates or a bipolar signal centred on the middle of the pad. UNI is 0..1 and is the default because a touch position is a COORDINATE: the pad's bottom-left is (0, 0) and its top-right is (1, 1), which is the space a screen and an absolute-position CV input already speak, so a 1:1 mapping lands the picture where your finger physically is. BI is −1..+1 with the centre of the pad at 0, which is what a destination that modulates around its own knob setting wants. It changes what the jacks emit, never what the pad view shows — the view always mirrors the physical surface.",
      smooth:
        "How lazily the X and Y jacks follow the device. At 0 each arriving sample steps the jack immediately, which is what a 1:1 screen mapping wants; turning it up makes the jack glide exponentially toward each new sample instead, covering about two thirds of the distance in the time the knob sets, up to a quarter of a second at the far end. Use it to turn a jittery fingertip or a coarse stream into a smooth sweep, and accept that the jack then trails the hand that made the gesture. It does not affect the gates or the clock, which must stay sharp.",
      divisor:
        "How many of the device's MIDI clock ticks make one pulse on the CLOCK jack. MIDI runs at a fixed 24 pulses per quarter note, so 24 is one pulse per quarter (patch it into TIMELORDE's clock to slave the rack to the device's transport), 12 is eighths, 6 sixteenths, 3 thirty-seconds, and RAW passes every incoming tick. Only divisions that divide 24 evenly are offered, because any other lands on no note value and drifts against every other clock in the rack.",
      'trails-connect-{n}':
        "The gesture that makes the module do anything at all. A browser shows no MIDI port until it has consented, and it only asks when a click asks it to — so before this press there is no device to read, and all twenty-one jacks sit at zero however many gestures the hardware is looping. Pressing it grants access (one prompt, once per origin) and binds every attached port whose name looks like a Trails, which is how a class-compliant USB-C device joins the rack with no driver and no helper app. It is safe to press again: on an already-granted origin it simply re-resolves the port list, which is what re-binds a device that was unplugged and put back. Loading a patch that contains this module never raises the prompt by itself — nothing in the rack asks for MIDI on the module's behalf. The outcome is always nameable rather than silent: bound, no port named Trails, permission denied, the prompt suppressed, or Web MIDI missing entirely, and the LINK lamp on the faceplate carries the sentence with the failures also printed under it. If it says no port is present, connect the module\'s USB-C socket to this computer; if you want to see what the device is actually transmitting, press MON beside the lamp.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    // ── One ConstantSource per output ─────────────────────────────────────
    const sources = new Map<string, ConstantSourceNode>();
    function makeSource(id: string): ConstantSourceNode {
      const c = ctx.createConstantSource();
      // `.value =`, NOT `setValueAtTime` — a ConstantSourceNode's offset
      // defaults to 1.0, so the zero has to be written, but writing it as an
      // AUTOMATION EVENT would put a scheduled point on every one of the
      // thirteen jacks at construction. That is what a resting module looks
      // like to any instrument reading the automation timeline, so the
      // "nothing has driven this jack yet" state would be unobservable.
      c.offset.value = 0;
      c.start();
      sources.set(id, c);
      return c;
    }
    for (const ch of TRAILS_CHANNELS) {
      makeSource(trailsAxisPortId(ch, 'x'));
      makeSource(trailsAxisPortId(ch, 'y'));
      makeSource(trailsGatePortId(ch));
      makeSource(trailsTrigPortId(ch));
    }
    makeSource(TRAILS_CLOCK_PORT_ID);

    // ── The four per-channel poly note buses ──────────────────────────────
    //
    // ⚠ SILENT UNLESS THE DEVICE IS IN NOTE MODE, by construction rather than
    // by a flag. These are written only from `'note'` events, and the decoder
    // only produces one from a MIDI note — which the device only sends with
    // both quantisations enabled. In ordinary CC mode every lane rests at
    // pitch 0 / gate 0 and the x/y/gate jacks are the whole story, exactly as
    // before this existed.
    const polySenders = new Map<TrailsChannel, PolySender>();
    for (const ch of TRAILS_CHANNELS) polySenders.set(ch, createPolySender(ctx));

    // ── Knobs ─────────────────────────────────────────────────────────────
    const knobs: Record<string, number> = {};
    for (const p of trailsDef.params) {
      const saved = node.params?.[p.id];
      knobs[p.id] = typeof saved === 'number' ? saved : p.defaultValue;
    }
    // Snapped at the POINT OF USE, never written back — a rack saved before
    // this roster existed (or arriving by an undo / replica restore that passes
    // through no loader) clocks at its nearest legal division and SHOWS that
    // division, and the first ordinary tagged write normalises it.
    const divisorNow = (): ClockDivisor => snapDivisor(knobs.divisor ?? 24);
    const bipolar = (): boolean => (knobs.range ?? 0) >= 0.5;
    const smoothTau = (): number =>
      Math.max(0, Math.min(1, knobs.smooth ?? 0)) * TRAILS_MAX_SMOOTH_TAU_S;

    // ── Transient render state (NEVER the Y.Doc) ──────────────────────────
    const channelStates: TrailsChannelState[] = TRAILS_CHANNELS.map(() => ({
      x: 0,
      y: 0,
      gate: false,
      trail: [],
    }));
    let axisMessages = 0;
    let clockTicks = 0;
    let loopRestarts = 0;
    let midiFrames = 0;
    let midiFramesUnrecognised = 0;
    const gateEdges: number[] = TRAILS_CHANNELS.map(() => 0);
    /** Step triggers emitted per channel — the counter that shows a kick would
     *  have fired, and the one a test asserts against a step count. */
    const stepTriggers: number[] = TRAILS_CHANNELS.map(() => 0);

    // ── Scheduling ────────────────────────────────────────────────────────
    const scheduler = createMidiScheduler(ctx);
    const decoder = createTrailsDecoder();
    const monitor = createTrailsMonitor();
    let tickCounter = 0;

    /** Map a 0..1 pad coordinate into whatever the RANGE knob asks for. */
    function toOutput(unit: number): number {
      return bipolar() ? unit * 2 - 1 : unit;
    }

    function writeAxis(portId: string, value: number, at: number): void {
      const src = sources.get(portId);
      if (!src) return;
      const tau = smoothTau();
      src.offset.cancelScheduledValues(at);
      if (tau <= 0) {
        src.offset.setValueAtTime(value, at);
      } else {
        // setTargetAtTime needs a value to depart FROM at `at`; without the
        // anchor the ramp starts from whatever the last scheduled event left,
        // which after a cancel is the value at the cancel point anyway — but
        // stating it makes the curve independent of what came before.
        src.offset.setValueAtTime(src.offset.value, at);
        src.offset.setTargetAtTime(value, at, tau);
      }
    }

    function writeGate(portId: string, high: boolean, at: number): void {
      const src = sources.get(portId);
      if (!src) return;
      src.offset.cancelScheduledValues(at);
      src.offset.setValueAtTime(high ? 1 : 0, at);
    }

    /**
     * A LOOP RESTART on one channel's gate: low for the notch, then high.
     *
     * Unconditional — it does not read the current level first, and that is the
     * point. During playback the gate is already high, so "set high" would be a
     * no-op and the repetition would be invisible to the rack; cutting the
     * notch regardless is what makes every repetition produce exactly one
     * rising edge, whether the gate was high (playback) or low (a channel whose
     * stream had gone quiet).
     */
    function retriggerGate(portId: string, at: number): void {
      const src = sources.get(portId);
      if (!src) return;
      src.offset.cancelScheduledValues(at);
      src.offset.setValueAtTime(0, at);
      src.offset.setValueAtTime(1, at + TRAILS_LOOP_RETRIGGER_NOTCH_S);
    }

    function pulseClock(at: number): void {
      const src = sources.get(TRAILS_CLOCK_PORT_ID);
      if (!src) return;
      src.offset.cancelScheduledValues(at);
      src.offset.setValueAtTime(1, at);
      src.offset.setValueAtTime(0, at + GATE_PULSE_S);
    }

    function applyEvents(events: readonly TrailsEvent[], at: number): void {
      for (const ev of events) {
        if (ev.kind === 'axis') {
          const state = channelStates[ev.channel - 1];
          if (state) {
            state[ev.axis] = ev.unit;
            // The trail is a fixed-size ring: push then shift, so the view's
            // cost never grows with how long the device has been streaming.
            state.trail.push({ x: state.x, y: state.y });
            if (state.trail.length > TRAILS_TRAIL_LENGTH) state.trail.shift();
          }
          axisMessages++;
          writeAxis(trailsAxisPortId(ev.channel, ev.axis), toOutput(ev.unit), at);
        } else if (ev.kind === 'gate') {
          const state = channelStates[ev.channel - 1];
          const wasHigh = state?.gate ?? false;
          if (state) {
            state.gate = ev.high;
            // A gate falling ends the gesture, and so does a loop restarting:
            // both make the next points a NEW stroke rather than a jump across
            // the pad from wherever the last repetition ended.
            if (!ev.high || ev.source === 'loop') state.trail.length = 0;
          }
          if (ev.source === 'loop') {
            // THE LOOP RESTART. Always an edge, never a level compare — see
            // retriggerGate.
            retriggerGate(trailsGatePortId(ev.channel), at);
            const i = ev.channel - 1;
            if (i >= 0 && i < gateEdges.length) gateEdges[i]!++;
          } else {
            writeGate(trailsGatePortId(ev.channel), ev.high, at);
            if (ev.high && !wasHigh) {
              const i = ev.channel - 1;
              if (i >= 0 && i < gateEdges.length) gateEdges[i]!++;
            }
          }
        } else if (ev.kind === 'trigger') {
          // ONE ARTICULATION = ONE PULSE. Written like MIDICLOCK's clock pulse
          // and unlike `retriggerGate`: this jack has no level to preserve, so
          // there is no notch to cut — it is low, goes high, and comes back.
          //
          // ⚠ `cancelScheduledValues` FIRST, so two steps closer together than
          // the pulse width produce two pulses rather than a stuck-high jack
          // whose first falling edge lands after the second rise.
          const src = sources.get(trailsTrigPortId(ev.channel));
          if (src) {
            src.offset.cancelScheduledValues(at);
            src.offset.setValueAtTime(1, at);
            src.offset.setValueAtTime(0, at + TRAILS_TRIGGER_PULSE_S);
          }
          const i = ev.channel - 1;
          if (i >= 0 && i < stepTriggers.length) stepTriggers[i]!++;
        } else if (ev.kind === 'note') {
          // ── THE POLY BUS ───────────────────────────────────────────────
          //
          // Pitch is TRUE V/OCT — `midiToVOct`, 0 V = C4 = MIDI 60 — which is
          // the bus's documented unit and the one every poly consumer converts
          // from. That is deliberately NOT what the x/y CV jacks carry: a `cv`
          // cable in this rack is a normalised modulation amount (ADR-004), so
          // the same note reaches the rack twice in two honest units — as a
          // position on x/y, and as a pitch here.
          //
          // ⚠ THE GATE IS A LEVEL, not a fixed-width pulse. Written straight to
          // the lane's ConstantSource rather than through `scheduleStep`, whose
          // `gateOffSec` would impose a note length the device never sent —
          // Trails holds a note for as long as the finger is down. AGENTS.md
          // rule 7: gate consumers stay level-sensitive.
          const sender = polySenders.get(ev.channel);
          const lane = sender?.voices[TRAILS_POLY_LANE[ev.axis]];
          if (lane) {
            // Pitch on a STRIKE only — last-note priority, the same rule the
            // x/y axis path uses, so a release never drags the pitch anywhere.
            if (ev.on) lane.pitchSrc.offset.setValueAtTime(midiToVOct(ev.note), at);
            lane.gateSrc.offset.cancelScheduledValues(at);
            lane.gateSrc.offset.setValueAtTime(ev.sounding ? 1 : 0, at);
          }
        } else if (ev.kind === 'clock') {
          clockTicks++;
          if (++tickCounter >= divisorNow()) {
            tickCounter = 0;
            pulseClock(at);
          }
        } else if (ev.kind === 'transport') {
          // Start (reset) re-zeroes the divider so the first pulse after a
          // transport start lands on the downbeat. Continue deliberately does
          // NOT — that is the whole difference between the two messages.
          //
          // ⚠ On this device a Start is not a once-per-session event: the
          // manual sends one "every time the playhead restarts from the
          // beginning of the track", so this re-zeroes once per loop and the
          // CLOCK jack stays phase-locked to the gesture. The gate half of the
          // same message is a `'loop'` gate event, emitted alongside this one.
          if (ev.reset) {
            tickCounter = 0;
            loopRestarts++;
          }
          if (!ev.running) writeGate(TRAILS_CLOCK_PORT_ID, false, at);
        }
      }
    }

    const unsubscribeMidi = subscribeTrailsMidi((mev) => {
      try {
        const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
        // The monitor is fed the DECODER'S OWN VERDICT on this frame, not a
        // second opinion — that is what lets it report a disagreement between
        // the wire and our constants instead of agreeing with itself.
        //
        // ⚠ `recognised`, NOT `events.length > 0`. A frame can be perfectly
        // understood and correctly produce no event (a note-on while another is
        // held, an Active Sense byte), and counting those as unrecognised put a
        // "your CC pair is wrong" warning on healthy hardware.
        const { events, recognised } = decoder.handleFrame(mev.data, nowMs);
        monitor.observe(mev.data, recognised);
        midiFrames++;
        if (!recognised) midiFramesUnrecognised++;
        if (events.length > 0) applyEvents(events, scheduler.schedAt(mev.timeStamp));
      } catch (err) {
        console.error('[trails] decode error', err);
      }
    });

    // Age the ACTIVITY gates on the shared scheduler tick rather than on a
    // timer of this module's own — the tick already exists, runs with no UI
    // mounted, and is the seam ptzcam uses for the same reason. Costs one
    // Map walk at 40 Hz and emits nothing at all once the device has proven it
    // sends notes.
    const unsubscribeTick = getSchedulerClock().subscribe(() => {
      try {
        const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
        const events = decoder.tick(nowMs);
        if (events.length > 0) {
          // ⚠ THE SAME CLOCK DOMAIN AS THE MIDI PATH, deliberately. This used
          // to schedule at `ctx.currentTime + GATE_PULSE_S` (+5 ms) while MIDI
          // events land at the scheduler's lookahead (+25 ms), so a tick's
          // falling edge was written EARLIER in audio time than a MIDI event
          // processed just before it — and `writeGate` cancels everything at or
          // after its own time, so the tick could delete a retrigger notch that
          // had not fired yet. Routing both through `schedAt` removes the
          // ordering hazard rather than relying on 120 ms happening to exceed
          // the lookahead.
          applyEvents(events, scheduler.schedAt(nowMs));
        }
      } catch (err) {
        console.error('[trails] tick error', err);
      }
    });

    function snapshot(): TrailsState {
      return {
        status: trailsStatus(),
        channels: channelStates,
        axisMessages,
        clockTicks,
        loopRestarts,
        gateEdges,
        stepTriggers,
        midiFrames,
        midiFramesUnrecognised,
      };
    }

    const cardApi: TrailsCardApi = {
      connect: () => connectTrails(),
      status: trailsStatus,
      state: snapshot,
      monitor: () => monitor.snapshot(),
      resetMonitor: () => {
        monitor.reset();
        midiFrames = 0;
        midiFramesUnrecognised = 0;
        // ⚠ THE LOOP COUNTERS RESET TOO. The card prints "loops N · edges …"
        // beside the monitor and a player reads the pair as a RATIO; zeroing
        // one half and not the other leaves a ratio against a baseline that is
        // no longer on screen, which is worse than not resetting at all.
        loopRestarts = 0;
        gateEdges.fill(0);
        stepTriggers.fill(0);
      },
    };

    return {
      domain: 'audio',
      inputs: new Map(),
      // ⚠ `{ node, output }`, NEVER a bare AudioNode — a bare node in this map
      // ships a module that is green and silent (the seqtris PR paid for that
      // lesson in as many words).
      outputs: new Map<string, { node: AudioNode; output: number }>([
        ...[...sources.entries()].map(
          ([id, src]) => [id, { node: src as AudioNode, output: 0 }] as const,
        ),
        ...TRAILS_CHANNELS.map(
          (ch) =>
            [
              trailsPolyPortId(ch),
              { node: polySenders.get(ch)!.output as AudioNode, output: 0 },
            ] as const,
        ),
      ]),
      setParam(id, value) {
        if (id in knobs) knobs[id] = value;
      },
      readParam(id) {
        return knobs[id];
      },
      read(key) {
        if (key === 'card-api') return cardApi;
        if (key === 'state') return snapshot();
        // Separate key, not a field on `state`: see TrailsState.midiFrames for
        // why the expensive half is not paid for on every animation frame.
        if (key === 'monitor') return monitor.snapshot();
        return undefined;
      },
      dispose() {
        unsubscribeMidi();
        unsubscribeTick();
        decoder.reset();
        for (const sender of polySenders.values()) sender.dispose();
        polySenders.clear();
        for (const src of sources.values()) {
          try {
            src.stop();
          } catch {
            /* already stopped */
          }
          src.disconnect();
        }
        sources.clear();
      },
    };
  },
};
