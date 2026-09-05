<script lang="ts">
  // packages/web/src/lib/ui/modules/videobox/VideoboxScreenBody.svelte
  //
  // The VIDEOBOX dock full-view body: the picture, the SCREEN switch, and the
  // file/transport gestures this module exists for.
  //
  // ⚠ WHY THE FACE NEEDS A BODY AT ALL. Promotion stops BOTH default surfaces
  // rendering `VideoboxCard.svelte` (`DockFullView` mounts `<ModuleShell>`
  // instead), and videobox is NOT in `DOM_SOURCE_LANE_TYPES` any more — it left
  // in LEG-02 P1 (#1511) — so there is no `<HeadlessSourceHost>` keeping an
  // off-screen card around either. Under the shell the card is not mounted
  // anywhere. Without this file a promoted videobox could not pick a file,
  // re-allow a remembered handle, drop a clip, or operate its transport.
  //
  // ⚠ THE PICTURE IS BLITTED FROM THE ENGINE AND THE `<video>` IS NEVER ADOPTED
  // HERE — the `TvLibrarianTunerBody` constraint, for the same two reasons. A
  // DOM node has exactly one parent, and this one belongs to a NODE-lifetime
  // owner that keeps it alive with nothing mounted; adopting it here would move
  // it out from under that owner. And `blitOutputForPreview` reads the module's
  // OWN output texture, which is what `gain` scales and what downstream modules
  // actually receive — a raw-element preview structurally cannot show the one
  // ranked control on this face. The engine
  // frame is the anamorphic 16:9-into-4:3 upload every downstream consumer
  // already gets (owner decision 2026-08-31 §3: blit it AS-IS; the upload's
  // aspect is a separate platform defect, not letterboxed around here).
  //
  // ⚠ NOT A SECOND OWNER. The element, its object URL, the engine attach, the
  // audio wire, the saved-handle restore, the 500 ms drift loop, the 33 ms gate
  // loop and the sync→element application are all
  // `$lib/ui/media/node-video-source-registry`'s, on NODE lifetime. This body
  // reads what the controller publishes and forwards gestures to it, exactly as
  // the legacy card does. The ONE element read it performs is a NON-OWNING
  // `nodeMedia.peek` for the playhead position (`VideoSourceStatus` publishes
  // no position or duration) — never `adopt`, never a write.
  //
  // ⚠ THE PICKER PATHS ARE PORTED VERBATIM FROM THE CARD, AND MUST STAY THAT
  // SHAPE. `showOpenFilePicker` / `getAsFileSystemHandle` are honoured only
  // inside a real user gesture and the native `<input type=file>` cannot hand
  // back a `FileSystemFileHandle` — so a body built on the input alone would
  // never persist a handle, never restore a file on rack reload, never set
  // `pendingHandleName`, and would leave the re-allow overlay permanently
  // unreachable dead code. `videobox-face-model.test.ts` pins this at source.
  import { patch } from '$lib/graph/store';
  import { mutateNode } from '$lib/graph/mutate';
  import { useEngine } from '$lib/audio/engine-context';
  import type { VideoEngine } from '$lib/video/engine';
  import { VIDEO_RES } from '$lib/video/engine';
  import type { VideoboxData } from '$lib/video/modules/videobox';
  import type { VideoboxFileMeta } from '$lib/video/modules/videobox-sync';
  import {
    canPersistVideoHandles,
    formatFileSize,
    type StoredFileHandle,
  } from '$lib/video/video-file-store';
  import {
    nodeVideoSource,
    reAllowVideoHandle,
    VIDEO_SOURCE_SLOT,
  } from '$lib/ui/media/node-video-source.svelte';
  import { nodeMedia } from '$lib/ui/media/node-media-registry';
  import { createFullscreen } from '../use-fullscreen.svelte';
  import { createFullFrame } from '../use-full-frame.svelte';
  import { attachRenderLease } from '../use-render-lease.svelte';
  import { startCornerResize } from '../card-resize';
  import VideoCanvasContextMenu from '../VideoCanvasContextMenu.svelte';
  import { drawPreviewDownscaled } from '../preview-downscale';

  interface Props {
    /** The graph node this faceplate is showing — the ONLY prop the slot gets. */
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  const engineCtx = useEngine();
  const ENGINE_W = VIDEO_RES.width;
  const ENGINE_H = VIDEO_RES.height;

  // ── The picture WELL, over the CARD'S OWN size keys ───────────────────────
  //
  // ⚠ `node.data.width` / `node.data.height` — NOT `resizedWidth` /
  // `resizedHeight` (those are graphicEq/milkdrop/monoglitch keys; using them
  // would ignore every saved rack's wall-of-TVs size). On the card these keys
  // size the CARD; here they size the PICTURE — the same meaning shift
  // `GRAPHIC_EQ_MONITOR_BOX`'s comment records for its own keys. Defaults and
  // minimum match the card (360, whole-rack-unit snapping via card-resize's
  // default quantum) so the two surfaces keep writing the same value space.
  const DEFAULT_SIZE = 360;
  const MIN_SIZE = 360;
  let wellW = $derived<number>(
    Math.max(MIN_SIZE, (patch.nodes[nodeId]?.data?.width as number | undefined) ?? DEFAULT_SIZE),
  );
  let wellH = $derived<number>(
    Math.max(MIN_SIZE, (patch.nodes[nodeId]?.data?.height as number | undefined) ?? DEFAULT_SIZE),
  );

  // ── Status, READ from the node's controller (derived, never mirrored) ─────
  let sourceStatus = $derived(nodeVideoSource.view(nodeId));
  let localFileName = $derived<string | null>(sourceStatus.fileName);
  let loadError = $derived<string | null>(sourceStatus.error);
  let pendingHandleName = $derived<string | null>(sourceStatus.pendingHandleName);
  const canRememberHandle = canPersistVideoHandles();

  // ── Reactive LEAF reads from data (Yjs-backed — leaves, never the object) ─
  let fileMeta = $derived<VideoboxFileMeta | null>(
    (patch.nodes[nodeId]?.data as Partial<VideoboxData> | undefined)?.fileMeta ?? null,
  );
  let isPlaying = $derived<boolean>(
    (patch.nodes[nodeId]?.data as Partial<VideoboxData> | undefined)?.isPlaying ?? false,
  );
  let lastSyncTime = $derived<number>(
    (patch.nodes[nodeId]?.data as Partial<VideoboxData> | undefined)?.lastSyncTime ?? 0,
  );
  let lastSyncPosition = $derived<number>(
    (patch.nodes[nodeId]?.data as Partial<VideoboxData> | undefined)?.lastSyncPosition ?? 0,
  );
  let durationSec = $derived<number>(fileMeta?.duration ?? 0);
  let hasLocalFile = $derived<boolean>(localFileName !== null);

  let showRelinkPrompt = $derived<boolean>(
    !hasLocalFile && fileMeta !== null && pendingHandleName === null,
  );

  // ── Gestures, FORWARDED to the node's controller ──────────────────────────
  function loadFile(file: File, opts?: { handle?: StoredFileHandle | null }): void {
    const res = nodeVideoSource.request(nodeId, {
      kind: 'load',
      file,
      handle: opts?.handle ?? undefined,
    });
    if (!res.delivered) {
      console.warn(`[videobox] no source controller for node ${nodeId} — the graph sync has not run`);
    }
  }

  function onFileInputChange(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    // The native <input type=file> can't hand us a FileSystemFileHandle, so a
    // pick through this path gets no remembered-handle persistence (only
    // fileMeta is saved → re-link prompt next time). The picker path below uses
    // showOpenFilePicker when available to also persist a handle.
    if (file) void loadFile(file);
    try { input.value = ''; } catch { /* */ }
  }

  // Picker button: prefer showOpenFilePicker (Chromium) so we get a
  // FileSystemFileHandle to remember; fall back to the native <input>
  // (Firefox / Safari) by letting the click bubble to its <label>.
  async function pickViaPicker(): Promise<boolean> {
    if (!canRememberHandle) return false;
    const picker = (globalThis as {
      showOpenFilePicker?: (opts?: unknown) => Promise<StoredFileHandle[]>;
    }).showOpenFilePicker;
    if (typeof picker !== 'function') return false;
    try {
      const handles = await picker({
        multiple: false,
        types: [
          { description: 'Video', accept: { 'video/*': ['.mp4', '.webm', '.mov', '.m4v', '.ogv'] } },
        ],
      });
      const handle = handles?.[0];
      if (!handle) return true; // user cancelled — still "handled"
      const file = await handle.getFile();
      loadFile(file, { handle });
    } catch (e) {
      if ((e as { name?: string })?.name !== 'AbortError') {
        loadError = `Could not open file: ${(e as Error)?.message ?? 'unknown error'}`;
      }
    }
    return true;
  }

  function onPickClick(ev: MouseEvent): void {
    if (!canRememberHandle) return; // let the native <input> handle it
    ev.preventDefault();
    void pickViaPicker();
  }

  let isDragOver = $state(false);
  function onDragOver(ev: DragEvent): void {
    ev.preventDefault();
    isDragOver = true;
  }
  function onDragLeave(): void { isDragOver = false; }
  async function onDrop(ev: DragEvent): Promise<void> {
    ev.preventDefault();
    isDragOver = false;
    // Grab a FileSystemFileHandle from the drop (Chromium) so a dropped file is
    // also remembered for one-click reload — absent on Firefox / Safari.
    const item = ev.dataTransfer?.items?.[0];
    let handle: StoredFileHandle | null = null;
    const getHandle = (item as unknown as {
      getAsFileSystemHandle?: () => Promise<StoredFileHandle | null>;
    })?.getAsFileSystemHandle;
    if (canRememberHandle && typeof getHandle === 'function') {
      try {
        const h = await getHandle.call(item);
        if (h && h.kind === 'file') handle = h;
      } catch { /* fall back to the plain File below */ }
    }
    const file = handle ? await handle.getFile().catch(() => null) : ev.dataTransfer?.files?.[0];
    if (file) void loadFile(file, { handle });
  }

  // One-click "re-allow <name>": requestPermission() is honoured only inside a
  // real user gesture, so the click performs what the controller can only offer.
  async function onReAllow(): Promise<void> {
    await reAllowVideoHandle(nodeId);
  }

  function togglePlay(): void {
    nodeVideoSource.request(nodeId, { kind: 'togglePlay' });
  }

  function onSeek(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const target = Number(input.value);
    if (!Number.isFinite(target)) return;
    nodeVideoSource.request(nodeId, { kind: 'seek', toSec: target });
  }

  function formatTime(s: number): string {
    if (!Number.isFinite(s) || s < 0) return '0:00';
    const mm = Math.floor(s / 60);
    const ss = Math.floor(s % 60).toString().padStart(2, '0');
    return `${mm}:${ss}`;
  }

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

  // ── Playhead position, derived in the SAME rAF that blits ─────────────────
  //
  // `VideoSourceStatus` publishes no position or duration, so the thumb's
  // source is derived here: the node-owned element's `currentTime` when THIS
  // browser holds a local copy (a NON-OWNING `nodeMedia.peek` — never adopt),
  // else the shared sync triple projected along the wallclock and clamped to
  // the loader-published duration, so a peer without a copy still sees the
  // thumb move. There is NO painted time readout: the card's `0:04 / 2:00`
  // line is a resting readout of derived state and is DELETED, not hidden
  // (owner ruling 2026-08-17); position survives on the slider itself and on
  // its aria-valuetext.
  let displayPos = $state(0);
  function derivePosition(): void {
    if (hasLocalFile) {
      const el = nodeMedia.peek(nodeId, VIDEO_SOURCE_SLOT) as HTMLVideoElement | null;
      if (el) { displayPos = el.currentTime; return; }
    }
    if (isPlaying) {
      const elapsed = Math.max(0, (Date.now() - lastSyncTime) / 1000);
      displayPos = Math.min(durationSec || Infinity, lastSyncPosition + elapsed);
    } else {
      displayPos = lastSyncPosition;
    }
  }

  // ── SCREEN OFF STOPS THE COPY AND KEEPS THE WATCH MARK ────────────────────
  //
  // The switch reclaims the preview's vertical space; it must never become a
  // MUTE for everything downstream. `blitOutputForPreview` IS the engine's
  // "someone is watching" signal, so a collapsed state that merely stopped
  // blitting would let the watch mark lapse and turn the switch into a
  // producer kill switch wherever nothing downstream is watching (#2015). The
  // loop keeps marking the node watched while collapsed and simply stops
  // copying pixels — the FILE keeps playing either way, because playback is
  // the node controller's, which this body never consults to draw.
  let canvasEl: HTMLCanvasElement | null = $state(null);
  let rafId: number | null = null;

  function draw(): void {
    rafId = null;
    derivePosition();
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
      const srcCanvas = videoEngine.canvas as CanvasImageSource;
      const cw = canvasEl.width;
      const ch = canvasEl.height;
      ctx2d.fillStyle = '#050608';
      ctx2d.fillRect(0, 0, cw, ch);
      // Letterbox the ENGINE frame into the well — the frame itself is blitted
      // as-is (see the header: the anamorphic upload is upstream, not ours).
      const srcAspect = ENGINE_W / ENGINE_H;
      const dstAspect = cw / ch;
      let w = cw, h = ch, x = 0, y = 0;
      if (dstAspect > srcAspect) { h = ch; w = Math.round(h * srcAspect); x = Math.round((cw - w) / 2); }
      else { w = cw; h = Math.round(w / srcAspect); y = Math.round((ch - h) / 2); }
      drawPreviewDownscaled(ctx2d, srcCanvas, x, y, w, h);
    }
    rafId = requestAnimationFrame(draw);
  }

  $effect(() => {
    if (rafId === null) rafId = requestAnimationFrame(draw);
    return () => {
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    };
  });

  // ── True fullscreen + Full Frame + the right-click menu ───────────────────
  //
  // Fullscreen shows the ENGINE READBACK, not the native-res element — a
  // visible downgrade on a documented feature, named at owner preview. The
  // canvas backing store is raised to the engine resolution while presenting so
  // the readback is at least full engine res.
  const fs = createFullscreen();
  let wrapEl: HTMLDivElement | null = $state(null);
  $effect(() => { fs.setTarget(wrapEl); });
  $effect(() => fs.attach());

  // Full Frame on the SAME `node.data.fullFrame` key the legacy card reads and
  // writes — a wall-of-TVs rack saved on either surface means the same thing on
  // the other. Tracked (mutateNode → LOCAL_ORIGIN) so it reaches Cmd-Z; the
  // card's bare write is fixed to match in the same diff.
  let fullFrame = $derived<boolean>((patch.nodes[nodeId]?.data?.fullFrame as boolean | undefined) ?? false);
  const ff = createFullFrame({
    setFullFrame: (on) => {
      mutateNode(nodeId, (live) => {
        if (!live.data) live.data = {};
        live.data.fullFrame = on;
      });
    },
    exitFullscreen: () => void fs.exit(),
  });
  let bodyEl: HTMLDivElement | null = $state(null);
  $effect(() => ff.attach(bodyEl, () => fullFrame));

  let presenting = $derived<boolean>(fs.isFullscreen || fullFrame);
  let canvasW = $derived<number>(presenting ? ENGINE_W : wellW);
  let canvasH = $derived<number>(presenting ? ENGINE_H : wellH);

  // Presenting-mode hard render lease — fullscreen / full-frame are surfaces
  // that outlive the dock's viewport rect (the card carries the same lease).
  attachRenderLease({
    engine: () => engineCtx.get(),
    nodeId: () => nodeId,
    presenting: () => fs.isFullscreen || fullFrame,
  });

  let ctxOpen = $state(false);
  let ctxX = $state(0);
  let ctxY = $state(0);
  function onPreviewContextMenu(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    ctxX = e.clientX;
    ctxY = e.clientY;
    ctxOpen = true;
  }

  // ── Corner-drag resize, over the card's own keys ──────────────────────────
  let resizing = $state(false);
  let resizeAbort: AbortController | null = null;
  let lastApplied: { w: number; h: number } | null = null;
  function onResizeStart(ev: PointerEvent) {
    ev.stopPropagation();
    resizeAbort = startCornerResize(ev, {
      flowStore: null, // the dock body is outside the SvelteFlow provider
      minWidth: MIN_SIZE,
      minHeight: MIN_SIZE,
      getStartSize: () => ({ width: wellW, height: wellH }),
      apply: (w, h) => {
        // The quantized size only moves on a tile crossing — dedupe so a drag
        // is a handful of TRACKED writes (one per crossing), never a storm.
        if (lastApplied && lastApplied.w === w && lastApplied.h === h) return;
        lastApplied = { w, h };
        mutateNode(nodeId, (live) => {
          if (!live.data) live.data = {};
          live.data.width = w;
          live.data.height = h;
        });
      },
      onStart: () => { resizing = true; lastApplied = null; },
      onEnd: () => { resizing = false; resizeAbort = null; lastApplied = null; },
    });
  }
  $effect(() => () => { if (resizeAbort) resizeAbort.abort(); });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions — drop target + the
     right-click menu; both gestures already have their own reachable controls
     (the pick label opens the same load path; the menu has the browser's own
     context-menu key route). -->
