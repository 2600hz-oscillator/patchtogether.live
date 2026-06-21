<script lang="ts">
  // LumakeyCard — proper 2-input luma-key compositor (FG + BG +
  // threshold). Replaces the old LUMA's single-input "mask only"
  // semantics with a full keyer that composites.
  //
  // All ports live in the shared yellow drill-down <PatchPanel> (the post-#767
  // hard standard — NO raw side <Handle> jacks). Port `id`s are byte-identical
  // to lumakeyDef so the CV bridge + persisted edges route unchanged.
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { setNodeParam } from '$lib/graph/mutate';
  import { lumakeyDef } from '$lib/video/modules/lumakey';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  function p(name: string): number {
    const def = lumakeyDef.params.find((d) => d.id === name);
    return node?.params[name] ?? def?.defaultValue ?? 0;
  }
  function setParam(paramId: string) {
    return (v: number) => setNodeParam(id, paramId, v);
  }

  function toggleInvert() {
    const target = patch.nodes[id];
    if (!target) return;
    target.params.invert = (target.params.invert ?? 0) >= 0.5 ? 0 : 1;
  }
  let invertOn = $derived(p('invert') >= 0.5);

  // Ports — ids byte-identical to lumakeyDef (fg/bg = video, threshold/softness/
  // invert = cv, out = video).
  const inputs: PortDescriptor[] = [
    { id: 'fg', label: 'FG', cable: 'video' },
    { id: 'bg', label: 'BG', cable: 'video' },
    { id: 'threshold', label: 'THRESH', cable: 'cv' },
    { id: 'softness', label: 'SOFT', cable: 'cv' },
    { id: 'invert', label: 'INVERT', cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [{ id: 'out', label: 'OUT', cable: 'video' }];
</script>

<div class="card video" data-testid="lumakey-card">
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="LUMAKEY" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="body">
      <button
        class="invert-btn"
        class:on={invertOn}
        onclick={toggleInvert}
        data-testid="lumakey-invert"
      >INV</button>

      <div class="fader-grid">
        <Fader value={p('threshold')} min={0} max={1}   defaultValue={lumakeyDef.params.find((x) => x.id === 'threshold')!.defaultValue} label="Thr"  curve="linear" onchange={setParam('threshold')} moduleId={id} paramId="threshold" />
        <Fader value={p('softness')}  min={0} max={0.5} defaultValue={lumakeyDef.params.find((x) => x.id === 'softness')!.defaultValue}  label="Soft" curve="linear" onchange={setParam('softness')}  moduleId={id} paramId="softness" />
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .card {
    width: 220px;
    min-height: 220px;
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
  .stripe { position: absolute; top: 0; left: 0; right: 0; height: 2px; border-radius: 2px 2px 0 0; background: var(--cable-video); }
  .title { font-size: 0.85rem; font-weight: 500; text-align: center; margin: 0 0 8px; letter-spacing: 0.05em; }
  .body {
    /* Clear the PatchPanel's top-left/right trigger affordances. */
    margin-top: 24px;
    padding: 0 12px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    align-items: center;
  }
  .invert-btn {
    display: block;
    background: var(--module-bg);
    color: var(--text-dim);
    border: 1px solid var(--border);
    border-radius: 3px;
    font-size: 0.65rem;
    letter-spacing: 0.08em;
    padding: 4px 10px;
    cursor: pointer;
    font-family: ui-monospace, monospace;
  }
  .invert-btn.on {
    background: var(--accent-dim, #46506b);
    color: var(--text);
    border-color: var(--accent, #6884d7);
  }
  .invert-btn:hover { border-color: var(--accent-dim); }
  .fader-grid {
    padding: 0 12px;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px 16px;
    justify-items: center;
  }
</style>
