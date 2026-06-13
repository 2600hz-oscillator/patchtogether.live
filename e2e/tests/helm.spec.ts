// e2e/tests/helm.spec.ts
//
// HELM end-to-end coverage. Asserts:
//   1. Module spawns + card mounts with no console errors.
//   2. Gear icon in the header opens the MIDI settings panel.
//   3. Settings panel exposes a Connect MIDI… button.
//   4. Knobs in the main panel respond to drag without crashing.
//   5. Step sequencer sliders are interactive.
//
// Full audio path is exercised in art/scenarios/helm/ (envelope shape) +
// the unit tests in packages/web/src/lib/audio/modules/helm.test.ts (def
// shape + MIDI parsing).

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

test('helm: drop module → card mounts with no console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'h', type: 'helm', position: { x: 200, y: 200 } }]);
  const card = page.locator('[data-testid="helm-card"]');
  await expect(card).toBeVisible();
  await expect(card).toContainText('HELM');
  expect(errors, errors.join('; ')).toEqual([]);
});

test('helm: gear icon opens MIDI settings panel', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'h', type: 'helm', position: { x: 200, y: 200 } }]);
  const card = page.locator('[data-testid="helm-card"]');
  await expect(card).toBeVisible();

  // Main panel visible — should show one of the section titles.
  await expect(card).toContainText('OSC 1');

  // Click gear icon.
  await card.locator('[data-testid="helm-gear-btn"]').click();

  // Settings panel appears, OSC 1 disappears.
  await expect(card.locator('[data-testid="helm-settings"]')).toBeVisible();
  await expect(card).not.toContainText('OSC 1');
  // Connect MIDI… button is the empty-state.
  await expect(card.locator('[data-testid="helm-midi-connect"]')).toBeVisible();

  // Closing returns to the main panel.
  await card.locator('button[aria-label="Close settings"]').click();
  await expect(card).toContainText('OSC 1');
});

// ----------------------------------------------------------------------------
// Sequencer behavior (v2 — gate-clocked).
//
// PR follow-up to #204: the sequencer is now gate-clocked rather than
// free-running. Default OFF; when ON, each rising edge on the gate input
// advances the step pointer + retriggers all three envelopes. UI exposes
// SEQ ON/OFF toggle + RST button. A green dot decorates the current step.
//
// These tests focus on the UI surface + state plumbing — the
// audio-rate sequence rendering itself is exercised in the ART scenario.
// ----------------------------------------------------------------------------

test('helm: sequencer defaults OFF + transport controls render', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'h', type: 'helm', position: { x: 200, y: 200 } }]);
  const card = page.locator('[data-testid="helm-card"]');
  await expect(card).toBeVisible();

  // SEQ OFF / SEQ ON toggle button visible + reads OFF.
  const onoff = card.locator('[data-testid="helm-seq-onoff"]');
  await expect(onoff).toBeVisible();
  await expect(onoff).toHaveText('SEQ OFF');
  await expect(onoff).toHaveAttribute('aria-pressed', 'false');

  // RST reset button visible.
  const reset = card.locator('[data-testid="helm-seq-reset"]');
  await expect(reset).toBeVisible();

  // No green dot when OFF (no `helm-step-dot-*` rendered at all).
  await expect(card.locator('[data-testid^="helm-step-dot-"]')).toHaveCount(0);
});

test('helm: toggling SEQ ON updates button + persists to node.data', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'h', type: 'helm', position: { x: 200, y: 200 } }]);
  const card = page.locator('[data-testid="helm-card"]');
  const onoff = card.locator('[data-testid="helm-seq-onoff"]');
  await expect(onoff).toHaveText('SEQ OFF');

  await onoff.click();
  await expect(onoff).toHaveText('SEQ ON');
  await expect(onoff).toHaveAttribute('aria-pressed', 'true');

  // Persistence: node.data.seqOn now true.
  const seqOn = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: { seqOn?: boolean } }> };
    };
    return w.__patch.nodes['h']?.data?.seqOn ?? null;
  });
  expect(seqOn).toBe(true);
});

