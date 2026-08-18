// scripts/test-ledger.test.ts
//
// FRESHNESS GATE for the generated 3-bucket test ledger
// (docs/testing/test-ledger.generated.md). Pure-unit, zero-flake, in the `unit`
// lane (runs via `task test` → `task test:scripts`). Mirrors the living-docs
// contract-lock.txt gate: regenerate the ledger from the committed source tree
// and string-compare to the committed artifact — any new skip / exemption /
// informational-lane change flips it red until a human regenerates + notices
// (#1858: the committed artifact and its freshness gate are deleted; what remains
// below is DERIVED from ci.yml and can fail on substance.)
// path is gated on LEDGER_UPDATE.
//
// Also asserts the ledger is NON-vacuous: the CI-gating classification (Bucket 3
// + the gated-through-umbrella set) is derived correctly from ci.yml — this is
// the load-bearing Part-1 answer, and it guards the ci.yml-parsing regexes
// against silent regression (e.g. dropping `e2e` because its var has a digit).

import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
// The generator + its buckets (plain .mjs, resolved at runtime by vitest — same
// pattern as test-reconciliation.test.ts importing the counting engine).
import * as ledger from './test-ledger.mjs';

const { generateLedger, LEDGER_PATH, bucket3 } = ledger as unknown as {
  generateLedger: () => string;
  LEDGER_PATH: string;
  bucket3: () => {
    items: { name: string; reason: string }[];
    gatingJobs: string[];
    requiredContexts: { name: string; job: string }[];
  };
};

describe('CI gating classification (derived from ci.yml)', () => {
  const b3 = bucket3();
  const informational = new Set(b3.items.map((i) => i.name));
  const gating = new Set(b3.gatingJobs);

  it('the required status-check contexts are the umbrella + vrt-strict', () => {
    const names = b3.requiredContexts.map((c) => c.name);
    expect(names).toContain('typecheck + unit + ART + E2E');
    expect(names.some((n) => n.startsWith('vrt-strict'))).toBe(true);
  });

  it('every job the ledger names RESOLVES to a job in ci.yml', () => {
    // ⚠ THIS IS WHAT MAKES A NAME BETTER THAN A LINE NUMBER, and it only works
    // because the reference is now a name. The ledger used to cite `ci.yml:985`;
    // nothing could check that, and every edit above line 985 silently
    // invalidated it — adding a 26-line comment block over the `e2e` job moved
    // every reference below it and reddened the freshness gate with no job
    // added, removed or changed (measured 2026-08-12).
    //
    // A name is checkable against the artifact, so a renamed or deleted job is
    // RED here rather than quietly pointing at whatever now occupies that line.
    const src = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
    const jobKeys = new Set(
      src
        .split('\n')
        .map((l) => /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(l)?.[1])
        .filter((k): k is string => Boolean(k)),
    );
    // Non-vacuity: if the scan found no jobs at all, every membership test
    // below would pass over an empty set the other way round.
    expect(jobKeys.has('e2e'), 'the ci.yml job-key scan is broken — it cannot see `e2e`').toBe(true);

    const referenced = [...b3.items.map((i) => i.name), ...b3.requiredContexts.map((c) => c.job)];
    const dangling = referenced.filter((n) => !jobKeys.has(n));
    expect(dangling, 'the ledger names ci.yml jobs that no longer exist').toEqual([]);
  });

  it('the ledger cites job keys, never ci.yml LINE NUMBERS', () => {
    // The regression guard for the fix itself: a `ci.yml:<digits>` reference
    // anywhere in the artifact means position-anchoring has crept back, and
    // with it a gate that goes red on unrelated comment edits.
    const text = generateLedger();
    const positional = text.match(/ci\.yml:\d+/g) ?? [];
    expect(positional, 'ci.yml:<line> is a reference to a POSITION — anchor to the job key instead').toEqual([]);
  });

  it('behavioral-smoke GATES, and is now the ONLY behavioral lane on CI', () => {
    // The full `behavioral-coverage` sweep (6 shards, continue-on-error,
    // push/label-only) was DELETED 2026-08-17 with the rest of the
    // informational tier. Its absence is asserted by the exact informational
    // set below, not by `informational.has('behavioral-coverage') === false` —
    // that reads green for a DELETED job and for a MISSPELLED one alike.
    expect(gating.has('behavioral-smoke')).toBe(true);
  });

  it('the informational tier is CLOSED — `collab` is the only member', () => {
    // ⚠ THE POINT OF THE 2026-08-17 BURN, in one derived assertion.
    //
    // Nine jobs — vrt, behavioral-coverage ×6, merge-behavioral-reports,
    // behavioral-watchdog, grand-attest, merge-reports, collab-attest — were
    // deleted rather than left reporting a signal nobody had to act on. Two had
    // grown into their caps and were turning main runs `cancelled`, which
    // poisons the green signal AND disqualifies the run from
    // daily-prod-deploy.yml's `find-green`.
    //
    // Asserted as an EXACT SET, derived from ci.yml in both directions, because
    // the failure mode this guards is ADDITION: a new lane landed
    // "informational-first, arm it later" is exactly how all nine got here, and
    // an assertion that only names the dead ones cannot see the tenth.
    //
    // `collab` survives on a CLOCK, not on sentiment: daily-prod-deploy.yml
    // fires at 04:00 UTC and collab-nightly.yml at 09:00 UTC, so the nightly
    // multiplayer backstop runs FIVE HOURS AFTER prod has already shipped.
    // Deleting it lets a multiplayer regression reach production before any
    // multiplayer lane runs. Arm it (needs + env + the failing `if`) or leave
    // it here — but do not add a second name without the same kind of reason.
    expect(
      [...informational].sort(),
      'a job is informational (continue-on-error, waited-on-but-not-gated, or ' +
        'declared off-umbrella) that is not `collab`. The informational tier was ' +
        'CLOSED on 2026-08-17: arm the lane through the umbrella (needs + env + ' +
        'the failing `if`), or do not add it to ci.yml.',
    ).toEqual(['collab']);
  });

  it('e2e + webgl-attest gate (a var with a digit must not be dropped)', () => {
    // Regression guard: `E2E` was silently dropped when the var regex excluded
    // digits — e2e would then read as informational. It MUST be gating.
    expect(gating.has('e2e')).toBe(true);
    expect(informational.has('e2e')).toBe(false);
    expect(gating.has('webgl-attest')).toBe(true);
  });

  it('webgl-attest is the ONE surviving attest, and it GATES', () => {
    // ⚠ THIS TEST USED TO PIN THE DEFECT, TWICE OVER. It first asserted
    // collab-attest and grand-attest were "waited-on but NON-gating" — the one
    // state #1505 calls indefensible (in `needs:`, so every PR waits, while the
    // failing `if` never reads the result). It was then rewritten to assert
    // they were informational and off the umbrella, which encoded the SECOND
    // defect as correct: a lane that cannot fail anything is a lane nobody acts
    // on. Both jobs were deleted 2026-08-17, and `vrt` (continue-on-error) with
    // them.
    //
    // What is left is the assertion that was always the real content: of the
    // three attests, exactly the one that could block a merge survived.
    expect(gating.has('webgl-attest')).toBe(true);
  });
});
