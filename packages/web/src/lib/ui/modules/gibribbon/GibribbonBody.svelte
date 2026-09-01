<script lang="ts">
  // packages/web/src/lib/ui/modules/gibribbon/GibribbonBody.svelte
  //
  // The GIBRIBBON dock full-view body: the game screen (the shared
  // GibribbonScreen — one playfield, one keyboard map, both surfaces) plus
  // the two per-node switches the face platform requires of it:
  //
  //   SCREEN  (#1928, video-face canon) — previewCollapsed on node.data, the
  //           SAME key the legacy card idiom uses. OFF unmounts the playfield,
  //           which skips the blit AND releases keyboard capture by
  //           construction. ⚠ The ENGINE KEEPS TICKING: the game runs on the
  //           shared scheduler clock inside the module factory, so attract
  //           keeps generating evt_* gates — the sequencer half of the module
  //           working as designed, with the screen dark.
  //
  //   MONITOR (#2009, face.monitor) — hideControls on node.data: hide the
  //           control bands and watch the ribbon, because the game IS the
  //           video output a rack projects. The shell suppresses the bands
  //           (faceMonitorPlan); this body owns only the button.
  //
  // ⚠ STATE LIVES ON THE NODE, NOT IN THIS COMPONENT (#1531/#1574/#1583):
  // this component unmounts on dock collapse / LRU eviction, and node.data
  // survives a remount, a reload and syncs to collaborators. One boolean per
  // CLICK, never per frame.
  //
  // ⚠ NO DERIVED TEXT LIVES HERE. Score / combo / ATTRACT / GAME OVER are
  // painted INSIDE the frame by the module's rasteriser (the GAMES.md
  // permitted shape); the speakable copy rides aria-label on the playfield
  // inside GibribbonScreen. The only literal text this body renders is
  // control captions (SCREEN / MONITOR — plus RESET / WAD inside the shared
  // screen component), which the resting-text ruling permits. That claim is
  // pinned, negative-controlled, in gibribbon-face-model.test.ts.
  import { patch } from '$lib/graph/store';
  import { mutateNode } from '$lib/graph/mutate';
  import GibribbonScreen from './GibribbonScreen.svelte';

  interface Props {
    /** The graph node this faceplate is showing — the ONLY prop the slot
     *  gets (`ShellExtensionFullViewBodyProps`). */
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  let previewCollapsed = $derived<boolean>(
    (patch.nodes[nodeId]?.data?.previewCollapsed as boolean | undefined) ?? false,
  );
  function togglePreview(): void {
    const next = !previewCollapsed;
    mutateNode(nodeId, (live) => {
      if (!live.data) live.data = {};
      live.data.previewCollapsed = next;
    });
  }

  let hideControls = $derived<boolean>(
    (patch.nodes[nodeId]?.data?.hideControls as boolean | undefined) ?? false,
  );
  function toggleMonitor(): void {
    const next = !hideControls;
    mutateNode(nodeId, (live) => {
      if (!live.data) live.data = {};
      live.data.hideControls = next;
    });
  }
</script>

<div class="gibribbon-body" data-testid="gibribbon-body">
  <div class="preview-wrap" data-preview-collapsed={previewCollapsed ? 'true' : 'false'}>
    {#if !previewCollapsed}
      <GibribbonScreen {nodeId} />
    {/if}
    <div class="switches">
      <button
        type="button"
        class="switch-btn nodrag"
        class:on={!previewCollapsed}
        onclick={togglePreview}
        data-testid="gibribbon-screen-toggle"
        aria-pressed={!previewCollapsed}
        title="SCREEN: turn the picture off to reclaim its space. The game keeps running on the scheduler clock — attract keeps playing and the evt gates keep firing — and turning it off releases the keyboard."
      >SCREEN {previewCollapsed ? 'OFF' : 'ON'}</button>
      <button
        type="button"
        class="switch-btn nodrag"
        class:on={hideControls}
        onclick={toggleMonitor}
        data-testid="gibribbon-monitor-toggle"
        aria-pressed={hideControls}
        title="MONITOR: hide the control bands and watch the ribbon — the game is the video output a rack projects."
      >MONITOR</button>
    </div>
  </div>
</div>

<style>
  .gibribbon-body {
    display: flex;
    justify-content: center;
    padding: 6px 0 2px;
  }
  .preview-wrap {
    position: relative;
    display: flex;
    justify-content: center;
    /* Load-bearing only with SCREEN OFF: keeps the switch row from
       collapsing the wrap to zero height. */
    min-height: 22px;
  }
  .switches {
    position: absolute;
    left: 4px;
    bottom: 4px;
    display: flex;
    gap: 6px;
  }
  .switch-btn {
    font-size: 0.55rem;
    letter-spacing: 0.06em;
    padding: 2px 8px;
    border: 1px solid var(--border);
    border-radius: 2px;
    background: rgba(5, 6, 8, 0.72);
    color: var(--text-dim);
    cursor: pointer;
    font-family: ui-monospace, monospace;
  }
  .switch-btn.on { color: var(--text); border-color: var(--accent-dim); }
  .switch-btn:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
</style>
