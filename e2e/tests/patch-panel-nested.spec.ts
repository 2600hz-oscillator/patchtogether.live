// e2e/tests/patch-panel-nested.spec.ts
//
// Click-to-expand nested sections — the patch panel's mitigation for
// dense modules (RIOTGIRLS 55 inputs, MIXMSTRS 49 inputs) overflowing
// even the two-column layout. Each section header is a button; clicking
// it toggles that section's port rows. Multiple sections can be open at
// once.
//
// Behaviour we lock in here:
//   1. Default state (panel just hover-opened) has every section header
//      visible AND zero port rows visible — the user sees only the
//      headlines (V1, V2, V3, V4, Master) and chooses where to drill.
//   2. Clicking a section header expands it inline; its port rows
//      become visible.
//   3. Clicking a different section header expands the second one
//      WITHOUT collapsing the first (multi-open).
//   4. Clicking an expanded header again collapses it (the others stay).
//   5. Section headers carry a port-count badge so the user can see at a
//      glance which voice has the most patchable ports.
//   6. Both RIOTGIRLS (existing sectioned card) and MIXMSTRS (newly
//      sectioned in this PR) share the same UX.
//   7. Handles inside collapsed sections stay in the DOM — the
//      io-spec-consistency e2e gate must continue to pass. We assert
//      that here too via .svelte-flow__handle count.
//
// The spec uses the following test-id contract added in PatchPanel.svelte:
//   * [data-testid="patch-panel-section"] — wraps each section, with
//     data-section-label="V1" / "Ch1" / etc. and
//     data-section-expanded="true|false".
//   * [data-testid="patch-panel-section-toggle"] — the clickable
//     header button, with the same data-section-label attribute.

import { test, expect, type Page, type Locator } from '@playwright/test';
import { spawnPatch } from './_helpers';

async function openPanel(page: Page, nodeId: string): Promise<Locator> {
  const trigger = page.locator(
    `.svelte-flow__node[data-id="${nodeId}"] [data-testid="patch-trigger"]`,
  );
  await trigger.hover();
  const panel = page.locator(
    `.svelte-flow__node[data-id="${nodeId}"] [data-testid="patch-panel"]`,
  );
  await expect(panel).toHaveAttribute('aria-hidden', 'false');
  return panel;
}

/** Click a section's header by its data-section-label attribute, then
 *  pin the panel open so the toggle action doesn't race the
 *  hover-close timer. We pin via clicking the trigger BEFORE the
 *  section toggle, so the panel stays sticky-open while we make
 *  multiple click-test assertions in sequence. */
async function pinPanelOpen(page: Page, nodeId: string) {
  await page
    .locator(`.svelte-flow__node[data-id="${nodeId}"] [data-testid="patch-trigger"]`)
    .click();
  const panel = page.locator(
    `.svelte-flow__node[data-id="${nodeId}"] [data-testid="patch-panel"]`,
  );
  await expect(panel).toHaveAttribute('aria-hidden', 'false');
}

async function clickSection(page: Page, nodeId: string, label: string) {
  await page
    .locator(
      `.svelte-flow__node[data-id="${nodeId}"] ` +
        `[data-testid="patch-panel-section-toggle"][data-section-label="${label}"]`,
    )
    .click();
}

async function sectionExpanded(
  page: Page,
  nodeId: string,
  label: string,
): Promise<boolean> {
  const attr = await page
    .locator(
      `.svelte-flow__node[data-id="${nodeId}"] ` +
        `[data-testid="patch-panel-section"][data-section-label="${label}"]`,
    )
    .getAttribute('data-section-expanded');
  return attr === 'true';
}

/** Count visible port-row labels inside a specific section. Hidden via
 *  CSS visibility:hidden / display:none don't count as "visible" to
 *  Playwright's :visible engine. */
async function visibleRowCountInSection(
  page: Page,
  nodeId: string,
  label: string,
): Promise<number> {
  // The collapsed-section CSS uses visibility:hidden + height:0 to keep
  // handles in the DOM but invisible. Playwright's :visible pseudo-
  // class respects both, so a simple visible-locator count works.
  return page
    .locator(
      `.svelte-flow__node[data-id="${nodeId}"] ` +
        `[data-testid="patch-panel-section"][data-section-label="${label}"] ` +
        `[data-testid="port-row-label"]:visible`,
    )
    .count();
}

