<script lang="ts">
  // BackdraftCard — UI for BACKDRAFT (video feedback generator).
  //
  // 2-column 3u layout (mirrors CUBE/HYPERCUBE): a large video PREVIEW on the
  // LEFT, all controls (mirror toggles + fader grid) on the RIGHT. Every port
  // (2 video + 2 KEY masks + 18 CV/gate inputs + the `out` video output) lives
  // in the yellow PatchPanel drill-down menu. Every Fader is wired with
  // moduleId={id} + paramId so MIDI-Learn binds.

  import { onMount, onDestroy } from 'svelte';
  import { type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { useEngine } from '$lib/audio/engine-context';
  import { patch, ydoc } from '$lib/graph/store';
  import { setNodeParam } from '$lib/graph/mutate';
  import {
    backdraftDef,
    BACKDRAFT_MAX_DELAY_MS,
    BACKDRAFT_MAX_FEEDBACK,
    BACKDRAFT_ZOOM_MIN,
    BACKDRAFT_ZOOM_MAX,
    BACKDRAFT_ROTATE_MIN,
    BACKDRAFT_ROTATE_MAX,
    BACKDRAFT_OFFSET_MIN,
    BACKDRAFT_OFFSET_MAX,
  } from '$lib/video/modules/backdraft';
  import type { VideoEngine } from '$lib/video/engine';
  import { VIDEO_RES } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  function pdef(name: string): number {
    return backdraftDef.params.find((d) => d.id === name)!.defaultValue;
  }
  function p(name: string): number {
    const def = backdraftDef.params.find((d) => d.id === name);
    return node?.params[name] ?? def?.defaultValue ?? 0;
  }
  function setParam(paramId: string) {
    return (v: number) => setNodeParam(id, paramId, v);
  }

  // ---- MIRROR X / MIRROR Y kaleidoscope toggles ----
  // Each button flips a boolean param (mirrorX / mirrorY). A rising edge on
  // the matching gate input also flips it in the engine; the button reflects
  // the (possibly gate-toggled) param value.
  let mirrorXOn = $derived(p('mirrorX') >= 0.5);
  let mirrorYOn = $derived(p('mirrorY') >= 0.5);
  function toggleMirror(paramId: 'mirrorX' | 'mirrorY') {
    return () => {
      setNodeParam(id, paramId, (p(paramId) ?? 0) >= 0.5 ? 0 : 1);
    };
  }

  // ---- DELAY CLOCK override indicator ----
  // When a cable is patched into the `delay_clock` input, the clock drives
  // the feedback delay (one pulse = the delay time) and OVERRIDES the DELAY
  // knob. We show a small "CLK" badge + disable the Delay fader so it reads
  // as overridden. patch.edges is a SyncedStore/Yjs proxy (not a Svelte
  // signal), so we bump a real $state from a Yjs observer to stay reactive
  // on cable add/remove — same pattern as DoomCard's edgesVersion.
  let edgesVersion = $state(0);
  let clockPatched = $derived.by<boolean>(() => {
    void edgesVersion;
    for (const edge of Object.values(patch.edges)) {
      if (!edge) continue;
      if (edge.target.nodeId === id && edge.target.portId === 'delay_clock') return true;
    }
    return false;
  });
  let edgesUnobserve: (() => void) | null = null;

  const ENGINE_W = VIDEO_RES.width;
  const ENGINE_H = VIDEO_RES.height;
  // Big on-card preview that fills the LEFT column of the 3u 2-col layout.
  const CANVAS_W = 320;
  const CANVAS_H = Math.round(CANVAS_W * (ENGINE_H / ENGINE_W)); // 4:3

  let canvasEl: HTMLCanvasElement | null = $state(null);
  let rafId: number | null = null;

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
    const ctx2d = canvasEl.getContext('2d', { alpha: false });
    if (ctx2d) {
      try {
        videoEngine.blitOutputToDrawingBuffer(id);
      } catch {
        // Never let an engine error nuke the rAF loop.
      }
      const src = videoEngine.canvas as CanvasImageSource;
      const cw = canvasEl.width;
      const ch = canvasEl.height;
      ctx2d.fillStyle = '#050608';
      ctx2d.fillRect(0, 0, cw, ch);
      const r = fitRect(cw, ch);
      ctx2d.drawImage(src, r.x, r.y, r.w, r.h);
    }
    // A rising edge on a mirror gate flips the param INSIDE the engine
    // instance. Mirror that live value back into the patch store so the
    // toggle persists + syncs to collaborators + the button reflects it.
    try { syncMirrorFromEngine(e, node); } catch { /* defensive */ }
    rafId = requestAnimationFrame(draw);
  }

  // Reconcile the engine's live mirrorX/mirrorY (possibly gate-toggled) into
  // the patch store. Only writes when the engine value differs from the store,
  // so user clicks (store → engine via setParam) and gate flips (engine →
  // store here) converge without fighting.
  function syncMirrorFromEngine(e: ReturnType<typeof engineCtx.get>, n: ModuleNode | undefined): void {
    if (!e || !n) return;
    for (const k of ['mirrorX', 'mirrorY'] as const) {
      const live = e.readParam(n, k);
      if (typeof live !== 'number') continue;
      const stored = (patch.nodes[id]?.params[k] ?? 0);
      if ((live >= 0.5) !== (stored >= 0.5)) {
        const target = patch.nodes[id];
        if (target) target.params[k] = live >= 0.5 ? 1 : 0; // guard:allow-raw-write — per-frame engine→store reflect, must NOT pollute undo
      }
    }
  }

  onMount(() => {
    rafId = requestAnimationFrame(draw);
    const edgesMap = ydoc.getMap('edges');
    const handler = (): void => { edgesVersion++; };
    edgesMap.observeDeep(handler);
    edgesUnobserve = () => edgesMap.unobserveDeep(handler);
    edgesVersion++; // seed for a patch loaded with the cable already present
  });
  onDestroy(() => {
    if (rafId !== null) cancelAnimationFrame(rafId);
    if (edgesUnobserve) { try { edgesUnobserve(); } catch { /* */ } edgesUnobserve = null; }
  });

  // ---------------- Patch-panel ports ----------------
  // Port ids match the def EXACTLY (handle id === port id — the cross-domain
  // CV bridge + saved patches route by id). lighten/darken CV use the `_cv`
  // suffix; gate-style inputs (delay_clock / mirror_*_gate) carry raw swing.
  const inputs: PortDescriptor[] = [
    { id: 'in_a',    label: 'IN A',    cable: 'video' },
    { id: 'in_b',    label: 'IN B',    cable: 'video' },
    { id: 'lighten', label: 'KEY +',   cable: 'video' },
    { id: 'darken',  label: 'KEY -',   cable: 'video' },
    { id: 'mix',         label: 'MIX',       cable: 'cv' },
    { id: 'feedback',    label: 'FEEDBACK',  cable: 'cv' },
    { id: 'delay',       label: 'DELAY',     cable: 'cv' },
    { id: 'delay_clock', label: 'DELAY CLK', cable: 'gate' },
    { id: 'luma',        label: 'LUMA',      cable: 'cv' },
    { id: 'chroma',      label: 'CHROMA',    cable: 'cv' },
    { id: 'r',           label: 'R',         cable: 'cv' },
    { id: 'g',           label: 'G',         cable: 'cv' },
    { id: 'b',           label: 'B',         cable: 'cv' },
    { id: 'lighten_cv',  label: 'LIGHTEN',   cable: 'cv' },
    { id: 'darken_cv',   label: 'DARKEN',    cable: 'cv' },
    { id: 'pixelate',    label: 'PIXELATE',  cable: 'cv' },
    { id: 'zoom',        label: 'ZOOM',      cable: 'cv' },
    { id: 'rotate',      label: 'ROTATE',    cable: 'cv' },
    { id: 'offsetx',     label: 'OFF X',     cable: 'cv' },
    { id: 'offsety',     label: 'OFF Y',     cable: 'cv' },
    { id: 'mirror_x_gate', label: 'MIRROR X', cable: 'gate' },
    { id: 'mirror_y_gate', label: 'MIRROR Y', cable: 'gate' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'out', label: 'OUT', cable: 'video' },
  ];
