<script lang="ts">
  // CameraSurface — the WORKFLOW topbar 📷 slot: the camera manager.
  //
  // Lists every MAPPED camera — a FULL cameraInput module in the graph
  // carrying the `hiddenCard` node-data flag, so it renders NO canvas card
  // anywhere (Canvas's flowNodes derivation skips it; the flag is synced
  // node data, so collaborators also see no card). Per row:
  //
  //   * LABEL — device label when locally resolvable, else "camera N".
  //     Click = a VIRTUAL-PORT cable drag of the camera's video output
  //     (connectDragState.beginVirtualPickup — the P3 primitive): the
  //     resolve() returns the EXISTING module's `out` port, so an
  //     abandoned drag never touches the graph and a commit rides the
  //     same validated carry paths as every cable.
  //   * hover — a live preview to the RIGHT of the menu: the camera's
  //     ALWAYS-MOUNTED card host (see below) is simply positioned
  //     on-screen. Zero extra preview plumbing — it IS the module's
  //     existing preview path (the card's own <video>).
  //   * SOURCE — pins that same host open + interactive so the user can
  //     work the card's OWN device dropdown / permission flow. Source
  //     assignment and its persistence (node.data.deviceId) are 100% the
  //     card's code (AudioIoSurface's reuse-over-duplication precedent).
  //   * ✕ — unmap: deletes the module + its edges via the standard
  //     remove path (these are NOT pinned). Confirm-free; the hover state
  //     makes the ✕ unambiguous (dedicated hit target + danger hover).
  //
  //   ＋ row — maps a new camera (cap-guarded: cameraInput.maxInstances,
  //   shared with canvas CAMERA cards) and immediately opens its source
  //   picker (the new camera's card host, pinned interactive).
  //
  // ALWAYS-ON lifecycle (the whole point): each mapped camera's REAL
  // CameraInputCard is hosted in a single-node SvelteFlow (the
  // AudioIoSurface / DockZoneContainer pattern) that stays MOUNTED while
  // the workflow shell is up — the card owns getUserMedia + the live
  // <video> element and hands it to the engine via attachExternalSource,
  // so closing the menu must not kill a camera the rack is compositing.
  // Hidden hosts park OFF-SCREEN (fixed, left:-9999px) rather than
  // display:none/visibility:hidden: an off-screen video element is the
  // same scenario as a canvas card scrolled out of view — decode + rVFC
  // keep running (the module's audio keep-alive holds the decode rate),
  // where a non-rendered one could freeze the engine's texture.

  import { SvelteFlow } from '@xyflow/svelte';
  import type { ModuleNode } from '$lib/graph/types';
  import { connectDragState } from '$lib/ui/connect-drag-state.svelte';
  import {
    addWorkflowCamera,
    unmapWorkflowCamera,
    cameraRowLabel,
    readCameraDeviceId,
    WORKFLOW_CAMERA_OUT_PORT,
    type DeviceLabelLike,
  } from './workflow-cameras';

  interface Props {
    /** The mapped (hiddenCard) camera nodes, snapshot-derived by Canvas. */
    cameras: ModuleNode[];
    /** True when one more camera would exceed cameraInput.maxInstances. */
    atCap: boolean;
    /** The same glob-driven nodeTypes map the main canvas uses. */
    nodeTypes: Record<string, unknown>;
    /** Whether the dropdown is visible (hosts stay mounted either way). */
    open: boolean;
    /** Close the dropdown (row-select hand-off). */
    onRequestClose: () => void;
    /** Canvas's ensureEngine — ＋ boots the engine on the same gesture so
     *  the reconciler can materialize the new camera's engine node. */
    onEnsureEngine?: (() => Promise<unknown>) | null;
  }
  let { cameras, atCap, nodeTypes, open, onRequestClose, onEnsureEngine = null }: Props = $props();

  let camError = $state<string | null>(null);
  /** Row whose card host is PINNED open + interactive (the source picker). */
  let expandedId = $state<string | null>(null);
  /** Row currently hovered (transient preview; wins over expanded). */
  let hoveredId = $state<string | null>(null);
  let panelEl = $state<HTMLDivElement | null>(null);
  /** Screen position of the on-screen host (right of the menu). */
  let hostPos = $state<{ left: number; top: number } | null>(null);

  /** Which camera's host is on-screen right now. */
  let shownId = $derived(open ? (hoveredId ?? expandedId) : null);

  // Drop stale expand/hover state when its camera is unmapped (any path —
  // our ✕, a collaborator's, Clear).
  $effect(() => {
    const ids = new Set(cameras.map((c) => c.id));
    if (expandedId && !ids.has(expandedId)) expandedId = null;
    if (hoveredId && !ids.has(hoveredId)) hoveredId = null;
  });

  // Position the shown host to the RIGHT of the menu, level with its row
  // (AssetsPickerSurface thumbnail geometry — fixed coords escape the
  // menu's overflow clip). Falls back to the panel top for a just-added
  // camera whose row hasn't painted yet.
  $effect(() => {
    const id = shownId;
    if (!id || !panelEl) return;
    void cameras.length; // reposition when rows shift
    const menuRect = panelEl.getBoundingClientRect();
    const rowEl = panelEl.querySelector(`[data-node-id="${CSS.escape(id)}"]`);
    const rowTop = rowEl ? rowEl.getBoundingClientRect().top : menuRect.top;
    const viewportH = typeof window !== 'undefined' ? window.innerHeight : 800;
    const viewportW = typeof window !== 'undefined' ? window.innerWidth : 1280;
    hostPos = {
      // Right of the menu, clamped on-screen (the host is 300px wide).
      left: Math.max(8, Math.min(menuRect.right + 8, viewportW - 310)),
      top: Math.max(8, Math.min(rowTop, viewportH - 440)),
    };
  });

  // ---- local device labels (display only — assignment is the card's) ----
  // deviceIds/labels are browser-instance-local and only readable after a
  // permission grant; unresolvable rows fall back to "camera N".
  let devices = $state<DeviceLabelLike[]>([]);
  async function refreshDeviceLabels(): Promise<void> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return;
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      devices = all
        .filter((d) => d.kind === 'videoinput')
        .map((d) => ({ deviceId: d.deviceId, label: d.label }));
    } catch {
      /* enumeration is best-effort — labels just stay generic */
    }
  }
  $effect(() => {
    if (!open) return;
    // Re-enumerate on open AND whenever the mapped set / an assignment
    // changes (a pick in the hosted card grants permission, which is what
    // makes real labels readable) — so rows flip "camera N" → the device
    // label without needing a menu re-open.
    void cameras;
    void refreshDeviceLabels();
  });
  $effect(() => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.addEventListener) return;
    const onChange = (): void => void refreshDeviceLabels();
    navigator.mediaDevices.addEventListener('devicechange', onChange);
    return () => navigator.mediaDevices.removeEventListener('devicechange', onChange);
  });

  // ---- ＋ map a new camera → open its source picker ----
  function onAdd(): void {
    camError = null;
    // Boot the engine on this gesture (fire-and-forget) so the reconciler
    // can materialize the camera's engine-side node.
    void onEnsureEngine?.().catch(() => {});
    const id = addWorkflowCamera({ onError: (m) => (camError = m) });
    if (id) expandedId = id; // the hosted card IS the source picker
  }

  // ---- row select → virtual-port drag of the EXISTING module's output ----
  function onRowSelect(cam: ModuleNode, ev: MouseEvent): void {
    camError = null;
    // Snapshot the id NOW — resolve() outlives this render pass (P3's
    // destroyed-component sentinel lesson; plain string, CRDT-safe).
    const nodeId = cam.id;
    connectDragState.beginVirtualPickup({
      anchor: { x: ev.clientX, y: ev.clientY },
      cableType: 'video',
      // No creation at commit time — the camera module already exists.
      resolve: () => Promise.resolve({ nodeId, portId: WORKFLOW_CAMERA_OUT_PORT }),
    });
    // Seed the ghost endpoint so the cable is visible pre-pointermove.
    connectDragState.updatePickupCursor(ev.clientX, ev.clientY);
    onRequestClose();
  }

  // ---- ✕ unmap (menu stays open; rows re-derive from the snapshot) ----
  function onRowUnmap(cam: ModuleNode, ev: MouseEvent): void {
    ev.stopPropagation();
    camError = null;
    unmapWorkflowCamera(cam.id);
  }

  function toggleSource(cam: ModuleNode, ev: MouseEvent): void {
    ev.stopPropagation();
    camError = null;
    expandedId = expandedId === cam.id ? null : cam.id;
  }

  /** Single-node host row — the AudioIoSurface / DockZoneContainer
   *  mounting pattern (the REAL CameraInputCard, its own everything). */
  function hostNodesFor(node: ModuleNode) {
    return [
      {
        id: node.id,
        type: node.type,
        position: { x: 0, y: 0 },
        draggable: false,
        data: { node },
      },
    ];
  }
