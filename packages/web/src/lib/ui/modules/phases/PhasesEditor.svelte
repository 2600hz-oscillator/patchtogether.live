<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import type { PhasesRuntimeState } from '$lib/audio/modules/phases';
  import { Knob } from '$lib/ui/controls';
  import { createDragCommit } from '$lib/ui/controls/drag-commit';
  import { onMeterFrame } from '$lib/ui/meter-frame';
  import { clampMenu, portal } from '$lib/ui/menu-viewport-action';
  import {
    evaluatePhasesEnvelope,
    PHASES_MAX_PHASES,
    type PhasesVertex,
  } from '../../../../../../dsp/src/lib/phases-dsp';
  import {
    readPhasesVertices, addPhasesVertex, setPhasesVertexY,
    setPhasesShape, removePhasesVertex,
  } from './phases-actions';
  import {
    PHASES_PLOT, PHASES_VIEWBOX, PHASES_COMPACT_PLOT, PHASES_COMPACT_VIEWBOX,
    phasesX as plotX, phasesY as plotY,
    phasesSegmentPath, phasesShapeName,
  } from './phases-editor-model';

  let { nodeId, compact = false }: { nodeId: string; compact?: boolean } = $props();
  let plot = $derived(compact ? PHASES_COMPACT_PLOT : PHASES_PLOT);
  const phasesX = (value: number): number => plotX(value, plot);
  const phasesY = (value: number): number => plotY(value, plot);
  const engine = useEngine();
  let svg: SVGSVGElement | undefined = $state();
  let root: HTMLDivElement | undefined = $state();
  let selectedX: number | null = $state(null);
  let runtime: PhasesRuntimeState | null = $state(null);
  let menu: { x: number; y: number; vertexX: number } | null = $state(null);
  let menuEl: HTMLDivElement | undefined = $state();
  let drag: { x: number; y: number; startY: number; pointerY: number; id: number } | null = $state(null);

  let stored = $derived.by(() => {
    void nodeVersion(nodeId);
    return readPhasesVertices(nodeId);
  });
  let vertices = $derived(stored.map((v) => drag && drag.x === v.x ? { ...v, y: drag.y } : v));
  let selectedIndex = $derived(vertices.findIndex((v, i) => v.x === selectedX && i < vertices.length - 1));
  let selected = $derived(selectedIndex >= 0 ? vertices[selectedIndex]! : null);
  let paths = $derived(vertices.slice(0, -1).map((v, i) => phasesSegmentPath(v, vertices[i + 1]!, plot)));
  let fill = $derived(paths.map((d, i) => i ? d.replace(/^M/, 'L') : d).join(' ')
    + ` L${phasesX(1)},${phasesY(0)} L${phasesX(0)},${phasesY(0)} Z`);
  let bipolar = $derived.by(() => {
    void nodeVersion(nodeId);
    return (patch.nodes[nodeId]?.params?.polarity ?? 0) >= 0.5;
  });
  let position = $derived.by(() => runtime?.position ?? 0);
  let playY = $derived(evaluatePhasesEnvelope(vertices, position));
  let deletable = $derived.by(() => menu !== null && menu.vertexX > 0 && menu.vertexX < 1);

  const dragCommit = createDragCommit((y) => {
    if (drag) setPhasesVertexY(nodeId, drag.x, y);
  });
  onDestroy(() => { dragCommit.flush(); dragCommit.dispose(); });
  onMount(() => {
    const frame = onMeterFrame(root ?? null, () => {
      const node = patch.nodes[nodeId];
      const next = node ? engine.get()?.read(node, 'state') as PhasesRuntimeState | undefined : undefined;
      if (next && (next.position !== runtime?.position || next.playing !== runtime?.playing
        || next.reverse !== runtime?.reverse || next.loop !== runtime?.loop)) runtime = { ...next };
    });
    return () => frame.stop();
  });

  function pointerPosition(event: PointerEvent): { x: number; y: number } {
    const matrix = svg?.getScreenCTM();
    if (!matrix) return { x: 0, y: 0 };
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return {
      x: Math.max(0, Math.min(1, (p.x - plot.left) / plot.width)),
      // Keep the raw pointer delta so off-centre grabs can reach both rails.
      y: 1 - (p.y - plot.top) / plot.height,
    };
  }

  function beginDrag(event: PointerEvent, vertex: PhasesVertex): void {
    if (event.button !== 0 || !svg) return;
    event.preventDefault(); event.stopPropagation();
    menu = null;
    selectedX = vertex.x === 1 ? vertices[vertices.length - 2]!.x : vertex.x;
    drag = { x: vertex.x, y: vertex.y, startY: vertex.y, pointerY: pointerPosition(event).y, id: event.pointerId };
    svg.setPointerCapture(event.pointerId);
  }

  function addVertex(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    menu = null;
    const x = pointerPosition(event).x;
    const vertex = addPhasesVertex(nodeId, x);
    if (vertex) beginDrag(event, vertex);
  }

  function moveVertex(event: PointerEvent): void {
    if (!drag || event.pointerId !== drag.id) return;
    event.preventDefault(); event.stopPropagation();
    drag.y = Math.max(0, Math.min(1, drag.startY + pointerPosition(event).y - drag.pointerY));
    dragCommit.commit(drag.y);
  }

  function endDrag(): void {
    if (!drag) return;
    dragCommit.flush();
    const pointerId = drag.id;
    drag = null;
    if (svg?.hasPointerCapture(pointerId)) svg.releasePointerCapture(pointerId);
  }

  function selectPhase(event: PointerEvent, x: number): void {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    menu = null; selectedX = x;
  }

  function openVertexMenu(event: MouseEvent, x: number): void {
    event.preventDefault(); event.stopPropagation();
    endDrag();
    menu = { x: event.clientX, y: event.clientY, vertexX: x };
  }

  function deleteVertex(): void {
    if (!menu) return;
    const nextSelection = removePhasesVertex(nodeId, menu.vertexX);
    if (nextSelection !== null) selectedX = nextSelection;
    menu = null;
    svg?.focus();
  }

  function vertexKey(event: KeyboardEvent, vertex: PhasesVertex): void {
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault(); event.stopPropagation();
      const next = removePhasesVertex(nodeId, vertex.x);
      if (next !== null) selectedX = next;
    } else if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      const step = event.shiftKey ? 0.1 : 0.01;
      const y = event.key === 'Home' ? 0 : event.key === 'End' ? 1
        : vertex.y + (event.key === 'ArrowUp' ? step : -step);
      setPhasesVertexY(nodeId, vertex.x, y);
    }
  }

  async function fire(key: 'trigger' | 'phaseTrigger'): Promise<void> {
    const liveEngine = engine.ensure ? await engine.ensure() : engine.get();
    const node = patch.nodes[nodeId];
    if (liveEngine && node) liveEngine.write(node, key, null);
  }

  $effect(() => {
    if (!menu || !menuEl) return;
    menuEl.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const outside = (event: PointerEvent) => {
      if (!menuEl?.contains(event.target as Node)) menu = null;
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); menu = null; svg?.focus(); }
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', escape, true);
    };
  });
