// packages/web/src/lib/audio/clip-audio-rec-machine.test.ts
//
// The PURE half of the clip recorder: the frame maths and the §4.4 arm state
// machine, held down with no audio context at all.
//
// THE LOAD-BEARING TEST IS THE DRIFT ONE. `stopFrame` for a long endless take
// must be `startFrame + n × unitFrames` computed from the ANCHOR in integer
// arithmetic — never seconds accumulated loop by loop and re-rounded. The
// accumulating spelling drifts by the fractional part of the loop's frame
// length on every pass; at 133 bpm that is ~0.46 frames/loop ≈ 459 frames over
// 1000 loops. The POSITIVE CONTROL below implements that broken spelling and
// asserts the drift test would catch it — an inert control proves nothing in
// either direction (§0.3 A's lesson: two earlier insert-identity controls were
// themselves inert and the test was vacuous until measured).
//
// THE TRANSITION MATRIX IS TOTAL. Every (phase × event) pair is asserted,
// including the spec's two named no-ops: a second STOP during STOPPING (stop
// sooner = a partial loop, the one outcome the mode forbids) and any gesture
// during COMMITTING. Unlisted pairs must be EXPLICIT no-ops — same state, zero
// effects — so a new event can never fall through to an accidental phase.

import { describe, it, expect } from 'vitest';
import {
  CLIP_REC_FALLBACK_BPM,
  CLIP_REC_IDLE,
  clipRecBpm,
  clipRecEndlessStopFrame,
  clipRecLoopFrame,
  clipRecStartFrame,
  clipRecTransition,
  clipRecUnitFrames,
  clipRecWholeUnits,
  type ClipRecEffect,
  type ClipRecEvent,
  type ClipRecState,
} from './clip-audio-rec-machine';
import { RATE_MULTS } from './modules/clip-clock';

const SR = 48_000;

// ---------------------------------------------------------------------------
// Frame maths
// ---------------------------------------------------------------------------

describe('clipRecBpm — the TIMELORDE-else-120 rule', () => {
  it('passes a finite positive tempo through', () => {
    expect(clipRecBpm(133)).toBe(133);
    expect(clipRecBpm(62.5)).toBe(62.5);
  });
  it('falls back to 120 for everything else (no TIMELORDE, junk payloads)', () => {
    for (const junk of [undefined, null, 0, -5, NaN, Infinity, -Infinity, '128', {}, true]) {
      expect(clipRecBpm(junk)).toBe(CLIP_REC_FALLBACK_BPM);
    }
    expect(CLIP_REC_FALLBACK_BPM).toBe(120);
  });
});

describe('clipRecUnitFrames — rounding', () => {
  // baseStepDur at the default 1/16 grid (4 steps per beat).
  const stepDur = (bpm: number) => 60 / bpm / 4;

  it('120 bpm / 16 steps / 1x / 48k = exactly 96 000 frames (one bar)', () => {
    expect(clipRecUnitFrames(16, stepDur(120), 3, SR)).toBe(96_000);
  });

  it('a non-dividing tempo rounds ONCE: 133 bpm / 16 steps = 86 617', () => {
    // 16 × (60/133/4) × 48000 = 86 616.5413…, round → 86 617. The ≤½-sample
    // error is paid here, once, and clipRecLoopFrame never re-pays it.
    expect(clipRecUnitFrames(16, stepDur(133), 3, SR)).toBe(86_617);
  });

  it('scales by the lane rate table, not a private copy of it', () => {
    const base = clipRecUnitFrames(16, stepDur(120), 3, SR);
    // 2x (index 4) halves the step duration; 1/2 (index 2) doubles it.
    expect(clipRecUnitFrames(16, stepDur(120), 4, SR)).toBe(base / 2);
    expect(clipRecUnitFrames(16, stepDur(120), 2, SR)).toBe(base * 2);
    // Pin the table identity this math rests on.
    expect(RATE_MULTS[3]).toBe(1);
  });

  it('clamps degenerate inputs to at least one step / one frame', () => {
    expect(clipRecUnitFrames(0, stepDur(120), 3, SR)).toBe(clipRecUnitFrames(1, stepDur(120), 3, SR));
    expect(clipRecUnitFrames(1, 1e-9, 3, SR)).toBe(1);
  });
});

