// packages/web/src/lib/audio/modules/vrt-platform-gaps.test.ts
//
// THE TEST THAT WOULD HAVE CAUGHT IT.
//
// For months the linux-deficit ratchet in vrt-meta.test.ts read ONE of the
// FOUR ways a VRT scene is declared dark on a platform, printed the size of
// that one list, and called it "the deficit". Measured 2026-08-01 on `main` @
// 77cd1bbc: 151 real gaps, 89 seen, 62 invisible — and the number it printed
// was 119, matching neither, because 30 of its entries named scenes that were
// not gaps at all.
//
// Nothing failed. Every assertion in the file was true about the list it read.
// The gate was blind by CONSTRUCTION, not by bug: it could not see mechanisms
// B, C and D, so no amount of running it could ever surface them.
//
// So this file does not test the deficit — vrt-meta.test.ts ratchets that.
// It tests THE INSTRUMENT:
//
//   1. TOTALITY   the ratchet's number equals the union across all four
//                 mechanisms, and every gap on disk is attributed to exactly
//                 one of them. Adding a fifth mechanism without teaching the
//                 enumerator about it lands its gaps in UNDECLARED → red.
//
//   2. NEGATIVE CONTROL (the part that matters). For EACH mechanism in turn,
//      drop it and require the report to notice. If dropping a mechanism
//      leaves the answer unchanged, the enumerator was never reading it and
//      the totality assertion above is vacuous — which is precisely the state
//      the original ratchet was in. Perturb the thing the metric claims to
//      measure and confirm the number moves (CLAUDE.md: VALIDATE THE
//      INSTRUMENT).
//
// Pure fs + string work. No browser, no renderer, runs in the ~1 s unit lane.
// ⚠ It can prove a linux baseline is MISSING; it cannot prove a committed one
// still MATCHES the linux render. Only linux CI can answer that.

import { describe, expect, it } from 'vitest';
import {
  VRT_GAP_MECHANISMS,
  assertParsersSeeSomething,
  collectLinuxGapReport,
  darwinOnlySceneIds,
  hardcodedLinuxDarkSpecs,
  listBaselineInventory,
  sharedPairScenes,
  specLocalPairScenes,
  type VrtGapMechanism,
} from '../../../../../../e2e/vrt/vrt-platform-gaps';

describe('vrt platform-gap enumerator — TOTALITY across all four mechanisms', () => {
  it('the ground truth is read off DISK, not off the declarations', () => {
    // The deficit must be anchored to committed PNGs. A declaration-derived
    // count is what drifted: it could name scenes that do not exist (15 did)
    // and miss scenes that do. Recompute the darwin-only set independently
    // here and require the report to agree exactly.
    const inventory = listBaselineInventory();
    expect(inventory.length, 'no __screenshots__ dirs found — the scan is broken').toBeGreaterThan(
      0,
    );
    let onDisk = 0;
    for (const { darwin, linux } of inventory) {
      const l = new Set(linux);
      onDisk += darwin.filter((s) => !l.has(s)).length;
    }
    const report = collectLinuxGapReport();
    expect(report.total, 'report.total must equal the on-disk darwin-only count').toBe(onDisk);
    expect(report.gaps.length).toBe(onDisk);
  });

  it('every gap is attributed to exactly one mechanism — none UNDECLARED', () => {
    const report = collectLinuxGapReport();
    const summed = VRT_GAP_MECHANISMS.reduce((n, m) => n + report.byMechanism[m], 0);
    expect(
      summed + report.undeclared.length,
      'the per-mechanism counts must partition the gap set — no double counting, no leaks',
    ).toBe(report.total);
    expect(
      report.undeclared.map((g) => `${g.spec}/${g.scene}`),
      report.format('UNDECLARED gap(s): a FIFTH mechanism exists and the enumerator cannot see it.'),
    ).toEqual([]);
  });

  it('all four mechanisms are non-empty (each one is load-bearing today)', () => {
    // If a mechanism ever legitimately empties out, its negative control below
    // becomes vacuous — so make that a deliberate, visible edit rather than a
    // silently weakened test.
    const report = collectLinuxGapReport();
    for (const m of VRT_GAP_MECHANISMS) {
      expect(
        report.byMechanism[m],
        `${m} declares zero gaps. If that is genuinely true now, delete it from ` +
          'VRT_GAP_MECHANISMS + its negative control — do not leave a dead branch that ' +
          'makes the control pass for free.',
      ).toBeGreaterThan(0);
    }
  });

  it('the four mechanisms are DISTINCT sources, not the same list read twice', () => {
    // A cheap way to fake totality would be four readers of one list. Assert
    // they come from four different places and disagree about their contents.
    const shared = sharedPairScenes();
    const local = specLocalPairScenes();
    const dark = hardcodedLinuxDarkSpecs();
    const darwinOnly = darwinOnlySceneIds();
    expect(shared.size, 'shared EXEMPT_BASELINE_PAIRS linux entries').toBeGreaterThan(0);
    expect(local.size, 'spec files with a PRIVATE EXEMPT_BASELINE_PAIRS').toBeGreaterThan(0);
    expect(dark.size, "spec files with a blanket `VRT_PLATFORM === 'linux'` skip").toBeGreaterThan(
      0,
    );
    expect(darwinOnly.size, 'composite scenes flagged darwinOnly').toBeGreaterThan(0);
    // No spec-local entry may also be in the shared set — that would mean the
    // two mechanisms overlap and the partition assertion above is luck.
    for (const [spec, scenes] of local) {
      for (const s of scenes) {
        expect(shared.has(s), `${spec} declares ${s} locally AND it is in the shared set`).toBe(
          false,
        );
      }
    }
  });

  it('the source-scanned parsers see something (they fail OPEN otherwise)', () => {
    // Mechanisms B and C are regex reads of spec sources — a drifted pattern
    // returns a clean empty set and the deficit silently under-reports. This
    // is the same "metric blind to the dimension under test" failure the
    // original ratchet had, one level down.
    const seen = assertParsersSeeSomething();
    expect(seen.local).toBeGreaterThan(0);
    expect(seen.dark).toBeGreaterThan(0);
  });
});

