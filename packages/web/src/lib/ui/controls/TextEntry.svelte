<!--
  TextEntry.svelte — the faceplate's ONE typed-entry primitive.

  A single writable text field with commit-on-Enter / commit-or-revert-on-blur /
  revert-on-Escape, and a valid/invalid focus ring driven by the caller's own
  validator. The caption is painted by the CELL (ModuleShell), exactly as it is
  for `selector` and `panel`, so this component owns the field and nothing else.

  ── WHY THIS IS NOT `NoteEntry.svelte` ────────────────────────────────────────

  `NoteEntry` is a note-specific COMPOSITE: a pitch input PLUS a gate <button>
  PLUS grid-navigation callbacks, built for a sequencer's step cell. Mounting it
  generically would drag a gate button into every text field on every faceplate.
  It stays exactly as it is (CartesianCard renders it), and this is the generic
  half. The two share their VALIDATOR through the module's own action file, never
  through a copied regex — the same one-source rule the warped fader's map obeys.

  ── WHY THE VALUE IS A PROPERTY AND NEVER A TEXT NODE ────────────────────────

  The resting-faceplate ruling forbids painted derived text. This field is the
  one exception the owner granted (`TextRole` 'authored-entry'), and the reason
  it is safe is STRUCTURAL rather than a promise: the string reaches the DOM only
  as `value={...}` on a writable form control. A readout needs a text node; this
  component has none for its value, so a display cannot adopt the role by
  copying this render. For the same reason there is no `readonly` and no
  `disabled` prop — an inert input painting a computed string is precisely the
  "there but hidden" shape that was refused by name.
-->
<script lang="ts" generics="T">
  import {
    entryCommitDecision,
    entryDisplayText,
    entryTextIsValid,
    type EntryParse,
  } from './text-entry-model';

  interface Props {
    /** The stored content, round-tripped to text by the caller. */
    stored: string;
    /** The caller's validator — the ONE place validity is decided. */
    parse: (text: string) => EntryParse<T>;
    /** Called ONLY with an accepted value. Never with raw text. */
    onCommit: (value: T) => void;
    /** Accessible name. Required: the visible caption lives on the cell, so
     *  without this the field would have no name at all. */
    ariaLabel: string;
    placeholder?: string;
    maxLength?: number;
    testid?: string;
    title?: string;
    /**
     * OPTIONAL grid navigation, for a host that lays these out as a GRID.
     * Returns true if the host moved focus.
     *
     * ⚠ OPT-IN, and the default matters more than the feature. A lone band cell
     * must leave the arrows alone — they are caret movement inside a text field,
     * and claiming them there would break ordinary editing to solve a problem
     * that surface does not have. A GRID host is the case where "left" means the
     * pad to the left, and only the host knows its own topology. Same prop, same
     * contract and same reason as `NoteEntry.onNavKey`.
     */
    onNavKey?: (e: KeyboardEvent) => boolean;
  }

  let {
    stored,
    parse,
    onCommit,
    ariaLabel,
    placeholder,
    maxLength,
    testid,
    title,
    onNavKey,
  }: Props = $props();

  let inputEl: HTMLInputElement | undefined = $state();
  let editing = $state(false);
  let buffer = $state('');

  let displayValue = $derived(entryDisplayText(stored, { editing, buffer }));
  let isValid = $derived(entryTextIsValid(displayValue, parse));

  function onFocus() {
    editing = true;
    buffer = stored;
    // Select all so one keystroke replaces the contents — the step-and-go feel
    // NoteEntry established for grid entry, kept for every field.
    queueMicrotask(() => inputEl?.select());
  }

  function revert() {
    editing = false;
    buffer = stored;
  }

  /** Commit if the buffer parses; otherwise DISCARD it and restore the stored
   *  value. Never writes a guess — see `entryCommitDecision`. */
  function commit() {
    const d = entryCommitDecision(buffer, parse);
    if (d.kind === 'write') onCommit(d.value);
    editing = false;
    buffer = stored;
  }

  function onInput(e: Event) {
    buffer = (e.currentTarget as HTMLInputElement).value;
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      revert();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
      onNavKey?.(e);
      return;
    }
    // ⚠ WITHOUT A GRID HOST, ARROWS AND TAB ARE DELIBERATELY NOT HANDLED. Bare
    // Tab is the rack-flip gesture (#1629) and the arrows reach xyflow's
    // node-move, but both owners bail on `isTypingTarget` / `isInputDOMNode`,
    // which wave an <input> through — that is why #1790 bit NoteEntry's gate
    // <button> and never its pitch field. Claiming them in a lone band cell
    // would break caret movement to solve a problem that surface does not have.
    if (!onNavKey) return;
    // ⚠ WITH one, the arrows are the GRID's. `preventDefault` runs FIRST and
    // unconditionally, so a declined move (clamped at an edge) leaves focus put
    // rather than letting the caret jump — the "rapid arrow-only editing" the
    // grid hosts were built for, and the same ordering NoteEntry uses.
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const handled = onNavKey(e);
      if (handled && editing) commit();
      return;
    }
    if (e.key === 'Tab') {
      // ⚠ NO `stopPropagation` HERE, AND THAT IS #1790 READ CORRECTLY. The flip
      // owners bail on `isTypingTarget`, which an <input> IS — so a Tab in this
      // field never reaches them and there is nothing to stop. The gate
      // <button> beside it is the element that needs the guard, and its host
      // applies it. Calling it here would be cargo-culting the fix onto the
      // element that never had the bug.
      if (onNavKey(e)) e.preventDefault();
    }
  }
</script>

<input
  bind:this={inputEl}
  class="text-entry"
  class:invalid={!isValid}
  type="text"
  spellcheck="false"
  autocomplete="off"
  autocapitalize="off"
  {placeholder}
  {title}
  maxlength={maxLength}
  aria-label={ariaLabel}
  aria-invalid={!isValid}
  value={displayValue}
  data-testid={testid}
  data-role="entry"
  onfocus={onFocus}
  onblur={commit}
  oninput={onInput}
  onkeydown={onKeydown}
/>

<style>
  .text-entry {
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
    /* Reserve the focus ring so committing cannot shift layout (and cannot
       move a VRT baseline by a pixel on focus). */
    box-shadow: 0 0 0 0 transparent;
    transition: box-shadow 0.05s ease-out, border-color 0.05s ease-out;
  }
  .text-entry:focus-visible {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent);
  }
  .text-entry:focus-visible.invalid {
    border-color: var(--cable-gate);
    box-shadow: 0 0 0 2px var(--cable-gate);
  }
</style>
