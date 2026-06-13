<script lang="ts">
  // GatemaidenCard — single-input gate↔trigger converter.
  // One IN; a GATE out (held square, min width Len) + a TRIG out (short pulse
  // per rising edge). ▷ marks the trigger port, ▭ the gate ports.

  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { setNodeParam } from '$lib/graph/mutate';
  import { gatemaidenDef } from '$lib/audio/modules/gatemaiden';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  function defaultFor(k: string): number {
    return gatemaidenDef.params.find((p) => p.id === k)?.defaultValue ?? 0;
  }
  function paramVal(k: string): number {
    const v = node?.params?.[k];
    return typeof v === 'number' ? v : defaultFor(k);
  }
  const set = (k: string) => (v: number) => {
    setNodeParam(id, k, v);
  };
  const live = (k: string) => () => {
    const e = engineCtx.get(); if (!e || !node) return undefined;
    return e.readParam(node, k);
  };

  // ▷ = trigger (short pulse), ▭ = gate (held level) — the trigger/gate glyphs.
  const inputs: PortDescriptor[] = [
    { id: 'in', label: 'IN', cable: 'gate' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'gate', label: '▭ GATE', cable: 'gate' },
    { id: 'trig', label: '▷ TRIG', cable: 'gate' },
  ];

  const shapeLabels = ['△ TRI', '▭ SQR'] as const;
  function cycleShape() {
    const t = patch.nodes[id]; if (!t) return;
    const cur = (t.params.trigShape ?? 0) | 0;
    t.params.trigShape = cur >= 1 ? 0 : 1;
  }
  let shapeLabel = $derived(shapeLabels[((paramVal('trigShape') | 0) % 2)]);
</script>

<div class="mod-card gatemaiden-card">
  <div class="stripe" style="background: var(--cable-gate);"></div>
  <ModuleTitle {id} {data} defaultLabel="gatemaiden" />

  <PatchPanel nodeId={id} {inputs} {outputs} panelWidth={180}>
    <div class="body">
      <div class="len">
        <Fader
          value={paramVal('gateLen')}
          min={0.005} max={2} defaultValue={defaultFor('gateLen')}
          label="Len"
          curve="log"
          onchange={set('gateLen')} moduleId={id} paramId="gateLen"
          readLive={live('gateLen')}
        />
      </div>
      <button class="modebtn" onclick={cycleShape} data-testid="gatemaiden-shape">{shapeLabel}</button>
    </div>
  </PatchPanel>
</div>

<style>
  .mod-card {
    width: 200px;
    background: var(--module-bg);
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text);
    /* Rack-compaction (#759): tightened 18/14 → 10/9 to fit the 1u tier. */
    padding-top: 10px;
    padding-bottom: 9px;
    position: relative;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  :global(.svelte-flow__node:hover) .mod-card { border-color: var(--accent-dim); }
  :global(.svelte-flow__node.selected) .mod-card {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .stripe { position: absolute; top: 0; left: 0; right: 0; height: 2px; border-radius: 2px 2px 0 0; }
  .body {
    /* Rack-compaction (#759): tightened padding + gap to fit 1u. */
    padding: 2px 10px 4px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
  }
  .len { width: 60px; }
  .modebtn {
    background: var(--module-bg);
    color: var(--text-dim);
    border: 1px solid var(--border);
    border-radius: 3px;
    font-size: 0.65rem;
    letter-spacing: 0.08em;
    padding: 5px 10px;
    cursor: pointer;
    font-family: ui-monospace, monospace;
  }
  .modebtn:hover { border-color: var(--accent-dim); color: var(--text); }
</style>
