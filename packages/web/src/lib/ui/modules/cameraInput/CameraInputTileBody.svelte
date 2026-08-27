<script lang="ts">
  // The CAMERA lane tile's own controls: pick a camera, see the capture state,
  // and START capture — without expanding the module.
  //
  // ⚠ WITHOUT THIS THE TILE IS A DEAD END. The extension filled `fullViewBody`
  // and nothing else, so the picker and the ONLY clickable route to
  // getUserMedia existed solely in the dock full view. The tile showed a
  // thumbnail with no stream behind it and offered no way to get one, which is
  // the def's own point 3 ("a live source with no way to START it") reappearing
  // one surface further out.
  //
  // The picture itself is NOT here: the shell's glyph slot already paints a
  // live thumbnail for any video face (`VideoTileThumb`, gated on
  // hasVideoSurface). This adds the controls that thumbnail needs to have
  // something to show.
  import CameraSourceControls from './CameraSourceControls.svelte';

  interface Props {
    nodeId: string;
  }
  let { nodeId }: Props = $props();
</script>

<div class="tile-camera">
  <CameraSourceControls {nodeId} testidPrefix="cameraInput-tile" compact />
</div>

<style>
  .tile-camera {
    width: 100%;
    padding: 2px 4px 4px;
    box-sizing: border-box;
  }
</style>
