<script lang="ts">
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { qbrtDef } from '$lib/audio/modules/qbrt';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  let cutoff    = $derived(node?.params.cutoff    ?? qbrtDef.params[0]!.defaultValue);
  let resonance = $derived(node?.params.resonance ?? qbrtDef.params[1]!.defaultValue);
  let mode      = $derived(node?.params.mode      ?? qbrtDef.params[2]!.defaultValue);
  let pingDecay = $derived(node?.params.pingDecay ?? qbrtDef.params[3]!.defaultValue);

  const set = (id_: string) => (v: number) => { const t = patch.nodes[id]; if (t) t.params[id_] = v; };
  const live = (id_: string) => () => { const e = engineCtx.get(); if (!e || !node) return undefined; return e.readParam(node, id_); };

  const inputs: PortDescriptor[] = [
    { id: 'L',         cable: 'audio' },
    { id: 'R',         cable: 'audio' },
    { id: 'ping',      cable: 'gate' },
    { id: 'cutoff',    cable: 'cv' },
    { id: 'resonance', cable: 'cv' },
    { id: 'mode',      cable: 'cv' },
    { id: 'pingDecay', label: 'PING DECAY', cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'L', cable: 'audio' },
    { id: 'R', cable: 'audio' },
  ];
</script>

<div class="mod-card qbrt-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <header class="title">QBRT</header>

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="fader-row">
      <Fader value={cutoff}    min={20}    max={20000} defaultValue={1000} label="Cutoff"     units="Hz" curve="log"    onchange={set('cutoff')} moduleId={id} paramId="cutoff"    readLive={live('cutoff')} />
      <Fader value={resonance} min={0}     max={0.99}  defaultValue={0.7}  label="Resonance"             curve="linear" onchange={set('resonance')} moduleId={id} paramId="resonance" readLive={live('resonance')} />
      <Fader value={mode}      min={0}     max={1}     defaultValue={0}    label="Mode"                  curve="linear" onchange={set('mode')} moduleId={id} paramId="mode"      readLive={live('mode')} />
      <Fader value={pingDecay} min={0.005} max={0.5}   defaultValue={0.15} label="Ping Decay" units="s"  curve="log"    onchange={set('pingDecay')} moduleId={id} paramId="pingDecay" readLive={live('pingDecay')} />
    </div>
  </PatchPanel>
</div>

<style>
  .qbrt-card { width: 280px; min-height: 240px; }
  .qbrt-card .fader-row { padding: 0 24px; margin-top: 14px; }
</style>
