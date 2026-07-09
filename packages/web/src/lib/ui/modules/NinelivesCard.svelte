<script lang="ts">
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { ninelivesDef } from '$lib/audio/modules/ninelives';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { set, live } = cardParams(ninelivesDef, () => id, () => node);

  let rate  = $derived(node?.params.rate  ?? ninelivesDef.params[0]!.defaultValue);
  let shape = $derived(node?.params.shape ?? ninelivesDef.params[1]!.defaultValue);


  const SHAPE_GLYPHS: Array<{ frac: number; kind: 'sine' | 'tri' | 'saw' | 'square' }> = [
    { frac: 0,   kind: 'sine'   },
    { frac: 0.5, kind: 'saw'    },
    { frac: 1,   kind: 'square' },
  ];

  const inputs = portsFromDef(ninelivesDef.inputs);
  // Nine CV taps on the geometric ⅓ ladder (out1 fastest … out9 = rate/6561).
  const outputs: PortDescriptor[] = Array.from({ length: 9 }, (_, i) => ({
    id: `out${i + 1}`,
    label: `OUT ${i + 1}`,
    cable: 'cv' as const,
  }));
</script>

<div class="mod-card ninelives-card">
  <div class="stripe" style="background: var(--cable-cv);"></div>
  <ModuleTitle {id} {data} defaultLabel="NINE LIVES" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <!-- Rate (out1 frequency) + the shared Waveform morph, one row. -->
    <div class="control-row">
      <Fader value={rate}  min={0.01} max={100} defaultValue={1} label="Rate" units="Hz" curve="log"    onchange={set('rate')}  readLive={live('rate')}  moduleId={id} paramId="rate" />
      <Fader value={shape} min={0}    max={2}   defaultValue={0} label="Waveform"        curve="linear" onchange={set('shape')} readLive={live('shape')} glyphs={SHAPE_GLYPHS} moduleId={id} paramId="shape" />
    </div>
  </PatchPanel>
</div>

<style>
  .ninelives-card .control-row {
    display: flex;
    align-items: flex-end;
    justify-content: center;
    gap: 18px;
    padding: 0 16px;
    margin-top: 12px;
  }
</style>
