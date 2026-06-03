<script lang="ts">
  // MOOG 912 ENVELOPE FOLLOWER card — the analysis utility of the Moog System
  // 55/35 clone family. One AUDIO input is watched for amplitude; a smoothed
  // CV "envelope" + a "gate" (high while sounding) come out. Two knobs:
  // SENSITIVITY (input gain into the follower) and SMOOTHING (how lazy the
  // envelope is — maps to the envelope lowpass cutoff).
  //
  // Uses the SHARED beige <MoogPanel> wrapper (re-bound control palette) so the
  // stock Knob / PatchPanel controls inherit the Moog-era look — same pattern
  // as Moog992Card / MoogCp3MixerCard / Moog921aCard.
  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { moog912Def } from '$lib/audio/modules/moog912';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import MoogPanel from './moog/MoogPanel.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  const engineCtx = useEngine();

  function def(pid: string) {
    return moog912Def.params.find((p) => p.id === pid)!;
  }

  let sensitivity = $derived(node?.params.sensitivity ?? def('sensitivity').defaultValue);
  let smoothing = $derived(node?.params.smoothing ?? def('smoothing').defaultValue);

  function setParam(paramId: string) {
    return (v: number) => {
      const target = patch.nodes[id];
      if (target) target.params[paramId] = v;
    };
  }
  function readLive(paramId: string) {
    return () => {
      const eng = engineCtx.get();
      if (!eng || !node) return undefined;
      return eng.readParam(node, paramId);
    };
  }

  // One AUDIO input (left); env (CV) + gate outputs (right). No audio out.
  const inputs: PortDescriptor[] = [
    { id: 'audio', label: 'In', cable: 'audio' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'env', label: 'Env', cable: 'cv' },
    { id: 'gate', label: 'Gate', cable: 'gate' },
  ];
</script>

<MoogPanel {id} {data} defaultLabel="Moog 912 Env Follow" width={200}>
  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="knob-row" data-testid="moog912-knobs">
      <Knob value={sensitivity} min={0} max={1} defaultValue={0.7} label="Sens" curve="linear" onchange={setParam('sensitivity')} moduleId={id} paramId="sensitivity" readLive={readLive('sensitivity')} />
      <Knob value={smoothing} min={0} max={1} defaultValue={0.5} label="Smooth" curve="linear" onchange={setParam('smoothing')} moduleId={id} paramId="smoothing" readLive={readLive('smoothing')} />
    </div>
  </PatchPanel>
</MoogPanel>

<style>
  .knob-row {
    display: flex;
    gap: 16px;
    padding: 8px 18px 4px;
    justify-content: center;
  }
</style>
