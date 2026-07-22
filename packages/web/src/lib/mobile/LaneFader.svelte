<script lang="ts">
  // LaneFader — the MIX tab's full-width horizontal fader strip with the VU
  // rendered as a fill bar BEHIND the track (spec §3 MIX). Relative drag
  // (never jump-to-touch), long-press = reset to default, drag-commit wired.
  //
  // The VU prop is pushed by the parent's SINGLE onMeterFrame subscription —
  // this component runs NO rAF loop of its own (the private-loop regression).
  import { onDestroy } from 'svelte';
  import { createDragCommit } from '$lib/ui/controls/drag-commit';

  interface Props {
    value: number; // 0..1 volume
    vu: number; // 0..1 post-fader RMS (rendered behind the track)
    muted?: boolean;
    defaultValue?: number;
    label: string;
    onchange: (v: number) => void;
    testid?: string;
  }
  let { value, vu, muted = false, defaultValue = 0.8, label, onchange, testid }: Props = $props();

  const commit = createDragCommit((v) => onchange(v));
  onDestroy(() => commit.dispose());

  let dragging = $state(false);
  let liveValue = $state(0);
  let shown = $derived(dragging ? liveValue : value);
  let frac = $derived(Math.max(0, Math.min(1, shown)));
  // VU display: clamp + a mild perceptual lift so quiet material still shows.
  let vuFrac = $derived(Math.max(0, Math.min(1, Math.sqrt(Math.max(0, vu)))));

  let trackEl: HTMLDivElement | null = $state(null);
  let startX = 0;
  let startValue = 0;
  let moved = false;
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;

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
    clearLongPress();
    longPressTimer = setTimeout(() => {
      if (!moved) {
        liveValue = defaultValue;
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
    liveValue = Math.max(0, Math.min(1, startValue + dx / w));
    commit.commit(liveValue);
  }

  function onPointerUp() {
    if (!dragging) return;
    clearLongPress();
    commit.flush();
    dragging = false;
  }
</script>

<div
  class="lane-fader"
  class:muted
  bind:this={trackEl}
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={onPointerUp}
  onpointercancel={onPointerUp}
  role="slider"
  aria-label="{label} volume"
  aria-valuemin={0}
  aria-valuemax={1}
  aria-valuenow={shown}
  tabindex="0"
  data-testid={testid}
>
  <div class="vu" style="width:{vuFrac * 100}%"></div>
  <div class="fill" style="width:{frac * 100}%"></div>
  <div class="thumb" style="left:{frac * 100}%"></div>
</div>

<style>
  .lane-fader {
    position: relative;
    height: 56px;
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.09);
    overflow: hidden;
    touch-action: none;
  }
  .vu {
    position: absolute;
    inset: 0 auto 0 0;
    background: linear-gradient(
      to right,
      rgba(64, 200, 120, 0.28),
      rgba(64, 200, 120, 0.45)
    );
    transition: width 60ms linear;
    pointer-events: none;
  }
  .fill {
    position: absolute;
    inset: 0 auto 0 0;
    background: color-mix(in srgb, var(--accent, #4f8cff) 26%, transparent);
    pointer-events: none;
  }
  .thumb {
    position: absolute;
    top: 6px;
    bottom: 6px;
    width: 5px;
    margin-left: -2.5px;
    border-radius: 3px;
    background: var(--accent, #4f8cff);
    pointer-events: none;
  }
  .muted .fill,
  .muted .thumb {
    background: rgba(255, 90, 90, 0.4);
  }
</style>
