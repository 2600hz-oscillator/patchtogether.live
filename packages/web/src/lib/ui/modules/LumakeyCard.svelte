<script lang="ts">
  // LumakeyCard — proper 2-input luma-key compositor (FG + BG +
  // threshold). Replaces the old LUMA's single-input "mask only"
  // semantics with a full keyer that composites.
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import { patch } from '$lib/graph/store';
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
    return (v: number) => {
      const target = patch.nodes[id];
      if (target) target.params[paramId] = v;
    };
  }

  function toggleInvert() {
    const target = patch.nodes[id];
    if (!target) return;
    target.params.invert = (target.params.invert ?? 0) >= 0.5 ? 0 : 1;
  }
  let invertOn = $derived(p('invert') >= 0.5);
</script>

<div class="card video">
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="LUMAKEY" />

  <Handle type="target" position={Position.Left} id="fg"        style="top: 56px;  --handle-color: var(--cable-video);" />
  <span class="port-label left" style="top: 50px;">FG</span>
  <Handle type="target" position={Position.Left} id="bg"        style="top: 88px;  --handle-color: var(--cable-video);" />
  <span class="port-label left" style="top: 82px;">BG</span>
  <Handle type="target" position={Position.Left} id="threshold" style="top: 124px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 118px;">T</span>
  <Handle type="target" position={Position.Left} id="softness"  style="top: 156px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 150px;">S</span>
  <Handle type="target" position={Position.Left} id="invert"    style="top: 188px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 182px;">I</span>

  <Handle type="source" position={Position.Right} id="out" style="top: 56px; --handle-color: var(--cable-video);" />
  <span class="port-label right" style="top: 50px;">OUT</span>

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

<style>
  .card {
    width: 220px;
    min-height: 280px;
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
  .port-label { position: absolute; font-size: 0.6rem; color: var(--text-dim); pointer-events: none; font-family: ui-monospace, monospace; }
  .port-label.left { left: 14px; }
  .port-label.right { right: 14px; }
  .invert-btn {
    margin: 110px auto 0;
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
    margin-top: 12px;
    padding: 0 12px;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px 16px;
    justify-items: center;
  }
</style>
