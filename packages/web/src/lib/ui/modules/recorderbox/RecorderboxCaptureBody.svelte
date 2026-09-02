<script lang="ts">
  // packages/web/src/lib/ui/modules/recorderbox/RecorderboxCaptureBody.svelte
  //
  // THE RECORDERBOX dock full-view body — the whole faceplate, because
  // `recorderboxDef` declares `params: []` and `face.order: []`: there is
  // nothing for the generic control bands to render (the `videoOut` / `flipper`
  // shape).
  //
  // It carries, in order: the crash-RECOVERY block, the live preview + SCREEN
  // switch, the two lamps, the FILE field, the DIR row, the SIZE picker and the
  // RECORD switch. Every one of them existed only on `RecorderboxCard.svelte`,
  // which the default shell stops mounting on promotion — recorderbox is in
  // NEITHER half of `HEADLESS_MOUNT_LANE_TYPES`, so there is no headless host
  // keeping a card alive off-screen either.
  //
  // ⚠ THE RECOVERY BLOCK IS FIRST, AND IT IS THE ONE THING HERE WITH UNSAVED
  // USER DATA BEHIND IT. On the card it was appended LAST, landed outside a
  // rack-tier-pinned `overflow: hidden` box and had to be rescued with an
  // absolute overlay (see `recorderbox-recover-reachable.spec.ts`, an
  // owner-reported bug). A dock pane has no such pin, so the honest fix is to
  // put the blocking question at the top of the flow and delete the overlay
  // geometry with it. It is ABSENT at rest — `listRecoverable` returns nothing
  // after a clean boot — so the idle baseline stays deterministic.
  //
  // ⚠ WHAT THIS BODY MUST NEVER DO: create, own or tear down the recording. The
  // capture canvas, the encode pump and the render lease belong to
  // `node-recorder-registry` on NODE lifetime (#1574 — a card `onDestroy` that
  // called `recorder.abandon()` made COLLAPSING the dock destroy the user's
  // take). The registry deliberately exposes no teardown, so this component
  // cannot re-introduce that bug: there is no method to call. Everything here
  // goes through `../recorderbox-transport`.
  //
  // ⚠ SCREEN OFF CANNOT REACH THE ENCODE — a STRONGER guarantee than the
  // fleet's correctly-ordered `markWatched`. A take runs on the registry's OWN
  // pump under `acquireRenderLease`, and a lease bypasses BOTH preview gates, so
  // the recording is at full rate whether this body is collapsed, unmounted or
  // throttled. The `markWatched` call in the collapsed branch is still here and
  // still load-bearing for the case with NO take running: `blitOutputForPreview`
  // IS the engine's "someone is watching" signal, and a node drops out of the
  // pull set 1.5 s after its last mark — so without it, SCREEN OFF on an idle
  // recorderbox would idle the whole upstream chain feeding `in` and stall the
  // `out` pass-through every downstream module is reading.
  import { onDestroy, untrack } from 'svelte';
  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import { mutateNode } from '$lib/graph/mutate';
  import { useEngine } from '$lib/audio/engine-context';
  import { VIDEO_RES, type VideoEngine } from '$lib/video/engine';
  import { QUALITY_VALUES, qualityLabel } from '$lib/video/recorderbox-quality';
  import StatusLed from '$lib/ui/controls/StatusLed.svelte';
  import { drawPreviewDownscaled } from '../preview-downscale';
  import { nodeRecorder } from '../node-recorder-registry.svelte';
  import {
    UNCHECKED_SUPPORT,
    changeRecorderboxFolder,
    discardTake,
    folderDisplayName,
    formatElapsed,
    probeRecorderboxSupport,
    recoverTake,
    reconcileRecorderboxTransport,
    recorderboxFilename,
    recorderboxNode,
    recorderboxQuality,
    recorderboxRecording,
    scanRecoverableTakes,
    setRecorderboxData,
    videoEngineOf,
    type RecorderboxManifest,
    type RecorderboxSupport,
  } from '../recorderbox-transport';

  interface Props {
    /** The graph node this faceplate is showing — the ONLY prop the slot gets
     *  (`ShellExtensionFullViewBodyProps`). */
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  const engineCtx = useEngine();

  // ── Node-backed state.
  // ⚠ TWO THINGS ARE WRONG WITH THE OBVIOUS `$derived(patch.nodes[id]...)`, AND
  // BOTH WERE MEASURED HERE RATHER THAN INHERITED:
  //
  //   1. `patch.nodes[id]` IS NOT REACTIVE ON ITS OWN. `node-versions.svelte.ts`
  //      maintains a per-node signal from ONE `nodes.observeDeep`, and
  //      `nodeVersion(id)` is how a surface subscribes to it — which is exactly
  //      what `ModuleShell` does before every live-node read.
  //   2. ⚠ TOUCHING THE SIGNAL IS NOT ENOUGH IF THE DERIVED RETURNS THE NODE.
  //      The SyncedStore node proxy has a STABLE IDENTITY, so a derived that
  //      recomputes to "the same proxy" is value-equal and Svelte does not
  //      notify its dependents at all
  //      ([[yjs-proxy-stable-identity-defeats-derived]]). So each derivation
  //      below returns the LEAF — a boolean, a string, an enum — whose value
  //      really does change, which is the same shape `ModuleShell.displayName`
  //      uses.
  //
  // MEASURED, in that order: with neither, a RECORD press wrote
  // `data.recording = true` to the doc and nothing reacted. With (1) alone the
  // effect STILL never re-ran — the reconcile logged exactly twice, both with
  // `recording === false`, while `__patch.nodes.d1.data.recording` was true.
  // A unit test over `node.data` passes on both states, which is why this is a
  // comment and an e2e leg rather than a hope.
  let filename = $derived.by(() => {
    void nodeVersion(nodeId);
    return recorderboxFilename(patch.nodes[nodeId] ?? null);
  });
  let recording = $derived.by(() => {
    void nodeVersion(nodeId);
    return recorderboxRecording(patch.nodes[nodeId] ?? null);
  });
  let quality = $derived.by(() => {
    void nodeVersion(nodeId);
    return recorderboxQuality(patch.nodes[nodeId] ?? null);
  });

  // ⚠ VIEW STATE ON THE NODE, NOT IN THE COMPONENT. This body unmounts on dock
  // collapse / LRU eviction (the #1531 / #1574 / #1583 class), and `node.data`
  // is what survives a remount, a reload and collab sync. Absent ⇒ false ⇒ ON.
  let previewCollapsed = $derived.by<boolean>(() => {
    void nodeVersion(nodeId);
    return (patch.nodes[nodeId]?.data?.previewCollapsed as boolean | undefined) ?? false;
  });
  function togglePreview(): void {
    const next = !previewCollapsed;
    mutateNode(nodeId, (live) => {
      if (!live.data) live.data = {};
      live.data.previewCollapsed = next;
    });
  }

  // ── Registry reads. NOT component state: the recording outlives this mount.
  let live = $derived(nodeRecorder.view(nodeId));
  let recState = $derived(live?.state ?? 'idle');
  let elapsed = $derived(live?.elapsed ?? 0);
  let lastSavedChunk = $derived<string | null>(live?.lastSavedChunk ?? null);
  let saveFolder = $derived(nodeRecorder.folderFor(nodeId));
  let folderName = $derived(folderDisplayName(saveFolder));
  let busy = $derived(recState === 'recording' || recState === 'finalizing');

  let support = $state<RecorderboxSupport>(UNCHECKED_SUPPORT);
  let folderHint = $state<string | null>(null);
  let recoverable = $state<RecorderboxManifest[]>([]);

  let previewEl: HTMLCanvasElement | null = $state(null);
  let rafId: number | null = null;

  // ── The TRANSPORT. One line, and the reasoning lives in the seam so the two
  //    faceplate surfaces and the legacy card cannot drift (see
  //    ../recorderbox-transport's header: `data.recording` is Y.Doc-synced, so
  //    a rack-mate's press and a loaded-armed patch reach it too).
  $effect(() => {
    reconcileRecorderboxTransport({
      nodeId,
      recording: () => recording,
      canRecord: () => support.canRecord,
      engine: () => engineCtx.get(),
      stillArmed: () => recorderboxRecording(recorderboxNode(nodeId)),
      setFolderHint: (h) => { folderHint = h; },
    });
  });

  async function rescan(): Promise<void> {
    recoverable = await scanRecoverableTakes(nodeId);
  }

  $effect(() => {
    void nodeId;
    untrack(() => {
      void probeRecorderboxSupport(VIDEO_RES.width, VIDEO_RES.height).then((s) => {
        support = s;
      });
      void rescan();
    });
  });

  function toggleRecord(): void {
    if (!support.canRecord) return;
    setRecorderboxData(nodeId, 'recording', !recording);
  }

  function onFilenameInput(e: Event): void {
    setRecorderboxData(nodeId, 'filename', (e.target as HTMLInputElement).value);
  }

  function onQualityChange(e: Event): void {
    setRecorderboxData(nodeId, 'quality', (e.target as HTMLSelectElement).value);
  }

  async function pickFolder(): Promise<void> {
    folderHint = await changeRecorderboxFolder(nodeId);
  }

  async function onRecover(m: RecorderboxManifest): Promise<void> {
    await recoverTake(m);
    await rescan();
  }

  async function onDiscard(m: RecorderboxManifest): Promise<void> {
    await discardTake(m);
    await rescan();
  }

  // ── The preview blit. PREVIEW ONLY — capture is not here, it is on the
  //    registry's own pump (see the header).
  function draw(): void {
    rafId = null;
    const ve: VideoEngine | undefined = videoEngineOf(engineCtx.get());
    if (!ve) { rafId = requestAnimationFrame(draw); return; }

    if (previewCollapsed) {
      // SCREEN OFF renews the watch mark — see the header. Never nuke the loop.
      try { ve.markWatched(nodeId); } catch { /* */ }
      rafId = requestAnimationFrame(draw);
      return;
    }

    if (!previewEl) { rafId = requestAnimationFrame(draw); return; }
    // #1802 — gated preview blit (see VideoEngine.blitOutputForPreview, which
    // calls markWatched itself AFTER the gate: a refused frame is not an
    // observation).
    let blitted = false;
    try { blitted = ve.blitOutputForPreview(nodeId); } catch { /* */ }
    if (!blitted) { rafId = requestAnimationFrame(draw); return; }

    const ctx2d = previewEl.getContext('2d', { alpha: false });
    if (ctx2d) {
      const src = ve.canvas as CanvasImageSource;
      const ew = ve.canvas.width || VIDEO_RES.width;
      const eh = ve.canvas.height || VIDEO_RES.height;
      const cw = previewEl.width;
      const ch = previewEl.height;
      ctx2d.fillStyle = '#0a0406';
      ctx2d.fillRect(0, 0, cw, ch);
      const srcAspect = ew / eh;
      const dstAspect = cw / ch;
      let w = cw, h = ch, x = 0, y = 0;
      if (dstAspect > srcAspect) { h = ch; w = Math.round(h * srcAspect); x = Math.round((cw - w) / 2); }
      else { w = cw; h = Math.round(w / srcAspect); y = Math.round((ch - h) / 2); }
      drawPreviewDownscaled(ctx2d, src, x, y, w, h);
    }
    rafId = requestAnimationFrame(draw);
  }

  // ONE loop, running in BOTH screen states, so nothing has to restart it on
  // toggle — which removes "switched it back on and the picture never came
  // back" by construction.
  $effect(() => {
    if (rafId === null) rafId = requestAnimationFrame(draw);
    return () => {
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    };
  });

  onDestroy(() => {
    // PREVIEW ONLY. #1574: the card's onDestroy also called
    // `recorder.abandon()`, which made COLLAPSING the view destroy the take —
    // a view action reaching the user's file. There is deliberately no registry
    // method to call here, and that absence is the guard.
    if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
  });

  // ── Accessible names. Every measurement this module has — the elapsed time,
  //    the last saved chunk, the destination folder, the capability answer — is
  //    a `detail` / `aria-label` / `title` and NEVER a painted text node
  //    (2026-08-17/19 resting-text rulings).
  let recDetail = $derived(
    recState === 'recording'
      ? `recording for ${formatElapsed(elapsed)}${lastSavedChunk ? `, last chunk saved as ${lastSavedChunk}` : ''}`
      : 'not recording',
  );
  let savingDetail = $derived(
    recState === 'finalizing'
      ? 'finalizing the take — remuxing the fragmented MP4 and writing it to the destination'
      : 'nothing to finalize',
  );
  let folderTitle = $derived(
    folderName
      ? `Saving to: ${folderName}`
      : 'No folder chosen yet — you will be prompted on Record',
  );
</script>

<div class="recorderbox-body" data-testid="recorderbox-face-body">
  <!-- THE BLOCKING QUESTION, FIRST. Absent at rest. -->
  {#if recoverable.length > 0}
    <div class="recover" data-testid="recorderbox-face-recover">
      <p class="recover-title">Recover unsaved recording?</p>
      {#each recoverable as m (m.opfsPath)}
        <div class="recover-row">
          <span class="recover-name">{m.chunkName ?? `${m.filename}.mp4`}</span>
          <button
            type="button"
            class="recover-save nodrag"
            onclick={() => onRecover(m)}
            data-testid="recorderbox-face-recover-save"
          >Save</button>
          <button
            type="button"
            class="recover-discard nodrag"
            onclick={() => onDiscard(m)}
            data-testid="recorderbox-face-recover-discard"
          >Discard</button>
        </div>
      {/each}
    </div>
  {/if}

  <div class="preview-wrap" data-preview-collapsed={previewCollapsed ? 'true' : 'false'}>
    {#if !previewCollapsed}
      <canvas
        bind:this={previewEl}
        width={480}
        height={360}
        data-testid="recorderbox-face-canvas"
        data-node-id={nodeId}
      ></canvas>
    {/if}
    <button
      type="button"
      class="screen-btn nodrag"
      class:on={!previewCollapsed}
      onclick={togglePreview}
      data-testid="recorderbox-face-screen-toggle"
      aria-pressed={!previewCollapsed}
      title={previewCollapsed
        ? 'SCREEN is OFF — the monitor picture is collapsed and its space reclaimed. A take in progress is UNAFFECTED: capture runs on the recorder\'s own pump under a render lease that bypasses this gate entirely.'
        : 'SCREEN — turn the monitor picture off to collapse it and reclaim the vertical space. Recording, the `out` pass-through and the chain feeding `in` all continue either way.'}
    >{previewCollapsed ? 'SCREEN OFF' : 'SCREEN ON'}</button>
  </div>

  <div class="lamps">
    <StatusLed
      caption="REC"
      lit={recState === 'recording'}
      detail={recDetail}
      testid="recorderbox-face-rec-led"
    />
    <StatusLed
      caption="SAVING"
      lit={recState === 'finalizing'}
      detail={savingDetail}
      testid="recorderbox-face-saving-led"
    />
    {#if support.checked && !support.canRecord}
      <StatusLed
        caption="ENCODER"
        lit={true}
        tone="warn"
        detail="no H.264 encoder available — this runtime cannot encode, so RECORD is disabled"
        testid="recorderbox-face-no-encoder"
      />
    {:else if support.checked && !support.opfs}
      <StatusLed
        caption="RECOVERY"
        lit={true}
        tone="warn"
        detail="crash recovery unavailable — this browser exposes no OPFS scratch, so a take interrupted by a crash cannot be recovered"
        testid="recorderbox-face-no-opfs"
      />
    {/if}
  </div>

  <div class="controls">
    <!-- ⚠ THE TYPED FIELD IS AN `<input type="text">`, NOT A `ShellEntryCell`.
         That cell kind forbids clamping, and the shipped save path SANITIZES
         (`recorderbox-store.sanitizeRecordingFilename`) — so an entry cell's
         rejections would disagree with the name actually written to disk. -->
    <label class="row filename-row">
      <span class="lbl">FILE</span>
      <input
        class="filename nodrag"
        type="text"
        value={filename}
        oninput={onFilenameInput}
        placeholder="recording"
        spellcheck="false"
        data-testid="recorderbox-face-filename"
      />
      <span class="ext">.mp4</span>
    </label>

    <!-- ⚠ THE FOLDER HANDLE IS DELIBERATELY KEPT OUT OF `node.data` (it is a
         permission-bound, origin-bound live capability that must never sync to
         a rack-mate), so no `ShellActionProbe` can observe this button and it
         cannot be a face cell. -->
    <div class="row folder-row">
      <span class="lbl">DIR</span>
      <span class="folder-name" data-testid="recorderbox-face-folder" title={folderTitle}
        >{folderName ?? '(chosen on record)'}</span
      >
      <button
        type="button"
        class="folder-btn nodrag"
        onclick={pickFolder}
        disabled={busy}
        data-testid="recorderbox-face-change-folder"
        title="Pick a destination subfolder. Chrome blocks Documents/Desktop/Downloads roots."
      >{folderName ? 'CHANGE' : 'PICK'}</button>
    </div>
    {#if folderHint}
      <p class="hint" role="status" data-testid="recorderbox-face-folder-hint">{folderHint}</p>
    {/if}

    <!-- ⚠ `disabled` IS THE SOLE GUARD ON A MID-TAKE QUALITY CHANGE
         (`onQualityChange` has no `recState` guard of its own), which is why
         this is a real `<select>` and not a `ShellSelectorCell`: that cell
         kind cannot reach `Selector.svelte`'s `disabled`, so a promoted lane
         tile would let SMALL be read over a running HIGH take. -->
    <label class="row quality-row">
      <span class="lbl">SIZE</span>
      <select
        class="quality-select nodrag"
        value={quality}
        onchange={onQualityChange}
        disabled={busy}
        data-testid="recorderbox-face-quality"
        title="Smaller files trade a little quality. HIGH = original H.264; BALANCED/SMALL prefer hardware HEVC where supported."
      >
        {#each QUALITY_VALUES as q (q)}
          <option value={q}>{qualityLabel(q)}</option>
        {/each}
      </select>
    </label>

    <!-- ⚠ NOT A `ShellToggleCell`: `Toggle.svelte`'s Props has no `disabled` at
         all, so a promoted lane tile would paint a live-looking RECORD switch
         on a machine that cannot encode — and `faces-parity` CLICKS every
         toggle cell, which on a real recorderbox means a folder prompt, an
         encoder probe and a full-canvas capture pump that nothing ever
         stops. -->
    <button
      type="button"
      class="rec-btn nodrag"
      class:on={recording}
      disabled={support.checked && !support.canRecord}
      onclick={toggleRecord}
      data-testid="recorderbox-face-record"
      data-recording={recording}
      aria-pressed={recording}
      title={recording ? 'STOP — finalize the take and write it out' : 'RECORD — start a take'}
    >{recording ? '■ STOP' : '● RECORD'}</button>
  </div>
</div>

<style>
  .recorderbox-body {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 6px 8px 2px;
    box-sizing: border-box;
  }
  .preview-wrap {
    position: relative;
    display: flex;
    justify-content: center;
    /* Only load-bearing with SCREEN OFF: the canvas is gone, and without a
       floor the wrap would collapse to zero and take the absolutely-positioned
       button with it. Inert behind the canvas whenever the picture shows. */
    min-height: 18px;
  }
  .preview-wrap canvas {
    display: block;
    border-radius: 3px;
    background: #0a0406;
    border: 1px solid var(--cable-video);
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

  .lamps { display: flex; align-items: center; gap: 12px; padding-left: 2px; }

  .controls { display: flex; flex-direction: column; gap: 6px; }
  .row { display: flex; align-items: center; gap: 6px; }
  .lbl {
    font-size: 0.6rem;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
    min-width: 26px;
  }
  .filename {
    flex: 1;
    min-width: 0;
    background: var(--input-bg, #111);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 4px 6px;
    font-size: 0.72rem;
    font-family: ui-monospace, monospace;
  }
  .filename:focus { outline: none; border-color: var(--accent); }
  .ext { font-size: 0.62rem; color: var(--text-dim); font-family: ui-monospace, monospace; }
  .folder-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text);
    font-size: 0.7rem;
    font-family: ui-monospace, monospace;
  }
  .folder-btn {
    background: var(--input-bg, #111);
    color: var(--text-dim);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 3px 7px;
    font-size: 0.58rem;
    letter-spacing: 0.04em;
    font-family: ui-monospace, monospace;
    cursor: pointer;
  }
  .folder-btn:hover:not(:disabled) { border-color: var(--accent-dim); color: var(--text); }
  .folder-btn:disabled { opacity: 0.45; cursor: not-allowed; }
  .quality-select {
    flex: 1;
    min-width: 0;
    background: var(--input-bg, #111);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 4px 6px;
    font-size: 0.72rem;
    font-family: ui-monospace, monospace;
    cursor: pointer;
  }
  .quality-select:focus { outline: none; border-color: var(--accent); }
  .quality-select:disabled { opacity: 0.5; cursor: not-allowed; }
  .rec-btn {
    width: 100%;
    padding: 7px 0;
    background: var(--input-bg, #111);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 4px;
    font-size: 0.74rem;
    font-weight: 600;
    letter-spacing: 0.05em;
    cursor: pointer;
    transition: background 80ms ease-out, border-color 80ms ease-out;
  }
  .rec-btn:hover:not(:disabled) { border-color: var(--accent-dim); }
  .rec-btn.on { background: #c1121f; border-color: #ff3b30; color: #fff; }
  .rec-btn:disabled { opacity: 0.45; cursor: not-allowed; }

  /* The transient folder guidance — feedback on a GESTURE, the shape the
     platform's own ShellFileCell paints under its button. It does not exist
     until a pick failed or a presenting take fell back to downloads, so the
     resting plate carries no sentence. */
  .hint {
    margin: 0;
    font-size: 0.58rem;
    line-height: 1.35;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
  }

  /* NOT an overlay here. On the card this block had to float over the preview
     because `.card` is `overflow: hidden` with a rack-tier-pinned height and
     appended flow content was clipped away unreachable (the owner-reported
     bug `recorderbox-recover-reachable.spec.ts` pins). A dock pane has no such
     pin, so it is ordinary flow content at the TOP — where a blocking question
     belongs. */
  .recover {
    padding: 8px;
    border: 1px dashed var(--accent-dim);
    border-radius: 4px;
    background: var(--module-bg);
  }
  .recover-title { margin: 0 0 6px; font-size: 0.66rem; color: var(--accent); }
  .recover-row { display: flex; align-items: center; gap: 6px; margin-top: 4px; }
  .recover-name {
    flex: 1;
    min-width: 0;
    font-size: 0.64rem;
    font-family: ui-monospace, monospace;
    color: var(--text-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .recover-save,
  .recover-discard {
    font-size: 0.6rem;
    padding: 3px 7px;
    border-radius: 3px;
    cursor: pointer;
    border: 1px solid var(--border);
    background: var(--input-bg, #111);
    color: var(--text);
  }
  .recover-save:hover { border-color: var(--accent); }
  .recover-discard:hover { border-color: #ff3b30; }
</style>
