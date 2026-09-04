// e2e/tests/video-hide-controls.spec.ts
//
// MONITOR MODE + the PatchPanel corner-trigger cascade, on the DEFAULT shell.
//
// ⚠ HISTORY (#2009): this file used to carry a parameterised LEGACY suite
// driving `<type>-card` / `-hide-toggle` / `-resize-handle` on
// `?shell=legacy`, plus a videoOut CARD-resize regression pair, with the FACED
// monitor-mode leg below added precisely because promotion could remove the
// gesture from the shipping surface while the legacy suite stayed green ("the
// gate whose precondition is the defect"). S2 removes the legacy lane, and
// with it the card-only halves died:
//
//   * hide-controls + free resize on the CARDS (ruttetra/monoglitch): the
//     STATE key (`node.data.hideControls`) is shared, and BOTH the toggle and
//     the corner drag survive on the faceplate — the faced legs below drive
//     `<type>-face-resize-handle` over the same monitor-box constants — so the
//     card legs were the same gesture on a dead surface.
//   * the videoOut CARD resize pair (`data.width`/`data.height` via the card's
//     corner handle + the inner-canvas aspect-fit): the card died; the shared
//     `card-resize.ts` seam and the same persisted keys keep their coverage on
//     the bentbox FACE resize (bentbox.spec.ts, drain 25).
//
// What remains here is everything with a shell surface:
//   * MONITOR MODE on the faced dock (#2009) — ruttetra / monoglitch /
//     reshaper / milkdrop (see the roster note below; milkdrop has no VRT
//     scene, so this file and faces-parity are what see its face render);
//   * the PatchPanel corner-trigger dblclick → port cascade, on the lane TILE
//     (ModuleShell mounts the same PatchPanel lane rail the cards carried).

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

async function readNodeData(page: Page, id: string): Promise<NodeDataShape> {
  return page.evaluate((nid) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: NodeDataShape }> };
    };
    return (w.__patch.nodes[nid]?.data ?? {}) as NodeDataShape;
  }, id);
}

// ⚠ RETIRED (S2): 'dblclick a PatchPanel corner-trigger opens the port
// cascade'. The shortcut it guarded — dblclick a `.patch-trigger` CORNER
// trigger → the module's first output's "patch to" cascade (#767,
// triggerInfoFromEvent in Canvas.svelte) — was CARD chrome: the corner-trigger
// markup is PatchPanel's card variant, and both shell surfaces mount the
// LANE-RAIL variant, whose trigger (class `jacks-trigger`, measured) the
// dblclick resolver never matches and whose SINGLE click already opens the
// drill-down panel — a strictly shorter path than the dance the shortcut
// existed to bypass. The cascade itself keeps shell coverage where its shell
// gestures live: the rear back-jack menus (unpatch-patch-point.spec.ts) and
// the drag drill-down (cable-drag-drilldown.spec.ts). `triggerInfoFromEvent`
// dies with the legacy cards.

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
        // ⚠ FREE CANVAS (x < 0), NOT (240, 4500). That spot sits inside the
        // VIDEO ZONE (slot 0 spans x≈22..382 from COLUMN_BASELINE_Y=4320), and
        // since #2247 wired the EXTENDED ensure the zone actually populates
        // with the seeded videoOut/recorderbox/synesthesia tiles — whose
        // locked cards then sit over the injected tile and intercept every
        // click on its dock button. Measured: `shell-open-dock` timed out with
        // "workflow-recorderbox … subtree intercepts pointer events" on a
        // clean origin/main (936fdcc), so this was a fixture collision
        // shipped by the zone change, invisible until the next real-GPU
        // attest ran this file. Same free-canvas convention as
        // workflow-shell-video.spec.ts / backdraft-panic.spec.ts.
        w.__patch.nodes[id] = {
          id, type, domain: 'video', position: { x: -700, y: 4500 }, params: {},
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
