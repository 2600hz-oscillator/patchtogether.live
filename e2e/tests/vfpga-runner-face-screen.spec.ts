// e2e/tests/vfpga-runner-face-screen.spec.ts
//
// THE RENDER LEGS for the two affordances VFPGA-RUNNER's promotion RECOVERED.
//
// Promotion sets `migrated('vfpgaRunner')` true, and from that moment neither
// surface renders `VfpgaRunnerCard.svelte` — so the card's SCREEN-adjacent
// switches are deleted by the promotion meant to keep them. Both now live in the
// module's `fullViewBody` extension, and `video-face-screen-source.test.ts`
// proves the SOURCE carries a `previewCollapsed` read + write + button. It says
// so in its own header: it "cannot tell you the button is visible, clickable, or
// wired to anything — the RENDER half is e2e's job." This is that half.
//
// ⚠ THIS FILE IS NOT THE DOM OWNER — `face-screen-render.spec.ts` IS, and this
// module has a row in its table (added in the same diff, per that file's stated
// convention). What is here is the half that sweep names as its OWN blind spot,
// in capitals: *"THAT THE MODULE KEEPS RENDERING WHILE THE SCREEN IS OFF. Every
// subject there is a DOM or LAYOUT fact; none reads a pixel."* Both tests below
// read pixels or a bespoke second view, which is why they are not rows there.
//
// ⚠ AND THE **FABRIC** VIEW HAS NO GATE ANYWHERE ELSE. The SCREEN switch is
// fleet-standard, source-gated and swept; the floorplan is bespoke to this
// module and the only route to a `.vfpga` as a CIRCUIT rather than as a name in
// a picker. Nothing but this file can see whether promotion kept it.
//
// ⚠ NO WALL-CLOCK WAITS. Every readiness gate here is either an auto-retrying
// `expect` on the real subject or a frame count via the one export site
// (`waitFrames`), because a ms budget is a different number of frames on every
// renderer — 7.9 fps under SwiftShader against ~60 on a GPU. The one wall-clock
// number is the test CAP, taken from the shared boot budget, which BOUNDS the
// failure rather than gating it.

import { test, expect, type Page } from '@playwright/test';
import { SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';
import { waitFrames } from '../_helpers/frames';
import { spawnPatch } from './_helpers';

const NODES = [
  { id: 'vf', type: 'vfpgaRunner', position: { x: 120, y: 80 }, domain: 'video' as const },
];

/** How many frames to give the rAF preview loop to blit a picture. Generous
 *  against SwiftShader and free on a GPU — it is a COUNT, not a clock. */
const PAINT_FRAMES = 30;

async function openDock(page: Page) {
  const shell = page.locator('.svelte-flow__node[data-id="vf"] [data-testid="module-shell"]');
  await expect(shell, 'the promoted face renders a ModuleShell tile in the lane')
    .toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
  await shell.getByTestId('shell-open-dock').click();
  const faceplate = page.getByTestId('dock-full-view');
  await expect(faceplate).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
  const dockShell = faceplate.locator('[data-testid="module-shell"][data-shell-tier="dock"]');
  await expect(dockShell).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
  return dockShell;
}

/** Is the face preview canvas painting anything but black? Sampled IN THE PAGE
 *  in ONE evaluate — never a Playwright poll loop, which would be one round-trip
 *  per sample on the same main thread as the subject and cannot tell "black"
 *  from "never looked" (CLAUDE.md, VALIDATE THE INSTRUMENT). */
async function previewIsLit(page: Page): Promise<{ lit: boolean; sampled: number }> {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLCanvasElement>('[data-testid="vfpga-face-canvas"]');
    if (!el) return { lit: false, sampled: 0 };
    const ctx = el.getContext('2d');
    if (!ctx) return { lit: false, sampled: 0 };
    let lit = 0;
    let sampled = 0;
    for (let i = 1; i < 6; i++) {
      for (let j = 1; j < 6; j++) {
        const d = ctx.getImageData(
          Math.floor((el.width * i) / 6),
          Math.floor((el.height * j) / 6),
          1,
          1,
        ).data;
        sampled++;
        if (d[0]! + d[1]! + d[2]! > 24) lit++;
      }
    }
    // The default bitstream is smpte-bars: most of the frame is saturated
    // colour, so a handful of lit samples is a very low bar to clear and a
    // black/absent picture cannot fake it.
    return { lit: lit > 4, sampled };
  });
}

