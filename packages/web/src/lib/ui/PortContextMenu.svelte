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

  //
  // CHANNEL MODE (owner Q5, "patch only L" / "patch only R"). When the source
  // port is one half of a DERIVED stereo pair, three radio rows sit above the
  // module list: STEREO (L+R) — the default and what every patch did before —
  // ONLY L, ONLY R. The choice is a property of the PATCH ABOUT TO BE MADE, not
  // of the port, so it lives with the picker and the caller resets it to
  // 'both' on every open. Picking a target port then writes exactly the legs
  // `planAudioCommit` plans for that mode.
  //
  // It is a MODE, not an action: clicking a channel row does NOT close the
  // menu, because the user still has to say where the cable goes.
  import type { ModuleEntry, CandidatePort } from '$lib/ui/port-patch-helpers';
  import type { ChannelMode } from '$lib/graph/stereo-autowire';

  interface Props {
    open: boolean;
    /** Edge-aligned menu position (screen-space, position:fixed). */
    x: number;
    y: number;
    /** Source port info, displayed in the header. */
    sourceLabel: string;
    /** The source port's derived stereo pair (`{left,right}` port ids), or null
     *  when it carries no stereo image — the channel rows are hidden then. */
    stereoPair?: { left: string; right: string } | null;
    /** Which legs the next commit writes. Owned by the caller. */
    channelMode?: ChannelMode;
    onchannelmode?: (mode: ChannelMode) => void;
    /** All other modules in the patch, already excluding the source's module. */
    moduleEntries: ModuleEntry[];
    /** Lazily computed when the user clicks a module. Caller maps
     *  nodeId → CandidatePort[]. */
    candidatesFor: (nodeId: string) => CandidatePort[];
    /** When set on OPEN, the picker drills STRAIGHT into this module's port
     *  list (level 2) instead of showing the full module list (level 1).
     *  Used by the cable-drop flow: dropping a carried cable over a target
     *  card lands the user directly on that card's compatible ports — the
     *  drill-down INPUT/OUTPUT menu the redesign asks for. null = normal entry
     *  (carry "patch to", contextmenu/dblclick fallbacks). */
    preselectModuleId?: string | null;
    /** `leg` is set when the user picked one SIDE of a collapsed stereo target
     *  (the "RET1 L" / "RET1 R" rows). The caller turns it into the commit's
     *  `channelMode`, so exactly one edge is written. */
    onpick: (target: { nodeId: string; portId: string; leg?: 'left' | 'right' }) => void;
    /**
     * Show the SOURCE jack's two L/R holes on its own card instead of one
     * collapsed jack (or fold them back). Omitted when the source is not an
     * expandable stereo pair.
     *
     * ⚠ NOT the same control as the channel rows above it, though they sit on
     * the same menu. The channel rows say WHICH LEGS THE NEXT CABLE CARRIES —
     * a property of the patch about to be made, reset on every open. This says
     * HOW THE CARD DRAWS THIS JACK — a persistent view choice that writes no
     * edge at all. They compose: expanding CH1 gives two rows you can patch
     * independently, and each of those still has its own channel default.
     */
    onexpandstereo?: () => void;
    /** TRUE when the source jack is already shown as two rows. */
    stereoExpanded?: boolean;
    onclose: () => void;
  }

  let {
    open = $bindable(false),
    x,
    y,
    sourceLabel,
    stereoPair = null,
    channelMode = 'both',
    onchannelmode,
    moduleEntries,
    candidatesFor,
    preselectModuleId = null,
    onpick,
    onexpandstereo,
    stereoExpanded = false,
    onclose,
  }: Props = $props();

  /** The three channel rows, in the order they render. `port` is the leg each
   *  mode actually writes — surfaced in the title so the row is checkable
   *  against the def rather than taken on faith. */
  let channelRows = $derived(
    stereoPair
      ? ([
          { mode: 'both', label: 'patch stereo (L+R)', port: `${stereoPair.left} + ${stereoPair.right}` },
          { mode: 'left', label: 'patch only L', port: stereoPair.left },
          { mode: 'right', label: 'patch only R', port: stereoPair.right },
        ] as const)
      : ([] as const),
  );

  // Overlay-replace view. null = the modules list (level 1); a nodeId = that
  // module's ports list (level 2, replacing the modules list). On open it
  // resets to `preselectModuleId` when the caller pre-drilled into a dropped-on
  // target, else to the modules list; on close it clears.
  let activeModuleId = $state<string | null>(null);

  $effect(() => {
    activeModuleId = open ? (preselectModuleId ?? null) : null;
  });

  let menuEl: HTMLDivElement | null = $state(null);

  // Portal to <body> so position:fixed resolves against the real viewport,
  // escaping the SvelteFlow viewport transform. clampMenu keeps the whole
  // menu inside the viewport with the REAL measured box (the caller's x/y is
  // an edge-aligned top-left estimated at width 200 — flip:false so an
  // overflow slides the menu into view instead of jumping across the anchor).
  import { clampMenu, portal } from '$lib/ui/menu-viewport-action';

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
    onpick({ nodeId: activeModuleId, portId: p.portId, leg: p.leg });
    onclose();
  }
