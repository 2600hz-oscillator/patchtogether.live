<script lang="ts">
  // CameraInputCard — UI for the CAMERA input video module.
  //
  // ⚠ THIS CARD OWNS NO LIFECYCLE ANY MORE (legacy-removal S1, 2026-09-03).
  // getUserMedia, enumerateDevices, the saved-device rebind, the permission
  // state machine, the engine attach and the multiplayer presence badge all
  // moved to `$lib/ui/media/node-camera-source-registry` — a NODE-keyed
  // controller Canvas syncs from the graph. What is left here is a VIEW: the
  // rack tile, the patch panel, a preview of the node-owned <video>, a device
  // picker that writes the graph, and buttons that ASK the controller to act.
  //
  // WHY. `cameraInput` was in `DOM_SOURCE_LANE_TYPES`, so the default shell kept
  // this card mounted OFF-SCREEN inside <HeadlessSourceHost> purely to keep the
  // camera alive — the card was load-bearing, and a load-bearing card cannot be
  // deleted. Every card is being deleted.
  //
  // ⚠ AND THE MOVE FIXED THE GUARDS' TIMING, not just their address. Every one
  // of the acquire guards (don't prompt on a rack load, don't request a camera
  // that is gone, "nothing saved" is not "not found") used to run in this card's
  // `onMount`. A CARD mounting is not a moment at which acquiring a camera is
  // appropriate; a NODE entering the graph is, and that is when they run now.
  //
  // ⚠ ONE DELIBERATE BEHAVIOUR CHANGE, recorded because it is not a pure
  // relocation: the awareness badge ("this user has a camera live here") now
  // tracks the STREAM rather than this card's mount. See the controller header.
  //
  // State scopes:
  //   - capture state (idle, requesting, streaming, …): per-tab, held by the
  //     controller. NOT in Yjs — permission grants are browser-instance-local.
  //   - `node.params.enabled / mirror / gain / fillMode`: in Yjs. `enabled` OWNS
  //     THE HARDWARE — the controller watches it, so a collaborator's toggle and
  //     the faceplate's ON cell free the camera exactly as this card's button does.
  //   - `node.data.deviceId` / `deviceLabel`: in Yjs. The controller watches
  //     these too, so a device picked on ANY surface (or by a rack-mate) lands.

  import { onDestroy } from 'svelte';
  import { nodeMedia, type NodeMediaLease } from '$lib/ui/media/node-media-registry';
  import { type NodeProps } from '@xyflow/svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import NeonFader from '$lib/ui/controls/NeonFader.svelte';
  import { useProvider } from '$lib/multiplayer/provider-context';
  import {
    readRemoteCameraPresence,
    type RemoteCameraPresence,
  } from '$lib/multiplayer/camera-presence';
  import type { PresenceUser } from '$lib/multiplayer/presence';
  import { setNodeParam } from '$lib/graph/mutate';
  import { cameraInputDef } from '$lib/video/modules/camera-input';
  import { savedDeviceMissing, type CameraState } from '$lib/video/camera-device';
  import {
    nodeCameraSource,
    CAMERA_SOURCE_SLOT,
  } from '$lib/ui/media/node-camera-source.svelte';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import NativeFillToggle from './NativeFillToggle.svelte';
  import { portsFromDef } from './card-kit';

  // ⚠ IMPORTED, NEVER RE-DECLARED. This used to be a local nine-member union,
  // and `loopback`'s header already flagged that as the latent defect shape: a
  // state one surface knows about and the published union does not is a string
  // another surface's lamp cannot render, with every runtime assertion green.
  // The controller and every surface now read the ONE declaration in
  // `$lib/video/camera-device`.
  type State = CameraState;

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  const providerCtx = useProvider();

  // ---- PatchPanel ports (NO raw side handles — the #767 yellow drill-down
  //      standard; also gives the card its rear-view back panel). Port `id`s are
  //      BYTE-IDENTICAL to the module def so the CV bridge + persisted edges
  //      route unchanged; only the rendering moved into the panel. ----
  const inputs = portsFromDef(cameraInputDef.inputs);
  const outputs = portsFromDef(cameraInputDef.outputs);

  // The <video> and the camera STREAM are owned by the NODE (see
  // $lib/ui/media/node-media-registry). This card ADOPTS the element to SHOW it
  // and releases it on unmount; both outlive both events.
  let videoHost: HTMLDivElement | null = $state(null);
  let mediaLease: NodeMediaLease<HTMLElement> | null = null;

  // ── The controller's published status ─────────────────────────────────────
  //
  // Read from `nodeCameraSource` rather than through `cameraStatus`, and the
  // difference from LoopbackCard is deliberate: this card needs the DEVICE
  // ROSTER, which the cross-surface status seam does not carry (it publishes
  // only `deviceCount`, because that is all the faceplate needs to decide
  // whether acquire is offerable). Widening that seam to feed one card would be
  // work that S4 deletes.
  let live = $derived(nodeCameraSource.view(id));
  let camState = $derived<State>(live.state);
  let errorMsg = $derived<string | null>(live.errorMsg);
  let devices = $derived(live.devices);
  let selectedDeviceId = $derived<string | null>(live.selectedDeviceId);
  let hasDeviceLabels = $derived(live.hasDeviceLabels);

  // The saved camera no longer resolves to an available device (loaded a patch
  // on a different machine / camera unplugged). Drives the dropdown placeholder.
  let savedMissing = $derived(
    savedDeviceMissing(
      selectedDeviceId,
      devices.map((d) => ({ deviceId: d.deviceId, label: d.label }) as MediaDeviceInfo),
      hasDeviceLabels,
    ),
  );

  // Awareness: who else (if anyone) has THIS node's CAMERA active. The stream
  // itself is local-only, so we render a presence badge instead of pixels.
  let remoteCameraUser = $state<PresenceUser | null>(null);

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

  function onPickDevice(deviceId: string): void {
    nodeCameraSource.request(id, { kind: 'pick', deviceId });
  }

  /**
   * ⚠ A REAL CLICK HANDLER, AND IT MUST STAY ONE. On a FIRST visit this is what
   * raises the permission prompt, and a browser judges that by the call's
   * activation context. `request` reaches getUserMedia synchronously, so the
   * activation survives; an `await` anywhere on the path would leave the prompt
   * unraised on exactly the visit that needed it, and every later visit would
   * work because the origin is already granted — which is the worst possible
   * shape for a bug to have.
   */
  function onRequestAccess(): void {
    const res = nodeCameraSource.request(id, { kind: 'acquire' });
    if (!res.delivered) {
      console.warn('[cameraInput] REQUEST ACCESS reached no controller for node', id);
    }
  }

  // ⚠ THE `enabled` PARAM OWNS THE HARDWARE — THIS BUTTON ONLY WRITES IT.
  //
  // It used to do both: write the param AND stop/start the track beside it, which
  // made the BUTTON the authority and left the param's documented behaviour true
  // only when the button was the writer. Every other writer — a collaborator's
  // toggle, the dock faceplate's ON cell — got the param without the hardware.
  // The controller watches the param off the graph snapshot, so all three
  // writers now free and re-request the camera identically.
  function onToggleEnabled(): void {
    setBoolParam('enabled', p('enabled') < 0.5);
  }

  function onToggleMirror(): void {
    setBoolParam('mirror', p('mirror') < 0.5);
  }

  // ---- Adopt the NODE-owned <video> into this card, to SHOW it ----
  //
  // ⚠ ADOPT, not create. The controller `ensure`s the element into existence
  // with no host, so it exists and is attached to the engine whether or not any
  // surface is mounted. Adoption is a transfer with an owner-checked release.
  let videoEl = $state<HTMLVideoElement | null>(null);
  $effect(() => {
    const host = videoHost;
    if (!host) return;
    const lease = nodeMedia.adopt(id, CAMERA_SOURCE_SLOT, host, { kind: 'video' });
    mediaLease = lease;
    videoEl = lease.el as HTMLVideoElement;
    return () => {
      lease.release();
      if (mediaLease === lease) mediaLease = null;
      videoEl = null;
    };
  });

  // The selfie-mirror is a PREVIEW transform, not the shader's. The element is
  // node-owned rather than declared here, so the binding is applied imperatively
  // — still reactive, because reading `p('mirror')` registers the dependency.
  $effect(() => {
    const v = videoEl;
    if (!v) return;
    v.style.transform = p('mirror') > 0.5 ? 'scaleX(-1)' : 'none';
  });

  // Live native aspect of the webcam stream (intrinsic <video> dims once a frame
  // has decoded), feeding the per-source fit/fill toggle's Native badge. Falls
  // back to 16:9 (the requested ideal 640×360) before the stream lands.
  //
  // ⚠ STAYS ON THE CARD, and it is the one loop that should. It reads the
  // ELEMENT this card has adopted and feeds a badge this card draws; with no
  // card mounted there is no badge to feed, and moving it would mint a rAF loop
  // running for nobody.
  let srcAspect = $state(16 / 9);
  $effect(() => {
    if (camState !== 'streaming') return;
    let raf: number;
    const tick = (): void => {
      const v = videoEl;
      if (v && v.videoWidth > 0 && v.videoHeight > 0) {
        const a = v.videoWidth / v.videoHeight;
        if (Math.abs(a - srcAspect) > 0.001) srcAspect = a;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  });

  onDestroy(() => {
    // NOTE what is deliberately ABSENT: no stop, no detach, no track teardown,
    // and — new since the extraction — no awareness removal either. Unmounting a
    // view is not a content event, and the badge is about whether a camera is
    // LIVE, which this card is not the authority on any more.
    mediaLease?.release();
    mediaLease = null;
  });

  // Subscribe to awareness changes — if a remote rack-mate has THIS node id in
  // their cameraNodeIds set, render the presence badge over our preview area.
  // Single-user / no-provider canvases get null and the overlay never shows.
  $effect(() => {
    const provider = providerCtx.get();
    const aw = provider?.awareness;
    if (!aw) {
      remoteCameraUser = null;
      return;
    }
    const refresh = (): void => {
      const remotes: RemoteCameraPresence[] = readRemoteCameraPresence(aw, aw.clientID);
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
    <!-- ⚠ THE `device` CAPTION IS GONE, THE ACCESSIBLE NAME IS NOT (owner
         directive 2026-08-23). A single select whose every option is a camera
         name does not need a word telling you it is the camera; the caption was
         the section-heading-restated class. `aria-label` keeps the name for
         anything that is not looking at the pixels — hiding the TEXT is allowed,
         dropping the NAME never is. -->
    <label class="row">
      <select
        class="device-select"
        aria-label="Camera device"
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
      <!-- The <video> is NOT declared here: it belongs to the NODE and is
           adopted into this host div (see the $effect above). The selfie-mirror
           transform is applied by a sibling effect. -->
      <div class="video-host" bind:this={videoHost}></div>
      <!-- Local-only hint. The captured stream stays inside this browser
           tab — collaborators see only a presence badge, not the pixels.
           Multiplayer streaming (WebRTC + SFU) is deferred to a future
           phase. -->
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
          onclick={onRequestAccess}
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
        <!-- ⚠ THE `: on` / `: off` SUFFIX IS GONE (owner directive 2026-08-23,
             "authored minimalist card"): it was resting text restating the
             control's own state, which `aria-pressed` already carries.
             ⚠ BUT THE STATE IS NOT MERELY HIDDEN — this card had NO
             `[aria-pressed]` styling at all, so the suffix was the only thing
             making MIRROR's state perceivable. Deleting the text alone would
             have been a functional regression dressed as tidying. The state
             moved INTO the button's appearance (see `.ghost[aria-pressed]`),
             which is how every other toggle in the fleet shows it. -->
        Mirror
      </button>
      <NativeFillToggle
        fillMode={p('fillMode')}
        {srcAspect}
        onchange={setParam('fillMode')}
      />
    </div>

    <div class="fader-grid">
      <NeonFader
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
    /* ⚠ `min-height: 360px` REMOVED (owner directive 2026-08-23: compact is the
       default, and useless grey space is never earned). The card's real content
       is the 200 px preview plus four short rows; the floor padded every state
       that is SHORTER than that — idle, permission-denied, no-cameras-found —
       into a tall grey box whose bottom third was empty by construction.
       ⚠ Removing it is safe for baselines because `cameraInput` is in
       EXEMPT_FROM_VRT for its CARD scene, so no committed PNG measures this
       card. The height now follows the content, and the preview is what earns
       the space. */
  }
  /* ⚠ THE PRESSED STATE MIRROR'S TEXT SUFFIX USED TO CARRY. This card had no
     [aria-pressed] rule, so removing ": on"/": off" without this would have
     made the toggle's state invisible rather than merely quieter. */
  .ghost[aria-pressed='true'] {
    border-color: var(--accent, #16a34a);
    color: var(--text, #e6e6e6);
    background: color-mix(in srgb, var(--accent, #16a34a) 18%, transparent);
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
  /* `.row-label` deleted with the `device` caption it styled — an unused
     selector is a svelte-check warning and, worse, an invitation to re-add the
     caption it implies is still wanted. */
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
  /* The <video> is ADOPTED into .video-host at runtime (node-owned, see
   * $lib/ui/media/node-media-registry), so these rules must be :global().
   * `display: contents` keeps the adopted element in the parent's layout. */
  .video-host { display: contents; }
  .video-host :global(video) {
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
