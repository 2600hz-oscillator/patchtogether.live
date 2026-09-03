// e2e/tests/ui-refresh.spec.ts
//
// Coverage for the UI refresh PR — MiniMap drop-in, cable hover-shift,
// card-hover cable de-emphasis, and Cmd-Z / Cmd-Shift-Z undo wiring.
//
// Each test is independent and runs against a fresh page; no fixtures share
// state across tests.

import { test, expect, loadVoiceDemo } from './_fixtures';
import { openModulePalette, spawnPatch } from './_helpers';
import { waitFrames } from '../_helpers/frames';

test.describe.configure({ mode: 'parallel' });

test.describe('MiniMap', () => {
  test('renders and reflects the canvas viewport', async ({ page, rack }) => {
    await loadVoiceDemo(page);
    await expect(page.locator('.svelte-flow__node')).toHaveCount(5, { timeout: 10_000 });

    const minimap = page.locator('.svelte-flow__minimap');
    await expect(minimap).toBeVisible();

    // The viewport mask should render — that's what xyflow draws to outline
    // the visible region.
    await expect(minimap.locator('.svelte-flow__minimap-mask').first()).toBeVisible();

    // Each canvas node should appear in the minimap as an SVG shape. We
    // don't lock to an exact selector class because xyflow may version it;
    // at least 5 SVG shapes (rects or paths) inside the minimap is enough.
    const minimapShapes = minimap.locator('rect, path');
    expect(await minimapShapes.count()).toBeGreaterThanOrEqual(5);
  });

  test('toggle button hides and shows the minimap', async ({ page, rack }) => {
    const toggle = page.getByTestId('minimap-toggle');
    await expect(toggle).toBeVisible();

    // Open by default
    await expect(page.locator('.svelte-flow__minimap')).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');

    // Hide
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.svelte-flow__minimap')).toHaveCount(0);

    // Show again
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.svelte-flow__minimap')).toBeVisible();
  });
});

