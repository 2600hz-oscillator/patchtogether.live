// packages/web/src/lib/ui/vrt-live-surfaces.test.ts
//
// THE ANTI-VACUITY GUARD for the VRT live-surface masks.
//
// A mask is a licence to render nothing. `expect(card).toHaveScreenshot({ mask
// })` paints the masked region magenta in BOTH the baseline and the actual
// before diffing, so a scope that draws a perfect trace and a scope that draws
// absolutely nothing produce byte-identical images. Left alone, that is the
// vacuous-assertion class this repo keeps producing — four were found in one
// backdraft sweep, and every one of them looked like a passing test.
//
// So masks are only legal here when they come with the coverage they deleted:
//
//   1. Every masked scene is REGISTERED in e2e/vrt/vrt-live-surfaces.ts, with
//      a stated reason naming WHAT DRIVES the non-determinism.
//   2. Every registered surface carries a COMPANION assertion.
//   3. Every companion REJECTS A DEAD RENDER — and this file PROVES that by
//      evaluating each companion against a synthetic flat-fill measurement,
//      rather than by trusting that whoever wrote the numbers meant well.
//      (CLAUDE.md: "negative-control the instrument, not just the code".)
//   4. Nobody can route around the registry: no VRT spec may hand-roll a
//      `mask:` array outside the shared capture seam, except the pinned
//      LEGACY set below — each entry NAMED and anchored to the file it names.
//   5. Every entry in the pre-registry `VRT_MODULE_MASKS` table (canvas masks
//      with no companion at all) must state a checkable CAUSE for the region it
//      deletes, per entry rather than per module.
//
// Neither 4 nor 5 has a COUNT any more — see the two removal notes below.
//
// This is a pure-unit gate: no browser, no snapshot, no flake, ~0 CI seconds.
// It runs in the `unit` lane, which is REQUIRED — so the rules above are
// enforced on every PR, not just the ones that happen to run the VRT lane.

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, relative, resolve } from 'node:path';

import {
  VRT_LIVE_SURFACES,
  MASKED_SCENE_IDS,
  type LiveSurface,
} from '../../../../../e2e/vrt/vrt-live-surfaces';
import {
  DEAD_RENDER_STATS,
  DEAD_RENDER_STATS_GREY,
  evaluateCompanion,
  rejectsDeadRender,
  type SurfaceCompanion,
} from '../../../../../e2e/vrt/vrt-surface-stats';
import { VRT_SCENES } from '../../../../../e2e/vrt/vrt-scenes';
import {
  findHandRolledMasks,
  collectMaskScanTargets,
  parseLocalImports,
  type ScanFs,
} from '../../../../../e2e/vrt/vrt-mask-scan';

function repoRoot(): string {
  // packages/web/src/lib/ui → five hops to the repo root. Resolved from
  // import.meta.dirname so it is invariant to vitest's cwd.
  return resolve(import.meta.dirname, '../../../../..');
}

const VRT_DIR = resolve(repoRoot(), 'e2e/vrt');

// ───────────────────────────────────────────────────────────────────────────
// THE LEGACY INLINE-MASK LIST — spec files still allowed to hand-roll a `mask:`
// array instead of going through e2e/vrt/vrt-capture.ts. Every one of these is a
// scene whose masked region has NO companion assertion, i.e. coverage that is
// currently deleted. Migrating a spec to the seam means deleting its line here
// in the same commit, and the anchor below makes forgetting to RED.
//
// ⚠ `LEGACY_INLINE_MASK_SPECS.size <= 6` IS GONE (2026-08-10). It was the LAST
// hand-typed population count in this file; the sibling
// `LEGACY_UNCOMPANIONED_MASK_CEILING = 12` went the same way earlier the same
// day (see the note under the table below, which also records what its removal
// cost). WHAT THE 6 PROTECTED and WHO CARRIES IT NOW:
//
//   · a NEW spec hand-rolling a mask → 'no VRT file hand-rolls a mask outside
//     the capture seam' (deny by default: an unlisted file with a `mask:` is
//     RED), plus 'no file OUTSIDE e2e/vrt/ that a VRT spec imports hand-rolls a
//     mask' and the import-graph reach-out control that keeps that scan
//     non-vacuous. None of the three consults this list except as an exemption;
//     none of them needs a number.
//   · a STALE entry → 'the legacy inline-mask list only shrinks', which resolves
//     every name against the tree: a listed file that does not exist is RED, and
//     a listed file that no longer hand-rolls a mask is RED. That is what makes
//     the list SHRINK on its own rather than because a literal says so.
//
// ⚠ WHAT IS GENUINELY LOST: growth-BY-LISTING. Adding a seventh spec to this set
// AND hand-rolling a mask in it used to trip the `<= 6`; now it does not, and
// the brake is review of the new named line in the diff. Pre-authorised coverage
// loss of the kill-ratchets directive, recorded here rather than in a commit
// message — and the same trade the sibling count below made, for the same
// reason: a literal three concurrent branches each compute correctly and merge
// wrongly is not a protection, it is a coin flip with a green light.
const LEGACY_INLINE_MASK_SPECS = new Set<string>([
  // Masks the app-version stamp (build metadata — vdev locally, vX.Y.Z on CI).
  'landing.spec.ts',
  'topbar.spec.ts',
  // Masks the POSTERBOX OUT preview canvas. Solo-spawned and unpatched it
  // renders a BLACK frame, so no ink/variance companion can distinguish
  // "working" from "dead" — the render coverage genuinely lives elsewhere
  // (posterbox.test.ts CPU mirror + posterbox-functional.spec.ts readPixels).
  // Migrating this one needs a driven scene first, not just a companion.
  'vrt-posterbox-states.spec.ts',
  // Mask the audio device pickers + the footer ctx/sr/lat status readout.
  'workflow-audio-io-composite.spec.ts',
  'workflow-dock-composite.spec.ts',
  'workflow-shell-zoom.spec.ts',
]);

