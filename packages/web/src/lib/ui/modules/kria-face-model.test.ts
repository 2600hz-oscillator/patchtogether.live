// packages/web/src/lib/ui/modules/kria-face-model.test.ts
//
// kria's FACE, as pure model: what the plate ranks, what each band cell reads,
// and what the grid paints. No DOM, no Y.Doc, no AudioContext.
//
// ⚠ THE TWO PERMANENT NEGATIVE CONTROLS THIS FILE EXISTS FOR:
//
//   §8 state 6 — SELECTED-TRACK COUPLING. Every band cell except SCALE and ROOT
//     reads "…of the selected track". That is the design's one real hazard: a
//     cell and the grid panel disagreeing about which track is on screen would
//     be silent, plausible, and wrong. Asserted in BOTH directions — switching
//     tracks moves every cell, and editing one track moves NOTHING on the
//     others.
//
//   §8 state 4 — THE OCTAVE ROW-0 REGRESSION. The card wrote `Math.min(5, 6 -
//     row)` and lit `6 - row <= oct`, so rows 0 AND 1 both wrote octave 5 while
//     octave 5 lit rows 1..6: row 0 took clicks forever and could never show
//     the state it had written. (The bijection PROPERTY over all seven lanes
//     lives in kria-types.test.ts; this pins the specific painted result.)

import { describe, it, expect } from 'vitest';
import { kriaDef } from '$lib/audio/modules/kria';
import { curatedFace, laneOrder, dockFacePlan } from '$lib/ui/workflow/curated-face';
import { shellCellKeys, panelCellKeys } from '$lib/ui/workflow/shell-cells';
import { STRICT_FACES } from '$lib/ui/workflow/strict-faces';
import {
  applyLaneEdit,
  defaultPattern,
  laneRowActive,
  laneRowLit,
  setDirection,
  setLoopLength,
  setMuted,
  setTimeDivision,
  KRIA_EDIT_ROWS,
  KRIA_LANES,
  KRIA_STEPS,
  KRIA_TRACKS,
  type KriaLane,
  type KriaTrack,
} from '$lib/audio/modules/kria-types';
import type { ModuleNode } from '$lib/graph/types';
import {
  kriaDirectionValue,
  kriaLoopLengthValue,
  kriaLoopStartValue,
  kriaMuteValue,
  kriaRootValue,
  kriaScaleValue,
  kriaTimeDivisionValue,
} from './kria-cell-actions';

const FACE = kriaDef.face!;

/** A node whose data holds `tracks`, with `sel` selected. */
function nodeWith(tracks: KriaTrack[], sel = 0): ModuleNode {
  return {
    id: 'k',
    type: 'kria',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params: {},
    data: {
      patterns: { '0': { ...defaultPattern(), tracks } },
      active: 0,
      selTrack: sel,
    },
  } as unknown as ModuleNode;
}

function freshTracks(): KriaTrack[] {
  return Array.from({ length: KRIA_TRACKS }, () => structuredClone(defaultPattern().tracks[0]!));
}

/** Every per-track band cell's rendered value, as one comparable record. */
function trackCells(node: ModuleNode) {
  return {
    loopStart: kriaLoopStartValue(node),
    loopLength: kriaLoopLengthValue(node),
    timeDivision: kriaTimeDivisionValue(node),
    direction: kriaDirectionValue(node),
    mute: kriaMuteValue(node),
  };
}

