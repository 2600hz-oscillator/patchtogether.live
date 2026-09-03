// e2e/tests/patch-panel.spec.ts
//
// Core invariants of the redesigned (no-drag / overlay-replace / portaled)
// patch menu, on the DEFAULT shell (the lane tile's jack-rail variant):
//
//  1. Default state: handles are in the node DOM but opacity:0 +
//     pointer-events:none, stacked at the affordance point (the per-port
//     sweep + cable anchor depend on this). The menu chrome is NOT mounted.
//  2. Click the rail trigger → the body-portaled chrome opens at the root
//     view (INPUT / OUTPUT pivots).
//  3. Drilling into INPUT / OUTPUT shows verbose-labeled port rows.
//  4. Hover alone never opens; an outside click closes.
//  5. Edge-alignment: the menu's anchored edge lines up with the node's
//     left edge, from the FIRST painted frame.
//
// ⚠ The card's LEFT/RIGHT corner trigger PAIR died with the card — the lane
// rail has ONE drill-down trigger (`patch-trigger`; `patch-trigger-right`
// exists only on the card variant of PatchPanel), so the "both triggers share
// one menu" and right-edge anchoring claims left the product with the fleet
// (S2 manifest).
//
// I/O-spec consistency (exact handle id matching) is covered separately in
// io-spec-consistency.spec.ts / per-module-per-port.spec.ts.

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

function chrome(page: Page, nodeId: string) {
  return page.locator(`[data-patch-panel-chrome="${nodeId}"]`);
}

async function openFrom(page: Page, nodeId: string) {
  await page
    .locator(`.svelte-flow__node[data-id="${nodeId}"] [data-testid="patch-trigger"]`)
    .click();
  await expect(chrome(page, nodeId)).toHaveAttribute('aria-hidden', 'false');
}

async function drill(page: Page, nodeId: string, nav: 'inputs' | 'outputs') {
  await chrome(page, nodeId).locator(`[data-testid="patch-panel-nav"][data-nav="${nav}"]`).click();
}

/** Card + chrome edges, all read inside ONE page-side layout pass. */
interface AnchorSample {
  mounted: boolean;
  side: string;
  cardLeft: number;
  cardRight: number;
  menuLeft: number;
  menuRight: number;
  /** |menu.left − card.left| in CSS px — the LEFT-trigger contract. */
  leftDelta: number;
  /** |menu.right − card.right| in CSS px — the RIGHT-trigger contract. */
  rightDelta: number;
}

const EMPTY_ANCHOR: AnchorSample = {
  mounted: false, side: '', cardLeft: NaN, cardRight: NaN,
  menuLeft: NaN, menuRight: NaN, leftDelta: NaN, rightDelta: NaN,
};

/** Units + both rects, so a red run is diagnosable from the message alone. */
function describeAnchor(s: AnchorSample): string {
  return (
    `side=${s.side} card=[${Math.round(s.cardLeft)}..${Math.round(s.cardRight)}] ` +
    `menu=[${Math.round(s.menuLeft)}..${Math.round(s.menuRight)}] ` +
    `leftDelta=${Math.round(s.leftDelta)} rightDelta=${Math.round(s.rightDelta)} (CSS px)`
  );
}

/** Sample the card + chrome rects together. Both rects come from the SAME
 *  layout, unlike two `boundingBox()` round trips. */
async function readDeltas(page: Page, nodeId: string): Promise<AnchorSample> {
  return await page.evaluate((id) => {
    const c = document.querySelector(`[data-patch-panel-chrome="${id}"]`) as HTMLElement | null;
    const card = document.querySelector(`.svelte-flow__node[data-id="${id}"]`) as HTMLElement | null;
    if (!c || !card) {
      return { mounted: false, side: '', cardLeft: NaN, cardRight: NaN,
        menuLeft: NaN, menuRight: NaN, leftDelta: NaN, rightDelta: NaN };
    }
    const cr = card.getBoundingClientRect();
    const mr = c.getBoundingClientRect();
    return {
      mounted: true,
      side: c.getAttribute('data-anchor-side') ?? '',
      cardLeft: cr.left, cardRight: cr.right,
      menuLeft: mr.left, menuRight: mr.right,
      leftDelta: Math.abs(mr.left - cr.left),
      rightDelta: Math.abs(mr.right - cr.right),
    };
  }, nodeId);
}

