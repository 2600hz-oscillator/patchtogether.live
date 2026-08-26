// e2e/tests/numpad-plus-face.spec.ts
//
// THE NUMPAD+ FACEPLATE, driven for real — and specifically the seams no other
// gate can see.
//
// `numpadPlus-face-model.test.ts` pins the ranking, both rosters, both probes
//   and the plate arithmetic.
// `numpad-plus-writes.test.ts` pins what every gesture writes, and proves the
//   three `node.data` defects are closed against a real Y.Doc.
// `faces-parity` proves every cell OPERATES.
// `workflow-shell-faces` photographs the plate and measures its width.
//
// None of them can see:
//
//  1. THAT THE THREE DEFECTS ARE CLOSED THROUGH THE REAL UI. The unit suite
//     calls the seam directly; here a player clicks a grid cell, presses
//     Cmd-Z's UndoManager, and arms REC and presses PLAY. ⚠ D1 is the one that
//     matters: arming REC and pressing PLAY erases sixteen steps, and it used
//     to be a bare SyncedStore proxy write that Cmd-Z could not reach.
//  2. THAT THE KEYPAD STILL PLAYS WITH NO CARD MOUNTED. The whole worry about
//     promoting this module is that its instrument is a document keyboard
//     listener. It is in the FACTORY, and this is where that stops being an
//     argument and becomes an observation.
//  3. THAT THE ADDED AFFORDANCE EXISTS. The def has promised
//     click-and-drag-to-change-note since it shipped and no handler
//     implemented it. `module-docs-lint` reads the DEF, so it was blind in
//     exactly that direction.
//  4. THAT THE KEYMAP PANEL DOES NOT STAY ARMED. Its probe arms a listening
//     mode; a panel left listening would capture the next keystroke anything
//     types and silently rebind a key.
//  5. THAT A FRESH LEGACY CARD IS STATIC. This PR DELETES this module's
//     permanent VRT exemption, whose stated reason named two animations that
//     are both gated on params defaulting to 0. That claim is measured HERE, on
//     the artifact, because reading the source once is what produced the wrong
//     sentence in the first place.
//
// Runs on /rack (no DB, no relay). The faceplate shell is the DEFAULT rack.

import { test, expect, type Locator, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

const SLOW_RENDER = process.env.E2E_SWIFTSHADER === '1' || !!process.env.CI;
const NODE = 'npf';

async function gotoShell(page: Page): Promise<void> {
  await page.goto('/rack?seed=none');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({
    timeout: SLOW_RENDER ? 30_000 : 15_000,
  });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

async function spawn(page: Page): Promise<void> {
  await spawnPatch(page, [{ id: NODE, type: 'numpadPlus', position: { x: 160, y: 140 } }]);
}

/** Open this node's dock faceplate, scoped by `data-shell-node` so a later swap
 *  of the dock's occupant cannot leave a stale locator on someone else's plate. */
async function openDock(page: Page, nodeId = NODE): Promise<Locator> {
  const shell = page.locator(`.svelte-flow__node[data-id="${nodeId}"] [data-testid="module-shell"]`);
  await expect(shell).toBeVisible();
  await shell.getByTestId('shell-open-dock').click();
  const dock = page
    .getByTestId('dock-full-view')
    .locator(`[data-testid="module-shell"][data-shell-tier="dock"][data-shell-node="${nodeId}"]`);
  await expect(dock).toBeVisible();
  return dock;
}

/** One step of one layer, as the graph holds it. */
const readStep = (page: Page, layer: number, step: number) =>
  page.evaluate(
    ({ id, layer, step }) => {
      const w = globalThis as unknown as {
        __patch: {
          nodes: Record<string, { data?: { layers?: Array<Array<{ on?: boolean; midi?: number | null }>> } }>;
        };
      };
      return w.__patch.nodes[id]?.data?.layers?.[layer]?.[step] ?? null;
    },
    { id: NODE, layer, step },
  );

const readKeymap = (page: Page) =>
  page.evaluate((id) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: { keymap?: Record<string, number> } }> };
    };
    return w.__patch.nodes[id]?.data?.keymap ?? null;
  }, NODE);

const undo = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __undoManager: { undo: () => void; stopCapturing: () => void } };
    w.__undoManager.undo();
  });