</script>

<div class="phases-editor-wrap nodrag nowheel" class:compact bind:this={root}>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <svg
    class="phases-grid" bind:this={svg} viewBox={compact ? PHASES_COMPACT_VIEWBOX : PHASES_VIEWBOX} role="application" tabindex="0"
    aria-label={`Phases envelope, ${vertices.length - 1} of ${PHASES_MAX_PHASES} phases. Click the curve to add a vertex; drag vertically; click a phase background to select its shape; right-click a vertex to delete it.`}
    data-testid={`phases-editor-${nodeId}`}
    data-plot-left={plot.left} data-plot-top={plot.top}
    data-plot-width={plot.width} data-plot-height={plot.height}
    data-polarity={bipolar ? 'bipolar' : 'unipolar'}
    onpointermove={moveVertex} onpointerup={endDrag} onpointercancel={endDrag} onlostpointercapture={endDrag}
    oncontextmenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
  >
    <rect class="plot" x={plot.left} y={plot.top} width={plot.width} height={plot.height} rx="1" />
    {#each [0.25, 0.5, 0.75] as t (t)}
      <line class="grid-line" x1={phasesX(t)} x2={phasesX(t)} y1={phasesY(0)} y2={phasesY(1)} />
      <line class="grid-line" x1={phasesX(0)} x2={phasesX(1)} y1={phasesY(t)} y2={phasesY(t)} />
    {/each}
    {#each vertices.slice(0, -1) as vertex, index (vertex.x)}
      <rect
        class="phase-band" class:selected={selectedIndex === index}
        x={phasesX(vertex.x)} y={plot.top}
        width={phasesX(vertices[index + 1]!.x) - phasesX(vertex.x)} height={plot.height}
        role="button" tabindex="0" aria-label={`Select phase ${index + 1}`} aria-pressed={selectedIndex === index}
        data-testid={`phases-phase-${nodeId}-${index}`} data-shape={vertex.shape} data-selected={selectedIndex === index}
        onpointerdown={(event) => selectPhase(event, vertex.x)}
        onkeydown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); selectedX = vertex.x; } }}
      />
    {/each}
    <path class="envelope-fill" d={fill} />
    {#if bipolar}
      <line class="zero-line" x1={phasesX(0)} x2={phasesX(1)} y1={phasesY(0.5)} y2={phasesY(0.5)} data-testid={`phases-zero-${nodeId}`} />
    {/if}
    {#each paths as d, index (vertices[index]!.x)}
      <path class="envelope-line" {d} />
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <path class="curve-hit" {d} data-testid={`phases-curve-${nodeId}-${index}`} onpointerdown={addVertex} />
    {/each}
    {#each vertices as vertex, index (vertex.x)}
      <circle class="vertex-hit" cx={phasesX(vertex.x)} cy={phasesY(vertex.y)} r="6"
        role="slider" tabindex="0" aria-label={`Vertex ${index + 1} level`}
        aria-valuemin={0} aria-valuemax={1} aria-valuenow={vertex.y}
        data-testid={`phases-vertex-${nodeId}-${index}`} data-x={vertex.x} data-y={vertex.y}
        onpointerdown={(event) => beginDrag(event, vertex)} onkeydown={(event) => vertexKey(event, vertex)}
        oncontextmenu={(event) => openVertexMenu(event, vertex.x)}
      />
      <circle class="vertex" class:active={drag?.x === vertex.x} cx={phasesX(vertex.x)} cy={phasesY(vertex.y)} r="2.7" />
    {/each}
    <circle class="playhead" cx={phasesX(position)} cy={phasesY(playY)} r="3.8"
      data-testid={`phases-playhead-${nodeId}`} data-position={position} data-running={runtime?.playing ?? false}
      data-direction={runtime?.reverse ? 'reverse' : 'forward'}
    />
  </svg>
  <div class="editor-controls">
    <div class="trigger-actions">
      <button type="button" title="Trigger from the beginning" aria-label="Trigger envelope"
        data-testid={`phases-trigger-${nodeId}`} onclick={() => void fire('trigger')}>▶</button>
      <button type="button" title="Retrigger the current phase" aria-label="Trigger current phase"
        data-testid={`phases-retrigger-${nodeId}`} onclick={() => void fire('phaseTrigger')}>↶</button>
    </div>
    {#if selected}
      <div class="shape-control">
        <Knob value={selected.shape} min={0} max={1} defaultValue={0} label="Phase Shape"
          testid={`phases-shape-${nodeId}`} formatValue={phasesShapeName}
          onchange={(shape) => { if (selected) setPhasesShape(nodeId, selected.x, shape); }} />
      </div>
    {/if}
  </div>
</div>

{#if menu}
  <div use:portal>
    <div class="vertex-menu" bind:this={menuEl} use:clampMenu={{ x: menu.x, y: menu.y }}
      role="menu" aria-label="Envelope vertex" data-testid={`phases-vertex-menu-${nodeId}`}>
      <button type="button" role="menuitem" disabled={!deletable} onclick={deleteVertex}>Delete vertex</button>
    </div>
  </div>
{/if}

<style>
  .phases-editor-wrap { width: 336px; max-width: 100%; padding: 4px 0; box-sizing: border-box; }
  .phases-grid { display: block; width: 100%; height: auto; overflow: visible; touch-action: none; user-select: none; }
  .plot { fill: #22262a; stroke: #4b5056; stroke-width: 1; }
  .grid-line { stroke: #454a50; stroke-width: 0.65; pointer-events: none; }
  .phase-band { fill: transparent; cursor: pointer; }
  .phase-band.selected { fill: #ef546c; fill-opacity: 0.19; }
  .phase-band:focus-visible { stroke: #ef788a; stroke-width: 1; outline: none; }
  .envelope-fill { fill: #44cba4; fill-opacity: 0.24; pointer-events: none; }
  .envelope-line { fill: none; stroke: #56e0b4; stroke-width: 1.35; pointer-events: none; }
  .curve-hit { fill: none; stroke: transparent; stroke-width: 10; cursor: crosshair; }
  .zero-line { stroke: #ee5468; stroke-width: 0.9; pointer-events: none; }
  .vertex-hit { fill: transparent; cursor: ns-resize; outline: none; }
  .vertex-hit:focus-visible { stroke: #a3e9d0; stroke-width: 1; }
  .vertex { fill: #d8f8ec; stroke: #237f66; stroke-width: 0.8; pointer-events: none; }
  .vertex.active { fill: white; }
  .playhead { fill: #54adff; stroke: #123e6b; stroke-width: 1; pointer-events: none; }
  .editor-controls { display: flex; min-height: 54px; align-items: center; justify-content: space-between; padding: 0 12px; }
  .trigger-actions { display: flex; gap: 5px; }
  .trigger-actions button { width: 26px; height: 23px; border: 1px solid #46545b; border-radius: 3px; background: #20272c; color: #9adbcd; cursor: pointer; }
  .trigger-actions button:hover { background: #34434a; }
  .shape-control { display: flex; align-items: center; --accent: #ed7d90; }
  .compact { width: 100%; padding: 0 5px; }
  .compact .phases-grid { height: 28px; }
  .compact .editor-controls { min-height: 24px; height: 24px; padding: 0 5px; }
  .compact .trigger-actions button { width: 20px; height: 18px; font-size: 10px; padding: 0; }
  .compact .shape-control :global(.knob-wrap) { flex-direction: row; gap: 4px; }
  .compact .shape-control :global(.knob) { width: 23px; height: 23px; }
  .compact .shape-control :global(.label) { font-size: 7px; max-width: 32px; }
  .vertex-menu { position: fixed; z-index: 100000; min-width: 142px; padding: 4px; border: 1px solid #4f5a63; border-radius: 5px; background: #20262c; box-shadow: 0 6px 20px #0009; }
  .vertex-menu button { display: block; width: 100%; border: 0; background: transparent; padding: 8px 12px; text-align: left; color: #f3e6e8; font-size: 12px; cursor: pointer; }
  .vertex-menu button:hover, .vertex-menu button:focus-visible { background: #493039; outline: none; }
  .vertex-menu button:disabled { opacity: 0.35; cursor: default; }
</style>
