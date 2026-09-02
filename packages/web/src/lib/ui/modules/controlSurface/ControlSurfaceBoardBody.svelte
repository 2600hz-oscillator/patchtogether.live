<script lang="ts">
  // CONTROL SURFACE BOARD BODY — the free-form pointer board, at the head of
  // the dock full view (`ShellExtension.fullViewBody`).
  //
  // This is `ControlSurfaceCard.svelte`'s board block — the group boxes, the
  // proxied Knobs, the passthrough colour stripes, the per-knob rename and the
  // drag layout — lifted with its `cardVersion` pump intact. The title bar does
  // NOT come with it (the shell owns that), and neither does the LOCK button —
  // that is the ranked faceplate cell now (`control-surface-lock-{n}` in
  // shell-cells.ts), which is what puts the lock on the lane tile too.
  //
  // ⚠ PORTED, NOT REDESIGNED. Three renderers proxy this module's pointers —
  // this body, the legacy card (still live under `?shell=legacy` and in the
  // dock rail for a USER-DOCKED node) and the Electra flash pipeline — and
  // every write goes through the SAME in-place mutators
  // ($lib/graph/control-surface): `setSurfaceGroupPosition`, `setBindingName`,
  // `resolveSurfaceParam().set`. Nothing here spreads a live Yjs array — the
  // "Type already integrated" crash class the graph module's CRITICAL note
  // records as SHIPPED history.
  //
  // ⚠ EVERY PROXIED KNOB PASSES AN EXPLICIT `testid`, AND THAT IS LOAD-BEARING,
  // NOT COSMETIC. `Knob.svelte` emits `data-testid="control-<paramId>"`
  // whenever `paramId` is passed (and `paramId` MUST be passed — it is also the
  // MIDI-learn binding key), and `faces-parity` asserts EXACT MULTISET EQUALITY
  // between the dock's `[data-testid^="control-"]` elements and THIS def's
  // param ids — which is `[]`. One bound proxy without the override fails the
  // whole face. For the same reason NO testid in this file may start with
  // `control-` — the card's own `control-surface-*` vocabulary is therefore NOT
  // reused here (the one deliberate testid divergence between the surfaces);
  // this body's namespace is `cs-board-*`.
  //
  // ⚠ THE PRUNE EFFECT IS NOT HERE — IT IS IN THE `tileBody`
  // (ControlSurfaceTileBody.svelte), deliberately: this body mounts only while
  // the dock full view is open, and the lane tile is the surface that is
  // mounted whenever the node is on canvas. Putting the prune here would have
  // reproduced the ES-9 shape (a side effect alive only while a human is
  // looking at the one surface that carries it).
  //
  // ⚠ NO PICTURE IS DRAWN HERE AND NONE MAY BE ADDED. This body's declared role
  // is `control-grid` (`face-rack-status-source.test.ts`), whose predicate
  // requires accessible names and no drawing surface — and the predicate GREPS
  // RAW SOURCE, so this sentence spells the tag out in words rather than
  // writing it. Beyond the gate: WebGL attest basis membership is derived from
  // CONTENT, so a drawn body would enrol a meta module in the GPU attest.
  //
  // ⚠ THE SEMANTICS LIVE ON `aria-label`, per the resting-text ruling. The
  // visible text on this surface is exhaustively: each group's SOURCE-MODULE
  // label, each knob's own caption (a `label` prop consumed by Knob.svelte),
  // the ✎ rename affordance, and the EMPTY-STATE instruction naming the
  // right-click "Send to …" gesture — the module's only discovery path, the
  // midiclock empty-state licence. No value, no measurement, no state word.

  import Knob from '$lib/ui/controls/Knob.svelte';
  import { patch } from '$lib/graph/store';
  import { nodeVersion, nodesStructuralVersion } from '$lib/graph/node-versions.svelte';
  import { setNodeParam } from '$lib/graph/mutate';
  import { useEngine } from '$lib/audio/engine-context';
  import { getModuleDef } from '$lib/audio/module-registry';
  import { getVideoModuleDef } from '$lib/video/module-registry';
  import type { ModuleNode, ParamDef } from '$lib/graph/types';
  import {
    readSurfaceData,
    groupBindingsByModule,
    setSurfaceGroupPosition,
    setBindingName,
  } from '$lib/graph/control-surface';
  import {
    BOX_W,
    KNOB_CELL_W,
    KNOBS_PER_ROW,
    KNOB_ROW_H,
    KNOB_GRID_GAP,
    posFor as layoutPosFor,
    unlockedCanvasSize,
  } from '$lib/graph/control-surface-layout';
  import { resolveSurfaceParam } from '$lib/graph/control-surface-params';
  import { resolveControlColor } from '$lib/graph/control-color';

  let { nodeId }: { nodeId: string } = $props();
  const engineCtx = useEngine();

  // Bounded node-scoped re-derive — the card's `cardVersion` pump, verbatim:
  // own node + every bound SOURCE module + node add/remove. It is what makes a
  // proxied knob track the real knob live, a source rename or colour change
  // repaint, and a remote binding add appear instantly. A body that omitted it
  // would render a board that never notices any of those — and a
  // node.data-level unit test would pass on it.
  let cardVersion = $derived.by(() => {
    let v = nodeVersion(nodeId) + nodesStructuralVersion();
    const seen = new Set<string>();
    for (const b of readSurfaceData(patch.nodes[nodeId]).bindings ?? []) {
      if (seen.has(b.moduleId)) continue;
      seen.add(b.moduleId);
      v += nodeVersion(b.moduleId);
    }
    return v;
  });

  let surfaceData = $derived.by(() => {
    void cardVersion;
    return readSurfaceData(patch.nodes[nodeId]);
  });
  // Read `locked` THROUGH cardVersion, not off `surfaceData`: setSurfaceLocked
  // mutates node.data.locked IN PLACE, so surfaceData returns the SAME object
  // reference and a `$derived(surfaceData.locked)` would short-circuit — the
  // measured card bug where unlock appeared to do nothing.
  let locked = $derived.by(() => {
    void cardVersion;
    return readSurfaceData(patch.nodes[nodeId]).locked ?? false;
  });

  // Display name for a source module (its renamed name, else def label, else type).
  function sourceLabel(sourceId: string): string {
    const n = patch.nodes[sourceId] as ModuleNode | undefined;
    if (!n) return sourceId;
    const nm = (n.data as Record<string, unknown> | undefined)?.name;
    if (typeof nm === 'string' && nm.trim().length > 0) return nm;
    const def = getModuleDef(n.type) ?? getVideoModuleDef(n.type);
    return def?.label ?? n.type;
  }

  interface RenderControl {
    paramId: string;
    label: string;
    customName: string;
    def: ParamDef;
  }
  interface RenderGroup {
    moduleId: string;
    label: string;
    /** The SOURCE module's resolved control colour, read LIVE as PASSTHROUGH —
     *  never stored on the surface. */
    color: string;
    controls: RenderControl[];
  }

  // Live groups: bindings grouped by module, dangling sources dropped, each
  // binding resolved THROUGH the param adapter so flat node.params sources and
  // nested node.data sources (TOYBOX) both land on the live location the
  // source's own knobs use.
  let groups = $derived.by<RenderGroup[]>(() => {
    void cardVersion;
    const out: RenderGroup[] = [];
    for (const g of groupBindingsByModule(surfaceData.bindings ?? [])) {
      const sourceNode = patch.nodes[g.moduleId] as ModuleNode | undefined;
      if (!sourceNode) continue; // source deleted → drop the whole group
      const controls: RenderControl[] = [];
      for (const b of g.bindings) {
        const resolved = resolveSurfaceParam(sourceNode, b.paramId);
        if (!resolved) continue;
        const custom = typeof b.name === 'string' ? b.name.trim() : '';
        const baseLabel = resolved.def.label ?? b.paramId;
        controls.push({
          paramId: b.paramId,
          label: custom.length > 0 ? custom : baseLabel,
          customName: custom,
          def: resolved.def,
        });
      }
      if (controls.length === 0) continue;
      const color = resolveControlColor(sourceNode);
      out.push({ moduleId: g.moduleId, label: sourceLabel(g.moduleId), color, controls });
    }
    return out;
  });

  let isEmpty = $derived(groups.length === 0);
  let surfaceTitle = $derived(surfaceData.name ?? 'Control Surface');

  // ── live param read / write (the pointer mechanism) — the card's, verbatim ──
  function readParam(sourceId: string, paramId: string, def: ParamDef): number {
    void cardVersion;
    const live = patch.nodes[sourceId] as ModuleNode | undefined;
    const resolved = resolveSurfaceParam(live, paramId);
    if (resolved) return resolved.get();
    return (live?.params[paramId] ?? def.defaultValue ?? 0) as number;
  }
  function setParam(sourceId: string, paramId: string, value: number) {
    const live = patch.nodes[sourceId] as ModuleNode | undefined;
    const resolved = resolveSurfaceParam(live, paramId);
    if (resolved) { resolved.set(value); return; }
    setNodeParam(sourceId, paramId, value);
  }
  function liveReader(sourceId: string, paramId: string) {
    return () => {
      const live = patch.nodes[sourceId] as ModuleNode | undefined;
      if (!live) return undefined;
      const e = engineCtx.get();
      const fromEngine = e ? e.readParam(live, paramId) : undefined;
      if (typeof fromEngine === 'number') return fromEngine;
      return resolveSurfaceParam(live, paramId)?.get();
    };
  }

  // ── layout — LOCKED flows and wraps; UNLOCKED is absolute + draggable ──
  function posFor(moduleId: string, index: number): { x: number; y: number } {
    return layoutPosFor(surfaceData.layout, moduleId, index);
  }
  let unlockedSize = $derived.by(() => {
    void cardVersion;
    return unlockedCanvasSize(
      groups.map((g) => ({ moduleId: g.moduleId, knobCount: g.controls.length })),
      surfaceData.layout,
    );
  });

  interface DragSession { moduleId: string; startX: number; startY: number; initX: number; initY: number; pointerId: number; }
  let drag: DragSession | null = $state(null);

  function startDrag(e: PointerEvent, moduleId: string, pos: { x: number; y: number }) {
    if (locked) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag = { moduleId, startX: e.clientX, startY: e.clientY, initX: pos.x, initY: pos.y, pointerId: e.pointerId };
  }
  function onPointerMove(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const nx = Math.max(0, drag.initX + (e.clientX - drag.startX));
    const ny = Math.max(0, drag.initY + (e.clientY - drag.startY));
    setSurfaceGroupPosition(nodeId, drag.moduleId, nx, ny);
  }
  function onPointerUp(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag = null;
  }

  // ── per-knob rename (unlocked only, matching the card's edit model) ──
  // The `<input type="text">` is INLINE IN THIS FILE deliberately: the
  // typed-entry parity leg (face-migration-inventory.test.ts) resolves
  // `fullViewBody:` to its directly-imported component and reads ONLY that one
  // file, so a rename field factored into a child component would read as a
  // typed-entry affordance lost in promotion.
  let editing: { moduleId: string; paramId: string } | null = $state(null);
  let editValue = $state('');

  function startRename(e: Event, moduleId: string, paramId: string, current: string) {
    if (locked) return;
    e.stopPropagation();
    editing = { moduleId, paramId };
    editValue = current;
  }
  function commitRename() {
    if (!editing) return;
    setBindingName(nodeId, editing.moduleId, editing.paramId, editValue);
    editing = null;
  }
  function cancelRename() {
    editing = null;
  }
  function onRenameKey(e: KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
  }
  function isEditing(moduleId: string, paramId: string): boolean {
    return editing?.moduleId === moduleId && editing?.paramId === paramId;
  }
