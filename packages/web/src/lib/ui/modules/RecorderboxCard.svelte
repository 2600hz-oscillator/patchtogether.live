<script lang="ts">
  // RecorderboxCard — UI for RECORDERBOX, the video+audio recorder sink.
  //
  // ⚠ THIS CARD IS THE `?shell=legacy` SURFACE ONLY. recorderbox is PROMOTED,
  // so the default shell renders `$lib/ui/modules/recorderbox/` (a lane tile
  // body + a dock full-view body) and never mounts this component — recorderbox
  // is in neither half of HEADLESS_MOUNT_LANE_TYPES, so there is no headless
  // host either. Every transport decision below is therefore SHARED rather than
  // owned: it lives in `./recorderbox-transport`, which this card and both
  // faceplate bodies call, so the three surfaces cannot drift.
  //
  // What it does:
  //   * Live preview of the `in` video (same blit as VideoOutCard — asks the
  //     engine to render THIS node's FBO into its drawing buffer, then
  //     drawImage()s it into the visible <canvas>).
  //   * ⚠ THERE IS NO CAPTURE CANVAS HERE, and the sentence that used to sit on
  //     this line ("a HIDDEN capture <canvas> at the engine's native resolution
  //     that the recorder encodes… each rAF while armed") has been FALSE since
  //     #1574/#1584. The capture canvas is created by
  //     `node-recorder-registry`, never enters the document, and is pumped by
  //     the registry — which is the whole point: a detached canvas keeps its
  //     last bitmap, so a card-owned one recorded a freeze frame for every
  //     collapsed span. It contradicted :92-96 of this same file for two
  //     months, and it is the sentence the migration inventory copied.
  //   * Filename text field bound to node.data.filename (synced via Y.Doc).
  //   * Record ON/OFF toggle (node.data.recording). ON picks a destination
  //     FOLDER once (showDirectoryPicker), then auto-writes the recording into it
  //     using the Filename box directly — NO per-save "Save As" prompt. The only
  //     prompt is an OVERWRITE confirm if a file with the target name already
  //     exists. The folder is remembered, so the next record needs no prompt.
  //   * GoPro CHUNKING: a long take rolls to a NEW file every ~10 min, with a 5 s
  //     AUDIO overlap between consecutive chunks. Chunks are named
  //     FILENAME-CHUNK#-DATETIME.mp4 (RECORDING-001-…, RECORDING-002-…), unique +
  //     Finder-sortable. (Firefox/Safari with no directory picker: each chunk
  //     downloads via <a download> with its chunk name.)
  //   * "no H.264 encoder available" badge when the runtime can't encode
  //     (headless CI / some OSes) — Record disabled, never crashes.
  //   * Recover prompt on mount when a previous take was left mid-flight.
  //
  // node.data mutation: ALWAYS in place (Yjs "already integrated" trap) —
  // we set patch.nodes[id].data.filename / .recording on the live store, never
  // reassign the data object.

  import { onMount, onDestroy } from 'svelte';
  import { type NodeProps } from '@xyflow/svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { useEngine } from '$lib/audio/engine-context';
  import type { VideoEngine } from '$lib/video/engine';
  import { VIDEO_RES } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import type { RecorderState } from '$lib/video/recorderbox-recorder';
  import { QUALITY_VALUES, qualityLabel } from '$lib/video/recorderbox-quality';
  import { nodeRecorder } from './node-recorder-registry.svelte';
  import { drawPreviewDownscaled } from './preview-downscale';
  // THE SHARED TRANSPORT SEAM. Everything the card used to own inline — the
  // support probe, the crash scan, the ~120-line start orchestration, the
  // folder re-pick, the download fallback and the `data.recording` REACTOR —
  // now lives in one plain module the faceplate bodies call too.
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
    type RecorderboxManifest,
    type RecorderboxSupport,
  } from './recorderbox-transport';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  const ENGINE_W = VIDEO_RES.width;
  const ENGINE_H = VIDEO_RES.height;

  // ⚠ READ OFF THE `node` PROP, NOT OFF `patch`. `patch` reads are not reactive
  // in the legacy card subtree ([[patch-reads-are-not-reactive-in-the-legacy-card-subtree]]),
  // which is exactly why the shared transport takes GETTERS: this surface hands
  // it these leaves, the faceplate bodies hand it their own `patch` reads, and
  // each subtree tracks the source it is actually reactive to.
  let filename = $derived(recorderboxFilename(node));
  let recording = $derived(recorderboxRecording(node));
  // QUALITY/SIZE tier. Default BALANCED (owner default 2026-06-15) — ~−80% size
  // for a small quality hit; HIGH (original ~14 Mbps H.264) is one click away.
  // Synced to rack-mates via Y.Doc.
  let quality = $derived(recorderboxQuality(node));

  let previewEl: HTMLCanvasElement | null = $state(null);
  // NOTE: there is no capture canvas here any more. The registry creates one
  // and never appends it to the document, so a card unmount cannot detach it
  // (a detached canvas keeps its last bitmap — that is how a "fixed" recording
  // would still have captured a freeze frame for the collapsed span).
  let rafId: number | null = null;

  // Encoder support → drives the disabled badge.
  let support = $state<RecorderboxSupport>(UNCHECKED_SUPPORT);

  // ── #1574: the recording belongs to the NODE, not to this card ──
  // These are READS of $lib/ui/modules/node-recorder-registry, which owns the
  // recorder, its capture canvas, its frame pump and its render lease for the
  // recording's whole lifetime. Collapsing the dock full-view unmounts this
  // card; before the registry that unmount called `recorder.abandon()` and
  // destroyed the user's take. The card no longer holds anything it could kill.
  let live = $derived(nodeRecorder.view(id));
  let recState = $derived<RecorderState>(live?.state ?? 'idle');
  let elapsed = $derived(live?.elapsed ?? 0);

  // ── No-prompt save (Tweak 1) + GoPro chunking (Tweak 3) ──
  // The destination FOLDER picked ONCE via showDirectoryPicker, so subsequent
  // records + every rolling chunk write into it with NO further prompt. Null
  // until a folder is picked / on a no-picker browser (then the per-chunk
  // <a download> fallback applies).
  //
  // #1583: this is a READ of the node-keyed registry, not card state. It used
  // to be `$state(null)` here, which meant any card unmount — collapse, ESC,
  // an LRU eviction caused by expanding a THIRD module — forgot the folder and
  // broke this card's own promise at the top of this file. Worse than a
  // re-prompt: while PRESENTING, `planRecordStartFolder` deliberately answers
  // 'download' rather than 'prompt', so a forgotten folder silently redirects
  // the take to the browser's downloads mid-performance.
  let saveFolder = $derived(nodeRecorder.folderFor(id));
  // The last chunk file the recorder reported saving (status line / a11y).
  let lastSavedChunk = $derived<string | null>(live?.lastSavedChunk ?? null);
  // Display name of the remembered destination folder (null = none chosen yet).
  let folderName = $derived(folderDisplayName(saveFolder));
  // Transient guidance under the folder row (e.g. the Chrome root-block hint).
  let folderHint = $state<string | null>(null);

  // Recovery prompt state.
  let recoverable = $state<RecorderboxManifest[]>([]);

  function onFilenameInput(e: Event) {
    setRecorderboxData(id, 'filename', (e.target as HTMLInputElement).value);
  }

  function onQualityChange(e: Event) {
    setRecorderboxData(id, 'quality', (e.target as HTMLSelectElement).value);
  }

  function toggleRecord() {
    if (!support.canRecord) return;
    setRecorderboxData(id, 'recording', !recording);
  }

  // Re-pick the destination folder at ANY time (a user gesture — the button
  // click — so showDirectoryPicker is allowed). Without this the first-picked
  // folder is sticky and the only way to change it was deleting the module.
  // The seam owns the hint strings, so the card and the faceplate cannot give
  // two different accounts of the SAME refusal (Chrome swallows both a dismiss
  // and its "contains system files" root-block into 'cancel').
  async function changeFolder() {
    folderHint = await changeRecorderboxFolder(id);
  }

  // ── Start / stop the recorder when node.data.recording flips ──
  //
  // ⚠ ONE LINE, AND THE BODY LIVES IN THE SEAM. `data.recording` is Y.Doc-
  // synced, so this reactor is also what handles a RACK-MATE's press and a
  // patch LOADED with `recording: true` — neither of which passes through
  // `toggleRecord`. Keeping the reads inside `reconcileRecorderboxTransport`
  // is what stops this card and the two faceplate bodies tracking different
  // things.
  $effect(() => {
    reconcileRecorderboxTransport({
      nodeId: id,
      recording: () => recording,
      canRecord: () => support.canRecord,
      engine: () => engineCtx.get(),
      stillArmed: () => recorderboxRecording(recorderboxNode(id)),
      setFolderHint: (h) => { folderHint = h; },
    });
  });

  // ── Recovery prompt: scan for this node's mid-flight recordings on mount ──
  async function scanRecoverable() {
    recoverable = await scanRecoverableTakes(id);
  }

  async function recoverOne(m: RecorderboxManifest) {
    await recoverTake(m);
    await scanRecoverable();
  }

  async function discardOne(m: RecorderboxManifest) {
    await discardTake(m);
    await scanRecoverable();
  }

  // ── rAF: preview blit ──
  function draw() {
    rafId = null;
    const e = engineCtx.get();
    const ve = getVideoEngine();
    if (!e || !ve || !previewEl) { rafId = requestAnimationFrame(draw); return; }
    // #1802 — gated preview blit (see VideoEngine.blitOutputForPreview).
    // SAFE FOR RECORDING: capture does not run here. The node-recorder
    // registry holds an `acquireRenderLease` for the whole take and pumps the
    // UNGATED `blitOutputToDrawingBuffer` itself, and a lease bypasses both
    // gates — so a recording node keeps rendering at full rate even with this
    // card off-screen, unmounted, or throttled.
    let blitted = false;
    try { blitted = ve.blitOutputForPreview(id); } catch { /* never nuke the rAF loop */ }
    if (!blitted) { rafId = requestAnimationFrame(draw); return; }
    const src = ve.canvas as CanvasImageSource;
    const ew = ve.canvas.width || ENGINE_W;
    const eh = ve.canvas.height || ENGINE_H;

    // Preview (small, aspect-fit).
    const pctx = previewEl.getContext('2d', { alpha: false });
    if (pctx) {
      const cw = previewEl.width, ch = previewEl.height;
      pctx.fillStyle = '#0a0406';
      pctx.fillRect(0, 0, cw, ch);
      const srcAspect = ew / eh;
      const dstAspect = cw / ch;
      let w = cw, h = ch, x = 0, y = 0;
      if (dstAspect > srcAspect) { h = ch; w = Math.round(h * srcAspect); x = Math.round((cw - w) / 2); }
      else { w = cw; h = Math.round(w / srcAspect); y = Math.round((ch - h) / 2); }
      drawPreviewDownscaled(pctx, src, x, y, w, h);
    }

    // CAPTURE IS NOT HERE. It runs on the registry's own pump, which keeps
    // feeding the encoder while this card is unmounted. This loop is
    // preview-only and is correct to die with the card.
    rafId = requestAnimationFrame(draw);
  }

  function getVideoEngine(): VideoEngine | undefined {
    const e = engineCtx.get();
    if (!e) return undefined;
    try { return e.getDomain<VideoEngine>('video'); } catch { return undefined; }
  }

  onMount(() => {
    rafId = requestAnimationFrame(draw);
    // Probe encoder support at the engine resolution.
    void probeRecorderboxSupport(ENGINE_W, ENGINE_H).then((s) => { support = s; });
    void scanRecoverable();
  });

  onDestroy(() => {
    // PREVIEW ONLY. #1574: this used to also `recorder.abandon()`, which made
    // COLLAPSING the card destroy an in-progress recording — the card cannot
    // distinguish "collapsed" from "node deleted", so it must decide neither.
    // The recording is owned by node-recorder-registry and ends only on user
    // intent (Record OFF) or on the node leaving the graph (Canvas's sweep).
    // There is deliberately no registry method to call here.
    if (rafId !== null) cancelAnimationFrame(rafId);
  });

  const fmtElapsed = formatElapsed;

  // Port layout.
  const inputs: PortDescriptor[] = [
    { id: 'in',      label: 'IN',  cable: 'video' },
    { id: 'audio_l', label: 'A·L', cable: 'audio' },
    { id: 'audio_r', label: 'A·R', cable: 'audio' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'out', cable: 'video' },
  ];
