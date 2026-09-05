// packages/web/src/lib/audio/modules/timelorde.ts
//
// TIMELORDE — central time source per rackspace. TS AudioWorklet for
// sample-accurate phase counters. See packages/dsp/src/timelorde.ts.
//
// Singleton: maxInstances = 1. The whole point is "one canonical clock per
// patch"; multiple TIMELORDEs would invite ambiguity over which is the
// master. TIMELORDE emits a fanout of gate outputs at standard musical
// divisions of the master BPM (1x = quarter; 2x/4x/8x = subdivisions;
// 1/2..1/64 = multiples of the bar) so any module that needs clocking
// can patch the appropriate division directly without a clock-divider
// helper in between.
//
// Inputs:
//   clock (gate):    external clock-in; when patched, the master BPM is locked to its measured period.
//   start_in (gate): rising edge STARTS the clock (running ← 1). Internal phase resumes from
//                    wherever the last stop halted it — musical position is preserved (DAW
//                    transport semantics).
//                    Wire MIDICLOCK.midistart → TIMELORDE.start_in to slave transport to a hardware MIDI device.
//   stop_in (gate):  rising edge HALTS the clock (running ← 0). Phase accumulator + sample
//                    counter + pending pulses all freeze; outputs go low. This is DIFFERENT from
//                    the card's MUTE button (which silences outputs but keeps the clock turning
//                    for LIVECODE). A patched stop is a real transport stop.
//                    Wire MIDICLOCK.midistop → TIMELORDE.stop_in for the matching stop side.
//   gate (gate):     LEVEL-SENSITIVE show/hide for the card's dot-matrix neon WIZARD graphic.
//                    gate HIGH (level ≥ GATE_HI) = wizard ON; gate LOW = wizard OFF. NOT
//                    edge-triggered (holding high keeps it on). Converges on the SAME wizardOn
//                    state as the on-card toggle button (button = manual override; gate =
//                    external control). Card-visual only — the DSP ignores it.
//
// Outputs:
//   1x (gate): quarter-note pulse at the master BPM.
//   2x / 4x / 8x (gate): faster subdivisions of the quarter (eighth / sixteenth / 32nd).
//   1/2 / 1/3 / 1/4 / 1/8 / 1/12 / 1/16 / 1/32 / 1/64 (gate): multiples of the quarter (half-note .. 64-bar).
//   swing (gate): shadows whichever train swingSource selects, holding its OFF-BEATS
//     back by swingAmount (a fraction of that train's own pulse interval); use as a
//     swung clock.
//
// Params:
//   bpm (log 10..300, default 120): master tempo.
//   swingAmount (linear 0..90°, default 0): swing offset applied to the `swing` output.
//   swingSource (discrete 0..11, default 0): which division feeds the swing tap
//     (one entry per gate output, 1x .. 1/64 — SWING_SOURCES has 12).
//   muteOutputs (discrete 0..1, default 0): 1 = silence every gate output but the internal
//                clock keeps running for LIVECODE / tick subscribers. Bound to the card's
//                MUTE button.
//   running     (discrete 0..1, default 1): 1 = clock advances, 0 = clock HALTED (phase
//                accumulator + sample-counter freeze). Bound to start_in / stop_in transport
//                gates. Distinct from muteOutputs: a stopped clock has no ticks to mute.
//   wizardOn    (discrete 0..1, default 1): card-only — 1 = the dot-matrix neon WIZARD graphic
//                is shown (and pulses with the beat while running), 0 = hidden. Driven by both
//                the on-card toggle button and the `gate` input level. Not consumed by the DSP.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { patch as livePatch } from '$lib/graph/store';
import workletUrl from '@patchtogether.live/dsp/dist/timelorde.js?url';
import { getSchedulerClock } from '$lib/audio/scheduler-clock';
import { createRisingEdgeDetector } from './transport-helpers';
import { gateLevelToWizardOn } from './timelorde-wizard';
import { timelordeTransportState } from './timelorde-transport-state';

import { createWorkletNode } from '$lib/audio/worklet-guard';
const loadedContexts = new WeakSet<BaseAudioContext>();

// ---------------- Pure transport-event helper ----------------
//
// Given how many start_in / stop_in rising edges fired in the most recent
// poll window and the CURRENT running value, decide the next running
// value. This is a real transport halt/resume — NOT the card's mute. A
// stop_in rising edge sets running ← 0 (clock phase freezes); start_in
// sets running ← 1 (resumes from the frozen position). Pure + sync —
// runs in vitest without an AudioContext.
//
// Ordering: if both edges fired inside the same poll window (unusual
// but possible at high tick periods), stop wins — matches the
// conservative "if a stop happened, honor it" interpretation. The
// pulse-per-call shape means a redundant start while already running
// is a no-op (idempotent), and likewise a stop while already halted.
export function transportEventsToRunState(args: {
  startEdges: number;
  stopEdges: number;
  prevRunning: 0 | 1;
}): 0 | 1 {
  if (args.stopEdges > 0) return 0;
  if (args.startEdges > 0) return 1;
  return args.prevRunning;
}

// ---------------- Pure EXTERNAL-CLOCK BPM LOCK helper ----------------
//
// ⚠ THE DEFECT THIS EXISTS TO CLOSE, and it is a DATA-LOSS one rather than an
// audio one. When a cable sits in `clock` the worklet posts its measured tempo
// and the factory writes it into BOTH the `bpm` AudioParam and
// `livePatch.nodes[id].params.bpm` — because LIVECODE's `clock.bpm()` reads the
// stored param and would otherwise diverge from the rack. That write-through is
// correct and stays. What was wrong is that it was DESTRUCTIVE: patch a
// MIDICLOCK running at 137 into a rack whose player had hand-set 120, pull the
// cable out again, and the knob is at 137 forever. The hand-set tempo is gone,
// there is no undo marker (the write does not ride the UndoManager — it is a
// factory write, not a user edit), and the ONE hint that a follower owned the
// number lived in a card footer that faceplates do not paint.
//
// The factory's own comment argued the overwrite was intentional ("the last
// followed tempo is the most sensible value to hold"). That argument is about
// what to hold WHILE LOCKED, and it is right; it says nothing about what to hold
// after the cable is gone. So the lock is now NON-DESTRUCTIVE: the player's
// tempo is STASHED the moment the follower first takes the knob, and RESTORED
// when the cable leaves. Nothing about the locked behaviour changes — every
// reader still sees the measured tempo for exactly as long as the clock owns it.
//
// Pure + sync (the transportEventsToRunState shape) so the whole three-edge
// state machine runs in vitest with no AudioContext, no worklet and no timers.
export interface BpmLockState {
  /**
   * The tempo the PLAYER set, stashed at the instant an external clock first
   * overwrote it. `null` = no external clock currently owns the tempo, so there
   * is nothing to give back.
   */
  stashed: number | null;
}

/** A rack with no external clock patched: nothing stashed, nothing owed. */
export const BPM_LOCK_UNLOCKED: BpmLockState = { stashed: null };

/** TIMELORDE's declared `bpm` range — the clamp the follower has always applied
 *  (a glitchy measurement must not push the param out of bounds). Exported so a
 *  test asserts against the DEF's numbers rather than re-typing them. */
