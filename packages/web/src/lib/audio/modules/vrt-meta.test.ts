// packages/web/src/lib/audio/modules/vrt-meta.test.ts
//
// Coverage self-test for the Playwright VRT suite.
//
// Asserts every registered audio + video + meta module has:
//   1. either a VRT baseline (via auto-enrollment from the registry
//      manifest) OR an explicit entry in EXEMPT_FROM_VRT with a reason
//   2. a baseline PNG under e2e/vrt/__screenshots__/vrt.spec.ts/{platform}/
//      for every platform we ship (linux + darwin) — unless the
//      (platform, type) pair is in EXEMPT_BASELINE_PAIRS.
//
// Catches the "added a new module, forgot the baseline" case in the
// vitest pass (~1s) rather than in the Playwright pass (~3min on CI),
// and well before the gallery deploys.
//
// EXEMPT_FROM_VRT + EXEMPT_BASELINE_PAIRS live in the shared
// e2e/vrt/vrt-exemptions.ts so vrt.spec.ts and this self-test agree on
// the source of truth — no risk of skew between a spec entry and an
// unaware self-test allowlist.

import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { listModuleDefs } from '$lib/audio/module-registry';
import { listVideoModuleDefs } from '$lib/video/module-registry';
import { listMetaModuleDefs } from '$lib/meta/module-registry';

// Single source of truth (also imported by e2e/vrt/vrt.spec.ts).
// vitest's `resolve.alias` doesn't reach across the /e2e/ workspace
// without explicit config, so we use a relative path here.
import {
  EXEMPT_FROM_VRT,
  EXEMPT_BASELINE_PAIRS,
  STRICT_VRT_MODULES,
  VRT_MODULE_MASKS,
} from '../../../../../../e2e/vrt/vrt-exemptions';
import { VRT_SCENES } from '../../../../../../e2e/vrt/vrt-scenes';

function repoRoot(): string {
  // This file lives at packages/web/src/lib/audio/modules/. Six `..`
  // hops up = repo root. Resolved from import.meta.dirname so the
  // result is invariant to vitest's working directory.
  return resolve(import.meta.dirname, '../../../../../..');
}

// Platforms we ship baselines for. Matches the {platform} substitution
// in vrt.config.ts's snapshotPathTemplate (Playwright fills it from
// process.platform). Keep in sync with the committed subdirs under
// e2e/vrt/__screenshots__/vrt.spec.ts/.
const VRT_PLATFORMS = ['linux', 'darwin'] as const;

function baselinePath(type: string, platform: string): string {
  return resolve(
    repoRoot(),
    `e2e/vrt/__screenshots__/vrt.spec.ts/${platform}/${type}.png`,
  );
}

