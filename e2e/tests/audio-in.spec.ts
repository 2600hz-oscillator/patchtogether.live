// e2e/tests/audio-in.spec.ts
//
// AUDIO IN module — end-to-end demo verification under Chromium's fake
// audio device (440 Hz sine produced by --use-fake-device-for-media-stream).
//
// Runs under the dedicated `chromium-audio-in` Playwright project so the
// fake-mic launch flag doesn't leak into other specs (which rely on
// getUserMedia failing predictably with NotAllowedError in headless).
//
// Coverage:
//   1. Spawn AUDIO IN + SCOPE; patch audio_l_out → SCOPE.ch1; assert
//      scope shows non-silence (fake-device synthetic sine = ~440 Hz).
//   2. Spawn 2× AUDIO IN; assert both can coexist (factory + card both
//      handle multiple instances without singleton bumping).
//   3. AUDIO OUT smoke: dropdown renders + lists >= 1 audiooutput entry
//      under fake-media (enumerateDevices works). We don't try to
//      validate setSinkId routing in headless.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { pollScopePeak, pollScopeStereoPeaks, scopePollMsg } from '../_helpers/scope-poll';
import { BOOT_MS, SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';

async function setupPage(page: import('@playwright/test').Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/rack?seed=none');
  await page.waitForLoadState('networkidle');
  return errors;
}

/**
 * Drive AUDIO IN to the `streaming` state, robust against the auto-acquire
 * race. The chromium-audio-in project pre-grants microphone permission, so
 * the card USUALLY auto-acquires on mount and the "Click to enable" button
 * never appears (or appears for a single frame then detaches when the
 * stream attaches). The old inline `if (visible) click({force})` raced that
 * detach. Instead: wait for the dropdown to populate, then poll — if the
 * status is already (or becomes) `streaming` we're done; only when a
 * SETTLED, actionable enable button is present do we click it (and we wait
 * for it to be enabled first, never force-clicking a `disabled` button).
 */
async function ensureAudioInStreaming(
  page: import('@playwright/test').Page,
  id = 'ai',
): Promise<void> {
  // On the default shell the tile body carries the controls and the state is
  // read off the node-input registry probe (`__nodeAudioInput`) — the same
  // seam the face arm below waits on. The tile action is only pressed when a
  // SETTLED, enabled button is offered (auto-acquire usually beats it).
  // Lane tiles carry the compact controls; the pinned 🎧 tray hosts the FACE
  // body — accept whichever surface this node renders.
  const tile = page
    .locator(
      `[data-audioin-node="${id}"][data-testid="audioin-tile-controls"], ` +
        `[data-testid="workflow-io-audioin-host"] [data-testid="audioin-source-body"]`,
    )
    .first();
  await expect(tile).toBeVisible();
  const action = tile.locator('[data-testid$="-action"]').first();
  const deadline = Date.now() + 10_000;
  const state = () =>
    page.evaluate(
      (n) => (globalThis as unknown as { __nodeAudioInput(x: string): { state: string } }).__nodeAudioInput(n).state,
      id,
    );
  while (Date.now() < deadline) {
    if ((await state()) === 'streaming') return;
    if ((await action.count()) > 0 && (await action.isEnabled().catch(() => false))) {
      await action.click({ noWaitAfter: true }).catch(() => { /* raced auto-acquire */ });
    }
    await page.waitForTimeout(150);
  }
  await faceWaitForState(page, 'streaming', id);
}

test.describe('AUDIO IN → SCOPE (fake mic)', () => {
  test('streams the fake 440 Hz sine to SCOPE.ch1 (non-silence)', async ({ page }) => {
    const errors = await setupPage(page);

    await spawnPatch(
      page,
      [
        { id: 'ai', type: 'audioIn', position: { x: 80, y: 60 } },
        { id: 'sc', type: 'scope', position: { x: 380, y: 60 }, params: { timeMs: 50 } },
      ],
      [
        {
          id: 'e-ai-sc',
          from: { nodeId: 'ai', portId: 'audio_l_out' },
          to: { nodeId: 'sc', portId: 'ch1' },
          sourceType: 'audio',
          targetType: 'audio',
        },
      ],
    );

    await expect(page.locator('.svelte-flow__node:has([data-shell-type="audioIn"])'), 'AUDIO IN tile visible').toBeVisible();
    await expect(page.locator('.svelte-flow__node:has([data-shell-type="scope"])'), 'SCOPE tile visible').toBeVisible();

    // Device dropdown populates from enumerateDevices on mount, then the
    // card auto-acquires (mic pre-granted) → status reaches 'streaming'.
    await ensureAudioInStreaming(page);

    // Give the audio graph a beat to actually push samples into the
    // scope buffer. Fake-device starts emitting immediately on track
    // start so a small wait is enough.
    await page.waitForTimeout(800);

    // Read the SCOPE's own analyser (the DOM-free instrument every rewritten
    // spec uses on the shell — the card's trace canvas died with the card).
    const r = await pollScopePeak(page, 'sc', 0.01, 10_000);
    expect(
      r.peak,
      scopePollMsg(`fake-mic sine never reached SCOPE.ch1 (peak ${r.peak.toFixed(4)})`, r),
    ).toBeGreaterThan(0.01);

    // No fatal errors. AUDIO IN's permission-related warnings (if any
    // fired) log to console.warn, not console.error.
    expect(errors.filter((e) => !/getUserMedia|audio/i.test(e)), errors.join('; ')).toEqual([]);
  });

  test('exposes BOTH L and R outputs of the stereo pair (both non-silent)', async ({ page }) => {
    // ES-9 stereo-pair-IN first step: AUDIO IN requests a 2-channel
    // capture, so patching BOTH audio_l_out + audio_r_out must land
    // signal on each. The fake device drives a sine on both channels, so
    // both SCOPE traces should be non-flat. (True channel SEPARATION —
    // L ≠ R — can only be verified on the physical ES-9 with different
    // sources on inputs 1 + 2; this gate just proves both outputs are
    // wired + carry the captured signal rather than one being dead.)
    const errors = await setupPage(page);

    await spawnPatch(
      page,
      [
        { id: 'ai', type: 'audioIn', position: { x: 80, y: 60 } },
        { id: 'sc', type: 'scope', position: { x: 380, y: 60 }, params: { timeMs: 50 } },
      ],
      [
        {
          id: 'e-l',
          from: { nodeId: 'ai', portId: 'audio_l_out' },
          to: { nodeId: 'sc', portId: 'ch1' },
          sourceType: 'audio',
          targetType: 'audio',
        },
        {
          id: 'e-r',
          from: { nodeId: 'ai', portId: 'audio_r_out' },
          to: { nodeId: 'sc', portId: 'ch2' },
          sourceType: 'audio',
          targetType: 'audio',
        },
      ],
    );

    await expect(page.locator('.svelte-flow__node:has([data-shell-type="audioIn"])')).toBeVisible();

    await ensureAudioInStreaming(page);
    await page.waitForTimeout(800);

    // BOTH channels at the analyser — ch1 (L) and ch2 (R) each read via the
    // SCOPE's own snapshot (the card trace canvas died with the card). The
    // loop runs IN THE PAGE: the Playwright-side expect.poll this replaces
    // read a constant 0.0015 on a healthy chain (one CDP round trip per
    // sample, starving the thread it measured — the scope-poll rationale).
    const both = await pollScopeStereoPeaks(page, 'sc', 0.01, 10_000);
    expect(
      Math.min(both.peakL, both.peakR),
      scopePollMsg(
        `both L (ch1) and R (ch2) must carry the captured signal ` +
          `(L=${both.peakL.toFixed(4)} R=${both.peakR.toFixed(4)})`,
        both,
      ),
    ).toBeGreaterThan(0.01);

    expect(errors.filter((e) => !/getUserMedia|audio/i.test(e)), errors.join('; ')).toEqual([]);
  });

  test('two AUDIO IN cards can coexist (not a singleton)', async ({ page }) => {
    await setupPage(page);
    await spawnPatch(page, [
      { id: 'ai1', type: 'audioIn', position: { x: 80, y: 60 } },
      { id: 'ai2', type: 'audioIn', position: { x: 360, y: 60 } },
    ]);

    // Both tiles should mount — the def's maxInstances is unset, so the
    // engine singleton guard shouldn't kick in.
    await expect(page.locator('.svelte-flow__node:has([data-shell-type="audioIn"])')).toHaveCount(2);
  });

  test('music-mode toggle re-acquires the stream without error', async ({ page }) => {
    // Music mode forces the browser capture DSP (echo-cancel / noise-
    // suppress / auto-gain) OFF for a clean line-level feed. Toggling it
    // re-runs getUserMedia (constraints can't change on a live track). The
    // fake device honours the constraints fine; this gate proves the toggle
    // is wired + the re-acquire returns to `streaming` with no fatal error.
    const errors = await setupPage(page);

    await spawnPatch(page, [
      { id: 'ai', type: 'audioIn', position: { x: 80, y: 60 } },
    ]);
    await expect(page.locator('.svelte-flow__node:has([data-shell-type="audioIn"])')).toBeVisible();
    await ensureAudioInStreaming(page);

    // Music mode is a NON-compact control — the dock face body's toggle
    // (the compact tile keeps only lamp + picker + action).
    await page.evaluate(
      (id) => (globalThis as unknown as { __openDockFullView: (id: string) => void }).__openDockFullView(id),
      'ai',
    );
    const toggle = page
      .locator('[data-testid="dock-fullview-pane"][data-pane-node="ai"]')
      .getByTestId('audioin-face-music-mode');
    await expect(toggle).toBeVisible();
    await expect(toggle).not.toBeChecked();

    await toggle.check();
    await expect(toggle).toBeChecked();

    // Re-acquire should settle back to streaming (the registry probe — the
    // card's status row died with the card).
    await faceWaitForState(page, 'streaming', 'ai');

    expect(errors.filter((e) => !/getUserMedia|audio/i.test(e)), errors.join('; ')).toEqual([]);
  });
});

test.describe('WORKFLOW audio I/O surface (🎧 always-on pinned AUDIO IN/OUT)', () => {
  // The workflow topbar's 1/8"-plug menu hosts the REAL AudioinCard +
  // AudioOutCard for the always-on pinned instances (canvas-hidden). This
  // spec lives in audio-in.spec.ts so it runs under the chromium-audio-in
  // project (fake mic + pre-granted permission) — the workflow surface is
  // exercised with a genuinely streaming device, per the real-source-chain
  // rule: menu patch-out → canvas SCOPE → signal visibly materializes.

  const WORKFLOW_PINNED_IDS = [
    'pinned-mixmstrs',
    'pinned-electraControl',
    'pinned-clipplayer',
    'pinned-timelorde',
    'pinned-midiclock',
    'pinned-audioIn',
    'pinned-audioOut',
  ];

  async function waitForWorkflowPins(page: import('@playwright/test').Page): Promise<void> {
    await page.waitForFunction(
      (ids) => {
        const w = globalThis as unknown as {
          __patch?: { nodes: Record<string, { data?: { pinned?: boolean } } | undefined> };
        };
        if (!w.__patch) return false;
        return ids.every((id) => w.__patch!.nodes[id]?.data?.pinned === true);
      },
      WORKFLOW_PINNED_IDS,
      { timeout: 10_000 },
    );
  }

  test('closed 🎧 panel paints NOTHING — the pinned card faces never ghost onto the canvas', async ({ page }) => {
    // Regression: the io-panel hid itself with `visibility: hidden`, but
    // xyflow stamps inline `visibility: visible` on every measured
    // .svelte-flow__node wrapper — visibility is child-overridable, so the
    // two hosted card faces painted as floating, non-draggable ghost cards
    // over a fresh workflow rack while the panel chrome stayed invisible
    // (owner report 2026-07-11, reproduced on dev). The fix hides the
    // panel with `opacity: 0` — opacity composites the WHOLE subtree and
    // no descendant can opt back in, which is why the assertion below pins
    // the computed opacity (Playwright's toBeVisible ignores opacity, and
    // the inner wrapper legitimately keeps visibility:visible).
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');
    await waitForWorkflowPins(page);

    const panel = page.getByTestId('workflow-io-panel');
    await expect(panel).toHaveAttribute('data-open', 'false');
    // The always-on lifecycle keeps both hosts MOUNTED while closed…
    await expect(panel.locator('[data-testid="workflow-io-audioin-host"]')).toHaveCount(1);
    await expect(panel.locator('[data-testid="workflow-io-audioout-host"]')).toHaveCount(1);
    // …but the closed panel must never paint: opacity 0 is the spec-level
    // "no pixels from this subtree" guarantee the visibility approach lacked.
    await expect(panel).toHaveCSS('opacity', '0');
    await expect(panel).toHaveCSS('pointer-events', 'none');

    // Open → the panel paints and the real card faces are usable.
    await page.getByTestId('workflow-topbar-slot-audio-io').click();
    await expect(panel).toHaveAttribute('data-open', 'true');
    await expect(panel).toHaveCSS('opacity', '1');
    await expect(
      panel.locator('[data-testid="workflow-io-audioin-host"] [data-testid="audioin-face-device"]'),
    ).toBeVisible();

    // Close again → back to zero paint (the stream-preserving mount stays).
    await page.getByTestId('workflow-topbar-slot-audio-io').click();
    await expect(panel).toHaveAttribute('data-open', 'false');
    await expect(panel).toHaveCSS('opacity', '0');
    await expect(panel.locator('[data-testid="workflow-io-audioin-host"]')).toHaveCount(1);
  });

  test('open 🎧 panel PLAIN-MOUNTS both card faces: unclipped, no flow host, no attribution', async ({ page }) => {
    // Regression (owner report 2026-07-11): the panel hosted the two card
    // faces in single-node SvelteFlow instances whose one-shot fitView fired
    // at mount — while the panel was hidden — against fixed 250×330 hosts:
    // the AUDIO IN card rendered CLIPPED at its host's left edge, AUDIO OUT
    // floated in dead space, and both hosts leaked the "Svelte Flow"
    // attribution badge. The fix plain-mounts both faces via DockCardHost
    // (the P2.5a drawer pattern). This pins the geometry: each card's box
    // sits fully INSIDE its host's box, and no flow chrome exists in the
    // panel at all.
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');
    await waitForWorkflowPins(page);

    await page.getByTestId('workflow-topbar-slot-audio-io').click();
    const panel = page.getByTestId('workflow-io-panel');
    await expect(panel).toHaveAttribute('data-open', 'true');

    // ZERO flow-host baggage inside the panel (the failure class is gone,
    // not patched around): no flow root, no attribution badge, no panes.
    await expect(panel.locator('.svelte-flow')).toHaveCount(0);
    await expect(panel.locator('.svelte-flow__attribution')).toHaveCount(0);
    // The plain-mount hosts carry the dock-card markers instead.
    await expect(panel.locator('[data-dock-card="pinned-audioIn"]')).toBeVisible();
    await expect(panel.locator('[data-dock-card="pinned-audioOut"]')).toBeVisible();

    // Geometry: each hosted card root fits fully inside its host column —
    // the pre-fix AUDIO IN card poked out past the host's LEFT edge.
    // The hosts mount FACE bodies now (the card roots died with the fleet);
    // the geometry claim is identical — each hosted surface fits its column.
    for (const [hostId, cardSel] of [
      ['workflow-io-audioin-host', '[data-dock-card="pinned-audioIn"] [data-testid="audioin-source-body"]'],
      ['workflow-io-audioout-host', '[data-dock-card="pinned-audioOut"] [data-testid="audioout-output-body"]'],
    ] as const) {
      const host = panel.locator(`[data-testid="${hostId}"]`);
      const hostBox = await host.boundingBox();
      const cardBox = await panel.locator(cardSel).first().boundingBox();
      expect(hostBox, `${hostId} box`).toBeTruthy();
      expect(cardBox, `${cardSel} box`).toBeTruthy();
      expect(cardBox!.x, `${hostId}: card left edge unclipped`).toBeGreaterThanOrEqual(hostBox!.x - 1);
      expect(cardBox!.y, `${hostId}: card top edge unclipped`).toBeGreaterThanOrEqual(hostBox!.y - 1);
      expect(
        cardBox!.x + cardBox!.width,
        `${hostId}: card right edge inside host`,
      ).toBeLessThanOrEqual(hostBox!.x + hostBox!.width + 1);
      expect(
        cardBox!.y + cardBox!.height,
        `${hostId}: card bottom edge inside host`,
      ).toBeLessThanOrEqual(hostBox!.y + hostBox!.height + 1);
    }

    // Close: the always-mounted lifecycle still holds (the #1068 pin).
    await page.getByTestId('workflow-topbar-slot-audio-io').click();
    await expect(panel).toHaveCSS('opacity', '0');
    await expect(panel.locator('[data-dock-card="pinned-audioIn"]')).toHaveCount(1);
  });

  test('menu patch-out wires pinned AUDIO IN → SCOPE and the fake-mic signal materializes', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');
    await waitForWorkflowPins(page);

    // A canvas destination for the patch-out. spawnPatch wipes the graph
    // (and boots the engine); the ensure effect re-spawns the pins.
    await spawnPatch(page, [
      { id: 'sc', type: 'scope', position: { x: 420, y: 200 }, params: { timeMs: 50 } },
    ]);
    await waitForWorkflowPins(page);

    // The pinned pair never renders as MAIN-CANVAS cards (`.flow` = the
    // rack flow; the topbar menu hosts their faces in its own flows).
    await expect(page.locator('.flow .svelte-flow__node[data-id="pinned-audioIn"]')).toHaveCount(0);
    await expect(page.locator('.flow .svelte-flow__node[data-id="pinned-audioOut"]')).toHaveCount(0);

    // Open the 🎧 menu: the REAL cards render inside the panel — the input
    // device picker (AudioinCard) + the output readout/picker (AudioOutCard).
    await page.getByTestId('workflow-topbar-slot-audio-io').click();
    const panel = page.getByTestId('workflow-io-panel');
    await expect(panel).toHaveAttribute('data-open', 'true');
    await expect(
      panel.locator('[data-testid="workflow-io-audioin-host"] [data-testid="audioin-face-device"]'),
    ).toBeVisible();
    // Output side: the device dropdown, or the setSinkId-unsupported notice.
    await page.waitForFunction(() => {
      const host = document.querySelector('[data-testid="workflow-io-audioout-host"]');
      if (!host) return false;
      const sel = host.querySelector('[data-testid="audioout-face-device-select"]') as HTMLSelectElement | null;
      const notice = host.querySelector('[data-testid="audioout-setsinkid-notice"]');
      return (sel !== null && sel.options.length > 0) || notice !== null;
    }, undefined, { timeout: 5_000 });

    // The hosted FACE body reaches `streaming` (fake mic, pre-granted) —
    // the same helper, keyed to the pinned node.
    await ensureAudioInStreaming(page, 'pinned-audioIn');

    // Click-driven patch-out: AUDIO IN L → the drill-down picker → SCOPE.ch1.
    await page.getByTestId('workflow-io-patchout-audio_l_out').click();
    const picker = page.locator('[data-testid="port-context-menu"]');
    await expect(picker).toBeVisible();
    await picker.locator('[data-testid="patch-to-module"][data-node-id="sc"]').click();
    const ch1 = picker.locator('[data-testid="patch-to-port"][data-port-id="ch1"]');
    await expect(ch1).toBeVisible();
    await ch1.click();

    // AUDIO IN's `audio_l_out`/`audio_r_out` are a derived stereo pair and
    // SCOPE's `ch1` is one mono probe, so the commit asks which channel first
    // (owner 2026-08-12). L is the leg this test has always been about — the
    // fake mic feeding the scope — and choosing it keeps the edge assertion
    // below identical.
    const chooser = page.getByTestId('stereo-drop-choice');
    await expect(chooser, 'a stereo source on a mono probe must ask').toBeVisible();
    await chooser.locator('[data-testid="stereo-drop-choice-option"][data-mode="left"]').click();
    await expect(chooser).toHaveCount(0);

    // The patch-out hand-off CLOSED the menu — from here on the panel is
    // hidden (not unmounted), so the signal assertions below double as the
    // "stream survives menu close" proof.
    await expect(panel).toHaveAttribute('data-open', 'false');

    // The edge materialized from the PINNED (canvas-hidden) source…
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const w = globalThis as unknown as {
            __patch: {
              edges: Record<
                string,
                { source: { nodeId: string; portId: string }; target: { nodeId: string; portId: string } } | undefined
              >;
            };
          };
          return Object.values(w.__patch.edges).some(
            (e) =>
              !!e &&
              e.source.nodeId === 'pinned-audioIn' &&
              e.source.portId === 'audio_l_out' &&
              e.target.nodeId === 'sc' &&
              e.target.portId === 'ch1',
          );
        }),
      { timeout: 5_000 })
      .toBe(true);

    // …and REAL signal flows down it, at the analyser.
    await page.waitForTimeout(800);
    const r2 = await pollScopePeak(page, 'sc', 0.01, 10_000);
    expect(
      r2.peak,
      scopePollMsg(`the pinned fake-mic signal never reached SCOPE.ch1 (peak ${r2.peak.toFixed(4)})`, r2),
    ).toBeGreaterThan(0.01);

    expect(errors.filter((e) => !/getUserMedia|audio/i.test(e)), errors.join('; ')).toEqual([]);
  });

  test('the pinned AUDIO OUT exposes a source picker (receive-from rows) like an added one (bug 1)', async ({ page }) => {
    // Owner bug 1: the DEFAULT (pinned) audio-out showed NO way to select a
    // source — an audio-out ADDED on the grid does (its input jacks open the
    // "patch from" picker). The panel now mirrors AUDIO IN's patch rows in
    // reverse: two "receive from" rows (AUDIO OUT L / R) that open the SAME
    // source picker, so the pinned instance behaves like an added one.
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');
    await waitForWorkflowPins(page);

    // Open the 🎧 panel.
    await page.getByTestId('workflow-topbar-slot-audio-io').click();
    const panel = page.getByTestId('workflow-io-panel');
    await expect(panel).toHaveAttribute('data-open', 'true');

    // The audio-out column now carries a discoverable source-selection affordance
    // (parity with the audio-in patch-out rows it sits opposite).
    const receiveRows = panel.getByTestId('workflow-io-patchin');
    await expect(receiveRows).toBeVisible();
    // ONE row, not two (PR-4 jack collapse): AUDIO OUT's `L`/`R` are a derived
    // stereo pair, so the panel shows a single stereo receive row addressed to
    // the LEFT leg — and the commit writes BOTH legs through planAudioCommit.
    // The R row is gone by design; assert its ABSENCE so a regression that
    // re-splits the pair is a red test rather than a silent visual change.
    await expect(panel.getByTestId('workflow-io-patchin-L')).toBeVisible();
    await expect(panel.getByTestId('workflow-io-patchin-R')).toHaveCount(0);
    await expect(panel.getByTestId('workflow-io-patchin-L')).toHaveAttribute(
      'data-stereo-sibling',
      'R',
    );

    // Clicking a receive row opens the "patch from" source picker (the same one
    // an added audio-out's input jack opens) — proving it selects a source.
    await panel.getByTestId('workflow-io-patchin-L').click();
    await expect(page.getByTestId('port-context-menu')).toBeVisible({ timeout: 4_000 });
  });
});

