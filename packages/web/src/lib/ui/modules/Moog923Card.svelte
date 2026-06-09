<script lang="ts">
  // MOOG 923 FILTERS / NOISE SOURCE card — the dual-purpose noise + fixed
  // filter utility of the Moog System 35 clone family. A LEVEL knob scales
  // the white + pink noise outputs; LO PASS / HI PASS knobs set the corner
  // of the low-pass / high-pass filters that process the external AUDIO
  // input. Two noise outputs (WHITE / PINK) plus the two filtered outputs
  // (LP / HP).
  //
  // Uses the SHARED beige <MoogPanel> wrapper (re-bound control palette) so
  // the stock Knob / PatchPanel controls inherit the Moog-era look — same
  // pattern as Moog992Card / MoogCp3MixerCard.
  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { setNodeParam } from '$lib/graph/mutate';
  import { moog923Def } from '$lib/audio/modules/moog923';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import MoogPanel from './moog/MoogPanel.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  const engineCtx = useEngine();

  function def(pid: string) {
    return moog923Def.params.find((p) => p.id === pid)!;
  }

  let level    = $derived(node?.params.level    ?? def('level').defaultValue);
  let lpCutoff = $derived(node?.params.lpCutoff ?? def('lpCutoff').defaultValue);
  let hpCutoff = $derived(node?.params.hpCutoff ?? def('hpCutoff').defaultValue);

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

  // One audio input (the signal fed into the LP + HP filter section).
  const inputs: PortDescriptor[] = [
    { id: 'audio', label: 'AUDIO IN', cable: 'audio' },
  ];
  // Two noise outputs + the two filtered outputs.
  const outputs: PortDescriptor[] = [
    { id: 'white', label: 'WHITE', cable: 'audio' },
    { id: 'pink',  label: 'PINK',  cable: 'audio' },
    { id: 'lp',    label: 'LP',    cable: 'audio' },
    { id: 'hp',    label: 'HP',    cable: 'audio' },
  ];
</script>

<MoogPanel {id} {data} defaultLabel="923 Filt/Noise" width={220}>
  <PatchPanel nodeId={id} {inputs} {outputs}>
    <!-- LEVEL (noise gain) + LO PASS / HI PASS filter corners. -->
    <div class="knob-row" data-testid="moog923-knobs">
      <Knob value={level}    min={0} max={1} defaultValue={0.8} label="LEVEL"   curve="linear" onchange={setParam('level')}    moduleId={id} paramId="level"    readLive={readLive('level')} />
      <Knob value={lpCutoff} min={0} max={1} defaultValue={0.5} label="LO PASS" curve="linear" onchange={setParam('lpCutoff')} moduleId={id} paramId="lpCutoff" readLive={readLive('lpCutoff')} />
      <Knob value={hpCutoff} min={0} max={1} defaultValue={0.5} label="HI PASS" curve="linear" onchange={setParam('hpCutoff')} moduleId={id} paramId="hpCutoff" readLive={readLive('hpCutoff')} />
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
