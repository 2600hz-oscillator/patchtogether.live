// packages/web/src/lib/video/toybox-asset-registry.ts
//
// THE TOYBOX ASSET PROVIDER SEAM (#1576, workstream 2; plumbing for #1575).
//
// ── The constraint that shaped the whole design ─────────────────────────────
//
// `getContentMeta` / `getModelMeta` / `getPresetMeta` are SYNCHRONOUS and sit on
// the RENDER HOT PATH. They are read per-frame by the worker handle and the
// main-thread engine (to push each param's uniform), and by the CV routing +
// control-param resolvers. An interface that made lookup async would break all
// of them. So the rule this file is built around:
//
//     ASYNC IS FINE FOR *LOADING*. LOOKUP STAYS SYNCHRONOUS. ALWAYS.
//
// The seam achieves that by giving providers a purely SYNCHRONOUS surface: a
// provider only ever reports what it ALREADY HOLDS. Fetching, decoding and
// parsing are the provider's own private business, done ahead of time; by the
// time the registry asks, the answer is in memory. The static-manifest provider
// fetches `/toybox/manifest.json` in `loadManifest()` and only then has entries
// to report; a runtime provider is handed bytes the caller already has.
//
// ── Why a composed INDEX, not a provider walk ───────────────────────────────
//
// Walking N providers per lookup would put an O(providers) loop inside the
// per-frame uniform push. Instead the registry composes ONE index (three Maps +
// three lists) and memoizes it against a revision counter. Steady state, a
// lookup is `revision === memoRevision` (an integer compare) plus a single
// `Map.get` — the same cost as the module-level Map it replaces. Any provider
// mutation calls `invalidateToyboxAssets()`, which bumps the revision; the next
// lookup rebuilds lazily. So a runtime asset registered AFTER the manifest
// caches were built is visible to the very next SYNCHRONOUS lookup, with no
// await anywhere — see the "registered late" tests.
//
// ── PRECEDENCE: the static manifest OUTRANKS every runtime provider ─────────
//
// Ordering is by DECLARED `precedence` (lower wins), never by registration
// order, so it cannot drift with module-init timing. `MANIFEST_PRECEDENCE` <
// `RUNTIME_PRECEDENCE`, and the reason is a correctness argument rather than a
// preference:
//
//   Bundled ids are referenced by PRESETS, and a preset rides the Y.Doc. If a
//   runtime registration could shadow a bundled id, then a peer who happened to
//   load a local asset named `caustic-pool` would render a DIFFERENT preset than
//   the rack-mate who did not — from the same synced document. Divergence
//   between rack-mates is precisely what this seam must not introduce. So a
//   runtime entry never wins, and the collision is REPORTED (`shadowed`) rather
//   than silently dropped, so the load UI can say why.
//
// In the disk path the question never actually arises: those ids are
// `custom-shader:<hash>` / `custom-obj:<hash>`, and the prefix cannot collide
// with a manifest id. The rule exists for the SUBSITE path (#1575), where a user
// names their own asset.
//
// ── WHAT THIS REGISTRY CANNOT SEE (stated inside the gate) ──────────────────
//
//   * It does not fetch anything. A provider that has not finished loading
//     reports nothing, and its ids resolve to `undefined` — indistinguishable
//     here from an unknown id. That is the pre-existing `getContentMeta`
//     contract (it has always returned `undefined` before the manifest lands)
//     and is deliberately unchanged.
//   * It does not validate. An entry whose `glsl` URL 404s, or whose shader
//     does not compile, is a perfectly good catalog entry as far as this file is
//     concerned. Compile validity is `validateToyboxShader` (workstream 3).
//   * It does not persist. Runtime registrations are SESSION-LOCAL and are not
//     written to the Y.Doc. See the convergence note on
//     `registerRuntimeToyboxAsset` for why that does not change what syncs.

import type { ToyboxContent, ToyboxModel, ToyboxPreset } from './toybox-content';

/** Which catalog an asset belongs to. */
export type ToyboxAssetKind = 'content' | 'model' | 'preset';

/**
 * One asset as offered by a provider.
 *
 * `listed` is REQUIRED, with no default, deliberately: the choice between "a
 * user can pick this from the dropdown" and "this is derived metadata for a
 * source the graph already carries" has to be made per registration, and a
 * required field means `tsc` refuses the undeclared form before any test runs.
 */
