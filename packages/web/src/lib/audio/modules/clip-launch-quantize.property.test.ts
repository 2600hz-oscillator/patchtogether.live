// packages/web/src/lib/audio/modules/clip-launch-quantize.property.test.ts
//
// fast-check property suite for `nextLaunchBoundary` (#1526) — the Deluge
// "quantize a queued launch to the longest currently-playing clip's next loop
// wrap" math.
//
// Why this core. Two peers must pick the SAME musical wrap from independently
// evolving local audio clocks; if they disagree, the clip fires a bar apart and
// the patch is audibly wrong on one machine and right on the other. That is a
// convergence law over ALL lane phases, which is precisely the shape an example
// test cannot cover. The clip math is pinned by the offline combined-master ART
// (art/scenarios/grand-integration/), which moves only on a deliberate re-pin,
// so properties are what test it BETWEEN pins. (It sat in the grand-attest
// basis too, until that attest was deleted 2026-08-17; the ART pin is the half
// that ran on CI and it survives.)
//
// The laws:
//   P1 FUTURE     — the boundary is STRICTLY after `now`. (`while (wrap <= now)`
//                   exists for this; a boundary in the past schedules a launch
//                   that already happened.)
//   P2 ON GRID    — the boundary is an exact loop-wrap of SOME playing lane:
//                   `nextStepTime + ((len - idx) mod len) * step + k * (len*step)`.
//   P3 ANCHOR     — the anchoring lane is one of MAXIMAL loop duration, and
//                   ties resolve to the FIRST such lane (sceneRepeatAnchor's rule).
//   P4 NULL IFF   — null is returned exactly when no lane has a usable step
//                   duration; never for a lane set that contains one.
//   P5 MONOTONE   — advancing `now` never moves the boundary EARLIER.
//   P6 PERMUTATION-STABLE under a stable sort by (−duration, index) — reordering
//                   equal-duration lanes must not change the answer, because two
//                   peers may hold the same `playing` set in the same order but
//                   reach it by different edits.
//   P7 FINITE     — never NaN/Infinity for finite inputs.
//
// PERMANENT NEGATIVE CONTROLS. Two deliberately-broken variants, each isolating
// ONE line of the real implementation, each REQUIRED to violate the property it
// is paired with:
//   * `withoutFutureRoll`   drops `while (wrap <= now)`      → must violate P1.
//   * `withGreaterOrEqual`  uses `>=` on the duration compare → must violate P3.
// If either stops failing, the corresponding property has stopped constraining
// the code.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { nextLaunchBoundary, type PlayingLaneClock } from './clip-launch-quantize';

// ---------------------------------------------------------------------------
// Generators — shaped like the scheduler's real state.
// ---------------------------------------------------------------------------

const laneClock = fc
  .record({
    lenSteps: fc.integer({ min: 1, max: 64 }),
    // 120 bpm 16ths ≈ 0.125 s; rate/div multipliers span roughly ×8 either way.
    laneStepDur: fc.double({ min: 0.001, max: 2, noNaN: true, noDefaultInfinity: true }),
    nextStepTime: fc.double({ min: 0, max: 1e4, noNaN: true, noDefaultInfinity: true }),
    stepIndex: fc.integer({ min: 0, max: 63 }),
  })
  .map((r) => ({ ...r, stepIndex: r.stepIndex % r.lenSteps }) satisfies PlayingLaneClock);

const playingSet = fc.array(laneClock, { minLength: 1, maxLength: 8 });
const nowSec = fc.double({ min: 0, max: 1e4, noNaN: true, noDefaultInfinity: true });

/** Loop duration of a lane, the way the implementation computes it. */
function loopDur(p: PlayingLaneClock): number {
  const step = Number.isFinite(p.laneStepDur) && p.laneStepDur > 0 ? p.laneStepDur : 0;
  if (step <= 0) return 0;
  return Math.max(1, Math.floor(p.lenSteps)) * step;
}

/** The un-rolled first wrap of a lane. */
function firstWrap(p: PlayingLaneClock): number {
  const step = p.laneStepDur;
  const len = Math.max(1, Math.floor(p.lenSteps));
  const idx = Math.min(Math.max(0, Math.floor(p.stepIndex)), len - 1);
  return p.nextStepTime + ((len - idx) % len) * step;
}

function describeSet(playing: readonly PlayingLaneClock[], now: number): string {
  return (
    `now=${now} playing=[` +
    playing
      .map(
        (p, i) =>
          `#${i}{len=${p.lenSteps} step=${p.laneStepDur} next=${p.nextStepTime} ` +
          `idx=${p.stepIndex} dur=${loopDur(p)}}`,
      )
      .join(', ') +
    ']'
  );
}

// ---------------------------------------------------------------------------
// The two BROKEN variants. Each is the real function with exactly one line
// changed — never an independent reimplementation, so a control failure can
// only mean the property stopped constraining that line.
// ---------------------------------------------------------------------------

