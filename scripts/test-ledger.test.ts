// scripts/test-ledger.test.ts
//
// FRESHNESS GATE for the generated 3-bucket test ledger
// (docs/testing/test-ledger.generated.md). Pure-unit, zero-flake, in the `unit`
// lane (runs via `task test` → `task test:scripts`). Mirrors the living-docs
// contract-lock.txt gate: regenerate the ledger from the committed source tree
// and string-compare to the committed artifact — any new skip / exemption /
// informational-lane change flips it red until a human regenerates + notices
// (`flox activate -- task test:ledger:accept`). CI NEVER self-heals: the write
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
    items: { name: string; line: number; reason: string }[];
    gatingJobs: string[];
    requiredContexts: { name: string; line: number }[];
  };
};

describe('test-ledger (generated 3-bucket punch-list) freshness gate', () => {
  it('the committed ledger matches a fresh regeneration from source', () => {
    const current = generateLedger();

    if (process.env.LEDGER_UPDATE) {
      // `task test:ledger:accept` — the deliberate human re-pin.
      writeFileSync(LEDGER_PATH, current, 'utf8');
      return;
    }

    let committed = '';
    try {
      committed = readFileSync(LEDGER_PATH, 'utf8');
    } catch {
      committed = '';
    }

    expect(
      committed,
      'docs/testing/test-ledger.generated.md is STALE — a skip / exemption / CI ' +
        'lane changed. Regenerate with `flox activate -- task test:ledger:accept` and ' +
        'review the git diff (a diff = the punch-list moved: accept it, or recognize a bug).',
    ).toBe(current);
  });

  it('is deterministic (two regenerations are byte-identical)', () => {
    expect(generateLedger()).toBe(generateLedger());
  });
});

// Non-vacuous: the CI-gating classification is the factual Part-1 answer. Lock it
// against ci.yml so a parsing regression (or a real gating change) is caught.
describe('CI gating classification (derived from ci.yml)', () => {
  const b3 = bucket3();
  const informational = new Set(b3.items.map((i) => i.name));
  const gating = new Set(b3.gatingJobs);

  it('the required status-check contexts are the umbrella + vrt-strict', () => {
    const names = b3.requiredContexts.map((c) => c.name);
    expect(names).toContain('typecheck + unit + ART + E2E');
    expect(names.some((n) => n.startsWith('vrt-strict'))).toBe(true);
  });

  it('behavioral-smoke GATES; the full behavioral-coverage sweep does NOT', () => {
    expect(gating.has('behavioral-smoke')).toBe(true);
    expect(informational.has('behavioral-coverage')).toBe(true);
    expect(gating.has('behavioral-coverage')).toBe(false);
  });

  it('e2e + webgl-attest gate (a var with a digit must not be dropped)', () => {
    // Regression guard: `E2E` was silently dropped when the var regex excluded
    // digits — e2e would then read as informational. It MUST be gating.
    expect(gating.has('e2e')).toBe(true);
    expect(informational.has('e2e')).toBe(false);
    expect(gating.has('webgl-attest')).toBe(true);
  });

  it('collab-attest + grand-attest are waited-on but NON-gating; vrt is informational', () => {
    // In the umbrella needs+env, but deliberately absent from the failing `if`.
    expect(informational.has('collab-attest')).toBe(true);
    expect(informational.has('grand-attest')).toBe(true);
    expect(gating.has('collab-attest')).toBe(false);
    expect(gating.has('grand-attest')).toBe(false);
    // vrt (full canvas) is continue-on-error; only vrt-strict gates.
    expect(informational.has('vrt')).toBe(true);
    expect(gating.has('vrt')).toBe(false);
  });
});
