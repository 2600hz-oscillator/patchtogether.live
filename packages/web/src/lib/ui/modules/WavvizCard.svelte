<script lang="ts">
  // WavvizCard — WAVVIZ is the wavetable-VCO sister with a built-in
  // wavefolder + a mono-video scope output.
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import { patch } from '$lib/graph/store';
  import { wavvizDef, type WavvizData } from '$lib/audio/modules/wavviz';
  import {
    WAVETABLE_PRESETS,
    loadWavetablePreset,
  } from '$lib/audio/wavetable-presets';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  let tune       = $derived(node?.params.tune       ?? wavvizDef.params[0]!.defaultValue);
  let fine       = $derived(node?.params.fine       ?? wavvizDef.params[1]!.defaultValue);
  let wavePos    = $derived(node?.params.wavePos    ?? wavvizDef.params[2]!.defaultValue);
  let fmAmount   = $derived(node?.params.fmAmount   ?? wavvizDef.params[3]!.defaultValue);
  let foldAmount = $derived(node?.params.foldAmount ?? wavvizDef.params[4]!.defaultValue);

  const set = (k: string) => (v: number) => { const t = patch.nodes[id]; if (t) t.params[k] = v; };
  const live = (k: string) => () => { const e = engineCtx.get(); if (!e || !node) return undefined; return e.readParam(node, k); };

  // Baked-in wavetable preset loader. Writes node.data.wavetableFrames; the
  // wavviz factory's poll loop picks it up and re-posts via the SAME 'load'
  // port message it already uses for the synthetic basic-shapes table. No
  // worklet changes (the wavetable-vco worklet's 'load' handler accepts
  // arbitrary frameSize × frameCount — bundled presets are 256 × 64 vs
  // synthetic 2048 × 16; both shapes work).
  let presetSelection = $state('');
  let presetStatus = $state<string | null>(null);
  let presetError = $state<string | null>(null);
  async function onPresetChange(ev: Event): Promise<void> {
    const sel = ev.target as HTMLSelectElement;
    const presetId = sel.value;
    if (!presetId) return;
    const preset = WAVETABLE_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    presetError = null;
    presetStatus = `loading ${preset.label}...`;
    try {
      const parsed = await loadWavetablePreset(preset.url);
      const target = patch.nodes[id];
      if (!target) return;
      if (!target.data) target.data = {};
      const d = target.data as WavvizData;
      d.wavetableFrames = parsed.frames;
      d.wavetableLabel = preset.label;
      presetStatus = `loaded ${preset.label} (${parsed.frames.length} frames)`;
    } catch (err) {
      presetError = err instanceof Error ? err.message : String(err);
      presetStatus = null;
    } finally {
      presetSelection = '';
    }
  }
</script>

<div class="mod-card wv-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="WAVVIZ" />

  <Handle type="target" position={Position.Left} id="pitch"      style="top: 56px;  --handle-color: var(--cable-pitch);" />
  <Handle type="target" position={Position.Left} id="fm"         style="top: 92px;  --handle-color: var(--cable-audio);" />
  <Handle type="target" position={Position.Left} id="wavePos"    style="top: 128px; --handle-color: var(--cable-cv);" />
  <Handle type="target" position={Position.Left} id="foldAmount" style="top: 164px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 50px;">pitch</span>
  <span class="port-label left" style="top: 86px;">fm</span>
  <span class="port-label left" style="top: 122px;">wave</span>
  <span class="port-label left" style="top: 158px;">fold</span>

  <Handle type="source" position={Position.Right} id="audio" style="top: 56px;  --handle-color: var(--cable-audio);" />
  <Handle type="source" position={Position.Right} id="scope" style="top: 92px;  --handle-color: var(--cable-mono-video);" />
  <span class="port-label right" style="top: 50px;">audio</span>
  <span class="port-label right" style="top: 86px;">scope</span>

  <div class="preset-row">
    <select
      class="preset-select"
      value={presetSelection}
      onchange={onPresetChange}
      data-testid="wavviz-preset-select"
    >
      <option value="">— pick a preset —</option>
      {#each WAVETABLE_PRESETS as p (p.id)}
        <option value={p.id}>{p.label}</option>
      {/each}
    </select>
  </div>
  {#if presetStatus}
    <div class="preset-status" data-testid="wavviz-preset-status">{presetStatus}</div>
  {/if}
  {#if presetError}
    <div class="preset-error" data-testid="wavviz-preset-error">{presetError}</div>
  {/if}

  <div class="fader-row">
    <Fader value={tune}       min={-36}  max={36}  defaultValue={0} label="Tune" units="st" curve="linear" onchange={set('tune')} moduleId={id} paramId="tune"       readLive={live('tune')} />
    <Fader value={fine}       min={-100} max={100} defaultValue={0} label="Fine" units="¢"  curve="linear" onchange={set('fine')} moduleId={id} paramId="fine"       readLive={live('fine')} />
    <Fader value={wavePos}    min={0}    max={1}   defaultValue={0} label="Wave"            curve="linear" onchange={set('wavePos')} moduleId={id} paramId="wavePos"    readLive={live('wavePos')} />
    <Fader value={fmAmount}   min={0}    max={1}   defaultValue={0} label="FM"              curve="linear" onchange={set('fmAmount')} moduleId={id} paramId="fmAmount"   readLive={live('fmAmount')} />
    <Fader value={foldAmount} min={0}    max={1}   defaultValue={0} label="Fold"            curve="linear" onchange={set('foldAmount')} moduleId={id} paramId="foldAmount" readLive={live('foldAmount')} />
  </div>
</div>

<style>
  .wv-card { width: 280px; min-height: 280px; }
  .wv-card .preset-row {
    margin: 6px 14px 0;
    display: flex;
    gap: 6px;
  }
  .wv-card .preset-select {
    flex: 1;
    background: #1a1f2a;
    color: var(--text, #d8dde6);
    border: 1px solid #2a2f3a;
    border-radius: 2px;
    padding: 2px 6px;
    font-size: 0.6rem;
    font-family: ui-monospace, monospace;
  }
  .wv-card .preset-status,
  .wv-card .preset-error {
    margin: 2px 14px 0;
    font-size: 0.55rem;
    font-family: ui-monospace, monospace;
    color: var(--text-dim);
  }
  .wv-card .preset-error { color: #ff6b6b; }
</style>
