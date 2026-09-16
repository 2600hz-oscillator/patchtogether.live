// THE OWNER'S DEV SCENARIO (2026-09-15), pinned as a regression: a PLAIN
// BROWSER (no `window.ptNative`) whose per-machine rig store already holds an
// ES-9 binding, a CAMERA binding and a DISPLAY binding — and none of those
// devices is present (the es9-bridge socket on ws://127.0.0.1:9209 is refused,
// the camera is unplugged, the monitor is gone). Loading `/rack` must:
//
//   1. MOUNT and STAY on /rack for the whole spec — never a navigation to
//      /preflight (the relaunch guard is a native-shell feature; a browser has
//      no rig-setup page to bounce to, and #2374's bounce stranded the owner in
//      a /preflight → enter rack → /preflight loop);
//   2. register the AUDIO ENGINE after a real gesture (the audio gate);
//   3. keep every IN-RACK binding surface reachable AND writable: the camera
//      slot picker, the master audio-out picker, the ES-9 CONNECT cell and the
//      LinnStrument CONNECT cell (which binds the LinnStrument port by name,
//      with no rig pick — the web product);
//   4. survive a RELOAD of the restored (video-bearing, eagerly-booted) rack
//      with the same answer, and with ZERO `[reconciler] skipping edge … no
//      engine registered for domain` warnings — those were the bounce tearing
//      the engine down under an in-flight reconcile pass, not pre-gesture noise.
//
// Written against the behaviour that was DISPLACED, not the feature that was
// added: it is RED on the tree that shipped the bounce and GREEN once /preflight
// and the guard are shell-only. Devices are TEST DOUBLES that are real in shape
// (a genuine MediaStreamTrack, a recording setSinkId, the shared WebMIDI double);
// the ES-9 socket refusal is REAL — no runner has an es9-bridge process.
//
// Console policy: page errors and reconciler domain warnings are asserted to be
// ABSENT; the one console error this scenario legitimately produces — the
// refused es9-bridge WebSocket — is allowed BY PATTERN and nothing else is.
//
// ── THE FIRST CI HEAD (run 34964501755, e2e shard 11, attempt 1) ──────────
// The spec opts INTO the real-user audio gate (`__ptRackAudioGate`), and the
// gate is designed to come BACK whenever the AudioContext stops running. On
// the 2-core SwiftShader runner Chromium logged "The AudioContext encountered
// an error from the audio device or the WebAudio renderer" 1 s before the
// audio-out step; the context went `suspended`, the gate remounted, and every
// later click was "intercepted" by it for the rest of the budget (206 retries)
// — the spec assumed the gate was gone for good after the first gesture. Two
// fixture changes, no product change and no timeout:
//   · every click went through a `userClick` that clicked the gate first if it
//     was up, then the target (superseded by the gate HANDLER — second head);
//   · the mechanism is now a DETERMINISTIC leg (the context is suspended on
//     purpose after the audio-out step: the gate must return and one click
//     must resume audio), so the recovery path is asserted, not hoped for;
//   · `installRenderSmokeHooks` idles the video rAF loop: the six video-zone
//     defaults were rasterizing at 1024×768 on a software GPU every frame,
//     which is what starves a 2-core runner's audio device and actionability
//     checks (the #2396 class). No pixel is asserted here — the camera lamp is
//     the capture session's state, the ES-9 lamp is DOM, the LinnStrument
//     proof is MIDI bytes — so idling the raster removes only cost.
// Local repro of a hot shard: `E2E_CPU_THROTTLE=8 task e2e:one -- tests/rack-stale-rig-stays-in-browser.spec.ts`.
//
// ── THE SECOND CI HEAD (run 35022011949, e2e shard 11, attempt 1) ─────────
// The same overlay, one step earlier: `workflow-topbar-slot-audio-io` retried
// for the whole 450 s budget with `<div data-testid="audio-gate"> intercepts
// pointer events` on every attempt. `userClick` was a CHECK-THEN-CLICK: it
// read `gate.count()`, saw 0, and clicked the target — and the audio-device
// error is ASYNCHRONOUS, so the gate mounted after the check and before (or
// during) the target's click; from then on the target click retried behind
// the overlay for ever and nothing ever clicked the overlay. No window
// between "check" and "click" is small enough: the fixture has to answer the
// overlay from INSIDE the click's own retry loop, which is what Playwright's
// `page.addLocatorHandler` is for (`installAudioGateHandler` below) — before
// every actionability check and every auto-waiting assertion check, if the
// gate is visible, the handler clicks it first: the user's hand on the
// overlay, wherever in the flow it comes back. The deterministic leg (3b')
// reads the gate's return with a plain `count()` (an auto-waiting locator
// assertion would run the handler first and click the overlay away before
// its own check) and proves that ONE ordinary click on the rack resumes
// audio THROUGH the handler. CI's audio-device error itself has no local
// repro — no runner-side knob produces it — so the handler is correct by
// construction (Playwright's documented overlay mechanism) plus that leg.

