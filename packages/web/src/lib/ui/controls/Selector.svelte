<script lang="ts">
  // Selector — the RACKLINE `.selector` / `.preset-pick` dropdown. Replaces the
  // raw `<select>` cards hand-roll (filter modes, clock sources) AND the
  // non-param named list (DX7's preset roster). Same card-kit plumbing as
  // Knob/Fader: `{ value, onchange, moduleId, paramId, readLive }`. When the
  // option values are all NUMERIC and a paramId is set, the chip is
  // MIDI-assignable (a learned CC sweeps the roster) + right-click opens the
  // ControlContextMenu; a NON-numeric preset roster is selection-only.
  import type { KnobCurve } from '$lib/graph/types';
  import { onDestroy, onMount, untrack } from 'svelte';
  import ControlContextMenu from './ControlContextMenu.svelte';
  import { makeMidiAssignable } from './midi-assignable.svelte';
  import {
    currentOption,
    selectorLabel,
    cycleOptionValue,
    numericOptionRange,
    type SelectorOption,
  } from './selector-model';

  type Val = number | string;

  interface Props {
    /** Current selected value (a param number, or a preset key). */
    value: Val;
    /** The option roster shown in the dropdown. */
    options: readonly SelectorOption<Val>[];
    /** Commit a new selection. For a numeric param pass `set('filterMode')`. */
    onchange: (value: Val) => void;
    /** Small uppercase tag shown left of the value (e.g. "preset", "mode"). */
    label?: string;
    /** Optional live reader (motorized discrete param — a CV-driven select). */
    readLive?: () => number | undefined;
    /** MIDI-Learn addressing (numeric rosters only). */
    moduleId?: string;
    paramId?: string;
    /** Hero-sized preset chip (DX7). */
    hero?: boolean;
    disabled?: boolean;
  }

  let {
    value,
    options,
    onchange,
    label,
    readLive,
    moduleId,
    paramId,
    hero = false,
    disabled = false,
  }: Props = $props();

  // MIDI applies only to a numeric roster addressed by a param.
  let midiRange = $derived(numericOptionRange(options));
  let midiEnabled = $derived(!!(moduleId && paramId && midiRange));

  // Snap an inbound scaled CC value to the nearest numeric option value.
  function nearestOptionValue(v: number): Val {
    let best: Val = options[0]?.value ?? v;
    let bestD = Infinity;
    for (const o of options) {
      if (typeof o.value !== 'number') continue;
      const d = Math.abs(o.value - v);
      if (d < bestD) { bestD = d; best = o.value; }
    }
    return best;
  }

  const midi = makeMidiAssignable({
    kind: 'cc',
    get moduleId() { return moduleId; },
    get paramId() { return paramId; },
    get min() { return midiRange?.min ?? 0; },
    get max() { return midiRange?.max ?? 1; },
    get onchange() { return (v: number) => onchange(nearestOptionValue(v)); },
    onTransient: (v) => { liveValue = nearestOptionValue(v); },
  });

  // Motorized live value (readLive for a CV-driven discrete param), else prop.
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

  let shownLabel = $derived(selectorLabel(liveValue, options));
  let shownTitle = $derived(currentOption(liveValue, options)?.title);

  onMount(() => { if (midiEnabled) midi.register(); });
  onDestroy(() => { if (raf !== null) cancelAnimationFrame(raf); midi.unregister(); });

  // ── dropdown open/close ──
  let open = $state(false);
  function toggleOpen() { if (!disabled) open = !open; }
  function choose(v: Val) { open = false; if (v !== value) onchange(v); }
  function onKeydown(e: KeyboardEvent) {
    if (disabled) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleOpen(); }
    else if (e.key === 'Escape') { open = false; }
    else if (e.key === 'ArrowDown') { e.preventDefault(); onchange(cycleOptionValue(value, options, +1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); onchange(cycleOptionValue(value, options, -1)); }
  }
  function onWheel(e: WheelEvent) {
    if (disabled || open) return;
    e.preventDefault();
    onchange(cycleOptionValue(value, options, e.deltaY < 0 ? +1 : -1));
  }

  // ── MIDI context menu ──
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

