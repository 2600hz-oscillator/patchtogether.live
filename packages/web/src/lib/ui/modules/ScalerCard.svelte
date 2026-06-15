<script lang="ts">
  // SCALER card — a tiny 1-in / 1-out signal multiplier. ONE AMOUNT knob
  // (x0.1 .. x10, log taper, unity at center) scales the input: out = in * amount.
  //
  // All ports live in the shared yellow drill-down <PatchPanel> (the post-#767
  // hard standard — NO raw side <Handle> jacks; this also gives the card its
  // rear-view back panel). Port `id`s are byte-identical to scalerDef so the CV
  // bridge + persisted edges route unchanged.
  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { setNodeParam } from '$lib/graph/mutate';
  import { scalerDef } from '$lib/audio/modules/scaler';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  function def(pid: string) {
    return scalerDef.params.find((p) => p.id === pid)!;
  }
  let amount = $derived(node?.params.amount ?? def('amount').defaultValue);

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

  const inputs: PortDescriptor[] = [{ id: 'in', label: 'IN', cable: 'audio' }];
  const outputs: PortDescriptor[] = [{ id: 'out', label: 'OUT', cable: 'audio' }];
</script>

<div class="card audio" data-testid="scaler-card">
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="SCALER" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="body">
      <!-- out = in * amount. Log taper → unity (1.0) at knob center; the full
           sweep spans x0.1 (left) .. x10 (right). -->
      <div class="knob-row" data-testid="scaler-amount">
        <Knob
          value={amount}
          min={def('amount').min}
          max={def('amount').max}
          defaultValue={def('amount').defaultValue}
          label="AMOUNT"
          units="x"
          curve="log"
          onchange={setParam('amount')}
          moduleId={id}
          paramId="amount"
          readLive={readLive('amount')}
        />
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .card {
    width: 160px;
    min-height: 150px;
    background: var(--module-bg);
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text);
    padding-top: 18px;
    padding-bottom: 14px;
    position: relative;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    transition: border-color 80ms ease-out, box-shadow 80ms ease-out;
  }
  :global(.svelte-flow__node:hover) .card { border-color: var(--accent-dim); }
  :global(.svelte-flow__node.selected) .card {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .stripe {
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    border-radius: 2px 2px 0 0;
    background: var(--cable-audio);
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
