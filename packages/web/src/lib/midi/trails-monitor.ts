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
// ⚠ NO WINDOW, NO Y.DOC, NO ENGINE. Plain data in, plain data out, fixed-size
// state. A 250 msg/s stream costs one map bump and one ring write per message.

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
  decoded: boolean;
  /** Arrival order of the most recent message, for newest-first ordering and
   *  for choosing an eviction victim. */
  seq: number;
}

/** Name one frame as a `key` (identity) and a `label` (display). Split out and
 *  exported so a test can pin the naming without driving a whole monitor. */
export function describeTrailsFrame(data: ArrayLike<number>): {
  key: string;
  label: string;
  value: number | null;
} {
  if (data.length < 1) return { key: 'empty', label: '(empty frame)', value: null };
  const status = data[0]! & 0xff;

  if (status >= 0xf0) {
    const name = REALTIME_NAMES[status];
    const hex = status.toString(16).toUpperCase().padStart(2, '0');
    return name
      ? { key: `rt-${status}`, label: `${name} (0x${hex})`, value: null }
      : { key: `rt-${status}`, label: `SYSTEM 0x${hex}`, value: null };
  }

  const kind = status & 0xf0;
  // ⚠ PRINTED 1-BASED. The wire nibble is 0-based and the manual's MIDI table
  // is 1-based ("1.X → channel 1"), so a monitor that printed the nibble would
  // have a reader comparing "ch0" against a table that starts at 1 — an
  // off-by-one argument in the one place whose entire job is settling one.
  const ch = (status & 0x0f) + 1;
  const d1 = data.length >= 2 ? data[1]! & 0x7f : null;
  const d2 = data.length >= 3 ? data[2]! & 0x7f : null;

  switch (kind) {
    case STATUS_CC:
      return { key: `cc-${ch}-${d1}`, label: `ch${ch} CC${d1}`, value: d2 };
    case STATUS_NOTE_ON:
      return {
        key: `note-${ch}-${d1}`,
        label: `ch${ch} NOTE ${d1}${d2 === 0 ? ' (off, vel 0)' : ' on'}`,
        value: d2,
      };
    case STATUS_NOTE_OFF:
      return { key: `noteoff-${ch}-${d1}`, label: `ch${ch} NOTE ${d1} off`, value: d2 };
    case STATUS_PITCH_BEND:
      return { key: `bend-${ch}`, label: `ch${ch} PITCH-BEND`, value: d2 };
    case STATUS_POLY_AFTERTOUCH:
      return { key: `pat-${ch}-${d1}`, label: `ch${ch} POLY-AT ${d1}`, value: d2 };
    case STATUS_CHANNEL_AFTERTOUCH:
      return { key: `cat-${ch}`, label: `ch${ch} CHAN-AT`, value: d1 };
    case STATUS_PROGRAM:
      return { key: `pc-${ch}`, label: `ch${ch} PROGRAM`, value: d1 };
    default: {
      const hex = status.toString(16).toUpperCase().padStart(2, '0');
      return { key: `raw-${status}`, label: `0x${hex} (unknown status)`, value: d1 };
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
    const { key, label, value } = describeTrailsFrame(data);
    const existing = rows.get(key);
    if (existing) {
      existing.count++;
      existing.lastValue = value;
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
    rows.set(key, { key, label, count: 1, lastValue: value, decoded, seq: ++seq });
  }

  function snapshot(): TrailsMonitorSnapshot {
    const ordered = [...rows.values()].sort((a, b) => b.seq - a.seq);
    const out: TrailsMonitorRow[] = ordered.map((r) => ({
      key: r.key,
      label: r.label,
      count: r.count,
      lastValue: r.lastValue,
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
    for (const r of [...out].sort((a, b) => b.count - a.count)) {
      const value = r.lastValue === null ? '' : ` last=${r.lastValue}`;
      lines.push(
        `  ${r.decoded ? ' ' : '!'} ${r.label.padEnd(22)} x${String(r.count).padEnd(7)}${value}`,
      );
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
