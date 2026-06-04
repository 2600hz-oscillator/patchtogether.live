// packages/web/src/lib/video/toybox-cv-routes.ts
//
// TOYBOX Phase 5 — CV routing model + resolution (PURE: no Yjs, no GL).
//
// A TOYBOX layer's shader (and thus its float uniforms) is chosen at RUNTIME,
// so we cannot statically declare a CV input port per possible uniform.
// Instead the def exposes a FIXED POOL of generic CV input ports (cv1..cv8),
// and a data-driven ROUTING MAP (node.data.cvRoutes) says which addressed
// param each generic port drives. The factory's setParam(cvN, value) looks up
// the route, resolves the target param's declared min/max, RE-SCALES the
// incoming -1..+1 value across that range (reusing scaleCv — the same helper
// the cv-bridge uses), and writes it into the live layer/combine param so the
// render updates next frame.
//
// The generic cv ports stay neutral-linear (the bridge does NOT scale them —
// they have a cvScale:{mode:'linear'} hint but NO paramTarget, so
// buildCvBridgeMapping degrades to raw passthrough and hands setParam the raw
// ±1 sample). TOYBOX does the per-target range scaling HERE, because only the
// route knows which param — and thus which range — the value is destined for.
//
// This file is the SINGLE SOURCE OF TRUTH for:
//   - the cv pool size + port ids (def + card + tests share these),
//   - the route shape,
//   - what params each target (a layer's content / an OBJ material / a combine
//     op node) exposes, with their declared min/max (the re-scale range),
//   - the pure resolve+rescale math (resolveRoute / scaleRoutedValue).
//
// Unit-tested in toybox-cv-routes.test.ts; consumed by modules/toybox.ts
// (setParam), ToyboxCard.svelte (the CV tab), and graph/toybox-cv-routes.ts
// (the Yjs mutator).

import { scaleCv } from '$lib/audio/cv-scale';
import {
  LAYER_COUNT,
  getContentMeta,
  type ToyboxLayer,
} from './toybox-content';
import {
  OP_PARAMS,
  isCombineGraph,
  type ToyboxCombineGraph,
  type ToyboxOpKind,
} from './toybox-combine-graph';

/** Number of generic CV input ports the def declares. */
export const CV_PORT_COUNT = 8;

/** The fixed pool of generic CV input port ids: 'cv1'..'cv8'. */
export const CV_PORT_IDS: readonly string[] = Array.from(
  { length: CV_PORT_COUNT },
  (_, i) => `cv${i + 1}`,
);

/** True if `portId` is one of the generic cv pool ports (cv1..cv8). */
export function isCvPortId(portId: string): boolean {
  return CV_PORT_IDS.includes(portId);
}

/** One routing target: which addressable param a generic cv port drives.
 *   - target 'layer': layer[layer].param — a content uniform OR (for an OBJ
 *     layer) a material transform/tint field (param prefixed 'material:').
 *   - target 'combine': the combine GRAPH op node `nodeId`'s float param. */
export interface CvRouteTarget {
  target: 'layer' | 'combine';
  /** Layer index (0..LAYER_COUNT-1) — when target === 'layer'. */
  layer?: number;
  /** Combine op-node id — when target === 'combine'. */
  nodeId?: string;
  /** The param id within the target (content uniform id, 'material:<field>',
   *  or a combine op param id). */
  param: string;
}

/** The persisted routing map, keyed by cv port id. A null/absent entry means
 *  "this generic cv port is unrouted" (its writes are ignored). */
export type CvRoutes = Partial<Record<string, CvRouteTarget | null>>;

// ---------------- OBJ material param schema (the re-scale ranges) ----------------
//
// The OBJ-layer material fields are addressable CV targets too (Phase-5 demo
// (c): cv3 → an OBJ-layer param). They are NOT in the manifest (they're a
// fixed engine-side material), so their min/max live HERE — the SAME ranges
// the card's OBJ knobs use. Addressed with the 'material:' prefix so they
// don't collide with content-uniform ids on a shader layer.

export interface ToyboxMaterialParamDef {
  /** Material field name (key on ToyboxObjMaterial). */
  field: string;
  /** Addressable param id ('material:<field>'). */
  id: string;
  label: string;
  min: number;
  max: number;
}

const PI = Math.PI;

/** OBJ material params exposed as CV targets (id = 'material:<field>'). Ranges
 *  mirror ToyboxCard's OBJ knobs so the re-scale matches the manual control. */
