<script lang="ts">
  // packages/web/src/lib/ui/modules/audioIn/AudioInSourceBody.svelte
  //
  // THE AUDIO IN faceplate body: the input-device picker, the two capture lamps,
  // the acquire/stop gesture and music mode.
  //
  // ⚠ IT IS THE PINNED INSTANCE'S ONLY SURFACE. `pinned-audioIn` is
  // canvas-hidden — no lane tile, no EXPAND pill, no route to `DockFullView` —
  // and the 🎧 topbar tray hosts it through `DockCardHost` at `view='drawer'`,
  // which `dockFullViewHeadPlan` treats as a faceplate view. So this body, not
  // the tile's, is what every user meets in every session.
  //
  // ⚠ NO CANVAS, EVER. Its `EXTENSION_BODY_ROLES` role is `status-primitive`,
  // whose predicate is "imports StatusLed and mounts NO drawing surface" — the
  // negative half follows the mount, so a picture component rendered here would
  // redden it. Spelled out in words because the predicate greps raw source and
  // cannot tell code from a comment. Beyond the gate: attest-basis membership is
  // derived from CONTENT, and a drawn body would enrol an audio def in the
  // real-GPU attest for nothing.
  //
  // ⚠ AND NO METER HERE, WHICH IS THE ONE PLACE THIS BODY DIFFERS FROM
  // `audioOut`'s. Its sibling paints a terminal meter because `audioOut`
  // declares `outputs: []`, so `primaryAudioOutPortId` is null, the glyph is
  // mechanically dead and the body is the only place a level could go. AUDIO IN
  // declares two real audio outputs, so `glyphBinding` resolves `live-audio` on
  // `audio_l_out` and the SHELL paints the level on the LANE TILE, where a rack
  // is read at a glance and where `audioOut` can never have one.
  //
  // ⚠ MEASURED, NOT ASSUMED, ABOUT THIS SURFACE SPECIFICALLY: on a FACEPLATE
  // view `dockFullViewHeadPlan` returns `heroGlyph: hasGlyph && !(dock &&
  // (heroCell || hasExtensionBody))`, so declaring this body SUPPRESSES the hero
  // glyph here — the tray shows the body and the fader and no meter. That is not
  // a loss: `AudioinCard` never drew one either, so the tray keeps exactly the
  // picture it had while the lane tile GAINS one. A meter inside this body would
  // buy it back at the cost of the `status-primitive` role and a second
  // derivation of a level the tile already draws, which is why it is refused
  // here and named rather than left to be re-discovered.
  //
  // ⚠ NO SCREEN ON/OFF SWITCH, and this is the ruling applied rather than
  // skipped: `video-face-screen-source.test.ts` sweeps
  // `listVideoModuleDefs() ∩ STRICT_FACES`, and `audioIn` is `domain: 'audio'`,
  // so the gate cannot reach it either way and needs no exemption. There is also
  // nothing to switch off — this body draws no picture. Likewise NO
  // `markWatched`: that is a `VideoEngine` pull-set concept this module has no
  // part in.
  import AudioInSourceControls from './AudioInSourceControls.svelte';

  interface Props {
    /** The graph node this faceplate is showing — the ONLY prop the slot gets
     *  (`ShellExtensionFullViewBodyProps`). */
    nodeId: string;
  }
  let { nodeId }: Props = $props();
</script>

<div class="audioin-body" data-testid="audioin-source-body">
  <AudioInSourceControls {nodeId} testidPrefix="audioin-face" />
</div>

<style>
  /* ⚠ THIS BODY CONTRIBUTES NO INTRINSIC WIDTH — the measured shape
     `AudioOutOutputBody` arrived at. `width: 100%` resolves as `auto` for the
     parent's intrinsic sizing, so the body adds nothing to how wide the plate
     WANTS to be and then occupies all of whatever it turns out to be. No floor,
     no `FACE_WIDTH_EXEMPTIONS` entry, and no number here that can go stale when
     a neighbour changes. */
  .audioin-body {
    display: flex;
    flex-direction: column;
    padding: 8px 0 2px;
    width: 100%;
    min-width: 0;
  }
</style>
