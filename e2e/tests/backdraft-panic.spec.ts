// e2e/tests/backdraft-panic.spec.ts
//
// BACKDRAFT's PANIC — owner request (2026-08): *"backdraft should have a
// 'panic' button and gate, the button should be above the screen on/off button
// and therefore visible in all views. the function of panic is to reset all
// settings in the module to their defaults, without changing at all anything
// which is patched."*
//
// The REAL button in the REAL dock view, plus the gate leg through the
// deterministic engine seam (the freezeframe driveGateFrames convention:
// getNodeHandle(...).setParam replays exactly what installGateDispatch
// delivers). The reset semantics themselves — every user param → def default,
// exclusions untouched, ONE undo step, CV-rides-on-top — are pinned at unit
// level in packages/web/src/lib/ui/modules/backdraft/panic.test.ts; this file
// proves the chrome and the wiring in a live rack.

import { test, expect, type Page } from '@playwright/test';
import { waitFrames } from '../_helpers/frames';
import { freezeVideoRender } from './_per-module-per-port-shared';

const NODE = 'bd';
const SRC = 'src-lines';

// Renderer-dependent spec (engine boot + live GL chain + dock): same knob and
// same shape as backdraft-preview-toggle.spec.ts, measured there.
const SLOW_RENDER = process.env.E2E_SWIFTSHADER === '1' || !!process.env.CI;
const CASE_MS = SLOW_RENDER ? 120_000 : 30_000;

/** ADD to the live patch, never `spawnPatch` — it clears the seeded video-zone
 *  defaults (the videoOut sink that pulls the chain). Verbatim the
 *  backdraft-preview-toggle.spec.ts / workflow-shell-video.spec.ts shape. */
async function injectPatch(
  page: Page,
  nodes: { id: string; type: string; position: { x: number; y: number } }[],
  edges: {
    id: string;
    from: { nodeId: string; portId: string };
    to: { nodeId: string; portId: string };
    sourceType: string;
    targetType: string;
  }[] = [],
): Promise<void> {
  await page.waitForFunction(() => {
    const w = globalThis as unknown as { __ensureEngine?: () => Promise<unknown> };
    return typeof w.__ensureEngine === 'function';
  });
  await page.evaluate(async () => {
    const w = globalThis as unknown as { __ensureEngine: () => Promise<unknown> };
    await w.__ensureEngine();
  });
  await page.evaluate(
    ({ nodes, edges }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, unknown>; edges: Record<string, unknown> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        for (const n of nodes) {
          w.__patch.nodes[n.id] = { id: n.id, type: n.type, domain: 'video', position: n.position, params: {} };
        }
        for (const e of edges) {
          w.__patch.edges[e.id] = {
            id: e.id,
            source: e.from,
            target: e.to,
            sourceType: e.sourceType,
            targetType: e.targetType,
          };
        }
      });
    },
    { nodes, edges },
  );
  await page.waitForFunction(
    (ids) => ids.every((id) => document.querySelector(`.svelte-flow__node[data-id="${id}"]`) !== null),
    nodes.map((n) => n.id),
    { timeout: 15_000 },
  );
}

async function gotoShell(page: Page): Promise<void> {
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 30_000 });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

/** Bring the node into the upper quarter of the viewport (the dock full view
 *  opens over the lower half). Verbatim backdraft-preview-toggle.spec.ts. */
async function centerOnNode(page: Page, nodeId: string, zoom = 0.9): Promise<void> {
  await page.evaluate(
    ({ nodeId, zoom }) => {
      const w = globalThis as unknown as {
        __flow: {
          getInternalNode: (id: string) => {
            internals?: { positionAbsolute?: { x: number; y: number } };
            position?: { x: number; y: number };
            measured?: { width?: number; height?: number };
          } | undefined;
          setViewport: (vp: { x: number; y: number; zoom: number }, o?: { duration?: number }) => void;
        };
      };
      const n = w.__flow.getInternalNode(nodeId);
      if (!n) return;
      const x = n.internals?.positionAbsolute?.x ?? n.position?.x ?? 0;
      const y = n.internals?.positionAbsolute?.y ?? n.position?.y ?? 0;
      const cx = x + (n.measured?.width ?? 192) / 2;
      const cy = y + (n.measured?.height ?? 180) / 2;
      const pane = document.querySelector('.svelte-flow') as HTMLElement;
      const r = pane.getBoundingClientRect();
      w.__flow.setViewport({ x: r.width / 2 - cx * zoom, y: r.height / 4 - cy * zoom, zoom }, { duration: 0 });
    },
    { nodeId, zoom },
  );
  await waitFrames(page, 4);
}

