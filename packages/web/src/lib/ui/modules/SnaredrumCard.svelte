<script lang="ts">
  // SnaredrumCard — deep stereo snare VOICE with a two-hand drumroll (design:
  // .myrobots/snare-drum-module-design.md). WIDE 3u banded layout, mate to
  // KickdrumCard:
  //
  //   ┌──────── HEAD ────────┬─── BODY ───┬──── WIRE ─────┐
  //   │ Tune Head Damp GDamp │ Tone Body  │ Wire WTn WDec │
  //   │ PAmt PTime           │            │               │
  //   ├─── CRACK ───┬──────── ROLL ───────┼──── DRIVE ────┤
  //   │ Crack CkTn  │ Roll Bounce Human   │ Drive [HARD]  │
  //   │             │                     │ Ceil          │
  //   ├──── STEREO ─────────┬──── OUT ─────────────────────┤
  //   │ Spread Width        │ Level                        │
  //   └─────────────────────┴──────────────────────────────┘

  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { snaredrumDef } from '$lib/audio/modules/snaredrum';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { defaultFor, paramVal, set, live } = cardParams(snaredrumDef, () => id, () => node);



  let tune       = $derived(paramVal('tune'));
  let tone       = $derived(paramVal('tone'));
  let damping    = $derived(paramVal('damping'));
  let headDecay  = $derived(paramVal('head_decay'));
  let bodyDecay  = $derived(paramVal('body_decay'));
  let pitchAmt   = $derived(paramVal('pitch_amt'));
  let pitchTime  = $derived(paramVal('pitch_time'));
  let wire       = $derived(paramVal('wire'));
  let wireTone   = $derived(paramVal('wire_tone'));
  let wireDecay  = $derived(paramVal('wire_decay'));
  let crack      = $derived(paramVal('crack'));
  let crackTone  = $derived(paramVal('crack_tone'));
  let damp       = $derived(paramVal('damp'));
  let rollSpeed  = $derived(paramVal('roll_speed'));
  let bounce     = $derived(paramVal('bounce'));
  let humanize   = $derived(paramVal('humanize'));
  let spread     = $derived(paramVal('spread'));
  let drive      = $derived(paramVal('drive'));
  let hard       = $derived(paramVal('hard'));
  let ceiling    = $derived(paramVal('ceiling'));
  let width      = $derived(paramVal('width'));
  let level      = $derived(paramVal('level'));

  let hardOn = $derived(hard >= 0.5);
  function toggleHard(): void { set('hard')(hardOn ? 0 : 1); }

  const inputs = portsFromDef(snaredrumDef.inputs, {
    trigger_in: 'TRIG', gate_in: 'ROLL', roll_speed_cv: 'SPD', accent_in: 'ACC',
    pitch_cv: 'V/OCT', choke_in: 'CHOKE',
  });
  const outputs = portsFromDef(snaredrumDef.outputs, { audio_l: 'OUT L', audio_r: 'OUT R' });
</script>