export interface ToyboxAssetEntry<T> {
  readonly asset: T;
  /**
   * TRUE  — appears in catalog LISTINGS (`listAllContent`/`listModels`/…), i.e.
   *         the dropdowns. Browsable content.
   * FALSE — resolvable BY ID only, absent from every listing. This is the shape
   *         for metadata DERIVED from a source the document already carries: a
   *         disk-loaded `shaderSrc` keyed by `customShaderKey(src)`. The user did
   *         not add an item to the library; they attached a source to a layer,
   *         and the engine needs to look up its params by the synthetic key.
   */
  readonly listed: boolean;
}

/**
 * A source of TOYBOX assets.
 *
 * ⚠ EVERY METHOD IS SYNCHRONOUS AND MUST STAY THAT WAY — see the header. A
 * provider reports what it already holds; it never fetches on demand. Methods
 * are called during index composition (i.e. on the first lookup after an
 * invalidation), so they must also be CHEAP and side-effect-free.
 */
export interface ToyboxAssetProvider {
  /** Stable name, used in shadow diagnostics. Unique across providers. */
  readonly name: string;
  /** Lower wins an id collision. See `MANIFEST_PRECEDENCE` / `RUNTIME_PRECEDENCE`. */
  readonly precedence: number;
  content(): readonly ToyboxAssetEntry<ToyboxContent>[];
  models(): readonly ToyboxAssetEntry<ToyboxModel>[];
  presets(): readonly ToyboxAssetEntry<ToyboxPreset>[];
}

/** The bundled static manifest. Authoritative: presets reference these ids. */
export const MANIFEST_PRECEDENCE = 0;
/** Session-registered assets (disk ingest today, subsite later). Never shadows. */
export const RUNTIME_PRECEDENCE = 100;

/** An id offered by two providers. The higher-precedence one is what resolves. */
export interface ToyboxAssetShadow {
  kind: ToyboxAssetKind;
  id: string;
  /** Provider whose entry RESOLVES (the lower `precedence`). */
  winner: string;
  /** Provider whose entry is SHADOWED — offered, but never returned. */
  loser: string;
}

// ---------------- Provider registration ----------------

const providers: ToyboxAssetProvider[] = [];
let revision = 0;

/**
 * Signal that some provider's contents changed. Bumps the revision so the next
 * SYNCHRONOUS lookup recomposes. Cheap — the rebuild is lazy, so a burst of
 * registrations costs one recomposition, not one per call.
 */
export function invalidateToyboxAssets(): void {
  revision++;
}

/** Current composition revision. Exposed so a consumer can memoize against it. */
export function toyboxAssetsRevision(): number {
  return revision;
}

/**
 * Add a provider. Idempotent by `name`: re-registering a provider with a name
 * already present REPLACES it (module hot-reload / test re-import safety) rather
 * than silently double-listing every asset it offers.
 */
export function registerToyboxAssetProvider(provider: ToyboxAssetProvider): void {
  const at = providers.findIndex((p) => p.name === provider.name);
  if (at >= 0) providers[at] = provider;
  else providers.push(provider);
  invalidateToyboxAssets();
}

/** Remove a provider by name. Returns whether one was actually removed. */
export function unregisterToyboxAssetProvider(name: string): boolean {
  const at = providers.findIndex((p) => p.name === name);
  if (at < 0) return false;
  providers.splice(at, 1);
  invalidateToyboxAssets();
  return true;
}

/** The registered providers, in RESOLUTION ORDER (highest precedence first). */
export function toyboxAssetProviders(): readonly ToyboxAssetProvider[] {
  return [...providers].sort((a, b) => a.precedence - b.precedence);
}

// ---------------- Composed index ----------------

interface ComposedIndex {
  content: Map<string, ToyboxContent>;
  models: Map<string, ToyboxModel>;
  presets: Map<string, ToyboxPreset>;
  contentList: ToyboxContent[];
  modelList: ToyboxModel[];
  presetList: ToyboxPreset[];
  shadowed: ToyboxAssetShadow[];
}

let memo: ComposedIndex | null = null;
let memoRevision = -1;

