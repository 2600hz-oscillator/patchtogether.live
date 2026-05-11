// packages/web/src/lib/audio/modules/vrt-meta.test.ts
//
// Coverage self-test for the Playwright VRT suite.
//
// Asserts every registered audio + video module has:
//   1. an entry in e2e/vrt/vrt.spec.ts's MODULES list
//   2. a baseline PNG under e2e/vrt/__screenshots__/vrt.spec.ts/
//
// Catches the "added a new module, forgot the baseline" case in the
// vitest pass (~1s) rather than in the Playwright pass (~3min on CI),
// and well before the gallery deploys.
//
// EXEMPTED types are listed inline with a reason — currently just
// cameraInput, which can't be VRT'd without baking the synthetic-camera
// video frame into the baseline.

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { listModuleDefs } from '$lib/audio/module-registry';
import { listVideoModuleDefs } from '$lib/video/module-registry';

// Modules that intentionally skip VRT. Each entry needs a reason +
// (where applicable) the alternative test that covers the same surface.
const EXEMPT_FROM_VRT: Record<string, string> = {
  // CAMERA renders a live MediaStream into a canvas. Even with the
  // fake-camera flag the synthetic frame is non-deterministic enough
  // (frame-time clock) that the baseline would flap. Functional coverage
  // is e2e/tests/camera-input.spec.ts.
  cameraInput: 'live MediaStream defeats deterministic capture',
};

function repoRoot(): string {
  // This file lives at packages/web/src/lib/audio/modules/. Six `..`
  // hops up = repo root. Resolved from import.meta.dirname so the
  // result is invariant to vitest's working directory.
  return resolve(import.meta.dirname, '../../../../../..');
}

function readVrtSpecModuleList(): Set<string> {
  const specPath = resolve(repoRoot(), 'e2e/vrt/vrt.spec.ts');
  const src = readFileSync(specPath, 'utf8');
  // Match `{ type: 'foo', domain: 'audio' | 'video', ... }` entries. The
  // regex is intentionally loose — we just need the `type:` value.
  const re = /\btype:\s*['"]([a-zA-Z0-9]+)['"]/g;
  const out = new Set<string>();
  for (const m of src.matchAll(re)) out.add(m[1]);
  return out;
}

function baselinePath(type: string): string {
  return resolve(
    repoRoot(),
    `e2e/vrt/__screenshots__/vrt.spec.ts/${type}.png`,
  );
}

describe('VRT coverage self-test', () => {
  // Import the registration barrels so the registries are populated.
  // The web app's UI does this on first page load; in the vitest pass
  // we have to import them explicitly.
  //
  // Note: these imports must come before any test body executes. We
  // use a dynamic import inside `beforeAll` to keep the type-checker
  // happy in environments where the registration side-effects haven't
  // been triggered yet by a sibling test in the same vitest invocation.
  //
  // The audio + video module barrels self-register on first import
  // (see audio/modules/index.ts + video/modules/index.ts), so a single
  // import of each is enough.
  it('imports module barrels so registries are populated', async () => {
    await import('$lib/audio/modules');
    await import('$lib/video/modules');
    const total = listModuleDefs().length + listVideoModuleDefs().length;
    expect(total, 'at least one module is registered').toBeGreaterThan(0);
  });

  it('every registered module is listed in vrt.spec.ts (or exempted)', async () => {
    await import('$lib/audio/modules');
    await import('$lib/video/modules');
    const registered = [
      ...listModuleDefs().map((d) => d.type as string),
      ...listVideoModuleDefs().map((d) => d.type as string),
    ];
    const inSpec = readVrtSpecModuleList();
    const missing: string[] = [];
    for (const t of registered) {
      if (EXEMPT_FROM_VRT[t]) continue;
      if (!inSpec.has(t)) missing.push(t);
    }
    expect(
      missing,
      `add these to e2e/vrt/vrt.spec.ts MODULES (or add an EXEMPT_FROM_VRT entry with a reason): ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('every VRT-listed module has a baseline PNG on disk', async () => {
    await import('$lib/audio/modules');
    await import('$lib/video/modules');
    const inSpec = readVrtSpecModuleList();
    const missingBaseline: string[] = [];
    for (const t of inSpec) {
      if (!existsSync(baselinePath(t))) missingBaseline.push(t);
    }
    expect(
      missingBaseline,
      `run \`task vrt:update\` to (re)generate baselines for: ${missingBaseline.join(', ')}`,
    ).toEqual([]);
  });

  it('every exempted module has a non-empty reason', () => {
    for (const [t, reason] of Object.entries(EXEMPT_FROM_VRT)) {
      expect(reason.length, `${t} exemption needs a reason`).toBeGreaterThan(10);
    }
  });
});
