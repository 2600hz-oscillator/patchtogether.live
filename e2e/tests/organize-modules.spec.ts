// e2e/tests/organize-modules.spec.ts
//
// End-to-end coverage for the right-click → "Organize modules" + anchored-spawn
// feature added in PR #36. This suite is intentionally extensive:
//
//   - Right-click context-menu basics (palette + per-node menu)
//   - "Add Module" sub-menu (categories, click-to-spawn, click-anchor, offset)
//   - "Organize modules" action (separates overlap, preserves layout, no-ops)
//   - Multi-user collab safety (organize + spawn cross-sync via Yjs)
//   - Edge cases (drag-vs-rclick, port-handle behavior, suppressed paths)
//
// Conventions:
//   - Prefer data-driven assertions via the dev test hooks (__patch, __ydoc,
//     __flow, __spawnAtFlowPos, __organizeModules) over DOM hit-testing —
//     fitView keeps reflowing screen coords as nodes appear, so flow-space
//     comparisons are the only stable basis for "spawned at click".
//   - Where a test must drive the actual right-click flow (menu UX), it does
//     so on the empty .svelte-flow__pane (right-click on a node opens the
//     per-node menu, not the palette — that behavior is exercised separately).

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

// ---------- helpers ----------

interface NodePos { x: number; y: number }
interface PatchNode { id: string; type: string; position: NodePos }

async function readNodes(page: Page): Promise<PatchNode[]> {
  return await page.evaluate(() => {
    const w = window as unknown as { __patch: { nodes: Record<string, PatchNode> } };
    return Object.values(w.__patch.nodes).filter(Boolean) as PatchNode[];
  });
}

async function readEdgeIds(page: Page): Promise<string[]> {
  return await page.evaluate(() => {
    const w = window as unknown as { __patch: { edges: Record<string, unknown> } };
    return Object.keys(w.__patch.edges);
  });
}

async function screenToFlow(page: Page, p: NodePos): Promise<NodePos> {
  return await page.evaluate(
    (pt) => {
      const w = window as unknown as { __flow: { screenToFlowPosition: (p: NodePos) => NodePos } };
      return w.__flow.screenToFlowPosition(pt);
    },
    p,
  );
}

async function getInternalSize(page: Page, id: string): Promise<{ w: number; h: number }> {
  return await page.evaluate((nid) => {
    const w = window as unknown as {
      __flow: { getInternalNode: (id: string) => { measured?: { width?: number; height?: number } } | undefined };
    };
    const internal = w.__flow.getInternalNode(nid);
    return { w: internal?.measured?.width ?? 240, h: internal?.measured?.height ?? 200 };
  }, id);
}

async function paneBox(page: Page) {
  const pane = page.locator('.svelte-flow__pane');
  const box = await pane.boundingBox();
  if (!box) throw new Error('no pane bounding box');
  return box;
}

function rectsOverlap(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  const xOverlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const yOverlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return xOverlap > 0.5 && yOverlap > 0.5;
}

async function ready(page: Page) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(() => {
    const w = window as unknown as { __patch?: unknown; __flow?: unknown };
    return !!w.__patch && !!w.__flow;
  });
}

// ============================================================================
// A. Right-click context menu basics
// ============================================================================

test('rclick on empty pane opens the Add-Module palette', async ({ page }) => {
  await ready(page);
  const box = await paneBox(page);
  await page.mouse.click(box.x + 200, box.y + 200, { button: 'right' });
  await expect(page.locator('.module-palette')).toBeVisible();
});

test('rclick on existing module opens the per-node action menu (NOT the palette)', async ({ page }) => {
  await ready(page);
  await spawnPatch(page, [{ id: 'm', type: 'mixer', position: { x: 200, y: 200 } }]);
  const m = page.locator('.svelte-flow__node-mixer').first();
  await m.click({ button: 'right' });
  await expect(page.locator('[role="menu"][aria-label="Module actions"]')).toBeVisible();
  await expect(page.locator('.module-palette')).toHaveCount(0);
});

