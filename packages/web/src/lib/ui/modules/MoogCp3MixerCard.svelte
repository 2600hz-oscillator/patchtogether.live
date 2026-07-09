<script lang="ts">
  // MOOG CP3 MIXER card — the Console Panel mixer of the Moog System 55/35
  // clone family. Laid out to echo the CP3 console: a row of four input
  // level knobs (25K-LIN, shown 0–10), the 4th-input ATTENUATOR, and the
  // patch panel with the four channel inputs + the 4th external jack, the
  // (+) and (−) outputs, the 1→3 MULTIPLE jacks, and the ±reference trunk
  // jacks.
  //
  // Uses the SHARED beige <MoogPanel> wrapper (re-bound control palette) so
  // the stock Knob / PatchPanel controls inherit the Moog-era look — same
  // way the 921 VCO card does.
  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { setNodeParam } from '$lib/graph/mutate';
  import { moogCp3Def } from '$lib/audio/modules/moog-cp3';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import MoogPanel from './moog/MoogPanel.svelte';
  import { portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  const engineCtx = useEngine();

  function def(pid: string) {
    return moogCp3Def.params.find((p) => p.id === pid)!;
  }

  let ch1         = $derived(node?.params.ch1         ?? def('ch1').defaultValue);
  let ch2         = $derived(node?.params.ch2         ?? def('ch2').defaultValue);
  let ch3         = $derived(node?.params.ch3         ?? def('ch3').defaultValue);
  let ch4         = $derived(node?.params.ch4         ?? def('ch4').defaultValue);
  let attenuator4 = $derived(node?.params.attenuator4 ?? def('attenuator4').defaultValue);

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

  const inputs = portsFromDef(moogCp3Def.inputs, {
    in1: 'IN 1', in2: 'IN 2', in3: 'IN 3', in4: 'IN 4', ext4: 'EXT 4',
  });
  const outputs = portsFromDef(moogCp3Def.outputs, {
    out_positive: '(+) OUT', out_negative: '(−) OUT', multiple_one: 'MULT 1',
    multiple_two: 'MULT 2', multiple_three: 'MULT 3', plus_twelve: '+12V', minus_six: '−6V',
  });
</script>

<MoogPanel {id} {data} defaultLabel="CP3 Mixer" width={264}>
  <PatchPanel nodeId={id} {inputs} {outputs}>
    <!-- Four input level knobs (25K-LIN, shown 0–10). -->
    <div class="knob-row" data-testid="moog-cp3-levels">
      <Knob value={ch1} min={0} max={1} defaultValue={1} label="Ch1" curve="linear" onchange={setParam('ch1')} moduleId={id} paramId="ch1" readLive={readLive('ch1')} />
      <Knob value={ch2} min={0} max={1} defaultValue={1} label="Ch2" curve="linear" onchange={setParam('ch2')} moduleId={id} paramId="ch2" readLive={readLive('ch2')} />
      <Knob value={ch3} min={0} max={1} defaultValue={1} label="Ch3" curve="linear" onchange={setParam('ch3')} moduleId={id} paramId="ch3" readLive={readLive('ch3')} />
      <Knob value={ch4} min={0} max={1} defaultValue={1} label="Ch4" curve="linear" onchange={setParam('ch4')} moduleId={id} paramId="ch4" readLive={readLive('ch4')} />
    </div>

    <!-- 4th-input ATTENUATOR (at "10" = unity / direct patch). -->
    <div class="knob-row" data-testid="moog-cp3-atten4">
      <Knob value={attenuator4} min={0} max={1} defaultValue={1} label="Att 4" curve="linear" onchange={setParam('attenuator4')} moduleId={id} paramId="attenuator4" readLive={readLive('attenuator4')} />
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