describe('clipRecStartFrame', () => {
  it('rounds a boundary time to the nearest frame', () => {
    expect(clipRecStartFrame(3.7, SR)).toBe(177_600);
    expect(clipRecStartFrame(0, SR)).toBe(0);
    expect(clipRecStartFrame(1 / 3, SR)).toBe(16_000);
  });
});

describe('clipRecLoopFrame — NO DRIFT over 1000 loops (anchor-derived)', () => {
  // 133 bpm: the loop's true frame length is 86 616.5413…, so any spelling
  // that re-rounds accumulated seconds drifts ~0.46 frames per loop.
  const unit = clipRecUnitFrames(16, 60 / 133 / 4, 3, SR);
  const start = clipRecStartFrame(3.7, SR);

  it('every successive boundary is EXACTLY unitFrames apart, 1000 times', () => {
    let prev = clipRecLoopFrame(start, unit, 0);
    expect(prev).toBe(start);
    for (let n = 1; n <= 1000; n++) {
      const b = clipRecLoopFrame(start, unit, n);
      expect(b - prev).toBe(unit); // exact integer ===, not toBeCloseTo
      prev = b;
    }
    expect(prev).toBe(start + 1000 * unit);
    expect(Number.isSafeInteger(prev)).toBe(true);
  });

  it('POSITIVE CONTROL: the seconds-accumulating spelling DRIFTS — this test can see the failure it exists for', () => {
    // The broken derivation: accumulate the loop length in float seconds and
    // re-round each pass — "repeated addition" instead of the anchor.
    const loopSeconds = 16 * (60 / 133 / 4);
    let tSec = 0;
    let broken = start;
    for (let n = 1; n <= 1000; n++) {
      tSec += loopSeconds;
      broken = Math.round(start + tSec * SR);
    }
    const anchored = clipRecLoopFrame(start, unit, 1000);
    const drift = Math.abs(broken - anchored);
    // The control must be a REAL perturbation (an inert control proves
    // nothing): at this tempo the accumulated drift is hundreds of frames.
    expect(drift).toBeGreaterThan(100);
    expect(broken).not.toBe(anchored);
  });
});

describe('clipRecEndlessStopFrame — the whole-multiple round-up', () => {
  const start = 1000;
  const unit = 86_617;
  it('a stop landing exactly ON a boundary stops there', () => {
    expect(clipRecEndlessStopFrame(start, unit, start + 2 * unit)).toBe(start + 2 * unit);
  });
  it('one frame past a boundary rounds UP a whole loop', () => {
    expect(clipRecEndlessStopFrame(start, unit, start + 2 * unit + 1)).toBe(start + 3 * unit);
  });
  it('a STOP the instant recording starts still records ONE whole loop', () => {
    expect(clipRecEndlessStopFrame(start, unit, start)).toBe(start + unit);
    expect(clipRecEndlessStopFrame(start, unit, start - 5)).toBe(start + unit);
  });
});

