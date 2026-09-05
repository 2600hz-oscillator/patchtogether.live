// e2e/tests/camera-input.spec.ts
//
// CAMERA module e2e — TWO describes, ONE file, split by load profile:
//
//   1. "deterministic render smoke" (UNTAGGED) — the GPU render path. This is
//      what the WebGL attest's Pass C runs (Pass C selects this file with a
//      `--grep-invert @camera-integration`, so only this describe attests).
//
//   2. "@camera-integration" (TAGGED) — the getUserMedia integration (device
//      enumeration, request flow, 'streaming' state, local-only hint,
//      'no-cameras-found'). The attest GREP-INVERTS this tag, so it runs ONLY in
//      the lighter functional (sharded) e2e lane, NOT in the cumulative-load
//      attest. (It stays in THIS file rather than a new file because the
//      chromium-camera project's testMatch is `camera-input.spec.ts`, so a new
//      file means editing playwright.config.ts — which is in the WEBGL attest
//      basis and costs a real-GPU re-attest. It used to cost a collab re-attest
//      too; that attest was deleted 2026-08-17.)
//
// WHY THE RENDER TEST IS DETERMINISTIC: the old render test depended on the LIVE
// getUserMedia → 'streaming' → rAF-render chain (three un-synchronized async
// clocks). It passed 10/10 in isolation but stalled past its 'streaming' timeout
// under Pass C's CUMULATIVE GPU load → 30s ceiling → "Target page has been
// closed", and the retries=1 backstop didn't recover it (the GPU-attest-rebuild
// flake). The render smoke now pins the engine clock + pauses its rAF loop and
// injects a DETERMINISTIC synthetic frame via the module's `__camerainputTestFrame`
// seam, then drives engine.step() a FIXED burst and reads CAMERA's own FBO once —
// no getUserMedia, no 'streaming', no rAF timing → bit-stable under any load.
//
// ⚠ `__camerainputTestFrame` BYPASSES THE UPLOAD, NOT THE GEOMETRY — so that
// claim was only ever true because the test out-ran the stream, and on
// 2026-08-11 it stopped out-running it. camera-input.ts's `draw()` picks its
// aspect-fit / cover-crop scale from the LIVE element
// (`videoEl?.videoWidth / videoEl?.videoHeight`, the `srcAspect` lines) even when
// the seam is supplying the pixels. A stream that reaches metadata BETWEEN the
// two bursts therefore re-scales the very frame this test asserts is frozen —
// identical texels, different sampling. The test now DENIES getUserMedia up
// front so no live element ever gets dimensions, and asserts that premise held
// (see the geometry guard below). That removes the race by construction instead
// of by winning it.
//
// The live getUserMedia → 'streaming' flow is inherently async/wall-clock and
// CANNOT be made bit-deterministic; it belongs in the light sharded lane (where
// it's always been stable), NOT in the GPU attest. Hence the tag split.
//
// Runs under the `chromium-camera` Playwright project (camera permission
// pre-granted) so the @camera-integration describe's auto-acquire succeeds
// quietly; the render smoke above opts back OUT of that stream deliberately.

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';
import { installRenderSmokeHooks, stepAndReadStats, assertRenderStats } from './_render-smoke';

const FIXED_STEPS = 6;

