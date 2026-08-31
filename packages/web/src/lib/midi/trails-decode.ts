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
//                   is ever sent.
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
  /** MIDI notes currently held for this channel. */
  held: Set<number>;
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
    held: new Set<number>(),
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
      s.sawNote = true;
      if (isOn) s.held.add(note);
      else s.held.delete(note);
      const high = s.held.size > 0;
      s.gateHigh = high;
      if (high !== wasHigh) {
        out.push({ kind: 'gate', channel: ref.channel, high, source: 'note' });
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