</script>

<div
  class="cam-panel"
  class:open
  data-testid="workflow-cameras-panel"
  data-open={open ? 'true' : 'false'}
  aria-hidden={!open}
  bind:this={panelEl}
>
  {#if camError}
    <div class="error" data-testid="workflow-cameras-error">{camError}</div>
  {/if}

  <button
    class="add-row"
    data-testid="workflow-cameras-add"
    disabled={atCap}
    onclick={onAdd}
    title={atCap
      ? 'Camera limit reached (shared with canvas CAMERA cards)'
      : 'Map another camera — pick its source, then patch its output from this menu'}
  >＋ add camera</button>

  {#if cameras.length === 0}
    <div class="empty" data-testid="workflow-cameras-empty">
      no cameras mapped — ＋ adds one
    </div>
  {/if}

  {#each cameras as cam (cam.id)}
    <div
      class="cam-row"
      class:expanded={expandedId === cam.id}
      data-testid="workflow-camera-row"
      data-node-id={cam.id}
      data-assigned={readCameraDeviceId(cam) ? 'true' : 'false'}
      role="menuitem"
      tabindex="0"
      onmouseenter={() => (hoveredId = cam.id)}
      onmouseleave={() => (hoveredId = null)}
      onclick={(e) => onRowSelect(cam, e)}
      onkeydown={(e) => {
        if (e.key === 'Enter') onRowSelect(cam, e as unknown as MouseEvent);
      }}
      title={`${cameraRowLabel(cam, devices)} — click to drag its video output out`}
    >
      <span class="jack" aria-hidden="true"></span>
      <span class="cam-label" data-testid="workflow-camera-label">
        {cameraRowLabel(cam, devices)}
      </span>
      <button
        class="source"
        data-testid="workflow-camera-source"
        aria-expanded={expandedId === cam.id}
        onclick={(e) => toggleSource(cam, e)}
        title="Pick / change this camera's source device"
      >source</button>
      <button
        class="unmap"
        data-testid="workflow-camera-unmap"
        aria-label={`unmap ${cameraRowLabel(cam, devices)}`}
        title="Unmap — removes this camera and its cables"
        onclick={(e) => onRowUnmap(cam, e)}
      >✕</button>
    </div>
  {/each}
</div>

<!-- The ALWAYS-MOUNTED card-host farm. One host per mapped camera; the
     shown one sits right of the menu, the rest park off-screen (still
     rendered — see the header comment). data-wf-camera-host exempts
     clicks inside from the topbar's outside-pointerdown close. -->
{#each cameras as cam (cam.id)}
  {@const pos = shownId === cam.id ? hostPos : null}
  <div
    class="cam-host"
    class:interactive={pos !== null && expandedId === cam.id}
    data-wf-camera-host
    data-testid="workflow-camera-host"
    data-node-id={cam.id}
    data-shown={pos !== null ? 'true' : 'false'}
    style={pos !== null ? `left:${pos.left}px; top:${pos.top}px;` : 'left:-9999px; top:0;'}
    aria-hidden={pos === null}
  >
    {#key cam.id}
      <SvelteFlow
        nodes={hostNodesFor(cam)}
        edges={[]}
        nodeTypes={nodeTypes as never}
        colorMode="dark"
        fitView
        fitViewOptions={{ padding: 0.04, maxZoom: 1 }}
        minZoom={0.05}
        maxZoom={4}
        panOnDrag={false}
        panOnScroll={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        preventScrolling={false}
      />
    {/key}
  </div>
{/each}

<style>
  .cam-panel {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 60;
    min-width: 230px;
    max-height: 70vh;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    background: #14171c;
    border: 1px solid #404652;
    border-radius: 4px;
    padding: 4px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
    visibility: hidden;
    pointer-events: none;
  }
  .cam-panel.open {
    visibility: visible;
    pointer-events: auto;
  }
  .error,
  .empty {
    color: var(--text-dim);
    font-size: 0.72rem;
    padding: 8px;
  }
  .error {
    color: var(--cable-gate, #f97316);
  }
  .add-row {
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
  .add-row:hover:not(:disabled) {
    background: #2a2f3a;
  }
  .add-row:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .cam-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 6px 4px 12px;
    border-radius: 3px;
    cursor: pointer;
    color: var(--text);
    font-family: ui-monospace, monospace;
    font-size: 0.7rem;
  }
  .cam-row:hover,
  .cam-row.expanded {
    background: #2a2f3a;
  }
  .jack {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--cable-video, #f472b6);
    flex: 0 0 auto;
  }
  .cam-label {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .source {
    flex: 0 0 auto;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 3px;
    color: var(--text-dim);
    cursor: pointer;
    font-family: inherit;
    font-size: 0.62rem;
    padding: 2px 6px;
  }
  .cam-row:hover .source,
  .cam-row.expanded .source {
    border-color: #404652;
    color: var(--text);
  }
  .source[aria-expanded='true'] {
    border-color: var(--cable-video, #f472b6);
  }
  /* The ✕ must read unambiguously on row hover: its own hit target with a
     danger-tinted hover, clearly separated from the row's click-to-patch. */
  .unmap {
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
  .cam-row:hover .unmap {
    color: var(--text);
  }
  .unmap:hover {
    color: #fca5a5;
    background: #3a2026;
  }
  .cam-host {
    position: fixed;
    z-index: 61;
    width: 300px;
    height: 420px;
    background: #14171c;
    border: 1px solid #404652;
    border-radius: 4px;
    padding: 4px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
    /* Hover preview is look-don't-touch; SOURCE pins it interactive. */
    pointer-events: none;
  }
  .cam-host.interactive {
    pointer-events: auto;
  }
  .cam-host :global(.svelte-flow) {
    width: 100%;
    height: 100%;
    background: #0e1116;
  }
  .cam-host :global(.svelte-flow__pane) {
    cursor: default;
  }
</style>
