// packages/web/src/lib/multiplayer/collab-attest-basis.test.ts
//
// Guard for the @collab local-relay attestation "semaphore"
// (.myrobots/plans/collab-attest-2026-06-15.md). The collab analogue of
// packages/web/src/lib/video/webgl-attest-coverage.test.ts. Runs in the REQUIRED
// `unit` job, so it can't silently rot.
//
// It asserts two things the attest scheme depends on:
//   (1) the content-hash BASIS resolves to a sane, non-trivial set (the relay,
//       the client sync layer, the @collab specs, the DB schema, toolchain pins
//       are all present) — so a hand-broken resolver doesn't make the hash
//       vacuous;
//   (2) the relay-vacuity skip CLASSIFIER actually flags the real
//       `test.skip(true,'…relay flake…')` reasons that appear in the @collab
//       specs as VACUITY (and leaves the benign asset/resource skips alone) —
//       this is THE property that makes a local attest meaningful, so it is
//       worth pinning against the live spec text.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

import {
  REPO_ROOT,
  resolveCollabBasis,
  resolveCollabSpecs,
  computeCollabHash,
  collabDepDigest,
  isRelayVacuitySkip,
  classifySkip,
  BENIGN_SKIPS,
  COLLAB_GREP,
} from '../../../../../scripts/collab-attest-lib';

