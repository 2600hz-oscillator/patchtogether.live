<script lang="ts">
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { ninelivesDef } from '$lib/audio/modules/ninelives';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, paramSpec, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { set, live } = cardParams(ninelivesDef, () => id, () => node);

  // RANGE- AND MAPPING-BOUND. The two faders used to re-type the def's numbers
  // (`min={0.01} max={100} defaultValue={1}` / `min={0} max={2}`) and they
  // AGREED, so `card-def-agreement` was green — but agreement is a fact about
  // today's literals, not a property of the card. Promoting the module makes
  // that gap live: the DOCK face renders straight off the `ParamDef` while the
  // legacy card renders off whatever it typed, so one param would have two
  // travels depending on which surface you reached it through. That is the
  // `analogVco` / `wavetableVco` backdraft class (#1681), and binding is the
  // form that cannot have it — there is no number left to disagree.
  const pRate = paramSpec(ninelivesDef, 'rate');
  const pShape = paramSpec(ninelivesDef, 'shape');

  let rate  = $derived(node?.params.rate  ?? pRate.defaultValue);
  let shape = $derived(node?.params.shape ?? pShape.defaultValue);


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
      <Fader
        value={rate}
        min={pRate.min} max={pRate.max} defaultValue={pRate.defaultValue}
        label={pRate.label ?? pRate.id} units={pRate.units} curve={pRate.curve}
        onchange={set('rate')} readLive={live('rate')} moduleId={id} paramId={pRate.id} />
      <Fader
        value={shape}
        min={pShape.min} max={pShape.max} defaultValue={pShape.defaultValue}
        label={pShape.label ?? pShape.id} curve={pShape.curve}
        onchange={set('shape')} readLive={live('shape')} glyphs={SHAPE_GLYPHS}
        moduleId={id} paramId={pShape.id} />
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
