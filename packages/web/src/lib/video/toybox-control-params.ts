// packages/web/src/lib/video/toybox-control-params.ts
//
// TOYBOX → CONTROL-SURFACE param adapter (PURE: no Yjs txn, no GL).
//
// PROBLEM. The Control Surface aggregates POINTERS to other modules' controls
// keyed by {moduleId, paramId}. For a normal module that maps 1:1 onto a flat
// `node.params[paramId]` and a ParamDef from getModuleDef/getVideoModuleDef.
// TOYBOX breaks BOTH assumptions:
//   - its def declares NO params (`params: []`) — a runtime-chosen shader has no
//     statically-declarable uniform list, so paramDefFor() finds nothing and the
//     binding is silently dropped, and
//   - its controls do NOT live on node.params: MATERIAL fields live on
//     node.data.layers[i].material, layer-content UNIFORMS on
//     node.data.layers[i].params, and COMBINE op params on
//     node.data.combine.nodes[].params.
//
// The TOYBOX knobs (ToyboxCard.svelte) already pass the SAME paramIds this file
// resolves — material 'rotX'/'scale'/'projPosX'/…, layer uniform '<id>', combine
// 'combine:<nodeId>:<param>' — and the CV-routing system (toybox-cv-routes.ts)
// already resolves the addressed param's RANGE + an in-place setter against the
// live layers/combine. This adapter reuses that canonical schema (MATERIAL_PARAMS,
// IMAGE_VIDEO_PARAMS, OP_PARAMS, getContentMeta) so a surface edit, a card edit,
// a CV write, and a MIDI assign all read/write the IDENTICAL live location.
//
// LAYER RESOLUTION. The flat material/uniform paramIds carry no layer index (the
// card targets its `activeLayer`; MIDI keys on moduleId:paramId, also index-free).
// We resolve deterministically to the FIRST layer that OWNS the param: the first
// OBJ layer for a material id, the first image/video layer for opacity/brightness,
// the first shader/gen/frag layer whose content declares the uniform. This matches
// the overwhelmingly-common single-content-layer TOYBOX and stays stable across
// re-renders (unlike a card-local `activeLayer`).
//
// Unit-tested in toybox-control-params.test.ts; consumed by
// ui/modules/ControlSurfaceCard.svelte (via graph/control-surface-params.ts).

import type { ParamDef } from '$lib/graph/types';
import {
  LAYER_COUNT,
  getContentMeta,
  makeDefaultObjMaterial,
  DEFAULT_PROJ,
  DEFAULT_PROJ_FOV,
  type ToyboxLayer,
  type ToyboxObjMaterial,
} from './toybox-content';
import {
  MATERIAL_PARAMS,
  MATERIAL_PARAM_PREFIX,
  IMAGE_VIDEO_PARAMS,
} from './toybox-cv-routes';
import {
  OP_PARAMS,
  isCombineGraph,
  combineNodeDisplayName,
  type ToyboxCombineGraph,
  type ToyboxOpKind,
} from './toybox-combine-graph';

const DEF_MAT = makeDefaultObjMaterial();

/** A resolved control: its ParamDef (for the proxied Knob) + live get/set that
 *  read/write the SAME location the card knob, the CV route, and MIDI all use. */
export interface ResolvedToyboxParam {
  def: ParamDef;
  /** Current live value (defaulted to the def default when unset). */
  get(): number;
  /** Write `value` into the live layer/combine param object, in place. */
  set(value: number): void;
}

/**
 * The FULL set of OBJ-material controls the card exposes as knobs, with the
 * card's EXACT ranges/defaults — a superset of the CV-targetable MATERIAL_PARAMS
 * (which omit the projective/surfaceMix fields). The CV-overlapping eight reuse
 * MATERIAL_PARAMS' ranges; the projective + surfaceMix entries carry the ranges
 * from ToyboxCard's projector knobs (kept in lock-step here).
 *
 * `field` is the key on ToyboxObjMaterial; `id` is the surface/MIDI paramId (the
 * bare field name — exactly what ToyboxCard's `paramId="rotX"` etc. pass; NOT the
 * CV system's 'material:'-prefixed id).
 */
interface MaterialControlDef {
  field: keyof ToyboxObjMaterial;
  id: string;
  label: string;
  min: number;
  max: number;
  default: number;
  curve: ParamDef['curve'];
}

