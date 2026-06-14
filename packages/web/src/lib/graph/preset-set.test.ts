// packages/web/src/lib/graph/preset-set.test.ts
//
// Unit tests for the pure `.set` container (zip-of-zips of preset slots +
// the MIDI mapping). No DOM / IDB — `fflate` runs in node, so this is a pure
// round-trip + validation suite.

import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import {
  buildSet,
  parseSet,
  isSet,
  SLOT_COUNT,
  SET_FORMAT,
  type PresetSet,
  type SetSlot,
} from './preset-set';
import type { MidiBindingExport } from './performance-bundle';

/** A tiny non-empty Uint8Array standing in for a perf-zip's bytes (the .set
 *  treats slot bytes as opaque blobs, so any non-empty payload round-trips). */
function fakeZip(seed: number, len = 32): Uint8Array {
  const a = new Uint8Array(len);
  for (let i = 0; i < len; i++) a[i] = (seed + i) % 256;
  return a;
}

const MIDI: MidiBindingExport[] = [
  { key: 'vca:gain', channel: 0, cc: 7, learnedAt: 1 },
  { key: 'adsr:attack', channel: 1, kind: 'note', note: 60, learnedAt: 2 },
];

describe('preset-set: build + parse round-trip', () => {
  it('round-trips occupied slots + the MIDI map byte-exactly', () => {
    const slots: SetSlot[] = [
      { index: 0, zipBytes: fakeZip(10), label: 'intro.ptperf.zip' },
      { index: 2, zipBytes: fakeZip(99, 64) },
      { index: 4, zipBytes: fakeZip(200, 16), label: 'finale' },
    ];
    const input: PresetSet = { slots, midiBindings: MIDI, savedAt: 12345 };

    const bytes = buildSet(input);
    expect(bytes.length).toBeGreaterThan(0);

    const parsed = parseSet(bytes);
    expect(parsed.savedAt).toBe(12345);
    expect(parsed.midiBindings).toEqual(MIDI);

    // Slots come back sorted by index, only the occupied ones.
    expect(parsed.slots.map((s) => s.index)).toEqual([0, 2, 4]);
    expect(parsed.slots[0]!.label).toBe('intro.ptperf.zip');
    expect(parsed.slots[2]!.label).toBe('finale');
    // Byte-exact payloads.
    expect(parsed.slots[0]!.zipBytes).toEqual(fakeZip(10));
    expect(parsed.slots[1]!.zipBytes).toEqual(fakeZip(99, 64));
    expect(parsed.slots[2]!.zipBytes).toEqual(fakeZip(200, 16));
  });

  it('handles a single occupied slot + empty MIDI map', () => {
    const bytes = buildSet({ slots: [{ index: 3, zipBytes: fakeZip(1) }], midiBindings: [] });
    const parsed = parseSet(bytes);
    expect(parsed.slots).toHaveLength(1);
    expect(parsed.slots[0]!.index).toBe(3);
    expect(parsed.midiBindings).toEqual([]);
  });

  it('produces an empty-slots set (manifest only) when nothing is occupied', () => {
    const bytes = buildSet({ slots: [], midiBindings: MIDI });
    const parsed = parseSet(bytes);
    expect(parsed.slots).toHaveLength(0);
    expect(parsed.midiBindings).toEqual(MIDI);
  });

  it('is deterministic for a fixed input (same bytes twice)', () => {
    const input: PresetSet = {
      slots: [
        { index: 4, zipBytes: fakeZip(5) },
        { index: 0, zipBytes: fakeZip(6) },
      ],
      midiBindings: MIDI,
      savedAt: 7,
    };
    expect(buildSet(input)).toEqual(buildSet(input));
  });
});

describe('preset-set: input hardening', () => {
  it('drops out-of-range slot indices', () => {
    const slots: SetSlot[] = [
      { index: -1, zipBytes: fakeZip(1) },
      { index: SLOT_COUNT, zipBytes: fakeZip(2) },
      { index: 0, zipBytes: fakeZip(3) },
    ];
    const parsed = parseSet(buildSet({ slots, midiBindings: [] }));
    expect(parsed.slots.map((s) => s.index)).toEqual([0]);
  });

  it('drops empty-byte slots', () => {
    const slots: SetSlot[] = [
      { index: 0, zipBytes: new Uint8Array(0) },
      { index: 1, zipBytes: fakeZip(1) },
    ];
    const parsed = parseSet(buildSet({ slots, midiBindings: [] }));
    expect(parsed.slots.map((s) => s.index)).toEqual([1]);
  });

  it('last write wins on a duplicate index in the input', () => {
    const slots: SetSlot[] = [
      { index: 1, zipBytes: fakeZip(1), label: 'first' },
      { index: 1, zipBytes: fakeZip(2), label: 'second' },
    ];
    const parsed = parseSet(buildSet({ slots, midiBindings: [] }));
    expect(parsed.slots).toHaveLength(1);
    expect(parsed.slots[0]!.label).toBe('second');
    expect(parsed.slots[0]!.zipBytes).toEqual(fakeZip(2));
  });
});

describe('preset-set: parse error surfaces', () => {
  it('throws on empty input', () => {
    expect(() => parseSet(new Uint8Array(0))).toThrow(/empty/i);
  });

  it('throws on corrupt (non-zip) bytes', () => {
    expect(() => parseSet(new Uint8Array([1, 2, 3, 4, 5]))).toThrow(/corrupt/i);
  });

  it('throws when set.json is missing (foreign zip)', () => {
    const foreign = zipSync({ 'hello.txt': strToU8('hi') });
    expect(() => parseSet(foreign)).toThrow(/set\.json/i);
  });

  it('throws on an unsupported format', () => {
    const bad = zipSync({
      'set.json': strToU8(JSON.stringify({ format: 'pt-set-v999', slots: [], midiBindings: [] })),
    });
    expect(() => parseSet(bad)).toThrow(/unsupported/i);
  });

  it('skips a slot whose referenced bytes are missing from the container', () => {
    // Hand-build a set whose manifest references a slot path that isn't present.
    const manifest = {
      format: SET_FORMAT,
      savedAt: 0,
      slots: [
        { index: 0, path: 'slots/slot-0-.ptperf.zip' }, // present below
        { index: 1, path: 'slots/slot-1-missing.ptperf.zip' }, // NOT present
      ],
      midiBindings: [],
    };
    const bytes = zipSync({
      'set.json': strToU8(JSON.stringify(manifest)),
      'slots/slot-0-.ptperf.zip': fakeZip(1),
    });
    const parsed = parseSet(bytes);
    expect(parsed.slots.map((s) => s.index)).toEqual([0]);
  });
});

describe('preset-set: isSet pre-check', () => {
  it('is true for a real .set', () => {
    expect(isSet(buildSet({ slots: [{ index: 0, zipBytes: fakeZip(1) }], midiBindings: [] }))).toBe(true);
  });
  it('is false for empty / garbage / a foreign zip', () => {
    expect(isSet(new Uint8Array(0))).toBe(false);
    expect(isSet(new Uint8Array([9, 9, 9]))).toBe(false);
    expect(isSet(zipSync({ 'x.txt': strToU8('x') }))).toBe(false);
  });
});
