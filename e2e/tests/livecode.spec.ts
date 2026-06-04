// e2e/tests/livecode.spec.ts
//
// LIVECODE module — JS-runtime coverage (v2):
//   1. Basic: spawn LIVECODE, run a script, assert nodes appear with
//      correct auto-names.
//   2. Error: a syntactically broken script surfaces a structured error
//      + leaves no spawned modules.
//   3. clocked(): invoking clocked() spawns a clockedRunner module with
//      the body + division stored on node.data.
//   4. Load-example recreation (graph-isomorphism): a JS script that
//      recreates the topbar's "Load example" patch produces the same
//      set of nodes + edges as clicking the button.

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
  await page.waitForFunction(
    (id) => {
      const w = globalThis as unknown as { __livecode?: Record<string, { run: (s: string) => void }> };
      return !!(w.__livecode && w.__livecode[id]);
    },
    livecodeNodeId,
    { timeout: 5000 },
  );
  await page.evaluate(
    ({ id, src }) => {
      const w = globalThis as unknown as { __livecode: Record<string, { run: (s: string) => void }> };
      w.__livecode[id]!.run(src);
    },
    { id: livecodeNodeId, src: script },
  );
}

test('livecode: spawn → run JS produces named modules with cables', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'lc', type: 'livecode', position: { x: 100, y: 100 } }]);

  await typeAndRun(
    page,
    'lc',
    `spawn('analogVco');\nspawn('audioOut');\npatch('ANALOGVCO.sine', 'AUDIOOUT.L');`,
  );

  await page.waitForFunction(() => {
    const w = globalThis as unknown as { __patch: { nodes: Record<string, unknown> } };
    return Object.keys(w.__patch.nodes).length >= 3;
  });

  const summary = await readPatchSummary(page);
  expect(summary.nodeTypes).toContain('analogVco');
  expect(summary.nodeTypes).toContain('audioOut');
  expect(summary.nodeNames).toContain('ANALOGVCO');
  expect(summary.nodeNames).toContain('AUDIOOUT');
  expect(summary.edges).toContainEqual(['analogVco', 'sine', 'audioOut', 'L']);

  expect(errors.filter((e) => !e.includes('DEP0040')), errors.join('; ')).toEqual([]);
});

test('livecode: patch() works direction-agnostically (destination-first)', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'lc', type: 'livecode', position: { x: 100, y: 100 } }]);

  // The user typed patch() with the destination first — the runtime
  // detects which side is the output and routes correctly.
  await typeAndRun(
    page,
    'lc',
    `spawn('analogVco');\nspawn('audioOut');\npatch('AUDIOOUT.L', 'ANALOGVCO.sine');`,
  );
  await page.waitForFunction(() => {
    const w = globalThis as unknown as { __patch: { edges: Record<string, unknown> } };
    return Object.keys(w.__patch.edges).length >= 1;
  });
  const summary = await readPatchSummary(page);
  // Even though the user typed audioOut first, the canonical edge
  // direction (output → input) is preserved.
  expect(summary.edges).toContainEqual(['analogVco', 'sine', 'audioOut', 'L']);
});

test('livecode: runtime error surfaces in status + leaves rack stable', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'lc', type: 'livecode', position: { x: 100, y: 100 } }]);

  const beforeNodeIds = await page.evaluate(() => {
    const w = globalThis as unknown as { __patch: { nodes: Record<string, unknown> } };
    return Object.keys(w.__patch.nodes).sort();
  });

  // Invalid JS — SyntaxError at compile.
  await typeAndRun(page, 'lc', 'this is not @ valid script ===');

  const result = await page.evaluate(() => {
    const w = globalThis as unknown as { __livecode: Record<string, { getLastResult: () => unknown }> };
    return w.__livecode['lc']!.getLastResult();
  });
  expect(result).not.toBeNull();
  expect((result as { ok: boolean }).ok).toBe(false);

  // No mutations applied → rack unchanged.
  const afterNodeIds = await page.evaluate(() => {
    const w = globalThis as unknown as { __patch: { nodes: Record<string, unknown> } };
    return Object.keys(w.__patch.nodes).sort();
  });
  expect(afterNodeIds).toEqual(beforeNodeIds);
});

test('livecode: clocked() spawns a clockedRunner with the body + division', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'lc', type: 'livecode', position: { x: 100, y: 100 } }]);

  await typeAndRun(
    page,
    'lc',
    `clocked('1/16', () => { set('TIMELORDE1', 'bpm', 130); });`,
  );

  await page.waitForFunction(() => {
    const w = globalThis as unknown as { __patch: { nodes: Record<string, { type: string }> } };
    return Object.values(w.__patch.nodes).some((n) => n?.type === 'clockedRunner');
  }, { timeout: 5000 });

  const runner = await page.evaluate(() => {
    const w = globalThis as unknown as { __patch: { nodes: Record<string, { type: string; data?: Record<string, unknown> }> } };
    return Object.values(w.__patch.nodes).find((n) => n?.type === 'clockedRunner');
  });
  expect(runner).toBeDefined();
  if (!runner) return;
  expect(runner.data?.division).toBe('1/16');
  expect(runner.data?.source).toContain("set('TIMELORDE1', 'bpm', 130)");
});

