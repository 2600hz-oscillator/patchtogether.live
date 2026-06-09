<script lang="ts">
  // MandelbulbCard — UI for the MANDELBULB 3D ray-marched fractal source.
  //
  // Card layout:
  //   - Live preview (~200×150) of the video_out render. Pulled from the
  //     engine via blitOutputToDrawingBuffer(id) + drawImage, exactly like
  //     MANDLEBLOT / MONOGLITCH / BENTBOX.
  //   - Six knobs (ZOOM / ROT X / ROT Y / POWER / DETAIL / HUE) — EACH also
  //     has a matching CV input port on the left (zoom + spatial controls
  //     under both CV and knobs, per the user's requirement).
  //   - SPIN + SCRN + SLICE toggle buttons.
  //   - When SLICE is ON: a CUBE-style slice UI appears — TWO displays (the
  //     fractal view with a MOVABLE YELLOW SELECT BOX overlay + a 2D bulb-slice
  //     readout) plus the four slice knobs (Y / S Rot X/Y/Z) with CV ports. The
  //     yellow box drag drives slice_y (vertical) + slice_ry (horizontal). This
  //     mirrors CubeCard's two-display slice widget (a future refactor can pull
  //     a shared SliceSelector component out of both — noted in the PR).
  //   - Patch panel: 6 spatial CV inputs + 4 slice CV inputs, 1 mono-video
  //     output (VIDEO) + 1 mono-audio output (AUDIO, silent when SLICE is OFF).
  //
  // The `audio_out` HANDLE is ALWAYS rendered (a declared port — the
  // handle-presence sweep pins it); it only carries SOUND when SLICE is ON.
  //
  // PERF: the SCRN toggle drives the `screen_on` param. When OFF *and*
  // video_out is unpatched, the engine module skips the (expensive)
  // raymarch. When SCRN is OFF we also stop pulling the preview.

  import { onMount, onDestroy } from 'svelte';
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { setNodeParam } from '$lib/graph/mutate';
  import { mandelbulbDef, MB_SLICE_Y_RANGE } from '$lib/video/modules/mandelbulb';
  import type { VideoEngine } from '$lib/video/engine';
  import { VIDEO_RES } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  // Pure bulb-slice readout — the IDENTICAL fn the engine factory + worklet run,
  // so the 2D slice display matches the sound. Imported via a relative path (the
  // cube.ts / bluebox.ts pattern: worktrees may not symlink the workspace pkg).
  import { mbSampleSlice, type MbSliceParams } from '../../../../../dsp/src/lib/mandelbulb-slice';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  function defaultFor(k: string): number {
    return mandelbulbDef.params.find((p) => p.id === k)?.defaultValue ?? 0;
  }
  function minFor(k: string): number {
    return mandelbulbDef.params.find((p) => p.id === k)?.min ?? 0;
  }
  function maxFor(k: string): number {
    return mandelbulbDef.params.find((p) => p.id === k)?.max ?? 1;
  }
  function paramVal(k: string): number {
    const v = node?.params?.[k];
    return typeof v === 'number' ? v : defaultFor(k);
  }
  const set = (k: string) => (v: number) => {
    setNodeParam(id, k, v);
  };
  const live = (pid: string) => () => {
    const e = engineCtx.get(); if (!e || !node) return undefined;
    return e.readParam(node, pid);
  };
  // Live param read (knob + CV via the engine), falling back to the stored value.
  function liveParam(pid: string, fallback: number): number {
    const e = engineCtx.get();
    if (e && node) { const v = e.readParam(node, pid); if (typeof v === 'number') return v; }
    return paramVal(pid) ?? fallback;
  }

  // Engine render resolution (VIDEO_RES) — letterbox the 4:3 render.
  const ENGINE_W = VIDEO_RES.width;
  const ENGINE_H = VIDEO_RES.height;
  const CANVAS_W = 200;
  const CANVAS_H = Math.round(CANVAS_W * (ENGINE_H / ENGINE_W)); // 150

  let canvasEl: HTMLCanvasElement | null = $state(null);
  let sliceCanvasEl: HTMLCanvasElement | null = $state(null); // 2D bulb-slice readout
  let rafId: number | null = null;

  // SCRN / SPIN / SLICE toggles.
  let screenOn = $derived(paramVal('screen_on') >= 0.5);
  let spinOn = $derived(paramVal('autospin') >= 0.5);
  let sliceOn = $derived(paramVal('slice') >= 0.5);
  function toggleScreen(): void { set('screen_on')(screenOn ? 0 : 1); }
  function toggleSpin(): void { set('autospin')(spinOn ? 0 : 1); }
  function toggleSlice(): void { set('slice')(sliceOn ? 0 : 1); }

  function fitRect(cw: number, ch: number): { x: number; y: number; w: number; h: number } {
    const srcAspect = ENGINE_W / ENGINE_H;
    const dstAspect = cw / ch;
    if (dstAspect > srcAspect) {
      const h = ch;
      const w = Math.round(h * srcAspect);
      return { x: Math.round((cw - w) / 2), y: 0, w, h };
    }
    const w = cw;
    const h = Math.round(w / srcAspect);
    return { x: 0, y: Math.round((ch - h) / 2), w, h };
  }

  // Paint a flat "screen off" panel (cheap + idempotent).
  let screenOffPainted = false;
  function paintScreenOff(): void {
    if (screenOffPainted || !canvasEl) return;
    const c2d = canvasEl.getContext('2d', { alpha: false });
    if (!c2d) return;
    c2d.fillStyle = '#050608';
    c2d.fillRect(0, 0, canvasEl.width, canvasEl.height);
    c2d.fillStyle = 'rgba(255,255,255,0.28)';
    c2d.font = '11px monospace';
    c2d.fillText('SCREEN OFF', 10, 20);
    screenOffPainted = true;
  }

  // ── MOVABLE YELLOW SELECT BOX — drives slice_y (vertical) + slice_ry (horiz) ──
  //
  // The box position is derived from the live slice params: its vertical centre
  // maps slice_y over [-MB_SLICE_Y_RANGE, +MB_SLICE_Y_RANGE]; its horizontal
  // centre maps slice_ry over [-π, +π]. Dragging it writes those params back —
  // the same selection-by-drag interaction CUBE's slice plane offers, surfaced
  // here as an explicit yellow box overlaid on the fractal view.
  const BOX_W = 0.42; // box size as a fraction of the canvas (so it stays inside)
  const BOX_H = 0.30;
  function sliceYToFrac(y: number): number {
    // slice_y ∈ [-R, R] → 0..1 (top = +R). Clamp so the box stays on screen.
    const t = (MB_SLICE_Y_RANGE - y) / (2 * MB_SLICE_Y_RANGE);
    return Math.min(1, Math.max(0, t));
  }
  function sliceRyToFrac(ry: number): number {
    const t = (ry + Math.PI) / (2 * Math.PI);
    return Math.min(1, Math.max(0, t));
  }
  let boxYFrac = $derived(sliceYToFrac(paramVal('slice_y')));
  let boxXFrac = $derived(sliceRyToFrac(paramVal('slice_ry')));

  let dragging = $state(false);
  function pointerToParams(ev: PointerEvent): void {
    const wrap = (ev.currentTarget as HTMLElement);
    const rect = wrap.getBoundingClientRect();
    const fx = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
    const fy = Math.min(1, Math.max(0, (ev.clientY - rect.top) / rect.height));
    // Inverse of sliceYToFrac / sliceRyToFrac.
    const y = MB_SLICE_Y_RANGE - fy * 2 * MB_SLICE_Y_RANGE;
    const ry = fx * 2 * Math.PI - Math.PI;
    set('slice_y')(y);
    set('slice_ry')(ry);
  }
  function onBoxPointerDown(ev: PointerEvent): void {
    if (!sliceOn) return;
    dragging = true;
    (ev.currentTarget as HTMLElement).setPointerCapture?.(ev.pointerId);
    pointerToParams(ev);
    ev.preventDefault();
  }
  function onBoxPointerMove(ev: PointerEvent): void {
    if (!dragging) return;
    pointerToParams(ev);
  }
  function onBoxPointerUp(ev: PointerEvent): void {
    if (!dragging) return;
    dragging = false;
    try { (ev.currentTarget as HTMLElement).releasePointerCapture?.(ev.pointerId); } catch { /* */ }
  }

  // ── 2D bulb-slice readout (display #2) — the waveform mbSampleSlice produces ──
  let lastSliceSig = '';
  function drawSliceReadout(): void {
    if (!sliceCanvasEl) return;
    const ctx2d = sliceCanvasEl.getContext('2d'); if (!ctx2d) return;
    const W = sliceCanvasEl.width, H = sliceCanvasEl.height;
    const sp: MbSliceParams = {
      sliceY: liveParam('slice_y', 0),
      rx: liveParam('slice_rx', 0),
      ry: liveParam('slice_ry', 0),
      rz: liveParam('slice_rz', 0),
      power: Math.max(1, Math.min(12, liveParam('power', 8))),
      iters: Math.max(4, Math.min(30, Math.round(liveParam('detail', 20)))),
    };
    const q = (v: number) => Math.round(v * 1000);
    const sig = `${q(sp.sliceY)}|${q(sp.rx)}|${q(sp.ry)}|${q(sp.rz)}|${q(sp.power)}|${sp.iters}`;
    if (sig === lastSliceSig) return; // perf: only recompute the scan on change
    lastSliceSig = sig;
    const wave = mbSampleSlice(sp);
    ctx2d.fillStyle = '#0a0c12'; ctx2d.fillRect(0, 0, W, H);
    ctx2d.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx2d.beginPath(); ctx2d.moveTo(0, H / 2); ctx2d.lineTo(W, H / 2); ctx2d.stroke();
    ctx2d.strokeStyle = '#ffd83a'; ctx2d.lineWidth = 1.5;
    ctx2d.beginPath();
    const n = wave.length;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * W;
      const yv = H / 2 - (wave[i] ?? 0) * (H / 2) * 0.92;
      if (i === 0) ctx2d.moveTo(x, yv); else ctx2d.lineTo(x, yv);
    }
    ctx2d.stroke();
    ctx2d.fillStyle = 'rgba(255,255,255,0.5)'; ctx2d.font = '9px monospace';
    ctx2d.fillText('SLICE', 5, 12);
  }

  function draw() {
    rafId = requestAnimationFrame(draw);
    // SCRN off ⇒ skip the preview pull entirely (the engine module also
    // skips its render when video_out is unpatched).
    if (!screenOn) { paintScreenOff(); return; }
    screenOffPainted = false;
    const e = engineCtx.get();
    if (!e || !canvasEl) return;
    let videoEngine: VideoEngine | undefined;
    try {
      videoEngine = e.getDomain<VideoEngine>('video');
    } catch {
      return;
    }
    if (!videoEngine) return;
    const ctx2d = canvasEl.getContext('2d', { alpha: false });
    if (!ctx2d) return;
    try {
      videoEngine.blitOutputToDrawingBuffer(id);
    } catch {
      // Don't let engine errors nuke the rAF loop.
    }
    const src = videoEngine.canvas as CanvasImageSource;
    const cw = canvasEl.width;
    const ch = canvasEl.height;
    ctx2d.fillStyle = '#050608';
    ctx2d.fillRect(0, 0, cw, ch);
    const r = fitRect(cw, ch);
    ctx2d.drawImage(src, r.x, r.y, r.w, r.h);
    // The 2D slice readout (display #2) only renders while SLICE is ON.
    if (sliceOn) drawSliceReadout();
  }

  onMount(() => {
    rafId = requestAnimationFrame(draw);
  });
  onDestroy(() => {
    if (rafId !== null) cancelAnimationFrame(rafId);
  });

  // Knob + matching CV-input descriptor list (the CV port id is `${pid}_cv`).
  const CONTROLS: Array<{ pid: string; label: string; portLabel: string; curve: 'linear' | 'log' | 'discrete' }> = [
    { pid: 'zoom',     label: 'ZOOM',  portLabel: 'ZOOM', curve: 'log' },
    { pid: 'rotate_x', label: 'ROT X', portLabel: 'RTX',  curve: 'linear' },
    { pid: 'rotate_y', label: 'ROT Y', portLabel: 'RTY',  curve: 'linear' },
    { pid: 'power',    label: 'POWER', portLabel: 'PWR',  curve: 'linear' },
    { pid: 'detail',   label: 'DETAIL',portLabel: 'DET',  curve: 'discrete' },
    { pid: 'hue',      label: 'HUE',   portLabel: 'HUE',  curve: 'linear' },
  ];
  // Slice spatial controls — knob + CV each, shown only while SLICE is ON.
  const SLICE_CONTROLS: Array<{ pid: string; label: string; portLabel: string }> = [
    { pid: 'slice_y',  label: 'Y',      portLabel: 'SY'  },
    { pid: 'slice_rx', label: 'S RX',   portLabel: 'SRX' },
    { pid: 'slice_ry', label: 'S RY',   portLabel: 'SRY' },
    { pid: 'slice_rz', label: 'S RZ',   portLabel: 'SRZ' },
  ];
