<script lang="ts">
  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { mixmstrsDef } from '$lib/audio/modules/mixmstrs';
  import type { ModuleNode, PortDef } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { set, live } = cardParams(mixmstrsDef, () => id, () => node);

  let compact = $state(false);

  function paramVal(id_: string, fallback: number): number {
    const v = node?.params?.[id_];
    return typeof v === 'number' ? v : fallback;
  }

  const CH = [1, 2, 3, 4, 5, 6] as const;
  type Channel = (typeof CH)[number];

  // Sectioned grouping: Ch1..Ch6 + Master, so the patch panel's
  // click-to-expand UX kicks in (each section's row list collapses by
  // default; user clicks a header to fan out the channel's handles).
  // Without this the 73-input column overflows even a 1366×768 viewport
  // when every section is expanded simultaneously.
  //
  // The audio + CV ports for each channel live in the same section so
  // the user can scan one channel's full I/O surface in a single
  // expand. Returns + master live under the Master section alongside
  // the master-bus volume + the 6 master/send outputs.
  function defPortToDescriptor(p: PortDef): PortDescriptor {
    return { id: p.id, cable: p.type };
  }
  // Lookup map keyed on port id so the section builder can pluck
  // exactly the def-declared port (and its cable type) without
  // re-deriving the id mapping in two places.
  const inputById = new Map<string, PortDescriptor>(
    mixmstrsDef.inputs.map((p) => [p.id, defPortToDescriptor(p)] as const),
  );
  const outputById = new Map<string, PortDescriptor>(
    mixmstrsDef.outputs.map((p) => [p.id, defPortToDescriptor(p)] as const),
  );

  function pickInputs(ids: string[]): PortDescriptor[] {
    return ids
      .map((id) => inputById.get(id))
      .filter((p): p is PortDescriptor => p !== undefined);
  }
  function pickOutputs(ids: string[]): PortDescriptor[] {
    return ids
      .map((id) => outputById.get(id))
      .filter((p): p is PortDescriptor => p !== undefined);
  }

  function chSection(ch: Channel) {
    return {
      label: `Ch${ch}`,
      inputs: pickInputs([
        `ch${ch}L`,
        `ch${ch}R`,
        `ch${ch}_volume`,
        `ch${ch}_low`,
        `ch${ch}_mid`,
        `ch${ch}_high`,
        `ch${ch}_thresh`,
        `ch${ch}_ratio`,
        `ch${ch}_compEnable`,
        `comp${ch}`,
        `ch${ch}_send1`,
        `ch${ch}_send2`,
      ]),
    };
  }

  const sections = [
    ...CH.map((ch) => chSection(ch)),
    {
      label: 'Master',
      inputs: pickInputs([
        'ret1L', 'ret1R', 'ret2L', 'ret2R',
        'master_volume',
      ]),
      outputs: pickOutputs([
        'masterL', 'masterR',
        'send1L', 'send1R',
        'send2L', 'send2R',
      ]),
    },
  ];
</script>

