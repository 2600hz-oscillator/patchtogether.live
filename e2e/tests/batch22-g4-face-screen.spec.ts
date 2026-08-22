// e2e/tests/batch22-g4-face-screen.spec.ts
//
// SCREEN ON / OFF on the four batch-22 GROUP 4 video faces — the RENDER half of
// the 2026-08-18 owner ruling ("'screen on / off' on the card like that is a
// thing all video modules should have moving forward").
//
// ⚠ WHY THIS FILE EXISTS, and why it is not redundant with the source gate.
// `video-face-screen-source.test.ts` (#1928) is deny-by-default over every faced
// video module and checks that each one's `fullViewBody` READS `previewCollapsed`,
// WRITES it through the node-data idiom, and exposes a `<button>`. It says so
// itself: *"It reads SOURCE, not a render. It cannot tell you the button is
// visible, clickable, or wired to anything… The RENDER half is e2e's job."*
//
// That render half had exactly TWO owners before this file — `freezeframe-screen-
// toggle.spec.ts` and `foxy-face-surface.spec.ts` — both single-module. Groups 1
// and 2a of this batch added SIX video faces between them and neither added a
// render-level leg, so six new `fullViewBody` surfaces entered the tree with the
// toggle proven only at the source. This PR adds four more. That is the gap.
//
// ⚠ AND IT IS DELIBERATELY NOT A REGISTRY SWEEP. The owner ruling on
// `cv-param-reach` is standing — *never build registry-wide render sweeps; test
// I/O per module, structurally* — so the table below is a FIXED, NAMED list of the
// four modules THIS PR promotes, not `STRICT_FACES` filtered by domain. It cannot
// silently grow to cover a module nobody wrote a line for, and it cannot silently
// shrink either: every entry names a type, and spawning an unknown type fails.
//
// ⚠ WHAT THIS FILE STILL CANNOT SEE, stated inside the gate as the blind-gates
// rule requires:
//   * That the module KEEPS RENDERING while the screen is off. Every subject here
//     is a DOM or LAYOUT fact; none reads a pixel. The "OFF stops the blit, never
//     the engine" claim lives at the SOURCE (each body retains `markWatched` in
//     its collapsed branch) and in the `EXTENSION_BODY_ROLES` argument, because no
//     runtime gate here can observe a watch mark. This is the same honest split
//     `freezeframe-screen-toggle.spec.ts` records after its first draft reached
//     for a `window.__videoEngine.hasNode` hook THAT DOES NOT EXIST and passed
//     green while measuring nothing.
//   * The LEGACY-CARD surface. None of these four cards has ever drawn a preview
//     (grepped: no `canvas`, no `previewCollapsed` in any of the four), so unlike
//     freezeframe there is no card half of the ruling to keep honest here — the
//     switch is an ADDITION the face introduces, not a port.
//
// NO WALL-CLOCK WAITS. Every wait is an auto-retrying `expect` / `expect.poll` on
// the real subject, per CLAUDE.md: state readiness is never a frame count and
// never a timeout. The only wall-clock number is the test BUDGET, from the one
// export site in `boot-budget.ts`, and it BOUNDS the failure rather than gating it.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';
import { waitFrames } from '../_helpers/frames';

/**
 * The four modules this PR promotes, with the testid prefix each body declares.
 *
 * ⚠ THE PREFIX IS NOT DERIVABLE FROM THE TYPE, which is the whole reason it is
 * written down rather than computed: `videoMixer`'s body spells its testids
 * `video-mixer-*` (the def's LABEL is `v-mixer`; its TYPE is `videoMixer` only to
 * avoid clashing with the audio `mixer`). A computed prefix would have silently
 * matched nothing on that one module and passed the other three.
 */
const SUBJECTS = [
  {
    type: 'mapper',
    prefix: 'mapper',
    why: 'the ONE-PARAM face: its picture is the merit argument, so a body that fails to mount takes the whole justification with it',
  },
  {
    type: 'destructor',
    prefix: 'destructor',
    why: 'four degradation amounts whose only description is a look',
  },
  {
    type: 'luma',
    prefix: 'luma',
    why: 'ships a bit-exact IDENTITY, so the frame is the only thing distinguishing graded from untouched',
  },
  {
    type: 'videoMixer',
    prefix: 'video-mixer',
    why: 'the JOIN — and the one whose testid prefix does NOT match its type, which is why prefixes are declared here rather than computed',
  },
] as const;

/**
 * ⚠ FREEZE THE PER-FRAME GL DRAW — the lever `freezeframe-screen-toggle.spec.ts`
 * pulls, for the reason it records. Each of these bodies runs a rAF loop calling
 * `blitOutputForPreview` + `drawPreviewDownscaled` EVERY frame for the life of the
 * test. On CI's two-core runner under SwiftShader that saturates the main thread,
 * and anything resolving on that same thread gets starved past the budget — a
 * wall-clock bump would only buy a slower failure.
 *
 * It costs these tests NOTHING, and that is worth stating rather than assuming:
 * every subject below is a DOM or LAYOUT fact. None reads a pixel.
 */
