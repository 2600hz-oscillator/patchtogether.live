<script lang="ts">
  // ANALOGLOGICMATHS card — two attenuverter knobs (A, B) plus the five
  // simultaneous algebraic outputs labeled on the patch panel. Spec lives
  // in $lib/audio/modules/analog-logic-maths.ts.
  //
  // ⚠ EVERY RANGE, CURVE, UNIT **AND LABEL** IS BOUND TO THE DEF (`paramSpec`),
  // NEVER RE-TYPED — the backdraft / #1746 treatment, paid here because
  // PROMOTION (queue Q19) is what makes a divergence user-visible: from that
  // point `ModuleShell` renders the dock full view straight off the `ParamDef`,
  // so a card and a dock could call one fader two different things with nobody
  // reviewing the rename.
  //
  // NOTHING DIVERGED. All four numeric props and both labels already AGREED
  // with the def, and neither side passed `units` (neither param declares one).
  // So NO PIXEL MOVES on this card — which is precisely why it had gone unbound:
  // a second copy with no visible symptom is still a second copy, and it is the
  // second copy that drifts. Enrolled in RANGE_BOUND_CARDS and
  // MAPPING_BOUND_CARDS in the same edit.
  import type { NodeProps } from '@xyflow/svelte';
  import NeonFader from '$lib/ui/controls/NeonFader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { analogLogicMathsDef } from '$lib/audio/modules/analog-logic-maths';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, paramSpec, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { paramVal, set, live } = cardParams(analogLogicMathsDef, () => id, () => node);

  /** THE ONE COPY of every number, curve, unit and label this card paints. */
  const P = {
    attA: paramSpec(analogLogicMathsDef, 'attA'),
    attB: paramSpec(analogLogicMathsDef, 'attB'),
  };

  let attA = $derived(paramVal('attA'));
  let attB = $derived(paramVal('attB'));

  const inputs = portsFromDef(analogLogicMathsDef.inputs);
  const outputs = portsFromDef(analogLogicMathsDef.outputs, { product: 'PROD' });
</script>

<div class="mod-card alm-card">
  <div class="stripe" style="background: var(--cable-cv);"></div>
  <ModuleTitle {id} {data} defaultLabel="ANALOGLOGICMATHS" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="fader-row">
      <NeonFader value={attA} min={P.attA.min} max={P.attA.max} defaultValue={P.attA.defaultValue} label={P.attA.label} units={P.attA.units} curve={P.attA.curve} onchange={set('attA')} moduleId={id} paramId="attA" readLive={live('attA')} />
      <NeonFader value={attB} min={P.attB.min} max={P.attB.max} defaultValue={P.attB.defaultValue} label={P.attB.label} units={P.attB.units} curve={P.attB.curve} onchange={set('attB')} moduleId={id} paramId="attB" readLive={live('attB')} />
    </div>
  </PatchPanel>
</div>

<style>
  .alm-card { width: 220px; }
  .alm-card .fader-row { padding: 0 14px; margin-top: 16px; }
</style>
