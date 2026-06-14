<script lang="ts">
  // ShapesCard — UI for the SHAPES geometry source. Mirrors LinesCard's
  // layout (handles + faders), with a 3-state shape-select button + a
  // tile-on/off toggle as discrete controls.
  import { type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { setNodeParam } from '$lib/graph/mutate';
  import { shapesDef } from '$lib/video/modules/shapes';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  function p(name: string): number {
    const def = shapesDef.params.find((d) => d.id === name);
    return node?.params[name] ?? def?.defaultValue ?? 0;
  }
  function setParam(paramId: string) {
    return (v: number) => setNodeParam(id, paramId, v);
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

  // CV inputs — port id MUST match param id so the cross-domain CV bridge in
  // VideoEngine routes audio-side cv onto setParam(portId).
  const inputs: PortDescriptor[] = [
    { id: 'shape',  label: 'SH', cable: 'cv' },
    { id: 'tile',   label: 'TI', cable: 'cv' },
    { id: 'rotate', label: 'R',  cable: 'cv' },
    { id: 'zoom',   label: 'Z',  cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'out', cable: 'mono-video' },
  ];
</script>

<div class="card video">
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="SHAPES" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
  <div class="button-row">
    <button class="mode-btn" onclick={cycleShape} title="Cycle shape (circle / square / triangle)">
      {SHAPE_LABELS[shapeIdx]}
    </button>
    <button class="mode-btn" class:active={tileOn} onclick={toggleTile} title="Tile across the frame">
      TILE {tileOn ? 'ON' : 'OFF'}
    </button>
  </div>

  <div class="fader-grid">
    <Fader value={p('tileN')}  min={1}        max={16}      defaultValue={shapesDef.params.find((x) => x.id === 'tileN')!.defaultValue}  label="Grid"   curve="linear" onchange={setParam('tileN')} moduleId={id} paramId="tileN" />
    <Fader value={p('rotate')} min={-3.14159} max={3.14159} defaultValue={shapesDef.params.find((x) => x.id === 'rotate')!.defaultValue} label="Rotate" curve="linear" onchange={setParam('rotate')} moduleId={id} paramId="rotate" />
    <Fader value={p('zoom')}   min={0.05}     max={10}      defaultValue={shapesDef.params.find((x) => x.id === 'zoom')!.defaultValue}   label="Zoom"   curve="log"    onchange={setParam('zoom')} moduleId={id} paramId="zoom" />
  </div>
  </PatchPanel>
</div>

<style>
  .card {
    width: 220px;
    min-height: 220px;
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
  .button-row {
    margin-top: 16px;
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
