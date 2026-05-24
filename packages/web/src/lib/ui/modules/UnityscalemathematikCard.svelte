<script lang="ts">
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { unityscalemathematikDef } from '$lib/audio/modules/unityscalemathematik';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  let unityAtten = $derived(node?.params.unityAtten ?? unityscalemathematikDef.params[0]!.defaultValue);
  let aAtten     = $derived(node?.params.aAtten     ?? unityscalemathematikDef.params[1]!.defaultValue);
  let aCurve     = $derived(node?.params.aCurve     ?? unityscalemathematikDef.params[2]!.defaultValue);
  let bAtten     = $derived(node?.params.bAtten     ?? unityscalemathematikDef.params[3]!.defaultValue);
  let bCurve     = $derived(node?.params.bCurve     ?? unityscalemathematikDef.params[4]!.defaultValue);

  const set = (id_: string) => (v: number) => { const t = patch.nodes[id]; if (t) t.params[id_] = v; };
  const live = (id_: string) => () => { const e = engineCtx.get(); if (!e || !node) return undefined; return e.readParam(node, id_); };

  const inputs: PortDescriptor[] = [
    { id: 'u_in',       cable: 'cv' },
    { id: 'u_atten_cv', cable: 'cv' },
    { id: 'a_in',       cable: 'cv' },
    { id: 'a_atten_cv', cable: 'cv' },
    { id: 'a_curve_cv', cable: 'cv' },
    { id: 'b_in',       cable: 'cv' },
    { id: 'b_atten_cv', cable: 'cv' },
    { id: 'b_curve_cv', cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'u_out', label: 'U', cable: 'cv' },
    { id: 'a_out', label: 'A', cable: 'cv' },
    { id: 'b_out', label: 'B', cable: 'cv' },
  ];
</script>

<div class="mod-card unity-card">
  <div class="stripe" style="background: var(--cable-cv);"></div>
  <header class="title">UNITYSCALEMATHEMATIK</header>

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="section">
      <div class="section-label">UNITY</div>
      <div class="fader-row">
        <Fader value={unityAtten} min={-1} max={1} defaultValue={1} label="Att" curve="linear" onchange={set('unityAtten')} moduleId={id} paramId="unityAtten" readLive={live('unityAtten')} />
      </div>
    </div>
    <div class="section">
      <div class="section-label">A</div>
      <div class="fader-row">
        <Fader value={aAtten} min={-1} max={1} defaultValue={1} label="Att"   curve="linear" onchange={set('aAtten')} moduleId={id} paramId="aAtten" readLive={live('aAtten')} />
        <Fader value={aCurve} min={0}  max={1} defaultValue={0} label="Curve" curve="linear" onchange={set('aCurve')} moduleId={id} paramId="aCurve" readLive={live('aCurve')} />
      </div>
    </div>
    <div class="section">
      <div class="section-label">B</div>
      <div class="fader-row">
        <Fader value={bAtten} min={-1} max={1} defaultValue={1} label="Att"   curve="linear" onchange={set('bAtten')} moduleId={id} paramId="bAtten" readLive={live('bAtten')} />
        <Fader value={bCurve} min={0}  max={1} defaultValue={0} label="Curve" curve="linear" onchange={set('bCurve')} moduleId={id} paramId="bCurve" readLive={live('bCurve')} />
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .unity-card { width: 240px; min-height: 360px; }
  .unity-card .section { margin-top: 10px; }
  .unity-card .section-label {
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--fg-muted, #777);
    padding: 0 14px;
    margin-bottom: 2px;
  }
  .unity-card .fader-row { padding: 0 14px; }
</style>
