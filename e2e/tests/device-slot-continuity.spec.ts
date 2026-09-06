// e2e/tests/device-slot-continuity.spec.ts
//
// NATIVE-SHELL P1 — THE RECEIVER SIDE OF THE DEVICE-SLOT CONTRACT.
//
// `graph/device-slots-ydoc.test.ts` already proves the GRAPH half against the
// real reconciler and the real `loadEnvelopeIntoStore`: across a patch load the
// reconciler never emits `removeNode` for a reserved slot id. Its own header
// states what that instrument structurally cannot see, and names this file as
// the answer:
//
//     "a recording engine is not a camera. `removeNode` not being called proves
//      the reconciler never asked the device layer to let go; it does NOT prove
//      a MediaStream kept producing frames."
//
// So this file asserts LIVENESS, not PRESENCE. "The node still exists after the
// load" is deliberately NOT the claim anywhere below — a node re-added at the
// same id would satisfy it while the camera light blinked. What is asserted is
// that the SAME MediaStreamTrack object is still `live`, that the SAME node-owned
// <video> element keeps PRESENTING NEW FRAMES after the load, and that a frame
// captured AFTER the load reaches the GPU through the same engine node.
//
// ── THE CAMERA IS REAL, THE HARDWARE IS NOT ────────────────────────────────
//
// This spec's filename puts it in the DEFAULT `chromium` Playwright project,
// which carries NO `--use-fake-device-for-media-stream` (only the literal
// `camera-input.spec.ts` gets that, via the `chromium-camera` project's
// hardcoded testMatch). Rather than reach for that lane, `getUserMedia` is
// stubbed before boot to hand back a `canvas.captureStream()` — and that is a
// STRICTLY BETTER instrument here, not a workaround:
//
//   * it is a REAL `MediaStream` with a REAL `MediaStreamTrack`, so
//     `track.stop()` genuinely flips `readyState` to 'ended' — which is the
//     entire positive control below. A hand-rolled fake object would let the
//     control pass while nothing was ever torn down;
//   * it is capability-INDEPENDENT (no camera, no permission, no probe-and-skip),
//     which `camerainput-shell-source.spec.ts` argues at length is stronger than
//     capability-gating; and
//   * the test OWNS the pixels, so it can change the source level on demand and
//     assert a frame captured after the load arrives — see THE LEVEL SWITCH.
//
// ⚠ `__camerainputTestFrame` IS DELIBERATELY NOT SET. That seam uploads a fixed
// synthetic checker INSTEAD of sampling the live <video> ("no dependency on
// getUserMedia reaching 'streaming'"), so with it on, every pixel assertion here
// would be invariant to whether the MediaStream survived — the exact shape of
// gate whose passing condition is the defect. The render smoke wants it; a
// device-continuity spec must not have it.
//
// ── WHAT A GREEN RUN HERE STILL CANNOT SEE ─────────────────────────────────
//
//   * `cameraInput` exposes no per-node upload counter (its `read()` keys are
//     `hasVideoElement` / `hasKeepAlive` / `rvfcSupported`), and `uploadIfReady`
//     returns TRUE for a STALE texture when no new frame is queued. So the
//     camera's output pixels alone can never distinguish "live" from "frozen on
//     its last frame" — which is why the level switch, not a brightness floor,
//     carries the after-the-load claim.
//   * a canvas capture is not a webcam driver: nothing here exercises device
//     enumeration, permission revocation, unplug, or `NotReadableError` recovery.
//   * one browser context — the collaborative half (a peer's Clear arriving over
//     sync) is the ydoc test's row, not this one.
//   * the load is driven through `__persistence.load`, the same
//     `loadEnvelopeIntoStore` the quickload button calls; the IndexedDB slot
//     store and the perf-zip wrapper around it are not covered here.
//
// ARMED WITH `errorWatch` like every face/shell spec in this repo.

