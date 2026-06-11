// e2e/tests/cable-drag-drilldown.spec.ts
//
// Cable-drag → drill-down menu (NO hover action, NO auto-patch).
//
// Owner report: dragging a cable from a raw-handle card's OUTPUT (e.g. a
// VARISPEED video out) onto a PatchPanel card (e.g. QUADRALOGICAL) used to
// AUTO-PATCH to an arbitrary stacked handle the moment SvelteFlow's
// connection-radius snapped — hover did a leftover snap, and the release/click
// committed a patch the user never chose. Worse, dropping near the hidden
// handle stack picked a port at random.
//
// INTENDED (and asserted here):
//   1. A cable dragged from a raw OUTPUT and RELEASED over a PatchPanel target
//      opens that card's DRILL-DOWN port picker (the patch-to menu pre-drilled
//      into the dropped-on module) — and creates NO edge yet.
//   2. Picking a compatible port in that menu commits the edge.
//   3. The reverse direction — grabbing the target's INPUT and dragging back to
//      an OUTPUT-bearing source — still patches correctly (no "snag").
//   4. A native drag dropped on a raw-handle target (two visible handles) keeps
//      the precise direct commit (we only divert the ambiguous stacked-handle
//      case).
//
// The drag lifecycle is driven through the dev-only __handleConnectStart /
// __handleConnectEnd hooks — the SAME production functions SvelteFlow's pointer
// drag calls (connectstart → connectend) — so we exercise the real
// suppress-snap + open-drill-down path without pixel-perfect pointer moves on a
// stacked-handle card. The drop point passed to __handleConnectEnd is a real
// screen coordinate inside the target card, so handleConnectEnd's
// elementFromPoint resolves the dropped-on card exactly as a real release does.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

// Serial (not parallel): this spec shares a shard with heavy WebGL video specs
// (e.g. backdraft) that can crash the SwiftShader browser under contention on
// CI; running these few cable-drag cases serially keeps the worker stable and
// avoids inheriting a dead browser from a parallel sibling.
test.describe.configure({ mode: 'serial' });

interface PatchEdge {
  id: string;
  source: { nodeId: string; portId: string };
  target: { nodeId: string; portId: string };
}

async function readEdges(page: Page): Promise<PatchEdge[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __patch: { edges: Record<string, PatchEdge> } };
    return Object.values(w.__patch.edges).filter(Boolean) as PatchEdge[];
  });
}

/** Centre screen point of a card (where a real release would land). */
async function cardCenter(page: Page, nodeId: string): Promise<{ x: number; y: number }> {
  const box = await page.locator(`.svelte-flow__node[data-id="${nodeId}"]`).boundingBox();
  expect(box, `card ${nodeId} must be mounted`).toBeTruthy();
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
}

/** Drive a native cable DRAG: grab a handle, release over a screen point —
 *  exactly the connectstart → connectend lifecycle a pointer drag fires. */
async function dragHandleTo(
  page: Page,
  source: { nodeId: string; handleId: string; handleType: 'source' | 'target' },
  drop: { x: number; y: number },
): Promise<void> {
  await page.evaluate(
    ({ source, drop }) => {
      const w = window as unknown as {
        __handleConnectStart: (p: {
          nodeId: string;
          handleId: string;
          handleType: 'source' | 'target';
        }) => void;
        __handleConnectEnd: (d: { x: number; y: number }) => void;
      };
      w.__handleConnectStart(source);
      w.__handleConnectEnd(drop);
    },
    { source, drop },
  );
}

/** VARISPEED (raw handles) → QUADRALOGICAL (PatchPanel, hidden handle stack). */
async function spawnVarispeedQuad(page: Page) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [
    { id: 'vs', type: 'videovarispeed', position: { x: 80, y: 120 }, domain: 'video' },
    { id: 'quad', type: 'quadralogical', position: { x: 760, y: 120 }, domain: 'video' },
  ]);
}

// ── (1) drag onto a PatchPanel card opens the drill-down picker, no edge yet ──

