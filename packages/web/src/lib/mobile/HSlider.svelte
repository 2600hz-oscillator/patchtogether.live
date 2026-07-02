<script lang="ts">
  // HSlider — full-width horizontal touch slider for the mobile views.
  //
  // Touch rules (spec §5): ≥44px target, RELATIVE drag (never jump-to-touch),
  // long-press = reset to default (replaces dblclick/wheel, absent on mobile),
  // writes coalesced through createDragCommit (mandatory — raw per-move writes
  // flood the snapshot bus and starve the audio thread).
  import { onDestroy } from 'svelte';
  import { createDragCommit } from '$lib/ui/controls/drag-commit';

  interface Props {
    label: string;
    value: number;
    min: number;
    max: number;
    /** Reset target for long-press. Defaults to `min`. */
    defaultValue?: number;
    /** Optional value formatter for the readout. */
    format?: (v: number) => string;
    /** Center-detent render (EQ ±dB bands): fill from center, 0 tick. */
    centerDetent?: boolean;
    onchange: (v: number) => void;
    testid?: string;
  }
  let {
    label,
    value,
    min,
    max,
    defaultValue,
    format,
    centerDetent = false,
    onchange,
    testid,
  }: Props = $props();

  const commit = createDragCommit((v) => onchange(v));
  onDestroy(() => commit.dispose());

  // Live value while dragging (thumb tracks the finger at full rate; the
  // store write is rAF-coalesced). Outside a drag we render the prop.
  let dragging = $state(false);
  let liveValue = $state(0);
  let shown = $derived(dragging ? liveValue : value);
  let frac = $derived(max > min ? Math.max(0, Math.min(1, (shown - min) / (max - min))) : 0);
  let zeroFrac = $derived(max > min ? Math.max(0, Math.min(1, (0 - min) / (max - min))) : 0);

  let trackEl: HTMLDivElement | null = $state(null);
  let startX = 0;
  let startValue = 0;
  let moved = false;
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;

  function clamp(v: number): number {
    return Math.max(min, Math.min(max, v));
  }

  function clearLongPress() {
    if (longPressTimer !== null) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }

  function onPointerDown(e: PointerEvent) {
    if (!trackEl) return;
    trackEl.setPointerCapture(e.pointerId);
    dragging = true;
    moved = false;
    startX = e.clientX;
    startValue = value;
    liveValue = value;
    // Long-press (600ms, <6px travel) = reset to default.
    clearLongPress();
    longPressTimer = setTimeout(() => {
      if (!moved && defaultValue !== undefined) {
        liveValue = clamp(defaultValue);
        commit.commit(liveValue);
        commit.flush();
      }
    }, 600);
  }

  function onPointerMove(e: PointerEvent) {
    if (!dragging || !trackEl) return;
    const dx = e.clientX - startX;
    if (Math.abs(dx) > 6) moved = true;
    const w = trackEl.clientWidth || 1;
    liveValue = clamp(startValue + (dx / w) * (max - min));
    commit.commit(liveValue);
  }

  function onPointerUp() {
    if (!dragging) return;
    clearLongPress();
    commit.flush();
    dragging = false;
  }

  /** Tap the label = zero the value (EQ tap-label-to-zero affordance). Only
   *  wired when centerDetent (a zero make senses there). */
  function onLabelTap() {
    if (!centerDetent) return;
    commit.commit(clamp(0));
    commit.flush();
  }
</script>

<div class="hslider" data-testid={testid}>
  <button class="hs-label" type="button" onclick={onLabelTap} tabindex={centerDetent ? 0 : -1}>
    {label}
  </button>
  <div
    class="hs-track"
    bind:this={trackEl}
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onpointercancel={onPointerUp}
    role="slider"
    aria-label={label}
    aria-valuemin={min}
    aria-valuemax={max}
    aria-valuenow={shown}
    tabindex="0"
  >
    {#if centerDetent}
      <div
        class="hs-fill center"
        style="left:{Math.min(zeroFrac, frac) * 100}%;width:{Math.abs(frac - zeroFrac) * 100}%"
      ></div>
      <div class="hs-zero" style="left:{zeroFrac * 100}%"></div>
    {:else}
      <div class="hs-fill" style="width:{frac * 100}%"></div>
    {/if}
    <div class="hs-thumb" style="left:{frac * 100}%"></div>
  </div>
  <span class="hs-value">{format ? format(shown) : shown.toFixed(2)}</span>
</div>

<style>
  .hslider {
    display: grid;
    grid-template-columns: 72px 1fr 52px;
    align-items: center;
    gap: 8px;
    min-height: 44px;
  }
  .hs-label {
    background: none;
    border: none;
    padding: 0;
    color: var(--text-dim, #8b93a3);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hs-track {
    position: relative;
    height: 44px;
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.09);
    touch-action: none; /* the drag surface owns the gesture */
    overflow: hidden;
  }
  .hs-fill {
    position: absolute;
    inset: 0 auto 0 0;
    background: color-mix(in srgb, var(--accent, #4f8cff) 45%, transparent);
    pointer-events: none;
  }
  .hs-fill.center {
    inset: 0 auto 0 auto;
  }
  .hs-zero {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 1px;
    background: rgba(255, 255, 255, 0.28);
    pointer-events: none;
  }
  .hs-thumb {
    position: absolute;
    top: 4px;
    bottom: 4px;
    width: 4px;
    margin-left: -2px;
    border-radius: 2px;
    background: var(--accent, #4f8cff);
    pointer-events: none;
  }
  .hs-value {
    color: var(--text, #dbe2ee);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    text-align: right;
  }
</style>
