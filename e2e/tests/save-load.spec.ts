// e2e/tests/save-load.spec.ts
//
// JSON patch save/load (Phase 1 done-gate item).
//
// Three layers covered:
//   1. Data round-trip: save → clear → load reconstructs the patch identically.
//   2. UI Save: clicking the Save button produces a downloadable envelope JSON.
//   3. UI Load: clicking the Load button + supplying a saved envelope file
//      restores the patch.
//
// Format spec: phase-1-mvp.md lines 344-377 (PatchEnvelope: envelopeVersion=1,
// savedAt, moduleSchemas, base64 Y.encodeStateAsUpdate).

import { test, expect } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

interface PatchEnvelope {
  envelopeVersion: number;
  savedAt: string;
  moduleSchemas: Record<string, number>;
  update: string;
}

test('save-load: round-trip preserves nodes, edges, params, and sequencer step data', async ({
  page,
}) => {
  await page.goto('/');
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

  // Envelope shape sanity.
  const env = result.env as PatchEnvelope;
  expect(env.envelopeVersion).toBe(1);
  expect(typeof env.savedAt).toBe('string');
  expect(env.moduleSchemas).toBeTruthy();
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

test('save-load: Save button downloads a valid PatchEnvelope JSON', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Load example' }).click();
  await expect(page.locator('.svelte-flow__node')).toHaveCount(5, { timeout: 10_000 });

  // Save now prompts for filename (default = patch.imp.json). Accepting the
  // prompt with no edit produces the same filename the prompt-less flow did.
  page.once('dialog', (dialog) => dialog.accept());
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toBe('patch.imp.json');

  const path = await download.path();
  const content = await readFile(path, 'utf8');
  const env = JSON.parse(content) as PatchEnvelope;

  expect(env.envelopeVersion).toBe(1);
  expect(typeof env.savedAt).toBe('string');
  expect(new Date(env.savedAt).getTime()).toBeGreaterThan(0); // valid ISO date
  expect(env.moduleSchemas).toBeTruthy();
  // Voice demo registers all 10 module types — schemas record at least these.
  expect(env.moduleSchemas['sequencer']).toBeGreaterThanOrEqual(1);
  expect(env.moduleSchemas['analogVco']).toBeGreaterThanOrEqual(1);
  // base64 of a non-trivial Yjs update
  expect(env.update.length).toBeGreaterThan(100);
  expect(env.update).toMatch(/^[A-Za-z0-9+/=]+$/);
});

test('save-load: Load button restores the patch from a saved envelope', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // Start with a known patch and save it.
  await page.getByRole('button', { name: 'Load example' }).click();
  await expect(page.locator('.svelte-flow__node')).toHaveCount(5, { timeout: 10_000 });

  page.once('dialog', (dialog) => dialog.accept());
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const download = await downloadPromise;
  const fixturePath = join(testInfo.outputDir, 'patch.imp.json');
  await mkdir(dirname(fixturePath), { recursive: true });
  await writeFile(fixturePath, await readFile(await download.path()));

  // Clear the patch.
  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(page.locator('.svelte-flow__node')).toHaveCount(0);

  // Click Load → handle the file picker.
  // The Load button creates a hidden <input type=file> and clicks it. Playwright
  // catches the resulting OS file dialog via the 'filechooser' event.
  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Load', exact: true }).click();
  const chooser = await fileChooserPromise;
  await chooser.setFiles(fixturePath);

  // Engine reconciles → 5 nodes + 6 edges back on the canvas.
  await expect(page.locator('.svelte-flow__node')).toHaveCount(5, { timeout: 5_000 });
  await expect(page.locator('.svelte-flow__edge')).toHaveCount(6);
});
