// e2e/tests/backdraft-preview-toggle.spec.ts
//
// THE PREVIEW ON/OFF TOGGLE on backdraft's faceplate (owner review round 1):
// *"the screen preview on the card should have an on/off button and when it's
// off it collapses so we reclaim the vertical space. that on/off persists
// through tab switches"*.
//
// ⚠ WHY THIS SPEC EXISTS RATHER THAN A SCREENSHOT. The dangerous half of a
// collapse is INVISIBLE in pixels: collapsing a view that also owns a producer
// tears the producer down, and the picture then comes back BLACK or STALE. That
// class has shipped twice recently — #1721 (collapsing a GROUP killed a
// CARD_PRODUCER pump, in both shells) and #1728 (collapsing the card blanked the
// physical Launchpad and dropped the device claim) — and it is the
// card-unmount-kills-node-lifetime-state family (#1531 / #1574 / #1583). A VRT
// baseline of a collapsed panel would be green for all of it.
//
// So the assertions here are about the PRODUCER and the STATE, not the look:
// the space is really reclaimed, the engine keeps advancing while collapsed,
// the picture is LIVE (moving, not merely non-black) after switching back on,
// and the choice survives a tab switch.

import { test, expect, type Page } from '@playwright/test';
import { waitFrames } from '../_helpers/frames';

const NODE = 'bd';

/**
 * ⚠ ADD to the live patch, never `spawnPatch`. `spawnPatch` CLEARS the rack,
 * which nukes the workflow rack's seeded video-zone defaults — including the
 * auto-spawned `videoOut`. That sink is what PULLS the video chain, so a
 * cleared rack renders nothing at all: measured, `framesDrawnFor('bd')` sat at
 * 0 forever and the preview was black. The first draft of this spec used
 * `spawnPatch` and its positive control failed for that reason — a broken
 * FIXTURE that reads exactly like a broken feature.
 *
 * Same shape as `workflow-shell-video.spec.ts`'s `injectPatch`, which carries
 * the same warning for the same reason.
 */
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

/** Patch the module's OUT into the rack's seeded videoOut, so the chain has a
 *  real sink pulling it. Returns false when no sink exists (the caller skips). */
async function patchToSeededSink(page: Page): Promise<boolean> {
  return page.evaluate((from) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { type?: string } | undefined>; edges: Record<string, unknown> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    const sink = Object.entries(w.__patch.nodes).find(([, n]) => n?.type === 'videoOut')?.[0];
    if (!sink) return false;
    w.__ydoc.transact(() => {
      w.__patch.edges['e-sink'] = {
        id: 'e-sink',
        source: { nodeId: from, portId: 'out' },
        target: { nodeId: sink, portId: 'in' },
        sourceType: 'mono-video',
        targetType: 'video',
      };
    });
    return true;
  }, NODE);
}

async function gotoShell(page: Page): Promise<void> {
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 30_000 });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

/** Bring a node into the viewport. The lane band sits at y≈4500 in flow space,
 *  so without this the tile is off-screen and every click times out — and it
 *  also ARMS the video visibility gate that decides whether the node renders. */
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

/** Open backdraft's dock faceplate and return the full-view locator. */
async function openFace(page: Page) {
  await centerOnNode(page, NODE);
  const shell = page.locator(`.svelte-flow__node[data-id="${NODE}"] [data-testid="module-shell"]`);
  await expect(shell).toBeVisible();
  await shell.getByTestId('shell-open-dock').click();
  const fv = page.getByTestId('dock-full-view');
  await expect(fv).toBeVisible();
  return fv;
}

/** The engine's per-node draw counter — the PRODUCER's own odometer, read from
 *  the page. This is the observable a screenshot cannot reach. */
function framesDrawn(page: Page): Promise<number> {
  return page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => { getDomain: (d: string) => { framesDrawnFor: (id: string) => number } };
    };
    try {
      return w.__engine!().getDomain('video').framesDrawnFor(id);
    } catch {
      return -1;
    }
  }, NODE);
}

/**
 * Sample the preview canvas across real frames IN THE PAGE and report whether
 * it MOVED — never a Playwright poll loop, which is one round-trip per sample
 * on the same main thread as the subject and cannot tell "frozen" from "never
 * looked" (CLAUDE.md, VALIDATE THE INSTRUMENT).
 *
 * ⚠ MOVEMENT, not non-blackness. A producer can come back bright AND FROZEN —
 * a blackness check calls that healthy, which is exactly how this defect class
 * keeps shipping.
 */
