<script lang="ts">
  // Vertical fader — Phase 1's primary parameter control.
  //
  // Conventions:
  //   - Vertical drag: up = +, down = −. Shift = ×0.1 fine, Cmd/Ctrl = ×0.01.
  //   - Scroll wheel: small ticks (Shift / Cmd modifiers same as drag).
  //   - Double-click: reset to defaultValue.
  //   - Right-click (when moduleId+paramId set): control menu (MIDI Learn /
  //     Forget). Plain right-click — no modifier required.
  //
  // Motorized convention: when not being dragged AND a `readLive()` callback
  // is provided, the fader thumb position reflects the LIVE current value
  // (e.g., audioParam.value, which includes any CV modulation). This means
  // patching an LFO to a parameter visibly wiggles the fader. While the user
  // is actively dragging, drag input wins.
  import type { KnobCurve } from '$lib/graph/types';
  import { onDestroy, onMount, untrack } from 'svelte';
  import WaveformGlyph from './WaveformGlyph.svelte';
  import { skinStore } from '$lib/ui/skins/skin-store.svelte';
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

  /** A single inline glyph anchored at a normalized [0,1] fraction along the
   *  fader track. Used by the LFO-shape sliders to render sine/tri/saw/square
   *  icons alongside the slider so the user sees what they're morphing into. */
  export interface FaderGlyph {
    frac: number;
    kind: 'sine' | 'tri' | 'saw' | 'square';
  }

  /** Optional inline label anchored at a [0,1] fraction along the track.
   *  Cartesian's LFO division slider uses this to mark each snap point with
   *  "1/8", "1/4", "x2", etc. */
  export interface FaderTick {
    frac: number;
    label: string;
  }

  interface Props {
    /** User-set value from the patch graph (drives initial position). */
    value: number;
    min: number;
    max: number;
    defaultValue: number;
    label: string;
    units?: string;
    curve?: KnobCurve;
    /** Called on every drag delta. Mutate patch state from this callback. */
    onchange: (value: number) => void;
    /**
     * Optional live-value reader. If provided, the fader polls this each rAF
     * (when not being dragged) and renders that as the thumb position —
     * "motorized fader" behavior.
     */
    readLive?: () => number | undefined;
    /** Optional waveform glyphs anchored at fractions along the track. */
    glyphs?: FaderGlyph[];
    /** Optional text labels anchored at fractions along the track. */
    ticks?: FaderTick[];
    /** Optional override for the value-tag text. Useful when the underlying
     *  numeric value is an index into a discrete list (e.g. division ratios). */
    formatValue?: (v: number) => string;
    /** MIDI Learn — when both moduleId + paramId are set the fader becomes
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
    glyphs,
    ticks,
    formatValue,
    moduleId,
    paramId,
  }: Props = $props();

  // ---------------- MIDI Learn integration ----------------
  // Track this fader's binding (re-read whenever a learn captures or the
  // user forgets). A keyed Svelte rune via $derived would be nicest but
  // midi-learn's bindings map updates via class mutation; we re-poll on
  // demand and after our own actions.
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

  // Context menu state.
  let ctxOpen = $state(false);
  let ctxX = $state(0);
  let ctxY = $state(0);
  let ctxSurfaces = $state<Array<{ id: string; name: string; bound: boolean }>>([]);

  function refreshSurfaces() {
    if (!moduleId || !paramId) { ctxSurfaces = []; return; }
    ctxSurfaces = listControlSurfaces(patch.nodes).map((s) => ({
      id: s.id,
      name: s.name,
      bound: surfaceHasBinding(readSurfaceData(patch.nodes[s.id]), moduleId!, paramId!),
    }));
  }

  function openContextMenu(e: MouseEvent) {
    if (!moduleId || !paramId) return; // feature off when not addressable
    refreshSurfaces();
    // Plain right-click on a wired fader opens the control menu (MIDI Learn /
    // Forget). stopPropagation keeps the event off the node menu; the node
    // menu (Docs / Duplicate / Unpatch all / Delete) is still reachable by
    // right-clicking the card *background* away from any control.
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

  // Register / unregister this fader's setter so a binding loaded from
  // localStorage on cold-start drives the knob as soon as the card mounts.
  onMount(() => {
    if (!moduleId || !paramId) return;
    registerSetter(moduleId, paramId, { min, max, onchange });
  });
  onDestroy(() => {
    if (!moduleId || !paramId) return;
    unregisterSetter(moduleId, paramId);
    // If this fader was the in-flight learn target, cancel it so a
    // re-mount doesn't accidentally capture the next CC.
    if (learning) cancelLearn();
  });

  // Display value: what the thumb position renders against. Driven by either
  // the user (during drag) or by readLive (when motorized + idle). The
  // initialization-from-prop is intentional (`untrack` makes it explicit) —
  // the $effects below keep liveValue synced after mount.
  let liveValue = $state(untrack(() => value));
  let dragging = $state(false);
  let hovering = $state(false);

  // Motorized read loop. Active whenever readLive is given and we're not dragging.
  // Use a $derived getter for `value` so the closure always reads the current
  // prop, not the captured-at-mount initial.
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

  // When the user-set value changes externally and we're not dragging and there's
  // no readLive, snap liveValue to it.
  $effect(() => {
    if (!dragging && !readLive) liveValue = currentValue;
  });

  // rAF-coalesced commit pump. During a drag, pointermove fires at
  // 120–240 Hz on modern hardware; each call to onchange() mutates the
  // SyncedStore patch graph and triggers a full snapshot rebuild +
  // reconciler walk + Svelte UI re-render. Without coalescing, the
  // resulting main-thread storm starves the audio scheduler's lookahead
  // window and causes audible tempo drift / glitches (LFOs driving the
  // same AudioParam don't have this problem — they bypass JS entirely).
  // dragCommit batches all pointermove updates within one frame into a
  // single onchange call. Local liveValue still updates synchronously,
  // so visual feedback is unaffected.
  const dragCommit = createDragCommit((v) => onchange(v));

  onDestroy(() => {
    if (raf !== null) cancelAnimationFrame(raf);
    dragCommit.dispose();
  });

  // Map value ↔ normalized [0,1] using the curve.
  function valueToFrac(v: number): number {
    const clamped = Math.max(min, Math.min(max, v));
    if (curve === 'log') {
      if (min <= 0 || max <= 0) return (clamped - min) / (max - min);
      return Math.log(clamped / min) / Math.log(max / min);
    }
    if (curve === 'exp') {
      const f = (clamped - min) / (max - min);
      return f * f;
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
    if (curve === 'discrete') {
      return Math.round(min + fr * (max - min));
    }
    return min + fr * (max - min);
  }

  let displayFrac = $derived(valueToFrac(liveValue));

  let startY = 0;
  let startFrac = 0;
  let mod: 'none' | 'shift' | 'fine' = 'none';

  /** Compute the frac corresponding to a clientY coordinate within the track. */
  function fracFromClientY(trackEl: HTMLElement, clientY: number): number {
    const rect = trackEl.getBoundingClientRect();
    const yInTrack = clientY - rect.top;
    return Math.max(0, Math.min(1, 1 - yInTrack / rect.height));
  }

  function pointerdown(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const trackEl = e.currentTarget as HTMLElement;
    mod = e.shiftKey ? 'shift' : (e.ctrlKey || e.metaKey) ? 'fine' : 'none';

    // Click-to-jump unless the user is grabbing very close to the current thumb
    // (so you can still hold-and-drag from the thumb without surprise jumps).
    const clickFrac = fracFromClientY(trackEl, e.clientY);
    const grabRadius = 0.08; // 8% of track height — the thumb's own ~17% visual size
    const jumped = Math.abs(clickFrac - displayFrac) > grabRadius;
    const initialFrac = jumped ? clickFrac : displayFrac;

    dragging = true;
    startY = e.clientY;
    startFrac = initialFrac;

    if (jumped) {
      // Snap thumb (and patch state) to click position before drag continues.
      const newValue = fracToValue(clickFrac);
      liveValue = newValue;
      if (newValue !== value) onchange(newValue);
    }

    trackEl.setPointerCapture(e.pointerId);
  }

  function pointermove(e: PointerEvent) {
    if (!dragging) return;
    e.preventDefault();
    const dy = startY - e.clientY; // up = positive
    // 100 px = full range at default sensitivity; modifiers slow it.
    const sensitivity = mod === 'fine' ? 1 / 10000 : mod === 'shift' ? 1 / 1000 : 1 / 100;
    const newFrac = Math.max(0, Math.min(1, startFrac + dy * sensitivity));
    const newValue = fracToValue(newFrac);
    // Update the local thumb position IMMEDIATELY so the drag feels real,
    // then stage the patch-state commit for the next animation frame.
    // The $effect won't re-sync liveValue while dragging is true, so this
    // assignment is the source of truth for the thumb during the drag.
    liveValue = newValue;
    if (newValue !== value) dragCommit.commit(newValue);
  }
  function pointerup(e: PointerEvent) {
    dragging = false;
    // Force-commit the final drag position before the pointer is fully
    // released. Without this, a trailing rAF could be cancelled by a
    // re-render storm and the patch store would lag the last visible
    // thumb position by one frame.
    dragCommit.flush();
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  }
  function pointercancel(e: PointerEvent) {
    // Browser cancelled the gesture (e.g. touch interrupted, OS gesture). If
    // we don't clear `dragging`, the motorized readLive loop stays gated off
    // and the thumb freezes.
    dragging = false;
    dragCommit.flush();
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch { /* capture may have been released already */ }
  }
  function dblclick(e: MouseEvent) {
    e.stopPropagation();
    onchange(defaultValue);
  }
  function wheel(e: WheelEvent) {
    e.preventDefault();
    e.stopPropagation();
    const step = e.shiftKey ? 0.001 : (e.ctrlKey || e.metaKey) ? 0.0001 : 0.01;
    const dir = e.deltaY < 0 ? 1 : -1;
    const newFrac = displayFrac + dir * step;
    const newValue = fracToValue(newFrac);
    if (newValue !== value) onchange(newValue);
  }

  function format(v: number, u: string): string {
    const abs = Math.abs(v);
    let s: string;
    if (abs >= 10000) s = `${(v / 1000).toFixed(1)}k`;
    else if (abs >= 1000) s = `${(v / 1000).toFixed(2)}k`;
    else if (abs >= 100) s = v.toFixed(0);
    else if (abs >= 10) s = v.toFixed(1);
    else s = v.toFixed(2);
    return u ? `${s} ${u}` : s;
  }

  // Track height in pixels (set in CSS). We compute thumb position from frac.
  const TRACK_HEIGHT = 80;
  const THUMB_HEIGHT = 14;
  let thumbY = $derived((1 - displayFrac) * (TRACK_HEIGHT - THUMB_HEIGHT));

  /** Bipolar = the param's natural range straddles zero, so the visual
   *  center of the track corresponds to 0V / "no modulation". For these
   *  sliders we render a center hash mark so the user can see the zero
   *  crossing at a glance (per the global ±1 CV convention). Unipolar
   *  sliders (e.g. cutoff freq, attack time) have no meaningful midpoint
   *  hash — we omit it to avoid implying one. */
  let isBipolar = $derived(min < 0 && max > 0);

  /** Pick the index of the glyph closest to the current frac (highlight). */
  let activeGlyphIdx = $derived.by(() => {
    if (!glyphs || glyphs.length === 0) return -1;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < glyphs.length; i++) {
      const d = Math.abs((glyphs[i]?.frac ?? 0) - displayFrac);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  });

  /** Pick index of nearest tick label (similar logic, separate list). */
  let activeTickIdx = $derived.by(() => {
    if (!ticks || ticks.length === 0) return -1;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < ticks.length; i++) {
      const d = Math.abs((ticks[i]?.frac ?? 0) - displayFrac);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  });

  /** Display string for the live value, applying the optional override. */
  function valueText(v: number): string {
    if (formatValue) return formatValue(v);
    return format(v, units);
  }

  // Sprite-mode: when the active skin opts into controlStyle:'sprite',
  // render the handle as an inline <svg> sprite + paint the track with
  // the skin's faderTrackBg image. CSS rendering path is preserved for
  // every other skin (controlStyle undefined => 'css').
  let activeSkin = $derived(skinStore.currentSkin);
  let useSprite = $derived(activeSkin.controlStyle === 'sprite');
  let handleSvg = $derived(activeSkin.faderHandleSvg ?? '');
</script>

<div
  class="fader-wrap"
  class:dragging
  class:sprite={useSprite}
  class:midi-learning={learning}
  class:midi-bound={!!binding}
  data-control-style={useSprite ? 'sprite' : 'css'}
  onpointerenter={() => (hovering = true)}
  onpointerleave={() => (hovering = false)}
  role="presentation"
>
  {#if dragging || hovering}
    <div class="value-tag">{valueText(liveValue)}</div>
  {/if}
  <div class="fader-row-inner">
    <div
      class="track"
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
      onpointercancel={pointercancel}
      ondblclick={dblclick}
      onwheel={wheel}
    >
      <div class="track-line"></div>
      {#if isBipolar}
        <div class="zero-hash" aria-hidden="true" data-testid="fader-zero-hash"></div>
      {/if}
      {#if useSprite && handleSvg}
        <!-- Sprite handle. {@html} is safe because handleSvg comes from a
             trusted, in-tree skin object — never user input — and is the
             only path that consumes inline SVG markup. -->
        <div
          class="thumb thumb-sprite"
          style:top="{thumbY}px"
          data-testid="fader-handle-sprite"
        >
          {@html handleSvg}
        </div>
      {:else}
        <div class="thumb" style:top="{thumbY}px"></div>
      {/if}
    </div>
    {#if glyphs && glyphs.length > 0}
      <div class="glyph-rail" aria-hidden="true">
        {#each glyphs as g, i (i)}
          <div
            class="glyph-anchor"
            style:top="{(1 - g.frac) * (TRACK_HEIGHT - THUMB_HEIGHT) + THUMB_HEIGHT / 2}px"
          >
            <WaveformGlyph kind={g.kind} active={i === activeGlyphIdx} size={14} />
          </div>
        {/each}
      </div>
    {/if}
    {#if ticks && ticks.length > 0}
      <div class="tick-rail" aria-hidden="true">
        {#each ticks as t, i (i)}
          <div
            class="tick-anchor"
            class:active={i === activeTickIdx}
            style:top="{(1 - t.frac) * (TRACK_HEIGHT - THUMB_HEIGHT) + THUMB_HEIGHT / 2}px"
          >{t.label}</div>
        {/each}
      </div>
    {/if}
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
  />
{/if}

<style>
  .fader-wrap {
    position: relative;
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    user-select: none;
    touch-action: none;
  }
  .track {
    position: relative;
    width: 22px;
    height: 80px;
    background: #14171c;
    border: 1px solid #404652;
    border-radius: 3px;
    cursor: ns-resize;
    outline: none;
  }
  /* Sprite mode: paint the track with the skin's faderTrackBg image
   * (data: URL) so the slot reads as a routed hardware cutout. The
   * fallback chain still resolves to the CSS-mode track if the var is
   * missing — the cover-size + center-position keep the inlay aligned
   * regardless of which skin set the var. */
  .fader-wrap.sprite .track {
    background: var(--fader-track-bg, #14171c) center/cover no-repeat, #14171c;
    border-color: var(--border-strong);
  }
  .track:focus-visible {
    box-shadow: 0 0 0 2px var(--accent);
  }
  .fader-wrap.dragging .track {
    background: #1c2028;
    border-color: var(--accent);
    box-shadow: 0 0 6px var(--accent-glow);
  }
  .track-line {
    position: absolute;
    top: 4px;
    bottom: 4px;
    left: 50%;
    width: 2px;
    margin-left: -1px;
    background: #2a2f3a;
    border-radius: 1px;
    pointer-events: none;
  }
  .zero-hash {
    /* 0V / center indicator for bipolar faders. Sits at the visual
       midpoint of the track (which IS the value-zero point because
       min < 0 < max with the linear/exp/log mapping symmetric for
       bipolar ranges). Subtle but legible — slightly brighter than
       the track-line so the eye picks it up. */
    position: absolute;
    top: 50%;
    left: 2px;
    right: 2px;
    height: 1px;
    margin-top: -0.5px;
    background: var(--text-dim, #6a7080);
    pointer-events: none;
  }
  .thumb {
    position: absolute;
    left: 1px;
    right: 1px;
    height: 14px;
    background: linear-gradient(180deg, #4a5063 0%, #2a2f3a 100%);
    border: 1px solid #5a6075;
    border-radius: 2px;
    box-shadow: 0 1px 0 rgba(255, 255, 255, 0.06) inset, 0 -1px 2px rgba(0, 0, 0, 0.3) inset;
    pointer-events: none;
  }
  .thumb::after {
    /* Center indicator line — the visual "tick" that's easy to read at a glance */
    content: '';
    position: absolute;
    top: 50%;
    left: 3px;
    right: 3px;
    height: 1px;
    background: var(--text);
    transform: translateY(-50%);
    border-radius: 0.5px;
  }
  /* Sprite handle: SVG fills the thumb box, no CSS gradient overlay, no
   * pseudo-element tick (the sprite paints its own indicator). The
   * stroke + border are removed so the SVG owns the silhouette. */
  .thumb-sprite {
    background: transparent;
    border: none;
    box-shadow: none;
    padding: 0;
    overflow: hidden;
  }
  .thumb-sprite::after { content: none; }
  .thumb-sprite :global(svg) {
    width: 100%;
    height: 100%;
    display: block;
  }
  .label {
    font-size: 0.62rem;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    pointer-events: none;
  }
  /* MIDI Learn visual states. */
  .fader-wrap.midi-learning {
    outline: 2px solid #f5c248;
    outline-offset: 2px;
    border-radius: 4px;
    animation: midi-learn-pulse 1.1s ease-in-out infinite;
  }
  @keyframes midi-learn-pulse {
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
  /* Sprite-mode label — bumps weight + size + applies the skin-supplied
   * silkscreen font (falls back to the inherited stack when unset). */
  .fader-wrap.sprite .label {
    font-family: var(--font-silkscreen, inherit);
    font-weight: 600;
    letter-spacing: 0.08em;
    color: var(--text);
  }
  .value-tag {
    position: absolute;
    background: #14171c;
    border: 1px solid #404652;
    color: var(--text);
    padding: 2px 6px;
    font-size: 0.7rem;
    font-family: ui-monospace, monospace;
    border-radius: 3px;
    white-space: nowrap;
    transform: translate(34px, 0);
    top: 0;
    pointer-events: none;
    z-index: 10;
  }
  .fader-row-inner {
    position: relative;
    display: flex;
    flex-direction: row;
    align-items: stretch;
    gap: 4px;
  }
  .glyph-rail, .tick-rail {
    position: relative;
    width: 16px;
    height: 80px;
    pointer-events: none;
  }
  .tick-rail {
    width: auto;
    min-width: 22px;
  }
  .glyph-anchor, .tick-anchor {
    position: absolute;
    left: 0;
    transform: translateY(-50%);
    line-height: 1;
  }
  .tick-anchor {
    font-size: 0.55rem;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
    white-space: nowrap;
    transition: color 0.08s ease-out;
  }
  .tick-anchor.active {
    color: var(--cable-cv);
  }
</style>
