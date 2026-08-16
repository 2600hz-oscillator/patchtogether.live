<script lang="ts">
  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { mixmstrsSectionPlan } from './mixmstrs-sections';
  import { mixmstrsDef, MIXMSTRS_CHANNELS, MIXMSTRS_RETURNS } from '$lib/audio/modules/mixmstrs';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { set, live } = cardParams(mixmstrsDef, () => id, () => node);

  let compact = $state(false);

  function paramVal(id_: string, fallback: number): number {
    const v = node?.params?.[id_];
    return typeof v === 'number' ? v : fallback;
  }

  // Channel + return lists come FROM THE DEF, never re-typed here — a card that
  // hardcodes what its def declares is invisible to every def-reading gate (the
  // repo's card-vs-def divergence rule). Adding a channel or a return upstream
  // now grows this card automatically.
  const CH = MIXMSTRS_CHANNELS;
  const RET = MIXMSTRS_RETURNS;

  // Sectioned grouping: Ch1..Ch8 + Master, so the patch panel's
  // click-to-expand UX kicks in (each section's row list collapses by
  // default; user clicks a header to fan out the channel's handles).
  // Without this the full input column overflows even a 1366×768 viewport
  // when every section is expanded simultaneously.
  //
  // The audio + CV ports for each channel live in the same section so
  // the user can scan one channel's full I/O surface in a single
  // expand. Returns + master live under the Master section alongside
  // the master-bus volume + the 6 master/send outputs.
  // Sections come from the extracted PURE builder (mixmstrs-sections.ts).
  // It used to live here as an inline `pickInputs` that SILENTLY DROPPED any id
  // the def does not declare — invisible to every gate, because a list inside a
  // `.svelte` file is unreachable from the unit lane. It is now an artifact
  // `mixmstrs-sections.test.ts` counts rows against.
  //
  // The rows are RAW per-leg descriptors; PatchPanel collapses `ch1L`/`ch1R`
  // into one CH1 jack centrally, so this card knows nothing about stereo.
  const sections = mixmstrsSectionPlan(mixmstrsDef, CH, RET).sections;
</script>

