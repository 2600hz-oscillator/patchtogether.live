<script lang="ts">
  // Snes9xCard — the SNES screen + clock_in + 12 SNES gamepad gate inputs +
  // the 11 outputs (out + audio_l/audio_r + gate1..4 + cv1..4).
  //
  // The card renders the live framebuffer + a "LOAD A ROM" dropzone/file-
  // picker when no ROM is loaded (DOOM-style; the ROM is user-provided +
  // gitignored), and the per-ROM CV/GATE "output definition" panel opened by
  // the right-click "see output definition for CV/GATES" menu item (Canvas
  // dispatches a window CustomEvent keyed by node id; the card listens).
  //
  // NO knobs/sliders — SNES9X is driven entirely by gate inputs (clock_in +
  // the gamepad). Wire the GAMEPAD module's gate outputs straight in.

  import type { NodeProps } from '@xyflow/svelte';
  import { onMount, onDestroy } from 'svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import {
    SNES_NATIVE_WIDTH,
    SNES_NATIVE_HEIGHT_MAX,
  } from '$lib/snes9x/snes9x-runtime';
  import type { Snes9xHandleExtras } from '$lib/video/modules/snes9x';
  import type { GameOutputDef } from '$lib/snes9x/output-definitions';
  import { SNES_BUTTONS } from '$lib/snes9x/snes-input';
  import { patch } from '$lib/graph/store';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import ModuleTitle from './ModuleTitle.svelte';
  import NativeFillToggle from './NativeFillToggle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  // Per-source fit/fill: SNES is fixed-native 4:3, so the Native badge shows in
  // 4:3 + the fit/fill toggle appears in 16:9.
  let fillMode = $derived<number>((node?.params?.fillMode as number | undefined) ?? 0);
  function setFillMode(v: number): void {
    const target = patch.nodes[id];
    if (target) target.params.fillMode = v;
  }

  let cardEl: HTMLDivElement | null = $state(null);
  let canvasEl: HTMLCanvasElement | null = $state(null);
  let ctx2d: CanvasRenderingContext2D | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let fileInputEl: HTMLInputElement | null = $state(null);

  let loaded = $state(false);
  let loadError = $state('');
  let romLoaded = $state(false);
  let gameId = $state('');
  let outputDef = $state<GameOutputDef | null>(null);
  let showOutputDef = $state(false);
  let dragOver = $state(false);

  function getExtras(): Snes9xHandleExtras | null {
    const eng = engineCtx.get();
    if (!eng || !node) return null;
    return (eng.read(node, 'extras') as Snes9xHandleExtras | undefined) ?? null;
  }

  function pollStatus() {
    const extras = getExtras();
    if (!extras) return;
    loaded = extras.isLoaded();
    loadError = extras.loadError();
    romLoaded = extras.romLoaded();
    gameId = extras.gameId();
    outputDef = extras.outputDefinition();
    const fb = extras.snapshotFramebuffer();
    if (fb && ctx2d && romLoaded) {
      const rt = extras.getRuntime();
      const w = rt ? rt.getFbWidth() : SNES_NATIVE_WIDTH;
      const h = rt ? rt.getFbHeight() : SNES_NATIVE_HEIGHT_MAX;
      if (w > 0 && h > 0 && fb.length >= w * h * 4) {
        try {
          if (canvasEl && (canvasEl.width !== w || canvasEl.height !== h)) {
            canvasEl.width = w;
            canvasEl.height = h;
          }
          const copy = new Uint8ClampedArray(w * h * 4);
          copy.set(fb.subarray(0, w * h * 4));
          ctx2d.putImageData(new ImageData(copy, w, h), 0, 0);
        } catch {
          /* mid-resize race — next poll repaints */
        }
      }
    }
  }

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const f = files[0];
    if (!f) return;
    const bytes = new Uint8Array(await f.arrayBuffer());
    const extras = getExtras();
    if (extras) extras.loadRomBytes(bytes);
    pollStatus();
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    dragOver = false;
    void handleFiles(e.dataTransfer?.files ?? null);
  }

  onMount(() => {
    if (canvasEl) {
      canvasEl.width = SNES_NATIVE_WIDTH;
      canvasEl.height = 224;
      ctx2d = canvasEl.getContext('2d');
    }
    pollTimer = setInterval(pollStatus, 100);
    pollStatus();
    // The right-click "see output definition for CV/GATES" menu item
    // dispatches this window event keyed by node id.
    const onShowDef = (ev: Event) => {
      const detail = (ev as CustomEvent<{ nodeId: string }>).detail;
      if (detail?.nodeId === id) showOutputDef = true;
    };
    window.addEventListener('snes9x:show-output-def', onShowDef as EventListener);
    return () => window.removeEventListener('snes9x:show-output-def', onShowDef as EventListener);
  });
  onDestroy(() => {
    if (pollTimer) clearInterval(pollTimer);
  });

  // Ports — ids byte-identical to snes9xDef so the CV bridge + persisted edges
  // route unchanged. Inputs: clock_in + the 12 SNES gamepad buttons (all gate).
  // Outputs: out (video), audio_l/audio_r (audio), gate1..4 (gate), cv1..4 (cv).
  const inputs: PortDescriptor[] = [
    { id: 'clock_in', label: 'CLOCK', cable: 'gate' },
    ...SNES_BUTTONS.map((b) => ({ id: b, label: b.toUpperCase(), cable: 'gate' })),
  ];
  const outputs: PortDescriptor[] = [
    { id: 'out', label: 'OUT', cable: 'video' },
    { id: 'audio_l', label: 'AUDIO L', cable: 'audio' },
    { id: 'audio_r', label: 'AUDIO R', cable: 'audio' },
    { id: 'gate1', label: 'GATE 1', cable: 'gate' },
    { id: 'gate2', label: 'GATE 2', cable: 'gate' },
    { id: 'gate3', label: 'GATE 3', cable: 'gate' },
    { id: 'gate4', label: 'GATE 4', cable: 'gate' },
    { id: 'cv1', label: 'CV 1', cable: 'cv' },
    { id: 'cv2', label: 'CV 2', cable: 'cv' },
    { id: 'cv3', label: 'CV 3', cable: 'cv' },
    { id: 'cv4', label: 'CV 4', cable: 'cv' },
  ];
