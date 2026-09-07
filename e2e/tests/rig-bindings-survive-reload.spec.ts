// e2e/tests/rig-bindings-survive-reload.spec.ts
//
// NATIVE-SHELL PART-3 — THE RECEIVER SIDE OF "DEVICE BINDINGS LIVE OFF THE Y.DOC".
//
// The bug this proves fixed: File→New (and a plain reload / refresh) used to wipe
// the camera, the external display and the master audio sink, because those
// bindings rode the collaborative Y.Doc and a fresh doc has none of them. They
// now live in the PER-MACHINE rig store (`device-slot-bindings.ts`,
// localStorage in the browser), which OUTLIVES the doc swap — and Canvas's
// `runDeviceRestore` re-applies them to whatever rack mounts next.
//
// ── WHY RELOAD, AND WHY IT IS THE HONEST FILE→NEW ──────────────────────────
//
// `device-slot-continuity.spec.ts` already proves the LOAD path (an in-place
// `__persistence.load`, same Y.Doc, the slot node never torn down — the SAME
// session survives). This file proves the harder edge: a full page RELOAD tears
// the whole page down and rehydrates a fresh doc, so nothing about the previous
// session survives IN THE PAGE — the element, the stream and the track are all
// new. What must come back is the BINDING, from the store, and it must drive a
// NEW live session. That is exactly the shape of File→New on a scratch rack
// (`newRack` → resetLocalScratchId → reload onto a fresh empty doc), which is why
// the reload here stands in for it: both land on the store-re-apply mount edge.
//
// ── LIVENESS, NOT PRESENCE ─────────────────────────────────────────────────
//
// "cam1 exists after reload" is never the claim: a re-added slot node satisfies
// it while the camera light stays off. What is asserted is that after the reload
// the camera holds a LIVE MediaStreamTrack and its node-owned <video> keeps
// PRESENTING NEW FRAMES; that the master sink was actually re-APPLIED to the
// AudioContext (the id setSinkId was called with, not merely "a value is saved");
// and that a projector re-OPENS on the saved display and shows the RIGHT node's
// moving pixels. Each has a positive leg that a frozen/blank/absent path fails.
//
// The camera + sink hardware is FAKED (a canvas capture stream, a recording
// setSinkId stub) but REAL in shape — a genuine MediaStreamTrack whose stop()
// flips readyState, a genuine setSinkId call whose argument we read back — so the
// instrument moves for the right reasons. ARMED WITH `errorWatch` like every
// shell spec.

