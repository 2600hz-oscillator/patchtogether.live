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

/** What a single TOYBOX layer holds. Phase 1 only renders index 0, but the
 *  array is sized to LAYER_COUNT so the persisted shape is already the
 *  Phase-2 (4-layer) shape — no migration needed when layers 1..3 light up. */
export interface ToyboxLayer {
  /** 'shader' (FX) | 'gen' (GEN). Distinguishes the source family; both
   *  compile + render identically in P1 — the tag drives later combine
   *  routing + UI grouping. */
  kind: 'shader' | 'gen';
  /** Selected content id (manifest entry). Null = empty layer (renders nothing). */
  contentId: string | null;
  /** Per-param values keyed by ToyboxParamDef.id. Missing keys fall back to
   *  the param's manifest default at draw time. */
  params: Record<string, number>;
}

/** Number of layers a TOYBOX node persists. P1 renders only index 0. */
export const LAYER_COUNT = 4;

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
  const empty = (): ToyboxLayer => ({ kind: 'shader', contentId: null, params: {} });
  return [layer0, empty(), empty(), empty()];
}
