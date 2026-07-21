// scripts/behavioral-watchdog.test.ts
//
// Unit coverage for the behavioral/collab CI watchdog aggregator
// (scripts/behavioral-watchdog.mjs). These are the pure decision functions the
// push-only `behavioral-watchdog` job leans on — the job itself can't be fully
// e2e'd until it runs on a real push, so the brain gets tested here instead.
//
// Covers exactly the units the spec calls out:
//   • parse a fixture shard JSON → passed/failed set
//   • diff-vs-last-green → newly-failing
//   • db-absent → vacuous flag
// plus reproduction-intersection + grep-building.

import { describe, expect, it } from 'vitest';
import {
  parseBehavioralReport,
  parseCollabAttestation,
  diffNewlyFailing,
  reproducedFailures,
  buildGrep,
  moduleIdFromTitle,
  specOutcome,
  BEHAVIORAL_TITLE_MARK,
} from './behavioral-watchdog.mjs';

// A minimal Playwright-JSON spec for a single behavioral module row.
function moduleSpec(id: string, status: 'expected' | 'unexpected' | 'flaky' | 'skipped') {
  return {
    title: `${id}: ${BEHAVIORAL_TITLE_MARK} the module's observable output (vs unpatched control)`,
    ok: status !== 'unexpected',
    tests: [{ status, results: [{ status: status === 'unexpected' ? 'failed' : 'passed' }] }],
  };
}

// Wrap module specs in the same describe nesting the real report produces, so we
// exercise collectSpecs' recursion.
function report(specs: unknown[], extraTopLevelSpecs: unknown[] = []) {
  return {
    suites: [
      {
        title: 'per-module-per-port-behavioral.spec.ts',
        specs: extraTopLevelSpecs,
        suites: [
          {
            title: "per-module per-port: BEHAVIORAL input coverage (output changes on driven input vs unpatched control)",
            specs,
          },
        ],
      },
    ],
  };
}

describe('parseBehavioralReport', () => {
  it('extracts passed + failed module sets from a fixture report', () => {
    const r = report([
      moduleSpec('adsr', 'expected'),
      moduleSpec('sequencer', 'unexpected'),
      moduleSpec('moog911', 'unexpected'),
      moduleSpec('vca', 'expected'),
    ]);
    const parsed = parseBehavioralReport(r);
    expect(parsed.passed).toBe(false);
    expect(parsed.failedModules).toEqual(['moog911', 'sequencer']); // sorted
    expect(parsed.passedModules).toEqual(['adsr', 'vca']);
    expect(parsed.total).toBe(4);
  });

  it('reports passed:true when no module row failed', () => {
    const parsed = parseBehavioralReport(report([moduleSpec('adsr', 'expected'), moduleSpec('vca', 'flaky')]));
    expect(parsed.passed).toBe(true);
    expect(parsed.failedModules).toEqual([]);
    // flaky (recovered on retry) counts as PASSED, not failed.
    expect(parsed.passedModules).toEqual(['adsr', 'vca']);
  });

  it('excludes skipped (test.fixme) rows from both sets', () => {
    const r = report([
      moduleSpec('adsr', 'expected'),
      moduleSpec('doom', 'skipped'),
    ]);
    const parsed = parseBehavioralReport(r);
    expect(parsed.passedModules).toEqual(['adsr']);
    expect(parsed.failedModules).toEqual([]);
    expect(parsed.skippedModules).toEqual(['doom']);
    expect(parsed.total).toBe(1); // skipped excluded from total
  });

  it('ignores non-behavioral rows (e.g. the RATCHET housekeeping test)', () => {
    const ratchet = {
      title: 'RATCHET: behavioral exemption lists only shrink',
      ok: false,
      tests: [{ status: 'unexpected', results: [{ status: 'failed' }] }],
    };
    // RATCHET failing must NOT show up as a failed MODULE.
    const parsed = parseBehavioralReport(report([moduleSpec('adsr', 'expected')], [ratchet]));
    expect(parsed.failedModules).toEqual([]);
    expect(parsed.passedModules).toEqual(['adsr']);
  });

  it('is defensive against an empty / malformed report', () => {
    expect(parseBehavioralReport({}).passed).toBe(true);
    expect(parseBehavioralReport({}).failedModules).toEqual([]);
    expect(parseBehavioralReport(undefined as never).failedModules).toEqual([]);
  });
});

