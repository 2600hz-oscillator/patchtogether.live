// e2e/tests/controlsurface-face.spec.ts
//
// CONTROL SURFACE, against the FACEPLATE — the DEFAULT renderer.
//
// ── ⚠ WHY THIS FILE EXISTS, AND WHY `control-surface.spec.ts` IS NOT ENOUGH ──
//
// All three tests in `control-surface.spec.ts` boot `/rack?shell=legacy`. That
// was CORRECT while this module was a `NON_SHELL_LANE_TYPES` snowflake whose
// verbatim card WAS the default lane render, and it stays correct as coverage
// of that card — `?shell=legacy` still renders it. It stops being sufficient
// the moment the module is PROMOTED: those tests keep passing against a
// surface no player meets, while the face's lock, board, proxies, rename and
// — above all — the PRUNE have zero coverage. Green, and blind.
//
// ── THE PRUNE LEG IS THE POINT OF THIS FILE ─────────────────────────────────
//
// `pruneSurfaceDangling` had exactly ONE production caller — the legacy card's
// `$effect` — and controlSurface is in neither half of
// `HEADLESS_MOUNT_LANE_TYPES`, so promotion silently stops it with every
// registry test green (the ES-9 card-only-side-effect shape). The fix parks it
// on the `tileBody`; the leg below proves it fires WITH THE DOCK CLOSED, which
// is the state the card-era wiring could never have covered.
//
// ── WHAT IT ASSERTS ON ──────────────────────────────────────────────────────
//
// The GRAPH, never pixels: every gesture here has a durable observable in
// `node.data` (the surface's bindings / locked / layout) or in the SOURCE
// node's `params` — renderer-independent, and the same thing a collaborator
// and the undo stack see. The pixels are the two face-controlSurface VRT
// scenes' job.

import { test, expect, type Locator, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { BOOT_MS, SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';

const SURFACE = 'cs-1';
const SOURCE = 'adsr-1';

interface PatchNode {
  id: string;
  type: string;
  domain: string;
  position: { x: number; y: number };
  params: Record<string, number>;
  data?: Record<string, unknown>;
}

/** A `pageerror` collector. ⚠ EVERY FACE SPEC OWES ONE: a shared derivation
 *  repaired on `ModuleShellPlaceholder` can still throw inside `ModuleShell`,
 *  and only PROMOTING reveals it — a face that throws mid-render leaves a
 *  plausible-looking empty tile. */
function watchPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  return errors;
}

function realErrors(errors: string[]): string[] {
  return errors.filter((e) => !e.includes('AudioContext'));
}

async function gotoShell(page: Page): Promise<void> {
  await page.goto('/rack?seed=none');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: BOOT_MS });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

/** The LANE tile's shell for a node. */
function laneShell(page: Page, nodeId: string): Locator {
  return page.locator(`.svelte-flow__node[data-id="${nodeId}"] [data-testid="module-shell"]`);
}

/** Open a node's dock faceplate, scoped BY NODE. */
async function openDock(page: Page, nodeId: string): Promise<Locator> {
  const shell = laneShell(page, nodeId);
  await expect(shell).toBeVisible();
  await shell.getByTestId('shell-open-dock').click();
  const dockShell = page
    .getByTestId('dock-full-view')
    .locator(`[data-testid="module-shell"][data-shell-tier="dock"][data-shell-node="${nodeId}"]`);
  await expect(dockShell).toBeVisible();
  return dockShell;
}

async function spawnPair(page: Page): Promise<void> {
  await spawnPatch(page, [
    { id: SURFACE, type: 'controlSurface', position: { x: 700, y: 80 }, domain: 'meta' },
    { id: SOURCE, type: 'adsr', position: { x: 80, y: 80 }, domain: 'audio' },
  ]);
}

