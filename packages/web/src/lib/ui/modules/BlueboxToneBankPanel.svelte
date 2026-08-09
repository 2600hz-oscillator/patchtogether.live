<script lang="ts">
  // BlueboxToneBankPanel — the faceplate's HERO PICTURE: the ten-slot TONE BANK.
  //
  // ⚠ NOT A TRACE, and not a spectrum analyser. Every bar is computed from the
  // LIVE key state through the worklet's OWN frequency table
  // (`bluebox-face-model`), so it is the TARGET the bank is heading for rather
  // than a reading of what came out. That is the whole point: this module has no
  // oscillator per key. It has ONE fixed bank of ten sines, and a held key
  // RAISES the target amplitude of each frequency it lights
  // (`ampTarget[f] += BUTTON_VOICE_AMP`, packages/dsp/src/bluebox.ts). Two keys
  // that share a tone drive ONE bar twice as hard instead of running two
  // independent voices, which is why {1,4} is 1.76 dB louder than {1,5}. There
  // is no other surface anywhere on which that is visible.
  //
  // ⚠ THE PICTURE IS LEGIBLE ON A SILENT RACK, deliberately. Every bar carries
  // its frequency, its band tint and its CAPACITY outline — how many keys could
  // ever light it — so column 1336 reads as the tall one (2, 5, 8 and 0 all pull
  // it) before anything is held. A hero that is blank at rest teaches nothing.
  //
  // ⚠ IT DOES NOT MOVE UNDER A FACEPLATE PRESS OR A GATE CABLE, and that is the
  // platform, not this panel. A `face.momentary` press writes the ENGINE ONLY
  // ($lib/audio/momentary-params) and a gate is a worklet NODE INPUT, so neither
  // reaches `node.params` — the same single source `ModuleShell.readoutValue`
  // reads for the three readouts beside this picture. Pointing the panel at the
  // live engine while those readouts stayed at zero would trade one honest
  // source for two that disagree. The bank lights for every DURABLE route into
  // the keys (group/instrument bar, MIDI CC, automation, preset recall, the
  // legacy card). Filed as a platform follow-up: a live-engine reader for
  // `FaceReadout`.
  //
  // ⚠ THIS PANEL EMITS NO `control-<paramId>` TESTID (shell-cells rule 1). Its
  // one writable affordance is the CAPTION MODE, which is PRIVATE VIEW STATE
  // (component state, never `node.data`: relabelling your own picture must not
  // relabel every collaborator's screen or dirty the patch).

  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import {
    BLUEBOX_MAX_SLOT_KEYS,
    blueboxBankBars,
    blueboxBarCaption,
    blueboxHeld,
  } from './bluebox-face-model';

  interface Props {
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  /** ⚠ THE VERSION IS CARRIED IN THE RESULT (the ModuleShell `liveCell`
   *  pattern). `patch.nodes[id]` is a stable SyncedStore proxy, so a derived
   *  that bumps on `nodeVersion(id)` and returns it BARE is `===` to its
   *  previous value and the whole picture freezes at first render. */
  let live = $derived.by(() => ({ v: nodeVersion(nodeId), n: patch.nodes[nodeId] }));

  let bars = $derived.by(() =>
    blueboxBankBars(
      blueboxHeld((id) => {
        const v = live.n?.params?.[id];
        return typeof v === 'number' ? v : undefined;
      }),
    ),
  );

  /** COMPONENT STATE — see the header. `hz` names each oscillator; `keys` reads
   *  the Bell grid BACKWARDS and is the direct answer to "why did those two
   *  stack". The flip is also this panel's declared operability probe: it drives
   *  the caption row's text, which a dead button cannot change. */
  let labelMode = $state<'hz' | 'keys'>('hz');
</script>

<div class="bank" data-testid="bluebox-tonebank">
  <div class="bars" role="img" aria-label="the ten-oscillator tone bank, {labelMode === 'hz' ? 'labelled by frequency' : 'labelled by the keys that light each slot'}">
    {#each bars as bar (bar.hz)}
      <div class="slot" data-band={bar.band} data-count={bar.count}>
        <!-- The CAPACITY outline: how tall this slot could ever get. Drawn
             always, so the bank's shape is readable before anything is held. -->
        <div class="track" style={`--cap:${bar.capacity / BLUEBOX_MAX_SLOT_KEYS}`}>
          <div class="cap"></div>
          <div class="fill" style={`--h:${bar.height}`}></div>
          {#if bar.count > 1}
            <!-- STACKING IS LABELLED, NOT INFERRED: a bar at 2 keys is the
                 whole architectural claim, so it says "×2" rather than leaving
                 the player to compare heights. -->
            <span class="mult">×{bar.count}</span>
          {/if}
        </div>
      </div>
    {/each}
  </div>

  <div class="axis">
    <!-- ⚠ THE CAPTION ROW IS THE PANEL'S OPERABILITY PROBE TARGET. Its text is
         computed from the label mode, so a MODE button that did nothing cannot
         change it — which is what makes the `text` probe on this element a real
         liveness assertion rather than a button relabelling itself.
         `bluebox-face-model.test.ts` asserts the two modes can never render the
         same string for any slot. -->
    <span class="axis-ticks" data-testid="bluebox-bank-axis">
      {#each bars as bar (bar.hz)}<span>{blueboxBarCaption(bar, labelMode)}</span>{/each}
    </span>
    <button
      type="button"
      class="mode"
      data-testid="bluebox-bank-label"
      title="Label the ten oscillators by FREQUENCY or by the KEYS that light each one (the Bell grid read backwards). Your screen only: this is not shared or saved."
      onclick={() => (labelMode = labelMode === 'hz' ? 'keys' : 'hz')}
    >{labelMode === 'hz' ? 'Hz' : 'keys'}</button>
  </div>

  <div class="key">
    <span class="k-row">rows</span>
    <span class="k-col">columns</span>
    <span class="k-inband">in-band · no digit</span>
  </div>
</div>

<style>
  .bank {
    width: 100%;
    display: grid;
    grid-template-rows: 1fr auto auto;
    gap: 3px;
  }

  .bars {
    display: grid;
    grid-template-columns: repeat(10, 1fr);
    gap: 3px;
    height: 104px;
    padding: 4px;
    background: rgb(0 0 0 / 0.35);
    border: 1px solid rgb(255 255 255 / 0.08);
    border-radius: 3px;
  }

  .slot {
    display: flex;
    align-items: flex-end;
    min-width: 0;
  }

  /* The track is the FIXED axis (four keys, the most any one slot can stack).
     `--cap` is this slot's own ceiling inside it. */
  .track {
    position: relative;
    width: 100%;
    height: 100%;
  }
  .cap {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: calc(var(--cap) * 100%);
    border: 1px dashed rgb(255 255 255 / 0.16);
    border-radius: 2px 2px 0 0;
  }
  .fill {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: calc(var(--h) * 100%);
    border-radius: 2px 2px 0 0;
    background: var(--band-hue);
  }
  .mult {
    position: absolute;
    left: 0;
    right: 0;
    bottom: calc(var(--h) * 100%);
    text-align: center;
    font-size: 8px;
    line-height: 1.4;
    color: var(--band-hue);
    font-variant-numeric: tabular-nums;
  }

  /* Three BANDS, three hues — rows and columns are the Bell grid, and the
     in-band tones belong to no digit at all, which is the module's name. */
  .slot[data-band='row'] {
    --band-hue: var(--domain, #4dd6c1);
  }
  .slot[data-band='col'] {
    --band-hue: #7fb2ff;
  }
  .slot[data-band='inband'] {
    --band-hue: #f0a44a;
  }

  .axis {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 9px;
    color: rgb(255 255 255 / 0.42);
    font-variant-numeric: tabular-nums;
  }
  .axis-ticks {
    flex: 1 1 auto;
    min-width: 0;
    display: grid;
    grid-template-columns: repeat(10, 1fr);
    gap: 3px;
  }
  .axis-ticks > span {
    text-align: center;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mode {
    appearance: none;
    background: rgb(255 255 255 / 0.06);
    border: 1px solid rgb(255 255 255 / 0.12);
    border-radius: 3px;
    color: inherit;
    font: inherit;
    padding: 1px 5px;
    cursor: pointer;
  }
  .mode:hover {
    background: rgb(255 255 255 / 0.12);
  }

  .key {
    display: flex;
    gap: 10px;
    font-size: 9px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .k-row {
    color: var(--domain, #4dd6c1);
  }
  .k-col {
    color: #7fb2ff;
  }
  .k-inband {
    color: #f0a44a;
  }
</style>
