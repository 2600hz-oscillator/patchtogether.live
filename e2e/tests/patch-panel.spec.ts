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

  test('two-column layout: inputs render left, outputs render right (ADSR)', async ({ page }) => {
    // The two-column open-state layout splits ports across two visible
    // grid columns: inputs on the left, outputs on the right. Both
    // columns are testid-tagged so positional assertions don't depend
    // on pixel measurements (which would flake under CSS shifts).
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [{ id: 'adsr', type: 'adsr', position: { x: 200, y: 200 } }]);
    await openPanel(page, 'adsr');

    const inputsCol = page.locator(
      `.svelte-flow__node[data-id="adsr"] [data-testid="patch-panel-inputs"]`,
    );
    const outputsCol = page.locator(
      `.svelte-flow__node[data-id="adsr"] [data-testid="patch-panel-outputs"]`,
    );
    await expect(inputsCol).toHaveCount(1);
    await expect(outputsCol).toHaveCount(1);

    // ADSR inputs: GATE / ATTACK / DECAY / SUSTAIN / RELEASE.
    const inputLabels = (await inputsCol
      .locator('[data-testid="port-row-label"]')
      .allTextContents()).map((s) => s.trim());
    expect(inputLabels).toContain('GATE');
    expect(inputLabels).toContain('ATTACK');
    // ADSR output: ENVELOPE — must NOT live in inputs column.
    expect(inputLabels).not.toContain('ENVELOPE');

    const outputLabels = (await outputsCol
      .locator('[data-testid="port-row-label"]')
      .allTextContents()).map((s) => s.trim());
    expect(outputLabels).toContain('ENVELOPE');
    expect(outputLabels).not.toContain('GATE');

    // Geometric sanity: outputs column is to the RIGHT of inputs column.
    const inputsBox = await inputsCol.boundingBox();
    const outputsBox = await outputsCol.boundingBox();
    expect(inputsBox).toBeTruthy();
    expect(outputsBox).toBeTruthy();
    if (!inputsBox || !outputsBox) return;
    expect(outputsBox.x, 'outputs column starts to the right of inputs column').toBeGreaterThan(
      inputsBox.x + inputsBox.width / 2,
    );
  });

  test('MIXMSTRS: dense panel (49 inputs) fits on a 1366×768 viewport', async ({ page }) => {
    // The whole point of the two-column layout: MIXMSTRS has 49 input
    // ports (12 audio: 6 stereo pairs + 37 CV: 9 params × 4 channels +
    // master). On a single column with 22px-tall rows + headers, the
    // panel was ~1500px tall and overflowed the viewport. With two
    // columns + per-column scroll, the panel must fit within the
    // viewport bounds.
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
    expect(box, 'MIXMSTRS panel has a bounding box').toBeTruthy();
    if (!box) return;

    // Panel must fit within the viewport (height) and not exceed 80%
    // of the viewport width.
    expect(box.height, 'MIXMSTRS panel height fits within viewport').toBeLessThanOrEqual(768);
    expect(box.width, 'MIXMSTRS panel width <= 80% viewport').toBeLessThanOrEqual(
      Math.round(1366 * 0.8) + 2,
    );

    // All input ports are in the DOM under the inputs column (the I/O
    // spec test covers exact-id matching; here we just confirm the
    // 2-column architecture didn't drop anything). MIXMSTRS exposes
    // 12 audio + 37 CV per the def; we use >= to stay flexible if the
    // module's port surface grows.
    const inputsCol = page.locator(
      `.svelte-flow__node[data-id="mm"] [data-testid="patch-panel-inputs"]`,
    );
    const inputCount = await inputsCol.locator('[data-testid="port-row-label"]').count();
    expect(inputCount, 'MIXMSTRS: dense input column populated').toBeGreaterThanOrEqual(49);
  });

  test('RIOTGIRLS: dense sectioned panel (55 inputs) fits on a 1366×768 viewport', async ({
    page,
  }) => {
    // Same fit-on-laptop guarantee for the sectioned grouping path
    // (RIOTGIRLS is the densest case: 4 voice sections + master FX,
    // 55 inputs total). All sections live in the inputs column;
    // outL/outR live in the outputs column.
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [{ id: 'rg', type: 'riotgirls', position: { x: 100, y: 100 } }]);
    await openPanel(page, 'rg');

    const panel = page.locator(
      `.svelte-flow__node[data-id="rg"] [data-testid="patch-panel"]`,
    );
    const box = await panel.boundingBox();
    expect(box, 'RIOTGIRLS panel has a bounding box').toBeTruthy();
    if (!box) return;

    expect(box.height, 'RIOTGIRLS panel height fits within viewport').toBeLessThanOrEqual(768);
    expect(box.width, 'RIOTGIRLS panel width <= 80% viewport').toBeLessThanOrEqual(
      Math.round(1366 * 0.8) + 2,
    );

    const inputsCol = page.locator(
      `.svelte-flow__node[data-id="rg"] [data-testid="patch-panel-inputs"]`,
    );
    const outputsCol = page.locator(
      `.svelte-flow__node[data-id="rg"] [data-testid="patch-panel-outputs"]`,
    );
    const inputCount = await inputsCol.locator('[data-testid="port-row-label"]').count();
    const outputCount = await outputsCol.locator('[data-testid="port-row-label"]').count();
    expect(inputCount, 'RIOTGIRLS: dense input column populated').toBeGreaterThanOrEqual(55);
    expect(outputCount, 'RIOTGIRLS: outL + outR in right column').toBe(2);
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

  test('open-panel: cable visually plugs into handle hole (not occluded by panel chrome)', async ({
    page,
  }) => {
    // User report: "patch cables need to stick into the holes they go to,
    // it's unclear now because they are under the panel". Before this fix
    // the target handle's CENTRE sat ~9px inside the panel chrome
    // (panel.left + panel.padding-left - half-handle), so the last ~9px
    // of the cable approach was painted UNDERNEATH the opaque panel
    // background (rgba(14,17,22,0.97)) and the user saw cables stop at
    // the panel border instead of reaching the visible ○ ring icons.
    //
    // Fix: handles now anchor with their visible centre AT the panel's
    // outer border line — half of the ring sits OUTSIDE the panel chrome
    // (where the cable terminates without occlusion) and half inside.
    // This regression locks the geometry: with the target panel open,
    // the cable's TARGET endpoint must be within ~3px of the target
    // handle's centre, AND the handle's centre must be within ~6px of
    // the panel's outer left border (i.e. NOT 9+ px inside it).
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Wire LFO out → ADSR attack input. We want the *target* side
    // because the bug is most obvious for inputs (the user's screenshot
    // showed input cables disappearing into the panel left edge).
    await spawnPatch(
      page,
      [
        { id: 'lfo', type: 'lfo', position: { x: 100, y: 100 } },
        { id: 'adsr', type: 'adsr', position: { x: 600, y: 100 } },
      ],
      [
        {
          id: 'e1',
          from: { nodeId: 'lfo', portId: 'phase0' },
          to: { nodeId: 'adsr', portId: 'attack' },
          sourceType: 'cv',
          targetType: 'cv',
        },
      ],
    );

    await expect(
      page.locator(`.svelte-flow__edge[data-id="e1"] .svelte-flow__edge-path`),
    ).toHaveCount(1);

    // Open the ADSR panel (target side) so the attack handle sits in
    // its open-state row position, not the closed-state corner stack.
    // PatchPanel's $effect calls useUpdateNodeInternals after two RAF
    // ticks (so CSS transitions land before measurement); wait a beat
    // longer here so xyflow has fully re-routed the cable to the new
    // handle position before we sample the path endpoint.
    await openPanel(page, 'adsr');
    await page.waitForTimeout(250);

    const panel = page.locator(
      `.svelte-flow__node[data-id="adsr"] [data-testid="patch-panel"]`,
    );
    const panelBox = await panel.boundingBox();
    expect(panelBox, 'open panel has a box').toBeTruthy();
    if (!panelBox) return;

    const targetHandle = page.locator(
      `.svelte-flow__node[data-id="adsr"] .svelte-flow__handle[data-handleid="attack"][class*="target"]`,
    );
    const handleBox = await targetHandle.boundingBox();
    expect(handleBox, 'attack handle has a box').toBeTruthy();
    if (!handleBox) return;

    const handleCx = handleBox.x + handleBox.width / 2;
    const handleCy = handleBox.y + handleBox.height / 2;

    // Invariant 1 — the visible ring icon is reachable: its centre must
    // sit at (or just outside) the panel's outer left border, NOT 9+ px
    // inside it where the panel chrome would occlude the cable approach.
    //
    // Why "half-handle-width" as the tolerance: the user's complaint was
    // "cables stop at the panel border" — i.e. the cable's last segment
    // lands inside the panel chrome and gets occluded. A handle centred
    // exactly on the border is the borderline case (half the ring sticks
    // outside, half inside); centred half-a-handle inside is the largest
    // offset that still leaves the ring's leftmost edge on the visible
    // chrome edge for the cable to terminate against. The bounding-box
    // thresholds use handleBox.width (which absorbs the canvas zoom) so
    // the assertion is invariant under default-zoom changes.
    const halfHandle = handleBox.width / 2;
    const insideOffset = handleCx - panelBox.x;
    expect(
      insideOffset,
      `handle centre must be at/near the panel's outer left border (got ${insideOffset}px inside panel.left, max ${halfHandle}px); larger means cable approach is occluded by panel chrome`,
    ).toBeLessThanOrEqual(halfHandle);

    // Allow the handle to protrude outward — a "jack on the front
    // panel" affordance — but not so far that it loses association
    // with its label row (cap at one full handle width outside).
    expect(
      insideOffset,
      `handle centre must not float far outside the panel (got ${insideOffset}px from panel.left)`,
    ).toBeGreaterThanOrEqual(-handleBox.width);

    // Invariant 2 — the cable's TARGET endpoint must visibly terminate
    // at or past the panel's outer border line, so the user perceives
    // the cable "plugging into" the visible ring icon. xyflow computes
    // edge endpoints from `handleBounds.left + node.positionAbsolute`
    // (Position.Left) at the moment of `useUpdateNodeInternals`, so the
    // endpoint typically tracks the handle's left edge rather than its
    // centre — we therefore assert "endpoint within one handle-width of
    // the handle area" + "endpoint NOT pulled inward of the panel
    // border" rather than pixel-exact centre coincidence.
    const edgePath = page
      .locator(`.svelte-flow__edge[data-id="e1"] .svelte-flow__edge-path`)
      .first();
    const targetEndpoint = await edgePath.evaluate((el) => {
      const path = el as SVGPathElement;
      const len = path.getTotalLength();
      const local = path.getPointAtLength(len);
      const ctm = path.getScreenCTM();
      if (!ctm) return null;
      const pt = (path.ownerSVGElement ?? path).createSVGPoint();
      pt.x = local.x;
      pt.y = local.y;
      const screen = pt.matrixTransform(ctm);
      return { x: screen.x, y: screen.y };
    });
    expect(targetEndpoint, 'edge has parseable target endpoint').not.toBeNull();
    if (!targetEndpoint) return;

    // The endpoint must be at or LEFT of the panel's outer left border
    // (i.e. NOT pulled inward by 10+ px the way the bug had it). One
    // handle-width of inward-tolerance covers xyflow's left-edge vs
    // centre semantics; anything more means the user sees the cable
    // disappear into the panel chrome (the original bug).
    const inwardOffset = targetEndpoint.x - panelBox.x;
    expect(
      inwardOffset,
      `cable target endpoint must terminate at/left of the panel border (got ${inwardOffset}px inside panel.left, max ${handleBox.width}px)`,
    ).toBeLessThanOrEqual(handleBox.width);

    // The endpoint must also be vertically aligned with the handle row
    // (otherwise the cable misses the visible hole entirely).
    const ey = Math.abs(targetEndpoint.y - handleCy);
    expect(
      ey,
      `cable target endpoint y must align with handle row centre (got dy=${ey}px)`,
    ).toBeLessThan(handleBox.height);

    // Symmetric check on the SOURCE side (LFO output panel): open the
    // source panel and assert the same "handle centre at panel border"
    // invariant for an output handle.
    await openPanel(page, 'lfo');
    const lfoPanel = page.locator(
      `.svelte-flow__node[data-id="lfo"] [data-testid="patch-panel"]`,
    );
    const lfoPanelBox = await lfoPanel.boundingBox();
    if (!lfoPanelBox) return;

    const sourceHandle = page.locator(
      `.svelte-flow__node[data-id="lfo"] .svelte-flow__handle[data-handleid="phase0"][class*="source"]`,
    );
    const sourceBox = await sourceHandle.boundingBox();
    if (!sourceBox) return;

    const sourceCx = sourceBox.x + sourceBox.width / 2;
    const sourceHalfHandle = sourceBox.width / 2;
    const sourceInsideOffset = lfoPanelBox.x + lfoPanelBox.width - sourceCx;
    expect(
      sourceInsideOffset,
      `output handle centre must be at/near the panel's outer right border (got ${sourceInsideOffset}px inside panel.right, max ${sourceHalfHandle}px)`,
    ).toBeLessThanOrEqual(sourceHalfHandle);
    expect(
      sourceInsideOffset,
      `output handle centre must not float far outside the panel (got ${sourceInsideOffset}px from panel.right)`,
    ).toBeGreaterThanOrEqual(-sourceBox.width);
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

  test('top-right click anchors panel to right corner; top-left click anchors to left', async ({
    page,
  }) => {
    // The popover should pop down from whichever corner the user
    // activated. The previous behavior (always anchored top-left) made
    // the right trigger feel disconnected — clicking it spawned the
    // panel under the OPPOSITE corner.
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // RIOTGIRLS is wide (panelWidth: 600) — the gap between left and
    // right anchors is dramatic enough to assert with confidence on
    // any viewport.
    await spawnPatch(page, [{ id: 'rg', type: 'riotgirls', position: { x: 100, y: 100 } }]);

    const leftTrigger = page.locator(
      `.svelte-flow__node[data-id="rg"] [data-testid="patch-trigger"]`,
    );
    const rightTrigger = page.locator(
      `.svelte-flow__node[data-id="rg"] [data-testid="patch-trigger-right"]`,
    );
    const panel = page.locator(
      `.svelte-flow__node[data-id="rg"] [data-testid="patch-panel"]`,
    );

    // Click left → panel anchors top-left (its LEFT edge sits under
    // the left trigger; the panel grows rightward).
    await leftTrigger.click();
    await expect(panel).toHaveAttribute('aria-hidden', 'false');
    await expect(panel).toHaveAttribute('data-anchor-corner', 'topLeft');

    const leftBox = await leftTrigger.boundingBox();
    const panelBoxLeftAnchor = await panel.boundingBox();
    expect(leftBox && panelBoxLeftAnchor, 'have boxes').toBeTruthy();
    if (!leftBox || !panelBoxLeftAnchor) return;
    // Panel's left edge must be near the left trigger's left edge.
    expect(
      Math.abs(panelBoxLeftAnchor.x - leftBox.x),
      `topLeft anchor: panel.left ~= leftTrigger.left (panel.x=${panelBoxLeftAnchor.x}, trigger.x=${leftBox.x})`,
    ).toBeLessThan(20);

    // Outside click to dismiss the pinned panel before the next test
    // step (also clears the post-click hold, per spec).
    await page.mouse.click(20, 20);
    await page.waitForTimeout(100);
    await expect(panel).toHaveAttribute('aria-hidden', 'true');

    // Click right → panel anchors top-right (its RIGHT edge sits
    // under the right trigger; the panel grows leftward).
    await rightTrigger.click();
    await expect(panel).toHaveAttribute('aria-hidden', 'false');
    await expect(panel).toHaveAttribute('data-anchor-corner', 'topRight');

    const rightBox = await rightTrigger.boundingBox();
    const panelBoxRightAnchor = await panel.boundingBox();
    expect(rightBox && panelBoxRightAnchor, 'have boxes').toBeTruthy();
    if (!rightBox || !panelBoxRightAnchor) return;
    // Panel's RIGHT edge must be near the right trigger's right edge.
    const panelRight = panelBoxRightAnchor.x + panelBoxRightAnchor.width;
    const triggerRight = rightBox.x + rightBox.width;
    expect(
      Math.abs(panelRight - triggerRight),
      `topRight anchor: panel.right ~= rightTrigger.right (panel.right=${panelRight}, trigger.right=${triggerRight})`,
    ).toBeLessThan(20);

    // And the panel should now sit further to the right than when it
    // was anchored from the left trigger — concrete evidence the
    // anchor point shifted.
    expect(
      panelBoxRightAnchor.x,
      `right-anchored panel must start to the right of left-anchored panel (right=${panelBoxRightAnchor.x}, left=${panelBoxLeftAnchor.x})`,
    ).toBeGreaterThan(panelBoxLeftAnchor.x + 50);
  });

  test('click triggers a 300ms post-click hold; panel survives mouseleave inside the window', async ({
    page,
  }) => {
    // After CLICK (release), the panel must persist for at least 300ms
    // even if the mouse leaves the trigger and panel — so the user can
    // navigate from the click target down to a port without the panel
    // snapping shut. After the 300ms expires, the normal 200ms hover-
    // close grace resumes.
    //
    // The first click pins the panel (pinned=true), which would mask
    // the 300ms hold's effect. To isolate the post-click hold, we
    // double-click the trigger: the second click unpins, and the hold
    // is the ONLY remaining keep-open driver.
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [{ id: 'adsr', type: 'adsr', position: { x: 200, y: 200 } }]);

    const trigger = page.locator(
      `.svelte-flow__node[data-id="adsr"] [data-testid="patch-trigger"]`,
    );
    const panel = page.locator(
      `.svelte-flow__node[data-id="adsr"] [data-testid="patch-panel"]`,
    );

    // Click 1 → pins.
    await trigger.click();
    await expect(panel).toHaveAttribute('aria-hidden', 'false');
    // Click 2 → unpins. Now ONLY the post-click hold (and maybe hover)
    // can keep it open.
    await trigger.click();
    // Mouse off immediately after the click release.
    await page.mouse.move(20, 20);

    // After 250ms (longer than the 200ms hover-close grace would take
    // WITHOUT the hold) the panel must STILL be open — proving the
    // 300ms hold is what's keeping it alive. Without the hold, the
    // mouseleave-scheduled close at +200ms would have already fired.
    await page.waitForTimeout(250);
    await expect(
      panel,
      'panel still open at +250ms (past the 200ms hover-grace) thanks to the 300ms post-click hold',
    ).toHaveAttribute('aria-hidden', 'false');

    // After the 300ms hold + 200ms hover-close grace expire, the panel
    // must close. Total wait from the 2nd click: 300+200 = 500ms; we
    // already waited 250ms, so wait ~450ms more for safety on slow CI.
    await page.waitForTimeout(450);
    await expect(panel, 'panel closes after the 300ms hold + 200ms grace expire').toHaveAttribute(
      'aria-hidden',
      'true',
    );
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
    // Mirror aut-patch-panel.spec.ts: 25 intermediate steps so Svelte
    // Flow's drag tracker reliably sees the pointermove sequence on
    // slower CI runners (a coarser drag was observed to skip handle
    // hit-tests and leave the connection unformed). With this PR
    // moving handles outward by ~9px, the drag path is slightly
    // longer; bumping steps keeps the per-step delta inside xyflow's
    // hit-test bucket.
    await page.mouse.move(tBox.x + tBox.width / 2, tBox.y + tBox.height / 2, { steps: 25 });

    // Mid-drag: the source panel is still open (pinned + stayOpenForDrag).
    const seqPanel = page.locator(
      `.svelte-flow__node[data-id="seq"] [data-testid="patch-panel"]`,
    );
    await expect(seqPanel).toHaveAttribute('aria-hidden', 'false');

    await page.mouse.up();
    // Same 150ms post-mouseup beat the AUT spec uses to give xyflow's
    // connect-end handler time to commit the new edge before we assert.
    await page.waitForTimeout(150);

    // Assert connection landed.
    const newEdge = page.locator(
      `.svelte-flow__edge[data-id*="seq-gate-adsr-gate"]`,
    );
    await expect(newEdge).toHaveCount(1);
  });
});
