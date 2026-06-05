// packages/web/src/lib/video/toybox-content.ts
//
// TOYBOX content-bank registry. Mirrors the wavetable-presets.ts pattern:
// the catalog (id / label / family / param schema) is described by a STATIC
// manifest served from packages/web/static/toybox/manifest.json at
// /toybox/manifest.json, and the GLSL source for each entry is fetched
// lazily from /toybox/shaders/<id>.frag.glsl the first time it's selected
// (NOT bundled into the JS chunk).
//
// Structured for Phase-1 (one fragment-shader layer) but shaped to extend:
// later phases (OBJ, combine graph, presets) add new families to the
// manifest + new `kind`s without touching the card or factory's content
// plumbing — they all funnel through listShaders()/listGen()/getContent().
//
// The manifest declares each entry's float-uniform params: this is the
// SINGLE SOURCE OF TRUTH for the card faders and (Phase 2+) CV targets.

/** Param descriptor for one declared float uniform of a content shader. */
export interface ToyboxParamDef {
  /** Uniform name in the GLSL (e.g. 'speed'). Also the layer.params key. */
  id: string;
  /** Display label for the fader. */
  label: string;
  min: number;
  max: number;
  /** Default value (used when a layer hasn't set this param). */
  default: number;
  /** Fader curve hint. */
  curve: 'linear' | 'log' | 'exp' | 'discrete';
}

/** Family tag — which palette bucket the content came from.
 *   - GEN: generative content (NO scene input — Shader A synthwave, noise, …).
 *   - FX:  a fragment effect that recolours/displaces the composite below it.
 *   - FRAG: a Shadertoy fragment shader receiving the below-composite as
 *           iChannel0 (the FRAG kind in the card; recolour / displace / FX). */
export type ToyboxFamily = 'GEN' | 'FX' | 'FRAG';

/** A catalog entry: metadata + the URL to lazily fetch its GLSL. */
export interface ToyboxContent {
  /** Stable storage id (also the GLSL filename stem). */
  id: string;
  /** Display label (dropdown). */
  label: string;
  family: ToyboxFamily;
  /** Public URL of the GLSL fragment source (served by SvelteKit static). */
  glsl: string;
  /** Declared float-uniform params (card faders + later CV targets). */
  params: ToyboxParamDef[];
  /** When true, the GLSL is written in the SHADERTOY convention (`void
   *  mainImage(out vec4, in vec2)` + iTime/iResolution-as-vec3/iMouse/…) and
   *  the factory wraps it via the mainImage→main shim + the full Shadertoy
   *  uniform set. Hand-authored engine shaders (plain `main()`) omit this. */
  shadertoy?: boolean;
  /** What this content receives as iChannel0:
   *   - 'none'  (default): GENERATIVE — no scene input (GEN family).
   *   - 'scene': the COMPOSITED layers below are bound to iChannel0 (FRAG
   *              family — recolour/displace/feedback FX on the layers beneath). */
  input?: 'none' | 'scene';
}

/** A 3D model entry (Phase 3 — the OBJ layer). Either a bundled OBJ fetched
 *  lazily from `obj`, or a procedural built-in primitive named by `builtin`
 *  (no asset file). The factory generates/loads the mesh on selection. */
export interface ToyboxModel {
  /** Stable storage id (also the OBJ filename stem when `obj` is set). */
  id: string;
  /** Display label (dropdown). */
  label: string;
  /** Public URL of the bundled OBJ source. Omit for built-in primitives. */
  obj?: string;
  /** Built-in procedural primitive id; set instead of `obj` for asset-free
   *  meshes. Must be one of primitives.ts' BuiltinPrimitive ids ('cube' |
   *  'sphere' | 'torus' | 'hypercube' | 'tetrahedron' | 'octahedron' |
   *  'icosahedron' | 'cylinder' | 'cone' | 'torus-knot'). */
  builtin?:
    | 'cube'
    | 'sphere'
    | 'torus'
    | 'hypercube'
    | 'tetrahedron'
    | 'octahedron'
    | 'icosahedron'
    | 'cylinder'
    | 'cone'
    | 'torus-knot';
  /** Default matcap style index for this model (0..MATCAP_STYLES-1). */
  matcap?: number;
  /** SPDX license tag (provenance — surfaced in docs/LICENSES). */
  license?: string;
}

