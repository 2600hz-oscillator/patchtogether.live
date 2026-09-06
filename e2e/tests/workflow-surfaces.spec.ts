// e2e/tests/workflow-surfaces.spec.ts
//
// WORKFLOW MODE P2 — the topbar surface trio on /rack:
//
//   🕐 clock — TIMELORDE's face: live BPM readout, the REAL tempo knob,
//      TAP tempo (shared TapTempo core), and click-driven patch-out rows
//      that hand off to the existing patch-menu drill-down picker.
//   ⚇ MIDI DIN — assign a MIDI input as TIMELORDE's clock source by wiring
//      the hidden pinned MIDICLOCK bridge (clock→clock, midistart→start_in,
//      midistop→stop_in); assigning flips the clock surface into the
//      externally-clocked state (tap disabled); unassign restores it.
//   (The 🎧 audio-I/O surface needs the fake-mic browser flags, so its e2e
//   lives in audio-in.spec.ts under the chromium-audio-in project.)
//
// Driving /rack keeps this in the NORMAL e2e lane (no
// DB/relay) — same rationale as workflow-mode.spec.ts. Web MIDI is faked
// via addInitScript (a deterministic single-input access object): CI
// runners have no MIDI hardware, and the bridge's device handling starts
// at navigator.requestMIDIAccess, which is exactly the seam we stub.

import { test, expect, type Page } from '@playwright/test';
import { canvasNode, spawnPatch } from './_helpers';
import { installRenderSmokeHooks } from './_render-smoke';
import { BOOT_MS, SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';

/** All always-on pinned ids a workflow rack must hold after the ensure
 *  (P1 trio + P2 surfaces — graph/workflow-pins.ts). */
const PINNED_IDS = [
  'pinned-mixmstrs',
  'pinned-electraControl',
  'pinned-clipplayer',
  'pinned-timelorde',
  'pinned-midiclock',
  'pinned-audioIn',
  'pinned-audioOut',
] as const;

/** The four P2 surface pins (never canvas cards). */
const SURFACE_IDS = PINNED_IDS.slice(3);

async function waitForPins(page: Page): Promise<void> {
  await page.waitForFunction(
    (ids) => {
      const w = globalThis as unknown as {
        __patch?: { nodes: Record<string, { data?: { pinned?: boolean } } | undefined> };
      };
      if (!w.__patch) return false;
      return ids.every((id) => w.__patch!.nodes[id]?.data?.pinned === true);
    },
    PINNED_IDS as unknown as string[],
    // ⚠ WAS A FLAT 10_000, AND THE RE-POINT IS WHY IT STOPPED FITTING. This
    // helper is byte-identical to origin/main; what changed is the navigation
    // above it — `?shell=legacy` is gone, so the pins now land after the v2
    // dock/ModuleShell boot rather than the legacy one, and a dock mount no
    // longer overlaps page load (memory:
    // repointing-a-spec-off-legacy-serializes-cold-boots). The flat number was
    // never re-derived.
    //
    // MEASURED on CI (run 33990942421, blob-report-10): this step occupied
    // 25,012 ms of wall clock before unwinding a "10000 ms" timeout — the page
    // was unresponsive well past its own deadline, while two ~400 s
    // `faceplate-platform` tests ran alongside it on the same shard. On the
    // retry the identical wait took 74 ms.
    //
    // A BOUND, not a claim: nothing here asserts boot latency, and the wait
    // returns the instant the pins land.
    //
    // ⚠ AND THE BOUND WAS NEVER WHAT EXPIRED. Raising it 10 s → 30 s and idling
    // the video engine (`installRenderSmokeHooks` in gotoWorkflow) did not stop
    // this site going red-then-green: 4 of 16 #2349 runs on 2026-09-05 and
    // #2368's run 34030547898 (shard 3) failed HERE, always on the first
    // rAF-dependent step of a fresh page, never later. That last run's trace
    // is the diagnosis: `networkidle` fired at 2.66 s, this wait began at
    // 2.63 s, the app logged `workflow: ensured pinned modules (…all seven…)`
    // at 3.10 s — and the wait expired at 30 s with the pins IN THE DOC the
    // whole time. The retry, in a fresh worker, took 5.8 s end to end.
    //
    // `page.waitForFunction` re-evaluates its predicate on the page's
    // `requestAnimationFrame` by default (Playwright: "polling: 'raf'"). This
    // predicate reads STORE state — a Y.Doc write by a Svelte effect — which
    // needs no frame to become true, and this spec deliberately gives the page
    // nothing to paint. So the readiness signal was being sampled by the one
    // clock the fixture had idled, and a page whose compositor delivered no
    // frame (the failed attempt's screencast holds a single frame in 37 s) kept
    // a true predicate unread. Reproduced locally by stubbing the main-world
    // rAF to never call back: the rAF-polled wait times out with the pins
    // present; a timer-polled one sees them in ~0.7 s; `click()` is unaffected
    // either way (actionability polls in Playwright's utility world). Timer
    // polling is the established shape for store-state waits in this suite
    // (`_scheduler-control`, `_clip-reset-trace`, `automation-cv-record`, …).
    { timeout: BOOT_MS, polling: 100 },
  );
}

interface PatchEdge {
  id: string;
  source: { nodeId: string; portId: string };
  target: { nodeId: string; portId: string };
}

async function readEdges(page: Page): Promise<PatchEdge[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __patch: { edges: Record<string, PatchEdge> } };
    return Object.values(w.__patch.edges).filter(Boolean) as PatchEdge[];
  });
}

