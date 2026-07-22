<script lang="ts">
  // Segmented — the RACKLINE `.segmented` / `.seg` / `.seg.on` discrete N-way
  // (filter type, wave shape, mode banks). A selector rendered inline: every
  // option is a button, one is `.on`. Same card-kit plumbing as Knob/Fader; a
  // numeric roster addressed by a paramId is MIDI-assignable (a learned CC
  // steps across the row) with a right-click ControlContextMenu.
  import { onDestroy, onMount, untrack } from 'svelte';
  import ControlContextMenu from './ControlContextMenu.svelte';
  import { makeMidiAssignable } from './midi-assignable.svelte';
  import { activeSegmentIndex, type Segment } from './segmented-model';
  import { numericOptionRange } from './selector-model';

  type Val = number | string;

  interface Props {
    value: Val;
    segments: readonly Segment<Val>[];
    onchange: (value: Val) => void;
    /** Optional uppercase group label rendered above the row. */
    label?: string;
    readLive?: () => number | undefined;
    moduleId?: string;
    paramId?: string;
  }

  let { value, segments, onchange, label, readLive, moduleId, paramId }: Props = $props();

  let midiRange = $derived(numericOptionRange(segments));
  let midiEnabled = $derived(!!(moduleId && paramId && midiRange));

  function nearestSegmentValue(v: number): Val {
    let best: Val = segments[0]?.value ?? v;
    let bestD = Infinity;
    for (const s of segments) {
      if (typeof s.value !== 'number') continue;
      const d = Math.abs(s.value - v);
      if (d < bestD) { bestD = d; best = s.value; }
    }
    return best;
  }

  const midi = makeMidiAssignable({
    kind: 'cc',
    get moduleId() { return moduleId; },
    get paramId() { return paramId; },
    get min() { return midiRange?.min ?? 0; },
    get max() { return midiRange?.max ?? 1; },
    get onchange() { return (v: number) => onchange(nearestSegmentValue(v)); },
    onTransient: (v) => { liveValue = nearestSegmentValue(v); },
  });

  let liveValue = $state<Val>(untrack(() => value));
  let raf: number | null = null;
  let currentValue = $derived(value);
  $effect(() => {
    if (midi.ccActive) return;
    if (!readLive) { liveValue = currentValue; return; }
    const reader = readLive;
    function tick() {
      const v = reader();
      liveValue = v ?? currentValue;
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => { if (raf !== null) cancelAnimationFrame(raf); raf = null; };
  });
  $effect(() => { if (!readLive && !midi.ccActive) liveValue = currentValue; });

  let activeIdx = $derived(activeSegmentIndex(liveValue, segments));

  onMount(() => { if (midiEnabled) midi.register(); });
  onDestroy(() => { if (raf !== null) cancelAnimationFrame(raf); midi.unregister(); });

  function pick(v: Val) { if (v !== value) onchange(v); }

  let ctxOpen = $state(false);
  let ctxX = $state(0);
  let ctxY = $state(0);
  function openContextMenu(e: MouseEvent) {
    if (!midiEnabled) return;
    midi.refresh();
    e.preventDefault();
    e.stopPropagation();
    ctxX = e.clientX; ctxY = e.clientY; ctxOpen = true;
  }
</script>

<div class="segmented-wrap" class:midi-learning={midi.learning} class:midi-bound={!!midi.binding}>
  {#if label}<div class="seg-label">{label}</div>{/if}
  <!-- radiogroup is a non-focusable container; focus lives on the radio buttons -->
  <!-- svelte-ignore a11y_interactive_supports_focus a11y_no_static_element_interactions -->
  <div
    class="segmented"
    role="radiogroup"
    aria-label={label}
    data-testid={paramId ? `control-${paramId}` : undefined}
    oncontextmenu={openContextMenu}
  >
    {#each segments as seg, i (seg.value)}
      <button
        class="seg"
        type="button"
        class:on={i === activeIdx}
        role="radio"
        aria-checked={i === activeIdx}
        title={seg.title}
        onclick={() => pick(seg.value)}
      >{seg.label}</button>
    {/each}
  </div>
  {#if midi.binding}
    <span class="midi-badge" title={`Bound to MIDI ${midi.bindingLabel}`}>{midi.badge}</span>
  {/if}
</div>

{#if midiEnabled}
  <ControlContextMenu
    open={ctxOpen}
    x={ctxX}
    y={ctxY}
    title={`${moduleId} · ${label ?? paramId}`}
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
  .segmented-wrap { position: relative; display: inline-flex; flex-direction: column; gap: 5px; }
  .seg-label {
    font-family: var(--mono, ui-monospace, monospace);
    font-size: 9px;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--text-dim);
    text-align: center;
  }
  .segmented { display: flex; gap: 4px; }
  .seg {
    flex: 1;
    min-width: 0;
    height: 24px;
    padding: 0 8px;
    border-radius: 5px;
    background: #14171b;
    border: 1px solid var(--border, #2c3037);
    display: grid;
    place-items: center;
    font-family: var(--font, sans-serif);
    font-size: 10px;
    letter-spacing: 0.06em;
    font-weight: 700;
    text-transform: uppercase;
    color: var(--text-dim);
    cursor: pointer;
    white-space: nowrap;
  }
  .seg:hover { border-color: var(--domain, var(--accent)); color: var(--text); }
  .seg:focus-visible { outline: 2px solid var(--domain, var(--accent)); outline-offset: 2px; }
  .seg.on {
    background: var(--domain, var(--accent));
    color: var(--text-on-accent, #05070a);
    border-color: var(--domain, var(--accent));
  }
  .segmented-wrap.midi-learning .segmented {
    outline: 2px solid #f5c248;
    outline-offset: 2px;
    border-radius: 6px;
    animation: seg-midi-learn-pulse 1.1s ease-in-out infinite;
  }
  @keyframes seg-midi-learn-pulse {
    0%, 100% { outline-color: rgba(245, 194, 72, 1); }
    50%      { outline-color: rgba(245, 194, 72, 0.3); }
  }
  .midi-badge {
    position: absolute;
    bottom: -6px;
    right: -4px;
    font-family: ui-monospace, monospace;
    font-size: 0.5rem;
    line-height: 1;
    padding: 1px 3px;
    background: rgba(96, 165, 250, 0.18);
    color: #a8d3ff;
    border-radius: 2px;
    pointer-events: none;
    letter-spacing: 0.02em;
  }
</style>