import { test, expect, type Page } from './_fixtures';
import { SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';

const CAM_SLOT = 'slot:cam1'; // the reserved node id
const CAM_SLOT_NAME = 'cam1'; // its slot name (how the rig store keys it)
// ⚠ TWO of each device, and the test picks the SECOND. A single-option `<select>`
// already renders its one option as the current value, so selecting it fires no
// `change` and the pick is a legitimate no-op (device-slot-continuity.spec.ts
// documents the same trap). Two options make the pick a real change.
const CAM_DEVICE_A = 'ptl-fake-cam-a';
const CAM_DEVICE_B = 'ptl-fake-cam-b';
const SINK_DEVICE_A = 'ptl-fake-sink-a';
const SINK_DEVICE_B = 'ptl-fake-sink-b';

/** Fake camera source level (the checker fill). Constant here — this spec keys
 *  on the MediaStream track + its presented-frame counter, not on pixels. */
const LEVEL_A = 90;

// ---------------------------------------------------------------------------
// The fake device rig — cameras, an audio sink, installed BEFORE boot so it
// survives the reload (addInitScript re-runs on every navigation).
// ---------------------------------------------------------------------------

/**
 * Stub `enumerateDevices` (one videoinput + one audiooutput, with REAL labels),
 * `getUserMedia` (a 30 fps canvas capture), and `AudioContext.setSinkId`
 * (records the id it was called with on `__appliedSink`).
 *
 * ⚠ NON-EMPTY LABELS ARE LOAD-BEARING HERE, and this is the OPPOSITE choice from
 * `device-slot-continuity.spec.ts`. That spec keeps labels empty so slots stay
 * idle and its picker pick is meaningful. This spec needs the reverse: after a
 * reload a BOUND slot must AUTO-ACQUIRE, and the camera source registry's
 * bootstrap auto-acquire fires only once labels are visible (permission granted).
 * An UNBOUND slot still stays dark regardless (bootstrap's unbound-slot guard),
 * so binding cam1 remains the thing under test.
 */
async function installFakeDevices(page: Page, initialLevel: number): Promise<void> {
  await page.addInitScript(
    ({ startLevel, camA, camB, sinkA, sinkB }) => {
      interface FakeRig {
        canvas: HTMLCanvasElement;
        stream: MediaStream;
        timer: ReturnType<typeof setInterval>;
      }
      interface FakeApi {
        level: number;
        rigs: FakeRig[];
        setLevel(v: number): void;
        dispose(): void;
      }
      const g = globalThis as unknown as {
        __fakeCam: FakeApi;
        __appliedSink: string | null;
        navigator: Navigator;
        AudioContext: typeof AudioContext;
      };
      g.__appliedSink = null;

      // ⚠ START FROM AN EMPTY RIG STORE — ONCE PER TEST, NOT ON THE RELOAD.
      // The store persists in localStorage; a leak from a prior run would let
      // the bind + acquire pass without doing anything (a vacuous green). Clear
      // it on the FIRST page load of each test, gated by a sessionStorage
      // sentinel that SURVIVES the reload — so the mid-test reload keeps the
      // binding, which is the whole thing under test.
      try {
        const ss = (globalThis as unknown as { sessionStorage?: Storage }).sessionStorage;
        const ls = (globalThis as unknown as { localStorage?: Storage }).localStorage;
        if (ss && ls && !ss.getItem('__rigTestCleared')) {
          ls.removeItem('pt:rig-bindings:v1');
          ss.setItem('__rigTestCleared', '1');
        }
      } catch {
        /* private mode / partial window — nothing to clear */
      }

      const api: FakeApi = {
        level: startLevel,
        rigs: [],
        setLevel(v) {
          api.level = v;
        },
        dispose() {
          for (const rig of api.rigs) {
            clearInterval(rig.timer);
            for (const t of rig.stream.getTracks()) t.stop();
          }
          api.rigs.length = 0;
        },
      };
      g.__fakeCam = api;

      const mintStream = (): MediaStream => {
        const canvas = document.createElement('canvas');
        canvas.width = 320;
        canvas.height = 240;
        const ctx = canvas.getContext('2d');
        const draw = (): void => {
          if (!ctx) return;
          const lit = api.level;
          for (let y = 0; y < 240; y += 40) {
            for (let x = 0; x < 320; x += 40) {
              const on = (x / 40 + y / 40) % 2 === 0;
              ctx.fillStyle = on ? `rgb(${lit},${lit},${lit})` : 'rgb(6,6,6)';
              ctx.fillRect(x, y, 40, 40);
            }
          }
          // A moving 1px seam keeps the canvas DIRTY every tick, so captureStream
          // keeps emitting frames even while the level is constant.
          ctx.fillStyle = `rgb(${(Date.now() / 33) % 255 | 0},0,0)`;
          ctx.fillRect(0, 0, 1, 1);
        };
        draw();
        const stream = (
          canvas as HTMLCanvasElement & { captureStream: (fps?: number) => MediaStream }
        ).captureStream(30);
        const timer = setInterval(draw, 33);
        api.rigs.push({ canvas, stream, timer });
        return stream;
      };

      const nav = g.navigator as Navigator & { mediaDevices?: unknown };
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
          { deviceId: camA, kind: 'videoinput', label: 'Studio Cam A', groupId: 'g1' },
          { deviceId: camB, kind: 'videoinput', label: 'Studio Cam B', groupId: 'g1' },
          { deviceId: sinkA, kind: 'audiooutput', label: 'External Speakers A', groupId: 'g2' },
          { deviceId: sinkB, kind: 'audiooutput', label: 'External Speakers B', groupId: 'g2' },
        ]);
      md.getUserMedia = () => Promise.resolve(mintStream());
      md.addEventListener ??= () => {};
      md.removeEventListener ??= () => {};

      // setSinkId: make the picker feature-detect as SUPPORTED and record the id
      // actually applied to the context — the observable half of "the sink was
      // re-applied", read back as `__appliedSink`.
      //
      // ⚠ OVERRIDE UNCONDITIONALLY. Recent headless Chrome ships a NATIVE
      // setSinkId, which would REJECT for these fake device ids and record
      // nothing — so a "only if missing" guard leaves `__appliedSink` null on the
      // exact browsers that have the API. The recording stub replaces it either
      // way (this test asserts the id the app tried to APPLY, not real routing).
      const proto = g.AudioContext?.prototype as unknown as {
        setSinkId?: (id: string) => Promise<void>;
      };
      if (proto) {
        proto.setSinkId = function (id: string): Promise<void> {
          g.__appliedSink = id;
          return Promise.resolve();
        };
      }
    },
    {
      startLevel: initialLevel,
      camA: CAM_DEVICE_A,
      camB: CAM_DEVICE_B,
      sinkA: SINK_DEVICE_A,
      sinkB: SINK_DEVICE_B,
    },
  );
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