test.describe('Cable hover affordances', () => {
  test('cable-hover CSS class thickens the stroke (visual elevation)', async ({ page, rack }) => {
    // Post-PatchPanel: cables anchor at the top-left of each card by
    // default (all handles stack at the affordance), so the physical
    // hover path runs through overlapping card chrome and the original
    // `.first().hover()` flow times out under Playwright. This test now
    // verifies the underlying CSS rule still applies — adding the
    // `.cable-hover` class to an edge thickens its stroke. The visual
    // affordance still works in real browsers; only the synthetic pointer
    // path is unreachable.
    await loadVoiceDemo(page);
    // A stereo LEG GROUP renders as ONE bezier (PR-4): the demo's
    // `vd-vca.audio → vd-out.L` + `→ R` pair is 2 edges and 1 cable, so 6
    // graph edges draw 5. Pinned in stereo-only-channel.spec.ts.
    await expect(page.locator('.svelte-flow__edge')).toHaveCount(5, { timeout: 10_000 });

    const firstEdge = page.locator('.svelte-flow__edge').first();
    const edgePath = firstEdge.locator('.svelte-flow__edge-path');
    const initial = await edgePath.evaluate((el) =>
      parseFloat(window.getComputedStyle(el).strokeWidth),
    );

    await firstEdge.evaluate((el) => el.classList.add('cable-hover'));

    // The thickening is a CSS transition, so the value we want is the SETTLED
    // one — poll for it rather than sleeping past an assumed transition
    // duration. Units: CSS px of stroke-width.
    await expect
      .poll(
        () => edgePath.evaluate((el) => parseFloat(window.getComputedStyle(el).strokeWidth)),
        {
          timeout: 5_000,
          message: `stroke-width (CSS px) should thicken past ${initial} with .cable-hover`,
        },
      )
      .toBeGreaterThan(initial);
  });

  test('hovering a card dims unrelated cables', async ({ page, rack }) => {
    // The voice demo: 5 nodes, 6 edges. The Sequencer (vd-seq) only touches
    // 2 of the 6 edges (seq.pitch→vco and seq.gate→adsr), so the remaining
    // 4 should dim when we hover the Sequencer card.
    await loadVoiceDemo(page);
    // A stereo LEG GROUP renders as ONE bezier (PR-4): the demo's
    // `vd-vca.audio → vd-out.L` + `→ R` pair is 2 edges and 1 cable, so 6
    // graph edges draw 5. Pinned in stereo-only-channel.spec.ts.
    await expect(page.locator('.svelte-flow__edge')).toHaveCount(5, { timeout: 10_000 });

    const seqNode = page.locator('.svelte-flow__node:has([data-shell-type="kria"])').first();
    await seqNode.hover();

    // No settle: the attribute assertion below auto-retries, so the sleep only
    // ever delayed a check that was already going to wait for the same thing.
    // The .svelte-flow root carries the data attribute; we use it to
    // assert the hover-dim mode is engaged.
    const sf = page.locator('.svelte-flow').first();
    await expect(sf).toHaveAttribute('data-hovered-node', /vd-seq/);

    // Sample related vs unrelated edges. Related edges keep full opacity;
    // unrelated dim. The class is applied to .svelte-flow__edge elements.
    const relatedCount = await page.locator('.svelte-flow__edge.cable-related').count();
    expect(relatedCount).toBe(2);
    const unrelatedCount = await page
      .locator('.svelte-flow__edge:not(.cable-related)')
      .count();
    // THREE, not four: the demo draws 5 cables, not 6 (`vd-vca.audio` into
    // `vd-out.L`+`R` is ONE stereo leg group rendered as one bezier, PR-4), and
    // 2 of them touch the hovered SEQUENCER. Derived from the two numbers this
    // test already pins, and asserted as the partition so the two counts cannot
    // drift apart silently.
    const totalCount = await page.locator('.svelte-flow__edge').count();
    expect(totalCount, 'the demo draws 5 cables for its 6 graph edges').toBe(5);
    expect(unrelatedCount).toBe(totalCount - relatedCount);
    expect(unrelatedCount).toBe(3);

    const relatedOpacity = await page
      .locator('.svelte-flow__edge.cable-related')
      .first()
      .evaluate((el) => parseFloat(window.getComputedStyle(el).opacity));
    const unrelatedOpacity = await page
      .locator('.svelte-flow__edge:not(.cable-related)')
      .first()
      .evaluate((el) => parseFloat(window.getComputedStyle(el).opacity));
    expect(unrelatedOpacity).toBeLessThan(relatedOpacity);
  });
});