async function freezeVideoRender(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (globalThis as unknown as { __videoEngineFreezeRender?: boolean })
      .__videoEngineFreezeRender = true;
  });
}

/** Bring the node into the viewport. The lane band sits far down in flow space, so
 *  without this the tile is off-screen and every click times out — and it also ARMS
 *  the video visibility gate that decides whether the node renders at all.
 *  (The `freezeframe-screen-toggle` / `backdraft-preview-toggle` pattern.) */
async function centerOnNode(page: Page, nodeId: string, zoom = 0.9): Promise<void> {
  await page.evaluate(
    ({ nodeId, zoom }) => {
      const w = globalThis as unknown as {
        __flow: {
          getInternalNode: (id: string) => {
            internals?: { positionAbsolute?: { x: number; y: number } };
            position?: { x: number; y: number };
            measured?: { width?: number; height?: number };
          } | undefined;
          setViewport: (vp: { x: number; y: number; zoom: number }, o?: { duration?: number }) => void;
        };
      };
      const n = w.__flow.getInternalNode(nodeId);
      if (!n) return;
      const x = n.internals?.positionAbsolute?.x ?? n.position?.x ?? 0;
      const y = n.internals?.positionAbsolute?.y ?? n.position?.y ?? 0;
      const cx = x + (n.measured?.width ?? 192) / 2;
      const cy = y + (n.measured?.height ?? 180) / 2;
      const pane = document.querySelector('.svelte-flow') as HTMLElement;
      const r = pane.getBoundingClientRect();
      // Upper QUARTER, not the centre: the dock full view opens over the lower
      // half of the pane and would cover a centred tile.
      w.__flow.setViewport({ x: r.width / 2 - cx * zoom, y: r.height / 4 - cy * zoom, zoom }, { duration: 0 });
    },
    { nodeId, zoom },
  );
  await waitFrames(page, 4);
}

/** Spawn one subject on the DEFAULT shell (what actually ships) and open its dock
 *  faceplate. ⚠ NOT `?shell=legacy`: that is precisely the surface promotion does
 *  NOT change, and testing it is the #1934 mistake this file must not repeat. */
async function openFace(page: Page, type: string) {
  await freezeVideoRender(page);
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar'))
    .toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });

  await spawnPatch(
    page,
    [{ id: 'sut', type, position: { x: 400, y: 60 }, domain: 'video', params: {} }],
    [],
  );
  await centerOnNode(page, 'sut');

  const shell = page.locator('.svelte-flow__node[data-id="sut"] [data-testid="module-shell"]');
  await expect(shell, `the ${type} shell tile`)
    .toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
  await shell.getByTestId('shell-open-dock').click();
  await expect(page.getByTestId('dock-full-view'), `the ${type} dock full view`).toBeVisible();
}

/** The persisted flag, read off the LIVE PATCH rather than off the DOM — the DOM is
 *  the thing under test, so reading it back would prove nothing about whether the
 *  state landed anywhere durable. */
async function persistedCollapsed(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __patch?: { nodes?: Record<string, { data?: Record<string, unknown> }> };
    };
    return w.__patch?.nodes?.sut?.data?.previewCollapsed;
  });
}

