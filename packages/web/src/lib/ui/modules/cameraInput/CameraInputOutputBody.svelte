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
  // ⚠ THIS FACE DOES NOT DELETE ITS CARD, WHICH IS UNIQUE IN THE FLEET.
  // `cameraInput` is in `NON_SHELL_LANE_TYPES`, so the lane always renders the
  // real card whatever `migrated()` says, while the dock reads `migrated()`
  // alone. So promotion ADDS this dock view and removes nothing: the permission
  // machine, the presence badge and the local-only hint all stay reachable in
  // the lane. That is why this body can be thin without losing parity.
  import { patch } from '$lib/graph/store';
  import { mutateNode } from '$lib/graph/mutate';
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

  // ── The capture LAMP ──────────────────────────────────────────────────────
  //
  // ⚠ IT REPORTS WHAT THE SHARED GRAPH KNOWS, AND DELIBERATELY DOES NOT CLAIM TO
  // KNOW PERMISSION STATE. The card's `camState` (idle / requesting / streaming /
  // permission-denied / device-in-use / …) is browser-instance-local `$state`
  // and is NOT in Yjs — the def says so explicitly, because a permission grant
  // is a property of one person's browser and syncing it would be a lie about
  // everyone else's. This body cannot read it, and inventing a second permission
  // machine here would fork ownership of the stream.
  //
  // So the lamp answers only questions the graph can answer: is a camera CHOSEN,
  // and is capture ENABLED. Anything about permission is deferred to the card,
  // which is always present in the lane — this face never deletes it. That is
  // the designed no-device state, rather than an error hole.
  let enabled = $derived<boolean>(
    ((patch.nodes[nodeId]?.params?.enabled as number | undefined) ?? 1) > 0.5,
  );
  let lamp = $derived<'no-device' | 'paused' | 'armed'>(
    !savedDeviceId ? 'no-device' : !enabled ? 'paused' : 'armed',
  );
  const LAMP_TITLE: Record<'no-device' | 'paused' | 'armed', string> = {
    'no-device': 'No camera chosen yet — pick one above. Permission itself is granted per browser, on the CAMERA card in the rack lane.',
    paused: 'Capture is paused (the ON control is off). The device stays selected.',
    armed: 'A camera is selected and capture is on. Whether frames are actually arriving depends on this browser\'s permission, which the CAMERA card in the rack lane reports.',
  };

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
  .lamp[data-lamp='armed'] { background: var(--accent); opacity: 1; }
  .lamp[data-lamp='paused'] { background: var(--warn, #c9a227); opacity: 1; }
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