async function readBpm(page: Page): Promise<number | undefined> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __patch: { nodes: Record<string, { params?: { bpm?: number } } | undefined> };
    };
    return w.__patch.nodes['pinned-timelorde']?.params?.bpm;
  });
}

async function setBpm(page: Page, bpm: number): Promise<void> {
  await page.evaluate((v) => {
    const w = window as unknown as {
      __patch: { nodes: Record<string, { params: Record<string, number> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      w.__patch.nodes['pinned-timelorde']!.params.bpm = v;
    });
  }, bpm);
}

async function gotoWorkflow(page: Page): Promise<void> {
  // ⚠ A BIGGER BOUND WAS NOT THE ANSWER, AND THE SECOND FAILURE PROVED IT. The
  // flat `10_000` here was derived up to `BOOT_MS` (30 s on CI) — and the wait
  // then expired at THIRTY seconds on the very next run. A bound that fails at
  // 3x its old value is not marginal; the page genuinely is not getting there.
  //
  // WHAT IT IS WAITING FOR is four PINNED surface nodes to reach `__patch`
  // after `/rack` boots — and note the URL carries NO `?seed=none`, so this is
  // the FULL DEFAULT RACK, every module of it mounting and painting, on a
  // 2-core runner sharing five workers. The pins are the subject; the pictures
  // are not.
  //
  // So the load is removed instead of the ceiling raised, the same lever that
  // fixed `toybox-presets-io` and `picturebox`'s diagnosis: every assertion in
  // this file is DOM — pin presence, `canvasNode` counts, a menu, a BPM text
  // readout — and `grep` finds no pixel read anywhere in it. Pausing the video
  // engine costs this spec nothing and gives the boot its cores back.
  //
  // `addInitScript` has to land before the app boots, which is why this sits
  // inside the shared entry point rather than in the tests.
  await installRenderSmokeHooks(page);
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  await waitForPins(page);
}

/** Stub Web MIDI with ONE deterministic input device. Must run before any
 *  page script (addInitScript) so webMidiAvailable() sees it. */
async function installFakeMidi(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const input = {
      id: 'fake-din-1',
      name: 'FAKE CLOCK DECK',
      state: 'connected',
      onmidimessage: null as unknown,
    };
    const access = {
      inputs: new Map([[input.id, input]]),
      onstatechange: null as unknown,
    };
    (navigator as unknown as { requestMIDIAccess: unknown }).requestMIDIAccess = () =>
      Promise.resolve(access);
    (globalThis as unknown as { __fakeMidi: unknown }).__fakeMidi = { access, input };
  });
}

