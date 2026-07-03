<script lang="ts">
  // SidecarCard — stereo sidechain ducker card. Standard fader card
  // pattern (mirrors ResofilterCard / CofefveCard). 9 knobs in two
  // rows: threshold/ratio/knee/makeup on the top row, attack/release/
  // envMag/inputLevel/sc_hpf on the bottom row. PatchPanel surfaces the 7
  // inputs (audio L/R, sc L/R, threshold_cv, env_mag_cv, input_level_cv) +
  // 4 outputs (audio L/R, env_out, env_inv_out).
  //
  // Input Lvl is the sidechain input volume: 0–200% (0.0–2.0 gain, default
  // 100%). Applied to the SC signal before ducking so a quiet pad can be
  // boosted into the mix.
  //
  // env_out + env_inv_out are typed `cv` so they connect to any
  // CV-family sink (STEREOVCA.strength, ADSR-style consumers).
  // Importantly, env_out has NO HARD CLAMP — at envMag>1 it can exceed
  // 1.0; downstream modules in this codebase tolerate this in the same
  // way they tolerate any audio-rate signal exceeding ±1.

  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { setNodeParam } from '$lib/graph/mutate';
  import { sidecarDef } from '$lib/audio/modules/sidecar';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import OssAttribution from './OssAttribution.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  // Build a defaults map by id so we don't depend on the param order in
  // the def array (defensive against future re-ordering).
  const defaults = Object.fromEntries(
    sidecarDef.params.map((p) => [p.id, p.defaultValue] as const),
  );

  let threshold = $derived(node?.params.threshold ?? defaults.threshold);
  let ratio     = $derived(node?.params.ratio     ?? defaults.ratio);
  let attack    = $derived(node?.params.attack    ?? defaults.attack);
  let release   = $derived(node?.params.release   ?? defaults.release);
  let knee      = $derived(node?.params.knee      ?? defaults.knee);
  let envMag    = $derived(node?.params.envMag     ?? defaults.envMag);
  let inputLvl  = $derived(node?.params.inputLevel ?? defaults.inputLevel);
  let makeup    = $derived(node?.params.makeup     ?? defaults.makeup);
  let scHpf     = $derived(node?.params.sc_hpf     ?? defaults.sc_hpf);

  const set = (id_: string) => (v: number) => {
    setNodeParam(id, id_, v);
  };
  const live = (id_: string) => () => {
    const e = engineCtx.get(); if (!e || !node) return undefined;
    return e.readParam(node, id_);
  };

  const inputs: PortDescriptor[] = [
    { id: 'audio_l_in',   label: 'AUD L',  cable: 'audio' },
    { id: 'audio_r_in',   label: 'AUD R',  cable: 'audio' },
    { id: 'sc_l_in',      label: 'SC L',   cable: 'audio' },
    { id: 'sc_r_in',      label: 'SC R',   cable: 'audio' },
    { id: 'threshold_cv',   label: 'THR CV', cable: 'cv' },
    { id: 'env_mag_cv',     label: 'MAG CV', cable: 'cv' },
    { id: 'input_level_cv', label: 'LVL CV', cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'audio_l_out', label: 'OUT L',   cable: 'audio' },
    { id: 'audio_r_out', label: 'OUT R',   cable: 'audio' },
    { id: 'env_out',     label: 'ENV',     cable: 'cv' },
    { id: 'env_inv_out', label: 'ENV INV', cable: 'cv' },
  ];
</script>

<div class="mod-card sidecar-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="SIDECAR" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="fader-row">
      <Fader value={threshold} min={-60} max={0}    defaultValue={defaults.threshold} label="Thresh" curve="linear" onchange={set('threshold')} moduleId={id} paramId="threshold" readLive={live('threshold')} />
      <Fader value={ratio}     min={1}   max={20}   defaultValue={defaults.ratio}     label="Ratio"  curve="log"    onchange={set('ratio')}     moduleId={id} paramId="ratio"     readLive={live('ratio')} />
      <Fader value={knee}      min={0}   max={24}   defaultValue={defaults.knee}      label="Knee"   curve="linear" onchange={set('knee')}      moduleId={id} paramId="knee"      readLive={live('knee')} />
      <Fader value={makeup}    min={0}   max={24}   defaultValue={defaults.makeup}    label="Makeup" curve="linear" onchange={set('makeup')}    moduleId={id} paramId="makeup"    readLive={live('makeup')} />
    </div>
    <div class="fader-row">
      <Fader value={attack}    min={0.1} max={200}  defaultValue={defaults.attack}    label="Att"    curve="log"    onchange={set('attack')}    moduleId={id} paramId="attack"    readLive={live('attack')} />
      <Fader value={release}   min={1}   max={2000} defaultValue={defaults.release}   label="Rel"    curve="log"    onchange={set('release')}   moduleId={id} paramId="release"   readLive={live('release')} />
      <Fader value={envMag}    min={0}   max={2}    defaultValue={defaults.envMag}     label="EnvMag" curve="linear" onchange={set('envMag')}     moduleId={id} paramId="envMag"     readLive={live('envMag')} />
      <Fader value={inputLvl}  min={0}   max={2}    defaultValue={defaults.inputLevel} label="In Lvl" curve="linear" onchange={set('inputLevel')} moduleId={id} paramId="inputLevel" readLive={live('inputLevel')} />
      <Fader value={scHpf}     min={20}  max={1000} defaultValue={defaults.sc_hpf}     label="SC HPF" curve="log"    onchange={set('sc_hpf')}     moduleId={id} paramId="sc_hpf"     readLive={live('sc_hpf')} />
    </div>
  </PatchPanel>

  <OssAttribution author={sidecarDef.ossAttribution?.author ?? ''} />
</div>

<style>
  .sidecar-card { width: 380px; min-height: 240px; }
  .sidecar-card .fader-row { padding: 0 14px; display: flex; gap: 10px; margin-bottom: 6px; }
</style>
