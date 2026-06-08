<script lang="ts">
  // RecorderboxCard — UI for RECORDERBOX, the video+audio recorder sink.
  //
  // What it does:
  //   * Live preview of the `in` video (same blit as VideoOutCard — asks the
  //     engine to render THIS node's FBO into its drawing buffer, then
  //     drawImage()s it into the visible <canvas>).
  //   * A HIDDEN capture <canvas> at the engine's native resolution that the
  //     recorder encodes (we draw the engine canvas into it each rAF while
  //     armed — keeps the preview small + crisp while recording full-res).
  //   * Filename text field bound to node.data.filename (synced via Y.Doc).
  //   * Record ON/OFF toggle (node.data.recording). ON starts streaming to
  //     OPFS scratch; OFF finalizes + Save-As's the MP4.
  //   * "no H.264 encoder available" badge when the runtime can't encode
  //     (headless CI / some OSes) — Record disabled, never crashes.
  //   * Recover prompt on mount when a previous take was left mid-flight.
  //
  // node.data mutation: ALWAYS in place (Yjs "already integrated" trap) —
  // we set patch.nodes[id].data.filename / .recording on the live store, never
  // reassign the data object.

  import { onMount, onDestroy } from 'svelte';
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { patch } from '$lib/graph/store';
  import type { VideoEngine } from '$lib/video/engine';
  import { VIDEO_RES } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import {
    RecorderboxRecorder,
    probeEncoders,
    type RecorderState,
  } from '$lib/video/recorderbox-recorder';
  import {
    listRecoverable,
    readOpfsBytes,
    deleteOpfsFile,
    deleteManifest,
    markManifestDone,
    sanitizeRecordingFilename,
    canSaveViaPicker,
    type RecorderboxManifest,
  } from '$lib/video/recorderbox-store';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  const ENGINE_W = VIDEO_RES.width;
  const ENGINE_H = VIDEO_RES.height;

  let filename = $derived<string>((node?.data?.filename as string | undefined) ?? 'recording');
  let recording = $derived<boolean>((node?.data?.recording as boolean | undefined) ?? false);

  let previewEl: HTMLCanvasElement | null = $state(null);
  // Hidden full-res capture canvas the recorder encodes from.
  let captureEl: HTMLCanvasElement | null = $state(null);
  let rafId: number | null = null;

  // Encoder support → drives the disabled badge.
  let support = $state<{ canRecord: boolean; opfs: boolean; checked: boolean }>({
    canRecord: false,
    opfs: false,
    checked: false,
  });

  let recState = $state<RecorderState>('idle');
  let elapsed = $state(0);
  let recorder: RecorderboxRecorder | null = null;

  // Recovery prompt state.
  let recoverable = $state<RecorderboxManifest[]>([]);

  function setData(key: 'filename' | 'recording', value: string | boolean) {
    const target = patch.nodes[id];
    if (target) {
      if (!target.data) target.data = {};
      target.data[key] = value;
    }
  }

  function onFilenameInput(e: Event) {
    const v = (e.target as HTMLInputElement).value;
    setData('filename', v);
  }

  function toggleRecord() {
    if (!support.canRecord) return;
    setData('recording', !recording);
  }

  // ── Save flow: showSaveFilePicker (Chromium) → <a download> fallback ──
  async function saveBytes(bytes: Uint8Array, name: string, mime: string): Promise<void> {
    const safeName = sanitizeRecordingFilename(name, 'mp4');
    if (canSaveViaPicker()) {
      const picker = (globalThis as unknown as {
        showSaveFilePicker: (o: {
          suggestedName?: string;
          types?: { description: string; accept: Record<string, string[]> }[];
        }) => Promise<{ createWritable: () => Promise<{
          write: (d: BufferSource) => Promise<void>; close: () => Promise<void>;
        }> }>;
      }).showSaveFilePicker;
      const handle = await picker({
        suggestedName: safeName,
        types: [{ description: 'MPEG-4 video', accept: { 'video/mp4': ['.mp4'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(bytes as unknown as BufferSource);
      await writable.close();
      return;
    }
    // Fallback: <a download> blob (Firefox/Safari), mirroring VIDEOBOX export.
    const blob = new Blob([bytes as BlobPart], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = safeName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  function getVideoEngine(): VideoEngine | undefined {
    const e = engineCtx.get();
    if (!e) return undefined;
    try { return e.getDomain<VideoEngine>('video'); } catch { return undefined; }
  }

  // ── rAF: preview blit + (while armed) full-res capture frame ──
  function draw() {
    rafId = null;
    const e = engineCtx.get();
    const ve = getVideoEngine();
    if (!e || !ve || !previewEl) { rafId = requestAnimationFrame(draw); return; }
    try { ve.blitOutputToDrawingBuffer(id); } catch { /* never nuke the rAF loop */ }
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
      pctx.drawImage(src, x, y, w, h);
    }

    // Capture (full engine res, no letterbox) — only while recording.
    if (recorder && recState === 'recording' && captureEl) {
      if (captureEl.width !== ew) captureEl.width = ew;
      if (captureEl.height !== eh) captureEl.height = eh;
      const cctx = captureEl.getContext('2d', { alpha: false });
      if (cctx) {
        cctx.drawImage(src, 0, 0, ew, eh);
        recorder.frame();
      }
      elapsed = recorder.elapsed();
    }
    rafId = requestAnimationFrame(draw);
  }

  // ── Start / stop the recorder when node.data.recording flips ──
  $effect(() => {
    const want = recording;
    if (want && !recorder && support.canRecord) {
      void startRecording();
    } else if (!want && recorder && recState === 'recording') {
      void stopRecording();
    }
  });

  async function startRecording() {
    const ve = getVideoEngine();
    if (!ve || !captureEl) { setData('recording', false); return; }
    const ew = ve.canvas.width || ENGINE_W;
    const eh = ve.canvas.height || ENGINE_H;
    captureEl.width = ew;
    captureEl.height = eh;

    // Pull the live capture MediaStream the module published (null = audio off
    // → record video only / silent).
    const e = engineCtx.get();
    let audioTrack: MediaStreamTrack | null = null;
    if (e && node) {
      const stream = e.read(node, 'audioStream') as MediaStream | null | undefined;
      audioTrack = stream?.getAudioTracks?.()[0] ?? null;
    }

    recorder = new RecorderboxRecorder({
      nodeId: id,
      canvas: captureEl,
      audioTrack,
      filename,
      width: ew,
      height: eh,
      saveBytes,
      onStateChange: (s) => { recState = s; },
    });
    try {
      await recorder.start();
    } catch {
      recorder = null;
      recState = 'error';
      setData('recording', false);
    }
  }

  async function stopRecording() {
    const r = recorder;
    recorder = null;
    if (r) {
      try { await r.stop(); } catch { /* */ }
    }
    recState = 'idle';
    elapsed = 0;
  }

  // ── Recovery prompt: scan for this node's mid-flight recordings on mount ──
  async function scanRecoverable() {
    try {
      recoverable = await listRecoverable(id);
    } catch {
      recoverable = [];
    }
  }

  async function recoverOne(m: RecorderboxManifest) {
    try {
      const bytes = await readOpfsBytes(m.opfsPath);
      if (bytes && bytes.byteLength > 0) {
        await saveBytes(bytes, m.filename, m.mime);
      }
      await markManifestDone(m.opfsPath);
      await deleteOpfsFile(m.opfsPath);
      await deleteManifest(m.opfsPath);
    } catch {
      // Keep the candidate if the save was cancelled / failed.
    }
    await scanRecoverable();
  }

  async function discardOne(m: RecorderboxManifest) {
    try {
      await deleteOpfsFile(m.opfsPath);
      await deleteManifest(m.opfsPath);
    } catch { /* */ }
    await scanRecoverable();
  }

  onMount(() => {
    rafId = requestAnimationFrame(draw);
    // Probe encoder support at the engine resolution.
    void probeEncoders(ENGINE_W, ENGINE_H).then((s) => {
      support = { canRecord: s.canRecord, opfs: s.opfs, checked: true };
    }).catch(() => {
      support = { canRecord: false, opfs: false, checked: true };
    });
    void scanRecoverable();
  });

  onDestroy(() => {
    if (rafId !== null) cancelAnimationFrame(rafId);
    // Card destroyed mid-record: abandon (finalize best-effort, LEAVE the
    // recover candidate so a reload can recover it).
    if (recorder && recState === 'recording') {
      void recorder.abandon();
    }
    recorder = null;
  });

  function fmtElapsed(s: number): string {
    const total = Math.floor(s);
    const mm = String(Math.floor(total / 60)).padStart(2, '0');
    const ss = String(total % 60).padStart(2, '0');
    return `${mm}:${ss}`;
  }

  // Handle layout.
  const INPUTS = [
    { id: 'in', y: 56, label: 'IN', color: 'var(--cable-video)' },
    { id: 'audio_l', y: 92, label: 'A·L', color: 'var(--cable-audio)' },
    { id: 'audio_r', y: 124, label: 'A·R', color: 'var(--cable-audio)' },
  ];
</script>

<div class="card video" data-testid="recorderbox-card" data-node-id={id}>
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="RECORDERBOX" />

  {#each INPUTS as h}
    <Handle type="target" position={Position.Left} id={h.id} style={`top: ${h.y}px; --handle-color: ${h.color};`} />
    <span class="port-label left" style={`top: ${h.y - 6}px;`}>{h.label}</span>
  {/each}
  <Handle type="source" position={Position.Right} id="out" style="top: 56px; --handle-color: var(--cable-video);" />
  <span class="port-label right" style="top: 50px;">OUT</span>

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

  <!-- Hidden full-res capture surface the recorder encodes. -->
  <canvas bind:this={captureEl} class="capture" width={ENGINE_W} height={ENGINE_H} aria-hidden="true"></canvas>

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
  </div>

  {#if recoverable.length > 0}
    <div class="recover" data-testid="recorderbox-recover">
      <p class="recover-title">Recover unsaved recording?</p>
      {#each recoverable as m (m.opfsPath)}
        <div class="recover-row">
          <span class="recover-name">{m.filename}.mp4</span>
          <button class="recover-save nodrag" onclick={() => recoverOne(m)} data-testid="recorderbox-recover-save">Save</button>
          <button class="recover-discard nodrag" onclick={() => discardOne(m)} data-testid="recorderbox-recover-discard">Discard</button>
        </div>
      {/each}
    </div>
  {/if}
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
  .port-label {
    position: absolute; font-size: 0.6rem; color: var(--text-dim);
    pointer-events: none; font-family: ui-monospace, monospace;
  }
  .port-label.left { left: 14px; }
  .port-label.right { right: 14px; }
  .preview-wrap { position: relative; margin: 30px auto 8px; width: 200px; height: 150px; }
  .preview-wrap canvas {
    background: #0a0406; border: 1px solid var(--cable-video);
    border-radius: 1px; image-rendering: pixelated;
    width: 200px; height: 150px; display: block;
  }
  .capture { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; left: -9999px; }
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
  .recover {
    margin-top: 10px; padding: 8px; border: 1px dashed var(--accent-dim);
    border-radius: 4px; background: rgba(255,255,255,0.03);
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
