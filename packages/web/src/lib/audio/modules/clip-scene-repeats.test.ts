// packages/web/src/lib/audio/modules/clip-scene-repeats.test.ts
//
// PURE unit tests for the SCENE REPEATS model (clip-scene-repeats.ts): count
// coercion (1..63, 0/absent = infinite), the per-key write seam, next-content-
// scene selection with gaps + last-scene behavior, the FROZEN repeat unit
// (longest clip incl. rate/div), the deviation (manual-interference) rules, and
// the advance decision (latched count edits). No engine, no store.

import { describe, it, expect } from 'vitest';
import {
  SCENE_REPEATS_MAX,
  coerceSceneRepeat,
  sceneRepeatCount,
  setSceneRepeat,
  sceneRepeatFlair,
  sceneRepeatProgressFlair,
  readSceneLaunch,
  sceneHasContent,
  nextContentScene,
  sceneLaunchPlan,
  applySceneLaunchWrite,
  sceneRepeatAnchor,
  anchorSceneRepeatTrack,
  sceneRepeatsDone,
  sceneRepeatDeviates,
  drainScenePrevSlots,
  sceneAllLanesStopped,
  sceneRepeatShouldAdvance,
  type SceneRepeatTrack,
} from './clip-scene-repeats';
import {
  CLIP_LANES,
  SCENE_STRIDE,
  clipIndex,
  defaultNoteClip,
  type ClipPlayerData,
  type NoteClipRecord,
} from './clip-types';

function clip(lengthSteps = 16, div?: number): NoteClipRecord {
  const c = defaultNoteClip();
  c.lengthSteps = lengthSteps;
  if (div !== undefined) c.div = div;
  return c;
}
function dataWith(clips: Record<string, NoteClipRecord>, extra: Partial<ClipPlayerData> = {}): ClipPlayerData {
  return { clips, ...extra } as ClipPlayerData;
}

describe('coerceSceneRepeat — 1..63 valid, everything else = infinite (0)', () => {
  it('accepts 1..63 as integers', () => {
    expect(coerceSceneRepeat(1)).toBe(1);
    expect(coerceSceneRepeat(63)).toBe(63);
    expect(coerceSceneRepeat(16)).toBe(16);
    expect(coerceSceneRepeat(4.9)).toBe(4); // trunc
  });
  it('0 / 64 / negatives / NaN / non-numbers read as INFINITE (0)', () => {
    expect(coerceSceneRepeat(0)).toBe(0);
    expect(coerceSceneRepeat(SCENE_REPEATS_MAX + 1)).toBe(0);
    expect(coerceSceneRepeat(-3)).toBe(0);
    expect(coerceSceneRepeat(Number.NaN)).toBe(0);
    expect(coerceSceneRepeat('7')).toBe(7); // numeric string coerces (sync payload)
    expect(coerceSceneRepeat('lots')).toBe(0);
    expect(coerceSceneRepeat(undefined)).toBe(0);
    expect(coerceSceneRepeat(null)).toBe(0);
  });
});

describe('sceneRepeatCount / setSceneRepeat — the per-key map seam', () => {
  it('absent map / absent key / invalid value ⇒ infinite', () => {
    expect(sceneRepeatCount(undefined, 0)).toBe(0);
    expect(sceneRepeatCount({}, 0)).toBe(0);
    expect(sceneRepeatCount({ sceneRepeats: { '1': 99 } }, 1)).toBe(0);
    expect(sceneRepeatCount({ sceneRepeats: { '1': 5 } }, 1)).toBe(5);
  });
  it('setSceneRepeat writes ONLY its key; infinite DELETES the key', () => {
    const d: ClipPlayerData = { sceneRepeats: { '2': 7 } };
    setSceneRepeat(d, 0, 4);
    expect(d.sceneRepeats).toEqual({ '2': 7, '0': 4 });
    setSceneRepeat(d, 0, 0); // infinite → delete
    expect(d.sceneRepeats).toEqual({ '2': 7 });
    setSceneRepeat(d, 2, 64); // out of domain → infinite → delete
    expect(d.sceneRepeats).toEqual({});
  });
  it('creates the container defensively and clamps the slot into 0..63', () => {
    const d: ClipPlayerData = {};
    setSceneRepeat(d, SCENE_STRIDE + 5, 3);
    expect(d.sceneRepeats).toEqual({ [String(SCENE_STRIDE - 1)]: 3 });
  });
});

