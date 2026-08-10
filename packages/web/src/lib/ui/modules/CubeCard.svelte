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
  // Visualization: THREE surfaces — the rotatable 3D WebGL2 volume (the field
  // as alpha-blended Z-slices + the cube wireframe + the live slicing plane),
  // the 2D SLICE cross-section, and the OUTPUT waveform. All of it lives in
  // `cube/CubeVizSurface.svelte`, extracted so the faceplate HERO paints the
  // SAME picture from the SAME code rather than a second, weaker renderer.
  //
  // PatchPanel exposes EVERY input handle (pitch + 8 CVs) + the L / R audio
  // output handles + the SYNC sine reference + the VIDEO out.

  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import ModuleTitle from './ModuleTitle.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { setNodeParam } from '$lib/graph/mutate';
  import { cubeDef, CUBE_SLOTS, CUBE_DEFAULT_TABLES, type CubeSlot, type CubeData, type CubeSlotData } from '$lib/audio/modules/cube';
  import CubeVizSurface from './cube/CubeVizSurface.svelte';
  import { getFactoryTables, framesToPlain } from '$lib/audio/wavetable-factory-tables';
  import { WAVETABLE_PRESETS, loadWavetablePreset } from '$lib/audio/wavetable-presets';
  import { parseE352Wav } from '$lib/audio/wavetable-parser';
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
    setNodeParam(id, pid, v);
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
  // SCREEN on/off (view-only). The GATE itself lives in CubeVizSurface (which
  // also weighs a patched video_out); the card only owns the button.
  let screenOn = $derived(paramVal('screen_on') >= 0.5);
  function toggleScreen(): void { set('screen_on')(screenOn ? 0 : 1); }

  // ───────────────── per-slot wavetable selection (node.data) ─────────────────
  const SLOT_LABEL: Record<CubeSlot, string> = { floor: 'FLOOR', wall: 'WALL', ceiling: 'CEILING' };

  function slotData(slot: CubeSlot): CubeSlotData {
    const d = (node?.data ?? {}) as CubeData;
    return (d[slot] as CubeSlotData | undefined) ?? {};
  }
  // The <select> value MUST equal an existing <option> value or the dropdown
  // renders blank. A loaded preset/file stores source:'user' (+ a label), which
  // matches no factory:/preset: option — so (issue #3) we select the synthetic
  // 'user' option and render it labelled with the stored filename. This mirrors
  // WAVESCULPT's oscSource/oscLabel + `<option value="user">USER · …` pattern,
  // and because it reads straight from node.data it survives a patch reload.
  function slotSelectValue(slot: CubeSlot): string {
    const sd = slotData(slot);
    if (sd.source === 'user') return 'user';
    return sd.source ?? `factory:${CUBE_DEFAULT_TABLES[slot]}`;
  }
  /** Human label of the currently-loaded table for a slot (the loaded filename
   *  for a user table, else the factory table's label). */
  function slotLabel(slot: CubeSlot): string {
    const sd = slotData(slot);
    if (sd.source === 'user') return sd.label ?? 'USER';
    const src = sd.source ?? `factory:${CUBE_DEFAULT_TABLES[slot]}`;
    if (src.startsWith('factory:')) {
      const fid = src.slice('factory:'.length);
      return factoryTables.find((t) => t.id === fid)?.label ?? fid;
    }
    return src;
  }
  let slotStatus = $state<Record<CubeSlot, string | null>>({ floor: null, wall: null, ceiling: null });
  // RELOAD FIX (item #1): the preset <select> gets its OWN selection state that
  // is reset to '' after every load — so re-picking the SAME preset (or a
  // different one) ALWAYS fires `change` (a controlled <select> whose bound
  // value never changes won't re-fire on re-select). The old combined dropdown
  // pinned its value to 'user' after any load, so loading a different table
  // could silently no-op. Mirrors WAVESCULPT's separate preset selector +
  // file-input value reset.
  let presetSelection = $state<Record<CubeSlot, string>>({ floor: '', wall: '', ceiling: '' });

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
    } finally {
      // Reset so the SAME preset can be picked again (re-fires `change`).
      presetSelection[slot] = '';
    }
  }
  function onPresetChange(slot: CubeSlot, ev: Event): void {
    const v = (ev.target as HTMLSelectElement).value;
    if (!v) return;
    void selectPreset(slot, v);
  }
  // File LOAD (item #1): parse a user .wav into the slot, then ALWAYS reset
  // input.value so re-selecting the same/different file fires `change` again.
  async function onSlotFileChange(slot: CubeSlot, ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    slotStatus[slot] = 'parsing…';
    try {
      const buf = await file.arrayBuffer();
      const parsed = parseE352Wav(buf);
      const sd = ensureSlot(slot); if (!sd) return;
      sd.source = 'user';
      sd.frames = framesToPlain(parsed.frames);
      sd.label = file.name.replace(/\.wav$/i, '').toUpperCase().slice(0, 24);
      slotStatus[slot] = `loaded ${parsed.frames.length} frames`;
    } catch (err) {
      slotStatus[slot] = err instanceof Error ? err.message : String(err);
    } finally {
      try { input.value = ''; } catch { /* */ }
    }
  }
  function onSlotChange(slot: CubeSlot, ev: Event): void {
    const sel = ev.target as HTMLSelectElement;
    const v = sel.value;
    if (v === 'user') return; // synthetic option — ignore (keeps the loaded table)
    if (v.startsWith('factory:')) selectFactory(slot, v.slice('factory:'.length));
    else if (v.startsWith('preset:')) void selectPreset(slot, v.slice('preset:'.length));
  }

  // ───────────────── patch panel ports ─────────────────
  const inputs: PortDescriptor[] = [
    { id: 'pitch',    label: 'PITCH',   cable: 'cv' },
    // Polyphonic chord bus (MIDI LANE mode=poly / POLYSEQZ). Gated lanes play
    // simultaneously; unpatched → the mono PITCH path. cable: 'polyPitchGate'.
    { id: 'poly',     label: 'POLY',    cable: 'polyPitchGate' },
    // Mono TRIGGER gate for the per-voice amplitude ADSR. The FIRST note turns
    // CUBE into a gated voice; before any note (and when unpatched) it drones.
    { id: 'trigger',  label: 'TRIG',    cable: 'gate' },
    { id: 'slice_y',  label: 'Y',       cable: 'cv' },
    { id: 'slice_rx', label: 'ROT X',   cable: 'cv' },
    { id: 'slice_ry', label: 'ROT Y',   cable: 'cv' },
    { id: 'slice_rz', label: 'ROT Z',   cable: 'cv' },
    { id: 'morph_fc', label: 'MORPH',   cable: 'cv' },
    { id: 'connect',  label: 'CONNECT', cable: 'cv' },
    { id: 'connect_strength', label: 'CNCT STR', cable: 'cv' },
    { id: 'crush',    label: 'CRUSH',   cable: 'cv' },
    { id: 'space_crush',   label: 'SPC CRUSH', cable: 'cv' },
    { id: 'space_diffuse', label: 'SPC DIFF',  cable: 'cv' },
    { id: 'fold_cv',  label: 'FOLD',    cable: 'cv' },
    { id: 'tune',     label: 'TUNE',    cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'L', label: 'L', cable: 'audio' },
    { id: 'R', label: 'R', cable: 'audio' },
    // SYNC — a pure sine at the playback fundamental, phase-locked to the L/R
    // slice readout. Hard-sync other oscillators to CUBE or use it as a clean
    // reference / sub.
    { id: 'sync', label: 'SYNC', cable: 'audio' },
    { id: 'video_out', label: 'VIDEO', cable: 'mono-video' },
  ];

  const factoryTables = getFactoryTables();

  // Knob descriptor list (driven from the def so ranges/curves stay in sync).
  const KNOBS: Array<{ pid: string; label: string; units?: string }> = [
    { pid: 'tune', label: 'Tune', units: 'st' },
    { pid: 'fine', label: 'Fine', units: '¢' },
    { pid: 'morph_fc', label: 'Morph' },
    { pid: 'connect', label: 'Connect' },
    { pid: 'connect_strength', label: 'Cnct Str' },
    { pid: 'crush', label: 'Crush' },
    { pid: 'space_crush', label: 'Space Crush' },
    { pid: 'space_diffuse', label: 'Space Diffuse' },
    { pid: 'fold', label: 'Fold' },
    { pid: 'spread', label: 'Spread' },
    { pid: 'slice_y', label: 'Y' },
    { pid: 'slice_rx', label: 'Rot X' },
    { pid: 'slice_ry', label: 'Rot Y' },
    { pid: 'slice_rz', label: 'Rot Z' },
    { pid: 'level', label: 'Level' },
  ];
  // ⚠ No 'view_rot_z' knob — the param is gone from the def because `renderGl`
  // never read it (the eye vector uses vrx/vry only and `sceneSig` omitted it,
  // so the knob could not even schedule a repaint). VIDEOCUBE's roll is real
  // and unaffected.
  const VIEW_KNOBS: Array<{ pid: string; label: string }> = [
    { pid: 'view_zoom', label: 'Zoom' },
    { pid: 'view_rot_x', label: 'View X' },
    { pid: 'view_rot_y', label: 'View Y' },
  ];
  // Per-voice amplitude ADSR (per-voice-ADSR feature). A/D/R use a log curve
  // (units s); S is linear 0..1. Driven by the poly lane gates (one envelope per
  // voice) or by the mono TRIG input (lane-0 envelope).
  const ADSR_KNOBS: Array<{ pid: string; label: string; units?: string; curve: 'log' | 'linear' }> = [
    { pid: 'attack',  label: 'A', units: 's', curve: 'log' },
    { pid: 'decay',   label: 'D', units: 's', curve: 'log' },
    { pid: 'sustain', label: 'S', curve: 'linear' },
    { pid: 'release', label: 'R', units: 's', curve: 'log' },
    // BASE VOL — per-voice VCA floor the ADSR rides on top of (gain =
    // base + (1-base)*env). Default 0 = pure ADSR (the envelope owns the note);
    // 1 = full, the env does nothing. Sits right next to the ADSR knobs.
    // The range/default come from the def via minFor/maxFor/defaultFor — never
    // re-type them here (the card-vs-def divergence class in CLAUDE.md).
    { pid: 'base_vol', label: 'Base', curve: 'linear' },
  ];
