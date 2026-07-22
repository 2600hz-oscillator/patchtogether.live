<script lang="ts">
  // KnobConic — the RACKLINE canonical dial (ux-fullview `.knob`): a
  // conic-gradient VALUE ARC driven by a single normalized `--v` (0..1) + a
  // steel `.cap` + a `.ptr` pointer, tinted by the faceplate's `--domain`
  // (falls back to `--accent`). Behaviour is identical to Knob.svelte — vertical
  // drag (Shift = fine, Cmd/Ctrl = finer), wheel, double-click reset, motorized
  // readLive, MIDI-Learn + ControlContextMenu, clip-automation touch-suspend —
  // so a card swaps Knob → KnobConic with no plumbing change. The existing
  // Knob.svelte is untouched (its ~79 importers keep the flat dial).
  import type { KnobCurve } from '$lib/graph/types';
  import { onDestroy, onMount, untrack } from 'svelte';
  import { createDragCommit } from './drag-commit';
  import ControlContextMenu from './ControlContextMenu.svelte';
  import { makeMidiAssignable } from './midi-assignable.svelte';
  import { notifyAutomationTouch, notifyAutomationRelease } from '$lib/audio/automation-touch';
  import { knobValueToFrac, knobFracToValue, knobPointerAngle } from './knob-conic-model';

  interface Props {
    value: number;
    min: number;
    max: number;
    defaultValue: number;
    label: string;
    units?: string;
    curve?: KnobCurve;
    onchange: (value: number) => void;
    /** Optional live-value reader — polled each rAF (when not dragging) so a
     *  patched LFO visibly rotates the pointer + arc (motorized dial). */
    readLive?: () => number | undefined;
    /** MIDI-Learn addressing — both set ⇒ right-click binds a CC. */
    moduleId?: string;
    paramId?: string;
    /** Dial size. md = the lane default, lg/xl = dock hero, sm = dense grids. */
    size?: 'sm' | 'md' | 'lg' | 'xl';
    /** Override the arc/pointer accent (defaults to the domain colour). */
    accent?: string;
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
    size = 'md',
    accent,
  }: Props = $props();

  // ---- MIDI-Learn (shared factory, kind:'cc') — getters so the factory reads
  //      the CURRENT reactive props across re-renders (mirrors Knob.svelte). ----
  const midi = makeMidiAssignable({
    kind: 'cc',
    get moduleId() { return moduleId; },
    get paramId() { return paramId; },
    get min() { return min; },
    get max() { return max; },
    get onchange() { return onchange; },
    onTransient: (v) => { if (!dragging) liveValue = v; },
  });

  let ctxOpen = $state(false);
  let ctxX = $state(0);
  let ctxY = $state(0);

  function openContextMenu(e: MouseEvent) {
    if (!moduleId || !paramId) return;
    midi.refresh();
    e.preventDefault();
    e.stopPropagation();
    ctxX = e.clientX;
    ctxY = e.clientY;
    ctxOpen = true;
  }
  onMount(() => midi.register());

  function touchAutomation() {
    if (moduleId && paramId) notifyAutomationTouch({ nodeId: moduleId, paramId }, 'pointer');
  }
  function releaseAutomation() {
    if (moduleId && paramId) notifyAutomationRelease({ nodeId: moduleId, paramId }, 'pointer');
  }
  let wheelReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  function wheelTouch() {
    if (moduleId && paramId) notifyAutomationTouch({ nodeId: moduleId, paramId }, 'wheel');
    if (wheelReleaseTimer !== null) clearTimeout(wheelReleaseTimer);
    wheelReleaseTimer = setTimeout(() => {
      wheelReleaseTimer = null;
      if (moduleId && paramId) notifyAutomationRelease({ nodeId: moduleId, paramId }, 'wheel');
    }, 200);
  }

  let dragging = $state(false);
  let hovering = $state(false);
  let liveValue = $state(untrack(() => value));
  let raf: number | null = null;
  let currentValue = $derived(value);

  $effect(() => {
    if (dragging || midi.ccActive) return;
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
    if (!dragging && !readLive && !midi.ccActive) liveValue = currentValue;
  });

  const dragCommit = createDragCommit((v) => onchange(v));

  onDestroy(() => {
    if (raf !== null) cancelAnimationFrame(raf);
    if (wheelReleaseTimer !== null) clearTimeout(wheelReleaseTimer);
    dragCommit.dispose();
    midi.unregister();
  });

  // Arc fraction (0..1) → the `--v` custom property + pointer rotation.
  let frac = $derived(knobValueToFrac(liveValue, min, max, curve));
  let ptrAngle = $derived(knobPointerAngle(frac));

  let startY = 0;
  let startFrac = 0;
  let mod: 'none' | 'shift' | 'fine' = 'none';

  function pointerdown(e: PointerEvent) {
    if (e.button !== 0) return;
    touchAutomation();
    dragging = true;
    startY = e.clientY;
    startFrac = knobValueToFrac(value, min, max, curve);
    mod = e.shiftKey ? 'shift' : (e.ctrlKey || e.metaKey) ? 'fine' : 'none';
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function pointermove(e: PointerEvent) {
    if (!dragging) return;
    const dy = startY - e.clientY;
    const sensitivity = mod === 'fine' ? 1 / 20000 : mod === 'shift' ? 1 / 2000 : 1 / 200;
    const newFrac = startFrac + dy * sensitivity;
    const newValue = knobFracToValue(newFrac, min, max, curve);
    liveValue = newValue;
    if (newValue !== value) dragCommit.commit(newValue);
  }

  function pointerup(e: PointerEvent) {
    dragging = false;
    releaseAutomation();
    dragCommit.flush();
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  }

  function lostcapture() {
    if (!dragging) return;
    dragging = false;
    dragCommit.flush();
    releaseAutomation();
  }

  function dblclick() {
    onchange(defaultValue);
  }

  function wheel(e: WheelEvent) {
    e.preventDefault();
    wheelTouch();
    const step = e.shiftKey ? 0.001 : e.ctrlKey || e.metaKey ? 0.0001 : 0.005;
    const direction = e.deltaY < 0 ? 1 : -1;
    const newFrac = knobValueToFrac(value, min, max, curve) + direction * step;
    const newValue = knobFracToValue(newFrac, min, max, curve);
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
  class:midi-learning={midi.learning}
  class:midi-bound={!!midi.binding}
  onpointerenter={() => (hovering = true)}
  onpointerleave={() => (hovering = false)}
  role="presentation"
>
  {#if dragging || hovering}
    <div class="value">{format(liveValue, units)}</div>
  {/if}
  <div
    class="knob {size}"
    role="slider"
    tabindex="0"
    data-testid={paramId ? `control-${paramId}` : undefined}
    aria-label={label}
    aria-valuemin={min}
    aria-valuemax={max}
    aria-valuenow={liveValue}
    style:--v={frac}
    style:--ka={accent ?? undefined}
    oncontextmenu={openContextMenu}
    onpointerdown={pointerdown}
    onpointermove={pointermove}
    onpointerup={pointerup}
    onlostpointercapture={lostcapture}
    ondblclick={dblclick}
    onwheel={wheel}
  >
    <span class="cap"></span>
    <span class="ptr" style:transform="translate(-50%, -100%) rotate({ptrAngle}deg)"></span>
  </div>
  <div class="label">{label}</div>
  {#if midi.binding}
    <div class="midi-badge" title={`Bound to MIDI ${midi.bindingLabel}`}>
      {midi.badge}
    </div>
  {/if}
</div>

{#if moduleId && paramId}
  <ControlContextMenu
    open={ctxOpen}
    x={ctxX}
    y={ctxY}
    title={`${moduleId} · ${label}`}
    hasBinding={!!midi.binding}
    bindingLabel={midi.bindingLabel}
    onlearn={midi.learn}
    onforget={midi.forget}
    onclose={() => (ctxOpen = false)}
    surfaces={midi.surfaces}
    onsendtosurface={midi.sendToSurface}
    onremovefromsurface={midi.removeFromSurface}
    electras={midi.electras}
    onassignelectra={midi.assignElectra}
    onclearelectra={midi.clearElectra}
    automationRecorded={midi.automationRecorded}
    onclearautomation={midi.clearAutomation}
  />
{/if}

<style>
  /* ── RACKLINE conic dial (_kit.css §5.1). --v drives the value arc; --ka
     the accent (domain, else app accent). Structural steel/track colours are
     literal per the kit (they are NOT themed). ── */
  .knob-wrap {
    position: relative;
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    gap: 5px;
    user-select: none;
    touch-action: none;
  }
  .knob {
    --kb: 40px; /* md */
    --_ka: var(--ka, var(--domain, var(--accent)));
    position: relative;
    width: var(--kb);
    height: var(--kb);
    border-radius: 50%;
    padding: 3px;
    cursor: ns-resize;
    outline: none;
    background: conic-gradient(
      from 225deg,
      var(--_ka) calc(var(--v, 0.5) * 270deg),
      #2a313d 0 270deg,
      transparent 0
    );
    filter: drop-shadow(0 2px 3px rgba(0, 0, 0, 0.5));
  }
  .knob.sm { --kb: 26px; }
  .knob.lg { --kb: var(--kn-lg, 46px); }
  .knob.xl { --kb: 64px; }
  .knob:focus-visible {
    box-shadow: 0 0 0 2px var(--_ka);
  }
  .knob-wrap.dragging .knob {
    filter: drop-shadow(0 2px 3px rgba(0, 0, 0, 0.5)) brightness(1.08);
  }
  .cap {
    position: absolute;
    inset: 15%;
    border-radius: 50%;
    background: radial-gradient(circle at 38% 30%, #333b47, #12161d 74%);
    border: 1px solid #0a0d12;
    box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.08);
    pointer-events: none;
  }
  .ptr {
    position: absolute;
    left: 50%;
    top: 50%;
    width: 2px;
    height: calc(var(--kb) / 2 - 3px);
    background: var(--_ka);
    border-radius: 2px;
    transform-origin: 50% 100%;
    /* transform set inline (rotation) — origin/translate here */
    box-shadow: 0 0 5px var(--_ka);
    pointer-events: none;
  }
  .label {
    font-family: var(--mono, ui-monospace, monospace);
    font-size: 9px;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: var(--text-dim);
    pointer-events: none;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: center;
  }
  .knob-wrap.midi-learning {
    outline: 2px solid #f5c248;
    outline-offset: 2px;
    border-radius: 4px;
    animation: knob-conic-midi-learn-pulse 1.1s ease-in-out infinite;
  }
  @keyframes knob-conic-midi-learn-pulse {
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
    background: var(--module-bg-deep, #14171c);
    border: 1px solid var(--border-strong, #404652);
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
