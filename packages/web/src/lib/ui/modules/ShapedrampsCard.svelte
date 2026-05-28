<script lang="ts">
  // ShapedrampsCard — UI for SHAPEDRAMPS sync-locked ramp generator.
  //
  // 6 CV inputs in upper-left (h_shape, v_shape, h_phase, v_phase,
  // h_freq, v_freq) and 4 mono-video outputs in upper-right (h_lin,
  // v_lin — stable identity ramps; h_out, v_out — shaped/morphable).
  //
  // Plus 2 onboard 2-channel mixers (lower half):
  //   MIX 1: mix1_a, mix1_b inputs + mix1_cv + mix1_out
  //   MIX 2: mix2_a, mix2_b inputs + mix2_cv + mix2_out
  //   Each mixer crossfades its inputs by amount knob/CV
  //   (out = (1 - amount) * A + amount * B).
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import { patch } from '$lib/graph/store';
  import { shapedrampsDef } from '$lib/video/modules/shapedramps';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

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
  <ModuleTitle {id} {data} defaultLabel="SHAPEDRAMPS" />

  <!-- 6 CV inputs left side, upper -->
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

  <!-- 4 mono-video outputs right side, upper -->
  <Handle type="source" position={Position.Right} id="h_lin" style="top: 56px;  --handle-color: var(--cable-mono-video);" />
  <span class="port-label right" style="top: 50px;">H_LIN</span>
  <Handle type="source" position={Position.Right} id="v_lin" style="top: 88px;  --handle-color: var(--cable-mono-video);" />
  <span class="port-label right" style="top: 82px;">V_LIN</span>
  <Handle type="source" position={Position.Right} id="h_out" style="top: 152px; --handle-color: var(--cable-mono-video);" />
  <span class="port-label right" style="top: 146px;">H_OUT</span>
  <Handle type="source" position={Position.Right} id="v_out" style="top: 184px; --handle-color: var(--cable-mono-video);" />
  <span class="port-label right" style="top: 178px;">V_OUT</span>

  <!-- MIX 1 — 2 mono-video signal ins + 1 cv in (left), 1 mono-video out (right) -->
  <Handle type="target" position={Position.Left} id="mix1_a"  style="top: 320px; --handle-color: var(--cable-mono-video);" />
  <span class="port-label left" style="top: 314px;">M1A</span>
  <Handle type="target" position={Position.Left} id="mix1_b"  style="top: 352px; --handle-color: var(--cable-mono-video);" />
  <span class="port-label left" style="top: 346px;">M1B</span>
  <Handle type="target" position={Position.Left} id="mix1_cv" style="top: 384px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 378px;">M1CV</span>
  <Handle type="source" position={Position.Right} id="mix1_out" style="top: 352px; --handle-color: var(--cable-mono-video);" />
  <span class="port-label right" style="top: 346px;">M1_OUT</span>

  <!-- MIX 2 — 2 mono-video signal ins + 1 cv in (left), 1 mono-video out (right) -->
  <Handle type="target" position={Position.Left} id="mix2_a"  style="top: 432px; --handle-color: var(--cable-mono-video);" />
  <span class="port-label left" style="top: 426px;">M2A</span>
  <Handle type="target" position={Position.Left} id="mix2_b"  style="top: 464px; --handle-color: var(--cable-mono-video);" />
  <span class="port-label left" style="top: 458px;">M2B</span>
  <Handle type="target" position={Position.Left} id="mix2_cv" style="top: 496px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 490px;">M2CV</span>
  <Handle type="source" position={Position.Right} id="mix2_out" style="top: 464px; --handle-color: var(--cable-mono-video);" />
  <span class="port-label right" style="top: 458px;">M2_OUT</span>

  <div class="fader-grid">
    <Fader value={p('h_shape')} min={0}   max={1} defaultValue={shapedrampsDef.params.find((x) => x.id === 'h_shape')!.defaultValue} label="HS" curve="linear" onchange={setParam('h_shape')} moduleId={id} paramId="h_shape" />
    <Fader value={p('v_shape')} min={0}   max={1} defaultValue={shapedrampsDef.params.find((x) => x.id === 'v_shape')!.defaultValue} label="VS" curve="linear" onchange={setParam('v_shape')} moduleId={id} paramId="v_shape" />
    <Fader value={p('h_phase')} min={0}   max={1} defaultValue={shapedrampsDef.params.find((x) => x.id === 'h_phase')!.defaultValue} label="HP" curve="linear" onchange={setParam('h_phase')} moduleId={id} paramId="h_phase" />
    <Fader value={p('v_phase')} min={0}   max={1} defaultValue={shapedrampsDef.params.find((x) => x.id === 'v_phase')!.defaultValue} label="VP" curve="linear" onchange={setParam('v_phase')} moduleId={id} paramId="v_phase" />
    <Fader value={p('h_freq')}  min={0.5} max={8} defaultValue={shapedrampsDef.params.find((x) => x.id === 'h_freq')!.defaultValue}  label="HF" curve="linear" onchange={setParam('h_freq')} moduleId={id} paramId="h_freq" />
    <Fader value={p('v_freq')}  min={0.5} max={8} defaultValue={shapedrampsDef.params.find((x) => x.id === 'v_freq')!.defaultValue}  label="VF" curve="linear" onchange={setParam('v_freq')} moduleId={id} paramId="v_freq" />
  </div>

  <div class="mixer-section" data-section="mix1">
    <div class="section-label">MIX 1</div>
    <Fader value={p('mix1')} min={0} max={1} defaultValue={shapedrampsDef.params.find((x) => x.id === 'mix1')!.defaultValue} label="M1" curve="linear" onchange={setParam('mix1')} moduleId={id} paramId="mix1" />
  </div>
  <div class="mixer-section" data-section="mix2">
    <div class="section-label">MIX 2</div>
    <Fader value={p('mix2')} min={0} max={1} defaultValue={shapedrampsDef.params.find((x) => x.id === 'mix2')!.defaultValue} label="M2" curve="linear" onchange={setParam('mix2')} moduleId={id} paramId="mix2" />
  </div>
</div>

<style>
  .card {
    width: 240px;
    min-height: 540px;
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
  .mixer-section {
    margin-top: 18px;
    padding: 0 12px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
  }
  .section-label {
    font-size: 0.6rem;
    color: var(--text-dim);
    letter-spacing: 0.1em;
    font-family: ui-monospace, monospace;
  }
</style>