test('drag from a raw OUTPUT onto a PatchPanel card opens the drill-down picker and creates NO edge', async ({
  page,
}) => {
  await spawnVarispeedQuad(page);
  expect(await readEdges(page)).toHaveLength(0);

  // Drag VARISPEED.video (a raw video OUTPUT) and release over QUADRALOGICAL.
  await dragHandleTo(
    page,
    { nodeId: 'vs', handleId: 'video', handleType: 'source' },
    await cardCenter(page, 'quad'),
  );

  // The drill-down picker is OPEN (overlay-replace, body-portaled), pre-drilled
  // into QUADRALOGICAL so the user is on its compatible-port list.
  const menu = page.locator('[data-testid="port-context-menu"]');
  await expect(menu).toBeVisible();
  await expect(menu.locator('[data-testid="patch-to-ports"]')).toBeVisible();
  // It lists QUADRALOGICAL's video inputs (in1..in4) — compatible with a video
  // source — and crucially NO edge has been written yet.
  const portIds = await menu
    .locator('[data-testid="patch-to-port"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-port-id')));
  expect(portIds).toContain('in1');
  expect(await readEdges(page)).toHaveLength(0);
});

// ── (2) picking a port in that menu commits the edge ─────────────────────────

test('picking a port in the drilled-down picker commits the chosen edge', async ({ page }) => {
  await spawnVarispeedQuad(page);

  await dragHandleTo(
    page,
    { nodeId: 'vs', handleId: 'video', handleType: 'source' },
    await cardCenter(page, 'quad'),
  );

  const menu = page.locator('[data-testid="port-context-menu"]');
  await expect(menu).toBeVisible();
  // Wait for the drilled-in port list to render before picking — on CI's
  // SwiftShader/slower runner the body-portaled sublist mounts a beat after the
  // menu container, and clicking before it exists raced the commit.
  await expect(menu.locator('[data-testid="patch-to-ports"]')).toBeVisible();
  // Pick QUADRALOGICAL's IN2.
  const in2 = menu.locator('[data-testid="patch-to-port"][data-port-id="in2"]');
  await expect(in2).toBeVisible();
  await in2.click();

  // Exactly the edge the user chose lands — vs.video → quad.in2.
  await expect.poll(async () => (await readEdges(page)).length, { timeout: 5000 }).toBe(1);
  const edges = await readEdges(page);
  expect(edges[0]!.source).toEqual({ nodeId: 'vs', portId: 'video' });
  expect(edges[0]!.target).toEqual({ nodeId: 'quad', portId: 'in2' });
  // The picker closed after the commit.
  await expect(menu).toHaveCount(0);
});

// ── (3) reverse-direction drag onto a PatchPanel card opens the picker for the
//        card's OUTPUTS, and the committed edge is correctly oriented ──────────

test('reverse drag — grab a raw INPUT, drop on a PatchPanel card — picker offers the card OUTPUTS and orients the edge', async ({
  page,
}) => {
  // VIDEO OUT (raw `in` INPUT) ← QUADRALOGICAL (PatchPanel, `out` video OUTPUT).
  // Grabbing the input and dragging to the output is the reverse direction the
  // owner reported as snagging; the picker must offer QUAD's compatible OUTPUTS
  // and the resulting edge must run quad.out (OUTPUT) → vout.in (INPUT).
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  // QUAD is the DROP target, so place it where the forward-drag test drops
  // (x:760) — a proven-visible region. At x:80 the body-portaled picker opened
  // hard against the left viewport edge and its option was un-actionable on CI.
  await spawnPatch(page, [
    { id: 'vout', type: 'videoOut', position: { x: 80, y: 120 }, domain: 'video' },
    { id: 'quad', type: 'quadralogical', position: { x: 760, y: 120 }, domain: 'video' },
  ]);
  expect(await readEdges(page)).toHaveLength(0);

  // Grab VIDEO OUT's `in` (a raw target/INPUT handle) and release over QUAD.
  await dragHandleTo(
    page,
    { nodeId: 'vout', handleId: 'in', handleType: 'target' },
    await cardCenter(page, 'quad'),
  );

  const menu = page.locator('[data-testid="port-context-menu"]');
  await expect(menu).toBeVisible();
  await expect(menu.locator('[data-testid="patch-to-ports"]')).toBeVisible();
  // The source is an INPUT, so the picker offers QUAD's compatible OUTPUTS.
  const portIds = await menu
    .locator('[data-testid="patch-to-port"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-port-id')));
  expect(portIds).toContain('out');
  expect(await readEdges(page)).toHaveLength(0);

  // Pick it → edge runs quad.out (OUTPUT) → vout.in (INPUT), correctly oriented.
  const outOpt = menu.locator('[data-testid="patch-to-port"][data-port-id="out"]');
  await expect(outOpt).toBeVisible();
  await outOpt.click();
  await expect.poll(async () => (await readEdges(page)).length, { timeout: 5000 }).toBe(1);
  const edges = await readEdges(page);
  expect(edges[0]!.source).toEqual({ nodeId: 'quad', portId: 'out' });
  expect(edges[0]!.target).toEqual({ nodeId: 'vout', portId: 'in' });
});

