<script lang="ts">
  // packages/web/src/lib/ui/modules/mappy/MappyMapBody.svelte
  //
  // THE MAPPY MAP SURFACE — the dock full-view body, and the surface a promoted
  // MAPPY is actually aligned on.
  //
  // ── WHAT IT CARRIES, AND WHY EACH THING COULD NOT BE A CELL ────────────────
  //
  //   * THE COMPOSITE PREVIEW + THE CORNER-PIN OVERLAY. Dragging a corner is
  //     the module. It is a pointer gesture over a picture in normalized output
  //     space; no ParamCellKind mounts a canvas, and the values it writes are
  //     `node.data.surfaces[i].corners[c]`, not params.
  //   * THE WHOLE-SURFACE MOVE DRAG and SURFACE SELECT — the same single
  //     pointer-down, resolved by the shared pure hit-test (`mappy-hit`).
  //   * THE PER-SURFACE FIT/CROP AND RESET, one pair per live surface. These
  //     are SIX INDEPENDENT BOOLEANS on six independent objects; a
  //     `controlFamilies` template is ONE cell with no per-member index, so the
  //     roster cannot be expressed as cells at all.
  //   * THE MAP ⤢ BUTTON, which mounts the existing full-window `MappyEditor`
  //     (big handles, snap-to-grid, surface tabs) — unchanged, and mounted from
  //     here so it survives the promotion that stops the card rendering.
  //   * THE MAP I/O STATUS LINE. The shell paints a status/error line for a
  //     `file` cell for free, but an `action` cell has nowhere to say what
  //     happened — so the EXPORT outcome needs a home, and this is it. Both
  //     halves route through the one seam (`mappy-map-actions`) the ranked cells
  //     call, so the body and the cells cannot disagree about the file format.
  //   * THE EMPTY-STATE HINT — a placeholder naming this surface's own
  //     condition (the samsloop NO SAMPLE LOADED shape), replaced the moment any
  //     input is patched.
  //
  // ── ⚠ NOTHING ON THIS SURFACE IS REACTIVE BY DEFAULT ──────────────────────
  //
  // `patch` is SyncedStore's proxy, NOT a Svelte signal: reading `patch.nodes`
  // or `patch.edges` inside a `$derived` subscribes to NOTHING. The legacy card
  // gets away with it because its xyflow props churn on every graph tick, and
  // it hand-rolls a `ydoc.getMap('edges').observeDeep` bridge for the edges —
  // a bridge that lives in NEITHER `mappy-edit`, `mappy-hit` nor
  // `mappy-map-io`, so "reuse the shared seams verbatim" does not carry it.
  //
  // A faceplate body has no churn to ride, so EVERY derived here reads its
  // pump first: `nodeVersion(nodeId)` for anything under this node, and
  // `edgesVersion()` for the patched-input roster that `live[]`, the hit-test
  // and the MAP editor's `connected` prop all depend on. MEASURED before it was
  // written this way: the surface tabs froze at one while the graph correctly
  // held two. The pumps are the fleet's shared seam (`node-versions.svelte.ts`)
  // rather than a second hand-rolled copy of the card's observer — same
  // mechanism, one implementation, and no per-component subscription lifetime
  // to leak.
  //
  // ── ⚠ SCREEN OFF MUST KEEP BLITTING ───────────────────────────────────────
  //
  // `markWatched` happens INSIDE `blitOutputForPreview`, and a node is a pull
  // root only while that mark is fresh. MAPPY is a mid-chain compositor whose
  // whole purpose is to feed a projector, so an OFF branch that simply stopped
  // calling the blit would turn a control labelled SCREEN into a PRODUCER KILL
  // SWITCH — a black projector on stage with the module apparently running.
  // The collapsed branch therefore still marks the node watched every frame,
  // which is quadralogical's shape and not a naive `{#if !collapsed}` around
  // the loop.

  import { onDestroy } from 'svelte';
  import { patch } from '$lib/graph/store';
  import { nodeVersion, edgesVersion } from '$lib/graph/node-versions.svelte';
  import { mutateNode } from '$lib/graph/mutate';
  import type { ModuleNode } from '$lib/graph/types';
  import type { VideoEngine } from '$lib/video/engine';
  import { VIDEO_RES } from '$lib/video/engine';
  import {
    mappyDef,
    MAPPY_SURFACE_COUNT,
    MAPPY_INPUT_IDS,
    MAPPY_SURFACE_COLORS,
    normalizeSurfaces,
    surfaceFitOn,
    type MappySurfaceState,
  } from '$lib/video/modules/mappy';
  import {
    getSurfaceCount,
    setCorner as editSetCorner,
    moveSurface as editMoveSurface,
    resetSurface as editResetSurface,
    toggleSurfaceFit as editToggleSurfaceFit,
  } from '../mappy-edit';
  import { exportMappyMap, importMappyMapFile } from '../mappy-map-actions';
  import { hitTestSurfaces } from '../mappy-hit';
  import { drawPreviewDownscaled } from '../preview-downscale';
  import { cardParams } from '../card-kit';
  import MappyEditor from '../MappyEditor.svelte';

  interface Props {
    /** The graph node this faceplate is showing — the ONLY prop the slot gets
     *  (`ShellExtensionFullViewBodyProps`). */
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  // ⚠ EVERY DERIVED BELOW RE-READS `patch.nodes[nodeId]`; the node is never
  // captured once. A Y.Doc node proxy's IDENTITY does not change when its
  // contents do, so a derived closing over a captured proxy can go stale while
  // the graph is perfectly correct — the graph is right, the picture is right,
  // and the surrounding UI is frozen. The legacy card gets away with it only
  // because its xyflow props churn on every graph tick; a faceplate body has no
  // such churn. `MatrixMixGridBody` is the shipped shape.
  const { engineCtx } = cardParams(
    mappyDef,
    () => nodeId,
    () => patch.nodes[nodeId] as ModuleNode | undefined,
  );

  // ── SCREEN ON/OFF ─────────────────────────────────────────────────────────
  // State on the NODE, not in the component: this body unmounts on dock
  // collapse / LRU eviction (#1531 / #1574 / #1583), and it is the SAME
  // `previewCollapsed` key every other video surface uses, so a rack saved
  // before this promotion keeps whatever it had. Absent ⇒ false ⇒ ON.
  let previewCollapsed = $derived.by<boolean>(() => {
    void nodeVersion(nodeId);
    return (patch.nodes[nodeId]?.data?.previewCollapsed as boolean | undefined) ?? false;
  });
  function toggleScreen(): void {
    const next = !previewCollapsed;
    mutateNode(nodeId, (liveNode) => {
      if (!liveNode.data) liveNode.data = {};
      liveNode.data.previewCollapsed = next;
    });
  }

  // ── which inputs are patched (see the header on the pumps) ────────────────
  let connected = $derived.by<boolean[]>(() => {
    void edgesVersion();
    return MAPPY_INPUT_IDS.map((portId) =>
      Object.values(patch.edges ?? {}).some(
        (e) => e?.target?.nodeId === nodeId && e?.target?.portId === portId,
      ),
    );
  });
  let anyConnected = $derived(connected.some(Boolean));

  // ── surface state ─────────────────────────────────────────────────────────
  let surfaces = $derived.by<MappySurfaceState[]>(() => {
    void nodeVersion(nodeId);
    return normalizeSurfaces(
      (patch.nodes[nodeId]?.data as { surfaces?: unknown } | undefined)?.surfaces,
    );
  });
  let fits = $derived<boolean[]>(surfaces.map((s) => surfaceFitOn(s)));
  // The PARAM, never a `node.data` mirror — see mappy-edit.ts. Every generic
  // shell cell writes the param alone, so a mirror the engine preferred would
  // have made this module's own faceplate inert.
  let surfaceCount = $derived.by<number>(() => {
    void nodeVersion(nodeId);
    return getSurfaceCount(patch.nodes[nodeId] as ModuleNode | undefined);
  });
  /** LIVE = within the count OR its input is patched — the engine's own rule. */
  let live = $derived<boolean[]>(
    Array.from({ length: MAPPY_SURFACE_COUNT }, (_, i) => i < surfaceCount || !!connected[i]),
  );
  let liveCount = $derived(live.filter(Boolean).length);

  let selected = $state(0);
  let editorOpen = $state(false);

  // ── map I/O status (the ACTION cell has no status line of its own) ────────
  let mapStatus = $state<{ kind: 'ok' | 'err'; text: string } | null>(null);
  let statusTimer: ReturnType<typeof setTimeout> | null = null;
  function flashResult(r: { status: string | null; error: string | null }): void {
    if (r.error) mapStatus = { kind: 'err', text: r.error };
    else if (r.status) mapStatus = { kind: 'ok', text: r.status };
    else return;
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { mapStatus = null; statusTimer = null; }, 4000);
  }

  let importInput: HTMLInputElement | null = $state(null);
  function onExportMap(): void {
    flashResult(exportMappyMap(nodeId));
  }
  function onImportClick(): void {
    importInput?.click();
  }
  async function onImportFile(ev: Event): Promise<void> {
    const input = ev.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // so picking the SAME file again re-fires change
    if (!file) return;
    const r = await importMappyMapFile(nodeId, file);
    if (!r.error && selected >= surfaceCount) selected = Math.max(0, surfaceCount - 1);
    flashResult(r);
  }

  // ── pointer drag — corner-pin OR whole-surface move ───────────────────────
  // ONE SVG-level pointer-down runs the shared pure hit-test; the overlay shapes
  // are pointer-events:none so this handler owns the corner-vs-interior
  // decision, exactly as on the card and in the MAP editor.
  const ENGINE_W = VIDEO_RES.width;
  const ENGINE_H = VIDEO_RES.height;
  /** The body's picture is wider than the card's 320 px well — this is a dock
   *  surface, and a bigger frame is what makes a corner pin precise. */
  const CANVAS_W = 480;
  const CANVAS_H = Math.round((CANVAS_W * ENGINE_H) / ENGINE_W);
  /** Grab radius in uv space: the on-screen handle radius over the frame. */
  const GRAB_UV = 8 / CANVAS_W;

  let svgEl: SVGSVGElement | null = $state(null);
  let drag = $state<
    | { kind: 'corner'; surface: number; corner: number }
    | { kind: 'move'; surface: number; lastX: number; lastY: number }
    | null
  >(null);

  function uvFromPointer(ev: PointerEvent): { x: number; y: number } | null {
    if (!svgEl) return null;
    const rect = svgEl.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return {
      x: (ev.clientX - rect.left) / rect.width,
      // y FLIPPED — corners live in the engine's y-UP uv space (v=1 = canvas
      // top), so a click near the visual top must map to a HIGH v or the grid
      // renders mirrored against the handle.
      y: 1 - (ev.clientY - rect.top) / rect.height,
    };
  }
  function onOverlayDown(ev: PointerEvent): void {
    if (ev.button !== 0) return;
    const uv = uvFromPointer(ev);
    if (!uv) return;
    const hit = hitTestSurfaces(surfaces, live, [uv.x, uv.y], GRAB_UV, selected);
    if (!hit) return;
    selected = hit.surface;
    if (hit.kind === 'corner') {
      drag = { kind: 'corner', surface: hit.surface, corner: hit.corner };
    } else {
      drag = { kind: 'move', surface: hit.surface, lastX: uv.x, lastY: uv.y };
    }
    svgEl?.setPointerCapture?.(ev.pointerId);
    ev.preventDefault();
    ev.stopPropagation();
  }
  function onHandleMove(ev: PointerEvent): void {
    if (!drag) return;
    const uv = uvFromPointer(ev);
    if (!uv) return;
    if (drag.kind === 'corner') {
      editSetCorner(nodeId, drag.surface, drag.corner, uv.x, uv.y);
    } else {
      editMoveSurface(nodeId, drag.surface, uv.x - drag.lastX, uv.y - drag.lastY);
      drag.lastX = uv.x;
      drag.lastY = uv.y;
    }
  }
  function onHandleUp(ev: PointerEvent): void {
    if (!drag) return;
    try { svgEl?.releasePointerCapture?.(ev.pointerId); } catch { /* */ }
    drag = null;
  }

  // ── overlay geometry (uv [0,1] → svg units) ──────────────────────────────
  function px(u: number): number { return u * CANVAS_W; }
  // y-UP: v=1 draws at the TOP, matching the engine's vUv space and the flipped
  // pointer above, so handles sit exactly where the surface renders.
  function py(v: number): number { return (1 - v) * CANVAS_H; }
  function quadPoints(s: MappySurfaceState): string {
    return s.corners.map((c) => `${px(c[0])},${py(c[1])}`).join(' ');
  }

  // ── the render loop ──────────────────────────────────────────────────────
  let canvasEl: HTMLCanvasElement | null = $state(null);
  let rafId: number | null = null;

  function draw(): void {
    rafId = null;
    const e = engineCtx.get();
    if (!e) { rafId = requestAnimationFrame(draw); return; }
    let videoEngine: VideoEngine | undefined;
    try { videoEngine = e.getDomain<VideoEngine>('video'); }
    catch { videoEngine = undefined; }
    if (!videoEngine) { rafId = requestAnimationFrame(draw); return; }

    if (previewCollapsed) {
      // ⚠ THE WATCH MARK IS RETAINED WITH THE SCREEN OFF — see the header. The
      // blit IS the mark, so stopping it here would black out the projector
      // this module exists to feed.
      try { videoEngine.markWatched(nodeId); } catch { /* never nuke the loop */ }
      rafId = requestAnimationFrame(draw);
      return;
    }

    if (canvasEl) {
      const ctx2d = canvasEl.getContext('2d', { alpha: false });
      if (ctx2d) {
        let blitted = false;
        try { blitted = videoEngine.blitOutputForPreview(nodeId); }
        catch { /* never nuke the loop */ }
        if (blitted) {
          const src = videoEngine.canvas as CanvasImageSource;
          ctx2d.fillStyle = '#050608';
          ctx2d.fillRect(0, 0, canvasEl.width, canvasEl.height);
          // The frame is authored at the engine aspect, so a straight stretch
          // keeps the overlay's [0,1] uv exactly the canvas rect — which is
          // what makes a dragged handle land on the pixel it points at.
          drawPreviewDownscaled(ctx2d, src, 0, 0, canvasEl.width, canvasEl.height);
        }
      }
    }
    rafId = requestAnimationFrame(draw);
  }

  // ONE place owns the loop and it runs in BOTH screen states, so nothing has to
  // restart it on toggle — which removes "switched it back on and the picture
  // never came back" by construction.
  $effect(() => {
    if (rafId === null) rafId = requestAnimationFrame(draw);
    return () => {
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    };
  });
  onDestroy(() => {
    if (statusTimer) clearTimeout(statusTimer);
  });

  /** The accessible name for the picture: what a sighted player reads off the
   *  legend — how many surfaces are live and how many are fed. `aria-label`
   *  rather than a painted line, per the resting-text ruling. */
  let frameLabel = $derived(
    `MAPPY composite — ${liveCount} surface${liveCount === 1 ? '' : 's'} live, `
    + `${connected.filter(Boolean).length} fed by video, surface ${selected + 1} focused`,
  );
