<script lang="ts">
  // TwotracksCard — tape loop emulator card (Phase 1: reel A only).
  //
  // Layout (reel A block):
  //   - Waveform canvas (buffer visualization + draggable playhead + start/end markers)
  //   - Transport LEDs (ARM / REC / PLAY / OVDB)
  //   - Mode toggle (tape / loop tape)
  //   - Overdub toggle button
  //   - Decay slider
  //   - Save-tape button (WAV export)
  //
  // All param writes go through setNodeParam() — never direct node.params mutation.
  // Per-frame playhead scrub state is kept LOCAL (localPlayhead) — NOT written to
  // the synced Y.Doc per frame to avoid the write-storm. Only on pointer-up does it
  // send a seek message to the worklet port.

  import type { NodeProps } from '@xyflow/svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { setNodeParam } from '$lib/graph/mutate';
  import { twotracksDef, type TwoTracksData, TWOTRACKS_MAX_SAMPLES } from '$lib/audio/modules/twotracks';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  const defaultFor = (k: string): number =>
    twotracksDef.params.find((p) => p.id === k)!.defaultValue;

  // Synced param values.
  let rateA        = $derived(node?.params.rate_a        ?? defaultFor('rate_a'));
  let modeA        = $derived(node?.params.mode_a        ?? defaultFor('mode_a'));
  let decayA       = $derived(node?.params.decay_a       ?? defaultFor('decay_a'));
  let overdubFlagA = $derived(node?.params.overdub_flag_a ?? defaultFor('overdub_flag_a'));

  // Data written back from the worklet (transport state + playhead).
  let transportState = $derived.by(() => {
    const d = node?.data as TwoTracksData | undefined;
    return d?.transportState_a ?? 'idle';
  });
  let syncedPlayhead = $derived.by(() => {
    const d = node?.data as TwoTracksData | undefined;
    return d?.playhead_a ?? 0;
  });
  let tapeABuf = $derived.by(() => {
    const d = node?.data as TwoTracksData | undefined;
    return d?.tapeA ?? null;
  });

  // Derived transport LED states.
  let ledArm     = $derived(transportState === 'armed');
  let ledRec     = $derived(transportState === 'rec' || transportState === 'overdub');
  let ledPlay    = $derived(transportState === 'play' || transportState === 'rec' || transportState === 'overdub');
  let ledOverdub = $derived(transportState === 'overdub');

  // Mode toggle.
  let isLoop = $derived(Math.round(modeA) === 1);

  // Overdub active flag (for button class).
  let overdubActive = $derived(Math.round(overdubFlagA) === 1);

  // Canvas and scrub state (local — NOT synced per frame).
  let canvasEl: HTMLCanvasElement | null = $state(null);
  let scrubbing = $state(false);
  let localPlayhead = $state(0);

  // Displayed playhead: use local value while scrubbing, synced otherwise.
  let displayPlayhead = $derived(scrubbing ? localPlayhead : syncedPlayhead);

  const inputs: PortDescriptor[] = [
    { id: 'audio_l_in_a', label: 'L IN A',    cable: 'audio' },
    { id: 'audio_r_in_a', label: 'R IN A',    cable: 'audio' },
    { id: 'rec_start_a',  label: 'REC START', cable: 'gate' },
    { id: 'rec_arm_a',    label: 'REC ARM',   cable: 'gate' },
    { id: 'overdub_a',    label: 'OVERDUB',   cable: 'gate' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'out_l', label: 'OUT L', cable: 'audio' },
    { id: 'out_r', label: 'OUT R', cable: 'audio' },
  ];

  // ---------- mode / overdub toggles ----------

  function toggleMode() {
    setNodeParam(id, 'mode_a', Math.round(modeA) === 1 ? 0 : 1);
  }

  function toggleOverdub() {
    setNodeParam(id, 'overdub_flag_a', Math.round(overdubFlagA) === 1 ? 0 : 1);
  }

  // ---------- decay slider ----------

  function onDecayInput(e: Event) {
    const v = parseFloat((e.target as HTMLInputElement).value);
    if (!isNaN(v)) setNodeParam(id, 'decay_a', v);
  }

  // ---------- canvas scrub (draggable playhead) ----------

  function posPxToNorm(x: number): number {
    if (!canvasEl) return 0;
    return Math.max(0, Math.min(1, x / canvasEl.width));
  }

  function onCanvasPointerDown(e: PointerEvent) {
    e.stopPropagation();
    if (!canvasEl) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    scrubbing = true;
    localPlayhead = posPxToNorm(e.offsetX);
  }

  function onCanvasPointerMove(e: PointerEvent) {
    e.stopPropagation();
    if (!scrubbing) return;
    localPlayhead = posPxToNorm(e.offsetX);
  }

  function onCanvasPointerUp(e: PointerEvent) {
    e.stopPropagation();
    if (!scrubbing) return;
    scrubbing = false;
    const pos = posPxToNorm(e.offsetX);
    localPlayhead = pos;
    // Send seek message to worklet via engine handle.
    const eng = engineCtx.get();
    if (eng && node) {
      try {
        const port = eng.read(node, 'workletPort') as MessagePort | undefined;
        if (port) port.postMessage({ type: 'seek', pos });
      } catch { /* engine may not be ready */ }
    }
  }

  // ---------- save tape (WAV export) ----------

  function onSave() {
    if (!tapeABuf || tapeABuf.bufLen === 0) return;
    const { bufL, bufR, bufLen } = tapeABuf;
    const sr = 48000;
    const numChannels = 2;
    const bitsPerSample = 16;
    const numFrames = Math.min(bufLen, bufL.length, bufR.length);
    const byteRate = sr * numChannels * (bitsPerSample / 8);
    const blockAlign = numChannels * (bitsPerSample / 8);
    const dataBytes = numFrames * blockAlign;
    const buf = new ArrayBuffer(44 + dataBytes);
    const view = new DataView(buf);
    // RIFF header
    const enc = new TextEncoder();
    const riff = enc.encode('RIFF'); for (let i = 0; i < 4; i++) view.setUint8(i, riff[i]);
    view.setUint32(4, 36 + dataBytes, true);
    const wave = enc.encode('WAVE'); for (let i = 0; i < 4; i++) view.setUint8(8 + i, wave[i]);
    const fmt = enc.encode('fmt '); for (let i = 0; i < 4; i++) view.setUint8(12 + i, fmt[i]);
    view.setUint32(16, 16, true);       // subchunk1Size
    view.setUint16(20, 1, true);        // PCM format
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sr, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);
    const data = enc.encode('data'); for (let i = 0; i < 4; i++) view.setUint8(36 + i, data[i]);
    view.setUint32(40, dataBytes, true);
    // PCM data (interleaved L, R)
    let off = 44;
    for (let i = 0; i < numFrames; i++) {
      const l = Math.max(-1, Math.min(1, bufL[i] ?? 0));
      const r = Math.max(-1, Math.min(1, bufR[i] ?? 0));
      view.setInt16(off, Math.round(l * 0x7fff), true); off += 2;
      view.setInt16(off, Math.round(r * 0x7fff), true); off += 2;
    }
    const blob = new Blob([buf], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `twotracks-tape-${Date.now()}.wav`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  // ---------- waveform draw ----------

  $effect(() => {
    void tapeABuf; void displayPlayhead;
    if (!canvasEl) return;
    const ctx2d = canvasEl.getContext('2d');
    if (!ctx2d) return;
    const w = canvasEl.width;
    const h = canvasEl.height;
    ctx2d.clearRect(0, 0, w, h);
    ctx2d.fillStyle = '#0a0c11';
    ctx2d.fillRect(0, 0, w, h);

    const buf = tapeABuf;
    if (!buf || buf.bufLen === 0) {
      ctx2d.fillStyle = '#5a6275';
      ctx2d.font = '9px ui-monospace, monospace';
      ctx2d.textAlign = 'center';
      ctx2d.fillText('NO TAPE', w / 2, h / 2);
    } else {
      const samples = buf.bufL;
      const len = Math.min(buf.bufLen, samples.length);
      const samplesPerPx = Math.max(1, Math.floor(len / w));
      ctx2d.strokeStyle = 'rgb(255, 140, 40)';
      ctx2d.lineWidth = 1;
      ctx2d.beginPath();
      for (let x = 0; x < w; x++) {
        const i0 = x * samplesPerPx;
        const i1 = Math.min(len, i0 + samplesPerPx);
        let mn = 0, mx = 0;
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
    }

    // Playhead line.
    const px = Math.round(displayPlayhead * w);
    ctx2d.strokeStyle = 'rgba(80, 160, 255, 0.85)';
    ctx2d.lineWidth = 1.5;
    ctx2d.beginPath();
    ctx2d.moveTo(px + 0.5, 0);
    ctx2d.lineTo(px + 0.5, h);
    ctx2d.stroke();
  });
</script>

<div class="mod-card twotracks-card" data-testid="twotracks-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="TWOTRACKS" />
  <div class="subtitle">TAPE LOOP · RECORD · OVERDUB · SCRUB</div>

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="body">

      <!-- Reel A block -->
      <div class="reel-block" data-testid="twotracks-reel-a">

        <!-- Transport LEDs row -->
        <div class="leds-row">
          <div class="led-item">
            <div class="led" class:active={ledArm} data-testid="led-arm"></div>
            <span class="led-label">ARM</span>
          </div>
          <div class="led-item">
            <div class="led led-rec-color" class:active={ledRec} data-testid="led-rec"></div>
            <span class="led-label">REC</span>
          </div>
          <div class="led-item">
            <div class="led led-play-color" class:active={ledPlay} data-testid="led-play"></div>
            <span class="led-label">PLAY</span>
          </div>
          <div class="led-item">
            <div class="led led-ovdb-color" class:active={ledOverdub} data-testid="led-overdub"></div>
            <span class="led-label">OVDB</span>
          </div>

          <!-- Mode toggle -->
          <button
            type="button"
            class="mode-btn"
            class:loop={isLoop}
            onclick={toggleMode}
            data-testid="twotracks-mode-toggle"
            aria-label="Toggle tape / loop tape"
          >{isLoop ? 'loop tape' : 'tape'}</button>

          <!-- Overdub toggle -->
          <button
            type="button"
            class="overdub-btn"
            class:active={overdubActive}
            onclick={toggleOverdub}
            data-testid="twotracks-overdub-toggle"
            aria-label="Toggle overdub"
          >OVERDUB</button>
        </div>

        <!-- Waveform canvas (draggable playhead) -->
        <canvas
          bind:this={canvasEl}
          width="220"
          height="60"
          class="waveform nodrag"
          data-testid="twotracks-waveform"
          onpointerdown={onCanvasPointerDown}
          onpointermove={onCanvasPointerMove}
          onpointerup={onCanvasPointerUp}
        ></canvas>

        <!-- Decay row -->
        <div class="decay-row">
          <span class="param-label">DECAY</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={decayA}
            oninput={onDecayInput}
            class="decay-slider nodrag"
            data-testid="twotracks-decay"
          />
          <span class="param-val">{Math.round(decayA * 100)}%</span>
        </div>

        <!-- Rate row -->
        <div class="rate-row">
          <span class="param-label">RATE</span>
          <input
            type="range"
            min="-3"
            max="3"
            step="0.01"
            value={rateA}
            oninput={(e) => setNodeParam(id, 'rate_a', parseFloat((e.target as HTMLInputElement).value))}
            class="rate-slider nodrag"
          />
          <span class="param-val">{rateA >= 0 ? '+' : ''}{rateA.toFixed(2)}×</span>
        </div>

        <!-- Save button -->
        <div class="save-row">
          <button
            type="button"
            class="save-btn"
            disabled={!tapeABuf || tapeABuf.bufLen === 0}
            onclick={onSave}
            data-testid="twotracks-save"
            aria-label="Save tape as WAV"
          >SAVE TAPE</button>
          {#if tapeABuf && tapeABuf.bufLen > 0}
            <span class="tape-info">{(tapeABuf.bufLen / 48000).toFixed(1)}s</span>
          {:else}
            <span class="tape-info dim">no tape</span>
          {/if}
        </div>

      </div><!-- /reel-block -->

    </div>
  </PatchPanel>
</div>

<style>
  .twotracks-card {
    width: 320px;
    min-height: 320px;
  }
  .twotracks-card .subtitle {
    font-size: 0.52rem;
    color: var(--text-dim, #8b94a5);
    text-align: center;
    letter-spacing: 0.08em;
    margin-top: 2px;
  }
  .twotracks-card .body {
    margin-top: 10px;
    padding: 0 12px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .twotracks-card .reel-block {
    display: flex;
    flex-direction: column;
    gap: 8px;
    border: 1px solid #2a2f3a;
    border-radius: 3px;
    padding: 8px;
  }
  /* ---------- LEDs ---------- */
  .twotracks-card .leds-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .twotracks-card .led-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
  }
  .twotracks-card .led {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #1e2430;
    border: 1px solid #3a4050;
    transition: background 80ms, box-shadow 80ms;
  }
  .twotracks-card .led.active {
    background: rgb(255, 220, 60);
    border-color: rgb(255, 240, 100);
    box-shadow: 0 0 5px 1px rgba(255, 220, 60, 0.5);
  }
  .twotracks-card .led.led-rec-color.active {
    background: rgb(255, 70, 60);
    border-color: rgb(255, 120, 100);
    box-shadow: 0 0 5px 1px rgba(255, 70, 60, 0.5);
  }
  .twotracks-card .led.led-play-color.active {
    background: rgb(60, 220, 100);
    border-color: rgb(100, 240, 140);
    box-shadow: 0 0 5px 1px rgba(60, 220, 100, 0.5);
  }
  .twotracks-card .led.led-ovdb-color.active {
    background: rgb(80, 160, 255);
    border-color: rgb(120, 200, 255);
    box-shadow: 0 0 5px 1px rgba(80, 160, 255, 0.5);
  }
  .twotracks-card .led-label {
    font-size: 0.45rem;
    color: var(--text-dim, #8b94a5);
    letter-spacing: 0.06em;
    font-family: ui-monospace, monospace;
  }
  /* ---------- mode + overdub buttons ---------- */
  .twotracks-card .mode-btn,
  .twotracks-card .overdub-btn {
    background: #1a1f2a;
    color: var(--text-dim, #8b94a5);
    border: 1px solid #404652;
    border-radius: 2px;
    padding: 3px 8px;
    font-size: 0.55rem;
    cursor: pointer;
    letter-spacing: 0.07em;
    font-family: ui-monospace, monospace;
    white-space: nowrap;
  }
  .twotracks-card .mode-btn:hover,
  .twotracks-card .overdub-btn:hover {
    border-color: #6a7282;
  }
  .twotracks-card .mode-btn.loop {
    color: rgb(80, 200, 220);
    border-color: rgb(80, 160, 220);
  }
  .twotracks-card .overdub-btn.active {
    color: rgb(80, 160, 255);
    border-color: rgb(80, 140, 255);
    background: #111a2a;
  }
  /* ---------- waveform canvas ---------- */
  .twotracks-card .waveform {
    display: block;
    width: 100%;
    height: 60px;
    background: #0a0c11;
    border: 1px solid #2a2f3a;
    border-radius: 2px;
    cursor: ew-resize;
  }
  /* ---------- decay / rate rows ---------- */
  .twotracks-card .decay-row,
  .twotracks-card .rate-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .twotracks-card .param-label {
    font-size: 0.5rem;
    color: var(--text-dim, #8b94a5);
    letter-spacing: 0.08em;
    font-family: ui-monospace, monospace;
    min-width: 36px;
  }
  .twotracks-card .decay-slider,
  .twotracks-card .rate-slider {
    flex: 1;
    height: 4px;
    accent-color: rgb(255, 140, 40);
    cursor: pointer;
  }
  .twotracks-card .param-val {
    font-size: 0.5rem;
    color: var(--text-dim, #8b94a5);
    font-family: ui-monospace, monospace;
    min-width: 36px;
    text-align: right;
  }
  /* ---------- save row ---------- */
  .twotracks-card .save-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .twotracks-card .save-btn {
    background: #1a1f2a;
    color: var(--text-dim, #8b94a5);
    border: 1px solid #404652;
    border-radius: 2px;
    padding: 5px 12px;
    font-size: 0.55rem;
    cursor: pointer;
    letter-spacing: 0.08em;
    font-family: ui-monospace, monospace;
  }
  .twotracks-card .save-btn:hover:not(:disabled) {
    color: rgb(80, 200, 220);
    border-color: rgb(80, 160, 220);
  }
  .twotracks-card .save-btn:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }
  .twotracks-card .tape-info {
    font-size: 0.5rem;
    color: var(--text-dim, #8b94a5);
    font-family: ui-monospace, monospace;
  }
  .twotracks-card .tape-info.dim {
    opacity: 0.5;
  }
</style>
