<script lang="ts">
  // Right-click context menu for a marquee selection (Module-grouping
  // Phase 1). Single action: "Group modules…" → opens the group builder
  // modal. Greyed out + non-clickable when selection.size < 2.

  interface Props {
    open: boolean;
    /** Screen-space anchor (cursor position). */
    x: number;
    y: number;
    /** Count of selected nodes — used to enable/disable "Group modules…". */
    selectionCount: number;
    /** Module-grouping Phase 3C — when a remote rack-mate's group-builder
     *  selection overlaps the local selection, soft-lock our action.
     *  `lockedByRemote` is that user's displayName (or undefined when
     *  there's no conflict). */
    lockedByRemote?: string;
    ongroup: () => void;
    onclose: () => void;
  }

  let {
    open = $bindable(false),
    x,
    y,
    selectionCount,
    lockedByRemote,
    ongroup,
    onclose,
  }: Props = $props();

  $effect(() => {
    if (!open) return;
    const onWindowKeydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onclose();
      }
    };
    window.addEventListener('keydown', onWindowKeydown);
    return () => window.removeEventListener('keydown', onWindowKeydown);
  });

  let canGroup = $derived(selectionCount >= 2 && !lockedByRemote);

  function pickGroup() {
    if (!canGroup) return;
    ongroup();
    onclose();
  }
</script>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div
    class="ctx-overlay"
    onclick={onclose}
    oncontextmenu={(e) => { e.preventDefault(); onclose(); }}
    role="presentation"
  ></div>
  <div
    class="ctx-menu"
    style:left="{x}px"
    style:top="{y}px"
    role="menu"
    aria-label="Selection actions"
    data-testid="selection-context-menu"
  >
    <div class="ctx-header">{selectionCount} module{selectionCount === 1 ? '' : 's'} selected</div>
    <button
      class="ctx-item"
      onclick={pickGroup}
      role="menuitem"
      disabled={!canGroup}
      data-testid="ctx-group-modules"
      title={lockedByRemote ? `${lockedByRemote} is currently grouping these modules.` : ''}
    >
      {#if lockedByRemote}
        {lockedByRemote} is grouping…
      {:else}
        Group modules…
      {/if}
    </button>
  </div>
{/if}

<style>
  .ctx-overlay {
    position: fixed;
    inset: 0;
    z-index: 200;
  }
  .ctx-menu {
    position: fixed;
    z-index: 201;
    min-width: 180px;
    background: var(--module-bg);
    border: 1px solid #404652;
    border-radius: 6px;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.5);
    overflow: hidden;
    font-size: 0.85rem;
    padding: 4px 0;
  }
  .ctx-header {
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-dim);
    padding: 6px 12px 4px;
    pointer-events: none;
  }
  .ctx-item {
    display: block;
    width: 100%;
    background: transparent;
    border: none;
    color: var(--text);
    text-align: left;
    padding: 6px 12px;
    font-size: 0.85rem;
    font-family: inherit;
    cursor: pointer;
  }
  .ctx-item:disabled {
    color: var(--text-dim);
    cursor: not-allowed;
    opacity: 0.55;
  }
  .ctx-item:not(:disabled):hover,
  .ctx-item:not(:disabled):focus-visible {
    background: rgba(96, 165, 250, 0.1);
    outline: none;
  }
</style>
