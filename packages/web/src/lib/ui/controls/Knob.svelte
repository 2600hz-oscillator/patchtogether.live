<script lang="ts">
  // D15 Knob: vertical drag, Shift = ×0.1 fine, Cmd/Ctrl = ×0.01 fine,
  // double-click = reset to default, value tooltip on drag and on hover.
  // Curve maps display angle ↔ internal value while DSP stays linear (D15).
  import type { KnobCurve } from '$lib/graph/types';

  interface Props {
    value: number;
    min: number;
    max: number;
    defaultValue: number;
    label: string;
    units?: string;
    curve?: KnobCurve;
    onchange: (value: number) => void;
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
  }: Props = $props();

  let dragging = $state(false);
  let hovering = $state(false);

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

  let angle = $derived(-135 + valueToFrac(value) * 270);

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
    if (newValue !== value) onchange(newValue);
  }

  function pointerup(e: PointerEvent) {
    dragging = false;
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
  onpointerenter={() => (hovering = true)}
  onpointerleave={() => (hovering = false)}
  role="presentation"
>
  {#if dragging || hovering}
    <div class="value">{format(value, units)}</div>
  {/if}
  <div
    class="knob"
    role="slider"
    tabindex="0"
    aria-label={label}
    aria-valuemin={min}
    aria-valuemax={max}
    aria-valuenow={value}
    onpointerdown={pointerdown}
    onpointermove={pointermove}
    onpointerup={pointerup}
    ondblclick={dblclick}
    onwheel={wheel}
  >
    <div class="tick" style:transform="rotate({angle}deg)"></div>
  </div>
  <div class="label">{label}</div>
</div>

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
    box-shadow: 0 0 0 2px var(--cable-cv);
  }
  .knob-wrap.dragging .knob {
    background: #353a47;
    box-shadow: 0 0 0 2px var(--cable-cv);
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
