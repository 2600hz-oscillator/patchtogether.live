<script lang="ts">
  // ChromaCard — single-input HUE-SHIFTER / COLORIZER. Use CHROMAKEY for
  // the proper 2-input chroma-key compositor (this card's old role
  // before the v3 rework — see chroma.ts header).
  //
  // All ports live in the shared yellow drill-down <PatchPanel> (the post-#767
  // hard standard — NO raw side <Handle> jacks). Port `id`s are byte-identical
  // to chromaDef so the CV bridge + persisted edges route unchanged.
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { patch } from '$lib/graph/store';
  import { setNodeParam } from '$lib/graph/mutate';
  import { chromaDef } from '$lib/video/modules/chroma';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  function p(name: string): number {
    const def = chromaDef.params.find((d) => d.id === name);
    return node?.params[name] ?? def?.defaultValue ?? 0;
  }
  function setParam(paramId: string) {
    return (v: number) => setNodeParam(id, paramId, v);
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

  // Ports — ids byte-identical to chromaDef (in = video, hue/saturation/tintR/
  // tintG/tintB/tintMix = cv, out = video).
  const inputs = portsFromDef(chromaDef.inputs, {
    saturation: 'SAT', tintR: 'R', tintG: 'G', tintB: 'B', tintMix: 'MIX',
  });
  const outputs = portsFromDef(chromaDef.outputs);
</script>

<div class="vcard card video">
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="CHROMA" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="body">
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
  </PatchPanel>
</div>

<style>
  .card {
    width: 260px;
    min-height: 220px;
  }
  .body {
    /* Clear the PatchPanel's top-left/right trigger affordances. */
    margin-top: 24px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .picker-row {
    margin: 0 12px;
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
