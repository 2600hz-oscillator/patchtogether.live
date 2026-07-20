// packages/web/src/lib/audio/modules/grand-attest-basis.test.ts
//
// Fail-CLOSED guard for the GRAND-INTEGRATION local attestation "semaphore"
// (.myrobots/plans/grand-integration-e2e-art-2026-07-19.md). The grand analogue
// of webgl-attest-coverage.test.ts + collab-attest-basis.test.ts. Runs in the
// REQUIRED `unit` job, so the basis + resolver can't silently rot.
//
// It asserts the properties the attest scheme depends on:
//   (1) the content-hash BASIS resolves to a sane, sorted, de-duplicated set
//       (the four instrument cores, the pure clip step math, the shared fixture,
//       the offline ART + driver, and the toolchain pins are all present) — so a
//       hand-broken resolver can't make the hash vacuous;
//   (2) the basis EXCLUDES the Playwright DRIVER spec (e2e/tests/**) and the
//       runner (scripts/**) — the platform rule "editing a test/runner must not
//       change an attest hash" (the ART scenario `.test.ts` is DELIBERATELY
//       in-basis because it DEFINES the render — that is not a driver spec);
//   (3) the package.json pins are NARROWED (no unrelated-dep drift, #939 lesson);
//   (4) the hash is a stable 64-hex; and
//   (5) the heavy browser spec still carries the `@grand-attest` tag the runner
//       greps (a spec that lost the tag would run ZERO tests → a vacuous attest).

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

import {
  REPO_ROOT,
  resolveGrandBasis,
  computeGrandHash,
  grandDepDigest,
  GRAND_GREP,
} from '../../../../../../scripts/grand-attest-lib';

/** The heavy browser spec — NOT in the hash basis, but the runner greps its tag,
 *  so the guard asserts the tag is present (fail-closed against a lost tag). */
const GRAND_SPEC_REL = 'e2e/tests/grand-integration.attest.spec.ts';

describe('grand-attest basis', () => {
  const basis = resolveGrandBasis();

  it('resolves to a non-trivial, sorted, de-duplicated set', () => {
    expect(basis.length).toBeGreaterThanOrEqual(15);
    expect([...basis].sort()).toEqual(basis); // already sorted
    expect(new Set(basis).size).toBe(basis.length); // no dupes
  });

  it('includes the four instrument cores, the clip step math, the fixture, the ART + driver, and toolchain pins', () => {
    // the four instrument DSP cores
    expect(basis).toContain('packages/dsp/src/lib/kickdrum-dsp.ts');
    expect(basis).toContain('packages/dsp/src/lib/snaredrum-dsp.ts');
    expect(basis).toContain('packages/dsp/src/lib/tidy-vco-dsp.ts');
    expect(basis).toContain('packages/dsp/src/lib/sixstrum-dsp.ts');
    // the pure clip step math (the offline↔browser fidelity anchor)
    expect(basis).toContain('packages/web/src/lib/audio/modules/clip-types.ts');
    expect(basis).toContain('packages/web/src/lib/audio/modules/clip-clock.ts');
    // the SHARED clip fixture + the offline ART scenario + the pure driver
    expect(basis).toContain('e2e/fixtures/grand-integration/clips.ts');
    expect(basis).toContain('art/scenarios/grand-integration/combined-master.test.ts');
    expect(basis).toContain('art/setup/clip-driver.ts');
    // toolchain pins
    expect(basis).toContain('e2e/package.json');
    expect(basis).toContain('.flox/env/manifest.toml');
  });

  it('EXCLUDES the Playwright driver spec (e2e/tests/**) and the runner (scripts/**)', () => {
    // Editing the DRIVER spec or the runner must be hash-free (platform rule).
    for (const f of basis) {
      expect(f.startsWith('e2e/tests/'), `${f} must not be in-basis (driver spec)`).toBe(false);
      expect(f.startsWith('scripts/'), `${f} must not be in-basis (runner)`).toBe(false);
    }
  });

  it('every basis file exists on disk', () => {
    for (const f of basis) {
      expect(existsSync(join(REPO_ROOT, f)), `${f} missing`).toBe(true);
    }
  });

  it('produces a stable 64-hex content hash', () => {
    const h = computeGrandHash();
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(computeGrandHash()).toBe(h); // deterministic across calls
  });

  it('NARROWS package.json pins to the grand-relevant dep (@playwright/test — no false drift, #939 lesson)', () => {
    const e2ePin = grandDepDigest('e2e/package.json');
    // The Playwright harness (browser + H.264 engine) IS captured …
    expect(e2ePin, 'e2e pin keeps @playwright/test').toMatch(/(^|\n)@playwright\/test@/);
    // … and the digest is a clean sorted name@range list (no JSON punctuation).
    expect(e2ePin).not.toMatch(/[{}"]/);
  });

  it('the heavy browser spec still carries the @grand-attest tag the runner greps', () => {
    const p = join(REPO_ROOT, GRAND_SPEC_REL);
    expect(existsSync(p), `${GRAND_SPEC_REL} missing`).toBe(true);
    const src = readFileSync(p, 'utf8');
    expect(src.includes(GRAND_GREP), `${GRAND_SPEC_REL} must contain the ${GRAND_GREP} tag`).toBe(true);
    expect(GRAND_GREP).toBe('@grand-attest');
  });
});
