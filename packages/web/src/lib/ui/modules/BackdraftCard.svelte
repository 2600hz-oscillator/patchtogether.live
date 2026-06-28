<script lang="ts">
  // BackdraftCard — UI for BACKDRAFT (video feedback generator).
  //
  // 2-column layout (mirrors CUBE/HYPERCUBE): a large video PREVIEW on the
  // LEFT, all controls (mirror toggles + fader grid) on the RIGHT. Every port
  // (2 video + 2 KEY masks + 18 CV/gate inputs + the `out` video output) lives
  // in the yellow PatchPanel drill-down menu. Every Fader is wired with
  // moduleId={id} + paramId so MIDI-Learn binds.
  //
  // FULL OUTPUT CAPABILITIES (mirrors VideoOutCard / BentboxCard):
  //   - Corner-drag resize: the whole card grows; the LEFT preview canvas
  //     scales with it while the RIGHT controls column keeps a fixed-ish width
  //     and stays usable. Width/height persist in node.data.width/height
  //     (Y.Doc-synced), snapped to whole-u (180px) rack tiles via card-resize.
  //   - Right-click the preview → context menu: Full Frame (in-app borderless,
  //     persisted node.data.fullFrame, double-click to exit) / Full Screen
  //     (true browser Fullscreen API) / Present on other display (a separate
  //     popup on a second monitor; only offered when getScreenDetails + >1
  //     screen). Full-frame ↔ fullscreen are mutually exclusive. The preview
  //     keeps rendering live in every mode (the rAF blit is independent).

  import { onMount, onDestroy } from 'svelte';
  import { useStore, type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { useEngine } from '$lib/audio/engine-context';
  import { patch, ydoc } from '$lib/graph/store';
  import { setNodeParam, mutateNode } from '$lib/graph/mutate';
  import { startCornerResize } from './card-resize';
  import { createFullscreen } from './use-fullscreen.svelte';
  import { createFullFrame } from './use-full-frame.svelte';
  import { createPresent } from './use-present.svelte';
  import { fullscreenCanvasDims } from './fullscreen-canvas-dims';
  import { liveEngineAspect } from './video-card-aspect';
  import VideoCanvasContextMenu from './VideoCanvasContextMenu.svelte';
  import {
    backdraftDef,
    BACKDRAFT_MAX_DELAY_MS,
    BACKDRAFT_MAX_FEEDBACK,
    BACKDRAFT_ZOOM_MIN,
    BACKDRAFT_ZOOM_MAX,
    BACKDRAFT_ROTATE_MIN,
    BACKDRAFT_ROTATE_MAX,
    BACKDRAFT_OFFSET_MIN,
    BACKDRAFT_OFFSET_MAX,
  } from '$lib/video/modules/backdraft';
  import type { VideoEngine } from '$lib/video/engine';
  import { VIDEO_RES } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();
  const flowStore = useStore();

  function pdef(name: string): number {
    return backdraftDef.params.find((d) => d.id === name)!.defaultValue;
  }
  function p(name: string): number {
    const def = backdraftDef.params.find((d) => d.id === name);
    return node?.params[name] ?? def?.defaultValue ?? 0;
  }
  function setParam(paramId: string) {
    return (v: number) => setNodeParam(id, paramId, v);
  }

  // ---- MIRROR X / MIRROR Y kaleidoscope toggles ----
  // Each button flips a boolean param (mirrorX / mirrorY). A rising edge on
  // the matching gate input also flips it in the engine; the button reflects
  // the (possibly gate-toggled) param value.
  let mirrorXOn = $derived(p('mirrorX') >= 0.5);
  let mirrorYOn = $derived(p('mirrorY') >= 0.5);
  function toggleMirror(paramId: 'mirrorX' | 'mirrorY') {
    return () => {
      setNodeParam(id, paramId, (p(paramId) ?? 0) >= 0.5 ? 0 : 1);
    };
  }

  // ---- DELAY CLOCK override indicator ----
  // When a cable is patched into the `delay_clock` input, the clock drives
  // the feedback delay (one pulse = the delay time) and OVERRIDES the DELAY
  // knob. We show a small "CLK" badge + disable the Delay fader so it reads
  // as overridden. patch.edges is a SyncedStore/Yjs proxy (not a Svelte
  // signal), so we bump a real $state from a Yjs observer to stay reactive
  // on cable add/remove — same pattern as DoomCard's edgesVersion.
  let edgesVersion = $state(0);
  let clockPatched = $derived.by<boolean>(() => {
    void edgesVersion;
    for (const edge of Object.values(patch.edges)) {
      if (!edge) continue;
      if (edge.target.nodeId === id && edge.target.portId === 'delay_clock') return true;
    }
    return false;
  });
  let edgesUnobserve: (() => void) | null = null;

  const ENGINE_W = VIDEO_RES.width;
  const ENGINE_H = VIDEO_RES.height;

  // ---------------- Resize (mirror VideoOutCard / BentboxCard) ----------------
  // Default keeps the historic ~720-wide footprint; height = 3u (540px). Min
  // rounded to whole-u (180px) tiles so the card lands on the rack grid out of
  // the box (#759) and so the rack CSS doesn't clamp the corner-resize.
  const DEFAULT_WIDTH = 720;
  const DEFAULT_HEIGHT = 540;
  const MIN_WIDTH = 540;
  const MIN_HEIGHT = 360;

  // The RIGHT controls column stays a sane fixed-ish width so the faders never
  // collapse; the LEFT preview takes whatever width is left.
  const CONTROLS_W = 280;
  // Header + horizontal/vertical paddings + the inter-column gap budget. The
  // preview gets the remaining width; height tracks the card minus the header.
  const HEADER_PX = 56;
  const PAD_PX = 28; // body left/right padding (14 each)
  const GAP_PX = 16; // inter-column gap

  let cardWidth = $derived<number>(
    (node?.data?.width as number | undefined) ?? DEFAULT_WIDTH,
  );
  let cardHeight = $derived<number>(
    (node?.data?.height as number | undefined) ?? DEFAULT_HEIGHT,
  );

  // The LEFT preview's inner box. It absorbs all card growth; the controls
  // column is fixed. Floor at a sane minimum so a tiny card still shows a
  // preview (the resize MIN already keeps this comfortably positive).
  let innerWidth = $derived(
    Math.max(180, cardWidth - CONTROLS_W - PAD_PX - GAP_PX),
  );
  let innerHeight = $derived(Math.max(180, cardHeight - HEADER_PX));

  let canvasEl: HTMLCanvasElement | null = $state(null);
  let rafId: number | null = null;

  // Live engine canvas dims, mirrored each rAF in draw() (the engine isn't a
  // reactive store), used by the fullscreen buffer-size derive below.
  let engineW = $state<number>(ENGINE_W);
  let engineH = $state<number>(ENGINE_H);

  // ---------- True fullscreen (mirrors VideoOutCard) ----------
  // The preview-wrap is the fullscreen element; it holds the live <canvas>.
  // CSS scales the canvas to fill the viewport aspect-fit while fullscreen;
  // the rAF blit keeps running so the fullscreen view stays live.
  const fs = createFullscreen();
  let wrapEl: HTMLDivElement | null = $state(null);
  $effect(() => {
    fs.setTarget(wrapEl);
  });
  $effect(() => fs.attach());

  // ---------- Present on a second display ----------
  // Separate popup window on the chosen display fed THIS card's live canvas
  // via a per-frame canvas blit; the main window stays interactive (unlike
  // fullscreen). Capability-gated by the menu (getScreenDetails + >1 screen).
  const present = createPresent({
    getCanvas: () => canvasEl,
    fullscreen: fs,
  });

  // ---------- Full Frame (in-app, NOT browser fullscreen) ----------
  // Expands the preview to consume the card border, hiding the controls + port
  // labels + jacks; the card stays in the rack + remains resizable. Persisted
  // in node.data.fullFrame (Y.Doc-synced, written in place via mutateNode) so a
  // wall-of-TVs layout survives reload + is shareable. See use-full-frame.
  let fullFrame = $derived<boolean>((node?.data?.fullFrame as boolean | undefined) ?? false);
  const ff = createFullFrame({
    setFullFrame: (on) => {
      mutateNode(id, (live) => {
        if (!live.data) live.data = {};
        live.data.fullFrame = on;
      });
    },
    // Mutual exclusion: entering full-frame drops any active true-fullscreen.
    exitFullscreen: () => void fs.exit(),
  });
  let cardEl: HTMLDivElement | null = $state(null);
  // Double-click a full-frame card exits back to normal chrome.
  $effect(() => ff.attach(cardEl, () => fullFrame));

  // Canvas drawing-buffer dims. Rack: preview inner dims. TRUE fullscreen — OR
  // while PRESENTING / full-frame: the live ENGINE dims so fitRect fills the
  // buffer edge-to-edge + object-fit:contain height-fills the screen (side
  // pillarbox only). See fullscreen-canvas-dims.ts.
  let bufferDims = $derived(
    fullscreenCanvasDims(
      fs.isFullscreen || present.isPresenting || fullFrame,
      { canvas: { width: engineW, height: engineH } },
      { width: innerWidth, height: innerHeight },
    ),
  );

  // Right-click-on-preview context menu (Full Frame / Full Screen / Present).
  let ctxOpen = $state(false);
  let ctxX = $state(0);
  let ctxY = $state(0);
  function onCanvasContextMenu(e: MouseEvent) {
    // Claim the right-click on the preview surface so it doesn't bubble to the
    // SvelteFlow node menu (Docs / Duplicate / Delete). Right-click on the
    // controls column still falls through to the node menu.
    e.preventDefault();
    e.stopPropagation();
    ctxX = e.clientX;
    ctxY = e.clientY;
    ctxOpen = true;
  }

  function fitRect(cw: number, ch: number): { x: number; y: number; w: number; h: number } {
    // Letterbox at the LIVE engine aspect (mirrored into engineW/engineH each
    // rAF) so the in-rack thumbnail tracks a 4:3 ↔ 16:9 OUTPUT switch.
    const srcAspect = liveEngineAspect({ canvas: { width: engineW, height: engineH } });
    const dstAspect = cw / ch;
    if (dstAspect > srcAspect) {
      const h = ch;
      const w = Math.round(h * srcAspect);
      return { x: Math.round((cw - w) / 2), y: 0, w, h };
    } else {
      const w = cw;
      const h = Math.round(w / srcAspect);
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
    try {
      videoEngine = e.getDomain<VideoEngine>('video');
    } catch {
      rafId = requestAnimationFrame(draw);
      return;
    }
    if (!videoEngine) {
      rafId = requestAnimationFrame(draw);
      return;
    }
    const ctx2d = canvasEl.getContext('2d', { alpha: false });
    if (ctx2d) {
      try {
        videoEngine.blitOutputToDrawingBuffer(id);
      } catch {
        // Never let an engine error nuke the rAF loop.
      }
      const src = videoEngine.canvas as CanvasImageSource;
      // Mirror the live engine dims into $state so the fullscreen buffer-size
      // derive (bufferDims) follows the engine resolution. Cheap change-guard.
      const ew = videoEngine.canvas.width || ENGINE_W;
      const eh = videoEngine.canvas.height || ENGINE_H;
      if (ew !== engineW) engineW = ew;
      if (eh !== engineH) engineH = eh;
      const cw = canvasEl.width;
      const ch = canvasEl.height;
      ctx2d.fillStyle = '#050608';
      ctx2d.fillRect(0, 0, cw, ch);
      const r = fitRect(cw, ch);
      // drawImage() from a WebGL canvas already presents upright (the browser
      // accounts for GL's bottom-left origin). A straight blit is correct.
      ctx2d.drawImage(src, r.x, r.y, r.w, r.h);
    }
    // A rising edge on a mirror gate flips the param INSIDE the engine
    // instance. Mirror that live value back into the patch store so the
    // toggle persists + syncs to collaborators + the button reflects it.
    try { syncMirrorFromEngine(e, node); } catch { /* defensive */ }
    rafId = requestAnimationFrame(draw);
  }

  // Reconcile the engine's live mirrorX/mirrorY (possibly gate-toggled) into
  // the patch store. Only writes when the engine value differs from the store,
  // so user clicks (store → engine via setParam) and gate flips (engine →
  // store here) converge without fighting.
  function syncMirrorFromEngine(e: ReturnType<typeof engineCtx.get>, n: ModuleNode | undefined): void {
    if (!e || !n) return;
    for (const k of ['mirrorX', 'mirrorY'] as const) {
      const live = e.readParam(n, k);
      if (typeof live !== 'number') continue;
      const stored = (patch.nodes[id]?.params[k] ?? 0);
      if ((live >= 0.5) !== (stored >= 0.5)) {
        const target = patch.nodes[id];
        if (target) target.params[k] = live >= 0.5 ? 1 : 0; // guard:allow-raw-write — per-frame engine→store reflect, must NOT pollute undo
      }
    }
  }

  onMount(() => {
    rafId = requestAnimationFrame(draw);
    const edgesMap = ydoc.getMap('edges');
    const handler = (): void => { edgesVersion++; };
    edgesMap.observeDeep(handler);
    edgesUnobserve = () => edgesMap.unobserveDeep(handler);
    edgesVersion++; // seed for a patch loaded with the cable already present
  });
  onDestroy(() => {
    if (rafId !== null) cancelAnimationFrame(rafId);
    if (resizeAbort) resizeAbort.abort();
    // Close any present popup + stop the blit loop when the card is gone.
    present.dispose();
    if (edgesUnobserve) { try { edgesUnobserve(); } catch { /* */ } edgesUnobserve = null; }
  });

  // ---------------- Corner-drag resize handle ----------------
  let resizing = $state(false);
  let resizeAbort: AbortController | null = null;
  function onResizeStart(ev: PointerEvent) {
    resizeAbort = startCornerResize(ev, {
      flowStore,
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      getStartSize: () => ({ width: cardWidth, height: cardHeight }),
      apply: (w, h) => {
        // guard:allow-raw-write — fires per pointermove during a resize drag;
        // a tracked write per frame would storm the doc + flood the undo stack.
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

  // ---------------- Patch-panel ports ----------------
  // Port ids match the def EXACTLY (handle id === port id — the cross-domain
  // CV bridge + saved patches route by id). lighten/darken CV use the `_cv`
  // suffix; gate-style inputs (delay_clock / mirror_*_gate) carry raw swing.
  const inputs: PortDescriptor[] = [
    { id: 'in_a',    label: 'IN A',    cable: 'video' },
    { id: 'in_b',    label: 'IN B',    cable: 'video' },
    { id: 'lighten', label: 'KEY +',   cable: 'video' },
    { id: 'darken',  label: 'KEY -',   cable: 'video' },
    { id: 'mix',         label: 'MIX',       cable: 'cv' },
    { id: 'feedback',    label: 'FEEDBACK',  cable: 'cv' },
    { id: 'delay',       label: 'DELAY',     cable: 'cv' },
    { id: 'delay_clock', label: 'DELAY CLK', cable: 'gate' },
    { id: 'luma',        label: 'LUMA',      cable: 'cv' },
    { id: 'chroma',      label: 'CHROMA',    cable: 'cv' },
    { id: 'r',           label: 'R',         cable: 'cv' },
    { id: 'g',           label: 'G',         cable: 'cv' },
    { id: 'b',           label: 'B',         cable: 'cv' },
    { id: 'lighten_cv',  label: 'LIGHTEN',   cable: 'cv' },
    { id: 'darken_cv',   label: 'DARKEN',    cable: 'cv' },
    { id: 'pixelate',    label: 'PIXELATE',  cable: 'cv' },
    { id: 'zoom',        label: 'ZOOM',      cable: 'cv' },
    { id: 'rotate',      label: 'ROTATE',    cable: 'cv' },
    { id: 'offsetx',     label: 'OFF X',     cable: 'cv' },
    { id: 'offsety',     label: 'OFF Y',     cable: 'cv' },
    { id: 'mirror_x_gate', label: 'MIRROR X', cable: 'gate' },
    { id: 'mirror_y_gate', label: 'MIRROR Y', cable: 'gate' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'out', label: 'OUT', cable: 'video' },
  ];
</script>

<div
  bind:this={cardEl}
  class="card video"
  class:resizing
  class:full-frame={fullFrame}
  style="width: {cardWidth}px; height: {cardHeight}px;"
  data-testid="backdraft-card"
  data-node-id={id}
  data-full-frame={fullFrame}
>
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="BACKDRAFT" />

  <PatchPanel nodeId={id} {inputs} {outputs} panelWidth={300}>
    <div class="bd-body">
      <!-- LEFT column: large video preview (scales with the card). -->
      <div class="bd-col bd-col-left">
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          bind:this={wrapEl}
          class="canvas-wrap"
          class:fullscreen={fs.isFullscreen}
          class:full-frame={fullFrame}
          style="width: {fs.isFullscreen || fullFrame ? '100%' : innerWidth + 'px'}; height: {fs.isFullscreen || fullFrame ? '100%' : innerHeight + 'px'};"
          data-testid="backdraft-fs-wrap"
          oncontextmenu={onCanvasContextMenu}
        >
          <canvas
            bind:this={canvasEl}
            width={bufferDims.width}
            height={bufferDims.height}
            style="aspect-ratio: {bufferDims.aspectRatio};"
            data-testid="backdraft-canvas"
            data-node-id={id}
          ></canvas>
        </div>
      </div>

      <!-- RIGHT column: mirror toggles + the fader grid (fixed-ish width). -->
      <div class="bd-col bd-col-right">
        <div class="mirror-row" data-testid="backdraft-mirror-row">
          <button
            type="button"
            class="mirror-btn nodrag"
            class:on={mirrorXOn}
            data-testid="backdraft-mirror-x"
            title="MIRROR X — fold the left half over the right (kaleidoscope)"
            onclick={toggleMirror('mirrorX')}
          >MIRROR X</button>
          <button
            type="button"
            class="mirror-btn nodrag"
            class:on={mirrorYOn}
            data-testid="backdraft-mirror-y"
            title="MIRROR Y — fold the top half over the bottom (kaleidoscope)"
            onclick={toggleMirror('mirrorY')}
          >MIRROR Y</button>
        </div>

        <div class="fader-grid" data-testid="backdraft-controls">
          <Fader value={p('mix')}      min={0}  max={1}                     defaultValue={pdef('mix')}      label="Mix"  curve="linear" onchange={setParam('mix')}      moduleId={id} paramId="mix" />
          <Fader value={p('feedback')} min={0}  max={BACKDRAFT_MAX_FEEDBACK} defaultValue={pdef('feedback')} label="FB"   curve="linear" onchange={setParam('feedback')} moduleId={id} paramId="feedback" />
          <div class="delay-cell" class:clk-driven={clockPatched}>
            <Fader value={p('delay')}    min={0}  max={BACKDRAFT_MAX_DELAY_MS} units="ms" defaultValue={pdef('delay')} label={clockPatched ? 'Dly·CLK' : 'Delay'} curve="linear" onchange={setParam('delay')} moduleId={id} paramId="delay" />
            {#if clockPatched}<span class="clk-badge" data-testid="backdraft-clk-badge" title="DELAY CLOCK is driving the feedback delay (knob overridden)">CLK</span>{/if}
          </div>
          <Fader value={p('luma')}     min={-1} max={2}                     defaultValue={pdef('luma')}     label="Luma" curve="linear" onchange={setParam('luma')}     moduleId={id} paramId="luma" />
          <Fader value={p('chroma')}   min={-1} max={2}                     defaultValue={pdef('chroma')}   label="Chr"  curve="linear" onchange={setParam('chroma')}   moduleId={id} paramId="chroma" />
          <Fader value={p('r')}        min={-1} max={2}                     defaultValue={pdef('r')}        label="R"    curve="linear" onchange={setParam('r')}        moduleId={id} paramId="r" />
          <Fader value={p('g')}        min={-1} max={2}                     defaultValue={pdef('g')}        label="G"    curve="linear" onchange={setParam('g')}        moduleId={id} paramId="g" />
          <Fader value={p('b')}        min={-1} max={2}                     defaultValue={pdef('b')}        label="B"    curve="linear" onchange={setParam('b')}        moduleId={id} paramId="b" />
          <Fader value={p('lighten')}  min={0}  max={1}                     defaultValue={pdef('lighten')}  label="Lgt"  curve="linear" onchange={setParam('lighten')}  moduleId={id} paramId="lighten" />
          <Fader value={p('darken')}   min={0}  max={1}                     defaultValue={pdef('darken')}   label="Drk"  curve="linear" onchange={setParam('darken')}   moduleId={id} paramId="darken" />
          <Fader value={p('pixelate')} min={0}  max={1}                     defaultValue={pdef('pixelate')} label="Pix"  curve="linear" onchange={setParam('pixelate')} moduleId={id} paramId="pixelate" />
          <Fader value={p('zoom')}     min={BACKDRAFT_ZOOM_MIN}   max={BACKDRAFT_ZOOM_MAX}   defaultValue={pdef('zoom')}    label="Zoom" curve="linear" onchange={setParam('zoom')}    moduleId={id} paramId="zoom" />
          <Fader value={p('rotate')}   min={BACKDRAFT_ROTATE_MIN} max={BACKDRAFT_ROTATE_MAX} units="°" defaultValue={pdef('rotate')} label="Rot"  curve="linear" onchange={setParam('rotate')}  moduleId={id} paramId="rotate" />
          <Fader value={p('offsetX')}  min={BACKDRAFT_OFFSET_MIN} max={BACKDRAFT_OFFSET_MAX} defaultValue={pdef('offsetX')} label="OffX" curve="linear" onchange={setParam('offsetX')} moduleId={id} paramId="offsetX" />
          <Fader value={p('offsetY')}  min={BACKDRAFT_OFFSET_MIN} max={BACKDRAFT_OFFSET_MAX} defaultValue={pdef('offsetY')} label="OffY" curve="linear" onchange={setParam('offsetY')} moduleId={id} paramId="offsetY" />
        </div>
      </div>
    </div>
  </PatchPanel>

  <!-- Bottom-right corner-drag resize handle. The svelte-flow nodrag class is
       required so xyflow's node-drag listener doesn't hijack the pointerdown
       event before we see it. -->
  <div
    class="resize-handle nodrag"
    role="separator"
    aria-label="Resize BACKDRAFT"
    data-testid="backdraft-resize-handle"
    onpointerdown={onResizeStart}
  ></div>
</div>

<VideoCanvasContextMenu
  bind:open={ctxOpen}
  x={ctxX}
  y={ctxY}
  title="BACKDRAFT"
  availableScreens={fs.availableScreens}
  onrequestscreens={() => void fs.loadScreens()}
  onfullscreen={(screenId) => { ff.exit(); void fs.enter(screenId); }}
  onfullframe={() => ff.toggle(fullFrame)}
  isFullFrame={fullFrame}
  onpresent={(screenId) => present.present(screenId)}
  onpresentall={() => present.presentAll(fs.availableScreens.filter((s) => !s.isPrimary).map((s) => s.id))}
  onstoppresent={() => present.stop()}
  isPresenting={present.isPresenting}
  onclose={() => { ctxOpen = false; }}
/>

<style>
  .card {
    /* Solid black underlay + opaque module-bg overlay so no cable routed
     * behind the preview canvas can bleed through the live video. */
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
  :global(.svelte-flow__node:hover) .card { border-color: var(--accent-dim); }
  :global(.svelte-flow__node.selected) .card {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .card.resizing {
    /* Avoid hover/selected pulses while the user drags. */
    transition: none;
  }
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
  /* 2-column layout: preview LEFT (scales), controls RIGHT (fixed-ish). */
  .bd-body {
    padding: 6px 14px 8px;
    display: flex;
    flex-direction: row;
    gap: 16px;
    align-items: flex-start;
  }
  .bd-col { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
  /* LEFT grows to absorb card resize; RIGHT keeps a sane fixed width so the
   * faders never collapse. */
  .bd-col-left { flex: 1 1 auto; min-width: 0; }
  .bd-col-right { flex: 0 0 280px; min-width: 0; }
  .canvas-wrap {
    border: 1px solid var(--cable-video);
    border-radius: 2px;
    overflow: hidden;
    line-height: 0;
    background: #050608;
    display: flex;
    justify-content: center;
    align-items: center;
  }
  .canvas-wrap canvas {
    display: block;
    width: 100%;
    height: 100%;
    image-rendering: pixelated;
    background: #050608;
  }
  /* TRUE fullscreen: the wrap IS the fullscreen element (filling the physical
   * screen). Center the live canvas + scale it to fit with aspect preserved
   * (object-fit:contain semantics), black bars on the short axis. The rAF blit
   * keeps feeding the same canvas. */
  .canvas-wrap.fullscreen {
    margin: 0;
    width: 100%;
    height: 100%;
    background: #000;
    border: none;
    border-radius: 0;
  }
  .canvas-wrap.fullscreen canvas {
    border: none;
    border-radius: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
    cursor: pointer;
  }
  /* FULL FRAME (in-app): the preview consumes the whole card border — hide the
   * chrome (title, controls, stripe) + drop the card padding so the video fills
   * edge-to-edge. The card stays in the rack + remains resizable; double-click
   * exits. Distinct from .fullscreen (Fullscreen API) above. */
  .card.full-frame {
    padding: 0;
  }
  .card.full-frame .title,
  .card.full-frame .stripe,
  .card.full-frame .bd-col-right {
    display: none;
  }
  .card.full-frame .bd-body {
    padding: 0;
    gap: 0;
    height: 100%;
  }
  .card.full-frame .bd-col-left {
    flex: 1 1 auto;
    width: 100%;
    height: 100%;
  }
  /* Let the PatchPanel host (display:contents) pass through so the preview can
   * fill the card once the title + controls are gone. */
  .card.full-frame :global(.patch-panel-host) {
    display: contents;
  }
  /* Hide the card's OWN Svelte Flow jacks + patch-panel triggers while
   * full-frame — keep handles in the DOM (opacity/pointer-events, not
   * display:none) so existing cables stay connected; we hide the jacks
   * visually, not disconnect them. */
  .card.full-frame :global(.svelte-flow__handle) {
    opacity: 0;
    pointer-events: none;
  }
  .card.full-frame :global(.patch-trigger) {
    display: none;
  }
  .canvas-wrap.full-frame {
    margin: 0;
    width: 100%;
    height: 100%;
    background: #000;
    border: none;
    border-radius: 0;
    cursor: pointer;
  }
  .canvas-wrap.full-frame canvas {
    border: none;
    border-radius: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
  .fader-grid {
    margin-top: 4px;
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 14px 6px;
    justify-items: center;
  }
  .mirror-row {
    display: flex;
    gap: 8px;
    justify-content: flex-start;
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
  .delay-cell {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  /* When the DELAY CLOCK drives the delay, dim the track + thumb so the
     knob reads as overridden (the fader stays interactive + MIDI-learnable;
     the value-tag + label stay full-opacity so the badge is legible). */
  .delay-cell.clk-driven :global(.track),
  .delay-cell.clk-driven :global(.thumb) {
    opacity: 0.45;
  }
  .clk-badge {
    margin-top: 2px;
    font-size: 0.5rem;
    line-height: 1;
    letter-spacing: 0.05em;
    color: var(--cable-cv, #6cf);
    border: 1px solid var(--cable-cv, #6cf);
    border-radius: 2px;
    padding: 1px 2px;
    font-family: ui-monospace, monospace;
    pointer-events: none;
  }
  .resize-handle {
    position: absolute;
    right: 0;
    bottom: 0;
    width: 16px;
    height: 16px;
    cursor: nwse-resize;
    /* Triangle in the corner so it's visible without dominating the chrome. */
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
