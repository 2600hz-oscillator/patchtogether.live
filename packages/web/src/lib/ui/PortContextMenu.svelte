<script lang="ts">
  // The "patch to" picker for the redesigned patch flow.
  //
  // OVERLAY-REPLACE model (no more side-by-side cascade columns):
  //   * view 'modules' — the list of every other module to patch to.
  //   * view 'ports'   — the chosen module's compatible ports. REPLACES the
  //     modules list in the SAME vertical space (modules list hides); a back
  //     affordance returns to 'modules'. Drill-in is CLICK-only (hover never
  //     pivots — that fought the click in the old side-by-side layout).
  //
  // The menu is body-portaled + position:fixed at edge-aligned coords (the
  // caller computes them via computeEdgeAlignedRect). It closes only on:
  //   (a) Escape,
  //   (b) picking a target port (commits via onpick),
  //   (c) a pointerdown in negative space (outside the menu DOM),
  //   (d) the caller re-opening it for a different port.
  //
  // Cursor movement does NOT close it — there are no separate columns to
  // traverse between, but negative-space-only dismissal also matches the
  // carry flow (the user may move the cursor around with a cable in hand).

  import type { ModuleEntry, CandidatePort } from '$lib/ui/port-patch-helpers';

  interface Props {
    open: boolean;
    /** Edge-aligned menu position (screen-space, position:fixed). */
    x: number;
    y: number;
    /** Source port info, displayed in the header. */
    sourceLabel: string;
    /** All other modules in the patch, already excluding the source's module. */
    moduleEntries: ModuleEntry[];
    /** Lazily computed when the user clicks a module. Caller maps
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

  // Overlay-replace view. null = the modules list (level 1); a nodeId = that
  // module's ports list (level 2, replacing the modules list). Resets every
  // time the menu reopens.
  let activeModuleId = $state<string | null>(null);

  $effect(() => {
    if (!open) activeModuleId = null;
  });

  let menuEl: HTMLDivElement | null = $state(null);

  // Portal to <body> so position:fixed resolves against the real viewport,
  // escaping the SvelteFlow viewport transform. Mirrors ControlContextMenu.
  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return {
      destroy() {
        node.remove();
      },
    };
  }

  $effect(() => {
    if (!open) return;
    const onWindowKeydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onclose();
      }
    };
    const onDocPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (menuEl && menuEl.contains(target)) return;
      onclose();
    };
    window.addEventListener('keydown', onWindowKeydown);
    document.addEventListener('pointerdown', onDocPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onWindowKeydown);
      document.removeEventListener('pointerdown', onDocPointerDown, true);
    };
  });

  let candidates = $derived<CandidatePort[]>(
    activeModuleId ? candidatesFor(activeModuleId) : [],
  );

  function pickModule(nodeId: string) {
    activeModuleId = nodeId;
  }

  function back() {
    activeModuleId = null;
  }

  function pickPort(p: CandidatePort) {
    if (!activeModuleId) return;
    onpick({ nodeId: activeModuleId, portId: p.portId });
    onclose();
  }
</script>

{#if open}
  <div use:portal>
    <div
      bind:this={menuEl}
      class="ctx-menu"
      style:left="{x}px"
      style:top="{y}px"
      role="menu"
      aria-label="Port actions"
      data-testid="port-context-menu"
    >
      <div class="ctx-header">
        {#if activeModuleId !== null}
          <button
            type="button"
            class="ctx-back"
            data-testid="patch-to-back"
            aria-label="Back"
            onclick={back}
          >
            <span aria-hidden="true">◂</span>
          </button>
        {/if}
        <span class="ctx-header-label">{sourceLabel}</span>
      </div>

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
      {:else if activeModuleId === null}
        <!-- LEVEL 1: modules list. -->
        <ul class="ctx-list" role="menu" aria-label="Target modules" data-testid="patch-to-modules">
          {#each moduleEntries as entry (entry.nodeId)}
            <li>
              <button
                type="button"
                class="ctx-item"
                role="menuitem"
                data-testid="patch-to-module"
                data-node-id={entry.nodeId}
                onclick={() => pickModule(entry.nodeId)}
              >
                <span class="entry-name">{entry.displayName}</span>
                {#if entry.displayName !== entry.typeLabel}
                  <span class="entry-type">· {entry.typeLabel}</span>
                {/if}
                <span class="chev" aria-hidden="true">▸</span>
              </button>
            </li>
          {/each}
        </ul>
      {:else}
        <!-- LEVEL 2: chosen module's ports — REPLACES the modules list. -->
        <ul class="ctx-list ctx-list-ports" role="menu" aria-label="Compatible ports" data-testid="patch-to-ports">
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
  </div>
{/if}

<style>
  .ctx-menu {
    position: fixed;
    z-index: 1002;
    min-width: 200px;
    max-width: 80vw;
    max-height: 70vh;
    overflow-y: auto;
    background: var(--module-bg);
    border: 1px solid #404652;
    border-radius: 6px;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.5);
    font-size: 0.85rem;
    padding: 4px 0;
  }
  .ctx-header {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-dim);
    padding: 6px 12px 4px;
  }
  .ctx-header-label {
    flex: 1;
    pointer-events: none;
  }
  .ctx-back {
    appearance: none;
    background: transparent;
    border: 1px solid #404652;
    border-radius: 3px;
    color: var(--text);
    cursor: pointer;
    font: inherit;
    line-height: 1;
    padding: 1px 5px;
  }
  .ctx-back:hover,
  .ctx-back:focus-visible {
    border-color: var(--accent, #60a5fa);
    outline: none;
  }
  .ctx-list {
    list-style: none;
    margin: 0;
    padding: 2px 0;
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
  .ctx-item:focus-visible {
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
  .entry-name {
    flex: 0 0 auto;
  }
  .entry-type {
    color: var(--text-dim);
    font-size: 0.78rem;
    margin-left: 6px;
    flex: 1;
  }
  .chev {
    color: var(--text-dim);
    margin-left: auto;
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
