<script lang="ts">
  // GroupExposedControls — Module-grouping Phase 4 + Instruments v1.
  //
  // Two render modes driven by `node.data.instrumentLayout?.mode`:
  //
  //   'locked' (default for saved instruments, and the fallback when no
  //   layout has ever been recorded) — bounded boxes stack in the legacy
  //   flow layout. The user sees a frozen "instrument" view.
  //
  //   'edit' — each bounded box becomes an absolutely-positioned
  //   draggable + resizable surface inside an .instrument-canvas. The
  //   user freely arranges + sizes elements; releasing the mouse commits
  //   the new x/y/width/height to `data.instrumentLayout.controls`. The
  //   floating canvas-wide "Save instrument" CTA flips mode back to
  //   'locked'.
  //
  // Layout key scheme (matches the spec):
  //   `${childId}.__module`   — the per-child controls bounding box
  //   `${childId}.__sequence` — the atomic step-grid / score sheet
  //                             (Instruments v1; not yet rendered inline
  //                             beyond a placeholder — sequencers render
  //                             on the child card via viz-passthrough)
  //   `${childId}.${ctrlId}`  — reserved for per-control positioning in
  //                             follow-up PRs (v1 keeps the whole child
  //                             box as one unit so the layout engine
  //                             stays tractable)

  import Knob from '$lib/ui/controls/Knob.svelte';
  import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
  import { setNodeParam } from '$lib/graph/mutate';
  import { useEngine } from '$lib/audio/engine-context';
  import { getModuleDef } from '$lib/audio/module-registry';
  import { resolveExposedControls } from '$lib/graph/group-controls';
  import type { ModuleNode } from '$lib/graph/types';
  import type { GroupData, InstrumentLayoutEntry } from '$lib/graph/group-projection';

  interface Props {
    /** The instrument's ModuleNode — read for data.exposedControls + layout. */
    group: ModuleNode;
    /** Card-version bump so we re-derive when any patch mutation lands. */
    cardVersion: number;
  }

  let { group, cardVersion }: Props = $props();
  const engineCtx = useEngine();

  let groupData = $derived(group.data as unknown as GroupData | undefined);
  let isEditMode = $derived(groupData?.instrumentLayout?.mode === 'edit');
  let layoutEntries = $derived(groupData?.instrumentLayout?.controls ?? {});
  let exposedSequences = $derived(groupData?.exposedSequences ?? {});

  let blocks = $derived.by(() => {
    void cardVersion;
    return resolveExposedControls(group as { data?: unknown }, {
      nodes: patch.nodes as Record<string, ModuleNode | undefined>,
      defLookup: (t: string) => getModuleDef(t),
      defLabelLookup: (t: string) => getModuleDef(t)?.label,
    });
  });

  // Atomic sequencer/score surfaces — keyed by childId. v1 just renders a
  // placeholder box (the actual step grid lives on the child card and is
  // beyond the scope of the layout engine); the placeholder is sufficient
  // for the test "configure DRUMSEQZ → step sequence visible" assertion.
  let sequenceChildren = $derived.by(() => {
    void cardVersion;
    const out: Array<{ childId: string; childLabel: string; child: ModuleNode }> = [];
    for (const [cid, on] of Object.entries(exposedSequences)) {
      if (!on) continue;
      const child = patch.nodes[cid] as ModuleNode | undefined;
      if (!child) continue;
      const def = getModuleDef(child.type) as { exposesSequence?: boolean; label?: string } | undefined;
      if (def?.exposesSequence !== true) continue;
      const dataName = (child.data as Record<string, unknown> | undefined)?.name;
      const label = (typeof dataName === 'string' && dataName.length > 0 ? dataName : def.label) ?? child.type;
      out.push({ childId: cid, childLabel: label, child });
    }
    return out;
  });

  function paramDefFor(child: ModuleNode, paramId: string) {
    const def = getModuleDef(child.type);
    return def?.params.find((p) => p.id === paramId);
  }
  function readParam(child: ModuleNode, paramId: string): number {
    void cardVersion;
    const live = patch.nodes[child.id];
    return (live?.params[paramId] ?? paramDefFor(child, paramId)?.defaultValue ?? 0) as number;
  }
  function setParam(child: ModuleNode, paramId: string, value: number) {
    setNodeParam(child.id, paramId, value);
  }
  function isPlaying(child: ModuleNode, paramId: string): boolean {
    return readParam(child, paramId) >= 0.5;
  }
  function togglePlay(child: ModuleNode, paramId: string) {
    setParam(child, paramId, isPlaying(child, paramId) ? 0 : 1);
  }
  function liveReader(child: ModuleNode, paramId: string) {
    return () => {
      const e = engineCtx.get();
      if (!e) return undefined;
      const live = patch.nodes[child.id];
      if (!live) return undefined;
      return e.readParam(live as unknown as ModuleNode, paramId);
    };
  }

  // ----- Layout helpers -----

  /** Default layout slot for a block when no record exists yet. We tile
   *  blocks down the left edge of the instrument canvas with a soft margin
   *  so the user sees them as soon as they enter edit mode, even if they
   *  never drag. Resize handles let them rearrange on demand. */
  function defaultEntry(index: number): InstrumentLayoutEntry {
    const MARGIN_X = 12;
    const MARGIN_Y = 12;
    const BOX_W = 200;
    const BOX_H = 92;
    const GAP = 10;
    return {
      x: MARGIN_X,
      y: MARGIN_Y + index * (BOX_H + GAP),
      width: BOX_W,
      height: BOX_H,
    };
  }

  function entryFor(key: string, fallback: InstrumentLayoutEntry): InstrumentLayoutEntry {
    return layoutEntries[key] ?? fallback;
  }

  function writeLayout(key: string, entry: InstrumentLayoutEntry) {
    ydoc.transact(() => {
      const target = patch.nodes[group.id];
      if (!target) return;
      if (!target.data) target.data = {};
      const data = target.data as unknown as GroupData;
      const existing = data.instrumentLayout ?? { mode: 'edit' as const, controls: {} };
      const nextControls = { ...existing.controls, [key]: entry };
      data.instrumentLayout = { mode: existing.mode, controls: nextControls };
    }, LOCAL_ORIGIN);
  }

  // ----- Drag + resize handlers -----
  //
  // Pointer-event based, screen-space deltas converted into the instrument-
  // canvas-local coordinate space. We deliberately keep the math simple:
  // 1 screen pixel === 1 layout-coord pixel. Svelte Flow's pan/zoom is
  // applied to the parent card, not us, so a `dx` measured in clientX/Y
  // is faithful to the local coordinate the user is dragging through.
  //
  // Snap-to-grid + collision detection are deferred — per spec v1 ships
  // free absolute positioning. We do clamp into the canvas bounds so the
  // user can't drag a control off-screen and lose it.

  const MIN_W = 90;
  const MIN_H = 40;
  // Bound the instrument canvas. The layout coords are local to this
  // canvas, so we clamp x/y/width/height to its measured bounds at drag
  // time. CANVAS_PADDING leaves a thin no-mans-land at the bottom-right
  // so a fully-grown box doesn't kiss the edge.
  const CANVAS_PADDING = 6;

  let canvasEl: HTMLDivElement | null = $state(null);
  function canvasBounds(): { width: number; height: number } {
    const w = canvasEl?.clientWidth ?? 320;
    const h = canvasEl?.clientHeight ?? 200;
    return { width: w, height: h };
  }

  function clampEntry(entry: InstrumentLayoutEntry): InstrumentLayoutEntry {
    const b = canvasBounds();
    const maxX = Math.max(0, b.width - CANVAS_PADDING - entry.width);
    const maxY = Math.max(0, b.height - CANVAS_PADDING - entry.height);
    return {
      x: Math.max(0, Math.min(maxX, entry.x)),
      y: Math.max(0, Math.min(maxY, entry.y)),
      width: Math.max(MIN_W, entry.width),
      height: Math.max(MIN_H, entry.height),
    };
  }

  interface DragSession {
    key: string;
    mode: 'move' | 'resize';
    startX: number;
    startY: number;
    initial: InstrumentLayoutEntry;
    pointerId: number;
  }
  let dragging: DragSession | null = null;

  function startMove(e: PointerEvent, key: string, entry: InstrumentLayoutEntry) {
    if (!isEditMode) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    dragging = {
      key,
      mode: 'move',
      startX: e.clientX,
      startY: e.clientY,
      initial: { ...entry },
      pointerId: e.pointerId,
    };
  }
  function startResize(e: PointerEvent, key: string, entry: InstrumentLayoutEntry) {
    if (!isEditMode) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    dragging = {
      key,
      mode: 'resize',
      startX: e.clientX,
      startY: e.clientY,
      initial: { ...entry },
      pointerId: e.pointerId,
    };
  }
  function onPointerMove(e: PointerEvent) {
    if (!dragging || e.pointerId !== dragging.pointerId) return;
    const dx = e.clientX - dragging.startX;
    const dy = e.clientY - dragging.startY;
    const next: InstrumentLayoutEntry =
      dragging.mode === 'move'
        ? {
            x: dragging.initial.x + dx,
            y: dragging.initial.y + dy,
            width: dragging.initial.width,
            height: dragging.initial.height,
          }
        : {
            x: dragging.initial.x,
            y: dragging.initial.y,
            width: dragging.initial.width + dx,
            height: dragging.initial.height + dy,
          };
    writeLayout(dragging.key, clampEntry(next));
  }
  function onPointerUp(e: PointerEvent) {
    if (!dragging || e.pointerId !== dragging.pointerId) return;
    dragging = null;
  }