// ───────────────────────────────────────────────────────────────────────────
// THE PRE-REGISTRY CANVAS-MASK TABLE. An entry here masks a card's canvas with
// NO companion, so the module is free to render nothing. Entries whose module is
// EXEMPT_FROM_VRT or has a VRT_SCENES entry are inert (the spec never applies
// them), so only the LIVE ones are of interest.
//
// ⚠ THE COUNT IS GONE (2026-08-10). `LEGACY_UNCOMPANIONED_MASK_CEILING = 12`
// was a hand-typed population count, and it is the clearest case in the repo of
// why that is the wrong data structure: A COUNT IS NOT A SIZE. Twelve entries
// could have been twelve 3 % slivers or twelve half-cards and the number would
// read the same, so the thing anyone actually needed to know had to be written
// out longhand in the comment below — which the number could neither carry nor
// keep true. Replaced by a REQUIRED `why` on every `MaskRect`
// (e2e/vrt/vrt-exemptions.ts), enforced from a controlled cause vocabulary by
// 'every legacy mask names WHY the region cannot be diffed' below, so each mask
// is a named, checkable decision instead of one unit of an anonymous budget.
//
// WHAT WAS LOST: nothing stops the live pile from GROWING now except the review
// of a new named entry. A card that adds a masked canvas with a plausible `why`
// no longer trips a number. That is the pre-authorised trade — a name a reader
// can check against the card, instead of a literal that three concurrent
// branches each compute correctly and merge wrongly.
//
// The measurement below stands as the record of the debt. MEASURED 2026-08-01
// by spawning each card the
// way vrt.spec.ts spawns it and computing masked-element area ÷ card area
// (e2e/vrt/vrt-legacy-mask-audit.spec.ts, `VRT_PROBE=1`; re-derive with one
// command). Sorted by cost:
//
//   module        card      masked region   area of card   companion?
//   ────────────  ────────  ──────────────  ────────────   ──────────
//   monoglitch    387x526   339x191            31.8 %      NONE
//   feedback      351x526   316x178            30.4 %      NONE
//   recorderbox   526x526   292x219 + 1x1      23.1 %      NONE
//   freezeframe   351x526   222x167            20.1 %      NONE
//   mandleblot    526x526   289x161            16.8 %      NONE
//   tiler         526x526   234x175            14.8 %      NONE
//   posterbox     526x526   234x175            14.8 %      NONE
//   outlines      351x526   164x164            14.5 %      NONE
//   samsloop      351x526   257x97             13.6 %      NONE
//   textmarquee   351x526   164x123            10.9 %      NONE
//   spirographs   351x526   156x117             9.9 %      NONE
//   cellshade     351x526   156x117             9.9 %      NONE
//
// For scale: the two masks the live-surface registry argues hardest to justify
// are timelorde at 25.6 % and mandelbulb at 22.6 %. FOUR entries in this
// uncompanioned pile are LARGER than mandelbulb's, and two are larger than
// timelorde's — with no `why`, no companion, no negative control and no
// measurement of any kind behind them. `recorderbox` additionally masks TWO
// elements from one selector (the second is the 1x1 off-screen capture
// canvas), which is exactly the one-selector-many-regions shape the registry's
// `expectCount: 1` rule exists to forbid.
//
// They are listed rather than fixed here deliberately: migrating one means
// building a driven scene for it (several render BLACK when solo-spawned and
// unpatched, so no ink/variance companion can separate "working" from "dead" —
// the posterbox note in RATCHET 1 above is the worked example). The point of
// this table is that the size of the debt is visible instead of implied.


