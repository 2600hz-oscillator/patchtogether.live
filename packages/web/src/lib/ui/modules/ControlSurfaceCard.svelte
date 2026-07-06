<script lang="ts">
  // CONTROL SURFACE card — an abstract panel of POINTERS to other modules'
  // controls. Spawns as a small blank square; right-click any MIDI-assignable
  // knob/fader elsewhere and "Send to <this surface>" to add a pointer here.
  //
  // Pointers, not copies: each proxied Knob reads + writes the SOURCE node's
  // live param (patch.nodes[moduleId].params[paramId]) and is keyed for MIDI
  // by the same moduleId:paramId — so a MIDI assignment / edit on the proxy is
  // the same as on the source, the same control can appear on multiple
  // surfaces, and there is no per-proxy state to drift. Because the source
  // node stays live in patch.nodes even when collapsed inside a Group, the
  // proxies keep working when the underlying module is folded away.
  //
  // Controls are grouped by their source module (dotted border + module-name
  // label). The surface is a mini-graph of itself: when UNLOCKED the group
  // boxes are draggable (positions persist on node.data.layout); a lock/unlock
  // button at the top freezes them.
  //
  // Modeled on GroupExposedControls.svelte (same proxied-Knob + drag-layout
  // pattern), generalized from group-children to arbitrary pointers.
  //
  // CONTROL COLOUR (passthrough): a thin colour stripe above each proxied knob
  // shows the SOURCE module's control colour (resolveControlColor) — a LIVE read
  // of the source, NOT a stored copy. It sits right beside the live VALUE read
  // (resolveSurfaceParam), the same passthrough pattern. See control-color.ts.

  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import ModuleTitle from './ModuleTitle.svelte';
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
    setSurfaceLocked,
    setSurfaceGroupPosition,
    setBindingName,
    type ControlBinding,
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
  import { resolveSurfaceParam, pruneSurfaceDangling } from '$lib/graph/control-surface-params';
  import { resolveControlColor } from '$lib/graph/control-color';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  // Re-derive on any Yjs update so live param reads + remote binding adds
  // reflect instantly (mirrors GroupCard's cardVersion pump).
  // Bounded node-scoped re-derive (phase-2 CC perf fix): the surface reads
  // its OWN data (bindings/layout/locked) + every bound SOURCE module's
  // subtree (live values, renames, control colours) + node add/remove (the
  // prune below cares about deletions; a bound TOYBOX reconfigure bumps
  // that source's own version). A binding edit bumps the surface's own
  // version, which re-derives the source subscription set. NOT a
  // whole-doc pump: a commit on an unbound module no longer re-runs this
  // card's derived chain.
  let cardVersion = $derived.by(() => {
    let v = nodeVersion(id) + nodesStructuralVersion();
    const seen = new Set<string>();
    for (const b of readSurfaceData(patch.nodes[id]).bindings ?? []) {
      if (seen.has(b.moduleId)) continue;
      seen.add(b.moduleId);
      v += nodeVersion(b.moduleId);
    }
    return v;
  });

  // AUTO-PRUNE dangling proxied controls: when a bound source disappears (a
  // mapped module deleted, or a mapped TOYBOX op node deleted when the toybox is
  // reconfigured) the control already stops RENDERING (groups skips an
  // unresolvable binding), but the BINDING lingers in node.data — so the next
  // Electra flash would emit a dead control. On every Yjs update, drop any
  // DEFINITELY-gone binding from the surface's data. pruneSurfaceDangling is
  // conservative (never prunes a not-yet-loaded source) and a no-op when nothing
  // dangles, so the follow-on update it triggers settles in one extra cycle.
  $effect(() => {
    void cardVersion;
    pruneSurfaceDangling(id);
  });

  let surfaceData = $derived.by(() => {
    void cardVersion;
    return readSurfaceData(patch.nodes[id]);
  });
  // Read `locked` THROUGH cardVersion, not off `surfaceData`: setSurfaceLocked
  // mutates node.data.locked IN PLACE, so surfaceData returns the SAME object
  // reference and Svelte's $derived equality short-circuit would skip re-running
  // a `$derived(surfaceData.locked)` (the unlock click then appeared to do
  // nothing — locked→unlocked never reflected). Touching cardVersion forces a
  // re-read on every ydoc update.
  let locked = $derived.by(() => {
    void cardVersion;
    return readSurfaceData(patch.nodes[id]).locked ?? false;
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
    /** The label shown on the knob: the user's custom name if set, else the
     *  param's own label. */
    label: string;
    /** The user-set custom name (empty when none) — seeds the rename input. */
    customName: string;
    def: ParamDef;
  }
  interface RenderGroup {
    moduleId: string;
    label: string;
    /** The SOURCE module's resolved control colour (6-digit hex), read LIVE as
     *  PASSTHROUGH — NOT stored on the surface. Drives the stripe above each of
     *  this group's knobs (same colour everywhere this source appears). */
    color: string;
    controls: RenderControl[];
  }

  // Live groups: bindings grouped by module, dangling sources dropped, each
  // binding resolved THROUGH the param adapter (resolveSurfaceParam) — so a flat
  // node.params source (normal module) AND a nested node.data source (TOYBOX:
  // material / combine / layer params) both resolve to a ParamDef + get/set
  // bound to the SAME live location the source's own knobs use. Unresolvable
  // bindings (param no longer exists) are skipped, as before.
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
      // LIVE read of the source module's control colour (passthrough) — re-runs
      // through cardVersion on any source-color change, exactly like the values.
      const color = resolveControlColor(sourceNode);
      out.push({ moduleId: g.moduleId, label: sourceLabel(g.moduleId), color, controls });
    }
    return out;
  });

  let isEmpty = $derived(groups.length === 0);

  // ── live param read / write (the pointer mechanism) ──
  // Both route through the param adapter so TOYBOX's nested params read/write the
  // right node.data location (material / combine / layer) instead of the missing
  // node.params[paramId].
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
      // The audio engine's readParam folds in intrinsic + connected-CV samples
      // for a motorized tick. TOYBOX's engine readParam returns undefined (its
      // params live in node.data), so fall back to the adapter's live get() —
      // which also picks up per-frame CV writes into the same material/combine
      // object.
      const e = engineCtx.get();
      const fromEngine = e ? e.readParam(live, paramId) : undefined;
      if (typeof fromEngine === 'number') return fromEngine;
      return resolveSurfaceParam(live, paramId)?.get();
    };
  }

  // ── layout ──
  // LOCKED (normal display): boxes flow in a wrap layout and the card grows to
  //   fit them (CSS handles it) — nothing is clipped.
  // UNLOCKED (drag-to-rearrange): boxes are absolutely positioned at their
  //   saved layout (or a default tile), and we size the `.cs-canvas` from those
  //   box positions so even the absolute layout grows to contain every box.
  // The geometry lives in control-surface-layout.ts (pure + unit-tested).
  function posFor(moduleId: string, index: number): { x: number; y: number } {
    return layoutPosFor(surfaceData.layout, moduleId, index);
  }
  // Drive the unlocked canvas size off the live group set (knob counts vary the
  // box height) + saved layout. Recomputes whenever bindings/layout change.
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
    setSurfaceGroupPosition(id, drag.moduleId, nx, ny);
  }
  function onPointerUp(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag = null;
  }

  let surfaceTitle = $derived(surfaceData.name ?? 'this surface');
  function toggleLock() { setSurfaceLocked(id, !locked); }

  // ── per-knob rename (only when UNLOCKED, matching the card's edit model) ──
  // Double-click a knob's label to edit its custom name; Enter / blur commits,
  // Escape cancels. An empty value clears the custom name (reverts to the param
  // label + the Electra auto-abbreviation). Writes via the in-place setBindingName.
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
    setBindingName(id, editing.moduleId, editing.paramId, editValue);
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

