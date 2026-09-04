// e2e/tests/audio-input-survives-card-collapse.spec.ts
//
// AUDIO IN must keep streaming when the SURFACE that opened it goes away
// (#1590, from the #1583 audit) — now asserted through the FACE.
//
// `AudioinCard` ran `onDestroy(() => stopStream())`, and `stopStream()` calls
// `t.stop()` on every getUserMedia track. A surface unmounts on COLLAPSE, on
// dock LRU eviction when a third module is expanded, on ESC, on M/E and on
// navigation — none of which mean the performer is finished with their input.
// So the rack went silent mid-performance and the OS mic indicator dropped.
//
// ⚠ WHY THIS ROW NEEDED ITS OWN SPEC RATHER THAN A LINE IN THE FAMILY'S.
// `MediaStreamTrack.stop()` is IRREVERSIBLE. Every other member of the #1583
// family destroyed something the app could rebuild from state it still had — a
// rAF restarts, a GL context re-creates, a tap re-enables — so for those,
// "re-expand and check it came back" is a fair test. Here there is nothing to
// come back to: the track is permanently `ended`, and only a fresh
// getUserMedia (a NEW permission decision, which fails outright if another app
// has taken the device meanwhile) can replace it. The assertion therefore has
// to be that the track was NEVER STOPPED, not that the module recovered.
//
// ── ⚠ WHAT THE PROMOTION DID TO THIS FILE, AND WHY IT IS NOT VACUOUS ───────
//
// Before the face, ONE surface existed (`AudioinCard`) and `faceplate-collapse`
// unmounted it. After the face there are two, and collapsing the dock pane
// leaves the LANE TILE's `tileBody` mounted — so the old single ACT would have
// gone QUIET WHILE GREEN: it would still pass, over a gesture that no longer
// removes anything. That is the shape this suite's own history warns about, so
// the file is rewritten rather than re-pointed, into TWO lifetime legs:
//
//   LEG A — the DOCK PANE. Collapsing it really does unmount `fullViewBody`,
//           which is a NEW component with its own binding effect. A naive port
//           carrying `onDestroy(() => releaseAudioInput(id))` reintroduces
//           #1590 exactly, and only this leg would see it.
//   LEG B — NO MOUNTED SURFACE AT ALL, which is the state the original ACT
//           produced and the one that actually matters. It ASSERTS that
//           zero-surface state before it asserts the track survived it, so "the
//           ACT did nothing" is red rather than green.
//
// ⚠ ON A FACED MODULE THERE IS EXACTLY ONE ROUTE TO ZERO SURFACES, AND IT IS
// NOT THE ONE THE DEFECT WAS REPORTED FROM. This was arrived at by elimination
// and is reported to the owner with this PR:
//
//   * the LANE TILE's `ModuleShell` is UNCONDITIONAL for a promoted module, and
//     it mounts the `tileBody`. Every gesture the #1590 report named — collapse,
//     dock LRU eviction, ESC, M/E — leaves it standing. That is why the old
//     single ACT would have gone quiet while green;
//   * DOCKING would work (a docked node's lane becomes a `dockStub`, and a rail
//     snap-collapsed under 80 px renders a strip with no `DockCardHost`), but
//     `audioIn` is not in `DOCKABLE_TYPES`, so `dockNode` is a no-op for it and
//     no dock gesture is offered at all — MEASURED here, by writing that leg
//     first and watching the rail never appear;
//   * the PINNED `pinned-audioIn` is canvas-hidden and its 🎧 tray host is
//     mounted for the life of the page (the panel closes by opacity, never by
//     unmounting), so it is never surface-less either;
//   * a node folded into a COLLAPSED GROUP has no canvas presence at all —
//     Canvas's own dock sweep says so in as many words — while remaining IN THE
//     GRAPH, so `nodeAudioInput.sweep(liveIds)` must keep its entry. That is
//     LEG B.
//
// BOTH LEGS ARE POSITIVE-CONTROLLED. Adding `onDestroy(() =>
// releaseAudioInput(nodeId))` to `AudioInSourceControls.svelte` — the naive port
// of the exact line #1590 deleted — turns both RED (verified 2026-08-31, then
// reverted). A green run here is not the absence of a probe.
//
// THE INSTRUMENT. `__nodeAudioInput(id)` reports `trackLive`, read from the
// real `MediaStreamTrack.readyState` — deliberately not the registry's own
// opinion of whether it is streaming. A probe that echoed registry state could
// report a cheerful `streaming: true` over a device that was already dead,
// which is precisely the failure this spec exists to catch.
//
// Fake devices come from `--use-fake-device-for-media-stream` +
// `--use-fake-ui-for-media-stream` and `permissions: ['microphone']`
// (playwright.config.ts, the `chromium-audio-in` project), so the permission is
// pre-granted and a synthetic audio device is always present — this runs on CI,
// it is not a capability-gated local-only test. The pre-grant also means
// `enumerateDevices()` returns LABELLED entries, which is the condition
// `bindAudioInputSurface` requires before it takes its one unattended acquire.

