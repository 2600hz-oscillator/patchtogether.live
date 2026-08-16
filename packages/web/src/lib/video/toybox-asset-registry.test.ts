// packages/web/src/lib/video/toybox-asset-registry.test.ts
//
// The TOYBOX asset provider seam (#1576, workstream 2).
//
// ⚠ SCOPE — what these tests CANNOT see, stated up front:
//   * They do not prove any SHADER COMPILES (that is toybox-shader-validate) nor
//     that a `glsl` URL resolves — the registry deliberately never fetches or
//     validates, so a green run here says nothing about content being playable.
//   * They do not exercise the real static manifest. The fetch is stubbed with a
//     fixture, so a malformed shipped manifest.json would not redden this file;
//     the e2e/VRT specs cover the real one.
//   * They do not prove the ENGINE reads a runtime asset's params. This PR wires
//     registration, not consumption (see the PR body) — so "registered" here
//     means resolvable by `getContentMeta`, not rendered.
//
// The module holds process-global state, so every test rebuilds the modules with
// `vi.resetModules()` and gets its own registry.

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ToyboxContent, ToyboxModel, ToyboxPreset } from './toybox-content';

// A fixture manifest with the two family buckets the real one has: `gen` is
// family GEN, `shaders` is family FX|FRAG.
const FIXTURE = {
  version: 1,
  gen: [
    { id: 'gen-a', label: 'GEN A', family: 'GEN', glsl: '/toybox/shaders/gen-a.glsl', params: [] },
    { id: 'gen-b', label: 'GEN B', family: 'GEN', glsl: '/toybox/shaders/gen-b.glsl', params: [] },
  ],
  shaders: [
    { id: 'fx-a', label: 'FX A', family: 'FX', glsl: '/toybox/shaders/fx-a.glsl', params: [] },
    { id: 'frag-a', label: 'FRAG A', family: 'FRAG', glsl: '/toybox/shaders/frag-a.glsl', params: [] },
  ],
  models: [
    { id: 'model-a', label: 'MODEL A', obj: '/toybox/models/model-a.obj' },
    { id: 'cube', label: 'CUBE', builtin: 'cube' },
  ],
  presets: [
    { id: 'preset-a', label: 'PRESET A', layers: [], combine: { nodes: [], edges: [] }, cvRoutes: {} },
  ],
};

/** Fresh module graph + a stubbed manifest fetch. Each test gets its own state. */
async function freshModules(manifest: unknown = FIXTURE) {
  vi.resetModules();
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => manifest,
  }));
  vi.stubGlobal('fetch', fetchMock);
  const registry = await import('./toybox-asset-registry');
  const content = await import('./toybox-content');
  return { registry, content, fetchMock };
}

