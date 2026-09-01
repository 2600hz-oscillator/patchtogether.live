// packages/web/src/lib/midi/trails-monitor.ts
//
// THE TRAILS MIDI MONITOR — a pure, bounded tally of what the device is
// actually sending, so a hardware question can be answered in one paste instead
// of one round trip per guess.
//
// ⚠ ITS MOST VALUABLE OUTPUT IS WHAT THE DECODER REJECTED. Every constant in
// `trails-decode.ts` — the CC pair, the channel→axis map, which statuses matter
// — is a reading of a manual, and a monitor that only reported the traffic the
// decoder already understands could not falsify a single one of them. It would
// show a tidy CC15/CC37 tally on a device streaming CC15/CC47 and look healthy
// while the module sat still. So `observe()` takes the decoder's own verdict and
// the UNRECOGNISED tally is a first-class number: a non-zero there is the whole
// diagnosis, and the per-controller breakdown says which constant to move.
//
// It is also the answer to "does the Bar transmit?". The documentation says no
// (the MIDI table is eight rows of X/Y, and the Bar has no output jack at all).
// A player who touches the Bar with MON open and sees the message count sit
// perfectly still has DISPROVEN nothing about our code and CONFIRMED the
// documentation on their own hardware, in about four seconds.
//
// ── ⚠ THE INSTRUMENT ITSELF WAS WRONG, TWICE (found 2026-09-01, from the first
//    real capture the owner pasted back) ──────────────────────────────────────
//
// A diagnostic that reports a hardware question incorrectly is worse than no
// diagnostic, because its answer is believed. Both defects were in the same
// four lines of `observe()` and both made the same row lie:
//
//   A. `lastValue` on a note row settled on 0. A running-status release is a
//      note-ON with velocity 0, so it shares the strike's key, and "the last
//      message's data byte" is therefore the release's zero between every pair
//      of strikes. The capture read `ch2 NOTE 81 on x106 last=0` on a device
//      struck 53 times, and was nearly reported upstream as "Trails sends
//      velocity 0". Fixed by tracking `lastOnVelocity` separately and STICKILY.
//   B. `label` was written only when a row was CREATED. Every other field moved
//      with the stream and the name did not, so a row born from a strike read
//      "… on" for the rest of the session. Fixed by refreshing the label on
//      every observation AND by removing the momentary state from the label
//      altogether — a row is a shape, not a moment.
//
// ⚠ NO WINDOW, NO Y.DOC, NO ENGINE. Plain data in, plain data out, fixed-size
// state. A 250 msg/s stream costs one map bump and one ring write per message.

// The ONE import, and it is data rather than behaviour: the channel→axis map,
// so a row can name the jack a MIDI channel drives. See `describeTrailsFrame`
// for why annotating with the decoder's own belief is a diagnosis rather than a
// monitor agreeing with itself.
import { TRAILS_AXIS_MAP } from '$lib/midi/trails-decode';

/** Distinct message shapes the rolling log remembers. A SHAPE, not a message:
 *  "channel 1, CC 15" is one row whose count grows and whose value updates, so
 *  a 250 msg/s stream stays readable instead of scrolling a fixed window's
 *  worth of noise past the reader every 100 ms. */
export const TRAILS_MONITOR_MAX_ROWS = 32;

/** MIDI status nibbles the monitor names. Anything else is reported by its raw
 *  hex, which is the honest thing to do with a byte we have no story for. */
const STATUS_NOTE_OFF = 0x80;
const STATUS_NOTE_ON = 0x90;
const STATUS_POLY_AFTERTOUCH = 0xa0;
const STATUS_CC = 0xb0;
const STATUS_PROGRAM = 0xc0;
const STATUS_CHANNEL_AFTERTOUCH = 0xd0;
const STATUS_PITCH_BEND = 0xe0;

const REALTIME_NAMES: Readonly<Record<number, string>> = {
  0xf8: 'CLOCK',
  0xfa: 'START',
  0xfb: 'CONTINUE',
  0xfc: 'STOP',
  0xfe: 'ACTIVE-SENSE',
  0xff: 'RESET',
};