describe('VRT coverage self-test', () => {
  // Force-import the registration barrels so the registries are
  // populated. The web app's UI does this on first page load; in the
  // vitest pass we have to import them explicitly.
  it('imports module barrels so registries are populated', async () => {
    await import('$lib/audio/modules');
    await import('$lib/video/modules');
    await import('$lib/meta/modules');
    const total =
      listModuleDefs().length + listVideoModuleDefs().length + listMetaModuleDefs().length;
    expect(total, 'at least one module is registered').toBeGreaterThan(0);
  });

  it('every registered module is covered by VRT or exempt with a reason', async () => {
    await import('$lib/audio/modules');
    await import('$lib/video/modules');
    await import('$lib/meta/modules');
    const registered = [
      ...listModuleDefs().map((d) => d.type as string),
      ...listVideoModuleDefs().map((d) => d.type as string),
      ...listMetaModuleDefs().map((d) => d.type as string),
    ];
    // After the manifest-driven rewrite of vrt.spec.ts, "in spec" =
    // "in the registry AND not in EXEMPT_FROM_VRT". The spec derives
    // its iteration list from exactly this rule — keeping the test in
    // lockstep means no module can slip through both gates.
    const missing: string[] = [];
    for (const t of registered) {
      if (EXEMPT_FROM_VRT[t]) continue;
      // Auto-enrollment via the manifest pass — module shows up in the
      // VRT spec the moment it's registered. The only way a module
      // ends up here as "missing" is if vrt-meta + vrt-exemptions
      // were edited out of sync (the spec ignores an EXEMPT_FROM_VRT
      // entry, or someone deleted EXEMPT_FROM_VRT without committing
      // the baselines). Either way, the message points the reader at
      // the exemption file.
      const baselineExists =
        existsSync(baselinePath(t, 'linux')) || existsSync(baselinePath(t, 'darwin'));
      if (!baselineExists) missing.push(t);
    }
    expect(
      missing,
      `register a baseline (\`task vrt:update\` on each platform) ` +
        `or add an EXEMPT_FROM_VRT entry in e2e/vrt/vrt-exemptions.ts for: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('every covered module has a baseline PNG on disk for every shipped platform', async () => {
    await import('$lib/audio/modules');
    await import('$lib/video/modules');
    await import('$lib/meta/modules');
    const registered = [
      ...listModuleDefs().map((d) => d.type as string),
      ...listVideoModuleDefs().map((d) => d.type as string),
      ...listMetaModuleDefs().map((d) => d.type as string),
    ];
    const missingBaseline: string[] = [];
    for (const t of registered) {
      if (EXEMPT_FROM_VRT[t]) continue;
      for (const platform of VRT_PLATFORMS) {
        const key = `${platform}/${t}`;
        if (EXEMPT_BASELINE_PAIRS.has(key)) continue;
        if (!existsSync(baselinePath(t, platform))) missingBaseline.push(key);
      }
    }
    expect(
      missingBaseline,
      `run \`task vrt:update\` on each platform to (re)generate baselines for: ${missingBaseline.join(', ')}`,
    ).toEqual([]);
  });

  it('every exempted module has a non-empty reason', () => {
    for (const [t, reason] of Object.entries(EXEMPT_FROM_VRT)) {
      expect(reason.length, `${t} exemption needs a reason`).toBeGreaterThan(10);
    }
  });

  it('every VRT_SCENES key is a registered module type (no drift)', async () => {
    await import('$lib/audio/modules');
    await import('$lib/video/modules');
    await import('$lib/meta/modules');
    const registered = new Set([
      ...listModuleDefs().map((d) => d.type as string),
      ...listVideoModuleDefs().map((d) => d.type as string),
      ...listMetaModuleDefs().map((d) => d.type as string),
    ]);
    for (const sceneType of Object.keys(VRT_SCENES)) {
      expect(
        registered.has(sceneType),
        `${sceneType} has a VRT scene but isn't a registered module`,
      ).toBe(true);
    }
  });

  it('VRT_SCENES module-under-test id is always "vrt-1" (matches vrt.spec.ts selector)', () => {
    for (const [type, scene] of Object.entries(VRT_SCENES)) {
      const hasVrt1 = scene.nodes.some((n) => n.id === 'vrt-1' && n.type === type);
      expect(hasVrt1, `${type}: scene.nodes must include {id:'vrt-1', type:'${type}'}`).toBe(true);
    }
  });

  // -------------------------------------------------------------------
  // STRICT_VRT_MODULES coverage — the deterministic subset is the gate
  // inside `task ci`. These invariants keep the gate honest:
  //   * a strict module MUST ship baselines on BOTH platforms (no
  //     EXEMPT_BASELINE_PAIRS entry on either side — promote-via-
  //     update-snapshots flow must capture both).
  //   * a strict module MUST NOT be in VRT_MODULE_MASKS (a mask means
  //     the canvas is non-deterministic; if we mask it the diff is no
  //     longer end-to-end semantic — covered by the full lane instead).
  //   * a strict module MUST NOT be in EXEMPT_FROM_VRT (can't both
  //     skip + gate).
  //   * a strict module MUST be a registered module (no drift).
  // -------------------------------------------------------------------
  it('every STRICT_VRT_MODULES entry has baselines on BOTH platforms', () => {
    const missing: string[] = [];
    for (const t of STRICT_VRT_MODULES) {
      for (const platform of VRT_PLATFORMS) {
        if (!existsSync(baselinePath(t, platform))) missing.push(`${platform}/${t}`);
      }
    }
    expect(
      missing,
      `STRICT_VRT_MODULES entries must have committed baselines on darwin + linux ` +
        `(strict lane runs cross-platform). Capture via \`task vrt:update\` on each platform: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('no STRICT_VRT_MODULES entry has a canvas mask (defeats the diff)', () => {
    const masked: string[] = [];
    for (const t of STRICT_VRT_MODULES) {
      if (t in VRT_MODULE_MASKS) masked.push(t);
    }
    expect(
      masked,
      `STRICT_VRT_MODULES entries with a VRT_MODULE_MASKS entry have a masked canvas region — ` +
        `the strict-lane diff would skip semantic content. Either remove the mask (the card is ` +
        `actually deterministic) or remove the module from STRICT_VRT_MODULES: ${masked.join(', ')}`,
    ).toEqual([]);
  });

  it('no STRICT_VRT_MODULES entry has a pending EXEMPT_BASELINE_PAIRS regen', () => {
    const pending: string[] = [];
    for (const t of STRICT_VRT_MODULES) {
      for (const platform of VRT_PLATFORMS) {
        const key = `${platform}/${t}`;
        if (EXEMPT_BASELINE_PAIRS.has(key)) pending.push(key);
      }
    }
    expect(
      pending,
      `STRICT_VRT_MODULES entries can't have a pending EXEMPT_BASELINE_PAIRS regen — ` +
        `the strict lane needs both baselines current. Capture the baseline + remove the pair, ` +
        `or remove the module from STRICT_VRT_MODULES: ${pending.join(', ')}`,
    ).toEqual([]);
  });

  it('no STRICT_VRT_MODULES entry is also in EXEMPT_FROM_VRT', () => {
    const conflict: string[] = [];
    for (const t of STRICT_VRT_MODULES) {
      if (EXEMPT_FROM_VRT[t]) conflict.push(t);
    }
    expect(
      conflict,
      `STRICT_VRT_MODULES + EXEMPT_FROM_VRT conflict (can't both skip + gate): ${conflict.join(', ')}`,
    ).toEqual([]);
  });

  it('every STRICT_VRT_MODULES entry is a registered module type', async () => {
    await import('$lib/audio/modules');
    await import('$lib/video/modules');
    await import('$lib/meta/modules');
    const registered = new Set([
      ...listModuleDefs().map((d) => d.type as string),
      ...listVideoModuleDefs().map((d) => d.type as string),
      ...listMetaModuleDefs().map((d) => d.type as string),
    ]);
    const ghosts: string[] = [];
    for (const t of STRICT_VRT_MODULES) {
      if (!registered.has(t)) ghosts.push(t);
    }
    expect(
      ghosts,
      `STRICT_VRT_MODULES entries not in the module registry (typo or unregistered module): ${ghosts.join(', ')}`,
    ).toEqual([]);
  });
});

