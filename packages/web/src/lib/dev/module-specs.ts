// packages/web/src/lib/dev/module-specs.ts
//
// Source-of-truth helper that exposes every registered AudioModuleDef's
// declared input/output port surface. Powers the I/O-spec consistency
// checks (def <-> published manifest <-> rendered card UI handles).
//
// Why separate from module-registry: the registry stores full ModuleDef
// objects (factories, migrations, schemaVersion). The consistency tests
// only need the port surface, and a thin projection makes the test
// targets robust to unrelated def-shape changes.
//
// In dev / autotest builds (testHooksEnabled() === true) the helper is
// also exposed on `window.__moduleSpecs` so e2e specs can read the
// canonical port list without re-implementing the projection in
// browser-evaluated JS.

import { listModuleDefs } from '$lib/audio/module-registry';
import { listVideoModuleDefs } from '$lib/video/module-registry';
import { listMetaModuleDefs } from '$lib/meta/module-registry';
import { testHooksEnabled } from './test-hooks';

export interface ModuleSpecPort {
  id: string;
  type: string;
}

export interface ModuleSpec {
  type: string;
  /** Human-friendly label from the def (e.g. "Analog VCO"). Used by
   *  test reporters + cascade-display assertions. */
  label: string;
  /** 'audio' for Phase-1 modules, 'video' for the Phase-0 video spike's
   *  modules, 'meta' for non-engine cards (sticky, group). Used by
   *  e2e tests to set node.domain correctly when spawning a module. */
  domain: string;
  /** Module-registry category (sources / modulation / filters / effects /
   *  utilities / output / etc.). Whatever the def declares. */
  category: string;
  inputs: ModuleSpecPort[];
  outputs: ModuleSpecPort[];
  /** Derived hints used by manifest-driven test generators (per-module
   *  spec stamper, pair-patch integration, full-system render). Set
   *  here so every downstream test layer sees the same answer for
   *  "does this module produce audio? CV? a clock? video?" without
   *  re-walking the outputs array. */
  hasAudioOutput: boolean;
  hasCvOutput: boolean;
  hasGateOutput: boolean;
  hasVideoOutput: boolean;
}

function hasOutputType(outputs: readonly ModuleSpecPort[], wanted: string): boolean {
  return outputs.some((p) => p.type === wanted);
}

/**
 * Snapshot every registered module def's I/O surface. Modules whose
 * `inputs` are computed via a builder function (e.g. RIOTGIRLS,
 * MIXMSTRS, HYDROGEN) work transparently — by the time they're
 * registered, the computed array is already attached to the def.
 *
 * Includes audio-, video-, and meta-domain modules. The per-domain
 * barrels self-register at import time, so callers that need a
 * non-empty list must have imported `$lib/audio/modules`,
 * `$lib/video/modules`, and `$lib/meta/modules` first (Canvas.svelte
 * does this on the page-load path; the manifest-emitting test imports
 * them explicitly).
 */
export function getAllModuleSpecs(): ModuleSpec[] {
  const all = [
    ...listModuleDefs(),
    ...listVideoModuleDefs(),
    ...listMetaModuleDefs(),
  ];
  return all
    .map((def) => {
      const inputs = def.inputs.map((p) => ({ id: p.id, type: p.type as string }));
      const outputs = def.outputs.map((p) => ({ id: p.id, type: p.type as string }));
      return {
        type: def.type as string,
        label: (def.label as string) ?? (def.type as string),
        domain: def.domain as string,
        category: (def.category as string) ?? 'uncategorized',
        inputs,
        outputs,
        hasAudioOutput: hasOutputType(outputs, 'audio'),
        hasCvOutput: hasOutputType(outputs, 'cv'),
        hasGateOutput: hasOutputType(outputs, 'gate'),
        hasVideoOutput:
          hasOutputType(outputs, 'video') || hasOutputType(outputs, 'mono-video'),
      };
    })
    .sort((a, b) => a.type.localeCompare(b.type));
}

/**
 * Look up one module's spec by type. Returns `undefined` if the type
 * isn't registered (e.g. typo in a test fixture).
 */
export function getModuleSpec(type: string): ModuleSpec | undefined {
  return getAllModuleSpecs().find((s) => s.type === type);
}

/**
 * Expose the spec snapshot on `window` for e2e tests. Called from
 * `audio/modules/index.ts` after registration.
 */
export function exposeModuleSpecsForTests(): void {
  if (!testHooksEnabled()) return;
  if (typeof window === 'undefined') return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__moduleSpecs = getAllModuleSpecs();
}
