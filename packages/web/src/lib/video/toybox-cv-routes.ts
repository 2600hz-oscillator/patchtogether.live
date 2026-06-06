// packages/web/src/lib/video/toybox-cv-routes.ts
//
// TOYBOX CV/modulation routing model + resolution (PURE: no Yjs, no GL).
//
// A TOYBOX layer's shader (and thus its float uniforms) is chosen at RUNTIME,
// so we cannot statically declare a CV input port per possible uniform.
// Instead the def exposes a FIXED POOL of generic input ports (cv1..cv6) — the
// Structure-style modulation section. Each accepts EITHER a CV or an AUDIO
// source (auto-detected at the bridge — see modules/toybox.ts + engine.ts), and
// a data-driven ROUTING MAP (node.data.cvRoutes) says which addressed param
// each port drives, plus a per-input bipolar SCALE (attenuverter) and OFFSET.
//
// The factory's setParam(cvN, value) looks up the route, resolves the target
// param's declared min/max, applies the per-input SCALE + OFFSET in normalized
// 0..1 space, maps that across the param range, and writes it into the live
// layer/combine param so the render updates next frame. The SCALE/OFFSET math
// is the PURE helper `effectiveCvValue` (unit-tested in toybox-cv-math.ts).
//
// The generic cv ports stay neutral-linear (the bridge does NOT scale them —
// they have a cvScale:{mode:'linear'} hint but NO paramTarget, so
// buildCvBridgeMapping degrades to raw passthrough and hands setParam the raw
// signal). TOYBOX does the per-target SCALE/OFFSET + range mapping HERE, because
// only the route knows which param — and thus which range — the value targets.
//
// This file is the SINGLE SOURCE OF TRUTH for:
//   - the cv pool size + port ids (def + card + tests share these),
//   - the route shape (incl. per-input scale/offset),
//   - what params each target (a layer's content / an OBJ material / a combine
//     op node) exposes, with their declared min/max (the map range).
//
// Unit-tested in toybox-cv-routes.test.ts; the pure SCALE/OFFSET math in
// toybox-cv-math.test.ts; consumed by modules/toybox.ts (setParam),
// ToyboxCard.svelte (the modulation section), and graph/toybox-cv-routes.ts
// (the Yjs mutator).

import {
  LAYER_COUNT,
  getContentMeta,
  type ToyboxLayer,
} from './toybox-content';
import {
  OP_PARAMS,
  isCombineGraph,
  combineDisplayNames,
  type ToyboxCombineGraph,
  type ToyboxOpKind,
} from './toybox-combine-graph';

import {
  DEFAULT_INPUT_SCALE,
  DEFAULT_INPUT_OFFSET,
} from './toybox-cv-math';

export {
  effectiveCvValue,
  effectiveNorm,
  foldCvToUnipolar,
  followEnvelope,
  makeEnvelopeFollower,
  DEFAULT_INPUT_SCALE,
  DEFAULT_INPUT_OFFSET,
} from './toybox-cv-math';

/** Number of generic CV/modulation input ports the def declares. */
export const CV_PORT_COUNT = 6;

/** The fixed pool of generic input port ids: 'cv1'..'cv6'. */
export const CV_PORT_IDS: readonly string[] = Array.from(
  { length: CV_PORT_COUNT },
  (_, i) => `cv${i + 1}`,
);

/** True if `portId` is one of the generic input pool ports (cv1..cv6). */
export function isCvPortId(portId: string): boolean {
  return CV_PORT_IDS.includes(portId);
}

/** One routing target: which addressable param a generic input port drives.
 *   - target 'layer': layer[layer].param — a content uniform OR (for an OBJ
 *     layer) a material transform/tint field (param prefixed 'material:').
 *   - target 'combine': the combine GRAPH op node `nodeId`'s float param.
 *
 *  The per-input SCALE/OFFSET do NOT live here — they live in a SIBLING map
 *  (`node.data.cvInputs`, see CvInput below), because OFFSET must be the manual
 *  control value even with NO route, and a null route has nowhere to hang it. */
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

