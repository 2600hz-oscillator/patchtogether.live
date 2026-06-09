<script lang="ts">
  // TwotracksCard — tape loop emulator card (Phase 4: live waveform + WAV export).
  //
  // Layout: horizontal — reel A (left) | center col (A/B + Lofi) | reel B (right)
  //
  // All param writes go through setNodeParam() — never direct node.params mutation.
  // Per-frame playhead scrub state kept LOCAL — NOT written to Y.Doc per frame.

  import type { NodeProps } from '@xyflow/svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { setNodeParam } from '$lib/graph/mutate';
  import { twotracksDef, type TwoTracksData, TWOTRACKS_MAX_SAMPLES, abGains } from '$lib/audio/modules/twotracks';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  const defaultFor = (k: string): number =>
    twotracksDef.params.find((p) => p.id === k)?.defaultValue ?? 0;

  // ─── Reel A synced params ───
  let rateA         = $derived(node?.params.rate_a         ?? defaultFor('rate_a'));
  let modeA         = $derived(node?.params.mode_a         ?? defaultFor('mode_a'));
  let decayA        = $derived(node?.params.decay_a        ?? defaultFor('decay_a'));
  let overdubFlagA  = $derived(node?.params.overdub_flag_a ?? defaultFor('overdub_flag_a'));
  let eqLowA        = $derived(node?.params.eqLow_a        ?? 0);
  let eqMidA        = $derived(node?.params.eqMid_a        ?? 0);
  let eqHighA       = $derived(node?.params.eqHigh_a       ?? 0);
  let filterModeA   = $derived(node?.params.filterMode_a   ?? 0);
  let cutoffA       = $derived(node?.params.cutoff_a       ?? 20000);
  let resoA         = $derived(node?.params.reso_a         ?? 0);

  // ─── Reel B synced params ───
  let rateB         = $derived(node?.params.rate_b         ?? defaultFor('rate_b'));
  let modeB         = $derived(node?.params.mode_b         ?? defaultFor('mode_b'));
  let decayB        = $derived(node?.params.decay_b        ?? defaultFor('decay_b'));
  let overdubFlagB  = $derived(node?.params.overdub_flag_b ?? defaultFor('overdub_flag_b'));
  let eqLowB        = $derived(node?.params.eqLow_b        ?? 0);
  let eqMidB        = $derived(node?.params.eqMid_b        ?? 0);
  let eqHighB       = $derived(node?.params.eqHigh_b       ?? 0);
  let filterModeB   = $derived(node?.params.filterMode_b   ?? 0);
  let cutoffB       = $derived(node?.params.cutoff_b       ?? 20000);
  let resoB         = $derived(node?.params.reso_b         ?? 0);

  // ─── Global A/B param ───
  let abParam = $derived(node?.params.ab ?? 0);

  // ─── Global Lofi param ───
  let lofiParam = $derived(node?.params.lofi ?? 0);
  const LOFI_LABELS = ['OFF', 'LOW', 'HIGH', 'ERROR'] as const;

  // ─── Worklet data ───
  let transportStateA = $derived.by(() => {
    const d = node?.data as TwoTracksData | undefined;
    return d?.transportState_a ?? 'idle';
  });
  let transportStateB = $derived.by(() => {
    const d = node?.data as TwoTracksData | undefined;
    return d?.transportState_b ?? 'idle';
  });
  let syncedPlayheadA = $derived.by(() => {
    const d = node?.data as TwoTracksData | undefined;
    return d?.playhead_a ?? 0;
  });
  let syncedPlayheadB = $derived.by(() => {
    const d = node?.data as TwoTracksData | undefined;
    return d?.playhead_b ?? 0;
  });
  // Peaks are local volatile state — polled via eng.read() like SCOPE snapshots,
  // NOT stored in node.data/Y.Doc (Float32Array can't be Y.Doc-encoded).
  let peaksA = $state<Float32Array | null>(null);
  let peaksB = $state<Float32Array | null>(null);
  let rafPeaks: number | null = null;
  $effect(() => {
    function poll() {
      const eng = engineCtx.get();
      if (eng && node) {
        const pA = eng.read(node, 'peaksA') as Float32Array | null;
        const pB = eng.read(node, 'peaksB') as Float32Array | null;
        if (pA !== peaksA) peaksA = pA;
        if (pB !== peaksB) peaksB = pB;
      }
      rafPeaks = requestAnimationFrame(poll);
    }
    rafPeaks = requestAnimationFrame(poll);
    return () => { if (rafPeaks !== null) cancelAnimationFrame(rafPeaks); rafPeaks = null; };
  });

  let bufLenA = $derived.by(() => {
    const d = node?.data as TwoTracksData | undefined;
    return d?.bufLenA ?? 0;
  });
  let bufLenB = $derived.by(() => {
    const d = node?.data as TwoTracksData | undefined;
    return d?.bufLenB ?? 0;
  });

  // ─── Derived LEDs reel A ───
  let ledArmA     = $derived(transportStateA === 'armed');
  let ledRecA     = $derived(transportStateA === 'rec' || transportStateA === 'overdub');
  let ledPlayA    = $derived(transportStateA === 'play' || transportStateA === 'rec' || transportStateA === 'overdub');
  let ledOverdubA = $derived(transportStateA === 'overdub');

  // ─── Derived LEDs reel B ───
  let ledArmB     = $derived(transportStateB === 'armed');
  let ledRecB     = $derived(transportStateB === 'rec' || transportStateB === 'overdub');
  let ledPlayB    = $derived(transportStateB === 'play' || transportStateB === 'rec' || transportStateB === 'overdub');
  let ledOverdubB = $derived(transportStateB === 'overdub');

  // ─── Mode / overdub toggles ───
  let isLoopA     = $derived(Math.round(modeA) === 1);
  let isLoopB     = $derived(Math.round(modeB) === 1);
  let overdubActA = $derived(Math.round(overdubFlagA) === 1);
  let overdubActB = $derived(Math.round(overdubFlagB) === 1);

  // ─── A/B gain display ───
  let gains = $derived(abGains(abParam));

  // ─── Canvas + scrub state (local) ───
  let canvasElA: HTMLCanvasElement | null = $state(null);
  let canvasElB: HTMLCanvasElement | null = $state(null);
  let scrubbingA = $state(false);
  let scrubbingB = $state(false);
  let localPlayheadA = $state(0);
  let localPlayheadB = $state(0);

  // Scrub velocity tracking (local — NOT written to Y.Doc per frame)
  let pointerPrevXA = 0;
  let pointerPrevXB = 0;

  let displayPlayheadA = $derived(scrubbingA ? localPlayheadA : syncedPlayheadA);
  let displayPlayheadB = $derived(scrubbingB ? localPlayheadB : syncedPlayheadB);

  // ─── Filter mode labels ───
  const FILTER_MODES = ['OFF', 'HP', 'LP', 'BP'] as const;

  const inputs: PortDescriptor[] = [
    { id: 'audio_l_in_a', label: 'L IN A',    cable: 'audio' },
    { id: 'audio_r_in_a', label: 'R IN A',    cable: 'audio' },
    { id: 'rec_start_a',  label: 'REC START A', cable: 'gate' },
    { id: 'rec_arm_a',    label: 'REC ARM A', cable: 'gate' },
    { id: 'overdub_a',    label: 'OVERDUB A', cable: 'gate' },
    { id: 'audio_l_in_b', label: 'L IN B',    cable: 'audio' },
    { id: 'audio_r_in_b', label: 'R IN B',    cable: 'audio' },
    { id: 'rec_start_b',  label: 'REC START B', cable: 'gate' },
    { id: 'rec_arm_b',    label: 'REC ARM B', cable: 'gate' },
    { id: 'overdub_b',    label: 'OVERDUB B', cable: 'gate' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'out_l', label: 'OUT L', cable: 'audio' },
    { id: 'out_r', label: 'OUT R', cable: 'audio' },
  ];

  // ─── Helpers ───

  function posPxToNorm(x: number, canvas: HTMLCanvasElement | null): number {
    if (!canvas) return 0;
    return Math.max(0, Math.min(1, x / canvas.width));
  }

  function sendSeek(reel: 'a' | 'b', pos: number): void {
    const eng = engineCtx.get();
    if (eng && node) {
      try {
        const port = eng.read(node, 'workletPort') as MessagePort | undefined;
        if (port) port.postMessage({ type: 'seek', reel, pos });
      } catch { /* engine may not be ready */ }
    }
  }

  function requestDumpTape(reel: 'a' | 'b'): void {
    const eng = engineCtx.get();
    if (eng && node) {
      try {
        const port = eng.read(node, 'workletPort') as MessagePort | undefined;
        if (port) port.postMessage({ type: 'dump-tape', reel });
      } catch { /* engine may not be ready */ }
    }
  }

  function sendScrubVelocity(reel: 'a' | 'b', velocity: number): void {
    const eng = engineCtx.get();
    if (eng && node) {
      try {
        eng.setParam(node, reel === 'a' ? 'scrubVelocity_a' : 'scrubVelocity_b', velocity);
      } catch { /* engine may not be ready */ }
    }
  }

  // ─── Reel A handlers ───

  function toggleModeA() { setNodeParam(id, 'mode_a', Math.round(modeA) === 1 ? 0 : 1); }
  function toggleOverdubA() { setNodeParam(id, 'overdub_flag_a', Math.round(overdubFlagA) === 1 ? 0 : 1); }

  function cycleFilterA() {
    setNodeParam(id, 'filterMode_a', (Math.round(filterModeA) + 1) % 4);
  }

  function onCanvasPointerDownA(e: PointerEvent) {
    e.stopPropagation();
    if (!canvasElA) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    scrubbingA = true;
    pointerPrevXA = e.offsetX;
    localPlayheadA = posPxToNorm(e.offsetX, canvasElA);
  }
  function onCanvasPointerMoveA(e: PointerEvent) {
    e.stopPropagation();
    if (!scrubbingA) return;
    localPlayheadA = posPxToNorm(e.offsetX, canvasElA);
    const blockWidthPx = canvasElA ? canvasElA.width : 220;
    const velocity = Math.abs(e.offsetX - pointerPrevXA) / blockWidthPx * 50;
    pointerPrevXA = e.offsetX;
    sendScrubVelocity('a', Math.min(10, velocity));
  }
  function onCanvasPointerUpA(e: PointerEvent) {
    e.stopPropagation();
    if (!scrubbingA) return;
    scrubbingA = false;
    const pos = posPxToNorm(e.offsetX, canvasElA);
    localPlayheadA = pos;
    sendSeek('a', pos);
    sendScrubVelocity('a', 0);
  }

  // ─── Reel B handlers ───

  function toggleModeB() { setNodeParam(id, 'mode_b', Math.round(modeB) === 1 ? 0 : 1); }
  function toggleOverdubB() { setNodeParam(id, 'overdub_flag_b', Math.round(overdubFlagB) === 1 ? 0 : 1); }

  function cycleFilterB() {
    setNodeParam(id, 'filterMode_b', (Math.round(filterModeB) + 1) % 4);
  }

  function onCanvasPointerDownB(e: PointerEvent) {
    e.stopPropagation();
    if (!canvasElB) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    scrubbingB = true;
    pointerPrevXB = e.offsetX;
    localPlayheadB = posPxToNorm(e.offsetX, canvasElB);
  }
  function onCanvasPointerMoveB(e: PointerEvent) {
    e.stopPropagation();
    if (!scrubbingB) return;
    localPlayheadB = posPxToNorm(e.offsetX, canvasElB);
    const blockWidthPx = canvasElB ? canvasElB.width : 220;
    const velocity = Math.abs(e.offsetX - pointerPrevXB) / blockWidthPx * 50;
    pointerPrevXB = e.offsetX;
    sendScrubVelocity('b', Math.min(10, velocity));
  }
  function onCanvasPointerUpB(e: PointerEvent) {
    e.stopPropagation();
    if (!scrubbingB) return;
    scrubbingB = false;
    const pos = posPxToNorm(e.offsetX, canvasElB);
    localPlayheadB = pos;
    sendSeek('b', pos);
    sendScrubVelocity('b', 0);
  }

  // ─── Waveform draw helper ───

  function drawWaveform(
    canvasEl: HTMLCanvasElement | null,
    peaks: Float32Array | null,
    bufLen: number,
    displayPlayhead: number,
  ): void {
    if (!canvasEl) return;
    const ctx2d = canvasEl.getContext('2d');
    if (!ctx2d) return;
    const w = canvasEl.width;
    const h = canvasEl.height;
    ctx2d.clearRect(0, 0, w, h);
    ctx2d.fillStyle = '#0a0c11';
    ctx2d.fillRect(0, 0, w, h);

    if (!peaks || bufLen === 0) {
      ctx2d.fillStyle = '#5a6275';
      ctx2d.font = '9px ui-monospace, monospace';
      ctx2d.textAlign = 'center';
      ctx2d.fillText('NO TAPE', w / 2, h / 2);
    } else {
      const pts = peaks.length;
      ctx2d.strokeStyle = 'rgb(255, 140, 40)';
      ctx2d.lineWidth = 1;
      ctx2d.beginPath();
      for (let x = 0; x < w; x++) {
        const pi = Math.floor((x / w) * pts);
        const peak = peaks[pi] ?? 0;
        const y0 = (0.5 - peak * 0.5) * h;
        const y1 = (0.5 + peak * 0.5) * h;
        ctx2d.moveTo(x + 0.5, y0);
        ctx2d.lineTo(x + 0.5, y1);
      }
      ctx2d.stroke();
    }

    const px = Math.round(displayPlayhead * w);
    ctx2d.strokeStyle = 'rgba(80, 160, 255, 0.85)';
    ctx2d.lineWidth = 1.5;
    ctx2d.beginPath();
    ctx2d.moveTo(px + 0.5, 0);
    ctx2d.lineTo(px + 0.5, h);
    ctx2d.stroke();
  }

  // Reactive waveform draws
  $effect(() => {
    void peaksA; void bufLenA; void displayPlayheadA;
    drawWaveform(canvasElA, peaksA, bufLenA, displayPlayheadA);
  });
  $effect(() => {
    void peaksB; void bufLenB; void displayPlayheadB;
    drawWaveform(canvasElB, peaksB, bufLenB, displayPlayheadB);
  });
