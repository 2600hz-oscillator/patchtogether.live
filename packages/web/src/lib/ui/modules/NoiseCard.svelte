<script lang="ts">
  import type { NodeProps } from '@xyflow/svelte';
  import NeonFader from '$lib/ui/controls/NeonFader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { noiseDef } from '$lib/audio/modules/noise';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, paramSpec, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { set, live } = cardParams(noiseDef, () => id, () => node);

  // ── THE RANGE COMES FROM THE DEF, NEVER RE-TYPED ────────────────────────
  // The backdraft class (CLAUDE.md): every gate this repo owns reads the DEF,
  // so a card restating its def's numbers can disagree with it and NOTHING can
  // see that. This card was the latent form — the fader hand-typed its bounds,
  // its default and its curve, four values that noise.ts already declares, on
  // the same screen as a line that CORRECTLY read the def's own default. They
  // agreed; agreeing today is not the property that matters. Enrolled in
  // RANGE_BOUND_CARDS + MAPPING_BOUND_CARDS (card-range-source.test.ts), which
  // is an opt-in list — an unlisted card is one the guard is blind to, so the
  // enrolment is half the fix.
  //
  // ⚠ `units` IS BOUND TOO, AND IT IS THE HALF THAT IS NOT TIDINESS. `level`
  // declares no units, so the fader was hand-typing "no units" BY OMISSION —
  // and an omitted prop and a bound `undefined` render identically today while
  // diverging the day the def gains one. Neither grep in card-range-source can
  // see an omission; both only ever match what a card actually writes.
  //
  // ⚠ AND KEEP THE LITERAL FORMS OUT OF THIS COMMENT. Those greps read the raw
  // file, not its code, so quoting the bound-away props here re-fails the gate
  // on its own explanation — the same prose-vs-code trap module-face-lint's
  // band-header grep solved with a `codeOnly()` strip and this one has not.
  const pLevel = paramSpec(noiseDef, 'level');

  let level = $derived(node?.params.level ?? pLevel.defaultValue);


  // No inputs (NOISE is a pure source), three audio outputs.
  const inputs = portsFromDef(noiseDef.inputs);
  const outputs = portsFromDef(noiseDef.outputs);
</script>

<div class="mod-card noise-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="NOISE" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="fader-row">
      <NeonFader value={level} min={pLevel.min} max={pLevel.max} defaultValue={pLevel.defaultValue} label="Level" curve={pLevel.curve} units={pLevel.units} onchange={set('level')} moduleId={id} paramId="level" readLive={live('level')} />
    </div>
  </PatchPanel>
</div>

<style>
  .noise-card { width: 160px; }
  .noise-card .fader-row { padding: 0 30px; margin-top: 16px; justify-content: center; }
</style>