describe('flair text', () => {
  it('"×N" for a set count, empty for infinite (the quiet option)', () => {
    expect(sceneRepeatFlair(4)).toBe('×4');
    expect(sceneRepeatFlair(0)).toBe('');
    expect(sceneRepeatFlair(999)).toBe('');
  });
  it('live progress "p/N" is 1-based and clamps to N', () => {
    expect(sceneRepeatProgressFlair(0, 8)).toBe('1/8');
    expect(sceneRepeatProgressFlair(2, 8)).toBe('3/8');
    expect(sceneRepeatProgressFlair(9, 8)).toBe('8/8');
    expect(sceneRepeatProgressFlair(3, 0)).toBe(''); // infinite → no progress
  });
});

describe('readSceneLaunch — the intent marker', () => {
  it('reads a valid {slot, n}; rejects malformed values', () => {
    expect(readSceneLaunch({ sceneLaunch: { slot: 3, n: 7 } })).toEqual({ slot: 3, n: 7 });
    expect(readSceneLaunch({ sceneLaunch: { slot: -1, n: 1 } })).toBeNull();
    expect(readSceneLaunch({ sceneLaunch: { slot: SCENE_STRIDE, n: 1 } })).toBeNull();
    expect(readSceneLaunch({ sceneLaunch: { slot: 0 } as never })).toBeNull();
    expect(readSceneLaunch({})).toBeNull();
    expect(readSceneLaunch(undefined)).toBeNull();
  });
});

describe('next-content-scene selection (skip gaps, no wrap)', () => {
  const d = dataWith({
    [clipIndex(0, 0)]: clip(),
    [clipIndex(3, 4)]: clip(), // gap: scenes 1,2 empty
    [clipIndex(9, 7)]: clip(), // content past the visible 8
  });
  it('skips empty rows to the next content scene DOWN', () => {
    expect(nextContentScene(d, 0)).toBe(3);
    expect(nextContentScene(d, 3)).toBe(9);
  });
  it('no content below ⇒ null (keep looping the last — never wrap, never stop)', () => {
    expect(nextContentScene(d, 9)).toBeNull();
    expect(nextContentScene(dataWith({}), 0)).toBeNull();
  });
  it('sceneHasContent checks every lane of the slot column', () => {
    expect(sceneHasContent(d, 3)).toBe(true);
    expect(sceneHasContent(d, 1)).toBe(false);
  });
});

describe('sceneLaunchPlan / applySceneLaunchWrite — the shared launch seam', () => {
  it('plans slot for content lanes, stop for the rest', () => {
    const d = dataWith({ [clipIndex(2, 0)]: clip(), [clipIndex(2, 5)]: clip() });
    const { queued, anyContent } = sceneLaunchPlan(d, 2);
    expect(anyContent).toBe(true);
    expect(queued[0]).toBe(2);
    expect(queued[5]).toBe(2);
    expect(queued[1]).toBe('stop');
    expect(queued).toHaveLength(CLIP_LANES);
  });
  it('an EMPTY scene writes NOTHING and returns false (no stop-all storm)', () => {
    const d = dataWith({ [clipIndex(0, 0)]: clip() }, { queued: [0, null, null, null, null, null, null, null] });
    expect(applySceneLaunchWrite(d, 5, false)).toBe(false);
    expect(d.queued).toEqual([0, null, null, null, null, null, null, null]);
    expect(d.sceneLaunch).toBeUndefined();
  });
  it('writes the whole plan + bumps the marker; immediate sets queuedImmediate', () => {
    const d = dataWith({ [clipIndex(1, 3)]: clip() });
    expect(applySceneLaunchWrite(d, 1, false)).toBe(true);
    expect(d.queued![3]).toBe(1);
    expect(d.sceneLaunch).toEqual({ slot: 1, n: 1 });
    expect(d.queuedImmediate).toBeUndefined();
    expect(applySceneLaunchWrite(d, 1, true)).toBe(true);
    expect(d.sceneLaunch).toEqual({ slot: 1, n: 2 }); // re-launch bumps n (fresh count)
    expect(d.queuedImmediate).toEqual(new Array(CLIP_LANES).fill(true));
  });
});