// Main CI 35049356846 exposed a third race: the gate handler's outside
// pointerdown closes an open topbar panel, then a pending close-TOGGLE click
// resumes and reopens it. Force that suspension at the camera cleanup below.
// An outside click on the banner is an idempotent close gesture, so cleanup
// stays closed even if the audio handler already dismissed the panel. The old
// toggle fails this forced sequence locally; no timeout or assertion is relaxed.

import { test, expect, type Page } from '@playwright/test';
import { canvasPane, revealInPane } from './_helpers';
import { installRenderSmokeHooks } from './_render-smoke';
import { applyCpuThrottle } from '../_helpers/cpu-throttle';
import { SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';
import { installMidiDeviceMock, readMidiOutCaptured } from '../_helpers/midi';
import {
  seedRigStore,
  installFakeScreens,
  installFakeCameras,
  installFakeAudioSinks,
  disposeFakeCameras,
} from '../_helpers/preflight-devices';

const CAM_SLOT = 'slot:cam1';
const CAM_PRESENT_A = 'present-cam-a';
const CAM_PRESENT_B = 'present-cam-b';
const SINK_A = 'present-sink-a';
const SINK_B = 'present-sink-b';
const ES9_NODE = 'es9x';
const LINN_NODE = 'lnx';
const LINN_IN = 'linn-in';
const LINN_OUT = 'linn-out';

// NRPN 245 = User Firmware Mode: MSB 1, LSB 117, data 1 (on) — what a real
// LinnStrument bind writes to the instrument's output.
const USER_MODE_ON: number[][] = [
  [0xb0, 99, 1],
  [0xb0, 98, 117],
  [0xb0, 6, 0],
  [0xb0, 38, 1],
  [0xb0, 101, 127],
  [0xb0, 100, 127],
];
function containsRun(writes: number[][], seq: number[][]): boolean {
  for (let i = 0; i + seq.length <= writes.length; i++) {
    if (seq.every((m, j) => writes[i + j]?.length === m.length && m.every((b, k) => writes[i + j]?.[k] === b))) return true;
  }
  return false;
}

/** The stale rig the owner's browser had on disk: every class bound, none present. */
const STALE_RIG = {
  cameras: { cam1: { deviceId: 'gone-cam', deviceLabel: 'Unplugged Studio Cam' } },
  outputs: {
    output1: {
      screen: { label: 'DELL U2720Q', isInternal: false, width: 3840, height: 2160, dpr: 2, left: 3024, top: 0 },
    },
  },
  es9: { pushPolicy: 'auto' },
};

interface ConsoleLine {
  type: string;
  text: string;
}
interface Watch {
  console: ConsoleLine[];
  pageErrors: string[];
  navigations: string[];
  /** Clicks the audio-gate locator handler made on the overlay (see `installAudioGateHandler`). */
  gateHandlerClicks: number;
}
function watchPage(page: Page): Watch {
  const w: Watch = { console: [], pageErrors: [], navigations: [], gateHandlerClicks: 0 };
  page.on('console', (m) => w.console.push({ type: m.type(), text: m.text() }));
  page.on('pageerror', (e) => w.pageErrors.push(e.message));
  page.on('framenavigated', (f) => {
    if (f === page.mainFrame()) w.navigations.push(f.url());
  });
  return w;
}

async function rig(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => {
    const w = globalThis as unknown as { __rigBindings?: () => Record<string, unknown> };
    return w.__rigBindings ? w.__rigBindings() : {};
  });
}

