<script lang="ts">
  // VideoboxCard — file picker + multiplayer playhead.
  //
  // The card owns the <video> element + the object-URL pointing at the
  // user's picked File; the engine module (videobox.ts) samples that
  // element each video frame into its FBO + (after wireAudio) routes
  // its audio into the cross-domain audio bridge.
  //
  // Multiplayer (node.data via Yjs/SyncedStore):
  //   data.fileMeta              — name + duration, set by the loader,
  //                                visible to all peers (so they can
  //                                render "{user} loaded {filename}").
  //   data.isPlaying             — true when the player is logically
  //                                playing (shared across peers).
  //   data.lastSyncTime          — wallclock ms at the last sync write.
  //   data.lastSyncPosition      — video position (s) at lastSyncTime.
  //
  // On every local play/pause/seek we write the new sync triple to
  // data; peers observe the write through the snapshot bus + run
  // videobox-sync.ts's decideDriftCorrection to bring their local
  // element back in line.
  //
  // Peers without a local copy can still see the seekbar (its max is
  // data.fileMeta.duration, set by the loader) and the play state, but
  // their <video> stays in the "drop a file to play locally" state.

  import { onMount, onDestroy } from 'svelte';
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
  import type { VideoEngine } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';
  import {
    videoboxDef,
    type VideoboxHandleExtras,
    type VideoboxData,
  } from '$lib/video/modules/videobox';
  import {
    buildSyncWrite,
    decideDriftCorrection,
    type VideoboxFileMeta,
  } from '$lib/video/modules/videobox-sync';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  // ---- DOM refs + local state ----
  let videoEl: HTMLVideoElement | null = $state(null);
  let objectUrl: string | null = null;
  let localFileName = $state<string | null>(null);
  let isDragOver = $state(false);
  let loadError = $state<string | null>(null);

  // ---- Reactive reads from data (Yjs-backed) ----
  let fileMeta = $derived<VideoboxFileMeta | null>(
    (node?.data as Partial<VideoboxData> | undefined)?.fileMeta ?? null,
  );
  let isPlaying = $derived<boolean>(
    (node?.data as Partial<VideoboxData> | undefined)?.isPlaying ?? false,
  );
  let lastSyncTime = $derived<number>(
    (node?.data as Partial<VideoboxData> | undefined)?.lastSyncTime ?? 0,
  );
  let lastSyncPosition = $derived<number>(
    (node?.data as Partial<VideoboxData> | undefined)?.lastSyncPosition ?? 0,
  );
  let durationSec = $derived<number>(fileMeta?.duration ?? 0);

  /** Track whether THIS browser has loaded a local copy of the file. */
  let hasLocalFile = $derived<boolean>(localFileName !== null);

  // ---- Extras helper ----
  function getExtras(): VideoboxHandleExtras | null {
    const e = engineCtx.get();
    if (!e) return null;
    try {
      const ve = e.getDomain<VideoEngine>('video');
      return (ve.read(id, 'extras') as VideoboxHandleExtras | undefined) ?? null;
    } catch {
      return null;
    }
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

  // ---- Sync writers (call inside a single transact so peers see one
  //      coherent update) ----
  function writeSync(args: { isPlaying: boolean; currentPositionSec: number }): void {
    const next = buildSyncWrite({
      isPlaying: args.isPlaying,
      currentPositionSec: args.currentPositionSec,
      nowWallclockMs: Date.now(),
    });
    ydoc.transact(() => {
      const t = patch.nodes[id];
      if (!t) return;
      if (!t.data) t.data = {};
      const d = t.data as Partial<VideoboxData>;
      d.isPlaying = next.isPlaying;
      d.lastSyncTime = next.lastSyncTime;
      d.lastSyncPosition = next.lastSyncPosition;
    }, LOCAL_ORIGIN);
  }

  function writeFileMeta(meta: VideoboxFileMeta): void {
    ydoc.transact(() => {
      const t = patch.nodes[id];
      if (!t) return;
      if (!t.data) t.data = {};
      const d = t.data as Partial<VideoboxData>;
      d.fileMeta = meta;
      // Reset playhead to start so peers don't extrapolate against
      // stale lastSyncPosition that may exceed the new duration.
      d.isPlaying = false;
      d.lastSyncTime = Date.now();
      d.lastSyncPosition = 0;
    }, LOCAL_ORIGIN);
  }

  // ---- File-picker handling ----
  async function loadFile(file: File): Promise<void> {
    loadError = null;
    if (!file.type.startsWith('video/')) {
      loadError = `Not a video file: ${file.type || file.name}`;
      return;
    }
    // Free the previous object URL — leaving them around accumulates
    // ~30 MB of blob storage per swap which the browser eventually GCs
    // anyway but it's polite to release explicitly.
    if (objectUrl) {
      try { URL.revokeObjectURL(objectUrl); } catch { /* */ }
      objectUrl = null;
    }
    objectUrl = URL.createObjectURL(file);
    localFileName = file.name;
    if (!videoEl) return;
    videoEl.src = objectUrl;
    // muted=false so audio plays through MediaElementSource (which IS
    // the audio output once we wireAudio()). The video element's own
    // speaker output is muted-by-Web-Audio once createMediaElementSource
    // is called, so this attribute only matters for the brief window
    // before wireAudio runs.
    videoEl.muted = false;

    // Wait for metadata so duration + readyState are populated before
    // we publish fileMeta. loadedmetadata fires fast (<100ms typical).
    await new Promise<void>((resolve) => {
      if (!videoEl) { resolve(); return; }
      if (videoEl.readyState >= 1 /* HAVE_METADATA */) { resolve(); return; }
      const onMeta = (): void => { videoEl?.removeEventListener('loadedmetadata', onMeta); resolve(); };
      videoEl.addEventListener('loadedmetadata', onMeta, { once: true });
    });
    if (!videoEl) return;

    writeFileMeta({
      name: file.name,
      duration: Number.isFinite(videoEl.duration) ? videoEl.duration : 0,
    });

    // Now that the element has src + metadata, wire its audio into the
    // graph. Must happen exactly once per <video> element instance —
    // creating a second MediaElementSource on the same element throws
    // InvalidStateError.
    const extras = getExtras();
    extras?.wireAudio();
  }

  function onFileInputChange(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) void loadFile(file);
    try { input.value = ''; } catch { /* */ }
  }

  function onDragOver(ev: DragEvent): void {
    ev.preventDefault();
    isDragOver = true;
  }
  function onDragLeave(): void { isDragOver = false; }
  function onDrop(ev: DragEvent): void {
    ev.preventDefault();
    isDragOver = false;
    const file = ev.dataTransfer?.files?.[0];
    if (file) void loadFile(file);
  }

  // ---- Play / pause / seek ----
  function togglePlay(): void {
    if (!videoEl) {
      // No local file — still flip the shared isPlaying so peers WITH a
      // local copy follow. Position stays where it was.
      writeSync({ isPlaying: !isPlaying, currentPositionSec: lastSyncPosition });
      return;
    }
    const next = !isPlaying;
    writeSync({ isPlaying: next, currentPositionSec: videoEl.currentTime });
  }

  function onSeek(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const target = Number(input.value);
    if (!Number.isFinite(target)) return;
    if (videoEl && hasLocalFile) {
      videoEl.currentTime = target;
    }
    // Write the seek REGARDLESS of whether we have a local copy — peers
    // with copies will pick it up + jump there.
    writeSync({ isPlaying, currentPositionSec: target });
  }

  // ---- Sync-driven local element control ----
  //
  // Whenever any of (isPlaying / lastSyncTime / lastSyncPosition) change,
  // bring our local <video> back in line:
  //   - if the shared state says playing but our element is paused, play
  //   - if shared says paused but ours is playing, pause
  //   - if our position drifts > 0.5s off expected, seek
  $effect(() => {
    void isPlaying; void lastSyncTime; void lastSyncPosition;
    if (!videoEl || !hasLocalFile) return;
    const playState = isPlaying;
    if (playState && videoEl.paused) {
      // Programmatic play() can reject on autoplay-policy grounds even
      // after a user has gestured for the page (browsers gate per-element
      // sometimes). Swallow — the next user click on the play button
      // will retry from a fresh gesture.
      void videoEl.play().catch(() => { /* autoplay blocked */ });
    } else if (!playState && !videoEl.paused) {
      try { videoEl.pause(); } catch { /* */ }
    }
    const decision = decideDriftCorrection(
      { isPlaying: playState, lastSyncTime, lastSyncPosition },
      videoEl.currentTime,
      Date.now(),
      durationSec,
    );
    if (decision.kind === 'seek') {
      try { videoEl.currentTime = decision.to; } catch { /* */ }
    }
  });

  // While playing, the local element advances on its own; we ALSO need
  // a periodic drift check (separate from the sync-state change above)
  // so a local element that's running slow gradually catches up. 500ms
  // is plenty — the threshold is 0.5s, so a check at the same rate
  // bounds total drift at ~1s worst case before correction.
  let driftTimer: ReturnType<typeof setInterval> | null = null;
  function startDriftLoop(): void {
    if (driftTimer !== null) return;
    driftTimer = setInterval(() => {
      if (!videoEl || !hasLocalFile) return;
      if (!isPlaying) return;
      const dec = decideDriftCorrection(
        { isPlaying: true, lastSyncTime, lastSyncPosition },
        videoEl.currentTime,
        Date.now(),
        durationSec,
      );
      if (dec.kind === 'seek') {
        try { videoEl.currentTime = dec.to; } catch { /* */ }
      }
    }, 500);
  }
  function stopDriftLoop(): void {
    if (driftTimer !== null) { clearInterval(driftTimer); driftTimer = null; }
  }

  // ---- play_trigger gate input edge detection ----
  //
  // When a gate fires into play_trigger, the engine writes the rising-
  // edge value into the synthetic cv_play_trigger param. We poll the
  // engine's readParam for that synthetic param + detect a rising edge,
  // then toggle play state. Polling rather than reaching into the
  // factory keeps this single-direction (card observes engine; engine
  // never reaches into the card).
  let lastGateValue = 0;
  let gateTimer: ReturnType<typeof setInterval> | null = null;
  function startGateLoop(): void {
    if (gateTimer !== null) return;
    gateTimer = setInterval(() => {
      const e = engineCtx.get();
      if (!e || !node) return;
      const v = e.readParam(node, 'cv_play_trigger');
      if (typeof v !== 'number') return;
      // Rising edge across 0.5: pulse → toggle.
      if (lastGateValue < 0.5 && v >= 0.5) {
        // Compose toggle as if the user clicked play/pause locally.
        const cur = videoEl?.currentTime ?? lastSyncPosition;
        writeSync({ isPlaying: !isPlaying, currentPositionSec: cur });
      }
      lastGateValue = v;
    }, 33);
  }
  function stopGateLoop(): void {
    if (gateTimer !== null) { clearInterval(gateTimer); gateTimer = null; }
  }

  // ---- Attach the <video> element to the engine module ----
  //
  // Mirrors CameraInputCard: the factory may not exist yet when the
  // card mounts (engine.addNode is async); poll until it does or we
  // give up after ~5s.
  function attachVideoEl(): void {
    const ve = videoEngine();
    if (!ve || !videoEl) return;
    try { ve.attachExternalSource(id, 'video', videoEl); } catch { /* not ready */ }
  }

  // ---- Mount / unmount ----
  onMount(() => {
    let attempts = 0;
    const attach = setInterval(() => {
      attempts++;
      const ve = videoEngine();
      if (ve && videoEl) {
        try {
          ve.attachExternalSource(id, 'video', videoEl);
          const present = ve.read(id, 'hasVideoElement');
          if (present === true) clearInterval(attach);
        } catch { /* not ready */ }
      }
      if (attempts > 50) clearInterval(attach);
    }, 100);

    startDriftLoop();
    startGateLoop();
  });

  onDestroy(() => {
    stopDriftLoop();
    stopGateLoop();
    const ve = videoEngine();
    try { ve?.attachExternalSource(id, 'video', null); } catch { /* */ }
    const extras = getExtras();
    extras?.unwireAudio();
    if (objectUrl) {
      try { URL.revokeObjectURL(objectUrl); } catch { /* */ }
      objectUrl = null;
    }
  });

  // ---- Displayed current position ----
  //
  // While playing, derive it from the sync state + elapsed wallclock
  // (so peers without a local copy still see the seekbar slider move).
  // While paused, just show lastSyncPosition.
  let displayPos = $state(0);
  let displayTimer: ReturnType<typeof setInterval> | null = null;
  function refreshDisplay(): void {
    if (videoEl && hasLocalFile) {
      displayPos = videoEl.currentTime;
      return;
    }
    if (isPlaying) {
      const elapsed = Math.max(0, (Date.now() - lastSyncTime) / 1000);
      displayPos = Math.min(durationSec || Infinity, lastSyncPosition + elapsed);
    } else {
      displayPos = lastSyncPosition;
    }
  }
  onMount(() => {
    displayTimer = setInterval(refreshDisplay, 100);
  });
  onDestroy(() => {
    if (displayTimer !== null) clearInterval(displayTimer);
  });

  function formatTime(s: number): string {
    if (!Number.isFinite(s) || s < 0) return '0:00';
    const mm = Math.floor(s / 60);
    const ss = Math.floor(s % 60).toString().padStart(2, '0');
    return `${mm}:${ss}`;
  }