/** One shape of message the device has sent at least once. */
export interface TrailsMonitorRow {
  /** Stable identity of the shape — what makes two messages "the same row". */
  readonly key: string;
  /** Human-readable, e.g. `ch1 CC15` or `ch3 NOTE 60` or `START`. */
  readonly label: string;
  /** How many messages of this shape have arrived. */
  readonly count: number;
  /** The most recent data value, where the shape has one. */
  readonly lastValue: number | null;
  /** What `lastValue` MEANS, for the summary's `<name>=` prefix. */
  readonly valueLabel: string;
  /**
   * For note rows: the velocity of the most recent note-on with a NON-ZERO
   * velocity. `null` on every other kind of row, and on a note row that has
   * only ever seen releases.
   *
   * ⚠ THIS FIELD EXISTS BECAUSE THE MONITOR LIED. A running-status release is a
   * note-ON with velocity 0, so it shares this row's key — and `lastValue`,
   * being "the last message's data byte", therefore settled on 0 between every
   * pair of strikes. The owner's 2026-09-01 capture reads `ch2 NOTE 81 on
   * x106 last=0` on a device that had been struck 53 times, and it was very
   * nearly reported as "Trails sends velocity 0". The instrument was wrong, not
   * the hardware. The ON velocity is tracked separately so the readout can
   * answer the question it was built to answer.
   */
  readonly lastOnVelocity: number | null;
  /**
   * Did the decoder turn the LAST message of this shape into an event?
   *
   * Per-shape rather than per-message because that is the question a reader
   * has: "is the module listening to this row at all". A row the device sends
   * thousands of times while `decoded` stays false is the diagnosis.
   */
  readonly decoded: boolean;
}

export interface TrailsMonitorSnapshot {
  /** Every message the bound ports delivered, decoded or not. */
  readonly total: number;
  /** Messages the decoder produced no event from. */
  readonly unrecognised: number;
  /** Newest-first, capped at TRAILS_MONITOR_MAX_ROWS. */
  readonly rows: readonly TrailsMonitorRow[];
  /** True once the row table filled and older shapes started being evicted. */
  readonly truncated: boolean;
  /**
   * The whole state as one paste-able block. This is the deliverable: a player
   * with the hardware copies it into a message and every open question about
   * the wire is answered at once.
   */
  readonly summary: string;
}

export interface TrailsMonitor {
  /**
   * Tally one raw MIDI frame.
   *
   * `decoded` is the DECODER'S verdict on this exact frame (did it yield at
   * least one event), passed in rather than re-derived here — a monitor that
   * re-implemented the decode would agree with itself by construction and could
   * never report a disagreement, which is the only thing it is for.
   */
  observe(data: ArrayLike<number>, decoded: boolean): void;
  snapshot(): TrailsMonitorSnapshot;
  reset(): void;
}

interface MutableRow {
  key: string;
  label: string;
  count: number;
  lastValue: number | null;
  valueLabel: string;
  lastOnVelocity: number | null;
  decoded: boolean;
  /** Arrival order of the most recent message, for newest-first ordering and
   *  for choosing an eviction victim. */
  seq: number;
}

/** What one frame is called and what its data byte means. */
export interface TrailsFrameDescription {
  /** Stable identity of the SHAPE — what makes two messages the same row. */
  readonly key: string;
  /**
   * Display name.
   *
   * ⚠ STATE-INDEPENDENT, deliberately. This used to read `chN NOTE nn on` for a
   * note-on and `chN NOTE nn (off, vel 0)` for its running-status release —
   * two spellings for ONE key, and `observe()` only ever wrote the label at row
   * CREATION. So a row born from a strike said "on" for the rest of the session
   * no matter what arrived afterwards, and the owner's capture printed `NOTE 81
   * on … last=0`: a label frozen in one state beside a value taken from the
   * other. A row is a shape, not a moment, so the name no longer claims to
   * describe a moment.
   */
  readonly label: string;
  /** The most recent data byte this shape carries, or null where it has none. */
  readonly value: number | null;
  /** What `value` means — the summary prints it as `<valueLabel>=<value>`. */
  readonly valueLabel: string;
  /** Set ONLY on a note-on whose velocity is non-zero. See
   *  TrailsMonitorRow.lastOnVelocity. */
  readonly onVelocity: number | null;
}

/** Name one frame as a `key` (identity) and a `label` (display). Split out and
 *  exported so a test can pin the naming without driving a whole monitor. */