async function openFace(page: Page) {
  await centerOnNode(page, NODE);
  const shell = page.locator(`.svelte-flow__node[data-id="${NODE}"] [data-testid="module-shell"]`);
  await expect(shell).toBeVisible();
  await shell.getByTestId('shell-open-dock').click();
  const fv = page.getByTestId('dock-full-view');
  await expect(fv).toBeVisible();
  return fv;
}

/** Twiddle a spread of settings THROUGH THE DOC (the same seam the faders
 *  write) — a continuous fader value, a discrete toggle, a discrete selector. */
async function twiddle(page: Page): Promise<void> {
  await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params: Record<string, number> } | undefined> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes[id]!;
      n.params.mix = 0.1;
      n.params.zoom = 1.5;
      n.params.rotate = -20;
      n.params.mirrorX = 1;
      n.params.tvMode = 2;
    });
  }, NODE);
}

function readNode(page: Page) {
  return page.evaluate((id) => {
    const w = globalThis as unknown as {
      __patch: {
        nodes: Record<string, {
          position: { x: number; y: number };
          params: Record<string, number>;
          data?: Record<string, unknown>;
        } | undefined>;
        edges: Record<string, { source: { nodeId: string; portId: string }; target: { nodeId: string; portId: string } } | undefined>;
      };
    };
    const n = w.__patch.nodes[id]!;
    return {
      position: { x: n.position.x, y: n.position.y },
      params: { ...n.params },
      previewCollapsed: n.data?.previewCollapsed ?? false,
      edgeIn: w.__patch.edges['e-in']
        ? {
            source: { ...w.__patch.edges['e-in']!.source },
            target: { ...w.__patch.edges['e-in']!.target },
          }
        : null,
    };
  }, NODE);
}

