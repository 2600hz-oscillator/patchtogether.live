<script lang="ts">
  // VideocubeCard — UI for VIDEOCUBE (the video isomorph of the audio CUBE).
  //
  // 2-column body (mirrors CubeCard): LEFT = the video_out live preview + the 3
  // frametable SLOT pickers (LIVE input / LOAD a .frametable.png file); RIGHT =
  // the WRAP / MATERIAL / SCREEN toggles, the global READER row (SMOOTH/MORPH/
  // CHAOS + FREEZE + LIVE) and the CUBE knob bank. Every knob drives BOTH the
  // picture (the GL combine) and the derived audio drone. The card stays a
  // Canvas2D previewer (NO WebGL here) so it is OUT of the WebGL attest basis.
  // All jacks live on the yellow drill-down PATCH PANEL.
  import { onMount, onDestroy } from 'svelte';
  import { type NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { setNodeParam } from '$lib/graph/mutate';
  import { videocubeDef } from '$lib/video/modules/videocube';
  import {
    VIDEOCUBE_MODE_SMOOTH,
    VIDEOCUBE_MODE_MORPH,
    VIDEOCUBE_MODE_CHAOS,
  } from '$lib/video/videocube-core';
  import { atlasGeometry, FRAMETABLE_FILE_ACCEPT, FRAMETABLE_ATLAS_COLS, FRAMETABLE_ATLAS_ROWS } from '$lib/video/frametable-atlas';
  import type { VideoEngine } from '$lib/video/engine';
  import { VIDEO_RES } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  type Slot = 'a' | 'b' | 'c';
  const SLOTS: readonly Slot[] = ['a', 'b', 'c'];
  const SLOT_LABEL: Record<Slot, string> = { a: 'FLOOR', b: 'WALL', c: 'CEIL' };

  function p(name: string): number {
    const def = videocubeDef.params.find((d) => d.id === name);
    return node?.params[name] ?? def?.defaultValue ?? 0;
  }
  function pmin(name: string): number { return videocubeDef.params.find((d) => d.id === name)!.min; }
  function pmax(name: string): number { return videocubeDef.params.find((d) => d.id === name)!.max; }
  function pdef(name: string): number { return videocubeDef.params.find((d) => d.id === name)!.defaultValue; }
  function punits(name: string): string | undefined { return videocubeDef.params.find((d) => d.id === name)!.units; }
  function set(paramId: string) { return (v: number) => setNodeParam(id, paramId, v); }

  // The CUBE knob bank (same order as CubeCard's KNOBS).
  const KNOBS: Array<{ pid: string; label: string }> = [
    { pid: 'tune', label: 'Tune' },
    { pid: 'fine', label: 'Fine' },
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

  // ── Toggles ──
  let wrapOn = $derived(p('wrap') >= 0.5);
  let materialHard = $derived(p('material') >= 0.5);
  let screenOn = $derived(p('screen_on') >= 0.5);
  function toggleWrap() { setNodeParam(id, 'wrap', wrapOn ? 0 : 1); }
  function toggleMaterial() { setNodeParam(id, 'material', materialHard ? 0 : 1); }
  function toggleScreen() { setNodeParam(id, 'screen_on', screenOn ? 0 : 1); }

  // ── Reader mode (global, all 3 rings) + FREEZE + LIVE ──
  const MODES = [
    { v: VIDEOCUBE_MODE_SMOOTH, label: 'SMOOTH' },
    { v: VIDEOCUBE_MODE_MORPH, label: 'MORPH' },
    { v: VIDEOCUBE_MODE_CHAOS, label: 'CHAOS' },
  ] as const;
  let mode = $derived(Math.round(p('reader_mode')));
  function pickMode(v: number) { setNodeParam(id, 'reader_mode', v); }
  let freezeOn = $derived(p('freeze') >= 0.5);
  let liveOn = $derived(p('live') >= 0.5);
  function toggleFreeze() { setNodeParam(id, 'freeze', freezeOn ? 0 : 1); }
  function toggleLive() { setNodeParam(id, 'live', liveOn ? 0 : 1); }

  // ── Video engine access (FrametableCard pattern). ──
  function getVideoEngine(): VideoEngine | null {
    const e = engineCtx.get();
    if (!e) return null;
    try { return e.getDomain<VideoEngine>('video') ?? null; }
    catch { return null; }
  }

  // ── Per-slot ingest: LIVE input vs LOAD a .frametable.png (session-only v1). ──
  let slotStatus = $state<Record<Slot, string | null>>({ a: null, b: null, c: null });
  let slotError = $state<Record<Slot, string | null>>({ a: null, b: null, c: null });

  function setLive(slot: Slot): void {
    const ve = getVideoEngine();
    if (!ve) return;
    // A tiny tagged clear element resets the factory's slot back to LIVE capture.
    const c = document.createElement('canvas');
    c.width = 1; c.height = 1;
    c.dataset.videocubeSlot = slot;
    c.dataset.videocubeClear = '1';
    ve.attachExternalSource(id, 'image', c);
    slotStatus[slot] = 'live';
    slotError[slot] = null;
  }

  async function onSlotFileChange(slot: Slot, ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    slotError[slot] = null;
    slotStatus[slot] = 'loading...';
    try {
      const bmp = await createImageBitmap(file);
      const geo = atlasGeometry(bmp.width, bmp.height);
      if (!geo.valid) {
        bmp.close?.();
        throw new Error(`not a ${FRAMETABLE_ATLAS_COLS}×${FRAMETABLE_ATLAS_ROWS} frametable atlas`);
      }
      const ve = getVideoEngine();
      if (!ve) throw new Error('video engine not ready');
      const c = document.createElement('canvas');
      c.width = bmp.width; c.height = bmp.height;
      const cx = c.getContext('2d');
      if (!cx) throw new Error('no 2d context');
      cx.drawImage(bmp, 0, 0);
      c.dataset.videocubeSlot = slot;
      ve.attachExternalSource(id, 'image', c);
      bmp.close?.();
      slotStatus[slot] = `file · ${geo.frames}f`;
    } catch (err) {
      slotError[slot] = err instanceof Error ? err.message : String(err);
      slotStatus[slot] = null;
    } finally {
      try { input.value = ''; } catch { /* */ }
    }
  }

  // ── Live preview of video_out (canonical surface.texture). ──
  const ENGINE_W = VIDEO_RES.width;
  const ENGINE_H = VIDEO_RES.height;
  let canvasEl: HTMLCanvasElement | null = $state(null);
  let rafId: number | null = null;

  function draw() {
    rafId = null;
    const e = engineCtx.get();
    if (!e || !canvasEl) { rafId = requestAnimationFrame(draw); return; }
    let videoEngine: VideoEngine | undefined;
    try { videoEngine = e.getDomain<VideoEngine>('video'); }
    catch { rafId = requestAnimationFrame(draw); return; }
    if (!videoEngine) { rafId = requestAnimationFrame(draw); return; }
    const ctx2d = canvasEl.getContext('2d', { alpha: false });
    if (ctx2d) {
      try { videoEngine.blitOutputToDrawingBuffer(id); } catch { /* never nuke the rAF loop */ }
      const src = videoEngine.canvas as CanvasImageSource;
      const cw = canvasEl.width, ch = canvasEl.height;
      ctx2d.fillStyle = '#050608';
      ctx2d.fillRect(0, 0, cw, ch);
      const srcAspect = ENGINE_W / ENGINE_H;
      const dstAspect = cw / ch;
      let w = cw, h = ch, x = 0, y = 0;
      if (dstAspect > srcAspect) { h = ch; w = Math.round(h * srcAspect); x = Math.round((cw - w) / 2); }
      else { w = cw; h = Math.round(w / srcAspect); y = Math.round((ch - h) / 2); }
      ctx2d.drawImage(src, x, y, w, h);
    }
    rafId = requestAnimationFrame(draw);
  }

  onMount(() => { rafId = requestAnimationFrame(draw); });
  onDestroy(() => { if (rafId !== null) cancelAnimationFrame(rafId); });

  const inputs = portsFromDef(videocubeDef.inputs, {
    video_a: 'A', video_b: 'B', video_c: 'C',
    morph_cv: 'MORPH', connect_cv: 'CONNECT', connect_strength_cv: 'CNCT STR',
    crush_cv: 'CRUSH', space_crush_cv: 'SPC CRUSH', space_diffuse_cv: 'SPC DIFF',
    slice_y_cv: 'Y', slice_rx_cv: 'ROT X', slice_ry_cv: 'ROT Y', slice_rz_cv: 'ROT Z',
    fold_cv: 'FOLD', spread_cv: 'SPREAD', tune_cv: 'TUNE',
  });
  const outputs = portsFromDef(videocubeDef.outputs, { video_out: 'VIDEO', audio_out: 'AUDIO' });
</script>

<div class="vcard card video" data-testid="videocube-card" data-node-id={id}>
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="VIDEOCUBE" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="vc-body">
      <!-- LEFT: preview + 3 slot pickers -->
      <div class="vc-col vc-left">
        <div class="preview-wrap">
          <canvas
            bind:this={canvasEl}
            width={200}
            height={150}
            data-testid="videocube-preview"
            data-node-id={id}
          ></canvas>
        </div>

        <div class="slots">
          {#each SLOTS as slot (slot)}
            <div class="slot-row" data-testid={`videocube-${slot}-select`}>
              <span class="slot-label">{SLOT_LABEL[slot]}</span>
              <button
                type="button"
                class="vc-btn nodrag"
                data-testid={`videocube-${slot}-live`}
                title="Use the connected LIVE video input for this slot"
                onclick={() => setLive(slot)}
              >LIVE</button>
              <label class="vc-btn nodrag file-load" data-testid={`videocube-${slot}-load`}
                title="Load a .frametable.png atlas into this slot (session-only in v1)">
                <input type="file" accept={FRAMETABLE_FILE_ACCEPT}
                  onchange={(ev) => onSlotFileChange(slot, ev)}
                  data-testid={`videocube-${slot}-file-input`} />
                <span>Load…</span>
              </label>
              {#if slotStatus[slot]}<span class="slot-status">{slotStatus[slot]}</span>{/if}
              {#if slotError[slot]}<span class="slot-error">{slotError[slot]}</span>{/if}
            </div>
          {/each}
        </div>
      </div>

      <!-- RIGHT: toggles + reader + knob bank -->
      <div class="vc-col vc-right">
        <div class="toggles">
          <button class="toggle nodrag" class:on={wrapOn} onclick={toggleWrap}
            data-testid="videocube-wrap-toggle"
            title="WRAP: clamp edges (off) or mirror-fold coords (on)">WRAP: {wrapOn ? 'ON' : 'OFF'}</button>
          <button class="toggle nodrag" class:on={materialHard} onclick={toggleMaterial}
            data-testid="videocube-material-toggle"
            title="MATERIAL: SMOOTH blend or HARD one-table-wins mosaic">MAT: {materialHard ? 'HARD' : 'SMOOTH'}</button>
          <button class="toggle nodrag" class:on={screenOn} onclick={toggleScreen}
            data-testid="videocube-screen-toggle"
            title="SCREEN: skip the combine render when off + video unpatched">SCRN: {screenOn ? 'ON' : 'OFF'}</button>
        </div>

        <div class="reader-row" data-testid="videocube-reader">
          {#each MODES as m (m.v)}
            <button type="button" class="vc-btn nodrag seg" class:on={mode === m.v}
              data-testid={`videocube-reader-${m.label.toLowerCase()}`}
              onclick={() => pickMode(m.v)}>{m.label}</button>
          {/each}
        </div>
        <div class="reader-row">
          <button type="button" class="vc-btn nodrag" class:on={freezeOn}
            data-testid="videocube-freeze" onclick={toggleFreeze}>{freezeOn ? 'FROZEN' : 'FREEZE'}</button>
          <button type="button" class="vc-btn nodrag" class:on={liveOn}
            data-testid="videocube-live" onclick={toggleLive}>{liveOn ? 'LIVE!' : 'LIVE'}</button>
        </div>

        <div class="knobs">
          {#each KNOBS as k (k.pid)}
            <Knob
              value={p(k.pid)}
              min={pmin(k.pid)}
              max={pmax(k.pid)}
              defaultValue={pdef(k.pid)}
              label={k.label}
              units={punits(k.pid)}
              curve="linear"
              onchange={set(k.pid)}
              moduleId={id}
              paramId={k.pid}
            />
          {/each}
        </div>
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .card {
    width: 540px;
    min-height: 260px;
    padding-bottom: 8px;
  }
  .vc-body {
    display: flex;
    gap: 10px;
    padding: 6px 12px 0;
  }
  .vc-col { display: flex; flex-direction: column; gap: 8px; }
  .vc-left { flex: 0 0 210px; }
  .vc-right { flex: 1 1 auto; min-width: 0; }
  .preview-wrap {
    width: 200px;
    display: flex;
    justify-content: center;
  }
  .preview-wrap canvas {
    width: 200px;
    height: 150px;
    background: #050608;
    border: 1px solid var(--cable-video, #3aa);
    border-radius: 1px;
    display: block;
  }
  .slots { display: flex; flex-direction: column; gap: 5px; }
  .slot-row {
    display: flex;
    align-items: center;
    gap: 5px;
    flex-wrap: wrap;
  }
  .slot-label {
    font-size: 0.55rem;
    letter-spacing: 0.06em;
    color: var(--text-dim);
    width: 42px;
    font-family: ui-monospace, monospace;
  }
  .vc-btn {
    background: var(--module-bg);
    color: var(--text-dim);
    border: 1px solid var(--border);
    border-radius: 3px;
    font-size: 0.55rem;
    letter-spacing: 0.06em;
    padding: 4px 6px;
    cursor: pointer;
    font-family: ui-monospace, monospace;
    touch-action: none;
    user-select: none;
  }
  .vc-btn:hover { border-color: var(--accent-dim); }
  .vc-btn.on {
    background: var(--accent-dim, #46506b);
    color: var(--text);
    border-color: var(--accent, #6884d7);
  }
  .file-load { display: inline-flex; align-items: center; justify-content: center; }
  .file-load input[type='file'] { display: none; }
  .slot-status, .slot-error {
    font-size: 0.5rem;
    font-family: ui-monospace, monospace;
    letter-spacing: 0.03em;
    width: 100%;
    word-break: break-word;
  }
  .slot-status { color: var(--text-dim); }
  .slot-error { color: var(--cable-video, #e66); }
  .toggles { display: flex; gap: 5px; }
  .toggle {
    flex: 1;
    background: var(--module-bg);
    color: var(--text-dim);
    border: 1px solid var(--border);
    border-radius: 3px;
    font-size: 0.52rem;
    letter-spacing: 0.04em;
    padding: 4px 2px;
    cursor: pointer;
    font-family: ui-monospace, monospace;
  }
  .toggle:hover { border-color: var(--accent-dim); }
  .toggle.on {
    background: var(--accent-dim, #46506b);
    color: var(--text);
    border-color: var(--accent, #6884d7);
  }
  .reader-row { display: flex; gap: 5px; }
  .reader-row .vc-btn { flex: 1; text-align: center; }
  .reader-row .seg { font-size: 0.52rem; padding: 4px 2px; }
  .knobs {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 4px 6px;
    margin-top: 2px;
  }
</style>
