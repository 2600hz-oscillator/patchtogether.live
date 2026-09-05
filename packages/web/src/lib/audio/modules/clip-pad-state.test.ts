// packages/web/src/lib/audio/modules/clip-pad-state.test.ts
//
// THE AGREEMENT PIN for `clipPadState` — the one projection of how a launch-grid
// cell paints.
//
// ⚠ WHY THIS FILE EXISTS. Two surfaces paint the same 8×8 grid: the legacy
// `ClipplayerCard` and the v2 clipplayer face. Each carried its OWN copy of the
// precedence ladder, the copies were logically identical, and NO GATE COMPARED
// THEM. That is the shape of defect the faces programme keeps finding, and here
// it had already begun: the card's last clause asked `clips[k] ? …` (RAW
// truthiness) while the face's asked `coerceClipRecord(clips[k]) !== null`, so a
// record that coerces away painted LOADED on one surface and EMPTY on the other.
//
// The unification is one function in `clip-types`; this file is the instrument
// that keeps it one function. It does three things, and the third is the one a
// re-typed copy cannot survive:
//
//   1. Pins the ladder exhaustively, on a matrix built to make every clause
//      decide at least one case.
//   2. Cross-checks that matrix against a TRANSCRIPTION of the other surface's
//      clause set, with a POSITIVE CONTROL — a deliberately-divergent variant
//      that MUST disagree, so a matrix too weak to tell two implementations
//      apart is red rather than quietly reassuring.
//   3. Source-scans the clipplayer surfaces and fails on one that computes pad
//      state itself instead of delegating.
//
// PURE — plain objects, no engine, no Y.Doc, no browser.

import { describe, it, expect } from 'vitest';
import {
  CLIP_LANES,
  CLIP_SLOTS,
  clipIndex,
  clipPadState,
  coerceClipRecord,
  defaultNoteClip,
  laneOf,
  lanePlaying,
  laneQueued,
  slotOf,
  type ClipPadState,
  type ClipPlayerData,
} from './clip-types';

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

function noteClip() {
  return defaultNoteClip();
}
function audioClip() {
  return {
    kind: 'audio' as const,
    mediaId: 'm-pad',
    lengthSteps: 16,
    frames: 192_000,
    sampleRate: 48_000,
    channels: 2 as const,
    format: 'pcm-f32' as const,
    takeAt: 7,
    loop: true,
  };
}

/** Every interesting `(clips, playing, queued)` combination for lane 0, plus a
 *  few on other lanes so a helper that ignored `laneOf` would be caught. Each
 *  case names the clause it exercises. */
