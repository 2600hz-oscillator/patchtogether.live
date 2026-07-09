<script lang="ts">
  // MOOG 993 TRIGGER & ENVELOPE VOLTAGES PANEL card — a patch-bay convenience
  // panel of the Moog System 55 clone family. Three ROUTE knobs select each
  // trigger out's source (0 = OFF / 1 = FROM 1 / 2 = FROM 2); the patch panel
  // carries the two trigger SOURCE jacks + two envelope-CV inputs on the left
  // and the three routed trigger outs + two envelope passthroughs on the right.
  //
  // Uses the SHARED beige <MoogPanel> wrapper (re-bound control palette) so the
  // stock Knob / PatchPanel controls inherit the Moog-era look — same pattern
  // as MoogCp3MixerCard / Moog921aCard.
  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { setNodeParam } from '$lib/graph/mutate';
  import { moog993Def } from '$lib/audio/modules/moog993';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import MoogPanel from './moog/MoogPanel.svelte';
  import { portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  const engineCtx = useEngine();

  function def(pid: string) {
    return moog993Def.params.find((p) => p.id === pid)!;
  }

  let route1 = $derived(node?.params.route1 ?? def('route1').defaultValue);
  let route2 = $derived(node?.params.route2 ?? def('route2').defaultValue);
  let route3 = $derived(node?.params.route3 ?? def('route3').defaultValue);

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

  const inputs = portsFromDef(moog993Def.inputs, {
    trig_from1: 'TRIG 1', trig_from2: 'TRIG 2', env_in1: 'ENV 1', env_in2: 'ENV 2',
  });
  const outputs = portsFromDef(moog993Def.outputs, {
    trig_out1: 'OUT 1', trig_out2: 'OUT 2', trig_out3: 'OUT 3', env_out1: 'ENV 1',
    env_out2: 'ENV 2',
  });
</script>

<MoogPanel {id} {data} defaultLabel="993 Trig" width={220}>
  <PatchPanel nodeId={id} {inputs} {outputs}>
    <!-- Three ROUTE selectors: 0 = OFF / 1 = FROM 1 / 2 = FROM 2. -->
    <div class="knob-row" data-testid="moog993-routes">
      <Knob value={route1} min={0} max={2} defaultValue={1} label="Route 1" curve="linear" onchange={setParam('route1')} moduleId={id} paramId="route1" readLive={readLive('route1')} />
      <Knob value={route2} min={0} max={2} defaultValue={1} label="Route 2" curve="linear" onchange={setParam('route2')} moduleId={id} paramId="route2" readLive={readLive('route2')} />
      <Knob value={route3} min={0} max={2} defaultValue={1} label="Route 3" curve="linear" onchange={setParam('route3')} moduleId={id} paramId="route3" readLive={readLive('route3')} />
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
