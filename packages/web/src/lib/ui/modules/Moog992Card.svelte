<script lang="ts">
  // MOOG 992 CONTROL VOLTAGE PANEL card — the CV summing/attenuating panel of
  // the Moog System 55/35 clone family. Four CV inputs, each with its own
  // attenuator knob, summed to a single CV output (SUM). The 4th channel is
  // signal-inverting (its attenuator subtracts from the sum).
  //
  // Uses the SHARED beige <MoogPanel> wrapper (re-bound control palette) so the
  // stock Knob / PatchPanel controls inherit the Moog-era look — same pattern
  // as MoogCp3MixerCard / Moog921aCard.
  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { setNodeParam } from '$lib/graph/mutate';
  import { moog992Def } from '$lib/audio/modules/moog992';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import MoogPanel from './moog/MoogPanel.svelte';
  import { portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  const engineCtx = useEngine();

  function def(pid: string) {
    return moog992Def.params.find((p) => p.id === pid)!;
  }

  let atten1 = $derived(node?.params.atten1 ?? def('atten1').defaultValue);
  let atten2 = $derived(node?.params.atten2 ?? def('atten2').defaultValue);
  let atten3 = $derived(node?.params.atten3 ?? def('atten3').defaultValue);
  let atten4 = $derived(node?.params.atten4 ?? def('atten4').defaultValue);

  function setParam(paramId: string) {
    return (v: number) => setNodeParam(id, paramId, v);
  }
  function readLive(paramId: string) {
    return () => {
      const eng = engineCtx.get();
      if (!eng || !node) return undefined;
      return eng.readParam(node, paramId);
    };
  }

  // Four CV inputs (left); single summed CV output (SUM). No audio ports.
  const inputs = portsFromDef(moog992Def.inputs, {
    cv1: 'CV 1', cv2: 'CV 2', cv3: 'CV 3', cv4: 'CV 4',
  });
  const outputs = portsFromDef(moog992Def.outputs, { cv_out: 'SUM' });
</script>

<MoogPanel {id} {data} defaultLabel="992 CV" width={220}>
  <PatchPanel nodeId={id} {inputs} {outputs}>
    <!-- Four per-channel attenuators (Ch 4 is signal-inverting). -->
    <div class="knob-row" data-testid="moog992-attens">
      <Knob value={atten1} min={0} max={1} defaultValue={1} label="Att 1" curve="linear" onchange={setParam('atten1')} moduleId={id} paramId="atten1" readLive={readLive('atten1')} />
      <Knob value={atten2} min={0} max={1} defaultValue={1} label="Att 2" curve="linear" onchange={setParam('atten2')} moduleId={id} paramId="atten2" readLive={readLive('atten2')} />
      <Knob value={atten3} min={0} max={1} defaultValue={1} label="Att 3" curve="linear" onchange={setParam('atten3')} moduleId={id} paramId="atten3" readLive={readLive('atten3')} />
      <Knob value={atten4} min={0} max={1} defaultValue={1} label="Att 4" curve="linear" onchange={setParam('atten4')} moduleId={id} paramId="atten4" readLive={readLive('atten4')} />
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
