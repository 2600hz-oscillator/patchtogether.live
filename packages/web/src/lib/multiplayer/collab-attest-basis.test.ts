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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

import {
  REPO_ROOT,
  resolveCollabBasis,
  resolveCollabSpecs,
  computeCollabHash,
  isRelayVacuitySkip,
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

  it('does NOT flag benign asset/resource skips as vacuity', () => {
    const benign = [
      'DOOM WASM not built',
      'DOOM1.WAD missing — see static/doom/DOWNLOAD_INSTRUCTIONS.md',
      'DOOM WASM / WAD missing — run build-doom-wasm.sh + fetch DOOM1.WAD',
      'DOOM runtime failed to load on A within 25s',
      'resource-constrained: a DOOM context could not load 4-up in time',
      'no /roms/snes9x/game.sfc — run',
      '', // no reason
    ];
    for (const r of benign) expect(isRelayVacuitySkip(r)).toBe(false);
  });

  it('matches the LIVE relay-flake skip reasons in the @collab specs', () => {
    // Scrape every `test.skip(true, '…relay flake…')` reason out of the actual
    // spec files and assert the classifier flags it. If a NEW relay-flake skip
    // reason is added with wording the classifier misses, this fails — forcing
    // the marker list (RELAY_VACUITY_MARKERS) to keep up so a vacuous local run
    // can never sneak an attestation through.
    const specs = resolveCollabSpecs();
    const reasons = new Set<string>();
    const re = /test\.skip\(\s*true\s*,\s*[`'"]([^`'"]*)[`'"]/g;
    for (const rel of specs) {
      const src = readFileSync(join(REPO_ROOT, rel), 'utf8');
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const reason = m[1];
        // Only the relay/sync-flake ones (those containing 'relay' or 'sync …
        // did not' / 'sync flake') must be classified as vacuity. Asset skips
        // are intentionally NOT vacuity.
        if (/relay|sync did not|sync flake|never (saw|took)/i.test(reason)) reasons.add(reason);
      }
    }
    expect(reasons.size).toBeGreaterThan(0);
    for (const r of reasons) {
      expect(isRelayVacuitySkip(r), `classifier missed relay-flake skip reason: "${r}"`).toBe(true);
    }
  });
});
