<script lang="ts">
  // AudioIoSurface — the WORKFLOW topbar 1/8"-plug dropdown: the faces of
  // the always-on pinned AUDIO IN + AUDIO OUT instances (canvas-hidden —
  // this panel is where they live).
  //
  // REUSE OVER DUPLICATION: the panel hosts the REAL AudioinCard +
  // AudioOutCard through DockCardHost — the P2.5a PLAIN-MOUNT pattern the
  // M/E/C drawers use (same nodeTypes map, natural card size via
  // ResizeObserver, independent 50–150% zoom, NO SvelteFlow host). The
  // previous single-node <SvelteFlow> hosts fired their one-shot fitView at
  // mount — while the panel was hidden (opacity:0, per the #1068 ghost-card
  // fix) — against fixed 250×330 boxes and never re-fit: the AUDIO IN card
  // rendered clipped at the host's left edge, AUDIO OUT floated in dead
  // space, and both hosts leaked the "Svelte Flow" attribution badge
  // (owner report 2026-07-11). Plain-mounting removes the whole failure
  // class: no fitView, no viewport transform, no attribution, columns size
  // to the card's natural (rack-sized) box. The input source picker,
  // getUserMedia permission flow, music-mode, status LED, gain fader,
  // output device pick (setSinkId) and master fader remain the cards' own
  // code — zero forked device-enumeration logic.
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

  import type { ModuleNode } from '$lib/graph/types';
  import DockCardHost from '$lib/ui/dock/DockCardHost.svelte';
  import { stepScale } from '$lib/ui/dock/dock-entries';

  interface Props {
    /** The pinned AUDIO IN / AUDIO OUT (snapshot-derived; null pre-ensure). */
    audioIn: ModuleNode | null;
    audioOut: ModuleNode | null;
    /** The same glob-driven nodeTypes map the main canvas uses. */
    nodeTypes: Record<string, unknown>;
    /** Canvas's type → rack {size, hp} map (DockCardHost rack sizing). */
    rackSizeByType?: Record<string, { size?: string; hp?: number }>;
    /** Whether the dropdown is visible (the panel stays mounted either way). */
    open: boolean;
    /** Close the dropdown (called after a patch-out hand-off). */
    onRequestClose: () => void;
  }
  let { audioIn, audioOut, nodeTypes, rackSizeByType = {}, open, onRequestClose }: Props = $props();

  // Independent per-column zoom — LOCAL panel state (the pinned pair has no
  // dock entry), stepping the same discrete 50–150% ladder the drawers use.
  let inScale = $state(1);
  let outScale = $state(1);

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

  // AUDIO OUT is canvas-HIDDEN, so — unlike a card ADDED on the grid, whose input
  // jacks let the user pick a source to patch FROM — the pinned instance had NO
  // discoverable "select a source" affordance in this panel (owner report: the
  // default audio-out shows no source list, but audio-in does). These rows mirror
  // audio-in's patch-out rows in reverse: clicking a channel grabs that INPUT
  // (one-motion rewire) and opens the SAME "patch from" picker that lists every
  // compatible source on the canvas — i.e. the pinned audio-out now behaves like
  // an added one. Sinks patch INTO them, so this is a "receive from" list.
  const PATCH_INS: ReadonlyArray<{ id: string; label: string }> = [
    { id: 'L', label: 'AUDIO OUT L' },
    { id: 'R', label: 'AUDIO OUT R' },
  ];

  function patchIn(portId: string, ev: MouseEvent): void {
    if (!audioOut) return;
    document.dispatchEvent(
      new CustomEvent('patchpanel:jackclick', {
        detail: { nodeId: audioOut.id, portId, direction: 'input', side: 'left' },
      }),
    );
    document.dispatchEvent(
      new CustomEvent('patchpanel:patchto', {
        detail: { nodeId: audioOut.id, pos: { x: ev.clientX, y: ev.clientY } },
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
      {#if audioIn}
        {#key audioIn.id}
          <div class="card-host" data-testid="workflow-io-audioin-host">
            <DockCardHost
              node={audioIn}
              {nodeTypes}
              rackSize={rackSizeByType[audioIn.type]}
              scale={inScale}
              title="audio in"
              onStepScale={(dir) => (inScale = stepScale(inScale, dir))}
              onResetScale={() => (inScale = 1)}
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
      {#if audioOut}
        {#key audioOut.id}
          <div class="card-host" data-testid="workflow-io-audioout-host">
            <DockCardHost
              node={audioOut}
              {nodeTypes}
              rackSize={rackSizeByType[audioOut.type]}
              scale={outScale}
              title="audio out"
              onStepScale={(dir) => (outScale = stepScale(outScale, dir))}
              onResetScale={() => (outScale = 1)}
            />
          </div>
        {/key}
        <div class="patchout" data-testid="workflow-io-patchin">
          {#each PATCH_INS as p (p.id)}
            <button
              class="patchout-row"
              data-testid={`workflow-io-patchin-${p.id}`}
              onclick={(e) => patchIn(p.id, e)}
              title={`Receive ${p.label} from a source on the canvas`}
            >
              <span class="jack"></span>
              {p.label}
            </button>
          {/each}
        </div>
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
       stream and must survive menu close, so the panel stays mounted and
       laid out (the ResizeObserver needs measurable hosts — no
       display:none).
       OPACITY, not visibility alone (#1068): visibility is
       inheritable-but-child-overridable — a descendant stamping inline
       `visibility: visible` would paint as a floating ghost over the
       canvas. opacity composites the whole subtree; children cannot
       opt back in. The regression e2e pins the computed opacity. */
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
  }
  .io-panel.open {
    opacity: 1;
    visibility: visible;
    pointer-events: auto;
  }
  .io-columns {
    display: flex;
    gap: 10px;
    align-items: flex-start;
  }
  .io-col {
    display: flex;
    flex-direction: column;
    gap: 6px;
    /* Columns size to CONTENT (the plain-mounted card's natural box ×
       scale) — no fixed 250×330 host, no clipping, no dead space. */
    width: max-content;
  }
  .card-host {
    width: max-content;
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
