// e2e/tests/video-hide-controls.spec.ts
//
// ⚠ SCOPE — READ THIS BEFORE TRUSTING A GREEN RUN (#2009).
//
// The parameterised suite below drives the LEGACY LANE and only the legacy
// lane: it navigates to `/rack?shell=legacy&seed=none` (`:129`) and asserts
// against `<type>-card` / `-hide-toggle` / `-resize-handle`, which are
// `RuttetraCard.svelte` / `MonoglitchCard.svelte`. Those cards keep rendering
// on `?shell=legacy` whether or not their module is promoted, so PROMOTION
// DOES NOT REDDEN ANY OF IT.
//
// That is exactly the wrong kind of green, and it was filed as such. Without a
// second leg this whole file would keep passing at full green WHILE THE
// GESTURE DISAPPEARED from the surface a workflow-mode user actually operates
// — the "gate whose precondition is the defect" class, where promotion removes
// the thing under test from the only surface that matters and every assertion
// survives because it was pointed somewhere else.
//
// So RUTTETRA — the first module to carry MONITOR MODE onto its faceplate —
// has a FACED leg at the bottom of this file, and it is deliberately in the
// same file as its legacy sibling so the two can never drift apart unnoticed.
//
// MONOGLITCH joined it on promotion (2026-08-21), which is what this note used
// to ask for: *"MONOGLITCH is still un-faced; when it is promoted its faced leg
// belongs here too."* ⚠ AND THE FACED LEG IS PARAMETERISED OVER A ROSTER, the
// same shape the LEGACY suite above already uses, rather than copied per
// module. Two hand-copied 80-line browser tests is how the two surfaces of one
// affordance drift; one roster is how the next of the five #2009 cards is added
// by writing four testids — which is exactly what `reshaper` cost (2026-08-21).
//
// Of the five that mount `hideControls`: `ruttetra`, `monoglitch`, `reshaper`
// and `milkdrop` are faced and covered here; `graphicEq` is the last one queued.
//
// ⚠ MILKDROP MATTERS MOST IN THIS FILE, and the reason is worth carrying at the
// top rather than only beside its roster entry. It was BLOCKED (#2083) — never
// on parity, which maps cleanly and hash-free, but on the FACES VRT roster,
// which was deny-by-default set-equality with no exemption while butterchurn is
// not pixel-deterministic even at a fixed frame count. It ships with a named
// `FACES_WITHOUT_SCENES` entry instead, which means NOTHING COMPARES ITS
// FACEPLATE'S PIXELS at any tier. This leg and `faces-parity` are what see its
// dock face render at all, so weakening either one silently un-covers it.
// `face-monitor-source.test.ts` turns RED at any such promotion if the face
// does not declare `monitor` at all — this file is what proves the declaration
// actually moves the bands.
//
// ── the LEGACY suite ───────────────────────────────────────────────────────
//
// Verifies the hide-controls + free-resize gesture on RUTTETRA + MONOGLITCH:
//   1. Click the hide-toggle - controls hide, canvas remains, card becomes
//      resizable via the corner handle.
//   2. Drag the corner handle - card grows, node.data.resizedWidth/height
//      update.
//   3. Double-click the card body - hide-controls clears + size resets.
// Also asserts:
//   - OUTPUT (videoOut) keeps its existing always-resizable behavior
//     (regression on PR-85 / VideoOutCard's data.width / data.height path).
//   - Double-clicking on a .svelte-flow__handle inside the card still
//     reaches the document-level patch-to listener (PR-113 regression).

import { test, expect } from './_fixtures';
import { type Locator, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { waitFrames } from '../_helpers/frames';

interface NodeDataShape {
  hideControls?: boolean;
  resizedWidth?: number;
  resizedHeight?: number;
  width?: number;
  height?: number;
}

async function readNodeData(page: Page, id: string): Promise<NodeDataShape> {
  return page.evaluate((nid) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: NodeDataShape }> };
    };
    return (w.__patch.nodes[nid]?.data ?? {}) as NodeDataShape;
  }, id);
}

