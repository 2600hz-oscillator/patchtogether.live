// packages/web/src/lib/midi/trails-decode.ts
//
// THE BELA TRAILS WIRE DECODER — pure, DOM-free, clock-injected.
//
// Trails is a quad touch-gesture recorder: a 85 × 85 mm multitouch pad whose
// four channels each record a gesture, loop it, and emit X, Y and a gate
// continuously. Over its class-compliant USB-MIDI port that state arrives as
// 14-bit Control Change per axis, one MIDI channel per axis, plus MIDI clock.
//
// EVERYTHING THIS FILE ENCODES ABOUT THE WIRE IS A NAMED CONSTANT, on purpose:
// a correction after a hardware session is a one-line edit here, not a rewrite
// anywhere, and the unit suite pins the decode against golden byte vectors
// spelled as literals so a moved constant goes RED rather than quietly agreeing
// with itself.
//
// ── WHAT THE DEVICE TRANSMITS, EXHAUSTIVELY (manual + quick reference, read
//    2026-08-31) ────────────────────────────────────────────────────────────
//
//   X and Y, and nothing else.  The manual's MIDI mapping table has exactly
//   EIGHT rows — 1.X … 4.Y on MIDI channels 1–8, each "Note or CC15 (MSB) +
//   CC37 (LSB)" — and the quick reference states the transmit set in one
//   sentence: "Each X and Y output transmits over its own channel, available
//   via USB-C on the rear of the module for USB MIDI Plug and Play".
//
//   NOT the gate.   It is absent from the MIDI section entirely; it exists only
//                   as the four physical gate-out jacks. Everything this file
//                   calls a "gate" is therefore INFERRED from the axis stream
//                   (or from notes) — see TRAILS_ACTIVITY_GATE_TIMEOUT_MS.
//   NOT the Bar.    The 10 × 85 mm capacitive strip is an assignable modifier of
//                   INTERNAL functions — quick reference: "In INPUT it can be
//                   assigned to Step Density, Gate Width, Smoothing, Volume or
//                   Portamento", waveshaping in ADAPT, "Start/End … Speed …
//                   Nudge" in METER. It has no MIDI message AND no output jack,
//                   so there is nothing for this decoder to decode and nothing
//                   an ES-9 could capture either. Its effect reaches us only
//                   indirectly, in the shape of the X/Y/gate it modifies.
//   Notes are the AXES, not an articulation. Quick reference: "When both pitch
//                   and temporal quantisation are enabled, Trails transmits MIDI
//                   Notes. Otherwise it sends high-resolution MIDI CC." Same two
//                   axes, quantised to a scale — so in the ordinary mode NO note
//                   is ever sent, and in note mode NO CC is.
//                   ⚠ THE SECOND HALF OF THAT SENTENCE IS LOAD-BEARING and was
//                   read and then not acted on: because note mode REPLACES the
//                   CC stream, a note branch that only kept a gate froze every
//                   X/Y jack at its last CC value the moment a player enabled
//                   quantisation. The note branch now drives the axes through
//                   the same `emitAxis` seam — see TRAILS_NOTE_AXIS_RANGE.
//   Transport.      "MIDI System Realtime Clock and Start messages are sent,
//                   based on the clock and playhead position of the first
//                   channel of Trails", and "A Start message is sent every time
//                   the playhead restarts from the beginning of the track."
//                   THAT is the loop repetition, once per repetition.
//
// ⚠ NO Y.DOC, NO ENGINE, NO WINDOW. This module returns plain events; the
// module factory is the only thing that turns them into ConstantSource writes,
// which is what keeps a 100–250 msg/s touch stream out of the synced store
// (the cv-modulation write-storm law).

/** Trails' four channels, as the front panel numbers them. */
export const TRAILS_CHANNEL_COUNT = 4;
export type TrailsChannel = 1 | 2 | 3 | 4;
export type TrailsAxis = 'x' | 'y';

/** Full-scale of a 14-bit CC (2^14 − 1). The value the wire can reach, not a
 *  choice — used to normalise into the 0..1 unit range every axis event
 *  carries. */
export const TRAILS_CC_FULL_SCALE = 16383;

/**
 * The 14-bit CC pair each axis streams on.
 *
 * ⚠ HARDWARE-VERIFY ITEM #1, AND THE MOST LIKELY THING TO BE WRONG. The Trails
 * manual states CC15 (MSB) + CC37 (LSB). That pairing is NOT the MIDI
 * convention: the spec pairs a coarse controller `n` (0..31) with its fine
 * partner `n + 32`, so CC15's documented partner is CC47, and CC37 is the fine
 * partner of CC5. One of the two numbers in the manual is therefore either a
 * typo or a deliberate firmware choice, and no public Trails firmware source
 * exists to settle it (Gliss's is GPL; Trails' is not published yet).
 *
 * Both numbers live HERE and nowhere else. `createTrailsDecoder` takes the pair
 * as an option, the simulated device builds its bytes from it, and the golden
 * vectors in the unit suite are derived from it — so if a MIDI monitor on real
 * hardware shows CC15 + CC47, correcting this object corrects the decoder, the
 * double and every test in one edit.
 */
export interface TrailsCcPair {
  /** Controller number carrying the coarse (high 7 bits) half. */
  readonly msb: number;
  /** Controller number carrying the fine (low 7 bits) half. */
  readonly lsb: number;
}
export const TRAILS_CC_PAIR: TrailsCcPair = { msb: 15, lsb: 37 };

/** One axis of one channel — what a MIDI channel resolves to. */
export interface TrailsAxisRef {
  readonly channel: TrailsChannel;
  readonly axis: TrailsAxis;
}

