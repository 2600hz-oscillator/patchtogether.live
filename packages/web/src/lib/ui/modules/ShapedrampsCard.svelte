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
  import { setNodeParam } from '$lib/graph/mutate';
  import { shapedrampsDef } from '$lib/video/modules/shapedramps';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  function p(name: string): number {
    const def = shapedrampsDef.params.find((d) => d.id === name);
    return node?.params[name] ?? def?.defaultValue ?? 0;
  }
  function setParam(paramId: string) {
    return (v: number) => setNodeParam(id, paramId, v);
  }

  const inputs = portsFromDef(shapedrampsDef.inputs, {
    h_shape: 'HS', v_shape: 'VS', h_phase: 'HP', v_phase: 'VP', h_freq: 'HF', v_freq: 'VF',
    mix1_a: 'M1A', mix1_b: 'M1B', mix2_a: 'M2A', mix2_b: 'M2B', mix1_cv: 'M1CV',
    mix2_cv: 'M2CV',
  });
  const outputs = portsFromDef(shapedrampsDef.outputs, { mix1_out: 'M1_OUT', mix2_out: 'M2_OUT' });
</script>

<div class="vcard card video">
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
  }
  .stripe {
    background: var(--cable-mono-video);
  }  .fader-grid {
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
