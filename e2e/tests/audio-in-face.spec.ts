// e2e/tests/audio-in-face.spec.ts
//
// AUDIO IN on the DEFAULT SHELL — the surface a player actually meets.
//
// ── WHY A NEW FILE, WHICH IS THE FINDING ───────────────────────────────────
//
// Every existing AUDIO IN spec drives `?shell=legacy`: `audio-in.spec.ts` boots
// `/rack?shell=legacy&seed=none` for all five of its tests, and the 🎧 panel's
// own VRT scene (`workflow-audio-io-composite`) does the same. Under that flag
// `shellFaces` is false, `laneRenderKind` returns `'legacy'` BEFORE `migrated`
// is ever read, and the legacy card renders — so the whole of that coverage
// stays green after promotion while covering a surface no player meets. A green
// legacy suite is not evidence about a face.
//
// This file is the other arm. It boots `/rack` with no `shell` query at all and
// asserts the things the promotion actually moved:
//
//   * `nodeAudioInput.adopt` — which had exactly ONE caller in the tree
//     (`AudioinCard.svelte`'s effect) and without which `request()` returns IDLE
//     and `view()` reads idle forever. `audioIn` is in neither
//     `DOM_SOURCE_LANE_TYPES` nor `CARD_PRODUCER_LANE_TYPES`, so after promotion
//     NO card is mounted anywhere — not even the off-screen
//     `<HeadlessSourceHost>` copy that keeps `cameraInput` alive. If the face
//     failed to adopt, the module would be silent and every def-reading gate
//     would stay green.
//   * REAL AUDIO THROUGH THE MODULE, at a `scope` analyser rather than at an
//     intermediate "an edge exists" assertion.
//   * THE TILE's acquire gesture, which is the only route to a first
//     `getUserMedia` grant on a faced AUDIO IN.
//   * The two persisted keys the picker and the music-mode switch write.
//
// ── WHAT THIS FILE STRUCTURALLY CANNOT SEE ─────────────────────────────────
//
//   * A REAL microphone. The device here is Chromium's synthetic one and the
//     permission is pre-granted by the project config, so the FIRST-GRANT
//     dialog — the one the ENABLE button exists for — is never actually shown.
//     What is proved is that the gesture reaches `getUserMedia` and opens a
//     device; that a real browser prompt appears on a real first click is an
//     owner hardware check.
//   * `hasLabels`. The pre-grant means `enumerateDevices()` always returns
//     labelled entries here, so the no-prior-grant branch of
//     `bindAudioInputSurface` (the one that makes a fresh visitor's page load
//     prompt-free, and the one that makes this face's VRT scenes deterministic)
//     is exercised by every OTHER project rather than asserted here.
//   * The 🎧 tray's arm. That is `workflow-audio-io-face.spec.ts`, which reads
//     `strictFace` off the registry manifest and therefore FLIPS ITSELF on this
//     promotion rather than being edited by it.
//
// LANE: this spec needs the fake mic, so it is named in the `chromium-audio-in`
// project's `testMatch` AND in the default project's `testIgnore` — both edited
// in the same diff. A spec that needs the mic and is named in neither would run
// in the default project, where getUserMedia is deliberately kept failing.

