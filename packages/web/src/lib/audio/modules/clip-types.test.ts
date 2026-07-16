// packages/web/src/lib/audio/modules/clip-types.test.ts
import { describe, it, expect } from 'vitest';
import { syncedStore } from '@syncedstore/core';
import { midiToVOct, C3_MIDI } from '$lib/audio/note-entry';
import { POLY_CHANNEL_PAIRS } from '$lib/audio/poly';
import {
  CLIP_COUNT,
  CLIP_LANES,
  SCENE_STRIDE,
  CLIP_SCHEMA_VERSION,
  migrateLegacyClipKey,
  migrateClipPlayerData,
  DEFAULT_CLIP_STEPS,
  clipIndex,
  laneOf,
  slotOf,
  lanePlaying,
  laneQueued,
  playingSet,
  defaultNoteClip,
  coerceNoteEvent,
  coerceClipRecord,
  clampStepCount,
  readClip,
  notesStartingAt,
  lanesForStep,
  scaleSteps,
  rowToMidi,
  midiToRow,
  toggleNoteAt,
  cycleVelocity,
  noteAt,
  noteCovering,
  setNoteSpan,
  nextScale,
  velLevelIndex,
  velBucket,
  laneMono,
  laneMuted,
  coerceLaneColor,
  coerceLaneColors,
  laneColor,
  VEL_DEFAULT,
  VEL_LEVELS,
  MAX_CLIP_STEPS,
  STEPS_PER_PAGE,
  MAX_EDIT_PAGES,
  doubleNoteClip,
  reverseClipSteps,
  copyClip,
  lengthEndBlock,
  lengthEndStep,
  lengthFromBlockTap,
  lengthFromStepTap,
  readNoteRec,
  SCALE_NAMES,
  SCALE_CYCLE,
  coerceScaleName,
  laneSwing,
  clampSwing,
  isSwingCentered,
  swingStepOffset,
  MAX_SWING,
  MAX_AUTOMATION_TRACKS,
  MAX_AUTOMATION_EVENTS,
  isAutomationArmed,
  coerceAutomationEvent,
  coerceAutoTrack,
  coerceAutoClipRecord,
  readAutoClip,
  autoTrackViews,
  automationTargetKey,
  parseAutomationTargetKey,
  coerceAutoAssign,
  assignedLaneOf,
  laneAssignedTargets,
  autoAssignCounts,
  plainCloneAutoClip,
  reverseAutoClipRecord,
  autoClipHasTracks,
  readSceneAutos,
  autoPlaybackOwners,
  ensureArmAutoShells,
  sameAutomationTarget,
  mergeAutomationOverdub,
  automationValueAt,
  automationLinearAt,
  automationNextAfter,
  pasteApplies,
  readScene,
  sceneWritePlan,
  type NoteClipRecord,
  type NoteEvent,
  type ClipPlayerData,
  type AutomationEvent,
  type AutomationTrack,
} from './clip-types';

describe('dimensions', () => {
  it('has 8 lanes + 8 visible card slots (64 visible cells) at a FIXED stride of 64', () => {
    expect(CLIP_COUNT).toBe(64); // the VISIBLE 8×8 card grid
    expect(CLIP_LANES).toBe(8);
    expect(SCENE_STRIDE).toBe(64); // fixed flat-key stride (decoupled from CLIP_SLOTS)
  });
  it('clipIndex keys the sparse map at lane*SCENE_STRIDE + slot', () => {
    expect(clipIndex(0, 0)).toBe(0);
    expect(clipIndex(7, 0)).toBe(7); // lane 0: slot == key (stride-invariant)
    expect(clipIndex(0, 1)).toBe(SCENE_STRIDE); // lane 1, slot 0 = 64
    expect(clipIndex(0, 7)).toBe(7 * SCENE_STRIDE); // 448
    expect(clipIndex(7, 7)).toBe(7 * SCENE_STRIDE + 7); // 455
    // slot can grow past the visible CLIP_SLOTS (scenes ≥ 8) with unique keys.
    expect(clipIndex(8, 0)).toBe(8);
    expect(clipIndex(63, 7)).toBe(7 * SCENE_STRIDE + 63); // 511 — the max cell
  });
  it('laneOf/slotOf round-trip clipIndex for every (slot 0..63, lane 0..7)', () => {
    const seen = new Set<number>();
    for (let lane = 0; lane < CLIP_LANES; lane++) {
      for (let slot = 0; slot < SCENE_STRIDE; slot++) {
        const idx = clipIndex(slot, lane);
        expect(laneOf(idx)).toBe(lane);
        expect(slotOf(idx)).toBe(slot);
        expect(seen.has(idx)).toBe(false); // every (slot,lane) → a UNIQUE key
        seen.add(idx);
      }
    }
    expect(seen.size).toBe(CLIP_LANES * SCENE_STRIDE); // 512 distinct keys, no collisions
  });
});

describe('clip-key schema migration (v1 stride-8 → v2 stride-64)', () => {
  it('migrateLegacyClipKey re-keys every legacy key to its identical (lane, slot)', () => {
    for (let legacy = 0; legacy < CLIP_LANES * 8; legacy++) {
      const lane = Math.floor(legacy / 8);
      const slot = legacy % 8;
      // the new key must equal clipIndex(slot, lane) — i.e. the SAME (lane, slot).
      expect(migrateLegacyClipKey(legacy)).toBe(clipIndex(slot, lane));
      expect(laneOf(migrateLegacyClipKey(legacy))).toBe(lane);
      expect(slotOf(migrateLegacyClipKey(legacy))).toBe(slot);
    }
    // lane-0 legacy keys are stride-invariant (unchanged).
    for (let slot = 0; slot < 8; slot++) expect(migrateLegacyClipKey(slot)).toBe(slot);
    // lane 1 slot 0 legacy key 8 → 64; lane 7 slot 7 legacy key 63 → 455.
    expect(migrateLegacyClipKey(8)).toBe(64);
    expect(migrateLegacyClipKey(63)).toBe(455);
  });

  it('save-compat: a LEGACY player (stride-8 keys, no sv) loads with every clip at its identical (lane, slot)', () => {
    // Distinct clips in KNOWN (lane, slot) cells, keyed the OLD way (lane*8+slot).
    const cells: [number, number, string][] = [
      [0, 0, 'a'], // lane 0 slot 0 → legacy key 0
      [3, 0, 'b'], // lane 0 slot 3 → legacy key 3  (lane-0, invariant)
      [0, 1, 'c'], // lane 1 slot 0 → legacy key 8  → new key 64
      [5, 2, 'd'], // lane 2 slot 5 → legacy key 21 → new key 133
      [7, 7, 'e'], // lane 7 slot 7 → legacy key 63 → new key 455
    ];
    const mk = (name: string): NoteClipRecord => ({ ...defaultNoteClip(), name });
    const legacyClips: Record<string, NoteClipRecord> = {};
    for (const [slot, lane, name] of cells) legacyClips[String(lane * 8 + slot)] = mk(name);
    const data = { clips: legacyClips } as unknown as ClipPlayerData; // NO sv = legacy v1

    expect(migrateClipPlayerData(data)).toBe(true); // it migrated
    expect(data.sv).toBe(CLIP_SCHEMA_VERSION);
    // EVERY clip is now retrievable at the IDENTICAL (lane, slot) via the new key.
    for (const [slot, lane, name] of cells) {
      const rec = readClip(data, clipIndex(slot, lane)) as NoteClipRecord | null;
      expect(rec, `clip at (lane ${lane}, slot ${slot})`).not.toBeNull();
      expect(rec!.name).toBe(name);
    }
    // No legacy stride-8 key survives for a moved lane (lane 1's clip left key "8").
    expect(data.clips!['8']).toBeUndefined();
    // …but lane-0 keys are byte-identical in place (never moved/cloned).
    expect(data.clips!['0']).toBe(legacyClips['0']);
  });

  it('idempotent: re-running the migration is a no-op (returns false, data unchanged)', () => {
    const data = {
      clips: { [String(1 * 8 + 2)]: { ...defaultNoteClip(), name: 'x' } },
    } as unknown as ClipPlayerData;
    expect(migrateClipPlayerData(data)).toBe(true);
    const snapshot = JSON.stringify(data);
    expect(migrateClipPlayerData(data)).toBe(false); // already sv=2 → no-op
    expect(JSON.stringify(data)).toBe(snapshot); // byte-identical, no double re-key
    // clip is at (lane 1, slot 2), NOT re-keyed a second time.
    expect((readClip(data, clipIndex(2, 1)) as NoteClipRecord).name).toBe('x');
  });

  it('safe on empty / absent clips + on already-stride-64 data', () => {
    const empty = {} as ClipPlayerData;
    expect(migrateClipPlayerData(empty)).toBe(true); // stamps sv even with no clips
    expect(empty.sv).toBe(CLIP_SCHEMA_VERSION);
    const withEmptyMap = { clips: {} } as ClipPlayerData;
    expect(migrateClipPlayerData(withEmptyMap)).toBe(true);
    expect(withEmptyMap.sv).toBe(CLIP_SCHEMA_VERSION);
    // A player already stamped sv=2 (new stride-64 data) is left untouched.
    const already = { sv: CLIP_SCHEMA_VERSION, clips: { [String(clipIndex(8, 1))]: defaultNoteClip() } } as unknown as ClipPlayerData;
    expect(migrateClipPlayerData(already)).toBe(false);
    expect((readClip(already, clipIndex(8, 1)) as NoteClipRecord).kind).toBe('note');
    // nullish input is a no-op.
    expect(migrateClipPlayerData(undefined)).toBe(false);
    expect(migrateClipPlayerData(null)).toBe(false);
  });

  it('save-compat over a REAL @syncedstore/core Y.Doc: re-keys live clips without re-parenting', () => {
    const store = syncedStore<{ nodes: Record<string, { data?: ClipPlayerData }> }>({ nodes: {} });
    store.nodes['n'] = { data: { clips: {} } };
    const d = store.nodes['n']!.data!;
    // Seed legacy stride-8 clips on the LIVE store (lane 0 slot 1 + lane 2 slot 3).
    d.clips![String(0 * 8 + 1)] = { ...defaultNoteClip(), name: 'p' };
    d.clips![String(2 * 8 + 3)] = { ...defaultNoteClip(), name: 'q' };
    // Migrate in place, cloning each moved value to a PLAIN object (coerce) so a
    // live Y child is never re-parented ("Type already integrated").
    expect(() => migrateClipPlayerData(d, coerceClipRecord)).not.toThrow();
    expect(d.sv).toBe(CLIP_SCHEMA_VERSION);
    expect((readClip(d, clipIndex(1, 0)) as NoteClipRecord).name).toBe('p'); // lane 0 slot 1
    expect((readClip(d, clipIndex(3, 2)) as NoteClipRecord).name).toBe('q'); // lane 2 slot 3
    expect(d.clips![String(2 * 8 + 3)]).toBeUndefined(); // legacy key gone
  });
});

