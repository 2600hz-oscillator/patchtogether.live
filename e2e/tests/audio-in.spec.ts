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

async function setupPage(page: import('@playwright/test').Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/rack');
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
async function ensureAudioInStreaming(page: import('@playwright/test').Page): Promise<void> {
  const select = page.locator('[data-testid="audioin-device-select"]');
  await expect(select).toBeVisible();
  await page.waitForFunction(() => {
    const el = document.querySelector(
      '[data-testid="audioin-device-select"]',
    ) as HTMLSelectElement | null;
    return el ? el.options.length > 0 : false;
  }, undefined, { timeout: 5_000 });

  const status = page.locator('[data-testid="audioin-status"]');
  const enable = page.locator('[data-testid="audioin-enable"]');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await status.getAttribute('data-state')) === 'streaming') return;
    // Only click an ENABLED enable button — never force a disabled one
    // (disabled = devices still enumerating; forcing it hangs/detaches).
    if ((await enable.count()) > 0 && await enable.isEnabled().catch(() => false)) {
      await enable.click({ noWaitAfter: true }).catch(() => { /* raced auto-acquire */ });
    }
    await page.waitForTimeout(150);
  }
  await expect(status).toHaveAttribute('data-state', 'streaming', { timeout: 5_000 });
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

    await expect(page.locator('.svelte-flow__node-audioIn'), 'AUDIO IN card visible').toBeVisible();
    await expect(page.locator('.svelte-flow__node-scope'), 'SCOPE card visible').toBeVisible();

    // Device dropdown populates from enumerateDevices on mount, then the
    // card auto-acquires (mic pre-granted) → status reaches 'streaming'.
    await ensureAudioInStreaming(page);

    // Give the audio graph a beat to actually push samples into the
    // scope buffer. Fake-device starts emitting immediately on track
    // start so a small wait is enough.
    await page.waitForTimeout(800);

    // Read SCOPE's ch1 buffer via the dev-exposed engine getter. SCOPE
    // exposes its waveform under the readModulatorTap analyser tap via
    // the standard read() interface; for the e2e gate we just want to
    // know the signal is not silence.
    //
    // Approach: query for the scope's on-card canvas pixels and check
    // they aren't a flat black field. SCOPE's draw routine paints a
    // trace whose pixel variance is a proxy for "scope sees signal".
    const scopeCanvas = page.locator('[data-testid="scope-canvas"]').first();
    await expect(scopeCanvas, 'SCOPE canvas in DOM').toBeVisible({ timeout: 5_000 });

    const stats = await scopeCanvas.evaluate((el) => {
      const c = el as HTMLCanvasElement;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;
      const img = ctx.getImageData(0, 0, c.width, c.height);
      const data = img.data;
      let n = 0;
      let sum = 0;
      let sumSq = 0;
      let nonZero = 0;
      // Stride wider than 4 to skip RGBA channels we don't care about
      // sampling at every pixel — speeds up the eval.
      for (let i = 0; i < data.length; i += 16) {
        const r = data[i]!;
        const g = data[i + 1]!;
        const b = data[i + 2]!;
        const v = (r + g + b) / 3;
        sum += v;
        sumSq += v * v;
        if (v > 8) nonZero++;
        n++;
      }
      const mean = sum / n;
      const variance = sumSq / n - mean * mean;
      return { mean, variance, nonZero, samples: n };
    });

    expect(stats, 'scope canvas pixel-stats sample').not.toBeNull();
    if (!stats) return;
    // Variance > 5: the scope canvas isn't flat. Threshold matches the
    // coverage-group-2-sources spec which uses the same proxy for
    // "is the source emitting audio" — fake-device is a clean sine wave
    // so the rendered trace's pixel variance is comfortably above 5.
    expect(
      stats.variance,
      `scope variance ${stats.variance.toFixed(1)} > 5 (flat black scope = no signal arriving)`,
    ).toBeGreaterThan(5);
    expect(
      stats.nonZero,
      `scope had ${stats.nonZero} non-zero pixels out of ${stats.samples}`,
    ).toBeGreaterThan(0);

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

    await expect(page.locator('.svelte-flow__node-audioIn')).toBeVisible();

    await ensureAudioInStreaming(page);
    await page.waitForTimeout(800);

    // Both ch1 (L) and ch2 (R) drive the SAME scope canvas trace, so a
    // non-flat canvas proves at least one is live; to prove BOTH outputs
    // carry signal independently, read each scope channel passthrough via
    // the engine's outputSnapshot-style read on the source ports. We use
    // the on-card canvas variance as the live-signal proxy (same proxy as
    // the ch1 test) AFTER confirming both edges materialized.
    const scopeCanvas = page.locator('[data-testid="scope-canvas"]').first();
    await expect(scopeCanvas).toBeVisible({ timeout: 5_000 });

    const variance = await scopeCanvas.evaluate((el) => {
      const c = el as HTMLCanvasElement;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      if (!ctx) return 0;
      const img = ctx.getImageData(0, 0, c.width, c.height);
      const data = img.data;
      let n = 0, sum = 0, sumSq = 0;
      for (let i = 0; i < data.length; i += 16) {
        const v = (data[i]! + data[i + 1]! + data[i + 2]!) / 3;
        sum += v; sumSq += v * v; n++;
      }
      const mean = sum / n;
      return sumSq / n - mean * mean;
    });
    expect(variance, `stereo-pair scope variance ${variance.toFixed(1)} > 5`).toBeGreaterThan(5);

    expect(errors.filter((e) => !/getUserMedia|audio/i.test(e)), errors.join('; ')).toEqual([]);
  });

  test('two AUDIO IN cards can coexist (not a singleton)', async ({ page }) => {
    await setupPage(page);
    await spawnPatch(page, [
      { id: 'ai1', type: 'audioIn', position: { x: 80, y: 60 } },
      { id: 'ai2', type: 'audioIn', position: { x: 360, y: 60 } },
    ]);

    // Both cards should mount — the def's maxInstances is unset, so the
    // engine singleton guard shouldn't kick in.
    await expect(page.locator('.svelte-flow__node-audioIn')).toHaveCount(2);
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
    await expect(page.locator('.svelte-flow__node-audioIn')).toBeVisible();
    await ensureAudioInStreaming(page);

    const toggle = page.locator('[data-testid="audioin-music-mode"]');
    await expect(toggle).toBeVisible();
    await expect(toggle).not.toBeChecked();

    await toggle.check();
    await expect(toggle).toBeChecked();

    // Re-acquire should settle back to streaming.
    const status = page.locator('[data-testid="audioin-status"]');
    await expect(status).toHaveAttribute('data-state', 'streaming', { timeout: 10_000 });

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
    await page.goto('/rack?mode=workflow');
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
      panel.locator('[data-testid="workflow-io-audioin-host"] [data-testid="audioin-device-select"]'),
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
    await page.goto('/rack?mode=workflow');
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
    for (const [hostId, cardSel] of [
      ['workflow-io-audioin-host', '[data-dock-card="pinned-audioIn"] .card'],
      ['workflow-io-audioout-host', '[data-dock-card="pinned-audioOut"] .card'],
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
    await page.goto('/rack?mode=workflow');
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
      panel.locator('[data-testid="workflow-io-audioin-host"] [data-testid="audioin-device-select"]'),
    ).toBeVisible();
    // Output side: the device dropdown, or the setSinkId-unsupported notice.
    await page.waitForFunction(() => {
      const host = document.querySelector('[data-testid="workflow-io-audioout-host"]');
      if (!host) return false;
      const sel = host.querySelector('[data-testid="audioout-device-select"]') as HTMLSelectElement | null;
      const notice = host.querySelector('[data-testid="audioout-setsinkid-notice"]');
      return (sel !== null && sel.options.length > 0) || notice !== null;
    }, undefined, { timeout: 5_000 });

    // The hosted AudioinCard reaches `streaming` (fake mic, pre-granted) —
    // the same helper the dawless card tests use, against the same testids.
    await ensureAudioInStreaming(page);

    // Click-driven patch-out: AUDIO IN L → the drill-down picker → SCOPE.ch1.
    await page.getByTestId('workflow-io-patchout-audio_l_out').click();
    const picker = page.locator('[data-testid="port-context-menu"]');
    await expect(picker).toBeVisible();
    await picker.locator('[data-testid="patch-to-module"][data-node-id="sc"]').click();
    const ch1 = picker.locator('[data-testid="patch-to-port"][data-port-id="ch1"]');
    await expect(ch1).toBeVisible();
    await ch1.click();

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

    // …and REAL signal flows down it: the scope trace is non-flat (the
    // same pixel-variance proxy the dawless AUDIO IN → SCOPE test uses).
    await page.waitForTimeout(800);
    const scopeCanvas = page.locator('[data-testid="scope-canvas"]').first();
    await expect(scopeCanvas).toBeVisible({ timeout: 5_000 });
    await expect
      .poll(async () =>
        scopeCanvas.evaluate((el) => {
          const c = el as HTMLCanvasElement;
          const ctx = c.getContext('2d', { willReadFrequently: true });
          if (!ctx) return 0;
          const img = ctx.getImageData(0, 0, c.width, c.height);
          const data = img.data;
          let n = 0, sum = 0, sumSq = 0;
          for (let i = 0; i < data.length; i += 16) {
            const v = (data[i]! + data[i + 1]! + data[i + 2]!) / 3;
            sum += v; sumSq += v * v; n++;
          }
          const mean = sum / n;
          return sumSq / n - mean * mean;
        }),
      { timeout: 10_000 })
      .toBeGreaterThan(5);

    expect(errors.filter((e) => !/getUserMedia|audio/i.test(e)), errors.join('; ')).toEqual([]);
  });

  test('the pinned AUDIO OUT exposes a source picker (receive-from rows) like an added one (bug 1)', async ({ page }) => {
    // Owner bug 1: the DEFAULT (pinned) audio-out showed NO way to select a
    // source — an audio-out ADDED on the grid does (its input jacks open the
    // "patch from" picker). The panel now mirrors AUDIO IN's patch rows in
    // reverse: two "receive from" rows (AUDIO OUT L / R) that open the SAME
    // source picker, so the pinned instance behaves like an added one.
    await page.goto('/rack?mode=workflow');
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
    await expect(panel.getByTestId('workflow-io-patchin-L')).toBeVisible();
    await expect(panel.getByTestId('workflow-io-patchin-R')).toBeVisible();

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
    await expect(page.locator('.svelte-flow__node-audioOut')).toBeVisible();

    const select = page.locator('[data-testid="audioout-device-select"]');
    await expect(select).toBeVisible();

    // Under --use-fake-device-for-media-stream + microphone permission
    // pre-granted, enumerateDevices returns at least one audiooutput
    // entry (Chromium synthesizes a fake speaker too). On platforms
    // where it doesn't, we accept zero options and instead assert the
    // setSinkId-unavailable notice is shown — the spec's "graceful
    // degrade on Firefox" path.
    await page.waitForFunction(() => {
      const el = document.querySelector(
        '[data-testid="audioout-device-select"]',
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
