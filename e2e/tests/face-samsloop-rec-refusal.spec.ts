// A REFUSED REC PRESS MUST BE VISIBLE ON THE FACEPLATE.
//
// ⚠ THE FILENAME IS DELIBERATE. Checked against the live `e2e/webgl-heavy-globs.ts`
// list: neither `face-*` nor `samsloop*` appears there, so this runs in the
// ordinary sharded e2e lane. A spec swept into the heavy lane runs in NO job on
// a pull request and is green forever.
//
// ── WHAT THIS EXISTS TO CATCH, AND WHY NOTHING ELSE COULD ──────────────────
//
// `startSamsloopTake` REFUSES to arm rather than recording something wrong:
// when the audio engine is not up, and when the rack's shared 12 MB sample
// budget has no room for the shortest legal take (re-read FRESH at press time,
// because a peer's sample can land between the last render and the click). The
// legacy card printed that sentence in `samsloop-rec-error`.
//
// The faceplate had nowhere to put it. `SHELL_CELLS.samsloop['samsloop-rec-{n}']`
// is an `action` cell, which renders a `<Button>` and nothing else — only the
// `file` cell has a `{status,error}` caption — so `toggleSamsloopRecord`
// recorded `delivered: false` in the audition ledger and the player saw the
// button move and NOTHING happen.
//
// ⚠ EVERY CELL GATE WAS GREEN THROUGHOUT, and that is the point.
// `shell-cells.test.ts` holds the probe, `faces-parity` drives the cell, and a
// refusal IS a recorded audition — so the whole cell apparatus is satisfied by
// exactly the press this file calls broken. `delivered` is a TEST INSTRUMENT.
// It is not a surface, and nothing that reads it can tell a refusal a player
// saw from one they did not.
//
// ⚠ WHY THE ENGINE-NOT-READY PATH AND NOT RACK-FULL. Both reach the same line.
// Rack-full is the more interesting refusal and it is also the expensive one to
// stage honestly: `samsloopRackLedger` counts base64 STRING LENGTH across the
// rack's other samsloops, so entering that state means putting ~12 MB of string
// through the Y.Doc in a shared lane. Engine-not-ready is the same seam, the
// same painted element and the same clearing rule, for one cold boot.
//
// ⚠ SO THIS SPEC ASSERTS ITS OWN PRECONDITION rather than assuming it. If the
// app ever boots an engine without `__ensureEngine`, the arrange step below
// goes RED and names the problem — instead of arming a real take and passing
// while asserting nothing.

import { test, expect, type Locator, type Page } from '@playwright/test';
import { BOOT_MS, SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';
import { readSample, samsloopIsRecording } from './_samsloop-helpers';

const SL = 'f-sl-refuse';

test.describe.configure({ mode: 'parallel' });

/** The shipping shell — this file's whole subject. */
async function gotoShell(page: Page): Promise<void> {
  await page.goto('/rack?seed=none');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: BOOT_MS });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

/**
 * Put one samsloop on the canvas WITHOUT booting the engine.
 *
 * ⚠ DELIBERATELY NOT `spawnPatch`. That helper's first act is
 * `await __ensureEngine()`, which is precisely the state this spec needs to
 * stay out of. The node shape is the one `spawnPatch` writes, minus the engine
 * bootstrap; readiness is the tile's own mount, which is observable state
 * rather than a delay.
 */
async function spawnWithoutEngine(page: Page, nodeId: string): Promise<void> {
  await page.waitForFunction(() => {
    const w = globalThis as unknown as { __ydoc?: unknown };
    return !!w.__ydoc;
  }, undefined, { timeout: BOOT_MS });
  await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, unknown>; edges: Record<string, unknown> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      for (const e of Object.keys(w.__patch.edges)) delete w.__patch.edges[e];
      for (const n of Object.keys(w.__patch.nodes)) delete w.__patch.nodes[n];
      w.__patch.nodes[id] = {
        id,
        type: 'samsloop',
        domain: 'audio',
        position: { x: 160, y: 140 },
        params: {},
      };
    });
  }, nodeId);
  await expect(
    page.locator(`.svelte-flow__node[data-id="${nodeId}"] [data-testid="module-shell"]`),
  ).toBeVisible({ timeout: BOOT_MS });
}

