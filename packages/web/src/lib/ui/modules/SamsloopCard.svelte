<script lang="ts">
  // SamsloopCard — loop-based sample player. Upload a small audio file
  // (anything the browser's decodeAudioData can read — wav, mp3, m4a/aac,
  // ogg, flac, opus, weba), set the playback window, scrub varispeed
  // (forward or reverse), toggle loop / one-shot. File-upload + canvas
  // waveform on top, MACROOSCILLATOR-style fader column below.
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import {
    samsloopDef,
    loadSamsloopWav,
    SAMSLOOP_MAX_FILE_BYTES,
    SAMSLOOP_MAX_SAMPLES,
    SAMSLOOP_RATE_RANGE,
    createSamsloopRecMachine,
    samsloopRecStart,
    samsloopRecAppend,
    samsloopRecStop,
    samsloopRecFail,
    type SamsloopData,
    type SamsloopRecMachine,
  } from '$lib/audio/modules/samsloop';
  import { useEngine } from '$lib/audio/engine-context';
  import { AudioEngine } from '$lib/audio/engine';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  const defaultFor = (k: string): number =>
    samsloopDef.params.find((p) => p.id === k)!.defaultValue;

  let rate  = $derived(node?.params.rate  ?? defaultFor('rate'));
  let mode  = $derived(node?.params.mode  ?? defaultFor('mode'));
  let start = $derived(node?.params.start ?? defaultFor('start'));
  let end   = $derived(node?.params.end   ?? defaultFor('end'));

  // Sample length is derived from node.data. Used as the upper clamp for
  // the start/end sliders; the param's declared max (1e6) is a generous
  // ceiling. When no sample is loaded the sliders snap to [0, 1].
  let sampleLength = $derived.by(() => {
    const d = node?.data as SamsloopData | undefined;
    return d?.sampleLength ?? 0;
  });
  let fileName = $derived.by(() => {
    const d = node?.data as SamsloopData | undefined;
    return d?.fileName ?? null;
  });

  const set = (k: string) => (v: number) => { const t = patch.nodes[id]; if (t) t.params[k] = v; };
  const live = (k: string) => () => {
    const e = engineCtx.get(); if (!e || !node) return undefined;
    return e.readParam(node, k);
  };

  const inputs: PortDescriptor[] = [
    { id: 'trig',    cable: 'gate' },
    { id: 'rate_cv', label: 'RATE (CV)', cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'out', cable: 'audio' },
  ];

  let canvasEl: HTMLCanvasElement | null = $state(null);
  let uploadStatus = $state<string | null>(null);
  let uploadError = $state<string | null>(null);
  let isLoop = $derived(Math.round(mode) === 1);

  // ---------- mic-record state ----------
  //
  // The state machine in `recMachine` is the source of truth for what's
  // currently happening (idle / recording / stopped). The MediaStream +
  // AudioContext nodes that drive it are held in plain locals — we tear
  // them down on stop / on failure / on component destroy. SAMSLOOP holds
  // ONE sample at a time (see header on samsloop.ts) so finishing a
  // recording REPLACES whatever sample was previously loaded.
  let recMachine = $state<SamsloopRecMachine>(createSamsloopRecMachine(22050));
  let micStream: MediaStream | null = null;
  let micSource: MediaStreamAudioSourceNode | null = null;
  let micTap: ScriptProcessorNode | null = null;
  let recStartTimeMs = $state<number>(0);
  // Tick state for the ms counter so the readout updates while
  // recording. setInterval rather than rAF — we display milliseconds at
  // 100ms granularity, not 60fps.
  let recCounterTicker: ReturnType<typeof setInterval> | null = null;
  let recCounterMs = $state<number>(0);

  let isRecording = $derived(recMachine.state === 'recording');
  let isCapStopped = $derived(
    recMachine.state === 'stopped' && recMachine.stopReason === 'cap',
  );
  // REC and file-upload are mutually exclusive: while one is in-flight
  // the other is disabled. uploadStatus is set transiently during
  // decode; recording state covers the live-capture window.
  let uploadInFlight = $derived(uploadStatus !== null);
  let recButtonDisabled = $derived(uploadInFlight);
  let fileInputDisabled = $derived(isRecording);

  function tearDownMicGraph() {
    if (micTap) {
      try { micTap.disconnect(); } catch { /* */ }
      // The processor's onaudioprocess holds a closure over recMachine —
      // null it explicitly so a residual fire after disconnect is a no-op.
      micTap.onaudioprocess = null;
      micTap = null;
    }
    if (micSource) {
      try { micSource.disconnect(); } catch { /* */ }
      micSource = null;
    }
    if (micStream) {
      for (const track of micStream.getTracks()) {
        try { track.stop(); } catch { /* */ }
      }
      micStream = null;
    }
    if (recCounterTicker !== null) {
      clearInterval(recCounterTicker);
      recCounterTicker = null;
    }
  }

  /** Write a finished recording into node.data, replacing any previous
   *  sample (one-sample invariant). Mirrors the file-upload commit path
   *  so playback wiring stays identical. */
  function commitRecordingToNode(samples: Float32Array, sampleRate: number) {
    const target = patch.nodes[id];
    if (!target) return;
    if (!target.data) target.data = {};
    const d = target.data as SamsloopData;
    d.samples = Array.from(samples);
    d.sampleRate = sampleRate;
    d.sampleLength = samples.length;
    // Use a stable filename so the card displays "mic recording" instead
    // of nothing — visually distinguishable from an uploaded WAV.
    d.fileName = `mic ${(samples.length / sampleRate).toFixed(2)}s`;
    target.params.start = 0;
    target.params.end = samples.length;
  }

  async function toggleRecord() {
    if (isRecording) {
      // User-driven stop. tearDown + commit the captured samples.
      const finished = samsloopRecStop(recMachine);
      const samples = finished.samples;
      const sr = finished.sampleRate;
      recMachine = finished;
      tearDownMicGraph();
      if (samples.length > 0) commitRecordingToNode(samples, sr);
      return;
    }
    // Begin a fresh recording. Clear any prior upload status so the
    // status row only shows live state.
    uploadStatus = null;
    uploadError = null;

    // Grab the AudioContext from the engine. We tap the mic through it
    // rather than spawning a separate context so the captured samples
    // are at the graph's native rate (no resampling later).
    const eng = engineCtx.get();
    let ctx: BaseAudioContext | undefined;
    try {
      if (eng?.hasDomain('audio')) {
        const audioEngine = eng.getDomain<AudioEngine>('audio');
        ctx = audioEngine.ctx;
      }
    } catch {
      ctx = undefined;
    }
    if (!ctx || typeof (ctx as AudioContext).createMediaStreamSource !== 'function') {
      recMachine = samsloopRecFail(
        recMachine,
        'Audio engine not ready yet — start audio first.',
      );
      return;
    }
    const audioCtx = ctx as AudioContext;

    // Permission + device acquisition. getUserMedia rejects on denial /
    // no-device / SecureContext violations; we route those into the
    // state machine as inline errors rather than letting them throw.
    if (!navigator.mediaDevices?.getUserMedia) {
      recMachine = samsloopRecFail(
        recMachine,
        'Microphone capture not supported in this browser.',
      );
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      const name = (err as { name?: string } | null)?.name;
      const msg =
        name === 'NotAllowedError' || name === 'PermissionDeniedError'
          ? 'Microphone permission denied.'
          : name === 'NotFoundError' || name === 'DevicesNotFoundError'
            ? 'No microphone found.'
            : `Mic capture failed: ${err instanceof Error ? err.message : String(err)}`;
      recMachine = samsloopRecFail(recMachine, msg);
      return;
    }

    micStream = stream;
    // ScriptProcessorNode is deprecated but universally available and
    // doesn't require a separate worklet bundle for capture — fine for
    // a short (max ~2.84s) mono recording. The cap auto-stop bounds the
    // total CPU exposure to the processor's lifetime.
    micSource = audioCtx.createMediaStreamSource(stream);
    const tap = audioCtx.createScriptProcessor(2048, 1, 1);
    micTap = tap;
    recMachine = samsloopRecStart(recMachine, audioCtx.sampleRate);
    recStartTimeMs = performance.now();
    recCounterMs = 0;
    recCounterTicker = setInterval(() => {
      recCounterMs = Math.floor(performance.now() - recStartTimeMs);
    }, 100);

    tap.onaudioprocess = (ev) => {
      // input[0] is mono (we asked for 1 input channel). Copy out — the
      // event's buffer is reused.
      const ch = ev.inputBuffer.getChannelData(0);
      const chunk = new Float32Array(ch.length);
      chunk.set(ch);
      const updated = samsloopRecAppend(recMachine, chunk);
      // If the helper auto-stopped on cap, tear down the mic graph here
      // and commit the captured samples. Mirrors the user-stop path.
      if (recMachine.state === 'recording' && updated.state === 'stopped') {
        recMachine = updated;
        const samples = updated.samples;
        const sr = updated.sampleRate;
        tearDownMicGraph();
        commitRecordingToNode(samples, sr);
      } else {
        recMachine = updated;
      }
    };
    micSource.connect(tap);
    // ScriptProcessorNode requires connection to a destination to fire
    // onaudioprocess. Connect to a muted GainNode so we don't echo back
    // into the user's speakers (which would cause feedback).
    const sink = audioCtx.createGain();
    sink.gain.value = 0;
    tap.connect(sink);
    sink.connect(audioCtx.destination);
  }

  // Tear down the mic graph on unmount so we don't leave the mic LED on
  // and don't leak the ScriptProcessorNode. Recording-state machine is
  // pure so it doesn't need explicit cleanup.
  $effect(() => {
    return () => tearDownMicGraph();
  });

  async function onAudioFileChange(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    uploadError = null;
    uploadStatus = 'parsing...';
    // Track whether we set a success status inside the try block so the
    // finally clause knows whether to clear it (failure paths) or leave
    // the success message in place. Every exit path resets the file
    // input + clears the spinner — this fixes the regression where
    // `if (!target) return;` left the spinner forever.
    let successStatus: string | null = null;
    try {
      const eng = engineCtx.get();
      // The PatchEngine wraps per-domain engines; the audio engine holds
      // the live AudioContext we need for decodeAudioData. hasDomain()
      // guards so we don't throw if the engine isn't booted yet.
      let ctx: BaseAudioContext | undefined;
      try {
        if (eng?.hasDomain('audio')) {
          const audioEngine = eng.getDomain<AudioEngine>('audio');
          ctx = audioEngine.ctx;
        }
      } catch {
        ctx = undefined;
      }
      if (!ctx) {
        uploadError = 'Audio engine not ready yet — start audio first.';
        return;
      }
      const result = await loadSamsloopWav(file, ctx);
      if (!result.ok) {
        uploadError = result.error ?? 'Unknown error';
        return;
      }
      const samples = result.samples!;
      const target = patch.nodes[id];
      if (!target) {
        // Node was deleted between picking the file and the decode
        // returning. Surface a clear error rather than leaving the
        // spinner forever (the prior bug at this line).
        uploadError = 'Module was removed during upload.';
        return;
      }
      if (!target.data) target.data = {};
      const d = target.data as SamsloopData;
      // Storing the samples into node.data writes them into the
      // syncedstore CRDT — that's where most of the load-time cost lives
      // (one YArray record per sample, plus broadcast to peers). The
      // decoded-buffer cap inside loadSamsloopWav keeps this bounded.
      d.samples = Array.from(samples);
      d.sampleRate = result.sampleRate;
      d.sampleLength = samples.length;
      d.fileName = file.name;
      // Reset playback window to the full sample.
      target.params.start = 0;
      target.params.end = samples.length;
      successStatus = `loaded ${samples.length} samples @ ${result.sampleRate} Hz`;
    } finally {
      uploadStatus = successStatus;
      try { input.value = ''; } catch { /* */ }
    }
  }

  function toggleMode() {
    const t = patch.nodes[id];
    if (!t) return;
    t.params.mode = Math.round(mode) === 1 ? 0 : 1;
  }

  // Peak-per-pixel waveform draw. Runs once whenever sampleLength changes
  // (avoids per-frame redraws — waveform is static once loaded). Also
  // redraws when the start/end sliders move, to update the highlight band.
  $effect(() => {
    // Track reactivity dependencies explicitly: sampleLength, start, end.
    void sampleLength; void start; void end;
    if (!canvasEl) return;
    const ctx2d = canvasEl.getContext('2d');
    if (!ctx2d) return;
    const w = canvasEl.width;
    const h = canvasEl.height;
    ctx2d.clearRect(0, 0, w, h);
    ctx2d.fillStyle = '#0a0c11';
    ctx2d.fillRect(0, 0, w, h);
    const d = node?.data as SamsloopData | undefined;
    const samples = d?.samples;
    if (!samples || samples.length === 0) {
      ctx2d.fillStyle = '#5a6275';
      ctx2d.font = '10px ui-monospace, monospace';
      ctx2d.textAlign = 'center';
      ctx2d.fillText('NO SAMPLE LOADED', w / 2, h / 2);
      return;
    }
    // Highlight the active playback window first (behind the waveform).
    const wStartFrac = Math.max(0, Math.min(1, start / samples.length));
    const wEndFrac = Math.max(wStartFrac, Math.min(1, end / samples.length));
    ctx2d.fillStyle = 'rgba(80, 160, 220, 0.18)';
    ctx2d.fillRect(wStartFrac * w, 0, (wEndFrac - wStartFrac) * w, h);
    // Peak-per-pixel waveform trace.
    const samplesPerPx = Math.max(1, Math.floor(samples.length / w));
    ctx2d.strokeStyle = 'rgb(255, 150, 40)';
    ctx2d.lineWidth = 1;
    ctx2d.beginPath();
    for (let x = 0; x < w; x++) {
      const i0 = x * samplesPerPx;
      const i1 = Math.min(samples.length, i0 + samplesPerPx);
      let mn = 0;
      let mx = 0;
      for (let i = i0; i < i1; i++) {
        const s = samples[i] ?? 0;
        if (s < mn) mn = s;
        if (s > mx) mx = s;
      }
      const y0 = (1 - (mx * 0.5 + 0.5)) * h;
      const y1 = (1 - (mn * 0.5 + 0.5)) * h;
      ctx2d.moveTo(x + 0.5, y0);
      ctx2d.lineTo(x + 0.5, y1);
    }
    ctx2d.stroke();
  });
