<script lang="ts">
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { setNodeParam } from '$lib/graph/mutate';
  import { lfoDef } from '$lib/audio/modules/lfo';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  let rate  = $derived(node?.params.rate  ?? lfoDef.params[0]!.defaultValue);
  let shape = $derived(node?.params.shape ?? lfoDef.params[1]!.defaultValue);
  let depth = $derived(node?.params.depth ?? lfoDef.params[2]!.defaultValue);

  const set = (id_: string) => (v: number) => setNodeParam(id, id_, v);
  const live = (id_: string) => () => { const e = engineCtx.get(); if (!e || !node) return undefined; return e.readParam(node, id_); };

  const SHAPE_GLYPHS: Array<{ frac: number; kind: 'sine' | 'tri' | 'saw' | 'square' }> = [
    { frac: 0,   kind: 'sine'   },
    { frac: 0.5, kind: 'saw'    },
    { frac: 1,   kind: 'square' },
  ];

  const inputs: PortDescriptor[] = [
    { id: 'clock', cable: 'gate' },
    { id: 'rate',  cable: 'cv' },
    { id: 'shape', cable: 'cv' },
    { id: 'depth_cv', label: 'DEPTH', cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'phase0',   label: 'PHASE 0°',   cable: 'cv' },
    { id: 'phase90',  label: 'PHASE 90°',  cable: 'cv' },
    { id: 'phase180', label: 'PHASE 180°', cable: 'cv' },
    { id: 'phase270', label: 'PHASE 270°', cable: 'cv' },
  ];
</script>

<div class="mod-card lfo-card">
  <div class="stripe" style="background: var(--cable-cv);"></div>
  <ModuleTitle {id} {data} defaultLabel="LFO" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="fader-row">
      <Fader value={rate}  min={0.01} max={100} defaultValue={1} label="Rate"  units="Hz" curve="log"    onchange={set('rate')}  readLive={live('rate')}  moduleId={id} paramId="rate" />
      <Fader value={shape} min={0}    max={2}   defaultValue={0} label="Shape"            curve="linear" onchange={set('shape')} readLive={live('shape')} glyphs={SHAPE_GLYPHS} moduleId={id} paramId="shape" />
    </div>
    <div class="knob-row">
      <Knob value={depth} min={0} max={1} defaultValue={0.5} label="Depth" curve="linear" onchange={set('depth')} readLive={live('depth')} moduleId={id} paramId="depth" />
    </div>
  </PatchPanel>
</div>

<style>
  .lfo-card { width: 200px; }
  .lfo-card .fader-row { padding: 0 30px; margin-top: 16px; gap: 12px; }
  .lfo-card .knob-row { display: flex; justify-content: center; margin-top: 16px; }
</style>