</script>

<div
  class="card video videobox-card"
  class:drag-over={isDragOver}
  data-testid="videobox-card"
  data-has-local-file={hasLocalFile}
  data-is-playing={isPlaying}
  ondragover={onDragOver}
  ondragleave={onDragLeave}
  ondrop={onDrop}
  role="region"
  aria-label="VIDEOBOX video player"
>
  <div class="stripe"></div>
  <header class="title">VIDEOBOX</header>

  <Handle type="target" position={Position.Left}  id="play_trigger" style="top: 56px; --handle-color: var(--cable-gate);" />
  <span class="port-label left" style="top: 50px;">TRIG</span>

  <Handle type="source" position={Position.Right} id="video"   style="top: 56px; --handle-color: var(--cable-video);" />
  <span class="port-label right" style="top: 50px;">VID</span>
  <Handle type="source" position={Position.Right} id="audio_l" style="top: 84px; --handle-color: var(--cable-audio);" />
  <span class="port-label right" style="top: 78px;">A-L</span>
  <Handle type="source" position={Position.Right} id="audio_r" style="top: 112px; --handle-color: var(--cable-audio);" />
  <span class="port-label right" style="top: 106px;">A-R</span>

  <div class="body">
    <div class="preview-wrap">
      <!-- svelte-ignore a11y_media_has_caption -->
      <video
        bind:this={videoEl}
        data-testid="videobox-video"
        playsinline
      ></video>
      {#if !hasLocalFile && !fileMeta}
        <div class="overlay drop-hint" data-testid="videobox-drop-hint">
          <div>Drop a video file</div>
          <div class="sub">or click to select</div>
        </div>
      {:else if !hasLocalFile && fileMeta}
        <div class="overlay peer-hint" data-testid="videobox-peer-hint">
          <div><strong>{fileMeta.name}</strong></div>
          <div class="sub">loaded by a peer — pick your own copy to play locally</div>
        </div>
      {/if}
    </div>

    <label class="pick-btn" data-testid="videobox-pick-label">
      <input
        type="file"
        accept="video/*"
        onchange={onFileInputChange}
        data-testid="videobox-file-input"
      />
      <span>{hasLocalFile ? 'Pick another video…' : 'Choose video…'}</span>
    </label>

    {#if loadError}
      <div class="error" data-testid="videobox-error">{loadError}</div>
    {/if}

    <div class="transport">
      <button
        type="button"
        class="play-btn"
        onclick={togglePlay}
        data-testid="videobox-play-btn"
        aria-pressed={isPlaying}
      >{isPlaying ? 'Pause' : 'Play'}</button>
      <span class="time" data-testid="videobox-time">
        {formatTime(displayPos)} / {formatTime(durationSec)}
      </span>
    </div>

    <input
      class="seek"
      type="range"
      min="0"
      max={Math.max(0.001, durationSec)}
      step="0.01"
      value={displayPos}
      oninput={onSeek}
      disabled={durationSec <= 0}
      data-testid="videobox-seek"
      aria-label="Video playhead"
    />

    {#if fileMeta}
      <div class="filename" title={fileMeta.name} data-testid="videobox-filename">
        {fileMeta.name}
      </div>
    {/if}
  </div>
</div>

<style>
  .card {
    width: 320px;
    min-height: 320px;
    background: var(--module-bg);
    border: 1px solid var(--border);
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
  .card.drag-over {
    border-color: var(--cable-video);
    box-shadow: 0 0 0 2px var(--cable-video), 0 2px 8px rgba(0, 0, 0, 0.3);
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
    font-size: 0.55rem;
    color: var(--text-dim);
    pointer-events: none;
    font-family: ui-monospace, monospace;
  }
  .port-label.left { left: 14px; }
  .port-label.right { right: 14px; }

  .body {
    margin-top: 28px;
    padding: 0 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .preview-wrap {
    position: relative;
    display: flex;
    justify-content: center;
    align-items: center;
    background: #050608;
    border: 1px solid var(--cable-video);
    border-radius: 1px;
    min-height: 160px;
    aspect-ratio: 16 / 9;
    overflow: hidden;
  }
  video {
    display: block;
    max-width: 100%;
    max-height: 100%;
    width: 100%;
    height: auto;
    object-fit: contain;
    background: #000;
  }
  .overlay {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    background: rgba(5, 6, 8, 0.85);
    color: var(--text);
    font-size: 0.7rem;
    padding: 8px;
    gap: 4px;
  }
  .overlay .sub {
    color: var(--text-dim);
    font-size: 0.6rem;
  }
  .drop-hint { border: 1px dashed color-mix(in oklab, var(--cable-video) 50%, transparent); }

  .pick-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: #1a1f2a;
    color: var(--text-dim);
    border: 1px dashed #404652;
    border-radius: 2px;
    padding: 4px 8px;
    font-size: 0.65rem;
    cursor: pointer;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  .pick-btn input { display: none; }
  .pick-btn:hover {
    color: var(--text);
    border-color: #6a7282;
  }

  .error {
    font-size: 0.6rem;
    color: #ff6b6b;
    font-family: ui-monospace, monospace;
  }

  .transport {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .play-btn {
    background: var(--cable-video);
    color: #000;
    border: none;
    border-radius: 2px;
    padding: 3px 10px;
    font-size: 0.7rem;
    cursor: pointer;
    letter-spacing: 0.05em;
    min-width: 56px;
  }
  .play-btn:hover { filter: brightness(1.1); }
  .time {
    font-size: 0.65rem;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
  }

  .seek {
    width: 100%;
    accent-color: var(--cable-video);
  }
  .seek:disabled { opacity: 0.5; }

  .filename {
    font-size: 0.6rem;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