import { test, expect, type Page } from './_fixtures';
import { spawnPatch } from './_helpers';
import { BOOT_MS, SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';

// Cold boot on the DEFAULT shell is the slowest goto in the suite, and both
// tests here pay it. A bound, not an assertion — see ../_helpers/boot-budget.ts.
test.describe.configure({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

const NODE = 'ain';

interface InputProbe {
  state: string;
  streaming: boolean;
  trackLive: boolean;
  tracks: number;
  liveChannels: number;
}

/** The NODE's own view of its input — never read off a surface, which is the
 *  thing under test for being absent. */
async function probe(page: Page, id = NODE): Promise<InputProbe> {
  return page.evaluate(
    (n) =>
      (globalThis as unknown as { __nodeAudioInput(x: string): InputProbe }).__nodeAudioInput(n),
    id,
  );
}

async function openFullView(page: Page, id = NODE) {
  await page.evaluate(
    (n) => (globalThis as unknown as { __openDockFullView(x: string): void }).__openDockFullView(n),
    id,
  );
}

/** Boot the DEFAULT shell (no `shell` query at all — the surface a player
 *  meets) and spawn one AUDIO IN. */
async function bootWithAudioIn(page: Page): Promise<void> {
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: BOOT_MS });
  await spawnPatch(page, [{ id: NODE, type: 'audioIn', position: { x: 160, y: 160 } }], []);
}

/**
 * Get the node STREAMING through the face, and prove it is really open.
 *
 * ⚠ THE ARRANGE HAS TWO LEGAL PATHS AND MUST TOLERATE BOTH. This project
 * pre-grants the microphone, so `enumerateDevices()` returns labels and
 * `bindAudioInputSurface` takes its ONE unattended acquire the moment a surface
 * binds — the same convenience a returning user gets. The action button is
 * therefore usually already showing STOP. Clicking it then would CLOSE the
 * input this spec needs, so the click is conditional on the button still
 * offering an acquire, read off its own `data-action`.
 *
 * The wait itself runs IN THE PAGE (`waitForFunction`), not as a Playwright-side
 * poll of a page-side value: each round trip would run on the same main thread
 * as the acquire it is waiting for.
 */
async function arrangeStreaming(page: Page): Promise<void> {
  const tileAction = page
    .locator(`[data-audioin-node="${NODE}"][data-testid="audioin-tile-controls"]`)
    .getByTestId('audioin-tile-action');
  await expect(tileAction, 'the LANE TILE must carry the acquire gesture').toBeVisible({
    timeout: BOOT_MS,
  });
  const kind = await tileAction.getAttribute('data-action');
  if (kind === 'enable' || kind === 'retry' || kind === 'retry-permission') {
    await tileAction.click();
  }

  await page.waitForFunction(
    (n) => {
      const w = globalThis as unknown as { __nodeAudioInput(x: string): InputProbe };
      return w.__nodeAudioInput(n).streaming === true;
    },
    NODE,
    { timeout: BOOT_MS },
  );

  const live = await probe(page);
  expect(
    live.trackLive,
    `acquired but the track is not live — the ARRANGE failed, so nothing below would mean ` +
      `anything: ${JSON.stringify(live)}`,
  ).toBe(true);
  expect(live.tracks).toBeGreaterThan(0);
  expect(live.liveChannels).toBeGreaterThan(0);
}

/**
 * THE POSITIVE CONTROL, and it is load-bearing in both tests.
 *
 * "Survives an unmount" is only meaningful if teardown CAN still happen — a
 * registry that simply never releases would pass every assertion above while
 * leaking the user's microphone for the life of the tab. Deleting the node from
 * the graph must stop the tracks.
 */
async function assertDeletingTheNodeReleasesIt(page: Page): Promise<void> {
  await page.evaluate((n) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, unknown> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      delete w.__patch.nodes[n];
    });
  }, NODE);

  await page.waitForFunction(
    (n) => {
      const w = globalThis as unknown as { __nodeAudioInput(x: string): InputProbe };
      return w.__nodeAudioInput(n).trackLive === false;
    },
    NODE,
    { timeout: BOOT_MS },
  );
}