interface CamSample {
  found: boolean;
  trackState: string | null;
  trackId: string | null;
  frames: number;
}

/** Sample the LIVE node-owned <video> for a slot (found fresh each call — a
 *  reload re-mints it, so identity is deliberately NOT the claim here). */
async function sampleLiveCamera(page: Page, nodeId: string): Promise<CamSample> {
  return page.evaluate((id) => {
    const el = document.querySelector(
      `video[data-testid="camera-preview"][data-node-id="${CSS.escape(id)}"]`,
    ) as HTMLVideoElement | null;
    const stream = (el?.srcObject as MediaStream | null) ?? null;
    const track = stream ? stream.getVideoTracks()[0] ?? null : null;
    const q = el as unknown as {
      getVideoPlaybackQuality?: () => { totalVideoFrames: number };
    } | null;
    let frames = -1;
    try {
      frames = q?.getVideoPlaybackQuality ? q.getVideoPlaybackQuality().totalVideoFrames : -1;
    } catch {
      frames = -1;
    }
    return {
      found: !!el && !!stream,
      trackState: track ? track.readyState : null,
      trackId: track ? track.id : null,
      frames,
    };
  }, nodeId);
}

interface PatchNodeLite {
  id: string;
  type: string;
  data?: Record<string, unknown> | null;
}
async function readNodes(page: Page): Promise<PatchNodeLite[]> {
  return page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, PatchNodeLite | null> };
    };
    return Object.values(w.__patch.nodes)
      .filter((n): n is PatchNodeLite => !!n)
      .map((n) => ({ id: n.id, type: n.type, data: n.data ?? null }));
  });
}
async function nodeIds(page: Page): Promise<string[]> {
  return (await readNodes(page)).map((n) => n.id).sort();
}

/** The camera binding for a slot in the PER-MACHINE STORE, via the `__rigBindings`
 *  hook. Both fields, because the deviceId is a per-session browser hash that
 *  legitimately ROTATES across a reload — the stable identity is the LABEL, which
 *  the by-name rebind carries across. */
async function slotCameraBinding(
  page: Page,
  slot: string,
): Promise<{ deviceId: string | null; deviceLabel: string | null }> {
  return page.evaluate((s) => {
    const w = globalThis as unknown as {
      __rigBindings?: () => {
        cameras?: Record<string, { deviceId?: string; deviceLabel?: string } | undefined>;
      };
    };
    const b = w.__rigBindings?.()?.cameras?.[s];
    return { deviceId: b?.deviceId ?? null, deviceLabel: b?.deviceLabel ?? null };
  }, slot);
}

/** The master-sink id in the store, via the hook. */
async function audioOutBinding(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const w = globalThis as unknown as {
      __rigBindings?: () => { audioOut?: { outputDeviceId?: string } };
    };
    return w.__rigBindings?.()?.audioOut?.outputDeviceId ?? null;
  });
}

async function appliedSink(page: Page): Promise<string | null> {
  return page.evaluate(
    () => (globalThis as unknown as { __appliedSink?: string | null }).__appliedSink ?? null,
  );
}

// ---------------------------------------------------------------------------
// The camera manager — the REAL bind path (mirrors device-slot-continuity)
// ---------------------------------------------------------------------------

async function openCamerasMenu(page: Page): Promise<void> {
  const panel = page.getByTestId('workflow-cameras-panel');
  if ((await panel.getAttribute('data-open')) !== 'true') {
    await page.getByTestId('workflow-topbar-slot-cameras').click();
  }
  await expect(panel).toHaveAttribute('data-open', 'true');
}

