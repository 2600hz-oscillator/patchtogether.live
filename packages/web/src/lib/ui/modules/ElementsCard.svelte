<script lang="ts">
  // ElementsCard — modal / physical-modeling voice card (Mutable Instruments
  // Elements archetype). EXCITER (BOW/BLOW/STRIKE) → modal RESONATOR + SPACE.
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import OssAttribution from '$lib/ui/modules/OssAttribution.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { elementsDef } from '$lib/audio/modules/elements';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  const defaultFor = (pid: string): number =>
    elementsDef.params.find((p) => p.id === pid)!.defaultValue;

  let note         = $derived(node?.params.note         ?? defaultFor('note'));
  let envShape     = $derived(node?.params.envShape     ?? defaultFor('envShape'));
  let bowLevel     = $derived(node?.params.bowLevel     ?? defaultFor('bowLevel'));
  let bowTimbre    = $derived(node?.params.bowTimbre    ?? defaultFor('bowTimbre'));
  let blowLevel    = $derived(node?.params.blowLevel    ?? defaultFor('blowLevel'));
  let blowMeta     = $derived(node?.params.blowMeta     ?? defaultFor('blowMeta'));
  let blowTimbre   = $derived(node?.params.blowTimbre   ?? defaultFor('blowTimbre'));
  let strikeLevel  = $derived(node?.params.strikeLevel  ?? defaultFor('strikeLevel'));
  let strikeMeta   = $derived(node?.params.strikeMeta   ?? defaultFor('strikeMeta'));
  let strikeTimbre = $derived(node?.params.strikeTimbre ?? defaultFor('strikeTimbre'));
  let geometry     = $derived(node?.params.geometry     ?? defaultFor('geometry'));
  let brightness   = $derived(node?.params.brightness   ?? defaultFor('brightness'));
  let damping      = $derived(node?.params.damping      ?? defaultFor('damping'));
  let position     = $derived(node?.params.position     ?? defaultFor('position'));
  let space        = $derived(node?.params.space        ?? defaultFor('space'));
  let strength     = $derived(node?.params.strength     ?? defaultFor('strength'));

  const set = (k: string) => (v: number) => { const t = patch.nodes[id]; if (t) t.params[k] = v; };
  const live = (k: string) => () => {
    const e = engineCtx.get(); if (!e || !node) return undefined;
    return e.readParam(node, k);
  };

  const inputs: PortDescriptor[] = [
    { id: 'in',          cable: 'audio' },
    { id: 'strike_in',   cable: 'audio' },
    { id: 'pitch',       cable: 'pitch' },
    { id: 'gate',        cable: 'gate' },
    { id: 'note_cv',     cable: 'cv' },
    { id: 'env_cv',      cable: 'cv' },
    { id: 'bowlvl_cv',   cable: 'cv' },
    { id: 'bowtim_cv',   cable: 'cv' },
    { id: 'blowlvl_cv',  cable: 'cv' },
    { id: 'blowmeta_cv', cable: 'cv' },
    { id: 'blowtim_cv',  cable: 'cv' },
    { id: 'strklvl_cv',  cable: 'cv' },
    { id: 'strkmeta_cv', cable: 'cv' },
    { id: 'strktim_cv',  cable: 'cv' },
    { id: 'geom_cv',     cable: 'cv' },
    { id: 'bright_cv',   cable: 'cv' },
    { id: 'damp_cv',     cable: 'cv' },
    { id: 'pos_cv',      cable: 'cv' },
    { id: 'space_cv',    cable: 'cv' },
    { id: 'strength_cv', cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'main', cable: 'audio' },
    { id: 'aux',  cable: 'audio' },
  ];
</script>