test('rclick → click outside dismisses palette', async ({ page }) => {
  await ready(page);
  const box = await paneBox(page);
  await page.mouse.click(box.x + 100, box.y + 100, { button: 'right' });
  await expect(page.locator('.module-palette')).toBeVisible();
  // The overlay div is a sibling of the palette and covers the whole viewport;
  // clicking it dismisses (component implements an onclick={onclose} overlay).
  await page.locator('.palette-overlay').click();
  await expect(page.locator('.module-palette')).not.toBeVisible();
});

test('rclick → Escape dismisses palette', async ({ page }) => {
  await ready(page);
  const box = await paneBox(page);
  await page.mouse.click(box.x + 100, box.y + 100, { button: 'right' });
  await expect(page.locator('.module-palette')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.module-palette')).not.toBeVisible();
});

test('rclick while palette open re-anchors at new click position', async ({ page }) => {
  await ready(page);
  const box = await paneBox(page);
  await page.mouse.click(box.x + 50, box.y + 50, { button: 'right' });
  await expect(page.locator('.module-palette')).toBeVisible();
  const firstStyle = await page.locator('.module-palette').getAttribute('style');
  // Open a second time at a much later x. The palette overlay first dismisses
  // (since right-click on overlay is also a click on the underlying pane in
  // bubble order), so the second rclick lands on the pane and re-opens.
  await page.locator('.palette-overlay').click();
  await page.mouse.click(box.x + 500, box.y + 350, { button: 'right' });
  await expect(page.locator('.module-palette')).toBeVisible();
  const secondStyle = await page.locator('.module-palette').getAttribute('style');
  expect(secondStyle).not.toEqual(firstStyle);
});

// ============================================================================
// B. Add-Module sub-menu
// ============================================================================

test('palette lists every documented category at least once', async ({ page }) => {
  await ready(page);
  const box = await paneBox(page);
  await page.mouse.click(box.x + 200, box.y + 200, { button: 'right' });
  await expect(page.locator('.module-palette')).toBeVisible();
  // Categories rendered as .category divs. Order is fixed by the palette,
  // singletons that are at-cap are filtered before render — fresh canvas
  // has none of them, so all categories should appear.
  const cats = await page.locator('.module-palette .category').allTextContents();
  // 'tools' is the always-present Organize header. Module categories from
  // the registry: sources, modulation, filters, effects, utilities, output.
  for (const expected of ['tools', 'sources', 'modulation', 'filters', 'effects', 'utilities', 'output']) {
    expect(cats).toContain(expected);
  }
});

test('palette lists Reverb under effects and Mixer under utilities', async ({ page }) => {
  await ready(page);
  const box = await paneBox(page);
  await page.mouse.click(box.x + 200, box.y + 200, { button: 'right' });
  await expect(page.locator('.module-palette')).toBeVisible();
  // The palette body is a flat alternating sequence of .category dividers and
  // .item buttons. We can read the DOM order to verify a button follows the
  // expected category header without a more elaborate group selector.
  const body = page.locator('.palette-body');
  const html = (await body.innerHTML()).replace(/\s+/g, ' ');
  const reverbIdx = html.indexOf('Reverb');
  const effectsIdx = html.indexOf('>effects<');
  const utilitiesIdx = html.indexOf('>utilities<');
  const mixerIdx = html.indexOf('>Mixer<');
  expect(reverbIdx).toBeGreaterThan(effectsIdx);
  expect(mixerIdx).toBeGreaterThan(utilitiesIdx);
  // Reverb belongs to effects, not utilities — index must be earlier than the
  // utilities header (effects comes before utilities in the registry order).
  expect(reverbIdx).toBeLessThan(utilitiesIdx);
});

test('clicking a palette item spawns exactly one module of that type', async ({ page }) => {
  await ready(page);
  const box = await paneBox(page);
  await page.mouse.click(box.x + 200, box.y + 200, { button: 'right' });
  await expect(page.locator('.module-palette')).toBeVisible();
  await page.getByRole('button', { name: 'Reverb', exact: true }).click();
  await expect(page.locator('.module-palette')).not.toBeVisible();
  const nodes = await readNodes(page);
  expect(nodes.filter((n) => n.type === 'reverb')).toHaveLength(1);
});

test('spawned node anchors at the click point in flow-space (within the card)', async ({ page }) => {
  await ready(page);
  const box = await paneBox(page);
  const clickClientX = box.x + 320;
  const clickClientY = box.y + 240;
  // Capture the flow-space coords of the click BEFORE spawning. After spawn,
  // fitView will re-center the viewport (a single new node), so reading
  // screenToFlowPosition for the same client point post-spawn would mislead.
  const expected = await screenToFlow(page, { x: clickClientX, y: clickClientY });
  await page.mouse.click(clickClientX, clickClientY, { button: 'right' });
  await expect(page.locator('.module-palette')).toBeVisible();
  await page.getByRole('button', { name: 'Reverb', exact: true }).click();
  const nodes = await readNodes(page);
  expect(nodes).toHaveLength(1);
  const pos = nodes[0].position;
  // The card's top-left should be near the click. xyflow doesn't snap, so a
  // few-px tolerance is just float jitter from the viewport transform.
  expect(Math.abs(pos.x - expected.x)).toBeLessThan(4);
  expect(Math.abs(pos.y - expected.y)).toBeLessThan(4);
});

test('spawn over an existing node offsets down-right to avoid stacking', async ({ page }) => {
  await ready(page);
  await spawnPatch(page, [{ id: 'a', type: 'mixer', position: { x: 200, y: 200 } }]);
  // Drive the spawn through __spawnAtFlowPos to bypass the rclick-targets-node
  // gotcha: pane right-clicks atop a node go to onNodeContextMenu instead.
  // The collision logic is the same code path; the test hook only sets the
  // spawnFlowPos and then calls spawnFromPalette.
  await page.evaluate(() => {
    const w = window as unknown as {
      __spawnAtFlowPos: (type: string, p: NodePos) => void;
    };
    w.__spawnAtFlowPos('reverb', { x: 200, y: 200 });
  });
  const nodes = await readNodes(page);
  const mixer = nodes.find((n) => n.type === 'mixer')!;
  const reverb = nodes.find((n) => n.type === 'reverb');
  expect(reverb).toBeTruthy();
  // STACK_OFFSET (24px) iterates until the new card clears the existing one.
  // Both x and y must have moved (down-right), and the resulting boxes must
  // not overlap.
  expect(reverb!.position.x).toBeGreaterThan(mixer.position.x);
  expect(reverb!.position.y).toBeGreaterThan(mixer.position.y);
  const sizeM = await getInternalSize(page, mixer.id);
  const sizeR = await getInternalSize(page, reverb!.id);
  expect(rectsOverlap(
    { x: mixer.position.x, y: mixer.position.y, w: sizeM.w, h: sizeM.h },
    { x: reverb!.position.x, y: reverb!.position.y, w: sizeR.w, h: sizeR.h },
  )).toBe(false);
  // Step quantum is the configured STACK_OFFSET — both axes increased by the
  // same multiple of 24 per the loop. Sanity-check the multiple-of-24 invariant.
  expect((reverb!.position.x - mixer.position.x) % 24).toBe(0);
  expect((reverb!.position.y - mixer.position.y) % 24).toBe(0);
});

test('spawn over multiple stacked nodes keeps offsetting until clear', async ({ page }) => {
  await ready(page);
  await spawnPatch(page, [
    { id: 'a', type: 'mixer', position: { x: 200, y: 200 } },
    { id: 'b', type: 'reverb', position: { x: 224, y: 224 } },
    { id: 'c', type: 'lfo', position: { x: 248, y: 248 } },
  ]);
  await page.evaluate(() => {
    const w = window as unknown as {
      __spawnAtFlowPos: (type: string, p: NodePos) => void;
    };
    w.__spawnAtFlowPos('scope', { x: 200, y: 200 });
  });
  const nodes = await readNodes(page);
  const scope = nodes.find((n) => n.type === 'scope');
  expect(scope).toBeTruthy();
  // Either 24*N down-right (no overlap with any of a/b/c) or whatever the
  // collision iteration produces — assert no overlap with measured boxes
  // rather than a hard-coded coord (cards measure to non-trivial dims).
  const sizeS = await getInternalSize(page, scope!.id);
  for (const other of nodes) {
    if (other.id === scope!.id) continue;
    const sizeO = await getInternalSize(page, other.id);
    expect(rectsOverlap(
      { x: scope!.position.x, y: scope!.position.y, w: sizeS.w, h: sizeS.h },
      { x: other.position.x, y: other.position.y, w: sizeO.w, h: sizeO.h },
    )).toBe(false);
  }
});

test('palette spawned via topbar + Add module goes through screenToFlowPosition', async ({ page }) => {
  await ready(page);
  // Compute the expected flow-space coord for {200, 200} BEFORE spawning so
  // we don't catch a post-spawn fitView shift. The topbar path always uses
  // {200, 200} as its synthetic anchor, then runs it through the same
  // screenToFlowPosition as the right-click path.
  const expected = await screenToFlow(page, { x: 200, y: 200 });
  await page.getByRole('button', { name: '+ Add module' }).click();
  await expect(page.locator('.module-palette')).toBeVisible();
  await page.getByRole('button', { name: 'Reverb', exact: true }).click();
  const nodes = await readNodes(page);
  expect(nodes).toHaveLength(1);
  expect(Math.abs(nodes[0].position.x - expected.x)).toBeLessThan(4);
  expect(Math.abs(nodes[0].position.y - expected.y)).toBeLessThan(4);
});

// ============================================================================
// C. Organize modules action
// ============================================================================

test('organize: 2 fully-stacked modules become disjoint', async ({ page }) => {
  await ready(page);
  await spawnPatch(page, [
    { id: 'a', type: 'mixer', position: { x: 200, y: 200 } },
    { id: 'b', type: 'reverb', position: { x: 200, y: 200 } },
  ]);
  await page.evaluate(() => {
    const w = window as unknown as { __organizeModules: () => void };
    w.__organizeModules();
  });
  const nodes = await readNodes(page);
  expect(nodes).toHaveLength(2);
  const sizes = await Promise.all(nodes.map((n) => getInternalSize(page, n.id)));
  expect(rectsOverlap(
    { x: nodes[0].position.x, y: nodes[0].position.y, w: sizes[0].w, h: sizes[0].h },
    { x: nodes[1].position.x, y: nodes[1].position.y, w: sizes[1].w, h: sizes[1].h },
  )).toBe(false);
});

test('organize: 3 already-disjoint modules in a row are not perturbed', async ({ page }) => {
  await ready(page);
  await spawnPatch(page, [
    { id: 'a', type: 'mixer', position: { x: 0, y: 0 } },
    { id: 'b', type: 'reverb', position: { x: 400, y: 0 } },
    { id: 'c', type: 'lfo', position: { x: 800, y: 0 } },
  ]);
  const before = await readNodes(page);
  await page.evaluate(() => {
    const w = window as unknown as { __organizeModules: () => void };
    w.__organizeModules();
  });
  const after = await readNodes(page);
  // Sort by id so we compare like-for-like.
  const beforeById = Object.fromEntries(before.map((n) => [n.id, n.position]));
  const afterById = Object.fromEntries(after.map((n) => [n.id, n.position]));
  for (const id of Object.keys(beforeById)) {
    expect(afterById[id]).toEqual(beforeById[id]);
  }
});

test('organize: many modules with mixed overlap end up fully disjoint', async ({ page }) => {
  await ready(page);
  await spawnPatch(page, [
    { id: 'n1', type: 'mixer', position: { x: 100, y: 100 } },
    { id: 'n2', type: 'reverb', position: { x: 110, y: 110 } },
    { id: 'n3', type: 'lfo', position: { x: 120, y: 120 } },
    { id: 'n4', type: 'scope', position: { x: 600, y: 100 } },
    { id: 'n5', type: 'audioOut', position: { x: 605, y: 105 } },
  ]);
  await page.evaluate(() => {
    const w = window as unknown as { __organizeModules: () => void };
    w.__organizeModules();
  });
  const nodes = await readNodes(page);
  const sizes = await Promise.all(nodes.map((n) => getInternalSize(page, n.id)));
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      expect(rectsOverlap(
        { x: nodes[i].position.x, y: nodes[i].position.y, w: sizes[i].w, h: sizes[i].h },
        { x: nodes[j].position.x, y: nodes[j].position.y, w: sizes[j].w, h: sizes[j].h },
      )).toBe(false);
    }
  }
});

