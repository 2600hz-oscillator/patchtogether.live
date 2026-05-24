<script lang="ts">
  // ChromakeyCard — proper 2-input chroma-key compositor (FG + BG +
  // configurable key color). Replaces the old CHROMA's single-input
  // "mask only" semantics with a full keyer that composites.
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import { patch } from '$lib/graph/store';
  import { chromakeyDef } from '$lib/video/modules/chromakey';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  function p(name: string): number {
    const def = chromakeyDef.params.find((d) => d.id === name);
    return node?.params[name] ?? def?.defaultValue ?? 0;
  }
  function setParam(paramId: string) {
    return (v: number) => {
      const target = patch.nodes[id];
      if (target) target.params[paramId] = v;
    };
  }

  // Key color picker — same swatch + native input pattern as the legacy
  // CHROMA card. The R/G/B params stay live for CV modulation.
  function clamp01(v: number): number { return Math.max(0, Math.min(1, v)); }
  function ch(v: number): string { return Math.round(clamp01(v) * 255).toString(16).padStart(2, '0'); }
  let keyHex = $derived(`#${ch(p('keyR'))}${ch(p('keyG'))}${ch(p('keyB'))}`);

  function onColorChange(e: Event) {
    const hex = (e.target as HTMLInputElement).value;
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const target = patch.nodes[id];
    if (!target) return;
    target.params.keyR = r;
    target.params.keyG = g;
    target.params.keyB = b;
  }
</script>

<div class="card video">
  <div class="stripe"></div>
  <header class="title">CHROMAKEY</header>

  <Handle type="target" position={Position.Left} id="fg"            style="top: 56px;  --handle-color: var(--cable-video);" />
  <span class="port-label left" style="top: 50px;">FG</span>
  <Handle type="target" position={Position.Left} id="bg"            style="top: 88px;  --handle-color: var(--cable-video);" />
  <span class="port-label left" style="top: 82px;">BG</span>
  <Handle type="target" position={Position.Left} id="keyR"          style="top: 124px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 118px;">R</span>
  <Handle type="target" position={Position.Left} id="keyG"          style="top: 156px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 150px;">G</span>
  <Handle type="target" position={Position.Left} id="keyB"          style="top: 188px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 182px;">B</span>
  <Handle type="target" position={Position.Left} id="threshold"     style="top: 220px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 214px;">T</span>
  <Handle type="target" position={Position.Left} id="softness"      style="top: 252px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 246px;">S</span>
  <Handle type="target" position={Position.Left} id="spillSuppress" style="top: 284px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 278px;">Sp</span>

  <Handle type="source" position={Position.Right} id="out" style="top: 56px; --handle-color: var(--cable-video);" />
  <span class="port-label right" style="top: 50px;">OUT</span>

  <div class="picker-row">
    <label class="swatch-wrap" title="Click to pick key color">
      <span class="swatch" style="background: {keyHex};"></span>
      <input
        type="color"
        class="color-input"
        value={keyHex}
        oninput={onColorChange}
        data-testid="chromakey-color-picker"
      />
      <span class="hex">{keyHex}</span>
    </label>
  </div>

  <div class="fader-grid">
    <Fader value={p('threshold')}     min={0} max={1}   defaultValue={chromakeyDef.params.find((x) => x.id === 'threshold')!.defaultValue}     label="Thr"   curve="linear" onchange={setParam('threshold')}     moduleId={id} paramId="threshold" />
    <Fader value={p('softness')}      min={0} max={0.5} defaultValue={chromakeyDef.params.find((x) => x.id === 'softness')!.defaultValue}      label="Soft"  curve="linear" onchange={setParam('softness')}      moduleId={id} paramId="softness" />
    <Fader value={p('spillSuppress')} min={0} max={1}   defaultValue={chromakeyDef.params.find((x) => x.id === 'spillSuppress')!.defaultValue} label="Spill" curve="linear" onchange={setParam('spillSuppress')} moduleId={id} paramId="spillSuppress" />
  </div>
</div>

<style>
  .card {
    width: 260px;
    min-height: 380px;
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
  .picker-row {
    margin: 200px 12px 12px;
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .swatch-wrap {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    user-select: none;
  }
  .swatch {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    border: 1px solid var(--border);
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.3);
    display: inline-block;
  }
  .color-input {
    position: absolute;
    opacity: 0;
    width: 1px;
    height: 1px;
  }
  .swatch-wrap:hover .swatch {
    border-color: var(--accent-dim);
  }
  .hex {
    font-family: ui-monospace, monospace;
    font-size: 0.7rem;
    color: var(--text-dim);
    letter-spacing: 0.02em;
  }
  .fader-grid {
    padding: 0 8px;
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 10px;
    justify-items: center;
  }
</style>
