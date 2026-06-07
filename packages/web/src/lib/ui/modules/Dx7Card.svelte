<script lang="ts">
  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import { DX7_DEFAULT_PRESET } from '$lib/audio/modules/dx7';
  import { DX7_BUILTIN_BANK } from '$lib/audio/dx7-banks';
  import { parseSyxBank, type DX7Voice } from '$lib/audio/dx7-syx';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  function paramVal(key: string, fb: number): number {
    const v = node?.params?.[key];
    return typeof v === 'number' ? v : fb;
  }
  const set = (k: string) => (v: number) => { const t = patch.nodes[id]; if (t) t.params[k] = v; };
  const live = (k: string) => () => {
    const e = engineCtx.get(); if (!e || !node) return undefined;
    return e.readParam(node, k);
  };

  // ---------------- Preset state ----------------
  let presetName = $derived.by(() => {
    const d = node?.data as Record<string, unknown> | undefined;
    return typeof d?.preset === 'string' ? d.preset : DX7_DEFAULT_PRESET;
  });
  let userPatches = $derived.by((): DX7Voice[] => {
    const d = node?.data as Record<string, unknown> | undefined;
    return Array.isArray(d?.userPatches) ? (d.userPatches as DX7Voice[]) : [];
  });
  let allPatchNames = $derived.by(() => {
    const builtin = DX7_BUILTIN_BANK.map((p) => ({ name: p.name, kind: 'builtin' as const }));
    const user = userPatches.map((p) => ({ name: p.name, kind: 'user' as const }));
    return [...builtin, ...user];
  });

  function selectPreset(name: string) {
    const t = patch.nodes[id];
    if (!t) return;
    if (!t.data) t.data = {};
    (t.data as Record<string, unknown>).preset = name;
  }

  function onPresetChange(ev: Event) {
    const sel = ev.target as HTMLSelectElement;
    selectPreset(sel.value);
  }

  let syxError = $state<string | null>(null);
  let syxStatus = $state<string | null>(null);

  async function onFileChange(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    syxError = null;
    syxStatus = 'parsing...';
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const result = parseSyxBank(bytes);
      const t = patch.nodes[id];
      if (!t) return;
      if (!t.data) t.data = {};
      const existing = Array.isArray((t.data as Record<string, unknown>).userPatches)
        ? ((t.data as Record<string, unknown>).userPatches as DX7Voice[])
        : [];
      // Append (don't replace) so the user can stack multiple cartridges.
      const merged = [...existing, ...result.voices];
      (t.data as Record<string, unknown>).userPatches = merged;
      syxStatus = `loaded ${result.voices.length} voices${result.warnings.length ? ` (${result.warnings.length} warnings)` : ''}`;
      // Auto-select the first newly-loaded patch.
      if (result.voices[0]) selectPreset(result.voices[0].name);
    } catch (err) {
      syxError = err instanceof Error ? err.message : String(err);
      syxStatus = null;
    } finally {
      try { input.value = ''; } catch { /* */ }
    }
  }

  // ---------------- Algorithm cycle (visual aid for the discrete knob) ----------------
  // We render the algorithm number as text since 32 algorithms is too many for a
  // pretty diagram. The knob still lets you scrub.
  let currentAlgo = $derived(Math.round(paramVal('algorithm', 5)));

  // ---------------- I/O ports ----------------
  const inputs: PortDescriptor[] = [
    { id: 'poly',     label: 'POLY',     cable: 'polyPitchGate' },
    { id: 'pitch_cv', label: 'PITCH CV', cable: 'cv' },
    { id: 'gate',     label: 'GATE',     cable: 'gate' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'out', label: 'OUT', cable: 'audio' },
  ];
</script>