/**
 * MIDI channel (0-based wire nibble) → which axis it carries.
 *
 * ⚠ HARDWARE-VERIFY ITEM #2. The manual says "each of the 8 axes transmits on
 * its own MIDI channel (1–8)" without printing the assignment table, so the
 * ORDER below is the natural reading — channel-major, X before Y — and not a
 * quoted fact. Wire channel 0 (printed "1") is channel 1's X, wire channel 1 is
 * channel 1's Y, and so on through wire channel 7 = channel 4's Y.
 *
 * A monitor session that shows a different order is a one-line edit to this
 * table; nothing downstream re-derives it.
 */
export const TRAILS_AXIS_MAP: readonly TrailsAxisRef[] = Array.from(
  { length: TRAILS_CHANNEL_COUNT * 2 },
  (_, wireChannel): TrailsAxisRef => ({
    channel: ((wireChannel >> 1) + 1) as TrailsChannel,
    axis: wireChannel % 2 === 0 ? 'x' : 'y',
  }),
);

/**
 * How long an axis stream may go quiet before the ACTIVITY gate falls.
 *
 * ── WHAT THE MANUAL ACTUALLY SETTLES (read 2026-08-31) ──────────────────────
 *
 * The ambiguity this constant was written to survive is RESOLVED, and not in
 * this constant's favour. Two documented facts decide it:
 *
 *   1. The manual's MIDI mapping table has exactly EIGHT rows — 1.X … 4.Y on
 *      MIDI channels 1–8 — and the quick reference states the transmit set as
 *      "Each X and Y output transmits over its own channel". THE GATE IS NOT A
 *      MIDI MESSAGE. It exists only as the four physical gate-out jacks.
 *   2. Notes are not a gate either. The quick reference: "When both pitch and
 *      temporal quantisation are enabled, Trails transmits MIDI Notes.
 *      Otherwise it sends high-resolution MIDI CC." Notes are an ALTERNATIVE
 *      ENCODING OF THE SAME TWO AXES, quantised to a scale — not a separate
 *      articulation stream. In the device's ordinary mode no note is ever sent,
 *      so `sawNote` stays false forever and every gate comes from HERE.
 *
 * So this timeout is not a fallback any more — in the default mode it is the
 * only contact signal there is, and it can only ever say one thing: "the axis
 * stream is flowing" / "the axis stream stopped". That is a faithful model of
 * exactly one half of the hardware gate, whose documented behaviour is:
 *
 *   "The GATE output produces a trigger whenever the gesture returns to the
 *    start of its loop or after each silent section in the recording."
 *
 * The "after each silent section" half IS a gap in the CC stream, and this
 * timeout catches it. ⚠ THE "RETURNS TO THE START OF ITS LOOP" HALF IS NOT A
 * GAP — it is a value discontinuity in a stream that never stops — so no
 * activity timeout, at any value, can ever produce one gate per loop
 * repetition. That is what `TRAILS_LOOP_PLAYHEAD_CHANNEL` below is for.
 *
 * The note path is KEPT because it is still the best available contact signal
 * when the device IS in note mode (a held note means that axis is sounding),
 * and it costs nothing when no note ever arrives.
 *
 * 120 ms is chosen to sit well above any plausible inter-message gap in a live
 * stream (even a 20 Hz axis update is 50 ms apart) and well below the point a
 * player would call a held gate "stuck". The real stream rate is still a
 * hardware-verify item; if it turns out to be slower than ~8 Hz this needs to
 * grow, and the MON readout on the card is how to measure it.
 */
export const TRAILS_ACTIVITY_GATE_TIMEOUT_MS = 120;

/**
 * The channel whose playhead the device's MIDI transport reports.
 *
 * ⚠ THIS IS THE FIX FOR "THE GATE DOESN'T FIRE EVERY LOOP", and it is a quoted
 * fact rather than an inference. The manual:
 *
 *   "MIDI System Realtime Clock and Start messages are sent, based on the clock
 *    and playhead position of the FIRST CHANNEL of Trails."
 *   "A Start message is sent every time the playhead restarts from the
 *    beginning of the track."
 *
 * So the loop repetition IS on the wire, once per repetition, as plain MIDI
 * Start (0xFA) — the module was decoding it and then spending it on nothing but
 * re-zeroing the clock divider. A Start is now ALSO a gate retrigger.
 *
 * ⚠ AND THE LIMIT, STATED: there is ONE playhead on the wire, channel 1's. A
 * per-channel loop restart for channels 2–4 is NOT observable over USB-MIDI,
 * and nothing in this file can invent one. See TRAILS_LOOP_RETRIGGER_SCOPE for
 * how far the single message is allowed to reach.
 */
export const TRAILS_LOOP_PLAYHEAD_CHANNEL: TrailsChannel = 1;

/**
 * How far one Start message reaches.
 *
 *   'first'  — retrigger ONLY channel 1's gate. Strictly what the message
 *              asserts, and nothing more.
 *   'active' — retrigger every channel whose gate is currently high (DEFAULT).
 *
 * 'active' is the default and it is an INFERENCE, flagged as one. Its warrant is
 * the quick reference's recording rule: "With a clock, recording begins and ends
 * on cycle, so loops always remain synchronised." When the loops are
 * synchronised, channel 1's playhead restarting IS every playing channel's
 * playhead restarting, so reaching them all is right and reaching only channel 1
 * would leave a player watching gate 2 with no gate at all. When they are NOT
 * synchronised — different step counts per channel, the manual's "polyrhythms"
 * and "polymeters" — this over-fires channels 2–4 at channel 1's rate.
 *
 * One word, one line, one edit: a player working in polymeter sets 'first'.
 */
export const TRAILS_LOOP_RETRIGGER_SCOPE: 'first' | 'active' = 'active';

