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
// Bug fix: hovering a collapsed nested section header during an active
// connect-drag now auto-expands that section so the cable can reach
// ports inside it. On drag end, sections that were only auto-expanded
// (not manually opened by the user before the drag) collapse back.

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

test.describe('PatchPanel: nested-section auto-expand during cable drag', () => {
  test('drag cable INTO a nested target port: hover collapsed section header auto-expands it', async ({
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

    // Every section is collapsed at the moment the panel opens (per
    // PR-92's "fresh hover starts collapsed" rule).
    for (const label of ['Ch1', 'Ch2', 'Ch3', 'Ch4', 'Master']) {
      expect(
        await sectionExpanded(page, 'mm', label),
        `${label} starts collapsed mid-drag`,
      ).toBe(false);
    }

    // Hover the Ch1 section header — must auto-expand because a drag
    // is in flight.
    const ch1Header = page.locator(
      `.svelte-flow__node[data-id="mm"] ` +
        `[data-testid="patch-panel-section-toggle"][data-section-label="Ch1"]`,
    );
    const hBox = await ch1Header.boundingBox();
    expect(hBox, 'Ch1 header has box').toBeTruthy();
    if (!hBox) return;
    await page.mouse.move(hBox.x + hBox.width / 2, hBox.y + hBox.height / 2, { steps: 10 });
    await page.waitForTimeout(80);

    expect(
      await sectionExpanded(page, 'mm', 'Ch1'),
      'Ch1 auto-expanded after pointer hovered its header during drag',
    ).toBe(true);

    // Sister sections still collapsed (auto-expand is per-section, not
    // a broadcast).
    expect(await sectionExpanded(page, 'mm', 'Ch2')).toBe(false);

    // Move pointer onto the ch1L target handle inside the now-expanded
    // section, then release to commit the connection.
    const targetHandle = page.locator(
      `.svelte-flow__node[data-id="mm"] .svelte-flow__handle[data-handleid="ch1L"][class*="target"]`,
    );
    // Wait for the auto-expand to settle handle geometry — the panel
    // calls updateNodeInternals via RAF when expandedSections flips.
    await page.waitForTimeout(120);
    const tBox = await targetHandle.boundingBox();
    expect(tBox, 'ch1L handle has box after auto-expand').toBeTruthy();
    if (!tBox) return;

    await page.mouse.move(tBox.x + tBox.width / 2, tBox.y + tBox.height / 2, { steps: 20 });
    await page.mouse.up();
    await page.waitForTimeout(200);

    const edges = await readEdges(page);
    expect(edges.length, 'one edge created').toBe(1);
    expect(edges[0]!.source).toEqual({ nodeId: 'lfo', portId: 'phase0' });
    expect(edges[0]!.target).toEqual({ nodeId: 'mm', portId: 'ch1L' });
  });

  test('drag cable INTO a pre-expanded nested section: manual expand persists after drag end', async ({
    page,
  }) => {
    // Companion to the auto-expand test above: when the user has
    // manually expanded a section BEFORE the drag starts, the cable
    // can land on a port in that section without any auto-expand
    // path being triggered, AND the section remains expanded after
    // the drag ends (snapshot-restore preserves user state).
    //
    // Outputs in sectioned panels live in the always-visible flat
    // outputs column, not behind a section-toggle — so "nested
    // source port" can't be exercised against current modules.
    // Instead we exercise the symmetric path: a manually-expanded
    // source-side section that hosts the cable-drag DESTINATION,
    // with the cable originating from a non-sectioned source (LFO).
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

    // Pin MIXMSTRS open and manually expand Ch3 before any drag.
    await pinPanelOpen(page, 'mm');
    await clickSection(page, 'mm', 'Ch3');
    expect(await sectionExpanded(page, 'mm', 'Ch3')).toBe(true);

    await page.waitForTimeout(200);

    const sourceHandle = page.locator(
      `.svelte-flow__node[data-id="lfo"] .svelte-flow__handle[data-handleid="phase0"][class*="source"]`,
    );
    const sBox = await sourceHandle.boundingBox();
    expect(sBox, 'LFO phase0 handle has box').toBeTruthy();
    if (!sBox) return;

    await page.mouse.move(sBox.x + sBox.width / 2, sBox.y + sBox.height / 2);
    await page.mouse.down();

    // Drag onto ch3_volume (in the pre-expanded Ch3 section). The
    // handle is already visible — no auto-expand needs to fire.
    const targetHandle = page.locator(
      `.svelte-flow__node[data-id="mm"] .svelte-flow__handle[data-handleid="ch3_volume"][class*="target"]`,
    );
    const tBox = await targetHandle.boundingBox();
    expect(tBox, 'ch3_volume handle visible because Ch3 was manually expanded').toBeTruthy();
    if (!tBox) return;

    await page.mouse.move(tBox.x + tBox.width / 2, tBox.y + tBox.height / 2, { steps: 25 });
    await page.mouse.up();
    await page.waitForTimeout(200);

    const edges = await readEdges(page);
    expect(edges.length, 'edge created into pre-expanded section port').toBe(1);
    expect(edges[0]!.source).toEqual({ nodeId: 'lfo', portId: 'phase0' });
    expect(edges[0]!.target).toEqual({ nodeId: 'mm', portId: 'ch3_volume' });

    // Ch3 was manually expanded before the drag — it stays expanded
    // after drag end (the snapshot-restore preserves user state).
    expect(
      await sectionExpanded(page, 'mm', 'Ch3'),
      'manually-expanded section persists after drag end',
    ).toBe(true);
  });

  test('drag-auto-expanded sections collapse back after drag end (snapshot restore)', async ({
    page,
  }) => {
    // Sister regression: a section that was ONLY auto-expanded by
    // drag-hover (not manually clicked open) must collapse again once
    // the drag releases — otherwise the user is left with stale UI
    // every time they brush a header mid-drag.
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

    const sourceHandle = page.locator(
      `.svelte-flow__node[data-id="lfo"] .svelte-flow__handle[data-handleid="phase0"][class*="source"]`,
    );
    const sBox = await sourceHandle.boundingBox();
    if (!sBox) return;

    await page.mouse.move(sBox.x + sBox.width / 2, sBox.y + sBox.height / 2);
    await page.mouse.down();

    // Hover Ch2 header → auto-expand.
    const ch2Header = page.locator(
      `.svelte-flow__node[data-id="mm"] ` +
        `[data-testid="patch-panel-section-toggle"][data-section-label="Ch2"]`,
    );
    const hBox = await ch2Header.boundingBox();
    if (!hBox) return;
    await page.mouse.move(hBox.x + hBox.width / 2, hBox.y + hBox.height / 2, { steps: 10 });
    await page.waitForTimeout(80);
    expect(await sectionExpanded(page, 'mm', 'Ch2')).toBe(true);

    // Cancel the drag (release outside any port).
    await page.mouse.move(hBox.x, hBox.y - 400, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(200);

    // No edge created.
    const edges = await readEdges(page);
    expect(edges.length).toBe(0);

    // Ch2 was only auto-expanded by the drag — it collapses back to
    // match the pre-drag snapshot.
    expect(
      await sectionExpanded(page, 'mm', 'Ch2'),
      'drag-auto-expanded section collapses after drag end',
    ).toBe(false);
  });
});
