<script lang="ts">
  // FourPlexerCard — 4-in / 4-out discrete signal router.
  //
  // Four selector knobs, one per output, each choosing which of in1..in4
  // that output carries (discrete 1..4). Click/drag a knob to set it
  // directly; the matching GATE input advances it on each rising edge.
  // PatchPanel hosts the 4 signal-in + 4 gate-in + 4 signal-out handles.

  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { setNodeParam } from '$lib/graph/mutate';
  import { fourplexerDef } from '$lib/audio/modules/fourplexer';
  import { fourplexerClampSelector } from '$lib/audio/fourplexer-select';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  function defaultFor(k: string): number {
    return fourplexerDef.params.find((p) => p.id === k)?.defaultValue ?? 0;
  }
  function paramVal(k: string): number {
    const v = node?.params?.[k];
    return fourplexerClampSelector(typeof v === 'number' ? v : defaultFor(k));
  }
  // Knob value is the 0-based selector; we display 1-based via the label.
  const set = (k: string) => (v: number) => {
    setNodeParam(id, k, fourplexerClampSelector(v));
  };
  // Live reader so a gate-advanced selection visibly rotates the knob even
  // though the change originated in the worklet (it posts back into params,
  // and the engine's readParam reflects the AudioParam value).
  const live = (k: string) => () => {
    const e = engineCtx.get(); if (!e || !node) return undefined;
    const v = e.readParam(node, k);
    return typeof v === 'number' ? v : undefined;
  };

  const inputs = portsFromDef(fourplexerDef.inputs, {
    in1: 'IN 1', in2: 'IN 2', in3: 'IN 3', in4: 'IN 4', gate1: 'GATE 1', gate2: 'GATE 2',
    gate3: 'GATE 3', gate4: 'GATE 4',
  });
  const outputs = portsFromDef(fourplexerDef.outputs, {
    out1: 'OUT 1', out2: 'OUT 2', out3: 'OUT 3', out4: 'OUT 4',
  });

  const outs = [1, 2, 3, 4] as const;
  // 1-based input label for the current selector position of output o.
  function selectedInput(o: number): number {
    return paramVal(`sel${o}`) + 1;
  }
</script>

<div class="mod-card fourplexer-card">
  <div class="stripe" style="background: var(--cable-cv);"></div>
  <ModuleTitle {id} {data} defaultLabel="4PLEXER" />

  <PatchPanel nodeId={id} {inputs} {outputs} panelWidth={300}>
    <div class="body">
      <div class="hint">each OUT carries 1 of 4 INs · GATE advances</div>
      <div class="selectors">
        {#each outs as o (o)}
          <div class="sel" data-testid={`fourplexer-sel${o}`}>
            <Knob
              value={paramVal(`sel${o}`)}
              min={0} max={3} defaultValue={defaultFor(`sel${o}`)}
              label={`OUT ${o}`}
              curve="discrete"
              onchange={set(`sel${o}`)} moduleId={id} paramId={`sel${o}`}
              readLive={live(`sel${o}`)}
            />
            <div class="readout" data-testid={`fourplexer-sel${o}-readout`}>
              ← IN {selectedInput(o)}
            </div>
          </div>
        {/each}
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .mod-card {
    width: 320px;
    background: var(--module-bg);
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text);
    padding-top: 18px;
    padding-bottom: 14px;
    position: relative;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  :global(.svelte-flow__node:hover) .mod-card { border-color: var(--accent-dim); }
  :global(.svelte-flow__node.selected) .mod-card {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .stripe { position: absolute; top: 0; left: 0; right: 0; height: 2px; border-radius: 2px 2px 0 0; }  .body { padding: 4px 10px 10px; }
  .hint {
    font-size: 0.6rem;
    text-align: center;
    color: var(--text-dim);
    letter-spacing: 0.04em;
    margin-bottom: 10px;
  }
  .selectors {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 6px;
    justify-items: center;
  }
  .sel { display: flex; flex-direction: column; align-items: center; gap: 4px; }
  .readout {
    font-size: 0.6rem;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
    letter-spacing: 0.04em;
  }
</style>