async function clickHideToggle(page: Page, testid: string): Promise<void> {
  const btn = page.locator(`[data-testid="${testid}"]`);
  await expect(btn, `${testid} present`).toBeVisible();
  await btn.click();
}

async function expectControlsHidden(page: Page, controlsTestid: string): Promise<void> {
  await expect(
    page.locator(`[data-testid="${controlsTestid}"]`),
    `${controlsTestid} hidden`,
  ).toHaveCount(0);
}

async function dragCorner(
  page: Page,
  handleTestid: string,
  dx: number,
  dy: number,
): Promise<void> {
  const handle = page.locator(`[data-testid="${handleTestid}"]`);
  await expect(handle).toBeVisible();
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;
  const sx = box.x + box.width / 2;
  const sy = box.y + box.height / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + dx / 2, sy + dy / 2, { steps: 5 });
  await page.mouse.move(sx + dx, sy + dy, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(150);
}

async function cardBoundingSize(
  page: Page,
  cardTestid: string,
): Promise<{ width: number; height: number }> {
  return page.locator(`[data-testid="${cardTestid}"]`).evaluate((el) => {
    const r = (el as HTMLElement).getBoundingClientRect();
    return { width: r.width, height: r.height };
  });
}

interface ModuleSpec {
  type: 'ruttetra' | 'monoglitch';
  cardTestid: string;
  toggleTestid: string;
  resizeTestid: string;
  controlsTestid: string;
  canvasTestid: string;
}

const MODULES: ModuleSpec[] = [
  {
    type: 'ruttetra',
    cardTestid: 'ruttetra-card',
    toggleTestid: 'ruttetra-hide-toggle',
    resizeTestid: 'ruttetra-resize-handle',
    controlsTestid: 'ruttetra-controls',
    canvasTestid: 'ruttetra-canvas',
  },
  {
    type: 'monoglitch',
    cardTestid: 'monoglitch-card',
    toggleTestid: 'monoglitch-hide-toggle',
    resizeTestid: 'monoglitch-resize-handle',
    controlsTestid: 'monoglitch-controls',
    canvasTestid: 'monoglitch-canvas',
  },
];

