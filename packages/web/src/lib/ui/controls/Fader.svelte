<script lang="ts">
  // Vertical fader — Phase 1's primary parameter control.
  //
  // Conventions:
  //   - Vertical drag: up = +, down = −. Shift = ×0.1 fine, Cmd/Ctrl = ×0.01.
  //   - Scroll wheel: small ticks (Shift / Cmd modifiers same as drag).
  //   - Double-click: reset to defaultValue.
  //   - Right-click: TODO menu (reset / type value / MIDI learn) — Day 8+.
  //
  // Motorized convention: when not being dragged AND a `readLive()` callback
  // is provided, the fader thumb position reflects the LIVE current value
  // (e.g., audioParam.value, which includes any CV modulation). This means
  // patching an LFO to a parameter visibly wiggles the fader. While the user
  // is actively dragging, drag input wins.
  import type { KnobCurve } from '$lib/graph/types';
  import { onDestroy, untrack } from 'svelte';
  import WaveformGlyph from './WaveformGlyph.svelte';

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
  }: Props = $props();

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

  onDestroy(() => {
    if (raf !== null) cancelAnimationFrame(raf);
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
    // then propagate to the patch state. The $effect won't re-sync liveValue
    // while dragging is true, so this assignment is the source of truth for
    // the thumb during the drag.
    liveValue = newValue;
    if (newValue !== value) onchange(newValue);
  }
  function pointerup(e: PointerEvent) {
    dragging = false;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  }
  function pointercancel(e: PointerEvent) {
    // Browser cancelled the gesture (e.g. touch interrupted, OS gesture). If
    // we don't clear `dragging`, the motorized readLive loop stays gated off
    // and the thumb freezes.
    dragging = false;
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
</script>

<div
  class="fader-wrap"
  class:dragging
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
      onpointerdown={pointerdown}
      onpointermove={pointermove}
      onpointerup={pointerup}
      onpointercancel={pointercancel}
      ondblclick={dblclick}
      onwheel={wheel}
    >
      <div class="track-line"></div>
      <div class="thumb" style:top="{thumbY}px"></div>
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
</div>

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
  .track:focus-visible {
    box-shadow: 0 0 0 2px var(--cable-cv);
  }
  .fader-wrap.dragging .track {
    background: #1c2028;
    border-color: var(--cable-cv);
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
  .label {
    font-size: 0.62rem;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    pointer-events: none;
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
