// e2e/tests/io-spec-consistency.spec.ts
//
// Preventive consistency check: every input/output declared in a
// module's AudioModuleDef must render as a Svelte Flow handle in that
// module's card UI.
//
// The bug class this guards against: the RIOTGIRLS regression where
// buildInputs() grew dozens of CV ports (per-voice tone/shape/volume/
// decay, ADSR, sends, master FX) but RiotgirlsCard.svelte only
// rendered trig/gate/pitch per voice + outL/outR. The published
// manifest at /docs/modules/riotgirls listed all ports; the patch
// graph would happily route cables to those ports; but the user
// couldn't see the handles to plug into.
//
// How it works:
//   1. Read the synthesised registry manifest (e2e/.generated/
//      registry-manifest.json — emitted by the unit-test pass; see
//      packages/web/src/lib/dev/registry-manifest.test.ts) at file-
//      parse time via the _registry.ts fixture.
//   2. Generate one test per registered module type.
//   3. Each test spawns the module via spawnPatch, reads the rendered
//      Handle elements' data-handleid attributes, and asserts strict
//      set-equality with the def's declared port ids.
//
// Adding a new module: no edits needed here. The registry barrels
// import the new module at registration time; the manifest emitter
// picks it up; this spec iterates the manifest. The only hand-
// curated structure left is SKIP_DEF_VS_UI for intentional UI lag.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { REGISTRY, type RegistryModule } from './_registry';

// Suppress the VideoEngine's heavy per-frame GL draw for video-domain cards.
// Set via addInitScript (document_start, every navigation) so it covers
// spawnPatch's navigation. The card still mounts (handles render); only the
// SwiftShader-bound per-frame draw passes are skipped. Mirrors the helper in
// per-module-per-port.spec.ts; kept local because that one isn't exported.
async function freezeVideoRender(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (globalThis as unknown as { __videoEngineFreezeRender?: boolean })
      .__videoEngineFreezeRender = true;
  });
}

// Modules whose UI is intentionally lagging the def — skipped with a
// TODO + a pointer at the dedicated coverage. Each entry MUST cite an
// alternative spec so we don't lose coverage by hiding the failure.
const SKIP_DEF_VS_UI: Record<string, string> = {
  // GROUP is a meta-domain container whose card body renders the
  // exposed-ports surface of the modules a user added INSIDE it. A
  // bare spawnPatch({type:'group'}) without `data.children` doesn't
  // render the Svelte Flow node, so spawnPatch's "wait for N nodes"
  // check times out. Functional coverage lives in
  // e2e/tests/grouping-phase1.spec.ts (creates a group from an
  // actual selection of modules). Promote here once a spawnPatch
  // overload accepts initial node.data.
  group: 'requires data.children; covered by e2e/tests/grouping-phase1.spec.ts',
  // CADILLAC renders as a roaming overlay sprite (CadillacOverlay), not
  // as a SvelteFlow card — Canvas.svelte filters it out of flowNodes so
  // xyflow doesn't paint a fallback box. spawnPatch's "wait for N cards"
  // would hang. The def has zero ports anyway (it's meta-domain).
  // Functional coverage: e2e/tests/cadillac.spec.ts.
  cadillac: 'overlay sprite, not a flow card (zero ports); covered by e2e/tests/cadillac.spec.ts',
};

async function readHandleIds(
  page: Page,
  cardClass: string,
): Promise<{ inputs: string[]; outputs: string[] }> {
  // Svelte Flow Handle renders <div class="svelte-flow__handle"
  // data-handleid="<id>" data-handlepos="left|right|...">. Source /
  // target is distinguishable by `.source` / `.target` classes.
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
    else inputs.push(id); // 'target' or unspecified → input
  }
  return { inputs, outputs };
}

test.describe.configure({ mode: 'parallel' });

