// e2e/tests/launchpad-face.spec.ts
//
// LAUNCHPAD CONTROL's FIRST SURFACE TEST — and the module had none before this.
//
// ── ⚠ THE MEASUREMENT THAT MADE THIS FILE MANDATORY ─────────────────────────
//
//   grep -rln "launchpad-control-" e2e/ packages/web/src
//     → packages/web/src/lib/ui/modules/LaunchpadControlCard.svelte
//
// ONE file: the card itself. Every `data-testid` that card emits appeared
// NOWHERE else in the repository. Meanwhile the library beneath it is one of
// the most heavily tested in the tree (ten unit files, ~6,300 lines) and it has
// five e2e specs of its own — every one of which takes the `rack` fixture,
// i.e. `?shell=legacy`, and drives `__launchpadTestInstall` / `__launchpadSim`
// (installed by `Canvas.svelte`, not by the card).
//
// So the coverage is real, extensive, and ORTHOGONAL to the surface. Two facts
// follow and they pull in opposite directions:
//
//   * promotion is mechanically SAFE for device behaviour — nothing in the
//     suite goes through the card, so replacing it cannot break a launchpad
//     assertion; and
//   * NOTHING WOULD NOTICE IF THE FACE'S GESTURES WERE WIRED TO NOTHING. A
//     dead face ships green today and would ship green after promotion.
//
// This file closes the second half, and it is written against the FACE rather
// than back-filled against the card being retired.
//
// ── WHAT IT DELIBERATELY DOES NOT ASSERT ────────────────────────────────────
//
// That a real Launchpad connects. No CI runner has one, and `requestMIDIAccess`
// there either rejects or is quietly suppressed. "The press reached the seam"
// is the honest observable for the two handshake cells and is the same one the
// face's own audition probe reads; the BOUND half is driven through the
// SIMULATED single unit the launchpad e2e suite already ships, which is a real
// in-memory device on the real decode path.

