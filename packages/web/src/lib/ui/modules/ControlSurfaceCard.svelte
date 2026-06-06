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

  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import ModuleTitle from './ModuleTitle.svelte';
  import { patch, ydoc } from '$lib/graph/store';
  import { useEngine } from '$lib/audio/engine-context';
  import { getModuleDef } from '$lib/audio/module-registry';
  import { getVideoModuleDef } from '$lib/video/module-registry';
  import type { ModuleNode, ParamDef } from '$lib/graph/types';
  import {
    readSurfaceData,
    groupBindingsByModule,
    setSurfaceLocked,
    setSurfaceGroupPosition,
    type ControlBinding,
  } from '$lib/graph/control-surface';
  import { resolveSurfaceParam } from '$lib/graph/control-surface-params';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  // Re-derive on any Yjs update so live param reads + remote binding adds
  // reflect instantly (mirrors GroupCard's cardVersion pump).
  let cardVersion = $state(0);
  $effect(() => {
    const h = () => { cardVersion = cardVersion + 1; };
    ydoc.on('update', h);
    return () => ydoc.off('update', h);
  });

  let surfaceData = $derived.by(() => {
    void cardVersion;
    return readSurfaceData(patch.nodes[id]);
  });
  let locked = $derived(surfaceData.locked ?? false);

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
    def: ParamDef;
  }
  interface RenderGroup {
    moduleId: string;
    label: string;
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
        controls.push({ paramId: b.paramId, label: resolved.def.label ?? b.paramId, def: resolved.def });
      }
      if (controls.length === 0) continue;
      out.push({ moduleId: g.moduleId, label: sourceLabel(g.moduleId), controls });
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
    if (live) live.params[paramId] = value;
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

  // ── layout: tile groups that have no saved position; drag when unlocked ──
  const BOX_W = 168;
  const GAP = 12;
  const ORIGIN = 10;
  function defaultPos(index: number): { x: number; y: number } {
    // Tile across in rows of 2 so a fresh surface lays out tidily.
    const col = index % 2;
    const row = Math.floor(index / 2);
    return { x: ORIGIN + col * (BOX_W + GAP), y: ORIGIN + row * 150 };
  }
  function posFor(moduleId: string, index: number): { x: number; y: number } {
    return surfaceData.layout?.[moduleId] ?? defaultPos(index);
  }

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
    <div class="cs-canvas" data-testid="control-surface-canvas">
      {#each groups as g, i (g.moduleId)}
        {@const pos = posFor(g.moduleId, i)}
        <div
          class="cs-group nodrag"
          class:draggable={!locked}
          data-testid="control-surface-group"
          data-source-id={g.moduleId}
          role="group"
          aria-label={`${g.label} controls`}
          style:left="{pos.x}px"
          style:top="{pos.y}px"
          style:width="{BOX_W}px"
          onpointerdown={(e) => startDrag(e, g.moduleId, pos)}
        >
          <div class="cs-group-label" data-testid="control-surface-group-label">{g.label}</div>
          <div class="cs-group-body">
            {#each g.controls as c (c.paramId)}
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div
                class="cs-knob"
                data-testid={`control-surface-knob-${g.moduleId}-${c.paramId}`}
                onpointerdown={(e) => e.stopPropagation()}
                title={`${c.label} — right-click for “Remove from ${surfaceTitle}”`}
              >
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
    width: 360px;
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
    position: relative;
    min-height: 150px;
    border: 1px solid #2a2f3a;
    border-radius: 5px;
    background: #0e1015;
    overflow: hidden;
  }
  .cs-group {
    position: absolute;
    border: 1px dashed #5a6680;
    border-radius: 5px;
    background: rgba(20, 24, 32, 0.7);
    padding: 4px 6px 6px;
    box-sizing: border-box;
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
  .cs-group-body {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: flex-start;
  }
  .cs-knob { touch-action: none; }
</style>
