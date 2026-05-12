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
  /** 'audio' for Phase-1 modules, 'video' for the Phase-0 video spike's
   *  modules. Used by e2e tests to set node.domain correctly when
   *  spawning a module by type. */
  domain: string;
  inputs: ModuleSpecPort[];
  outputs: ModuleSpecPort[];
}

/**
 * Snapshot every registered module def's I/O surface. Modules whose
 * `inputs` are computed via a builder function (e.g. RIOTGIRLS,
 * MIXMSTRS) work transparently — by the time they're registered, the
 * computed array is already attached to the def.
 *
 * Includes both audio-domain and video-domain modules. The Phase-0
 * video spike (.myrobots/plans/video-modules-mvp.md) registers `lines`
 * + `videoOut` here so the existing I/O-spec consistency e2e
 * (e2e/tests/io-spec-consistency.spec.ts) covers them too.
 */
export function getAllModuleSpecs(): ModuleSpec[] {
  const all = [
    ...listModuleDefs(),
    ...listVideoModuleDefs(),
    ...listMetaModuleDefs(),
  ];
  return all
    .map((def) => ({
      type: def.type as string,
      domain: def.domain as string,
      inputs: def.inputs.map((p) => ({ id: p.id, type: p.type })),
      outputs: def.outputs.map((p) => ({ id: p.id, type: p.type })),
    }))
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
