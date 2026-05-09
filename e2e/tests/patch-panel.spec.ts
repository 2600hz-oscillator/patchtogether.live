// e2e/tests/patch-panel.spec.ts
//
// Hover-revealed patch panel: covers the core invariants of the
// PatchPanel refactor.
//
//  1. Default state shows zero visible jacks (handles in DOM but
//     opacity:0 / pointer-events:none / stacked at the affordance corner).
//  2. Hover the top-left affordance opens the panel; verbose-labeled rows
//     for every input/output appear.
//  3. The panel stays open during a connect-drag.
//  4. Cables visually anchor at the top-left corner when the panel is
//     closed (their SVG endpoint coords land within a few px of the
//     affordance, NOT at the actual port row).
//
// I/O-spec consistency is covered separately in
// io-spec-consistency.spec.ts; this test focuses on the new UI surface.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

async function openPanel(page: Page, nodeId: string): Promise<void> {
  const trigger = page.locator(
    `.svelte-flow__node[data-id="${nodeId}"] [data-testid="patch-trigger"]`,
  );
  await trigger.hover();
  // Wait for aria-hidden=false on the panel.
  const panel = page.locator(
    `.svelte-flow__node[data-id="${nodeId}"] [data-testid="patch-panel"]`,
  );
  await expect(panel).toHaveAttribute('aria-hidden', 'false');
}

