// e2e/tests/face-toybox.spec.ts
//
// TOYBOX's v2 face, driven in a real browser — the half no source gate can see.
//
// ⚠ THE FILENAME IS `face-<module>`, NOT `<module>-face`, AND THAT IS LOAD-
// BEARING. `e2e/webgl-heavy-globs.ts` carries `**/toybox-*.spec.ts`, and every
// spec that list matches is EXCLUDED from the sharded PR matrix and run by
// nothing — the lane that used to run them was deleted in 2026-06 (#839). A
// spec named `toybox-face.spec.ts` would therefore be green forever without
// executing once. Checked against that list before writing, not assumed.
//
// ⚠ WHY THIS FILE EXISTS ALONGSIDE THE TWENTY `?shell=legacy` TOYBOX SPECS.
// Every one of those boots the LEGACY card, which is exactly the surface
// promotion does not change — so all twenty stay green and all twenty stop
// saying anything about what a player now meets. This spec boots the DEFAULT
// shell, where `ToyboxCard.svelte` is mounted NOWHERE (toybox is in none of
// DOM_SOURCE_LANE_TYPES / CARD_PRODUCER_LANE_TYPES / HEADLESS_MOUNT_LANE_TYPES,
// so there is no `<HeadlessSourceHost>` either), and asserts the console is
// reachable, that it still drives the engine, and that the SCREEN switch
// changes what is painted and not what is produced.
//
// ⚠ THE pageerror GUARD IS NOT CEREMONY. A TypeError inside a `$derived` does
// not surface as a failed assertion — it takes the subtree's render down and
// the symptom lands somewhere else entirely. This console is one component with
// two mounts, so a face-only reactivity bug (the `nodeSnapshot` vs
// `nodeVersion` split) would show up here first and nowhere else.

import { test, expect, type Page, type Locator } from '@playwright/test';
import { spawnPatch, canvasPane, MAIN_CANVAS } from './_helpers';
import { BOOT_MS, SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';

const NODE = 'ftb';

/** Frames the engine must advance for a "the picture is live" claim. Small
 *  enough for a contended SwiftShader shard, large enough that a single stray
 *  frame cannot satisfy it. */
const MIN_FRAMES = 3;
/** Observation window CAP — the failure bound, never the gate. The gate is
 *  accumulated forward progress, measured in-page across real frames. */
const OBSERVE_MS = 3_000;

const laneNode = (nodeId: string) => `${MAIN_CANVAS} .svelte-flow__node[data-id="${nodeId}"]`;

async function boot(page: Page): Promise<void> {
  // Plain /rack — the DEFAULT shell. The twenty `?shell=legacy` toybox specs
  // cover the surface this promotion leaves alone.
  await page.goto('/rack?seed=none');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: BOOT_MS });
  await canvasPane(page).waitFor({ state: 'visible' });
}

/** Open this node's dock faceplate (the auto-retrying tv-librarian pattern —
 *  the tile button is hit-testable while a previous pane is still tearing down,
 *  so one click can land on nothing). */
async function openDock(page: Page, nodeId: string): Promise<Locator> {
  const shell = page.locator(`${laneNode(nodeId)} [data-testid="module-shell"]`);
  await expect(shell).toBeVisible({ timeout: BOOT_MS });
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

/**
 * Frames the VIDEO ENGINE has drawn for this node.
 *
 * ⚠ THE ENGINE, NOT A CANVAS, and the distinction is the whole point of the
 * SCREEN leg below. A canvas sample cannot tell "the module stopped rendering"
 * from "the module is still rendering and nobody is painting a copy" — which
 * are the two possible meanings of SCREEN OFF and the only thing worth
 * measuring about it.
 */
async function framesDrawn(page: Page, nodeId: string): Promise<number> {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => { getDomain: (d: string) => { framesDrawnFor: (i: string) => number } };
    };
    try {
      return w.__engine?.().getDomain('video').framesDrawnFor(id) ?? -1;
    } catch {
      return -1;
    }
  }, nodeId);
}

/** Accumulate FORWARD engine progress over `ms`, sampled IN-PAGE across real
 *  animation frames. A running accumulator rather than a start/end delta, so a
 *  loop the page never scheduled is distinguishable from an engine that
 *  genuinely did not advance. */