</script>

<div class="mod-card cube-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="CUBE" />

  <PatchPanel nodeId={id} {inputs} {outputs} panelWidth={360}>
    <div class="cube-body">
      <!-- LEFT column: the 3D viewport (+ SLICE / OUTPUT) and the wavetable
           source selectors. RIGHT column: toggles, knobs, ADSR, view. -->
      <div class="cube-col cube-col-left">
      <!-- Visualization: all THREE views — the 3D cube (headline) on top, the
           2D SLICE cross-section + OUTPUT WAVEFORM side-by-side beneath.
           SHARED with the faceplate hero (cube/CubeVizSurface.svelte). -->
      <CubeVizSurface nodeId={id} vizW={320} vizH={260} sliceW={150} sliceH={120} waveW={162} waveH={120} />

      <!-- Wavetable selectors. The FACTORY dropdown is the steady-state source
           selector (+ the synthetic USER option so a loaded table shows its
           filename and survives reload). The PRESET dropdown + file LOAD button
           are separate (RELOAD FIX, item #1): the preset <select> resets to
           blank after each load and the file <input> resets its value, so
           re-selecting the same OR a different table ALWAYS re-fires `change`. -->
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
              {#each factoryTables as t (t.id)}
                <option value={`factory:${t.id}`}>{t.label}</option>
              {/each}
              <!-- Synthetic option so a loaded user table (source:'user') has a
                   matching <option> + the dropdown shows its filename (issue #3,
                   persists across reload since it reads node.data). -->
              {#if slotSelectValue(slot) === 'user'}
                <option value="user">USER · {slotLabel(slot)}</option>
              {/if}
            </select>
            <select
              class="wt-select preset-select"
              value={presetSelection[slot]}
              onchange={(ev) => onPresetChange(slot, ev)}
              data-testid={`cube-${slot}-preset-select`}
            >
              <option value="">— preset —</option>
              {#each WAVETABLE_PRESETS as p (p.id)}
                <option value={p.id}>{p.label}</option>
              {/each}
            </select>
            <label class="upload-btn" data-testid={`cube-${slot}-load`}>
              <input
                type="file"
                accept=".wav,audio/wav"
                onchange={(ev) => onSlotFileChange(slot, ev)}
              />
              <span>LOAD</span>
            </label>
            {#if slotStatus[slot]}
              <span class="wt-status">{slotStatus[slot]}</span>
            {/if}
          </div>
        {/each}
      </div>
      </div>

      <div class="cube-col cube-col-right">
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
        <button
          class="toggle"
          class:on={screenOn}
          onclick={toggleScreen}
          data-testid="cube-screen-toggle"
          title="SCREEN: turn the 3D viz OFF to save performance. When OFF and VIDEO is unpatched, ALL visual computation is skipped (audio keeps running)."
        >SCRN: {screenOn ? 'ON' : 'OFF'}</button>
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

      <!-- Per-voice amplitude ADSR (poly lane gates / mono TRIG) -->
      <div class="adsr-section">
        <div class="adsr-head">AMP ADSR</div>
        <div class="knobs adsr-knobs">
          {#each ADSR_KNOBS as k (k.pid)}
            <Knob
              value={paramVal(k.pid)}
              min={minFor(k.pid)}
              max={maxFor(k.pid)}
              defaultValue={defaultFor(k.pid)}
              label={k.label}
              units={k.units}
              curve={k.curve}
              onchange={set(k.pid)}
              moduleId={id}
              paramId={k.pid}
              readLive={live(k.pid)}
            />
          {/each}
        </div>
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
    </div>
  </PatchPanel>
</div>

<style>
  .cube-card {
    width: 360px;
    background: var(--cube-bg, #12141b);
    color: #ece8e2;
  }
  /* 2-column layout for the wide (4hp) rack box: viewport + sources on the
     left, controls on the right. */
  .cube-body { padding: 6px 10px 8px; display: flex; flex-direction: row; gap: 14px; align-items: flex-start; }
  .cube-col { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  .cube-col-left { flex: 0 0 auto; }
  .cube-col-right { flex: 1 1 340px; min-width: 320px; }
  .wt-selects { display: flex; flex-direction: column; gap: 4px; }
  .wt-row { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
  .wt-label {
    font-family: var(--font-mono, monospace);
    font-size: 0.6rem; letter-spacing: 0.04em; color: #9fb6c9;
    width: 52px; flex: none;
  }
  .wt-select {
    flex: 1; min-width: 80px; font-size: 0.62rem; background: #1b1f29; color: #ece8e2;
    border: 1px solid rgba(255,255,255,0.12); border-radius: 3px; padding: 2px 4px;
  }
  .preset-select { flex: 0 1 96px; min-width: 70px; }
  .upload-btn {
    flex: none; display: inline-flex; align-items: center; cursor: pointer;
    font-family: var(--font-mono, monospace); font-size: 0.55rem; color: #9fb6c9;
    background: #1b1f29; border: 1px solid rgba(255,255,255,0.14);
    border-radius: 3px; padding: 2px 6px;
  }
  .upload-btn input[type='file'] { display: none; }
  .upload-btn:hover { background: #232838; color: #d9f4ff; }
  .wt-status { font-size: 0.52rem; color: #7fd6a0; white-space: nowrap; max-width: 100%; overflow: hidden; text-overflow: ellipsis; flex-basis: 100%; }
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
  .adsr-section { border-top: 1px solid rgba(255,255,255,0.08); padding-top: 6px; }
  .adsr-head { font-family: var(--font-mono, monospace); font-size: 0.55rem; letter-spacing: 0.04em; color: #8294a4; margin-bottom: 4px; }
  .adsr-knobs { gap: 12px; }
</style>