function withoutFutureRoll(
  playing: readonly PlayingLaneClock[],
  now: number,
): number | null {
  let best: { dur: number; wrap: number } | null = null;
  for (const p of playing) {
    const step = Number.isFinite(p.laneStepDur) && p.laneStepDur > 0 ? p.laneStepDur : 0;
    if (step <= 0) continue;
    const len = Math.max(1, Math.floor(p.lenSteps));
    const dur = len * step;
    const idx = Math.min(Math.max(0, Math.floor(p.stepIndex)), len - 1);
    const wrap = p.nextStepTime + ((len - idx) % len) * step;
    // ↓ THE DEFECT: no `while (wrap <= now) wrap += dur`.
    if (!best || dur > best.dur) best = { dur, wrap };
  }
  return best ? best.wrap : null;
}

function withGreaterOrEqual(
  playing: readonly PlayingLaneClock[],
  now: number,
): number | null {
  let best: { dur: number; wrap: number; idx: number } | null = null;
  for (let i = 0; i < playing.length; i++) {
    const p = playing[i] as PlayingLaneClock;
    const step = Number.isFinite(p.laneStepDur) && p.laneStepDur > 0 ? p.laneStepDur : 0;
    if (step <= 0) continue;
    const len = Math.max(1, Math.floor(p.lenSteps));
    const dur = len * step;
    const idx = Math.min(Math.max(0, Math.floor(p.stepIndex)), len - 1);
    let wrap = p.nextStepTime + ((len - idx) % len) * step;
    if (Number.isFinite(now)) {
      while (wrap <= now) wrap += dur;
    }
    // ↓ THE DEFECT: `>=` keeps the LAST tied lane, not the first.
    if (!best || dur >= best.dur) best = { dur, wrap, idx: i };
  }
  return best ? best.wrap : null;
}