test.describe('I/O spec consistency: def <-> rendered card UI handles', () => {
  test('seed: registry manifest is non-empty + every non-meta module has ≥1 port', () => {
    expect(REGISTRY.length, 'manifest contains modules').toBeGreaterThan(0);
    // Meta-domain modules (sticky, group) intentionally have zero
    // ports — they're pure-UI cards with no signal-routing surface.
    // LIVECODE + clockedRunner are side-tools that mutate the rack
    // via the JS runtime; they intentionally have no patch I/O.
    const ZERO_PORT_OK = new Set(['livecode', 'clockedRunner']);
    for (const s of REGISTRY) {
      if (s.domain === 'meta') continue;
      if (ZERO_PORT_OK.has(s.type)) continue;
      const total = s.inputs.length + s.outputs.length;
      expect(total, `${s.type} has at least one port`).toBeGreaterThan(0);
    }
  });

  for (const mod of REGISTRY) {
    const skipReason = SKIP_DEF_VS_UI[mod.type];
    const fn = async ({ page }: { page: Page }): Promise<void> => {
      // WebGL-heavy cards (mandelbulb/toybox/cube/quadralogical/b3ntb0x/…)
      // paint their connection handles slowly on CI's software renderer, so the
      // 30s default times out while handles are still mounting. Give headroom.
      test.setTimeout(60_000);
      // Suppress the heavy per-frame video GL render for the whole iteration
      // (same mechanism as per-module-per-port's handle sweeps). This spec
      // asserts only DOM-level handle ids; the engine still mounts the card
      // (shaders compiled, FBOs allocated → handles render) but skips the
      // SwiftShader-bound per-frame draw passes that otherwise starve out the
      // sequential getAttribute loop on a 19-handle card like b3ntb0x. See
      // VideoEngine.step()'s __videoEngineFreezeRender branch. No-op for
      // non-video modules (only the video engine reads the flag).
      if (mod.domain === 'video') await freezeVideoRender(page);
      await page.goto('/rack');
      await page.waitForLoadState('networkidle');

      await spawnPatch(page, [
        {
          id: 'm-1',
          type: mod.type,
          position: { x: 100, y: 100 },
          domain: mod.domain,
        },
      ]);

      const cardClass = `svelte-flow__node-${mod.type}`;
      // Wait for ALL handles to render before snapshotting their ids. A bare
      // count() taken mid-render undercounts (or nth(i) times out) on slow GL
      // cards → flaky id-mismatch / getAttribute timeout. Settling on the
      // def's port total is deterministic and only costs time for slow cards.
      const expectedHandles = mod.inputs.length + mod.outputs.length;
      await expect(
        page.locator(`.${cardClass}`).locator('.svelte-flow__handle'),
        `${mod.type}: all ${expectedHandles} handles rendered before reading ids`,
      ).toHaveCount(expectedHandles, { timeout: 45_000 });
      const { inputs: handleInputs, outputs: handleOutputs } = await readHandleIds(
        page,
        cardClass,
      );

      const expectedInputs = mod.inputs.map((p: RegistryModule['inputs'][number]) => p.id).sort();
      const expectedOutputs = mod.outputs.map((p: RegistryModule['outputs'][number]) => p.id).sort();
      const actualInputs = [...handleInputs].sort();
      const actualOutputs = [...handleOutputs].sort();

      expect(actualInputs, `${mod.type}: rendered input handle ids match def`).toEqual(
        expectedInputs,
      );
      expect(actualOutputs, `${mod.type}: rendered output handle ids match def`).toEqual(
        expectedOutputs,
      );
    };

    if (skipReason) {
      // .fixme over .skip when the test SHOULD pass once the fix lands —
      // Playwright surfaces fixme-marked tests in the report so they're
      // harder to forget.
      test.fixme(`module ${mod.type}: rendered handles match def [SKIPPED: ${skipReason}]`, fn);
    } else {
      test(`module ${mod.type}: rendered handles match def`, fn);
    }
  }
});