test.describe('CAMERA → OUTPUT (deterministic render smoke)', () => {
  test('injected frame renders through the camera pass to a non-black, frame-stable FBO', async ({ page, errorWatch }) => {
    test.setTimeout(60_000);

    // Pause the engine rAF loop (the test owns the exact frame count), pin the
    // clock, AND enable the deterministic camera frame — all BEFORE boot so the
    // very first draw uploads the synthetic frame.
    await installRenderSmokeHooks(page);
    await page.addInitScript(() => {
      (window as unknown as { __camerainputTestFrame?: boolean }).__camerainputTestFrame = true;
    });

    // DENY the live stream (see the header). The seam supplies the pixels, but
    // camera-input.ts still sizes the quad from the live element, so a stream
    // arriving mid-test re-scales the "frozen" frame. Measured on this project
    // before the deny: burst A at 0×0 (fallback aspect, no crop) vs burst B at
    // 640×360 (cover-crop) moved variance 4537.73 → 4813.35 — dVar 275.62 against
    // a 1.0 budget — while dMean was 0.14 and passed the mean gate untroubled.
    // Two bursts taken after the stream had settled differed by EXACTLY 0.0, so
    // the render itself is deterministic and the stream was the only variable.
    await page.addInitScript(() => {
      const md = navigator.mediaDevices;
      if (!md) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (md as any).getUserMedia = () =>
        Promise.reject(
          new DOMException('render-smoke: camera denied by design', 'NotAllowedError'),
        );
    });

    await page.goto('/rack?seed=none');
    await page.waitForLoadState('networkidle');

    await spawnPatch(
      page,
      [
        { id: 'v-cam', type: 'cameraInput', position: { x: 80, y: 60 }, domain: 'video' },
        { id: 'v-out', type: 'videoOut', position: { x: 480, y: 60 }, domain: 'video' },
      ],
      [
        {
          id: 'e-cam-out',
          from: { nodeId: 'v-cam', portId: 'out' },
          to: { nodeId: 'v-out', portId: 'in' },
          sourceType: 'video',
          targetType: 'video',
        },
      ],
    );

    await expect(page.locator('.svelte-flow__node:has([data-shell-type="cameraInput"])'), 'CAMERA visible').toBeVisible();
    await expect(page.locator('.svelte-flow__node:has([data-shell-type="videoOut"])'), 'OUTPUT visible').toBeVisible();

    // Drive a FIXED burst synchronously (no rAF, no waitForTimeout) so the
    // injected frame uploads + renders, then read CAMERA's OWN output texture.
    // The synthetic checker is dense + saturated → the DEFAULT non-black floor
    // (2%) and variance floor apply (no sparse override needed).
    const a = await stepAndReadStats(page, { nodeId: 'v-cam', steps: FIXED_STEPS });
    assertRenderStats(a, FIXED_STEPS);

    // DETERMINISM: a second independent burst (clock still frozen, frame fixed)
    // must produce a frame-stable result — same mean + variance to a tight
    // epsilon. A genuine black/flat regression still fails; driver pixel
    // divergence never trips it.
    const b = await stepAndReadStats(page, { nodeId: 'v-cam', steps: FIXED_STEPS });

    // GEOMETRY GUARD — the test's own premise, asserted on every run rather than
    // once at authoring time. The frame-stability asserts below can only mean
    // "the render is deterministic" if the synthetic frame was the ONLY thing
    // driving it; a live element with real dimensions silently changes the
    // cover-crop scale and shows up as an unattributable variance delta. Assert
    // the offenders directly so THAT regression names itself here instead.
    const geom = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __engine?: () => { getDomain: (d: string) => { read: (id: string, k: string) => unknown } } | null;
      };
      return {
        attached: w.__engine?.()?.getDomain('video')?.read('v-cam', 'hasVideoElement') ?? null,
        sized: Array.from(document.querySelectorAll('video'))
          .filter((v) => v.videoWidth > 0 || v.videoHeight > 0)
          .map((v) => `${v.videoWidth}x${v.videoHeight}`),
      };
    });
    expect(
      geom.sized,
      `no LIVE camera stream may drive the frozen render — the seam bypasses the upload, not the aspect-fit ` +
        `(hasVideoElement=${geom.attached}; sized elements: ${geom.sized.join(', ') || 'none'})`,
    ).toEqual([]);

    expect(b.framesDelta, 'second burst also advanced the exact frame count').toBe(FIXED_STEPS);
    expect(Math.abs(b.mean - a.mean), `frozen camera output is frame-stable (mean ${a.mean.toFixed(3)} vs ${b.mean.toFixed(3)})`).toBeLessThan(0.5);
    expect(Math.abs(b.variance - a.variance), `frozen camera output variance is frame-stable (var ${a.variance.toFixed(3)} vs ${b.variance.toFixed(3)})`).toBeLessThan(1.0);

  });
});

