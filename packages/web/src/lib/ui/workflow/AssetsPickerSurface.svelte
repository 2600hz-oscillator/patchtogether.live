<script lang="ts">
  // AssetsPickerSurface — the WORKFLOW topbar 💾 (5.25" floppy) slot:
  // the Loaded Assets Picker. Three submenus — images / videos / sounds —
  // each listing the mediaLibrary items of that kind. Per row:
  //
  //   * NAME — click = SELECT: the menu closes and a VIRTUAL-PORT cable
  //     drag begins (connectDragState.beginVirtualPickup — the P3
  //     primitive). The cable dangles from the clicked row; dropping it
  //     on a compatible input (a PatchPanel port row) makes Canvas
  //     resolve the source: the asset's PRIMARY module if one is linked
  //     (drag-from-existing), else a new module in the right rail with
  //     the media loaded through the module's own path (asset-spawn.ts).
  //   * ✕ (far right) — UNLOAD: deletes the asset's linked module(s) and
  //     removes it from the library. The menu STAYS OPEN (sticky).
  //   * right-click — context row "add additional output module": a
  //     SECOND module for the same asset, for manual patching
  //     (subsequent drags still default to the FIRST module).
  //
  // Rows whose asset is already patched render in the THEME highlight
  // colour (the workflow accent --cable-gate). Hovering an image/video
  // row shows a thumbnail overlay to the RIGHT of the menu (image:
  // objectUrl; video: the probe's captured poster frame, falling back to
  // a metadata-preloaded <video> first frame).
  //
  // STICKINESS: an open submenu stays open until an asset is SELECTED or
  // ESC — WorkflowTopbar exempts this menu from its outside-pointerdown
  // close (its ESC handler still applies).
  import { mediaLibrary, type MediaItem } from '$lib/media/library.svelte';
  import { assetLinks } from '$lib/media/asset-links.svelte';
  import {
    createAssetModule,
    ensureAssetModule,
    unloadAsset,
    type AssetSpawnContext,
  } from '$lib/media/asset-spawn';
  import { assetModuleSpecFor } from '$lib/media/asset-modules';
  import { connectDragState } from '$lib/ui/connect-drag-state.svelte';
  import type { MediaKind } from '$lib/media/ingest';

  interface Props {
    /** Multiplayer user id (cap checks + creatorId) — Canvas's. */
    currentUserId: string | null;
    /** Canvas's ensureEngine (SAMSLOOP decode needs the AudioContext). */
    onEnsureEngine?: (() => Promise<unknown>) | null;
    /** Close the dropdown (select hand-off). */
    onRequestClose: () => void;
  }
  let { currentUserId, onEnsureEngine = null, onRequestClose }: Props = $props();

  const SECTIONS: ReadonlyArray<{ id: string; label: string; kind: MediaKind }> = [
    { id: 'images', label: 'images', kind: 'image' },
    { id: 'videos', label: 'videos', kind: 'video' },
    { id: 'sounds', label: 'sounds', kind: 'audio' },
  ];

  let openSection = $state<string | null>(null);
  function toggleSection(id: string): void {
    openSection = openSection === id ? null : id;
    hovered = null;
  }

  function itemsOf(kind: MediaKind): MediaItem[] {
    return mediaLibrary.items.filter((i) => i.kind === kind);
  }

  // Spawn/load failures (cap hit, decode error) surface inline — the
  // sticky menu is still up for cap errors from the context row; commit-
  // time errors surface on the next open (the resolve outlives the menu).
  let errorMsg = $state<string | null>(null);
  /** SNAPSHOT the context at gesture time. The virtual drag's resolve()
   *  runs AFTER this menu component is destroyed (select closes it), and
   *  reading destructured props from a destroyed component yields
   *  Svelte's internal UNINITIALIZED sentinel SYMBOL — which, stamped
   *  onto node.data as creatorId, blows up the CRDT write ("invalid").
   *  Plain values captured while alive dodge the whole class. */
  function makeSpawnCtx(): AssetSpawnContext {
    return {
      currentUserId: typeof currentUserId === 'string' ? currentUserId : null,
      ensureEngine: onEnsureEngine,
      onError: (msg) => {
        errorMsg = msg;
      },
    };
  }

  // ---- select → virtual-port cable drag (the P3 primitive) ----
  function onRowSelect(item: MediaItem, ev: MouseEvent): void {
    errorMsg = null;
    const spec = assetModuleSpecFor(item.kind);
    const ctx = makeSpawnCtx(); // snapshot NOW — resolve() outlives this component
    connectDragState.beginVirtualPickup({
      anchor: { x: ev.clientX, y: ev.clientY },
      cableType: spec.dragCableType,
      resolve: () => ensureAssetModule(item, ctx),
    });
    // Seed the ghost endpoint so the cable is visible before the first
    // pointermove (Canvas's tracker takes over immediately after).
    connectDragState.updatePickupCursor(ev.clientX, ev.clientY);
    onRequestClose();
  }

  // ---- unload (✕) — menu stays open ----
  function onRowUnload(item: MediaItem, ev: MouseEvent): void {
    ev.stopPropagation();
    errorMsg = null;
    hovered = null;
    ctxMenu = null;
    unloadAsset(item.id);
  }

  // ---- right-click → "add additional output module" ----
  let ctxMenu = $state<{ item: MediaItem; x: number; y: number } | null>(null);
  function onRowContextMenu(item: MediaItem, ev: MouseEvent): void {
    ev.preventDefault();
    ev.stopPropagation();
    ctxMenu = { item, x: ev.clientX, y: ev.clientY };
  }
  async function onAddAdditionalModule(): Promise<void> {
    const item = ctxMenu?.item;
    ctxMenu = null;
    if (!item) return;
    errorMsg = null;
    await createAssetModule(item, makeSpawnCtx());
  }

  // ---- hover thumbnails (images + videos) ----
  // The overlay renders position:FIXED (viewport coords) rather than
  // absolute inside the menu: the menu scrolls (overflow-y:auto), and an
  // overflow container clips absolutely-positioned children — a fixed
  // element escapes the clip, so the thumbnail really sits to the RIGHT
  // of the menu edge.
  let menuEl = $state<HTMLDivElement | null>(null);
  let hovered = $state<{ item: MediaItem; left: number; top: number } | null>(null);
  function onRowEnter(item: MediaItem, ev: MouseEvent): void {
    if (item.kind === 'audio') return;
    const menuRect = menuEl?.getBoundingClientRect();
    const rowRect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    hovered = {
      item,
      left: (menuRect ? menuRect.right : rowRect.right) + 8,
      top: rowRect.top,
    };
  }
  function onRowLeave(): void {
    hovered = null;
  }

  function isPatched(item: MediaItem): boolean {
    return assetLinks.isLinked(item.id);
  }
