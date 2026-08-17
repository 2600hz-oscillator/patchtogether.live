<script lang="ts">
  // SnaredrumCard — deep stereo snare VOICE with a two-hand drumroll.
  // WIDE 4u banded layout (the three
  // bands are ~683px tall at hp:2 — a 3u tier dropped the STEREO/OUT band
  // below the border, so the def declares 4u), mate to KickdrumCard:
  //
  //   ┌──────── HEAD ────────┬─── BODY ───┬──── WIRE ─────┐
  //   │ Tune Head Damp GDamp │ Tone Body  │ Wire WTn WDec │
  //   │ PAmt PTime           │            │               │
  //   ├─ CRACK ─┬─ PLAY ─┬──── ROLL ──────┼──── DRIVE ────┤
  //   │ Crack   │ ● HIT  │ Roll Bounce    │ Drive [HARD]  │
  //   │ CkTn    │ ▬ ROLL │ Human          │ Ceil          │
  //   ├──── STEREO ─────────┬──── OUT ─────────────────────┤
  //   │ Spread Width        │ Level                        │
  //   └─────────────────────┴──────────────────────────────┘

  import type { NodeProps } from '@xyflow/svelte';
  import NeonFader from '$lib/ui/controls/NeonFader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { snaredrumDef } from '$lib/audio/modules/snaredrum';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, paramSpec } from './card-kit';
  import { fireManualStrike, setManualGate } from './manual-strike-actions';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { defaultFor, paramVal, set, live } = cardParams(snaredrumDef, () => id, () => node);

  // ⚠ EVERY CONTROL'S RANGE / CURVE / UNITS / LABEL COMES FROM THE DEF.
  // This card used to re-type all 21 continuous params' min/max/curve/units as
  // literals. They happened to AGREE with snaredrum.ts — all 21 checked — so it
  // was not a live bug, but it is exactly the backdraft divergence shape (a
  // card silently disagreeing with its def) and NO gate we own can see it:
  // contract-lock, module-docs-lint and module-face-lint all read the DEF.
  // Held at the source level by card-range-source.test.ts.
  //
  // The LABELS were re-typed too, and THERE the card genuinely disagreed: it
  // painted the literal string 'Tone' on THREE different faders (tone,
  // wire_tone, crack_tone) with only a group header to tell them apart, while
  // the def has always declared 'Tone' / 'W Tone' / 'Ck Tone'; and it painted
  // 'Wire' where the def says 'Wires'. Reading them from the def removes the
  // ambiguity and makes the card and the dock name the same knob the same way.
  const P = {
    tune:       paramSpec(snaredrumDef, 'tune'),
    tone:       paramSpec(snaredrumDef, 'tone'),
    damping:    paramSpec(snaredrumDef, 'damping'),
    head_decay: paramSpec(snaredrumDef, 'head_decay'),
    body_decay: paramSpec(snaredrumDef, 'body_decay'),
    pitch_amt:  paramSpec(snaredrumDef, 'pitch_amt'),
    pitch_time: paramSpec(snaredrumDef, 'pitch_time'),
    wire:       paramSpec(snaredrumDef, 'wire'),
    wire_tone:  paramSpec(snaredrumDef, 'wire_tone'),
    wire_decay: paramSpec(snaredrumDef, 'wire_decay'),
    crack:      paramSpec(snaredrumDef, 'crack'),
    crack_tone: paramSpec(snaredrumDef, 'crack_tone'),
    damp:       paramSpec(snaredrumDef, 'damp'),
    roll_speed: paramSpec(snaredrumDef, 'roll_speed'),
    bounce:     paramSpec(snaredrumDef, 'bounce'),
    humanize:   paramSpec(snaredrumDef, 'humanize'),
    spread:     paramSpec(snaredrumDef, 'spread'),
    drive:      paramSpec(snaredrumDef, 'drive'),
    ceiling:    paramSpec(snaredrumDef, 'ceiling'),
    width:      paramSpec(snaredrumDef, 'width'),
    level:      paramSpec(snaredrumDef, 'level'),
  } as const;

  // ── THE AUDITION (the `snaredrum-hit` / `snaredrum-roll` control families).
  // Before this the card could make NO sound at all without a sequencer patched
  // in. Both pads call the SAME seam the RACKLINE shell's cells call
  // (manual-strike-actions → the engine handle's read keys → host-side
  // ConstantSources on trigger_in / gate_in), so there is one implementation.
  // ROLL is press-and-HOLD (`setManualGate`, the seam's held shape), matching
  // gate_in's declared edge:'gate'; HIT is the one-shot (`fireManualStrike`),
  // matching trigger_in's edge:'trigger'. Picking the wrong one here would be
  // the card contradicting the def about the thing this voice exists for.
  let hitPulse = $state(false);
  let rolling = $state(false);
  function hit(): void {
    fireManualStrike(id);
    hitPulse = true;
    setTimeout(() => { hitPulse = false; }, 120);
  }
  function rollDown(): void { rolling = true; setManualGate(id, true); }
  function rollUp(): void {
    if (!rolling) return;
    rolling = false;
    setManualGate(id, false);
  }


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

  // Rear PatchPanel — sectioned to MIRROR the on-card control-group headers:
  // every per-control CV jack sits under the same header as its knob (the
  // existing roll_speed_cv joins the ROLL group), and the structural
  // performance jacks (TRIG / ROLL gate / ACC / V-OCT / CHOKE) + the audio
  // OUT pair collect in the trailing OUT / PATCH sections.
  const headCv: PortDescriptor[] = [
    { id: 'tune_cv',       label: 'TUNE',     cable: 'cv' },
    { id: 'head_decay_cv', label: 'HEAD DEC', cable: 'cv' },
    { id: 'damping_cv',    label: 'DAMP',     cable: 'cv' },
    { id: 'damp_cv',       label: 'G DAMP',   cable: 'cv' },
    { id: 'pitch_amt_cv',  label: 'P AMT',    cable: 'cv' },
    { id: 'pitch_time_cv', label: 'P TIME',   cable: 'cv' },
  ];
  const bodyCv: PortDescriptor[] = [
    { id: 'tone_cv',       label: 'TONE',     cable: 'cv' },
    { id: 'body_decay_cv', label: 'BODY DEC', cable: 'cv' },
  ];
  const wireCv: PortDescriptor[] = [
    { id: 'wire_cv',       label: 'WIRE',   cable: 'cv' },
    { id: 'wire_tone_cv',  label: 'W TONE', cable: 'cv' },
    { id: 'wire_decay_cv', label: 'W DEC',  cable: 'cv' },
  ];
  const crackCv: PortDescriptor[] = [
    { id: 'crack_cv',      label: 'CRACK',   cable: 'cv' },
    { id: 'crack_tone_cv', label: 'CK TONE', cable: 'cv' },
  ];
  const rollCv: PortDescriptor[] = [
    { id: 'roll_speed_cv', label: 'ROLL SPD', cable: 'cv' },
    { id: 'bounce_cv',     label: 'BOUNCE',   cable: 'cv' },
    { id: 'humanize_cv',   label: 'HUMAN',    cable: 'cv' },
  ];
  const driveCv: PortDescriptor[] = [
    { id: 'drive_cv',   label: 'DRIVE', cable: 'cv' },
    { id: 'hard_cv',    label: 'HARD',  cable: 'cv' },
    { id: 'ceiling_cv', label: 'CEIL',  cable: 'cv' },
  ];
  const stereoCv: PortDescriptor[] = [
    { id: 'spread_cv', label: 'SPREAD', cable: 'cv' },
    { id: 'width_cv',  label: 'WIDTH',  cable: 'cv' },
  ];
  const outInputs: PortDescriptor[] = [
    { id: 'level_cv', label: 'LEVEL', cable: 'cv' },
  ];
  const outOutputs: PortDescriptor[] = [
    { id: 'audio_l', label: 'OUT L', cable: 'audio' },
    { id: 'audio_r', label: 'OUT R', cable: 'audio' },
  ];
  const patchInputs: PortDescriptor[] = [
    { id: 'trigger_in', label: 'TRIG',  cable: 'gate' },
    { id: 'gate_in',    label: 'ROLL',  cable: 'gate' },
    { id: 'accent_in',  label: 'ACC',   cable: 'cv' },
    { id: 'pitch_cv',   label: 'V/OCT', cable: 'cv' },
    { id: 'choke_in',   label: 'CHOKE', cable: 'gate' },
  ];

  const sections = [
    { label: 'HEAD',   inputs: headCv },
    { label: 'BODY',   inputs: bodyCv },
    { label: 'WIRE',   inputs: wireCv },
    { label: 'CRACK',  inputs: crackCv },
    { label: 'ROLL',   inputs: rollCv },
    { label: 'DRIVE',  inputs: driveCv },
    { label: 'STEREO', inputs: stereoCv },
    { label: 'OUT',    inputs: outInputs, outputs: outOutputs },
    { label: 'PATCH',  inputs: patchInputs },
  ];