/** Words that name a DRIVER of non-determinism. A `why` that cannot name one
 *  is not an explanation — it is a shrug, and the next reader cannot tell
 *  whether the mask is still needed. Same shape as the edge/gate vocabulary
 *  check in module-docs-lint.test.ts. */
const DRIVER_VOCABULARY = [
  'requestAnimationFrame',
  'rAF',
  'analyser',
  'AnalyserNode',
  'engine clock',
  'wall clock',
  'wall-clock',
  'render loop',
  'blit loop',
  'GPU',
  'WebGL',
  'decode',
  'poll',
  'timer',
  'network',
  'device list',
  'build metadata',
];

/** The cause vocabulary for a LEGACY `MaskRect.why`. A superset of the driver
 *  words above, because two legacy masks are unstable for reasons that are not
 *  a driver at all and saying so is the honest answer:
 *    - an EMPTY / PLACEHOLDER state (samsloop's "NO SAMPLE LOADED" text before
 *      a WAV is uploaded — nothing is animating, there is simply no content);
 *    - a FALLBACK entry that vrt.spec.ts never applies because the module has a
 *      VRT_SCENES entry that overrides it (ruttetra, scoreboard).
 *  Forcing those two to name a driver would only teach the next author to
 *  fabricate one, which is how a vocabulary check becomes a spelling test. */
const MASK_CAUSE_VOCABULARY = [
  ...DRIVER_VOCABULARY,
  'placeholder',
  'empty on',
  'FALLBACK',
];

function allSurfaces(): Array<{ sceneId: string; surface: LiveSurface }> {
  return Object.entries(VRT_LIVE_SURFACES).flatMap(([sceneId, scene]) =>
    scene.surfaces.map((surface) => ({ sceneId, surface })),
  );
}

describe('VRT live-surface registry: structure', () => {
  it('registers at least one scene (an empty registry means the seam is unused)', () => {
    expect(MASKED_SCENE_IDS.length).toBeGreaterThan(0);
  });

  it('every scene declares an owning spec file that exists', () => {
    for (const [sceneId, scene] of Object.entries(VRT_LIVE_SURFACES)) {
      expect(scene.spec, `${sceneId}: missing owning spec`).toBeTruthy();
      expect(
        existsSync(resolve(VRT_DIR, scene.spec)),
        `${sceneId}: declared spec ${scene.spec} does not exist under e2e/vrt/`,
      ).toBe(true);
    }
  });

  it('every scene masks at least one surface', () => {
    for (const [sceneId, scene] of Object.entries(VRT_LIVE_SURFACES)) {
      expect(
        scene.surfaces.length,
        `${sceneId}: a registry entry with no surfaces masks nothing — delete it`,
      ).toBeGreaterThan(0);
    }
  });

  it('every scene id has a committed baseline', () => {
    // Typo guard. A misspelled key masks NOTHING (the scene never looks itself
    // up) while reading as though the region were handled — the exact silent
    // failure this file exists to prevent.
    //
    // ⚠ This resolved `<spec>/{linux,darwin}/<scene>.png` until 2026-08-11, and
    // kept doing so AFTER the `{platform}` segment was deleted from
    // `snapshotPathTemplate` — so it was probing two directories that no longer
    // exist and could not pass for ANY entry. It read as "one uncaptured
    // scene" because the loop fails on the first entry and `mandelbulb` is the
    // first key; the real scope was every entry in the registry. A path built
    // in a test is a second, unchecked copy of the production path template,
    // and this is what that costs.
    const missing: string[] = [];
    for (const [sceneId, scene] of Object.entries(VRT_LIVE_SURFACES)) {
      if (!existsSync(resolve(VRT_DIR, '__screenshots__', scene.spec, `${sceneId}.png`))) {
        missing.push(`${scene.spec}/${sceneId}.png`);
      }
    }
    // Report ALL of them, not just the first: with one baseline set authored by
    // CI, "which scenes are uncaptured" is the actionable list, and failing on
    // entry one hides the other 40.
    expect(
      missing,
      'live-surface scene ids with no committed baseline under e2e/vrt/__screenshots__/. ' +
        'Either the scene id is misspelled (so the mask silently never applies) or the ' +
        'baseline was never captured — capture with `task vrt:commit`, which dispatches ' +
        'vrt-update.yml on linux CI, the only baseline author.',
    ).toEqual([]);
  });
});