/**
 * The velocity Trails puts on every note-on. MEASURED ON HARDWARE, NOT INFERRED.
 *
 * ⚠ THE QUESTION IS SETTLED AND THE ANSWER IS "NO TOUCH FORCE". The manual never
 * uses the word "velocity", so this was an open hardware item — and the fixed
 * MON readout answered it in one paste (owner, 2026-09-01, note mode, 12643
 * messages across a full gesture session): EVERY note row, on every axis and
 * every channel, read `vel=127`.
 *
 *   ch4 NOTE 71  x514  vel=127      ch4 NOTE 56  x240  vel=127
 *   ch3 NOTE 63  x336  vel=127      ch4 NOTE 77  x226  vel=127
 *   ch3 NOTE 99  x294  vel=127      ch3 NOTE 83  x204  vel=127
 *
 * A constant across 500+ strikes on one row is not a pad that happened to be
 * pressed identically each time; it is a firmware that does not transmit force.
 *
 * CONSEQUENCE, STATED SO NOBODY RE-OPENS IT: there is no touch-size data on the
 * wire, so a velocity-derived output would be a jack that can never carry
 * information — the same mistake the absent `bar` output is documented to avoid.
 * Do not build one. This constant exists so the simulated device sends what the
 * hardware sends, and so a firmware that later DOES vary velocity shows up as a
 * disagreement with a number that has a citation.
 */
export const TRAILS_NOTE_VELOCITY = 127;

/** The window of MIDI note numbers one axis's 0..1 travel is spread across. */
export interface TrailsNoteRange {
  /** The note that reads 0.0 (and everything below it). */
  readonly lo: number;
  /** The note that reads 1.0 (and everything above it). */
  readonly hi: number;
}

/**
 * NOTE MODE: which note numbers map onto an axis's 0..1 travel.
 *
 * ── THE BUG THIS CONSTANT EXISTS TO FIX ─────────────────────────────────────
 *
 * Trails transmits EITHER high-resolution 14-bit CC OR MIDI Notes, never both.
 * The quick reference: "When both pitch and temporal quantisation are enabled,
 * Trails transmits MIDI Notes. Otherwise it sends high-resolution MIDI CC." The
 * notes are the SAME TWO AXES re-encoded and quantised to a scale, on the SAME
 * per-axis MIDI channels — not a separate articulation stream.
 *
 * So the instant a player enables pitch quantisation (hold SCALE, tap a
 * channel) the CC stream for that channel STOPS. A note branch that only
 * maintained `held` and emitted a gate therefore left the channel's X and Y
 * jacks frozen at their last CC value, forever, and every touch produced the
 * same held pitch downstream. Owner, on hardware: "when i hit scale i am just
 * getting one continuous note output even when i select other notes in the
 * scale."
 *
 * ── WHY THE MAPPING IS LINEAR IN THE NOTE NUMBER (AND ALREADY V/OCT-SHAPED) ──
 *
 * `unit = (note − lo) / (hi − lo)`, clamped. A MIDI note number is linear in
 * SEMITONES, and so is a volt-per-octave control voltage — so this mapping IS
 * V/oct-shaped, exponential in frequency; the only thing a "proper" V/oct
 * treatment would change is the constant of proportionality, which is exactly
 * what the window below sets.
 *
 * And there is no volts-per-octave alternative available to choose in this
 * rack. `docs/adr/004-cv-range-convention.md` fixes the `cv` cable as a
 * NORMALISED modulation amount that `cv-scale` sweeps a destination param with;
 * it is not a pitch bus. This module deliberately declares `cv` rather than
 * `pitch` outputs so a touch position stays off the note lane (see the module
 * header's "WHY EVERY OUTPUT IS cv OR gate"). A jack emitting 5.0 for note 60
 * would be clamped flat by every destination in the tree.
 *
 * So the whole decision is the WINDOW, and it is this one line:
 *
 *   { lo: 0,  hi: 127 }  DEFAULT — the full MIDI note range. One semitone moves
 *                        the jack by 1/127 = 0.0079.
 *   { lo: 0,  hi: 120 }  Exactly ten octaves across full scale = 0.1 per
 *                        octave: the 1 V/oct shape, if full scale is read as
 *                        10 V. Pick it to calibrate a destination in octaves.
 *   { lo: 60, hi: 96 }   Three octaves — 3.5× the default's resolution, at the
 *                        cost of clamping anything outside the window.
 *
 * ⚠ WHAT IS DOCUMENTED AND WHAT IS INFERRED. DOCUMENTED: that note mode
 * replaces CC mode, and that each axis keeps its own MIDI channel. NOT
 * DOCUMENTED, anywhere: the note range the pad spans. The manual prints no low
 * note, no high note and no scale roster. The default above is therefore chosen
 * to be RANGE-SAFE rather than range-optimal — 0..127 is the only span the wire
 * itself guarantees, so nothing this decoder emits can ever be clipped by a
 * guess about the firmware.
 *
 * The one MEASUREMENT that exists is a single owner MON capture (2026-09-01,
 * note mode, both quantisations enabled): notes 77, 80, 82, 88, 89 arriving on
 * the axis printed ch1 and 81, 83, 89, 93 on ch2 — a ~16-semitone spread. Under
 * the default window that swings the jack 16/127 ≈ 0.126 of full scale (≈ 0.25
 * in BI). That is real movement where there was none; it is also the number to
 * look at if the owner wants more travel, and narrowing `hi − lo` to the span a
 * scale actually uses is this one edit.
 */
export const TRAILS_NOTE_AXIS_RANGE: TrailsNoteRange = { lo: 0, hi: 127 };

/**
 * One note number as a 14-bit axis value, so note mode and CC mode land in the
 * SAME units and travel the SAME seam.
 *
 * Exported because the simulated device and the golden vectors both need it,
 * and because a hardware session that wants to re-scale the axis should be able
 * to see this function's output move with the constant above.
 */
export function trailsNoteToValue14(
  note: number,
  range: TrailsNoteRange = TRAILS_NOTE_AXIS_RANGE,
): number {
  // A degenerate window has no travel to spread anything across; holding at the
  // bottom of the jack is the honest answer, and it cannot divide by zero.
  if (!(range.hi > range.lo)) return 0;
  const clampedNote = Math.max(range.lo, Math.min(range.hi, note));
  const t = (clampedNote - range.lo) / (range.hi - range.lo);
  return Math.round(t * TRAILS_CC_FULL_SCALE);
}