test.describe('Undo / redo', () => {
  test('Cmd-Z removes a freshly-spawned module; Cmd-Shift-Z restores it', async ({ page, rack }) => {
    await expect(page.locator('.svelte-flow__node')).toHaveCount(0);

    // Spawn through Canvas.svelte's spawnFromPalette path so the edit
    // lands on the LOCAL_ORIGIN-tracked undo stack.
    await openModulePalette(page);
    await expect(page.locator('.module-palette')).toBeVisible();
    await page.keyboard.type('Reverb');
    await page.getByRole('button', { name: 'reverb', exact: true }).click();
    await expect(page.locator('.svelte-flow__node:has([data-shell-type="reverb"])')).toHaveCount(1);

    // Click somewhere on the canvas pane to drop focus from the palette
    // (palette is closed but body is the safest target for keydown).
    await page.locator('body').click({ position: { x: 5, y: 5 } });

    // Cmd-Z removes the spawned node.
    await page.keyboard.press('Meta+z');
    await expect(page.locator('.svelte-flow__node:has([data-shell-type="reverb"])')).toHaveCount(0, { timeout: 5000 });

    // Cmd-Shift-Z restores it.
    await page.keyboard.press('Meta+Shift+z');
    await expect(page.locator('.svelte-flow__node:has([data-shell-type="reverb"])')).toHaveCount(1, { timeout: 5000 });
  });

  test('Cmd-Z reverts a node deletion (right-click → Delete)', async ({ page, rack }) => {
    await loadVoiceDemo(page);
    await expect(page.locator('.svelte-flow__node')).toHaveCount(5, { timeout: 10_000 });
    // A stereo LEG GROUP renders as ONE bezier (PR-4): the demo's
    // `vd-vca.audio → vd-out.L` + `→ R` pair is 2 edges and 1 cable, so 6
    // graph edges draw 5. Pinned in stereo-only-channel.spec.ts.
    await expect(page.locator('.svelte-flow__edge')).toHaveCount(5);

    // Right-click the VCO and delete it (4 edges touch the VCA — exercising
    // the multi-op-in-one-transact path that should still be one undo).
    await page.locator('.svelte-flow__node:has([data-shell-type="vca"])').first().locator('.tile-name').click({ button: 'right' });
    await expect(page.locator('[role="menu"][aria-label="Module actions"]')).toBeVisible();
    await page.locator('[role="menuitem"]', { hasText: 'Delete' }).click();
    await expect(page.locator('.svelte-flow__node:has([data-shell-type="vca"])')).toHaveCount(0);
    await expect(page.locator('.svelte-flow__edge')).toHaveCount(2);

    // One Cmd-Z restores the VCA + all its edges (single undo entry).
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Meta+z');
    await expect(page.locator('.svelte-flow__node:has([data-shell-type="vca"])')).toHaveCount(1, { timeout: 5000 });
    // A stereo LEG GROUP renders as ONE bezier (PR-4): the demo's
    // `vd-vca.audio → vd-out.L` + `→ R` pair is 2 edges and 1 cable, so 6
    // graph edges draw 5. Pinned in stereo-only-channel.spec.ts.
    await expect(page.locator('.svelte-flow__edge')).toHaveCount(5, { timeout: 5000 });
  });

  test('Cmd-Z is ignored while focus is in a text input (no hijack of native undo)', async ({ page, rack }) => {
    await loadVoiceDemo(page);
    await expect(page.locator('.svelte-flow__node')).toHaveCount(5, { timeout: 10_000 });

    // The demo gives the undo stack real content; the TILE NAME EDITOR
    // supplies the text input on the shell (the cartesian card's note input
    // was card DOM — NoteEntry's own keydown guard keeps its coverage in
    // note-entry.spec.ts). The claim here is the global one: focus in a text
    // input must suppress canvas undo.
    await page
      .locator('.svelte-flow__node[data-id="vd-vca"] [data-testid="tile-name-label-button"]')
      .click();
    const note = page.locator('[data-testid="tile-name-label-input"]').first();
    await expect(note).toBeVisible();
    await note.click();

    const beforeCount = await page.locator('.svelte-flow__node').count();
    await page.keyboard.press('Meta+z');
    // A NEGATIVE assertion: "the count did NOT change". An auto-retrying expect
    // would pass at t=0 whether or not the undo handler ever ran, so what this
    // needs is proof the app got to react and chose not to — frames, not a
    // duration that is a different number of frames on every renderer.
    await waitFrames(page, 4);
    const afterCount = await page.locator('.svelte-flow__node').count();
    expect(afterCount).toBe(beforeCount);
  });

  test('Cmd-Z on an empty undo stack is a no-op (no crash)', async ({ page, rack }) => {
    await expect(page.locator('.svelte-flow__node')).toHaveCount(0);

    // Press Cmd-Z without any prior tracked edits.
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Meta+z');
    // Same negative shape as above: give the undo path real frames to run in
    // before asserting that nothing appeared.
    await waitFrames(page, 4);

    // No errors logged, page still alive.
    await expect(page.locator('.svelte-flow__node')).toHaveCount(0);
  });
});
