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
  import { paramSpec, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  const engineCtx = useEngine();

  // Every knob carries its own ParamDef rather than re-typed literals. All five
  // hand-typed `min={0} max={1} defaultValue={1}` and AGREED, so this is the
  // AnalogLogicMathsCard shape — a maintainability conversion, done WITH the
  // promotion because from here the dock renders these controls off the
  // `ParamDef` while this card renders off its own literals, and a later edit to
  // one side would ship two surfaces calling one control two things.
  const P = {
    ch1: paramSpec(moogCp3Def, 'ch1'),
    ch2: paramSpec(moogCp3Def, 'ch2'),
    ch3: paramSpec(moogCp3Def, 'ch3'),
    ch4: paramSpec(moogCp3Def, 'ch4'),
    attenuator4: paramSpec(moogCp3Def, 'attenuator4'),
  } as const;

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
      <Knob value={ch1} min={P.ch1.min} max={P.ch1.max} defaultValue={P.ch1.defaultValue} label={P.ch1.label ?? P.ch1.id} units={P.ch1.units ?? ''} curve={P.ch1.curve} onchange={setParam(P.ch1.id)} moduleId={id} paramId={P.ch1.id} readLive={readLive(P.ch1.id)} />
      <Knob value={ch2} min={P.ch2.min} max={P.ch2.max} defaultValue={P.ch2.defaultValue} label={P.ch2.label ?? P.ch2.id} units={P.ch2.units ?? ''} curve={P.ch2.curve} onchange={setParam(P.ch2.id)} moduleId={id} paramId={P.ch2.id} readLive={readLive(P.ch2.id)} />
      <Knob value={ch3} min={P.ch3.min} max={P.ch3.max} defaultValue={P.ch3.defaultValue} label={P.ch3.label ?? P.ch3.id} units={P.ch3.units ?? ''} curve={P.ch3.curve} onchange={setParam(P.ch3.id)} moduleId={id} paramId={P.ch3.id} readLive={readLive(P.ch3.id)} />
      <Knob value={ch4} min={P.ch4.min} max={P.ch4.max} defaultValue={P.ch4.defaultValue} label={P.ch4.label ?? P.ch4.id} units={P.ch4.units ?? ''} curve={P.ch4.curve} onchange={setParam(P.ch4.id)} moduleId={id} paramId={P.ch4.id} readLive={readLive(P.ch4.id)} />
    </div>

    <!-- 4th-input ATTENUATOR (at "10" = unity / direct patch). -->
    <div class="knob-row" data-testid="moog-cp3-atten4">
      <Knob value={attenuator4} min={P.attenuator4.min} max={P.attenuator4.max} defaultValue={P.attenuator4.defaultValue} label={P.attenuator4.label ?? P.attenuator4.id} units={P.attenuator4.units ?? ''} curve={P.attenuator4.curve} onchange={setParam(P.attenuator4.id)} moduleId={id} paramId={P.attenuator4.id} readLive={readLive(P.attenuator4.id)} />
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
