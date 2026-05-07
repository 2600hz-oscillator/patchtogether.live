<!--
  NoteEntry.svelte — text-entry pitch field for one Sequencer step or one
  Cartesian cell (D5).

  Renders an <input type="text"> that:
    - displays the note name (canonical sharp form, e.g. 'a4', 'c#3') for the
      bound MIDI int, or '' when midi is null;
    - revalidates on every keystroke and shows green focus ring when valid,
      red when invalid;
    - commits on blur or Enter via onCommit(input);
    - reverts on Escape;
    - exposes itself as a focusable cell to the parent for keyboard nav.

  Note: keyboard nav (arrows, Tab, Enter-advances) is handled at the parent
  level since it requires knowledge of the grid topology. This component
  surfaces just the input + the commit/revert behavior.
-->
<script lang="ts">
  import { parseNoteName, noteNameForMidi } from '$lib/audio/note-entry';

  interface Props {
    midi: number | null;
    on: boolean;
    onCommit: (input: string) => void;
    onGateToggle: () => void;
    /** Called by the parent's keydown handler to coordinate grid navigation. */
    onNavKey?: (e: KeyboardEvent) => boolean;
    /** Test ID for the pitch input itself (e2e). */
    testId?: string;
    /** Test ID for the gate button below the input. */
    gateTestId?: string;
    /** When step is "active" (current playhead), highlight the gate button. */
    isActive?: boolean;
    /** Dim the cell (out of length range, etc.). */
    dim?: boolean;
  }

  let {
    midi,
    on,
    onCommit,
    onGateToggle,
    onNavKey,
    testId,
    gateTestId,
    isActive = false,
    dim = false,
  }: Props = $props();

  /** Local edit buffer. Synced from `midi` when not focused; on focus, captured
   *  so user keystrokes don't fight the prop reactivity. */
  let inputEl: HTMLInputElement | undefined = $state();
  let editing = $state(false);
  let buffer = $state('');

  /** Display text: when editing, the buffer; otherwise canonical name. */
  let displayValue = $derived(editing ? buffer : (midi !== null ? noteNameForMidi(midi) : ''));

  /** Validity of the *current visible* text. Drives green vs red ring. */
  let isValid = $derived.by(() => {
    const text = editing ? buffer : (midi !== null ? noteNameForMidi(midi) : '');
    if (text === '') return false;
    return parseNoteName(text) !== null;
  });

  function onFocus() {
    editing = true;
    buffer = midi !== null ? noteNameForMidi(midi) : '';
    // Select all so a single keystroke replaces the contents — feels right for
    // step-and-go entry.
    queueMicrotask(() => inputEl?.select());
  }

  function commit() {
    onCommit(buffer);
    editing = false;
  }

  function revert() {
    editing = false;
    buffer = midi !== null ? noteNameForMidi(midi) : '';
  }

  function onBlur() {
    if (editing) commit();
  }

  function onInput(e: Event) {
    buffer = (e.currentTarget as HTMLInputElement).value;
  }

  function onKeydown(e: KeyboardEvent) {
    // Esc: revert + keep focus.
    if (e.key === 'Escape') {
      e.preventDefault();
      revert();
      return;
    }
    // Enter: commit, then let parent move focus to the next pitch box.
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
      onNavKey?.(e);
      return;
    }
    // Arrow keys: ALWAYS preempt the browser's caret-move default — arrow
    // keys are reserved for grid nav inside the patch. If the parent declines
    // to move focus (clamped at an edge), focus stays put rather than the
    // caret jumping inside the input. This is the "very rapid arrow-only
    // editing" UX from the spec.
    if (
      e.key === 'ArrowLeft' ||
      e.key === 'ArrowRight' ||
      e.key === 'ArrowUp' ||
      e.key === 'ArrowDown'
    ) {
      e.preventDefault();
      const handled = onNavKey?.(e) ?? false;
      if (handled && editing) commit();
      return;
    }
  }

  function onGateKeydown(e: KeyboardEvent) {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      onGateToggle();
      return;
    }
    if (
      e.key === 'ArrowLeft' ||
      e.key === 'ArrowRight' ||
      e.key === 'ArrowUp' ||
      e.key === 'ArrowDown' ||
      e.key === 'Tab'
    ) {
      const handled = onNavKey?.(e) ?? false;
      if (handled) e.preventDefault();
    }
  }
</script>

<div class="note-cell" class:dim>
  <button
    class="gate"
    class:on
    class:active={isActive}
    type="button"
    aria-pressed={on}
    data-testid={gateTestId}
    data-role="gate"
    onclick={onGateToggle}
    onkeydown={onGateKeydown}
    title={on ? 'Gate on (Space to toggle)' : 'Gate off (Space to toggle)'}
  ></button>
  <input
    bind:this={inputEl}
    class="note-input"
    class:valid={isValid}
    class:invalid={!isValid}
    type="text"
    spellcheck="false"
    autocomplete="off"
    autocapitalize="off"
    inputmode="text"
    maxlength="12"
    value={displayValue}
    data-testid={testId}
    data-role="pitch"
    onfocus={onFocus}
    onblur={onBlur}
    oninput={onInput}
    onkeydown={onKeydown}
  />
</div>

<style>
  .note-cell {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    min-width: 0;
  }
  .note-cell.dim {
    opacity: 0.35;
  }
  .note-input {
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
    background: #14171c;
    border: 1px solid #2a2f3a;
    border-radius: 2px;
    color: var(--text);
    font-family: ui-monospace, monospace;
    font-size: 0.7rem;
    padding: 2px 3px;
    text-align: center;
    outline: none;
    /* Reserve a 2px ring on focus so layout doesn't shift. */
    box-shadow: 0 0 0 0 transparent;
    transition: box-shadow 0.05s ease-out, border-color 0.05s ease-out;
  }
  .note-input:focus-visible.valid {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent);
  }
  .note-input:focus-visible.invalid {
    border-color: var(--cable-gate);
    box-shadow: 0 0 0 2px var(--cable-gate);
  }
  .gate {
    width: 100%;
    height: 14px;
    background: #14171c;
    border: 1px solid #2a2f3a;
    border-radius: 2px;
    cursor: pointer;
    padding: 0;
    box-shadow: 0 0 0 0 transparent;
    transition: box-shadow 0.05s ease-out, background 0.05s ease-out, border-color 0.05s ease-out;
  }
  .gate.on {
    background: var(--cable-gate);
    border-color: var(--cable-gate);
  }
  .gate.active {
    outline: 1px solid var(--accent);
    outline-offset: -1px;
  }
  .gate:focus-visible {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent);
  }
</style>
