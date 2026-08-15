// scripts/attest-preflight.test.ts
//
// THE QUIET-MACHINE GUARD, TESTED AGAINST THE SIGNAL THAT BROKE IT (#1331).
//
// The fixture is not invented: it is the 45-sample, 2 s-interval recording of a
// real contended machine from the issue. Every assertion below is driven by
// that series through the REAL exported predicates (`aggregateSamples`,
// `judgeProfile`) — never a re-typed copy of their logic.
//
// The two directions that matter, both permanent legs:
//   · the windowed judge REFUSES on the recorded signal (the fix works), and
//   · a SINGLE-SAMPLE guard — what shipped before — PASSES on a large fraction
//     of the very same instants (the fix was necessary). A gate that only ever
//     proves the first is proving that it can say no, not that it says no to
//     the right thing.
//
// ── WHAT THIS FILE CANNOT SEE ───────────────────────────────────────────────
//   · Whether `ps` output parses (that is webgl-cotenancy's own tests) or
//     whether the REAL sampler is wired into the runners — asserted
//     source-anchored at the bottom, since a perfect predicate nobody calls is
//     the classic green-and-blind gate.
//   · Real timing: `measureCoTenants` sleeps, so these tests drive the pure
//     core instead. The schedule's irregularity IS asserted, from the exported
//     constant rather than from the comment that claims it.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  aggregateSamples,
  judgeProfile,
  SAMPLE_OFFSETS_MS,
  SUSTAINED_FRACTION,
  EGREGIOUS_MULTIPLE,
  type CoTenantProfile,
} from './attest-preflight';
import type { PsRow } from './webgl-cotenancy';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The measured signal from #1331: one co-tenant renderer, 45 samples at 2 s,
 *  oscillating with a period of roughly 4 s. Recorded verbatim. */
const RECORDED_CPU_SERIES = [
  22.4, 30.9, 18.7, 87.1, 5.0, 36.6, 14.6, 32.5, 37.3, 3.7, 36.6, 6.1, 36.3, 36.9, 4.5,
  36.2, 4.7, 37.0, 28.8, 77.0, 33.4, 4.0, 36.7, 9.4, 32.6, 36.6, 3.7, 35.8, 5.7, 20.3,
  34.9, 14.5, 31.5, 7.0, 31.9, 20.5, 18.5, 65.1, 3.5, 31.0, 14.7, 31.3, 36.4, 3.7, 37.3,
];

/** A genuinely idle machine: a backgrounded browser tab's ~5-10 % idle draw,
 *  which the guard must NOT refuse (the "9 % Microsoft Edge — verified
 *  harmless" false refusal the threshold was chosen to avoid). */
const QUIET_CPU_SERIES = [6.2, 5.1, 9.0, 4.4, 7.7, 5.9, 8.3];

const THRESHOLD = 25;

/** One CPU reading → the one-row sample the real sampler would have returned. */
function sampleOf(cpu: number): PsRow[] {
  return [{ cpu, pid: 4242, ppid: 1, name: 'Microsoft Edge Helper (Renderer)' }];
}

function profileFrom(series: number[], opts?: Partial<CoTenantProfile>): CoTenantProfile {
  const samples = series.map(sampleOf);
  const { maxForeignCpu, offenders } = aggregateSamples(samples, THRESHOLD);
  return {
    samples: samples.length,
    windowMs: (series.length - 1) * 2000,
    maxForeignCpu,
    offenders,
    thresholdCpu: THRESHOLD,
    load1: 1.0,
    cores: 10,
    ...opts,
  };
}

describe('the recorded contended machine (#1331) — both directions', () => {
  it('REFUSES on the recorded signal, naming the sustained offender', () => {
    const { quiet, reasons } = judgeProfile(profileFrom(RECORDED_CPU_SERIES));
    expect(quiet, `reasons: ${reasons.join(' | ')}`).toBe(false);
    expect(reasons.join(' ')).toMatch(/SUSTAINED/);
    expect(reasons.join(' '), 'the refusal must name the process').toMatch(/Helper \(Renderer\)/);
  });

  // THE NECESSITY LEG — permanent. If this ever fails, the single-sample guard
  // would have been adequate and this module is over-engineering; if it passes,
  // the old guard was a coin flip on a machine that had to be refused.
  it('a SINGLE-SAMPLE guard passes on a large fraction of those same instants', () => {
    const passingInstants = RECORDED_CPU_SERIES.filter((cpu) => cpu < THRESHOLD);
    const fraction = passingInstants.length / RECORDED_CPU_SERIES.length;
    expect(
      fraction,
      `a single instant chosen from this recording passes ${(fraction * 100).toFixed(0)}% of the ` +
        `time (${passingInstants.length}/${RECORDED_CPU_SERIES.length} readings below ` +
        `${THRESHOLD}% CPU) — which is why one \`ps\` invocation could not decide this`,
    ).toBeGreaterThan(0.3);
  });

  it('PASSES on a genuinely idle machine (positive control — it can say yes)', () => {
    const { quiet, reasons } = judgeProfile(profileFrom(QUIET_CPU_SERIES));
    expect(quiet, `must not refuse an idle machine; reasons: ${reasons.join(' | ')}`).toBe(true);
  });

  it('records peak foreign CPU independent of the threshold (evidence, not a verdict)', () => {
    const profile = profileFrom(RECORDED_CPU_SERIES);
    expect(profile.maxForeignCpu).toBeCloseTo(87.1, 1);
    // Even the quiet machine's peak is recorded, though nothing is an offender.
    const quiet = profileFrom(QUIET_CPU_SERIES);
    expect(quiet.maxForeignCpu).toBeCloseTo(9.0, 1);
    expect(quiet.offenders).toEqual([]);
  });
});