async function bindCameraSlot(page: Page, nodeId: string, deviceId: string): Promise<void> {
  await openCamerasMenu(page);
  const row = page.locator(`[data-testid="workflow-camera-row"][data-node-id="${nodeId}"]`);
  await expect(row, `${nodeId} is a row in the manager`).toHaveCount(1);
  await row.getByTestId('workflow-camera-source').click();
  const host = page.locator(`[data-testid="workflow-camera-host"][data-node-id="${nodeId}"]`);
  await expect(host, `${nodeId}'s camera host is on-screen`).toHaveAttribute('data-shown', 'true', {
    timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
  });
  const select = host.getByTestId('cameraInput-tile-device-select');
  await expect(select).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
  await select.selectOption(deviceId);
  await expect(
    host.getByTestId('cameraInput-tile-lamp'),
    `${nodeId} reached 'streaming' through the picker`,
  ).toHaveAttribute('data-lamp', 'streaming', { timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
  // Close the menu so the host parks off-screen — the state a rack performs in.
  await page.getByTestId('workflow-topbar-slot-cameras').click();
  await expect(page.getByTestId('workflow-cameras-panel')).toHaveAttribute('data-open', 'false');
}

async function bootWorkflowRack(page: Page): Promise<void> {
  // ⚠ THE DEFAULT SHELL, NO `seed=none`: that flag turns off the device-slot
  // ensure, so `?seed=none` racks have NO slots. `/rack` seeds the eight reserved
  // ids this spec is entirely about.
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({
    timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
  });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
  await expect
    .poll(async () => (await nodeIds(page)).includes(CAM_SLOT), {
      message: 'the device-slot ensure created the reserved camera slot',
      timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
    })
    .toBe(true);
}

/** Boot the PatchEngine (audio + video domains) — what a user's first sound or
 *  render does — so the audioOut handle re-reads the store's master sink and the
 *  video domain renders the slots. */
async function bootEngine(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      typeof (globalThis as unknown as { __ensureEngine?: unknown }).__ensureEngine === 'function',
    undefined,
    { timeout: SLOW_BOOT_TEST_TIMEOUT_MS },
  );
  await page.evaluate(async () => {
    await (globalThis as unknown as { __ensureEngine: () => Promise<unknown> }).__ensureEngine();
  });
}

// ---------------------------------------------------------------------------

test.describe('NATIVE-SHELL PART-3 — rig bindings survive a reload / File→New', () => {
  test.afterEach(async ({ page }) => {
    await page
      .evaluate(() => {
        (globalThis as unknown as { __fakeCam?: { dispose(): void } }).__fakeCam?.dispose();
      })
      .catch(() => {});
  });

  test('a bound CAMERA slot re-acquires a LIVE session after a reload', async ({
    page,
    errorWatch,
  }) => {
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 3);
    await installFakeDevices(page, LEVEL_A);
    await bootWorkflowRack(page);

    // BIND the slot through the real manager path → the pick lands in the STORE.
    await bindCameraSlot(page, CAM_SLOT, CAM_DEVICE_B);

    // Pre-reload liveness + the binding is in the store, NOT node.data.
    const pre = await sampleLiveCamera(page, CAM_SLOT);
    expect(pre.trackState, 'the slot camera is LIVE before the reload').toBe('live');
    const bound = await slotCameraBinding(page, CAM_SLOT_NAME);
    expect(bound.deviceId, 'the pick landed in the rig store').toEqual(expect.any(String));
    expect(bound.deviceLabel, 'and carries the picked camera label').toBe('Studio Cam B');
    expect(
      (await readNodes(page)).find((n) => n.id === CAM_SLOT)?.data?.deviceId,
      'and never on the synced node.data (#2045 class)',
    ).toBeUndefined();

    // ── THE RELOAD — a brand-new page + a rehydrated doc ───────────────────
    // Nothing about the previous session survives IN THE PAGE (the element, the
    // stream and the track are all new). The binding must come back from the
    // store and drive a NEW live acquisition — the shape of File→New on a scratch
    // rack.
    await page.reload();
    await expect(page.getByTestId('workflow-topbar')).toBeVisible({
      timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
    });
    await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });

    // THE STORE SURVIVED (by its stable label — the deviceId hash may rotate),
    // and node.data is still clean.
    await expect
      .poll(async () => (await slotCameraBinding(page, CAM_SLOT_NAME)).deviceLabel, {
        message: 'the camera binding survived the reload in the rig store',
        timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
      })
      .toBe('Studio Cam B');
    expect(
      (await readNodes(page)).find((n) => n.id === CAM_SLOT)?.data?.deviceId,
      'the reloaded node.data never carries the machine-local id',
    ).toBeUndefined();

    // THE SUBJECT — the store drove a NEW live acquisition. (Identity is NOT
    // asserted: a reload legitimately re-mints element+stream+track. What is
    // asserted is that the re-minted track is LIVE — a wiped binding would leave
    // the slot dark with no <video> at all.)
    await expect
      .poll(async () => (await sampleLiveCamera(page, CAM_SLOT)).trackState, {
        message:
          'runDeviceRestore must re-acquire the bound slot from the store after the reload — ' +
          'a wiped binding would leave the slot dark',
        timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
      })
      .toBe('live');

    // LIVENESS, NOT PRESENCE. ⚠ SAMPLE TWICE, ASSERT ON THE SECOND: a single
    // post-reload read could be satisfied by frames that arrived once and a
    // counter that has since frozen. The presented-frame counter advances only
    // while the MediaStream keeps delivering frames.
    const mid = await sampleLiveCamera(page, CAM_SLOT);
    expect(mid.frames, `the re-acquired element exposes a frame counter — ${JSON.stringify(mid)}`)
      .toBeGreaterThanOrEqual(0);
    await expect
      .poll(async () => (await sampleLiveCamera(page, CAM_SLOT)).frames, {
        message: 'the re-acquired camera keeps PRESENTING FRAMES (not frozen on one)',
        timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
      })
      .toBeGreaterThan(mid.frames);

    errorWatch.assertClean();
  });

  test('the MASTER SINK re-applies to the AudioContext after a reload', async ({
    page,
    errorWatch,
  }) => {
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 2);
    await installFakeDevices(page, LEVEL_A);
    await bootWorkflowRack(page);

    const audioOutId = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { id: string; type: string } | null> };
      };
      const hit = Object.values(w.__patch.nodes).find((n) => !!n && n.type === 'audioOut');
      return hit ? hit.id : null;
    });
    expect(audioOutId, 'the workflow rack has a pinned audioOut').toEqual(expect.any(String));

    // Boot the audio engine so the audioOut handle exists and `setSinkId` is
    // reachable — the same thing a user's first sound does.
    await bootEngine(page);

    // Open the 🎧 panel and pick the fake sink through the pinned audio-out
    // face's real device select (scoped to the io host, which also mounts the
    // faceplate elsewhere) → the pick lands in the store and is applied.
    await page.getByTestId('workflow-topbar-slot-audio-io').click();
    const select = page
      .getByTestId('workflow-io-audioout-host')
      .getByTestId('audioout-face-device-select');
    await expect(select).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
    await select.selectOption(SINK_DEVICE_B);

    // The pick landed in the store, was applied to the context, and is NOT on
    // the synced node.data.
    await expect
      .poll(() => audioOutBinding(page), {
        message: 'the sink pick landed in the rig store',
        timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
      })
      .toBe(SINK_DEVICE_B);
    await expect
      .poll(() => appliedSink(page), {
        message: 'setSinkId was actually called with the picked device pre-reload',
        timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
      })
      .toBe(SINK_DEVICE_B);
    expect(
      (await readNodes(page)).find((n) => n.id === audioOutId)?.data?.outputDeviceId,
      'the sink id never rides the synced node.data',
    ).toBeUndefined();

    // ── THE RELOAD ─────────────────────────────────────────────────────────
    await page.reload();
    await expect(page.getByTestId('workflow-topbar')).toBeVisible({
      timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
    });
    await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });

    // The binding survived the reload.
    await expect
      .poll(() => audioOutBinding(page), {
        message: 'the master sink binding survived the reload in the rig store',
        timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
      })
      .toBe(SINK_DEVICE_B);

    // Boot audio on the fresh page — `__appliedSink` was reset to null by the
    // reload, so a non-null value now can ONLY be the post-reload re-apply the
    // audio-out handle performs by reading the store at boot.
    await bootEngine(page);
    await expect
      .poll(() => appliedSink(page), {
        message:
          'the audio-out handle must re-apply the STORED sink to the fresh context after the ' +
          'reload — a wiped binding would leave __appliedSink null',
        timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
      })
      .toBe(SINK_DEVICE_B);

    errorWatch.assertClean();
  });
});
