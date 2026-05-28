<script lang="ts">
  // BentboxCard — CRT-emulation OUTPUT with AVEmod-style bending knobs.
  //
  // Visual surface: same per-card 2D-canvas blit pattern as VideoOutCard
  // — we ask the VideoEngine to render THIS instance's FBO into its
  // drawing buffer, then drawImage() that into our visible <canvas>.
  // Resize handle uses the shared startCornerResize helper.
  //
  // Bending controls live BELOW the screen as a 4×3 grid of compact
  // knobs grouped by row: TIMING (HS Drift, HS Loss, VS Drift, Wobble),
  // CHROMA + GAIN (Hue, Shimmer, Gain, Bloom), FEEDBACK + DESTRUCTION
  // (Feedback, Delay, Wavefold, Noise). The layout intentionally puts
  // the "make it weirder" knobs (Wavefold, Noise) on the bottom row so
  // a new user sees them last.

  import { onMount, onDestroy } from 'svelte';
  import { Handle, Position, useStore, type NodeProps } from '@xyflow/svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { patch } from '$lib/graph/store';
  import { startCornerResize } from './card-resize';
  import { createFullscreen } from './use-fullscreen.svelte';
  import { createFullFrame } from './use-full-frame.svelte';
  import VideoCanvasContextMenu from './VideoCanvasContextMenu.svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import type { VideoEngine } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';
  import { bentboxDef } from '$lib/video/modules/bentbox';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();
  const flowStore = useStore();

  // ---------------- Resize (mirror VideoOutCard) ----------------

  // Default size sized for the knob grid below the screen. Width is
  // 4 knob columns wide; height = screen (4:3 of inner width) + knob
  // grid.
  const DEFAULT_WIDTH = 420;
  const DEFAULT_HEIGHT = 480;
  const MIN_WIDTH = 320;
  const MIN_HEIGHT = 360;

  // Engine render resolution — matches VIDEO_RES in video/engine.ts.
  // We always letterbox 4:3 inside the canvas so the CRT aspect ratio
  // is preserved even as the user resizes.
  const ENGINE_W = 640;
  const ENGINE_H = 360;

  let cardWidth = $derived<number>(
    (node?.data?.width as number | undefined) ?? DEFAULT_WIDTH,
  );
  let cardHeight = $derived<number>(
    (node?.data?.height as number | undefined) ?? DEFAULT_HEIGHT,
  );

  // Layout budget: header ~52px, knob grid below ~190px, padding ~20px.
  // Whatever's left is the visible screen area.
  const HEADER_PX = 52;
  const KNOBS_PX = 200;
  const PAD_PX = 20;
  let innerWidth = $derived(Math.max(MIN_WIDTH - PAD_PX, cardWidth - PAD_PX));
  let screenAreaH = $derived(
    Math.max(120, cardHeight - HEADER_PX - KNOBS_PX),
  );

  let canvasEl: HTMLCanvasElement | null = $state(null);
  let rafId: number | null = null;

  // ---------- True fullscreen (mirrors VideoOutCard) ----------
  // The screen-wrap is the fullscreen element; it holds the live <canvas>.
  // CSS scales the canvas to fill the viewport aspect-fit while fullscreen;
  // the rAF blit keeps running so the CRT view stays live.
  const fs = createFullscreen();
  let wrapEl: HTMLDivElement | null = $state(null);
  $effect(() => {
    fs.setTarget(wrapEl);
  });
  $effect(() => fs.attach());

  // ---------- Full Frame (in-app, NOT browser fullscreen) ----------
  // Expands the CRT surface to consume the card border, hiding the knob
  // grid + port labels + jacks; the card stays in the rack + remains
  // resizable. Persisted in node.data.fullFrame (Y.Doc-synced) so a
  // wall-of-TVs layout survives reload + is shareable. See use-full-frame.
  let fullFrame = $derived<boolean>((node?.data?.fullFrame as boolean | undefined) ?? false);
  const ff = createFullFrame({
    setFullFrame: (on) => {
      const target = patch.nodes[id];
      if (target) {
        if (!target.data) target.data = {};
        target.data.fullFrame = on;
      }
    },
    exitFullscreen: () => void fs.exit(),
  });
  let cardEl: HTMLDivElement | null = $state(null);
  $effect(() => ff.attach(cardEl, () => fullFrame));

  let ctxOpen = $state(false);
  let ctxX = $state(0);
  let ctxY = $state(0);
  function onCanvasContextMenu(e: MouseEvent) {
    // Claim right-click on the CRT surface so the SvelteFlow node menu
    // doesn't also fire; right-click on the knob area still falls through.
    e.preventDefault();
    e.stopPropagation();
    ctxX = e.clientX;
    ctxY = e.clientY;
    ctxOpen = true;
  }

  /** Letterbox the engine frame inside the (cw, ch) container at the
   *  PIPELINE aspect (16:9 = ENGINE_W/ENGINE_H), NOT 4:3. The whole video
   *  pipeline (sources → mixer → bentbox) renders a 16:9 FBO; re-imposing a
   *  4:3 blit here squished the image horizontally. The CRT/retro look
   *  (scanlines, phosphor mask, NTSC bend) lives in the BENTBOX shader and
   *  is unaffected — we only fix the display-rect aspect so a 16:9 input
   *  isn't distorted on the way to the visible canvas. */
  function fitRect(cw: number, ch: number): { x: number; y: number; w: number; h: number } {
    const SRC = ENGINE_W / ENGINE_H;
    const dstAspect = cw / ch;
    if (dstAspect > SRC) {
      const h = ch;
      const w = Math.round(h * SRC);
      return { x: Math.round((cw - w) / 2), y: 0, w, h };
    } else {
      const w = cw;
      const h = Math.round(w / SRC);
      return { x: 0, y: Math.round((ch - h) / 2), w, h };
    }
  }

  function draw() {
    rafId = null;
    const e = engineCtx.get();
    if (!e || !canvasEl) {
      rafId = requestAnimationFrame(draw);
      return;
    }
    let videoEngine: VideoEngine | undefined;
    try { videoEngine = e.getDomain<VideoEngine>('video'); } catch { videoEngine = undefined; }
    if (!videoEngine) {
      rafId = requestAnimationFrame(draw);
      return;
    }
    const ctx2d = canvasEl.getContext('2d', { alpha: false });
    if (ctx2d) {
      try { videoEngine.blitOutputToDrawingBuffer(id); } catch { /* defensive */ }
      const src = videoEngine.canvas as CanvasImageSource;
      const cw = canvasEl.width;
      const ch = canvasEl.height;
      ctx2d.fillStyle = '#050608';
      ctx2d.fillRect(0, 0, cw, ch);
      const r = fitRect(cw, ch);
      // drawImage() from a WebGL canvas already presents upright (the
      // browser accounts for GL's bottom-left origin). A straight blit is
      // correct — the manual scale(1,-1) that used to be here flipped the
      // image upside down. See VideoOutCard for the full rationale.
      ctx2d.drawImage(src, r.x, r.y, r.w, r.h);
    }
    // Reflect gate-toggled mirror state from the engine back into the store
    // (so the button updates + the toggle persists/syncs). Only writes on a
    // real change — user clicks and gate flips converge.
    try {
      for (const k of ['mirrorX', 'mirrorY'] as const) {
        const live = e.readParam(node, k);
        if (typeof live !== 'number') continue;
        const stored = patch.nodes[id]?.params[k] ?? 0;
        if ((live >= 0.5) !== (stored >= 0.5)) {
          const t = patch.nodes[id];
          if (t) t.params[k] = live >= 0.5 ? 1 : 0;
        }
      }
    } catch { /* defensive */ }
    rafId = requestAnimationFrame(draw);
  }

  onMount(() => { rafId = requestAnimationFrame(draw); });
  onDestroy(() => {
    if (rafId !== null) cancelAnimationFrame(rafId);
    if (resizeAbort) resizeAbort.abort();
  });

  // ---------------- Resize handle ----------------
  let resizing = $state(false);
  let resizeAbort: AbortController | null = null;
  function onResizeStart(ev: PointerEvent) {
    resizeAbort = startCornerResize(ev, {
      flowStore,
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      getStartSize: () => ({ width: cardWidth, height: cardHeight }),
      apply: (w, h) => {
        const target = patch.nodes[id];
        if (target) {
          if (!target.data) target.data = {};
          target.data.width = w;
          target.data.height = h;
        }
      },
      onStart: () => { resizing = true; },
      onEnd: () => { resizing = false; resizeAbort = null; },
    });
  }

  // ---------------- Knob plumbing ----------------

  const defaultFor = (key: string): number =>
    bentboxDef.params.find((p) => p.id === key)!.defaultValue;

  const set = (k: string) => (v: number) => { const t = patch.nodes[id]; if (t) t.params[k] = v; };
  const live = (k: string) => () => {
    const e = engineCtx.get(); if (!e || !node) return undefined;
    return e.readParam(node, k);
  };

  // Reactive param reads from the patch store (Y.Doc-synced).
  let hsync_drift        = $derived(node?.params.hsync_drift        ?? defaultFor('hsync_drift'));
  let hsync_loss         = $derived(node?.params.hsync_loss         ?? defaultFor('hsync_loss'));
  let vsync_drift        = $derived(node?.params.vsync_drift        ?? defaultFor('vsync_drift'));
  let scan_wobble        = $derived(node?.params.scan_wobble        ?? defaultFor('scan_wobble'));
  let chroma_phase       = $derived(node?.params.chroma_phase       ?? defaultFor('chroma_phase'));
  let chroma_instability = $derived(node?.params.chroma_instability ?? defaultFor('chroma_instability'));
  let master_gain        = $derived(node?.params.master_gain        ?? defaultFor('master_gain'));
  let bloom              = $derived(node?.params.bloom              ?? defaultFor('bloom'));
  let feedback_gain      = $derived(node?.params.feedback_gain      ?? defaultFor('feedback_gain'));
  let feedback_delay     = $derived(node?.params.feedback_delay     ?? defaultFor('feedback_delay'));
  let wavefold           = $derived(node?.params.wavefold           ?? defaultFor('wavefold'));
  let noise              = $derived(node?.params.noise              ?? defaultFor('noise'));

  // ---- MIRROR X / MIRROR Y kaleidoscope toggles ----
  // Each button flips a boolean param (mirrorX / mirrorY). A rising edge on
  // the matching gate input also flips it in the engine; the button reflects
  // the (possibly gate-toggled) param value.
  let mirrorX = $derived((node?.params.mirrorX ?? defaultFor('mirrorX')) >= 0.5);
  let mirrorY = $derived((node?.params.mirrorY ?? defaultFor('mirrorY')) >= 0.5);
  function toggleMirror(paramId: 'mirrorX' | 'mirrorY') {
    return () => {
      const t = patch.nodes[id];
      if (!t) return;
      t.params[paramId] = (t.params[paramId] ?? 0) >= 0.5 ? 0 : 1;
    };
  }

  const inputs: PortDescriptor[] = [
    { id: 'in',                    label: 'IN',    cable: 'video' },
    { id: 'hsync_drift_cv',        label: 'HSD',   cable: 'cv' },
    { id: 'hsync_loss_cv',         label: 'HSL',   cable: 'cv' },
    { id: 'vsync_drift_cv',        label: 'VSD',   cable: 'cv' },
    { id: 'scan_wobble_cv',        label: 'WOB',   cable: 'cv' },
    { id: 'chroma_phase_cv',       label: 'HUE',   cable: 'cv' },
    { id: 'chroma_instability_cv', label: 'SHM',   cable: 'cv' },
    { id: 'feedback_gain_cv',      label: 'FBK',   cable: 'cv' },
    { id: 'feedback_delay_cv',     label: 'DLY',   cable: 'cv' },
    { id: 'wavefold_cv',           label: 'FOLD',  cable: 'cv' },
    { id: 'bloom_cv',              label: 'BLM',   cable: 'cv' },
    { id: 'noise_cv',              label: 'NSE',   cable: 'cv' },
    { id: 'master_gain_cv',        label: 'GAIN',  cable: 'cv' },
    { id: 'mirror_x_gate',         label: 'MIRX',  cable: 'cv' },
    { id: 'mirror_y_gate',         label: 'MIRY',  cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'out', label: 'OUT', cable: 'video' },
  ];
