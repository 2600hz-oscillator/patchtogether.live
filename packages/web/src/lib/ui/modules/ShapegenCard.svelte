<script lang="ts">
  // ShapegenCard — 3D-shape generator card.
  //
  // 3 video inputs (RASTER A/B/C on the left), 1 video output (OUT on the
  // right), 2 knobs (SIZE + ROT), 1 toggle (SOLIDS) that switches the
  // renderer between vaporwave wireframe (FOXY look) and per-primitive
  // lit canvas2D (sphere/cube/cylinder/cone — ring + tetraFrame stay
  // wireframe in v1; see shapegen-draw.ts).
  //
  // On-card preview: the factory exposes the OffscreenCanvas via
  // `read('sceneCanvas')`. We blit it into a smaller preview canvas on a
  // setInterval ~30 Hz (same pattern AcidwarpCard uses). Cheap — just a
  // drawImage of an already-painted canvas, no recomputation here.

  import type { NodeProps } from '@xyflow/svelte';
  import { Handle, Position } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import { patch } from '$lib/graph/store';
  import { shapegenDef } from '$lib/video/modules/shapegen';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import { onMount, onDestroy } from 'svelte';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  function defaultFor(k: string): number {
    return shapegenDef.params.find((p) => p.id === k)?.defaultValue ?? 0;
  }
  function paramVal(k: string): number {
    const v = node?.params?.[k];
    return typeof v === 'number' ? v : defaultFor(k);
  }
  const set = (k: string) => (v: number) => {
    const t = patch.nodes[id]; if (t) t.params[k] = v;
  };

  // ----- Preview canvas: blit the engine's OffscreenCanvas scene -----
  let previewEl: HTMLCanvasElement | null = $state(null);
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  onMount(() => {
    if (previewEl) {
      previewEl.width = 200;
      previewEl.height = 144;
    }
    pollTimer = setInterval(() => {
      const e = engineCtx.get(); if (!e || !node || !previewEl) return;
      const scene = e.read(node, 'sceneCanvas') as
        | OffscreenCanvas | HTMLCanvasElement | undefined;
      if (!scene) return;
      const c2d = previewEl.getContext('2d');
      if (!c2d) return;
      // Scale the engine-res scene (640×360 by default) into the preview.
      c2d.drawImage(scene as CanvasImageSource, 0, 0, previewEl.width, previewEl.height);
    }, 33); // ~30 Hz
  });
  onDestroy(() => { if (pollTimer) clearInterval(pollTimer); });

  function toggleSolids() {
    const t = patch.nodes[id]; if (!t) return;
    t.params.solids = (t.params.solids ?? 0) >= 0.5 ? 0 : 1;
  }

  let solidsOn = $derived(paramVal('solids') >= 0.5);
  let solidsLabel = $derived(solidsOn ? 'SOLIDS: ON' : 'SOLIDS: OFF');
</script>

<div class="mod-card shapegen-card" data-testid="shapegen-card">
  <div class="stripe" style="background: var(--cable-video);"></div>
  <ModuleTitle {id} {data} defaultLabel="SHAPEGEN" />

  <!-- Three video inputs on the left. -->
  <Handle type="target" position={Position.Left} id="raster_a" style="top: 56px; --handle-color: var(--cable-video);" />
  <span class="port-label left" style="top: 50px;">A</span>
  <Handle type="target" position={Position.Left} id="raster_b" style="top: 88px; --handle-color: var(--cable-video);" />
  <span class="port-label left" style="top: 82px;">B</span>
  <Handle type="target" position={Position.Left} id="raster_c" style="top: 120px; --handle-color: var(--cable-video);" />
  <span class="port-label left" style="top: 114px;">C</span>

  <!-- One video output on the right. -->
  <Handle type="source" position={Position.Right} id="out" style="top: 88px; --handle-color: var(--cable-video);" />
  <span class="port-label right" style="top: 82px;">OUT</span>

  <div class="screen-wrap">
    <canvas bind:this={previewEl} class="screen" data-testid="shapegen-screen"></canvas>
  </div>

  <div class="row">
    <Knob
      value={paramVal('size')}
      min={0.1} max={3} defaultValue={defaultFor('size')}
      label="SIZE" curve="linear"
      onchange={set('size')} moduleId={id} paramId="size"
    />
    <Knob
      value={paramVal('rotate')}
      min={0} max={1} defaultValue={defaultFor('rotate')}
      label="ROT" curve="linear"
      onchange={set('rotate')} moduleId={id} paramId="rotate"
    />
    <div class="buttons">
      <button
        class="btn"
        class:on={solidsOn}
        onclick={toggleSolids}
        data-testid="shapegen-solids"
        aria-pressed={solidsOn}
        title="Toggle between wireframe (vaporwave) and lit-solid rendering"
      >{solidsLabel}</button>
    </div>
  </div>
</div>

<style>
  .mod-card {
    width: 300px;
    min-height: 280px;
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
  .stripe { position: absolute; top: 0; left: 0; right: 0; height: 2px; border-radius: 2px 2px 0 0; }
  .port-label { position: absolute; font-size: 0.6rem; color: var(--text-dim); pointer-events: none; font-family: ui-monospace, monospace; }
  .port-label.left { left: 14px; }
  .port-label.right { right: 14px; }
  .screen-wrap {
    margin: 12px auto 12px;
    width: 200px;
    height: 144px;
    border: 1px solid #000;
    box-shadow: inset 0 0 8px rgba(0, 0, 0, 0.6), 0 0 4px rgba(0, 0, 0, 0.3);
    background: #0c0419;
    border-radius: 3px;
    overflow: hidden;
  }
  .screen {
    width: 200px;
    height: 144px;
    display: block;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 14px;
    padding: 0 14px;
  }
  .buttons {
    display: flex;
    flex-direction: column;
    gap: 4px;
    align-items: stretch;
  }
  .btn {
    background: var(--module-bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 3px;
    font-size: 0.65rem;
    letter-spacing: 0.08em;
    padding: 6px 10px;
    cursor: pointer;
    font-family: ui-monospace, monospace;
  }
  .btn:hover { border-color: var(--accent-dim); }
  .btn.on {
    background: rgba(135, 200, 255, 0.2);
    color: #87c8ff;
    border-color: #87c8ff;
  }
</style>
