<script lang="ts">
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { drummergirlDef } from '$lib/audio/modules/drummergirl';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  let pitch  = $derived(node?.params.pitch  ?? drummergirlDef.params[0]!.defaultValue);
  let tone   = $derived(node?.params.tone   ?? drummergirlDef.params[1]!.defaultValue);
  let shape  = $derived(node?.params.shape  ?? drummergirlDef.params[2]!.defaultValue);
  let volume = $derived(node?.params.volume ?? drummergirlDef.params[3]!.defaultValue);
  let decay  = $derived(node?.params.decay  ?? drummergirlDef.params[4]!.defaultValue);

  const set = (id_: string) => (v: number) => { const t = patch.nodes[id]; if (t) t.params[id_] = v; };
  const live = (id_: string) => () => { const e = engineCtx.get(); if (!e || !node) return undefined; return e.readParam(node, id_); };

  const inputs: PortDescriptor[] = [
    { id: 'gate',   cable: 'gate' },
    { id: 'pitch',  cable: 'cv' },
    { id: 'tone',   cable: 'cv' },
    { id: 'shape',  cable: 'cv' },
    { id: 'volume', cable: 'cv' },
    { id: 'decay',  cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [{ id: 'audio', label: 'OUT', cable: 'audio' }];
</script>

<div class="mod-card drummergirl-card">
  <div class="stripe" style="background: var(--cable-gate);"></div>
  <header class="title">DRUMMERGIRL</header>

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="fader-row">
      <Fader value={pitch}  min={-36}   max={36}  defaultValue={0}    label="Pitch"  units="st" curve="linear" onchange={set('pitch')} moduleId={id} paramId="pitch"  readLive={live('pitch')} />
      <Fader value={tone}   min={0}     max={1}   defaultValue={0.3}  label="Tone"              curve="linear" onchange={set('tone')} moduleId={id} paramId="tone"   readLive={live('tone')} />
      <Fader value={shape}  min={0}     max={1}   defaultValue={0.3}  label="Shape"             curve="linear" onchange={set('shape')} moduleId={id} paramId="shape"  readLive={live('shape')} />
      <Fader value={decay}  min={0.001} max={0.5} defaultValue={0.15} label="Decay"  units="s"  curve="log"    onchange={set('decay')} moduleId={id} paramId="decay"  readLive={live('decay')} />
      <Fader value={volume} min={0}     max={2.0} defaultValue={1.0}  label="Volume"            curve="linear" onchange={set('volume')} moduleId={id} paramId="volume" readLive={live('volume')} />
    </div>
  </PatchPanel>
</div>

<style>
  .drummergirl-card { width: 320px; min-height: 240px; }
  .drummergirl-card .fader-row { padding: 0 24px; margin-top: 14px; }
</style>
