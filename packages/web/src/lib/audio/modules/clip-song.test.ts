// packages/web/src/lib/audio/modules/clip-song.test.ts
//
// Pure SONG MODE v2 model: the concrete PRINTED performance the clip player
// records into and plays back from (clip-song.ts). Covers shape defaults,
// garbage coercion, the print merge, the half-open playback window, loop-length
// derivation, the arranger-override ownership precedence, the container-init
// seam, and the SONG-REC state reads. Deterministic, engine-free.

import { describe, it, expect } from 'vitest';
import {
  SONG_SCHEMA_VERSION,
  MAX_SONG_NOTE_EVENTS,
  MAX_SONG_AUTO_TRACKS,
  defaultSongData,
  coerceSongData,
  coerceSongNoteEvent,
  coerceSongNoteChannel,
  coerceSongAutoChannel,
  coerceSongRecState,
  ensureSongContainers,
  mergeSongNotes,
  songNoteChannel,
  songNotesInRange,
  songFurthestBeat,
  songLengthBeats,
  songHasContent,
  songNoteCount,
  songPlaybackOwners,
  ARRANGER_LANE,
  songArmed,
  songRecMode,
  isSongRecorder,
  songNoteEnabled,
  songAutoEnabled,
  songArrangerEnabled,
  type SongData,
  type SongNoteEvent,
} from './clip-song';

describe('defaultSongData', () => {
  it('is an empty, open, looping song at the current schema', () => {
    expect(defaultSongData()).toEqual({ v: SONG_SCHEMA_VERSION, lengthBeats: 0, loop: true });
  });
});

describe('coerceSongNoteEvent', () => {
  it('accepts a valid onset + optional fields', () => {
    expect(coerceSongNoteEvent({ beat: 4, midi: 60 })).toEqual({ beat: 4, midi: 60 });
    expect(
      coerceSongNoteEvent({ beat: 1.5, midi: 72, velocity: 100, lengthBeats: 0.25 }),
    ).toEqual({ beat: 1.5, midi: 72, velocity: 100, lengthBeats: 0.25 });
  });
  it('rejects / clamps garbage', () => {
    expect(coerceSongNoteEvent(null)).toBeNull();
    expect(coerceSongNoteEvent({ beat: -1, midi: 60 })).toBeNull(); // negative beat
    expect(coerceSongNoteEvent({ beat: 0 })).toBeNull(); // no midi
    expect(coerceSongNoteEvent({ beat: 0, midi: 60, velocity: 999 })?.velocity).toBe(127);
    // non-positive lengthBeats is dropped (not a valid gate width)
    expect(coerceSongNoteEvent({ beat: 0, midi: 60, lengthBeats: 0 })?.lengthBeats).toBeUndefined();
  });
});

describe('coerceSongNoteChannel', () => {
  it('coerces + drops + beat-sorts events', () => {
    const ch = coerceSongNoteChannel({
      events: [
        { beat: 2, midi: 60 },
        'garbage',
        { beat: 0, midi: 62 },
        { beat: 1, midi: 64 },
      ],
    });
    expect(ch?.events.map((e) => e.beat)).toEqual([0, 1, 2]);
  });
  it('caps at MAX_SONG_NOTE_EVENTS', () => {
    const events = Array.from({ length: MAX_SONG_NOTE_EVENTS + 50 }, (_, i) => ({ beat: i, midi: 60 }));
    expect(coerceSongNoteChannel({ events })?.events.length).toBe(MAX_SONG_NOTE_EVENTS);
  });
});

describe('coerceSongAutoChannel', () => {
  it('keeps only valid target keys, sorted, capped', () => {
    const ch = coerceSongAutoChannel({
      tracks: {
        'n1::freq': { events: [{ beat: 1, value: 0.5 }, { beat: 0, value: 0.2 }] },
        badkey: { events: [] }, // no `::` → dropped
        'n2::gain': { events: [{ beat: 0, value: 2 }] }, // value clamped to 1
      },
    });
    expect(Object.keys(ch!.tracks).sort()).toEqual(['n1::freq', 'n2::gain']);
    expect(ch!.tracks['n1::freq']!.events.map((e) => e.beat)).toEqual([0, 1]); // beat-sorted
    expect(ch!.tracks['n2::gain']!.events[0]!.value).toBe(1); // clamped
  });
  it('caps track count at MAX_SONG_AUTO_TRACKS', () => {
    const tracks: Record<string, unknown> = {};
    for (let i = 0; i < MAX_SONG_AUTO_TRACKS + 10; i++) tracks[`n${i}::p`] = { events: [] };
    expect(Object.keys(coerceSongAutoChannel({ tracks })!.tracks).length).toBe(MAX_SONG_AUTO_TRACKS);
  });
});