/** A bundled PRESET (Phase 6): a fully-specified TOYBOX patch — layers +
 *  combine GRAPH + cvRoutes — using ONLY bundled content. Selecting one writes
 *  these into node.data (in place). The combine/cvRoutes are stored as plain
 *  JSON in the manifest; the loader copies them through structuredClone-style
 *  plain-object rebuilds before pushing into the live Y types. */
export interface ToyboxPreset {
  /** Stable storage id (also the dropdown value). */
  id: string;
  /** Display label (dropdown). */
  label: string;
  /** Human note (provenance / what the preset shows). */
  note?: string;
  /** The full layer array (LAYER_COUNT entries). */
  layers: ToyboxLayer[];
  /** The combine GRAPH ({nodes,edges}) — typed loosely here to avoid a cycle
   *  with toybox-combine-graph; the loader/factory treat it as the graph. */
  combine: { nodes: unknown[]; edges: unknown[] };
  /** The CV routing map (cv1..cv8 → target/param). */
  cvRoutes: Record<string, unknown>;
}

interface ToyboxManifest {
  version: number;
  /** FX family entries. */
  shaders: ToyboxContent[];
  /** GEN family entries. */
  gen: ToyboxContent[];
  /** 3D model entries (Phase 3 OBJ layer). Optional for older manifests. */
  models?: ToyboxModel[];
  /** Bundled presets (Phase 6). Optional for older manifests. */
  presets?: ToyboxPreset[];
}

/** Public path to the static manifest. */
export const TOYBOX_MANIFEST_URL = '/toybox/manifest.json';

// ---------------- Manifest load + catalog ----------------

let manifestPromise: Promise<ToyboxManifest> | null = null;
let catalog: ToyboxContent[] | null = null;
let byId: Map<string, ToyboxContent> | null = null;
let modelCatalog: ToyboxModel[] | null = null;
let modelById: Map<string, ToyboxModel> | null = null;
let presetCatalog: ToyboxPreset[] | null = null;
let presetById: Map<string, ToyboxPreset> | null = null;

/** Fetch + parse the static manifest once; cached for the session. */
async function loadManifest(): Promise<ToyboxManifest> {
  if (!manifestPromise) {
    manifestPromise = (async () => {
      const res = await fetch(TOYBOX_MANIFEST_URL);
      if (!res.ok) {
        throw new Error(`TOYBOX manifest fetch ${TOYBOX_MANIFEST_URL} → ${res.status} ${res.statusText}`);
      }
      const json = (await res.json()) as ToyboxManifest;
      const shaders = Array.isArray(json.shaders) ? json.shaders : [];
      const gen = Array.isArray(json.gen) ? json.gen : [];
      catalog = [...gen, ...shaders];
      byId = new Map(catalog.map((c) => [c.id, c]));
      modelCatalog = Array.isArray(json.models) ? json.models : [];
      modelById = new Map(modelCatalog.map((m) => [m.id, m]));
      presetCatalog = Array.isArray(json.presets) ? json.presets : [];
      presetById = new Map(presetCatalog.map((p) => [p.id, p]));
      return json;
    })();
  }
  return manifestPromise;
}

/** Ensure the catalog is parsed (await before the sync list/lookup helpers). */
export async function ensureToyboxCatalog(): Promise<void> {
  await loadManifest();
}

/** All FX-family entries (the manifest's `shaders` array). Empty until
 *  ensureToyboxCatalog() has resolved. */
export async function listShaders(): Promise<ToyboxContent[]> {
  const m = await loadManifest();
  return m.shaders;
}

/** All GEN-family entries (the manifest's `gen` array). Empty until
 *  ensureToyboxCatalog() has resolved. */
export async function listGen(): Promise<ToyboxContent[]> {
  const m = await loadManifest();
  return m.gen;
}

/** The full combined catalog (GEN first, then FX) — what the card's content
 *  dropdown iterates. */
export async function listAllContent(): Promise<ToyboxContent[]> {
  await loadManifest();
  return catalog ?? [];
}

/** Synchronous catalog lookup — returns undefined if the manifest hasn't
 *  loaded yet OR the id is unknown. Cards/factories that have already awaited
 *  ensureToyboxCatalog() can use this on the hot path. */
