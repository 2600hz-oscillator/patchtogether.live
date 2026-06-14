<script lang="ts">
  // OutlinesCard — UI for the OUTLINES stateful particle video generator.
  //
  // (Was CirclesCard — renamed when the SHAPE selector landed: a spawned shape
  // can be a circle OR a regular N-gon, plus a live-global ROTATION.)
  //
  // Left rail: GATE (spawn trigger) + COLLIDE (live inter-shape elastic-bounce
  // gate) + D/V/SPD/DECAY/SHAPE/ROT CV inputs + the VIDEO input (used by the
  // `mapped` output). Right rail: the four outputs (OVERLAP / CONTOUR / COMBINE
  // / MAPPED). Seven knobs (D/V/SPD/DECAY/SHAPE/ROT/RATE) + a live preview of
  // the COMBINE output (blitted from the factory's scene canvas, same pattern
  // ShapegenCard uses). SHAPE shows its current shape name; ROT shows its spin
  // direction (CCW / · / CW).

  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { setNodeParam } from '$lib/graph/mutate';
  import { outlinesDef, OUTLINES_GATE_PORT_ID, OUTLINES_COLLIDE_PORT_ID } from '$lib/video/modules/outlines';
  import { mapShape, ROT_CENTER } from '$lib/video/modules/outlines-sim';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import { onMount, onDestroy } from 'svelte';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  function defaultFor(k: string): number {
    return outlinesDef.params.find((p) => p.id === k)?.defaultValue ?? 0;
  }
  function paramVal(k: string): number {
    const v = node?.params?.[k];
    return typeof v === 'number' ? v : defaultFor(k);
  }
  const set = (k: string) => (v: number) => {
    setNodeParam(id, k, v);
  };

  // SHAPE readout: the discrete shape NAME for the current `shape` knob value.
  const SHAPE_NAMES = ['CIRCLE', 'TRI', 'SQUARE', 'PENTA', 'HEXA', 'OCTA'];
  let shapeName = $derived(SHAPE_NAMES[mapShape(paramVal('shape'))] ?? 'CIRCLE');
  // ROT readout: spin DIRECTION from the bipolar knob (center = no spin).
  let rotDir = $derived.by(() => {
    const r = paramVal('rotation');
    if (r > ROT_CENTER + 0.02) return 'CW';
    if (r < ROT_CENTER - 0.02) return 'CCW';
    return '·';
  });

  // ----- Preview canvas: blit the engine's COMBINE scene canvas -----
  let previewEl: HTMLCanvasElement | null = $state(null);
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  onMount(() => {
    if (previewEl) {
      previewEl.width = 168;
      previewEl.height = 168;
    }
    pollTimer = setInterval(() => {
      const e = engineCtx.get(); if (!e || !node || !previewEl) return;
      const scene = e.read(node, 'sceneCanvas') as
        | OffscreenCanvas | HTMLCanvasElement | undefined;
      if (!scene) return;
      const c2d = previewEl.getContext('2d');
      if (!c2d) return;
      c2d.drawImage(scene as CanvasImageSource, 0, 0, previewEl.width, previewEl.height);
    }, 33); // ~30 Hz
  });
  onDestroy(() => { if (pollTimer) clearInterval(pollTimer); });

  // [GATED] hint: lights when the gate input is the target of any edge.
  let gatePatched = $derived<boolean>(
    Object.values(patch.edges ?? {}).some(
      (e) => e?.target?.nodeId === id && e?.target?.portId === OUTLINES_GATE_PORT_ID,
    ),
  );

  // Left rail: gate spawn + collide gate + D/V/SPD/DECAY/SHAPE/ROT CV + video.
  // Both gate/collide are declared `type: 'gate'` on the def.
  const inputs: PortDescriptor[] = [
    { id: OUTLINES_GATE_PORT_ID,    label: 'GATE', cable: 'gate' },
    { id: OUTLINES_COLLIDE_PORT_ID, label: 'COL',  cable: 'gate' },
    { id: 'd',        label: 'D',   cable: 'cv' },
    { id: 'v',        label: 'V',   cable: 'cv' },
    { id: 'spd',      label: 'SPD', cable: 'cv' },
    { id: 'decay',    label: 'DEC', cable: 'cv' },
    { id: 'shape',    label: 'SHP', cable: 'cv' },
    { id: 'rotation', label: 'ROT', cable: 'cv' },
    { id: 'video',    label: 'VID', cable: 'video' },
  ];
  // Right rail: the four outputs.
  const outputs: PortDescriptor[] = [
    { id: 'overlap', label: 'OVR', cable: 'mono-video' },
    { id: 'contour', label: 'CNT', cable: 'mono-video' },
    { id: 'combine', label: 'CMB', cable: 'video' },
    { id: 'mapped',  label: 'MAP', cable: 'video' },
  ];