function composeOne<T extends { id: string }>(
  kind: ToyboxAssetKind,
  ordered: readonly ToyboxAssetProvider[],
  pick: (p: ToyboxAssetProvider) => readonly ToyboxAssetEntry<T>[],
  shadowed: ToyboxAssetShadow[],
): { map: Map<string, T>; list: T[] } {
  const map = new Map<string, T>();
  const owner = new Map<string, string>();
  const list: T[] = [];
  for (const p of ordered) {
    for (const entry of pick(p)) {
      const id = entry.asset.id;
      const held = owner.get(id);
      if (held !== undefined) {
        // A LOWER-precedence provider offered an id already taken. It is
        // reported, never applied — see the precedence argument in the header.
        shadowed.push({ kind, id, winner: held, loser: p.name });
        continue;
      }
      owner.set(id, p.name);
      map.set(id, entry.asset);
      if (entry.listed) list.push(entry.asset);
    }
  }
  return { map, list };
}

function index(): ComposedIndex {
  if (memo && memoRevision === revision) return memo;
  const ordered = toyboxAssetProviders();
  const shadowed: ToyboxAssetShadow[] = [];
  const c = composeOne<ToyboxContent>('content', ordered, (p) => p.content(), shadowed);
  const m = composeOne<ToyboxModel>('model', ordered, (p) => p.models(), shadowed);
  const pr = composeOne<ToyboxPreset>('preset', ordered, (p) => p.presets(), shadowed);
  memo = {
    content: c.map,
    models: m.map,
    presets: pr.map,
    contentList: c.list,
    modelList: m.list,
    presetList: pr.list,
    shadowed,
  };
  memoRevision = revision;
  return memo;
}

// ---------------- Synchronous lookups (the hot path) ----------------

/** Resolve a content id across all providers. SYNC — safe per-frame. */
export function resolveContent(id: string): ToyboxContent | undefined {
  return index().content.get(id);
}

/** Resolve a model id across all providers. SYNC — safe per-frame. */
export function resolveModel(id: string): ToyboxModel | undefined {
  return index().models.get(id);
}

/** Resolve a preset id across all providers. SYNC. */
export function resolvePreset(id: string): ToyboxPreset | undefined {
  return index().presets.get(id);
}

/** Every LISTED content entry, in provider-precedence then declaration order. */
export function listedContent(): readonly ToyboxContent[] {
  return index().contentList;
}

/** Every LISTED model entry. */
export function listedModels(): readonly ToyboxModel[] {
  return index().modelList;
}

/** Every LISTED preset entry. */
export function listedPresets(): readonly ToyboxPreset[] {
  return index().presetList;
}

/**
 * Id collisions seen during composition, i.e. every entry a provider offered
 * that a higher-precedence provider already owned. Empty in the normal case.
 * Surfaced so the load UI can explain a rejected name instead of appearing to
 * accept it and then rendering something else.
 */
export function shadowedToyboxAssets(): readonly ToyboxAssetShadow[] {
  return index().shadowed;
}

// ---------------- The runtime provider ----------------

interface RuntimeStore {
  content: Map<string, ToyboxAssetEntry<ToyboxContent>>;
  models: Map<string, ToyboxAssetEntry<ToyboxModel>>;
  presets: Map<string, ToyboxAssetEntry<ToyboxPreset>>;
}

const runtime: RuntimeStore = {
  content: new Map(),
  models: new Map(),
  presets: new Map(),
};

/**
 * The session-registered asset provider.
 *
 * ⚠ SESSION-LOCAL AND NOT PERSISTED — and that is deliberately NOT a sync
 * regression. See `registerRuntimeToyboxAsset`.
 */
export const runtimeToyboxProvider: ToyboxAssetProvider = {
  name: 'runtime',
  precedence: RUNTIME_PRECEDENCE,
  content: () => [...runtime.content.values()],
  models: () => [...runtime.models.values()],
  presets: () => [...runtime.presets.values()],
};

registerToyboxAssetProvider(runtimeToyboxProvider);

/** What a runtime registration did.
 *
 *  ⚠ `effective` is a SNAPSHOT taken against the index as it stands at the
 *  moment of registration, and the answer can legitimately change afterwards:
 *  registering an id BEFORE the manifest has loaded is effective, and stops
 *  being so once the manifest lands carrying that same id. For a live answer
 *  ask `shadowedToyboxAssets()`, which is recomputed with the index. */
