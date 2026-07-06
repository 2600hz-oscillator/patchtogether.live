<script lang="ts">
  // Redesigned patch panel — every module card hosts one.
  //
  // THE MODEL (see .myrobots / patch-menu-redesign UX spec items 1–5):
  //
  //   * Default state: two small "patch" affordances (top-LEFT + top-RIGHT)
  //     on the card. Every <Handle> declared on the module def is rendered
  //     here in the card DOM, stacked at the top-left affordance corner with
  //     opacity:0 + pointer-events:none. So all cables anchor at the corner
  //     AND the per-module-per-port handle-presence sweep (which counts
  //     `.svelte-flow__handle[data-handleid]` with the panel CLOSED) still
  //     finds every handle. This handle stack NEVER moves out of the card.
  //
  //   * CHROME is PORTALED to <body> via use:portal + position:fixed. The
  //     fixed coords come from computeEdgeAlignedRect so the menu's anchored
  //     edge aligns to the matching card edge (left trigger → menu LEFT edge
  //     at card LEFT edge; right trigger → menu RIGHT edge at card RIGHT
  //     edge) and never spills past that side. Portaling escapes the
  //     SvelteFlow viewport transform so position:fixed resolves against the
  //     real viewport.
  //
  //   * The chrome is an OVERLAY-REPLACE stack driven by the pure reducer in
  //     patch-menu-state.ts. Root view shows INPUT / OUTPUT (+ section rows
  //     for sectioned mega-modules). Clicking one REPLACES the view in place
  //     (parent hides; nothing stacks side-by-side); a back affordance
  //     returns to root. Drill-in is by CLICK.
  //
  //   * Left-clicking a port ROW = "jack click" (UX item 4): it begins a
  //     pickup (a cable dangles from the cursor) AND keeps the menu open
  //     with a "patch to" entry. The actual <Handle> dots also still
  //     emit click-connect via xyflow, so either affordance works; the row
  //     is the discoverable one. Clicking "patch to" hides the dangling
  //     cable + shows the patch-to picker (target module → target port);
  //     a VALID pick commits the patch, INVALID discards silently.
  //
  //   * NO DRAGGING anywhere in this flow. The click-and-hold-to-open
  //     gesture is RETIRED (see Canvas.svelte).
  //
  //   * GATE-INPUT MIDI ASSIGN (from #735): every gate/trigger INPUT row is
  //     right-clickable to bind a MIDI NOTE (NOTE-on → gate high, off → low)
  //     via PatchEngine.setGateInput. Re-applied onto the overlay-replace
  //     rows below.
  //
  // The reducer (PatchMenuState) is the single source of truth for "what is
  // the menu showing + is a cable in flight?"; this component renders it and
  // feeds it transition events. The carry/pickup lifecycle itself lives in
  // connectDragState (shared singleton) + Canvas (which owns the commit).
  import { onDestroy, untrack } from 'svelte';
  import { Handle, Position, useStore } from '@xyflow/svelte';
  import {
    resolveVerboseLabel,
    groupPortsByCableType,
    type GroupedPorts,
    type PortDescriptor,
  } from '$lib/ui/patch-panel-labels';
  import { connectDragState } from '$lib/ui/connect-drag-state.svelte';
  import {
    CLOSED,
    openFromTrigger,
    openFromJack,
    drillInto,
    back as backReducer,
    esc as escReducer,
    type PatchMenuState,
    type PatchMenuView,
  } from '$lib/ui/patch-menu-state';
  import { computeEdgeAlignedRect, type Rect, type Viewport } from '$lib/ui/patch-menu-position';
  import ControlContextMenu from '$lib/ui/controls/ControlContextMenu.svelte';
  import { makeMidiAssignable } from '$lib/ui/controls/midi-assignable.svelte';
  import {
    registerGateSetter,
    unregisterGateSetter,
    getBinding,
    bindingsRune,
  } from '$lib/midi/midi-learn.svelte';
  import { getActiveEngine } from '$lib/audio/engine-ref';
  import { patch } from '$lib/graph/store';
  import { nodeVersion, edgesVersion, nodesStructuralVersion } from '$lib/graph/node-versions.svelte';
  import { getModuleDef } from '$lib/audio/module-registry';
  import { getVideoModuleDef } from '$lib/video/module-registry';
  import { getMetaModuleDef } from '$lib/meta/module-registry';
  import { buildDocIndexFromDef } from '$lib/docs/doc-index-from-def';
  import AnnotateLayer from '$lib/ui/AnnotateLayer.svelte';
  import { portConnections } from '$lib/ui/port-patch-helpers';
  import type { ModuleNode } from '$lib/graph/types';
  import type { Snippet } from 'svelte';

  interface SectionedGroup {
    label: string;
    inputs?: PortDescriptor[];
    outputs?: PortDescriptor[];
    /** Optional nested sub-sections (recursive). No card uses this today;
     *  kept so future 2-level layouts opt in without re-discovering it. */
    subsections?: SectionedGroup[];
  }

  interface Props {
    nodeId: string;
    inputs?: PortDescriptor[];
    outputs?: PortDescriptor[];
    groupingStrategy?: 'auto' | 'sectioned';
    sections?: SectionedGroup[];
    /** CSS width of the OPEN portaled chrome (default 280). Dense
     *  sectioned modules pass a wider value so verbose labels fit. */
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

  // ---------------- Menu state (overlay-replace reducer) ----------------
  //
  // One reducer state per panel. Open = the portaled chrome is up; view =
  // the overlay-replace level; side = which card edge it edge-aligns to.
  let menu = $state<PatchMenuState>(CLOSED);

  // The cascade-lock from connectDragState keeps the SOURCE panel logically
  // "in flight" while a carry/patch-to picker is up for one of its ports.
  let cascadeLockEngaged = $derived(connectDragState.cascadeActiveForPanel === nodeId);

  // `open` = the menu reducer says open. (No more hover/drag/hold drivers —
  // the panel is purely click-driven now per the redesign.)
  let open = $derived(menu.open);
  let view = $derived<PatchMenuView>(menu.view);

  // ---------------- Port lists ----------------
  let inputGroups = $derived<GroupedPorts[]>(
    groupingStrategy === 'auto' ? groupPortsByCableType(inputs, 'input') : [],
  );
  let outputGroups = $derived<GroupedPorts[]>(
    groupingStrategy === 'auto' ? groupPortsByCableType(outputs, 'output') : [],
  );

  // Flat input/output lists across sections (for the all-inputs / all-outputs
  // drill views on sectioned cards, and for the per-handle render stack).
  let allInputs = $derived<PortDescriptor[]>(
    groupingStrategy === 'sectioned'
      ? sections.flatMap((s) => s.inputs ?? [])
      : inputs,
  );
  let allOutputs = $derived<PortDescriptor[]>(
    groupingStrategy === 'sectioned'
      ? sections.flatMap((s) => s.outputs ?? [])
      : outputs,
  );

  let hasInputs = $derived(allInputs.length > 0);
  let hasOutputs = $derived(allOutputs.length > 0);

  // Sections that actually carry input ports — the nav rows shown at root
  // for sectioned cards.
  let inputSections = $derived<SectionedGroup[]>(
    groupingStrategy === 'sectioned'
      ? sections.filter((s) => (s.inputs?.length ?? 0) > 0)
      : [],
  );

  function sectionByLabel(label: string): SectionedGroup | undefined {
    return sections.find((s) => s.label === label);
  }

  function cableColorVar(cable: string | undefined): string {
    if (!cable) return 'var(--cable-audio)';
    return `var(--cable-${cable})`;
  }

  // ---------------- Live patch status (jack indicator + hover overlay) -------
  //
  // Each port row shows a filled circle when an edge connects to it, else a
  // hollow ring; hovering a patched circle surfaces the remote endpoint(s) via
  // the native `title` attribute (robust in the portaled, scrollable menu).
  // We re-derive on every Yjs update — the SAME cardVersion pump MatrixMixCard
  // / CONTROL SURFACE / GROUP use — so the indicator reflects patches made
  // ANYWHERE (drag-connect, this menu, a collaborator) in real time.
  // Scoped re-derive (phase-2 CC perf fix): the panel's consumers read the
  // edge set (jack indicators), OWN-node name/type (back title, annotate
  // index) and node add/remove — NOT the whole doc. PatchPanel mounts once
  // per card (the rear-view back panel), so the old whole-doc pump made
  // every card's panel re-derive on every CC settle commit.
  let edgeVersion = $derived(edgesVersion() + nodesStructuralVersion() + nodeVersion(nodeId));

  // Any-domain def lookup — the SAME chain validate-edge / persistence /
  // MATRIXMIX use, so remote module names match everywhere.
  function defLookup(type: string) {
    return getModuleDef(type) ?? getVideoModuleDef(type) ?? getMetaModuleDef(type);
  }

  let connections = $derived.by(() => {
    void edgeVersion; // re-run on every edge change
    // Rename-liveness: ALSO subscribe to each connected REMOTE endpoint's
    // node version — portConnections bakes remote module NAMES into its
    // hover strings, and a remote rename is a node-subtree write that
    // bumps neither the edges nor the structural counters. The edge scan
    // re-runs (and re-subscribes) whenever the edge set changes.
    for (const e of Object.values(patch.edges)) {
      if (!e?.source || !e?.target) continue;
      if (e.source.nodeId === nodeId) void nodeVersion(e.target.nodeId);
      else if (e.target.nodeId === nodeId) void nodeVersion(e.source.nodeId);
    }
    return portConnections(
      patch.edges,
      nodeId,
      patch.nodes as Record<string, ModuleNode | undefined>,
      defLookup,
    );
  });

  // ---------------- Rear-view back-panel title (rack Phase 3) ----------------
  //
  // The back panel (revealed by the "Flip rack" toggle, styled in
  // _module-card.css) shows the module's name + its declared jacks. The display
  // name is the same `node.data.name` channel ModuleTitle uses; fall back to the
  // node TYPE (then the nodeId) so a card always reads as *something* from
  // behind. Re-derives on edge changes so renames reflect (cheap; reads the
  // live store node, same pump the jack indicators use).
  let backTitle = $derived.by(() => {
    void edgeVersion;
    const node = patch.nodes[nodeId] as ModuleNode | undefined;
    const name = (node?.data as { name?: unknown } | null | undefined)?.name;
    if (typeof name === 'string' && name.trim().length > 0) return name;
    return node?.type ?? nodeId;
  });

  // ---------------- Annotate mode (authored-doc hover) ----------------
  //
  // Build the flat DocIndex for THIS card's module straight from the live def +
  // its co-located `docs` (reusing the doc-page builder). Null when the module has
  // no authored docs → AnnotateLayer is inert and the right-click "Annotate" entry
  // is hidden. Re-derives on graph change so a duplicated/retyped node stays
  // correct. ANY-DOMAIN: resolve via the same multi-domain `defLookup` this panel
  // already uses, NOT the audio-only getModuleDef — otherwise Annotate is dead on
  // VIDEO modules (bentbox, chroma, …) whose defs live in the video registry even
  // though they carry co-located docs. buildDocIndexFromDef only reads
  // docs/inputs/params/controls (present on video defs too), so the cast is structural.
  let annotateDocIndex = $derived.by(() => {
    void edgeVersion;
    const node = patch.nodes[nodeId] as ModuleNode | undefined;
    if (!node) return null;
    return buildDocIndexFromDef(defLookup(node.type) as Parameters<typeof buildDocIndexFromDef>[0]);
  });

  /** Remote endpoint strings for one port (empty when unpatched). */
  function remotesFor(portId: string, direction: 'input' | 'output'): string[] {
    const map = direction === 'input' ? connections.inputs : connections.outputs;
    return map.get(portId) ?? [];
  }

  function isPatched(portId: string, direction: 'input' | 'output'): boolean {
    return remotesFor(portId, direction).length > 0;
  }

  /** Hover/aria text for a patched jack: INPUT takes one cable (← FROM …);
   *  OUTPUT fans out (→ TO a, b, …). Empty for an unpatched port. */
  function patchTitle(portId: string, direction: 'input' | 'output'): string | undefined {
    const remotes = remotesFor(portId, direction);
    if (remotes.length === 0) return undefined;
    return direction === 'input'
      ? `← FROM ${remotes[0]}`
      : `→ TO ${remotes.join(', ')}`;
  }

  // ---------------- Gate-input MIDI assign (WORKSTREAM B) ----------------
  //
  // EVERY gate/trigger INPUT row (cable === 'gate') is right-clickable to bind a
  // MIDI NOTE. NOTE-on → gate high, NOTE-off → gate low — driven through
  // PatchEngine.setGateInput, which resolves the port's paramTarget and reuses
  // the EXACT same-domain gate-edge mechanism. INPUTS only; outputs aren't
  // assignable. Added here so it covers ALL cards automatically. The binding key
  // is `nodeId:portId` (the same moduleId:paramId convention as knob CC).
  //
  // Each gate port registers a gate setter on mount so a persisted NOTE binding
  // dispatches even when its row isn't the open-menu target. The single
  // ControlContextMenu below handles learn/forget/surface/electra for whichever
  // gate row was right-clicked (tracked by `gatePortId`).
  let allGateInputs = $derived<PortDescriptor[]>(
    (groupingStrategy === 'sectioned'
      ? sections.flatMap((s) => s.inputs ?? [])
      : inputs
    ).filter((p) => p.cable === 'gate'),
  );

  /** Drive a gate input high/low via the live engine (NOTE on/off). */
  function driveGate(portId: string, high: boolean): void {
    getActiveEngine()?.setGateInput(nodeId, portId, high);
  }

  /** Reactive: the persisted MIDI binding for a gate port (or undefined). Read
   *  in the row markup to surface a bound indicator; re-evals when any binding
   *  changes (e.g. an injected NOTE completes a learn). */
  function gateBound(portId: string) {
    void bindingsRune();
    return getBinding(nodeId, portId);
  }

  // Per-gate-port gate setters: (re)registered whenever the gate-port set
  // changes so a loaded binding fires the moment a card mounts. Cleaned up on
  // unmount. Tracks which keys we registered so we can unregister exactly those.
  let registeredGateKeys: string[] = [];
  $effect(() => {
    const ports = allGateInputs;
    untrack(() => {
      for (const k of registeredGateKeys) {
        const portId = k.slice(nodeId.length + 1);
        unregisterGateSetter(nodeId, portId);
      }
      registeredGateKeys = [];
      for (const p of ports) {
        registerGateSetter(nodeId, p.id, { onGate: (h) => driveGate(p.id, h) });
        registeredGateKeys.push(`${nodeId}:${p.id}`);
      }
    });
  });
  onDestroy(() => {
    for (const p of untrack(() => allGateInputs)) unregisterGateSetter(nodeId, p.id);
  });

  // Single shared menu for the currently-right-clicked gate row. paramId tracks
  // the targeted gate port; onGate drives THAT port (closure reads gatePortId).
  let gatePortId = $state('');
  const gateMidi = makeMidiAssignable({
    kind: 'note',
    get moduleId() { return nodeId; },
    get paramId() { return gatePortId || undefined; },
    onGate: (h) => driveGate(gatePortId, h),
  });
  let gateCtxOpen = $state(false);
  let gateCtxX = $state(0);
  let gateCtxY = $state(0);

  function openGateMidiMenu(e: MouseEvent, port: PortDescriptor): void {
    e.preventDefault();
    e.stopPropagation();
    gatePortId = port.id;
    gateMidi.refresh();
    gateCtxX = e.clientX;
    gateCtxY = e.clientY;
    gateCtxOpen = true;
    // Keep THIS panel open underneath the menu via the cascade-lock driver.
    connectDragState.beginCascade(nodeId);
  }
  function closeGateMidiMenu(): void {
    gateCtxOpen = false;
    if (connectDragState.cascadeActiveForPanel === nodeId) connectDragState.endCascade();
  }

  // panelWidth is the TOTAL popover width — preserving the prop's
  // pre-two-column semantics so existing test geometry (handles land
  // near the card edge, not 280px further out) continues to work.
  // The 2-column grid divides this width internally.

  // ---------------- Open / close / drill ----------------
  function openMenu(side: 'left' | 'right') {
    // Toggle: clicking the same-side trigger while already open from that
    // side closes the menu (lets the user dismiss without leaving the card).
    if (menu.open && menu.side === side) {
      closeMenu();
      return;
    }
    menu = openFromTrigger(side);
  }

  function closeMenu() {
    menu = CLOSED;
    // Closing the trigger-menu must not strand a carry started from a row.
    if (connectDragState.mode === 'pickup' && connectDragState.cascadeActiveForPanel === nodeId) {
      connectDragState.discard();
      connectDragState.endCascade();
    }
  }

  function drill(v: PatchMenuView) {
    menu = drillInto(menu, v);
  }

  function goBack() {
    menu = backReducer(menu);
  }

  // ---------------- Jack click (UX item 4) ----------------
  //
  // Clicking a port ROW begins a pickup (cable dangles) AND keeps this
  // panel's menu open with a "patch to" entry. Canvas owns the picker +
  // commit; PatchPanel just signals the begin + flips its own view so the
  // user sees the "patch to" affordance. We dispatch a custom event Canvas
  // listens for (it knows the cable type + commit wiring).
  function onPortRowClick(portId: string, direction: 'input' | 'output') {
    return jackInteract(portId, direction, true);
  }

  // ---------------- Rear-view back-panel jack click (rack Phase 3) ----------
  //
  // In rear view ("Flip rack") the card's FRONT — including the hidden handle
  // stack the front-view chrome drives — is rotated away (backface-visibility),
  // so the only patch surface is the back panel. We make its labelled jacks LIVE
  // patch points that reuse the EXACT SAME carry seam the front-view port rows
  // use (patchpanel:jackclick → carry → patchpanel:carrycommit, owned by
  // Canvas), so a rear-view patch is the SAME validated edge with the SAME port
  // ids as a front-view one. Direct jack-to-jack ("patch on the back like a
  // patchbay"): first click picks up a cable from that jack, the second click on
  // any compatible jack (this card or another) commits it. There is NO drill-down
  // chrome in rear view — the jacks ARE the affordance — so we suppress the menu
  // flip (openMenu=false) and let the dangling ghost cable + jack click stand in.
  function onBackJackClick(portId: string, direction: 'input' | 'output') {
    return jackInteract(portId, direction, false);
  }

  // Shared jack pickup/commit. `openChrome` flips the drill-down menu into carry
  // mode (front view); rear view passes false (jacks-only, no chrome). Both paths
  // dispatch the identical Canvas-owned carry events, so the committed edge is
  // identical regardless of which face the user patched from.
  function jackInteract(portId: string, direction: 'input' | 'output', openChrome: boolean) {
    const host = hostEl;
    if (!host) return;
    // If a cable is ALREADY being carried (from any source port), clicking a
    // port row attempts to COMMIT the carried cable to this port (UX item 5:
    // "click a panel → click submenu → click a valid point = patch made").
    // VALID → patch; INVALID (output→output etc.) → silent discard. Canvas
    // owns the validateEdge gate + the write.
    if (connectDragState.mode === 'pickup') {
      host.dispatchEvent(
        new CustomEvent('patchpanel:carrycommit', {
          bubbles: true,
          detail: { nodeId, portId, direction },
        }),
      );
      if (openChrome) closeMenu();
      return;
    }
    // Otherwise this is a fresh JACK-CLICK (UX item 4): pick up a cable from
    // this port + (front view only) flip our view into carry mode (root, where
    // the "patch to" entry renders) so the user can either steer to a target or
    // use the picker. Rear view skips the chrome — the dangling ghost cable + a
    // second jack click ARE the affordance. Canvas resolves cable type + begins
    // the pickup either way.
    if (openChrome) menu = openFromJack(menu.side);
    host.dispatchEvent(
      new CustomEvent('patchpanel:jackclick', {
        bubbles: true,
        detail: { nodeId, portId, direction, side: menu.side },
      }),
    );
  }

  // ---------------- Portal the chrome to <body> ----------------
  //
  // SvelteFlow nodes live under .svelte-flow__viewport (a transformed
  // ancestor), which would become the containing block for our
  // position:fixed chrome and reinterpret left/top in canvas space. Portal
  // to <body> so fixed-positioning resolves against the real viewport, then
  // edge-align via computeEdgeAlignedRect. Mirrors ControlContextMenu.
  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return {
      destroy() {
        node.remove();
      },
    };
  }

  // Host element (in card DOM) — the trigger + handle stack live here. We
  // read its bounding rect to edge-align the portaled chrome.
  let hostEl: HTMLDivElement | null = $state(null);
  // Portaled chrome element — measured for width/height clamping.
  let chromeEl: HTMLDivElement | null = $state(null);

  let chromePos = $state<{ left: number; top: number }>({ left: 0, top: 0 });

  function cardRectOf(el: HTMLElement): Rect {
    // Edge-align against the whole CARD, not just the host wrapper (the host
    // is display:contents). Walk up to the svelte-flow node element.
    const card =
      (el.closest('.svelte-flow__node') as HTMLElement | null) ?? el;
    const r = card.getBoundingClientRect();
    return {
      left: r.left,
      top: r.top,
      right: r.right,
      bottom: r.bottom,
      width: r.width,
      height: r.height,
    };
  }

  function recomputeChromePos() {
    if (!open || !hostEl) return;
    const viewport: Viewport = {
      width: window.innerWidth,
      height: window.innerHeight,
    };
    const measuredWidth = chromeEl?.offsetWidth || panelWidth;
    const measuredHeight = chromeEl?.offsetHeight;
    chromePos = computeEdgeAlignedRect({
      cardRect: cardRectOf(hostEl),
      side: menu.side,
      menuWidth: measuredWidth,
      menuHeight: measuredHeight,
      viewport,
    });
  }

  // Re-position the chrome whenever it opens / the view changes (height
  // shifts) / on scroll + resize + pan (the card moves under us). A rAF loop
  // while open keeps it glued to the card during a SvelteFlow pan without a
  // per-frame Svelte re-render of the whole panel.
  $effect(() => {
    if (!open) return;
    void view; // re-measure on view swap (overlay-replace changes height)
    let raf = 0;
    const tick = () => {
      recomputeChromePos();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  });

  // ---------------- Dismiss: Esc + outside (negative-space) click ----------------
  $effect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Let Canvas handle Esc during an active pickup (it cancels the
      // pickup + xyflow click-connect); we just close our chrome.
      menu = escReducer();
    };
    const onDocPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      // Inside our own chrome (portaled) or our host → keep open.
      if (target.closest(`[data-patch-panel-chrome="${nodeId}"]`)) return;
      if (target.closest(`[data-patch-panel-node="${nodeId}"]`)) return;
      // A carry/patch-to picker owned by Canvas counts as "inside" — don't
      // dismiss the chrome out from under an in-flight patch.
      if (cascadeLockEngaged) return;
      closeMenu();
    };
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDocPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onDocPointerDown, true);
    };
  });

  // ---------------- Handle bounds re-measure ----------------
  //
  // The handle stack stays in the card DOM at a fixed (closed) position
  // regardless of menu state — so edges always anchor at the trigger corner.
  // We still nudge SvelteFlow to re-measure on menu open/close so any
  // in-flight cable re-routes cleanly. RAF-deferred so CSS settles first.
  //
  // We re-measure through the *stable* SvelteFlow store (captured eagerly,
  // a plain context object) rather than xyflow's `useUpdateNodeInternals()`
  // hook. That hook reads `domNode`/`updateNodeInternals` through a
  // component-owned `$derived(useStore())`, and schedules its OWN
  // uncancellable inner rAF that re-reads that derived. If this card is
  // deleted between scheduling and the rAF firing — e.g. CADILLAC drives
  // through a PICTUREBOX tile and deletes it — the derived is INERT
  // (`svelte/e/derived_inert`) and the read throws an unhandled
  // `updateNodeInternals is not a function` (minified `o(...) is not a
  // function`). That intermittent pageerror flaked the Media Burn
  // load-example e2e (#821 fixed the sibling CadillacOverlay call sites; this
  // PatchPanel site, on every card, was the remaining source). Reading the
  // method off the stable store inside OUR cancellable rAF — and guarding the
  // call — keeps it on the live component's lifecycle.
  const flowStore = useStore();
  $effect(() => {
    void open;
    const id = nodeId;
    let f1 = 0;
    let f2 = 0;
    f1 = requestAnimationFrame(() => {
      f2 = requestAnimationFrame(() => {
        untrack(() => {
          // The card may be mid-teardown by the time this fires (deleted
          // node). The querySelector miss + try/catch make it a no-op rather
          // than an unhandled throw.
          try {
            const nodeElement = flowStore.domNode?.querySelector<HTMLDivElement>(
              `.svelte-flow__node[data-id="${id}"]`,
            );
            if (!nodeElement) return;
            flowStore.updateNodeInternals(
              new Map([[id, { id, nodeElement, force: true }]]),
            );
          } catch {
            /* node already gone — re-measure is moot */
          }
        });
      });
    });
    return () => {
      cancelAnimationFrame(f1);
      cancelAnimationFrame(f2);
    };
  });

  // Whether the menu is carrying a cable for THIS panel's source (so we
  // render the "patch to" entry). Driven by connectDragState.
  let carryingHere = $derived(
    connectDragState.mode === 'pickup' &&
      connectDragState.pickupMenuOpen &&
      connectDragState.pickupSource?.nodeId === nodeId,
  );

  // When a carry that originated HERE ends (commit / Esc / discard), Canvas
  // tears down the pickup + cascade. Close our chrome too so the source
  // panel doesn't linger open after the patch lands. We only auto-close when
  // OUR reducer is in carry mode (menu.carrying) AND the global carry for
  // this node has dropped — i.e. the commit/discard fired.
  $effect(() => {
    const stillCarrying =
      connectDragState.mode === 'pickup' &&
      connectDragState.pickupSource?.nodeId === nodeId;
    untrack(() => {
      if (menu.open && menu.carrying && !stillCarrying) {
        menu = CLOSED;
      }
    });
  });