export function getContentMeta(id: string): ToyboxContent | undefined {
  return byId?.get(id);
}

// ---------------- Model catalog (Phase 3 OBJ layer) ----------------

/** All model entries (the manifest's `models` array). Empty until
 *  ensureToyboxCatalog() has resolved. */
export async function listModels(): Promise<ToyboxModel[]> {
  await loadManifest();
  return modelCatalog ?? [];
}

/** Synchronous model lookup (manifest must have loaded). */
export function getModelMeta(id: string): ToyboxModel | undefined {
  return modelById?.get(id);
}

// ---------------- Preset catalog (Phase 6) ----------------

/** All bundled presets (the manifest's `presets` array). Empty until
 *  ensureToyboxCatalog() has resolved. */
export async function listPresets(): Promise<ToyboxPreset[]> {
  await loadManifest();
  return presetCatalog ?? [];
}

/** Synchronous preset lookup (manifest must have loaded). */
export function getPresetMeta(id: string): ToyboxPreset | undefined {
  return presetById?.get(id);
}

/** Fetch the manifest (if needed) then return the preset by id, or undefined. */
export async function getPreset(id: string): Promise<ToyboxPreset | undefined> {
  await loadManifest();
  return presetById?.get(id);
}

/** The default model id (first model entry) for a fresh OBJ layer. */
export const DEFAULT_MODEL_ID = 'spot';

const objCache = new Map<string, Promise<string>>();

/**
 * Fetch the OBJ source text for a model id, lazily + cached. Resolves the
 * manifest first, then fetches `model.obj`. Built-in primitives (no `obj`
 * URL) are generated procedurally by the factory and never reach here —
 * throws if called for one. Throws on unknown id or fetch error.
 */
export async function getModelObj(id: string): Promise<{ meta: ToyboxModel; obj: string }> {
  await loadManifest();
  const meta = modelById?.get(id);
  if (!meta) throw new Error(`TOYBOX: unknown model id '${id}'`);
  if (!meta.obj) throw new Error(`TOYBOX: model '${id}' is a built-in primitive (no OBJ to fetch)`);
  let p = objCache.get(id);
  if (!p) {
    p = (async () => {
      const res = await fetch(meta.obj!);
      if (!res.ok) {
        throw new Error(`TOYBOX obj fetch ${meta.obj} → ${res.status} ${res.statusText}`);
      }
      return res.text();
    })();
    objCache.set(id, p);
  }
  return { meta, obj: await p };
}

/** The default content id (first GEN entry) used when a fresh TOYBOX layer
 *  has no contentId yet. Falls back to the kdnown first-slice id so the
 *  factory has a deterministic boot even before the manifest resolves. */
export const DEFAULT_CONTENT_ID = 'noise-fbm';
/* (the default first-slice id; the manifest's first GEN entry) */

/** The default content id for a fresh FRAG layer (a Shadertoy fragment shader
 *  that receives the composited layers below as iChannel0). */
export const DEFAULT_FRAG_CONTENT_ID = 'frag-invert-scan';

// ---------------- Lazy GLSL fetch ----------------

const glslCache = new Map<string, Promise<string>>();

/**
 * Fetch the GLSL source for a content id, lazily + cached. Resolves the
 * manifest first (so an id picked before the catalog loaded still works),
 * then fetches the entry's `glsl` URL. Throws on unknown id or fetch error.
 *
 * Returns the raw fragment-shader source text (GLSL ES 300) — the factory
 * compiles it via the engine's compileFragment().
 */
export async function getContent(id: string): Promise<{ meta: ToyboxContent; glsl: string }> {
  await loadManifest();
  const meta = byId?.get(id);
  if (!meta) throw new Error(`TOYBOX: unknown content id '${id}'`);
  let glslP = glslCache.get(id);
  if (!glslP) {
    glslP = (async () => {
      const res = await fetch(meta.glsl);
      if (!res.ok) {
        throw new Error(`TOYBOX glsl fetch ${meta.glsl} → ${res.status} ${res.statusText}`);
      }
      return res.text();
    })();
    glslCache.set(id, glslP);
  }
  const glsl = await glslP;
  return { meta, glsl };
}

