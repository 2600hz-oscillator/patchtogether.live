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
//
// ⚠ EXEMPT_BASELINE_PAIRS is NOT the only way a scene goes dark on a platform
// — it is one of FOUR (2026-08-01). The LINUX-DEFICIT ratchet near the bottom
// of this file therefore reads e2e/vrt/vrt-platform-gaps.ts, which enumerates
// all four and anchors the count to the committed PNGs rather than to any
// list. Read that file's header before adding a gate here that reasons about
// platform coverage from a single list; the previous one under-reported the
// deficit by 41 % and nothing failed.

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
  ALLOWED_PERMANENT_EXEMPT,
  EXEMPT_BASELINE_PAIRS,
  STRICT_VRT_MODULES,
  VRT_MODULE_MASKS,
} from '../../../../../../e2e/vrt/vrt-exemptions';
import { VRT_SCENES } from '../../../../../../e2e/vrt/vrt-scenes';
import { VRT_LIVE_SURFACES } from '../../../../../../e2e/vrt/vrt-live-surfaces';
// The FOUR platform-gap declaration mechanisms, enumerated in one place.
// Reading only EXEMPT_BASELINE_PAIRS (as this file used to) sees 89 of 151.
import {
  assertBaselineTreeIsReadable,
  assertParsersSeeSomething,
  collectLinuxGapReport,
  committedBaselineKeys,
} from '../../../../../../e2e/vrt/vrt-platform-gaps';

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
    // BOTH mask tables, deliberately. This check used to read only
    // VRT_MODULE_MASKS; once masks could also come from the live-surface
    // registry (e2e/vrt/vrt-live-surfaces.ts) that made it a gate reading one
    // side of a two-sided contract — a strict module could be masked via the
    // registry and this test would have stayed green. Every source of masking
    // has to be enumerated here or the invariant is fiction.
    const masked: string[] = [];
    for (const t of STRICT_VRT_MODULES) {
      if (t in VRT_MODULE_MASKS) masked.push(`${t} (VRT_MODULE_MASKS)`);
      if (t in VRT_LIVE_SURFACES) masked.push(`${t} (VRT_LIVE_SURFACES)`);
    }
    expect(
      masked,
      `STRICT_VRT_MODULES entries with a mask entry have a masked region — the strict-lane ` +
        `diff would skip semantic content. Either remove the mask (the card is actually ` +
        `deterministic) or remove the module from STRICT_VRT_MODULES: ${masked.join(', ')}`,
    ).toEqual([]);
  });

  it('...and that check can actually SEE a registry mask (negative control)', () => {
    // Guard the guard. The test above passes when nothing is masked, which is
    // also what it would do if the VRT_LIVE_SURFACES half were dropped in a
    // refactor. Run the same predicate over a synthetic strict set that DOES
    // contain a registry-masked module and require it to flag it.
    const registryMasked = Object.keys(VRT_LIVE_SURFACES);
    expect(
      registryMasked.length,
      'the live-surface registry is empty, so this control proves nothing',
    ).toBeGreaterThan(0);
    const syntheticStrict = new Set<string>([registryMasked[0]]);
    const flagged = [...syntheticStrict].filter(
      (t) => t in VRT_MODULE_MASKS || t in VRT_LIVE_SURFACES,
    );
    expect(flagged).toEqual([registryMasked[0]]);
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

/**
 * THE PERMANENT-EXEMPT CEILING. Frozen at the 81 entries that existed when the
 * brake landed (2026-08-04). Asserted in BOTH directions, like every other
 * ratchet in this file: a ceiling can only trip by GROWING, so a drain that
 * forgets to lower the number passes in total silence and leaves slack for the
 * next regression to hide in.
 *
 * LOWER this by exactly the number of modules you drain out of
 * EXEMPT_FROM_VRT + ALLOWED_PERMANENT_EXEMPT, in the SAME commit. NEVER raise
 * it to make a red gate green — a new module needing an exemption is a
 * reviewed decision, and raising the ceiling is how you record having made it.
 */
const PERMANENT_EXEMPT_CEILING = 81;

describe('vrt-meta — EXEMPT_FROM_VRT is DENY-BY-DEFAULT (frozen allowlist)', () => {
  // EXEMPT_FROM_VRT used to be a pure OPT-OUT: any module could remove itself
  // from visual coverage by adding a key with a >10-char reason. That gate
  // proved the string was long, never that skipping was justified — so the list
  // grew 76 → 81 with nothing able to notice. These four assertions are the
  // brake the vrt-zero-exemptions campaign always assumed existed.

  it('every exempted module is on the frozen allowlist (a new module CANNOT self-exempt)', () => {
    const unlisted = Object.keys(EXEMPT_FROM_VRT).filter((t) => !ALLOWED_PERMANENT_EXEMPT.has(t));
    expect(
      unlisted,
      `these modules exempted themselves from VRT without an allowlist entry: ${unlisted.join(', ')}.\n` +
        'Shipping a module with NO visual coverage is a reviewed decision. Either give it a ' +
        'VRT baseline (the strongly preferred path — see vrt-update.yml), or add it to ' +
        'ALLOWED_PERMANENT_EXEMPT in e2e/vrt/vrt-exemptions.ts AND raise ' +
        'PERMANENT_EXEMPT_CEILING, so the exemption shows up in review.',
    ).toEqual([]);
  });

  it('no allowlist entry is STALE (anchored to the artifact, not the list)', () => {
    // A drained module must not leave a licence to silently re-exempt itself.
    const stale = [...ALLOWED_PERMANENT_EXEMPT].filter((t) => !(t in EXEMPT_FROM_VRT));
    expect(
      stale,
      `ALLOWED_PERMANENT_EXEMPT names modules that are no longer in EXEMPT_FROM_VRT: ${stale.join(', ')}. ` +
        'Delete them from the allowlist and lower PERMANENT_EXEMPT_CEILING by the same count.',
    ).toEqual([]);
  });

  it('the exemption count only SHRINKS — and the ceiling has no slack', () => {
    const actual = Object.keys(EXEMPT_FROM_VRT).length;
    expect(
      actual,
      `EXEMPT_FROM_VRT grew to ${actual} over a ceiling of ${PERMANENT_EXEMPT_CEILING} — see the RATCHET rule`,
    ).toBeLessThanOrEqual(PERMANENT_EXEMPT_CEILING);
    expect(
      PERMANENT_EXEMPT_CEILING - actual,
      `THE PERMANENT-EXEMPT CEILING HAS GONE SLACK: ${actual} exemption(s) under a ceiling of ` +
        `${PERMANENT_EXEMPT_CEILING}. Modules were drained and the number was not lowered, so ` +
        `${PERMANENT_EXEMPT_CEILING - actual} new module(s) can now self-exempt for free. ` +
        `Lower PERMANENT_EXEMPT_CEILING to ${actual}.`,
    ).toBe(0);
  });

  it('...and that check can actually SEE an unlisted exemption (negative control)', () => {
    // Guard against the gate silently reading an empty/short-circuited set —
    // the exact "green gate that checked nothing" failure this brake exists for.
    const syntheticExempt = { ...EXEMPT_FROM_VRT, someBrandNewModule: 'a plausible-looking ten-plus-character reason' };
    const unlisted = Object.keys(syntheticExempt).filter((t) => !ALLOWED_PERMANENT_EXEMPT.has(t));
    expect(unlisted).toEqual(['someBrandNewModule']);
    // ...and the stale check must see a phantom allowlist entry too.
    const syntheticAllow = new Set([...ALLOWED_PERMANENT_EXEMPT, 'aModuleThatWasDrained']);
    const stale = [...syntheticAllow].filter((t) => !(t in EXEMPT_FROM_VRT));
    expect(stale).toEqual(['aModuleThatWasDrained']);
  });

  it('the allowlist is non-empty and matches the live list exactly (no drift in either direction)', () => {
    expect(ALLOWED_PERMANENT_EXEMPT.size).toBeGreaterThan(0);
    expect([...ALLOWED_PERMANENT_EXEMPT].sort()).toEqual(Object.keys(EXEMPT_FROM_VRT).sort());
  });
});

/**
 * Shared `linux/*` pair budget. Asserted BOTH ways — see LINUX_DEFICIT_CEILING.
 *
 * 104 → 94 (2026-08-01): the 10 misnamed `linux/toybox-*` entries were DELETED
 * (no such scene stem exists; vrt-toybox.spec.ts does not even import the Set —
 * see the note in vrt-exemptions.ts). Found by the both-directions assertion
 * below the moment the entries went: under a bare `<=` ceiling this cleanup
 * would have left 10 counts of slack and said nothing.
 *
 * 94 → 93 (2026-08-02): `linux/ringback` DRAINED with the ringback face
 * promotion, whose PR dispatches `vrt-update.yml -f platform=linux` for its two
 * new `face-ringback-*` scenes and picks the card scene up in the same run.
 *
 * 93 → 91 (2026-08-02, the snaredrum face PR): `linux/face-snaredrum-compact`
 * and `linux/face-snaredrum-dock` drained so a `vrt-update.yml -f
 * platform=linux` dispatch on that branch could capture them (a listed pair is
 * skipped unconditionally, and a skipped test writes no snapshot). Drain and
 * re-capture in the SAME PR — a drain without its dispatch ships a red lane.
 * ⚠ This is the SUM of two independent drains that landed the same day
 * (ringback −1, snaredrum −2), not either branch's own −2 on top of 94 —
 * the merge is where that arithmetic has to be done, and the both-directions
 * assertion below is what refuses a guess.
 */
// FACE BATCH 3 (2026-08-03): 97 → 91, DRAINED. The six darwin-first pairs added
// by that batch — the compact + dock face scenes for clap, drummergirl and
// pentemelodica, the three modules PROMOTED in it — came back OUT of
// EXEMPT_BASELINE_PAIRS in the same commit as this number, so that a
// `vrt-update.yml -f platform=linux` dispatch on this branch could capture
// them at all (a listed pair is skipped unconditionally and a skipped test
// writes no snapshot). This ceiling is LIST-anchored, so it drops the instant
// those 6 lines go — unlike LINUX_DEFICIT_CEILING below, which is
// ARTIFACT-anchored and only falls when the PNGs actually land.
// (sixstrum's face RE-DO needed no new pair: its two linux entries have been
// listed since batch 2 and stay listed.)
const SHARED_LINUX_PAIR_CEILING = 91;

describe('vrt-meta — EXEMPT_BASELINE_PAIRS size RATCHET (only shrinks)', () => {
  // ⚠ 2026-08-01 — READ THIS BEFORE TRUSTING THE NUMBER BELOW.
  //
  // This ceiling counts ONE declaration mechanism: `linux/*` strings in the
  // SHARED EXEMPT_BASELINE_PAIRS Set. It used to be described as "the linux
  // deficit". It is NOT, and calling it that is what let 62 dark scenes hide
  // for months. Measured on `main` @ 77cd1bbc:
  //
  //   real deficit (a darwin PNG with no linux sibling)   151
  //   this Set explains                                    89   (59 %)
  //   the OTHER THREE mechanisms explain                   62   (41 %)
  //
  // …and the number this test printed was 119 — neither 151 nor 89 — because
  // 30 of its entries named scenes that are not gaps at all (15 whose linux PNG
  // was already committed, 15 with no PNG on either platform). A count of
  // DECLARATIONS was being read as a count of GAPS. It was wrong in both
  // directions simultaneously, which is the signature of a metric measuring the
  // wrong quantity rather than measuring it badly.
  //
  // The REAL deficit ratchet is the describe block below, which reads all four
  // mechanisms off `e2e/vrt/vrt-platform-gaps.ts`. This one survives as a
  // narrower LIST-HYGIENE ratchet: the shared Set may not grow. Keep both —
  // they fail on different things (this on list rot, that on coverage rot).
  it('the shared EXEMPT_BASELINE_PAIRS linux entry count only shrinks', () => {
    const linuxPending = [...EXEMPT_BASELINE_PAIRS].filter((p) => p.startsWith('linux/')).length;
    expect(
      linuxPending,
      'the shared EXEMPT_BASELINE_PAIRS linux list GREW. Each entry skips a card on the ' +
        'platform CI gates on. Capture linux baselines (vrt-update.yml workflow_dispatch, ' +
        'UNSCOPED) + drop the pairs to LOWER this number; only RAISE it for a deliberate, ' +
        'commented darwin-first new module. NOTE: this is ONE of FOUR mechanisms — it is ' +
        'NOT the deficit. See the linux-deficit ratchet below + e2e/vrt/vrt-platform-gaps.ts.',
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
      // 104→107 for the WORKFLOW `?shell=1` ZOOM scenes (2026-07-25,
      // deliberate darwin-first — the same framed RACKLINE rack region pinned
      // at zoom 0.40/0.80/1.30 in workflow-shell-zoom.spec.ts, the pixel gate
      // for the owner-reported zoom-reposition bug; linux baselines pending
      // the vrt-update.yml dispatch on the PR branch, the
      // workflow-dock-composite precedent).
      // 107→119 for the P1 BATCH-1 CURATED FACES (2026-07-25, deliberate
      // darwin-first — per migrated module (adsr/cloudseed/kickdrum/lfo/
      // tidyVco/vca) the compact lane tile + the dock full-view faceplate
      // under `?shell=1` in workflow-shell-faces.spec.ts; linux baselines
      // pending the vrt-update.yml dispatch on the PR branch, the
      // workflow-shell-zoom precedent).
      // 119→121 for the REAR CARD scenes (2026-07-25, deliberate darwin-first
      // — the dock full-view's TAB flip-side jack field for the busiest +
      // simplest prototypes (rear-tidyVco / rear-vca in
      // workflow-rear-card.spec.ts); linux baselines pending the
      // vrt-update.yml dispatch on the PR branch, the workflow-shell-faces
      // precedent).
      // 121→104 DRAIN (2026-07-26): the whole `?shell=1` WORKFLOW-SHELL
      // pending set — the 3 zoom scenes, the 12 P1 batch-1 curated faces
      // (compact + dock per migrated module) and the 2 rear-card scenes —
      // got real linux baselines via a single vrt-update.yml dispatch
      // (platform=linux) on this branch, so their 17 exemption pairs came
      // out (the #1064 drum-wave drain precedent: drop the pairs FIRST, then
      // dispatch, because the pending-pair skip is unconditional and
      // `--update-snapshots` writes nothing for a skipped test).
      // 104→118 for P1 BATCH 2 (2026-07-26, deliberate darwin-first — the
      // SAME lifecycle batch 1 just completed, entering at its start): 12
      // curated-face scenes for the six newly-migrated modules (compact +
      // dock per module) + 2 new rear-card scenes (rear-dx7, rear-sixstrum).
      // darwin baselines captured locally and flake-checked 3× (42/42 clean);
      // a vrt-update.yml `platform=linux` dispatch on this branch drains the
      // 14 pairs and brings this back to 104.
      // 118→128 for P1 BATCH 3 (2026-07-26, deliberate darwin-first — the SAME
      // lifecycle, entering at its start): 10 curated-face scenes for the five
      // newly-migrated modules (compact + dock per module) — karplus, filter,
      // mixer, delay, reverb. This is the SUM of the five module branches'
      // independent +2s on top of batch 2's landed 118, NOT any one branch's
      // 104→106. darwin baselines captured locally and flake-checked 3×; a
      // vrt-update.yml `platform=linux` dispatch on this branch drains the 10
      // pairs and brings this back to 118.
      // 128→118 DRAIN (2026-07-26): the batch-3 pending set — the 10 curated
      // face scenes (compact + dock for karplus/filter/mixer/delay/reverb) —
      // had its pairs REMOVED so a single vrt-update.yml `platform=linux`
      // dispatch on this branch captures them (the skip is unconditional, so
      // drain-then-dispatch; the batch-1/2 precedent).
      // 118→119 for the CLIP-PLAYER-AS-A-DOCK-PANE split scene (2026-07-26,
      // deliberate darwin-first — ONE new scene, workflow-dock-clip-split:
      // the owner's "clip player open along side a module in drawer" as a
      // 50/50 pixel gate in workflow-dock-composite.spec.ts). darwin baseline
      // captured locally and flake-checked 3×; a vrt-update.yml
      // `platform=linux` dispatch on this branch drains the pair and brings
      // this back to 118. (The pre-existing linux/workflow-dock-patch pair is
      // unchanged — that scene's darwin baseline was RE-captured in place
      // because `c` now opens the clip player as a pane, not a drawer.)
      // PF-8, the DOCK LANE-RAIL REMOVAL (2026-07-27), holds this at 119 — it
      // does NOT move the ceiling in either direction. The migrated shell
      // stopped painting a duplicate jack rail inside the dock faceplate,
      // which moves FIVE dock scenes: the ones whose content does NOT overflow
      // the 425px faceplate cap, so the rail was actually inside the element
      // screenshot (adsr, delay, mixer, reverb, vca). The other twelve render
      // it below the fold and are pixel-identical (measured overflow + a full
      // darwin VRT run, see vrt-exemptions.ts).
      //
      // BOTH platforms' baselines for those five are re-captured on this
      // branch — darwin locally, linux via one vrt-update.yml dispatch — so
      // none of them is parked. Parking them would have pushed this ceiling
      // 119→124, and THIS RATCHET ONLY SHRINKS. A scene whose linux baseline
      // one dispatch regenerates is a re-capture, not a platform deficit;
      // letting a re-capture inflate the ceiling is how these ceilings rot.
      //
      // 119→104 DRAIN (2026-08-01): the 15 pairs whose linux baseline was
      // ALREADY COMMITTED under __screenshots__/vrt.spec.ts/linux/ — the pair
      // is consulted before the PNG, so each one skipped a card the repo had
      // already paid to capture (macrooscillator, samsloop, scope, videoOut,
      // audioOut, analogVco, lfo, feedback, lines, monoglitch, shapedramps,
      // unityscalemathematik, vdelay, warrenspectrum, timelorde). It was also a
      // deadlock: `--update-snapshots` writes nothing for a skipped test, so the
      // "re-capture then remove the pair" plan three of them are waiting on
      // could never run while the pair was listed. The TOTAL deficit does NOT
      // move (151 → 151): a pair whose PNG exists was never part of it.
    ).toBeLessThanOrEqual(SHARED_LINUX_PAIR_CEILING);
    expect(
      SHARED_LINUX_PAIR_CEILING - linuxPending,
      `THE SHARED-PAIR CEILING HAS GONE SLACK: ${linuxPending} linux pair(s) under a ceiling of ` +
        `${SHARED_LINUX_PAIR_CEILING}. Pairs were drained and the number was not lowered, so ` +
        `${SHARED_LINUX_PAIR_CEILING - linuxPending} new darwin-first exemption(s) can now be ` +
        `added without anything going red. Set it to ${linuxPending}.`,
    ).toBe(0);
  });
});

/**
 * THE LINUX-DEFICIT CEILING — and it is asserted in BOTH directions.
 *
 * A ceiling can only ever trip by GROWING. That makes the complementary
 * failure — a PR that closes gaps and forgets to lower the number — completely
 * silent, and it leaves exactly that much slack for the next regression to
 * hide in. Every ratchet in this file now pairs `<= CEILING` with
 * `CEILING - actual === 0`, so a drain that does not re-pin the constant is as
 * red as a regression. Change this number in the same commit that moves the
 * baselines, never on its own.
 */
// 151 → 150 (2026-08-02, ringback face promotion). NET of two movements that
// happen in ONE commit and must be read together, because either alone looks
// wrong: the promotion ADDS two darwin-first scenes (face-ringback-compact /
// -dock, +2) and DRAINS `linux/ringback` (−1), and the PR's
// `vrt-update.yml -f platform=linux` dispatch captures all THREE — so the
// steady state is 151 − 1 = 150. ⚠ Between the branch push and the bot's
// baseline commit this test is RED at 153 by construction (three darwin PNGs
// with no linux sibling and nothing declaring them); that window is the
// documented drain-then-dispatch flow, not a slack ceiling.
//
// 150 → 148 (2026-08-02, the snaredrum face PR): `face-snaredrum-compact` and
// `face-snaredrum-dock` got real linux baselines from a `vrt-update.yml -f
// platform=linux` dispatch on that branch (run 30737945839), so two darwin-only
// scenes stopped being darwin-only. ⚠ SUM, not substitution: ringback's −1
// and snaredrum's −2 are independent drains that landed the same day, and
// taking either branch's literal would leave the other's slack behind.
// FACE BATCH 3 (2026-08-03): 154 → 148, the DRAIN half of the same six scenes
// as the shared-pair ceiling above (clap / drummergirl / pentemelodica, compact
// + dock). ⚠ Unlike that one, this ceiling is ARTIFACT-anchored: ground truth
// is "a darwin PNG with no linux sibling", so removing the six pairs from
// EXEMPT_BASELINE_PAIRS does NOT by itself move `report.total` — the six stay
// real gaps until the `vrt-update.yml -f platform=linux` dispatch on this
// branch actually commits their linux PNGs, at which point total falls 154 → 148
// and meets this number exactly. The interval between the drain push and that
// capture is the known-red window CLAUDE.md names ("a drain without its
// re-capture ships a red lane"); it closes inside this same PR. If this gate is
// red with 6 UNDECLARED gaps named clap/drummergirl/pentemelodica, the dispatch
// has not landed yet — that is the expected reading, not a reason to raise the
// number back.
const LINUX_DEFICIT_CEILING = 148;

describe('vrt-meta — LINUX-baseline DEFICIT RATCHET (all four mechanisms)', () => {
  // THE HONESTY GATE. CI renders on LINUX. A scene captured on darwin but
  // skipped on linux contributes ZERO protection on the platform that gates,
  // while still counting as "covered" in every either-platform check above.
  //
  // Ground truth is ON DISK — a darwin PNG with no linux sibling — and the four
  // declaration mechanisms are then required to EXPLAIN each gap. That
  // inversion is the fix: the printed number cannot drift from the baselines,
  // an undeclared gap fails loudly, and a dead declaration is reported rather
  // than silently inflating the count. Mechanisms + how each is read:
  // e2e/vrt/vrt-platform-gaps.ts.
  //
  // RATCHET RULE: this ceiling only SHRINKS. LOWER it when a `vrt-update.yml
  // -f platform=linux` dispatch lands baselines (drain the pending pairs
  // FIRST — a skipped test writes no snapshot). Only RAISE it for a
  // DELIBERATE, commented darwin-first scene — NEVER to make a red gate green.
  it('the linux-baseline deficit only shrinks toward zero', () => {
    // ⚠ EVERY assertion in this describe is derived from `__screenshots__`.
    // With that tree unreadable the report is `total = 0, undeclared = []` and
    // all of them PASS — measured. `assertBaselineTreeIsReadable()` throws
    // first so the ratchet cannot skip-pass on a partial checkout.
    assertBaselineTreeIsReadable();
    const report = collectLinuxGapReport();
    expect(
      report.total,
      report.format(
        'THE LINUX-BASELINE DEFICIT GREW — more scenes are now captured on darwin ' +
          'and never diffed on linux, which is where CI gates.',
      ),
      // 151 measured 2026-08-01 on `main` @ 77cd1bbc, the FIRST honest reading:
      // 280 darwin baselines vs 129 linux. The predecessor ratchet reported 119
      // while counting only the shared-pairs mechanism (89 real gaps + 30
      // non-gaps), so this is not a regression from 119 — it is the first time
      // the quantity was measured at all. Breakdown at the freeze:
      //   89  shared-pairs
      //   49  hardcoded-platform-skip  (27 of them vrt-toybox.spec.ts)
      //   10  spec-local-pairs         (dashboard/groups/interactions/landing)
      //    3  scene-darwin-only        (vco-scope-audio-trace, adsr-sustain-*)
      //    0  UNDECLARED
      //
      // 151 → 149 (2026-08-02, the snaredrum face PR): `face-snaredrum-compact`
      // and `face-snaredrum-dock` got real linux baselines from a
      // `vrt-update.yml -f platform=linux` dispatch on that branch, so two
      // darwin-only scenes stopped being darwin-only. ⚠ The pairs were removed
      // FIRST (a listed pair is skipped, and a skipped test writes no
      // snapshot) — which means this number and the dispatch have to land in
      // the SAME PR, or the branch ships with two UNDECLARED gaps.
    ).toBeLessThanOrEqual(LINUX_DEFICIT_CEILING);
    // …AND THE OTHER DIRECTION, which a ceiling structurally cannot see.
    // `<=` only trips on GROWTH. A PR that CLOSES gaps — the whole point of
    // the ratchet — leaves a slack ceiling behind, silently, and the next
    // regression is absorbed by that slack instead of failing. CLAUDE.md's
    // drain procedure says "lower the ceiling by the same count" and nothing
    // enforced it, so the instruction was advisory. Now it is not.
    expect(
      LINUX_DEFICIT_CEILING - report.total,
      `THE CEILING HAS GONE SLACK: ${report.total} real gap(s) under a ceiling of ` +
        `${LINUX_DEFICIT_CEILING}. Somebody captured linux baselines (good) and did not lower ` +
        `LINUX_DEFICIT_CEILING by the same count (not good) — the ratchet now tolerates ` +
        `${LINUX_DEFICIT_CEILING - report.total} new dark scene(s) without a word. Set it to ` +
        `${report.total}.`,
    ).toBe(0);
  });

  it('every linux gap is DECLARED by one of the four mechanisms', () => {
    // A gap nobody declares is the worst kind: a scene silently dark on the
    // gating platform with no comment, no pair and no reason. Zero today —
    // keep it zero. If this fires, either add the declaration or (better)
    // capture the linux baseline.
    assertBaselineTreeIsReadable();
    const report = collectLinuxGapReport();
    expect(
      report.undeclared.map((g) => `${g.spec}/${g.scene}`),
      report.format('UNDECLARED linux gap(s) — a scene goes dark on linux with nothing saying so.'),
    ).toEqual([]);
  });

  it('a spec declared linux-dark ships NO linux baseline (the skip must not lie)', () => {
    // `test.skip(VRT_PLATFORM === 'linux', …)` is a blanket, list-free skip: it
    // takes the WHOLE spec dark. If such a spec also ships a linux baseline,
    // that PNG is dead weight and the blanket skip is stale — the two sides of
    // the contract disagree and only this check reads both.
    assertBaselineTreeIsReadable();
    const report = collectLinuxGapReport();
    expect(
      report.contradictoryDarkSpecs,
      "spec(s) with a blanket `test.skip(VRT_PLATFORM === 'linux', …)` that nonetheless ship a " +
        'committed linux baseline. The baseline is never compared. Either narrow the skip so ' +
        'those scenes run on linux, or delete the dead PNG.',
    ).toEqual([]);
  });

  it('the SOURCE-SCANNED mechanisms actually see something (instrument control)', () => {
    // Two of the four mechanisms live in Playwright spec sources and can only
    // be read as TEXT (importing a spec executes `test.describe()` outside the
    // runner and throws). A regex that drifts from the source returns a clean,
    // plausible EMPTY set and the deficit silently under-reports. Fail loudly
    // instead — including on the happy day the mechanism is genuinely gone, so
    // somebody deletes the parser deliberately.
    const seen = assertParsersSeeSomething();
    expect(seen.local, 'spec-local EXEMPT_BASELINE_PAIRS entries found').toBeGreaterThan(0);
    expect(seen.dark, 'specs with a blanket linux skip found').toBeGreaterThan(0);
  });
});

/** Stale-pair budget. Asserted in BOTH directions — see LINUX_DEFICIT_CEILING. */
const STALE_PAIR_CEILING = 4;

describe('vrt-meta — STALE EXEMPT_BASELINE_PAIRS RATCHET (only shrinks)', () => {
  // HYGIENE GATE for the OTHER rot direction. An EXEMPT_BASELINE_PAIRS entry
  // means "baseline PENDING — vrt.spec.ts SKIPS this card on this platform". But
  // a pair often outlives its reason: the baseline lands (e.g. a `vrt-update.yml`
  // CI dispatch commits it) yet nobody removes the pair, so the card stays
  // SKIPPED on that platform DESPITE a committed baseline — silent coverage loss.
  // (This is distinct from EXEMPT_FROM_VRT, which skips a card ENTIRELY on
  // purpose, with a reason; a "pending" pair whose baseline exists is just rot.)
  //
  // A pair is STALE when a baseline PNG for that `<platform>/<scene>` exists
  // ANYWHERE under __screenshots__ — not just under vrt.spec.ts.
  //
  // ⚠ 2026-08-01: this check used to resolve only the vrt.spec.ts path, so a
  // stale composite/scene pair (whose PNG lives under its own spec dir) was
  // structurally invisible to it. Same blindness class as the deficit ratchet
  // above — a gate that looks in one directory cannot speak for the tree.
  // `committedBaselineKeys()` indexes every spec dir, so the widened check now
  // sees all of them. `task vrt:audit` prints the classified list.
  //
  // Widening it immediately found THREE the narrow version could not see — the
  // three `darwin/wavesculpt-blink-*` quarantines, whose PNGs live under
  // vrt-wavesculpt-blink.spec.ts. Re-derived on main @ 77cd1bbc: narrow = 16,
  // widened = 19. (`darwin/rasterize` is the FOURTH member of the residue but
  // NOT part of the delta — its PNG is `vrt.spec.ts/darwin/rasterize.png`, so
  // the narrow check always saw it. An earlier revision of this comment, the
  // commit message and CLAUDE.md all said "FOUR"; scripts/vrt-exemptions-audit
  // said three, and the audit script was right.) The true count was 19, ABOVE
  // the old ceiling of 18 — the ratchet was under its cap only because its
  // instrument was short-sighted.
  //
  // Those four are the residue and are deliberately NOT drained: they are
  // tracked FLAKE QUARANTINES (canvas-render timing variance, tasks #198 and
  // #202), not pending captures. Their baselines are committed and correct;
  // the scene is unstable. Dropping the pairs without the root-cause fix just
  // re-reds the lane, which is the opposite of coverage — see
  // `feedback_never_quarantine_fix_the_test`: they come out with the FIX.
  //
  // 18 → 4. The 15 pending-but-committed pairs were drained 2026-08-01, so the
  // only remaining budget is those four named quarantines. A new "capture the
  // baseline, forget to drop the pair" therefore fails immediately.
  //
  // THE PRECONDITION FOR A DRAIN (restored — it was deleted in the very commit
  // that then violated it, and the 15-scene drain went out with all 15 linux
  // baselines DIMENSION-MISMATCHED, turning the VRT lane red):
  //   LOWER the number when you drop a stale pair — AFTER CONFIRMING THE
  //   COMMITTED BASELINE STILL MATCHES THE RENDER. A pair that has been listed
  //   for weeks has usually outlived its PNG: the card was re-laid-out and the
  //   committed image is the wrong SIZE, which Playwright hard-fails before it
  //   ever computes a diff ratio, so no tolerance argument applies. If in
  //   doubt, `git rm` the stale PNG and dispatch
  //   `vrt-update.yml -f platform=linux` in the SAME PR — a drain whose
  //   re-capture is deferred to "a follow-up" ships a red lane.
  // Re-introducing a pair for a card that already has a baseline RAISES this
  // number → fails. Mirrors the deficit ratchet above, inverted.
  it('the stale-exemption count (pair listed but baseline already exists) only shrinks', () => {
    // Same vacuity trap as the deficit ratchet: with `__screenshots__` absent
    // `committed` is empty, `stale` is 0, and `0 <= 4` passes while measuring
    // nothing at all.
    assertBaselineTreeIsReadable();
    const committed = committedBaselineKeys();
    const stale = [...EXEMPT_BASELINE_PAIRS].filter((p) => committed.has(p)).sort();
    expect(
      stale.length,
      `EXEMPT_BASELINE_PAIRS lists pairs whose baseline PNG ALREADY exists — the scene is ` +
        `SKIPPED on that platform despite a committed baseline (silent coverage loss; the ` +
        `pair is consulted BEFORE the PNG). It is also a deadlock: --update-snapshots writes ` +
        `nothing for a skipped test, so the pair blocks the very re-capture it waits on. ` +
        `Drop the stale pair(s) (see \`task vrt:audit\`): ${stale.join(', ')}`,
      // 18→4 (2026-08-01): the drain batch removed the 15 PENDING-but-committed
      // pairs (see the DRAIN BATCH note at the head of EXEMPT_BASELINE_PAIRS).
      // The 4 that remain are the tracked darwin flake QUARANTINES (#198/#202)
      // and only leave with their root-cause fix. Do not raise this: outside a
      // quarantine, a pair whose PNG exists has no legitimate reading.
    ).toBeLessThanOrEqual(STALE_PAIR_CEILING);
    expect(
      STALE_PAIR_CEILING - stale.length,
      `THE STALE-PAIR CEILING HAS GONE SLACK: ${stale.length} stale pair(s) under a ceiling of ` +
        `${STALE_PAIR_CEILING}. A quarantine was released and the number was not lowered, so ` +
        `the ratchet now silently tolerates ${STALE_PAIR_CEILING - stale.length} new "captured ` +
        `the baseline, forgot to drop the pair". Set it to ${stale.length}.`,
    ).toBe(0);
  });
});