// ── (3b) reverse RAW→RAW drag commits directly, correctly oriented ──────────

test('reverse raw→raw drag (grab INPUT, drop on OUTPUT) commits the oriented edge directly', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [
    { id: 'vs', type: 'videovarispeed', position: { x: 80, y: 120 }, domain: 'video' },
    { id: 'vout', type: 'videoOut', position: { x: 760, y: 120 }, domain: 'video' },
  ]);
  expect(await readEdges(page)).toHaveLength(0);

  // Grab VIDEO OUT.in (raw INPUT), commit the literal reverse connection onto
  // VARISPEED.video (raw OUTPUT) — both visible handles, a precise drop. xyflow
  // (loose mode) reports the grabbed input as the literal source; orientation
  // must flip it so the written edge is vs.video → vout.in.
  await page.evaluate(() => {
    const w = window as unknown as {
      __handleConnectStart: (p: { nodeId: string; handleId: string; handleType: 'source' | 'target' }) => void;
      __handleConnect: (c: { source: string; target: string; sourceHandle: string; targetHandle: string }) => void;
      __handleConnectEnd: (d: { x: number; y: number }) => void;
    };
    w.__handleConnectStart({ nodeId: 'vout', handleId: 'in', handleType: 'target' });
    w.__handleConnect({ source: 'vout', target: 'vs', sourceHandle: 'in', targetHandle: 'video' });
    w.__handleConnectEnd({ x: 0, y: 0 });
  });

  await expect(page.locator('[data-testid="port-context-menu"]')).toHaveCount(0);
  await expect.poll(async () => (await readEdges(page)).length, { timeout: 5000 }).toBe(1);
  const edges = await readEdges(page);
  expect(edges[0]!.source).toEqual({ nodeId: 'vs', portId: 'video' });
  expect(edges[0]!.target).toEqual({ nodeId: 'vout', portId: 'in' });
});

// ── (4) drag between two raw-handle cards keeps the precise direct commit ─────

test('drag between two raw-handle cards still commits directly (no picker)', async ({ page }) => {
  // VARISPEED.video (raw out) → VIDEO OUT.in (raw in) — both visible handles, an
  // unambiguous precise drop, so it commits directly without the drill-down.
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [
    { id: 'vs', type: 'videovarispeed', position: { x: 80, y: 120 }, domain: 'video' },
    { id: 'vout', type: 'videoOut', position: { x: 760, y: 120 }, domain: 'video' },
  ]);
  expect(await readEdges(page)).toHaveLength(0);

  await page.evaluate(() => {
    const w = window as unknown as {
      __handleConnectStart: (p: { nodeId: string; handleId: string; handleType: 'source' | 'target' }) => void;
      __handleConnect: (c: { source: string; target: string; sourceHandle: string; targetHandle: string }) => void;
      __handleConnectEnd: (d: { x: number; y: number }) => void;
    };
    // Real lifecycle: start the drag, commit a PRECISE connection onto the raw
    // target handle (as SvelteFlow's onconnect would for a visible-handle drop),
    // then end. VIDEO OUT is a raw-handle card so the commit is honoured.
    w.__handleConnectStart({ nodeId: 'vs', handleId: 'video', handleType: 'source' });
    w.__handleConnect({ source: 'vs', target: 'vout', sourceHandle: 'video', targetHandle: 'in' });
    w.__handleConnectEnd({ x: 0, y: 0 });
  });

  // No drill-down picker — the edge committed directly.
  await expect(page.locator('[data-testid="port-context-menu"]')).toHaveCount(0);
  await expect.poll(async () => (await readEdges(page)).length, { timeout: 5000 }).toBe(1);
  const edges = await readEdges(page);
  expect(edges[0]!.source).toEqual({ nodeId: 'vs', portId: 'video' });
  expect(edges[0]!.target).toEqual({ nodeId: 'vout', portId: 'in' });
});
