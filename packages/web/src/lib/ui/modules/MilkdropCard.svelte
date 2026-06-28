<script lang="ts">
  // MilkdropCard — UI for the MILKDROP butterchurn visualizer. ONE audio input
  // + per-band CV overrides (bass/mid/treb) + reactivity/speed/preset/morph CV
  // + a NEXT trigger, all on the yellow drill-down PatchPanel (NO raw side
  // jacks, #767 standard). On-card live preview pulled from the engine via
  // drawImage(engine.canvas, …) (same path as RUTTETRA / VIDEO-OUT), plus a
  // preset name/index readout and knobs for the CV-targetable params.
  //
  // Layout + hide-controls/corner-resize mirror RuttetraCard. The preset
  // readout is DISPLAY-ONLY (polled from engine.read each frame, never written
  // to the Y.Doc).

  import { onMount, onDestroy } from 'svelte';
  import { useStore, type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { useEngine } from '$lib/audio/engine-context';
  import { patch } from '$lib/graph/store';
  import { setNodeParam } from '$lib/graph/mutate';
  import { milkdropDef, MILKDROP_CURATED_NAMES } from '$lib/video/modules/milkdrop';
  import { convertMilkPreset, resolvePresetNames } from '$lib/video/milkdrop-preset-loader';
  import { startCornerResize } from './card-resize';
  import type { VideoEngine } from '$lib/video/engine';
  import { VIDEO_RES } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();
  const flowStore = useStore();

  function pdef(name: string): number {
    return milkdropDef.params.find((d) => d.id === name)?.defaultValue ?? 0;
  }
  function pmax(name: string): number {
    return milkdropDef.params.find((d) => d.id === name)?.max ?? 1;
  }
  function p(name: string): number {
    return node?.params[name] ?? pdef(name);
  }
  function setParam(paramId: string) {
    return (v: number) => setNodeParam(id, paramId, v);
  }

  // 1 audio input + 7 cv inputs + 1 gate trigger. Port id MUST match the def.
  const inputs: PortDescriptor[] = [
    { id: 'audio', label: 'AUD', cable: 'audio' },
    { id: 'bass', label: 'BAS', cable: 'cv' },
    { id: 'mid', label: 'MID', cable: 'cv' },
    { id: 'treb', label: 'TRB', cable: 'cv' },
    { id: 'reactivity', label: 'RCT', cable: 'cv' },
    { id: 'speed', label: 'SPD', cable: 'cv' },
    { id: 'presetSelect', label: 'PST', cable: 'cv' },
    { id: 'morph', label: 'MPH', cable: 'cv' },
    { id: 'next', label: 'NXT', cable: 'gate' },
  ];
  const outputs: PortDescriptor[] = [{ id: 'out', cable: 'video' }];

  const ENGINE_W = VIDEO_RES.width;
  const ENGINE_H = VIDEO_RES.height;
  const CANVAS_W = 280;
  const CANVAS_H = 158;

  const MIN_WIDTH = 360;
  const MIN_HEIGHT = 180;
  const DEFAULT_WIDTH = 360;
  const DEFAULT_HEIGHT = 360;
  const HEADER_PX = 56;
  const PAD_PX = 20;

  let hideControls = $derived<boolean>(Boolean(node?.data?.hideControls));
  let resizedWidth = $derived<number>((node?.data?.resizedWidth as number | undefined) ?? DEFAULT_WIDTH);
  let resizedHeight = $derived<number>((node?.data?.resizedHeight as number | undefined) ?? DEFAULT_HEIGHT);
  let innerWidth = $derived(Math.max(MIN_WIDTH - PAD_PX, resizedWidth - PAD_PX));
  let innerHeight = $derived(Math.max(MIN_HEIGHT - HEADER_PX, resizedHeight - HEADER_PX));

  let canvasEl: HTMLCanvasElement | null = $state(null);
  let rafId: number | null = null;

  // DISPLAY-ONLY preset readout (polled from engine.read, never synced).
  let presetName = $state('');
  let presetIndex = $state(0);
  let presetCount = $state(0);
  let ready = $state(false);

  // ---- Preset PICKER state ----
  // The engine's LIVE name list (curated, pack-drift-filtered, + in-session
  // customs), re-read ONLY when the count changes (cheap), never per frame.
  let liveNames = $state<string[]>([]);
  let lastNamesKey = -1;
  // The names the dropdown shows: live list once ready, else the curated
  // fallback so the picker is populated before the lazy pack chunk resolves.
  let pickerNames = $derived(resolvePresetNames(liveNames, MILKDROP_CURATED_NAMES));
  // Custom .milk import status line (transient UI feedback).
  let milkStatus = $state('');
  let milkBusy = $state(false);

  function getVideoEngine(): VideoEngine | null {
    const e = engineCtx.get();
    if (!e) return null;
    try {
      return e.getDomain<VideoEngine>('video') ?? null;
    } catch {
      return null;
    }
  }

  // Picker → select a preset by its index in the live list. Routes through the
  // SAME presetSelect param the PST knob / PRESET CV / NEXT trigger drive, so
  // the selection stays in sync everywhere (and persists with the patch).
  function onPickPreset(ev: Event) {
    const idx = Number((ev.currentTarget as HTMLSelectElement).value);
    if (!Number.isFinite(idx)) return;
    setNodeParam(id, 'presetSelect', idx);
  }

  // "Load .milk…" → read the file, convert it to butterchurn JSON in-browser,
  // and hand it to the engine handle's loadCustomPreset command (which appends
  // it to the in-session picker list + loads it with a MORPH-second crossfade).
  async function onPickMilk(ev: Event) {
    const input = ev.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // allow re-picking the same file
    if (!file) return;
    milkBusy = true;
    milkStatus = `converting ${file.name}…`;
    try {
      const text = await file.text();
      const preset = await convertMilkPreset(text);
      const engine = getVideoEngine();
      const loader = engine?.read(id, 'loadCustomPreset') as
        | ((preset: unknown, name: string, blend: number) => number)
        | undefined;
      if (typeof loader !== 'function') {
        milkStatus = 'engine not ready — try again';
        return;
      }
      const name = file.name.replace(/\.milk$/i, '');
      loader(preset, name, p('morph'));
      milkStatus = `loaded ${name}`;
    } catch (e) {
      console.warn('[milkdrop] .milk import failed:', e);
      milkStatus = "couldn't load that .milk file";
    } finally {
      milkBusy = false;
    }
  }

  function fitRect(cw: number, ch: number): { x: number; y: number; w: number; h: number } {
    const srcAspect = ENGINE_W / ENGINE_H;
    const dstAspect = cw / ch;
    if (dstAspect > srcAspect) {
      const h = ch;
      const w = Math.round(h * srcAspect);
      return { x: Math.round((cw - w) / 2), y: 0, w, h };
    } else {
      const w = cw;
      const h = Math.round(w / srcAspect);
      return { x: 0, y: Math.round((ch - h) / 2), w, h };
    }
  }

  function draw() {
    rafId = null;
    const e = engineCtx.get();
    if (!e || !canvasEl) {
      rafId = requestAnimationFrame(draw);
      return;
    }
    let videoEngine: VideoEngine | undefined;
    try {
      videoEngine = e.getDomain<VideoEngine>('video');
    } catch {
      rafId = requestAnimationFrame(draw);
      return;
    }
    if (!videoEngine) {
      rafId = requestAnimationFrame(draw);
      return;
    }
    // Poll the display-only preset readout.
    try {
      ready = Boolean(videoEngine.read(id, 'ready'));
      presetName = (videoEngine.read(id, 'presetName') as string) ?? '';
      presetIndex = (videoEngine.read(id, 'presetIndex') as number) ?? 0;
      presetCount = (videoEngine.read(id, 'presetCount') as number) ?? 0;
      // Refresh the picker's live name list ONLY when the list size changes
      // (first load, or a custom .milk appended) — not the per-frame array alloc.
      const namesKey = ready ? presetCount : -1;
      if (namesKey !== lastNamesKey) {
        liveNames = (videoEngine.read(id, 'presetNames') as string[]) ?? [];
        lastNamesKey = namesKey;
      }
    } catch {
      /* engine churn — ignore */
    }
    const ctx2d = canvasEl.getContext('2d', { alpha: false });
    if (ctx2d) {
      try {
        videoEngine.blitOutputToDrawingBuffer(id);
      } catch {
        /* never let an engine error nuke the rAF loop */
      }
      const src = videoEngine.canvas as CanvasImageSource;
      const cw = canvasEl.width;
      const ch = canvasEl.height;
      ctx2d.fillStyle = '#050608';
      ctx2d.fillRect(0, 0, cw, ch);
      const r = fitRect(cw, ch);
      ctx2d.drawImage(src, r.x, r.y, r.w, r.h);
    }
    rafId = requestAnimationFrame(draw);
  }

  onMount(() => {
    rafId = requestAnimationFrame(draw);
  });
  onDestroy(() => {
    if (rafId !== null) cancelAnimationFrame(rafId);
    if (resizeAbort) resizeAbort.abort();
  });

  // ---------- Hide-controls toggle + corner-drag resize ----------
  let resizing = $state(false);
  let resizeAbort: AbortController | null = null;

  function toggleHideControls(ev: MouseEvent) {
    ev.preventDefault();
    ev.stopPropagation();
    const target = patch.nodes[id];
    if (!target) return;
    if (!target.data) target.data = {};
    const next = !target.data.hideControls;
    target.data.hideControls = next;
    if (!next) {
      delete target.data.resizedWidth;
      delete target.data.resizedHeight;
    }
  }

  function onResizeStart(ev: PointerEvent) {
    resizeAbort = startCornerResize(ev, {
      flowStore,
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      getStartSize: () => ({ width: resizedWidth, height: resizedHeight }),
      apply: (w, h) => {
        const target = patch.nodes[id];
        if (target) {
          if (!target.data) target.data = {};
          target.data.resizedWidth = w;
          target.data.resizedHeight = h;
        }
      },
      onStart: () => { resizing = true; },
      onEnd: () => { resizing = false; resizeAbort = null; },
    });
  }

  function onBodyDblClick(ev: MouseEvent) {
    if (!hideControls) return;
    const t = ev.target as HTMLElement | null;
    if (t && t.closest('.svelte-flow__handle')) return;
    ev.stopPropagation();
    const target = patch.nodes[id];
    if (!target) return;
    if (!target.data) target.data = {};
    target.data.hideControls = false;
    delete target.data.resizedWidth;
    delete target.data.resizedHeight;
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions a11y_no_noninteractive_element_interactions -->
<div
  class="card video"
  class:hide-controls={hideControls}
  class:resizing
  style={hideControls ? `width: ${resizedWidth}px; height: ${resizedHeight}px;` : ''}
  data-testid="milkdrop-card"
  data-node-id={id}
  data-hide-controls={hideControls ? 'true' : 'false'}
  ondblclick={onBodyDblClick}
>
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="MILKDROP" />

  <button
    type="button"
    class="hide-toggle nodrag"
    aria-label={hideControls ? 'Show MILKDROP controls' : 'Hide MILKDROP controls'}
    title={hideControls ? 'Show controls (or double-click frame)' : 'Hide controls'}
    data-testid="milkdrop-hide-toggle"
    onclick={toggleHideControls}
  >{hideControls ? '+' : '–'}</button>

  <PatchPanel nodeId={id} {inputs} {outputs}>
  {#if hideControls}
    <div class="canvas-wrap canvas-wrap-resizable" style="width: {innerWidth}px; height: {innerHeight}px;">
      <canvas
        bind:this={canvasEl}
        width={innerWidth}
        height={innerHeight}
        data-testid="milkdrop-canvas"
        data-node-id={id}
      ></canvas>
    </div>
    <div
      class="resize-handle nodrag"
      role="separator"
      aria-label="Resize MILKDROP"
      data-testid="milkdrop-resize-handle"
      onpointerdown={onResizeStart}
    ></div>
  {:else}
    <div class="canvas-wrap">
      <canvas
        bind:this={canvasEl}
        width={CANVAS_W}
        height={CANVAS_H}
        data-testid="milkdrop-canvas"
        data-node-id={id}
      ></canvas>
    </div>

    <div class="readout" data-testid="milkdrop-preset">
      <span class="preset-idx">{ready ? `${presetIndex + 1}/${presetCount}` : '…'}</span>
      <span class="preset-name" title={presetName}>{presetName || (ready ? '' : 'loading presets…')}</span>
    </div>

    <div class="controls" data-testid="milkdrop-controls">
      <!-- Preset PICKER: browse/load by name. Drives the SAME presetSelect param
           as the PST knob / PRESET CV / NEXT trigger, so all stay in sync. A
           <select> + file <button> are exempt from the MIDI-learn audit. -->
      <div class="picker" data-testid="milkdrop-picker">
        <select
          class="preset-select nodrag"
          data-testid="milkdrop-preset-select"
          aria-label="Milkdrop preset"
          onchange={onPickPreset}
        >
          {#each pickerNames as name, i (i + ':' + name)}
            <option value={i} selected={i === presetIndex}>{i + 1}. {name}</option>
          {/each}
        </select>
        <label class="milk-load nodrag" title="Load a classic Winamp Milkdrop .milk preset file">
          <input
            type="file"
            accept=".milk"
            data-testid="milkdrop-milk-input"
            onchange={onPickMilk}
            disabled={milkBusy}
          />
          <span>{milkBusy ? '…' : 'Load .milk…'}</span>
        </label>
      </div>
      {#if milkStatus}
        <p class="milk-status" data-testid="milkdrop-milk-status">{milkStatus}</p>
      {/if}

      <div class="fader-grid four">
        <Fader value={p('reactivity')} min={0} max={2} defaultValue={pdef('reactivity')} label="RCT" curve="linear" onchange={setParam('reactivity')} moduleId={id} paramId="reactivity" />
        <Fader value={p('speed')} min={0} max={2} defaultValue={pdef('speed')} label="SPD" curve="linear" onchange={setParam('speed')} moduleId={id} paramId="speed" />
        <Fader value={p('presetSelect')} min={0} max={pmax('presetSelect')} defaultValue={pdef('presetSelect')} label="PST" curve="linear" onchange={setParam('presetSelect')} moduleId={id} paramId="presetSelect" />
        <Fader value={p('morph')} min={0} max={8} defaultValue={pdef('morph')} label="MPH" curve="linear" onchange={setParam('morph')} moduleId={id} paramId="morph" />
      </div>
      <p class="hint">BAS/MID/TRB jacks REPLACE that band (open = live audio).</p>
      <p
        class="credit"
        title="Milkdrop visualizer © Ryan Geiss (Winamp Milkdrop). Rendering engine: butterchurn by jberg / the @webamp/butterchurn fork (MIT). Preset import: milkdrop-preset-converter (MIT)."
      >Milkdrop © Ryan Geiss · engine: butterchurn (jberg / @webamp) MIT</p>
    </div>
  {/if}
  </PatchPanel>
</div>

<style>
  .card {
    width: 320px;
    min-height: 420px;
    background: var(--module-bg);
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text);
    padding-top: 18px;
    padding-bottom: 14px;
    position: relative;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    transition: border-color 80ms ease-out, box-shadow 80ms ease-out;
  }
  .card.hide-controls {
    background-color: #000;
    background-image: linear-gradient(var(--module-bg), var(--module-bg));
    min-height: 0;
    padding-bottom: 14px;
    overflow: hidden;
    isolation: isolate;
  }
  .card.resizing { transition: none; }
  :global(.svelte-flow__node:hover) .card { border-color: var(--accent-dim); }
  :global(.svelte-flow__node.selected) .card {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .stripe {
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    border-radius: 2px 2px 0 0;
    background: var(--cable-video);
  }
  .canvas-wrap {
    margin: 12px 18px 8px;
    border: 1px solid var(--cable-video);
    border-radius: 2px;
    overflow: hidden;
    line-height: 0;
    background: #050608;
  }
  .canvas-wrap-resizable {
    margin: 12px auto 0;
    display: flex;
    justify-content: center;
    align-items: center;
    border: 1px solid var(--cable-video);
  }
  canvas {
    display: block;
    width: 100%;
    height: 100%;
    image-rendering: pixelated;
    background: #050608;
  }
  .canvas-wrap:not(.canvas-wrap-resizable) canvas { height: auto; }
  .readout {
    display: flex;
    align-items: baseline;
    gap: 6px;
    padding: 0 18px;
    font-family: ui-monospace, monospace;
    font-size: 0.58rem;
    color: var(--text-dim);
  }
  .preset-idx { color: var(--cable-video); }
  .preset-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .controls { padding: 0 14px; }
  .picker {
    display: flex;
    align-items: stretch;
    gap: 6px;
    margin-top: 10px;
  }
  .preset-select {
    flex: 1 1 auto;
    min-width: 0;
    font-family: ui-monospace, monospace;
    font-size: 0.6rem;
    color: var(--text);
    background: var(--control-bg, #0c0e12);
    border: 1px solid var(--border);
    border-radius: 2px;
    padding: 3px 4px;
    cursor: pointer;
  }
  .preset-select:hover { border-color: var(--cable-video); }
  .milk-load {
    position: relative;
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    font-family: ui-monospace, monospace;
    font-size: 0.58rem;
    color: var(--text-dim);
    background: var(--control-bg, #0c0e12);
    border: 1px solid var(--border);
    border-radius: 2px;
    padding: 3px 6px;
    cursor: pointer;
    white-space: nowrap;
  }
  .milk-load:hover { color: var(--text); border-color: var(--cable-video); }
  /* The native file input fills the label but is visually hidden (the label
     text is the affordance). */
  .milk-load input[type='file'] {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    opacity: 0;
    cursor: pointer;
  }
  .milk-load input[type='file']:disabled { cursor: default; }
  .milk-status {
    margin: 6px 0 0;
    font-size: 0.55rem;
    line-height: 1.3;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fader-grid {
    margin-top: 10px;
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 10px 4px;
    justify-items: center;
  }
  .fader-grid.four { grid-template-columns: repeat(4, 1fr); }
  .hint {
    margin: 10px 0 0;
    font-size: 0.55rem;
    line-height: 1.3;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
  }
  .credit {
    margin: 8px 0 0;
    font-size: 0.5rem;
    line-height: 1.2;
    color: var(--text-dim);
    opacity: 0.6;
    font-family: ui-monospace, monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: help;
  }
  .hide-toggle {
    position: absolute;
    top: 4px;
    right: 26px;
    width: 16px;
    height: 16px;
    padding: 0;
    line-height: 14px;
    font-size: 12px;
    font-family: ui-monospace, monospace;
    color: var(--text-dim);
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 2px;
    cursor: pointer;
    z-index: 6;
  }
  .hide-toggle:hover { color: var(--text); border-color: var(--cable-video); }
  .resize-handle {
    position: absolute;
    right: 0;
    bottom: 0;
    width: 16px;
    height: 16px;
    cursor: nwse-resize;
    background: linear-gradient(
      135deg,
      transparent 50%,
      var(--cable-video) 50%,
      var(--cable-video) 60%,
      transparent 60%,
      transparent 70%,
      var(--cable-video) 70%,
      var(--cable-video) 80%,
      transparent 80%
    );
    opacity: 0.7;
    z-index: 5;
  }
  .resize-handle:hover { opacity: 1; }
</style>
