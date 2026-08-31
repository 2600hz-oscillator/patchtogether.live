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
//   g1..g4 (gate): the four channels' contact gates.
//   clock (gate): a divided pulse train from the device's MIDI clock.
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

// ── Card-visible state ──────────────────────────────────────────────────────

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
}

export interface TrailsCardApi {
  /** Gesture-gated. Never throws; true only when a Trails port is attached. */
  connect(): Promise<boolean>;
  status(): TrailsStatus;
  state(): TrailsState;
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
      "The Bela TRAILS eurorack module, read straight into the rack over its USB-C port. Trails is a quad touch-gesture recorder: an 85 by 85 mm multitouch pad whose four channels each record a finger gesture, loop it, and keep emitting an X position, a Y position and a contact gate long after you have taken your hand away. This module receives all of that as MIDI and hands it to the patch as twelve modulation jacks plus a clock. Mental model: your finger is a modulation source, and once you lift it the gesture keeps performing itself. The pad view on the card mirrors the physical surface one to one — up to four coloured touch points with fading trails, in the same coordinates the jacks emit — so you can see what the rack is receiving without looking down at the hardware. RANGE picks whether the X and Y jacks are the pad's own 0..1 coordinates (the default, so patching X into a video module's horizontal position puts the picture where your finger is) or bipolar around the pad's centre. SMOOTH glides the X and Y jacks toward each new sample instead of stepping, which turns a jittery fingertip into a sweep at the cost of trailing the hand. CLOCK DIV divides the device's own MIDI clock into a pulse train, so a recorded gesture and the rack can share a tempo. Nothing is streamed into the saved patch: the touch data is live engine state, so a gesture never bloats the document or reaches collaborators. Connecting asks the browser for MIDI permission when you press CONNECT and not before, so loading a patch that contains this module never raises a prompt. There is no MIDI back to the device — Trails takes its clock and reset as CV on its own jacks, so to slave it to the rack, patch a clock out of CV BUDDY into the module's clock input.",
    inputs: {},
    outputs: {
      x1: "Channel 1's horizontal pad position. 0 is the left edge of the pad and 1 the right, or −1..+1 about the centre when RANGE is BI. It keeps streaming while a recorded gesture plays back, and holds its last value when the channel is idle.",
      y1: "Channel 1's vertical pad position, 0 at the bottom edge through 1 at the top (or −1..+1 when RANGE is BI). Pair it with X1 to drive a two-axis destination from one finger.",
      x2: "Channel 2's horizontal pad position, in the same coordinates as X1.",
      y2: "Channel 2's vertical pad position, in the same coordinates as Y1.",
      x3: "Channel 3's horizontal pad position, in the same coordinates as X1.",
      y3: "Channel 3's vertical pad position, in the same coordinates as Y1.",
      x4: "Channel 4's horizontal pad position, in the same coordinates as X1.",
      y4: "Channel 4's vertical pad position, in the same coordinates as Y1.",
      g1: "Channel 1's contact gate: high while the channel is touched or its recorded gesture is playing, low when it is idle. Patch it into an envelope so a touch articulates as well as modulates.",
      g2: "Channel 2's contact gate, high while that channel is active.",
      g3: "Channel 3's contact gate, high while that channel is active.",
      g4: "Channel 4's contact gate, high while that channel is active.",
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

    // ── Scheduling ────────────────────────────────────────────────────────
    const scheduler = createMidiScheduler(ctx);
    const decoder = createTrailsDecoder();
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
          if (state) {
            state.gate = ev.high;
            // A gate falling ends the gesture; clearing the trail is what makes
            // the next touch read as a NEW stroke rather than as a jump.
            if (!ev.high) state.trail.length = 0;
          }
          writeGate(trailsGatePortId(ev.channel), ev.high, at);
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
          if (ev.reset) tickCounter = 0;
          if (!ev.running) writeGate(TRAILS_CLOCK_PORT_ID, false, at);
        }
      }
    }

    const unsubscribeMidi = subscribeTrailsMidi((mev) => {
      try {
        const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
        const events = decoder.handle(mev.data, nowMs);
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
          applyEvents(events, ctx.currentTime + GATE_PULSE_S);
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
      };
    }

    const cardApi: TrailsCardApi = {
      connect: () => connectTrails(),
      status: trailsStatus,
      state: snapshot,
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
