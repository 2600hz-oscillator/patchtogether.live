<script lang="ts">
  // D15 Knob: vertical drag, Shift = ×0.1 fine, Cmd/Ctrl = ×0.01 fine,
  // double-click = reset to default, value tooltip on drag and on hover.
  // Curve maps display angle ↔ internal value while DSP stays linear (D15).
  //
  // Motorized: when readLive is provided and we're not dragging, the tick
  // angle reflects the LIVE current value (intrinsic + connected CV) so
  // patching an LFO into a knob's CV input visibly rotates the tick.
  import type { KnobCurve } from '$lib/graph/types';
  import { onDestroy, onMount, untrack } from 'svelte';
  import { createDragCommit } from './drag-commit';
  import ControlContextMenu from './ControlContextMenu.svelte';
  import {
    beginLearn,
    cancelLearn,
    registerSetter,
    unregisterSetter,
    getBinding,
    clearBinding,
    learnSpecRune,
    bindingsRune,
  } from '$lib/midi/midi-learn.svelte';
  import { patch } from '$lib/graph/store';
  import {
    listControlSurfaces,
    readSurfaceData,
    hasBinding as surfaceHasBinding,
    addBindingToSurface,
    removeBindingFromSurface,
  } from '$lib/graph/control-surface';
  import {
    listElectraControls,
    readElectraData,
    slotForBinding,
    assignSlotToElectra,
    clearSlot,
  } from '$lib/graph/electra-control';

  interface Props {
    value: number;
    min: number;
    max: number;
    defaultValue: number;
    label: string;
    units?: string;
    curve?: KnobCurve;
    onchange: (value: number) => void;
    /**
     * Optional live-value reader. If provided, the knob polls this each rAF
     * (when not being dragged) and renders that as the tick angle.
     */
    readLive?: () => number | undefined;
    /** MIDI Learn — when both moduleId + paramId are set the knob becomes
     *  right-clickable to bind a MIDI CC. Cards that don't pass these
     *  silently skip the feature. */
    moduleId?: string;
    paramId?: string;
  }

  let {
    value,
    min,
    max,
    defaultValue,
    label,
    units = '',
    curve = 'linear',
    onchange,
    readLive,
    moduleId,
    paramId,
  }: Props = $props();

  // ---------------- MIDI Learn integration (mirrors Fader.svelte) ----------------
  let bindingTick = $state(0);
  function bumpBindingTick() { bindingTick++; }
  let binding = $derived.by(() => {
    void bindingTick;      // legacy local-action bump
    void bindingsRune();   // reactive: re-eval when ANY binding add/remove
                           // happens (e.g. an incoming CC completes a learn)
    if (!moduleId || !paramId) return undefined;
    return getBinding(moduleId, paramId);
  });
  let learning = $derived.by(() => {
    if (!moduleId || !paramId) return false;
    const ls = learnSpecRune();
    return !!ls && ls.moduleId === moduleId && ls.paramId === paramId;
  });

  let ctxOpen = $state(false);
  let ctxX = $state(0);
  let ctxY = $state(0);
  // Control surfaces this knob can be sent to — snapshotted when the menu
  // opens (surfaces rarely change mid-menu; recomputed each open).
  let ctxSurfaces = $state<Array<{ id: string; name: string; bound: boolean }>>([]);
  // ElectraControl surfaces this knob can be sent to a fixed (row, knob) slot
  // on — snapshotted alongside ctxSurfaces when the menu opens.
  let ctxElectras = $state<Array<{ id: string; name: string; assignedSlot: number | null }>>([]);

  function refreshSurfaces() {
    if (!moduleId || !paramId) { ctxSurfaces = []; return; }
    ctxSurfaces = listControlSurfaces(patch.nodes).map((s) => ({
      id: s.id,
      name: s.name,
      bound: surfaceHasBinding(readSurfaceData(patch.nodes[s.id]), moduleId!, paramId!),
    }));
  }

  function refreshElectras() {
    if (!moduleId || !paramId) { ctxElectras = []; return; }
    ctxElectras = listElectraControls(patch.nodes).map((e) => ({
      id: e.id,
      name: e.name,
      assignedSlot: slotForBinding(readElectraData(patch.nodes[e.id]), moduleId!, paramId!),
    }));
  }

  function openContextMenu(e: MouseEvent) {
    if (!moduleId || !paramId) return;
    refreshSurfaces();
    refreshElectras();
    // Plain right-click on a wired knob opens the control menu (MIDI Learn /
    // Forget). We stopPropagation so the event does NOT bubble to the node
    // menu — right-clicking the card *background* still gets the node menu
    // (Docs / Duplicate / Unpatch / Delete) because only the knob surface
    // is covered by this handler.
    e.preventDefault();
    e.stopPropagation();
    ctxX = e.clientX;
    ctxY = e.clientY;
    ctxOpen = true;
  }
  function onLearnPick() {
    if (!moduleId || !paramId) return;
    beginLearn({ moduleId, paramId, min, max, onchange });
    bumpBindingTick();
  }
  function onForgetPick() {
    if (!moduleId || !paramId) return;
    clearBinding(moduleId, paramId);
    bumpBindingTick();
  }
  function onSendToSurface(surfaceId: string) {
    if (!moduleId || !paramId) return;
    addBindingToSurface(surfaceId, moduleId, paramId);
  }
  function onRemoveFromSurface(surfaceId: string) {
    if (!moduleId || !paramId) return;
    removeBindingFromSurface(surfaceId, moduleId, paramId);
  }
  function onAssignElectra(electraId: string, slot: number) {
    if (!moduleId || !paramId) return;
    assignSlotToElectra(electraId, slot, moduleId, paramId);
  }
  function onClearElectra(electraId: string, slot: number) {
    clearSlot(electraId, slot);
  }
  onMount(() => {
    if (!moduleId || !paramId) return;
    registerSetter(moduleId, paramId, { min, max, onchange });
  });

  let dragging = $state(false);
  let hovering = $state(false);
  // Display value for the tick. Driven by drag while user is interacting,
  // by readLive when motorized + idle, by the prop value otherwise.
  let liveValue = $state(untrack(() => value));
  let raf: number | null = null;
  let currentValue = $derived(value);

  $effect(() => {
    if (dragging) return;
    if (!readLive) {
      liveValue = currentValue;
      return;
    }
    const reader = readLive;
    function tick() {
      const v = reader();
      liveValue = v ?? currentValue;
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => {
      if (raf !== null) cancelAnimationFrame(raf);
      raf = null;
    };
  });

  $effect(() => {
    if (!dragging && !readLive) liveValue = currentValue;
  });

  // rAF-coalesced commit pump — see Fader.svelte for the full rationale.
  // Knob lives on the same pointermove → onchange → SyncedStore mutation
  // path that produces the hand-modulation tempo-drift symptom; without
  // coalescing, a 240 Hz drag floods the snapshot bus + reconciler.
  const dragCommit = createDragCommit((v) => onchange(v));

  onDestroy(() => {
    if (raf !== null) cancelAnimationFrame(raf);
    dragCommit.dispose();
    if (moduleId && paramId) {
      unregisterSetter(moduleId, paramId);
      if (learning) cancelLearn();
    }
  });

  // Map internal value ↔ normalized [0,1] using the declared curve.
  function valueToFrac(v: number): number {
    const clamped = Math.max(min, Math.min(max, v));
    if (curve === 'log') {
      // Guard against zero/negative endpoints; fall back to linear in that case.
      if (min <= 0 || max <= 0) return (clamped - min) / (max - min);
      return Math.log(clamped / min) / Math.log(max / min);
    }
    if (curve === 'exp') {
      const frac = (clamped - min) / (max - min);
      return frac * frac;
    }
    return (clamped - min) / (max - min);
  }

  function fracToValue(f: number): number {
    const fr = Math.max(0, Math.min(1, f));
    if (curve === 'log') {
      if (min <= 0 || max <= 0) return min + fr * (max - min);
      return min * Math.pow(max / min, fr);
    }
    if (curve === 'exp') {
      return min + Math.sqrt(fr) * (max - min);
    }
    return min + fr * (max - min);
  }

  let angle = $derived(-135 + valueToFrac(liveValue) * 270);

  let startY = 0;
  let startFrac = 0;
  let mod: 'none' | 'shift' | 'fine' = 'none';

  function pointerdown(e: PointerEvent) {
    if (e.button !== 0) return;
    dragging = true;
    startY = e.clientY;
    startFrac = valueToFrac(value);
    mod = e.shiftKey ? 'shift' : (e.ctrlKey || e.metaKey) ? 'fine' : 'none';
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function pointermove(e: PointerEvent) {
    if (!dragging) return;
    const dy = startY - e.clientY; // up = positive
    // Sensitivity scales: 1 unit / 200 px linearly; Shift = 10×, Cmd = 100× finer.
    const sensitivity = mod === 'fine' ? 1 / 20000 : mod === 'shift' ? 1 / 2000 : 1 / 200;
    const newFrac = startFrac + dy * sensitivity;
    const newValue = fracToValue(newFrac);
    liveValue = newValue;
    if (newValue !== value) dragCommit.commit(newValue);
  }

  function pointerup(e: PointerEvent) {
    dragging = false;
    // Force-commit the final drag position so the patch store can't lag
    // the last visible tick angle by one frame on release.
    dragCommit.flush();
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  }

  function dblclick() {
    onchange(defaultValue);
  }

  function wheel(e: WheelEvent) {
    e.preventDefault();
    // Wheel ticks: small step in normalized space.
    const step = e.shiftKey ? 0.001 : e.ctrlKey || e.metaKey ? 0.0001 : 0.005;
    const direction = e.deltaY < 0 ? 1 : -1;
    const newFrac = valueToFrac(value) + direction * step;
    const newValue = fracToValue(newFrac);
    if (newValue !== value) onchange(newValue);
  }

  function format(v: number, u: string): string {
    const abs = Math.abs(v);
    let str: string;
    if (abs >= 10000) str = `${(v / 1000).toFixed(1)}k`;
    else if (abs >= 1000) str = `${(v / 1000).toFixed(2)}k`;
    else if (abs >= 100) str = v.toFixed(0);
    else if (abs >= 10) str = v.toFixed(1);
    else str = v.toFixed(2);
    return u ? `${str} ${u}` : str;
  }
</script>

<div
  class="knob-wrap"
  class:dragging
  class:midi-learning={learning}
  class:midi-bound={!!binding}
  onpointerenter={() => (hovering = true)}
  onpointerleave={() => (hovering = false)}
  role="presentation"
>
  {#if dragging || hovering}
    <div class="value">{format(liveValue, units)}</div>
  {/if}
  <div
    class="knob"
    role="slider"
    tabindex="0"
    aria-label={label}
    aria-valuemin={min}
    aria-valuemax={max}
    aria-valuenow={liveValue}
    oncontextmenu={openContextMenu}
    onpointerdown={pointerdown}
    onpointermove={pointermove}
    onpointerup={pointerup}
    ondblclick={dblclick}
    onwheel={wheel}
  >
    <div class="tick" style:transform="rotate({angle}deg)"></div>
  </div>
  <div class="label">{label}</div>
  {#if binding}
    <div class="midi-badge" title="Bound to MIDI Channel {binding.channel + 1}, CC {binding.cc}">
      CC {binding.cc}
    </div>
  {/if}
</div>

{#if moduleId && paramId}
  <ControlContextMenu
    open={ctxOpen}
    x={ctxX}
    y={ctxY}
    title={`${moduleId} · ${label}`}
    hasBinding={!!binding}
    bindingLabel={binding ? `CH ${binding.channel + 1} · CC ${binding.cc}` : undefined}
    onlearn={onLearnPick}
    onforget={onForgetPick}
    onclose={() => (ctxOpen = false)}
    surfaces={ctxSurfaces}
    onsendtosurface={onSendToSurface}
    onremovefromsurface={onRemoveFromSurface}
    electras={ctxElectras}
    onassignelectra={onAssignElectra}
    onclearelectra={onClearElectra}
  />
{/if}

<style>
  .knob-wrap {
    position: relative;
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    user-select: none;
    touch-action: none;
  }
  .knob {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: #2a2f3a;
    border: 1px solid #404652;
    position: relative;
    cursor: ns-resize;
    outline: none;
  }
  .knob:focus-visible {
    box-shadow: 0 0 0 2px var(--accent);
  }
  .knob-wrap.dragging .knob {
    background: #353a47;
    box-shadow: 0 0 0 2px var(--accent), 0 0 6px var(--accent-glow);
  }
  .tick {
    position: absolute;
    top: 50%;
    left: 50%;
    width: 2px;
    height: 14px;
    margin-left: -1px;
    margin-top: -16px;
    background: var(--text);
    transform-origin: 50% 100%;
    border-radius: 1px;
    pointer-events: none;
  }
  .label {
    font-size: 0.65rem;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    pointer-events: none;
    /* Keep long param labels (e.g. "CUTOFF", "RES 2") from spilling past the
       knob and colliding with a sibling knob's label in a cramped host (the
       Control Surface group box). Clamp to the wrap width + ellipsize. */
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: center;
  }
  /* MIDI Learn visual states (mirror Fader.svelte). */
  .knob-wrap.midi-learning {
    outline: 2px solid #f5c248;
    outline-offset: 2px;
    border-radius: 4px;
    animation: knob-midi-learn-pulse 1.1s ease-in-out infinite;
  }
  @keyframes knob-midi-learn-pulse {
    0%, 100% { outline-color: rgba(245, 194, 72, 1); }
    50%      { outline-color: rgba(245, 194, 72, 0.3); }
  }
  .midi-badge {
    position: absolute;
    bottom: -2px;
    right: -2px;
    font-family: ui-monospace, monospace;
    font-size: 0.55rem;
    line-height: 1;
    padding: 2px 4px;
    background: rgba(96, 165, 250, 0.18);
    color: #a8d3ff;
    border-radius: 2px;
    pointer-events: none;
    letter-spacing: 0.02em;
  }
  .value {
    position: absolute;
    background: #14171c;
    border: 1px solid #404652;
    color: var(--text);
    padding: 2px 6px;
    font-size: 0.7rem;
    font-family: ui-monospace, monospace;
    border-radius: 3px;
    white-space: nowrap;
    transform: translateY(-22px);
    pointer-events: none;
    z-index: 10;
  }
</style>
