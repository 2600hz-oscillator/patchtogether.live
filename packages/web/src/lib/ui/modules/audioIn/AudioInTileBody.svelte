<script lang="ts">
  // The AUDIO IN lane tile's own controls: pick an input, see whether it is
  // capturing, and START it — without expanding the module.
  //
  // ⚠ WITHOUT THIS THE TILE IS A DEAD END, AND WORSE THAN CAMERA'S WAS. ENABLE
  // is the only route to a FIRST microphone grant, and `audioIn` is in neither
  // `DOM_SOURCE_LANE_TYPES` nor `CARD_PRODUCER_LANE_TYPES`, so promotion leaves
  // NO card mounted anywhere to reach instead — not even the off-screen
  // `<HeadlessSourceHost>` copy `cameraInput` falls back to. A tile with a live
  // meter glyph and no way to open a device would be a module that reads as
  // broken and is in fact merely shut.
  //
  // The PICTURE is not here: the shell's glyph slot already paints this face's
  // live output meter (`face.glyph: 'meter'` resolves to a `live-audio` binding
  // on `audio_l_out`). This adds the controls that meter needs in order to have
  // anything to show.
  import AudioInSourceControls from './AudioInSourceControls.svelte';

  interface Props {
    nodeId: string;
  }
  let { nodeId }: Props = $props();
</script>

<div class="tile-audioin">
  <AudioInSourceControls {nodeId} testidPrefix="audioin-tile" compact />
</div>

<style>
  .tile-audioin {
    width: 100%;
    padding: 2px 4px 4px;
    box-sizing: border-box;
  }
</style>
