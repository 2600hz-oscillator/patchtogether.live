<script lang="ts">
  // Toggle — the RACKLINE `.switch` / `.toggle-ctl` 0/1 control (kickdrum HARD,
  // the checkbox cards). A card picks Toggle over Knob when the param
  // `looksLikeToggle` (discrete, 0..1 — see toggle-model / exposable-controls).
  // Same card-kit plumbing as the other primitives: `{ value, onchange,
  // moduleId, paramId, readLive }`. MIDI-assignable as a NOTE (a learned pad
  // flips the switch on the press edge) with a right-click ControlContextMenu.
  import { onDestroy, onMount, untrack } from 'svelte';
  import ControlContextMenu from './ControlContextMenu.svelte';
  import { makeMidiAssignable } from './midi-assignable.svelte';
  import { isToggleOn, toggledValue } from './toggle-model';

  interface Props {
    /** 0 = off, 1 = on (anything ≥ 0.5 reads on). */
    value: number;
    onchange: (value: number) => void;
    /** Uppercase switch label (the `.sw-lab`). */
    label?: string;
    /** Optional sub-hint under the label (the `.sw-hint`, e.g. "clean-warm"). */
    hint?: string;
    readLive?: () => number | undefined;
    moduleId?: string;
    paramId?: string;
    /** Explicit test id — for a NON-param switch (a shell family cell backed by
     *  node.data) that has no paramId to derive `control-<id>` from. */
    testid?: string;
    /**
     * DROP THE PAINTED `.sw-lab` — the caption under the switch.
     *
     * ⚠ NOT `label={undefined}`, and that distinction is the whole reason this
     * prop exists. Dropping the prop would take `aria-label` and the annotate
     * menu's title with it, leaving an unnamed switch: a real accessibility and
     * MIDI-addressing regression dressed up as a layout tidy. This hides TEXT.
     *
     * Declared per cell (`face.bareCells`) — see KnobConic's copy for the
     * owner's redundancy rule.
     */
    hideCaption?: boolean;
  }

  let {
    value,
    onchange,
    label,
    hint,
    readLive,
    moduleId,
    paramId,
    testid,
    hideCaption = false,
  }: Props = $props();

  const midiEnabled = $derived(!!(moduleId && paramId));

  // A toggle is a NOTE-assignable button in TOGGLE mode: flip on the press edge.
  const midi = makeMidiAssignable({
    kind: 'note',
    controlType: 'button',
    get moduleId() { return moduleId; },
    get paramId() { return paramId; },
    onGate: (high) => { if (high) onchange(toggledValue(value)); },
  });

  // Motorized live value (a CV-driven toggle), else the prop.
  let liveValue = $state(untrack(() => value));
  let raf: number | null = null;
  let currentValue = $derived(value);
  $effect(() => {
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
  $effect(() => { if (!readLive) liveValue = currentValue; });

  let on = $derived(isToggleOn(liveValue));

  function flip() { onchange(toggledValue(value)); }
  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); }
  }

  onMount(() => { if (midiEnabled) midi.register(); });
  onDestroy(() => { if (raf !== null) cancelAnimationFrame(raf); midi.unregister(); });

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

<div class="toggle-ctl" class:midi-learning={midi.learning} class:midi-bound={!!midi.binding} title={hint}>
  <div
    class="switch nodrag"
    class:on
    role="switch"
    tabindex="0"
    aria-checked={on}
    aria-label={label}
    data-testid={testid ?? (paramId ? `control-${paramId}` : undefined)}
    onclick={flip}
    onkeydown={onKeydown}
    oncontextmenu={openContextMenu}
  >
    <span class="thumb"></span>
  </div>
  {#if label && !hideCaption}<div class="sw-lab">{label}</div>{/if}
  {#if hint}<div class="sw-hint">{hint}</div>{/if}
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
  />
{/if}

<style>
  /* THE ACCENT CHAIN, VERBATIM from KnobConic:347 / NeonFader:484 — no colour
     is chosen here, and the DOMAIN behaviour is byte-identical because `--ka`
     is unset everywhere it was unset before.
     ⚠ THIS CONTROL WAS OUTSIDE THE CHAIN UNTIL #1825, reading
     `var(--domain, var(--accent))` directly. That is #1812's shape: a per-cell
     `--ka` (the documented override the knob and the fader both honour) simply
     did not reach it, so on mixmstrs' `enable` row the compressor switch stayed
     domain-teal while the eight controls above and below it took their lane
     colour — a whole ROW of the console silently opted out. */
  .toggle-ctl {
    --_ka: var(--ka, var(--domain, var(--accent)));
    position: relative;
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
  }
  .switch {
    width: 52px;
    height: 26px;
    border-radius: 999px;
    background: var(--module-bg-deep, #0a0c0f);
    border: 1px solid var(--border-strong, #333b48);
    position: relative;
    padding: 3px;
    cursor: pointer;
    outline: none;
  }
  .switch:focus-visible { outline: 2px solid var(--_ka); outline-offset: 2px; }
  .thumb {
    display: block;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: linear-gradient(180deg, #454e5c, #262c36);
    transition: margin-left 0.14s ease, background 0.14s ease;
  }
  .switch.on {
    background: color-mix(in srgb, var(--_ka) 20%, transparent);
    border-color: var(--_ka);
  }
  .switch.on .thumb {
    margin-left: 26px;
    background: linear-gradient(
      180deg,
      var(--_ka),
      color-mix(in srgb, var(--_ka) 80%, #05070a)
    );
  }
  .sw-lab {
    font-family: var(--mono, ui-monospace, monospace);
    font-size: 9px;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--text-dim);
  }
  .sw-hint {
    font-family: var(--mono, ui-monospace, monospace);
    font-size: 8.5px;
    letter-spacing: 0.04em;
    color: var(--text-dim);
    opacity: 0.7;
  }
  .toggle-ctl.midi-learning .switch {
    outline: 2px solid #f5c248;
    outline-offset: 2px;
    animation: toggle-midi-learn-pulse 1.1s ease-in-out infinite;
  }
  @keyframes toggle-midi-learn-pulse {
    0%, 100% { outline-color: rgba(245, 194, 72, 1); }
    50%      { outline-color: rgba(245, 194, 72, 0.3); }
  }
  .midi-badge {
    position: absolute;
    top: -4px;
    right: -8px;
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
