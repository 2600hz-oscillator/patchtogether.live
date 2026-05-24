<script lang="ts">
  // ChromaCard — chroma-key card.
  //
  // v2 UX: instead of three separate R/G/B faders the user mostly used as
  // a hack-around for the missing color picker, we expose a single color
  // swatch that pops a native <input type="color"> on click. The R/G/B
  // params still exist (CV inputs use them as audio-rate modulators) but
  // they're driven from the picker as a group rather than individually.
  // Threshold + Softness + Invert sit next to the swatch as faders +
  // a toggle button.

  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import { patch } from '$lib/graph/store';
  import { chromaDef } from '$lib/video/modules/chroma';
  import type { ModuleNode } from '$lib/graph/types';

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

  // Convert the three keyR/keyG/keyB params (each 0..1) to a #rrggbb
  // hex string for <input type="color">, and back.
  function clamp01(v: number): number { return Math.max(0, Math.min(1, v)); }
  function ch(v: number): string { return Math.round(clamp01(v) * 255).toString(16).padStart(2, '0'); }
  let keyHex = $derived(`#${ch(p('keyR'))}${ch(p('keyG'))}${ch(p('keyB'))}`);

  function onColorChange(e: Event) {
    const hex = (e.target as HTMLInputElement).value;
    // hex is '#rrggbb' — slice into 3 bytes, normalize to 0..1.
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const target = patch.nodes[id];
    if (!target) return;
    target.params.keyR = r;
    target.params.keyG = g;
    target.params.keyB = b;
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
  <header class="title">CHROMA</header>

  <Handle type="target" position={Position.Left} id="in"        style="top: 56px;  --handle-color: var(--cable-video);" />
  <span class="port-label left" style="top: 50px;">IN</span>
  <Handle type="target" position={Position.Left} id="keyR"      style="top: 92px;  --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 86px;">R</span>
  <Handle type="target" position={Position.Left} id="keyG"      style="top: 124px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 118px;">G</span>
  <Handle type="target" position={Position.Left} id="keyB"      style="top: 156px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 150px;">B</span>
  <Handle type="target" position={Position.Left} id="threshold" style="top: 188px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 182px;">T</span>
  <Handle type="target" position={Position.Left} id="softness"  style="top: 220px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 214px;">S</span>

  <Handle type="source" position={Position.Right} id="out" style="top: 56px; --handle-color: var(--cable-keys);" />
  <span class="port-label right" style="top: 50px;">OUT</span>

  <div class="picker-row">
    <label class="swatch-wrap" title="Click to pick key color">
      <span class="swatch" style="background: {keyHex};"></span>
      <input
        type="color"
        class="color-input"
        value={keyHex}
        oninput={onColorChange}
        data-testid="chroma-color-picker"
      />
      <span class="hex">{keyHex}</span>
    </label>
    <button
      class="invert-btn"
      class:on={invertOn}
      onclick={toggleInvert}
      data-testid="chroma-invert"
    >INV</button>
  </div>

  <div class="fader-grid">
    <Fader value={p('threshold')} min={0} max={1} defaultValue={chromaDef.params.find((x) => x.id === 'threshold')!.defaultValue} label="Thr"  curve="linear" onchange={setParam('threshold')} />
    <Fader value={p('softness')}  min={0} max={1} defaultValue={chromaDef.params.find((x) => x.id === 'softness')!.defaultValue}  label="Soft" curve="linear" onchange={setParam('softness')} />
  </div>
</div>

<style>
  .card {
    width: 280px;
    min-height: 320px;
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
  .stripe { position: absolute; top: 0; left: 0; right: 0; height: 2px; border-radius: 2px 2px 0 0; background: var(--cable-keys); }
  .title { font-size: 0.85rem; font-weight: 500; text-align: center; margin: 0 0 8px; letter-spacing: 0.05em; }
  .port-label { position: absolute; font-size: 0.6rem; color: var(--text-dim); pointer-events: none; font-family: ui-monospace, monospace; }
  .port-label.left { left: 14px; }
  .port-label.right { right: 14px; }
  .picker-row {
    margin: 130px 12px 12px;
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
    width: 36px;
    height: 36px;
    border-radius: 50%;
    border: 1px solid var(--border);
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.3);
    display: inline-block;
  }
  .color-input {
    /* Visually hide but stay focusable so the <label> click opens the
     * system picker. position+opacity:0 keeps it from contributing to
     * layout; we DO want pointer events so the popup opens reliably
     * on browsers that wire it through the input itself. */
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
  .invert-btn {
    background: var(--module-bg);
    color: var(--text-dim);
    border: 1px solid var(--border);
    border-radius: 3px;
    font-size: 0.65rem;
    letter-spacing: 0.08em;
    padding: 4px 8px;
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
    padding: 0 8px;
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 12px;
    justify-items: center;
  }
</style>

<!-- The actual color input lives on the wrap so clicking the swatch opens
     the system picker. Hidden offscreen via opacity 0 to avoid layout
     contributions. -->
