// e2e/tests/backdraft-clocked-delay.spec.ts
//
// A PATCHED DELAY CLOCK MAKES THE DELAY FADER INERT — owner ruling, verbatim:
// *"how does the delay fader interact with a clocked delay? i think if delay
// clock is patched this is a case where we should ignore the fader entirely."*
//
// The chain is REAL end to end: an audio LFO's phase output crosses the
// cross-domain bridge into backdraft's delay_clock, the module measures the
// pulse period on the bridge's own write clock, and the faceplate's delay
// fader dims + badges through the SAME shared predicate the legacy card's CLK
// badge uses (backdraft-clocked-delay.ts). The engine-side observable is
// read('effectiveDelayMs') — the delay draw() actually used — because the
// picture cannot show which ring slot it tapped.
//
// The hold/lock/re-patch state machine is pinned at unit level
// (backdraft-delay-ring.test.ts); this spec proves the live wiring: badge on
// patch, fader writes ignored while patched, control returned on unpatch.

import { test, expect, type Page } from '@playwright/test';
import { waitFrames } from '../_helpers/frames';

const NODE = 'bd';
const LFO = 'clk-lfo';
/** 4 Hz LFO → one rising edge per 250ms cycle. */
const LFO_RATE_HZ = 4;
const EXPECTED_PERIOD_MS = 1000 / LFO_RATE_HZ;

const SLOW_RENDER = process.env.E2E_SWIFTSHADER === '1' || !!process.env.CI;
const CASE_MS = SLOW_RENDER ? 120_000 : 45_000;

/** ADD to the live patch (never spawnPatch — it clears the seeded video zone);
 *  per-node domain because this spec needs an AUDIO clock source. Same shape
 *  as backdraft-panic.spec.ts / workflow-shell-video.spec.ts. */
async function injectPatch(
  page: Page,
  nodes: { id: string; type: string; domain: string; position: { x: number; y: number }; params?: Record<string, number> }[],
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
          w.__patch.nodes[n.id] = {
            id: n.id, type: n.type, domain: n.domain, position: n.position, params: n.params ?? {},
          };
        }
        for (const e of edges) {
          w.__patch.edges[e.id] = {
            id: e.id, source: e.from, target: e.to,
            sourceType: e.sourceType, targetType: e.targetType,
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

/** The delay draw() actually used, in ms — the engine-side truth. */
function effectiveDelayMs(page: Page): Promise<number> {
  return page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => { getDomain: (d: string) => { read: (id: string, k: string) => unknown } };
    };
    try {
      return (w.__engine!().getDomain('video').read(id, 'effectiveDelayMs') as number) ?? -1;
    } catch {
      return -1;
    }
  }, NODE);
}

function writeDelayParam(page: Page, ms: number): Promise<void> {
  return page.evaluate(
    ({ id, ms }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> } | undefined> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => { w.__patch.nodes[id]!.params.delay = ms; });
    },
    { id: NODE, ms },
  );
}

test.describe('backdraft — clocked delay makes the fader inert', () => {
  test('badge on patch, fader ignored while patched, control returned on unpatch', async ({ page }) => {
    test.setTimeout(CASE_MS);
    await gotoShell(page);
    await injectPatch(
      page,
      [
        { id: LFO, type: 'lfo', domain: 'audio', position: { x: -1200, y: 4500 }, params: { rate: LFO_RATE_HZ } },
        { id: NODE, type: 'backdraft', domain: 'video', position: { x: -700, y: 4500 }, params: { delay: 120 } },
      ],
    );

    const fv = await openFace(page);
    await fv.getByTestId('faceplate-tab-loop').click();
    const delayCell = fv.locator('[data-cell-key="delay"]');
    await expect(delayCell).toBeVisible();
    await expect(
      fv.getByTestId('face-override-badge-delay'),
      'no badge while nothing is patched',
    ).toHaveCount(0);

    // Patch the clock — the badge and the dim must follow the CABLE, and the
    // engine must start ignoring the fader.
    await page.evaluate(
      ({ lfo, bd }) => {
        const w = globalThis as unknown as {
          __patch: { edges: Record<string, unknown> };
          __ydoc: { transact: (fn: () => void) => void };
        };
        w.__ydoc.transact(() => {
          w.__patch.edges['e-clk'] = {
            id: 'e-clk',
            source: { nodeId: lfo, portId: 'phase0' },
            target: { nodeId: bd, portId: 'delay_clock' },
            sourceType: 'cv',
            targetType: 'cv',
          };
        });
      },
      { lfo: LFO, bd: NODE },
    );

    await expect(
      fv.getByTestId('face-override-badge-delay'),
      'the CLK badge appears on the face the moment the cable lands',
    ).toBeVisible();
    await expect(delayCell, 'the cell dims (overridden class)').toHaveClass(/ms-cell-overridden/);

    // The module measures one pulse period and locks to it. The measurement
    // is accurate to ~one 25ms bridge tick (the port doc's stated bound), so
    // the window is wide but centred on the true 250ms.
    await expect
      .poll(() => effectiveDelayMs(page), {
        message: `effective delay locks to ~one ${EXPECTED_PERIOD_MS}ms pulse (ms)`,
        timeout: 30_000,
      })
      .toBeGreaterThan(EXPECTED_PERIOD_MS * 0.6);
    expect(await effectiveDelayMs(page), 'locked delay stays near the pulse (ms)')
      .toBeLessThan(EXPECTED_PERIOD_MS * 1.6);

    // FADER INERT: a delay write moves the param, not the effective delay.
    await writeDelayParam(page, 900);
    await waitFrames(page, SLOW_RENDER ? 12 : 6); // give draws a chance to (wrongly) apply it
    const whileClocked = await effectiveDelayMs(page);
    expect(whileClocked, 'fader write ignored while clocked (ms)').toBeLessThan(
      EXPECTED_PERIOD_MS * 1.6,
    );

    // UNPATCH: control returns to the fader AT ITS CURRENT POSITION (900ms —
    // the value parked while clocked), and the badge goes away.
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { edges: Record<string, unknown> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => { delete w.__patch.edges['e-clk']; });
    });
    await expect(
      fv.getByTestId('face-override-badge-delay'),
      'the badge follows the cable out',
    ).toHaveCount(0);
    await expect
      .poll(() => effectiveDelayMs(page), {
        message: 'the fader rules again, at its parked 900ms position (ms)',
        timeout: 30_000,
      })
      .toBe(900);
  });
});