// ── MIDI status bytes we care about ─────────────────────────────────────────
const STATUS_NOTE_OFF = 0x80;
const STATUS_NOTE_ON = 0x90;
const STATUS_CC = 0xb0;
const STATUS_CLOCK = 0xf8;
const STATUS_START = 0xfa;
const STATUS_CONTINUE = 0xfb;
const STATUS_STOP = 0xfc;

/** What the decoder emits. Deliberately a flat union of plain data — the
 *  factory pattern-matches it; nothing here knows about Web Audio. */
export type TrailsEvent =
  | {
      kind: 'axis';
      channel: TrailsChannel;
      axis: TrailsAxis;
      /** Raw assembled 14-bit value, 0..16383. */
      value14: number;
      /** `value14 / TRAILS_CC_FULL_SCALE` — 0..1, the pad's own coordinate. */
      unit: number;
    }
  | {
      kind: 'gate';
      channel: TrailsChannel;
      high: boolean;
      /**
       * Which mechanism produced this edge.
       *
       * `'loop'` is special and a consumer MUST treat it as such: it is always
       * `high: true`, and it means "the playhead restarted" — which is a fresh
       * gate event EVEN IF THE GATE WAS ALREADY HIGH. A consumer that only
       * looks at `high` will see no change and drop it on the floor, which is
       * precisely the bug this field exists to make impossible: during loop
       * playback the axis stream never stops, so the level never falls, so a
       * level-only consumer never sees a new loop. The factory answers a
       * `'loop'` edge with a RETRIGGER NOTCH — low, then high — so the rising
       * edge is real on the wire the rack actually reads.
       */
      source: 'note' | 'activity' | 'loop';
    }
  /**
   * A NOTE-MODE strike or release, per AXIS — the quantised pitch itself.
   *
   * ⚠ THIS IS NOT A SECOND PARSER, and the distinction matters. One note
   * message is two facts, exactly as one CC message is: where the axis IS
   * (`axis`) and whether it is sounding (`gate`). A note carries a third that a
   * CC simply does not have — WHICH PITCH — and that is the only thing this
   * event adds. It rides the same branch, in the same order, and CC mode never
   * produces one, which is what makes the poly outputs silent in CC mode by
   * construction rather than by a mode flag someone has to remember to check.
   *
   * PER AXIS, not per channel, because the poly bus is per-axis: one Trails
   * channel's X and Y are two independent voices on two lanes. The `gate` event
   * beside this one is the channel-level OR of the two, which is what the
   * single-jack gate outputs need.
   */
  | {
      kind: 'note';
      channel: TrailsChannel;
      axis: TrailsAxis;
      /** The MIDI note number this message carried. */
      note: number;
      /** Was this a STRIKE (true) or a release (false)? Pitch is written on a
       *  strike only — last-note priority, matching the axis path. */
      on: boolean;
      /** Is this AXIS still holding any note after the message? The level a
       *  poly lane's gate should sit at. */
      sounding: boolean;
    }
  /**
   * ONE ARTICULATION on a channel — the thing a drum voice fires from.
   *
   * ⚠ WHY THIS EXISTS AS A SEPARATE FACT FROM `gate`. The `gate` event is a
   * LEVEL: "is this channel sounding". That is the right answer to a different
   * question, and during a real gesture it is USELESS FOR TRIGGERING, because
   * the two axes are quantised INDEPENDENTLY — X crosses a scale boundary when
   * the finger's horizontal position does, Y when its vertical position does,
   * and those moments essentially never coincide. So the channel-level OR of
   * the two goes high at the first touch and stays high for the whole gesture.
   * Measured on the decoder: an interleaved gesture of ten note messages
   * produces exactly ONE rising edge, so a downstream kick fires once and then
   * never again. That is the owner's report.
   *
   * A trigger is therefore not a re-labelling of the gate; it is the fact the
   * gate cannot carry.
   *
   *   'step'    — note mode: the channel advanced to a new step.
   *   'contact' — CC mode: the axis stream started after silence. The only
   *               articulation CC mode puts on the wire (see below).
   *   'loop'    — the playhead restarted (MIDI Start), in either mode.
   *
   * ⚠ CC MODE IS STRICTLY POORER AND THAT IS A PROPERTY OF THE WIRE. In note
   * mode a Note On IS the articulation, so 'step' is exact. In CC mode the
   * device transmits X and Y and nothing else — its step gate is not a MIDI
   * message at all (the manual's MIDI table is eight rows of X/Y) — so all that
   * can honestly be produced is 'contact' and 'loop'. There is no value of any
   * constant that would recover per-step triggers from a continuous CC stream,
   * and this file will not pretend otherwise.
   */
  | {
      kind: 'trigger';
      channel: TrailsChannel;
      source: 'step' | 'contact' | 'loop';
    }
  /** One MIDI clock tick (0xF8). MIDI is fixed at 24 of these per quarter. */
  | { kind: 'clock' }
  /** Transport moved. `reset` is true for Start (0xFA) and false for Continue
   *  (0xFB) — Continue resumes without re-zeroing a divider, exactly as
   *  MIDICLOCK treats it. */
  | { kind: 'transport'; running: boolean; reset: boolean };

export interface TrailsDecoderOptions {
  ccPair?: TrailsCcPair;
  axisMap?: readonly TrailsAxisRef[];
  activityGateTimeoutMs?: number;
  loopRetriggerScope?: 'first' | 'active';
  /** See TRAILS_NOTE_AXIS_RANGE. Injected so a test can pin the mapping shape
   *  without depending on whatever the shipped window happens to be. */
  noteRange?: TrailsNoteRange;
}

