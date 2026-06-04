// e2e/tests/cabinet-spawn.spec.ts
//
// End-to-end coverage for the two "moogafakkin System 35/55" topbar
// buttons (feat/moog-cabinet-buttons). Clicking a button spawns a full
// Moog cabinet — every module laid out in two rows mirroring the real
// service-manual cabinet figures, non-overlapping.
//
// Asserts, per system:
//   - the right NUMBER of moog cards mount in the DOM (17 for S35, 27 for
//     S55) — counted via the .svelte-flow__node[data-id^="moog"] cards,
//   - the patch graph holds exactly that many moog nodes (via __patch),
//   - NO two spawned cards' bounding boxes overlap (rect from node
//     position + measured size, read through the __flow dev hook).
//
// The TIMELORDE clock auto-spawns on an empty rack, so we count + overlap-
// check only the moog* nodes the button added (TIMELORDE is excluded).

import { test, expect, type Page } from '@playwright/test';

test.describe.configure({ mode: 'parallel' });

interface NodePos { x: number; y: number }
interface PatchNode { id: string; type: string; position: NodePos }

async function ready(page: Page) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(() => {
    const w = window as unknown as { __patch?: unknown; __flow?: unknown };
    return !!w.__patch && !!w.__flow;
  });
}

// Only the moog cabinet nodes the button spawned (excludes the auto-spawned
// TIMELORDE singleton + any other non-moog node).
async function readMoogNodes(page: Page): Promise<PatchNode[]> {
  return await page.evaluate(() => {
    const w = window as unknown as { __patch: { nodes: Record<string, PatchNode> } };
    return (Object.values(w.__patch.nodes).filter(Boolean) as PatchNode[]).filter((n) =>
      n.type.startsWith('moog'),
    );
  });
}

async function getInternalSize(page: Page, id: string): Promise<{ w: number; h: number }> {
  return await page.evaluate((nid) => {
    const w = window as unknown as {
      __flow: {
        getInternalNode: (id: string) => { measured?: { width?: number; height?: number } } | undefined;
      };
    };
    const internal = w.__flow.getInternalNode(nid);
    return { w: internal?.measured?.width ?? 240, h: internal?.measured?.height ?? 200 };
  }, id);
}

function rectsOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  const xOverlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const yOverlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return xOverlap > 0.5 && yOverlap > 0.5;
}

async function assertNoOverlaps(page: Page, nodes: PatchNode[]) {
  const sizes = await Promise.all(nodes.map((n) => getInternalSize(page, n.id)));
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const ri = { x: nodes[i].position.x, y: nodes[i].position.y, w: sizes[i].w, h: sizes[i].h };
      const rj = { x: nodes[j].position.x, y: nodes[j].position.y, w: sizes[j].w, h: sizes[j].h };
      expect(
        rectsOverlap(ri, rj),
        `cards ${nodes[i].id} and ${nodes[j].id} overlap`,
      ).toBe(false);
    }
  }
}

test('moogafakkin System 35 button spawns 17 non-overlapping cabinet modules', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await ready(page);
  await page.getByTestId('moog-system-35-btn').click();

  // 17 moog cards mount in the DOM.
  const cards = page.locator('.svelte-flow__node[data-id^="moog"]');
  await expect(cards).toHaveCount(17);

  // Patch graph holds exactly 17 moog nodes.
  await expect.poll(async () => (await readMoogNodes(page)).length).toBe(17);

  // Let xyflow measure card sizes before the overlap check.
  await page.waitForTimeout(300);
  const nodes = await readMoogNodes(page);
  await assertNoOverlaps(page, nodes);

  expect(errors).toEqual([]);
});

test('moogafakkin System 55 button spawns 27 non-overlapping cabinet modules', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await ready(page);
  await page.getByTestId('moog-system-55-btn').click();

  // 27 moog cards mount in the DOM.
  const cards = page.locator('.svelte-flow__node[data-id^="moog"]');
  await expect(cards).toHaveCount(27);

  // Patch graph holds exactly 27 moog nodes.
  await expect.poll(async () => (await readMoogNodes(page)).length).toBe(27);

  await page.waitForTimeout(300);
  const nodes = await readMoogNodes(page);
  await assertNoOverlaps(page, nodes);

  expect(errors).toEqual([]);
});
