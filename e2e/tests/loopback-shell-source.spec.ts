// e2e/tests/loopback-shell-source.spec.ts
//
// LOOPBACK UNDER THE DEFAULT SHELL — the spec that had to exist before the
// promotion could ship.
//
// WHAT PROMOTION CHANGED. `loopback` was un-faced, so the lane painted a
// `ModuleShellPlaceholder`. Now it paints a FACEPLATE. In BOTH states the real
// card runs inside `<HeadlessSourceHost>` — parked at `left:-9999px`,
// `pointer-events: none`, `aria-hidden` — because `needsHeadlessSourceMount`
// covers the 'placeholder' and 'shell' lane kinds alike. That is worth stating
// plainly, because the tempting story ("the face moved the card off-screen") is
// wrong and would misattribute everything below.
//
// Two things follow, and they are DIFFERENT problems that every existing gate
// conflates:
//
//   1. THE SOURCE must survive the swap. It does, by a mechanism that already
//      existed: loopback ∈ `DOM_SOURCE_LANE_TYPES`, and the `<video>` +
//      MediaStream are node-owned (#1583). Every unit assertion about that is
//      pure set membership — NOTHING in the unit lane proves Canvas wires it or
//      that a frame arrives. This file does.
//
//   2. THE AFFORDANCES do NOT survive it, and keeping the source alive does not
//      keep the module usable. An off-screen host is unclickable, so the card's
//      "Start capture" is gone unless something carries it.
//
//      ⚠ AND HERE THAT IS TOTAL, WHICH IS THE ONE PLACE THIS FILE IS NOT A COPY
//      OF `camerainput-shell-source.spec.ts`. cameraInput's card auto-acquires
//      when the origin has already been granted, so its faceplate button is the
//      route for a FIRST-TIME visitor. `getDisplayMedia` has NO already-granted
//      state: every capture, for every user, forever, needs a fresh user
//      gesture and a fresh trip through the picker. So without a reachable
//      button a promoted LOOPBACK cannot be started AT ALL — and it would ship
//      that way behind a fully green gate set, because every existing gate
//      reads the SOURCE. `$lib/ui/media/loopback-status-registry` carries the
//      gesture; this file proves the carry works IN BOTH DIRECTIONS through the
//      real DOM (a click reaches the card, and the card's resulting state
//      reaches the face).
//
// ⚠ NO PICKER, NO PROMPT, NO CAPABILITY PROBE — BY CONSTRUCTION. A display
// capture cannot be granted headlessly, and a probe-and-skip here would be a
// gate that cannot fail where it matters. `getDisplayMedia` is STUBBED before
// boot to REJECT: a rejection is a real, reachable outcome with its own
// recovery text, identical on every machine, where a success would need a
// picker no CI can answer. So this spec is capability-INDEPENDENT rather than
// capability-gated, which is strictly stronger than probing.
//
// ⚠ AND THE UNSUPPORTED BRANCH IS EXERCISED TOO, as a BRANCH rather than a
// `test.skip`. A mid-test skip marks the whole case skipped on CI and hides the
// capability-independent half that DID run. The last test DELETES
// `getDisplayMedia` and asserts the face degrades honestly — and that its
// button stays HIT-TESTABLE while disabled, because `disabled` changes dispatch,
// not hit-testing, and reachability must not be a capability-dependent claim.
//
// ⚠ THE PIXEL LEG USES THE MODULE'S OWN INJECTED-FRAME SEAM
// (`__loopbackTestFrame`), the same one `loopback.spec.ts` and the face VRT
// scenes use: a fixed synthetic frame uploaded instead of a live `<video>`
// sample, with the crop derived from the PARAM rather than from any per-frame
// viewport measurement. Frames are driven SYNCHRONOUSLY through `engine.step()`
// with the rAF loop paused, so there is no renderer-dependent wait anywhere in
// this file — not a millisecond budget, not a frame count standing in for one.
//
// ⚠ SCOPED SELECTORS THROUGHOUT (`canvasNode`, and `host.locator(...)` for the
// hosted copy). `HeadlessSourceHost` mounts the real card inside its OWN
// `<SvelteFlow>`, so a bare `.svelte-flow__node[data-id=…]` matches TWO
// elements and Playwright's `toBeVisible` is satisfied by one at
// `left:-9999px`. That measured trap bit four tests on the camera promotion;
// `MAIN_CANVAS`'s child combinator is the discriminator and this file uses it
// from the first line rather than after a red.
//
// ⚠ ARMED WITH `errorWatch`, WHICH IS PART OF THE ASSERTION HERE RATHER THAN
// HYGIENE. The status registry notifies its subscribers SYNCHRONOUSLY from
// inside the card's publish `$effect`, and the subscriber is a DIFFERENT
// component (the dock body) writing its own `$state`. A clean console is the
// evidence that the notify/subscribe direction is sound.
import { test, expect, type Page } from './_fixtures';
import { spawnPatch, canvasNode } from './_helpers';
import { BOOT_MS, SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';
import { installRenderSmokeHooks, stepAndReadStats, assertRenderStats } from './_render-smoke';

const LOOP = 'sut-loopback';
const OUT = 'sut-out';
const FIXED_STEPS = 6;

/** How many times the page asked to capture a display surface. Read back to
 *  prove the face's button reached the card — an acquire writes NOTHING to the
 *  graph and is therefore invisible to every readParam/readData probe. */
interface GdmProbe {
  __loopGdmCalls?: number;
}

/**
 * Stub `getDisplayMedia` before boot.
 *
 * `mode: 'reject'` is the default and the interesting one. `mode: 'absent'`
 * DELETES the API, which is what an unsupported runtime looks like to
 * `isViewportCaptureSupported()` — the other half of the capability space.
 */
async function stubDisplayMedia(page: Page, mode: 'reject' | 'absent' = 'reject'): Promise<void> {
  await page.addInitScript((m: string) => {
    const w = globalThis as unknown as GdmProbe & { navigator: Navigator };
    w.__loopGdmCalls = 0;
    const nav = w.navigator as Navigator & { mediaDevices?: unknown };
    // A non-secure context has no `mediaDevices` at all; create the shape rather
    // than letting the stub silently not apply.
    if (!nav.mediaDevices) {
      Object.defineProperty(nav, 'mediaDevices', { value: {}, configurable: true });
    }
    const md = nav.mediaDevices as {
      getDisplayMedia?: (c?: unknown) => Promise<MediaStream>;
      addEventListener?: (t: string, f: () => void) => void;
      removeEventListener?: (t: string, f: () => void) => void;
    };
    if (m === 'absent') {
      // ⚠ DELETE, then re-assert absence. Chromium defines the method on the
      // prototype, so a bare `delete` on the instance can leave the inherited
      // one visible and the "unsupported" case would silently not be tested.
      try { delete md.getDisplayMedia; } catch { /* non-configurable */ }
      Object.defineProperty(md, 'getDisplayMedia', {
        value: undefined,
        configurable: true,
        writable: true,
      });
    } else {
      md.getDisplayMedia = () => {
        w.__loopGdmCalls = (w.__loopGdmCalls ?? 0) + 1;
        // ⚠ NOT `NotAllowedError`. The card treats that as "the user dismissed
        // the picker" and returns quietly to `idle` with NO error text — a real
        // outcome, but one whose face-side evidence is the ABSENCE of things,
        // which cannot distinguish "the seam carried the answer" from "the seam
        // did nothing". A hard failure produces a lamp AND text to travel back.
        return Promise.reject(
          new DOMException('e2e: display capture unavailable by design', 'NotReadableError'),
        );
      };
    }
    md.addEventListener ??= () => {};
    md.removeEventListener ??= () => {};
  }, mode);
}

async function gdmCalls(page: Page): Promise<number> {
  return page.evaluate(() => (globalThis as unknown as GdmProbe).__loopGdmCalls ?? 0);
}

/**
 * WHERE the node-owned `<video>` currently lives, plus its liveness.
 *
 * ⚠ `where` IS THE LOAD-BEARING FIELD AND THE OTHERS ARE NOT. The camera
 * promotion measured this exactly: on a tree where the face had unmounted the
 * card everywhere, `present` and `count` BOTH still passed — the node-owned
 * registry rescues the element into parking with no card mounted anywhere, so
 * "the element exists" is structurally blind to the regression. Only a label
 * that can NAME the host separates hosted from rescued.
 */
async function videoWhere(page: Page) {
  return page.evaluate(() => {
    const all = [...document.querySelectorAll('[data-testid="loopback-preview"]')];
    const v = all[0] as HTMLVideoElement | undefined;
    if (!v) return { present: false, count: 0, where: 'absent' };
    return {
      present: true,
      // ONE element per node is a registry invariant, not an accident —
      // assert it here, where a real double-mount actually happens.
      count: all.length,
      where: v.closest('[data-testid="dock-full-view"]')
        ? 'dock'
        : v.closest('[data-testid="headless-source-host"]')
          ? 'host'
          : v.closest('[data-testid="node-media-parking"]')
            ? 'parking'
            : 'lane',
    };
  });
}

/** Spawn LOOPBACK → VIDEO OUT. The edge is what makes the source's survival
 *  OBSERVABLE downstream rather than merely internal. */
async function spawnLoopbackChain(page: Page): Promise<void> {
  await spawnPatch(
    page,
    [
      { id: LOOP, type: 'loopback', position: { x: 420, y: 80 }, domain: 'video' },
      { id: OUT, type: 'videoOut', position: { x: 900, y: 80 }, domain: 'video' },
    ],
    [
      {
        id: 'e-loop-out',
        from: { nodeId: LOOP, portId: 'out' },
        to: { nodeId: OUT, portId: 'in' },
        sourceType: 'video',
        targetType: 'video',
      },
    ],
  );
}

async function bootRack(page: Page, url = '/rack'): Promise<void> {
  await page.goto(url);
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: BOOT_MS });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

