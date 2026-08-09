// TEMPORARY tuning harness — deleted before the PR lands.
import { describe, it } from 'vitest';
import {
  pitchCandidates,
  centreMass,
  outOfScaleMass,
  expectedAbsDegreeOffset,
  pitchSpread,
  PITCH_PROB_LEVELS,
  pitchProbLevelToValue,
} from './pitch-probability';

const root = 48;
const cands = (x: number, midi = 60, scale: 'major' | undefined = 'major') =>
  pitchCandidates({ midi, instability: x, root, scale });

describe('verify DEFAULT_PITCH_CURVE', () => {
  it('ladder', () => {
    for (const lvl of [0, 10, 16, 20, 24, 32, 40]) {
      const x = pitchProbLevelToValue(lvl);
      const c = cands(x);
      // eslint-disable-next-line no-console
      console.log(
        `//   ${String(lvl).padStart(3)}   ${x.toFixed(2)}   ${(centreMass(c) * 100).toFixed(1)}%  ${(outOfScaleMass(c) * 100).toFixed(1)}%  spread=${pitchSpread(x).toFixed(2)} E|d|=${expectedAbsDegreeOffset(c).toFixed(3)}`,
      );
    }
  });

  it('monotonicity + dead levels', () => {
    let ties = 0;
    let prevC = Infinity;
    let prevO = -1;
    let prevE = -1;
    let violations = 0;
    let firstAudible = -1;
    for (let l = 0; l <= PITCH_PROB_LEVELS; l++) {
      const c = cands(pitchProbLevelToValue(l));
      const cm = centreMass(c);
      const om = outOfScaleMass(c);
      const e = expectedAbsDegreeOffset(c);
      if (l > 0) {
        if (cm > prevC) violations++;
        if (cm === prevC) ties++;
        if (om < prevO) violations++;
        if (e < prevE) violations++;
      }
      if (firstAudible < 0 && cm < 0.99) firstAudible = l;
      prevC = cm;
      prevO = om;
      prevE = e;
    }
    // eslint-disable-next-line no-console
    console.log(`violations=${violations} centre-ties=${ties} first level with >1% mutation = ${firstAudible}`);
  });

  it('privileged peaks across the range', () => {
    for (const x of [0.3, 0.5, 0.7, 0.9, 1]) {
      const c = cands(x);
      const w = (st: number) => c.find((k) => k.semitoneOffset === st)!.weight;
      // eslint-disable-next-line no-console
      console.log(
        `x=${x} oct+: ${(w(12) / w(11)).toFixed(2)}x/${(w(12) / w(13)).toFixed(2)}x  oct-: ${(w(-12) / w(-11)).toFixed(2)}x/${(w(-12) / w(-13)).toFixed(2)}x  5th+: ${(w(7) / w(6)).toFixed(2)}x/${(w(7) / w(8)).toFixed(2)}x  5th-: ${(w(-7) / w(-6)).toFixed(2)}x/${(w(-7) / w(-8)).toFixed(2)}x`,
      );
    }
    // and from E (a non-root note) in C major
    for (const x of [0.3, 0.5, 0.7, 1]) {
      const c = cands(x, 64);
      const w = (st: number) => c.find((k) => k.semitoneOffset === st)!.weight;
      // eslint-disable-next-line no-console
      console.log(
        `E x=${x} oct+: ${(w(12) / w(11)).toFixed(2)}x/${(w(12) / w(13)).toFixed(2)}x  oct-: ${(w(-12) / w(-11)).toFixed(2)}x/${(w(-12) / w(-13)).toFixed(2)}x  5th+: ${(w(7) / w(6)).toFixed(2)}x/${(w(7) / w(8)).toFixed(2)}x  5th-: ${(w(-7) / w(-6)).toFixed(2)}x/${(w(-7) / w(-8)).toFixed(2)}x`,
      );
    }
    // pentatonic + minor sanity
    for (const scale of ['minor', 'pentatonic', 'dorian', 'phrygian', 'mixolydian'] as const) {
      const c = pitchCandidates({ midi: 60, instability: 0.6, root, scale });
      const w = (st: number) => c.find((k) => k.semitoneOffset === st)!.weight;
      const ok12 = w(12) > w(11) && w(12) > w(13) && w(-12) > w(-11) && w(-12) > w(-13);
      const ok7 = w(7) > w(6) && w(7) > w(8) && w(-7) > w(-6) && w(-7) > w(-8);
      // eslint-disable-next-line no-console
      console.log(`${scale}: oct peak=${ok12} fifth peak=${ok7} ooS=${(outOfScaleMass(c) * 100).toFixed(1)}%`);
    }
  });

  it('chromatic clip (no scale)', () => {
    for (const x of [0, 0.25, 0.5, 1]) {
      const c = pitchCandidates({ midi: 60, instability: x, root, scale: undefined });
      // eslint-disable-next-line no-console
      console.log(
        `chromatic x=${x} centre=${(centreMass(c) * 100).toFixed(1)}% ooS=${(outOfScaleMass(c) * 100).toFixed(1)}% E|d|=${expectedAbsDegreeOffset(c).toFixed(3)}`,
      );
    }
  });

  it('spread-arrives-before-chroma ordering, normalized', () => {
    const eMax = expectedAbsDegreeOffset(cands(1));
    const oMax = outOfScaleMass(cands(1));
    let bad = 0;
    for (let l = 1; l < PITCH_PROB_LEVELS; l++) {
      const c = cands(pitchProbLevelToValue(l));
      const eFrac = expectedAbsDegreeOffset(c) / eMax;
      const oFrac = outOfScaleMass(c) / oMax;
      if (!(eFrac > oFrac)) bad++;
    }
    // eslint-disable-next-line no-console
    console.log(`levels where spread-fraction does NOT lead chroma-fraction: ${bad}`);
  });
});
