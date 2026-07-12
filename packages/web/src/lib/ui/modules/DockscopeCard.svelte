<script lang="ts">
  // DockscopeCard — the slim 1u rail scope (P2.5b; def:
  // $lib/audio/modules/dockscope). One horizontal trace + TIME/SCALE
  // faders + an AUDIO↔CV range toggle, in SCOPE's visual language.
  //
  // RAIL-OPTIMIZED RENDERING (the reason this module exists): the canvas
  // BACKING STORE tracks the card's live on-screen pixel size —
  // getBoundingClientRect (which folds in the dock's 50–150% CSS scale)
  // × devicePixelRatio — and the trace is re-plotted as VECTORS at that
  // resolution every meter frame (drawDockscope). At dock scale 150% the
  // backing store grows and the redraw fills it natively; nothing is
  // bitmap-upscaled, so the trace never blurs (the regular SCOPE's fixed
  // 320×300 raster was the P2.5a dock disqualifier).
  import { onMount } from 'svelte';
  import type { NodeProps } from '@xyflow/svelte';
  import { onMeterFrame } from '$lib/ui/meter-frame';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { dockscopeDef, type DockscopeSnapshot } from '$lib/audio/modules/dockscope';
  import { drawDockscope } from '$lib/audio/modules/dockscope-draw';
  import { useEngine } from '$lib/audio/engine-context';
  import { setNodeParam } from '$lib/graph/mutate';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { portsFromDef } from './card-kit';

  const inputs = portsFromDef(dockscopeDef.inputs, { ch1: 'CHANNEL 1' });

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  let timeMs = $derived(node?.params.timeMs ?? dockscopeDef.params[0]!.defaultValue);
  let scale  = $derived(node?.params.scale  ?? dockscopeDef.params[1]!.defaultValue);
  let range  = $derived(node?.params.range  ?? dockscopeDef.params[2]!.defaultValue);

  function setParam(paramId: string) {
    return (v: number) => setNodeParam(id, paramId, v);
  }
  function toggleRange() {
    setNodeParam(id, 'range', range >= 0.5 ? 0 : 1);
  }

  // Trace color: the audio cable tint, resolved post-mount (theme-aware) —
  // same convention as ScopeCard.
  let traceColor = $state('#fbbf24');
  onMount(() => {
    const cs = getComputedStyle(document.documentElement);
    traceColor = cs.getPropertyValue('--cable-audio').trim() || traceColor;
  });

  // VRT determinism seed — mirrors __scopeVrtSeed (ScopeCard): when the
  // harness sets globalThis.__dockscopeVrtSeed, the draw loop renders a
  // FIXED synthetic sine instead of the live analyser window, so pixels
  // are identical every run. No-op in production.
  function vrtSeed(): { freq: number } | null {
    const s = (globalThis as unknown as { __dockscopeVrtSeed?: { freq?: number } | boolean })
      .__dockscopeVrtSeed;
    if (!s) return null;
    return { freq: (typeof s === 'object' ? s.freq : undefined) ?? 220 };
  }
  function seededSnapshot(seed: { freq: number }): DockscopeSnapshot {
    const n = 2048;
    const sampleRate = 48000;
    const samples = new Float32Array(n);
    for (let i = 0; i < n; i++) samples[i] = Math.sin((2 * Math.PI * seed.freq * i) / sampleRate);
    return { samples, sampleRate };
  }

  let canvasEl: HTMLCanvasElement | null = $state(null);

  /** Crisp-resize + vector redraw: size the backing store to the LIVE
   *  on-screen pixels (gBCR × dpr — dock scale included), then re-plot. */
  function paint(c: HTMLCanvasElement, snap: DockscopeSnapshot): void {
    const rect = c.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    const dpr = typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1;
    const w = Math.round(rect.width * dpr);
    const h = Math.round(rect.height * dpr);
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
    const ctx2d = c.getContext('2d');
    if (!ctx2d) return;
    // pixelRatio = backing px per LOGICAL (unscaled layout) px — scales
    // stroke widths/labels with dpr × dock scale so line weight tracks
    // the zoom step instead of thinning out.
    const logicalW = c.clientWidth || rect.width;
    drawDockscope(ctx2d, snap.samples, snap.sampleRate, {
      timeMs, scale, range,
      color: traceColor,
      pixelRatio: logicalW > 0 ? w / logicalW : dpr,
    }, w, h);
  }

  $effect(() => {
    if (!canvasEl) return;
    const h = onMeterFrame(canvasEl, () => {
      const c = canvasEl;
      if (!c || !node) return;
      const seed = vrtSeed();
      if (seed) {
        paint(c, seededSnapshot(seed));
        return;
      }
      const eng = engineCtx.get();
      const snap = eng?.read(node, 'snapshot') as DockscopeSnapshot | undefined;
      if (snap) paint(c, snap);
    });
    return () => h.stop();
  });
</script>

<div class="mod-card dockscope-card">
  <div class="stripe"></div>
  <header class="title-row">
    <ModuleTitle {id} {data} defaultLabel="Dockscope" inline />
    <button
      class="range-btn"
      class:cv={range >= 0.5}
      style="color: {traceColor};"
      aria-pressed={range >= 0.5}
      data-testid="dockscope-range"
      onclick={toggleRange}
      title={range >= 0.5 ? 'CV display (±5V) — click for AUDIO' : 'AUDIO display (±1.0) — click for CV'}
    >
      {range >= 0.5 ? 'CV' : 'AUDIO'}
    </button>
  </header>

  <PatchPanel nodeId={id} {inputs} outputs={[]}>
    <div class="strip">
      <div class="screen-wrap">
        <canvas bind:this={canvasEl} data-testid="dockscope-canvas"></canvas>
      </div>
      <div class="fader-col">
        <Fader value={timeMs} min={1} max={200} defaultValue={20} label="Time" units="ms" curve="log" onchange={setParam('timeMs')} moduleId={id} paramId="timeMs" />
        <Fader value={scale} min={0.1} max={10} defaultValue={1} label="Scale" curve="log" onchange={setParam('scale')} moduleId={id} paramId="scale" />
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .dockscope-card {
    width: 360px;
    display: flex;
    flex-direction: column;
  }
  .stripe {
    background: var(--cable-audio);
  }
  .title-row {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    font-size: 0.85rem;
    font-weight: 500;
    margin: 0 0 4px;
  }
  .range-btn {
    height: 18px;
    min-width: 48px;
    padding: 0 5px;
    background: #14171c;
    border: 1px solid var(--border);
    border-radius: 3px;
    font-size: 0.6rem;
    font-family: ui-monospace, monospace;
    cursor: pointer;
    line-height: 1;
  }
  .range-btn[aria-pressed='true'] {
    background: #1c2028;
    border-color: currentColor;
  }
  .strip {
    display: flex;
    align-items: stretch;
    gap: 8px;
    padding: 0 12px 6px;
    flex: 1 1 auto;
    min-height: 0;
  }
  .screen-wrap {
    flex: 1 1 auto;
    min-width: 0;
    border: 1px solid var(--border);
    border-radius: 3px;
    overflow: hidden;
    line-height: 0;
  }
  canvas {
    display: block;
    /* The LAYOUT box is CSS-driven (fills the strip); the BACKING STORE is
       resized per frame to the live on-screen pixels (paint()) — the
       vector redraw that keeps the trace crisp at every dock zoom step. */
    width: 100%;
    height: 100%;
  }
  .fader-col {
    flex: 0 0 auto;
    display: flex;
    gap: 6px;
  }
</style>
