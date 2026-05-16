<script lang="ts">
  // Right-click context menu for module nodes. Four actions:
  //   Docs         — open this module's in-app docs page in a new tab
  //   Duplicate    — clone the module with all params/data into a new node
  //   Unpatch all  — keep node, remove every edge touching it
  //   Delete       — remove node + every edge touching it

  interface Props {
    open: boolean;
    /** Screen-space anchor (cursor position). */
    x: number;
    y: number;
    /** Module display label (e.g. "Analog VCO"). */
    nodeLabel: string;
    /** Module type id (e.g. "analogVco"). Used to build the /docs URL. */
    nodeType?: string | null;
    /** Module-grouping Phase 1: when true the menu surfaces "Ungroup" and
     *  group-specific actions (Phase 2 adds Edit knob positions, Edit
     *  exposed jacks, Duplicate). */
    isGroup?: boolean;
    /** Module-grouping Phase 2A: current expanded state of the group.
     *  Drives the label of the "Edit knob positions" toggle. */
    groupExpanded?: boolean;
    ondelete: () => void;
    onduplicate: () => void;
    onunpatch: () => void;
    onungroup?: () => void;
    /** Module-grouping Phase 2A — toggle data.expanded on the group. */
    ontoggleexpanded?: () => void;
    /** Module-grouping Phase 2B — re-open the group builder for an
     *  existing group, pre-checking currently-exposed ports. */
    oneditexposed?: () => void;
    /** Module-grouping Phase 2C — duplicate group + every child with
     *  fresh ids + cascade offset. */
    onduplicategroup?: () => void;
    /** Saved-groups library — Canvas passes this for signed-in users when
     *  the right-clicked node is a group. Renders "Save group to library…". */
    onsavegroup?: () => void;
    /** Saved-groups library — gates the menu entry. The wiring up in
     *  Canvas already constrains this to signed-in users + group nodes;
     *  the menu just respects whatever the parent asserts. */
    canSaveGroup?: boolean;
    onclose: () => void;
  }

  let {
    open = $bindable(false),
    x,
    y,
    nodeLabel,
    nodeType = null,
    isGroup = false,
    groupExpanded = false,
    ondelete,
    onduplicate,
    onunpatch,
    onungroup,
    ontoggleexpanded,
    oneditexposed,
    onduplicategroup,
    onsavegroup,
    canSaveGroup = false,
    onclose,
  }: Props = $props();

  // Window-level Escape handler — context menus traditionally don't take focus,
  // and the user expects Esc to dismiss regardless of where focus actually sits.
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

  function pickDelete() {
    ondelete();
    onclose();
  }
  function pickDuplicate() {
    onduplicate();
    onclose();
  }
  function pickUnpatch() {
    onunpatch();
    onclose();
  }
  function pickDocs() {
    if (!nodeType) return;
    // window.open with 'noopener' so the new tab can't reach back at this
    // page via window.opener; matches the user's framing of the request.
    window.open(`/docs/modules/${nodeType}`, '_blank', 'noopener');
    onclose();
  }
  function pickUngroup() {
    onungroup?.();
    onclose();
  }
  function pickToggleExpanded() {
    ontoggleexpanded?.();
    onclose();
  }
  function pickEditExposed() {
    oneditexposed?.();
    onclose();
  }
  function pickDuplicateGroup() {
    onduplicategroup?.();
    onclose();
  }
  function pickSaveGroup() {
    onsavegroup?.();
    onclose();
  }
</script>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="ctx-overlay" onclick={onclose} oncontextmenu={(e) => { e.preventDefault(); onclose(); }} role="presentation"></div>
  <div
    class="ctx-menu"
    style:left="{x}px"
    style:top="{y}px"
    role="menu"
    aria-label="Module actions"
  >
    <div class="ctx-header">{nodeLabel}</div>
    {#if nodeType && !isGroup}
      <button class="ctx-item" onclick={pickDocs} role="menuitem">
        Docs
      </button>
      <div class="ctx-sep" role="presentation"></div>
    {/if}
    {#if isGroup}
      <button
        class="ctx-item"
        onclick={pickToggleExpanded}
        role="menuitem"
        data-testid="ctx-toggle-expanded"
      >
        {groupExpanded ? 'Finish editing knob positions' : 'Edit knob positions'}
      </button>
      <button
        class="ctx-item"
        onclick={pickEditExposed}
        role="menuitem"
        data-testid="ctx-edit-exposed"
      >
        Edit exposed patch jacks…
      </button>
      <button
        class="ctx-item"
        onclick={pickDuplicateGroup}
        role="menuitem"
        data-testid="ctx-duplicate-group"
      >
        Duplicate
      </button>
      {#if canSaveGroup && onsavegroup}
        <button
          class="ctx-item"
          onclick={pickSaveGroup}
          role="menuitem"
          data-testid="ctx-save-group"
        >
          Save group to library…
        </button>
      {/if}
      <button class="ctx-item" onclick={pickUngroup} role="menuitem" data-testid="ctx-ungroup">
        Ungroup
      </button>
      <div class="ctx-sep" role="presentation"></div>
    {:else}
      <button class="ctx-item" onclick={pickDuplicate} role="menuitem">
        Duplicate
      </button>
      <button class="ctx-item" onclick={pickUnpatch} role="menuitem">
        Unpatch all
      </button>
    {/if}
    <button class="ctx-item danger" onclick={pickDelete} role="menuitem">
      {isGroup ? 'Delete group + children' : 'Delete'}
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
    min-width: 160px;
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
  .ctx-item:hover,
  .ctx-item:focus-visible {
    background: rgba(96, 165, 250, 0.1);
    outline: none;
  }
  .ctx-item.danger {
    color: #f87171;
  }
  .ctx-item.danger:hover,
  .ctx-item.danger:focus-visible {
    background: rgba(248, 113, 113, 0.12);
  }
  .ctx-sep {
    height: 1px;
    background: #404652;
    margin: 4px 0;
  }
</style>