describe('vrt-meta — STRICT_VRT_MODULES RATCHET (only grows)', () => {
  // STRICT_VRT_MODULES is an OPT-IN allowlist: the deterministic VRT cards
  // promoted into the required `task ci` strict lane (see vrt-exemptions.ts).
  // This cap FREEZES the set at today's size so it can only GROW — DEMOTING a
  // card (shrinking the strict gate) fails this test on purpose.
  //   RATCHET RULE: strict lists only grow. RAISE the number when you promote a
  //   card. Only LOWER it for a real, justified demotion (a card that flaked in
  //   CI) — NEVER to make a red gate go green.
  it('STRICT_VRT_MODULES never shrinks below its frozen floor', () => {
    // 25→29 (2026-06-29): the 4 CV-utility cards (Track-2 batch 1, #951).
    // 29→49 (2026-06-29): the 20-card MOOG cluster (Track-2 batch 2, #953) —
    // deterministic beige-faceplate cards, both-platform baselines validated.
    // 49→48 (2026-07-07): the 15-module deletion PR removed the one STRICT
    // member among them (negativity) — a real un-promotion via module
    // deletion, not a gate dodge.
    expect(
      STRICT_VRT_MODULES.size,
      'STRICT_VRT_MODULES shrank below its frozen floor — see the RATCHET rule above',
    ).toBeGreaterThanOrEqual(48);
  });
});

