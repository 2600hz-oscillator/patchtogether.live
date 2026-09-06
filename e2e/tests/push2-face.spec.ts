// e2e/tests/push2-face.spec.ts
//
// PUSH 2 CONTROL's FACEPLATE — the coverage the promotion would otherwise have
// lost, and the reason it is a SEPARATE file rather than a re-point.
//
// ── ⚠ THE MEASUREMENT THAT MADE THIS FILE MANDATORY ─────────────────────────
//
// Both existing push2 specs — `push2-clip-launch.spec.ts` and
// `clipplayer-transport-no-controller.spec.ts` — take the `rack` fixture, which
// at the time booted the PRE-INVERSION renderer. That fixture existed precisely
// because `/rack` renders each module as a FACEPLATE tile, so a module's own
// pre-promotion testids do not exist in the lane.
//
// So the shipped coverage ran in THE ONE PLACE THE FACE CANNOT EXIST.
// That stays correct as coverage of the CARD — the card still ships and still
// renders there — and it becomes GREEN AND BLIND about the face: every gesture
// the promotion moves would have had zero coverage while those specs went on
// passing. CLAUDE.md's precondition rule says fix the SUBJECT rather than the
// threshold, so the legacy specs are UNTOUCHED and this file drives the default
// renderer.
//
// ── WHAT IT DELIBERATELY DOES NOT ASSERT ────────────────────────────────────
//
// That a real Push 2 connects. No CI runner has one, and `requestMIDIAccess`
// there either rejects or is quietly suppressed. "The press reached the seam"
// is the honest observable for the ranked CONNECT cell and is the same one the
// face's own audition probe reads; the BOUND half is driven through the
// SIMULATED Push the push2 e2e suite already ships, which is a real in-memory
// device on the real decode path.
//
// ⚠ AND THE OBSERVABLE FOR EVERY BODY CONTROL IS THE SINGLETON, NEVER THE
// BUTTON. A lane button that only repainted itself would satisfy an
// `aria-pressed` assertion while writing nothing — the dead-button shape one
// layer up from the dead-cell shape the audition ledger exists to catch. This
// module makes that trap easy to fall into, because none of its state is on
// `node.data`, so `readData` is structurally blind to all of it.

