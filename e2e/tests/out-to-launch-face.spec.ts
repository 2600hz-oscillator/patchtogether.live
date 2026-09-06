// e2e/tests/out-to-launch-face.spec.ts
//
// OUT TO LAUNCH's FACEPLATE — the coverage the promotion would otherwise have
// lost, plus the regression pin for a live defect the promotion uncovered.
//
// ── WHY A SEPARATE FILE ─────────────────────────────────────────────────────
//
// The module's shipped e2e, `launchpad-monitor-survives-card-collapse.spec.ts`,
// is the #1728 guard: the LED pump and the device claim must outlive the
// surface that bound them. That spec is REPOINTED by this PR (its subject moved
// from the card to the faceplate body, which unmounts on collapse in exactly the
// same way) and it stays focused on the hardware lifetime. This file is the
// other half: what the FACE itself carries, and whether the lane tile tells the
// truth.
//
// ⚠ WHAT IT DELIBERATELY DOES NOT ASSERT: that a real Launchpad connects. No CI
// runner has one, and `requestMIDIAccess` there either rejects or is quietly
// suppressed. "The press reached the seam" is the honest observable for the
// ranked CONNECT cell and is the same one the face's own audition probe reads;
// the BOUND half is driven through the SIMULATED Mini Mk3 the launchpad e2e
// suite already ships, in the collapse spec.
//
// ⚠ NAME CHECK: `out-to-launch-face.spec.ts` matches NO glob in
// `e2e/webgl-heavy-globs.ts`, so it runs in the sharded PR matrix. Verified with
// that module's own minimatch matcher rather than by eye — `video-*.spec.ts`
// would have silently deleted this file's PR coverage, and a name like
// `video-monitor-face.spec.ts` is the obvious one to reach for.

