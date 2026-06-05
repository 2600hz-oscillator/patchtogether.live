// packages/web/src/lib/graph/toybox-layers.ts
//
// TOYBOX per-layer editing — Yjs mutators for node.data.layers[<index>].
//
// The card edits ANY of the LAYER_COUNT layers (the layer-INDEX selector picks
// which). Each layer's kind / contentId / params / material live in
// node.data.layers[i]; the video factory reads them live per-frame, and the
// writes ride the Y.Doc out to rack-mates.
//
// CRITICAL (the in-place trap — same as toybox-combine.ts / toybox-presets.ts /
// [[yjs-save-load-real-ydoc]]): once node.data.layers has synced, its entries
// are live Y.Maps and `layers[i].params` / `.material` are live Y types. We must
// NEVER spread-and-reassign a live Y type into a fresh array/object (Yjs throws
// "Type already integrated"). So every mutator here:
//   - assigns SCALAR fields directly (layer.kind = x, material.matcap = n), and
//   - REPLACES a sub-object's contents by clearing-in-place then re-setting keys
//     (params), pushing only plain objects when a fresh layer/material is seeded.
//
// All writes go through the patch proxy inside ONE LOCAL_ORIGIN transaction.
// The pure-ish ensureLayer* helpers below are also driveable without a txn for
// unit tests (the patch proxy still routes them through the Y.Doc).

import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
import {
  DEFAULT_CONTENT_ID,
  DEFAULT_FRAG_CONTENT_ID,
  DEFAULT_MODEL_ID,
  LAYER_COUNT,
  getContentMeta,
  getModelMeta,
  makeDefaultLayers,
  makeDefaultObjMaterial,
  type ToyboxLayer,
  type ToyboxLayerKind,
  type ToyboxObjMaterial,
  type ToyboxSurfaceMode,
  type ToyboxVideoSource,
} from '$lib/video/toybox-content';

/** The valid VIDEO-source values (kept in sync with ToyboxVideoSource). */
const VIDEO_SOURCES: readonly ToyboxVideoSource[] = ['inA', 'inB', 'file', 'camera'];

/** Map a content family tag to the layer kind it materialises as. */
function kindForFamily(family: string | undefined): ToyboxLayerKind {
  if (family === 'GEN') return 'gen';
  if (family === 'FRAG') return 'frag';
  return 'shader'; // FX (and any legacy family) → 'shader'
}

/** Clamp an arbitrary value to a valid layer index (0..LAYER_COUNT-1). */
export function clampLayerIndex(i: unknown): number {
  const n = typeof i === 'number' && Number.isFinite(i) ? Math.floor(i) : 0;
  return Math.min(LAYER_COUNT - 1, Math.max(0, n));
}

/**
 * Ensure node.data.layers exists (seed a fully-defaulted array in place if
 * absent/empty), then ensure the entry at `index` exists, and return it. The
 * returned layer is the LIVE, store-backed object (mutate its fields directly).
 * Returns null if the node doesn't exist.
 */
export function ensureLayer(nodeId: string, index: number): ToyboxLayer | null {
  const idx = clampLayerIndex(index);
  const target = patch.nodes[nodeId];
  if (!target) return null;
  if (!target.data) (target as { data: Record<string, unknown> }).data = {};
  const d = target.data as { layers?: ToyboxLayer[] };
  if (!Array.isArray(d.layers) || d.layers.length === 0) d.layers = makeDefaultLayers();
  // Pad to LAYER_COUNT in place (push plain 'off' layers) so any index resolves.
  while (d.layers.length < LAYER_COUNT) {
    d.layers.push({ kind: 'off', contentId: null, params: {} });
  }
  return d.layers[idx]!;
}

/** Ensure layer `index` has a material object + return it (live, mutable). */
export function ensureMaterial(nodeId: string, index: number): ToyboxObjMaterial | null {
  const layer = ensureLayer(nodeId, index);
  if (!layer) return null;
  if (!layer.material) layer.material = makeDefaultObjMaterial();
  return layer.material;
}