async function mountRack(page: Page): Promise<void> {
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
  await expect(page.getByTestId('preflight-panel')).toHaveCount(0);
  expect(page.url(), 'the rack mounted at /rack').toMatch(/\/rack(\?|$)/);
}

/** The 'audio' domain's context state, or 'none' before the engine exists. */
function audioState(page: Page): Promise<string> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __engine?: () => { getDomain?: (d: string) => { ctx?: AudioContext } } | null;
    };
    try {
      return w.__engine?.()?.getDomain?.('audio')?.ctx?.state ?? 'none';
    } catch {
      return 'none';
    }
  });
}

const GATE = '[data-testid="audio-gate"]';

/**
 * THE USER'S HAND ON THE AUDIO GATE (the second CI head — see the header).
 * The product re-mounts the full-screen "Click anywhere to enable audio"
 * overlay whenever the AudioContext stops running (a browser suspend, CI's
 * audio-device error), at a moment no spec can predict; a user then clicks it
 * and carries on. Playwright runs this handler before every actionability
 * check and every auto-waiting assertion check while the gate is visible, so
 * no click below can be left "intercepted" by the overlay — including a gate
 * that mounts between a check and a click, which is exactly how the
 * check-then-click `userClick` this replaces lost the second CI head.
 *
 *   · Playwright's DEFAULT wait-after, on purpose: after the handler's click
 *     the action waits for the overlay to be HIDDEN (the resume completing)
 *     and only then proceeds. ⚠ Not `noWaitAfter` — that retries the action
 *     while the resume is still in flight (`gate.busy`, overlay still up),
 *     re-runs the handler, and the handler's click then auto-waits on an
 *     overlay that unmounts underneath it: `element was detached from the
 *     DOM, retrying` … for the whole test budget. The deterministic leg (3b')
 *     failed 3/3 exactly that way at ×1 before this was the default.
 *   · a device that refuses the resume keeps the overlay up (`gate.error`
 *     in the subtitle), so the wait-after runs out the action's budget with
 *     `waiting for getByTestId('audio-gate') to be hidden` in the call log —
 *     the product's failure, named, not a silent hang.
 *   · THE OVERLAY THAT IS THERE NOW, OR NOTHING: `page.$` does not wait, and
 *     an element handle's click throws `Element is not attached to the DOM`
 *     the moment the overlay unmounts under it — where a LOCATOR click logs
 *     `element was detached from the DOM, retrying`, auto-waits for the
 *     overlay to COME BACK, and spends the blocked action's whole budget.
 *     Not hypothetical: at ×8 the eager boot mounts the gate for a beat and
 *     resumes the context ITSELF, and `mountRack` after `goto` went 3/3 red
 *     with a locator click here (`toBeVisible` on the topbar, 30 s, with
 *     `found getByTestId('audio-gate'), intercepting action` in its log).
 *   · the click lands at the overlay's top-left, never its centre: the
 *     overlay is z-index 1000 and the only chrome above it is a portaled menu
 *     (a `Selector` listbox, z 2001) anchored near its trigger — a gate that
 *     comes back with the audio-out listbox open must still be clickable —
 *     and what sits under that corner is the banner's heading, so the
 *     hit-target check has nothing else to name.
 *
 * ⚠ With the handler installed, never `gate.click()` from the spec body: the
 * pre-check would run the handler (which clicks the gate away) and the click
 * would then auto-wait for an overlay that is gone. Read the gate with
 * `count()` / `page.evaluate` and let an ordinary action do the clicking.
 *
 * `w.gateHandlerClicks` counts the handler's clicks: the deterministic leg
 * asserts on it, and a RED run's evidence carries it.
 */