/** What `handleFrame` reports about one message. */
export interface TrailsFrameResult {
  readonly events: TrailsEvent[];
  /**
   * Did this decoder UNDERSTAND the frame — independent of whether it produced
   * an event?
   *
   * ⚠ THE TWO ARE NOT THE SAME, and conflating them is what makes a diagnostic
   * lie. Several frames are fully understood and deliberately emit nothing: a
   * second note-on while one is already held (the level did not change), an LSB
   * that arrives before its axis has ever sent an MSB, an Active Sense byte we
   * knowingly ignore. Reporting "no event" as "not recognised" would flag all
   * of those on healthy hardware and print advice to go and change the CC pair —
   * the exact misdiagnosis the monitor exists to prevent.
   */
  readonly recognised: boolean;
}

export interface TrailsDecoder {
  /**
   * Feed one MIDI message. `nowMs` is the arrival time on the SAME clock the
   * caller later passes to `tick` (`performance.now()` in the app, a counter in
   * a test) — injected rather than read so the activity gate is testable
   * without waiting for wall-clock time.
   */
  handle(data: ArrayLike<number>, nowMs: number): TrailsEvent[];
  /** `handle`, plus the recognition verdict the MIDI monitor needs. */
  handleFrame(data: ArrayLike<number>, nowMs: number): TrailsFrameResult;
  /** Age the activity gates. Returns the falling edges that are now due. */
  tick(nowMs: number): TrailsEvent[];
  /** Forget all assembled halves, held notes and gate levels. */
  reset(): void;
}

interface ChannelState {
  /** Last coarse half seen for each axis, or null before the first one. */
  msb: { x: number | null; y: number | null };
  /** Last fine half seen for each axis. Starts at 0 — the value an MSB-only
   *  device implies. */
  lsb: { x: number; y: number };
  /**
   * MIDI notes currently held, PER AXIS.
   *
   * ⚠ SPLIT BY AXIS, AND THE SPLIT IS A BUG FIX. One Trails channel occupies
   * TWO MIDI channels — its X and its Y — and this state is keyed by the TRAILS
   * channel, so both axes' notes used to land in one `Set<number>`. A `Set`
   * DEDUPLICATES, so the moment X and Y quantised to the SAME note number
   * (routine: any gesture on the pad's diagonal, or any scale coarse enough
   * that both coordinates land on one degree) the two strikes collapsed into a
   * single entry — and releasing X emptied the set and DROPPED THE CHANNEL'S
   * GATE while Y was still sounding. Worse, Y's own release then found nothing
   * to delete and computed no level change, so it emitted nothing and the gate
   * stayed low until the next strike.
   *
   * Reproduced before the fix, on the exact shape the owner's hardware sends:
   *   0x92 71 127 (ch2 X) -> gate HIGH
   *   0x93 71 127 (ch2 Y) -> no event, correct: the channel is already sounding
   *   0x92 71 0   (release X, Y STILL HELD) -> gate LOW   <- the defect
   *
   * With the sets split, "is this channel sounding" is the OR of its two axes,
   * which is what a contact gate means and what the CC-mode activity path has
   * always computed.
   */
  held: { x: Set<number>; y: Set<number> };
  /**
   * Has EITHER axis let go since this channel last fired a step trigger?
   *
   * ⚠ THE WHOLE STEP RULE, AND IT IS DELIBERATELY TIME-FREE. One step of a
   * temporally-quantised gesture puts TWO note-ons on the wire — X and Y are
   * separate MIDI channels — so a trigger per note-on would flam a kick on
   * every step. The obvious fix is a coalescing time window, and it is the
   * wrong one: it needs a magic millisecond value wedged between USB packet
   * jitter and the shortest musical step, and it decides a musical question
   * with a timer.
   *
   * This decides it with the stream instead. A note-on fires a step trigger
   * only when the channel has seen a RELEASE since its last one (or was silent
   * altogether). Both axes releasing and re-striking is one step: the first
   * strike consumes the flag and the second finds it already spent. Two axes
   * moving at different moments is two steps, and honestly so — they are two
   * quantiser steps.
   *
   * ⚠ THE ASSUMPTION, STATED: the device sends a release for every note. That
   * is MEASURED, not hoped — the owner's MON capture shows note-on rows with
   * velocity 0, the running-status release, and no bare 0x80 rows. A firmware
   * that played legato (a new note-on with no release) would advance the step
   * without setting this flag and would need the alternative rule.
   */
  releasedSinceTrigger: boolean;
  /** Has this channel EVER produced a note? Once true the activity path is
   *  permanently off for it — see TRAILS_ACTIVITY_GATE_TIMEOUT_MS. */
  sawNote: boolean;
  /** Arrival time of the most recent axis message. */
  lastAxisMs: number;
  gateHigh: boolean;
}

function newChannelState(): ChannelState {
  return {
    msb: { x: null, y: null },
    lsb: { x: 0, y: 0 },
    held: { x: new Set<number>(), y: new Set<number>() },
    releasedSinceTrigger: false,
    sawNote: false,
    lastAxisMs: Number.NEGATIVE_INFINITY,
    gateHigh: false,
  };
}

/**
 * Build a decoder.
 *
 * ── THE 14-BIT ASSEMBLY RULE, STATED ────────────────────────────────────────
 *
 * Per MIDI channel we keep the LATEST coarse half and the LATEST fine half, and
 * we emit on EITHER arriving (once a coarse half has ever been seen). That is
 * deliberately not the textbook "MSB latches, LSB completes" state machine, and
 * the difference is the whole robustness story:
 *
 *   * MSB-ONLY streams work. A device that only ever sends the coarse half
 *     still moves the output — the fine half stays at its last value, which
 *     costs at most 127/16383 = 0.8 % of full scale, once.
 *   * OUT-OF-ORDER pairs converge. Whether the fine half arrives before or
 *     after its partner, the value after both have landed is identical, because
 *     the state is two independent latches rather than an ordered handshake.
 *     (A strict handshake emits nothing at all on an LSB-first pair and then
 *     emits a coarse-only value on the MSB — worse in both directions.)
 *   * A LEADING FINE HALF, before any coarse half has ever arrived, emits
 *     NOTHING. Guessing a coarse half would put the touch at the left edge of
 *     the pad for one frame, which reads as a real gesture.
 *
 * The cost is that a device which uses the MSB to mean "reset the LSB to zero"
 * would read 0.8 % high for one message after a coarse-only move. That is
 * inside the pad's own noise floor and is called out here so a hardware session
 * can decide whether it is worth the stricter machine.
 */