test('LEG A — a live input survives its DOCK PANE being collapsed (the face body unmounts)', async ({
  page,
}) => {
  await bootWithAudioIn(page);
  await arrangeStreaming(page);

  // The pane mounts `fullViewBody`, a component with its own binding effect.
  await openFullView(page);
  const pane = page.locator('.dock-fullview-pane');
  await expect(pane).toBeVisible({ timeout: BOOT_MS });
  const paneBody = pane.locator(
    `[data-audioin-node="${NODE}"][data-testid="audioin-face-controls"]`,
  );
  await expect(
    paneBody,
    'the dock pane must render the FACE body, not the legacy card — this spec is about the ' +
      'shipping surface',
  ).toBeVisible();

  // ── ACT: collapse. This UNMOUNTS the full-view body. ──
  await page.getByTestId('faceplate-collapse').click();
  await expect(
    page.locator(`[data-audioin-node="${NODE}"][data-testid="audioin-face-controls"]`),
    'the ACT must really unmount the body — otherwise this leg proves nothing. (Scoped to THIS ' +
      'node: the canvas-hidden `pinned-audioIn` renders the same body in the always-mounted 🎧 ' +
      'tray, so an unscoped locator would never reach zero.)',
  ).toHaveCount(0);

  // ── ASSERT: the input is untouched. ──
  const after = await probe(page);
  expect(
    after.trackLive,
    `collapsing the dock pane STOPPED the capture track — this is the #1590 defect through the ` +
      `face body's own lifecycle, and it is irreversible. probe=${JSON.stringify(after)}`,
  ).toBe(true);
  expect(after.streaming, JSON.stringify(after)).toBe(true);

  // …and it is STILL live a moment later — a teardown scheduled by the unmount
  // (a queued microtask, a deferred effect cleanup) would land after the
  // synchronous check above and read as a pass.
  await expect
    .poll(async () => (await probe(page)).trackLive, {
      message: 'the track was stopped shortly AFTER the collapse — a deferred teardown',
      timeout: 3_000,
    })
    .toBe(true);

  // Re-expanding ADOPTS the live entry rather than coming up idle.
  await openFullView(page);
  await expect(paneBody.getByTestId('audioin-face-action')).toHaveAttribute('data-action', 'stop', {
    timeout: BOOT_MS,
  });
  const reopened = await probe(page);
  expect(
    reopened.streaming,
    `re-expanding showed a surface that had forgotten the live input: ${JSON.stringify(reopened)}`,
  ).toBe(true);

  await assertDeletingTheNodeReleasesIt(page);
});

