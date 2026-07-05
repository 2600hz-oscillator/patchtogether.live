// e2e/tests/save-load.spec.ts
//
// JSON patch save/load DATA round-trip (Phase 1 done-gate item).
//
// The manual Save / Load patch buttons were retired in rack Phase 3 (the
// portable .ptperf.zip export/import is the survivor; auto-sync covers durable
// per-rack persistence). The underlying envelope save/load is still exercised
// here via the dev __persistence hook (the same makeEnvelope / loadEnvelope
// path the .zip + auto-sync use), so the round-trip contract stays covered
// without depending on removed topbar buttons.
//
// Format spec: v2 LEAN envelope (cleanup 5/5): envelopeVersion=2, savedAt,
// base64 Y.encodeStateAsUpdate — the per-module moduleSchemas map was dropped
// with the migration substrate (parseEnvelope still tolerantly READS v1).

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

interface PatchEnvelope {
  envelopeVersion: number;
  savedAt: string;
  /** Dropped from v2 saves — asserted ABSENT below (legacy v1 field). */
  moduleSchemas?: Record<string, number>;
  update: string;
}

test('save-load: round-trip preserves nodes, edges, params, and sequencer step data', async ({
  page,
}) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  // Build the canonical voice chain (5 nodes, 6 edges, sequencer with steps).
  await spawnPatch(
    page,
    [
      {
        id: 'seq',
        type: 'sequencer',
        params: { bpm: 180, length: 8, isPlaying: 1, gateLength: 0.4 },
      },
      { id: 'vco',  type: 'analogVco' },
      { id: 'adsr', type: 'adsr', params: { attack: 0.005, decay: 0.08, sustain: 0.3, release: 0.15 } },
      { id: 'vca',  type: 'vca',  params: { base: 0, cvAmount: 1 } },
      { id: 'out',  type: 'audioOut', params: { master: 0.4 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'seq',  portId: 'pitch' }, to: { nodeId: 'vco',  portId: 'pitch' }, sourceType: 'pitch', targetType: 'pitch' },
      { id: 'e2', from: { nodeId: 'seq',  portId: 'gate'  }, to: { nodeId: 'adsr', portId: 'gate'  }, sourceType: 'gate',  targetType: 'gate'  },
      { id: 'e3', from: { nodeId: 'vco',  portId: 'sine'  }, to: { nodeId: 'vca',  portId: 'audio' } },
      { id: 'e4', from: { nodeId: 'adsr', portId: 'env'   }, to: { nodeId: 'vca',  portId: 'cv'    }, sourceType: 'cv', targetType: 'cv' },
      { id: 'e5', from: { nodeId: 'vca',  portId: 'audio' }, to: { nodeId: 'out',  portId: 'L'     } },
      { id: 'e6', from: { nodeId: 'vca',  portId: 'audio' }, to: { nodeId: 'out',  portId: 'R'     } },
    ],
  );

  // Set sequencer step data via the live patch.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      w.__patch.nodes['seq'].data = {
        // v2 step encoding: midi int (60 = C4); null = empty.
        steps: [
          { on: true, midi: 60 }, { on: true, midi: 67 },
          { on: false, midi: null }, { on: true, midi: 72 },
          { on: true, midi: 67 }, { on: false, midi: null },
          { on: true, midi: 65 }, { on: true, midi: 64 },
        ],
      };
    });
  });

  // Snapshot the patch before save.
  const before = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: {
        nodes: Record<string, unknown>;
        edges: Record<string, unknown>;
      };
    };
    return {
      nodes: JSON.parse(JSON.stringify(w.__patch.nodes)),
      edges: JSON.parse(JSON.stringify(w.__patch.edges)),
    };
  });

  // Save → clear → load round-trip.
  const result = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __persistence: {
        save: () => unknown;
        load: (env: unknown) => unknown;
      };
      __patch: { nodes: Record<string, unknown>; edges: Record<string, unknown> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    const env = w.__persistence.save();
    // Clear everything
    w.__ydoc.transact(() => {
      for (const id of Object.keys(w.__patch.edges)) delete w.__patch.edges[id];
      for (const id of Object.keys(w.__patch.nodes)) delete w.__patch.nodes[id];
    });
    // Load it back
    const loadResult = w.__persistence.load(env);
    return {
      env,
      loadResult,
      nodesAfter: JSON.parse(JSON.stringify(w.__patch.nodes)),
      edgesAfter: JSON.parse(JSON.stringify(w.__patch.edges)),
    };
  });

  // Envelope shape sanity — the v2 LEAN format (no moduleSchemas).
  const env = result.env as PatchEnvelope;
  expect(env.envelopeVersion).toBe(2);
  expect(typeof env.savedAt).toBe('string');
  expect(env.moduleSchemas).toBeUndefined();
  expect(env.update).toMatch(/^[A-Za-z0-9+/=]+$/); // base64

  // Round-trip data integrity.
  expect(Object.keys(result.nodesAfter).sort()).toEqual(Object.keys(before.nodes).sort());
  expect(Object.keys(result.edgesAfter).sort()).toEqual(Object.keys(before.edges).sort());

  // Sequencer step data preserved exactly.
  const seqAfter = (result.nodesAfter as Record<string, { data?: { steps?: unknown[] } }>)['seq'];
  expect(seqAfter.data?.steps).toBeDefined();
  expect(seqAfter.data!.steps!.length).toBe(8);
  expect(seqAfter.data!.steps![0]).toEqual({ on: true, midi: 60 });
  expect(seqAfter.data!.steps![3]).toEqual({ on: true, midi: 72 });

  // Params preserved.
  const vcaAfter = (result.nodesAfter as Record<string, { params: Record<string, number> }>)['vca'];
  expect(vcaAfter.params.base).toBe(0);
  expect(vcaAfter.params.cvAmount).toBe(1);

  // Edges preserved with correct endpoints + types.
  const e3 = (result.edgesAfter as Record<string, { source: { nodeId: string; portId: string }; target: { nodeId: string; portId: string }; sourceType: string }>)['e3'];
  expect(e3.source).toEqual({ nodeId: 'vco', portId: 'sine' });
  expect(e3.target).toEqual({ nodeId: 'vca', portId: 'audio' });

  // Load result diagnostics — should be clean (5 nodes, 6 edges, no warnings).
  const lr = result.loadResult as { nodesLoaded: number; edgesLoaded: number; diagnostics: unknown[] };
  expect(lr.nodesLoaded).toBe(5);
  expect(lr.edgesLoaded).toBe(6);
  expect(lr.diagnostics).toEqual([]);

  // Engine reconciles the loaded state — DOM eventually shows 5 nodes.
  await expect(page.locator('.svelte-flow__node')).toHaveCount(5);
});

