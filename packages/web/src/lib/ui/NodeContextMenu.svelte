<script lang="ts">
  // Right-click context menu for module nodes. Three actions:
  //   Docs         — open the module's docs page in a new tab (top of menu)
  //   Unpatch all  — keep node, remove every edge touching it
  //   Delete       — remove node + every edge touching it
  //
  // The Docs entry is filtered to per-node right-clicks only; the canvas-pane
  // right-click (handled by ModulePalette) keeps "Add Module" + "Organize" and
  // does not show Docs because there's no module-type to deep-link to.

  interface Props {
    open: boolean;
    /** Screen-space anchor (cursor position). */
    x: number;
    y: number;
    /** Module display label (e.g. "Analog VCO"). */
    nodeLabel: string;
    /** Module type id (e.g. "analogVco"). Used to deep-link to the docs page. */
    nodeType: string;
    ondelete: () => void;
    onunpatch: () => void;
    onclose: () => void;
  }

  let { open = $bindable(false), x, y, nodeLabel, nodeType, ondelete, onunpatch, onclose }: Props = $props();

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
  function pickUnpatch() {
    onunpatch();
    onclose();
  }
  function pickDocs() {
    // New tab so the user keeps their session/canvas state. noopener is the
    // recommended posture for cross-tab links to a public docs page.
    if (typeof window !== 'undefined' && nodeType) {
      window.open(`/docs/modules/${nodeType}`, '_blank', 'noopener');
    }
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
    <button class="ctx-item" onclick={pickDocs} role="menuitem" data-testid="ctx-docs">
      Docs
    </button>
    <div class="ctx-sep" role="separator"></div>
    <button class="ctx-item" onclick={pickUnpatch} role="menuitem">
      Unpatch all
    </button>
    <button class="ctx-item danger" onclick={pickDelete} role="menuitem">
      Delete
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
    background: #2a2f3a;
    margin: 4px 6px;
  }
</style>
