<script lang="ts">
  // DELAY — mono delay line with time / feedback / mix. Pure-JS
  // factory wires a DelayNode + feedback loop; see
  // /Users/2600hz/Documents/workspace/inet.modular/packages/web/src/lib/audio/modules/delay.ts
  // for the topology.
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { delayDef } from '$lib/audio/modules/delay';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  let time     = $derived(node?.params.time     ?? delayDef.params[0]!.defaultValue);
  let feedback = $derived(node?.params.feedback ?? delayDef.params[1]!.defaultValue);
  let mix      = $derived(node?.params.mix      ?? delayDef.params[2]!.defaultValue);

  const set = (k: string) => (v: number) => { const t = patch.nodes[id]; if (t) t.params[k] = v; };
  const live = (k: string) => () => { const e = engineCtx.get(); if (!e || !node) return undefined; return e.readParam(node, k); };

  const inputs: PortDescriptor[] = [
    { id: 'audio', label: 'IN',   cable: 'audio' },
    { id: 'time',  label: 'TIME', cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [{ id: 'audio', label: 'OUT', cable: 'audio' }];
</script>

<div class="mod-card delay-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <header class="title">DELAY</header>

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="fader-row">
      <Fader value={time}     min={0.001} max={2}    defaultValue={0.25} label="Time" units="s" curve="log"    onchange={set('time')} moduleId={id} paramId="time"     readLive={live('time')} />
      <Fader value={feedback} min={0}     max={0.95} defaultValue={0.4}  label="Fb"   curve="linear"        onchange={set('feedback')} moduleId={id} paramId="feedback" readLive={live('feedback')} />
      <Fader value={mix}      min={0}     max={1}    defaultValue={0.35} label="Mix"  curve="linear"        onchange={set('mix')} moduleId={id} paramId="mix"      readLive={live('mix')} />
    </div>
  </PatchPanel>
</div>

<style>
  .delay-card { width: 200px; min-height: 180px; }
  .delay-card .fader-row { margin-top: 14px; padding: 0 18px; }
</style>