</script>

<div class="mod-card samsloop-card" data-testid="samsloop-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <header class="title">SAMSLOOP</header>
  <div class="subtitle">SAMPLE LOOPER · VARISPEED · ±2×</div>

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="body">
      <div class="upload-row">
        <label
          class="upload-btn"
          class:disabled={fileInputDisabled}
          data-testid="samsloop-upload-label"
        >
          <input
            type="file"
            accept="audio/*"
            onchange={onAudioFileChange}
            disabled={fileInputDisabled}
            data-testid="samsloop-wav-input"
          />
          <span>Load audio (≤ {SAMSLOOP_MAX_FILE_BYTES / 1024} KB)…</span>
        </label>
        <button
          type="button"
          class="rec-btn"
          class:active={isRecording}
          disabled={recButtonDisabled}
          onclick={toggleRecord}
          data-testid="samsloop-rec-button"
          aria-label={isRecording ? 'Stop recording' : 'Start recording from microphone'}
        >
          {#if isRecording}
            <span class="rec-dot"></span>
            REC <span class="rec-counter" data-testid="samsloop-rec-counter">{recCounterMs} ms</span>
          {:else}
            REC
          {/if}
        </button>
        <button
          type="button"
          class="mode-btn"
          class:loop={isLoop}
          onclick={toggleMode}
          data-testid="samsloop-mode-toggle"
          aria-label="Toggle loop / one-shot"
        >{isLoop ? 'LOOP' : '1-SHOT'}</button>
      </div>
      {#if fileName}
        <div class="filename" data-testid="samsloop-filename">{fileName}</div>
      {/if}
      {#if uploadStatus}
        <div class="upload-status" data-testid="samsloop-upload-status">{uploadStatus}</div>
      {/if}
      {#if uploadError}
        <div class="upload-error" data-testid="samsloop-upload-error">{uploadError}</div>
      {/if}
      {#if isCapStopped}
        <div class="upload-status" data-testid="samsloop-rec-cap-msg">max length reached</div>
      {/if}
      {#if recMachine.error}
        <div class="upload-error" data-testid="samsloop-rec-error">{recMachine.error}</div>
      {/if}

      <div class="waveform-row">
        <Fader
          value={start}
          min={0}
          max={Math.max(1, sampleLength)}
          defaultValue={0}
          label="Start"
          curve="linear"
          onchange={set('start')} moduleId={id} paramId="start"
          readLive={live('start')}
        />
        <canvas
          bind:this={canvasEl}
          width="200"
          height="100"
          class="waveform"
          data-testid="samsloop-waveform"
        ></canvas>
        <Fader
          value={end}
          min={0}
          max={Math.max(1, sampleLength)}
          defaultValue={Math.max(1, sampleLength)}
          label="End"
          curve="linear"
          onchange={set('end')} moduleId={id} paramId="end"
          readLive={live('end')}
        />
      </div>

      <div class="rate-row">
        <Fader
          value={rate}
          min={SAMSLOOP_RATE_RANGE.min}
          max={SAMSLOOP_RATE_RANGE.max}
          defaultValue={SAMSLOOP_RATE_RANGE.defaultValue}
          label="Rate"
          units="×"
          curve="linear"
          onchange={set('rate')} moduleId={id} paramId="rate"
          readLive={live('rate')}
          formatValue={(v: number) => v >= 0
            ? `+${v.toFixed(2)}×`
            : `${v.toFixed(2)}× rev`}
        />
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .samsloop-card {
    width: 360px;
    min-height: 360px;
  }
  .samsloop-card .title {
    font-family: var(--font-display, inherit);
    font-size: 0.85rem;
    letter-spacing: 0.04em;
  }
  .samsloop-card .subtitle {
    font-size: 0.55rem;
    color: var(--text-dim, #8b94a5);
    text-align: center;
    letter-spacing: 0.08em;
    margin-top: 2px;
  }
  .samsloop-card .body {
    margin-top: 12px;
    padding: 0 14px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .samsloop-card .upload-row {
    display: flex;
    gap: 6px;
    align-items: stretch;
  }
  .samsloop-card .upload-btn {
    flex: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: #1a1f2a;
    color: var(--text-dim, #8b94a5);
    border: 1px dashed #404652;
    border-radius: 2px;
    padding: 4px 8px;
    font-size: 0.6rem;
    cursor: pointer;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  .samsloop-card .upload-btn input[type='file'] {
    display: none;
  }
  .samsloop-card .upload-btn:hover {
    color: var(--text, #d8dde6);
    border-color: #6a7282;
  }
  .samsloop-card .upload-btn.disabled {
    opacity: 0.4;
    pointer-events: none;
  }
  .samsloop-card .mode-btn {
    background: #1a1f2a;
    color: var(--text-dim, #8b94a5);
    border: 1px solid #404652;
    border-radius: 2px;
    padding: 4px 10px;
    font-size: 0.6rem;
    cursor: pointer;
    letter-spacing: 0.08em;
    font-family: ui-monospace, monospace;
    min-width: 64px;
  }
  .samsloop-card .mode-btn.loop {
    color: rgb(80, 200, 220);
    border-color: rgb(80, 160, 220);
  }
  .samsloop-card .mode-btn:hover {
    border-color: #6a7282;
  }
  .samsloop-card .rec-btn {
    background: #1a1f2a;
    color: var(--text-dim, #8b94a5);
    border: 1px solid #404652;
    border-radius: 2px;
    padding: 4px 8px;
    font-size: 0.6rem;
    cursor: pointer;
    letter-spacing: 0.08em;
    font-family: ui-monospace, monospace;
    min-width: 64px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
  }
  .samsloop-card .rec-btn:hover {
    border-color: #6a7282;
  }
  .samsloop-card .rec-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .samsloop-card .rec-btn.active {
    color: #ffffff;
    background: #c0282e;
    border-color: #ff6b6b;
  }
  .samsloop-card .rec-btn .rec-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #ffffff;
    display: inline-block;
    /* Pulse only while recording (parent .active) so non-recording
     * REC buttons don't blink. */
    animation: samsloop-rec-pulse 1s ease-in-out infinite;
  }
  .samsloop-card .rec-btn .rec-counter {
    font-size: 0.55rem;
    opacity: 0.9;
  }
  @keyframes samsloop-rec-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }
  .samsloop-card .filename {
    font-size: 0.55rem;
    color: var(--text-dim, #8b94a5);
    font-family: ui-monospace, monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .samsloop-card .upload-status {
    font-size: 0.6rem;
    color: var(--text-dim, #8b94a5);
    font-family: ui-monospace, monospace;
  }
  .samsloop-card .upload-error {
    font-size: 0.6rem;
    color: #ff6b6b;
    font-family: ui-monospace, monospace;
  }
  .samsloop-card .waveform-row {
    display: flex;
    gap: 8px;
    align-items: stretch;
  }
  .samsloop-card .waveform {
    flex: 1;
    display: block;
    height: 100px;
    background: #0a0c11;
    border: 1px solid #2a2f3a;
    border-radius: 2px;
  }
  .samsloop-card .rate-row {
    margin-top: 6px;
    display: flex;
    justify-content: center;
  }
</style>
