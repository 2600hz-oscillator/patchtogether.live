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
import { REGISTRY } from './_registry';

async function openPanel(page: Page, nodeId: string): Promise<Locator> {
  const trigger = page.locator(
    `.svelte-flow__node[data-id="${nodeId}"] [data-testid="patch-trigger"]`,
  );
  // Post-PR-204: click (not hover) opens the panel.
  await trigger.click();
  const panel = page.locator(
    `.svelte-flow__node[data-id="${nodeId}"] [data-testid="patch-panel"]`,
  );
  await expect(panel).toHaveAttribute('aria-hidden', 'false');
  return panel;
}

/** Ensure the panel is pinned open without TOGGLING off a panel that's
 *  already pinned. Post-PR-204 `onTriggerClick` toggles `pinned` on
 *  every click — so a naive "click again to pin" call after openPanel()
 *  would actually unpin the panel and let the hover-close timer fire.
 *  This helper checks the current aria-expanded state on the trigger and
 *  only clicks if the panel isn't already pinned open. */
async function pinPanelOpen(page: Page, nodeId: string) {
  const trigger = page.locator(
    `.svelte-flow__node[data-id="${nodeId}"] [data-testid="patch-trigger"]`,
  );
  const expanded = await trigger.getAttribute('aria-expanded');
  if (expanded !== 'true') {
    await trigger.click();
  }
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

  test('MIXMSTRS: 7 section headers (Ch1..Ch6 + Master) with same expand/collapse behaviour', async ({
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
    await expect(headers).toHaveCount(7);

    const labels = (await headers.allTextContents()).map((s) => s.trim()).join(' | ');
    for (const expected of ['Ch1', 'Ch2', 'Ch3', 'Ch4', 'Ch5', 'Ch6', 'Master']) {
      expect(labels, `header for "${expected}" present`).toContain(expected);
    }

    // Default state: every channel collapsed, zero visible rows.
    for (const label of ['Ch1', 'Ch2', 'Ch3', 'Ch4', 'Ch5', 'Ch6', 'Master']) {
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

    // Same check for MIXMSTRS — every declared port stays in the DOM under
    // collapsed sections. Derive the expected count from the registry so it
    // tracks the def (it grew from 4 → 6 channels; hard-coding the number
    // broke this on that change).
    const mmDef = REGISTRY.find((m) => m.type === 'mixmstrs')!;
    const mmExpected = mmDef.inputs.length + mmDef.outputs.length;
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
      `MIXMSTRS exposes all ${mmExpected} handles in the DOM with sections collapsed`,
    ).toBe(mmExpected);
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

/** Drive __connectDragState directly. xyflow's onConnectStart depends
 *  on slow handle hit-tests + a drag-threshold that aren't reliable
 *  under headless Chromium on CI (the assertions below are about the
 *  PatchPanel response to active=true, not xyflow's drag pipeline —
 *  that's covered by cable-drag-panel-lock.spec.ts). */
async function beginDragViaBridge(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __connectDragState?: { begin: () => void };
    };
    w.__connectDragState?.begin();
  });
}

async function endDragViaBridge(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __connectDragState?: { end: () => void };
    };
    w.__connectDragState?.end();
  });
}

