<script lang="ts">
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import ScopeScreen from '$lib/ui/controls/ScopeScreen.svelte';
  import { adsrDef } from '$lib/audio/modules/adsr';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { set, live } = cardParams(adsrDef, () => id, () => node);

  let attack  = $derived(node?.params.attack  ?? adsrDef.params[0]!.defaultValue);
  let decay   = $derived(node?.params.decay   ?? adsrDef.params[1]!.defaultValue);
  let sustain = $derived(node?.params.sustain ?? adsrDef.params[2]!.defaultValue);
  let release = $derived(node?.params.release ?? adsrDef.params[3]!.defaultValue);


  const inputs = portsFromDef(adsrDef.inputs);
  const outputs = portsFromDef(adsrDef.outputs, { env_inv: 'ENV INV' });
</script>

<div class="mod-card adsr-card">
  <div class="stripe" style="background: var(--cable-gate);"></div>
  <ModuleTitle {id} {data} defaultLabel="ADSR" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <!-- Live DECAY-screen glyph: the ADSR curve recomputed as the faders move. -->
    <div class="env-screen">
      <ScopeScreen
        mode="envelope"
        {attack}
        {decay}
        {sustain}
        {release}
        width={204}
        height={56}
        testid="adsr-envelope-screen"
        ariaLabel="ADSR envelope shape"
      />
    </div>
    <div class="fader-row">
      <Fader value={attack}  min={0.001} max={10} defaultValue={0.005} label="Attack"  units="s" curve="log"    onchange={set('attack')}  readLive={live('attack')}  moduleId={id} paramId="attack" />
      <Fader value={decay}   min={0.001} max={10} defaultValue={0.1}   label="Decay"   units="s" curve="log"    onchange={set('decay')}   readLive={live('decay')}   moduleId={id} paramId="decay" />
      <Fader value={sustain} min={0}     max={1}  defaultValue={0.7}   label="Sustain"           curve="linear" onchange={set('sustain')} readLive={live('sustain')} moduleId={id} paramId="sustain" />
      <Fader value={release} min={0.001} max={10} defaultValue={0.3}   label="Release" units="s" curve="log"    onchange={set('release')} readLive={live('release')} moduleId={id} paramId="release" />
    </div>
  </PatchPanel>
</div>

<style>
  .adsr-card { width: 240px; }
  .adsr-card .env-screen { padding: 12px 18px 0; display: flex; justify-content: center; }
  .adsr-card .fader-row { padding: 0 18px; margin-top: 12px; }
</style>
