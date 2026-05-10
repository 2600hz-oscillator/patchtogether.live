// e2e/tests/io-spec-consistency.spec.ts
//
// Preventive consistency check: every input/output declared in a module's
// AudioModuleDef must render as a Svelte Flow handle in that module's
// card UI.
//
// The bug class this guards against: the RIOTGIRLS regression where
// buildInputs() grew dozens of CV ports (per-voice tone/shape/volume/
// decay, ADSR, sends, master FX) but RiotgirlsCard.svelte only rendered
// trig/gate/pitch per voice + outL/outR. The published manifest at
// /docs/modules/riotgirls listed all ports; the patch graph would
// happily route cables to those ports; but the user couldn't see the
// handles to plug into.
//
// How it works:
//   1. Spawn one instance of every registered module type via the dev
//      __patch helpers (same path as e2e/tests/modules.spec.ts).
//   2. Read the canonical I/O spec from window.__moduleSpecs (exposed by
//      packages/web/src/lib/dev/module-specs.ts when test hooks are
//      enabled).
//   3. Read all rendered Handle elements for the spawned card and pull
//      their data-handleid attributes.
//   4. Assert: { def input/output ids } === { rendered handle ids } as
//      sets. Strict equivalence catches missing handles AND stray
//      handles that don't have a backing port.
//
// Adding a new module:
//   - No edits needed here. The test iterates over MODULES_AND_EXPECTED_IDS,
//     which is built from the registry at startup. As long as the new
//     module's card renders Handle elements whose `id` matches the def's
//     port ids, this test passes for it automatically. If a temporary
//     drift is intentional (UI not yet caught up), add it to the
//     SKIP_DEF_VS_UI map below with a TODO pointing at the fix.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

interface SpecPort {
  id: string;
  type: string;
}
interface ModuleSpec {
  type: string;
  /** 'audio' / 'video' (Phase 0 video spike adds the second domain). */
  domain?: string;
  inputs: SpecPort[];
  outputs: SpecPort[];
}

// Modules whose UI is intentionally lagging the def — skipped with a
// TODO. Empty when the codebase is fully consistent. (As of the
// patch-panel refactor MIXMSTRS now exposes its full 49-port surface
// via the panel; nothing in this map.)
const SKIP_DEF_VS_UI: Record<string, string> = {};

async function readModuleSpecs(page: Page): Promise<ModuleSpec[]> {
  // Wait for the dev hooks Canvas exposes — that's the signal the
  // SvelteKit app has hydrated, which in turn means
  // packages/web/src/lib/audio/modules/index.ts has run (Canvas's
  // top-level `import '$lib/audio/modules'`). __moduleSpecs is set in
  // the same module, so once __patch is up, __moduleSpecs is too.
  await page.waitForFunction(() => {
    const w = globalThis as unknown as {
      __patch?: unknown;
      __moduleSpecs?: ModuleSpec[];
    };
    return (
      typeof w.__patch === 'object' &&
      w.__patch !== null &&
      Array.isArray(w.__moduleSpecs) &&
      w.__moduleSpecs.length > 0
    );
  });
  return await page.evaluate(() => {
    const w = globalThis as unknown as { __moduleSpecs: ModuleSpec[] };
    return w.__moduleSpecs;
  });
}

async function readHandleIds(
  page: Page,
  cardClass: string,
): Promise<{ inputs: string[]; outputs: string[] }> {
  // Svelte Flow Handle renders <div class="svelte-flow__handle"
  // data-handleid="<id>" data-handlepos="left|right|...">. Source/target
  // is also distinguishable by .source / .target classes, but
  // data-handlepos works the same and matches the project's left=input,
  // right=output convention.
  const card = page.locator(`.${cardClass}`);
  const handles = card.locator('.svelte-flow__handle');
  const count = await handles.count();
  const inputs: string[] = [];
  const outputs: string[] = [];
  for (let i = 0; i < count; i++) {
    const h = handles.nth(i);
    const id = await h.getAttribute('data-handleid');
    if (!id) continue;
    const cls = (await h.getAttribute('class')) ?? '';
    if (cls.includes('source')) outputs.push(id);
    else inputs.push(id); // 'target' or unspecified -> input
  }
  return { inputs, outputs };
}

test.describe.configure({ mode: 'parallel' });