/** Build the material control table, reusing MATERIAL_PARAMS' ranges. */
function buildMaterialControls(): MaterialControlDef[] {
  // The eight CV-targetable transform/spin/tint fields (ranges from the CV
  // schema; defaults from makeDefaultObjMaterial — the card's defaults).
  const base: MaterialControlDef[] = MATERIAL_PARAMS.map((p) => ({
    field: p.field as keyof ToyboxObjMaterial,
    id: p.field, // bare field name — the card's paramId
    label: p.label,
    min: p.min,
    max: p.max,
    default: num((DEF_MAT as unknown as Record<string, number>)[p.field], 0),
    curve: 'linear' as const,
  }));
  // The card also exposes these material knobs (NOT in the CV target set);
  // ranges/defaults mirror ToyboxCard's projector + SURF MIX knobs.
  const extra: MaterialControlDef[] = [
    { field: 'surfaceMix', id: 'surfaceMix', label: 'SURF MIX', min: 0, max: 1, default: 1, curve: 'linear' },
    { field: 'projPosX', id: 'projPosX', label: 'POS X', min: -5, max: 5, default: DEFAULT_PROJ.posX, curve: 'linear' },
    { field: 'projPosY', id: 'projPosY', label: 'POS Y', min: -5, max: 5, default: DEFAULT_PROJ.posY, curve: 'linear' },
    { field: 'projPosZ', id: 'projPosZ', label: 'POS Z', min: -5, max: 5, default: DEFAULT_PROJ.posZ, curve: 'linear' },
    { field: 'projDirX', id: 'projDirX', label: 'DIR X', min: -1, max: 1, default: DEFAULT_PROJ.dirX, curve: 'linear' },
    { field: 'projDirY', id: 'projDirY', label: 'DIR Y', min: -1, max: 1, default: DEFAULT_PROJ.dirY, curve: 'linear' },
    { field: 'projDirZ', id: 'projDirZ', label: 'DIR Z', min: -1, max: 1, default: DEFAULT_PROJ.dirZ, curve: 'linear' },
    { field: 'projFov', id: 'projFov', label: 'FOV', min: 0.2, max: 2.6, default: DEFAULT_PROJ_FOV, curve: 'linear' },
  ];
  return [...base, ...extra];
}

const MATERIAL_CONTROLS: readonly MaterialControlDef[] = buildMaterialControls();
const MATERIAL_BY_ID = new Map(MATERIAL_CONTROLS.map((c) => [c.id, c]));

/** True if `paramId` is a TOYBOX combine param (`combine:<nodeId>:<param>`). */
export function isToyboxCombineParamId(paramId: string): boolean {
  return paramId.startsWith('combine:');
}

/** Parse `combine:<nodeId>:<param>` → its parts (nodeId may itself contain no
 *  colon; param is the segment after the SECOND colon). Returns null if it isn't
 *  a combine paramId or is malformed. */
export function parseCombineParamId(
  paramId: string,
): { nodeId: string; param: string } | null {
  if (!isToyboxCombineParamId(paramId)) return null;
  const rest = paramId.slice('combine:'.length);
  const sep = rest.indexOf(':');
  if (sep <= 0) return null;
  const nodeId = rest.slice(0, sep);
  const param = rest.slice(sep + 1);
  if (!nodeId || !param) return null;
  return { nodeId, param };
}

