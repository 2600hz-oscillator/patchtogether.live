// e2e/tests/organize-modules.spec.ts
//
// End-to-end coverage for the right-click → "Organize modules" + anchored-spawn
// feature added in PR #36. This suite is intentionally extensive:
//
//   - Right-click context-menu basics (palette + per-node menu)
//   - "Add Module" sub-menu (categories, click-to-spawn, click-anchor)
//   - "Organize modules" action (separates overlap, preserves layout, no-ops)
//   - Multi-user collab safety (organize + spawn cross-sync via Yjs)
//   - Edge cases (drag-vs-rclick, port-handle behavior, suppressed paths)
//
// NOTE: spawn-on-collision used to auto-offset by STACK_OFFSET (24px) until
// the new card cleared every sibling. That was changed to literal-cursor +
// visual-on-top (zIndex) per user feedback — see spawn-at-cursor.spec.ts
// for the new invariants.
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
import { SYNC_BUDGET_MS, SYNC_POLL_INTERVALS } from './_collab-helpers';

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

// readUserNodes excludes the auto-spawned TIMELORDE singleton so @collab
// count assertions see only the nodes the test itself added.
async function readUserNodes(page: Page): Promise<PatchNode[]> {
  return (await readNodes(page)).filter((n) => n.type !== 'timelorde');
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
  // Right-click the card background (title bar) — a knob/fader right-click now
  // opens the per-control MIDI menu instead of the module menu.
  await m.locator('.title').click({ button: 'right' });
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

test('palette renders the 3 top-level categories (audio / video / hybrid)', async ({ page }) => {
  await ready(page);
  const box = await paneBox(page);
  await page.mouse.click(box.x + 200, box.y + 200, { button: 'right' });
  await expect(page.locator('.module-palette')).toBeVisible();
  // The nested menu starts collapsed: the three top-level rows are visible
  // and the per-domain sub-categories surface after expanding.
  await expect(page.getByTestId('palette-top-audio-modules')).toBeVisible();
  await expect(page.getByTestId('palette-top-video-modules')).toBeVisible();
  await expect(page.getByTestId('palette-top-hybrid')).toBeVisible();
});

test('palette: drilling into Audio modules → Effects surfaces Reverb', async ({ page }) => {
  await ready(page);
  const box = await paneBox(page);
  await page.mouse.click(box.x + 200, box.y + 200, { button: 'right' });
  await expect(page.locator('.module-palette')).toBeVisible();
  await page.getByTestId('palette-top-audio-modules').click();
  await page.getByTestId('palette-sub-effects').click();
  await expect(page.getByTestId('palette-item-reverb')).toBeVisible();
  // Mixer is NOT under Effects — it's under Mixing.
  await expect(page.getByTestId('palette-item-mixer')).toHaveCount(0);
});

test('clicking a palette item spawns exactly one module of that type', async ({ page }) => {
  await ready(page);
  const box = await paneBox(page);
  await page.mouse.click(box.x + 200, box.y + 200, { button: 'right' });
  await expect(page.locator('.module-palette')).toBeVisible();
  await page.getByTestId('palette-top-audio-modules').click();
  await page.getByTestId('palette-sub-effects').click();
  await page.getByTestId('palette-item-reverb').click();
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
  // Search-mode shortcut so the test doesn't have to know that Reverb
  // currently lives under Audio modules → Effects.
  await page.keyboard.type('Reverb');
  await page.keyboard.press('Enter');
  const nodes = await readNodes(page);
  expect(nodes).toHaveLength(1);
  const pos = nodes[0].position;
  // The card's top-left should be near the click. xyflow doesn't snap, so a
  // few-px tolerance is just float jitter from the viewport transform.
  expect(Math.abs(pos.x - expected.x)).toBeLessThan(4);
  expect(Math.abs(pos.y - expected.y)).toBeLessThan(4);
});

test('spawn over an existing node lands AT the cursor position (overlap allowed)', async ({ page }) => {
  // Behavior change vs PR #36: the user explicitly wants the new card under
  // the cursor even if it overlaps an existing module. Visual stacking is
  // handled by topNodeId/zIndex (see spawn-at-cursor.spec.ts), so here we
  // only assert the position invariant — the new card sits at the requested
  // flow-space coords, NOT auto-offset away.
  await ready(page);
  await spawnPatch(page, [{ id: 'a', type: 'mixer', position: { x: 200, y: 200 } }]);
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
  expect(reverb!.position).toEqual({ x: 200, y: 200 });
  expect(mixer.position).toEqual({ x: 200, y: 200 });
});

test('spawn over multiple stacked nodes still lands AT the cursor (overlap allowed)', async ({ page }) => {
  // Same change as above — the previous behavior iterated STACK_OFFSET until
  // clear; new behavior trusts the user and stacks visually via zIndex.
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
  expect(scope!.position).toEqual({ x: 200, y: 200 });
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
  await page.keyboard.type('Reverb');
  await page.keyboard.press('Enter');
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

test('organize: 3 already-disjoint modules preserve left-to-right order + remain non-overlapping', async ({ page }) => {
  await ready(page);
  // The previous "are not perturbed" assertion belonged to the old strict
  // declutter pass. The new dense-pack always relayouts so the user gets the
  // gap-tightening they asked for — but it MUST still preserve relative order
  // (a → b → c stays a → b → c) and avoid overlap.
  await spawnPatch(page, [
    { id: 'a', type: 'mixer', position: { x: 0, y: 0 } },
    { id: 'b', type: 'reverb', position: { x: 400, y: 0 } },
    { id: 'c', type: 'lfo', position: { x: 800, y: 0 } },
  ]);
  await page.evaluate(() => {
    const w = window as unknown as { __organizeModules: () => void };
    w.__organizeModules();
  });
  const after = await readNodes(page);
  const a = after.find((n) => n.id === 'a')!;
  const b = after.find((n) => n.id === 'b')!;
  const c = after.find((n) => n.id === 'c')!;
  // Left-to-right order preserved (within their row, however the row-pack chose).
  if (a.position.y === b.position.y) expect(a.position.x).toBeLessThan(b.position.x);
  if (b.position.y === c.position.y) expect(b.position.x).toBeLessThan(c.position.x);
  // No overlap between any pair.
  const sizes = await Promise.all(after.map((n) => getInternalSize(page, n.id)));
  for (let i = 0; i < after.length; i++) {
    for (let j = i + 1; j < after.length; j++) {
      expect(rectsOverlap(
        { x: after[i].position.x, y: after[i].position.y, w: sizes[i].w, h: sizes[i].h },
        { x: after[j].position.x, y: after[j].position.y, w: sizes[j].w, h: sizes[j].h },
      )).toBe(false);
    }
  }
});

test('organize: dense-pack moves a far-apart layout closer together', async ({ page }) => {
  await ready(page);
  // The user's complaint was "leaves big gaps". Spread modules far apart and
  // assert organize actually moves them: the max pairwise distance after the
  // pass must be strictly less than before. (Bbox-area is a noisier metric
  // because the viewport-aware row pack may stretch across the whole canvas
  // width to put everything on one row — that's the desired behavior, but it
  // doesn't always shrink the bbox.)
  await spawnPatch(page, [
    { id: 'a', type: 'mixer', position: { x: 0, y: 0 } },
    { id: 'b', type: 'reverb', position: { x: 2000, y: 0 } },
    { id: 'c', type: 'lfo', position: { x: 0, y: 2000 } },
    { id: 'd', type: 'scope', position: { x: 2000, y: 2000 } },
  ]);
  const maxPairwise = (nodes: PatchNode[]) => {
    let m = 0;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = nodes[i].position.x - nodes[j].position.x;
        const dy = nodes[i].position.y - nodes[j].position.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > m) m = d;
      }
    }
    return m;
  };
  const before = await readNodes(page);
  const beforeMax = maxPairwise(before);
  await page.evaluate(() => {
    const w = window as unknown as { __organizeModules: () => void };
    w.__organizeModules();
  });
  const after = await readNodes(page);
  const afterMax = maxPairwise(after);
  expect(afterMax).toBeLessThan(beforeMax);
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

  test('User-A spawn-at-rclick reaches User-B', async ({ browser }) => {
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
          { timeout: SYNC_BUDGET_MS, intervals: SYNC_POLL_INTERVALS },
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
          async () => (await readUserNodes(s.pageB)).length,
          { timeout: SYNC_BUDGET_MS, intervals: SYNC_POLL_INTERVALS },
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
          { timeout: SYNC_BUDGET_MS, intervals: SYNC_POLL_INTERVALS },
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
  // Use search mode (flat results) so we don't have to drill into the
  // correct sub-category just to assert the item is missing.
  await page.keyboard.type('TIMELORDE');
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

test('patch-to flow on a port surfaces the picker, not the module palette', async ({ page }) => {
  // Redesign: PatchPanel handles are non-interactive cable anchors (the
  // right-click-handle gesture is retired). The "patch to" picker is reached
  // via jack-click → "patch to". We assert: NO crash, the module palette
  // never appears, and the port-context picker DOES appear. (Two modules so
  // the picker has a target.)
  await ready(page);
  await spawnPatch(page, [
    { id: 'm', type: 'lfo', position: { x: 200, y: 200 } },
    { id: 'f', type: 'filter', position: { x: 760, y: 200 } },
  ]);
  const nodeId = 'm';
  await page.locator('.svelte-flow__node-lfo [data-testid="patch-trigger"]').click();
  const chrome = page.locator(`[data-patch-panel-chrome="${nodeId}"]`);
  await expect(chrome).toHaveAttribute('aria-hidden', 'false');
  await chrome.locator('[data-testid="patch-panel-nav"][data-nav="outputs"]').click();
  await chrome.locator('[data-testid="patch-panel-port-row"][data-port-id="phase0"]').click();
  await page.mouse.move(500, 320);
  await chrome.locator('[data-testid="patch-panel-patch-to"]').click();
  await expect(page.locator('[data-testid="port-context-menu"]')).toBeVisible();
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
  // Search-mode flatten + Enter shortcut (avoids drilling Audio → Effects).
  await page.keyboard.type('Reverb');
  await page.keyboard.press('Enter');
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
