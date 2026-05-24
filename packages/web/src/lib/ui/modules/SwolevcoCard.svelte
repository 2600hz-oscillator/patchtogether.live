<script lang="ts">
  // SwolevcoCard — Buchla-259-style complex VCO. PatchPanel pattern
  // (mirrors AdsrCard / VcaCard). Knobs for tune/fine, modulator
  // tune/fine, ratio, timbre, symmetry, fold; ports for the four
  // outputs (out / mod_out / sum_out / scope) and the various inputs
  // (pitch, mod_pitch, fm, plus cv-modulatable knobs).
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { swolevcoDef } from '$lib/audio/modules/swolevco';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  function paramVal(id_: string, fallback: number): number {
    const v = node?.params?.[id_];
    return typeof v === 'number' ? v : fallback;
  }
  const set = (k: string) => (v: number) => {
    const t = patch.nodes[id]; if (t) t.params[k] = v;
  };
  const live = (k: string) => () => {
    const e = engineCtx.get(); if (!e || !node) return undefined;
    return e.readParam(node, k);
  };

  // Inputs + outputs feed the PatchPanel. The patch-panel auto-grouper
  // sorts by cable type — pitches first, then audio, then cv. Outputs
  // group similarly (audio + mono-video).
  const inputs: PortDescriptor[] = [
    { id: 'pitch',     cable: 'pitch' },
    { id: 'mod_pitch', label: 'MOD PITCH', cable: 'pitch' },
    { id: 'fm',        cable: 'audio' },
    { id: 'timbre',    cable: 'cv' },
    { id: 'symmetry',  cable: 'cv' },
    { id: 'fold',      cable: 'cv' },
    { id: 'ratio',     cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'out',     cable: 'audio' },
    { id: 'mod_out', label: 'MOD OUT', cable: 'audio' },
    { id: 'sum_out', label: 'SUM OUT', cable: 'audio' },
    { id: 'scope',   cable: 'mono-video' },
  ];
</script>

<div class="mod-card swolevco-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <header class="title">SWOLEVCO</header>

  <PatchPanel nodeId={id} {inputs} {outputs} panelWidth={280}>
    <div class="grid">
      <div class="row">
        <Fader value={paramVal('tune', 0)}      min={-36}  max={36}   defaultValue={0}   label="Tune"  units="st" curve="linear" onchange={set('tune')} moduleId={id} paramId="tune"     readLive={live('tune')} />
        <Fader value={paramVal('fine', 0)}      min={-100} max={100}  defaultValue={0}   label="Fine"  units="¢"  curve="linear" onchange={set('fine')} moduleId={id} paramId="fine"     readLive={live('fine')} />
        <Fader value={paramVal('mod_tune', 0)}  min={-36}  max={36}   defaultValue={0}   label="M.Tn"  units="st" curve="linear" onchange={set('mod_tune')} moduleId={id} paramId="mod_tune" readLive={live('mod_tune')} />
        <Fader value={paramVal('mod_fine', 0)}  min={-100} max={100}  defaultValue={0}   label="M.Fn"  units="¢"  curve="linear" onchange={set('mod_fine')} moduleId={id} paramId="mod_fine" readLive={live('mod_fine')} />
      </div>
      <div class="row">
        <Fader value={paramVal('ratio', 1.0)}    min={0}    max={8}    defaultValue={1.0} label="Ratio"            curve="linear" onchange={set('ratio')} moduleId={id} paramId="ratio"    readLive={live('ratio')} />
        <Fader value={paramVal('timbre', 0)}     min={0}    max={1}    defaultValue={0}   label="Timbr"            curve="linear" onchange={set('timbre')} moduleId={id} paramId="timbre"   readLive={live('timbre')} />
        <Fader value={paramVal('symmetry', 0.5)} min={0}    max={1}    defaultValue={0.5} label="Sym"              curve="linear" onchange={set('symmetry')} moduleId={id} paramId="symmetry" readLive={live('symmetry')} />
        <Fader value={paramVal('fold', 0)}       min={0}    max={1}    defaultValue={0}   label="Fold"             curve="linear" onchange={set('fold')} moduleId={id} paramId="fold"     readLive={live('fold')} />
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .swolevco-card {
    width: 360px;
    min-height: 280px;
  }
  .swolevco-card .grid {
    margin-top: 16px;
    padding: 0 18px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .swolevco-card .row {
    display: flex;
    gap: 8px;
    justify-content: space-between;
  }
</style>
