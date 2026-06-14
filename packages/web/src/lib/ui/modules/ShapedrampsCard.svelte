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
  import { type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { setNodeParam } from '$lib/graph/mutate';
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
    return (v: number) => setNodeParam(id, paramId, v);
  }

  const inputs: PortDescriptor[] = [
    // 6 CV inputs (shape/phase/freq).
    { id: 'h_shape', label: 'HS',   cable: 'cv' },
    { id: 'v_shape', label: 'VS',   cable: 'cv' },
    { id: 'h_phase', label: 'HP',   cable: 'cv' },
    { id: 'v_phase', label: 'VP',   cable: 'cv' },
    { id: 'h_freq',  label: 'HF',   cable: 'cv' },
    { id: 'v_freq',  label: 'VF',   cable: 'cv' },
    // MIX 1 — 2 mono-video signal ins + 1 cv in.
    { id: 'mix1_a',  label: 'M1A',  cable: 'mono-video' },
    { id: 'mix1_b',  label: 'M1B',  cable: 'mono-video' },
    { id: 'mix1_cv', label: 'M1CV', cable: 'cv' },
    // MIX 2 — 2 mono-video signal ins + 1 cv in.
    { id: 'mix2_a',  label: 'M2A',  cable: 'mono-video' },
    { id: 'mix2_b',  label: 'M2B',  cable: 'mono-video' },
    { id: 'mix2_cv', label: 'M2CV', cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    // 4 mono-video outputs (linear identity + shaped).
    { id: 'h_lin',    label: 'H_LIN',  cable: 'mono-video' },
    { id: 'v_lin',    label: 'V_LIN',  cable: 'mono-video' },
    { id: 'h_out',    label: 'H_OUT',  cable: 'mono-video' },
    { id: 'v_out',    label: 'V_OUT',  cable: 'mono-video' },
    // Mixer outs.
    { id: 'mix1_out', label: 'M1_OUT', cable: 'mono-video' },
    { id: 'mix2_out', label: 'M2_OUT', cable: 'mono-video' },
  ];
</script>

<div class="card video">
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="SHAPEDRAMPS" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
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
  </PatchPanel>
</div>

<style>
  .card {
    width: 240px;
    min-height: 280px;
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
  .fader-grid {
    margin-top: 16px;
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
