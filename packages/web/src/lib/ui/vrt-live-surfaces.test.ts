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
//      LEGACY set below — which may only ever SHRINK.
//   5. The pre-registry `VRT_MODULE_MASKS` table (canvas masks with no
//      companion at all) is capped by a ratchet that may only ever SHRINK, so
//      a new module cannot join the un-companioned pile.
//
// This is a pure-unit gate: no browser, no snapshot, no flake, ~0 CI seconds.
// It runs in the `unit` lane, which is REQUIRED — so the rules above are
// enforced on every PR, not just the ones that happen to run the VRT lane.

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

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
import { VRT_MODULE_MASKS, EXEMPT_FROM_VRT } from '../../../../../e2e/vrt/vrt-exemptions';
import { VRT_SCENES } from '../../../../../e2e/vrt/vrt-scenes';

function repoRoot(): string {
  // packages/web/src/lib/ui → five hops to the repo root. Resolved from
  // import.meta.dirname so it is invariant to vitest's cwd.
  return resolve(import.meta.dirname, '../../../../..');
}

const VRT_DIR = resolve(repoRoot(), 'e2e/vrt');
const PLATFORMS = ['linux', 'darwin'] as const;

// ───────────────────────────────────────────────────────────────────────────
// RATCHET 1 — spec files still allowed to hand-roll a `mask:` array instead of
// going through e2e/vrt/vrt-capture.ts. Every one of these is a scene whose
// masked region has NO companion assertion, i.e. coverage that is currently
// deleted. The list may only ever SHRINK: migrating a spec to the seam means
// deleting its line here in the same commit. Adding a line is the failure the
// guard exists to catch.
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
// RATCHET 2 — the pre-registry canvas-mask table. An entry here masks a card's
// canvas with NO companion, so the module is free to render nothing. Entries
// whose module is EXEMPT_FROM_VRT or has a VRT_SCENES entry are inert (the
// spec never applies them), so the ratchet counts only the LIVE ones.
//
// Pinned at the measured value on the branch that introduced this guard.
// It may only go DOWN — migrate an entry into VRT_LIVE_SURFACES (with a
// companion) and lower this number in the same commit.
const LEGACY_UNCOMPANIONED_MASK_CEILING = 12;

/** The subset of VRT_MODULE_MASKS that vrt.spec.ts actually applies. */
function liveLegacyMaskTypes(): string[] {
  return Object.keys(VRT_MODULE_MASKS).filter(
    (type) => !(type in EXEMPT_FROM_VRT) && !(type in VRT_SCENES),
  );
}

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

  it('every scene id has a committed baseline on at least one platform', () => {
    // Typo guard. A misspelled key masks NOTHING (the scene never looks itself
    // up) while reading as though the region were handled — the exact silent
    // failure this file exists to prevent.
    for (const [sceneId, scene] of Object.entries(VRT_LIVE_SURFACES)) {
      const found = PLATFORMS.some((p) =>
        existsSync(resolve(VRT_DIR, '__screenshots__', scene.spec, p, `${sceneId}.png`)),
      );
      expect(
        found,
        `${sceneId}: no baseline PNG under __screenshots__/${scene.spec}/{linux,darwin}/ — ` +
          'either the scene id is misspelled (so the mask silently never applies) or the ' +
          'baseline was never captured',
      ).toBe(true);
    }
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
      if (surface.expectCount !== undefined) {
        expect(surface.expectCount, `${where}: expectCount must be >= 1`).toBeGreaterThanOrEqual(1);
        expect(
          surface.nth ?? 0,
          `${where}: nth must index inside expectCount`,
        ).toBeLessThan(surface.expectCount);
      }
    },
  );
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

describe('VRT masks: nobody routes around the registry', () => {
  it('no VRT spec hand-rolls a mask outside the capture seam (shrinking legacy list)', () => {
    const specs = readdirSync(VRT_DIR).filter((f) => f.endsWith('.spec.ts'));
    const offenders: string[] = [];
    for (const f of specs) {
      const src = readFileSync(resolve(VRT_DIR, f), 'utf8');
      if (!/^\s*mask:/m.test(src)) continue;
      if (LEGACY_INLINE_MASK_SPECS.has(f)) continue;
      offenders.push(f);
    }
    expect(
      offenders,
      'These specs pass a `mask:` array straight to toHaveScreenshot, so the masked region has ' +
        'no companion and may render nothing forever. Register the surface in ' +
        'e2e/vrt/vrt-live-surfaces.ts and capture through e2e/vrt/vrt-capture.ts instead.',
    ).toEqual([]);
  });

  it('the legacy inline-mask list only shrinks', () => {
    const specs = new Set(readdirSync(VRT_DIR).filter((f) => f.endsWith('.spec.ts')));
    for (const f of LEGACY_INLINE_MASK_SPECS) {
      expect(specs.has(f), `${f} is listed as a legacy inline-mask spec but does not exist`).toBe(true);
      const src = readFileSync(resolve(VRT_DIR, f), 'utf8');
      expect(
        /^\s*mask:/m.test(src),
        `${f} no longer hand-rolls a mask — delete it from LEGACY_INLINE_MASK_SPECS ` +
          '(the list is a ratchet; a stale entry re-opens the hole)',
      ).toBe(true);
    }
    expect(LEGACY_INLINE_MASK_SPECS.size).toBeLessThanOrEqual(6);
  });

  it('the un-companioned VRT_MODULE_MASKS pile only shrinks', () => {
    const live = liveLegacyMaskTypes();
    expect(
      live.length,
      `${live.length} module cards are masked by VRT_MODULE_MASKS with NO companion assertion ` +
        `(ceiling ${LEGACY_UNCOMPANIONED_MASK_CEILING}). Each one may render nothing and still ` +
        'pass. Migrate entries into e2e/vrt/vrt-live-surfaces.ts with a companion and lower the ' +
        `ceiling in the same commit.\n  ${live.join(', ')}`,
    ).toBeLessThanOrEqual(LEGACY_UNCOMPANIONED_MASK_CEILING);
  });

  it('a scene is masked from exactly ONE place', () => {
    // Both tables applying to the same module would mean two sources of truth
    // for one region, and the registry's companion could be silently bypassed.
    const overlap = MASKED_SCENE_IDS.filter((id) => id in VRT_MODULE_MASKS);
    expect(
      overlap,
      'These module types are in BOTH VRT_MODULE_MASKS and VRT_LIVE_SURFACES. Delete the ' +
        'VRT_MODULE_MASKS entry — the registry is the source of truth.',
    ).toEqual([]);
  });
});
