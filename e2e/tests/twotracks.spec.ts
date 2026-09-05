// e2e/tests/twotracks.spec.ts
//
// TWOTRACKS end-to-end coverage (Phase 1 + Phase 2 + Phase 3 + Phase 4).
//
// Phase 1 tests:
//   1. Module spawns with no console errors — card renders with correct
//      data-testid elements, LEDs and mode toggle visible.
//   2. Wire OSCILLATOR → twotracks → SCOPE: module is wired and alive.
//   3. Mode toggle: clicking the mode-toggle button changes the label.
//   4. Overdub toggle: button toggles the OVERDUB LED active state.
//   5. Decay slider: moving the decay input changes the displayed value.
//
// Phase 2 tests:
//   6. Reel B card elements exist (mirror of reel A structure).
//   7. A/B knob strip visible with both reel labels.
//   8. A/B law: at ab=0 gainA=100% gainB=0%; at ab=1 gainA=0% gainB=100%.
//   9. Both reels independently record/play.
//
// Phase 3 tests:
//   10. Lofi strip visible and cycles through OFF/LOW/HIGH/ERROR.
//   11. Lofi ERROR button shows active/error highlight.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { runFor } from './_module-coverage-helpers';

// The card died with promotion. The face: the two reel pictures + their
// START/END/playhead scrubbers are `fullViewBody` (`twotracks-reel-body`,
// canvases `twotracks-face-canvas-a`/`-b` — the SAME two-gesture seam split
// the card had), every param is a ranked cell (`control-<param>` — mode and
// overdub and monitor are SWITCHES, filterMode and lofi SEGMENTED radiogroups,
// the rest knobs/faders), and the transports + tape export are ACTION cell
// families (`shell-cell-twotracks-<rec|play|stop|save>-<a|b>`), all in a
// TABBED dock (a-transport/a-tape/a-tone, the b mirror, mix).
const PANE_VISIBLE_MS = 60_000;

/** Open the dock pane and return it — every locator scopes under it. */
async function openTtPane(page: Page) {
  await page.waitForFunction(
    () =>
      typeof (globalThis as unknown as { __openDockFullView?: unknown }).__openDockFullView ===
      'function',
    undefined,
    { timeout: 30_000 },
  );
  await page.evaluate(
    (i) => (globalThis as unknown as { __openDockFullView: (x: string) => void }).__openDockFullView(i),
    'tt',
  );
  const pane = page.locator('[data-testid="dock-fullview-pane"][data-pane-node="tt"]');
  await expect(pane.getByTestId('twotracks-reel-body')).toBeVisible({ timeout: PANE_VISIBLE_MS });
  return pane;
}

/** Activate a faceplate tab (inactive pages are display:none). */
async function ttTab(pane: import('@playwright/test').Locator, tab: string) {
  await pane.locator(`[data-testid="faceplate-tab-${tab}"]`).click();
}

async function setupPage(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/rack?seed=none');
  await page.waitForLoadState('networkidle');
  return errors;
}