import { test, expect, type Page } from './_fixtures';
import { type Locator } from '@playwright/test';
import { spawnPatch, getFlowViewport, setFlowViewport, MAIN_CANVAS } from './_helpers';
import { SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';
import { stepAndReadStats } from './_render-smoke';

/** The reserved slot ids under test. `output1` keeps the HISTORICAL id
 *  `workflow-videoOut` by design (device-slots.ts) — renaming it would have been
 *  the very remove+add teardown the layer exists to prevent. */
const CAM_SLOT = 'slot:cam1';
const OUT_SLOT = 'workflow-videoOut';
/** Ordinary patch content: cleared and restored by the load like anything else. */
const CONTENT = 'lines-a';

const CAM_A = 'ptl-fake-cam-a';
const CAM_B = 'ptl-fake-cam-b';

/** Source levels for the fake camera. The gap is wide on purpose: the two bands
 *  must not be separable only by a lucky sample. LEVEL A also clears the
 *  module's idle navy pattern (mean ~19) so "a live frame is rendering" and
 *  "which frame" are two different questions with two different answers. */
const LEVEL_A = 90;
const LEVEL_B = 235;
/** Checker means, approximately: half the tiles are lit, half are rgb(6,6,6). */
const BAND_A_MAX = 80; // ~48 expected
const BAND_B_MIN = 95; // ~120 expected

// ---------------------------------------------------------------------------
// The fake camera rig
// ---------------------------------------------------------------------------

/**
 * Replace `enumerateDevices` + `getUserMedia` before boot.
 *
 * ⚠ EMPTY LABELS ARE LOAD-BEARING, for the reason camerainput-shell-source.spec
 * documents: the camera source registry's bootstrap auto-acquire
 * (node-camera-source-registry.ts) fires only when labels are visible (i.e.
 * permission was already granted in this origin). An empty
 * label is the real pre-grant shape, it keeps all four slot cameras idle, and it
 * leaves the FIRST `getUserMedia` on this page to the pick this test makes
 * through the manager's own source picker. A labelled fake would have every
 * camera auto-acquire on mount and the "bind through the real user path" leg
 * would pass without the picker doing anything.
 *
 * ⚠ TWO DEVICES, and the test picks the SECOND for the slot. A single-option
 * `<select>` renders that option as the browser's current value, so selecting it
 * is a change the product can legitimately treat as a no-op.
 */
async function installFakeCameras(page: Page, initialLevel: number): Promise<void> {
  await page.addInitScript((startLevel: number) => {
    interface FakeRig {
      canvas: HTMLCanvasElement;
      stream: MediaStream;
      timer: ReturnType<typeof setInterval>;
    }
    interface FakeCamApi {
      calls: number;
      level: number;
      /** Held so nothing here is collected while its track is still live. */
      rigs: FakeRig[];
      setLevel(v: number): void;
      /** Stop every capture pipeline this rig started. See the afterEach. */
      dispose(): void;
    }
    const g = globalThis as unknown as { __fakeCam: FakeCamApi; navigator: Navigator };

    const api: FakeCamApi = {
      calls: 0,
      level: startLevel,
      rigs: [],
      setLevel(v: number): void {
        api.level = v;
      },
      // ⚠ THE RIG MUST BE STOPPABLE, and it was not. Each acquisition mints a
      // canvas, a 30 fps `captureStream` and a 33 ms `setInterval`, all
      // deliberately retained so nothing is collected while a track is live.
      // Nothing ever stopped them, so every pipeline stayed hot for the life of
      // the page — and a run that ended abnormally left the browser holding
      // them. Chromium spawns per-stream capture/decode utility processes, so
      // the cost is real processes, not just timers: an iterative local loop
      // over this spec accumulated ~80 orphaned helpers.
      //
      // Called from the afterEach below, so it runs on the FAILING path too —
      // which is the path that was leaking.
      dispose(): void {
        for (const rig of api.rigs) {
          clearInterval(rig.timer);
          for (const t of rig.stream.getTracks()) t.stop();
        }
        api.rigs.length = 0;
      },
    };
    g.__fakeCam = api;

    /** One animated 320x240 checkerboard per acquisition, captured at 30 fps.
     *  A DISTINCT canvas per call means the two cameras below hold DISTINCT
     *  MediaStream objects — without that, the positive control and the subject
     *  would share a stream and stopping one would stop both. */
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
        // A moving 1px seam guarantees the canvas is DIRTY on every tick, so
        // captureStream keeps emitting frames even while the level is constant.
        ctx.fillStyle = `rgb(${(api.calls * 7 + Date.now() / 33) % 255 | 0},0,0)`;
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
        { deviceId: 'ptl-fake-cam-a', kind: 'videoinput', label: '', groupId: 'g1' },
        { deviceId: 'ptl-fake-cam-b', kind: 'videoinput', label: '', groupId: 'g1' },
      ]);
    md.getUserMedia = () => {
      api.calls++;
      return Promise.resolve(mintStream());
    };
    md.addEventListener ??= () => {};
    md.removeEventListener ??= () => {};
  }, initialLevel);
}

async function setSourceLevel(page: Page, level: number): Promise<void> {
  await page.evaluate((v) => {
    (globalThis as unknown as { __fakeCam: { setLevel(n: number): void } }).__fakeCam.setLevel(v);
  }, level);
}

// ---------------------------------------------------------------------------
// The media probe — IDENTITY-BOUND, by construction
// ---------------------------------------------------------------------------