describe('kria face — the declaration', () => {
  it('is PROMOTED and ranks the grid FIRST', () => {
    expect(STRICT_FACES.has('kria')).toBe(true);
    expect(FACE.order[0]).toBe('kria-cell-{n}');
    expect(FACE.hero?.cell).toBe('kria-cell-{n}');
  });

  it('the grid is a PANEL, and PF-22 keeps it out of every lane tier', () => {
    // The whole reason this module can have a faceplate: a panel may not be
    // SELECTED at a lane tier, and kria has too few rankable keys to push one
    // past the six-cell lane cap. `laneOrder` drops the hero cell instead.
    expect(panelCellKeys('kria')).toContain('kria-cell-{n}');
    expect(laneOrder(FACE)).not.toContain('kria-cell-{n}');
    expect(laneOrder(FACE)[0], 'the lane leads with the transport').toBe('running');
    for (const tier of ['mini', 'compact', 'full'] as const) {
      expect(
        curatedFace(kriaDef, tier)!.controls.map((c) => c.key),
        `${tier}: a 320px panel must never be selected into a 46px knob column`,
      ).not.toContain('kria-cell-{n}');
    }
    // …and the DOCK is where it renders — the other half of the same claim.
    expect(curatedFace(kriaDef, 'dock')!.controls.map((c) => c.key)).toContain('kria-cell-{n}');
    expect(dockFacePlan(kriaDef)).toBeTruthy();
  });

  it('every ranked key resolves to a registered, non-inert cell or a param', () => {
    const params = new Set(kriaDef.params.map((p) => p.id));
    const registered = new Set(shellCellKeys('kria'));
    const inert = FACE.order.filter((k) => !params.has(k) && !registered.has(k));
    expect(inert, 'a ranked key with no registered cell renders as a dead dashed label').toEqual([]);
    // …and the other direction: a registered cell nothing ranks never paints.
    const orphans = [...registered].filter((k) => !FACE.order.includes(k));
    expect(orphans, 'a registered cell that no face key ranks is dead code').toEqual([]);
  });

  it('THREE bands, no tab rail — the honest grouping, not a padded one', () => {
    expect(FACE.pages?.map((p) => p.id)).toEqual(['transport', 'track', 'scale']);
    expect(FACE.tabbed, 'face.tabbed is owner-instruction-only').toBeUndefined();
    // LOOP and TIME are the same idea twice, so they are clusters inside the
    // track band rather than two more pages.
    const track = FACE.pages!.find((p) => p.id === 'track')!;
    expect(track.clusters?.map((c) => c.label)).toEqual(['loop', 'time']);
  });

  it('declares NO shell extension — the clicked-grid class needs no platform seam', () => {
    // The result this promotion exists to establish for the sequencer cohort.
    expect(FACE.extension).toBeUndefined();
    // …and no lane picture, because kria has no audio output for one to trace.
    expect(FACE.glyph).toBe('none');
    expect(kriaDef.outputs.some((o) => o.type === 'audio')).toBe(false);
  });
});

describe('kria face — §8 state 6: the SELECTED-TRACK coupling (permanent negative control)', () => {
  it('switching tracks moves EVERY per-track cell', () => {
    const tracks = freshTracks();
    // Give each track a distinguishable configuration.
    tracks[0] = setLoopLength(tracks[0]!, 4);
    tracks[1] = setDirection(setTimeDivision(tracks[1]!, 6), 'reverse');
    tracks[2] = setMuted(tracks[2]!, true);
    tracks[3] = setLoopLength(setTimeDivision(tracks[3]!, 12), 9);

    const seen = [0, 1, 2, 3].map((t) => trackCells(nodeWith(tracks, t)));

    expect(seen[0]).toEqual({ loopStart: '0', loopLength: '4', timeDivision: '1', direction: 'forward', mute: false });
    expect(seen[1]).toEqual({ loopStart: '0', loopLength: String(KRIA_STEPS), timeDivision: '6', direction: 'reverse', mute: false });
    expect(seen[2]).toEqual({ loopStart: '0', loopLength: String(KRIA_STEPS), timeDivision: '1', direction: 'forward', mute: true });
    expect(seen[3]).toEqual({ loopStart: '0', loopLength: '9', timeDivision: '12', direction: 'forward', mute: false });

    // The load-bearing claim, stated as a property rather than four literals:
    // no two tracks read the same, so a cell stuck on track 0 cannot pass.
    const distinct = new Set(seen.map((c) => JSON.stringify(c)));
    expect(distinct.size, 'a cell that ignored the selection would collapse these').toBe(4);
  });

  it('…and the OTHER direction: editing one track moves NOTHING on the others', () => {
    const before = freshTracks();
    const after = freshTracks();
    after[2] = setDirection(setLoopLength(after[2]!, 3), 'drunk');
    for (const t of [0, 1, 3]) {
      expect(
        trackCells(nodeWith(after, t)),
        `track ${t} must be untouched by an edit to track 2`,
      ).toEqual(trackCells(nodeWith(before, t)));
    }
    expect(trackCells(nodeWith(after, 2)).direction).toBe('drunk');
  });

  it('SCALE and ROOT are pattern-level — they do NOT move with the track', () => {
    const tracks = freshTracks();
    const values = [0, 1, 2, 3].map((t) => ({
      scale: kriaScaleValue(nodeWith(tracks, t)),
      root: kriaRootValue(nodeWith(tracks, t)),
    }));
    expect(new Set(values.map((v) => JSON.stringify(v))).size, 'one setting for all four tracks').toBe(1);
  });
});

