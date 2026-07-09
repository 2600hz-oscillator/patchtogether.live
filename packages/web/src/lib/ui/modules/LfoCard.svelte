<script lang="ts">
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { lfoDef } from '$lib/audio/modules/lfo';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { set, live } = cardParams(lfoDef, () => id, () => node);

  let rate  = $derived(node?.params.rate  ?? lfoDef.params[0]!.defaultValue);
  let shape = $derived(node?.params.shape ?? lfoDef.params[1]!.defaultValue);
  let depth = $derived(node?.params.depth ?? lfoDef.params[2]!.defaultValue);


  const SHAPE_GLYPHS: Array<{ frac: number; kind: 'sine' | 'tri' | 'saw' | 'square' }> = [
    { frac: 0,   kind: 'sine'   },
    { frac: 0.5, kind: 'saw'    },
    { frac: 1,   kind: 'square' },
  ];

  const inputs = portsFromDef(lfoDef.inputs, { depth_cv: 'DEPTH' });
  const outputs = portsFromDef(lfoDef.outputs, {
    phase0: 'PHASE 0°', phase90: 'PHASE 90°', phase180: 'PHASE 180°', phase270: 'PHASE 270°',
  });
</script>

<div class="mod-card lfo-card">
  <div class="stripe" style="background: var(--cable-cv);"></div>
  <ModuleTitle {id} {data} defaultLabel="LFO" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <!-- 1u: Rate + Shape faders with the Depth KNOB to their right, one row. -->
    <div class="control-row">
      <Fader value={rate}  min={0.01} max={100} defaultValue={1} label="Rate"  units="Hz" curve="log"    onchange={set('rate')}  readLive={live('rate')}  moduleId={id} paramId="rate" />
      <Fader value={shape} min={0}    max={2}   defaultValue={0} label="Shape"            curve="linear" onchange={set('shape')} readLive={live('shape')} glyphs={SHAPE_GLYPHS} moduleId={id} paramId="shape" />
      <Knob value={depth} min={0} max={1} defaultValue={0.5} label="Depth" curve="linear" onchange={set('depth')} readLive={live('depth')} moduleId={id} paramId="depth" />
    </div>
  </PatchPanel>
</div>

<style>
  .lfo-card .control-row {
    display: flex;
    align-items: flex-end;
    justify-content: center;
    gap: 18px;
    padding: 0 16px;
    margin-top: 12px;
  }
</style>
