// packages/web/src/lib/midi/midi-tail.ts
//
// THE MIDI TAIL — a pure ring of decoded MIDI traffic for a debug surface.
//
// WHY IT EXISTS (owner report, 2026-09-03: "midiclock may be entirely broken,
// it doesn't seem to read start"). Chasing that report proved the INGEST CHAIN
// sound end-to-end — grant → bind → `onmidimessage` → transport — under the
// full mock-driven default-shell path. What the product could not answer was
// the owner's actual question: IS ANY BYTE ARRIVING ON THE PORT THIS MODULE IS
// LISTENING TO? A binder whose port is wrong (the Windows dual-interface
// class, a DAW's virtual port enumerated first, a device that routes its
// transport out a second jack) looks perfectly healthy — connected, roster
// painted, lamp dark — while receiving nothing at all. The tail is the one
// affordance that separates "nothing arrives" from "it arrives and we drop
// it", which is the difference between a cable problem and a code problem.
//
// PURE — no Svelte, no DOM, no engine, no Web MIDI. The engine side is one
// nullable tap callback (`MidiclockApi.tapMidi`); the surface owns an instance
// of this ring only while its panel is open, so a closed panel costs nothing
// anywhere.

/** One raw inbound MIDI message, as the tap hands it over. */
export interface MidiTailEvent {
  /** `event.timeStamp` — performance.now()-domain milliseconds. */
  atMs: number;
  /** The raw bytes, copied out of the event's Uint8Array. */
  bytes: readonly number[];
}

/** How many rows the tail keeps. Old rows fall off; `seen` keeps counting. */
export const MIDI_TAIL_CAPACITY = 200;

/** What an OPEN, EMPTY tail says. It states the honest negative — nothing has
 *  arrived on the bound port — which is the exact fact the panel exists to
 *  establish. Decided here so a unit test can read it. */
export const MIDI_TAIL_IDLE_TEXT = 'no traffic on the selected device yet';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

/** `60` → `C4` (middle C, the MIDI convention this repo's docs use). */
export function midiNoteName(note: number): string {
  const n = Math.max(0, Math.min(127, Math.trunc(note)));
  return `${NOTE_NAMES[n % 12]}${Math.trunc(n / 12) - 1}`;
}

/**
 * One human-readable name per message, System Real-Time first because they are
 * what a TRANSPORT bridge lives on — the fixed vocabulary is deliberately the
 * uppercase wire-name style the trails monitor uses.
 *
 * Unknown or torn messages decode to `?` rather than throwing: the tail's job
 * is to show the wire as it is, including bytes that should not exist.
 */
export function decodeMidiMessage(bytes: readonly number[]): string {
  const status = bytes[0];
  if (status === undefined) return '?';

  // System Real-Time / System Common (no channel nibble).
  if (status >= 0xf0) {
    switch (status) {
      case 0xf8: return 'CLOCK';
      case 0xfa: return 'START';
      case 0xfb: return 'CONTINUE';
      case 0xfc: return 'STOP';
      case 0xfe: return 'ACTIVE SENSE';
      case 0xff: return 'RESET';
      case 0xf0: return 'SYSEX';
      case 0xf1: return 'MTC QUARTER';
      case 0xf2: return `SONG POS ${((bytes[2] ?? 0) << 7) | (bytes[1] ?? 0)}`;
      case 0xf3: return `SONG SEL ${bytes[1] ?? 0}`;
      case 0xf6: return 'TUNE REQ';
      case 0xf7: return 'SYSEX END';
      default: return '?';
    }
  }

  if (status < 0x80) return '?'; // a stray data byte — shown, not hidden

  const kind = status & 0xf0;
  const ch = (status & 0x0f) + 1; // 1-based on-wire channel, the repo convention
  switch (kind) {
    case 0x80: return `ch${ch} NOTE OFF ${midiNoteName(bytes[1] ?? 0)}`;
    case 0x90:
      // Velocity-0 note-on IS a note-off on the wire; say so.
      return (bytes[2] ?? 0) === 0
        ? `ch${ch} NOTE OFF ${midiNoteName(bytes[1] ?? 0)} (v0)`
        : `ch${ch} NOTE ON ${midiNoteName(bytes[1] ?? 0)} v${bytes[2] ?? 0}`;
    case 0xa0: return `ch${ch} POLY AT ${midiNoteName(bytes[1] ?? 0)} ${bytes[2] ?? 0}`;
    case 0xb0: return `ch${ch} CC ${bytes[1] ?? 0} = ${bytes[2] ?? 0}`;
    case 0xc0: return `ch${ch} PROGRAM ${bytes[1] ?? 0}`;
    case 0xd0: return `ch${ch} CHAN AT ${bytes[1] ?? 0}`;
    case 0xe0: return `ch${ch} BEND ${(((bytes[2] ?? 0) << 7) | (bytes[1] ?? 0)) - 8192}`;
    default: return '?';
  }
}

/** `[0x90, 60, 100]` → `"90 3C 64"`. */
export function formatMidiHex(bytes: readonly number[]): string {
  return bytes.map((b) => (b & 0xff).toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

/**
 * One tail row: seconds-with-millis timestamp, hex, decoded name. The
 * timestamp stays in the event's own performance.now() domain rather than
 * being re-anchored to wall time — DELTAS are what a clock diagnosis reads,
 * and this is the same clock the scheduler projects from.
 */
export function formatMidiTailRow(ev: MidiTailEvent): string {
  const hex = formatMidiHex(ev.bytes).padEnd(8, ' ');
  return `${(ev.atMs / 1000).toFixed(3).padStart(9, ' ')}  ${hex}  ${decodeMidiMessage(ev.bytes)}`;
}

export interface MidiTailRing {
  /** Record one event. O(1); drops the oldest row past capacity. */
  push(ev: MidiTailEvent): void;
  /** Formatted rows, NEWEST FIRST — the row a player is waiting for lands at
   *  the top rather than below a scroll. */
  lines(): string[];
  /** Total events ever pushed (survives ring eviction; reset by clear). */
  seen(): number;
  /** Empty the ring and zero the counter. */
  clear(): void;
}

/** A bounded tail of formatted MIDI rows. Pure state — no timers, no DOM. */
export function createMidiTailRing(capacity: number = MIDI_TAIL_CAPACITY): MidiTailRing {
  let rows: string[] = [];
  let total = 0;
  return {
    push(ev: MidiTailEvent): void {
      total++;
      rows.push(formatMidiTailRow(ev));
      if (rows.length > capacity) rows = rows.slice(rows.length - capacity);
    },
    lines(): string[] {
      return [...rows].reverse();
    },
    seen: () => total,
    clear(): void {
      rows = [];
      total = 0;
    },
  };
}