describe('collab-attest basis', () => {
  const basis = resolveCollabBasis();

  it('resolves to a non-trivial, sorted, de-duplicated set', () => {
    expect(basis.length).toBeGreaterThan(30);
    expect([...basis].sort()).toEqual(basis); // already sorted
    expect(new Set(basis).size).toBe(basis.length); // no dupes
  });

  it('includes the relay, the client sync layer, the DB schema, and toolchain pins', () => {
    expect(basis).toContain('packages/server/src/index.ts');
    expect(basis).toContain('packages/web/src/lib/multiplayer/presence.ts');
    expect(basis).toContain('packages/web/src/lib/multiplayer/provider.ts');
    expect(basis).toContain('packages/web/src/lib/graph/store.ts');
    expect(basis).toContain('db/schema/001_init.sql');
    expect(basis).toContain('packages/server/package.json');
    expect(basis).toContain('e2e/playwright.config.ts');
  });

  it('EXCLUDES node-env unit tests from the hashed source dirs (over-invalidation guard)', () => {
    // A .test.ts under the whole-dir source roots would force a ~6.5-8 min
    // @collab re-attest on every unit-test edit — exactly the webgl V6 trap.
    for (const f of basis) {
      if (f.startsWith('packages/server/src/') || f.startsWith('packages/web/src/lib/multiplayer/')) {
        expect(f.endsWith('.test.ts')).toBe(false);
      }
    }
  });

  it('includes EVERY @collab/@capacity-tagged spec (resolved by the lane selector)', () => {
    const specs = resolveCollabSpecs();
    expect(specs.length).toBeGreaterThan(10); // there are ~28 today
    for (const s of specs) expect(basis).toContain(s);
    // The selector the basis resolves by is the SAME one the `collab` lane greps.
    expect(COLLAB_GREP).toBe('@collab|@capacity');
  });

  it('produces a stable 64-hex content hash', () => {
    const h = computeCollabHash();
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(computeCollabHash()).toBe(h); // deterministic across calls
  });

  it('NARROWS package.json pins to collab-relevant deps (no false drift — #939/#160)', () => {
    // #939 added a VIDEO dep (butterchurn) to packages/web/package.json; because
    // the file was hashed WHOLESALE the collab content-hash drifted → collab-attest
    // went red on a change that can't affect sync. The pins are now hashed by
    // collabDepDigest (only COLLAB_DEP_ALLOW deps), so a non-collab dep bump
    // can't drift the hash.
    const web = collabDepDigest('packages/web/package.json');
    const srv = collabDepDigest('packages/server/package.json');
    // Collab-relevant deps ARE captured (so the pin still forces a re-attest on
    // a real sync-layer dep bump) …
    expect(web, 'web pin keeps yjs').toMatch(/(^|\n)yjs@/);
    expect(srv, 'server pin keeps pg').toMatch(/(^|\n)pg@/);
    expect(srv, 'server pin keeps yjs').toMatch(/(^|\n)yjs@/);
    // … and collab-IRRELEVANT deps are NOT (so bumping them can't drift it):
    expect(web, 'butterchurn (the #939 culprit) excluded').not.toMatch(/butterchurn/);
    expect(web, 'svelte (UI, not sync) excluded').not.toMatch(/(^|\n)svelte@/);
    // The digest is a clean sorted name@range list (no JSON punctuation leaked).
    expect(web).not.toMatch(/[{}"]/);
  });
});

describe('relay-vacuity skip classifier', () => {
  it('flags relay/sync-vacuity reasons as vacuity (poison the attestation)', () => {
    const vacuous = [
      'cross-context mpLive sync did not reach B (relay flake)',
      'cross-context node sync did not deliver all 4 DOOM cards (known CI @collab relay flake — task #97)',
      'cross-context roster sync did not seat the guest at slot 1 (relay flake)',
      'host A never took slot 0 (relay flake — #97)',
      'peer 2 never saw the live MP signal (relay flake — #97)',
      'cross-context node sync flake',
      'cross-context roster/relaunch sync flake under CI shard load',
    ];
    for (const r of vacuous) expect(isRelayVacuitySkip(r)).toBe(true);
  });

  // ⚠ `isRelayVacuitySkip` is a DIAGNOSIS, not the refusal predicate. These
  // reasons are not relay stalls — and this test used to be read as proof they
  // were therefore harmless, which is how four DOOM runtime-load skips and a
  // `test.fixme` quarantine got minted into attestations as "benign asset
  // skips". `classifySkip` (below) is what decides refusal, and it denies by
  // default: every reason here is UNCLASSIFIED and now REFUSES.
  it('does NOT DIAGNOSE non-relay reasons as relay vacuity (but they are not benign either)', () => {
    const notRelayStalls = [
      'DOOM WASM not built',
      'DOOM1.WAD missing — see static/doom/DOWNLOAD_INSTRUCTIONS.md',
      'DOOM WASM / WAD missing — run build-doom-wasm.sh + fetch DOOM1.WAD',
      'DOOM runtime failed to load on A within 25s',
      'resource-constrained: a DOOM context could not load 4-up in time',
      'no ROM fixture present — run the setup script',
      '', // no reason
    ];
    for (const r of notRelayStalls) expect(isRelayVacuitySkip(r)).toBe(false);
    // The whole point of the inversion: not-a-relay-stall must NOT mean allowed.
    for (const r of notRelayStalls) {
      expect(
        classifySkip('doom-launch.spec.ts', r).verdict,
        `"${r}" must not be waved through — no BENIGN_SKIPS rule claims it`,
      ).toBe('unclassified');
    }
  });

  describe('deny-by-default (the polarity that was inverted)', () => {
    it('REFUSES the exact skip that could hide a dead DOOM 2-user gate', () => {
      // Measured 2026-08-13: four @collab DOOM specs carry this reason verbatim.
      // Under the old allow-by-default shape all four could skip their entire
      // bodies and the runner still minted, reporting them as "asset skips".
      for (const spec of [
        'doom-launch.spec.ts',
        'doom-identity-crossview.spec.ts',
        'doom-late-join.spec.ts',
        'doom-multiplayer.spec.ts',
      ]) {
        expect(classifySkip(spec, 'DOOM runtime failed to load on A within 25s').verdict).toBe(
          'unclassified',
        );
      }
    });

    it('a NAMED rule claims its own skip, and ONLY in its own spec', () => {
      // Positive control: the rule fires where it is scoped.
      expect(classifySkip('in-card-title.spec.ts', '').verdict).toBe('benign');
      // Negative control, same predicate: the exemption is (spec, reason), never
      // a bare filename — so an empty-reason skip appearing anywhere ELSE still
      // refuses, and a DIFFERENT skip inside the already-listed file does too.
      expect(classifySkip('doom-launch.spec.ts', '').verdict).toBe('unclassified');
      expect(classifySkip('in-card-title.spec.ts', 'some new skip').verdict).toBe('unclassified');
    });

    it('a relay stall is still DIAGNOSED as vacuity (so the message says which fix)', () => {
      expect(classifySkip('doom-launch.spec.ts', 'roster sync did not seat B').verdict).toBe(
        'vacuity',
      );
    });

    it('every BENIGN_SKIPS entry is ANCHORED to a live @collab spec + argues its case', () => {
      // A ledger entry naming something that no longer exists is RED: if the
      // spec is deleted, renamed, or drops out of the @collab lane, the entry
      // can never fire again and must not sit here looking load-bearing.
      const specs = resolveCollabSpecs(); // repo-relative, e.g. e2e/tests/x.spec.ts
      for (const rule of BENIGN_SKIPS) {
        expect(
          specs.some((s) => s.endsWith(`/${rule.spec}`)),
          `BENIGN_SKIPS names ${rule.spec}, which is not a live @collab spec — delete the entry`,
        ).toBe(true);
        expect(
          existsSync(join(REPO_ROOT, 'e2e/tests', rule.spec)),
          `BENIGN_SKIPS names ${rule.spec}, which is not on disk`,
        ).toBe(true);
        // Prose-quality floor on the argument, not a count of the entries.
        expect(rule.why.length, `${rule.spec}: 'why' must actually argue the case`).toBeGreaterThan(
          80,
        );
      }
    });
  });

  it('has ZERO relay-flake vacuity skips left in the @collab specs (de-flake invariant)', () => {
    // PR #844 converted every `test.skip(true,'…relay flake…')` vacuity skip in
    // the @collab specs into a real `expect.poll` assertion (killing the
    // fake-green DOOM gate). This guard LOCKS THAT IN: if anyone re-adds a
    // relay/sync-flake skip, this fails — forcing it back to a real assert
    // instead of a green-while-vacuous skip. (The classifier itself is tested
    // above with a static positive/benign list, so it stays honest even with no
    // live samples to scrape. Benign asset/runtime capability skips are NOT
    // vacuity and remain allowed.)
    const specs = resolveCollabSpecs();
    const offenders: string[] = [];
    const re = /test\.skip\(\s*true\s*,\s*[`'"]([^`'"]*)[`'"]/g;
    for (const rel of specs) {
      const src = readFileSync(join(REPO_ROOT, rel), 'utf8');
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        if (isRelayVacuitySkip(m[1])) offenders.push(`${rel}: "${m[1]}"`);
      }
    }
    expect(
      offenders,
      `relay-flake vacuity skips must be 0 — convert each to a real assert:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