</script>

<!--
  PORT ROW BUTTON — one shape across all four drill views (inputs / outputs /
  sectioned-outputs fallback / section). The cable-type stripe + verbose label
  come first; a trailing JACK INDICATOR (filled circle = patched, hollow ring =
  unpatched) right-aligns because the label is flex:1. Hovering a patched jack
  shows the remote endpoint(s) via the native `title` (mirrored on aria-label),
  which never clips inside the scrollable portaled menu. The <li> wrappers (and
  the input-only gate-assignable / contextmenu plumbing) stay per-site.
-->
{#snippet portButton(port: PortDescriptor, direction: 'input' | 'output')}
  {@const patched = isPatched(port.id, direction)}
  {@const title = patchTitle(port.id, direction)}
  <button
    type="button"
    class="port-row port-row-{direction}"
    data-testid="patch-panel-port-row"
    data-port-id={port.id}
    data-direction={direction}
    onclick={() => onPortRowClick(port.id, direction)}
  >
    <span class="row-stripe" aria-hidden="true"></span>
    <span class="row-label" data-testid="port-row-label">
      {resolveVerboseLabel(port)}
    </span>
    <span
      class="row-jack"
      data-testid="port-row-jack"
      data-patched={patched ? 'true' : 'false'}
      title={title}
      aria-label={title}
    ></span>
  </button>
{/snippet}

<!--
  HOST (in card DOM, display:contents). Holds the two trigger affordances +
  the always-rendered handle stack. The handle stack is what the per-port
  sweep counts (panel CLOSED) and what cables anchor to.
-->
<div
  class="patch-panel-host"
  data-patch-panel-node={nodeId}
  bind:this={hostEl}
>
  <button
    class="patch-trigger left"
    type="button"
    data-testid="patch-trigger"
    aria-label="Open patch panel"
    aria-expanded={open && menu.side === 'left'}
    onclick={() => openMenu('left')}
  >
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
    aria-expanded={open && menu.side === 'right'}
    onclick={() => openMenu('right')}
  >
    <span class="trigger-glyph" aria-hidden="true">
      <span class="prong"></span>
      <span class="prong"></span>
      <span class="stem"></span>
    </span>
  </button>

  <!--
    HANDLE STACK — every declared <Handle> stays in the card DOM at ALL
    times, stacked + hidden at the top-left corner. This is the cable anchor
    AND the per-module-per-port handle-presence target. It NEVER moves out of
    the card and is independent of the portaled chrome.
  -->
  <div class="handle-stack" aria-hidden="true">
    {#each allInputs as port (port.id)}
      <Handle
        type="target"
        position={Position.Left}
        id={port.id}
        style={`--handle-color: ${cableColorVar(port.cable)};`}
      />
    {/each}
    {#each allOutputs as port (port.id)}
      <Handle
        type="source"
        position={Position.Right}
        id={port.id}
        style={`--handle-color: ${cableColorVar(port.cable)};`}
      />
    {/each}
  </div>

  {@render children?.()}

  <!--
    REAR-VIEW BACK PANEL (rack Phase 3). Always in the DOM (so the CSS 3D flip
    can reveal it without a mount), but display:none until the flow container
    carries `.rear-view`. Covers the whole card, pre-rotated 180° (see
    _module-card.css). Shows the module name + every declared INPUT/OUTPUT jack.
    Each jack is a LIVE patch point in rear view: a <button> that drives the same
    carry seam the front-view port rows use (patchpanel:jackclick → carry →
    patchpanel:carrycommit, owned by Canvas), so a patch made from the back is
    the SAME validated edge with the SAME port ids as a front-view patch. Direct
    jack-to-jack: first click picks up a cable, the next click on any compatible
    jack commits it. The back panel is interactive ONLY in rear view (gated in
    _module-card.css: pointer-events flip to auto under `.rear-view`).
  -->
  <div class="card-back-panel" data-testid="card-back-panel">
    <div class="back-title" data-testid="card-back-title">{backTitle}</div>
    <div class="back-cols">
      <div class="back-col inputs">
        <div class="back-col-head">in</div>
        {#if hasInputs}
          {#each allInputs as port (port.id)}
            {@const patched = isPatched(port.id, 'input')}
            <button
              type="button"
              class="back-jack"
              data-testid="back-jack"
              data-port-id={port.id}
              data-direction="input"
              data-patched={patched ? 'true' : 'false'}
              title={patchTitle(port.id, 'input') ?? resolveVerboseLabel(port)}
              aria-label={`patch ${resolveVerboseLabel(port)} input`}
              style:--jack-color={cableColorVar(port.cable)}
              onclick={() => onBackJackClick(port.id, 'input')}
            >
              <span class="jack-hole" data-patched={patched ? 'true' : 'false'} aria-hidden="true"></span>
              <span class="jack-label">{resolveVerboseLabel(port)}</span>
            </button>
          {/each}
        {:else}
          <div class="back-empty">—</div>
        {/if}
      </div>
      <div class="back-col outputs">
        <div class="back-col-head">out</div>
        {#if hasOutputs}
          {#each allOutputs as port (port.id)}
            {@const patched = isPatched(port.id, 'output')}
            <button
              type="button"
              class="back-jack"
              data-testid="back-jack"
              data-port-id={port.id}
              data-direction="output"
              data-patched={patched ? 'true' : 'false'}
              title={patchTitle(port.id, 'output') ?? resolveVerboseLabel(port)}
              aria-label={`patch ${resolveVerboseLabel(port)} output`}
              style:--jack-color={cableColorVar(port.cable)}
              onclick={() => onBackJackClick(port.id, 'output')}
            >
              <span class="jack-hole" data-patched={patched ? 'true' : 'false'} aria-hidden="true"></span>
              <span class="jack-label">{resolveVerboseLabel(port)}</span>
            </button>
          {/each}
        {:else}
          <div class="back-empty">—</div>
        {/if}
      </div>
    </div>
  </div>
</div>

<!--
  PORTALED CHROME — only the navigation rows. Edge-aligned, position:fixed,
  appended to <body>. Overlay-replace: one `view` at a time.
-->
{#if open}
  <div use:portal>
    <div
      bind:this={chromeEl}
      class="patch-panel"
      class:open
      data-testid="patch-panel"
      data-patch-panel-chrome={nodeId}
      data-anchor-side={menu.side}
      style:left="{chromePos.left}px"
      style:top="{chromePos.top}px"
      style:width="{panelWidth}px"
      aria-hidden={!open}
      role="group"
    >
      <!-- Header row: back affordance (when drilled) + title. -->
      <div class="chrome-header">
        {#if view.kind !== 'root'}
          <button
            type="button"
            class="chrome-back"
            data-testid="patch-panel-back"
            aria-label="Back"
            onclick={goBack}
          >
            <span aria-hidden="true">◂</span> back
          </button>
        {/if}
        <span class="chrome-title">
          {#if view.kind === 'root'}patch
          {:else if view.kind === 'inputs'}inputs
          {:else if view.kind === 'outputs'}outputs
          {:else if view.kind === 'section'}{view.label}
          {:else if view.kind === 'picker'}patch to
          {/if}
        </span>
      </div>

      {#if view.kind === 'root'}
        <!-- ROOT: INPUT / OUTPUT pivots (+ section rows for sectioned cards). -->
        <div class="chrome-body" data-testid="patch-panel-root">
          {#if menu.carrying || carryingHere}
            <button
              type="button"
              class="nav-row patch-to-row"
              data-testid="patch-panel-patch-to"
              onclick={() => {
                hostEl?.dispatchEvent(
                  new CustomEvent('patchpanel:patchto', { bubbles: true, detail: { nodeId } }),
                );
              }}
            >
              patch to&hellip; <span class="chev" aria-hidden="true">▸</span>
            </button>
          {/if}
          {#if groupingStrategy === 'sectioned'}
            {#if hasInputs}
              {#each inputSections as section (section.label)}
                <button
                  type="button"
                  class="nav-row"
                  data-testid="patch-panel-section-nav"
                  data-section-label={section.label}
                  onclick={() => drill({ kind: 'section', label: section.label })}
                >
                  <span class="nav-label">{section.label}</span>
                  <span class="nav-count">({section.inputs?.length ?? 0})</span>
                  <span class="chev" aria-hidden="true">▸</span>
                </button>
              {/each}
            {/if}
            {#if hasOutputs}
              <button
                type="button"
                class="nav-row"
                data-testid="patch-panel-nav"
                data-nav="outputs"
                onclick={() => drill({ kind: 'outputs' })}
              >
                <span class="nav-label">OUTPUT</span>
                <span class="nav-count">({allOutputs.length})</span>
                <span class="chev" aria-hidden="true">▸</span>
              </button>
            {/if}
          {:else}
            {#if hasInputs}
              <button
                type="button"
                class="nav-row"
                data-testid="patch-panel-nav"
                data-nav="inputs"
                onclick={() => drill({ kind: 'inputs' })}
              >
                <span class="nav-label">INPUT</span>
                <span class="nav-count">({allInputs.length})</span>
                <span class="chev" aria-hidden="true">▸</span>
              </button>
            {/if}
            {#if hasOutputs}
              <button
                type="button"
                class="nav-row"
                data-testid="patch-panel-nav"
                data-nav="outputs"
                onclick={() => drill({ kind: 'outputs' })}
              >
                <span class="nav-label">OUTPUT</span>
                <span class="nav-count">({allOutputs.length})</span>
                <span class="chev" aria-hidden="true">▸</span>
              </button>
            {/if}
          {/if}
        </div>
      {:else if view.kind === 'inputs'}
        <!-- INPUT drill: flat input port rows (auto grouping). -->
        <div class="chrome-body" data-testid="patch-panel-inputs">
          {#each inputGroups as group (group.cable)}
            <div class="row-group-label">{group.label}</div>
            <ul class="row-list">
              {#each group.ports as port (port.id)}
                <li
                  class="panel-row"
                  class:gate-assignable={port.cable === 'gate'}
                  style:--row-cable={cableColorVar(port.cable)}
                  oncontextmenu={port.cable === 'gate' ? (e) => openGateMidiMenu(e, port) : undefined}
                  data-gate-midi-bound={port.cable === 'gate' && !!gateBound(port.id) ? 'true' : undefined}
                >
                  {@render portButton(port, 'input')}
                </li>
              {/each}
            </ul>
          {/each}
        </div>
      {:else if view.kind === 'outputs'}
        <!-- OUTPUT drill: flat output port rows. -->
        <div class="chrome-body" data-testid="patch-panel-outputs">
          {#each outputGroups as group (group.cable)}
            <div class="row-group-label">{group.label}</div>
            <ul class="row-list">
              {#each group.ports as port (port.id)}
                <li class="panel-row" style:--row-cable={cableColorVar(port.cable)}>
                  {@render portButton(port, 'output')}
                </li>
              {/each}
            </ul>
          {/each}
          {#if outputGroups.length === 0 && allOutputs.length > 0}
            <!-- Sectioned cards funnel outputs into the flat list. -->
            <ul class="row-list">
              {#each allOutputs as port (port.id)}
                <li class="panel-row" style:--row-cable={cableColorVar(port.cable)}>
                  {@render portButton(port, 'output')}
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      {:else if view.kind === 'section'}
        <!-- SECTION drill: one section's input port rows. -->
        {@const section = sectionByLabel(view.label)}
        <div
          class="chrome-body"
          data-testid="patch-panel-section"
          data-section-label={view.label}
          data-section-expanded="true"
        >
          {#if section}
            <ul class="row-list">
              {#each section.inputs ?? [] as port (port.id)}
                <li
                  class="panel-row"
                  class:gate-assignable={port.cable === 'gate'}
                  style:--row-cable={cableColorVar(port.cable)}
                  oncontextmenu={port.cable === 'gate' ? (e) => openGateMidiMenu(e, port) : undefined}
                  data-gate-midi-bound={port.cable === 'gate' && !!gateBound(port.id) ? 'true' : undefined}
                >
                  {@render portButton(port, 'input')}
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      {/if}
    </div>
  </div>
{/if}

<!-- Gate-input MIDI assign menu (right-click a gate INPUT row). 'note' kind:
     MIDI assign captures a NOTE; NOTE-on → gate high, NOTE-off → gate low. -->
{#if gatePortId}
  <ControlContextMenu
    open={gateCtxOpen}
    x={gateCtxX}
    y={gateCtxY}
    title={`${nodeId} · ${gatePortId}`}
    hasBinding={!!gateMidi.binding}
    bindingLabel={gateMidi.bindingLabel}
    onlearn={gateMidi.learn}
    onforget={gateMidi.forget}
    onclose={closeGateMidiMenu}
    surfaces={gateMidi.surfaces}
    onsendtosurface={gateMidi.sendToSurface}
    onremovefromsurface={gateMidi.removeFromSurface}
    electras={gateMidi.electras}
    onassignelectra={gateMidi.assignElectra}
    onclearelectra={gateMidi.clearElectra}
  />
{/if}

<!-- Annotate mode (personal authored-doc hover lens) — inert unless toggled ON
     for this node via the right-click "Annotate" entry; null docIndex (no
     authored docs) makes it a no-op. -->
<AnnotateLayer {nodeId} docIndex={annotateDocIndex} />

<style>
  .patch-panel-host {
    display: contents;
  }

  /* ---------------- Trigger affordance (top-left + top-right) ---------------- */
  .patch-panel-host {
    --patch-trigger-inset: max(4px, calc(var(--module-radius, 2px) * 0.42));
  }

  .patch-trigger {
    position: absolute;
    top: var(--patch-trigger-inset, 4px);
    width: 18px;
    height: 18px;
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
    left: var(--patch-trigger-inset, 4px);
  }
  .patch-trigger.right {
    right: var(--patch-trigger-inset, 4px);
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

  /* ---------------- Handle stack (closed-state, always in card DOM) ---------------- */
  /*
   * Every <Handle> lives here at all times, collapsed to the card's top-left
   * affordance corner: opacity 0, pointer-events none, stacked. Cables anchor
   * here; the per-module-per-port sweep counts these (panel CLOSED). The
   * portaled chrome is a separate, navigation-only surface.
   */
  .handle-stack {
    position: absolute;
    top: var(--patch-trigger-inset, 4px);
    left: var(--patch-trigger-inset, 4px);
    width: 0;
    height: 0;
    pointer-events: none;
  }
  .handle-stack :global(.svelte-flow__handle) {
    position: absolute !important;
    top: 6px !important;
    left: 6px !important;
    right: auto !important;
    bottom: auto !important;
    transform: none !important;
    opacity: 0 !important;
    pointer-events: none !important;
  }

  /* ---------------- Portaled chrome ---------------- */
  .patch-panel {
    position: fixed;
    background: rgba(14, 17, 22, 0.97);
    border: 1px solid var(--accent-dim);
    border-radius: 3px;
    color: var(--text);
    box-shadow: 0 4px 18px rgba(0, 0, 0, 0.6);
    padding: 6px 8px 8px;
    max-height: 70vh;
    max-width: 80vw;
    overflow-y: auto;
    z-index: 1001;
    font-family: ui-monospace, monospace;
    /* Open/close visual transition is handled by the {#if open} mount —
     * no opacity dance needed now that the chrome only exists when open. */
  }

  .chrome-header {
    display: flex;
    align-items: center;
    gap: 8px;
    position: sticky;
    top: -6px;
    background: rgba(14, 17, 22, 0.97);
    padding: 2px 2px 6px;
    margin: 0 0 4px;
    border-bottom: 1px solid var(--divider);
    z-index: 1;
  }
  .chrome-title {
    font-size: 0.65rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text);
    flex: 1;
  }
  .chrome-back {
    appearance: none;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text);
    cursor: pointer;
    font: inherit;
    font-size: 0.6rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 2px 6px;
  }
  .chrome-back:hover,
  .chrome-back:focus-visible {
    border-color: var(--accent);
    background: rgba(0, 240, 255, 0.08);
    outline: none;
  }

  .chrome-body {
    display: flex;
    flex-direction: column;
  }

  /* ---------------- Nav rows (root pivots) ---------------- */
  .nav-row {
    appearance: none;
    background: transparent;
    border: none;
    color: var(--text);
    cursor: pointer;
    font: inherit;
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    text-align: left;
    padding: 7px 8px;
    border-radius: 2px;
    font-size: 0.72rem;
  }
  .nav-row:hover,
  .nav-row:focus-visible {
    background: rgba(0, 240, 255, 0.08);
    outline: none;
  }
  .nav-row .nav-label {
    flex: 1;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 600;
  }
  .nav-row .nav-count {
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
  }
  .nav-row .chev {
    color: var(--text-dim);
  }
  .patch-to-row {
    color: var(--accent);
    font-weight: 600;
  }

  /* ---------------- Port rows (drill views) ---------------- */
  .row-group-label {
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
  .panel-row {
    position: relative;
  }
  .port-row {
    appearance: none;
    background: transparent;
    border: none;
    color: var(--text);
    cursor: pointer;
    font: inherit;
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    text-align: left;
    height: 24px;
    padding: 0 8px;
    border-radius: 2px;
    font-size: 0.7rem;
  }
  .port-row:hover,
  .port-row:focus-visible {
    background: rgba(0, 240, 255, 0.08);
    outline: none;
  }
  .port-row .row-stripe {
    width: 3px;
    height: 14px;
    border-radius: 1px;
    background: var(--row-cable, var(--cable-audio));
    flex: 0 0 auto;
  }
  .port-row .row-label {
    flex: 1;
  }
  /* JACK INDICATOR (trailing, right-aligned by the flex:1 label). A hollow
     cable-coloured RING means the port is unpatched; a FILLED cable-coloured
     circle means an edge connects to it. Hovering a filled jack surfaces the
     remote endpoint(s) via the native `title`. Visually echoes .row-stripe. */
  .port-row .row-jack {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    box-sizing: border-box;
    border: 1.5px solid var(--row-cable, var(--cable-audio));
    background: transparent;
    flex: 0 0 auto;
    /* A slightly larger transparent hit area for the hover title without
       changing the visible 8px ring. */
    margin: 0 1px;
  }
  .port-row .row-jack[data-patched='true'] {
    background: var(--row-cable, var(--cable-audio));
  }
  /* Gate inputs are right-clickable for MIDI assign (re-applied from #735 onto
     the redesign's overlay-replace port rows); hint via the context cursor +
     a subtle dot when a NOTE binding is active. */
  .panel-row.gate-assignable .port-row {
    cursor: context-menu;
  }
  .panel-row.gate-assignable[data-gate-midi-bound='true'] .row-label::after {
    content: '●';
    margin-left: 4px;
    font-size: 0.5rem;
    color: #a8d3ff;
    vertical-align: middle;
  }
</style>
