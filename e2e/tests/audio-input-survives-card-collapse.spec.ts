// e2e/tests/audio-input-survives-card-collapse.spec.ts
//
// AUDIO IN must keep streaming when its card goes away (#1590, from the #1583
// audit).
//
// `AudioinCard` ran `onDestroy(() => stopStream())`, and `stopStream()` calls
// `t.stop()` on every getUserMedia track. A card unmounts on COLLAPSE, on dock
// LRU eviction when a third module is expanded, on ESC, on M/E and on
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
// THE INSTRUMENT. `__nodeAudioInput(id)` reports `trackLive`, read from the
// real `MediaStreamTrack.readyState` — deliberately not the registry's own
// opinion of whether it is streaming. A probe that echoed registry state could
// report a cheerful `streaming: true` over a device that was already dead,
// which is precisely the failure this spec exists to catch.
//
// Fake devices come from `--use-fake-device-for-media-stream` +
// `--use-fake-ui-for-media-stream` (playwright.config.ts), so the permission
// prompt is auto-granted and a synthetic audio device is always present — this
// runs on CI, it is not a capability-gated local-only test.

import { test, expect, type Page } from './_fixtures';
import { spawnPatch } from './_helpers';

const NODE = 'ain';

interface InputProbe {
  state: string;
  streaming: boolean;
  trackLive: boolean;
  tracks: number;
  liveChannels: number;
}

/** The NODE's own view of its input — never read off the card, which is the
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

test('a live input SURVIVES its card being collapsed — and the graph still releases it', async ({
  page,
}) => {
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 30_000 });
  await spawnPatch(page, [{ id: NODE, type: 'audioIn', position: { x: 160, y: 160 } }], []);

  // ── ARRANGE: acquire the device through the real card control. ──
  await openFullView(page);
  // ⚠ SCOPE TO THE PANE. AUDIO IN is also a PINNED TOPBAR SURFACE, so an
  // unscoped testid resolves to two cards — the topbar's and this node's — and
  // the spec would be driving whichever one Playwright picked. The pinned one
  // is a different node with a different lifetime and is not what is under test.
  const pane = page.locator('.dock-fullview-pane');
  await expect(pane).toBeVisible({ timeout: 15_000 });

  // ⚠ The card may already be STREAMING by the time the pane paints: this
  // project pre-grants `microphone`, so `enumerateDevices` returns real labels
  // and the card takes its auto-acquire path (the same convenience a returning
  // user gets once permission is remembered). The enable button only exists in
  // idle / denied / error, so REQUIRING it would fail on the healthy path.
  // Click it only if the card is actually waiting for a decision.
  const enable = pane.getByTestId('audioin-enable');
  if (await enable.isVisible().catch(() => false)) await enable.click();

  await expect
    .poll(async () => JSON.stringify(await probe(page)), {
      message:
        'the fake capture device never attached — the spec cannot test what it is for. ' +
        'The probe is printed so a bad ARRANGE (no device enumerated, permission path, ' +
        'disabled button) is distinguishable from the defect itself.',
      timeout: 20_000,
    })
    .toContain('"streaming":true');

  const live = await probe(page);
  expect(live.trackLive, `acquired but the track is not live: ${JSON.stringify(live)}`).toBe(true);
  expect(live.tracks).toBeGreaterThan(0);

  // ── ACT: collapse. This UNMOUNTS AudioinCard. ──
  await page.getByTestId('faceplate-collapse').click();

  // ── ASSERT: the input is untouched. This is the whole regression. ──
  const afterCollapse = await probe(page);
  expect(
    afterCollapse.trackLive,
    `the collapse STOPPED the capture track — this is the #1590 defect, and it is ` +
      `irreversible: the device cannot be recovered without a fresh getUserMedia. ` +
      `probe=${JSON.stringify(afterCollapse)}`,
  ).toBe(true);
  expect(
    afterCollapse.streaming,
    `the node stopped reporting a live input after its card unmounted: ${JSON.stringify(afterCollapse)}`,
  ).toBe(true);
  expect(afterCollapse.liveChannels).toBeGreaterThan(0);

  // …and it is STILL live a moment later — a teardown scheduled by the unmount
  // (a queued microtask, a deferred effect cleanup) would land after the
  // synchronous check above and read as a pass.
  await expect
    .poll(async () => (await probe(page)).trackLive, {
      message: 'the track was stopped shortly AFTER the collapse — a deferred teardown',
      timeout: 3_000,
    })
    .toBe(true);

  // ── Re-expanding adopts the LIVE entry, not a fresh idle one. ──
  await openFullView(page);
  await expect(pane.getByTestId('audioin-disable')).toBeVisible({ timeout: 10_000 });
  const reopened = await probe(page);
  expect(
    reopened.streaming,
    `re-expanding showed a card that had forgotten the live input: ${JSON.stringify(reopened)}`,
  ).toBe(true);

  // ── POSITIVE CONTROL, and it is load-bearing. ──
  // "Survives collapse" is only meaningful if teardown CAN still happen — a
  // registry that simply never releases would pass every assertion above while
  // leaking the user's microphone for the life of the tab. Deleting the node
  // from the graph must stop the tracks.
  await page.evaluate((n) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, unknown> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      delete w.__patch.nodes[n];
    });
  }, NODE);

  await expect
    .poll(async () => (await probe(page)).trackLive, {
      message:
        'deleting the node did NOT release the capture device — the registry leaks the mic for the life of the tab, ' +
        'which would also make every assertion above vacuous',
      timeout: 10_000,
    })
    .toBe(false);
});