</script>

{#if open}
  <div use:portal>
    <div
      bind:this={menuEl}
      class="ctx-menu"
      use:clampMenu={{ x, y, flip: false }}
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

      {#if channelRows.length > 0}
        <!-- CHANNEL MODE — a mode, not an action: picking a row leaves the menu
             open so the user can still choose a destination. -->
        <ul
          class="ctx-list ctx-list-channels"
          role="group"
          aria-label="Stereo channels to patch"
          data-testid="patch-channel-modes"
        >
          {#each channelRows as row (row.mode)}
            <li>
              <button
                type="button"
                class="ctx-item ctx-channel"
                class:selected={channelMode === row.mode}
                role="menuitemradio"
                aria-checked={channelMode === row.mode}
                data-testid="patch-channel-mode"
                data-mode={row.mode}
                data-selected={channelMode === row.mode ? 'true' : 'false'}
                title={`writes ${row.port}`}
                onclick={() => onchannelmode?.(row.mode)}
              >
                <span class="tick" aria-hidden="true">{channelMode === row.mode ? '●' : '○'}</span>
                <span>{row.label}</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}

      {#if onexpandstereo}
        <!-- JACK LAYOUT — an ACTION, not a mode: it changes how the source card
             draws this jack and closes the menu. Distinct from the channel rows
             above (which choose what the next cable carries and write an edge);
             this writes none. -->
        <ul class="ctx-list ctx-list-channels" role="group" aria-label="Stereo jack layout">
          <li>
            <button
              type="button"
              class="ctx-item ctx-channel"
              role="menuitem"
              data-testid="patch-expand-stereo"
              data-expanded={stereoExpanded ? 'true' : 'false'}
              title="Show this stereo jack as two separate L / R holes"
              onclick={() => {
                onexpandstereo?.();
              }}
            >
              <span class="tick" aria-hidden="true">⇔</span>
              <span
                >{stereoExpanded ? 'collapse to one stereo jack' : 'expand to L / R jacks'}</span
              >
            </button>
          </li>
        </ul>
      {/if}

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
            {#each candidates as p (p.key)}
              <li>
                <button
                  type="button"
                  class="ctx-item"
                  class:warn={p.occupiedBy !== undefined}
                  class:ctx-leg={p.leg !== undefined}
                  role="menuitem"
                  data-testid="patch-to-port"
                  data-port-id={p.portId}
                  data-leg={p.leg ?? ''}
                  data-occupied={p.occupiedBy !== undefined ? 'true' : 'false'}
                  title={p.occupiedBy
                    ? `Will replace existing connection from ${p.occupiedBy.sourceDisplayName}`
                    : p.leg
                      ? `Patch ONE leg only — the ${p.leg === 'left' ? 'L' : 'R'} side`
                      : ''}
                  onclick={() => pickPort(p)}
                >
                  {#if p.occupiedBy}<span class="warn-glyph" aria-hidden="true">!</span>{/if}
                  {#if p.leg}<span class="leg-glyph" aria-hidden="true">└</span>{/if}
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
  .ctx-list-channels {
    border-bottom: 1px solid #2c3037;
    padding-bottom: 4px;
    margin-bottom: 2px;
  }
  .ctx-channel {
    font-size: 0.8rem;
  }
  .ctx-channel .tick {
    color: var(--text-dim);
    width: 0.9em;
    display: inline-block;
    text-align: center;
  }
  .ctx-channel.selected {
    color: var(--accent, #60a5fa);
  }
  .ctx-channel.selected .tick {
    color: var(--accent, #60a5fa);
  }
  /* A per-leg row of a collapsed stereo target — indented under its pair so the
     three rows read as one jack and its two sides, not as three jacks. */
  .ctx-item.ctx-leg {
    padding-left: 20px;
    font-size: 0.8rem;
  }
  .leg-glyph {
    color: var(--text-dim);
    width: 0.7em;
    display: inline-block;
    text-align: center;
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