</script>

<div
  bind:this={cardEl}
  class="mod-card snes9x-card"
  tabindex="-1"
  aria-label="SNES9X — Super Nintendo emulator. Load a ROM; drive via clock_in + SNES gamepad gates."
  data-testid="snes9x-card"
>
  <div class="stripe" style="background: var(--cable-video);"></div>
  <ModuleTitle {id} {data} defaultLabel="SNES9X" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="body">
      <div class="screen-wrap">
    <canvas bind:this={canvasEl} class="screen" data-testid="snes9x-screen"></canvas>

    {#if !loaded}
      <div class="overlay loading"><div class="overlay-title">LOADING CORE…</div></div>
    {:else if !romLoaded}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="overlay dropzone"
        class:drag-over={dragOver}
        data-testid="snes9x-load-rom"
        role="button"
        tabindex="0"
        ondragover={(e) => { e.preventDefault(); dragOver = true; }}
        ondragleave={() => (dragOver = false)}
        ondrop={onDrop}
        onclick={() => fileInputEl?.click()}
        onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileInputEl?.click(); }}
      >
        <div class="overlay-title">LOAD A ROM</div>
        <div class="overlay-body">Drop a .sfc / .smc here, or click to pick one.</div>
        <div class="overlay-hint">ROM stays in your browser. <code>task setup:snes9x</code> to autoload.</div>
      </div>
      <input
        bind:this={fileInputEl}
        type="file"
        accept=".sfc,.smc,.fig,.zip"
        class="file-input"
        data-testid="snes9x-file-input"
        onchange={(e) => handleFiles((e.currentTarget as HTMLInputElement).files)}
      />
    {/if}

    {#if showOutputDef && outputDef}
      <div class="overlay outdef" data-testid="snes9x-output-def">
        <div class="outdef-head">
          <span>CV/GATE OUTPUTS — {outputDef.title}</span>
          <button class="outdef-close" onclick={() => (showOutputDef = false)} aria-label="Close">×</button>
        </div>
        <div class="outdef-body">
          {#each outputDef.outputs as o (o.port)}
            <div class="outdef-row" class:inactive={!o.active}>
              <span class="outdef-port">{o.port}</span>
              <span class="outdef-label">{o.label}</span>
              <span class="outdef-desc">{o.description}</span>
            </div>
          {/each}
          <div class="outdef-notes">
            {#each outputDef.notes as n (n)}<div>• {n}</div>{/each}
          </div>
        </div>
      </div>
    {/if}
  </div>

      <div class="fit-row" data-testid="snes9x-fit-row">
        <span class="fit-label">OUTPUT FIT</span>
        <NativeFillToggle {fillMode} srcAspect={4 / 3} onchange={setFillMode} />
      </div>

      <div class="tip">
        Right-click → “see output definition for CV/GATES”. Patch clock_in + a GAMEPAD’s gates.
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .mod-card {
    width: max-content;
    min-width: 360px;
    min-height: 360px;
    background: var(--module-bg);
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text);
    /* Rack-compaction (#759): tighter top padding to fit the 2u tier. */
    padding: 10px 12px 9px;
    position: relative;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    outline: none;
  }
  .body {
    /* Clear the PatchPanel's top-left/right trigger affordances. */
    margin-top: 24px;
  }
  .fit-row {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    margin-top: 8px;
  }
  .fit-label {
    font-size: 0.6rem;
    color: var(--text-dim);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    font-family: ui-monospace, monospace;
  }
  :global(.svelte-flow__node:hover) .mod-card { border-color: var(--accent-dim); }
  :global(.svelte-flow__node.selected) .mod-card {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .stripe { position: absolute; top: 0; left: 0; right: 0; height: 2px; border-radius: 2px 2px 0 0; }
  .screen-wrap {
    position: relative;
    /* Rack-compaction (#759): tighter vertical margin to fit 2u. */
    margin: 8px auto 6px;
    width: 256px;
    height: 224px;
    border: 1px solid #000;
    box-shadow: inset 0 0 12px rgba(0, 0, 0, 0.6), 0 0 4px rgba(0, 0, 0, 0.3);
    background: #000;
    border-radius: 3px;
    overflow: hidden;
  }
  .screen { width: 100%; height: 100%; image-rendering: pixelated; display: block; }
  .overlay {
    position: absolute; inset: 0;
    background: rgba(0, 0, 0, 0.78);
    color: #80d0ff;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    font-family: ui-monospace, monospace; text-align: center; padding: 12px;
  }
  .overlay.loading { pointer-events: none; }
  .overlay.dropzone { cursor: pointer; border: 1px dashed rgba(128, 208, 255, 0.4); }
  .overlay.dropzone.drag-over { background: rgba(0, 40, 80, 0.85); border-color: #80d0ff; }
  .overlay-title { font-size: 0.95rem; letter-spacing: 0.16em; font-weight: 700; margin-bottom: 6px; }
  .overlay-body { font-size: 0.7rem; line-height: 1.4; opacity: 0.85; margin-bottom: 6px; max-width: 90%; }
  .overlay-hint { font-size: 0.62rem; opacity: 0.7; }
  .overlay-hint code {
    background: rgba(255, 255, 255, 0.08); padding: 2px 6px; border-radius: 2px; font-size: 0.62rem;
  }
  .file-input { display: none; }
  .overlay.outdef {
    background: rgba(8, 12, 20, 0.97);
    color: var(--text);
    align-items: stretch; justify-content: flex-start;
    text-align: left; padding: 0; overflow: auto;
  }
  .outdef-head {
    display: flex; justify-content: space-between; align-items: center;
    padding: 6px 10px; border-bottom: 1px solid #2a3140;
    font-size: 0.62rem; letter-spacing: 0.08em; color: #80d0ff;
    position: sticky; top: 0; background: rgba(8, 12, 20, 0.98);
  }
  .outdef-close {
    background: transparent; border: none; color: var(--text-dim);
    font-size: 1rem; cursor: pointer; line-height: 1; padding: 0 4px;
  }
  .outdef-body { padding: 6px 10px; }
  .outdef-row {
    display: grid; grid-template-columns: 42px 92px 1fr; gap: 6px;
    font-size: 0.56rem; line-height: 1.3; padding: 3px 0; border-bottom: 1px solid #1a2030;
  }
  .outdef-row.inactive { opacity: 0.45; }
  .outdef-port { color: #80d0ff; font-family: ui-monospace, monospace; }
  .outdef-label { color: #ffd060; font-weight: 600; }
  .outdef-desc { color: var(--text-dim); }
  .outdef-notes { margin-top: 8px; font-size: 0.54rem; color: var(--text-dim); line-height: 1.4; }
  .tip {
    font-family: ui-monospace, monospace; font-size: 0.52rem; color: var(--text-dim);
    text-align: center; margin-top: 4px; letter-spacing: 0.04em; max-width: 360px;
  }
</style>