<div class="mod-card dx7-card" data-testid="dx7-card">
  <div class="stripe" style="background: var(--cable-polyPitchGate);"></div>
  <ModuleTitle {id} {data} defaultLabel="DX7" />
  <div class="subtitle">FM SYNTHESIZER · 6-OP · 32 ALGORITHMS</div>

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="body">
      <!-- Preset selector + algorithm display -->
      <div class="preset-row">
        <label class="lbl" for={`dx7-preset-${id}`}>Preset</label>
        <select id={`dx7-preset-${id}`} class="preset-select" onchange={onPresetChange} value={presetName} data-testid="dx7-preset-select">
          <optgroup label="Built-in (factory-inspired)">
            {#each DX7_BUILTIN_BANK as p (p.name)}
              <option value={p.name} selected={p.name === presetName}>{p.name}</option>
            {/each}
          </optgroup>
          {#if userPatches.length > 0}
            <optgroup label="Loaded SYX">
              {#each userPatches as p, i (p.name + i)}
                <option value={p.name} selected={p.name === presetName}>{p.name || `(unnamed ${i + 1})`}</option>
              {/each}
            </optgroup>
          {/if}
        </select>
      </div>

      <!-- Algo display -->
      <div class="algo-row">
        <div class="algo-display" data-testid="dx7-algo-display">ALG {String(currentAlgo).padStart(2, '0')}</div>
      </div>

      <!-- Knobs -->
      <div class="knob-row">
        <Knob value={paramVal('algorithm', 5)}  min={1}   max={32} defaultValue={5}   label="Algo"  curve="discrete" onchange={set('algorithm')} moduleId={id} paramId="algorithm"  readLive={live('algorithm')} />
        <Knob value={paramVal('voiceCount', 5)} min={1}   max={5}  defaultValue={5}   label="Voices" curve="discrete" onchange={set('voiceCount')} moduleId={id} paramId="voiceCount" readLive={live('voiceCount')} />
        <Knob value={paramVal('level', 0.7)}    min={0}   max={2}  defaultValue={0.7} label="Level" curve="linear"   onchange={set('level')} moduleId={id} paramId="level"      readLive={live('level')} />
        <Knob value={paramVal('transpose', 0)}  min={-24} max={24} defaultValue={0}   label="Trans" curve="linear"   onchange={set('transpose')} moduleId={id} paramId="transpose"  readLive={live('transpose')} />
      </div>

      <!-- Master output-VCA ADSR (per-voice; on top of the SYX operator EGs) -->
      <div class="adsr-label">MASTER ADSR</div>
      <div class="knob-row adsr-row">
        <Knob value={paramVal('attack', 0.001)}  min={0.001} max={5} defaultValue={0.001} label="Atk" units="s" curve="log"    onchange={set('attack')}  moduleId={id} paramId="attack"  readLive={live('attack')} />
        <Knob value={paramVal('decay', 0.1)}     min={0.001} max={5} defaultValue={0.1}   label="Dec" units="s" curve="log"    onchange={set('decay')}   moduleId={id} paramId="decay"   readLive={live('decay')} />
        <Knob value={paramVal('sustain', 1)}     min={0}     max={1} defaultValue={1}     label="Sus"           curve="linear" onchange={set('sustain')} moduleId={id} paramId="sustain" readLive={live('sustain')} />
        <Knob value={paramVal('release', 0.005)} min={0.001} max={5} defaultValue={0.005} label="Rel" units="s" curve="log"    onchange={set('release')} moduleId={id} paramId="release" readLive={live('release')} />
      </div>

      <!-- SYX upload -->
      <div class="syx-row">
        <label class="syx-btn">
          <input type="file" accept=".syx,application/octet-stream" onchange={onFileChange} data-testid="dx7-syx-input" />
          <span>Load .syx bank...</span>
        </label>
        {#if syxStatus}
          <span class="syx-status" data-testid="dx7-syx-status">{syxStatus}</span>
        {/if}
        {#if syxError}
          <span class="syx-error" data-testid="dx7-syx-error">{syxError}</span>
        {/if}
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .dx7-card {
    width: 320px;
  }
  .subtitle {
    font-size: 0.55rem;
    color: var(--text-dim);
    text-align: center;
    letter-spacing: 0.08em;
    margin-top: 2px;
  }
  .body {
    margin-top: 16px;
    padding: 0 18px 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .preset-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .preset-row .lbl {
    font-size: 0.65rem;
    color: var(--text-dim);
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  .preset-select {
    flex: 1;
    background: var(--card-bg, #1a1f2a);
    color: var(--text, #d8dde6);
    border: 1px solid #2a2f3a;
    border-radius: 2px;
    padding: 2px 6px;
    font-size: 0.7rem;
    font-family: ui-monospace, monospace;
  }
  .algo-row {
    display: flex;
    justify-content: center;
  }
  .algo-display {
    font-family: ui-monospace, monospace;
    font-size: 0.85rem;
    background: #0a0c11;
    color: var(--cable-polyPitchGate, #b386ff);
    padding: 4px 14px;
    border: 1px solid #2a2f3a;
    border-radius: 2px;
    letter-spacing: 0.12em;
  }
  .knob-row {
    display: flex;
    justify-content: center;
    gap: 14px;
    flex-wrap: wrap;
  }
  .adsr-label {
    font-size: 0.55rem;
    color: var(--text-dim);
    text-align: center;
    letter-spacing: 0.08em;
    margin-top: 2px;
  }
  .syx-row {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 4px;
    padding-top: 8px;
    border-top: 1px dashed #2a2f3a;
  }
  .syx-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: #1a1f2a;
    color: var(--text-dim);
    border: 1px dashed #404652;
    border-radius: 2px;
    padding: 4px 8px;
    font-size: 0.65rem;
    cursor: pointer;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  .syx-btn input[type='file'] {
    display: none;
  }
  .syx-btn:hover {
    color: var(--text, #d8dde6);
    border-color: #5a6172;
  }
  .syx-status {
    font-size: 0.6rem;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
  }
  .syx-error {
    font-size: 0.6rem;
    color: #ff6b6b;
    font-family: ui-monospace, monospace;
  }
</style>
