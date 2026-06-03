<script lang="ts">
  // MOOG 995 ATTENUATORS card — three INDEPENDENT passive variable
  // attenuators of the Moog System 55/35 clone family. Laid out as a single
  // row of three level knobs (ATT 1–3) above the patch panel with the three
  // channel inputs (IN 1–3) and the three post-attenuator outputs (OUT 1–3).
  //
  // Uses the SHARED beige <MoogPanel> wrapper (re-bound control palette) so
  // the stock Knob / PatchPanel controls inherit the Moog-era look — same way
  // the CP3 mixer / 921A driver cards do.
  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { moog995Def } from '$lib/audio/modules/moog995';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import MoogPanel from './moog/MoogPanel.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  const engineCtx = useEngine();

  function def(pid: string) {
    return moog995Def.params.find((p) => p.id === pid)!;
  }

  let atten1 = $derived(node?.params.atten1 ?? def('atten1').defaultValue);
  let atten2 = $derived(node?.params.atten2 ?? def('atten2').defaultValue);
  let atten3 = $derived(node?.params.atten3 ?? def('atten3').defaultValue);

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

  const inputs: PortDescriptor[] = [
    { id: 'in1', label: 'IN 1', cable: 'audio' },
    { id: 'in2', label: 'IN 2', cable: 'audio' },
    { id: 'in3', label: 'IN 3', cable: 'audio' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'out1', label: 'OUT 1', cable: 'audio' },
    { id: 'out2', label: 'OUT 2', cable: 'audio' },
    { id: 'out3', label: 'OUT 3', cable: 'audio' },
  ];
</script>

<MoogPanel {id} {data} defaultLabel="Moog 995 Atten" width={200}>
  <PatchPanel nodeId={id} {inputs} {outputs}>
    <!-- Three independent attenuator level knobs (0..unity, 1.0 = direct patch). -->
    <div class="knob-row" data-testid="moog995-attenuators">
      <Knob value={atten1} min={0} max={1} defaultValue={1} label="Att 1" curve="linear" onchange={setParam('atten1')} moduleId={id} paramId="atten1" readLive={readLive('atten1')} />
      <Knob value={atten2} min={0} max={1} defaultValue={1} label="Att 2" curve="linear" onchange={setParam('atten2')} moduleId={id} paramId="atten2" readLive={readLive('atten2')} />
      <Knob value={atten3} min={0} max={1} defaultValue={1} label="Att 3" curve="linear" onchange={setParam('atten3')} moduleId={id} paramId="atten3" readLive={readLive('atten3')} />
    </div>
  </PatchPanel>
</MoogPanel>

<style>
  .knob-row {
    display: flex;
    gap: 12px;
    padding: 8px 18px 4px;
    justify-content: center;
  }
</style>