export function describeTrailsFrame(data: ArrayLike<number>): TrailsFrameDescription {
  if (data.length < 1) {
    return { key: 'empty', label: '(empty frame)', value: null, valueLabel: 'last', onVelocity: null };
  }
  const status = data[0]! & 0xff;

  if (status >= 0xf0) {
    const name = REALTIME_NAMES[status];
    const hex = status.toString(16).toUpperCase().padStart(2, '0');
    const label = name ? `${name} (0x${hex})` : `SYSTEM 0x${hex}`;
    return { key: `rt-${status}`, label, value: null, valueLabel: 'last', onVelocity: null };
  }

  const kind = status & 0xf0;
  // ⚠ PRINTED 1-BASED. The wire nibble is 0-based and the manual's MIDI table
  // is 1-based ("1.X → channel 1"), so a monitor that printed the nibble would
  // have a reader comparing "ch0" against a table that starts at 1 — an
  // off-by-one argument in the one place whose entire job is settling one.
  const ch = (status & 0x0f) + 1;
  // …AND ANNOTATED WITH THE JACK IT DRIVES.
  //
  // ⚠ THIS IS THE THIRD READOUT DEFECT, and the one that cost the most. A MIDI
  // channel is NOT a Trails channel: the device spends two MIDI channels per
  // Trails channel, one per axis, so MIDI ch3 and ch4 are Trails channel 2's X
  // and Y. Printing the bare MIDI number invited exactly the reading it got —
  // the owner saw "ch3 NOTE 63 / ch4 NOTE 99", looked at gate jacks 3 and 4,
  // found them dead, and reported the gates as broken. They were firing
  // correctly, on jack 2, the whole time.
  //
  // The annotation is the module's BELIEF about that channel, taken from the
  // same TRAILS_AXIS_MAP the decoder uses. That is deliberate and is not the
  // monitor re-deriving a decode it is supposed to be able to contradict: if
  // the map is wrong for some firmware, this prints the wrong belief right next
  // to the traffic that disproves it, which is the diagnosis rather than a
  // cover-up. A channel the map does not claim is annotated as unused.
  const belief = TRAILS_AXIS_MAP[status & 0x0f];
  const jack = belief ? `${belief.channel}${belief.axis.toUpperCase()}` : '--';
  const d1 = data.length >= 2 ? data[1]! & 0x7f : null;
  const d2 = data.length >= 3 ? data[2]! & 0x7f : null;

  const plain = (key: string, label: string, value: number | null): TrailsFrameDescription => ({
    key,
    label,
    value,
    valueLabel: 'last',
    onVelocity: null,
  });

  switch (kind) {
    case STATUS_CC:
      return plain(`cc-${ch}-${d1}`, `ch${ch}[${jack}] CC${d1}`, d2);
    case STATUS_NOTE_ON:
      // ONE key for the strike and its running-status release. Splitting them
      // would double the note rows and, at a 32-row cap on a device sending
      // eight-plus distinct notes on two axis channels, would evict the CLOCK
      // and CC rows a reader needs in the same glance. The state that used to
      // be smuggled into the label is carried by `onVelocity` instead.
      return {
        key: `note-${ch}-${d1}`,
        label: `ch${ch}[${jack}] NOTE ${d1}`,
        value: d2,
        valueLabel: 'vel',
        // Velocity 0 is the release, not a strike at zero force.
        onVelocity: d2 !== null && d2 > 0 ? d2 : null,
      };
    case STATUS_NOTE_OFF:
      return {
        key: `noteoff-${ch}-${d1}`,
        label: `ch${ch}[${jack}] NOTE ${d1} off`,
        value: d2,
        valueLabel: 'vel',
        onVelocity: null,
      };
    case STATUS_PITCH_BEND:
      return plain(`bend-${ch}`, `ch${ch}[${jack}] PITCH-BEND`, d2);
    case STATUS_POLY_AFTERTOUCH:
      return plain(`pat-${ch}-${d1}`, `ch${ch}[${jack}] POLY-AT ${d1}`, d2);
    case STATUS_CHANNEL_AFTERTOUCH:
      return plain(`cat-${ch}`, `ch${ch}[${jack}] CHAN-AT`, d1);
    case STATUS_PROGRAM:
      return plain(`pc-${ch}`, `ch${ch}[${jack}] PROGRAM`, d1);
    default: {
      const hex = status.toString(16).toUpperCase().padStart(2, '0');
      return plain(`raw-${status}`, `0x${hex} (unknown status)`, d1);
    }
  }
}

