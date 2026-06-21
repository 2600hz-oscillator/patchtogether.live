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
    pickEncodeProfile,
    coerceQuality,
    QUALITY_VALUES,
    qualityLabel,
    type RecorderboxQuality,
  } from '$lib/video/recorderbox-quality';
  import {
    listRecoverable,
    readOpfsBytes,
    deleteOpfsFile,
    deleteManifest,
    markManifestDone,
    ensureHandleWritePermission,
    sanitizeRecordingFilename,
    canSaveViaPicker,
    type RecorderboxManifest,
  } from '$lib/video/recorderbox-store';
  import {
    promptSaveDestination,
    streamToHandle,
    promptSaveFolder,
    fileExistsInDir,
    fileHandleInDir,
  } from '$lib/video/recorderbox-save-flow';
  import { chunkFileName } from '$lib/video/recorderbox-chunk-name';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  const ENGINE_W = VIDEO_RES.width;
  const ENGINE_H = VIDEO_RES.height;

  let filename = $derived<string>((node?.data?.filename as string | undefined) ?? 'recording');
  let recording = $derived<boolean>((node?.data?.recording as boolean | undefined) ?? false);
  // QUALITY/SIZE tier. Default BALANCED (owner default 2026-06-15) — ~−80% size
  // for a small quality hit; HIGH (original ~14 Mbps H.264) is one click away.
  // Synced to rack-mates via Y.Doc.
  let quality = $derived<RecorderboxQuality>(coerceQuality(node?.data?.quality));

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

  // ── No-prompt save (Tweak 1) + GoPro chunking (Tweak 3) ──
  // The destination FOLDER picked ONCE via showDirectoryPicker. Remembered in
  // component state so subsequent records + every rolling chunk write into it
  // with NO further prompt. Null until a folder is picked / on a no-picker
  // browser (then the per-chunk <a download> fallback applies).
  let saveFolder: FileSystemDirectoryHandle | null = $state(null);
  // The last chunk file the recorder reported saving (status line / a11y).
  let lastSavedChunk = $state<string | null>(null);
  // Display name of the remembered destination folder (null = none chosen yet).
  // (Read `.name` via a structural cast — the project's FileSystemDirectoryHandle
  // typing doesn't surface it, but every real handle has a `.name`.)
  let folderName = $derived<string | null>(
    saveFolder ? ((saveFolder as { name?: string }).name ?? null) : null,
  );
  // Transient guidance under the folder row (e.g. the Chrome root-block hint).
  let folderHint = $state<string | null>(null);

  // Recovery prompt state.
  let recoverable = $state<RecorderboxManifest[]>([]);

  function setData(key: 'filename' | 'recording' | 'quality', value: string | boolean) {
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

  function onQualityChange(e: Event) {
    const v = (e.target as HTMLSelectElement).value;
    setData('quality', coerceQuality(v));
  }

  function toggleRecord() {
    if (!support.canRecord) return;
    setData('recording', !recording);
  }

  // Re-pick the destination folder at ANY time (a user gesture — the button
  // click — so showDirectoryPicker is allowed). Without this the first-picked
  // folder is sticky and the only way to change it was deleting the module.
  // showDirectoryPicker swallows BOTH a dismiss AND Chrome's "contains system
  // files" root-block into 'cancel', so on an empty pick we surface the
  // actionable subfolder hint (Chrome refuses readwrite on Documents/Desktop/
  // Downloads/home roots — you must choose a SUBfolder).
  async function changeFolder() {
    if (recState === 'recording' || recState === 'finalizing') return;
    const picked = await promptSaveFolder();
    if (picked === 'cancel') {
      folderHint = 'Pick a SUBFOLDER — Chrome blocks Documents/Desktop/Downloads roots ("contains system files").';
      return;
    }
    if (picked == null) {
      folderHint = 'This browser has no folder picker — recordings download instead.';
      return;
    }
    if (!(await ensureHandleWritePermission(picked))) {
      folderHint = 'Write permission was denied for that folder.';
      return;
    }
    saveFolder = picked;
    folderHint = null;
  }

  // Prompt the user for the OUTPUT location at the START of recording (the
  // Record toggle is a valid user gesture). The returned FileSystemFileHandle
  // is structured-cloneable, so the recorder persists it to the IndexedDB
  // manifest → on crash-recovery we restore to the SAME chosen path with the
  // SAME name, no re-picking. (promptSaveDestination + streamToHandle live in
  // recorderbox-save-flow.ts so they're unit-testable without a Svelte harness.)
  //   * a handle  → start recording, stream to it on stop.
  //   * null      → no picker (Firefox/Safari): record to OPFS, download on stop.
  //   * 'cancel'  → user dismissed the picker: do NOT record.

  // ── Download fallback (Firefox/Safari, or a recovery handle that's gone) ──
  // The recorder's saveBytes contract: used ONLY when no destHandle exists.
  async function saveBytes(bytes: Uint8Array, name: string, mime: string): Promise<void> {
    const safeName = sanitizeRecordingFilename(name, 'mp4');
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

  // Guards against the $effect re-entering startRecording while the START
  // save-location picker is open (an async user-gesture dialog).
  let starting = false;

  async function startRecording() {
    if (starting) return;
    const ve = getVideoEngine();
    if (!ve || !captureEl) { setData('recording', false); return; }

    starting = true;
    try {
      // ── Resolve the destination FOLDER (Tweak 1: no per-save prompt) ──
      // Pick a folder ONCE; subsequent records + every rolling chunk auto-write
      // into it. If we already remember one (re-verify permission) → use it
      // silently. Else prompt once (the Record press is the user gesture).
      //   * a dir handle → write FILENAME-CHUNK#-DATETIME chunks into it.
      //   * null         → no directory picker (Firefox/Safari): per-chunk
      //                    <a download> fallback (the recorder uses saveBytes).
      //   * 'cancel'     → user dismissed → do NOT record; revert the toggle.
      let dirHandle: FileSystemDirectoryHandle | null = saveFolder;
      if (dirHandle && !(await ensureHandleWritePermission(dirHandle))) {
        dirHandle = null; // permission lapsed — re-pick below.
      }
      if (!dirHandle) {
        const picked = await promptSaveFolder();
        if (picked === 'cancel') {
          setData('recording', false);
          return;
        }
        // The user may have flipped Record OFF while the picker was open.
        if (!recording) return;
        if (picked) {
          dirHandle = picked;
          saveFolder = picked; // remember → no prompt next time.
        }
        // picked === null → no FS-Access: dirHandle stays null → download path.
      }

      // ── OVERWRITE prompt (Tweak 1: the ONLY remaining prompt) ──
      // Chunk names carry a unique DATETIME so a real collision is near-impossible
      // — this is a genuine safety net. Check the FIRST chunk's resolved name.
      if (dirHandle) {
        const firstName = chunkFileName(filename, 1, new Date());
        if (await fileExistsInDir(dirHandle, firstName)) {
          const ok =
            typeof confirm === 'function'
              ? confirm(`"${firstName}" already exists. Overwrite?`)
              : true;
          if (!ok) {
            setData('recording', false);
            return;
          }
        }
      }
      if (!recording) return;

      const ew = ve.canvas.width || ENGINE_W;
      const eh = ve.canvas.height || ENGINE_H;
      captureEl.width = ew;
      captureEl.height = eh;

      // Resolve the encode profile for the chosen quality tier at THIS
      // resolution: HIGH = the original H.264 / 14 Mbps; BALANCED/SMALL prefer
      // hardware HEVC if the runtime can encode it, else a lower-bitrate H.264.
      // Probed against the real runtime (degrades gracefully). All tiers request
      // the hardware encoder so a software encode can't starve the audio capture.
      const profile = await pickEncodeProfile(quality, ew, eh);
      // The user may have flipped Record OFF while the probe ran.
      if (!recording) return;

      // Pull the live audio source the module published. PREFER the
      // sample-accurate capture tap (read('audioCapture') → a Promise resolving
      // to { port, sampleRate } | null): the worklet posts planar f32 stereo
      // from the audio thread + the recorder drains it losslessly (no
      // clicks/pops). Fall back to the legacy capture MediaStream's audio track
      // (audioStream) when no tap is available (no AudioContext / worklet load
      // failed). null/absent both = record video only / silent.
      const e = engineCtx.get();
      let audioCapture: { port: MessagePort; sampleRate: number } | null = null;
      let audioTrack: MediaStreamTrack | null = null;
      if (e && node) {
        try {
          audioCapture = (await e.read(node, 'audioCapture')) as
            | { port: MessagePort; sampleRate: number }
            | null;
        } catch {
          audioCapture = null;
        }
        // The user may have flipped Record OFF while the tap Promise settled.
        if (!recording) return;
        const stream = e.read(node, 'audioStream') as MediaStream | null | undefined;
        audioTrack = stream?.getAudioTracks?.()[0] ?? null;
      }

      recorder = new RecorderboxRecorder({
        nodeId: id,
        canvas: captureEl,
        audioCapture,   // PREFERRED — sample-accurate worklet tap (lossless).
        audioTrack,     // FALLBACK — legacy MediaStreamAudioTrackSource path.
        filename,
        // FOLDER model: chunks auto-write into the picked folder under their
        // FILENAME-CHUNK#-DATETIME names; null → per-chunk <a download> fallback.
        dirHandle,
        videoCodec: profile.videoCodec,
        videoBitrate: profile.videoBitrate,
        keyFrameInterval: profile.keyFrameInterval,
        audioBitrate: profile.audioBitrate,
        hardwareAcceleration: profile.hardwareAcceleration,
        width: ew,
        height: eh,
        saveBytes,
        onStateChange: (s) => { recState = s; },
        onChunkSaved: ({ name }) => { lastSavedChunk = name; },
      });
      try {
        await recorder.start();
      } catch {
        recorder = null;
        recState = 'error';
        setData('recording', false);
      }
    } finally {
      starting = false;
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

  async function retireRecovery(opfsPath: string) {
    await markManifestDone(opfsPath);
    await deleteOpfsFile(opfsPath);
    await deleteManifest(opfsPath);
  }

  async function recoverOne(m: RecorderboxManifest) {
    try {
      // 1a) Persisted destination FOLDER (Chromium, the folder model): re-acquire
      //     write permission, resolve the chunk's file handle INSIDE the folder
      //     (FILENAME-CHUNK#-DATETIME.mp4), and STREAM the partial straight back —
      //     no re-picking. (requestPermission needs a user gesture: the Save btn.)
      if (m.dirHandle && (await ensureHandleWritePermission(m.dirHandle))) {
        const name = m.chunkName ?? sanitizeRecordingFilename(m.filename, 'mp4');
        const fh = await fileHandleInDir(m.dirHandle, name);
        const written = await streamToHandle(m.opfsPath, fh);
        if (written > 0) {
          await retireRecovery(m.opfsPath);
          await scanRecoverable();
          return;
        }
      }

      // 1b) Legacy persisted single-file handle (Chromium): re-acquire write
      //     permission + stream the partial back to the original chosen path.
      if (m.destHandle && (await ensureHandleWritePermission(m.destHandle))) {
        const written = await streamToHandle(m.opfsPath, m.destHandle);
        if (written > 0) {
          await retireRecovery(m.opfsPath);
          await scanRecoverable();
          return;
        }
        // Nothing written — fall through to the picker/download fallback.
      }

      // 2) Fallback (handle gone / permission denied / Firefox/Safari): prompt
      //    for a NEW destination if the picker is available + stream to it; else
      //    download the bytes. Either way the suggested name is the chunk name
      //    (FILENAME-CHUNK#-DATETIME.mp4) when one was recorded.
      const suggestedName = m.chunkName ?? sanitizeRecordingFilename(m.filename, 'mp4');
      const dest =
        m.dirHandle == null && m.destHandle == null && canSaveViaPicker()
          ? await promptSaveDestination(suggestedName)
          : null;
      if (dest && dest !== 'cancel') {
        await streamToHandle(m.opfsPath, dest);
      } else if (dest === 'cancel') {
        // User dismissed the picker — keep the candidate.
        await scanRecoverable();
        return;
      } else {
        const bytes = await readOpfsBytes(m.opfsPath);
        if (bytes && bytes.byteLength > 0) {
          await saveBytes(bytes, suggestedName, m.mime);
        }
      }
      await retireRecovery(m.opfsPath);
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