</script>

<div class="mod-card outlines-card" data-testid="outlines-card">
  <div class="stripe" style="background: var(--cable-video);"></div>
  <ModuleTitle {id} {data} defaultLabel="outlines" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
  <div class="screen-wrap">
    {#if gatePatched}
      <span class="gated-badge" data-testid="outlines-gated-badge">[GATED]</span>
    {/if}
    <canvas bind:this={previewEl} class="screen" data-testid="outlines-screen"></canvas>
  </div>

  <div class="row">
    <Knob value={paramVal('d')}     min={0} max={1} defaultValue={defaultFor('d')}     label="D"    curve="linear" onchange={set('d')}     moduleId={id} paramId="d" />
    <Knob value={paramVal('v')}     min={0} max={1} defaultValue={defaultFor('v')}     label="V"    curve="linear" onchange={set('v')}     moduleId={id} paramId="v" />
    <Knob value={paramVal('spd')}   min={0} max={1} defaultValue={defaultFor('spd')}   label="SPD"  curve="linear" onchange={set('spd')}   moduleId={id} paramId="spd" />
    <Knob value={paramVal('decay')} min={0} max={1} defaultValue={defaultFor('decay')} label="DEC"  curve="linear" onchange={set('decay')} moduleId={id} paramId="decay" />
  </div>
  <div class="row second">
    <div class="knob-with-readout">
      <Knob value={paramVal('shape')} min={0} max={1} defaultValue={defaultFor('shape')} label="SHP" curve="linear" onchange={set('shape')} moduleId={id} paramId="shape" />
      <span class="readout" data-testid="outlines-shape-readout">{shapeName}</span>
    </div>
    <div class="knob-with-readout">
      <Knob value={paramVal('rotation')} min={0} max={1} defaultValue={defaultFor('rotation')} label="ROT" curve="linear" onchange={set('rotation')} moduleId={id} paramId="rotation" />
      <span class="readout" data-testid="outlines-rot-readout">{rotDir}</span>
    </div>
    <Knob value={paramVal('rate')}  min={0} max={1} defaultValue={defaultFor('rate')}  label="RATE" curve="linear" onchange={set('rate')}  moduleId={id} paramId="rate" />
  </div>
  </PatchPanel>
</div>

<style>
  .mod-card {
    width: 260px;
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
  .stripe { position: absolute; top: 0; left: 0; right: 0; height: 2px; border-radius: 2px 2px 0 0; }
  .screen-wrap {
    margin: 16px auto 12px;
    width: 168px;
    height: 168px;
    border: 1px solid #000;
    box-shadow: inset 0 0 8px rgba(0, 0, 0, 0.6), 0 0 4px rgba(0, 0, 0, 0.3);
    background: #000;
    border-radius: 3px;
    overflow: hidden;
    position: relative;
  }
  .gated-badge {
    position: absolute;
    top: 4px;
    right: 4px;
    font-size: 0.55rem;
    letter-spacing: 0.08em;
    color: #87c8ff;
    background: rgba(0, 0, 0, 0.55);
    border: 1px solid #87c8ff;
    border-radius: 2px;
    padding: 1px 4px;
    font-family: ui-monospace, monospace;
    pointer-events: none;
    z-index: 2;
  }
  .screen { width: 168px; height: 168px; display: block; }
  .row {
    display: flex;
    align-items: flex-start;
    justify-content: center;
    gap: 6px;
    padding: 0 8px;
  }
  .row.second { margin-top: 10px; }
  .knob-with-readout {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
  }
  .readout {
    font-size: 0.5rem;
    letter-spacing: 0.06em;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
    pointer-events: none;
  }
</style>