// The attest GREP-INVERTS "@camera-integration" (see scripts/webgl-attest.ts
// Pass C), so everything in this describe runs ONLY in the functional lane.
test.describe('CAMERA → OUTPUT (fake webcam) — getUserMedia integration @camera-integration', () => {
  test('enumerates the fake device, reaches streaming, and shows the local-only hint', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    await page.goto('/rack?seed=none');
    await page.waitForLoadState('networkidle');

    await spawnPatch(
      page,
      [
        { id: 'v-cam', type: 'cameraInput', position: { x: 80, y: 60 }, domain: 'video' },
        { id: 'v-out', type: 'videoOut', position: { x: 480, y: 60 }, domain: 'video' },
      ],
      [
        {
          id: 'e-cam-out',
          from: { nodeId: 'v-cam', portId: 'out' },
          to: { nodeId: 'v-out', portId: 'in' },
          sourceType: 'video',
          targetType: 'video',
        },
      ],
    );

    await expect(page.locator('.svelte-flow__node:has([data-shell-type="cameraInput"])'), 'CAMERA visible').toBeVisible();
    await expect(page.locator('.svelte-flow__node:has([data-shell-type="videoOut"])'), 'OUTPUT visible').toBeVisible();

    // The device dropdown should populate from enumerateDevices on mount.
    // With the fake-device flag, Chromium emits at least one virtual
    // 'videoinput' entry. Wait for it to land before clicking Request.
    const select = page.locator('[data-testid="cameraInput-tile-device-select"]');
    await expect(select).toBeVisible();
    // Give the async refreshDevices() a beat to populate options.
    await page.waitForFunction(() => {
      const el = document.querySelector(
        '[data-testid="cameraInput-tile-device-select"]',
      ) as HTMLSelectElement | null;
      return el ? el.options.length > 0 : false;
    }, undefined, { timeout: 5_000 });

    // Under Chromium's --use-fake-ui-for-media-stream + camera permission
    // pre-granted (project-level), the card's onMount auto-acquire fires
    // because labels are visible immediately and node.params.enabled is 1
    // by default. So the state machine may already be 'streaming' before
    // we get here, OR still 'idle'. Handle both: click Request Access if
    // visible, then wait for streaming. (If it's not visible, we're
    // already in streaming/paused/etc.)
    const requestBtn = page.locator('[data-testid="cameraInput-tile-request-access"]');
    // Only click when the button is actually ENABLED. On a fast machine the
    // onMount auto-acquire has often already fired by the time we get here, so
    // the button is rendered DISABLED and about to detach (it swaps to
    // Pause/Resume) — a force-click then races the detach and hangs the full
    // 30s ("element was detached from the DOM, retrying"). A disabled button
    // means streaming is already on its way, so skip the click and fall through
    // to the streaming wait. The .catch() covers the residual detach-mid-click
    // race when the button WAS enabled at check time.
    if (
      (await requestBtn.count()) > 0 &&
      (await requestBtn.isVisible().catch(() => false)) &&
      (await requestBtn.isEnabled().catch(() => false))
    ) {
      await requestBtn.click({ noWaitAfter: true }).catch(() => {
        /* auto-acquire detached the button — streaming is already starting */
      });
    }

    // Wait for the state machine to reach 'streaming' — on the shell the
    // observable is the tile lamp's data-lamp ('streaming' is 1:1 with the
    // card's old raw state string).
    const status = page.locator('[data-testid="cameraInput-tile-lamp"]');
    await expect(status).toHaveAttribute('data-lamp', 'streaming', {
      timeout: 10_000,
    });

    // Local-only hint must be visible while streaming. The CAMERA stream
    // is not multiplayer-streamed (deferred to a future phase); the in-card text keeps
    // user expectations honest.
    await page.evaluate(() => (globalThis as unknown as { __openDockFullView: (id: string) => void }).__openDockFullView('v-cam'));
    const localOnlyHint = page.locator('[data-testid="cameraInput-face-local-only"]');
    await expect(localOnlyHint, 'local-only hint visible while streaming').toBeVisible();
    await expect(localOnlyHint).toContainText(/local only/i);
    await expect(localOnlyHint).toContainText(/won't see/i);

    expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
  });

  test('recovers from "no-cameras-found": picking an available camera starts the stream', async ({ page, errorWatch }) => {
    // Reproduce the reported bug: load a patch whose saved camera is gone (or on
    // a different machine), land in 'no-cameras-found' — then switch to an
    // AVAILABLE camera and confirm the stream actually starts (it used to stay
    // stuck because the re-acquire guard omitted 'no-cameras-found').
    //
    // Deterministic, no reliance on a bogus exact-deviceId: stub getUserMedia to
    // reject (OverconstrainedError — exactly what a missing saved device throws)
    // while a window flag is set, then flip the flag and let the real Chromium
    // fake device satisfy the pick.

    await page.addInitScript(() => {
      const md = navigator.mediaDevices;
      if (!md) return;
      (window as unknown as { __camFailRequest?: boolean }).__camFailRequest = true;
      const orig = md.getUserMedia.bind(md);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (md as any).getUserMedia = (constraints: MediaStreamConstraints) => {
        if ((window as unknown as { __camFailRequest?: boolean }).__camFailRequest) {
          return Promise.reject(
            new DOMException('saved camera not present', 'OverconstrainedError'),
          );
        }
        return orig(constraints);
      };
    });

    await page.goto('/rack?seed=none');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'v-cam', type: 'cameraInput', position: { x: 80, y: 60 }, domain: 'video' },
    ]);

    await expect(page.locator('.svelte-flow__node:has([data-shell-type="cameraInput"])'), 'CAMERA visible').toBeVisible();

    // The mount auto-acquire hit the stubbed reject → stuck in 'no-cameras-found'
    // (the screenshot state). The dropdown still lists the available camera(s).
    // 'no-cameras-found' folds into the lamp's ERROR bucket on the shell;
    // 'streaming' below is the unambiguous recovery observable.
    const status = page.locator('[data-testid="cameraInput-tile-lamp"]');
    await expect(status).toHaveAttribute('data-lamp', 'error', { timeout: 10_000 });

    const select = page.locator('[data-testid="cameraInput-tile-device-select"]');
    await page.waitForFunction(
      () => {
        const el = document.querySelector(
          '[data-testid="cameraInput-tile-device-select"]',
        ) as HTMLSelectElement | null;
        // At least one real (enabled, non-empty-value) camera option to pick.
        return !!el && Array.from(el.options).some((o) => !o.disabled && o.value !== '');
      },
      undefined,
      { timeout: 5_000 },
    );

    // Stop failing requests — the device is "available" again from here on.
    await page.evaluate(() => {
      (window as unknown as { __camFailRequest?: boolean }).__camFailRequest = false;
    });

    // Switch to the first available camera. This is the action that used to do
    // nothing; it must now (re)acquire and reach 'streaming'.
    const firstRealValue = await select.evaluate((el) => {
      const sel = el as HTMLSelectElement;
      const opt = Array.from(sel.options).find((o) => !o.disabled && o.value !== '');
      return opt ? opt.value : '';
    });
    expect(firstRealValue, 'an available camera to switch to').not.toBe('');
    await select.selectOption(firstRealValue);

    await expect(status, 'switching to an available camera starts the stream').toHaveAttribute(
      'data-lamp',
      'streaming',
      { timeout: 10_000 },
    );

  });

  test('shows "no cameras" if enumerateDevices returns empty', async ({ page }) => {
    // Override navigator.mediaDevices.enumerateDevices BEFORE any module
    // mounts so the CAMERA card sees an empty device list. Verifies the
    // 'no-cameras-found' state is reachable from the UI without us
    // having to disable the fake-camera flag at the browser level.
    await page.addInitScript(() => {
      const md = navigator.mediaDevices;
      if (!md) return;
      const orig = md.enumerateDevices.bind(md);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (md as any).enumerateDevices = async () => {
        const all = await orig();
        // Strip videoinput entries to simulate no camera.
        return all.filter((d) => d.kind !== 'videoinput');
      };
    });

    await page.goto('/rack?seed=none');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'v-cam', type: 'cameraInput', position: { x: 80, y: 60 }, domain: 'video' },
    ]);

    const status = page.locator('[data-testid="cameraInput-tile-lamp"]');
    await expect(status).toHaveAttribute('data-lamp', 'error', {
      timeout: 5_000,
    });
    // …and the picker itself says why: zero devices disables it.
    await expect(
      page.locator('[data-testid="cameraInput-tile-device-select"]'),
    ).toBeDisabled();
  });

  // THE OWNER P0 (`/rack`: "camera → output renders
  // nothing"). The camera's SOURCE lives on its card: CameraInputCard owns
  // getUserMedia + the <video> element and hands it to the engine handle via
  // `attachExternalSource` (and DETACHES it on unmount). Under the shell preview
  // the lane rendered a uniform tile INSTEAD of the card, so the attach never
  // ran: the engine node existed, the cable existed, and the OUTPUT was black.
  //
  // cameraInput is now a NON_SHELL_LANE_TYPE ($lib/ui/workflow/legacy-fallback)
  // — its real card renders in the lane exactly like videoOut's, which also
  // keeps the device <select> (card-only DOM, not a ParamDef) usable in the new
  // view. This test is the end-to-end pin: SAME rack, shell ON, real
  // getUserMedia → the OUTPUT surface paints MOVING pixels.
  //
  // Lives HERE because only this file's `chromium-camera` project has the fake
  // webcam + pre-granted permission (playwright.config.ts is in the collab
  // attest basis — adding a project for one test would force a re-attest).
  // Renderer-tolerant: canvas INEQUALITY between two frames, never exact pixels.
  test('under the default shell NO camera card is mounted, the picker lives on the faceplate, and camera → OUTPUT paints moving pixels', async ({ page }) => {
    test.setTimeout(90_000);

    await page.goto('/rack');
    await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 15_000 });

    await spawnPatch(
      page,
      [
        { id: 'v-cam', type: 'cameraInput', position: { x: 80, y: 60 }, domain: 'video', params: { enabled: 1 } },
        { id: 'v-out', type: 'videoOut', position: { x: 480, y: 60 }, domain: 'video' },
      ],
      [
        {
          id: 'e-cam-out',
          from: { nodeId: 'v-cam', portId: 'out' },
          to: { nodeId: 'v-out', portId: 'in' },
          sourceType: 'video',
          targetType: 'video',
        },
      ],
    );

    // ⚠ THE CARVE-OUT IS GONE, AND THIS BLOCK USED TO ASSERT IT. It read:
    //
    //   // The CARVE-OUT: the real card in the lane, never the uniform tile…
    //   const camLane = page.locator('.svelte-flow__node[data-id="v-cam"]');
    //   await expect(camLane.locator('…module-shell-placeholder')).toHaveCount(0);
    //   // …so the DEVICE PICKER is reachable + lists the fake device.
    //   const select = camLane.locator('[data-testid="cameraInput-tile-device-select"]');
    //   await expect(select, 'device picker usable in the shell lane').toBeVisible();
    //
    // ⚠ AND IT KEPT PASSING AFTER THE PROMOTION MADE IT FALSE — this file did
    // not go red, which is why it is being corrected deliberately rather than by
    // following a failure. Both legs went green-and-blind for reasons the
    // assertions cannot show:
    //   * the placeholder leg still passes, but for a NEW reason — the lane is a
    //     `module-shell` FACE now, not the real card the carve-out gave it;
    //   * `<HeadlessSourceHost>` mounts the real card in its OWN single-node
    //     `<SvelteFlow>`, so `.svelte-flow__node[data-id="v-cam"]` matches TWO
    //     elements and `camLane.locator(...)` resolved through the hosted copy —
    //     which sits at `left:-9999px` inside a `pointer-events: none` subtree,
    //     and Playwright's `toBeVisible` is satisfied by exactly that.
    // Measured on the sibling case: the only picker in the document had
    // `rect.left = -9976`. See `workflow-shell-video.spec.ts`, which carries the
    // full measurement and now owns the reachability claim generally.
    //
    // What replaces it asserts the promotion's ACTUAL shape, and the
    // real-webcam legs below are unchanged — this project is the only one with
    // a fake device, so it stays the home of "the picker lists a REAL camera".
    const camLane = page.locator('.svelte-flow__node[data-id="v-cam"]');
    await expect(
      camLane.locator('[data-testid="module-shell"]').first(),
      'the promoted CAMERA paints a faceplate tile in the lane',
    ).toBeVisible({ timeout: 15_000 });

    // ⚠ NO CARD IS MOUNTED ANYWHERE, AND THAT IS THE SECOND CORRECTION THIS
    // BLOCK HAS TAKEN (legacy-removal S1, 2026-09-03). The paragraph above
    // records the promotion moving the card OFF the lane and into
    // `<HeadlessSourceHost>`; the extraction moves getUserMedia, the device
    // roster and the permission machine OFF the card entirely, to
    // `$lib/ui/media/node-camera-source-registry` on graph lifetime. So there is
    // no host and no card, and this is the ONLY project with a fake webcam —
    // which makes this leg the strongest evidence anywhere that the controller's
    // auto-acquire works against real hardware plumbing rather than a stub.
    const camHost = page.locator('[data-testid="headless-source-host"][data-node-id="v-cam"]');
    await expect(camHost, 'cameraInput has no headless host — the controller owns the source')
      .toHaveCount(0);
    await expect(
      page.locator('[data-testid="camera-status"]'),
      'and no CameraInputCard is mounted anywhere either',
    ).toHaveCount(0);

    // The DEVICE PICKER is reachable where it now lives — the faceplate — and
    // it lists the fake device. Opened and closed again so the OUTPUT poll below
    // measures the lane, exactly as it did before.
    await page.evaluate(() => {
      (globalThis as unknown as { __openDockFullView: (i: string) => void }).__openDockFullView('v-cam');
    });
    const dock = page.locator('[data-testid="dock-full-view"]');
    await expect(dock).toHaveCount(1, { timeout: 20_000 });
    // ⚠ THE STREAMING ASSERTION MOVED HERE FROM THE HOSTED CARD, and it is the
    // same claim read off the surviving surface: a REAL getUserMedia stream
    // reached `streaming` with nothing mounted when it was acquired. The
    // controller had already auto-acquired before this dock was opened — the
    // dock is where the state is now VISIBLE, not where it is produced.
    await expect(
      dock.locator('[data-testid="cameraInput-face-lamp"]'),
      'the controller reached streaming with a REAL getUserMedia stream',
    ).toHaveAttribute('data-lamp', 'streaming', { timeout: 20_000 });
    const select = dock.locator('[data-testid="cameraInput-face-device-select"]');
    // ⚠ THIS LINE IS THE ONE THAT WAS GREEN WHILE DEV WAS BROKEN — kept, and
    // no longer the whole claim. See the ON-SCREEN describe at the end of this
    // file for what `toBeVisible()` cannot see and what replaces it.
    await expect(select, 'device picker usable on the faceplate').toBeVisible({ timeout: 15_000 });
    await page.waitForFunction(
      () => {
        const el = document.querySelector(
          '[data-testid="dock-full-view"] [data-testid="cameraInput-face-device-select"]',
        ) as HTMLSelectElement | null;
        return el ? el.options.length > 0 : false;
      },
      undefined,
      { timeout: 10_000 },
    );
    await expect(select).toBeEnabled();
    await page.getByTestId('faceplate-collapse').click();
    await expect(dock).toHaveCount(0, { timeout: 20_000 });

    // …and the OUTPUT surface paints MOVING pixels (the fake device's animated
    // pattern). Pre-fix this canvas stayed black — "no video at all".
    //
    // ⚠ THE OUTPUT SURFACE IS THE FACE TILE'S LIVE THUMB NOW, not the legacy
    // card's canvas (#1821). This selector was
    // `[data-testid="video-out-canvas"]`, which exists only on `VideoOutCard` —
    // and videoOut left `NON_SHELL_LANE_TYPES` when it was promoted, so under
    // the DEFAULT shell this rack renders a `ModuleShell` tile whose glyph slot
    // is the live `VideoTileThumb`. The old selector matched nothing and the
    // assertion failed `element(s) not found`.
    //
    // ⚠ THE TEST'S SUBJECT IS UNCHANGED and this is not a loosened locator: the
    // camera-side assertions above (the carve-out, the device picker, the
    // streaming state) are untouched and still pass — cameraInput is still
    // carved out — and the pixel-inequality poll below still proves
    // camera → OUTPUT paints. Only the element that IS the output surface moved.
    const outSel = '.svelte-flow__node[data-id="v-out"] [data-testid="module-shell"] canvas';
    await expect(page.locator(outSel)).toBeVisible({ timeout: 15_000 });
    const snap = async () =>
      page.evaluate((sel) => {
        const c = document.querySelector(sel) as HTMLCanvasElement | null;
        return c ? c.toDataURL() : '';
      }, outSel);
    const first = await snap();
    expect(first, 'OUTPUT canvas snapshot captured').not.toBe('');
    await expect
      .poll(async () => (await snap()) !== first, {
        message: 'camera → OUTPUT paints changing pixels under ?shell=1',
        timeout: 25_000,
      })
      .toBe(true);
  });
});

