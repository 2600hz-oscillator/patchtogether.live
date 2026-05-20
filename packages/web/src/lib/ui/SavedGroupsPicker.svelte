<script lang="ts">
  // SavedGroupsPicker — modal overlay listing the signed-in user's
  // saved-group library. Opened from the ModulePalette's "Insert saved
  // group…" tools entry. Picking a row dispatches `oninsert` with the
  // chosen SavedGroup; Canvas wraps that in a single ydoc.transact via
  // resurrectSavedGroup. Picker also surfaces a per-row Delete affordance
  // so users can prune the library without leaving the rack.
  //
  // Fetches /api/saved-groups on open (cheap — capped at 100 rows per user).

  import type { SavedGroup } from '$lib/server/saved-groups';

  interface Props {
    open: boolean;
    oninsert: (sg: SavedGroup) => void;
    onclose: () => void;
  }

  let { open = $bindable(false), oninsert, onclose }: Props = $props();

  let savedGroups = $state<SavedGroup[]>([]);
  let loading = $state(false);
  let error: string | null = $state(null);
  let deletingId: string | null = $state(null);

  async function refresh() {
    loading = true;
    error = null;
    try {
      const res = await fetch('/api/saved-groups');
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        error = body.message ?? `Load failed: ${res.status}`;
        return;
      }
      const json = (await res.json()) as { savedGroups: SavedGroup[] };
      savedGroups = json.savedGroups;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    if (open) void refresh();
  });

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

  function pickInsert(sg: SavedGroup) {
    oninsert(sg);
    onclose();
  }

  async function deleteRow(sg: SavedGroup, e: Event) {
    e.stopPropagation();
    if (deletingId) return;
    if (!confirm(`Delete instrument "${sg.label}" from your library? This is permanent.`)) return;
    deletingId = sg.id;
    try {
      const res = await fetch(`/api/saved-groups/${sg.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        error = body.message ?? `Delete failed: ${res.status}`;
        return;
      }
      savedGroups = savedGroups.filter((x) => x.id !== sg.id);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      deletingId = null;
    }
  }

  function fmtCount(sg: SavedGroup): string {
    const c = sg.payload.children.length;
    const e = sg.payload.internalEdges.length;
    return `${c} module${c === 1 ? '' : 's'} · ${e} cable${e === 1 ? '' : 's'}`;
  }
</script>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="modal-overlay" onclick={onclose} role="presentation"></div>
  <div
    class="modal"
    role="dialog"
    aria-labelledby="saved-groups-picker-title"
    data-testid="saved-groups-picker"
  >
    <header class="modal-header">
      <h2 id="saved-groups-picker-title">Insert a saved instrument</h2>
      <p class="modal-sub">Click a row to drop a copy into this rack at the spawn point.</p>
    </header>
    <div class="modal-body">
      {#if loading}
        <p class="empty">Loading…</p>
      {:else if error}
        <p class="error" data-testid="picker-error">{error}</p>
      {:else if savedGroups.length === 0}
        <p class="empty" data-testid="picker-empty">
          Your library is empty. Right-click an instrument on the canvas and
          choose "Save instrument to library…" to add one.
        </p>
      {:else}
        <ul class="rows">
          {#each savedGroups as sg (sg.id)}
            <li class="row" data-testid="saved-group-row">
              <button class="row-main" onclick={() => pickInsert(sg)} data-testid={`insert-${sg.id}`}>
                <span class="label">{sg.label}</span>
                <span class="meta">{fmtCount(sg)}</span>
              </button>
              <button
                class="row-delete"
                title="Delete from library"
                onclick={(e) => void deleteRow(sg, e)}
                disabled={deletingId === sg.id}
                data-testid={`delete-${sg.id}`}
              >
                {deletingId === sg.id ? '…' : '×'}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
    <footer class="modal-footer">
      <button class="btn" onclick={onclose} data-testid="picker-close">Close</button>
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
    color: var(--text-dim);
    font-size: 0.85rem;
  }
  .error {
    color: var(--cable-gate, #f87171);
    background: rgba(248, 113, 113, 0.1);
    padding: 8px 12px;
    border-radius: 4px;
    font-size: 0.85rem;
  }
  .rows {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .row {
    display: flex;
    align-items: stretch;
    border: 1px solid #2a2f3a;
    border-radius: 4px;
    margin-bottom: 6px;
    overflow: hidden;
  }
  .row-main {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    background: transparent;
    color: var(--text);
    border: none;
    text-align: left;
    padding: 10px 14px;
    cursor: pointer;
    font-family: inherit;
  }
  .row-main:hover {
    background: rgba(96, 165, 250, 0.08);
  }
  .label {
    font-weight: 500;
    font-size: 0.9rem;
  }
  .meta {
    color: var(--text-dim);
    font-size: 0.75rem;
    margin-top: 2px;
    font-family: ui-monospace, monospace;
  }
  .row-delete {
    background: transparent;
    border: none;
    border-left: 1px solid #2a2f3a;
    color: var(--text-dim);
    padding: 0 12px;
    cursor: pointer;
    font-family: inherit;
    font-size: 1rem;
  }
  .row-delete:hover:not(:disabled) {
    background: rgba(248, 113, 113, 0.1);
    color: var(--cable-gate, #f87171);
  }
  .row-delete:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .modal-footer {
    padding: 12px 18px;
    border-top: 1px solid #2c313b;
    display: flex;
    justify-content: flex-end;
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
  .btn:hover {
    background: #353a47;
  }
</style>