<div class="mod-card mixmstrs-card" class:compact>
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <header class="title">
    <ModuleTitle {id} {data} defaultLabel="MIXMSTRS" inline />
    <button class="toggle" onclick={() => (compact = !compact)} title={compact ? 'Expand' : 'Compact'}>
      {compact ? '◇' : '◆'}
    </button>
  </header>

  <!--
    panelWidth is the total open-state popover width. With the
    two-column open layout (inputs left, outputs right), 560 gives
    each column ~265px — wide enough for verbose labels like
    "ch1 SEND 1" without truncation. MIXMSTRS has 73 inputs + 6
    outputs across 7 sections (Ch1..Ch6 + Master); sections
    collapse by default via PatchPanel's click-to-expand UX so the
    panel fits on a 1366×768 laptop viewport even with one or two
    sections open.
  -->
  <PatchPanel nodeId={id} groupingStrategy="sectioned" {sections} panelWidth={560}>
    <div class="grid">
      {#each CH as ch (ch)}
        <div class="ch-col">
          <div class="ch-label">CH {ch}</div>
          <Knob value={paramVal(`ch${ch}_volume`, 0.8)} min={0}    max={1}   defaultValue={0.8} label="Vol" curve="linear"   onchange={set(`ch${ch}_volume`)} moduleId={id} paramId={`ch${ch}_volume`}     readLive={live(`ch${ch}_volume`)} />
          {#if !compact}
            <Knob value={paramVal(`ch${ch}_low`, 0)}    min={-12}  max={12}  defaultValue={0}   label="LOW" curve="linear"   onchange={set(`ch${ch}_low`)} moduleId={id} paramId={`ch${ch}_low`}        readLive={live(`ch${ch}_low`)} />
            <Knob value={paramVal(`ch${ch}_mid`, 0)}    min={-12}  max={12}  defaultValue={0}   label="MID" curve="linear"   onchange={set(`ch${ch}_mid`)} moduleId={id} paramId={`ch${ch}_mid`}        readLive={live(`ch${ch}_mid`)} />
            <Knob value={paramVal(`ch${ch}_high`, 0)}   min={-12}  max={12}  defaultValue={0}   label="HGH" curve="linear"   onchange={set(`ch${ch}_high`)} moduleId={id} paramId={`ch${ch}_high`}       readLive={live(`ch${ch}_high`)} />
            <Knob value={paramVal(`ch${ch}_thresh`, -12)}  min={-36} max={0}   defaultValue={-12} label="THR" curve="linear"   onchange={set(`ch${ch}_thresh`)} moduleId={id} paramId={`ch${ch}_thresh`}     readLive={live(`ch${ch}_thresh`)} />
            <Knob value={paramVal(`ch${ch}_ratio`, 2)}     min={1}   max={10}  defaultValue={2}   label="RAT" curve="linear"   onchange={set(`ch${ch}_ratio`)} moduleId={id} paramId={`ch${ch}_ratio`}      readLive={live(`ch${ch}_ratio`)} />
            <Knob value={paramVal(`ch${ch}_compEnable`, 0)} min={0}  max={1}   defaultValue={0}   label="CMP" curve="discrete" onchange={set(`ch${ch}_compEnable`)} moduleId={id} paramId={`ch${ch}_compEnable`} readLive={live(`ch${ch}_compEnable`)} />
          {/if}
          <!-- Per-channel comp macro knob (always visible — even in compact
               mode — because it's the user-friendly path; the THR/RAT/CMP
               triple above is for power users in expanded mode). -->
          <Knob value={paramVal(`comp${ch}`, 0)}         min={0}   max={1}   defaultValue={0}   label="Comp" curve="linear"   onchange={set(`comp${ch}`)} moduleId={id} paramId={`comp${ch}`}          readLive={live(`comp${ch}`)} />
          <Knob value={paramVal(`ch${ch}_send1`, 0)}  min={0}  max={1}   defaultValue={0}   label="S1"  curve="linear"   onchange={set(`ch${ch}_send1`)} moduleId={id} paramId={`ch${ch}_send1`}      readLive={live(`ch${ch}_send1`)} />
          <Knob value={paramVal(`ch${ch}_send2`, 0)}  min={0}  max={1}   defaultValue={0}   label="S2"  curve="linear"   onchange={set(`ch${ch}_send2`)} moduleId={id} paramId={`ch${ch}_send2`}      readLive={live(`ch${ch}_send2`)} />
        </div>
      {/each}
      <div class="ch-col master-col">
        <div class="ch-label">MASTER</div>
        <Knob value={paramVal('master_volume', 0.8)} min={0} max={1} defaultValue={0.8} label="Vol" curve="linear" onchange={set('master_volume')} moduleId={id} paramId="master_volume" readLive={live('master_volume')} />
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .mixmstrs-card {
    width: 720px;
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
    grid-template-columns: repeat(6, 1fr) 80px;
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