/**
 * Set a layer's KIND. Seeds the kind's default content in place when switching
 * an empty/uninitialised layer INTO a renderable kind (mirrors the card's
 * original layer-0 init):
 *   - 'obj' → seed a material (+ default model + its preferred matcap) if absent.
 *   - 'gen' | 'shader' → seed a generative contentId + param defaults if absent.
 *   - 'frag' → seed a FRAG contentId (a Shadertoy shader that receives the
 *     composited layers below as iChannel0) + its param defaults if absent.
 *   - 'image' / 'video' → just set the kind (the card drives the file picker;
 *     image bytes / video metadata land on the layer when a file is chosen).
 *   - 'off' → just set the kind.
 */
export function setLayerKind(nodeId: string, index: number, kind: ToyboxLayerKind): void {
  ydoc.transact(() => {
    const layer = ensureLayer(nodeId, index);
    if (!layer) return;
    layer.kind = kind;
    if (kind === 'obj') {
      if (!layer.material) {
        const mat = makeDefaultObjMaterial(DEFAULT_MODEL_ID);
        const mm = getModelMeta(DEFAULT_MODEL_ID);
        if (mm && typeof mm.matcap === 'number') mat.matcap = mm.matcap;
        layer.material = mat;
      }
    } else if (kind === 'frag') {
      // Switching INTO frag: if there's no FRAG/Shadertoy content selected yet,
      // seed the default FRAG shader. A layer that already had gen/shader content
      // keeps it (a FX shader can run as a scene-input FRAG too).
      if (!layer.contentId) {
        const meta = getContentMeta(DEFAULT_FRAG_CONTENT_ID);
        layer.contentId = DEFAULT_FRAG_CONTENT_ID;
        setParamsInPlace(layer, meta ? Object.fromEntries(meta.params.map((p) => [p.id, p.default])) : {});
      }
    } else if (kind === 'gen' || kind === 'shader') {
      if (!layer.contentId) {
        const meta = getContentMeta(DEFAULT_CONTENT_ID);
        layer.contentId = DEFAULT_CONTENT_ID;
        layer.kind = kindForFamily(meta?.family);
        setParamsInPlace(layer, meta ? Object.fromEntries(meta.params.map((p) => [p.id, p.default])) : {});
      }
    }
  }, LOCAL_ORIGIN);
}

/**
 * Select a fragment-shader/gen content for a layer. Resolves the kind from the
 * content family + resets params to the content's manifest defaults (so faders
 * start sensibly), all IN PLACE on the live layer.
 */
export function setLayerContent(nodeId: string, index: number, contentId: string): void {
  const meta = getContentMeta(contentId);
  if (!meta) return;
  ydoc.transact(() => {
    const layer = ensureLayer(nodeId, index);
    if (!layer) return;
    layer.kind = kindForFamily(meta.family);
    layer.contentId = contentId;
    setParamsInPlace(layer, Object.fromEntries(meta.params.map((p) => [p.id, p.default])));
  }, LOCAL_ORIGIN);
}

/** Set one float param on a layer (the content faders). In place on .params. */
export function setLayerParam(nodeId: string, index: number, pid: string, value: number): void {
  ydoc.transact(() => {
    const layer = ensureLayer(nodeId, index);
    if (!layer) return;
    if (!layer.params) layer.params = {};
    layer.params[pid] = value;
  }, LOCAL_ORIGIN);
}

/** Pick the OBJ model for a layer; also adopt the model's preferred matcap. */
export function setLayerModel(nodeId: string, index: number, modelId: string): void {
  ydoc.transact(() => {
    const mat = ensureMaterial(nodeId, index);
    if (!mat) return;
    mat.modelId = modelId;
    const mm = getModelMeta(modelId);
    if (mm && typeof mm.matcap === 'number') mat.matcap = mm.matcap;
  }, LOCAL_ORIGIN);
}

/** Set the OBJ matcap style index for a layer. */
export function setLayerMatcap(nodeId: string, index: number, matcap: number): void {
  ydoc.transact(() => {
    const mat = ensureMaterial(nodeId, index);
    if (!mat) return;
    mat.matcap = Number.isFinite(matcap) ? matcap : 0;
  }, LOCAL_ORIGIN);
}