// ⚠ AND `BOOT_MS` (30 s on CI) DOES NOT FIT INSIDE PLAYWRIGHT'S 30 s DEFAULT,
// so the budget has to move with it or the inner cap could never fire — the
// nesting inversion this repo has now been bitten by three times.
test.describe.configure({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

test.describe('workflow clock surface (🕐 TIMELORDE face)', () => {
  test('surface pins exist off-canvas; the menu shows the live BPM readout', async ({ page }) => {
    await gotoWorkflow(page);

    // The P2 surface pins live in the graph but NEVER as MAIN-CANVAS cards
    // (the audio-I/O menu legitimately hosts the pinned AUDIO IN/OUT faces in
    // its own standalone flow).
    //
    // ⚠ RE-POINTED, NOT RELAXED (2026-08-23). This read `.flow .svelte-flow__node…`
    // on the premise — stated in the line it replaces — that "`.flow` is the
    // main rack flow". That premise is FALSE: `HeadlessSourceHost` renders each
    // hosted card in its own SvelteFlow *inside* `.flow`, so a bare `.flow`
    // scope matches the host's copy too. It went red the day `pinned-timelorde`
    // gained a host (#1754), and the thing that changed is the SELECTOR'S REACH,
    // not the claim: an off-screen, `aria-hidden`, `pointer-events:none` mount
    // at `left:-9999px` is not a canvas card by any reading. `canvasNode`
    // addresses the canvas's own flow by the child combinator that separates
    // them — see its note in `_helpers.ts`.
    for (const id of SURFACE_IDS) {
      await expect(canvasNode(page, id)).toHaveCount(0);
    }
    // …and the ABSENCE above is not the absence of the node from the PAGE, which
    // is a different and much weaker claim.
    //
    // ⚠ WHAT PINNED IT HAS CHANGED, AND THE LEG IS STRONGER FOR IT
    // (legacy-removal S1). This used to assert `pinned-timelorde` was mounted
    // off-canvas in a `headless-source-host`, because its CARD was the sole
    // writer of `video_out`. The composite is node-owned now
    // ($lib/ui/media/frame-producers), so there is no host and no card at all —
    // and the honest anchor is the NODE, which really is in the graph while
    // nothing renders it on the canvas. If the node ever stops existing, this
    // fails rather than the count-zero leg above quietly getting easier.
    expect(
      await page.evaluate(() => {
        const w = globalThis as unknown as {
          __patch?: { nodes: Record<string, { type?: string } | undefined> };
        };
        return w.__patch?.nodes['pinned-timelorde']?.type ?? null;
      }),
      'the pinned clock node is not in the graph, so the canvas-absence above is the absence of ' +
        'the whole module rather than of its canvas tile',
    ).toBe('timelorde');
    await expect(
      page.locator('[data-testid="headless-source-host"][data-node-type="timelorde"]'),
      'a headless host is keeping a timelorde card alive — its producer is node-lifetime now, so ' +
        'that mount would be a second owner of one display frame',
    ).toHaveCount(0);

    await page.getByTestId('workflow-topbar-slot-clock').click();
    const menu = page.getByTestId('workflow-clock-menu');
    await expect(menu).toBeVisible();

    const readout = page.getByTestId('workflow-clock-bpm');
    await expect(readout).toContainText('120');
    await expect(readout).toHaveAttribute('data-clock-source', 'internal');
    await expect(page.getByTestId('workflow-clock-tap')).toBeEnabled();

    // The readout is LIVE: a remote/param write reflects without reopening.
    await setBpm(page, 87);
    await expect(readout).toContainText('87');
  });

  test('the tempo knob is the real Knob and turning it writes bpm', async ({ page }) => {
    await gotoWorkflow(page);
    await page.getByTestId('workflow-topbar-slot-clock').click();

    const knob = page
      .getByTestId('workflow-clock-knob')
      .locator('[data-testid="control-bpm"]');
    await expect(knob).toBeVisible();

    const box = await knob.boundingBox();
    expect(box).toBeTruthy();
    const cx = box!.x + box!.width / 2;
    const cy = box!.y + box!.height / 2;

    // Vertical drag UP = increase (the shared Knob convention).
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx, cy - 60, { steps: 12 });
    await page.mouse.up();

    await expect
      .poll(async () => (await readBpm(page)) ?? 0, { timeout: 5_000 })
      .toBeGreaterThan(120);
  });

  test('tap tempo: a single tap is inert; two taps lock the tapped tempo', async ({ page }) => {
    await gotoWorkflow(page);
    await setBpm(page, 60);

    await page.getByTestId('workflow-topbar-slot-clock').click();
    const tap = page.getByTestId('workflow-clock-tap');
    await expect(tap).toBeEnabled();

    // 2-tap minimum: the first tap alone must not move the tempo.
    await tap.click();

    // pacing: age the solo tap past the reset window so the timed pair below is
    // a FRESH sequence (otherwise the solo tap joins the median). That window is
    // the product's own `TAP_RESET_MS = 2000` —
    // packages/web/src/lib/electra/tap-tempo.ts:27, the default `resetMs` of the
    // `TapTempo` controller this very button drives (ClockSurface.svelte:83).
    // 2_100 is that interval plus margin.
    await page.waitForTimeout(2_100);

    // …and it did not: checked AFTER the full reset window rather than after a
    // 250 ms guess, so the solo tap has had strictly more time to (not) land.
    expect(await readBpm(page), 'one tap alone leaves the tempo untouched').toBe(60);

    // Fire both taps IN-PAGE and measure the actual interval with
    // performance.now() — CI load can stretch any nominal wait, so the
    // assertion compares against the MEASURED interval instead of a fixed
    // band. The exact interval→BPM math is pinned by the tap-tempo unit
    // suite; this proves the button feeds it and the result lands on the
    // real `bpm` param.
    const measured = await page.evaluate(
      () =>
        new Promise<{ intervalMs: number }>((resolve) => {
          const btn = document.querySelector(
            '[data-testid="workflow-clock-tap"]',
          ) as HTMLButtonElement;
          const t0 = performance.now();
          btn.click();
          setTimeout(() => {
            const t1 = performance.now();
            btn.click();
            resolve({ intervalMs: t1 - t0 });
          }, 300);
        }),
    );
    const expected = 60000 / measured.intervalMs;
    await expect
      .poll(async () => (await readBpm(page)) ?? 0, { timeout: 5_000 })
      .not.toBe(60);
    const bpm = (await readBpm(page))!;
    expect(Math.abs(bpm - expected)).toBeLessThan(5);
  });

  test('patch-out row opens the drill-down picker and wires 1x → ADSR gate', async ({ page }) => {
    await gotoWorkflow(page);
    // A canvas target with a gate input. spawnPatch wipes the graph; the
    // ensure effect re-spawns the pins, so re-wait before driving menus.
    await spawnPatch(page, [{ id: 'env', type: 'adsr', position: { x: 420, y: 220 } }]);
    await waitForPins(page);

    await page.getByTestId('workflow-topbar-slot-clock').click();
    await page.getByTestId('workflow-clock-patchout-1x').click();

    // The EXISTING drill-down picker opens (the same PortContextMenu every
    // card jack uses); the clock menu itself closed on hand-off.
    const picker = page.locator('[data-testid="port-context-menu"]');
    await expect(picker).toBeVisible();
    await expect(page.getByTestId('workflow-clock-menu')).toHaveCount(0);

    await picker.locator('[data-testid="patch-to-module"][data-node-id="env"]').click();
    const gateRow = picker.locator('[data-testid="patch-to-port"][data-port-id="gate"]');
    await expect(gateRow).toBeVisible();
    await gateRow.click();

    await expect
      .poll(async () => {
        const edges = await readEdges(page);
        return edges.some(
          (e) =>
            e.source.nodeId === 'pinned-timelorde' &&
            e.source.portId === '1x' &&
            e.target.nodeId === 'env' &&
            e.target.portId === 'gate',
        );
      }, { timeout: 5_000 })
      .toBe(true);
  });
});

test.describe('workflow MIDI DIN surface (⚇ clock source)', () => {
  /** The three bridge edges a DIN assignment writes. */
  function bridgeEdges(edges: PatchEdge[]): PatchEdge[] {
    return edges.filter(
      (e) => e.source.nodeId === 'pinned-midiclock' && e.target.nodeId === 'pinned-timelorde',
    );
  }

  // ⏸ FLAKE-PARK #1847 — parked with `test.fixme`; the body and its assertions are UNCHANGED.
  // NONDETERMINISM: 2 recovered-on-retry observation(s) across 1 SHA(s) / 1 branch(es) in the
  // 96 h CI census to 2026-08-18 — never a hard failure, so every one of those jobs reported SUCCESS.
  // LOST WHILE PARKED: the MIDI DIN clock-source assignment — wiring the hidden pinned MIDICLOCK bridge (clock/start_in/stop_in), flipping TIMELORDE into the externally-clocked state, and a clean unassign round-trip.
  // Re-enable only on a root cause (#1847); "it passes now" is not one.
  test.fixme('assign wires the midiclock bridge, disables tap, and unassign round-trips', { annotation: { type: 'fixme', description: 'FLAKE-PARK #1847 — nondeterministic on CI: 2 recovered-on-retry observations in the 96 h census to 2026-08-18; parked until root-caused' } }, async ({ page }) => {
    await installFakeMidi(page);
    await gotoWorkflow(page);

    // The bridge's MidiclockApi lives on the ENGINE-side module — boot the
    // engine the same way every audio e2e does.
    await page.evaluate(async () => {
      const w = globalThis as unknown as { __ensureEngine: () => Promise<unknown> };
      await w.__ensureEngine();
    });

    // Connect → the faked access lists exactly our device.
    await page.getByTestId('workflow-topbar-slot-midi-din').click();
    const menu = page.getByTestId('workflow-din-menu');
    await expect(menu).toBeVisible();
    await page.getByTestId('workflow-din-connect').click();

    const device = menu.locator('[data-testid="workflow-din-device"][data-deviceid="fake-din-1"]');
    await expect(device).toBeVisible();
    await expect(device).toContainText('FAKE CLOCK DECK');

    // Assign → the three bridge cables land in ONE transact.
    await device.click();
    await expect
      .poll(async () => bridgeEdges(await readEdges(page)).length, { timeout: 5_000 })
      .toBe(3);
    const pairs = bridgeEdges(await readEdges(page))
      .map((e) => `${e.source.portId}→${e.target.portId}`)
      .sort();
    expect(pairs).toEqual(['clock→clock', 'midistart→start_in', 'midistop→stop_in']);

    // The menu now shows the assigned source with an unassign ✕.
    const assigned = page.getByTestId('workflow-din-assigned');
    await expect(assigned).toBeVisible();
    await expect(assigned).toContainText('FAKE CLOCK DECK');

    // The clock surface flipped to the externally-clocked state: tap is
    // DISABLED (with the explanatory tooltip) and the readout says external.
    await page.getByTestId('workflow-topbar-slot-clock').click();
    const tap = page.getByTestId('workflow-clock-tap');
    await expect(tap).toBeDisabled();
    await expect(tap).toHaveAttribute('title', /external clock/i);
    await expect(page.getByTestId('workflow-clock-bpm')).toHaveAttribute(
      'data-clock-source',
      'external',
    );

    // Unassign → cables gone, tap re-enabled, source back to internal.
    await page.getByTestId('workflow-topbar-slot-midi-din').click();
    await page.getByTestId('workflow-din-unassign').click();
    await expect
      .poll(async () => bridgeEdges(await readEdges(page)).length, { timeout: 5_000 })
      .toBe(0);

    await page.getByTestId('workflow-topbar-slot-clock').click();
    await expect(page.getByTestId('workflow-clock-tap')).toBeEnabled();
    await expect(page.getByTestId('workflow-clock-bpm')).toHaveAttribute(
      'data-clock-source',
      'internal',
    );
  });
});