export const TIMELORDE_BPM_MIN = 10;
export const TIMELORDE_BPM_MAX = 300;
function clampTimelordeBpm(bpm: number): number {
  return Math.max(TIMELORDE_BPM_MIN, Math.min(TIMELORDE_BPM_MAX, bpm));
}

/**
 * A `measuredBpm` message arrived from the worklet.
 *
 * `measuredBpm <= 0` is the worklet's DROPOUT signal — the cable is still
 * patched, the pulses merely stopped — so it writes nothing and stashes nothing:
 * the external clock still owns the tempo and the last followed value stands.
 * That is the half of the old comment's argument which was always right.
 */
export function externalBpmLockOnMeasure(
  state: BpmLockState,
  args: { measuredBpm: number; storedBpm: number },
): { state: BpmLockState; write: number | null } {
  if (!(args.measuredBpm > 0)) return { state, write: null };
  // ⚠ STASH ONLY ON THE FIRST TAKE-OVER. Re-stashing on every measurement would
  // capture the FOLLOWED tempo (we wrote it ourselves one message ago) and the
  // restore would hand back the external clock's value — a fix that restores
  // nothing while looking exactly like one.
  const stashed = state.stashed ?? args.storedBpm;
  return { state: { stashed }, write: clampTimelordeBpm(args.measuredBpm) };
}

/**
 * The player moved the BPM control (the handle's `setParam` path — the knob, the
 * face cell, TAP, the topbar clock surface: every user write lands there).
 *
 * While a lock is live this REPLACES the stash, so unlocking gives back the
 * player's latest intent rather than whatever the tempo happened to be when the
 * cable went in. With no lock there is nothing to remember — the stored param
 * IS the truth — and stashing then would make the next unlock restore a stale
 * value.
 */
export function externalBpmLockOnUserWrite(state: BpmLockState, value: number): BpmLockState {
  if (state.stashed === null) return state;
  return { stashed: value };
}

/**
 * The `clock` cable was removed (or was never there). Returns the tempo to write
 * back, or `null` when nothing is owed — which is the overwhelmingly common case
 * and must therefore be a no-op rather than a write of a default.
 */
export function externalBpmLockOnUnpatch(state: BpmLockState): {
  state: BpmLockState;
  restore: number | null;
} {
  if (state.stashed === null) return { state, restore: null };
  return { state: BPM_LOCK_UNLOCKED, restore: state.stashed };
}

