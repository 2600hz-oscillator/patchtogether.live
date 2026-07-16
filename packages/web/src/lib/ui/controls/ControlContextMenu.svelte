<script lang="ts">
  // Right-click context menu for a single knob / slider.
  //
  //   MIDI Learn          — capture next CC and bind it to this control
  //   Forget MIDI binding — drop the saved binding (if any)
  //
  // Layout mirrors NodeContextMenu.svelte exactly so the menus look + feel
  // alike across the canvas. Anchored at the cursor position (x, y).

  interface Props {
    open: boolean;
    /** Cursor screen-coords (anchor). */
    x: number;
    y: number;
    /** Optional title at the top — usually "Module — Param". */
    title: string;
    /** Is there a learned binding to surface a "Forget" option for? */
    hasBinding: boolean;
    /** Optional human description of the current binding (e.g. "CH 1 · CC 7"). */
    bindingLabel?: string;
    onlearn: () => void;
    onforget: () => void;
    onclose: () => void;
    /** Control surfaces this control can be sent to. `bound` = the control is
     *  already on that surface (we offer "Remove from" instead of "Send to").
     *  Omitted/empty → the surface section is hidden (no surfaces in patch). */
    surfaces?: Array<{ id: string; name: string; bound: boolean }>;
    /** Add this control as a pointer on the given surface. */
    onsendtosurface?: (surfaceId: string) => void;
    /** Remove this control's pointer from the given surface. */
    onremovefromsurface?: (surfaceId: string) => void;
    /** ELECTRA CONTROL surfaces this control can be sent to a FIXED (row, knob)
     *  slot on. `assignedSlot` = the 0..35 slot this control already occupies on
     *  that electra (null when unassigned → we offer the Row/knob flyout instead
     *  of "Remove from"). Omitted/empty → the electra section is hidden. */
    electras?: Array<{ id: string; name: string; assignedSlot: number | null }>;
    /** Assign this control to (electraId, slot) — slot = (row-1)*6 + (knob-1). */
    onassignelectra?: (electraId: string, slot: number) => void;
    /** Clear this control from (electraId, slot). */
    onclearelectra?: (electraId: string, slot: number) => void;
    /** Clip-players in the rack — the "Assign to automation lane ▸ 1–8"
     *  targets (per-clip automation: every clip-player accepts assignments).
     *  `lanes` carries each lane's colour swatch; `assignedLane` = the lane this
     *  control already sits on for that player (highlighted in the flyout).
     *  Omitted/empty → the section is hidden unless `automated` (then only
     *  "Remove automation assignment" shows). */
    automations?: Array<{
      nodeId: string;
      name: string;
      lanes: Array<{ lane: number; color: string }>;
      assignedLane: number | null;
    }>;
    /** True when THIS control is already assigned to some automation lane → we
     *  ALSO offer "Remove automation assignment" (assigning to another lane
     *  MOVES it — one lane per param). */
    automated?: boolean;
    /** True when THIS control has RECORDED envelopes in some clip → we offer
     *  "Clear recorded automation" (remove = stops future recording; clear =
     *  deletes the recorded envelopes — two different affordances). */
    automationRecorded?: boolean;
    /** Assign this control to (clipPlayerNodeId, lane). */
    onassignautomation?: (clipPlayerNodeId: string, lane: number) => void;
    /** Remove this control's assignment from whichever player holds it. */
    onremoveautomation?: () => void;
    /** Delete this control's recorded envelopes (assigned lane / all clips). */
    onclearautomation?: () => void;
  }

  let {
    open = $bindable(false),
    x,
    y,
    title,
    hasBinding,
    bindingLabel,
    onlearn,
    onforget,
    onclose,
    surfaces = [],
    onsendtosurface,
    onremovefromsurface,
    electras = [],
    onassignelectra,
    onclearelectra,
    automations = [],
    automated = false,
    automationRecorded = false,
    onassignautomation,
    onremoveautomation,
    onclearautomation,
  }: Props = $props();

  // Fixed 6×6 layout enumeration for the Electra "Send to … → Row → knob"
  // flyout. slot = (row-1)*6 + (knob-1), matching $lib/graph/electra-control.
  const ELECTRA_ROWS = [1, 2, 3, 4, 5, 6] as const;
  const ELECTRA_KNOBS = [1, 2, 3, 4, 5, 6] as const;
  function electraSlot(row: number, knob: number): number {
    return (row - 1) * 6 + (knob - 1);
  }

  // Hover cascade state for the Electra flyout: which electra's Row column is
  // open, and which Row's knob column is open. Reset on every reopen.
  let activeElectraId = $state<string | null>(null);
  let activeRow = $state<number | null>(null);
  // Automation "Assign to automation lane ▸ 1–8" flyout: which clip-player's
  // lane column is open. Reset on every reopen.
  let activeAutomationId = $state<string | null>(null);
  $effect(() => {
    if (!open) {
      activeElectraId = null;
      activeRow = null;
      activeAutomationId = null;
    }
  });

  function assignElectra(electraId: string, row: number, knob: number) {
    onassignelectra?.(electraId, electraSlot(row, knob));
    onclose();
  }
  function clearElectra(e: { id: string; assignedSlot: number | null }) {
    if (e.assignedSlot !== null) onclearelectra?.(e.id, e.assignedSlot);
    onclose();
  }

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

  function pickLearn() { onlearn(); onclose(); }
  function pickForget() { onforget(); onclose(); }
  function pickAssignAutomation(nodeId: string, lane: number) { onassignautomation?.(nodeId, lane); onclose(); }
  function pickRemoveAutomation() { onremoveautomation?.(); onclose(); }
  function pickClearAutomation() { onclearautomation?.(); onclose(); }
  function pickSurface(s: { id: string; bound: boolean }) {
    if (s.bound) onremovefromsurface?.(s.id);
    else onsendtosurface?.(s.id);
    onclose();
  }

  // Portal the menu to <body>. The control menu is rendered inside a
  // SvelteFlow node, which lives under `.svelte-flow__viewport` — an element
  // with a CSS `transform` (pan/zoom). A transformed ancestor becomes the
  // containing block for `position: fixed` descendants, so without this the
  // menu's `left/top` (cursor clientX/clientY) would be interpreted in the
  // transformed/scaled canvas space and land in the wrong spot (drifting as
  // you pan/zoom). Appending to <body> removes the transformed ancestor so
  // fixed-positioning resolves against the real viewport → menu spawns under
  // the cursor. Mirrors VideoCanvasContextMenu.svelte.
  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return {
      destroy() {
        node.remove();
      },
    };
  }
