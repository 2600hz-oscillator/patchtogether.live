<script lang="ts">
  // ShapedrampsCard — UI for SHAPEDRAMPS sync-locked ramp generator.
  //
  // 6 CV inputs on the left: h_shape, v_shape, h_phase, v_phase,
  // h_freq, v_freq. 4 mono-video outputs on the right: h_lin, v_lin
  // (stable identity ramps — wire these to RUTTETRA.x / RUTTETRA.y for
  // a clean raster passthrough), h_out, v_out (shaped/morphable).
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import { patch } from '$lib/graph/store';
  import { shapedrampsDef } from '$lib/video/modules/shapedramps';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  function p(name: string): number {
    const def = shapedrampsDef.params.find((d) => d.id === name);
    return node?.params[name] ?? def?.defaultValue ?? 0;
  }
  function setParam(paramId: string) {
    return (v: number) => {
      const target = patch.nodes[id];
      if (target) target.params[paramId] = v;
    };
  }
</script>

<div class="card video">
  <div class="stripe"></div>
  <header class="title">SHAPEDRAMPS</header>

  <!-- 6 CV inputs left side -->
  <Handle type="target" position={Position.Left} id="h_shape" style="top: 56px;  --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 50px;">HS</span>
  <Handle type="target" position={Position.Left} id="v_shape" style="top: 88px;  --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 82px;">VS</span>
  <Handle type="target" position={Position.Left} id="h_phase" style="top: 120px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 114px;">HP</span>
  <Handle type="target" position={Position.Left} id="v_phase" style="top: 152px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 146px;">VP</span>
  <Handle type="target" position={Position.Left} id="h_freq"  style="top: 184px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 178px;">HF</span>
  <Handle type="target" position={Position.Left} id="v_freq"  style="top: 216px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 210px;">VF</span>

  <!-- 4 mono-video outputs right side -->
  <Handle type="source" position={Position.Right} id="h_lin" style="top: 56px;  --handle-color: var(--cable-mono-video);" />
  <span class="port-label right" style="top: 50px;">H_LIN</span>
  <Handle type="source" position={Position.Right} id="v_lin" style="top: 88px;  --handle-color: var(--cable-mono-video);" />
  <span class="port-label right" style="top: 82px;">V_LIN</span>
  <Handle type="source" position={Position.Right} id="h_out" style="top: 152px; --handle-color: var(--cable-mono-video);" />
  <span class="port-label right" style="top: 146px;">H_OUT</span>
  <Handle type="source" position={Position.Right} id="v_out" style="top: 184px; --handle-color: var(--cable-mono-video);" />
  <span class="port-label right" style="top: 178px;">V_OUT</span>

  <div class="fader-grid">
    <Fader value={p('h_shape')} min={0}   max={1} defaultValue={shapedrampsDef.params.find((x) => x.id === 'h_shape')!.defaultValue} label="HS" curve="linear" onchange={setParam('h_shape')} />
    <Fader value={p('v_shape')} min={0}   max={1} defaultValue={shapedrampsDef.params.find((x) => x.id === 'v_shape')!.defaultValue} label="VS" curve="linear" onchange={setParam('v_shape')} />
    <Fader value={p('h_phase')} min={0}   max={1} defaultValue={shapedrampsDef.params.find((x) => x.id === 'h_phase')!.defaultValue} label="HP" curve="linear" onchange={setParam('h_phase')} />
    <Fader value={p('v_phase')} min={0}   max={1} defaultValue={shapedrampsDef.params.find((x) => x.id === 'v_phase')!.defaultValue} label="VP" curve="linear" onchange={setParam('v_phase')} />
    <Fader value={p('h_freq')}  min={0.5} max={8} defaultValue={shapedrampsDef.params.find((x) => x.id === 'h_freq')!.defaultValue}  label="HF" curve="linear" onchange={setParam('h_freq')} />
    <Fader value={p('v_freq')}  min={0.5} max={8} defaultValue={shapedrampsDef.params.find((x) => x.id === 'v_freq')!.defaultValue}  label="VF" curve="linear" onchange={setParam('v_freq')} />
  </div>
</div>

<style>
  .card {
    width: 240px;
    min-height: 380px;
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
  .fader-grid {
    margin-top: 140px;
    padding: 0 12px;
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 12px 8px;
    justify-items: center;
  }
</style>
