<script lang="ts">
  // ParamGrid — the RACKLINE CHIP + PORTALED GRID POPOVER for a discrete param
  // whose states are PICTURES rather than words (PF-15).
  //
  // The third answer to "how does a discrete param show its states". Segmented
  // lays <=6 named states out inline; Selector shows a 7+ roster as a portaled
  // one-column list; neither can present a 32-entry roster whose entries are
  // little DIAGRAMS. The DX7 algorithm chart is the case that forced it: 32
  // wiring topologies, and the only readable presentation is the chart itself,
  // laid out as a grid of mini-diagrams.
  //
  // TWO PARTS, and the split is load-bearing:
  //   * the CHIP always renders in the cell. It is the param's ONE
  //     `control-<paramId>` element (so faces-parity's exact param multiset
  //     holds) and the MIDI-assignable root, exactly like Selector's chip.
  //   * the GRID is PORTALED to <body> + viewport-clamped (the shared
  //     `portal`/`clampMenu` recipe Selector uses). Portaling is what lets this
  //     primitive work at EVERY tier: a 4x8 diagram grid never has to fit a
  //     46 px lane knob column, because it does not live in that column. It
  //     also escapes `.rl-tile { overflow: hidden }` and SvelteFlow's
  //     transformed pane, which would clip an absolutely-positioned popover to
  //     nothing.
  //
  // ⚠ The testid lives on the CHIP, NOT on the portaled radiogroup. A portaled
  // node is no longer a descendant of the dock shell, so a `control-<paramId>`
  // there would VANISH from faces-parity's `dockShell` multiset and the param
  // would read as a LOST control. The grid is addressed by `data-grid-param`
  // instead (page-scoped, like the Selector menu's `[role="listbox"]`).
  //
  // Same card-kit plumbing as every other primitive:
  // `{ value, onchange, moduleId, paramId, readLive }`.
  import type { Snippet } from 'svelte';
  import { onDestroy, onMount, untrack } from 'svelte';
  import ControlContextMenu from './ControlContextMenu.svelte';
  import { makeMidiAssignable } from './midi-assignable.svelte';
  import { clampMenu, portal } from '$lib/ui/menu-viewport-action';
  import type { SelectorOption } from './selector-model';
  import {
    gridChipLabel,
    gridColumns,
    gridNavIndex,
    nearestGridIndex,
    paramGridCells,
  } from './param-grid-model';

  interface Props {
    /** Current param value. */
    value: number;
    /** Commit a new selection (`params.set(paramId)`). */
    onchange: (value: number) => void;
    /** The param's discrete range — the roster when no `options` is declared. */
    min: number;
    max: number;
    /** A DECLARED roster (PF-1); wins over the derived range. */
    options?: readonly SelectorOption<number>[];
    /** Small uppercase tag left of the value (the param's label). */
    label?: string;
    /** Declared value formatter (PF-3) — the chip + derived cell captions. */
    format?: (v: number) => string;
    /** Live reader (motorized / CV-driven discrete param). */
    readLive?: () => number | undefined;
    /** MIDI-Learn addressing. */
    moduleId?: string;
    paramId?: string;
    /** Grid width in cells. Defaults to `gridColumns(count)` (<=8). */
    cols?: number;
    /** Hero-sized chip (the dock faceplate). */
    hero?: boolean;
    /** LANE-TILE chip: shrinks into the 46 px `--kcol-max` knob column, drops
     *  the tag row and ellipsizes the value. The grid is portaled, so the full
     *  chart stays readable from a lane tile. */
    compact?: boolean;
    disabled?: boolean;
    /** Per-cell renderer — the seam a module uses to paint real pictures
     *  (PR 4's mini algorithm diagrams). Omitted → the cell's text label. */
    cell?: Snippet<[{ value: number; label: string; selected: boolean }]>;
  }

  let {
    value,
    onchange,
    min,
    max,
    options,
    label,
    format,
    readLive,
    moduleId,
    paramId,
    cols,
    hero = false,
    compact = false,
    disabled = false,
    cell,
  }: Props = $props();

  let cells = $derived(paramGridCells({ min, max, options }, format));
  let columns = $derived(cols ?? gridColumns(cells.length));

  // MIDI: a learned CC sweeps the chart, snapped to the nearest cell (the
  // Selector/Segmented precedent — an inbound scaled CC lands off-detent).
  let midiEnabled = $derived(!!(moduleId && paramId && cells.length > 1));
  function snap(v: number): number {
    const i = nearestGridIndex(v, cells);
    return i >= 0 ? cells[i]!.value : v;
  }

  const midi = makeMidiAssignable({
    kind: 'cc',
    get moduleId() { return moduleId; },
    get paramId() { return paramId; },
    get min() { return min; },
    get max() { return max; },
    get onchange() { return (v: number) => onchange(snap(v)); },
    onTransient: (v) => { liveValue = snap(v); },
  });

  // Motorized live value (the same transient-first seam the knobs read).
  let liveValue = $state<number>(untrack(() => value));
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

  let activeIdx = $derived(nearestGridIndex(liveValue, cells));
  let shownLabel = $derived(gridChipLabel(liveValue, cells, format));
  let shownTitle = $derived(cells[activeIdx]?.title);

  onMount(() => { if (midiEnabled) midi.register(); });
  onDestroy(() => { if (raf !== null) cancelAnimationFrame(raf); midi.unregister(); });

  // ── popover open/close (the Selector portal recipe) ──
  let open = $state(false);
  let chipEl = $state<HTMLElement | null>(null);
  let gridEl = $state<HTMLElement | null>(null);
  let menuX = $state(0);
  let menuY = $state(0);
  // The ROVING focus index. Focus stays on the radiogroup container and moves
  // via `aria-activedescendant` rather than DOM-focusing 32 buttons in turn:
  // moving real focus inside a scrollable popover drags the scroll position
  // around on every arrow press.
  let focusIdx = $state(-1);

  function anchorMenu(): void {
    const r = chipEl?.getBoundingClientRect();
    menuX = r ? r.left : 0;
    menuY = r ? r.bottom + 4 : 0;
  }
  function openGrid(): void {
    if (disabled) return;
    anchorMenu();
    focusIdx = activeIdx;
    open = true;
  }
  function closeGrid(): void {
    open = false;
    chipEl?.focus();
  }
  function toggleOpen(): void {
    if (open) { open = false; return; }
    openGrid();
  }
  function choose(v: number): void {
    open = false;
    if (v !== value) onchange(v);
    chipEl?.focus();
  }

  function onChipKeydown(e: KeyboardEvent): void {
    if (disabled) return;
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
      e.preventDefault();
      openGrid();
    } else if (e.key === 'Escape') {
      open = false;
    }
  }

  function onGridKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') { e.preventDefault(); closeGrid(); return; }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const c = cells[focusIdx];
      if (c) choose(c.value);
      return;
    }
    const next = gridNavIndex(focusIdx, e.key, cells.length, columns);
    if (next !== focusIdx) {
      e.preventDefault();
      focusIdx = next;
    } else if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
    }
  }

  // Focus the grid container when it opens, so arrows drive it immediately.
  $effect(() => {
    if (open && gridEl) gridEl.focus();
  });

  let cellId = $derived((i: number) => `${paramId ?? 'param'}-grid-cell-${i}`);

  // ── MIDI context menu ──
  let ctxOpen = $state(false);
  let ctxX = $state(0);
  let ctxY = $state(0);
  function openContextMenu(e: MouseEvent): void {
    if (!midiEnabled) return;
    midi.refresh();
    e.preventDefault();
    e.stopPropagation();
    ctxX = e.clientX; ctxY = e.clientY; ctxOpen = true;
  }