function previewCollapsed(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> } | undefined> };
    };
    return w.__patch.nodes['vf']?.data?.previewCollapsed ?? null;
  });
}

test.describe('VFPGA-RUNNER face — the switches promotion recovered', () => {
  // A wall-clock CAP taken from the ONE export site rather than typed, so it
  // moves with the fleet. It bounds the failure; the gates above are the
  // assertions.
  test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS);

  test('SCREEN: OFF reclaims the picture, ON brings back a LIVE one', async ({ page }) => {
    await page.goto('/rack?shell=1&seed=none');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, NODES, []);

    const dockShell = await openDock(page);
    const body = dockShell.getByTestId('vfpga-runner-output-body');
    await expect(body, 'the fullViewBody paints at the dock').toBeVisible();

    const toggle = body.getByTestId('vfpga-face-screen-toggle');
    await expect(toggle, 'SCREEN starts ON').toHaveAttribute('aria-pressed', 'true');
    await expect(body.getByTestId('vfpga-face-canvas')).toBeVisible();

    await waitFrames(page, PAINT_FRAMES);
    const before = await previewIsLit(page);
    expect(before.lit, `the preview blits the loaded bitstream (sampled ${before.sampled} points)`)
      .toBe(true);

    // ── OFF: the canvas goes away and the STATE lands on the node ──────────
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(
      body.getByTestId('vfpga-face-canvas'),
      'SCREEN OFF removes the picture rather than hiding it — the space is reclaimed',
    ).toHaveCount(0);
    // ⚠ ON THE NODE, not in component state. A `$state` here would die with the
    // component, and this body unmounts on dock collapse / LRU eviction (the
    // #1531/#1574/#1583 class). `node.data` is also what makes the owner's
    // stated floor — persistence through tab switches — true.
    await expect.poll(() => previewCollapsed(page), {
      message: 'SCREEN OFF writes node.data.previewCollapsed',
    }).toBe(true);

    // ── ON again: a LIVE picture, not a stale frame ───────────────────────
    // ⚠ THIS IS THE #1720/#1721 LEG. If SCREEN OFF had torn the producer down —
    // or merely stopped marking the node watched, so it dropped out of the pull
    // set after WATCH_TTL_MS — coming back would show black while it spun up.
    // The body marks watched in the collapsed branch precisely so it does not.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(body.getByTestId('vfpga-face-canvas')).toBeVisible();
    await waitFrames(page, PAINT_FRAMES);
    const after = await previewIsLit(page);
    expect(
      after.lit,
      'SCREEN back ON must show the LIVE picture — a black canvas here means the toggle killed '
        + 'the producer instead of just the copy',
    ).toBe(true);
    await expect.poll(() => previewCollapsed(page)).toBe(false);
  });

  test('FABRIC: the floorplan swaps in for the picture, and back', async ({ page }) => {
    await page.goto('/rack?shell=1&seed=none');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, NODES, []);

    const dockShell = await openDock(page);
    const body = dockShell.getByTestId('vfpga-runner-output-body');
    await expect(body).toBeVisible();

    const fabric = body.getByTestId('vfpga-face-fabric-toggle');
    await expect(fabric, 'FABRIC starts off').toHaveAttribute('aria-pressed', 'false');
    await expect(body.getByTestId('vfpga-face-fabric')).toHaveCount(0);

    await fabric.click();
    await expect(fabric).toHaveAttribute('aria-pressed', 'true');
    await expect(
      body.getByTestId('vfpga-face-fabric'),
      'the read-only floorplan is the ONLY surface on which a .vfpga is legible as a circuit — '
        + 'promotion deleted the card that used to own this button',
    ).toBeVisible();
    // The two views SWAP: there is never a third region and never both at once.
    await expect(body.getByTestId('vfpga-face-canvas')).toHaveCount(0);

    await fabric.click();
    await expect(fabric).toHaveAttribute('aria-pressed', 'false');
    await expect(body.getByTestId('vfpga-face-canvas')).toBeVisible();
    await expect(body.getByTestId('vfpga-face-fabric')).toHaveCount(0);
  });
});