const CASES: { why: string; data: ClipPlayerData; index: number }[] = (() => {
  const at = (slot: number, lane = 0) => clipIndex(slot, lane);
  const withLane0 = (
    clips: Record<string, unknown>,
    playing: number | null,
    queued: number | 'stop' | null,
  ): ClipPlayerData =>
    ({
      clips,
      playing: [playing, null, null, null, null, null, null, null],
      queued: [queued, null, null, null, null, null, null, null],
    }) as unknown as ClipPlayerData;

  const out: { why: string; data: ClipPlayerData; index: number }[] = [];
  const loaded = { [String(at(0))]: noteClip(), [String(at(1))]: audioClip() };

  out.push({ why: 'nothing anywhere', data: withLane0({}, null, null), index: at(0) });
  out.push({ why: 'a note clip, idle', data: withLane0(loaded, null, null), index: at(0) });
  out.push({ why: 'an AUDIO clip, idle', data: withLane0(loaded, null, null), index: at(1) });
  out.push({ why: 'playing this slot', data: withLane0(loaded, 0, null), index: at(0) });
  out.push({ why: 'playing ANOTHER slot', data: withLane0(loaded, 1, null), index: at(0) });
  out.push({ why: 'queued THIS slot, nothing playing', data: withLane0(loaded, null, 0), index: at(0) });
  out.push({ why: 'queued this slot WHILE another plays', data: withLane0(loaded, 1, 0), index: at(0) });
  out.push({
    why: 'the OUTGOING pad while an incoming one is queued — still sounding',
    data: withLane0(loaded, 1, 0),
    index: at(1),
  });
  out.push({
    why: 'queued STOP on the playing pad — queued WINS over playing',
    data: withLane0(loaded, 0, 'stop'),
    index: at(0),
  });
  out.push({
    why: 'queued STOP while a DIFFERENT slot is the subject',
    data: withLane0(loaded, 0, 'stop'),
    index: at(1),
  });
  out.push({
    why: 'queued this slot and ALSO playing it (re-launch)',
    data: withLane0(loaded, 0, 0),
    index: at(0),
  });
  out.push({
    why: 'an EMPTY slot that is queued — a launch into nothing still blinks',
    data: withLane0({}, null, 3),
    index: at(3),
  });
  out.push({
    why: 'a record that COERCES AWAY (the retired stamped automation clip)',
    data: withLane0({ [String(at(0))]: { kind: 'automation', tracks: {} } }, null, null),
    index: at(0),
  });
  out.push({
    why: 'a MALFORMED audio record (no mediaId) — unschedulable, so not loaded',
    data: withLane0({ [String(at(0))]: { kind: 'audio', loop: true } }, null, null),
    index: at(0),
  });
  out.push({
    why: 'absent playing/queued arrays entirely',
    data: { clips: loaded } as unknown as ClipPlayerData,
    index: at(0),
  });
  out.push({ why: 'undefined data', data: undefined as unknown as ClipPlayerData, index: at(0) });
  // AUDIO CLIP-RECORD states (slice 5) — the rec rungs sit ABOVE queued.
  const recAt = (slot: number, phase: 'armed' | 'recording' | 'stopping') => ({
    lane: 0,
    slot,
    mode: 'single' as const,
    phase,
    startFrame: 0,
    stopFrame: 96_000,
    unitFrames: 96_000,
    recorderId: 1,
  });
  out.push({
    why: 'ARMED take on this slot — reserved, not yet content',
    data: { ...withLane0({}, null, null), audioRec: { '0': recAt(3, 'armed') } },
    index: at(3),
  });
  out.push({
    why: 'RECORDING take on this slot',
    data: { ...withLane0({}, null, null), audioRec: { '0': recAt(3, 'recording') } },
    index: at(3),
  });
  out.push({
    why: 'STOPPING paints rec-active too (slice 6 adds the countdown rung)',
    data: { ...withLane0({}, null, null), audioRec: { '0': recAt(3, 'stopping') } },
    index: at(3),
  });
  out.push({
    why: 'a take on ANOTHER slot leaves this pad alone',
    data: { ...withLane0(loaded, null, null), audioRec: { '0': recAt(3, 'recording') } },
    index: at(0),
  });
  out.push({
    why: 'REC beats QUEUED on the same slot',
    data: { ...withLane0({}, null, 3), audioRec: { '0': recAt(3, 'armed') } },
    index: at(3),
  });
  out.push({
    why: 'REC beats PLAYING on the same slot',
    data: { ...withLane0(loaded, 0, null), audioRec: { '0': recAt(0, 'recording') } },
    index: at(0),
  });
  out.push({
    why: 'a MALFORMED audioRec entry (junk phase) is ignored',
    data: {
      ...withLane0(loaded, null, null),
      audioRec: { '0': { phase: 'exploded', slot: 0 } as never },
    },
    index: at(0),
  });
  // Other lanes — a helper that dropped `laneOf` would read lane 0's state here.
  out.push({
    why: "lane 5's pad while LANE 0 is the one playing",
    data: withLane0({ [String(at(2, 5))]: noteClip() }, 2, null),
    index: at(2, 5),
  });
  out.push({
    why: "lane 5's pad, playing on lane 5",
    data: {
      clips: { [String(at(2, 5))]: noteClip() },
      playing: [null, null, null, null, null, 2, null, null],
      queued: [null, null, null, null, null, null, null, null],
    } as unknown as ClipPlayerData,
    index: at(2, 5),
  });
  return out;
})();