const stopCapturing = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __undoManager: { stopCapturing: () => void } };
    w.__undoManager.stopCapturing();
  });

test.describe('NUMPAD+ face — the plate', () => {
  test('the LANE TILE renders the face, and the ladder is the one the rank claims', async ({ page }) => {
    await gotoShell(page);
    await spawn(page);
    const shell = page.locator(`.svelte-flow__node[data-id="${NODE}"] [data-testid="module-shell"]`);
    await expect(shell, 'a promoted module renders ModuleShell, not the placeholder tile').toBeVisible();
    // The lane's rank-1 control is the LAYER — the thing that decides which
    // pitch/gate pair a keypress drives. Neither panel may reach a lane tier.
    await expect(shell.locator('[data-testid="control-activeLayer"]')).toBeVisible();
    await expect(
      shell.locator('[data-testid="numpad-step-grid"]'),
      'the hero picture is DOCK-ONLY (PF-22) — a 46px knob column cannot hold a panel',
    ).toHaveCount(0);
    await expect(shell.locator('[data-testid="numpad-keymap-panel"]')).toHaveCount(0);
  });

  test('the DOCK paints both panels, and NO cell paints a decimal readout', async ({ page }) => {
    await gotoShell(page);
    await spawn(page);
    const dock = await openDock(page);

    const grid = dock.getByTestId('numpad-step-grid');
    await expect(grid).toBeVisible();
    await expect(grid.locator('[role="gridcell"]')).toHaveCount(16);
    const caps = dock.getByTestId('numpad-keymap-panel');
    await expect(caps).toBeVisible();
    await expect(caps.locator('button[data-testid^="numpad-key-"]')).toHaveCount(14);

    // ⚠ THE HINT LINE IS PRESENT AND EMPTY AT REST. It is the keymap panel's
    // declared probe WITNESS, and `expect: 'changed'` over an absent→present
    // element is not a comparison the parity sweep can make. Present-and-empty
    // is also what keeps it out of the resting-text ruling's way.
    const hint = dock.getByTestId('numpad-key-hint');
    await expect(hint).toBeVisible();
    await expect(hint).toHaveText('');

    // No resting NUMBER anywhere on the plate. The card painted the octave as a
    // bare integer between two arrows; the face names the state instead (`c4`).
    await expect(
      dock.locator('[data-testid="numpad-octave-value"]'),
      'the octave NUMBER is REMOVED, not hidden',
    ).toHaveCount(0);
    const numbersIn = async (loc: Locator) =>
      (await loc.innerText()).trim().split(/\s+/).filter((w) => /^[+\-−]?\d+(\.\d+)?$/.test(w));

    // ⚠ THE KEY CAPS ARE EXCLUDED, AND THAT IS THE SPEC'S ONE ARGUED CARVE-OUT
    // RATHER THAN A LOOSENED THRESHOLD. A cap paints the ENGRAVING of the
    // physical key bound to it, and for the ten default numpad bindings that
    // engraving IS a digit. `7` there is the proper noun of a key — it cannot
    // be more or less, it restates no dial position, and it is the only
    // feedback the remapping feature has: delete it and binding a key never
    // tells you which key you bound. That is the `cvBuddy.ppqn` argument
    // ("there is no name for the state that is not the integer") reached by a
    // panel instead of a knob.
    const capNumbers = await numbersIn(caps);
    expect(capNumbers.sort(), 'the ten default numpad engravings, and nothing else')
      .toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']);

    // Everything OUTSIDE that panel must paint no number at all.
    const rest = await page.evaluate(() => {
      const plate = document.querySelector('[data-testid="dock-full-view"] [data-shell-tier="dock"]');
      if (!plate) return '';
      const clone = plate.cloneNode(true) as HTMLElement;
      clone.querySelector('[data-testid="numpad-keymap-panel"]')?.remove();
      return (clone.innerText ?? clone.textContent ?? '').trim();
    });
    expect(
      rest.split(/\s+/).filter((w) => /^[+\-−]?\d+(\.\d+)?$/.test(w)),
      `a bare number is painted outside the key caps: ${JSON.stringify(rest)}`,
    ).toEqual([]);
  });

  test('a step CELL carries its note in the ACCESSIBLE NAME, which the card never did', async ({ page }) => {
    await gotoShell(page);
    await spawn(page);
    const dock = await openDock(page);
    const cell = dock.getByTestId('numpad-cell-0');

    // The legacy card's cell was `Step 1` and the note lived in the painted
    // text and NOWHERE else, so nothing assertable tracked it. This is an
    // ADDITION, not a weakening of the removed readout.
    await expect(cell).toHaveAttribute('aria-label', 'step 1 — off');
    await cell.click();
    await expect(cell, 'the octave default is 4, so a freshly lit step plays c4')
      .toHaveAttribute('aria-label', 'step 1 — c4');
    expect(await readStep(page, 0, 0)).toMatchObject({ on: true, midi: 60 });
  });
});