</script>

<div class="grid-wrap" class:midi-learning={midi.learning} class:midi-bound={!!midi.binding}>
  <div
    bind:this={chipEl}
    class="grid-chip nodrag"
    class:hero
    class:compact
    class:disabled
    role="button"
    tabindex={disabled ? -1 : 0}
    aria-haspopup="dialog"
    aria-expanded={open}
    aria-label={label ? `${label}: ${shownLabel}` : shownLabel}
    data-testid={paramId ? `control-${paramId}` : undefined}
    title={shownTitle ?? (label ? `${label}: ${shownLabel}` : shownLabel)}
    onclick={toggleOpen}
    onkeydown={onChipKeydown}
    oncontextmenu={openContextMenu}
  >
    {#if label && !compact}<span class="lab">{label}</span>{/if}
    <span class="val">{shownLabel}</span>
    <span class="chev" class:up={open}>▾</span>
  </div>

  {#if open}
    <div use:portal>
      <!-- transparent backdrop closes the popover on any outside click -->
      <button class="backdrop" type="button" aria-label="close" onclick={() => (open = false)}></button>
      <div
        bind:this={gridEl}
        class="grid-menu"
        use:clampMenu={{ x: menuX, y: menuY, flip: false }}
        role="radiogroup"
        tabindex="-1"
        aria-label={label ?? paramId ?? 'options'}
        aria-activedescendant={focusIdx >= 0 ? cellId(focusIdx) : undefined}
        data-grid-param={paramId}
        style={`--grid-cols:${columns}`}
        onkeydown={onGridKeydown}
      >
        {#each cells as c, i (c.value)}
          <button
            class="grid-cell"
            type="button"
            id={cellId(i)}
            class:on={i === activeIdx}
            class:focused={i === focusIdx}
            role="radio"
            aria-checked={i === activeIdx}
            tabindex="-1"
            title={c.title ?? c.label}
            data-testid={paramId ? `grid-${paramId}-${c.value}` : undefined}
            onclick={() => choose(c.value)}
          >
            {#if cell}
              {@render cell({ value: c.value, label: c.label, selected: i === activeIdx })}
            {:else}
              <span class="cell-lab">{c.label}</span>
            {/if}
          </button>
        {/each}
      </div>
    </div>
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
  /* The chip mirrors `.selector` exactly — same box, same tiers — so a grid
     param and a roster param read as siblings on the same faceplate. */
  .grid-wrap { position: relative; display: inline-flex; }
  .grid-chip {
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
  .grid-chip.hero { padding: 8px 12px; min-width: 168px; font-size: 13px; }
  .grid-chip.compact {
    min-width: 0;
    width: 100%;
    gap: 2px;
    padding: 4px 4px;
    font-size: 9px;
    border-radius: 4px;
  }
  .grid-chip.compact .val { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .grid-chip.compact .chev { margin-left: 0; font-size: 8px; }
  .grid-chip:hover { border-color: var(--domain, var(--accent)); }
  .grid-chip:focus-visible { outline: 2px solid var(--domain, var(--accent)); outline-offset: 2px; }
  .grid-chip.disabled { opacity: 0.5; cursor: default; }
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
    z-index: 2001;
    background: transparent;
    border: none;
    cursor: default;
  }
  .grid-menu {
    /* PORTALED to <body> + `use:clampMenu`: fixed so it escapes
       `.rl-tile { overflow: hidden }` and SvelteFlow's transformed pane.
       Above the context-menu chrome's 2000/2001 band, like Selector's list. */
    position: fixed;
    top: 0;
    left: 0;
    z-index: 2002;
    display: grid;
    grid-template-columns: repeat(var(--grid-cols, 8), minmax(0, 1fr));
    gap: 4px;
    max-height: 70vh;
    overflow: auto;
    padding: 6px;
    background: var(--surface-3, #262a31);
    border: 1px solid var(--border-strong, #333b48);
    border-radius: 6px;
    box-shadow: 0 12px 28px -12px rgba(0, 0, 0, 0.7);
    outline: none;
  }
  .grid-cell {
    display: grid;
    place-items: center;
    min-width: 34px;
    min-height: 34px;
    padding: 3px;
    border: 1px solid var(--border, #2c3037);
    border-radius: 5px;
    background: #14171b;
    color: var(--text-dim);
    font-family: var(--mono, ui-monospace, monospace);
    font-size: 11px;
    cursor: pointer;
  }
  .grid-cell:hover { color: var(--text); border-color: var(--domain, var(--accent)); }
  .grid-cell.focused { outline: 2px solid var(--domain, var(--accent)); outline-offset: -2px; }
  .grid-cell.on {
    color: var(--domain, var(--accent));
    border-color: color-mix(in srgb, var(--domain, var(--accent)) 60%, transparent);
    background: color-mix(in srgb, var(--domain, var(--accent)) 14%, transparent);
  }
  .cell-lab { white-space: nowrap; }

  .grid-wrap.midi-learning .grid-chip {
    outline: 2px solid #f5c248;
    outline-offset: 2px;
    animation: grid-midi-learn-pulse 1.1s ease-in-out infinite;
  }
  @keyframes grid-midi-learn-pulse {
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
