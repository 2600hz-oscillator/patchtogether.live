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
});