export interface RuntimeRegistration {
  kind: ToyboxAssetKind;
  id: string;
  /** True when this id resolves to the registered asset right now. */
  effective: boolean;
  /** Set when `effective` is false: the provider that owns the id instead. */
  shadowedBy?: string;
}

/** Which provider currently owns an id in the composed index, if any. */
function currentOwner(kind: ToyboxAssetKind, id: string): string | undefined {
  const ordered = toyboxAssetProviders();
  for (const p of ordered) {
    const entries =
      kind === 'content' ? p.content() : kind === 'model' ? p.models() : p.presets();
    for (const e of entries) if (e.asset.id === id) return p.name;
  }
  return undefined;
}

/**
 * Register (or replace) a session-local asset.
 *
 * ── WHY THIS DOES NOT CHANGE WHAT SYNCS ────────────────────────────────────
 *
 * The obvious worry about a session-local registry is that it makes a rack
 * DIVERGE: peer A sees an asset peer B does not. For the disk-ingest path it
 * does not, and the reason is that the registry is a CACHE OF A PURE FUNCTION
 * OVER DATA THAT ALREADY SYNCS, not a second source of truth.
 *
 * A disk-loaded shader's bytes live on the LAYER (`shaderSrc`), which rides the
 * Y.Doc exactly as before — untouched by this change. Its registry id is
 * `customShaderKey(src)`, a pure djb2 hash OF THOSE SYNCED BYTES. So every peer
 * holding the synced layer can independently derive the identical key and
 * independently register identical derived metadata, with no coordination and
 * nothing extra on the wire. Registration is memoization, and the thing being
 * memoized is deterministic.
 *
 * What a peer that never registers loses is only the DERIVED metadata (the
 * extracted params) — never the source, which it has. That is the pre-existing
 * behaviour for custom shaders, so nothing regresses.
 *
 * ⚠ The corollary, and the real limit: a registration made by ONE peer is not
 * seen by another. Convergence comes from every peer running the same derivation
 * over the same synced bytes, so registration must happen wherever the source is
 * OBSERVED, not only where the file was picked. The disk ingest registers at
 * pick time (this PR); the observe-side registration lands with the engine
 * change that consumes these params (see the PR body).
 */
export function registerRuntimeToyboxAsset(
  kind: 'content',
  asset: ToyboxContent,
  opts: { listed: boolean },
): RuntimeRegistration;
export function registerRuntimeToyboxAsset(
  kind: 'model',
  asset: ToyboxModel,
  opts: { listed: boolean },
): RuntimeRegistration;
export function registerRuntimeToyboxAsset(
  kind: 'preset',
  asset: ToyboxPreset,
  opts: { listed: boolean },
): RuntimeRegistration;
export function registerRuntimeToyboxAsset(
  kind: ToyboxAssetKind,
  asset: ToyboxContent | ToyboxModel | ToyboxPreset,
  opts: { listed: boolean },
): RuntimeRegistration {
  const entry = { asset, listed: opts.listed };
  if (kind === 'content') runtime.content.set(asset.id, entry as ToyboxAssetEntry<ToyboxContent>);
  else if (kind === 'model') runtime.models.set(asset.id, entry as ToyboxAssetEntry<ToyboxModel>);
  else runtime.presets.set(asset.id, entry as ToyboxAssetEntry<ToyboxPreset>);
  invalidateToyboxAssets();

  // Ask the LIVE index who owns the id now, rather than assuming the
  // registration took: a higher-precedence provider may already hold it.
  const owner = currentOwner(kind, asset.id);
  return owner === runtimeToyboxProvider.name || owner === undefined
    ? { kind, id: asset.id, effective: true }
    : { kind, id: asset.id, effective: false, shadowedBy: owner };
}

/** Drop one session-local asset. Returns whether one was present. */
export function unregisterRuntimeToyboxAsset(kind: ToyboxAssetKind, id: string): boolean {
  const store =
    kind === 'content' ? runtime.content : kind === 'model' ? runtime.models : runtime.presets;
  const had = store.delete(id);
  if (had) invalidateToyboxAssets();
  return had;
}

/** Drop every session-local asset. Used by tests and by a session teardown. */
export function clearRuntimeToyboxAssets(): void {
  const had = runtime.content.size + runtime.models.size + runtime.presets.size > 0;
  runtime.content.clear();
  runtime.models.clear();
  runtime.presets.clear();
  if (had) invalidateToyboxAssets();
}
