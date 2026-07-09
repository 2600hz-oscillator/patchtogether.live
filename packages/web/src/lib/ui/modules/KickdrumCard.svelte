<script lang="ts">
  // KickdrumCard — layered stereo kick-voice card (build plan:
  // .myrobots/plans/kick-drum-voice-2026-07-01.md). WIDE 3u banded layout
  // (owner decision), Ports-family chrome:
  //
  //   ┌──── SUB ─────┬───────── BODY ─────────┬──── CLICK ────┐
  //   │ Tune SubDec  │ PAmt PTime Tens        │ Click ClkTone │
  //   │ Sub          │ BodyDec Body Shape     │ ClkLvl        │
  //   ├──── DRIVE ───┼───────── EQ ───────────┼── TRANSLATE ──┤
  //   │ Drive [HARD] │ SubEQ BodyEQ AtkEQ Tilt│ Translate     │
  //   ├── DYNAMICS ──┼──────── STEREO ────────┼──── OUT ──────┤
  //   │ Atk Sus Glue │ Width                  │ Level         │
  //   │ Ceil         │                        │               │
  //   └──────────────┴────────────────────────┴───────────────┘

  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { kickdrumDef } from '$lib/audio/modules/kickdrum';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { defaultFor, paramVal, set, live } = cardParams(kickdrumDef, () => id, () => node);



  // Per-param reactive reads.
  let tune       = $derived(paramVal('tune'));
  let pitchAmt   = $derived(paramVal('pitch_amt'));
  let pitchTime  = $derived(paramVal('pitch_time'));
  let tension    = $derived(paramVal('tension'));
  let subDecay   = $derived(paramVal('sub_decay'));
  let bodyDecay  = $derived(paramVal('body_decay'));
  let clickLen   = $derived(paramVal('click_len'));
  let subLevel   = $derived(paramVal('sub_level'));
  let bodyLevel  = $derived(paramVal('body_level'));
  let clickLevel = $derived(paramVal('click_level'));
  let bodyShape  = $derived(paramVal('body_shape'));
  let clickTone  = $derived(paramVal('click_tone'));
  let drive      = $derived(paramVal('drive'));
  let hard       = $derived(paramVal('hard'));
  let translate  = $derived(paramVal('translate'));
  let subEq      = $derived(paramVal('sub_eq'));
  let bodyEq     = $derived(paramVal('body_eq'));
  let attackEq   = $derived(paramVal('attack_eq'));
  let tilt       = $derived(paramVal('tilt'));
  let attack     = $derived(paramVal('attack'));
  let sustain    = $derived(paramVal('sustain'));
  let glue       = $derived(paramVal('glue'));
  let ceiling    = $derived(paramVal('ceiling'));
  let width      = $derived(paramVal('width'));
  let level      = $derived(paramVal('level'));

  let hardOn = $derived(hard >= 0.5);
  function toggleHard(): void { set('hard')(hardOn ? 0 : 1); }

  const inputs = portsFromDef(kickdrumDef.inputs, {
    trigger_in: 'TRIG', accent_in: 'ACC', pitch_cv: 'V/OCT', choke_in: 'CHOKE',
  });
  const outputs = portsFromDef(kickdrumDef.outputs, { audio_l: 'OUT L', audio_r: 'OUT R' });
</script>