</script>

<div class="assets-menu" data-testid="workflow-assets-menu" role="menu" bind:this={menuEl}>
  {#if errorMsg}
    <div class="error" data-testid="workflow-assets-error">{errorMsg}</div>
  {/if}
  {#if mediaLibrary.count === 0}
    <div class="empty" data-testid="workflow-assets-empty">
      no media loaded — use the + loader (or drop files on it)
    </div>
  {/if}
  {#each SECTIONS as section (section.id)}
    {@const items = itemsOf(section.kind)}
    <button
      class="section-row"
      role="menuitem"
      data-testid={`workflow-assets-section-${section.id}`}
      aria-expanded={openSection === section.id}
      disabled={items.length === 0}
      onclick={() => toggleSection(section.id)}
    >
      {section.label}
      <span class="count">{items.length}</span>
      <span class="chev">{openSection === section.id ? '▾' : '▸'}</span>
    </button>
    {#if openSection === section.id}
      <ul class="asset-list" data-testid={`workflow-assets-list-${section.id}`}>
        {#each items as item (item.id)}
          <li>
            <div
              class="asset-row"
              class:patched={isPatched(item)}
              data-testid="workflow-asset-row"
              data-asset-id={item.id}
              data-kind={item.kind}
              data-patched={isPatched(item) ? 'true' : 'false'}
              role="menuitem"
              tabindex="0"
              onmouseenter={(e) => onRowEnter(item, e)}
              onmouseleave={onRowLeave}
              oncontextmenu={(e) => onRowContextMenu(item, e)}
              onclick={(e) => onRowSelect(item, e)}
              onkeydown={(e) => {
                if (e.key === 'Enter') onRowSelect(item, e as unknown as MouseEvent);
              }}
              title={isPatched(item)
                ? `${item.name} — patched; click to drag a new wire from its module`
                : `${item.name} — click to drag a patch wire out`}
            >
              <span class="jack" aria-hidden="true"></span>
              <span class="asset-name" data-testid="workflow-asset-name">{item.name}</span>
              <button
                class="unload"
                data-testid="workflow-asset-unload"
                aria-label={`unload ${item.name}`}
                title="Unload — removes this asset and deletes its module(s)"
                onclick={(e) => onRowUnload(item, e)}
              >✕</button>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  {/each}

  {#if hovered}
    <div
      class="thumb"
      data-testid="workflow-asset-thumb"
      data-thumb-kind={hovered.item.kind}
      style={`left: ${hovered.left}px; top: ${hovered.top}px;`}
      aria-hidden="true"
    >
      {#if hovered.item.kind === 'image'}
        <img src={hovered.item.objectUrl} alt="" data-testid="workflow-asset-thumb-image" />
      {:else if hovered.item.meta.posterUrl}
        <img src={hovered.item.meta.posterUrl} alt="" data-testid="workflow-asset-thumb-poster" />
      {:else}
        <!-- Poster still probing/unavailable — a metadata-preloaded, muted
             video shows its first frame without playing. -->
        <video
          muted
          preload="metadata"
          src={hovered.item.objectUrl}
          data-testid="workflow-asset-thumb-video"
        ></video>
      {/if}
    </div>
  {/if}

  {#if ctxMenu}
    <div
      class="row-ctx"
      data-testid="workflow-asset-context"
      style={`left: ${ctxMenu.x}px; top: ${ctxMenu.y}px;`}
      role="menu"
    >
      <button
        class="row-ctx-item"
        role="menuitem"
        data-testid="workflow-asset-add-module"
        onclick={onAddAdditionalModule}
      >add additional output module</button>
    </div>
  {/if}
</div>

<style>
  .assets-menu {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 60;
    min-width: 240px;
    max-height: 70vh;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    background: #14171c;
    border: 1px solid #404652;
    border-radius: 4px;
    padding: 4px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
  }
  .empty,
  .error {
    color: var(--text-dim);
    font-size: 0.72rem;
    padding: 8px;
  }
  .error {
    color: var(--cable-gate, #f97316);
  }
  .section-row {
    display: flex;
    align-items: center;
    gap: 8px;
    background: transparent;
    color: var(--text);
    border: none;
    text-align: left;
    padding: 7px 10px;
    border-radius: 3px;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.8rem;
  }
  .section-row:hover:not(:disabled) {
    background: #2a2f3a;
  }
  .section-row:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .section-row .count {
    margin-left: auto;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
    font-size: 0.7rem;
  }
  .section-row .chev {
    color: var(--text-dim);
    font-size: 0.7rem;
  }
  .asset-list {
    list-style: none;
    margin: 0;
    padding: 0 0 4px;
  }
  .asset-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 6px 4px 20px;
    border-radius: 3px;
    cursor: pointer;
    color: var(--text);
    font-family: ui-monospace, monospace;
    font-size: 0.7rem;
  }
  .asset-row:hover {
    background: #2a2f3a;
  }
  /* Already-patched assets render in the THEME highlight colour (the
     workflow accent — skin-driven via --cable-gate). */
  .asset-row.patched {
    color: var(--cable-gate, #f97316);
  }
  .asset-row.patched .jack {
    background: var(--cable-gate, #f97316);
  }
  .jack {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    border: 1px solid var(--text-dim);
    flex: 0 0 auto;
  }
  .asset-name {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .unload {
    flex: 0 0 auto;
    width: 18px;
    height: 18px;
    background: transparent;
    border: none;
    border-radius: 3px;
    color: var(--text-dim);
    cursor: pointer;
    font-size: 0.65rem;
  }
  .unload:hover {
    color: var(--text);
    background: #3a2026;
  }
  .thumb {
    position: fixed;
    z-index: 61;
    background: #14171c;
    border: 1px solid #404652;
    border-radius: 4px;
    padding: 4px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
    pointer-events: none;
  }
  .thumb img,
  .thumb video {
    display: block;
    max-width: 180px;
    max-height: 120px;
    border-radius: 3px;
    background: #000;
  }
  .row-ctx {
    position: fixed;
    z-index: 70;
    background: #14171c;
    border: 1px solid #404652;
    border-radius: 4px;
    padding: 4px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
  }
  .row-ctx-item {
    display: block;
    background: transparent;
    border: none;
    color: var(--text);
    padding: 6px 10px;
    border-radius: 3px;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.72rem;
  }
  .row-ctx-item:hover {
    background: #2a2f3a;
  }
</style>