describe('vrt-meta — LINUX-baseline deficit RATCHET (only shrinks)', () => {
  // HONESTY GATE. CI runs on linux. A module that has only a darwin baseline +
  // a `linux/<m>` entry in EXEMPT_BASELINE_PAIRS is rendered on darwin only and
  // is SKIPPED on CI (vrt.spec.ts) — so it NEVER actually diffs on the platform
  // that gates. The either-platform "covered" check above therefore OVERSTATES
  // real CI protection by exactly this count: the linux deficit is the gap
  // between "looks covered" and "actually gated".
  //
  // This ceiling makes the deficit visible + ratchets it toward ZERO: it may
  // only SHRINK. LOWER the number when you land linux baselines (capture via
  // `vrt-update.yml` + drop the pairs). Only RAISE it for a DELIBERATE,
  // commented darwin-first new module — NEVER to make a red gate go green.
  // (Mirrors the STRICT_VRT_MODULES ratchet above, inverted: that floor only
  // grows, this ceiling only shrinks; both converge on full linux coverage.)
  // Most deferrals are `linux/*` (darwin-first authoring); a handful of
  // `darwin/*` deferrals exist for scene-variant captures + a module whose
  // linux baseline already gates. The CI-protection metric is the LINUX count:
  // CI runs on linux, so a linux-pending module never diffs on the gating
  // platform — that count is the gap between "looks covered" and "actually
  // gated". This ceiling ratchets it toward ZERO.
  it('the linux-baseline deficit only shrinks toward zero', () => {
    const linuxPending = [...EXEMPT_BASELINE_PAIRS].filter((p) => p.startsWith('linux/')).length;
    expect(
      linuxPending,
      'the linux-baseline deficit GREW. CI is linux, so a linux-pending module is never ' +
        'actually diffed on CI — landing fewer linux baselines is a real coverage regression. ' +
        'Capture linux baselines (vrt-update.yml workflow_dispatch) + drop the pairs to LOWER ' +
        'this number; only RAISE it for a deliberate, commented darwin-first new module.',
      // 98→99 for NINE LIVES (2026-06-28, deliberate darwin-first 9-output LFO).
      // 99→95 (2026-06-29): CV-util batch linux baselines (Track-2 batch 1).
      // 95→75 (2026-06-29): the 20-card MOOG cluster linux baselines (Track-2
      // batch 2) — deterministic beige-faceplate cards, captured on linux CI.
      // 75→76 for KICK DRUM (2026-07-02, deliberate darwin-first new module —
      // linux baseline pending the vrt-update.yml dispatch on the PR branch).
      // 76→81 for COLOUR OF MAGIC (2026-07-03, deliberate darwin-first new
      // module — 6 per-block composite VRT scenes com-pass/rgb/ydbdr/hsv/
      // override/palette; linux baselines pending the vrt-update.yml dispatch
      // on the PR branch).
      // 81→84 for the COLOUR OF MAGIC colorspace expansion (2026-07-04,
      // deliberate darwin-first — +3 new scenes com-yiq/com-ycc/com-yiq-i-tap
      // for the YIQ + YCbCr studio-swing blocks + a mono tap; linux baselines
      // pending the vrt-update.yml dispatch on the PR branch).
      // 84→85 for SNARE DRUM (2026-07-04, deliberate darwin-first new module —
      // the wide 3u banded snare-voice card; linux baseline pending the
      // vrt-update.yml dispatch on the PR branch).
      // 85→87 for TOYBOX birds + FLIGHTY (2026-07-04, deliberate darwin-first —
      // +2 toybox VRT scenes preset-flighty (the CC0 bird flapping over the
      // animated flighty-sky GEN) + obj-bird-ernest (the bird OBJ per-model
      // baseline); linux baselines pending the vrt-update.yml dispatch, same
      // darwin-first precedent as every other linux/toybox-* pair).
      // 87→88 for DOCKSCOPE (2026-07-11, deliberate darwin-first new module —
      // workflow P2.5b's slim 1u rail scope with the seeded VRT scene; linux
      // baseline pending the vrt-update.yml dispatch on the PR branch).
      // 88→89 for TOM DRUM (2026-07-11, deliberate darwin-first new module —
      // the compact MEMBRANE·COLOR·OUT tom-voice card; linux baseline pending
      // the vrt-update.yml dispatch on the PR branch).
      // 89→90 for KARPLUS (2026-07-11, deliberate darwin-first new module —
      // the extended Karplus-Strong string-voice card; linux baseline pending
      // the vrt-update.yml dispatch on the PR branch).
      // 90→94 for CLAP (2026-07-11, deliberate darwin-first new module — the
      // compact BURST·NOISE·ROOM/OUT clap-voice card + 3 composite-state
      // scenes (clap-909-dense / clap-linn-room / clap-dry-snap in
      // vrt-clap.spec.ts); linux baselines pending the vrt-update.yml
      // dispatch on the PR branch).
      // 94→100 for the KARPLUS + TOM DRUM composite-state scenes (2026-07-11,
      // deliberate darwin-first — 6 non-default-state card scenes in
      // vrt-karplus-tomtom-states.spec.ts, the sonic-audit coverage gap-fill;
      // linux baselines pending the vrt-update.yml dispatch on the PR
      // branch, same precedent as the COLOUR OF MAGIC scene batches).
      // 100→87 DRAIN (2026-07-11): the whole drum-wave pending set —
      // dockscope + karplus + tomtom + clap default cards, clap's 3
      // composite scenes, and the 6 karplus/tomtom sonic-audit scenes —
      // got real linux baselines via a single vrt-update.yml dispatch on
      // this branch, so their 13 exemption pairs came out.
      // 87→90 for the CELLSHADE rebuild composite scenes (2026-07-11,
      // deliberate darwin-first — 3 UNMASKED frozen scenes
      // cellshade-bands/cellshade-ink/cellshade-smooth in
      // cellshade-composite.spec.ts, the new 4-pass engine's canvas
      // regression gate; linux baselines pending the vrt-update.yml
      // dispatch on the PR branch, same precedent as the COLOUR OF MAGIC
      // scene batches).
      // 90→92 for the WORKFLOW audio-UX composite scenes (2026-07-11,
      // deliberate darwin-first — the OPEN 🎧 audio-I/O panel
      // (workflow-audio-io-composite.spec.ts, device text masked) + the
      // bottom dock drawer with the patch-to picker open
      // (workflow-dock-composite.spec.ts, menu position pinned) — the
      // owner's "this should have been caught with vrt" coverage; linux
      // baselines pending the vrt-update.yml dispatch on the PR branch).
          // 92→96 for POSTERBOX (2026-07-11, deliberate darwin-first new module —
      // the retro palette-crush video card + 3 composite-state scenes
      // (posterbox-brutal-1bit / posterbox-dither-hatch / posterbox-subtle-565
      // in vrt-posterbox-states.spec.ts); linux baselines pending the
      // vrt-update.yml dispatch on the PR branch).
          // 96→100 for TIDY VCO (2026-07-11, deliberate darwin-first new
      // module — the flagship VA subtractive voice card + its 3
      // composite-state scenes (tidyvco-acid / tidyvco-pad / tidyvco-bass
      // in vrt-tidy-vco.spec.ts); linux baselines pending the
      // vrt-update.yml dispatch on the PR branch, the karplus/clap
      // drum-wave precedent).
      // 100→104 for MIRRORPOOL (2026-07-15, deliberate darwin-first new
      // video module HELD for owner preview — its solo card + the 3
      // deterministic composite scenes (mirrorpool-refract / -mirror / -storm
      // in mirrorpool-composite.spec.ts); linux baselines land via
      // vrt-update.yml once the owner approves the look.
    ).toBeLessThanOrEqual(104);
  });
});

