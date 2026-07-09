<script lang="ts">
  // POLARIZER card — a tiny 1-in / 1-out CV utility: unipolar [0,1] → bipolar
  // [-1,+1]. ONE DEPTH knob (0..1, default 1) scales the swing:
  // out = (2·in − 1)·depth.
  //
  // All ports live in the shared yellow drill-down <PatchPanel> (the post-#767
  // hard standard — NO raw side <Handle> jacks; this also gives the card its
  // rear-view back panel). Port `id`s are byte-identical to polarizerDef so the
  // CV bridge + persisted edges route unchanged.
  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { setNodeParam } from '$lib/graph/mutate';
  import { polarizerDef } from '$lib/audio/modules/polarizer';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  function def(pid: string) {
    return polarizerDef.params.find((p) => p.id === pid)!;
  }
  let depth = $derived(node?.params.depth ?? def('depth').defaultValue);

  function setParam(paramId: string) {
    return (v: number): void => setNodeParam(id, paramId, v);
  }
  function readLive(paramId: string) {
    return (): number | undefined => {
      const eng = engineCtx.get();
      if (!eng || !node) return undefined;
      return eng.readParam(node, paramId);
    };
  }

  const inputs = portsFromDef(polarizerDef.inputs);
  const outputs = portsFromDef(polarizerDef.outputs);
</script>

<div class="vcard card cv" data-testid="polarizer-card">
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="POLARIZER" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="body">
      <!-- out = (2·in − 1)·depth. 1 = full ±1, 0 = flat 0. -->
      <div class="knob-row" data-testid="polarizer-depth">
        <Knob
          value={depth}
          min={def('depth').min}
          max={def('depth').max}
          defaultValue={def('depth').defaultValue}
          label="DEPTH"
          curve="linear"
          onchange={setParam('depth')}
          moduleId={id}
          paramId="depth"
          readLive={readLive('depth')}
        />
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .card {
    width: 160px;
    min-height: 150px;
  }
  .stripe {
    background: var(--cable-cv);
  }
  .body {
    /* Clear the PatchPanel's top-left/right trigger affordances. */
    margin-top: 24px;
    padding: 0 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .knob-row {
    display: flex;
    justify-content: center;
    padding: 8px 0 4px;
  }
</style>