describe('clipPadState — the painted ladder', () => {
  it('resolves every case in the matrix to the documented state', () => {
    const got = CASES.map((c) => `${c.why} → ${clipPadState(c.data, c.index)}`);
    expect(got).toEqual([
      'nothing anywhere → empty',
      'a note clip, idle → loaded',
      'an AUDIO clip, idle → loaded',
      'playing this slot → playing',
      'playing ANOTHER slot → loaded',
      'queued THIS slot, nothing playing → queued',
      'queued this slot WHILE another plays → queued',
      'the OUTGOING pad while an incoming one is queued — still sounding → playing',
      'queued STOP on the playing pad — queued WINS over playing → queued',
      'queued STOP while a DIFFERENT slot is the subject → loaded',
      'queued this slot and ALSO playing it (re-launch) → queued',
      'an EMPTY slot that is queued — a launch into nothing still blinks → queued',
      'a record that COERCES AWAY (the retired stamped automation clip) → empty',
      'a MALFORMED audio record (no mediaId) — unschedulable, so not loaded → empty',
      'absent playing/queued arrays entirely → loaded',
      'undefined data → empty',
      'ARMED take on this slot — reserved, not yet content → rec-armed',
      'RECORDING take on this slot → rec-active',
      'STOPPING paints rec-active too (slice 6 adds the countdown rung) → rec-active',
      'a take on ANOTHER slot leaves this pad alone → loaded',
      'REC beats QUEUED on the same slot → rec-armed',
      'REC beats PLAYING on the same slot → rec-active',
      'a MALFORMED audioRec entry (junk phase) is ignored → loaded',
      "lane 5's pad while LANE 0 is the one playing → loaded",
      "lane 5's pad, playing on lane 5 → playing",
    ]);
  });

  it('REC-ARMED beats QUEUED for every slot of every lane (the new top rung, swept)', () => {
    for (let lane = 0; lane < CLIP_LANES; lane++) {
      for (let slot = 0; slot < CLIP_SLOTS; slot++) {
        const queued = new Array(CLIP_LANES).fill(null);
        queued[lane] = slot;
        const d = {
          clips: {},
          playing: new Array(CLIP_LANES).fill(null),
          queued,
          audioRec: {
            [String(lane)]: {
              lane,
              slot,
              mode: 'single',
              phase: 'armed',
              startFrame: 0,
              stopFrame: 1,
              unitFrames: 1,
              recorderId: 1,
            },
          },
        } as unknown as ClipPlayerData;
        expect(clipPadState(d, clipIndex(slot, lane))).toBe('rec-armed');
      }
    }
  });

  it('QUEUED beats PLAYING for every slot of every lane (the precedence, swept)', () => {
    for (let lane = 0; lane < CLIP_LANES; lane++) {
      for (let slot = 0; slot < CLIP_SLOTS; slot++) {
        const playing = new Array(CLIP_LANES).fill(null);
        const queued = new Array(CLIP_LANES).fill(null);
        playing[lane] = slot;
        queued[lane] = slot;
        const d = { clips: {}, playing, queued } as unknown as ClipPlayerData;
        expect(clipPadState(d, clipIndex(slot, lane))).toBe('queued');
      }
    }
  });

  it('an AUDIO clip reads LOADED — the state a launcher slot with a take must show', () => {
    const d = { clips: { [String(clipIndex(4, 2))]: audioClip() } } as unknown as ClipPlayerData;
    expect(clipPadState(d, clipIndex(4, 2))).toBe('loaded');
  });
});

// ---------------------------------------------------------------------------
// The cross-surface agreement, and the control that proves the matrix bites
// ---------------------------------------------------------------------------

/** A verbatim transcription of the OTHER surface's clause set (the v2 face's
 *  `clipplayerPadState`). Kept here as a reference implementation so the two
 *  readings are compared BY A TEST rather than by eye — which is exactly what
 *  nobody was doing while they drifted. */
