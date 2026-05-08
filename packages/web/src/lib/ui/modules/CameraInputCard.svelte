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
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { patch } from '$lib/graph/store';
  import { cameraInputDef } from '$lib/video/modules/camera-input';
  import type { VideoEngine } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';

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

  let videoEl: HTMLVideoElement | null = $state(null);
  let stream: MediaStream | null = null;
  let camState: State = $state('idle');
  let errorMsg = $state<string | null>(null);
  let devices = $state<MediaDeviceInfo[]>([]);
  let selectedDeviceId = $state<string | null>(null);

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
    return (v: number): void => {
      const target = patch.nodes[id];
      if (target) target.params[paramId] = v;
    };
  }
  function setBoolParam(paramId: string, v: boolean): void {
    const target = patch.nodes[id];
    if (target) target.params[paramId] = v ? 1 : 0;
  }
  function setSavedDeviceId(deviceId: string | null): void {
    const target = patch.nodes[id];
    if (!target) return;
    if (!target.data) target.data = {};
    if (deviceId === null) delete target.data['deviceId'];
    else target.data['deviceId'] = deviceId;
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
      return { hasLabels: cams.some((d) => d.label !== '') };
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
    const constraints: MediaStreamConstraints = {
      video: targetId
        ? {
            deviceId: { exact: targetId },
            width: { ideal: 640 },
            height: { ideal: 360 },
            frameRate: { ideal: 30 },
          }
        : {
            width: { ideal: 640 },
            height: { ideal: 360 },
            frameRate: { ideal: 30 },
          },
      audio: false,
    };

    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      const e = err as DOMException;
      if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
        camState = 'permission-denied';
        errorMsg = 'Camera permission blocked. Grant in browser site settings.';
      } else if (e.name === 'NotFoundError' || e.name === 'OverconstrainedError') {
        camState = 'no-cameras-found';
        errorMsg = 'No camera matches the selected constraints.';
      } else if (e.name === 'NotReadableError') {
        camState = 'device-in-use';
        errorMsg = 'Camera is in use by another tab or application.';
      } else {
        camState = 'error';
        errorMsg = `${e.name}: ${e.message}`;
      }
      return;
    }

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
  }

  function onPickDevice(deviceId: string): void {
    selectedDeviceId = deviceId;
    setSavedDeviceId(deviceId);
    if (camState === 'streaming' || camState === 'paused' || camState === 'device-in-use' || camState === 'error') {
      // Re-acquire on the new device.
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
      }
      // If labels are already visible (permission previously granted in
      // this origin) AND the persisted toggle says enabled, auto-acquire.
      if (res.hasLabels && p('enabled') > 0.5) {
        requestStream();
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

<div class="card video">
  <div class="stripe"></div>
  <header class="title">CAMERA</header>

  <Handle type="target" position={Position.Left} id="gain" style="top: 56px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 50px;">CV</span>

  <Handle type="source" position={Position.Right} id="out" style="top: 56px; --handle-color: var(--cable-video);" />
  <span class="port-label right" style="top: 50px;">OUT</span>

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
    </div>

    <div class="fader-grid">
      <Fader
        value={p('gain')}
        min={0}
        max={2}
        defaultValue={cameraInputDef.params.find((x) => x.id === 'gain')!.defaultValue}
        label="Gain"
        curve="linear"
        onchange={setParam('gain')}
      />
    </div>
  </div>
</div>

<style>
  .card {
    width: 280px;
    min-height: 360px;
    background: var(--module-bg);
    border: 1px solid #2a2f3a;
    border-radius: 2px;
    color: var(--text);
    padding-top: 18px;
    padding-bottom: 14px;
    position: relative;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    transition: border-color 80ms ease-out, box-shadow 80ms ease-out;
  }
  :global(.svelte-flow__node:hover) .card { border-color: var(--accent-dim); }
  :global(.svelte-flow__node.selected) .card {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .stripe {
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    border-radius: 2px 2px 0 0;
    background: var(--cable-video);
  }
  .title {
    font-size: 0.85rem;
    font-weight: 500;
    text-align: center;
    margin: 0 0 8px;
    letter-spacing: 0.05em;
  }
  .port-label {
    position: absolute;
    font-size: 0.6rem;
    color: var(--text-dim);
    pointer-events: none;
    font-family: ui-monospace, monospace;
  }
  .port-label.left { left: 14px; }
  .port-label.right { right: 14px; }

  .body {
    margin-top: 22px;
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
    border: 1px solid #2a2f3a;
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
    justify-content: center;
    margin: 4px 0;
  }
  video {
    width: 200px;
    height: 112px;
    background: #050608;
    border: 1px solid var(--cable-video);
    border-radius: 1px;
    object-fit: cover;
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
    border: 1px solid #2a2f3a;
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