test.describe('AUDIO OUT device dropdown', () => {
  test('renders the output dropdown with at least one option', async ({ page }) => {
    await setupPage(page);

    // Spawn an audioOut and let its onMount enumerate devices.
    await spawnPatch(page, [
      { id: 'ao', type: 'audioOut', position: { x: 80, y: 60 } },
    ]);
    await expect(page.locator('.svelte-flow__node:has([data-shell-type="audioOut"])')).toBeVisible();

    // The device select lives on the DOCK face body on the default shell.
    await page.evaluate(
      (id) => (globalThis as unknown as { __openDockFullView: (id: string) => void }).__openDockFullView(id),
      'ao',
    );
    const select = page.locator('[data-testid="audioout-face-device-select"]');
    await expect(select).toBeVisible();

    // Under --use-fake-device-for-media-stream + microphone permission
    // pre-granted, enumerateDevices returns at least one audiooutput
    // entry (Chromium synthesizes a fake speaker too). On platforms
    // where it doesn't, we accept zero options and instead assert the
    // setSinkId-unavailable notice is shown — the spec's "graceful
    // degrade on Firefox" path.
    await page.waitForFunction(() => {
      const el = document.querySelector(
        '[data-testid="audioout-face-device-select"]',
      ) as HTMLSelectElement | null;
      const notice = document.querySelector(
        '[data-testid="audioout-setsinkid-notice"]',
      );
      // Pass condition: either at least one option, OR the notice is
      // rendered (browser lacks setSinkId entirely).
      return (el && el.options.length > 0) || notice !== null;
    }, undefined, { timeout: 5_000 });
  });
});

