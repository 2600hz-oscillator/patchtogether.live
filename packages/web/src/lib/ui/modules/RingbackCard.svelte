<script lang="ts">
  // RINGBACK — stereo crush effect (the TWOTRACKS record-time artifact, made
  // intentional). Stereo in (L/R) → stereo out (L/R). Four knobs expose the
  // mechanism: RATE (crush amount), SIZE (ring length), FB (feedback regen),
  // MIX (dry/wet). All writes go through setNodeParam(). See
  // packages/web/src/lib/audio/modules/ringback.ts for the signal path.
  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { setNodeParam } from '$lib/graph/mutate';
  import { ringbackDef } from '$lib/audio/modules/ringback';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  const defaultFor = (k: string): number =>
    ringbackDef.params.find((p) => p.id === k)?.defaultValue ?? 0;

  let rate     = $derived(node?.params.rate     ?? defaultFor('rate'));
  let size     = $derived(node?.params.size     ?? defaultFor('size'));
  let feedback = $derived(node?.params.feedback ?? defaultFor('feedback'));
  let mix      = $derived(node?.params.mix      ?? defaultFor('mix'));

  const inputs: PortDescriptor[] = [
    { id: 'in_l', label: 'L IN', cable: 'audio' },
    { id: 'in_r', label: 'R IN', cable: 'audio' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'out_l', label: 'L OUT', cable: 'audio' },
    { id: 'out_r', label: 'R OUT', cable: 'audio' },
  ];
</script>

<div class="mod-card ringback-card" data-testid="ringback-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="RINGBACK" />
  <div class="subtitle">STEREO CRUSH · RING + FEEDBACK</div>

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="knob-row" data-testid="ringback-knobs">
      <Knob value={rate} min={0.05} max={4} defaultValue={0.5} label="RATE" curve="linear"
        onchange={(v) => setNodeParam(id, 'rate', v)} moduleId={id} paramId="rate" />
      <Knob value={size} min={2} max={4096} defaultValue={64} label="SIZE" units="smp" curve="log"
        onchange={(v) => setNodeParam(id, 'size', Math.round(v))} moduleId={id} paramId="size" />
      <Knob value={feedback} min={0} max={0.98} defaultValue={0.3} label="FB" curve="linear"
        onchange={(v) => setNodeParam(id, 'feedback', v)} moduleId={id} paramId="feedback" />
      <Knob value={mix} min={0} max={1} defaultValue={1} label="MIX" curve="linear"
        onchange={(v) => setNodeParam(id, 'mix', v)} moduleId={id} paramId="mix" />
    </div>
  </PatchPanel>
</div>

<style>
  .ringback-card {
    width: 240px;
  }
  .ringback-card .subtitle {
    font-size: 0.50rem;
    color: var(--text-dim, #8b94a5);
    text-align: center;
    letter-spacing: 0.07em;
    margin-top: 2px;
  }
  .ringback-card .knob-row {
    margin-top: 12px;
    padding: 0 12px 6px;
    display: flex;
    align-items: flex-start;
    justify-content: space-around;
    gap: 6px;
  }
  .ringback-card .knob-row :global(.knob) {
    width: 34px;
    height: 34px;
  }
  .ringback-card .knob-row :global(.label) {
    font-size: 0.44rem;
  }
</style>