<div class="mod-card kickdrum-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="KICK DRUM" />

  <PatchPanel nodeId={id} {inputs} {outputs} panelWidth={560}>
    <!-- ── band 1: SUB · BODY · CLICK ── -->
    <section class="band">
      <div class="groups">
        <div class="group">
          <header>SUB</header>
          <div class="fader-row">
            <Fader value={tune}     min={20} max={120} defaultValue={defaultFor('tune')}      label="Tune" units="Hz" curve="log"    onchange={set('tune')}      moduleId={id} paramId="tune"      readLive={live('tune')} />
            <Fader value={subDecay} min={50} max={800} defaultValue={defaultFor('sub_decay')} label="Dec"  units="ms" curve="log"    onchange={set('sub_decay')} moduleId={id} paramId="sub_decay" readLive={live('sub_decay')} />
            <Fader value={subLevel} min={0}  max={1}   defaultValue={defaultFor('sub_level')} label="Sub"             curve="linear" onchange={set('sub_level')} moduleId={id} paramId="sub_level" readLive={live('sub_level')} />
          </div>
        </div>
        <div class="group wide">
          <header>BODY</header>
          <div class="fader-row">
            <Fader value={pitchAmt}  min={0}  max={48}  defaultValue={defaultFor('pitch_amt')}  label="PAmt" units="st" curve="linear" onchange={set('pitch_amt')}  moduleId={id} paramId="pitch_amt"  readLive={live('pitch_amt')} />
            <Fader value={pitchTime} min={5}  max={120} defaultValue={defaultFor('pitch_time')} label="PTim" units="ms" curve="log"    onchange={set('pitch_time')} moduleId={id} paramId="pitch_time" readLive={live('pitch_time')} />
            <Fader value={tension}   min={0}  max={0.6} defaultValue={defaultFor('tension')}    label="Tens"            curve="linear" onchange={set('tension')}    moduleId={id} paramId="tension"    readLive={live('tension')} />
          </div>
          <div class="fader-row">
            <Fader value={bodyDecay} min={20} max={400} defaultValue={defaultFor('body_decay')} label="Dec"  units="ms" curve="log"    onchange={set('body_decay')} moduleId={id} paramId="body_decay" readLive={live('body_decay')} />
            <Fader value={bodyLevel} min={0}  max={1}   defaultValue={defaultFor('body_level')} label="Body"            curve="linear" onchange={set('body_level')} moduleId={id} paramId="body_level" readLive={live('body_level')} />
            <Fader value={bodyShape} min={0}  max={1}   defaultValue={defaultFor('body_shape')} label="Shp"             curve="linear" onchange={set('body_shape')} moduleId={id} paramId="body_shape" readLive={live('body_shape')} />
          </div>
        </div>
        <div class="group">
          <header>CLICK</header>
          <div class="fader-row">
            <Fader value={clickLen}   min={2}   max={60}   defaultValue={defaultFor('click_len')}   label="Len"  units="ms" curve="log"    onchange={set('click_len')}   moduleId={id} paramId="click_len"   readLive={live('click_len')} />
            <Fader value={clickTone}  min={500} max={6000} defaultValue={defaultFor('click_tone')}  label="Tone" units="Hz" curve="log"    onchange={set('click_tone')}  moduleId={id} paramId="click_tone"  readLive={live('click_tone')} />
            <Fader value={clickLevel} min={0}   max={1}    defaultValue={defaultFor('click_level')} label="Lvl"             curve="linear" onchange={set('click_level')} moduleId={id} paramId="click_level" readLive={live('click_level')} />
          </div>
        </div>
      </div>
    </section>

    <!-- ── band 2: DRIVE · EQ · TRANSLATE ── -->
    <section class="band">
      <div class="groups">
        <div class="group">
          <header>DRIVE</header>
          <div class="fader-row">
            <Fader value={drive} min={0} max={1} defaultValue={defaultFor('drive')} label="Drv" curve="linear" onchange={set('drive')} moduleId={id} paramId="drive" readLive={live('drive')} />
            <button
              class="toggle"
              class:on={hardOn}
              onclick={toggleHard}
              data-testid="kickdrum-hard-toggle"
              title="HARD: drive character — OFF = clean-warm saturation, ON = aggressive"
            >HARD: {hardOn ? 'ON' : 'OFF'}</button>
          </div>
        </div>
        <div class="group wide">
          <header>EQ</header>
          <div class="fader-row">
            <Fader value={subEq}    min={-12} max={12} defaultValue={defaultFor('sub_eq')}    label="Sub"  units="dB" curve="linear" onchange={set('sub_eq')}    moduleId={id} paramId="sub_eq"    readLive={live('sub_eq')} />
            <Fader value={bodyEq}   min={-12} max={12} defaultValue={defaultFor('body_eq')}   label="Body" units="dB" curve="linear" onchange={set('body_eq')}   moduleId={id} paramId="body_eq"   readLive={live('body_eq')} />
            <Fader value={attackEq} min={-12} max={12} defaultValue={defaultFor('attack_eq')} label="Atk"  units="dB" curve="linear" onchange={set('attack_eq')} moduleId={id} paramId="attack_eq" readLive={live('attack_eq')} />
            <Fader value={tilt}     min={-1}  max={1}  defaultValue={defaultFor('tilt')}      label="Tilt"            curve="linear" onchange={set('tilt')}      moduleId={id} paramId="tilt"      readLive={live('tilt')} />
          </div>
        </div>
        <div class="group">
          <header>TRANSLATE</header>
          <div class="fader-row">
            <Fader value={translate} min={0} max={1} defaultValue={defaultFor('translate')} label="Xlat" curve="linear" onchange={set('translate')} moduleId={id} paramId="translate" readLive={live('translate')} />
          </div>
        </div>
      </div>
    </section>

    <!-- ── band 3: DYNAMICS · STEREO · OUT ── -->
    <section class="band">
      <div class="groups">
        <div class="group wide">
          <header>DYNAMICS</header>
          <div class="fader-row">
            <Fader value={attack}  min={-1} max={1} defaultValue={defaultFor('attack')}  label="Atk"  curve="linear" onchange={set('attack')}  moduleId={id} paramId="attack"  readLive={live('attack')} />
            <Fader value={sustain} min={-1} max={1} defaultValue={defaultFor('sustain')} label="Sus"  curve="linear" onchange={set('sustain')} moduleId={id} paramId="sustain" readLive={live('sustain')} />
            <Fader value={glue}    min={0}  max={1} defaultValue={defaultFor('glue')}    label="Glue" curve="linear" onchange={set('glue')}    moduleId={id} paramId="glue"    readLive={live('glue')} />
            <Fader value={ceiling} min={0}  max={1} defaultValue={defaultFor('ceiling')} label="Ceil" curve="linear" onchange={set('ceiling')} moduleId={id} paramId="ceiling" readLive={live('ceiling')} />
          </div>
        </div>
        <div class="group">
          <header>STEREO</header>
          <div class="fader-row">
            <Fader value={width} min={0} max={1} defaultValue={defaultFor('width')} label="Wid" curve="linear" onchange={set('width')} moduleId={id} paramId="width" readLive={live('width')} />
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
  .kickdrum-card { width: 580px; min-height: 380px; }
  .kickdrum-card .band {
    padding: 6px 12px 8px;
    border-top: 1px solid #1d1f25;
  }
  .kickdrum-card .band:first-of-type { border-top: none; }
  .kickdrum-card .groups {
    display: flex;
    gap: 12px;
    align-items: stretch;
  }
  .kickdrum-card .group {
    flex: 1;
    min-width: 0;
    border-right: 1px solid #1d1f25;
    padding-right: 10px;
  }
  .kickdrum-card .group.wide { flex: 1.6; }
  .kickdrum-card .group:last-child { border-right: none; padding-right: 0; }
  .kickdrum-card .group header {
    font-size: 10px;
    letter-spacing: 1.2px;
    color: #ff8f3f;
    text-transform: uppercase;
    margin: 4px 0 4px;
    opacity: 0.9;
  }
  .kickdrum-card .fader-row {
    display: flex;
    gap: 10px;
    padding: 0 2px;
    margin-bottom: 6px;
    align-items: flex-end;
  }
  .kickdrum-card .toggle {
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
  .kickdrum-card .toggle.on {
    color: #ff8f3f;
    border-color: #ff8f3f;
    background: #1c1610;
  }
</style>