test.describe('NUMPAD+ face — the three node.data defects, through the real UI', () => {
  test('⚠ D2: a grid click is UNDOABLE — it used to be a transact with no origin', async ({ page }) => {
    await gotoShell(page);
    await spawn(page);
    const dock = await openDock(page);

    await dock.getByTestId('numpad-cell-5').click();
    await expect
      .poll(async () => (await readStep(page, 0, 5))?.on ?? false, { message: 'the click wrote the step' })
      .toBe(true);

    await undo(page);
    await expect
      .poll(async () => (await readStep(page, 0, 5))?.on ?? false, {
        message: 'Cmd-Z must revert a step edit — before the write seam it did nothing at all',
      })
      .toBe(false);
  });

  test('⚠ D1: ARM + PLAY erases a layer, and Cmd-Z brings it back', async ({ page }) => {
    // The longest gesture chain in this file — spawn, dock, a take, ARM, PLAY,
    // and a transport that has to actually reach the play-from-start edge. It
    // is not renderer-bound; it is simply more steps than the default budget.
    test.slow();
    await gotoShell(page);
    await spawn(page);
    const dock = await openDock(page);

    // Record a take by hand: two lit steps.
    for (const s of [0, 12]) await dock.getByTestId(`numpad-cell-${s}`).click();
    await expect
      .poll(async () => (await readStep(page, 0, 12))?.on ?? false, { message: 'the take is recorded' })
      .toBe(true);
    // What a real >500 ms pause between the take and the destructive act does,
    // so the UndoManager's capture window cannot fuse them into one entry.
    await stopCapturing(page);

    // ARM, then PLAY — the module's headline workflow, and the one that used to
    // destroy sixteen steps through a bare proxy write.
    // `Toggle` emits `role="switch"` AND `control-<paramId>` on the SAME
    // element, so the cell IS the switch.
    await dock.locator('[data-testid="control-recArm"][role="switch"]').click();
    await expect
      .poll(() => page.evaluate((id) => {
        const w = globalThis as unknown as { __patch: { nodes: Record<string, { params: Record<string, number> }> } };
        return w.__patch.nodes[id]?.params.recArm;
      }, NODE), { message: 'REC ARM latched' })
      .toBe(1);
    await dock.locator('[data-testid="control-isPlaying"][role="switch"]').click();

    await expect
      .poll(async () => (await readStep(page, 0, 12))?.on ?? true, {
        timeout: 10_000,
        message: 'arming and playing must clear the active layer (the module’s own behaviour)',
      })
      .toBe(false);

    // ⚠ ONE undo, and what it pops is the CLEAR. The PLAY click and the clear it
    // caused land in the same capture window, so reverting that entry both
    // restores the sixteen steps and stops the transport — which is exactly
    // what a player pressing Cmd-Z after an accidental armed take wants.
    await undo(page);
    await expect
      .poll(async () => (await readStep(page, 0, 12))?.on ?? false, {
        timeout: 10_000,
        message:
          'Cmd-Z must restore the erased take — this is the data-loss defect the write seam closes',
      })
      .toBe(true);
    expect(await readStep(page, 0, 0), 'the WHOLE take came back, not one step').toMatchObject({ on: true });
  });

  test('⚠ D4: DRAGGING a cell changes its note — the def promised this and nothing implemented it', async ({ page }) => {
    await gotoShell(page);
    await spawn(page);
    const dock = await openDock(page);
    const cell = dock.getByTestId('numpad-cell-2');
    const box = (await cell.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    // Drag UP. The panel's map is 6 px per semitone, so 36 px is six semitones
    // above the octave's C — and a drag on an OFF step lights it, which is what
    // makes the grid a picture-you-EDIT rather than a picture-you-toggle.
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx, cy - 36, { steps: 12 });
    await page.mouse.up();

    await expect
      .poll(async () => (await readStep(page, 0, 2))?.midi ?? null, {
        message: 'a drag up must raise the step’s note',
      })
      .toBe(66);
    await expect(cell).toHaveAttribute('aria-label', 'step 3 — f#4');
    // ⚠ AND THE DRAG MUST NOT ALSO TOGGLE. A press that moved has already
    // written its note; toggling on release would undo the edit just made.
    expect((await readStep(page, 0, 2))?.on).toBe(true);
  });
});

