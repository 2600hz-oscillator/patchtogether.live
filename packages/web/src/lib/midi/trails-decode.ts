// packages/web/src/lib/midi/trails-decode.ts
//
// THE BELA TRAILS WIRE DECODER — pure, DOM-free, clock-injected.
//
// Trails is a quad touch-gesture recorder: a 85 × 85 mm multitouch pad whose
// four channels each record a gesture, loop it, and emit X, Y and a gate
// continuously. Over its class-compliant USB-MIDI port that state arrives as
// 14-bit Control Change per axis, one MIDI channel per axis, plus MIDI clock.
//
// EVERYTHING THIS FILE ENCODES ABOUT THE WIRE IS A NAMED CONSTANT, on purpose.
// The hardware is not in the building yet: the manual is the only source for
// the CC pair, the channel→axis order and how the gates are emitted, and one of
// those three (the CC pair) is documented as a NONSTANDARD pairing. So each is
// a single exported constant with a hardware-verify note beside it, and the
// unit suite pins the DECODE against golden byte vectors built from those
// constants — a correction after the first hardware session is a one-line edit
// here, not a rewrite anywhere.
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
 * ⚠ HARDWARE-VERIFY ITEM #3 — the ambiguity this number exists to survive. The
 * manual documents Note On/Off as an ALTERNATIVE to CC ("sends Note On/Off
 * instead of CC when pitch and temporal quantisation are both enabled"), and
 * says nothing about what carries the gate when the device is in its ordinary
 * CC mode. Two readings are possible and we cannot tell them apart without the
 * device: notes are always sent alongside CC, or the gate is only inferable
 * from the CC stream starting and stopping.
 *
 * So BOTH are implemented and notes WIN. A channel that has ever produced a
 * note takes its gate from notes exclusively and this timeout never applies to
 * it. A channel that has only ever produced CC gets an activity gate: high
 * while axis messages keep arriving, low once the stream has been quiet for
 * this long. If the hardware turns out to send notes, the activity path is
 * simply never reached and this constant becomes dead weight worth deleting;
 * if it does not, the module still emits a usable gate.
 *
 * 120 ms is chosen to sit well above any plausible inter-message gap in a live
 * stream (even a 20 Hz axis update is 50 ms apart) and well below the point a
 * player would call a held gate "stuck". The real stream rate is the fourth
 * hardware-verify item; if it turns out to be slower than ~8 Hz this needs to
 * grow.
 */
export const TRAILS_ACTIVITY_GATE_TIMEOUT_MS = 120;

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
      /** Which of the two documented mechanisms produced this edge. */
      source: 'note' | 'activity';
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
}

export interface TrailsDecoder {
  /**
   * Feed one MIDI message. `nowMs` is the arrival time on the SAME clock the
   * caller later passes to `tick` (`performance.now()` in the app, a counter in
   * a test) — injected rather than read so the activity gate is testable
   * without waiting for wall-clock time.
   */
  handle(data: ArrayLike<number>, nowMs: number): TrailsEvent[];
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

  function handle(data: ArrayLike<number>, nowMs: number): TrailsEvent[] {
    const out: TrailsEvent[] = [];
    if (data.length < 1) return out;
    const status = data[0]! & 0xff;

    // System real-time (0xF8..0xFF) is broadcast — no channel nibble.
    if (status >= 0xf8) {
      if (status === STATUS_CLOCK) out.push({ kind: 'clock' });
      else if (status === STATUS_START) out.push({ kind: 'transport', running: true, reset: true });
      else if (status === STATUS_CONTINUE) out.push({ kind: 'transport', running: true, reset: false });
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
      const wasNoteChannel = s.sawNote;
      s.sawNote = true;
      if (!wasNoteChannel && s.gateHigh) {
        // The channel had an ACTIVITY gate up and has now proven it sends
        // notes. Hand ownership over without a spurious edge: the note state
        // below decides the level from here on.
        s.gateHigh = false;
      }
      if (isOn) s.held.add(note);
      else s.held.delete(note);
      const high = s.held.size > 0;
      if (high !== s.gateHigh) {
        s.gateHigh = high;
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

  return {
    handle,
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