</script>

<div class="card video" data-testid="backdraft-card" data-node-id={id}>
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="BACKDRAFT" />

  <PatchPanel nodeId={id} {inputs} {outputs} panelWidth={300}>
    <div class="bd-body">
      <!-- LEFT column: large video preview. -->
      <div class="bd-col bd-col-left">
        <div class="canvas-wrap">
          <canvas
            bind:this={canvasEl}
            width={CANVAS_W}
            height={CANVAS_H}
            data-testid="backdraft-canvas"
            data-node-id={id}
          ></canvas>
        </div>
      </div>

      <!-- RIGHT column: mirror toggles + the fader grid. -->
      <div class="bd-col bd-col-right">
        <div class="mirror-row" data-testid="backdraft-mirror-row">
          <button
            type="button"
            class="mirror-btn nodrag"
            class:on={mirrorXOn}
            data-testid="backdraft-mirror-x"
            title="MIRROR X — fold the left half over the right (kaleidoscope)"
            onclick={toggleMirror('mirrorX')}
          >MIRROR X</button>
          <button
            type="button"
            class="mirror-btn nodrag"
            class:on={mirrorYOn}
            data-testid="backdraft-mirror-y"
            title="MIRROR Y — fold the top half over the bottom (kaleidoscope)"
            onclick={toggleMirror('mirrorY')}
          >MIRROR Y</button>
        </div>

        <div class="fader-grid" data-testid="backdraft-controls">
          <Fader value={p('mix')}      min={0}  max={1}                     defaultValue={pdef('mix')}      label="Mix"  curve="linear" onchange={setParam('mix')}      moduleId={id} paramId="mix" />
          <Fader value={p('feedback')} min={0}  max={BACKDRAFT_MAX_FEEDBACK} defaultValue={pdef('feedback')} label="FB"   curve="linear" onchange={setParam('feedback')} moduleId={id} paramId="feedback" />
          <div class="delay-cell" class:clk-driven={clockPatched}>
            <Fader value={p('delay')}    min={0}  max={BACKDRAFT_MAX_DELAY_MS} units="ms" defaultValue={pdef('delay')} label={clockPatched ? 'Dly·CLK' : 'Delay'} curve="linear" onchange={setParam('delay')} moduleId={id} paramId="delay" />
            {#if clockPatched}<span class="clk-badge" data-testid="backdraft-clk-badge" title="DELAY CLOCK is driving the feedback delay (knob overridden)">CLK</span>{/if}
          </div>
          <Fader value={p('luma')}     min={-1} max={2}                     defaultValue={pdef('luma')}     label="Luma" curve="linear" onchange={setParam('luma')}     moduleId={id} paramId="luma" />
          <Fader value={p('chroma')}   min={-1} max={2}                     defaultValue={pdef('chroma')}   label="Chr"  curve="linear" onchange={setParam('chroma')}   moduleId={id} paramId="chroma" />
          <Fader value={p('r')}        min={-1} max={2}                     defaultValue={pdef('r')}        label="R"    curve="linear" onchange={setParam('r')}        moduleId={id} paramId="r" />
          <Fader value={p('g')}        min={-1} max={2}                     defaultValue={pdef('g')}        label="G"    curve="linear" onchange={setParam('g')}        moduleId={id} paramId="g" />
          <Fader value={p('b')}        min={-1} max={2}                     defaultValue={pdef('b')}        label="B"    curve="linear" onchange={setParam('b')}        moduleId={id} paramId="b" />
          <Fader value={p('lighten')}  min={0}  max={1}                     defaultValue={pdef('lighten')}  label="Lgt"  curve="linear" onchange={setParam('lighten')}  moduleId={id} paramId="lighten" />
          <Fader value={p('darken')}   min={0}  max={1}                     defaultValue={pdef('darken')}   label="Drk"  curve="linear" onchange={setParam('darken')}   moduleId={id} paramId="darken" />
          <Fader value={p('pixelate')} min={0}  max={1}                     defaultValue={pdef('pixelate')} label="Pix"  curve="linear" onchange={setParam('pixelate')} moduleId={id} paramId="pixelate" />
          <Fader value={p('zoom')}     min={BACKDRAFT_ZOOM_MIN}   max={BACKDRAFT_ZOOM_MAX}   defaultValue={pdef('zoom')}    label="Zoom" curve="linear" onchange={setParam('zoom')}    moduleId={id} paramId="zoom" />
          <Fader value={p('rotate')}   min={BACKDRAFT_ROTATE_MIN} max={BACKDRAFT_ROTATE_MAX} units="°" defaultValue={pdef('rotate')} label="Rot"  curve="linear" onchange={setParam('rotate')}  moduleId={id} paramId="rotate" />
          <Fader value={p('offsetX')}  min={BACKDRAFT_OFFSET_MIN} max={BACKDRAFT_OFFSET_MAX} defaultValue={pdef('offsetX')} label="OffX" curve="linear" onchange={setParam('offsetX')} moduleId={id} paramId="offsetX" />
          <Fader value={p('offsetY')}  min={BACKDRAFT_OFFSET_MIN} max={BACKDRAFT_OFFSET_MAX} defaultValue={pdef('offsetY')} label="OffY" curve="linear" onchange={setParam('offsetY')} moduleId={id} paramId="offsetY" />
        </div>
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .card {
    width: 720px;
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
  .title {
    font-size: 0.85rem;
    font-weight: 500;
    text-align: center;
    margin: 0 0 8px;
    letter-spacing: 0.05em;
  }
  /* 2-column 3u layout: preview LEFT, controls RIGHT (CUBE pattern). */
  .bd-body {
    padding: 6px 14px 8px;
    display: flex;
    flex-direction: row;
    gap: 16px;
    align-items: flex-start;
  }
  .bd-col { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
  .bd-col-left { flex: 0 0 auto; }
  .bd-col-right { flex: 1 1 auto; min-width: 0; }
  .canvas-wrap {
    border: 1px solid var(--cable-video);
    border-radius: 2px;
    overflow: hidden;
    line-height: 0;
    background: #050608;
  }
  .canvas-wrap canvas {
    display: block;
    width: 320px;
    height: 240px;
    image-rendering: pixelated;
    background: #050608;
  }
  .fader-grid {
    margin-top: 4px;
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 14px 6px;
    justify-items: center;
  }
  .mirror-row {
    display: flex;
    gap: 8px;
    justify-content: flex-start;
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
  .delay-cell {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  /* When the DELAY CLOCK drives the delay, dim the track + thumb so the
     knob reads as overridden (the fader stays interactive + MIDI-learnable;
     the value-tag + label stay full-opacity so the badge is legible). */
  .delay-cell.clk-driven :global(.track),
  .delay-cell.clk-driven :global(.thumb) {
    opacity: 0.45;
  }
  .clk-badge {
    margin-top: 2px;
    font-size: 0.5rem;
    line-height: 1;
    letter-spacing: 0.05em;
    color: var(--cable-cv, #6cf);
    border: 1px solid var(--cable-cv, #6cf);
    border-radius: 2px;
    padding: 1px 2px;
    font-family: ui-monospace, monospace;
    pointer-events: none;
  }
</style>