export const MATERIAL_PARAMS: readonly ToyboxMaterialParamDef[] = [
  { field: 'rotX', id: 'material:rotX', label: 'ROT X', min: -PI, max: PI },
  { field: 'rotY', id: 'material:rotY', label: 'ROT Y', min: -PI, max: PI },
  { field: 'rotZ', id: 'material:rotZ', label: 'ROT Z', min: -PI, max: PI },
  { field: 'scale', id: 'material:scale', label: 'SCALE', min: 0.25, max: 3 },
  { field: 'spin', id: 'material:spin', label: 'SPIN', min: 0, max: 3 },
  { field: 'tintR', id: 'material:tintR', label: 'TINT R', min: 0, max: 1 },
  { field: 'tintG', id: 'material:tintG', label: 'TINT G', min: 0, max: 1 },
  { field: 'tintB', id: 'material:tintB', label: 'TINT B', min: 0, max: 1 },
];

/** The 'material:' prefix marks an OBJ-material CV target param id. */
export const MATERIAL_PARAM_PREFIX = 'material:';

/** Look up a material param def by its addressable id ('material:<field>'). */
export function materialParamById(id: string): ToyboxMaterialParamDef | undefined {
  return MATERIAL_PARAMS.find((p) => p.id === id);
}

// ---------------- Target enumeration (UI dropdowns) ----------------

/** A choosable target for the CV tab's [target ▾] dropdown. */
export interface CvTargetOption {
  /** Stable value encoding the target (e.g. 'layer:0', 'combine:op1'). */
  value: string;
  label: string;
  target: 'layer' | 'combine';
  layer?: number;
  nodeId?: string;
}

/** A choosable param for the CV tab's [param ▾] dropdown. */
export interface CvParamOption {
  id: string;
  label: string;
  min: number;
  max: number;
}

/** Encode a target option's stable dropdown value. */
export function encodeTargetValue(t: { target: 'layer' | 'combine'; layer?: number; nodeId?: string }): string {
  return t.target === 'layer' ? `layer:${t.layer ?? 0}` : `combine:${t.nodeId ?? ''}`;
}

/** Decode a dropdown value back into a partial route target (no param). */
export function decodeTargetValue(
  value: string,
): { target: 'layer' | 'combine'; layer?: number; nodeId?: string } | null {
  if (value.startsWith('layer:')) {
    const layer = parseInt(value.slice('layer:'.length), 10);
    if (!Number.isFinite(layer)) return null;
    return { target: 'layer', layer };
  }
  if (value.startsWith('combine:')) {
    const nodeId = value.slice('combine:'.length);
    if (!nodeId) return null;
    return { target: 'combine', nodeId };
  }
  return null;
}

/**
 * Enumerate the targets the CV tab offers: the 4 layers + every combine op
 * node (sources/output have no params, so they're excluded). Pure over the
 * live layers + combine graph.
 */
export function listCvTargets(
  layers: readonly ToyboxLayer[] | undefined,
  combine: unknown,
): CvTargetOption[] {
  const out: CvTargetOption[] = [];
  for (let i = 0; i < LAYER_COUNT; i++) {
    const layer = layers?.[i];
    const kindTag = layer?.kind === 'obj' ? 'OBJ' : layer?.kind === 'off' ? 'OFF' : 'SHD';
    out.push({ value: `layer:${i}`, label: `Layer ${i} (${kindTag})`, target: 'layer', layer: i });
  }
  if (isCombineGraph(combine)) {
    const g = combine as ToyboxCombineGraph;
    for (const n of g.nodes) {
      if (n.kind === 'source' || n.kind === 'output') continue;
      out.push({
        value: `combine:${n.id}`,
        label: `Combine ${n.id} (${n.kind})`,
        target: 'combine',
        nodeId: n.id,
      });
    }
  }
  return out;
}

/**
 * Enumerate the params a given target exposes (the [param ▾] dropdown):
 *   - a SHADER/GEN layer → its content's manifest float uniforms,
 *   - an OBJ layer → the MATERIAL_PARAMS (transform/spin/tint),
 *   - a combine op node → that op kind's OP_PARAMS.
 * Pure; returns [] for an unknown / param-less target (off layer, missing op).
 */
