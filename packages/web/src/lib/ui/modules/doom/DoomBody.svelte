<script lang="ts">
  // packages/web/src/lib/ui/modules/doom/DoomBody.svelte
  //
  // The DOOM dock full-view body: the shared DoomSurface (one screen, one
  // keyboard map, one session adoption — both surfaces mount it) plus the
  // per-node SCREEN switch the video-face canon requires.
  //
  //   SCREEN  (#1928, the 2026-08-18 owner ruling) — `previewCollapsed` on
  //           node.data, the SAME key every other video face uses, so a preview
  //           collapsed before the promotion stays collapsed after it.
  //
  //   MONITOR (#2009, face.monitor) — `hideControls` on node.data: hide the
  //           control bands and watch the marine, because DOOM's POV IS the
  //           video output a rack projects. The shell suppresses the bands
  //           (`faceMonitorPlan`); this body owns only the button. ⚠ It hides
  //           the two OUTPUT TRIMS (Volume, OUTPUT FIT) and nothing a player
  //           needs mid-game: the screen, the keyboard, the Join button and the
  //           New Game dialog all live in this body, which MONITOR does not
  //           touch — so unlike a synth face, monitor mode here cannot take away
  //           the instrument.
  //
  // ⚠ SCREEN OFF STOPS THE BLIT AND NOTHING ELSE — and for DOOM that sentence
  // has to be exact, because DOOM's GAME CLOCK IS ITS FRAME CLOCK. The game does
  // NOT advance on this component's rAF: `runtime.runTic()` runs inside
  // `surface.draw` in `video/modules/doom.ts`, driven by the VIDEO ENGINE's own
  // loop. What this body collapses is the card-style 2-D `putImageData` copy of
  // a framebuffer the engine has already produced. So OFF costs a picture, never
  // a tic — and never a netgame: a lockstep peer that stopped ticking would
  // starve every other peer's barrier (#345 semantics), which is the one failure
  // this module cannot afford.
  //
  // ⚠ NO WATCH MARK IS ADDED, and that is measured rather than assumed.
  // `VideoEngine.isPullExempt` names DOOM in its own comment: a non-empty
  // `audioSources` map (DOOM publishes audio_l/audio_r plus 30 event gates) makes
  // the node a pull ROOT unconditionally, so it renders with nothing watching and
  // no `markWatched` call on any path. The card never marked it either — its blit
  // reads `extras.snapshotFramebuffer()` directly, not through the engine — so
  // adding a mark here would be new behaviour dressed as parity.
  //
  // ⚠ THE SESSION, THE KEYBOARD AND THE MULTIPLAYER DIALOGS STAY MOUNTED WITH
  // THE SCREEN OFF. gibribbon collapses its whole playfield component because
  // unmounting it releases keyboard capture by construction; DOOM must not, in
  // either half. Unmounting DoomSurface would drop `__doomCards`, the awareness
  // observers and the Join / New Game / Launch affordances — so a host who
  // reclaimed some dock space would have taken the lobby down with it. Only the
  // <canvas> is inside the collapse.
  //
  // ⚠ STATE LIVES ON THE NODE, NOT IN THIS COMPONENT (#1531/#1574/#1583): this
  // component unmounts on dock collapse and LRU eviction, and node.data survives
  // a remount, a reload, and syncs to collaborators. One boolean per CLICK.
  //
  // ⚠ NO DERIVED TEXT LIVES HERE. DOOM paints its own HUD — health, armour, ammo
  // and the status-bar face — INSIDE its framebuffer, which is the module's own
  // artwork and the shape the GAMES.md ruling permits (that ruling cites this
  // module without naming it). The only literal text this body renders is the
  // SCREEN control's own caption.
  import { patch } from '$lib/graph/store';
  import { mutateNode } from '$lib/graph/mutate';
  import DoomSurface from './DoomSurface.svelte';

  interface Props {
    /** The graph node this faceplate is showing — the ONLY prop the slot gets
     *  (`ShellExtensionFullViewBodyProps`). */
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

<div class="doom-body" data-testid="doom-body">
  <div class="preview-wrap" data-preview-collapsed={previewCollapsed ? 'true' : 'false'}>
    <DoomSurface id={nodeId} variant="face" {previewCollapsed} />
    <div class="switches">
      <button
        type="button"
        class="switch-btn nodrag"
        class:on={!previewCollapsed}
        onclick={togglePreview}
        data-testid="doom-face-screen-toggle"
        aria-pressed={!previewCollapsed}
        title="SCREEN: turn the picture off to reclaim its space. The game keeps running — DOOM ticks inside the video engine's own draw, not this preview — so a netgame stays in lockstep and the event gates keep firing."
      >SCREEN {previewCollapsed ? 'OFF' : 'ON'}</button>
      <button
        type="button"
        class="switch-btn nodrag"
        class:on={hideControls}
        onclick={toggleMonitor}
        data-testid="doom-monitor-toggle"
        aria-pressed={hideControls}
        title="MONITOR: hide the two output trims and watch the marine — DOOM's POV is the video output a rack projects. The screen, the keyboard and the multiplayer controls stay."
      >MONITOR</button>
    </div>
  </div>
</div>

<style>
  .doom-body {
    display: flex;
    justify-content: center;
    padding: 6px 0 2px;
  }
  .preview-wrap {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    /* Load-bearing only with SCREEN OFF: keeps the switch row from collapsing
       the wrap to zero height. */
    min-height: 22px;
  }
  .switches {
    display: flex;
    gap: 6px;
    align-self: flex-start;
    padding: 2px 0 0 4px;
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