// ── DEFAULT-SHELL FACE COVERAGE ────────────────────────────────────────────
//
// AUDIO IN on the DEFAULT SHELL — the surface a player actually meets.
//
// ── WHY A NEW FILE, WHICH IS THE FINDING ───────────────────────────────────
//
// At promotion time every existing AUDIO IN spec drove the PRE-PROMOTION
// surface: all five tests in this file, and the 🎧 panel's own VRT scene
// (`workflow-audio-io-composite`), booted a renderer that painted the module's
// old instrument whatever its migration state was. (S2 has since re-pointed the
// describes above at the shipping shell; this describe was the face arm from
// the start.) The lane decision short-circuited before it ever read the
// promotion — so the whole of that coverage
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
// ⚠ IT LIVES IN THIS FILE RATHER THAN ITS OWN, AND THE REASON IS THE WEBGL
// ATTEST BASIS. These tests need the fake mic, so a new spec file would have to
// be named in the `chromium-audio-in` project's `testMatch` and in the default
// project's `testIgnore` — and `e2e/playwright.config.ts` IS IN THE ATTEST BASIS
// (`scripts/webgl-attest-hash.sh --list`, 220 files). MEASURED on this branch:
// adding three routing lines moved the content hash to 671522fb… and reddened
// the real-GPU gate, buying an owner-run attest window for a list of spec names.
// This file is already in the right project, so the coverage lands here and the
// hash does not move. The workflow/device describes above and the FACE-specific
// ones below are deliberately in one file for that reason; each names its own
// boot (all on the default shell since S2).