</script>

<div class="mod-card twotracks-card" data-testid="twotracks-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="TWOTRACKS" />
  <div class="subtitle">TAPE LOOP · 2 REELS · EQ · FILTER · A/B MIX</div>

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="body">

      <!-- ════════════ REEL A ════════════ -->
      <div class="reel-block reel-a" data-testid="twotracks-reel-a">
        <div class="reel-header">REEL A</div>

        <!-- Transport LEDs + mode/overdub toggles -->
        <div class="leds-row">
          <div class="led-item">
            <div class="led" class:active={ledArmA} data-testid="led-arm"></div>
            <span class="led-label">ARM</span>
          </div>
          <div class="led-item">
            <div class="led led-rec-color" class:active={ledRecA} data-testid="led-rec"></div>
            <span class="led-label">REC</span>
          </div>
          <div class="led-item">
            <div class="led led-play-color" class:active={ledPlayA} data-testid="led-play"></div>
            <span class="led-label">PLAY</span>
          </div>
          <div class="led-item">
            <div class="led led-ovdb-color" class:active={ledOverdubA} data-testid="led-overdub"></div>
            <span class="led-label">OVDB</span>
          </div>
          <button type="button" class="mode-btn nodrag" class:loop={isLoopA}
            onclick={toggleModeA} data-testid="twotracks-mode-toggle"
            aria-label="Toggle tape / loop tape A">{isLoopA ? 'loop tape' : 'tape'}</button>
          <button type="button" class="overdub-btn nodrag" class:active={overdubActA}
            onclick={toggleOverdubA} data-testid="twotracks-overdub-toggle"
            aria-label="Toggle overdub A">OVERDUB</button>
        </div>

        <!-- Waveform canvas -->
        <canvas bind:this={canvasElA} width="220" height="60" class="waveform nodrag"
          data-testid="twotracks-waveform"
          onpointerdown={onCanvasPointerDownA}
          onpointermove={onCanvasPointerMoveA}
          onpointerup={onCanvasPointerUpA}></canvas>

        <!-- 3-band EQ -->
        <div class="eq-row" data-testid="twotracks-eq-a">
          <span class="section-label">EQ</span>
          <div class="eq-knobs">
            <div class="knob-group">
              <span class="knob-label">LOW</span>
              <input type="range" min="-12" max="12" step="0.1" value={eqLowA}
                oninput={(e) => setNodeParam(id, 'eqLow_a', parseFloat((e.target as HTMLInputElement).value))}
                class="eq-slider nodrag" />
              <span class="knob-val">{eqLowA >= 0 ? '+' : ''}{eqLowA.toFixed(1)}</span>
            </div>
            <div class="knob-group">
              <span class="knob-label">MID</span>
              <input type="range" min="-12" max="12" step="0.1" value={eqMidA}
                oninput={(e) => setNodeParam(id, 'eqMid_a', parseFloat((e.target as HTMLInputElement).value))}
                class="eq-slider nodrag" />
              <span class="knob-val">{eqMidA >= 0 ? '+' : ''}{eqMidA.toFixed(1)}</span>
            </div>
            <div class="knob-group">
              <span class="knob-label">HIGH</span>
              <input type="range" min="-12" max="12" step="0.1" value={eqHighA}
                oninput={(e) => setNodeParam(id, 'eqHigh_a', parseFloat((e.target as HTMLInputElement).value))}
                class="eq-slider nodrag" />
              <span class="knob-val">{eqHighA >= 0 ? '+' : ''}{eqHighA.toFixed(1)}</span>
            </div>
          </div>
        </div>

        <!-- Filter row -->
        <div class="filter-row" data-testid="twotracks-filter-a">
          <button type="button" class="filter-mode-btn nodrag" onclick={cycleFilterA}
            aria-label="Cycle filter mode A">
            {FILTER_MODES[Math.round(filterModeA) % 4]}
          </button>
          <span class="param-label">CUT</span>
          <input type="range" min="20" max="20000" step="1" value={cutoffA}
            oninput={(e) => setNodeParam(id, 'cutoff_a', parseFloat((e.target as HTMLInputElement).value))}
            class="filter-slider nodrag" />
          <span class="param-label">RES</span>
          <input type="range" min="0" max="1" step="0.01" value={resoA}
            oninput={(e) => setNodeParam(id, 'reso_a', parseFloat((e.target as HTMLInputElement).value))}
            class="filter-slider nodrag" style="max-width:40px;" />
        </div>

        <!-- Decay row -->
        <div class="decay-row">
          <span class="param-label">DECAY</span>
          <input type="range" min="0" max="1" step="0.01" value={decayA}
            oninput={(e) => setNodeParam(id, 'decay_a', parseFloat((e.target as HTMLInputElement).value))}
            class="decay-slider nodrag" data-testid="twotracks-decay" />
          <span class="param-val">{Math.round(decayA * 100)}%</span>
        </div>

        <!-- Rate row -->
        <div class="rate-row">
          <span class="param-label">RATE</span>
          <input type="range" min="-3" max="3" step="0.01" value={rateA}
            oninput={(e) => setNodeParam(id, 'rate_a', parseFloat((e.target as HTMLInputElement).value))}
            class="rate-slider nodrag" />
          <span class="param-val">{rateA >= 0 ? '+' : ''}{rateA.toFixed(2)}×</span>
        </div>

        <!-- Save row -->
        <div class="save-row">
          <button type="button" class="save-btn nodrag"
            disabled={bufLenA === 0}
            onclick={() => requestDumpTape('a')}
            data-testid="twotracks-save" aria-label="Save reel A tape as WAV">SAVE TAPE</button>
          {#if bufLenA > 0}
            <span class="tape-info">{(bufLenA / 48000).toFixed(1)}s</span>
          {:else}
            <span class="tape-info dim">no tape</span>
          {/if}
        </div>
      </div><!-- /reel A -->

      <!-- ════════════ CENTER COLUMN ════════════ -->
      <div class="center-col">

        <!-- A/B crossfade strip -->
        <div class="ab-strip" data-testid="twotracks-ab-knob">
          <span class="ab-label">A</span>
          <div class="ab-knob-wrap">
            <input type="range" min="0" max="1" step="0.01" value={abParam}
              oninput={(e) => setNodeParam(id, 'ab', parseFloat((e.target as HTMLInputElement).value))}
              class="ab-slider nodrag" aria-label="A/B crossfade" />
            <span class="ab-pct">A:{Math.round(gains.gainA * 100)}%</span>
            <span class="ab-pct">B:{Math.round(gains.gainB * 100)}%</span>
          </div>
          <span class="ab-label">B</span>
        </div>

        <!-- Lofi strip -->
        <div class="lofi-strip" data-testid="twotracks-lofi">
          <span class="strip-label">LOFI</span>
          <div class="lofi-btns">
            {#each LOFI_LABELS as label, i}
              <button
                type="button"
                class="lofi-btn nodrag"
                class:active={Math.round(lofiParam) === i}
                class:error={i === 3 && Math.round(lofiParam) === 3}
                onclick={() => setNodeParam(id, 'lofi', i)}
                aria-label="Lofi mode {label}"
              >{label}</button>
            {/each}
          </div>
        </div>

      </div><!-- /center-col -->

      <!-- ════════════ REEL B ════════════ -->
      <div class="reel-block reel-b" data-testid="twotracks-reel-b">
        <div class="reel-header">REEL B</div>

        <!-- Transport LEDs + mode/overdub toggles -->
        <div class="leds-row">
          <div class="led-item">
            <div class="led" class:active={ledArmB} data-testid="led-arm-b"></div>
            <span class="led-label">ARM</span>
          </div>
          <div class="led-item">
            <div class="led led-rec-color" class:active={ledRecB} data-testid="led-rec-b"></div>
            <span class="led-label">REC</span>
          </div>
          <div class="led-item">
            <div class="led led-play-color" class:active={ledPlayB} data-testid="led-play-b"></div>
            <span class="led-label">PLAY</span>
          </div>
          <div class="led-item">
            <div class="led led-ovdb-color" class:active={ledOverdubB} data-testid="led-overdub-b"></div>
            <span class="led-label">OVDB</span>
          </div>
          <button type="button" class="mode-btn nodrag" class:loop={isLoopB}
            onclick={toggleModeB} data-testid="twotracks-mode-toggle-b"
            aria-label="Toggle tape / loop tape B">{isLoopB ? 'loop tape' : 'tape'}</button>
          <button type="button" class="overdub-btn nodrag" class:active={overdubActB}
            onclick={toggleOverdubB} data-testid="twotracks-overdub-toggle-b"
            aria-label="Toggle overdub B">OVERDUB</button>
        </div>

        <!-- Waveform canvas reel B -->
        <canvas bind:this={canvasElB} width="220" height="60" class="waveform nodrag"
          data-testid="twotracks-waveform-b"
          onpointerdown={onCanvasPointerDownB}
          onpointermove={onCanvasPointerMoveB}
          onpointerup={onCanvasPointerUpB}></canvas>

        <!-- 3-band EQ reel B -->
        <div class="eq-row" data-testid="twotracks-eq-b">
          <span class="section-label">EQ</span>
          <div class="eq-knobs">
            <div class="knob-group">
              <span class="knob-label">LOW</span>
              <input type="range" min="-12" max="12" step="0.1" value={eqLowB}
                oninput={(e) => setNodeParam(id, 'eqLow_b', parseFloat((e.target as HTMLInputElement).value))}
                class="eq-slider nodrag" />
              <span class="knob-val">{eqLowB >= 0 ? '+' : ''}{eqLowB.toFixed(1)}</span>
            </div>
            <div class="knob-group">
              <span class="knob-label">MID</span>
              <input type="range" min="-12" max="12" step="0.1" value={eqMidB}
                oninput={(e) => setNodeParam(id, 'eqMid_b', parseFloat((e.target as HTMLInputElement).value))}
                class="eq-slider nodrag" />
              <span class="knob-val">{eqMidB >= 0 ? '+' : ''}{eqMidB.toFixed(1)}</span>
            </div>
            <div class="knob-group">
              <span class="knob-label">HIGH</span>
              <input type="range" min="-12" max="12" step="0.1" value={eqHighB}
                oninput={(e) => setNodeParam(id, 'eqHigh_b', parseFloat((e.target as HTMLInputElement).value))}
                class="eq-slider nodrag" />
              <span class="knob-val">{eqHighB >= 0 ? '+' : ''}{eqHighB.toFixed(1)}</span>
            </div>
          </div>
        </div>

        <!-- Filter row reel B -->
        <div class="filter-row" data-testid="twotracks-filter-b">
          <button type="button" class="filter-mode-btn nodrag" onclick={cycleFilterB}
            aria-label="Cycle filter mode B">
            {FILTER_MODES[Math.round(filterModeB) % 4]}
          </button>
          <span class="param-label">CUT</span>
          <input type="range" min="20" max="20000" step="1" value={cutoffB}
            oninput={(e) => setNodeParam(id, 'cutoff_b', parseFloat((e.target as HTMLInputElement).value))}
            class="filter-slider nodrag" />
          <span class="param-label">RES</span>
          <input type="range" min="0" max="1" step="0.01" value={resoB}
            oninput={(e) => setNodeParam(id, 'reso_b', parseFloat((e.target as HTMLInputElement).value))}
            class="filter-slider nodrag" style="max-width:40px;" />
        </div>

        <!-- Decay row reel B -->
        <div class="decay-row">
          <span class="param-label">DECAY</span>
          <input type="range" min="0" max="1" step="0.01" value={decayB}
            oninput={(e) => setNodeParam(id, 'decay_b', parseFloat((e.target as HTMLInputElement).value))}
            class="decay-slider nodrag" data-testid="twotracks-decay-b" />
          <span class="param-val">{Math.round(decayB * 100)}%</span>
        </div>

        <!-- Rate row reel B -->
        <div class="rate-row">
          <span class="param-label">RATE</span>
          <input type="range" min="-3" max="3" step="0.01" value={rateB}
            oninput={(e) => setNodeParam(id, 'rate_b', parseFloat((e.target as HTMLInputElement).value))}
            class="rate-slider nodrag" />
          <span class="param-val">{rateB >= 0 ? '+' : ''}{rateB.toFixed(2)}×</span>
        </div>

        <!-- Save row reel B -->
        <div class="save-row">
          <button type="button" class="save-btn nodrag"
            disabled={bufLenB === 0}
            onclick={() => requestDumpTape('b')}
            data-testid="twotracks-save-b" aria-label="Save reel B tape as WAV">SAVE TAPE</button>
          {#if bufLenB > 0}
            <span class="tape-info">{(bufLenB / 48000).toFixed(1)}s</span>
          {:else}
            <span class="tape-info dim">no tape</span>
          {/if}
        </div>
      </div><!-- /reel B -->

    </div>
  </PatchPanel>
</div>

<style>
  .twotracks-card {
    width: 580px;
  }
  .twotracks-card .subtitle {
    font-size: 0.50rem;
    color: var(--text-dim, #8b94a5);
    text-align: center;
    letter-spacing: 0.07em;
    margin-top: 2px;
  }
  .twotracks-card .body {
    margin-top: 8px;
    padding: 0 10px 10px;
    display: flex;
    flex-direction: row;
    align-items: stretch;
    gap: 6px;
  }

  /* ─── Reel blocks ─── */
  .twotracks-card .reel-block {
    flex: 1 1 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
    border: 1px solid #2a2f3a;
    border-radius: 3px;
    padding: 7px;
  }

  /* ─── Center column (A/B + Lofi) ─── */
  .twotracks-card .center-col {
    flex: 0 0 90px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    justify-content: center;
  }
  .twotracks-card .reel-a {
    border-color: #3a4254;
  }
  .twotracks-card .reel-b {
    border-color: #3a4254;
  }
  .twotracks-card .reel-header {
    font-size: 0.50rem;
    color: rgba(255, 140, 40, 0.8);
    letter-spacing: 0.12em;
    font-family: ui-monospace, monospace;
    font-weight: bold;
  }

  /* ─── LEDs ─── */
  .twotracks-card .leds-row {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .twotracks-card .led-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
  }
  .twotracks-card .led {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #1e2430;
    border: 1px solid #3a4050;
    transition: background 80ms, box-shadow 80ms;
  }
  .twotracks-card .led.active {
    background: rgb(255, 220, 60);
    border-color: rgb(255, 240, 100);
    box-shadow: 0 0 4px 1px rgba(255, 220, 60, 0.5);
  }
  .twotracks-card .led.led-rec-color.active {
    background: rgb(255, 70, 60);
    border-color: rgb(255, 120, 100);
    box-shadow: 0 0 4px 1px rgba(255, 70, 60, 0.5);
  }
  .twotracks-card .led.led-play-color.active {
    background: rgb(60, 220, 100);
    border-color: rgb(100, 240, 140);
    box-shadow: 0 0 4px 1px rgba(60, 220, 100, 0.5);
  }
  .twotracks-card .led.led-ovdb-color.active {
    background: rgb(80, 160, 255);
    border-color: rgb(120, 200, 255);
    box-shadow: 0 0 4px 1px rgba(80, 160, 255, 0.5);
  }
  .twotracks-card .led-label {
    font-size: 0.42rem;
    color: var(--text-dim, #8b94a5);
    letter-spacing: 0.05em;
    font-family: ui-monospace, monospace;
  }

  /* ─── Mode + overdub buttons ─── */
  .twotracks-card .mode-btn,
  .twotracks-card .overdub-btn {
    background: #1a1f2a;
    color: var(--text-dim, #8b94a5);
    border: 1px solid #404652;
    border-radius: 2px;
    padding: 2px 6px;
    font-size: 0.50rem;
    cursor: pointer;
    letter-spacing: 0.06em;
    font-family: ui-monospace, monospace;
    white-space: nowrap;
  }
  .twotracks-card .mode-btn.loop { color: rgb(80, 200, 220); border-color: rgb(80, 160, 220); }
  .twotracks-card .overdub-btn.active { color: rgb(80, 160, 255); border-color: rgb(80, 140, 255); background: #111a2a; }

  /* ─── Waveform canvas ─── */
  .twotracks-card .waveform {
    display: block;
    width: 100%;
    height: 56px;
    background: #0a0c11;
    border: 1px solid #2a2f3a;
    border-radius: 2px;
    cursor: ew-resize;
  }

  /* ─── EQ row ─── */
  .twotracks-card .eq-row {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .twotracks-card .section-label {
    font-size: 0.45rem;
    color: var(--text-dim, #8b94a5);
    letter-spacing: 0.10em;
    font-family: ui-monospace, monospace;
    min-width: 16px;
  }
  .twotracks-card .eq-knobs {
    display: flex;
    gap: 4px;
    flex: 1;
  }
  .twotracks-card .knob-group {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1px;
    flex: 1;
  }
  .twotracks-card .knob-label {
    font-size: 0.40rem;
    color: var(--text-dim, #8b94a5);
    font-family: ui-monospace, monospace;
    letter-spacing: 0.05em;
  }
  .twotracks-card .knob-val {
    font-size: 0.38rem;
    color: var(--text-dim, #8b94a5);
    font-family: ui-monospace, monospace;
    min-width: 30px;
    text-align: center;
  }
  .twotracks-card .eq-slider {
    width: 100%;
    height: 4px;
    accent-color: rgb(100, 200, 160);
    cursor: pointer;
  }

  /* ─── Filter row ─── */
  .twotracks-card .filter-row {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .twotracks-card .filter-mode-btn {
    background: #1a1f2a;
    color: rgb(200, 180, 100);
    border: 1px solid #504030;
    border-radius: 2px;
    padding: 2px 5px;
    font-size: 0.48rem;
    cursor: pointer;
    letter-spacing: 0.06em;
    font-family: ui-monospace, monospace;
    min-width: 24px;
    text-align: center;
  }
  .twotracks-card .filter-slider {
    flex: 1;
    height: 4px;
    accent-color: rgb(200, 160, 100);
    cursor: pointer;
  }

  /* ─── Decay / rate rows ─── */
  .twotracks-card .decay-row,
  .twotracks-card .rate-row {
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .twotracks-card .param-label {
    font-size: 0.46rem;
    color: var(--text-dim, #8b94a5);
    letter-spacing: 0.07em;
    font-family: ui-monospace, monospace;
    min-width: 30px;
  }
  .twotracks-card .decay-slider,
  .twotracks-card .rate-slider {
    flex: 1;
    height: 4px;
    accent-color: rgb(255, 140, 40);
    cursor: pointer;
  }
  .twotracks-card .param-val {
    font-size: 0.46rem;
    color: var(--text-dim, #8b94a5);
    font-family: ui-monospace, monospace;
    min-width: 34px;
    text-align: right;
  }

  /* ─── Save row ─── */
  .twotracks-card .save-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .twotracks-card .save-btn {
    background: #1a1f2a;
    color: var(--text-dim, #8b94a5);
    border: 1px solid #404652;
    border-radius: 2px;
    padding: 4px 10px;
    font-size: 0.50rem;
    cursor: pointer;
    letter-spacing: 0.07em;
    font-family: ui-monospace, monospace;
  }
  .twotracks-card .save-btn:hover:not(:disabled) { color: rgb(80, 200, 220); border-color: rgb(80, 160, 220); }
  .twotracks-card .save-btn:disabled { opacity: 0.35; cursor: not-allowed; }
  .twotracks-card .tape-info {
    font-size: 0.46rem;
    color: var(--text-dim, #8b94a5);
    font-family: ui-monospace, monospace;
  }
  .twotracks-card .tape-info.dim { opacity: 0.5; }

  /* ─── A/B center strip ─── */
  .twotracks-card .ab-strip {
    display: flex;
    align-items: center;
    gap: 6px;
    background: #111520;
    border: 1px solid #2a3045;
    border-radius: 3px;
    padding: 5px 8px;
  }
  .twotracks-card .ab-label {
    font-size: 0.55rem;
    color: rgb(200, 180, 255);
    font-family: ui-monospace, monospace;
    font-weight: bold;
    letter-spacing: 0.08em;
    min-width: 10px;
  }
  .twotracks-card .ab-knob-wrap {
    display: flex;
    flex-direction: column;
    align-items: center;
    flex: 1;
    gap: 2px;
  }
  .twotracks-card .ab-slider {
    width: 100%;
    height: 5px;
    accent-color: rgb(180, 140, 255);
    cursor: pointer;
  }
  .twotracks-card .ab-pct {
    font-size: 0.38rem;
    color: rgba(200, 180, 255, 0.7);
    font-family: ui-monospace, monospace;
    letter-spacing: 0.06em;
  }

  /* ─── Lofi strip ─── */
  .twotracks-card .lofi-strip {
    display: flex;
    align-items: center;
    gap: 6px;
    background: #100e18;
    border: 1px solid #2a2040;
    border-radius: 3px;
    padding: 5px 8px;
  }
  .twotracks-card .strip-label {
    font-size: 0.50rem;
    color: rgba(180, 150, 255, 0.8);
    font-family: ui-monospace, monospace;
    font-weight: bold;
    letter-spacing: 0.10em;
    min-width: 28px;
  }
  .twotracks-card .lofi-btns {
    display: flex;
    gap: 4px;
    flex: 1;
  }
  .twotracks-card .lofi-btn {
    flex: 1;
    background: #1a1525;
    color: var(--text-dim, #8b94a5);
    border: 1px solid #3a304a;
    border-radius: 2px;
    padding: 3px 4px;
    font-size: 0.46rem;
    cursor: pointer;
    letter-spacing: 0.06em;
    font-family: ui-monospace, monospace;
    text-align: center;
    transition: background 80ms, color 80ms, border-color 80ms;
  }
  .twotracks-card .lofi-btn.active {
    background: #251c3a;
    color: rgb(180, 140, 255);
    border-color: rgb(140, 100, 220);
  }
  .twotracks-card .lofi-btn.error {
    background: #2a1020;
    color: rgb(255, 80, 80);
    border-color: rgb(200, 60, 60);
    animation: lofi-error-pulse 1.2s ease-in-out infinite;
  }
  @keyframes lofi-error-pulse {
    0%, 100% { opacity: 1; }
    50%       { opacity: 0.65; }
  }
</style>