describe('sceneRepeatAnchor — the FROZEN unit (longest clip incl. rate/div)', () => {
  const SPB = 4; // stepDiv 2 → 4 steps per beat
  it('picks the longest clip in BEATS: length × 1/(spb×mult)', () => {
    // lane 0: 16 steps at 1x → 4 beats. lane 1: 8 steps at 1/2 (div idx 2 →
    // mult 0.5) → 8/(4*0.5) = 4 beats. Tie → the LOWEST lane wins.
    const d = dataWith({
      [clipIndex(0, 0)]: clip(16),
      [clipIndex(0, 1)]: clip(8, 2),
    });
    expect(sceneRepeatAnchor(d, 0, SPB)).toEqual({ lane: 0, unitBeats: 4, stepBeats: 0.25 });
  });
  it('a slower lane RATE stretches that lane into the anchor', () => {
    // lane 2 runs at lane-rate 1/4 (idx 1 → mult 0.25): 8 steps → 8/(4*0.25) =
    // 8 beats — longer than lane 0's 16 steps at 1x (4 beats).
    const d = dataWith(
      { [clipIndex(0, 0)]: clip(16), [clipIndex(0, 2)]: clip(8) },
      { rate: [3, 3, 1, 3, 3, 3, 3, 3] },
    );
    expect(sceneRepeatAnchor(d, 0, SPB)).toEqual({ lane: 2, unitBeats: 8, stepBeats: 1 });
  });
  it('clip.div OVERRIDES the lane rate (the same clipDivIndex seam the engine latches)', () => {
    // lane 1's clip carries div 5 (4x) → 16/(4*4) = 1 beat despite a slow lane rate.
    const d = dataWith(
      { [clipIndex(0, 1)]: clip(16, 5) },
      { rate: [3, 0, 3, 3, 3, 3, 3, 3] },
    );
    expect(sceneRepeatAnchor(d, 0, SPB)).toEqual({ lane: 1, unitBeats: 1, stepBeats: 1 / 16 });
  });
  it('empty scene ⇒ null anchor ⇒ null tracker', () => {
    expect(sceneRepeatAnchor(dataWith({}), 0, SPB)).toBeNull();
    expect(anchorSceneRepeatTrack(dataWith({}), 0, SPB, undefined)).toBeNull();
  });
  it('a NON-NOTE clip (audio/snapshot shell) still anchors with the engine len-1 fallback', () => {
    // The targeting set (sceneHasContent) counts raw-truthy entries of any
    // declared kind — the anchor must not silently die on a non-note-only
    // scene (the repeat chain would end there).
    const d = {
      clips: { [String(clipIndex(0, 2))]: { kind: 'audio', loop: true } },
    } as unknown as ClipPlayerData;
    expect(sceneRepeatAnchor(d, 0, SPB)).toEqual({ lane: 2, unitBeats: 0.25, stepBeats: 0.25 });
  });
  it('anchorSceneRepeatTrack seeds transition GRACE from the ACTUAL playing set (never a prior tracker)', () => {
    const d = dataWith({ [clipIndex(0, 0)]: clip(16) });
    // Lanes still playing slots 3 and 5 at anchor time; one lane already plays
    // the NEW slot (0) — grace covers only the FOREIGN slots.
    const t = anchorSceneRepeatTrack(d, 0, SPB, [3, 0, 5, null, null, null, null, null])!;
    expect([...t.prevSlots].sort()).toEqual([3, 5]);
    expect(t.started).toBe(false);
    expect(t.unitBeats).toBe(4);
    expect(t.anchorLane).toBe(0);
    // No lanes playing (fresh rack) ⇒ empty grace.
    expect(anchorSceneRepeatTrack(d, 0, SPB, undefined)!.prevSlots.size).toBe(0);
  });
});

function track(over: Partial<SceneRepeatTrack> = {}): SceneRepeatTrack {
  return {
    slot: 0,
    prevSlots: new Set<number>(),
    unitBeats: 4,
    stepBeats: 0.25,
    anchorLane: 0,
    started: true,
    startBeat: 10,
    ...over,
  };
}

describe('sceneRepeatsDone — beats-domain counting off the frozen unit', () => {
  it('floors completed units since the start boundary (epsilon at the boundary)', () => {
    const t = track();
    expect(sceneRepeatsDone(t, 10)).toBe(0);
    expect(sceneRepeatsDone(t, 13.9)).toBe(0);
    expect(sceneRepeatsDone(t, 14)).toBe(1); // exactly one unit — boundary counts
    expect(sceneRepeatsDone(t, 22.5)).toBe(3);
  });
  it('not started ⇒ 0', () => {
    expect(sceneRepeatsDone(track({ started: false }), 99)).toBe(0);
  });
});