import { test, expect, type Locator, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

const SLOW_RENDER = process.env.E2E_SWIFTSHADER === '1' || !!process.env.CI;
const NODE = 'otl';
const SRC = 'src';
const VOUT = 'vout';

async function gotoShell(page: Page): Promise<void> {
  await page.goto('/rack?seed=none');
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
async function auditions(
  page: Page,
  nodeId: string,
): Promise<{ delivered: number; total: number }> {
  return page.evaluate((id) => {
    const log = (window as unknown as {
      __auditionLog?: () => { nodeId: string; seam: string; delivered: boolean }[];
    }).__auditionLog;
    if (!log) return { delivered: -1, total: -1 };
    const rows = log().filter((r) => r.nodeId === id && r.seam === 'engine-message');
    return { delivered: rows.filter((r) => r.delivered).length, total: rows.length };
  }, nodeId);
}

/**
 * Summarise a lane tile's thumbnail canvas IN THE PAGE.
 *
 * ⚠ The accumulation happens page-side and returns one object, rather than a
 * Playwright poll sampling pixels one round trip at a time on the same main
 * thread as the renderer it is measuring.
 */
async function thumbStats(
  page: Page,
  nodeId: string,
): Promise<{ mean: number; max: number } | null> {
  return page.evaluate((id) => {
    const el = document.querySelector(`[data-thumb-node="${id}"]`) as HTMLCanvasElement | null;
    if (!el) return null;
    const c = el.getContext('2d');
    if (!c) return null;
    const d = c.getImageData(0, 0, el.width, el.height).data;
    let sum = 0;
    let max = 0;
    for (let i = 0; i < d.length; i += 4) {
      const v = d[i] + d[i + 1] + d[i + 2];
      sum += v;
      if (v > max) max = v;
    }
    return { mean: sum / (d.length / 4), max };
  }, nodeId);
}

test.describe('OUT TO LAUNCH faceplate', () => {
  test.describe.configure({ timeout: 120_000 });

  test('the LANE TILE is the SHELL, and CONNECT is on it and reaches the seam', async ({ page }) => {
    // ⚠ THE REGRESSION PIN FOR THE WHOLE PROMOTION. Before it, `outToLaunch`
    // was not in `NON_SHELL_LANE_TYPES` and not in `STRICT_FACES`, so
    // `laneRenderKind` returned 'placeholder': a uniform rackline tile with ZERO
    // ranked controls, and every gesture — Connect, the port picker, Unbind, the
    // two knobs — reachable ONLY by expanding the dock, because the card existed
    // nowhere else.
    await gotoShell(page);
    await spawnPatch(page, [
      { id: NODE, type: 'outToLaunch', position: { x: 240, y: 200 }, domain: 'video' },
    ]);

    const lane = laneShell(page, NODE);
    await expect(lane, 'the lane renders ModuleShell, not OutToLaunchCard').toBeVisible();

    // An `action` cell is not dock-restricted (only `panel` is), which is the
    // whole reason CONNECT is a cell rather than a body control.
    const connect = lane.getByTestId('shell-cell-out-to-launch-connect');
    await expect(connect, 'CONNECT reaches the lane tier').toBeEnabled();

    // ── THE PRESS REACHES THE SEAM, and the ledger is the observable. ──
    // `bindMonitor` writes to `node.data` ZERO times by design (the claim lives
    // in the device layer's node-keyed map), so `readData` is STRUCTURALLY blind
    // to this gesture and a dead button would satisfy any DOM assertion.
    const before = await auditions(page, NODE);
    expect(before.total, 'the audition ledger is exposed to this build').toBeGreaterThanOrEqual(0);
    await connect.click();
    await expect
      .poll(async () => (await auditions(page, NODE)).total, {
        message: 'pressing CONNECT recorded NOTHING in the audition ledger — the cell is inert',
        timeout: 15_000,
      })
      .toBeGreaterThan(before.total);

    // ⚠ AND `delivered` IS NOT ASSERTED TRUE. Whether the press reached Web MIDI
    // depends on the runner: `midiAvailable()` is the branch that decides, and a
    // headless browser without it records `delivered: false` — RECORDED, never
    // dropped, which is exactly the distinction that stops this probe being the
    // "this function was called" tautology. Both legs are driven with an
    // injected seam in `out-to-launch-cell-actions.test.ts`; what this test owns
    // is that the CELL is wired to the function at all.
    expect(await auditions(page, NODE)).toMatchObject({ total: before.total + 1 });
  });

  test('the DOCK BODY paints the 9x9 monitor and prints no derived state text', async ({ page }) => {
    await gotoShell(page);
    await spawnPatch(page, [
      { id: NODE, type: 'outToLaunch', position: { x: 240, y: 200 }, domain: 'video' },
    ]);
    const dock = await openDock(page, NODE);

    await expect(
      dock.getByTestId(`out-to-launch-binder-body-${NODE}`),
      'the fullViewBody extension claimed the dock head',
    ).toBeVisible();
    await expect(dock.getByTestId('outToLaunch-face-canvas'), 'the 9x9 monitor').toBeVisible();

    // The MONITOR lamp carries the card's MONITOR ACTIVE banner and its
    // `Bound to …` line. At rest it is DARK and the sentence is in the
    // accessible name, never painted — the route the resting-text ruling names
    // for a derived sentence.
    const lamp = dock.getByTestId(`out-to-launch-led-monitor-${NODE}`);
    await expect(lamp).toBeVisible();
    await expect(lamp, 'nothing is bound, so the lamp is dark').toHaveAttribute('data-lit', '0');
    await expect(lamp).toHaveAttribute('aria-label', /no launchpad is bound/i);

    // ⚠ THE CARD'S BANNER TEXT MUST NOT BE PAINTED ANYWHERE ON THE PLATE. This
    // is the assertion that would catch someone "restoring" the warning as a
    // visible sentence, which is what the ruling refuses.
    await expect(
      dock.getByText(/MONITOR ACTIVE/i),
      'the card banner must not be painted as resting text',
    ).toHaveCount(0);
    await expect(
      dock.getByText(/Bound to/i),
      'nor the card status line',
    ).toHaveCount(0);

    // The two knobs rank, and their values live in `aria-valuetext` rather than
    // in a printed decimal. ⚠ A FAMILY cell and a PARAM cell are addressed
    // differently — `cellTestId` (`shell-cell-<familyId>`) is only minted for
    // family/static cells, while a param control renders generically as
    // `control-<paramId>` — so both spellings appear here deliberately.
    for (const param of ['bright', 'gamma']) {
      await expect(
        dock.locator(`[data-testid="control-${param}"]`),
        `${param} ranks on the dock faceplate`,
      ).toBeVisible();
    }

    // The whole band, in rank order: CONNECT first, then the two knobs. This is
    // the ladder the face comment reads back as a sentence, asserted rather
    // than described.
    await expect(
      dock.locator('[data-cell-key]'),
      'the dock renders every ranked cell: the CONNECT family plus both knobs',
    ).toHaveCount(3);
  });

  test('BRIGHT and GAMMA track the GRAPH, not just the knob', async ({ page }) => {
    await gotoShell(page);
    await spawnPatch(page, [
      { id: NODE, type: 'outToLaunch', position: { x: 240, y: 200 }, domain: 'video' },
    ]);
    const dock = await openDock(page, NODE);

    const knob = dock.locator('[data-testid="control-bright"]');
    await expect(knob).toBeVisible();
    const atRest = await knob.getAttribute('aria-valuetext');

    // Write through the live Y.Doc, exactly as a collaborator's edit would.
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['otl'];
        if (n) n.params.bright = 0.25;
      });
    });

    await expect
      .poll(async () => knob.getAttribute('aria-valuetext'), {
        message: 'the BRIGHT cell did not follow a graph write — the face is not bound to the param',
        timeout: 15_000,
      })
      .not.toBe(atRest);
  });

  test('the lane tile paints its OWN picture, not the last node that blitted', async ({ page }) => {
    // ⚠ THE REGRESSION PIN FOR A LIVE DEFECT THIS PROMOTION UNCOVERED.
    //
    // `VideoTileThumb` blits a node's texture into the engine's SHARED drawing
    // buffer and then `drawImage`s THAT BUFFER. `blitOutputToDrawingBuffer`
    // returns `void` and does nothing when `handle.surface.texture` is null, so
    // the snapshot could not tell — and `outToLaunch` is the one video def whose
    // surface is `{ fbo: null, texture: null }`, because it is a SINK whose
    // screen is 81 physical LEDs.
    //
    // MEASURED before the fix, in exactly this scene: the two tiles were
    // BYTE-IDENTICAL — mean 710.891875 and max 765 on both — i.e. the monitor
    // tile showed the videoOut picture while nothing at all was patched into it.
    // For a video module the picture IS its identity in a rack (owner, #1785),
    // so "somebody else's frame" is the worst available answer.
    //
    // ⚠ THE videoOut LEG IS A POSITIVE CONTROL AND IS LOAD-BEARING. Asserting
    // only "the monitor tile is dark" would pass just as happily if the thumb
    // loop were dead, the engine never booted, or the source rendered black —
    // every one of which is a different bug that this test would then certify.
    // The control says: in THIS page, at THIS moment, a tile that SHOULD have a
    // picture does.
    await gotoShell(page);
    await spawnPatch(
      page,
      [
        { id: SRC, type: 'shapes', position: { x: 40, y: 200 }, domain: 'video', params: { shape: 2, tile: 0, rotate: 0, zoom: 2.2 } },
        { id: VOUT, type: 'videoOut', position: { x: 300, y: 200 }, domain: 'video' },
        { id: NODE, type: 'outToLaunch', position: { x: 560, y: 200 }, domain: 'video' },
      ],
      [{ id: 'e1', from: { nodeId: SRC, portId: 'out' }, to: { nodeId: VOUT, portId: 'in' }, sourceType: 'mono-video', targetType: 'video' }],
    );

    await expect(page.locator(`[data-thumb-node="${NODE}"]`), 'the monitor tile has a thumb').toHaveCount(1);
    await expect(page.locator(`[data-thumb-node="${VOUT}"]`), 'and so does videoOut').toHaveCount(1);

    // POSITIVE CONTROL FIRST: the instrument can see a picture at all.
    await expect
      .poll(async () => (await thumbStats(page, VOUT))?.max ?? 0, {
        message:
          'the videoOut tile never lit — the ARRANGE failed (no GL frame, a black source, or a ' +
          'dead thumb loop), so the assertion below would pass for the wrong reason',
        timeout: 45_000,
      })
      .toBeGreaterThan(30);

    const monitor = await thumbStats(page, NODE);
    const out = await thumbStats(page, VOUT);
    expect(monitor, 'the monitor tile canvas is readable').not.toBeNull();

    // The subject: a texture-less sink paints its own dark well, NOT the shared
    // buffer. Stated with both numbers, so a failure names what it saw.
    expect(
      monitor!.max,
      `the outToLaunch tile is painting another node's frame out of the shared drawing buffer: ` +
        `monitor=${JSON.stringify(monitor)} videoOut=${JSON.stringify(out)} — with NOTHING patched ` +
        `into outToLaunch's input. Units: summed RGB per pixel, 0..765.`,
    ).toBeLessThanOrEqual(30);
    expect(
      monitor!.mean,
      `and the two tiles must not agree: monitor=${JSON.stringify(monitor)} videoOut=${JSON.stringify(out)}`,
    ).not.toBeCloseTo(out!.mean, 3);
  });
});