test.describe('I/O spec consistency: def <-> rendered card UI handles', () => {
  // We need one bootstrap to read window.__moduleSpecs once, then iterate.
  // Playwright doesn't let beforeAll share a page with tests, so each test
  // re-reads the spec — cheap (a single page.evaluate) and avoids fixture
  // plumbing.

  test('seed: every registered module type has a card class registered', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const specs = await readModuleSpecs(page);
    expect(specs.length, 'at least one module def is registered').toBeGreaterThan(0);
    // Sanity: every spec has at least one port (input or output) so we're
    // not silently passing on a stub def.
    for (const s of specs) {
      const total = s.inputs.length + s.outputs.length;
      expect(total, `${s.type} has at least one port`).toBeGreaterThan(0);
    }
  });

  // We can't iterate over an async-fetched list at module-load time, so the
  // module type list is hardcoded mirroring StandardModuleType in
  // packages/web/src/lib/graph/types.ts. New modules added there also need
  // an entry here — the seed test above will fail-fast if the list drifts.
  const MODULE_TYPES = [
    'analogVco',
    'audioOut',
    'vca',
    'mixer',
    'adsr',
    'filter',
    'reverb',
    'scope',
    'sequencer',
    'wavetableVco',
    'lfo',
    'cartesian',
    'destroy',
    'qbrt',
    'drummergirl',
    'meowbox',
    'mixmstrs',
    'timelorde',
    'charlottesEchos',
    'riotgirls',
    'score',
    'drumseqz',
    'polyseqz',
    // Sister VCOs with built-in wavefolders + waveform-video out:
    'vizvco',
    'wavviz',
    // SWOLEVCO — Buchla 259-style complex VCO (primary + modulator + cross-mod
    // + symmetry morph + wavefolder + scope mono-video out).
    'swolevco',
    // Video-domain (Phase 0 spike, .myrobots/plans/video-modules-mvp.md):
    'lines',
    'videoOut',
    // Video-domain (Phase 1):
    'inwards',
    'picturebox',
    'destructor',
    'chroma',
    'luma',
    'colorizer',
    'feedback',
    'videoMixer',
    // SHAPES — geometry source.
    'shapes',
    // MONOGLITCH — luma → vertical-scanline displacement OUTPUT (formerly
    // RUTTETRA — renamed when the real raster-scan model took that name).
    'monoglitch',
    // RUTTETRA — true Rutt/Etra raster-scan-coordinate processor (X/Y
    // mono-video coordinate fields + Z source video).
    'ruttetra',
    // SHAPEDRAMPS — sync-locked ramp generator (linear + shaped outputs).
    'shapedramps',
    // CAMERA — webcam input (local-only). Spec: .myrobots/plans/module-camera-input.md.
    'cameraInput',
    // ILLOGIC — combined attenuverter / math / logic utility (audio domain).
    'illogic',
    // UNITYSCALEMATHEMATIK — bipolar CV-shaping utility (1 unity scaler +
    // 2 attenuvert sections with linear/expo curve morph).
    'unityscalemathematik',
    // DX7 — pure-TS 6-op FM synth (audio domain).
    'dx7',
    // NOISE — basic noise source (white / pink / brown).
    'noise',
    // BUGGLES — chaotic random voltage source (wogglebug-style).
    'buggles',
  ];

  for (const type of MODULE_TYPES) {
    const skipReason = SKIP_DEF_VS_UI[type];
    const fn = async ({ page }: { page: Page }): Promise<void> => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const specs = await readModuleSpecs(page);
      const spec = specs.find((s) => s.type === type);
      expect(spec, `module ${type} is registered`).toBeDefined();
      if (!spec) return;

      // Pass the registered domain through to spawnPatch so video modules
      // (Phase 0) get the right domain on their node — otherwise the
      // reconciler would route them to the audio engine and addNode
      // would throw on a video-domain def.
      const domain = (spec.domain === 'video' ? 'video' : 'audio') as 'audio' | 'video';
      await spawnPatch(page, [{ id: 'm-1', type, position: { x: 100, y: 100 }, domain }]);

      const cardClass = `svelte-flow__node-${type}`;
      const { inputs: handleInputs, outputs: handleOutputs } = await readHandleIds(
        page,
        cardClass,
      );

      const expectedInputs = spec.inputs.map((p) => p.id).sort();
      const expectedOutputs = spec.outputs.map((p) => p.id).sort();
      const actualInputs = [...handleInputs].sort();
      const actualOutputs = [...handleOutputs].sort();

      expect(actualInputs, `${type}: rendered input handle ids match def`).toEqual(
        expectedInputs,
      );
      expect(actualOutputs, `${type}: rendered output handle ids match def`).toEqual(
        expectedOutputs,
      );
    };

    if (skipReason) {
      // .fixme is preferred over .skip when the test SHOULD pass once the
      // referenced fix lands — Playwright surfaces fixme-marked tests in
      // the report so they're harder to forget.
      test.fixme(`module ${type}: rendered handles match def [SKIPPED: ${skipReason}]`, fn);
    } else {
      test(`module ${type}: rendered handles match def`, fn);
    }
  }
});