/**
 * Click a trigger IN THE PAGE and sample the chrome's anchor in the SAME task,
 * i.e. on the first frame the chrome exists. Nothing crosses the Playwright
 * protocol boundary inside the window under test, so the measurement is
 * frame-exact and does not depend on the renderer's frame rate — the property
 * a `boundingBox()` round trip does not have (#1647, #1569).
 */
async function openInPageAndSampleFirstFrame(
  page: Page,
  nodeId: string,
): Promise<AnchorSample> {
  const testid = 'patch-trigger';
  const sample = await page.evaluate(
    async ({ id, tid }) => {
      const btn = document.querySelector(
        `.svelte-flow__node[data-id="${id}"] [data-testid="${tid}"]`,
      ) as HTMLElement | null;
      if (!btn) return null;
      btn.click();
      // Let Svelte flush the DOM creation, then read — still before any
      // animation frame has been given the chance to reposition anything.
      await new Promise<void>((r) => queueMicrotask(() => r()));
      const c = document.querySelector(`[data-patch-panel-chrome="${id}"]`) as HTMLElement | null;
      const card = document.querySelector(`.svelte-flow__node[data-id="${id}"]`) as HTMLElement | null;
      if (!c || !card) return null;
      const cr = card.getBoundingClientRect();
      const mr = c.getBoundingClientRect();
      return {
        mounted: true,
        side: c.getAttribute('data-anchor-side') ?? '',
        cardLeft: cr.left, cardRight: cr.right,
        menuLeft: mr.left, menuRight: mr.right,
        leftDelta: Math.abs(mr.left - cr.left),
        rightDelta: Math.abs(mr.right - cr.right),
      };
    },
    { id: nodeId, tid: testid },
  );
  return sample ?? EMPTY_ANCHOR;
}

