<script lang="ts">
  // ChromakeyCard — proper 2-input chroma-key compositor (FG + BG +
  // configurable key color). Replaces the old CHROMA's single-input
  // "mask only" semantics with a full keyer that composites.
  //
  // All ports live in the shared yellow drill-down <PatchPanel> (the post-#767
  // hard standard — NO raw side <Handle> jacks). Port `id`s are byte-identical
  // to chromakeyDef so the CV bridge + persisted edges route unchanged.
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { patch } from '$lib/graph/store';
  import { setNodeParam } from '$lib/graph/mutate';
  import { chromakeyDef } from '$lib/video/modules/chromakey';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);

  function p(name: string): number {
    const def = chromakeyDef.params.find((d) => d.id === name);
    return node?.params[name] ?? def?.defaultValue ?? 0;
  }
  function setParam(paramId: string) {
    return (v: number) => setNodeParam(id, paramId, v);
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

  // Ports — ids byte-identical to chromakeyDef (fg/bg = video, keyR/keyG/keyB +
  // threshold/softness/spillSuppress = cv, out = video).
  const inputs = portsFromDef(chromakeyDef.inputs, {
    threshold: 'THRESH', softness: 'SOFT', spillSuppress: 'SPILL',
  });
  const outputs = portsFromDef(chromakeyDef.outputs);
</script>

<div class="vcard card video" data-testid="chromakey-card">
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="CHROMAKEY" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="body">
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
