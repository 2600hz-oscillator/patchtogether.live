<script lang="ts">
  // FoxyCard — HYBRID module card. Renders the whole internal chain as
  // small preview windows plus the controls:
  //   [mini SWOLEVCO knobs] → [RASTERIZE preview] → [XYZ window] →
  //   [animated WAVECEL wavetable display] + [WAVECEL control row]
  //
  // All preview canvases are driven from ONE rAF loop that calls the
  // engine's read() seam each frame: read('rasterImageData'), read('xyzField'),
  // read('wavetableFrames'). The engine handle owns the actual compute (the
  // throttled bridge) so the card just blits.
  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { foxyDef } from '$lib/audio/modules/foxy';
  import { drawWave3D, drawWaveScope } from '$lib/audio/modules/wavecel-draw';
  import { drawFoxyXyz } from '$lib/audio/modules/foxy-draw';
  import type { FoxyFieldRow } from '$lib/audio/modules/foxy-map';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  function pv(k: string, fallback: number): number {
    const v = node?.params?.[k];
    return typeof v === 'number' ? v : fallback;
  }
  function defv(k: string): number {
    return foxyDef.params.find((p) => p.id === k)!.defaultValue;
  }
  const set = (k: string) => (v: number) => { const t = patch.nodes[id]; if (t) t.params[k] = v; };
  const live = (k: string) => () => {
    const e = engineCtx.get(); if (!e || !node) return undefined;
    return e.readParam(node, k);
  };

  // FOXY exposes WAVECEL's full IO verbatim.
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
    { id: 'scope_out',  label: 'SCOPE VIDEO', cable: 'mono-video' },
    { id: 'wave3d_out', label: '3D VIDEO',    cable: 'video' },
  ];

  let rasterEl: HTMLCanvasElement | null = $state(null);
  let xyzEl: HTMLCanvasElement | null = $state(null);
  let wtEl: HTMLCanvasElement | null = $state(null);
  let vizMode = $state<'scope' | '3d'>('3d');
  let raf: number | null = null;

  function toggleVizMode() { vizMode = vizMode === '3d' ? 'scope' : '3d'; }

  $effect(() => {
    if (!rasterEl && !xyzEl && !wtEl) return;
    function tick() {
      const e = engineCtx.get();
      if (e && node) {
        // Drive the bridge once, then read the three cached previews.
        const img = e.read(node, 'rasterImageData') as ImageData | undefined;
        const field = e.read(node, 'xyzField') as FoxyFieldRow[] | undefined;
        const wt = e.read(node, 'wavetableFrames') as Float32Array[] | undefined;
        const activeFrame = (e.read(node, 'activeFrame') as number | undefined) ?? 0;

        // RASTERIZE preview.
        if (rasterEl && img) {
          const c = rasterEl.getContext('2d');
          if (c) {
            if (typeof OffscreenCanvas !== 'undefined') {
              const stage = new OffscreenCanvas(img.width, img.height);
              const sc = stage.getContext('2d');
              if (sc) {
                sc.putImageData(img, 0, 0);
                c.imageSmoothingEnabled = false;
                c.clearRect(0, 0, rasterEl.width, rasterEl.height);
                c.drawImage(stage, 0, 0, rasterEl.width, rasterEl.height);
              }
            } else {
              c.putImageData(img, 0, 0);
            }
          }
        }
        // XYZ window.
        if (xyzEl && field) {
          const c = xyzEl.getContext('2d');
          if (c) drawFoxyXyz(c, field, xyzEl.width, xyzEl.height);
        }
        // Animated wavetable display.
        if (wtEl) {
          const c = wtEl.getContext('2d');
          if (c) {
            const fs = wt ?? [];
            if (vizMode === '3d') drawWave3D(c, fs, wtEl.width, wtEl.height, { activeFrame });
            else drawWaveScope(c, fs, wtEl.width, wtEl.height, { activeFrame });
          }
        }
      }
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => { if (raf !== null) cancelAnimationFrame(raf); raf = null; };
  });
</script>

<div class="mod-card foxy-card" data-testid="foxy-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <header class="title">FOXY</header>
  <div class="subtitle">SWOLEVCO → RASTERIZE → XYZ → LIVE WAVETABLE</div>

  <PatchPanel nodeId={id} {inputs} {outputs} panelWidth={320}>
    <div class="body">
      <!-- Internal chain previews -->
      <div class="preview-row">
        <div class="preview">
          <canvas bind:this={rasterEl} width="96" height="96" class="prev-canvas" data-testid="foxy-raster"></canvas>
          <span class="prev-label">RASTER</span>
        </div>
        <div class="arrow">→</div>
        <div class="preview">
          <canvas bind:this={xyzEl} width="96" height="96" class="prev-canvas" data-testid="foxy-xyz"></canvas>
          <span class="prev-label">XYZ</span>
        </div>
      </div>

      <!-- mini SWOLEVCO source controls -->
      <div class="section-label">SOURCE (mini SWOLEVCO)</div>
      <div class="knob-row">
        <Knob value={pv('src_tune', defv('src_tune'))}     min={-36} max={36}  defaultValue={0}   label="Tune" units="st" curve="linear" onchange={set('src_tune')}     moduleId={id} paramId="src_tune"     readLive={live('src_tune')} />
        <Knob value={pv('src_fine', defv('src_fine'))}     min={-100} max={100} defaultValue={0}   label="Fine" units="¢"  curve="linear" onchange={set('src_fine')}     moduleId={id} paramId="src_fine"     readLive={live('src_fine')} />
        <Knob value={pv('src_timbre', defv('src_timbre'))} min={0}   max={1}   defaultValue={0.3} label="Tbr"            curve="linear" onchange={set('src_timbre')}   moduleId={id} paramId="src_timbre"   readLive={live('src_timbre')} />
        <Knob value={pv('src_symmetry', defv('src_symmetry'))} min={0} max={1} defaultValue={0.5} label="Sym"           curve="linear" onchange={set('src_symmetry')} moduleId={id} paramId="src_symmetry" readLive={live('src_symmetry')} />
        <Knob value={pv('src_fold', defv('src_fold'))}     min={0}   max={1}   defaultValue={0.2} label="Fold"           curve="linear" onchange={set('src_fold')}     moduleId={id} paramId="src_fold"     readLive={live('src_fold')} />
      </div>

      <!-- XYZ window controls -->
      <div class="section-label">XYZ (simplified RUTTETRA)</div>
      <div class="knob-row">
        <Knob value={pv('xyz_xshape', defv('xyz_xshape'))} min={0}  max={1} defaultValue={defv('xyz_xshape')} label="X Shp" curve="linear" onchange={set('xyz_xshape')} moduleId={id} paramId="xyz_xshape" readLive={live('xyz_xshape')} />
        <Knob value={pv('xyz_yshape', defv('xyz_yshape'))} min={0}  max={1} defaultValue={defv('xyz_yshape')} label="Y Shp" curve="linear" onchange={set('xyz_yshape')} moduleId={id} paramId="xyz_yshape" readLive={live('xyz_yshape')} />
        <Knob value={pv('xyz_ydisp', defv('xyz_ydisp'))}   min={-1} max={1} defaultValue={defv('xyz_ydisp')}  label="Y Dsp" curve="linear" onchange={set('xyz_ydisp')}  moduleId={id} paramId="xyz_ydisp"  readLive={live('xyz_ydisp')} />
      </div>

      <!-- Animated WAVECEL wavetable display + full WAVECEL control row -->
      <div class="section-label">LIVE WAVETABLE (WAVECEL)</div>
      <div class="viz-row">
        <canvas bind:this={wtEl} width="280" height="110" class="viz" data-testid="foxy-wavetable"></canvas>
        <button type="button" class="viz-toggle" onclick={toggleVizMode} data-testid="foxy-viz-toggle" aria-label="Toggle visualization">{vizMode === '3d' ? '3D' : 'SCOPE'}</button>
      </div>
      <div class="knob-row">
        <Knob value={pv('tune', defv('tune'))}   min={-36} max={36}  defaultValue={0} label="Tune"  units="st" curve="linear" onchange={set('tune')}   moduleId={id} paramId="tune"   readLive={live('tune')} />
        <Knob value={pv('fine', defv('fine'))}   min={-100} max={100} defaultValue={0} label="Fine"  units="¢"  curve="linear" onchange={set('fine')}   moduleId={id} paramId="fine"   readLive={live('fine')} />
        <Knob value={pv('morph', defv('morph'))} min={0}   max={1}   defaultValue={0} label="Morph"            curve="linear" onchange={set('morph')}  moduleId={id} paramId="morph"  readLive={live('morph')} />
        <Knob value={pv('spread', defv('spread'))} min={1} max={5}   defaultValue={1} label="Sprd"             curve="linear" onchange={set('spread')} moduleId={id} paramId="spread" readLive={live('spread')} />
        <Knob value={pv('fold', defv('fold'))}   min={0}   max={1}   defaultValue={0} label="Fold"             curve="linear" onchange={set('fold')}   moduleId={id} paramId="fold"   readLive={live('fold')} />
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .foxy-card {
    width: 360px;
    min-height: 480px;
  }
  .foxy-card .subtitle {
    font-size: 0.5rem;
    color: var(--text-dim);
    text-align: center;
    letter-spacing: 0.06em;
    margin-top: 2px;
  }
  .foxy-card .body {
    margin-top: 14px;
    padding: 0 14px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .foxy-card .preview-row {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }
  .foxy-card .preview {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
  }
  .foxy-card .prev-canvas {
    width: 96px;
    height: 96px;
    background: #05070b;
    border: 1px solid #2a2f3a;
    border-radius: 2px;
    image-rendering: pixelated;
  }
  .foxy-card .prev-label {
    font-size: 0.5rem;
    color: var(--text-dim);
    letter-spacing: 0.1em;
    font-family: ui-monospace, monospace;
  }
  .foxy-card .arrow {
    color: var(--text-dim);
    font-size: 1rem;
  }
  .foxy-card .section-label {
    font-size: 0.5rem;
    color: var(--text-dim);
    letter-spacing: 0.08em;
    font-family: ui-monospace, monospace;
    margin-top: 4px;
  }
  .foxy-card .viz-row {
    position: relative;
  }
  .foxy-card .viz {
    display: block;
    width: 100%;
    height: 110px;
    background: #0a0c11;
    border: 1px solid #2a2f3a;
    border-radius: 2px;
  }
  .foxy-card .viz-toggle {
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
  .foxy-card .viz-toggle:hover { border-color: #6a7282; }
  .foxy-card .knob-row {
    display: flex;
    justify-content: center;
    gap: 10px;
    flex-wrap: wrap;
  }
</style>