const HOST = '[data-testid="headless-source-host"][data-node-type="loopback"]';

test.describe('LOOPBACK under the DEFAULT shell — promoted lane, headless source', () => {
  test('the lane paints a FACEPLATE, the real card runs headless, and the source still produces', async ({ page, errorWatch }) => {
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 2);

    await installRenderSmokeHooks(page);
    await page.addInitScript(() => {
      (globalThis as unknown as { __loopbackTestFrame?: boolean }).__loopbackTestFrame = true;
    });
    await stubDisplayMedia(page);

    // ⚠ THE DEFAULT SHELL, NOT `?shell=legacy`. Every test in `loopback.spec.ts`
    // pins `?shell=legacy`, which is precisely the surface promotion does not
    // change — so that whole file, useful as it is, proves nothing about this.
    await bootRack(page);
    await spawnLoopbackChain(page);

    // ── 1. THE LANE SWAPPED ────────────────────────────────────────────────
    const laneNode = canvasNode(page, LOOP);
    await expect(laneNode.getByTestId('module-shell'), 'the lane paints LOOPBACK\'s faceplate')
      .toBeVisible({ timeout: BOOT_MS });

    // ── 2. THE REAL CARD IS STILL MOUNTED, OFF-SCREEN ──────────────────────
    // This is the assertion the whole promotion rests on. Without it the card is
    // gone, `attachExternalSource` never runs, and LOOPBACK → OUT is black.
    const host = page.locator(HOST);
    await expect(host, 'HeadlessSourceHost keeps LOOPBACK\'s real card alive')
      .toHaveCount(1, { timeout: BOOT_MS });
    await expect(
      host.getByTestId('loopback-start-capture'),
      'and it is the REAL card in there, not an empty shell',
    ).toHaveCount(1);

    // ── 3. …AND THE CARD IS ONLY THERE ─────────────────────────────────────
    //
    // ⚠ ASSERTED AS UNIQUENESS-PLUS-LOCATION, NEVER AS `toHaveCount(0)` ON THE
    // LANE. The camera promotion wrote that inverted gate first and recorded
    // why it was wrong: `toHaveCount(0)` is satisfied BOTH by "the lane swapped
    // and the card is hosted off-screen" (right) and by "the card is not
    // mounted anywhere at all" (the exact regression this file exists to
    // catch). It would go GREEN in the broken world.
    await expect(
      host.locator('.svelte-flow__node-loopback'),
      'the real card is mounted inside the headless host',
    ).toHaveCount(1);
    await expect(
      page.locator('.svelte-flow__node-loopback'),
      'and NOWHERE ELSE — exactly one mount, and leg 2 proved which one it is',
    ).toHaveCount(1);

    // ── 3b. THE NODE-OWNED <video> IS HOSTED, NOT MERELY RESCUED ───────────
    expect(await videoWhere(page)).toEqual({ present: true, count: 1, where: 'host' });

    // ── 4. THE SOURCE PRODUCES ─────────────────────────────────────────────
    // Driven synchronously with the engine rAF loop paused: the frame count is
    // the assertion's own input, so this is renderer-independent by
    // construction rather than by tuning.
    const stats = await stepAndReadStats(page, { nodeId: LOOP, steps: FIXED_STEPS });
    assertRenderStats(stats, FIXED_STEPS);

    // ── 5. OPENING THE DOCK FACEPLATE DOES NOT UNMOUNT THE CARD ────────────
    // ⚠ THE REGRESSION THIS LEG EXISTS FOR, inherited from the camera lane:
    // Canvas excluded every full-view node from the headless host on the premise
    // that "DockFullView already mounts its real card" — true only for an
    // UN-MIGRATED module, since `DockFullView` is `{#if migrated} <ModuleShell/>
    // {:else} <CardComponent/>`. Promotion turns that premise false, and the
    // failure is silent: the faceplate looks right while the card that owns the
    // capture has been unmounted from every surface at once.
    await laneNode.getByTestId('module-shell').getByTestId('shell-open-dock').click();
    await expect(page.getByTestId('dock-full-view')).toBeVisible({ timeout: BOOT_MS });

    await expect(
      host,
      'the card must STILL be hosted while the faceplate is open — the dock shows the FACE, not the card',
    ).toHaveCount(1);
    expect(
      await videoWhere(page),
      'and the <video> is still in the host — `parking` would mean the card is unmounted everywhere',
    ).toEqual({ present: true, count: 1, where: 'host' });

    const afterDock = await stepAndReadStats(page, { nodeId: LOOP, steps: FIXED_STEPS });
    assertRenderStats(afterDock, FIXED_STEPS);
  });

  test('the faceplate carries BOTH capture gestures, and the card\'s answer comes back', async ({ page, errorWatch }) => {
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 2);

    await stubDisplayMedia(page);
    await bootRack(page);
    await spawnLoopbackChain(page);

    await canvasNode(page, LOOP).getByTestId('module-shell').getByTestId('shell-open-dock').click();
    const dock = page.getByTestId('dock-full-view');
    await expect(dock).toBeVisible({ timeout: BOOT_MS });

    const body = dock.getByTestId('loopback-output-body');
    await expect(body, 'the LOOPBACK extension body is mounted in the dock')
      .toBeVisible({ timeout: BOOT_MS });

    // ── THE NEGATIVE CONTROL, FIRST ────────────────────────────────────────
    // Nothing has asked to capture yet. If this is ever non-zero the click below
    // proves nothing — the error state would appear whether the button worked or
    // not. On this module the control is stronger than on CAMERA: there is no
    // auto-acquire path at all, so a non-zero count here would mean something is
    // calling getDisplayMedia without a gesture, which browsers refuse anyway.
    expect(
      await gdmCalls(page),
      'no getDisplayMedia before the click — otherwise the assertions below are vacuous',
    ).toBe(0);

    const lamp = body.getByTestId('loopback-face-lamp');
    await expect(lamp, 'nothing captured yet, and nothing is wrong yet')
      .toHaveAttribute('data-lamp', 'idle');
    await expect(
      body.getByTestId('loopback-face-error'),
      'no error text while nothing has failed',
    ).toHaveCount(0);

    const stop = body.getByTestId('loopback-face-stop');
    await expect(stop, 'STOP is not offerable while nothing is capturing')
      .toHaveAttribute('data-can-stop', 'false');

    // ── THE GESTURE ────────────────────────────────────────────────────────
    const acquire = body.getByTestId('loopback-face-acquire');
    await expect(acquire, 'the acquire button is offerable — a card is listening and the API exists')
      .toHaveAttribute('data-can-acquire', 'true');

    // ⚠ REACHABILITY, THE SETTLED PREDICATE: hit-test the element's own centre,
    // which is what a click actually does. NOT `toBeInViewport` alone (a
    // below-the-fold but scroll-reachable control is legitimate) and NOT an
    // ancestor `pointer-events` walk (the overlay idiom of a none-container
    // around an auto-panel is ordinary and produced a false red). It is FALSE
    // for the headless host, whose centre is at negative coordinates — which is
    // the whole point of asserting it on the faceplate's copy.
    await acquire.scrollIntoViewIfNeeded();
    const hitTestable = await acquire.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!hit && (hit === el || el.contains(hit) || hit.contains(el));
    });
    expect(
      hitTestable,
      'the acquire button is hit-testable at its own centre — a click would land on it, which is '
        + 'what "reachable" means and what the off-screen host can never satisfy',
    ).toBe(true);

    // ⚠ THE PERMANENT NEGATIVE CONTROL. If the two mounts ever became
    // indistinguishable, the leg above would start passing on the hosted copy
    // and certify a module nobody can click. Asserting the host is OFF-canvas
    // makes that go RED instead of quietly green.
    const hostedBox = await page.locator(`${HOST} [data-testid="loopback-start-capture"]`).boundingBox();
    expect(hostedBox, 'the hosted card must exist for this control to mean anything').not.toBeNull();
    expect(
      hostedBox!.x,
      'the HOSTED copy is parked off-canvas — if this ever goes >= 0 the reachability leg above is blind',
    ).toBeLessThan(0);

    await acquire.click();

    // ── DIRECTION ONE: the click REACHED the card ──────────────────────────
    // The card is off-screen and pointer-events:none, so the ONLY path from this
    // button to getDisplayMedia is the registry's command slot. An acquire
    // writes nothing to the graph, so this counter is the only observable there
    // is.
    await expect
      .poll(() => gdmCalls(page), {
        message: 'the faceplate button must reach the headless card\'s getDisplayMedia',
        timeout: BOOT_MS,
      })
      .toBe(1);

    // ── DIRECTION TWO: the card's ANSWER reached the face ──────────────────
    // The stub rejects with NotReadableError, so the card lands in 'error' with
    // its recovery text. Both must arrive back here — a one-way seam would leave
    // the lamp cheerfully idle over a failed capture, and on this module the
    // lamp has NOTHING in the graph it could fall back to reading.
    await expect(lamp, 'the lamp shows the card\'s REAL failure, not a graph guess')
      .toHaveAttribute('data-lamp', 'error', { timeout: BOOT_MS });
    await expect(
      body.getByTestId('loopback-face-error'),
      'and the card\'s message arrives with it',
    ).toContainText(/NotReadableError/i, { timeout: BOOT_MS });

    // ── AND THE FAILURE IS RETRYABLE ───────────────────────────────────────
    // `supported` is independent of `state`: a failed picker must stay
    // offerable, or a single transient error would strand the module forever
    // with no way back.
    await expect(acquire, 'a failed capture must remain retryable')
      .toHaveAttribute('data-can-acquire', 'true');
  });

  test('an UNSUPPORTED runtime degrades honestly — and the button stays REACHABLE while disabled', async ({ page, errorWatch }) => {
    // ⚠ A BRANCH OF THE CAPABILITY SPACE, EXERCISED AS A TEST RATHER THAN
    // SKIPPED. A mid-test `test.skip` marks the whole case skipped on CI and
    // hides the capability-independent half that did run, so the two states are
    // two tests and both run everywhere.
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS);

    await stubDisplayMedia(page, 'absent');
    await bootRack(page);
    await spawnLoopbackChain(page);

    await canvasNode(page, LOOP).getByTestId('module-shell').getByTestId('shell-open-dock').click();
    const dock = page.getByTestId('dock-full-view');
    await expect(dock).toBeVisible({ timeout: BOOT_MS });
    const body = dock.getByTestId('loopback-output-body');
    await expect(body).toBeVisible({ timeout: BOOT_MS });

    const acquire = body.getByTestId('loopback-face-acquire');
    await expect(acquire, 'no Screen Capture API ⇒ nothing to offer')
      .toHaveAttribute('data-can-acquire', 'false', { timeout: BOOT_MS });
    await expect(acquire).toBeDisabled();
    await expect(body.getByTestId('loopback-face-lamp')).toHaveAttribute('data-lamp', 'error');
    await expect(
      body.getByTestId('loopback-face-error'),
      'the card explains WHY rather than leaving a dead button unexplained',
    ).toContainText(/does not support/i);

    // ⚠ REACHABILITY IS CAPABILITY-INDEPENDENT, AND THIS IS THE LEG THAT SAYS
    // SO. `disabled` changes event DISPATCH, not HIT-TESTING — so a correctly
    // disabled control is still at real coordinates on a real surface. Had the
    // predicate been `toBeEnabled()` it would read differently on a machine
    // with the API than on one without, and "the control is unreachable" and
    // "this runtime cannot capture" would be indistinguishable from the output.
    await acquire.scrollIntoViewIfNeeded();
    const hitTestable = await acquire.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!hit && (hit === el || el.contains(hit) || hit.contains(el));
    });
    expect(
      hitTestable,
      'a DISABLED button is still hit-testable at its centre — reachability must not depend on capability',
    ).toBe(true);
  });

  test('`?shell=legacy` is UNCHANGED — the real card is in the lane and no host exists', async ({ page, errorWatch }) => {
    // ⚠ THE ESCAPE HATCH IS PART OF THE CONTRACT, and this promotion is exactly
    // the kind of change that quietly breaks it: the headless host would be a
    // SECOND mount of a card that is already in the lane, which is the
    // double-capture hazard `needsHeadlessSourceMount`'s 'legacy' arm exists to
    // prevent. Asserting the host is ABSENT is what proves that arm still fires
    // for this module now that it is promoted.
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS);

    await stubDisplayMedia(page);
    await bootRack(page, '/rack?shell=legacy');
    await spawnLoopbackChain(page);

    await expect(
      page.locator(`.svelte-flow__node-loopback[data-id="${LOOP}"]`),
      'the verbatim legacy card is the lane surface under ?shell=legacy',
    ).toBeVisible({ timeout: BOOT_MS });

    await expect(
      page.locator(HOST),
      'and NO headless host — that would be a second mount of the same card',
    ).toHaveCount(0);

    // The card's own buttons are the reachable ones here — the legacy surface
    // owes the same affordances the faceplate now carries.
    await expect(page.getByTestId('loopback-start-capture')).toHaveCount(1);
    expect(
      await videoWhere(page),
      'the node-owned <video> lives in the LANE card under the legacy shell',
    ).toEqual({ present: true, count: 1, where: 'lane' });
  });
});
