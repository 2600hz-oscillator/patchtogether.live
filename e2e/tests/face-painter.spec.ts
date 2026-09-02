// e2e/tests/face-painter.spec.ts
//
// THE PAINTER FACE, driven for real on the DEFAULT shell — the seams no other
// gate can see.
//
// ⚠ THE FILENAME IS DELIBERATE — NOT `painter-face.spec.ts`. A spec's FILENAME
// decides its CI lane: `e2e/webgl-heavy-globs.ts` is glob-matched, and a spec
// that lands in the heavy list runs in NO pull-request job at all (the
// `e2e-video` lane that ran them was deleted in #839), which is green forever.
// Verified against the LIVE list rather than the neighbouring prose: nothing
// there matches `painter*` or `face-*`, so this runs on the sharded `e2e`
// matrix. `face-` is also the shape `face-videobox` / `face-peertube`
// established, and it cannot be swept in by a future glob named after the
// module.
//
// ⚠ `painter.spec.ts` BOOTS `?shell=legacy` (the `rack` fixture), so all three
// of its tests stay green after the promotion while covering a surface no
// player meets any more. This file is the default-shell leg they owe.
//
// `painter-face-model.test.ts` pins the ranking, the empty face, the glyph, the
// `$effect`-keyed setup and the lease handshake at the SOURCE.
// `painter/paint-surface.test.ts` pins the gesture arithmetic both surfaces
// share. `face-rack-status-source.test.ts` proves the body declares what it
// paints, and the shared `face-screen-render-*` suite drives the SCREEN switch
// generically (reachable / collapses / reclaims space / comes back). None of
// them can see:
//
//  1. ⚠ THAT THE MODULE CAN BE DRAWN ON AT ALL UNDER THE SHELL. painter
//     declares `params: []`, so the faceplate has ZERO control cells: if the
//     body fails to mount there is nothing else on the plate, and painter is in
//     none of `DOM_SOURCE_LANE_TYPES` / `CARD_PRODUCER_LANE_TYPES` /
//     `HEADLESS_MOUNT_LANE_TYPES`, so no card is mounted anywhere to fall back
//     on. This file asserts the legacy card is ABSENT and that a gesture on the
//     FACE still paints.
//  2. ⚠ THAT THE PAINT REACHES `out`. The body's canvas is the SOURCE, not a
//     copy of the output: its pixels are uploaded into painter's texture by the
//     module's own `draw()` only while the body holds the extras lease AND the
//     node is a pull root. Asserting the 2-D canvas went red proves the
//     EDITOR works and says nothing about the MODULE — the engine-direct trap
//     that has shipped green, silent modules before. So this reads the node's
//     OWN output texture.
//  3. ⚠ THAT SCREEN OFF IS NOT A PRODUCER KILL SWITCH. OFF unmounts the canvas,
//     which RELEASES the lease; `$lib/ui/media/extras-producers` must re-push
//     its own replay of the same op log, so `out` keeps carrying the drawing
//     with no editor on screen. The shared suite asserts the canvas is GONE and
//     is structurally blind to what the module is emitting while it is.
//  4. ⚠ THAT THE CANVAS SURVIVES ITS OWN REMOUNT. The SCREEN cycle destroys and
//     recreates the element, so setup that ran in `onMount` would come back
//     holding a 2-D context on a DETACHED canvas — the visible editor would
//     paint nothing while the ops still committed. The shared suite passes that
//     regression, because the canvas is back in the DOM and has a box.
//  5. ⚠ THAT RIGHT-CLICK-A-SWATCH STILL SETS THE BACKGROUND. It is the only way
//     to change the colour the ERASER paints with, and it is the affordance
//     most easily lost in a port (a context menu is easy to forget and nothing
//     type-checks it). The op log is where the answer is.

