<script lang="ts">
  // MOOG 962 SEQUENTIAL SWITCH card — the gate-advanced signal selector of the
  // Moog System 55 clone family. Up to three signal inputs (IN 1–3) feed a
  // single OUT; a rising edge on the SHIFT gate steps the selector to the next
  // input. A single STAGES knob sets how many inputs cycle (2 or 3).
  //
  // Uses the SHARED beige <MoogPanel> wrapper (re-bound control palette) so the
  // stock Knob / PatchPanel controls inherit the Moog-era look — same pattern
  // as Moog992Card / Moog995Card / MoogCp3MixerCard.
  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { setNodeParam } from '$lib/graph/mutate';
  import { moog962Def } from '$lib/audio/modules/moog962';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import MoogPanel from './moog/MoogPanel.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  const engineCtx = useEngine();

  function def(pid: string) {
    return moog962Def.params.find((p) => p.id === pid)!;
  }

  let stages = $derived(node?.params.stages ?? def('stages').defaultValue);

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

  // Three signal inputs + the SHIFT advance gate (left); single OUT (right).
  const inputs: PortDescriptor[] = [
    { id: 'in1',   label: 'IN 1',  cable: 'cv' },
    { id: 'in2',   label: 'IN 2',  cable: 'cv' },
    { id: 'in3',   label: 'IN 3',  cable: 'cv' },
    { id: 'shift', label: 'SHIFT', cable: 'gate' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'out', label: 'OUT', cable: 'cv' },
  ];
</script>

<MoogPanel {id} {data} defaultLabel="962 Seq Switch" width={200}>
  <PatchPanel nodeId={id} {inputs} {outputs}>
    <!-- STAGES: how many inputs the SHIFT gate cycles through (2 or 3). -->
    <div class="knob-row" data-testid="moog962-stages">
      <Knob
        value={stages}
        min={2}
        max={3}
        defaultValue={3}
        label="Stages"
        curve="discrete"
        onchange={setParam('stages')}
        moduleId={id}
        paramId="stages"
        readLive={readLive('stages')}
      />
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
