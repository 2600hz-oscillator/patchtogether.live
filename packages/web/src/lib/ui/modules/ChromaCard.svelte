<script lang="ts">
  // ChromaCard — single-input HUE-SHIFTER / COLORIZER. Use CHROMAKEY for
  // the proper 2-input chroma-key compositor (this card's old role
  // before the v3 rework — see chroma.ts header).
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import { patch } from '$lib/graph/store';
  import { chromaDef } from '$lib/video/modules/chroma';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  function p(name: string): number {
    const def = chromaDef.params.find((d) => d.id === name);
    return node?.params[name] ?? def?.defaultValue ?? 0;
  }
  function setParam(paramId: string) {
    return (v: number) => {
      const target = patch.nodes[id];
      if (target) target.params[paramId] = v;
    };
  }

  // Tint color is exposed as a hex swatch + native color picker (the same
  // pattern the legacy keyer card used). The R/G/B params stay live for
  // CV modulation; the picker writes all three in one shot.
  function clamp01(v: number): number { return Math.max(0, Math.min(1, v)); }
  function ch(v: number): string { return Math.round(clamp01(v) * 255).toString(16).padStart(2, '0'); }
  let tintHex = $derived(`#${ch(p('tintR'))}${ch(p('tintG'))}${ch(p('tintB'))}`);

  function onColorChange(e: Event) {
    const hex = (e.target as HTMLInputElement).value;
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const target = patch.nodes[id];
    if (!target) return;
    target.params.tintR = r;
    target.params.tintG = g;
    target.params.tintB = b;
  }
</script>

<div class="card video">
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="CHROMA" />

  <Handle type="target" position={Position.Left} id="in"         style="top: 56px;  --handle-color: var(--cable-video);" />
  <span class="port-label left" style="top: 50px;">IN</span>
  <Handle type="target" position={Position.Left} id="hue"        style="top: 92px;  --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 86px;">H</span>
  <Handle type="target" position={Position.Left} id="saturation" style="top: 124px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 118px;">S</span>
  <Handle type="target" position={Position.Left} id="tintR"      style="top: 156px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 150px;">R</span>
  <Handle type="target" position={Position.Left} id="tintG"      style="top: 188px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 182px;">G</span>
  <Handle type="target" position={Position.Left} id="tintB"      style="top: 220px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 214px;">B</span>
  <Handle type="target" position={Position.Left} id="tintMix"    style="top: 252px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 246px;">M</span>

  <Handle type="source" position={Position.Right} id="out" style="top: 56px; --handle-color: var(--cable-video);" />
  <span class="port-label right" style="top: 50px;">OUT</span>

  <div class="picker-row">
    <label class="swatch-wrap" title="Click to pick tint color">
      <span class="swatch" style="background: {tintHex};"></span>
      <input
        type="color"
        class="color-input"
        value={tintHex}
        oninput={onColorChange}
        data-testid="chroma-tint-picker"
      />
      <span class="hex">{tintHex}</span>
    </label>
  </div>

  <div class="fader-grid">
    <Fader value={p('hue')}        min={-180} max={180} defaultValue={chromaDef.params.find((x) => x.id === 'hue')!.defaultValue}        label="Hue"  curve="linear" onchange={setParam('hue')}        moduleId={id} paramId="hue" />
    <Fader value={p('saturation')} min={0}    max={2}   defaultValue={chromaDef.params.find((x) => x.id === 'saturation')!.defaultValue} label="Sat"  curve="linear" onchange={setParam('saturation')} moduleId={id} paramId="saturation" />
    <Fader value={p('tintMix')}    min={0}    max={1}   defaultValue={chromaDef.params.find((x) => x.id === 'tintMix')!.defaultValue}    label="Mix"  curve="linear" onchange={setParam('tintMix')}    moduleId={id} paramId="tintMix" />
  </div>
</div>

<style>
  .card {
    width: 260px;
    min-height: 360px;
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
    margin: 165px 12px 12px;
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
