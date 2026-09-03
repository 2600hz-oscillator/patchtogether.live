<script lang="ts">
  // TrailsTileBody — the LANE TILE's strip: the pad mirror at 40 px beside the
  // LINK lamp, read-only.
  //
  // ⚠ THE SIZE IS DERIVED FROM THE BUDGET, NOT CHOSEN. From
  // `module-shell-model.ts`: the tile is `SHELL_TILE_W` (192) wide, its body
  // inner width is 172 px, and `LANE_BODY_H` is 112 px. Both `range` and
  // `divisor` declare `options`, and ANY param declaring `options`/`landmarks`
  // earns a readout (`earnsReadout` → `paintsReadout`), so the compact row is
  // `LANE_KNOB_READOUT_H` = 57 px rather than the 42 px design row. That leaves
  // 112 − 57 − 4 ≈ 51 px for this body, so it is ONE strip: a 40 × 46 px mirror
  // with the lamp beside it in the ~120 px of horizontal room the mirror does
  // not use, costing one row of height rather than two.
  //
  // ⚠ MON IS NOT HERE, BY MEASUREMENT RATHER THAN TASTE. The `<pre>` is a
  // 22-character padded label plus a count and a value per row; at 172 px of
  // inner width it is unreadable, and the panel alone is taller than the whole
  // remaining budget. The gesture MON serves — diagnose the wire — is a sit-down
  // activity, unlike CONNECT, which must be reachable where the module is met
  // and is therefore a ranked `action` cell in the band above this strip.
  //
  // ⚠ THE BAR CAPTION IS NOT HERE EITHER: 8 px of prose under a 46 px picture.
  // The HATCH is, because it is canvas rather than text and it is the part that
  // does the work at a glance.
  //
  // ⚠ READ-ONLY, AND THE TESTIDS ARE NAMESPACED. `ModuleShell` renders this slot
  // only `{#if !extBody}`, so the tile and the dock body are counterparts rather
  // than siblings — but a lane tile and an open dock pane for the SAME node are
  // two shell instances mounted at once, so a shared testid stem would put two
  // elements behind one selector (the bug skifree's extension header names).
  // Hence `trails-tile-*` here and `trails-face-*` there.
  //
  // ⚠ NOTHING EXPENSIVE RUNS AT MOUNT. The module auto-binds nothing and asks
  // the browser for nothing: `requestMIDIAccess` is reached only from the
  // CONNECT gesture, the decoder and all twenty-one `ConstantSource`s live in the
  // FACTORY, and this component's whole mount cost is one canvas fill plus a
  // subscription to a `writable(0)`. That is the bar #2314 set — a tile body
  // that probed a real encoder on every rack boot cost 60 VRT scenes.

  import { onDestroy } from 'svelte';
  import { StatusLed } from '$lib/ui/controls';
  import { trailsMidiVersion, trailsStatus, type TrailsStatus } from '$lib/midi/trails-device';
  import { trailsApi } from '../trails-cell-actions';
  import TrailsPadMirror from './TrailsPadMirror.svelte';
  import { trailsLamp } from './trails-status-model';

  let { nodeId }: { nodeId: string } = $props();

  /** 40 px wide → 46 px tall at the panel's own 85/98 aspect. Four coloured dots
   *  at that size is a GLANCE — "is a finger down, and roughly where" — which is
   *  the claim skifree's tile body makes for its 104 px slope. */
  const TILE_MIRROR_W = 40;

  // Init-time subscribe + `onDestroy`, for the reason the dock body's header
  // records: neither store sugar nor an `$effect` bridge delivers these bumps.
  let midiV = $state(0);
  onDestroy(
    trailsMidiVersion.subscribe((n) => {
      midiV = n;
    }),
  );

  let status = $derived.by<TrailsStatus | null>(() => {
    void midiV;
    return trailsApi(nodeId)?.status() ?? trailsStatus();
  });
  let lamp = $derived(trailsLamp(status));
</script>

<div class="trails-tile" data-testid="trails-tile-body-{nodeId}">
  <TrailsPadMirror {nodeId} width={TILE_MIRROR_W} testidPrefix="trails-tile" />
  <StatusLed
    caption="LINK"
    lit={lamp.lit}
    tone={lamp.tone}
    detail={lamp.detail}
    testid="trails-tile-led-{nodeId}"
  />
</div>

<style>
  .trails-tile {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 6px 2px;
    box-sizing: border-box;
    width: 100%;
  }
</style>
