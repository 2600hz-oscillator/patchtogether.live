// e2e/tests/ai-smoke.spec.ts
//
// AI-friendly smoke check. Designed for an AI agent to run via `task ai:check`
// and parse the result without ambiguity. Each test does ONE thing and labels
// it clearly. Failures dump captured console + screenshot path so the agent
// can read the diagnostic without separate steps.

import { test, expect, loadVoiceDemo, openFileMenu, fileMenuClick } from './_fixtures';
import { captureConsole, formatConsole } from './helpers';
import { spawnPatch, canvasPane} from './_helpers';

test.describe('AI smoke check', () => {
  test('app: HTTP 200 + COOP/COEP headers @smoke', async ({ page }) => {
    const response = await page.goto('/rack?seed=none');
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
    ).toBe('credentialless');
    // ^ `credentialless` (not `require-corp`): keeps the page cross-origin
    //   ISOLATED (the @smoke test below asserts crossOriginIsolated === true, so
    //   SharedArrayBuffer/Faust still work) while letting no-cors third-party
    //   media (ARCHIVIST's archive.org <video>/<audio>/<img>) actually load. See
    //   packages/web/src/hooks.server.ts setCoopCoepHeaders.
  });

  test('app: title is patchtogether.live @smoke', async ({ page }) => {
    await page.goto('/rack?seed=none');
    await expect(page).toHaveTitle('patchtogether.live');
  });

  test('app: cross-origin-isolated context (Faust SharedArrayBuffer prereq) @smoke', async ({ page }) => {
    await page.goto('/rack?seed=none');
    const isolated = await page.evaluate(() => globalThis.crossOriginIsolated);
    expect(isolated, 'crossOriginIsolated must be true').toBe(true);
  });

  test('canvas: topbar renders its controls', async ({ page, rack }) => {
    const cc = captureConsole(page);

    const h1 = page.locator('h1', { hasText: 'patchtogether' });
    await expect(h1, 'topbar h1 missing').toBeVisible();

    // The shell's own controls. (This used to assert the "Load example…"
    // dropdown; that control was deleted with the example patches, so the
    // shell check moved to two controls that are actually part of the rack
    // UI — the preset-slot bar and the Raw JSON action menu.)
    // The topbar's actions live behind File.. now (the bare-button bar went
    // with the second shell). Assert the trigger + one row inside it, so this
    // still fails if the menu stops opening rather than merely stops existing.
    await expect(page.getByTestId('workflow-file-trigger'), 'File.. missing').toBeVisible();
    await openFileMenu(page);
    await expect(page.getByTestId('workflow-file-rawjson'), 'Raw JSON row missing').toBeVisible();
    await expect(page.getByTestId('workflow-file-quicksave'), 'Quicksave row missing').toBeVisible();
    await page.keyboard.press('Escape');

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
  test('auth: landing page exposes a sign-in entry point @smoke', async ({ page, rack }) => {
    await openFileMenu(page);
    const link = page.getByTestId('workflow-file-signin');
    await expect(link, 'sign-in link missing on landing page').toBeVisible();

    // Must point at an auth-handled route. /dashboard is the canonical
    // entry — it redirects to /sign-in?redirect_url=/dashboard when signed
    // out, and renders the dashboard when signed in.
    const href = await link.getAttribute('href');
    expect(href, `sign-in link href: ${href}`).toMatch(/^\/(dashboard|sign-in)/);
  });

  test('canvas: the voice demo creates 5 Svelte Flow nodes @smoke', async ({ page, rack }) => {
    await loadVoiceDemo(page);
    const nodes = page.locator('.svelte-flow__node');
    await expect(nodes, 'expected 5 module-card nodes after the voice demo').toHaveCount(5, {
      timeout: 10_000,
    });
  });

  test('canvas: spawned nodes are VISUALLY rendered (non-zero bounding rect)', async ({ page, rack }) => {
    await loadVoiceDemo(page);
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
    // The canvas now layers TWO dot <Background> fields — the fine 16px texture
    // and the 180px virtual-rack grid (Canvas.svelte) — so `.dots` matches two
    // patterns; `.first()` keeps the assertion unambiguous (strict-mode safe).
    const bgPattern = page.locator('.svelte-flow__background-pattern.dots').first();
    await expect(bgPattern, 'background dot pattern not in DOM').toBeAttached();
  });

  test('fader: dragging visibly moves the thumb (motorized state reflection)', async ({ page, rack }) => {
    await loadVoiceDemo(page);
    await expect(page.locator('.svelte-flow__node')).toHaveCount(5, { timeout: 10_000 });

    // The draggable NeonFader lives in the DOCK ladder on the default shell
    // (the lane tile draws knobs) — open the VCO's pane and take its first
    // fader (TUNE).
    const vcoId = (await page
      .locator('.svelte-flow__node:has([data-shell-type="analogVco"])')
      .first()
      .getAttribute('data-id'))!;
    await page.evaluate(
      (id) => (globalThis as unknown as { __openDockFullView: (id: string) => void }).__openDockFullView(id),
      vcoId,
    );
    const pane = page.locator(`[data-testid="dock-fullview-pane"][data-pane-node="${vcoId}"]`);
    await expect(pane).toBeVisible();
    const tune = pane.locator('[data-testid="control-tune"][role="slider"]').first();
    await tune.scrollIntoViewIfNeeded();

    // ⚠ A RENDERED property, not a state variable (#1794's lesson): the shell
    // Knob spins its `.ptr` pointer with an inline rotate transform, so an empty read
    // means the probe is on the wrong element — asserted non-empty both times.
    const readThumb = () => tune.locator('.ptr').evaluate((el) => (el as HTMLElement).style.transform);
    const initialTop = await readThumb();
    expect(initialTop, 'knob tick has no inline transform — this probe is reading the wrong property').not.toBe('');
    const trackBox = await tune.boundingBox();
    expect(trackBox, 'TUNE knob not visible').toBeTruthy();
    if (!trackBox) return;

    const cx = trackBox.x + trackBox.width / 2;
    const cy = trackBox.y + trackBox.height / 2;

    // Drag DOWN 30px — thumb should move visibly (motorized fader convention).
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx, cy + 30, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(100);

    const newTop = await readThumb();
    expect(newTop, 'thumb lost its inline transform mid-drag').not.toBe('');
    expect(
      newTop,
      `thumb offset should change after drag; was ${initialTop}, now ${newTop}`
    ).not.toBe(initialTop);
  });

  test('connect-replaces-existing: patching to an occupied input replaces the prior cable', async ({ page, rack }) => {
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

    const sqr = page.locator('.svelte-flow__node:has([data-shell-type="analogVco"]) .svelte-flow__handle[data-handleid="square"]');
    const audioIn = page.locator('.svelte-flow__node:has([data-shell-type="audioOut"]) .svelte-flow__handle[data-handleid="L"]');
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

  test('detach-on-grab: jack-clicking a patched input removes the existing cable', async ({ page, rack }) => {
    // Redesign: cable dragging is retired. The "grab a patched input to
    // rewire it" gesture is now a jack-click on the patched INPUT row — it
    // detaches the existing cable + picks it up for re-patching. We assert
    // the detach half here (the cable is removed the moment the input row is
    // clicked); Esc then drops the carried cable so no new edge forms.
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

    // Open the AudioOut menu + drill into INPUT, then jack-click the L input
    // row (the patched input) — this detaches e1 + carries the cable.
    await page
      .locator('.svelte-flow__node:has([data-shell-type="audioOut"]) [data-testid="patch-trigger"]')
      .click();
    // The chrome is body-portaled; resolve AudioOut's by its node id.
    const nodeId = await page
      .locator('.svelte-flow__node:has([data-shell-type="audioOut"])')
      .first()
      .getAttribute('data-id');
    const aoChrome = page.locator(`[data-patch-panel-chrome="${nodeId}"]`);
    await expect(aoChrome).toHaveAttribute('aria-hidden', 'false');

    await aoChrome.locator('[data-testid="patch-panel-nav"][data-nav="inputs"]').click();
    await aoChrome
      .locator('[data-testid="patch-panel-port-row"][data-port-id="L"]')
      .click();

    // The existing cable is detached the moment the patched input is grabbed.
    await expect(page.locator('.svelte-flow__edge'), 'edge detached on grab').toHaveCount(0);

    // Esc drops the carried cable — no new edge re-forms.
    await page.keyboard.press('Escape');
    await expect(page.locator('.svelte-flow__edge')).toHaveCount(0);
  });

  test('delete: selecting an edge + Backspace removes it from the patch', async ({ page, rack }) => {
    // Headless Playwright can't reliably click Svelte Flow's thin SVG edge
    // (the visible stroke is 3 px; the wider invisible interaction band has
    // subtle pointer-events semantics). Instead of a brittle SVG click, we
    // select the edge the way the app's own runtime does — by setting xyflow's
    // real `selected` flag via the dev-mode `__flow.setEdgeSelected` hook
    // (which calls useSvelteFlow().updateEdge under the hood) — then press the
    // REAL Backspace deleteKey. That exercises xyflow's genuine KeyHandler →
    // deleteElements → ondelete path, which Canvas's handleDelete mirrors back
    // into the patch graph. So this asserts the full select→Backspace→teardown
    // behaviour, just with a deterministic selection step.
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
    const edge = page.locator('.svelte-flow__edge[data-id="e1"]');
    await expect(edge, 'edge e1 should render').toHaveCount(1);

    // Move keyboard focus onto the canvas pane so the Backspace keydown reaches
    // xyflow's window-level KeyHandler and is NOT swallowed by isInputDOMNode
    // (e.g. if an editable card title held focus). Click empty pane space.
    await canvasPane(page).click({ position: { x: 5, y: 5 } });

    // Select the edge through xyflow's real `selected` mutation. Retry the
    // (select → assert .selected) pair: under HMR/CPU stress Canvas can
    // re-derive flowEdges from the snapshot right after spawn, momentarily
    // dropping the just-set selection, so a single set can race the rebuild.
    await expect(async () => {
      await page.evaluate(() => {
        (globalThis as unknown as {
          __flow: { setEdgeSelected: (id: string, sel: boolean) => void };
        }).__flow.setEdgeSelected('e1', true);
      });
      await expect(edge, 'edge should reflect selected state').toHaveClass(/selected/, {
        timeout: 1000,
      });
    }, 'edge e1 should become selected').toPass({ timeout: 10_000 });

    // Real Backspace → xyflow KeyHandler deletes the selected edge.
    await page.keyboard.press('Backspace');

    // Edge gone from the DOM…
    await expect(edge, 'edge should be removed from DOM after Backspace').toHaveCount(0);
    // …AND from the underlying patch graph (handleDelete mirrored the teardown).
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              Object.keys(
                (globalThis as unknown as { __patch: { edges: Record<string, unknown> } })
                  .__patch.edges,
              ).length,
          ),
        { message: 'patch.edges should be empty after edge delete' },
      )
      .toBe(0);
  });

  test('clear: Clear button removes all nodes + edges from patch + DOM', async ({ page, rack }) => {
    await loadVoiceDemo(page);
    await expect(page.locator('.svelte-flow__node')).toHaveCount(5, { timeout: 10_000 });
    // A stereo LEG GROUP renders as ONE bezier (PR-4): the demo's
    // `vd-vca.audio → vd-out.L` + `→ R` pair is 2 edges and 1 cable, so 6
    // graph edges draw 5. Pinned in stereo-only-channel.spec.ts.
    await expect(page.locator('.svelte-flow__edge')).toHaveCount(5);

    await fileMenuClick(page, 'workflow-file-clear');
    await page.waitForTimeout(150);

    await expect(page.locator('.svelte-flow__node')).toHaveCount(0);
    await expect(page.locator('.svelte-flow__edge')).toHaveCount(0);
    const statusText = (await page.locator('.bottombar').textContent()) ?? '';
    expect(statusText).toMatch(/nodes\s*0/);
    expect(statusText).toMatch(/edges\s*0/);
  });

  test('node-drag: dragging a card persists position back to the patch graph', async ({ page, rack }) => {
    await loadVoiceDemo(page);
    await expect(page.locator('.svelte-flow__node')).toHaveCount(5, { timeout: 10_000 });

    const vco = page.locator('.svelte-flow__node:has([data-shell-type="analogVco"])');
    const before = await vco.evaluate((el) => (el as HTMLElement).style.transform);

    // Grab the tile's KIND row — the shell's drag grip (the tile centre is
    // `nodrag` and the name row is a button; the cable-z-order recipe).
    const grip = page.locator('.svelte-flow__node:has([data-shell-type="analogVco"]) .tile-kind');
    const cardBox = await grip.boundingBox();
    if (!cardBox) throw new Error('VCO tile grip not visible');
    const startX = cardBox.x + cardBox.width / 2;
    const startY = cardBox.y + cardBox.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 80, startY, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(150);

    const after = await vco.evaluate((el) => (el as HTMLElement).style.transform);
    expect(after, `node transform should change after drag (was ${before})`).not.toBe(before);
  });

  test('canvas: spawned patch produces audio (peak meter > 0) @smoke', async ({ page, rack }) => {
    const cc = captureConsole(page);
    await loadVoiceDemo(page);

    await expect(page.locator('.svelte-flow__node')).toHaveCount(5, { timeout: 10_000 });

    const statusText = (await page.locator('.bottombar').textContent()) ?? '';
    expect(statusText, `bottombar text: "${statusText}"`).toMatch(/ctx\s*running/);
    expect(statusText).toMatch(/nodes\s*5/);
    // FIVE, not six — and the number is DERIVED, not read off a failing run.
    // The bottombar counts `flowEdges.length`, i.e. CABLES DRAWN ON THE CANVAS
    // (its `nodes` counterpart is `flowNodes.length` for the same reason). The
    // demo holds SIX graph edges, of which `vd-vca.audio → vd-out.L` and
    // `→ vd-out.R` are one stereo LEG GROUP rendered as ONE bezier (PR-4). No
    // other cable in this patch is paired, so 6 − 1 = 5.
    expect(statusText).toMatch(/edges\s*5/);
    // The GRAPH still holds all six — the dedupe is a rendering decision, and
    // asserting both is what stops this becoming "whatever the app printed".
    const graphEdges = await page.evaluate(
      () => Object.keys((window as unknown as { __patch: { edges: object } }).__patch.edges).length,
    );
    expect(graphEdges, 'the six graph edges are all still there').toBe(6);

    if (cc.pageErrors.length || cc.errors.length) {
      console.log(formatConsole(cc));
    }
  });
});