for (const m of MODULES) {
  test.describe(`${m.type.toUpperCase()} - hide-controls + free resize`, () => {
    test('hide -> resize -> dblclick restore', async ({ page }) => {
      // RUTTETRA renders a 320×180 LINE grid (~57k grid points) into its
      // on-card preview every animation frame — by far the heaviest
      // per-frame GL work in the suite. On a loaded CI runner that draw loop
      // starves the main thread, so the multi-step corner-resize drag
      // (page.mouse.move with {steps:5}, twice) can take several seconds per
      // move (~3.5s each was observed on shard 8/8), pushing the whole test
      // past the default 30s budget even though every assertion ultimately
      // passes. Give the heavy-WebGL cards the same headroom the video/DOOM
      // specs already grant (picturebox-limits, multi-video, etc.). Cheap
      // fullscreen-quad cards (MONOGLITCH) finish well under this.
      test.setTimeout(60_000);

      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (msg) => {
        if (msg.type() === 'error') errors.push(msg.text());
      });

      await page.goto('/rack?shell=legacy&seed=none');
      await page.waitForLoadState('networkidle');

      await spawnPatch(page, [
        { id: 'v', type: m.type, position: { x: 200, y: 100 }, domain: 'video' },
      ]);

      const card = page.locator(`[data-testid="${m.cardTestid}"]`);
      await expect(card).toHaveCount(1);
      await expect(
        page.locator(`[data-testid="${m.controlsTestid}"]`),
        'controls visible by default',
      ).toBeVisible();
      await expect(
        page.locator(`[data-testid="${m.canvasTestid}"]`),
        'canvas visible by default',
      ).toBeVisible();
      await expect(
        page.locator(`[data-testid="${m.resizeTestid}"]`),
        'resize handle absent by default',
      ).toHaveCount(0);

      await clickHideToggle(page, m.toggleTestid);

      await expectControlsHidden(page, m.controlsTestid);
      await expect(
        page.locator(`[data-testid="${m.canvasTestid}"]`),
        'canvas still visible in hide-controls mode',
      ).toBeVisible();
      await expect(
        page.locator(`[data-testid="${m.resizeTestid}"]`),
        'resize handle appears in hide-controls mode',
      ).toBeVisible();
      const dataAfterHide = await readNodeData(page, 'v');
      expect(dataAfterHide.hideControls, 'hideControls flagged true').toBe(true);

      const sizeBeforeDrag = await cardBoundingSize(page, m.cardTestid);
      await dragCorner(page, m.resizeTestid, 200, 150);
      const sizeAfterDrag = await cardBoundingSize(page, m.cardTestid);
      expect(
        sizeAfterDrag.width,
        `card grew (${sizeBeforeDrag.width} -> ${sizeAfterDrag.width})`,
      ).toBeGreaterThan(sizeBeforeDrag.width + 20);
      expect(
        sizeAfterDrag.height,
        `card grew (${sizeBeforeDrag.height} -> ${sizeAfterDrag.height})`,
      ).toBeGreaterThan(sizeBeforeDrag.height + 20);

      const dataAfterDrag = await readNodeData(page, 'v');
      expect(dataAfterDrag.resizedWidth, 'resizedWidth persisted').toBeGreaterThan(360);
      expect(dataAfterDrag.resizedHeight, 'resizedHeight persisted').toBeGreaterThan(240);

      // Double-click on the card body (not on a handle) to restore.
      await card.dblclick({ position: { x: 30, y: 80 } });
      await page.waitForTimeout(120);

      const dataAfterRestore = await readNodeData(page, 'v');
      expect(dataAfterRestore.hideControls, 'hideControls cleared').toBeFalsy();
      expect(dataAfterRestore.resizedWidth, 'resizedWidth cleared').toBeUndefined();
      expect(dataAfterRestore.resizedHeight, 'resizedHeight cleared').toBeUndefined();

      await expect(
        page.locator(`[data-testid="${m.controlsTestid}"]`),
        'controls back after restore',
      ).toBeVisible();

      expect(errors).toEqual([]);
    });
  });
}

test.describe('OUTPUT regression', () => {
  test('videoOut keeps existing data.width/data.height resize behavior', async ({ page, rack }) => {
    await spawnPatch(page, [
      { id: 'v-out', type: 'videoOut', position: { x: 200, y: 100 }, domain: 'video' },
    ]);

    const card = page.locator('[data-testid="video-out-card"]');
    await expect(card).toHaveCount(1);
    await expect(page.locator('[data-testid="video-out-resize-handle"]')).toBeVisible();
    // OUTPUT should NOT have a hide-toggle button (it's already minimal).
    await expect(page.locator('[data-testid="video-out-hide-toggle"]')).toHaveCount(0);

    const before = await cardBoundingSize(page, 'video-out-card');
    await dragCorner(page, 'video-out-resize-handle', 180, 120);
    const after = await cardBoundingSize(page, 'video-out-card');
    expect(after.width).toBeGreaterThan(before.width + 20);
    expect(after.height).toBeGreaterThan(before.height + 20);

    const data = await readNodeData(page, 'v-out');
    expect(data.width, 'OUTPUT still uses node.data.width').toBeGreaterThanOrEqual(360);
    expect(data.height, 'OUTPUT still uses node.data.height').toBeGreaterThanOrEqual(240);
    expect(data.resizedWidth, 'OUTPUT does NOT use new resizedWidth key').toBeUndefined();
  });

  // Folded in from video-output-resize.spec.ts (consolidation §2): the corner-drag
  // resize itself is the dup the test above already covers (same dragCorner +
  // node.data.width/height); the UNIQUE leg is that after a known size is forced,
  // the INNER canvas dimensions follow the card (aspect-fit, not collapsed to 0).
  // We set the size directly via patch mutation (skip the drag) so the aspect-fit
  // math is testable independent of the drag harness.
  test('inner canvas keeps aspect-fit after resize (engine 4:3)', async ({ page, rack }) => {
    await spawnPatch(page, [
      { id: 'v-out', type: 'videoOut', position: { x: 200, y: 100 }, domain: 'video' },
    ]);
    await expect(page.locator('[data-testid="video-out-card"]')).toHaveCount(1);

    // Force a known size via direct patch mutation (skip the drag) so
    // the aspect-fit math is testable independent of the drag harness.
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['v-out'];
        if (!n) return;
        if (!n.data) n.data = {};
        n.data.width = 800;
        n.data.height = 480;
      });
    });
    await page.waitForTimeout(150);

    const inner = await page.evaluate(() => {
      const c = document.querySelector('canvas[data-testid="video-out-canvas"]') as HTMLCanvasElement | null;
      if (!c) return null;
      // The aspect inside the card should be 4:3 (engine resolution),
      // but the canvas-wrap simply takes (width - PAD, height - HEADER).
      // We check it's CLOSE to that size and not collapsed to 0.
      return { width: c.width, height: c.height };
    });
    expect(inner).not.toBeNull();
    if (!inner) return;
    expect(inner.width, 'inner canvas width follows card width').toBeGreaterThan(700);
    expect(inner.height, 'inner canvas height follows card height').toBeGreaterThan(380);
  });
});