test.describe('PatchPanel: redesigned menu', () => {
  test('ADSR default state hides jacks; click-open + drill shows verbose labels', async ({ page, rack }) => {
    await spawnPatch(page, [{ id: 'adsr', type: 'adsr', position: { x: 200, y: 200 } }]);

    // 1. Default: chrome not mounted.
    await expect(chrome(page, 'adsr')).toHaveCount(0);

    // Handles in DOM but visually hidden (opacity:0 + pointer-events:none).
    const gate = page
      .locator(`.svelte-flow__node[data-id="adsr"] .svelte-flow__handle[data-handleid="gate"]`)
      .first();
    await expect(gate).toHaveCount(1);
    const hidden = await gate.evaluate((el) => {
      const cs = getComputedStyle(el);
      return cs.opacity === '0' && cs.pointerEvents === 'none';
    });
    expect(hidden, 'closed-state handle is opacity:0 + pointer-events:none').toBe(true);

    // 2 + 3. Click-open + drill INPUT → verbose labels.
    await openFrom(page, 'adsr');
    await drill(page, 'adsr', 'inputs');
    const inputLabels = (
      await chrome(page, 'adsr').locator('[data-testid="port-row-label"]').allTextContents()
    ).map((s) => s.trim());
    for (const expected of ['ATTACK', 'DECAY', 'SUSTAIN', 'RELEASE', 'GATE']) {
      expect(inputLabels).toContain(expected);
    }
    expect(inputLabels).not.toContain('ATK');

    // Back → drill OUTPUT → ENVELOPE.
    await chrome(page, 'adsr').locator('[data-testid="patch-panel-back"]').click();
    await drill(page, 'adsr', 'outputs');
    const outLabels = (
      await chrome(page, 'adsr').locator('[data-testid="port-row-label"]').allTextContents()
    ).map((s) => s.trim());
    expect(outLabels).toContain('ENVELOPE');
    expect(outLabels).not.toContain('GATE');
  });

  test('Filter drill uses verbose CUTOFF / RESONANCE labels', async ({ page, rack }) => {
    await spawnPatch(page, [{ id: 'flt', type: 'filter', position: { x: 200, y: 200 } }]);
    await openFrom(page, 'flt');
    await drill(page, 'flt', 'inputs');
    const labels = (
      await chrome(page, 'flt').locator('[data-testid="port-row-label"]').allTextContents()
    ).map((s) => s.trim());
    expect(labels).toContain('CUTOFF');
    expect(labels).toContain('RESONANCE');
    expect(labels).not.toContain('CUT');
  });

  test('the rail trigger opens ONE menu on click only; an outside click closes it', async ({ page, rack }) => {
    await spawnPatch(page, [{ id: 'adsr', type: 'adsr', position: { x: 200, y: 200 } }]);

    const trigger = page.locator(
      `.svelte-flow__node[data-id="adsr"] [data-testid="patch-trigger"]`,
    );
    await expect(trigger).toHaveCount(1);

    // Hover alone never opens.
    await trigger.hover();
    // pacing: a NEGATIVE observation window — the menu opens synchronously on
    // click (openMenu in PatchPanel.svelte has no delay/debounce), so 150 ms of
    // hover with no chrome mounted bounds "hover alone never opens" from above;
    // there is no product interval to await because none may exist.
    await page.waitForTimeout(150);
    await expect(chrome(page, 'adsr')).toHaveCount(0);

    // Click → opens (one chrome instance).
    await trigger.click();
    await expect(chrome(page, 'adsr')).toHaveAttribute('aria-hidden', 'false');
    await expect(chrome(page, 'adsr')).toHaveCount(1);

    // Outside click closes.
    await page.mouse.click(20, 20);
    await expect(chrome(page, 'adsr')).toHaveCount(0);
  });

  // ⏸ FLAKE-PARK #1847 — parked with `test.fixme`; the body and its assertions are UNCHANGED.
  // NONDETERMINISM: 6 recovered-on-retry observation(s) across 3 SHA(s) / 3 branch(es) in the
  // 96 h CI census to 2026-08-18 — never a hard failure, so every one of those jobs reported SUCCESS.
  // LOST WHILE PARKED: that the body-portaled patch menu anchors to the side of its trigger — a menu that opens off-screen at a card near the viewport edge is an unreachable patch.
  // Re-enable only on a root cause (#1847); "it passes now" is not one.
  // (Re-pointed at the shell's single rail trigger by the S2 legacy-removal
  // inversion — the card's RIGHT-trigger half of this subject died with the
  // card; see the header + manifest.)
  test.fixme('edge-alignment: the rail trigger anchors the menu to the node edge from the FIRST frame', { annotation: { type: 'fixme', description: 'FLAKE-PARK #1847 — nondeterministic on CI: 6 recovered-on-retry observations in the 96 h census to 2026-08-18; parked until root-caused' } }, async ({ page, rack }) => {
    await spawnPatch(page, [{ id: 'adsr', type: 'adsr', position: { x: 200, y: 160 } }]);

    // ── Settled contract, measured in ONE layout pass and auto-retried ──────
    //
    // ⚠ The two `boundingBox()` calls this replaced were TWO Playwright round
    // trips, i.e. the card and the menu were measured at two different
    // moments, and each was a ONE-SHOT read with no retry. `readDeltas` takes
    // both rects inside a single page-side layout, and `expect.poll` retries
    // on the visible subject, so neither edge can be read from a layout the
    // other was not read from.
    await openFrom(page, 'adsr');
    await expect
      .poll(async () => (await readDeltas(page, 'adsr')).leftDelta, {
        message: 'rail trigger: menu LEFT edge aligns to node LEFT edge (CSS px)',
      })
      .toBeLessThanOrEqual(4);
    const settled = await readDeltas(page, 'adsr');
    expect(
      settled.menuLeft,
      `menu must never spill PAST the anchored node edge — ${describeAnchor(settled)}`,
    ).toBeGreaterThanOrEqual(settled.cardLeft - 1);
    await page.mouse.click(8, 8);
    await expect(chrome(page, 'adsr')).toHaveCount(0);

    // ── PERMANENT LEG (#1647): the FIRST painted frame is already aligned ───
    //
    // The settled assertions above are auto-retrying, so on their own they are
    // BLIND to the defect that produced the 1/25 CI flake: the portaled chrome
    // used to render at the PREVIOUS open's coordinates and only jump to the
    // right anchor on the first rAF. `chromePos` outlives a close (only the
    // `{#if open}` block unmounts), `data-anchor-side` and `aria-hidden` are
    // already correct in that frame, and the window is RENDERER-SCALED — ~16 ms
    // at 60 fps, ~126 ms under SwiftShader's 7.9 fps — which is exactly why a
    // Playwright round trip landed inside it on CI and never locally.
    //
    // Measured on origin/main before the fix, open LEFT → close → open RIGHT:
    //   first frame  menuRight=659  cardRight=945  delta=286   <-- the CI value
    //   +1 frame     menuRight=945  cardRight=945  delta=0
    //
    // So this leg asserts the frame the settled poll cannot see. The click is
    // dispatched IN THE PAGE and the rect sampled in the same task, so no
    // Playwright round trip happens inside the window under test — the
    // measurement is frame-exact and renderer-independent by construction.
    {
      const first = await openInPageAndSampleFirstFrame(page, 'adsr');
      expect(
        first.mounted,
        'the chrome must be in the DOM in the same task as the trigger click',
      ).toBe(true);
      expect(first.side, 'chrome anchors to the left side').toBe('left');
      expect(
        first.leftDelta,
        `#1647 — the FIRST frame the chrome exists must ALREADY be edge-aligned, ` +
          `not one frame behind at the previous open's anchor. ${describeAnchor(first)}`,
      ).toBeLessThanOrEqual(4);
      await page.mouse.click(8, 8);
      await expect(chrome(page, 'adsr')).toHaveCount(0);
    }
  });

  test('cables visually anchor at the affordance corner when the menu is closed', async ({ page, rack }) => {
    await spawnPatch(
      page,
      [
        { id: 'adsr', type: 'adsr', position: { x: 100, y: 100 } },
        { id: 'vca', type: 'vca', position: { x: 600, y: 100 } },
      ],
      [
        {
          id: 'e1',
          from: { nodeId: 'adsr', portId: 'env' },
          to: { nodeId: 'vca', portId: 'cv' },
          sourceType: 'cv',
          targetType: 'cv',
        },
      ],
    );
    await expect(
      page.locator(`.svelte-flow__edge[data-id="e1"] .svelte-flow__edge-path`),
    ).toHaveCount(1);

    // Menu closed → the env output handle sits at the node's TOP-LEFT
    // affordance point (the corner stack), so the cable anchors there. On the
    // shell the DRILL trigger moved into the bottom jack rail, but the visual
    // anchor corner did not — measured: handle centre ≈ 28 px inset from the
    // node's top-left, rail ~250 px below it.
    await expect(chrome(page, 'adsr')).toHaveCount(0);
    const nodeBox = await page.locator(`.svelte-flow__node[data-id="adsr"]`).boundingBox();
    const handleBox = await page
      .locator(
        `.svelte-flow__node[data-id="adsr"] .svelte-flow__handle[data-handleid="env"][class*="source"]`,
      )
      .boundingBox();
    expect(nodeBox && handleBox).toBeTruthy();
    if (!nodeBox || !handleBox) return;
    const dx = handleBox.x + handleBox.width / 2 - nodeBox.x;
    const dy = handleBox.y + handleBox.height / 2 - nodeBox.y;
    expect(dx, `closed output handle anchors at the node's top-left corner (dx=${dx})`).toBeLessThan(40);
    expect(dy, `closed output handle anchors at the node's top-left corner (dy=${dy})`).toBeLessThan(40);
    expect(dx, 'and inside the node, never off its edge').toBeGreaterThanOrEqual(0);
    expect(dy, 'and inside the node, never off its edge').toBeGreaterThanOrEqual(0);
  });

  test('handles for every declared port stay in the card DOM with the menu closed (io-spec parity)', async ({ page, rack }) => {
    await spawnPatch(page, [{ id: 'mm', type: 'mixmstrs', position: { x: 200, y: 200 } }]);
    await expect(chrome(page, 'mm')).toHaveCount(0);
    // MIXMSTRS: every declared port materialises a handle regardless of menu
    // state (49 inputs + outputs — the sectioned mega-module case).
    const count = await page
      .locator('.svelte-flow__node[data-id="mm"] .svelte-flow__handle[data-handleid]')
      .count();
    expect(count).toBeGreaterThanOrEqual(50);
  });
});