test('LEG B — a live input survives having NO mounted surface at all (canvas-hidden)', async ({
  page,
}) => {
  await bootWithAudioIn(page);
  await arrangeStreaming(page);

  // ── ACT: take the node OFF THE CANVAS entirely (`data.hiddenCard`).
  //
  // ⚠ THIS IS THE ONLY REMAINING ROUTE TO ZERO SURFACES ON A FACED MODULE, AND
  // IT WAS ARRIVED AT BY ELIMINATION RATHER THAN BY PREFERENCE. On a promoted
  // module the lane tile's `ModuleShell` (and therefore its `tileBody`) is
  // UNCONDITIONAL, so collapsing the dock pane leaves a surface mounted (that is
  // LEG A). Docking would give a `dockStub` lane and a rail that can
  // snap-collapse to a strip, but `audioIn` is not in `DOCKABLE_TYPES`, so no
  // dock gesture is offered for it at all. And the pinned `pinned-audioIn` is
  // canvas-hidden with its 🎧 tray mounted for the life of the page. A
  // canvas-hidden USER-SPAWNED node is the remaining case: `isCanvasHiddenNode`
  // drops it from `flowNodes` while it is STILL IN THE GRAPH, so
  // `nodeAudioInput.sweep(liveIds)` must keep its entry.
  //
  // ⚠ RE-POINTED, NOT WEAKENED. The ACT used to fold the node into a COLLAPSED
  // GROUP (the shape `grouping-phase1.spec.ts` established). The GROUP! module
  // is deleted, and the group was only ever the mechanism — the subject is
  // "in the graph, zero surfaces mounted". `data.hiddenCard`
  // ($lib/graph/hidden-card.ts, a KEEP file precisely because saved patches
  // carry it) reaches the identical state through the path the product still
  // ships, so this drives a live mechanism rather than a retired one.
  await page.evaluate((n) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, Record<string, unknown>> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const child = w.__patch.nodes[n];
      if (child) {
        if (!child.data) child.data = {};
        (child.data as Record<string, unknown>).hiddenCard = true;
      }
    });
  }, NODE);

  // THE INSTRUMENT CHECK, and it is what stops this leg going quiet the way the
  // pre-promotion ACT would have: the node is gone from the canvas entirely, and
  // NOTHING belonging to it is mounted anywhere in the document.
  await expect(
    page.locator(`.svelte-flow__node[data-id="${NODE}"]`),
    'a folded child must have no canvas presence — if it still has a tile, the ACT did nothing',
  ).toHaveCount(0);
  await expect(
    page.locator(`[data-audioin-node="${NODE}"]`),
    'the ACT must leave THIS node with ZERO mounted surfaces — that is the state the original ' +
      'defect was reported from, and the only one that tests the REGISTRY rather than a ' +
      'component. (Scoped by node id: the canvas-hidden `pinned-audioIn` keeps its own body ' +
      'mounted in the 🎧 tray for the life of the page, so a document-wide count can never be 0.)',
  ).toHaveCount(0);

  // ── ASSERT: the input is untouched. ──
  const after = await probe(page);
  expect(
    after.trackLive,
    `the node lost its LAST surface and the capture track was STOPPED — this is #1590 exactly, ` +
      `and it is irreversible: the device cannot be recovered without a fresh getUserMedia. ` +
      `probe=${JSON.stringify(after)}`,
  ).toBe(true);
  expect(after.streaming, JSON.stringify(after)).toBe(true);
  expect(after.liveChannels).toBeGreaterThan(0);

  // …and STILL live a moment later — a teardown scheduled by the unmount (a
  // queued microtask, a deferred effect cleanup) would land after the
  // synchronous check above and read as a pass.
  await expect
    .poll(async () => (await probe(page)).trackLive, {
      message: 'the track was stopped shortly AFTER the last surface unmounted — a deferred teardown',
      timeout: 3_000,
    })
    .toBe(true);

  // ── UNGROUP: the tile comes back and ADOPTS the live entry rather than
  // coming up idle. (Whether a re-mount could RE-ACQUIRE instead of adopting is
  // not visible from here — both end in `streaming` with a live track, and the
  // probe carries no stream identity. The once-per-NODE claim that decides it,
  // `beginAutoAcquire` after a deliberate STOP, is asserted directly in
  // `audioin-face-model.test.ts`.)
  await page.evaluate((n) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, Record<string, unknown>> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const child = w.__patch.nodes[n];
      if (child?.data) delete (child.data as Record<string, unknown>).hiddenCard;
    });
  }, NODE);

  await expect(
    page
      .locator(`[data-audioin-node="${NODE}"][data-testid="audioin-tile-controls"]`)
      .getByTestId('audioin-tile-action'),
  ).toHaveAttribute('data-action', 'stop', { timeout: BOOT_MS });
  const reopened = await probe(page);
  expect(
    reopened.streaming,
    `the tile came back with a forgotten input: ${JSON.stringify(reopened)}`,
  ).toBe(true);

  await assertDeletingTheNodeReleasesIt(page);
});
