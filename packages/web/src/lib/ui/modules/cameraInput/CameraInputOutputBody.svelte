<script lang="ts">
  // packages/web/src/lib/ui/modules/cameraInput/CameraInputOutputBody.svelte
  //
  // The CAMERA dock full-view body: the live picture, the SCREEN switch, the
  // DEVICE PICKER, and a capture lamp.
  //
  // ⚠ THE PICTURE IS BLITTED FROM THE ENGINE AND THE `<video>` IS NEVER ADOPTED,
  // and that is the single most important line in this file. CAMERA's `<video>`
  // element is owned by the NODE and *adopted* into `CameraInputCard.svelte` at
  // runtime. A DOM node has exactly one parent — so a body that adopted it here
  // would STEAL it from the card, and the card is what owns `getUserMedia`, the
  // stream and the permission machine. "Port the card's preview" is the obvious
  // move and it would silently kill the capture the moment the dock opened.
  // `blitOutputForPreview` reads the module's own output texture instead, which
  // is what every other video face does anyway.
  //
  // ⚠ THE CARD IS STILL ALIVE, AND IS STILL THE ONLY OWNER — IT IS JUST NOT ON
  // SCREEN. Under the default shell the lane paints this module's faceplate and
  // the real card runs inside `<HeadlessSourceHost>`, parked at `left:-9999px`
  // with `pointer-events: none`. The STREAM is unaffected; every BUTTON the card
  // draws is unreachable. So this body is NOT a thin add-on to a visible card —
  // it is the only surface a player can touch, and it has to carry:
  //   * the DEVICE PICKER (below),
  //   * the ACQUIRE gesture — "Request access" / "Retry", the only route to
  //     getUserMedia for a visitor this origin has not granted before,
  //   * the capture LAMP, showing the card's REAL state rather than a guess,
  //   * and the card's RECOVERY TEXT, which is where the instructions live
  //     ("Grant in browser site settings", "Close other capture apps").
  //
  // ⚠ AND IT CARRIES THEM WITHOUT BECOMING A SECOND OWNER. `getUserMedia`, the
  // MediaStream and the permission state machine stay entirely on the card. This
  // body READS a published status and INVOKES a registered command through
  // `$lib/ui/media/camera-status-registry` — a remote control, not a second
  // machine. Two callers would be two owners, and whichever tore down last would
  // strand the survivor.
  import { patch } from '$lib/graph/store';
  import { mutateNode } from '$lib/graph/mutate';
  import { cameraStatus, type CameraStatus } from '$lib/ui/media/camera-status-registry';
  import { useEngine } from '$lib/audio/engine-context';
  import type { VideoEngine } from '$lib/video/engine';
  import { VIDEO_RES } from '$lib/video/engine';
  import { drawPreviewDownscaled } from '../preview-downscale';

  interface Props {
    /** The graph node this faceplate is showing — the ONLY prop the slot gets. */
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  const engineCtx = useEngine();
  const ENGINE_W = VIDEO_RES.width;
  const ENGINE_H = VIDEO_RES.height;

  let canvasEl: HTMLCanvasElement | null = $state(null);
  let rafId: number | null = null;

  // ── SCREEN, on the shared key ─────────────────────────────────────────────
  let previewCollapsed = $derived<boolean>(
    (patch.nodes[nodeId]?.data?.previewCollapsed as boolean | undefined) ?? false,
  );
  function togglePreview(): void {
    const next = !previewCollapsed;
    mutateNode(nodeId, (live) => {
      if (!live.data) live.data = {};
      live.data.previewCollapsed = next;
    });
  }

  // ── The DEVICE PICKER ─────────────────────────────────────────────────────
  //
  // ⚠ NOT A ParamDef, WHICH IS WHY IT IS HERE AND NOT A FACE CELL. The device
  // list is enumerated at RUNTIME from the browser, so it cannot be an `options`
  // roster on the def — a roster is a fixed set known at authoring time, and
  // this one is different on every machine and changes when hardware is plugged
  // in. `node.data.deviceId` is the persisted pick (in Yjs, per the def's own
  // note: each browser tries to match it to a local camera).
  //
  // ⚠ ENUMERATION ONLY — this body never calls `getUserMedia`. Acquisition
  // belongs to the card, which owns the stream; two callers would be two owners.
  // Without permission the browser returns device ids with EMPTY labels, which
  // is why the fallback name below is the id prefix rather than a blank row.
  let devices = $state<{ deviceId: string; label: string }[]>([]);
  let enumerateFailed = $state(false);

  let savedDeviceId = $derived<string | null>(
    (patch.nodes[nodeId]?.data?.deviceId as string | undefined) ?? null,
  );

  async function refreshDevices(): Promise<void> {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      devices = all
        .filter((d) => d.kind === 'videoinput')
        .map((d) => ({ deviceId: d.deviceId, label: d.label }));
      enumerateFailed = false;
    } catch {
      devices = [];
      enumerateFailed = true;
    }
  }

  function pickDevice(deviceId: string): void {
    if (!deviceId) return;
    // ⚠ WRITES THE SHARED KEY THE CARD ALREADY READS. The card re-acquires from
    // it (see its `$effect` on the saved id), so the pick reaches the stream
    // without this body touching `getUserMedia`.
    mutateNode(nodeId, (live) => {
      if (!live.data) live.data = {};
      live.data.deviceId = deviceId;
    });
  }

  // ── The capture LAMP, the ERROR TEXT and the ACQUIRE gesture ──────────────
  //
  // ⚠ THE LAMP READS THE CARD'S REAL STATE, NOT A GUESS ASSEMBLED FROM THE
  // GRAPH. An earlier draft derived it from `deviceId` + `enabled` alone,
  // because the card's `camState` is browser-local `$state` and deliberately NOT
  // in Yjs (a permission grant is a property of ONE person's browser; syncing it
  // would assert something false about everyone else's machine — the def says
  // so, and that part is unchanged and correct).
  //
  // But a graph-derived lamp can only say "a device is chosen and capture is
  // enabled". It cannot tell that apart from `permission-denied`, and it would
  // read ARMED while the browser refuses every frame — worse than no lamp,
  // because it actively points away from the problem. The registry solves the
  // ownership objection without the transport one: the status is published
  // in-process, per tab, and never leaves the browser it describes.
  //
  // ⚠ A NULL STATUS IS A REAL STATE AND IS RENDERED AS ONE. `null` means no card
  // has published — the node exists but nothing is mounted for it yet. It is not
  // an error and it is not `idle`; the lamp goes dim and the acquire button is
  // disabled, because there is nobody to deliver the command to.
  let live = $state<CameraStatus | null>(null);
  let commandable = $state(false);

  $effect(() => {
    const id = nodeId;
    const sync = (): void => {
      live = cameraStatus.read(id);
      commandable = cameraStatus.hasCommands(id);
    };
    sync();
    return cameraStatus.subscribe(id, sync);
  });

  let enabled = $derived<boolean>(
    ((patch.nodes[nodeId]?.params?.enabled as number | undefined) ?? 1) > 0.5,
  );

  type Lamp = 'no-card' | 'no-device' | 'paused' | 'requesting' | 'error' | 'armed' | 'streaming';
  let lamp = $derived<Lamp>(
    !live ? 'no-card'
      : live.state === 'streaming' ? 'streaming'
      : live.state === 'requesting' ? 'requesting'
      : live.state === 'paused' || !enabled ? 'paused'
      : live.state === 'idle' ? (savedDeviceId ? 'armed' : 'no-device')
      : 'error',
  );

  const LAMP_TITLE: Record<Lamp, string> = {
    'no-card': 'No CAMERA surface is mounted for this node yet — nothing has reported a capture state.',
    'no-device': 'No camera chosen yet — pick one from the list.',
    paused: 'Capture is paused (the ON control is off). The device stays selected and the hardware is released.',
    requesting: 'Asking the browser for the camera…',
    error: 'Capture is not running — see the message below.',
    armed: 'A camera is selected and capture is on, but no frames are arriving yet. Use REQUEST ACCESS to grant permission.',
    streaming: 'Capture is running: frames are arriving and feeding OUT.',
  };

  /** The card's own recovery text, verbatim — the instructions live there. */
  let errorMsg = $derived<string | null>(live?.errorMsg ?? null);

  /**
   * ⚠ THE ONLY ROUTE TO getUserMedia IN THE DEFAULT SHELL. The card's button is
   * off-screen and `pointer-events: none`; this is the gesture that reaches it.
   *
   * It must stay a real click handler on a real `<button>`: `getUserMedia`
   * requires a user gesture for a first grant, and the browser judges that by
   * the call's activation context. A programmatic call from an effect would be
   * refused, which is exactly why the card's auto-acquire only fires when
   * permission was ALREADY granted in this origin.
   */
  function requestAccess(): void {
    const res = cameraStatus.request(nodeId);
    // ⚠ DELIVERY IS REPORTED, NEVER DROPPED. An acquire writes nothing to the
    // graph, so no readParam/readData probe can see whether it landed — this log
    // is the only thing separating "the card acted" from "no card was listening".
    if (!res.delivered) {
      console.warn('[cameraInput] REQUEST ACCESS reached no card for node', nodeId);
    }
  }

  /** Offerable only when a card is listening AND the browser found a camera —
   *  the same two conditions the card's own button is disabled on. */
  let canRequest = $derived<boolean>(
    commandable && (live?.deviceCount ?? 0) > 0 && live?.state !== 'requesting',
  );

  // ── SCREEN OFF stops the COPY and keeps the WATCH MARK (#2015) ────────────
  //
  // ⚠ ON A CAPTURE SOURCE THIS IS THE WIDEST VERSION OF THE ARGUMENT. CAMERA has
  // no video input — it is the ORIGIN of whatever it feeds. A lapsed watch mark
  // drops the node from the pull set, so the switch would stop being a preview
  // control and become a MUTE for every consumer downstream. There is no
  // accumulator to lose (the picture is whatever the sensor last gave), so this
  // is the OUTPUT argument, not `vdelay`'s or `peakstate`'s.
  function draw() {
    rafId = null;
    const e = engineCtx.get();
    if (!e) { rafId = requestAnimationFrame(draw); return; }
    let videoEngine: VideoEngine | undefined;
    try { videoEngine = e.getDomain<VideoEngine>('video'); }
    catch { videoEngine = undefined; }
    if (!videoEngine) { rafId = requestAnimationFrame(draw); return; }

    if (previewCollapsed) {
      try { videoEngine.markWatched(nodeId); } catch { /* never nuke the rAF loop */ }
      rafId = requestAnimationFrame(draw);
      return;
    }

    if (!canvasEl) { rafId = requestAnimationFrame(draw); return; }
    const ctx2d = canvasEl.getContext('2d', { alpha: false });
    if (ctx2d) {
      let blitted = false;
      try { blitted = videoEngine.blitOutputForPreview(nodeId); } catch { /* never nuke the rAF loop */ }
      if (!blitted) { rafId = requestAnimationFrame(draw); return; }
      const src = videoEngine.canvas as CanvasImageSource;
      const cw = canvasEl.width;
      const ch = canvasEl.height;
      ctx2d.fillStyle = '#050608';
      ctx2d.fillRect(0, 0, cw, ch);
      const srcAspect = ENGINE_W / ENGINE_H;
      const dstAspect = cw / ch;
      let w = cw, h = ch, x = 0, y = 0;
      if (dstAspect > srcAspect) { h = ch; w = Math.round(h * srcAspect); x = Math.round((cw - w) / 2); }
      else { w = cw; h = Math.round(w / srcAspect); y = Math.round((ch - h) / 2); }
      drawPreviewDownscaled(ctx2d, src, x, y, w, h);
    }
    rafId = requestAnimationFrame(draw);
  }

  $effect(() => {
    if (rafId === null) rafId = requestAnimationFrame(draw);
    return () => {
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    };
  });

  $effect(() => {
    void refreshDevices();
    const onChange = () => { void refreshDevices(); };
    navigator.mediaDevices?.addEventListener?.('devicechange', onChange);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', onChange);
  });
