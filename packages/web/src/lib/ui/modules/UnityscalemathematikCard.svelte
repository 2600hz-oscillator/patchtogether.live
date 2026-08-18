<script lang="ts">
  // #1714. ⚠ EVERY RANGE, CURVE, UNIT **AND LABEL** IS BOUND TO THE DEF
  // (`paramSpec`), NEVER RE-TYPED. This card is the reason the rule names the
  // LABEL as well as the numbers: its five `min`/`max`/`defaultValue` literals
  // all AGREED with the def, and all five `label`s DISAGREED —
  //
  //     unityAtten  def 'Unity'  card 'Att'
  //     aAtten      def 'A Att'  card 'Att'
  //     aCurve      def 'A Crv'  card 'Curve'
  //     bAtten      def 'B Att'  card 'Att'
  //     bCurve      def 'B Crv'  card 'Curve'
  //
  // — because the card disambiguates the three `Att` cells with static section
  // captions the def cannot see. `card-def-agreement.ts` compares the numeric
  // props, so nothing was watching. It becomes user-visible the moment this
  // module enters STRICT_FACES: the dock full-view renders straight off the
  // `ParamDef`, so a face PR that did not bind labels would have shipped a
  // rename of five controls that nobody reviewed.
  //
  // The section captions stay — they are card chrome and the faceplate
  // reproduces them as band labels — but they now sit ABOVE the def's own
  // qualified names rather than standing in for them.
  //
  // ⚠ The defaults were also read by POSITION (`params[0]!.defaultValue`), which
  // no gate forbids and which re-pointing the `params` array would silently
  // scramble. `paramVal` resolves by id.
  import type { NodeProps } from '@xyflow/svelte';
  import NeonFader from '$lib/ui/controls/NeonFader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { unityscalemathematikDef } from '$lib/audio/modules/unityscalemathematik';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, paramSpec, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { paramVal, set, live } = cardParams(unityscalemathematikDef, () => id, () => node);

  /** THE ONE COPY of every number, curve, unit and label this card paints. */
  const P = {
    unityAtten: paramSpec(unityscalemathematikDef, 'unityAtten'),
    aAtten:     paramSpec(unityscalemathematikDef, 'aAtten'),
    aCurve:     paramSpec(unityscalemathematikDef, 'aCurve'),
    bAtten:     paramSpec(unityscalemathematikDef, 'bAtten'),
    bCurve:     paramSpec(unityscalemathematikDef, 'bCurve'),
  };

  const inputs = portsFromDef(unityscalemathematikDef.inputs);
  const outputs = portsFromDef(unityscalemathematikDef.outputs, {
    u_out: 'U', a_out: 'A', b_out: 'B',
  });
</script>

<div class="mod-card unity-card">
  <div class="stripe" style="background: var(--cable-cv);"></div>
  <ModuleTitle {id} {data} defaultLabel="UNITYSCALEMATHEMATIK" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="section">
      <div class="section-label">UNITY</div>
      <div class="fader-row">
        <NeonFader value={paramVal('unityAtten')} min={P.unityAtten.min} max={P.unityAtten.max} defaultValue={P.unityAtten.defaultValue} label={P.unityAtten.label} units={P.unityAtten.units} curve={P.unityAtten.curve} onchange={set('unityAtten')} moduleId={id} paramId="unityAtten" readLive={live('unityAtten')} />
      </div>
    </div>
    <div class="section">
      <div class="section-label">A</div>
      <div class="fader-row">
        <NeonFader value={paramVal('aAtten')} min={P.aAtten.min} max={P.aAtten.max} defaultValue={P.aAtten.defaultValue} label={P.aAtten.label} units={P.aAtten.units} curve={P.aAtten.curve} onchange={set('aAtten')} moduleId={id} paramId="aAtten" readLive={live('aAtten')} />
        <NeonFader value={paramVal('aCurve')} min={P.aCurve.min} max={P.aCurve.max} defaultValue={P.aCurve.defaultValue} label={P.aCurve.label} units={P.aCurve.units} curve={P.aCurve.curve} onchange={set('aCurve')} moduleId={id} paramId="aCurve" readLive={live('aCurve')} />
      </div>
    </div>
    <div class="section">
      <div class="section-label">B</div>
      <div class="fader-row">
        <NeonFader value={paramVal('bAtten')} min={P.bAtten.min} max={P.bAtten.max} defaultValue={P.bAtten.defaultValue} label={P.bAtten.label} units={P.bAtten.units} curve={P.bAtten.curve} onchange={set('bAtten')} moduleId={id} paramId="bAtten" readLive={live('bAtten')} />
        <NeonFader value={paramVal('bCurve')} min={P.bCurve.min} max={P.bCurve.max} defaultValue={P.bCurve.defaultValue} label={P.bCurve.label} units={P.bCurve.units} curve={P.bCurve.curve} onchange={set('bCurve')} moduleId={id} paramId="bCurve" readLive={live('bCurve')} />
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .unity-card { width: 240px; }
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