import { test, expect, type Locator, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { BOOT_MS, SLOW_BOOT_TEST_TIMEOUT_MS, SLOW_RENDER } from '../_helpers/boot-budget';

const NODE = 'fpaint1';

/** The Win95 swatches this spec drives, by their palette hex (the testid tail). */
const RED = '#ff0000';
const BLUE = '#0000ff';

type PatchGlobal = {
  __patch: { nodes: Record<string, { data?: { ops?: { color?: string }[] } }> };
};

async function boot(page: Page): Promise<void> {
  // Plain /rack — the DEFAULT shell. `painter.spec.ts`'s `?shell=legacy` is
  // precisely the surface promotion does not change.
  await page.goto('/rack?seed=none');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: BOOT_MS });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

/** Open this node's dock faceplate (the auto-retrying tv-librarian pattern —
 *  the tile button is hit-testable while a previous pane is still tearing down,
 *  so one click can land on nothing). */
async function openDock(page: Page, nodeId: string): Promise<Locator> {
  const shell = page.locator(`.svelte-flow__node[data-id="${nodeId}"] [data-testid="module-shell"]`);
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

async function spawnPainter(page: Page): Promise<void> {
  await spawnPatch(page, [{ id: NODE, type: 'painter', domain: 'video' }], [], {
    mountTimeout: BOOT_MS,
  });
}

/** The committed op log, read off the live patch. */
function ops(page: Page): Promise<{ color?: string }[]> {
  return page.evaluate((id) => {
    const w = globalThis as unknown as PatchGlobal;
    return (w.__patch.nodes[id]?.data?.ops ?? []) as { color?: string }[];
  }, NODE);
}

interface CanvasStats {
  /** The DRAWING BUFFER size, which the body sets from `VIDEO_RES`. */
  width: number;
  height: number;
  /** Fraction of sampled pixels that are OPAQUE and not near-white. */
  paintedFrac: number;
  /** Fraction that are opaque and saturated RED. */
  redFrac: number;
}

/**
 * The FACE's own canvas, read back in 2-D. Cheap, and it says nothing about the
 * MODULE — that is `probeOut`'s job (see leg 2).
 *
 * ⚠ EVERY MEASURE REQUIRES OPACITY, and that is the correction that makes this
 * instrument able to fail. A canvas that was never set up is TRANSPARENT BLACK
 * (rgba 0,0,0,0), so a naive "not near-white" test reads it as 100% PAINTED —
 * which is exactly the state the remount regression produces, and it would have
 * turned the leg below into a check that passes hardest when the product is
 * most broken. `width` is reported for the same reason: an un-set-up canvas is
 * the HTML default 300x150, never the engine's buffer.
 */
function faceCanvasStats(page: Page): Promise<CanvasStats | null> {
  return page.evaluate(() => {
    const c = document.querySelector(
      '[data-testid="painter-face-canvas"]',
    ) as HTMLCanvasElement | null;
    if (!c) return null;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    let painted = 0;
    let red = 0;
    for (let i = 0; i < d.length; i += 4 * 64) {
      n++;
      const r = d[i]!;
      const g = d[i + 1]!;
      const b = d[i + 2]!;
      const a = d[i + 3]!;
      if (a < 200) continue; // transparent — an un-set-up canvas, not paint
      if (r < 240 || g < 240 || b < 240) painted++;
      if (r > 200 && g < 80 && b < 80) red++;
    }
    return {
      width: c.width,
      height: c.height,
      paintedFrac: n > 0 ? painted / n : 0,
      redFrac: n > 0 ? red / n : 0,
    };
  });
}

interface Reading {
  r: number;
  g: number;
  b: number;
  /** Pixels sampled — 0 means the probe never looked, which must never read as
   *  a pass. */
  samples: number;
  hasTexture: boolean;
  fbComplete: boolean;
}

/**
 * The MODULE's own output texture, per channel.
 *
 * ⚠ IT READS STRIPS, NOT THE FRAME (#1757). A full 1024x768 readback is 3.1 MB
 * and forces a flush+sync on the SwiftShader context under measurement, which
 * on a four-worker CI runner makes the instrument cost more than the subject —
 * the exact failure `extras-producer-lifetime.spec.ts` documents at length. Six
 * two-row strips are 49 KB and still span the frame vertically. Every reading
 * carries `tex` / `fbo` / `samples` so a probe that measured NOTHING cannot be
 * mistaken for a probe that measured white.
 */
async function probeOut(page: Page): Promise<Reading> {
  return page.evaluate(
    ({ id, strips, rows }) => {
      const w = globalThis as unknown as {
        __engine: () => {
          getDomain: (d: string) => {
            gl: WebGL2RenderingContext;
            outputTexture: (n: string, port?: string) => WebGLTexture | null;
            res: { width: number; height: number };
          };
        };
      };
      const empty = { r: 0, g: 0, b: 0, samples: 0, hasTexture: false, fbComplete: false };
      let vid: ReturnType<ReturnType<typeof w.__engine>['getDomain']>;
      try {
        vid = w.__engine().getDomain('video');
      } catch {
        return empty;
      }
      const gl = vid.gl;
      const tex = vid.outputTexture(id);
      if (!tex) return empty;
      const { width: W, height: H } = vid.res;
      const fb = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      const px = new Uint8Array(W * rows * 4);
      let n = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      if (complete) {
        for (let s = 0; s < strips; s++) {
          const y = Math.floor(((s + 0.5) / strips) * Math.max(1, H - rows));
          gl.readPixels(0, y, W, rows, gl.RGBA, gl.UNSIGNED_BYTE, px);
          for (let i = 0; i < px.length; i += 4 * 4) {
            r += px[i]!;
            g += px[i + 1]!;
            b += px[i + 2]!;
            n++;
          }
        }
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fb);
      while (gl.getError() !== gl.NO_ERROR) {
        /* drain the readback (already captured) */
      }
      return {
        r: n ? Math.round(r / n) : 0,
        g: n ? Math.round(g / n) : 0,
        b: n ? Math.round(b / n) : 0,
        samples: n,
        hasTexture: true,
        fbComplete: complete,
      };
    },
    { id: NODE, strips: 6, rows: 2 },
  );
}

function fmt(x: Reading): string {
  return `meanRGB=(${x.r},${x.g},${x.b}) samples=${x.samples} tex=${x.hasTexture} fbo=${x.fbComplete}`;
}

/** Is `channel` clearly the dominant one, and is there anything there at all?
 *  `samples > 0` is what stops a probe that looked at nothing from passing. */
function dominates(x: Reading, channel: 'r' | 'g' | 'b'): boolean {
  const others = (['r', 'g', 'b'] as const).filter((c) => c !== channel);
  return x.samples > 0 && x[channel] > 64 && others.every((c) => x[channel] > x[c] + 32);
}

/** A BLANK MS-Paint page: every channel saturated. The negative control for
 *  every `dominates` assertion below — the module's idle state is white, so a
 *  probe that could not tell white from red would pass leg 2 vacuously. */
function isBlankPage(x: Reading): boolean {
  return x.samples > 0 && x.r > 200 && x.g > 200 && x.b > 200;
}

/** Left-click a palette swatch (FOREGROUND). */
async function pickFg(body: Locator, hex: string): Promise<void> {
  await body.locator(`[data-testid="painter-face-swatch-${hex}"]`).click();
}

/** RIGHT-click a palette swatch (BACKGROUND — the eraser's colour, and a filled
 *  shape's interior). The only route to it on either surface. */
async function pickBg(body: Locator, hex: string): Promise<void> {
  await body.locator(`[data-testid="painter-face-swatch-${hex}"]`).click({ button: 'right' });
}

/**
 * The canvas's box, IN THE VIEWPORT.
 *
 * ⚠ `scrollIntoViewIfNeeded` FIRST, and it is not defensive padding. The dock
 * pane scrolls, `boundingBox()` reports document coordinates whether or not the
 * element is on screen, and `page.mouse` drives real viewport pixels — so a
 * canvas scrolled below the fold takes every gesture in this file and lands it
 * on whatever is actually there. Measured: with the editor at its full editing
 * size the drag silently painted NOTHING and the failure surfaced as
 * "0 ops committed", which reads like a broken commit path rather than a test
 * pointing at the wrong pixels.
 */
async function canvasBox(body: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const canvas = body.locator('[data-testid="painter-face-canvas"]');
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('the face canvas has no bounding box');
  return box;
}

/** Flood the whole page with the current FOREGROUND — one click, and it
 *  saturates the frame, so the strip probe reads it unambiguously. */
async function floodFill(page: Page, body: Locator): Promise<void> {
  await body.locator('[data-testid="painter-face-tool-fill"]').click();
  const box = await canvasBox(body);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

/** Drag a thick brush stroke across the face canvas. */
async function drawStroke(page: Page, body: Locator, yFrac = 0.5): Promise<void> {
  await body.locator('[data-testid="painter-face-tool-brush"]').click();
  await body.locator('[data-testid="painter-face-size"]').fill('48');
  const box = await canvasBox(body);
  const y = box.y + box.height * yFrac;
  await page.mouse.move(box.x + box.width * 0.15, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, y);
  await page.mouse.move(box.x + box.width * 0.85, y);
  await page.mouse.up();
}

const PROBE_MS = SLOW_RENDER ? 60_000 : 30_000;

test.describe('PAINTER face — the promotion is what makes it drawable', () => {
  // ⚠ A PAGE ERROR FAILS EVERY TEST IN THIS FILE. A TypeError inside a
  // `$derived` or an `$effect` does not surface as a thrown assertion — it
  // takes the subtree's render down and the symptom lands somewhere else
  // entirely (the tv-librarian-face incident, twice). This body runs an effect
  // per element mount and a rAF for its whole lifetime, so it has two places to
  // throw that a locator assertion would report as "not visible".
  test.beforeEach(({ page }) => {
    page.on('pageerror', (err) => {
      throw new Error(`uncaught page error during a painter face test: ${err.message}`);
    });
  });

  test('the shell replaces the card, and a gesture on the FACE reaches OUT @video', async ({
    page,
  }) => {
    // Serialises the dock's lazy body chunk plus two GL readbacks behind the
    // boot — bounded from the ONE export site, never a flat literal.
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 3);
    await boot(page);
    await spawnPainter(page);

    // ⚠ THE PRECONDITION, ASSERTED RATHER THAN ASSUMED. If a card were mounted
    // anywhere, every claim below would be about the CARD and this file would
    // be measuring the surface it exists to replace.
    await expect(
      page.locator('[data-testid="painter-card"]'),
      'a promoted painter must render NO legacy card on either default surface',
    ).toHaveCount(0);

    const body = await openDock(page, NODE);
    await expect(
      body.locator('[data-testid="painter-face-canvas"]'),
      'the face body is the only drawing surface a player can reach',
    ).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

    // ── THE NEGATIVE CONTROL, FIRST. A fresh painter is a BLANK WHITE PAGE, so
    // a probe that cannot tell white from red would pass the leg below without
    // measuring anything.
    await expect
      .poll(async () => isBlankPage(await probeOut(page)), {
        message: 'a fresh painter must emit a blank WHITE page, never a dead black frame',
        timeout: PROBE_MS,
      })
      .toBe(true);
    const blank = await probeOut(page);
    expect(dominates(blank, 'r'), `the blank page must NOT read as red: ${fmt(blank)}`).toBe(false);

    // ── THE GESTURE. A drag commits ONE synced stroke op and paints the editor.
    await pickFg(body, RED);
    await drawStroke(page, body, 0.3);
    await expect
      .poll(async () => (await ops(page)).length, {
        message: 'one stroke op committed to node.data.ops from the FACE',
      })
      .toBe(1);
    const afterStroke = await faceCanvasStats(page);
    expect(afterStroke, 'the editing surface is readable').not.toBeNull();
    expect(
      afterStroke!.paintedFrac,
      'the drag painted the editing surface',
    ).toBeGreaterThan(0.005);

    // ── AND IT REACHES `out`. ⚠ THIS IS THE LEG THAT SEPARATES "the editor
    // works" FROM "the module works": the body's canvas is the SOURCE, so the
    // paint only appears on the output if the body actually holds the extras
    // lease AND the node is being drawn. A flood fill saturates the frame, so
    // the strip probe reads it unambiguously.
    await floodFill(page, body);
    await expect
      .poll(async () => (await ops(page)).length, { message: 'the fill op commits too' })
      .toBe(2);
    await expect
      .poll(async () => dominates(await probeOut(page), 'r'), {
        message:
          "painter's OWN output texture must carry what was painted on the FACE. The same probe " +
          `read ${fmt(blank)} on the blank page before the gesture.`,
        timeout: PROBE_MS,
      })
      .toBe(true);
    console.log(`face-painter: blank ${fmt(blank)} | painted ${fmt(await probeOut(page))}`);
  });

  test('SCREEN OFF collapses the EDITOR and never the OUTPUT, and the canvas survives the remount @video', async ({
    page,
  }) => {
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 3);
    await boot(page);
    await spawnPainter(page);
    const body = await openDock(page, NODE);
    await expect(body.locator('[data-testid="painter-face-canvas"]')).toBeVisible({
      timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
    });

    await pickFg(body, RED);
    await floodFill(page, body);
    await expect
      .poll(async () => dominates(await probeOut(page), 'r'), {
        message: 'the drawing must reach OUT before the SCREEN switch is exercised',
        timeout: PROBE_MS,
      })
      .toBe(true);

    // ── SCREEN OFF. The canvas is REMOVED (the shared suite's leg) and with it
    // the extras lease — so the node-lifetime producer must take the binding
    // back and go on emitting the SAME picture.
    const toggle = body.locator('[data-testid="painter-face-screen-toggle"]');
    await toggle.click();
    await expect(toggle, 'now OFF').toHaveAttribute('aria-pressed', 'false');
    await expect(
      body.locator('[data-testid="painter-face-canvas"]'),
      'the editor is GONE, not hidden',
    ).toHaveCount(0);
    await expect(
      toggle,
      'the switch survives its own OFF state — it is the only way any peer brings the editor back',
    ).toBeVisible();

    // ⚠ THE LEG NOTHING ELSE HAS. `face-screen-render-*` asserts the canvas
    // disappeared; it is structurally blind to what the module is emitting
    // while it is gone. A `setPaintCanvas(null)` on teardown — which reads as
    // correct cleanup — would drop this to a blank white page, the #1720 bug.
    await expect
      .poll(async () => dominates(await probeOut(page), 'r'), {
        message:
          'SCREEN OFF became a PRODUCER KILL SWITCH: the editor was collapsed and the module ' +
          'stopped carrying the drawing on OUT',
        timeout: PROBE_MS,
      })
      .toBe(true);

    // ── SCREEN ON. ⚠ THE REMOUNT LEG. The canvas is a NEW element, so a body
    // that set up in `onMount` would come back holding a 2-D context on the
    // DETACHED one: the ops would still commit and the visible editor would
    // paint nothing. The shared suite passes that regression — the canvas is
    // back in the DOM with a box — so this is where it is caught.
    await toggle.click();
    await expect(toggle, 'back ON').toHaveAttribute('aria-pressed', 'true');
    const canvas = body.locator('[data-testid="painter-face-canvas"]');
    await expect(canvas).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
    // The remounted canvas is REPLAYED from the log, so the drawing is on it
    // before anything else happens. ⚠ RED, not merely "painted": an un-set-up
    // canvas is transparent black, which a painted-ness test reads as fully
    // painted. And the BUFFER SIZE is asserted beside it, because the same
    // regression leaves the element at the HTML default 300x150 — two
    // independent fingerprints of one defect.
    await expect
      .poll(async () => (await faceCanvasStats(page))?.redFrac ?? -1, {
        message:
          'the remounted editor does not carry the drawing — its 2-D context is on a DETACHED ' +
          'element (the onMount-instead-of-$effect regression), so the log was never replayed ' +
          'onto the canvas the player is looking at',
        timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
      })
      .toBeGreaterThan(0.9);
    const remounted = await faceCanvasStats(page);
    expect(
      remounted!.width,
      'the remounted canvas was never RE-SIZED to the engine buffer — it is the HTML default',
    ).toBeGreaterThan(300);

    // …and it still ACCEPTS input, which is the other half of the same defect:
    // a detached context takes strokes that nobody can see.
    await pickFg(body, BLUE);
    await floodFill(page, body);
    await expect
      .poll(async () => (await ops(page)).length, { message: 'the post-remount fill commits' })
      .toBe(2);
    await expect
      .poll(async () => dominates(await probeOut(page), 'b'), {
        message: 'a gesture made AFTER a SCREEN cycle must reach OUT like any other',
        timeout: PROBE_MS,
      })
      .toBe(true);
  });

  test('RIGHT-CLICKING a swatch sets the BACKGROUND, which is what the ERASER paints', async ({
    page,
  }) => {
    // ⚠ NO GL HERE, DELIBERATELY. The claim is about which COLOUR the committed
    // op carries, and the op log answers it exactly — a pixel probe would be a
    // slower instrument for a weaker statement.
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 2);
    await boot(page);
    await spawnPainter(page);
    const body = await openDock(page, NODE);
    await expect(body.locator('[data-testid="painter-face-canvas"]')).toBeVisible({
      timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
    });

    // ⚠ THE TEXT FIELD IS TOOL-GATED, exactly as the card has it — a stamp
    // string does nothing unless TEXT is the active tool, and a control that
    // cannot act is the dead-control shape this program keeps deleting. Pinned
    // here because the typed-entry gate greps SOURCE and cannot see whether the
    // field is ever actually rendered.
    const stamp = body.locator('[data-testid="painter-face-text-input"]');
    await expect(stamp, 'no stamp field while another tool is active').toHaveCount(0);
    await body.locator('[data-testid="painter-face-tool-text"]').click();
    await expect(stamp, 'the TEXT tool reveals it').toBeVisible();

    // Left-click sets the FOREGROUND: a red fill.
    await pickFg(body, RED);
    await floodFill(page, body);
    await expect.poll(async () => (await ops(page))[0]?.color).toBe(RED);

    // RIGHT-click sets the BACKGROUND. Nothing visible changes at the moment of
    // the click — the only observable is what the eraser then paints with,
    // which is exactly why this affordance is easy to lose in a port.
    await pickBg(body, BLUE);
    await body.locator('[data-testid="painter-face-tool-eraser"]').click();
    await body.locator('[data-testid="painter-face-size"]').fill('48');
    const box = await canvasBox(body);
    const y = box.y + box.height * 0.5;
    await page.mouse.move(box.x + box.width * 0.2, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.8, y);
    await page.mouse.up();

    await expect
      .poll(async () => (await ops(page)).length, { message: 'the eraser stroke commits' })
      .toBe(2);
    const stroke = (await ops(page))[1];
    expect(
      stroke?.color,
      'the eraser must paint the RIGHT-CLICKED background colour — if this is the foreground, ' +
        'the swatch context menu was lost in the port and the background is unreachable',
    ).toBe(BLUE);
  });
});
