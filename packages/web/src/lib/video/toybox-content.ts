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

/** Family tag — which palette bucket the content came from. */
export type ToyboxFamily = 'GEN' | 'FX';

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
}

interface ToyboxManifest {
  version: number;
  /** FX family entries. */
  shaders: ToyboxContent[];
  /** GEN family entries. */
  gen: ToyboxContent[];
}

/** Public path to the static manifest. */
export const TOYBOX_MANIFEST_URL = '/toybox/manifest.json';

// ---------------- Manifest load + catalog ----------------

let manifestPromise: Promise<ToyboxManifest> | null = null;
let catalog: ToyboxContent[] | null = null;
let byId: Map<string, ToyboxContent> | null = null;

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

/** The default content id (first GEN entry) used when a fresh TOYBOX layer
 *  has no contentId yet. Falls back to the kdnown first-slice id so the
 *  factory has a deterministic boot even before the manifest resolves. */
export const DEFAULT_CONTENT_ID = 'noise-fbm';
/* (the default first-slice id; the manifest's first GEN entry) */

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

// ---------------- Layer model (persisted in node.data.layers) ----------------

/** Source kind of a single TOYBOX layer.
 *  - 'shader' (FX) / 'gen' (GEN): a bundled GLSL content entry, compiled +
 *    rendered into the layer's own FBO.
 *  - 'video': the layer's texture comes from the matching `layer<i>_in` video
 *    INPUT port (the factory samples it instead of rendering anything).
 *  - 'off': the layer is empty — a black sentinel feeds the combine stage.
 *  ('obj' lands in P3; the factory treats it as 'off' for now.) */
export type ToyboxLayerKind = 'shader' | 'gen' | 'video' | 'off';

/** What a single TOYBOX layer holds. Phase 2 renders ALL LAYER_COUNT layers
 *  (each into its own FBO) and combines them; the array shape is unchanged
 *  from P1 so persisted P1 nodes load without migration. */
export interface ToyboxLayer {
  /** Source kind (see ToyboxLayerKind). P1 only used 'shader' | 'gen'. */
  kind: ToyboxLayerKind;
  /** Selected content id (manifest entry). Null = empty layer (renders
   *  nothing). Only meaningful for kind 'shader' | 'gen'. */
  contentId: string | null;
  /** Per-param values keyed by ToyboxParamDef.id. Missing keys fall back to
   *  the param's manifest default at draw time. */
  params: Record<string, number>;
}

/** Number of layers a TOYBOX node persists + renders (P2: all of them). */
export const LAYER_COUNT = 4;

/** Build a fresh, fully-defaulted layer array (4 layers; layer 0 seeded with
 *  the default GEN content + its param defaults, layers 1..3 off). Used by
 *  the factory + card when node.data.layers is absent. The param defaults are
 *  best-effort from the (possibly-not-yet-loaded) catalog — the factory
 *  re-resolves them against the manifest once it has the real param schema. */
export function makeDefaultLayers(): ToyboxLayer[] {
  const meta = getContentMeta(DEFAULT_CONTENT_ID);
  const params: Record<string, number> = {};
  if (meta) for (const p of meta.params) params[p.id] = p.default;
  const layer0: ToyboxLayer = { kind: 'gen', contentId: DEFAULT_CONTENT_ID, params };
  const off = (): ToyboxLayer => ({ kind: 'off', contentId: null, params: {} });
  return [layer0, off(), off(), off()];
}

// ---------------- Combine model (persisted in node.data.combine) -------------
//
// A small DATA-DRIVEN graph that composites the 4 layer textures into the
// module output. P2 ships a FIXED default chain (built in code when the
// persisted `combine` is empty); P4 swaps the default for a node-editor the
// user edits. The shape is the one the editor will read/write so P4 needs no
// migration: a list of op-nodes + edges wiring layer sources + op outputs to
// op inputs and finally to the OUTPUT.

/** The combine operators. Each is ONE fullscreen-quad pass over 2 input
 *  textures (A = primary, B = secondary) into a scratch FBO.
 *  - 'fade'      : mix(A, B, t).
 *  - 'lumakey'   : luminance key — A over B keyed by A's luma (LUMAKEY math).
 *  - 'chromakey' : chroma key   — A over B keyed by colour (CHROMAKEY math).
 *  - 'map'       : selectable blend-mode operator (screen/multiply/add/…). */