interface CamSample {
  /** Was a <video> found under this node's camera host at watch time? */
  watched: boolean;
  /** Is the element the watcher stashed STILL the one the host renders?
   *  False means the element was destroyed and re-minted — a session change
   *  that "the node still exists" would happily report as fine. */
  sameElement: boolean;
  /** Is the stashed element still in the document? `nodeMedia.disposeNode`
   *  removes it outright, so this is the DOM-side teardown signal. */
  connected: boolean;
  /** The element's CURRENT srcObject, compared by OBJECT identity to the
   *  stream the watcher stashed. */
  sameStream: boolean;
  streamId: string | null;
  trackId: string | null;
  /** The real `MediaStreamTrack.readyState` — 'live' or 'ended'. Read off the
   *  STASHED track, so a torn-down session cannot hide behind a fresh one. */
  trackState: string | null;
  /** Presented-frame counter for the stashed element. THE liveness quantity:
   *  it advances only when the MediaStream delivers new frames. -1 when the
   *  browser does not implement it (asserted against, never tolerated). */
  frames: number;
  currentTime: number;
  readyState: number;
}

interface WatchRec {
  el: HTMLVideoElement | null;
  stream: MediaStream | null;
  track: MediaStreamTrack | null;
}

/** Find + stash the node-owned <video>, its stream and its track. Everything
 *  read afterwards is read THROUGH these references, which is what makes every
 *  assertion below an identity claim rather than a presence claim.
 *
 *  The element is the node-media registry's, found by the node id it stamps at
 *  creation — NOT through the 📷 manager's host, which under the shell renders
 *  only the face's CONTROLS (CameraSourceControls). The <video> itself lives in
 *  the registry's off-screen parking (real dimensions, never display:none, so
 *  it keeps decoding and presenting frames) or wherever a surface adopted it —
 *  either way the same element for the life of the NODE, which is the identity
 *  this test rides. */
async function watchCamera(page: Page, nodeId: string): Promise<void> {
  await page.evaluate((id) => {
    const w = globalThis as unknown as { __slotWatch?: Record<string, WatchRec> };
    w.__slotWatch ??= {};
    const el = document.querySelector(
      `video[data-testid="camera-preview"][data-node-id="${CSS.escape(id)}"]`,
    ) as HTMLVideoElement | null;
    const stream = (el?.srcObject as MediaStream | null) ?? null;
    w.__slotWatch[id] = {
      el,
      stream,
      track: stream ? (stream.getVideoTracks()[0] ?? null) : null,
    };
  }, nodeId);
}

async function sampleCamera(page: Page, nodeId: string): Promise<CamSample> {
  return page.evaluate((id) => {
    const w = globalThis as unknown as { __slotWatch?: Record<string, WatchRec> };
    const rec = w.__slotWatch?.[id];
    const liveEl = (document.querySelector(
      `video[data-testid="camera-preview"][data-node-id="${CSS.escape(id)}"]`,
    ) as HTMLVideoElement | null) ?? null;
    const el = rec?.el ?? null;
    const now = (el?.srcObject as MediaStream | null) ?? null;
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
      watched: !!el,
      sameElement: !!el && el === liveEl,
      connected: !!el && el.isConnected,
      sameStream: !!rec?.stream && now === rec.stream,
      streamId: now ? now.id : null,
      trackId: rec?.track ? rec.track.id : null,
      trackState: rec?.track ? rec.track.readyState : null,
      frames,
      currentTime: el ? el.currentTime : -1,
      readyState: el ? el.readyState : -1,
    };
  }, nodeId);
}

// ---------------------------------------------------------------------------
// Graph + engine reads
// ---------------------------------------------------------------------------

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

/** `read(nodeId, key)` on the video domain. Returns `undefined` when the ENGINE
 *  node does not exist — which is exactly what a torn-down node looks like. */
async function engineRead(page: Page, nodeId: string, key: string): Promise<unknown> {
  return page.evaluate(
    ({ id, k }) => {
      const w = globalThis as unknown as {
        __engine?: () => {
          getDomain: (d: string) => { read: (n: string, key: string) => unknown };
        } | null;
      };
      try {
        return w.__engine?.()?.getDomain('video').read(id, k) ?? undefined;
      } catch {
        return undefined;
      }
    },
    { id: nodeId, k: key },
  );
}

