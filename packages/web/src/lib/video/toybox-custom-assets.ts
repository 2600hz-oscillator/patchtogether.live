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
  type ToyboxContent,
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
