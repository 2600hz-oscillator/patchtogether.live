<script lang="ts">
  // MOOG 903A RANDOM SIGNAL GENERATOR card — the noise SOURCE of the Moog
  // System 55/35 clone family. Two independent noise taps (WHITE + PINK), both
  // gain-scaled by a single LEVEL knob. No inputs.
  //
  // Uses the SHARED beige <MoogPanel> wrapper (re-bound control palette) so the
  // stock Knob / PatchPanel controls inherit the Moog-era look — same pattern
  // as MoogCp3MixerCard / Moog992Card.
  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { moog903aDef } from '$lib/audio/modules/moog903a';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import MoogPanel from './moog/MoogPanel.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  const engineCtx = useEngine();

  function def(pid: string) {
    return moog903aDef.params.find((p) => p.id === pid)!;
  }

  let level = $derived(node?.params.level ?? def('level').defaultValue);

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

  // No inputs (pure source). Two independent noise outputs.
  const inputs: PortDescriptor[] = [];
  const outputs: PortDescriptor[] = [
    { id: 'white', label: 'WHITE', cable: 'audio' },
    { id: 'pink',  label: 'PINK',  cable: 'audio' },
  ];
</script>

<MoogPanel {id} {data} defaultLabel="903A Noise" width={180}>
  <PatchPanel nodeId={id} {inputs} {outputs}>
    <!-- Single LEVEL knob driving both taps. -->
    <div class="knob-row" data-testid="moog903a-level">
      <Knob value={level} min={0} max={1} defaultValue={0.8} label="Level" curve="linear" onchange={setParam('level')} moduleId={id} paramId="level" readLive={readLive('level')} />
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
