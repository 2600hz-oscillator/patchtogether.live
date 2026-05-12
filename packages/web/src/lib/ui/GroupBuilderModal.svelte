<script lang="ts">
  // GroupBuilderModal — Module-grouping Phase 1.
  //
  // Presents the candidate-port list for the marquee selection. Each row:
  // checkbox + "module.port" label + cable-type swatch + patched/unpatched
  // indicator. Auto-pre-checks ports with cables crossing the selection
  // boundary (would-be-dropped otherwise); the user can uncheck if they
  // want to drop those cables.
  //
  // On "Create group", emits the user-confirmed candidate list back to the
  // parent which builds the ExposedPort[] + plans the create-group action.

  import type { PortCandidate } from '$lib/graph/group-actions';

  /** Hard cap on name length — sanity guard, not validation. */
  const NAME_MAX_LENGTH = 32;
  /** Fallback label when the user leaves the name blank. */
  const DEFAULT_GROUP_LABEL = 'GROUP!';

  interface Props {
    open: boolean;
    /** All candidate ports for the selection, pre-ordered by module. */
    candidates: PortCandidate[];
    /** Selection node ids, used to pre-check defaults. */
    selectionIds: string[];
    /** Per-childId display label (e.g. "FILTER"). Falls back to childId. */
    moduleLabels: Map<string, string>;
    oncreate: (selectedCandidates: PortCandidate[], label: string) => void;
    onclose: () => void;
  }

  let {
    open = $bindable(false),
    candidates,
    selectionIds,
    moduleLabels,
    oncreate,
    onclose,
  }: Props = $props();

  // Group name input — defaults to '' so the placeholder is visible. Reset
  // each time the modal opens so a previous session's name doesn't carry over.
  let groupName = $state<string>('');
  let nameInputEl = $state<HTMLInputElement | null>(null);

  // Stable key for the candidate identity (used as Map key + DOM id).
  function keyOf(c: PortCandidate): string {
    return `${c.direction}::${c.childId}::${c.childPortId}`;
  }

  // Per-row check state. Initialized from `hasExternalCable` so any port
  // with a cable crossing the selection boundary is pre-checked (the
  // user's "would have been dropped" prompt). Reset whenever the candidate
  // list identity changes (i.e. modal reopened on a different selection).
  let checked = $state<Record<string, boolean>>({});
  $effect(() => {
    if (!open) return;
    const next: Record<string, boolean> = {};
    for (const c of candidates) next[keyOf(c)] = c.hasExternalCable;
    checked = next;
    // Reset the name + auto-focus the input on (re)open — matches the
    // ModulePalette search-box behavior.
    groupName = '';
    queueMicrotask(() => nameInputEl?.focus());
  });

  let _selectionIds = $derived(selectionIds); // referenced for reactivity hygiene

  // Group candidates by childId for the tabular list. Each group renders
  // a sub-header (module label) + its rows.
  interface ModuleGroup {
    childId: string;
    label: string;
    rows: PortCandidate[];
  }
  let groups = $derived.by<ModuleGroup[]>(() => {
    const byChild = new Map<string, PortCandidate[]>();
    for (const c of candidates) {
      const arr = byChild.get(c.childId) ?? [];
      arr.push(c);
      byChild.set(c.childId, arr);
    }
    return Array.from(byChild.entries()).map(([childId, rows]) => ({
      childId,
      label: moduleLabels.get(childId) ?? childId,
      rows: [...rows].sort((a, b) => {
        // inputs first, then outputs; alphabetical within each
        if (a.direction !== b.direction) return a.direction === 'input' ? -1 : 1;
        return a.childPortId.localeCompare(b.childPortId);
      }),
    }));
  });

  // Count of would-be-dropped cables — sum of `hasExternalCable` rows
  // currently NOT checked. Drives the confirmation hint.
  let dropCount = $derived.by(() => {
    let n = 0;
    for (const c of candidates) {
      if (c.hasExternalCable && !checked[keyOf(c)]) n++;
    }
    return n;
  });

  function toggle(c: PortCandidate) {
    checked = { ...checked, [keyOf(c)]: !checked[keyOf(c)] };
  }

  function handleCreate() {
    const picks: PortCandidate[] = [];
    for (const c of candidates) {
      if (checked[keyOf(c)]) picks.push(c);
    }
    // Confirmation gate: if the user has unchecked external-cable rows,
    // surface a confirm() prompt — they're explicitly dropping those
    // connections, and the spec says to require an extra tap.
    if (dropCount > 0) {
      const ok = window.confirm(
        `${dropCount} cable${dropCount === 1 ? '' : 's'} crossing the group boundary will be DROPPED. Continue?`,
      );
      if (!ok) return;
    }
    const trimmed = groupName.trim();
    const label = trimmed.length > 0 ? trimmed : DEFAULT_GROUP_LABEL;
    oncreate(picks, label);
    onclose();
  }

  function handleCancel() {
    onclose();
  }

  // Enter in the name input triggers Create (same as clicking the button).
  // The port-list validation lives entirely inside handleCreate, so we just
  // delegate to it.
  function onNameKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleCreate();
    }
  }

  // Esc closes the modal.
  $effect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onclose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
