<script lang="ts">
  // /m/cam — GLITCH CAM. One screen; the scene is a REAL patch in the same
  // store/engine: cameraInput → bentbox → recorderbox (spec §4).
  //
  //   - Display = direct in-page 2D canvas blit of the bentbox FBO
  //     (blitOutputToDrawingBuffer + cover-crop drawImage) — NOT /present and
  //     NOT the Fullscreen API (iPhone Safari has neither).
  //   - The record lifecycle runs in a REAL RecorderboxCard mounted hidden in
  //     a CardStage tray — the entire tested pipeline (probe, encode profile,
  //     OPFS chunking, crash recovery) with zero rewritten plumbing.
  //   - v1 skips showDirectoryPicker/showSaveFilePicker EVERYWHERE (spec §4
  //     Save): we shadow both globals to undefined for this page only, so the
  //     recorder takes its existing null-picker download fallback (surfaces
  //     the iOS share sheet). No shared-file edit needed.
  import { onDestroy, onMount } from 'svelte';
  import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
  import {
    ensureMobileEngine,
    getMobileEngine,
    getMobileAudioContext,
    disposeMobileEngine,
    installMobileTestHooks,
    resolveAnyDef,
  } from '$lib/mobile/mobile-host';
  import { createMatrixEdge } from '$lib/graph/matrixmix';
  import { mutateNode, setNodeParam } from '$lib/graph/mutate';
  import { provideEngineContext } from '$lib/audio/engine-context';
  import { createAudioGate } from '$lib/audio/audio-gate.svelte';
  import { getDefaultSnapshotBus, type PatchSnapshot } from '$lib/graph/snapshot';
  import { onMeterFrame, type MeterFrameHandle } from '$lib/ui/meter-frame';
  import { createCamSource, type CamSource } from '$lib/mobile/cam-source';
  import { getVideoModuleDef } from '$lib/video/module-registry';
  import type { VideoEngine } from '$lib/video/engine';
  import type { ModuleNode, ParamDef } from '$lib/graph/types';
  import { probeEncoders } from '$lib/video/recorderbox-recorder';
  import { testHooksEnabled } from '$lib/dev/test-hooks';
  import CardStage from '$lib/mobile/CardStage.svelte';
  import HSlider from '$lib/mobile/HSlider.svelte';

  // ── Engine plumbing ──
  const gate = createAudioGate();
  gate.setBooter(() => ensureMobileEngine({ videoRes: { width: 960, height: 540 } }));
  provideEngineContext(() => getMobileEngine());

  function videoEngine(): VideoEngine | null {
    const e = getMobileEngine();
    if (!e) return null;
    try {
      return e.getDomain<VideoEngine>('video');
    } catch {
      return null;
    }
  }

  // ── UI state machine ──
  type UiState = 'intro' | 'starting' | 'live' | 'denied' | 'error';
  let uiState = $state<UiState>('intro');
  let errMsg = $state<string | null>(null);

  // ── Scene ids (spawned on the OPEN CAMERA gesture) ──
  let ids = $state<{ cam: string; bent: string; rec: string } | null>(null);

  function spawnScene(): { cam: string; bent: string; rec: string } {
    const cam = `cameraInput-${crypto.randomUUID().slice(0, 8)}`;
    const bent = `bentbox-${crypto.randomUUID().slice(0, 8)}`;
    const rec = `recorderbox-${crypto.randomUUID().slice(0, 8)}`;
    ydoc.transact(() => {
      patch.nodes[cam] = {
        id: cam,
        type: 'cameraInput',
        domain: 'video',
        position: { x: 40, y: 40 },
        params: {},
        data: { name: 'CAMERAINPUT' },
      };
      patch.nodes[bent] = {
        id: bent,
        type: 'bentbox',
        domain: 'video',
        position: { x: 420, y: 40 },
        params: {},
        data: { name: 'BENTBOX', width: 370, height: 370 },
      };
      patch.nodes[rec] = {
        id: rec,
        type: 'recorderbox',
        domain: 'video',
        position: { x: 860, y: 40 },
        params: {},
        data: { name: 'RECORDERBOX', filename: 'glitchcam' },
      };
    }, LOCAL_ORIGIN);
    // Wire through the shared matrix seam (validated, one transact each).
    createMatrixEdge(
      { nodeId: cam, portId: 'out' },
      { nodeId: bent, portId: 'in' },
      'video',
      'video',
      resolveAnyDef,
    );
    createMatrixEdge(
      { nodeId: bent, portId: 'out' },
      { nodeId: rec, portId: 'in' },
      'video',
      'video',
      resolveAnyDef,
    );
    return { cam, bent, rec };
  }

  /** Wait for the camera node's engine handle to materialize (the reconciler
   *  runs on a microtask after the transact). */
  async function waitForCamHandle(camId: string, timeoutMs = 8000): Promise<boolean> {
    const t0 = performance.now();
    for (;;) {
      const eng = getMobileEngine();
      const node = patch.nodes[camId] as ModuleNode | undefined;
      if (eng && node && eng.read(node, 'hasVideoElement') !== undefined) return true;
      if (performance.now() - t0 > timeoutMs) return false;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  // ── Deterministic e2e seam: with __camerainputTestFrame set (and test
  // hooks enabled), the camera module renders a synthetic frame with NO
  // getUserMedia — skip acquisition entirely. Prod builds strip this. ──
  function fakeFrameActive(): boolean {
    return (
      testHooksEnabled() &&
      !!(globalThis as { __camerainputTestFrame?: unknown }).__camerainputTestFrame
    );
  }

  // ── Camera source ──
  let videoEl: HTMLVideoElement | null = $state(null);
  let cam: CamSource | null = null;
  let facing = $state<'user' | 'environment'>('environment');

  function attachToEngine() {
    if (!ids || !videoEl) return;
    videoEngine()?.attachExternalSource(ids.cam, 'video', videoEl);
  }

  function ensureCamSource(): CamSource | null {
    if (cam) return cam;
    if (!videoEl) return null;
    cam = createCamSource(videoEl, {
      onChange: (s, detail) => {
        facing = detail.facing;
        if (s === 'live') uiState = 'live';
        else if (s === 'denied') {
          uiState = 'denied';
          errMsg = detail.error;
        } else if (s === 'error') {
          uiState = 'error';
          errMsg = detail.error;
        }
      },
      onStream: () => attachToEngine(),
    });
    return cam;
  }

  // ── Wake lock (cam route only; in-gesture + visibilitychange re-request) ──
  type WakeLockSentinel = { release: () => Promise<void> };
  let wakeLock: WakeLockSentinel | null = null;
  async function requestWakeLock() {
    try {
      const nav = navigator as Navigator & {
        wakeLock?: { request: (t: 'screen') => Promise<WakeLockSentinel> };
      };
      wakeLock = (await nav.wakeLock?.request('screen')) ?? null;
    } catch {
      wakeLock = null; // low battery / unsupported — non-fatal
    }
  }
  function onVisibilityWake() {
    if (document.visibilityState === 'visible' && uiState === 'live') void requestWakeLock();
  }

  // ── The OPEN CAMERA gesture — one tap does everything (spec §4 boot) ──
  async function openCamera() {
    if (uiState === 'starting') return;
    uiState = 'starting';
    errMsg = null;
    void requestWakeLock(); // must fire inside the gesture
    try {
      await gate.resume(); // boots the engine on first tap
      gate.bind(getMobileAudioContext());
    } catch (e) {
      uiState = 'error';
      errMsg = e instanceof Error ? e.message : String(e);
      return;
    }
    if (!ids) ids = spawnScene();
    await waitForCamHandle(ids.cam);
    if (fakeFrameActive()) {
      uiState = 'live';
      return;
    }
    const c = ensureCamSource();
    if (!c) {
      uiState = 'error';
      errMsg = 'internal: video element not ready';
      return;
    }
    await c.start();
  }

  async function flip() {
    if (fakeFrameActive()) return;
    await ensureCamSource()?.flip();
  }

  // ── Snapshot pump (recording flag + rec node for the CardStage tray) ──
  let snapshot = $state<PatchSnapshot>({ nodes: [], edges: [] });
  const unsubscribeSnap = getDefaultSnapshotBus().subscribe((s) => (snapshot = s));
  let recNode = $derived(ids ? snapshot.nodes.find((n) => n.id === ids!.rec) : undefined);
  let bentNode = $derived(ids ? snapshot.nodes.find((n) => n.id === ids!.bent) : undefined);
  let recording = $derived(!!(recNode?.data as { recording?: boolean } | undefined)?.recording);

  // ── Encoder capability probe (the same gate CI needs) ──
  let canRecord = $state<boolean | null>(null);
  $effect(() => {
    if (uiState !== 'live' || canRecord !== null) return;
    const ve = videoEngine();
    const w = ve?.canvas.width ?? 960;
    const h = ve?.canvas.height ?? 540;
    void probeEncoders(w, h)
      .then((s) => (canRecord = s.canRecord))
      .catch(() => (canRecord = false));
  });

  function toggleRecord() {
    if (!ids || !canRecord) return;
    mutateNode(ids.rec, (live) => {
      if (!live.data) live.data = {};
      live.data.recording = !live.data.recording;
    });
  }

  // Recording elapsed chip.
  let recStart = $state<number | null>(null);
  let elapsedLabel = $state('0:00');
  let elapsedTimer: ReturnType<typeof setInterval> | null = null;
  $effect(() => {
    if (recording && recStart === null) {
      recStart = Date.now();
      elapsedTimer = setInterval(() => {
        const s = Math.floor((Date.now() - (recStart ?? Date.now())) / 1000);
        elapsedLabel = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      }, 500);
    } else if (!recording && recStart !== null) {
      recStart = null;
      elapsedLabel = '0:00';
      if (elapsedTimer) clearInterval(elapsedTimer);
      elapsedTimer = null;
    }
  });

  // ── Glitch strip: 6 single-param sliders + mirror chips (spec §4) ──
  const GLITCH_PARAMS: { id: string; label: string }[] = [
    { id: 'wavefold', label: 'solarize' },
    { id: 'hsync_loss', label: 'tear' },
    { id: 'chroma_phase', label: 'hue' },
    { id: 'feedback_gain', label: 'trails' },
    { id: 'noise', label: 'noise' },
    { id: 'master_gain', label: 'gain' },
  ];
  const bentDef = getVideoModuleDef('bentbox');
  function paramDef(id: string): ParamDef | undefined {
    return bentDef?.params.find((p) => p.id === id);
  }
  function bentValue(id: string): number {
    const live = (bentNode?.params ?? {})[id];
    return typeof live === 'number' ? live : (paramDef(id)?.defaultValue ?? 0);
  }
  function bentMirror(axis: 'mirrorX' | 'mirrorY'): boolean {
    return bentValue(axis) >= 0.5;
  }
  function toggleMirror(axis: 'mirrorX' | 'mirrorY') {
    if (!ids) return;
    setNodeParam(ids.bent, axis, bentMirror(axis) ? 0 : 1);
  }

  // ── Overlay auto-hide (3s; tap wakes) ──
  let overlayVisible = $state(true);
  let overlayTimer: ReturnType<typeof setTimeout> | null = null;
  function wakeOverlay() {
    overlayVisible = true;
    if (overlayTimer) clearTimeout(overlayTimer);
    overlayTimer = setTimeout(() => {
      if (uiState === 'live' && !trayOpen) overlayVisible = false;
    }, 3000);
  }

  // ── ⚙ tray (device list + the hidden real RecorderboxCard) ──
  let trayOpen = $state(false);
  let devices = $state<{ deviceId: string; label: string }[]>([]);
  async function refreshDevices() {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      devices = all
        .filter((d) => d.kind === 'videoinput')
        .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `camera ${i + 1}` }));
    } catch {
      devices = [];
    }
  }
  function toggleTray() {
    trayOpen = !trayOpen;
    if (trayOpen) void refreshDevices();
  }
  async function pickDevice(deviceId: string) {
    trayOpen = false;
    await ensureCamSource()?.setDevice(deviceId);
  }

  // ── Display blit: bentbox FBO → engine drawing buffer → 2D cover-crop ──
  let displayCanvas: HTMLCanvasElement | null = $state(null);
  let display2d: CanvasRenderingContext2D | null = null;
  let meterHandle: MeterFrameHandle | null = null;

  function sizeDisplay() {
    if (!displayCanvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(displayCanvas.clientWidth * dpr);
    const h = Math.round(displayCanvas.clientHeight * dpr);
    if (w > 0 && h > 0 && (displayCanvas.width !== w || displayCanvas.height !== h)) {
      displayCanvas.width = w;
      displayCanvas.height = h;
    }
  }

  function blit() {
    if (!displayCanvas || !ids) return;
    const ve = videoEngine();
    if (!ve) return;
    if (!display2d) display2d = displayCanvas.getContext('2d');
    if (!display2d) return;
    sizeDisplay();
    ve.blitOutputToDrawingBuffer(ids.bent);
    const src = ve.canvas;
    const sw = src.width;
    const sh = src.height;
    const cw = displayCanvas.width;
    const ch = displayCanvas.height;
    if (!(sw > 0 && sh > 0 && cw > 0 && ch > 0)) return;
    const scale = Math.max(cw / sw, ch / sh);
    const dw = sw * scale;
    const dh = sh * scale;
    display2d.drawImage(src as CanvasImageSource, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
  }

  onMount(() => {
    installMobileTestHooks();
    // v1 save model: DOWNLOAD-ONLY (spec §4 Save). Shadow the FS-Access
    // pickers to undefined FOR THIS PAGE so the recorder's feature-detects
    // (canPickDirectory/canSaveViaPicker) take the existing null-picker
    // <a download> fallback — no full-screen folder pickers on a phone.
    (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker = undefined;
    (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker = undefined;
    document.addEventListener('visibilitychange', onVisibilityWake);
    meterHandle = onMeterFrame(displayCanvas, () => {
      if (uiState === 'live') blit();
    });
    wakeOverlay();
  });

  onDestroy(() => {
    unsubscribeSnap();
    meterHandle?.stop();
    if (overlayTimer) clearTimeout(overlayTimer);
    if (elapsedTimer) clearInterval(elapsedTimer);
    document.removeEventListener('visibilitychange', onVisibilityWake);
    cam?.dispose();
    void wakeLock?.release().catch(() => undefined);
    gate.bind(null);
    disposeMobileEngine();
  });
</script>

<svelte:head>
  <title>glitch cam — patchtogether</title>
</svelte:head>

<div
  class="cam-root"
  data-testid="m-cam-root"
  data-state={uiState}
  onpointerdown={wakeOverlay}
>
  <!-- Hidden camera element the module samples (rVFC upload). -->
  <!-- svelte-ignore a11y_media_has_caption -->
  <video class="hidden-video" bind:this={videoEl} muted playsinline></video>

  <!-- Full-viewport display canvas (always mounted so the blit loop is warm). -->
  <canvas class="display" bind:this={displayCanvas} data-testid="m-cam-canvas"></canvas>

  {#if uiState === 'intro' || uiState === 'starting'}
    <div class="scrim intro">
      <h1>glitch cam</h1>
      <p class="sub">your camera through a CRT video bender.<br />nothing leaves your phone.</p>
      <button
        class="open-btn"
        onclick={openCamera}
        disabled={uiState === 'starting'}
        data-testid="m-cam-open"
      >
        {uiState === 'starting' ? 'starting…' : 'OPEN CAMERA'}
      </button>
      <a class="exit-link" href="/m" data-sveltekit-reload>back</a>
    </div>
  {:else if uiState === 'denied' || uiState === 'error'}
    <div class="scrim">
      <h1>{uiState === 'denied' ? 'camera blocked' : 'camera problem'}</h1>
      <p class="sub">{errMsg}</p>
      <button class="open-btn" onclick={openCamera} data-testid="m-cam-retry">RETRY</button>
      <a class="exit-link" href="/m" data-sveltekit-reload>back</a>
    </div>
  {/if}

  {#if uiState === 'live'}
    <div class="overlay" class:hidden={!overlayVisible} data-testid="m-cam-overlay">
      <div class="top-row">
        <a class="chip-btn" href="/m" data-sveltekit-reload data-testid="m-cam-exit">×</a>
        <div class="top-right">
          <button class="chip-btn" onclick={toggleTray} data-testid="m-cam-gear">⚙</button>
          <button class="chip-btn" onclick={flip} data-testid="m-cam-flip">FLIP</button>
        </div>
      </div>

      <div class="bottom-stack">
        <div class="glitch-strip" data-testid="m-cam-glitch-strip">
          {#each GLITCH_PARAMS as gp (gp.id)}
            {@const def = paramDef(gp.id)}
            <HSlider
              label={gp.label}
              value={bentValue(gp.id)}
              min={def?.min ?? 0}
              max={def?.max ?? 1}
              defaultValue={def?.defaultValue ?? 0}
              onchange={(v) => ids && setNodeParam(ids.bent, gp.id, v)}
              testid={`m-cam-slider-${gp.id}`}
            />
          {/each}
          <div class="mirror-row">
            <button
              class="chip-btn wide"
              class:on={bentMirror('mirrorX')}
              onclick={() => toggleMirror('mirrorX')}
              data-testid="m-cam-mirror-x"
            >
              MIRROR X
            </button>
            <button
              class="chip-btn wide"
              class:on={bentMirror('mirrorY')}
              onclick={() => toggleMirror('mirrorY')}
              data-testid="m-cam-mirror-y"
            >
              MIRROR Y
            </button>
          </div>
        </div>

        <div class="rec-row">
          {#if recording}
            <span class="rec-chip" data-testid="m-cam-rec-elapsed">● {elapsedLabel}</span>
          {/if}
          <button
            class="rec-btn"
            class:hot={recording}
            disabled={canRecord === false}
            onclick={toggleRecord}
            data-testid="m-cam-rec"
            data-recording={recording}
            data-can-record={canRecord}
            aria-label={recording ? 'stop recording' : 'start recording'}
          ></button>
          {#if canRecord === false}
            <span class="no-enc" data-testid="m-cam-no-encoder">no encoder — live only</span>
          {/if}
        </div>
      </div>
    </div>

    <!-- ⚙ tray: device list + the REAL RecorderboxCard (kept mounted once
         open — its probe/recovery/save flows run inside it). -->
    <div class="tray" class:open={trayOpen} data-testid="m-cam-tray">
      <div class="tray-head">
        <span>camera + recorder</span>
        <button class="chip-btn" onclick={toggleTray}>done</button>
      </div>
      {#if devices.length > 0}
        <div class="device-list">
          {#each devices as d (d.deviceId)}
            <button class="device-row" onclick={() => pickDevice(d.deviceId)}>{d.label}</button>
          {/each}
        </div>
      {/if}
      {#if recNode}
        <div class="tray-card">
          <CardStage node={recNode} />
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .cam-root {
    position: fixed;
    inset: 0;
    background: #05070a;
    color: #dbe2ee;
    overflow: hidden;
    touch-action: manipulation;
  }
  .hidden-video {
    position: absolute;
    width: 2px;
    height: 2px;
    opacity: 0;
    pointer-events: none;
  }
  .display {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
  }
  .scrim {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 14px;
    padding: 24px;
    background: rgba(5, 7, 10, 0.82);
    text-align: center;
  }
  .scrim h1 {
    font-size: 28px;
    font-weight: 700;
    margin: 0;
  }
  .sub {
    color: #8b93a3;
    font-size: 14px;
    margin: 0;
  }
  .open-btn {
    min-height: 64px;
    padding: 0 36px;
    border-radius: 32px;
    border: none;
    background: #e2445c;
    color: #fff;
    font-size: 18px;
    font-weight: 700;
    letter-spacing: 0.04em;
  }
  .open-btn:disabled {
    opacity: 0.6;
  }
  .exit-link {
    color: #8b93a3;
    font-size: 14px;
    text-decoration: none;
    padding: 10px;
  }
  .overlay {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    padding: calc(10px + env(safe-area-inset-top)) 12px calc(10px + env(safe-area-inset-bottom));
    transition: opacity 300ms ease;
    pointer-events: none;
  }
  .overlay > * {
    pointer-events: auto;
  }
  .overlay.hidden {
    opacity: 0;
  }
  .overlay.hidden > * {
    pointer-events: none;
  }
  .top-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .top-right {
    display: flex;
    gap: 8px;
  }
  .chip-btn {
    min-width: 44px;
    min-height: 44px;
    padding: 0 14px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 22px;
    border: 1px solid rgba(255, 255, 255, 0.18);
    background: rgba(10, 12, 16, 0.55);
    color: #dbe2ee;
    font-size: 14px;
    font-weight: 600;
    text-decoration: none;
    backdrop-filter: blur(4px);
  }
  .chip-btn.on {
    background: rgba(79, 140, 255, 0.4);
    border-color: rgba(79, 140, 255, 0.7);
  }
  .chip-btn.wide {
    flex: 1;
  }
  .bottom-stack {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .glitch-strip {
    background: rgba(10, 12, 16, 0.55);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 14px;
    padding: 8px 10px;
    max-height: 38dvh;
    overflow-y: auto;
    backdrop-filter: blur(6px);
  }
  .mirror-row {
    display: flex;
    gap: 8px;
    padding: 6px 0 2px;
  }
  .rec-row {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    min-height: 76px;
  }
  .rec-btn {
    width: 72px;
    height: 72px;
    border-radius: 50%;
    border: 4px solid rgba(255, 255, 255, 0.85);
    background: #e2445c;
  }
  .rec-btn.hot {
    animation: rec-pulse 1.2s ease-in-out infinite;
    border-radius: 22%;
  }
  .rec-btn:disabled {
    opacity: 0.35;
  }
  @keyframes rec-pulse {
    0%,
    100% {
      box-shadow: 0 0 0 0 rgba(226, 68, 92, 0.7);
    }
    50% {
      box-shadow: 0 0 0 14px rgba(226, 68, 92, 0);
    }
  }
  .rec-chip {
    color: #ff6b81;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }
  .no-enc {
    color: #8b93a3;
    font-size: 12px;
  }
  .tray {
    position: absolute;
    inset: auto 0 0 0;
    max-height: 80dvh;
    overflow-y: auto;
    background: #10141b;
    border-top: 1px solid #2a2f3a;
    border-radius: 16px 16px 0 0;
    padding: 12px 12px calc(12px + env(safe-area-inset-bottom));
    transform: translateY(105%);
    transition: transform 240ms ease;
  }
  .tray.open {
    transform: translateY(0);
  }
  .tray-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 13px;
    color: #8b93a3;
    padding-bottom: 8px;
  }
  .device-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding-bottom: 10px;
  }
  .device-row {
    min-height: 48px;
    text-align: left;
    padding: 0 14px;
    border-radius: 10px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    background: rgba(255, 255, 255, 0.04);
    color: #dbe2ee;
    font-size: 15px;
  }
  .tray-card {
    /* The REAL RecorderboxCard — functional, scrollable, kept mounted while
       the tray exists so its recorder lifecycle survives open/close. */
    border-top: 1px solid #2a2f3a;
    padding-top: 8px;
  }
</style>
