<script lang="ts">
  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { charlottesEchosDef } from '$lib/audio/modules/charlottes-echos';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  let delay    = $derived(node?.params.delay    ?? charlottesEchosDef.params[0]!.defaultValue);
  let feedback = $derived(node?.params.feedback ?? charlottesEchosDef.params[1]!.defaultValue);
  let decay    = $derived(node?.params.decay    ?? charlottesEchosDef.params[2]!.defaultValue);
  let pitchUp  = $derived(node?.params.pitchUp  ?? charlottesEchosDef.params[3]!.defaultValue);
  let mix      = $derived(node?.params.mix      ?? charlottesEchosDef.params[4]!.defaultValue);

  // Stripe shimmer activates when feedback is high enough that artifacts
  // become audibly compounding.
  let shimmer = $derived(feedback > 0.6);

  const set = (k: string) => (v: number) => { const t = patch.nodes[id]; if (t) t.params[k] = v; };
  const live = (k: string) => () => {
    const e = engineCtx.get(); if (!e || !node) return undefined;
    return e.readParam(node, k);
  };

  const inputs: PortDescriptor[] = [
    { id: 'L',     cable: 'audio' },
    { id: 'R',     cable: 'audio' },
    { id: 'delay', cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'L', cable: 'audio' },
    { id: 'R', cable: 'audio' },
  ];
</script>

<div class="mod-card charlottes-echos-card">
  <div class="stripe" class:shimmer style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="CHARLOTTE&#39;S ECHOS" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="knob-row">
      <Knob value={delay}    min={0.001} max={1.5} defaultValue={0.4} label="Delay"    units="s" curve="log"    onchange={set('delay')} moduleId={id} paramId="delay"    readLive={live('delay')} />
      <Knob value={feedback} min={0}     max={1}   defaultValue={0.5} label="Feedback"           curve="linear" onchange={set('feedback')} moduleId={id} paramId="feedback" readLive={live('feedback')} />
      <Knob value={decay}    min={0}     max={1}   defaultValue={0.2} label="Decay"              curve="linear" onchange={set('decay')} moduleId={id} paramId="decay"    readLive={live('decay')} />
      <Knob value={pitchUp}  min={0}     max={0.2} defaultValue={0}   label="Pitch"              curve="linear" onchange={set('pitchUp')} moduleId={id} paramId="pitchUp"  readLive={live('pitchUp')} />
      <Knob value={mix}      min={0}     max={1}   defaultValue={0.5} label="Mix"                curve="linear" onchange={set('mix')} moduleId={id} paramId="mix"      readLive={live('mix')} />
    </div>
  </PatchPanel>
</div>

<style>
  .charlottes-echos-card {
    width: 320px;
    min-height: 220px;
  }
  .charlottes-echos-card .title {
    font-family: var(--font-display, inherit);
    font-size: 0.85rem;
    letter-spacing: 0.04em;
  }
  .charlottes-echos-card .stripe.shimmer {
    background: linear-gradient(
      90deg,
      var(--cable-audio) 0%,
      rgba(255, 255, 255, 0.6) 50%,
      var(--cable-audio) 100%
    );
    background-size: 200% 100%;
    animation: ce-shimmer 1.6s linear infinite;
  }
  :global(body.reduced-effects) .charlottes-echos-card .stripe.shimmer {
    animation: none;
    background: var(--cable-audio);
  }
  @media (prefers-reduced-motion: reduce) {
    .charlottes-echos-card .stripe.shimmer {
      animation: none;
      background: var(--cable-audio);
    }
  }
  @keyframes ce-shimmer {
    0%   { background-position: 0% 0; }
    100% { background-position: 200% 0; }
  }
  .charlottes-echos-card .knob-row {
    margin-top: 14px;
    display: flex;
    justify-content: center;
    gap: 12px;
    padding: 0 18px;
    flex-wrap: wrap;
  }
</style>