describe('defaultNoteClip', () => {
  it('is an empty in-key major clip rooted at C3', () => {
    const c = defaultNoteClip();
    expect(c.kind).toBe('note');
    expect(c.steps).toEqual([]);
    expect(c.lengthSteps).toBe(DEFAULT_CLIP_STEPS);
    expect(c.root).toBe(C3_MIDI);
    expect(c.scale).toBe('major');
    expect(c.loop).toBe(true);
  });
});

describe('coerceNoteEvent', () => {
  it('accepts a valid event and clamps optional fields', () => {
    expect(coerceNoteEvent({ step: 2, midi: 60 })).toEqual({ step: 2, midi: 60 });
    expect(coerceNoteEvent({ step: 0, midi: 60, velocity: 200, lengthSteps: 0, prob: 2 })).toEqual({
      step: 0,
      midi: 60,
      velocity: 127,
      lengthSteps: 1,
      prob: 1,
    });
  });
  it('rejects garbage / out-of-range', () => {
    expect(coerceNoteEvent(null)).toBeNull();
    expect(coerceNoteEvent({ step: -1, midi: 60 })).toBeNull();
    expect(coerceNoteEvent({ step: 0, midi: 9999 })).toBeNull();
    expect(coerceNoteEvent({ step: 0 })).toBeNull();
  });
});

describe('coerceClipRecord', () => {
  it('normalizes a note clip and drops bad events', () => {
    const c = coerceClipRecord({
      kind: 'note',
      steps: [{ step: 0, midi: 60 }, { step: 1, midi: 'x' }],
      lengthSteps: 8,
      root: 48,
      scale: 'minor',
    });
    expect(c?.kind).toBe('note');
    expect((c as NoteClipRecord).steps).toEqual([{ step: 0, midi: 60 }]);
    expect((c as NoteClipRecord).lengthSteps).toBe(8);
    expect((c as NoteClipRecord).scale).toBe('minor');
  });
  it('returns null for unknown / empty', () => {
    expect(coerceClipRecord(null)).toBeNull();
    expect(coerceClipRecord({ kind: 'bogus' })).toBeNull();
  });
});

describe('clampStepCount', () => {
  it('clamps to [1, MAX_CLIP_STEPS=128] and defaults bad input', () => {
    expect(MAX_CLIP_STEPS).toBe(128);
    expect(clampStepCount(0)).toBe(1);
    expect(clampStepCount(16)).toBe(16);
    expect(clampStepCount(128)).toBe(128);
    expect(clampStepCount(999)).toBe(MAX_CLIP_STEPS);
    expect(clampStepCount(NaN)).toBe(DEFAULT_CLIP_STEPS);
  });
});

// ---------------------------------------------------------------------------
// AUTOMATION lane (task #183) — the fork-independent record layer
// ---------------------------------------------------------------------------

const tgt = (nodeId: string, paramId: string) => ({ nodeId, paramId });

describe('automation: coerceAutomationEvent', () => {
  it('accepts finite step≥0 and clamps value to 0..1', () => {
    expect(coerceAutomationEvent({ step: 0, value: 0.5 })).toEqual({ step: 0, value: 0.5 });
    expect(coerceAutomationEvent({ step: 3.5, value: 2 })).toEqual({ step: 3.5, value: 1 });
    expect(coerceAutomationEvent({ step: 1, value: -1 })).toEqual({ step: 1, value: 0 });
  });
  it('rejects negative/NaN step or non-finite value', () => {
    expect(coerceAutomationEvent({ step: -1, value: 0.5 })).toBeNull();
    expect(coerceAutomationEvent({ step: NaN, value: 0.5 })).toBeNull();
    expect(coerceAutomationEvent({ step: 0, value: NaN })).toBeNull();
    expect(coerceAutomationEvent(null)).toBeNull();
  });
});

describe('automation: coerceAutoTrack (keyed track value — no MIDI identity, no target)', () => {
  it('normalizes a track value: step-sorts + filters events, carries interp', () => {
    const t = coerceAutoTrack({
      interp: 'hold',
      events: [
        { step: 2, value: 0.2 },
        { step: 0, value: 0.9 },
        { step: 1, value: 'bad' }, // dropped
      ],
    });
    expect(t).not.toBeNull();
    expect(t!.interp).toBe('hold');
    expect((t as unknown as Record<string, unknown>).channel).toBeUndefined(); // no MIDI identity
    expect(t!.events).toEqual([
      { step: 0, value: 0.9 },
      { step: 2, value: 0.2 },
    ]);
  });
  it('caps events at MAX_AUTOMATION_EVENTS (long-take guard)', () => {
    const events = Array.from({ length: MAX_AUTOMATION_EVENTS + 500 }, (_, i) => ({
      step: i,
      value: 0.5,
    }));
    const t = coerceAutoTrack({ events });
    expect(t!.events.length).toBe(MAX_AUTOMATION_EVENTS);
  });
  it('ignores a bad interp value; rejects a non-object', () => {
    expect(coerceAutoTrack({ interp: 'bogus', events: [] })!.interp).toBeUndefined();
    expect(coerceAutoTrack(null)).toBeNull();
    expect(coerceAutoTrack(3)).toBeNull();
  });
});

describe('automation: targetKey round-trip', () => {
  it('automationTargetKey ↔ parseAutomationTargetKey', () => {
    const t = tgt('nodeA', 'cutoff');
    expect(automationTargetKey(t)).toBe('nodeA::cutoff');
    expect(parseAutomationTargetKey('nodeA::cutoff')).toEqual(t);
  });
  it('rejects malformed keys', () => {
    expect(parseAutomationTargetKey('')).toBeNull();
    expect(parseAutomationTargetKey('nocolons')).toBeNull();
    expect(parseAutomationTargetKey('::param')).toBeNull();
    expect(parseAutomationTargetKey('node::')).toBeNull();
  });
});

describe('automation: coerceAutoClipRecord (the sibling auto[k] boundary)', () => {
  it('normalizes a record and enforces MAX_AUTOMATION_TRACKS', () => {
    expect(MAX_AUTOMATION_TRACKS).toBe(16);
    const tracks: Record<string, unknown> = {};
    for (let i = 0; i < 20; i++) tracks[`n${i}::p`] = { events: [{ step: 0, value: 0.5 }] };
    const rec = coerceAutoClipRecord({ tracks });
    expect(rec).not.toBeNull();
    expect(Object.keys(rec!.tracks).length).toBe(MAX_AUTOMATION_TRACKS);
  });
  it('drops malformed keys + unusable values, keeps the good tracks', () => {
    const rec = coerceAutoClipRecord({
      tracks: {
        'good::p': { events: [{ step: 0, value: 0.4 }] },
        'no-separator': { events: [] }, // malformed key → dropped
        '::param': { events: [] }, // empty nodeId → dropped
        'bad::value': 7, // unusable value → dropped
      },
    });
    expect(Object.keys(rec!.tracks)).toEqual(['good::p']);
    expect(rec!.tracks['good::p']!.events).toEqual([{ step: 0, value: 0.4 }]);
  });
  it('round-trips: coerce(coerce(x)) === coerce(x) (idempotent at the boundary)', () => {
    const raw = {
      tracks: {
        'a::x': { events: [{ step: 2, value: 0.2 }, { step: 0, value: 0.9 }], interp: 'hold' },
        'b::y': { events: [{ step: 1, value: 2 }] }, // clamps to 1
      },
    };
    const once = coerceAutoClipRecord(raw)!;
    const twice = coerceAutoClipRecord(once)!;
    expect(twice).toEqual(once);
    expect(once.tracks['a::x']!.events[0]).toEqual({ step: 0, value: 0.9 }); // sorted
    expect(once.tracks['b::y']!.events[0]).toEqual({ step: 1, value: 1 }); // clamped
  });
  it('readAutoClip returns null for absent / empty records', () => {
    expect(readAutoClip(undefined, 3)).toBeNull();
    expect(readAutoClip({}, 3)).toBeNull();
    expect(readAutoClip({ auto: {} }, 3)).toBeNull();
    expect(readAutoClip({ auto: { '3': { tracks: {} } } }, 3)).toBeNull(); // no tracks → null
    expect(
      readAutoClip({ auto: { '3': { tracks: { 'a::p': { events: [] } } } } }, 3),
    ).not.toBeNull();
  });
  it('autoTrackViews builds the runtime (target + events) views from the keyed record', () => {
    const rec = coerceAutoClipRecord({
      tracks: {
        'a::x': { events: [{ step: 0, value: 0.5 }], interp: 'linear' },
        'b::y': { events: [] },
      },
    });
    const views = autoTrackViews(rec);
    expect(views.length).toBe(2);
    const ax = views.find((v) => v.target.nodeId === 'a')!;
    expect(ax.target).toEqual(tgt('a', 'x'));
    expect(ax.interp).toBe('linear');
    expect(ax.events).toEqual([{ step: 0, value: 0.5 }]);
    expect(autoTrackViews(null)).toEqual([]);
  });
});

