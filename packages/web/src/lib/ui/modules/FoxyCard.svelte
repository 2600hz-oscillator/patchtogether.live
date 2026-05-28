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
  import { drawFoxyXyz, drawFoxyBox } from '$lib/audio/modules/foxy-draw';
  import type { FoxyBox, FoxyFieldRow } from '$lib/audio/modules/foxy-map';
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

  let rasterAEl: HTMLCanvasElement | null = $state(null);
  let rasterBEl: HTMLCanvasElement | null = $state(null);
  let boxEl: HTMLCanvasElement | null = $state(null);
  let xyzEl: HTMLCanvasElement | null = $state(null);
  let wtEl: HTMLCanvasElement | null = $state(null);
  let vizMode = $state<'scope' | '3d'>('3d');
  let raf: number | null = null;

  function toggleVizMode() { vizMode = vizMode === '3d' ? 'scope' : '3d'; }

  function blitRaster(el: HTMLCanvasElement, img: ImageData): void {
    const c = el.getContext('2d');
    if (!c) return;
    if (typeof OffscreenCanvas !== 'undefined') {
      const stage = new OffscreenCanvas(img.width, img.height);
      const sc = stage.getContext('2d');
      if (sc) {
        sc.putImageData(img, 0, 0);
        c.imageSmoothingEnabled = false;
        c.clearRect(0, 0, el.width, el.height);
        c.drawImage(stage, 0, 0, el.width, el.height);
      }
    } else {
      c.putImageData(img, 0, 0);
    }
  }

  $effect(() => {
    if (!rasterAEl && !rasterBEl && !boxEl && !xyzEl && !wtEl) return;
    function tick() {
      const e = engineCtx.get();
      if (e && node) {
        // Drive the bridge once, then read the cached previews.
        const imgA = e.read(node, 'rasterImageDataA') as ImageData | undefined;
        const imgB = e.read(node, 'rasterImageDataB') as ImageData | undefined;
        const box = e.read(node, 'box') as FoxyBox | null | undefined;
        const field = e.read(node, 'xyzField') as FoxyFieldRow[] | undefined;
        const wt = e.read(node, 'wavetableFrames') as Float32Array[] | undefined;
        const activeFrame = (e.read(node, 'activeFrame') as number | undefined) ?? 0;

        // RASTER A + RASTER B previews.
        if (rasterAEl && imgA) blitRaster(rasterAEl, imgA);
        if (rasterBEl && imgB) blitRaster(rasterBEl, imgB);
        // Box 3D heightfield (A terrain lifted by B luma).
        if (boxEl) {
          const c = boxEl.getContext('2d');
          if (c) drawFoxyBox(c, box ?? null, boxEl.width, boxEl.height);
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
  <div class="subtitle">DUAL SWOLEVCO → RASTER A/B → BOX 3D → XYZ → LIVE WAVETABLE</div>

  <PatchPanel nodeId={id} {inputs} {outputs} panelWidth={320}>
    <div class="body">
      <!-- mini SWOLEVCO source A controls (terrain) -->
      <div class="section-label">SWOLE A (terrain)</div>
      <div class="knob-row">
        <Knob value={pv('src_tune', defv('src_tune'))}     min={-36} max={36}  defaultValue={0}   label="Tune" units="st" curve="linear" onchange={set('src_tune')}     moduleId={id} paramId="src_tune"     readLive={live('src_tune')} />
        <Knob value={pv('src_fine', defv('src_fine'))}     min={-100} max={100} defaultValue={0}   label="Fine" units="¢"  curve="linear" onchange={set('src_fine')}     moduleId={id} paramId="src_fine"     readLive={live('src_fine')} />
        <Knob value={pv('src_timbre', defv('src_timbre'))} min={0}   max={1}   defaultValue={0.3} label="Tbr"            curve="linear" onchange={set('src_timbre')}   moduleId={id} paramId="src_timbre"   readLive={live('src_timbre')} />
        <Knob value={pv('src_symmetry', defv('src_symmetry'))} min={0} max={1} defaultValue={0.5} label="Sym"           curve="linear" onchange={set('src_symmetry')} moduleId={id} paramId="src_symmetry" readLive={live('src_symmetry')} />
        <Knob value={pv('src_fold', defv('src_fold'))}     min={0}   max={1}   defaultValue={0.2} label="Fold"           curve="linear" onchange={set('src_fold')}     moduleId={id} paramId="src_fold"     readLive={live('src_fold')} />
      </div>

      <!-- mini SWOLEVCO source B controls (Z height) -->
      <div class="section-label">SWOLE B (Z height)</div>
      <div class="knob-row">
        <Knob value={pv('src2_tune', defv('src2_tune'))}     min={-36} max={36}  defaultValue={defv('src2_tune')} label="Tune" units="st" curve="linear" onchange={set('src2_tune')}     moduleId={id} paramId="src2_tune"     readLive={live('src2_tune')} />
        <Knob value={pv('src2_fine', defv('src2_fine'))}     min={-100} max={100} defaultValue={0}                 label="Fine" units="¢"  curve="linear" onchange={set('src2_fine')}     moduleId={id} paramId="src2_fine"     readLive={live('src2_fine')} />
        <Knob value={pv('src2_timbre', defv('src2_timbre'))} min={0}   max={1}   defaultValue={defv('src2_timbre')} label="Tbr"          curve="linear" onchange={set('src2_timbre')}   moduleId={id} paramId="src2_timbre"   readLive={live('src2_timbre')} />
        <Knob value={pv('src2_symmetry', defv('src2_symmetry'))} min={0} max={1} defaultValue={defv('src2_symmetry')} label="Sym"        curve="linear" onchange={set('src2_symmetry')} moduleId={id} paramId="src2_symmetry" readLive={live('src2_symmetry')} />
        <Knob value={pv('src2_fold', defv('src2_fold'))}     min={0}   max={1}   defaultValue={defv('src2_fold')}  label="Fold"           curve="linear" onchange={set('src2_fold')}     moduleId={id} paramId="src2_fold"     readLive={live('src2_fold')} />
      </div>

      <!-- Raster A + Raster B small previews -->
      <div class="preview-row">
        <div class="preview">
          <canvas bind:this={rasterAEl} width="72" height="72" class="prev-canvas" data-testid="foxy-raster-a"></canvas>
          <span class="prev-label">RASTER A</span>
        </div>
        <div class="arrow">+</div>
        <div class="preview">
          <canvas bind:this={rasterBEl} width="72" height="72" class="prev-canvas" data-testid="foxy-raster-b"></canvas>
          <span class="prev-label">RASTER B</span>
        </div>
        <div class="arrow">→</div>
        <div class="preview">
          <canvas bind:this={boxEl} width="96" height="84" class="prev-canvas box-canvas" data-testid="foxy-box"></canvas>
          <span class="prev-label">BOX (3D)</span>
        </div>
      </div>

      <!-- Box → XYZ window -->
      <div class="preview-row">
        <div class="preview">
          <canvas bind:this={xyzEl} width="96" height="84" class="prev-canvas box-canvas" data-testid="foxy-xyz"></canvas>
          <span class="prev-label">XYZ</span>
        </div>
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
    min-height: 620px;
  }
  .foxy-card .box-canvas {
    width: 96px;
    height: 84px;
    image-rendering: auto;
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
