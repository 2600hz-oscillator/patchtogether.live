// e2e/tests/livecode.spec.ts
//
// LIVECODE module — JS-runtime coverage (v2):
//   1. Basic: spawn LIVECODE, run a script, assert nodes appear with
//      correct auto-names.
//   2. Error: a syntactically broken script surfaces a structured error
//      + leaves no spawned modules.
//   3. clocked(): invoking clocked() spawns a clockedRunner module with
//      the body + division stored on node.data.
//   4. Voice-demo recreation (graph-isomorphism): a JS script that rebuilds
//      the canonical voice demo produces the same set of nodes + edges as
//      the shared `loadVoiceDemo` fixture writes.

import { test, expect, loadVoiceDemo } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';

// ⚠ THE PER-TEST BUDGET IS A BOUND, AND IT WAS THE INVISIBLE 30 s DEFAULT.
//
// ⚠ THIS SPEC TOOK `main` RED. Run 33408552411, e2e shard 5: "livecode: JS
// recreates the voice-demo patch" failed attempt 1 with
// `page.waitForLoadState: Test timeout of 30000ms exceeded` and passed attempt 2
// at the SAME SHA — a recovered flake, which `--fail-on-flaky` reds anyway.
// This file set NO per-test budget from any source, so every test in it ran on
// the flat default while spawning a full engine plus a voice-demo graph.
//
// An inner bound at or above the budget that CONTAINS it can never come true:
// the outer clock kills the test first, so a legible `element not found` is
// converted into an illegible `Test timeout of 30000ms exceeded` — the class
// #2291 root-caused and #2293 repaired at its second call site. Nothing in this
// file said "30000"; `e2e/playwright.config.ts` never overrides Playwright's
// default, so there was nothing to grep for except the ABSENCE of a budget.
//
// The budget therefore comes from `boot-budget` (90 000 on CI/SwiftShader,
// 30 000 local) instead of the invisible default. A bound only costs wall-clock
// when it is EXCEEDED, so this adds exactly zero to a green run; lane cost stays
// gauged by `--global-timeout`, not by this.
//
// ⚠ BOUNDS ONLY. No assertion, subject or wait target changed here.
test.describe.configure({ mode: 'parallel', timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

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
  // The RUN seam's `__livecode[id]` handle is registered by whichever editor
  // surface is MOUNTED — on the default shell that is the dock face body
  // (LivecodeEditorBody), so open the pane first (idempotent).
  const pane = page.locator(`[data-testid="dock-fullview-pane"][data-pane-node="${livecodeNodeId}"]`);
  if ((await pane.count()) === 0) {
    await page.evaluate(
      (id) => (globalThis as unknown as { __openDockFullView: (id: string) => void }).__openDockFullView(id),
      livecodeNodeId,
    );
    await expect(pane).toBeVisible();
  }
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
  await page.goto('/rack?seed=none');
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

test('livecode: patch() works direction-agnostically (destination-first)', async ({ page, rack }) => {
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

test('livecode: runtime error surfaces in status + leaves rack stable', async ({ page, rack }) => {
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

test('livecode: clocked() spawns a clockedRunner with the body + division', async ({ page, rack }) => {
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

test('livecode: setData writes sequencer step array → node.data.steps', async ({ page, rack }) => {
  await spawnPatch(page, [{ id: 'lc', type: 'livecode', position: { x: 100, y: 100 } }]);

  await typeAndRun(
    page,
    'lc',
    `spawn('kria', 'seq');
setData('seq', 'steps', [
  { on: true, pitch: 60 },
  { on: false },
  { on: true, pitch: 64 },
]);`,
  );

  await page.waitForFunction(() => {
    const w = globalThis as unknown as { __patch: { nodes: Record<string, { type: string; data?: { steps?: unknown } }> } };
    const seq = Object.values(w.__patch.nodes).find((n) => n?.type === 'kria');
    return !!(seq?.data?.steps);
  }, { timeout: 5000 });

  const steps = await page.evaluate(() => {
    const w = globalThis as unknown as { __patch: { nodes: Record<string, { type: string; data?: { steps?: unknown } }> } };
    const seq = Object.values(w.__patch.nodes).find((n) => n?.type === 'kria');
    return seq?.data?.steps;
  });
  expect(Array.isArray(steps)).toBe(true);
  if (!Array.isArray(steps)) return;
  expect(steps.length).toBe(3);
  expect((steps[0] as { on?: boolean }).on).toBe(true);
  expect((steps[0] as { pitch?: number }).pitch).toBe(60);
});

test('livecode: state.set persists on owning livecode card across two runs', async ({ page, rack }) => {
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

test('livecode: editable name label — rename + reject duplicate', async ({ page, rack }) => {
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
  const labelA = page.locator('[data-testid="tile-name-label-button"]', { hasText: /^ANALOGVCO$/ });
  await expect(labelA).toBeVisible();
  await labelA.click();
  const inputA = page.locator('[data-testid="tile-name-label-input"]');
  await expect(inputA).toBeFocused();
  await inputA.fill('BASS');
  await inputA.press('Enter');

  const renamed = page.locator('[data-testid="tile-name-label-button"]', { hasText: 'BASS' });
  await expect(renamed).toBeVisible();

  const labelB = page.locator('[data-testid="tile-name-label-button"]', { hasText: 'ANALOGVCO2' });
  await labelB.click();
  const inputB = page.locator('[data-testid="tile-name-label-input"]');
  await inputB.fill('BASS');
  await inputB.press('Enter');
  const error = page.locator('[data-testid="tile-name-label-error"]');
  await expect(error).toBeVisible();
  await expect(error).toContainText(/already in use/);
  await expect(page.locator('[data-testid="tile-name-label-button"]', { hasText: 'BASS' })).toHaveCount(1);
});

test('livecode: JS recreates the voice-demo patch → graph-isomorphic', async ({ page }) => {
  await page.goto('/rack?seed=none');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'lc', type: 'livecode', position: { x: 50, y: 400 } }]);

  const js = `spawn('kria', 'seq');
spawn('analogVco', 'vco');
spawn('adsr', 'env');
spawn('vca', 'amp');
spawn('audioOut', 'out');

patch('seq.pitch1', 'vco.pitch');
patch('seq.gate1',  'env.gate');
patch('vco.sine',  'amp.audio');
patch('env.env',   'amp.cv');
patch('amp.audio', 'out.L');
patch('amp.audio', 'out.R');

set('seq', 'bpm',     180);
set('seq', 'running', 1);

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

  await page.goto('/rack?seed=none');
  await page.waitForLoadState('networkidle');
  await loadVoiceDemo(page);
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
