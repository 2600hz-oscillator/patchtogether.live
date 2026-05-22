<script lang="ts">
  // Hover-revealed patch panel — every module card hosts one.
  //
  // Default state: a single small "patch" affordance at the top-left of the
  // card. Every <Handle> declared on the module def is rendered here in the
  // DOM (so the I/O-spec consistency e2e test still finds them) but stacked
  // at (8, 8) with opacity:0 + pointer-events:none. All cables therefore
  // visually anchor to the affordance corner.
  //
  // Hover (or tap) the affordance: a popover patch-panel slides out, with
  // each port rendered as a labeled row carrying the real <Handle>. Handles
  // re-position to their row coordinates on open; we call
  // useUpdateNodeInternals() with `force: true` so Svelte Flow re-measures
  // handleBounds and edges re-route.
  //
  // Approach (a) from .myrobots/plans/ui-patch-panel-refactor.md.
  import { onMount } from 'svelte';
  import { Handle, Position, useUpdateNodeInternals } from '@xyflow/svelte';
  import {
    resolveVerboseLabel,
    groupPortsByCableType,
    type GroupedPorts,
    type PortDescriptor,
  } from '$lib/ui/patch-panel-labels';
  import { connectDragState } from '$lib/ui/connect-drag-state.svelte';
  import type { Snippet } from 'svelte';

  /**
   * Props.
   *
   * - `nodeId`: the Svelte Flow node id (passed from the card's `let { id }
   *   = $props()`). Used by useUpdateNodeInternals to ask Svelte Flow to
   *   recompute handleBounds for THIS card after the panel toggles.
   * - `inputs` / `outputs`: ordered port lists. Each entry can override the
   *   verbose label (otherwise it derives from the port id via
   *   resolveVerboseLabel) and can attach a non-default cable color (which
   *   shows up as a stripe on the panel row).
   * - `groupingStrategy`: 'auto' (default) groups inputs by cable type
   *   (Gates → Pitches → CV → Audio → ...) and outputs the same way.
   *   'sectioned' lets the card supply explicit section headers — useful
   *   for mega-modules like RIOTGIRLS where voices need their own grouping.
   * - `sections`: when groupingStrategy === 'sectioned', an array of
   *   { label, inputs, outputs } that PatchPanel renders top-to-bottom.
   * - `panelWidth`: CSS width of the OPEN popover (default 280).
   *   The open panel hosts a 2-column grid (inputs left, outputs
   *   right), so each column is ~half this width minus gap. Dense
   *   modules pass a wider `panelWidth` (MIXMSTRS 560, RIOTGIRLS 600)
   *   so each column has enough horizontal space for verbose labels
   *   like "FILTER PING DECAY". The panel scrolls vertically when
   *   the dense column overflows max-height (70vh), so RIOTGIRLS's
   *   55-row inputs column doesn't push the panel past the viewport.
   *   `panelWidth` is capped at 80vw on the panel itself so smaller
   *   viewports stay legible.
   * - `children`: the slot for the card's main content (knobs, buttons,
   *   widgets — everything that is NOT a Handle).
   */
  interface SectionedGroup {
    label: string;
    inputs?: PortDescriptor[];
    outputs?: PortDescriptor[];
    /** Optional nested sub-sections. Recursive — sub-sections may
     *  themselves declare further sub-sections. Drag-time expand-all
     *  recurses through this tree so every section + sub-section is
     *  reachable when a cable is in flight. No card currently uses this
     *  (today's data model is single-level), but the recursion is here
     *  so future mega-modules can opt into 2-level layouts without
     *  re-discovering the expand-all gap. */
    subsections?: SectionedGroup[];
  }

  interface Props {
    nodeId: string;
    inputs?: PortDescriptor[];
    outputs?: PortDescriptor[];
    groupingStrategy?: 'auto' | 'sectioned';
    sections?: SectionedGroup[];
    panelWidth?: number;
    children?: Snippet;
  }

  let {
    nodeId,
    inputs = [],
    outputs = [],
    groupingStrategy = 'auto',
    sections = [],
    panelWidth = 280,
    children,
  }: Props = $props();

  // For sectioned grouping (RIOTGIRLS), pull the outputs across all
  // sections into a single flat list rendered in the right column.
  // Each section keeps its inputs in the left column. This is
  // "Option A" from the layout spec — simpler than splitting each
  // section into its own column, and fits within width budget.
  interface SectionedOutputEntry {
    sectionLabel: string;
    ports: PortDescriptor[];
  }
  let sectionedOutputs = $derived<SectionedOutputEntry[]>(
    groupingStrategy === 'sectioned'
      ? sections
          .filter((s) => s.outputs && s.outputs.length > 0)
          .map((s) => ({
            sectionLabel: s.label,
            ports: s.outputs ?? [],
          }))
      : [],
  );
  let sectionedHasInputs = $derived<boolean>(
    groupingStrategy === 'sectioned' &&
      sections.some((s) => s.inputs && s.inputs.length > 0),
  );

  // Layout column count: AudioOut has no outputs; some hypothetical
  // source modules might have no inputs. In either case collapse to a
  // single visible column so we don't render an awkward empty grid track.
  let hasInputs = $derived(
    groupingStrategy === 'sectioned' ? sectionedHasInputs : inputs.length > 0,
  );
  let hasOutputs = $derived(
    groupingStrategy === 'sectioned' ? sectionedOutputs.length > 0 : outputs.length > 0,
  );
  let visibleColumnCount = $derived((hasInputs ? 1 : 0) + (hasOutputs ? 1 : 0) || 1);

  // panelWidth is the TOTAL popover width — preserving the prop's
  // pre-two-column semantics so existing test geometry (handles land
  // near the card edge, not 280px further out) continues to work.
  // The 2-column grid divides this width internally.

  // ---------------- Hover-intent state machine ----------------
  //
  // Three drivers can keep the panel open:
  //   * `hovered`        — mouse is over the trigger or panel
  //   * `pinned`         — user clicked the trigger to lock it open (until
  //                        another click or an outside tap)
  //   * `stayOpenForDrag` — user is mid-connect-drag with a handle inside
  //                        this panel (released on pointerup)
  //
  // Any one of those keeps the panel open; the panel closes only when all
  // three drop. The 200ms hover-close delay only applies to the `hovered`
  // driver, so a click stays sticky and a drag never blinks shut.

  let hovered = $state(false);
  let pinned = $state(false);
  let stayOpenForDrag = $state(false);
  // Active trigger corner — set by whichever affordance most recently
  // received a hover/focus/click. Drives panel positioning so the
  // popover anchors under the corner the user reached for, instead of
  // always anchoring to the top-left. ('topLeft' is the historical
  // default; the cable-anchor-top-left invariant from PR-78 still
  // applies to closed-state handles regardless of corner.)
  let triggerCorner = $state<'topLeft' | 'topRight'>('topLeft');
  // Post-click hold: a click on either trigger sets this to a wall-
  // clock timestamp 300ms in the future. While `now < postClickHoldUntil`,
  // the panel stays open even if the cursor leaves — so the user can
  // navigate from the click target down into a port row without the
  // panel snapping shut mid-motion. After the hold expires, normal
  // hover-intent rules (200ms close-grace) resume.
  const POST_CLICK_HOLD_MS = 300;
  let postClickHoldUntil = $state<number>(0);
  let postClickHoldTimer: ReturnType<typeof setTimeout> | null = null;

  // The panel is open if ANY driver wants it open. postClickHoldActive
  // joins the hover/pin/drag drivers as a fourth keep-open signal —
  // it's a time-bounded version of `pinned` that auto-expires.
  // dragLockEngaged is the fifth: a Svelte Flow connect-drag is in
  // flight AND this panel is the one that opened first during the drag,
  // so the panel must persist until the drag commits or releases.
  // cascadeLockEngaged is the sixth: a patch-to cascade (right-click /
  // double-click) is open AND was triggered from a port inside this
  // panel — so the panel must stay visible underneath the cascade
  // until the cascade closes (commit / Esc / new cascade).
  let postClickHoldActive = $derived(postClickHoldUntil > 0);
  let dragLockEngaged = $derived(
    connectDragState.active && connectDragState.lockedPanelNodeId === nodeId,
  );
  let cascadeLockEngaged = $derived(
    connectDragState.cascadeActiveForPanel === nodeId,
  );
  // Auto-open when a connect-drag cable hovers over this card. With the
  // click-to-open trigger model (PR #208), the destination panel would
  // never unfold during a drag without this driver — the cursor is on
  // the cable endpoint, not the corner glyph. The hovered card id is
  // published by connect-drag-state's document-level pointermove tracker.
  let dragHoverEngaged = $derived(
    connectDragState.active && connectDragState.hoveredCardNodeId === nodeId,
  );
  let open = $derived(
    hovered ||
      pinned ||
      stayOpenForDrag ||
      postClickHoldActive ||
      dragLockEngaged ||
      cascadeLockEngaged ||
      dragHoverEngaged,
  );

  // First panel to TRANSITION to open during an active drag claims the
  // lock. We ignore panels that were already open when the drag started
  // (e.g. the source panel, pinned by the user before grabbing the
  // cable) — only a destination panel that opens *as a result of* the
  // drag should be locked. We track the previous-frame value of `open`
  // so we can detect the closed→open transition.
  let prevOpen = $state(false);
  $effect(() => {
    const nextOpen = open;
    if (!prevOpen && nextOpen && connectDragState.active) {
      connectDragState.tryLock(nodeId);
    }
    prevOpen = nextOpen;
  });

  const CLOSE_DELAY_MS = 200;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  function clearCloseTimer() {
    if (closeTimer !== null) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
  }

  function clearPostClickHoldTimer() {
    if (postClickHoldTimer !== null) {
      clearTimeout(postClickHoldTimer);
      postClickHoldTimer = null;
    }
  }

  function openNow() {
    clearCloseTimer();
    hovered = true;
  }

  function scheduleClose() {
    clearCloseTimer();
    // If a post-click hold is in flight, defer the hover-close until
    // after the hold expires (then the normal 200ms grace applies).
    const now = Date.now();
    const remaining = postClickHoldUntil - now;
    const delay = remaining > 0 ? remaining + CLOSE_DELAY_MS : CLOSE_DELAY_MS;
    closeTimer = setTimeout(() => {
      hovered = false;
      closeTimer = null;
    }, delay);
  }

  function startPostClickHold() {
    // Extend the keep-open window to now + 300ms. Multiple clicks just
    // restart the timer (the latest click wins).
    clearPostClickHoldTimer();
    postClickHoldUntil = Date.now() + POST_CLICK_HOLD_MS;
    postClickHoldTimer = setTimeout(() => {
      postClickHoldUntil = 0;
      postClickHoldTimer = null;
    }, POST_CLICK_HOLD_MS);
  }

  function onTriggerEnter(corner: 'topLeft' | 'topRight') {
    triggerCorner = corner;
    openNow();
  }

  function onTriggerClick(corner: 'topLeft' | 'topRight') {
    triggerCorner = corner;
    // Always seed the 300ms post-click hold so the user has a forgiving
    // window to move toward a port. Pin-toggle still works on top of it
    // for explicit lock-open / lock-close.
    startPostClickHold();
    if (pinned) {
      pinned = false;
      // If the cursor's still on the trigger/panel, hover-driver keeps it
      // open until the user moves away.
    } else {
      pinned = true;
      clearCloseTimer();
    }
  }

  // Close on outside-click for touch / mobile users. We treat ANY
  // patch-panel host (not just this one) as "inside" — clicking a port
  // handle in a sibling panel must not close THIS panel, which is the
  // common multi-card patching case.
  onMount(() => {
    const onDocPointerDown = (e: PointerEvent) => {
      if (!open) return;
      if (stayOpenForDrag) return;
      // Drag-lock owns this panel — outside-click can't dismiss it
      // until the drag commits / releases (then connectDragState.end()
      // fires from Canvas's onconnect / onconnectend).
      if (dragLockEngaged) return;
      // Cascade-lock owns this panel — outside-click can't dismiss it
      // until the patch-to cascade closes (commit / Esc / new cascade).
      if (cascadeLockEngaged) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest('[data-patch-panel-node]')) return;
      pinned = false;
      hovered = false;
      // Outside-click overrides the post-click hold — the user is
      // explicitly steering away from this panel, so honour the close.
      clearPostClickHoldTimer();
      postClickHoldUntil = 0;
      clearCloseTimer();
    };
    document.addEventListener('pointerdown', onDocPointerDown, true);
    return () => document.removeEventListener('pointerdown', onDocPointerDown, true);
  });

  // ---------------- Drag-while-open guard ----------------
  //
  // The Handle component fires a low-level pointerdown that becomes a
  // connect-drag. We watch for pointerdowns on any handle inside our panel
  // and set stayOpenForDrag — Canvas's onconnectstart/end on the SvelteFlow
  // root would also work but plumbing a callback is more invasive. The
  // global pointerup clears the flag.
  function onPanelPointerDown(e: PointerEvent) {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (target.closest('.svelte-flow__handle')) {
      stayOpenForDrag = true;
      // Watch for the drop / cancel via a one-shot pointerup on the document.
      const release = () => {
        stayOpenForDrag = false;
        document.removeEventListener('pointerup', release, true);
        document.removeEventListener('pointercancel', release, true);
      };
      document.addEventListener('pointerup', release, true);
      document.addEventListener('pointercancel', release, true);
    }
  }

  // ---------------- Handle bounds re-measure ----------------
  //
  // Svelte Flow caches handleBounds keyed by node-element resize. Because
  // our open/close doesn't change the card's bounding box (the panel is
  // absolute and overflows), we MUST manually trigger a re-measure so
  // edges re-route.
  const updateNodeInternals = useUpdateNodeInternals();

  $effect(() => {
    // Read `open` so this effect re-runs on every flip.
    void open;
    // Also re-run on every section-expand toggle (sectioned modules) so
    // the handles that fan out / collapse get their bounds re-measured
    // and any in-flight cables re-route to the new positions. Reading
    // expandedSections here registers the rune as a dep.
    void expandedSections;
    // RAF-defer to let CSS transitions land their endpoint values before
    // we measure — Svelte Flow uses getBoundingClientRect, which sees
    // mid-transition values. Two RAFs gives the panel enough time to
    // reach its final geometry without making the cable-route feel laggy.
    let f1 = 0;
    let f2 = 0;
    f1 = requestAnimationFrame(() => {
      f2 = requestAnimationFrame(() => {
        updateNodeInternals(nodeId);
      });
    });
    return () => {
      cancelAnimationFrame(f1);
      cancelAnimationFrame(f2);
    };
  });

  // When the panel fully closes, reset the active corner back to
  // topLeft so the closed-state CSS (which collapses every handle to
  // the panel's top-left interior — PR-78's cable-anchor invariant)
  // resolves against the topLeft trigger position. Without this, a
  // panel that was last opened from the right would keep its
  // .anchor-right class while closed, parking the closed-state
  // handles under the right trigger and breaking output-cable visual
  // termination at the top-left affordance.
  $effect(() => {
    if (!open) {
      triggerCorner = 'topLeft';
    }
  });

  // ---------------- Click-to-expand nested sections ----------------
  //
  // For sectioned modules (RIOTGIRLS, MIXMSTRS) the inputs column would
  // otherwise overflow even a 1366×768 viewport. By default, collapse
  // every section to its header row + a port-count badge; the user clicks
  // a header to fan out that section's handles inline. Multiple sections
  // can be open at once (the top-level decision is "what voices am I
  // patching right now?" — usually a few, not all).
  //
  // CRITICAL: Handle elements stay in the DOM under collapsed sections —
  // io-spec-consistency e2e walks `.svelte-flow__handle[data-handleid]`
  // via `count()` + `getAttribute()`, both of which work on hidden
  // descendants. The collapsed-section CSS (see .section-rows-collapsed
  // below) pulls the <ul> out of layout flow with position:absolute +
  // visibility:hidden + height:0, NOT display:none — display:none would
  // zero out getBoundingClientRect on the inner Handle elements and
  // break Svelte Flow's handle-bounds cache. Svelte's {#each} block
  // still renders the Handle children either way so their
  // data-handleid attributes are reachable for the spec test.
  //
  // State persistence: kept in a local rune. When the panel closes we
  // wipe it so the next hover-open starts every section collapsed —
  // "fresh hover starts collapsed reduces stale state confusion" per
  // the spec. Pinned panels retain their expanded state until they
  // close (the rune isn't cleared while `open` stays true).
  let expandedSections = $state<Record<string, boolean>>({});

  function isSectionExpanded(label: string): boolean {
    return expandedSections[label] === true;
  }

  function toggleSection(label: string) {
    expandedSections = {
      ...expandedSections,
      [label]: !expandedSections[label],
    };
  }

  $effect(() => {
    if (!open) {
      expandedSections = {};
    }
  });

  // ---------------- Drag-time expand-all for nested sections ----------------
  //
  // When a connect-drag becomes active and this panel is open, auto-
  // expand every section so the user sees every possible target at
  // once. We snapshot the pre-drag expandedSections map and restore it
  // when the drag ends — sections the user manually expanded before
  // the drag stay open; everything else reverts to collapsed.
  //
  // This replaces the earlier hover-based per-section auto-expand:
  // expanding all sections has the same UX intent ("show me where this
  // cable can go") without depending on hover-detection through
  // xyflow's pointer-capture + connection-line overlay (which behaved
  // inconsistently between local + headless Chromium on CI).
  let preDragExpandedSnapshot: Record<string, boolean> | null = null;

  // Recursively walk a section tree and mark every node + descendant as
  // expanded. Today's sectioned modules are single-level — every entry
  // in `sections` is a leaf — but the recursion keeps the contract
  // intact if a future card opts into nested sub-sections.
  function expandSectionAndChildren(s: SectionedGroup, into: Record<string, boolean>): void {
    if ((s.inputs && s.inputs.length > 0) || (s.outputs && s.outputs.length > 0)) {
      into[s.label] = true;
    }
    if (s.subsections && s.subsections.length > 0) {
      for (const child of s.subsections) {
        expandSectionAndChildren(child, into);
      }
      into[s.label] = true;
    }
  }

  $effect(() => {
    const dragActive = connectDragState.active;
    const isOpen = open;
    if (dragActive && isOpen && preDragExpandedSnapshot === null) {
      preDragExpandedSnapshot = { ...expandedSections };
      if (groupingStrategy === 'sectioned' && sections.length > 0) {
        const next: Record<string, boolean> = { ...expandedSections };
        for (const s of sections) {
          expandSectionAndChildren(s, next);
        }
        expandedSections = next;
      }
    } else if (!dragActive && preDragExpandedSnapshot !== null) {
      const snapshot = preDragExpandedSnapshot;
      preDragExpandedSnapshot = null;
      if (isOpen) {
        expandedSections = { ...snapshot };
      }
    }
  });

  // ---------------- Group/sort port lists ----------------

  let inputGroups = $derived<GroupedPorts[]>(
    groupingStrategy === 'auto' ? groupPortsByCableType(inputs, 'input') : [],
  );
  let outputGroups = $derived<GroupedPorts[]>(
    groupingStrategy === 'auto' ? groupPortsByCableType(outputs, 'output') : [],
  );

  function cableColorVar(cable: string | undefined): string {
    if (!cable) return 'var(--cable-audio)';
    return `var(--cable-${cable})`;
  }
