<script lang="ts">
  // ShapesCard — UI for the SHAPES geometry source. Mirrors LinesCard's
  // layout (handles + faders), with a 3-state shape-select button + a
  // tile-on/off toggle as discrete controls.
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import { patch } from '$lib/graph/store';
  import { shapesDef } from '$lib/video/modules/shapes';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  function p(name: string): number {
    const def = shapesDef.params.find((d) => d.id === name);
    return node?.params[name] ?? def?.defaultValue ?? 0;
  }
  function setParam(paramId: string) {
    return (v: number) => {
      const target = patch.nodes[id];
      if (target) target.params[paramId] = v;
    };
  }

  const SHAPE_LABELS = ['CIRCLE', 'SQUARE', 'TRI'] as const;
  let shapeIdx = $derived(Math.max(0, Math.min(2, Math.round(p('shape')))));
  let tileOn   = $derived(p('tile') >= 0.5);

  function cycleShape() {
    const target = patch.nodes[id];
    if (!target) return;
    target.params.shape = (shapeIdx + 1) % 3;
  }
  function toggleTile() {
    const target = patch.nodes[id];
    if (!target) return;
    target.params.tile = tileOn ? 0 : 1;
  }
</script>

<div class="card video">
  <div class="stripe"></div>
  <header class="title">SHAPES</header>

  <!-- CV inputs — port id MUST match param id so the cross-domain CV
       bridge in VideoEngine routes audio-side cv onto setParam(portId). -->
  <Handle type="target" position={Position.Left} id="shape"  style="top: 56px;  --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 50px;">SH</span>
  <Handle type="target" position={Position.Left} id="tile"   style="top: 88px;  --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 82px;">TI</span>
  <Handle type="target" position={Position.Left} id="rotate" style="top: 120px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 114px;">R</span>
  <Handle type="target" position={Position.Left} id="zoom"   style="top: 152px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 146px;">Z</span>

  <Handle type="source" position={Position.Right} id="out" style="top: 56px; --handle-color: var(--cable-mono-video);" />
  <span class="port-label right" style="top: 50px;">OUT</span>

  <div class="button-row">
    <button class="mode-btn" onclick={cycleShape} title="Cycle shape (circle / square / triangle)">
      {SHAPE_LABELS[shapeIdx]}
    </button>
    <button class="mode-btn" class:active={tileOn} onclick={toggleTile} title="Tile across the frame">
      TILE {tileOn ? 'ON' : 'OFF'}
    </button>
  </div>

  <div class="fader-grid">
    <Fader value={p('tileN')}  min={1}        max={16}      defaultValue={shapesDef.params.find((x) => x.id === 'tileN')!.defaultValue}  label="Grid"   curve="linear" onchange={setParam('tileN')} />
    <Fader value={p('rotate')} min={-3.14159} max={3.14159} defaultValue={shapesDef.params.find((x) => x.id === 'rotate')!.defaultValue} label="Rotate" curve="linear" onchange={setParam('rotate')} />
    <Fader value={p('zoom')}   min={0.05}     max={10}      defaultValue={shapesDef.params.find((x) => x.id === 'zoom')!.defaultValue}   label="Zoom"   curve="log"    onchange={setParam('zoom')} />
  </div>
</div>

<style>
  .card {
    width: 220px;
    /* Matches INWARDS layout — clears the lowest CV input handle plus
     * the buttons + faders below. */
    min-height: 320px;
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
    background: var(--cable-mono-video);
  }
  .title {
    font-size: 0.85rem;
    font-weight: 500;
    text-align: center;
    margin: 0 0 8px;
    letter-spacing: 0.05em;
  }
  .port-label {
    position: absolute;
    font-size: 0.6rem;
    color: var(--text-dim);
    pointer-events: none;
    font-family: ui-monospace, monospace;
  }
  .port-label.left { left: 14px; }
  .port-label.right { right: 14px; }
  .button-row {
    margin-top: 100px;
    padding: 0 12px;
    display: flex;
    gap: 6px;
    justify-content: center;
  }
  .mode-btn {
    height: 22px;
    padding: 0 8px;
    background: #14171c;
    border: 1px solid var(--border);
    border-radius: 3px;
    color: var(--text);
    font-size: 0.65rem;
    font-family: ui-monospace, monospace;
    cursor: pointer;
    line-height: 1;
  }
  .mode-btn.active {
    background: var(--accent);
    color: #1a1d23;
    border-color: var(--accent);
  }
  .fader-grid {
    margin-top: 12px;
    padding: 0 12px;
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 12px 8px;
    justify-items: center;
  }
</style>
