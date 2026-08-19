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
  import {
    fourplexerClampSelector,
    FOURPLEXER_INPUT_OPTIONS,
    FOURPLEXER_INPUTS,
    FOURPLEXER_SELECTORS,
  } from '$lib/audio/fourplexer-select';
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

  // The four selectors, DERIVED from the def rather than listed here — the
  // card can no longer disagree with the module about how many outputs it has.
  const outs = FOURPLEXER_SELECTORS;
  // The name of the input a selector currently points at. Read off the SAME
  // `options` roster the def declares (fourplexer-select.ts), so the card and
  // the faceplate say the same word — this used to be `← IN {value + 1}`
  // computed in markup, which is exactly the kind of restatement that survives
  // right up until the card stops rendering.
  function selectedLabel(paramId: string): string {
    const v = paramVal(paramId);
    return FOURPLEXER_INPUT_OPTIONS.find((o) => o.value === v)?.label ?? '';
  }
</script>

<div class="mod-card fourplexer-card">
  <div class="stripe" style="background: var(--cable-cv);"></div>
  <ModuleTitle {id} {data} defaultLabel="4PLEXER" />

  <PatchPanel nodeId={id} {inputs} {outputs} panelWidth={300}>
    <div class="body">
      <div class="hint">each OUT carries 1 of 4 INs · GATE advances</div>
      <div class="selectors">
        {#each outs as sel (sel.id)}
          <div class="sel" data-testid={`fourplexer-${sel.id}`}>
            <Knob
              value={paramVal(sel.id)}
              min={0} max={FOURPLEXER_INPUTS - 1} defaultValue={defaultFor(sel.id)}
              label={sel.label}
              curve="discrete"
              onchange={set(sel.id)} moduleId={id} paramId={sel.id}
              readLive={live(sel.id)}
            />
            <div class="readout" data-testid={`fourplexer-${sel.id}-readout`}>
              ← {selectedLabel(sel.id)}
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