</script>

<div
  class="patch-panel-host"
  data-patch-panel-node={nodeId}
>
  <!--
    Two trigger affordances — top-left + top-right — both open the SAME
    panel, share state, and obey the same hover-intent rules. Per user
    feedback ("UI roll up looks great, but lets make another area in the
    upper right of each module that opens the same panel"), the right
    side gives a more natural reach when the user's already on that side
    of a card (e.g. dragging an OUTPUT cable from the right edge of a
    module). Both triggers are kept identical structurally so screen
    readers announce them the same way.
  -->
  <button
    class="patch-trigger left"
    type="button"
    data-testid="patch-trigger"
    aria-label="Open patch panel"
    aria-expanded={open}
    onclick={() => onTriggerClick('topLeft')}
  >
    <!-- Plug glyph — two short verticals + a horizontal stem. CSS-only. -->
    <span class="trigger-glyph" aria-hidden="true">
      <span class="prong"></span>
      <span class="prong"></span>
      <span class="stem"></span>
    </span>
  </button>
  <button
    class="patch-trigger right"
    type="button"
    data-testid="patch-trigger-right"
    aria-label="Open patch panel"
    aria-expanded={open}
    onclick={() => onTriggerClick('topRight')}
  >
    <span class="trigger-glyph" aria-hidden="true">
      <span class="prong"></span>
      <span class="prong"></span>
      <span class="stem"></span>
    </span>
  </button>

  <div
    class="patch-panel"
    class:open
    class:two-col={visibleColumnCount === 2}
    class:one-col={visibleColumnCount === 1}
    class:anchor-left={triggerCorner === 'topLeft'}
    class:anchor-right={triggerCorner === 'topRight'}
    style:width="{panelWidth}px"
    data-testid="patch-panel"
    data-anchor-corner={triggerCorner}
    aria-hidden={!open}
    onpointerdown={onPanelPointerDown}
    role="group"
  >
    <!--
      Open-state layout is a 2-column grid so dense modules
      (MIXMSTRS 49 inputs, RIOTGIRLS 55 inputs) fit on a typical
      laptop viewport. Inputs always render in the left column,
      outputs in the right column. The panel itself scrolls vertically
      when the dense column overflows max-height (per-column scroll
      would clip handles — see .panel-col CSS for the rationale).
      Sectioned grouping (RIOTGIRLS) keeps sections stacked WITHIN the
      inputs column; outputs from any section fall into the single
      right column.

      When a module has only inputs (AudioOut) or only outputs, the
      panel collapses to a single visible column to avoid rendering a
      blank grid track.
    -->
    <div class="panel-grid">
      {#if hasInputs}
      <div class="panel-col panel-col-inputs" data-testid="patch-panel-inputs">
        {#if groupingStrategy === 'sectioned'}
          {#each sections as section, sIdx (section.label + '-' + sIdx)}
            {#if section.inputs && section.inputs.length > 0}
              {@const expanded = isSectionExpanded(section.label)}
              <section
                class="panel-section sectioned"
                class:section-expanded={expanded}
                class:section-collapsed={!expanded}
                data-testid="patch-panel-section"
                data-section-label={section.label}
                data-section-expanded={expanded ? 'true' : 'false'}
              >
                <!--
                  Header is a real <button> so keyboard users get
                  Enter/Space activation for free. The disclosure
                  triangle + port-count badge live inside the button
                  so the whole row is one click target. Stop
                  propagation so the click doesn't bubble out to the
                  panel's pointerdown drag-guard (which would
                  otherwise treat the click as a connect-drag start
                  attempt on the surrounding panel surface).
                -->
                <button
                  type="button"
                  class="section-toggle section-title"
                  data-testid="patch-panel-section-toggle"
                  data-section-label={section.label}
                  aria-expanded={expanded}
                  aria-controls="section-{nodeId}-{sIdx}"
                  onclick={(e) => {
                    e.stopPropagation();
                    toggleSection(section.label);
                  }}
                >
                  <span class="disclosure" aria-hidden="true">{expanded ? '▼' : '▶'}</span>
                  <span class="section-toggle-label">{section.label}</span>
                  <span class="section-count" aria-label="{section.inputs.length} ports">
                    ({section.inputs.length})
                  </span>
                </button>
                <!--
                  IMPORTANT: <ul> stays in the DOM unconditionally
                  (no {#if}) so the Handle elements inside it remain
                  attached. io-spec-consistency e2e + Svelte Flow's
                  internal node-handles bookkeeping both rely on
                  data-handleid being present even when the section
                  is collapsed. CSS in .section-rows-collapsed
                  hides the <ul> via position:absolute + visibility:
                  hidden + height:0 (NOT display:none, which would
                  zero out the inner Handle bounding boxes and break
                  Svelte Flow's handle-bounds cache).
                -->
                <ul
                  id="section-{nodeId}-{sIdx}"
                  class="row-list section-rows"
                  class:section-rows-collapsed={!expanded}
                >
                  {#each section.inputs as port (port.id)}
                    <li class="panel-row" style:--row-cable={cableColorVar(port.cable)}>
                      <span class="row-stripe" aria-hidden="true"></span>
                      <span class="row-label" data-testid="port-row-label">
                        {resolveVerboseLabel(port)}
                      </span>
                      <Handle
                        type="target"
                        position={Position.Left}
                        id={port.id}
                        style={`--handle-color: ${cableColorVar(port.cable)};`}
                      />
                    </li>
                  {/each}
                </ul>
              </section>
            {/if}
          {/each}
        {:else if inputGroups.length > 0}
          <section class="panel-section">
            <h3 class="section-title">Inputs</h3>
            {#each inputGroups as group (group.cable)}
              <h4 class="subgroup-title">{group.label}</h4>
              <ul class="row-list">
                {#each group.ports as port (port.id)}
                  <li class="panel-row" style:--row-cable={cableColorVar(port.cable)}>
                    <span class="row-stripe" aria-hidden="true"></span>
                    <span class="row-label" data-testid="port-row-label">
                      {resolveVerboseLabel(port)}
                    </span>
                    <Handle
                      type="target"
                      position={Position.Left}
                      id={port.id}
                      style={`--handle-color: ${cableColorVar(port.cable)};`}
                    />
                  </li>
                {/each}
              </ul>
            {/each}
          </section>
        {/if}
      </div>
      {/if}

      {#if hasOutputs}
      <div class="panel-col panel-col-outputs" data-testid="patch-panel-outputs">
        {#if groupingStrategy === 'sectioned'}
          {#if sectionedOutputs.length > 0}
            <section class="panel-section">
              <h3 class="section-title">Outputs</h3>
              {#each sectionedOutputs as entry (entry.sectionLabel)}
                {#if sectionedOutputs.length > 1}
                  <h4 class="subgroup-title">{entry.sectionLabel}</h4>
                {/if}
                <ul class="row-list">
                  {#each entry.ports as port (port.id)}
                    <li class="panel-row right" style:--row-cable={cableColorVar(port.cable)}>
                      <Handle
                        type="source"
                        position={Position.Right}
                        id={port.id}
                        style={`--handle-color: ${cableColorVar(port.cable)};`}
                      />
                      <span class="row-label right" data-testid="port-row-label">
                        {resolveVerboseLabel(port)}
                      </span>
                      <span class="row-stripe right" aria-hidden="true"></span>
                    </li>
                  {/each}
                </ul>
              {/each}
            </section>
          {/if}
        {:else if outputGroups.length > 0}
          <section class="panel-section">
            <h3 class="section-title">Outputs</h3>
            {#each outputGroups as group (group.cable)}
              <h4 class="subgroup-title">{group.label}</h4>
              <ul class="row-list">
                {#each group.ports as port (port.id)}
                  <li class="panel-row right" style:--row-cable={cableColorVar(port.cable)}>
                    <Handle
                      type="source"
                      position={Position.Right}
                      id={port.id}
                      style={`--handle-color: ${cableColorVar(port.cable)};`}
                    />
                    <span class="row-label right" data-testid="port-row-label">
                      {resolveVerboseLabel(port)}
                    </span>
                    <span class="row-stripe right" aria-hidden="true"></span>
                  </li>
                {/each}
              </ul>
            {/each}
          </section>
        {/if}
      </div>
      {/if}
    </div>
  </div>

  {@render children?.()}
</div>

<style>
  .patch-panel-host {
    /* Wraps the affordance + popover + the card's main content slot. The
     * host is `display: contents` so it doesn't add an extra box around
     * the card body — the card's existing layout (faders, knobs) sits
     * directly inside .mod-card without disturbance. */
    display: contents;
  }

  /* ---------------- Trigger affordance (top-left + top-right) ---------------- */

  .patch-trigger {
    position: absolute;
    top: 4px;
    width: 18px;
    height: 18px;
    /* Skin-aware: --module-bg-deep is the lifted version of the literal
     * `rgba(20, 23, 28, 0.85)` (close enough — both are "darker than the
     * card body"); --border is the lifted `#2a2f3a`. Default skin keeps
     * the visual identical; non-default skins recolour both. */
    background: var(--module-bg-deep);
    border: 1px solid var(--border);
    border-radius: 2px;
    padding: 0;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    z-index: 6;
    transition: border-color 80ms ease-out, background 80ms ease-out;
  }
  .patch-trigger.left {
    left: 4px;
  }
  .patch-trigger.right {
    right: 4px;
  }
  .patch-trigger:hover,
  .patch-trigger[aria-expanded='true'] {
    border-color: var(--accent);
    background: rgba(0, 240, 255, 0.08);
  }
  .patch-trigger:focus-visible {
    outline: 1px solid var(--accent);
    outline-offset: 1px;
  }
  .trigger-glyph {
    position: relative;
    width: 12px;
    height: 12px;
    display: inline-block;
  }
  .trigger-glyph .prong {
    position: absolute;
    top: 1px;
    width: 2px;
    height: 5px;
    background: var(--cable-audio);
    border-radius: 1px;
  }
  .trigger-glyph .prong:nth-child(1) {
    left: 3px;
  }
  .trigger-glyph .prong:nth-child(2) {
    left: 7px;
  }
  .trigger-glyph .stem {
    position: absolute;
    bottom: 1px;
    left: 4px;
    width: 4px;
    height: 6px;
    background: var(--cable-audio);
    border-radius: 1px;
  }

  /* ---------------- Popover panel ---------------- */

  .patch-panel {
    position: absolute;
    top: 28px;
    /* Default anchor: top-left corner. Overridden by .anchor-right
     * below when the user opened the panel via the top-right trigger.
     * Either way the panel pops down from beneath the trigger that
     * fired; the panel content (input/output 2-col grid) is unchanged. */
    left: 4px;
    background: rgba(14, 17, 22, 0.97);
    border: 1px solid var(--accent-dim);
    border-radius: 3px;
    color: var(--text);
    box-shadow: 0 4px 18px rgba(0, 0, 0, 0.6);
    padding: 8px 10px 10px;
    /* Closed state: hide visually but keep handles in DOM (I/O spec test
     * needs to find them). Opacity + pointer-events keeps the geometry
     * intact for getBoundingClientRect; transform pulls the visual
     * panel offscreen so it doesn't intercept hover. */
    opacity: 0;
    pointer-events: none;
    transform: translateX(-8px);
    transition: opacity 120ms ease-out, transform 120ms ease-out;
    max-height: 70vh;
    /* Cap at 80vw on smaller viewports so the popover stays onscreen. */
    max-width: 80vw;
    /* Panel-level vertical scroll. The handle dots (12x12, positioned
     * at -7px / +5px from .panel-row's leading/trailing edge) sit
     * within the panel's 10px padding, so the panel's content-box
     * comfortably contains them and the auto scrollbar doesn't clip.
     * (Per CSS spec, `overflow-y: auto` is effectively `overflow: auto`
     * — so per-column scrolling would clip the handles instead.) */
    overflow-y: auto;
    z-index: 10;
  }
  /* Anchor variants — pick which corner of the card the popover
   * pops down from. The topRight variant clears `left` and pins to
   * `right: 4px` so the panel's right edge sits under the right
   * trigger and the panel grows leftward. */
  .patch-panel.anchor-left {
    left: 4px;
    right: auto;
    transform: translateX(-8px);
  }
  .patch-panel.anchor-right {
    left: auto;
    right: 4px;
    transform: translateX(8px);
  }
  .patch-panel.open {
    opacity: 1;
    pointer-events: auto;
    transform: translateX(0);
  }

  /* ---------------- Two-column grid (open state) ---------------- */
  /*
   * Inputs left, outputs right. The dense column (usually inputs)
   * drives panel height; the panel scrolls vertically when content
   * overflows. Per-column scroll would clip the handle dots that sit
   * at left:-7px / right:-7px on each row (CSS spec: any axis !=
   * visible promotes the other axis to auto). Dense modules (MIXMSTRS
   * 49 inputs / RIOTGIRLS 55 inputs) get their full label width and a
   * scroll bar inside the panel; the panel's max-height keeps it
   * onscreen.
   */
  .panel-grid {
    display: grid;
    gap: 12px;
    /* Width tracks the inline style:width on .patch-panel so the grid
     * never grows past the viewport cap (max-width: 80vw on the panel
     * trims the rendered width on small screens). The panel itself
     * owns the vertical scroll — the grid stretches to whatever its
     * content needs and the panel scrolls when needed. */
    width: 100%;
  }
  .patch-panel.two-col .panel-grid {
    grid-template-columns: 1fr 1fr;
  }
  .patch-panel.one-col .panel-grid {
    grid-template-columns: 1fr;
  }
  .panel-col {
    display: flex;
    flex-direction: column;
    /* IMPORTANT: columns must NOT clip overflow. Output handles are
     * positioned at `right: -7px` relative to .panel-row, which puts
     * them past the column's right edge. CSS treats `overflow-y: auto`
     * + `overflow-x: visible` as `overflow: auto` (per spec), so a
     * scrolling column would clip the handles and break xyflow's
     * connect-drag hit-testing on neighbouring modules. The PANEL
     * itself owns the vertical scroll instead (overflow-y: auto on
     * .patch-panel). The dense column (usually inputs) drives the
     * scroll height; the shorter column (usually outputs) sits at the
     * top and is short enough to never need scrolling. */
    min-width: 0;
    min-height: 0;
  }

  .panel-section + .panel-section {
    margin-top: 10px;
    padding-top: 8px;
    /* Skin-aware divider; lifted from the literal #1f242c. */
    border-top: 1px solid var(--divider);
  }
  .section-title {
    font-size: 0.65rem;
    font-weight: 600;
    color: var(--text);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin: 0 0 4px;
    position: sticky;
    /* Sticky pins to the panel's scrollport. -8px offsets the panel's
     * 8px top padding so the title hugs the panel's top edge as the
     * user scrolls a long inputs column. */
    top: -8px;
    background: rgba(14, 17, 22, 0.97);
    padding-top: 4px;
    padding-bottom: 2px;
    z-index: 1;
  }
  .subgroup-title {
    font-size: 0.55rem;
    font-weight: 500;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin: 6px 0 2px;
  }
  .row-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  /* ---------------- Click-to-expand section header (sectioned only) ---------------- */
  /*
   * Replaces the flat <h3 class="section-title"> for sectioned-grouping
   * modules (RIOTGIRLS, MIXMSTRS) with a clickable button row. Default
   * state hides every section's port list — the user clicks a header
   * to fan out that section's handles inline. Multiple sections can be
   * expanded simultaneously.
   *
   * Sticky-pin matches the original .section-title behaviour so the
   * header stays visible as the user scrolls a long expanded section.
   */
  .section-toggle {
    /* Reset native <button>. */
    appearance: none;
    background: rgba(14, 17, 22, 0.97);
    border: none;
    border-radius: 2px;
    color: var(--text);
    cursor: pointer;
    font: inherit;
    padding: 4px 6px 3px;
    margin: 0 0 2px;
    width: 100%;
    text-align: left;
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.65rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    /* Sticky-pin to the panel's scrollport (matches .section-title's
     * -8px offset against the panel's 8px top padding). */
    position: sticky;
    top: -8px;
    z-index: 1;
    transition: background 80ms ease-out;
  }
  .section-toggle:hover {
    background: rgba(0, 240, 255, 0.06);
  }
  .section-toggle:focus-visible {
    outline: 1px solid var(--accent);
    outline-offset: 1px;
  }
  .section-toggle .disclosure {
    display: inline-block;
    width: 0.7em;
    color: var(--text-dim);
    /* Fixed-width so the label doesn't shift when the glyph swaps. */
    text-align: center;
  }
  .section-toggle-label {
    flex: 1;
  }
  .section-count {
    color: var(--text-dim);
    font-weight: 400;
    /* Tabular figures keep the badge aligned across sections with
     * different port counts (e.g. RIOTGIRLS V1=10 vs Master=12). */
    font-variant-numeric: tabular-nums;
  }

  /* Collapsed-section row list: the <ul> + every <li> inside it must
   * collapse to zero visible height, but the <Handle> elements need
   * to remain in the DOM AND have a sensible bounding box so any
   * already-connected cables route to the section header (instead of
   * (0, 0) in the page) and Svelte Flow's handle-bounds book-keeping
   * stays consistent. We achieve this by:
   *
   *   * pulling the <ul> out of layout flow with `position: absolute`
   *     so it contributes 0px to the inputs column's flow height;
   *   * pinning it to (0, 0) of the .panel-section so its inner
   *     handles inherit the section header's screen position;
   *   * hiding it visually with visibility:hidden + pointer-events:
   *     none (NOT display:none, which would zero out
   *     getBoundingClientRect and break Svelte Flow's bounds cache).
   *
   * The Handle children stay in the DOM with their data-handleid
   * attributes, so io-spec-consistency.spec.ts continues to find
   * them by id, and any pre-existing cables route to the collapsed
   * section's header coordinate (a sane "this port lives here, the
   * user has hidden it" visual). Click the section open and the
   * <ul> reverts to its in-flow position; cables re-route via the
   * RAF-deferred updateNodeInternals call above.
   */
  .panel-section.sectioned {
    /* Anchor for the collapsed-state absolute <ul> child. */
    position: relative;
  }
  .section-rows.section-rows-collapsed {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    visibility: hidden;
    pointer-events: none;
    /* Keep height at 0 so the absolute box doesn't visually overlap
     * the next section's header. The handles inside still expose a
     * real (degenerate) bounding box at the header coordinate. */
    height: 0;
    overflow: hidden;
  }

  /* ---------------- Panel rows ---------------- */
  /*
   * Each row is `position: relative` so the absolutely-positioned Handle
   * inside it lands at the row's leading or trailing edge. Row layout is
   * a flex line with [stripe | label | handle] for inputs and
   * [handle | label | stripe] for outputs.
   */
  .panel-row {
    position: relative;
    display: flex;
    align-items: center;
    height: 22px;
    padding: 0 16px 0 12px;
    font-size: 0.7rem;
    font-family: ui-monospace, monospace;
    color: var(--text);
  }
  .panel-row.right {
    padding: 0 12px 0 16px;
    justify-content: flex-end;
  }
  .panel-row .row-stripe {
    position: absolute;
    left: 0;
    top: 4px;
    bottom: 4px;
    width: 3px;
    border-radius: 1px;
    background: var(--row-cable, var(--cable-audio));
  }
  .panel-row .row-stripe.right {
    left: auto;
    right: 0;
  }
  .panel-row .row-label {
    flex: 1;
    text-align: left;
  }
  .panel-row .row-label.right {
    text-align: right;
  }

  /* ---------------- Handle positioning ---------------- */
  /*
   * Default xyflow handle styling (in routes/global.css) is a 12x12 ringed
   * dot. Inside our panel rows, the handle anchors so its visible centre
   * sits AT the panel's outer border line — half outside the panel chrome
   * (where the cable terminates without occlusion) and half inside (where
   * it visually associates with its label row).
   *
   * Why straddle the border instead of nesting the handle deep inside the
   * panel? Cable edges paint as a single SVG layer at the SvelteFlow
   * viewport level. The open-state panel chrome (rgba(14,17,22,0.97)
   * background + 1px border) sits ABOVE that layer (z-index:10 plus the
   * :has(.patch-panel.open) lift to z-index:1000 on the host node), so
   * any cable approach that lands inside the panel's bounding box gets
   * occluded by the chrome — the user sees cables "stop at the panel
   * border" instead of plugging into the visible ○ ring icons (the
   * handles).
   *
   * Geometry math:
   *   .patch-panel padding = 8px 10px 10px (left padding = 10px)
   *   .panel-row.left = .patch-panel.left + 10
   *   handle width = 12px → half-width = 6px
   *   For input handle CENTRE to land at .patch-panel.left:
   *     handle.left_offset (relative to panel-row) = -16
   *     (= -10 to back out the panel padding, -6 to half-out the dot)
   *   For output handle (mirror), same offset on the right side:
   *     handle.right_offset (relative to panel-row) = -16
   *
   * Result: every cable now visibly continues from the panel border
   * inward to the centre of the ring icon, then stops cleanly at the
   * dot. Eurorack-style "jacks on the front panel" affordance.
   */
  .patch-panel .panel-row :global(.svelte-flow__handle) {
    position: absolute !important;
    top: 50% !important;
    transform: translateY(-50%);
    /* Lift handle DOM above the panel chrome so the visible ring
     * (and its border) renders on top of the panel background, not
     * underneath it. Keeps the whole ○ visible whether the centre
     * sits half-on/half-off the border. */
    z-index: 11 !important;
  }
  .patch-panel .panel-row :global(.svelte-flow__handle.target),
  .patch-panel .panel-row:not(.right) :global(.svelte-flow__handle) {
    left: -16px !important;
    right: auto !important;
  }
  .patch-panel .panel-row.right :global(.svelte-flow__handle),
  .patch-panel .panel-row :global(.svelte-flow__handle.source) {
    left: auto !important;
    right: -16px !important;
  }

  /* ---------------- Collapsed-state handle stacking ---------------- */
  /*
   * When the panel is closed, ALL handles inside it — inputs AND outputs
   * — must collapse to the SAME on-screen point: the top-left affordance
   * corner of the card. Cables follow handle positions natively, so this
   * is what makes every closed cable visually terminate at the trigger.
   *
   * The trick: when closed, drop `position: relative` on .panel-row so
   * the absolutely-positioned handle resolves against .patch-panel
   * itself (which sits at top:28px;left:4px of the card). Then a single
   * pair of absolute top/left values lifts every handle up to the card
   * top-left, regardless of which row it lives in or whether the row
   * is .right (output) or default (input).
   *
   * Without this, handles instead anchored at each row's top-left —
   * which for inputs landed near (but not on) the affordance, and for
   * outputs/long panels landed hundreds of px down/right (so output
   * cables visually traced back to the wrong side of the card).
   *
   * Specificity hack: we need higher specificity than every open-state
   * positioning rule above. The open-state output rule combines BOTH
   * `.panel-row.right .svelte-flow__handle` AND
   * `.panel-row .svelte-flow__handle.source` — so we double both
   * `.patch-panel` AND `.panel-row` to win against either selector for
   * either handle type. pointer-events:none stops a stray click on the
   * stack of invisible handles from starting a connect-drag.
   */
  .patch-panel.patch-panel:not(.open) .panel-row.panel-row {
    position: static;
  }
  .patch-panel.patch-panel:not(.open) .panel-row.panel-row :global(.svelte-flow__handle) {
    position: absolute !important;
    /* Lift the handle from the panel's interior up to the card's top-
     * left corner. The panel's box top-edge sits at card y=28px; the
     * trigger sits at card y=4px and is 18px tall. -22px puts the
     * handle's top edge at card y=6px, which is on top of the trigger
     * (and therefore the visual cable terminus the user sees). */
    top: -22px !important;
    left: 0 !important;
    right: auto !important;
    bottom: auto !important;
    transform: none !important;
    opacity: 0 !important;
    pointer-events: none !important;
  }
</style>
