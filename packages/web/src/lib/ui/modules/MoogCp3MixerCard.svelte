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
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { moogCp3Def } from '$lib/audio/modules/moog-cp3';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import MoogPanel from './moog/MoogPanel.svelte';

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
    { id: 'in1',  label: 'IN 1', cable: 'audio' },
    { id: 'in2',  label: 'IN 2', cable: 'audio' },
    { id: 'in3',  label: 'IN 3', cable: 'audio' },
    { id: 'in4',  label: 'IN 4', cable: 'audio' },
    { id: 'ext4', label: 'EXT 4', cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'out_positive',   label: '(+) OUT', cable: 'audio' },
    { id: 'out_negative',   label: '(−) OUT', cable: 'audio' },
    { id: 'multiple_one',   label: 'MULT 1',  cable: 'audio' },
    { id: 'multiple_two',   label: 'MULT 2',  cable: 'audio' },
    { id: 'multiple_three', label: 'MULT 3',  cable: 'audio' },
    { id: 'plus_twelve',    label: '+12V',    cable: 'cv' },
    { id: 'minus_six',      label: '−6V',     cable: 'cv' },
  ];
</script>

<MoogPanel {id} {data} defaultLabel="Moog CP3 Mixer" width={264}>
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