export type ToyboxCombineOp = 'fade' | 'lumakey' | 'chromakey' | 'map';

/** Blend modes for the 'map' op (discrete `mode` param, index into this
 *  array). Order is load-bearing: it's the `mode` param's integer encoding
 *  AND the card dropdown order. */
export const TOYBOX_BLEND_MODES = [
  'screen',
  'multiply',
  'add',
  'darken',
  'lighten',
  'difference',
  'overlay',
] as const;
export type ToyboxBlendMode = (typeof TOYBOX_BLEND_MODES)[number];

/** A combine-graph node. `op` nodes run a pass; the special 'output' node is
 *  the sink that gets blitted to the module output. (Layer SOURCES are not
 *  nodes — they're referenced by id `layer0`..`layer3` on edges, so the editor
 *  doesn't have to re-declare them.) */
export interface ToyboxCombineNode {
  /** Stable node id within the combine graph. */
  id: string;
  /** 'op' = a combine operator pass; 'output' = the module-output sink. */
  type: 'op' | 'output';
  /** The operator (only for type 'op'). */
  op?: ToyboxCombineOp;
  /** Op params (t / mode / mix / threshold / softness / keyR…). Missing keys
   *  fall back to COMBINE_OP_DEFAULTS at draw time. */
  params?: Record<string, number>;
}

/** A wire feeding one input slot of a combine node. `source` is either a layer
 *  ref ('layer0'..'layer3') or another combine-node id. `inlet` is the target
 *  slot: 'a' (primary) or 'b' (secondary) for an op; 'in' for the output. */
export interface ToyboxCombineEdge {
  source: string;
  target: string;
  inlet: 'a' | 'b' | 'in';
}

/** The persisted combine graph. Empty `nodes` → the factory builds the fixed
 *  default chain (makeDefaultCombine). */
export interface ToyboxCombine {
  nodes: ToyboxCombineNode[];
  edges: ToyboxCombineEdge[];
}

/** Layer source ids referenced on combine edges. */
export const layerSourceId = (i: number): string => `layer${i}`;

/** Per-op param defaults (used when an op-node omits a param key). Mirrors
 *  the LUMAKEY / CHROMAKEY module defaults so the math is identical. */
export const COMBINE_OP_DEFAULTS: Record<ToyboxCombineOp, Record<string, number>> = {
  fade: { t: 0.5 },
  lumakey: { threshold: 0.5, softness: 0.1, invert: 0 },
  chromakey: { keyR: 0.0, keyG: 1.0, keyB: 0.0, tolerance: 0.15, softness: 0.08 },
  // mode = index into TOYBOX_BLEND_MODES (0 = screen); mix = blend amount.
  map: { mode: 0, mix: 1.0 },
};

/** Build the FIXED default P2 combine chain:
 *
 *   fade(a=layer0, b=layer1)               → f
 *   map(screen, a=f, b=layer2)             → m
 *   lumakey(a=layer3 [fg], b=m [bg])       → k
 *   output(in=k)
 *
 * When layers 1..3 are 'off' (P1 backwards-compat), each op reduces to its
 * identity over layer0: fade t=0 keeps A, BUT we want the P1 result == layer0
 * straight, so the factory short-circuits to layer0 when layers 1..3 are all
 * off (see toybox.ts). With layers populated this gives a sensible blend
 * sandwich the card exposes knobs for. */
export function makeDefaultCombine(): ToyboxCombine {
  return {
    nodes: [
      { id: 'fade', type: 'op', op: 'fade', params: { ...COMBINE_OP_DEFAULTS.fade } },
      { id: 'map', type: 'op', op: 'map', params: { ...COMBINE_OP_DEFAULTS.map } },
      { id: 'key', type: 'op', op: 'lumakey', params: { ...COMBINE_OP_DEFAULTS.lumakey } },
      { id: 'out', type: 'output' },
    ],
    edges: [
      { source: layerSourceId(0), target: 'fade', inlet: 'a' },
      { source: layerSourceId(1), target: 'fade', inlet: 'b' },
      { source: 'fade', target: 'map', inlet: 'a' },
      { source: layerSourceId(2), target: 'map', inlet: 'b' },
      { source: layerSourceId(3), target: 'key', inlet: 'a' },
      { source: 'map', target: 'key', inlet: 'b' },
      { source: 'key', target: 'out', inlet: 'in' },
    ],
  };
}