export const timelordeDef: AudioModuleDef = {
  type: 'timelorde',
  palette: { top: 'Audio modules', sub: 'Utility' },
  domain: 'audio',
  label: 'timelorde',
  category: 'modulation',
  maxInstances: 1,
  // TIMELORDE is the rack's system clock — every sequencer + LIVECODE's
  // clocked() function ride on it. Can't be deleted; if a rack is opened
  // without one, the auto-spawn path (see Canvas.svelte init effect) drops
  // one in at a fixed position so the rack is always musically coherent.
  undeletable: true,

  inputs: [
    // External clock — when patched, snaps 1x to incoming rising edges and
    // measures period for multiplier prediction. Disconnect → falls back
    // to internal BPM after ~2 master periods.
    { id: 'clock', type: 'gate', edge: 'trigger' },
    // start_in / stop_in: transport gates that mirror the card's
    // ON / MUTE button. Designed for MIDICLOCK.midistart →
    // TIMELORDE.start_in + MIDICLOCK.midistop → TIMELORDE.stop_in so a
    // hardware MIDI device can drive the rack's transport. Rising-edge
    // detection runs on a scheduler-clock poll (same TICK_MS the rest
    // of the sequencer transport uses); idempotent — a start while
    // already running is a no-op, same for stop while already muted.
    { id: 'start_in', type: 'gate', edge: 'trigger' },
    { id: 'stop_in',  type: 'gate', edge: 'trigger' },
    // gate (LEVEL-SENSITIVE, edge: 'gate'): external show/hide for the
    // dot-matrix neon WIZARD card graphic. gate HIGH (level ≥ GATE_HI) =
    // wizard ON; gate LOW = wizard OFF. NOT edge-triggered — holding the
    // gate high keeps the wizard on (it does not toggle per rising edge).
    // Converges on the SAME wizardOn state the on-card button drives (the
    // button = manual override; the gate = external control). When no gate
    // is patched, only the button governs. See gateLevelToWizardOn() in
    // timelorde-wizard.ts (one-spot place to flip the meaning).
    { id: 'gate',     type: 'gate', edge: 'gate' },
    // video_in (cross-domain VIDEO input): patch a video feed here and the
    // card's big display becomes a LIVE MONITOR of that feed (the wizard steps
    // aside) — and `video_out` passes the feed through, so TIMELORDE can sit
    // INLINE in a video chain (in → display → out). When nothing is patched
    // the display shows the beat-pulsing wizard (the original behaviour).
    //
    // Consumed CARD-SIDE (the SYNESTHESIA / WAVESCULPT-wall precedent): the
    // card walks patch.edges to find the upstream source and blits its frame
    // into the display + the passthrough. The audio engine has no AudioNode
    // for a video port, so PatchEngine.addEdge IGNORES the video-frame edge
    // (same-domain audio video-frame branch) — no graph wiring needed here.
    { id: 'video_in', type: 'video' },
  ],
  outputs: [
    // Order MUST match dsp/timelorde.ts OUT_* indices.
    //
    // ⚠ THIS ARRAY MUST STAY AN INLINE LITERAL INSIDE THE DEF, and that is a
    // PARSER constraint rather than a style one. The living-docs manifest reads
    // this file as TEXT (`readModule`, module-manifest.ts) and looks for
    // `outputs: [ … ]` in the def object; hoisting it to a named const made the
    // manifest emit ZERO outputs for this module while every runtime gate stayed
    // green — measured, by module-manifest.test.ts, on exactly that refactor.
    // The swing-source roster is therefore derived AFTER the def instead (see
    // TIMELORDE_SWING_SOURCES below).
    { id: '1x',    type: 'gate', edge: 'trigger' },
    { id: '8x',    type: 'gate', edge: 'trigger' },
    { id: '4x',    type: 'gate', edge: 'trigger' },
    { id: '2x',    type: 'gate', edge: 'trigger' },
    { id: '1/2',   type: 'gate', edge: 'trigger' },
    { id: '1/3',   type: 'gate', edge: 'trigger' },
    { id: '1/4',   type: 'gate', edge: 'trigger' },
    { id: '1/8',   type: 'gate', edge: 'trigger' },
    { id: '1/12',  type: 'gate', edge: 'trigger' },
    { id: '1/16',  type: 'gate', edge: 'trigger' },
    { id: '1/32',  type: 'gate', edge: 'trigger' },
    { id: '1/64',  type: 'gate', edge: 'trigger' },
    { id: 'swing', type: 'gate', edge: 'trigger' },
    // video_out (cross-domain VIDEO output): the picture TIMELORDE's big
    // display shows — the LIVE video feed when something is patched into
    // video_in, else the beat-pulsing wizard. Published via the handle's
    // `videoSources` map with a `drawFrame` (the SCOPE precedent for an
    // AUDIO module driving a video source): the card pushes the current
    // display frame into the node each rAF (handle.write('displayFrame', …)),
    // and drawFrame() blits the latest one for the cross-domain video bridge,
    // so a downstream video module sees the feed pass through.
    { id: 'video_out', type: 'video' },
  ],
  params: [
    { id: 'bpm',          label: 'BPM',   defaultValue: 120, min: 10, max: 300, curve: 'log',      units: 'bpm' },
    { id: 'swingAmount',  label: 'Swing', defaultValue: 0,   min: 0,  max: 90,  curve: 'linear',   units: 'deg' },
    // swingSource: its `options` roster is DERIVED from this def's own output
    // fanout and ATTACHED just below the def — see TIMELORDE_SWING_SOURCES for
    // why it cannot be written here. Twelve options is past
    // SEGMENTED_MAX_OPTIONS, so the faceplate resolves a portaled SELECTOR
    // printing the same twelve names the card prints, instead of an anonymous
    // twelve-position dial reading `5`.
    { id: 'swingSource',  label: 'Src',   defaultValue: 0,   min: 0,  max: 11,  curve: 'discrete' },
    // muteOutputs (v2): 0 (default) = running + gates fire normally;
    // 1 = gates muted but the INTERNAL clock keeps generating so
    // LIVECODE's clocked() callbacks + any other consumers stay
    // alive. v1's `isPlaying` was inverted in meaning AND stopped
    // the internal clock entirely; LIVECODE needs the clock to
    // outlive the gates, so v2 splits "is the clock running" (always
    // true) from "are gates audible" (the new muteOutputs param).
    // Patches saved on v1 carry `params.isPlaying`; the factory
    // converts inline (see readMuteOutputs() below) so old racks
    // start MUTED iff the user had explicitly stopped them.
    //
    // ⚠ THE `options` ROSTER IS THE WHOLE POINT OF THIS PAIR, and it is not
    // about selectability — `looksLikeToggle` already derives a switch from a
    // 0/1 discrete param. It is about the ONE kind of resting text the faceplate
    // ruling permits: an option NAME that disambiguates a control's own
    // position. `running = 0` and `muteOutputs = 1` are BYTE-IDENTICAL on all
    // thirteen gate outputs (measured on the clock core,
    // timelorde-clock-core.test.ts), so a player hunting "why is my whole rack
    // silent" cannot answer it from any cable — only from seeing both switches
    // NAME their states side by side. The words are STATES, not verbs: a roster
    // reading STOP/START would be a command on a latching control.
    { id: 'muteOutputs',  label: 'Mute',  defaultValue: 0,   min: 0,  max: 1,   curve: 'discrete',
      options: [
        { value: 0, label: 'GATES LIVE' },
        { value: 1, label: 'MUTED' },
      ] },
    // running (v3): driven exclusively by start_in / stop_in transport
    // gate inputs. Default 1 = clock advances. When 0 the worklet
    // freezes phase + sample-count + pending pulses; on resume the
    // counters pick up from the halted position (musical position
    // preserved). Patches save it so a stopped rack stays stopped on
    // reload. ⚠ The line that used to sit here — "the card has no button
    // for this, only the external gates can flip it" — has been false
    // since the card grew its RUN button, and is doubly so now: the
    // faceplate paints it as a NAMED two-state control at rank 2.
    { id: 'running',      label: 'Run',   defaultValue: 1,   min: 0,  max: 1,   curve: 'discrete',
      options: [
        { value: 0, label: 'STOPPED' },
        { value: 1, label: 'RUNNING' },
      ] },
    // wizardOn (card-only): 1 (default) = the dot-matrix neon WIZARD graphic
    // is shown (and pulses with the beat while running); 0 = hidden. Driven
    // by BOTH the on-card toggle button (manual override) AND the `gate`
    // input level (external control) — the two converge here. NOT consumed
    // by the DSP worklet (purely a card-visual flag); it lives as a param so
    // it persists on node.data + syncs to rack-mates via Y.Doc like every
    // other card-state param.
    { id: 'wizardOn',     label: 'Wizard', defaultValue: 1,  min: 0,  max: 1,   curve: 'discrete' },
  ],

  // Module-grouping Phase 4 — surface every knob (BPM / Swing / Src) so a
  // containing GROUP! can opt to expose any subset on its bar. The play
  // toggle is intentionally NOT exposable here because TIMELORDE's local
  // play UI hides itself whenever an external clock is patched; the same
  // gating logic would have to be ported into the group bar to avoid
  // surprises. v1 covers knobs only; the button can be added later.
  exposableControls: [
    { id: 'bpm',         label: 'BPM',   kind: 'knob', paramId: 'bpm' },
    { id: 'swingAmount', label: 'Swing', kind: 'knob', paramId: 'swingAmount' },
    { id: 'swingSource', label: 'Src',   kind: 'knob', paramId: 'swingSource' },
  ],

  // TAP TEMPO is not a param — it is a CALL into a TapTempo controller that,
  // from the second tap onward, writes the ordinary `bpm` param. A family entry
  // is how a non-param control gets a rank, a doc blurb and a shell cell; the
  // `testidPrefix` matches the testid this module already used, so every
  // surface addresses one control by one string.
  controlFamilies: [
    { id: 'timelorde-tap', label: 'Tap tempo', kind: 'transport', testidPrefix: 'timelorde-tap' },
  ],

  // ── THE FACEPLATE ────────────────────────────────────────────────────────
  //
  // `order` is PRIORITY (what a shrinking tier keeps); `pages` is FUNCTION
  // order. They disagree DELIBERATELY here and the disagreement is the design:
  // the transport pair ranks 2/3 because a stopped rack is the worst state this
  // module can be in, while `bpm` — rank 1 — sits in a band of its own because
  // tempo and transport are different questions.
  //
  //  1 `bpm`         on most modules rank 1 is the thing you RIDE; here it is
  //                  the thing the whole rack is DERIVED from. Thirteen outputs
  //                  and every sequencer in the patch are a function of this one
  //                  number, and it is the only continuous control on the
  //                  module. Nothing else can be rank 1.
  //  2 `running`     the control that un-silences a silent rack. It outranks
  //                  MUTE because STOP is the strictly worse state: un-muting a
  //                  stopped rack does not start it
  //                  (timelorde-transport-state.ts). ⚠ Wrong ranking for any
  //                  non-singleton — on a per-voice module a transport toggle is
  //                  setup, not performance.
  //  3 `muteOutputs` the other half of the pair, and the two are only legible
  //                  TOGETHER: their two rosters side by side are the only
  //                  surface that separates four states the jacks cannot.
  //  4 `swingAmount` the only other continuous control. Below the transport pair
  //                  because it is INERT at its shipped default (0 = an exact
  //                  duplicate of the source), and a lane cell that does nothing
  //                  on a fresh spawn is worse than absent.
  //  5 `swingSource` setup, not performance — chosen once. Legible at the dock
  //                  as a named selector, pointless at a 46 px lane column where
  //                  `paramCellKind` degrades every roster to a knob.
  //  6 `wizardOn`    it governs a picture that only exists on the DOCK, so a
  //                  lane cell for it would switch something the lane cannot
  //                  show.
  //  7 TAP          ⚠ DOCK-ONLY, AND THAT IS A REAL LOSS ARGUED RATHER THAN A
  //                  formality. With `glyph: 'none'` the caps are mini 1 /
  //                  compact 3 / plate 6, so rank 7 never reaches a lane tier —
  //                  and TAP is a PERFORMANCE gesture, which normally wins that
  //                  argument. It loses here because each of the six params
  //                  above it is defensible on its own AND because TAP alone has
  //                  a working keyboard route the params do not (Space, while
  //                  the node is selected). Revert = rank it 5 and demote
  //                  `swingSource`; the cost is the swing division going back to
  //                  an anonymous lane knob.
  //
  // ⚠ `glyph: 'none'` IS FORCED, NOT CHOSEN. `hasVideoSurface` is
  // `domain === 'video'` and timelorde is audio, so the lane paints no
  // VideoTileThumb; and `primaryAudioOutPortId` matches `type === 'audio'`,
  // while all fourteen outputs are thirteen `gate` plus one `video` — so every
  // glyph literal except 'none' resolves `{kind:'static'}` and reddens the
  // dead-glyph clause. The lane tile is controls-only. That is a five-module
  // platform gap (`ShellExtension.glyph` renders only under
  // `binding.kind === 'algorithm'`), not a decision made here.
  face: {
    order: [
      'bpm',
      'running',
      'muteOutputs',
      'swingAmount',
      'swingSource',
      'wizardOn',
      'timelorde-tap-{n}',
    ],
    glyph: 'none',
    extension: 'timelorde',
    pages: [
      // TRANSPORT. The two params that decide whether the RACK MOVES, adjacent,
      // because they are only legible as a pair. TAP is homed HERE and not in
      // `tempo`: it SETS the tempo, so it reads as a tempo control — but it is a
      // PRESS, and the one thing a press belongs beside is the other things you
      // press.
      { id: 'transport', label: 'transport', controls: ['running', 'muteOutputs', 'timelorde-tap-{n}'] },
      // TEMPO. One continuous control and the thing it is measured in.
      { id: 'tempo', label: 'tempo', controls: ['bpm'] },
      // SWING. Depth and which train it shadows: one idea, two halves, and the
      // second is meaningless without the first.
      { id: 'swing', label: 'swing', controls: ['swingAmount', 'swingSource'] },
      // DISPLAY. ⚠ THIS BAND IS THE DECLARED FALLBACK, NOT THE FIRST CHOICE, and
      // the reason is worth keeping. The design wanted `wizardOn` painted by the
      // BODY beside the picture it governs — but the body-surfaced-control
      // mechanism is `face.xyPads[].surface`, which exists only for PADS, and
      // `module-face-lint`'s completeness loop has no filter and no skip list: a
      // param with no cell is RED. Painting it in BOTH places is refused for a
      // different gate — `faces-parity` asserts EXACT multiset equality between
      // the dock's `control-*` testids and the def's param ids, and it scans the
      // extension body too, so a second `control-wizardOn` fails the whole face.
      // So the switch lives in a band and the body paints only the picture and
      // its SCREEN switch. Nothing is lost: the card's owl-thumbnail button was
      // decoration on the same param.
      { id: 'display', label: 'display', controls: ['wizardOn'] },
    ],
    // ⚠ AUTHORED BECAUSE THE DERIVATION CANNOT SEE THESE JOINS, and that is a
    // property of the PORT NAMES rather than a shortfall. `face.rear` derives a
    // section per page from the `<param>_cv` convention; timelorde's inputs
    // target the same state under different names — `start_in`/`stop_in` drive
    // `running`, `gate` drives `wizardOn` — so nothing joins them and the whole
    // input rail would be uncurated. These two groups make the rear say what the
    // front says. The OUTPUT rail is left ALONE: thirteen gate jacks and one
    // video jack split by cable domain is already right, and
    // `rearSectionColumns` widens the gate section on its own.
    rear: {
      groups: [
        { id: 'transport', label: 'transport', ports: ['start_in', 'stop_in'] },
        { id: 'tempo', label: 'clock', ports: ['clock'] },
      ],
    },
  },

  docs: {
    explanation:
      "The rack's master clock — one canonical tempo source per patch (it's a singleton and can't be deleted; a rack that opens without one gets one dropped in automatically). Set a BPM and TIMELORDE fans out a whole family of clock outputs at standard musical divisions of that tempo, from a quarter-note pulse up through sixteenths and down to multi-bar pulses, plus a swung tap — so any sequencer, LFO, or trigger consumer can patch the exact division it needs without a separate clock divider. Patch an external clock into CLOCK IN and it locks its tempo to the incoming pulses (and follows that measured BPM everywhere, including LIVECODE's clock). Its transport is drivable hands-free via START/STOP gate inputs (wire a MIDICLOCK's start/stop to slave the rack to hardware), and the big card display shows a beat-pulsing neon WIZARD — or, if you patch a video feed into VIDEO IN, it becomes a live monitor that also passes the feed through VIDEO OUT, so TIMELORDE can sit inline in a video chain.",
    inputs: {
      clock:
        "External clock input: while patched, TIMELORDE locks its master tempo to the measured period between incoming rising edges, so every division output tracks the external pulse train. Unpatch and it falls back to the internal BPM after a couple of beats — and to the BPM YOU set, not to the tempo the hardware happened to be running: the lock puts your setting aside rather than overwriting it. One beat of lock-in is unavoidable: a period needs two edges to measure, so the FIRST incoming beat has its 2x / 4x / 8x subdivisions laid out at whatever tempo the BPM knob says instead. They are all still there — the spacing is off for one beat, nothing is dropped — and from the second beat on the multipliers ride the measured tempo. Set the knob near the incoming tempo and even that beat lands where you expect.",
      start_in:
        "Transport START: a rising edge resumes the clock from wherever it was last stopped (musical position is preserved, like a DAW play button). Wire MIDICLOCK's start here to slave the rack's transport to a hardware MIDI device.",
      stop_in:
        "Transport STOP: a rising edge halts the clock — phase, sample counter and pending pulses all freeze and the outputs go low. This is a real transport stop (distinct from the faceplate's MUTE, which silences the gates but keeps the clock turning). Wire MIDICLOCK's stop here for the matching stop side.",
      gate:
        "Wizard show/hide control — a level-sensitive (not edge-triggered) gate: while it is held high the neon WIZARD graphic is shown, while it is low the wizard is hidden. It converges on the same state as the faceplate's wizard toggle (the button is a manual override, this input is external control). Card-visual only — the clock ignores it.",
      video_in:
        "Cross-domain video input: patch a video feed here and the faceplate's big display becomes a live monitor of that feed (the wizard steps aside) and the feed passes through to VIDEO OUT, so TIMELORDE can sit inline in a video chain.",
    },
    outputs: {
      "1x": "Quarter-note clock — one pulse per beat at the master BPM. The reference division everything else is built from.",
      "8x": "32nd-note clock — eight pulses per beat (the fastest subdivision tap). Like the other multipliers it is exact from the very first beat: the subdivision is computed from the tempo you set, not measured from a beat that has already gone by, so its first pulse lands on the downbeat together with 1x. (With an EXTERNAL clock patched there is one exception that cannot be avoided — see CLOCK IN.)",
      "4x": "Sixteenth-note clock — four pulses per beat. Exact from the first beat, same as 8x.",
      "2x": "Eighth-note clock — two pulses per beat. Exact from the first beat, same as 8x.",
      "1/2": "Half-note clock — one pulse every two beats.",
      "1/3": "One pulse every three beats (dotted/triplet-feel longer division).",
      "1/4": "One pulse every four beats — once per bar in 4/4. Like every divider it fires on the FIRST beat of its group, coincident with 1x, so it lands on the downbeat.",
      "1/8": "One pulse every eight beats — once every two bars.",
      "1/12": "One pulse every twelve beats — once every three bars.",
      "1/16": "One pulse every sixteen beats — once every four bars.",
      "1/32": "One pulse every thirty-two beats — once every eight bars.",
      "1/64": "One pulse every sixty-four beats — once every sixteen bars (the slowest tap, for very long-form modulation).",
      swing:
        "A SHUFFLED copy of whichever division SRC selects (1x by default): its on-beats fire dead on time and its off-beats are held back by the SWING amount, so the pulses alternate long-short instead of arriving evenly. At SWING 0 it is an exact duplicate of the source, which makes it safe to patch permanently and dial the shuffle in later. Patch it where you want a swung rather than straight clock.",
      video_out:
        "Cross-domain video output: the picture the faceplate's big display shows — the live feed when something is patched into VIDEO IN, otherwise the beat-pulsing wizard — passed on for downstream video modules.",
    },
    controls: {
      bpm: "BPM — the master tempo every division output is derived from (10–300). While an external clock is patched into CLOCK IN the measured external tempo takes the control over, so everything that reads the tempo (the outputs, LIVECODE's clock, a collaborator's screen) agrees with the hardware. Your own setting is not lost while that happens: it is put aside and handed back the moment you pull the clock cable out, and if you re-set the tempo during the lock it is that later setting you get back.",
      swingAmount: "SWING — how far the SWING output's off-beats are pushed late, as an angle of the SOURCE division's own pulse interval (0–90°, so at most a quarter of the way to the next pulse); 0 is dead-straight, higher values deepen the shuffle. Because it is measured against the SRC train rather than the master beat, the same setting means the same feel whichever division you swing.",
      swingSource: "SRC — which clock division feeds the SWING tap (0–11, one per gate output in the order 1x, 8x, 4x, 2x, 1/2, 1/3, 1/4, 1/8, 1/12, 1/16, 1/32, 1/64), so you can shuffle a faster or slower subdivision than the default 1x quarter-note.",
      muteOutputs:
        "MUTE — silences every gate output while the internal clock keeps running underneath (so LIVECODE's clocked() callbacks and other tick subscribers stay alive). Bound to the faceplate\'s MUTE button. Different from a transport STOP, which actually halts the clock — but NOT different at the jacks: a muted clock and a stopped one both send nothing at all down every one of the thirteen outputs, so a cable cannot tell you which one is silencing your rack. The faceplate\'s TRANSPORT readout names the state (RUNNING / STOPPED / MUTED / STOPPED + MUTED); read it before you go hunting for a broken patch cable.",
      running:
        "RUN — the transport state (1 = clock advancing, 0 = halted with phase frozen). It is driven by the START/STOP gate inputs as well as the faceplate's transport button, and is saved so a stopped rack reloads stopped. Halting is a real stop: the phase accumulator, the sample counter and the pending pulses all freeze, so nothing downstream advances (unlike MUTE, which only silences the gates). Because both states look identical from a patch cable, the faceplate\'s TRANSPORT readout is the thing that tells them apart — and note that STOPPED + MUTED is its own state: un-muting a rack that is also stopped will not start it.",
      wizardOn:
        "WIZARD — whether the owl display is shown (1) or hidden (0); it pulses with the beat while running. Driven by both this switch and the level on the gate input, which converge on one state. Display-only — not used by the clock, and VIDEO OUT keeps passing the picture on either way.",
      'timelorde-tap-{n}':
        "TAP — set the tempo by ear: tap it twice in time with the beat and the BPM locks to the interval you tapped, then keep tapping to refine it (it takes the median of your recent taps, so one mistimed tap does not drag the estimate, and a pause of about two seconds starts a fresh count). It writes the ordinary BPM control, so the value persists and syncs to everyone in the rack. While an external clock is patched into CLOCK IN it does nothing at all — the measured external tempo owns the BPM then.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = createWorkletNode(node, ctx, 'timelorde', {
      numberOfInputs: 1,
      numberOfOutputs: 13,
      outputChannelCount: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    });

    // The worklet's clock input always exists; tests + the engine plug a
    // ConstantSource of silence in so the node sees an active inbound to
    // remain in the graph even when no cable is patched.
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    silence.connect(workletNode, 0, 0);

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of timelordeDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }
    const bpmParam = params.get('bpm');
    const swAmt = params.get('swingAmount');
    const swSrc = params.get('swingSource');
    const muteOutputsParam = params.get('muteOutputs');
    const runningParam = params.get('running');
    const hasExt = params.get('hasExternalClock');

    // v1 → v2 inline migration: existing patches saved `isPlaying`
    // (1=playing/0=stopped). v2 renamed to `muteOutputs` (inverted
    // semantic). If the loaded params carry the legacy field, copy it
    // forward at spawn time so the user's intent survives.
    const legacyIsPlaying = (node.params ?? {})['isPlaying'];
    if (
      typeof legacyIsPlaying === 'number' &&
      (node.params?.['muteOutputs'] === undefined) &&
      muteOutputsParam
    ) {
      const muted = legacyIsPlaying >= 0.5 ? 0 : 1;
      muteOutputsParam.setValueAtTime(muted, ctx.currentTime);
    }

    const nodeId = node.id;

    // The player's own tempo, held for the duration of an external lock. See
    // BpmLockState above for the data-loss defect this closes.
    let bpmLock: BpmLockState = BPM_LOCK_UNLOCKED;
    function writeBpm(value: number): void {
      bpmParam?.setValueAtTime(value, ctx.currentTime);
      const live = livePatch.nodes[nodeId];
      if (live?.params) live.params.bpm = value;
    }

    // hasExternalClock is reflected from the live patch every ~250 ms so the
    // worklet knows when to honor isPlaying vs force always-on.
    let timer: ReturnType<typeof setInterval> | null = null;
    function syncExternalFlag() {
      let hasEdge = false;
      for (const edge of Object.values(livePatch.edges)) {
        if (!edge) continue;
        if (edge.target.nodeId === nodeId && edge.target.portId === 'clock') {
          hasEdge = true;
          break;
        }
      }
      if (hasExt) hasExt.setValueAtTime(hasEdge ? 1 : 0, ctx.currentTime);
      // ⚠ THE UNLOCK EDGE IS THE CABLE LEAVING, NOT THE PULSES STOPPING. The
      // worklet posts `bpm: 0` on dropout while the cable is still in, and that
      // is NOT an unlock — the external transport still owns the tempo and the
      // last followed value must stand. This scan is the only place that knows
      // the difference, which is why the restore lives here and not in the
      // message handler.
      if (!hasEdge) {
        const { state, restore } = externalBpmLockOnUnpatch(bpmLock);
        bpmLock = state;
        if (restore !== null) writeBpm(restore);
      }
    }
    syncExternalFlag();
    timer = setInterval(syncExternalFlag, 250);

    // The worklet posts { type: 'measuredBpm', bpm } whenever the locked
    // external tempo drifts (>0.1 BPM) and posts bpm:0 on dropout. We
    // cache the latest value here and surface it via read('measuredBpm')
    // so TimelordeCard can show the tempo TIMELORDE is actually locked
    // to, not the stale internal knob.
    let measuredBpm = 0;
    workletNode.port.onmessage = (e: MessageEvent) => {
      const m = e.data as { type?: string; bpm?: number } | undefined;
      if (m && m.type === 'measuredBpm' && typeof m.bpm === 'number') {
        measuredBpm = m.bpm;
        // ── External-clock BPM follow (Phase-2 gap-fill) ──
        //
        // Before this, the worklet's measured external tempo was DISPLAY-
        // ONLY (read('measuredBpm') for the card); the `bpm` param stayed at
        // the stale internal knob. So while the GATE OUTPUTS followed the
        // hardware clock, anything reading the bpm param — most importantly
        // LIVECODE's clock.bpm() / clocked() period derivation — kept using
        // the internal knob value, diverging from the rack.
        //
        // Fix: when a POSITIVE measured BPM arrives (i.e. an external clock
        // is locked — the worklet only measures while externalActive), write
        // it into BOTH the `bpm` AudioParam (so the internal phase, the card,
        // and any param reader agree) AND livePatch.params.bpm (so the patch
        // store + LIVECODE's clock.bpm() getter + remote rack-mates pick it
        // up via Y.Doc sync). This mirrors the existing start_in/stop_in
        // write-back pattern in pollTransportGates(). On dropout the worklet
        // posts bpm:0; we DON'T clobber the param then — the last followed
        // tempo is the most sensible value to hold (and the internal knob
        // resumes governing the worklet phase via the worklet's own logic).
        //
        // ⚠ AND THE WRITE IS NO LONGER DESTRUCTIVE. The player's own tempo is
        // STASHED on the first take-over and given back by syncExternalFlag the
        // moment the cable leaves (externalBpmLockOnMeasure / …OnUnpatch above).
        // The locked behaviour is byte-identical to before; only the state after
        // an unpatch changed, and it changed from "the player's tempo is gone
        // with no undo marker" to "the player's tempo comes back".
        const liveNode = livePatch.nodes[nodeId];
        const storedRaw = liveNode?.params?.bpm;
        const storedBpm =
          typeof storedRaw === 'number' ? storedRaw : (bpmParam?.value ?? 120);
        const step = externalBpmLockOnMeasure(bpmLock, { measuredBpm, storedBpm });
        bpmLock = step.state;
        if (step.write !== null) writeBpm(step.write);
      }
    };

    // -------- start_in / stop_in: transport gate inputs --------
    //
    // Each input is a Gain → Analyser tap (same shape transport-cv uses
    // for play_cv / reset_cv on sequencer-style modules). A silence
    // ConstantSource keeps the node graph-alive even when no cable is
    // patched, so the analyser doesn't see ghost edges from a torn-down
    // connection. A scheduler-clock subscription drains them every tick
    // and routes rising-edge counts through transportEventsToRunState(),
    // mirroring the result back to BOTH the engine-side `running`
    // AudioParam (so the worklet sees the change immediately) AND the
    // patch store (so any UI + remote rack-mates pick up the new state
    // via Y.Doc sync). Note: these gates HALT the clock, distinct from
    // the card's MUTE button which only silences output gates.
    // Edge-detector ring buffers: at fftSize=2048 the analyser ring only
    // holds ~42 ms, so a main-thread stall longer than that (a canvas
    // pan/drag event-storm can block 80–150 ms) OVERWRITES start/stop
    // rising edges before this poll reads them ⇒ a dropped/late transport
    // edge (a missed start or stop). Widen to 16384 samples (~341 ms @
    // 48 kHz) so the ring outlasts any plausible UI stall — matching the
    // headroom the sequencer's external-clock detector already got in #229.
    // fftSize must be a power of two ≤ 32768; the scan buffer is sized off
    // it so the two never drift apart.
    const EDGE_DETECTOR_FFT_SIZE = 16384;
    const startGain = ctx.createGain();
    const startAna = ctx.createAnalyser();
    startAna.fftSize = EDGE_DETECTOR_FFT_SIZE;
    startAna.smoothingTimeConstant = 0;
    startGain.connect(startAna);
    const startSilence = ctx.createConstantSource();
    startSilence.offset.value = 0;
    startSilence.start();
    startSilence.connect(startGain);
    const startBuf = new Float32Array(startAna.fftSize);
    const startDet = createRisingEdgeDetector(0.5);

    const stopGain = ctx.createGain();
    const stopAna = ctx.createAnalyser();
    stopAna.fftSize = EDGE_DETECTOR_FFT_SIZE;
    stopAna.smoothingTimeConstant = 0;
    stopGain.connect(stopAna);
    const stopSilence = ctx.createConstantSource();
    stopSilence.offset.value = 0;
    stopSilence.start();
    stopSilence.connect(stopGain);
    const stopBuf = new Float32Array(stopAna.fftSize);
    const stopDet = createRisingEdgeDetector(0.5);

    // -------- gate: LEVEL-SENSITIVE wizard show/hide input --------
    //
    // Tap the `gate` input the same Gain → Analyser way as start/stop, but
    // read the LATEST LEVEL (not rising edges) — the port is declared
    // `edge: 'gate'` (level-sensitive). gate HIGH = wizard ON, LOW = OFF
    // (see gateLevelToWizardOn() in timelorde-wizard.ts — the one-spot place
    // to flip the semantic). When a cable is patched its level OWNS wizardOn;
    // when nothing is patched the analyser reads the silence ConstantSource
    // (level 0) so the card's manual button is left to govern (see the
    // hasWizardGate guard below). A small fftSize is plenty — we only sample
    // the most-recent value, no edge windowing. The result is mirrored to
    // BOTH the engine-side wizardOn AudioParam AND livePatch.params.wizardOn
    // so the card + remote rack-mates pick it up via Y.Doc sync, exactly like
    // the start_in/stop_in transport write-back above.
    const wizardGateGain = ctx.createGain();
    const wizardGateAna = ctx.createAnalyser();
    wizardGateAna.fftSize = 2048;
    wizardGateAna.smoothingTimeConstant = 0;
    wizardGateGain.connect(wizardGateAna);
    const wizardGateSilence = ctx.createConstantSource();
    wizardGateSilence.offset.value = 0;
    wizardGateSilence.start();
    wizardGateSilence.connect(wizardGateGain);
    const wizardGateBuf = new Float32Array(wizardGateAna.fftSize);
    const wizardOnParam = params.get('wizardOn');

    // -------- video_out: card-pushed display frame → cross-domain bridge -----
    //
    // TIMELORDE is an AUDIO module that ALSO carries a `video_out`. Audio
    // modules publish a video output via the handle's `videoSources` map; the
    // cross-domain video-texture bridge calls our `drawFrame(canvas)` each
    // VIDEO frame and uploads the result for downstream video modules (the
    // SCOPE / WAVESCULPT.video_out precedent).
    //
    // The picture is the SAME thing the card's big display shows — the live
    // video feed when video_in is patched, else the beat-pulsing wizard. Only
    // the DOM (the card) can read the upstream video frame + paint the wizard,
    // so the card computes the display each rAF and PUSHES it to us via
    // handle.write('displayFrame', ImageBitmap) (the SYNESTHESIA write() path).
    // drawFrame() blits the latest pushed bitmap; before the first push (or
    // with no DOM) it paints a dark idle frame so a downstream consumer never
    // samples an uninitialised texture.
    let lastDisplayFrame: ImageBitmap | null = null;
    function drawFrame(canvas: OffscreenCanvas | HTMLCanvasElement): void {
      const g = canvas.getContext('2d') as
        | OffscreenCanvasRenderingContext2D
        | CanvasRenderingContext2D
        | null;
      if (!g) return;
      const w = canvas.width;
      const h = canvas.height;
      if (lastDisplayFrame) {
        try {
          g.clearRect(0, 0, w, h);
          g.drawImage(lastDisplayFrame, 0, 0, w, h);
          return;
        } catch {
          // Bitmap was closed out from under us — fall through to idle.
        }
      }
      // Idle frame (no card push yet): the gate-cable accent on near-black so
      // a downstream module reads a stable, non-garbage texture.
      g.fillStyle = '#07090d';
      g.fillRect(0, 0, w, h);
    }
    // The `analyser` field is required by getVideoSource() callers even when a
    // drawFrame is supplied (the bridge ignores it then — see the
    // AudioDomainNodeHandle.videoSources docs). Tap output 0 (the 1x clock) so
    // there's a live AnalyserNode to hand over.
    const videoTapAna = ctx.createAnalyser();
    videoTapAna.fftSize = 2048;
    videoTapAna.smoothingTimeConstant = 0;
    try { workletNode.connect(videoTapAna, 0); } catch { /* offline/test ctx */ }

    let lastTransportPollTime = ctx.currentTime;
    function pollTransportGates(): void {
      const nowAt = ctx.currentTime;
      const elapsed = Math.max(0, nowAt - lastTransportPollTime);
      lastTransportPollTime = nowAt;
      startAna.getFloatTimeDomainData(startBuf);
      stopAna.getFloatTimeDomainData(stopBuf);
      const newSamples = Math.min(
        startBuf.length,
        Math.max(1, Math.ceil(elapsed * ctx.sampleRate)),
      );
      const start = startBuf.length - newSamples;
      const startEdges = startDet.scan(startBuf, start, startBuf.length);
      const stopEdges  = stopDet.scan(stopBuf,  start, stopBuf.length);
      if (startEdges === 0 && stopEdges === 0) return;

      const live = livePatch.nodes[nodeId];
      // Default running=1 if unset (matches the param's defaultValue).
      // running is NOT muteOutputs — it actually halts the worklet's
      // phase accumulator. muteOutputs stays untouched here.
      const prevRaw = live?.params?.running;
      const prevRunning: 0 | 1 =
        typeof prevRaw === 'number' ? (prevRaw >= 0.5 ? 1 : 0) : 1;
      const nextRunning = transportEventsToRunState({
        startEdges,
        stopEdges,
        prevRunning,
      });
      if (nextRunning === prevRunning) return;
      // Write through both layers: AudioParam so the worklet sees it
      // on the next process() block (phase accumulator freezes /
      // resumes); livePatch.params so any UI + remote rack-mates pick
      // up the new state via Y.Doc sync.
      runningParam?.setValueAtTime(nextRunning, ctx.currentTime);
      if (live?.params) live.params.running = nextRunning;
    }
    const transportUnsub = getSchedulerClock().subscribe(pollTransportGates);

    // -------- gate → wizardOn: level-sensitive poll --------
    //
    // Once per scheduler tick, if a cable is patched into the `gate` input,
    // sample its latest level and drive wizardOn from it (HIGH = on, LOW =
    // off). Level-sensitive, NOT edge-detected — a held-high gate keeps the
    // wizard on. When no cable is patched we leave wizardOn alone so the
    // on-card button stays in control (the analyser would otherwise read the
    // silence source = 0 and clamp the wizard off forever). Write-through to
    // both the AudioParam (cheap, keeps a single source of truth) and the
    // patch store (UI + remote rack-mates) — mirrors pollTransportGates().
    let lastWizardGateOn: boolean | null = null;
    function pollWizardGate(): void {
      let hasWizardGate = false;
      for (const edge of Object.values(livePatch.edges)) {
        if (!edge) continue;
        if (edge.target.nodeId === nodeId && edge.target.portId === 'gate') {
          hasWizardGate = true;
          break;
        }
      }
      if (!hasWizardGate) {
        // No external control — hand the wizard back to the button.
        lastWizardGateOn = null;
        return;
      }
      wizardGateAna.getFloatTimeDomainData(wizardGateBuf);
      const level = wizardGateBuf[wizardGateBuf.length - 1] ?? 0;
      const on = gateLevelToWizardOn(level);
      if (on === lastWizardGateOn) return; // no change → no write
      lastWizardGateOn = on;
      wizardOnParam?.setValueAtTime(on ? 1 : 0, ctx.currentTime);
      const live = livePatch.nodes[nodeId];
      if (live?.params) live.params.wizardOn = on ? 1 : 0;
    }
    const wizardGateUnsub = getSchedulerClock().subscribe(pollWizardGate);

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number }>([
        ['clock',    { node: workletNode,    input: 0 }],
        ['start_in', { node: startGain,      input: 0 }],
        ['stop_in',  { node: stopGain,       input: 0 }],
        ['gate',     { node: wizardGateGain, input: 0 }],
      ]),
      outputs: new Map([
        ['1x',    { node: workletNode, output: 0 }],
        ['8x',    { node: workletNode, output: 1 }],
        ['4x',    { node: workletNode, output: 2 }],
        ['2x',    { node: workletNode, output: 3 }],
        ['1/2',   { node: workletNode, output: 4 }],
        ['1/3',   { node: workletNode, output: 5 }],
        ['1/4',   { node: workletNode, output: 6 }],
        ['1/8',   { node: workletNode, output: 7 }],
        ['1/12',  { node: workletNode, output: 8 }],
        ['1/16',  { node: workletNode, output: 9 }],
        ['1/32',  { node: workletNode, output: 10 }],
        ['1/64',  { node: workletNode, output: 11 }],
        ['swing', { node: workletNode, output: 12 }],
      ]),
      // video_out (cross-domain): the card-pushed display frame, exposed as a
      // video source for the audio→video texture bridge. `drawFrame` blits the
      // latest frame; `analyser` (the 1x clock tap) satisfies the bridge's
      // contract even though it's ignored when drawFrame is present.
      videoSources: new Map([
        ['video_out', { analyser: videoTapAna, sampleRate: ctx.sampleRate, drawFrame }],
      ]),
      setParam(paramId, value) {
        // ⚠ EVERY user tempo write lands here — the knob, the faceplate cell,
        // TAP, the topbar clock surface — so this is the one seam that can see
        // "the player re-set the tempo WHILE the follower owned it" and keep the
        // stash honest. With no lock live it is a no-op (see …OnUserWrite).
        if (paramId === 'bpm') bpmLock = externalBpmLockOnUserWrite(bpmLock, value);
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      // The card pushes the current big-display picture (live feed or wizard)
      // here every rAF so video_out's drawFrame can pass it through. We adopt
      // the new ImageBitmap and close the previous one (bitmaps hold GPU/CPU
      // memory until close()). Mirrors SYNESTHESIA's video_levels_a/_b write().
      write(key, value) {
        if (key === 'displayFrame') {
          const prev = lastDisplayFrame;
          lastDisplayFrame =
            value instanceof ImageBitmap ? value : null;
          if (prev && prev !== lastDisplayFrame) {
            try { prev.close(); } catch { /* */ }
          }
        }
      },
      read(key) {
        if (key === 'hasExternalClock') {
          return hasExt?.value ?? 0;
        }
        if (key === 'measuredBpm') {
          return measuredBpm;
        }
        if (key === 'hasDisplayFrame') {
          // ⚠ THIS EXISTS TO MAKE THE CARD'S PUSH CONVERGENT RATHER THAN
          // FIRE-AND-FORGET, and it closes a measured defect.
          //
          // `write(node,'displayFrame', …)` is the ONLY thing that ever fills
          // `lastDisplayFrame`, and under `prefers-reduced-motion: reduce` the
          // card paints exactly ONE frame and pushes exactly ONCE. A push that
          // lands before this handle exists — or on a handle that is then
          // replaced — is therefore lost FOREVER, and `drawFrame` falls back to
          // the #07090d idle field for the rest of the session. MEASURED on a
          // default rack, `emulateMedia({reducedMotion:'reduce'})`, card mounted
          // and its own canvas carrying the owl at `nonBlack 47034/48400`:
          // `video_out` read `nonBlack 0/3072, maxLuma 9`. Every reduced-motion
          // player's TIMELORDE was a black square downstream. Nudging the card
          // into one more render restored it to `2940/3072` immediately, which
          // is what identified the push rather than the render as the loss.
          //
          // With this key the card can ASK whether its frame arrived and push
          // again if it did not — so a lost write self-heals, and a replaced
          // handle (which reports false again) does too. Cheap by construction:
          // a boolean, no allocation, no copy.
          return lastDisplayFrame ? 1 : 0;
        }
        if (key === 'running') {
          // Reflects the transport-gate state. start_in/stop_in flip
          // this; muteOutputs is independent (the card's mute doesn't
          // halt the clock).
          const v = runningParam?.value ?? 1;
          return v >= 0.5 ? 1 : 0;
        }
        if (key === 'transportState') {
          // The named state — the ONLY place the four transport states are
          // separable. MEASURED on the clock core: `running = 0`,
          // `muteOutputs = 1` and both together are byte-identical on all 13
          // gate outputs, so nothing downstream of a cable can tell them
          // apart. Derived from the LIVE param values through the same pure
          // function the card renders, so the readout and the engine can never
          // disagree about which state the rack is in.
          return timelordeTransportState({
            running: runningParam?.value,
            muteOutputs: muteOutputsParam?.value,
          }).id;
        }
        return undefined;
      },
      dispose() {
        if (timer !== null) clearInterval(timer);
        try { transportUnsub(); } catch { /* */ }
        try { wizardGateUnsub(); } catch { /* */ }
        try { silence.stop(); } catch { /* */ }
        try { startSilence.stop(); } catch { /* */ }
        try { stopSilence.stop(); } catch { /* */ }
        try { wizardGateSilence.stop(); } catch { /* */ }
        silence.disconnect();
        startSilence.disconnect();
        stopSilence.disconnect();
        wizardGateSilence.disconnect();
        startGain.disconnect();
        stopGain.disconnect();
        wizardGateGain.disconnect();
        startAna.disconnect();
        stopAna.disconnect();
        wizardGateAna.disconnect();
        try { videoTapAna.disconnect(); } catch { /* */ }
        if (lastDisplayFrame) {
          try { lastDisplayFrame.close(); } catch { /* */ }
          lastDisplayFrame = null;
        }
        workletNode.disconnect();
      },
    };
  },
};

