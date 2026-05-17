<script lang="ts">
  // ExposedControlsModal — Module-grouping Phase 4.
  //
  // Pick which child-module controls (buttons + knobs) should surface on
  // a GROUP!'s bar. Sister to GroupBuilderModal but for UI controls
  // instead of patch jacks. Layout: one block per child module that
  // declares `exposableControls`, with a checkbox per control. Empty
  // children (no exposable controls) are omitted entirely.

  import type { ExposedControl } from '$lib/graph/group-projection';
  import type { ExposableControl } from '$lib/audio/module-registry';

  interface ChildBlock {
    childId: string;
    label: string;
    controls: readonly ExposableControl[];
  }

  interface Props {
    open: boolean;
    /** One block per child module that has exposable controls. */
    children: ChildBlock[];
    /** Currently-exposed controls (pre-checks the matching boxes). */
    existing: ExposedControl[];
    /** Called with the user-confirmed list on Save. */
    onsave: (picks: ExposedControl[]) => void;
    onclose: () => void;
  }

  let {
    open = $bindable(false),
    children: childBlocks,
    existing,
    onsave,
    onclose,
  }: Props = $props();

  // key === `${childId}::${controlId}` — stable for both the checkbox state
  // map and the DOM `data-testid` so the E2E spec can address rows by name.
  function keyOf(childId: string, controlId: string): string {
    return `${childId}::${controlId}`;
  }

  let checked = $state<Record<string, boolean>>({});
  $effect(() => {
    if (!open) return;
    const next: Record<string, boolean> = {};
    const existingKeys = new Set<string>();
    for (const ec of existing) existingKeys.add(keyOf(ec.childId, ec.controlId));
    for (const block of childBlocks) {
      for (const c of block.controls) {
        const k = keyOf(block.childId, c.id);
        next[k] = existingKeys.has(k);
      }
    }
    checked = next;
  });

  function toggle(childId: string, controlId: string) {
    const k = keyOf(childId, controlId);
    checked = { ...checked, [k]: !checked[k] };
  }

  function handleSave() {
    const picks: ExposedControl[] = [];
    for (const block of childBlocks) {
      for (const c of block.controls) {
        if (checked[keyOf(block.childId, c.id)]) {
          picks.push({ childId: block.childId, controlId: c.id });
        }
      }
    }
    onsave(picks);
    onclose();
  }

  function handleCancel() {
    onclose();
  }

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
    aria-labelledby="exposed-controls-title"
    data-testid="exposed-controls-modal"
  >
    <header class="modal-header">
      <h2 id="exposed-controls-title">Configure exposed controls</h2>
      <p class="modal-sub">
        Pick which child-module controls surface on the group's bar so
        they're operable without unfolding the group.
      </p>
    </header>
    <div class="modal-body">
      {#if childBlocks.length === 0}
        <div class="empty">None of this group's modules declare exposable controls yet.</div>
      {/if}
      {#each childBlocks as block (block.childId)}
        <div class="mod-block">
          <div class="mod-header">{block.label} <span class="mod-id">({block.childId})</span></div>
          <ul class="ctrl-list">
            {#each block.controls as c (c.id)}
              <li class="ctrl-row" data-testid={`ctrl-row-${keyOf(block.childId, c.id)}`}>
                <label class="ctrl-label">
                  <input
                    type="checkbox"
                    checked={checked[keyOf(block.childId, c.id)] === true}
                    onchange={() => toggle(block.childId, c.id)}
                    data-testid={`ctrl-check-${keyOf(block.childId, c.id)}`}
                  />
                  <span class="kind" class:button={c.kind === 'button'} class:knob={c.kind === 'knob'}>
                    {c.kind.toUpperCase()}
                  </span>
                  <span class="ctrl-id">{c.label}</span>
                  <span class="ctrl-sub">({c.paramId})</span>
                </label>
              </li>
            {/each}
          </ul>
        </div>
      {/each}
    </div>
    <footer class="modal-footer">
      <button class="btn" onclick={handleCancel} data-testid="exposed-controls-cancel">Cancel</button>
      <button class="btn primary" onclick={handleSave} data-testid="exposed-controls-save">Save</button>
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
    width: min(520px, 92vw);
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
  .empty {
    font-size: 0.85rem;
    color: var(--text-dim);
    padding: 12px;
    text-align: center;
  }
  .mod-block {
    margin-bottom: 12px;
  }
  .mod-header {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--text-dim);
    padding: 6px 0;
  }
  .mod-id {
    font-family: ui-monospace, monospace;
    color: #555a66;
    margin-left: 4px;
  }
  .ctrl-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .ctrl-row {
    padding: 4px 0;
  }
  .ctrl-label {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    font-size: 0.85rem;
  }
  .kind {
    font-size: 0.6rem;
    letter-spacing: 0.06em;
    padding: 1px 6px;
    border-radius: 3px;
    background: #2a2f3a;
    color: var(--text-dim);
  }
  .kind.button {
    background: rgba(96, 165, 250, 0.16);
    color: #93c5fd;
  }
  .kind.knob {
    background: rgba(192, 132, 252, 0.16);
    color: #d8b4fe;
  }
  .ctrl-sub {
    font-family: ui-monospace, monospace;
    color: var(--text-dim);
    font-size: 0.75rem;
  }
  .modal-footer {
    padding: 12px 18px;
    border-top: 1px solid #2c313b;
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .btn {
    background: #2a2f3a;
    color: var(--text);
    border: 1px solid #404652;
    padding: 6px 14px;
    font-size: 0.85rem;
    border-radius: 4px;
    cursor: pointer;
    font-family: inherit;
  }
  .btn.primary {
    background: var(--accent, #60a5fa);
    color: #0e1116;
    border-color: var(--accent, #60a5fa);
  }
</style>