for (const { type, prefix, why } of SUBJECTS) {
  test.describe(`batch-22 G4 · ${type}: the SCREEN switch on the FACE`, () => {
    // The SwiftShader budget, from the ONE export site rather than a literal — a
    // flat wall-clock number is a different assertion on every runner, and CI's
    // two-core boxes swing >=2x run-to-run on identical code (#1860/#1906). This
    // BOUNDS the failure; it is not what any test here asserts.
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS);

    test(`is REACHABLE, collapses the picture, RECLAIMS its space, and comes back — ${why}`, async ({ page }) => {
      const TOGGLE = `[data-testid="${prefix}-face-screen-toggle"]`;
      const CANVAS = `[data-testid="${prefix}-face-canvas"]`;

      await openFace(page, type);

      const toggle = page.locator(TOGGLE);
      const canvas = page.locator(CANVAS);

      // ⚠ THE LEG NO SOURCE GATE CAN HAVE. Promotion deletes the card from both
      // default surfaces, so if `face.extension` were dropped or its
      // shell-extension stopped resolving there would be NO screen switch anywhere
      // a player can reach — and this module's card never had one to fall back to.
      //
      // NEGATIVE-CONTROLLED BY HAND BEFORE MERGE, and the result is recorded here
      // because the control cannot live in the tree: deleting
      // `mixerVideoDef.face.extension` makes this exact assertion fail with
      // "the SCREEN switch is on videoMixer's faceplate at all — element(s) not
      // found", and takes the persistence test below down with it. So this file
      // goes RED on the regression it claims to cover.
      //
      // ⚠ BOUNDED WITH THE BOOT BUDGET, NOT LEFT ON PLAYWRIGHT'S 5 s DEFAULT, and
      // the reason is mechanical rather than cautious: this is the ONE assertion in
      // the file waiting on a LAZY chunk. `loadShellExtension` is a non-eager
      // `import.meta.glob`, so the body arrives via a dynamic import that has not
      // started until the dock mounts. A flat 5 s is a different assertion on every
      // runner (#1875/#1906) and CI's two-core SwiftShader boxes swing >=2x. This
      // BOUNDS the failure; it is not the gate.
      await expect(toggle, `the SCREEN switch is on ${type}'s faceplate at all`)
        .toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

      // Absent => false => ON, so an existing rack opens unchanged.
      await expect(toggle, 'starts ON').toHaveAttribute('aria-pressed', 'true');
      await expect(toggle).toHaveText('SCREEN ON');
      await expect(canvas, 'the picture is showing').toBeVisible();
      await expect
        .poll(async () => (await canvas.boundingBox())?.height ?? 0, {
          message: `${type}: the preview occupies real vertical space when ON (CSS px)`,
        })
        .toBeGreaterThan(50);

      await toggle.click();

      await expect(toggle, 'now OFF').toHaveAttribute('aria-pressed', 'false');
      await expect(toggle).toHaveText('SCREEN OFF');
      // ⚠ RECLAIMED, NOT MERELY INVISIBLE. `visibility: hidden` would keep the box
      // and buy the player nothing, which is the point of the ruling — and the
      // whole reason these bodies use `{#if !previewCollapsed}` rather than a CSS
      // class. The owner's words: "we do not want useless gray horizontal space on
      // cards, ever."
      await expect(canvas, 'the picture is GONE, not hidden').toHaveCount(0);
      // …and the control that turns it back on did not vanish with the picture.
      await expect(toggle, 'the toggle survives its own OFF state').toBeVisible();

      await toggle.click();
      await expect(canvas, 'the picture returns').toBeVisible();
      await expect(toggle, 'back ON').toHaveAttribute('aria-pressed', 'true');
      await expect
        .poll(async () => (await canvas.boundingBox())?.height ?? 0, {
          message: `${type}: the preview has its space back (CSS px)`,
        })
        .toBeGreaterThan(50);
      // the canvas is the live element for THIS node, not a remounted stray
      await expect(canvas).toHaveAttribute('data-node-id', 'sut');
    });
  });
}

test.describe('batch-22 G4 · videoMixer: the SCREEN state PERSISTS', () => {
  test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS);

  test('it survives closing and reopening the dock — node.data, not component state', async ({ page }) => {
    // The owner's STATED FLOOR ("the on/off state persists through tab switches"),
    // proven once rather than four times: `previewCollapsed` is read and written
    // identically in all four bodies and the source gate checks that in all four,
    // so a second copy of this leg would cost CI time to re-prove one mechanism.
    //
    // videoMixer is the instance because it is the JOIN — the node whose collapsed
    // preview a player is most likely to leave collapsed across a session.
    //
    // ⚠ THIS IS THE LEG A `$state` BOOLEAN WOULD FAIL AND EVERY OTHER ASSERTION IN
    // THIS FILE WOULD PASS. The body unmounts with the dock (the #1531/#1574/#1583
    // card-unmount-kills-node-lifetime-state class), so component-local state is
    // exactly what would look correct until you closed the pane.
    //
    // ONE round trip, not one per tab: the parked backdraft persistence test
    // clicked EVERY tab in a loop, which is n chances to lose one coin flip and is
    // why it recovered-on-retry 21 times (#1847). The invariant is node-keyed, so
    // one close/reopen proves it.
    const TOGGLE = '[data-testid="video-mixer-face-screen-toggle"]';

    await openFace(page, 'videoMixer');
    expect(await persistedCollapsed(page), 'nothing written before the first click').toBeFalsy();

    await page.locator(TOGGLE).click();
    await expect(page.locator(TOGGLE)).toHaveAttribute('aria-pressed', 'false');
    expect(await persistedCollapsed(page), 'OFF is persisted to the patch').toBe(true);

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('dock-full-view')).toHaveCount(0);

    const shell = page.locator('.svelte-flow__node[data-id="sut"] [data-testid="module-shell"]');
    await shell.getByTestId('shell-open-dock').click();
    await expect(page.getByTestId('dock-full-view')).toBeVisible();

    await expect(page.locator(TOGGLE), 'still OFF after a remount')
      .toHaveAttribute('aria-pressed', 'false');
    expect(await persistedCollapsed(page), 'and still persisted').toBe(true);
  });
});
