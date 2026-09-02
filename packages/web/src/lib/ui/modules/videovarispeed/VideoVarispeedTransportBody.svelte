<script lang="ts">
  // packages/web/src/lib/ui/modules/videovarispeed/VideoVarispeedTransportBody.svelte
  //
  // The VIDEOVARISPEED dock full-view body: the picture, the SCREEN switch, the
  // transport, the crop editor and the seven-slot asset bank.
  //
  // ⚠ WHY THE FACE NEEDS A BODY AT ALL. Promotion stops BOTH default surfaces
  // rendering `VideoVarispeedCard.svelte` (`DockFullView` mounts `<ModuleShell>`
  // instead), and videovarispeed is in neither `DOM_SOURCE_LANE_TYPES` nor
  // `CARD_PRODUCER_LANE_TYPES`, so there is no `<HeadlessSourceHost>` either.
  // Under the shell the card is not mounted anywhere. Without this file a
  // promoted videovarispeed could not be given a clip, scrubbed, cropped, or
  // switched between slots.
  //
  // ⚠ THE PICTURE IS BLITTED FROM THE ENGINE AND NO `<video>` IS EVER ADOPTED
  // HERE — the videobox / tvLibrarian constraint, for the same two reasons. A
  // DOM node has exactly one parent and the LEGACY card may be adopting the
  // node's element at the same moment (`?shell=legacy`), so adopting it here
  // would move it out from under that mount. And `blitOutputForPreview` reads
  // the module's OWN output texture — which is what the CROP output windows and
  // what downstream modules receive, letterboxed exactly as they see it, which
  // the card's raw-element preview structurally cannot show.
  //
  // ⚠ NOT A SECOND OWNER. The seven elements, their object URLs, the engine
  // attach, the audio wire, the transport loop, the seven virtual playheads,
  // the 33 ms CV poll, the per-slot LOADER, the saved-handle restore, the crop
  // push and its aspect re-fit are all
  // `$lib/ui/media/node-varispeed-registry`'s, on NODE lifetime. This body
  // reads what the controller publishes and forwards gestures to it, exactly as
  // the legacy card does.
  //
  // ⚠ THE PICKER PATHS ARE PORTED VERBATIM FROM THE CARD AND MUST STAY THAT
  // SHAPE. `showOpenFilePicker` / `getAsFileSystemHandle` are honoured only
  // inside a real user gesture and the native `<input type=file>` cannot hand
  // back a `FileSystemFileHandle` — so a body built on the input alone would
  // never persist a handle, never restore a clip on rack reload, never set
  // `pendingHandleName`, and would ship the re-allow overlay as permanently
  // unreachable dead code while `docs.explanation` promises it works.
  // `videovarispeed-face-model.test.ts` pins this at source.
  //
  // ⚠ THE ASSET BANK IS ALWAYS VISIBLE HERE, NOT BEHIND A RIGHT-CLICK. On the
  // card the "Load multiple…" sheet was toggled by a whole-card
  // `oncontextmenu`, which the faceplate cannot reuse: right-click is claimed
  // PER-CONTROL by `ControlContextMenu` (MIDI-learn / automation). An affordance
  // whose only opener is a gesture another owner has taken is an affordance with
  // no opener, so the bank is a section of this body.
  import { patch } from '$lib/graph/store';
  import { mutateNode } from '$lib/graph/mutate';
  import { useEngine } from '$lib/audio/engine-context';
  import type { VideoEngine } from '$lib/video/engine';
  import { VIDEO_RES } from '$lib/video/engine';
  import type { VideoboxFileMeta } from '$lib/video/modules/videobox-sync';
  import {
    VIDEOVARISPEED_MAX_SLOT_BYTES,
    type VideoVarispeedData,
  } from '$lib/video/modules/videovarispeed';
  import {
    speedKnobToMultiplier,
    effectiveSpeedKnob,
    resolveWindow,
  } from '$lib/video/modules/videovarispeed-transport';
  import { ASSET_SLOTS, ASSET_SLOT_LABELS } from '$lib/video/asset-select';
  import { canPersistVideoHandles, type StoredFileHandle } from '$lib/video/video-file-store';
  import { videoVarispeedDef } from '$lib/video/modules/videovarispeed';
  import {
    nodeVarispeed,
    reAllowVarispeedHandle,
  } from '$lib/ui/media/node-varispeed.svelte';
  import { videoAspectStore } from '$lib/ui/video-aspect-store.svelte';
  import { defaultCropRect, type CropRect } from '$lib/video/crop-core';
  import { writeCrop as commitCrop, readCrop } from '../crop-edit';
  import CropOverlay from '$lib/ui/video/CropOverlay.svelte';
  import { attachRenderLease } from '../use-render-lease.svelte';
  import { drawPreviewDownscaled } from '../preview-downscale';

  interface Props {
    /** The graph node this faceplate is showing — the ONLY prop the slot gets. */
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  const engineCtx = useEngine();
  const ENGINE_W = VIDEO_RES.width;
  const ENGINE_H = VIDEO_RES.height;
  const WELL_W = 360;

  // ── Status, READ from the node's controller (derived, never mirrored) ─────
  //
  // The card kept `slotNames`, `slotDuration`, `activeSlot` and `displayPos` as
  // component `$state` and re-hydrated them on mount. Reading THROUGH the
  // controller is what makes a surface unable to come up believing the node has
  // no clip while the bytes are live — the exact stale-mirror class that made
  // an expand snap the player back to slot 0.
  let status = $derived(nodeVarispeed.view(nodeId));
  let activeSlot = $derived<number>(status.activeSlot);
  let slotNames = $derived<readonly (string | null)[]>(status.slotNames);
  let loadError = $derived<string | null>(status.error);
  let pendingHandleName = $derived<string | null>(status.pendingHandleName);
  let displayPos = $derived<number>(status.positionSec);
  const canRememberHandle = canPersistVideoHandles();

  // ── Reactive LEAF reads from data (Yjs-backed — leaves, never the object) ─
  let slotMeta = $derived<readonly (VideoboxFileMeta | null)[]>(
    (patch.nodes[nodeId]?.data as Partial<VideoVarispeedData> | undefined)?.slotMeta
      ?? new Array(ASSET_SLOTS).fill(null),
  );
  let baseFileMeta = $derived<VideoboxFileMeta | null>(
    (patch.nodes[nodeId]?.data as Partial<VideoVarispeedData> | undefined)?.fileMeta ?? null,
  );
  /** Slot 0's legacy single-video `fileMeta` is authoritative for slot 0 (it is
   *  what the perf-zip, asset-picker and handle-reload paths read and write);
   *  slots 1..6 use their own `slotMeta` row. */
  let fileMeta = $derived<VideoboxFileMeta | null>(
    activeSlot === 0 ? (baseFileMeta ?? slotMeta[0] ?? null) : (slotMeta[activeSlot] ?? null),
  );
  let isPlaying = $derived<boolean>(
    (patch.nodes[nodeId]?.data as Partial<VideoVarispeedData> | undefined)?.isPlaying ?? false,
  );
  let loop = $derived<boolean>(
    (patch.nodes[nodeId]?.data as Partial<VideoVarispeedData> | undefined)?.loop ?? true,
  );
  let hasLocalFile = $derived<boolean>((slotNames[activeSlot] ?? null) !== null);
  /** The controller's element-read duration first (the synced `fileMeta` lags a
   *  freshly loaded slot by a round trip, and a 0 draws a dead scrubber over a
   *  clip that is playing). */
  let durationSec = $derived<number>(
    status.durationSec > 0 ? status.durationSec : (fileMeta?.duration ?? 0),
  );
  let showRelinkPrompt = $derived<boolean>(
    !hasLocalFile && fileMeta !== null && pendingHandleName === null,
  );

  // ── Gestures, FORWARDED to the node's controller ──────────────────────────
  function requestLoad(slot: number, file: File, handle?: StoredFileHandle | null): void {
    const res = nodeVarispeed.request(nodeId, {
      kind: 'loadFile',
      slot,
      file,
      handle: handle ?? undefined,
    });
    if (!res.delivered) {
      console.warn(`[videovarispeed] no controller for node ${nodeId} — the graph sync has not run`);
    }
  }

  function onFileInputChange(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    // The native <input type=file> cannot hand back a FileSystemFileHandle, so
    // a pick through this path gets no remembered-handle persistence (only
    // fileMeta → the re-link prompt next time). `onPickClick` below intercepts
    // on Chromium to use showOpenFilePicker instead.
    if (file) requestLoad(0, file);
    try { input.value = ''; } catch { /* */ }
  }

  function onSlotFileInputChange(ev: Event, slot: number): void {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) requestLoad(slot, file);
    try { input.value = ''; } catch { /* */ }
  }

  let pickError = $state<string | null>(null);

  /** Picker button: prefer showOpenFilePicker (Chromium) so we capture a
   *  FileSystemFileHandle to remember; fall back to the native <input>. */
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
      requestLoad(0, file, handle);
    } catch (e) {
      if ((e as { name?: string })?.name !== 'AbortError') {
        pickError = `Could not open file: ${(e as Error)?.message ?? 'unknown error'}`;
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
  function onDragOver(ev: DragEvent): void { ev.preventDefault(); isDragOver = true; }
  function onDragLeave(): void { isDragOver = false; }
  async function onDrop(ev: DragEvent): Promise<void> {
    ev.preventDefault();
    isDragOver = false;
    // Grab a FileSystemFileHandle from the drop (Chromium) so a dropped clip is
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
    if (file) requestLoad(0, file, handle);
  }

  // One-click "re-allow <name>": requestPermission() is honoured only inside a
  // real user gesture, so the click performs what the controller can only offer.
  async function onReAllow(): Promise<void> {
    await reAllowVarispeedHandle(nodeId);
  }

  function togglePlay(): void { nodeVarispeed.request(nodeId, { kind: 'togglePlay' }); }
  function toggleLoop(): void { nodeVarispeed.request(nodeId, { kind: 'setLoop', loop: !loop }); }
  function selectAssetSlot(i: number): void {
    nodeVarispeed.request(nodeId, { kind: 'selectSlot', slot: i });
  }
  function clearSlot(i: number): void {
    nodeVarispeed.request(nodeId, { kind: 'clearSlot', slot: i });
  }
  function onSeek(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const target = Number(input.value);
    if (!Number.isFinite(target)) return;
    nodeVarispeed.request(nodeId, { kind: 'seek', toSec: target });
  }

  function formatTime(s: number): string {
    if (!Number.isFinite(s) || s < 0) return '0:00';
    const mm = Math.floor(s / 60);
    const ss = Math.floor(s % 60).toString().padStart(2, '0');
    return `${mm}:${ss}`;
  }

  function slotHasLocalVideo(i: number): boolean {
    return i >= 0 && i < ASSET_SLOTS && (slotNames[i] ?? null) !== null;
  }

  // ── The SPEED multiplier and the empty-window warning ─────────────────────
  //
  // ⚠ BOTH PAINTED HERE, NEVER VIA `ParamDef.format` OR `landmarks` (owner
  // decision 2026-08-31 §8). `params` is NOT hash-transparent, so declaring a
  // format on an in-basis video def would cost a real-GPU re-attest for a
  // readout — and a body-side multiplier also sidesteps the "decimals gone, not
  // hidden" ruling, which governs the face's own param cells rather than a
  // transport line. The value shown is byte-identical to the card's.
  //
  // The warning is the ONLY diagnostic for a transport that genuinely HALTS:
  // with START past END `resolveWindow` returns `hasWindow: false` and the
  // controller pauses the element every frame, so Play does nothing and the
  // picture freezes with no other explanation on screen.
  function knobOf(paramId: string): number {
    const v = (patch.nodes[nodeId]?.params as Record<string, number> | undefined)?.[paramId];
    if (typeof v === 'number') return v;
    return videoVarispeedDef.params?.find((p) => p.id === paramId)?.defaultValue ?? 0;
  }
  function cvOf(paramId: string): number {
    const e = engineCtx.get();
    const node = patch.nodes[nodeId];
    if (!e || !node) return 0;
    try {
      const v = e.readParam(node, paramId);
      return typeof v === 'number' ? v : 0;
    } catch { return 0; }
  }
  let speedMult = $derived(speedKnobToMultiplier(effectiveSpeedKnob(knobOf('speed'), cvOf('speedCv'))));
  let speedLabel = $derived(`${speedMult >= 0 ? '+' : ''}${speedMult.toFixed(1)}×`);
  let windowValid = $derived(
    resolveWindow(durationSec || 1, knobOf('start'), knobOf('end')).hasWindow,
  );

  // ── CROP ─────────────────────────────────────────────────────────────────
  //
  // The rect is SYNCED `node.data.crop`, aspect-locked to the live OUTPUT
  // aspect. `cropEditing` is LOCAL surface state (the overlay shows only while
  // editing). The controller owns the push to the engine AND the aspect re-fit;
  // this only writes the value and tells the controller it moved.
  let outAspect = $derived<number>(
    videoAspectStore.engineRes.height > 0
      ? videoAspectStore.engineRes.width / videoAspectStore.engineRes.height
      : 4 / 3,
  );
  let cropState = $derived(readCrop(patch.nodes[nodeId], outAspect, outAspect));
  let cropActive = $derived<boolean>(cropState.active);
  let cropEditing = $state(false);

  function pushCrop(): void { nodeVarispeed.request(nodeId, { kind: 'cropChanged' }); }
  function addCrop(): void {
    commitCrop(nodeId, true, defaultCropRect(outAspect, outAspect));
    cropEditing = true;
    pushCrop();
  }
  function removeCrop(): void {
    commitCrop(nodeId, false, cropState.rect);
    cropEditing = false;
    pushCrop();
  }
  function toggleCropEdit(): void { cropEditing = !cropEditing; }
  function onCropChange(next: CropRect): void {
    commitCrop(nodeId, true, next);
    pushCrop();
  }

  // ── SCREEN, on the shared key ─────────────────────────────────────────────
  let previewCollapsed = $derived<boolean>(
    (patch.nodes[nodeId]?.data?.previewCollapsed as boolean | undefined) ?? false,
  );
  function togglePreview(): void {
    const next = !previewCollapsed;
    // Tracked (mutateNode → LOCAL_ORIGIN) so the switch reaches Cmd-Z like
    // every other edit, and syncs to peers on the shared key.
    mutateNode(nodeId, (live) => {
      if (!live.data) live.data = {};
      live.data.previewCollapsed = next;
    });
  }

  // ── SCREEN OFF STOPS THE COPY AND KEEPS THE WATCH MARK ────────────────────
  //
  // The switch reclaims the preview's vertical space; it must never become a
  // MUTE for everything downstream. `blitOutputForPreview` IS the engine's
  // "someone is watching" signal, so a collapsed state that merely stopped
  // blitting would let the watch mark lapse and turn the switch into a producer
  // kill switch wherever nothing downstream is watching (#2015). The loop keeps
  // marking the node watched while collapsed and simply stops copying pixels —
  // the CLIP keeps playing either way, because playback is the controller's,
  // which this body never consults to draw.
  //
  // ⚠ AND THE MARK MATTERS MORE HERE THAN FOR A STATELESS EFFECT: the CROP
  // output is a second pass over this module's own frame, so a lapsed mark
  // would idle BOTH outputs while the element went on decoding.
  let canvasEl: HTMLCanvasElement | null = $state(null);
  let rafId: number | null = null;

  function draw(): void {
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
      const srcCanvas = videoEngine.canvas as CanvasImageSource;
      const cw = canvasEl.width;
      const ch = canvasEl.height;
      ctx2d.fillStyle = '#050608';
      ctx2d.fillRect(0, 0, cw, ch);
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

  // The dock body is a viewport-rect-independent surface while it is open, so
  // it carries the same hard render lease the card does.
  attachRenderLease({
    engine: () => engineCtx.get(),
    nodeId: () => nodeId,
    presenting: () => false,
  });

  const CAP_MB = Math.round(VIDEOVARISPEED_MAX_SLOT_BYTES / (1024 * 1024));
  let canvasH = $derived<number>(Math.round(WELL_W * (ENGINE_H / ENGINE_W)));
</script>

<!-- svelte-ignore a11y_no_static_element_interactions
     — the drop TARGET is the whole body, which is a <div> by necessity: the
     player's affordances (a canvas, a file <label>, a transport, a bank of
     rows) cannot be nested inside an interactive element, and a drop zone has
     no keyboard equivalent to lose because the file <label> beside it is the
     keyboard-reachable path to exactly the same action. Same shape and same
     reason as the legacy card's own root handler (#1572). -->
<div
  class="vvs-body"
  class:drag-over={isDragOver}
  data-testid="videovarispeed-face-body"
  data-has-local-file={hasLocalFile}
  data-is-playing={isPlaying}
  data-loop={loop}
  data-active-slot={activeSlot}
  ondragover={onDragOver}
  ondragleave={onDragLeave}
  ondrop={onDrop}
>
  <div
    class="preview-wrap"
    data-testid="videovarispeed-face-wrap"
    data-preview-collapsed={previewCollapsed ? 'true' : 'false'}
    style={`width:${WELL_W}px;`}
    role="img"
    aria-label={hasLocalFile || fileMeta
      ? `VIDEOVARISPEED picture — ${fileMeta?.name ?? slotNames[activeSlot]} at ${speedLabel}`
      : 'VIDEOVARISPEED picture — no clip loaded'}
  >
    {#if !previewCollapsed}
      <canvas
        bind:this={canvasEl}
        width={WELL_W}
        height={canvasH}
        data-testid="videovarispeed-face-canvas"
        data-node-id={nodeId}
      ></canvas>
      {#if !hasLocalFile && !fileMeta}
        <div class="overlay drop-hint" data-testid="videovarispeed-drop-hint">
          <div>Drop a video file</div>
          <div class="sub">or click to select</div>
        </div>
      {:else if !hasLocalFile && pendingHandleName}
        <!-- One-click re-allow: a remembered handle exists in THIS browser but
             its read permission lapsed. Re-grant + reload in a single gesture. -->
        <div class="overlay reallow-hint" data-testid="videovarispeed-reallow-hint">
          <div><strong>{pendingHandleName}</strong></div>
          <button
            type="button"
            class="reallow-btn"
            onclick={onReAllow}
            data-testid="videovarispeed-reallow-btn"
          >Click to re-allow {pendingHandleName}</button>
        </div>
      {:else if showRelinkPrompt}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions
             — a <label> wrapping a file <input>, whose onclick opens the Chromium
             showOpenFilePicker path; pointer-only by design (#1572). -->
        <label
          class="overlay relink-hint"
          data-testid="videovarispeed-relink-hint"
          onclick={onPickClick}
        >
          <input
            type="file"
            accept="video/*"
            onchange={onFileInputChange}
            data-testid="videovarispeed-relink-input"
          />
          <div class="relink-label">Re-link: drop "{fileMeta?.name}"</div>
        </label>
      {/if}

      {#if cropEditing && cropActive}
        <CropOverlay rect={cropState.rect} aspect={outAspect} onchange={onCropChange} />
      {/if}
    {/if}
    <button
      type="button"
      class="screen-btn nodrag"
      class:on={!previewCollapsed}
      onclick={togglePreview}
      data-testid="videovarispeed-face-screen-toggle"
      aria-pressed={!previewCollapsed}
      title={previewCollapsed
        ? 'SCREEN is OFF — the picture is collapsed and its space reclaimed. THE CLIP KEEPS PLAYING and keeps feeding VIDEO, CROP and AUDIO OUT: switching it back on shows the LIVE picture, not a stale frame.'
        : 'SCREEN — turn the picture off to collapse it and reclaim the vertical space. The clip goes on playing and feeding OUT either way.'}
    >{previewCollapsed ? 'SCREEN OFF' : 'SCREEN ON'}</button>
  </div>

  <div class="crop-row">
    {#if !cropActive}
      <button
        type="button"
        class="crop-btn"
        onclick={addCrop}
        data-testid="videovarispeed-add-crop"
        title="Overlay a resizable, aspect-locked crop box; the CROP output zooms into it"
      >add crop</button>
    {:else}
      <button
        type="button"
        class="crop-btn"
        class:on={cropEditing}
        onclick={toggleCropEdit}
        data-testid="videovarispeed-edit-crop"
        aria-pressed={cropEditing}
        title="Show/hide the crop box editor"
      >{cropEditing ? 'done' : 'edit crop'}</button>
      <button
        type="button"
        class="crop-btn remove"
        onclick={removeCrop}
        data-testid="videovarispeed-remove-crop"
        title="Remove the crop — the CROP output returns to the full frame"
      >remove crop</button>
    {/if}
  </div>

  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions
       — a <label> wrapping a file <input>, whose onclick opens the Chromium
       showOpenFilePicker path; pointer-only by design (#1572). -->
  <label class="pick-btn" data-testid="videovarispeed-pick-label" onclick={onPickClick}>
    <input
      type="file"
      accept="video/*"
      onchange={onFileInputChange}
      data-testid="videovarispeed-file-input"
    />
    <span>{hasLocalFile ? 'Pick another video…' : 'Choose video…'}</span>
  </label>

  {#if loadError || pickError}
    <div class="error" data-testid="videovarispeed-error">{loadError ?? pickError}</div>
  {/if}

  <div class="transport">
    <button
      type="button"
      class="play-btn"
      onclick={togglePlay}
      data-testid="videovarispeed-play-btn"
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
      data-testid="videovarispeed-seek"
      aria-label="Video playhead"
      aria-valuetext="{formatTime(displayPos)} of {formatTime(durationSec)}"
    />
    <!-- The SPEED multiplier, body-side beside the scrubber (owner decision
         2026-08-31 §8). It is the READING of the asymmetric clock-face law the
         knob's angle alone cannot give. -->
    <span class="speed-readout" data-testid="videovarispeed-speed-readout">{speedLabel}</span>
    <button
      type="button"
      class="loop-btn"
      class:on={loop}
      onclick={toggleLoop}
      data-testid="videovarispeed-loop-btn"
      aria-pressed={loop}
      title="Toggle LOOP (jump to START at END) vs ONE-SHOT (stop at END)"
    >{loop ? 'LOOP' : '1-SHOT'}</button>
  </div>

  {#if !windowValid}
    <div class="warn" data-testid="videovarispeed-window-warn">START past END — no playback</div>
  {/if}

  {#if fileMeta}
    <div class="filename" title={fileMeta.name} data-testid="videovarispeed-filename">
      {fileMeta.name}
    </div>
  {/if}

  <!-- The 7-slot ASSET BANK. Rows are the C-major scale degrees C..B: a clip
       player's pitch+gate switches which one plays through the ASSET ports, and
       a click here does the same thing by hand. -->
  <div class="bank" data-testid="videovarispeed-multi-panel">
    <div class="bank-head">ASSET BANK — max {CAP_MB} MB/slot</div>
    {#each ASSET_SLOT_LABELS as label, i (i)}
      <!-- data-slot-local: true once THIS browser holds the slot's bytes,
           distinct from the synced name a peer who never had the file shows. -->
      <div
        class="slot-row"
        class:active={i === activeSlot}
        data-testid="videovarispeed-slot-{i}"
        data-slot-local={(slotNames[i] ?? null) !== null}
      >
        <button
          type="button"
          class="slot-note"
          onclick={() => selectAssetSlot(i)}
          disabled={!slotHasLocalVideo(i)}
          aria-pressed={i === activeSlot}
          data-testid="videovarispeed-slot-select-{i}"
          title={slotHasLocalVideo(i) ? `Play slot ${label}` : `Slot ${label} is empty`}
        >{label}</button>
        <label class="slot-load">
          <input
            type="file"
            accept="video/*"
            onchange={(e) => onSlotFileInputChange(e, i)}
            data-testid="videovarispeed-slot-input-{i}"
          />
          <span>{status.loadingSlots[i] ? '…' : 'Load video…'}</span>
        </label>
        <span
          class="slot-name"
          title={slotNames[i] ?? (slotMeta[i]?.name ?? '')}
          data-testid="videovarispeed-slot-name-{i}"
        >{slotNames[i] ?? slotMeta[i]?.name ?? '—'}</span>
        {#if slotNames[i] || slotMeta[i]}
          <button
            type="button"
            class="slot-clear"
            onclick={() => clearSlot(i)}
            data-testid="videovarispeed-slot-clear-{i}"
            aria-label="Clear slot {label}"
          >✕</button>
        {/if}
      </div>
    {/each}
  </div>
</div>

<style>
  .vvs-body {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    min-height: 0;
    padding: 4px 0;
  }
  .vvs-body.drag-over .preview-wrap {
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
    min-height: 30px;
  }
  .preview-wrap canvas { display: block; width: 100%; height: auto; }

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
  .overlay .sub { color: var(--text-dim); font-size: 0.6rem; }
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

  .screen-btn {
    position: absolute;
    right: 6px;
    top: 6px;
    z-index: 4;
    background: #0c0f14;
    color: var(--text-dim);
    border: 1px solid #404652;
    border-radius: 2px;
    padding: 2px 7px;
    font-size: 0.55rem;
    letter-spacing: 0.06em;
    font-family: ui-monospace, monospace;
    cursor: pointer;
  }
  .screen-btn.on { color: #87c8ff; border-color: #87c8ff; }

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
  .pick-btn:hover { color: var(--text); border-color: #6a7282; }

  .error { font-size: 0.6rem; color: #ff6b6b; font-family: ui-monospace, monospace; }
  .warn { font-size: 0.6rem; color: #ffb347; font-family: ui-monospace, monospace; }

  .transport { display: flex; align-items: center; gap: 8px; width: 100%; max-width: 360px; }
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
  .seek { flex: 1; min-width: 0; accent-color: var(--cable-video); }
  .seek:disabled { opacity: 0.5; }
  .speed-readout {
    font-family: ui-monospace, monospace;
    font-size: 0.6rem;
    color: var(--text-dim);
    letter-spacing: 0.05em;
    min-width: 46px;
    text-align: right;
    flex: none;
  }
  .loop-btn {
    background: var(--module-bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 3px;
    font-size: 0.6rem;
    letter-spacing: 0.06em;
    padding: 3px 8px;
    cursor: pointer;
    font-family: ui-monospace, monospace;
    min-width: 52px;
    flex: none;
  }
  .loop-btn:hover { border-color: var(--accent-dim); }
  .loop-btn.on {
    background: rgba(135, 200, 255, 0.2);
    color: #87c8ff;
    border-color: #87c8ff;
  }

  .crop-row { display: flex; gap: 6px; align-items: center; }
  .crop-btn {
    background: #1a1f2a;
    color: var(--text-dim);
    border: 1px solid #404652;
    border-radius: 2px;
    padding: 3px 9px;
    font-size: 0.62rem;
    cursor: pointer;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    font-family: ui-monospace, monospace;
  }
  .crop-btn:hover { color: var(--text); border-color: #6a7282; }
  .crop-btn.on {
    background: rgba(255, 59, 59, 0.16);
    border-color: #ff3b3b;
    color: #ff8a8a;
  }
  .crop-btn.remove:hover { color: #ff8a8a; border-color: #ff3b3b; }

  .filename {
    font-size: 0.6rem;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 360px;
  }

  .bank {
    width: 100%;
    max-width: 360px;
    padding: 6px;
    background: #0c0f14;
    border: 1px solid var(--cable-video);
    border-radius: 2px;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .bank-head {
    font-size: 0.55rem;
    color: var(--cable-video);
    font-family: ui-monospace, monospace;
    letter-spacing: 0.03em;
    margin-bottom: 2px;
  }
  .slot-row {
    display: grid;
    grid-template-columns: 22px auto 1fr 14px;
    align-items: center;
    gap: 5px;
  }
  .slot-note {
    font-size: 0.65rem;
    font-weight: 600;
    color: var(--cable-video);
    font-family: ui-monospace, monospace;
    text-align: center;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
  }
  .slot-note:disabled { opacity: 0.45; cursor: default; }
  .slot-row.active .slot-note { color: #87c8ff; }
  .slot-load {
    display: inline-block;
    padding: 1px 6px;
    background: var(--cable-video);
    color: #000;
    border-radius: 2px;
    font-size: 0.55rem;
    cursor: pointer;
    user-select: none;
  }
  .slot-load input { display: none; }
  .slot-name {
    font-size: 0.55rem;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .slot-clear {
    background: none;
    border: none;
    color: var(--text-dim);
    cursor: pointer;
    font-size: 0.65rem;
    padding: 0 2px;
    line-height: 1;
  }
  .slot-clear:hover { color: #ff6b6b; }
</style>