describe('VRT live-surface registry: every mask states WHY', () => {
  it.each(allSurfaces().map(({ sceneId, surface }) => [sceneId, surface.selector, surface] as const))(
    '%s / %s explains what drives it',
    (sceneId, selector, surface) => {
      const why = surface.why ?? '';
      expect(
        why.length,
        `${sceneId} / ${selector}: "why" must be a real explanation of what drives the ` +
          'non-determinism, not a placeholder',
      ).toBeGreaterThanOrEqual(80);
      expect(
        /TODO|FIXME|TBD|n\/a/i.test(why),
        `${sceneId} / ${selector}: "why" contains a placeholder`,
      ).toBe(false);
      expect(
        DRIVER_VOCABULARY.some((w) => why.toLowerCase().includes(w.toLowerCase())),
        `${sceneId} / ${selector}: "why" never names WHAT DRIVES the region. Name the ` +
          `mechanism — one of: ${DRIVER_VOCABULARY.join(', ')}`,
      ).toBe(true);
    },
  );
});

describe('VRT live-surface registry: every mask owes a companion', () => {
  it.each(allSurfaces().map(({ sceneId, surface }) => [sceneId, surface.selector, surface] as const))(
    '%s / %s carries a companion with a stated derivation',
    (sceneId, selector, surface) => {
      const c: SurfaceCompanion | undefined = surface.companion;
      expect(c, `${sceneId} / ${selector}: no companion — the mask deletes coverage outright`).toBeTruthy();
      expect(
        (c.rationale ?? '').length,
        `${sceneId} / ${selector}: companion rationale must state the measured live value and ` +
          'what a dead render scores, so the floors can be re-derived when they go red',
      ).toBeGreaterThanOrEqual(80);
    },
  );

  it.each(allSurfaces().map(({ sceneId, surface }) => [sceneId, surface.selector, surface] as const))(
    '%s / %s sets at least one FLOOR (a ceiling alone is vacuous)',
    (sceneId, selector, surface) => {
      const c = surface.companion;
      const floors = [
        c.minInkFraction,
        c.minLumaStdDev,
        c.minDistinctLumaBuckets,
        c.minMeanChroma,
      ].filter((v) => v !== undefined);
      expect(
        floors.length,
        `${sceneId} / ${selector}: companion sets no floor. A dead render scores ZERO on every ` +
          'statistic, so a ceiling-only companion accepts it.',
      ).toBeGreaterThan(0);
    },
  );

  // THE LOAD-BEARING TEST. Not "does the companion look strict" — does it
  // actually reject a measurement taken from a surface that rendered nothing.
  it.each(allSurfaces().map(({ sceneId, surface }) => [sceneId, surface.selector, surface] as const))(
    '%s / %s REJECTS a dead render (evaluated, not assumed)',
    (sceneId, selector, surface) => {
      const black = evaluateCompanion(surface.companion, DEAD_RENDER_STATS);
      const grey = evaluateCompanion(surface.companion, DEAD_RENDER_STATS_GREY);
      expect(
        black.ok,
        `${sceneId} / ${selector}: companion ACCEPTS a flat BLACK region — the mask deleted the ` +
          `coverage and nothing replaced it.\n  ${black.checked.join('\n  ')}`,
      ).toBe(false);
      expect(
        grey.ok,
        `${sceneId} / ${selector}: companion ACCEPTS a flat MID-GREY region. A floor that only ` +
          'catches black is blind to a grey wash (a cleared GL buffer, a disabled card).\n  ' +
          grey.checked.join('\n  '),
      ).toBe(false);
      expect(rejectsDeadRender(surface.companion)).toBe(true);
    },
  );

  it.each(allSurfaces().map(({ sceneId, surface }) => [sceneId, surface.selector, surface] as const))(
    '%s / %s uses floors inside their physical range',
    (sceneId, selector, surface) => {
      const c = surface.companion;
      const where = `${sceneId} / ${selector}`;
      if (c.minInkFraction !== undefined) {
        expect(c.minInkFraction, `${where}: minInkFraction must be > 0`).toBeGreaterThan(0);
        expect(c.minInkFraction, `${where}: minInkFraction is a FRACTION (0-1)`).toBeLessThanOrEqual(1);
      }
      if (c.maxInkFraction !== undefined) {
        expect(c.maxInkFraction, `${where}: maxInkFraction is a FRACTION (0-1)`).toBeLessThanOrEqual(1);
        expect(
          c.maxInkFraction,
          `${where}: maxInkFraction must sit above minInkFraction`,
        ).toBeGreaterThan(c.minInkFraction ?? 0);
      }
      if (c.minLumaStdDev !== undefined) {
        expect(c.minLumaStdDev, `${where}: minLumaStdDev must be > 0`).toBeGreaterThan(0);
        // Population stddev of an 0-255 signal maxes at 127.5.
        expect(c.minLumaStdDev, `${where}: minLumaStdDev exceeds the 0-127.5 range`).toBeLessThanOrEqual(127.5);
      }
      if (c.minDistinctLumaBuckets !== undefined) {
        expect(
          c.minDistinctLumaBuckets,
          `${where}: a flat fill already scores 1 bucket, so a floor of 1 is vacuous`,
        ).toBeGreaterThanOrEqual(2);
        expect(c.minDistinctLumaBuckets, `${where}: there are only 16 buckets`).toBeLessThanOrEqual(16);
      }
      if (c.minMeanChroma !== undefined) {
        expect(c.minMeanChroma, `${where}: minMeanChroma must be > 0`).toBeGreaterThan(0);
        expect(c.minMeanChroma, `${where}: chroma is 0-255`).toBeLessThanOrEqual(255);
      }
    },
  );
});