describe('nextLaunchBoundary properties', () => {
  it('P1: the boundary is STRICTLY in the future', () => {
    fc.assert(
      fc.property(playingSet, nowSec, (playing, now) => {
        const b = nextLaunchBoundary(playing, now);
        fc.pre(b !== null);
        expect(b as number, `boundary not after now — ${describeSet(playing, now)}`)
          .toBeGreaterThan(now);
      }),
      { numRuns: 500, seed: 15281 },
    );
  });

  it('P2: the boundary is an exact loop-wrap of some playing lane', () => {
    fc.assert(
      fc.property(playingSet, nowSec, (playing, now) => {
        const b = nextLaunchBoundary(playing, now);
        fc.pre(b !== null);
        const onGrid = playing.some((p) => {
          const dur = loopDur(p);
          if (dur <= 0) return false;
          const k = ((b as number) - firstWrap(p)) / dur;
          // Whole number of loops after the lane's first wrap, to float
          // tolerance scaled by the magnitude of the times involved.
          const tol = 1e-9 * Math.max(1, Math.abs(b as number) / dur);
          return k >= -tol && Math.abs(k - Math.round(k)) <= tol;
        });
        expect(
          onGrid,
          `boundary ${b} is not a whole number of loops after any lane's wrap — ` +
            describeSet(playing, now),
        ).toBe(true);
      }),
      { numRuns: 500, seed: 15282 },
    );
  });

  it('P3: the anchor is a lane of MAXIMAL loop duration, ties to the FIRST', () => {
    fc.assert(
      fc.property(playingSet, nowSec, (playing, now) => {
        const b = nextLaunchBoundary(playing, now);
        fc.pre(b !== null);
        const usable = playing.filter((p) => loopDur(p) > 0);
        const maxDur = Math.max(...usable.map(loopDur));
        const anchor = usable.find((p) => loopDur(p) === maxDur) as PlayingLaneClock;
        // Recompute the anchor's rolled wrap independently of the subject.
        let want = firstWrap(anchor);
        const dur = loopDur(anchor);
        while (want <= now) want += dur;
        expect(
          b as number,
          `anchored on the wrong lane: got ${b}, the first maximal-duration lane ` +
            `(dur=${maxDur}) wraps at ${want} — ${describeSet(playing, now)}`,
        ).toBeCloseTo(want, 9);
      }),
      { numRuns: 500, seed: 15283 },
    );
  });

  it('P4: null EXACTLY when no lane has a usable step duration', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            lenSteps: fc.integer({ min: 1, max: 16 }),
            // Deliberately includes the unusable values the guard rejects.
            laneStepDur: fc.oneof(
              fc.constantFrom(0, -1, Number.NaN, Number.POSITIVE_INFINITY),
              fc.double({ min: 0.01, max: 1, noNaN: true, noDefaultInfinity: true }),
            ),
            nextStepTime: fc.double({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true }),
            stepIndex: fc.integer({ min: 0, max: 15 }),
          }),
          { maxLength: 6 },
        ),
        nowSec,
        (raw, now) => {
          const playing = raw.map((r) => ({ ...r, stepIndex: r.stepIndex % r.lenSteps }));
          const anyUsable = playing.some(
            (p) => Number.isFinite(p.laneStepDur) && p.laneStepDur > 0,
          );
          const b = nextLaunchBoundary(playing, now);
          expect(
            b === null,
            `null-ness disagrees with usability (anyUsable=${anyUsable}, got ${b}) — ` +
              describeSet(playing, now),
          ).toBe(!anyUsable);
        },
      ),
      { numRuns: 500, seed: 15284 },
    );
  });

  it('P5: advancing `now` never moves the boundary earlier', () => {
    fc.assert(
      fc.property(playingSet, nowSec, nowSec, (playing, a, b) => {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        const bLo = nextLaunchBoundary(playing, lo);
        const bHi = nextLaunchBoundary(playing, hi);
        fc.pre(bLo !== null && bHi !== null);
        expect(
          bHi as number,
          `now ${lo} → ${bLo} but now ${hi} → ${bHi} (went backwards) — ` +
            describeSet(playing, hi),
        ).toBeGreaterThanOrEqual(bLo as number);
      }),
      { numRuns: 500, seed: 15285 },
    );
  });

  it('P6: the result depends only on the lane ORDER the tie rule reads, not on identity', () => {
    fc.assert(
      fc.property(playingSet, nowSec, (playing, now) => {
        // A stable sort by (−duration, original index) puts the tie-winner
        // first without changing WHICH lane wins — so the answer must not move.
        const indexed = playing.map((p, i) => ({ p, i }));
        const sorted = indexed
          .slice()
          .sort((x, y) => loopDur(y.p) - loopDur(x.p) || x.i - y.i)
          .map((x) => x.p);
        const a = nextLaunchBoundary(playing, now);
        const b = nextLaunchBoundary(sorted, now);
        if (a === null || b === null) {
          expect(a).toBe(b);
          return;
        }
        expect(
          b,
          `stable-sorting the lane set changed the boundary (${a} → ${b}) — ` +
            describeSet(playing, now),
        ).toBeCloseTo(a, 9);
      }),
      { numRuns: 400, seed: 15286 },
    );
  });

  it('P7: never NaN/Infinity for finite inputs', () => {
    fc.assert(
      fc.property(playingSet, nowSec, (playing, now) => {
        const b = nextLaunchBoundary(playing, now);
        if (b === null) return;
        expect(
          Number.isFinite(b),
          `non-finite boundary ${b} — ${describeSet(playing, now)}`,
        ).toBe(true);
      }),
      { numRuns: 400, seed: 15287 },
    );
  });

  // -------------------------------------------------------------------
  // PERMANENT NEGATIVE CONTROLS.
  // -------------------------------------------------------------------

  it('CONTROL: dropping the future-roll VIOLATES P1 (so P1 constrains that line)', () => {
    let violations = 0;
    const examples: string[] = [];
    fc.assert(
      fc.property(playingSet, nowSec, (playing, now) => {
        const broken = withoutFutureRoll(playing, now);
        if (broken !== null && broken <= now) {
          violations++;
          if (examples.length < 3) examples.push(`${describeSet(playing, now)} → ${broken}`);
        }
        // The real one must still be clean on the very same input.
        const real = nextLaunchBoundary(playing, now);
        if (real !== null) expect(real).toBeGreaterThan(now);
      }),
      { numRuns: 500, seed: 15288 },
    );
    expect(
      violations,
      'removing `while (wrap <= now) wrap += dur` produced a strictly-future ' +
        'boundary on EVERY generated case. Either the generator stopped producing ' +
        'lanes whose next wrap is already past `now`, or P1 is no longer sensitive ' +
        'to that line.',
    ).toBeGreaterThan(0);
    expect(examples.join('\n')).toMatch(/now=/);
  });

  it('CONTROL: the `>=` tie-break VIOLATES P3 (so the tie rule is really pinned)', () => {
    let violations = 0;
    const examples: string[] = [];
    fc.assert(
      fc.property(
        // Force ties: equal durations, differing phase, so first-vs-last differ.
        fc
          .tuple(
            fc.integer({ min: 1, max: 16 }),
            fc.double({ min: 0.01, max: 0.5, noNaN: true, noDefaultInfinity: true }),
            fc.array(
              fc.double({ min: 0, max: 50, noNaN: true, noDefaultInfinity: true }),
              { minLength: 2, maxLength: 5 },
            ),
          )
          .map(([lenSteps, laneStepDur, phases]) =>
            phases.map((nextStepTime) => ({
              lenSteps,
              laneStepDur,
              nextStepTime,
              stepIndex: 0,
            })),
          ),
        nowSec,
        (playing, now) => {
          const real = nextLaunchBoundary(playing, now);
          const broken = withGreaterOrEqual(playing, now);
          if (real !== null && broken !== null && Math.abs(real - broken) > 1e-9) {
            violations++;
            if (examples.length < 3) {
              examples.push(`${describeSet(playing, now)} → real ${real}, `
                + `>=-variant ${broken}`);
            }
          }
        },
      ),
      { numRuns: 500, seed: 15289 },
    );
    expect(
      violations,
      'the `>=` tie-break agreed with the real `>` on every generated tie. The ' +
        'ties-go-to-the-lowest-lane rule (matching sceneRepeatAnchor) is then ' +
        'unguarded — two peers could anchor on different lanes.',
    ).toBeGreaterThan(0);
    expect(examples.join('\n')).toMatch(/>=-variant/);
  });
});
