<script lang="ts">
  // Right-click context menu for a port (handle dot). Cascades:
  //   level 1: "Patch to..." (disabled when no other modules exist)
  //   level 2: every other module — "DisplayName · TypeLabel"
  //   level 3: candidate ports on the chosen module, with "!" prefix on
  //            inputs already receiving a cable (destructive overwrite).
  //
  // The menu persists through ALL pointer movements while open. It closes
  // only on Escape, on picking a candidate port (which fires
  // `onpick({ targetNodeId, targetPortId })`), or implicitly when the
  // user right-clicks a different port (Canvas opens a fresh menu in
  // place of the old one).

  import type { ModuleEntry, CandidatePort } from '$lib/ui/port-patch-helpers';

  interface Props {
    open: boolean;
    /** Cursor position (screen-space). */
    x: number;
    y: number;
    /** Source port info, displayed in the header. */
    sourceLabel: string;
    /** All other modules in the patch, already excluding the source's module. */
    moduleEntries: ModuleEntry[];
    /** Lazily computed when the user hovers / clicks a module. Caller maps
     *  nodeId → CandidatePort[]. */
    candidatesFor: (nodeId: string) => CandidatePort[];
    onpick: (target: { nodeId: string; portId: string }) => void;
    onclose: () => void;
  }

  let {
    open = $bindable(false),
    x,
    y,
    sourceLabel,
    moduleEntries,
    candidatesFor,
    onpick,
    onclose,
  }: Props = $props();

  // Active panel cascade — null = level 1 only; nodeId = level 2 expanded
  // for that module. Resets every time the menu reopens (on `open` flip).
  let activeModuleId = $state<string | null>(null);

  $effect(() => {
    if (!open) activeModuleId = null;
  });

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

  let candidates = $derived<CandidatePort[]>(
    activeModuleId ? candidatesFor(activeModuleId) : [],
  );

  function pickModule(nodeId: string) {
    activeModuleId = nodeId;
  }

  function pickPort(p: CandidatePort) {
    if (!activeModuleId) return;
    onpick({ nodeId: activeModuleId, portId: p.portId });
    onclose();
  }
</script>

{#if open}
  <!--
    No click-outside overlay: the patch-context menu must persist through
    ALL pointer movements while the user is mid-patching. It closes only
    on (a) Escape, (b) picking a target port, or (c) a fresh contextmenu
    on a different port (Canvas's capture-phase listener replaces this
    open with a new one, no explicit close needed). An overlay with
    onclick={onclose} would dismiss the menu on incidental clicks
    elsewhere on the canvas, which broke the cascade mid-trip.
  -->
  <div
    class="ctx-menu"
    style:left="{x}px"
    style:top="{y}px"
    role="menu"
    aria-label="Port actions"
    data-testid="port-context-menu"
  >
    <div class="ctx-header">{sourceLabel}</div>
    {#if moduleEntries.length === 0}
      <button
        class="ctx-item"
        type="button"
        disabled
        role="menuitem"
        aria-disabled="true"
        title="No other modules to patch to"
        data-testid="patch-to-disabled"
      >
        Patch to...
      </button>
    {:else}
      <div class="cascade-row">
        <div class="cascade-col">
          <button
            class="ctx-item cascade-trigger"
            class:active={activeModuleId !== null}
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={activeModuleId !== null}
            onclick={() => {
              if (activeModuleId === null && moduleEntries.length === 1) {
                pickModule(moduleEntries[0]!.nodeId);
              }
            }}
            data-testid="patch-to-trigger"
          >
            Patch to... <span class="chev" aria-hidden="true">▸</span>
          </button>
          <ul class="submenu" role="menu" aria-label="Target modules" data-testid="patch-to-modules">
            {#each moduleEntries as entry (entry.nodeId)}
              <li>
                <button
                  type="button"
                  class="ctx-item"
                  class:active={activeModuleId === entry.nodeId}
                  role="menuitem"
                  data-testid="patch-to-module"
                  data-node-id={entry.nodeId}
                  onmouseenter={() => pickModule(entry.nodeId)}
                  onfocus={() => pickModule(entry.nodeId)}
                  onclick={() => pickModule(entry.nodeId)}
                >
                  <span class="entry-name">{entry.displayName}</span>
                  {#if entry.displayName !== entry.typeLabel}
                    <span class="entry-type">· {entry.typeLabel}</span>
                  {/if}
                </button>
              </li>
            {/each}
          </ul>
        </div>
        {#if activeModuleId !== null}
          <ul class="submenu submenu-ports" role="menu" aria-label="Compatible ports" data-testid="patch-to-ports">
            {#if candidates.length === 0}
              <li>
                <button
                  type="button"
                  class="ctx-item dim"
                  disabled
                  aria-disabled="true"
                  role="menuitem"
                  data-testid="no-compatible-ports"
                >
                  No compatible ports
                </button>
              </li>
            {:else}
              {#each candidates as p (p.portId)}
                <li>
                  <button
                    type="button"
                    class="ctx-item"
                    class:warn={p.occupiedBy !== undefined}
                    role="menuitem"
                    data-testid="patch-to-port"
                    data-port-id={p.portId}
                    data-occupied={p.occupiedBy !== undefined ? 'true' : 'false'}
                    title={p.occupiedBy
                      ? `Will replace existing connection from ${p.occupiedBy.sourceDisplayName}`
                      : ''}
                    onclick={() => pickPort(p)}
                  >
                    {#if p.occupiedBy}<span class="warn-glyph" aria-hidden="true">!</span>{/if}
                    <span>{p.label}</span>
                  </button>
                </li>
              {/each}
            {/if}
          </ul>
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
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
  .cascade-row {
    display: flex;
    align-items: stretch;
  }
  .cascade-col {
    display: flex;
    flex-direction: column;
    min-width: 180px;
  }
  .submenu {
    list-style: none;
    margin: 0;
    padding: 4px 0;
    border-top: 1px solid #2a2f3a;
    max-height: 50vh;
    overflow-y: auto;
  }
  .submenu-ports {
    border-top: none;
    border-left: 1px solid #2a2f3a;
    min-width: 180px;
  }
  .ctx-item {
    display: flex;
    width: 100%;
    align-items: center;
    gap: 6px;
    background: transparent;
    border: none;
    color: var(--text);
    text-align: left;
    padding: 6px 12px;
    font-size: 0.85rem;
    font-family: inherit;
    cursor: pointer;
  }
  .ctx-item:hover:not(:disabled),
  .ctx-item:focus-visible,
  .ctx-item.active {
    background: rgba(96, 165, 250, 0.1);
    outline: none;
  }
  .ctx-item:disabled,
  .ctx-item[aria-disabled='true'] {
    color: var(--text-dim);
    cursor: not-allowed;
    opacity: 0.55;
  }
  .ctx-item.dim {
    color: var(--text-dim);
    font-style: italic;
  }
  .cascade-trigger {
    justify-content: space-between;
  }
  .chev {
    color: var(--text-dim);
  }
  .entry-name {
    flex: 0 0 auto;
  }
  .entry-type {
    color: var(--text-dim);
    font-size: 0.78rem;
    margin-left: 6px;
  }
  .ctx-item.warn {
    color: #fbbf24;
  }
  .warn-glyph {
    color: #fbbf24;
    font-weight: 700;
    width: 0.7em;
    display: inline-block;
    text-align: center;
  }
</style>