</script>

<svelte:window onpointermove={onPointerMove} onpointerup={onPointerUp} onpointercancel={onPointerUp} />

<div
  class="cs-board nodrag"
  data-testid="cs-board"
  data-node-id={nodeId}
  data-locked={locked ? 'true' : 'false'}
  role="group"
  aria-label={`${surfaceTitle} — ${groups.reduce((n, g) => n + g.controls.length, 0)} controls from ${groups.length} modules, ${locked ? 'layout locked' : 'layout unlocked'}`}
>
  {#if isEmpty}
    <!-- ⚠ THE DASHED FRAME IS AN <svg> RECT, NOT A CSS BORDER, AND THAT IS A
         MEASUREMENT DECISION (the ElectraGridBody empty-dial lesson): the dock
         width gate derives "content" from an INK SWEEP — boxes for
         `[data-cell-key]`/glyph/canvas/svg/img and TEXT RANGES for everything
         else — so a CSS border on a plain div is invisible to it. MEASURED on
         this branch before the change: content 332 against a 410 px face body,
         78 px of "empty plate" on a surface that draws its frame across every
         one of them. The mark is identical; it is now expressed where the
         instrument can read it. -->
    <div class="cs-empty" data-testid="cs-board-empty">
      <svg class="cs-empty-frame" aria-hidden="true" preserveAspectRatio="none" viewBox="0 0 100 32">
        <rect
          x="0.5"
          y="0.5"
          width="99"
          height="31"
          rx="2"
          fill="none"
          stroke="#3a4150"
          stroke-width="1"
          stroke-dasharray="3 3"
          vector-effect="non-scaling-stroke"
        />
      </svg>
      <span>Right-click a control → “Send to {surfaceTitle}”.</span>
    </div>
  {:else}
    <div
      class="cs-canvas"
      class:flowing={locked}
      data-testid="cs-board-canvas"
      data-locked={locked ? 'true' : 'false'}
      style:width={locked ? null : `${unlockedSize.width}px`}
      style:height={locked ? null : `${unlockedSize.height}px`}
    >
      {#each groups as g, i (g.moduleId)}
        {@const pos = posFor(g.moduleId, i)}
        <div
          class="cs-group nodrag"
          class:draggable={!locked}
          data-testid="cs-board-group"
          data-source-id={g.moduleId}
          role="group"
          aria-label={`${g.label} controls`}
          style:left={locked ? null : `${pos.x}px`}
          style:top={locked ? null : `${pos.y}px`}
          style:width="{BOX_W}px"
          onpointerdown={(e) => startDrag(e, g.moduleId, pos)}
        >
          <div class="cs-group-label" data-testid="cs-board-group-label">{g.label}</div>
          <div
            class="cs-group-body"
            style:--cs-cols={KNOBS_PER_ROW}
            style:--cs-cell-w="{KNOB_CELL_W}px"
            style:--cs-row-h="{KNOB_ROW_H}px"
            style:--cs-gap="{KNOB_GRID_GAP}px"
            style:--cs-dial-h="48px"
          >
            {#each g.controls as c (c.paramId)}
              <!-- svelte-ignore a11y_no_static_element_interactions — pointer PLUMBING only: the handler stops the
                   surrounding drag so the control inside receives the gesture. No user action happens on this
                   div, so there is nothing to give a keyboard equivalent to. -->
              <div
                class="cs-knob"
                data-testid={`cs-board-knob-${g.moduleId}-${c.paramId}`}
                onpointerdown={(e) => e.stopPropagation()}
                title={`${c.label} — right-click for “Remove from ${surfaceTitle}”`}
              >
                <!-- PASSTHROUGH colour stripe: the SOURCE module's live control
                     colour, so a glance identifies which source each knob comes
                     from. Not a stored copy. -->
                <div
                  class="cs-knob-stripe"
                  data-testid={`cs-board-stripe-${g.moduleId}-${c.paramId}`}
                  style:background={`#${g.color}`}
                  aria-hidden="true"
                ></div>
                <Knob
                  value={readParam(g.moduleId, c.paramId, c.def)}
                  min={c.def.min}
                  max={c.def.max}
                  defaultValue={c.def.defaultValue}
                  label={c.label}
                  units={c.def.units}
                  curve={c.def.curve}
                  onchange={(v) => setParam(g.moduleId, c.paramId, v)}
                  readLive={liveReader(g.moduleId, c.paramId)}
                  moduleId={g.moduleId}
                  paramId={c.paramId}
                  testid={`cs-board-dial-${g.moduleId}-${c.paramId}`}
                />
                <div class="cs-knob-label" title={c.label}>{c.label}</div>
                {#if isEditing(g.moduleId, c.paramId)}
                  <!-- svelte-ignore a11y_autofocus — autofocus is the POINT: this input only exists while a
                       rename is in progress, and it was opened by an explicit user action. -->
                  <input
                    class="cs-rename nodrag"
                    data-testid={`cs-board-rename-input-${g.moduleId}-${c.paramId}`}
                    type="text"
                    bind:value={editValue}
                    maxlength="14"
                    aria-label={`Rename ${c.label}`}
                    autofocus
                    onpointerdown={(e) => e.stopPropagation()}
                    onkeydown={onRenameKey}
                    onblur={commitRename}
                  />
                {:else if !locked}
                  <button
                    type="button"
                    class="cs-rename-btn nodrag"
                    data-testid={`cs-board-rename-${g.moduleId}-${c.paramId}`}
                    title={`Rename “${c.label}” for the Electra`}
                    aria-label={`Rename ${c.label}`}
                    onpointerdown={(e) => e.stopPropagation()}
                    ondblclick={(e) => startRename(e, g.moduleId, c.paramId, c.customName)}
                    onclick={(e) => startRename(e, g.moduleId, c.paramId, c.customName)}
                  >
                    ✎
                  </button>
                {/if}
              </div>
            {/each}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  /* The board's own internal layout — the card's, minus the card frame: in a
     faceplate the shell's editor frame already separates the body from the
     bands, so the outer `.mod-card` box does not come along. */
  .cs-board {
    width: max-content;
    min-width: 344px;
    max-width: 100%;
    box-sizing: border-box;
  }
  .cs-empty {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 90px;
    /* The dashed frame is the <svg> rect in the markup — see the comment
       there for why it is not a CSS border. */
    border-radius: 5px;
    color: var(--text-dim, #8a93a6);
    font-size: 0.72rem;
    text-align: center;
    padding: 8px;
  }
  .cs-empty-frame {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
  }
  .cs-canvas {
    /* UNLOCKED (default of this rule): absolute box layout, sized inline from
       unlockedCanvasSize() so the canvas GROWS to contain every box. */
    position: relative;
    min-height: 150px;
    min-width: 344px;
    border: 1px solid #2a2f3a;
    border-radius: 5px;
    background: #0e1015;
    overflow: visible;
    box-sizing: border-box;
  }
  /* LOCKED (normal display): boxes flow + wrap; canvas auto-sizes. */
  .cs-canvas.flowing {
    display: flex;
    flex-wrap: wrap;
    align-content: flex-start;
    gap: 12px;
    padding: 10px;
    width: auto;
    height: auto;
  }
  .cs-group {
    position: absolute;
    border: 1px dashed #5a6680;
    border-radius: 5px;
    background: rgba(20, 24, 32, 0.7);
    padding: 4px 6px 6px;
    box-sizing: border-box;
  }
  .cs-canvas.flowing .cs-group {
    position: static;
  }
  .cs-group.draggable { cursor: grab; border-color: #6f8bd0; }
  .cs-group.draggable:active { cursor: grabbing; }
  .cs-group-label {
    font-size: 0.62rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-dim, #97a3bd);
    margin-bottom: 4px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    pointer-events: none;
  }
  /* DETERMINISTIC GRID — the same fixed column/row constants
     control-surface-layout.ts budgets with, so the board always contains its
     content (the card's resize fix, carried verbatim). */
  .cs-group-body {
    display: grid;
    grid-template-columns: repeat(var(--cs-cols), var(--cs-cell-w));
    grid-auto-rows: var(--cs-row-h);
    gap: var(--cs-gap);
    justify-content: flex-start;
  }
  .cs-knob {
    touch-action: none;
    width: var(--cs-cell-w);
    display: grid;
    grid-template-rows: 4px var(--cs-dial-h) auto auto;
    justify-items: center;
    align-content: start;
    row-gap: 2px;
    overflow: hidden;
  }
  .cs-knob-stripe {
    width: 100%;
    height: 4px;
    border-radius: 2px;
  }
  .cs-knob :global(.knob-wrap) {
    position: relative;
  }
  /* Hide the Knob's OWN flow label; the name renders in the dedicated row
     below so a long name truncates without overlapping the CC badge. */
  .cs-knob :global(.knob-wrap > .label) {
    display: none;
  }
  .cs-knob :global(.midi-badge) {
    top: -2px;
    bottom: auto;
    right: -2px;
  }
  .cs-knob-label {
    width: 100%;
    text-align: center;
    font-size: 0.62rem;
    line-height: 1.1;
    color: var(--text-dim, #97a3bd);
    text-transform: uppercase;
    letter-spacing: 0.03em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    pointer-events: none;
  }
  .cs-rename-btn {
    font-size: 0.6rem;
    line-height: 1;
    padding: 1px 4px;
    border-radius: 3px;
    border: 1px solid #404652;
    background: rgba(96, 165, 250, 0.1);
    color: var(--text-dim, #aab);
    cursor: pointer;
  }
  .cs-rename-btn:hover { background: rgba(96, 165, 250, 0.22); }
  .cs-rename {
    width: 100%;
    max-width: var(--cs-cell-w, 76px);
    box-sizing: border-box;
    font-size: 0.6rem;
    padding: 1px 3px;
    border-radius: 3px;
    border: 1px solid #6f8bd0;
    background: #0e1015;
    color: var(--text, #e8eaed);
  }
</style>