</script>

<div class="mod-card snaredrum-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="SNARE DRUM" />

  <PatchPanel nodeId={id} groupingStrategy="sectioned" {sections} panelWidth={560}>
    <!-- ── band 1: HEAD · BODY · WIRE ── -->
    <section class="band">
      <div class="groups">
        <div class="group wide">
          <header>HEAD</header>
          <div class="fader-row">
            <NeonFader value={tune}      min={P.tune.min}       max={P.tune.max}       defaultValue={defaultFor('tune')}       label={P.tune.label}       units={P.tune.units}       curve={P.tune.curve}       onchange={set('tune')}       moduleId={id} paramId="tune"       readLive={live('tune')} />
            <NeonFader value={headDecay} min={P.head_decay.min} max={P.head_decay.max} defaultValue={defaultFor('head_decay')} label={P.head_decay.label} units={P.head_decay.units} curve={P.head_decay.curve} onchange={set('head_decay')} moduleId={id} paramId="head_decay" readLive={live('head_decay')} />
            <NeonFader value={damping}   min={P.damping.min}    max={P.damping.max}    defaultValue={defaultFor('damping')}    label={P.damping.label}    units={P.damping.units}    curve={P.damping.curve}    onchange={set('damping')}    moduleId={id} paramId="damping"    readLive={live('damping')} />
            <NeonFader value={damp}      min={P.damp.min}       max={P.damp.max}       defaultValue={defaultFor('damp')}       label={P.damp.label}       units={P.damp.units}       curve={P.damp.curve}       onchange={set('damp')}       moduleId={id} paramId="damp"       readLive={live('damp')} />
          </div>
          <div class="fader-row">
            <NeonFader value={pitchAmt}  min={P.pitch_amt.min}  max={P.pitch_amt.max}  defaultValue={defaultFor('pitch_amt')}  label={P.pitch_amt.label}  units={P.pitch_amt.units}  curve={P.pitch_amt.curve}  onchange={set('pitch_amt')}  moduleId={id} paramId="pitch_amt"  readLive={live('pitch_amt')} />
            <NeonFader value={pitchTime} min={P.pitch_time.min} max={P.pitch_time.max} defaultValue={defaultFor('pitch_time')} label={P.pitch_time.label} units={P.pitch_time.units} curve={P.pitch_time.curve} onchange={set('pitch_time')} moduleId={id} paramId="pitch_time" readLive={live('pitch_time')} />
          </div>
        </div>
        <div class="group">
          <header>BODY</header>
          <div class="fader-row">
            <NeonFader value={tone}      min={P.tone.min}       max={P.tone.max}       defaultValue={defaultFor('tone')}       label={P.tone.label}       units={P.tone.units}       curve={P.tone.curve}       onchange={set('tone')}       moduleId={id} paramId="tone"       readLive={live('tone')} />
            <NeonFader value={bodyDecay} min={P.body_decay.min} max={P.body_decay.max} defaultValue={defaultFor('body_decay')} label={P.body_decay.label} units={P.body_decay.units} curve={P.body_decay.curve} onchange={set('body_decay')} moduleId={id} paramId="body_decay" readLive={live('body_decay')} />
          </div>
        </div>
        <div class="group">
          <header>WIRE</header>
          <div class="fader-row">
            <NeonFader value={wire}      min={P.wire.min}       max={P.wire.max}       defaultValue={defaultFor('wire')}       label={P.wire.label}       units={P.wire.units}       curve={P.wire.curve}       onchange={set('wire')}       moduleId={id} paramId="wire"       readLive={live('wire')} />
            <NeonFader value={wireTone}  min={P.wire_tone.min}  max={P.wire_tone.max}  defaultValue={defaultFor('wire_tone')}  label={P.wire_tone.label}  units={P.wire_tone.units}  curve={P.wire_tone.curve}  onchange={set('wire_tone')}  moduleId={id} paramId="wire_tone"  readLive={live('wire_tone')} />
            <NeonFader value={wireDecay} min={P.wire_decay.min} max={P.wire_decay.max} defaultValue={defaultFor('wire_decay')} label={P.wire_decay.label} units={P.wire_decay.units} curve={P.wire_decay.curve} onchange={set('wire_decay')} moduleId={id} paramId="wire_decay" readLive={live('wire_decay')} />
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
            <NeonFader value={crack}     min={P.crack.min}      max={P.crack.max}      defaultValue={defaultFor('crack')}      label={P.crack.label}      units={P.crack.units}      curve={P.crack.curve}      onchange={set('crack')}      moduleId={id} paramId="crack"      readLive={live('crack')} />
            <NeonFader value={crackTone} min={P.crack_tone.min} max={P.crack_tone.max} defaultValue={defaultFor('crack_tone')} label={P.crack_tone.label} units={P.crack_tone.units} curve={P.crack_tone.curve} onchange={set('crack_tone')} moduleId={id} paramId="crack_tone" readLive={live('crack_tone')} />
          </div>
        </div>
        <!-- THE AUDITION — the `snaredrum-hit` + `snaredrum-roll` families.
             Two pads because the module has two strike INPUTS with different
             declared edge semantics: HIT is a one-shot (trigger_in), ROLL is
             press-and-HOLD (gate_in, edge:'gate' — the two-hand engine runs
             only while the level is high). They sit beside ROLL SPEED and
             BOUNCE on purpose: those are the knobs you ride while holding. -->
        <!-- ⚠ `narrow`, NOT a flex share. Giving PLAY `flex: 1` like its
             neighbours added a FIFTH share to a 560 px band and squeezed DRIVE
             from ~155 px to ~128 px, which pushed the HARD toggle 11.3 CSS px
             past the card's right edge — MEASURED by card-control-overflow,
             not eyeballed. Two 62 px pads have an intrinsic width; they should
             take it and give the rest back. -->
        <div class="group narrow">
          <header>PLAY</header>
          <div class="pad-col">
            <button
              class="pad"
              class:pulse={hitPulse}
              onclick={hit}
              data-testid={`snaredrum-hit-${id}-1`}
              title="Audition: one snare hit (identical to a trigger_in rising edge)"
            >● HIT</button>
            <button
              class="pad"
              class:held={rolling}
              aria-pressed={rolling}
              onpointerdown={rollDown}
              onpointerup={rollUp}
              onpointercancel={rollUp}
              onpointerleave={rollUp}
              onblur={rollUp}
              data-testid={`snaredrum-roll-${id}-1`}
              title="Audition: HOLD to run the two-hand roll (identical to holding gate_in high)"
            >▬ ROLL</button>
          </div>
        </div>
        <div class="group wide">
          <header>ROLL</header>
          <div class="fader-row">
            <NeonFader value={rollSpeed} min={P.roll_speed.min} max={P.roll_speed.max} defaultValue={defaultFor('roll_speed')} label={P.roll_speed.label} units={P.roll_speed.units} curve={P.roll_speed.curve} onchange={set('roll_speed')} moduleId={id} paramId="roll_speed" readLive={live('roll_speed')} />
            <NeonFader value={bounce}    min={P.bounce.min}     max={P.bounce.max}     defaultValue={defaultFor('bounce')}     label={P.bounce.label}     units={P.bounce.units}     curve={P.bounce.curve}     onchange={set('bounce')}     moduleId={id} paramId="bounce"     readLive={live('bounce')} />
            <NeonFader value={humanize}  min={P.humanize.min}   max={P.humanize.max}   defaultValue={defaultFor('humanize')}   label={P.humanize.label}   units={P.humanize.units}   curve={P.humanize.curve}   onchange={set('humanize')}   moduleId={id} paramId="humanize"   readLive={live('humanize')} />
          </div>
        </div>
        <!-- `fit`: DRIVE holds the one fixed-width control on the card (the
             nowrap HARD toggle), so it is sized by its content rather than
             flex-shrunk — see the .group.fit note in the styles. -->
        <div class="group fit">
          <header>DRIVE</header>
          <div class="fader-row">
            <NeonFader value={drive} min={P.drive.min} max={P.drive.max} defaultValue={defaultFor('drive')} label={P.drive.label} units={P.drive.units} curve={P.drive.curve} onchange={set('drive')} moduleId={id} paramId="drive" readLive={live('drive')} />
            <button
              class="toggle"
              class:on={hardOn}
              onclick={toggleHard}
              data-testid="snaredrum-hard-toggle"
              title="HARD: drive character — OFF = clean-warm saturation, ON = aggressive"
            >HARD: {hardOn ? 'ON' : 'OFF'}</button>
          </div>
          <div class="fader-row">
            <NeonFader value={ceiling} min={P.ceiling.min} max={P.ceiling.max} defaultValue={defaultFor('ceiling')} label={P.ceiling.label} units={P.ceiling.units} curve={P.ceiling.curve} onchange={set('ceiling')} moduleId={id} paramId="ceiling" readLive={live('ceiling')} />
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
            <NeonFader value={spread} min={P.spread.min} max={P.spread.max} defaultValue={defaultFor('spread')} label={P.spread.label} units={P.spread.units} curve={P.spread.curve} onchange={set('spread')} moduleId={id} paramId="spread" readLive={live('spread')} />
            <NeonFader value={width}  min={P.width.min}  max={P.width.max}  defaultValue={defaultFor('width')}  label={P.width.label}  units={P.width.units}  curve={P.width.curve}  onchange={set('width')}  moduleId={id} paramId="width"  readLive={live('width')} />
          </div>
        </div>
        <div class="group">
          <header>OUT</header>
          <div class="fader-row">
            <NeonFader value={level} min={P.level.min} max={P.level.max} defaultValue={defaultFor('level')} label={P.level.label} units={P.level.units} curve={P.level.curve} onchange={set('level')} moduleId={id} paramId="level" readLive={live('level')} />
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
  /* A group sized by its CONTENT and carrying NO CHROME — see the PLAY comment
     in the markup. `.group`'s 10px padding-right + 1px border-right is 11px of
     horizontal budget per group, and a FOURTH group in a 556px band is exactly
     the 11px that pushed the HARD toggle off the card. The pads read as a
     distinct control type on their own; they do not need a divider. */
  .snaredrum-card .group.narrow {
    flex: 0 0 auto;
    padding-right: 0;
    border-right: none;
  }
  /* CONTENT-SIZED, chrome kept. DRIVE holds the one FIXED-WIDTH control on this
     card — the `HARD: OFF` toggle is `white-space: nowrap` at ~76px — so it is
     the one group that must not be flex-shrunk. Under an equal flex share the
     fourth group in band 2 squeezed it until the toggle hung 11.3 CSS px off
     the card's right edge (card-control-overflow, measured). Sizing DRIVE to
     its content and letting CRACK/ROLL absorb the remainder is the fix; giving
     the space back through the flex pool was not, because a 1:1.6:1 pool
     returns only ~28% of it to DRIVE. */
  .snaredrum-card .group.fit { flex: 0 0 auto; }
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
  .snaredrum-card .pad-col {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 2px 2px 6px;
  }
  .snaredrum-card .pad {
    font-family: var(--font-mono, monospace);
    font-size: 0.6rem;
    letter-spacing: 0.5px;
    padding: 7px 6px;
    background: #14151a;
    color: #9aa0ae;
    border: 1px solid #2a2d36;
    border-radius: 4px;
    cursor: pointer;
    white-space: nowrap;
    touch-action: none;
    user-select: none;
  }
  .snaredrum-card .pad:hover { border-color: #6fb7ff; }
  .snaredrum-card .pad:active,
  .snaredrum-card .pad.pulse,
  .snaredrum-card .pad.held {
    color: #6fb7ff;
    border-color: #6fb7ff;
    background: #101820;
  }
</style>