describe('moduleIdFromTitle / specOutcome', () => {
  it('pulls the module id before the first colon', () => {
    expect(moduleIdFromTitle('adsr: each declared input perturbs …')).toBe('adsr');
    expect(moduleIdFromTitle('no-colon-here')).toBeNull();
  });
  it('classifies outcomes, treating flaky as passed and unexpected as failed', () => {
    expect(specOutcome({ tests: [{ status: 'expected' }] })).toBe('passed');
    expect(specOutcome({ tests: [{ status: 'flaky' }] })).toBe('passed');
    expect(specOutcome({ tests: [{ status: 'unexpected' }] })).toBe('failed');
    expect(specOutcome({ tests: [{ status: 'skipped' }] })).toBe('skipped');
    // falls back to spec.ok when statuses are absent
    expect(specOutcome({ ok: false, tests: [] })).toBe('failed');
  });
});

describe('parseCollabAttestation → vacuous flag', () => {
  it('flags a DB-absent attestation as vacuous', () => {
    const c = parseCollabAttestation({ databaseConfirmed: false, run: { passed: 52, failed: 0 } });
    expect(c.dbPresent).toBe(false);
    expect(c.vacuous).toBe(true);
    expect(c.passed).toBe(false);
    expect(c.reason).toMatch(/VACUOUS/);
  });

  it('treats a missing attestation as present:false + vacuous', () => {
    const c = parseCollabAttestation(null);
    expect(c.present).toBe(false);
    expect(c.vacuous).toBe(true);
    expect(c.dbPresent).toBe(false);
  });

  it('passes a real DB attestation with a clean run', () => {
    const c = parseCollabAttestation({ databaseConfirmed: true, run: { passed: 52, failed: 0, skipped: 1 } });
    expect(c.dbPresent).toBe(true);
    expect(c.vacuous).toBe(false);
    expect(c.passed).toBe(true);
  });

  it('does NOT pass a DB-present attestation that recorded failures', () => {
    const c = parseCollabAttestation({ databaseConfirmed: true, run: { passed: 40, failed: 3 } });
    expect(c.dbPresent).toBe(true);
    expect(c.vacuous).toBe(false);
    expect(c.passed).toBe(false);
    expect(c.reason).toMatch(/failed/);
  });
});

describe('diffNewlyFailing (diff vs last-green)', () => {
  const baseline = { passing: ['adsr', 'vca', 'moog911'], failing: ['sequencer'] };

  it('flags a previously-green module that now fails', () => {
    expect(diffNewlyFailing(['moog911'], baseline)).toEqual(['moog911']);
  });

  it('does NOT flag a chronic tolerated red (already failing at baseline)', () => {
    expect(diffNewlyFailing(['sequencer'], baseline)).toEqual([]);
  });

  it('does NOT flag a brand-new / never-observed module', () => {
    expect(diffNewlyFailing(['newmodule'], baseline)).toEqual([]);
  });

  it('returns only the regressions when failures are mixed', () => {
    expect(diffNewlyFailing(['moog911', 'sequencer', 'newmodule', 'adsr'], baseline)).toEqual(['adsr', 'moog911']);
  });

  it('never fires against an empty / missing baseline (bootstrap run)', () => {
    expect(diffNewlyFailing(['moog911', 'adsr'], null)).toEqual([]);
    expect(diffNewlyFailing(['moog911'], { passing: [], failing: [] })).toEqual([]);
  });
});

describe('reproducedFailures (infra-blip rejection)', () => {
  it('keeps only candidates that failed AGAIN in the re-run', () => {
    expect(reproducedFailures(['moog911', 'adsr'], ['moog911'])).toEqual(['moog911']);
  });
  it('drops a candidate that passed on re-run (was an infra blip)', () => {
    expect(reproducedFailures(['moog911'], [])).toEqual([]);
  });
});

describe('buildGrep', () => {
  it('builds an anchored alternation over module ids', () => {
    expect(buildGrep(['adsr', 'vca'])).toBe(`(adsr|vca): ${BEHAVIORAL_TITLE_MARK}`);
  });
  it('returns empty string for no modules', () => {
    expect(buildGrep([])).toBe('');
  });
  it('escapes regex metacharacters in ids', () => {
    expect(buildGrep(['moog.911'])).toBe(`(moog\\.911): ${BEHAVIORAL_TITLE_MARK}`);
  });
});