/** Mean luma of a node's output FBO.
 *
 *  Reuses `_render-smoke`'s reader with `steps: 0` — the ENGINE LOOP IS LIVE in
 *  this spec (the subject is a real-time device session, not a frozen render),
 *  so the frame-count contract `assertRenderStats` enforces does not apply and
 *  is deliberately not asserted. The reader is the shared part; the assertion
 *  bundle is not. Returns -1 when the node has no output texture.
 *
 *  ⚠ IT PERTURBS, AND THAT IS DECLARED RATHER THAN HIDDEN. `outputTexture`
 *  calls `markWatched` internally, so reading a node keeps it in the pull set.
 *  That is deliberate here: the subject of this file is the DEVICE SESSION, not
 *  the pull evaluator, and the probe is applied identically before and after the
 *  load — so it can bias neither side of the comparison. A spec whose subject IS
 *  pull evaluation must not use this (see collapse-keeps-playing.spec.ts). */
async function outMean(page: Page, nodeId: string): Promise<number> {
  const s = await stepAndReadStats(page, { nodeId, steps: 0 });
  return s.fbComplete ? s.mean : -1;
}

/**
 * Pan the MAIN canvas until `nodeId`'s card is centred in the MAIN pane.
 *
 * ⚠ WHY NOT `revealInPane`. The shared helper resolves its pane with
 * `document.querySelector('.svelte-flow__pane')` — the FIRST pane in the
 * document. The 📷 manager's always-mounted card-host farm renders a
 * single-node `<SvelteFlow>` per camera, parked at `left:-9999px`, and those
 * panes come first. MEASURED here: the helper compared the video-zone card
 * (x=-9907) against a camera host's pane (x≈-9999..-9699), concluded `inside`,
 * and returned as a NO-OP — a silent one, indistinguishable from success. This
 * spec does the same pan against a pane scoped to the main canvas.
 *
 * ⚠ AND THAT IS A FINDING ABOUT THE HELPER, NOT ONLY ABOUT THIS FILE:
 * the device-slot layer puts FOUR camera hosts in every rack by default, so the
 * first pane in the document is now a camera host on every page. Reported rather
 * than fixed here — `revealInPane` is on `spawnPatch`'s path for the whole
 * suite, so re-scoping it is its own change with its own blast radius.
 */
async function centreOnCard(page: Page, nodeId: string): Promise<void> {
  const delta = await page.evaluate(
    ({ id, canvas }) => {
      const pane = document.querySelector(`${canvas} .svelte-flow__pane`);
      const el = document.querySelector(`${canvas} .svelte-flow__node[data-id="${id}"]`);
      if (!pane || !el) return null;
      const p = pane.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return {
        dx: p.left + p.width / 2 - (r.left + r.width / 2),
        dy: p.top + p.height / 2 - (r.top + r.height / 2),
      };
    },
    { id: nodeId, canvas: MAIN_CANVAS },
  );
  if (!delta) throw new Error(`centreOnCard: no main-canvas node ${nodeId}`);
  const vp = await getFlowViewport(page);
  await setFlowViewport(page, { x: vp.x + delta.dx, y: vp.y + delta.dy, zoom: vp.zoom });
  // Wait on the CONTAINMENT itself — the signal that makes the card visible to
  // the engine's card-visibility tracker — never on a frame count or a sleep.
  await expect
    .poll(
      async () =>
        page.evaluate(
          ({ id, canvas }) => {
            const pane = document.querySelector(`${canvas} .svelte-flow__pane`);
            const el = document.querySelector(`${canvas} .svelte-flow__node[data-id="${id}"]`);
            if (!pane || !el) return false;
            const p = pane.getBoundingClientRect();
            const r = el.getBoundingClientRect();
            return r.left >= p.left && r.right <= p.right && r.top >= p.top && r.bottom <= p.bottom;
          },
          { id: nodeId, canvas: MAIN_CANVAS },
        ),
      { message: `${nodeId}'s card must be inside the main pane`, timeout: 15_000 },
    )
    .toBe(true);
}

// ---------------------------------------------------------------------------
// The camera manager — the REAL user path
// ---------------------------------------------------------------------------

function camRow(page: Page, nodeId: string): Locator {
  return page.locator(`[data-testid="workflow-camera-row"][data-node-id="${nodeId}"]`);
}
function camHost(page: Page, nodeId: string): Locator {
  return page.locator(`[data-testid="workflow-camera-host"][data-node-id="${nodeId}"]`);
}

async function openCamerasMenu(page: Page): Promise<void> {
  const panel = page.getByTestId('workflow-cameras-panel');
  if ((await panel.getAttribute('data-open')) !== 'true') {
    await page.getByTestId('workflow-topbar-slot-cameras').click();
  }
  await expect(panel).toHaveAttribute('data-open', 'true');
}

/** Pick `deviceId` in the hosted REAL faceplate's own `<select>` — the
 *  module's existing source-selection seam (CameraSourceControls, mounted by
 *  the tile body with the `cameraInput-tile` testid prefix), which is what the
 *  📷 manager's SOURCE button pins open. Nothing is written to the doc by this
 *  test. */
