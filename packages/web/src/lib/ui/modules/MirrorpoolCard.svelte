<script lang="ts">
  // MirrorpoolCard — UI for MIRRORPOOL (hemisphere-pool liquid renderer).
  //
  // The camera is a repositionable ORBIT + FREE-LOOK rig, presented as TWO X-Y
  // pads (modelled on WavesculptCard's joystick pads):
  //   * PAD 1 — POSITION: X = orbit_az (orbit around the pool), Y = orbit_el
  //     (elevation; UP = higher/overhead, DOWN = below the surface = underwater).
  //   * PAD 2 — LOOK: X = look_yaw, Y = look_pitch — the free-look offset from
  //     the default aim-at-centre, so the camera can look ANY direction.
  // Both write the SAME ParamDefs through the undoable graph seam (`mutateNode`,
  // one coalesced transaction per frame — no store write-storm on the live
  // video sim). The remaining controls (WIND / DIR / RAIN / BRIGHT / MODE +
  // DIST + ZOOM) stay as faders; every control keeps its CV input on the
  // PatchPanel. A live preview of the rendered OUT is shown (the Cellshade blit).
  import { onMount, onDestroy } from 'svelte';
  import { type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { setNodeParam } from '$lib/graph/mutate';
  import { mirrorpoolDef } from '$lib/video/modules/mirrorpool';
  import type { VideoEngine } from '$lib/video/engine';
  import { VIDEO_RES } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  function p(name: string): number {
    const def = mirrorpoolDef.params.find((d) => d.id === name);
    return node?.params[name] ?? def?.defaultValue ?? 0;
  }
  function pdef(name: string): number {
    return mirrorpoolDef.params.find((d) => d.id === name)!.defaultValue;
  }
  function pmin(name: string): number {
    return mirrorpoolDef.params.find((d) => d.id === name)!.min;
  }
  function pmax(name: string): number {
    return mirrorpoolDef.params.find((d) => d.id === name)!.max;
  }
  function setParam(paramId: string) {
    return (v: number) => setNodeParam(id, paramId, v);
  }

  // --- Live preview of OUT (the canonical surface.texture). ---
  const ENGINE_W = VIDEO_RES.width;
  const ENGINE_H = VIDEO_RES.height;
  let canvasEl: HTMLCanvasElement | null = $state(null);
  let rafId: number | null = null;

  function draw() {
    rafId = null;
    const e = engineCtx.get();
    if (!e || !canvasEl) { rafId = requestAnimationFrame(draw); return; }
    let videoEngine: VideoEngine | undefined;
    try { videoEngine = e.getDomain<VideoEngine>('video'); }
    catch { rafId = requestAnimationFrame(draw); return; }
    if (!videoEngine) { rafId = requestAnimationFrame(draw); return; }
    const ctx2d = canvasEl.getContext('2d', { alpha: false });
    if (ctx2d) {
      try { videoEngine.blitOutputToDrawingBuffer(id); } catch { /* never nuke the rAF loop */ }
      const src = videoEngine.canvas as CanvasImageSource;
      const cw = canvasEl.width;
      const ch = canvasEl.height;
      ctx2d.fillStyle = '#050608';
      ctx2d.fillRect(0, 0, cw, ch);
      const srcAspect = ENGINE_W / ENGINE_H;
      const dstAspect = cw / ch;
      let w = cw, h = ch, x = 0, y = 0;
      if (dstAspect > srcAspect) { h = ch; w = Math.round(h * srcAspect); x = Math.round((cw - w) / 2); }
      else { w = cw; h = Math.round(w / srcAspect); y = Math.round((ch - h) / 2); }
      ctx2d.drawImage(src, x, y, w, h);
    }
    rafId = requestAnimationFrame(draw);
  }

  onMount(() => { rafId = requestAnimationFrame(draw); });
  onDestroy(() => {
    if (rafId !== null) cancelAnimationFrame(rafId);
    if (padRaf !== null) cancelAnimationFrame(padRaf);
  });

  const inputs = portsFromDef(mirrorpoolDef.inputs, {
    pool: 'POOL',
    scene: 'SCENE',
    wind_speed: 'WIND',
    wind_dir: 'DIR',
    rain: 'RAIN',
    brightness: 'BRIGHT',
    surface_mode: 'MODE',
    orbit_az: 'ORBIT',
    orbit_el: 'ELEV',
    orbit_dist: 'DIST',
    look_yaw: 'LOOK X',
    look_pitch: 'LOOK Y',
    zoom: 'ZOOM',
  });
  const outputs = portsFromDef(mirrorpoolDef.outputs);

  // Faders for the non-camera-pad controls (the camera az/el/yaw/pitch live on
  // the two X-Y pads below; DIST + ZOOM stay as dials).
  const KNOBS: { id: string; label: string }[] = [
    { id: 'wind_speed', label: 'Wind' },
    { id: 'wind_dir', label: 'Dir' },
    { id: 'rain', label: 'Rain' },
    { id: 'brightness', label: 'Bright' },
    { id: 'surface_mode', label: 'Mode' },
    { id: 'orbit_dist', label: 'Dist' },
    { id: 'zoom', label: 'Zoom' },
  ];

  // ---- X-Y pad plumbing (WavesculptCard pattern, range-aware) ----
  const PAD_PX = 94;

  /** Map a live param value → pad fraction [0..1] across its ParamDef range. */
  function valFrac(paramId: string, v: number): number {
    const lo = pmin(paramId), hi = pmax(paramId);
    return hi > lo ? Math.max(0, Math.min(1, (v - lo) / (hi - lo))) : 0.5;
  }
  /** Map a pad fraction [0..1] → param value across its ParamDef range. */
  function fracVal(paramId: string, f: number): number {
    const lo = pmin(paramId), hi = pmax(paramId);
    return lo + Math.max(0, Math.min(1, f)) * (hi - lo);
  }

  // Coalesced, undoable two-param commit. A drag fires pointermove at 120–240 Hz;
  // batching both axes into ONE write per animation frame keeps the live water
  // sim from being starved by a store-write storm (mirrors the Fader's rAF
  // drag-commit). Each axis rides setNodeParam (the undoable LOCAL_ORIGIN seam);
  // the two per-frame writes coalesce into one undo entry via Yjs' captureTimeout.
  let padRaf: number | null = null;
  let padPending: Array<[string, number]> | null = null;
  function commitPad(a: [string, number], b: [string, number]): void {
    padPending = [a, b];
    if (padRaf === null) padRaf = requestAnimationFrame(flushPad);
  }
  function flushPad(): void {
    if (padRaf !== null) { cancelAnimationFrame(padRaf); padRaf = null; }
    const pend = padPending;
    padPending = null;
    if (!pend) return;
    for (const [k, v] of pend) setNodeParam(id, k, v);
  }

  function padFrac(el: HTMLDivElement, ev: PointerEvent): { fx: number; fy: number } {
    const rect = el.getBoundingClientRect();
    return {
      fx: Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width)),
      fy: Math.max(0, Math.min(1, (ev.clientY - rect.top) / rect.height)),
    };
  }

  // Pad 1 — POSITION: X = orbit_az, Y = orbit_el (top of pad = higher elevation).
  let padPosEl: HTMLDivElement | null = $state(null);
  let draggingPos = $state(false);
  let dragAz = $state<number | null>(null);
  let dragEl = $state<number | null>(null);
  let azVal = $derived(draggingPos && dragAz !== null ? dragAz : p('orbit_az'));
  let elVal = $derived(draggingPos && dragEl !== null ? dragEl : p('orbit_el'));
  let dotPosX = $derived(valFrac('orbit_az', azVal) * PAD_PX);
  let dotPosY = $derived((1 - valFrac('orbit_el', elVal)) * PAD_PX);
  function writePos(fx: number, fy: number): void {
    const az = fracVal('orbit_az', fx);
    const el = fracVal('orbit_el', 1 - fy); // invert Y so UP = more elevation
    dragAz = az; dragEl = el;
    commitPad(['orbit_az', az], ['orbit_el', el]);
  }
  function posDown(ev: PointerEvent): void {
    if (!padPosEl) return;
    draggingPos = true;
    padPosEl.setPointerCapture(ev.pointerId);
    const { fx, fy } = padFrac(padPosEl, ev);
    writePos(fx, fy);
    ev.preventDefault();
    ev.stopPropagation();
  }
  function posMove(ev: PointerEvent): void {
    if (!draggingPos || !padPosEl) return;
    const { fx, fy } = padFrac(padPosEl, ev);
    writePos(fx, fy);
  }
  function posUp(ev: PointerEvent): void {
    if (!draggingPos) return;
    flushPad(); // commit the final position before dropping the drag override
    draggingPos = false;
    dragAz = null; dragEl = null;
    try { padPosEl?.releasePointerCapture(ev.pointerId); } catch { /* */ }
  }
  function posReset(): void {
    commitPad(['orbit_az', pdef('orbit_az')], ['orbit_el', pdef('orbit_el')]);
    flushPad();
  }

  // Pad 2 — LOOK: X = look_yaw, Y = look_pitch (top of pad = look up).
  let padLookEl: HTMLDivElement | null = $state(null);
  let draggingLook = $state(false);
  let dragYaw = $state<number | null>(null);
  let dragPitch = $state<number | null>(null);
  let yawVal = $derived(draggingLook && dragYaw !== null ? dragYaw : p('look_yaw'));
  let pitchVal = $derived(draggingLook && dragPitch !== null ? dragPitch : p('look_pitch'));
  let dotLookX = $derived(valFrac('look_yaw', yawVal) * PAD_PX);
  let dotLookY = $derived((1 - valFrac('look_pitch', pitchVal)) * PAD_PX);
  function writeLook(fx: number, fy: number): void {
    const yaw = fracVal('look_yaw', fx);
    const pitch = fracVal('look_pitch', 1 - fy); // invert Y so UP = look up
    dragYaw = yaw; dragPitch = pitch;
    commitPad(['look_yaw', yaw], ['look_pitch', pitch]);
  }
  function lookDown(ev: PointerEvent): void {
    if (!padLookEl) return;
    draggingLook = true;
    padLookEl.setPointerCapture(ev.pointerId);
    const { fx, fy } = padFrac(padLookEl, ev);
    writeLook(fx, fy);
    ev.preventDefault();
    ev.stopPropagation();
  }
  function lookMove(ev: PointerEvent): void {
    if (!draggingLook || !padLookEl) return;
    const { fx, fy } = padFrac(padLookEl, ev);
    writeLook(fx, fy);
  }
  function lookUp(ev: PointerEvent): void {
    if (!draggingLook) return;
    flushPad();
    draggingLook = false;
    dragYaw = null; dragPitch = null;
    try { padLookEl?.releasePointerCapture(ev.pointerId); } catch { /* */ }
  }
  function lookReset(): void {
    commitPad(['look_yaw', pdef('look_yaw')], ['look_pitch', pdef('look_pitch')]);
    flushPad();
  }
