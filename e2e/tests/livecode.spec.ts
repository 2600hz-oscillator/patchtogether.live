// e2e/tests/livecode.spec.ts
//
// LIVECODE module — text-DSL coverage:
//   1. Basic: spawn LIVECODE, type a script, hit Run, assert nodes appear
//      with correct auto-names.
//   2. Error: type a syntactically broken script, hit Run, assert the
//      error band shows + no nodes were spawned (transactionality).
//   3. Editable name label: rename a spawned module via the click-to-edit
//      label; verify uniqueness rejection.
//   4. Load-example recreation (graph-isomorphism check): a DSL script
//      that recreates the topbar's "Load example" patch produces the
//      same set of nodes + edges (modulo ids).

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

async function readPatchSummary(
  page: Page,
): Promise<{ nodeTypes: string[]; nodeNames: string[]; edges: Array<[string, string, string, string]> }> {
  return await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: {
        nodes: Record<string, { type: string; data?: { name?: string } }>;
        edges: Record<string, { source: { nodeId: string; portId: string }; target: { nodeId: string; portId: string } }>;
      };
    };
    const nodeTypes: string[] = [];
    const nodeNames: string[] = [];
    for (const n of Object.values(w.__patch.nodes)) {
      if (!n) continue;
      nodeTypes.push(n.type);
      const nm = n.data?.name;
      if (typeof nm === 'string') nodeNames.push(nm);
    }
    const edges: Array<[string, string, string, string]> = [];
    for (const e of Object.values(w.__patch.edges)) {
      if (!e) continue;
      const sn = w.__patch.nodes[e.source.nodeId];
      const tn = w.__patch.nodes[e.target.nodeId];
      if (!sn || !tn) continue;
      edges.push([sn.type, e.source.portId, tn.type, e.target.portId]);
    }
    nodeTypes.sort();
    nodeNames.sort();
    edges.sort((a, b) => a.join('|').localeCompare(b.join('|')));
    return { nodeTypes, nodeNames, edges };
  });
}

async function typeAndRun(page: Page, livecodeNodeId: string, script: string): Promise<void> {
  const card = page.locator(`.svelte-flow__node[data-id="${livecodeNodeId}"]`);
  const editor = card.locator('[data-testid="livecode-editor"]');
  await editor.click();
  // Clear any existing text first.
  await editor.fill('');
  await editor.fill(script);
  // Verify the text actually landed in the textarea before clicking Run.
  await expect(editor).toHaveValue(script);
  // Click Run. Force is intentional: xyflow's drag listener can briefly
  // intercept pointer events near the card edge during a node-stack
  // re-layout; the button has class `nodrag` but force bypasses
  // Playwright's actionability checks for resilience.
  await card.locator('[data-testid="livecode-run"]').click({ force: true });
}

test('livecode: spawn → type → run produces named modules', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'lc', type: 'livecode', position: { x: 100, y: 100 } }]);

  await typeAndRun(
    page,
    'lc',
    `vco = analogVco.new()
out = audioOut.new()
vco.sine -> out.L`,
  );

  // Allow a tick for the transact to flush + reconciler to materialize.
  await page.waitForFunction(() => {
    const w = globalThis as unknown as { __patch: { nodes: Record<string, unknown> } };
    return Object.keys(w.__patch.nodes).length >= 3;
  });

  const summary = await readPatchSummary(page);
  expect(summary.nodeTypes).toContain('analogVco');
  expect(summary.nodeTypes).toContain('audioOut');
  expect(summary.nodeNames).toContain('LIVECODE1');
  expect(summary.nodeNames).toContain('ANALOGVCO1');
  expect(summary.nodeNames).toContain('AUDIOOUT1');
  // The edge should target audioOut.L from analogVco.sine.
  expect(summary.edges).toContainEqual(['analogVco', 'sine', 'audioOut', 'L']);

  // No console errors during a happy path run.
  expect(errors.filter((e) => !e.includes('DEP0040')), errors.join('; ')).toEqual([]);
});

test('livecode: parse error shows in status + applies no mutations', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'lc', type: 'livecode', position: { x: 100, y: 100 } }]);

  // Snapshot the patch state pre-run.
  const beforeNodeIds = await page.evaluate(() => {
    const w = globalThis as unknown as { __patch: { nodes: Record<string, unknown> } };
    return Object.keys(w.__patch.nodes).sort();
  });

  await typeAndRun(page, 'lc', 'this is not @ valid script ===');

  // Status should be in error state.
  const status = page.locator('[data-testid="livecode-status"]');
  await expect(status).toHaveClass(/err/);

  // Patch state should be unchanged (no spawned modules).
  const afterNodeIds = await page.evaluate(() => {
    const w = globalThis as unknown as { __patch: { nodes: Record<string, unknown> } };
    return Object.keys(w.__patch.nodes).sort();
  });
  expect(afterNodeIds).toEqual(beforeNodeIds);
});