test.describe('PatchPanel: click-to-expand nested sections', () => {
  test('RIOTGIRLS: sections collapse by default; click-toggle expands inline', async ({
    page,
  }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'rg', type: 'riotgirls', position: { x: 200, y: 200 } },
    ]);
    await openPanel(page, 'rg');
    // Pin the panel so the click-toggles don't race the hover-close timer.
    await pinPanelOpen(page, 'rg');

    // 1. Five section headers visible (one per voice + Master FX).
    const headers = page.locator(
      `.svelte-flow__node[data-id="rg"] [data-testid="patch-panel-section-toggle"]`,
    );
    const labels = (await headers.allTextContents()).map((s) => s.trim());
    // Each header text is "<label> (<count>)" with the disclosure
    // glyph prefixed; we substring-match the section labels.
    const joined = labels.join(' | ');
    for (const expected of [
      'Voice 1 (DG)',
      'Voice 2 (DG)',
      'Voice 3 (DG)',
      'Voice 4 (WT)',
      'Master FX',
    ]) {
      expect(joined, `header for "${expected}" present`).toContain(expected);
    }

    // 2. Default state: every section is collapsed; no port-row labels
    //    are visible inside any section's body.
    for (const label of [
      'Voice 1 (DG)',
      'Voice 2 (DG)',
      'Voice 3 (DG)',
      'Voice 4 (WT)',
      'Master FX',
    ]) {
      expect(
        await sectionExpanded(page, 'rg', label),
        `${label} starts collapsed`,
      ).toBe(false);
      expect(
        await visibleRowCountInSection(page, 'rg', label),
        `${label} renders zero visible port rows when collapsed`,
      ).toBe(0);
    }

    // 3. Click "Voice 1 (DG)" → V1 expands.
    await clickSection(page, 'rg', 'Voice 1 (DG)');
    expect(await sectionExpanded(page, 'rg', 'Voice 1 (DG)')).toBe(true);
    expect(
      await visibleRowCountInSection(page, 'rg', 'Voice 1 (DG)'),
      'V1 has 10 ports visible after expand',
    ).toBeGreaterThanOrEqual(10);
    // Sister sections still collapsed.
    expect(await sectionExpanded(page, 'rg', 'Voice 2 (DG)')).toBe(false);

    // 4. Click "Voice 2 (DG)" → both V1 AND V2 expanded (multi-open).
    await clickSection(page, 'rg', 'Voice 2 (DG)');
    expect(await sectionExpanded(page, 'rg', 'Voice 1 (DG)')).toBe(true);
    expect(await sectionExpanded(page, 'rg', 'Voice 2 (DG)')).toBe(true);

    // 5. Click "Voice 1 (DG)" again → V1 collapses, V2 stays open.
    await clickSection(page, 'rg', 'Voice 1 (DG)');
    expect(await sectionExpanded(page, 'rg', 'Voice 1 (DG)')).toBe(false);
    expect(await sectionExpanded(page, 'rg', 'Voice 2 (DG)')).toBe(true);
    expect(
      await visibleRowCountInSection(page, 'rg', 'Voice 1 (DG)'),
      'V1 hides its port rows after re-collapse',
    ).toBe(0);
  });

  test('RIOTGIRLS: section headers carry port-count badges', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'rg', type: 'riotgirls', position: { x: 200, y: 200 } },
    ]);
    await openPanel(page, 'rg');

    // Voice 1 (DG): 10 inputs (trig, gate, pitch + tone/shape/volume/decay/pan/sendA/sendB).
    const v1Header = page
      .locator(
        `.svelte-flow__node[data-id="rg"] ` +
          `[data-testid="patch-panel-section-toggle"][data-section-label="Voice 1 (DG)"]`,
      );
    await expect(v1Header).toContainText('(10)');

    // Voice 4 (WT): 13 inputs.
    const v4Header = page
      .locator(
        `.svelte-flow__node[data-id="rg"] ` +
          `[data-testid="patch-panel-section-toggle"][data-section-label="Voice 4 (WT)"]`,
      );
    await expect(v4Header).toContainText('(13)');
  });

  test('MIXMSTRS: 5 section headers (Ch1..Ch4 + Master) with same expand/collapse behaviour', async ({
    page,
  }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'mm', type: 'mixmstrs', position: { x: 100, y: 100 } },
    ]);
    await openPanel(page, 'mm');
    await pinPanelOpen(page, 'mm');

    const headers = page.locator(
      `.svelte-flow__node[data-id="mm"] [data-testid="patch-panel-section-toggle"]`,
    );
    await expect(headers).toHaveCount(5);

    const labels = (await headers.allTextContents()).map((s) => s.trim()).join(' | ');
    for (const expected of ['Ch1', 'Ch2', 'Ch3', 'Ch4', 'Master']) {
      expect(labels, `header for "${expected}" present`).toContain(expected);
    }

    // Default state: every channel collapsed, zero visible rows.
    for (const label of ['Ch1', 'Ch2', 'Ch3', 'Ch4', 'Master']) {
      expect(await sectionExpanded(page, 'mm', label)).toBe(false);
      expect(await visibleRowCountInSection(page, 'mm', label)).toBe(0);
    }

    // Click Ch1 → expands; click Ch2 → both expanded; click Ch1 → only Ch2.
    await clickSection(page, 'mm', 'Ch1');
    expect(await sectionExpanded(page, 'mm', 'Ch1')).toBe(true);
    expect(await visibleRowCountInSection(page, 'mm', 'Ch1')).toBeGreaterThan(0);

    await clickSection(page, 'mm', 'Ch2');
    expect(await sectionExpanded(page, 'mm', 'Ch1')).toBe(true);
    expect(await sectionExpanded(page, 'mm', 'Ch2')).toBe(true);

    await clickSection(page, 'mm', 'Ch1');
    expect(await sectionExpanded(page, 'mm', 'Ch1')).toBe(false);
    expect(await sectionExpanded(page, 'mm', 'Ch2')).toBe(true);
  });

  test('MIXMSTRS: panel fits on 1366×768 viewport with sections collapsed', async ({
    page,
  }) => {
    // Whole point of the nested-sections work: even with the 2-column
    // layout, MIXMSTRS's 49 inputs would still scroll past the
    // viewport when fully expanded. With sections collapsed by default,
    // the panel fits comfortably.
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'mm', type: 'mixmstrs', position: { x: 100, y: 100 } },
    ]);
    await openPanel(page, 'mm');

    const panel = page.locator(
      `.svelte-flow__node[data-id="mm"] [data-testid="patch-panel"]`,
    );
    const box = await panel.boundingBox();
    expect(box, 'MIXMSTRS panel has bounding box').toBeTruthy();
    if (!box) return;

    // With everything collapsed the panel should be much shorter than
    // 768. We assert <= 600 to lock in "fits comfortably with headroom
    // for the user to expand a section or two without overflowing".
    // Real measured value at this writing: ~488px (5 collapsed
    // sections + 6 outputs + chrome).
    expect(
      box.height,
      'MIXMSTRS panel height with sections collapsed is well under viewport',
    ).toBeLessThanOrEqual(600);
  });

  test('RIOTGIRLS: panel fits on 1366×768 viewport with sections collapsed', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'rg', type: 'riotgirls', position: { x: 100, y: 100 } },
    ]);
    await openPanel(page, 'rg');

    const panel = page.locator(
      `.svelte-flow__node[data-id="rg"] [data-testid="patch-panel"]`,
    );
    const box = await panel.boundingBox();
    expect(box, 'RIOTGIRLS panel has bounding box').toBeTruthy();
    if (!box) return;

    expect(
      box.height,
      'RIOTGIRLS panel height with sections collapsed is well under viewport',
    ).toBeLessThanOrEqual(600);
  });

  test('handles remain in the DOM under collapsed sections (io-spec parity)', async ({
    page,
  }) => {
    // io-spec-consistency.spec.ts's invariant: every def-declared port
    // renders a Handle element with data-handleid in the card. The
    // nested-sections work must NOT break this — handles stay in the
    // DOM whether their section is collapsed or expanded, just hidden
    // via CSS.
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'rg', type: 'riotgirls', position: { x: 200, y: 200 } },
    ]);
    await openPanel(page, 'rg');

    // RIOTGIRLS: 55 inputs + 2 outputs = 57 handle elements regardless
    // of section state.
    const handleCount = await page
      .locator(
        `.svelte-flow__node[data-id="rg"] .svelte-flow__handle[data-handleid]`,
      )
      .count();
    expect(
      handleCount,
      'RIOTGIRLS exposes all 57 handles in the DOM with sections collapsed',
    ).toBe(57);

    // Same check for MIXMSTRS: 12 audio inputs (6 stereo pairs) + 41 CV
    // inputs (10 params × 4 channels + master_volume) + 6 audio outputs
    // (master L/R + send1 L/R + send2 L/R) = 59 handle elements.
    await spawnPatch(page, [
      { id: 'mm', type: 'mixmstrs', position: { x: 200, y: 200 } },
    ]);
    await openPanel(page, 'mm');
    const mmHandleCount = await page
      .locator(
        `.svelte-flow__node[data-id="mm"] .svelte-flow__handle[data-handleid]`,
      )
      .count();
    expect(
      mmHandleCount,
      'MIXMSTRS exposes all 59 handles in the DOM with sections collapsed',
    ).toBe(59);
  });
});