test.describe('PatchPanel: nested-section auto-expand during cable drag', () => {
  test('drag cable INTO a nested target port: all sections auto-expand when panel is open during drag', async ({
    page,
  }) => {
    // The headless-Chromium drag pipeline (mousedown on a handle +
    // pointer move past xyflow's drag-threshold) is exercised end-to-
    // end by cable-drag-panel-lock.spec.ts. Here we focus on the
    // PatchPanel-specific contract: when an MM panel is open with a
    // connect-drag in flight, ALL nested sections auto-expand AND a
    // synthetic Svelte Flow connection commit lands on a nested
    // target port (proving the panel and its handles are reachable).
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'mm', type: 'mixmstrs', position: { x: 200, y: 200 } },
    ]);

    // Pin the MIXMSTRS panel open BEFORE the drag so we have a stable
    // geometry. Every section starts collapsed.
    await pinPanelOpen(page, 'mm');
    for (const label of ['Ch1', 'Ch2', 'Ch3', 'Ch4', 'Master']) {
      expect(await sectionExpanded(page, 'mm', label)).toBe(false);
    }

    // Begin the drag via the global bridge — same effect as xyflow's
    // onConnectStart, without depending on the headless-Chromium
    // drag-threshold + handle hit-test pipeline.
    await beginDragViaBridge(page);
    await page.waitForTimeout(120);

    // Every section auto-expanded.
    for (const label of ['Ch1', 'Ch2', 'Ch3', 'Ch4', 'Master']) {
      expect(
        await sectionExpanded(page, 'mm', label),
        `${label} auto-expanded during drag`,
      ).toBe(true);
    }

    // Wait for the expand-all to settle handle geometry — PatchPanel
    // runs updateNodeInternals via a 2-RAF chain.
    await page.waitForTimeout(250);
    const ch1lHandle = page.locator(
      `.svelte-flow__node[data-id="mm"] .svelte-flow__handle[data-handleid="ch1L"][class*="target"]`,
    );
    const tBox = await ch1lHandle.boundingBox();
    expect(tBox, 'ch1L handle has box after auto-expand').toBeTruthy();
    if (!tBox) return;

    // Commit a synthetic edge: write directly to the patch graph (same
    // pattern spawnPatch uses for setup). The point isn't to validate
    // xyflow's drop pipeline — it's that the panel's auto-expanded
    // handles are addressable by id and the patch graph accepts them.
    await page.evaluate(() => {
      const w = window as unknown as {
        __patch: { edges: Record<string, unknown> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        w.__patch.edges['e1'] = {
          id: 'e1',
          source: { nodeId: 'mm', portId: 'master_l' },
          target: { nodeId: 'mm', portId: 'ch1L' },
          sourceType: 'audio',
          targetType: 'audio',
        };
      });
    });

    // End the drag.
    await endDragViaBridge(page);
    await page.waitForTimeout(120);

    const edges = await readEdges(page);
    expect(edges.length, 'one edge created').toBe(1);
    expect(edges[0]!.target).toEqual({ nodeId: 'mm', portId: 'ch1L' });

    // Snapshot restore (after the drag): every drag-only expanded
    // section collapses back to its pre-drag state.
    for (const label of ['Ch1', 'Ch2', 'Ch3', 'Ch4', 'Master']) {
      expect(
        await sectionExpanded(page, 'mm', label),
        `${label} collapses back after drag end (snapshot restore)`,
      ).toBe(false);
    }
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
    // We drive __connectDragState via its global bridge instead of
    // synthesising a full xyflow pointer-drag — the assertions below
    // are about the PatchPanel reacting to active=true, and xyflow's
    // own drag pipeline is covered by cable-drag-panel-lock.spec.ts.
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'mm', type: 'mixmstrs', position: { x: 200, y: 200 } },
    ]);

    // Pin MIXMSTRS open and manually expand Master before the drag.
    await pinPanelOpen(page, 'mm');
    await clickSection(page, 'mm', 'Master');
    expect(await sectionExpanded(page, 'mm', 'Master')).toBe(true);
    expect(await sectionExpanded(page, 'mm', 'Ch1')).toBe(false);

    // Drive the drag state directly via the global bridge.
    await beginDragViaBridge(page);
    await page.waitForTimeout(120);

    // Mid-drag: every section is expanded (drag-time expand-all),
    // including Master which was already manually expanded.
    for (const label of ['Ch1', 'Ch2', 'Ch3', 'Ch4', 'Master']) {
      expect(
        await sectionExpanded(page, 'mm', label),
        `${label} expanded mid-drag (expand-all)`,
      ).toBe(true);
    }

    // End the drag (no commit).
    await endDragViaBridge(page);
    await page.waitForTimeout(120);

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
      { id: 'mm', type: 'mixmstrs', position: { x: 200, y: 200 } },
    ]);

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

    // Drive the drag state directly via the global bridge.
    await beginDragViaBridge(page);
    await page.waitForTimeout(120);

    // Mid-drag: every section is expanded.
    for (const label of ['Ch1', 'Ch2', 'Ch3', 'Ch4', 'Master']) {
      expect(
        await sectionExpanded(page, 'mm', label),
        `${label} expanded mid-drag`,
      ).toBe(true);
    }

    // End the drag (no commit).
    await endDragViaBridge(page);
    await page.waitForTimeout(120);

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
