// e2e/tests/workflow-camera.spec.ts
//
// WORKFLOW MODE P4 — the camera manager on /rack?mode=workflow:
//
//   📷 topbar slot → ＋ maps a HEADLESS camera (a FULL cameraInput module
//   carrying the `hiddenCard` node-data flag — NO canvas card anywhere,
//   its face is this menu) and immediately opens its source picker (the
//   hosted REAL CameraInputCard's own device dropdown). Menu rows:
//   click = a VIRTUAL-PORT cable drag of the camera's video output
//   (resolve-at-commit returns the EXISTING module — no creation);
//   ✕ = unmap via the standard remove path (module + edges gone).
//
//   The REAL-CHAIN test drives the module's deterministic frame seam
//   (`__camerainputTestFrame` — the exact hook the CAMERA render smoke
//   uses) with the engine loop paused + clock pinned (_render-smoke), so
//   the "downstream shows live frames" assert is fixed-step + floors-only
//   (renderer-tolerant: SwiftShader vs real GPU both clear them), never a
//   wall-clock pixel race.
//
// Driving /rack?mode=workflow keeps this in the NORMAL e2e lane (no
// DB/relay) — same rationale as workflow-mode.spec.ts. Collaborator
// visibility (the flag is synced node data) is covered at unit level
// against real Y.Docs (graph/hidden-card.test.ts), not by a multi-context
// spec here.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { installRenderSmokeHooks, stepAndReadStats, assertRenderStats } from './_render-smoke';

const FIXED_STEPS = 6;

interface PatchNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data?: Record<string, unknown>;
}
interface PatchEdge {
  id: string;
  source: { nodeId: string; portId: string };
  target: { nodeId: string; portId: string };
}

async function readNodes(page: Page): Promise<PatchNode[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __patch: { nodes: Record<string, PatchNode> } };
    return Object.values(w.__patch.nodes)
      .filter(Boolean)
      .map((n) => ({ id: n.id, type: n.type, position: n.position, data: n.data }));
  });
}
async function readEdges(page: Page): Promise<PatchEdge[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __patch: { edges: Record<string, PatchEdge> } };
    return Object.values(w.__patch.edges).filter(Boolean) as PatchEdge[];
  });
}
async function mappedCameras(page: Page): Promise<PatchNode[]> {
  return (await readNodes(page)).filter(
    (n) => n.type === 'cameraInput' && n.data?.hiddenCard === true,
  );
}