// ---------------- Drag-into / drag-from nested-section ports ----------------
//
// Bug fix: when a connect-drag is in flight and the patch panel is
// open, every collapsed nested section auto-expands so the user can
// reach any port inside the panel without first hunting and clicking
// section headers. We snapshot the pre-drag expanded state at drag
// start and restore it on drag end — sections the user manually
// expanded BEFORE the drag stay open; the rest revert to collapsed.

interface PatchEdge {
  id: string;
  source: { nodeId: string; portId: string };
  target: { nodeId: string; portId: string };
}

async function readEdges(page: Page): Promise<PatchEdge[]> {
  return await page.evaluate(() => {
    const w = window as unknown as { __patch: { edges: Record<string, PatchEdge> } };
    return Object.values(w.__patch.edges).filter(Boolean) as PatchEdge[];
  });
}

/** Wait until xyflow's onConnectStart has fired and the global drag-
 *  state singleton reports active=true. xyflow has a drag-threshold,
 *  so a single pointermove after pointerdown isn't always enough on
 *  slow headless Chromium; poll instead of relying on a fixed delay. */
async function waitForConnectDragActive(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const w = window as unknown as {
        __connectDragState?: { active: boolean };
      };
      return w.__connectDragState?.active === true;
    },
    null,
    { timeout: 3000 },
  );
}