function faceReferenceLadder(
  data: ClipPlayerData | undefined,
  index: number,
): ClipPadState {
  const lane = laneOf(index);
  const slot = slotOf(index);
  // The slice-5 top rungs: an armed/live take owns its pad's picture.
  const ar = data?.audioRec?.[String(lane)];
  if (
    ar &&
    typeof ar === 'object' &&
    (ar.phase === 'armed' || ar.phase === 'recording' || ar.phase === 'stopping') &&
    Number.isInteger(ar.slot) &&
    ar.slot === slot
  ) {
    return ar.phase === 'armed' ? 'rec-armed' : 'rec-active';
  }
  const playing = lanePlaying(data, lane);
  const queued = laneQueued(data, lane);
  if (queued === slot) return 'queued';
  if (playing === slot) return queued === 'stop' ? 'queued' : 'playing';
  const rec = (data?.clips ?? {})[String(index)];
  return rec && coerceClipRecord(rec) ? 'loaded' : 'empty';
}

/** The SUPERSEDED card reading — raw truthiness on the last clause. This is what
 *  the card actually did before the unification, and it is the POSITIVE CONTROL:
 *  if the matrix above cannot tell this apart from the shared helper, the matrix
 *  is not measuring the thing that drifted. */
function rawTruthinessLadder(
  data: ClipPlayerData | undefined,
  index: number,
): ClipPadState {
  const lane = laneOf(index);
  const slot = slotOf(index);
  // Same slice-5 top rungs as the shared helper — the CONTROL models the
  // truthiness drift on the LAST clause, not a missing rec rung.
  const ar = data?.audioRec?.[String(lane)];
  if (
    ar &&
    typeof ar === 'object' &&
    (ar.phase === 'armed' || ar.phase === 'recording' || ar.phase === 'stopping') &&
    Number.isInteger(ar.slot) &&
    ar.slot === slot
  ) {
    return ar.phase === 'armed' ? 'rec-armed' : 'rec-active';
  }
  const playing = lanePlaying(data, lane);
  const queued = laneQueued(data, lane);
  if (queued === slot) return 'queued';
  if (playing === slot) return queued === 'stop' ? 'queued' : 'playing';
  return (data?.clips ?? {})[String(index)] ? 'loaded' : 'empty';
}

describe('clipPadState — one ladder, both surfaces', () => {
  it('agrees with the face surface transcription on every case', () => {
    for (const c of CASES) {
      expect(clipPadState(c.data, c.index), c.why).toBe(faceReferenceLadder(c.data, c.index));
    }
  });

  it('POSITIVE CONTROL: the matrix DOES separate the two readings that drifted', () => {
    // The superseded raw-truthiness clause must disagree with the shared helper
    // somewhere in the matrix. If it did not, a green agreement test above would
    // be proving nothing at all.
    const disagreements = CASES.filter(
      (c) => rawTruthinessLadder(c.data, c.index) !== clipPadState(c.data, c.index),
    ).map((c) => c.why);
    expect(disagreements).toEqual([
      'a record that COERCES AWAY (the retired stamped automation clip)',
      'a MALFORMED audio record (no mediaId) — unschedulable, so not loaded',
    ]);
    // And name the direction, so the fix is legible: raw truthiness painted a
    // pad LOADED that has nothing playable in it.
    for (const c of CASES.filter((x) => disagreements.includes(x.why))) {
      expect(rawTruthinessLadder(c.data, c.index)).toBe('loaded');
      expect(clipPadState(c.data, c.index)).toBe('empty');
    }
  });
});

// ---------------------------------------------------------------------------
// The delegation scan — a re-typed ladder is red
// ---------------------------------------------------------------------------