/**
 * Pick the OBJ SURFACE source: -1 (MATCAP) or a layer INDEX (0..LAYER_COUNT-1)
 * whose rendered output UV-maps onto the mesh. Scalar in-place set.
 */
export function setLayerSurfaceSource(nodeId: string, index: number, source: number): void {
  ydoc.transact(() => {
    const mat = ensureMaterial(nodeId, index);
    if (!mat) return;
    mat.surfaceSource = Number.isFinite(source) && source >= 0 ? source : -1;
  }, LOCAL_ORIGIN);
}

/** Set one numeric OBJ-material field (transform/spin/tint/surfaceMix). */
export function setLayerMaterialField(
  nodeId: string,
  index: number,
  key: keyof ToyboxObjMaterial,
  value: number,
): void {
  ydoc.transact(() => {
    const mat = ensureMaterial(nodeId, index);
    if (!mat) return;
    (mat as unknown as Record<string, number>)[key as string] = value;
  }, LOCAL_ORIGIN);
}

/**
 * Set the OBJ SURFACE-mapping mode (Phase 7): 'uv' (sample the source by mesh
 * UVs — the default) or 'projective' (project the source from a viewpoint).
 * Scalar string field, in place.
 */
export function setLayerSurfaceMode(
  nodeId: string,
  index: number,
  mode: ToyboxSurfaceMode,
): void {
  ydoc.transact(() => {
    const mat = ensureMaterial(nodeId, index);
    if (!mat) return;
    mat.surfaceMode = mode === 'projective' ? 'projective' : 'uv';
  }, LOCAL_ORIGIN);
}

/**
 * Set an IMAGE layer's encoded bytes + filename (PICTUREBOX-style; both ride the
 * Y.Doc so rack-mates see the same picture). Pass bytes=null to clear back to the
 * idle pattern. Writes both fields in ONE transact so peers see one update.
 */
export function setLayerImage(
  nodeId: string,
  index: number,
  bytes: string | null,
  name: string | null,
): void {
  ydoc.transact(() => {
    const layer = ensureLayer(nodeId, index);
    if (!layer) return;
    layer.imageBytes = bytes;
    layer.imageName = name;
  }, LOCAL_ORIGIN);
}

/**
 * Set a VIDEO layer's filename metadata (VIDEOBOX-style: only the NAME rides the
 * Y.Doc — the bytes are local-file + card-owned). Replaces videoMeta in place
 * (or seeds it). Pass null to clear.
 */
export function setLayerVideoName(nodeId: string, index: number, name: string | null): void {
  ydoc.transact(() => {
    const layer = ensureLayer(nodeId, index);
    if (!layer) return;
    if (!layer.videoMeta || typeof layer.videoMeta !== 'object') {
      layer.videoMeta = { name };
    } else {
      layer.videoMeta.name = name;
    }
  }, LOCAL_ORIGIN);
}

/**
 * Set a VIDEO layer's SOURCE: 'inA'/'inB' (a patched feed off the TOYBOX video
 * input port), 'file' (a local-file <video>), or 'camera' (the webcam). Scalar
 * in-place set (no Y-type reassign). An unrecognised value falls back to 'file'
 * (the #603 default). The factory reads layer.videoSource live each frame to
 * pick where renderVideoLayer pulls the texture.
 */
export function setLayerVideoSource(
  nodeId: string,
  index: number,
  source: ToyboxVideoSource,
): void {
  const next: ToyboxVideoSource = VIDEO_SOURCES.includes(source) ? source : 'file';
  ydoc.transact(() => {
    const layer = ensureLayer(nodeId, index);
    if (!layer) return;
    layer.videoSource = next;
  }, LOCAL_ORIGIN);
}

/** Replace a layer's params map contents IN PLACE (clear keys, then set fresh).
 *  Never reassigns the .params object if it already exists (a live Y.Map). */
function setParamsInPlace(layer: ToyboxLayer, params: Record<string, number>): void {
  if (!layer.params || typeof layer.params !== 'object') {
    layer.params = { ...params };
    return;
  }
  const cur = layer.params;
  for (const k of Object.keys(cur)) delete cur[k];
  for (const [k, v] of Object.entries(params)) cur[k] = v;
}
