<script lang="ts">
  // Right-click context menu for module nodes. Actions:
  //   Docs         — open this module's in-app docs page in a new tab
  //   Assign control color ▸ — set this module's "control colour" tag (the
  //                  colour that PASSES THROUGH onto any Control Surface /
  //                  ElectraControl stripe + the Electra preset). A submenu of
  //                  curated swatches + a custom hex picker + "Reset to default".
  //   Duplicate    — clone the module with all params/data into a new node
  //   Unpatch all  — keep node, remove every edge touching it
  //   Delete       — remove node + every edge touching it

  import {
    CONTROL_COLOR_PALETTE,
    quantizeToRgb565,
    normalizeHex,
  } from '$lib/graph/control-color';
  import type { DockZone } from '$lib/ui/dock/dock';

  interface Props {
    open: boolean;
    /** Screen-space anchor (cursor position). */
    x: number;
    y: number;
    /** Module display label (e.g. "Analog VCO"). */
    nodeLabel: string;
    /** Module type id (e.g. "analogVco"). Used to build the /docs URL. */
    nodeType?: string | null;
    /** Living-docs: whether this module has AUTHORED docs (MODULE_DOCS entry).
     *  Gates the "Annotate" entry — only documented modules can be annotated. */
    hasDocs?: boolean;
    /** Whether annotate mode is currently ON for this node (toggle label). */
    annotateActive?: boolean;
    /** Toggle on-canvas annotate mode for this node (hover → authored docs). */
    onannotate?: () => void;
    /** Module-grouping Phase 1: when true the menu surfaces "Ungroup" and
     *  group-specific actions (Phase 2 adds Edit knob positions, Edit
     *  exposed jacks, Duplicate). */
    isGroup?: boolean;
    /** Module-grouping Phase 2A: current expanded state of the group.
     *  Drives the label of the "Edit knob positions" toggle. */
    groupExpanded?: boolean;
    /** Virtual-rack Phase 2: whether this module is "screwed down" to its rack
     *  slot. Drives the Lock/Unlock entry label + which callback fires. */
    locked?: boolean;
    ondelete: () => void;
    onduplicate: () => void;
    onunpatch: () => void;
    /** Virtual-rack Phase 2: screw the module down to its rack slot (snap to
     *  the 180px grid + pin it non-draggable). */
    onlock?: () => void;
    /** Virtual-rack Phase 2: unscrew the module so it free-floats / drags. */
    onunlock?: () => void;
    onungroup?: () => void;
    /** Module-grouping Phase 2A — toggle data.expanded on the group. */
    ontoggleexpanded?: () => void;
    /** Module-grouping Phase 2B — re-open the group builder for an
     *  existing group, pre-checking currently-exposed ports. */
    oneditexposed?: () => void;
    /** Module-grouping Phase 4 — open the exposed-controls picker
     *  modal for a group. */
    onconfigurecontrols?: () => void;
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
    /** Control colour — the module's CURRENT resolved colour (6-digit hex, no
     *  `#`), shown as the menu's preview swatch. */
    currentControlColor?: string | null;
    /** Whether the user has EXPLICITLY assigned a colour (vs. the auto default)
     *  — gates the "Reset to default" entry. */
    hasCustomControlColor?: boolean;
    /** Set this module's control colour (6-digit hex, no `#`). */
    onsetcontrolcolor?: (hex: string) => void;
    /** Clear the module's control colour → revert to the auto default. */
    onresetcontrolcolor?: () => void;
    /** WORKFLOW "Assign to channel N" (the three separate right-clicks —
     *  automation lane / control-from-clip / send-to-mixer — folded into ONE
     *  channel-indexed action). The per-channel COLOURS (length = channel count)
     *  of the canonical clip-player; each channel button is tinted by its colour,
     *  which IS the automation-lane colour (the per-channel clip colour).
     *  Empty/omitted → the whole assignment section is hidden (no clip-player in
     *  the rack to hold the automation assignment). */
    channelColors?: string[];
    /** THIS module's CURRENT automation lane (0-based) or null — drives the ✓ on
     *  the assigned channel + gates "Remove automation assignment". One lane per
     *  module: picking another channel MOVES the assignment. */
    assignedChannel?: number | null;
    /** Whether "Assign to channel N" will ALSO wire clip-control (the module is a
     *  playable instrument — pitch+gate / poly / gate-only). For the action hint. */
    clipEligible?: boolean;
    /** Whether "Assign to channel N" will ALSO send-to-mixer (the module has a
     *  main audio out AND a mixmstrs is present). For the action hint. */
    mixerEligible?: boolean;
    /** "Assign to channel N" (0-based): automation lane N (ALWAYS) + control-from-
     *  clip N (if clipEligible) + send-to-mixer N (if mixerEligible), one gesture. */
    onassigntochannel?: (channel: number) => void;
    /** "Assign automation only ▸ N": assign ONLY automation lane N — no clip/mixer
     *  wiring, so several modules can share one automation lane. */
    onassignautomationonly?: (channel: number) => void;
    /** Remove this module's automation assignment from whichever player holds it. */
    onremoveautomationlane?: () => void;
    /** DOCKING P2.5a — "Dock to …" entries (allowlisted types, workflow
     *  racks only; Canvas gates and this just renders). */
    dockable?: boolean;
    /** DOCKING P2.5a — the right-clicked node is currently docked (its
     *  canvas presence is a DockStubCard): show "Undock" instead. */
    docked?: boolean;
    ondock?: (zone: DockZone) => void;
    onundock?: () => void;
    onclose: () => void;
  }

  let {
    open = $bindable(false),
    x,
    y,
    nodeLabel,
    nodeType = null,
    hasDocs = false,
    annotateActive = false,
    onannotate,
    isGroup = false,
    groupExpanded = false,
    locked = false,
    ondelete,
    onduplicate,
    onunpatch,
    onlock,
    onunlock,
    onungroup,
    ontoggleexpanded,
    oneditexposed,
    onconfigurecontrols,
    onduplicategroup,
    onsavegroup,
    canSaveGroup = false,
    currentControlColor = null,
    hasCustomControlColor = false,
    onsetcontrolcolor,
    onresetcontrolcolor,
    channelColors = [],
    assignedChannel = null,
    clipEligible = false,
    mixerEligible = false,
    onassigntochannel,
    onassignautomationonly,
    onremoveautomationlane,
    dockable = false,
    docked = false,
    ondock,
    onundock,
    onclose,
  }: Props = $props();

  function pickDock(zone: DockZone) {
    ondock?.(zone);
    onclose();
  }
  function pickUndock() {
    onundock?.();
    onclose();
  }

  // ── Control-colour submenu state ──
  let colorSubmenuOpen = $state(false);
  // ── "Assign to channel" / "Assign automation only" submenu state ──
  let channelSubmenuOpen = $state(false);
  let autoOnlySubmenuOpen = $state(false);
  // Collapse the submenus whenever the whole menu closes, so the NEXT open
  // starts fresh (the component instance is reused via bind:open — without this
  // reset a second open would TOGGLE the still-open submenu shut).
  $effect(() => {
    if (!open) {
      colorSubmenuOpen = false;
      channelSubmenuOpen = false;
      autoOnlySubmenuOpen = false;
    }
  });
  // What "Assign to channel N" wires beyond the always-on automation lane.
  let channelActionHint = $derived(
    clipEligible && mixerEligible
      ? 'also wires clip → module + module → mixer'
      : clipEligible
        ? 'also wires clip → module'
        : mixerEligible
          ? 'also wires module → mixer'
          : 'automation only (module accepts no clip / mixer wiring)',
  );
  // The custom <input type=color> value, seeded from the current colour. Kept
  // as a `#rrggbb` string (the native input's format).
  let customHex = $state('#FFFFFF');
  // The 565-quantized PREVIEW of the custom hex — what the hardware renders.
  let customPreview = $derived(quantizeToRgb565(normalizeHex(customHex) ?? 'FFFFFF'));

  function openColorSubmenu() {
    customHex = `#${currentControlColor ?? 'FFFFFF'}`;
    colorSubmenuOpen = !colorSubmenuOpen;
  }
  function pickColor(hex: string) {
    onsetcontrolcolor?.(hex);
    onclose();
  }
  function pickCustomColor() {
    const norm = normalizeHex(customHex);
    if (norm) onsetcontrolcolor?.(quantizeToRgb565(norm));
    onclose();
  }
  function pickResetColor() {
    onresetcontrolcolor?.();
    onclose();
  }

  function toggleChannelSubmenu() {
    channelSubmenuOpen = !channelSubmenuOpen;
    if (channelSubmenuOpen) autoOnlySubmenuOpen = false;
  }
  function toggleAutoOnlySubmenu() {
    autoOnlySubmenuOpen = !autoOnlySubmenuOpen;
    if (autoOnlySubmenuOpen) channelSubmenuOpen = false;
  }
  function pickAssignToChannel(channel: number) {
    onassigntochannel?.(channel);
    onclose();
  }
  function pickAssignAutomationOnly(channel: number) {
    onassignautomationonly?.(channel);
    onclose();
  }
  function pickRemoveAutomationLane() {
    onremoveautomationlane?.();
    onclose();
  }

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
  function pickLock() {
    if (locked) onunlock?.();
    else onlock?.();
    onclose();
  }
  function pickDocs() {
    if (!nodeType) return;
    // window.open with 'noopener' so the new tab can't reach back at this
    // page via window.opener; matches the user's framing of the request.
    window.open(`/docs/modules/${nodeType}`, '_blank', 'noopener');
    onclose();
  }
  function pickAnnotate() {
    onannotate?.();
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
  function pickConfigureControls() {
    onconfigurecontrols?.();
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
      {#if hasDocs && onannotate}
        <!-- Living-docs: toggle on-canvas Annotate mode (hover a control/port
             → its authored doc in an anchored popover). Only shown for modules
             that actually have authored docs. -->
        <button
          class="ctx-item"
          onclick={pickAnnotate}
          role="menuitemcheckbox"
          aria-checked={annotateActive}
          data-testid="ctx-annotate"
        >
          {annotateActive ? 'Annotate ✓' : 'Annotate'}
        </button>
      {/if}
      <div class="ctx-sep" role="presentation"></div>
    {/if}
    {#if isGroup}
      <!-- Instruments v1 — "Edit Instrument" toggles the new edit-mode
           layout engine (free-form drag + resize). The legacy
           "Edit knob positions" expanded-card mode is kept under the same
           data-testid so existing tests continue to address the toggle. -->
      <button
        class="ctx-item"
        onclick={pickToggleExpanded}
        role="menuitem"
        data-testid="ctx-toggle-expanded"
      >
        {groupExpanded ? 'Finish editing instrument' : 'Edit instrument'}
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
        onclick={pickConfigureControls}
        role="menuitem"
        data-testid="ctx-configure-controls"
      >
        Configure exposed controls…
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
          Save instrument to library…
        </button>
      {/if}
      <button class="ctx-item" onclick={pickUngroup} role="menuitem" data-testid="ctx-ungroup">
        Break apart instrument
      </button>
      <div class="ctx-sep" role="presentation"></div>
    {:else}
      {#if onsetcontrolcolor}
        <!-- Assign control color ▸ — sets the module's tag colour that passes
             through onto Control Surface / ElectraControl stripes + Electra. -->
        <button
          class="ctx-item ctx-has-submenu"
          onclick={openColorSubmenu}
          role="menuitem"
          aria-haspopup="true"
          aria-expanded={colorSubmenuOpen}
          data-testid="ctx-assign-control-color"
        >
          <span
            class="ctx-color-swatch"
            style:background={`#${currentControlColor ?? 'FFFFFF'}`}
            aria-hidden="true"
          ></span>
          Assign control color
          <span class="ctx-caret" aria-hidden="true">{colorSubmenuOpen ? '▾' : '▸'}</span>
        </button>
        {#if colorSubmenuOpen}
          <div class="ctx-color-panel" data-testid="ctx-color-panel" role="group" aria-label="Control colour">
            <div class="ctx-swatches">
              {#each CONTROL_COLOR_PALETTE as sw (sw.hex)}
                <button
                  type="button"
                  class="ctx-swatch-btn"
                  class:selected={currentControlColor === sw.hex}
                  style:background={`#${sw.hex}`}
                  title={sw.name}
                  aria-label={sw.name}
                  data-testid={`ctx-color-swatch-${sw.hex}`}
                  onclick={() => pickColor(sw.hex)}
                ></button>
              {/each}
            </div>
            <div class="ctx-custom-row">
              <label class="ctx-custom-label" title="Custom colour">
                <input
                  type="color"
                  class="ctx-color-input nodrag"
                  bind:value={customHex}
                  data-testid="ctx-color-custom-input"
                  aria-label="Custom control colour"
                />
                <span
                  class="ctx-custom-preview"
                  style:background={`#${customPreview}`}
                  title={`Hardware (RGB565): #${customPreview}`}
                  aria-hidden="true"
                ></span>
                <span class="ctx-custom-hex">#{customPreview}</span>
              </label>
              <button
                type="button"
                class="ctx-custom-apply"
                onclick={pickCustomColor}
                data-testid="ctx-color-custom-apply"
              >
                Apply
              </button>
            </div>
            {#if hasCustomControlColor}
              <button
                type="button"
                class="ctx-item ctx-reset"
                onclick={pickResetColor}
                role="menuitem"
                data-testid="ctx-color-reset"
              >
                Reset to default
              </button>
            {/if}
          </div>
        {/if}
      {/if}
      {#if channelColors.length > 0}
        <!-- WORKFLOW "Assign to channel N" — the folded-together action. ONE
             right-click wires channel N end-to-end: (a) assign this MODULE to
             automation lane N (ALWAYS — automation is universal); (b) if the
             module is a playable instrument, wire clip N → it; (c) if it has a
             main audio out, send it → mixer channel N. Whatever the module can't
             accept is simply skipped (graceful subset). The channel colour IS
             the automation-lane colour (the per-channel clip colour). One lane
             per module: picking another channel MOVES the assignment. -->
        <button
          class="ctx-item ctx-has-submenu"
          onclick={toggleChannelSubmenu}
          role="menuitem"
          aria-haspopup="true"
          aria-expanded={channelSubmenuOpen}
          title={channelActionHint}
          data-testid="ctx-assign-channel"
        >
          Assign to channel
          <span class="ctx-caret" aria-hidden="true">{channelSubmenuOpen ? '▾' : '▸'}</span>
        </button>
        {#if channelSubmenuOpen}
          <div
            class="ctx-lane-panel"
            data-testid="ctx-assign-channel-panel"
            role="group"
            aria-label="Assign to channel"
          >
            {#each channelColors as color, ch (ch)}
              <button
                type="button"
                class="ctx-lane-btn"
                class:assigned={assignedChannel === ch}
                style:--lane-color={color}
                title={`Channel ${ch + 1} — ${channelActionHint}`}
                aria-label={`assign to channel ${ch + 1}`}
                data-testid={`ctx-assign-channel-${ch}`}
                onclick={() => pickAssignToChannel(ch)}
              >{ch + 1}{assignedChannel === ch ? ' ✓' : ''}</button>
            {/each}
          </div>
        {/if}
        <!-- "Assign automation only" — automation lane N with NO clip/mixer
             wiring, so several modules can share one automation lane. -->
        <button
          class="ctx-item ctx-has-submenu"
          onclick={toggleAutoOnlySubmenu}
          role="menuitem"
          aria-haspopup="true"
          aria-expanded={autoOnlySubmenuOpen}
          data-testid="ctx-assign-auto-only"
        >
          Assign automation only
          <span class="ctx-caret" aria-hidden="true">{autoOnlySubmenuOpen ? '▾' : '▸'}</span>
        </button>
        {#if autoOnlySubmenuOpen}
          <div
            class="ctx-lane-panel"
            data-testid="ctx-assign-auto-only-panel"
            role="group"
            aria-label="Assign automation only"
          >
            {#each channelColors as color, ch (ch)}
              <button
                type="button"
                class="ctx-lane-btn"
                class:assigned={assignedChannel === ch}
                style:--lane-color={color}
                title={`Automation lane ${ch + 1} only`}
                aria-label={`assign automation only to channel ${ch + 1}`}
                data-testid={`ctx-assign-auto-only-${ch}`}
                onclick={() => pickAssignAutomationOnly(ch)}
              >{ch + 1}{assignedChannel === ch ? ' ✓' : ''}</button>
            {/each}
          </div>
        {/if}
        {#if assignedChannel !== null}
          <button
            class="ctx-item ctx-subtle"
            onclick={pickRemoveAutomationLane}
            role="menuitem"
            title="Stops FUTURE recording of this module's controls — already-recorded envelopes keep playing (Clear recorded automation lives on each control's right-click menu)"
            data-testid="ctx-automation-remove"
          >
            Remove automation assignment
          </button>
        {/if}
        <div class="ctx-sep" role="presentation"></div>
      {/if}
      {#if docked && onundock}
        <!-- DOCKING P2.5a: the node's canvas presence is a DockStubCard —
             undock returns the full card to its dock-time position. NOT
             undoable (dock state is local; undock is the explicit inverse). -->
        <button class="ctx-item" onclick={pickUndock} role="menuitem" data-testid="ctx-undock">
          ⇲ Undock — return to canvas
        </button>
        <div class="ctx-sep" role="presentation"></div>
      {:else if dockable && ondock}
        <!-- DOCKING P2.5a: workflow racks, allowlisted control modules +
             scope only (owner Q3). Three zones (owner Q5). -->
        <button class="ctx-item" onclick={() => pickDock('top')} role="menuitem" data-testid="ctx-dock-top">
          ⇱ Dock to top rail
        </button>
        <button class="ctx-item" onclick={() => pickDock('left')} role="menuitem" data-testid="ctx-dock-left">
          ⇱ Dock to left rail
        </button>
        <button class="ctx-item" onclick={() => pickDock('bottom')} role="menuitem" data-testid="ctx-dock-bottom">
          ⇱ Dock to bottom drawer
        </button>
        <div class="ctx-sep" role="presentation"></div>
      {/if}
      <button class="ctx-item" onclick={pickDuplicate} role="menuitem">
        Duplicate
      </button>
      <!-- TOYBOX is a node-map module: "Unpatch all" (remove every cable
           touching the module) is confusing alongside the in-card combine
           graph's own per-node disconnect, so it's hidden for type==='toybox'.
           The combine editor's contextual menu provides node-map disconnects. -->
      {#if nodeType !== 'toybox'}
        <button class="ctx-item" onclick={pickUnpatch} role="menuitem">
          Unpatch all
        </button>
      {/if}
      <!-- Virtual-rack Phase 2: "screw down" the module to its rack slot
           (snap to the 180px grid + pin non-draggable), or release it. -->
      {#if (onlock || onunlock) && !docked}
        <!-- Lock (screw-down) is a canvas-position op — meaningless while
             the node's canvas presence is a dock stub, so hidden then. -->
        <button
          class="ctx-item"
          onclick={pickLock}
          role="menuitem"
          data-testid="ctx-lock"
          aria-pressed={locked}
        >
          {locked ? 'Unlock' : 'Lock'}
        </button>
      {/if}
    {/if}
    <button class="ctx-item danger" onclick={pickDelete} role="menuitem">
      {isGroup ? 'Delete instrument + modules' : 'Delete'}
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
  /* ── Control-colour submenu ── */
  .ctx-has-submenu {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .ctx-color-swatch {
    display: inline-block;
    width: 11px;
    height: 11px;
    border-radius: 3px;
    border: 1px solid rgba(0, 0, 0, 0.4);
    flex: none;
  }
  .ctx-caret {
    margin-left: auto;
    color: var(--text-dim);
    font-size: 0.7rem;
  }
  .ctx-color-panel {
    padding: 6px 12px 8px;
    border-bottom: 1px solid #2a2f3a;
  }
  .ctx-swatches {
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    gap: 5px;
    margin-bottom: 8px;
  }
  .ctx-swatch-btn {
    width: 100%;
    aspect-ratio: 1;
    min-width: 18px;
    border-radius: 4px;
    border: 1px solid rgba(0, 0, 0, 0.4);
    cursor: pointer;
    padding: 0;
  }
  .ctx-swatch-btn:hover,
  .ctx-swatch-btn:focus-visible {
    outline: 2px solid var(--accent, #60a5fa);
    outline-offset: 1px;
  }
  .ctx-swatch-btn.selected {
    outline: 2px solid #fff;
    outline-offset: 1px;
  }
  .ctx-custom-row {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 4px;
  }
  .ctx-custom-label {
    display: flex;
    align-items: center;
    gap: 5px;
    flex: 1;
    cursor: pointer;
  }
  .ctx-color-input {
    width: 22px;
    height: 22px;
    padding: 0;
    border: 1px solid #404652;
    border-radius: 4px;
    background: transparent;
    cursor: pointer;
  }
  .ctx-custom-preview {
    display: inline-block;
    width: 14px;
    height: 14px;
    border-radius: 3px;
    border: 1px solid rgba(0, 0, 0, 0.4);
    flex: none;
  }
  .ctx-custom-hex {
    font-size: 0.65rem;
    font-family: ui-monospace, monospace;
    color: var(--text-dim);
  }
  .ctx-custom-apply {
    font-size: 0.7rem;
    padding: 3px 10px;
    border-radius: 4px;
    border: 1px solid #404652;
    background: rgba(96, 165, 250, 0.12);
    color: var(--text);
    cursor: pointer;
  }
  .ctx-custom-apply:hover {
    background: rgba(96, 165, 250, 0.22);
  }
  .ctx-reset {
    padding: 4px 0 0;
    color: var(--text-dim);
    font-size: 0.78rem;
  }
  .ctx-reset:hover,
  .ctx-reset:focus-visible {
    background: transparent;
    color: var(--text);
  }
  /* ── Automation-lane submenu (module-level assignment) ── */
  .ctx-lane-panel {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 5px;
    padding: 6px 12px 8px;
    border-bottom: 1px solid #2a2f3a;
  }
  .ctx-lane-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 2px;
    height: 22px;
    border-radius: 4px;
    border: 1px solid color-mix(in srgb, var(--lane-color) 70%, #000);
    background: color-mix(in srgb, var(--lane-color) 45%, #0b0d12);
    color: #fff;
    font-size: 0.72rem;
    cursor: pointer;
    padding: 0;
  }
  .ctx-lane-btn:hover,
  .ctx-lane-btn:focus-visible {
    outline: 2px solid var(--accent, #60a5fa);
    outline-offset: 1px;
  }
  .ctx-lane-btn.assigned {
    background: var(--lane-color);
    color: #04211f;
    font-weight: 700;
  }
  .ctx-subtle {
    color: var(--text-dim);
    font-size: 0.78rem;
  }
</style>