<div class="mod-card elements-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="ELEMENTS" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="section-label">EXCITER</div>
    <div class="fader-row">
      <Fader value={bowLevel}     min={0} max={1} defaultValue={0}   label="Bow"       curve="linear" onchange={set('bowLevel')}     moduleId={id} paramId="bowLevel"     readLive={live('bowLevel')} />
      <Fader value={bowTimbre}    min={0} max={1} defaultValue={0.5} label="Bow Tmb"   curve="linear" onchange={set('bowTimbre')}    moduleId={id} paramId="bowTimbre"    readLive={live('bowTimbre')} />
      <Fader value={blowLevel}    min={0} max={1} defaultValue={0}   label="Blow"      curve="linear" onchange={set('blowLevel')}    moduleId={id} paramId="blowLevel"    readLive={live('blowLevel')} />
      <Fader value={blowMeta}     min={0} max={1} defaultValue={0.5} label="Flow"      curve="linear" onchange={set('blowMeta')}     moduleId={id} paramId="blowMeta"     readLive={live('blowMeta')} />
      <Fader value={blowTimbre}   min={0} max={1} defaultValue={0.5} label="Blow Tmb"  curve="linear" onchange={set('blowTimbre')}   moduleId={id} paramId="blowTimbre"   readLive={live('blowTimbre')} />
      <Fader value={strikeLevel}  min={0} max={1} defaultValue={0.8} label="Strike"    curve="linear" onchange={set('strikeLevel')}  moduleId={id} paramId="strikeLevel"  readLive={live('strikeLevel')} />
      <Fader value={strikeMeta}   min={0} max={1} defaultValue={0.5} label="Mallet"    curve="linear" onchange={set('strikeMeta')}   moduleId={id} paramId="strikeMeta"   readLive={live('strikeMeta')} />
      <Fader value={strikeTimbre} min={0} max={1} defaultValue={0.5} label="Strk Tmb"  curve="linear" onchange={set('strikeTimbre')} moduleId={id} paramId="strikeTimbre" readLive={live('strikeTimbre')} />
    </div>

    <div class="section-label">RESONATOR</div>
    <div class="fader-row">
      <Fader value={note}       min={-60} max={60} defaultValue={0}    label="Note"       units="st" curve="linear" onchange={set('note')}       moduleId={id} paramId="note"       readLive={live('note')} />
      <Fader value={geometry}   min={0}   max={1}  defaultValue={0.2}  label="Geometry"   curve="linear" onchange={set('geometry')}   moduleId={id} paramId="geometry"   readLive={live('geometry')} />
      <Fader value={brightness} min={0}   max={1}  defaultValue={0.5}  label="Brightness" curve="linear" onchange={set('brightness')} moduleId={id} paramId="brightness" readLive={live('brightness')} />
      <Fader value={damping}    min={0}   max={1}  defaultValue={0.25} label="Damping"    curve="linear" onchange={set('damping')}    moduleId={id} paramId="damping"    readLive={live('damping')} />
      <Fader value={position}   min={0}   max={1}  defaultValue={0.3}  label="Position"   curve="linear" onchange={set('position')}   moduleId={id} paramId="position"   readLive={live('position')} />
      <Fader value={space}      min={0}   max={2}  defaultValue={0.3}  label="Space"      curve="linear" onchange={set('space')}      moduleId={id} paramId="space"      readLive={live('space')} />
      <Fader value={envShape}   min={0}   max={1}  defaultValue={1}    label="Env"        curve="linear" onchange={set('envShape')}   moduleId={id} paramId="envShape"   readLive={live('envShape')} />
      <Fader value={strength}   min={0}   max={1}  defaultValue={0.5}  label="Strength"   curve="linear" onchange={set('strength')}   moduleId={id} paramId="strength"   readLive={live('strength')} />
    </div>
  </PatchPanel>
  <OssAttribution author={elementsDef.ossAttribution?.author} />
</div>

<style>
  .elements-card { width: 460px; }
  .elements-card .title {
    font-family: var(--font-display, inherit);
    font-size: 0.85rem;
    letter-spacing: 0.04em;
  }
  .elements-card .section-label {
    margin: 8px 12px 0;
    font-family: var(--font-display, monospace);
    font-size: 0.6rem;
    letter-spacing: 0.12em;
    color: var(--text-muted, #999);
  }
  .elements-card .fader-row {
    margin-top: 4px;
    display: flex;
    justify-content: center;
    gap: 6px;
    padding: 0 12px;
    flex-wrap: wrap;
  }
</style>