import { test, expect, type Page } from './_fixtures';
import { spawnPatch } from './_helpers';
import { pollScopePeak, scopePollMsg } from '../_helpers/scope-poll';
import { BOOT_MS, SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';

// Cold boot on the DEFAULT shell (faceplates + the seeded video zone) is the
// slowest goto in the suite. A bound, not an assertion.
test.describe.configure({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

const NODE = 'ain';
const SCOPE = 'sc';

interface InputProbe {
  state: string;
  streaming: boolean;
  trackLive: boolean;
  tracks: number;
  liveChannels: number;
  deviceId: string | null;
}

async function probe(page: Page, id = NODE): Promise<InputProbe> {
  return page.evaluate(
    (n) =>
      (globalThis as unknown as { __nodeAudioInput(x: string): InputProbe }).__nodeAudioInput(n),
    id,
  );
}

/** This node's saved keys, read off the live patch rather than off a control. */
async function savedData(page: Page, id = NODE): Promise<Record<string, unknown>> {
  return page.evaluate((n) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
    };
    return { ...(w.__patch.nodes[n]?.data ?? {}) };
  }, id);
}

/** The LANE TILE's own controls for this node — scoped by node id, because the
 *  canvas-hidden `pinned-audioIn` renders the same component in the 🎧 tray for
 *  the life of the page and an unscoped testid would be ambiguous. */
function tileControls(page: Page, id = NODE) {
  return page.locator(`[data-audioin-node="${id}"][data-testid="audioin-tile-controls"]`);
}

/** Wait IN THE PAGE for the node's capture state. Never a Playwright-side poll:
 *  each round trip runs on the same main thread as the acquire it waits on. */
async function waitForState(page: Page, want: string, id = NODE): Promise<void> {
  await page.waitForFunction(
    ([n, s]) => {
      const w = globalThis as unknown as { __nodeAudioInput(x: string): InputProbe };
      return w.__nodeAudioInput(n).state === s;
    },
    [id, want] as const,
    { timeout: BOOT_MS },
  );
}

async function bootDefaultShell(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: BOOT_MS });
  return errors;
}

test('the FACE alone adopts, acquires and drives real audio — with no card anywhere', async ({
  page,
}) => {
  const errors = await bootDefaultShell(page);

  await spawnPatch(
    page,
    [
      { id: NODE, type: 'audioIn', position: { x: 160, y: 160 } },
      { id: SCOPE, type: 'scope', position: { x: 520, y: 160 }, params: { timeMs: 50 } },
    ],
    [
      {
        id: 'e-ain-sc',
        from: { nodeId: NODE, portId: 'audio_l_out' },
        to: { nodeId: SCOPE, portId: 'ch1' },
        sourceType: 'audio',
        targetType: 'audio',
      },
    ],
  );

  // ── THE PRECONDITION THIS FILE EXISTS FOR: there is no card. ──
  const tile = tileControls(page);
  await expect(tile, 'the lane tile must render the face body').toBeVisible({ timeout: BOOT_MS });
  await expect(
    page.locator(`.svelte-flow__node-audioIn`),
    'a promoted module must not render its legacy card in the lane — if it does, everything ' +
      'below is testing the card again and the promotion is not what is under test',
  ).toHaveCount(0);
  await expect(
    page.locator(`[data-audioin-node="${NODE}"] [data-testid="audioin-device-select"]`),
    'neither body may reuse the CARD-ONLY testid: `workflow-audio-io-face.spec.ts` uses it as ' +
      'the positive marker that the 🎧 tray mounted the verbatim card',
  ).toHaveCount(0);

  // ── ADOPT + ACQUIRE, from the face's own binding effect. ──
  await waitForState(page, 'streaming');
  const live = await probe(page);
  expect(live.trackLive, JSON.stringify(live)).toBe(true);
  expect(
    live.liveChannels,
    'the delivered channel layout must be reported — 0 means the attach never happened',
  ).toBeGreaterThan(0);

  // The acquire persists what actually opened, so a reload re-opens the same
  // physical input. (`onResolved` → `setInputDevice`.)
  expect(
    (await savedData(page))['deviceId'],
    'the resolved device must be saved by the acquire itself, not only by a manual pick',
  ).toBeTruthy();

  // ── REAL AUDIO, at an analyser rather than at an "an edge exists" proxy. ──
  const r = await pollScopePeak(page, SCOPE, 0.01, BOOT_MS);
  expect(
    r.peak,
    scopePollMsg(
      `AUDIO IN drove no signal into SCOPE.ch1 through the FACE (peak ${r.peak.toFixed(4)}). ` +
        `The engine attach is what the promotion had to carry: adopt() had exactly one caller ` +
        `and it was the card`,
      r,
    ),
  ).toBeGreaterThan(0.01);
  expect(r.samples, scopePollMsg('the poll never reduced a buffer', r)).toBeGreaterThan(0);

  expect(
    errors.filter((e) => !/getUserMedia|mediaDevices|permission/i.test(e)),
    errors.join(' | '),
  ).toEqual([]);
});

