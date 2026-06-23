<script lang="ts">
  // FaderCard — the card face for FADER: a two-source video mixer with a
  // send/return FX loop. Two horizontal faders (A↔B and dry/wet), each with a
  // transition-shape dropdown (fade / wipe / dissolve / star / checkerboard).
  // All ports live in the shared yellow drill-down <PatchPanel> (post-#767
  // standard): IN A / IN B / RETURN, OUT / SEND. Params flow card → engine via
  // setNodeParam (the same path a patched CV cable would drive).

  import { type NodeProps } from '@xyflow/svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { setNodeParam } from '$lib/graph/mutate';
  import { faderDef } from '$lib/video/modules/fader';
  import { TRANSITION_NAMES } from '$lib/video/modules/fader-transitions';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  const paramDef = (name: string) => faderDef.params?.find((pp) => pp.id === name);
  /** Current param value (live node.params, else the def default). */
  function p(name: string): number {
    const v = node?.params?.[name];
    return typeof v === 'number' ? v : (paramDef(name)?.defaultValue ?? 0);
  }
  const set = (paramId: string) => (v: number) => setNodeParam(id, paramId, v);

  const inputs: PortDescriptor[] = [
    { id: 'in_a',   label: 'A',   cable: 'video' },
    { id: 'in_b',   label: 'B',   cable: 'video' },
    { id: 'return', label: 'RET', cable: 'video' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'out',  label: 'OUT',  cable: 'video' },
    { id: 'send', label: 'SEND', cable: 'video' },
  ];
</script>

<div class="mod-card fader-card" data-testid="fader-card">
  <div class="stripe" style="background: var(--cable-video);"></div>
  <ModuleTitle {id} {data} defaultLabel="fader" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="body nodrag" data-testid="fader-body">
      <!-- A ↔ B crossfade + its transition shape -->
      <div class="group">
        <div class="row">
          <span class="lbl">A<span class="dim"> ◂▸ </span>B</span>
          <input
            type="range" class="slider nodrag" min="0" max="1" step="0.01" value={p('fader')}
            data-testid="fader-ab"
            oninput={(e) => set('fader')(Number((e.currentTarget as HTMLInputElement).value))} />
        </div>
        <div class="row">
          <span class="lbl">FX</span>
          <select
            class="sel nodrag" data-testid="fader-ab-fx" value={p('abTransition')}
            onchange={(e) => set('abTransition')(Number((e.currentTarget as HTMLSelectElement).value))}>
            {#each TRANSITION_NAMES as nm, i (nm)}
              <option value={i}>{nm}</option>
            {/each}
          </select>
        </div>
      </div>

      <div class="sep" aria-hidden="true"></div>

      <!-- send/return: dry (mix) ↔ wet (return) + its transition shape -->
      <div class="group">
        <div class="row">
          <span class="lbl">DRY<span class="dim"> ◂▸ </span>WET</span>
          <input
            type="range" class="slider nodrag" min="0" max="1" step="0.01" value={p('dryWet')}
            data-testid="fader-drywet"
            oninput={(e) => set('dryWet')(Number((e.currentTarget as HTMLInputElement).value))} />
        </div>
        <div class="row">
          <span class="lbl">FX</span>
          <select
            class="sel nodrag" data-testid="fader-drywet-fx" value={p('dwTransition')}
            onchange={(e) => set('dwTransition')(Number((e.currentTarget as HTMLSelectElement).value))}>
            {#each TRANSITION_NAMES as nm, i (nm)}
              <option value={i}>{nm}</option>
            {/each}
          </select>
        </div>
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .mod-card {
    width: 220px;
    background: var(--module-bg);
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text);
    padding-top: 18px;
    padding-bottom: 12px;
    position: relative;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  :global(.svelte-flow__node:hover) .mod-card { border-color: var(--accent-dim); }
  :global(.svelte-flow__node.selected) .mod-card {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .stripe { position: absolute; top: 0; left: 0; right: 0; height: 2px; border-radius: 2px 2px 0 0; }

  .body { padding: 8px; display: flex; flex-direction: column; gap: 8px; }
  .group { display: flex; flex-direction: column; gap: 6px; }
  .row { display: flex; align-items: center; gap: 8px; }
  .lbl {
    flex: 0 0 64px;
    font-size: 0.6rem;
    letter-spacing: 0.04em;
    color: var(--text-dim);
    white-space: nowrap;
  }
  .lbl .dim { color: var(--accent-dim); }
  .slider { flex: 1; min-width: 0; }
  .sel {
    flex: 1;
    min-width: 0;
    height: 24px;
    font-size: 0.72rem;
    color: var(--text);
    background: var(--control-bg, #1c1c22);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 0 4px;
    text-transform: capitalize;
  }
  .sep { height: 1px; background: var(--border); opacity: 0.6; margin: 2px 0; }
</style>
