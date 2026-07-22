<script lang="ts">
  // Button — the RACKLINE `.btn` (+ `.ghost` / `.accent` / `.sm` variants):
  // the momentary / trigger control cards hand-roll as raw `<button>` (strike,
  // reset, load .syx, SAVE). Two behaviours (button-model):
  //   • TRIGGER (default) — fires `onTrigger` ONCE on the press edge.
  //   • MOMENTARY — fires `onGate(true)` while held, `onGate(false)` on release.
  // MIDI-assignable as a NOTE so a learned pad does exactly what a click does
  // (screen + MIDI resolve through the SAME button-model), with a right-click
  // ControlContextMenu.
  import { onDestroy, onMount } from 'svelte';
  import type { Snippet } from 'svelte';
  import ControlContextMenu from './ControlContextMenu.svelte';
  import { makeMidiAssignable } from './midi-assignable.svelte';
  import { buttonPointerFire, buttonGateFire, type ButtonFire } from './button-model';

  interface Props {
    label: string;
    /** Trigger (one-shot) vs momentary (held). Default = trigger. */
    momentary?: boolean;
    /** Fired once on the press edge for a TRIGGER button. */
    onTrigger?: () => void;
    /** Fired true/false on press/release for a MOMENTARY button. */
    onGate?: (high: boolean) => void;
    /** Visual variant. */
    variant?: 'default' | 'ghost' | 'accent' | 'sm';
    /** Optional leading icon (inline SVG snippet). */
    icon?: Snippet;
    title?: string;
    disabled?: boolean;
    /** MIDI-Learn addressing — both set ⇒ right-click binds a NOTE. */
    moduleId?: string;
    paramId?: string;
  }

  let {
    label,
    momentary = false,
    onTrigger,
    onGate,
    variant = 'default',
    icon,
    title,
    disabled = false,
    moduleId,
    paramId,
  }: Props = $props();

  const midiEnabled = $derived(!!(moduleId && paramId));

  /** Dispatch a resolved fire from either the pointer or a MIDI note. */
  function dispatch(fire: ButtonFire) {
    if (fire === 'trigger') onTrigger?.();
    else if (fire === 'press') onGate?.(true);
    else if (fire === 'release') onGate?.(false);
  }

  const midi = makeMidiAssignable({
    kind: 'note',
    controlType: 'button',
    get moduleId() { return moduleId; },
    get paramId() { return paramId; },
    onGate: (high) => dispatch(buttonGateFire(momentary, high)),
  });

  let pressed = $state(false);

  function pointerdown(e: PointerEvent) {
    if (e.button !== 0 || disabled) return;
    pressed = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dispatch(buttonPointerFire(momentary, 'down'));
  }
  function pointerup(e: PointerEvent) {
    if (!pressed) return;
    pressed = false;
    dispatch(buttonPointerFire(momentary, 'up'));
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* already released */ }
  }
  function lostcapture() {
    if (!pressed) return;
    pressed = false;
    dispatch(buttonPointerFire(momentary, 'up'));
  }
  function onKeydown(e: KeyboardEvent) {
    if (disabled) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (pressed) return; // ignore auto-repeat
      pressed = true;
      dispatch(buttonPointerFire(momentary, 'down'));
    }
  }
  function onKeyup(e: KeyboardEvent) {
    if ((e.key === 'Enter' || e.key === ' ') && pressed) {
      pressed = false;
      dispatch(buttonPointerFire(momentary, 'up'));
    }
  }

  onMount(() => { if (midiEnabled) midi.register(); });
  onDestroy(() => midi.unregister());

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

<span class="btn-wrap" class:midi-learning={midi.learning} class:midi-bound={!!midi.binding}>
  <button
    class="btn {variant}"
    class:pressed
    type="button"
    {disabled}
    {title}
    data-testid={paramId ? `control-${paramId}` : undefined}
    aria-pressed={momentary ? pressed : undefined}
    onpointerdown={pointerdown}
    onpointerup={pointerup}
    onlostpointercapture={lostcapture}
    onkeydown={onKeydown}
    onkeyup={onKeyup}
    oncontextmenu={openContextMenu}
  >
    {#if icon}{@render icon()}{/if}
    <span class="btn-label">{label}</span>
  </button>
  {#if midi.binding}
    <span class="midi-badge" title={`Bound to MIDI ${midi.bindingLabel}`}>{midi.badge}</span>
  {/if}
</span>

{#if midiEnabled}
  <ControlContextMenu
    open={ctxOpen}
    x={ctxX}
    y={ctxY}
    title={`${moduleId} · ${label}`}
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
  .btn-wrap { position: relative; display: inline-flex; }
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    font-family: var(--font, sans-serif);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    color: var(--text);
    background: var(--surface-2, #20262f);
    border: 1px solid var(--border-strong, #333b48);
    border-radius: 6px;
    padding: 8px 12px;
    cursor: pointer;
    user-select: none;
    touch-action: none;
  }
  .btn:hover { border-color: var(--domain, var(--accent)); color: var(--text); }
  .btn:focus-visible { outline: 2px solid var(--domain, var(--accent)); outline-offset: 2px; }
  .btn.pressed, .btn:active { transform: translateY(1px); filter: brightness(0.9); }
  .btn:disabled { opacity: 0.45; cursor: default; transform: none; filter: none; }
  .btn :global(svg) { width: 13px; height: 13px; }

  .btn.ghost { background: transparent; }

  .btn.accent {
    background: linear-gradient(
      180deg,
      var(--domain, var(--accent)),
      color-mix(in srgb, var(--domain, var(--accent)) 80%, #05070a)
    );
    color: var(--text-on-accent, #05070a);
    border: none;
    text-transform: uppercase;
    box-shadow: 0 6px 16px -8px color-mix(in srgb, var(--domain, var(--accent)) 42%, transparent);
  }
  .btn.accent:hover { color: var(--text-on-accent, #05070a); filter: brightness(1.05); }

  .btn.sm {
    padding: 0;
    width: 22px;
    height: 22px;
    font-size: 9px;
    border-radius: 4px;
  }
  .btn.sm .btn-label { line-height: 1; }

  .btn-wrap.midi-learning .btn {
    outline: 2px solid #f5c248;
    outline-offset: 2px;
    animation: btn-midi-learn-pulse 1.1s ease-in-out infinite;
  }
  @keyframes btn-midi-learn-pulse {
    0%, 100% { outline-color: rgba(245, 194, 72, 1); }
    50%      { outline-color: rgba(245, 194, 72, 0.3); }
  }
  .midi-badge {
    position: absolute;
    bottom: -4px;
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