test.describe('backdraft PANIC', () => {
  test.beforeEach(async ({ page }) => {
    // Render-suppression hook (the per-module-sweep seam): nothing in this
    // spec reads a pixel — it asserts CHROME (buttons, tabs, geometry) and
    // DOC state — and under SwiftShader every un-frozen frame carries a full
    // software-rasterized feedback pass. Measured on CI shard 3: the
    // seven-tab loop blew its 120s budget behind those frames; frozen, the
    // clicks are plain DOM work on every renderer.
    await freezeVideoRender(page);
    await gotoShell(page);
    await injectPatch(
      page,
      [
        // Free canvas below the video zone (the workflow-shell-video.spec.ts
        // coordinates) — lane membership is irrelevant to this spec.
        { id: SRC, type: 'lines', position: { x: -1200, y: 4500 } },
        { id: NODE, type: 'backdraft', position: { x: -700, y: 4500 } },
      ],
      [
        {
          id: 'e-in',
          from: { nodeId: SRC, portId: 'out' },
          to: { nodeId: NODE, portId: 'in_a' },
          sourceType: 'mono-video',
          targetType: 'video',
        },
      ],
    );
  });

  test('the REAL button resets settings to defaults and touches nothing patched', async ({ page }) => {
    test.setTimeout(CASE_MS);
    const fv = await openFace(page);

    // SCREEN off through the REAL toggle first, so the spec can prove panic
    // leaves the owner's neighbouring button alone (screen-on/off is VIEW
    // state, not a setting).
    await fv.getByTestId('backdraft-preview-toggle').click();
    await expect(fv.getByTestId('backdraft-preview-toggle')).toHaveText('SCREEN OFF');

    await twiddle(page);
    const before = await readNode(page);
    expect(before.params.mix, 'fixture twiddled (doc units)').toBe(0.1);
    expect(before.edgeIn, 'fixture cable present').not.toBeNull();

    // PANIC sits directly ABOVE the screen toggle (the owner's placement).
    const panic = fv.getByTestId('backdraft-panic');
    const screenBox = await fv.getByTestId('backdraft-preview-toggle').boundingBox();
    const panicBox = await panic.boundingBox();
    expect(panicBox!.y + panicBox!.height, 'PANIC above SCREEN (CSS px)').toBeLessThanOrEqual(
      screenBox!.y + 1,
    );

    await panic.click();

    await expect
      .poll(async () => (await readNode(page)).params.mix, { message: 'mix back to default (doc units)' })
      .toBe(0.5);
    const after = await readNode(page);
    expect(after.params.zoom, 'zoom back to default').toBe(1);
    expect(after.params.rotate, 'rotate back to default').toBe(0);
    expect(after.params.mirrorX, 'mirrorX back to default').toBe(0);
    expect(after.params.tvMode, 'tvMode back to default').toBe(0);

    // Nothing patched changed: same cable, same endpoints.
    expect(after.edgeIn, 'the patch cable is untouched').toEqual(before.edgeIn);
    // Layout / membership untouched.
    expect(after.position, 'position untouched (flow units)').toEqual(before.position);
    // The neighbouring SCREEN state is view state, not a setting.
    expect(after.previewCollapsed, 'screen-on/off untouched').toBe(true);
    await expect(fv.getByTestId('backdraft-preview-toggle')).toHaveText('SCREEN OFF');
  });

  test('PANIC is on screen in EVERY dock tab (above SCREEN, which is why)', async ({ page }) => {
    test.setTimeout(CASE_MS);
    const fv = await openFace(page);
    const tabs = fv.locator('[data-testid^="faceplate-tab-"]');
    const n = await tabs.count();
    expect(n, 'the face paints a tab rail').toBeGreaterThan(1);
    for (let i = 0; i < n; i++) {
      await tabs.nth(i).click();
      await expect(fv.getByTestId('backdraft-panic'), `tab ${i} still shows PANIC`).toBeVisible();
      await expect(fv.getByTestId('backdraft-preview-toggle'), `tab ${i} still shows SCREEN`).toBeVisible();
    }
  });

  test('the panic GATE fires the same reset (deterministic bridge-replay seam)', async ({ page }) => {
    test.setTimeout(CASE_MS);
    await twiddle(page);
    expect((await readNode(page)).params.zoom, 'fixture twiddled (doc units)').toBe(1.5);

    // Replay exactly what installGateDispatch delivers for one counted rising
    // edge: setParam(0); setParam(1) — the freezeframe driveGateFrames seam.
    const fired = await page.evaluate((id) => {
      const w = globalThis as unknown as {
        __engine?: () => {
          getDomain: (d: string) => {
            getNodeHandle: (id: string) => {
              setParam: (p: string, v: number) => void;
              read?: (k: string) => unknown;
            } | null;
          };
        };
      };
      const handle = w.__engine?.().getDomain('video').getNodeHandle(id);
      if (!handle) return { ok: false, panicCount: -1 };
      handle.setParam('panicGate', 0);
      handle.setParam('panicGate', 1);
      handle.setParam('panicGate', 0);
      return { ok: true, panicCount: (handle.read?.('panicCount') as number | undefined) ?? -1 };
    }, NODE);
    expect(fired.ok, 'live handle reachable').toBe(true);
    expect(fired.panicCount, 'exactly one rising edge acted on (edges)').toBe(1);

    await expect
      .poll(async () => (await readNode(page)).params.zoom, { message: 'gate reset zoom to default (doc units)' })
      .toBe(1);
    const after = await readNode(page);
    expect(after.params.mix, 'gate reset mix').toBe(0.5);
    expect(after.params.tvMode, 'gate reset tvMode').toBe(0);
    expect(after.edgeIn, 'the patch cable is untouched').not.toBeNull();
  });
});