</script>

<div class="vcard card video" data-testid="mirrorpool-card" data-node-id={id}>
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="MIRRORPOOL" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <!-- OUT live preview -->
    <div class="preview-wrap">
      <canvas
        bind:this={canvasEl}
        width={160}
        height={120}
        data-testid="mirrorpool-preview"
        data-node-id={id}
      ></canvas>
    </div>

    <!-- CAMERA — two X-Y pads: POSITION (orbit × elevation) + LOOK (yaw × pitch). -->
    <div class="cam-label">CAMERA</div>
    <div class="pads-row">
      <div class="pad-cell">
        <div
          class="pad nodrag"
          bind:this={padPosEl}
          style="width: {PAD_PX}px; height: {PAD_PX}px;"
          role="application"
          aria-label="MIRRORPOOL camera position pad (orbit x elevation)"
          data-testid="mirrorpool-pad-position"
          onpointerdown={posDown}
          onpointermove={posMove}
          onpointerup={posUp}
          onpointercancel={posUp}
          ondblclick={posReset}
        >
          <div class="cross-h"></div>
          <div class="cross-v"></div>
          <div class="dot" class:active={draggingPos} style="left: {dotPosX}px; top: {dotPosY}px;"></div>
        </div>
        <div class="pad-label">orbit / elev</div>
      </div>

      <div class="pad-cell">
        <div
          class="pad nodrag pad-look"
          bind:this={padLookEl}
          style="width: {PAD_PX}px; height: {PAD_PX}px;"
          role="application"
          aria-label="MIRRORPOOL camera look pad (yaw x pitch)"
          data-testid="mirrorpool-pad-look"
          onpointerdown={lookDown}
          onpointermove={lookMove}
          onpointerup={lookUp}
          onpointercancel={lookUp}
          ondblclick={lookReset}
        >
          <div class="cross-h"></div>
          <div class="cross-v"></div>
          <div class="dot" class:active={draggingLook} style="left: {dotLookX}px; top: {dotLookY}px;"></div>
        </div>
        <div class="pad-label">yaw / pitch</div>
      </div>
    </div>

    <div class="fader-grid">
      {#each KNOBS as k (k.id)}
        <Fader
          value={p(k.id)}
          min={pmin(k.id)}
          max={pmax(k.id)}
          defaultValue={pdef(k.id)}
          label={k.label}
          curve="linear"
          onchange={setParam(k.id)}
          moduleId={id}
          paramId={k.id}
        />
      {/each}
    </div>
  </PatchPanel>
</div>

<style>
  .card {
    width: 250px;
    min-height: 200px;
    padding-bottom: 9px;
  }
  .preview-wrap {
    margin: 6px auto 0;
    width: 160px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
  }
  .preview-wrap canvas {
    width: 160px;
    height: 120px;
    background: #050608;
    border: 1px solid var(--cable-video);
    border-radius: 1px;
    display: block;
  }
  .cam-label {
    margin: 8px 0 2px;
    text-align: center;
    font-size: 0.62rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    color: var(--text-dim);
  }
  .pads-row {
    display: flex;
    justify-content: center;
    gap: 12px;
  }
  .pad-cell {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
  }
  .pad {
    position: relative;
    background: #050608;
    border: 1px solid var(--cable-cv, #6cf);
    border-radius: 2px;
    touch-action: none;
    cursor: grab;
    user-select: none;
  }
  .pad-look {
    border-color: var(--accent, #d6a);
  }
  .pad:active { cursor: grabbing; }
  .cross-h, .cross-v {
    position: absolute;
    background: rgba(255, 255, 255, 0.08);
    pointer-events: none;
  }
  .cross-h { left: 0; right: 0; top: 50%; height: 1px; transform: translateY(-0.5px); }
  .cross-v { top: 0; bottom: 0; left: 50%; width: 1px; transform: translateX(-0.5px); }
  .dot {
    position: absolute;
    width: 12px; height: 12px;
    border-radius: 50%;
    background: var(--cable-cv, #6cf);
    border: 1px solid #fff;
    transform: translate(-50%, -50%);
    pointer-events: none;
    box-shadow: 0 0 6px rgba(120, 200, 255, 0.4);
  }
  .pad-look .dot {
    background: var(--accent, #d6a);
    box-shadow: 0 0 6px rgba(210, 110, 200, 0.4);
  }
  .dot.active { box-shadow: 0 0 12px rgba(120, 200, 255, 0.8); }
  .pad-look .dot.active { box-shadow: 0 0 12px rgba(210, 110, 200, 0.9); }
  .pad-label {
    font-size: 0.55rem;
    color: var(--text-dim);
    letter-spacing: 0.05em;
  }
  .fader-grid {
    margin-top: 10px;
    padding: 0 14px;
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 12px 6px;
    justify-items: center;
  }
</style>