async function installAudioGateHandler(page: Page, w: Watch): Promise<void> {
  await page.addLocatorHandler(page.getByTestId('audio-gate'), async () => {
    const el = await page.$(GATE);
    if (!el) return;
    try {
      await el.click({ position: { x: 12, y: 12 } });
      w.gateHandlerClicks += 1;
    } catch (e) {
      if (!/not attached to the DOM/.test(String(e))) throw e;
    } finally {
      await el.dispose();
    }
  });
}

/** Closing must not invert state after the gate handler's outside click. */
async function closeTopbarPanel(
  page: Page,
  panelTestId: string,
  options: { timeout?: number } = {},
): Promise<void> {
  // A real locator click keeps gate recovery inside the action's wait, before
  // the short state assertion. The heading is outside every menu anchor and
  // has no toggle handler, so both the recovery click and this click close.
  await page.getByTestId('workflow-topbar').getByRole('heading').click();
  await expect(page.getByTestId(panelTestId)).toHaveAttribute('data-open', 'false', options);
}

/**
 * The GESTURE that boots audio for a real user: a click on the rack. In the
 * owner's browser the restored video rack boots the engine eagerly with a
 * SUSPENDED AudioContext and the audio-gate overlay sits on top until the first
 * click resumes it; headless Chromium has no autoplay block, so the eager
 * context may already be running and the overlay (which hides while the ctx is
 * running) may never mount. Either way the gesture is a REAL click on the
 * page — it lands on the overlay when there is one, on the pane otherwise —
 * and the assertion is the same: afterwards the 'audio' domain resolves and
 * its context is RUNNING.
 */
async function bootAudioByGesture(page: Page): Promise<void> {
  // ⚠ THE MAIN CANVAS's pane (`canvasPane`, `.flow > .svelte-flow`), never a
  // bare `.svelte-flow__pane:visible`: with a camera slot BOUND — this spec's
  // state from its first frame — the topbar's camera manager hosts the live
  // camera card in its own single-node SvelteFlow parked at left:-9999px and
  // it precedes `.flow` in the DOM, so the bare selector's first match is the
  // parked host and a click at its box lands off-screen (see _helpers.ts
  // revealInPane). That is how this leg once passed vacuously.
  const pane = canvasPane(page);
  const box = await pane.boundingBox();
  expect(box, 'the rack pane has a box to click').not.toBeNull();
  expect(box!.x, 'the pane is the on-screen canvas, not a parked camera host').toBeGreaterThanOrEqual(0);
  // Bottom-left of the pane: no module is placed there, and a full-screen
  // audio-gate overlay, if mounted, is what receives the click instead. The
  // click is repeated per read until the context reports RUNNING — a click
  // that lands before the overlay has mounted boots nothing, and the retry is
  // driven by the observed state, bounded by the boot budget.
  await expect
    .poll(
      async () => {
        await page.mouse.click(box!.x + 12, box!.y + box!.height - 12);
        return audioState(page);
      },
      { message: 'a click on the rack boots/resumes the audio engine', timeout: SLOW_BOOT_TEST_TIMEOUT_MS },
    )
    .toBe('running');
  await expect(page.locator(GATE), 'the overlay is gone once audio runs').toHaveCount(0);
}

/** Add the two hardware modules WITHOUT clearing the graph (spawnPatch would
 *  drop the reserved device slots this scenario is about). */
async function addHardwareModules(page: Page): Promise<void> {
  await page.evaluate(
    ({ es9, linn }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, unknown> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        w.__patch.nodes[es9] = { id: es9, type: 'es9', domain: 'audio', position: { x: 40, y: 400 }, params: {}, data: {} };
        w.__patch.nodes[linn] = { id: linn, type: 'linnstrument', domain: 'audio', position: { x: 520, y: 400 }, params: {}, data: {} };
      });
    },
    { es9: ES9_NODE, linn: LINN_NODE },
  );
  for (const id of [ES9_NODE, LINN_NODE]) {
    await expect(page.locator(`.svelte-flow__node[data-id="${id}"] [data-testid="module-shell"]`)).toBeVisible({
      timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
    });
  }
}