test('livecode: setData writes sequencer step array → node.data.steps', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'lc', type: 'livecode', position: { x: 100, y: 100 } }]);

  await typeAndRun(
    page,
    'lc',
    `spawn('sequencer', 'seq');
setData('seq', 'steps', [
  { on: true, pitch: 60 },
  { on: false },
  { on: true, pitch: 64 },
]);`,
  );

  await page.waitForFunction(() => {
    const w = globalThis as unknown as { __patch: { nodes: Record<string, { type: string; data?: { steps?: unknown } }> } };
    const seq = Object.values(w.__patch.nodes).find((n) => n?.type === 'sequencer');
    return !!(seq?.data?.steps);
  }, { timeout: 5000 });

  const steps = await page.evaluate(() => {
    const w = globalThis as unknown as { __patch: { nodes: Record<string, { type: string; data?: { steps?: unknown } }> } };
    const seq = Object.values(w.__patch.nodes).find((n) => n?.type === 'sequencer');
    return seq?.data?.steps;
  });
  expect(Array.isArray(steps)).toBe(true);
  if (!Array.isArray(steps)) return;
  expect(steps.length).toBe(3);
  expect((steps[0] as { on?: boolean }).on).toBe(true);
  expect((steps[0] as { pitch?: number }).pitch).toBe(60);
});

test('livecode: state.set persists on owning livecode card across two runs', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'lc', type: 'livecode', position: { x: 100, y: 100 } }]);

  // Run 1 — initialize counter to 1.
  await typeAndRun(page, 'lc', `state.set('beat', (state.get('beat') ?? 0) + 1);`);
  // Run 2 — increment to 2. Reads from the data.state we just wrote.
  await typeAndRun(page, 'lc', `state.set('beat', (state.get('beat') ?? 0) + 1);`);

  const beat = await page.evaluate(() => {
    const w = globalThis as unknown as { __patch: { nodes: Record<string, { data?: { state?: Record<string, unknown> } }> } };
    const lc = w.__patch.nodes.lc;
    return lc?.data?.state?.beat;
  });
  expect(beat).toBe(2);
});

test('livecode: editable name label — rename + reject duplicate', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [
    { id: 'a', type: 'analogVco', position: { x: 100, y: 100 } },
    { id: 'b', type: 'analogVco', position: { x: 400, y: 100 } },
  ]);

  await page.waitForFunction(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: { name?: string } }> };
    };
    const a = w.__patch.nodes.a;
    const b = w.__patch.nodes.b;
    return typeof a?.data?.name === 'string' && typeof b?.data?.name === 'string';
  });

  // hasText with a string does substring match, which would also pick up
  // 'ANALOGVCO2'. Use a regex with start+end anchors so we land on the
  // bare-prefix instance only.
  const labelA = page.locator('[data-testid="name-label-button"]', { hasText: /^ANALOGVCO$/ });
  await expect(labelA).toBeVisible();
  await labelA.click();
  const inputA = page.locator('[data-testid="name-label-input"]');
  await expect(inputA).toBeFocused();
  await inputA.fill('BASS');
  await inputA.press('Enter');

  const renamed = page.locator('[data-testid="name-label-button"]', { hasText: 'BASS' });
  await expect(renamed).toBeVisible();

  const labelB = page.locator('[data-testid="name-label-button"]', { hasText: 'ANALOGVCO2' });
  await labelB.click();
  const inputB = page.locator('[data-testid="name-label-input"]');
  await inputB.fill('BASS');
  await inputB.press('Enter');
  const error = page.locator('[data-testid="name-label-error"]');
  await expect(error).toBeVisible();
  await expect(error).toContainText(/already in use/);
  await expect(page.locator('[data-testid="name-label-button"]', { hasText: 'BASS' })).toHaveCount(1);
});

test('livecode: JS recreates "Load example" patch → graph-isomorphic', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'lc', type: 'livecode', position: { x: 50, y: 400 } }]);

  const js = `spawn('sequencer', 'seq');
spawn('analogVco', 'vco');
spawn('adsr', 'env');
spawn('vca', 'amp');
spawn('audioOut', 'out');

patch('seq.pitch', 'vco.pitch');
patch('seq.gate',  'env.gate');
patch('vco.sine',  'amp.audio');
patch('env.env',   'amp.cv');
patch('amp.audio', 'out.L');
patch('amp.audio', 'out.R');

set('seq', 'bpm',        180);
set('seq', 'length',     8);
set('seq', 'isPlaying',  1);
set('seq', 'gateLength', 0.4);

set('env', 'attack',  0.005);
set('env', 'decay',   0.08);
set('env', 'sustain', 0.3);
set('env', 'release', 0.15);

set('amp', 'base',     0);
set('amp', 'cvAmount', 1);

set('out', 'master',   0.4);`;

  await typeAndRun(page, 'lc', js);
  await page.waitForFunction(() => {
    const w = globalThis as unknown as { __patch: { nodes: Record<string, unknown> } };
    return Object.keys(w.__patch.nodes).length >= 6; // 5 + livecode
  });

  const dslSummary = await readPatchSummary(page);

  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.getByTestId('load-example-select').selectOption('sequenced-vco');
  await page.waitForFunction(() => {
    const w = globalThis as unknown as { __patch: { nodes: Record<string, unknown> } };
    return Object.keys(w.__patch.nodes).length >= 5;
  });
  const exampleSummary = await readPatchSummary(page);

  const dslTypes = dslSummary.nodeTypes.filter((t) => t !== 'livecode').sort();
  const exampleTypes = exampleSummary.nodeTypes.slice().sort();
  expect(dslTypes).toEqual(exampleTypes);
  expect(dslSummary.edges).toEqual(exampleSummary.edges);
});