/**
 * The twelve divisions `swingSource` selects between, as an `options` ROSTER —
 * DERIVED from this def's own output fanout, never typed.
 *
 * ⚠ WHY DERIVED. `swingSource` shipped as a 12-state discrete param with NO
 * roster, so a faceplate over it paints an anonymous dial reading `5` for a
 * state the module already has a name for. The names existed — as a CARD-LOCAL
 * array (`TimelordeCard.svelte`'s `SRC_LABELS`) duplicating this very list,
 * which is the `sampleHold` / `moog904b` shape and the backdraft one-source
 * rule applied to a list instead of a range. Re-typing them here would have
 * MOVED the duplicate rather than removed it, and it would have been a
 * hand-typed population count in disguise: the outputs' own comment says the
 * order MUST match the DSP's `OUT_*` indices, so the twelfth entry is not a
 * fact anyone may re-state.
 *
 * ⚠ WHY IT IS ATTACHED HERE RATHER THAN WRITTEN INSIDE THE PARAM. A def cannot
 * reference itself while it is being constructed, and hoisting `outputs` to a
 * named const so it could is what the outputs' own comment now forbids: the
 * living-docs manifest parses this file as TEXT and emitted ZERO outputs for
 * timelorde when the literal moved. So the roster is computed from the finished
 * def and written onto the param it belongs to. `param-vocabulary`,
 * `contract-lock` and `paramCellKind` all read the LIVE def, so they see it.
 *
 * TOTAL over the declared 0..11 by construction (thirteen gate outputs minus
 * `swing` itself, which cannot shadow itself) — which is what `param-vocabulary`
 * requires of any roster.
 */
export const TIMELORDE_SWING_SOURCES: readonly { value: number; label: string }[] =
  timelordeDef.outputs
    .filter((o) => o.type === 'gate' && o.id !== 'swing')
    .map((o, i) => ({ value: i, label: o.id }));

{
  const swingSourceParam = timelordeDef.params.find((p) => p.id === 'swingSource');
  if (!swingSourceParam) {
    // Fail LOUDLY rather than silently shipping an unnamed twelve-position dial:
    // a rename here is exactly the drift this roster exists to prevent.
    throw new Error('timelorde: swingSource param not found — the derived roster has nothing to attach to');
  }
  swingSourceParam.options = TIMELORDE_SWING_SOURCES;
}
