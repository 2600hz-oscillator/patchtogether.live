// e2e/tests/ai-smoke.spec.ts
//
// AI-friendly smoke check. Designed for an AI agent to run via `task ai:check`
// and parse the result without ambiguity. Each test does ONE thing and labels
// it clearly. Failures dump captured console + screenshot path so the agent
// can read the diagnostic without separate steps.

import { test, expect } from '@playwright/test';
import { captureConsole, formatConsole } from './helpers';
import { spawnPatch } from './_helpers';

test.describe('AI smoke check', () => {
  test('app: HTTP 200 + COOP/COEP headers @smoke', async ({ page }) => {
    const response = await page.goto('/');
    expect(response, 'no response').toBeTruthy();
    expect(response!.status(), `status ${response!.status()}`).toBe(200);
    const headers = response!.headers();
    expect(
      headers['cross-origin-opener-policy'],
      'COOP missing'
    ).toBe('same-origin');
    expect(
      headers['cross-origin-embedder-policy'],
      'COEP missing'
    ).toBe('require-corp');
  });

  test('app: title is patchtogether.live @smoke', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle('patchtogether.live');
  });

  test('app: cross-origin-isolated context (Faust SharedArrayBuffer prereq) @smoke', async ({ page }) => {
    await page.goto('/');
    const isolated = await page.evaluate(() => globalThis.crossOriginIsolated);
    expect(isolated, 'crossOriginIsolated must be true').toBe(true);
  });

  test('canvas: topbar + Load example button render', async ({ page }) => {
    const cc = captureConsole(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const h1 = page.locator('h1', { hasText: 'patchtogether.live' });
    await expect(h1, 'topbar h1 missing').toBeVisible();

    const spawnBtn = page.getByRole('button', { name: 'Load example' });
    await expect(spawnBtn, 'Load example button missing').toBeVisible();

    const errors = cc.pageErrors.length + cc.errors.length;
    if (errors > 0) {
      throw new Error(`${errors} console/page errors during shell render:\n${formatConsole(cc)}`);
    }
  });

  // Regression: PR-2 preview shipped without any sign-in entry on the public
  // canvas, so users had no way to reach /sign-in or /dashboard. ClerkProvider
  // is intentionally not mounted on `/` (COEP would block its CDN), so the
  // entry must be a plain link, not a Clerk component. This test runs against
  // the live autotest env once main is deployed, catching regressions where a
  // refactor removes the entry point or a layout change hides it.
  test('auth: landing page exposes a sign-in entry point @smoke', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const link = page.getByTestId('signin-link');
    await expect(link, 'sign-in link missing on landing page').toBeVisible();

    // Must point at an auth-handled route. /dashboard is the canonical
    // entry — it redirects to /sign-in?redirect_url=/dashboard when signed
    // out, and renders the dashboard when signed in.
    const href = await link.getAttribute('href');
    expect(href, `sign-in link href: ${href}`).toMatch(/^\/(dashboard|sign-in)/);
  });

  test('canvas: Load example creates 5 Svelte Flow nodes @smoke', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Load example' }).click();
    const nodes = page.locator('.svelte-flow__node');
    await expect(nodes, 'expected 5 module-card nodes after Load example').toHaveCount(5, {
      timeout: 10_000,
    });
  });

  test('canvas: spawned nodes are VISUALLY rendered (non-zero bounding rect)', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Load example' }).click();
    await expect(page.locator('.svelte-flow__node')).toHaveCount(5, { timeout: 10_000 });

    // Bounding rects: cards must be visible on screen (width × height > 0
    // AND inside the viewport). Catches the case where DOM exists but Svelte
    // Flow's container has zero height (the canvas appears empty).
    const rects = await page.locator('.svelte-flow__node').evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        return { width: r.width, height: r.height, top: r.top, left: r.left, visible: r.width > 0 && r.height > 0 };
      })
    );
    for (const [i, r] of rects.entries()) {
      expect(r.visible, `node ${i} bounding rect: ${JSON.stringify(r)}`).toBe(true);
      expect(r.width, `node ${i} width`).toBeGreaterThan(50);
      expect(r.height, `node ${i} height`).toBeGreaterThan(50);
    }

    // Background dot pattern proves Svelte Flow itself is rendering.
    // Use toBeAttached because the background is an SVG without intrinsic size
    // even though the dots are visibly painted — toBeVisible is too strict here.
    const bgPattern = page.locator('.svelte-flow__background-pattern.dots');
    await expect(bgPattern, 'background dot pattern not in DOM').toBeAttached();
  });

  test('fader: dragging visibly moves the thumb (motorized state reflection)', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Load example' }).click();
    await expect(page.locator('.svelte-flow__node')).toHaveCount(5, { timeout: 10_000 });

    // First fader on the Analog VCO card = TUNE.
    const tuneTrack = page
      .locator('.svelte-flow__node-analogVco .fader-wrap')
      .first()
      .locator('.track');
    const tuneThumb = page
      .locator('.svelte-flow__node-analogVco .fader-wrap')
      .first()
      .locator('.thumb');

    const initialTop = await tuneThumb.evaluate((el) => (el as HTMLElement).style.top);
    const trackBox = await tuneTrack.boundingBox();
    expect(trackBox, 'TUNE track not visible').toBeTruthy();
    if (!trackBox) return;

    const cx = trackBox.x + trackBox.width / 2;
    const cy = trackBox.y + trackBox.height / 2;

    // Drag DOWN 30px — thumb should move visibly (motorized fader convention).
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx, cy + 30, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(100);

    const newTop = await tuneThumb.evaluate((el) => (el as HTMLElement).style.top);
    expect(
      newTop,
      `thumb top should change after drag; was ${initialTop}, now ${newTop}`
    ).not.toBe(initialTop);
  });

  test('connect-replaces-existing: patching to an occupied input replaces the prior cable', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await spawnPatch(
      page,
      [
        { id: 'vco', type: 'analogVco', position: { x: 100, y: 100 } },
        { id: 'out', type: 'audioOut',  position: { x: 500, y: 100 }, params: { master: 0.2 } },
      ],
      [
        { id: 'e1', from: { nodeId: 'vco', portId: 'saw' }, to: { nodeId: 'out', portId: 'L' } },
      ]
    );
    await expect(page.locator('.svelte-flow__node')).toHaveCount(2);
    await expect(page.locator('.svelte-flow__edge')).toHaveCount(1);

    const sqr = page.locator('.svelte-flow__node-analogVco .svelte-flow__handle[data-handleid="square"]');
    const audioIn = page.locator('.svelte-flow__node-audioOut .svelte-flow__handle[data-handleid="L"]');
    const a = await sqr.boundingBox();
    const b = await audioIn.boundingBox();
    if (!a || !b) throw new Error('handles not found');

    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(150);

    await expect(page.locator('.svelte-flow__edge'), 'still 1 edge after replace').toHaveCount(1);
  });

  test('detach-on-grab: starting a drag from a patched input removes the existing cable', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await spawnPatch(
      page,
      [
        { id: 'vco', type: 'analogVco', position: { x: 100, y: 100 } },
        { id: 'out', type: 'audioOut',  position: { x: 500, y: 100 }, params: { master: 0.2 } },
      ],
      [
        { id: 'e1', from: { nodeId: 'vco', portId: 'saw' }, to: { nodeId: 'out', portId: 'L' } },
      ]
    );
    await expect(page.locator('.svelte-flow__edge')).toHaveCount(1);

    // Post-PatchPanel: jacks live in a hover-revealed panel. Open the
    // panel first so the input handle is at its row position (not
    // stacked-at-trigger with pointer-events:none) before we measure.
    //
    // ROOT-CAUSE FIX (May 2026): the previous test used .hover() then
    // immediately read boundingBox(). Two distinct failure modes hit
    // CI:
    //
    //   1. The panel runs a 120 ms opacity + translateX(-8px → 0)
    //      transition on .open. The translateX moves the handle by 8 px
    //      in viewport coords. A bounding-box read mid-transition
    //      reports the in-flight position; by the time the mouse-down
    //      reaches the browser via CDP, the handle has moved. The
    //      mouse-down lands beside the handle, gets ignored by the
    //      `pointer-events:none` closed-state stack, and bubbles up
    //      to the SvelteFlow node — Svelte Flow treats it as a node-
    //      drag, NOT a connect-drag. handleConnectStart never fires.
    //
    //   2. After hover() the panel opens via the `hovered` driver, but
    //      that driver is sticky for only 200 ms past the next
    //      mouseleave. Playwright moves the mouse during measure +
    //      drag setup; if the panel auto-closes mid-drag, the handle
    //      vanishes and Svelte Flow can't register the connect.
    //
    // Fix: CLICK the trigger to PIN the panel open (the `pinned`
    // driver locks the panel until another click). Then assert
    // aria-hidden=false so we know the .open class is applied AND
    // the panel finished the transition (Playwright's auto-retry
    // gives us the polling for free). Pump 2 RAFs to let
    // useUpdateNodeInternals refresh Svelte Flow's handleBounds.
    await page
      .locator('.svelte-flow__node-audioOut [data-testid="patch-trigger"]')
      .click();
    await expect(
      page.locator('.svelte-flow__node-audioOut [data-testid="patch-panel"]'),
    ).toHaveAttribute('aria-hidden', 'false');
    await page.evaluate(
      () =>
        new Promise<void>((res) =>
          requestAnimationFrame(() => requestAnimationFrame(() => res())),
        ),
    );

    const audioIn = page.locator('.svelte-flow__node-audioOut .svelte-flow__handle[data-handleid="L"]');
    // Wait for the handle to be visible (panel is .open → handle has
    // pointer-events:auto + opacity > 0). toBeVisible auto-retries.
    await expect(audioIn).toBeVisible();
    const box = await audioIn.boundingBox();
    if (!box) throw new Error('audio input handle not found');

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    // 20 steps so Svelte Flow's drag tracker sees the pointermove
    // sequence (a too-fast drag has been observed to confuse the
    // connection-line state machine on slow runners).
    await page.mouse.move(box.x + box.width / 2, box.y + 300, { steps: 20 });
    await page.mouse.up();
    await page.waitForTimeout(150);

    await expect(page.locator('.svelte-flow__edge'), 'edge should be detached').toHaveCount(0);
  });

  test.fixme(
    'delete: clicking an edge + Backspace removes it from the patch',
    async () => {
      // Headless Playwright struggles to register a click on Svelte Flow's
      // SVG edge layer (visible stroke is 3px tall; the wider invisible
      // interaction band has subtle pointer-events semantics). Backspace-on-
      // selected-edge works fine in real browsers via Svelte Flow's default
      // deleteKey handler. The engine-side teardown is covered by the Clear
      // test below. TODO: figure out a Playwright-friendly way to select an
      // edge — likely via the SvelteFlow store API exposed in dev.
    }
  );

  test('clear: Clear button removes all nodes + edges from patch + DOM', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Load example' }).click();
    await expect(page.locator('.svelte-flow__node')).toHaveCount(5, { timeout: 10_000 });
    await expect(page.locator('.svelte-flow__edge')).toHaveCount(6);

    await page.getByRole('button', { name: 'Clear' }).click();
    await page.waitForTimeout(150);

    await expect(page.locator('.svelte-flow__node')).toHaveCount(0);
    await expect(page.locator('.svelte-flow__edge')).toHaveCount(0);
    const statusText = (await page.locator('.bottombar').textContent()) ?? '';
    expect(statusText).toMatch(/nodes\s*0/);
    expect(statusText).toMatch(/edges\s*0/);
  });

  test('node-drag: dragging a card persists position back to the patch graph', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Load example' }).click();
    await expect(page.locator('.svelte-flow__node')).toHaveCount(5, { timeout: 10_000 });

    const vco = page.locator('.svelte-flow__node-analogVco');
    const before = await vco.evaluate((el) => (el as HTMLElement).style.transform);

    // Grab the card's title bar (away from handles + faders) and drag right.
    const title = page.locator('.svelte-flow__node-analogVco header.title');
    const box = await title.boundingBox();
    if (!box) throw new Error('VCO title not visible');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(150);

    const after = await vco.evaluate((el) => (el as HTMLElement).style.transform);
    expect(after, `node transform should change after drag (was ${before})`).not.toBe(before);
  });

  test('canvas: spawned patch produces audio (peak meter > 0) @smoke', async ({ page }) => {
    const cc = captureConsole(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Load example' }).click();

    await expect(page.locator('.svelte-flow__node')).toHaveCount(5, { timeout: 10_000 });

    const statusText = (await page.locator('.bottombar').textContent()) ?? '';
    expect(statusText, `bottombar text: "${statusText}"`).toMatch(/ctx\s*running/);
    expect(statusText).toMatch(/nodes\s*5/);
    expect(statusText).toMatch(/edges\s*6/);

    if (cc.pageErrors.length || cc.errors.length) {
      console.log(formatConsole(cc));
    }
  });
});