</script>

<div
  bind:this={cardEl}
  class="card bentbox"
  class:resizing
  class:full-frame={fullFrame}
  style="width: {cardWidth}px; height: {cardHeight}px;"
  data-testid="bentbox-card"
  data-node-id={id}
  data-full-frame={fullFrame}
>
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="BENTBOX" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      bind:this={wrapEl}
      class="screen-wrap"
      class:fullscreen={fs.isFullscreen}
      class:full-frame={fullFrame}
      style="width: {fs.isFullscreen || fullFrame ? '100%' : innerWidth + 'px'}; height: {fs.isFullscreen || fullFrame ? '100%' : screenAreaH + 'px'};"
      data-testid="bentbox-fs-wrap"
      oncontextmenu={onCanvasContextMenu}
    >
      <canvas
        bind:this={canvasEl}
        width={innerWidth}
        height={screenAreaH}
        style="aspect-ratio: {innerWidth} / {screenAreaH};"
        data-testid="bentbox-canvas"
        data-node-id={id}
      ></canvas>
    </div>

    <div class="knob-grid">
      <Knob value={hsync_drift}        min={0}  max={1} defaultValue={0}    label="HS Drift"  curve="linear" onchange={set('hsync_drift')} moduleId={id} paramId="hsync_drift"        readLive={live('hsync_drift')} />
      <Knob value={hsync_loss}         min={0}  max={1} defaultValue={0}    label="HS Loss"   curve="linear" onchange={set('hsync_loss')} moduleId={id} paramId="hsync_loss"         readLive={live('hsync_loss')} />
      <Knob value={vsync_drift}        min={0}  max={1} defaultValue={0}    label="VS Drift"  curve="linear" onchange={set('vsync_drift')} moduleId={id} paramId="vsync_drift"        readLive={live('vsync_drift')} />
      <Knob value={scan_wobble}        min={0}  max={1} defaultValue={0}    label="Wobble"    curve="linear" onchange={set('scan_wobble')} moduleId={id} paramId="scan_wobble"        readLive={live('scan_wobble')} />

      <Knob value={chroma_phase}       min={-1} max={1} defaultValue={0}    label="Hue"       curve="linear" onchange={set('chroma_phase')} moduleId={id} paramId="chroma_phase"       readLive={live('chroma_phase')} />
      <Knob value={chroma_instability} min={0}  max={1} defaultValue={0}    label="Shimmer"   curve="linear" onchange={set('chroma_instability')} moduleId={id} paramId="chroma_instability" readLive={live('chroma_instability')} />
      <Knob value={master_gain}        min={0}  max={2} defaultValue={1}    label="Gain"      curve="linear" onchange={set('master_gain')} moduleId={id} paramId="master_gain"        readLive={live('master_gain')} />
      <Knob value={bloom}              min={0}  max={1} defaultValue={0.4}  label="Bloom"     curve="linear" onchange={set('bloom')} moduleId={id} paramId="bloom"              readLive={live('bloom')} />

      <Knob value={feedback_gain}      min={0}  max={1} defaultValue={0}    label="Feedback"  curve="linear" onchange={set('feedback_gain')} moduleId={id} paramId="feedback_gain"      readLive={live('feedback_gain')} />
      <Knob value={feedback_delay}     min={0}  max={1} defaultValue={0}    label="Delay"     curve="linear" onchange={set('feedback_delay')} moduleId={id} paramId="feedback_delay"     readLive={live('feedback_delay')} />
      <Knob value={wavefold}           min={0}  max={1} defaultValue={0}    label="Wavefold"  curve="linear" onchange={set('wavefold')} moduleId={id} paramId="wavefold"           readLive={live('wavefold')} />
      <Knob value={noise}              min={0}  max={1} defaultValue={0.05} label="Noise"     curve="linear" onchange={set('noise')} moduleId={id} paramId="noise"              readLive={live('noise')} />
    </div>

    <div class="mirror-row" data-testid="bentbox-mirror-row">
      <button
        type="button"
        class="mirror-btn nodrag"
        class:on={mirrorX}
        data-testid="bentbox-mirror-x"
        title="MIRROR X — fold the left half over the right (kaleidoscope)"
        onclick={toggleMirror('mirrorX')}
      >MIRROR X</button>
      <button
        type="button"
        class="mirror-btn nodrag"
        class:on={mirrorY}
        data-testid="bentbox-mirror-y"
        title="MIRROR Y — fold the top half over the bottom (kaleidoscope)"
        onclick={toggleMirror('mirrorY')}
      >MIRROR Y</button>
    </div>
  </PatchPanel>

  <div
    class="resize-handle nodrag"
    role="separator"
    aria-label="Resize BENTBOX"
    data-testid="bentbox-resize-handle"
    onpointerdown={onResizeStart}
  ></div>