test.describe('PatchPanel: nested-section auto-expand during cable drag', () => {
  test('drag cable INTO a nested target port: all sections auto-expand when panel opens mid-drag', async ({
    page,
  }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'lfo', type: 'lfo', position: { x: 80, y: 100 } },
      { id: 'mm', type: 'mixmstrs', position: { x: 800, y: 100 } },
    ]);

    // Open the LFO panel via click so phase0's source handle sits in
    // its open-state row position (the drag must originate from a
    // visible handle).
    await page
      .locator(`.svelte-flow__node[data-id="lfo"] [data-testid="patch-trigger"]`)
      .click();
    await expect(
      page.locator(`.svelte-flow__node[data-id="lfo"] [data-testid="patch-panel"]`),
    ).toHaveAttribute('aria-hidden', 'false');

    // Confirm the MIXMSTRS panel starts CLOSED and every section is
    // collapsed by default.
    const mmPanel = page.locator(
      `.svelte-flow__node[data-id="mm"] [data-testid="patch-panel"]`,
    );
    await expect(mmPanel).toHaveAttribute('aria-hidden', 'true');

    await page.waitForTimeout(250);

    const sourceHandle = page.locator(
      `.svelte-flow__node[data-id="lfo"] .svelte-flow__handle[data-handleid="phase0"][class*="source"]`,
    );
    const sBox = await sourceHandle.boundingBox();
    expect(sBox, 'LFO phase0 handle has box').toBeTruthy();
    if (!sBox) return;

    // Begin the drag from the source handle.
    await page.mouse.move(sBox.x + sBox.width / 2, sBox.y + sBox.height / 2);
    await page.mouse.down();

    // Move pointer onto the MIXMSTRS corner trigger — panel opens
    // mid-drag via PR-108's drag-induced hover-open + drag-lock.
    const mmTrigger = page.locator(
      `.svelte-flow__node[data-id="mm"] [data-testid="patch-trigger"]`,
    );
    const triggerBox = await mmTrigger.boundingBox();
    expect(triggerBox, 'MIXMSTRS trigger has box').toBeTruthy();
    if (!triggerBox) return;

    await page.mouse.move(
      triggerBox.x + triggerBox.width / 2,
      triggerBox.y + triggerBox.height / 2,
      { steps: 20 },
    );

    await expect(mmPanel, 'MIXMSTRS panel opens mid-drag').toHaveAttribute(
      'aria-hidden',
      'false',
    );

    // Wait for xyflow's onConnectStart to flip __connectDragState.active
    // before checking expand-all — the panel can open via hover-intent
    // a frame or two before xyflow's drag-threshold-gated start fires.
    await waitForConnectDragActive(page);
    // Give the snapshot $effect a frame to react to (active && open).
    await page.waitForTimeout(120);

    // Expand-all fires when the panel opens with a drag in flight —
    // every section transitions to expanded so the user sees every
    // possible target port without hunting through section headers.
    for (const label of ['Ch1', 'Ch2', 'Ch3', 'Ch4', 'Master']) {
      expect(
        await sectionExpanded(page, 'mm', label),
        `${label} auto-expanded when panel opens during drag`,
      ).toBe(true);
    }

    // Move pointer onto the ch1L target handle inside the now-expanded
    // panel, then release to commit the connection.
    const targetHandle = page.locator(
      `.svelte-flow__node[data-id="mm"] .svelte-flow__handle[data-handleid="ch1L"][class*="target"]`,
    );
    // Wait for expand-all to settle handle geometry — PatchPanel's
    // updateNodeInternals runs in a 2-RAF chain and xyflow caches
    // handle bounds for connect-drop targeting.
    await page.waitForTimeout(250);
    const tBox = await targetHandle.boundingBox();
    expect(tBox, 'ch1L handle has box after auto-expand').toBeTruthy();
    if (!tBox) return;

    // Multi-step approach so xyflow's connection-line tracks the move
    // and the final small jiggle settles into the handle's hit region
    // before we release.
    await page.mouse.move(tBox.x + tBox.width / 2, tBox.y + tBox.height / 2, { steps: 20 });
    await page.waitForTimeout(60);
    await page.mouse.move(tBox.x + tBox.width / 2 + 1, tBox.y + tBox.height / 2);
    await page.mouse.move(tBox.x + tBox.width / 2, tBox.y + tBox.height / 2);
    await page.waitForTimeout(40);
    await page.mouse.up();
    await page.waitForTimeout(250);

    const edges = await readEdges(page);
    expect(edges.length, 'one edge created').toBe(1);
    expect(edges[0]!.source).toEqual({ nodeId: 'lfo', portId: 'phase0' });
    expect(edges[0]!.target).toEqual({ nodeId: 'mm', portId: 'ch1L' });
  });

  test('drag-induced expand-all coexists with pre-existing manual expand (snapshot preserves manual)', async ({
    page,
  }) => {
    // When the user has manually expanded a section BEFORE the drag
    // starts, the drag-time expand-all opens every OTHER section too;
    // on drag end the snapshot taken at drag start restores the pre-
    // drag map — sections opened only by the drag revert, sections
    // opened manually stay open.
    //
    // Outputs in sectioned panels live in the always-visible flat
    // outputs column, not behind a section-toggle — so "drag FROM a
    // nested source port" can't be exercised against the current
    // module catalogue. This test exercises the snapshot-restore
    // contract via "panel already open + Master manually expanded"
    // pre-drag.
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'lfo', type: 'lfo', position: { x: 80, y: 100 } },
      { id: 'mm', type: 'mixmstrs', position: { x: 800, y: 100 } },
    ]);

    // Pin the LFO panel so phase0's source handle is in its
    // open-state row position.
    await page
      .locator(`.svelte-flow__node[data-id="lfo"] [data-testid="patch-trigger"]`)
      .click();
    await page.waitForTimeout(200);

    // Pin MIXMSTRS open and manually expand Master before the drag.
    await pinPanelOpen(page, 'mm');
    await clickSection(page, 'mm', 'Master');
    expect(await sectionExpanded(page, 'mm', 'Master')).toBe(true);
    expect(await sectionExpanded(page, 'mm', 'Ch1')).toBe(false);

    await page.waitForTimeout(200);

    const sourceHandle = page.locator(
      `.svelte-flow__node[data-id="lfo"] .svelte-flow__handle[data-handleid="phase0"][class*="source"]`,
    );
    const sBox = await sourceHandle.boundingBox();
    expect(sBox, 'LFO phase0 handle has box').toBeTruthy();
    if (!sBox) return;

    await page.mouse.move(sBox.x + sBox.width / 2, sBox.y + sBox.height / 2);
    await page.mouse.down();
    // Long, multi-step move past xyflow's connection-drag threshold —
    // 80px in 20 steps is enough on slow headless Chromium to trigger
    // onConnectStart. We aim away from any node to keep the move in
    // empty canvas.
    await page.mouse.move(sBox.x + sBox.width / 2 + 80, sBox.y + sBox.height / 2 + 80, {
      steps: 20,
    });
    await waitForConnectDragActive(page);
    await page.waitForTimeout(100);

    // Mid-drag: every section is expanded (drag-time expand-all),
    // including Master which was already manually expanded.
    for (const label of ['Ch1', 'Ch2', 'Ch3', 'Ch4', 'Master']) {
      expect(
        await sectionExpanded(page, 'mm', label),
        `${label} expanded mid-drag (expand-all)`,
      ).toBe(true);
    }

    // Cancel the drag — release away from any handle.
    await page.mouse.move(sBox.x - 200, sBox.y + 400, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(200);

    // No edge committed (the drag ended in empty space).
    const edges = await readEdges(page);
    expect(edges.length, 'no edge created (drag cancelled)').toBe(0);

    // Snapshot restore: every channel section that was only opened by
    // the drag collapses back; Master (manually pre-expanded) stays
    // open. Each section ends in the state the user left it in
    // pre-drag, regardless of mid-drag side effects.
    expect(
      await sectionExpanded(page, 'mm', 'Master'),
      'manually-expanded section persists after drag end',
    ).toBe(true);
    for (const label of ['Ch1', 'Ch2', 'Ch3', 'Ch4']) {
      expect(
        await sectionExpanded(page, 'mm', label),
        `${label} (drag-auto-expanded) reverts to pre-drag (collapsed) state`,
      ).toBe(false);
    }
  });

  test('drag-auto-expanded sections collapse back after drag end (snapshot restore)', async ({
    page,
  }) => {
    // Sister regression: sections that were ONLY auto-expanded by
    // drag-time expand-all (not manually clicked open before the drag)
    // must collapse again once the drag releases — otherwise the user
    // is left with every section gaping open after every cable they
    // pull.
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'lfo', type: 'lfo', position: { x: 80, y: 100 } },
      { id: 'mm', type: 'mixmstrs', position: { x: 800, y: 100 } },
    ]);

    await page
      .locator(`.svelte-flow__node[data-id="lfo"] [data-testid="patch-trigger"]`)
      .click();
    await page.waitForTimeout(200);

    // Pin the MIXMSTRS panel open BEFORE the drag so that after drag
    // end the panel remains open (otherwise it closes and
    // expandedSections is wiped — masking whether snapshot restore
    // worked).
    await pinPanelOpen(page, 'mm');

    // Confirm pre-drag state: every section collapsed.
    for (const label of ['Ch1', 'Ch2', 'Ch3', 'Ch4', 'Master']) {
      expect(
        await sectionExpanded(page, 'mm', label),
        `${label} collapsed pre-drag`,
      ).toBe(false);
    }

    const sourceHandle = page.locator(
      `.svelte-flow__node[data-id="lfo"] .svelte-flow__handle[data-handleid="phase0"][class*="source"]`,
    );
    const sBox = await sourceHandle.boundingBox();
    if (!sBox) return;

    await page.mouse.move(sBox.x + sBox.width / 2, sBox.y + sBox.height / 2);
    await page.mouse.down();
    // Long, multi-step move past xyflow's connection-drag threshold so
    // onConnectStart fires on slow headless Chromium.
    await page.mouse.move(sBox.x + sBox.width / 2 + 80, sBox.y + sBox.height / 2 + 80, {
      steps: 20,
    });
    await waitForConnectDragActive(page);
    await page.waitForTimeout(100);

    // Mid-drag: every section is expanded.
    for (const label of ['Ch1', 'Ch2', 'Ch3', 'Ch4', 'Master']) {
      expect(
        await sectionExpanded(page, 'mm', label),
        `${label} expanded mid-drag`,
      ).toBe(true);
    }

    // Cancel the drag (release in empty space).
    await page.mouse.move(sBox.x - 200, sBox.y + 400, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(200);

    // No edge created.
    const edges = await readEdges(page);
    expect(edges.length).toBe(0);

    // Every section was only auto-expanded by the drag — they all
    // collapse back to match the pre-drag snapshot.
    for (const label of ['Ch1', 'Ch2', 'Ch3', 'Ch4', 'Master']) {
      expect(
        await sectionExpanded(page, 'mm', label),
        `${label} (drag-auto-expanded only) collapses after drag end`,
      ).toBe(false);
    }
  });
});
