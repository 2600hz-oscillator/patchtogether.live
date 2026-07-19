<script lang="ts">
  // FrametableCard — UI for FRAMETABLE (video wavetable oscillator, 3-mode rework).
  //
  // ONE video input → ONE video output. A faceplate MODE selector picks the render
  // engine (SMOOTH default / MORPH / CHAOS). SMOOTH shows two X-Y pads (per-axis
  // waveform freq × amt) with a shape knob under each; CHAOS shows SHIMMER + SHAPE
  // faders; MORPH shows a hint (its only controls are the shared MORPH/SPREAD).
  // CHAOS is a momentary switch (overrides the selector while held); LIVE is a
  // latching switch that forces real-time (no lag) in any mode. FREEZE holds the
  // ring; SAVE snapshots it. Shared MORPH/SPREAD faders. A live preview of
  // video_out is shown (the Cellshade/Mirrorpool blit). All jacks live in the
  // yellow drill-down PATCH PANEL (no raw side ports). The card hides the
  // inactive mode's extras so each mode fits the card bounds (no control overflow).
  import { onMount, onDestroy } from 'svelte';
  import { type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { setNodeParam } from '$lib/graph/mutate';
  import { patch } from '$lib/graph/store';
  import { frametableDef } from '$lib/video/modules/frametable';
  import {
    FRAMETABLE_MODE_SMOOTH,
    FRAMETABLE_MODE_MORPH,
    FRAMETABLE_MODE_CHAOS,
  } from '$lib/video/frametable-core';
  import {
    FRAMETABLE_ATLAS_COLS,
    FRAMETABLE_ATLAS_ROWS,
    FRAMETABLE_ATLAS_TILES,
    FRAMETABLE_FILE_ACCEPT,
    tileRect,
    atlasGeometry,
    atlasDimensions,
    flipRowsY,
    frametableFileName,
  } from '$lib/video/frametable-atlas';
  import {
    newFrametableFileId,
    putFrametableBlob,
    getFrametableBlob,
    type FrametableFileMeta,
  } from '$lib/video/frametable-file-store';
  import { canSaveViaPicker } from '$lib/video/recorderbox-store';
  import type { VideoEngine } from '$lib/video/engine';
  import { VIDEO_RES } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  function p(name: string): number {
    const def = frametableDef.params.find((d) => d.id === name);
    return node?.params[name] ?? def?.defaultValue ?? 0;
  }
  function pdef(name: string): number { return frametableDef.params.find((d) => d.id === name)!.defaultValue; }
  function pmin(name: string): number { return frametableDef.params.find((d) => d.id === name)!.min; }
  function pmax(name: string): number { return frametableDef.params.find((d) => d.id === name)!.max; }
  function setParam(paramId: string) { return (v: number) => setNodeParam(id, paramId, v); }

  // --- MODE selector (3-segment: SMOOTH | MORPH | CHAOS). Discrete param. ---
  const MODES = [
    { v: FRAMETABLE_MODE_SMOOTH, label: 'SMOOTH', key: 'smooth' },
    { v: FRAMETABLE_MODE_MORPH, label: 'MORPH', key: 'morph' },
    { v: FRAMETABLE_MODE_CHAOS, label: 'CHAOS', key: 'chaos' },
  ] as const;
  let mode = $derived(Math.round(p('mode')));
  function pickMode(v: number) { setNodeParam(id, 'mode', v); }

  // --- FREEZE toggle button drives `freeze` (OR'd with the freeze gate by the engine). ---
  let freezeOn = $derived(p('freeze') >= 0.5);
  function toggleFreeze() { setNodeParam(id, 'freeze', freezeOn ? 0 : 1); }

  // --- LIVE latching switch → forces real-time (no lag) in any mode. ---
  let liveOn = $derived(p('live') >= 0.5);
  function toggleLive() { setNodeParam(id, 'live', liveOn ? 0 : 1); }

  // --- CHAOS momentary switch → overrides the selector to CHAOS while held. ---
  let chaosHeld = $derived(p('chaos') >= 0.5);
  function chaosDown(ev: PointerEvent) {
    (ev.currentTarget as HTMLElement).setPointerCapture?.(ev.pointerId);
    setNodeParam(id, 'chaos', 1);
    ev.preventDefault();
  }
  function chaosUp(ev: PointerEvent) {
    setNodeParam(id, 'chaos', 0);
    try { (ev.currentTarget as HTMLElement).releasePointerCapture?.(ev.pointerId); } catch { /* */ }
  }

  // --- SAVE momentary: rising edge the engine snapshots on, then reset shortly. ---
  let savedFlash = $state(false);
  let saveResetTimer: ReturnType<typeof setTimeout> | null = null;
  let saveFlashTimer: ReturnType<typeof setTimeout> | null = null;
  function doSave() {
    setNodeParam(id, 'saveTrig', 1);
    savedFlash = true;
    if (saveResetTimer) clearTimeout(saveResetTimer);
    if (saveFlashTimer) clearTimeout(saveFlashTimer);
    saveResetTimer = setTimeout(() => setNodeParam(id, 'saveTrig', 0), 140);
    saveFlashTimer = setTimeout(() => { savedFlash = false; }, 600);
  }

  // ═══ FILE SAVE / LOAD — real `.frametable.png` atlas files (the wavetable ═══
  //     workflow). Separate from the in-GPU SAVE slot above (doSave): that feeds
  //     the VideoCube + save-trigger jack and dies on reload; THIS writes/reads a
  //     real 60-frame PNG sprite-sheet to disk + IndexedDB (survives reload).
  let fileStatus = $state<string | null>(null);
  let fileError = $state<string | null>(null);
  let savingFile = $state(false);
  // A card-held atlas canvas kept alive until the factory's next draw() detiles it.
  let loadCanvasEl: HTMLCanvasElement | null = null;
  // The file id already detiled into the GPU ring — guards the mount $effect from
  // re-hydrating a table we just loaded/saved locally this session.
  let hydratedId: string | null = null;

  function getVideoEngine(): VideoEngine | null {
    const e = engineCtx.get();
    if (!e) return null;
    try { return e.getDomain<VideoEngine>('video') ?? null; }
    catch { return null; }
  }
  async function waitForVideoEngine(timeoutMs = 4000): Promise<VideoEngine | null> {
    const start = Date.now();
    for (;;) {
      const ve = getVideoEngine();
      if (ve) return ve;
      if (Date.now() - start > timeoutMs) return null;
      await new Promise((r) => setTimeout(r, 80));
    }
  }

  // The tiny persisted descriptor (id + geometry, ~120 bytes) — the ONLY thing
  // that touches node.data / the Y.Doc. The 45 MiB of frames live in IndexedDB.
  let ftFile = $derived((node?.data as { frametableFile?: FrametableFileMeta } | undefined)?.frametableFile);

  function writeFileMeta(meta: FrametableFileMeta): void {
    const target = patch.nodes[id];
    if (!target) return;
    if (!target.data) target.data = {};
    (target.data as Record<string, unknown>).frametableFile = meta;
  }

  // Forward the decoded atlas to the factory via the CAMERA/VIDEOBOX external-
  // source channel (so engine.ts stays untouched) + FREEZE so the loaded table
  // is held for morph/scan (capture would gradually overwrite it otherwise).
  function uploadAtlas(ve: VideoEngine, bmp: ImageBitmap): void {
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const cx = c.getContext('2d');
    if (!cx) return;
    cx.drawImage(bmp, 0, 0);
    loadCanvasEl = c; // keep alive until the next draw() detiles it
    ve.attachExternalSource(id, 'image', c);
    setNodeParam(id, 'freeze', 1);
  }

  // File input onchange — decode + validate + upload + persist (mirrors WAVECEL).
  async function onFrametableFileChange(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    fileError = null;
    fileStatus = 'loading...';
    try {
      const bmp = await createImageBitmap(file);
      const geo = atlasGeometry(bmp.width, bmp.height);
      if (!geo.valid) {
        bmp.close?.();
        throw new Error(`not a ${FRAMETABLE_ATLAS_COLS}×${FRAMETABLE_ATLAS_ROWS} frametable atlas (${bmp.width}×${bmp.height})`);
      }
      const ve = getVideoEngine();
      if (!ve) throw new Error('video engine not ready');
      uploadAtlas(ve, bmp);
      bmp.close?.();
      // Persist the PNG bytes to THIS browser's IndexedDB (NEVER the Y.Doc), and
      // stamp only the tiny descriptor into node.data so it survives reload.
      const fid = newFrametableFileId();
      const meta: FrametableFileMeta = {
        id: fid, name: file.name, cols: geo.cols, rows: geo.rows,
        tileW: geo.tileW, tileH: geo.tileH, frames: geo.frames, size: file.size,
      };
      await putFrametableBlob(fid, file, file.name);
      hydratedId = fid;          // we just detiled it → the $effect must not redo it
      writeFileMeta(meta);
      fileStatus = `loaded ${geo.frames} frames ${geo.tileW}×${geo.tileH}`;
    } catch (err) {
      fileError = err instanceof Error ? err.message : String(err);
      fileStatus = null;
    } finally {
      try { input.value = ''; } catch { /* */ }
    }
  }

  // Save-to-disk — read the 60 ring layers back, tile into a PNG atlas, then
  // showSaveFilePicker (Chromium) / <a download> (Firefox/Safari). Also persists
  // to IndexedDB so the saved table survives reload even before a re-load.
  async function doSaveFile() {
    if (savingFile) return;
    savingFile = true;
    fileError = null;
    fileStatus = 'saving...';
    try {
      const ve = getVideoEngine();
      if (!ve) throw new Error('video engine not ready');
      const rb = ve.read(id, 'ringReadback') as
        | { w: number; h: number; layers: number; chrono: Uint8Array[] }
        | undefined;
      if (!rb || !rb.chrono || rb.chrono.length < FRAMETABLE_ATLAS_TILES) throw new Error('ring not ready');
      const blob = await encodeAtlasBlob(rb.w, rb.h, rb.chrono);
      if (!blob) throw new Error('PNG encode failed');
      const name = frametableFileName();
      await saveBlobToDisk(blob, name);
      const fid = newFrametableFileId();
      await putFrametableBlob(fid, blob, name);
      hydratedId = fid; // the current ring already IS this table
      writeFileMeta({
        id: fid, name, cols: FRAMETABLE_ATLAS_COLS, rows: FRAMETABLE_ATLAS_ROWS,
        tileW: rb.w, tileH: rb.h, frames: FRAMETABLE_ATLAS_TILES, size: blob.size,
      });
      fileStatus = `saved ${name}`;
    } catch (err) {
      // AbortError = the user cancelled the picker — not an error to surface.
      if (err instanceof DOMException && err.name === 'AbortError') fileStatus = null;
      else fileError = err instanceof Error ? err.message : String(err);
    } finally {
      savingFile = false;
    }
  }

  // Tile the chronological readback into an UPRIGHT PNG atlas (flip each
  // bottom-origin readback tile). Pure canvas — NO codec (CI/SwiftShader-safe).
  function encodeAtlasBlob(w: number, h: number, chrono: Uint8Array[]): Promise<Blob | null> {
    const { width, height } = atlasDimensions(w, h);
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const cx = canvas.getContext('2d');
    if (!cx) return Promise.resolve(null);
    for (let c = 0; c < FRAMETABLE_ATLAS_TILES; c++) {
      const src = chrono[c];
      if (!src || src.length < w * h * 4) continue;
      const upright = flipRowsY(src, w, h); // GL bottom-origin → top-origin (upright)
      const img = new ImageData(upright, w, h);
      const { sx, sy } = tileRect(c, w, h);
      cx.putImageData(img, sx, sy);
    }
    return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
  }

  async function saveBlobToDisk(blob: Blob, name: string): Promise<void> {
    if (canSaveViaPicker()) {
      const picker = (globalThis as unknown as {
        showSaveFilePicker: (o: unknown) => Promise<{ createWritable: () => Promise<{ write: (b: Blob) => Promise<void>; close: () => Promise<void> }> }>;
      }).showSaveFilePicker;
      try {
        const handle = await picker({
          suggestedName: name,
          types: [{ description: 'FrameTable atlas', accept: { 'image/png': ['.frametable.png', '.png'] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return;
      } catch (err) {
        // User cancel bubbles up (handled by the caller); other picker failures
        // fall through to the <a download> blob path.
        if (err instanceof DOMException && err.name === 'AbortError') throw err;
      }
    }
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url; a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  // Re-hydrate on mount / patch-load (or when a peer loads a file): pull the PNG
  // bytes from THIS browser's IndexedDB by id, decode, detile back into the ring.
  // A peer WITHOUT the local copy gets null → the file input stays as the re-load
  // drop-zone (the VIDEOBOX "peers without a local copy show the placeholder").
  async function hydrateFromStore(fileId: string): Promise<void> {
    if (hydratedId === fileId) return;
    try {
      const rec = await getFrametableBlob(fileId);
      if (!rec) return; // no local copy — leave the re-load control
      const bmp = await createImageBitmap(rec.blob);
      const geo = atlasGeometry(bmp.width, bmp.height);
      if (!geo.valid) { bmp.close?.(); return; }
      const ve = await waitForVideoEngine();
      if (!ve) { bmp.close?.(); return; }
      hydratedId = fileId;
      uploadAtlas(ve, bmp);
      bmp.close?.();
      fileStatus = `restored ${rec.name}`;
    } catch { /* best-effort re-hydrate; leave the re-load control on failure */ }
  }

  $effect(() => {
    const fid = ftFile?.id;
    if (fid && fid !== hydratedId) void hydrateFromStore(fid);
  });

  // --- Live preview of video_out (the canonical surface.texture). ---
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
      const cw = canvasEl.width;
      const ch = canvasEl.height;
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
  onDestroy(() => {
    if (rafId !== null) cancelAnimationFrame(rafId);
    if (padRaf !== null) cancelAnimationFrame(padRaf);
    if (saveResetTimer) clearTimeout(saveResetTimer);
    if (saveFlashTimer) clearTimeout(saveFlashTimer);
  });

  const inputs = portsFromDef(frametableDef.inputs, {
    video_in: 'IN',
    morph_cv: 'MORPH',
    spread_cv: 'SPREAD',
    shimmer_cv: 'SHIMMER',
    weightShape_cv: 'SHAPE',
    waveFreqX_cv: 'X FREQ',
    waveAmtX_cv: 'X AMT',
    waveShapeX_cv: 'X SHP',
    waveFreqY_cv: 'Y FREQ',
    waveAmtY_cv: 'Y AMT',
    waveShapeY_cv: 'Y SHP',
    freeze_gate: 'FREEZE',
    save_trig: 'SAVE',
    chaos_gate: 'CHAOS',
    live_gate: 'LIVE',
  });
  const outputs = portsFromDef(frametableDef.outputs, { video_out: 'OUT' });

  // ---- X-Y pad plumbing (MIRRORPOOL pattern, range-aware, rAF-coalesced) ----
  const PAD_PX = 80;

  function valFrac(paramId: string, v: number): number {
    const lo = pmin(paramId), hi = pmax(paramId);
    return hi > lo ? Math.max(0, Math.min(1, (v - lo) / (hi - lo))) : 0.5;
  }
  function fracVal(paramId: string, f: number): number {
    const lo = pmin(paramId), hi = pmax(paramId);
    return lo + Math.max(0, Math.min(1, f)) * (hi - lo);
  }

  // Coalesced, undoable two-param commit — batch both axes into ONE write per
  // animation frame so a drag doesn't store-write-storm the live video sim.
  let padRaf: number | null = null;
  let padPending: Array<[string, number]> | null = null;
  function commitPad(a: [string, number], b: [string, number]): void {
    padPending = [a, b];
    if (padRaf === null) padRaf = requestAnimationFrame(flushPad);
  }
  function flushPad(): void {
    if (padRaf !== null) { cancelAnimationFrame(padRaf); padRaf = null; }
    const pend = padPending;
    padPending = null;
    if (!pend) return;
    for (const [k, v] of pend) setNodeParam(id, k, v);
  }
  function padFrac(el: HTMLDivElement, ev: PointerEvent): { fx: number; fy: number } {
    const rect = el.getBoundingClientRect();
    return {
      fx: Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width)),
      fy: Math.max(0, Math.min(1, (ev.clientY - rect.top) / rect.height)),
    };
  }

  // Pad X — X-axis waveform: pad-X = waveFreqX, pad-Y = waveAmtX (top = more amt).
  let padXEl: HTMLDivElement | null = $state(null);
  let draggingX = $state(false);
  let dragFreqX = $state<number | null>(null);
  let dragAmtX = $state<number | null>(null);
  let freqXVal = $derived(draggingX && dragFreqX !== null ? dragFreqX : p('waveFreqX'));
  let amtXVal = $derived(draggingX && dragAmtX !== null ? dragAmtX : p('waveAmtX'));
  let dotXx = $derived(valFrac('waveFreqX', freqXVal) * PAD_PX);
  let dotXy = $derived((1 - valFrac('waveAmtX', amtXVal)) * PAD_PX);
  function writeX(fx: number, fy: number): void {
    const freq = fracVal('waveFreqX', fx);
    const amt = fracVal('waveAmtX', 1 - fy);
    dragFreqX = freq; dragAmtX = amt;
    commitPad(['waveFreqX', freq], ['waveAmtX', amt]);
  }
  function xDown(ev: PointerEvent): void {
    if (!padXEl) return;
    draggingX = true;
    padXEl.setPointerCapture(ev.pointerId);
    const { fx, fy } = padFrac(padXEl, ev);
    writeX(fx, fy);
    ev.preventDefault(); ev.stopPropagation();
  }
  function xMove(ev: PointerEvent): void {
    if (!draggingX || !padXEl) return;
    const { fx, fy } = padFrac(padXEl, ev);
    writeX(fx, fy);
  }
  function xUp(ev: PointerEvent): void {
    if (!draggingX) return;
    flushPad();
    draggingX = false; dragFreqX = null; dragAmtX = null;
    try { padXEl?.releasePointerCapture(ev.pointerId); } catch { /* */ }
  }
  function xReset(): void {
    commitPad(['waveFreqX', pdef('waveFreqX')], ['waveAmtX', pdef('waveAmtX')]);
    flushPad();
  }

  // Pad Y — Y-axis waveform: pad-X = waveFreqY, pad-Y = waveAmtY.
  let padYEl: HTMLDivElement | null = $state(null);
  let draggingY = $state(false);
  let dragFreqY = $state<number | null>(null);
  let dragAmtY = $state<number | null>(null);
  let freqYVal = $derived(draggingY && dragFreqY !== null ? dragFreqY : p('waveFreqY'));
  let amtYVal = $derived(draggingY && dragAmtY !== null ? dragAmtY : p('waveAmtY'));
  let dotYx = $derived(valFrac('waveFreqY', freqYVal) * PAD_PX);
  let dotYy = $derived((1 - valFrac('waveAmtY', amtYVal)) * PAD_PX);
  function writeY(fx: number, fy: number): void {
    const freq = fracVal('waveFreqY', fx);
    const amt = fracVal('waveAmtY', 1 - fy);
    dragFreqY = freq; dragAmtY = amt;
    commitPad(['waveFreqY', freq], ['waveAmtY', amt]);
  }
  function yDown(ev: PointerEvent): void {
    if (!padYEl) return;
    draggingY = true;
    padYEl.setPointerCapture(ev.pointerId);
    const { fx, fy } = padFrac(padYEl, ev);
    writeY(fx, fy);
    ev.preventDefault(); ev.stopPropagation();
  }
  function yMove(ev: PointerEvent): void {
    if (!draggingY || !padYEl) return;
    const { fx, fy } = padFrac(padYEl, ev);
    writeY(fx, fy);
  }
  function yUp(ev: PointerEvent): void {
    if (!draggingY) return;
    flushPad();
    draggingY = false; dragFreqY = null; dragAmtY = null;
    try { padYEl?.releasePointerCapture(ev.pointerId); } catch { /* */ }
  }
  function yReset(): void {
    commitPad(['waveFreqY', pdef('waveFreqY')], ['waveAmtY', pdef('waveAmtY')]);
    flushPad();
  }
</script>

<div class="vcard card video" data-testid="frametable-card" data-node-id={id}>
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="FRAMETABLE" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <!-- MODE selector -->
    <div class="mode-row" data-testid="frametable-mode">
      {#each MODES as m (m.v)}
        <button
          type="button"
          class="ft-btn nodrag seg"
          class:on={mode === m.v}
          data-testid={`frametable-mode-${m.key}`}
          onclick={() => pickMode(m.v)}
        >{m.label}</button>
      {/each}
    </div>

    <!-- video_out live preview (compact to fit the 3u tier alongside the SMOOTH pads). -->
    <div class="preview-wrap">
      <canvas
        bind:this={canvasEl}
        width={176}
        height={92}
        data-testid="frametable-preview"
        data-node-id={id}
      ></canvas>
    </div>

    <!-- Gate/switch row: CHAOS (momentary) + LIVE (latching). -->
    <div class="btn-row" data-testid="frametable-gates">
      <button
        type="button"
        class="ft-btn nodrag"
        class:on={chaosHeld}
        data-testid="frametable-chaos"
        title="CHAOS — HOLD to momentarily force the real-time per-pixel CHAOS render, overriding the mode selector"
        onpointerdown={chaosDown}
        onpointerup={chaosUp}
        onpointerleave={chaosUp}
        onpointercancel={chaosUp}
      >CHAOS</button>
      <button
        type="button"
        class="ft-btn nodrag"
        class:on={liveOn}
        data-testid="frametable-live"
        title="LIVE — force real-time (no lag) in any mode; SMOOTH/MORPH stop lagging and track the live input"
        onclick={toggleLive}
      >{liveOn ? 'LIVE!' : 'LIVE'}</button>
    </div>

    <!-- Transport row: FREEZE + SAVE. -->
    <div class="btn-row" data-testid="frametable-transport">
      <button
        type="button"
        class="ft-btn nodrag"
        class:on={freezeOn}
        data-testid="frametable-freeze"
        title="FREEZE — stop the 60-frame ring from advancing so MORPH/SPREAD scrub a held window (also held frozen while the FREEZE gate is high)"
        onclick={toggleFreeze}
      >{freezeOn ? 'FROZEN' : 'FREEZE'}</button>
      <button
        type="button"
        class="ft-btn nodrag"
        class:flash={savedFlash}
        data-testid="frametable-save"
        title="SAVE — snapshot the current 60-frame ring into an in-GPU slot (also fired by a rising edge on the SAVE trigger)"
        onclick={doSave}
      >{savedFlash ? 'SAVED' : 'SAVE'}</button>
    </div>

    <!-- File row: Load / Save real .frametable.png atlas files (visible in ALL
         modes — placed outside the per-mode extras). Separate from the in-GPU
         SAVE above: this writes/reads real files that survive reload. -->
    <div class="btn-row file-row" data-testid="frametable-file">
      <label
        class="ft-btn nodrag file-load"
        title="Load a .frametable.png atlas file into the 60-frame ring (freezes it so you can morph/scan the loaded table)"
      >
        <input
          type="file"
          accept={FRAMETABLE_FILE_ACCEPT}
          onchange={onFrametableFileChange}
          data-testid="frametable-file-input"
        />
        <span>Load…</span>
      </label>
      <button
        type="button"
        class="ft-btn nodrag"
        data-testid="frametable-save-file"
        title="Save the current 60-frame ring as a .frametable.png atlas file (freeze first to hold the window before saving)"
        onclick={doSaveFile}
        disabled={savingFile}
      >Save file</button>
    </div>
    {#if fileStatus}
      <div class="file-status" data-testid="frametable-file-status">{fileStatus}</div>
    {/if}
    {#if fileError}
      <div class="file-error" data-testid="frametable-file-error">{fileError}</div>
    {/if}

    <!-- Shared faders: MORPH + SPREAD. -->
    <div class="fader-row">
      <Fader value={p('morph')} min={pmin('morph')} max={pmax('morph')} defaultValue={pdef('morph')}
        label="Morph" curve="linear" onchange={setParam('morph')} moduleId={id} paramId="morph" />
      <Fader value={p('spread')} min={pmin('spread')} max={pmax('spread')} defaultValue={pdef('spread')}
        label="Spread" curve="linear" onchange={setParam('spread')} moduleId={id} paramId="spread" />
    </div>

    <!-- Mode-extras: hides the inactive mode's controls (keeps the card in-bounds). -->
    {#if mode === FRAMETABLE_MODE_SMOOTH}
      <div class="extras" data-testid="frametable-extras-smooth">
        <div class="pads-row">
          <div class="pad-cell">
            <div
              class="pad nodrag"
              bind:this={padXEl}
              style="width: {PAD_PX}px; height: {PAD_PX}px;"
              role="application"
              aria-label="FRAMETABLE X-axis waveform pad (freq x amt)"
              data-testid="frametable-pad-x"
              onpointerdown={xDown}
              onpointermove={xMove}
              onpointerup={xUp}
              onpointercancel={xUp}
              ondblclick={xReset}
            >
              <div class="cross-h"></div>
              <div class="cross-v"></div>
              <div class="dot" class:active={draggingX} style="left: {dotXx}px; top: {dotXy}px;"></div>
            </div>
            <div class="pad-label">x freq / amt</div>
            <div class="knob-cell">
              <Fader value={p('waveShapeX')} min={pmin('waveShapeX')} max={pmax('waveShapeX')} defaultValue={pdef('waveShapeX')}
                label="X Shp" curve="linear" onchange={setParam('waveShapeX')} moduleId={id} paramId="waveShapeX" />
            </div>
          </div>

          <div class="pad-cell">
            <div
              class="pad nodrag pad-y"
              bind:this={padYEl}
              style="width: {PAD_PX}px; height: {PAD_PX}px;"
              role="application"
              aria-label="FRAMETABLE Y-axis waveform pad (freq x amt)"
              data-testid="frametable-pad-y"
              onpointerdown={yDown}
              onpointermove={yMove}
              onpointerup={yUp}
              onpointercancel={yUp}
              ondblclick={yReset}
            >
              <div class="cross-h"></div>
              <div class="cross-v"></div>
              <div class="dot" class:active={draggingY} style="left: {dotYx}px; top: {dotYy}px;"></div>
            </div>
            <div class="pad-label">y freq / amt</div>
            <div class="knob-cell">
              <Fader value={p('waveShapeY')} min={pmin('waveShapeY')} max={pmax('waveShapeY')} defaultValue={pdef('waveShapeY')}
                label="Y Shp" curve="linear" onchange={setParam('waveShapeY')} moduleId={id} paramId="waveShapeY" />
            </div>
          </div>
        </div>
      </div>
    {:else if mode === FRAMETABLE_MODE_CHAOS}
      <div class="extras fader-row" data-testid="frametable-extras-chaos">
        <Fader value={p('shimmer')} min={pmin('shimmer')} max={pmax('shimmer')} defaultValue={pdef('shimmer')}
          label="Shimmer" curve="linear" onchange={setParam('shimmer')} moduleId={id} paramId="shimmer" />
        <Fader value={p('weightShape')} min={pmin('weightShape')} max={pmax('weightShape')} defaultValue={pdef('weightShape')}
          label="Shape" curve="linear" onchange={setParam('weightShape')} moduleId={id} paramId="weightShape" />
      </div>
    {:else}
      <div class="extras hint" data-testid="frametable-extras-morph">
        smoothest morph — scan MORPH
      </div>
    {/if}
  </PatchPanel>
</div>

<style>
  .card {
    width: 288px;
    min-height: 200px;
    padding-bottom: 8px;
  }
  .mode-row {
    display: flex;
    gap: 4px;
    margin: 4px 14px 0;
  }
  .mode-row .seg {
    flex: 1;
    padding: 4px 2px;
    font-size: 0.58rem;
  }
  .preview-wrap {
    margin: 6px auto 0;
    width: 176px;
    display: flex;
    justify-content: center;
  }
  .preview-wrap canvas {
    width: 176px;
    height: 92px;
    background: #050608;
    border: 1px solid var(--cable-video);
    border-radius: 1px;
    display: block;
  }
  .btn-row {
    display: flex;
    gap: 8px;
    margin: 6px 14px 0;
  }
  .ft-btn {
    flex: 1;
    background: var(--module-bg);
    color: var(--text-dim);
    border: 1px solid var(--border);
    border-radius: 3px;
    font-size: 0.6rem;
    letter-spacing: 0.09em;
    padding: 5px 6px;
    cursor: pointer;
    font-family: ui-monospace, monospace;
    touch-action: none;
    user-select: none;
  }
  .ft-btn:hover { border-color: var(--accent-dim); }
  .ft-btn.on {
    background: var(--accent-dim, #46506b);
    color: var(--text);
    border-color: var(--accent, #6884d7);
  }
  .ft-btn.flash {
    background: var(--cable-video, #3aa);
    color: #041014;
    border-color: var(--cable-video, #3aa);
  }
  .file-row {
    align-items: stretch;
  }
  .file-load {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
  }
  .file-load input[type='file'] {
    display: none;
  }
  .file-status,
  .file-error {
    margin: 3px 14px 0;
    font-size: 0.55rem;
    font-family: ui-monospace, monospace;
    letter-spacing: 0.03em;
    text-align: center;
    word-break: break-word;
  }
  .file-status {
    color: var(--text-dim);
  }
  .file-error {
    color: var(--cable-video, #e66);
  }
  .fader-row {
    margin-top: 6px;
    padding: 0 14px;
    display: flex;
    justify-content: center;
    gap: 18px;
  }
  .extras {
    margin-top: 4px;
  }
  .pads-row {
    display: flex;
    justify-content: center;
    gap: 12px;
    padding: 0 14px;
  }
  .pad-cell {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
  }
  .pad {
    position: relative;
    background: #050608;
    border: 1px solid var(--cable-cv, #6cf);
    border-radius: 2px;
    touch-action: none;
    cursor: grab;
    user-select: none;
  }
  .pad-y { border-color: var(--accent, #d6a); }
  .pad:active { cursor: grabbing; }
  .cross-h, .cross-v {
    position: absolute;
    background: rgba(255, 255, 255, 0.08);
    pointer-events: none;
  }
  .cross-h { left: 0; right: 0; top: 50%; height: 1px; transform: translateY(-0.5px); }
  .cross-v { top: 0; bottom: 0; left: 50%; width: 1px; transform: translateX(-0.5px); }
  .dot {
    position: absolute;
    width: 12px; height: 12px;
    border-radius: 50%;
    background: var(--cable-cv, #6cf);
    border: 1px solid #fff;
    transform: translate(-50%, -50%);
    pointer-events: none;
    box-shadow: 0 0 6px rgba(120, 200, 255, 0.4);
  }
  .pad-y .dot {
    background: var(--accent, #d6a);
    box-shadow: 0 0 6px rgba(210, 110, 200, 0.4);
  }
  .dot.active { box-shadow: 0 0 12px rgba(120, 200, 255, 0.8); }
  .pad-y .dot.active { box-shadow: 0 0 12px rgba(210, 110, 200, 0.9); }
  .pad-label {
    font-size: 0.55rem;
    color: var(--text-dim);
    letter-spacing: 0.05em;
  }
  .knob-cell {
    margin-top: 0;
  }
  .hint {
    text-align: center;
    font-size: 0.62rem;
    color: var(--text-dim);
    letter-spacing: 0.06em;
    padding: 10px 14px;
    font-style: italic;
  }
</style>