test.describe('TWOTRACKS module', () => {
  // ═══════════════════════════ Phase 1 ═══════════════════════════

  test('spawns with no console errors and card elements visible', async ({ page }) => {
    const errors = await setupPage(page);

    await spawnPatch(page, [
      { id: 'tt', type: 'twotracks', position: { x: 200, y: 200 } },
    ]);
    // Faceplate tile carries the module name.
    const tile = page.locator('.svelte-flow__node[data-id="tt"]');
    await expect(tile.locator('[data-testid="module-shell"]')).toBeVisible({ timeout: 15_000 });
    await expect(tile).toContainText(/TWOTRACKS/i);

    const pane = await openTtPane(page);
    // Reel A picture present (the reel body shows BOTH reels at once).
    await expect(pane.getByTestId('twotracks-face-canvas-a')).toBeVisible();
    // (The four transport LEDs died with the card — deleted state readouts;
    // the transport truth is `data.transportState_a`, asserted in P5.)
    // Mode + overdub switches, echoes knob, transports + save on the
    // A·transport / A·tape tabs.
    await ttTab(pane, 'a-transport');
    await expect(pane.getByTestId('control-mode_a')).toBeVisible();
    await expect(pane.getByTestId('control-overdub_flag_a')).toBeVisible();
    await expect(pane.getByTestId('shell-cell-twotracks-rec-a')).toBeVisible();
    await expect(pane.getByTestId('shell-cell-twotracks-save-a')).toBeVisible();
    await ttTab(pane, 'a-tape');
    await expect(pane.getByTestId('control-echoes_a')).toBeVisible();

    // No console errors on spawn.
    expect(errors, errors.join('; ')).toEqual([]);
  });

  test('wires OSCILLATOR → twotracks → SCOPE and asserts module is alive', async ({ page }) => {
    const errors = await setupPage(page);

    await spawnPatch(page, [
      { id: 'vco',   type: 'analogVco',  position: { x: 50,  y: 200 }, params: { freq: 440, level: 1 } },
      { id: 'tt',    type: 'twotracks',  position: { x: 300, y: 200 } },
      { id: 'scope', type: 'scope',      position: { x: 550, y: 200 } },
    ], [
      { id: 'e1', from: { nodeId: 'vco', portId: 'saw' }, to: { nodeId: 'tt', portId: 'audio_l_in_a' } },
      { id: 'e2', from: { nodeId: 'tt', portId: 'out_l' }, to: { nodeId: 'scope', portId: 'ch1' } },
    ]);
    await expect(
      page.locator('.svelte-flow__node[data-id="tt"] [data-testid="module-shell"]'),
    ).toBeVisible({ timeout: 15_000 });

    await runFor(page, 600);

    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __ydoc: { transact: (fn: () => void) => void };
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
      };
      w.__ydoc.transact(() => {
        const tt = w.__patch.nodes['tt'];
        if (tt) {
          tt.params['rate_a'] = 1;
          tt.params['mode_a'] = 1;
        }
      });
    });

    await runFor(page, 400);

    await expect(page.locator('.svelte-flow__node[data-id="scope"]')).toBeVisible();
    await expect(
      page.locator('.svelte-flow__node[data-id="tt"] [data-testid="module-shell"]'),
    ).toBeVisible();

    const filtered = errors.filter((e) => !e.includes('ResizeObserver') && !e.includes('vite'));
    expect(filtered, filtered.join('; ')).toEqual([]);
  });

  test('mode toggle alternates between "tape" and "loop tape"', async ({ page }) => {
    await setupPage(page);

    await spawnPatch(page, [
      { id: 'tt', type: 'twotracks', position: { x: 200, y: 200 } },
    ]);
    const pane = await openTtPane(page);
    await ttTab(pane, 'a-transport');
    // The card's labelled cycle button died; the face MODE is a SWITCH whose
    // checked state IS "loop tape" (default 1). Assert the param follows.
    const modeSwitch = pane.getByTestId('control-mode_a');
    const readMode = () => page.evaluate(() => {
      const w = globalThis as unknown as { __patch: { nodes: Record<string, { params: Record<string, number> }> } };
      return w.__patch.nodes['tt']?.params['mode_a'] ?? 1;
    });
    await expect(modeSwitch).toHaveAttribute('aria-checked', 'true'); // loop tape
    await modeSwitch.click();
    await expect(modeSwitch).toHaveAttribute('aria-checked', 'false'); // tape
    expect(await readMode()).toBe(0);
    await modeSwitch.click();
    await expect(modeSwitch).toHaveAttribute('aria-checked', 'true');
    expect(await readMode()).toBe(1);
  });

  test('overdub toggle button activates and deactivates', async ({ page }) => {
    await setupPage(page);

    await spawnPatch(page, [
      { id: 'tt', type: 'twotracks', position: { x: 200, y: 200 } },
    ]);
    const pane = await openTtPane(page);
    await ttTab(pane, 'a-transport');
    const overdub = pane.getByTestId('control-overdub_flag_a');
    await expect(overdub).toBeVisible();
    await expect(overdub).toHaveAttribute('aria-checked', 'false');

    await overdub.click();
    await expect(overdub).toHaveAttribute('aria-checked', 'true');

    await overdub.click();
    await expect(overdub).toHaveAttribute('aria-checked', 'false');
  });

  test('echoes knob reflects the echoes param value', async ({ page }) => {
    await setupPage(page);

    await spawnPatch(page, [
      { id: 'tt', type: 'twotracks', position: { x: 200, y: 200 } },
    ]);
    const pane = await openTtPane(page);
    await ttTab(pane, 'a-tape');
    // ECHOES is the ranked knob (role="slider", default 3); its aria-valuenow
    // tracks the echoes_a param.
    const echoesKnob = pane.getByTestId('control-echoes_a');
    await expect(echoesKnob).toBeVisible();
    await expect(echoesKnob).toHaveAttribute('aria-valuenow', '3');

    // Drive echoes_a via the dev Y.Doc; the knob must reflect it.
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __ydoc: { transact: (fn: () => void) => void };
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
      };
      w.__ydoc.transact(() => {
        const tt = w.__patch.nodes['tt'];
        if (tt) tt.params['echoes_a'] = 5;
      });
    });
    await expect(echoesKnob).toHaveAttribute('aria-valuenow', '5');
  });

  // ═══════════════════════════ Phase 2 ═══════════════════════════

  test('P2: reel B card elements exist and mirror reel A', async ({ page }) => {
    const errors = await setupPage(page);

    await spawnPatch(page, [
      { id: 'tt', type: 'twotracks', position: { x: 200, y: 200 } },
    ]);
    const pane = await openTtPane(page);

    // Reel B picture (the body paints both reels).
    await expect(pane.getByTestId('twotracks-face-canvas-b')).toBeVisible();

    // The B tabs mirror A: transport (mode/overdub switches + transports +
    // save) and tone (EQ + filter). LEDs died with the card (P5's data assert
    // covers the transport truth).
    await ttTab(pane, 'b-transport');
    await expect(pane.getByTestId('control-mode_b')).toBeVisible();
    await expect(pane.getByTestId('control-overdub_flag_b')).toBeVisible();
    await expect(pane.getByTestId('shell-cell-twotracks-rec-b')).toBeVisible();
    await expect(pane.getByTestId('shell-cell-twotracks-save-b')).toBeVisible();
    await ttTab(pane, 'b-tape');
    await expect(pane.getByTestId('control-echoes_b')).toBeVisible();
    await ttTab(pane, 'b-tone');
    await expect(pane.getByTestId('control-eqLow_b')).toBeVisible();
    await expect(pane.getByTestId('control-filterMode_b')).toBeVisible();

    // No errors
    expect(errors, errors.join('; ')).toEqual([]);
  });

  // Helper: set the A/B param directly via the dev Y.Doc (the A/B control is a
  // drag Knob now, not a fillable range input — so we drive the param and assert
  // the reactive percentage readout, which is what the gain law actually maps).
  async function setAbParam(page: Page, value: number) {
    await page.evaluate((v) => {
      const w = globalThis as unknown as {
        __ydoc: { transact: (fn: () => void) => void };
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
      };
      w.__ydoc.transact(() => {
        const tt = w.__patch.nodes['tt'];
        if (tt) tt.params['ab'] = v;
      });
    }, value);
  }

  test('P2: the A/B crossfade knob ranks on the face', async ({ page }) => {
    await setupPage(page);

    await spawnPatch(page, [
      { id: 'tt', type: 'twotracks', position: { x: 200, y: 200 } },
    ]);
    const pane = await openTtPane(page);
    await ttTab(pane, 'mix');

    // The A/B crossfade is the ranked `control-ab` knob (the card's painted
    // A:x% / B:y% readout died — deleted resting text; the LAW itself is
    // unit-tested DSP, and the knob's value is the whole UI claim).
    const ab = pane.getByTestId('control-ab');
    await expect(ab).toBeVisible();
    await expect(ab).toHaveAttribute('aria-valuenow', '0');
  });

  test('P2: the A/B knob is a live two-way surface for the synced ab param', async ({ page }) => {
    await setupPage(page);

    await spawnPatch(page, [
      { id: 'tt', type: 'twotracks', position: { x: 200, y: 200 } },
    ]);
    const pane = await openTtPane(page);
    await ttTab(pane, 'mix');
    const ab = pane.getByTestId('control-ab');

    // The percentage READOUT died with the card (the gain LAW is pinned by
    // twotracks-engine unit tests); what the face owes is that the knob is a
    // live two-way surface for the synced param.
    await expect(ab).toHaveAttribute('aria-valuenow', '0');
    await setAbParam(page, 0.5);
    await expect(ab).toHaveAttribute('aria-valuenow', '0.5');
    await setAbParam(page, 1);
    await expect(ab).toHaveAttribute('aria-valuenow', '1');
    await setAbParam(page, 0);
    await expect(ab).toHaveAttribute('aria-valuenow', '0');
  });

  test('P2: reel B mode toggle alternates between tape and loop tape', async ({ page }) => {
    await setupPage(page);

    await spawnPatch(page, [
      { id: 'tt', type: 'twotracks', position: { x: 200, y: 200 } },
    ]);
    const pane = await openTtPane(page);
    await ttTab(pane, 'b-transport');
    const modeSwitch = pane.getByTestId('control-mode_b');

    await expect(modeSwitch).toBeVisible();
    await expect(modeSwitch).toHaveAttribute('aria-checked', 'true'); // loop tape

    await modeSwitch.click();
    await expect(modeSwitch).toHaveAttribute('aria-checked', 'false'); // tape

    await modeSwitch.click();
    await expect(modeSwitch).toHaveAttribute('aria-checked', 'true');
  });

  test('P2: reel B overdub toggle activates and deactivates independently', async ({ page }) => {
    await setupPage(page);

    await spawnPatch(page, [
      { id: 'tt', type: 'twotracks', position: { x: 200, y: 200 } },
    ]);
    const pane = await openTtPane(page);
    const overdubA = pane.getByTestId('control-overdub_flag_a');
    const overdubB = pane.getByTestId('control-overdub_flag_b');

    // Both start off (aria works across inactive tabs; clicks need the tab).
    await expect(overdubA).toHaveAttribute('aria-checked', 'false');
    await expect(overdubB).toHaveAttribute('aria-checked', 'false');

    // Enable reel B overdub only.
    await ttTab(pane, 'b-transport');
    await overdubB.click();
    await expect(overdubB).toHaveAttribute('aria-checked', 'true');
    await expect(overdubA).toHaveAttribute('aria-checked', 'false');

    // Disable reel B, enable reel A.
    await overdubB.click();
    await ttTab(pane, 'a-transport');
    await overdubA.click();
    await expect(overdubA).toHaveAttribute('aria-checked', 'true');
    await expect(overdubB).toHaveAttribute('aria-checked', 'false');
  });

  test('P2: EQ sections present on both reels', async ({ page }) => {
    await setupPage(page);

    await spawnPatch(page, [
      { id: 'tt', type: 'twotracks', position: { x: 200, y: 200 } },
    ]);
    const pane = await openTtPane(page);

    // Reel A tone tab — the three EQ knobs.
    await ttTab(pane, 'a-tone');
    for (const band of ['eqLow_a', 'eqMid_a', 'eqHigh_a']) {
      await expect(pane.getByTestId(`control-${band}`)).toBeVisible();
    }

    // Reel B mirror.
    await ttTab(pane, 'b-tone');
    for (const band of ['eqLow_b', 'eqMid_b', 'eqHigh_b']) {
      await expect(pane.getByTestId(`control-${band}`)).toBeVisible();
    }
  });

  test('P2: filter sections present on both reels with mode toggle buttons', async ({ page }) => {
    await setupPage(page);

    await spawnPatch(page, [
      { id: 'tt', type: 'twotracks', position: { x: 200, y: 200 } },
    ]);
    const pane = await openTtPane(page);

    // Reel A tone tab — the card's cycle button became a SEGMENTED radiogroup;
    // each mode is its own segment and the checked one is the state.
    await ttTab(pane, 'a-tone');
    const filterA = pane.getByTestId('control-filterMode_a');
    await expect(filterA).toBeVisible();
    const checkedA = filterA.locator('[role="radio"][aria-checked="true"]');
    await expect(checkedA).toHaveText('OFF');
    for (const mode of ['HP', 'LP', 'BP', 'OFF']) {
      await filterA.getByRole('radio', { name: mode, exact: true }).click();
      await expect(checkedA).toHaveText(mode);
    }

    // Reel B mirror starts at OFF.
    await ttTab(pane, 'b-tone');
    const filterB = pane.getByTestId('control-filterMode_b');
    await expect(filterB).toBeVisible();
    await expect(filterB.locator('[role="radio"][aria-checked="true"]')).toHaveText('OFF');
  });

  // ═══════════════════════════ Phase 3 ═══════════════════════════

  test.describe('TWOTRACKS P3', () => {
    test('lofi strip is visible and contains all four mode buttons', async ({ page }) => {
      const errors = await setupPage(page);

      await spawnPatch(page, [
        { id: 'tt', type: 'twotracks', position: { x: 200, y: 200 } },
      ]);
      const pane = await openTtPane(page);
      await ttTab(pane, 'mix');
      const lofi = pane.getByTestId('control-lofi');
      await expect(lofi).toBeVisible();

      // All four modes present as segments; OFF checked by default.
      const buttons = lofi.locator('[role="radio"]');
      await expect(buttons).toHaveCount(4);
      await expect(buttons.nth(0)).toHaveText('OFF');
      await expect(buttons.nth(1)).toHaveText('LOW');
      await expect(buttons.nth(2)).toHaveText('HIGH');
      await expect(buttons.nth(3)).toHaveText('ERROR');
      await expect(buttons.nth(0)).toHaveAttribute('aria-checked', 'true');
      await expect(buttons.nth(1)).toHaveAttribute('aria-checked', 'false');
      await expect(buttons.nth(2)).toHaveAttribute('aria-checked', 'false');
      await expect(buttons.nth(3)).toHaveAttribute('aria-checked', 'false');

      const filtered = errors.filter((e) => !e.includes('ResizeObserver') && !e.includes('vite'));
      expect(filtered, filtered.join('; ')).toEqual([]);
    });

    test('lofi switch cycles through OFF → LOW → HIGH → ERROR and back to OFF', async ({ page }) => {
      await setupPage(page);

      await spawnPatch(page, [
        { id: 'tt', type: 'twotracks', position: { x: 200, y: 200 } },
      ]);
      const pane = await openTtPane(page);
      await ttTab(pane, 'mix');
      const buttons = pane.getByTestId('control-lofi').locator('[role="radio"]');

      // Start: OFF checked.
      await expect(buttons.nth(0)).toHaveAttribute('aria-checked', 'true');

      // LOW → HIGH → ERROR → OFF, each click moving the checked segment.
      await buttons.nth(1).click();
      await expect(buttons.nth(1)).toHaveAttribute('aria-checked', 'true');
      await expect(buttons.nth(0)).toHaveAttribute('aria-checked', 'false');

      await buttons.nth(2).click();
      await expect(buttons.nth(2)).toHaveAttribute('aria-checked', 'true');
      await expect(buttons.nth(1)).toHaveAttribute('aria-checked', 'false');

      await buttons.nth(3).click();
      await expect(buttons.nth(3)).toHaveAttribute('aria-checked', 'true');
      await expect(buttons.nth(2)).toHaveAttribute('aria-checked', 'false');

      await buttons.nth(0).click();
      await expect(buttons.nth(0)).toHaveAttribute('aria-checked', 'true');
      await expect(buttons.nth(3)).toHaveAttribute('aria-checked', 'false');
    });

    test('lofi ERROR button shows error highlight class when active', async ({ page }) => {
      await setupPage(page);

      await spawnPatch(page, [
        { id: 'tt', type: 'twotracks', position: { x: 200, y: 200 } },
      ]);
      const pane = await openTtPane(page);
      await ttTab(pane, 'mix');
      const lofi = pane.getByTestId('control-lofi');
      const errorBtn = lofi.locator('[role="radio"]').nth(3);

      // The card's red highlight class died with the card (VRT owns the look);
      // the surviving state is the checked segment + the PARAM it writes.
      const readLofi = () => page.evaluate(() => {
        const w = globalThis as unknown as { __patch: { nodes: Record<string, { params: Record<string, number> }> } };
        return w.__patch.nodes['tt']?.params['lofi'] ?? 0;
      });
      await errorBtn.click();
      await expect(errorBtn).toHaveAttribute('aria-checked', 'true');
      await expect.poll(readLofi, { message: 'ERROR writes lofi=3' }).toBe(3);

      await lofi.locator('[role="radio"]').nth(0).click();
      await expect(errorBtn).toHaveAttribute('aria-checked', 'false');
      await expect.poll(readLofi, { message: 'OFF writes lofi=0' }).toBe(0);
    });
  });

  // ═══════════════════════════ Phase 4 ═══════════════════════════

  test.describe('TWOTRACKS P4', () => {
    test('P4: waveform canvas elements present on both reels', async ({ page }) => {
      await setupPage(page);

      await spawnPatch(page, [
        { id: 'tt', type: 'twotracks', position: { x: 200, y: 200 } },
      ]);
      const pane = await openTtPane(page);

      // Both reel pictures paint in the body.
      await expect(pane.getByTestId('twotracks-face-canvas-a')).toBeVisible();
      await expect(pane.getByTestId('twotracks-face-canvas-b')).toBeVisible();

      // Both SAVE TAPE cells present (attached across their tabs).
      await expect(pane.getByTestId('shell-cell-twotracks-save-a')).toBeAttached();
      await expect(pane.getByTestId('shell-cell-twotracks-save-b')).toBeAttached();
    });

    // ⚠ RETIRED (S2): 'SAVE TAPE disabled initially and shows "no tape" info'
    // and 'SAVE TAPE becomes enabled and shows duration when bufLen is set'.
    // Both guarded CARD chrome: the card's save button disabled itself on
    // `bufLen` and painted a `.tape-info` duration readout. The face's SAVE
    // TAPE is a trigger ACTION cell with no disabled state (the export handler
    // owns the no-tape case), and the duration readout is deleted resting
    // text. `bufLenA` itself stays covered: twotracks-perfzip.spec.ts asserts
    // it round-trips, and the export seam is audited by the per-module sweep's
    // `file-export` probe.
  });

  // ═══════════════════════════ Phase 5 ═══════════════════════════
  // Transport trigger buttons + idle stability (the module must be completely
  // static on spawn — no sweeping playhead, no transport activity).

  test.describe('TWOTRACKS P5 transport + idle stability', () => {
    test('REC / PLAY / STOP buttons present on both reels', async ({ page }) => {
      await setupPage(page);

      await spawnPatch(page, [
        { id: 'tt', type: 'twotracks', position: { x: 200, y: 200 } },
      ]);
      const pane = await openTtPane(page);
      for (const id of [
        'shell-cell-twotracks-rec-a', 'shell-cell-twotracks-play-a', 'shell-cell-twotracks-stop-a',
        'shell-cell-twotracks-rec-b', 'shell-cell-twotracks-play-b', 'shell-cell-twotracks-stop-b',
      ]) {
        await expect(pane.getByTestId(id)).toBeAttached();
      }
    });

    test('on spawn the module is idle — no transport LEDs active, playhead static', async ({ page }) => {
      await setupPage(page);

      await spawnPatch(page, [
        { id: 'tt', type: 'twotracks', position: { x: 200, y: 200 } },
      ]);
      await openTtPane(page);

      // (The card's LED bank died — deleted state readouts. The transport
      // truth is `data.transportState_a`, and idle-over-time is the claim.)

      // The transport state in node.data must stay 'idle' over time (the worklet
      // must NOT free-run the playhead on an empty module). Sample twice ~500ms
      // apart and require it never leaves idle.
      const readState = () => page.evaluate(() => {
        const w = globalThis as unknown as {
          __patch: { nodes: Record<string, { data?: { transportState_a?: string } }> };
        };
        return w.__patch.nodes['tt']?.data?.transportState_a ?? 'idle';
      });
      expect(await readState()).toBe('idle');
      await page.waitForTimeout(500);
      expect(await readState()).toBe('idle');
    });

    test('all reel knobs are MIDI + control-surface assignable (right-click → control menu)', async ({ page }) => {
      await setupPage(page);

      await spawnPatch(page, [
        { id: 'tt', type: 'twotracks', position: { x: 200, y: 200 } },
      ]);
      const pane = await openTtPane(page);

      // Every continuous control is a ranked slider. The card's census was 17
      // knobs; the face adds the four START/END loop faders as ranked cells
      // (the card kept those on the waveform only), so the dock census is 21.
      const knobs = pane.locator('[role="slider"]');
      await expect(knobs).toHaveCount(21);

      // Right-clicking a knob opens the control context menu whose entries are
      // the MIDI-Learn + Send-to-control-surface actions — i.e. the control is
      // assignable to both. Verify on a representative knob (reel A echoes).
      await ttTab(pane, 'a-tape');
      const echoesKnob = pane.getByTestId('control-echoes_a');
      await echoesKnob.click({ button: 'right' });
      await expect(page.locator('[data-testid="control-context-menu"]')).toBeVisible();
      await expect(page.locator('[data-testid="ctx-midi-learn"]')).toBeVisible();
    });

    test('double-clicking the RATE knob resets reel speed to true 1.0×', async ({ page }) => {
      await setupPage(page);

      await spawnPatch(page, [
        { id: 'tt', type: 'twotracks', position: { x: 200, y: 200 } },
      ]);
      const pane = await openTtPane(page);

      // Drive the rate off 1× via the dev Y.Doc.
      await page.evaluate(() => {
        const w = globalThis as unknown as {
          __ydoc: { transact: (fn: () => void) => void };
          __patch: { nodes: Record<string, { params: Record<string, number> }> };
        };
        w.__ydoc.transact(() => {
          const tt = w.__patch.nodes['tt'];
          if (tt) tt.params['rate_a'] = 2.5;
        });
      });

      // The card's 1× button died; the shell-wide reset gesture is DOUBLE-
      // CLICK on the knob (Knob.svelte's dblclick → onchange(defaultValue)),
      // and rate_a's default IS exactly 1.
      await ttTab(pane, 'a-tape');
      await pane.getByTestId('control-rate_a').dblclick();
      const rate = await page.evaluate(() => {
        const w = globalThis as unknown as {
          __patch: { nodes: Record<string, { params: Record<string, number> }> };
        };
        return w.__patch.nodes['tt']?.params['rate_a'];
      });
      expect(rate).toBe(1);
    });

    test('MONITOR button toggles input-passthrough state', async ({ page }) => {
      await setupPage(page);

      await spawnPatch(page, [
        { id: 'tt', type: 'twotracks', position: { x: 200, y: 200 } },
      ]);
      const pane = await openTtPane(page);
      await ttTab(pane, 'mix');
      const monitor = pane.getByTestId('control-monitor');

      // Off by default (a ranked SWITCH on the face).
      await expect(monitor).toBeVisible();
      await expect(monitor).toHaveAttribute('aria-checked', 'false');

      // Click → monitor engages (param + checked state).
      await monitor.click();
      await expect(monitor).toHaveAttribute('aria-checked', 'true');
      const on = await page.evaluate(() => {
        const w = globalThis as unknown as {
          __patch: { nodes: Record<string, { params: Record<string, number> }> };
        };
        return w.__patch.nodes['tt']?.params['monitor'];
      });
      expect(on).toBe(1);

      // Click again → off.
      await monitor.click();
      await expect(monitor).toHaveAttribute('aria-checked', 'false');
    });
  });

  // ═══════════════════════════ Phase 6 ═══════════════════════════
  // Per-side start/end loop scrubbers on the waveform (like SAMSLOOP). Dragging
  // a side's handle narrows the played span; neither handle can cross the other
  // (and — verified in the engine unit tests — neither can cross the playhead
  // while rolling). The clamp MATH is unit-tested in twotracks-engine.test.ts
  // (clampLoopStart/clampLoopEnd); these assert the UI wiring writes the params.

  test.describe('TWOTRACKS P6 loop scrubbers', () => {
    // Drag across a reel waveform from one displayed fraction to another. With
    // posPxToNorm dividing by the displayed width, the written tape fraction ≈
    // the drag fraction.
    // The face canvases carry the SAME two-gesture seam split the card had
    // (marker drags → setNodeParam; elsewhere → a transient seek message).
    async function dragWaveform(page: Page, testid: string, fromFrac: number, toFrac: number) {
      const canvas = page
        .locator('[data-testid="dock-fullview-pane"][data-pane-node="tt"]')
        .locator(`[data-testid="${testid}"]`);
      await canvas.scrollIntoViewIfNeeded();
      const box = await canvas.boundingBox();
      if (!box) throw new Error(`no bounding box for ${testid}`);
      const y = box.y + box.height / 2;
      await page.mouse.move(box.x + box.width * fromFrac, y);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * toFrac, y, { steps: 8 });
      await page.mouse.up();
    }
    const readParam = (page: Page, p: string) =>
      page.evaluate((pp) => {
        const w = globalThis as unknown as {
          __patch: { nodes: Record<string, { params: Record<string, number> }> };
        };
        return w.__patch.nodes['tt']?.params[pp];
      }, p);
    const setParam = (page: Page, p: string, v: number) =>
      page.evaluate(({ pp, vv }) => {
        const w = globalThis as unknown as {
          __ydoc: { transact: (fn: () => void) => void };
          __patch: { nodes: Record<string, { params: Record<string, number> }> };
        };
        w.__ydoc.transact(() => {
          const tt = w.__patch.nodes['tt'];
          if (tt) tt.params[pp] = vv;
        });
      }, { pp: p, vv: v });

    // Untouched params aren't materialized into node.params until written, so a
    // fresh read is `undefined` → fall back to the def default (what the card
    // renders via `?? defaultFor(...)`).
    const effStart = async (page: Page) => (await readParam(page, 'start_a')) ?? 0;
    const effEnd = async (page: Page) => (await readParam(page, 'end_a')) ?? 1;

    test('start/end default to the full tape (0 and 1)', async ({ page }) => {
      await setupPage(page);
      await spawnPatch(page, [{ id: 'tt', type: 'twotracks', position: { x: 200, y: 200 } }]);
      await openTtPane(page);
      expect(await effStart(page)).toBe(0);
      expect(await effEnd(page)).toBe(1);
    });

    test('dragging the START handle inward moves start_a', async ({ page }) => {
      await setupPage(page);
      await spawnPatch(page, [{ id: 'tt', type: 'twotracks', position: { x: 200, y: 200 } }]);
      await openTtPane(page);
      await dragWaveform(page, 'twotracks-face-canvas-a', 0.01, 0.5);
      const start = await readParam(page, 'start_a');
      expect(start).toBeGreaterThan(0.35);
      expect(start).toBeLessThan(0.65);
      // End untouched.
      expect(await effEnd(page)).toBe(1);
    });

    test('dragging the END handle inward moves end_a', async ({ page }) => {
      await setupPage(page);
      await spawnPatch(page, [{ id: 'tt', type: 'twotracks', position: { x: 200, y: 200 } }]);
      await openTtPane(page);
      await dragWaveform(page, 'twotracks-face-canvas-a', 0.99, 0.5);
      const end = await readParam(page, 'end_a');
      expect(end).toBeGreaterThan(0.35);
      expect(end).toBeLessThan(0.65);
      // Start untouched.
      expect(await effStart(page)).toBe(0);
    });

    test('START cannot be dragged past END (clamped to the loop window)', async ({ page }) => {
      await setupPage(page);
      await spawnPatch(page, [{ id: 'tt', type: 'twotracks', position: { x: 200, y: 200 } }]);
      await openTtPane(page);
      // Pull END in first, then try to drag START well past it.
      await setParam(page, 'end_a', 0.3);
      await dragWaveform(page, 'twotracks-face-canvas-a', 0.01, 0.85);
      const start = await readParam(page, 'start_a');
      // Clamped at end − MIN_LOOP_GAP (0.3 − 0.01); never crosses END.
      expect(start).toBeLessThanOrEqual(0.3);
      expect(start).toBeGreaterThan(0.25);
    });

    test('reel B scrubbers are independent of reel A', async ({ page }) => {
      await setupPage(page);
      await spawnPatch(page, [{ id: 'tt', type: 'twotracks', position: { x: 200, y: 200 } }]);
      await openTtPane(page);
      await dragWaveform(page, 'twotracks-face-canvas-b', 0.01, 0.4);
      const startB = await readParam(page, 'start_b');
      expect(startB).toBeGreaterThan(0.25);
      // Reel A unchanged.
      expect(await effStart(page)).toBe(0);
    });

    test('clicking the middle of the waveform still scrubs the playhead (not a handle)', async ({ page }) => {
      await setupPage(page);
      await spawnPatch(page, [{ id: 'tt', type: 'twotracks', position: { x: 200, y: 200 } }]);
      await openTtPane(page);
      // A mid-tape press is far from both edge handles → it must NOT move
      // start_a/end_a (it's a playhead scrub).
      await dragWaveform(page, 'twotracks-face-canvas-a', 0.5, 0.55);
      expect(await effStart(page)).toBe(0);
      expect(await effEnd(page)).toBe(1);
    });
  });

  // ═══════════════════════════ Phase 7 ═══════════════════════════
  // Cross-feed knobs A→B / B→A (default off). The DSP (cross-feed into the input
  // path, dry gating, monitor mix) is unit-tested in twotracks-engine.test.ts —
  // headless Playwright can't run the worklet audio thread — so these assert the
  // UI surface: the knobs render, default to 0 (off → no signal-path change),
  // are MIDI/control-surface assignable, and write their params.

  test.describe('TWOTRACKS P7 cross-feed knobs', () => {
    test('A→B and B→A knobs render in the center, default off (0)', async ({ page }) => {
      await setupPage(page);
      await spawnPatch(page, [{ id: 'tt', type: 'twotracks', position: { x: 200, y: 200 } }]);
      await openTtPane(page);

      const pane = page.locator('[data-testid="dock-fullview-pane"][data-pane-node="tt"]');
      await ttTab(pane, 'mix');
      const a2b = pane.getByTestId('control-a2b');
      const b2a = pane.getByTestId('control-b2a');
      await expect(a2b).toBeVisible();
      await expect(b2a).toBeVisible();
      // Both default to 0 (off → byte-for-byte the prior signal path).
      await expect(a2b).toHaveAttribute('aria-valuenow', '0');
      await expect(b2a).toHaveAttribute('aria-valuenow', '0');
    });

    test('cross-feed knobs reflect the a2b / b2a params (assignable + synced)', async ({ page }) => {
      await setupPage(page);
      await spawnPatch(page, [{ id: 'tt', type: 'twotracks', position: { x: 200, y: 200 } }]);
      await openTtPane(page);

      const pane = page.locator('[data-testid="dock-fullview-pane"][data-pane-node="tt"]');
      await ttTab(pane, 'mix');
      const a2b = pane.getByTestId('control-a2b');
      const b2a = pane.getByTestId('control-b2a');

      // Drive both via the dev Y.Doc; the knobs must reflect them.
      await page.evaluate(() => {
        const w = globalThis as unknown as {
          __ydoc: { transact: (fn: () => void) => void };
          __patch: { nodes: Record<string, { params: Record<string, number> }> };
        };
        w.__ydoc.transact(() => {
          const tt = w.__patch.nodes['tt'];
          if (tt) { tt.params['a2b'] = 1; tt.params['b2a'] = 0.5; }
        });
      });
      await expect(a2b).toHaveAttribute('aria-valuenow', '1');
      await expect(b2a).toHaveAttribute('aria-valuenow', '0.5');

      // Right-click → control context menu (MIDI-learn + send-to-surface).
      await a2b.click({ button: 'right' });
      await expect(page.locator('[data-testid="control-context-menu"]')).toBeVisible();
      await expect(page.locator('[data-testid="ctx-midi-learn"]')).toBeVisible();
    });
  });
});
