<script lang="ts">
  // NEGATIVITY card — a tiny 1-in / 1-out CV utility: a pure inverter, out = −in.
  // NO knob, no params — it just flips the sign of its input.
  //
  // All ports live in the shared yellow drill-down <PatchPanel> (the post-#767
  // hard standard — NO raw side <Handle> jacks; this also gives the card its
  // rear-view back panel). Port `id`s are byte-identical to negativityDef so the
  // CV bridge + persisted edges route unchanged.
  import type { NodeProps } from '@xyflow/svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();

  const inputs: PortDescriptor[] = [{ id: 'in', label: 'IN', cable: 'cv' }];
  const outputs: PortDescriptor[] = [{ id: 'out', label: 'OUT', cable: 'cv' }];
</script>

<div class="card cv" data-testid="negativity-card">
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="NEGATIVITY" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="body">
      <!-- out = −in. Fixed inverter, no controls. -->
      <div class="glyph" data-testid="negativity-glyph">−1&times;</div>
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
    background: var(--cable-cv);
  }
  .body {
    /* Clear the PatchPanel's top-left/right trigger affordances. */
    margin-top: 24px;
    padding: 0 12px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }
  .glyph {
    font-size: 28px;
    font-weight: 600;
    letter-spacing: 0.04em;
    color: var(--cable-cv);
    opacity: 0.85;
    padding: 10px 0 4px;
    user-select: none;
  }
</style>
