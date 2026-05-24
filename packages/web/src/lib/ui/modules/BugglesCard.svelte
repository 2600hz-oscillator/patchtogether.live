<script lang="ts">
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { bugglesDef } from '$lib/audio/modules/buggles';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  let rate       = $derived(node?.params.rate              ?? bugglesDef.params[0]!.defaultValue);
  let chaos      = $derived(node?.params.chaos             ?? bugglesDef.params[1]!.defaultValue);
  let smoothness = $derived(node?.params.smoothness        ?? bugglesDef.params[2]!.defaultValue);
  let burstProb  = $derived(node?.params.burst_probability ?? bugglesDef.params[3]!.defaultValue);
  let level      = $derived(node?.params.level             ?? bugglesDef.params[4]!.defaultValue);

  const set = (id_: string) => (v: number) => { const t = patch.nodes[id]; if (t) t.params[id_] = v; };
  const live = (id_: string) => () => { const e = engineCtx.get(); if (!e || !node) return undefined; return e.readParam(node, id_); };

  const inputs: PortDescriptor[] = [
    { id: 'clock_cv',       label: 'CLOCK CV', cable: 'cv' },
    { id: 'chaos_cv',       label: 'CHAOS CV', cable: 'cv' },
    { id: 'external_clock', label: 'EXT CLK',  cable: 'gate' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'smooth',  label: 'SMOOTH',  cable: 'cv' },
    { id: 'stepped', label: 'STEPPED', cable: 'cv' },
    { id: 'clock',   label: 'CLOCK',   cable: 'gate' },
    { id: 'burst',   label: 'BURST',   cable: 'gate' },
    { id: 'ring',    label: 'RING',    cable: 'audio' },
  ];
</script>

<div class="mod-card buggles-card">
  <div class="stripe" style="background: var(--cable-cv);"></div>
  <header class="title">BUGGLES</header>

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="fader-row">
      <Fader value={rate}       min={0} max={1} defaultValue={0.4} label="Rate"   curve="linear" onchange={set('rate')} moduleId={id} paramId="rate"              readLive={live('rate')} />
      <Fader value={chaos}      min={0} max={1} defaultValue={0.3} label="Chaos"  curve="linear" onchange={set('chaos')} moduleId={id} paramId="chaos"             readLive={live('chaos')} />
      <Fader value={smoothness} min={0} max={1} defaultValue={0.5} label="Smooth" curve="linear" onchange={set('smoothness')} moduleId={id} paramId="smoothness"        readLive={live('smoothness')} />
      <Fader value={burstProb}  min={0} max={1} defaultValue={0.2} label="Burst"  curve="linear" onchange={set('burst_probability')} moduleId={id} paramId="burst_probability" readLive={live('burst_probability')} />
      <Fader value={level}      min={0} max={1} defaultValue={0.7} label="Level"  curve="linear" onchange={set('level')} moduleId={id} paramId="level"             readLive={live('level')} />
    </div>
  </PatchPanel>
</div>

<style>
  .buggles-card { width: 280px; min-height: 220px; }
  .buggles-card .fader-row { padding: 0 14px; margin-top: 18px; gap: 4px; }
</style>
