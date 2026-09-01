<script lang="ts">
  // GibribbonCard — the LEGACY-SHELL card for the rewritten GIBRIBBON, now a
  // THIN BRIDGE: title + patch panel + the SAME shared playfield component
  // the dock faceplate body mounts (GibribbonScreen). One renderer-consumer,
  // one keyboard map — the card cannot diverge from the face.
  //
  // The module is AUDIO-DRIVEN: the course derives from the `audio_in` port
  // (the module's own analyser — see gibribbon.ts).
  //
  // ⚠ THE DOM HUD IS GONE ON PURPOSE. The old card's score/health/combo row,
  // GAME OVER overlay and tip line were the GAMES.md forbidden-chrome shape;
  // the rewrite paints score, combo, ATTRACT, count-in and GAME OVER INSIDE
  // the frame (the module's own rasteriser), and the speakable copy rides
  // aria-label on the playfield. The only text beside the screen is control
  // captions (RESET, WAD — inside the shared component).
  import type { NodeProps } from '@xyflow/svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import ModuleTitle from './ModuleTitle.svelte';
  import GibribbonScreen from './gibribbon/GibribbonScreen.svelte';

  let { id, data }: NodeProps = $props();

  // Ports — ids byte-identical to gibribbonDef (the audio-in design: ONE
  // source, aim, buttons, restart).
  const inputs: PortDescriptor[] = [
    { id: 'audio_in', label: 'AUDIO IN', cable: 'audio' },
    { id: 'x', label: 'X', cable: 'cv' },
    { id: 'y', label: 'Y', cable: 'cv' },
    { id: 'a', label: 'A', cable: 'gate' },
    { id: 'b', label: 'B', cable: 'gate' },
    { id: 'x_btn', label: 'X BTN', cable: 'gate' },
    { id: 'y_btn', label: 'Y BTN', cable: 'gate' },
    { id: 'restart', label: 'RESTART', cable: 'gate' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'out', label: 'OUT', cable: 'video' },
    { id: 'evt_hit', label: 'HIT', cable: 'gate' },
    { id: 'evt_miss', label: 'MISS', cable: 'gate' },
    { id: 'evt_fire', label: 'FIRE', cable: 'gate' },
    { id: 'evt_kill', label: 'KILL', cable: 'gate' },
    { id: 'evt_gameover', label: 'GAME OVER', cable: 'gate' },
    { id: 'health_cv', label: 'HEALTH', cable: 'cv' },
  ];
</script>

<div class="mod-card gibribbon-card">
  <div class="stripe" style="background: var(--cable-video);"></div>
  <ModuleTitle {id} {data} defaultLabel="GIBRIBBON" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="body">
      <GibribbonScreen nodeId={id} />
    </div>
  </PatchPanel>
</div>

<style>
  .mod-card {
    width: max-content;
    min-width: 520px;
    background: var(--module-bg);
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text);
    padding: 18px 30px 12px;
    position: relative;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    outline: none;
  }
  :global(.svelte-flow__node:hover) .mod-card { border-color: var(--accent-dim); }
  :global(.svelte-flow__node.selected) .mod-card {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .stripe { position: absolute; top: 0; left: 0; right: 0; height: 2px; border-radius: 2px 2px 0 0; }
  .body {
    /* Clear the PatchPanel's top-left/right trigger affordances. */
    margin-top: 24px;
    display: flex;
    justify-content: center;
    padding-bottom: 6px;
  }
</style>
