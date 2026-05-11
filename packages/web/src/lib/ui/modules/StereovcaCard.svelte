<script lang="ts">
  // StereovcaCard — stereo VCA + ring modulator. PatchPanel pattern
  // (mirrors VcaCard). Two faders: master LEVEL post-multiply and a
  // bipolar OFFSET that lifts the strength signal so an unpatched
  // (0V) strength can still pass audio at unity (offset=+1).
  //
  // Strength inputs declare cable type `cv` so LFOs / ADSRs land
  // natively (no cross-type cast). The card surfaces L/R-grouped port
  // labels so the panel hover layout matches the L-on-top, R-below
  // stereo convention.
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { stereovcaDef } from '$lib/audio/modules/stereovca';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  let level  = $derived(node?.params.level  ?? stereovcaDef.params[0]!.defaultValue);
  let offset = $derived(node?.params.offset ?? stereovcaDef.params[1]!.defaultValue);

  const set = (id_: string) => (v: number) => {
    const t = patch.nodes[id]; if (t) t.params[id_] = v;
  };
  const live = (id_: string) => () => {
    const e = engineCtx.get(); if (!e || !node) return undefined;
    return e.readParam(node, id_);
  };

  const inputs: PortDescriptor[] = [
    { id: 'in_l',       label: 'IN L',  cable: 'audio' },
    { id: 'in_r',       label: 'IN R',  cable: 'audio' },
    { id: 'strength_l', label: 'STR L', cable: 'cv' },
    { id: 'strength_r', label: 'STR R', cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'out_l', label: 'OUT L', cable: 'audio' },
    { id: 'out_r', label: 'OUT R', cable: 'audio' },
  ];
</script>

<div class="mod-card stereovca-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <header class="title">STEREOVCA</header>

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="fader-row">
      <Fader value={level}  min={0}  max={1} defaultValue={1.0} label="Level"  curve="linear" onchange={set('level')}  readLive={live('level')} />
      <Fader value={offset} min={-1} max={1} defaultValue={0}   label="Offset" curve="linear" onchange={set('offset')} readLive={live('offset')} />
    </div>
  </PatchPanel>
</div>

<style>
  .stereovca-card { width: 180px; min-height: 200px; }
  .stereovca-card .fader-row { padding: 0 14px; display: flex; gap: 12px; }
</style>