import { test, expect, type Locator, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

const SLOW_RENDER = process.env.E2E_SWIFTSHADER === '1' || !!process.env.CI;
const NODE = 'px';
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

/** The push2 control SINGLETON's own state — the only honest observable for
 *  this module's body controls, since none of its state is on `node.data`. */
async function pushState(page: Page): Promise<Record<string, unknown> | null> {
  return page.evaluate(() => {
    const w = globalThis as unknown as { __push2Sim?: { state: () => Record<string, unknown> } };
    return w.__push2Sim?.state() ?? null;
  });
}

test.describe('PUSH 2 CONTROL faceplate', () => {
  test('the LANE TILE is the SHELL, and CONNECT is on it', async ({ page }) => {
    // ⚠ THE REGRESSION PIN FOR THE WHOLE PROMOTION. Before it, `push2Control`
    // was not in `NON_SHELL_LANE_TYPES` and not in `STRICT_FACES`, so
    // `laneRenderKind` returned 'placeholder' — a uniform rackline tile with
    // ZERO ranked controls, on a module that also declares `inputs: []` and
    // `outputs: []` so its jack rail is empty too. A name and a badge, and the
    // gesture the module is inert without reachable only through the dock.
    await gotoShell(page);
    await spawnPatch(page, [{ id: NODE, type: 'push2Control', position: { x: 200, y: 200 }, domain: 'meta' }]);

    const lane = laneShell(page, NODE);
    await expect(lane, 'the lane renders ModuleShell, not Push2ControlCard').toBeVisible();

    // An `action` cell is not dock-restricted (only `panel` is), which is the
    // whole reason CONNECT is a cell rather than a body control.
    await expect(lane.getByTestId('shell-cell-push2-control-connect')).toBeEnabled();

    // ⚠ AND THE BODY DOES **NOT** REACH THE LANE, deliberately. At 192 px the
    // 960-px replica scales to 0.20× — eight coloured bars with no legible
    // text, a picture that MISREPRESENTS the hardware, which is worse than no
    // picture. `dockFullViewHeadPlan` is what keeps it out.
    await expect(page.getByTestId(`push2-surface-body-${NODE}`)).toHaveCount(0);
  });

  test('pressing CONNECT reaches the seam — not merely "does not crash"', async ({ page }) => {
    // The assertion-free click is the shape the audition ledger was built to
    // end: a completely dead button passes "the tile is still visible".
    await gotoShell(page);
    await spawnPatch(page, [{ id: NODE, type: 'push2Control', position: { x: 200, y: 200 }, domain: 'meta' }]);

    const before = await auditionCount(page, NODE, 'engine-message');
    expect(before, 'the audition ledger is exposed (VITE_E2E_HOOKS)').toBeGreaterThanOrEqual(0);

    await laneShell(page, NODE).getByTestId('shell-cell-push2-control-connect').click();

    // Auto-retrying: the press is synchronous but the ledger read is a
    // round-trip, and `connectPush` is fire-and-forget behind it.
    await expect
      .poll(() => auditionCount(page, NODE, 'engine-message'), {
        message: 'the CONNECT press must reach the push2 device seam and report DELIVERED',
      })
      .toBeGreaterThan(before);

    // ⚠ WHAT THIS CANNOT SEE, AND WHERE IT IS SEEN INSTEAD. On this runner
    // `navigator.requestMIDIAccess` EXISTS (Chromium ships Web MIDI) and no
    // Push does, so `delivered` can only ever be true here — the false branch
    // is unreachable by construction. That is why the probe's negative control
    // is a UNIT test (`push2-cell-actions.test.ts`) driving the no-Web-MIDI
    // seam directly: without it, "the probe can fail" would be a claim nothing
    // in the repo makes.

    // The shell survives whichever branch the request takes — including a
    // REJECTED `requestMIDIAccess`, which is an ordinary outcome rather than an
    // exception and must not surface as a `pageerror`.
    await expect(laneShell(page, NODE)).toBeVisible();
  });

  test('the DOCK BODY paints the REPLICA and no state word, and ANNOUNCES the state instead', async ({ page }) => {
    // ⚠ BOTH HALVES OF THE RESTING-TEXT RULING, and no source gate can see
    // either. `face-resting-text-source` reads FACE FIELDS and states that a
    // body's markup is its blind spot; the dock VRT baseline can photograph a
    // lamp but cannot read an attribute. The card this face replaces painted a
    // NINE-BRANCH status region here.
    await gotoShell(page);
    await spawnPatch(page, [{ id: NODE, type: 'push2Control', position: { x: 200, y: 200 }, domain: 'meta' }]);
    const dock = await openDock(page, NODE);

    const body = dock.getByTestId(`push2-surface-body-${NODE}`);
    await expect(body).toBeVisible();

    // ── THE REPLICA IS MOUNTED, and it is the surface the module exists for ──
    const canvas = body.getByTestId(`push2-face-canvas-${NODE}`);
    await expect(canvas).toBeVisible();
    // Its backing size is the hardware's, so the picture is a replica rather
    // than a re-layout; the CSS width is what scales it.
    await expect(canvas).toHaveAttribute('width', '960');
    await expect(canvas).toHaveAttribute('height', '160');

    // ── the PAINTED text carries no state word ──────────────────────────────
    const painted = (await body.innerText()).toUpperCase();
    for (const forbidden of ['NOT CONNECTED', 'PUSH 2 ✓', 'DRIVING CLIP-PLAYER', 'SCREEN NOT CONNECTED']) {
      expect(painted, `the resting faceplate must not paint "${forbidden}"`).not.toContain(forbidden);
    }
    // ⚠ NEGATIVE CONTROL FOR THE READ ITSELF. `innerText` on a mis-resolved or
    // empty element is '', which satisfies every assertion above — "the surface
    // is compliant" and "the surface is not there" must not look alike. The
    // lamp CAPTIONS are the permitted text that is always present.
    expect(painted, 'the body really has text on it').toContain('PUSH');
    expect(painted).toContain('SCREEN');
    expect(painted).toContain('BOUND');

    // ── the ACCESSIBLE name carries it ──────────────────────────────────────
    const pushLed = body.getByTestId(`push2-face-led-push-${NODE}`);
    await expect(pushLed, 'the lamp is DARK before a device is bound').toHaveAttribute('data-lit', '0');
    await expect(pushLed).toHaveAttribute('aria-label', /No Push 2 connected/i);

    const boundLed = body.getByTestId(`push2-face-led-bound-${NODE}`);
    await expect(boundLed).toHaveAttribute('data-lit', '0');
    await expect(boundLed).toHaveAttribute('aria-label', /Not driving a clip-player/i);

    // ⚠ AN UNLIT SCREEN LAMP IS NOT A FAULT, and the tone is where that is said.
    // The display "degrades to nothing" by design, so a warn tint on the
    // DEFAULT path would be a lie in the opposite direction from the one the
    // resting-text ruling usually guards against.
    const screenLed = body.getByTestId(`push2-face-led-screen-${NODE}`);
    await expect(screenLed).toHaveAttribute('data-lit', '0');
    await expect(screenLed, 'absent, not failed').toHaveClass(/accent/);

    // ── the FLIP POSITION, which used to be a painted `i/N` badge ───────────
    // The deletion's finding — "there are N modules in this lane and you are
    // looking at the i-th" — is speakable and assertable, and unpainted.
    await expect(body.getByTestId(`push2-face-flip-${NODE}`)).toHaveAttribute('aria-label', /Push card/);

    // ── the PRE-CONNECT branch, which is also what the VRT baseline captures ─
    // No device and no clipplayer, so neither body control renders. Asserting
    // it here means the baseline's precondition is checked by something other
    // than the baseline.
    await expect(body.getByTestId(`push2-face-bind-${NODE}`)).toHaveCount(0);
    await expect(body.getByTestId(`push2-face-view-seg-${NODE}`)).toHaveCount(0);

    // ⚠ AND EXACTLY ONE CONNECT GESTURE ON THE WHOLE PLATE. It is a ranked cell
    // — that is what puts it on the lane tile — so a second button inside the
    // body would be one gesture with two affordances and a second thing to keep
    // in sync.
    await expect(dock.getByTestId('shell-cell-push2-control-connect')).toHaveCount(1);
    await expect(body.getByRole('button', { name: /^Connect Push/ })).toHaveCount(0);
  });

  test('BOUND: the body\'s lane select, view segment and BIND drive the REAL singleton', async ({ page }) => {
    // The half a source gate and a solo-spawn baseline both structurally miss.
    // `__push2TestInstall` installs an in-memory Push on the real decode path
    // and binds the clip-player — the same driver `push2-clip-launch.spec.ts`
    // uses, pointed at the face instead of the card.
    await gotoShell(page);
    await spawnPatch(page, [
      { id: CLIP, type: 'clipplayer', position: { x: 200, y: 420 }, domain: 'audio' },
      { id: NODE, type: 'push2Control', position: { x: 200, y: 200 }, domain: 'meta' },
    ]);
    const installed = await page.evaluate(async (clipId) => {
      const w = globalThis as unknown as { __push2TestInstall?: (id: string) => Promise<boolean> };
      return w.__push2TestInstall ? await w.__push2TestInstall(clipId) : false;
    }, CLIP);
    expect(installed, 'the simulated Push 2 installed').toBe(true);

    const dock = await openDock(page, NODE);
    const body = dock.getByTestId(`push2-surface-body-${NODE}`);

    // Both lamps LIT, and BOUND's detail now names the node.
    await expect(body.getByTestId(`push2-face-led-push-${NODE}`)).toHaveAttribute('data-lit', '1');
    const boundLed = body.getByTestId(`push2-face-led-bound-${NODE}`);
    await expect(boundLed).toHaveAttribute('data-lit', '1');
    await expect(
      boundLed,
      'WHICH clip-player is driven — the finding the deleted status sentence carried, now speakable',
    ).toHaveAttribute('aria-label', new RegExp(CLIP));

    // ── the LANE SELECT reaches the control singleton ───────────────────────
    // ⚠ THE OBSERVABLE IS THE SINGLETON, NOT THE BUTTON — and on this module
    // that distinction is the whole reason the lane select is a body control.
    // A `ShellSelectorCell` COULD read the same module-scope rune, but
    // ModuleShell re-projects a cell only on `nodeVersion(id)` and this module
    // writes `node.data` zero times, so a cell would never notice the lane
    // moving. Here the click must land on `selectChannel`.
    await expect.poll(async () => (await pushState(page))?.selectedChannel).toBe(0);
    await body.getByTestId(`push2-face-lane-4-${NODE}`).click();
    await expect
      .poll(async () => (await pushState(page))?.selectedChannel, {
        message: 'a lane button must call selectChannel on the live control singleton',
      })
      .toBe(3);
    await expect(body.getByTestId(`push2-face-lane-4-${NODE}`)).toHaveAttribute('aria-pressed', 'true');
    await expect(
      body.getByTestId(`push2-face-lane-1-${NODE}`),
      'one control with eight positions, not eight independent controls',
    ).toHaveAttribute('aria-pressed', 'false');

    // ── the four-role segment appears, and picking a role reaches the singleton
    const seg = body.getByTestId(`push2-face-view-seg-${NODE}`);
    await expect(seg, 'the segment exists once a device is connected').toBeVisible();
    await body.getByTestId(`push2-face-view-arranger-${NODE}`).click();
    await expect
      .poll(async () => (await pushState(page))?.singleView, {
        message: 'picking a role must call setLaunchpadView on the live control singleton',
      })
      .toBe('arranger');
    await expect(body.getByTestId(`push2-face-view-arranger-${NODE}`)).toHaveAttribute('aria-pressed', 'true');

    // ── BIND flips, and its caption names the action it will perform ─────────
    const bind = body.getByTestId(`push2-face-bind-${NODE}`);
    await expect(bind, 'bound, so the control offers the OPPOSITE action').toHaveText(/Unbind/);
    await bind.click();
    await expect(body.getByTestId(`push2-face-led-bound-${NODE}`)).toHaveAttribute('data-lit', '0');
    await expect(
      body.getByTestId(`push2-face-bind-${NODE}`),
      'and it now offers the other one — which is why this is not a ranked action cell',
    ).toHaveText(/^Bind/);
  });
});
