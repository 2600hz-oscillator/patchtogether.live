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
  import {
    foxyDef,
    FOXY_GEN_MODE_NAMES,
    FOXY_GEN_MODE_MAX,
    FOXY_SYNC_MODE_NAMES,
    FOXY_SYNC_MODE_MAX,
    buildWavetableExport,
    buildWavetableExportFilename,
  } from '$lib/audio/modules/foxy';
  import { drawWave3D, drawWaveScope } from '$lib/audio/modules/wavecel-draw';
  import { drawFoxyXyz } from '$lib/audio/modules/foxy-draw';
  import { drawFoxyShapes } from '$lib/audio/modules/foxy-shapes-draw';
  import type { Shape as FoxyShape } from '$lib/audio/modules/foxy-shapes';
  import type { FoxyFieldRow } from '$lib/audio/modules/foxy-map';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { set, live, engineCtx } = cardParams(foxyDef, () => id, () => node);

  function pv(k: string, fallback: number): number {
    const v = node?.params?.[k];
    return typeof v === 'number' ? v : fallback;
  }
  function defv(k: string): number {
    return foxyDef.params.find((p) => p.id === k)!.defaultValue;
  }

  // FOXY exposes WAVECEL's full IO verbatim.
  const inputs = portsFromDef(foxyDef.inputs, {
    morph_cv: 'MORPH (CV)', spread_cv: 'SPREAD (CV)', fold_cv: 'FOLD (CV)',
  });
  const outputs = portsFromDef(foxyDef.outputs, {
    out_l: 'OUT L', out_r: 'OUT R', scope_out: 'SCOPE VIDEO', wave3d_out: '3D VIDEO',
    combined_out: 'COMBINED VIDEO',
  });

  let rasterAEl: HTMLCanvasElement | null = $state(null);
  let rasterBEl: HTMLCanvasElement | null = $state(null);
  let rasterCEl: HTMLCanvasElement | null = $state(null);
  let xyzEl: HTMLCanvasElement | null = $state(null);
  let wtEl: HTMLCanvasElement | null = $state(null);
  let vizMode = $state<'scope' | '3d'>('3d');
  let raf: number | null = null;

  // GEN mode (0 = XYZ, 1 = 3D Shape Gen). Tracks the param so the on-card
  // XYZ window can swap renderers + the mode-name label can update live.
  function clampGen(v: number): number {
    const r = Math.round(v);
    if (r < 0) return 0;
    if (r > FOXY_GEN_MODE_MAX) return FOXY_GEN_MODE_MAX;
    return r;
  }
  let genIdx = $derived(clampGen(pv('gen_mode', 0)));
  let genName = $derived(FOXY_GEN_MODE_NAMES[genIdx]);

  function toggleVizMode() { vizMode = vizMode === '3d' ? 'scope' : '3d'; }

  // EXPORT TABLE — only meaningful (+ visible) when FREEZE TABLE is on, so
  // the user is dumping a stable, identifiable snapshot. Reads the live
  // wavetable frames + the current GEN mode via the same engine seam the
  // viz uses, builds a portable JSON payload, then triggers a download via
  // an in-DOM anchor click. No File System Access API → works in every
  // browser the rest of the app supports.
  let isFrozen = $derived(pv('freezeTable', 0) >= 0.5);
  function exportTable(): void {
    const e = engineCtx.get();
    if (!e || !node) return;
    const wt = e.read(node, 'wavetableFrames') as Float32Array[] | undefined;
    if (!wt || wt.length === 0) return;
    const modeIdx = clampGen(Number((e.read(node, 'genMode') as number | undefined) ?? 0));
    const mode = FOXY_GEN_MODE_NAMES[modeIdx];
    const now = new Date();
    const payload = buildWavetableExport(wt, mode, now);
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = buildWavetableExportFilename(now);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Defer URL revoke a tick so Safari's late click-handling sees the
    // blob; matches the VideoboxCard/VideoVarispeedCard export pattern.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  // Named-mode label next to the SYNC knob (Off / X & Y / XYZ). Mirrors the
  // pattern — render the constant indexed by the
  // current discrete param value.
  let syncMode = $derived(pv('sync_mode', defv('sync_mode')));
  let syncModeLabel = $derived(
    FOXY_SYNC_MODE_NAMES[Math.max(0, Math.min(FOXY_SYNC_MODE_MAX, Math.round(syncMode)))],
  );

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

  // LIVE WAVETABLE redraw guard. drawWave3D/drawWaveScope are pure functions of
  // (frames, activeFrame, vizMode), so re-running them every rAF when nothing
  // changed just re-rasterizes identical pixels. While FREEZE TABLE is on the
  // frames don't change, so without a guard the canvas was repainted ~60×/s with
  // the SAME content — and at a fractional canvas zoom each repaint composites
  // with non-deterministic sub-pixel AA, so two screenshots taken 2 s apart
  // differed by a few bytes and broke the freeze-equality e2e (#759/#411/#420).
  // Skipping the redraw when the inputs are unchanged keeps the composited layer
  // byte-stable (and is a small perf win in production).
  let lastWtSig = '';
  function wtSignature(fs: Float32Array[], activeFrame: number, mode: string): string {
    // Cheap content fingerprint: frame count + length + a few sampled values
    // from the first/last frame + the active index + viz mode. Enough to detect
    // a real wavetable change without hashing every sample each frame.
    const n = fs.length;
    let sig = `${mode}|${activeFrame}|${n}`;
    if (n > 0) {
      const f0 = fs[0]!;
      const fl = fs[n - 1]!;
      sig += `|${f0.length}`;
      const k = Math.max(1, f0.length >> 3);
      for (let i = 0; i < f0.length; i += k) sig += `,${f0[i]!.toFixed(4)}`;
      for (let i = 0; i < fl.length; i += k) sig += `;${fl[i]!.toFixed(4)}`;
    }
    return sig;
  }

  $effect(() => {
    if (!rasterAEl && !rasterBEl && !rasterCEl && !xyzEl && !wtEl) return;
    function tick() {
      const e = engineCtx.get();
      if (e && node) {
        // Drive the bridge once, then read the cached previews.
        const imgA = e.read(node, 'rasterImageDataA') as ImageData | undefined;
        const imgB = e.read(node, 'rasterImageDataB') as ImageData | undefined;
        const imgC = e.read(node, 'rasterImageDataC') as ImageData | undefined;
        const field = e.read(node, 'xyzField') as FoxyFieldRow[] | undefined;
        const wt = e.read(node, 'wavetableFrames') as Float32Array[] | undefined;
        const activeFrame = (e.read(node, 'activeFrame') as number | undefined) ?? 0;

        // RASTER A/B/C previews.
        if (rasterAEl && imgA) blitRaster(rasterAEl, imgA);
        if (rasterBEl && imgB) blitRaster(rasterBEl, imgB);
        if (rasterCEl && imgC) blitRaster(rasterCEl, imgC);
        // XYZ window — switches renderer based on gen_mode:
        //   0 (XYZ):          drawFoxyXyz reads `field`, the v4.1 height
        //                     scanlines.
        //   1 (3D Shape Gen): drawFoxyShapes reads `shapes`, the
        //                     vaporwave-styled 3D primitives in a box.
        if (xyzEl) {
          const c = xyzEl.getContext('2d');
          if (c) {
            if (genIdx >= 1) {
              const shapes = (e.read(node, 'shapes') as FoxyShape[] | undefined) ?? [];
              drawFoxyShapes(c, shapes, xyzEl.width, xyzEl.height);
            } else if (field) {
              drawFoxyXyz(c, field, xyzEl.width, xyzEl.height);
            }
          }
        }
        // Animated wavetable display. Only repaint when the draw inputs
        // changed (see wtSignature) — a frozen table keeps the same pixels, so
        // skipping the redraw keeps the composited canvas byte-stable.
        if (wtEl) {
          const c = wtEl.getContext('2d');
          if (c) {
            const fs = wt ?? [];
            const sig = wtSignature(fs, activeFrame, vizMode);
            if (sig !== lastWtSig) {
              lastWtSig = sig;
              if (vizMode === '3d') drawWave3D(c, fs, wtEl.width, wtEl.height, { activeFrame });
              else drawWaveScope(c, fs, wtEl.width, wtEl.height, { activeFrame });
            }
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
  <ModuleTitle {id} {data} defaultLabel="FOXY" />
  <div class="subtitle">TRIPLE SWOLEVCO → RASTER A/B/C → 3-AXIS DIST (X=A · Y=B · Z=C) → LIVE WAVETABLE</div>

  <PatchPanel nodeId={id} {inputs} {outputs} panelWidth={320}>
    <div class="body">
      <!-- 2-column layout:
             LEFT  — sources: SWOLE A/B/C + RASTER A/B/C previews + XYZ scope
                     (+ FREEZE TABLE toggle).
             RIGHT — wavetable: GEN mode + XYZ volumetric + VCO SYNC +
                     LIVE WAVETABLE display + WAVECEL knob row.
           All controls preserved; only the layout changes. -->
      <div class="card-grid">
        <div class="card-col card-col-left">
      <!-- mini SWOLEVCO source A controls (X axis — column distribution) -->
      <div class="section-label">SWOLE A (X axis · column dist)</div>
      <div class="knob-row">
        <Knob value={pv('src_tune', defv('src_tune'))}     min={-36} max={36}  defaultValue={0}   label="Tune" units="st" curve="linear" onchange={set('src_tune')}     moduleId={id} paramId="src_tune"     readLive={live('src_tune')} />
        <Knob value={pv('src_fine', defv('src_fine'))}     min={-100} max={100} defaultValue={0}   label="Fine" units="¢"  curve="linear" onchange={set('src_fine')}     moduleId={id} paramId="src_fine"     readLive={live('src_fine')} />
        <Knob value={pv('src_timbre', defv('src_timbre'))} min={0}   max={1}   defaultValue={0.3} label="Tbr"            curve="linear" onchange={set('src_timbre')}   moduleId={id} paramId="src_timbre"   readLive={live('src_timbre')} />
        <Knob value={pv('src_symmetry', defv('src_symmetry'))} min={0} max={1} defaultValue={0.5} label="Sym"           curve="linear" onchange={set('src_symmetry')} moduleId={id} paramId="src_symmetry" readLive={live('src_symmetry')} />
        <Knob value={pv('src_fold', defv('src_fold'))}     min={0}   max={1}   defaultValue={0.2} label="Fold"           curve="linear" onchange={set('src_fold')}     moduleId={id} paramId="src_fold"     readLive={live('src_fold')} />
      </div>

      <!-- mini SWOLEVCO source B controls (Y axis — row distribution) -->
      <div class="section-label">SWOLE B (Y axis · row dist)</div>
      <div class="knob-row">
        <Knob value={pv('src2_tune', defv('src2_tune'))}     min={-36} max={36}  defaultValue={defv('src2_tune')} label="Tune" units="st" curve="linear" onchange={set('src2_tune')}     moduleId={id} paramId="src2_tune"     readLive={live('src2_tune')} />
        <Knob value={pv('src2_fine', defv('src2_fine'))}     min={-100} max={100} defaultValue={0}                 label="Fine" units="¢"  curve="linear" onchange={set('src2_fine')}     moduleId={id} paramId="src2_fine"     readLive={live('src2_fine')} />
        <Knob value={pv('src2_timbre', defv('src2_timbre'))} min={0}   max={1}   defaultValue={defv('src2_timbre')} label="Tbr"          curve="linear" onchange={set('src2_timbre')}   moduleId={id} paramId="src2_timbre"   readLive={live('src2_timbre')} />
        <Knob value={pv('src2_symmetry', defv('src2_symmetry'))} min={0} max={1} defaultValue={defv('src2_symmetry')} label="Sym"        curve="linear" onchange={set('src2_symmetry')} moduleId={id} paramId="src2_symmetry" readLive={live('src2_symmetry')} />
        <Knob value={pv('src2_fold', defv('src2_fold'))}     min={0}   max={1}   defaultValue={defv('src2_fold')}  label="Fold"           curve="linear" onchange={set('src2_fold')}     moduleId={id} paramId="src2_fold"     readLive={live('src2_fold')} />
      </div>

      <!-- mini SWOLEVCO source C controls (Z axis — amplitude LUT) -->
      <div class="section-label">SWOLE C (Z axis · amplitude LUT)</div>
      <div class="knob-row">
        <Knob value={pv('src3_tune', defv('src3_tune'))}     min={-36} max={36}  defaultValue={defv('src3_tune')} label="Tune" units="st" curve="linear" onchange={set('src3_tune')}     moduleId={id} paramId="src3_tune"     readLive={live('src3_tune')} />
        <Knob value={pv('src3_fine', defv('src3_fine'))}     min={-100} max={100} defaultValue={0}                 label="Fine" units="¢"  curve="linear" onchange={set('src3_fine')}     moduleId={id} paramId="src3_fine"     readLive={live('src3_fine')} />
        <Knob value={pv('src3_timbre', defv('src3_timbre'))} min={0}   max={1}   defaultValue={defv('src3_timbre')} label="Tbr"          curve="linear" onchange={set('src3_timbre')}   moduleId={id} paramId="src3_timbre"   readLive={live('src3_timbre')} />
        <Knob value={pv('src3_symmetry', defv('src3_symmetry'))} min={0} max={1} defaultValue={defv('src3_symmetry')} label="Sym"        curve="linear" onchange={set('src3_symmetry')} moduleId={id} paramId="src3_symmetry" readLive={live('src3_symmetry')} />
        <Knob value={pv('src3_fold', defv('src3_fold'))}     min={0}   max={1}   defaultValue={defv('src3_fold')}  label="Fold"           curve="linear" onchange={set('src3_fold')}     moduleId={id} paramId="src3_fold"     readLive={live('src3_fold')} />
      </div>

      <!-- Raster A / B / C small previews. Each preview carries a FREEZE
           toggle that holds its current frame so the SWOLEVCOs no longer
           drive that axis of the wavetable; the XYZ preview carries FREEZE
           TABLE, which holds the wavetable WAVECEL is currently reading (so
           the XYZ scope can keep evolving while the audio stays put). -->
      <div class="preview-row">
        <div class="preview">
          <canvas bind:this={rasterAEl} width="72" height="72" class="prev-canvas" data-testid="foxy-raster-a"></canvas>
          <span class="prev-label">RASTER A</span>
          <button
            type="button"
            class="freeze-btn"
            data-testid="foxy-freeze-raster-a"
            aria-pressed={pv('freezeRasterA', 0) >= 0.5}
            onclick={() => set('freezeRasterA')(pv('freezeRasterA', 0) >= 0.5 ? 0 : 1)}
          >{pv('freezeRasterA', 0) >= 0.5 ? 'FROZEN' : 'FREEZE A'}</button>
        </div>
        <div class="preview">
          <canvas bind:this={rasterBEl} width="72" height="72" class="prev-canvas" data-testid="foxy-raster-b"></canvas>
          <span class="prev-label">RASTER B</span>
          <button
            type="button"
            class="freeze-btn"
            data-testid="foxy-freeze-raster-b"
            aria-pressed={pv('freezeRasterB', 0) >= 0.5}
            onclick={() => set('freezeRasterB')(pv('freezeRasterB', 0) >= 0.5 ? 0 : 1)}
          >{pv('freezeRasterB', 0) >= 0.5 ? 'FROZEN' : 'FREEZE B'}</button>
        </div>
        <div class="preview">
          <canvas bind:this={rasterCEl} width="72" height="72" class="prev-canvas" data-testid="foxy-raster-c"></canvas>
          <span class="prev-label">RASTER C</span>
          <button
            type="button"
            class="freeze-btn"
            data-testid="foxy-freeze-raster-c"
            aria-pressed={pv('freezeRasterC', 0) >= 0.5}
            onclick={() => set('freezeRasterC')(pv('freezeRasterC', 0) >= 0.5 ? 0 : 1)}
          >{pv('freezeRasterC', 0) >= 0.5 ? 'FROZEN' : 'FREEZE C'}</button>
        </div>
      </div>

      <!-- XYZ scope window (X=A · Y=B · Z=C) — reads the live wavetable.
           FREEZE TABLE sits under the XYZ scope on the LEFT column: it
           freezes the wavetable ONLY (XYZ scope keeps animating). -->
      <div class="preview-row">
        <div class="preview">
          <canvas bind:this={xyzEl} width="160" height="84" class="prev-canvas box-canvas" data-testid="foxy-xyz"></canvas>
          <span class="prev-label">XYZ (X=A · Y=B · Z=C)</span>
          <button
            type="button"
            class="freeze-btn"
            data-testid="foxy-freeze-table"
            aria-pressed={pv('freezeTable', 0) >= 0.5}
            onclick={() => set('freezeTable')(pv('freezeTable', 0) >= 0.5 ? 0 : 1)}
          >{pv('freezeTable', 0) >= 0.5 ? 'TABLE FROZEN' : 'FREEZE TABLE'}</button>
        </div>
      </div>
        </div>

        <div class="card-col card-col-right">
      <!-- GEN mode picker — switches the WAVETABLE GENERATOR path between
           the XYZ (default) continuous-heightfield + 3D Shape Gen
           (experimental, vaporwave 3D primitives in a box). -->
      <div class="section-label">WAVETABLE GENERATOR</div>
      <div class="knob-row">
        <div class="mode-group" data-testid="foxy-gen-group">
          <Knob value={pv('gen_mode', defv('gen_mode'))} min={0} max={FOXY_GEN_MODE_MAX} defaultValue={defv('gen_mode')} label="GEN" curve="linear" onchange={set('gen_mode')} moduleId={id} paramId="gen_mode" readLive={live('gen_mode')} />
          <div class="mode-name" data-testid="foxy-gen-mode-name">{genName}</div>
        </div>
      </div>

      <!-- XYZ volumetric controls (v4: shape + C-driven warp / Z height;
           v4.1: zoom + smooth → fewer / larger conical peaks).
           Only meaningful when gen_mode = 0 (XYZ); harmless when set to 1
           (3D Shape Gen) since the shapes path doesn't read them. -->
      <div class="section-label">XYZ volumetric (v4.1)</div>
      <div class="knob-row">
        <Knob value={pv('xyz_xshape', defv('xyz_xshape'))} min={0}  max={1} defaultValue={defv('xyz_xshape')} label="X Shp" curve="linear" onchange={set('xyz_xshape')} moduleId={id} paramId="xyz_xshape" readLive={live('xyz_xshape')} />
        <Knob value={pv('xyz_yshape', defv('xyz_yshape'))} min={0}  max={1} defaultValue={defv('xyz_yshape')} label="Y Shp" curve="linear" onchange={set('xyz_yshape')} moduleId={id} paramId="xyz_yshape" readLive={live('xyz_yshape')} />
        <Knob value={pv('xyz_ydisp', defv('xyz_ydisp'))}   min={-1} max={1} defaultValue={defv('xyz_ydisp')}  label="Y Dsp" curve="linear" onchange={set('xyz_ydisp')}  moduleId={id} paramId="xyz_ydisp"  readLive={live('xyz_ydisp')} />
        <Knob value={pv('xyz_warp', defv('xyz_warp'))}     min={0}  max={1} defaultValue={defv('xyz_warp')}    label="Warp"  curve="linear" onchange={set('xyz_warp')}    moduleId={id} paramId="xyz_warp"    readLive={live('xyz_warp')} />
        <Knob value={pv('xyz_zheight', defv('xyz_zheight'))} min={0} max={1} defaultValue={defv('xyz_zheight')} label="Z Ht"  curve="linear" onchange={set('xyz_zheight')} moduleId={id} paramId="xyz_zheight" readLive={live('xyz_zheight')} />
        <Knob value={pv('xyz_zoom', defv('xyz_zoom'))}     min={1}  max={8} defaultValue={defv('xyz_zoom')}    label="ZOOM"  curve="linear" onchange={set('xyz_zoom')}    moduleId={id} paramId="xyz_zoom"    readLive={live('xyz_zoom')} />
        <Knob value={pv('xyz_smooth', defv('xyz_smooth'))} min={0}  max={1} defaultValue={defv('xyz_smooth')}  label="SMOOTH" curve="linear" onchange={set('xyz_smooth')} moduleId={id} paramId="xyz_smooth"  readLive={live('xyz_smooth')} />
      </div>

      <!-- VCO sync (ratio-lock): swoleB and (mode 2) swoleC snap their base
           Hz to integer ratios of swoleA. Named-mode label sits next to the
           knob (Off / X & Y / XYZ) — mirrors RESOFILTER. -->
      <div class="section-label">VCO SYNC (raster source oscillators)</div>
      <div class="knob-row sync-row">
        <Knob value={pv('sync_mode', defv('sync_mode'))} min={0} max={FOXY_SYNC_MODE_MAX} defaultValue={defv('sync_mode')}
          label="Sync" curve="discrete"
          onchange={set('sync_mode')} moduleId={id} paramId="sync_mode" readLive={live('sync_mode')} />
        <div class="sync-mode-name" data-testid="foxy-sync-mode-name">{syncModeLabel}</div>
      </div>

      <!-- Animated WAVECEL wavetable display + full WAVECEL control row.
           Section header sprouts an EXPORT TABLE button when FREEZE TABLE
           is on — clicking it downloads the frozen wavetable as a portable
           JSON file (see buildWavetableExport for the payload shape). -->
      <div class="section-header">
        <span class="section-label">LIVE WAVETABLE (WAVECEL)</span>
        {#if isFrozen}
          <button
            type="button"
            class="export-btn"
            data-testid="foxy-export-table"
            title="Export the frozen wavetable as JSON"
            onclick={exportTable}
          >↓ EXPORT</button>
        {/if}
      </div>
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
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .foxy-card {
    /* 2-column layout: wider + shorter than the single-column ancestor
       (was 360 × 620). Left col carries the sources/rasters/XYZ scope,
       right col carries the wavetable controls + LIVE WAVETABLE. */
    width: 720px;
    min-height: 320px;
  }
  .foxy-card .card-grid {
    display: flex;
    flex-direction: row;
    gap: 18px;
    width: 100%;
  }
  .foxy-card .card-col {
    flex: 1 1 50%;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .foxy-card .card-col-left {
    border-right: 1px solid var(--module-bg, #1a1f2a);
    padding-right: 12px;
  }
  /* Narrow-card fallback — collapse to single column to preserve usability
     when the card is shrunk by the canvas zoom / layout chrome. */
  @media (max-width: 560px) {
    .foxy-card { width: 100%; }
    .foxy-card .card-grid { flex-direction: column; }
    .foxy-card .card-col-left { border-right: 0; padding-right: 0; }
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
    /* FIXED pixel size matching the canvas bitmap (280×110) so the rendered
     * element never CSS-stretches with the card. The rack forces FOXY to its 4u
     * tier (720px tall, taller than its natural content, #759); a `width: 100%`
     * canvas re-rasterized on every layout reflow of the stretched card, so two
     * screenshots 2s apart drifted by a few bytes and broke the freeze-equality
     * e2e. A fixed px box makes the frozen-wavetable snapshots byte-stable. */
    width: 280px;
    height: 110px;
    margin: 0 auto;
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
  .foxy-card .freeze-btn {
    margin-top: 2px;
    background: rgba(20, 24, 32, 0.85);
    color: var(--text, #d8dde6);
    border: 1px solid #404652;
    border-radius: 2px;
    padding: 1px 6px;
    font-size: 0.5rem;
    cursor: pointer;
    letter-spacing: 0.08em;
    font-family: ui-monospace, monospace;
  }
  .foxy-card .freeze-btn:hover { border-color: #6a7282; }
  .foxy-card .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-top: 4px;
  }
  .foxy-card .section-header .section-label {
    margin-top: 0;
  }
  .foxy-card .export-btn {
    background: rgba(20, 24, 32, 0.85);
    color: var(--text, #d8dde6);
    border: 1px solid #404652;
    border-radius: 2px;
    padding: 1px 8px;
    font-size: 0.55rem;
    cursor: pointer;
    letter-spacing: 0.08em;
    font-family: ui-monospace, monospace;
  }
  .foxy-card .export-btn:hover {
    border-color: #6a7282;
    background: rgba(40, 48, 60, 0.95);
  }
  .foxy-card .freeze-btn[aria-pressed="true"] {
    background: var(--cable-cv, #6cf);
    color: #000;
    border-color: var(--cable-cv, #6cf);
  }
  .foxy-card .knob-row {
    display: flex;
    justify-content: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .foxy-card .mode-group {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    /* Wide enough for "3D Shape Gen". */
    min-width: 96px;
  }
  .foxy-card .mode-name {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 0.62rem;
    letter-spacing: 0.02em;
    color: #ffce6e;
    text-align: center;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
  }
  .foxy-card .sync-row {
    align-items: center;
  }
  .foxy-card .sync-mode-name {
    font-size: 0.6rem;
    color: var(--text, #d8dde6);
    letter-spacing: 0.1em;
    font-family: ui-monospace, monospace;
    padding: 2px 8px;
    border: 1px solid #404652;
    border-radius: 2px;
    background: rgba(20, 24, 32, 0.85);
  }
</style>
