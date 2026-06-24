// packages/web/src/lib/dev/registry-manifest.test.ts
//
// Manifest emitter — the foundation of the registry-driven test layer.
//
// Why this lives in `packages/web/src/lib/dev/`:
//   * vitest in this workspace already imports the three module-registry
//     barrels (audio / video / meta) in countless unit tests; running
//     the registry projection here is essentially free.
//   * Test-load-time iteration over a registry is the unit-test pass's
//     superpower. Playwright can't `await` at file load — but it CAN
//     `readFileSync` a JSON dump. So we treat the manifest as the seam:
//     `task test` emits it, downstream `task e2e` + `task vrt` specs
//     consume it via `e2e/tests/_registry.ts`.
//   * The alternative — duplicating the registry list in 3-4 hardcoded
//     allowlists across spec files — is what got the codebase to
//     21/74 (28%) drift in `io-spec-consistency.MODULE_TYPES` + 27/74
//     (36%) drift in `modules.spec.ts:MODULES` before this slice
//     landed.
//
// Output: e2e/.generated/registry-manifest.json (gitignored), refreshed
// every `task test` run. CI's `task ci` chain runs `task test` before
// `task e2e` / `task vrt`, so the manifest is always fresh when the
// downstream Playwright specs read it.
//
// Schema is sorted by module type for stable diffs across runs.

import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// Pull every barrel — the side-effect import is what triggers the
// per-domain registerModule() calls. Without these the lists would be
// empty and the assertion at the bottom would fail.
import '$lib/audio/modules';
import '$lib/video/modules';
import '$lib/meta/modules';

import { getAllModuleSpecs } from './module-specs';

interface ManifestPortEntry {
  id: string;
  type: string;
  // schemaVersion-2 enrichment (all optional — emitted only when set).
  paramTarget?: string;
  cvScale?: { mode: string; depth?: number };
  accepts?: string[];
  edge?: 'trigger' | 'gate';
  adoptsUpstreamFrom?: string;
}

interface ManifestParamEntry {
  id: string;
  label: string;
  defaultValue: number;
  min: number;
  max: number;
  curve: string;
  units?: string;
}

interface ManifestEntry {
  type: string;
  label: string;
  domain: string;
  category: string;
  inputs: ManifestPortEntry[];
  outputs: ManifestPortEntry[];
  // schemaVersion-2 enrichment — full ParamDef surface + stereo pairs, so
  // the docs I/O section + io-explain read the SINGLE source of truth.
  params: ManifestParamEntry[];
  stereoPairs?: [string, string][];
  hasAudioOutput: boolean;
  hasCvOutput: boolean;
  hasGateOutput: boolean;
  hasVideoOutput: boolean;
}

interface Manifest {
  /** Schema version. Bump when the entry shape changes — downstream
   *  Playwright fixture refuses to load a manifest whose version it
   *  doesn't recognise (fail-fast over silent skew). schemaVersion 2
   *  (this slice) carries the full PortDef + ParamDef + stereoPairs per
   *  module for the docs-overhaul auto I/O section. */
  schemaVersion: 2;
  /** ISO 8601 timestamp the manifest was emitted. Stable across runs
   *  is not the point — debuggability is: when CI flags a downstream
   *  drift, the timestamp lets you confirm which test invocation
   *  produced this manifest. */
  generatedAt: string;
  /** Sorted by module type. */
  modules: ManifestEntry[];
}

/** Resolve the manifest path from the repo root. vitest's cwd is
 *  packages/web; the manifest lives at the repo's e2e/.generated/
 *  so all e2e specs can read it via a relative path. Five `..` hops:
 *  packages/web/src/lib/dev/ → repo root. Then `e2e/.generated/`. */
function manifestPath(): string {
  return resolve(import.meta.dirname, '../../../../..', 'e2e/.generated/registry-manifest.json');
}