<div class="mod-card control-surface-card" data-testid="control-surface-card" data-node-id={id} data-locked={locked ? 'true' : 'false'}>
  <div class="cs-titlebar">
    <ModuleTitle {id} {data} defaultLabel="CONTROL SURFACE" inline={true} />
    <button
      class="lock-btn nodrag"
      class:locked
      data-testid="control-surface-lock"
      onclick={toggleLock}
      title={locked ? 'Unlock to rearrange' : 'Lock layout'}
      aria-pressed={locked}
    >
      {locked ? '🔒 Locked' : '🔓 Unlocked'}
    </button>
  </div>

  {#if isEmpty}
    <div class="cs-empty" data-testid="control-surface-empty">
      <span>Right-click a control → “Send to {readSurfaceData(patch.nodes[id]).name ?? 'Control Surface'}”.</span>
    </div>
  {:else}
    <div
      class="cs-canvas"
      class:flowing={locked}
      data-testid="control-surface-canvas"
      data-locked={locked ? 'true' : 'false'}
      style:width={locked ? null : `${unlockedSize.width}px`}
      style:height={locked ? null : `${unlockedSize.height}px`}
    >
      {#each groups as g, i (g.moduleId)}
        {@const pos = posFor(g.moduleId, i)}
        <div
          class="cs-group nodrag"
          class:draggable={!locked}
          data-testid="control-surface-group"
          data-source-id={g.moduleId}
          role="group"
          aria-label={`${g.label} controls`}
          style:left={locked ? null : `${pos.x}px`}
          style:top={locked ? null : `${pos.y}px`}
          style:width="{BOX_W}px"
          onpointerdown={(e) => startDrag(e, g.moduleId, pos)}
        >
          <div class="cs-group-label" data-testid="control-surface-group-label">{g.label}</div>
          <div
            class="cs-group-body"
            style:--cs-cols={KNOBS_PER_ROW}
            style:--cs-cell-w="{KNOB_CELL_W}px"
            style:--cs-row-h="{KNOB_ROW_H}px"
            style:--cs-gap="{KNOB_GRID_GAP}px"
            style:--cs-dial-h="48px"
          >
            {#each g.controls as c (c.paramId)}
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div
                class="cs-knob"
                data-testid={`control-surface-knob-${g.moduleId}-${c.paramId}`}
                onpointerdown={(e) => e.stopPropagation()}
                title={`${c.label} — right-click for “Remove from ${surfaceTitle}”`}
              >
                <!-- PASSTHROUGH colour stripe: the SOURCE module's live control
                     colour (resolveControlColor), so a glance identifies which
                     source each knob comes from. Not a stored copy. -->
                <div
                  class="cs-knob-stripe"
                  data-testid={`control-surface-stripe-${g.moduleId}-${c.paramId}`}
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
                />
                <div class="cs-knob-label" title={c.label}>{c.label}</div>
                {#if isEditing(g.moduleId, c.paramId)}
                  <!-- svelte-ignore a11y_autofocus -->
                  <input
                    class="cs-rename nodrag"
                    data-testid={`control-surface-rename-input-${g.moduleId}-${c.paramId}`}
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
                    data-testid={`control-surface-rename-${g.moduleId}-${c.paramId}`}
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
  .control-surface-card {
    /* Grow to fit all groups (the SvelteFlow node auto-sizes to the card), with
       a sane floor so an empty/one-group surface stays card-shaped. Was a fixed
       360px, which clipped every group past the first row. */
    width: max-content;
    min-width: 360px;
    max-width: 760px;
    min-height: 140px;
    background: var(--module-bg, #1a1d24);
    border-radius: 6px;
    padding: 6px 8px 8px;
    box-sizing: border-box;
  }
  .cs-titlebar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 6px;
  }
  .lock-btn {
    font-size: 0.68rem;
    padding: 2px 8px;
    border-radius: 4px;
    border: 1px solid #404652;
    background: rgba(96, 165, 250, 0.12);
    color: var(--text, #e8eaed);
    cursor: pointer;
    white-space: nowrap;
  }
  .lock-btn.locked {
    background: rgba(120, 120, 130, 0.18);
    color: var(--text-dim, #aab);
  }
  .lock-btn:hover { background: rgba(96, 165, 250, 0.22); }
  .cs-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 90px;
    border: 1px dashed #3a4150;
    border-radius: 5px;
    color: var(--text-dim, #8a93a6);
    font-size: 0.72rem;
    text-align: center;
    padding: 8px;
  }
  .cs-canvas {
    /* UNLOCKED (default of this rule): absolute box layout. Width/height are set
       inline from unlockedCanvasSize() so the canvas GROWS to contain every box
       — overflow visible (no clipping). */
    position: relative;
    min-height: 150px;
    min-width: 344px;
    border: 1px solid #2a2f3a;
    border-radius: 5px;
    background: #0e1015;
    overflow: visible;
    box-sizing: border-box;
  }
  /* LOCKED (normal display): boxes flow + wrap; canvas + card auto-size. */
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
  /* In the flowing (locked) layout the boxes are static — the wrap container
     places them, so they never fall outside a fixed-height canvas. */
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
  /* DETERMINISTIC GRID (the resize fix): a FIXED 2-column grid with a fixed row
     height, NOT flex-wrap. flex-wrap's wrap point drifted with label width, so
     the lib (which assumed 3/row) under-counted rows and tall groups spilled
     below the card frame. The column count, cell width, row height + gap are the
     SAME constants control-surface-layout.ts uses for groupBoxHeight() /
     unlockedCanvasSize(), so the card is guaranteed to contain its content. */
  .cs-group-body {
    display: grid;
    grid-template-columns: repeat(var(--cs-cols), var(--cs-cell-w));
    grid-auto-rows: var(--cs-row-h);
    gap: var(--cs-gap);
    justify-content: flex-start;
  }
  /* One knob cell: a fixed-height DIAL SLOT (dial + room for its overhanging
     "CC n" MIDI badge), then the ellipsized param-name LABEL row, then the ✎
     rename-button row. Fixed track heights so the centered label can never
     collide with the badge and the box height is stable across lock/unlock. */
  .cs-knob {
    touch-action: none;
    width: var(--cs-cell-w);
    display: grid;
    /* colour-stripe(4) then dial-slot, label, rename rows. The stripe row +
       its row-gap are budgeted into KNOB_ROW_H (control-surface-layout.ts). */
    grid-template-rows: 4px var(--cs-dial-h) auto auto;
    justify-items: center;
    align-content: start;
    row-gap: 2px;
    overflow: hidden;
  }
  /* PASSTHROUGH colour stripe — the source module's live control colour sits
     above the knob, so the surface reads "what's coming from what" at a glance.
     The background colour is set inline from resolveControlColor(source). */
  .cs-knob-stripe {
    width: 100%;
    height: 4px;
    border-radius: 2px;
  }
  /* The Knob unit (dial + label + badge) lives in the dial slot. We hide the
     Knob's OWN flow `.label` and render the name in the surface's dedicated
     label row below (so a long name truncates without ever overlapping the
     absolutely-positioned "CC n" badge that hangs off the dial). */
  .cs-knob :global(.knob-wrap) {
    position: relative;
  }
  .cs-knob :global(.knob-wrap > .label) {
    display: none;
  }
  /* Move the surface-hosted "CC n" MIDI badge to the dial's TOP-right corner so
     it sits clear of the param-name label beneath the dial (was bottom-right,
     overlapping the label → "W CC 0", "INPUT CC 7" collisions). */
  .cs-knob :global(.midi-badge) {
    top: -2px;
    bottom: auto;
    right: -2px;
  }
  /* The param-name label: its own clear row, centered + ellipsized. */
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
  /* Rename affordance: a tiny pencil button (unlocked only) opens an inline
     input that writes the Electra custom name. */
  .cs-rename-btn {
    /* In the grid cell the row-gap already spaces it from the label; no
       margin-top (kept the height inside the fixed KNOB_ROW_H budget). */
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