test('the TILE carries the gesture that opens the device, and both picks persist', async ({
  page,
}) => {
  const errors = await bootDefaultShell(page);
  await spawnPatch(page, [{ id: NODE, type: 'audioIn', position: { x: 160, y: 160 } }], []);

  const tile = tileControls(page);
  await expect(tile).toBeVisible({ timeout: BOOT_MS });
  const action = tile.getByTestId('audioin-tile-action');
  const select = tile.getByTestId('audioin-tile-device');

  // The project pre-grants the mic, so the unattended acquire runs first and the
  // button is already offering STOP.
  await waitForState(page, 'streaming');
  await expect(action).toHaveAttribute('data-action', 'stop');

  // ── STOP is obeyed, and it is a real release. ──
  await action.click();
  await waitForState(page, 'idle');
  const stopped = await probe(page);
  expect(
    stopped.trackLive,
    `STOP must actually release the device: ${JSON.stringify(stopped)}`,
  ).toBe(false);

  // ── …AND IT STAYS STOPPED. The unattended acquire is claimed ONCE PER NODE,
  // so nothing re-opens the input behind the player's back. A guard that only
  // read the state would re-acquire here, and the STOP button would be
  // un-obeyable. Bounded, then re-read — the state must still be idle.
  await expect
    .poll(async () => (await probe(page)).state, {
      message: 'the node re-acquired on its own after a deliberate STOP',
      timeout: 2_000,
    })
    .toBe('idle');

  // ── ENABLE, ON THE TILE, reaches getUserMedia. This is the gesture the whole
  // `tileBody` exists for: on a faced AUDIO IN it is the only route to a first
  // permission grant, and `cameraInput` shipped without it.
  await expect(action).toHaveAttribute('data-action', 'enable');
  await action.click();
  await waitForState(page, 'streaming');
  expect((await probe(page)).trackLive).toBe(true);

  // ── THE DEVICE PICK writes the shared key every surface reads. ──
  const values = await select.evaluate((el) =>
    [...(el as HTMLSelectElement).options].map((o) => o.value).filter((v) => v !== ''),
  );
  expect(
    values.length,
    `the fake-device roster offered ${values.length} audioinput(s) (${values.join(', ')}). This ` +
      `test needs two to prove a PICK writes the key rather than the acquire having written it.`,
  ).toBeGreaterThan(1);
  const current = (await savedData(page))['deviceId'];
  const other = values.find((v) => v !== current) ?? values[0]!;
  await select.selectOption(other);
  await expect
    .poll(async () => (await savedData(page))['deviceId'], {
      message: 'picking a device did not write node.data.deviceId',
      timeout: BOOT_MS,
    })
    .toBe(other);

  // ── MUSIC MODE persists AND re-acquires (the capture DSP constraints cannot
  // be changed on a live track, so the switch has to re-open the device).
  await tile.getByTestId('audioin-tile-music-mode').check();
  await expect
    .poll(async () => (await savedData(page))['musicMode'], {
      message: 'music mode did not persist to node.data',
      timeout: BOOT_MS,
    })
    .toBe(true);
  await waitForState(page, 'streaming');
  const afterMusic = await probe(page);
  expect(
    afterMusic.trackLive,
    `music mode re-acquired and left the input dead: ${JSON.stringify(afterMusic)}`,
  ).toBe(true);

  expect(
    errors.filter((e) => !/getUserMedia|mediaDevices|permission/i.test(e)),
    errors.join(' | '),
  ).toEqual([]);
});