test.describe('a plain browser keeps the rack with a stale rig store (the owner\'s dev scenario)', () => {
  let watch: Watch | null = null;
  test.beforeEach(async ({ page }) => {
    await applyCpuThrottle(page); // no-op at E2E_CPU_THROTTLE=1
  });
  test.afterEach(async ({ page }, testInfo) => {
    // The evidence, pass or fail: every navigation, every reconciler warning,
    // every console error — so a RED run names what displaced the rack.
    if (watch) {
      const evidence = JSON.stringify(
        {
          navigations: watch.navigations,
          pageErrors: watch.pageErrors,
          reconcilerDomainWarnings: watch.console.filter((c) => /no engine registered for domain/.test(c.text)).map((c) => c.text),
          consoleErrors: watch.console.filter((c) => c.type === 'error').map((c) => c.text),
          gateHandlerClicks: watch.gateHandlerClicks,
        },
        null,
        2,
      );
      await testInfo.attach('rack-watch.json', { contentType: 'application/json', body: evidence });
      // A RED run prints its evidence too, so the list reporter carries it.
      if (testInfo.status !== testInfo.expectedStatus) console.log(`[rack-watch] ${evidence}`);
    }
    watch = null;
    await disposeFakeCameras(page);
  });

  test('stale ES-9 + camera + display bindings, bridge refused: /rack mounts, never leaves, and every in-rack binding surface still works — across a reload', async ({
    page,
  }) => {
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 5);

    // The owner's browser: the scratch replica persists the rack (so the
    // reload below restores a VIDEO rack and boots the engine eagerly), and
    // the audio gate is the gesture that starts audio.
    await page.addInitScript(() => {
      const w = window as unknown as { __ptScratchReplica?: boolean; __ptRackAudioGate?: boolean };
      w.__ptScratchReplica = true;
      w.__ptRackAudioGate = true;
    });
    // Idle the video raster (header: the first CI head). Nothing here reads a
    // pixel; the restored video rack still boots eagerly and still reconciles.
    await installRenderSmokeHooks(page);
    await seedRigStore(page, STALE_RIG);
    // The LIVE device lists are real and usable — and do not contain the bound
    // devices (the exact shape the guard called "positively absent").
    await installFakeCameras(page, [
      { deviceId: CAM_PRESENT_A, label: 'Present Cam A' },
      { deviceId: CAM_PRESENT_B, label: 'Present Cam B' },
    ]);
    await installFakeAudioSinks(page, [
      { deviceId: SINK_A, label: 'Present Sink A' },
      { deviceId: SINK_B, label: 'Present Sink B' },
    ]);
    await installFakeScreens(page, [
      { label: 'Built-in Retina', isInternal: true, width: 3024, height: 1964, devicePixelRatio: 2 },
    ]);
    await installMidiDeviceMock(page, {
      inputs: [{ id: LINN_IN, name: 'LinnStrument MIDI' }],
      outputs: [{ id: LINN_OUT, name: 'LinnStrument MIDI' }],
    });
    watch = watchPage(page);
    const w = watch;
    // The gate handler goes in BEFORE the first in-rack action (header: the
    // second CI head) — from here on, any click or auto-waiting assertion the
    // overlay blocks clicks the overlay first.
    await installAudioGateHandler(page, w);

    // ── 1. LOAD /rack: it mounts and stays ─────────────────────────────────
    await page.goto('/rack');
    await mountRack(page);
    expect((await rig(page)).es9, 'the stale ES-9 binding is really in the store').toEqual({ pushPolicy: 'auto' });

    // ── 2. AUDIO after a gesture ───────────────────────────────────────────
    await bootAudioByGesture(page);
    await mountRack(page); // still here after the gesture

    // ── 3a. CAMERA — the slot picker in the rack, writing the rig store ────
    await page.getByTestId('workflow-topbar-slot-cameras').click();
    await expect(page.getByTestId('workflow-cameras-panel')).toHaveAttribute('data-open', 'true');
    const row = page.locator(`[data-testid="workflow-camera-row"][data-node-id="${CAM_SLOT}"]`);
    await expect(row).toHaveCount(1);
    await row.getByTestId('workflow-camera-source').click();
    const host = page.locator(`[data-testid="workflow-camera-host"][data-node-id="${CAM_SLOT}"]`);
    await expect(host).toHaveAttribute('data-shown', 'true', { timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
    const camSelect = host.getByTestId('cameraInput-tile-device-select');
    await expect(camSelect).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
    await camSelect.selectOption(CAM_PRESENT_B);
    // The pick lands in the rig store. Asserted by LABEL: the camera core
    // re-acquires and writes the ACQUIRED track's per-session device hash back
    // (rig-bindings-survive-reload.spec.ts documents the rotation); the label is
    // the stable identity, and the stale id is gone either way.
    await expect
      .poll(async () => ((await rig(page)).cameras as Record<string, { deviceLabel?: string }>)?.cam1?.deviceLabel, {
        message: 'the in-rack camera picker rebinds cam1 in the rig store',
        timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
      })
      .toBe('Present Cam B');
    expect(((await rig(page)).cameras as Record<string, { deviceId?: string }>)?.cam1?.deviceId).not.toBe('gone-cam');
    await expect(host.getByTestId('cameraInput-tile-lamp')).toHaveAttribute('data-lamp', 'streaming', {
      timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
    });
    // Reproduce main CI 35049356846: the audio gate can return while a
    // panel is open. Its recovery click is an outside pointerdown that closes
    // the panel before the original pending action continues.
    await page.evaluate(() => {
      const w = window as unknown as { __engine: () => { getDomain: (d: string) => { ctx: AudioContext } } };
      return w.__engine().getDomain('audio').ctx.suspend();
    });
    await expect.poll(() => page.locator(GATE).count(), {
      message: 'the audio gate returns while the camera panel is open',
      timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
    }).toBe(1);
    await closeTopbarPanel(page, 'workflow-cameras-panel');

    // ── 3b. AUDIO OUT — the master-sink picker, written AND applied ────────
    await page.getByTestId('workflow-topbar-slot-audio-io').click();
    // The picker is the face's roster CHIP, not a native `<select>`: click it,
    // then the portaled option carrying the sink's id — BOTH real pointer
    // clicks the gate handler covers, because this is exactly the step around
    // which the audio gate remounts (see the header), and `selectOption`
    // needed no pointer at all.
    const sinkChip = page.getByTestId('workflow-io-audioout-host').getByTestId('audioout-face-device-select');
    await expect(sinkChip).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
    await sinkChip.click();
    await page.locator(`[role="listbox"] [role="option"][data-value="${SINK_B}"]`).click();
    await expect
      .poll(async () => ((await rig(page)).audioOut as { outputDeviceId?: string })?.outputDeviceId, {
        message: 'the in-rack audio-out picker writes the rig store',
        timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
      })
      .toBe(SINK_B);
    await expect
      .poll(() => page.evaluate(() => (globalThis as unknown as { __appliedSink?: string | null }).__appliedSink ?? null), {
        message: 'and the sink was applied to the live AudioContext',
        timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
      })
      .toBe(SINK_B);
    await closeTopbarPanel(page, 'workflow-io-panel');

    // ── 3b'. THE BROWSER STOPS THE CONTEXT (the first CI head, deterministic) ─
    // CI's audio-device error left the context `suspended`; the product's
    // answer is the gate coming back, and a user's answer is one click. Both
    // are asserted here on purpose, so the recovery path is part of the
    // scenario rather than a race the fixture hopes never to see — and the
    // click is the GATE HANDLER's (the second CI head), so the mechanism every
    // click in this spec relies on is exercised here, not hoped for.
    await page.evaluate(() => {
      const w = window as unknown as { __engine: () => { getDomain: (d: string) => { ctx: AudioContext } } };
      return w.__engine().getDomain('audio').ctx.suspend();
    });
    await expect.poll(() => audioState(page), { message: 'the context is suspended' }).toBe('suspended');
    // The gate's return is read with `count()` — a plain query, never an
    // auto-waiting locator assertion: `expect(gate).toBeVisible()` would run
    // the handler FIRST, click the overlay away, and fail its own check.
    await expect
      .poll(() => page.locator(GATE).count(), {
        message: 'the product re-mounts the audio gate when audio stops',
        timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
      })
      .toBe(1);
    // ONE ordinary click on the rack — the audio-io slot, the neighbouring
    // step's own target. Its actionability check finds the overlay; the
    // handler clicks it (`gate.resume()` → `ctx.resume()`); the slot click
    // lands once the overlay is gone, and the panel opening proves it landed.
    // The poll's received value carries the overlay's own subtitle, so a
    // failure names the gate's reason ("Starting audio…" = a resume still in
    // flight / stalled, an error string = the browser refused the resume)
    // instead of a bare state.
    const handlerClicksBefore = w.gateHandlerClicks;
    await page.getByTestId('workflow-topbar-slot-audio-io').click();
    await expect
      .poll(
        async () => {
          // Read, never auto-wait: a locator's textContent() would block on an
          // unmounted overlay for its own action timeout.
          const subtitle = await page.evaluate(
            () => document.querySelector('[data-testid="audio-gate"] .audio-gate-subtitle')?.textContent?.trim() ?? 'unmounted',
          );
          return `${await audioState(page)} | gate: ${subtitle}`;
        },
        { message: 'one click on the gate resumes audio', timeout: SLOW_BOOT_TEST_TIMEOUT_MS },
      )
      .toMatch(/^running \| gate: unmounted$/);
    expect(w.gateHandlerClicks, 'the gate handler is what clicked the overlay').toBeGreaterThan(handlerClicksBefore);
    await expect(page.getByTestId('workflow-io-panel'), 'and the click behind it landed').toHaveAttribute('data-open', 'true', {
      timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
    });
    await closeTopbarPanel(page, 'workflow-io-panel', { timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
    await mountRack(page);

    // ── 3c. ES-9 — the CONNECT cell on the tile, with the bridge REFUSED ───
    await addHardwareModules(page);
    const es9Lane = page.locator(`.svelte-flow__node[data-id="${ES9_NODE}"]`);
    const es9Connect = es9Lane.getByTestId('shell-cell-es9-connect');
    await expect(es9Connect).toHaveCount(1);
    // The tile sits below the reserved slots; pan the flow so it is inside the
    // pane (Playwright's own scroll is undone by the canvas — _helpers.ts).
    await revealInPane(page, es9Lane);
    await es9Connect.click();
    await es9Lane.locator('[data-testid="module-shell"]').getByTestId('shell-open-dock').click();
    const es9Dock = page
      .getByTestId('dock-full-view')
      .locator(`[data-testid="module-shell"][data-shell-tier="dock"][data-shell-node="${ES9_NODE}"]`);
    await expect(es9Dock).toBeVisible();
    const bridgeLamp = es9Dock.getByTestId(`es9-led-bridge-${ES9_NODE}`);
    await expect(bridgeLamp, 'ws://127.0.0.1:9209 is refused: the lamp says so, the rack stays').toHaveAttribute(
      'aria-label',
      /no es9-bridge app answered/i,
      { timeout: SLOW_BOOT_TEST_TIMEOUT_MS },
    );
    // Close the drawer before the next tile: the bottom dock overlays the lower
    // canvas, and `revealInPane` guarantees "inside the pane", not "not under
    // the drawer" — a tile that lands there is clickable to the pane and
    // intercepted by the drawer's tabrail (seen at ×8 CPU throttle).
    // (The close button is in the full view's window-controls header, a sibling
    // of the module shell — scope to the full view, not the shell.)
    await page.getByTestId('dock-full-view').getByTestId('faceplate-close').click();
    await expect(page.getByTestId('dock-full-view')).toHaveCount(0);
    await mountRack(page);

    // ── 3d. LINNSTRUMENT — CONNECT on the face binds the port by NAME ──────
    const linnLane = page.locator(`.svelte-flow__node[data-id="${LINN_NODE}"]`);
    const linnConnect = linnLane.getByTestId('shell-cell-linnstrument-connect');
    await expect(linnConnect).toHaveCount(1);
    await revealInPane(page, linnLane);
    await linnConnect.click();
    await expect
      .poll(async () => ((await rig(page)).linnstrument as { deviceId?: string } | undefined)?.deviceId, {
        message: 'CONNECT from the face, with NO rig pick, binds the LinnStrument port and records it in the rig store',
        timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
      })
      .toBe(LINN_IN);
    await expect
      .poll(async () => containsRun((await readMidiOutCaptured(page, LINN_OUT)).map((m) => m.bytes), USER_MODE_ON), {
        message: 'and User Firmware Mode entry (NRPN 245) left on the paired output',
        timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
      })
      .toBe(true);

    // ── 4. RELOAD the restored video rack (the eager boot path) ────────────
    await page.reload();
    await mountRack(page);
    await expect
      .poll(async () => ((await rig(page)).cameras as Record<string, { deviceLabel?: string }>)?.cam1?.deviceLabel, {
        message: 'the in-rack camera bind survived the reload',
        timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
      })
      .toBe('Present Cam B');
    expect(((await rig(page)).linnstrument as { deviceId?: string } | undefined)?.deviceId).toBe(LINN_IN);
    // The restored rack re-materializes; give the eager boot its pass before
    // reading the console (the topbar is up, the slots are back).
    await expect(page.locator(`.svelte-flow__node[data-id="${ES9_NODE}"] [data-testid="module-shell"]`)).toBeVisible({
      timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
    });
    await bootAudioByGesture(page);
    await mountRack(page);

    // ── THE WHOLE-SPEC INVARIANTS ──────────────────────────────────────────
    expect(
      w.navigations.filter((u) => /\/preflight/.test(u)),
      `the page never navigated to /preflight — navigations: ${w.navigations.join(' → ')}`,
    ).toEqual([]);
    expect(
      w.navigations.filter((u) => !/\/rack(\?|$)/.test(u)),
      'every main-frame navigation (the load, the router\'s own replaceState hops, the reload) stayed on /rack',
    ).toEqual([]);
    expect(w.pageErrors, 'no page errors').toEqual([]);
    expect(
      w.console.filter((c) => /no engine registered for domain/.test(c.text)),
      'no reconciler pass ever ran against a disposed engine',
    ).toEqual([]);
    expect(
      w.console.filter((c) => /\[reconciler\] skipping edge/.test(c.text)),
      'no edge was skipped',
    ).toEqual([]);
    // Two console errors are the ENVIRONMENT, not the product, and both are
    // modelled above rather than tolerated here: the es9-bridge socket is
    // refused because no helper runs (the BRIDGE lamp asserts that in words),
    // and CI's runner has no audio device, so Chromium logs "The AudioContext
    // encountered an error from the audio device or the WebAudio renderer" and
    // suspends the context — the exact event the suspend → gate → resume leg
    // above exercises on purpose (run 34970354093, shard 11, is where it
    // landed in this list). Anything else on the error channel is a defect.
    const unexpectedErrors = w.console
      .filter((c) => c.type === 'error')
      .filter((c) => !/ws:\/\/127\.0\.0\.1:9209|WebSocket connection/.test(c.text))
      .filter((c) => !/AudioContext encountered an error from the audio device/.test(c.text));
    expect(
      unexpectedErrors,
      "the only console errors are the refused es9-bridge socket and CI's audio-device error",
    ).toEqual([]);
  });
});
