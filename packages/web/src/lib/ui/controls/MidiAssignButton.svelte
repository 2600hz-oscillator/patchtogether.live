<script lang="ts">
  // MidiAssignButton — wraps any card BUTTON to make it MIDI-assignable + sendable
  // to a control surface / Electra (WORKSTREAM B). It renders a <slot> (the
  // card's existing button markup) and attaches a right-click handler that opens
  // the shared ControlContextMenu in 'note' mode: "MIDI assign" captures a NOTE,
  // then NOTE-on → press (momentary onGate(true)/onGate(false), or a toggle via
  // onToggle on the press edge), NOTE-off → release (momentary only).
  //
  // The card declares momentary-vs-toggle via the `momentary` prop. Persistence
  // is keyed moduleId:paramId exactly like knob CC — localStorage, not the Y.Doc.
  //
  // Usage (wrap the card's button, keep its existing markup as the slot):
  //   <MidiAssignButton moduleId={id} paramId="play" label="PLAY" momentary={false}
  //                     onToggle={togglePlay}>
  //     <button onclick={togglePlay} ...>▶ PLAY</button>
  //   </MidiAssignButton>
  import { onDestroy, onMount } from 'svelte';
  import type { Snippet } from 'svelte';
  import ControlContextMenu from './ControlContextMenu.svelte';
  import { makeMidiAssignable } from './midi-assignable.svelte';

  interface Props {
    /** Patch-graph node id. */
    moduleId: string;
    /** Synthetic action id for this button (e.g. 'play', 'clear'). Forms the
     *  binding key `moduleId:paramId`. */
    paramId: string;
    /** Menu title label. */
    label: string;
    /** Momentary (held while the note is held) vs toggle (each NOTE-on flips). */
    momentary?: boolean;
    /** Momentary press/release callback. Called true on NOTE-on, false on
     *  NOTE-off. Required for momentary buttons. */
    onGate?: (high: boolean) => void;
    /** Toggle callback. Called once per NOTE-on (the press edge) for a toggle
     *  button. Required for toggle buttons. */
    onToggle?: () => void;
    children: Snippet;
  }

  let { moduleId, paramId, label, momentary = false, onGate, onToggle, children }: Props = $props();

  // A button is a 'note' assignable. For a toggle button we fire onToggle on the
  // press edge only; for a momentary button we forward both edges to onGate.
  const midi = makeMidiAssignable({
    kind: 'note',
    controlType: 'button',
    get moduleId() { return moduleId; },
    get paramId() { return paramId; },
    onGate: (high) => {
      if (momentary) {
        onGate?.(high);
      } else if (high) {
        onToggle?.(); // toggle on the press edge; ignore the release
      }
    },
  });

  let ctxOpen = $state(false);
  let ctxX = $state(0);
  let ctxY = $state(0);

  function openMenu(e: MouseEvent) {
    // Right-click the button → MIDI assign menu. stopPropagation so it doesn't
    // bubble to the node (card) context menu.
    e.preventDefault();
    e.stopPropagation();
    midi.refresh();
    ctxX = e.clientX;
    ctxY = e.clientY;
    ctxOpen = true;
  }

  onMount(() => midi.register());
  onDestroy(() => midi.unregister());
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<span
  class="midi-assign-button"
  class:midi-learning={midi.learning}
  class:midi-bound={!!midi.binding}
  oncontextmenu={openMenu}
  role="presentation"
>
  {@render children()}
  {#if midi.binding}
    <span class="midi-badge" title={`Bound to MIDI ${midi.bindingLabel}`}>{midi.badge}</span>
  {/if}
</span>

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

<style>
  .midi-assign-button {
    position: relative;
    display: inline-flex;
    align-items: center;
  }
  .midi-assign-button.midi-learning {
    outline: 2px solid #f5c248;
    outline-offset: 2px;
    border-radius: 4px;
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