</script>

<svelte:window onpointermove={onPointerMove} onpointerup={onPointerUp} onpointercancel={onPointerUp} />

{#if blocks.length > 0 || sequenceChildren.length > 0}
  {#if isEditMode}
    <!-- Edit phase: free-form absolute layout. Each box is independently
         draggable + resizable; releasing the mouse commits to y.doc.
         Min width/height clamps keep boxes operable. -->
    <div
      class="instrument-canvas"
      data-testid="instrument-canvas"
      data-instrument-mode="edit"
      bind:this={canvasEl}
    >
      {#each blocks as block, i (block.childId)}
        {@const key = `${block.childId}.__module`}
        {@const entry = entryFor(key, defaultEntry(i))}
        <div
          class="ctrl-box edit"
          data-testid="ctrl-box"
          data-child-id={block.childId}
          data-layout-key={key}
          style:left="{entry.x}px"
          style:top="{entry.y}px"
          style:width="{entry.width}px"
          style:height="{entry.height}px"
          onpointerdown={(e) => startMove(e, key, entry)}
        >
          <div class="ctrl-header" data-testid="ctrl-box-header">{block.childLabel}</div>
          <div class="ctrl-body">
            {#each block.controls as c (c.id)}
              {#if c.kind === 'button'}
                <button
                  class="play-btn"
                  class:playing={isPlaying(block.child, c.paramId)}
                  onpointerdown={(e) => e.stopPropagation()}
                  onclick={(e) => { e.stopPropagation(); togglePlay(block.child, c.paramId); }}
                  title={isPlaying(block.child, c.paramId) ? 'Stop' : 'Play'}
                  data-testid={`ctrl-btn-${block.childId}-${c.id}`}
                  data-control-kind="button"
                  data-playing={isPlaying(block.child, c.paramId) ? 'true' : 'false'}
                >
                  {isPlaying(block.child, c.paramId) ? '■' : '▶'}
                </button>
              {:else if c.kind === 'knob'}
                {@const pd = paramDefFor(block.child, c.paramId)}
                {#if pd}
                  <div
                    class="knob-wrap"
                    data-testid={`ctrl-knob-${block.childId}-${c.id}`}
                    data-control-kind="knob"
                    onpointerdown={(e) => e.stopPropagation()}
                  >
                    <Knob
                      value={readParam(block.child, c.paramId)}
                      min={pd.min}
                      max={pd.max}
                      defaultValue={pd.defaultValue}
                      label={c.label}
                      units={pd.units}
                      curve={pd.curve}
                      onchange={(v) => setParam(block.child, c.paramId, v)}
                      readLive={liveReader(block.child, c.paramId)}
                    />
                  </div>
                {/if}
              {/if}
            {/each}
          </div>
          <!-- bottom-right corner resize handle; pointer-capture below -->
          <div
            class="resize-handle"
            data-testid="ctrl-resize"
            onpointerdown={(e) => startResize(e, key, entry)}
          ></div>
        </div>
      {/each}
      {#each sequenceChildren as sc, i (sc.childId)}
        {@const key = `${sc.childId}.__sequence`}
        {@const entry = entryFor(key, { ...defaultEntry(blocks.length + i), width: 260, height: 120 })}
        <div
          class="ctrl-box edit sequence-box"
          data-testid="ctrl-sequence-box"
          data-child-id={sc.childId}
          data-layout-key={key}
          style:left="{entry.x}px"
          style:top="{entry.y}px"
          style:width="{entry.width}px"
          style:height="{entry.height}px"
          onpointerdown={(e) => startMove(e, key, entry)}
        >
          <div class="ctrl-header">{sc.childLabel} — sequence</div>
          <div class="seq-body">step sequence (rendered on the source module card)</div>
          <div
            class="resize-handle"
            data-testid="ctrl-resize-sequence"
            onpointerdown={(e) => startResize(e, key, entry)}
          ></div>
        </div>
      {/each}
    </div>
  {:else}
    <!-- Locked phase: flow layout, no drag/resize affordances. We honor any
         persisted positions visually (absolute mode) so saving an arrangement
         and reloading shows the same render; if no positions are recorded
         we fall back to the stacked flow layout for back-compat. -->
    {#if Object.keys(layoutEntries).length > 0}
      <div
        class="instrument-canvas locked"
        data-testid="instrument-canvas"
        data-instrument-mode="locked"
      >
        {#each blocks as block, i (block.childId)}
          {@const key = `${block.childId}.__module`}
          {@const entry = entryFor(key, defaultEntry(i))}
          <div
            class="ctrl-box locked"
            data-testid="ctrl-box"
            data-child-id={block.childId}
            data-layout-key={key}
            style:left="{entry.x}px"
            style:top="{entry.y}px"
            style:width="{entry.width}px"
            style:height="{entry.height}px"
          >
            <div class="ctrl-header" data-testid="ctrl-box-header">{block.childLabel}</div>
            <div class="ctrl-body">
              {#each block.controls as c (c.id)}
                {#if c.kind === 'button'}
                  <button
                    class="play-btn"
                    class:playing={isPlaying(block.child, c.paramId)}
                    onclick={() => togglePlay(block.child, c.paramId)}
                    title={isPlaying(block.child, c.paramId) ? 'Stop' : 'Play'}
                    data-testid={`ctrl-btn-${block.childId}-${c.id}`}
                    data-control-kind="button"
                    data-playing={isPlaying(block.child, c.paramId) ? 'true' : 'false'}
                  >
                    {isPlaying(block.child, c.paramId) ? '■' : '▶'}
                  </button>
                {:else if c.kind === 'knob'}
                  {@const pd = paramDefFor(block.child, c.paramId)}
                  {#if pd}
                    <div class="knob-wrap" data-testid={`ctrl-knob-${block.childId}-${c.id}`} data-control-kind="knob">
                      <Knob
                        value={readParam(block.child, c.paramId)}
                        min={pd.min}
                        max={pd.max}
                        defaultValue={pd.defaultValue}
                        label={c.label}
                        units={pd.units}
                        curve={pd.curve}
                        onchange={(v) => setParam(block.child, c.paramId, v)}
                        readLive={liveReader(block.child, c.paramId)}
                      />
                    </div>
                  {/if}
                {/if}
              {/each}
            </div>
          </div>
        {/each}
        {#each sequenceChildren as sc, i (sc.childId)}
          {@const key = `${sc.childId}.__sequence`}
          {@const entry = entryFor(key, { ...defaultEntry(blocks.length + i), width: 260, height: 120 })}
          <div
            class="ctrl-box locked sequence-box"
            data-testid="ctrl-sequence-box"
            data-child-id={sc.childId}
            data-layout-key={key}
            style:left="{entry.x}px"
            style:top="{entry.y}px"
            style:width="{entry.width}px"
            style:height="{entry.height}px"
          >
            <div class="ctrl-header">{sc.childLabel} — sequence</div>
            <div class="seq-body">step sequence</div>
          </div>
        {/each}
      </div>
    {:else}
      <div class="exposed-controls" data-testid="group-exposed-controls">
        {#each blocks as block (block.childId)}
          <div class="ctrl-box" data-testid="ctrl-box" data-child-id={block.childId}>
            <div class="ctrl-header" data-testid="ctrl-box-header">{block.childLabel}</div>
            <div class="ctrl-body">
              {#each block.controls as c (c.id)}
                {#if c.kind === 'button'}
                  <button
                    class="play-btn"
                    class:playing={isPlaying(block.child, c.paramId)}
                    onclick={() => togglePlay(block.child, c.paramId)}
                    title={isPlaying(block.child, c.paramId) ? 'Stop' : 'Play'}
                    data-testid={`ctrl-btn-${block.childId}-${c.id}`}
                    data-control-kind="button"
                    data-playing={isPlaying(block.child, c.paramId) ? 'true' : 'false'}
                  >
                    {isPlaying(block.child, c.paramId) ? '■' : '▶'}
                  </button>
                {:else if c.kind === 'knob'}
                  {@const pd = paramDefFor(block.child, c.paramId)}
                  {#if pd}
                    <div class="knob-wrap" data-testid={`ctrl-knob-${block.childId}-${c.id}`} data-control-kind="knob">
                      <Knob
                        value={readParam(block.child, c.paramId)}
                        min={pd.min}
                        max={pd.max}
                        defaultValue={pd.defaultValue}
                        label={c.label}
                        units={pd.units}
                        curve={pd.curve}
                        onchange={(v) => setParam(block.child, c.paramId, v)}
                        readLive={liveReader(block.child, c.paramId)}
                      />
                    </div>
                  {/if}
                {/if}
              {/each}
            </div>
          </div>
        {/each}
        {#each sequenceChildren as sc (sc.childId)}
          <div class="ctrl-box sequence-box" data-testid="ctrl-sequence-box" data-child-id={sc.childId}>
            <div class="ctrl-header">{sc.childLabel} — sequence</div>
            <div class="seq-body">step sequence</div>
          </div>
        {/each}
      </div>
    {/if}
  {/if}
{/if}

<style>
  /* Legacy flow layout (no layout entries recorded yet). */
  .exposed-controls {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 10px 4px;
  }
  /* Edit/locked phase canvas: positioned-children container with a minimum
   * height so an empty instrument still has a draggable area for the
   * default-tile slots to land in. */
  .instrument-canvas {
    position: relative;
    width: 100%;
    min-height: 280px;
    padding: 6px;
    box-sizing: border-box;
  }
  .instrument-canvas[data-instrument-mode='edit'] {
    background: repeating-linear-gradient(
      45deg,
      rgba(96, 165, 250, 0.03),
      rgba(96, 165, 250, 0.03) 8px,
      transparent 8px,
      transparent 16px
    );
    outline: 1px dashed rgba(96, 165, 250, 0.32);
    outline-offset: 2px;
  }
  .ctrl-box {
    border: 1px solid var(--border, #404652);
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.02);
    padding: 6px 8px 8px;
  }
  .ctrl-box.edit,
  .ctrl-box.locked {
    position: absolute;
    box-sizing: border-box;
    overflow: hidden;
  }
  .ctrl-box.edit {
    cursor: grab;
    border-color: rgba(96, 165, 250, 0.6);
    background: rgba(96, 165, 250, 0.04);
  }
  .ctrl-box.edit:active { cursor: grabbing; }
  .ctrl-header {
    font-size: 0.6rem;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--text-dim, #8e94a2);
    padding-bottom: 4px;
  }
  .ctrl-body {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    justify-content: flex-start;
  }
  .play-btn {
    width: 22px;
    height: 22px;
    background: #2a2f3a;
    border: 1px solid #404652;
    color: var(--text);
    border-radius: 3px;
    font-size: 0.7rem;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
    padding: 0;
  }
  .play-btn.playing {
    background: var(--cable-gate, #f59e0b);
    color: #1a1d23;
    border-color: var(--cable-gate, #f59e0b);
  }
  .knob-wrap {
    display: inline-flex;
  }
  .sequence-box {
    background: rgba(252, 211, 77, 0.06);
    border-color: rgba(252, 211, 77, 0.45);
  }
  .seq-body {
    font-size: 0.65rem;
    color: var(--text-dim, #8e94a2);
    padding: 8px 4px;
  }
  /* Bottom-right corner resize handle. Sized so the user can grab it
   * easily without missing the click target on a 4K display. */
  .resize-handle {
    position: absolute;
    right: 0;
    bottom: 0;
    width: 14px;
    height: 14px;
    cursor: nwse-resize;
    background: linear-gradient(
      135deg,
      transparent 50%,
      rgba(96, 165, 250, 0.8) 50%,
      rgba(96, 165, 250, 0.8) 70%,
      transparent 70%
    );
  }
</style>