async function pickSource(page: Page, nodeId: string, deviceId: string): Promise<void> {
  const host = camHost(page, nodeId);
  await expect(host, `${nodeId}'s camera host is on-screen + interactive`).toHaveAttribute(
    'data-shown',
    'true',
    { timeout: SLOW_BOOT_TEST_TIMEOUT_MS },
  );
  const select = host.getByTestId('cameraInput-tile-device-select');
  await expect(select).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
  await select.selectOption(deviceId);
  await expect(
    host.getByTestId('cameraInput-tile-lamp'),
    `${nodeId} reached 'streaming' through the picker`,
  ).toHaveAttribute('data-lamp', 'streaming', { timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
}

// ---------------------------------------------------------------------------

test.describe('NATIVE-SHELL P1 — a bound device slot survives a patch load', () => {
  // Stop every capture pipeline this test started, on the failing path as well
  // as the passing one — see `dispose` in the rig. Best-effort: the page may
  // already be gone (a crash, a navigation), and a teardown that threw would
  // convert a real failure into a confusing one.
  test.afterEach(async ({ page }) => {
    await page
      .evaluate(() => {
        (globalThis as unknown as { __fakeCam?: { dispose(): void } }).__fakeCam?.dispose();
      })
      .catch(() => {});
  });

  test('a slot camera keeps PRODUCING across a load; an unreserved camera does NOT', async ({
    page,
    errorWatch,
  }) => {
    // Video-domain boot on CI's SwiftShader + two getUserMedia acquisitions +
    // a full menu interaction chain + a real envelope round-trip.
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 3);

    await installFakeCameras(page, LEVEL_A);

    // ⚠ THE DEFAULT SHELL AND NO `seed=none`. `?seed=none` is precisely the flag
    // that turns `seedShellDefaults` off, and the device-slot ensure returns
    // early on it — so the `rack`/`rackDefault` fixtures (both of which pass it)
    // would produce a rack with NO SLOTS and every assertion below would be
    // about nodes this test spawned itself.
    await page.goto('/rack');
    await expect(page.getByTestId('workflow-topbar')).toBeVisible({
      timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
    });
    await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });

    // ── 0. A RACK WITH ORDINARY CONTENT ────────────────────────────────────
    // spawnPatch CLEARS every node before adding its own, so it must run BEFORE
    // anything acquires a device. The slot ensure has no latch — it re-asserts
    // the eight reserved ids on the next snapshot, which is the backstop for
    // exactly this kind of wholesale replacement.
    await spawnPatch(page, [
      { id: CONTENT, type: 'lines', position: { x: 120, y: 200 }, domain: 'video' },
    ]);
    await expect
      .poll(async () => (await nodeIds(page)).includes(CAM_SLOT), {
        message: 'the device-slot ensure re-asserted the reserved ids after the clear',
        timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
      })
      .toBe(true);
    expect(await nodeIds(page), 'both slots under test exist').toEqual(
      expect.arrayContaining([CAM_SLOT, OUT_SLOT, CONTENT]),
    );

    // Patch CAM SLOT → OUTPUT SLOT through the real connect-commit path, so the
    // camera is a genuine upstream of a rendering sink rather than an island the
    // pull evaluator is entitled to skip.
    await page.evaluate(
      ({ from, to }) => {
        const w = globalThis as unknown as {
          __handleConnect: (c: {
            source: string;
            target: string;
            sourceHandle: string;
            targetHandle: string;
          }) => unknown;
        };
        w.__handleConnect({ source: from, target: to, sourceHandle: 'out', targetHandle: 'in' });
      },
      { from: CAM_SLOT, to: OUT_SLOT },
    );
    await expect
      .poll(
        async () =>
          page.evaluate(
            ({ from, to }) => {
              const w = globalThis as unknown as {
                __patch: {
                  edges: Record<
                    string,
                    { source: { nodeId: string }; target: { nodeId: string } } | null
                  >;
                };
              };
              return Object.values(w.__patch.edges).some(
                (e) => !!e && e.source.nodeId === from && e.target.nodeId === to,
              );
            },
            { from: CAM_SLOT, to: OUT_SLOT },
          ),
        { message: 'the slot camera is patched into the slot output', timeout: 15_000 },
      )
      .toBe(true);

    // ── 1. THE ENVELOPE — captured BEFORE any device is bound ──────────────
    // This is the DIFFERENT patch that gets loaded later. It contains the
    // content + the slot nodes + the cable, and it CANNOT contain the dynamic
    // camera added in step 3 (that camera does not exist yet), which is what
    // makes the positive control genuinely destructive rather than a no-op.
    const envelope = await page.evaluate(() => {
      const w = globalThis as unknown as { __persistence: { save: () => unknown } };
      return w.__persistence.save();
    });
    expect(envelope, '__persistence.save() unavailable — DEV/E2E-hooks build expected').toBeTruthy();

    // ── 2. BIND THE SLOT THROUGH THE 📷 MANAGER ────────────────────────────
    await openCamerasMenu(page);
    // The reserved slots list FIRST, in slot order, and a slot row is labelled
    // by its slot name rather than "camera N" (workflow-cameras.ts).
    await expect(camRow(page, CAM_SLOT), 'cam1 is a row in the manager').toHaveCount(1);
    await expect(camRow(page, CAM_SLOT).getByTestId('workflow-camera-label')).toHaveText('cam1');
    await expect(
      camRow(page, CAM_SLOT),
      'and it starts UNBOUND — otherwise the pick below proves nothing',
    ).toHaveAttribute('data-assigned', 'false');

    // SOURCE pins this row's card host open + interactive; the pick then rides
    // the card's own device dropdown. `stopPropagation` on the button keeps the
    // row's click-to-drag-a-cable gesture out of the way.
    await camRow(page, CAM_SLOT).getByTestId('workflow-camera-source').click();
    await pickSource(page, CAM_SLOT, CAM_B);
    await expect(camRow(page, CAM_SLOT)).toHaveAttribute('data-assigned', 'true');

    // ── 3. THE POSITIVE CONTROL — an UNRESERVED camera in the same rack ────
    // ＋ maps a dynamic `wfcam-*` camera: same type, same registries, same
    // always-mounted host, same getUserMedia path. The ONLY difference is that
    // its id is not reserved. Without this, a green result below could equally
    // mean the load never happened.
    const addBtn = page.getByTestId('workflow-cameras-add');
    await expect(addBtn, 'four PINNED slot cameras do not consume the maxInstances budget')
      .toBeEnabled();
    await addBtn.click();
    const wfcamId = await page.evaluate(async () => {
      const w = globalThis as unknown as {
        __patch: {
          nodes: Record<
            string,
            { id: string; type: string; data?: Record<string, unknown> | null } | null
          >;
        };
      };
      const hit = Object.values(w.__patch.nodes).find((n) => !!n && n.id.startsWith('wfcam-'));
      return hit ? hit.id : null;
    });
    expect(wfcamId, '＋ mapped a dynamic workflow camera').toMatch(/^wfcam-/);
    const WFCAM = wfcamId as string;
    // ＋ opens the new camera's source picker for us.
    await pickSource(page, WFCAM, CAM_A);

    // Close the menu: every card host parks off-screen, which is the state a
    // rack is actually in while the operator performs. Decode keeps running
    // there by design (the module's audio keep-alive holds the rate), and
    // testing the parked state is the honest scenario.
    await page.getByTestId('workflow-topbar-slot-cameras').click();
    await expect(page.getByTestId('workflow-cameras-panel')).toHaveAttribute('data-open', 'false');

    // ── 4. BASELINE — both sessions live, the slot rendering LEVEL A ───────
    await watchCamera(page, CAM_SLOT);
    await watchCamera(page, WFCAM);

    const camPre = await sampleCamera(page, CAM_SLOT);
    const wfPre = await sampleCamera(page, WFCAM);
    expect(camPre.watched, 'the slot camera has a node-owned <video>').toBe(true);
    expect(camPre.trackState, 'the slot camera session is LIVE before the load').toBe('live');
    expect(wfPre.trackState, 'the control camera session is LIVE before the load').toBe('live');
    expect(
      Boolean(camPre.trackId) && Boolean(wfPre.trackId) && camPre.trackId !== wfPre.trackId,
      'the two cameras hold DISTINCT tracks — otherwise the control would stop the subject',
    ).toBe(true);
    // INSTRUMENT CHECK. The presented-frame counter is the whole liveness
    // measurement; if this browser does not implement it, the run must go RED
    // rather than quietly assert on -1 forever.
    expect(
      camPre.frames,
      `HTMLVideoElement.getVideoPlaybackQuality() must be readable — sample was ${JSON.stringify(camPre)}`,
    ).toBeGreaterThanOrEqual(0);

    await expect
      .poll(() => outMean(page, CAM_SLOT), {
        message: 'the slot camera renders a LIVE frame (clear of the idle navy pattern)',
        timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
      })
      .toBeGreaterThan(25);
    const meanPre = await outMean(page, CAM_SLOT);
    expect(
      meanPre,
      `the pre-load render is LEVEL A (${LEVEL_A}); measured mean ${meanPre}`,
    ).toBeLessThan(BAND_A_MAX);

    // The OUTPUT SLOT is rendering that same frame through the cable. Reserved
    // output ids are protected by the id guard ALONE — they are deliberately NOT
    // pinned, because `pinned` is also the canvas-hide bit and pinning one would
    // make the rack's master sink vanish from the purple zone. So this is a
    // different mechanism from the camera's and gets its own baseline.
    //
    // ⚠ ITS CARD MUST BE IN THE PANE, and that is a PRODUCT rule rather than a
    // convenience. Pull evaluation treats a sink whose card is not visible as
    // skippable — MEASURED here: `pullStats().skipped` listed all four output
    // slots with `cardVisible: false`, and `workflow-videoOut` had drawn exactly
    // ONCE (its spawn-grace frame) while the camera had drawn 50. Its FBO held
    // the module's IDLE NAVY PATTERN, mean 18.96, so an "is the sink rendering"
    // assertion without this would have been measuring the viewport, not the
    // device layer. `markWatched` does NOT lift it either: `isPullRoot` demotes
    // a watched node whose card is invisible. The operator presenting from an
    // output slot has it on screen; so does this test.
    //
    // See `centreOnCard` for why the shared `revealInPane` cannot be used once
    // the 📷 host farm is mounted — which, with four camera slots, is always.
    await centreOnCard(page, OUT_SLOT);
    await expect
      .poll(() => outMean(page, OUT_SLOT), {
        message: 'the output slot renders the camera through the cable, pre-load',
        timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
      })
      .toBeGreaterThan(25);
    const outMeanPre = await outMean(page, OUT_SLOT);
    expect(
      outMeanPre,
      `the output slot's pre-load picture is LEVEL A; measured mean ${outMeanPre}`,
    ).toBeLessThan(BAND_A_MAX);

    // The RIG BINDING as the card actually persisted it.
    //
    // ⚠ NOT the id this test picked. `requestStream` reads the granted track's
    // OWN `getSettings().deviceId` and writes THAT back, so the persisted value
    // is the browser's per-origin device hash, not the fake id in the `<select>`.
    // Asserting the picked id here read as a tidy check and was simply wrong
    // about the product; what the load must preserve is whatever this machine
    // wrote, so that is what gets captured and compared.
    const deviceIdPre = (
      (await readNodes(page)).find((n) => n.id === CAM_SLOT)?.data as
        | Record<string, unknown>
        | undefined
    )?.deviceId;
    expect(deviceIdPre, 'the card persisted a device binding for the slot').toEqual(
      expect.any(String),
    );

    // Delete the ordinary content, so the load has something to RESTORE. Without
    // this the "a different patch arrived" evidence would be one-directional.
    await page.evaluate((id) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, unknown> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        delete w.__patch.nodes[id];
      });
    }, CONTENT);
    await expect
      .poll(async () => (await nodeIds(page)).includes(CONTENT), { timeout: 15_000 })
      .toBe(false);

    // ── 5. THE LOAD ────────────────────────────────────────────────────────
    await page.evaluate((env) => {
      const w = globalThis as unknown as { __persistence: { load: (e: unknown) => unknown } };
      w.__persistence.load(env);
    }, envelope);

    // ── 6. THE LOAD REALLY REPLACED THE GRAPH — both directions ────────────
    await expect
      .poll(async () => (await nodeIds(page)).includes(CONTENT), {
        message: 'the envelope RESTORED its content',
        timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
      })
      .toBe(true);
    await expect
      .poll(async () => (await nodeIds(page)).includes(WFCAM), {
        message: 'the load CLEARED the unreserved camera (it is not in the envelope)',
        timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
      })
      .toBe(false);
    expect(
      await nodeIds(page),
      'and every reserved id is still standing',
    ).toEqual(expect.arrayContaining([CAM_SLOT, OUT_SLOT]));

    // THE POSITIVE CONTROL, PAID OFF. The interruption P1 exists to remove, still
    // happening to a camera that is not in a slot: the node left the graph, the
    // sweep disposed its registry entry, and `stopStream` ENDED the track. This
    // is what "device access breaks" looks like at the receiver.
    await expect
      .poll(async () => (await sampleCamera(page, WFCAM)).trackState, {
        message: 'the unreserved camera\'s MediaStreamTrack is torn down by the load',
        timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
      })
      .toBe('ended');
    const wfPost = await sampleCamera(page, WFCAM);
    expect(wfPost.connected, 'and its node-owned <video> was removed from the document').toBe(false);
    expect(
      await page.evaluate((id) => {
        const w = globalThis as unknown as { __nodeMedia: (n: string) => unknown[] };
        return w.__nodeMedia(id);
      }, WFCAM),
      'and its media-registry rows are gone',
    ).toEqual([]);
    expect(
      await engineRead(page, WFCAM, 'hasVideoElement'),
      'and its ENGINE node is gone (read on an absent node is undefined)',
    ).toBeUndefined();

    // ── 7. THE SUBJECT — SAME SESSION, STILL PRODUCING ─────────────────────
    // Identity first. Everything here is read through the references stashed
    // BEFORE the load, so none of it can be satisfied by a fresh element, a
    // fresh stream or a fresh track at the same node id.
    const camMid = await sampleCamera(page, CAM_SLOT);
    expect(camMid.sameElement, 'the node-owned <video> is the SAME element').toBe(true);
    expect(camMid.connected, 'and it is still in the document').toBe(true);
    expect(camMid.sameStream, 'and it still holds the SAME MediaStream OBJECT').toBe(true);
    expect(camMid.streamId, 'same stream id').toBe(camPre.streamId);
    expect(camMid.trackId, 'same track id').toBe(camPre.trackId);
    expect(
      camMid.trackState,
      `the slot camera's track must still be LIVE — sample ${JSON.stringify(camMid)}`,
    ).toBe('live');
    expect(
      await engineRead(page, CAM_SLOT, 'hasVideoElement'),
      'and the engine node still holds that element',
    ).toBe(true);

    // LIVENESS. ⚠ SAMPLE TWICE, ASSERT ON THE SECOND. `camMid` was taken right
    // after the load; the assertion is on a LATER read, against camMid. A single
    // post-load read compared with the pre-load one would be satisfied by frames
    // that arrived BEFORE the load and by a counter that has since stopped.
    await expect
      .poll(async () => (await sampleCamera(page, CAM_SLOT)).frames, {
        message:
          'the slot camera must keep PRESENTING FRAMES after the load — a frozen ' +
          'stream leaves this counter flat at its post-load value',
        timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
      })
      .toBeGreaterThan(camMid.frames);
    const camPost = await sampleCamera(page, CAM_SLOT);
    expect(
      camPost.frames,
      `presented frames advanced past the POST-LOAD sample (${camMid.frames}); got ${camPost.frames}`,
    ).toBeGreaterThan(camMid.frames);
    expect(
      camPost.frames,
      `and past the PRE-LOAD sample (${camPre.frames}); got ${camPost.frames}`,
    ).toBeGreaterThan(camPre.frames);

    // ── 8. THE LEVEL SWITCH — a frame captured AFTER the load reaches the GPU
    //
    // ⚠ WHY A LEVEL SWITCH AND NOT A BRIGHTNESS FLOOR. `uploadIfReady` returns
    // TRUE for a STALE texture when no new frame is queued, so the camera's
    // output keeps rendering its LAST frame forever with `uHasInput=1`. A
    // "non-black, structured" assertion is therefore satisfied by a frozen
    // camera. Changing the SOURCE after the load and requiring the OUTPUT to
    // follow is the one pixel claim a frozen texture cannot satisfy.
    await setSourceLevel(page, LEVEL_B);
    await expect
      .poll(() => outMean(page, CAM_SLOT), {
        message:
          'a frame captured AFTER the load must reach the GPU through the same node — ' +
          'a frozen texture stays in the LEVEL A band',
        timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
      })
      .toBeGreaterThan(BAND_B_MIN);

    // ── 9. THE OUTPUT SLOT KEEPS RENDERING — THE WHOLE CHAIN, RESTORED ─────
    // The cable is ordinary patch content, so the load cleared it and re-added
    // it from the envelope. Requiring the SINK's picture to follow the same
    // level switch proves the entire chain is live after the load — the camera
    // still capturing, the restored cable carrying it, the reserved sink
    // drawing it — rather than any one of those in isolation.
    await expect
      .poll(() => outMean(page, OUT_SLOT), {
        message: 'the output slot shows the post-load camera frame through the restored cable',
        timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
      })
      .toBeGreaterThan(BAND_B_MIN);

    // ── 10. THE RIG BINDING IS THIS MACHINE'S, AND IT STAYED ───────────────
    // `deviceId` is a RIG property: stripped from the envelope on the way out,
    // carried across from the live node on the way in. The envelope saved at
    // step 1 predates the binding entirely, so finding it here means the load
    // preserved it rather than restored it.
    const camNode = (await readNodes(page)).find((n) => n.id === CAM_SLOT);
    expect(camNode?.type, 'the slot kept its canonical type').toBe('cameraInput');
    expect(
      (camNode?.data as Record<string, unknown> | undefined)?.deviceId,
      "this machine's camera binding survived the load",
    ).toBe(deviceIdPre);

    errorWatch.assertClean();
  });
});
