// packages/web/src/lib/video/toybox-custom-assets.ts
//
// THE BRIDGE from a user-supplied SOURCE to a registered ASSET (#1576).
//
// This is where workstream 1 (param extraction) meets workstream 2 (the provider
// seam): given the GLSL text of a disk-loaded — later, pasted — shader, derive
// its metadata and register it so the ORDINARY sync lookup
// (`getContentMeta(id)`) resolves it, exactly as it resolves a bundled entry.
//
// ── The id is a HASH OF THE SOURCE, and that is the whole trick ─────────────
//
// The registration id is `customShaderKey(src)` — a pure djb2 hash of the source
// text, the SAME key the engine already uses for its program cache. Two
// consequences, both load-bearing:
//
//   1. IDEMPOTENT. Registering the same source twice is a no-op replace: same
//      key, and (because extraction is pure) identical derived metadata. So a
//      caller may register defensively without tracking whether it already did.
//
//   2. CONVERGENT WITHOUT SYNCING ANYTHING. The source itself rides the Y.Doc on
//      the layer (`shaderSrc`) exactly as before — this module changes nothing
//      about what is persisted or transmitted. Because the key is a pure
//      function of those synced bytes, ANY peer can derive the identical id and
//      identical params locally. The registry is a cache of a deterministic
//      function over already-synced data, not a second source of truth, so it
//      cannot make two rack-mates disagree about the document.
//
// ── WHY THE OBJ PATH IS DELIBERATELY NOT REGISTERED ────────────────────────
//
// The disk picker also loads a custom `.obj`, and it would be symmetrical to
// register a `ToyboxModel` for it. It is not, on purpose: there is nothing to
// DERIVE. An OBJ yields a mesh, not metadata — no params, no ranges — and the
// mesh is already cached under `customObjKey(src)` by the engine's own
// `ensureMesh`. A model entry would restate the filename that already rides the
// Y.Doc as `objName` and buy nothing. If a future need appears (per-model
// material defaults, say), it registers then, through this same seam.

import {
  customShaderKey,
  getContentMeta,
  type ToyboxContent,
  type ToyboxLayer,
  type ToyboxParamDef,
} from './toybox-content';
import {
  registerRuntimeToyboxAsset,
  unregisterRuntimeToyboxAsset,
  type RuntimeRegistration,
} from './toybox-asset-registry';
import { extractShaderParams, type ShaderParamDiagnostic } from './toybox-shader-params';
import { isShadertoySource } from './toybox-shadertoy';

export interface CustomShaderRegistration {
  /** The synthetic content id — `customShaderKey(src)`. Stable for this text. */
  id: string;
  /** Params extracted from the source's own `uniform float` declarations. */
  params: ToyboxParamDef[];
  /** Everything extraction skipped or adjusted, for the load UI to explain. */
  diagnostics: ShaderParamDiagnostic[];
  /** The registry's verdict — `effective: false` would mean a higher-precedence
   *  provider owns the id. Structurally impossible for a `custom-shader:` key
   *  (the prefix cannot collide with a manifest id), and asserted as such. */
  registration: RuntimeRegistration;
}

/**
 * Derive metadata for an inline custom shader source and register it as a
 * session-local asset, so `getContentMeta(id)` resolves its params.
 *
 * Registered UNLISTED (`listed: false`): this is not a library item the user can
 * pick from the content dropdown, it is derived metadata for a source already
 * attached to a layer. Nothing appears in any dropdown as a result of this call.
 *
 * PURE apart from the registration itself — no GL, no fetch. Whether the shader
 * COMPILES is a separate question, answered by `validateToyboxShader`.
 */
export function registerCustomShaderSource(
  src: string,
  label?: string | null,
): CustomShaderRegistration {
  const id = customShaderKey(src);
  const { params, diagnostics } = extractShaderParams(src);
  const asset: ToyboxContent = {
    id,
    label: (label ?? '').trim() || 'CUSTOM SHADER',
    // A Shadertoy-convention source reads the composited layers below as
    // iChannel0, so it is a FRAG; a plain `main()` source is generative.
    // Mirrors the engine's own auto-detection, from the same predicate.
    family: isShadertoySource(src) ? 'FRAG' : 'GEN',
    input: isShadertoySource(src) ? 'scene' : 'none',
    shadertoy: isShadertoySource(src) || undefined,
    // Never fetched: `inlineSource` makes getContent() refuse rather than
    // request this. The value is a sentinel, not a URL.
    glsl: `inline:${id}`,
    inlineSource: true,
    params,
  };
  const registration = registerRuntimeToyboxAsset('content', asset, { listed: false });
  return { id, params, diagnostics, registration };
}