describe('vrt platform-gap enumerator — NEGATIVE CONTROL (drop a mechanism, it must notice)', () => {
  const full = collectLinuxGapReport();

  for (const mechanism of VRT_GAP_MECHANISMS) {
    it(`dropping '${mechanism}' resurfaces its gaps as UNDECLARED`, () => {
      const crippled = collectLinuxGapReport({ omit: mechanism as VrtGapMechanism });

      // The gap SET is on disk and cannot change — only the attribution can.
      // If total moved, the enumerator is deriving ground truth from the
      // declarations again, which is the original bug.
      expect(
        crippled.total,
        'omitting a mechanism must not change the on-disk gap count — only who explains it',
      ).toBe(full.total);

      // The dropped mechanism must lose exactly the gaps it used to own…
      expect(crippled.byMechanism[mechanism]).toBe(0);
      // …and they must reappear as UNDECLARED, in the same number.
      expect(
        crippled.undeclared.length,
        `dropping '${mechanism}' changed NOTHING — the enumerator was never actually reading ` +
          'it, so the totality assertions are vacuous. This is exactly the state the old ' +
          'ratchet was in for all three mechanisms it did not know about.',
      ).toBe(full.byMechanism[mechanism]);

      // Same scenes, not merely the same count.
      const lost = new Set(
        full.gaps.filter((g) => g.mechanism === mechanism).map((g) => `${g.spec}/${g.scene}`),
      );
      expect(new Set(crippled.undeclared.map((g) => `${g.spec}/${g.scene}`))).toEqual(lost);
    });
  }

  it('the UNDECLARED gate would actually FAIL under a dropped mechanism', () => {
    // Proves the gate is wired to the signal, not just that the signal exists.
    // Run vrt-meta's own predicate against each crippled report and require a
    // non-empty result every time.
    for (const mechanism of VRT_GAP_MECHANISMS) {
      const crippled = collectLinuxGapReport({ omit: mechanism as VrtGapMechanism });
      expect(
        crippled.undeclared.length,
        `the UNDECLARED gate stays green with '${mechanism}' dropped — it is decoration`,
      ).toBeGreaterThan(0);
      // And the failure message must NAME the mechanism that went missing, so
      // a human reading the CI log knows which one to fix. A bare number is
      // what let this hide for months.
      expect(crippled.format()).toContain(mechanism);
      expect(crippled.format()).toContain('OMITTED by negative control');
      expect(crippled.format()).toContain('UNDECLARED');
    }
  });

  it('the failure message names every mechanism and its contribution', () => {
    const msg = full.format('probe');
    for (const m of VRT_GAP_MECHANISMS) expect(msg).toContain(m);
    for (const m of VRT_GAP_MECHANISMS) expect(msg).toContain(String(full.byMechanism[m]));
    expect(msg).toContain('LINUX-DEFICIT BREAKDOWN');
    expect(msg).toContain('vrt-platform-gaps.ts');
  });
});

describe('vrt platform-gap enumerator — DECLARATION HYGIENE', () => {
  it('reports declarations that match no gap instead of silently inflating the count', () => {
    // The old ratchet counted 119 while only 89 were real: 15 pairs whose PNG
    // was already committed (drained 2026-08-01) and 15 naming a scene with no
    // PNG on either platform. Those are LIST rot, not coverage — they must be
    // visible and must never be mistaken for deficit.
    const report = collectLinuxGapReport();

    // Stale LINUX pairs (baseline exists) are now zero and stay zero. The four
    // surviving stale pairs are `darwin/*` flake quarantines, which this report
    // does not classify — vrt-meta's widened stale ratchet caps those at 4.
    const stale = report.dead['shared-pairs'].filter((s) => s.includes('IS committed'));
    expect(
      stale,
      'a shared pair whose linux PNG is committed skips a card we already paid for, AND ' +
        'blocks its own re-capture (--update-snapshots writes nothing for a skipped test)',
    ).toEqual([]);

    // Entries naming nothing on either platform are pure noise. They are not
    // fixed here (the 10 dead `linux/toybox-*` names in particular are shadowed
    // by mechanism C and harmless), but the count is FROZEN so it cannot grow.
    const phantom = report.dead['shared-pairs'].filter((s) => s.includes('dead entry'));
    expect(
      phantom.length,
      'shared EXEMPT_BASELINE_PAIRS entries naming a scene with no baseline on EITHER ' +
        `platform — they inflate the list and explain nothing: ${phantom.join(', ')}`,
    ).toBeLessThanOrEqual(15);
  });

  it('every spec-local and darwinOnly declaration matches a real gap', () => {
    const report = collectLinuxGapReport();
    expect(report.dead['spec-local-pairs'], 'spec-local pair declaring a non-gap').toEqual([]);
    expect(report.dead['scene-darwin-only'], 'darwinOnly scene that is not a gap').toEqual([]);
    expect(
      report.dead['hardcoded-platform-skip'],
      'spec with a blanket linux skip but no darwin-only baselines — the skip is dead code',
    ).toEqual([]);
  });
});