// ---------------- Custom disk-loaded sources (shader / OBJ) ----------------
//
// A layer can carry an INLINE source loaded from the user's disk:
//   - shaderSrc (GLSL .glsl/.frag) → compiled directly instead of fetching a
//     bundled content by id;
//   - objSrc (Wavefront .obj text) → parsed directly instead of fetching a
//     bundled model by id.
// Both are PERSISTED on the layer (ride the Y.Doc), so they survive reload and
// export cleanly. The engine keys its program/mesh caches by a SYNTHETIC id
// derived from the source text (so two layers with identical custom source share
// one compiled program, and a different source gets a fresh cache slot + its own
// inflight/failed guard).

/** Max byte size we accept for a disk-loaded shader/OBJ text source (sanity cap;
 *  the source rides the Y.Doc so it must stay small — this is NOT the separate
 *  50MB video cap). 2 MB of GLSL/OBJ text is enormous for either format. */
export const MAX_CUSTOM_SOURCE_BYTES = 2 * 1024 * 1024;

/** djb2 string hash → unsigned 32-bit, base-36. Cheap, stable, dependency-free —
 *  good enough to dedup cache slots for identical custom source text (collisions
 *  only mean two DIFFERENT sources would share a slot, which is astronomically
 *  unlikely for human-authored shaders and at worst shows the wrong custom
 *  shader, never a crash). PURE. */
function hashSource(src: string): string {
  let h = 5381;
  for (let i = 0; i < src.length; i++) {
    h = ((h << 5) + h + src.charCodeAt(i)) | 0; // h*33 + c, wrap to int32
  }
  return (h >>> 0).toString(36);
}

/** Synthetic program-cache key for an inline custom SHADER source. Stable for a
 *  given source text; distinct from any manifest content id (the `custom-shader:`
 *  prefix can never collide with a real id). PURE. */
export function customShaderKey(src: string): string {
  return `custom-shader:${hashSource(src)}`;
}

/** Synthetic mesh-cache key for an inline custom OBJ source. Distinct from any
 *  manifest model id / built-in primitive name (the `custom-obj:` prefix). PURE. */
export function customObjKey(src: string): string {
  return `custom-obj:${hashSource(src)}`;
}

/** Byte length of a UTF-8 string (for the size cap check). PURE — uses TextEncoder
 *  when available (browser + node), else falls back to a char-count approximation
 *  that is always ≥ the conservative byte count for ASCII source. */
export function utf8ByteLength(s: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length;
  // Fallback: count UTF-8 bytes manually (no TextEncoder in some old runtimes).
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { bytes += 4; i++; } // surrogate pair
    else bytes += 3;
  }
  return bytes;
}

// ---------------- Layer model (persisted in node.data.layers) ----------------

/** The kind of source a TOYBOX layer renders.
 *   - 'shader' (FX) / 'gen' (GEN): a fragment-shader content entry. GEN is
 *            generative (no scene input); a shader/FX recolours.
 *   - 'frag' (FRAG): a Shadertoy fragment shader receiving the COMPOSITED
 *            layers BELOW as iChannel0 (recolour / displace / feedback FX).
 *            Distinct from 'gen' (which gets no scene input). May itself be a
 *            single Shadertoy pass OR a multi-buffer project (layer.project).
 *   - 'obj': a 3D mesh (bundled OBJ or built-in primitive), matcap-shaded
 *            into the layer's FBO with depth testing (Phase 3).
 *   - 'image': a still image (PICTUREBOX-style: file → ImageBitmap →
 *              texImage2D). The image bytes ride the Y.Doc (data on the layer)
 *              so rack-mates see the same picture; each peer decodes + uploads
 *              into the layer's FBO. Silent (idle pattern) until a file is set.
 *   - 'video': a local-file video player (VIDEOBOX-style: File → <video> →
 *              GL texture via the frame-upload pump, looping). The element is
 *              card-owned + LOCAL (video bytes are not synced — only the file
 *              metadata, like VIDEOBOX). Silent until a file is set.
 *   - 'off': explicitly empty (renders nothing). */
export type ToyboxLayerKind = 'shader' | 'gen' | 'frag' | 'obj' | 'image' | 'video' | 'off';