describe('clipRecWholeUnits — the truncation count', () => {
  it('floors to whole loops and never goes negative', () => {
    expect(clipRecWholeUnits(0, 100, 250)).toBe(2);
    expect(clipRecWholeUnits(0, 100, 200)).toBe(2);
    expect(clipRecWholeUnits(0, 100, 99)).toBe(0);
    expect(clipRecWholeUnits(500, 100, 400)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The transition matrix — TOTAL over (phase × event)
// ---------------------------------------------------------------------------

const START = 96_000;
const UNIT = 48_000;

const armedSingle: ClipRecState = {
  phase: 'armed',
  mode: 'single',
  window: { startFrame: START, stopFrame: START + UNIT, unitFrames: UNIT },
};
const armedEndless: ClipRecState = {
  phase: 'armed',
  mode: 'endless',
  window: { startFrame: START, stopFrame: null, unitFrames: UNIT },
};
const recordingSingle: ClipRecState = {
  phase: 'recording',
  mode: 'single',
  window: { startFrame: START, stopFrame: START + UNIT, unitFrames: UNIT },
};
const recordingEndless: ClipRecState = {
  phase: 'recording',
  mode: 'endless',
  window: { startFrame: START, stopFrame: null, unitFrames: UNIT },
};
const stopping: ClipRecState = {
  phase: 'stopping',
  mode: 'endless',
  window: { startFrame: START, stopFrame: START + 3 * UNIT, unitFrames: UNIT },
};
const committing: ClipRecState = {
  phase: 'committing',
  mode: 'single',
  window: { startFrame: START, stopFrame: START + UNIT, unitFrames: UNIT },
  frames: UNIT,
};

const kinds = (effects: readonly ClipRecEffect[]) => effects.map((e) => e.kind);

/** Assert an EXPLICIT no-op: the SAME state object back, zero effects. */
function expectNoop(state: ClipRecState, event: ClipRecEvent) {
  const r = clipRecTransition(state, event);
  expect(r.state).toBe(state);
  expect(r.effects).toHaveLength(0);
}

describe('IDLE', () => {
  it('arm(single) → armed, stopFrame NORMALIZED to the anchor + one unit (the caller is not trusted)', () => {
    const r = clipRecTransition(CLIP_REC_IDLE, {
      type: 'arm',
      mode: 'single',
      // Deliberately wrong stopFrame from the caller — the machine enforces.
      window: { startFrame: START, stopFrame: null, unitFrames: UNIT },
    });
    expect(r.state).toEqual(armedSingle);
    expect(r.effects).toEqual([
      { kind: 'armWorklet', window: { startFrame: START, stopFrame: START + UNIT, unitFrames: UNIT } },
    ]);
  });
  it('arm(endless) → armed with stopFrame null, whatever the caller passed', () => {
    const r = clipRecTransition(CLIP_REC_IDLE, {
      type: 'arm',
      mode: 'endless',
      window: { startFrame: START, stopFrame: START + 7, unitFrames: UNIT },
    });
    expect(r.state).toEqual(armedEndless);
    expect(kinds(r.effects)).toEqual(['armWorklet']);
  });
  it('everything else is an explicit no-op', () => {
    expectNoop(CLIP_REC_IDLE, { type: 'frame', frame: 1e9 });
    expectNoop(CLIP_REC_IDLE, { type: 'stop', frame: 0 });
    expectNoop(CLIP_REC_IDLE, { type: 'cancel' });
    expectNoop(CLIP_REC_IDLE, { type: 'transportStop', frame: 0 });
    expectNoop(CLIP_REC_IDLE, { type: 'budgetCeiling', frame: 0 });
    expectNoop(CLIP_REC_IDLE, { type: 'commitOk' });
    expectNoop(CLIP_REC_IDLE, { type: 'commitFail' });
  });
});

describe('ARMED', () => {
  it('re-tap the SAME mode = cancel (disarm)', () => {
    const r = clipRecTransition(armedSingle, { type: 'arm', mode: 'single', window: armedSingle.window });
    expect(r.state).toBe(CLIP_REC_IDLE);
    expect(kinds(r.effects)).toEqual(['cancelWorklet', 'discardScratch']);
  });
  it('arm the OTHER mode switches in place, re-resolving stopFrame from its OWN anchor', () => {
    const toEndless = clipRecTransition(armedSingle, {
      type: 'arm',
      mode: 'endless',
      // The event's window is ignored on a switch — pass junk to prove it.
      window: { startFrame: 1, stopFrame: 2, unitFrames: 3 },
    });
    expect(toEndless.state).toEqual(armedEndless);
    expect(kinds(toEndless.effects)).toEqual(['armWorklet']);
    const toSingle = clipRecTransition(armedEndless, {
      type: 'arm',
      mode: 'single',
      window: { startFrame: 1, stopFrame: null, unitFrames: 3 },
    });
    expect(toSingle.state).toEqual(armedSingle);
    expect(kinds(toSingle.effects)).toEqual(['armWorklet']);
  });
  it('a frame before startFrame is a no-op; reaching it punches in', () => {
    expectNoop(armedSingle, { type: 'frame', frame: START - 1 });
    const r = clipRecTransition(armedSingle, { type: 'frame', frame: START });
    expect(r.state).toEqual(recordingSingle);
    expect(r.effects).toHaveLength(0);
  });
  it('a degenerate jump past the whole window goes straight to committing', () => {
    const r = clipRecTransition(armedSingle, { type: 'frame', frame: START + UNIT });
    expect(r.state).toEqual({ ...committing, mode: 'single' });
    expect(r.effects).toEqual([{ kind: 'beginCommit', frames: UNIT }]);
  });
  it('transport stop / cancel discard — nothing was captured', () => {
    for (const event of [{ type: 'transportStop', frame: START } as const, { type: 'cancel' } as const]) {
      const r = clipRecTransition(armedEndless, event);
      expect(r.state).toBe(CLIP_REC_IDLE);
      expect(kinds(r.effects)).toEqual(['cancelWorklet', 'discardScratch']);
    }
  });
  it('everything else is an explicit no-op', () => {
    expectNoop(armedSingle, { type: 'stop', frame: START });
    expectNoop(armedSingle, { type: 'budgetCeiling', frame: START });
    expectNoop(armedSingle, { type: 'commitOk' });
    expectNoop(armedSingle, { type: 'commitFail' });
  });
});

describe('RECORDING', () => {
  it('single: stopFrame reached → committing exactly one unit', () => {
    expectNoop(recordingSingle, { type: 'frame', frame: START + UNIT - 1 });
    const r = clipRecTransition(recordingSingle, { type: 'frame', frame: START + UNIT });
    expect(r.state).toEqual(committing);
    expect(r.effects).toEqual([{ kind: 'beginCommit', frames: UNIT }]);
  });
  it('endless: STOP mid-loop resolves stopFrame to the NEXT whole multiple (2.5 loops → 3)', () => {
    const r = clipRecTransition(recordingEndless, {
      type: 'stop',
      frame: START + Math.round(2.5 * UNIT),
    });
    expect(r.state).toEqual(stopping);
    expect(r.effects).toEqual([{ kind: 'stopWorklet', stopFrame: START + 3 * UNIT }]);
  });
  it('endless with no stop request never self-commits', () => {
    expectNoop(recordingEndless, { type: 'frame', frame: START + 100 * UNIT });
  });
  it('single: STOP is a no-op (single stops itself)', () => {
    expectNoop(recordingSingle, { type: 'stop', frame: START + 10 });
  });
  it('cancel discards the whole take', () => {
    const r = clipRecTransition(recordingEndless, { type: 'cancel' });
    expect(r.state).toBe(CLIP_REC_IDLE);
    expect(kinds(r.effects)).toEqual(['cancelWorklet', 'discardScratch']);
  });
  it('transport stop mid-endless TRUNCATES AND REPORTS at the whole loop (2.7 → 2)', () => {
    // ⚠ THIS PINNED A TAKE-LOSING BUG UNTIL 2026-09-04. It asserted
    // `[cancelWorklet, beginCommit]`, a self-contradicting pair: the worklet's
    // `cancel` discards a lane silently — no final chunk, no `done` — while
    // `beginCommit` waits for `done` before it will encode. Every endless take
    // ended by a transport stop therefore timed out and landed in the recovery
    // pile instead of the clip. The test was green the whole time because it
    // only ever read the effect NAMES.
    //
    // The take now stops the way a graceful STOP does: `stopWorklet` at the
    // whole-loop boundary, phase `stopping`, and the commit follows on the next
    // `frame` (asserted below) — one path, already proven.
    const r = clipRecTransition(recordingEndless, {
      type: 'transportStop',
      frame: START + Math.round(2.7 * UNIT),
    });
    const stopFrame = START + 2 * UNIT;
    expect(r.state).toEqual({
      phase: 'stopping',
      mode: 'endless',
      window: { ...recordingEndless.window, stopFrame },
    });
    expect(kinds(r.effects)).toEqual(['stopWorklet']);
    expect(r.effects[0]).toEqual({ kind: 'stopWorklet', stopFrame });
    // ⚠ AND IT REACHES THE COMMIT. A stop effect that never commits would be a
    // different way to lose the take, so the second half is asserted rather
    // than assumed: the very next frame observation (already past a stopFrame
    // that lies in the PAST) commits exactly two whole loops.
    const c = clipRecTransition(r.state, {
      type: 'frame',
      frame: START + Math.round(2.7 * UNIT),
    });
    expect(c.state).toEqual({
      phase: 'committing',
      mode: 'endless',
      window: { ...recordingEndless.window, stopFrame },
      frames: 2 * UNIT,
    });
    expect(c.effects).toEqual([{ kind: 'beginCommit', frames: 2 * UNIT }]);
  });
  it('transport stop mid-endless below one whole loop discards', () => {
    const r = clipRecTransition(recordingEndless, {
      type: 'transportStop',
      frame: START + Math.round(0.5 * UNIT),
    });
    expect(r.state).toBe(CLIP_REC_IDLE);
    expect(kinds(r.effects)).toEqual(['cancelWorklet', 'discardScratch']);
  });
  it('transport stop mid-single discards — a partial is not a shorter single', () => {
    const r = clipRecTransition(recordingSingle, { type: 'transportStop', frame: START + UNIT - 1 });
    expect(r.state).toBe(CLIP_REC_IDLE);
    expect(kinds(r.effects)).toEqual(['cancelWorklet', 'discardScratch']);
  });
  it('budget ceiling auto-stops at the PREVIOUS whole unit — and reaches the commit', () => {
    const r = clipRecTransition(recordingEndless, {
      type: 'budgetCeiling',
      frame: START + Math.round(3.9 * UNIT),
    });
    const stopFrame = START + 3 * UNIT;
    expect(r.state.phase).toBe('stopping');
    expect(r.effects).toEqual([{ kind: 'stopWorklet', stopFrame }]);
    const c = clipRecTransition(r.state, {
      type: 'frame',
      frame: START + Math.round(3.9 * UNIT),
    });
    expect(c.state.phase).toBe('committing');
    expect((c.state as Extract<ClipRecState, { phase: 'committing' }>).frames).toBe(3 * UNIT);
    expect(c.effects).toEqual([{ kind: 'beginCommit', frames: 3 * UNIT }]);
  });
  it('⚠ NO PATH EVER PAIRS cancelWorklet WITH beginCommit — the take-losing shape', () => {
    // A REGRESSION PIN, not a transition test. `cancel` makes the worklet
    // discard its lane silently (no final chunk, no `done`); `beginCommit`
    // waits for `done`. Any transition emitting both asks a lane to report and
    // to vanish, and the commit times out — which is how every endless take
    // ended by a transport stop was lost until 2026-09-04.
    //
    // Exhaustive over the live phases × every event, so a future edit that
    // reintroduces the pair anywhere reddens here rather than in production.
    const states: ClipRecState[] = [recordingSingle, recordingEndless, stopping, armedSingle];
    const events: ClipRecEvent[] = [
      { type: 'frame', frame: START + Math.round(2.7 * UNIT) },
      { type: 'stop', frame: START + Math.round(2.7 * UNIT) },
      { type: 'cancel' },
      { type: 'transportStop', frame: START + Math.round(2.7 * UNIT) },
      { type: 'budgetCeiling', frame: START + Math.round(2.7 * UNIT) },
      { type: 'commitOk' },
      { type: 'commitFail' },
    ];
    const offenders: string[] = [];
    let sawCancel = 0;
    let sawCommit = 0;
    for (const st of states) {
      for (const ev of events) {
        const k = kinds(clipRecTransition(st, ev).effects);
        if (k.includes('cancelWorklet')) sawCancel++;
        if (k.includes('beginCommit')) sawCommit++;
        if (k.includes('cancelWorklet') && k.includes('beginCommit')) {
          offenders.push(`${st.phase} + ${ev.type} → [${k.join(', ')}]`);
        }
      }
    }
    expect(offenders, 'a transition asks the worklet to vanish AND to report').toEqual([]);
    // VACUITY GUARD: the sweep must actually reach both effects, or an empty
    // offenders list would prove only that the matrix drove nothing.
    expect(sawCancel, 'the sweep reached cancelWorklet at all').toBeGreaterThan(0);
    expect(sawCommit, 'the sweep reached beginCommit at all').toBeGreaterThan(0);
  });
  it('everything else is an explicit no-op', () => {
    expectNoop(recordingSingle, { type: 'arm', mode: 'single', window: recordingSingle.window });
    expectNoop(recordingSingle, { type: 'commitOk' });
    expectNoop(recordingSingle, { type: 'commitFail' });
  });
});

describe('STOPPING', () => {
  it('⚠ a SECOND STOP is a deliberate no-op — stopping sooner would be a partial loop', () => {
    expectNoop(stopping, { type: 'stop', frame: START + UNIT }); // "stop sooner"
    expectNoop(stopping, { type: 'stop', frame: START + 10 * UNIT }); // "stop later"
  });
  it('stopFrame reached → committing exactly n whole units', () => {
    expectNoop(stopping, { type: 'frame', frame: START + 3 * UNIT - 1 });
    const r = clipRecTransition(stopping, { type: 'frame', frame: START + 3 * UNIT });
    expect(r.state).toEqual({
      phase: 'committing',
      mode: 'endless',
      window: stopping.window,
      frames: 3 * UNIT,
    });
    expect(r.effects).toEqual([{ kind: 'beginCommit', frames: 3 * UNIT }]);
  });
  it('CANCEL is the escape', () => {
    const r = clipRecTransition(stopping, { type: 'cancel' });
    expect(r.state).toBe(CLIP_REC_IDLE);
    expect(kinds(r.effects)).toEqual(['cancelWorklet', 'discardScratch']);
  });
  it('transport stop before the resolved boundary RE-STOPS SHORTER, then commits the whole loops so far', () => {
    // A transport stop during STOPPING is the one thing that may shorten an
    // already-resolved stop (a second STOP gesture may not — see above). It
    // re-issues `stopWorklet` at the earlier whole-loop boundary; the worklet's
    // own "never EXTEND a resolved stop" guard accepts a shortening.
    const r = clipRecTransition(stopping, {
      type: 'transportStop',
      frame: START + Math.round(2.4 * UNIT),
    });
    const stopFrame = START + 2 * UNIT;
    expect(r.state.phase).toBe('stopping');
    expect(r.effects).toEqual([{ kind: 'stopWorklet', stopFrame }]);
    // …and it still reaches the commit, which is the half that was lost.
    const c = clipRecTransition(r.state, {
      type: 'frame',
      frame: START + Math.round(2.4 * UNIT),
    });
    expect(c.state.phase).toBe('committing');
    expect((c.state as Extract<ClipRecState, { phase: 'committing' }>).frames).toBe(2 * UNIT);
    expect(c.effects).toEqual([{ kind: 'beginCommit', frames: 2 * UNIT }]);
  });
  it('everything else is an explicit no-op', () => {
    expectNoop(stopping, { type: 'arm', mode: 'endless', window: stopping.window });
    expectNoop(stopping, { type: 'commitOk' });
    expectNoop(stopping, { type: 'commitFail' });
  });
});

describe('COMMITTING', () => {
  it('commitOk → idle, clean', () => {
    const r = clipRecTransition(committing, { type: 'commitOk' });
    expect(r.state).toBe(CLIP_REC_IDLE);
    expect(r.effects).toHaveLength(0);
  });
  it('commitFail → idle, scratch KEPT as a recover candidate', () => {
    const r = clipRecTransition(committing, { type: 'commitFail' });
    expect(r.state).toBe(CLIP_REC_IDLE);
    expect(r.effects).toEqual([{ kind: 'keepRecoverScratch' }]);
  });
  it('every gesture is an explicit no-op — the frames are already decided', () => {
    expectNoop(committing, { type: 'arm', mode: 'single', window: committing.window });
    expectNoop(committing, { type: 'frame', frame: 1e9 });
    expectNoop(committing, { type: 'stop', frame: 0 });
    expectNoop(committing, { type: 'cancel' });
    expectNoop(committing, { type: 'transportStop', frame: 0 });
    expectNoop(committing, { type: 'budgetCeiling', frame: 0 });
  });
});
