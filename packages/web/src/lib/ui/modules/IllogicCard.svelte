<script lang="ts">
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { illogicDef } from '$lib/audio/modules/illogic';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  let att1 = $derived(node?.params.att1_amount ?? illogicDef.params[0]!.defaultValue);
  let att2 = $derived(node?.params.att2_amount ?? illogicDef.params[1]!.defaultValue);
  let att3 = $derived(node?.params.att3_amount ?? illogicDef.params[2]!.defaultValue);
  let att4 = $derived(node?.params.att4_amount ?? illogicDef.params[3]!.defaultValue);

  const set = (id_: string) => (v: number) => { const t = patch.nodes[id]; if (t) t.params[id_] = v; };
  const live = (id_: string) => () => { const e = engineCtx.get(); if (!e || !node) return undefined; return e.readParam(node, id_); };

  const inputs: PortDescriptor[] = [
    { id: 'in1', cable: 'cv' },
    { id: 'in2', cable: 'cv' },
    { id: 'in3', cable: 'cv' },
    { id: 'in4', cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'att1', label: 'ATT1', cable: 'cv' },
    { id: 'att2', label: 'ATT2', cable: 'cv' },
    { id: 'att3', label: 'ATT3', cable: 'cv' },
    { id: 'att4', label: 'ATT4', cable: 'cv' },
    { id: 'sum',  label: 'SUM',  cable: 'cv' },
    { id: 'diff', label: 'DIFF', cable: 'cv' },
    { id: 'and',  label: 'AND',  cable: 'gate' },
    { id: 'nand', label: 'NAND', cable: 'gate' },
    { id: 'or',   label: 'OR',   cable: 'gate' },
    { id: 'not',  label: 'NOT',  cable: 'gate' },
  ];
</script>

<div class="mod-card illogic-card">
  <div class="stripe" style="background: var(--cable-cv);"></div>
  <header class="title">ILLOGIC</header>

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="fader-row">
      <Fader value={att1} min={-1} max={1} defaultValue={1} label="Att1" curve="linear" onchange={set('att1_amount')} readLive={live('att1_amount')} />
      <Fader value={att2} min={-1} max={1} defaultValue={1} label="Att2" curve="linear" onchange={set('att2_amount')} readLive={live('att2_amount')} />
      <Fader value={att3} min={-1} max={1} defaultValue={1} label="Att3" curve="linear" onchange={set('att3_amount')} readLive={live('att3_amount')} />
      <Fader value={att4} min={-1} max={1} defaultValue={1} label="Att4" curve="linear" onchange={set('att4_amount')} readLive={live('att4_amount')} />
    </div>
  </PatchPanel>
</div>

<style>
  .illogic-card { width: 240px; min-height: 220px; }
  .illogic-card .fader-row { padding: 0 14px; margin-top: 16px; }
</style>