test.describe('NUMPAD+ face — the keymap panel', () => {
  test('left-click arms, a keystroke rebinds, and the map persists on the node', async ({ page }) => {
    await gotoShell(page);
    await spawn(page);
    const dock = await openDock(page);

    const capC = dock.getByTestId('numpad-key-0');
    await expect(capC, 'C is bound to Numpad1, whose engraving is "1"')
      .toHaveAttribute('aria-label', 'c — key 1');

    // LEFT-CLICK BEGINS THE REMAP — one click instead of the card's two. The
    // right-click menu still offers Remap / Reset.
    await capC.click();
    const hint = dock.getByTestId('numpad-key-hint');
    await expect(hint, 'the probe’s witness element moves').toHaveText(/press any key to bind c\b/);

    await page.keyboard.press('q');
    await expect(capC).toHaveAttribute('aria-label', 'c — key Q');
    await expect(hint, 'the hint returns to empty once the bind lands').toHaveText('');

    const km = await readKeymap(page);
    expect(km, 'the map is persisted on the NODE, so it rides collab and the save').not.toBeNull();
    expect(km!.KeyQ).toBe(0);
    expect(km!.Numpad1, 'the bijection frees the note’s old key').toBeUndefined();
    expect(km!.Numpad2, 'and every other binding is untouched').toBe(1);
  });

  test('⚠ M4: the panel does NOT stay armed — a click elsewhere disarms it', async ({ page }) => {
    // The property that makes the parity sweep safe. faces-parity clicks the
    // probe's cap and moves on; a panel left listening would capture the NEXT
    // keystroke anything types and silently rebind a key in the fixture it is
    // measuring.
    await gotoShell(page);
    await spawn(page);
    const dock = await openDock(page);

    await dock.getByTestId('numpad-key-3').click();
    const hint = dock.getByTestId('numpad-key-hint');
    await expect(hint).not.toHaveText('');

    // Click somewhere else on the plate — the same thing the sweep does next.
    await dock.getByTestId('numpad-cell-15').click();
    await expect(hint, 'the listening mode is dropped on a pointerdown outside the panel').toHaveText('');

    await page.keyboard.press('z');
    expect(
      await readKeymap(page),
      'a keystroke after disarming must NOT rebind anything — the map is still the default',
    ).toBeNull();
  });

  test('the remap MENU is portaled out and stays fully in view', async ({ page }) => {
    await gotoShell(page);
    await spawn(page);
    const dock = await openDock(page);

    await dock.getByTestId('numpad-key-11').click({ button: 'right' });
    const menu = page.getByTestId('numpad-key-menu');
    await expect(menu).toBeVisible();
    // Portaled to <body>: not a descendant of the dock's own scroll container,
    // so `position: fixed` resolves against the viewport.
    await expect(page.locator('[data-testid="dock-full-view"] [data-testid="numpad-key-menu"]')).toHaveCount(0);

    const box = (await menu.boundingBox())!;
    const vp = page.viewportSize()!;
    expect(box.x, 'the menu is clamped inside the viewport').toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(vp.width);
    expect(box.y + box.height).toBeLessThanOrEqual(vp.height);

    // Reset-to-default is reachable from the menu and writes through the seam.
    await page.getByTestId('numpad-reset-item').click();
    await expect(menu).toHaveCount(0);
  });
});