function makeContent(id: string, label = id.toUpperCase()): ToyboxContent {
  return { id, label, family: 'GEN', glsl: `/x/${id}.glsl`, params: [] };
}
function makeModel(id: string): ToyboxModel {
  return { id, label: id.toUpperCase(), builtin: 'cube' };
}
function makePreset(id: string): ToyboxPreset {
  return { id, label: id.toUpperCase(), layers: [], combine: { nodes: [], edges: [] }, cvRoutes: {} };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// THE HARD CONSTRAINT: lookups are SYNCHRONOUS.
// ---------------------------------------------------------------------------

describe('sync lookup contract (the constraint the seam exists to preserve)', () => {
  it('getContentMeta / getModelMeta / getPresetMeta return values, never promises', async () => {
    const { content } = await freshModules();
    await content.ensureToyboxCatalog();
    const got = [
      content.getContentMeta('gen-a'),
      content.getModelMeta('model-a'),
      content.getPresetMeta('preset-a'),
    ];
    // A Promise would satisfy a `toBeDefined` assertion just as happily, which
    // is exactly how an async regression would slip past — so assert the shape.
    for (const v of got) {
      expect(v).toBeDefined();
      expect(typeof (v as { then?: unknown }).then).toBe('undefined');
    }
    expect(got.map((v) => (v as { id: string }).id)).toEqual(['gen-a', 'model-a', 'preset-a']);
  });

  it('still returns undefined BEFORE the manifest resolves (unchanged contract)', async () => {
    const { content } = await freshModules();
    // No ensureToyboxCatalog() — the pre-#1576 behaviour every call site codes
    // against is that an un-awaited catalog yields undefined, not a throw.
    expect(content.getContentMeta('gen-a')).toBeUndefined();
    expect(content.getModelMeta('model-a')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ORDERING: the two directions, one of which a naive cache assignment destroys.
// ---------------------------------------------------------------------------

describe('registration ordering vs manifest load', () => {
  it('an asset registered AFTER the manifest loaded is visible to the next SYNC lookup', async () => {
    const { registry, content } = await freshModules();
    await content.ensureToyboxCatalog();
    expect(content.getContentMeta('late-one')).toBeUndefined();

    registry.registerRuntimeToyboxAsset('content', makeContent('late-one'), { listed: true });

    // No await between the registration and the lookup — that is the point.
    expect(content.getContentMeta('late-one')?.label).toBe('LATE-ONE');
  });

  it('an asset registered BEFORE the manifest loaded SURVIVES the load', async () => {
    // The regression this guards: `loadManifest` used to ASSIGN the module-level
    // caches (`byId = new Map(...)`). Composing into a shared index instead of
    // assigning is what keeps an early registration alive; an assignment would
    // silently wipe it, and nothing else in the suite would notice.
    const { registry, content } = await freshModules();
    registry.registerRuntimeToyboxAsset('content', makeContent('early-one'), { listed: true });
    expect(content.getContentMeta('early-one')).toBeDefined();

    await content.ensureToyboxCatalog();

    expect(content.getContentMeta('early-one')?.label).toBe('EARLY-ONE');
    // …and the manifest's own entries loaded alongside it.
    expect(content.getContentMeta('gen-a')?.label).toBe('GEN A');
  });
});

// ---------------------------------------------------------------------------
// PRECEDENCE: the manifest outranks runtime, in BOTH registration orders.
// ---------------------------------------------------------------------------

describe('id precedence — the static manifest always wins', () => {
  it('a runtime asset CANNOT shadow a manifest id (runtime registered second)', async () => {
    const { registry, content } = await freshModules();
    await content.ensureToyboxCatalog();

    const reg = registry.registerRuntimeToyboxAsset(
      'content',
      makeContent('gen-a', 'IMPOSTOR'),
      { listed: true },
    );

    expect(content.getContentMeta('gen-a')?.label).toBe('GEN A');
    expect(reg.effective).toBe(false);
    expect(reg.shadowedBy).toBe('static-manifest');
  });

  it('a runtime asset CANNOT shadow a manifest id (runtime registered FIRST)', async () => {
    // Precedence is DECLARED numerically, not derived from registration order,
    // so the outcome must be identical with the order reversed. If ordering
    // leaked into resolution this is the test that catches it.
    const { registry, content } = await freshModules();
    const reg = registry.registerRuntimeToyboxAsset(
      'content',
      makeContent('gen-a', 'IMPOSTOR'),
      { listed: true },
    );
    // Before the manifest exists the runtime entry legitimately resolves…
    expect(reg.effective).toBe(true);
    expect(content.getContentMeta('gen-a')?.label).toBe('IMPOSTOR');

    await content.ensureToyboxCatalog();

    // …and the moment the manifest lands it takes the id back.
    expect(content.getContentMeta('gen-a')?.label).toBe('GEN A');
  });

  it('reports the collision rather than dropping it silently', async () => {
    const { registry, content } = await freshModules();
    await content.ensureToyboxCatalog();
    registry.registerRuntimeToyboxAsset('content', makeContent('gen-a', 'IMPOSTOR'), {
      listed: true,
    });

    const shadows = registry.shadowedToyboxAssets();
    expect(shadows).toContainEqual({
      kind: 'content',
      id: 'gen-a',
      winner: 'static-manifest',
      loser: 'runtime',
    });
  });

  it('a NON-colliding runtime id produces no shadow at all', async () => {
    // Negative control for the shadow reporter: it must not fire on the
    // ordinary case, or "collision detected" would be worthless.
    const { registry, content } = await freshModules();
    await content.ensureToyboxCatalog();
    registry.registerRuntimeToyboxAsset('content', makeContent('nobody-elses-id'), {
      listed: true,
    });
    expect(registry.shadowedToyboxAssets()).toEqual([]);
  });

  it('applies the same precedence to MODELS and PRESETS, not just content', async () => {
    const { registry, content } = await freshModules();
    await content.ensureToyboxCatalog();

    const m = registry.registerRuntimeToyboxAsset('model', makeModel('model-a'), { listed: true });
    const p = registry.registerRuntimeToyboxAsset('preset', makePreset('preset-a'), {
      listed: true,
    });

    expect(m.effective).toBe(false);
    expect(p.effective).toBe(false);
    expect(content.getModelMeta('model-a')?.label).toBe('MODEL A');
    expect(content.getPresetMeta('preset-a')?.label).toBe('PRESET A');
  });
});

// ---------------------------------------------------------------------------
// LISTED vs RESOLVABLE — why this PR adds nothing to any dropdown.
// ---------------------------------------------------------------------------

describe('listed vs unlisted', () => {
  it('an UNLISTED asset resolves by id but appears in NO listing', async () => {
    const { registry, content } = await freshModules();
    await content.ensureToyboxCatalog();
    registry.registerRuntimeToyboxAsset('content', makeContent('custom-shader:abc'), {
      listed: false,
    });

    expect(content.getContentMeta('custom-shader:abc')).toBeDefined();
    const all = await content.listAllContent();
    expect(all.map((c) => c.id)).not.toContain('custom-shader:abc');
  });

  it('a LISTED runtime asset DOES appear — the positive control for the above', async () => {
    // Without this leg, "absent from the listing" could just mean the listing is
    // broken. This proves the listing can carry a runtime entry at all.
    const { registry, content } = await freshModules();
    await content.ensureToyboxCatalog();
    registry.registerRuntimeToyboxAsset('content', makeContent('browsable'), { listed: true });

    const all = await content.listAllContent();
    expect(all.map((c) => c.id)).toContain('browsable');
  });

  it('listAllContent is exactly the manifest entries when nothing is registered', async () => {
    const { content } = await freshModules();
    const all = await content.listAllContent();
    // Derived from the fixture, never a typed count: GEN first, then FX/FRAG.
    expect(all.map((c) => c.id)).toEqual([
      ...FIXTURE.gen.map((g) => g.id),
      ...FIXTURE.shaders.map((s) => s.id),
    ]);
  });
});

// ---------------------------------------------------------------------------
// The family partition that replaced the two manifest arrays.
// ---------------------------------------------------------------------------

describe('listShaders / listGen derive from family', () => {
  it('partition the catalog exactly as the manifest arrays did', async () => {
    const { content } = await freshModules();
    const gen = await content.listGen();
    const shaders = await content.listShaders();
    expect(gen.map((c) => c.id)).toEqual(FIXTURE.gen.map((g) => g.id));
    expect(shaders.map((c) => c.id)).toEqual(FIXTURE.shaders.map((s) => s.id));
  });

  it('the two partitions are disjoint and cover the whole catalog', async () => {
    // Property, not size: no entry may fall in both or neither bucket.
    const { content } = await freshModules();
    const all = await content.listAllContent();
    const gen = new Set((await content.listGen()).map((c) => c.id));
    const shaders = new Set((await content.listShaders()).map((c) => c.id));
    const both = all.filter((c) => gen.has(c.id) && shaders.has(c.id));
    const neither = all.filter((c) => !gen.has(c.id) && !shaders.has(c.id));
    expect({ both: both.map((c) => c.id), neither: neither.map((c) => c.id) }).toEqual({
      both: [],
      neither: [],
    });
  });
});

// ---------------------------------------------------------------------------
// NEGATIVE CONTROLS, in both directions, as a permanent leg.
// ---------------------------------------------------------------------------

describe('negative controls — the index really does recompose', () => {
  it('unregistering makes the id stop resolving (and re-registering brings it back)', async () => {
    const { registry, content } = await freshModules();
    await content.ensureToyboxCatalog();

    registry.registerRuntimeToyboxAsset('content', makeContent('toggle-me'), { listed: true });
    expect(content.getContentMeta('toggle-me')).toBeDefined();

    expect(registry.unregisterRuntimeToyboxAsset('content', 'toggle-me')).toBe(true);
    expect(content.getContentMeta('toggle-me')).toBeUndefined();

    registry.registerRuntimeToyboxAsset('content', makeContent('toggle-me'), { listed: true });
    expect(content.getContentMeta('toggle-me')).toBeDefined();
  });

  it('removing the shadowing entry clears the shadow report', async () => {
    const { registry, content } = await freshModules();
    await content.ensureToyboxCatalog();
    registry.registerRuntimeToyboxAsset('content', makeContent('gen-a', 'IMPOSTOR'), {
      listed: true,
    });
    expect(registry.shadowedToyboxAssets().length).toBeGreaterThan(0);

    registry.clearRuntimeToyboxAssets();
    expect(registry.shadowedToyboxAssets()).toEqual([]);
    // The manifest entry is untouched by the runtime provider's churn.
    expect(content.getContentMeta('gen-a')?.label).toBe('GEN A');
  });

  it('the memo is invalidated by mutation — a stale index would fail this', async () => {
    // The memo is the one piece of machinery whose bug would look like nothing:
    // a lookup that never recomposes returns correct-looking OLD data. Read the
    // revision, perturb, and assert it MOVED — then assert the read moved too.
    const { registry, content } = await freshModules();
    await content.ensureToyboxCatalog();
    const before = registry.toyboxAssetsRevision();
    content.getContentMeta('gen-a'); // force a composition, so a memo exists

    registry.registerRuntimeToyboxAsset('content', makeContent('perturbation'), { listed: true });

    expect(registry.toyboxAssetsRevision()).toBeGreaterThan(before);
    expect(content.getContentMeta('perturbation')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Provider bookkeeping.
// ---------------------------------------------------------------------------

describe('provider registration', () => {
  it('orders providers by declared precedence, manifest ahead of runtime', async () => {
    const { registry } = await freshModules();
    await import('./toybox-content'); // ensure the manifest provider registered
    const names = registry.toyboxAssetProviders().map((p) => p.name);
    expect(names.indexOf('static-manifest')).toBeLessThan(names.indexOf('runtime'));
  });

  it('re-registering a provider name REPLACES rather than double-listing', async () => {
    const { registry, content } = await freshModules();
    await content.ensureToyboxCatalog();
    const extra = {
      name: 'test-provider',
      precedence: registry.RUNTIME_PRECEDENCE + 1,
      content: () => [{ asset: makeContent('dupe-check'), listed: true }],
      models: () => [],
      presets: () => [],
    };
    registry.registerToyboxAssetProvider(extra);
    registry.registerToyboxAssetProvider(extra);

    const all = await content.listAllContent();
    expect(all.filter((c) => c.id === 'dupe-check')).toHaveLength(1);
    expect(registry.toyboxAssetProviders().filter((p) => p.name === 'test-provider')).toHaveLength(1);
  });

  it('unregistering a provider removes its assets', async () => {
    const { registry, content } = await freshModules();
    await content.ensureToyboxCatalog();
    registry.registerToyboxAssetProvider({
      name: 'test-provider',
      precedence: registry.RUNTIME_PRECEDENCE + 1,
      content: () => [{ asset: makeContent('provider-owned'), listed: true }],
      models: () => [],
      presets: () => [],
    });
    expect(content.getContentMeta('provider-owned')).toBeDefined();

    expect(registry.unregisterToyboxAssetProvider('test-provider')).toBe(true);
    expect(content.getContentMeta('provider-owned')).toBeUndefined();
    expect(registry.unregisterToyboxAssetProvider('test-provider')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The inline-source guard.
// ---------------------------------------------------------------------------

describe('inlineSource entries are never fetched', () => {
  it('getContent REFUSES an inline entry instead of requesting its sentinel URL', async () => {
    const { registry, content, fetchMock } = await freshModules();
    await content.ensureToyboxCatalog();
    const callsAfterManifest = fetchMock.mock.calls.length;

    registry.registerRuntimeToyboxAsset(
      'content',
      { ...makeContent('custom-shader:zzz'), inlineSource: true, glsl: 'inline:custom-shader:zzz' },
      { listed: false },
    );

    await expect(content.getContent('custom-shader:zzz')).rejects.toThrow(/inline/i);
    // …and it did not attempt a network request for the sentinel.
    expect(fetchMock.mock.calls.length).toBe(callsAfterManifest);
  });

  it('getContent still fetches an ORDINARY entry — the positive control', async () => {
    const { content, fetchMock } = await freshModules();
    await content.ensureToyboxCatalog();
    const before = fetchMock.mock.calls.length;
    // The stub returns an object without .text(), so the fetch itself is what we
    // are observing; the parse failing afterwards is irrelevant here.
    await content.getContent('gen-a').catch(() => {});
    expect(fetchMock.mock.calls.length).toBeGreaterThan(before);
  });
});