async function gotoWorkflow(page: Page): Promise<void> {
  await page.goto('/rack?mode=workflow');
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

async function openCamerasMenu(page: Page): Promise<void> {
  const panel = page.getByTestId('workflow-cameras-panel');
  if ((await panel.getAttribute('data-open')) !== 'true') {
    await page.getByTestId('workflow-topbar-slot-cameras').click();
  }
  await expect(panel).toHaveAttribute('data-open', 'true');
}

/** Drop the carried (virtual) cable on `portId` of node `nodeId` via the
 *  card's own PatchPanel: trigger → INPUT drill → port row (the same
 *  validated commit path every carry rides — workflow-media precedent). */
async function dropOnInput(page: Page, nodeId: string, portId: string): Promise<void> {
  const card = page.locator(`.svelte-flow__node[data-id="${nodeId}"]`);
  await card.getByTestId('patch-trigger').click();
  const panel = page.locator(`[data-patch-panel-chrome="${nodeId}"]`);
  await expect(panel).toBeVisible();
  const inputsNav = panel.locator('[data-testid="patch-panel-nav"][data-nav="inputs"]');
  if (await inputsNav.count()) {
    await inputsNav.click();
  } else {
    await panel.locator('[data-testid="patch-panel-section-nav"]').first().click();
  }
  await panel
    .locator(`[data-testid="patch-panel-port-row"][data-port-id="${portId}"][data-direction="input"]`)
    .click();
}

test.describe('workflow camera manager (P4)', () => {
  test('REAL CHAIN — ＋ maps a headless camera (no card anywhere), menu-drag patches its output into CHROMA, downstream renders LIVE frames; ✕ unmaps module + edges', async ({
    page,
  }) => {
    // A video-domain boot on CI's SwiftShader + a full menu → drag → drill
    // interaction chain (ONE camera capture — flat 90s covers it).
    test.setTimeout(90_000);

    // Determinism hooks BEFORE boot: pause the engine rAF loop + pin the
    // clock (_render-smoke), and enable the synthetic camera frame so the
    // chain needs no getUserMedia / 'streaming' state (the camera render
    // smoke's exact recipe — bit-stable under any load).
    await installRenderSmokeHooks(page);
    await page.addInitScript(() => {
      (window as unknown as { __camerainputTestFrame?: boolean }).__camerainputTestFrame = true;
    });

    await gotoWorkflow(page);
    await spawnPatch(page, [{ id: 'fx', type: 'chroma', position: { x: 60, y: 200 }, domain: 'video' }]);

    // ＋ maps a camera…
    await openCamerasMenu(page);
    await expect(page.getByTestId('workflow-cameras-empty')).toBeVisible();
    await page.getByTestId('workflow-cameras-add').click();

    // …a FULL cameraInput module lands in the graph, hiddenCard-flagged…
    await expect.poll(async () => (await mappedCameras(page)).length).toBe(1);
    const [cam] = await mappedCameras(page);
    expect(cam.id).toMatch(/^wfcam-/);

    // …with NO canvas card anywhere (the hidden-flag skip), while the
    // CHROMA card renders normally.
    await expect(page.locator(`.flow .svelte-flow__node[data-id="${cam.id}"]`)).toHaveCount(0);
    await expect(page.locator('.flow .svelte-flow__node[data-id="fx"]')).toBeVisible();

    // ＋ also opened the new camera's SOURCE PICKER: the hosted REAL
    // CameraInputCard (its own device dropdown = the module's existing
    // source-selection seam, nothing forked).
    const host = page.locator(`[data-testid="workflow-camera-host"][data-node-id="${cam.id}"]`);
    await expect(host).toHaveAttribute('data-shown', 'true');
    await expect(host.getByTestId('camera-device-select')).toBeVisible();

    // The menu lists it ("camera 1" — no locally-resolvable device label
    // in this headless run).
    const row = page.getByTestId('workflow-camera-row');
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId('workflow-camera-label')).toHaveText(/camera 1/);

    // Row click → the VIRTUAL-PORT drag: ghost cable up, menu closed.
    await row.getByTestId('workflow-camera-label').click();
    await expect(page.getByTestId('pickup-cable')).toBeVisible();
    await expect(page.getByTestId('workflow-cameras-panel')).toHaveAttribute('data-open', 'false');

    // Drop on CHROMA.in → resolve-at-commit returns the EXISTING module
    // (no second camera), and the edge rides the validated carry commit.
    await dropOnInput(page, 'fx', 'in');
    await expect
      .poll(async () =>
        (await readEdges(page)).some(
          (e) =>
            e.source.nodeId === cam.id &&
            e.source.portId === 'out' &&
            e.target.nodeId === 'fx' &&
            e.target.portId === 'in',
        ),
      )
      .toBe(true);
    expect(await mappedCameras(page)).toHaveLength(1);

    // DOWNSTREAM SHOWS LIVE FRAMES: first let the async reconciler
    // materialize the camera's engine node + the new edge (single-step
    // probes until CHROMA's input goes live), then drive a fixed burst
    // and read CHROMA's output FBO (floors only — renderer-tolerant).
    // The synthetic checker is dense + saturated, so beyond the standard
    // floors we can pin down "LIVE frames, not the camera's idle navy":
    // the checker's mean luma (~110) clears 60 where the idle pattern
    // (~19) cannot.
    await expect
      .poll(
        async () => (await stepAndReadStats(page, { nodeId: 'fx', steps: 1 })).mean,
        { timeout: 20_000 },
      )
      .toBeGreaterThan(60);
    const stats = await stepAndReadStats(page, { nodeId: 'fx', steps: FIXED_STEPS });
    assertRenderStats(stats, FIXED_STEPS);
    expect(
      stats.mean,
      'downstream renders the camera FRAME (checker mean luma), not the idle pattern',
    ).toBeGreaterThan(60);

    // Still no card materialized anywhere for the camera.
    await expect(page.locator(`.flow .svelte-flow__node[data-id="${cam.id}"]`)).toHaveCount(0);

    // ✕ unmaps: module + its edges gone via the standard remove path
    // (hidden cameras are NOT pinned); the row disappears.
    await openCamerasMenu(page);
    await page.getByTestId('workflow-camera-unmap').click();
    await expect.poll(async () => (await mappedCameras(page)).length).toBe(0);
    expect(
      (await readEdges(page)).filter(
        (e) => e.source.nodeId === cam.id || e.target.nodeId === cam.id,
      ),
    ).toHaveLength(0);
    await expect(page.getByTestId('workflow-camera-row')).toHaveCount(0);
    await expect(page.getByTestId('workflow-cameras-empty')).toBeVisible();
  });

  test('cap + persistence: ＋ stops at cameraInput.maxInstances, ✕ frees a slot with stable ordinals, and mapped cameras round-trip quicksave→reload→quickload still cardless', async ({
    page,
  }) => {
    // Two full page boots (reload) + 4 hosted cards — DOM-only, no video
    // engine render needed.
    test.setTimeout(90_000);
    await gotoWorkflow(page);

    // Map cameras up to the def cap (4 — shared with canvas CAMERA cards,
    // graph/cap.ts wouldExceedCap: the same predicate every spawn uses).
    await openCamerasMenu(page);
    const addBtn = page.getByTestId('workflow-cameras-add');
    for (let i = 1; i <= 4; i++) {
      await addBtn.click();
      await expect.poll(async () => (await mappedCameras(page)).length).toBe(i);
    }
    await expect(page.getByTestId('workflow-camera-row')).toHaveCount(4);
    const labels = page.getByTestId('workflow-camera-label');
    await expect(labels.nth(0)).toHaveText(/camera 1/);
    await expect(labels.nth(3)).toHaveText(/camera 4/);
    // The 5th is refused — the ＋ row reads disabled at cap.
    await expect(addBtn).toBeDisabled();

    // ✕ the SECOND row: ordinals stay stable (1, 3, 4 — "camera 3" does
    // not renumber), and the freed slot re-enables ＋.
    await page.getByTestId('workflow-camera-unmap').nth(1).click();
    await expect.poll(async () => (await mappedCameras(page)).length).toBe(3);
    await expect(labels.nth(0)).toHaveText(/camera 1/);
    await expect(labels.nth(1)).toHaveText(/camera 3/);
    await expect(labels.nth(2)).toHaveText(/camera 4/);
    await expect(addBtn).toBeEnabled();

    // Never a canvas card, whatever the count.
    expect(
      await page.locator('.flow .svelte-flow__node-cameraInput').count(),
    ).toBe(0);

    // PERSISTENCE ROUND-TRIP: quicksave slot 1 → full reload → quickload.
    // hiddenCard is ordinary synced node data, so the mapped set (and its
    // cardlessness) must survive like any module.
    await page.getByTestId('workflow-file-trigger').click();
    await page.getByTestId('workflow-file-quicksave').click();
    await page.getByTestId('workflow-quicksave-1').click();
    await expect(page.getByTestId('workflow-file-menu')).toHaveCount(0);
    // The slot write is async (perf-zip build → IndexedDB slot store) —
    // wait for the slot to read OCCUPIED before reloading, or the reload
    // races the write and quickload finds an empty slot.
    await page.getByTestId('workflow-file-trigger').click();
    await page.getByTestId('workflow-file-quicksave').click();
    await expect(page.getByTestId('workflow-quicksave-1')).toHaveClass(/occupied/, {
      timeout: 15_000,
    });
    await page.keyboard.press('Escape');

    await page.reload();
    await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
    await page.getByTestId('workflow-file-trigger').click();
    await page.getByTestId('workflow-file-quickload').click();
    const slot1 = page.getByTestId('workflow-quickload-1');
    await expect(slot1).toBeEnabled();
    await slot1.click();

    await expect
      .poll(async () => (await mappedCameras(page)).length, { timeout: 15_000 })
      .toBe(3);
    // The menu lists the restored set (same stable ordinals)…
    await openCamerasMenu(page);
    await expect(page.getByTestId('workflow-camera-row')).toHaveCount(3);
    await expect(page.getByTestId('workflow-camera-label').nth(1)).toHaveText(/camera 3/);
    // …and they are still headless — zero camera cards on the canvas.
    expect(
      await page.locator('.flow .svelte-flow__node-cameraInput').count(),
    ).toBe(0);
  });
});
