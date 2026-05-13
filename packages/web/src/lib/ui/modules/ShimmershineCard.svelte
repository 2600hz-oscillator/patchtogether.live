<script lang="ts">
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { shimmershineDef } from '$lib/audio/modules/shimmershine';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  let decay   = $derived(node?.params.decay   ?? shimmershineDef.params[0]!.defaultValue);
  let shimmer = $derived(node?.params.shimmer ?? shimmershineDef.params[1]!.defaultValue);
  let size    = $derived(node?.params.size    ?? shimmershineDef.params[2]!.defaultValue);
  let damp    = $derived(node?.params.damp    ?? shimmershineDef.params[3]!.defaultValue);
  let mix     = $derived(node?.params.mix     ?? shimmershineDef.params[4]!.defaultValue);

  const set = (k: string) => (v: number) => { const t = patch.nodes[id]; if (t) t.params[k] = v; };
  const live = (k: string) => () => {
    const e = engineCtx.get(); if (!e || !node) return undefined;
    return e.readParam(node, k);
  };

  const inputs: PortDescriptor[] = [
    { id: 'in_l',       cable: 'audio' },
    { id: 'in_r',       cable: 'audio' },
    { id: 'decay_cv',   cable: 'cv' },
    { id: 'shimmer_cv', cable: 'cv' },
    { id: 'size_cv',    cable: 'cv' },
    { id: 'mix_cv',     cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'out_l', cable: 'audio' },
    { id: 'out_r', cable: 'audio' },
  ];
</script>

<div class="mod-card shimmershine-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <header class="title">SHIMMERSHINE</header>

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="fader-row">
      <Fader value={decay}   min={0} max={1} defaultValue={0.6} label="Decay"   curve="linear" onchange={set('decay')}   readLive={live('decay')} />
      <Fader value={shimmer} min={0} max={1} defaultValue={0.4} label="Shimmer" curve="linear" onchange={set('shimmer')} readLive={live('shimmer')} />
      <Fader value={size}    min={0} max={1} defaultValue={0.6} label="Size"    curve="linear" onchange={set('size')}    readLive={live('size')} />
      <Fader value={damp}    min={0} max={1} defaultValue={0.4} label="Damp"    curve="linear" onchange={set('damp')}    readLive={live('damp')} />
      <Fader value={mix}     min={0} max={1} defaultValue={0.4} label="Mix"     curve="linear" onchange={set('mix')}     readLive={live('mix')} />
    </div>
  </PatchPanel>
</div>

<style>
  .shimmershine-card { width: 280px; min-height: 220px; }
  .shimmershine-card .title {
    font-family: var(--font-display, inherit);
    font-size: 0.85rem;
    letter-spacing: 0.04em;
  }
  .shimmershine-card .fader-row {
    margin-top: 14px;
    display: flex;
    justify-content: center;
    gap: 12px;
    padding: 0 18px;
  }
</style>