<div class="selector-wrap" class:midi-learning={midi.learning} class:midi-bound={!!midi.binding}>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div
    class="selector"
    class:hero
    class:disabled
    role="button"
    tabindex={disabled ? -1 : 0}
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-label={label ? `${label}: ${shownLabel}` : shownLabel}
    data-testid={paramId ? `control-${paramId}` : undefined}
    title={shownTitle}
    onclick={toggleOpen}
    onkeydown={onKeydown}
    onwheel={onWheel}
    oncontextmenu={openContextMenu}
  >
    {#if label}<span class="lab">{label}</span>{/if}
    <span class="val">{shownLabel}</span>
    <span class="chev" class:up={open}>▾</span>
  </div>

  {#if open}
    <!-- transparent backdrop closes the menu on any outside click -->
    <button class="backdrop" type="button" aria-label="close" onclick={() => (open = false)}></button>
    <ul class="menu" role="listbox">
      {#each options as opt (opt.value)}
        <li>
          <button
            class="item"
            type="button"
            class:on={opt.value === value}
            role="option"
            aria-selected={opt.value === value}
            title={opt.title}
            onclick={() => choose(opt.value)}
          >{opt.label}</button>
        </li>
      {/each}
    </ul>
  {/if}

  {#if midi.binding}
    <span class="midi-badge" title={`Bound to MIDI ${midi.bindingLabel}`}>{midi.badge}</span>
  {/if}
</div>

{#if midiEnabled}
  <ControlContextMenu
    open={ctxOpen}
    x={ctxX}
    y={ctxY}
    title={`${moduleId} · ${label ?? shownLabel}`}
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
  .selector-wrap { position: relative; display: inline-flex; }
  .selector {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    justify-content: space-between;
    background: var(--module-bg-deep, #0a0c0f);
    border: 1px solid var(--border-strong, #333b48);
    border-radius: 6px;
    padding: 6px 10px;
    font-family: var(--mono, ui-monospace, monospace);
    font-size: 12px;
    color: var(--text);
    cursor: pointer;
    min-width: 120px;
    outline: none;
  }
  .selector.hero { padding: 8px 12px; min-width: 168px; font-size: 13px; }
  .selector:hover { border-color: var(--domain, var(--accent)); }
  .selector:focus-visible { outline: 2px solid var(--domain, var(--accent)); outline-offset: 2px; }
  .selector.disabled { opacity: 0.5; cursor: default; }
  .lab {
    font-size: 9px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--text-dim);
  }
  .val { color: var(--domain, var(--accent)); }
  .chev { color: var(--text-dim); margin-left: auto; transition: transform 0.12s ease; }
  .chev.up { transform: rotate(180deg); }

  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 40;
    background: transparent;
    border: none;
    cursor: default;
  }
  .menu {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    z-index: 41;
    min-width: 100%;
    max-height: 240px;
    overflow-y: auto;
    margin: 0;
    padding: 4px;
    list-style: none;
    background: var(--surface-3, #262a31);
    border: 1px solid var(--border-strong, #333b48);
    border-radius: 6px;
    box-shadow: 0 12px 28px -12px rgba(0, 0, 0, 0.7);
  }
  .menu li { display: block; }
  .item {
    display: block;
    width: 100%;
    text-align: left;
    padding: 6px 9px;
    border: 1px solid transparent;
    border-radius: 5px;
    background: transparent;
    color: var(--text-dim);
    font-family: var(--mono, ui-monospace, monospace);
    font-size: 12px;
    letter-spacing: 0.02em;
    cursor: pointer;
    white-space: nowrap;
  }
  .item:hover { color: var(--text); background: rgba(255, 255, 255, 0.04); }
  .item.on {
    color: var(--domain, var(--accent));
    border-color: color-mix(in srgb, var(--domain, var(--accent)) 34%, transparent);
    background: color-mix(in srgb, var(--domain, var(--accent)) 10%, transparent);
  }

  .selector-wrap.midi-learning .selector {
    outline: 2px solid #f5c248;
    outline-offset: 2px;
    animation: selector-midi-learn-pulse 1.1s ease-in-out infinite;
  }
  @keyframes selector-midi-learn-pulse {
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