/** How an OBJ layer maps its SURFACE source onto the mesh (Phase 7 projection):
 *   - 'uv': the source FBO is sampled by the mesh's own UV coords (the Phase-6
 *           default texmap).
 *   - 'projective': the source is PROJECTED onto the mesh from a viewpoint (a
 *           projector view-projection). Each fragment's world position is
 *           transformed into the projector's clip space and the source sampled
 *           there, with front-facing + in-frustum guards (no back-wrap, no
 *           projection behind the projector). This is the "video projector
 *           mapped onto geometry" / projection-mapping look. */
export type ToyboxSurfaceMode = 'uv' | 'projective';

/** Transform + matcap material for an OBJ-kind layer (Phase 3). All numeric
 *  so they are CV-target-ready later; the OBJ render pass reads them every
 *  frame from the live layer. */
export interface ToyboxObjMaterial {
  /** Model id (manifest `models` entry — bundled OBJ or built-in primitive). */
  modelId: string;
  /** Static rotation about each axis (radians). */
  rotX: number;
  rotY: number;
  rotZ: number;
  /** Uniform scale multiplier applied ON TOP of the mesh's auto-frame fit. */
  scale: number;
  /** Auto-rotation rate (radians/sec about Y, added to rotY at draw time). */
  spin: number;
  /** Procedural matcap style index (0..MATCAP_STYLES-1). */
  matcap: number;
  /** RGB tint multiplied over the matcap. */
  tintR: number;
  tintG: number;
  tintB: number;
  /** OPTIONAL surface-texture source (Phase 6 texmap): the LAYER INDEX
   *  (0..LAYER_COUNT-1) whose rendered FBO is UV-mapped onto the mesh as a
   *  surface texture in place of (blended with) the matcap. undefined or a
   *  negative / out-of-range / self value = matcap-only. Choosing a layer index
   *  (not a node id) mirrors the combine source nodes' `layer:number` and is
   *  kind-agnostic, so a future 'video' layer's frame works identically. */
  surfaceSource?: number;
  /** OPTIONAL blend amount (0..1) of the sampled surface texture over the
   *  matcap. undefined → 1 (full texture replace-over-matcap) when a valid
   *  surfaceSource is set. */
  surfaceMix?: number;
  /** OPTIONAL surface-mapping mode (Phase 7). undefined → 'uv' (the Phase-6
   *  default: sample the source by the mesh UVs). 'projective' projects the
   *  source from a viewpoint (see {@link ToyboxSurfaceMode}). */
  surfaceMode?: ToyboxSurfaceMode;
  /** PROJECTIVE mode: when truthy (>0.5 when persisted as a number) the
   *  projector view IS the render camera (the projection appears "painted on"
   *  from the viewer). When false the projector uses projPos/projDir below.
   *  Stored numerically (0/1) so it is CV-target-uniform with the rest of the
   *  material. */
  projUseCamera?: number;
  /** PROJECTIVE mode: projector eye position (world space). Ignored when
   *  projUseCamera is set. Defaults make a projector in front of the mesh
   *  looking back toward the origin. */
  projPosX?: number;
  projPosY?: number;
  projPosZ?: number;
  /** PROJECTIVE mode: projector look direction (world space; need not be
   *  normalised — the math normalises). Ignored when projUseCamera is set. */
  projDirX?: number;
  projDirY?: number;
  projDirZ?: number;
  /** PROJECTIVE mode: projector vertical field-of-view (radians). Wider = the
   *  image spreads over more of the mesh. Defaults to the render FOV. */
  projFov?: number;
}

/** Number of procedural matcap styles the OBJ shader provides. */
export const MATCAP_STYLES = 3;

/** Default projector field-of-view (radians) — matches the render camera's
 *  50°. Used when material.projFov is unset. */
export const DEFAULT_PROJ_FOV = (50 * Math.PI) / 180;

/** Default projector eye + look (world space) when material.projPos* / projDir*
 *  are unset: a projector in front of the mesh at z=+2.5 looking back at the
 *  origin (down -Z), so a fresh projective surface paints from the front. */
export const DEFAULT_PROJ = {
  posX: 0,
  posY: 0,
  posZ: 2.5,
  dirX: 0,
  dirY: 0,
  dirZ: -1,
} as const;

