<script lang="ts">
  // packages/web/src/lib/ui/modules/moog956/Moog956RibbonBody.svelte
  //
  // THE 956's DOCK SURFACE — the playable ribbon at the head of the dock full
  // view, at the full width of the plate.
  //
  // ⚠ WIDTH IS THE REASON THIS IS A BODY AND NOT A CELL. The ladder was walked
  // rather than skipped: `selector`/`toggle`/`file` are refused (nothing here
  // is a roster, a latch or a file); the ranked `fader` cell over `pos` is
  // REAL and survives in the band below — it is the LANE's answer — but a
  // ~46 px knob-column cell inverts the gesture (the hardware ribbon is
  // horizontal and shoulder-wide) and a fader drag cannot DROP THE GATE ON
  // RELEASE, which is the half of the gesture that makes this a controller;
  // `xyPads` is the wrong arity (a pad binds two CONTINUOUS axes and `gate` is
  // a momentary, which module-face-lint refuses — correctly); a PF-14 `panel`
  // cell is a picture-you-edit INSIDE the band grid, and this control's
  // PRECISION is its width (≈ 8 px per semitone across a 2-octave default
  // span). `fullViewBody` is the slot for a module that brings its own
  // full-width surface.
  //
  // ⚠ IT IS A COMPLEMENT, NEVER A REPLACEMENT — the seam's own rule (the
  // `warrensspectrum` failure). The four param cells still render in the band
  // beneath this strip, untouched, which is what keeps face completeness, the
  // dock render-plan parity gate and `faces-parity` applicable to a module
  // with a body.
  //
  // ⚠ THE ACCESSIBLE NAME IS ON THIS GROUP, and it is not decoration: the
  // body's `EXTENSION_BODY_ROLES` role is `control-grid`, whose predicate is
  // "sets `aria-label` on what it paints and mounts NO canvas". A control grid
  // carries its MEANING in the accessible name — the resting-text ruling's home
  // for a sentence that must be speakable and unpainted — and the strip's own
  // live value rides its `aria-valuetext` one level down.
  //
  // ⚠ NO SCREEN SWITCH and NO WATCH MARK: `video-face-screen-source` sweeps
  // `STRICT_FACES ∩ video defs` and this is `domain: 'audio'`; `markWatched`
  // is a VideoEngine pull-set concept this module has no part in.
  import Moog956RibbonStrip from './Moog956RibbonStrip.svelte';

  interface Props {
    /** The graph node this faceplate is showing — the ONLY prop the slot gets
     *  (`ShellExtensionFullViewBodyProps`). */
    nodeId: string;
  }
  let { nodeId }: Props = $props();
</script>

<div
  class="ribbon-body"
  role="group"
  aria-label="956 ribbon controller — press and slide to play"
  data-testid="moog956-face-body"
  data-node-id={nodeId}
>
  <Moog956RibbonStrip {nodeId} testidPrefix="moog956-face" />
</div>

<style>
  /* No intrinsic width contributed — see the strip's own note. */
  .ribbon-body {
    display: flex;
    flex-direction: column;
    padding: 8px 0 4px;
    width: 100%;
    min-width: 0;
  }
</style>