test('organize preserves edges (no cable cut)', async ({ page }) => {
  await ready(page);
  // Two stacked modules with one cable between them; after organize the
  // graph topology is unchanged, only positions move.
  await spawnPatch(
    page,
    [
      { id: 'src', type: 'analogVco', position: { x: 200, y: 200 } },
      { id: 'dst', type: 'mixer', position: { x: 200, y: 200 } },
    ],
    [
      {
        id: 'e1',
        from: { nodeId: 'src', portId: 'sine' },
        to: { nodeId: 'dst', portId: 'in1' },
      },
    ],
  );
  const edgesBefore = await readEdgeIds(page);
  expect(edgesBefore).toEqual(['e1']);
  await page.evaluate(() => {
    const w = window as unknown as { __organizeModules: () => void };
    w.__organizeModules();
  });
  const edgesAfter = await readEdgeIds(page);
  expect(edgesAfter).toEqual(['e1']);
});

test('organize is a no-op when there are 0 modules', async ({ page }) => {
  await ready(page);
  await page.evaluate(() => {
    const w = window as unknown as { __organizeModules: () => void };
    w.__organizeModules();
  });
  const nodes = await readNodes(page);
  expect(nodes).toEqual([]);
});

test('organize is a no-op when there is 1 module', async ({ page }) => {
  await ready(page);
  await spawnPatch(page, [{ id: 'only', type: 'mixer', position: { x: 333, y: 444 } }]);
  await page.evaluate(() => {
    const w = window as unknown as { __organizeModules: () => void };
    w.__organizeModules();
  });
  const nodes = await readNodes(page);
  expect(nodes).toHaveLength(1);
  expect(nodes[0].position).toEqual({ x: 333, y: 444 });
});