/**
 * One input's modulation-shaping controls: the bipolar attenuverter (SCALE,
 * −1..+1: 0 = off, +1 = full positive depth, <0 inverts) and the OFFSET
 * (0..1: the manual / no-cable control value). Lives in a SIBLING map keyed by
 * cv port id (`node.data.cvInputs`), INDEPENDENT of the route — so the OFFSET
 * acts as a manual control even when the port has no route AND no cable (then
 * the param parks at `min + offset*(max-min)`; see applyUnpatchedOffsets).
 */
export interface CvInput {
  /** Bipolar attenuverter, −1..+1 (center 0 = off, <0 inverts). */
  scale: number;
  /** Manual / no-cable control value, 0..1 (0 = min, 1 = full range). */
  offset: number;
}

/** The persisted per-input scale/offset map, keyed by cv port id. */
export type CvInputs = Partial<Record<string, CvInput | null>>;

/** Read one input's scale/offset off a live cvInputs map, filling defaults.
 *  Defaults: scale = DEFAULT_INPUT_SCALE (+1, full passthrough — a fresh cable
 *  modulates immediately), offset = DEFAULT_INPUT_OFFSET (0). */
export function getCvInput(
  inputs: CvInputs | undefined | null,
  portId: string,
): CvInput {
  const e = inputs && typeof inputs === 'object' ? inputs[portId] : undefined;
  return {
    scale: typeof e?.scale === 'number' && Number.isFinite(e.scale) ? e.scale : DEFAULT_INPUT_SCALE,
    offset:
      typeof e?.offset === 'number' && Number.isFinite(e.offset) ? e.offset : DEFAULT_INPUT_OFFSET,
  };
}

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

// ---------------- IMAGE / VIDEO layer param schema (#57) ----------------
//
// An image/video-kind layer renders a still / video frame through the input
// pass. Those passes now read two layer-level float params so the layer is a
// usable CV target (#57): OPACITY (the layer's alpha — how much it contributes
// when composited) and BRIGHTNESS (an RGB gain, the `uGain` the input shader
// already declared). They live on the layer's `params` Record (every layer
// carries one), so they round-trip through save/load like a shader uniform and
// resolveRoute writes them in place. The factory's renderImageLayer /
// renderVideoLayer read these each frame.

export interface ToyboxImageVideoParamDef {
  id: string;
  label: string;
  min: number;
  max: number;
  default: number;
}

/** Float params an IMAGE/VIDEO layer exposes (CV-target + manual). */
export const IMAGE_VIDEO_PARAMS: readonly ToyboxImageVideoParamDef[] = [
  { id: 'opacity', label: 'OPACITY', min: 0, max: 1, default: 1 },
  { id: 'brightness', label: 'BRIGHT', min: 0, max: 2, default: 1 },
];