describe('automation: CLEAN BREAK — the retired stamped kind coerces away silently', () => {
  it('coerceClipRecord returns null for a legacy kind:"automation" clip (old saves load without crashing)', () => {
    const legacy = {
      kind: 'automation',
      lengthSteps: 64,
      loop: true,
      div: 1,
      tracks: [{ target: tgt('a', 'p'), events: [{ step: 0, value: 0.5 }] }],
    };
    expect(coerceClipRecord(legacy)).toBeNull(); // unknown kind → empty cell, no crash
    // …and reading it through readClip is equally safe.
    expect(readClip({ clips: { '448': legacy } }, 448)).toBeNull();
  });
  it('isAutomationArmed reflects the synced arm flag', () => {
    expect(isAutomationArmed(undefined)).toBe(false);
    expect(isAutomationArmed({})).toBe(false);
    expect(isAutomationArmed({ automation: { arm: false } })).toBe(false);
    expect(isAutomationArmed({ automation: { arm: true } })).toBe(true);
  });
});

// UI-CAN'T-LIE: the card's per-lane assigned-count chip row renders EXACTLY
// autoAssignCounts(data), and the record scope is EXACTLY laneAssignedTargets —
// these pin the single source so the readout can never disagree with the stored
// autoAssign map.
describe('automation: autoAssign (param → lane) reads', () => {
  it('coerceAutoAssign keeps only parsable keys with integer lanes 0..7', () => {
    expect(
      coerceAutoAssign({
        'a::x': 3,
        'b::y': 0,
        'bad-key': 2, // malformed key → dropped
        'c::z': 8, // lane out of range → dropped
        'd::w': 1.5, // non-integer → dropped
        'e::v': '2', // numeric string → forgiving coerce (house style: Number())
        'f::u': 'x', // non-numeric → dropped
      }),
    ).toEqual({ 'a::x': 3, 'b::y': 0, 'e::v': 2 });
    expect(coerceAutoAssign(undefined)).toEqual({});
    expect(coerceAutoAssign(null)).toEqual({});
    expect(coerceAutoAssign('nope')).toEqual({});
  });
  it('assignedLaneOf finds the lane for a target (or null)', () => {
    const data = { autoAssign: { 'a::x': 3 } };
    expect(assignedLaneOf(data, tgt('a', 'x'))).toBe(3);
    expect(assignedLaneOf(data, tgt('a', 'y'))).toBeNull();
    expect(assignedLaneOf(undefined, tgt('a', 'x'))).toBeNull();
  });
  it('laneAssignedTargets groups targets per lane (length CLIP_LANES)', () => {
    const data = {
      autoAssign: { 'a::x': 3, 'b::y': 3, 'c::z': 0 },
    };
    const byLane = laneAssignedTargets(data);
    expect(byLane.length).toBe(CLIP_LANES);
    expect(byLane[0]).toEqual([tgt('c', 'z')]);
    expect(byLane[3]!.map((t) => t.nodeId).sort()).toEqual(['a', 'b']);
    expect(byLane[5]).toEqual([]);
  });
  it('autoAssignCounts mirrors the map exactly (the chip-row source)', () => {
    expect(autoAssignCounts({ autoAssign: { 'a::x': 3, 'b::y': 3, 'c::z': 0 } })).toEqual([
      1, 0, 0, 2, 0, 0, 0, 0,
    ]);
    expect(autoAssignCounts(undefined)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });
});

describe('automation: mergeAutomationOverdub (punch-in)', () => {
  it('replaces only the [start,end) window, preserves events outside it', () => {
    const existing: AutomationEvent[] = [
      { step: 0, value: 0.1 },
      { step: 1, value: 0.2 },
      { step: 1.5, value: 0.25 },
      { step: 2, value: 0.3 },
      { step: 3, value: 0.4 },
    ];
    const incoming: AutomationEvent[] = [{ step: 1.2, value: 0.9 }];
    const merged = mergeAutomationOverdub(existing, incoming, 1, 2);
    expect(merged).toEqual([
      { step: 0, value: 0.1 },
      { step: 1.2, value: 0.9 },
      { step: 2, value: 0.3 }, // half-open: step 2 outside, kept
      { step: 3, value: 0.4 },
    ]);
  });
  it('WRAP window (start>end) keeps the middle [end,start), replaces the wrapped ends', () => {
    // 16-step clip; a punch from step 14 → 2 wraps: window = [14,16) ∪ [0,2).
    const existing: AutomationEvent[] = [
      { step: 0.5, value: 0.01 }, // in wrapped window → dropped
      { step: 4, value: 0.4 }, // middle → KEPT
      { step: 10, value: 0.6 }, // middle → KEPT
      { step: 15, value: 0.99 }, // in wrapped window → dropped
    ];
    const incoming: AutomationEvent[] = [
      { step: 15.5, value: 0.7 },
      { step: 1, value: 0.8 },
    ];
    const merged = mergeAutomationOverdub(existing, incoming, 14, 2);
    expect(merged).toEqual([
      { step: 1, value: 0.8 },
      { step: 4, value: 0.4 },
      { step: 10, value: 0.6 },
      { step: 15.5, value: 0.7 },
    ]);
  });
  it('clamps incoming values + caps at MAX_AUTOMATION_EVENTS', () => {
    const merged = mergeAutomationOverdub([], [{ step: 0.7, value: 3 }], 0, 16);
    expect(merged).toEqual([{ step: 0.7, value: 1 }]);
    const many = Array.from({ length: MAX_AUTOMATION_EVENTS + 10 }, (_, i) => ({ step: i, value: 0.5 }));
    expect(mergeAutomationOverdub([], many, 0, 99999).length).toBe(MAX_AUTOMATION_EVENTS);
  });
});

describe('automation lifecycle: clone / reverse / carrier probe (envelope-belongs-to-the-clip)', () => {
  const rec = () =>
    coerceAutoClipRecord({
      tracks: {
        'a::x': { events: [{ step: 0, value: 0.2 }, { step: 6, value: 0.9 }], interp: 'hold' },
        'b::y': { events: [{ step: 2, value: 0.5 }] },
      },
    })!;
  it('plainCloneAutoClip deep-clones (no shared refs) and nulls empties', () => {
    const src = rec();
    const clone = plainCloneAutoClip(src)!;
    expect(clone).toEqual(src);
    expect(clone).not.toBe(src);
    expect(clone.tracks['a::x']).not.toBe(src.tracks['a::x']);
    expect(clone.tracks['a::x']!.events[0]).not.toBe(src.tracks['a::x']!.events[0]);
    clone.tracks['a::x']!.events[0]!.value = 0.99;
    expect(src.tracks['a::x']!.events[0]!.value).toBe(0.2); // source untouched
    expect(plainCloneAutoClip(null)).toBeNull();
    expect(plainCloneAutoClip({ tracks: {} })).toBeNull(); // nothing to carry
  });
  it('reverseAutoClipRecord mirrors each event in time (step → len − step), re-sorted', () => {
    const out = reverseAutoClipRecord(rec(), 8);
    expect(out.tracks['a::x']!.events).toEqual([
      { step: 2, value: 0.9 }, // 8-6
      { step: 8, value: 0.2 }, // 8-0
    ]);
    expect(out.tracks['a::x']!.interp).toBe('hold'); // interp carried
    expect(out.tracks['b::y']!.events).toEqual([{ step: 6, value: 0.5 }]);
  });
  it('autoClipHasTracks: cheap raw probe (valid keys only)', () => {
    expect(autoClipHasTracks(rec())).toBe(true);
    expect(autoClipHasTracks({ tracks: {} })).toBe(false);
    expect(autoClipHasTracks({ tracks: { 'bad-key': { events: [] } } })).toBe(false);
    expect(autoClipHasTracks(null)).toBe(false);
    expect(autoClipHasTracks(7)).toBe(false);
  });
  it('readSceneAutos + sceneWritePlan carry each lane’s automation with its clip', () => {
    const data = {
      clips: { [String(clipIndex(2, 0))]: { kind: 'note', steps: [], lengthSteps: 8, root: 48, loop: true } },
      auto: { [String(clipIndex(2, 0))]: rec() },
    };
    const autos = readSceneAutos(data as never, 2);
    expect(autos[0]).toEqual(rec());
    expect(autos[1]).toBeNull();
    const clips = readScene(data as never, 2);
    const plan = sceneWritePlan(5, clips, autos);
    // Lane 0: clip + its automation land at slot 5 (re-cloned, not shared).
    expect(plan[0]!.index).toBe(clipIndex(5, 0));
    expect(plan[0]!.value).not.toBeNull();
    expect(plan[0]!.auto).toEqual(rec());
    expect(plan[0]!.auto).not.toBe(autos[0]); // re-cloned per paste
    // Lane 1: no clip → BOTH keys delete (no ghost envelope under an empty cell).
    expect(plan[1]!.value).toBeNull();
    expect(plan[1]!.auto).toBeNull();
  });
});

describe('automation: single-driver playback ownership (autoPlaybackOwners)', () => {
  const set = (...keys: string[]) => new Set(keys);
  it('unassigned → the LOWEST active carrier lane owns the key', () => {
    const owners = autoPlaybackOwners({}, [null, set('a::x'), set('a::x', 'b::y'), null]);
    expect(owners.get('a::x')).toBe(1);
    expect(owners.get('b::y')).toBe(2);
  });
  it('the ASSIGNED lane wins when it is an active carrier', () => {
    const owners = autoPlaybackOwners({ 'a::x': 2 }, [null, set('a::x'), set('a::x'), null]);
    expect(owners.get('a::x')).toBe(2);
  });
  it('an assigned lane that is NOT carrying falls back to the lowest carrier', () => {
    const owners = autoPlaybackOwners({ 'a::x': 5 }, [null, set('a::x'), set('a::x'), null]);
    expect(owners.get('a::x')).toBe(1); // lane 5 inactive/not carrying → lowest carrier
  });
  it('a key carried by ONE lane is owned by it regardless of assignment', () => {
    const owners = autoPlaybackOwners({ 'a::x': 0 }, [null, null, set('a::x')]);
    expect(owners.get('a::x')).toBe(2);
  });
});

describe('automation: ensureArmAutoShells (arm-time container pre-creation)', () => {
  it('creates shells ONLY for lanes with assigned params AND a playing note clip', () => {
    const d: ClipPlayerData = {
      clips: {
        [String(clipIndex(0, 0))]: { kind: 'note', steps: [], lengthSteps: 8, root: 48, loop: true },
        [String(clipIndex(1, 2))]: { kind: 'note', steps: [], lengthSteps: 8, root: 48, loop: true },
        [String(clipIndex(0, 3))]: { kind: 'note', steps: [], lengthSteps: 8, root: 48, loop: true },
      },
      playing: [0, null, 1, null, null, null, null, null], // lane 0 + lane 2 playing; lane 3 NOT
      autoAssign: { 'a::x': 0, 'b::y': 3 }, // lane 0 assigned+playing; lane 3 assigned+stopped
    };
    ensureArmAutoShells(d);
    expect(d.auto?.[String(clipIndex(0, 0))]).toEqual({ tracks: {} }); // lane 0 → shell
    expect(d.auto?.[String(clipIndex(1, 2))]).toBeUndefined(); // lane 2 playing but unassigned
    expect(d.auto?.[String(clipIndex(0, 3))]).toBeUndefined(); // lane 3 assigned but stopped
  });
  it('never replaces an EXISTING record (idempotent)', () => {
    const existing = { tracks: { 'a::x': { events: [{ step: 0, value: 0.5 }] } } };
    const d: ClipPlayerData = {
      clips: { '0': { kind: 'note', steps: [], lengthSteps: 8, root: 48, loop: true } },
      playing: [0, null, null, null, null, null, null, null],
      autoAssign: { 'a::x': 0 },
      auto: { '0': existing },
    };
    ensureArmAutoShells(d);
    expect(d.auto!['0']).toBe(existing); // untouched
  });
});

describe('automation: autoAssignCounts exists-filter (dangling targets not counted)', () => {
  it('filters out targets whose module is gone', () => {
    const data = { autoAssign: { 'alive::x': 2, 'gone::y': 2 } };
    expect(autoAssignCounts(data)).toEqual([0, 0, 2, 0, 0, 0, 0, 0]);
    expect(autoAssignCounts(data, (t) => t.nodeId === 'alive')).toEqual([0, 0, 1, 0, 0, 0, 0, 0]);
  });
});

describe('automation: sameAutomationTarget', () => {
  it('matches by (nodeId, paramId)', () => {
    expect(sameAutomationTarget(tgt('a', 'x'), tgt('a', 'x'))).toBe(true);
    expect(sameAutomationTarget(tgt('a', 'x'), tgt('a', 'y'))).toBe(false);
    expect(sameAutomationTarget(tgt('a', 'x'), tgt('b', 'x'))).toBe(false);
  });
});

describe('automation: playback reads (hold-last, linear, next-after)', () => {
  const events: AutomationEvent[] = [
    { step: 0, value: 0.1 },
    { step: 2, value: 0.5 },
    { step: 4, value: 0.9 },
  ];
  it('automationValueAt holds the last breakpoint at or before the step', () => {
    expect(automationValueAt(events, 0)).toBe(0.1);
    expect(automationValueAt(events, 1.9)).toBe(0.1);
    expect(automationValueAt(events, 2)).toBe(0.5);
    expect(automationValueAt(events, 100)).toBe(0.9);
  });
  it('automationValueAt returns null before the first breakpoint', () => {
    expect(automationValueAt([{ step: 2, value: 0.5 }], 1)).toBeNull();
    expect(automationValueAt([], 5)).toBeNull();
  });
  it('automationLinearAt interpolates between breakpoints', () => {
    expect(automationLinearAt(events, 0)).toBe(0.1);
    expect(automationLinearAt(events, 1)).toBeCloseTo(0.3, 9); // halfway 0.1→0.5
    expect(automationLinearAt(events, 3)).toBeCloseTo(0.7, 9); // halfway 0.5→0.9
    expect(automationLinearAt(events, 100)).toBe(0.9); // holds past last
    expect(automationLinearAt(events, -1)).toBeNull(); // before first
    expect(automationLinearAt([], 0)).toBeNull();
  });
  it('automationNextAfter finds the first breakpoint strictly after step', () => {
    expect(automationNextAfter(events, 0)).toEqual({ step: 2, value: 0.5 });
    expect(automationNextAfter(events, 2)).toEqual({ step: 4, value: 0.9 });
    expect(automationNextAfter(events, 4)).toBeNull();
    expect(automationNextAfter(events, 3.9)).toEqual({ step: 4, value: 0.9 });
  });
});

describe('readClip', () => {
  it('reads + coerces a slot, null when empty/absent', () => {
    const data = { clips: { '5': { kind: 'note', steps: [], lengthSteps: 16, root: 48 } } };
    expect(readClip(data, 5)?.kind).toBe('note');
    expect(readClip(data, 6)).toBeNull();
    expect(readClip(undefined, 0)).toBeNull();
  });
});

describe('lanesForStep', () => {
  const clip: NoteClipRecord = {
    kind: 'note',
    lengthSteps: 16,
    root: C3_MIDI,
    loop: true,
    steps: [
      { step: 0, midi: 60, velocity: 127, lengthSteps: 2 },
      { step: 0, midi: 64 }, // chord with above
      { step: 4, midi: 67, velocity: 64 },
    ],
  };
  it('returns chord lanes + max velocity + max gate width on a step with notes', () => {
    const r = lanesForStep(clip, 0);
    expect(r.any).toBe(true);
    expect(r.lanes).toEqual([
      { pitch: midiToVOct(60), gate: 1 },
      { pitch: midiToVOct(64), gate: 1 },
    ]);
    expect(r.velocity).toBeCloseTo(1, 5); // 127/127
    expect(r.gateSteps).toBe(2);
  });
  it('maps velocity to 0..1', () => {
    const r = lanesForStep(clip, 4);
    expect(r.velocity).toBeCloseTo(64 / 127, 5);
  });
  it('is empty on a silent step', () => {
    const r = lanesForStep(clip, 1);
    expect(r.any).toBe(false);
    expect(r.lanes).toEqual([]);
  });
  it('finds notes starting at a step', () => {
    expect(notesStartingAt(clip, 0)).toHaveLength(2);
    expect(notesStartingAt(clip, 9)).toHaveLength(0);
  });
});

describe('note-editor row math', () => {
  it('chromatic rows are +1 semitone from root', () => {
    expect(scaleSteps(undefined)).toHaveLength(12);
    expect(rowToMidi(0, 48)).toBe(48);
    expect(rowToMidi(1, 48)).toBe(49);
    expect(rowToMidi(12, 48)).toBe(60);
    expect(rowToMidi(-1, 48)).toBe(47);
  });
  it('in-key major rows are scale degrees (7 rows per octave)', () => {
    // C major from C3 (48): C D E F G A B C → 48 50 52 53 55 57 59 60
    expect(rowToMidi(0, 48, 'major')).toBe(48);
    expect(rowToMidi(1, 48, 'major')).toBe(50);
    expect(rowToMidi(2, 48, 'major')).toBe(52);
    expect(rowToMidi(6, 48, 'major')).toBe(59);
    expect(rowToMidi(7, 48, 'major')).toBe(60); // next octave's root
  });
  it('midiToRow inverts rowToMidi and rejects out-of-scale notes', () => {
    for (const row of [0, 1, 2, 6, 7, 13]) {
      const m = rowToMidi(row, 48, 'major');
      expect(midiToRow(m, 48, 'major')).toBe(row);
    }
    // C#3 (49) is not in C major → no row.
    expect(midiToRow(49, 48, 'major')).toBeNull();
    // chromatic accepts everything.
    expect(midiToRow(49, 48)).toBe(1);
  });
});

describe('toggleNoteAt', () => {
  it('adds then removes a note immutably (default velocity)', () => {
    const c0 = defaultNoteClip();
    const c1 = toggleNoteAt(c0, 3, 60);
    expect(c1.steps).toEqual([{ step: 3, midi: 60, velocity: VEL_DEFAULT, lengthSteps: 1 }]);
    expect(c0.steps).toEqual([]); // original untouched
    const c2 = toggleNoteAt(c1, 3, 60);
    expect(c2.steps).toEqual([]);
  });

  it('MONO: adding a note in a column REPLACES the note already there', () => {
    // A note at (step 3, midi 60); placing a different pitch in column 3 replaces it.
    const c0 = { ...defaultNoteClip(), steps: [{ step: 3, midi: 60, velocity: 100, lengthSteps: 1 }] };
    const c1 = toggleNoteAt(c0, 3, 64, { mono: true });
    expect(c1.steps).toHaveLength(1);
    expect(c1.steps[0]).toMatchObject({ step: 3, midi: 64 });
  });

  it('MONO: replaces even a HELD note covering the column', () => {
    const c0 = { ...defaultNoteClip(), steps: [{ step: 2, midi: 60, velocity: 100, lengthSteps: 4 }] };
    const c1 = toggleNoteAt(c0, 4, 67, { mono: true }); // step 4 is inside the held span
    expect(c1.steps).toHaveLength(1);
    expect(c1.steps[0]).toMatchObject({ step: 4, midi: 67, lengthSteps: 1 });
  });

  it('POLY caps a column at maxVoices, re-using the OLDEST voice', () => {
    // Fill column 0 with POLY_CHANNEL_PAIRS voices (the poly width), then add
    // one more → the oldest (the first note added) is dropped.
    let c: NoteClipRecord = defaultNoteClip();
    const oldest = 48;
    for (let i = 0; i < POLY_CHANNEL_PAIRS; i++) c = toggleNoteAt(c, 0, oldest + i);
    expect(c.steps.filter((e) => e.step === 0)).toHaveLength(POLY_CHANNEL_PAIRS);
    const overflowMidi = oldest + POLY_CHANNEL_PAIRS;
    const cOver = toggleNoteAt(c, 0, overflowMidi); // one over → drop the oldest
    const col = cOver.steps.filter((e) => e.step === 0);
    expect(col).toHaveLength(POLY_CHANNEL_PAIRS);
    expect(col.some((e) => e.midi === oldest)).toBe(false); // oldest re-used
    expect(col.some((e) => e.midi === overflowMidi)).toBe(true); // newest present
  });

  it('POLY cap leaves OTHER columns untouched', () => {
    let c: NoteClipRecord = defaultNoteClip();
    for (const m of [60, 62, 64, 65, 67]) c = toggleNoteAt(c, 0, m);
    c = toggleNoteAt(c, 1, 72); // a different column
    expect(c.steps.filter((e) => e.step === 1)).toHaveLength(1);
    expect(c.steps.filter((e) => e.step === 0)).toHaveLength(5);
  });
});

describe('laneMono', () => {
  it('reads the per-lane mono flag (default poly)', () => {
    expect(laneMono(undefined, 0)).toBe(false);
    expect(laneMono({ mono: [true, false] }, 0)).toBe(true);
    expect(laneMono({ mono: [true, false] }, 1)).toBe(false);
    expect(laneMono({ mono: [true] }, 5)).toBe(false);
  });
});

describe('laneMuted (P3 — advance-but-silent)', () => {
  it('reads the per-lane mute flag; a missing/short array is back-compat all-live', () => {
    expect(laneMuted(undefined, 0)).toBe(false); // no field → live
    expect(laneMuted({}, 0)).toBe(false);
    expect(laneMuted({ muted: [true, false] }, 0)).toBe(true);
    expect(laneMuted({ muted: [true, false] }, 1)).toBe(false);
    expect(laneMuted({ muted: [true] }, 5)).toBe(false); // short array → live
  });
});

describe('per-lane CLIP COLOR helpers', () => {
  it('coerceLaneColor keeps a valid hex, lowercasing + expanding #rgb → #rrggbb', () => {
    expect(coerceLaneColor('#aabbcc')).toBe('#aabbcc');
    expect(coerceLaneColor('#AABBCC')).toBe('#aabbcc'); // lowercased
    expect(coerceLaneColor('#F0A')).toBe('#ff00aa'); // #rgb expanded
    expect(coerceLaneColor('  #FfEe00  ')).toBe('#ffee00'); // trimmed + lowercased
  });
  it('coerceLaneColor rejects non-hex / null / wrong-length ⇒ null', () => {
    expect(coerceLaneColor(null)).toBeNull();
    expect(coerceLaneColor(undefined)).toBeNull();
    expect(coerceLaneColor(0xff00aa)).toBeNull(); // a number, not a string
    expect(coerceLaneColor('red')).toBeNull(); // named colors not accepted
    expect(coerceLaneColor('#12')).toBeNull(); // too short (2 digits)
    expect(coerceLaneColor('#12345')).toBeNull(); // 5 digits
    expect(coerceLaneColor('#1234567')).toBeNull(); // 7 digits
    expect(coerceLaneColor('#gggggg')).toBeNull(); // non-hex digits
    expect(coerceLaneColor('aabbcc')).toBeNull(); // missing '#'
    expect(coerceLaneColor('')).toBeNull();
  });
  it('coerceLaneColors normalizes to exactly CLIP_LANES entries (missing/short ⇒ null)', () => {
    const out = coerceLaneColors(['#f00', 'nope', '#00FF00']);
    expect(out).toHaveLength(CLIP_LANES);
    expect(out[0]).toBe('#ff0000'); // #rgb expanded + kept
    expect(out[1]).toBeNull(); // invalid entry ⇒ null
    expect(out[2]).toBe('#00ff00'); // lowercased
    for (let i = 3; i < CLIP_LANES; i++) expect(out[i]).toBeNull(); // short ⇒ padded null
  });
  it('coerceLaneColors on a non-array (absent/corrupt) ⇒ all nulls, still length CLIP_LANES', () => {
    for (const raw of [undefined, null, 'nope', 42]) {
      const out = coerceLaneColors(raw);
      expect(out).toHaveLength(CLIP_LANES);
      expect(out.every((c) => c === null)).toBe(true);
    }
  });
  it('laneColor reads a per-lane entry, null when absent/short/corrupt', () => {
    expect(laneColor({ laneColor: ['#abcdef', '#123'] }, 0)).toBe('#abcdef');
    expect(laneColor({ laneColor: ['#abcdef', '#123'] }, 1)).toBe('#112233'); // #rgb expanded
    expect(laneColor({ laneColor: ['#abcdef'] }, 3)).toBeNull(); // short array
    expect(laneColor(undefined, 0)).toBeNull();
    expect(laneColor({}, 0)).toBeNull();
    expect(laneColor({ laneColor: 'nope' } as unknown as ClipPlayerData, 0)).toBeNull();
    expect(laneColor({ laneColor: ['bad'] }, 0)).toBeNull(); // corrupt entry ⇒ null
  });
});

describe('per-lane index + state helpers', () => {
  it('laneOf / slotOf split a flat index (lane*SCENE_STRIDE + slot)', () => {
    expect([laneOf(0), slotOf(0)]).toEqual([0, 0]);
    expect([laneOf(SCENE_STRIDE + 1), slotOf(SCENE_STRIDE + 1)]).toEqual([1, 1]); // lane 1 slot 1
    expect([laneOf(63), slotOf(63)]).toEqual([0, 63]); // stride-64: 63 is lane 0 slot 63
    expect([laneOf(clipIndex(7, 7)), slotOf(clipIndex(7, 7))]).toEqual([7, 7]);
  });
  it('lanePlaying / laneQueued read the per-lane arrays', () => {
    const data = {
      playing: [null, 3, null, null, null, null, null, null],
      queued: ['stop', 2, null, null, null, null, null, null] as (number | 'stop' | null)[],
    };
    expect(lanePlaying(data, 1)).toBe(3);
    expect(lanePlaying(data, 0)).toBeNull();
    expect(lanePlaying(undefined, 0)).toBeNull();
    expect(laneQueued(data, 0)).toBe('stop');
    expect(laneQueued(data, 1)).toBe(2);
    expect(laneQueued(data, 2)).toBeNull();
  });
  it('playingSet normalizes to exactly CLIP_LANES entries', () => {
    expect(playingSet({ playing: [1] })).toHaveLength(CLIP_LANES);
    expect(playingSet(undefined)).toEqual(new Array(CLIP_LANES).fill(null));
    expect(playingSet({ playing: [1] })[0]).toBe(1);
  });
});

describe('held notes (the hold-pad + tap-another tie gesture)', () => {
  it('setNoteSpan makes one held note across lo..hi, merging the row', () => {
    const c0 = defaultNoteClip();
    const c1 = setNoteSpan(c0, 2, 5, 60);
    expect(c1.steps).toHaveLength(1);
    expect(c1.steps[0]).toMatchObject({ step: 2, midi: 60, lengthSteps: 4 });
    expect(c0.steps).toEqual([]); // immutable
  });
  it('setNoteSpan normalizes order + removes overlapping notes in the row', () => {
    const c0 = { ...defaultNoteClip(), steps: [{ step: 4, midi: 60, lengthSteps: 1 }] };
    const c1 = setNoteSpan(c0, 5, 2, 60); // hi/lo swapped; covers the existing step-4 note
    expect(c1.steps).toHaveLength(1);
    expect(c1.steps[0]).toMatchObject({ step: 2, midi: 60, lengthSteps: 4 });
  });
  it('noteCovering reports a held note across its whole span (not just the start)', () => {
    const clip = { ...defaultNoteClip(), steps: [{ step: 2, midi: 60, lengthSteps: 3 }] };
    expect(noteCovering(clip, 2, 60)).toBeDefined(); // start
    expect(noteCovering(clip, 4, 60)).toBeDefined(); // held tail
    expect(noteCovering(clip, 5, 60)).toBeUndefined(); // past the span
    expect(noteCovering(clip, 3, 62)).toBeUndefined(); // wrong row
  });
  it('setNoteSpan MONO clears notes in OTHER rows across the span too', () => {
    const c0 = {
      ...defaultNoteClip(),
      steps: [
        { step: 3, midi: 64, lengthSteps: 1 }, // a note inside the span, different row
        { step: 9, midi: 67, lengthSteps: 1 }, // a note OUTSIDE the span — survives
      ],
    };
    const c1 = setNoteSpan(c0, 2, 5, 60, { mono: true });
    // Only the new held note + the out-of-span note remain.
    expect(c1.steps).toHaveLength(2);
    expect(c1.steps.some((e) => e.midi === 64)).toBe(false); // cleared (in span)
    expect(c1.steps.some((e) => e.step === 9 && e.midi === 67)).toBe(true); // kept
    expect(c1.steps.find((e) => e.midi === 60)).toMatchObject({ step: 2, lengthSteps: 4 });
  });
});

describe('nextScale (the grid SCALE pad / card scale cycle)', () => {
  it('cycles through all six named scales then chromatic, wrapping to major', () => {
    expect(nextScale('major')).toBe('minor');
    expect(nextScale('minor')).toBe('pentatonic');
    expect(nextScale('pentatonic')).toBe('dorian');
    expect(nextScale('dorian')).toBe('phrygian');
    expect(nextScale('phrygian')).toBe('mixolydian');
    expect(nextScale('mixolydian')).toBeUndefined(); // chromatic
    expect(nextScale(undefined)).toBe('major'); // wraps from chromatic
  });
  it('SCALE_CYCLE = the six named scales followed by undefined (chromatic)', () => {
    expect(SCALE_CYCLE).toEqual([
      'major', 'minor', 'pentatonic', 'dorian', 'phrygian', 'mixolydian', undefined,
    ]);
    expect(SCALE_NAMES).toEqual([
      'major', 'minor', 'pentatonic', 'dorian', 'phrygian', 'mixolydian',
    ]);
  });
});

describe('scaleSteps for the added modes', () => {
  it('returns the canonical semitone set for each new mode', () => {
    expect(scaleSteps('dorian')).toEqual([0, 2, 3, 5, 7, 9, 10]);
    expect(scaleSteps('phrygian')).toEqual([0, 1, 3, 5, 7, 8, 10]);
    expect(scaleSteps('mixolydian')).toEqual([0, 2, 4, 5, 7, 9, 10]);
  });
  it('in-key rows walk the mode degrees (dorian from C3=48)', () => {
    // C dorian: C D E♭ F G A B♭ C → 48 50 51 53 55 57 58 60
    expect(rowToMidi(0, 48, 'dorian')).toBe(48);
    expect(rowToMidi(2, 48, 'dorian')).toBe(51); // E♭ (the minor 3rd)
    expect(rowToMidi(5, 48, 'dorian')).toBe(57); // A (the raised 6th)
    expect(rowToMidi(7, 48, 'dorian')).toBe(60); // next octave's root
  });
});

describe('coerceScaleName + scale round-trip on load', () => {
  it('accepts every named scale (incl. the 3 new ones)', () => {
    for (const s of SCALE_NAMES) expect(coerceScaleName(s)).toBe(s);
  });
  it('unknown / legacy / absent ⇒ undefined (chromatic)', () => {
    expect(coerceScaleName('ionian')).toBeUndefined(); // dropped alias
    expect(coerceScaleName('aeolian')).toBeUndefined();
    expect(coerceScaleName('chromatic')).toBeUndefined(); // chromatic = absence
    expect(coerceScaleName('bogus')).toBeUndefined();
    expect(coerceScaleName(undefined)).toBeUndefined();
    expect(coerceScaleName(3)).toBeUndefined();
  });
  it('coerceClipRecord round-trips each new mode', () => {
    for (const scale of ['dorian', 'phrygian', 'mixolydian'] as const) {
      const c = coerceClipRecord({ kind: 'note', steps: [], lengthSteps: 8, root: 48, scale });
      expect((c as NoteClipRecord).scale).toBe(scale);
    }
  });
  it('coerceClipRecord drops an unknown scale (legacy → chromatic)', () => {
    const c = coerceClipRecord({ kind: 'note', steps: [], lengthSteps: 8, root: 48, scale: 'ionian' });
    expect('scale' in (c as NoteClipRecord)).toBe(false);
  });
});

describe('per-clip div coercion', () => {
  it('clamps a finite div to a valid RATE index, rounding', () => {
    expect((coerceClipRecord({ kind: 'note', steps: [], lengthSteps: 8, root: 48, div: 0 }) as NoteClipRecord).div).toBe(0);
    expect((coerceClipRecord({ kind: 'note', steps: [], lengthSteps: 8, root: 48, div: 5 }) as NoteClipRecord).div).toBe(5);
    expect((coerceClipRecord({ kind: 'note', steps: [], lengthSteps: 8, root: 48, div: 2.4 }) as NoteClipRecord).div).toBe(2);
    expect((coerceClipRecord({ kind: 'note', steps: [], lengthSteps: 8, root: 48, div: 99 }) as NoteClipRecord).div).toBe(5); // clamp high
    expect((coerceClipRecord({ kind: 'note', steps: [], lengthSteps: 8, root: 48, div: -3 }) as NoteClipRecord).div).toBe(0); // clamp low
  });
  it('missing / non-numeric div ⇒ undefined (clip follows the lane rate)', () => {
    expect((coerceClipRecord({ kind: 'note', steps: [], lengthSteps: 8, root: 48 }) as NoteClipRecord).div).toBeUndefined();
    expect((coerceClipRecord({ kind: 'note', steps: [], lengthSteps: 8, root: 48, div: 'x' }) as NoteClipRecord).div).toBeUndefined();
    expect((coerceClipRecord({ kind: 'note', steps: [], lengthSteps: 8, root: 48, div: NaN }) as NoteClipRecord).div).toBeUndefined();
  });
  it('copyClip preserves an explicit div (and omits it when absent)', () => {
    const withDiv: NoteClipRecord = { kind: 'note', steps: [], lengthSteps: 8, root: 48, loop: true, div: 4 };
    expect(copyClip(withDiv).div).toBe(4);
    const noDiv: NoteClipRecord = { kind: 'note', steps: [], lengthSteps: 8, root: 48, loop: true };
    expect('div' in copyClip(noDiv)).toBe(false);
  });
});

describe('per-lane SWING helpers', () => {
  it('MAX_SWING matches the DRUMSEQZ range (0..0.75)', () => {
    expect(MAX_SWING).toBe(0.75);
  });
  it('clampSwing clamps to [0, MAX_SWING] and defaults garbage to 0', () => {
    expect(clampSwing(0)).toBe(0);
    expect(clampSwing(0.5)).toBe(0.5);
    expect(clampSwing(0.75)).toBe(0.75);
    expect(clampSwing(2)).toBe(0.75); // clamp high
    expect(clampSwing(-1)).toBe(0); // clamp low
    expect(clampSwing(NaN)).toBe(0);
    expect(clampSwing(undefined)).toBe(0);
    expect(clampSwing('nope')).toBe(0);
  });
  it('laneSwing reads a per-lane entry, 0 when absent/short/corrupt', () => {
    expect(laneSwing({ swing: [0.5, 0.25, 0] }, 0)).toBe(0.5);
    expect(laneSwing({ swing: [0.5, 0.25, 0] }, 1)).toBe(0.25);
    expect(laneSwing({ swing: [2] }, 0)).toBe(0.75); // clamped
    expect(laneSwing(undefined, 0)).toBe(0);
    expect(laneSwing({}, 0)).toBe(0);
    expect(laneSwing({ swing: 'nope' }, 0)).toBe(0);
    expect(laneSwing({ swing: [0.5] }, 3)).toBe(0); // short array
  });
  it('swingStepOffset delays ODD steps by swing*stepDur, EVEN steps stay on grid', () => {
    // stepDur 0.25, swing 0.5 → odd steps push late by 0.125, even steps 0.
    expect(swingStepOffset(0, 0.5, 0.25)).toBe(0);
    expect(swingStepOffset(1, 0.5, 0.25)).toBe(0.125);
    expect(swingStepOffset(2, 0.5, 0.25)).toBe(0);
    expect(swingStepOffset(3, 0.5, 0.25)).toBe(0.125);
    // a different amount + a clamp inside the helper
    expect(swingStepOffset(1, 0.25, 0.4)).toBeCloseTo(0.1, 10);
    expect(swingStepOffset(1, 2, 0.25)).toBe(0.1875); // clamped to 0.75 → 0.75*0.25
  });
  it('swing 0 ⇒ every step offset is 0 (the un-swung even grid)', () => {
    for (let i = 0; i < 8; i++) expect(swingStepOffset(i, 0, 0.25)).toBe(0);
  });
  it('isSwingCentered is true only at 0 (within epsilon)', () => {
    expect(isSwingCentered(0)).toBe(true);
    expect(isSwingCentered(1e-12)).toBe(true);
    expect(isSwingCentered(0.02)).toBe(false);
    expect(isSwingCentered(0.75)).toBe(false);
  });
});

describe('VELOCITY-hold velocity cycle (6 levels)', () => {
  it('six levels span 0..127 in ~20% steps', () => {
    expect(VEL_LEVELS).toEqual([0, 25, 51, 76, 102, 127]);
    expect(VEL_LEVELS[0] / 127).toBeCloseTo(0, 2);
    expect(VEL_LEVELS[5] / 127).toBeCloseTo(1, 2);
  });
  it('cycleVelocity: empty → default, then steps UP through all six, wrapping', () => {
    const c0 = defaultNoteClip();
    let c = cycleVelocity(c0, 3, 60); // places at VEL_DEFAULT
    expect(noteAt(c, 3, 60)?.velocity).toBe(VEL_DEFAULT);
    // From the default, cycling advances through the levels and wraps back to it.
    const startIdx = VEL_LEVELS.indexOf(VEL_DEFAULT);
    for (let i = 1; i <= VEL_LEVELS.length; i++) {
      c = cycleVelocity(c, 3, 60);
      const expected = VEL_LEVELS[(startIdx + i) % VEL_LEVELS.length];
      expect(noteAt(c, 3, 60)?.velocity).toBe(expected);
    }
    expect(noteAt(c, 3, 60)?.velocity).toBe(VEL_DEFAULT); // full wrap
    expect(c0.steps).toEqual([]); // immutable
  });
  it('cycleVelocity changes the COVERING held note (press anywhere in its span)', () => {
    const clip = { ...defaultNoteClip(), steps: [{ step: 2, midi: 60, velocity: VEL_LEVELS[0], lengthSteps: 3 }] };
    const next = cycleVelocity(clip, 4, 60); // press a held-tail cell → level 0 → level 1
    expect(noteAt(next, 2, 60)?.velocity).toBe(VEL_LEVELS[1]);
  });
  it('velLevelIndex snaps a raw velocity to the nearest of the 6 levels', () => {
    expect(velLevelIndex(0)).toBe(0);
    expect(velLevelIndex(127)).toBe(5);
    expect(velLevelIndex(76)).toBe(3);
    expect(velLevelIndex(100)).toBe(4); // nearest 102
    expect(velLevelIndex(undefined)).toBe(velLevelIndex(VEL_DEFAULT));
  });
  it('velBucket folds the 6 levels into 3 display colours (2 per colour)', () => {
    // levels {0,1}→0, {2,3}→1, {4,5}→2
    expect(VEL_LEVELS.map((v) => velBucket(v))).toEqual([0, 0, 1, 1, 2, 2]);
  });
});

describe('doubleNoteClip', () => {
  const c = (lengthSteps: number, steps: NoteEvent[]): NoteClipRecord => ({
    ...defaultNoteClip(),
    lengthSteps,
    steps,
  });
  it('16 → 32 with the first half duplicated into the second', () => {
    const c0 = c(16, [{ step: 0, midi: 60, lengthSteps: 1 }, { step: 4, midi: 64, lengthSteps: 2 }]);
    const d = doubleNoteClip(c0);
    expect(d.lengthSteps).toBe(32);
    // originals kept …
    expect(d.steps).toContainEqual({ step: 0, midi: 60, lengthSteps: 1 });
    expect(d.steps).toContainEqual({ step: 4, midi: 64, lengthSteps: 2 });
    // … plus their mirror at +16.
    expect(d.steps).toContainEqual({ step: 16, midi: 60, lengthSteps: 1 });
    expect(d.steps).toContainEqual({ step: 20, midi: 64, lengthSteps: 2 });
    expect(c0.steps).toHaveLength(2); // immutable
  });
  it('17 → 34, including a copy that lands in the second half (partial tail kept)', () => {
    const c0 = c(17, [{ step: 0, midi: 60, lengthSteps: 1 }, { step: 16, midi: 67, lengthSteps: 1 }]);
    const d = doubleNoteClip(c0);
    expect(d.lengthSteps).toBe(34);
    expect(d.steps).toContainEqual({ step: 0, midi: 60, lengthSteps: 1 });
    expect(d.steps).toContainEqual({ step: 16, midi: 67, lengthSteps: 1 }); // original
    expect(d.steps).toContainEqual({ step: 17, midi: 60, lengthSteps: 1 }); // mirror of step-0
    expect(d.steps).toContainEqual({ step: 33, midi: 67, lengthSteps: 1 }); // mirror of step-16 (33 < 34)
  });
  it('65 → 128 (capped), truncating copies that would start past 128', () => {
    const c0 = c(65, [
      { step: 0, midi: 60, lengthSteps: 1 },   // mirror → 65 (< 128, kept)
      { step: 63, midi: 62, lengthSteps: 1 },  // mirror → 128 (>= 128, DROPPED)
      { step: 64, midi: 64, lengthSteps: 1 },  // mirror → 129 (>= 128, DROPPED)
    ]);
    const d = doubleNoteClip(c0);
    expect(d.lengthSteps).toBe(128);
    expect(d.steps).toContainEqual({ step: 65, midi: 60, lengthSteps: 1 }); // kept
    expect(d.steps.some((e) => e.step === 128)).toBe(false); // dropped (at the cap)
    expect(d.steps.some((e) => e.step === 129)).toBe(false); // dropped (past the cap)
    // originals all survive
    expect(d.steps.filter((e) => e.step < 65)).toHaveLength(3);
  });
  it('at MAX_CLIP_STEPS (128) it is a no-op returning the SAME reference', () => {
    const c0 = c(128, [{ step: 0, midi: 60, lengthSteps: 1 }]);
    expect(doubleNoteClip(c0)).toBe(c0); // identity → caller skips the write
  });
  it('clamps a copied held note so it cannot bleed past the new length', () => {
    // length 65 → 128; a held note near the end whose mirror would overrun 128.
    const c0 = c(65, [{ step: 60, midi: 60, lengthSteps: 4 }]); // mirror at 125, span 4 → 129
    const d = doubleNoteClip(c0);
    const mirror = d.steps.find((e) => e.step === 125);
    expect(mirror).toBeDefined();
    expect(mirror!.step + (mirror!.lengthSteps ?? 1)).toBeLessThanOrEqual(128); // clamped, no bleed
    expect(mirror!.lengthSteps).toBe(3); // 128 - 125
  });
});

describe('reverseClipSteps', () => {
  const c = (lengthSteps: number, steps: NoteEvent[]): NoteClipRecord => ({
    ...defaultNoteClip(),
    lengthSteps,
    steps,
  });
  it('mirrors a single-step note across the clip length', () => {
    const r = reverseClipSteps(c(16, [{ step: 0, midi: 60, lengthSteps: 1 }]));
    // start 0, span 1 → mirroredStart = 16 - (0+1) = 15.
    expect(r.steps).toEqual([{ step: 15, midi: 60, lengthSteps: 1 }]);
  });
  it('re-anchors a MULTI-STEP held span to the mirrored END (not Array.reverse)', () => {
    // a 3-step held note at step 2 (covers 2,3,4) in a 16-step clip.
    const r = reverseClipSteps(c(16, [{ step: 2, midi: 60, lengthSteps: 3 }]));
    // mirroredStart = 16 - (2+3) = 11; still a 3-step note (covers 11,12,13).
    expect(r.steps).toEqual([{ step: 11, midi: 60, lengthSteps: 3 }]);
  });
  it('a span anchored at step 0 mirrors to the clip end', () => {
    const r = reverseClipSteps(c(16, [{ step: 0, midi: 60, lengthSteps: 4 }])); // covers 0..3
    // mirroredStart = 16 - (0+4) = 12; covers 12..15.
    expect(r.steps).toEqual([{ step: 12, midi: 60, lengthSteps: 4 }]);
  });
  it('preserves multiple notes (full forward→reverse symmetry)', () => {
    const fwd = c(8, [
      { step: 0, midi: 60, lengthSteps: 2 }, // → 8-(0+2)=6
      { step: 6, midi: 64, lengthSteps: 1 }, // → 8-(6+1)=1
    ]);
    const r = reverseClipSteps(fwd);
    expect(r.steps).toContainEqual({ step: 6, midi: 60, lengthSteps: 2 });
    expect(r.steps).toContainEqual({ step: 1, midi: 64, lengthSteps: 1 });
    // reversing twice round-trips back to the original positions.
    const back = reverseClipSteps(r);
    expect(back.steps).toContainEqual({ step: 0, midi: 60, lengthSteps: 2 });
    expect(back.steps).toContainEqual({ step: 6, midi: 64, lengthSteps: 1 });
    expect(fwd.steps).toHaveLength(2); // immutable
  });
  it('clamps a span that overran the clip end (mirroredStart < 0)', () => {
    // a note at step 6 with span 4 (covers 6..9) but length only 8 — span > end.
    const r = reverseClipSteps(c(8, [{ step: 6, midi: 60, lengthSteps: 4 }]));
    // mirroredStart = 8 - (6+4) = -2 → clamp to 0, trim len to 4 + (-2) = 2.
    expect(r.steps).toEqual([{ step: 0, midi: 60, lengthSteps: 2 }]);
  });
});

describe('copyClip', () => {
  it('structurally clones steps, length, root, scale (no shared refs)', () => {
    const c0: NoteClipRecord = {
      ...defaultNoteClip(),
      root: 50,
      scale: 'minor',
      lengthSteps: 24,
      steps: [{ step: 1, midi: 62, velocity: 100, lengthSteps: 2 }],
    };
    const c1 = copyClip(c0);
    expect(c1).toEqual({
      kind: 'note',
      root: 50,
      scale: 'minor',
      loop: true,
      lengthSteps: 24,
      steps: [{ step: 1, midi: 62, velocity: 100, lengthSteps: 2 }],
    });
    expect(c1.steps).not.toBe(c0.steps); // array cloned
    expect(c1.steps[0]).not.toBe(c0.steps[0]); // event cloned
    // mutating the copy never touches the original.
    c1.steps[0].midi = 99;
    expect(c0.steps[0].midi).toBe(62);
  });
  it('a chromatic (no-scale) clip clones without a scale key', () => {
    const c0: NoteClipRecord = { ...defaultNoteClip(), steps: [] };
    delete c0.scale;
    expect('scale' in copyClip(c0)).toBe(false);
  });
});

describe('LENGTH-EDIT page math', () => {
  it('STEPS_PER_PAGE = 16, MAX_EDIT_PAGES = 8', () => {
    expect(STEPS_PER_PAGE).toBe(16);
    expect(MAX_EDIT_PAGES).toBe(8);
  });
  // endBlock / endStep for the documented lengths 1 / 16 / 17 / 113 / 128.
  it.each([
    [1, 1, 1],
    [16, 1, 16],
    [17, 2, 1],
    [113, 8, 1],
    [128, 8, 16],
  ])('L=%i → endBlock=%i, endStep=%i', (L, block, step) => {
    expect(lengthEndBlock(L)).toBe(block);
    expect(lengthEndStep(L)).toBe(step);
  });
  it('tap row-0 block C → C*16 (full block)', () => {
    expect(lengthFromBlockTap(1)).toBe(16);
    expect(lengthFromBlockTap(7)).toBe(112);
    expect(lengthFromBlockTap(8)).toBe(128);
    expect(lengthFromBlockTap(99)).toBe(128); // clamp
  });
  it('tap row-1 step N → (endBlock−1)*16 + N (length 113 = block 8 then step 1)', () => {
    // currently in block 8 (e.g. L=128) → tapping row-1 step 1 trims to 113.
    expect(lengthFromStepTap(128, 1)).toBe(113);
    expect(lengthFromStepTap(128, 16)).toBe(128);
    // in block 2 (e.g. L=17) → tapping step 5 → 16 + 5 = 21.
    expect(lengthFromStepTap(17, 5)).toBe(21);
    // in block 1 → tapping step 8 → 8.
    expect(lengthFromStepTap(16, 8)).toBe(8);
  });
});

describe('readNoteRec — KEYS note-record state normalization', () => {
  it('returns null when absent/null/non-object', () => {
    expect(readNoteRec(undefined)).toBeNull();
    expect(readNoteRec({} as ClipPlayerData)).toBeNull();
    expect(readNoteRec({ noteRec: null } as ClipPlayerData)).toBeNull();
  });
  it('coerces + clamps lane/slot and reads the boolean flags', () => {
    const r = readNoteRec({
      noteRec: { lane: 2, slot: 5, armed: true, recording: false, overdub: true },
    } as ClipPlayerData);
    expect(r).toEqual({ lane: 2, slot: 5, armed: true, recording: false, overdub: true });
    // out-of-range lane/slot clamp into the grid.
    const c = readNoteRec({ noteRec: { lane: 99, slot: -3 } } as unknown as ClipPlayerData);
    expect(c!.lane).toBe(7);
    expect(c!.slot).toBe(0);
    expect(c!.armed).toBe(false); // missing flags default false
  });
  it('rejects a non-numeric lane/slot', () => {
    expect(readNoteRec({ noteRec: { lane: 'x', slot: 1 } } as unknown as ClipPlayerData)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SCENE copy/paste — the typed clipboard PURE core (pasteApplies + readScene +
// sceneWritePlan) used by the Launchpad scene copy/paste. See launchpad-control.
// ---------------------------------------------------------------------------
function clipWithNoteHelper(step: number, midi: number): NoteClipRecord {
  return { ...defaultNoteClip(), steps: [{ step, midi, velocity: 100, lengthSteps: 1 }] };
}
describe('scene copy/paste — pasteApplies (the 4-combo type gate)', () => {
  it('applies ONLY when the buffer kind matches the target kind', () => {
    expect(pasteApplies('scene', 'scene')).toBe(true); // scene→scene VALID
    expect(pasteApplies('clip', 'clip')).toBe(true); // clip→clip VALID
    expect(pasteApplies('scene', 'clip')).toBe(false); // scene→clip NO-OP
    expect(pasteApplies('clip', 'scene')).toBe(false); // clip→scene NO-OP
  });
});

describe('scene copy/paste — readScene (snapshot all 8 lanes at a slot)', () => {
  it('reads every lane at a slot as a plain clone; empty lanes are null', () => {
    const a = clipWithNoteHelper(1, 61);
    const b = clipWithNoteHelper(2, 62);
    const data = {
      clips: {
        [clipIndex(3, 0)]: a,
        [clipIndex(3, 2)]: b,
        [clipIndex(4, 1)]: clipWithNoteHelper(0, 60), // a DIFFERENT slot — must be ignored
      },
    };
    const scene = readScene(data, 3);
    expect(scene).toHaveLength(CLIP_LANES);
    expect(scene[0]).toMatchObject({ kind: 'note', steps: [{ step: 1, midi: 61 }] });
    expect(scene[1]).toBeNull(); // empty lane
    expect(scene[2]).toMatchObject({ kind: 'note', steps: [{ step: 2, midi: 62 }] });
    for (let lane = 3; lane < CLIP_LANES; lane++) expect(scene[lane]).toBeNull();
  });

  it('SEVERS live Y children (a plain clone, safe to re-parent)', () => {
    const store = syncedStore<{ nodes: Record<string, { data: ClipPlayerData }> }>({ nodes: {} });
    store.nodes['n'] = { data: { clips: { [clipIndex(0, 0)]: clipWithNoteHelper(0, 64) } } };
    const scene = readScene(store.nodes['n']!.data, 0);
    // A plain object — mutating it does not touch the live store.
    (scene[0] as NoteClipRecord).steps.push({ step: 9, midi: 70 });
    const live = (store.nodes['n']!.data.clips as Record<string, NoteClipRecord>)[String(clipIndex(0, 0))];
    expect(live.steps).toHaveLength(1); // untouched
  });

  it('an empty slot reads as all nulls', () => {
    expect(readScene({ clips: {} }, 5)).toEqual(new Array(CLIP_LANES).fill(null));
  });
});

describe('scene copy/paste — sceneWritePlan (full-replace plan incl. deletes)', () => {
  it('maps each lane to its target flat index + a plain-cloned value (null = delete)', () => {
    const src = readScene(
      { clips: { [clipIndex(2, 0)]: clipWithNoteHelper(1, 61), [clipIndex(2, 3)]: clipWithNoteHelper(2, 62) } },
      2,
    );
    const plan = sceneWritePlan(10, src); // paste scene 2 → target slot 10
    expect(plan).toHaveLength(CLIP_LANES);
    for (let lane = 0; lane < CLIP_LANES; lane++) {
      expect(plan[lane]!.index).toBe(clipIndex(10, lane));
    }
    expect(plan[0]!.value).toMatchObject({ kind: 'note', steps: [{ step: 1, midi: 61 }] });
    expect(plan[3]!.value).toMatchObject({ kind: 'note', steps: [{ step: 2, midi: 62 }] });
    expect(plan[1]!.value).toBeNull(); // empty source lane → delete target
    expect(plan[7]!.value).toBeNull();
  });

  it('re-clones so the plan never shares refs with the source array', () => {
    const src = readScene({ clips: { [clipIndex(0, 0)]: clipWithNoteHelper(0, 60) } }, 0);
    const plan = sceneWritePlan(0, src);
    expect(plan[0]!.value).not.toBe(src[0]); // a fresh clone
    expect(plan[0]!.value).toEqual(src[0]); // but equal by value
  });

  it('an all-empty scene plans 8 deletes (clears the target)', () => {
    const plan = sceneWritePlan(4, new Array(CLIP_LANES).fill(null));
    expect(plan.every((p) => p.value === null)).toBe(true);
    expect(plan.map((p) => p.index)).toEqual(
      Array.from({ length: CLIP_LANES }, (_, lane) => clipIndex(4, lane)),
    );
  });
});
