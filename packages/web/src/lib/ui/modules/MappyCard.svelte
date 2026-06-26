<script lang="ts">
  // MappyCard — UI for MAPPY (multi-surface manual projection mapper).
  //
  // Layout:
  //   * A live PREVIEW of the composite output (the canonical surface, pulled
  //     via blitOutputToDrawingBuffer — same pattern as QuadralogicalCard /
  //     BackdraftCard).
  //   * An SVG overlay on the preview: for every surface whose input is
  //     CONNECTED, four draggable corner DOTS + the quad outline, coloured per
  //     surface. Dragging a corner writes node.data.surfaces[i].corners[c] in
  //     NORMALIZED [0,1] output space (IN PLACE — never spread-reassigning the
  //     live Y object). A "selected" surface owns the on-top, opaque handles;
  //     the others draw dimmed so a busy 6-surface scene stays legible.
  //   * A surface LEGEND: one row per CONNECTED input (in1..in6) — its colour
  //     swatch, a focus/select toggle, and a "reset" (corners → full-frame).
  //   * A "show grid" toggle (numbered calibration grid in place of the input).
  //   * Ports via the yellow PatchPanel (no raw side jacks).

  import { onMount, onDestroy } from 'svelte';
  import { type NodeProps } from '@xyflow/svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { patch, ydoc } from '$lib/graph/store';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import type { ModuleNode } from '$lib/graph/types';
  import type { VideoEngine } from '$lib/video/engine';
  import { VIDEO_RES } from '$lib/video/engine';
  import {
    mappyDef,
    MAPPY_SURFACE_COUNT,
    MAPPY_MIN_SURFACES,
    MAPPY_INPUT_IDS,
    MAPPY_SURFACE_COLORS,
    normalizeSurfaces,
    surfaceFitOn,
    type MappySurfaceState,
  } from '$lib/video/modules/mappy';
  import {
    getSurfaceCount,
    addSurface,
    removeSurface,
    setCorner as editSetCorner,
    moveSurface as editMoveSurface,
    resetSurface as editResetSurface,
    toggleGrid as editToggleGrid,
    toggleSurfaceFit as editToggleSurfaceFit,
    applyMapLayout,
  } from './mappy-edit';
  import { serializeMap, parseMap, applyMap } from './mappy-map-io';
  import { hitTestSurfaces } from './mappy-hit';
  import MappyEditor from './MappyEditor.svelte';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  // ───────── reactive edges → which inputs are connected ─────────
  // patch.edges is a Yjs proxy; reading it in a $derived isn't reactive on its
  // own. Bump a $state signal from an edges-map observer (DoomCard/CubeCard
  // pattern) so the connected set re-derives when a cable is added/removed.
  let edgesVersion = $state(0);
  let connected = $derived<boolean[]>(
    (void edgesVersion,
      MAPPY_INPUT_IDS.map((portId) =>
        Object.values(patch.edges ?? {}).some(
          (e) => e?.target?.nodeId === id && e?.target?.portId === portId,
        ),
      )),
  );
  let anyConnected = $derived(connected.some(Boolean));
  let edgesObserver: (() => void) | null = null;
  function attachEdgesObserver(): void {
    try {
      const edgesMap = ydoc.getMap('edges');
      const handler = (): void => { edgesVersion++; };
      edgesMap.observeDeep(handler);
      edgesObserver = () => { try { edgesMap.unobserveDeep(handler); } catch { /* */ } };
      edgesVersion++;
    } catch { /* ydoc unavailable (test env) */ }
  }

  // ───────── surface state (node.data, reactive via the snapshot bus) ─────────
  let surfaces = $derived<MappySurfaceState[]>(
    normalizeSurfaces((node?.data as { surfaces?: unknown } | undefined)?.surfaces),
  );
  // per-surface FIT (true = zoom-fit default, false = crop/window). Independent
  // per surface — normalizeSurfaces fills `fit` (ON for old/missing data).
  let fits = $derived<boolean[]>(surfaces.map((s) => surfaceFitOn(s)));
  let showGrid = $derived<boolean>(
    ((node?.data as { showGrid?: unknown } | undefined)?.showGrid as boolean) ?? false,
  );
  let surfaceCount = $derived<number>(getSurfaceCount(node));
  /** A surface is LIVE (shown + editable) if it's within the surface count OR
   *  its input is connected (auto-activate on patch) — mirrors the engine. */
  let live = $derived<boolean[]>(
    Array.from({ length: MAPPY_SURFACE_COUNT }, (_, i) => i < surfaceCount || !!connected[i]),
  );

  let selected = $state(0); // which surface owns the on-top handles
  let editorOpen = $state(false);

  // ───────── edits (Yjs in-place via shared $lib/ui/modules/mappy-edit) ─────────
  function setCorner(surfaceIdx: number, cornerIdx: number, x: number, y: number): void {
    editSetCorner(id, surfaceIdx, cornerIdx, x, y);
  }
  function resetSurface(surfaceIdx: number): void {
    editResetSurface(id, surfaceIdx);
  }
  function toggleGrid(): void {
    editToggleGrid(id, showGrid);
  }
  function onToggleFit(surfaceIdx: number): void {
    editToggleSurfaceFit(id, surfaceIdx);
  }
  function onAdd(): void {
    selected = addSurface(id) - 1;
  }
  function onRemove(): void {
    removeSurface(id);
    if (selected >= surfaceCount - 1) selected = Math.max(0, surfaceCount - 2);
  }

  // ───────── export / import the surface LAYOUT (the venue map) ─────────
  // The "map" is the venue's projector-alignment: the COUNT of surfaces + each
  // surface's geometry + per-surface FIT. EXPORT downloads it as JSON; IMPORT
  // reads a file, validates it (foreign/garbage rejected with a non-crashing
  // message), and REPLACES the current layout via the in-place Yjs seam.
  // The (de)serialize/validate logic is the PURE mappy-map-io helper; only the
  // Blob/URL/file-picker glue lives here.
  let mapStatus = $state<{ kind: 'ok' | 'err'; text: string } | null>(null);
  let importInput: HTMLInputElement | null = $state(null);
  let statusTimer: ReturnType<typeof setTimeout> | null = null;

  function flashStatus(kind: 'ok' | 'err', text: string): void {
    mapStatus = { kind, text };
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { mapStatus = null; statusTimer = null; }, 4000);
  }

  function onExportMap(): void {
    try {
      const map = serializeMap(node?.data as { surfaces?: unknown; surfaceCount?: unknown } | undefined);
      const json = JSON.stringify(map, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `mappy-map-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // revoke on the next tick so the click has surely started the download
      setTimeout(() => URL.revokeObjectURL(url), 0);
      flashStatus('ok', `exported ${map.count} surface${map.count === 1 ? '' : 's'}`);
    } catch {
      flashStatus('err', 'export failed');
    }
  }

  function onImportClick(): void {
    importInput?.click();
  }

  async function onImportFile(ev: Event): Promise<void> {
    const input = ev.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    // reset so picking the SAME file again re-fires change
    input.value = '';
    if (!file) return;
    let text: string;
    try {
      text = await file.text();
    } catch {
      flashStatus('err', 'could not read file');
      return;
    }
    const parsed = parseMap(text);
    if (!parsed.ok) {
      flashStatus('err', `not a MAPPY map: ${parsed.error}`);
      return; // do NOT mutate on a foreign/garbage file
    }
    const layout = applyMap(parsed.map);
    applyMapLayout(id, layout);
    if (selected >= layout.count) selected = Math.max(0, layout.count - 1);
    flashStatus('ok', `imported ${layout.count} surface${layout.count === 1 ? '' : 's'}`);
  }

  // ───────── pointer drag — corner-pin OR whole-surface move ─────────
  // A single SVG-level pointer-down runs the shared hit-test (mappy-hit): a
  // pointer within grab range of a corner pins that corner (unchanged); else a
  // pointer inside a surface's quad MOVES the whole surface bodily (new). The
  // overlay shapes are pointer-events:none so this one handler owns hit-testing.
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
    const x = (ev.clientX - rect.left) / rect.width;
    // y is FLIPPED: corners live in the engine's y-UP uv space (vUv.y=1 = canvas
    // top), so a click near the visual top must map to a HIGH v — else the grid
    // renders mirrored vs the handle (the y-down/y-up mismatch).
    const y = 1 - (ev.clientY - rect.top) / rect.height;
    return { x, y };
  }
  function onOverlayDown(ev: PointerEvent): void {
    if (ev.button !== 0) return;
    const uv = uvFromPointer(ev);
    if (!uv) return;
    // grab radius in uv space — ~the on-card handle radius (7px) over the preview.
    const grabUv = 7 / CANVAS_W;
    const hit = hitTestSurfaces(surfaces, live, [uv.x, uv.y], grabUv, selected);
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
      setCorner(drag.surface, drag.corner, uv.x, uv.y);
    } else {
      editMoveSurface(id, drag.surface, uv.x - drag.lastX, uv.y - drag.lastY);
      drag.lastX = uv.x;
      drag.lastY = uv.y;
    }
  }
  function onHandleUp(ev: PointerEvent): void {
    if (!drag) return;
    try { svgEl?.releasePointerCapture?.(ev.pointerId); } catch { /* */ }
    drag = null;
  }

  // ───────── live composite preview ─────────
  const ENGINE_W = VIDEO_RES.width;
  const ENGINE_H = VIDEO_RES.height;
  const CANVAS_W = 320;
  const CANVAS_H = Math.round((CANVAS_W * ENGINE_H) / ENGINE_W);
  let canvasEl: HTMLCanvasElement | null = $state(null);
  let drawRaf: number | null = null;

  function draw(): void {
    drawRaf = null;
    const e = engineCtx.get();
    if (!e || !canvasEl) { drawRaf = requestAnimationFrame(draw); return; }
    let videoEngine: VideoEngine | undefined;
    try { videoEngine = e.getDomain<VideoEngine>('video'); } catch { drawRaf = requestAnimationFrame(draw); return; }
    if (!videoEngine) { drawRaf = requestAnimationFrame(draw); return; }
    const ctx2d = canvasEl.getContext('2d', { alpha: false });
    if (ctx2d) {
      try { videoEngine.blitOutputToDrawingBuffer(id); } catch { /* never nuke the loop */ }
      const src = videoEngine.canvas as CanvasImageSource;
      ctx2d.fillStyle = '#050608';
      ctx2d.fillRect(0, 0, canvasEl.width, canvasEl.height);
      // The preview is exactly the engine aspect (CANVAS_H derived from it), so
      // a straight stretch keeps the overlay's [0,1] uv == the canvas rect.
      ctx2d.drawImage(src, 0, 0, canvasEl.width, canvasEl.height);
    }
    drawRaf = requestAnimationFrame(draw);
  }

  onMount(() => {
    attachEdgesObserver();
    drawRaf = requestAnimationFrame(draw);
  });
  onDestroy(() => {
    if (drawRaf !== null) cancelAnimationFrame(drawRaf);
    edgesObserver?.();
    if (statusTimer) clearTimeout(statusTimer);
  });

  // ───────── overlay geometry helpers (uv [0,1] → preview px) ─────────
  function px(u: number): number { return u * CANVAS_W; }
  // y-UP: v=1 draws at the TOP (matches the engine's vUv space + the flipped
  // pointer in uvFromPointer), so handles sit exactly where the surface renders.
  function py(v: number): number { return (1 - v) * CANVAS_H; }
  /** SVG polygon points string for a surface's quad (TL→TR→BR→BL). */
  function quadPoints(s: MappySurfaceState): string {
    return s.corners.map((c) => `${px(c[0])},${py(c[1])}`).join(' ');
  }

  // ───────── patch panel ports ─────────
  const inputs: PortDescriptor[] = MAPPY_INPUT_IDS.map((portId, i) => ({
    id: portId,
    label: `IN${i + 1}`,
    cable: 'video',
  }));
  const outputs: PortDescriptor[] = [{ id: 'out', label: 'OUT', cable: 'video' }];

  void mappyDef; // referenced for parity with sibling cards
</script>

<div class="mod-card mappy-card" data-testid="mappy-card" data-node-id={id} data-show-grid={showGrid}>
  <div class="stripe" style="background: var(--cable-video);"></div>
  <ModuleTitle {id} {data} defaultLabel="MAPPY" />

  <PatchPanel nodeId={id} {inputs} {outputs} panelWidth={340}>
    <div class="body">
      <!-- composite preview + draggable corner overlay -->
      <div class="preview-wrap" style="width: {CANVAS_W}px; height: {CANVAS_H}px;">
        <canvas
          bind:this={canvasEl}
          width={CANVAS_W}
          height={CANVAS_H}
          data-testid="mappy-canvas"
          data-node-id={id}
        ></canvas>
        <!-- svelte-ignore a11y_no_static_element_interactions -->
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
          data-testid="mappy-overlay"
        >
          {#each surfaces as surf, i (i)}
            {#if live[i]}
              {@const color = MAPPY_SURFACE_COLORS[i]}
              {@const isSel = selected === i}
              <!-- quad outline + an interior fill so the move target reads (the
                   fill is faint; the whole SVG owns pointer-down hit-testing) -->
              <polygon
                points={quadPoints(surf)}
                fill={color}
                fill-opacity={isSel ? 0.08 : 0.03}
                stroke={color}
                stroke-width={isSel ? 2 : 1}
                stroke-opacity={isSel ? 0.95 : 0.4}
                data-testid={`mappy-quad-${i + 1}`}
              />
              {#each surf.corners as c, ci (ci)}
                <circle
                  class="handle"
                  cx={px(c[0])}
                  cy={py(c[1])}
                  r={isSel ? 7 : 5}
                  fill={color}
                  fill-opacity={isSel ? 0.95 : 0.45}
                  stroke="#0008"
                  stroke-width="1"
                  data-testid={`mappy-handle-${i + 1}-${ci}`}
                />
              {/each}
            {/if}
          {/each}
        </svg>
        {#if !anyConnected}
          <div class="empty-hint" data-testid="mappy-empty-hint">drag the grid corners to map · then connect IN1…IN6</div>
        {/if}
      </div>

      <!-- controls: surface count + MAP + grid toggle + per-surface legend -->
      <div class="controls">
        <div class="toolbar">
          <div class="count" data-testid="mappy-count">
            <button
              class="count-btn nodrag"
              type="button"
              onclick={onRemove}
              disabled={surfaceCount <= MAPPY_MIN_SURFACES}
              data-testid="mappy-remove"
              title="Remove the last surface"
            >−</button>
            <span class="count-n" data-testid="mappy-count-n">{surfaceCount}</span>
            <button
              class="count-btn nodrag"
              type="button"
              onclick={onAdd}
              disabled={surfaceCount >= MAPPY_SURFACE_COUNT}
              data-testid="mappy-add"
              title="Add a surface (up to 6)"
            >+</button>
          </div>
          <button
            class="map-btn nodrag"
            type="button"
            onclick={() => (editorOpen = true)}
            data-testid="mappy-open-editor"
            title="Open the full-window mapping editor for precise corner-pin"
          >MAP ⤢</button>
          <button
            class="grid-toggle nodrag"
            class:on={showGrid}
            type="button"
            onclick={toggleGrid}
            data-testid="mappy-grid-toggle"
            title="Force the numbered calibration grid on every surface"
          >GRID {showGrid ? 'ON' : 'OFF'}</button>
        </div>

        <!-- map I/O: save the surface LAYOUT (the venue projector-alignment) to
             disk + load it into a different patch at the same venue -->
        <div class="map-io" data-testid="mappy-map-io">
          <button
            class="map-io-btn nodrag"
            type="button"
            onclick={onExportMap}
            data-testid="mappy-export-map"
            title="Save the surface layout (count + corners + FIT) to a .json file — reuse it in another patch at the same venue"
          >export map</button>
          <button
            class="map-io-btn nodrag"
            type="button"
            onclick={onImportClick}
            data-testid="mappy-import-map"
            title="Load a surface layout from a .json file — REPLACES the current layout"
          >import map</button>
          <input
            bind:this={importInput}
            class="map-io-file"
            type="file"
            accept="application/json,.json"
            onchange={onImportFile}
            data-testid="mappy-import-file"
            tabindex="-1"
            aria-hidden="true"
          />
          {#if mapStatus}
            <span
              class="map-io-status"
              class:err={mapStatus.kind === 'err'}
              data-testid="mappy-map-status"
              data-status-kind={mapStatus.kind}
            >{mapStatus.text}</span>
          {/if}
        </div>

        <div class="legend" data-testid="mappy-legend">
          {#each surfaces as _surf, i (i)}
            {#if live[i]}
              <div class="legend-row" class:selected={selected === i} data-testid={`mappy-legend-${i + 1}`}>
                <button
                  class="swatch-btn nodrag"
                  type="button"
                  style="--c: {MAPPY_SURFACE_COLORS[i]};"
                  onclick={() => (selected = i)}
                  title={`Focus surface ${i + 1} (its corner handles come to front)`}
                  data-testid={`mappy-select-${i + 1}`}
                >
                  <span class="swatch"></span>
                  <span class="legend-label">IN{i + 1}</span>
                  <span class="legend-state" class:lit={connected[i]}>{connected[i] ? '● video' : '○ grid'}</span>
                </button>
                <button
                  class="fit-btn nodrag"
                  class:on={fits[i]}
                  type="button"
                  onclick={() => onToggleFit(i)}
                  title={fits[i]
                    ? `FIT ON — surface ${i + 1} zoom-fits the whole source into its box. Click for CROP (window the source at native scale).`
                    : `CROP — surface ${i + 1} windows the source at native scale (move to pan, resize to crop). Click for FIT (zoom-fit).`}
                  data-testid={`mappy-fit-${i + 1}`}
                >{fits[i] ? 'FIT' : 'CROP'}</button>
                <button
                  class="reset-btn nodrag"
                  type="button"
                  onclick={() => resetSurface(i)}
                  title={`Reset surface ${i + 1} corners to full-frame`}
                  data-testid={`mappy-reset-${i + 1}`}
                >reset</button>
              </div>
            {/if}
          {/each}
        </div>
      </div>
    </div>
  </PatchPanel>
</div>

{#if editorOpen}
  <MappyEditor {id} {node} {connected} onClose={() => (editorOpen = false)} />
{/if}

<style>
  .mappy-card { width: 380px; }
  .stripe {
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    border-radius: 2px 2px 0 0;
  }
  .body {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 10px;
    margin-top: 8px;
  }
  .preview-wrap {
    position: relative;
    align-self: center;
    border: 1px solid var(--cable-video);
    border-radius: 2px;
    overflow: hidden;
    background: #050608;
    line-height: 0;
  }
  .preview-wrap canvas {
    display: block;
    image-rendering: pixelated;
    background: #050608;
  }
  .overlay {
    position: absolute;
    inset: 0;
    touch-action: none;
    /* the SVG owns pointer-down hit-testing (corner vs. interior move); the
       shapes themselves don't intercept, so a single handler decides. `move`
       is the interior affordance — corners read as the handle dots. */
    cursor: move;
  }
  /* shapes are visual only — the SVG element handles all pointer events */
  .overlay polygon,
  .overlay .handle {
    pointer-events: none;
  }
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
  .controls {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 0 6px;
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .count {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    border: 1px solid #404652;
    border-radius: 3px;
    overflow: hidden;
  }
  .count-btn {
    background: #2a2f3a;
    color: var(--text);
    border: none;
    padding: 2px 9px;
    font-size: 0.9rem;
    line-height: 1;
    font-family: ui-monospace, monospace;
    cursor: pointer;
  }
  .count-btn:disabled { opacity: 0.35; cursor: not-allowed; }
  .count-btn:hover:not(:disabled) { background: #353c49; }
  .count-n {
    min-width: 16px;
    text-align: center;
    font-size: 0.74rem;
    font-family: ui-monospace, monospace;
    color: var(--text);
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
  .grid-toggle {
    background: #2a2f3a;
    color: var(--text);
    border: 1px solid #404652;
    border-radius: 3px;
    padding: 3px 10px;
    font-size: 0.66rem;
    font-family: ui-monospace, monospace;
    letter-spacing: 0.06em;
    cursor: pointer;
  }
  .grid-toggle.on {
    background: rgba(255, 220, 0, 0.15);
    border-color: var(--yellow, #ffd24a);
    color: var(--yellow, #ffd24a);
  }
  .map-io {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .map-io-btn {
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
  .map-io-btn:hover {
    background: #353c49;
    border-color: var(--cable-video, #4adfff);
  }
  .map-io-file {
    /* visually hidden but still focusable/clickable programmatically */
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
  .map-io-status {
    font-size: 0.6rem;
    font-family: ui-monospace, monospace;
    color: var(--cable-video, #4adfff);
  }
  .map-io-status.err {
    color: var(--red, #ff5a5a);
  }
  .legend-state {
    margin-left: 6px;
    font-size: 0.6rem;
    color: var(--text-dim, #889);
  }
  .legend-state.lit { color: var(--cable-video, #4adfff); }
  .legend {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .legend-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 2px 4px;
    border-radius: 3px;
  }
  .legend-row.selected {
    background: rgba(255, 255, 255, 0.06);
  }
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
  .legend-label {
    letter-spacing: 0.04em;
  }
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