export function createTrailsDecoder(opts: TrailsDecoderOptions = {}): TrailsDecoder {
  const ccPair = opts.ccPair ?? TRAILS_CC_PAIR;
  const axisMap = opts.axisMap ?? TRAILS_AXIS_MAP;
  const activityTimeoutMs = opts.activityGateTimeoutMs ?? TRAILS_ACTIVITY_GATE_TIMEOUT_MS;
  const loopScope = opts.loopRetriggerScope ?? TRAILS_LOOP_RETRIGGER_SCOPE;
  const noteRange = opts.noteRange ?? TRAILS_NOTE_AXIS_RANGE;

  const channels = new Map<TrailsChannel, ChannelState>();
  function stateFor(channel: TrailsChannel): ChannelState {
    let s = channels.get(channel);
    if (!s) {
      s = newChannelState();
      channels.set(channel, s);
    }
    return s;
  }

  function axisFor(wireChannel: number): TrailsAxisRef | undefined {
    return axisMap[wireChannel];
  }

  function emitAxis(ref: TrailsAxisRef, s: ChannelState, out: TrailsEvent[]): void {
    const msb = s.msb[ref.axis];
    if (msb === null) return; // fine half with no coarse partner yet — see header
    const value14 = Math.max(0, Math.min(TRAILS_CC_FULL_SCALE, (msb << 7) | s.lsb[ref.axis]));
    out.push({
      kind: 'axis',
      channel: ref.channel,
      axis: ref.axis,
      value14,
      unit: value14 / TRAILS_CC_FULL_SCALE,
    });
  }

  function raiseActivityGate(s: ChannelState, channel: TrailsChannel, out: TrailsEvent[]): void {
    if (s.sawNote || s.gateHigh) return;
    s.gateHigh = true;
    out.push({ kind: 'gate', channel, high: true, source: 'activity' });
    // ⚠ CC MODE'S ONLY ARTICULATION, and it is thin on purpose. The device
    // transmits X and Y and nothing else in this mode, so "the stream started
    // again after a gap" is the entire set of contact events that reach us.
    // The hardware's own per-step gate is not on the wire here at all.
    out.push({ kind: 'trigger', channel, source: 'contact' });
  }

  /**
   * THE LOOP RESTART. One MIDI Start = one repetition of the device's playhead,
   * so this emits one gate edge per repetition per channel in scope.
   *
   * ⚠ IT EMITS EVEN WHEN THE GATE IS ALREADY HIGH, and that is the whole point:
   * during playback the axis stream is continuous, so the level never falls and
   * a level-change-only emitter would emit nothing at all. The `'loop'` source
   * is the contract that tells the factory to cut a retrigger notch instead of
   * comparing levels.
   *
   * Note-mode channels are skipped: when the device sends notes, the notes are
   * already the articulation and a second mechanism would double-trigger.
   */
  function emitLoopRestart(nowMs: number, out: TrailsEvent[]): void {
    const targets: TrailsChannel[] = [];
    if (loopScope === 'active') {
      // ⚠ "HAS EVER STREAMED", NOT "IS HIGH RIGHT NOW". Selecting on the live
      // gate level looks equivalent and is not: the hardware gate also strikes
      // "after each silent section in the recording", so a recorded gesture
      // legitimately goes quiet mid-cycle and its activity gate falls. If a
      // Start landed during one of those silences, a gate-level filter found
      // NOTHING active, fell through to channel 1, and struck an empty jack
      // while the channel that actually restarted got nothing at all.
      //
      // A channel that has ever sent CC is a channel with a gesture on it,
      // which is the population a playhead restart is about.
      for (const [channel, s] of channels) {
        if (!s.sawNote && s.lastAxisMs > Number.NEGATIVE_INFINITY) targets.push(channel);
      }
      targets.sort((a, b) => a - b);
      // ⚠ AND NO FALLBACK HERE. With nothing recorded on any channel there is
      // no gesture to repeat, so striking channel 1 anyway would put a pulse
      // train on an empty jack for as long as the device's transport ran — a
      // gate that means nothing, which is the same mistake as an output that
      // can never carry data. Silence is the honest answer.
    } else {
      // 'first' — strictly what the message asserts, and the escape hatch for a
      // player in polymeter. It always speaks, because it always speaks for the
      // one playhead the device actually reports.
      targets.push(TRAILS_LOOP_PLAYHEAD_CHANNEL);
    }

    for (const channel of targets) {
      const s = stateFor(channel);
      if (s.sawNote) continue;
      s.gateHigh = true;
      // A restart IS activity. Without this the gate the restart just raised
      // could be dropped by the very next `tick()` — `lastAxisMs` would still
      // be whenever the CC stream last spoke, or −Infinity on a channel that
      // has never streamed at all.
      s.lastAxisMs = nowMs;
      out.push({ kind: 'gate', channel, high: true, source: 'loop' });
      // The manual, verbatim: "The GATE output produces a TRIGGER whenever the
      // gesture returns to the start of its loop". So a restart articulates in
      // BOTH modes, and the trigger jack is where that lands cleanly.
      out.push({ kind: 'trigger', channel, source: 'loop' });
    }
  }

  function handle(data: ArrayLike<number>, nowMs: number): TrailsEvent[] {
    const out: TrailsEvent[] = [];
    if (data.length < 1) return out;
    const status = data[0]! & 0xff;

    // System real-time (0xF8..0xFF) is broadcast — no channel nibble.
    if (status >= 0xf8) {
      if (status === STATUS_CLOCK) out.push({ kind: 'clock' });
      else if (status === STATUS_START) {
        out.push({ kind: 'transport', running: true, reset: true });
        // ⚠ ORDER MATTERS: the transport event re-zeroes the clock divider, the
        // loop event retriggers the gates. Both come from this one byte, and
        // before today only the first of them existed.
        emitLoopRestart(nowMs, out);
      } else if (status === STATUS_CONTINUE) out.push({ kind: 'transport', running: true, reset: false });
      else if (status === STATUS_STOP) out.push({ kind: 'transport', running: false, reset: false });
      return out;
    }

    const kind = status & 0xf0;
    const wireChannel = status & 0x0f;
    const ref = axisFor(wireChannel);
    if (!ref) return out; // a channel Trails does not use — ignore, never guess

    const s = stateFor(ref.channel);

    if (kind === STATUS_CC) {
      if (data.length < 3) return out;
      const controller = data[1]! & 0x7f;
      const value = data[2]! & 0x7f;
      if (controller === ccPair.msb) {
        s.msb[ref.axis] = value;
      } else if (controller === ccPair.lsb) {
        s.lsb[ref.axis] = value;
      } else {
        return out; // some other CC on a Trails channel — not ours
      }
      s.lastAxisMs = nowMs;
      emitAxis(ref, s, out);
      raiseActivityGate(s, ref.channel, out);
      return out;
    }

    if (kind === STATUS_NOTE_ON || kind === STATUS_NOTE_OFF) {
      if (data.length < 2) return out;
      const note = data[1]! & 0x7f;
      const velocity = data.length >= 3 ? data[2]! & 0x7f : 0;
      // Note-on with velocity 0 is the running-status note-off.
      const isOn = kind === STATUS_NOTE_ON && velocity > 0;
      // ⚠ COMPARE AGAINST THE LEVEL THE CONSUMER CURRENTLY SEES, captured
      // BEFORE the note path takes ownership of this channel.
      //
      // The previous shape zeroed `gateHigh` on the activity→note handover and
      // then compared the new level against that zero, which silently swallowed
      // one case: a channel whose gate was already HIGH and whose FIRST note
      // message is a note-off computed `false !== false` and emitted nothing —
      // leaving the jack stuck at 1 with no mechanism left to lower it, because
      // `tick()` skips note channels forever after. Comparing against the real
      // previous level makes the handover fall out for free: note-on while high
      // is still no edge, note-off while high is the falling edge that was lost.
      const wasHigh = s.gateHigh;
      const wasSounding = s.held.x.size > 0 || s.held.y.size > 0;
      s.sawNote = true;
      if (isOn) s.held[ref.axis].add(note);
      else s.held[ref.axis].delete(note);
      // A release ARMS the next step. See `releasedSinceTrigger`.
      if (!isOn) s.releasedSinceTrigger = true;

      // ⚠ THE NOTE IS THE AXIS. This is the whole fix, and it is deliberately
      // written as a WRITE INTO THE CC LATCHES followed by the ordinary
      // `emitAxis` rather than as a second emit path: the range param, the
      // smoothing, the per-channel axis mapping, the pad-mirror trail and the
      // `axisMessages` counter are all downstream of that one seam, and a
      // parallel emitter would have to re-earn every one of them.
      //
      // ON NOTE-ON ONLY, which is LAST-NOTE PRIORITY — the standard mono
      // behaviour. One axis carries one coordinate, so the device has no reason
      // to stack notes on a single axis channel; if one ever arrives, the newest
      // wins. A note-OFF deliberately moves nothing: the axis then HOLDS at its
      // last value, exactly as it does when a CC stream goes quiet (the `x1`
      // doc: "holds its last value when the channel is idle"), so releasing a
      // stacked note can never make the jack jump backwards.
      //
      // Writing the latches rather than overriding the emit also means a device
      // that switches BACK to CC mode resumes from a coherent pair. The one cost
      // is that the first coarse-half CC after such a switch combines with a
      // note-derived fine half for a single message — at most 127/16383 = 0.8 %
      // of full scale, once, which is the same tolerance the 14-bit assembler
      // already documents.
      if (isOn) {
        const value14 = trailsNoteToValue14(note, noteRange);
        s.msb[ref.axis] = (value14 >> 7) & 0x7f;
        s.lsb[ref.axis] = value14 & 0x7f;
        // Bookkeeping only while `sawNote` is true (both the activity timeout
        // and the loop-restart selector skip note channels), but kept honest so
        // a future change to that rule does not inherit a stale timestamp.
        s.lastAxisMs = nowMs;
        // ⚠ AXIS BEFORE GATE. Both land at the same audio time, on independent
        // ConstantSources, so this cannot race — but pitch-then-gate is the
        // order a downstream envelope + VCO wants stated, and stating it costs
        // nothing.
        emitAxis(ref, s, out);
      }

      // The quantised pitch, per axis — the poly bus's raw material. Emitted
      // for a release too, because a lane's gate has to fall.
      out.push({
        kind: 'note',
        channel: ref.channel,
        axis: ref.axis,
        note,
        on: isOn,
        sounding: s.held[ref.axis].size > 0,
      });

      // ⚠ THE OR OF THE CHANNEL'S TWO AXES. A contact gate answers "is this
      // Trails channel sounding", and a channel is sounding while EITHER of its
      // coordinates is. Reading one axis alone — which a shared, deduplicating
      // note set silently did — drops the gate mid-gesture. This is also the
      // same question the CC-mode activity path answers, computed the same way,
      // which is what keeps one parser rather than two.
      const high = s.held.x.size > 0 || s.held.y.size > 0;
      s.gateHigh = high;
      if (high !== wasHigh) {
        out.push({ kind: 'gate', channel: ref.channel, high, source: 'note' });
      }
      // THE STEP TRIGGER. After the gate, so a consumer reading both in order
      // sees the level settle before the articulation — and only on a STRIKE
      // that the stream says begins a new step.
      if (isOn && (!wasSounding || s.releasedSinceTrigger)) {
        s.releasedSinceTrigger = false;
        out.push({ kind: 'trigger', channel: ref.channel, source: 'step' });
      }
      return out;
    }

    return out;
  }

  function tick(nowMs: number): TrailsEvent[] {
    const out: TrailsEvent[] = [];
    for (const [channel, s] of channels) {
      if (s.sawNote || !s.gateHigh) continue;
      if (nowMs - s.lastAxisMs >= activityTimeoutMs) {
        s.gateHigh = false;
        out.push({ kind: 'gate', channel, high: false, source: 'activity' });
      }
    }
    return out;
  }

  /**
   * Is this a frame this decoder has a story for?
   *
   * Deliberately a SEPARATE, purely structural pass rather than a flag threaded
   * through `handle`'s many early returns — recognition is a property of the
   * bytes, not of what the channel state happened to do with them, and keeping
   * it independent is what lets the monitor disagree with the decode.
   */
  function recognises(data: ArrayLike<number>): boolean {
    if (data.length < 1) return false;
    const status = data[0]! & 0xff;
    // System REAL-TIME (0xF8..0xFF). We act on clock/start/continue/stop and
    // knowingly ignore the rest (Active Sense at ~3 Hz is the common one) — all
    // of them are understood, so none should inflate the "not decoded" tally.
    if (status >= 0xf8) return true;
    // System COMMON (0xF0..0xF7) — SysEx, MTC, Song Position. Trails documents
    // none of these, so if one appears it is genuinely news and should surface.
    if (status >= 0xf0) return false;
    const kind = status & 0xf0;
    const ref = axisFor(status & 0x0f);
    if (!ref) return false; // a MIDI channel this device does not use
    if (kind === STATUS_NOTE_ON || kind === STATUS_NOTE_OFF) return data.length >= 2;
    if (kind === STATUS_CC) {
      if (data.length < 3) return false;
      const controller = data[1]! & 0x7f;
      return controller === ccPair.msb || controller === ccPair.lsb;
    }
    return false;
  }

  return {
    handle,
    handleFrame(data, nowMs) {
      // `recognises` FIRST: `handle` mutates channel state, and a verdict read
      // afterwards would be describing the post-state rather than the bytes.
      const recognised = recognises(data);
      return { events: handle(data, nowMs), recognised };
    },
    tick,
    reset() {
      channels.clear();
    },
  };
}