describe('the verdict rules', () => {
  it('a single egregious spike refuses even when it is not sustained', () => {
    // One reading at EGREGIOUS_MULTIPLE× threshold, everything else idle.
    const series = [4, 5, 4, THRESHOLD * EGREGIOUS_MULTIPLE + 1, 5, 4, 5];
    const { quiet, reasons } = judgeProfile(profileFrom(series));
    expect(quiet).toBe(false);
    expect(reasons.join(' ')).toMatch(/SPIKE/);
  });

  it('one brief reading just over threshold does NOT refuse (the annoying direction stays rare)', () => {
    const series = [4, 5, 4, THRESHOLD + 2, 5, 4, 5];
    const { quiet } = judgeProfile(profileFrom(series));
    expect(quiet, 'a lone marginal blip on an otherwise idle machine is not contention').toBe(true);
  });

  it('sustained-but-marginal contention DOES refuse', () => {
    const over = THRESHOLD + 2;
    const series = [over, 5, over, 5, over, 5, over];
    const { quiet, reasons } = judgeProfile(profileFrom(series));
    expect(quiet, reasons.join(' | ')).toBe(false);
    expect(reasons.join(' ')).toMatch(/SUSTAINED/);
  });

  it('aggregate load refuses on its own, and names the numbers', () => {
    const { quiet, reasons } = judgeProfile(
      profileFrom(QUIET_CPU_SERIES, { load1: 9.5, cores: 10 }),
    );
    expect(quiet).toBe(false);
    expect(reasons.join(' ')).toMatch(/LOAD: load\(1m\)=9\.50 on 10 cores/);
  });

  it('separate processes are aggregated separately (no cross-process smearing)', () => {
    // Two different pids each over threshold ONCE — neither is sustained, and
    // neither peaks egregiously, so this must PASS. Smearing them into one
    // counter would refuse.
    const samples: PsRow[][] = [
      [{ cpu: 30, pid: 1, ppid: 1, name: 'A' }],
      [{ cpu: 30, pid: 2, ppid: 1, name: 'B' }],
      [{ cpu: 3, pid: 1, ppid: 1, name: 'A' }],
      [{ cpu: 3, pid: 2, ppid: 1, name: 'B' }],
      [], [], [],
    ];
    const { maxForeignCpu, offenders } = aggregateSamples(samples, THRESHOLD);
    expect(offenders.map((o) => o.samplesOver)).toEqual([1, 1]);
    const { quiet } = judgeProfile({
      samples: samples.length, windowMs: 10_000, maxForeignCpu, offenders,
      thresholdCpu: THRESHOLD, load1: 1, cores: 10,
    });
    expect(quiet).toBe(true);
  });
});

describe('the sampling schedule itself', () => {
  it('is IRREGULAR — no repeated gap, and no common period to alias against', () => {
    const gaps: number[] = [];
    for (let i = 1; i < SAMPLE_OFFSETS_MS.length; i++) {
      gaps.push((SAMPLE_OFFSETS_MS[i] ?? 0) - (SAMPLE_OFFSETS_MS[i - 1] ?? 0));
    }
    expect(new Set(gaps).size, `gaps must all differ, got ${gaps.join(',')}`).toBe(gaps.length);
    const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
    const common = gaps.reduce((a, b) => gcd(a, b));
    // A regular 10 s schedule against the measured ~4 s period read 3.9-5.6%
    // every single time — "quiet", falsely. A large common divisor is exactly
    // that failure waiting to happen.
    expect(common, `gaps share a ${common}ms period: ${gaps.join(',')}`).toBeLessThan(100);
  });

  it('spans several periods of the oscillation it must not alias with', () => {
    const span = SAMPLE_OFFSETS_MS[SAMPLE_OFFSETS_MS.length - 1] ?? 0;
    // The measured co-tenant oscillated with a period of about 4 s.
    expect(span, 'the window must cover multiple oscillations').toBeGreaterThan(4000 * 2);
  });

  it('SUSTAINED_FRACTION needs at least two samples to fire (one reading is never "sustained")', () => {
    const sustainedMin = Math.max(2, Math.ceil(SAMPLE_OFFSETS_MS.length * SUSTAINED_FRACTION));
    expect(sustainedMin).toBeGreaterThanOrEqual(2);
    expect(sustainedMin).toBeLessThan(SAMPLE_OFFSETS_MS.length);
  });
});

// The predicate is worthless if the runners do not call it — and BOTH used to
// carry their own copy (grand's had an older co-tenant regex that could not see
// Discord/Slack/generic Electron renderers at all).
describe('both attest runners use THIS guard — no second copy', () => {
  for (const f of ['webgl-attest.ts', 'grand-attest.ts']) {
    it(`${f} imports preflightSolo and defines none of its own`, () => {
      const src = readFileSync(join(HERE, f), 'utf8');
      expect(src, `${f} must import the shared guard`).toMatch(
        /import\s*\{[^}]*preflightSolo[^}]*\}\s*from\s*'\.\/attest-preflight'/s,
      );
      expect(
        /function\s+preflightSolo\s*\(/.test(src),
        `${f} must NOT define its own preflightSolo — that duplication is #1331's other half`,
      ).toBe(false);
      expect(
        /const\s+COTENANT_RE\s*=/.test(src),
        `${f} must not carry a private co-tenant regex — one match list, in webgl-cotenancy.ts`,
      ).toBe(false);
    });
  }
});