async function readSurfaceData(page: Page, surfaceId: string) {
  return await page.evaluate((id) => {
    const w = window as unknown as { __patch: { nodes: Record<string, PatchNode> } };
    return (w.__patch.nodes[id]?.data ?? null) as {
      bindings?: { moduleId: string; paramId: string; name?: string }[];
      locked?: boolean;
    } | null;
  }, surfaceId);
}

/** Bind the SOURCE's Attack through the REAL gesture: right-click the knob →
 *  the control context menu → "Send to <surface>". `knobHost` is whichever
 *  surface currently renders the source's attack knob. */
async function sendAttackToSurface(page: Page, knobHost: Locator): Promise<void> {
  const attack = knobHost.locator('[data-testid="control-attack"]');
  await expect(attack).toBeVisible();
  await attack.click({ button: 'right' });
  const menu = page.locator('[data-testid="control-context-menu"]');
  await expect(menu).toBeVisible();
  const sendItem = menu.locator(`[data-testid="ctx-surface-${SURFACE}"]`);
  await expect(sendItem).toContainText('Send to');
  await sendItem.click();
  await expect
    .poll(async () => ((await readSurfaceData(page, SURFACE))?.bindings ?? []).length, {
      message: 'the Send-to gesture records the pointer on the surface node',
    })
    .toBe(1);
}

