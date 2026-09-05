// e2e/tests/camerainput-shell-source.spec.ts
//
// CAMERA UNDER THE DEFAULT SHELL — the spec that had to exist before the
// promotion could ship.
//
// WHAT PROMOTION CHANGED. `cameraInput` was in `NON_SHELL_LANE_TYPES`, so its
// real card rendered in the lane whatever `migrated()` said. Removing it means
// the lane paints a FACEPLATE and the real card moves into
// `<HeadlessSourceHost>` — parked at `left:-9999px`, `pointer-events: none`,
// `aria-hidden`. Two things follow, and they are DIFFERENT problems that every
// existing gate conflates:
//
//   1. THE SOURCE must survive the swap. It does, by a mechanism that already
//      existed and had never been exercised on a promoted module: cameraInput ∈
//      `DOM_SOURCE_LANE_TYPES`, `needsHeadlessSourceMount` is true for kind
//      'shell', and the `<video>` + MediaStream are node-owned. Every unit
//      assertion about that is pure set membership — NOTHING in the unit lane
//      proves Canvas wires it or that a frame arrives. This file does.
//
//   2. THE AFFORDANCES do NOT survive it, and keeping the source alive does not
//      keep the module usable. An off-screen host is unclickable, so the card's
//      "Request access" — the only route to `getUserMedia` for a visitor this
//      origin has not granted before — is gone unless something carries it.
//      `$lib/ui/media/camera-status-registry` carries it; this file proves the
//      carry works IN BOTH DIRECTIONS through the real DOM (a click reaches the
//      card, and the card's resulting state reaches the face).
//
// ⚠ NO CAMERA, NO PERMISSION PROMPT, NO CAPABILITY PROBE — BY CONSTRUCTION.
// CI has no camera, and a probe-and-skip here would be a gate that cannot fail
// where it matters. Instead both browser APIs are STUBBED before boot:
//   * `enumerateDevices` returns ONE videoinput with an EMPTY LABEL, which is
//     exactly what a real browser returns before permission is granted. That is
//     load-bearing: the card's mount-time auto-acquire fires only when labels
//     are visible, so an empty label keeps the card at 'idle' and leaves the
//     FIRST `getUserMedia` call to the click this test makes. A labelled fake
//     would have the card auto-request on mount and the error would already be
//     on screen before the button was pressed — the assertion would pass
//     without the button working at all.
//   * `getUserMedia` REJECTS with NotAllowedError. A rejection is a real,
//     reachable outcome with its own recovery text, and it is identical on
//     every machine — where a success would depend on hardware nobody's CI has.
// So this spec is capability-INDEPENDENT rather than capability-gated, which is
// strictly stronger than probing.
//
// ⚠ AND THE PIXEL LEG USES THE MODULE'S OWN INJECTED-FRAME SEAM
// (`__camerainputTestFrame`), the same one the render smoke and the attest use:
// a fixed synthetic checker uploaded instead of a live `<video>` sample, with
// "NO dependency on getUserMedia reaching 'streaming'". Frames are driven
// SYNCHRONOUSLY through `engine.step()` with the rAF loop paused, so there is no
// renderer-dependent wait anywhere in this file — not a millisecond budget, not
// a frame count standing in for one.

// ⚠ ARMED WITH `errorWatch`, WHICH IS PART OF THE ASSERTION HERE RATHER THAN
// HYGIENE. The status registry notifies its subscribers SYNCHRONOUSLY from
// inside the card's publish `$effect`, and the subscriber is a DIFFERENT
// component (the dock body) writing its own `$state`. Cross-component state
// writes during an effect are exactly the shape Svelte 5 warns about, and a
// warning here would be a real design smell in a seam that runs on every camera
// state change. A clean console across all three tests is the evidence that the
// notify/subscribe direction is sound; without this fixture the specs would pass
// while the console filled up.
import { test, expect, type Page } from './_fixtures';
import { spawnPatch } from './_helpers';
import { SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';
import { installRenderSmokeHooks, stepAndReadStats, assertRenderStats } from './_render-smoke';

const CAM = 'sut-camera';
const OUT = 'sut-out';
const FIXED_STEPS = 6;

/** How many times the page asked for a camera. Read back to prove the face's
 *  button reached the card, which writes nothing to the graph and is therefore
 *  invisible to every readParam/readData probe. */
interface GumProbe {
  __camGumCalls?: number;
}

/**
 * Stub the two media APIs before boot. See the header for why an EMPTY LABEL and
 * a REJECTION are the load-bearing choices rather than conveniences.
 */
async function stubMediaDevices(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = globalThis as unknown as GumProbe & { navigator: Navigator };
    w.__camGumCalls = 0;
    const nav = w.navigator as Navigator & { mediaDevices?: unknown };
    // A non-secure context has no `mediaDevices` at all; create the shape rather
    // than letting the stub silently not apply.
    if (!nav.mediaDevices) {
      Object.defineProperty(nav, 'mediaDevices', { value: {}, configurable: true });
    }
    const md = nav.mediaDevices as {
      enumerateDevices: () => Promise<unknown[]>;
      getUserMedia: (c?: unknown) => Promise<MediaStream>;
      addEventListener?: (t: string, f: () => void) => void;
      removeEventListener?: (t: string, f: () => void) => void;
    };
    md.enumerateDevices = () =>
      Promise.resolve([
        // EMPTY label = permission not yet granted, the real pre-grant shape.
        { deviceId: 'fake-cam-1', kind: 'videoinput', label: '', groupId: 'g1' },
      ]);
    md.getUserMedia = () => {
      w.__camGumCalls = (w.__camGumCalls ?? 0) + 1;
      return Promise.reject(
        new DOMException('e2e: camera denied by design', 'NotAllowedError'),
      );
    };
    md.addEventListener ??= () => {};
    md.removeEventListener ??= () => {};
  });
}

