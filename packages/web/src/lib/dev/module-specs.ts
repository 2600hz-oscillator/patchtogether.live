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
  /** schemaVersion-2 enrichment — the full PortDef surface the docs I/O
   *  section + io-explain read. All optional so v1 consumers that only
   *  read {id,type} keep working unchanged. */
  paramTarget?: string;
  cvScale?: { mode: 'linear' | 'log' | 'discrete' | 'passthrough'; depth?: number };
  accepts?: string[];
  edge?: 'trigger' | 'gate';
  adoptsUpstreamFrom?: string;
}

/** schemaVersion-2 param projection — the ParamDef fields the docs params
 *  table + io-explain render. */
export interface ModuleSpecParam {
  id: string;
  label: string;
  defaultValue: number;
  min: number;
  max: number;
  curve: 'linear' | 'log' | 'exp' | 'discrete';
  units?: string;
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
  /** schemaVersion-2 enrichment — the module's full ParamDef surface +
   *  stereo-pair tuples. Powers the docs params table + the stereo L/R
   *  normaling note. Optional (a def may declare no params / no pairs). */
  params: ModuleSpecParam[];
  stereoPairs?: [string, string][];
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

/** Project a live PortDef into the schemaVersion-2 ModuleSpecPort. Emits the
 *  optional enrichment fields ONLY when set so the JSON stays terse and v1
 *  consumers (which read just {id,type}) are unaffected. */
function projectPort(p: {
  id: string;
  type: unknown;
  paramTarget?: string;
  cvScale?: { mode: 'linear' | 'log' | 'discrete' | 'passthrough'; depth?: number };
  accepts?: readonly unknown[];
  edge?: 'trigger' | 'gate';
  adoptsUpstreamFrom?: string;
}): ModuleSpecPort {
  const out: ModuleSpecPort = { id: p.id, type: p.type as string };
  if (p.paramTarget) out.paramTarget = p.paramTarget;
  if (p.cvScale) {
    out.cvScale = p.cvScale.depth !== undefined
      ? { mode: p.cvScale.mode, depth: p.cvScale.depth }
      : { mode: p.cvScale.mode };
  }
  if (p.accepts && p.accepts.length > 0) out.accepts = p.accepts.map((a) => a as string);
  if (p.edge) out.edge = p.edge;
  if (p.adoptsUpstreamFrom) out.adoptsUpstreamFrom = p.adoptsUpstreamFrom;
  return out;
}

/**
 * Snapshot every registered module def's I/O surface. Modules whose
 * `inputs` are computed via a builder function (e.g.
 * MIXMSTRS) work transparently — by the time they're
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
      const inputs = def.inputs.map(projectPort);
      const outputs = def.outputs.map(projectPort);
      const params: ModuleSpecParam[] = (def.params ?? []).map((p) => ({
        id: p.id,
        label: p.label,
        defaultValue: p.defaultValue,
        min: p.min,
        max: p.max,
        curve: p.curve,
        ...(p.units ? { units: p.units } : {}),
      }));
      // stereoPairs may be readonly nested tuples on the def — clone to a
      // plain mutable [string, string][] for the JSON manifest.
      const rawPairs = (def as { stereoPairs?: readonly (readonly [string, string])[] }).stereoPairs;
      const stereoPairs: [string, string][] | undefined = rawPairs
        ? rawPairs.map(([l, r]) => [l, r] as [string, string])
        : undefined;
      return {
        type: def.type as string,
        label: (def.label as string) ?? (def.type as string),
        domain: def.domain as string,
        category: (def.category as string) ?? 'uncategorized',
        inputs,
        outputs,
        params,
        ...(stereoPairs ? { stereoPairs } : {}),
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
