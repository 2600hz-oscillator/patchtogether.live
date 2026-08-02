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
  MIN_DARWIN_BASELINES,
  MIN_LINUX_BASELINES,
  VRT_GAP_MECHANISMS,
  assertBaselineTreeIsReadable,
  assertParsersSeeSomething,
  baselineTotals,
  collectLinuxGapReport,
  collidingSceneStems,
  darkSpecCoverage,
  darwinOnlySceneIds,
  hardcodedLinuxDarkSpecs,
  listBaselineInventory,
  sharedPairScenes,
  specLocalPairScenes,
  type VrtGapMechanism,
} from '../../../../../../e2e/vrt/vrt-platform-gaps';

describe('vrt platform-gap enumerator — TOTALITY across all four mechanisms', () => {
  it('the baseline tree is READABLE — every number below is 0 without it', () => {
    // THE VACUITY TRIPWIRE. Measured with `__screenshots__` moved aside: the
    // deficit ratchet (≤151), the UNDECLARED gate (== []), the contradictory-
    // dark-spec gate (== []) and the stale-pair ratchet (≤4) ALL pass, because
    // 0 ≤ 151 and [] == []. The only thing that kept CI honest was an
    // incidental property of git-LFS — pointer stubs preserve FILENAMES — and
    // nothing asserted it. `assertBaselineTreeIsReadable()` throws instead.
    const totals = assertBaselineTreeIsReadable();
    expect(totals.darwin).toBeGreaterThanOrEqual(MIN_DARWIN_BASELINES);
    expect(totals.linux).toBeGreaterThanOrEqual(MIN_LINUX_BASELINES);
    expect(baselineTotals()).toEqual(totals);
  });

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

  it('NO GAP is claimed by two mechanisms (precedence must never matter)', () => {
    // The pairwise local∩shared check above covered one of six pairs. Every
    // other overlap is equally fatal to the negative controls below: with an
    // overlap, dropping a mechanism makes its gaps fall through to the NEXT
    // mechanism in the precedence order rather than resurfacing as UNDECLARED,
    // and the control fails with a message blaming the parser. Concretely: the
    // 10 misnamed `linux/toybox-*` shared pairs are harmless only because
    // `toybox-truchet` is not a real stem — renaming them to the real stems
    // (`truchet`, …) makes A and C overlap and breaks the C control.
    const report = collectLinuxGapReport();
    expect(
      report.mechanismOverlaps,
      'gap(s) declared by more than one mechanism. Attribution is precedence-ordered, so the ' +
        'per-mechanism counts (and the negative controls) become a function of that order. ' +
        'Remove the redundant declaration — the more specific one wins.',
    ).toEqual([]);
  });

  it('every linux-dark spec is dark for ALL of its tests (C is per-FILE, written per-TEST)', () => {
    // The single biggest hole in the enumerator: `hardcodedLinuxDarkSpecs()`
    // promotes a WHOLE FILE on ONE `test.skip(VRT_PLATFORM === 'linux', …)`,
    // but every one of the 8 specs writes that skip inside individual `test()`
    // bodies. Adding a toybox test with NO skip therefore lands its scene in
    // mechanism C for free, invisible to the UNDECLARED gate — demonstrated by
    // dropping a `zz-brand-new-scene.png` into vrt-toybox.spec.ts/darwin/ and
    // watching it report `mechanism: 'hardcoded-platform-skip', undeclared: 0`.
    const report = collectLinuxGapReport();
    expect(
      report.partiallyDarkSpecs.map(
        (d) => `${d.spec}: ${d.skips} linux skip(s) for ${d.tests} test() site(s)`,
      ),
      'spec(s) that LOOK linux-dark but are not dark for every test. Any scene from an ' +
        'unskipped test there is silently attributed to mechanism C and can never reach the ' +
        'UNDECLARED gate. Either skip every test on linux, or capture the linux baselines.',
    ).toEqual([]);
    // …and the check itself must be looking at something.
    expect(darkSpecCoverage().length, 'no linux-dark specs found at all').toBeGreaterThan(0);
  });

  it('scene stems do not collide across spec dirs (A and D key on the bare stem)', () => {
    // `shared.has(scene)` and `darwinOnly.has(scene)` are spec-agnostic: a pair
    // written for `vrt.spec.ts` would explain a same-named gap in any other
    // dir. Zero collisions today; this keeps the first one from being a silent
    // free pass.
    expect(
      collidingSceneStems(),
      'the same <platform>/<scene> stem exists in two spec dirs. Mechanisms A and D match on ' +
        'the stem alone, so one declaration would silently explain both gaps.',
    ).toEqual([]);
  });

  it('the source-scanned parsers see something (they fail OPEN otherwise)', () => {
    // Mechanisms B, C and D are text reads of spec/scene sources — a drifted
    // pattern returns a clean empty set and the deficit silently under-reports.
    // This is the same "metric blind to the dimension under test" failure the
    // original ratchet had, one level down.
    const seen = assertParsersSeeSomething();
    expect(seen.local).toBeGreaterThan(0);
    expect(seen.dark).toBeGreaterThan(0);
    expect(seen.darwinOnly).toBeGreaterThan(0);
  });

  it('the darwinOnly SOURCE scan returns SCENE ids, not nested node ids', () => {
    // Mechanism D stopped being a value import (it dragged `@playwright/test`
    // into the unit lane through vrt-composite-scenes → _helpers → spawnPatch).
    // The replacement is indentation-anchored text, so pin what it must return:
    // every id it reports has to be a real committed darwin baseline stem. A
    // mis-parse that grabbed a node id ('vco', 'sc') fails here AND in the
    // dead['scene-darwin-only'] hygiene assertion.
    const ids = [...darwinOnlySceneIds()].sort();
    expect(ids.length, 'darwinOnly scenes found').toBeGreaterThan(0);
    const darwinStems = new Set(listBaselineInventory().flatMap((i) => i.darwin));
    for (const id of ids) {
      expect(darwinStems.has(id), `darwinOnly id '${id}' is not a committed darwin baseline`).toBe(
        true,
      );
    }
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
        `dropping '${mechanism}' did not resurface its ${full.byMechanism[mechanism]} gap(s) as ` +
          'UNDECLARED. TWO different causes, check which: (a) the enumerator was never actually ' +
          'reading that mechanism, so the totality assertions are vacuous — the state the old ' +
          'ratchet was in for three of the four; or (b) the mechanisms OVERLAP, so the gaps ' +
          'fell through to the next mechanism in the precedence order instead. (b) is what the ' +
          "`NO GAP is claimed by two mechanisms` test above exists to rule out — read its " +
          'verdict first.',
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
    //
    // Read the CLASSIFIED bucket, never a substring of the prose. This filtered
    // `dead['shared-pairs']` for `'IS committed'`; nothing pinned that wording,
    // so any reword (or translation) would have turned the assertion vacuously
    // green forever.
    expect(
      report.deadShared.stale,
      'a shared pair whose linux PNG is committed skips a card we already paid for, AND ' +
        'blocks its own re-capture (--update-snapshots writes nothing for a skipped test)',
    ).toEqual([]);

    // Entries naming nothing on either platform are pure noise. The 10 misnamed
    // `linux/toybox-*` names were DELETED (they are not "shadowed by mechanism
    // C and harmless" — the real toybox stems are `truchet`, `obj-tex-sphere`,
    // …, with no `toybox-` prefix, and vrt-toybox.spec.ts never imports the
    // shared Set, so nothing read them at all). The remaining 5 are frozen.
    const PHANTOM_CEILING = 5;
    expect(
      report.deadShared.phantom.length,
      'shared EXEMPT_BASELINE_PAIRS entries naming a scene with no baseline on EITHER ' +
        `platform — they inflate the list and explain nothing: ` +
        `${report.deadShared.phantom.join(', ')}`,
    ).toBeLessThanOrEqual(PHANTOM_CEILING);
    // Both directions: a ceiling cannot see a cleanup that forgot to re-pin it,
    // and the slack it leaves behind absorbs the next entry silently.
    expect(
      PHANTOM_CEILING - report.deadShared.phantom.length,
      `THE PHANTOM CEILING HAS GONE SLACK: ${report.deadShared.phantom.length} phantom(s) under ` +
        `a ceiling of ${PHANTOM_CEILING}. Set it to ${report.deadShared.phantom.length}.`,
    ).toBe(0);

    // The buckets must partition the rot — otherwise a classification bug
    // could quietly empty `stale` into `otherMechanism`.
    expect(
      report.deadShared.stale.length +
        report.deadShared.phantom.length +
        report.deadShared.otherMechanism.length,
      'the three deadShared buckets must partition dead[shared-pairs]',
    ).toBe(report.dead['shared-pairs'].length);
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