// ───────────────────────────────────────────────────────────────────────────
// THE PER-REGION RULE.
//
// The hole this closes: the registry used to allow `selector: 'canvas'` with
// `expectCount: 3, nth: 0`. The capture seam masked ALL THREE canvases and the
// companion measured only `nth(0)` — so the MASKED set and the COMPANIONED set
// were different sets, and nothing checked that. Across three scenes that was
// TEN masked canvases with no companion behind them, inside the file whose
// entire premise is "a mask cannot silently delete coverage".
//
// The fix is structural, not procedural: one entry names exactly one element,
// so `mask.length === surfaces.length === companions.length` by construction
// and there is no index to get wrong.
describe('VRT live-surface registry: one entry = one region = one companion', () => {
  it.each(allSurfaces().map(({ sceneId, surface }) => [sceneId, surface.selector, surface] as const))(
    '%s / %s masks EXACTLY ONE element',
    (sceneId, selector, surface) => {
      expect(
        surface.expectCount,
        `${sceneId} / ${selector}: expectCount must be exactly 1. A selector matching N ` +
          'elements masks N regions but the companion measures ONE, so N-1 masked regions ' +
          'would carry no assertion at all. Narrow the selector and register one entry ' +
          '(with its own measured companion) per non-deterministic region.',
      ).toBe(1);
    },
  );

  it('no surface carries an `nth` index (the field is gone on purpose)', () => {
    // A stale `nth` in a hand-edited entry would be silently ignored by the
    // seam now that it masks the single matched element — and "silently
    // ignored" is how the previous hole read too. Fail loudly instead.
    for (const { sceneId, surface } of allSurfaces()) {
      expect(
        'nth' in (surface as object),
        `${sceneId} / ${surface.selector}: \`nth\` no longer exists — a selector resolves ` +
          'to one element or it is not a legal entry. Split it into per-region entries.',
      ).toBe(false);
    }
  });
});

describe('VRT live-surface registry: the instrument itself', () => {
  // Guard the guard. If evaluateCompanion ever stopped failing — a refactor
  // that swallowed the comparison, a stats field renamed — every test above
  // would go green while proving nothing. These two pin the polarity.
  it('a floor-setting companion rejects the dead fixtures', () => {
    const c: SurfaceCompanion = { minInkFraction: 0.001, rationale: 'x'.repeat(80) };
    expect(evaluateCompanion(c, DEAD_RENDER_STATS).ok).toBe(false);
    expect(evaluateCompanion(c, DEAD_RENDER_STATS_GREY).ok).toBe(false);
  });

  it('the same companion ACCEPTS a plausible live measurement', () => {
    const c: SurfaceCompanion = { minInkFraction: 0.001, rationale: 'x'.repeat(80) };
    expect(
      evaluateCompanion(c, { ...DEAD_RENDER_STATS, inkFraction: 0.05, lumaStdDev: 20, distinctLumaBuckets: 5 })
        .ok,
    ).toBe(true);
  });

  it('a ceiling-only companion is detected as vacuous', () => {
    const c: SurfaceCompanion = { maxInkFraction: 0.9, rationale: 'x'.repeat(80) };
    expect(rejectsDeadRender(c)).toBe(false);
  });
});

/** Real-filesystem adapter for the import-graph walk. */
const REAL_FS: ScanFs = {
  exists: existsSync,
  read: (p) => readFileSync(p, 'utf8'),
  resolve,
  dirname,
};