test.describe('PatchPanel: hover-reveal + verbose labels', () => {
  test('ADSR default state hides jacks; hover opens panel with verbose labels', async ({
    page,
  }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'adsr', type: 'adsr', position: { x: 200, y: 200 } },
    ]);

    // 1. Default state: panel is closed.
    const panel = page.locator(
      `.svelte-flow__node[data-id="adsr"] [data-testid="patch-panel"]`,
    );
    await expect(panel).toHaveAttribute('aria-hidden', 'true');

    // Handles are in the DOM but visually hidden — the I/O spec test
    // already covers DOM presence; here we assert visibility is off.
    // Assert the first handle has computed opacity 0 in the closed state.
    const firstHandle = page
      .locator(
        `.svelte-flow__node[data-id="adsr"] .svelte-flow__handle[data-handleid="gate"]`,
      )
      .first();
    await expect(firstHandle).toHaveCount(1);
    const isHiddenWhenClosed = await firstHandle.evaluate((el) => {
      const cs = getComputedStyle(el);
      return cs.opacity === '0' && cs.pointerEvents === 'none';
    });
    expect(isHiddenWhenClosed, 'closed-state handle is opacity:0 + pointer-events:none').toBe(
      true,
    );

    // 2. Open the panel by hovering the trigger.
    await openPanel(page, 'adsr');

    // 3. Verbose labels: ATTACK / DECAY / SUSTAIN / RELEASE.
    //    Use the panel-row label test-id so we don't accidentally match
    //    the section/group headers.
    const labels = page.locator(
      `.svelte-flow__node[data-id="adsr"] [data-testid="patch-panel"] [data-testid="port-row-label"]`,
    );
    const labelTexts = (await labels.allTextContents()).map((s) => s.trim());

    expect(labelTexts).toContain('ATTACK');
    expect(labelTexts).toContain('DECAY');
    expect(labelTexts).toContain('SUSTAIN');
    expect(labelTexts).toContain('RELEASE');
    expect(labelTexts).toContain('GATE');
    expect(labelTexts).toContain('ENVELOPE');

    // Reverting to abbreviations should fail this test loudly.
    expect(labelTexts, 'no abbreviated labels in panel').not.toContain('ATK');
    expect(labelTexts, 'no abbreviated labels in panel').not.toContain('DCY');
    expect(labelTexts, 'no abbreviated labels in panel').not.toContain('SUS');
    expect(labelTexts, 'no abbreviated labels in panel').not.toContain('REL');
  });

  test('Filter panel uses verbose CUTOFF / RESONANCE labels', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [{ id: 'flt', type: 'filter', position: { x: 200, y: 200 } }]);
    await openPanel(page, 'flt');

    const labels = page.locator(
      `.svelte-flow__node[data-id="flt"] [data-testid="patch-panel"] [data-testid="port-row-label"]`,
    );
    const labelTexts = (await labels.allTextContents()).map((s) => s.trim());
    expect(labelTexts).toContain('CUTOFF');
    expect(labelTexts).toContain('RESONANCE');
    expect(labelTexts, 'no abbreviated labels in filter panel').not.toContain('CUT');
    expect(labelTexts, 'no abbreviated labels in filter panel').not.toContain('RES');
  });

  test('RIOTGIRLS panel renders all 55 input rows', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [{ id: 'rg', type: 'riotgirls', position: { x: 200, y: 200 } }]);
    await openPanel(page, 'rg');

    // Section headers (one per voice + master) should all be present.
    const sectionHeaders = page.locator(
      `.svelte-flow__node[data-id="rg"] [data-testid="patch-panel"] .section-title`,
    );
    const sectionTexts = (await sectionHeaders.allTextContents()).map((s) => s.trim());
    expect(sectionTexts).toEqual(
      expect.arrayContaining(['Voice 1 (DG)', 'Voice 2 (DG)', 'Voice 3 (DG)', 'Voice 4 (WT)', 'Master FX']),
    );

    // Spot-check verbose labels.
    const labels = page.locator(
      `.svelte-flow__node[data-id="rg"] [data-testid="patch-panel"] [data-testid="port-row-label"]`,
    );
    const labelTexts = (await labels.allTextContents()).map((s) => s.trim());
    expect(labelTexts).toContain('V1 TRIGGER');
    expect(labelTexts).toContain('V4 ATTACK');
    expect(labelTexts).toContain('FILTER CUTOFF');
    expect(labelTexts).toContain('REVERB SIZE');
    expect(labelTexts).toContain('OUT L');
    expect(labelTexts).toContain('OUT R');

    // Total port-row-label count == 55 inputs + 2 outputs.
    expect(labelTexts.length).toBe(57);
  });

  test('cables visually anchor at top-left when both panels are closed', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Two adjacent modules connected by an audio cable. ADSR's env
    // output → VCA's cv input.
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

    // Wait for the edge SVG to render.
    const edge = page.locator(`.svelte-flow__edge[data-id="e1"] .svelte-flow__edge-path`);
    await expect(edge).toHaveCount(1);

    // Move mouse to a neutral location so neither panel is open.
    await page.mouse.move(50, 50);
    // Wait for any pending close timer to fire.
    await page.waitForTimeout(300);
    // Confirm panels closed.
    await expect(
      page.locator(`.svelte-flow__node[data-id="adsr"] [data-testid="patch-panel"]`),
    ).toHaveAttribute('aria-hidden', 'true');
    await expect(
      page.locator(`.svelte-flow__node[data-id="vca"] [data-testid="patch-panel"]`),
    ).toHaveAttribute('aria-hidden', 'true');

    // Compare the env handle's computed position against the panel row's
    // open-state position. When the panel is closed, the closed-state CSS
    // override pulls the handle to the top-left corner — its on-screen
    // position should NOT match the row-relative position (otherwise our
    // visual-anchor invariant is broken).
    const handleSelector = `.svelte-flow__node[data-id="adsr"] .svelte-flow__handle[data-handleid="env"][class*="source"]`;
    const closedStyle = await page.locator(handleSelector).evaluate((el) => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        opacity: cs.opacity,
        pointerEvents: cs.pointerEvents,
        x: r.left,
        y: r.top,
      };
    });
    expect(closedStyle.opacity, 'closed handle opacity:0').toBe('0');
    expect(closedStyle.pointerEvents, 'closed handle pointer-events:none').toBe('none');

    // Now hover-open the panel and confirm the handle's screen position
    // changed (i.e. it moved out of the corner stack into a row position).
    await page
      .locator(`.svelte-flow__node[data-id="adsr"] [data-testid="patch-trigger"]`)
      .hover();
    await page.waitForTimeout(200);
    await expect(
      page.locator(`.svelte-flow__node[data-id="adsr"] [data-testid="patch-panel"]`),
    ).toHaveAttribute('aria-hidden', 'false');

    const openStyle = await page.locator(handleSelector).evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top };
    });

    // The two positions must differ — that's the whole point of the
    // refactor (cables fan out when the panel opens).
    const dx = Math.abs(openStyle.x - closedStyle.x);
    const dy = Math.abs(openStyle.y - closedStyle.y);
    expect(
      Math.max(dx, dy),
      `handle screen position must differ between closed and open (got dx=${dx}, dy=${dy})`,
    ).toBeGreaterThan(40);
  });

  test('output cables anchor at top-left affordance when source panel is collapsed', async ({
    page,
  }) => {
    // Bug: when the source module's panel is closed, an output cable's
    // SVG endpoint must terminate at the source card's top-left
    // affordance — not at the row position the handle would occupy if
    // the panel were open. This was broken on PR-76 / SWOLEVCO: the
    // output cable visually traced back to the right side of the card
    // (where the open-state OUTPUT handle row lives) even with the panel
    // closed. The collapsed-state CSS rule needs higher specificity than
    // the open-state OUTPUT positioning rule (which uses both the
    // .panel-row.right selector AND the .svelte-flow__handle.source
    // selector — the original specificity hack only countered one of
    // them).
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // ADSR (env source, an output) wired to VCA (cv target, an input).
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

    // Move mouse far away so neither panel is open.
    await page.mouse.move(50, 50);
    await page.waitForTimeout(300);
    await expect(
      page.locator(`.svelte-flow__node[data-id="adsr"] [data-testid="patch-panel"]`),
    ).toHaveAttribute('aria-hidden', 'true');

    // Anchor: the source-side trigger affordance the user sees in the
    // top-left corner of the source card.
    const sourceCardTrigger = page.locator(
      `.svelte-flow__node[data-id="adsr"] [data-testid="patch-trigger"]`,
    );
    const triggerBox = await sourceCardTrigger.boundingBox();
    expect(triggerBox, 'source-card top-left trigger has a box').toBeTruthy();
    if (!triggerBox) return;

    // Output handle (env, type=source). When the panel is closed, this
    // handle must visually anchor near the trigger affordance — which
    // is what the cable's SVG endpoint follows.
    const outputHandle = page.locator(
      `.svelte-flow__node[data-id="adsr"] .svelte-flow__handle[data-handleid="env"][class*="source"]`,
    );
    const handleBox = await outputHandle.boundingBox();
    expect(handleBox, 'output handle has a box').toBeTruthy();
    if (!handleBox) return;

    // The output handle's centre must be within ~30px of the trigger's
    // centre. Anything further means the handle is still positioned at
    // the open-state row coordinates (right edge of the card, ~card-
    // width away from the top-left affordance).
    const triggerCx = triggerBox.x + triggerBox.width / 2;
    const triggerCy = triggerBox.y + triggerBox.height / 2;
    const handleCx = handleBox.x + handleBox.width / 2;
    const handleCy = handleBox.y + handleBox.height / 2;
    const dx = Math.abs(handleCx - triggerCx);
    const dy = Math.abs(handleCy - triggerCy);
    expect(
      dx,
      `output handle x must anchor near top-left trigger when panel closed (got dx=${dx}px from trigger centre)`,
    ).toBeLessThan(30);
    expect(
      dy,
      `output handle y must anchor near top-left trigger when panel closed (got dy=${dy}px from trigger centre)`,
    ).toBeLessThan(30);

    // And the cable's source endpoint (the start of the SVG <path d>)
    // must follow the handle — i.e. the cable visually terminates at
    // the trigger area, not at a row on the right edge of the card.
    const edgePath = page
      .locator(`.svelte-flow__edge[data-id="e1"] .svelte-flow__edge-path`)
      .first();
    const sourceEndpoint = await edgePath.evaluate((el) => {
      // svelte-flow edge paths start with `M x,y ...` — the M coordinate
      // is the source-side endpoint in SVG coords. Convert to viewport
      // coords via getCTM so we can compare to handle/trigger boxes.
      const path = el as SVGPathElement;
      const d = path.getAttribute('d') ?? '';
      const m = d.match(/^M\s*([-\d.]+)[ ,]([-\d.]+)/);
      if (!m) return null;
      const sx = Number(m[1]);
      const sy = Number(m[2]);
      const ctm = path.getScreenCTM();
      if (!ctm) return null;
      const pt = (path.ownerSVGElement ?? path).createSVGPoint();
      pt.x = sx;
      pt.y = sy;
      const screen = pt.matrixTransform(ctm);
      return { x: screen.x, y: screen.y };
    });
    expect(sourceEndpoint, 'edge has parseable source endpoint').not.toBeNull();
    if (!sourceEndpoint) return;
    const ex = Math.abs(sourceEndpoint.x - triggerCx);
    const ey = Math.abs(sourceEndpoint.y - triggerCy);
    expect(
      ex,
      `cable source endpoint x must anchor near top-left trigger when source panel closed (got dx=${ex}px from trigger centre)`,
    ).toBeLessThan(40);
    expect(
      ey,
      `cable source endpoint y must anchor near top-left trigger when source panel closed (got dy=${ey}px from trigger centre)`,
    ).toBeLessThan(40);
  });

  test('top-right trigger opens the same panel as top-left', async ({ page }) => {
    // Per user feedback (PR-69): every module gets a SECOND hover
    // affordance in the top-right corner that opens the same panel
    // as the existing top-left one. Both share state.
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'adsr', type: 'adsr', position: { x: 200, y: 200 } },
    ]);

    const panel = page.locator(
      `.svelte-flow__node[data-id="adsr"] [data-testid="patch-panel"]`,
    );
    const rightTrigger = page.locator(
      `.svelte-flow__node[data-id="adsr"] [data-testid="patch-trigger-right"]`,
    );

    // Sanity: the right trigger exists and is visible.
    await expect(rightTrigger).toHaveCount(1);

    // Default closed.
    await expect(panel).toHaveAttribute('aria-hidden', 'true');

    // Hover top-right → panel opens.
    await rightTrigger.hover();
    await expect(panel).toHaveAttribute('aria-hidden', 'false');

    // Move mouse far away → panel closes (after the 200ms hover-close
    // timer fires).
    await page.mouse.move(50, 50);
    await page.waitForTimeout(350);
    await expect(panel).toHaveAttribute('aria-hidden', 'true');
  });

  test('mousing from top-left across the card top to top-right keeps panel open', async ({
    page,
  }) => {
    // Hover-intent guard: the user reaches across the card to switch
    // affordances, the panel must NOT blink shut mid-trip. Both
    // triggers share state, and the panel itself is also hoverable
    // (the cursor crosses through the panel area en route).
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'adsr', type: 'adsr', position: { x: 200, y: 200 } },
    ]);

    const leftTrigger = page.locator(
      `.svelte-flow__node[data-id="adsr"] [data-testid="patch-trigger"]`,
    );
    const rightTrigger = page.locator(
      `.svelte-flow__node[data-id="adsr"] [data-testid="patch-trigger-right"]`,
    );
    const panel = page.locator(
      `.svelte-flow__node[data-id="adsr"] [data-testid="patch-panel"]`,
    );

    // Open via left trigger.
    await leftTrigger.hover();
    await expect(panel).toHaveAttribute('aria-hidden', 'false');

    // Walk cursor across the panel to the right trigger. Each
    // intermediate hover keeps the panel open via either the panel's
    // own onmouseenter or the right trigger's onmouseenter; the
    // 200ms scheduleClose timer never has a chance to fire as long as
    // each step lands within the close delay.
    const rightBox = await rightTrigger.boundingBox();
    expect(rightBox, 'right trigger has box').toBeTruthy();
    if (!rightBox) return;

    // Step through the panel area (which is between left and right
    // triggers vertically); each move is a fresh mouse event the
    // browser dispatches mouseenter/mouseleave for.
    await page.mouse.move(rightBox.x + rightBox.width / 2, rightBox.y + rightBox.height / 2, {
      steps: 10,
    });
    // The whole walk takes <100ms; the close timer is 200ms; the panel
    // must still be open.
    await expect(panel).toHaveAttribute('aria-hidden', 'false');

    // Settle on the right trigger — explicit hover for the assertion.
    await rightTrigger.hover();
    await expect(panel).toHaveAttribute('aria-hidden', 'false');
  });

  test('panel stays open during a connect-drag', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'seq', type: 'sequencer', position: { x: 100, y: 100 } },
      { id: 'adsr', type: 'adsr', position: { x: 700, y: 100 } },
    ]);

    const sourceHandle = page.locator(
      `.svelte-flow__node[data-id="seq"] .svelte-flow__handle[data-handleid="gate"][class*="source"]`,
    );
    const targetHandle = page.locator(
      `.svelte-flow__node[data-id="adsr"] .svelte-flow__handle[data-handleid="gate"][class*="target"]`,
    );

    // Pin both panels open via click — once pinned, the panel stays
    // open until an outside tap or another click on the trigger.
    await page
      .locator(`.svelte-flow__node[data-id="seq"] [data-testid="patch-trigger"]`)
      .click();
    await page
      .locator(`.svelte-flow__node[data-id="adsr"] [data-testid="patch-trigger"]`)
      .click();
    await expect(
      page.locator(`.svelte-flow__node[data-id="seq"] [data-testid="patch-panel"]`),
    ).toHaveAttribute('aria-hidden', 'false');
    await expect(
      page.locator(`.svelte-flow__node[data-id="adsr"] [data-testid="patch-panel"]`),
    ).toHaveAttribute('aria-hidden', 'false');

    const sBox = await sourceHandle.boundingBox();
    const tBox = await targetHandle.boundingBox();
    expect(sBox && tBox, 'both handles have boxes').toBeTruthy();
    if (!sBox || !tBox) return;

    await page.mouse.move(sBox.x + sBox.width / 2, sBox.y + sBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(tBox.x + tBox.width / 2, tBox.y + tBox.height / 2, { steps: 8 });

    // Mid-drag: the source panel is still open (pinned + stayOpenForDrag).
    const seqPanel = page.locator(
      `.svelte-flow__node[data-id="seq"] [data-testid="patch-panel"]`,
    );
    await expect(seqPanel).toHaveAttribute('aria-hidden', 'false');

    await page.mouse.up();

    // Assert connection landed.
    const newEdge = page.locator(
      `.svelte-flow__edge[data-id*="seq-gate-adsr-gate"]`,
    );
    await expect(newEdge).toHaveCount(1);
  });
});
