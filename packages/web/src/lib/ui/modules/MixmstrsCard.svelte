<script lang="ts">
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import { patch } from '$lib/graph/store';
  import { mixmstrsDef } from '$lib/audio/modules/mixmstrs';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';

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

  // Per-channel y offset for handle alignment. 4 stereo pairs × 32 px stride
  // starting at top:56.
  const CH_HANDLE_TOP = (i: number, side: 'L' | 'R') => 56 + i * 64 + (side === 'R' ? 24 : 0);
  const RET_HANDLE_TOP = (i: number, side: 'L' | 'R') => 56 + 4 * 64 + i * 64 + (side === 'R' ? 24 : 0);
  const OUT_HANDLE_TOP = (i: number) => 56 + i * 32;

  const CH = [1, 2, 3, 4] as const;
  const PARAM_KEYS = ['volume', 'low', 'mid', 'high', 'thresh', 'ratio', 'compEnable', 'send1', 'send2'] as const;
</script>

<div class="mod-card mixmstrs-card" class:compact>
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <header class="title">
    MIXMSTRS
    <button class="toggle" onclick={() => (compact = !compact)} title={compact ? 'Expand' : 'Compact'}>
      {compact ? '◇' : '◆'}
    </button>
  </header>

  <!-- Channel inputs (left side, top half) -->
  {#each CH as ch, i (ch)}
    <Handle type="target" position={Position.Left} id={`ch${ch}L`} style="top: {CH_HANDLE_TOP(i, 'L')}px; --handle-color: var(--cable-audio);" />
    <Handle type="target" position={Position.Left} id={`ch${ch}R`} style="top: {CH_HANDLE_TOP(i, 'R')}px; --handle-color: var(--cable-audio);" />
    <span class="port-label left" style="top: {CH_HANDLE_TOP(i, 'L') - 6}px;">ch{ch} L</span>
    <span class="port-label left" style="top: {CH_HANDLE_TOP(i, 'R') - 6}px;">ch{ch} R</span>
  {/each}

  <!-- Returns (left side, bottom half) -->
  {#each [1, 2] as ret, i (ret)}
    <Handle type="target" position={Position.Left} id={`ret${ret}L`} style="top: {RET_HANDLE_TOP(i, 'L')}px; --handle-color: var(--cable-audio);" />
    <Handle type="target" position={Position.Left} id={`ret${ret}R`} style="top: {RET_HANDLE_TOP(i, 'R')}px; --handle-color: var(--cable-audio);" />
    <span class="port-label left" style="top: {RET_HANDLE_TOP(i, 'L') - 6}px;">ret{ret}L</span>
    <span class="port-label left" style="top: {RET_HANDLE_TOP(i, 'R') - 6}px;">ret{ret}R</span>
  {/each}

  <!-- Outputs (right side) -->
  {#each ['masterL', 'masterR', 'send1L', 'send1R', 'send2L', 'send2R'] as out, i (out)}
    <Handle type="source" position={Position.Right} id={out} style="top: {OUT_HANDLE_TOP(i)}px; --handle-color: var(--cable-audio);" />
    <span class="port-label right" style="top: {OUT_HANDLE_TOP(i) - 6}px;">{out}</span>
  {/each}

  <!-- Knob grid -->
  <div class="grid">
    {#each CH as ch (ch)}
      <div class="ch-col">
        <div class="ch-label">CH {ch}</div>
        <Knob value={paramVal(`ch${ch}_volume`, 0.8)} min={0}    max={1}   defaultValue={0.8} label="Vol" curve="linear"   onchange={set(`ch${ch}_volume`)}     readLive={live(`ch${ch}_volume`)} />
        {#if !compact}
          <Knob value={paramVal(`ch${ch}_low`, 0)}    min={-12}  max={12}  defaultValue={0}   label="Lo"  curve="linear"   onchange={set(`ch${ch}_low`)}        readLive={live(`ch${ch}_low`)} />
          <Knob value={paramVal(`ch${ch}_mid`, 0)}    min={-12}  max={12}  defaultValue={0}   label="Md"  curve="linear"   onchange={set(`ch${ch}_mid`)}        readLive={live(`ch${ch}_mid`)} />
          <Knob value={paramVal(`ch${ch}_high`, 0)}   min={-12}  max={12}  defaultValue={0}   label="Hi"  curve="linear"   onchange={set(`ch${ch}_high`)}       readLive={live(`ch${ch}_high`)} />
          <Knob value={paramVal(`ch${ch}_thresh`, -12)}  min={-36} max={0}   defaultValue={-12} label="Th"  curve="linear"   onchange={set(`ch${ch}_thresh`)}     readLive={live(`ch${ch}_thresh`)} />
          <Knob value={paramVal(`ch${ch}_ratio`, 2)}     min={1}   max={10}  defaultValue={2}   label="Rt"  curve="linear"   onchange={set(`ch${ch}_ratio`)}      readLive={live(`ch${ch}_ratio`)} />
          <Knob value={paramVal(`ch${ch}_compEnable`, 0)} min={0}  max={1}   defaultValue={0}   label="Cp"  curve="discrete" onchange={set(`ch${ch}_compEnable`)} readLive={live(`ch${ch}_compEnable`)} />
        {/if}
        <Knob value={paramVal(`ch${ch}_send1`, 0)}  min={0}  max={1}   defaultValue={0}   label="S1"  curve="linear"   onchange={set(`ch${ch}_send1`)}      readLive={live(`ch${ch}_send1`)} />
        <Knob value={paramVal(`ch${ch}_send2`, 0)}  min={0}  max={1}   defaultValue={0}   label="S2"  curve="linear"   onchange={set(`ch${ch}_send2`)}      readLive={live(`ch${ch}_send2`)} />
      </div>
    {/each}
    <div class="ch-col master-col">
      <div class="ch-label">MASTER</div>
      <Knob value={paramVal('master_volume', 0.8)} min={0} max={1} defaultValue={0.8} label="Vol" curve="linear" onchange={set('master_volume')} readLive={live('master_volume')} />
    </div>
  </div>
</div>

<style>
  .mixmstrs-card {
    width: 520px;
    min-height: 480px;
  }
  .mixmstrs-card.compact {
    min-height: 220px;
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
    margin-top: 30px;
    display: grid;
    grid-template-columns: repeat(4, 1fr) 80px;
    gap: 8px;
    padding: 0 60px;
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