async function previewMoves(page: Page, frames: number): Promise<{ moved: boolean; distinct: number }> {
  return page.evaluate(async (n: number) => {
    const c = document.querySelector(
      '[data-testid="backdraft-face-output"] canvas',
    ) as HTMLCanvasElement | null;
    if (!c) return { moved: false, distinct: 0 };
    const seen = new Set<string>();
    for (let i = 0; i < n; i++) {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      try {
        seen.add(c.toDataURL().slice(-96));
      } catch {
        /* a tainted canvas contributes nothing rather than throwing */
      }
    }
    return { moved: seen.size > 1, distinct: seen.size };
  }, frames);
}

test.describe('backdraft faceplate — the preview ON/OFF toggle', () => {
  test.beforeEach(async ({ page }) => {
    await gotoShell(page);
    // A REAL animated source into the feedback loop, so "the picture moves" is
    // a claim about the chain rather than about noise.
    await injectPatch(
      page,
      [
        { id: 'src', type: 'lines', position: { x: -1200, y: 4500 } },
        { id: NODE, type: 'backdraft', position: { x: -700, y: 4500 } },
      ],
      [
        {
          id: 'e1',
          from: { nodeId: 'src', portId: 'out' },
          to: { nodeId: NODE, portId: 'in_a' },
          sourceType: 'mono-video',
          targetType: 'video',
        },
      ],
    );
    // …and a real SINK, without which nothing pulls the chain.
    const sinkOk = await patchToSeededSink(page);
    expect(sinkOk, 'the workflow rack seeds a videoOut to pull the chain').toBe(true);
  });

  test('OFF collapses and RECLAIMS the vertical space; ON restores it', async ({ page }) => {
    const fv = await openFace(page);
    const wrap = fv.locator('[data-testid="backdraft-fs-wrap"]');
    const toggle = fv.getByTestId('backdraft-preview-toggle');

    const row = fv.locator('[data-testid="backdraft-face-output"]');

    await expect(wrap).toHaveAttribute('data-preview-collapsed', 'false');
    const openRowH = (await row.boundingBox())!.height;
    const openPaneH = (await fv.boundingBox())!.height;
    expect(openRowH, 'the preview row has real height while ON (CSS px)').toBeGreaterThan(100);

    await toggle.click();
    await expect(wrap).toHaveAttribute('data-preview-collapsed', 'true');

    // RECLAIMED, NOT MERELY HIDDEN. The OUTPUT ROW is the subject: it must
    // collapse to about the height of its own buttons, which is what taking the
    // picture out of flow buys. `visibility: hidden` would keep the whole box
    // and pass any "is it invisible" check while reclaiming nothing — this is
    // the assertion that tells those two apart.
    const closedRowH = (await row.boundingBox())!.height;
    expect(
      closedRowH,
      `the output row must collapse to roughly its button height — ` +
        `${openRowH}px ON, ${closedRowH}px OFF (CSS px)`,
    ).toBeLessThan(openRowH * 0.35);

    // …and the PANE really is shorter for it. Asserted as a direction, not a
    // magnitude: the pane has its own minimum and the band below it re-flows,
    // so demanding the row's full height back would be asserting a coincidence.
    const closedPaneH = (await fv.boundingBox())!.height;
    expect(
      closedPaneH,
      `the faceplate pane must get shorter — ${openPaneH}px ON, ${closedPaneH}px OFF (CSS px)`,
    ).toBeLessThan(openPaneH);

    await toggle.click();
    await expect(wrap).toHaveAttribute('data-preview-collapsed', 'false');
    expect(
      Math.abs((await fv.boundingBox())!.height - openPaneH),
      'ON restores the original pane height',
    ).toBeLessThan(4);
  });

  test('the choice PERSISTS across a tab switch (the owner\'s stated floor)', async ({ page }) => {
    const fv = await openFace(page);
    const wrap = fv.locator('[data-testid="backdraft-fs-wrap"]');
    await fv.getByTestId('backdraft-preview-toggle').click();
    await expect(wrap).toHaveAttribute('data-preview-collapsed', 'true');

    // Walk the rail: every declared page, derived from the DOM rather than a
    // typed count, so adding or removing a tab cannot make this vacuous.
    const tabs = fv.locator('[data-testid^="faceplate-tab-"]');
    const n = await tabs.count();
    expect(n, 'the face paints a tab rail').toBeGreaterThan(1);
    for (let i = 0; i < n; i++) {
      await tabs.nth(i).click();
      await expect(
        wrap,
        `preview state survives switching to tab ${i + 1}/${n}`,
      ).toHaveAttribute('data-preview-collapsed', 'true');
    }
  });

  test('the choice survives the faceplate being CLOSED and REOPENED (node-keyed, not view-keyed)', async ({
    page,
  }) => {
    // The reason the flag lives on `node.data` and not in the component: this
    // component unmounts on collapse / LRU eviction, and a `$state` would die
    // with it. Stronger than the stated requirement, and deliberately so.
    const fv = await openFace(page);
    await fv.getByTestId('backdraft-preview-toggle').click();
    await expect(fv.locator('[data-testid="backdraft-fs-wrap"]')).toHaveAttribute(
      'data-preview-collapsed',
      'true',
    );

    await fv.getByTestId('faceplate-collapse').click();
    await expect(page.getByTestId('dock-full-view')).toHaveCount(0);

    const again = await openFace(page);
    await expect(
      again.locator('[data-testid="backdraft-fs-wrap"]'),
      'the preview is still OFF after a full unmount + remount',
    ).toHaveAttribute('data-preview-collapsed', 'true');
  });

  test('⚠ COLLAPSING DOES NOT KILL THE PRODUCER — the engine keeps advancing, and the picture comes back LIVE', async ({
    page,
  }) => {
    const fv = await openFace(page);
    const wrap = fv.locator('[data-testid="backdraft-fs-wrap"]');
    const toggle = fv.getByTestId('backdraft-preview-toggle');

    // POSITIVE CONTROL first: the picture genuinely moves while ON. Without
    // this leg the "it moves again" assertion below could pass on a subject
    // that never moved, and every conclusion would be about nothing.
    const whileOn = await previewMoves(page, 12);
    expect(
      whileOn.moved,
      `the preview must be animating while ON before this test can say anything ` +
        `about OFF (distinct frames seen: ${whileOn.distinct})`,
    ).toBe(true);

    await toggle.click();
    await expect(wrap).toHaveAttribute('data-preview-collapsed', 'true');

    // THE LOAD-BEARING ASSERTION. While collapsed the node must STILL be a pull
    // root — `markWatched` keeps running even though the blit does not — so the
    // engine's own per-node draw counter must keep climbing. If collapsing tore
    // the producer down this is where it shows, and it is invisible in pixels.
    const before = await framesDrawn(page);
    test.skip(before < 0, 'engine draw counter unavailable in this runtime');
    await waitFrames(page, 20);
    const after = await framesDrawn(page);
    expect(
      after - before,
      `the engine must keep drawing this node while its preview is COLLAPSED ` +
        `(frames drawn: ${before} -> ${after}). A collapse that stops the producer ` +
        `loses the feedback nest's history and the picture returns black or stale.`,
    ).toBeGreaterThan(0);

    // …and switching back ON shows a LIVE picture, not a stale held frame.
    await toggle.click();
    await expect(wrap).toHaveAttribute('data-preview-collapsed', 'false');
    const whileBack = await previewMoves(page, 12);
    expect(
      whileBack.moved,
      `after switching the preview back ON the picture must be LIVE, not a stale ` +
        `frame (distinct frames seen: ${whileBack.distinct})`,
    ).toBe(true);
  });

  test('the OUTPUT menu still works while the preview is OFF (the surface is collapsed, not destroyed)', async ({
    page,
  }) => {
    // Full Screen / Present / Full Frame all blit from the same canvas, so a
    // collapse that unmounted it would break all three — and the ⛶ OUTPUT
    // button is the module's SOLE entry to them.
    const fv = await openFace(page);
    await fv.getByTestId('backdraft-preview-toggle').click();
    await expect(fv.locator('[data-testid="backdraft-fs-wrap"]')).toHaveAttribute(
      'data-preview-collapsed',
      'true',
    );

    // The canvas is still a real, rendered element — `requestFullscreen()` has
    // to be handed one at the moment the menu item is clicked.
    await expect(
      fv.locator('[data-testid="backdraft-canvas"]'),
      'the canvas is collapsed, never unmounted',
    ).toHaveCount(1);

    await fv.getByTestId('backdraft-output-menu').click();
    await expect(page.locator('[role="menu"]').first()).toBeVisible();
  });
});
