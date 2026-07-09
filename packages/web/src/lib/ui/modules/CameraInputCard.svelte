<script lang="ts">
  // CameraInputCard — UI for the CAMERA input video module.
  //
  // Owns: getUserMedia + enumerateDevices + the live <video> element +
  // permission state machine. Hands the <video> element off to the
  // engine module's runtime via attachExternalSource so the WebGL2
  // sampler reads from it directly (single source of truth — see
  // .myrobots/plans/module-camera-input.md §7).
  //
  // State scopes:
  //   - `state` (idle, requesting, streaming, ...): per-tab. Lives in
  //     local Svelte $state. NOT in Yjs — permission grants are
  //     browser-instance-local.
  //   - `node.params.enabled / mirror / gain`: in Yjs. Sync across
  //     collaborators. Mirror toggling on User-A flips User-B's local
  //     preview too — that's intentional, the param IS shared.
  //   - `node.data.deviceId`: in Yjs. Each user's browser tries to
  //     match it to a local camera; if missing, dropdown shows
  //     "(saved camera not found)" and user picks again.

  import { onMount, onDestroy, untrack } from 'svelte';
  import { acquireCameraStream } from '$lib/ui/camera-acquire';
  import { type NodeProps } from '@xyflow/svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { useProvider } from '$lib/multiplayer/provider-context';
  import {
    addLocalCameraNodeId,
    removeLocalCameraNodeId,
    readRemoteCameraPresence,
    type RemoteCameraPresence,
  } from '$lib/multiplayer/camera-presence';
  import type { PresenceUser } from '$lib/multiplayer/presence';
  import { setNodeParam, mutateNode } from '$lib/graph/mutate';
  import { cameraInputDef } from '$lib/video/modules/camera-input';
  import { shouldReacquireOnPick, savedDeviceMissing } from '$lib/video/camera-device';
  import type { VideoEngine } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import NativeFillToggle from './NativeFillToggle.svelte';
  import { portsFromDef } from './card-kit';

  type State =
    | 'idle'
    | 'requesting'
    | 'streaming'
    | 'paused'
    | 'permission-denied'
    | 'no-cameras-found'
    | 'device-in-use'
    | 'unsupported'
    | 'error';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  const engineCtx = useEngine();
  const providerCtx = useProvider();

  // ---- PatchPanel ports (NO raw side handles — the #767 yellow drill-down
  //      standard; also gives the card its rear-view back panel). Port `id`s are
  //      BYTE-IDENTICAL to the module def so the CV bridge + persisted edges
  //      route unchanged; only the rendering moved into the panel. ----
  const inputs = portsFromDef(cameraInputDef.inputs);
  const outputs = portsFromDef(cameraInputDef.outputs);

  let videoEl: HTMLVideoElement | null = $state(null);
  let stream: MediaStream | null = null;
  let camState: State = $state('idle');
  let errorMsg = $state<string | null>(null);
  let devices = $state<MediaDeviceInfo[]>([]);
  let selectedDeviceId = $state<string | null>(null);
  // True once enumerateDevices returns real labels — i.e. camera permission has
  // been granted in this origin. Before that, deviceIds are redacted to '' so we
  // can't tell whether the saved camera is actually present.
  let hasDeviceLabels = $state(false);
  // The saved camera no longer resolves to an available device (loaded a patch
  // on a different machine / camera unplugged). Drives the dropdown placeholder.
  let savedMissing = $derived(savedDeviceMissing(selectedDeviceId, devices, hasDeviceLabels));
  // Awareness: who else (if anyone) has THIS card's CAMERA active. The
  // stream itself is local-only, so we render a presence badge instead of
  // pixels. Null = no remote user; non-null = the first remote user we
  // see in the awareness states whose cameraNodeIds includes our id.
  let remoteCameraUser = $state<PresenceUser | null>(null);

  // Hydrate selectedDeviceId from node.data.deviceId once on mount.
  // Subsequent picks write back to node.data.deviceId.
  function readSavedDeviceId(): string | null {
    const d = node?.data;
    if (d && typeof d['deviceId'] === 'string') return d['deviceId'] as string;
    return null;
  }

  function p(name: string): number {
    const def = cameraInputDef.params.find((x) => x.id === name);
    return node?.params[name] ?? def?.defaultValue ?? 0;
  }
  function setParam(paramId: string) {
    return (v: number): void => setNodeParam(id, paramId, v);
  }
  function setBoolParam(paramId: string, v: boolean): void {
    setNodeParam(id, paramId, v ? 1 : 0);
  }
  function setSavedDeviceId(deviceId: string | null): void {
    mutateNode(id, (live) => {
      if (!live.data) live.data = {};
      if (deviceId === null) delete live.data['deviceId'];
      else live.data['deviceId'] = deviceId;
    });
  }

  function videoEngine(): VideoEngine | null {
    const e = engineCtx.get();
    if (!e) return null;
    try {
      return e.getDomain<VideoEngine>('video');
    } catch {
      return null;
    }
  }

  /**
   * Refresh the device list. Returns the device labels visibility flag —
   * before permission has been granted, browsers return entries with empty
   * labels (privacy-protective). After grant, real labels appear.
   */
  async function refreshDevices(): Promise<{ hasLabels: boolean }> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
      devices = [];
      return { hasLabels: false };
    }
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const cams = all.filter((d) => d.kind === 'videoinput');
      devices = cams;
      const hasLabels = cams.some((d) => d.label !== '');
      hasDeviceLabels = hasLabels;
      return { hasLabels };
    } catch (err) {
      console.warn('[cameraInput] enumerateDevices failed:', err);
      devices = [];
      return { hasLabels: false };
    }
  }

  async function requestStream(): Promise<void> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      camState = 'unsupported';
      errorMsg = 'Browser does not support getUserMedia';
      return;
    }

    camState = 'requesting';
    errorMsg = null;

    // First: tear down any existing stream so we can re-acquire on the
    // selected device cleanly.
    stopStream();

    const targetId = selectedDeviceId;
    // Acquisition goes through the retry seam: webcam-friendly constraints
    // first, then — for a specific device that NotReadableErrors — one BARE
    // deviceId-only retry at the driver's native format. Exclusive-access
    // capture drivers (Blackmagic WDM et al.) routinely reject format hints
    // with the SAME error name as "device busy"; the retry distinguishes a
    // format-picky driver from a genuinely held device. See camera-acquire.ts.
    const result = await acquireCameraStream(
      (c) => navigator.mediaDevices.getUserMedia(c),
      targetId ?? null,
    );
    if (!result.stream) {
      const e = result.error!;
      console.warn(
        '[cameraInput] acquire failed:',
        e?.name,
        e?.message,
        `(bare retry attempted: ${result.usedBareRetry})`,
      );
      if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
        camState = 'permission-denied';
        errorMsg = 'Camera permission blocked. Grant in browser site settings.';
      } else if (e.name === 'NotFoundError' || e.name === 'OverconstrainedError') {
        camState = 'no-cameras-found';
        errorMsg = 'No camera matches the selected constraints.';
      } else if (e.name === 'NotReadableError') {
        camState = 'device-in-use';
        // NotReadableError is ambiguous: another app holding the device OR the
        // driver failing to start the source (capture cards need a live input
        // signal in a format the driver offers). Say both — "in use" alone
        // sends people hunting for an app that may not exist.
        errorMsg =
          'Camera is busy or failed to start. Close other capture apps ' +
          '(OBS, Desktop Video Setup), and check the device has a live input signal.';
      } else {
        camState = 'error';
        errorMsg = `${e.name}: ${e.message}`;
      }
      return;
    }
    stream = result.stream;

    // Permission granted — re-enumerate to pick up real device labels.
    await refreshDevices();

    // Hook the stream into the <video> element. The element itself was
    // already mounted by the template (so we can use its DOM ref); we
    // just set srcObject.
    if (videoEl) {
      videoEl.srcObject = stream;
      try {
        await videoEl.play();
      } catch (playErr) {
        // play() can reject if the page hasn't seen a user gesture yet,
        // but the click that triggered requestStream() counts as one.
        // Log and keep going — the next user interaction will retry.
        console.warn('[cameraInput] video.play() rejected:', playErr);
      }
    }

    // Announce the element to the engine module.
    const ve = videoEngine();
    ve?.attachExternalSource(id, 'video', videoEl);

    // Track the chosen device id back into Yjs once we know what we got.
    const track = stream.getVideoTracks()[0];
    if (track) {
      const settings = track.getSettings?.();
      const realId = settings?.deviceId ?? null;
      if (realId && realId !== selectedDeviceId) {
        selectedDeviceId = realId;
        setSavedDeviceId(realId);
      } else if (selectedDeviceId) {
        setSavedDeviceId(selectedDeviceId);
      }
      // Wire end-of-stream — covers permission revoke, hardware unplug,
      // sleep/wake on macOS.
      track.addEventListener('ended', () => {
        if (camState === 'streaming') {
          camState = 'error';
          errorMsg = 'Camera stream ended (disconnected or revoked).';
          stopStream();
        }
      });
    }

    camState = 'streaming';
    // Awareness signal: tell rack-mates THIS user has a CAMERA active here.
    // Stream itself stays local — the awareness field is just an id list,
    // so the receiving side can render a presence badge over the matching
    // node without seeing pixels.
    addLocalCameraNodeId(providerCtx.get(), id);
  }

  function stopStream(): void {
    if (stream) {
      for (const t of stream.getTracks()) t.stop();
      stream = null;
    }
    if (videoEl) {
      videoEl.srcObject = null;
    }
    const ve = videoEngine();
    ve?.attachExternalSource(id, 'video', null);
    // Awareness signal cleanup: peers should drop the badge when the
    // stream ends (whether user-initiated, hardware-disconnected, or
    // permission-revoked).
    removeLocalCameraNodeId(providerCtx.get(), id);
  }

  function onPickDevice(deviceId: string): void {
    selectedDeviceId = deviceId;
    setSavedDeviceId(deviceId);
    // An explicit pick is a user gesture + a clear intent to use THAT camera —
    // (re)acquire from any state except where a request can't/shouldn't fire
    // (requesting / unsupported). Critically this now includes
    // 'no-cameras-found' (loaded a patch whose saved camera is gone) and
    // 'permission-denied' / 'idle' — previously the card stayed stuck there:
    // switching cameras saved the id but never started the stream.
    if (shouldReacquireOnPick(camState)) {
      requestStream();
    }
  }

  function onToggleEnabled(): void {
    const next = p('enabled') < 0.5;
    setBoolParam('enabled', next);
    if (!next) {
      // Pause: stop the track to release the camera (matches the spec
      // §6 — paused means hardware is freed; resume re-requests).
      stopStream();
      camState = 'paused';
    } else {
      // Resume.
      requestStream();
    }
  }

  function onToggleMirror(): void {
    const next = p('mirror') < 0.5;
    setBoolParam('mirror', next);
  }

  // Live native aspect of the webcam stream (intrinsic <video> dims once a
  // frame has decoded), feeding the per-source fit/fill toggle's Native badge.
  // Falls back to 16:9 (the requested ideal 640×360) before the stream lands.
  let srcAspect = $state(16 / 9);
  $effect(() => {
    if (camState !== 'streaming') return;
    let raf: number;
    const tick = (): void => {
      if (videoEl && videoEl.videoWidth > 0 && videoEl.videoHeight > 0) {
        const a = videoEl.videoWidth / videoEl.videoHeight;
        if (Math.abs(a - srcAspect) > 0.001) srcAspect = a;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  });

  // ---- Lifecycle ----
  onMount(() => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      camState = 'unsupported';
      errorMsg = 'Browser does not support getUserMedia';
      return;
    }

    untrack(() => {
      selectedDeviceId = readSavedDeviceId();
    });

    // Populate the device list with empty labels (no permission yet).
    // The user picks "Request access" to actually start the stream.
    refreshDevices().then((res) => {
      if (devices.length === 0) {
        camState = 'no-cameras-found';
        errorMsg = 'No cameras detected.';
        return;
      }
      // If labels are already visible (permission previously granted in
      // this origin) AND the persisted toggle says enabled, auto-acquire.
      if (res.hasLabels && p('enabled') > 0.5) {
        // Guard: if a patch saved a deviceId that's no longer present (loaded on
        // a different machine / the camera was unplugged), DON'T fire the doomed
        // exact-deviceId request — it just OverconstrainedErrors. Surface "pick
        // a camera" directly so the (now working) device dropdown is the path
        // forward. A null saved id falls through to an unconstrained request
        // (the browser's default camera).
        if (savedDeviceMissing(selectedDeviceId, devices, res.hasLabels)) {
          camState = 'no-cameras-found';
          errorMsg = 'Saved camera not found — pick another from the list.';
        } else {
          requestStream();
        }
      }
    });

    // Hand the (empty, not-yet-streaming) <video> element to the engine
    // module right away so a later track attach via srcObject is picked
    // up by the per-frame readyState check without waiting for a re-mount.
    //
    // Race: the reconciler creates the engine-side node asynchronously
    // (engine.addNode is `async`). The card may mount before that
    // landed, in which case the attach is silently dropped. Poll
    // until the node exists OR we time out — once attached, the engine's
    // per-frame draw picks the videoEl up.
    let attachAttempts = 0;
    const attachInterval = setInterval(() => {
      attachAttempts++;
      const ve = videoEngine();
      // The engine's `read('cameraInput', 'hasVideoElement')` returns
      // undefined when the node doesn't exist yet, false once the
      // factory ran but no element is attached, and true once we've
      // successfully handed it across.
      const e = engineCtx.get();
      if (!e || !ve) {
        if (attachAttempts > 50) clearInterval(attachInterval); // ~5s
        return;
      }
      try {
        ve.attachExternalSource(id, 'video', videoEl);
        // Verify it stuck. read() returns undefined if the node isn't
        // registered yet (still racing the reconciler).
        const present = ve.read(id, 'hasVideoElement');
        if (present === true) clearInterval(attachInterval);
      } catch {
        // engine not ready
      }
      if (attachAttempts > 50) clearInterval(attachInterval);
    }, 100);
  });

  onDestroy(() => {
    stopStream();
    const ve = videoEngine();
    ve?.attachExternalSource(id, 'video', null);
    // Defensive: if stopStream's clear didn't run (e.g. card unmounted
    // mid-stream-acquisition), still scrub our awareness footprint.
    removeLocalCameraNodeId(providerCtx.get(), id);
  });

  // Subscribe to awareness changes — if a remote rack-mate has THIS node
  // id in their cameraNodeIds set, render the presence badge over our
  // preview area. Single-user / no-provider canvases get null and the
  // overlay never shows.
  $effect(() => {
    const provider = providerCtx.get();
    if (!provider) {
      remoteCameraUser = null;
      return;
    }
    const aw = provider.awareness;
    if (!aw) {
      remoteCameraUser = null;
      return;
    }
    const refresh = (): void => {
      const remotes: RemoteCameraPresence[] = readRemoteCameraPresence(
        aw,
        aw.clientID,
      );
      const owner = remotes.find((r) => r.nodeIds.includes(id));
      remoteCameraUser = owner ? owner.user : null;
    };
    refresh();
    aw.on('change', refresh);
    aw.on('update', refresh);
    return () => {
      aw.off('change', refresh);
      aw.off('update', refresh);
    };
  });

  // Status text for the LED row.
  const STATE_LABEL: Record<State, string> = {
    idle: 'idle',
    requesting: 'requesting…',
    streaming: 'streaming',
    paused: 'paused',
    'permission-denied': 'permission denied',
    'no-cameras-found': 'no cameras',
    'device-in-use': 'device in use',
    unsupported: 'unsupported',
    error: 'error',
  };