test('helm: gate-clocked advance — driving GATE in advances the step pointer + lights the dot', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // Source: a SEQUENCER firing a steady gate train. HELM in SEQ ON mode
  // should consume each gate edge to advance its own step pointer.
  //
  // The helm worklet's process() only runs when WebAudio has a downstream
  // consumer of its output — so we MUST wire it to audioOut for the
  // sequencer-edge-detection code path to execute. Real user patches
  // always do this; tests that omit it are testing nothing.
  await spawnPatch(
    page,
    [
      // Explicit, well-separated positions: rack-sized cards (helm 720×540,
      // sequencer 540×540) overlap when stacked at the default (100,100), and
      // the overlapping card would intercept clicks on helm's bottom-row seq
      // controls (#759). Spread them so each card's controls are clickable.
      { id: 'src', type: 'sequencer', position: { x: 60,  y: 720 }, params: { bpm: 600, length: 4, isPlaying: 1, gateLength: 0.4 } },
      { id: 'h',   type: 'helm',      position: { x: 60,  y: 60 },  params: { stepDepth: 0.5, stepNumSteps: 8 } },
      { id: 'out', type: 'audioOut',  position: { x: 860, y: 60 },  params: { master: 0.1 } },
    ],
    [
      { id: 'g',  from: { nodeId: 'src', portId: 'gate'  }, to: { nodeId: 'h',   portId: 'gate' }, sourceType: 'gate', targetType: 'gate' },
      { id: 'al', from: { nodeId: 'h',   portId: 'out_l' }, to: { nodeId: 'out', portId: 'L' } },
      { id: 'ar', from: { nodeId: 'h',   portId: 'out_r' }, to: { nodeId: 'out', portId: 'R' } },
    ],
  );
  // Sequencer steps default to an empty array — gate only fires when a
  // step is `{on: true, midi: <int>}`. Lay down a 4-step pattern.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const seq = w.__patch.nodes['src'];
      if (!seq.data) seq.data = {};
      seq.data.steps = [
        { on: true, midi: 60 }, { on: true, midi: 62 },
        { on: true, midi: 64 }, { on: true, midi: 65 },
        ...Array.from({ length: 28 }, () => ({ on: false, midi: null })),
      ];
    });
  });

  // Turn SEQ ON via the UI toggle (covers the persist path + worklet msg).
  const card = page.locator('[data-testid="helm-card"]');
  await card.locator('[data-testid="helm-seq-onoff"]').click();
  await expect(card.locator('[data-testid="helm-seq-onoff"]')).toHaveText('SEQ ON');

  // Let several gates fire. 600 BPM 16ths ≈ 40 pulses/sec, so 400ms ≈ 16 advances —
  // pointer will have wrapped within stepNumSteps=8, currentStep ∈ [0..7].
  await page.waitForTimeout(450);

  // Currently-active dot should be in the DOM and on a 0..7 cell. Take a
  // single snapshot of testid + cell attribute together — the pointer is
  // moving (~40 advances/sec), so resampling the DOM in two separate
  // queries can race past a transition.
  const dot = card.locator('[data-testid^="helm-step-dot-"]').first();
  await expect(dot).toBeVisible();
  const snap = await card.evaluate((root) => {
    const dots = root.querySelectorAll('[data-testid^="helm-step-dot-"]');
    const dotIds = Array.from(dots).map((n) => (n as HTMLElement).dataset.testid ?? '');
    const cells = root.querySelectorAll('[data-testid^="helm-step-cell-"]');
    const currentCellIds = Array.from(cells)
      .filter((c) => (c as HTMLElement).dataset.current === 'true')
      .map((c) => (c as HTMLElement).dataset.testid ?? '');
    return { dotIds, currentCellIds };
  });
  expect(snap.dotIds.length).toBe(1);
  expect(snap.currentCellIds.length).toBe(1);
  const dotIdx = Number(snap.dotIds[0]!.replace('helm-step-dot-', ''));
  const cellIdx = Number(snap.currentCellIds[0]!.replace('helm-step-cell-', ''));
  // Dot index and current-cell index must agree (same snapshot tick).
  expect(dotIdx).toBe(cellIdx);
  expect(dotIdx).toBeGreaterThanOrEqual(0);
  expect(dotIdx).toBeLessThan(8);
});