// ── Encoding, for the simulated device and the golden vectors ───────────────

/**
 * The bytes a Trails would put on the wire for one axis at `unit` (0..1).
 *
 * Lives beside the decoder ON PURPOSE: the simulated device drives the REAL
 * decode path, and it can only do that if it speaks the real byte format. A
 * test that wants an independent encoding writes the literal bytes itself (the
 * golden vectors do exactly that), so this helper never makes the suite agree
 * with the decoder by construction.
 */
export function encodeTrailsAxis(
  ref: TrailsAxisRef,
  unit: number,
  ccPair: TrailsCcPair = TRAILS_CC_PAIR,
  axisMap: readonly TrailsAxisRef[] = TRAILS_AXIS_MAP,
): number[][] {
  const wireChannel = axisMap.findIndex((a) => a.channel === ref.channel && a.axis === ref.axis);
  if (wireChannel < 0) return [];
  const clamped = Math.max(0, Math.min(1, Number.isFinite(unit) ? unit : 0));
  const value14 = Math.round(clamped * TRAILS_CC_FULL_SCALE);
  const status = STATUS_CC | (wireChannel & 0x0f);
  return [
    [status, ccPair.msb, (value14 >> 7) & 0x7f],
    [status, ccPair.lsb, value14 & 0x7f],
  ];
}