const FACE_NODE = 'ain';
const FACE_SCOPE = 'sc';

interface FaceInputProbe {
  state: string;
  streaming: boolean;
  trackLive: boolean;
  tracks: number;
  liveChannels: number;
  deviceId: string | null;
}

async function faceProbe(page: import('@playwright/test').Page, id = FACE_NODE): Promise<FaceInputProbe> {
  return page.evaluate(
    (n) =>
      (globalThis as unknown as { __nodeAudioInput(x: string): FaceInputProbe }).__nodeAudioInput(n),
    id,
  );
}

/** This node's saved keys, read off the live patch rather than off a control. */
async function faceSavedData(page: import('@playwright/test').Page, id = FACE_NODE): Promise<Record<string, unknown>> {
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
function faceTileControls(page: import('@playwright/test').Page, id = FACE_NODE) {
  return page.locator(`[data-audioin-node="${id}"][data-testid="audioin-tile-controls"]`);
}

/** Wait IN THE PAGE for the node's capture state. Never a Playwright-side poll:
 *  each round trip runs on the same main thread as the acquire it waits on. */
async function faceWaitForState(page: import('@playwright/test').Page, want: string, id = FACE_NODE): Promise<void> {
  await page.waitForFunction(
    ([n, s]) => {
      const w = globalThis as unknown as { __nodeAudioInput(x: string): FaceInputProbe };
      return w.__nodeAudioInput(n).state === s;
    },
    [id, want] as const,
    { timeout: BOOT_MS },
  );
}

async function faceBootDefaultShell(page: import('@playwright/test').Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: BOOT_MS });
  return errors;
}

