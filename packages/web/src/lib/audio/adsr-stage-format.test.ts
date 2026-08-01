// packages/web/src/lib/audio/adsr-stage-format.test.ts
//
// The unit gate for adsr's PF-3 readout law. Three layers, deliberately:
//
//  1. TABLE — the exact strings, including the two rounding BAND EDGES where a
//     naive implementation prints "10.0 ms" or "1000 ms".
//  2. PROPERTY — parse every readout back to seconds across a log sweep of the
//     REAL declared range and assert (a) it never misstates the value by more
//     than HALF ITS OWN LAST PRINTED DIGIT and (b) it never inverts. A readout
//     that is not monotone is not a scale, and a per-value table can't see that.
//     ⚠ The tolerance is derived FROM THE TEXT, not fixed: a flat "within 1 %"
//     would be wrong at the bottom of the range (1.0 ms of printed resolution
//     against a 1 ms value is 5 %) — i.e. the naive instrument would fail a
//     correct formatter and read exactly like a finding.
//  3. THE DEF TIE — the four stage params actually DECLARE these formatters, and
//     their DEFAULTS format to the text the dock mock shows. A model nobody
//     wired up is a model that ships dead (the card-vs-def blindness class:
//     every gate that reads only one side proves nothing about the other).

import { describe, it, expect } from 'vitest';
import { formatStageTime, formatSustainLevel, NON_FINITE_READOUT } from './adsr-stage-format';
import { adsrDef } from './modules/adsr';

const READOUT = /^([\d.]+) (ms|s)$/;

/** Read a readout back to SECONDS — the inverse the property test needs. */
function parseReadout(text: string): number {
  const m = text.match(READOUT);
  if (!m) throw new Error(`unparseable readout: "${text}"`);
  const n = Number(m[1]);
  return m[2] === 'ms' ? n / 1000 : n;
}

/** HALF the place value of the readout's own last printed digit, in seconds —
 *  the most a correctly-rounded string of that precision can be off by. */
function halfPrintedStep(text: string): number {
  const m = text.match(READOUT);
  if (!m) throw new Error(`unparseable readout: "${text}"`);
  const decimals = (m[1]!.split('.')[1] ?? '').length;
  const unit = m[2] === 'ms' ? 1e-3 : 1;
  return 0.5 * Math.pow(10, -decimals) * unit;
}

describe('formatStageTime — the unit-banded stage readout', () => {
  it('prints sub-10 ms with one decimal, trailing ".0" trimmed', () => {
    expect(formatStageTime(0.001)).toBe('1 ms'); // the param MIN
    expect(formatStageTime(0.0015)).toBe('1.5 ms');
    expect(formatStageTime(0.005)).toBe('5 ms'); // the attack DEFAULT
    expect(formatStageTime(0.008)).toBe('8 ms'); // the mock's attack readout
    expect(formatStageTime(0.0099)).toBe('9.9 ms');
  });

  it('prints 10 ms … 999 ms as whole milliseconds', () => {
    expect(formatStageTime(0.01)).toBe('10 ms');
    expect(formatStageTime(0.1)).toBe('100 ms'); // the decay DEFAULT
    expect(formatStageTime(0.22)).toBe('220 ms'); // the mock's decay readout
    expect(formatStageTime(0.3)).toBe('300 ms'); // the release DEFAULT
    expect(formatStageTime(0.48)).toBe('480 ms'); // the mock's release readout
    expect(formatStageTime(0.9994)).toBe('999 ms');
  });

  it('prints a second and over in seconds', () => {
    expect(formatStageTime(1)).toBe('1.00 s');
    expect(formatStageTime(2.5)).toBe('2.50 s');
    expect(formatStageTime(9.994)).toBe('9.99 s');
    expect(formatStageTime(10)).toBe('10.0 s'); // the param MAX
  });

  it('never rounds ACROSS a unit at a band edge', () => {
    // The two values a naive banding gets wrong: 9.95 ms would print "10.0 ms"
    // (a decimal the 10-ms band does not use) and 999.6 ms would print
    // "1000 ms" (a millisecond count nobody reads as a second).
    expect(formatStageTime(0.00995)).toBe('10 ms');
    expect(formatStageTime(0.9996)).toBe('1.00 s');
    expect(formatStageTime(9.996)).toBe('10.0 s');
  });

  it('is TOTAL: non-finite and non-positive input still produce a visible string', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(formatStageTime(bad)).toBe(NON_FINITE_READOUT);
    }
    expect(formatStageTime(0)).toBe('0 ms');
    expect(formatStageTime(-1)).toBe('0 ms');
    // `format` also feeds aria-valuetext — an empty readout reads as "no
    // vocabulary declared" and silently un-renders the element.
    for (const v of [NaN, 0, -1, 0.005, 10]) expect(formatStageTime(v).length).toBeGreaterThan(0);
  });

  it('is ACCURATE and MONOTONE across the declared range (parse the text back)', () => {
    const min = 0.001;
    const max = 10;
    const N = 400;
    let prev = -Infinity;
    let prevText = '';
    for (let i = 0; i <= N; i++) {
      // Log sweep — the curve the param actually uses, so the samples land
      // where the dial's travel actually is.
      const v = min * Math.pow(max / min, i / N);
      const text = formatStageTime(v);
      const back = parseReadout(text);
      expect(
        Math.abs(back - v),
        `"${text}" states ${v} s to within half its own last digit (${halfPrintedStep(text)} s)`,
      ).toBeLessThanOrEqual(halfPrintedStep(text) + 1e-12);
      expect(back, `readout is monotone: "${prevText}" → "${text}"`).toBeGreaterThanOrEqual(prev);
      prev = back;
      prevText = text;
    }
  });
});