</script>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="modal-overlay" onclick={handleCancel} role="presentation"></div>
  <div
    class="modal"
    role="dialog"
    aria-labelledby="group-builder-title"
    data-testid="group-builder-modal"
  >
    <header class="modal-header">
      <h2 id="group-builder-title">Group modules</h2>
      <p class="modal-sub">
        Pick the ports to expose on the group. Cables that would cross the
        boundary are pre-checked; uncheck to drop them.
      </p>
    </header>
    <div class="modal-body">
      <div class="name-row">
        <label class="name-label" for="group-builder-name">Group name</label>
        <input
          id="group-builder-name"
          bind:this={nameInputEl}
          bind:value={groupName}
          type="text"
          class="name-input"
          placeholder={DEFAULT_GROUP_LABEL}
          maxlength={NAME_MAX_LENGTH}
          onkeydown={onNameKeydown}
          data-testid="group-builder-name"
          autocomplete="off"
          spellcheck="false"
        />
      </div>
      {#each groups as g (g.childId)}
        <div class="mod-group">
          <div class="mod-header">{g.label} <span class="mod-id">({g.childId})</span></div>
          <ul class="port-list">
            {#each g.rows as c (keyOf(c))}
              <li class="port-row" data-testid={`port-row-${keyOf(c)}`}>
                <label class="port-label">
                  <input
                    type="checkbox"
                    checked={checked[keyOf(c)] === true}
                    onchange={() => toggle(c)}
                    data-testid={`port-check-${keyOf(c)}`}
                  />
                  <span
                    class="swatch"
                    style="background: var(--cable-{c.cableType});"
                    aria-hidden="true"
                  ></span>
                  <span class="dir" class:input={c.direction === 'input'} class:output={c.direction === 'output'}>
                    {c.direction === 'input' ? 'IN' : 'OUT'}
                  </span>
                  <span class="port-id">{c.childPortId}</span>
                  <span class="status">
                    {#if c.hasExternalCable}
                      <span class="badge external" title={c.externalSummary ?? ''}>patched: external</span>
                    {:else}
                      <span class="badge unpatched">unpatched</span>
                    {/if}
                  </span>
                </label>
              </li>
            {/each}
          </ul>
        </div>
      {/each}
    </div>
    <footer class="modal-footer">
      {#if dropCount > 0}
        <span class="drop-hint">{dropCount} cable{dropCount === 1 ? '' : 's'} will be dropped</span>
      {/if}
      <button class="btn" onclick={handleCancel} data-testid="group-builder-cancel">Cancel</button>
      <button class="btn primary" onclick={handleCreate} data-testid="group-builder-create">
        Create group
      </button>
    </footer>
  </div>
{/if}

<style>
  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    z-index: 300;
  }
  .modal {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(560px, 92vw);
    max-height: 80vh;
    background: var(--module-bg, #1c2026);
    color: var(--text, #f1f1f1);
    border: 1px solid #404652;
    border-radius: 8px;
    z-index: 301;
    display: flex;
    flex-direction: column;
    box-shadow: 0 12px 48px rgba(0, 0, 0, 0.6);
  }
  .modal-header {
    padding: 14px 18px 10px;
    border-bottom: 1px solid #2c313b;
  }
  .modal-header h2 {
    margin: 0;
    font-size: 1rem;
    font-weight: 500;
  }
  .modal-sub {
    margin: 4px 0 0;
    font-size: 0.75rem;
    color: var(--text-dim);
  }
  .modal-body {
    flex: 1 1 auto;
    overflow-y: auto;
    padding: 10px 18px;
  }
  .name-row {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 14px;
  }
  .name-label {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--text-dim);
  }
  .name-input {
    background: #11141a;
    color: var(--text, #f1f1f1);
    border: 1px solid #404652;
    padding: 6px 10px;
    font-size: 0.9rem;
    border-radius: 4px;
    font-family: inherit;
    outline: none;
  }
  .name-input:focus {
    border-color: var(--accent, #60a5fa);
  }
  .mod-group {
    margin-bottom: 14px;
  }
  .mod-header {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--accent, #60a5fa);
    padding: 4px 0;
    margin-bottom: 4px;
    border-bottom: 1px dashed #2c313b;
  }
  .mod-id {
    color: var(--text-dim);
    font-weight: 400;
    text-transform: none;
    letter-spacing: 0;
    margin-left: 6px;
  }
  .port-list {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .port-row {
    padding: 4px 0;
  }
  .port-label {
    display: grid;
    grid-template-columns: auto 16px 40px 1fr auto;
    align-items: center;
    gap: 10px;
    cursor: pointer;
    font-size: 0.85rem;
  }
  .swatch {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 1px solid #2c313b;
  }
  .dir {
    font-size: 0.65rem;
    font-family: ui-monospace, monospace;
    letter-spacing: 0.06em;
    padding: 1px 6px;
    border-radius: 3px;
    background: #2a2f3a;
    color: var(--text-dim);
    text-align: center;
  }
  .dir.input { color: #93c5fd; }
  .dir.output { color: #fcd34d; }
  .port-id {
    font-family: ui-monospace, monospace;
    font-size: 0.8rem;
  }
  .status .badge {
    font-size: 0.65rem;
    letter-spacing: 0.05em;
    padding: 2px 6px;
    border-radius: 3px;
    text-transform: uppercase;
  }
  .badge.external {
    background: rgba(96, 165, 250, 0.15);
    color: #93c5fd;
  }
  .badge.unpatched {
    background: rgba(120, 120, 120, 0.15);
    color: var(--text-dim);
  }
  .modal-footer {
    padding: 12px 18px;
    border-top: 1px solid #2c313b;
    display: flex;
    align-items: center;
    gap: 8px;
    justify-content: flex-end;
  }
  .drop-hint {
    margin-right: auto;
    font-size: 0.75rem;
    color: #f87171;
  }
  .btn {
    background: #2a2f3a;
    color: var(--text);
    border: 1px solid #404652;
    padding: 6px 12px;
    font-size: 0.8rem;
    border-radius: 4px;
    cursor: pointer;
    font-family: inherit;
  }
  .btn:hover { background: #353a47; }
  .btn.primary {
    background: var(--accent, #60a5fa);
    color: #1a1d23;
    border-color: var(--accent, #60a5fa);
  }
  .btn.primary:hover { filter: brightness(1.05); }
</style>