test.describe('dblclick a PatchPanel corner-trigger opens the port cascade', () => {
  // Every video card was migrated onto the yellow PatchPanel (#767), so the
  // dblclick→"patch to" cascade is now reached via a corner PATCH-TRIGGER
  // (triggerInfoFromEvent in Canvas.svelte → resolves to the module's first
  // output), NOT a raw <Handle> — no card exposes raw source jacks anymore.
  // (Was: a chroma raw-handle fixture, which the #767 sweep orphaned when
  // chroma itself moved to the PatchPanel; that stale assertion failed ONLY on
  // the real-GPU attest lane, silently blocking every lib/video re-attest.)
  // The drag-to-patch drill-down is covered by cable-drag-drilldown.spec; THIS
  // guards the dblclick→port-menu shortcut, which no other spec exercises.
  test('dblclick on a PatchPanel corner-trigger opens the port menu', async ({ page, rack }) => {
    await spawnPatch(page, [
      { id: 'c', type: 'chroma', position: { x: 200, y: 100 }, domain: 'video' },
      { id: 'l', type: 'lines', position: { x: 600, y: 100 }, domain: 'video' },
    ]);

    const card = page.locator('.svelte-flow__node-chroma');
    await expect(card).toHaveCount(1);

    // The output-side corner trigger (right); a dblclick resolves to the
    // module's first output and opens the "patch to" cascade.
    const trigger = card.locator('[data-testid="patch-trigger-right"]').first();
    await expect(trigger).toBeVisible();
    await trigger.dblclick();

    await expect(
      page.locator('[data-testid="port-context-menu"]'),
      'port-to cascade opened from PatchPanel corner-trigger dblclick',
    ).toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE FACED LEG (#2009) — MONITOR MODE on the workflow-shell dock faceplate.
//
// This is the half the suite above structurally cannot see. Promotion swaps
// BOTH surfaces from `RuttetraCard.svelte` to `<ModuleShell>`, so on the
// faceplate the gesture is a different mechanism entirely:
//
//   * the STATE is the same persisted `node.data.hideControls` key (shared on
//     purpose — a rack saved from the legacy card must reopen the same way);
//   * the TOGGLE lives on the module's own `fullViewBody` extension;
//   * the SUPPRESSION is the shell's (`faceMonitorPlan`), because
//     `fullViewBody` paints ABOVE the bands and by contract cannot hide them.
//
// ⚠ THE ASSERTIONS THAT MATTER MOST ARE THE ONES ABOUT WHAT REMAINS. Hiding
// the bands is only an improvement while something else is still painting, and
// the way BACK is a button on that surface. A spec that only asserted the
// disappearance would pass just as happily on a blank plate — which is the
// failure this mode is one edit away from at all times.

/** One faced adopter of MONITOR MODE.
 *
 *  ⚠ `pageIds` IS A ROSTER OF NAMES, NOT A COUNT. It is compared against the
 *  `data-face-page` attributes the shell actually emits, so a renamed or
 *  dropped band is RED here and a re-ordered face is RED here — none of which a
 *  bare `toHaveCount(n)` can see, and it carries no number to go stale. */
interface FacedSpec {
  type: string;
  nodeId: string;
  pageIds: string[];
}

const FACED: FacedSpec[] = [
  // The module that proved the seam (#2009 / #2053): one page per expression of
  // the scan shader.
  { type: 'ruttetra', nodeId: 'rt-face', pageIds: ['relief', 'shape', 'scan', 'beam'] },
  // The first inheritor (2026-08-21): one page per TERM of the glitch shader.
  { type: 'monoglitch', nodeId: 'mg-face', pageIds: ['lift', 'raster', 'pan', 'tint'] },
  // The third adopter (2026-08-21): one page per shader stage that HAS params —
  // the ramp stage is cables only, so it ranks nothing.
  { type: 'reshaper', nodeId: 'rs-face', pageIds: ['warp', 'colour'] },
  // ⚠ MILKDROP MATTERS MOST HERE (2026-08-21). It is the ONE faced module with
  // no VRT scenes at all — butterchurn is not pixel-reproducible, so it carries
  // a named `FACES_WITHOUT_SCENES` exemption (#2083). Nothing compares its
  // faceplate's pixels at any tier, which makes this leg and faces-parity the
  // only things that see its dock face render at all.
  { type: 'milkdrop', nodeId: 'mk-face', pageIds: ['preset', 'motion'] },
];

// ⚠ RENDERER-DEPENDENT, the capability-dependent class. Both tests boot the
// workflow shell and a real GL chain, and CI is SwiftShader (measured repo-wide
// at ~7.9 fps against ~60) with ten shards in parallel on top. Same knob and
// same shape as backdraft-preview-toggle.spec.ts.
const SLOW_RENDER = process.env.E2E_SWIFTSHADER === '1' || !!process.env.CI;
const FACE_CASE_MS = SLOW_RENDER ? 120_000 : 45_000;

/** ⚠ ADD to the live patch, never `spawnPatch`. `spawnPatch` CLEARS the rack,
 *  which nukes the workflow rack's seeded video-zone defaults — including the
 *  auto-spawned `videoOut` that PULLS the chain, so nothing renders at all.
 *  Same warning and same reason as backdraft-preview-toggle.spec.ts, where the
 *  first draft's positive control failed for exactly this: a broken FIXTURE
 *  that reads precisely like a broken feature. */
async function addNode(page: Page, id: string, type: string): Promise<void> {
  await page.waitForFunction(() => {
    const w = globalThis as unknown as { __ensureEngine?: () => Promise<unknown> };
    return typeof w.__ensureEngine === 'function';
  });
  await page.evaluate(async () => {
    const w = globalThis as unknown as { __ensureEngine: () => Promise<unknown> };
    await w.__ensureEngine();
  });
  await page.evaluate(
    ({ id, type }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, unknown> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        w.__patch.nodes[id] = {
          id, type, domain: 'video', position: { x: 240, y: 4500 }, params: {},
        };
      });
    },
    { id, type },
  );
  await page.waitForFunction(
    (n) => document.querySelector(`.svelte-flow__node[data-id="${n}"]`) !== null,
    id,
    { timeout: 15_000 },
  );
}

/** Bring a node into the viewport. The lane band sits at y≈4500 in flow space,
 *  so without this the tile is off-screen, every click times out, and the video
 *  visibility gate never ARMS. */
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
      // Upper QUARTER, not the centre: the dock full view opens over the lower
      // half of the pane and would cover a centred tile.
      w.__flow.setViewport({ x: r.width / 2 - cx * zoom, y: r.height / 4 - cy * zoom, zoom }, { duration: 0 });
    },
    { nodeId, zoom },
  );
  await waitFrames(page, 4);
}

