<script lang="ts">
  // Segmented — the RACKLINE `.segmented` / `.seg` / `.seg.on` discrete N-way
  // (filter type, wave shape, mode banks). A selector rendered inline: every
  // option is a button, one is `.on`. Same card-kit plumbing as Knob/Fader; a
  // numeric roster addressed by a paramId is MIDI-assignable (a learned CC
  // steps across the row) with a right-click ControlContextMenu.
  import { onDestroy, onMount, untrack } from 'svelte';
  import ControlContextMenu from './ControlContextMenu.svelte';
  import { makeMidiAssignable } from './midi-assignable.svelte';
  import { activeSegmentIndex, nearestSegmentValue, type Segment } from './segmented-model';
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
    /**
     * Light the NEAREST segment when the value sits off-detent, instead of
     * lighting none (the `activeSegmentIndex` default).
     *
     * OFF for a free-standing roster, where "no exact match" is real
     * information. ON for a PARAM-backed roster (PF-1), where it is not: a
     * param always HAS a value, so a dock faceplate showing no selected mode
     * at all is strictly worse than showing the one it is nearest. Saved racks
     * predate their param's `options`, and a CV-motorized read lands between
     * steps by construction — cloudseed `late_mode` is the known case.
     */
    snapActive?: boolean;
  }

  let {
    value,
    segments,
    onchange,
    label,
    readLive,
    moduleId,
    paramId,
    snapActive = false,
  }: Props = $props();

  let midiRange = $derived(numericOptionRange(segments));
  let midiEnabled = $derived(!!(moduleId && paramId && midiRange));

  /** Snap to the nearest segment — the SHARED resolver (segmented-model), so
   *  the dock's segment row and the lane's dial readout can never disagree
   *  about which state an off-detent value is in. */
  const snap = (v: number): Val => nearestSegmentValue(v, segments);

  const midi = makeMidiAssignable({
    kind: 'cc',
    get moduleId() { return moduleId; },
    get paramId() { return paramId; },
    get min() { return midiRange?.min ?? 0; },
    get max() { return midiRange?.max ?? 1; },
    get onchange() { return (v: number) => onchange(snap(v)); },
    onTransient: (v) => { liveValue = snap(v); },
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

  let activeIdx = $derived(
    activeSegmentIndex(
      snapActive && typeof liveValue === 'number' ? snap(liveValue) : liveValue,
      segments,
    ),
  );

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
      ><span class="seg-text">{seg.label}</span></button>
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
    /* ⚠ `1 1 auto`, NOT the `flex: 1` shorthand — which is `1 1 0%` and makes
       every button EXACTLY the same width regardless of what it says. A row
       then sizes its cells to the AVERAGE caption and clips every caption
       above it, by a fraction of a pixel, which paints as a full ellipsis.
       MEASURED on resofilter's dock row (macOS system stack, 182.469 px row):
       `1 1 0%` gives five 15.297 px content boxes against captions of
       LP 14.125 · HP 16.016 · BP 15.109 · NT 15.719 · AP 15.5 px, so HP, NT and
       AP overflowed by 0.719 / 0.422 / 0.203 px and rendered `H…` `N…` `A…` —
       three of five states unreadable. With `auto` the flex BASE is the
       caption's own max-content (trailing letter-space included, which is what
       the 0.2 px overflows were), free space is still shared equally by the
       `1` grow factor, and all five measure exactly 0 px of overflow. Sibling
       rows move the same way — the registry-driven sweep in
       `faceplate-platform.spec.ts` reproduces ELEVEN clipped captions across
       five faces the moment this line goes back to `flex: 1`: filter HP by
       0.922 px, tidyVco -1/+1 by 0.656/2.516, cofefve's four by 3.3-16.2, and
       cloudseed's `divine inspiration` by 30.109.
       This does NOT retire the ellipsis below: a roster whose captions cannot
       all fit still shrinks (weighted by base, so the longest gives up most)
       and still ellipsizes — it just no longer clips a row that HAD room. */
    flex: 1 1 auto;
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
    /* The track must be allowed to shrink below its content, or the caption
       below can never ellipsize (a grid item's implicit `min-width: auto`
       floors it at min-content). */
    grid-template-columns: minmax(0, 1fr);
  }
  /* A long state name ELLIPSIZES rather than running out of its button. Two-
     to-four-letter modes (filter LP/HP/BP) never reach this and render
     byte-identically; a preset roster ('divine inspiration') does, and a hard
     clip mid-glyph reads as a rendering bug where an ellipsis reads as "there
     is more name here". */
  .seg-text {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
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