export function listCvParams(
  target: { target: 'layer' | 'combine'; layer?: number; nodeId?: string },
  layers: readonly ToyboxLayer[] | undefined,
  combine: unknown,
): CvParamOption[] {
  if (target.target === 'layer') {
    const layer = layers?.[target.layer ?? -1];
    if (!layer) return [];
    if (layer.kind === 'obj') {
      return MATERIAL_PARAMS.map((p) => ({ id: p.id, label: p.label, min: p.min, max: p.max }));
    }
    if (layer.kind === 'shader' || layer.kind === 'gen') {
      const meta = layer.contentId ? getContentMeta(layer.contentId) : undefined;
      if (!meta) return [];
      return meta.params.map((p) => ({ id: p.id, label: p.label, min: p.min, max: p.max }));
    }
    return [];
  }
  // combine op node
  if (!isCombineGraph(combine)) return [];
  const g = combine as ToyboxCombineGraph;
  const n = g.nodes.find((x) => x.id === target.nodeId);
  if (!n || n.kind === 'source' || n.kind === 'output') return [];
  const defs = OP_PARAMS[n.kind as ToyboxOpKind] ?? [];
  return defs.map((p) => ({ id: p.id, label: p.label, min: p.min, max: p.max }));
}

// ---------------- Resolve + re-scale (the setParam hot path) ----------------

/** The resolved write target: the param's range, the param's CURRENT value
 *  (the modulation centre), and a setter that writes the re-scaled value into
 *  the live layer/combine param object in place. */
export interface ResolvedRoute {
  min: number;
  max: number;
  /** The param's CURRENT value (defaulted to the schema default when unset).
   *  This is the modulation centre passed to scaleRoutedValue as the knob. */
  current: number;
  /** Write `value` into the live target param object (mutates in place). */
  apply: (value: number) => void;
}

/**
 * Resolve a route against the LIVE layers + combine graph, returning the
 * addressed param's range + an in-place setter — or null if the route is
 * unresolvable (no such layer/op, no such param, off layer, etc.). The
 * `params`/`material` objects passed in are the LIVE objects the factory reads
 * each frame, so the setter's write is visible to the next render.
 *
 * Pure except for the returned setter (which mutates the live param object the
 * caller hands it). Range is read from the SAME schema the card uses, so the
 * re-scale matches the manual control.
 */
export function resolveRoute(
  route: CvRouteTarget,
  layers: readonly ToyboxLayer[] | undefined,
  combine: unknown,
): ResolvedRoute | null {
  if (route.target === 'layer') {
    const layer = layers?.[route.layer ?? -1];
    if (!layer) return null;
    // OBJ material param.
    if (route.param.startsWith(MATERIAL_PARAM_PREFIX)) {
      if (layer.kind !== 'obj' || !layer.material) return null;
      const def = materialParamById(route.param);
      if (!def) return null;
      const material = layer.material as unknown as Record<string, number>;
      const cur = material[def.field];
      return {
        min: def.min,
        max: def.max,
        current: typeof cur === 'number' ? cur : 0,
        apply: (v) => { material[def.field] = v; },
      };
    }
    // Content (shader/gen) uniform.
    if (layer.kind !== 'shader' && layer.kind !== 'gen') return null;
    const meta = layer.contentId ? getContentMeta(layer.contentId) : undefined;
    const pdef = meta?.params.find((p) => p.id === route.param);
    if (!pdef) return null;
    if (!layer.params) return null;
    const params = layer.params;
    const cur = params[route.param];
    return {
      min: pdef.min,
      max: pdef.max,
      current: typeof cur === 'number' ? cur : pdef.default,
      apply: (v) => { params[route.param] = v; },
    };
  }
  // Combine op-node param.
  if (!isCombineGraph(combine)) return null;
  const g = combine as ToyboxCombineGraph;
  const n = g.nodes.find((x) => x.id === route.nodeId);
  if (!n || n.kind === 'source' || n.kind === 'output') return null;
  const defs = OP_PARAMS[n.kind as ToyboxOpKind] ?? [];
  const def = defs.find((p) => p.id === route.param);
  if (!def) return null;
  if (!n.params) return null;
  const params = n.params;
  const cur = params[route.param];
  return {
    min: def.min,
    max: def.max,
    current: typeof cur === 'number' ? cur : def.default,
    apply: (v) => { params[route.param] = v; },
  };
}

/**
 * Re-scale a raw cv sample (-1..+1) across the resolved param's range, centred
 * on the param's current value (the modulation centre, mirroring the audio +
 * cv-bridge knob semantics), and return the effective value to write.
 *
 * Reuses scaleCv (linear mode) — the SAME helper the cv-bridge uses — so a ±1
 * CV sweeps the param's FULL natural range. `knob` is the param's current value
 * (read live by the caller).
 */
export function scaleRoutedValue(
  raw: number,
  knob: number,
  min: number,
  max: number,
): number {
  return scaleCv(raw, knob, min, max, { mode: 'linear' });
}