<div
  bind:this={bodyEl}
  class="videobox-body"
  class:drag-over={isDragOver}
  class:full-frame={fullFrame}
  data-testid="videobox-face-body"
  data-has-local-file={hasLocalFile}
  data-is-playing={isPlaying}
  data-full-frame={fullFrame}
  ondragover={onDragOver}
  ondragleave={onDragLeave}
  ondrop={onDrop}
>
  <!-- svelte-ignore a11y_no_static_element_interactions, a11y_no_noninteractive_element_interactions
       — oncontextmenu only; right-click already has a keyboard route the browser
       dispatches to this same event (the Menu key / Shift+F10). NOTE the codes
       are COMMA-separated: in runes mode svelte-ignore silently drops every code
       after the first unless they are (#1572's card comment records the trap). -->
  <div
    bind:this={wrapEl}
    class="preview-wrap"
    class:fullscreen={fs.isFullscreen}
    class:full-frame={fullFrame}
    class:resizing
    data-testid="videobox-face-wrap"
    data-preview-collapsed={previewCollapsed ? 'true' : 'false'}
    style={fullFrame ? '' : `width:${wellW}px;`}
    oncontextmenu={onPreviewContextMenu}
    role="img"
    aria-label={hasLocalFile || fileMeta
      ? `VIDEOBOX picture — ${fileMeta?.name ?? localFileName}`
      : 'VIDEOBOX picture — no file loaded'}
  >
    {#if !previewCollapsed}
      <canvas
        bind:this={canvasEl}
        width={canvasW}
        height={canvasH}
        data-testid="videobox-face-canvas"
        data-node-id={nodeId}
      ></canvas>
      {#if !hasLocalFile && !fileMeta && !fullFrame}
        <div class="overlay drop-hint" data-testid="videobox-drop-hint">
          <div>Drop a video file</div>
          <div class="sub">or click to select</div>
        </div>
      {:else if !hasLocalFile && pendingHandleName}
        <!-- One-click re-allow: a remembered handle exists in THIS browser but
             its read permission lapsed (patch reopened). Re-grant + reload in a
             single user gesture. -->
        <div class="overlay reallow-hint" data-testid="videobox-reallow-hint">
          <div><strong>{fileMeta?.name}</strong></div>
          <button
            type="button"
            class="reallow-btn"
            onclick={onReAllow}
            data-testid="videobox-reallow-btn"
          >Click to re-allow {fileMeta?.name}</button>
        </div>
      {:else if showRelinkPrompt}
        <!-- Re-link fallback (all browsers / cross-machine): no usable handle,
             so prompt the user to re-pick (or drop) their own copy. The <label>
             drives the native <input> on Firefox / Safari; onPickClick
             intercepts to use showOpenFilePicker on Chromium so the re-picked
             file gets a fresh remembered handle. -->
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions
             — a <label> wrapping a file <input>, whose onclick opens the Chromium
             showOpenFilePicker path; pointer-only by design (#1572). -->
        <label
          class="overlay relink-hint"
          data-testid="videobox-relink-hint"
          onclick={onPickClick}
        >
          <input
            type="file"
            accept="video/*"
            onchange={onFileInputChange}
            data-testid="videobox-relink-input"
          />
          <div class="relink-label">Re-link: drop "{fileMeta?.name}"</div>
          <div class="sub">
            {formatFileSize(fileMeta?.size)} · {formatTime(durationSec)}
          </div>
        </label>
      {/if}
    {/if}
    <button
      type="button"
      class="screen-btn nodrag"
      class:on={!previewCollapsed}
      onclick={togglePreview}
      data-testid="videobox-face-screen-toggle"
      aria-pressed={!previewCollapsed}
      title={previewCollapsed
        ? 'SCREEN is OFF — the picture is collapsed and its space reclaimed. THE FILE KEEPS PLAYING and keeps feeding VIDEO and AUDIO OUT: switching it back on shows the LIVE picture, not a stale frame.'
        : 'SCREEN — turn the picture off to collapse it and reclaim the vertical space. The file goes on playing and feeding OUT either way.'}
    >{previewCollapsed ? 'SCREEN OFF' : 'SCREEN ON'}</button>
    {#if !previewCollapsed && !fullFrame}
      <div
        class="resize-handle nodrag"
        role="separator"
        aria-label="Resize the VIDEOBOX picture"
        data-testid="videobox-face-resize-handle"
        onpointerdown={onResizeStart}
      ></div>
    {/if}
  </div>

  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions
       — a <label> wrapping a file <input>, whose onclick opens the Chromium
       showOpenFilePicker path; pointer-only by design (#1572). -->
  <label class="pick-btn" data-testid="videobox-pick-label" onclick={onPickClick}>
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
      aria-valuetext="{formatTime(displayPos)} of {formatTime(durationSec)}"
    />
  </div>

  {#if fileMeta}
    <div class="filename" title={fileMeta.name} data-testid="videobox-filename">
      {fileMeta.name}
    </div>
  {/if}
</div>

<VideoCanvasContextMenu
  bind:open={ctxOpen}
  x={ctxX}
  y={ctxY}
  title="VIDEOBOX"
  availableScreens={fs.availableScreens}
  onrequestscreens={() => void fs.loadScreens()}
  onfullscreen={(screenId) => { ff.exit(); void fs.enter(screenId); }}
  onfullframe={() => ff.toggle(fullFrame)}
  isFullFrame={fullFrame}
  onclose={() => { ctxOpen = false; }}
/>

<style>
  .videobox-body {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    min-height: 0;
    padding: 4px 0;
  }
  .videobox-body.drag-over .preview-wrap {
    border-color: var(--cable-video);
    box-shadow: 0 0 0 2px var(--cable-video);
  }

  .preview-wrap {
    position: relative;
    background: #050608;
    border: 1px solid var(--cable-video);
    border-radius: 1px;
    overflow: hidden;
    max-width: 100%;
    flex: 0 0 auto;
    /* Only load-bearing with SCREEN OFF: the canvas is gone, and without a
       floor the wrap would collapse and take the SCREEN button with it. */
    min-height: 18px;
  }
  .preview-wrap.resizing { transition: none; }
  .preview-wrap canvas {
    display: block;
    width: 100%;
    height: auto;
    background: #000;
  }
  .preview-wrap[data-preview-collapsed='true'] { border-style: dashed; }

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

  .reallow-hint { gap: 8px; }
  .reallow-btn {
    background: var(--cable-video);
    color: #000;
    border: none;
    border-radius: 2px;
    padding: 5px 12px;
    font-size: 0.65rem;
    cursor: pointer;
    letter-spacing: 0.03em;
    max-width: 90%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .reallow-btn:hover { filter: brightness(1.1); }

  .relink-hint {
    cursor: pointer;
    border: 1px dashed color-mix(in oklab, var(--cable-video) 50%, transparent);
    gap: 6px;
  }
  .relink-hint input { display: none; }
  .relink-label {
    color: var(--text);
    font-size: 0.7rem;
    max-width: 92%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .relink-hint:hover .relink-label { text-decoration: underline; }

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
    align-self: stretch;
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

  .seek {
    flex: 1;
    min-width: 0;
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
    max-width: 100%;
  }

  .screen-btn {
    position: absolute;
    right: 4px;
    top: 4px;
    background: rgba(5, 6, 8, 0.8);
    color: var(--text-dim);
    border: 1px solid var(--border);
    border-radius: 2px;
    padding: 1px 6px;
    font-size: 0.5rem;
    letter-spacing: 0.06em;
    font-family: ui-monospace, monospace;
    cursor: pointer;
    z-index: 3;
  }
  .screen-btn.on { color: var(--cable-video); border-color: var(--cable-video); }
  .preview-wrap[data-preview-collapsed='true'] .screen-btn { position: static; margin: 4px; }

  .resize-handle {
    position: absolute;
    right: 0;
    bottom: 0;
    width: 16px;
    height: 16px;
    cursor: nwse-resize;
    background: linear-gradient(
      135deg,
      transparent 50%,
      var(--cable-video) 50%,
      var(--cable-video) 60%,
      transparent 60%,
      transparent 70%,
      var(--cable-video) 70%,
      var(--cable-video) 80%,
      transparent 80%
    );
    opacity: 0.7;
    z-index: 5;
  }
  .resize-handle:hover { opacity: 1; }

  /* ── True fullscreen ─────────────────────────────────────────────────── */
  .preview-wrap.fullscreen {
    width: 100% !important;
    height: 100%;
    background: #000;
  }
  .preview-wrap.fullscreen canvas {
    width: 100%;
    height: 100%;
    object-fit: contain;
    cursor: pointer;
  }

  /* ── FULL FRAME (in-app) — the picture consumes the surface ─────────────
     The picker, transport, seekbar and filename are hidden so the body shows
     only video; the state is on node.data.fullFrame, so it syncs to peers and
     to the legacy card. Double-click exits (use-full-frame). */
  .videobox-body.full-frame .pick-btn,
  .videobox-body.full-frame .transport,
  .videobox-body.full-frame .filename,
  .videobox-body.full-frame .error {
    display: none;
  }
  .videobox-body.full-frame { align-items: stretch; }
  .preview-wrap.full-frame {
    width: 100%;
    border: none;
    border-radius: 0;
    background: #000;
    cursor: pointer;
  }
  .preview-wrap.full-frame canvas {
    width: 100%;
    height: auto;
    object-fit: contain;
  }
</style>