async function gotoShell(page: Page): Promise<void> {
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 30_000 });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

/** Open a node's dock faceplate and return the full-view locator. */
async function openFace(page: Page, nodeId: string): Promise<Locator> {
  await centerOnNode(page, nodeId);
  const shell = page.locator(`.svelte-flow__node[data-id="${nodeId}"] [data-testid="module-shell"]`);
  await expect(shell, `${nodeId} renders a faceplate shell, not a legacy card`).toBeVisible();
  await shell.getByTestId('shell-open-dock').click();
  const fv = page.getByTestId('dock-full-view');
  await expect(fv).toBeVisible();
  return fv;
}

test.describe('MONITOR MODE on the FACED dock (#2009)', () => {
  for (const m of FACED) {
    test(`${m.type} — hide the bands, keep the picture, and the way back is still on screen`, async ({ page }) => {
      test.setTimeout(FACE_CASE_MS);
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));

      await gotoShell(page);
      await addNode(page, m.nodeId, m.type);
      const fv = await openFace(page, m.nodeId);

      const shellRoot = fv.locator('[data-testid="module-shell"]').first();
      const bands = fv.getByTestId('face-pages');
      const pages = fv.locator('[data-face-page]');
      const canvas = fv.getByTestId(`${m.type}-face-canvas`);
      const monitorBtn = fv.getByTestId(`${m.type}-face-monitor-toggle`);
      const screenBtn = fv.getByTestId(`${m.type}-face-screen-toggle`);
      const handle = fv.getByTestId(`${m.type}-face-resize-handle`);

      // ── AT REST: the ordinary faceplate ──────────────────────────────────
      // ⚠ `data-face-monitor="off"` and ABSENT are DIFFERENT states, and the
      // distinction is load-bearing: absent means the face declares no monitor
      // mode at all (asserted of a sibling in the negative control below).
      // "off" is the only correct resting value here.
      await expect(shellRoot, 'the face DECLARES monitor mode, and it is off at rest')
        .toHaveAttribute('data-face-monitor', 'off');
      await expect(bands, 'the control bands paint at rest').toBeVisible();
      // ⚠ THE BAND IDS, NOT A COUNT — so a renamed, dropped or re-ordered page
      // is red here, and there is no number to go stale. `expect.poll` because
      // the bands are rendered from an async-resolved plan; a bare read races
      // the first paint on a loaded runner.
      await expect
        .poll(
          () => pages.evaluateAll((els) => els.map((e) => e.getAttribute('data-face-page'))),
          { message: `${m.type} paints exactly its declared bands, in order` },
        )
        .toEqual(m.pageIds);
      await expect(canvas, 'and so does the picture').toBeVisible();
      await expect(monitorBtn).toBeVisible();
      await expect(screenBtn, 'the SCREEN switch is a SEPARATE control, not this one').toBeVisible();
      await expect(handle, 'resize handle absent until monitor mode — same as the card')
        .toHaveCount(0);

      // ── MONITOR ON ───────────────────────────────────────────────────────
      await monitorBtn.click();

      await expect(shellRoot).toHaveAttribute('data-face-monitor', 'on');
      await expect(bands, 'the control bands are GONE — the whole affordance').toHaveCount(0);
      // ⚠ THE THREE THAT MUST SURVIVE.
      await expect(canvas, 'the PICTURE still paints — otherwise this is a blank plate')
        .toBeVisible();
      await expect(monitorBtn, 'and the way BACK is still on screen').toBeVisible();
      await expect(handle, 'the corner drag arrives with the mode').toBeVisible();

      const hidden = await readNodeData(page, m.nodeId);
      expect(hidden.hideControls, 'over the SAME persisted key the legacy card writes').toBe(true);

      // ── THE CORNER DRAG ──────────────────────────────────────────────────
      const before = await canvas.boundingBox();
      expect(before).not.toBeNull();
      await dragCorner(page, `${m.type}-face-resize-handle`, 160, 120);
      const after = await canvas.boundingBox();
      expect(after).not.toBeNull();
      expect(
        after!.width,
        `the monitor grew (${before?.width} -> ${after?.width} CSS px)`,
      ).toBeGreaterThan(before!.width + 20);

      // ⚠ COMPARED AGAINST THE PICTURE'S OWN STARTING WIDTH, not a re-typed
      // floor. Both adopters happen to share `minW`/`minH` today, and writing
      // the number here would be a third copy of a constant the def already
      // owns (`<MOD>_MONITOR_BOX`) — the exact divergence that constant exists
      // to prevent.
      const sized = await readNodeData(page, m.nodeId);
      expect(sized.resizedWidth, "resizedWidth persisted — the card's own key")
        .toBeGreaterThan(before!.width);
      expect(sized.resizedHeight, 'resizedHeight persisted').toBeGreaterThan(0);

      // ── MONITOR OFF, from the button that turned it on ───────────────────
      // ⚠ NO DOUBLE-CLICK RESCUE IS NEEDED OR OFFERED, and that is a FIX rather
      // than a dropped affordance. On the CARD the toggle sits INSIDE the region
      // it hides, so `ondblclick` on the body is the only way back — a
      // pointer-only trap the card's own source calls out by name. Here the
      // extension body always paints, so the button that turned monitor mode on
      // is the button that turns it off.
      await monitorBtn.click();
      await expect(shellRoot).toHaveAttribute('data-face-monitor', 'off');
      await expect(bands, 'the bands come back').toBeVisible();
      await expect
        .poll(
          () => pages.evaluateAll((els) => els.map((e) => e.getAttribute('data-face-page'))),
          { message: 'and they are the SAME bands, not merely the same number of them' },
        )
        .toEqual(m.pageIds);

      const restored = await readNodeData(page, m.nodeId);
      expect(restored.hideControls, 'hideControls cleared').toBeFalsy();
      expect(restored.resizedWidth, "and the size with it, exactly as the card's restore does")
        .toBeUndefined();
      expect(restored.resizedHeight).toBeUndefined();

      expect(errors).toEqual([]);
    });
  }

  test("NEGATIVE CONTROL: a stale hideControls cannot blank a face that declares no monitor", async ({ page }) => {
    // ⚠ THE FAILURE MODE THE DECLARATION GATE EXISTS FOR, exercised end to end
    // rather than argued in a comment. `hideControls` is persisted and
    // collab-synced, so a rack saved from ANY legacy card can hand this flag to
    // a faceplate whose face never declared monitor mode. If the shell read the
    // flag alone, that patch would open a faceplate with no bands — and on a
    // face with no extension body, with nothing at all.
    //
    // `grainsOfVision` is the right subject twice over: a FACED video module
    // with a full `fullViewBody` and SCREEN switch and NO `face.monitor`, and
    // the module #1865 would have swept up by claiming SCREEN subsumes this.
    test.setTimeout(FACE_CASE_MS);
    await gotoShell(page);
    await addNode(page, 'gov-face', 'grainsOfVision');

    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['gov-face'];
        if (!n) return;
        if (!n.data) n.data = {};
        n.data.hideControls = true;
      });
    });

    const fv = await openFace(page, 'gov-face');
    const shellRoot = fv.locator('[data-testid="module-shell"]').first();

    // ABSENT, not "off": this face declares no monitor mode, so the shell emits
    // no attribute at all. That absence is what keeps every un-adopting
    // faceplate's DOM — and therefore its dock VRT baseline — byte-identical.
    await expect(shellRoot, 'no monitor mode is declared, so no attribute is emitted')
      .not.toHaveAttribute('data-face-monitor', /.*/);
    await expect(fv.getByTestId('face-pages'), 'and the bands paint regardless of the stale flag')
      .toBeVisible();

    // The flag is still ON the node — the shell IGNORED it rather than clearing
    // it, so the legacy card's meaning of the key is untouched.
    const data = await readNodeData(page, 'gov-face');
    expect(data.hideControls, 'the key is untouched, merely inert here').toBe(true);
  });
});
