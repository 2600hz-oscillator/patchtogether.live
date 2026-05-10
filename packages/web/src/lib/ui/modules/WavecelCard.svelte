<script lang="ts">
  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { wavecelDef, type WavecelData } from '$lib/audio/modules/wavecel';
  import {
    getFactoryTables,
    DEFAULT_FACTORY_TABLE_ID,
    framesToPlain,
    framesFromPlain,
  } from '$lib/audio/wavecel-factory-tables';
  import { parseE352Wav } from '$lib/audio/wavetable-parser';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  let tune   = $derived(node?.params.tune   ?? wavecelDef.params[0]!.defaultValue);
  let fine   = $derived(node?.params.fine   ?? wavecelDef.params[1]!.defaultValue);
  let morph  = $derived(node?.params.morph  ?? wavecelDef.params[2]!.defaultValue);
  let spread = $derived(node?.params.spread ?? wavecelDef.params[3]!.defaultValue);
  let fold   = $derived(node?.params.fold   ?? wavecelDef.params[4]!.defaultValue);

  const set = (k: string) => (v: number) => { const t = patch.nodes[id]; if (t) t.params[k] = v; };
  const live = (k: string) => () => {
    const e = engineCtx.get(); if (!e || !node) return undefined;
    return e.readParam(node, k);
  };

  const inputs: PortDescriptor[] = [
    { id: 'pitch',     cable: 'pitch' },
    { id: 'fm',        cable: 'audio' },
    { id: 'morph_cv',  label: 'MORPH (CV)',  cable: 'cv' },
    { id: 'spread_cv', label: 'SPREAD (CV)', cable: 'cv' },
    { id: 'fold_cv',   label: 'FOLD (CV)',   cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'out_l', label: 'OUT L', cable: 'audio' },
    { id: 'out_r', label: 'OUT R', cable: 'audio' },
  ];

  // Visualizer state.
  let canvasEl: HTMLCanvasElement | null = $state(null);
  let raf: number | null = null;
  let vizMode = $state<'scope' | '3d'>('3d');

  // Wavetable source: factory id or 'user' (loaded from upload). Resolved
  // from node.data so the choice persists across page reloads + multiplayer.
  let wavetableSource = $derived.by(() => {
    const d = node?.data as WavecelData | undefined;
    return d?.wavetableSource ?? `factory:${DEFAULT_FACTORY_TABLE_ID}`;
  });
  let wavetableLabel = $derived.by(() => {
    const d = node?.data as WavecelData | undefined;
    if (d?.wavetableSource === 'user' && d.wavetableLabel) return d.wavetableLabel;
    const factories = getFactoryTables();
    const id = (d?.wavetableSource ?? `factory:${DEFAULT_FACTORY_TABLE_ID}`).slice('factory:'.length);
    return factories.find((t) => t.id === id)?.label ?? factories[0]!.label;
  });

  // Local Float32Array cache for drawing — derived from either the persisted
  // user upload (node.data.wavetableFrames) or the chosen factory table.
  let frames = $derived.by(() => {
    const d = node?.data as WavecelData | undefined;
    if (d?.wavetableSource === 'user' && Array.isArray(d.wavetableFrames)) {
      return framesFromPlain(d.wavetableFrames);
    }
    const factories = getFactoryTables();
    const idStr = (d?.wavetableSource ?? `factory:${DEFAULT_FACTORY_TABLE_ID}`).slice('factory:'.length);
    return (factories.find((t) => t.id === idStr) ?? factories[0]!).frames;
  });

  let uploadStatus = $state<string | null>(null);
  let uploadError = $state<string | null>(null);

  async function onWavFileChange(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    uploadError = null;
    uploadStatus = 'parsing...';
    try {
      const buf = await file.arrayBuffer();
      const parsed = parseE352Wav(buf);
      const target = patch.nodes[id];
      if (!target) return;
      if (!target.data) target.data = {};
      const d = target.data as WavecelData;
      d.wavetableSource = 'user';
      d.wavetableFrames = framesToPlain(parsed.frames);
      d.wavetableLabel = file.name.replace(/\.wav$/i, '').toUpperCase().slice(0, 24);
      uploadStatus = `loaded ${parsed.frames.length} frames @ ${parsed.sampleRate} Hz`;
      // The factory's poll loop picks up node.data changes within POLL_MS.
    } catch (err) {
      uploadError = err instanceof Error ? err.message : String(err);
      uploadStatus = null;
    } finally {
      try { input.value = ''; } catch { /* */ }
    }
  }

  function selectFactory(factoryId: string) {
    const t = patch.nodes[id];
    if (!t) return;
    if (!t.data) t.data = {};
    const d = t.data as WavecelData;
    d.wavetableSource = `factory:${factoryId}`;
    delete d.wavetableFrames;
    delete d.wavetableLabel;
    // The factory's poll loop picks up node.data changes within POLL_MS.
  }

  function toggleVizMode() {
    vizMode = vizMode === '3d' ? 'scope' : '3d';
  }

  // Visualizer render loop. Draws either:
  //  - 3D mode: orange polylines per frame, stacked back-to-front in
  //    perspective. Active frame (== morph * (FC-1)) highlighted in white.
  //  - Scope mode: single oscilloscope-style trace of the active frame.
  $effect(() => {
    if (!canvasEl) return;
    function tick() {
      if (!canvasEl) return;
      const ctx = canvasEl.getContext('2d');
      if (!ctx) {
        raf = requestAnimationFrame(tick);
        return;
      }
      const w = canvasEl.width;
      const h = canvasEl.height;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#0a0c11';
      ctx.fillRect(0, 0, w, h);

      const fs = frames;
      if (!fs || fs.length === 0) {
        raf = requestAnimationFrame(tick);
        return;
      }

      const eng = engineCtx.get();
      const liveMorph = (eng && node ? eng.readParam(node, 'morph') : undefined) ?? morph;
      const activeFrame = Math.round((liveMorph as number) * (fs.length - 1));

      if (vizMode === '3d') {
        draw3D(ctx, fs, w, h, activeFrame);
      } else {
        drawScope(ctx, fs, w, h, activeFrame);
      }
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => {
      if (raf !== null) cancelAnimationFrame(raf);
      raf = null;
    };
  });

  function draw3D(
    ctx: CanvasRenderingContext2D,
    fs: Float32Array[],
    w: number,
    h: number,
    activeFrame: number,
  ) {
    const FC = fs.length;
    const margin = 8;
    const drawW = w - margin * 2;
    const drawH = h - margin * 2;
    // Pseudo-perspective: frame 0 sits at the back (highest y, smallest
    // width); frame FC-1 sits at the front. Each successive frame is
    // shifted DOWN-RIGHT by (xStep, yStep) and drawn slightly wider.
    const backWidth = drawW * 0.55;
    const frontWidth = drawW * 0.95;
    const totalDepth = drawH * 0.7;
    const yBack = margin + drawH * 0.05;
    for (let f = 0; f < FC; f++) {
      const t = FC > 1 ? f / (FC - 1) : 0;
      const frameW = backWidth + (frontWidth - backWidth) * t;
      const frameY = yBack + totalDepth * t;
      const xLeft = margin + (drawW - frameW) / 2 + (drawW * 0.05) * (t - 0.5) * 2;
      const isActive = f === activeFrame;
      ctx.beginPath();
      const arr = fs[f]!;
      const N = arr.length;
      const sliceH = drawH * 0.16 * (0.6 + 0.4 * t);
      for (let s = 0; s < N; s++) {
        const x = xLeft + (s / (N - 1)) * frameW;
        const y = frameY - (arr[s]! ?? 0) * sliceH;
        if (s === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      if (isActive) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.6;
      } else {
        // Orange, dimmer toward the back for depth.
        const alpha = 0.25 + 0.6 * t;
        ctx.strokeStyle = `rgba(255,150,40,${alpha.toFixed(3)})`;
        ctx.lineWidth = 0.9;
      }
      ctx.stroke();
    }
  }

  function drawScope(
    ctx: CanvasRenderingContext2D,
    fs: Float32Array[],
    w: number,
    h: number,
    activeFrame: number,
  ) {
    const arr = fs[Math.max(0, Math.min(fs.length - 1, activeFrame))]!;
    const margin = 8;
    const drawW = w - margin * 2;
    const drawH = h - margin * 2;
    const midY = margin + drawH / 2;
    ctx.strokeStyle = '#1f242e';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(margin, midY);
    ctx.lineTo(margin + drawW, midY);
    ctx.stroke();
    ctx.beginPath();
    const N = arr.length;
    for (let s = 0; s < N; s++) {
      const x = margin + (s / (N - 1)) * drawW;
      const y = midY - arr[s]! * (drawH / 2) * 0.9;
      if (s === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = '#ff9628';
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }
</script>

<div class="mod-card wavecel-card" data-testid="wavecel-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <header class="title">WAVECEL</header>
  <div class="subtitle">STEREO WAVETABLE · MORPH · SPREAD · FOLD</div>

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="body">
      <div class="viz-row">
        <canvas bind:this={canvasEl} width="240" height="120" class="viz" data-testid="wavecel-viz"></canvas>
        <button
          type="button"
          class="viz-toggle"
          onclick={toggleVizMode}
          data-testid="wavecel-viz-toggle"
          aria-label="Toggle visualization"
        >{vizMode === '3d' ? '3D' : 'SCOPE'}</button>
      </div>

      <div class="wt-row">
        <select
          class="wt-select"
          value={wavetableSource}
          onchange={(e) => {
            const v = (e.target as HTMLSelectElement).value;
            if (v === 'user') return;
            const factoryId = v.startsWith('factory:') ? v.slice('factory:'.length) : v;
            selectFactory(factoryId);
          }}
          data-testid="wavecel-source-select"
        >
          {#each getFactoryTables() as t (t.id)}
            <option value={`factory:${t.id}`}>{t.label}</option>
          {/each}
          {#if wavetableSource === 'user'}
            <option value="user">USER · {wavetableLabel}</option>
          {/if}
        </select>
        <label class="upload-btn">
          <input
            type="file"
            accept=".wav,audio/wav"
            onchange={onWavFileChange}
            data-testid="wavecel-wav-input"
          />
          <span>Load WAV...</span>
        </label>
      </div>
      {#if uploadStatus}
        <div class="upload-status" data-testid="wavecel-upload-status">{uploadStatus}</div>
      {/if}
      {#if uploadError}
        <div class="upload-error" data-testid="wavecel-upload-error">{uploadError}</div>
      {/if}

      <div class="knob-row">
        <Knob value={tune}   min={-36} max={36}  defaultValue={0} label="Tune"  units="st" curve="linear" onchange={set('tune')}   readLive={live('tune')} />
        <Knob value={fine}   min={-100} max={100} defaultValue={0} label="Fine"  units="¢"  curve="linear" onchange={set('fine')}   readLive={live('fine')} />
        <Knob value={morph}  min={0}   max={1}   defaultValue={0} label="Morph"            curve="linear" onchange={set('morph')}  readLive={live('morph')} />
        <Knob value={spread} min={1}   max={5}   defaultValue={1} label="Sprd"             curve="linear" onchange={set('spread')} readLive={live('spread')} />
        <Knob value={fold}   min={0}   max={1}   defaultValue={0} label="Fold"             curve="linear" onchange={set('fold')}   readLive={live('fold')} />
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .wavecel-card {
    width: 320px;
    min-height: 360px;
  }
  .wavecel-card .subtitle {
    font-size: 0.55rem;
    color: var(--text-dim);
    text-align: center;
    letter-spacing: 0.08em;
    margin-top: 2px;
  }
  .wavecel-card .body {
    margin-top: 14px;
    padding: 0 14px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .wavecel-card .viz-row {
    position: relative;
  }
  .wavecel-card .viz {
    display: block;
    width: 100%;
    height: 120px;
    background: #0a0c11;
    border: 1px solid #2a2f3a;
    border-radius: 2px;
  }
  .wavecel-card .viz-toggle {
    position: absolute;
    top: 4px;
    right: 4px;
    background: rgba(20, 24, 32, 0.8);
    color: var(--text, #d8dde6);
    border: 1px solid #404652;
    border-radius: 2px;
    padding: 2px 8px;
    font-size: 0.55rem;
    cursor: pointer;
    letter-spacing: 0.08em;
    font-family: ui-monospace, monospace;
  }
  .wavecel-card .viz-toggle:hover {
    border-color: #6a7282;
  }
  .wavecel-card .wt-row {
    display: flex;
    gap: 6px;
    align-items: stretch;
  }
  .wavecel-card .wt-select {
    flex: 1;
    background: #1a1f2a;
    color: var(--text, #d8dde6);
    border: 1px solid #2a2f3a;
    border-radius: 2px;
    padding: 2px 6px;
    font-size: 0.65rem;
    font-family: ui-monospace, monospace;
  }
  .wavecel-card .upload-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: #1a1f2a;
    color: var(--text-dim);
    border: 1px dashed #404652;
    border-radius: 2px;
    padding: 2px 8px;
    font-size: 0.6rem;
    cursor: pointer;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  .wavecel-card .upload-btn input[type='file'] {
    display: none;
  }
  .wavecel-card .upload-btn:hover {
    color: var(--text, #d8dde6);
    border-color: #6a7282;
  }
  .wavecel-card .upload-status {
    font-size: 0.6rem;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
  }
  .wavecel-card .upload-error {
    font-size: 0.6rem;
    color: #ff6b6b;
    font-family: ui-monospace, monospace;
  }
  .wavecel-card .knob-row {
    display: flex;
    justify-content: center;
    gap: 12px;
    flex-wrap: wrap;
  }
</style>
