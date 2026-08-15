// packages/web/src/lib/audio/modules/snaredrum.ts
//
// SNARE DRUM — deep, flexible stereo snare VOICE with a POLYPHONIC two-hand
// DRUMROLL. Mate to
// KICK DRUM; it clones that template (state-object DSP, sr-calibrated decay,
// seeded xorshift, per-channel tanh ceiling, mono-safe M/S, stereo audio_l /
// audio_r fanned through a ChannelSplitter) and adds one new thing: a true
// mechanistic drumroll driven by a GATE.
//
// Four decoupled acoustic layers (design §1): a HEAD modal bank at Bessel-zero
// ratios (the pitchless membrane thunk), BODY noise around the head (the noisy
// tone; `tone` crossfades HEAD↔BODY), a SHARED re-excitable snare-WIRE buzz bed
// (the defining sizzle + the roll's continuity), and a CRACK stick transient.
//
// Two strike sources feed the one synth:
//   trigger_in (edge:'trigger') — one rising edge fires ONE snare hit.
//   gate_in    (edge:'gate')    — WHILE high, an internal two-hand roll engine
//     generates a continuous roll at `roll_speed` (+ roll_speed_cv). Two
//     alternating hands (180° interleaved) whose overlapping decaying tails +
//     the re-excited wire bed keep the snare ringing — a real superposition, NOT
//     a fast one-shot retrigger. `bounce` morphs single → double/open → buzz.
//
// Outputs are SEPARATE audio_l / audio_r ports (cube.ts idiom) so the stereo
// image survives downstream patching; stereoPairs auto-pairs them. width=0 AND
// spread=0 → L == R exactly (mono-safe fold-down).

import { closeGate, fireTrigger, openGate } from '$lib/audio/gate-trigger';
import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/snaredrum.js?url';

import { createWorkletNode } from '$lib/audio/worklet-guard';
const PROCESSOR_NAME = 'snaredrum';
const loadedContexts = new WeakSet<BaseAudioContext>();