test('livecode: editable name label — rename + reject duplicate', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [
    { id: 'a', type: 'analogVco', position: { x: 100, y: 100 } },
    { id: 'b', type: 'analogVco', position: { x: 400, y: 100 } },
  ]);

  // Wait for the migration to assign ANALOGVCO1 + ANALOGVCO2.
  await page.waitForFunction(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: { name?: string } }> };
    };
    const a = w.__patch.nodes.a;
    const b = w.__patch.nodes.b;
    return typeof a?.data?.name === 'string' && typeof b?.data?.name === 'string';
  });

  // The name label is rendered in a NodeToolbar above each card. Use the
  // global locator since the NodeToolbar mounts as a portal sibling of
  // the card. Two ANALOGVCO buttons exist; we select by current text
  // content via the dialog.
  const labelA = page.locator('[data-testid="name-label-button"]', { hasText: 'ANALOGVCO1' });
  await expect(labelA).toBeVisible();
  await labelA.click();
  const inputA = page.locator('[data-testid="name-label-input"]');
  await expect(inputA).toBeFocused();
  await inputA.fill('BASS');
  await inputA.press('Enter');

  // The label now reads BASS, and the patch graph reflects it.
  const renamed = page.locator('[data-testid="name-label-button"]', { hasText: 'BASS' });
  await expect(renamed).toBeVisible();

  // Try to rename ANALOGVCO2 → BASS (collision). Inline error shows.
  const labelB = page.locator('[data-testid="name-label-button"]', { hasText: 'ANALOGVCO2' });
  await labelB.click();
  const inputB = page.locator('[data-testid="name-label-input"]');
  await inputB.fill('BASS');
  await inputB.press('Enter');
  // Error appears, input still focused.
  const error = page.locator('[data-testid="name-label-error"]');
  await expect(error).toBeVisible();
  await expect(error).toContainText(/already in use/);
  // The label hasn't committed.
  await expect(page.locator('[data-testid="name-label-button"]', { hasText: 'BASS' })).toHaveCount(1);
});

test('livecode: "Load example" recreated in DSL → graph-isomorphic to topbar button', async ({ page }) => {
  // First load the example via the DSL.
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'lc', type: 'livecode', position: { x: 50, y: 400 } }]);

  const dsl = `seq = sequencer.new()
vco = analogVco.new()
env = adsr.new()
amp = vca.new()
out = audioOut.new()

seq.pitch -> vco.pitch
seq.gate -> env.gate
vco.sine -> amp.audio
env.env -> amp.cv
amp.audio -> out.L
amp.audio -> out.R

seq.bpm = 180
seq.length = 8
seq.isPlaying = 1
seq.gateLength = 0.4

env.attack = 0.005
env.decay = 0.08
env.sustain = 0.3
env.release = 0.15

amp.base = 0
amp.cvAmount = 1

out.master = 0.4`;

  await typeAndRun(page, 'lc', dsl);
  await page.waitForFunction(() => {
    const w = globalThis as unknown as { __patch: { nodes: Record<string, unknown> } };
    return Object.keys(w.__patch.nodes).length >= 6; // 5 + livecode
  });

  const dslSummary = await readPatchSummary(page);

  // Now reset and run the topbar Load-example button on a fresh page.
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  // Click "Load example".
  await page.getByRole('button', { name: /load example/i }).click();
  await page.waitForFunction(() => {
    const w = globalThis as unknown as { __patch: { nodes: Record<string, unknown> } };
    return Object.keys(w.__patch.nodes).length >= 5;
  });
  const exampleSummary = await readPatchSummary(page);

  // Assert the same set of node TYPES (modulo livecode in the dsl side).
  const dslTypes = dslSummary.nodeTypes.filter((t) => t !== 'livecode').sort();
  const exampleTypes = exampleSummary.nodeTypes.slice().sort();
  expect(dslTypes).toEqual(exampleTypes);

  // Assert the same set of (sourceType, sourcePort, targetType, targetPort) edges.
  expect(dslSummary.edges).toEqual(exampleSummary.edges);
});