import { test, expect, type Locator, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

const SLOW_RENDER = process.env.E2E_SWIFTSHADER === '1' || !!process.env.CI;
const NODE = 'lp';
const CLIP = 'cp';

async function gotoShell(page: Page): Promise<void> {
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({
    timeout: SLOW_RENDER ? 30_000 : 15_000,
  });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

/** The LANE tile's shell for a node. */
function laneShell(page: Page, nodeId: string): Locator {
  return page.locator(`.svelte-flow__node[data-id="${nodeId}"] [data-testid="module-shell"]`);
}

/** Open a node's dock faceplate, scoped BY NODE (opening a second node's
 *  faceplate swaps the dock's occupant, so an unscoped locator would keep
 *  resolving and assert the wrong surface). */
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

/** The audition ledger, read IN THE PAGE (never polled from Node — the repo
 *  rule about sampling a page-side quantity across the protocol). */
async function auditionCount(page: Page, nodeId: string, seam: string): Promise<number> {
  return page.evaluate(
    ([id, s]) => {
      const log = (window as unknown as {
        __auditionLog?: () => { nodeId: string; seam: string; delivered: boolean }[];
      }).__auditionLog;
      if (!log) return -1;
      return log().filter((r) => r.nodeId === id && r.seam === s && r.delivered).length;
    },
    [nodeId, seam] as const,
  );
}

test.describe('LAUNCHPAD CONTROL faceplate', () => {
  test('the LANE TILE is the SHELL, and it carries BOTH handshakes', async ({ page }) => {
    // ⚠ THE REGRESSION PIN FOR THE `NON_SHELL_LANE_TYPES` DRAIN, which is what
    // this promotion actually is. While the carve-out stood, `laneRenderKind`
    // short-circuited to 'legacy' two lines BEFORE `migrated` was consulted —
    // so a face could have been authored, promoted, and completely unreachable
    // in the lane, with every unit gate green. Nothing else in the tree would
    // have said so, because `isShellSwappable` is a pure function whose unit
    // test asserts the SET, not the render.
    await gotoShell(page);
    await spawnPatch(page, [{ id: NODE, type: 'launchpadControlLeft', position: { x: 200, y: 200 } }]);

    const lane = laneShell(page, NODE);
    await expect(lane, 'the lane renders ModuleShell, not LaunchpadControlCard').toBeVisible();
    await expect(
      page.locator(`.svelte-flow__node[data-id="${NODE}"] .launchpad-control-card`),
      'and the legacy card is NOT mounted beside it',
    ).toHaveCount(0);

    // Both gestures reach the lane: an `action` cell is not dock-restricted
    // (only `panel` is), which is the whole reason they are cells rather than
    // body controls.
    await expect(lane.getByTestId('shell-cell-launchpad-control-single')).toBeEnabled();
    await expect(lane.getByTestId('shell-cell-launchpad-control-pair')).toBeEnabled();
  });

  test('pressing CONNECT SINGLE reaches the seam — not merely "does not crash"', async ({ page }) => {
    // The assertion-free click is the shape the audition ledger was built to
    // end: a completely dead button passes "the tile is still visible".
    await gotoShell(page);
    await spawnPatch(page, [{ id: NODE, type: 'launchpadControlLeft', position: { x: 200, y: 200 } }]);

    const before = await auditionCount(page, NODE, 'engine-message');
    expect(before, 'the audition ledger is exposed (VITE_E2E_HOOKS)').toBeGreaterThanOrEqual(0);

    await laneShell(page, NODE).getByTestId('shell-cell-launchpad-control-single').click();

    // Auto-retrying: the press is synchronous but the ledger read is a
    // round-trip, and the handshake itself is fire-and-forget.
    await expect
      .poll(() => auditionCount(page, NODE, 'engine-message'), {
        message: 'the SINGLE press must reach the launchpad device seam and report DELIVERED',
      })
      .toBeGreaterThan(before);

    // ⚠ WHAT THIS CANNOT SEE, AND WHERE IT IS SEEN INSTEAD. On this runner
    // `navigator.requestMIDIAccess` EXISTS (Chromium ships Web MIDI) and no
    // Launchpad does, so `delivered` can only ever be true here — the false
    // branch is unreachable by construction. That is why the probe's negative
    // control is a UNIT test (`launchpad-cell-actions.test.ts`) driving the
    // no-Web-MIDI seam directly: without it, "the probe can fail" would be a
    // claim nothing in the repo makes.

    // The shell survives whichever branch the handshake takes.
    await expect(laneShell(page, NODE)).toBeVisible();
  });

  test('the DOCK BODY paints no state word, and ANNOUNCES the state instead', async ({ page }) => {
    // ⚠ BOTH HALVES OF THE RESTING-TEXT RULING, and no source gate can see
    // either. `face-resting-text-source` reads FACE FIELDS and states that a
    // body's markup is its blind spot; the dock VRT baseline can photograph a
    // lamp but cannot read an attribute. The card this face replaces painted a
    // NINE-BRANCH status sentence here.
    await gotoShell(page);
    await spawnPatch(page, [{ id: NODE, type: 'launchpadControlLeft', position: { x: 200, y: 200 } }]);
    const dock = await openDock(page, NODE);

    const body = dock.getByTestId(`launchpad-binder-body-${NODE}`);
    await expect(body).toBeVisible();

    // ── the PAINTED text carries no state word ──────────────────────────────
    const painted = (await body.innerText()).toUpperCase();
    for (const forbidden of ['NOT CONNECTED', 'PAIRED ✓', 'DRIVING CLIP-PLAYER', 'SINGLE UNIT ✓']) {
      expect(painted, `the resting faceplate must not paint "${forbidden}"`).not.toContain(forbidden);
    }
    // ⚠ NEGATIVE CONTROL FOR THE READ ITSELF. `innerText` on a mis-resolved or
    // empty element is '', which satisfies every assertion above — "the surface
    // is compliant" and "the surface is not there" must not look alike. The
    // lamp CAPTIONS are the permitted text that is always present.
    expect(painted, 'the body really has text on it').toContain('LINK');
    expect(painted).toContain('CLIP');
    // …and the PRE-CONNECT EMPTY STATE, which is the whole content of the plate
    // before a handshake and the reason "no device yet" and "the body failed to
    // mount" are different pictures in the dock baseline.
    await expect(body.getByTestId(`launchpad-binder-empty-${NODE}`)).toContainText(/Connect a Launchpad/);

    // ── the ACCESSIBLE name carries it ──────────────────────────────────────
    const link = body.getByTestId(`launchpad-led-link-${NODE}`);
    await expect(link, 'the lamp is DARK before a device is bound').toHaveAttribute('data-lit', '0');
    await expect(link).toHaveAttribute('aria-label', /no Launchpad bound/i);

    const clip = body.getByTestId(`launchpad-led-clip-${NODE}`);
    await expect(clip).toHaveAttribute('data-lit', '0');
    await expect(clip).toHaveAttribute('aria-label', /no clip-player bound/i);

    // ── the PRE-CONNECT branch, which is also what the VRT baseline captures ─
    // No device and no clipplayer, so neither body control renders. Asserting
    // it here means the baseline's precondition is checked by something other
    // than the baseline.
    await expect(body.getByTestId(`launchpad-binder-bind-${NODE}`)).toHaveCount(0);
    await expect(body.getByTestId(`launchpad-binder-view-seg-${NODE}`)).toHaveCount(0);

    // ⚠ AND EXACTLY ONE OF EACH GESTURE ON THE WHOLE PLATE. Both handshakes are
    // ranked cells — that is what puts them on the lane tile — so a second
    // button inside the body would be one gesture with two affordances.
    await expect(dock.getByTestId('shell-cell-launchpad-control-single')).toHaveCount(1);
    await expect(dock.getByTestId('shell-cell-launchpad-control-pair')).toHaveCount(1);
    await expect(body.getByRole('button', { name: /Pair|Connect single/ })).toHaveCount(0);
  });

  test('BOUND: the body\'s BIND control and four-role segment drive the REAL singleton', async ({ page }) => {
    // The half a source gate and a solo-spawn baseline both structurally miss.
    // `__launchpadTestInstallSingle` installs an in-memory Launchpad on the
    // real decode path, forces the single deployment and binds the clip-player
    // — the same driver the five legacy launchpad specs use, pointed at the
    // face instead of the card.
    await gotoShell(page);
    await spawnPatch(page, [
      { id: CLIP, type: 'clipplayer', position: { x: 200, y: 420 } },
      { id: NODE, type: 'launchpadControlLeft', position: { x: 200, y: 200 } },
    ]);
    const installed = await page.evaluate(async (clipId) => {
      const w = globalThis as unknown as { __launchpadTestInstallSingle?: (id: string) => Promise<boolean> };
      return w.__launchpadTestInstallSingle ? w.__launchpadTestInstallSingle(clipId) : false;
    }, CLIP);
    expect(installed, 'the simulated single-unit Launchpad installed').toBe(true);

    const dock = await openDock(page, NODE);
    const body = dock.getByTestId(`launchpad-binder-body-${NODE}`);

    // Both lamps LIT, and the details now name the deployment and the node.
    await expect(body.getByTestId(`launchpad-led-link-${NODE}`)).toHaveAttribute('data-lit', '1');
    const clip = body.getByTestId(`launchpad-led-clip-${NODE}`);
    await expect(clip).toHaveAttribute('data-lit', '1');
    await expect(
      clip,
      'WHICH clip-player is driven — the finding the deleted status line carried, now speakable',
    ).toHaveAttribute('aria-label', new RegExp(CLIP));

    // ── the four-role segment appears, and picking a role reaches the singleton
    const seg = body.getByTestId(`launchpad-binder-view-seg-${NODE}`);
    await expect(seg, 'the segment exists in SINGLE mode').toBeVisible();
    const clipRole = body.getByTestId(`launchpad-binder-view-clip-${NODE}`);
    await expect(clipRole, 'the installer forces the CLIP role').toHaveAttribute('aria-pressed', 'true');

    await body.getByTestId(`launchpad-binder-view-arranger-${NODE}`).click();
    // ⚠ THE OBSERVABLE IS THE SINGLETON, NOT THE BUTTON. A segment that only
    // repainted itself would pass an `aria-pressed` assertion while writing
    // nothing — the dead-button shape one layer up.
    await expect
      .poll(async () => page.evaluate(() => {
        const w = globalThis as unknown as { __launchpadSingleSim?: { state: () => { singleView?: string } } };
        return w.__launchpadSingleSim?.state().singleView ?? null;
      }), { message: 'picking a role must call setLaunchpadView on the live control singleton' })
      .toBe('arranger');
    await expect(body.getByTestId(`launchpad-binder-view-arranger-${NODE}`)).toHaveAttribute('aria-pressed', 'true');

    // ── BIND flips, and its caption names the action it will perform ─────────
    const bind = body.getByTestId(`launchpad-binder-bind-${NODE}`);
    await expect(bind, 'bound, so the control offers the OPPOSITE action').toHaveText(/Unbind/);
    await bind.click();
    await expect(body.getByTestId(`launchpad-led-clip-${NODE}`)).toHaveAttribute('data-lit', '0');
    await expect(
      body.getByTestId(`launchpad-binder-bind-${NODE}`),
      'and it now offers the other one — which is why this is not a ranked action cell',
    ).toHaveText(/^Bind/);
  });
});