test.describe('AUDIO IN on the DEFAULT SHELL (the promoted face)', () => {
  // Cold boot on the DEFAULT shell (faceplates + the seeded video zone) is the
  // slowest goto in the suite. A bound, not an assertion.
  test.describe.configure({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

test('the FACE alone adopts, acquires and drives real audio — with no card anywhere', async ({
  page,
}) => {
  const errors = await faceBootDefaultShell(page);

  await spawnPatch(
    page,
    [
      { id: FACE_NODE, type: 'audioIn', position: { x: 160, y: 160 } },
      { id: FACE_SCOPE, type: 'scope', position: { x: 520, y: 160 }, params: { timeMs: 50 } },
    ],
    [
      {
        id: 'e-ain-sc',
        from: { nodeId: FACE_NODE, portId: 'audio_l_out' },
        to: { nodeId: FACE_SCOPE, portId: 'ch1' },
        sourceType: 'audio',
        targetType: 'audio',
      },
    ],
  );

  // ── THE PRECONDITION THIS FILE EXISTS FOR: the lane paints the FACE. ──
  //
  // ⚠ TWO ABSENCE CHECKS STOOD HERE AND BOTH HAD STOPPED BEING FALSIFIABLE.
  // One waited on `.svelte-flow__node-audioIn` — xyflow stamps a node with its
  // NODE TYPE, and every lane node is `moduleShell` now, so that class cannot
  // appear for ANY module and the assertion was true of a blank page. The other
  // refused `audioin-device-select`, an id no surface in the tree emits any
  // more. A `toHaveCount(0)` whose subject cannot exist is satisfied by a rack
  // that rendered nothing at all, which is the shape this file's own header
  // warns about. The POSITIVE statement below is the one that can fail.
  const tile = faceTileControls(page);
  await expect(tile, 'the lane tile must render the face body').toBeVisible({ timeout: BOOT_MS });

  // ── ADOPT + ACQUIRE, from the face's own binding effect. ──
  await faceWaitForState(page, 'streaming');
  const live = await faceProbe(page);
  expect(live.trackLive, JSON.stringify(live)).toBe(true);
  expect(
    live.liveChannels,
    'the delivered channel layout must be reported — 0 means the attach never happened',
  ).toBeGreaterThan(0);

  // The acquire persists what actually opened, so a reload re-opens the same
  // physical input. (`onResolved` → `setInputDevice`.)
  expect(
    (await faceSavedData(page))['deviceId'],
    'the resolved device must be saved by the acquire itself, not only by a manual pick',
  ).toBeTruthy();

  // ── REAL AUDIO, at an analyser rather than at an "an edge exists" proxy. ──
  const r = await pollScopePeak(page, FACE_SCOPE, 0.01, BOOT_MS);
  expect(
    r.peak,
    scopePollMsg(
      `AUDIO IN drove no signal into FACE_SCOPE.ch1 through the FACE (peak ${r.peak.toFixed(4)}). ` +
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
  const errors = await faceBootDefaultShell(page);
  await spawnPatch(page, [{ id: FACE_NODE, type: 'audioIn', position: { x: 160, y: 160 } }], []);

  const tile = faceTileControls(page);
  await expect(tile).toBeVisible({ timeout: BOOT_MS });
  const action = tile.getByTestId('audioin-tile-action');
  const select = tile.getByTestId('audioin-tile-device');

  // The project pre-grants the mic, so the unattended acquire runs first and the
  // button is already offering STOP.
  await faceWaitForState(page, 'streaming');
  await expect(action).toHaveAttribute('data-action', 'stop');

  // ── STOP is obeyed, and it is a real release. ──
  await action.click();
  await faceWaitForState(page, 'idle');
  const stopped = await faceProbe(page);
  expect(
    stopped.trackLive,
    `STOP must actually release the device: ${JSON.stringify(stopped)}`,
  ).toBe(false);

  // ── …AND IT STAYS STOPPED. The unattended acquire is claimed ONCE PER FACE_NODE,
  // so nothing re-opens the input behind the player's back. A guard that only
  // read the state would re-acquire here, and the STOP button would be
  // un-obeyable. Bounded, then re-read — the state must still be idle.
  await expect
    .poll(async () => (await faceProbe(page)).state, {
      message: 'the node re-acquired on its own after a deliberate STOP',
      timeout: 2_000,
    })
    .toBe('idle');

  // ── ENABLE, ON THE TILE, reaches getUserMedia. This is the gesture the whole
  // `tileBody` exists for: on a faced AUDIO IN it is the only route to a first
  // permission grant, and `cameraInput` shipped without it.
  await expect(action).toHaveAttribute('data-action', 'enable');
  await action.click();
  await faceWaitForState(page, 'streaming');
  expect((await faceProbe(page)).trackLive).toBe(true);

  // ── THE DEVICE PICK writes the shared key every surface reads. ──
  const values = await select.evaluate((el) =>
    [...(el as HTMLSelectElement).options].map((o) => o.value).filter((v) => v !== ''),
  );
  expect(
    values.length,
    `the fake-device roster offered ${values.length} audioinput(s) (${values.join(', ')}). This ` +
      `test needs two to prove a PICK writes the key rather than the acquire having written it.`,
  ).toBeGreaterThan(1);
  const current = (await faceSavedData(page))['deviceId'];
  const other = values.find((v) => v !== current) ?? values[0]!;
  await select.selectOption(other);
  await expect
    .poll(async () => (await faceSavedData(page))['deviceId'], {
      message: 'picking a device did not write node.data.deviceId',
      timeout: BOOT_MS,
    })
    .toBe(other);

  // ── MUSIC MODE persists AND re-acquires (the capture DSP constraints cannot
  // be changed on a live track, so the switch has to re-open the device).
  //
  // ⚠ IT IS A DOCK CONTROL, NOT A TILE ONE, and that is deliberate: the shell
  // budgets the lane tile's height and it fits ONE tileBody row (measured — the
  // first draft's three rows painted over the GAIN caption in the compact VRT
  // baseline). So the tile keeps the picker and the acquire gesture, which
  // cannot live anywhere else, and this switch lives one click away. It is also
  // ALWAYS present on the pinned instance, whose 🎧 tray mounts the full-view
  // body.
  await expect(
    tile.getByTestId('audioin-tile-music-mode'),
    'the compact tier is one row: music mode must NOT be on the tile',
  ).toHaveCount(0);
  await page.evaluate(
    (n) => (globalThis as unknown as { __openDockFullView(x: string): void }).__openDockFullView(n),
    FACE_NODE,
  );
  const paneBody = page.locator(
    `.dock-fullview-pane [data-audioin-node="${FACE_NODE}"][data-testid="audioin-face-controls"]`,
  );
  await expect(paneBody).toBeVisible({ timeout: BOOT_MS });
  await paneBody.getByTestId('audioin-face-music-mode').check();
  await expect
    .poll(async () => (await faceSavedData(page))['musicMode'], {
      message: 'music mode did not persist to node.data',
      timeout: BOOT_MS,
    })
    .toBe(true);
  await faceWaitForState(page, 'streaming');
  const afterMusic = await faceProbe(page);
  expect(
    afterMusic.trackLive,
    `music mode re-acquired and left the input dead: ${JSON.stringify(afterMusic)}`,
  ).toBe(true);

  expect(
    errors.filter((e) => !/getUserMedia|mediaDevices|permission/i.test(e)),
    errors.join(' | '),
  ).toEqual([]);
});

// ── AN EMPTIED ROSTER MUST NOT DISABLE **STOP** ────────────────────────────
//
// The shipped guard on the face's one action button was
// `action === null || options.length === 0`. That button serves ENABLE / RETRY /
// STOP, so an empty roster also killed the only control that CLOSES a live
// microphone. The legacy card never did this: `AudioinCard` gated
// `audioin-enable` on the roster and gave `audioin-disable` no `disabled`
// attribute at all.
//
// ⚠ THE STATE IS REACHABLE, WHICH IS THE WHOLE POINT OF DRIVING IT HERE.
// `refreshInputDevices()` empties the roster on ANY `enumerateDevices()`
// rejection and runs on every `devicechange`, while the registry leaves
// `streaming` only on a track `'ended'` event. So a hub unplug that makes
// enumeration throw leaves a node CAPTURING with a roster of zero — the OS
// microphone indicator lit and no UI route to switch it off. That is the #1590
// harm class through a new door, and a test that only read the attribute on a
// happy-path roster would never have seen it.
//
// ⚠ WHAT IS AND IS NOT STUBBED. Only `enumerateDevices` is replaced, and only
// after the capture is already open: the stream, the registry entry, the
// button's own state machine and the click are all the real thing. The stub
// stands in for hardware this runner cannot unplug.
test('an EMPTIED ROSTER must not disable STOP — the live mic you cannot switch off', async ({
  page,
}) => {
  const errors = await faceBootDefaultShell(page);
  await spawnPatch(page, [{ id: FACE_NODE, type: 'audioIn', position: { x: 160, y: 160 } }], []);

  const tile = faceTileControls(page);
  await expect(tile).toBeVisible({ timeout: BOOT_MS });
  const action = tile.getByTestId('audioin-tile-action');
  const select = tile.getByTestId('audioin-tile-device');

  // The project pre-grants the mic, so the unattended acquire has already run
  // and the button is offering STOP against a POPULATED roster.
  await faceWaitForState(page, 'streaming');
  await expect(action).toHaveAttribute('data-action', 'stop');
  await expect(select, 'precondition: the roster must start populated').toBeEnabled();

  // ── EMPTY THE ROSTER THE WAY A HUB UNPLUG DOES. ──
  await page.evaluate(() => {
    Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', {
      configurable: true,
      writable: true,
      value: () => Promise.reject(new DOMException('enumeration failed', 'NotFoundError')),
    });
    navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
  });

  // The picker is `disabled` exactly when the roster is empty, so this locator
  // assertion IS the observable for "the refresh landed" — no Playwright-side
  // sampling loop, and no wall-clock wait standing in for a state.
  await expect(
    select,
    'the devicechange did not empty the roster — the rest of this test would be vacuous',
  ).toBeDisabled({ timeout: BOOT_MS });

  // ── THE HARM: the capture is STILL OPEN with nothing in the roster. ──
  const live = await faceProbe(page);
  expect(
    live.state,
    `an emptied roster must not have stopped the capture — it is the state the ` +
      `player is trapped in: ${JSON.stringify(live)}`,
  ).toBe('streaming');
  expect(live.trackLive, JSON.stringify(live)).toBe(true);

  // ── THE REGRESSION: STOP is still offered AND still pressable. ──
  await expect(action).toHaveAttribute('data-action', 'stop');
  await expect(
    action,
    'STOP is the only route to closing a live microphone; an empty device roster ' +
      'must never disable it (it still disables ENABLE/RETRY, which is correct)',
  ).toBeEnabled();

  // ── …AND IT REALLY RELEASES THE DEVICE. An enabled button that does nothing
  // would satisfy the attribute assertion above and leave the mic open.
  await action.click();
  await faceWaitForState(page, 'idle');
  const stopped = await faceProbe(page);
  expect(
    stopped.trackLive,
    `STOP with an empty roster must actually release the device: ${JSON.stringify(stopped)}`,
  ).toBe(false);
  expect(stopped.tracks, JSON.stringify(stopped)).toBe(0);

  // `refreshInputDevices` reports a failed enumeration on console.warn, by
  // design (an empty roster is a state the picker NAMES rather than a crash), so
  // nothing here may reach the error channel.
  expect(
    errors.filter((e) => !/getUserMedia|mediaDevices|permission/i.test(e)),
    errors.join(' | '),
  ).toEqual([]);
});
});