test.describe('CONTROL SURFACE faceplate', () => {
  test.beforeEach(({}, testInfo) => {
    testInfo.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 2);
  });

  test('the LANE TILE is the SHELL: LOCK + the empty-state prompt, and no legacy card', async ({ page }) => {
    // ⚠ THE REGRESSION PIN FOR THE `NON_SHELL_LANE_TYPES` DRAIN, which is what
    // this promotion actually is. While the carve-out stood, `laneRenderKind`
    // short-circuited to 'legacy' BEFORE `migrated` was consulted — a face
    // could have been authored, promoted, and completely unreachable in the
    // lane, with every unit gate green.
    const errors = watchPageErrors(page);
    await gotoShell(page);
    await spawnPair(page);

    const lane = laneShell(page, SURFACE);
    await expect(lane, 'the lane renders ModuleShell, not ControlSurfaceCard').toBeVisible();
    await expect(
      page.locator(`.svelte-flow__node[data-id="${SURFACE}"] .control-surface-card`),
      'and the legacy card is NOT mounted beside it',
    ).toHaveCount(0);

    // The LOCK reaches the lane: a toggle cell is not dock-restricted, which
    // is the whole reason it is a cell rather than a body control.
    await expect(lane.getByTestId('shell-cell-control-surface-lock')).toBeVisible();

    // The tileBody's empty state paints the module's only discovery path.
    await expect(lane.getByTestId(`cs-tile-empty-${SURFACE}`)).toContainText(/Send to/);

    expect(realErrors(errors), 'no pageerror while the face renders').toEqual([]);
  });

  test('toggling LOCK from the TILE flips node.data.locked — the same key the card writes', async ({ page }) => {
    await gotoShell(page);
    await spawnPair(page);

    // `Toggle.svelte` puts the testid ON the `role="switch"` element itself.
    const sw = laneShell(page, SURFACE).getByTestId('shell-cell-control-surface-lock');
    await expect(sw).toHaveAttribute('role', 'switch');

    expect(((await readSurfaceData(page, SURFACE))?.locked ?? false), 'a fresh surface is unlocked').toBe(false);
    await sw.click();
    await expect
      .poll(async () => (await readSurfaceData(page, SURFACE))?.locked ?? false, {
        message: 'LOCK ON reaches the Y.Doc through setSurfaceLocked',
      })
      .toBe(true);
    await sw.click();
    await expect
      .poll(async () => (await readSurfaceData(page, SURFACE))?.locked ?? false, {
        message: 'LOCK OFF reaches the Y.Doc too — the switch is live, not latched',
      })
      .toBe(false);
  });

  test('BOUND: the dock BOARD proxies the SOURCE param, and ✎ rename writes binding.name', async ({ page }) => {
    const errors = watchPageErrors(page);
    await gotoShell(page);
    await spawnPair(page);

    // Bind through the REAL gesture, from the SOURCE's own faced knob in its
    // lane — the module's only assignment path (there is no affordance on the
    // board itself).
    await sendAttackToSurface(page, laneShell(page, SOURCE));

    const dock = await openDock(page, SURFACE);
    const board = dock.getByTestId('cs-board');
    await expect(board).toBeVisible();
    await expect(board.getByTestId('cs-board-empty')).toHaveCount(0);
    await expect(board.getByTestId('cs-board-group-label')).toContainText(/adsr/i);

    // ⚠ THE MULTISET GUARD, asserted live where faces-parity cannot reach (the
    // sweep never binds a proxy): a bound board must add ZERO `control-*`
    // testids to the dock shell — one would fail the whole face's parity.
    const controlIds = await dock
      .locator('[data-testid^="control-"]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')));
    expect(controlIds, 'a bound proxy claims no control-<paramId> testid').toEqual([]);

    // Pointer proof (the legacy spec's, against the BODY): push the SOURCE
    // param off-default, reset via the PROXY's double-click — the source
    // param must move, because the proxy has no state of its own.
    const dial = board.locator(`[data-testid="cs-board-dial-${SOURCE}-attack"]`);
    await expect(dial).toBeVisible();
    await page.evaluate((src) => {
      const w = window as unknown as { __patch: { nodes: Record<string, PatchNode> } };
      w.__patch.nodes[src].params.attack = 0.9;
    }, SOURCE);
    await dial.dblclick();
    await expect
      .poll(async () =>
        page.evaluate((src) => {
          const w = window as unknown as { __patch: { nodes: Record<string, PatchNode> } };
          return w.__patch.nodes[src].params.attack;
        }, SOURCE),
      { message: 'the proxy wrote the SOURCE param (reset-to-default)' },
      )
      .not.toBe(0.9);

    // ✎ rename (unlocked by default) writes binding.name through the shared
    // in-place mutator — the key the Electra preset generator reads.
    await board.getByTestId(`cs-board-rename-${SOURCE}-attack`).click();
    const input = board.getByTestId(`cs-board-rename-input-${SOURCE}-attack`);
    await expect(input).toBeVisible();
    await input.fill('ATK');
    await input.press('Enter');
    await expect
      .poll(async () => (await readSurfaceData(page, SURFACE))?.bindings?.[0]?.name ?? null, {
        message: 'the rename lands on the binding in node.data',
      })
      .toBe('ATK');

    expect(realErrors(errors), 'no pageerror across bind, proxy write and rename').toEqual([]);
  });

  test('the PRUNE fires from the TILE with the dock CLOSED — the card-only side effect, rehomed', async ({ page }) => {
    await gotoShell(page);
    await spawnPair(page);

    await sendAttackToSurface(page, laneShell(page, SOURCE));
    // ⚠ THE DOCK IS NEVER OPENED IN THIS TEST. The board body is not mounted;
    // the lane tile is the only controlSurface surface alive — exactly the
    // state in which the card-era wiring would have left the binding to rot.

    // Delete the SOURCE node (the unambiguous "definitely gone" branch of
    // bindingDefinitelyDangling).
    await page.evaluate((src) => {
      const w = window as unknown as {
        __patch: { nodes: Record<string, PatchNode> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        delete w.__patch.nodes[src];
      });
    }, SOURCE);

    await expect
      .poll(async () => (await readSurfaceData(page, SURFACE))?.bindings ?? null, {
        message:
          'the tileBody $effect prunes the dangling binding — with no card and no dock body ' +
          'mounted anywhere, which is the state that killed the ES-9 policy push',
      })
      .toEqual([]);

    // …and the tile is back to its empty state (the strip has nothing to show).
    await expect(laneShell(page, SURFACE).getByTestId(`cs-tile-empty-${SURFACE}`)).toBeVisible();
  });
});