</script>

<div class="card video" data-testid="recorderbox-card" data-node-id={id}>
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="RECORDERBOX" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
  <div class="preview-wrap">
    <canvas
      bind:this={previewEl}
      width={200}
      height={150}
      data-testid="recorderbox-preview"
      data-node-id={id}
    ></canvas>
    {#if recState === 'recording'}
      <span class="rec-indicator" data-testid="recorderbox-rec-indicator">
        <span class="dot"></span> REC {fmtElapsed(elapsed)}
      </span>
    {:else if recState === 'finalizing'}
      <span class="rec-indicator finalizing">SAVING…</span>
    {/if}
  </div>


  <div class="controls">
    <label class="filename-row">
      <span class="lbl">FILE</span>
      <input
        class="filename nodrag"
        type="text"
        value={filename}
        oninput={onFilenameInput}
        placeholder="recording"
        spellcheck="false"
        data-testid="recorderbox-filename"
      />
      <span class="ext">.mp4</span>
    </label>

    <div class="folder-row">
      <span class="lbl">DIR</span>
      <span
        class="folder-name"
        data-testid="recorderbox-folder"
        title={folderName ? `Saving to: ${folderName}` : 'No folder chosen yet — you will be prompted on Record'}
      >{folderName ?? '(chosen on record)'}</span>
      <button
        class="folder-btn nodrag"
        onclick={changeFolder}
        disabled={recState === 'recording' || recState === 'finalizing'}
        data-testid="recorderbox-change-folder"
        title="Pick a destination subfolder. Chrome blocks Documents/Desktop/Downloads roots."
      >{folderName ? 'CHANGE' : 'PICK'}</button>
    </div>
    {#if folderHint}
      <span class="badge subtle" data-testid="recorderbox-folder-hint">{folderHint}</span>
    {/if}

    <label class="quality-row">
      <span class="lbl">SIZE</span>
      <select
        class="quality-select nodrag"
        value={quality}
        onchange={onQualityChange}
        disabled={recState === 'recording' || recState === 'finalizing'}
        data-testid="recorderbox-quality"
        title="Smaller files trade a little quality. HIGH = original H.264; BALANCED/SMALL prefer AV1/VP9 where supported."
      >
        {#each QUALITY_VALUES as q (q)}
          <option value={q}>{qualityLabel(q)}</option>
        {/each}
      </select>
    </label>

    <button
      class="rec-btn nodrag"
      class:on={recording}
      disabled={support.checked && !support.canRecord}
      onclick={toggleRecord}
      data-testid="recorderbox-record"
      data-recording={recording}
    >
      {#if recording}■ STOP{:else}● RECORD{/if}
    </button>

    {#if support.checked && !support.canRecord}
      <span class="badge" data-testid="recorderbox-no-encoder">no H.264 encoder available</span>
    {:else if support.checked && !support.opfs}
      <span class="badge subtle" data-testid="recorderbox-no-opfs">crash-recovery unavailable (no OPFS)</span>
    {/if}

    <!-- Chunk status: only shown WHILE recording once a chunk has rolled+saved,
         so the idle card (the VRT baseline state) is unchanged. -->
    {#if recState === 'recording' && lastSavedChunk}
      <span class="badge subtle" data-testid="recorderbox-chunk-status">saved {lastSavedChunk}</span>
    {/if}
  </div>

  {#if recoverable.length > 0}
    <div class="recover" data-testid="recorderbox-recover">
      <p class="recover-title">Recover unsaved recording?</p>
      {#each recoverable as m (m.opfsPath)}
        <div class="recover-row">
          <span class="recover-name">{m.chunkName ?? `${m.filename}.mp4`}</span>
          <button class="recover-save nodrag" onclick={() => recoverOne(m)} data-testid="recorderbox-recover-save">Save</button>
          <button class="recover-discard nodrag" onclick={() => discardOne(m)} data-testid="recorderbox-recover-discard">Discard</button>
        </div>
      {/each}
    </div>
  {/if}
  </PatchPanel>
</div>

<style>
  .card {
    background-color: #000;
    background-image: linear-gradient(var(--module-bg), var(--module-bg));
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text);
    padding: 18px 14px 14px;
    position: relative;
    width: 248px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    overflow: hidden;
    isolation: isolate;
  }
  :global(.svelte-flow__node:hover) .card { border-color: var(--accent-dim); }
  :global(.svelte-flow__node.selected) .card {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .stripe {
    position: absolute; top: 0; left: 0; right: 0; height: 2px;
    border-radius: 2px 2px 0 0; background: var(--cable-video);
  }
  .preview-wrap { position: relative; margin: 18px auto 8px; width: 200px; height: 150px; }
  .preview-wrap canvas {
    background: #0a0406; border: 1px solid var(--cable-video);
    border-radius: 1px; image-rendering: pixelated;
    width: 200px; height: 150px; display: block;
  }
  .rec-indicator {
    position: absolute; top: 6px; left: 6px;
    display: inline-flex; align-items: center; gap: 5px;
    font-size: 0.62rem; font-family: ui-monospace, monospace;
    color: #fff; background: rgba(0,0,0,0.55);
    padding: 2px 6px; border-radius: 3px; letter-spacing: 0.04em;
  }
  .rec-indicator .dot {
    width: 8px; height: 8px; border-radius: 50%; background: #ff3b30;
    animation: rec-pulse 1s ease-in-out infinite;
  }
  .rec-indicator.finalizing { color: var(--accent); }
  @keyframes rec-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.25; } }
  .controls { display: flex; flex-direction: column; gap: 8px; }
  .filename-row { display: flex; align-items: center; gap: 6px; }
  .filename-row .lbl {
    font-size: 0.6rem; color: var(--text-dim); font-family: ui-monospace, monospace;
  }
  .filename {
    flex: 1; min-width: 0;
    background: var(--input-bg, #111); color: var(--text);
    border: 1px solid var(--border); border-radius: 3px;
    padding: 4px 6px; font-size: 0.72rem; font-family: ui-monospace, monospace;
  }
  .filename:focus { outline: none; border-color: var(--accent); }
  .ext { font-size: 0.62rem; color: var(--text-dim); font-family: ui-monospace, monospace; }
  .folder-row { display: flex; align-items: center; gap: 6px; }
  .folder-row .lbl {
    font-size: 0.6rem; color: var(--text-dim); font-family: ui-monospace, monospace;
  }
  .folder-name {
    flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: var(--text); font-size: 0.7rem; font-family: ui-monospace, monospace;
  }
  .folder-btn {
    background: var(--input-bg, #111); color: var(--text-dim);
    border: 1px solid var(--border); border-radius: 3px;
    padding: 3px 7px; font-size: 0.58rem; letter-spacing: 0.04em;
    font-family: ui-monospace, monospace; cursor: pointer;
  }
  .folder-btn:hover:not(:disabled) { border-color: var(--accent-dim); color: var(--text); }
  .folder-btn:disabled { opacity: 0.45; cursor: not-allowed; }
  .quality-row { display: flex; align-items: center; gap: 6px; }
  .quality-row .lbl {
    font-size: 0.6rem; color: var(--text-dim); font-family: ui-monospace, monospace;
  }
  .quality-select {
    flex: 1; min-width: 0;
    background: var(--input-bg, #111); color: var(--text);
    border: 1px solid var(--border); border-radius: 3px;
    padding: 4px 6px; font-size: 0.72rem; font-family: ui-monospace, monospace;
    cursor: pointer;
  }
  .quality-select:focus { outline: none; border-color: var(--accent); }
  .quality-select:disabled { opacity: 0.5; cursor: not-allowed; }
  .rec-btn {
    width: 100%; padding: 7px 0;
    background: var(--input-bg, #111); color: var(--text);
    border: 1px solid var(--border); border-radius: 4px;
    font-size: 0.74rem; font-weight: 600; letter-spacing: 0.05em;
    cursor: pointer; transition: background 80ms ease-out, border-color 80ms ease-out;
  }
  .rec-btn:hover:not(:disabled) { border-color: var(--accent-dim); }
  .rec-btn.on {
    background: #c1121f; border-color: #ff3b30; color: #fff;
  }
  .rec-btn:disabled { opacity: 0.45; cursor: not-allowed; }
  .badge {
    font-size: 0.58rem; color: #ff8f87; text-align: center;
    font-family: ui-monospace, monospace; letter-spacing: 0.02em;
  }
  .badge.subtle { color: var(--text-dim); }
  /* The recovery prompt is an OVERLAY, not flow content.
   *
   * The card's height is HARD-PINNED by the rack tier — `_module-card.css`
   * sets `height/min-height/max-height: calc(var(--rack-u) * var(--rack-unit))`
   * on `.card` (recorderbox is 2u), and `.card` is `overflow: hidden`. Appended
   * at the end of the flow the prompt landed BELOW that pinned box, so its Save
   * and Discard buttons were clipped away and the recovery was unreachable —
   * the user could see "Recover unsaved recording?" and could not act on it.
   * Growing the card is not an option: the tier pin is what keeps lane geometry
   * from thrashing on zoom.
   *
   * So it floats over the preview well, which is idle whenever a recovery is
   * pending (you are not recording). Opaque, not translucent — this is a
   * blocking question, and the controls behind it must not read as live. */
  .recover {
    position: absolute;
    left: 12px; right: 12px; top: 42px;
    z-index: 6;
    padding: 8px; border: 1px dashed var(--accent-dim);
    border-radius: 4px;
    background: var(--module-bg);
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.55);
  }
  .recover-title { margin: 0 0 6px; font-size: 0.66rem; color: var(--accent); }
  .recover-row { display: flex; align-items: center; gap: 6px; margin-top: 4px; }
  .recover-name {
    flex: 1; min-width: 0; font-size: 0.64rem; font-family: ui-monospace, monospace;
    color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .recover-save, .recover-discard {
    font-size: 0.6rem; padding: 3px 7px; border-radius: 3px; cursor: pointer;
    border: 1px solid var(--border); background: var(--input-bg, #111); color: var(--text);
  }
  .recover-save:hover { border-color: var(--accent); }
  .recover-discard:hover { border-color: #ff3b30; }
</style>
