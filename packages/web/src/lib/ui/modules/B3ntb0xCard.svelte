<script lang="ts">
  // B3ntb0xCard — circuit-level NTSC composite re-arch OUTPUT.
  //
  // Same per-card 2D-canvas blit pattern as BentboxCard / VideoOutCard: ask
  // the VideoEngine to render THIS instance's FBO (the CRT front buffer) into
  // its drawing buffer, then drawImage() into our visible <canvas>. Resize via
  // the shared startCornerResize helper. The whole 4-pass pipeline renders an
  // ENGINE_W×ENGINE_H 4:3 FBO; we letterbox at the SOURCE aspect (never
  // re-impose any other aspect here — the 4:3 active area + barrel/overscan
  // live INSIDE the CRT shader).
  //
  // Knobs are grouped by circuit stage below the screen:
  //   ENCODE/BEND : Enhance, Bias, AC/DC, Sync Crush, Burst Starve, Hue
  //   DECODE      : Chroma Leak, Luma Peak, TBC/Lock, Drift
  //   BEND NET    : Bend A, Bend B, Bend C, Bend D
  //   CRT         : Feedback, Tube Bloom, Overscan, Barrel

  import { onMount, onDestroy } from 'svelte';
  import { Handle, Position, useStore, type NodeProps } from '@xyflow/svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { patch } from '$lib/graph/store';
  import { startCornerResize } from './card-resize';
  import { createFullscreen } from './use-fullscreen.svelte';
  import { createFullFrame } from './use-full-frame.svelte';
  import VideoCanvasContextMenu from './VideoCanvasContextMenu.svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import type { VideoEngine } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';
  import { b3ntb0xDef } from '$lib/video/modules/b3ntb0x';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();
  const flowStore = useStore();

  // ---------------- Resize (mirror BentboxCard) ----------------
  const DEFAULT_WIDTH = 460;
  const DEFAULT_HEIGHT = 540;
  const MIN_WIDTH = 360;
  const MIN_HEIGHT = 400;

  // Engine render resolution — matches VIDEO_RES in video/engine.ts (4:3).
  const ENGINE_W = 640;
  const ENGINE_H = 480;

  let cardWidth = $derived<number>((node?.data?.width as number | undefined) ?? DEFAULT_WIDTH);
  let cardHeight = $derived<number>((node?.data?.height as number | undefined) ?? DEFAULT_HEIGHT);

  const HEADER_PX = 52;
  const KNOBS_PX = 280;
  const PAD_PX = 20;
  let innerWidth = $derived(Math.max(MIN_WIDTH - PAD_PX, cardWidth - PAD_PX));
  let screenAreaH = $derived(Math.max(120, cardHeight - HEADER_PX - KNOBS_PX));

  let canvasEl: HTMLCanvasElement | null = $state(null);
  let rafId: number | null = null;

  // Reduced-precision badge — true when the GPU couldn't allocate float FBOs.
  let reducedPrecision = $state(false);

  // ---------- True fullscreen ----------
  const fs = createFullscreen();
  let wrapEl: HTMLDivElement | null = $state(null);
  $effect(() => { fs.setTarget(wrapEl); });
  $effect(() => fs.attach());

  // ---------- Full Frame (in-app) ----------
  let fullFrame = $derived<boolean>((node?.data?.fullFrame as boolean | undefined) ?? false);
  const ff = createFullFrame({
    setFullFrame: (on) => {
      const target = patch.nodes[id];
      if (target) {
        if (!target.data) target.data = {};
        target.data.fullFrame = on;
      }
    },
    exitFullscreen: () => void fs.exit(),
  });
  let cardEl: HTMLDivElement | null = $state(null);
  $effect(() => ff.attach(cardEl, () => fullFrame));

  let ctxOpen = $state(false);
  let ctxX = $state(0);
  let ctxY = $state(0);
  function onCanvasContextMenu(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    ctxX = e.clientX;
    ctxY = e.clientY;
    ctxOpen = true;
  }

  /** Letterbox the engine frame at the PIPELINE aspect (ENGINE_W/ENGINE_H).
   *  Do NOT re-impose any other aspect — the 4:3 active area + overscan +
   *  barrel live inside the CRT shader. */
  function fitRect(cw: number, ch: number): { x: number; y: number; w: number; h: number } {
    const SRC = ENGINE_W / ENGINE_H;
    const dstAspect = cw / ch;
    if (dstAspect > SRC) {
      const h = ch;
      const w = Math.round(h * SRC);
      return { x: Math.round((cw - w) / 2), y: 0, w, h };
    } else {
      const w = cw;
      const h = Math.round(w / SRC);
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
    try { videoEngine = e.getDomain<VideoEngine>('video'); } catch { videoEngine = undefined; }
    if (!videoEngine) {
      rafId = requestAnimationFrame(draw);
      return;
    }
    const ctx2d = canvasEl.getContext('2d', { alpha: false });
    if (ctx2d) {
      try { videoEngine.blitOutputToDrawingBuffer(id); } catch { /* defensive */ }
      const src = videoEngine.canvas as CanvasImageSource;
      const cw = canvasEl.width;
      const ch = canvasEl.height;
      ctx2d.fillStyle = '#050608';
      ctx2d.fillRect(0, 0, cw, ch);
      const r = fitRect(cw, ch);
      // drawImage from a WebGL canvas is already upright — no Y-flip.
      ctx2d.drawImage(src, r.x, r.y, r.w, r.h);
    }
    // Reflect gate-toggled mirror state back into the store + read the
    // reduced-precision flag for the badge.
    try {
      for (const k of ['mirrorX', 'mirrorY'] as const) {
        const live = e.readParam(node, k);
        if (typeof live !== 'number') continue;
        const stored = patch.nodes[id]?.params[k] ?? 0;
        if ((live >= 0.5) !== (stored >= 0.5)) {
          const t = patch.nodes[id];
          if (t) t.params[k] = live >= 0.5 ? 1 : 0;
        }
      }
      const vh = videoEngine.read?.(id, 'isFloat');
      if (typeof vh === 'boolean') reducedPrecision = !vh;
    } catch { /* defensive */ }
    rafId = requestAnimationFrame(draw);
  }

  onMount(() => { rafId = requestAnimationFrame(draw); });
  onDestroy(() => {
    if (rafId !== null) cancelAnimationFrame(rafId);
    if (resizeAbort) resizeAbort.abort();
  });

  // ---------------- Resize handle ----------------
  let resizing = $state(false);
  let resizeAbort: AbortController | null = null;
  function onResizeStart(ev: PointerEvent) {
    resizeAbort = startCornerResize(ev, {
      flowStore,
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      getStartSize: () => ({ width: cardWidth, height: cardHeight }),
      apply: (w, h) => {
        const target = patch.nodes[id];
        if (target) {
          if (!target.data) target.data = {};
          target.data.width = w;
          target.data.height = h;
        }
      },
      onStart: () => { resizing = true; },
      onEnd: () => { resizing = false; resizeAbort = null; },
    });
  }

  // ---------------- Knob plumbing ----------------
  const defaultFor = (key: string): number =>
    b3ntb0xDef.params.find((p) => p.id === key)!.defaultValue;
  const set = (k: string) => (v: number) => { const t = patch.nodes[id]; if (t) t.params[k] = v; };
  const live = (k: string) => () => {
    const e = engineCtx.get(); if (!e || !node) return undefined;
    return e.readParam(node, k);
  };

  let enhance      = $derived(node?.params.enhance      ?? defaultFor('enhance'));
  let bias         = $derived(node?.params.bias         ?? defaultFor('bias'));
  let ac_dc        = $derived(node?.params.ac_dc        ?? defaultFor('ac_dc'));
  let sync_crush   = $derived(node?.params.sync_crush   ?? defaultFor('sync_crush'));
  let burst_starve = $derived(node?.params.burst_starve ?? defaultFor('burst_starve'));
  let hue          = $derived(node?.params.hue          ?? defaultFor('hue'));
  let chroma_leak  = $derived(node?.params.chroma_leak  ?? defaultFor('chroma_leak'));
  let luma_peak    = $derived(node?.params.luma_peak    ?? defaultFor('luma_peak'));
  let tbc          = $derived(node?.params.tbc          ?? defaultFor('tbc'));
  let sub_drift    = $derived(node?.params.sub_drift    ?? defaultFor('sub_drift'));
  let bend_a       = $derived(node?.params.bend_a       ?? defaultFor('bend_a'));
  let bend_b       = $derived(node?.params.bend_b       ?? defaultFor('bend_b'));
  let bend_c       = $derived(node?.params.bend_c       ?? defaultFor('bend_c'));
  let bend_d       = $derived(node?.params.bend_d       ?? defaultFor('bend_d'));
  let feedback     = $derived(node?.params.feedback     ?? defaultFor('feedback'));
  let tube_bloom   = $derived(node?.params.tube_bloom   ?? defaultFor('tube_bloom'));
  let overscan     = $derived(node?.params.overscan     ?? defaultFor('overscan'));
  let barrel       = $derived(node?.params.barrel       ?? defaultFor('barrel'));

  // ---- MIRROR X / MIRROR Y toggles ----
  let mirrorX = $derived((node?.params.mirrorX ?? defaultFor('mirrorX')) >= 0.5);
  let mirrorY = $derived((node?.params.mirrorY ?? defaultFor('mirrorY')) >= 0.5);
  function toggleMirror(paramId: 'mirrorX' | 'mirrorY') {
    return () => {
      const t = patch.nodes[id];
      if (!t) return;
      t.params[paramId] = (t.params[paramId] ?? 0) >= 0.5 ? 0 : 1;
    };
  }

  // PatchPanel MUST list EVERY declared input + output id so handle-presence
  // passes (io-spec-consistency + per-module-per-port).
  const inputs: PortDescriptor[] = [
    { id: 'in',              label: 'IN',    cable: 'video' },
    { id: 'enhance_cv',      label: 'ENH',   cable: 'cv' },
    { id: 'bias_cv',         label: 'BIAS',  cable: 'cv' },
    { id: 'ac_dc_cv',        label: 'AC',    cable: 'cv' },
    { id: 'sync_crush_cv',   label: 'CRSH',  cable: 'cv' },
    { id: 'burst_starve_cv', label: 'BRST',  cable: 'cv' },
    { id: 'chroma_leak_cv',  label: 'CHRM',  cable: 'cv' },
    { id: 'luma_peak_cv',    label: 'LUMA',  cable: 'cv' },
    { id: 'bend_a_cv',       label: 'BNDA',  cable: 'cv' },
    { id: 'bend_b_cv',       label: 'BNDB',  cable: 'cv' },
    { id: 'bend_c_cv',       label: 'BNDC',  cable: 'cv' },
    { id: 'bend_d_cv',       label: 'BNDD',  cable: 'cv' },
    { id: 'feedback_cv',     label: 'FBK',   cable: 'cv' },
    { id: 'tbc_cv',          label: 'TBC',   cable: 'cv' },
    { id: 'tube_bloom_cv',   label: 'BLM',   cable: 'cv' },
    { id: 'overscan_cv',     label: 'OVSC',  cable: 'cv' },
    { id: 'barrel_cv',       label: 'BARL',  cable: 'cv' },
    { id: 'mirror_x_gate',   label: 'MIRX',  cable: 'cv' },
    { id: 'mirror_y_gate',   label: 'MIRY',  cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'out', label: 'OUT', cable: 'video' },
  ];
</script>

<div
  bind:this={cardEl}
  class="card b3ntb0x"
  class:resizing
  class:full-frame={fullFrame}
  style="width: {cardWidth}px; height: {cardHeight}px;"
  data-testid="b3ntb0x-card"
  data-node-id={id}
  data-full-frame={fullFrame}
>
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="B3NTB0X" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      bind:this={wrapEl}
      class="screen-wrap"
      class:fullscreen={fs.isFullscreen}
      class:full-frame={fullFrame}
      style="width: {fs.isFullscreen || fullFrame ? '100%' : innerWidth + 'px'}; height: {fs.isFullscreen || fullFrame ? '100%' : screenAreaH + 'px'};"
      data-testid="b3ntb0x-fs-wrap"
      oncontextmenu={onCanvasContextMenu}
    >
      <canvas
        bind:this={canvasEl}
        width={innerWidth}
        height={screenAreaH}
        style="aspect-ratio: {innerWidth} / {screenAreaH};"
        data-testid="b3ntb0x-canvas"
        data-node-id={id}
      ></canvas>
      {#if reducedPrecision}
        <div class="precision-badge" data-testid="b3ntb0x-reduced-precision">reduced precision (no float FBO)</div>
      {/if}
    </div>

    <div class="knob-grid">
      <Knob value={enhance}      min={0}  max={1} defaultValue={0}    label="Enhance"     curve="linear" onchange={set('enhance')} moduleId={id} paramId="enhance" readLive={live('enhance')} />
      <Knob value={bias}         min={-1} max={1} defaultValue={0}    label="Bias"        curve="linear" onchange={set('bias')} moduleId={id} paramId="bias" readLive={live('bias')} />
      <Knob value={ac_dc}        min={0}  max={1} defaultValue={0}    label="AC/DC"       curve="linear" onchange={set('ac_dc')} moduleId={id} paramId="ac_dc" readLive={live('ac_dc')} />
      <Knob value={sync_crush}   min={0}  max={2} defaultValue={1}    label="Sync Crush"  curve="linear" onchange={set('sync_crush')} moduleId={id} paramId="sync_crush" readLive={live('sync_crush')} />
      <Knob value={burst_starve} min={0}  max={1} defaultValue={0}    label="Burst Strv"  curve="linear" onchange={set('burst_starve')} moduleId={id} paramId="burst_starve" readLive={live('burst_starve')} />

      <Knob value={chroma_leak}  min={0}  max={1} defaultValue={0.15} label="Chroma Lk"   curve="linear" onchange={set('chroma_leak')} moduleId={id} paramId="chroma_leak" readLive={live('chroma_leak')} />
      <Knob value={luma_peak}    min={0}  max={1} defaultValue={0}    label="Luma Peak"   curve="linear" onchange={set('luma_peak')} moduleId={id} paramId="luma_peak" readLive={live('luma_peak')} />
      <Knob value={tbc}          min={0}  max={1} defaultValue={1}    label="TBC/Lock"    curve="linear" onchange={set('tbc')} moduleId={id} paramId="tbc" readLive={live('tbc')} />
      <Knob value={hue}          min={-1} max={1} defaultValue={0}    label="Hue"         curve="linear" onchange={set('hue')} moduleId={id} paramId="hue" readLive={live('hue')} />
      <Knob value={sub_drift}    min={0}  max={1} defaultValue={0}    label="Drift"       curve="linear" onchange={set('sub_drift')} moduleId={id} paramId="sub_drift" readLive={live('sub_drift')} />

      <Knob value={bend_a}       min={-1} max={1} defaultValue={0}    label="Bend A"      curve="linear" onchange={set('bend_a')} moduleId={id} paramId="bend_a" readLive={live('bend_a')} />
      <Knob value={bend_b}       min={-1} max={1} defaultValue={0}    label="Bend B"      curve="linear" onchange={set('bend_b')} moduleId={id} paramId="bend_b" readLive={live('bend_b')} />
      <Knob value={bend_c}       min={-1} max={1} defaultValue={0}    label="Bend C"      curve="linear" onchange={set('bend_c')} moduleId={id} paramId="bend_c" readLive={live('bend_c')} />
      <Knob value={bend_d}       min={-1} max={1} defaultValue={0}    label="Bend D"      curve="linear" onchange={set('bend_d')} moduleId={id} paramId="bend_d" readLive={live('bend_d')} />

      <Knob value={feedback}     min={0}  max={1} defaultValue={0}    label="Feedback"    curve="linear" onchange={set('feedback')} moduleId={id} paramId="feedback" readLive={live('feedback')} />
      <Knob value={tube_bloom}   min={0}  max={1} defaultValue={0.35} label="Tube Bloom"  curve="linear" onchange={set('tube_bloom')} moduleId={id} paramId="tube_bloom" readLive={live('tube_bloom')} />
      <Knob value={overscan}     min={0}  max={1} defaultValue={0.2}  label="Overscan"    curve="linear" onchange={set('overscan')} moduleId={id} paramId="overscan" readLive={live('overscan')} />
      <Knob value={barrel}       min={0}  max={1} defaultValue={0.25} label="Barrel"      curve="linear" onchange={set('barrel')} moduleId={id} paramId="barrel" readLive={live('barrel')} />
    </div>

    <div class="mirror-row" data-testid="b3ntb0x-mirror-row">
      <button
        type="button"
        class="mirror-btn nodrag"
        class:on={mirrorX}
        data-testid="b3ntb0x-mirror-x"
        title="MIRROR X — fold the left half over the right (kaleidoscope)"
        onclick={toggleMirror('mirrorX')}
      >MIRROR X</button>
      <button
        type="button"
        class="mirror-btn nodrag"
        class:on={mirrorY}
        data-testid="b3ntb0x-mirror-y"
        title="MIRROR Y — fold the top half over the bottom (kaleidoscope)"
        onclick={toggleMirror('mirrorY')}
      >MIRROR Y</button>
    </div>
  </PatchPanel>

  <div
    class="resize-handle nodrag"
    role="separator"
    aria-label="Resize B3NTB0X"
    data-testid="b3ntb0x-resize-handle"
    onpointerdown={onResizeStart}
  ></div>
</div>

<VideoCanvasContextMenu
  bind:open={ctxOpen}
  x={ctxX}
  y={ctxY}
  title="B3NTB0X"
  availableScreens={fs.availableScreens}
  onrequestscreens={() => void fs.loadScreens()}
  onfullscreen={(screenId) => { ff.exit(); void fs.enter(screenId); }}
  onfullframe={() => ff.toggle(fullFrame)}
  isFullFrame={fullFrame}
  onclose={() => { ctxOpen = false; }}
/>

<style>
  .card.b3ntb0x {
    background-color: #000;
    background-image: linear-gradient(var(--module-bg), var(--module-bg));
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text);
    padding-top: 18px;
    padding-bottom: 14px;
    position: relative;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    transition: border-color 80ms ease-out, box-shadow 80ms ease-out;
    overflow: hidden;
    isolation: isolate;
  }
  :global(.svelte-flow__node:hover) .card.b3ntb0x {
    border-color: var(--accent-dim);
  }
  :global(.svelte-flow__node.selected) .card.b3ntb0x {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .card.b3ntb0x.resizing { transition: none; }
  .stripe {
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    border-radius: 2px 2px 0 0;
    background: var(--cable-video);
  }
  .screen-wrap {
    margin: 0 auto 10px;
    display: flex;
    justify-content: center;
    align-items: center;
    position: relative;
  }
  .screen-wrap canvas {
    background: #050608;
    border: 1px solid var(--cable-video);
    border-radius: 1px;
    image-rendering: auto;
    width: 100%;
    height: 100%;
    display: block;
  }
  .precision-badge {
    position: absolute;
    left: 4px;
    bottom: 4px;
    font-size: 0.55rem;
    letter-spacing: 0.04em;
    color: #ffd27f;
    background: rgba(0, 0, 0, 0.65);
    border: 1px solid rgba(255, 210, 127, 0.5);
    border-radius: 2px;
    padding: 1px 4px;
    pointer-events: none;
    font-family: ui-monospace, monospace;
  }
  .screen-wrap.fullscreen {
    margin: 0;
    width: 100%;
    height: 100%;
    background: #000;
  }
  .screen-wrap.fullscreen canvas {
    border: none;
    border-radius: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
    cursor: pointer;
  }
  .card.b3ntb0x.full-frame {
    padding: 0;
  }
  .card.b3ntb0x.full-frame .title,
  .card.b3ntb0x.full-frame .stripe,
  .card.b3ntb0x.full-frame .knob-grid,
  .card.b3ntb0x.full-frame .mirror-row {
    display: none;
  }
  .card.b3ntb0x.full-frame :global(.patch-trigger) {
    opacity: 0;
    pointer-events: none;
  }
  .card.b3ntb0x.full-frame :global(.svelte-flow__handle) {
    opacity: 0;
    pointer-events: none;
  }
  .screen-wrap.full-frame {
    margin: 0;
    width: 100%;
    height: 100%;
    background: #000;
    cursor: pointer;
  }
  .screen-wrap.full-frame canvas {
    border: none;
    border-radius: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
  .card.b3ntb0x.full-frame :global(.patch-panel-host) {
    display: contents;
  }
  .knob-grid {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 6px 8px;
    padding: 0 8px;
  }
  .mirror-row {
    display: flex;
    gap: 8px;
    justify-content: center;
    margin-top: 8px;
    padding: 0 8px;
  }
  .mirror-btn {
    flex: 1;
    background: var(--module-bg);
    color: var(--text-dim);
    border: 1px solid var(--border);
    border-radius: 3px;
    font-size: 0.6rem;
    letter-spacing: 0.08em;
    padding: 4px 6px;
    cursor: pointer;
    font-family: ui-monospace, monospace;
  }
  .mirror-btn.on {
    background: var(--accent-dim, #46506b);
    color: var(--text);
    border-color: var(--accent, #6884d7);
  }
  .mirror-btn:hover { border-color: var(--accent-dim); }
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
