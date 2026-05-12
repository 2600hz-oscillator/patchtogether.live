// e2e/tests/sticky-note.spec.ts
//
// Proposal B3 — sticky notes. Meta-domain card (no engine binding); the
// reconciler skips it; persistence round-trips data.text; multi-user
// rackspaces sync text changes via Yjs.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

interface PatchNode {
  id: string;
  type: string;
  domain: string;
  position: { x: number; y: number };
  params: Record<string, number>;
  data?: Record<string, unknown>;
}

async function readNodes(page: Page): Promise<PatchNode[]> {
  return await page.evaluate(() => {
    const w = window as unknown as { __patch: { nodes: Record<string, PatchNode> } };
    return Object.values(w.__patch.nodes).filter(Boolean) as PatchNode[];
  });
}

test('sticky spawn + type into the textarea + persisted in node.data.text', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(page, [
    { id: 'st-1', type: 'sticky', position: { x: 100, y: 100 }, domain: 'meta' },
  ]);

  const card = page.locator('[data-testid="sticky-card"][data-node-id="st-1"]');
  await expect(card).toBeVisible();
  // Sticky has no handles — the reconciler skip rule + the def's empty
  // inputs / outputs guarantee this. Asserting here catches regressions.
  await expect(card.locator('.svelte-flow__handle')).toHaveCount(0);

  const textarea = card.locator('textarea[data-testid="sticky-textarea"]');
  await textarea.fill('remember to test cv splice');

  // text is persisted into node.data.text.
  await expect.poll(async () => {
    const nodes = await readNodes(page);
    return nodes.find((n) => n.id === 'st-1')?.data?.text;
  }).toBe('remember to test cv splice');
});

test('sticky save + load round-trips the text', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [
    { id: 'st-2', type: 'sticky', position: { x: 80, y: 80 }, domain: 'meta' },
  ]);

  await page
    .locator('[data-testid="sticky-card"][data-node-id="st-2"] textarea')
    .fill('round-trip me');

  // Wait for the write to land in the graph.
  await expect.poll(async () => {
    const nodes = await readNodes(page);
    return nodes.find((n) => n.id === 'st-2')?.data?.text;
  }).toBe('round-trip me');

  // Serialize → clear → load through the dev persistence hooks.
  const envelope = await page.evaluate(() => {
    const w = window as unknown as { __persistence: { save: () => unknown } };
    return w.__persistence.save();
  });

  // Clear the patch via __ydoc.transact.
  await page.evaluate(() => {
    const w = window as unknown as {
      __patch: { nodes: Record<string, unknown>; edges: Record<string, unknown> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      for (const id of Object.keys(w.__patch.edges)) delete w.__patch.edges[id];
      for (const id of Object.keys(w.__patch.nodes)) delete w.__patch.nodes[id];
    });
  });
  await expect(page.locator('.svelte-flow__node')).toHaveCount(0);

  await page.evaluate((env) => {
    const w = window as unknown as { __persistence: { load: (e: unknown) => unknown } };
    return w.__persistence.load(env);
  }, envelope);

  await expect(page.locator('[data-testid="sticky-card"][data-node-id="st-2"]')).toBeVisible();
  const reloaded = await readNodes(page);
  expect(reloaded.find((n) => n.id === 'st-2')?.data?.text).toBe('round-trip me');
});

test('sticky reconcile: no console errors when spawning a sticky-only patch', async ({ page }) => {
  // The reconciler must skip meta-domain nodes (no engine binding); a
  // sticky-only patch should never reach engine.addNode. This test boots
  // a sticky + asserts no console errors fire during the bootstrap.
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(page, [
    { id: 'st-3', type: 'sticky', position: { x: 200, y: 200 }, domain: 'meta' },
  ]);
  await expect(page.locator('[data-testid="sticky-card"]')).toBeVisible();
  // Give the microtask-scheduled reconcile a chance to fire.
  await page.waitForTimeout(150);

  expect(errors, `console errors during sticky-only bootstrap: ${errors.join('; ')}`).toEqual([]);
});

test('@collab sticky text edit in A appears in B within 4s', async ({ browser }) => {
  const rackspaceId = `sticky-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  try {
    for (const p of [pageA, pageB]) {
      await p.goto('/');
      await p.waitForLoadState('networkidle');
      await p.waitForFunction(
        () =>
          typeof (window as unknown as { __attachProvider?: unknown }).__attachProvider === 'function',
      );
    }
    await Promise.all(
      [pageA, pageB].map((p) =>
        p.evaluate(async (id) => {
          const w = window as unknown as { __attachProvider: (id: string) => Promise<unknown> };
          await w.__attachProvider(id);
        }, rackspaceId),
      ),
    );

    // A seeds a sticky.
    await pageA.evaluate(() => {
      const w = window as unknown as {
        __patch: { nodes: Record<string, unknown> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        w.__patch.nodes['st-shared'] = {
          id: 'st-shared',
          type: 'sticky',
          domain: 'meta',
          position: { x: 120, y: 120 },
          params: {},
          data: { text: '' },
        };
      });
    });

    // B sees the sticky.
    await expect
      .poll(async () => await pageB.evaluate(() => {
        const w = window as unknown as { __patch: { nodes: Record<string, { type: string }> } };
        return Object.values(w.__patch.nodes).some((n) => n && n.type === 'sticky');
      }), { timeout: 4000 })
      .toBe(true);

    // A edits the textarea.
    await pageA
      .locator('[data-testid="sticky-card"][data-node-id="st-shared"] textarea')
      .fill('hi from A');

    // B reads the same text within 4s.
    await expect
      .poll(async () => await pageB.evaluate(() => {
        const w = window as unknown as {
          __patch: { nodes: Record<string, { data?: { text?: string } }> };
        };
        return w.__patch.nodes['st-shared']?.data?.text;
      }), { timeout: 4000 })
      .toBe('hi from A');
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});
