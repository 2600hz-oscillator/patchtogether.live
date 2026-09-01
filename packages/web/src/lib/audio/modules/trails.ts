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
// ── WHY EVERY OUTPUT IS cv OR gate ──────────────────────────────────────────
// A modulation source must never declare a pitch-typed or poly output: those
// make `isNoteSource` true and put the module on a note LANE, which is not what
// a touch position is. X/Y are positions; the gates are contact.
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
import type { ParamDef } from '$lib/graph/types';
import { createMidiScheduler } from '$lib/audio/midi-timing';
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
  ],
  params: [TRAILS_RANGE_PARAM, TRAILS_SMOOTH_PARAM, TRAILS_DIVISOR_PARAM],

  docs: {
    explanation:
      "The Bela TRAILS eurorack module, read straight into the rack over its USB-C port. Trails is a quad touch-gesture recorder: an 85 by 85 mm multitouch pad whose four channels each record a finger gesture, loop it, and keep emitting an X position, a Y position and a contact gate long after you have taken your hand away. This module receives all of that as MIDI and hands it to the patch as twelve modulation jacks plus a clock. Mental model: your finger is a modulation source, and once you lift it the gesture keeps performing itself. The pad view on the card mirrors the physical surface one to one — up to four coloured touch points with fading trails, in the same coordinates the jacks emit — so you can see what the rack is receiving without looking down at the hardware. RANGE picks whether the X and Y jacks are the pad's own 0..1 coordinates (the default, so patching X into a video module's horizontal position puts the picture where your finger is) or bipolar around the pad's centre. SMOOTH glides the X and Y jacks toward each new sample instead of stepping, which turns a jittery fingertip into a sweep at the cost of trailing the hand. CLOCK DIV divides the device's own MIDI clock into a pulse train, so a recorded gesture and the rack can share a tempo. Nothing is streamed into the saved patch: the touch data is live engine state, so a gesture never bloats the document or reaches collaborators. Connecting asks the browser for MIDI permission when you press CONNECT and not before, so loading a patch that contains this module never raises a prompt. There is no MIDI back to the device — Trails takes its clock and reset as CV on its own jacks, so to slave it to the rack, patch a clock out of CV BUDDY into the module's clock input. Two things about the hardware are worth knowing before you patch it. The device transmits its X and Y positions and its transport, and nothing else: the gate you see on the module's own gate jacks is not a MIDI message, so the gates here are reconstructed from the stream — high while a channel is sending, re-struck at the top of every loop, and falling when the channel goes quiet. And the touch bar down the panel is not transmitted at all, and has no output jack of its own on the hardware either; it is an assignable modifier of the device's internal behaviour, so what it changes reaches this module in the shape of the X, Y and gate it shapes rather than as a signal you can patch. The bar is drawn on the pad view so the picture matches the panel, greyed to say it carries no data. MON opens a live readout of every MIDI message the device is sending, including any this module does not recognise, which is how to check what your firmware actually transmits. The third thing worth knowing is what happens when you turn on pitch quantisation. With both pitch and temporal quantisation enabled the device stops sending its continuous high-resolution positions and sends MIDI notes instead, quantised to the scale you picked. Those notes are the same two axes, on the same per-axis channels, so the X and Y jacks keep working: each note number is spread across the jack's travel, so playing up a scale walks the jack upward in even steps. Because a note number is already linear in semitones, the jack is a pitch-shaped signal in the same way a volt-per-octave control voltage is, just normalised into this rack's range rather than measured in volts. The travel a scale covers depends on how wide it is: the whole MIDI note range is spread across the jack, so a scale spanning an octave or two moves it by a tenth to a fifth of full scale rather than end to end. Turn RANGE to BI to double that swing, or use an attenuverter downstream to make a narrow scale reach further.",
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
      g1: "Channel 1's contact gate: high while the channel is touched or its recorded gesture is playing, low when it is idle, and RE-STRUCK once at the top of every loop repetition so a looping gesture articulates an envelope again each time round. The retrigger is a brief dip to zero and back rather than a level change, because the device streams a recorded gesture continuously and the level never falls by itself — without the dip a looping channel would be one endless held gate. Patch it into an envelope so a touch articulates as well as modulates. Note that the device transmits only one playhead, its first channel's, so the loop retrigger is driven from that: with clock-synchronised recording every channel shares the cycle and they all re-strike together, but channels running a different step count will re-strike at channel 1's rate rather than their own.",
      g2: "Channel 2's contact gate, high while that channel is active and re-struck at each loop repetition. See GATE 1 for how the loop retrigger works and what the device does and does not transmit.",
      g3: "Channel 3's contact gate, high while that channel is active and re-struck at each loop repetition. See GATE 1 for how the loop retrigger works and what the device does and does not transmit.",
      g4: "Channel 4's contact gate, high while that channel is active and re-struck at each loop repetition. See GATE 1 for how the loop retrigger works and what the device does and does not transmit.",
      clock:
        "A pulse train derived from the MIDI clock the device transmits, divided by the CLOCK DIV setting — at the default 24 that is one pulse per quarter note, the division TIMELORDE expects. It is a trigger: each pulse is a short fixed-width rising edge and the level between pulses carries no meaning. Silent until the device's transport is running.",
    },
    controls: {
      range:
        "Whether the eight X and Y jacks emit the pad's own coordinates or a bipolar signal centred on the middle of the pad. UNI is 0..1 and is the default because a touch position is a COORDINATE: the pad's bottom-left is (0, 0) and its top-right is (1, 1), which is the space a screen and an absolute-position CV input already speak, so a 1:1 mapping lands the picture where your finger physically is. BI is −1..+1 with the centre of the pad at 0, which is what a destination that modulates around its own knob setting wants. It changes what the jacks emit, never what the pad view shows — the view always mirrors the physical surface.",
      smooth:
        "How lazily the X and Y jacks follow the device. At 0 each arriving sample steps the jack immediately, which is what a 1:1 screen mapping wants; turning it up makes the jack glide exponentially toward each new sample instead, covering about two thirds of the distance in the time the knob sets, up to a quarter of a second at the far end. Use it to turn a jittery fingertip or a coarse stream into a smooth sweep, and accept that the jack then trails the hand that made the gesture. It does not affect the gates or the clock, which must stay sharp.",
      divisor:
        "How many of the device's MIDI clock ticks make one pulse on the CLOCK jack. MIDI runs at a fixed 24 pulses per quarter note, so 24 is one pulse per quarter (patch it into TIMELORDE's clock to slave the rack to the device's transport), 12 is eighths, 6 sixteenths, 3 thirty-seconds, and RAW passes every incoming tick. Only divisions that divide 24 evenly are offered, because any other lands on no note value and drifts against every other clock in the rack.",
    },
  },

  // ⚠ NO `face` — a DELIBERATE non-promotion, recorded in
  // FACE_MIGRATION_INVENTORY as `bespoke-surface`. The three knobs are the only
  // generic-face material this module has; the two things that make it usable
  // are the CONNECT gesture and the live pad mirror, and both are WebMIDI
  // service state rather than params. The ptzcam / chromaconsole disposition,
  // for the same reason, and the same one the joystick's own header states: a
  // pad is not a lane control, and a face whose ranked cells are three knobs
  // would move the knobs and leave the pad behind.
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
    }
    makeSource(TRAILS_CLOCK_PORT_ID);

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
      },
    };

    return {
      domain: 'audio',
      inputs: new Map(),
      outputs: new Map(
        [...sources.entries()].map(([id, src]) => [id, { node: src as AudioNode, output: 0 }]),
      ),
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