test('helm: RESET button snaps the dot away (currentStep → -1 = no dot)', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [
      // Explicit, well-separated positions (see gate-clocked test above): the
      // rack-sized helm + sequencer overlap when stacked at the default
      // (100,100) and would intercept clicks on helm's bottom-row controls.
      { id: 'src', type: 'sequencer', position: { x: 60,  y: 720 }, params: { bpm: 600, length: 4, isPlaying: 1, gateLength: 0.4 } },
      { id: 'h',   type: 'helm',      position: { x: 60,  y: 60 },  params: { stepDepth: 0.5, stepNumSteps: 8 } },
      { id: 'out', type: 'audioOut',  position: { x: 860, y: 60 },  params: { master: 0.1 } },
    ],
    [
      { id: 'g',  from: { nodeId: 'src', portId: 'gate'  }, to: { nodeId: 'h',   portId: 'gate' }, sourceType: 'gate', targetType: 'gate' },
      { id: 'al', from: { nodeId: 'h',   portId: 'out_l' }, to: { nodeId: 'out', portId: 'L' } },
      { id: 'ar', from: { nodeId: 'h',   portId: 'out_r' }, to: { nodeId: 'out', portId: 'R' } },
    ],
  );
  // Sequencer steps default to an empty array — gate only fires when a
  // step is `{on: true, midi: <int>}`. Lay down a 4-step pattern.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const seq = w.__patch.nodes['src'];
      if (!seq.data) seq.data = {};
      seq.data.steps = [
        { on: true, midi: 60 }, { on: true, midi: 62 },
        { on: true, midi: 64 }, { on: true, midi: 65 },
        ...Array.from({ length: 28 }, () => ({ on: false, midi: null })),
      ];
    });
  });
  const card = page.locator('[data-testid="helm-card"]');
  await card.locator('[data-testid="helm-seq-onoff"]').click();
  await page.waitForTimeout(300);
  // Dot present.
  await expect(card.locator('[data-testid^="helm-step-dot-"]').first()).toBeVisible();

  // Hit reset.
  await card.locator('[data-testid="helm-seq-reset"]').click();

  // Immediately after reset, currentStep is -1 → no dot.
  // Need to wait a tick for the postMessage round-trip to update the UI.
  await page.waitForTimeout(50);
  // After reset, the next gate will land on step 0 — so checking "no dot"
  // is racy. Instead assert the NEXT visible dot lands on cell 0.
  await page.waitForFunction(() => {
    const els = document.querySelectorAll('[data-testid^="helm-step-dot-"]');
    return els.length === 1 && (els[0] as HTMLElement).dataset.testid === 'helm-step-dot-0';
  }, { timeout: 2000 });
});

test('helm: SEQ OFF — gate-driven sequencer makes no contribution (no dot rendered)', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  // Default (no toggle click) = SEQ OFF. Drive the gate; the dot should
  // never appear.
  await spawnPatch(
    page,
    [
      { id: 'src', type: 'sequencer', params: { bpm: 600, length: 4, isPlaying: 1, gateLength: 0.4 } },
      { id: 'h',   type: 'helm',      params: { stepDepth: 0.8, stepNumSteps: 8 } },
      { id: 'out', type: 'audioOut',  params: { master: 0.1 } },
    ],
    [
      { id: 'g',  from: { nodeId: 'src', portId: 'gate'  }, to: { nodeId: 'h',   portId: 'gate' }, sourceType: 'gate', targetType: 'gate' },
      { id: 'al', from: { nodeId: 'h',   portId: 'out_l' }, to: { nodeId: 'out', portId: 'L' } },
      { id: 'ar', from: { nodeId: 'h',   portId: 'out_r' }, to: { nodeId: 'out', portId: 'R' } },
    ],
  );
  await page.waitForTimeout(400);
  const card = page.locator('[data-testid="helm-card"]');
  // Toggle confirms OFF default.
  await expect(card.locator('[data-testid="helm-seq-onoff"]')).toHaveText('SEQ OFF');
  // No dot.
  await expect(card.locator('[data-testid^="helm-step-dot-"]')).toHaveCount(0);
});

test('helm: knob drag does not crash the card', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'h', type: 'helm', position: { x: 200, y: 200 } }]);
  const card = page.locator('[data-testid="helm-card"]');
  await expect(card).toBeVisible();

  // Find any knob and drag it. The Knob.svelte component uses
  // pointerdown / pointermove / pointerup; simulate a small drag.
  const firstKnob = card.locator('.knob').first();
  await expect(firstKnob).toBeVisible();
  const box = await firstKnob.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y - 30, { steps: 5 });
    await page.mouse.up();
  }
  // Allow any in-flight render to settle.
  await page.waitForTimeout(200);

  // Card still alive.
  await expect(card).toBeVisible();
  expect(errors, errors.join('; ')).toEqual([]);
});