describe('coerceSongData', () => {
  it('normalizes a full song, dropping empty/garbage channels + bad lane keys', () => {
    const song = coerceSongData({
      lengthBeats: 16,
      loop: false,
      notes: {
        '0': { events: [{ beat: 0, midi: 60 }] },
        '3': { events: [] }, // empty channel dropped
        '9': { events: [{ beat: 0, midi: 60 }] }, // bad lane key dropped
        x: { events: [{ beat: 0, midi: 60 }] }, // non-numeric key dropped
      },
      arrangerAuto: { tracks: { 'n1::freq': { events: [{ beat: 0, value: 0.5 }] } } },
      arrangerAssign: { modA: true, 'bad::key': true, modB: false },
    });
    expect(song.v).toBe(SONG_SCHEMA_VERSION);
    expect(song.lengthBeats).toBe(16);
    expect(song.loop).toBe(false);
    expect(Object.keys(song.notes ?? {})).toEqual(['0']);
    expect(song.arrangerAuto?.tracks['n1::freq']).toBeTruthy();
    expect(song.arrangerAssign).toEqual({ modA: true }); // only valid module key
  });
  it('a non-object → default song', () => {
    expect(coerceSongData(null)).toEqual(defaultSongData());
    expect(coerceSongData(42)).toEqual(defaultSongData());
  });
});

describe('ensureSongContainers', () => {
  it('creates song + all sparse containers in place (idempotent)', () => {
    const holder: { song?: SongData | null } = {};
    ensureSongContainers(holder);
    expect(holder.song).toBeTruthy();
    expect(holder.song!.notes).toEqual({});
    expect(holder.song!.auto).toEqual({});
    expect(holder.song!.arrangerAuto).toEqual({ tracks: {} });
    expect(holder.song!.arrangerAssign).toEqual({});
    // Idempotent: existing content survives a second call.
    holder.song!.notes!['0'] = { events: [{ beat: 0, midi: 60 }] };
    ensureSongContainers(holder);
    expect(holder.song!.notes!['0']).toEqual({ events: [{ beat: 0, midi: 60 }] });
  });
});

describe('mergeSongNotes (print merge / overdub)', () => {
  it('concats + stable beat-sorts + plain-copies', () => {
    const existing: SongNoteEvent[] = [{ beat: 0, midi: 60 }, { beat: 2, midi: 64 }];
    const incoming: SongNoteEvent[] = [{ beat: 1, midi: 62, velocity: 100, lengthBeats: 0.5 }];
    const merged = mergeSongNotes(existing, incoming);
    expect(merged.map((e) => e.beat)).toEqual([0, 1, 2]);
    expect(merged[1]).toEqual({ beat: 1, midi: 62, velocity: 100, lengthBeats: 0.5 });
    // plain-copied (not the same references — Y-severed)
    expect(merged[0]).not.toBe(existing[0]);
  });
  it('caps the merged array', () => {
    const existing = Array.from({ length: MAX_SONG_NOTE_EVENTS }, (_, i) => ({ beat: i, midi: 60 }));
    const merged = mergeSongNotes(existing, [{ beat: 0.5, midi: 61 }]);
    expect(merged.length).toBe(MAX_SONG_NOTE_EVENTS);
  });
});

describe('songNotesInRange (half-open playback window)', () => {
  const ch = coerceSongNoteChannel({
    events: [
      { beat: 0, midi: 60 },
      { beat: 1, midi: 62 },
      { beat: 2, midi: 64 },
      { beat: 2, midi: 67 }, // chord at beat 2
    ],
  });
  it('fires [from, to) — onset on the boundary fires ONCE', () => {
    expect(songNotesInRange(ch, 0, 1).map((e) => e.midi)).toEqual([60]); // 1 excluded
    expect(songNotesInRange(ch, 1, 3).map((e) => e.midi)).toEqual([62, 64, 67]);
    expect(songNotesInRange(ch, 3, 5)).toEqual([]);
    expect(songNotesInRange(ch, 1, 1)).toEqual([]); // empty window
  });
  it('null channel → []', () => {
    expect(songNotesInRange(null, 0, 4)).toEqual([]);
  });
});

