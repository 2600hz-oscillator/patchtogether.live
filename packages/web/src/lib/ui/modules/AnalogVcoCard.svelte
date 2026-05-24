<script lang="ts">
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { analogVcoDef } from '$lib/audio/modules/analog-vco';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  const engineCtx = useEngine();

  let tune     = $derived(node?.params.tune     ?? analogVcoDef.params.find((p) => p.id === 'tune')!.defaultValue);
  let fine     = $derived(node?.params.fine     ?? analogVcoDef.params.find((p) => p.id === 'fine')!.defaultValue);
  let fmAmount = $derived(node?.params.fmAmount ?? analogVcoDef.params.find((p) => p.id === 'fmAmount')!.defaultValue);
  let pmAmount = $derived(node?.params.pmAmount ?? analogVcoDef.params.find((p) => p.id === 'pmAmount')!.defaultValue);
  let pw       = $derived(node?.params.pw       ?? analogVcoDef.params.find((p) => p.id === 'pw')!.defaultValue);

  function setParam(paramId: string) {
    return (v: number) => {
      const target = patch.nodes[id];
      if (target) target.params[paramId] = v;
    };
  }
  function readLive(paramId: string) {
    return () => {
      const eng = engineCtx.get();
      if (!eng || !node) return undefined;
      return eng.readParam(node, paramId);
    };
  }

  const inputs: PortDescriptor[] = [
    { id: 'pitch',    cable: 'pitch' },
    { id: 'fm',       cable: 'audio' },
    { id: 'pm',       cable: 'audio' },
    { id: 'tune',     cable: 'cv' },
    { id: 'fine',     cable: 'cv' },
    { id: 'fmAmount', label: 'FM AMT', cable: 'cv' },
    { id: 'pmAmount', label: 'PM AMT', cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'saw',      cable: 'audio' },
    { id: 'square',   cable: 'audio' },
    { id: 'triangle', cable: 'audio' },
    { id: 'sine',     cable: 'audio' },
  ];
</script>

<div class="card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <header class="title">Analog VCO</header>

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="fader-row">
      <Fader value={tune}     min={-36} max={36}     defaultValue={0}   label="Tune" units="st" curve="linear" onchange={setParam('tune')} moduleId={id} paramId="tune"     readLive={readLive('tune')} />
      <Fader value={fine}     min={-100} max={100}   defaultValue={0}   label="Fine" units="¢"  curve="linear" onchange={setParam('fine')} moduleId={id} paramId="fine"     readLive={readLive('fine')} />
      <Fader value={fmAmount} min={0}   max={1}      defaultValue={0}   label="FM"              curve="linear" onchange={setParam('fmAmount')} moduleId={id} paramId="fmAmount" readLive={readLive('fmAmount')} />
      <Fader value={pmAmount} min={0}   max={1}      defaultValue={0}   label="PM"              curve="linear" onchange={setParam('pmAmount')} moduleId={id} paramId="pmAmount" readLive={readLive('pmAmount')} />
      <Fader value={pw}       min={0.05} max={0.95}  defaultValue={0.5} label="PW"              curve="linear" onchange={setParam('pw')} moduleId={id} paramId="pw"       readLive={readLive('pw')} />
    </div>
  </PatchPanel>
</div>

<style>
  .card {
    width: 240px;
    min-height: 200px;
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
  :global(.svelte-flow__node:hover) .card {
    border-color: var(--accent-dim);
  }
  :global(.svelte-flow__node.selected) .card {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .stripe {
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    border-radius: 2px 2px 0 0;
  }
  .title {
    font-size: 0.85rem;
    font-weight: 500;
    text-align: center;
    margin: 0 0 8px;
    letter-spacing: 0.02em;
  }
  .fader-row {
    margin-top: 16px;
    display: flex;
    gap: 6px;
    padding: 0 18px;
    justify-content: space-between;
  }
</style>