describe('vrt-meta — STALE EXEMPT_BASELINE_PAIRS RATCHET (only shrinks)', () => {
  // HYGIENE GATE for the OTHER rot direction. An EXEMPT_BASELINE_PAIRS entry
  // means "baseline PENDING — vrt.spec.ts SKIPS this card on this platform". But
  // a pair often outlives its reason: the baseline lands (e.g. a `vrt-update.yml`
  // CI dispatch commits it) yet nobody removes the pair, so the card stays
  // SKIPPED on that platform DESPITE a committed baseline — silent coverage loss.
  // (This is distinct from EXEMPT_FROM_VRT, which skips a card ENTIRELY on
  // purpose, with a reason; a "pending" pair whose baseline exists is just rot.)
  //
  // We detect a pair as STALE when its vrt.spec.ts baseline PNG exists on disk.
  // (Composite/scope SCENE pairs store baselines under a different spec dir, so
  // they have no vrt.spec.ts path and are never counted here — this ratchet only
  // governs plain module-card pairs, the unambiguous case.) `task vrt:audit`
  // prints the full classified list for the cleanup pass.
  //
  // This ceiling makes the rot visible + ratchets it toward ZERO: it may only
  // SHRINK. LOWER the number when you drop a stale pair (after confirming the
  // committed baseline still matches the render — else `task vrt:commit` to
  // regenerate first). Re-introducing a pair for a card that already has a
  // baseline RAISES it → fails. Mirrors the deficit ratchet above, inverted.
  it('the stale-exemption count (pair listed but baseline already exists) only shrinks', () => {
    const stale = [...EXEMPT_BASELINE_PAIRS]
      .filter((p) => {
        const [platform, type] = p.split('/');
        return existsSync(baselinePath(type, platform));
      })
      .sort();
    expect(
      stale.length,
      `EXEMPT_BASELINE_PAIRS lists pairs whose vrt.spec.ts baseline ALREADY exists — the ` +
        `card is SKIPPED on that platform despite a committed baseline (silent coverage ` +
        `loss). Drop the stale pair(s) to LOWER this ceiling (see \`task vrt:audit\`): ` +
        `${stale.join(', ')}`,
      // Frozen at today's debt (2026-06-30). Drive it to 0 by reconciling each
      // pair: confirm the committed baseline matches the current render, then
      // remove the pair from EXEMPT_BASELINE_PAIRS and lower this number.
    ).toBeLessThanOrEqual(18);
  });
});