test('save-load: __persistence.save() emits a valid PatchEnvelope JSON', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  await page.getByTestId('load-example-select').selectOption('sequenced-vco');
  await expect(page.locator('.svelte-flow__node')).toHaveCount(5, { timeout: 10_000 });

  // The retired Save button used makeEnvelope(ydoc); __persistence.save() is the
  // exact same call, so this still proves the envelope contract.
  const env = (await page.evaluate(() => {
    const w = globalThis as unknown as { __persistence: { save: () => unknown } };
    return w.__persistence.save();
  })) as PatchEnvelope;

  expect(env.envelopeVersion).toBe(2);
  expect(typeof env.savedAt).toBe('string');
  expect(new Date(env.savedAt).getTime()).toBeGreaterThan(0); // valid ISO date
  // v2 lean format: the moduleSchemas map is no longer stamped.
  expect(env.moduleSchemas).toBeUndefined();
  // base64 of a non-trivial Yjs update
  expect(env.update.length).toBeGreaterThan(100);
  expect(env.update).toMatch(/^[A-Za-z0-9+/=]+$/);
});

test('save-load: __persistence.load() restores the patch from a saved envelope', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  // Start with a known patch and capture its envelope.
  await page.getByTestId('load-example-select').selectOption('sequenced-vco');
  await expect(page.locator('.svelte-flow__node')).toHaveCount(5, { timeout: 10_000 });

  const env = await page.evaluate(() => {
    const w = globalThis as unknown as { __persistence: { save: () => unknown } };
    return w.__persistence.save();
  });

  // Clear the patch.
  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(page.locator('.svelte-flow__node')).toHaveCount(0);

  // Load the captured envelope back through the same path the .zip import uses.
  await page.evaluate((envIn) => {
    const w = globalThis as unknown as { __persistence: { load: (env: unknown) => unknown } };
    w.__persistence.load(envIn);
  }, env);

  // Engine reconciles → 5 nodes + 6 edges back on the canvas.
  await expect(page.locator('.svelte-flow__node')).toHaveCount(5, { timeout: 5_000 });
  await expect(page.locator('.svelte-flow__edge')).toHaveCount(6);
});