test.describe('NUMPAD+ face — the instrument survives promotion', () => {
  test('⚠ the KEYPAD still plays with no card mounted, because the listener is in the FACTORY', async ({ page }) => {
    await gotoShell(page);
    await spawn(page);
    // No card anywhere on this shell — the whole point.
    await expect(page.locator('[data-testid="numpad-plus-card"]')).toHaveCount(0);
    await expect
      .poll(() => page.evaluate((id) => {
        const w = globalThis as unknown as {
          __engine?: () => { read: (n: unknown, k: string) => unknown } | null;
          __patch: { nodes: Record<string, unknown> };
        };
        const eng = w.__engine?.();
        const np = w.__patch.nodes[id];
        return eng && np ? eng.read(np, 'activeLayer') : null;
      }, NODE), { timeout: 10_000, message: 'the engine node materialised' })
      .toBe(0);

    // OVERDUB on, then a real document keydown — the module's own instrument.
    await page.evaluate((id) => {
      const w = globalThis as unknown as { __patch: { nodes: Record<string, { params: Record<string, number> }> } };
      const np = w.__patch.nodes[id];
      if (np) np.params.overdub = 1;
    }, NODE);
    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Numpad3', key: '3' }));
      document.dispatchEvent(new KeyboardEvent('keyup', { code: 'Numpad3', key: '3' }));
    });

    await expect
      .poll(async () => (await readStep(page, 0, 0))?.midi ?? null, {
        timeout: 10_000,
        message: 'Numpad3 at octave 4 is D4 = MIDI 62, recorded into step 0 with no UI in the way',
      })
      .toBe(62);

    // And the HERO GRID follows the graph the recording wrote — the face reads
    // the same state the factory writes.
    const dock = await openDock(page);
    await expect(dock.getByTestId('numpad-cell-0')).toHaveAttribute('aria-label', 'step 1 — d4');
  });
});

test.describe('NUMPAD+ — ⚠ the VRT exemption this PR DELETES, measured on the artifact', () => {
  test('a fresh legacy card is STATIC: neither named animation can reach a capture', async ({ page }) => {
    // The deleted exemption read "card has a current-step highlight box + REC
    // ARM pulse animation that animates whether the sequence is running or not."
    // BOTH are gated on params that default to 0. This asserts it on the DOM,
    // not on the source — reading the source once is what produced the wrong
    // sentence, and a second reading would reproduce the same mistake.
    await page.goto('/rack?shell=legacy&seed=none');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, [{ id: NODE, type: 'numpadPlus', position: { x: 200, y: 200 } }]);
    const card = page.locator('[data-testid="numpad-plus-card"]');
    await expect(card).toBeVisible();

    const still = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="numpad-plus-card"]')!;
      return {
        activeStep: el.querySelectorAll('.cell.active').length,
        armed: el.querySelectorAll('.rec-btn.armed').length,
        listening: el.querySelectorAll('.kmap-key.listening').length,
        animations: (document.getAnimations?.() ?? []).filter((a) => {
          const t = (a as { effect?: { target?: Element | null } }).effect?.target ?? null;
          return !!t && el.contains(t);
        }).length,
      };
    });
    expect(
      still,
      'a fresh NUMPAD+ card paints nothing that moves — which is why the permanent ' +
        'VRT exemption naming those two animations described a state the capture never reaches',
    ).toEqual({ activeStep: 0, armed: 0, listening: 0, animations: 0 });

    // ⚠ THE POSITIVE CONTROL, AND IT IS THE HALF THAT MATTERS. Every count above
    // is ZERO, which is also exactly what a WRONG SELECTOR returns — and this
    // assertion is what licenses deleting a permanent VRT exemption, so "the
    // probe read nothing" and "there is nothing to read" must be told apart.
    // Arming REC and starting the transport makes BOTH named animations appear;
    // if the selectors could not see them, that is a test certifying a baseline
    // it never actually checked.
    await page.evaluate((id) => {
      const w = globalThis as unknown as { __patch: { nodes: Record<string, { params: Record<string, number> }> } };
      const n = w.__patch.nodes[id];
      if (n) { n.params.recArm = 1; n.params.isPlaying = 1; }
    }, NODE);
    await expect
      .poll(
        () => page.evaluate(() => {
          const el = document.querySelector('[data-testid="numpad-plus-card"]')!;
          return {
            activeStep: el.querySelectorAll('.cell.active').length,
            armed: el.querySelectorAll('.rec-btn.armed').length,
          };
        }),
        {
          timeout: 10_000,
          message:
            'the SAME selectors must be able to SEE both animations once the transport runs — ' +
            'otherwise the zeros above are a wrong selector rather than a still card',
        },
      )
      .toEqual({ activeStep: 1, armed: 1 });
  });
});