<div class="mod-card mixmstrs-card" class:compact>
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <header class="title">
    <ModuleTitle {id} {data} defaultLabel="MIXMSTRS" inline />
    <button class="toggle" onclick={() => (compact = !compact)} title={compact ? 'Expand' : 'Compact'}>
      {compact ? '◇' : '◆'}
    </button>
  </header>

  <!--
    panelWidth is the total open-state popover width. With the
    two-column open layout (inputs left, outputs right), 560 gives
    each column ~265px — wide enough for verbose labels like
    "ch1 SEND 1" without truncation. MIXMSTRS's input field is by far
    the largest in the fleet (a strip's worth of audio + CV per channel,
    plus the returns and master); sections
    collapse by default via PatchPanel's click-to-expand UX so the
    panel fits on a 1366×768 laptop viewport even with one or two
    sections open.
  -->
  <PatchPanel nodeId={id} groupingStrategy="sectioned" {sections} panelWidth={560}>
    <div class="grid" style={`--strip-cols:${CH.length + RET.length}`}>
      {#each CH as ch (ch)}
        <div class="ch-col">
          <div class="ch-label">CH {ch}</div>
          <Knob value={paramVal(`ch${ch}_volume`, 0.8)} min={0}    max={1}   defaultValue={0.8} label="Vol" curve="linear"   onchange={set(`ch${ch}_volume`)} moduleId={id} paramId={`ch${ch}_volume`}     readLive={live(`ch${ch}_volume`)} />
          {#if !compact}
            <Knob value={paramVal(`ch${ch}_low`, 0)}    min={-12}  max={12}  defaultValue={0}   label="LOW" curve="linear"   onchange={set(`ch${ch}_low`)} moduleId={id} paramId={`ch${ch}_low`}        readLive={live(`ch${ch}_low`)} />
            <Knob value={paramVal(`ch${ch}_mid`, 0)}    min={-12}  max={12}  defaultValue={0}   label="MID" curve="linear"   onchange={set(`ch${ch}_mid`)} moduleId={id} paramId={`ch${ch}_mid`}        readLive={live(`ch${ch}_mid`)} />
            <Knob value={paramVal(`ch${ch}_high`, 0)}   min={-12}  max={12}  defaultValue={0}   label="HGH" curve="linear"   onchange={set(`ch${ch}_high`)} moduleId={id} paramId={`ch${ch}_high`}       readLive={live(`ch${ch}_high`)} />
            <Knob value={paramVal(`ch${ch}_thresh`, -12)}  min={-36} max={0}   defaultValue={-12} label="THR" curve="linear"   onchange={set(`ch${ch}_thresh`)} moduleId={id} paramId={`ch${ch}_thresh`}     readLive={live(`ch${ch}_thresh`)} />
            <Knob value={paramVal(`ch${ch}_ratio`, 2)}     min={1}   max={10}  defaultValue={2}   label="RAT" curve="linear"   onchange={set(`ch${ch}_ratio`)} moduleId={id} paramId={`ch${ch}_ratio`}      readLive={live(`ch${ch}_ratio`)} />
            <Knob value={paramVal(`ch${ch}_compEnable`, 0)} min={0}  max={1}   defaultValue={0}   label="CMP" curve="discrete" onchange={set(`ch${ch}_compEnable`)} moduleId={id} paramId={`ch${ch}_compEnable`} readLive={live(`ch${ch}_compEnable`)} />
          {/if}
          <!-- Per-channel comp macro knob (always visible — even in compact
               mode — because it's the user-friendly path; the THR/RAT/CMP
               triple above is for power users in expanded mode). -->
          <Knob value={paramVal(`comp${ch}`, 0)}         min={0}   max={1}   defaultValue={0}   label="Comp" curve="linear"   onchange={set(`comp${ch}`)} moduleId={id} paramId={`comp${ch}`}          readLive={live(`comp${ch}`)} />
          <Knob value={paramVal(`ch${ch}_send1`, 0)}  min={0}  max={1}   defaultValue={0}   label="S1"  curve="linear"   onchange={set(`ch${ch}_send1`)} moduleId={id} paramId={`ch${ch}_send1`}      readLive={live(`ch${ch}_send1`)} />
          <Knob value={paramVal(`ch${ch}_send2`, 0)}  min={0}  max={1}   defaultValue={0}   label="S2"  curve="linear"   onchange={set(`ch${ch}_send2`)} moduleId={id} paramId={`ch${ch}_send2`}      readLive={live(`ch${ch}_send2`)} />
        </div>
      {/each}
      <!-- RETURN 1. Deliberately UNROLLED rather than looped like the 8 channel
           strips: `card-def-agreement` can only compare a LITERAL paramId
           against the def, so a templated `ret${r}_volume` would be an
           uncheckable control — a typo'd range on a return knob would sail
           past the one gate that exists to catch exactly that. Two returns is
           cheap to spell out; eight channels was not. -->
      <div class="ch-col ret-col">
        <div class="ch-label">RET 1</div>
        <!-- Return LEVEL — the knob that makes a pre-fader send usable: it sets
             how loud the wet comes back while the source channel is muted.
             Defaults to 1 (unity = the fixed gain returns used to have). -->
        <Knob value={paramVal('ret1_volume', 1)} min={0} max={1} defaultValue={1} label="Vol" curve="linear" onchange={set('ret1_volume')} moduleId={id} paramId="ret1_volume" readLive={live('ret1_volume')} />
        {#if !compact}
          <Knob value={paramVal('ret1_low', 0)}  min={-12} max={12} defaultValue={0} label="LOW" curve="linear" onchange={set('ret1_low')}  moduleId={id} paramId="ret1_low"  readLive={live('ret1_low')} />
          <Knob value={paramVal('ret1_mid', 0)}  min={-12} max={12} defaultValue={0} label="MID" curve="linear" onchange={set('ret1_mid')}  moduleId={id} paramId="ret1_mid"  readLive={live('ret1_mid')} />
          <Knob value={paramVal('ret1_high', 0)} min={-12} max={12} defaultValue={0} label="HGH" curve="linear" onchange={set('ret1_high')} moduleId={id} paramId="ret1_high" readLive={live('ret1_high')} />
        {/if}
        <!-- PRE/POST for the send bus feeding THIS return. One click; the two
             buses are independent (send 1 can be PRE while send 2 stays POST). -->
        <button
          class="prepost"
          class:pre={paramVal('send1Pre', 0) >= 0.5}
          onclick={() => set('send1Pre')(paramVal('send1Pre', 0) >= 0.5 ? 0 : 1)}
          aria-pressed={paramVal('send1Pre', 0) >= 0.5}
          title={paramVal('send1Pre', 0) >= 0.5
            ? 'SEND 1 is PRE-fader — it taps each channel before its volume fader, so this return keeps sounding even when the source channel is muted. Click for POST.'
            : 'SEND 1 is POST-fader — it follows each channel\'s volume fader, so muting a channel mutes its send. Click for PRE (return stays audible through a mute).'}
          data-testid={`mixmstrs-send1-prepost-${id}`}
        >S1 {paramVal('send1Pre', 0) >= 0.5 ? 'PRE' : 'POST'}</button>
      </div>
      <!-- RETURN 2. Deliberately UNROLLED rather than looped like the 8 channel
           strips: `card-def-agreement` can only compare a LITERAL paramId
           against the def, so a templated `ret${r}_volume` would be an
           uncheckable control — a typo'd range on a return knob would sail
           past the one gate that exists to catch exactly that. Two returns is
           cheap to spell out; eight channels was not. -->
      <div class="ch-col ret-col">
        <div class="ch-label">RET 2</div>
        <!-- Return LEVEL — the knob that makes a pre-fader send usable: it sets
             how loud the wet comes back while the source channel is muted.
             Defaults to 1 (unity = the fixed gain returns used to have). -->
        <Knob value={paramVal('ret2_volume', 1)} min={0} max={1} defaultValue={1} label="Vol" curve="linear" onchange={set('ret2_volume')} moduleId={id} paramId="ret2_volume" readLive={live('ret2_volume')} />
        {#if !compact}
          <Knob value={paramVal('ret2_low', 0)}  min={-12} max={12} defaultValue={0} label="LOW" curve="linear" onchange={set('ret2_low')}  moduleId={id} paramId="ret2_low"  readLive={live('ret2_low')} />
          <Knob value={paramVal('ret2_mid', 0)}  min={-12} max={12} defaultValue={0} label="MID" curve="linear" onchange={set('ret2_mid')}  moduleId={id} paramId="ret2_mid"  readLive={live('ret2_mid')} />
          <Knob value={paramVal('ret2_high', 0)} min={-12} max={12} defaultValue={0} label="HGH" curve="linear" onchange={set('ret2_high')} moduleId={id} paramId="ret2_high" readLive={live('ret2_high')} />
        {/if}
        <!-- PRE/POST for the send bus feeding THIS return. One click; the two
             buses are independent (send 1 can be PRE while send 2 stays POST). -->
        <button
          class="prepost"
          class:pre={paramVal('send2Pre', 0) >= 0.5}
          onclick={() => set('send2Pre')(paramVal('send2Pre', 0) >= 0.5 ? 0 : 1)}
          aria-pressed={paramVal('send2Pre', 0) >= 0.5}
          title={paramVal('send2Pre', 0) >= 0.5
            ? 'SEND 2 is PRE-fader — it taps each channel before its volume fader, so this return keeps sounding even when the source channel is muted. Click for POST.'
            : 'SEND 2 is POST-fader — it follows each channel\'s volume fader, so muting a channel mutes its send. Click for PRE (return stays audible through a mute).'}
          data-testid={`mixmstrs-send2-prepost-${id}`}
        >S2 {paramVal('send2Pre', 0) >= 0.5 ? 'PRE' : 'POST'}</button>
      </div>
      <div class="ch-col master-col">
        <div class="ch-label">MASTER</div>
        <Knob value={paramVal('master_volume', 0.8)} min={0} max={1} defaultValue={0.8} label="Vol" curve="linear" onchange={set('master_volume')} moduleId={id} paramId="master_volume" readLive={live('master_volume')} />
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .mixmstrs-card {
    /* Widened 720 → 900 for the 8-channel expansion: 8 channel strips + the
       master column keep ~90px/column (matching the 6-channel card's spacing —
       no cramped knobs, no control overflow past the card edge). 900 = 5×180 so
       it lands cleanly on the rack-grid hp (rack-sizes.ts mixmstrs hp: 5).
       1080 (= 6×180) for the two RETURN strips added with pre/post sends: same
       ~90px/column, still on the hp grid, and it keeps the return knobs from
       squeezing the channel strips (card-control-overflow measures this). */
    width: 1080px;
  }
  /* PRE/POST toggle — one per send bus, sat under its return strip. Reads as a
     state label, not a verb: it says what the bus IS, and clicking flips it. */
  .prepost {
    margin-top: 4px;
    font-size: 9px;
    letter-spacing: 0.04em;
    line-height: 1;
    padding: 3px 5px;
    color: var(--text-dim, #aaa);
    background: var(--control-bg, #222);
    border: 1px solid var(--border);
    border-radius: 2px;
    cursor: pointer;
    white-space: nowrap;
  }
  .prepost:hover { color: var(--text, #ddd); border-color: var(--accent-dim, #6cf); }
  /* PRE is the non-default, and it changes what you hear through a mute — so it
     is the state that gets the loud treatment. */
  .prepost.pre { color: #1a1400; background: #e8b35b; border-color: #f2c675; }
  .mixmstrs-card .title {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }
  .toggle {
    width: 18px;
    height: 18px;
    background: #2a2f3a;
    border: 1px solid #404652;
    color: var(--text);
    border-radius: 3px;
    font-size: 0.65rem;
    cursor: pointer;
    padding: 0;
    line-height: 1;
  }
  .grid {
    margin-top: 16px;
    display: grid;
    /* --strip-cols = CH + RET, set inline from the DEF-derived lists, then the
       fixed master column. It was `repeat(8, 1fr) 80px` — hardcoded to the
       channel count, so the two RETURN strips silently wrapped onto an implicit
       second row and fell off the bottom of the card (caught by VRT, invisible
       to every def-reading gate). Deriving it means adding a channel or a
       return upstream reflows this correctly instead of overflowing. */
    grid-template-columns: repeat(var(--strip-cols, 8), 1fr) 80px;
    gap: 8px;
    padding: 0 18px;
  }
  .ch-col {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
  }
  .ch-label {
    font-size: 0.6rem;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .master-col {
    border-left: 1px solid #2a2f3a;
    padding-left: 10px;
  }
</style>