describe('deviation — deliberate, deterministic cancel rules', () => {
  it('a QUEUED individual clip outside the scene deviates; stops/nulls never do', () => {
    const t = track();
    expect(sceneRepeatDeviates(t, [5, null, null, null, null, null, null, null], [])).toBe(true);
    expect(sceneRepeatDeviates(t, ['stop', null, null, null, null, null, null, null], [])).toBe(false);
    expect(sceneRepeatDeviates(t, [0, null, null, null, null, null, null, null], [])).toBe(false);
    expect(sceneRepeatDeviates(t, undefined, undefined)).toBe(false);
  });
  it('a PLAYING slot outside the scene deviates — except the draining grace set', () => {
    const t = track({ slot: 3, prevSlots: new Set([0, 5]) });
    expect(sceneRepeatDeviates(t, [], [3, 0, 5, null, null, null, null, null])).toBe(false);
    expect(sceneRepeatDeviates(t, [], [3, 7, null, null, null, null, null, null])).toBe(true);
  });
  it('drainScenePrevSlots — removes exactly the grace slots nothing plays or queues any more', () => {
    const t = track({ slot: 3, prevSlots: new Set([0, 5]) });
    // slot 0 still queued on a lane, slot 5 still playing → both stay.
    drainScenePrevSlots(t, [0, null, null, null, null, null, null, null], [null, 5, null, null, null, null, null, null]);
    expect([...t.prevSlots].sort()).toEqual([0, 5]);
    // slot 5 gone everywhere → dropped; slot 0 still playing → kept.
    drainScenePrevSlots(t, [], [0, null, null, null, null, null, null, null]);
    expect([...t.prevSlots]).toEqual([0]);
    // everything drained → empty (full strictness returns).
    drainScenePrevSlots(t, ['stop', null, null, null, null, null, null, null], [3, null, null, null, null, null, null, null]);
    expect(t.prevSlots.size).toBe(0);
  });
  it('sceneAllLanesStopped — every scene lane stopped OR pending-stop cancels (started only)', () => {
    const t = track();
    expect(sceneAllLanesStopped(t, [], [null, null, null, null, null, null, null, null])).toBe(true);
    expect(sceneAllLanesStopped(t, [], [0, null, null, null, null, null, null, null])).toBe(false);
    // A PENDING manual stop counts as stopped (the advance runs in the
    // lookahead, before the stop applies — it must not clobber a stop-all).
    expect(
      sceneAllLanesStopped(t, ['stop', null, null, null, null, null, null, null], [0, null, null, null, null, null, null, null]),
    ).toBe(true);
    // …but a pending RE-launch of the scene keeps it alive.
    expect(
      sceneAllLanesStopped(t, [0, null, null, null, null, null, null, null], [null, null, null, null, null, null, null, null]),
    ).toBe(false);
    expect(sceneAllLanesStopped(track({ started: false }), [], [])).toBe(false);
  });
});

describe('sceneRepeatShouldAdvance — the boundary decision (latched count reads)', () => {
  it('fires only when the FROZEN boundary enters the lookahead window', () => {
    const t = track(); // startBeat 10, unit 4 → N=2 boundary at 18
    expect(sceneRepeatShouldAdvance(t, 2, 17.0, 0.5)).toBe(false);
    expect(sceneRepeatShouldAdvance(t, 2, 17.6, 0.5)).toBe(true);
    expect(sceneRepeatShouldAdvance(t, 2, 18.5, 0.5)).toBe(true); // past = still fires (next boundary applies it)
  });
  it('infinite (0) never advances; unstarted never advances', () => {
    expect(sceneRepeatShouldAdvance(track(), 0, 99, 1)).toBe(false);
    expect(sceneRepeatShouldAdvance(track({ started: false }), 2, 99, 1)).toBe(false);
  });
  it('NO one-shot latch: past the boundary it keeps firing each evaluation, and RAISING N moves the boundary back out (re-arm semantics)', () => {
    const t = track(); // startBeat 10, unit 4
    expect(sceneRepeatShouldAdvance(t, 2, 19, 0.5)).toBe(true); // boundary 18 passed
    expect(sceneRepeatShouldAdvance(t, 2, 25, 0.5)).toBe(true); // still true later (no latch field)
    expect(sceneRepeatShouldAdvance(t, 5, 25, 0.5)).toBe(false); // N raised → boundary 30, counting resumes
    expect(sceneRepeatShouldAdvance(t, 5, 29.6, 0.5)).toBe(true);
  });
  it('the count is read FRESH each evaluation — lowering N below the elapsed count fires at the next evaluation (never retroactively inside a pass)', () => {
    const t = track(); // 3 passes elapsed at beat 22
    expect(sceneRepeatShouldAdvance(t, 0, 22, 0.5)).toBe(false); // infinite while unset
    // The count is edited to 1 (below the elapsed 3): the boundary (10+4=14) is
    // long past → the decision fires NOW, and the write applies at each lane's
    // NEXT loop boundary (the queued path) — the latched semantic.
    expect(sceneRepeatShouldAdvance(t, 1, 22, 0.5)).toBe(true);
  });
});
