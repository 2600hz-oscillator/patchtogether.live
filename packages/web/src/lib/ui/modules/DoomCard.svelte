<script lang="ts">
  // DoomCard — the LEGACY-SHELL bridge for the DOOM video module.
  //
  // ⚠ THE GAME SURFACE MOVED, NOTHING WAS REWRITTEN. The keyboard capture, the
  // node-owned session adoption, the roster / netcode / lockstep wiring, the New
  // Game dialog, the blit loop and the `__doomCards` e2e hook now live in
  // `doom/DoomSurface.svelte`, which the legacy card and the v2 faceplate body
  // (`doom/DoomBody.svelte`) BOTH mount. One surface, one keyboard map, one
  // session adoption.
  //
  // WHY, in one sentence: promotion sets `migrated('doom')` and from that moment
  // the default shell renders `<ModuleShell>` instead of this card, so a face
  // body that did not carry the session wiring would ship a DOOM with no game in
  // it while every registry gate stayed green. The gibribbon
  // (`gibribbon/GibribbonScreen.svelte`) and nibbles (`nibbles-game-actions.ts`)
  // promotions made the same move for the same reason.
  //
  // ⚠ WHAT DELIBERATELY DID **NOT** MOVE: this card's own OUTPUT FIT + Volume
  // row, below. Those two params are CARD CHROME — the faceplate renders them as
  // ranked shell cells from `face.order`, so a shared copy would put two controls
  // on the plate for one param (which `faces-parity` counts rather than compares,
  // and would pass). And they must stay in a `*Card.svelte` for a second, sharper
  // reason: `card-def-agreement.test.ts` and `card-range-source.test.ts` scan
  // `*Card.svelte` ONLY, so a control that slipped out of their reach would take
  // its recorded card↔def divergence with it and the ledger entry would read as
  // PAID when nothing had been fixed — the silently-emptied-subject-set failure
  // `card-media-lifetime.test.ts` has now recorded three times.
  //
  // ⚠ AND THE CARD'S PIXELS DO NOT MOVE. `variant="card"` renders the identical
  // DOM this file rendered before — same root classes, same `data-testid`, same
  // stripe, header, PatchPanel, OUTPUT FIT row and hint footer, in the same order
  // — because `composite-doom-evt-{kill,door}-{idle,driven}.png` capture this
  // card at `?shell=legacy`, and every DOOM spec but one drives `?shell=legacy`.
  //
  // ⚠ NOTHING ABOUT THE GAME IS RE-TIMED. `runtime.runTic()` still runs inside
  // `surface.draw` in `video/modules/doom.ts`: DOOM's game clock is still its
  // frame clock, and this split introduces no second clock.
  import { type NodeProps } from '@xyflow/svelte';
  import type { ModuleNode } from '$lib/graph/types';
  import { setNodeParam } from '$lib/graph/mutate';
  import NativeFillToggle from './NativeFillToggle.svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import DoomSurface from './doom/DoomSurface.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode | undefined);

  // Per-source fit/fill: DOOM's viewport is fixed 8:5; the Native badge never
  // matches the output, so the fit/fill toggle is always shown (letterbox by
  // default — Mario-style pillarbox in 16:9).
  let fillMode = $derived<number>((node?.params?.fillMode as number | undefined) ?? 0);

  // Output volume (audioGain): a fixed +makeup gain lives in the PCM worklet
  // (the −42 dB i_pcmgen `>>6` fix); this knob trims on top of it, 0..2
  // (default 1). The engine's setParam picks the write up and forwards it
  // straight to the worklet on change.
  let audioGain = $derived<number>((node?.params?.audioGain as number | undefined) ?? 1);

  // ⚠ DEBT PAID, NOT MOVED (`raw-write-ledger.ts`). Both setters used to poke
  // `patch.nodes[id].params.<k> = v` directly, which is neither undoable nor
  // LOCAL_ORIGIN-tagged: Cmd-Z stepped straight over an OUTPUT FIT flip or a
  // Volume twist, and a collaborator could miss it. The ledger's own note is the
  // rule — "a face does not pay a card's debt; editing the card does" — so both
  // now go through the tracked `setNodeParam` seam. Same param, same value, same
  // engine path; only undo/sync semantics change, and no pixel moves.
  function setFillMode(v: number): void {
    setNodeParam(id, 'fillMode', v);
  }
  function setAudioGain(v: number): void {
    setNodeParam(id, 'audioGain', v);
  }
</script>

{#snippet controlsRow()}
  <div class="doom-fit-row" data-testid="doom-fit-row">
    <span class="doom-fit-label">OUTPUT FIT</span>
    <NativeFillToggle {fillMode} srcAspect={640 / 400} onchange={setFillMode} />
    <div class="doom-volume nodrag" data-testid="doom-volume">
      <Knob
        value={audioGain}
        min={0}
        max={2}
        defaultValue={1}
        label="Volume"
        curve="linear"
        onchange={setAudioGain}
        moduleId={id}
        paramId="audioGain"
      />
    </div>
  </div>
{/snippet}

<DoomSurface
  {id}
  data={data as { node?: ModuleNode } | undefined}
  variant="card"
  {controlsRow}
/>

<style>
  .doom-fit-row {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    /* Rack-compaction (#759): tighter margin to fit the 2u tier. */
    margin: 2px 0 1px;
  }
  .doom-fit-label {
    font-size: 0.6rem;
    color: var(--text-dim);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    font-family: ui-monospace, monospace;
  }
  .doom-volume {
    display: flex;
    align-items: center;
    margin-left: 4px;
  }
</style>