// The NODE-OWNED MEDIA LIFETIME guard for cameraInput (owner P0 2026-08-12:
// "videovarispeed stops playing if its card is collapsed … fix it in all
// places for all video chains").
//
// cameraInput is the WORST case of that bug class and the one a user could not
// recover from. Its card used to call `stream.getTracks().forEach(t => t.stop())`
// in `onDestroy`, and a stopped capture track cannot be restarted without a
// fresh permission gesture — so any card MOVE killed the camera for good rather
// than merely pausing it. The <video> and the MediaStream now belong to the
// NODE ($lib/ui/media/node-media-registry) and outlive the card.
//
// cameraInput keeps its real card in the LANE (a NON_SHELL carve-out), so
// expanding it mounts a SECOND real card in the dock rather than moving the
// one that exists. That makes it the best available real-app exercise of the
// double-mount invariant: exactly one element per node, and an owner-checked
// release so the mount that tears down last cannot strand the survivor.
//
// It lives in THIS FILE for the reason the sibling shell test documents: only
// `chromium-camera` carries the fake webcam + pre-granted permission, and
// playwright.config.ts is in the WEBGL attest basis, so adding a project for one
// test forces a real-GPU re-attest. (It was in the collab basis too, until that
// attest was deleted 2026-08-17.)
test.describe('CAMERA node-owned media lifetime @camera-integration', () => {
  test('a card move (expand + collapse) does NOT stop the capture', async ({ page }) => {
    test.setTimeout(90_000);

    await page.goto('/rack');
    await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 15_000 });

    await spawnPatch(page, [
      { id: 'v-cam', type: 'cameraInput', position: { x: 80, y: 60 }, domain: 'video', params: { enabled: 1 } },
    ]);

    // ⚠ READINESS IS READ OFF THE ELEMENT, NOT OFF A CARD (legacy-removal S1).
    // This used to wait on the lane card's `camera-status`, which existed
    // because `cameraInput` was carved out of the shell swap and later because
    // the headless host kept a card mounted. Neither is true now: the
    // controller owns getUserMedia on graph lifetime, so the FIRST observable
    // of a live capture is the node-owned element's own track — which is also
    // the thing this test is actually about.
    const camLane = page.locator('.svelte-flow__node[data-id="v-cam"]');
    await expect(camLane.locator('[data-testid="module-shell"]').first())
      .toBeVisible({ timeout: 15_000 });

    /** Liveness of the node's capture, read from the DOM wherever the element
     *  currently lives. `track.readyState` is the decisive signal: 'ended' is
     *  precisely what `t.stop()` produces and is NOT recoverable. */
    /**
     * Wait until the capture is live again, IN-PAGE, then return the state.
     *
     * #1559: reading `captureState()` the instant the dock appears is a race.
     * The element is RE-PARENTED across the card move, and its `srcObject`
     * re-attaches asynchronously — so the read can land in the gap and report
     * `{present: true, count: 1, tracks: []}`: the element exists, in the right
     * place, with no stream yet. That signature reddened a REQUIRED lane across
     * four separate PRs, none of which touched camera code.
     *
     * Waiting on the OBSERVABLE (a track in `srcObject`) rather than on wall
     * clock keeps this renderer-independent, and it does not weaken the
     * assertion: if the stream never comes back, this times out and the test
     * still fails — which is the real defect it is there to catch. What it
     * stops reporting is "not yet", which was never the question.
     */
    const waitForLiveCapture = async () => {
      await page
        .waitForFunction(
          () => {
            const v = document.querySelector('[data-testid="camera-preview"]') as HTMLVideoElement | null;
            const s = v?.srcObject as MediaStream | null;
            return !!s && s.getVideoTracks().some((t) => t.readyState === 'live');
          },
          undefined,
          { timeout: 15_000 },
        )
        // Swallow the timeout so the ASSERTION below reports the real state
        // (which tracks, which readyState, where the element is) instead of a
        // bare Playwright timeout that says nothing about why.
        .catch(() => {});
      return captureState();
    };

    const captureState = async () =>
      page.evaluate(() => {
        const all = [...document.querySelectorAll('[data-testid="camera-preview"]')];
        const v = all[0] as HTMLVideoElement | undefined;
        if (!v) return { present: false, count: 0, tracks: [] as string[], where: 'absent' };
        const s = v.srcObject as MediaStream | null;
        return {
          present: true,
          // ONE element per node is a registry invariant, not an accident —
          // assert it here where a real double-mount actually happens.
          count: all.length,
          tracks: s ? s.getVideoTracks().map((t) => t.readyState) : [],
          // ⚠ THE `host` BRANCH IS NEW AND IS NOT COSMETIC. Before the
          // promotion this element could only be in the dock, in parking, or in
          // the lane; a promoted cameraInput's real card lives in
          // <HeadlessSourceHost>, which is none of those and used to report as
          // 'lane'. A label that cannot name where the thing actually is makes
          // the assertions below unable to state what they mean.
          where: v.closest('[data-testid="dock-full-view"]')
            ? 'dock'
            : v.closest('[data-testid="headless-source-host"]')
              ? 'host'
              : v.closest('[data-testid="node-media-parking"]')
                ? 'parking'
                : 'lane',
        };
      });

    const before = await waitForLiveCapture();
    expect(before.present, 'the camera element exists before the move').toBe(true);
    expect(
      before.where,
      `with no card mounted the node-owned element is PARKED — 'absent' would mean the `
        + `controller never ensured it: ${JSON.stringify(before)}`,
    ).toBe('parking');
    expect(before.tracks, `a live capture track before the move: ${JSON.stringify(before)}`)
      .toEqual(['live']);

    // EXPAND.
    //
    // ⚠ THIS USED TO BE A DOUBLE-MOUNT EXERCISE AND IS NOT ANY MORE. The note
    // here read: "for a NON_SHELL type the lane KEEPS its real card and the dock
    // full-view mounts a SECOND one … the real-app exercise of the registry's
    // transfer + owner-checked release". That was true while cameraInput was
    // carved out of the shell swap. It is promoted now, so the lane paints a
    // faceplate, the dock paints a faceplate, and the real card sits in
    // <HeadlessSourceHost> throughout — one mount, not two.
    //
    // ⚠ SO THE CASE CHANGED SUBJECT RATHER THAN LOSING ONE, and the new subject
    // is sharper. `DockFullView` renders `{#if migrated} <ModuleShell/> {:else}
    // <CardComponent/>`, so for a promoted module the tray mounts NO card —
    // which means Canvas's headless-host derivation must keep hosting this node
    // WHILE its faceplate is open. It very nearly did not: that exclusion was an
    // unconditional "skip every full-view node", written when no card-owned
    // source had ever been promoted, and it is now conditioned on `migrated`
    // (`fullViewShowsFaceInstead`). If that condition regresses, the card
    // unmounts on expand and its <video> is released to PARKING — which is
    // exactly what `where` below now distinguishes, and why the `host` label had
    // to exist for this assertion to be sayable at all.
    //
    // The registry invariant it used to prove (ONE element per node, owner-
    // checked release) is still asserted here and is still real; what changed is
    // that the second mount it was defending against no longer occurs on THIS
    // module. `videobox`/`videovarispeed` still exercise the two-mount path in
    // `collapse-keeps-playing.spec.ts`.
    await page.evaluate(() => {
      (globalThis as unknown as { __openDockFullView: (i: string) => void })
        .__openDockFullView('v-cam');
    });
    await expect(page.locator('[data-testid="dock-full-view"]')).toHaveCount(1, { timeout: 20_000 });

    const expanded = await waitForLiveCapture();
    expect(expanded.present, `the element still exists while expanded: ${JSON.stringify(expanded)}`)
      .toBe(true);
    expect(expanded.count, 'never two <video> elements for one node').toBe(1);
    expect(expanded.tracks, `capture still live while expanded: ${JSON.stringify(expanded)}`)
      .toEqual(['live']);
    // ⚠ THE GUARD FOR THE FULL-VIEW EXCLUSION, AND IT IS THE ONLY LEG THAT CAN
    // SEE THAT REGRESSION — measured, not argued. Reverting
    // `fullViewShowsFaceInstead` to a constant `false` in Canvas (i.e. restoring
    // the unconditional "skip every full-view node") and re-running this test
    // reports:
    //
    //   {"present":true,"count":1,"tracks":["live"],"where":"parking"}
    //
    // The capture is STILL LIVE and there is STILL exactly one element — so
    // `tracks` and `count`, the two assertions directly above, both pass on the
    // broken tree. They are structurally blind to it, because the element is
    // node-owned and the registry saves the stream whether or not any card is
    // mounted. `where` is what separates "hosted" from "rescued by the
    // registry", and 'parking' is the signature of the card having been
    // unmounted from every surface at once.
    // ⚠ THIS LEG'S SUBJECT LEFT THIS MODULE (legacy-removal S1) AND IS NOT LOST,
    // which is the only reason it is safe to invert rather than delete. It read
    // `.toBe('host')`, and the paragraph above records what it was measuring:
    // reverting Canvas's `fullViewShowsFaceInstead` to a constant `false` made
    // the card unmount on expand and the element fall back to PARKING, with
    // `tracks` and `count` both still green — `where` was the only reading that
    // could see it.
    //
    // cameraInput cannot exercise that any more, because it has no card to host
    // and 'parking' is now its correct resting state in every phase. The
    // regression is still real for the modules that DO still get a headless
    // host, and it is still covered: `face-archivist.spec.ts` asserts it for the
    // surviving DOM-source member, and `card-producer-lifetime.spec.ts` asserts
    // it for the whole CARD_PRODUCER half through `keepsHeadlessWhileDocked`.
    // What this leg keeps is the weaker but still-real claim that opening the
    // dock does not lose the element.
    expect(
      expanded.where,
      `the node-owned element must survive the dock opening — 'absent' means it was destroyed: `
        + `${JSON.stringify(expanded)}`,
    ).toBe('parking');

    // COLLAPSE — the dock mount goes away. Pre-fix, that unmount stopped the
    // tracks and the camera was gone for good.
    await page.getByTestId('faceplate-collapse').click();
    await expect(page.locator('[data-testid="dock-full-view"]')).toHaveCount(0, { timeout: 20_000 });

    // Same re-parent race as the expand above — the element moves back out of
    // the dock and re-attaches its stream asynchronously. This side has not
    // been observed failing, but it is the identical shape, and fixing only the
    // half that happened to go red would leave the other half to surface later
    // as a "new" flake.
    const after = await waitForLiveCapture();
    expect(after.present, `the element must survive the card move: ${JSON.stringify(after)}`).toBe(true);
    expect(after.count, 'still exactly one element after collapse').toBe(1);
    expect(after.tracks, `the capture track must still be LIVE after collapse: ${JSON.stringify(after)}`)
      .toEqual(['live']);
    expect(after.where, `and still the parked node-owned element: ${JSON.stringify(after)}`)
      .toBe('parking');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// THE CONTROLS ARE ON SCREEN — the 2026-09-03 owner P0, and the reason the
// assertion above could not see it. @camera-integration
//
// OWNER REPORT: the CAMERAINPUT dock faceplate showed the band headed SOURCES
// and the live preview, and *"no device dropdown and no capture lamp"*.
//
// ⚠ WHY THE SHIPPED ASSERTION WAS GREEN, WHICH IS THE FINDING RATHER THAN THE
// FIX. Fifteen lines up this file already does
// `await expect(select, 'device picker usable on the faceplate').toBeVisible()`
// against this exact testid, in this exact host, and it passed on every run
// while the owner could not reach the control. Playwright's `toBeVisible()` is
// `display`/`visibility`/`opacity` plus a non-empty bounding box. It has NO
// viewport requirement and NO scroll-position requirement: an element at
// document y=789 in a 720 px window is "visible" to it, and so is one 138 px
// below the bottom of the scroll container it lives in. (`.click()` would have
// auto-scrolled and passed too, for the same reason — the auto-scroll is the
// thing that hides it.)
//
// MEASURED on `origin/main` at Playwright's own `Desktop Chrome` viewport
// (1280×720 — the configuration this file already runs in):
//   .dock-faceplate   max-height min(60vh,680px) → 424 px, correctly bounded
//   .faceplate-scroll clientH 352, scrollH 648    → 296 px below the fold
//   .camera-output    a FIXED 480×360 canvas, then the local-only hint, then
//                     the picker row LAST → picker at y≈789, window is 720
// Nothing was clipped, nothing threw, no chunk failed to load. The controls
// were simply rendered past the bottom of the surface that carries them.
//
// SO THE ASSERTION IS THE PRODUCT'S OWN QUESTION, NOT THE DOM'S: is the control
// inside the viewport, inside the visible box of every scrolling ancestor, and
// does a hit test at its centre land on the control itself? That is what a
// player means by "the dropdown is there", and it is the smallest predicate
// that could have gone red.
//
// ⚠ AND IT CARRIES ITS OWN POSITIVE CONTROL, in-test, against the REAL
// pre-fix DOM: the case re-appends the picker row to the end of `.camera-output`
// — byte-for-byte the order this body shipped with — and asserts the SAME
// predicate reports it off-screen, then restores it. A gate that cannot be made
// to fail on the defect it names is a gate nobody has tested.

/** Where a control actually is, as a player would judge it. */
async function onScreenReport(page: import('@playwright/test').Page, testid: string) {
  return page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
    if (!el) return { present: false as const };
    const b = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Every scrolling/clipping ancestor must also SHOW it — a control below the
    // fold of an inner scroller is exactly as unreachable as one below the
    // window, and it is the case the owner hit.
    let clippedBy: string | null = null;
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (!/(auto|scroll|hidden)/.test(cs.overflowY) && !/(auto|scroll|hidden)/.test(cs.overflowX)) continue;
      const pb = p.getBoundingClientRect();
      if (b.bottom > pb.bottom + 0.5 || b.top < pb.top - 0.5 || b.right > pb.right + 0.5 || b.left < pb.left - 0.5) {
        clippedBy = p.getAttribute('data-testid') ?? p.className?.toString().slice(0, 48) ?? p.tagName;
        break;
      }
    }
    const cx = b.left + b.width / 2;
    const cy = b.top + b.height / 2;
    const inViewport = b.top >= 0 && b.left >= 0 && b.bottom <= vh && b.right <= vw && b.width > 0 && b.height > 0;
    const hit = inViewport ? document.elementFromPoint(cx, cy) : null;
    return {
      present: true as const,
      rect: { top: Math.round(b.top), bottom: Math.round(b.bottom) },
      viewport: { w: vw, h: vh },
      inViewport,
      clippedBy,
      hitsItself: !!hit && (hit === el || el.contains(hit)),
    };
  }, testid);
}