</script>

{#if open}
  <div use:portal>
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
      aria-label="Control actions"
      data-testid="control-context-menu"
    >
      <div class="ctx-header">{title}</div>
      <button
        class="ctx-item"
        onclick={pickLearn}
        role="menuitem"
        data-testid="ctx-midi-learn"
      >
        MIDI Learn…
      </button>
      {#if hasBinding}
        <button
          class="ctx-item subtle"
          onclick={pickForget}
          role="menuitem"
          data-testid="ctx-midi-forget"
        >
          Forget {bindingLabel ?? 'binding'}
        </button>
      {/if}
      {#if surfaces.length > 0}
        <div class="ctx-divider" role="separator"></div>
        {#each surfaces as s (s.id)}
          <button
            class="ctx-item"
            class:subtle={s.bound}
            onclick={() => pickSurface(s)}
            role="menuitem"
            data-testid={`ctx-surface-${s.id}`}
            data-bound={s.bound ? 'true' : 'false'}
          >
            {s.bound ? `Remove from ${s.name}` : `Send to ${s.name}`}
          </button>
        {/each}
      {/if}
      {#if electras.length > 0}
        <div class="ctx-divider" role="separator"></div>
        {#each electras as e (e.id)}
          <!-- LEVEL 1: "Send to <electra>" trigger → LEVEL 2 Row column →
               LEVEL 3 knob column. Hover/click drives the cascade; each leaf
               assigns slot=(row-1)*6+(knob-1). When already assigned, a
               "Remove from <electra>" item is offered too. -->
          <div class="cascade-row">
            <div class="cascade-col">
              <button
                class="ctx-item cascade-trigger"
                class:active={activeElectraId === e.id}
                type="button"
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={activeElectraId === e.id}
                data-testid={`ctx-electra-${e.id}`}
                onmouseenter={() => { activeElectraId = e.id; activeRow = null; }}
                onfocus={() => { activeElectraId = e.id; activeRow = null; }}
                onclick={() => { activeElectraId = e.id; activeRow = null; }}
              >
                Send to {e.name} <span class="chev" aria-hidden="true">▸</span>
              </button>
              {#if e.assignedSlot !== null}
                <button
                  class="ctx-item subtle"
                  type="button"
                  role="menuitem"
                  data-testid={`ctx-electra-${e.id}-clear`}
                  onclick={() => clearElectra(e)}
                >
                  Remove from {e.name}
                </button>
              {/if}
            </div>
            {#if activeElectraId === e.id}
              <ul class="submenu submenu-rows" role="menu" aria-label="Rows" data-testid={`ctx-electra-${e.id}-rows`}>
                {#each ELECTRA_ROWS as row (row)}
                  <li>
                    <button
                      type="button"
                      class="ctx-item cascade-trigger"
                      class:active={activeRow === row}
                      role="menuitem"
                      aria-haspopup="menu"
                      aria-expanded={activeRow === row}
                      data-testid={`ctx-electra-${e.id}-row-${row}`}
                      onmouseenter={() => { activeRow = row; }}
                      onfocus={() => { activeRow = row; }}
                      onclick={() => { activeRow = row; }}
                    >
                      Row{row} <span class="chev" aria-hidden="true">▸</span>
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}
            {#if activeElectraId === e.id && activeRow !== null}
              <ul class="submenu submenu-knobs" role="menu" aria-label="Knobs" data-testid={`ctx-electra-${e.id}-row-${activeRow}-knobs`}>
                {#each ELECTRA_KNOBS as knob (knob)}
                  <li>
                    <button
                      type="button"
                      class="ctx-item"
                      role="menuitem"
                      data-testid={`ctx-electra-${e.id}-row-${activeRow}-knob-${knob}`}
                      onclick={() => assignElectra(e.id, activeRow!, knob)}
                    >
                      {knob}
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
        {/each}
      {/if}
      <!-- PER-CLIP AUTOMATION: assign this control to ONE of a clip-player's 8
           automation lanes ("Assign to automation lane ▸ 1–8" — a lane column
           flyout per player, each row swatched in the lane's colour). One lane
           per param: picking another lane MOVES the assignment. When already
           assigned, "Remove automation assignment" is offered too. -->
      {#if automations.length > 0}
        <div class="ctx-divider" role="separator"></div>
        {#each automations as a (a.nodeId)}
          <div class="cascade-row">
            <div class="cascade-col">
              <button
                class="ctx-item cascade-trigger"
                class:active={activeAutomationId === a.nodeId}
                type="button"
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={activeAutomationId === a.nodeId}
                data-testid={`ctx-automation-${a.nodeId}`}
                onmouseenter={() => { activeAutomationId = a.nodeId; }}
                onfocus={() => { activeAutomationId = a.nodeId; }}
                onclick={() => { activeAutomationId = a.nodeId; }}
              >
                {automations.length > 1
                  ? `Assign to automation lane (${a.name})`
                  : 'Assign to automation lane'}
                <span class="chev" aria-hidden="true">▸</span>
              </button>
            </div>
            {#if activeAutomationId === a.nodeId}
              <ul
                class="submenu submenu-rows"
                role="menu"
                aria-label="Automation lanes"
                data-testid={`ctx-automation-${a.nodeId}-lanes`}
              >
                {#each a.lanes as l (l.lane)}
                  <li>
                    <button
                      type="button"
                      class="ctx-item lane-item"
                      class:assigned={a.assignedLane === l.lane}
                      role="menuitem"
                      data-testid={`ctx-automation-${a.nodeId}-lane-${l.lane}`}
                      onclick={() => pickAssignAutomation(a.nodeId, l.lane)}
                    >
                      <span class="lane-swatch" style:background={l.color} aria-hidden="true"
                      ></span>
                      Lane {l.lane + 1}{a.assignedLane === l.lane ? ' ✓' : ''}
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
        {/each}
      {/if}
      {#if automated}
        <button
          class="ctx-item subtle"
          onclick={pickRemoveAutomation}
          role="menuitem"
          title="Stops FUTURE recording of this control — already-recorded envelopes keep playing (use Clear recorded automation to delete them)"
          data-testid="ctx-automation-remove"
        >
          Remove automation assignment
        </button>
      {/if}
      {#if automationRecorded}
        <button
          class="ctx-item subtle"
          onclick={pickClearAutomation}
          role="menuitem"
          title="DELETES this control's recorded envelopes — from every clip in its assigned lane (or all clips when unassigned). Undoable."
          data-testid="ctx-automation-clear"
        >
          Clear recorded automation (this control)
        </button>
      {/if}
    </div>
  </div>
{/if}

<style>
  .ctx-overlay {
    position: fixed;
    inset: 0;
    /* Above the patch-menu redesign's portaled panel chrome (z-index 1001) +
       the pickup cable (1002) so a control/gate-input MIDI-assign menu opened
       from a card or an OPEN patch panel is never intercepted by the panel rows
       beneath it. Still below global modals/toasts (9000+). */
    z-index: 2000;
  }
  .ctx-divider {
    height: 1px;
    margin: 4px 0;
    background: #353b46;
  }
  .ctx-menu {
    position: fixed;
    z-index: 2001;
    min-width: 180px;
    background: var(--module-bg);
    border: 1px solid #404652;
    border-radius: 6px;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.5);
    /* visible (not hidden) so the Electra Row/knob cascade columns, which lay
       out as flex-row siblings, aren't clipped when they extend past the main
       column. The main column's rounded corners stay clean. */
    overflow: visible;
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
  .ctx-item.subtle {
    color: var(--text-dim);
    font-size: 0.78rem;
  }
  .ctx-item:hover,
  .ctx-item:focus-visible,
  .ctx-item.active {
    background: rgba(96, 165, 250, 0.1);
    outline: none;
  }
  /* ── Electra "Send to … → Row → knob" 3-level cascade (cribbed from
     PortContextMenu's 2-level cascade, extended to a 3rd column). The three
     columns lay out as flex-row siblings inside the menu so the parent grows
     horizontally to fit them (no absolute positioning → no clip). ── */
  .cascade-row {
    display: flex;
    align-items: stretch;
  }
  .cascade-col {
    display: flex;
    flex-direction: column;
    min-width: 180px;
  }
  .cascade-trigger {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 6px;
  }
  .chev {
    color: var(--text-dim);
  }
  .submenu {
    list-style: none;
    margin: 0;
    padding: 4px 0;
    border-left: 1px solid #2a2f3a;
    max-height: 60vh;
    overflow-y: auto;
    background: var(--module-bg);
  }
  .submenu-rows {
    min-width: 96px;
  }
  .submenu-knobs {
    min-width: 64px;
  }
  .submenu .ctx-item {
    white-space: nowrap;
  }
  /* Automation-lane flyout rows: a colour swatch + "Lane N" (✓ on the current
     assignment). The swatch is the lane's effective channel colour — the same
     hue the assigned control's name border and the grid column use. */
  .lane-item {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .lane-item.assigned {
    color: #7ff0ea;
  }
  .lane-swatch {
    width: 10px;
    height: 10px;
    border-radius: 2px;
    flex: none;
    border: 1px solid rgba(255, 255, 255, 0.25);
  }
</style>