describe('VRT masks: nobody routes around the registry', () => {
  // The ONE file allowed to build a mask array: the shared capture seam.
  // Everything else under e2e/vrt/ is scanned — specs AND helpers.
  const SEAM = new Set(['vrt-capture.ts', 'vrt-mask-scan.ts']);
  const scannable = (): string[] =>
    readdirSync(VRT_DIR).filter((f) => f.endsWith('.ts') && !SEAM.has(f));

  // ── THE SCAN SET, WIDENED ────────────────────────────────────────────────
  //
  // Scanning the DIRECTORY e2e/vrt/ was the hole. The comment above used to
  // claim helpers were covered "because a spec that calls `liveTextMasks(page)`
  // from a helper module would otherwise move the mask out of the scanned
  // file" — true only for a helper that happens to live in e2e/vrt/. A helper
  // ONE DIRECTORY OVER (`e2e/tests/_shot-opts.ts`) was invisible, and an
  // adversarial verifier proved it with exactly that file while this guard
  // stayed green.
  //
  // So the scan follows the IMPORT GRAPH out of e2e/vrt/ instead: a mask can
  // only reach a `toHaveScreenshot` in the VRT lane if its file is reachable
  // from a VRT file. Closed by construction, and it cannot fire on unrelated
  // e2e specs (e2e/tests/toybox-node-batch.spec.ts's `params: { op: 0, mask:
  // 170 }` is a legitimate DSP parameter and is reachable from no VRT spec).
  //
  // Files OUTSIDE e2e/vrt/ get NO legacy exemption: LEGACY_INLINE_MASK_SPECS
  // names the specs that already existed, not a licence to open a new one
  // somewhere the guard used not to look.
  const importedOutsideVrtDir = (): string[] => {
    const entries = readdirSync(VRT_DIR)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => resolve(VRT_DIR, f));
    return collectMaskScanTargets({ entries, fs: REAL_FS }).filter(
      (p) => dirname(p) !== VRT_DIR,
    );
  };

  it('the scan set REACHES OUT of e2e/vrt/ (else the widening is decorative)', () => {
    // Negative-control the scan set itself. If this list is ever empty the
    // import walk has silently stopped working and every assertion below is
    // vacuous — which is precisely how the directory scan failed.
    const outside = importedOutsideVrtDir();
    expect(
      outside.length,
      'The import-graph walk found NO file outside e2e/vrt/. The VRT specs do import ' +
        '../tests/_helpers and ../tests/_registry, so an empty result means the walk broke ' +
        'and the out-of-directory hole is open again.',
    ).toBeGreaterThan(0);
    // Named, so a refactor that moves the helpers is a readable failure.
    const rel = outside.map((p) => relative(resolve(repoRoot()), p));
    expect(rel).toContain('e2e/tests/_helpers.ts');
  });

  it('no file OUTSIDE e2e/vrt/ that a VRT spec imports hand-rolls a mask', () => {
    const offenders: string[] = [];
    for (const abs of importedOutsideVrtDir()) {
      if (!existsSync(abs)) continue;
      const hits = findHandRolledMasks(readFileSync(abs, 'utf8'));
      if (hits.length === 0) continue;
      offenders.push(`${relative(resolve(repoRoot()), abs)}:${hits.map((h) => h.line).join(',')} — ${hits[0]!.text}`);
    }
    expect(
      offenders,
      'A module OUTSIDE e2e/vrt/ that a VRT spec imports builds a `mask` array. That is the ' +
        'exact evasion this scan was widened to catch: the mask never appears in a scanned ' +
        'spec, so the masked region has no companion and may render nothing forever. ' +
        'Register the surface in e2e/vrt/vrt-live-surfaces.ts and capture through ' +
        'e2e/vrt/vrt-capture.ts.',
    ).toEqual([]);
  });

  it('no VRT file hand-rolls a mask outside the capture seam (shrinking legacy list)', () => {
    const offenders: string[] = [];
    for (const f of scannable()) {
      const hits = findHandRolledMasks(readFileSync(resolve(VRT_DIR, f), 'utf8'));
      if (hits.length === 0) continue;
      if (LEGACY_INLINE_MASK_SPECS.has(f)) continue;
      offenders.push(`${f}:${hits.map((h) => h.line).join(',')} — ${hits[0]!.text}`);
    }
    expect(
      offenders,
      'These files pass a `mask` straight to toHaveScreenshot, so the masked region has ' +
        'no companion and may render nothing forever. Register the surface in ' +
        'e2e/vrt/vrt-live-surfaces.ts and capture through e2e/vrt/vrt-capture.ts instead.',
    ).toEqual([]);
  });

  it('the legacy inline-mask list only shrinks', () => {
    const files = new Set(scannable());
    for (const f of LEGACY_INLINE_MASK_SPECS) {
      expect(files.has(f), `${f} is listed as a legacy inline-mask spec but does not exist`).toBe(true);
      const src = readFileSync(resolve(VRT_DIR, f), 'utf8');
      expect(
        findHandRolledMasks(src).length,
        `${f} no longer hand-rolls a mask — delete it from LEGACY_INLINE_MASK_SPECS ` +
          '(a stale entry is one nobody is watching, and it re-opens the hole for ' +
          'whatever mask is added to that file next)',
      ).toBeGreaterThan(0);
    }
    // (`expect(LEGACY_INLINE_MASK_SPECS.size).toBeLessThanOrEqual(6)` stood
    // here until 2026-08-10 — see the removal note above the set for what it
    // protected and which assertions carry that now. The loop above IS the
    // only-shrinks mechanism: it is anchored to the tree, so it cannot go
    // stale, and it names the file instead of reporting that a total moved.)
  });

  // ── GUARD THE GUARD ──────────────────────────────────────────────────────
  //
  // The rule above is only worth the bytes if the DETECTOR actually sees the
  // shapes a mask can take. The previous detector was `/^\s*mask:/m` — `mask:`
  // had to open its own line — so the repo's own one-line style
  // `toHaveScreenshot(name, { mask: [x] })` walked straight past it. An
  // adversarial verifier injected exactly that into vrt-aspect-16x9.spec.ts
  // and the guard stayed GREEN.
  //
  // So: perturb the thing the instrument claims to measure and confirm the
  // number moves (CLAUDE.md, "negative-control the instrument, not just the
  // code"). Each MUST_CATCH fixture is a real way to write a mask; each
  // MUST_IGNORE fixture is a way the word appears WITHOUT masking anything,
  // and a detector that fires on those is one nobody will keep.
  describe('the mask detector itself', () => {
    const MUST_CATCH: Array<[string, string]> = [
      [
        'the one-liner that evaded the old ^\\s*mask: regex',
        "await expect(card).toHaveScreenshot('x.png', { mask: [card.locator('canvas')] });",
      ],
      ['the prettier-wrapped form', 'await expect(c).toHaveScreenshot({\n  mask: [x],\n});'],
      ['object shorthand', 'const mask = [x];\nawait expect(c).toHaveScreenshot({ mask });'],
      ['a quoted property key', "await expect(c).toHaveScreenshot({ 'mask': [x] });"],
      ['a computed property key', 'await expect(c).toHaveScreenshot({ ["mask"]: [x] });'],
      ['extra whitespace before the colon', 'await expect(c).toHaveScreenshot({ mask : [x] });'],
      ['a mask nested inside another option object', 'const o = { a: 1, b: { mask: [x] } };'],
    ];
    const MUST_IGNORE: Array<[string, string]> = [
      ['maskColor alone (legal — it only recolours the mask)', "toHaveScreenshot({ maskColor: '#ff00ff' });"],
      ['a line comment mentioning mask:', '// mask: [x] would be illegal here'],
      ['a block comment mentioning mask:', '/*\n * mask: [x]\n */'],
      ['a string containing "mask:"', "const s = 'mask: [x]';"],
      ['a template literal containing mask:', 'const s = `mask: ${x}`;'],
      ['an identifier merely ending in mask', 'const o = { unmask: [x] };'],
    ];

    it.each(MUST_CATCH)('CATCHES %s', (_name, src) => {
      expect(findHandRolledMasks(src).length).toBeGreaterThan(0);
    });

    it.each(MUST_IGNORE)('ignores %s', (_name, src) => {
      expect(findHandRolledMasks(src)).toEqual([]);
    });

    it('reports the 1-indexed line of the ORIGINAL source', () => {
      const src = '// header\n/* block\n   comment */\nconst o = { mask: [x] };';
      expect(findHandRolledMasks(src)).toEqual([
        { line: 4, text: 'const o = { mask: [x] };' },
      ]);
    });
  });

  // ── GUARD THE SCAN SET ───────────────────────────────────────────────────
  //
  // The detector fixtures above prove the scanner sees every SPELLING of a
  // mask. They say nothing about whether the guard ever READS the file the
  // mask is in — and that was the second, independent hole: a helper outside
  // e2e/vrt/ was never opened, so the detector's quality was irrelevant.
  //
  // These fixtures rebuild the verifier's exact evasion on a synthetic tree —
  // `e2e/tests/_shot-opts.ts` exporting a mask, imported by an
  // `e2e/vrt/*.spec.ts` — and assert the walk reaches it. Synthetic rather
  // than a real committed file, because committing the evasion would make the
  // guard above go permanently red.
  describe('the scan set (import-graph walk)', () => {
    const fixtureTree = (): { vrtSpec: string; helper: string; root: string } => {
      const root = mkdtempSync(resolve(tmpdir(), 'vrt-mask-scan-'));
      mkdirSync(resolve(root, 'e2e/vrt'), { recursive: true });
      mkdirSync(resolve(root, 'e2e/tests'), { recursive: true });
      const helper = resolve(root, 'e2e/tests/_shot-opts.ts');
      writeFileSync(
        helper,
        [
          "import type { Locator } from '@playwright/test';",
          'export const shotOpts = (card: Locator) => ({',
          "  mask: [card.locator('canvas')],",
          "  maskColor: '#ff00ff',",
          '});',
        ].join('\n'),
      );
      const vrtSpec = resolve(root, 'e2e/vrt/evader.spec.ts');
      writeFileSync(
        vrtSpec,
        [
          "import { shotOpts } from '../tests/_shot-opts';",
          "await expect(card).toHaveScreenshot('x.png', shotOpts(card));",
        ].join('\n'),
      );
      return { vrtSpec, helper, root };
    };

    it('parses the relative specifier out of an import', () => {
      expect(parseLocalImports("import { a } from '../tests/_shot-opts';")).toEqual([
        '../tests/_shot-opts',
      ]);
      expect(parseLocalImports("export * from './vrt-scenes';")).toEqual(['./vrt-scenes']);
      expect(parseLocalImports("const m = await import('./late');")).toEqual(['./late']);
      expect(parseLocalImports("import './side-effect';")).toEqual(['./side-effect']);
      // A bare package is not ours to walk into.
      expect(parseLocalImports("import { test } from '@playwright/test';")).toEqual([]);
    });

    it('REACHES a helper one directory over — the exact shape that evaded the guard', () => {
      const { vrtSpec, helper } = fixtureTree();
      const targets = collectMaskScanTargets({ entries: [vrtSpec], fs: REAL_FS });
      expect(
        targets,
        'The walk must follow ../tests/_shot-opts out of e2e/vrt/ — a helper the guard never ' +
          'opens is a mask the guard cannot see, however good the detector is.',
      ).toContain(helper);
    });

    it('and the mask INSIDE that helper is then found', () => {
      const { vrtSpec, helper } = fixtureTree();
      const targets = collectMaskScanTargets({ entries: [vrtSpec], fs: REAL_FS });
      const hits = targets
        .filter((p) => existsSync(p))
        .flatMap((p) => findHandRolledMasks(readFileSync(p, 'utf8')).map((h) => ({ p, ...h })));
      expect(hits.map((h) => h.p)).toContain(helper);
    });

    it('NEGATIVE CONTROL: the same helper is NOT reached when nothing imports it', () => {
      // Without this, the two tests above would pass on a walk that simply
      // returned every .ts under the tmp root — proving reachability, not the
      // import graph.
      const { vrtSpec, helper, root } = fixtureTree();
      writeFileSync(vrtSpec, "await expect(card).toHaveScreenshot('x.png');\n");
      const targets = collectMaskScanTargets({ entries: [vrtSpec], fs: REAL_FS });
      expect(targets).not.toContain(helper);
      expect(targets).toEqual([vrtSpec]);
      expect(existsSync(resolve(root, 'e2e/tests/_shot-opts.ts'))).toBe(true);
    });

    it('survives an import cycle instead of hanging', () => {
      const root = mkdtempSync(resolve(tmpdir(), 'vrt-mask-cycle-'));
      const a = resolve(root, 'a.ts');
      const b = resolve(root, 'b.ts');
      writeFileSync(a, "import './b';");
      writeFileSync(b, "import './a';");
      expect(collectMaskScanTargets({ entries: [a], fs: REAL_FS }).sort()).toEqual([a, b].sort());
    });
  });

  // ⚠ THE THREE LEGACY-MASK LEGS ARE GONE, AND THE LAST ONE SAID SO ITSELF.
  //
  // They asserted that every `VRT_MODULE_MASKS` entry named a real cause, that
  // the predicate could see a bare mask, and that no scene was masked from both
  // that table and this registry. All three read `VRT_MODULE_MASKS` /
  // `EXEMPT_FROM_VRT` out of `e2e/vrt/vrt-exemptions.ts`, which existed ONLY to
  // steer the per-module legacy CARD sweep. The sweep is deleted, so the table
  // applies to nothing — and the negative control here carried the exit
  // condition in its own message: "no legacy mask is LIVE any more … that is
  // the goal state — delete the table and this guard together when it happens."
  // It happened.
  //
  // Nothing about the REGISTRY's own guarantees moves: every leg above still
  // runs, and the "nobody routes around the registry" scan is what stops a mask
  // reappearing outside it.
});