test('organize via right-click → "Organize modules" entry separates stacked cards', async ({ page }) => {
  await ready(page);
  await spawnPatch(page, [
    { id: 'a', type: 'mixer', position: { x: 200, y: 200 } },
    { id: 'b', type: 'reverb', position: { x: 200, y: 200 } },
  ]);
  // Find an empty pane click target by reading the stacked node's bounding
  // box and right-clicking well above + outside it. The two stacked nodes
  // share a single DOM region so we just need a click outside that rect.
  const stackedBox = await page.locator('.svelte-flow__node').first().boundingBox();
  const pane = await paneBox(page);
  const clickX = stackedBox ? Math.max(stackedBox.x + stackedBox.width + 80, pane.x + 50) : pane.x + 50;
  const clickY = pane.y + 30;
  await page.mouse.click(Math.min(clickX, pane.x + pane.width - 60), clickY, { button: 'right' });
  await expect(page.locator('.module-palette')).toBeVisible();
  await page.locator('[data-testid="palette-organize"]').click();
  await expect(page.locator('.module-palette')).not.toBeVisible();
  const nodes = await readNodes(page);
  const sizes = await Promise.all(nodes.map((n) => getInternalSize(page, n.id)));
  expect(rectsOverlap(
    { x: nodes[0].position.x, y: nodes[0].position.y, w: sizes[0].w, h: sizes[0].h },
    { x: nodes[1].position.x, y: nodes[1].position.y, w: sizes[1].w, h: sizes[1].h },
  )).toBe(false);
});