<div class="mod-card snaredrum-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="SNARE DRUM" />

  <PatchPanel nodeId={id} {inputs} {outputs} panelWidth={560}>
    <!-- ── band 1: HEAD · BODY · WIRE ── -->
    <section class="band">
      <div class="groups">
        <div class="group wide">
          <header>HEAD</header>
          <div class="fader-row">
            <Fader value={tune}      min={90} max={400} defaultValue={defaultFor('tune')}       label="Tune"  units="Hz" curve="log"    onchange={set('tune')}       moduleId={id} paramId="tune"       readLive={live('tune')} />
            <Fader value={headDecay} min={30} max={600} defaultValue={defaultFor('head_decay')} label="Head"  units="ms" curve="log"    onchange={set('head_decay')} moduleId={id} paramId="head_decay" readLive={live('head_decay')} />
            <Fader value={damping}   min={0}  max={1}   defaultValue={defaultFor('damping')}    label="Damp"             curve="linear" onchange={set('damping')}    moduleId={id} paramId="damping"    readLive={live('damping')} />
            <Fader value={damp}      min={0}  max={1}   defaultValue={defaultFor('damp')}       label="GDmp"             curve="linear" onchange={set('damp')}       moduleId={id} paramId="damp"       readLive={live('damp')} />
          </div>
          <div class="fader-row">
            <Fader value={pitchAmt}  min={0}  max={12}  defaultValue={defaultFor('pitch_amt')}  label="PAmt"  units="st" curve="linear" onchange={set('pitch_amt')}  moduleId={id} paramId="pitch_amt"  readLive={live('pitch_amt')} />
            <Fader value={pitchTime} min={3}  max={80}  defaultValue={defaultFor('pitch_time')} label="PTim"  units="ms" curve="log"    onchange={set('pitch_time')} moduleId={id} paramId="pitch_time" readLive={live('pitch_time')} />
          </div>
        </div>
        <div class="group">
          <header>BODY</header>
          <div class="fader-row">
            <Fader value={tone}      min={0}  max={1}   defaultValue={defaultFor('tone')}       label="Tone"             curve="linear" onchange={set('tone')}       moduleId={id} paramId="tone"       readLive={live('tone')} />
            <Fader value={bodyDecay} min={20} max={300} defaultValue={defaultFor('body_decay')} label="Body"  units="ms" curve="log"    onchange={set('body_decay')} moduleId={id} paramId="body_decay" readLive={live('body_decay')} />
          </div>
        </div>
        <div class="group">
          <header>WIRE</header>
          <div class="fader-row">
            <Fader value={wire}      min={0}    max={1}    defaultValue={defaultFor('wire')}      label="Wire"  curve="linear" onchange={set('wire')}      moduleId={id} paramId="wire"      readLive={live('wire')} />
            <Fader value={wireTone}  min={1500} max={9000} defaultValue={defaultFor('wire_tone')} label="Tone" units="Hz" curve="log" onchange={set('wire_tone')} moduleId={id} paramId="wire_tone" readLive={live('wire_tone')} />
            <Fader value={wireDecay} min={40}   max={700}  defaultValue={defaultFor('wire_decay')} label="Dec" units="ms" curve="log" onchange={set('wire_decay')} moduleId={id} paramId="wire_decay" readLive={live('wire_decay')} />
          </div>
        </div>
      </div>
    </section>

    <!-- ── band 2: CRACK · ROLL · DRIVE ── -->
    <section class="band">
      <div class="groups">
        <div class="group">
          <header>CRACK</header>
          <div class="fader-row">
            <Fader value={crack}     min={0}   max={1}    defaultValue={defaultFor('crack')}      label="Amt"             curve="linear" onchange={set('crack')}      moduleId={id} paramId="crack"      readLive={live('crack')} />
            <Fader value={crackTone} min={800} max={7000} defaultValue={defaultFor('crack_tone')} label="Tone" units="Hz" curve="log"    onchange={set('crack_tone')} moduleId={id} paramId="crack_tone" readLive={live('crack_tone')} />
          </div>
        </div>
        <div class="group wide">
          <header>ROLL</header>
          <div class="fader-row">
            <Fader value={rollSpeed} min={0} max={1} defaultValue={defaultFor('roll_speed')} label="Roll"   curve="linear" onchange={set('roll_speed')} moduleId={id} paramId="roll_speed" readLive={live('roll_speed')} />
            <Fader value={bounce}    min={0} max={1} defaultValue={defaultFor('bounce')}     label="Bounce" curve="linear" onchange={set('bounce')}     moduleId={id} paramId="bounce"     readLive={live('bounce')} />
            <Fader value={humanize}  min={0} max={1} defaultValue={defaultFor('humanize')}   label="Human"  curve="linear" onchange={set('humanize')}   moduleId={id} paramId="humanize"   readLive={live('humanize')} />
          </div>
        </div>
        <div class="group">
          <header>DRIVE</header>
          <div class="fader-row">
            <Fader value={drive} min={0} max={1} defaultValue={defaultFor('drive')} label="Drv" curve="linear" onchange={set('drive')} moduleId={id} paramId="drive" readLive={live('drive')} />
            <button
              class="toggle"
              class:on={hardOn}
              onclick={toggleHard}
              data-testid="snaredrum-hard-toggle"
              title="HARD: drive character — OFF = clean-warm saturation, ON = aggressive"
            >HARD: {hardOn ? 'ON' : 'OFF'}</button>
          </div>
          <div class="fader-row">
            <Fader value={ceiling} min={0} max={1} defaultValue={defaultFor('ceiling')} label="Ceil" curve="linear" onchange={set('ceiling')} moduleId={id} paramId="ceiling" readLive={live('ceiling')} />
          </div>
        </div>
      </div>
    </section>

    <!-- ── band 3: STEREO · OUT ── -->
    <section class="band">
      <div class="groups">
        <div class="group wide">
          <header>STEREO</header>
          <div class="fader-row">
            <Fader value={spread} min={0} max={1} defaultValue={defaultFor('spread')} label="Sprd" curve="linear" onchange={set('spread')} moduleId={id} paramId="spread" readLive={live('spread')} />
            <Fader value={width}  min={0} max={1} defaultValue={defaultFor('width')}  label="Wid"  curve="linear" onchange={set('width')}  moduleId={id} paramId="width"  readLive={live('width')} />
          </div>
        </div>
        <div class="group">
          <header>OUT</header>
          <div class="fader-row">
            <Fader value={level} min={-24} max={12} defaultValue={defaultFor('level')} label="Lvl" units="dB" curve="linear" onchange={set('level')} moduleId={id} paramId="level" readLive={live('level')} />
          </div>
        </div>
      </div>
    </section>
  </PatchPanel>
</div>

<style>
  .snaredrum-card { width: 580px; min-height: 380px; }
  .snaredrum-card .band {
    padding: 6px 12px 8px;
    border-top: 1px solid #1d1f25;
  }
  .snaredrum-card .band:first-of-type { border-top: none; }
  .snaredrum-card .groups {
    display: flex;
    gap: 12px;
    align-items: stretch;
  }
  .snaredrum-card .group {
    flex: 1;
    min-width: 0;
    border-right: 1px solid #1d1f25;
    padding-right: 10px;
  }
  .snaredrum-card .group.wide { flex: 1.6; }
  .snaredrum-card .group:last-child { border-right: none; padding-right: 0; }
  .snaredrum-card .group header {
    font-size: 10px;
    letter-spacing: 1.2px;
    color: #6fb7ff;
    text-transform: uppercase;
    margin: 4px 0 4px;
    opacity: 0.9;
  }
  .snaredrum-card .fader-row {
    display: flex;
    gap: 10px;
    padding: 0 2px;
    margin-bottom: 6px;
    align-items: flex-end;
  }
  .snaredrum-card .toggle {
    align-self: center;
    font-family: var(--font-mono, monospace);
    font-size: 0.6rem;
    letter-spacing: 0.5px;
    padding: 6px 8px;
    background: #14151a;
    color: #9aa0ae;
    border: 1px solid #2a2d36;
    border-radius: 4px;
    cursor: pointer;
    white-space: nowrap;
  }
  .snaredrum-card .toggle.on {
    color: #6fb7ff;
    border-color: #6fb7ff;
    background: #101820;
  }
</style>
