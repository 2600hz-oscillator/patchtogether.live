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
//      attest. (It must stay in THIS file rather than a new file because the
//      chromium-camera project's testMatch is `camera-input.spec.ts` and adding
//      a new file there would edit playwright.config.ts — which is in the collab
//      attest basis, forcing an unrelated collab re-attest.)
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

    await page.goto('/rack?shell=legacy&seed=none');
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

    await expect(page.locator('.svelte-flow__node-cameraInput'), 'CAMERA visible').toBeVisible();
    await expect(page.locator('.svelte-flow__node-videoOut'), 'OUTPUT visible').toBeVisible();

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

    await page.goto('/rack?shell=legacy&seed=none');
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

    await expect(page.locator('.svelte-flow__node-cameraInput'), 'CAMERA visible').toBeVisible();
    await expect(page.locator('.svelte-flow__node-videoOut'), 'OUTPUT visible').toBeVisible();

    // The device dropdown should populate from enumerateDevices on mount.
    // With the fake-device flag, Chromium emits at least one virtual
    // 'videoinput' entry. Wait for it to land before clicking Request.
    const select = page.locator('[data-testid="camera-device-select"]');
    await expect(select).toBeVisible();
    // Give the async refreshDevices() a beat to populate options.
    await page.waitForFunction(() => {
      const el = document.querySelector(
        '[data-testid="camera-device-select"]',
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
    const requestBtn = page.locator('[data-testid="camera-request-access"]');
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

    // Wait for the state machine to reach 'streaming'.
    const status = page.locator('[data-testid="camera-status"]');
    await expect(status).toHaveAttribute('data-state', 'streaming', {
      timeout: 10_000,
    });

    // Local-only hint must be visible while streaming. The CAMERA stream
    // is not multiplayer-streamed (deferred to a future phase); the in-card text keeps
    // user expectations honest.
    const localOnlyHint = page.locator('[data-testid="camera-local-only-hint"]');
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

    await page.goto('/rack?shell=legacy&seed=none');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'v-cam', type: 'cameraInput', position: { x: 80, y: 60 }, domain: 'video' },
    ]);

    await expect(page.locator('.svelte-flow__node-cameraInput'), 'CAMERA visible').toBeVisible();

    // The mount auto-acquire hit the stubbed reject → stuck in 'no-cameras-found'
    // (the screenshot state). The dropdown still lists the available camera(s).
    const status = page.locator('[data-testid="camera-status"]');
    await expect(status).toHaveAttribute('data-state', 'no-cameras-found', { timeout: 10_000 });

    const select = page.locator('[data-testid="camera-device-select"]');
    await page.waitForFunction(
      () => {
        const el = document.querySelector(
          '[data-testid="camera-device-select"]',
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
      'data-state',
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

    await page.goto('/rack?shell=legacy&seed=none');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'v-cam', type: 'cameraInput', position: { x: 80, y: 60 }, domain: 'video' },
    ]);

    const status = page.locator('[data-testid="camera-status"]');
    await expect(status).toHaveAttribute('data-state', 'no-cameras-found', {
      timeout: 5_000,
    });
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
  test('under ?shell=1 the camera card + picker stay in the lane and camera → OUTPUT paints moving pixels', async ({ page }) => {
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

    // The CARVE-OUT: the real card in the lane, never the uniform tile…
    const camLane = page.locator('.svelte-flow__node[data-id="v-cam"]');
    await expect(camLane.locator('[data-testid="module-shell-placeholder"]')).toHaveCount(0);
    // …so the DEVICE PICKER is reachable + lists the fake device.
    const select = camLane.locator('[data-testid="camera-device-select"]');
    await expect(select, 'device picker usable in the shell lane').toBeVisible({ timeout: 15_000 });
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="camera-device-select"]') as HTMLSelectElement | null;
        return el ? el.options.length > 0 : false;
      },
      undefined,
      { timeout: 10_000 },
    );
    await expect(select).toBeEnabled();

    // The SOURCE actually reached the engine: the card streams…
    await expect(camLane.locator('[data-testid="camera-status"]'))
      .toHaveAttribute('data-state', 'streaming', { timeout: 20_000 });

    // …and the OUTPUT surface paints MOVING pixels (the fake device's animated
    // pattern). Pre-fix this canvas stayed black — "no video at all".
    const outSel = '.svelte-flow__node[data-id="v-out"] [data-testid="video-out-canvas"]';
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
// playwright.config.ts is in the collab attest basis, so adding a project for
// one test would force a re-attest.
test.describe('CAMERA node-owned media lifetime @camera-integration', () => {
  test('a card move (expand + collapse) does NOT stop the capture', async ({ page }) => {
    test.setTimeout(90_000);

    await page.goto('/rack');
    await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 15_000 });

    await spawnPatch(page, [
      { id: 'v-cam', type: 'cameraInput', position: { x: 80, y: 60 }, domain: 'video', params: { enabled: 1 } },
    ]);

    const camLane = page.locator('.svelte-flow__node[data-id="v-cam"]');
    await expect(camLane.locator('[data-testid="camera-status"]'))
      .toHaveAttribute('data-state', 'streaming', { timeout: 30_000 });

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
          where: v.closest('[data-testid="dock-full-view"]')
            ? 'dock'
            : v.closest('[data-testid="node-media-parking"]')
              ? 'parking'
              : 'lane',
        };
      });

    const before = await captureState();
    expect(before.present, 'the camera element exists before the move').toBe(true);
    expect(before.tracks, `a live capture track before the move: ${JSON.stringify(before)}`)
      .toEqual(['live']);

    // EXPAND — for a NON_SHELL type the lane KEEPS its real card and the dock
    // full-view mounts a SECOND one. That is precisely the hazard Canvas
    // documents ("a second mount would run two media elements for one node and
    // the first to unmount would detach the survivor's source"), so this is the
    // real-app exercise of the registry's transfer + owner-checked release:
    // there is only ever ONE element, and whichever mount tears down last
    // cannot strand it.
    await page.evaluate(() => {
      (globalThis as unknown as { __openDockFullView: (i: string) => void })
        .__openDockFullView('v-cam');
    });
    await expect(page.locator('[data-testid="dock-full-view"]')).toHaveCount(1, { timeout: 20_000 });

    const expanded = await waitForLiveCapture();
    expect(expanded.present, `exactly one element while double-mounted: ${JSON.stringify(expanded)}`)
      .toBe(true);
    expect(expanded.count, 'never two <video> elements for one node').toBe(1);
    expect(expanded.tracks, `capture still live while expanded: ${JSON.stringify(expanded)}`)
      .toEqual(['live']);

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
    await expect(camLane.locator('[data-testid="camera-status"]'))
      .toHaveAttribute('data-state', 'streaming', { timeout: 20_000 });
  });
});