async function measureFrames(page: Page, nodeId: string, ms: number) {
  return await page.evaluate(
    async ({ id, windowMs }) => {
      const w = globalThis as unknown as {
        __engine?: () => { getDomain: (d: string) => { framesDrawnFor: (i: string) => number } };
      };
      const readNow = (): number => {
        try {
          return w.__engine?.().getDomain('video').framesDrawnFor(id) ?? -1;
        } catch {
          return -1;
        }
      };
      const startMs = performance.now();
      let last = readNow();
      let advanced = 0;
      let samples = 0;
      await new Promise<void>((resolve) => {
        const tick = () => {
          const now = readNow();
          if (now > last) advanced += now - last;
          last = now;
          samples += 1;
          if (performance.now() - startMs >= windowMs) {
            resolve();
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      return { advanced, samples, elapsedMs: performance.now() - startMs, last };
    },
    { id: nodeId, windowMs: ms },
  );
}

/** This node's combine graph, read off the live patch. */
async function combineNodeCount(page: Page, nodeId: string): Promise<number> {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __patch?: { nodes: Record<string, { data?: { combine?: { nodes?: unknown[] } } }> };
    };
    return w.__patch?.nodes?.[id]?.data?.combine?.nodes?.length ?? -1;
  }, nodeId);
}

test.describe('TOYBOX face — the console survives the promotion that deletes its card', () => {
  test.beforeEach(({ page }) => {
    page.on('pageerror', (err) => {
      throw new Error(`uncaught page error during a toybox face test: ${err.message}`);
    });
  });

  test('the CARD is mounted NOWHERE and the console is reachable anyway @video', async ({ page }) => {
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 2);
    await boot(page);
    await spawnPatch(page, [{ id: NODE, type: 'toybox', domain: 'video' }], [], {
      mountTimeout: BOOT_MS,
    });

    const dock = await openDock(page, NODE);
    const body = dock.getByTestId('toybox-face-body');
    await expect(body).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

    // ⚠ THE LEG THAT MAKES THE REST MEAN SOMETHING. toybox is in none of the
    // card-keeping sets, so promotion leaves NO mount of the legacy card
    // anywhere in the document — not in the lane, not in the dock rail, and not
    // off-screen in a headless host. If this ever counts 1, the module is being
    // rescued by a card and none of the assertions below are about the face.
    await expect(page.locator('[data-testid="toybox-card"]')).toHaveCount(0);

    // The console's own zones, each addressed by the testid the card used, so a
    // silent rename is a failure rather than a green skip.
    await expect(body.getByTestId('toybox-face-canvas')).toBeVisible();
    await expect(body.getByTestId('toybox-face-layer-band')).toBeVisible();
    await expect(body.getByTestId('toybox-layer-tabs')).toBeVisible();
    await expect(body.getByTestId('toybox-kind-select')).toBeVisible();

    // ⚠ AND NO `control-*` TESTID ANYWHERE ON THE PLATE. `toyboxDef.params` is
    // `[]`, and faces-parity asserts exact multiset equality against it — this
    // is the same identity, checked here too because a regression to Knob's
    // default testid would otherwise surface as twenty confusing "unbacked
    // extra control" lines in a registry-wide sweep.
    await expect(dock.locator('[data-testid^="control-"]')).toHaveCount(0);
    // The knobs are still THERE, and still MIDI-assignable — the override
    // changed the name, not the binding.
    await expect(dock.locator('[data-testid^="toybox-dial-"]').first()).toBeVisible();
  });

  test('the three tabs reach the three sections, and cv-mod is where it opens @video', async ({ page }) => {
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 2);
    await boot(page);
    await spawnPatch(page, [{ id: NODE, type: 'toybox', domain: 'video' }], [], {
      mountTimeout: BOOT_MS,
    });
    const dock = await openDock(page, NODE);
    const body = dock.getByTestId('toybox-face-body');
    await expect(body).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

    // Opens on CV-MOD — the performance tab.
    await expect(body.getByTestId('toybox-face-tab-cv')).toHaveAttribute('aria-selected', 'true');
    await expect(body.getByTestId('toybox-cv-rows')).toBeVisible();
    // All SIX rows. A screenshot showing four is a crop; the source loops
    // CV_PORT_IDS, and this is the leg that says so.
    for (const cv of ['cv1', 'cv2', 'cv3', 'cv4', 'cv5', 'cv6']) {
      await expect(body.getByTestId(`toybox-cv-row-${cv}`)).toBeVisible();
    }

    // COMBINE GRAPH — the editor whole, not a summary of it.
    await body.getByTestId('toybox-face-tab-combine').click();
    await expect(body.getByTestId('toybox-graph-svg')).toBeVisible();
    await expect(body.getByTestId('toybox-add-row')).toBeVisible();
    // The full 17-kind ADD roster, spot-checked at both ends so a truncated
    // loop is visible.
    await expect(body.getByTestId('toybox-add-fade')).toBeVisible();
    await expect(body.getByTestId('toybox-add-datamosh')).toBeVisible();
    await expect(body.getByTestId('toybox-cv-rows')).toHaveCount(0);

    // PRESETS — including the typed-entry field, which is the affordance the
    // migration inventory's typed-entry leg is about.
    await body.getByTestId('toybox-face-tab-presets').click();
    await expect(body.getByTestId('toybox-preset-select')).toBeVisible();
    await expect(body.getByTestId('toybox-randomize')).toBeVisible();
    await body.getByTestId('toybox-preset-save').click();
    await expect(body.getByTestId('toybox-preset-name-input')).toBeVisible();
    await body.getByTestId('toybox-preset-save-cancel').click();

    // The LAYER band is persistent across all three — every tab references
    // layers and none owns them, so it must never be the thing that went away.
    await expect(body.getByTestId('toybox-face-layer-band')).toBeVisible();
  });

  test('the face DRIVES the module — an op node added here reaches the graph and the engine @video', async ({ page }) => {
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 2);
    await boot(page);
    await spawnPatch(page, [{ id: NODE, type: 'toybox', domain: 'video' }], [], {
      mountTimeout: BOOT_MS,
    });
    const dock = await openDock(page, NODE);
    const body = dock.getByTestId('toybox-face-body');
    await expect(body).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

    // The output is LIVE before anything is touched — the module renders from
    // node.data with no gesture, which is what makes the next assertion a
    // statement about the EDIT rather than about the mount.
    const before = await measureFrames(page, NODE, OBSERVE_MS);
    expect(before.samples, 'the in-page accumulator actually ran').toBeGreaterThan(5);
    expect(
      before.advanced,
      `the engine drew ${before.advanced} frames for ${NODE} over ${before.samples} samples / `
        + `${Math.round(before.elapsedMs)} ms — the face is mounted but the node is not being pulled`,
    ).toBeGreaterThanOrEqual(MIN_FRAMES);

    // ⚠ TEST THE EFFECT, NOT THAT A BUTTON EXISTS. The combine graph is the
    // deepest thing on this surface and the one a summary-shaped migration
    // would have flattened; adding an op through the FACE must reach the same
    // Y.Doc the card writes.
    const nodesBefore = await combineNodeCount(page, NODE);
    expect(nodesBefore, 'the default combine graph did not resolve').toBeGreaterThan(0);

    await body.getByTestId('toybox-face-tab-combine').click();
    await expect(body.getByTestId('toybox-graph-svg')).toBeVisible();
    await body.getByTestId('toybox-add-lumakey').click();

    await expect
      .poll(() => combineNodeCount(page, NODE), {
        timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
        message: 'ADD LUMAKEY on the faceplate never reached node.data.combine',
      })
      .toBe(nodesBefore + 1);

    // …and the new node is on the surface, under the unique display name the
    // graph derives — the editor is really an editor.
    await expect(body.locator('[data-testid^="toybox-gnode-"]')).toHaveCount(nodesBefore + 1);
  });

  test('SCREEN OFF reclaims the space and is NOT a pause @video', async ({ page }) => {
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 2);
    await boot(page);
    await spawnPatch(page, [{ id: NODE, type: 'toybox', domain: 'video' }], [], {
      mountTimeout: BOOT_MS,
    });
    const dock = await openDock(page, NODE);
    const body = dock.getByTestId('toybox-face-body');
    await expect(body).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

    const toggle = body.getByTestId('toybox-face-screen-toggle');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(body.getByTestId('toybox-face-canvas')).toBeVisible();

    // Turn it OFF. The picture is REMOVED — not hidden — so the space is
    // reclaimed, which is the whole point of the switch.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(body.getByTestId('toybox-face-canvas')).toHaveCount(0);

    // ⚠ AND THE ENGINE KEEPS GOING. This is the leg the whole switch design
    // rests on: `blitOutputForPreview` renews the watch mark as a SIDE EFFECT
    // of painting, so a face that merely stopped blitting would let the mark
    // lapse and `computePullActiveSet` would drop the node — freezing the
    // FEEDBACK / FRAMEDELAY / EXQUISITE / DATAMOSH history and idling every
    // module downstream of `out`. `renewWatchMark` is what stops that, and this
    // measures the engine rather than a canvas precisely because a canvas
    // cannot tell "stopped rendering" from "nobody is painting a copy".
    const off = await measureFrames(page, NODE, OBSERVE_MS);
    expect(off.samples, 'the in-page accumulator actually ran').toBeGreaterThan(5);
    expect(
      off.advanced,
      `SCREEN OFF stopped the engine: ${off.advanced} frames over ${off.samples} samples / `
        + `${Math.round(off.elapsedMs)} ms. The watch mark lapsed — see renewWatchMark in `
        + 'ToyboxConsole.svelte.',
    ).toBeGreaterThanOrEqual(MIN_FRAMES);

    // The console below is fully operable with the screen off — building a
    // patch blind on a projector is the normal show posture.
    await expect(body.getByTestId('toybox-face-layer-band')).toBeVisible();
    await body.getByTestId('toybox-face-tab-combine').click();
    await expect(body.getByTestId('toybox-graph-svg')).toBeVisible();

    // And it comes back.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(body.getByTestId('toybox-face-canvas')).toBeVisible();

    // The state is on the NODE, so it survives a remount rather than dying with
    // the component (#1531 / #1574 / #1583).
    await toggle.click();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('dock-full-view')).toHaveCount(0);
    const reopened = await openDock(page, NODE);
    await expect(reopened.getByTestId('toybox-face-screen-toggle')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(await framesDrawn(page, NODE)).toBeGreaterThan(0);
  });
});
