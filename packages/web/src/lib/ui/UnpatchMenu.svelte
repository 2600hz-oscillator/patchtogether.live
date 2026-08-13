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
    /** Change a LIVE cable's stereo mode (owner: right-click an output and the
     *  option is there, patched or not). Switching to L/R-only DROPS the other
     *  leg — the caller routes it through planAudioCommit's channelMode, so
     *  there is one commit seam and no muted-but-present edge. */
    onchannelmode?: (edgeId: string, mode: 'both' | 'left' | 'right') => void;
    /**
     * Start ANOTHER cable from this patch point — opens the patch picker.
     *
     * WHY IT IS HERE. An OUTPUT fans out: the owner's own rack drives
     * `masterL` into three different targets. But right-clicking a patched
     * point opened THIS menu and nothing else, so once a jack had one cable
     * there was no right-click route to a second one — and his two aux sends
     * leave the SAME collapsed `SEND1` jack for two different ES-9 outputs
     * (`send1L`→out3, `send1R`→out4). The first was patchable and the second
     * was not, from the identical gesture.
     *
     * Omitted for an INPUT, which holds one cable and has nothing to fan out.
     */
    onpatchto?: () => void;
    /**
     * Show this jack's two L/R holes instead of one collapsed jack (or fold
     * them back). Omitted when the point is not an expandable stereo pair, so
     * the row is absent rather than present-and-inert.
     *
     * Right-clicking a PATCHED point opens this menu and returns, so without a
     * row here the expand gesture would work on an empty jack and stop working
     * the moment a cable landed in it — which is precisely when the user most
     * wants to see WHICH LEG that cable is on.
     */
    onexpandstereo?: () => void;
    /** TRUE when the pair is already shown as two rows — the row then offers
     *  the way back. */
    stereoExpanded?: boolean;
    onclose: () => void;
  }

  let {
    open = $bindable(false),
    x,
    y,
    title,
    items,
    allLabel,
    onunpatch,
    onchannelmode,
    onpatchto,
    onexpandstereo,
    stereoExpanded = false,
    onclose,
  }: Props = $props();

  /** The three channel chips, in render order. Compact labels — this is a chip
   *  row under a cable, not the picker's full-width rows. */
  const CHANNEL_CHIPS = [
    { mode: 'both', label: 'stereo L+R' },
    { mode: 'left', label: 'only L' },
    { mode: 'right', label: 'only R' },
  ] as const;

  function setMode(edgeId: string, mode: 'both' | 'left' | 'right') {
    onchannelmode?.(edgeId, mode);
    onclose();
  }

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
          tabindex="-1"
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
            {#if item.channelMode}
              <!-- CHANNEL MODE on a LIVE cable. Before this the rows existed
                   only for an UNPATCHED output, because the unpatch menu claimed
                   the right-click first — so a patched stereo cable could not be
                   narrowed without unpatching and re-patching it. -->
              <div
                class="chan"
                role="group"
                aria-label="Stereo channels for this cable"
                data-testid="unpatch-channel-modes"
                data-edge-id={item.edgeId}
              >
                {#each CHANNEL_CHIPS as chip (chip.mode)}
                  <button
                    type="button"
                    class="chan-btn"
                    class:selected={item.channelMode === chip.mode}
                    role="menuitemradio"
                    aria-checked={item.channelMode === chip.mode}
                    data-testid="unpatch-channel-mode"
                    data-mode={chip.mode}
                    data-selected={item.channelMode === chip.mode ? 'true' : 'false'}
                    onclick={() => setMode(item.edgeId, chip.mode)}
                  >{chip.label}</button>
                {/each}
              </div>
            {/if}
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
        {#if onpatchto}
          <li>
            <button
              type="button"
              class="ctx-item patch-to"
              role="menuitem"
              data-testid="unpatch-patch-to"
              title="Run another cable from this output"
              onclick={() => {
                onpatchto();
                onclose();
              }}
            >
              <span class="cut" aria-hidden="true">+</span>
              <span class="txt">Patch to…</span>
            </button>
          </li>
        {/if}
        {#if onexpandstereo}
          <li>
            <button
              type="button"
              class="ctx-item patch-to"
              role="menuitem"
              data-testid="unpatch-expand-stereo"
              data-expanded={stereoExpanded ? 'true' : 'false'}
              title="Show this stereo jack as two separate L / R holes"
              onclick={() => {
                onexpandstereo();
                onclose();
              }}
            >
              <span class="cut" aria-hidden="true">⇔</span>
              <span class="txt"
                >{stereoExpanded ? 'Collapse to one stereo jack' : 'Expand to L / R jacks'}</span
              >
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
  /* Channel chips under a cable row — quieter than the ✂ rows so the
     destructive action stays the visually dominant one. */
  .chan {
    display: flex;
    gap: 4px;
    padding: 2px 12px 6px 30px;
  }
  .chan-btn {
    background: transparent;
    border: 1px solid #333a45;
    border-radius: 3px;
    color: var(--text-dim);
    cursor: pointer;
    font-family: inherit;
    font-size: 0.68rem;
    padding: 2px 6px;
  }
  .chan-btn:hover,
  .chan-btn:focus-visible {
    border-color: var(--accent, #60a5fa);
    color: var(--text);
    outline: none;
  }
  .chan-btn.selected {
    border-color: var(--accent, #60a5fa);
    color: var(--accent, #60a5fa);
  }
  .ctx-item.all {
    border-top: 1px solid #333a45;
    margin-top: 2px;
    padding-top: 7px;
    color: #f87171;
  }
  /* ADDITIVE, not destructive — so it reads as the opposite of the ✂ rows
     above it rather than as another way to cut something. */
  .ctx-item.patch-to {
    border-top: 1px solid #333a45;
    margin-top: 2px;
    padding-top: 7px;
  }
  .ctx-item.patch-to .cut {
    color: var(--accent, #60a5fa);
    font-weight: 700;
  }
  .ctx-item.patch-to:hover,
  .ctx-item.patch-to:focus-visible {
    background: rgba(96, 165, 250, 0.12);
  }
</style>
