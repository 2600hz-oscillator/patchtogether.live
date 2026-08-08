<script lang="ts">
  // UNPATCH MENU — the right-click menu on a PATCHED patch point.
  //
  // Opened by Canvas from the bubbling `patchpanel:jackcontextmenu` event any
  // jack field dispatches (legacy PatchPanel port rows + back-panel jacks, the
  // dock full-view / bare-TAB RearCard holes). ONE menu for every surface, so a
  // hole behaves identically wherever it's rendered.
  //
  // Layout + dismissal mirror PortContextMenu (the sibling patch menu): body-
  // portaled + `position: fixed` so it escapes SvelteFlow's transformed
  // viewport, positioned by the shared `clampMenu` action so the WHOLE menu
  // stays inside the client viewport — including a hole right on the screen
  // edge, where the raw cursor anchor would spill it off-screen. Closes on
  // Escape, on a pointerdown in negative space, and after a pick.
  //
  // Presentation only: the caller owns the removal (Canvas's single
  // LOCAL_ORIGIN edge-delete transact), so undo/redo + multiplayer sync come
  // from the existing seam rather than from here.

  import { clampMenu, portal } from '$lib/ui/menu-viewport-action';
  import type { UnpatchItem } from '$lib/ui/unpatch-menu';

  interface Props {
    open: boolean;
    /** Cursor screen-coords (anchor). */
    x: number;
    y: number;
    /** Header — the patch point ("<Module> <PORTID>"). */
    title: string;
    /** One line per seated cable. Never empty when `open` (an unpatched point
     *  opens no menu at all). */
    items: UnpatchItem[];
    /** "Unpatch all (N)" label for a fan-out; null for a single cable. */
    allLabel: string | null;
    /** Remove these edge ids (one, or all of them for "Unpatch all"). */
    onunpatch: (edgeIds: string[]) => void;
    onclose: () => void;
  }

  let { open = $bindable(false), x, y, title, items, allLabel, onunpatch, onclose }: Props =
    $props();

  let menuEl: HTMLDivElement | null = $state(null);

  $effect(() => {
    if (!open) return;
    // CAPTURE + stopPropagation: Escape must close the MENU ONLY. The dock
    // keymap's bubble-phase Escape closes the whole full-view drawer, so a
    // non-capturing handler here would dismiss the menu AND the view the user
    // is patching on. Same discipline as the pickup-cancel / lasso handlers.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onclose();
      }
    };
    const onDocPointerDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (menuEl && menuEl.contains(t)) return;
      onclose();
    };
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDocPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onDocPointerDown, true);
    };
  });

  function pick(edgeIds: string[]) {
    onunpatch(edgeIds);
    onclose();
  }
</script>

{#if open && items.length > 0}
  <div use:portal>
    <div
      bind:this={menuEl}
      class="ctx-menu"
      use:clampMenu={{ x, y }}
      role="menu"
      aria-label="Unpatch"
      data-testid="unpatch-menu"
      oncontextmenu={(e) => e.preventDefault()}
    >
      <div class="ctx-header" data-testid="unpatch-menu-title">{title}</div>
      <ul class="ctx-list">
        {#each items as item (item.edgeId)}
          <li>
            <button
              type="button"
              class="ctx-item"
              role="menuitem"
              data-testid="unpatch-item"
              data-edge-id={item.edgeId}
              data-edge-ids={item.edgeIds.join(' ')}
              data-solo-channel={item.soloChannel ?? ''}
              title={item.label}
              onclick={() => pick(item.edgeIds)}
            >
              <span class="cut" aria-hidden="true">✂</span>
              <span class="txt">{item.label}</span>
            </button>
          </li>
        {/each}
        {#if allLabel}
          <li>
            <button
              type="button"
              class="ctx-item all"
              role="menuitem"
              data-testid="unpatch-all"
              onclick={() => pick(items.flatMap((i) => i.edgeIds))}
            >
              <span class="cut" aria-hidden="true">✂</span>
              <span class="txt">{allLabel}</span>
            </button>
          </li>
        {/if}
      </ul>
    </div>
  </div>
{/if}

<style>
  /* Mirrors PortContextMenu's chrome so the two patch menus read as one
     family (z-index above the portaled patch-panel chrome at 1001). */
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
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-dim);
    padding: 6px 12px 4px;
    pointer-events: none;
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
    gap: 8px;
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
    background: rgba(248, 113, 113, 0.12);
    outline: none;
  }
  .ctx-item .cut {
    color: #f87171;
    width: 0.9em;
    flex: none;
    text-align: center;
  }
  .ctx-item .txt {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ctx-item.all {
    border-top: 1px solid #333a45;
    margin-top: 2px;
    padding-top: 7px;
    color: #f87171;
  }
</style>