function num(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

/** Find the first layer (and its index) satisfying `pred`, scanning 0..LAYER_COUNT-1. */
function firstLayer(
  layers: readonly ToyboxLayer[] | undefined,
  pred: (l: ToyboxLayer) => boolean,
): { layer: ToyboxLayer; index: number } | null {
  if (!Array.isArray(layers)) return null;
  for (let i = 0; i < Math.min(LAYER_COUNT, layers.length); i++) {
    const l = layers[i];
    if (l && pred(l)) return { layer: l, index: i };
  }
  return null;
}

// ---------------- material resolution ----------------

function resolveMaterial(
  layers: readonly ToyboxLayer[] | undefined,
  paramId: string,
): ResolvedToyboxParam | null {
  const ctl = MATERIAL_BY_ID.get(paramId);
  if (!ctl) return null;
  const found = firstLayer(layers, (l) => l.kind === 'obj');
  if (!found || !found.layer.material) return null;
  const material = found.layer.material as unknown as Record<string, number>;
  const def: ParamDef = {
    id: paramId,
    label: ctl.label,
    defaultValue: ctl.default,
    min: ctl.min,
    max: ctl.max,
    curve: ctl.curve,
  };
  return {
    def,
    get: () => num(material[ctl.field as string], ctl.default),
    set: (v) => { material[ctl.field as string] = v; },
  };
}

// ---------------- layer-uniform / image-video resolution ----------------

function resolveLayerParam(
  layers: readonly ToyboxLayer[] | undefined,
  paramId: string,
): ResolvedToyboxParam | null {
  // IMAGE/VIDEO layer params (opacity / brightness) — same ids on layer.params.
  const ivDef = IMAGE_VIDEO_PARAMS.find((p) => p.id === paramId);
  if (ivDef) {
    const found = firstLayer(
      layers,
      (l) => (l.kind === 'image' || l.kind === 'video') && !!l.params,
    );
    if (found && found.layer.params) {
      const params = found.layer.params;
      const def: ParamDef = {
        id: paramId,
        label: ivDef.label,
        defaultValue: ivDef.default,
        min: ivDef.min,
        max: ivDef.max,
        curve: 'linear',
      };
      return {
        def,
        get: () => num(params[paramId], ivDef.default),
        set: (v) => { params[paramId] = v; },
      };
    }
    // fall through: a content uniform could share an id (unlikely) — try below.
  }
  // Content (shader/gen/frag) uniform — find the first such layer that DECLARES it.
  const found = firstLayer(layers, (l) => {
    if (l.kind !== 'shader' && l.kind !== 'gen' && l.kind !== 'frag') return false;
    if (!l.contentId) return false;
    const meta = getContentMeta(l.contentId);
    return !!meta?.params.some((p) => p.id === paramId);
  });
  if (!found) return null;
  const meta = found.layer.contentId ? getContentMeta(found.layer.contentId) : undefined;
  const pdef = meta?.params.find((p) => p.id === paramId);
  if (!pdef) return null;
  if (!found.layer.params) return null;
  const params = found.layer.params;
  const def: ParamDef = {
    id: paramId,
    label: pdef.label,
    defaultValue: pdef.default,
    min: pdef.min,
    max: pdef.max,
    curve: pdef.curve === 'discrete' ? 'linear' : pdef.curve,
  };
  return {
    def,
    get: () => num(params[paramId], pdef.default),
    set: (v) => { params[paramId] = v; },
  };
}

// ---------------- combine resolution ----------------

function resolveCombine(
  combine: unknown,
  paramId: string,
): ResolvedToyboxParam | null {
  const parsed = parseCombineParamId(paramId);
  if (!parsed) return null;
  if (!isCombineGraph(combine)) return null;
  const g = combine as ToyboxCombineGraph;
  const n = g.nodes.find((x) => x.id === parsed.nodeId);
  if (!n || n.kind === 'source' || n.kind === 'output') return null;
  const defs = OP_PARAMS[n.kind as ToyboxOpKind] ?? [];
  const pdef = defs.find((p) => p.id === parsed.param);
  if (!pdef) return null;
  if (!n.params) n.params = {};
  const params = n.params;
  const opLabel = combineNodeDisplayName(g, parsed.nodeId);
  const def: ParamDef = {
    id: paramId,
    label: `${opLabel} ${pdef.label}`,
    defaultValue: pdef.default,
    min: pdef.min,
    max: pdef.max,
    curve: 'linear',
  };
  return {
    def,
    get: () => num(params[parsed.param], pdef.default),
    set: (v) => { params[parsed.param] = v; },
  };
}

// ---------------- public entry ----------------

/**
 * Resolve a TOYBOX surface/MIDI paramId against a LIVE toybox node, returning the
 * param's ParamDef + an in-place get/set bound to the same live layer/combine
 * object the card + CV route + MIDI all touch — or null when the param can't be
 * resolved (no matching layer/op, no such uniform, malformed combine id, etc.).
 *
 * `node` is the LIVE store-backed node (mutating the returned set() writes into
 * node.data.layers / node.data.combine in place, so the change is visible to the
 * next render and rides the Y.Doc — when called inside a store transaction).
 *
 * PURE except for the returned set()'s mutation of the live param object.
 */
export function resolveToyboxParam(
  node: { data?: unknown } | undefined,
  paramId: string,
): ResolvedToyboxParam | null {
  if (!node || !paramId) return null;
  const data = node.data as { layers?: ToyboxLayer[]; combine?: unknown } | undefined;
  const layers = Array.isArray(data?.layers) ? data!.layers : undefined;

  if (isToyboxCombineParamId(paramId)) {
    return resolveCombine(data?.combine, paramId);
  }
  // A bare name can be BOTH a material field AND a content uniform (e.g. 'scale').
  // Prefer the material binding when an OBJ layer owns it (the card shows material
  // knobs for OBJ layers); otherwise fall through to a layer-content uniform /
  // image-video param so a shader-layer 'scale' still resolves.
  if (MATERIAL_BY_ID.has(paramId)) {
    const mat = resolveMaterial(layers, paramId);
    if (mat) return mat;
  }
  return resolveLayerParam(layers, paramId);
}