export const snaredrumDef: AudioModuleDef = {
  type: 'snaredrum',
  palette: { top: 'Audio modules', sub: 'VCOs' },
  domain: 'audio',
  label: 'snare drum',
  category: 'sources',
  // A WIDE banded voice card (~22 controls over three HEAD·BODY·WIRE /
  // CRACK·ROLL·DRIVE / STEREO·OUT bands), mate to KICK DRUM. MEASURED
  // natural content height at hp:2 (360px) is ~683px (offsetHeight probe),
  // so the 3u tier (540px) dropped the whole STEREO/OUT band below the
  // border; 4u (720px) contains every control + label. ~683×360px.
  size: '4u',
  hp: 2,

  inputs: [
    // The STRIKE: one snare hit per rising edge. Accent is read at the edge.
    { id: 'trigger_in',   type: 'gate', edge: 'trigger' },
    // The DRUMROLL: while high, the two-hand engine rolls (level-sensitive).
    { id: 'gate_in',      type: 'gate', edge: 'gate' },
    // Roll rate CV — a 1V/oct multiply on roll_speed.
    { id: 'roll_speed_cv', type: 'cv' },
    // Per-hit velocity, sampled at each strike.
    { id: 'accent_in',    type: 'cv' },
    // 1V/oct — transposes the whole voice (head + body) as a multiplier.
    { id: 'pitch_cv',     type: 'cv' },
    // Level-sensitive hand-on-head mute (a choke group input).
    { id: 'choke_in',     type: 'gate', edge: 'gate' },
    // Per-control CV for the voice knobs (the cofefve/karplus convention;
    // roll_speed keeps its dedicated node-rate roll_speed_cv above). A -1..+1
    // CV sweeps the target AudioParam's FULL range centred on the live knob;
    // cvScale mode matches each param's curve. At cv=0 the delta is 0, so an
    // unpatched input is a no-op.
    { id: 'tune_cv',       type: 'cv', paramTarget: 'tune',       cvScale: { mode: 'log' } },
    { id: 'head_decay_cv', type: 'cv', paramTarget: 'head_decay', cvScale: { mode: 'log' } },
    { id: 'damping_cv',    type: 'cv', paramTarget: 'damping',    cvScale: { mode: 'linear' } },
    { id: 'damp_cv',       type: 'cv', paramTarget: 'damp',       cvScale: { mode: 'linear' } },
    { id: 'pitch_amt_cv',  type: 'cv', paramTarget: 'pitch_amt',  cvScale: { mode: 'linear' } },
    { id: 'pitch_time_cv', type: 'cv', paramTarget: 'pitch_time', cvScale: { mode: 'log' } },
    { id: 'tone_cv',       type: 'cv', paramTarget: 'tone',       cvScale: { mode: 'linear' } },
    { id: 'body_decay_cv', type: 'cv', paramTarget: 'body_decay', cvScale: { mode: 'log' } },
    { id: 'wire_cv',       type: 'cv', paramTarget: 'wire',       cvScale: { mode: 'linear' } },
    { id: 'wire_tone_cv',  type: 'cv', paramTarget: 'wire_tone',  cvScale: { mode: 'log' } },
    { id: 'wire_decay_cv', type: 'cv', paramTarget: 'wire_decay', cvScale: { mode: 'log' } },
    { id: 'crack_cv',      type: 'cv', paramTarget: 'crack',      cvScale: { mode: 'linear' } },
    { id: 'crack_tone_cv', type: 'cv', paramTarget: 'crack_tone', cvScale: { mode: 'log' } },
    { id: 'bounce_cv',     type: 'cv', paramTarget: 'bounce',     cvScale: { mode: 'linear' } },
    { id: 'humanize_cv',   type: 'cv', paramTarget: 'humanize',   cvScale: { mode: 'linear' } },
    { id: 'drive_cv',      type: 'cv', paramTarget: 'drive',      cvScale: { mode: 'linear' } },
    { id: 'hard_cv',       type: 'cv', paramTarget: 'hard',       cvScale: { mode: 'discrete' } },
    { id: 'ceiling_cv',    type: 'cv', paramTarget: 'ceiling',    cvScale: { mode: 'linear' } },
    { id: 'spread_cv',     type: 'cv', paramTarget: 'spread',     cvScale: { mode: 'linear' } },
    { id: 'width_cv',      type: 'cv', paramTarget: 'width',      cvScale: { mode: 'linear' } },
    { id: 'level_cv',      type: 'cv', paramTarget: 'level',      cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'audio_l', type: 'audio' },
    { id: 'audio_r', type: 'audio' },
  ],
  stereoPairs: [['audio_l', 'audio_r']],
  params: [
    // ── HEAD · BODY ──
    { id: 'tune',        label: 'Tune',    defaultValue: 180,  min: 90,   max: 400,  curve: 'log',      units: 'Hz' },
    { id: 'tone',        label: 'Tone',    defaultValue: 0.5,  min: 0,    max: 1,    curve: 'linear' },
    { id: 'damping',     label: 'Damp',    defaultValue: 0.4,  min: 0,    max: 1,    curve: 'linear' },
    { id: 'head_decay',  label: 'Head',    defaultValue: 180,  min: 30,   max: 600,  curve: 'log',      units: 'ms' },
    { id: 'body_decay',  label: 'Body',    defaultValue: 110,  min: 20,   max: 300,  curve: 'log',      units: 'ms' },
    { id: 'pitch_amt',   label: 'P Amt',   defaultValue: 3,    min: 0,    max: 12,   curve: 'linear',   units: 'st' },
    { id: 'pitch_time',  label: 'P Time',  defaultValue: 18,   min: 3,    max: 80,   curve: 'log',      units: 'ms' },
    // ── WIRE · CRACK ──
    { id: 'wire',        label: 'Wires',   defaultValue: 0.7,  min: 0,    max: 1,    curve: 'linear' },
    { id: 'wire_tone',   label: 'W Tone',  defaultValue: 4500, min: 1500, max: 9000, curve: 'log',      units: 'Hz' },
    { id: 'wire_decay',  label: 'W Dec',   defaultValue: 260,  min: 40,   max: 700,  curve: 'log',      units: 'ms' },
    { id: 'crack',       label: 'Crack',   defaultValue: 0.4,  min: 0,    max: 1,    curve: 'linear' },
    { id: 'crack_tone',  label: 'Ck Tone', defaultValue: 3200, min: 800,  max: 7000, curve: 'log',      units: 'Hz' },
    { id: 'damp',        label: 'G Damp',  defaultValue: 0.2,  min: 0,    max: 1,    curve: 'linear' },
    // ── ROLL ──
    { id: 'roll_speed',  label: 'Roll',    defaultValue: 0.5,  min: 0,    max: 1,    curve: 'linear' },
    { id: 'bounce',      label: 'Bounce',  defaultValue: 0.35, min: 0,    max: 1,    curve: 'linear' },
    { id: 'humanize',    label: 'Human',   defaultValue: 0.2,  min: 0,    max: 1,    curve: 'linear' },
    // ── DRIVE · STEREO · OUT ──
    { id: 'spread',      label: 'Spread',  defaultValue: 0.5,  min: 0,    max: 1,    curve: 'linear' },
    { id: 'drive',       label: 'Drive',   defaultValue: 0.2,  min: 0,    max: 1,    curve: 'linear' },
    { id: 'hard',        label: 'Hard',    defaultValue: 0,    min: 0,    max: 1,    curve: 'discrete' },
    { id: 'ceiling',     label: 'Ceiling', defaultValue: 0.5,  min: 0,    max: 1,    curve: 'linear' },
    { id: 'width',       label: 'Width',   defaultValue: 0.4,  min: 0,    max: 1,    curve: 'linear' },
    { id: 'level',       label: 'Level',   defaultValue: 0,    min: -24,  max: 12,   curve: 'linear',   units: 'dB' },
  ],

  // THE AUDITION — two families, because this voice has TWO strike inputs with
  // DIFFERENT declared semantics and collapsing them into one button would be
  // the face contradicting its own def about the thing the module exists for:
  //   snaredrum-hit  → `trigger_in`, edge:'trigger' — one hit per rising edge;
  //   snaredrum-roll → `gate_in`,    edge:'gate'    — the two-hand roll runs
  //                    WHILE held, which is why its pad is MOMENTARY and not a
  //                    click (a roll you cannot hold is not this module).
  // Neither is a PARAM. A `strike` param would need a row in the worklet's
  // PARAM_TABLE, and the ART profile's `.sha` covers those DSP sources, so it
  // would force a re-capture of a byte-identical baseline; both pads instead
  // drive host-side ConstantSources summed into the SAME worklet inputs a cable
  // feeds (see the factory), through the karplus/samsloop `read(key)` seam.
  // ONE implementation for both surfaces, and it is the RACK-WIDE one every
  // struck voice uses: ui/modules/manual-strike-actions (fireManualStrike for
  // the hit, setManualGate for the held roll).
  controlFamilies: [
    { id: 'snaredrum-hit',  label: 'Hit',  kind: 'other', testidPrefix: 'snaredrum-hit' },
    { id: 'snaredrum-roll', label: 'Roll', kind: 'other', testidPrefix: 'snaredrum-roll' },
  ],

  // ── RACKLINE face (P1 total-rework — UI CURATION only, NOT the I/O
  // contract; see ModuleFace in $lib/graph/types). DESIGNED from the voice's
  // intent + the KICK DRUM sibling's producer-intent banding, not transcribed
  // from the legacy card.
  //
  // ⚠ `order` and `pages` ANSWER DIFFERENT QUESTIONS AND MAY DISAGREE. `order`
  // is a PRIORITY ranking, consumed by the tiers that show a SUBSET; `pages` is
  // FUNCTION order, consumed by the one tier that shows EVERYTHING. Do not
  // "fix" one to match the other — the auditions rank LAST (you press them once
  // while dialling in; you RIDE the knobs) and render FIRST (the strike is what
  // causes everything the other bands shape).
  //
  // THE LANE IS SIX CELLS AND IT ENDS THERE. laneBodyPlan's plate is
  // PLATE_COLS(3) × PLATE_MAX_ROWS(2) = LANE_PLATE_MAX_CELLS = 6, so RANK 7 IS
  // DOCK-ONLY. The comment this replaces promised "ranks 4–8 complete the
  // full-in-lane face", which was stale by two: `bounce` (7) and `level` (8)
  // rendered NOWHERE in the lane. That is what made the old ranking
  // indefensible — the module with the rack's only roll ENGINE let you set a
  // roll's RATE and not its CHARACTER.
  //
  // THE SIX, and the criterion is the repo's: a knob you RIDE during a
  // performance belongs in the lane; a knob you SET ONCE while dialling in
  // belongs in the dock.
  //   1 TUNE   — the drum's size. The modal bank AND the noise body centre
  //              track it, so nothing else about this drum is knowable first.
  //   2 WIRES  — the knob that makes it a snare instead of a tom, AND the
  //              master of a roll's sustain (`bed += wire × velocity`), so it
  //              is two identities in one control. With TUNE it is the whole
  //              compact tile: which drum, and is it even a snare.
  //   3 ROLL   — the mechanism this voice has and its siblings do not. THE DEF
  //              ITSELF says this knob is expected to MOVE: `roll_speed` is the
  //              only param in the module with its own dedicated audio-rate
  //              node input (`roll_speed_cv`, worklet input 2, read per sample
  //              at 1 V/oct). Every other knob gets an 80 Hz-smoothed
  //              AudioParam. A crescendo roll IS a sweep of this control.
  //   4 BOUNCE — the roll's CHARACTER (single → double/open → buzz). Ranking
  //              the rate without the type is exactly what the old face did.
  //   5 G DAMP — one cell doing the work of three: it scales the head, body AND
  //              wire-bed decays together, ×(1 − 0.6 × damp), and tightens the
  //              modal ring with them. It is also the natural counterpart to a
  //              buzz roll, whose overlapping tails are what turn a press roll
  //              into mud.
  //   6 TONE   — the whole-drum bright↔fat tilt (the tonal voice's gain rides
  //              0.6→1.4 against the wire bed's 1.4→0.6, and the head modes
  //              crossfade with the body noise inside the voice).
  // DEMOTED OUT OF THE LANE, and it is a demotion, not a loss — both keep a
  // dock cell: HEAD DEC because G DAMP moves that tail and two others from one
  // cell, and CRACK because it is the level of a FIXED ~6 ms tick — an attack
  // you set, not one you ride. LEVEL was ALREADY out of the lane at rank 8 and
  // stays out on the drum-family rule: it is applied to mid and side BEFORE the
  // ceiling, so it is a saturation lever rather than a fader.
  //
  // GLYPH ACCOUNTING, stated because it is easy to assume otherwise: a face
  // with ≥4 selected cells renders NO glyph at the `full` tier
  // (`laneBodyPlan`: `glyph = hasGlyph && rows <= 1`, and 6 cells is 2 rows).
  // The scope trace was already dead at `full` BEFORE this re-cut — it survives
  // at mini (1 cell), compact (2 cells) and the dock hero, and this face costs
  // it nothing.
  //
  // THE DOCK BANDS follow producer intent, not the signal graph. The two
  // AUDITION pads head band 1 — the same ordinal argument KICK DRUM's face
  // makes: this voice is SILENT until something strikes it, so the way to hear
  // it belongs in the band a player reaches first. Then the four layers in the
  // order they are heard (head + body, then the wire/crack snap), the ROLL
  // engine (SPREAD rides there because it is a ROLL control — the DSP centres
  // every single trigger hit, so spread only ever moves the two hands, their
  // detune and the bed's ping-pong), then the two WHOLE-DRUM scalers, then the
  // output bus.
  //
  // ⚠ WHY `whole drum` IS ITS OWN 2-CELL BAND AND NOT A CLUSTER UNDER `bus`.
  // TONE and DAMP are the only two controls that touch EVERY layer (tone tilts
  // voice-vs-bed and crossfades head↔body; damp scales the head, body and wire
  // decays together). Filing them as a sub-header inside a band called `bus`
  // would teach that they are part of the output chain, which is the shape of
  // the mis-teaching KICK DRUM's face had to be fixed for (it read
  // `… → ceiling → stereo → level` while the DSP does `… → level → width →
  // ceiling`). A thin band that says the true thing beats a fat band that says
  // a false one.
  //
  // glyph 'scope' = the live analyser trace on audio_l — for a percussion voice
  // that IS the hero image: each strike's amp/noise envelope (crack spike →
  // modal thunk → wire tail) drawn from the real output, the KICK-family hero.
  // (No 'dual' binding: this voice has no assigned-shape morph to draw from
  // params — its identity is the envelope, and the envelope is only real live.)
  face: {
    order: [
      // ── the lane budget: ranks 1–6, and it ends HERE ──
      'tune', 'wire',              // the compact tile: which drum, is it a snare
      'roll_speed', 'bounce',      // the ROLL — rate, then character
      'damp', 'tone',              // the two whole-drum scalers
      // ── dock-only tail, in FACEPLATE reading order ──
      // The two auditions lead it exactly as they lead the faceplate. They are
      // family cells (<Button>s, not knobs) and there is no precedent for a
      // button inside the lane plate — laneBodyPlan's no-clip guarantee is
      // derived entirely from knob-column geometry — so rank 7 is both their
      // natural place in the story and the first rank that cannot reach a lane.
      'snaredrum-hit-{n}', 'snaredrum-roll-{n}',
      'damping', 'head_decay', 'body_decay', 'pitch_amt', 'pitch_time',
      'wire_tone', 'wire_decay', 'crack', 'crack_tone',
      'humanize', 'spread',
      'drive', 'hard', 'ceiling', 'width', 'level',
    ],
    pages: [
      // ⚠ PAGE IDS ARE CHECKED AGAINST THE CURATED REAR GROUP IDS.
      // `rearFieldPlan` gives a curated group whose id is 'voice'/'signal' the
      // LEADING band slot and then walks `face.pages` claiming a curated group
      // with each page's id, so a page id colliding with the leading group's id
      // renders that band TWICE and reddens the rear-derivation totality gate
      // (dx7 hit exactly this). This module's only curated rear group is
      // `voice`; no page is called 'voice', and none is called 'strike' either
      // — the REAR already owns that word for the band where trigger_in and
      // gate_in are patched, and two adjacent bands both headed STRIKE is the
      // confusion KICK DRUM had to unpick (a player patching a gate into the
      // wrong one silently detunes the drum instead of hitting it).
      {
        id: 'drum',
        label: 'drum · head + body',
        controls: ['snaredrum-hit-{n}', 'snaredrum-roll-{n}', 'tune', 'damping', 'head_decay', 'body_decay', 'pitch_amt', 'pitch_time'],
        // ⚠ Clusters render AFTER the band's flat row (curated-face's
        // resolvePage / ModuleShell), so a cluster can never LEAD a band —
        // which is why the pads are un-clustered and first in `controls`.
        clusters: [
          // Depth + settle time are ONE envelope (the snare 'pit'). Uncaptioned
          // they read as two more orphans among four decay knobs.
          { label: 'pitch drop', controls: ['pitch_amt', 'pitch_time'] },
        ],
      },
      { id: 'snap',  label: 'snap · wire + crack', controls: ['wire', 'wire_tone', 'wire_decay', 'crack', 'crack_tone'] },
      { id: 'roll',  label: 'roll · two hands',    controls: ['roll_speed', 'bounce', 'humanize', 'spread'] },
      { id: 'whole', label: 'whole drum',          controls: ['tone', 'damp'] },
      { id: 'bus',   label: 'bus · out',           controls: ['drive', 'hard', 'ceiling', 'width', 'level'] },
    ],
    glyph: 'scope',
    // REAR CARD curation (rear-card-model). Derivation already files every
    // per-control CV under the page band of the knob it moves (incl.
    // roll_speed_cv → 'roll · two hands', whose `_cv` stem resolves to the
    // roll_speed param); curated here are the exceptions:
    //   • the leading band is renamed from the derived generic 'voice' and
    //     SPLIT into the two ways to hit this drum (TRIGGER = one hit, the
    //     ROLL gate = the two-hand engine) vs the three per-hit modifiers;
    //   • audioRate ticks the SIX dedicated worklet node inputs — they are
    //     read RAW from the input buffers every sample (sample-accurate strike
    //     edges, 1 V/oct, per-stroke accent), whereas every per-control CV
    //     lands on an AudioParam the worklet reads through an 80 Hz one-pole
    //     smoother, so those are deliberately NOT ticked.
    rear: {
      groups: [
        {
          id: 'voice',
          label: 'strike · performance',
          ports: ['trigger_in', 'gate_in', 'accent_in', 'pitch_cv', 'choke_in'],
        },
      ],
      clusters: [
        // The cluster caption now TEACHES the distinction instead of restating
        // the band header: these two jacks carry the same `gate` cable and the
        // same voltage, and the difference is entirely in how this module reads
        // them (PortDef.edge). That is the one fact a patcher cannot infer from
        // the holes, and the jack field is where the decision is made.
        { group: 'voice', label: 'strike \u00b7 hit or hold', ports: ['trigger_in', 'gate_in'] },
        { group: 'voice', label: 'per hit', ports: ['accent_in', 'pitch_cv', 'choke_in'] },
      ],
      audioRate: ['trigger_in', 'gate_in', 'roll_speed_cv', 'accent_in', 'pitch_cv', 'choke_in'],
    },
  },

  docs: {
    explanation:
      "A deep, flexible stereo SNARE VOICE — the mate to KICK DRUM — with a genuinely polyphonic two-hand DRUMROLL. Four decoupled generators layer the way a real snare works. HEAD is a four-mode membrane bank at inharmonic Bessel-zero ratios (1 : 1.03 : 1.59 : 2.14) — self-ringing state-variable resonators struck by an impulse, with the fundamental pair damped hardest, so the 'thunk' reads pitchless rather than as a note — plus a downward pitch-drop at the strike (the snare 'pit'). BODY is seeded noise band-passed around the head pitch (the drop bends its centre too, so the whole attack chirps), with a slice of high-passed noise blended in so its decay reads broadband instead of hiding under the wires. WIRE is the defining timbre: bright high-passed noise on a SHARED, re-excitable bed — every strike, trigger or roll stroke, tops the bed up by wire × velocity, and a contact term rides the rectified head displacement on top of that, so the buzz breathes with the membrane and rings on BETWEEN strokes. That shared bed, not the voice count, is what makes a roll continuous. CRACK is a fixed ~6 ms band-passed stick tick, summed above the head onset so the leading edge always pokes through. TONE tilts the whole drum: the tonal voice's gain and the wire bed's move in opposition (0.6×…1.4×) while the head modes crossfade with the noise body — low = bright and sizzle-forward, high = fat and head-forward, 0.5 = neutral. TWO strike inputs feed the one synth: TRIGGER fires exactly one (always centred) hit per rising edge; GATE runs the roll. The roll engine advances two hand phases 180° apart at ROLL SPEED (4–24 strokes/s per hand; the hands interleave, so the composite sticking rate is about double), and each hand-beat schedules a bounce train set by BOUNCE — one stroke, the classic double/open roll, or a dense multi-bounce buzz of up to six sub-strokes with geometric velocity decay and shrinking (4 ms-floored) spacing, with slower hands automatically growing more bounces to fill the gap. Every fired sub-stroke re-excites the wire bed and, within a 70-per-second new-voice budget, takes its own voice from a ten-voice pool (lowest-energy steal), so overlapping decaying tails SUPERPOSE into a continuous roll instead of one mono voice being retriggered into a pulsed 'brap'; past that budget the extra sub-strokes drive the bed alone, which is what a dense buzz sounds like anyway. HUMANIZE adds seeded timing/velocity/detune jitter, and both hand phases and the jitter PRNG reset on the gate's rising edge — a roll is repeatable relative to its gate, and nothing here ever reads a wall clock. The pool sum and the bed then share ONE bus: the mono MID runs a DRIVE saturator (bypassed outright at Drive 0; 2× oversampled tanh, or a 4× oversampled wavefolder + asymmetric shaper when HARD is on, its fold depth riding the head displacement and bed energy), a DC blocker, then LEVEL — while the SIDE signal (the two hands' constant-power pan and the decorrelated wire sizzle) bypasses the shaper and rejoins at the output matrix, where a per-channel tanh CEILING bounds L = mid + side and R = mid − side true-peak-safe however hot it runs. Head, body and crack are identical on both channels for a centred hit, so a mono fold-down never thins: only SPREAD (the two-hand pan — roll-only, since a single trigger hit is always centred) and WIDTH (the wire's L/R decorrelation) put content on the sides, and with both at 0 the channels are exactly equal. ACCENT lifts drive and level continuously and scales stroke velocity, PITCH CV transposes the whole voice at 1V/oct, and CHOKE damps the output while held. Strike it from any trigger/gate/clock/sequencer source.",
    inputs: {
      trigger_in:
        "The STRIKE: each rising edge (crossing 0.5) fires exactly ONE snare hit — a voice is taken from the pool, its modal impulse and envelopes retrigger, the shared wire bed is re-excited, and accent is read at that instant. How long the signal stays high doesn't matter; it's a trigger, not a hold. A trigger hit is always CENTRED and un-detuned (SPREAD only moves the two roll hands), and consecutive hits into an idle pool reuse the same slot and its seed, so they are bit-identical. Patch a sequencer gate, drum-seq lane, or clock here for individual hits.",
      gate_in:
        "The DRUMROLL: WHILE this level is high, the internal two-hand roll engine generates a continuous roll at ROLL SPEED — two alternating hands whose overlapping strokes (and, in buzz mode, multi-bounce trains) keep the snare re-excited faster than it decays. The rising edge resets both hand phases and the jitter PRNG and fires an immediate left-hand stroke, so the roll starts with no initial gap and replays identically for a given gate; on the falling edge scheduling stops and the in-flight voices + wire bed ring out naturally. Hold a long gate here (a sequencer gate with a long gate length, a held clock, an LFO pulse) for a snare roll.",
      roll_speed_cv:
        "Roll-rate CV — a 1V/oct multiply on ROLL SPEED (+1 V doubles the strokes/second, −1 V halves it; the input is clamped to ±4 V and the resulting rate to 1–40 strokes/s per hand), so you can crescendo a roll from a control source or sequence its density. This is the roll's own rate jack, read per sample straight off the input — not a per-control CV centred on the knob.",
      accent_in:
        "Per-hit intensity CV (0..1) doing two things at once. At each strike (the trigger edge and every roll sub-stroke) the stroke velocity is multiplied by 1 + 0.5 × accent and clamped at 1 — a full-velocity primary stroke already sits at that ceiling, so the velocity term mostly lifts the quieter REBOUND strokes of a double/buzz roll — while continuously, per sample, accent also pushes DRIVE up to 30 % harder and LEVEL up to +4 dB, so an accented hit leans into the CEILING clip. Patch a velocity lane or an LFO for dynamics; at 0 it is a no-op.",
      pitch_cv:
        "1V/oct pitch input: transposes the whole voice — head modes and body noise together — as a true frequency multiplier (tune × 2^volts), so a snare line can track a melody or be tuned per step. It is read per sample, so an audio-rate signal here FMs the drum rather than merely transposing it.",
      choke_in:
        "Choke group input (level-sensitive gate): WHILE the level is high the output is damped toward silence through a short ~30 ms ramp (a hand on the head), and on the falling edge it releases and recovers through a ~15 Hz one-pole — both edges matter. It multiplies both channels AFTER the ceiling, so a choked voice stays bounded. Hold it high to duck the snare's ring/roll; it does not fire hits.",
      tune_cv:
        "CV modulation of TUNE (log): ±1 sweeps the head fundamental across its full 90–400 Hz range centred on the knob — the modes and body noise track it. (Distinct from pitch_cv, which transposes the whole voice at 1V/oct.)",
      head_decay_cv:
        "CV modulation of HEAD DEC (log): ±1 sweeps the modal ring's decay across its full 30–600 ms range around the knob — dry tick to ringing head.",
      damping_cv:
        "CV modulation of DAMP (linear): ±1 sweeps the head mode Q across its full 0–1 range around the knob — open and ringy to tight and muted.",
      damp_cv:
        "CV modulation of GLOBAL DAMP (linear): ±1 sweeps the shared head/body/wire decay scaler across its full 0–1 range around the knob — a 'towel on the drum' under CV.",
      pitch_amt_cv:
        "CV modulation of P AMT (linear): ±1 sweeps the strike pitch-drop depth across its full 0–12 st range around the knob — flatten or deepen the snare 'pit'.",
      pitch_time_cv:
        "CV modulation of P TIME (log): ±1 sweeps the pitch-drop settle time across its full 3–80 ms range around the knob — quick chirp to falling attack.",
      tone_cv:
        "CV modulation of TONE (linear): ±1 sweeps the overall bright↔fat tilt across its full 0–1 range around the knob — wire-forward sizzle to head-forward body.",
      body_decay_cv:
        "CV modulation of BODY DEC (log): ±1 sweeps the noise-body decay across its full 20–300 ms range around the knob.",
      wire_cv:
        "CV modulation of WIRE (linear): ±1 sweeps the snare-wire buzz amount across its full 0–1 range around the knob — also driving how hard each strike re-excites the shared wire bed.",
      wire_tone_cv:
        "CV modulation of W TONE (log): ±1 sweeps the wire high-pass corner across its full 1500–9000 Hz range around the knob — dark rattle to papery sizzle.",
      wire_decay_cv:
        "CV modulation of W DEC (log): ±1 sweeps the wire bed's sustain across its full 40–700 ms range around the knob — the roll's continuity control.",
      crack_cv:
        "CV modulation of CRACK (linear): ±1 sweeps the stick-transient level across its full 0–1 range around the knob — softer or snappier leading edge.",
      crack_tone_cv:
        "CV modulation of CK TONE (log): ±1 sweeps the crack band-pass across its full 800–7000 Hz range around the knob — dark knock to bright snap.",
      bounce_cv:
        "CV modulation of BOUNCE (linear): ±1 sweeps the roll type across its full 0–1 range around the knob — single-stroke → double/open → dense multi-bounce buzz.",
      humanize_cv:
        "CV modulation of HUMANIZE (linear): ±1 sweeps the seeded roll jitter across its full 0–1 range around the knob — machine-perfect to loose and human (the detune share of that jitter is scaled by SPREAD).",
      drive_cv:
        "CV modulation of DRIVE (linear): ±1 sweeps the mid-bus saturation across its full 0–1 range around the knob — pump the perceived loudness live.",
      hard_cv:
        "CV modulation of HARD (discrete): the CV is bucketed straight onto the switch by round-half-up, so the flip point sits exactly at CV = 0 — CV ≥ 0 (the midpoint itself included) selects the aggressive wavefold and only CV < 0 selects clean-warm tanh, whatever the knob says. The character switch under CV; only audible while Drive > 0.",
      ceiling_cv:
        "CV modulation of CEILING (linear): ±1 sweeps how hard the bus is pushed into the true-peak soft-clip across its full 0–1 range around the knob — cleaner/quieter to hotter/more clipped.",
      spread_cv:
        "CV modulation of SPREAD (linear): ±1 sweeps the two-hand pan/detune across its full 0–1 range around the knob — mono-centred to hard L/R hands. It shapes ROLLS only; a single trigger hit is centred whatever this reads.",
      width_cv:
        "CV modulation of WIDTH (linear): ±1 sweeps the decorrelated wire-sizzle width across its full 0–1 range around the knob (head and body stay centred).",
      level_cv:
        "CV modulation of LEVEL (linear): ±1 sweeps the output gain across its full −24..+12 dB range around the knob — tremolo or dynamic swells.",
    },
    outputs: {
      audio_l:
        "Left output of the stereo voice — the mid + side sum through the channel's own true-peak tanh ceiling (DRIVE and the DC blocker run on the MID only; the side rejoins here). The head, body and crack of a single centred hit are identical on both sides — only SPREAD (the two-hand roll pan) and WIDTH (the decorrelated wire sizzle) put content on the sides — so a mono fold-down never phase-cancels. Patch L alone for a mono snare; the pair auto-pairs when the target accepts it.",
      audio_r:
        "Right output — the other half of the stereo pair, the mid − side difference through its own ceiling. Carries the same centred head/body/crack as the left; the two-hand roll and the bright wire band differ from L when SPREAD / WIDTH are up, and at Spread 0 with Width 0 the two channels are exactly equal.",
    },
    controls: {
      'snaredrum-hit-{n}':
        "AUDITION \u2014 HIT: one press fires exactly ONE snare hit, identical to a rising edge on trigger_in. It is a button, not a knob: nothing is stored, nothing is shared with the rackspace, and it drives the same worklet input a cable does, so a sequencer patched into trigger_in keeps working while you use it. Its purpose is that this voice makes NO sound until something strikes it \u2014 without the pad the dock offers twenty-two controls over a drum you cannot hear. A hit from here is always centred and un-detuned, exactly like a hit from the jack.",
      'snaredrum-roll-{n}':
        "AUDITION \u2014 ROLL: a MOMENTARY pad. WHILE you hold it the internal two-hand roll engine runs, exactly as it does while gate_in is high, and it stops the instant you let go. Hold-to-roll rather than click-to-roll is not a UI preference: gate_in is declared edge:'gate', the roll exists only for as long as the level stays high, and a roll you could not hold would be a different instrument. Press it with ROLL SPEED and BOUNCE under your other hand \u2014 that is the whole reason those two rank into the lane. Like HIT it writes nothing to the graph, and the gate is force-closed if the pane is closed or the window loses focus mid-hold, so a held roll can never be left running.",
      tune: "HEAD: the snare's fundamental pitch (90–400 Hz, log). The four inharmonic modes track it at their Bessel ratios, and the body noise centres on it. Low = deep/fat snare, high = tight/piccolo. Tracks pitch_cv at 1V/oct.",
      tone: "Overall tonal TILT of the drum (0 = bright, wire/noise-forward sizzle; 1 = fat, head/body-forward). Two things move in opposition: the tonal VOICE's gain rides 0.6→1.4 while the bright wire BED's rides 1.4→0.6, and inside the voice the head modes crossfade with the body noise (the crack tick rides with the voice, not against it). 0.5 leaves both gains at unity — the everyday balance and the shipped default.",
      damping: "HEAD: mode Q / ring character (0 = open and ringy, 1 = tight and muted) — the RELATIVE resonance of the modal bank, applied on top of the damping Head Dec sets, so the knob keeps its full range at any decay length. The (0,1) fundamental pair is damped hardest by design — that is what keeps the thunk pitchless while the upper inharmonic modes carry it.",
      head_decay: "HEAD: the modal ring's decay to −60 dB (30–600 ms, log). It drives the amp envelope AND the resonators' damping — a longer setting lowers their loss so the modes really do ring that long (at short settings the bank self-terminates and the envelope does the work). Short = a dry tick; long = a ringing, resonant head. Scaled shorter by Global Damp.",
      body_decay: "BODY: the noise-body decay to −60 dB (20–300 ms, log) — the length of the drum's noisy tone. Scaled shorter by Global Damp.",
      pitch_amt: "HEAD: depth of the downward pitch-drop at the strike, in semitones (0–12) — the snare 'pit'. The voice starts this far ABOVE its settled pitch and falls, bending the four modes AND the noise body's centre together so the whole attack chirps. 0 = static pitch; higher = a more pronounced pitched-down attack.",
      pitch_time: "HEAD: how fast the pitch-drop settles (3–80 ms, log). Short = a quick chirp; long = an audible falling attack.",
      wire: "WIRE: snare-wire buzz amount (0–1) — the defining sizzle. It sets both the wire level AND how hard every strike tops up the shared wire bed (bed += wire × velocity, clamped at full), so it is the master of a roll's continuous sustain. 0 = a wireless, tom-like drum.",
      wire_tone: "WIRE: the high-pass corner of the wire noise (1500–9000 Hz, log). Lower = a darker, fuller rattle; higher = a bright, papery sizzle that sits on top of the mix.",
      wire_decay: "WIRE: the wire bed's decay to −60 dB (40–700 ms, log) — the sustain of the buzz between strokes. This is what makes a roll continuous: set longer than the stroke interval and the bed never returns to silence mid-roll. Scaled shorter by Global Damp.",
      crack: "CRACK: level of the stick-contact transient (0–1) — a fixed ~6 ms band-passed noise tick, the leading edge the ear locks onto. It is summed ABOVE the head onset (outside the voice's normalization trim, with its own weight) so it always pokes through instead of being averaged away, and it scales with the stroke's velocity. More = a harder, snappier attack.",
      crack_tone: "CRACK: band-pass center of the stick transient (800–7000 Hz, log) — dark knock at the bottom, bright snap at the top.",
      damp: "GLOBAL DAMP: scales the head, body and wire-bed decays DOWN together — ×(1 − 0.6 × damp), so at full every tail runs at 40 % of its set time — and, through the head's ring law, tightens the modal resonance with them. A single 'towel on the drum' choke that never touches the tuning.",
      roll_speed: "ROLL: strokes per hand while the roll GATE is held (0 → 4 Hz, 1 → 24 Hz, exponential; the hands interleave 180° apart, so the composite sticking rate is ≈ 2×). Below ~15–20 Hz composite the individual strokes are audible (a machine-gun/open roll); above it they fuse into a roar. roll_speed_cv multiplies this at 1V/oct and the result is clamped to 1–40 Hz per hand.",
      bounce: "ROLL type: below 0.05 it is a single-stroke roll (one stroke per hand-beat, granular); up to about 0.29 at the default ROLL SPEED it is the classic double/open roll (a primary stroke + one softer rebound); from 0.3 up — the 0.35 default included — a third sub-stroke joins; and → 1 it is a dense multi-bounce buzz / press roll (a bouncing-ball train of up to 6 sub-strokes with geometric decay). The count is set by the knob AND the hand rate together (slower hands add bounces to fill the wider gap), so the same setting reads differently at either end of ROLL SPEED: at the 24 Hz-per-hand top even Bounce 1.0 stays a plain double, while at 4 Hz per hand Bounce 0.6 already schedules four.",
      humanize: "ROLL: seeded (deterministic) jitter on stroke timing (±8 % of the hand period), stroke velocity (±15 %) and per-hand detune (±1.5 semitones) — 0 = machine-perfect, 1 = loose and human. The detune share is scaled by SPREAD, so at Spread 0 the hands stay in tune with each other. The generator reseeds on every roll-gate rising edge, so the same roll replays identically — the constantly-shifting sizzle of a real roll without ever using wall-clock randomness.",
      spread: "ROLL/STEREO: two-hand pan + per-hand detune (0 = mono/centred, 1 = hard L/R hands, each detuned ¾ of a semitone off centre in opposite directions). The drum voices pan properly — the left hand's stroke goes left, the right hand's right, each striking a slightly different spot on the membrane — and the loud wire bed's placement slews (~5 ms per stroke) so the sizzle ping-pongs with the sticking rather than sitting still: a genuine stereo roll image, not a decorrelation trick. Voice and sizzle share ONE constant-power pan, so a stroke arrives as a single coherent hand — body and buzz on the same side — and turning WIRE up widens that image instead of splitting it. (It used to split: the bed's pan term was summed with the sign opposite the voices', which threw a left-hand stroke's sizzle right. Fixed in #1293.) It is a ROLL control either way: a single trigger hit is always dead-centre, so Spread does nothing until the roll gate runs.",
      drive: "DRIVE: saturation on the summed MID — the mono sum of the voice pool plus the wire bed (0–1); the stereo side signal bypasses it. It adds harmonics and perceived loudness at the same peak level. At 0 the shaper is bypassed outright (no oversampling cost); character is set by HARD, and both modes are oversampled (2× clean / 4× hard) so they stay clean.",
      hard: "DRIVE character switch: OFF = clean-warm tanh saturation, 2× oversampled (smooth, the shipping default); ON = a wavefolder + bounded asymmetric shaper, 4× oversampled and driven harder, with its fold depth riding the head displacement and the wire bed's energy so the bite follows the hit — gated/distorted snares. It only engages when DRIVE > 0 — at Drive = 0 the shaper is bypassed, so the switch has no effect until you add drive. One switch instead of a mode menu.",
      ceiling: "OUTPUT: how hard the voice is pushed into the per-channel true-peak soft-clip (0–1) — the gain into the clip tanh is 1 + 2 × ceiling. HIGHER = hotter: louder and more aggressively clipped/compressed; LOWER = cleaner and quieter with more headroom before the clip. The tanh always bounds each channel below full scale, so you can run Level hot regardless.",
      width: "STEREO: M/S width of the decorrelated wire SIZZLE only (0–1). The bed is generated as two independent noise streams and this sets how much of their difference reaches the sides; head, body and crack stay centred/mono-safe. 0 = a mono wire (combine with Spread = 0 for an exactly mono voice, L == R).",
      level: "OUTPUT: output level in dB (−24..+12), applied to mid and side alike BEFORE the ceiling, so hot settings lean into the clip instead of escaping it (an ACCENT adds up to a further +4 dB). The +12 dB of makeup headroom is deliberate — the ceiling stage keeps a hot setting true-peak-safe.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    // 6 audio-rate node inputs (trigger, gate, roll-cv, accent, pitch, choke);
    // ONE stereo output, fanned into separate L / R ports below.
    const worklet = createWorkletNode(node, ctx, PROCESSOR_NAME, {
      numberOfInputs: 6,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });

    // Fan the worklet's 2-channel output into SEPARATE L / R node ports so the
    // stereo image survives downstream (the cube.ts / kickdrum idiom).
    const splitter = ctx.createChannelSplitter(2);
    worklet.connect(splitter, 0);

    // Keep the worklet alive with a single 0-offset silence source on every
    // input, so it processes blocks (and can be struck immediately) even when
    // nothing is patched yet. One ConstantSource, six connections.
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    for (let i = 0; i < 6; i++) silence.connect(worklet, 0, i);

    // THE TWO AUDITIONS (the pads on both faces). Two DEDICATED
    // ConstantSources, each summed into the worklet input its own jack feeds —
    // input 0 = trigger_in (one hit per rising edge), input 1 = gate_in (the
    // roll runs while high). Web Audio SUMS connections, so a real cable on
    // either jack keeps working while the pad is used, and the worklet's
    // per-sample edge/level detection cannot tell the two apart. Both waveforms
    // come from the SHARED $lib/audio/gate-trigger seam — never re-derived
    // here, so the pulse width and the HIGH level are the repo's, not this
    // module's.
    //
    // HOST-SIDE ON PURPOSE: a `strike`/`roll` PARAM would need rows in the
    // worklet's PARAM_TABLE, and snaredrum's ART profile pins the sha of those
    // DSP sources, so it would force a re-capture of a byte-identical baseline.
    const hitCs = ctx.createConstantSource();
    hitCs.offset.value = 0;
    hitCs.start();
    hitCs.connect(worklet, 0, 0);

    const rollCs = ctx.createConstantSource();
    rollCs.offset.value = 0;
    rollCs.start();
    rollCs.connect(worklet, 0, 1);

    // Set initial params from the persisted node state (or defaults).
    const params = worklet.parameters as unknown as Map<string, AudioParam>;
    const initial = node.params ?? {};
    for (const def of snaredrumDef.params) {
      const v = initial[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    const inputsMap = new Map<string, { node: AudioNode; input: number; param?: AudioParam }>();
    inputsMap.set('trigger_in',   { node: worklet, input: 0 });
    inputsMap.set('gate_in',      { node: worklet, input: 1 });
    inputsMap.set('roll_speed_cv', { node: worklet, input: 2 });
    inputsMap.set('accent_in',    { node: worklet, input: 3 });
    inputsMap.set('pitch_cv',     { node: worklet, input: 4 });
    inputsMap.set('choke_in',     { node: worklet, input: 5 });
    // Per-control CV → AudioParam routing (cofefve/karplus convention). The
    // `input: 0` is an unused placeholder; the engine routes onto the
    // AudioParam named by `param` (with the def's cvScale hint applied).
    inputsMap.set('tune_cv',       { node: worklet, input: 0, param: params.get('tune')! });
    inputsMap.set('head_decay_cv', { node: worklet, input: 0, param: params.get('head_decay')! });
    inputsMap.set('damping_cv',    { node: worklet, input: 0, param: params.get('damping')! });
    inputsMap.set('damp_cv',       { node: worklet, input: 0, param: params.get('damp')! });
    inputsMap.set('pitch_amt_cv',  { node: worklet, input: 0, param: params.get('pitch_amt')! });
    inputsMap.set('pitch_time_cv', { node: worklet, input: 0, param: params.get('pitch_time')! });
    inputsMap.set('tone_cv',       { node: worklet, input: 0, param: params.get('tone')! });
    inputsMap.set('body_decay_cv', { node: worklet, input: 0, param: params.get('body_decay')! });
    inputsMap.set('wire_cv',       { node: worklet, input: 0, param: params.get('wire')! });
    inputsMap.set('wire_tone_cv',  { node: worklet, input: 0, param: params.get('wire_tone')! });
    inputsMap.set('wire_decay_cv', { node: worklet, input: 0, param: params.get('wire_decay')! });
    inputsMap.set('crack_cv',      { node: worklet, input: 0, param: params.get('crack')! });
    inputsMap.set('crack_tone_cv', { node: worklet, input: 0, param: params.get('crack_tone')! });
    inputsMap.set('bounce_cv',     { node: worklet, input: 0, param: params.get('bounce')! });
    inputsMap.set('humanize_cv',   { node: worklet, input: 0, param: params.get('humanize')! });
    inputsMap.set('drive_cv',      { node: worklet, input: 0, param: params.get('drive')! });
    inputsMap.set('hard_cv',       { node: worklet, input: 0, param: params.get('hard')! });
    inputsMap.set('ceiling_cv',    { node: worklet, input: 0, param: params.get('ceiling')! });
    inputsMap.set('spread_cv',     { node: worklet, input: 0, param: params.get('spread')! });
    inputsMap.set('width_cv',      { node: worklet, input: 0, param: params.get('width')! });
    inputsMap.set('level_cv',      { node: worklet, input: 0, param: params.get('level')! });

    return {
      domain: 'audio',
      inputs: inputsMap,
      outputs: new Map([
        ['audio_l', { node: splitter, output: 0 }],
        ['audio_r', { node: splitter, output: 1 }],
      ]),
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      // The AUDITION seam — the karplus/samsloop `read(key)` idiom, one key per
      // strike input because the two have different EDGE semantics and a caller
      // that can only do one of them must not silently get the other:
      //   'manualTrigger' → () => void               fires ONE hit  (trigger_in)
      //   'manualGate'    → (high: boolean) => void  holds a roll   (gate_in)
      // Both faces (SnaredrumCard's pads and the shell's `snaredrum-hit` /
      // `snaredrum-roll` cells) go through these, so there is no second
      // implementation to drift.
      read(key: string): unknown {
        if (key === 'manualTrigger') {
          return () => {
            try { fireTrigger(hitCs, ctx.currentTime); } catch { /* */ }
          };
        }
        if (key === 'manualGate') {
          return (high: boolean) => {
            try {
              if (high) openGate(rollCs, ctx.currentTime);
              else closeGate(rollCs, ctx.currentTime);
            } catch { /* */ }
          };
        }
        return undefined;
      },
      dispose() {
        // ⚠ CLOSE THE ROLL GATE BEFORE STOPPING ITS SOURCE. A node deleted
        // mid-hold is one of the release edges the button itself can never see
        // (its <Button> unmounts with the pane), and a gate left open is a drum
        // that rolls forever — see ui/modules/manual-gate-latch.ts.
        try { closeGate(rollCs, ctx.currentTime); } catch { /* */ }
        try { silence.stop(); } catch { /* already stopped */ }
        try { silence.disconnect(); } catch { /* */ }
        try { hitCs.stop(); } catch { /* */ }
        try { hitCs.disconnect(); } catch { /* */ }
        try { rollCs.stop(); } catch { /* */ }
        try { rollCs.disconnect(); } catch { /* */ }
        try { splitter.disconnect(); } catch { /* */ }
        try { worklet.disconnect(); } catch { /* */ }
      },
    };
  },
};
