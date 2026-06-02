<script lang="ts">
  // CubeCard — 3D wavetable-navigator oscillator UI (slice 4).
  //
  // Controls:
  //   • 3 wavetable dropdowns (FLOOR / WALL / CEILING), each picking a factory
  //     table or a baked preset (reuses WAVESCULPT's loader + list — writes
  //     node.data[slot] so the cube factory's poll loop posts loadWavetable).
  //   • Knobs: TUNE / FINE / MORPH / CONNECT / CRUSH / SPREAD / Y /
  //     ROT X / ROT Y / ROT Z / LEVEL.
  //   • Toggles: WRAP (silent↔mirror-fold), MATERIAL (SMOOTH↔HARD).
  //   • View-only camera: ZOOM / VIEW X / VIEW Y / VIEW Z — transform the
  //     visualization only (no effect on sound or selected slice).
  //
  // Visualization (2D fallback per PLAN §8 / §10 Q9 — "PRIORITIZE a functional,
  // registered, audible, handle-complete module over visualization polish"):
  //   We ship a clear 2D view driven entirely by the worklet's slice SNAPSHOT
  //   (the played waveform), so it needs no cross-bundle DSP import (this repo's
  //   convention keeps web code off packages/dsp/src — see stages-engine.ts):
  //     • SURFACE-HEIGHT view — the snapshot drawn as a filled silhouette. The
  //       surface-height scan IS the slice's intersection-depth profile, so
  //       this panel literally shows the cube's cross-section shape that the
  //       slice reads out (taller fill = the solid extends further along the
  //       ray at that x). It tracks Y / rotation / morph / crush / material /
  //       wrap live because the worklet recomputes the slice from them.
  //     • OUTPUT WAVEFORM — the same snapshot as a centered scope trace.
  //   The full rotatable 3D WebGL navigator (alpha-blended slice stack →
  //   raymarched volume) is a documented follow-up; the snapshot transport +
  //   deterministic field math are already in place for it.
  //
  // PatchPanel exposes EVERY input handle (pitch + 8 CVs) + the audio_out
  // handle.

  import type { NodeProps } from '@xyflow/svelte';
  import { onDestroy } from 'svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import ModuleTitle from './ModuleTitle.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { cubeDef, CUBE_SLOTS, CUBE_DEFAULT_TABLES, type CubeSlot, type CubeData, type CubeSlotData } from '$lib/audio/modules/cube';
  import { getFactoryTables } from '$lib/audio/wavetable-factory-tables';
  import { WAVETABLE_PRESETS, loadWavetablePreset } from '$lib/audio/wavetable-presets';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  const defaultFor = (pid: string): number =>
    cubeDef.params.find((p) => p.id === pid)!.defaultValue;
  const minFor = (pid: string): number => cubeDef.params.find((p) => p.id === pid)!.min;
  const maxFor = (pid: string): number => cubeDef.params.find((p) => p.id === pid)!.max;

  function paramVal(k: string): number {
    const v = node?.params?.[k];
    return typeof v === 'number' ? v : defaultFor(k);
  }
  const set = (pid: string) => (v: number) => {
    const t = patch.nodes[id]; if (t) t.params[pid] = v;
  };
  const live = (pid: string) => () => {
    const e = engineCtx.get(); if (!e || !node) return undefined;
    return e.readParam(node, pid);
  };

  // ───────────────── toggles ─────────────────
  let wrapOn = $derived(paramVal('wrap') >= 0.5);
  let materialHard = $derived(paramVal('material') >= 0.5);
  function toggleWrap(): void { set('wrap')(wrapOn ? 0 : 1); }
  function toggleMaterial(): void { set('material')(materialHard ? 0 : 1); }

  // ───────────────── per-slot wavetable selection (node.data) ─────────────────
  const SLOT_LABEL: Record<CubeSlot, string> = { floor: 'FLOOR', wall: 'WALL', ceiling: 'CEILING' };

  function slotData(slot: CubeSlot): CubeSlotData {
    const d = (node?.data ?? {}) as CubeData;
    return (d[slot] as CubeSlotData | undefined) ?? {};
  }
  function slotSelectValue(slot: CubeSlot): string {
    const sd = slotData(slot);
    if (sd.source === 'user') return `user:${sd.label ?? ''}`;
    return sd.source ?? `factory:${CUBE_DEFAULT_TABLES[slot]}`;
  }
  let slotStatus = $state<Record<CubeSlot, string | null>>({ floor: null, wall: null, ceiling: null });

  function ensureSlot(slot: CubeSlot): CubeSlotData | null {
    const t = patch.nodes[id];
    if (!t) return null;
    if (!t.data) t.data = {};
    const d = t.data as CubeData;
    if (!d[slot]) (d as Record<string, unknown>)[slot] = {};
    return d[slot] as CubeSlotData;
  }
  function selectFactory(slot: CubeSlot, factoryId: string): void {
    const sd = ensureSlot(slot); if (!sd) return;
    sd.source = `factory:${factoryId}`;
    delete sd.frames;
    delete sd.label;
    slotStatus[slot] = null;
  }
  async function selectPreset(slot: CubeSlot, presetId: string): Promise<void> {
    const preset = WAVETABLE_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    slotStatus[slot] = `loading ${preset.label}…`;
    try {
      const parsed = await loadWavetablePreset(preset.url);
      const sd = ensureSlot(slot); if (!sd) return;
      sd.source = 'user';
      sd.frames = parsed.frames;
      sd.label = preset.label;
      slotStatus[slot] = `loaded ${parsed.frames.length} frames`;
    } catch (err) {
      slotStatus[slot] = err instanceof Error ? err.message : String(err);
    }
  }
  function onSlotChange(slot: CubeSlot, ev: Event): void {
    const sel = ev.target as HTMLSelectElement;
    const v = sel.value;
    if (v.startsWith('factory:')) selectFactory(slot, v.slice('factory:'.length));
    else if (v.startsWith('preset:')) void selectPreset(slot, v.slice('preset:'.length));
  }

  // ───────────────── visualization (rAF) ─────────────────
  let waveCanvas = $state<HTMLCanvasElement | null>(null);
  let sliceCanvas = $state<HTMLCanvasElement | null>(null);
  let raf: number | null = null;

  function drawWave(c: HTMLCanvasElement, wave: Float32Array): void {
    const ctx2d = c.getContext('2d'); if (!ctx2d) return;
    const W = c.width, H = c.height;
    ctx2d.fillStyle = '#0a0c12';
    ctx2d.fillRect(0, 0, W, H);
    ctx2d.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx2d.beginPath(); ctx2d.moveTo(0, H / 2); ctx2d.lineTo(W, H / 2); ctx2d.stroke();
    ctx2d.strokeStyle = '#5ad1ff';
    ctx2d.lineWidth = 1.5;
    ctx2d.beginPath();
    const n = wave.length;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * W;
      const y = H / 2 - (wave[i] ?? 0) * (H / 2) * 0.92;
      if (i === 0) ctx2d.moveTo(x, y); else ctx2d.lineTo(x, y);
    }
    ctx2d.stroke();
    ctx2d.fillStyle = 'rgba(255,255,255,0.5)';
    ctx2d.font = '9px monospace';
    ctx2d.fillText('OUTPUT', 5, 12);
  }

  // SURFACE-HEIGHT cross-section: the slice's intersection-depth profile drawn
  // as a filled silhouette. The snapshot value at x is in [-1,1] = 2·depth−1,
  // so depth = (v+1)/2 ∈ [0,1] is exactly how far the solid extends along the
  // ray at that x — the cube's cross-section becoming the wave. Filled from the
  // bottom up to that height.
  function drawSurface(c: HTMLCanvasElement, wave: Float32Array): void {
    const ctx2d = c.getContext('2d'); if (!ctx2d) return;
    const W = c.width, H = c.height;
    ctx2d.fillStyle = '#0a0c12';
    ctx2d.fillRect(0, 0, W, H);
    const n = wave.length;
    // Filled solid silhouette.
    ctx2d.beginPath();
    ctx2d.moveTo(0, H);
    for (let i = 0; i < n; i++) {
      const depth = Math.max(0, Math.min(1, ((wave[i] ?? 0) + 1) * 0.5));
      const x = (i / (n - 1)) * W;
      const y = H - depth * H * 0.94 - 2;
      ctx2d.lineTo(x, y);
    }
    ctx2d.lineTo(W, H);
    ctx2d.closePath();
    const grad = ctx2d.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#7fe3ff');
    grad.addColorStop(1, '#1f5e74');
    ctx2d.fillStyle = grad;
    ctx2d.fill();
    ctx2d.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx2d.strokeRect(0.5, 0.5, W - 1, H - 1);
    ctx2d.fillStyle = 'rgba(255,255,255,0.55)';
    ctx2d.font = '9px monospace';
    ctx2d.fillText('SLICE', 5, 12);
  }

  $effect(() => {
    function tick() {
      const e = engineCtx.get();
      if (e && node) {
        const snap = e.read(node, 'snapshot') as Float32Array | undefined;
        if (snap) {
          if (sliceCanvas) drawSurface(sliceCanvas, snap);
          if (waveCanvas) drawWave(waveCanvas, snap);
        }
      }
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => { if (raf !== null) cancelAnimationFrame(raf); raf = null; };
  });
  onDestroy(() => { if (raf !== null) cancelAnimationFrame(raf); });

  // ───────────────── patch panel ports ─────────────────
  const inputs: PortDescriptor[] = [
    { id: 'pitch',    label: 'PITCH',   cable: 'cv' },
    { id: 'slice_y',  label: 'Y',       cable: 'cv' },
    { id: 'slice_rx', label: 'ROT X',   cable: 'cv' },
    { id: 'slice_ry', label: 'ROT Y',   cable: 'cv' },
    { id: 'slice_rz', label: 'ROT Z',   cable: 'cv' },
    { id: 'morph_fc', label: 'MORPH',   cable: 'cv' },
    { id: 'connect',  label: 'CONNECT', cable: 'cv' },
    { id: 'crush',    label: 'CRUSH',   cable: 'cv' },
    { id: 'tune',     label: 'TUNE',    cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'audio_out', label: 'OUT', cable: 'audio' },
  ];

  const factoryTables = getFactoryTables();

  // Knob descriptor list (driven from the def so ranges/curves stay in sync).
  const KNOBS: Array<{ pid: string; label: string; units?: string }> = [
    { pid: 'tune', label: 'Tune', units: 'st' },
    { pid: 'fine', label: 'Fine', units: '¢' },
    { pid: 'morph_fc', label: 'Morph' },
    { pid: 'connect', label: 'Connect' },
    { pid: 'crush', label: 'Crush' },
    { pid: 'spread', label: 'Spread' },
    { pid: 'slice_y', label: 'Y' },
    { pid: 'slice_rx', label: 'Rot X' },
    { pid: 'slice_ry', label: 'Rot Y' },
    { pid: 'slice_rz', label: 'Rot Z' },
    { pid: 'level', label: 'Level' },
  ];
  const VIEW_KNOBS: Array<{ pid: string; label: string }> = [
    { pid: 'view_zoom', label: 'Zoom' },
    { pid: 'view_rot_x', label: 'View X' },
    { pid: 'view_rot_y', label: 'View Y' },
    { pid: 'view_rot_z', label: 'View Z' },
  ];
</script>

<div class="mod-card cube-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="CUBE" />

  <PatchPanel nodeId={id} {inputs} {outputs} panelWidth={360}>
    <div class="cube-body">
      <!-- Visualization: cube cross-section + output waveform -->
      <div class="viz-row">
        <canvas
          bind:this={sliceCanvas}
          class="viz slice-viz"
          width={150}
          height={120}
          data-testid="cube-slice-viz"
        ></canvas>
        <canvas
          bind:this={waveCanvas}
          class="viz wave-viz"
          width={180}
          height={120}
          data-testid="cube-wave-viz"
        ></canvas>
      </div>

      <!-- Wavetable selectors -->
      <div class="wt-selects">
        {#each CUBE_SLOTS as slot (slot)}
          <div class="wt-row">
            <span class="wt-label">{SLOT_LABEL[slot]}</span>
            <select
              class="wt-select"
              value={slotSelectValue(slot)}
              onchange={(ev) => onSlotChange(slot, ev)}
              data-testid={`cube-${slot}-select`}
            >
              <optgroup label="Factory">
                {#each factoryTables as t (t.id)}
                  <option value={`factory:${t.id}`}>{t.label}</option>
                {/each}
              </optgroup>
              <optgroup label="Presets">
                {#each WAVETABLE_PRESETS as p (p.id)}
                  <option value={`preset:${p.id}`}>{p.label}</option>
                {/each}
              </optgroup>
            </select>
            {#if slotStatus[slot]}
              <span class="wt-status">{slotStatus[slot]}</span>
            {/if}
          </div>
        {/each}
      </div>

      <!-- Toggles -->
      <div class="toggles">
        <button
          class="toggle"
          class:on={wrapOn}
          onclick={toggleWrap}
          data-testid="cube-wrap-toggle"
          title="WRAP: out-of-cube slice is silent (off) or mirror-folds back in (on)"
        >WRAP: {wrapOn ? 'ON' : 'OFF'}</button>
        <button
          class="toggle"
          class:on={materialHard}
          onclick={toggleMaterial}
          data-testid="cube-material-toggle"
          title="MATERIAL: SMOOTH (continuous density) or HARD (binary solid)"
        >MAT: {materialHard ? 'HARD' : 'SMOOTH'}</button>
      </div>

      <!-- Audio knobs -->
      <div class="knobs">
        {#each KNOBS as k (k.pid)}
          <Knob
            value={paramVal(k.pid)}
            min={minFor(k.pid)}
            max={maxFor(k.pid)}
            defaultValue={defaultFor(k.pid)}
            label={k.label}
            units={k.units}
            curve="linear"
            onchange={set(k.pid)}
            moduleId={id}
            paramId={k.pid}
            readLive={live(k.pid)}
          />
        {/each}
      </div>

      <!-- View-only camera controls -->
      <div class="view-section">
        <div class="view-head">VIEW (visualization only)</div>
        <div class="knobs view-knobs">
          {#each VIEW_KNOBS as k (k.pid)}
            <Knob
              value={paramVal(k.pid)}
              min={minFor(k.pid)}
              max={maxFor(k.pid)}
              defaultValue={defaultFor(k.pid)}
              label={k.label}
              curve={k.pid === 'view_zoom' ? 'log' : 'linear'}
              onchange={set(k.pid)}
              moduleId={id}
              paramId={k.pid}
              readLive={live(k.pid)}
            />
          {/each}
        </div>
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .cube-card {
    width: 360px;
    background: var(--cube-bg, #12141b);
    color: #ece8e2;
  }
  .cube-body { padding: 6px 10px 8px; display: flex; flex-direction: column; gap: 8px; }
  .viz-row { display: flex; gap: 8px; justify-content: center; }
  .viz { border-radius: 4px; background: #0a0c12; border: 1px solid rgba(255,255,255,0.08); }
  .wt-selects { display: flex; flex-direction: column; gap: 4px; }
  .wt-row { display: flex; align-items: center; gap: 6px; }
  .wt-label {
    font-family: var(--font-mono, monospace);
    font-size: 0.6rem; letter-spacing: 0.04em; color: #9fb6c9;
    width: 52px; flex: none;
  }
  .wt-select {
    flex: 1; font-size: 0.62rem; background: #1b1f29; color: #ece8e2;
    border: 1px solid rgba(255,255,255,0.12); border-radius: 3px; padding: 2px 4px;
  }
  .wt-status { font-size: 0.52rem; color: #7fd6a0; white-space: nowrap; max-width: 80px; overflow: hidden; text-overflow: ellipsis; }
  .toggles { display: flex; gap: 8px; }
  .toggle {
    flex: 1; font-family: var(--font-mono, monospace); font-size: 0.6rem;
    padding: 4px 6px; border-radius: 3px; cursor: pointer;
    background: #1b1f29; color: #9fb6c9; border: 1px solid rgba(255,255,255,0.14);
  }
  .toggle.on { background: #1f5e74; color: #d9f4ff; border-color: #3a9cc0; }
  .knobs { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-end; justify-content: flex-start; }
  .view-section { border-top: 1px solid rgba(255,255,255,0.08); padding-top: 6px; }
  .view-head { font-family: var(--font-mono, monospace); font-size: 0.55rem; letter-spacing: 0.04em; color: #8294a4; margin-bottom: 4px; }
  .view-knobs { gap: 12px; }
</style>