export function createTrailsMonitor(maxRows = TRAILS_MONITOR_MAX_ROWS): TrailsMonitor {
  const rows = new Map<string, MutableRow>();
  let total = 0;
  let unrecognised = 0;
  let seq = 0;
  let truncated = false;

  function observe(data: ArrayLike<number>, decoded: boolean): void {
    total++;
    if (!decoded) unrecognised++;
    const { key, label, value, valueLabel, onVelocity } = describeTrailsFrame(data);
    const existing = rows.get(key);
    if (existing) {
      existing.count++;
      // ⚠ `label` AND `valueLabel` ARE REFRESHED. They used to be written only
      // at row creation, so a row born from one message shape described that
      // first message for the rest of the session while every other field moved
      // on beneath it — the frozen-label half of the owner's misleading capture.
      existing.label = label;
      existing.valueLabel = valueLabel;
      existing.lastValue = value;
      // …but the ON velocity is STICKY, and that asymmetry is the point: a
      // release carries no velocity information, so letting it overwrite the
      // last real strike is how the readout came to say "vel 0" about a device
      // that had been struck a hundred times.
      if (onVelocity !== null) existing.lastOnVelocity = onVelocity;
      existing.decoded = decoded;
      existing.seq = ++seq;
      return;
    }
    if (rows.size >= maxRows) {
      // Evict the LEAST RECENTLY SEEN shape, never the least frequent: a rare
      // shape that just arrived is the interesting one, and a monitor that
      // dropped it to protect a CC row with ten thousand hits would throw away
      // the only message a reader is looking for.
      let victim: MutableRow | null = null;
      for (const r of rows.values()) if (!victim || r.seq < victim.seq) victim = r;
      if (victim) rows.delete(victim.key);
      truncated = true;
    }
    rows.set(key, {
      key,
      label,
      count: 1,
      lastValue: value,
      valueLabel,
      lastOnVelocity: onVelocity,
      decoded,
      seq: ++seq,
    });
  }

  function snapshot(): TrailsMonitorSnapshot {
    const ordered = [...rows.values()].sort((a, b) => b.seq - a.seq);
    const out: TrailsMonitorRow[] = ordered.map((r) => ({
      key: r.key,
      label: r.label,
      count: r.count,
      lastValue: r.lastValue,
      valueLabel: r.valueLabel,
      lastOnVelocity: r.lastOnVelocity,
      decoded: r.decoded,
    }));
    return { total, unrecognised, rows: out, truncated, summary: renderSummary(out) };
  }

  function renderSummary(out: readonly TrailsMonitorRow[]): string {
    const lines: string[] = [
      `TRAILS MIDI MONITOR — ${total} message${total === 1 ? '' : 's'}, `
        + `${unrecognised} not decoded${truncated ? ', row table truncated' : ''}`,
    ];
    if (out.length === 0) {
      lines.push('(nothing received — the device has sent no MIDI since MON was opened)');
      return lines.join('\n');
    }
    // Sorted by COUNT for the paste, not by recency: the reader wants the
    // stream's shape, and the two rows carrying a 14-bit axis should be the two
    // biggest numbers on the page if the CC pair is right.
    let anyNoteRow = false;
    for (const r of [...out].sort((a, b) => b.count - a.count)) {
      // A note row prints the last STRIKE'S velocity, never the release's zero.
      // That is the one number in this readout no document can supply: the
      // Trails manual does not contain the word "velocity", so whether the pad
      // transmits touch force is answerable only by watching this column while
      // pressing harder.
      const isNote = r.valueLabel === 'vel';
      if (isNote) anyNoteRow = true;
      const shown = isNote ? r.lastOnVelocity : r.lastValue;
      const value =
        shown !== null
          ? ` ${r.valueLabel}=${shown}`
          : isNote
            ? ' vel=? (no note-on with a velocity yet)'
            : '';
      lines.push(
        `  ${r.decoded ? ' ' : '!'} ${r.label.padEnd(22)} x${String(r.count).padEnd(7)}${value}`,
      );
    }
    if (anyNoteRow) {
      lines.push('  vel= is the last NOTE-ON velocity, ignoring the velocity-0 releases. If it');
      lines.push('      never changes however hard you press, this pad does not send touch force.');
    }
    if (unrecognised > 0) {
      lines.push('  ! = NOT decoded by this module. If an axis row is marked !, the CC pair or');
      lines.push('      the channel map in trails-decode.ts is wrong for this firmware.');
    }
    return lines.join('\n');
  }

  return {
    observe,
    snapshot,
    reset() {
      rows.clear();
      total = 0;
      unrecognised = 0;
      seq = 0;
      truncated = false;
    },
  };
}