/**
 * The bytes a Trails in NOTE MODE puts on the wire for one axis.
 *
 * ⚠ A NOTE-ON WITH VELOCITY 0 IS THE RELEASE, and that is not a stylistic
 * choice — it is what the hardware does. The owner's MON capture (2026-09-01)
 * shows rows named `chN NOTE nn on` with `last=0` and NO 0x80 note-off rows at
 * all, which is the running-status shape. The double sends what the device
 * sends, so a decoder change that only handled 0x80 would go red here.
 *
 * `axis` matters: in note mode each axis still transmits on its own MIDI
 * channel (the same eight-row map as CC mode), so channel 1's X and channel 1's
 * Y are two different note streams on two different wire channels — which is
 * exactly what the capture shows, with distinct note sets on ch1 and ch2.
 */
export function encodeTrailsNote(
  ref: TrailsAxisRef,
  note: number,
  velocity: number = TRAILS_NOTE_VELOCITY,
  axisMap: readonly TrailsAxisRef[] = TRAILS_AXIS_MAP,
): number[] {
  const wireChannel = axisMap.findIndex((a) => a.channel === ref.channel && a.axis === ref.axis);
  const nibble = (wireChannel < 0 ? 0 : wireChannel) & 0x0f;
  return [STATUS_NOTE_ON | nibble, note & 0x7f, velocity & 0x7f];
}

/** The note-on / note-off bytes for a channel's gate, on that channel's X wire
 *  channel (the one the axis map assigns to it first). */
export function encodeTrailsGate(
  channel: TrailsChannel,
  high: boolean,
  note = 60,
  axisMap: readonly TrailsAxisRef[] = TRAILS_AXIS_MAP,
): number[] {
  const wireChannel = axisMap.findIndex((a) => a.channel === channel && a.axis === 'x');
  const nibble = (wireChannel < 0 ? 0 : wireChannel) & 0x0f;
  return high
    ? [STATUS_NOTE_ON | nibble, note & 0x7f, 100]
    : [STATUS_NOTE_OFF | nibble, note & 0x7f, 0];
}