/** Read an image/video layer param off the layer's params map, defaulting. */
export function imageVideoParamValue(
  params: Record<string, number> | undefined | null,
  id: string,
): number {
  const def = IMAGE_VIDEO_PARAMS.find((p) => p.id === id);
  const v = params && typeof params === 'object' ? params[id] : undefined;
  return typeof v === 'number' && Number.isFinite(v) ? v : def?.default ?? 0;
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

/** Short tag for a layer kind, shown in its CV-target label. IMAGE/VIDEO are
 *  tagged correctly (#57) so they no longer masquerade as 'SHD'. */
function layerKindTag(kind: ToyboxLayer['kind'] | undefined): string {
  switch (kind) {
    case 'obj': return 'OBJ';
    case 'off': return 'OFF';
    case 'image': return 'IMG';
    case 'video': return 'VID';
    case 'shader': case 'gen': case 'frag': return 'SHD';
    default: return 'OFF';
  }
}

/**
 * Enumerate the targets the CV tab offers: the 4 layers + every combine op
 * node (sources/output have no params, so they're excluded). Pure over the
 * live layers + combine graph.
 *
 * Labels are 1-based (#56): "Layer 1 (SHD)" .. "Layer 4 (...)" — the INDEX
 * stays 0-based (in `value`/`layer`) so patches/presets don't break. Combine
 * ops use their UNIQUE ordinal display name (#58): "CHROMA 1", "LUMA 2", …
 * instead of a raw kind, so two same-kind nodes are distinguishable.
 */
export function listCvTargets(
  layers: readonly ToyboxLayer[] | undefined,
  combine: unknown,
): CvTargetOption[] {
  const out: CvTargetOption[] = [];
  for (let i = 0; i < LAYER_COUNT; i++) {
    const layer = layers?.[i];
    out.push({
      value: `layer:${i}`,
      label: `Layer ${i + 1} (${layerKindTag(layer?.kind)})`,
      target: 'layer',
      layer: i,
    });
  }
  if (isCombineGraph(combine)) {
    const g = combine as ToyboxCombineGraph;
    const names = combineDisplayNames(g);
    for (const n of g.nodes) {
      if (n.kind === 'source' || n.kind === 'output') continue;
      out.push({
        value: `combine:${n.id}`,
        label: names.get(n.id) ?? n.id,
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
    // IMAGE / VIDEO layers expose OPACITY + BRIGHTNESS as CV targets (#57).
    if (layer.kind === 'image' || layer.kind === 'video') {
      return IMAGE_VIDEO_PARAMS.map((p) => ({ id: p.id, label: p.label, min: p.min, max: p.max }));
    }
    if (layer.kind === 'shader' || layer.kind === 'gen' || layer.kind === 'frag') {
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

// ---------------- Orphan detection (auto-unmap) ----------------

/**
 * Find the cv ports whose route is now ORPHANED — its target layer/node no
 * longer exists, became an un-routable kind (e.g. an 'off' layer), or its param
 * is no longer in that target's schema. Returns the list of port ids whose
 * route should be cleared (#60: when a change orphans a mapped CV, auto-unmap
 * it). PURE: resolveRoute returns null for any unresolvable route, so "orphaned"
 * is exactly "has a route that no longer resolves".
 *
 * A null/absent route is NOT orphaned (it's already unmapped). Only ports with a
 * non-null route that fails to resolve are reported.
 */
export function findOrphanedRoutes(
  routes: CvRoutes | undefined | null,
  layers: readonly ToyboxLayer[] | undefined,
  combine: unknown,
): string[] {
  if (!routes || typeof routes !== 'object') return [];
  const out: string[] = [];
  for (const portId of Object.keys(routes)) {
    const route = routes[portId];
    if (!route) continue; // already unmapped
    if (resolveRoute(route, layers, combine) === null) out.push(portId);
  }
  return out;
}

// ---------------- Resolve + re-scale (the setParam hot path) ----------------

/** The resolved write target: the param's range, the param's CURRENT value, and
 *  a setter that writes the mapped value into the live layer/combine param
 *  object in place. */
export interface ResolvedRoute {
  min: number;
  max: number;
  /** The param's CURRENT value (defaulted to the schema default when unset).
   *  Surfaced for the card's live read-back; the value WRITTEN is computed by
   *  effectiveCvValue(signal, scale, offset, min, max) (no longer centred on
   *  this value — the attenuverter/offset model is absolute, not relative). */
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
    // IMAGE / VIDEO layer param (opacity / brightness) — stored on layer.params.
    if (layer.kind === 'image' || layer.kind === 'video') {
      const def = IMAGE_VIDEO_PARAMS.find((p) => p.id === route.param);
      if (!def) return null;
      if (!layer.params) return null;
      const params = layer.params;
      const cur = params[route.param];
      return {
        min: def.min,
        max: def.max,
        current: typeof cur === 'number' ? cur : def.default,
        apply: (v) => { params[route.param] = v; },
      };
    }
    // Content (shader/gen/frag) uniform.
    if (layer.kind !== 'shader' && layer.kind !== 'gen' && layer.kind !== 'frag') return null;
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