</script>

<div class="mappy-body" data-testid="mappy-map-body">
  <div class="stage">
    <div
      class="frame"
      class:collapsed={previewCollapsed}
      style={previewCollapsed ? '' : `width: ${CANVAS_W}px; height: ${CANVAS_H}px;`}
    >
      {#if !previewCollapsed}
        <canvas
          bind:this={canvasEl}
          width={CANVAS_W}
          height={CANVAS_H}
          data-testid="mappy-face-canvas"
          data-node-id={nodeId}
          aria-label={frameLabel}
        ></canvas>
        <!-- svelte-ignore a11y_no_static_element_interactions — a drag-the-corner-handles
             projection-mapping overlay. Dragging a quad by keyboard needs a nudge model that
             does not exist yet; grouped with the other pointer-only surfaces in #1572. -->
        <svg
          bind:this={svgEl}
          class="overlay nodrag"
          viewBox={`0 0 ${CANVAS_W} ${CANVAS_H}`}
          width={CANVAS_W}
          height={CANVAS_H}
          onpointerdown={onOverlayDown}
          onpointermove={onHandleMove}
          onpointerup={onHandleUp}
          onpointercancel={onHandleUp}
          data-testid="mappy-face-overlay"
        >
          {#each surfaces as surf, i (i)}
            {#if live[i]}
              {@const color = MAPPY_SURFACE_COLORS[i]}
              {@const isSel = selected === i}
              <polygon
                points={quadPoints(surf)}
                fill={color}
                fill-opacity={isSel ? 0.08 : 0.03}
                stroke={color}
                stroke-width={isSel ? 2 : 1}
                stroke-opacity={isSel ? 0.95 : 0.4}
                data-testid={`mappy-face-quad-${i + 1}`}
              />
              {#each surf.corners as c, ci (ci)}
                <circle
                  class="handle"
                  cx={px(c[0])}
                  cy={py(c[1])}
                  r={isSel ? 8 : 6}
                  fill={color}
                  fill-opacity={isSel ? 0.95 : 0.45}
                  stroke="#0008"
                  stroke-width="1"
                  data-testid={`mappy-face-handle-${i + 1}-${ci}`}
                />
              {/each}
            {/if}
          {/each}
        </svg>
        {#if !anyConnected}
          <div class="empty-hint" data-testid="mappy-face-empty-hint">
            drag the grid corners to map · then connect IN1…IN6
          </div>
        {/if}
      {/if}

      <button
        type="button"
        class="screen-btn nodrag"
        class:on={!previewCollapsed}
        onclick={toggleScreen}
        data-testid="mappy-face-screen-toggle"
        aria-pressed={!previewCollapsed}
        title={previewCollapsed
          ? 'SCREEN is OFF — the composite preview and its corner handles are collapsed. MAPPY KEEPS COMPOSITING and keeps feeding `out`, so the projector is unaffected; switching it back on shows the LIVE frame, not a stale one.'
          : 'SCREEN — collapse the composite preview and reclaim its space. MAPPY goes on compositing and feeding `out` either way, so this never darkens the projector.'}
      >{previewCollapsed ? 'SCREEN OFF' : 'SCREEN ON'}</button>
    </div>
  </div>

  <div class="tools">
    <button
      class="map-btn nodrag"
      type="button"
      onclick={() => (editorOpen = true)}
      data-testid="mappy-face-open-editor"
      title="Open the full-window mapping editor for precise corner-pin"
    >MAP ⤢</button>

    <!-- The map I/O the RANKED CELLS also drive, repeated here because the
         action cell's outcome has nowhere else to be seen, and because a player
         aligning a venue is already looking at this surface. -->
    <button
      class="tool-btn nodrag"
      type="button"
      onclick={onExportMap}
      data-testid="mappy-face-export-map"
      title="Save the surface layout (count + corners + FIT) to a .json file — reuse it in another patch at the same venue"
    >export map</button>
    <button
      class="tool-btn nodrag"
      type="button"
      onclick={onImportClick}
      data-testid="mappy-face-import-map"
      title="Load a surface layout from a .json file — REPLACES the current layout"
    >import map</button>
    <input
      bind:this={importInput}
      class="file-input"
      type="file"
      accept="application/json,.json"
      onchange={onImportFile}
      data-testid="mappy-face-import-file"
      tabindex="-1"
      aria-hidden="true"
    />
    {#if mapStatus}
      <span
        class="map-status"
        class:err={mapStatus.kind === 'err'}
        data-testid="mappy-face-map-status"
        data-status-kind={mapStatus.kind}
        role="status"
      >{mapStatus.text}</span>
    {/if}
  </div>

  <!-- One row per LIVE surface: focus, its FIT/CROP mode, and its geometry
       reset. Six independent booleans on six independent objects — the shape a
       controlFamilies template cannot carry, since a template is ONE cell with
       no per-member index. -->
  <div class="legend" data-testid="mappy-face-legend">
    {#each surfaces as _surf, i (i)}
      {#if live[i]}
        <div class="legend-row" class:selected={selected === i} data-testid={`mappy-face-legend-${i + 1}`}>
          <button
            class="swatch-btn nodrag"
            type="button"
            style="--c: {MAPPY_SURFACE_COLORS[i]};"
            onclick={() => (selected = i)}
            title={`Focus surface ${i + 1} (its corner handles come to front)`}
            data-testid={`mappy-face-select-${i + 1}`}
          >
            <span class="swatch"></span>
            <span class="legend-label">IN{i + 1}</span>
            <span class="legend-state" class:lit={connected[i]}>{connected[i] ? '● video' : '○ grid'}</span>
          </button>
          <button
            class="fit-btn nodrag"
            class:on={fits[i]}
            type="button"
            onclick={() => editToggleSurfaceFit(nodeId, i)}
            title={fits[i]
              ? `FIT ON — surface ${i + 1} zoom-fits the whole source into its box. Click for CROP (window the source at native scale).`
              : `CROP — surface ${i + 1} windows the source at native scale (move to pan, resize to crop). Click for FIT (zoom-fit).`}
            data-testid={`mappy-face-fit-${i + 1}`}
          >{fits[i] ? 'FIT' : 'CROP'}</button>
          <button
            class="reset-btn nodrag"
            type="button"
            onclick={() => editResetSurface(nodeId, i)}
            title={`Reset surface ${i + 1} corners to full-frame`}
            data-testid={`mappy-face-reset-${i + 1}`}
          >reset</button>
        </div>
      {/if}
    {/each}
  </div>
</div>

{#if editorOpen}
  <MappyEditor id={nodeId} {connected} onClose={() => (editorOpen = false)} />
{/if}

<style>
  .mappy-body {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
    padding: 6px 0 2px;
  }
  .stage { display: flex; justify-content: center; }
  .frame {
    position: relative;
    border: 1px solid var(--cable-video);
    border-radius: 3px;
    overflow: hidden;
    background: #050608;
    line-height: 0;
  }
  /* SCREEN OFF reclaims the picture's space; the switch keeps its own row so it
     is never the element that moves under the player's cursor. */
  .frame.collapsed {
    border-color: var(--border);
    min-height: 20px;
    min-width: 120px;
  }
  .frame canvas {
    display: block;
    image-rendering: pixelated;
    background: #050608;
  }
  .overlay {
    position: absolute;
    inset: 0;
    touch-action: none;
    /* the SVG owns pointer-down hit-testing (corner vs. interior move); the
       shapes themselves don't intercept, so a single handler decides */
    cursor: move;
  }
  .overlay polygon,
  .overlay .handle { pointer-events: none; }
  .empty-hint {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-dim, #889);
    font-size: 0.72rem;
    font-family: ui-monospace, monospace;
    pointer-events: none;
    text-align: center;
    padding: 0 16px;
    line-height: 1.3;
  }
  .screen-btn {
    position: absolute;
    right: 4px;
    bottom: 4px;
    font-size: 0.55rem;
    letter-spacing: 0.06em;
    padding: 2px 8px;
    border: 1px solid var(--border);
    border-radius: 2px;
    /* legible over a live picture — a transparent button was not */
    background: rgba(5, 6, 8, 0.72);
    color: var(--text-dim);
    cursor: pointer;
    line-height: 1.2;
  }
  .screen-btn.on { color: var(--text); border-color: var(--accent-dim); }
  .screen-btn:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
  .tools {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    padding: 0 6px;
  }
  .map-btn {
    background: rgba(74, 223, 255, 0.12);
    color: var(--cable-video, #4adfff);
    border: 1px solid var(--cable-video, #4adfff);
    border-radius: 3px;
    padding: 3px 12px;
    font-size: 0.66rem;
    font-family: ui-monospace, monospace;
    letter-spacing: 0.06em;
    cursor: pointer;
  }
  .map-btn:hover { background: rgba(74, 223, 255, 0.22); }
  .tool-btn {
    background: #2a2f3a;
    color: var(--text);
    border: 1px solid #404652;
    border-radius: 3px;
    padding: 3px 10px;
    font-size: 0.64rem;
    font-family: ui-monospace, monospace;
    letter-spacing: 0.04em;
    cursor: pointer;
  }
  .tool-btn:hover { background: #353c49; border-color: var(--cable-video, #4adfff); }
  .file-input {
    /* visually hidden but still clickable programmatically */
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
  .map-status {
    font-size: 0.6rem;
    font-family: ui-monospace, monospace;
    color: var(--cable-video, #4adfff);
  }
  .map-status.err { color: var(--red, #ff5a5a); }
  .legend {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 0 6px;
  }
  .legend-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 2px 4px;
    border-radius: 3px;
  }
  .legend-row.selected { background: rgba(255, 255, 255, 0.06); }
  .swatch-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    background: transparent;
    border: none;
    color: var(--text);
    cursor: pointer;
    padding: 2px 4px;
    font-size: 0.72rem;
    font-family: ui-monospace, monospace;
  }
  .swatch {
    width: 12px;
    height: 12px;
    border-radius: 2px;
    background: var(--c);
    border: 1px solid #0006;
    display: inline-block;
  }
  .legend-label { letter-spacing: 0.04em; }
  .legend-state {
    margin-left: 6px;
    font-size: 0.6rem;
    color: var(--text-dim, #889);
  }
  .legend-state.lit { color: var(--cable-video, #4adfff); }
  .fit-btn {
    margin-left: auto;
    min-width: 40px;
    background: transparent;
    border: 1px solid #404652;
    color: var(--text-dim, #99a);
    border-radius: 3px;
    padding: 1px 7px;
    font-size: 0.6rem;
    letter-spacing: 0.04em;
    font-family: ui-monospace, monospace;
    cursor: pointer;
  }
  .fit-btn:hover { color: var(--text); border-color: var(--cable-video); }
  .fit-btn.on {
    background: rgba(74, 223, 255, 0.12);
    border-color: var(--cable-video, #4adfff);
    color: var(--cable-video, #4adfff);
  }
  .reset-btn {
    background: transparent;
    border: 1px solid #404652;
    color: var(--text-dim, #99a);
    border-radius: 3px;
    padding: 1px 7px;
    font-size: 0.6rem;
    font-family: ui-monospace, monospace;
    cursor: pointer;
  }
  .reset-btn:hover { color: var(--text); border-color: var(--cable-video); }
</style>
