<script lang="ts">
  // ANALOGLOGICMATHS card — two attenuverter knobs (A, B) plus the five
  // simultaneous algebraic outputs labeled on the patch panel. Spec lives
  // in $lib/audio/modules/analog-logic-maths.ts.
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { analogLogicMathsDef } from '$lib/audio/modules/analog-logic-maths';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { set, live } = cardParams(analogLogicMathsDef, () => id, () => node);

  let attA = $derived(node?.params.attA ?? analogLogicMathsDef.params[0]!.defaultValue);
  let attB = $derived(node?.params.attB ?? analogLogicMathsDef.params[1]!.defaultValue);


  const inputs = portsFromDef(analogLogicMathsDef.inputs);
  const outputs = portsFromDef(analogLogicMathsDef.outputs, { product: 'PROD' });
</script>

<div class="mod-card alm-card">
  <div class="stripe" style="background: var(--cable-cv);"></div>
  <ModuleTitle {id} {data} defaultLabel="ANALOGLOGICMATHS" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="fader-row">
      <Fader value={attA} min={-1} max={1} defaultValue={1} label="Att A" curve="linear" onchange={set('attA')} moduleId={id} paramId="attA" readLive={live('attA')} />
      <Fader value={attB} min={-1} max={1} defaultValue={1} label="Att B" curve="linear" onchange={set('attB')} moduleId={id} paramId="attB" readLive={live('attB')} />
    </div>
  </PatchPanel>
</div>

<style>
  .alm-card { width: 220px; }
  .alm-card .fader-row { padding: 0 14px; margin-top: 16px; }
</style>