</script>

<div class="camera-output" data-testid="cameraInput-output-body">
  <div class="preview-wrap" data-preview-collapsed={previewCollapsed ? 'true' : 'false'}>
    {#if !previewCollapsed}
      <canvas
        bind:this={canvasEl}
        width={480}
        height={360}
        data-testid="cameraInput-face-canvas"
        data-node-id={nodeId}
      ></canvas>
    {/if}
    <button
      type="button"
      class="screen-btn nodrag"
      class:on={!previewCollapsed}
      onclick={togglePreview}
      data-testid="cameraInput-face-screen-toggle"
      aria-pressed={!previewCollapsed}
      title={previewCollapsed
        ? 'SCREEN is OFF — the camera preview is collapsed and its space reclaimed. CAPTURE KEEPS RUNNING and keeps feeding OUT: switching it back on shows the LIVE picture, not a stale frame.'
        : 'SCREEN — turn the camera preview off to collapse it and reclaim the vertical space. Capture goes on feeding OUT either way.'}
    >{previewCollapsed ? 'SCREEN OFF' : 'SCREEN ON'}</button>
  </div>

  {#if live?.state === 'streaming'}
    <!-- ⚠ THE LOCAL-ONLY HINT IS NOT DECORATION — it is the one place the app
         tells a player that a rack-mate cannot see these pixels. It lived on the
         card, which is off-screen under the shell, so it moved here with the
         rest. Shown only while streaming, exactly as the card shows it. -->
    <p class="local-only" data-testid="cameraInput-face-local-only">
      Local only — others won't see your camera stream
    </p>
  {/if}

  {#if errorMsg}
    <!-- ⚠ THE CARD'S RECOVERY TEXT, VERBATIM AND UNSUMMARISED. This is the
         exception the resting-text rule is built to allow: it is not derived
         state restating a control, it is an ERROR with instructions, and it is
         absent whenever nothing is wrong. Paraphrasing it would drop the part
         that acts — the site-settings path, the named capture apps. -->
    <p class="error" role="alert" data-testid="cameraInput-face-error">{errorMsg}</p>
  {/if}

  <div class="picker-row">
    <!-- ⚠ The lamp carries its state in `aria-label`/`title`, not as a resting
         readout: the only TEXT here is the device NAME, which is a name rather
         than a measurement (the cvBuddy precedent for this slot). -->
    <span
      class="lamp"
      data-testid="cameraInput-face-lamp"
      data-lamp={lamp}
      role="img"
      aria-label={LAMP_TITLE[lamp]}
      title={LAMP_TITLE[lamp]}
    ></span>
    <select
      class="device-select nodrag"
      data-testid="cameraInput-face-device-select"
      value={savedDeviceId ?? ''}
      onchange={(e) => pickDevice((e.currentTarget as HTMLSelectElement).value)}
      disabled={devices.length === 0}
      aria-label="Camera device"
    >
      {#if enumerateFailed}
        <option value="">cameras unavailable</option>
      {:else if devices.length === 0}
        <option value="">no cameras</option>
      {:else}
        {#if !savedDeviceId}
          <option value="" disabled selected>pick a camera</option>
        {/if}
        {#each devices as d (d.deviceId)}
          <option value={d.deviceId} selected={d.deviceId === savedDeviceId}>
            {d.label || `Camera ${d.deviceId.slice(0, 6)}`}
          </option>
        {/each}
      {/if}
    </select>

    <!-- ⚠ THE ACQUIRE GESTURE. Under the default shell this is the ONLY
         clickable route to getUserMedia: the card's own button is parked
         off-screen with `pointer-events: none`. A first-time visitor has no
         other path, so this button is the difference between a promoted module
         and a first-run dead end. It must stay a real click on a real
         <button> — the browser grants a first permission only from a genuine
         activation context. -->
    <button
      type="button"
      class="acquire nodrag"
      onclick={requestAccess}
      disabled={!canRequest}
      data-testid="cameraInput-face-request-access"
      data-can-request={canRequest ? 'true' : 'false'}
      title={canRequest
        ? 'Ask the browser for this camera. Grants permission on first use, and retries after a failure.'
        : 'Unavailable: no camera surface is mounted for this node, no camera was found, or a request is already in flight.'}
    >{live?.state === 'permission-denied' ? 'RETRY IN SETTINGS' : live?.state === 'streaming' ? 'RE-ACQUIRE' : 'REQUEST ACCESS'}</button>
  </div>
</div>

<style>
  .camera-output {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 6px 0 2px;
  }
  /* ⚠ THE SWITCH COSTS ZERO LAYOUT HEIGHT — it OVERLAYS the picture's corner,
     so the body is exactly the height the picture is. See the OVERLAY paragraph
     in module-faceplates.md. */
  .preview-wrap {
    position: relative;
    display: flex;
    justify-content: center;
    /* Only load-bearing with SCREEN OFF: without a floor the wrap collapses to
       zero and takes the absolutely-positioned button with it. */
    min-height: 18px;
  }
  .preview-wrap canvas {
    display: block;
    border-radius: 3px;
    background: #050608;
    max-width: 100%;
    height: auto;
  }
  .screen-btn {
    position: absolute;
    right: 4px;
    bottom: 4px;
    font-size: 0.55rem;
    letter-spacing: 0.06em;
    padding: 2px 8px;
    border: 1px solid var(--border);
    border-radius: 2px;
    background: rgba(5, 6, 8, 0.72);
    color: var(--text-dim);
    cursor: pointer;
  }
  .screen-btn.on { color: var(--text); border-color: var(--accent-dim); }
  .screen-btn:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }

  .picker-row {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    max-width: 480px;
  }
  .lamp {
    width: 8px;
    height: 8px;
    flex: 0 0 auto;
    border-radius: 50%;
    background: var(--text-dim);
    opacity: 0.5;
  }
  .lamp[data-lamp='streaming'] { background: var(--accent); opacity: 1; box-shadow: 0 0 4px var(--accent); }
  .lamp[data-lamp='armed'] { background: var(--accent); opacity: 0.75; }
  .lamp[data-lamp='requesting'],
  .lamp[data-lamp='paused'] { background: var(--warn, #c9a227); opacity: 1; }
  .lamp[data-lamp='error'] { background: #dc2626; opacity: 1; }
  /* `no-card` / `no-device` keep the dim default — nothing is wrong, nothing is
     running. A red lamp for "you have not picked a camera yet" would cry wolf. */

  .local-only {
    margin: 0;
    font-size: 0.6rem;
    color: var(--text-dim);
    opacity: 0.6;
    text-align: center;
    line-height: 1.2;
    max-width: 480px;
  }
  .error {
    margin: 0;
    width: 100%;
    max-width: 480px;
    font-size: 0.65rem;
    color: #fca5a5;
    background: rgba(220, 38, 38, 0.08);
    border: 1px solid rgba(220, 38, 38, 0.3);
    padding: 4px 6px;
    border-radius: 2px;
    line-height: 1.3;
  }
  .acquire {
    flex: 0 0 auto;
    font-size: 0.55rem;
    letter-spacing: 0.06em;
    padding: 2px 8px;
    border: 1px solid var(--cable-video, var(--border));
    border-radius: 2px;
    background: rgba(244, 114, 182, 0.12);
    color: var(--text);
    cursor: pointer;
    white-space: nowrap;
  }
  .acquire:hover:not(:disabled) { background: rgba(244, 114, 182, 0.2); }
  .acquire:disabled { opacity: 0.4; cursor: not-allowed; }
  .acquire:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
  .device-select {
    flex: 1 1 auto;
    min-width: 0;
    font-size: 0.6rem;
    padding: 2px 4px;
    background: var(--module-bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 2px;
  }
</style>
