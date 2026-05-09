<script lang="ts">
  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { mixmstrsDef } from '$lib/audio/modules/mixmstrs';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode, PortDef } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  let compact = $state(false);

  function paramVal(id_: string, fallback: number): number {
    const v = node?.params?.[id_];
    return typeof v === 'number' ? v : fallback;
  }
  const set = (k: string) => (v: number) => { const t = patch.nodes[id]; if (t) t.params[k] = v; };
  const live = (k: string) => () => {
    const e = engineCtx.get(); if (!e || !node) return undefined;
    return e.readParam(node, k);
  };

  const CH = [1, 2, 3, 4] as const;

  // Pull every input port off the def — 12 audio + 37 CV-per-param. The
  // panel's auto-grouping puts Audio first, then CV, with verbose labels
  // resolved from the id stems via patch-panel-labels.ts.
  function defPortToDescriptor(p: PortDef): PortDescriptor {
    return { id: p.id, cable: p.type };
  }
  const inputs: PortDescriptor[] = mixmstrsDef.inputs.map(defPortToDescriptor);
  const outputs: PortDescriptor[] = mixmstrsDef.outputs.map(defPortToDescriptor);
</script>

<div class="mod-card mixmstrs-card" class:compact>
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <header class="title">
    MIXMSTRS
    <button class="toggle" onclick={() => (compact = !compact)} title={compact ? 'Expand' : 'Compact'}>
      {compact ? '◇' : '◆'}
    </button>
  </header>

  <PatchPanel nodeId={id} {inputs} {outputs} panelWidth={320}>
    <div class="grid">
      {#each CH as ch (ch)}
        <div class="ch-col">
          <div class="ch-label">CH {ch}</div>
          <Knob value={paramVal(`ch${ch}_volume`, 0.8)} min={0}    max={1}   defaultValue={0.8} label="Vol" curve="linear"   onchange={set(`ch${ch}_volume`)}     readLive={live(`ch${ch}_volume`)} />
          {#if !compact}
            <Knob value={paramVal(`ch${ch}_low`, 0)}    min={-12}  max={12}  defaultValue={0}   label="LOW" curve="linear"   onchange={set(`ch${ch}_low`)}        readLive={live(`ch${ch}_low`)} />
            <Knob value={paramVal(`ch${ch}_mid`, 0)}    min={-12}  max={12}  defaultValue={0}   label="MID" curve="linear"   onchange={set(`ch${ch}_mid`)}        readLive={live(`ch${ch}_mid`)} />
            <Knob value={paramVal(`ch${ch}_high`, 0)}   min={-12}  max={12}  defaultValue={0}   label="HGH" curve="linear"   onchange={set(`ch${ch}_high`)}       readLive={live(`ch${ch}_high`)} />
            <Knob value={paramVal(`ch${ch}_thresh`, -12)}  min={-36} max={0}   defaultValue={-12} label="THR" curve="linear"   onchange={set(`ch${ch}_thresh`)}     readLive={live(`ch${ch}_thresh`)} />
            <Knob value={paramVal(`ch${ch}_ratio`, 2)}     min={1}   max={10}  defaultValue={2}   label="RAT" curve="linear"   onchange={set(`ch${ch}_ratio`)}      readLive={live(`ch${ch}_ratio`)} />
            <Knob value={paramVal(`ch${ch}_compEnable`, 0)} min={0}  max={1}   defaultValue={0}   label="CMP" curve="discrete" onchange={set(`ch${ch}_compEnable`)} readLive={live(`ch${ch}_compEnable`)} />
          {/if}
          <!-- Per-channel comp macro knob (always visible — even in compact
               mode — because it's the user-friendly path; the THR/RAT/CMP
               triple above is for power users in expanded mode). -->
          <Knob value={paramVal(`comp${ch}`, 0)}         min={0}   max={1}   defaultValue={0}   label="Comp" curve="linear"   onchange={set(`comp${ch}`)}          readLive={live(`comp${ch}`)} />
          <Knob value={paramVal(`ch${ch}_send1`, 0)}  min={0}  max={1}   defaultValue={0}   label="S1"  curve="linear"   onchange={set(`ch${ch}_send1`)}      readLive={live(`ch${ch}_send1`)} />
          <Knob value={paramVal(`ch${ch}_send2`, 0)}  min={0}  max={1}   defaultValue={0}   label="S2"  curve="linear"   onchange={set(`ch${ch}_send2`)}      readLive={live(`ch${ch}_send2`)} />
        </div>
      {/each}
      <div class="ch-col master-col">
        <div class="ch-label">MASTER</div>
        <Knob value={paramVal('master_volume', 0.8)} min={0} max={1} defaultValue={0.8} label="Vol" curve="linear" onchange={set('master_volume')} readLive={live('master_volume')} />
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .mixmstrs-card {
    width: 520px;
    min-height: 460px;
  }
  .mixmstrs-card.compact {
    min-height: 200px;
  }
  .mixmstrs-card .title {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }
  .toggle {
    width: 18px;
    height: 18px;
    background: #2a2f3a;
    border: 1px solid #404652;
    color: var(--text);
    border-radius: 3px;
    font-size: 0.65rem;
    cursor: pointer;
    padding: 0;
    line-height: 1;
  }
  .grid {
    margin-top: 16px;
    display: grid;
    grid-template-columns: repeat(4, 1fr) 80px;
    gap: 8px;
    padding: 0 18px;
  }
  .ch-col {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
  }
  .ch-label {
    font-size: 0.6rem;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .master-col {
    border-left: 1px solid #2a2f3a;
    padding-left: 10px;
  }
</style>
