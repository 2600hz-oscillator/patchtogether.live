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
import { STRICT_FACES } from '$lib/ui/workflow/strict-faces';
import {
  faceAnnotationTally,
  type FaceplateDefLike,
} from '$lib/ui/workflow/dock-faceplate-model';
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
  /** Declared dynamic control-family ids (`def.controlFamilies[].id`) — the
   *  faces-parity e2e counts one rendered family cell per entry. Emitted only
   *  when the def declares families. */
  controlFamilies?: string[];
  /**
   * PF-20 — the dock SIDEBAR blocks the face declares, as `{kind,label}` pairs
   * in declaration order. Emitted only when the def declares a sidebar.
   *
   * ⚠ THIS EXISTS SO THE SIDEBAR IS REGISTRY-DRIVEN LIKE EVERYTHING ELSE. The
   * sidebar mounts OUTSIDE `[data-testid="module-shell"]`, which is what keeps
   * a preset button from having to be taught to faces-parity's cell sweep —
   * and it also puts every block out of reach of that sweep entirely. Without
   * this projection the ONLY DOM coverage a sidebar could have would be a spec
   * hardcoded to one module type, so adopter #2 could ship a sidebar that
   * renders blank and nothing would notice. Publishing the DECLARATION lets
   * `faceplate-platform.spec.ts` enumerate it and assert every declared block
   * actually painted, for every module, with no per-module test edit.
   */
  faceSidebar?: { kind: string; label: string }[];
  /**
   * PF-20 ANNOTATIONS — the count of prose strings this face declares, split by
   * the SURFACE each one paints on: the section `face.title` (0 or 1), the
   * page-level `face.hint` (0 or 1), and the per-band `hint`s. Emitted only when
   * the face declares any.
   *
   * ⚠ SAME REASON AS `faceSidebar`, one layer over. Annotation prose is OUT of
   * the DOM until the viewer turns the dock toggle on, so the only thing a
   * hardcoded spec can prove is that ONE module's prose appears — and the
   * failure that matters is the opposite one: a face that declares prose the
   * platform never offers a way to read, or a toggle on a face with nothing to
   * say. Publishing the counts lets the e2e assert BOTH directions for every
   * adopter with no per-module test edit.
   *
   * ⚠ SPLIT BY SURFACE, not aggregated, because one number cannot distinguish
   * "the title painted and a band hint did not" from the correct render. Each
   * count is asserted against its own selector (`.face-title` / `.face-hint` /
   * `.page-hint`).
   *
   * ⚠ `bandHints` NO LONGER IMPLIES AN UNTABBED FACE. It used to: the shell
   * gated the hint on the band LABEL, which a tab rail suppresses, so a hint on
   * a tabbed face rendered nowhere and module-face-lint forbade declaring one.
   * `bandHeaderPlan` asks the two questions separately (2026-08-02), so a tabbed
   * face paints its hints as their own line and the sweep's COUNT assertion
   * covers both shapes with no branch.
   */
  faceAnnotations?: { title: number; pageHint: number; bandHints: number };
  /**
   * #1726 — the param ids this def declares as having NO USER CONTROL (a
   * synthetic gate param a `paramTarget` CV bridge writes; a determinism
   * toggle). Emitted only when the def declares any, so every existing spec
   * JSON is byte-identical.
   *
   * PUBLISHED because `faces-parity` derives "one interactive cell per param"
   * from `spec.params`, and a declared param must render ZERO. Without this the
   * browser-free lint and its DOM twin would disagree the day a video face
   * lands, and the DOM one is the authoritative half.
   */
  noUserControl?: string[];
  /** True when the type is in STRICT_FACES (a MIGRATED curated face) — the
   *  registry key the faces-parity e2e enumerates, so every future promoted
   *  module auto-enrolls in the dock render-parity sweep. Emitted only when
   *  true. */
  strictFace?: boolean;
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
      const rawFamilies = (def as { controlFamilies?: readonly { id: string }[] }).controlFamilies;
      const controlFamilies: string[] | undefined =
        rawFamilies && rawFamilies.length ? rawFamilies.map((f) => f.id) : undefined;
      const strictFace = STRICT_FACES.has(def.type as string);
      const rawNoControl = (def as { noUserControl?: readonly { param: string }[] }).noUserControl;
      const noUserControl: string[] | undefined =
        rawNoControl && rawNoControl.length ? rawNoControl.map((e) => e.param) : undefined;
      // PF-20 — the DECLARED sidebar blocks (kind + label only: the sweep asks
      // "did every declared block paint", never "what is inside it").
      const rawSidebar = (def as { face?: { sidebar?: readonly { kind: string; label: string }[] } })
        .face?.sidebar;
      const faceSidebar: { kind: string; label: string }[] | undefined =
        rawSidebar && rawSidebar.length
          ? rawSidebar.map((b) => ({ kind: b.kind, label: b.label }))
          : undefined;
      // PF-20 — the ANNOTATION counts, resolved through the SAME pure function
      // the shell and the dock toggle read (`faceAnnotationTally`), never a
      // second walk of `face.title` + `face.hint` + `pages[].hint` here: two
      // implementations of "what counts as annotation prose" is precisely the
      // drift this projection exists to catch.
      //
      // ⚠ The kinds are COUNTED, not recovered by subtraction. This used to
      // publish `bandHints: total - pageHint`, and the day `title` joined the
      // roster (owner, 2026-08-02) that sum would have over-counted every
      // titled face's band hints by exactly one — and the e2e sweep would have
      // failed on a face whose markup was correct. The tally is per-kind at the
      // source so a FOURTH source cannot repeat it.
      const faceDef = def as FaceplateDefLike;
      const tally = faceAnnotationTally(faceDef);
      const faceAnnotations =
        tally.total > 0
          ? { title: tally.title, pageHint: tally.pageHint, bandHints: tally.bandHints }
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
        ...(controlFamilies ? { controlFamilies } : {}),
        ...(faceSidebar ? { faceSidebar } : {}),
        ...(faceAnnotations ? { faceAnnotations } : {}),
        ...(noUserControl ? { noUserControl } : {}),
        ...(strictFace ? { strictFace } : {}),
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
