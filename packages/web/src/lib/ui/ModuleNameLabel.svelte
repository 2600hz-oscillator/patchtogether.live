<script lang="ts">
  // Editable module-name label. Lives in every card's title chrome.
  //
  // Default (display) state: shows `node.data.name` (or the computed
  // default if missing) as a clickable text element. Click → swaps in an
  // <input> for inline editing; Enter / blur commits, Esc cancels.
  //
  // Uniqueness is enforced by validateRename in $lib/multiplayer/module-naming.
  // Rejection surfaces inline (red text under the input) and the input
  // re-focuses so the user can fix the value without losing keystrokes.
  //
  // Multiplayer: the name lives on `node.data.name` which Y.Doc syncs to
  // every collaborator. Two users editing the same name concurrently
  // resolve via Y.Map last-write-wins — the loser sees the value snap to
  // the winner on the next tick.

  import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
  import {
    nextDefaultName,
    validateRename,
    readName,
  } from '$lib/multiplayer/module-naming';
  import type { ModuleNode } from '$lib/graph/types';

  interface Props {
    node: ModuleNode;
    /** Test hook — appears in data-testid on the input/button so cards can
     *  disambiguate between multiple labels (rare; only relevant if a
     *  card later splits its title into multiple zones). Defaults to
     *  'name-label'. */
    testIdSuffix?: string;
  }

  let { node, testIdSuffix = 'name-label' }: Props = $props();

  // Read the current displayed name. If `node.data.name` is missing
  // (legacy node loaded before the migration ran), compute a default
  // for THIS render only — the migration in Canvas.svelte will write
  // it on the next mount, and a deliberate edit here ALSO writes it.
  let displayName = $derived(
    readName(node) ?? nextDefaultName(patch.nodes, node.type),
  );

  let editing = $state(false);
  let draft = $state('');
  let error = $state<string | null>(null);
  let inputEl = $state<HTMLInputElement | null>(null);

  function startEdit(e?: Event) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    draft = displayName;
    error = null;
    editing = true;
    queueMicrotask(() => {
      inputEl?.focus();
      inputEl?.select();
    });
  }

  function commit() {
    const result = validateRename(patch.nodes, node.id, draft);
    if (!result.ok) {
      error = result.error;
      // Stay in edit mode so the user can fix it.
      queueMicrotask(() => inputEl?.focus());
      return;
    }
    // Same value → no-op write (Y.Doc dedupes anyway, but skip cleanly).
    if (result.name !== readName(node)) {
      ydoc.transact(() => {
        const target = patch.nodes[node.id];
        if (!target) return;
        if (!target.data) target.data = {};
        target.data.name = result.name;
      }, LOCAL_ORIGIN);
    }
    editing = false;
    error = null;
  }

  function cancel() {
    editing = false;
    error = null;
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  }
</script>

<span class="name-label" data-testid={testIdSuffix}>
  {#if editing}
    <input
      bind:this={inputEl}
      bind:value={draft}
      onkeydown={onKey}
      onblur={commit}
      class="name-input nodrag"
      data-testid="{testIdSuffix}-input"
      maxlength="32"
      autocomplete="off"
      spellcheck="false"
      aria-label="Edit module name"
    />
    {#if error}
      <span class="name-error" data-testid="{testIdSuffix}-error">{error}</span>
    {/if}
  {:else}
    <button
      type="button"
      class="name-button nodrag"
      data-testid="{testIdSuffix}-button"
      title="Click to rename"
      onclick={startEdit}
      ondblclick={startEdit}
    >{displayName}</button>
  {/if}
</span>

<style>
  .name-label {
    /* Hosted inside the card .title — tight inline display, no extra box.
     * The card already centers + sizes the title; we just style the
     * interactive bit. */
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    line-height: 1.1;
  }
  .name-button {
    background: transparent;
    border: 1px solid transparent;
    color: inherit;
    font: inherit;
    font-family: ui-monospace, monospace;
    font-size: 0.7rem;
    letter-spacing: 0.06em;
    padding: 1px 6px;
    border-radius: 2px;
    cursor: text;
    transition: border-color 80ms ease-out, background 80ms ease-out;
    /* Reset button look so it sits inline like static text. */
    appearance: none;
    -webkit-appearance: none;
  }
  .name-button:hover,
  .name-button:focus-visible {
    border-color: var(--accent-dim);
    background: rgba(0, 240, 255, 0.06);
    outline: none;
  }
  .name-input {
    background: var(--module-bg-deep, rgba(20, 23, 28, 0.85));
    color: var(--text);
    border: 1px solid var(--accent);
    border-radius: 2px;
    padding: 1px 6px;
    font: inherit;
    font-family: ui-monospace, monospace;
    font-size: 0.7rem;
    letter-spacing: 0.06em;
    text-align: center;
    /* Wide enough to comfortably show 12+ chars at this font size. */
    width: 8.5rem;
    outline: none;
  }
  .name-error {
    font-size: 0.55rem;
    color: #fca5a5;
    background: rgba(248, 113, 113, 0.08);
    padding: 1px 6px;
    border-radius: 2px;
    max-width: 12rem;
  }
</style>