describe('songFurthestBeat / songLengthBeats', () => {
  it('furthest beat spans note length + auto + arranger', () => {
    const song = coerceSongData({
      notes: { '0': { events: [{ beat: 3, midi: 60, lengthBeats: 2 }] } }, // reaches 5
      auto: { '1': { tracks: { 'n::p': { events: [{ beat: 6, value: 1 }] } } } },
      arrangerAuto: { tracks: { 'n::q': { events: [{ beat: 7.5, value: 0 }] } } },
    });
    expect(songFurthestBeat(song)).toBe(7.5);
  });
  it('explicit lengthBeats wins; else bar-ceil of furthest; empty → one bar', () => {
    expect(songLengthBeats(coerceSongData({ lengthBeats: 12 }), 4)).toBe(12);
    const s = coerceSongData({ notes: { '0': { events: [{ beat: 5, midi: 60 }] } } });
    expect(songLengthBeats(s, 4)).toBe(8); // 5 → next bar (8)
    expect(songLengthBeats(defaultSongData(), 4)).toBe(4); // empty → 1 bar
  });
});

describe('songHasContent / songNoteCount', () => {
  it('detects + counts across channels', () => {
    expect(songHasContent(defaultSongData())).toBe(false);
    const s = coerceSongData({
      notes: { '0': { events: [{ beat: 0, midi: 60 }, { beat: 1, midi: 62 }] }, '2': { events: [{ beat: 0, midi: 48 }] } },
    });
    expect(songHasContent(s)).toBe(true);
    expect(songNoteCount(s)).toBe(3);
    expect(songNoteCount(defaultSongData())).toBe(0);
  });
  it('content via arranger-only auto', () => {
    const s = coerceSongData({ arrangerAuto: { tracks: { 'n::p': { events: [{ beat: 0, value: 1 }] } } } });
    expect(songHasContent(s)).toBe(true);
  });
});

describe('songPlaybackOwners (override precedence)', () => {
  it('arranger lane OVERRIDES a channel carrying the same key; else lowest channel wins', () => {
    const carriers = [
      new Set(['n1::a']), // channel 0
      new Set(['n1::a', 'n2::b']), // channel 1 also carries n1::a → ch0 wins that
      null,
      new Set(['n3::c']),
    ];
    const arranger = new Set(['n2::b']); // arranger overrides n2::b
    const owners = songPlaybackOwners(arranger, carriers);
    expect(owners.get('n1::a')).toBe(0); // lowest carrying channel
    expect(owners.get('n2::b')).toBe(ARRANGER_LANE); // arranger overrides
    expect(owners.get('n3::c')).toBe(3);
  });
  it('no arranger keys → pure lowest-channel ownership', () => {
    const owners = songPlaybackOwners(null, [null, new Set(['k']), new Set(['k'])]);
    expect(owners.get('k')).toBe(1);
  });
});

describe('SONG-REC state reads', () => {
  it('armed / mode / recorder gate', () => {
    expect(songArmed({ songRec: { armed: true } })).toBe(true);
    expect(songArmed({ songRec: { armed: false } })).toBe(false);
    expect(songArmed(undefined)).toBe(false);
    expect(songRecMode({ songRec: { armed: true, mode: 'overdub' } })).toBe('overdub');
    expect(songRecMode({ songRec: { armed: true } })).toBe('replace');
    // recorderId gates the single writer; absent → any client records (fallback).
    expect(isSongRecorder({ songRec: { armed: true, recorderId: 7 } }, 7)).toBe(true);
    expect(isSongRecorder({ songRec: { armed: true, recorderId: 7 } }, 9)).toBe(false);
    expect(isSongRecorder({ songRec: { armed: true } }, 42)).toBe(true);
    expect(isSongRecorder({ songRec: { armed: false, recorderId: 7 } }, 7)).toBe(false);
  });
  it('per-channel enables default to ALL enabled; explicit map gates', () => {
    expect(songNoteEnabled({ songRec: { armed: true } }, 3)).toBe(true); // no map → all on
    expect(songNoteEnabled({ songRec: { armed: true, noteEnable: { '2': true } } }, 2)).toBe(true);
    expect(songNoteEnabled({ songRec: { armed: true, noteEnable: { '2': true } } }, 3)).toBe(false);
    expect(songNoteEnabled({ songRec: { armed: false } }, 0)).toBe(false); // not armed
    expect(songAutoEnabled({ songRec: { armed: true } }, 0)).toBe(true);
    // arranger enable is OPT-IN (default off)
    expect(songArrangerEnabled({ songRec: { armed: true } })).toBe(false);
    expect(songArrangerEnabled({ songRec: { armed: true, arrangerEnable: true } })).toBe(true);
  });
  it('coerceSongRecState normalizes shape', () => {
    expect(coerceSongRecState(null)).toBeNull();
    const rs = coerceSongRecState({ armed: true, mode: 'bogus', recorderId: 5, noteEnable: { '1': true, '9': true } });
    expect(rs).toEqual({ armed: true, mode: 'replace', recorderId: 5, noteEnable: { '1': true } });
  });
});