test.describe('CAMERA faceplate — the SOURCE controls are ON SCREEN @camera-integration', () => {
  test('the dock faceplate paints the picker, the lamp and ACQUIRE inside the surface a player is looking at', async ({
    page,
    errorWatch,
  }) => {
    test.setTimeout(90_000);

    await page.goto('/rack');
    await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 15_000 });
    await spawnPatch(page, [
      { id: 'v-cam', type: 'cameraInput', position: { x: 80, y: 60 }, domain: 'video', params: { enabled: 1 } },
    ]);

    // ── THE LANE TILE FIRST — the surface a player normally MEETS the module
    //    on, and the one nothing in this repo asserted before today. #2242 put
    //    the picker here precisely because the dock-only version was the first
    //    occurrence of this bug class; there was no gate on it.
    const laneShell = page.locator('.svelte-flow__node[data-id="v-cam"] [data-testid="module-shell"]').first();
    await expect(laneShell, 'the promoted CAMERA paints a faceplate tile').toBeVisible({ timeout: 15_000 });
    for (const id of ['cameraInput-tile-lamp', 'cameraInput-tile-device-select', 'cameraInput-tile-request-access']) {
      const r = await onScreenReport(page, id);
      expect(r.present, `${id} must exist on the lane tile`).toBe(true);
      expect(r, `${id} must be inside the lane tile a player is looking at`).toMatchObject({
        inViewport: true,
        clippedBy: null,
      });
    }

    // ── THE DOCK FACEPLATE — the owner's screenshot.
    await page.evaluate(() => {
      (globalThis as unknown as { __openDockFullView: (i: string) => void }).__openDockFullView('v-cam');
    });
    await expect(page.locator('[data-testid="dock-full-view"]')).toHaveCount(1, { timeout: 20_000 });
    await expect(page.getByTestId('cameraInput-output-body')).toBeVisible({ timeout: 15_000 });

    for (const id of ['cameraInput-face-lamp', 'cameraInput-face-device-select', 'cameraInput-face-request-access']) {
      const r = await onScreenReport(page, id);
      expect(r.present, `${id} must exist on the dock faceplate`).toBe(true);
      expect(
        r,
        `${id} must be ON SCREEN on the dock faceplate — this is the owner P0, and `
          + `toBeVisible() passes for all three of "below the window", "below an inner `
          + `scroller's fold" and "under the footer"`,
      ).toMatchObject({ inViewport: true, clippedBy: null, hitsItself: true });
    }

    // ── POSITIVE CONTROL: rebuild the pre-fix DOM and prove this goes RED ──
    //
    // `.picker-row` back at the END of `.camera-output`, after the fixed 480×360
    // canvas and the local-only hint — the exact order the body shipped with
    // until this PR. If the assertions above can pass in that arrangement, they
    // are not measuring what they claim to.
    const moved = await page.evaluate(() => {
      const body = document.querySelector('[data-testid="cameraInput-output-body"]');
      const row = document.querySelector('[data-testid="cameraInput-face-device-select"]')?.parentElement;
      if (!body || !row || row.parentElement !== body) return false;
      body.appendChild(row); // re-append = move to last child
      return body.lastElementChild === row;
    });
    expect(moved, 'the positive control must actually rebuild the pre-fix order').toBe(true);

    const control = await onScreenReport(page, 'cameraInput-face-device-select');
    expect(control.present).toBe(true);
    // The instrument the OLD assertion used still says "visible" in this exact
    // arrangement — asserted, so the finding is pinned rather than narrated.
    await expect(
      page.locator('[data-testid="dock-full-view"] [data-testid="cameraInput-face-device-select"]'),
      'toBeVisible() cannot see this defect — that is why it shipped',
    ).toBeVisible();
    expect(
      control.present && (!control.inViewport || control.clippedBy !== null || !control.hitsItself),
      `the pre-fix order must FAIL the on-screen check, else this gate is decorative `
        + `(got ${JSON.stringify(control)})`,
    ).toBe(true);

    // Restore, and re-assert — so a later reader can see the check is not
    // one-way and the page is left in the shipped state.
    await page.evaluate(() => {
      const body = document.querySelector('[data-testid="cameraInput-output-body"]');
      const row = document.querySelector('[data-testid="cameraInput-face-device-select"]')?.parentElement;
      if (body && row) body.insertBefore(row, body.firstElementChild);
    });
    const restored = await onScreenReport(page, 'cameraInput-face-device-select');
    expect(restored).toMatchObject({ inViewport: true, clippedBy: null, hitsItself: true });

    errorWatch.assertClean();
  });
});