async function gumCalls(page: Page): Promise<number> {
  return page.evaluate(() => (globalThis as unknown as GumProbe).__camGumCalls ?? 0);
}

/** Spawn CAMERA → VIDEO OUT. The edge is what makes the source's survival
 *  OBSERVABLE downstream rather than merely internal. */
async function spawnCameraChain(page: Page): Promise<void> {
  await spawnPatch(
    page,
    [
      { id: CAM, type: 'cameraInput', position: { x: 420, y: 80 }, domain: 'video' },
      { id: OUT, type: 'videoOut', position: { x: 900, y: 80 }, domain: 'video' },
    ],
    [
      {
        id: 'e-cam-out',
        from: { nodeId: CAM, portId: 'out' },
        to: { nodeId: OUT, portId: 'in' },
        sourceType: 'video',
        targetType: 'video',
      },
    ],
  );
}

test.describe('CAMERA under the DEFAULT shell — promoted lane, node-owned source', () => {
  test('the lane paints a FACEPLATE, NO card is mounted anywhere, and the source still produces', async ({ page, errorWatch }) => {
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 2);

    await installRenderSmokeHooks(page);
    await page.addInitScript(() => {
      (globalThis as unknown as { __camerainputTestFrame?: boolean }).__camerainputTestFrame = true;
    });
    await stubMediaDevices(page);

    // The shipping shell — the only surface this module has, and the whole
    // subject of this file.
    await page.goto('/rack');
    await expect(page.getByTestId('workflow-topbar'))
      .toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
    await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
    await spawnCameraChain(page);

    // ── 1. THE LANE SWAPPED ────────────────────────────────────────────────
    const laneNode = page.locator(`.svelte-flow__node[data-id="${CAM}"]`);
    await expect(laneNode.getByTestId('module-shell'), 'the lane paints CAMERA\'s faceplate')
      .toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

    // ── 2. NO CARD IS MOUNTED ANYWHERE ─────────────────────────────────────
    //
    // ⚠ THIS LEG ASSERTED THE OPPOSITE UNTIL 2026-09-03, and the inversion is
    // the legacy-removal S1 extraction. Until then the promotion rested on
    // `HeadlessSourceHost` keeping the REAL card mounted off-screen, because the
    // card owned getUserMedia, the device roster, the permission state machine
    // and the engine attach. `$lib/ui/media/node-camera-source-registry` owns all
    // four now, on GRAPH lifetime, so cameraInput left `DOM_SOURCE_LANE_TYPES`
    // and gets no host.
    //
    // ⚠ AND THE OLD LEG-3 STORY INVERTS WITH IT — it is worth reading before
    // trusting anything below. The first version of that leg was
    // `toHaveCount(0)` on the lane, and it was rejected because zero is
    // satisfied BOTH by "swapped and hosted off-screen" (right) and by "not
    // mounted anywhere at all" (the regression). Zero mounts is now the INTENDED
    // state, so a mount count separates nothing at all in either direction, and
    // no rewording of it can. What separates the two worlds is whether the module
    // still PRODUCES PIXELS with nothing mounted — leg 4. Read that as the gate;
    // this leg only establishes what leg 4 produced them WITHOUT.
    const host = page.locator(
      '[data-testid="headless-source-host"][data-node-type="cameraInput"]',
    );
    await expect(host, 'cameraInput has no headless host any more — the controller owns the source')
      .toHaveCount(0, { timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
    // ⚠ TWO FURTHER ABSENCE CHECKS STOOD HERE AND NEITHER CAN FAIL ANY MORE.
    // `camera-device-select` is emitted by nothing in the tree, and
    // `.svelte-flow__node-cameraInput` is a per-TYPE xyflow class that stopped
    // existing when every lane node became `moduleShell` — so both were
    // satisfied by a page that rendered nothing. The HOST check above is the
    // falsifiable one (six modules still get hosts), and the source-produces
    // leg below is the positive statement.

    // ── 4. THE SOURCE PRODUCES ─────────────────────────────────────────────
    // Driven synchronously with the engine rAF loop paused: the frame count is
    // the assertion's own input, so this is renderer-independent by
    // construction rather than by tuning.
    const stats = await stepAndReadStats(page, { nodeId: CAM, steps: FIXED_STEPS });
    assertRenderStats(stats, FIXED_STEPS);

    // ── 5. OPENING THE DOCK FACEPLATE DISTURBS NOTHING ─────────────────────
    // The original worry was that opening the dock unmounted the card from every
    // surface at once — `DockFullView` being `{#if migrated} <ModuleShell/>
    // {:else} <CardComponent/>` meant the headless host's exclusion of full-view
    // nodes silently orphaned a promoted module's source. There is no card to
    // unmount now, so the leg becomes the same question asked of what replaced
    // it: the module keeps producing across the dock transition.
    await laneNode.getByTestId('module-shell').getByTestId('shell-open-dock').click();
    await expect(page.getByTestId('dock-full-view'))
      .toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

    await expect(
      page.getByTestId('camera-device-select'),
      'the dock shows the FACE — opening it must not mint a card mount either',
    ).toHaveCount(0);

    const afterDock = await stepAndReadStats(page, { nodeId: CAM, steps: FIXED_STEPS });
    assertRenderStats(afterDock, FIXED_STEPS);
  });

  test('the faceplate carries the ACQUIRE gesture, and the controller\'s answer comes back to it', async ({ page, errorWatch }) => {
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 2);

    await stubMediaDevices(page);

    await page.goto('/rack');
    await expect(page.getByTestId('workflow-topbar'))
      .toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
    await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
    await spawnCameraChain(page);

    const laneNode = page.locator(`.svelte-flow__node[data-id="${CAM}"]`);
    await laneNode.getByTestId('module-shell').getByTestId('shell-open-dock').click();
    const dock = page.getByTestId('dock-full-view');
    await expect(dock).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

    const body = dock.getByTestId('cameraInput-output-body');
    await expect(body, 'the CAMERA extension body is mounted in the dock')
      .toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

    // ── THE NEGATIVE CONTROL, FIRST ────────────────────────────────────────
    // Nothing has asked for a camera yet, and that is only true because the fake
    // device carries an EMPTY LABEL (see the header). If this is ever non-zero,
    // the click below proves nothing — the card auto-acquired and the error
    // state it produces would appear whether the button worked or not.
    expect(
      await gumCalls(page),
      'no getUserMedia before the click — otherwise the assertions below are vacuous',
    ).toBe(0);

    const lamp = body.getByTestId('cameraInput-face-lamp');
    await expect(lamp, 'no camera chosen yet, and nothing is wrong yet')
      .toHaveAttribute('data-lamp', 'no-device');
    await expect(
      body.getByTestId('cameraInput-face-error'),
      'no error text while nothing has failed',
    ).toHaveCount(0);

    // ── THE GESTURE ────────────────────────────────────────────────────────
    const acquire = body.getByTestId('cameraInput-face-request-access');
    await expect(acquire, 'the acquire button is offerable — a card is listening and a device exists')
      .toHaveAttribute('data-can-request', 'true');
    await acquire.click();

    // ── DIRECTION ONE: the click REACHED the card ──────────────────────────
    // The card is off-screen and pointer-events:none, so the ONLY path from this
    // button to getUserMedia is the registry's command slot. An acquire writes
    // nothing to the graph, so this counter is the only observable there is.
    await expect
      .poll(() => gumCalls(page), {
        message: 'the faceplate button must reach the headless card\'s getUserMedia',
        timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
      })
      .toBe(1);

    // ── DIRECTION TWO: the card's ANSWER reached the face ──────────────────
    // The stub rejects with NotAllowedError, so the card lands in
    // 'permission-denied' with its recovery text. Both must arrive back here —
    // a one-way seam would leave the lamp cheerfully ARMED over a dead camera,
    // which is the failure a graph-derived lamp could not distinguish.
    await expect(lamp, 'the lamp shows the card\'s REAL failure, not a graph guess')
      .toHaveAttribute('data-lamp', 'error', { timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
    await expect(
      body.getByTestId('cameraInput-face-error'),
      'and the card\'s recovery instructions arrive with it',
    ).toContainText(/site settings/i, { timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
  });

  // A second-renderer leg was DELETED by the S2 inversion: its subject was that
  // renderer plus the absence of the (since deleted) HeadlessSourceHost.
  // Node-source ownership on the shell users get is
  // covered by the tests above and by workflow-shell-video's per-row
  // card-absence assertions.
});