/** Drop a previously registered custom shader by its source text. Returns
 *  whether one was present. Registration is keyed by content, so this removes
 *  the entry for THIS exact source. */
export function unregisterCustomShaderSource(src: string): boolean {
  return unregisterRuntimeToyboxAsset('content', customShaderKey(src));
}

// ---------------- REGISTRATION DRIVEN BY OBSERVATION (#1708) ----------------
//
// ── The bug this shape exists to make impossible ────────────────────────────
//
// Registering where the FILE IS PICKED is wrong, and not subtly: a rack-mate who
// receives the layer over the Y.Doc never runs the picker's handler, so its
// lookup misses and its faders are absent while the picking peer's are present —
// two peers rendering the same document differently, which is the one thing this
// seam must not introduce. Syncing the registration would be the wrong fix (it
// puts derived data on the wire). The right one is that ANY peer holding the
// synced bytes derives the identical metadata locally, which means registration
// must be driven from OBSERVING a layer that carries an inline source.
//
// So `resolveLayerContent` is BOTH the lookup and the registration: every
// consumer that asks a layer what content it renders — the two render paths, CV
// routing, the control-surface/MIDI resolver, the card's fader list — registers
// it as a side effect of asking. There is no separate "register" call site left
// that a new consumer could forget, and no ordering between them to get wrong.
//
// ── Cost on the render hot path ────────────────────────────────────────────
//
// Steady state is ONE djb2 hash of the source (which both render paths ALREADY
// paid to key their program cache — this replaces that call, it does not add
// one) plus one `Map.get`. The derivation runs only on a MISS, so it happens
// once per distinct source per thread; a hit never touches the provider list and
// never invalidates the composed index.

/** What a layer renders, resolved once: its inline source (if any), the content
 *  id that keys the engine's program cache, and the metadata carrying `params`. */
export interface ResolvedLayerContent {
  /** The inline custom GLSL this layer carries, or null for bundled content. */
  src: string | null;
  /** The id this layer resolves to: `customShaderKey(src)` when `src` is set,
   *  else `layer.contentId`. Null when the layer has neither. */
  id: string | null;
  /** The resolved content metadata (`params`, `family`, `input`, …), or
   *  undefined for an unknown id / a catalog that has not loaded yet. */
  meta: ToyboxContent | undefined;
}

/** What `resolveLayerContent` reads off a layer. A whole `ToyboxLayer` satisfies
 *  it; only `shaderSrc`, `shaderName` and `contentId` are ever looked at. */
export type LayerContentRef = Readonly<Partial<ToyboxLayer>>;

/** The inline custom GLSL a layer carries, normalised to `string | null`. PURE. */
function inlineShaderSrc(layer: LayerContentRef | undefined | null): string | null {
  const s = layer?.shaderSrc;
  return typeof s === 'string' && s.length > 0 ? s : null;
}

/** Resolve a custom source's metadata, registering it if this is the first time
 *  this thread has seen it. `id` must be `customShaderKey(src)` — passed in so a
 *  caller that already computed it does not hash the source twice per frame. */
function metaForSource(src: string, id: string, label: string | null): ToyboxContent | undefined {
  const hit = getContentMeta(id);
  if (hit) return hit;
  registerCustomShaderSource(src, label);
  return getContentMeta(id);
}

/**
 * Resolve what a TOYBOX layer renders — inline custom source FIRST, bundled
 * `contentId` otherwise — registering derived metadata for an inline source on
 * first observation.
 *
 * SYNCHRONOUS and safe to call per frame (see the cost note above). This is the
 * ONE place the inline-vs-bundled precedence is expressed; every consumer reads
 * it here so a custom source and a bundled one travel the same code path from
 * this point on.
 */
export function resolveLayerContent(
  layer: LayerContentRef | undefined | null,
): ResolvedLayerContent {
  const src = inlineShaderSrc(layer);
  if (src !== null) {
    const id = customShaderKey(src);
    // The filename rides the Y.Doc too, so a receiving peer derives the same
    // label as the picking one — the entry is identical on both, not merely
    // equivalent.
    return { src, id, meta: metaForSource(src, id, layer?.shaderName ?? null) };
  }
  const id = layer?.contentId ?? null;
  return { src: null, id, meta: id ? getContentMeta(id) : undefined };
}

/**
 * Resolve an inline custom source's metadata when the caller holds the SOURCE
 * but not the layer (the engines' `ensureProgram`, which is handed the GLSL).
 * Same registration-on-observation contract as `resolveLayerContent`; hashes the
 * source, so call it off the per-frame path.
 */
export function ensureCustomShaderMeta(
  src: string,
  label: string | null = null,
): ToyboxContent | undefined {
  return metaForSource(src, customShaderKey(src), label);
}