async function openDock(page: Page, nodeId: string): Promise<Locator> {
  const shell = page.locator(`.svelte-flow__node[data-id="${nodeId}"] [data-testid="module-shell"]`);
  const dockShell = page
    .getByTestId('dock-full-view')
    .locator(`[data-testid="module-shell"][data-shell-tier="dock"][data-shell-node="${nodeId}"]`);
  await expect(async () => {
    if ((await dockShell.count()) === 0) {
      await shell.getByTestId('shell-open-dock').click();
    }
    await expect(dockShell).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
  return dockShell;
}

/** Is a PatchEngine registered right now? The precondition, read rather than
 *  assumed — `_samsloop-helpers.ts` uses the same global. */
async function engineIsUp(page: Page): Promise<boolean> {
  return await page.evaluate(() => {
    const w = globalThis as unknown as { __engine?: () => unknown };
    return !!w.__engine?.();
  });
}

test.describe('SAMSLOOP faceplate — a refused REC press', () => {
  test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 2);

  test('a missing panel chunk reports recovery and a fresh page restores the saved rack', async ({ page }, testInfo) => {
    const errors: string[] = [];
    const blocked = new Set<string>();
    let blockPanel = true;
    page.on('pageerror', (error) => errors.push(error.message));
    // Match the module-owned surface in either dev source or a hashed preview
    // chunk. Never pin yesterday's hash: changing builds is the failure case.
    await page.route('**/*', async (route) => {
      if (route.request().resourceType() !== 'script') return route.continue();
      const response = await route.fetch();
      const body = await response.text();
      if (blockPanel && body.includes('samsloop-output-body')) {
        blocked.add(route.request().url());
        return route.fulfill({ status: 404, contentType: 'text/html', body: '<h1>Not found</h1>' });
      }
      await route.fulfill({ response });
    });
    await gotoShell(page);
    await spawnWithoutEngine(page, SL);
    const dock = await openDock(page, SL);
    const failure = dock.getByTestId('shell-extension-error');
    await expect(failure).toBeVisible();
    expect(blocked.size, 'the negative control actually blocked the surface download').toBe(1);
    await expect(dock.getByTestId('samsloop-output-body')).toHaveCount(0);
    await expect(failure).toContainText('Save your patch');
    await failure.getByRole('button', { name: 'RETRY PANEL' }).click();
    await expect(failure, 'a persistent missing chunk remains actionable').toBeVisible();
    expect(errors, 'the import rejection must be handled').toEqual([]);
    await testInfo.attach('panel-download-failure', { body: await dock.screenshot(), contentType: 'image/png' });

    // Follow the recovery's SAVE instruction through the same envelope seam
    // as File → Save. This isolated fixture does not auto-persist a rack.
    const envelope = await page.evaluate(() => {
      const w = globalThis as unknown as { __persistence: { save: () => unknown } };
      return w.__persistence.save();
    });
    expect(envelope).toBeTruthy();
    blockPanel = false;
    await page.reload();
    await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: BOOT_MS });
    await page.waitForFunction(() => !!(globalThis as unknown as {
      __persistence?: { load?: unknown };
    }).__persistence?.load);
    await page.evaluate((saved) => {
      const w = globalThis as unknown as { __persistence: { load: (saved: unknown) => unknown } };
      w.__persistence.load(saved);
    }, envelope);
    // Do not respawn: restore the saved rack, not a replacement test node.
    const recovered = await openDock(page, SL);
    await expect(recovered.getByTestId('samsloop-output-body')).toBeVisible();
    await expect(recovered.getByTestId('samsloop-face-canvas')).toBeVisible();
    await expect(recovered.getByTestId('shell-extension-error')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('paints the module\'s refusal, and the next armed press retires it', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    await gotoShell(page);
    await spawnWithoutEngine(page, SL);

    // THE PRECONDITION, ASSERTED. Without this the whole test could arm a real
    // take and pass while proving nothing about a refusal.
    expect(
      await engineIsUp(page),
      'this spec drives the engine-not-ready refusal, so no engine may be registered yet — '
        + 'if the app now boots one on its own, drive a different refusal path rather than '
        + 'letting this pass vacuously',
    ).toBe(false);

    const dock = await openDock(page, SL);

    // ⚠ THE REC CELL IS ON THE DOCK FACEPLATE AND NOWHERE ELSE. `face.order`
    // ranks it eighth against a six-cell lane plate, which is what makes ONE
    // dock surface a complete home for the refusal rather than a partial one.
    // `samsloop-face-model.test.ts` pins that inequality through the real
    // selector; this leg only relies on it.
    //
    // ⚠ WHETHER REC NEEDS A TAB CLICK IS A PRODUCT DECISION, NOT A CONSTANT.
    // The face declares two pages (play / sample) and REC is on SAMPLE, but the
    // rail only becomes REAL per-section tabs when `dockTabPlan` says the bands
    // cannot fit one column — below that threshold both bands render and scroll
    // under a single MODULE chip. Measured today: samsloop is below it, so there
    // is no `sample` tab to click. Clicking it WHEN IT EXISTS keeps this spec
    // correct on either side of the threshold, and the unconditional
    // `toBeVisible` below is what actually holds the line — a rail change that
    // buried REC reds here rather than being absorbed.
    const sampleTab = page.getByTestId('faceplate-tab-sample');
    if ((await sampleTab.count()) > 0) await sampleTab.click();

    // Located by `data-cell-key`, the face-order key itself, rather than by the
    // derived testid: the key is the thing the def declares, so a rename of the
    // testid scheme cannot silently point this at nothing.
    const rec = dock.locator('[data-cell-key="samsloop-rec-{n}"] button');
    await expect(rec, 'the REC transport is reachable on the faceplate').toBeVisible();

    // ABSENT AT REST — so the assertion below cannot pass on a line that is
    // always painted, and so no VRT dock baseline moves.
    const refusal = dock.getByTestId('samsloop-face-rec-error');
    await expect(refusal, 'nothing is painted before a press').toHaveCount(0);

    await rec.click();

    await expect(refusal, 'a refused press says WHY, on the surface it was pressed from')
      .toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
    // The module's own sentence, not a generic one. Matched loosely on the two
    // load-bearing words rather than the whole string, so a wording edit in
    // `samsloop-face-actions.ts` does not red a spec that is about the SURFACE.
    await expect(refusal).toContainText(/engine/i);
    await expect(refusal).toContainText(/audio/i);

    // ⚠ AND IT IS REACHABLE, not merely rendered — the same geometry class the
    // recovery prompts pin. A refusal clipped away by an ancestor reports as
    // visible and tells the player nothing.
    const box = await refusal.boundingBox();
    expect(box, 'the refusal has a box').not.toBeNull();
    const hit = await page.evaluate(
      ({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        return !!el?.closest('[data-testid="samsloop-face-rec-error"]');
      },
      { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 },
    );
    expect(hit, 'the refusal is not the topmost element at its own centre — it is clipped or covered')
      .toBe(true);

    // ── THE CLEARING HALF ────────────────────────────────────────────────
    //
    // A refusal that only ever gets SET is one that keeps complaining about a
    // take that is now running. Boot the engine and press again: the take arms
    // and the sentence retires.
    await page.evaluate(async () => {
      const w = globalThis as unknown as { __ensureEngine: () => Promise<unknown> };
      await w.__ensureEngine();
    });
    expect(await engineIsUp(page), 'the engine is up for the second press').toBe(true);

    await rec.click();
    await expect(refusal).toContainText('Connect audio');
    expect(await samsloopIsRecording(page, SL)).toBe(false);
    expect(await readSample(page, SL)).toBeNull();

    // Connect a real source without replacing the sampler or remounting its
    // refusal. The right input alone is valid too; silence is not a refusal.
    await page.evaluate((id) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, unknown>; edges: Record<string, unknown> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        w.__patch.nodes['rec-noise'] = {
          id: 'rec-noise', type: 'noise', domain: 'audio',
          position: { x: 400, y: 140 }, params: {},
        };
        w.__patch.edges['rec-input'] = {
          id: 'rec-input',
          source: { nodeId: 'rec-noise', portId: 'white' },
          target: { nodeId: id, portId: 'audio_r_in' },
          sourceType: 'audio', targetType: 'audio',
        };
      });
    }, SL);
    await rec.click();
    await expect(refusal, 'a press that ARMS retires the refusal').toHaveCount(0, {
      timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
    });

    await expect.poll(async () => page.evaluate((id) => {
      const w = globalThis as unknown as {
        __samsloopRecording: (id: string) => { frames: number };
      };
      return w.__samsloopRecording(id).frames;
    }, SL), { message: 'a connected input actually captures frames' }).toBeGreaterThan(0);

    await rec.click();
    expect(await readSample(page, SL)).not.toBeNull();

    expect(errors).toEqual([]);
  });
});