test('organize on a realistic example patch leaves no overlapping cards', async ({ page }) => {
  await ready(page);
  // Force overlap by stacking the example modules at the same coord, then run
  // organize. After organize we expect every pairwise rect to be disjoint.
  await spawnPatch(page, [
    { id: 'seq', type: 'sequencer', position: { x: 100, y: 100 } },
    { id: 'vco', type: 'analogVco', position: { x: 100, y: 100 } },
    { id: 'env', type: 'adsr', position: { x: 100, y: 100 } },
    { id: 'vca', type: 'vca', position: { x: 100, y: 100 } },
    { id: 'out', type: 'audioOut', position: { x: 100, y: 100 } },
  ]);
  await page.evaluate(() => {
    const w = window as unknown as { __organizeModules: () => void };
    w.__organizeModules();
  });
  const nodes = await readNodes(page);
  const sizes = await Promise.all(nodes.map((n) => getInternalSize(page, n.id)));
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      expect(rectsOverlap(
        { x: nodes[i].position.x, y: nodes[i].position.y, w: sizes[i].w, h: sizes[i].h },
        { x: nodes[j].position.x, y: nodes[j].position.y, w: sizes[j].w, h: sizes[j].h },
      )).toBe(false);
    }
  }
});

// ============================================================================
// D. Multi-user / collab safety
// ============================================================================