describe('kria face — §8 state 4: the OCTAVE row-0 regression', () => {
  it('row 0 is INERT: it takes no click and can never light', () => {
    expect(laneRowActive('octave', 0)).toBe(false);
    expect(applyLaneEdit('octave', defaultPattern().tracks[0]!, 0, 0)).toBeNull();
    // …at every octave value, not just the default. Octave 5 is the one the old
    // code produced from row 0 and then painted on rows 1..6.
    for (let oct = 0; oct <= 5; oct++) {
      const t = applyLaneEdit('octave', defaultPattern().tracks[0]!, 0, 6 - oct)!;
      expect(t.octave[0], `row ${6 - oct} writes octave ${oct}`).toBe(oct);
      expect(laneRowLit('octave', t, 0, 0), `octave ${oct} must not light row 0`).toBe(false);
    }
  });

  it('the octave bar fills from the bottom and reaches its own clicked row', () => {
    const lit = (t: KriaTrack) =>
      Array.from({ length: KRIA_EDIT_ROWS }, (_, r) => (laneRowLit('octave', t, 0, r) ? 1 : 0));
    // octave 0 → only the bottom row; octave 5 → rows 1..6, never row 0.
    expect(lit(applyLaneEdit('octave', defaultPattern().tracks[0]!, 0, 6)!)).toEqual([0, 0, 0, 0, 0, 0, 1]);
    expect(lit(applyLaneEdit('octave', defaultPattern().tracks[0]!, 0, 1)!)).toEqual([0, 1, 1, 1, 1, 1, 1]);
  });
});

describe('kria face — §8 states 2 and 3: what the grid paints', () => {
  const litSet = (lane: KriaLane, t: KriaTrack, step: number) =>
    Array.from({ length: KRIA_EDIT_ROWS }, (_, r) => r).filter((r) => laneRowLit(lane, t, step, r));

  it('TRIG lights ONE row (the bottom) and only on the steps that fire', () => {
    const t = applyLaneEdit('trig', defaultPattern().tracks[0]!, 5, 3)!;
    expect(litSet('trig', t, 5)).toEqual([KRIA_EDIT_ROWS - 1]);
    expect(litSet('trig', t, 4), 'an unset step stays dark').toEqual([]);
  });

  it('NOTE lights exactly ONE row per step — the degree', () => {
    for (let row = 0; row < KRIA_EDIT_ROWS; row++) {
      const t = applyLaneEdit('note', defaultPattern().tracks[0]!, 2, row)!;
      expect(litSet('note', t, 2), `note row ${row} is a single-lit lane`).toEqual([row]);
    }
  });

  it('every lane is REACHABLE from the face — the manifest sentence, as a test', () => {
    // The nine controls that were engine-implemented, documented, and editable
    // from nowhere but a monome grid over WebSerial.
    const laneIds = KRIA_LANES.map((l) => l.id);
    expect(laneIds).toEqual(['trig', 'note', 'octave', 'duration', 'probability', 'glide', 'ratchet']);
    for (const lane of laneIds) {
      const rows = Array.from({ length: KRIA_EDIT_ROWS }, (_, r) => r).filter((r) => laneRowActive(lane, r));
      expect(rows.length, `${lane} must have at least one live row`).toBeGreaterThan(0);
    }
    for (const key of ['kria-loop-start-{n}', 'kria-loop-length-{n}', 'kria-time-division-{n}',
                       'kria-direction-{n}', 'kria-mute-{n}', 'kria-scale-{n}', 'kria-root-{n}']) {
      expect(FACE.order, `${key} is ranked`).toContain(key);
      expect(shellCellKeys('kria'), `${key} has a registered cell`).toContain(key);
    }
  });
});
