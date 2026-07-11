<script lang="ts">
  // AudioIoSurface — the WORKFLOW topbar 1/8"-plug dropdown: the faces of
  // the always-on pinned AUDIO IN + AUDIO OUT instances (canvas-hidden —
  // this panel is where they live).
  //
  // REUSE OVER DUPLICATION: the panel hosts the REAL AudioinCard +
  // AudioOutCard through a standalone single-node SvelteFlow host (the P1
  // dock-drawer precedent; the drawer itself moved to the plain-mount
  // DockCardHost in P2.5a — this surface keeps the flow host because its
  // pinned nodes are canvas-hidden, so no stub/data-id collision exists
  // and its geometry is already attested by the P2 e2e), so the input
  // source picker, getUserMedia permission flow, music-mode, status LED,
  // gain fader, output device pick (setSinkId) and master fader are all
  // the card's own code — zero forked device-enumeration logic.
  //
  // ALWAYS-ON lifecycle: AudioinCard owns the live MediaStream and stops
  // it on unmount, so this panel stays MOUNTED whenever the workflow shell
  // is up and open/close only toggles CSS visibility — closing the menu
  // must not kill the rack's audio input.
  //
  // Patch-out rows hand AUDIO IN's L/R outputs to the existing patch-menu
  // drill-down (same CustomEvent seam as ClockSurface). AUDIO OUT needs no
  // patch-out (it is a terminal sink; sources patch INTO it from any card
  // jack or picker).

  import { SvelteFlow } from '@xyflow/svelte';
  import type { ModuleNode } from '$lib/graph/types';

  interface Props {
    /** The pinned AUDIO IN / AUDIO OUT (snapshot-derived; null pre-ensure). */
    audioIn: ModuleNode | null;
    audioOut: ModuleNode | null;
    /** The same glob-driven nodeTypes map the main canvas uses. */
    nodeTypes: Record<string, unknown>;
    /** Whether the dropdown is visible (the panel stays mounted either way). */
    open: boolean;
    /** Close the dropdown (called after a patch-out hand-off). */
    onRequestClose: () => void;
  }
  let { audioIn, audioOut, nodeTypes, open, onRequestClose }: Props = $props();

  /** Single-node host row — the P1 dock-drawer flow-host pattern. */
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

  const PATCH_OUTS: ReadonlyArray<{ id: string; label: string }> = [
    { id: 'audio_l_out', label: 'AUDIO IN L' },
    { id: 'audio_r_out', label: 'AUDIO IN R' },
  ];

  function patchOut(portId: string, ev: MouseEvent): void {
    if (!audioIn) return;
    document.dispatchEvent(
      new CustomEvent('patchpanel:jackclick', {
        detail: { nodeId: audioIn.id, portId, direction: 'output', side: 'right' },
      }),
    );
    document.dispatchEvent(
      new CustomEvent('patchpanel:patchto', {
        detail: { nodeId: audioIn.id, pos: { x: ev.clientX, y: ev.clientY } },
      }),
    );
    onRequestClose();
  }
</script>

<div
  class="io-panel"
  class:open
  data-testid="workflow-io-panel"
  data-open={open ? 'true' : 'false'}
  aria-hidden={!open}
>
  <div class="io-columns">
    <section class="io-col">
      <header class="io-col-header">input</header>
      {#if audioIn}
        {#key audioIn.id}
          <div class="card-host" data-testid="workflow-io-audioin-host">
            <SvelteFlow
              nodes={hostNodesFor(audioIn)}
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
          </div>
        {/key}
        <div class="patchout" data-testid="workflow-io-patchout">
          {#each PATCH_OUTS as p (p.id)}
            <button
              class="patchout-row"
              data-testid={`workflow-io-patchout-${p.id}`}
              onclick={(e) => patchOut(p.id, e)}
              title={`Patch ${p.label} to a compatible input on the canvas`}
            >
              <span class="jack"></span>
              {p.label}
            </button>
          {/each}
        </div>
      {:else}
        <div class="hint" data-testid="workflow-io-audioin-empty">audio in spawning…</div>
      {/if}
    </section>

    <section class="io-col">
      <header class="io-col-header">output</header>
      {#if audioOut}
        {#key audioOut.id}
          <div class="card-host" data-testid="workflow-io-audioout-host">
            <SvelteFlow
              nodes={hostNodesFor(audioOut)}
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
          </div>
        {/key}
      {:else}
        <div class="hint" data-testid="workflow-io-audioout-empty">audio out spawning…</div>
      {/if}
    </section>
  </div>
</div>

<style>
  .io-panel {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 60;
    background: #14171c;
    border: 1px solid #404652;
    border-radius: 4px;
    padding: 8px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
    /* Hidden ≠ unmounted: the hosted AudioinCard owns the live input
       stream and must survive menu close. visibility (not display) keeps
       the standalone flow hosts measurable for fitView. */
    visibility: hidden;
    pointer-events: none;
  }
  .io-panel.open {
    visibility: visible;
    pointer-events: auto;
  }
  .io-columns {
    display: flex;
    gap: 10px;
    align-items: stretch;
  }
  .io-col {
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 250px;
  }
  .io-col-header {
    font-size: 0.6rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-dim);
    padding: 0 2px;
  }
  .card-host {
    width: 250px;
    height: 330px;
    border: 1px solid #2a2f3a;
    border-radius: 3px;
    overflow: hidden;
  }
  .card-host :global(.svelte-flow) {
    width: 100%;
    height: 100%;
    background: #0e1116;
  }
  .card-host :global(.svelte-flow__pane) {
    cursor: default;
  }
  .hint {
    color: var(--text-dim);
    font-size: 0.7rem;
    padding: 8px;
  }
  .patchout {
    display: flex;
    flex-direction: column;
  }
  .patchout-row {
    display: flex;
    align-items: center;
    gap: 8px;
    background: transparent;
    border: none;
    color: var(--text);
    text-align: left;
    padding: 4px 6px;
    border-radius: 3px;
    cursor: pointer;
    font-family: ui-monospace, monospace;
    font-size: 0.7rem;
  }
  .patchout-row:hover {
    background: #2a2f3a;
  }
  .jack {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--cable-audio, #22c55e);
    flex: 0 0 auto;
  }
</style>