describe('registry manifest emitter', () => {
  const specs = getAllModuleSpecs();
  const manifest: Manifest = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    modules: specs,
  };

  it('every barrel registered at least one module', () => {
    // 74 was the count at the time this slice landed (55 audio + 17
    // video + 2 meta). The bar is "non-trivially populated", not an
    // exact count — new modules push the count up without breaking
    // this assertion. If the count DROPS, it means a registration
    // side-effect got skipped (the barrel import didn't fire) and the
    // emitted manifest would be wrong.
    expect(specs.length).toBeGreaterThan(60);
  });

  it('every module has the required fields', () => {
    for (const m of specs) {
      expect(m.type, 'type').toBeTruthy();
      expect(m.label, `${m.type} label`).toBeTruthy();
      expect(m.domain, `${m.type} domain`).toMatch(/^(audio|video|meta)$/);
      expect(m.category, `${m.type} category`).toBeTruthy();
      expect(Array.isArray(m.inputs), `${m.type} inputs is array`).toBe(true);
      expect(Array.isArray(m.outputs), `${m.type} outputs is array`).toBe(true);
      // schemaVersion-2: params is always an array (possibly empty).
      expect(Array.isArray(m.params), `${m.type} params is array`).toBe(true);
    }
  });

  // schemaVersion-2 enrichment carries the full PortDef/ParamDef surface.
  // Spot-check ADSR: its CV inputs declare paramTarget + cvScale, and its
  // params declare label/min/max/curve — the fields the docs I/O section
  // + io-explain read. This is the manifest-side proof the projection
  // (module-specs.ts) preserves the def fields end-to-end.
  it('schemaVersion-2 carries paramTarget/cvScale on ports and full ParamDef', () => {
    const adsr = specs.find((s) => s.type === 'adsr');
    expect(adsr, 'adsr present').toBeDefined();
    if (!adsr) return;
    const attackIn = adsr.inputs.find((p) => p.id === 'attack');
    expect(attackIn?.paramTarget, 'adsr.attack paramTarget').toBe('attack');
    expect(attackIn?.cvScale?.mode, 'adsr.attack cvScale.mode').toBe('log');
    const attackParam = adsr.params.find((p) => p.id === 'attack');
    expect(attackParam?.label, 'adsr.attack param label').toBeTruthy();
    expect(typeof attackParam?.min, 'adsr.attack min is number').toBe('number');
    expect(typeof attackParam?.max, 'adsr.attack max is number').toBe('number');
    expect(attackParam?.curve, 'adsr.attack curve').toBeTruthy();
  });

  it('module types are unique', () => {
    const types = specs.map((m) => m.type);
    const unique = new Set(types);
    expect(types.length, 'no duplicate type ids').toBe(unique.size);
  });

  // The card UI uppercases the label for DISPLAY via CSS, so the stored
  // `label:` string itself must be lowercase for consistency (the #658
  // convention). Iterating the full registry here both ENUMERATES every
  // offender and PREVENTS recurrence — any new module that lands with an
  // uppercase label (or a stray uppercase letter in a multi-word label
  // like 'audio in') fails CI here. Multi-word labels keep their spaces;
  // only letter-casing is constrained.
  it('every module label is lowercase', () => {
    const offenders = specs
      .filter((m) => m.label !== m.label.toLowerCase())
      .map((m) => `${m.type}: ${JSON.stringify(m.label)}`);
    expect(
      offenders,
      `module labels must be lowercase (card CSS uppercases for display); ` +
        `offenders:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('emits the manifest JSON to disk', () => {
    const path = manifestPath();
    mkdirSync(dirname(path), { recursive: true });
    // Pretty-printed so a diff is reviewable in PR if anyone happens
    // to check in the generated file. The committed `.gitignore`
    // entry should prevent that — but defensive pretty-printing
    // costs nothing.
    writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    // Sanity: subsequent read returns parsable JSON with the schema
    // we just wrote.
    const written = JSON.parse(JSON.stringify(manifest));
    expect(written.schemaVersion).toBe(2);
    expect(written.modules.length).toBe(specs.length);
  });
});