/** Resolve a material's projector eye + look + fov, applying defaults for any
 *  unset field. PURE — shared by the GL pass + card so they agree. */
export function resolveProjector(mat: ToyboxObjMaterial): {
  pos: [number, number, number];
  dir: [number, number, number];
  fov: number;
} {
  const num = (v: number | undefined, d: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : d;
  return {
    pos: [
      num(mat.projPosX, DEFAULT_PROJ.posX),
      num(mat.projPosY, DEFAULT_PROJ.posY),
      num(mat.projPosZ, DEFAULT_PROJ.posZ),
    ],
    dir: [
      num(mat.projDirX, DEFAULT_PROJ.dirX),
      num(mat.projDirY, DEFAULT_PROJ.dirY),
      num(mat.projDirZ, DEFAULT_PROJ.dirZ),
    ],
    fov: num(mat.projFov, DEFAULT_PROJ_FOV),
  };
}

/** Default OBJ material for a fresh OBJ layer. */
export function makeDefaultObjMaterial(modelId = DEFAULT_MODEL_ID): ToyboxObjMaterial {
  return {
    modelId,
    rotX: 0.3,
    rotY: 0.6,
    rotZ: 0,
    scale: 1,
    spin: 0.4,
    matcap: 0,
    tintR: 1,
    tintG: 1,
    tintB: 1,
  };
}

/** Media metadata for a 'video' layer (VIDEOBOX-style). The video bytes are
 *  NOT synced (videos are large + local-file); only the filename rides the
 *  Y.Doc so rack-mates see "{name}" + the card prompts each peer to pick their
 *  own copy. The card owns the <video> element. */
export interface ToyboxVideoMeta {
  /** Source filename, surfaced in the card UI. */
  name: string | null;
}

/** Where a VIDEO-kind layer gets its texture:
 *   - 'inA' / 'inB': a PATCHED FEED off the TOYBOX node's video input port of
 *           the same id (frame.getInputTexture) — a live source patched in from
 *           the rack (e.g. ACIDWARP / CAMERA / another module's video out). The
 *           cable provides the feed; no local file needed.
 *   - 'file': a local-file <video> player (VIDEOBOX-style: the card owns the
 *           element + object-URL; only the filename rides the Y.Doc). The #603
 *           default behaviour.
 *   - 'camera': the device webcam streamed into the same card-owned <video>
 *           (getUserMedia → srcObject), pumped through the same uploader.
 *  Absent → treated as 'file' (the #603 default, so existing video layers are
 *  unchanged). */
export type ToyboxVideoSource = 'inA' | 'inB' | 'file' | 'camera';

/** What a single TOYBOX layer holds. The array is sized to LAYER_COUNT; each
 *  layer renders into its own FBO and the combine DAG reduces them to the
 *  output. */
export interface ToyboxLayer {
  /** Source kind — see {@link ToyboxLayerKind}. */
  kind: ToyboxLayerKind;
  /** Selected fragment-shader content id (for shader/gen kinds). Null = empty. */
  contentId: string | null;
  /** Per-param values keyed by ToyboxParamDef.id (shader/gen kinds). Missing
   *  keys fall back to the param's manifest default at draw time. */
  params: Record<string, number>;
  /** OBJ transform + matcap material (only meaningful for kind === 'obj'). */
  material?: ToyboxObjMaterial;
  /** IMAGE layer: base64-encoded JPEG bytes (PICTUREBOX-style, synced over
   *  Y.Doc). Null until a file is picked. The card decodes + uploads. */
  imageBytes?: string | null;
  /** IMAGE layer: source filename, surfaced in the card UI. */
  imageName?: string | null;
  /** CUSTOM SHADER (shader/gen/frag kind): the raw GLSL source loaded from the
   *  user's disk, persisted on the layer (rides the Y.Doc, so it survives reload
   *  + exports cleanly). When present the engine compiles THIS source instead of
   *  fetching `contentId` from the manifest. Shadertoy-vs-GEN convention is
   *  auto-detected (isShadertoySource). Custom shaders declare NO params (the
   *  card shows no faders). Null/absent → fall back to `contentId`. */
  shaderSrc?: string | null;
  /** CUSTOM SHADER: source filename, surfaced in the card UI. */
  shaderName?: string | null;
  /** CUSTOM OBJ (obj kind): the raw Wavefront OBJ text loaded from the user's
   *  disk, persisted on the layer (rides the Y.Doc). When present the engine
   *  parses THIS text instead of fetching the bundled `material.modelId`.
   *  Null/absent → fall back to `material.modelId`. */
  objSrc?: string | null;
  /** CUSTOM OBJ: source filename, surfaced in the card UI. */
  objName?: string | null;
  /** VIDEO layer: local-file metadata (filename). The bytes are not synced. */
  videoMeta?: ToyboxVideoMeta;
  /** VIDEO layer: where the texture comes from — a patched feed ('inA'/'inB'),
   *  a local file ('file'), or the webcam ('camera'). Absent → 'file' (the #603
   *  default, so saved video layers keep their behaviour). */
  videoSource?: ToyboxVideoSource;
  /** SHADERTOY multi-buffer project (a 'gen' or 'frag' layer can host one):
   *  Common + N buffer passes + an Image pass with iChannelN wiring. When
   *  present the factory renders the project's pass chain (own FBOs, ping-pong
   *  feedback, iMouse click-paint) into the layer FBO INSTEAD of the single
   *  content shader. Plain JSON (Yjs-safe). Shape mirrors ShadertoyProject in
   *  toybox-shadertoy.ts (typed loosely here to avoid an import cycle). */
  project?: {
    common?: string;
    passes: Array<{ id: string; src: string; channels: unknown[]; float?: boolean }>;
  };
  /** PRESET-ONLY lazy descriptor for a multi-buffer project: instead of inlining
   *  the (large) GLSL in the manifest, a preset layer carries the pass FILE URLs
   *  + channel wiring here; the preset loader fetches each `url` and assembles
   *  `project` (with `src` filled in) before writing the layer. Stripped after
   *  resolution. Mirrors the GLSL-is-lazy-fetched-never-bundled convention. */
  projectRef?: {
    common?: string; // URL of the shared Common GLSL (optional)
    passes: Array<{ id: string; url: string; channels: unknown[]; float?: boolean }>;
  };
}

/** Number of layers a TOYBOX node persists + renders. */
export const LAYER_COUNT = 4;

// ---------------- Combine DAG (reduce layers → output) ----------------

/** A combine operation in the per-node combine graph. Each step combines an
 *  accumulator (the running composite, starting at layer 0) with one further
 *  layer texture using `op`. The output is the final accumulator. */
export type ToyboxCombineOp = 'fade' | 'lumakey' | 'chromakey' | 'map';

export interface ToyboxCombineStep {
  /** Layer index (1..LAYER_COUNT-1) to combine into the accumulator. */
  layer: number;
  /** How to blend it. */
  op: ToyboxCombineOp;
  /** Mix amount / threshold (0..1), op-dependent. */
  amount: number;
}

export interface ToyboxCombine {
  steps: ToyboxCombineStep[];
}

/** Build the default combine: a straight chain that fades each subsequent
 *  active layer over the accumulator at full amount. Layer 0 is the base. */
export function makeDefaultCombine(): ToyboxCombine {
  const steps: ToyboxCombineStep[] = [];
  for (let i = 1; i < LAYER_COUNT; i++) {
    steps.push({ layer: i, op: 'fade', amount: 0 });
  }
  return { steps };
}

/** Build a fresh, fully-defaulted layer array (4 layers; layer 0 seeded with
 *  the default GEN content + its param defaults, layers 1..3 empty). Used by
 *  the factory + card when node.data.layers is absent. The param defaults are
 *  best-effort from the (possibly-not-yet-loaded) catalog — the factory
 *  re-resolves them against the manifest once it has the real param schema. */
export function makeDefaultLayers(): ToyboxLayer[] {
  const meta = getContentMeta(DEFAULT_CONTENT_ID);
  const params: Record<string, number> = {};
  if (meta) for (const p of meta.params) params[p.id] = p.default;
  const layer0: ToyboxLayer = { kind: 'gen', contentId: DEFAULT_CONTENT_ID, params };
  const empty = (): ToyboxLayer => ({ kind: 'off', contentId: null, params: {} });
  return [layer0, empty(), empty(), empty()];
}