</script>

<div class="mod-card mandelbulb-card" data-testid="mandelbulb-card" data-node-id={id}>
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="MANDELBULB" />

  <!-- CV inputs (one per spatial/zoom control) down the left edge. -->
  {#each CONTROLS as c, i (c.pid)}
    <Handle
      type="target"
      position={Position.Left}
      id={`${c.pid}_cv`}
      style={`top: ${56 + i * 26}px; --handle-color: var(--cable-cv);`}
    />
    <span class="port-label left" style={`top: ${50 + i * 26}px;`}>{c.portLabel}</span>
  {/each}
  <!-- Slice CV inputs — always present (declared ports → handle-presence sweep);
       labels are only meaningful when SLICE is ON. -->
  {#each SLICE_CONTROLS as c, i (c.pid)}
    <Handle
      type="target"
      position={Position.Left}
      id={`${c.pid}_cv`}
      style={`top: ${56 + (CONTROLS.length + i) * 26}px; --handle-color: var(--cable-cv);`}
    />
    <span class="port-label left" style={`top: ${50 + (CONTROLS.length + i) * 26}px;`}>{c.portLabel}</span>
  {/each}

  <!-- Mono-video output. -->
  <Handle type="source" position={Position.Right} id="video_out" style="top: 56px; --handle-color: var(--cable-mono-video, var(--cable-video));" />
  <span class="port-label right" style="top: 50px;">VIDEO</span>
  <!-- Mono-audio output (ALWAYS present; silent until SLICE is ON). -->
  <Handle type="source" position={Position.Right} id="audio_out" style="top: 82px; --handle-color: var(--cable-audio);" />
  <span class="port-label right" style="top: 76px;">AUDIO</span>

  <!-- Display #1: the fractal view, with the movable YELLOW SELECT BOX overlay
       when SLICE is ON. -->
  <div
    class="screen-wrap"
    onpointerdown={onBoxPointerDown}
    onpointermove={onBoxPointerMove}
    onpointerup={onBoxPointerUp}
    onpointercancel={onBoxPointerUp}
    role="presentation"
  >
    <canvas
      bind:this={canvasEl}
      width={CANVAS_W}
      height={CANVAS_H}
      data-testid="mandelbulb-canvas"
      data-node-id={id}
    ></canvas>
    {#if sliceOn}
      <div
        class="select-box"
        class:dragging
        data-testid="mandelbulb-select-box"
        style={`left: ${(boxXFrac - BOX_W / 2) * 100}%; top: ${(boxYFrac - BOX_H / 2) * 100}%; width: ${BOX_W * 100}%; height: ${BOX_H * 100}%;`}
      ></div>
    {/if}
  </div>

  <!-- Display #2: the 2D bulb-slice readout (the waveform the slice produces) —
       only while SLICE is ON. -->
  {#if sliceOn}
    <div class="slice-wrap">
      <canvas
        bind:this={sliceCanvasEl}
        width={200}
        height={70}
        data-testid="mandelbulb-slice-readout"
      ></canvas>
    </div>
  {/if}

  <div class="toggles">
    <button
      class="toggle"
      class:on={spinOn}
      onclick={toggleSpin}
      data-testid="mandelbulb-spin-toggle"
      title="SPIN: auto-rotate the bulb's yaw"
    >SPIN: {spinOn ? 'ON' : 'OFF'}</button>
    <button
      class="toggle"
      class:on={screenOn}
      onclick={toggleScreen}
      data-testid="mandelbulb-screen-toggle"
      title="SCREEN: turn the preview OFF to save performance. When OFF and VIDEO is unpatched, the raymarch is skipped entirely."
    >SCRN: {screenOn ? 'ON' : 'OFF'}</button>
    <button
      class="toggle"
      class:on={sliceOn}
      onclick={toggleSlice}
      data-testid="mandelbulb-slice-toggle"
      title="SLICE: overlay a fixed-size slice plane on the bulb + emit AUDIO from the slice readout. OFF = video-only (no audio)."
    >SLICE: {sliceOn ? 'ON' : 'OFF'}</button>
  </div>

  <div class="knob-grid" data-testid="mandelbulb-controls">
    {#each CONTROLS as c (c.pid)}
      <Knob
        value={paramVal(c.pid)}
        min={minFor(c.pid)} max={maxFor(c.pid)} defaultValue={defaultFor(c.pid)}
        label={c.label} curve={c.curve}
        onchange={set(c.pid)} moduleId={id} paramId={c.pid}
        readLive={live(c.pid)}
      />
    {/each}
  </div>

  {#if sliceOn}
    <div class="slice-knobs" data-testid="mandelbulb-slice-controls">
      {#each SLICE_CONTROLS as c (c.pid)}
        <Knob
          value={paramVal(c.pid)}
          min={minFor(c.pid)} max={maxFor(c.pid)} defaultValue={defaultFor(c.pid)}
          label={c.label} curve="linear"
          onchange={set(c.pid)} moduleId={id} paramId={c.pid}
          readLive={live(c.pid)}
        />
      {/each}
    </div>
  {/if}
</div>

<style>
  .mod-card {
    width: 280px;
    min-height: 360px;
    background: var(--module-bg);
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text);
    padding-top: 18px;
    padding-bottom: 14px;
    position: relative;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  :global(.svelte-flow__node:hover) .mod-card { border-color: var(--accent-dim); }
  :global(.svelte-flow__node.selected) .mod-card {
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
  .port-label {
    position: absolute;
    font-size: 0.6rem;
    color: var(--text-dim);
    pointer-events: none;
    font-family: ui-monospace, monospace;
  }
  .port-label.left  { left: 14px; }
  .port-label.right { right: 14px; }
  .screen-wrap {
    position: relative;
    margin: 12px auto 8px;
    width: 200px;
    height: 150px;
    border: 1px solid var(--cable-video);
    border-radius: 2px;
    overflow: hidden;
    background: #050608;
    line-height: 0;
    touch-action: none;
  }
  canvas {
    display: block;
    width: 100%;
    height: 100%;
    image-rendering: pixelated;
    background: #050608;
  }
  /* The movable yellow select box overlaid on the fractal view. */
  .select-box {
    position: absolute;
    border: 2px solid #ffd83a;
    border-radius: 2px;
    box-shadow: 0 0 6px rgba(255, 216, 58, 0.5), inset 0 0 6px rgba(255, 216, 58, 0.25);
    background: rgba(255, 216, 58, 0.08);
    cursor: grab;
    pointer-events: none; /* the wrap handles the drag so clicks anywhere reposition */
  }
  .select-box.dragging { cursor: grabbing; }
  .slice-wrap {
    margin: 0 auto 8px;
    width: 200px;
    height: 70px;
    border: 1px solid rgba(255, 216, 58, 0.4);
    border-radius: 2px;
    overflow: hidden;
    background: #0a0c12;
    line-height: 0;
  }
  .slice-wrap canvas { image-rendering: auto; }
  .toggles {
    display: flex;
    gap: 6px;
    padding: 0 14px;
    margin-bottom: 6px;
  }
  .toggle {
    flex: 1; font-family: ui-monospace, monospace; font-size: 0.56rem;
    padding: 4px 5px; border-radius: 3px; cursor: pointer;
    background: var(--module-bg); color: var(--text-dim);
    border: 1px solid var(--border);
  }
  .toggle:hover { border-color: var(--accent-dim); }
  .toggle.on {
    background: rgba(135, 200, 255, 0.2);
    color: #87c8ff;
    border-color: #87c8ff;
  }
  .knob-grid {
    margin-top: 6px;
    padding: 0 14px;
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 14px 4px;
    justify-items: center;
  }
  .slice-knobs {
    margin-top: 10px;
    padding: 6px 14px 0;
    border-top: 1px solid rgba(255, 216, 58, 0.25);
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 10px 4px;
    justify-items: center;
  }
</style>