</script>

<div class="vcard card video">
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="CAMERA" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
  <div class="body">
    <label class="row">
      <span class="row-label">device</span>
      <select
        class="device-select"
        data-testid="camera-device-select"
        value={selectedDeviceId ?? ''}
        onchange={(e) => onPickDevice((e.currentTarget as HTMLSelectElement).value)}
        disabled={devices.length === 0}
      >
        {#if devices.length === 0}
          <option value="">(no cameras)</option>
        {:else}
          {#if !selectedDeviceId}
            <option value="" disabled selected>(pick one)</option>
          {:else if savedMissing}
            <!-- Saved camera is gone — show it as a disabled placeholder so the
                 select's displayed value matches state and picking ANY real
                 device below fires an onchange (the recovery path). -->
            <option value={selectedDeviceId} disabled selected>(saved camera not found — pick one)</option>
          {/if}
          {#each devices as d (d.deviceId)}
            <option value={d.deviceId} selected={d.deviceId === selectedDeviceId}>
              {d.label || `Camera ${d.deviceId.slice(0, 6)}`}
            </option>
          {/each}
        {/if}
      </select>
    </label>

    <div class="row status-row" data-testid="camera-status" data-state={camState}>
      <span class="led" class:streaming={camState === 'streaming'} class:warn={camState === 'paused' || camState === 'requesting'} class:err={camState === 'permission-denied' || camState === 'no-cameras-found' || camState === 'device-in-use' || camState === 'error' || camState === 'unsupported'}></span>
      <span class="status-label">{STATE_LABEL[camState]}</span>
    </div>

    {#if errorMsg}
      <div class="error" role="alert">{errorMsg}</div>
    {/if}

    <div class="preview-wrap">
      <!-- The <video> doubles as the texImage2D source. CSS scaleX(-1)
           gives the live-preview the selfie-mirror effect; the actual
           shader-side mirror is independent (controlled by params.mirror)
           so downstream modules see whatever the user sees. -->
      <!-- svelte-ignore a11y_media_has_caption -->
      <video
        bind:this={videoEl}
        data-testid="camera-preview"
        playsinline
        muted
        autoplay
        style:transform={p('mirror') > 0.5 ? 'scaleX(-1)' : 'none'}
      ></video>
      <!-- Local-only hint. The captured stream stays inside this browser
           tab — collaborators see only a presence badge, not the pixels.
           Multiplayer streaming (WebRTC + SFU) is deferred to a future
           phase; see .myrobots/plans/module-camera-input.md. -->
      {#if camState === 'streaming'}
        <div class="local-only-hint" data-testid="camera-local-only-hint">
          Local only — others won't see your camera stream
        </div>
      {/if}
      <!-- Remote-camera presence badge: shown when a rack-mate has this
           CAMERA active in THEIR browser. We can't see their pixels (the
           stream is local to their tab), but we know who's holding it. -->
      {#if remoteCameraUser && camState !== 'streaming'}
        <div
          class="remote-camera-badge"
          data-testid="camera-remote-presence"
          data-remote-user-id={remoteCameraUser.id}
          style:--remote-color={remoteCameraUser.color}
        >
          <span class="badge-dot" aria-hidden="true"></span>
          <span class="badge-text">
            {remoteCameraUser.displayName} has CAMERA active
          </span>
        </div>
      {/if}
    </div>

    <div class="controls">
      {#if camState === 'idle' || camState === 'permission-denied' || camState === 'device-in-use' || camState === 'error'}
        <button
          class="primary"
          data-testid="camera-request-access"
          onclick={requestStream}
          disabled={devices.length === 0}
        >
          {camState === 'permission-denied' ? 'Retry (in settings)' : camState === 'device-in-use' || camState === 'error' ? 'Retry' : 'Request access'}
        </button>
      {:else}
        <button
          class="ghost"
          data-testid="camera-enable-toggle"
          onclick={onToggleEnabled}
        >
          {p('enabled') > 0.5 ? 'Pause' : 'Resume'}
        </button>
      {/if}
      <button
        class="ghost"
        data-testid="camera-mirror-toggle"
        onclick={onToggleMirror}
        aria-pressed={p('mirror') > 0.5}
      >
        Mirror{p('mirror') > 0.5 ? ': on' : ': off'}
      </button>
      <NativeFillToggle
        fillMode={p('fillMode')}
        {srcAspect}
        onchange={setParam('fillMode')}
      />
    </div>

    <div class="fader-grid">
      <Fader
        value={p('gain')}
        min={0}
        max={2}
        defaultValue={cameraInputDef.params.find((x) => x.id === 'gain')!.defaultValue}
        label="Gain"
        curve="linear"
        onchange={setParam('gain')} moduleId={id} paramId="gain"
      />
    </div>
  </div>
  </PatchPanel>
</div>

<style>
  .card {
    width: 280px;
    min-height: 360px;
  }
  .body {
    /* Clear the PatchPanel's top-left/right trigger affordances (18px tall,
       inset from the corners) — same top margin the swept video cards use. */
    margin-top: 24px;
    padding: 0 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.7rem;
    color: var(--text-dim);
  }
  .row-label { min-width: 44px; text-transform: uppercase; letter-spacing: 0.05em; }
  .device-select {
    flex: 1 1 auto;
    background: #0c0e13;
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 1px;
    padding: 2px 4px;
    font-size: 0.7rem;
    font-family: ui-monospace, monospace;
  }
  .device-select:disabled { opacity: 0.5; }

  .status-row {
    align-items: center;
    gap: 6px;
  }
  .led {
    width: 8px; height: 8px; border-radius: 50%;
    background: #555;
  }
  .led.streaming { background: #16a34a; box-shadow: 0 0 4px #16a34a; }
  .led.warn { background: #ca8a04; }
  .led.err { background: #dc2626; }
  .status-label { font-family: ui-monospace, monospace; font-size: 0.65rem; }

  .error {
    font-size: 0.65rem;
    color: #fca5a5;
    background: rgba(220, 38, 38, 0.08);
    border: 1px solid rgba(220, 38, 38, 0.3);
    padding: 4px 6px;
    border-radius: 2px;
    line-height: 1.3;
  }

  .preview-wrap {
    display: flex;
    flex-direction: column;
    align-items: center;
    margin: 4px 0;
    gap: 2px;
  }
  video {
    width: 200px;
    height: 112px;
    background: #050608;
    border: 1px solid var(--cable-video);
    border-radius: 1px;
    object-fit: cover;
  }
  .local-only-hint {
    font-size: 0.6rem;
    color: var(--text-dim);
    opacity: 0.6;
    font-family: ui-sans-serif, system-ui, sans-serif;
    text-align: center;
    line-height: 1.2;
    max-width: 200px;
    letter-spacing: 0.01em;
  }
  .remote-camera-badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    margin-top: 2px;
    padding: 3px 7px;
    border-radius: 10px;
    background: rgba(20, 23, 31, 0.6);
    border: 1px solid var(--remote-color, #3b82f6);
    font-size: 0.65rem;
    color: var(--text);
    font-family: ui-sans-serif, system-ui, sans-serif;
    line-height: 1.2;
  }
  .badge-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--remote-color, #3b82f6);
    box-shadow: 0 0 4px var(--remote-color, #3b82f6);
    animation: badge-pulse 1.6s ease-in-out infinite;
  }
  @keyframes badge-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }
  .badge-text {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 175px;
  }

  .controls {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    justify-content: center;
  }
  button {
    font-family: inherit;
    font-size: 0.7rem;
    padding: 3px 8px;
    border-radius: 2px;
    cursor: pointer;
    background: #14171f;
    color: var(--text);
    border: 1px solid var(--border);
  }
  button:hover:not(:disabled) { border-color: var(--accent-dim); }
  button:disabled { opacity: 0.4; cursor: not-allowed; }
  button.primary {
    background: rgba(244, 114, 182, 0.12);
    border-color: var(--cable-video);
    color: var(--text);
  }
  button.primary:hover:not(:disabled) {
    background: rgba(244, 114, 182, 0.2);
  }

  .fader-grid {
    display: flex;
    justify-content: center;
    margin-top: 4px;
  }
</style>