describe('formatSustainLevel — the one stage that is a LEVEL', () => {
  it('prints two decimals with no unit', () => {
    expect(formatSustainLevel(0)).toBe('0.00');
    expect(formatSustainLevel(0.62)).toBe('0.62'); // the mock's sustain readout
    expect(formatSustainLevel(0.7)).toBe('0.70'); // the DEFAULT
    expect(formatSustainLevel(1)).toBe('1.00');
  });

  it('carries no "s" — that is what distinguishes it from the three times', () => {
    expect(formatSustainLevel(0.7)).not.toContain('s');
  });

  it('is TOTAL for non-finite input', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(formatSustainLevel(bad)).toBe(NON_FINITE_READOUT);
    }
  });
});

describe('the DEF TIE — adsr actually declares these formatters', () => {
  const byId = new Map(adsrDef.params.map((p) => [p.id, p]));

  it('every stage param declares a format (else the readout never renders)', () => {
    // KnobConic renders the persistent readout ONLY when the param declared a
    // vocabulary (knobReadout returns null otherwise), so a missing `format`
    // is not a downgrade — it is an absent control affordance.
    for (const id of ['attack', 'decay', 'sustain', 'release']) {
      expect(typeof byId.get(id)?.format, `${id}.format`).toBe('function');
    }
  });

  it('each stage DEFAULT formats to the text the dock mock shows', () => {
    expect(byId.get('attack')?.format?.(byId.get('attack')!.defaultValue)).toBe('5 ms');
    expect(byId.get('decay')?.format?.(byId.get('decay')!.defaultValue)).toBe('100 ms');
    expect(byId.get('sustain')?.format?.(byId.get('sustain')!.defaultValue)).toBe('0.70');
    expect(byId.get('release')?.format?.(byId.get('release')!.defaultValue)).toBe('300 ms');
  });

  it('the three TIME stages share one formatter and sustain does not', () => {
    const times = ['attack', 'decay', 'release'].map((id) => byId.get(id)?.format);
    for (const f of times) expect(f?.(0.25)).toBe('250 ms');
    // The level formatter would print "0.25" for the same number — the two are
    // genuinely different laws, not a copy-paste.
    expect(byId.get('sustain')?.format?.(0.25)).toBe('0.25');
  });

  it('formats the extremes of each param RANGE without falling back', () => {
    for (const id of ['attack', 'decay', 'sustain', 'release']) {
      const p = byId.get(id)!;
      for (const v of [p.min, p.max, (p.min + p.max) / 2]) {
        // `expect(p.format?.(v))` would pass VACUOUSLY on a param that declares
        // no formatter at all (undefined is not the placeholder either) — the
        // negative control caught exactly that. Demand a real string.
        const out = p.format?.(v);
        expect(typeof out, `${id}.format(${v}) returns a string`).toBe('string');
        expect(out, `${id}.format(${v})`).not.toBe(NON_FINITE_READOUT);
      }
    }
  });
});
