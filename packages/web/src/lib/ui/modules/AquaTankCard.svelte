<script lang="ts">
  // AquaTankCard — 4-channel Hadamard FDN feedback matrix.
  // Layout: 4 feedback faders (one per channel) across the top, then
  // tilt / damp / cross / spread / out below, plus PatchPanel-managed
  // ports.

  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { aquaTankDef } from '$lib/audio/modules/aquatank';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  function defaultFor(k: string): number {
    return aquaTankDef.params.find((p) => p.id === k)?.defaultValue ?? 0;
  }
  function paramVal(k: string): number {
    const v = node?.params?.[k];
    return typeof v === 'number' ? v : defaultFor(k);
  }
  const set = (k: string) => (v: number) => {
    const t = patch.nodes[id]; if (t) t.params[k] = v;
  };
  const live = (k: string) => () => {
    const e = engineCtx.get(); if (!e || !node) return undefined;
    return e.readParam(node, k);
  };

  const inputs: PortDescriptor[] = [
    { id: 'in1',     label: 'IN 1',  cable: 'audio' },
    { id: 'in2',     label: 'IN 2',  cable: 'audio' },
    { id: 'in3',     label: 'IN 3',  cable: 'audio' },
    { id: 'in4',     label: 'IN 4',  cable: 'audio' },
    { id: 'fb1_cv',  label: 'F1 CV', cable: 'cv' },
    { id: 'fb2_cv',  label: 'F2 CV', cable: 'cv' },
    { id: 'fb3_cv',  label: 'F3 CV', cable: 'cv' },
    { id: 'fb4_cv',  label: 'F4 CV', cable: 'cv' },
    { id: 'tilt_cv', label: 'TLT CV',cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'out1',  label: 'OUT 1', cable: 'audio' },
    { id: 'out2',  label: 'OUT 2', cable: 'audio' },
    { id: 'out3',  label: 'OUT 3', cable: 'audio' },
    { id: 'out4',  label: 'OUT 4', cable: 'audio' },
    { id: 'mix_l', label: 'L',     cable: 'audio' },
    { id: 'mix_r', label: 'R',     cable: 'audio' },
  ];
  const channels = [1, 2, 3, 4] as const;
</script>

<div class="mod-card aquatank-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <header class="title">AQUATANK</header>

  <PatchPanel nodeId={id} {inputs} {outputs} panelWidth={300}>
    <div class="body">
      <div class="fb-row">
        {#each channels as ch (ch)}
          <Fader
            value={paramVal(`fb${ch}`)}
            min={0} max={0.95} defaultValue={defaultFor(`fb${ch}`)}
            label={`FB ${ch}`} curve="linear"
            onchange={set(`fb${ch}`)} moduleId={id} paramId={`fb${ch}`}
            readLive={live(`fb${ch}`)}
          />
        {/each}
      </div>
      <div class="bottom-row">
        <Fader value={paramVal('tilt')}     min={-1} max={1} defaultValue={defaultFor('tilt')}     label="Tilt"  curve="linear" onchange={set('tilt')} moduleId={id} paramId="tilt"     readLive={live('tilt')} />
        <Fader value={paramVal('damp')}     min={0}  max={1} defaultValue={defaultFor('damp')}     label="Damp"  curve="linear" onchange={set('damp')} moduleId={id} paramId="damp"     readLive={live('damp')} />
        <Fader value={paramVal('crossMix')} min={0}  max={1} defaultValue={defaultFor('crossMix')} label="Cross" curve="linear" onchange={set('crossMix')} moduleId={id} paramId="crossMix" readLive={live('crossMix')} />
        <Fader value={paramVal('spread')}   min={0}  max={1} defaultValue={defaultFor('spread')}   label="Sprd"  curve="linear" onchange={set('spread')} moduleId={id} paramId="spread"   readLive={live('spread')} />
        <Fader value={paramVal('outLevel')} min={0}  max={1} defaultValue={defaultFor('outLevel')} label="Out"   curve="linear" onchange={set('outLevel')} moduleId={id} paramId="outLevel" readLive={live('outLevel')} />
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .mod-card {
    width: 320px;
    min-height: 300px;
    background: var(--module-bg);
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text);
    padding-top: 18px;
    padding-bottom: 14px;
    position: relative;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  :global(.svelte-flow__node:hover) .mod-card { border-color: var(--accent-dim); }
  :global(.svelte-flow__node.selected) .mod-card {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .stripe { position: absolute; top: 0; left: 0; right: 0; height: 2px; border-radius: 2px 2px 0 0; }
  .title { font-size: 0.85rem; font-weight: 500; text-align: center; margin: 0 0 8px; letter-spacing: 0.05em; }
  .body { padding: 4px 10px 10px; }
  .fb-row {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 6px;
    justify-items: center;
  }
  .bottom-row {
    margin-top: 12px;
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 6px;
    justify-items: center;
  }
</style>
