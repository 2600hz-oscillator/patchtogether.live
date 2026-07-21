<!--
  VuMeter.svelte — a compact SEGMENTED level meter (the moog914 "RESO"
  reference). A stack of short segments lit bottom-up by level: warm (amber →
  yellow) at the top few, cool teal-green below, unlit segments dim. Clean, no
  chrome.

  LIVE DATA: this is a THIN renderer over the app's existing metering seam, NOT
  a new analyser stack. Two ways to feed it:
    • `getLevel` — a getter polled on the SHARED `onMeterFrame` ticker (the same
      coalesced rAF the scope / playhead meters use). The card wires it to
      `engine.read(node, 'level')` (an AnalyserNode-derived RMS on the module's
      output tap). This is the live path.
    • `level` — a plain reactive 0..1 (or dBFS with `db`) prop, for callers that
      already have the value (or for the showcase/tests).
  Peak-hold + attack/release smoothing run on that same shared frame. Cleans up
  its subscription on unmount and respects prefers-reduced-motion (no smoothing
  animation / no CSS transitions when reduced).
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { onMeterFrame } from '$lib/ui/meter-frame';
  import {
    dbfsToUnit,
    isSegmentLit,
    litCount,
    segmentColor,
    type VuOrientation,
  } from './vu-meter-model';

  interface Props {
    /** Live level getter, polled on the shared meter frame. Preferred (live). */
    getLevel?: () => number;
    /** Static/reactive level, used when `getLevel` is absent. */
    level?: number;
    /** Interpret the level (from either source) as dBFS instead of 0..1. */
    db?: boolean;
    /** Number of segments. Default 12 (the moog914 band count). */
    segments?: number;
    orientation?: VuOrientation;
    /** Show a held peak marker that decays slowly. Default true. */
    peakHold?: boolean;
    /** CSS length of the bar's long axis (height when vertical). Default 84px. */
    length?: number;
    /** CSS width of the bar's short axis. Default 12px. */
    thickness?: number;
    /** Optional test id on the root. */
    testid?: string;
    /** Accessible label. */
    ariaLabel?: string;
  }

  let {
    getLevel,
    level = 0,
    db = false,
    segments = 12,
    orientation = 'vertical',
    peakHold = true,
    length = 84,
    thickness = 12,
    testid,
    ariaLabel = 'level meter',
  }: Props = $props();

  // Normalize whatever units the caller uses to a 0..1 display fraction.
  function toUnit(v: number): number {
    return db ? dbfsToUnit(v) : v < 0 ? 0 : v > 1 ? 1 : v;
  }

  let reduced = $state(false);
  onMount(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia('(prefers-reduced-motion: reduce)');
    reduced = mq.matches;
    const onChange = () => (reduced = mq.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  });

  // The displayed (smoothed) level and the held peak. When `getLevel` is set we
  // drive these on the shared frame; otherwise they track the reactive `level`.
  let displayLevel = $state(0);
  let peakLevel = $state(0);

  // Smoothing coefficients (fraction toward target per frame). Fast attack so a
  // transient shows immediately, slow release so the bar falls smoothly. Peak
  // holds then bleeds off. Bypassed entirely under prefers-reduced-motion.
  const ATTACK = 0.6;
  const RELEASE = 0.16;
  const PEAK_DECAY = 0.012;

  $effect(() => {
    if (!getLevel) {
      // Static/reactive path — mirror the prop directly (no rAF).
      const u = toUnit(level);
      displayLevel = u;
      if (u > peakLevel) peakLevel = u;
      return;
    }
    const h = onMeterFrame(null, () => {
      const target = toUnit(getLevel());
      if (reduced) {
        displayLevel = target;
      } else if (target > displayLevel) {
        displayLevel += (target - displayLevel) * ATTACK;
      } else {
        displayLevel += (target - displayLevel) * RELEASE;
      }
      if (displayLevel > peakLevel) {
        peakLevel = displayLevel;
      } else if (peakHold && !reduced) {
        peakLevel = Math.max(displayLevel, peakLevel - PEAK_DECAY);
      } else {
        peakLevel = displayLevel;
      }
    });
    return () => h.stop();
  });

  // 0 = bottom .. segments-1 = top. We render top→bottom in the DOM (so the
  // amber peak zone is visually at the top for a vertical bar) but light by the
  // model's bottom-up index.
  const indices = $derived(
    orientation === 'vertical'
      ? Array.from({ length: segments }, (_, i) => segments - 1 - i)
      : Array.from({ length: segments }, (_, i) => i),
  );
  const lit = $derived(litCount(displayLevel, segments));
  // Peak segment index (0-based bottom-up); -1 when silent.
  const peakIdx = $derived(peakLevel <= 0 ? -1 : Math.min(segments - 1, litCount(peakLevel, segments) - 1));
</script>

<div
  class="vu"
  class:horizontal={orientation === 'horizontal'}
  class:reduced
  style="--len:{length}px; --thick:{thickness}px;"
  role="meter"
  aria-label={ariaLabel}
  aria-valuemin="0"
  aria-valuemax="1"
  aria-valuenow={displayLevel}
  data-testid={testid}
  data-lit={lit}
>
  {#each indices as i (i)}
    <div
      class="seg"
      class:lit={isSegmentLit(i, displayLevel, segments)}
      class:peak={peakHold && i === peakIdx}
      style="--c:{segmentColor(i, segments)};"
      data-seg={i}
    ></div>
  {/each}
</div>

<style>
  .vu {
    display: flex;
    flex-direction: column;
    gap: 2px;
    width: var(--thick);
    height: var(--len);
    padding: 2px;
    background: #0b0d11;
    border: 1px solid var(--border, #2a2d36);
    border-radius: 3px;
    box-sizing: border-box;
  }
  .vu.horizontal {
    flex-direction: row;
    width: var(--len);
    height: var(--thick);
  }
  .seg {
    flex: 1;
    border-radius: 1px;
    /* Unlit: the segment's own color, heavily dimmed (so the scale is faintly
       readable even at rest). */
    background: var(--c);
    opacity: 0.14;
    transition: opacity 90ms linear, box-shadow 90ms linear;
  }
  .seg.lit {
    opacity: 1;
    box-shadow: 0 0 4px -1px var(--c);
  }
  .seg.peak {
    opacity: 1;
    box-shadow: 0 0 6px 0 var(--c);
    outline: 1px solid var(--c);
  }
  .vu.reduced .seg {
    transition: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .seg {
      transition: none;
    }
  }
</style>