</div>

<VideoCanvasContextMenu
  bind:open={ctxOpen}
  x={ctxX}
  y={ctxY}
  title="BENTBOX"
  availableScreens={fs.availableScreens}
  onrequestscreens={() => void fs.loadScreens()}
  onfullscreen={(screenId) => { ff.exit(); void fs.enter(screenId); }}
  onfullframe={() => ff.toggle(fullFrame)}
  isFullFrame={fullFrame}
  onclose={() => { ctxOpen = false; }}
/>

<style>
  .card.bentbox {
    background-color: #000;
    background-image: linear-gradient(var(--module-bg), var(--module-bg));
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text);
    padding-top: 18px;
    padding-bottom: 14px;
    position: relative;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    transition: border-color 80ms ease-out, box-shadow 80ms ease-out;
    overflow: hidden;
    isolation: isolate;
  }
  :global(.svelte-flow__node:hover) .card.bentbox {
    border-color: var(--accent-dim);
  }
  :global(.svelte-flow__node.selected) .card.bentbox {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .card.bentbox.resizing { transition: none; }
  .stripe {
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    border-radius: 2px 2px 0 0;
    background: var(--cable-video);
  }
  .title {
    font-size: 0.85rem;
    font-weight: 500;
    text-align: center;
    margin: 0 0 8px;
    letter-spacing: 0.05em;
  }
  .screen-wrap {
    margin: 0 auto 10px;
    display: flex;
    justify-content: center;
    align-items: center;
  }
  .screen-wrap canvas {
    background: #050608;
    border: 1px solid var(--cable-video);
    border-radius: 1px;
    image-rendering: auto; /* soft-pixel CRT look — let browser smooth */
    width: 100%;
    height: 100%;
    display: block;
  }
  /* TRUE fullscreen: the screen-wrap fills the physical screen; center +
   * aspect-fit the live canvas (object-fit:contain semantics), black bars
   * on the short axis. rAF blit keeps feeding the canvas. */
  .screen-wrap.fullscreen {
    margin: 0;
    width: 100%;
    height: 100%;
    background: #000;
  }
  /* Zoom-fit: scale the live canvas UP to fill the fullscreen viewport as
   * large as possible while preserving aspect. The canvas drawing buffer is
   * small (card-sized px) so width/height:auto kept it tiny + un-scaled —
   * fill the wrap (100% × 100%) + object-fit:contain so it scales up,
   * centered, with black bars on the off-axis. */
  .screen-wrap.fullscreen canvas {
    border: none;
    border-radius: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
    cursor: pointer;
  }
  /* FULL FRAME (in-app): the CRT surface consumes the whole card border —
   * hide the title, knob grid, stripe + the PatchPanel jack affordances so
   * the card shows only video. Stays in the rack + resizable; double-click
   * exits. Distinct from .fullscreen (browser Fullscreen API) above. */
  .card.bentbox.full-frame {
    padding: 0;
  }
  .card.bentbox.full-frame .title,
  .card.bentbox.full-frame .stripe,
  .card.bentbox.full-frame .knob-grid,
  .card.bentbox.full-frame .mirror-row {
    display: none;
  }
  /* Hide the card's OWN jack affordances + Svelte Flow handles while full-
   * frame. Keep handles in the DOM (opacity/pointer-events, not
   * display:none) so existing cables stay connected — we hide, not remove. */
  .card.bentbox.full-frame :global(.patch-trigger) {
    opacity: 0;
    pointer-events: none;
  }
  .card.bentbox.full-frame :global(.svelte-flow__handle) {
    opacity: 0;
    pointer-events: none;
  }
  .screen-wrap.full-frame {
    margin: 0;
    width: 100%;
    height: 100%;
    background: #000;
    cursor: pointer;
  }
  .screen-wrap.full-frame canvas {
    border: none;
    border-radius: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
  /* When full-frame, the PatchPanel host (display:contents) must let the
   * screen-wrap fill the card. The card is a flex/normal-flow box; the
   * screen-wrap grows to fill the freed space once title + knobs are gone. */
  .card.bentbox.full-frame :global(.patch-panel-host) {
    display: contents;
  }
  .knob-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 6px 8px;
    padding: 0 8px;
  }
  .mirror-row {
    display: flex;
    gap: 8px;
    justify-content: center;
    margin-top: 8px;
    padding: 0 8px;
  }
  .mirror-btn {
    flex: 1;
    background: var(--module-bg);
    color: var(--text-dim);
    border: 1px solid var(--border);
    border-radius: 3px;
    font-size: 0.6rem;
    letter-spacing: 0.08em;
    padding: 4px 6px;
    cursor: pointer;
    font-family: ui-monospace, monospace;
  }
  .mirror-btn.on {
    background: var(--accent-dim, #46506b);
    color: var(--text);
    border-color: var(--accent, #6884d7);
  }
  .mirror-btn:hover { border-color: var(--accent-dim); }
  .resize-handle {
    position: absolute;
    right: 0;
    bottom: 0;
    width: 16px;
    height: 16px;
    cursor: nwse-resize;
    background: linear-gradient(
      135deg,
      transparent 50%,
      var(--cable-video) 50%,
      var(--cable-video) 60%,
      transparent 60%,
      transparent 70%,
      var(--cable-video) 70%,
      var(--cable-video) 80%,
      transparent 80%
    );
    opacity: 0.7;
    z-index: 5;
  }
  .resize-handle:hover { opacity: 1; }
</style>