const LIB_FILES = import.meta.glob('../../**/*.{ts,svelte}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** The clipplayer SURFACES — every file that paints the launch grid. Matched by
 *  path so the v2 face joins this set the moment it lands, without an edit
 *  here. */
const SURFACE_RE = /(ClipplayerCard\.svelte|clipplayer[-/][^/]*face[^/]*\.(ts|svelte)|clipplayer\/.*\.(ts|svelte))$/;

/** The shape of a RE-TYPED ladder: the `queued === slot` clause, which is the
 *  distinctive first rung and cannot be written any other way. */
const LADDER_RE = /queued\s*===\s*slot|q\s*===\s*slot/;

/**
 * Source with comments removed, so the scan reads CODE and not prose.
 *
 * ⚠ A MEASURED NECESSITY, NOT TIDINESS. The first cut matched raw text, and the
 * first surface to delegate CORRECTLY went red — because its comment EXPLAINED
 * the rung it had just stopped writing. A gate that cannot tell an
 * implementation from a sentence about the implementation punishes exactly the
 * documentation this repo runs on, and the obvious workaround ("never name the
 * thing in a comment") is worse than the gate.
 *
 * Deliberately a cheap strip rather than a parser: it removes block and line
 * comments and does not track string literals. A `//` inside a string would
 * over-strip that line, which can only ever cause a MISS, never a false red —
 * and a miss is what the positive control below exists to catch.
 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('the pad ladder is not re-typed on a surface', () => {
  const surfaces = Object.entries(LIB_FILES)
    .filter(([p]) => !p.includes('.test.'))
    .filter(([p]) => SURFACE_RE.test(p));

  it('finds the clipplayer surfaces at all (a vacuous scan is not a pass)', () => {
    // MINIMUM-POPULATION GUARD. A regex that silently stopped matching would
    // otherwise turn this whole describe green by scanning nothing.
    expect(surfaces.length).toBeGreaterThanOrEqual(1);
    // ⚠ AND THE V2 FACE, BY NAME, NOW THAT IT EXISTS. When this helper was
    // written the face was still an unmerged branch, so the scan could only
    // PROMISE to cover it once it landed. It has (#2326), and two surfaces
    // drifting apart is the entire defect this file guards — so "both surfaces
    // are actually being read" is asserted rather than left to the regex's good
    // intentions.
    expect(
      surfaces.some(([p]) => p.endsWith('clipplayer/clipplayer-face-model.ts')),
      'the v2 face model must be in the scanned set — it is the second surface',
    ).toBe(true);
  });

  it('every surface DELEGATES to clipPadState and re-types no ladder of its own', () => {
    // ⚠ NO "BUT IT IMPORTS THE HELPER" ESCAPE. The first cut of this check
    // excused any file that merely MENTIONED `clipPadState`, and a re-typed
    // ladder in a file that imports the helper for its TYPE walked straight
    // through it (measured — the negative control below was green when it
    // should have been red). A delegating surface has no reason to write the
    // `queued === slot` rung at all, so its presence is the offence.
    const offenders = surfaces
      .filter(([, src]) => LADDER_RE.test(stripComments(src)))
      .map(([p]) => p);
    expect(
      offenders,
      'a clipplayer surface computes pad state itself instead of calling clipPadState — ' +
        'that is the second copy this helper exists to prevent',
    ).toEqual([]);
  });

  it('the face model actually calls the shared helper (not merely imports it)', () => {
    // The subject moved with the surface: this used to read another call site
    // of 'clipPadState(dataObj()'. The face model is the surviving one,
    // and it is the one the launch grid now paints from.
    const model = surfaces.find(([p]) => p.endsWith('clipplayer/clipplayer-face-model.ts'))?.[1] ?? '';
    expect(model).toContain('clipPadState(');
  });

  it('POSITIVE CONTROL: the scan still reddens on a re-typed ladder in CODE', () => {
    // ⚠ THE COMMENT STRIP MUST NOT HAVE BLUNTED THE GATE. This feeds the
    // stripper a file that both EXPLAINS the rung in prose and WRITES it in
    // code, and requires the code half to survive — so "reads code, not prose"
    // is a property with a test rather than a claim in a doc comment.
    const proseOnly = `
      // The ladder asks whether queued === slot before anything else.
      /* Historically this file wrote if (q === slot) return 'queued'; */
      export const f = (d, i) => clipPadState(d, i);
    `;
    const reTyped = `
      // Delegates to the shared helper.
      export function f(d, i) {
        if (queued === slot) return 'queued';
        return 'empty';
      }
    `;
    expect(LADDER_RE.test(stripComments(proseOnly)), 'prose alone must NOT redden').toBe(false);
    expect(LADDER_RE.test(stripComments(reTyped)), 'a re-typed rung in CODE must redden').toBe(true);
  });
});