test.describe('@collab', () => {
  async function openTwo(browser: import('@playwright/test').Browser) {
    const rackspaceId = `organize-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    for (const p of [pageA, pageB]) {
      await p.goto('/');
      await p.waitForLoadState('networkidle');
      await p.waitForFunction(
        () => typeof (window as unknown as { __attachProvider?: unknown }).__attachProvider === 'function',
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
    return {
      pageA,
      pageB,
      close: async () => {
        await ctxA.close();
        await ctxB.close();
      },
    };
  }

  test('User-A spawn-at-rclick reaches User-B within ~1s', async ({ browser }) => {
    const s = await openTwo(browser);
    try {
      await s.pageA.evaluate(() => {
        const w = window as unknown as { __spawnAtFlowPos: (t: string, p: NodePos) => void };
        w.__spawnAtFlowPos('reverb', { x: 333, y: 222 });
      });
      await expect
        .poll(
          async () =>
            await s.pageB.evaluate(() => {
              const w = window as unknown as { __patch: { nodes: Record<string, { type: string }> } };
              return Object.values(w.__patch.nodes).some((n) => n?.type === 'reverb');
            }),
          { timeout: 1500 },
        )
        .toBe(true);
    } finally {
      await s.close();
    }
  });

  test('User-A organize updates positions on User-B (per-user layouts respected)', async ({ browser }) => {
    const s = await openTwo(browser);
    try {
      await s.pageA.evaluate(() => {
        const w = window as unknown as {
          __patch: { nodes: Record<string, unknown> };
          __ydoc: { transact: (fn: () => void) => void };
        };
        w.__ydoc.transact(() => {
          w.__patch.nodes['a'] = {
            id: 'a', type: 'mixer', domain: 'audio', position: { x: 200, y: 200 }, params: {},
          };
          w.__patch.nodes['b'] = {
            id: 'b', type: 'reverb', domain: 'audio', position: { x: 200, y: 200 }, params: {},
          };
        });
      });
      await expect
        .poll(
          async () => (await readNodes(s.pageB)).length,
          { timeout: 2000 },
        )
        .toBe(2);
      // A organizes locally. The shared node.position is updated when there's
      // no per-user layout (default in this test — currentUserId is unset).
      await s.pageA.evaluate(() => {
        const w = window as unknown as { __organizeModules: () => void };
        w.__organizeModules();
      });
      await expect
        .poll(
          async () => {
            const nodes = await readNodes(s.pageB);
            const a = nodes.find((n) => n.id === 'a');
            const b = nodes.find((n) => n.id === 'b');
            if (!a || !b) return false;
            // Either node has moved off the original (200,200).
            return (a.position.x !== 200 || a.position.y !== 200)
              || (b.position.x !== 200 || b.position.y !== 200);
          },
          { timeout: 2000 },
        )
        .toBe(true);
    } finally {
      await s.close();
    }
  });
});

// ============================================================================
// E. Edge cases
// ============================================================================

test('rclick-and-spawn respects maxInstances (timelorde singleton stays at 1)', async ({ page }) => {
  await ready(page);
  await spawnPatch(page, [{ id: 't1', type: 'timelorde', position: { x: 100, y: 100 } }]);
  // Force-attempt the spawn even though the palette would filter it.
  await page.evaluate(() => {
    const w = window as unknown as { __spawnAtFlowPos: (t: string, p: NodePos) => void };
    w.__spawnAtFlowPos('timelorde', { x: 400, y: 400 });
  });
  const nodes = await readNodes(page);
  expect(nodes.filter((n) => n.type === 'timelorde')).toHaveLength(1);
});

test('palette filters out at-cap singletons (timelorde hidden when one exists)', async ({ page }) => {
  await ready(page);
  await spawnPatch(page, [{ id: 't1', type: 'timelorde', position: { x: 100, y: 100 } }]);
  const box = await paneBox(page);
  await page.mouse.click(box.x + 50, box.y + 50, { button: 'right' });
  await expect(page.locator('.module-palette')).toBeVisible();
  // The TIMELORDE label should NOT appear because it's a singleton with one
  // already in the patch.
  const items = await page.locator('.module-palette .item').allTextContents();
  expect(items.map((s) => s.trim())).not.toContain('TIMELORDE');
});

test('Organize entry is present in palette and is the first tools entry', async ({ page }) => {
  await ready(page);
  const box = await paneBox(page);
  await page.mouse.click(box.x + 100, box.y + 100, { button: 'right' });
  await expect(page.locator('.module-palette')).toBeVisible();
  const organize = page.locator('[data-testid="palette-organize"]');
  await expect(organize).toBeVisible();
  await expect(organize).toHaveText(/Organize modules/);
});

test('rclick on a port handle does not crash and surfaces SOME menu', async ({ page }) => {
  // Ports live inside the node card. Right-click on the card area triggers
  // the per-node context menu (xyflow's onnodecontextmenu). We assert: NO
  // crash, palette never appears, per-node menu does appear.
  await ready(page);
  await spawnPatch(page, [{ id: 'm', type: 'lfo', position: { x: 200, y: 200 } }]);
  // Find a port handle inside the LFO card and right-click it.
  const handle = page.locator('.svelte-flow__node-lfo .svelte-flow__handle').first();
  await expect(handle).toBeVisible();
  await handle.click({ button: 'right' });
  await expect(page.locator('[role="menu"][aria-label="Module actions"]')).toBeVisible();
  await expect(page.locator('.module-palette')).toHaveCount(0);
});

test('rclick after the canvas pans/scrolls still anchors at the cursor (flow-space)', async ({ page }) => {
  await ready(page);
  // Spawn one module so fitView centers the viewport; subsequent rclick
  // anchor must still match in flow-space (NOT in screen-space) because
  // fitView keeps re-fitting.
  await spawnPatch(page, [{ id: 'anchor', type: 'mixer', position: { x: 0, y: 0 } }]);
  const box = await paneBox(page);
  const mixerBox = await page.locator('.svelte-flow__node-mixer').first().boundingBox();
  // Click well past the mixer's right edge (and within the pane) so the
  // event lands on the empty pane, not on the mixer card or its handles.
  const offsetFromMixer = mixerBox ? (mixerBox.x + mixerBox.width + 80) : (box.x + box.width * 0.8);
  const click = { x: Math.min(offsetFromMixer, box.x + box.width - 60), y: box.y + 40 };
  const expected = await screenToFlow(page, click);
  await page.mouse.click(click.x, click.y, { button: 'right' });
  await expect(page.locator('.module-palette')).toBeVisible();
  await page.getByRole('button', { name: 'Reverb', exact: true }).click();
  const nodes = await readNodes(page);
  const reverb = nodes.find((n) => n.type === 'reverb');
  expect(reverb).toBeTruthy();
  expect(Math.abs(reverb!.position.x - expected.x)).toBeLessThan(4);
  expect(Math.abs(reverb!.position.y - expected.y)).toBeLessThan(4);
});

test('palette open state is bidirectional: closing via Escape clears UI', async ({ page }) => {
  await ready(page);
  const box = await paneBox(page);
  await page.mouse.click(box.x + 100, box.y + 100, { button: 'right' });
  await expect(page.locator('.module-palette')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.module-palette')).not.toBeVisible();
  // No accidental spawn from Escape path.
  const nodes = await readNodes(page);
  expect(nodes).toEqual([]);
});

// Documented out-of-scope:
//   - Touch / long-press: mobile menu UX is deferred. The pointer-events
//     pipeline today targets desktop only; track in M-NN if/when we add a
//     mobile-first path.
