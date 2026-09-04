// packages/web/src/lib/audio/modules/clipplayer.ts
//
// CLIP PLAYER (v2) — an Ableton-Session-style clip launcher with 8 INSTRUMENT
// LANES. Rows = instruments (8), columns = clip slots (8) → 64 note clips. Each
// lane independently plays its launched clip out its OWN pitch/gate/velocity
// outputs, so up to 8 clips sound at once (one per instrument). A monome grid
// drives it (lib/control/monome) and the card is the always-available editor + launcher.
//
// Clock: LOCKED TO TIMELORDE (the rack transport). The module runs only while
// TIMELORDE.running, at TIMELORDE.bpm, and freezes when it stops — no internal
// BPM, no clock-input cable. A STEP-division param sets steps-per-beat. (See
// the plan doc §10 + clip-types.ts.)
//
// Inputs:  stop_all (trigger) — rising edge stops every lane.
//          reset    (trigger) — rising edge snaps every ACTIVE lane to step 1.
// Outputs: pitch1..8 (polyPitchGate) / gate1..8 / vel1..8 — one set per lane.
// Params:  stepDiv (1/4..1/32), octave, gateLength, quantize (launch snap),
//          snh, and the clip-view DISPLAY-only pair restrictRange + rangeFloor
//          (piano-roll pitch window; never touches playback/CV).
// Per-lane clock RATE (1/8..4x, card dropdown → data.rate) scales each lane's
// step duration off the global STEP grid — see clip-clock.ts for the model +
// phase rule (common origin at transport start / RESET).

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import type { ModuleNode } from '$lib/graph/types';
import { patch as livePatch, ydoc } from '$lib/graph/store';
import { getActiveEngine } from '$lib/audio/engine-ref';
import { resolveSurfaceParam } from '$lib/graph/control-surface-params';
import { valueToFrac, fracToValue } from '$lib/electra/curve';
import { AutomationController, type AutoTrackUpdate } from './clip-automation-controller';
import {
  registerAutomationController,
  unregisterAutomationController,
} from '$lib/audio/automation-touch';
import { SEAM_GLIDE_S, quantizeStopStep, type RampPoint } from './clip-automation-engine';
import { createPolySender, POLY_CHANNEL_PAIRS } from '$lib/audio/poly';
import { createVoiceAllocator, type VoiceAllocator } from '$lib/audio/poly-alloc';
import { getSchedulerClock } from '$lib/audio/scheduler-clock';
import { createEdgeCounter } from '$lib/audio/edge-detect';
import { midiToVOct } from '$lib/audio/note-entry';
import { isInputPortConnected } from './transport-helpers';
import { getClipAudioBuffer, clipAudioCacheKey } from '$lib/audio/clip-audio-cache';
import { clipLaneNormalConnected } from '$lib/audio/clip-lane-return';
import { setLanePlayhead, clearPlayheads } from './clip-playhead';
import { setLanePhase, clearLanePhases } from './clip-lane-phase';
import { drainReconcile, clearReconcile } from './clip-reconcile';
import {
  setAutomationRender,
  clearAutomationRender,
  type AutomationLaneRender,
} from './clip-automation-render';
import { drainAudition, clearAudition } from './clip-audition';
import { applyPitchProbability } from '$lib/audio/pitch-probability';
import {
  readClip,
  clipLengthSteps,
  notesFiringAt,
  lanesFromFiring,
  assignPolyLanes,
  createPolyLaneBook,
  freePolyLanesAt,
  resetPolyLaneBook,
  type PolyLaneBook,
  type NoteEvent,
  DEFAULT_VELOCITY,
  clipIndex,
  CLIP_LANES,
  CLIP_COUNT,
  laneMuted,
  laneSwing,
  swingStepOffset,
  readNoteRec,
  isLaneAutomationRecorder,
  laneAutomationArmed,
  migrateAutomationLanesShape,
  migrateClipPlayerData,
  coerceClipRecord,
  coerceAutoClipRecord,
  autoTrackViews,
  automationTargetKey,
  laneAssignedModules,
  coerceAutoAssign,
  autoPlaybackOwners,
  MAX_AUTOMATION_TRACKS,
  type AudioClipRecord,
  type ClipPlayerData,
  type ClipRecord,
  type AutoTrack,
  type AutoClipRecord,
  type AutomationTarget,
  type AutomationTrack,
} from './clip-types';
import { clipDivIndex, laneStepDur, RATE_DEFAULT_INDEX } from './clip-clock';
import { nextLaunchBoundary, referenceClocks, type PlayingLaneClock } from './clip-launch-quantize';
import {
  readSceneLaunch,
  anchorSceneRepeatTrack,
  sceneRepeatsDone,
  sceneRepeatDeviates,
  drainScenePrevSlots,
  sceneAllLanesStopped,
  sceneRepeatShouldAdvance,
  sceneRepeatCount,
  nextContentScene,
  applySceneLaunchWrite,
  type SceneRepeatTrack,
} from './clip-scene-repeats';
import {
  coerceArrangeData,
  recordEvent,
  clearArrange,
  eventsInRange,
  arrangeLengthBeats,
  type ArrangeEvent,
  type ArrangeSlot,
  type ClipPlayMode,
} from './clip-arrange';
import {
  ensureSongContainers,
  mergeSongNotes,
  MAX_SONG_NOTE_EVENTS,
  coerceSongRecState,
  songNoteChannel,
  songNotesInRange,
  songLengthBeats,
  songNoteCount,
  songHasContent,
  songArmed,
  songRecMode,
  isSongRecorder,
  type SongData,
  type SongNoteEvent,
} from './clip-song';

/** steps-per-beat for each stepDiv index (0=1/4 … 3=1/32). */
const STEP_DIV_SPB = [1, 2, 4, 8] as const;

/** Transaction ORIGIN for automation record commits — deliberately NOT the
 *  undo-tracked LOCAL_ORIGIN (see the commit dep's rationale: per-wrap undo
 *  flooding). Exported for tests that assert commits stay out of the undo scope. */
export const AUTOMATION_COMMIT_ORIGIN = Symbol('automation-commit');

/** Transaction ORIGIN for SONG print commits — like AUTOMATION_COMMIT_ORIGIN,
 *  deliberately NOT the undo-tracked LOCAL_ORIGIN (the per-bar print commits
 *  would flood the undo stack). A bad take is cleared by re-recording (REPLACE)
 *  or an explicit clear affordance. */
export const SONG_COMMIT_ORIGIN = Symbol('song-commit');

/** How often (in song-beats) the SONG print buffer commits to the Y.Doc during
 *  a take — once per bar, never per step/tick ([[cv-modulation-live-store-write-storm]]). */
const SONG_COMMIT_BEATS = 4;

/** Fall→rise gap (s) when an audition voice-lane changes owner (LRU-steal, or a
 *  freed lane re-taken in the same drain). Two clean setValueAtTime edges — a
 *  brief gate dip so the downstream envelope RE-ATTACKS at the new pitch, never a
 *  silent pitch swap under a held gate (gate/held-note plan §3.2 invariant). */
const AUDITION_STEAL_GAP_S = 0.003;

export const clipplayerDef: AudioModuleDef = {
  type: 'clipplayer',
  palette: { top: 'Audio modules', sub: 'sequencers' },
  domain: 'audio',
  label: 'clip player',
  category: 'modulation',
  // 8×8 clip grid (capped) + piano-roll note editor + transport — fits a 3u tile.
  size: '3u',
  hp: 2,

  inputs: [
    // Both are TRIGGERS (declared, per CLAUDE.md): fire ONCE per rising edge,
    // detected through the shared windowed edge counter ($lib/audio/edge-detect).
    { id: 'stop_all', type: 'gate', edge: 'trigger' },
    { id: 'reset', type: 'gate', edge: 'trigger' },
  ],
  outputs: [
    ...Array.from({ length: CLIP_LANES }, (_, i) => [
      { id: `pitch${i + 1}`, type: 'polyPitchGate' as const },
      // GATE, not trigger: the emitter's low edge is the NOTE/TIE span
      // (clipplayer.ts:1416-1417 `gateOff`), not a fixed pulse — a tied note
      // stays high across it.
      { id: `gate${i + 1}`, type: 'gate' as const, edge: 'gate' as const },
      { id: `vel${i + 1}`, type: 'cv' as const },
    ]).flat(),
    // AUDIO CLIP playback, one stereo pair PER LANE (owner Q8: per-lane, not a
    // sum — the lane↔channel identity is the product concept, and a take must
    // be able to return to its own mixmstrs channel). These same legs feed the
    // internal NORMAL into mixmstrs channel N (clip-lane-return.ts), which a
    // cable into that channel's input jack breaks — the jacks here keep
    // working either way, so tape-return patches are untouched.
    ...Array.from({ length: CLIP_LANES }, (_, i) => [
      { id: `audio${i + 1}L`, type: 'audio' as const },
      { id: `audio${i + 1}R`, type: 'audio' as const },
    ]).flat(),
  ],
  params: [
    // stepDiv: 0=1/4, 1=1/8, 2=1/16 (default), 3=1/32 — steps per TIMELORDE beat.
    { id: 'stepDiv', label: 'Step', defaultValue: 2, min: 0, max: 3, curve: 'discrete' },
    { id: 'octave', label: 'Oct', defaultValue: 0, min: -2, max: 2, curve: 'discrete' },
    { id: 'gateLength', label: 'Gate', defaultValue: 0.9, min: 0.1, max: 1, curve: 'linear' },
    // 0 = launch immediately, 1 = quantize to the lane's clip-loop boundary.
    { id: 'quantize', label: 'Qnt', defaultValue: 1, min: 0, max: 1, curve: 'discrete' },
    // Gate-sampled Sample & Hold on every lane's pitch CV (ONE global toggle
    // for all 8 lanes — this replaces the 8 external S&H modules). ON
    // (default): on an EMPTY step (a rest) the per-voice gate still closes but
    // pitch HOLDS its last value, so each lane's pitch CV latches to the gate
    // edge instead of resetting to 0/C4 on every rest. OFF: rests rewrite
    // pitch=0 (the legacy continuous behavior). Default-ON changes existing
    // patches by design.
    { id: 'snh', label: 's&h', defaultValue: 1, min: 0, max: 1, curve: 'discrete' },
    // CLIP-VIEW (note editor) DISPLAY ONLY — these two do NOT touch playback,
    // pitch, or the emitted CV; they only change how many pitch rows the
    // piano-roll draws. restrictRange OFF (default) = the full editable range
    // (byte-identical to before this feature). ON = a THREE-octave window whose
    // LOWEST octave is rangeFloor's C, clamped inside the editable range.
    //
    // ⚠ "THREE", NOT "FOUR", AND THE NUMBER WAS WRONG IN SEVEN PLACES.
    // `restrictedRowWindow(root, scale, floor, octaves = 3)` is the shipped law
    // and `ClipplayerCard.svelte` passes `RESTRICT_OCTAVES = 3`, so the window
    // has always been three octaves tall. Two doc blobs below and four card
    // comments said four. Nothing caught it because every one of them is PROSE:
    // the only surfaces that state the number to a player are the tooltips, and
    // those INTERPOLATE the constant, so they were right the whole time.
    { id: 'restrictRange', label: 'RngLim', defaultValue: 0, min: 0, max: 1, curve: 'discrete' },
    { id: 'rangeFloor', label: 'RngFlr', defaultValue: 3, min: 0, max: 8, curve: 'discrete' },
  ],

  exposesSequence: true,

  docs: {
    explanation:
      "A clip launcher in the style of Ableton's Session view, with 8 instrument lanes. The grid's rows are the 8 lanes (instruments) and the columns are clip slots — the card shows 8 slots per lane at a time (64 clips at a glance), while on a Launchpad the scene column scrolls through up to 64 scene slots per lane (fixed stride-64 storage; older saves migrate once on load), so clips can live in scenes past the first 8. Each lane independently plays whichever clip you launch out its OWN pitch/gate/velocity outputs, so up to 8 clips can sound at once (one per lane). Click a pad to launch its clip, double-click to open the piano-roll editor and draw notes into it. Each note carries three per-note performance controls. Two of them decide WHETHER the note fires, and they STACK: a PROBABILITY (a firing chance) and a PLAY EVERY (a 1–8 count-divider — the note plays only on every Nth loop of its clip), so a note fires only when it's that loop's turn AND wins its probability roll; both are set from the card's right-click menu (the NOTE PROBABILITY and SKIP EVERY submenus) — on a NOTE CELL they set that one note, on a LAUNCH-GRID CLIP PAD they set the whole clip or, on a Launchpad, SHIFT+tap (probability) and SHIFT+double-tap (play-every, an 8-pad red top-row picker). The third decides WHAT PITCH it fires at: PITCH PROBABILITY, a single \"pitch instability\" amount from off to 100% in the same 40 increments (card note right-click for now — hardware surfaces are a follow-up). At OFF, which is the default, the note plays exactly the pitch you drew, always. Turning it up progressively loosens the note's identity rather than adding random noise: first occasional ornaments a scale degree away, then frequent but local melodic variation, then wider reharmonisation, and only near the top do out-of-key notes arrive in force. It draws from a weighted spread of candidate pitches measured in SCALE DEGREES of the clip's own key — so a step from E in C major is D or F, not D♯ — with big leaps exponentially rarer than small ones, extra weight on the OCTAVE (and the fifth) so a large move still sounds like the same musical idea, and out-of-key notes fading in gradually instead of switching on. The clip's key governs where a note may wander TO, never the note you actually wrote: a deliberate out-of-key note keeps its own pitch and its own octaves at full weight. A note re-draws its pitch on every pass of the clip rather than freezing into a transposition, and the notes of a chord move independently. The play-every gate and the pitch draw are both DETERMINISTIC from the shared loop count, so collaborators hear the same melody; the firing-probability roll is currently rolled per-peer, so on a probabilistic note different collaborators may hear different notes drop out. Notes colour-code the first two: white always fires, a dimmer purple/orange as probability drops, red (dimmer the higher N) for a play-every note, and a blend of the two for a note that is both — pitch probability instead marks the cell with a DASHED border (a shape, not a third colour, so it stays readable on top of the other two), with the exact amount in the cell's tooltip and the menu's checkmark. There's no internal clock or BPM — CLIP PLAYER is locked to TIMELORDE (the rack transport): it runs at TIMELORDE's tempo, only while TIMELORDE is running, and the STEP control sets how many steps fall per beat. Each lane also has its own clock-rate control (1/8 · 1/4 · 1/2 · 1 · 2x · 4x — the card dropdown, and the Launchpad deck's per-lane RATE row) that divides or multiplies that lane's step rate off the global STEP grid — polyrhythms without leaving the card — and because the tempo comes from TIMELORDE, 2x/4x are exact from the first step. All lanes share a common phase origin (transport start or the RST button), so a 1/2 lane lands on even base steps and stays locked to the others; RST (also a MIDI-assignable button, and the reset input) snaps every active lane back to step 1 and re-anchors that shared origin. Launches can fire immediately or be quantized to snap cleanly at the next loop boundary of the LONGEST currently-playing clip — the shared reference bar (the Deluge model), so mixed-length clips stay phase-locked and short clips don't flip early; a launch fires immediately only when nothing is playing yet (there's no reference loop to line up to) or via a per-lane NOW. It also has a SONG / arrangement mode that records your launches onto a timeline for non-real-time playback, and pairs with a monome grid 128 or a one- or two-unit Novation Launchpad Mini Mk3 for hardware launching. On the Launchpad the scene-launch column is a scrolling window (its shift-layer amber UP/DOWN buttons slide it), and a typed clipboard lets you COPY/PASTE whole SCENES (all 8 lanes at one slot, full-replace) as well as single clips — scene→scene and clip→clip pastes apply, while scene→clip and clip→scene are ignored (their targets dim). SCENE REPEATS (Deluge-style, Launchpad-set): by default a launched scene loops forever (repeats = infinite), but each scene can carry a repeat count 1–63 — after that many passes of the scene's LONGEST clip (its length × rate/div, frozen at launch so mid-count edits never move the scheduled boundaries) the player AUTO-LAUNCHES the next scene DOWN that has content, skipping empty rows, through the normal quantized launch path (arranger-record captures it, LEDs update, peers stay in sync); after the last content scene it keeps looping it. Setting the count is a two-hands Launchpad gesture: HOLD the GRID button + HOLD a scene-launch button → the 8×8 becomes the orange REPEAT-COUNT view (pads 1..N lit row-major from the upper-left; all 64 lit = infinite) — tap pad k to set k repeats, pad 64 for infinite; release either button to return to the grid. The buttons are position-relative through the scene scroll, so a scrolled window edits the correct scene. Counts are content: a whole-scene COPY/PASTE carries the repeat count with the scene (a full-replace paste sets the target's count from the copied scene, clearing it when the source had none). Manual always wins: launching another scene (or re-launching the same one) resets the count fresh, launching an individual clip outside the scene cancels the countdown until the next scene launch, and stopping every scene lane cancels it too — while MUTING lanes never voids or alters the count. Each scene row carries a repeat control — \"∞\" until a count is set, then \"×N\", and live progress \"p/N\" while that scene is counting. CLICKING it cycles the count (∞ → 2 → 3 → 4 → 8 → ∞) on both the card and the faceplate, so the two-hands Launchpad gesture is not the only way to set one. PER-CLIP AUTOMATION records parameter moves into the PLAYING clip by CONTINUOUS OVERDUB — Deluge-like: assign modules, launch a clip, arm the lane, twist, and it just keeps overdubbing. Assignment is MODULE-level: right-click a MODULE'S CARD → \"Assign to automation lane\" → pick lane 1–8 (one lane per module; re-assigning moves it). The assigned module's whole card gets a thin border in that lane's colour, and the AUTO block shows a per-lane assigned-module count. The ARM is PER LANE — the small teal ◉ under each channel column (next to its RATE control), distinct from the experimental red ● arranger record (which records clip LAUNCHES, not knob moves): launch a note clip in the lane, arm THAT lane's ◉, and just MOVE any control on an assigned module — the lane's recorder punches in cleanly at ITS playing clip's own next loop start and overdubs EVERY loop until you press its ◉ again (a manual stop — no auto punch-out); several lanes can record at once, each on its own loop, and different collaborators can record different lanes simultaneously (each lane is single-writer). Automation records your HANDS — screen drags, MIDI CC, Electra — never CV: a CV cable modulating a param is performance signal, not recorded automation (recording reads the modulation-free knob value, and CV never counts as a touch). Touching a control on an UNASSIGNED module while armed records nothing — assign the module first. Each clip's automation caps at 16 recorded controls (a MAX badge flashes when a touch would exceed it). Longer-form automation across a whole song is the (future) arranger mode's job — clip automation is always clip-length. DUPLICATING a clip player copies its content (clips, recorded automation, per-channel settings, the arrangement) but never its LIVE state: the copy is born stopped, disarmed and UNASSIGNED (one lane per module is a global claim — it stays with the original). Each loop, only the params you're actively MOVING are (re)recorded; every other track keeps PLAYING BACK, and a released control reverts to playback next loop; stopping mid-loop keeps the untouched tail. A 🟡🟡🔴🔴 countdown flashes each recording clip's pad (and its lane's ◉ arm) on the last four beats before that clip's own wrap. EVERY clip in the lane carries its OWN automation — THE ENVELOPE BELONGS TO THE CLIP: it's stored beside the notes (editing notes never touches the recorded envelopes), COPY/PASTE and scene-duplicate carry it with the clip (PASTE-REV pastes it time-reversed to match the reversed notes), pasting over a clip replaces its automation, and clearing/emptying a clip clears its automation too. Clips that carry automation show a small teal dot on their grid cell. Launching a clip launches its envelopes with it, looping at the clip's length; if two playing clips in different lanes automate the SAME control, exactly ONE drives it (its module's assigned lane wins, else the lowest lane — no fighting). Deleting is explicit and undoable: right-click an automated control → \"Clear recorded automation\" wipes that control's envelopes (its module's lane's clips, or everywhere when unassigned) — distinct from the module card's \"Remove automation assignment\", which only stops FUTURE recording and leaves recorded envelopes playing — and the editor's CLR AUTO button wipes the open clip's whole automation while keeping its notes. On playback it drives those params transiently on every peer (never rewriting the saved clip). Parameter moves never JUMP: when a lane stops or switches away from an automating clip the params HOLD their last automated value — recomputed from the clip data at the stop position, quantized to the step grid so collaborating peers converge on the same resting value (never a snap to zero/default) — and every unavoidable seam (the loop wrap, switching INTO an automating clip, and a quantized switch AWAY, which holds at the musical boundary rather than cutting early) is a short click-free glide rather than a hard step. Grabbing an automated control live SUSPENDS its automation (live wins) until you physically RELEASE it — a gesture that spans a loop wrap is never yanked back to the envelope mid-drag, a wrap commit only overwrites the part of the loop the gesture actually covered, and a param gripped by two surfaces at once (screen + MIDI) stays live until the last one lets go; on release the param glides back to playback (the on-card dot re-enables all at once). Two current limits are documented honestly: the on-card grid shows only the first 8 scenes (card scene-scroll is a follow-up), and the arranger records session launches of scenes 1–8 (recording launches of scene 9+ is a follow-up — session launching them already works). Drive its lanes into eight voices for a full multitrack clip-based performance instrument.",
    inputs: {
      stop_all: "Stop-all trigger: a rising edge immediately stops every lane (a panic/stop button), in both session and arrangement modes.",
      reset: "Reset trigger: a rising edge snaps every ACTIVE lane back to step 1 and re-anchors all lanes to a shared phase origin (divided/multiplied lanes restart their counting together). Queued-but-not-started launches are untouched — they still drop in at the next loop boundary of the longest playing clip. Stopped lanes stay stopped; the arrangement's song position is not rewound (this is a clip-step reset, not a transport rewind).",
    },
    outputs: {
      pitch1: "Lane 1's pitch output — the launched clip's notes as a poly chord cable (a mono pitch input receives just the root; a poly voice plays the whole chord), shifted by the OCT control.",
      pitch2: "Lane 2's pitch output (poly chord cable), from lane 2's launched clip.",
      pitch3: "Lane 3's pitch output (poly chord cable), from lane 3's launched clip.",
      pitch4: "Lane 4's pitch output (poly chord cable), from lane 4's launched clip.",
      pitch5: "Lane 5's pitch output (poly chord cable), from lane 5's launched clip.",
      pitch6: "Lane 6's pitch output (poly chord cable), from lane 6's launched clip.",
      pitch7: "Lane 7's pitch output (poly chord cable), from lane 7's launched clip.",
      pitch8: "Lane 8's pitch output (poly chord cable), from lane 8's launched clip.",
      gate1: "Lane 1's gate — goes high while a note in lane 1's clip plays (its width set by GATE; tied/held notes stay high across their span); low on rests. Patch into an envelope/VCA.",
      gate2: "Lane 2's gate — high while lane 2's notes play, low on rests.",
      gate3: "Lane 3's gate — high while lane 3's notes play, low on rests.",
      gate4: "Lane 4's gate — high while lane 4's notes play, low on rests.",
      gate5: "Lane 5's gate — high while lane 5's notes play, low on rests.",
      gate6: "Lane 6's gate — high while lane 6's notes play, low on rests.",
      gate7: "Lane 7's gate — high while lane 7's notes play, low on rests.",
      gate8: "Lane 8's gate — high while lane 8's notes play, low on rests.",
      vel1: "Lane 1's velocity CV — each note's velocity as a control voltage, for velocity-sensitive patching (e.g. into a VCA or filter depth).",
      vel2: "Lane 2's velocity CV.",
      vel3: "Lane 3's velocity CV.",
      vel4: "Lane 4's velocity CV.",
      vel5: "Lane 5's velocity CV.",
      vel6: "Lane 6's velocity CV.",
      vel7: "Lane 7's velocity CV.",
      vel8: "Lane 8's velocity CV.",
      audio1L: "Lane 1's recorded-audio-clip output, LEFT leg. When lane 1 plays an AUDIO clip (a take recorded from MIXMSTRS channel 1 — the channel number and the lane number are the same number everywhere in this product), the take loops out this stereo pair, launched and stopped on the same quantized boundaries a note clip uses. This SAME signal is internally NORMALLED into MIXMSTRS channel 1's input — an internal connection that breaks the moment a cable is patched into that channel's input jack — and this jack keeps working either way, so you can also patch the loop anywhere else. Silent while the lane is stopped, muted, or playing a note clip.",
      audio1R: "Lane 1's recorded-audio-clip output, RIGHT leg (see audio1L).",
      audio2L: "Lane 2's recorded-audio-clip output, LEFT leg — lane 2's launched audio take, looped; normalled into MIXMSTRS channel 2 (see audio1L).",
      audio2R: "Lane 2's recorded-audio-clip output, RIGHT leg (see audio1L).",
      audio3L: "Lane 3's recorded-audio-clip output, LEFT leg — lane 3's launched audio take, looped; normalled into MIXMSTRS channel 3 (see audio1L).",
      audio3R: "Lane 3's recorded-audio-clip output, RIGHT leg (see audio1L).",
      audio4L: "Lane 4's recorded-audio-clip output, LEFT leg — lane 4's launched audio take, looped; normalled into MIXMSTRS channel 4 (see audio1L).",
      audio4R: "Lane 4's recorded-audio-clip output, RIGHT leg (see audio1L).",
      audio5L: "Lane 5's recorded-audio-clip output, LEFT leg — lane 5's launched audio take, looped; normalled into MIXMSTRS channel 5 (see audio1L).",
      audio5R: "Lane 5's recorded-audio-clip output, RIGHT leg (see audio1L).",
      audio6L: "Lane 6's recorded-audio-clip output, LEFT leg — lane 6's launched audio take, looped; normalled into MIXMSTRS channel 6 (see audio1L).",
      audio6R: "Lane 6's recorded-audio-clip output, RIGHT leg (see audio1L).",
      audio7L: "Lane 7's recorded-audio-clip output, LEFT leg — lane 7's launched audio take, looped; normalled into MIXMSTRS channel 7 (see audio1L).",
      audio7R: "Lane 7's recorded-audio-clip output, RIGHT leg (see audio1L).",
      audio8L: "Lane 8's recorded-audio-clip output, LEFT leg — lane 8's launched audio take, looped; normalled into MIXMSTRS channel 8 (see audio1L).",
      audio8R: "Lane 8's recorded-audio-clip output, RIGHT leg (see audio1L).",
    },
    controls: {
      stepDiv: "STEP — how many steps fall per TIMELORDE beat (1/4, 1/8, 1/16, 1/32), i.e. the playback resolution of the clips.",
      octave: "OCT — transposes every lane's pitch output up or down by whole octaves (-2..+2).",
      gateLength: "GATE — how much of each step the per-note gate stays high, from short staccato stabs to near-legato (held/tied notes ignore this and stay high across their full span).",
      quantize: "QNT — launch quantization: on, a clip you launch waits and drops in cleanly at the next loop boundary of the LONGEST currently-playing clip (the shared reference bar — the Deluge model), so mixed-length clips stay phase-locked; off, it launches immediately. A launch fires immediately only when NOTHING is playing yet (there is no reference loop to line up to) or with a per-lane NOW override — a launch into an idle lane is otherwise queued to that reference boundary, not fired at once.",
      snh: "S&H — one global sample-and-hold toggle for all 8 lanes' pitch outputs: on (default), on a rest the gate closes but each lane's pitch HOLDS its last note (latched to the gate edge); off, rests reset pitch to 0 (the legacy continuous behavior).",
      restrictRange: "RESTRICT RANGE (clip-view display only) — off (default) the piano-roll note editor shows the WHOLE editable pitch range at once; on, it shows a compact 3-octave window (its lowest octave set by the FLOOR control) so a tall grid stays scannable. Affects the editor view ONLY — never the played notes, pitch CV, or anything a clip emits.",
      rangeFloor: "RANGE FLOOR (clip-view display only) — the LOWEST octave shown when RESTRICT RANGE is on: the 3-octave editor window runs from this octave's C upward, clamped so it never scrolls past the editable range's top or bottom. Display only; does not transpose or gate anything.",
      "clipplayer-mono-{n}":
        "Lane {n}'s mono/poly toggle — switches that lane between MONO (one note per column, replace-on-add) and POLY (a chord: multiple notes stacked in one column, played out the lane's poly pitch output up to the poly cable's voice width).",
      "clipplayer-rate-{n}":
        "Lane {n}'s clock-rate control (the per-lane dropdown under each channel column) — divides or multiplies the lane's step rate off the global STEP grid: 1/8, 1/4 and 1/2 advance the lane every 8th/4th/2nd base step; 2x and 4x advance it 2×/4× per base step (exact, since the tempo comes from TIMELORDE); 1 (the default) runs on the STEP grid. All lanes count from a shared phase origin (transport start or RST), so divided lanes stay locked to the others. Exposed on the card AND the Launchpad deck's per-lane RATE row (tap to cycle up); the monome grid has no rate surface.",
      "clipplayer-pad-{n}":
        "A clip slot in the launch grid (one cell of the 8 lanes × 8 slots). Click to launch that lane's clip (with QNT on it quantizes to the longest playing clip's next loop boundary; immediately when nothing's playing yet or via NOW), click the playing pad to stop the lane, and double-click to open the clip in the piano-roll editor. RIGHT-CLICK a pad for the CLIP menu — the SAME menu, with the same rows in the same order, that a note cell opens, only scoped to the whole clip: NOTE PROBABILITY (the clip DEFAULT every note without its own inherits), PITCH PROBABILITY and SKIP EVERY (both applied to EVERY note in the clip), then COPY, PASTE and CLEAR. It opens on EVERY pad, loaded or empty: on an empty slot only PASTE is live, which is how a copied clip is duplicated onto a free pad, exactly as on a Launchpad or Push 2. An empty pad shows differently from a filled or playing one; a clip that CARRIES RECORDED AUTOMATION shows a small teal dot in its corner (the envelope belongs to the clip — copy/paste moves it with the clip).",
      "clipplayer-cell-{n}":
        "A note cell in the piano-roll editor (rows are scale degrees/pitches, columns are steps). Click to toggle a note on or off at that pitch and step; right-click a note for its menu. The menu's top level is three SUBMENUS that expand into their option lists — NOTE PROBABILITY (a 0–100% firing chance), PITCH PROBABILITY (an off–100% pitch-instability amount in 40 increments) and SKIP EVERY (a 1–8 count-divider that plays the note only on every Nth loop of the clip) — followed by three actions on the CLIP you are editing: COPY and PASTE, which use the same typed clipboard as the Launchpad and Push 2 (so a clip copied on the card pastes on the hardware and vice versa; a paste replaces the target's notes AND its recorded automation, and a whole-SCENE buffer will not paste onto a single clip), and CLEAR, which DELETES the clip — the same undoable operation as the launch grid's right-click CLEAR, and distinct from the editor's ⌫, which empties the notes but keeps the clip. The first two STACK and decide WHETHER the note fires: it sounds only when it's that loop's turn AND it wins its probability roll. The third decides WHAT PITCH it fires at — off (the default) plays exactly the note you drew, and turning it up lets the note wander to nearby SCALE DEGREES of the clip's key, from occasional ornaments through melodic variation to out-of-key reharmonisation at the top, with octaves favoured over equally-distant dissonances. The cell colour codes the first two — white = always fires, a dimmer purple/orange as probability drops, RED (dimmer the higher N) for a play-every note, and the AVERAGE of the two when a note is both probabilistic and play-every. Pitch probability deliberately does NOT add a third colour to that blend (it would be unreadable at cell size): a note whose pitch can wander gets a DASHED border instead, and its exact amount is in the cell's tooltip and the menu's checkmark. The cells make up the clip you're editing for the selected lane+slot.",
      "clipplayer-auto-arm-{n}":
        "Lane {n}'s ◉ automation arm (CLIP RECORD, CONTINUOUS OVERDUB) — the small teal button under channel {n}'s column, next to its RATE control; PER LANE, Deluge-like (this replaced the old single global AUTO button), and distinct from the experimental red ● arranger record. While lane {n} is armed and a note clip plays in it, the recorder punches in cleanly at THAT clip's own next loop start; then just MOVE any control of a MODULE assigned to lane {n} (screen / MIDI / Electra all count — CV never records): it records WHILE you hold it, and every OTHER track keeps playing back so the automation loops audibly/visibly. Recording lands in the clip PLAYING in the lane (each clip carries its own envelopes). Release a control and it reverts to playback next loop. It overdubs EVERY loop until you click the ◉ again — a MANUAL STOP (no auto punch-out); stopping mid-loop keeps the untouched tail. Touching a control on an UNASSIGNED module records nothing — right-click the module's card → \"Assign to automation lane\" first. A 🟡🟡🔴🔴 countdown flashes this ◉ (and the recording clip's grid cell + Launchpad pad) on the last four beats before the clip's wrap. Per-lane single-writer: the arming client records this lane (another collaborator can record a DIFFERENT lane at the same time); peers still play back. On a Launchpad, SHIFT + the top-row button of the lane's column toggles the same arm (lane 8 = double-tap SHIFT).",
      "clipplayer-scene-repeat-{n}":
        "Scene {n}'s repeat count — the \"×N\" beside that scene's row. By default a launched scene loops forever (∞); CLICK to cycle the count ∞ → 2 → 3 → 4 → 8 → ∞, and after N passes of the scene's LONGEST clip the player auto-launches the next content scene down, skipping empty rows, through the normal quantized launch path. While the scene is actively counting the card shows live progress \"p/N\" (pass p of N). The count is also settable on a Launchpad — HOLD GRID + HOLD the scene's launch button, then tap pad k in the orange repeat-count view (pad 64 = back to infinite) — and it is CONTENT: a whole-scene COPY/PASTE carries it with the scene. Manual always wins: launching another scene resets the count fresh, launching an individual clip outside the scene cancels the countdown, and stopping every scene lane cancels it too, while MUTING lanes never alters it.",
    },
  },

  // ── CONTROL FAMILIES — SIX, and it was TEN ────────────────────────────────
  //
  // ⚠ FOUR FAMILIES ARE DELETED IN THE SAME DIFF THAT PROMOTES THIS MODULE, and
  // the deletion is a CONTRACT change (families are in the contract signature),
  // so it is stated here rather than left to the lock diff to explain.
  //
  // A declared family is a promise that the control can be RANKED on a face,
  // and a ranked family resolves to a shell cell that `faces-parity` DRIVES and
  // asserts moved. Four of the ten could never satisfy that, for two different
  // reasons, and neither is fixable by ranking them somewhere else:
  //
  //   `clipplayer-auto-assigned`  a per-lane COUNT. No gesture at all.
  //   `clipplayer-auto-cap`       the MAX badge. A readout, and a CONDITIONAL
  //                               one — it renders for a few seconds after a
  //                               touch exceeds the 16-track cap and is absent
  //                               on every fresh node.
  //   `clipplayer-auto-override`  a dot that renders only WHILE a grabbed
  //                               control is suspending automation playback.
  //   `clipplayer-clear-auto`     CLR AUTO, rendered only inside the editor and
  //                               only when the open clip carries automation.
  //
  // NOTHING IS LOST FROM THE SURFACE. All four still paint — the first three as
  // `StatusLed` lamps in the module's `fullViewBody` (caption static, the
  // measurement on `aria-label`/`title`, per the 2026-08-17/19 readout rulings)
  // and CLR AUTO as the same button in the note editor. What they stop being is
  // CELLS, because a cell that no probe can reach is a cell nothing can prove
  // is alive, and the legacy card keeps every one of them under `?shell=legacy`.
  //
  // ⚠ `clipplayer-scene-repeat` SURVIVED ONLY BECAUSE THE PROSE WAS RE-READ.
  // Its doc blob above described a "read-only ×N" whose count is set on a
  // Launchpad, with card-side editing "a follow-up" — which would have put it
  // in the list above. The card grew the click gesture (`cycleSceneRepeat`) and
  // says so in its own comment; the doc was never re-read. Corrected above.
  //
  // Every `testidPrefix` below is a literal BOTH surfaces emit — the legacy
  // card and the face's panel — which is what `module-docs-lint`'s card grep
  // checks, so a rename on either surface is red.
  controlFamilies: [
    { id: 'clipplayer-mono', label: 'Per-lane mono/poly toggle', kind: 'other', testidPrefix: 'clipplayer-mono' },
    { id: 'clipplayer-rate', label: 'Per-lane clock rate (mult/div)', kind: 'other', testidPrefix: 'clipplayer-rate' },
    { id: 'clipplayer-pad', label: 'Clip launch grid', kind: 'cell', testidPrefix: 'clipplayer-pad' },
    { id: 'clipplayer-cell', label: 'Piano-roll note cells', kind: 'cell', testidPrefix: 'clipplayer-cell' },
    { id: 'clipplayer-auto-arm', label: 'Per-lane automation record arm', kind: 'other', testidPrefix: 'clipplayer-auto-arm' },
    { id: 'clipplayer-scene-repeat', label: 'Per-scene repeat count', kind: 'other', testidPrefix: 'clipplayer-scene-repeat' },
  ],

  // ── THE FACE ──────────────────────────────────────────────────────────────
  //
  // WHAT IT IS FOR: eight instrument lanes, eight clip slots each, locked to
  // TIMELORDE. You launch clips into lanes and they drop in on a shared musical
  // boundary; you draw the notes in a piano roll; you record your knob moves
  // into whichever clip is playing. The verb a player performs is PLAY THE
  // ARRANGEMENT LIVE — deciding what happens next while the current thing is
  // still going.
  //
  // THE LADDER, read back as a sentence: at every lane tier you get the global
  // playback settings (STEP, QNT, S&H) and a live strip saying which of the
  // eight lanes are sounding; one Expand away you get the launcher itself — the
  // 8×8 grid at its real size, the note editor, the four per-lane rows, the
  // scene repeats, the transport, both recorders and the performance deck.
  //
  // ⚠ THE LANE-TIER CHANGE IS OWNER-APPROVED (2026-08-31, owner-decisions item
  // 10): `clipplayer` leaves `NON_SHELL_LANE_TYPES` and the 336 px launcher (up
  // to ~2,200 px in clip view) becomes a 192×180 tile plus one Expand, on the
  // electraControl / semantic-zoom precedent. The owner previews the COMPACT
  // tier before merge; the pinned `c`-pane instance is unaffected, since it
  // already paints at faceplate width.
  //
  // ⚠ `glyph: 'none'` IS A DECISION NOW, NOT THE ONLY LITERAL THAT COMPILES.
  // Since slice 5 the def DOES declare audio outputs (`audio{N}L/R`, the
  // per-lane clip returns), so a live meter glyph would resolve — onto LANE
  // 1's clip output, which is silent whenever lane 1 holds no audio clip and
  // says nothing about the other seven. The only useful glance here ("is
  // anything playing HERE") is per-lane, and the `tileBody` strip is that
  // glance; a lane-1 meter would be a confident picture of the wrong thing.
  // 'envelope' still needs a/d/s/r params there are none of and falls to
  // `{kind:'static'}`, which module-face-lint reddens by name (#1692).
  // 'algorithm' would resolve — it accepts a `face.extension` — but
  // `ShellExtensionGlyphProps` carries no nodeId, so every clip player in the
  // rack would draw the same picture, while the only useful glance here ("is
  // anything playing HERE") is per-node. The `tileBody` strip is that glance.
  //
  // ⚠ FOUR PAGES AND A TAB RAIL, ON THE OWNER'S EXPLICIT INSTRUCTION — AND
  // THERE IS NO `face.hero`, WHICH IS THE SAME DECISION SAID TWICE.
  //
  // This face shipped (#2326) with the launch grid promoted to `hero.cell` and
  // all four bands stacked in one scrolling column, on the reasoning that a
  // faceplate holds the grid, the editor and the deck AT ONCE "so there is no
  // selection left to make". The owner rejected exactly that (2026-09-04,
  // verbatim): "we do NOT want the clip viewer always visible. we want to see
  // it when we double click on a grid cell, at which point, we do not see the
  // grid. this needs to work exactly the way the legacy card did". The legacy
  // card is a VIEW SWITCHER — one `cardView` rune, a GRID / CLIP / ARR / CTRL
  // strip, and grid and editor as MUTUALLY EXCLUSIVE branches of one if/else —
  // and `face.tabbed` is the platform's own name for that structure, with the
  // band hiding, the rail and the parity sweep's rail navigation already built
  // (`dock-tabs-model.ts`; `FACE_TAB_OPT_IN` in its test carries this
  // instruction verbatim, which is the fence the opt-in is licensed by).
  //
  // ⚠ THE HERO HAD TO GO WITH IT, and that half is mechanical rather than a
  // taste. `heroFacePlan` PROMOTES the hero cell OUT of its band and ModuleShell
  // paints it ABOVE `.dock-pages` — outside every tab panel — so a hero grid
  // stays on screen on the editor tab no matter what the rail says. The hero
  // slot is for the module's picture AT REST; a launcher whose picture is one of
  // two views does not have one. Nothing is lost: `session` is the FIRST page
  // and therefore the default tab, so a freshly opened faceplate still paints
  // the 8×8 grid at its real size, and "a launcher whose faceplate paints seven
  // knobs and no pads is not a launcher" is still refused.
  //
  // ⚠ AND THE LANE TIER IS UNCHANGED EITHER WAY, which is the clause worth
  // checking rather than assuming. `clipplayer-pad-{n}` is a PF-14 PANEL and
  // module-face-lint refuses a panel SELECTED at a lane tier, so a panel's first
  // legal rank is SEVEN. PF-22's `laneOrder` used to drop the hero cell from the
  // LANE roster; with no hero it drops nothing — and the pad is ranked EIGHTH,
  // past the six-cell plate (`PLATE_COLS * PLATE_MAX_ROWS`), so the lane's six
  // selected cells are stepDiv / quantize / snh / octave / gateLength /
  // restrictRange before and after. `clipplayer-face-model.test.ts` pins both.
  //
  // The four pages are the module's own four ideas — the session, the channel
  // strip, the editor, the global playback settings — and they are NOT padded to
  // reach `DOCK_TAB_MIN_BANDS` (7). Padding is the failure mode the owner ruled
  // on for `ruttetra`; the opt-in exists precisely so a face with honest pages
  // can still be a view switcher when its MODULE is one.
  //
  // The transport, both recorders, the clip-undo stack, the per-lane MUTE/STOP
  // deck, the monome GRID bind, the arranger pop-out and the automation status
  // lamps are the extension's `fullViewBody`; the lane strip and the panic stop
  // are its `tileBody`. See $lib/ui/modules/clipplayer/shell-extension.ts.
  face: {
    title: 'clip player',
    hint: 'eight lanes of clips, launched onto a shared musical boundary and locked to TIMELORDE',
    glyph: 'none',
    extension: 'clipplayer',
    // OWNER-INSTRUCTED (2026-09-04) — see the block above. The rail IS the
    // legacy card's GRID / CLIP / ARR / CTRL strip, and it is what makes the
    // grid and the editor mutually exclusive.
    tabbed: true,
    order: [
      // Ranks 1-7 are the PARAMS, and they are the lane budget: with no hero,
      // `laneOrder` is this list unfiltered, and these seven are what a 192 px
      // tile can reach (it selects six).
      'stepDiv',
      'quantize',
      'snh',
      'octave',
      'gateLength',
      'restrictRange',
      'rangeFloor',
      // THE LAUNCH GRID, ranked EIGHTH — the first rank at which a PF-14 panel
      // is legal without `hero.cell` promoting it (module-face-lint refuses a
      // panel selected at a lane tier, and the plate selects six).
      'clipplayer-pad-{n}',
      // Ranks 9-13: the remaining panels, all past the six-cell plate.
      'clipplayer-mono-{n}',
      'clipplayer-rate-{n}',
      'clipplayer-auto-arm-{n}',
      'clipplayer-scene-repeat-{n}',
      'clipplayer-cell-{n}',
    ],
    pages: [
      {
        // ⚠ FIRST PAGE = THE DEFAULT TAB, and on a railed face that is a
        // behavioural statement, not an ordering preference: this is the view a
        // freshly opened faceplate shows, and it is GRID, exactly as the legacy
        // card's `cardView` starts at 'grid'.
        //
        // THE SCENE REPEATS SHARE THIS BAND WITH THE GRID because a row of the
        // grid IS a scene. (The mechanical half of that argument — that the
        // grid was promoted into the hero and `heroFacePlan` drops a band the
        // hero emptied — retired with the hero; the design half is what is
        // left, and it was always the stronger one.)
        id: 'session',
        label: 'session',
        hint:
          'the launch grid — columns are the eight instrument lanes, rows are the eight clip ' +
          'slots, and a row is a SCENE. Click a pad to launch it, click the playing pad to stop ' +
          'the lane, double-click to open it in the EDITOR page (which replaces this one, the way ' +
          'the card always did); give a scene a finite repeat count and it hands over to the next ' +
          'scene with content after that many passes of its longest clip.',
        controls: ['clipplayer-pad-{n}', 'clipplayer-scene-repeat-{n}'],
      },
      {
        id: 'channels',
        label: 'channels',
        hint:
          'per lane, and all eight at once because the reason to look is to compare them: ' +
          'MONO replaces the note under a new one where POLY stacks a chord, the RATE ' +
          'divides or multiplies that lane off the STEP grid for polyrhythms, and the arm ' +
          'records knob moves into whatever clip is playing there.',
        controls: [
          'clipplayer-mono-{n}',
          'clipplayer-rate-{n}',
          'clipplayer-auto-arm-{n}',
        ],
      },
      {
        id: 'editor',
        label: 'editor',
        hint:
          'the piano roll for whichever clip you last double-clicked in the grid, and the two ' +
          'display-only controls that decide how much of the pitch range it draws — neither ' +
          'touches playback, the pitch CV, or anything a clip emits. Go back with the SESSION ' +
          'tab, the way the card\'s GRID button did.',
        controls: ['clipplayer-cell-{n}', 'restrictRange', 'rangeFloor'],
        clusters: [{ label: 'pitch window', controls: ['restrictRange', 'rangeFloor'] }],
      },
      {
        id: 'playback',
        label: 'playback',
        hint:
          'global to every lane. STEP sets how many steps fall per TIMELORDE beat; QNT holds ' +
          'a launch until the longest playing clip wraps; S&H holds each pitch through a rest ' +
          'instead of resetting it.',
        controls: ['stepDiv', 'quantize', 'snh', 'octave', 'gateLength'],
        clusters: [
          { label: 'grid', controls: ['stepDiv', 'quantize'] },
          { label: 'voice', controls: ['snh', 'octave', 'gateLength'] },
        ],
      },
    ],
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const nodeId = node.id;
    const LANES = CLIP_LANES;
    const LOOKAHEAD_S = 0.2;
    // STALE-NOTE FIX (redesign §3.3): while a lane is being note-RECORDED, shrink
    // its scheduling lookahead to a few ms so a clip edit can't be out-run by
    // audio committed a full ~200 ms ago. Kept comfortably above the ~25 ms
    // scheduler tick (so the fast-clock loop still schedules ≥1 step ahead each
    // tick and never starves), but 4× tighter than the play lookahead — bounding
    // the schedule↔edit phase gap to ~one tick. Only the ACTIVE record lane uses
    // it; every other lane keeps the full LOOKAHEAD_S safety margin.
    const RECORD_LOOKAHEAD_S = 0.05;

    interface Lane {
      poly: ReturnType<typeof createPolySender>;
      gateSrc: ConstantSourceNode;
      velSrc: ConstantSourceNode;
      stepIndex: number;
      nextStepTime: number;
      // PLAY-EVERY loop counter: 0-based count of COMPLETED loops of the active
      // clip since it was launched. Incremented at each wrap (alongside
      // totalLoops), reset to 0 whenever the lane re-anchors from a fresh start
      // (launch/switch, RST, transport start, peer-adopt). Deterministic from the
      // shared transport, so every peer's counter advances in lock-step —
      // notePlaysThisLoop reads it, so per-note play-every stays collab-safe.
      loopCount: number;
      // LATCHED effective clock-rate index (into RATE_MULTS) for the step
      // duration — re-read from the active clip's `div` (or the lane rate) ONLY
      // at a loop boundary (stepIndex 0), so a mid-loop Clip-Div edit takes
      // effect at the NEXT clip start, never mid-loop.
      divIndex: number;
      active: number | null; // active slot (column) in this lane, or null
      lastVOct: number;
      lastGate: number;
      lastVel: number;
      // Ring of recently-scheduled (audio time → step) for an audio-accurate
      // visual playhead (steps are scheduled LOOKAHEAD_S ahead of currentTime).
      sched: { t: number; idx: number }[];
      // LIVE AUDITION (KEYS keyboard). A STABLE per-voice allocator maps each
      // held MIDI note → a poly voice-lane and KEEPS it until that note is
      // released (Phase 2a, gate/held-note plan §3.2). Replaces the old
      // positional repack: releasing a low note no longer shifts the others down
      // a lane (which rewrote pitch on a still-sounding voice → glitch).
      alloc: VoiceAllocator;
      // CLIP PLAYBACK voice ownership. Distinct from `alloc` above, which is
      // edge-driven and serves LIVE AUDITION: playback SCHEDULES ahead, so a
      // note's release is a future TIME rather than an event to react to. See
      // `assignPolyLanes`.
      playBook: PolyLaneBook;
      // The MIDI note (or null) currently WRITTEN to each poly voice-lane, so a
      // drain reconciles ownership → the MINIMUM set of clean gate/pitch edges
      // (a held voice whose owner is unchanged is never re-written).
      laneKey: (number | null)[];
      /** velocity 0..1 of the most-recent live-audition note-on. */
      audVel: number;
      /** AUTOMATION seam flag: false until this lane's active AUTOMATION clip has
       *  emitted its first step, so the FIRST step-0 (clip-switch INTO) anchors +
       *  de-zipper-glides from the held value instead of hard-stepping. Reset to
       *  false whenever the active clip changes / the lane re-anchors. */
      autoStarted: boolean;
    }
    const lanes: Lane[] = Array.from({ length: LANES }, () => {
      const poly = createPolySender(ctx);
      const gateSrc = ctx.createConstantSource();
      const velSrc = ctx.createConstantSource();
      gateSrc.offset.value = 0;
      velSrc.offset.value = 0;
      gateSrc.start();
      velSrc.start();
      return {
        poly,
        gateSrc,
        velSrc,
        stepIndex: 0,
        nextStepTime: ctx.currentTime + 0.05,
        loopCount: 0,
        divIndex: RATE_DEFAULT_INDEX,
        active: null,
        lastVOct: 0,
        lastGate: 0,
        lastVel: 0,
        sched: [],
        alloc: createVoiceAllocator(POLY_CHANNEL_PAIRS),
        playBook: createPolyLaneBook(),
        laneKey: new Array<number | null>(POLY_CHANNEL_PAIRS).fill(null),
        audVel: 0,
        autoStarted: false,
      };
    });

    /** The step lane L is currently SOUNDING (the latest scheduled step whose
     *  time has passed), or -1 when the lane is stopped. Audio-accurate (not the
     *  lookahead position) so the card + grid playhead tracks what you hear. */
    function laneDisplayStep(L: number): number {
      return laneAnchor(L).step;
    }

    /** The current audible step of lane L AND the audio time its gate was
     *  scheduled at (the onset the KEYS recorder projects a pad event against —
     *  clip-lane-phase.ts / clip-record-capture.ts). `step = -1`, `time = -Inf`
     *  when the lane is stopped or nothing has elapsed. */
    function laneAnchor(L: number): { step: number; time: number } {
      const ln = lanes[L];
      if (ln.active === null) return { step: -1, time: -Infinity };
      let best = -1;
      let bestT = -Infinity;
      for (const e of ln.sched) {
        if (e.t <= ctx.currentTime && e.t > bestT) {
          bestT = e.t;
          best = e.idx;
        }
      }
      return { step: best, time: bestT };
    }

    /** The reference-bar lane clocks for launch quantization (Deluge). COLLAB-
     *  CRITICAL: membership + each clip's LENGTH/RATE come from the SYNCED state
     *  (`d.playing[L]` + the synced clip at that slot), NOT a peer-local audio-
     *  sounding probe — so a tick-ahead and a tick-behind peer always agree on
     *  which lane is the longest reference bar and never diverge. Only the
     *  boundary's ctx-TIME uses the lane's local `nextStepTime`/`stepIndex` (the
     *  per-peer realization of the shared phase origin; the wrap names the same
     *  MUSICAL instant on every peer, differing only by audio-clock skew).
     *  `baseStepDur` is the global STEP grid; each lane scales it by its
     *  SYNCED clip.div / lane rate (clipDivIndex). */
    function collectPlayingClocks(
      d: ClipPlayerData | undefined,
      baseStepDur: number,
    ): PlayingLaneClock[] {
      return referenceClocks(d?.playing, (L, slot) => {
        const clip = readClip(d, clipIndex(slot, L)); // SYNCED clip at the synced slot
        // KIND-AGNOSTIC LENGTH. The reference bar is the LONGEST playing clip's
        // wrap, so a clip whose length this collector cannot see drags the
        // shared bar down to one step for every peer at once.
        const len = clipLengthSteps(clip);
        const divIdx = clipDivIndex(clip?.kind === 'note' ? clip : null, d, L); // SYNCED rate/div
        return {
          lenSteps: len,
          laneStepDur: laneStepDur(baseStepDur, divIdx),
          nextStepTime: lanes[L].nextStepTime, // local phase realization
          stepIndex: lanes[L].stepIndex,
        };
      });
    }

    // --- stop_all input (windowed edge counter — no whole-buffer rescan) ---
    const stopGain = ctx.createGain();
    const stopAnalyser = ctx.createAnalyser();
    stopAnalyser.fftSize = 2048;
    stopGain.connect(stopAnalyser);
    const stopSilence = ctx.createConstantSource();
    stopSilence.offset.value = 0;
    stopSilence.start();
    stopSilence.connect(stopGain);
    const stopCounter = createEdgeCounter({ ctx, analyser: stopAnalyser });

    // --- reset input (same windowed edge-counter seam as stop_all) ---
    const resetGain = ctx.createGain();
    const resetAnalyser = ctx.createAnalyser();
    resetAnalyser.fftSize = 2048;
    resetGain.connect(resetAnalyser);
    const resetSilence = ctx.createConstantSource();
    resetSilence.offset.value = 0;
    resetSilence.start();
    resetSilence.connect(resetGain);
    const resetCounter = createEdgeCounter({ ctx, analyser: resetAnalyser });
    // Card RST button intent (synced counter on node.data — see ClipPlayerData.
    // resetNonce). null = "not yet seen": the first tick ADOPTS the current
    // value without firing, so loading a saved patch never replays a reset.
    let lastResetNonce: number | null = null;

    // ── AUDIO CLIP PLAYBACK (slice 5) — per-lane stereo outs + the normal ───
    //
    // An audio clip is NOT a step sequence: it is ONE AudioBufferSourceNode,
    // scheduled ONCE at its launch boundary with loop=true, so its timing is
    // the context clock's and cannot drift against the grid that launched it
    // (a per-step emit would be a second, drifting opinion about when it
    // sounds — emitLaneStep's own comment). The lane machinery still advances
    // over `clipLengthSteps`, which is what makes queued stops land on the
    // SAME wrap a note clip would use.
    //
    // Capability-gated: unit tests drive this factory against a fake context
    // with no splitter/buffer-source/destination; there the ports still exist
    // (gains) and the scheduling bookkeeping runs, but no source is spawned.
    // The audible path is the e2e's to prove — a green fake proves nothing.
    const audioCtx = ctx as BaseAudioContext & Partial<AudioContext>;
    const canPlayAudioClips =
      typeof audioCtx.createChannelSplitter === 'function' &&
      typeof audioCtx.createBufferSource === 'function';
    interface LaneAudioOut {
      l: GainNode;
      r: GainNode;
      split: ChannelSplitterNode | null;
    }
    const audioOut: LaneAudioOut[] = [];
    // gain(0) → destination keeps the sources pulled (and phase-true) even
    // when nothing is patched or normalled — recorderbox's keep-alive rule.
    const audioKeep: GainNode | null = audioCtx.destination ? ctx.createGain() : null;
    if (audioKeep) {
      audioKeep.gain.value = 0;
      audioKeep.connect(audioCtx.destination!);
    }
    for (let L = 0; L < LANES; L++) {
      const l = ctx.createGain();
      const r = ctx.createGain();
      let split: ChannelSplitterNode | null = null;
      if (canPlayAudioClips) {
        split = audioCtx.createChannelSplitter!(2);
        split.connect(l, 0);
        split.connect(r, 1);
      }
      if (audioKeep) {
        l.connect(audioKeep);
        r.connect(audioKeep);
      }
      audioOut.push({ l, r, split });
    }

    /** Lane L's in-flight audio playback. `originAt` is the ctx time of loop
     *  frame 0 — kept across a mute suspend so resume stays phase-locked. */
    interface LaneAudioPlay {
      key: string; // clipAudioCacheKey — the take's identity incl. takeAt
      clip: AudioClipRecord;
      originAt: number;
      source: AudioBufferSourceNode | null;
      audible: boolean; // the duck edge published as playing
    }
    const laneAudio: (LaneAudioPlay | null)[] = new Array(LANES).fill(null);

    function firstMixmstrs(): ModuleNode | undefined {
      for (const n of Object.values(livePatch.nodes)) {
        if (n && (n as { type?: string }).type === 'mixmstrs') return n as ModuleNode;
      }
      return undefined;
    }

    /** Publish a lane-playing edge to the mixer's MON duck — a value scheduled
     *  AT A CONTEXT TIME, the same instant the clip's own source starts or
     *  stops, per the clip-lane-return contract. Never polled. */
    function publishLaneEdge(L: number, playing: boolean, atTime: number): void {
      const engine = getActiveEngine();
      const mix = firstMixmstrs();
      if (!engine || !mix) return;
      try {
        engine.write(mix, 'clipLaneEdge', { lane: L, playing, atTime });
      } catch {
        /* the mixer is not materialized yet — nothing to duck */
      }
    }

    function spawnLaneSource(L: number, st: LaneAudioPlay, buf: AudioBuffer): void {
      if (!canPlayAudioClips) return;
      const src = audioCtx.createBufferSource!();
      src.buffer = buf;
      src.loop = true;
      src.loopStart = 0;
      src.loopEnd = buf.duration;
      const out = audioOut[L]!;
      if (out.split) src.connect(out.split);
      const now = ctx.currentTime;
      // A future origin starts ON it; a past origin (decode latency, an
      // unmute) starts NOW at the phase-locked offset into the loop, so the
      // loop's frame 0 stays anchored to `originAt` either way.
      if (st.originAt >= now) src.start(st.originAt);
      else src.start(now, (now - st.originAt) % buf.duration);
      st.source = src;
    }

    /** Stop lane L's audio at `at`. `forget` drops the take (launch/stop/
     *  switch/undo); false keeps it + its phase origin (mute suspend). */
    function haltLaneAudio(L: number, at: number, forget: boolean): void {
      const st = laneAudio[L];
      if (!st) return;
      const t = Math.max(at, ctx.currentTime);
      if (st.source) {
        try {
          st.source.stop(t);
        } catch {
          /* already stopped */
        }
        st.source = null;
      }
      if (st.audible) {
        publishLaneEdge(L, false, t);
        st.audible = false;
      }
      if (forget) laneAudio[L] = null;
    }

    /** Begin lane L's playback of an audio `clip`, loop frame 0 at `at`.
     *  Decode is lazy (byte-capped cache); the duck edge is published at the
     *  SCHEDULED time immediately, not when the decode resolves — the boundary
     *  is the boundary whether or not the bytes are warm. */
    function startLaneAudio(L: number, clip: AudioClipRecord, at: number): void {
      haltLaneAudio(L, at, true);
      const st: LaneAudioPlay = {
        key: clipAudioCacheKey(clip),
        clip,
        originAt: at,
        source: null,
        audible: true,
      };
      laneAudio[L] = st;
      publishLaneEdge(L, true, at);
      if (!canPlayAudioClips) return;
      void getClipAudioBuffer(ctx, clip)
        .then((buf) => {
          if (!alive || laneAudio[L] !== st || !st.audible || st.source || !buf) return;
          spawnLaneSource(L, st, buf);
        })
        .catch(() => {
          /* media absent — the pad's named state; nothing sounds */
        });
    }

    /** Resume a mute-suspended lane at its original phase. */
    function resumeLaneAudio(L: number): void {
      const st = laneAudio[L];
      if (!st || st.audible) return;
      st.audible = true;
      publishLaneEdge(L, true, ctx.currentTime);
      if (!canPlayAudioClips) return;
      void getClipAudioBuffer(ctx, st.clip)
        .then((buf) => {
          if (!alive || laneAudio[L] !== st || !st.audible || st.source || !buf) return;
          spawnLaneSource(L, st, buf);
        })
        .catch(() => {
          /* media absent */
        });
    }

    /** The launch/stop/switch hook: lane L's active slot became `slot`,
     *  effective at `at` — the same instant setLaneActive anchors the grid on.
     *  Called from every path that moves `ln.active`. */
    function updateLaneAudio(L: number, slot: number | null, at: number): void {
      const d = liveData();
      const clip = slot !== null ? readClip(d, clipIndex(slot, L)) : null;
      if (clip?.kind === 'audio' && transportRunning() && !laneMuted(d, L)) {
        startLaneAudio(L, clip, at);
      } else {
        haltLaneAudio(L, at, true);
      }
    }

    /** (Re)start every active audio-clip lane from loop frame 0 at `at` — the
     *  transport-start and RST re-anchor (all lanes share the phase origin). */
    function restartActiveLaneAudio(at: number): void {
      const d = liveData();
      for (let L = 0; L < LANES; L++) {
        const slot = lanes[L].active;
        if (slot === null) continue;
        const clip = readClip(d, clipIndex(slot, L));
        if (clip?.kind === 'audio' && !laneMuted(d, L)) startLaneAudio(L, clip, at);
        else haltLaneAudio(L, at, true);
      }
    }

    // ── THE NORMALLED RETURN — lane N into mixmstrs channel N ──────────────
    //
    // A hardware normal and nothing more (clip-lane-return.ts): the internal
    // connection BREAKS the moment a cable is patched into that channel's
    // input jack — a GRAPH fact, never an audio probe — and the lane's own
    // audio{N}L/R jacks keep working either way. A cable into EITHER leg of
    // the channel breaks the whole channel's normal: the MON duck is
    // per-channel, and a half-normalled channel (live L, clip R) is not a
    // state a player can reason about. Re-checked every tick against the live
    // edge set and the mixer's published entry points; a rebuilt mixer
    // factory hands back a NEW roster identity, which forgets dead nodes.
    let laneReturnsRef: unknown = null;
    let laneReturns: { node: AudioNode; input: number }[] | null = null;
    const normalOn: boolean[] = new Array(LANES).fill(false);
    function syncLaneReturns(): void {
      const engine = getActiveEngine();
      const mix = firstMixmstrs();
      const raw = engine && mix ? engine.read(mix, 'laneReturns') : null;
      if (raw !== laneReturnsRef) {
        // The mixer (re)built or vanished — prior connections died with its
        // nodes. Best-effort disconnect (a dead node throws; that is fine).
        for (let L = 0; L < LANES; L++) {
          if (normalOn[L] && laneReturns) {
            const rl = laneReturns[2 * L];
            const rr = laneReturns[2 * L + 1];
            try {
              if (rl) audioOut[L]!.l.disconnect(rl.node);
            } catch {
              /* node gone */
            }
            try {
              if (rr) audioOut[L]!.r.disconnect(rr.node);
            } catch {
              /* node gone */
            }
          }
          normalOn[L] = false;
        }
        laneReturnsRef = raw;
        laneReturns =
          Array.isArray(raw) && raw.length >= LANES * 2
            ? (raw as { node: AudioNode; input: number }[])
            : null;
      }
      if (!laneReturns || !mix) return;
      const edges = Object.values(livePatch.edges);
      for (let L = 0; L < LANES; L++) {
        const patched =
          isInputPortConnected(edges, mix.id, `ch${L + 1}L`) ||
          isInputPortConnected(edges, mix.id, `ch${L + 1}R`);
        const want = clipLaneNormalConnected(patched);
        if (want === normalOn[L]) continue;
        const rl = laneReturns[2 * L]!;
        const rr = laneReturns[2 * L + 1]!;
        const out = audioOut[L]!;
        if (want) {
          try {
            out.l.connect(rl.node, 0, rl.input);
            out.r.connect(rr.node, 0, rr.input);
          } catch {
            continue; // roster stale mid-teardown; the next tick re-reads it
          }
        } else {
          try {
            out.l.disconnect(rl.node);
          } catch {
            /* already gone */
          }
          try {
            out.r.disconnect(rr.node);
          } catch {
            /* already gone */
          }
        }
        normalOn[L] = want;
      }
    }

    let alive = true;
    let unsubscribeTick: (() => void) | null = null;
    let prevRunning = false;
    let totalLoops = 0;
    // ── AUTOMATION-STOP seam (param-jump policy) ────────────────────────────
    /**
     * HOLD-LAST-VALUE for lane L's OUTGOING clip's sibling automation at a
     * stop/switch seam. Keyed off the lane's active NOTE clip + its `auto[k]`
     * tracks (the same predicate playback uses), so ANY playing clip carrying
     * automation gets its hold.
     *
     * ORDERING (the same-tick wipe fix): this runs BEFORE the incoming clip's
     * step-0 anchor/glide is scheduled — from `setLaneActive` (which every
     * switch/stop path funnels through), the peer-adopt mutation, the transport
     * stop, and dispose — never from a post-loop stop-detect that would cancel
     * freshly-scheduled incoming events.
     *
     *  - `switchAt != null` ⇒ a QUANTIZED BOUNDARY switch: the stop position is
     *    exactly the loop end (`len`), and the hold PINS at the boundary time
     *    (engine future-pin — no cancel, so the outgoing clip's still-audible
     *    tail plays to the musical boundary). Params the INCOMING clip's
     *    automation drives are SKIPPED entirely — nothing is scheduled past the
     *    boundary and the incoming step-0 glide takes over exactly there.
     *  - `switchAt == null` ⇒ an IMMEDIATE stop/switch (stop-all, QNT-off/NOW
     *    launch, peer stop, transport stop, dispose): cancel-and-hold at NOW.
     *    The stop position is the lane's audible playhead QUANTIZED to the
     *    integer step grid (`quantizeStopStep`) so peers' resting values
     *    converge (each peer's fractional playhead is peer-local). Params the
     *    incoming clip's automation drives are TRUNCATE-ONLY (kill the outgoing
     *    ~200 ms tail; the incoming anchor+glide repossesses them).
     */
    function holdLaneAutomation(
      L: number,
      outgoingSlot: number | null,
      incomingSlot: number | null,
      switchAt: number | null,
    ): void {
      if (outgoingSlot === null) return;
      const d = liveData();
      const oldClip = readClip(d, clipIndex(outgoingSlot, L));
      if (oldClip?.kind !== 'note') return;
      let tracks = autoTracksAt(clipIndex(outgoingSlot, L));
      if (tracks.length === 0) return;
      // SINGLE-DRIVER ownership: hold ONLY the keys THIS lane currently owns —
      // a key another lane owns was never driven by L (shadowed), so pinning it
      // here would stomp the owning lane's live automation. (Ownership is
      // computed with L still active — holdLaneAutomation runs BEFORE
      // ln.active flips.)
      const ownersNow = computeAutoOwners(d);
      tracks = tracks.filter((t) => ownersNow.get(automationTargetKey(t.target)) === L);
      if (tracks.length === 0) return;
      // Automation length is LINKED to the note clip in this phase.
      const len = Math.max(1, oldClip.lengthSteps);
      let stopStep: number;
      if (switchAt !== null) {
        stopStep = len; // boundary switch stops exactly at the loop end
      } else {
        const stepDur = 60 / transportBpm() / (STEP_DIV_SPB[readParam('stepDiv', 2)] ?? 4);
        const laneDur = laneStepDur(stepDur, lanes[L].divIndex);
        const frac = laneFracStep(L, laneDur);
        stopStep = quantizeStopStep(frac >= 0 ? frac : lanes[L].stepIndex, len);
      }
      // Params another writer takes over at this seam get no resting pin:
      //  - the INCOMING clip's own automation (this lane), and
      //  - keys REPOSSESSED by another still-active carrier lane once L stops
      //    (ownership recomputed excluding L).
      // Boundary → skip (the successor's glide/steps take over at/after the
      // seam); immediate → truncate-only (kill L's ~200 ms tail now).
      const shared = new Set<string>();
      const incomingTracks =
        incomingSlot !== null ? autoTracksAt(clipIndex(incomingSlot, L)) : [];
      for (const t of incomingTracks) shared.add(automationTargetKey(t.target));
      const ownersAfter = computeAutoOwners(d, L);
      for (const t of tracks) {
        const k = automationTargetKey(t.target);
        if (ownersAfter.has(k)) shared.add(k); // another lane repossesses it
      }
      let skipKeys: Set<string> | undefined;
      let truncateKeys: Set<string> | undefined;
      if (shared.size) {
        if (switchAt !== null) skipKeys = shared;
        else truncateKeys = shared;
      }
      controller.holdLastValue(tracks, stopStep, SEAM_GLIDE_S, {
        atTime: switchAt ?? undefined,
        skipKeys,
        truncateKeys,
      });
    }
    // Per-lane MUTE edge-tracking — silence the moment a lane is muted (drive its
    // buses to 0 at currentTime) rather than waiting for its next scheduled step.
    const prevMuted: boolean[] = new Array(CLIP_LANES).fill(false);

    // --- SONG MODE (arranger) ---
    // songBeat = beats since the current song origin (record-arm or arrangement
    // play from the top). Tracks ctx.currentTime so a recorded launch's beat is
    // the beat you HEARD it apply. arrangeCursor = the last songBeat the playback
    // cursor fired up to (half-open, so each event fires once).
    let songBeat = 0;
    let lastBeatAt = ctx.currentTime;
    let arrangeCursor = 0;
    let prevRecording = false;
    let prevClipMode: ClipPlayMode = 'session';

    // --- SONG MODE v2 (the PRINTED performance; clip-song.ts) ---
    // songSchedCursor = the absolute song-beat the SONG PLAYBACK scheduler has
    // scheduled notes up to (ahead of songBeat by the lookahead) — distinct from
    // arrangeCursor (the legacy launch-log replay cursor). songNoteBuf[L] buffers
    // this take's PRINTED note onsets for lane L until a commit boundary (the
    // write-storm guard); songCommitAtBeat is the next song-beat to flush at.
    let songSchedCursor = 0;
    const songNoteBuf: SongNoteEvent[][] = Array.from({ length: CLIP_LANES }, () => []);
    let songCommitAtBeat = SONG_COMMIT_BEATS;
    let prevSongArmed = false;
    // Client-local CAP-HIT flag (mirrors controller.capHit for the automation
    // track cap): set true when a commit would truncate a lane's printed note
    // channel at MAX_SONG_NOTE_EVENTS, so the card can warn politely. Consumed +
    // cleared by the card via read('songCapHit'); reset on a fresh REPLACE take.
    let songCapHit = false;

    // --- SCENE REPEATS (per-peer runtime tracking; clip-scene-repeats.ts) ---
    // repBeatClock: beats elapsed while running — like songBeat but NEVER reset
    // (record-arm/arrangement origins don't touch it), so the frozen repeat unit
    // counts in pure musical time (a tempo change rescales, a transport stop
    // pauses). lastSceneLaunch mirrors the synced `sceneLaunch` marker
    // (resetNonce pattern: null = adopt-without-fire on the first tick, so a
    // loaded patch never replays a launch — scenes loop infinitely until the
    // next real scene launch). The mirror compares the WHOLE {slot, n} pair,
    // not n alone: two peers launching DIFFERENT scenes concurrently both
    // write n = prev+1, and the LWW loser would otherwise never observe a
    // change and mis-cancel instead of re-anchoring. repTrack is the LIVE
    // countdown — runtime-only, never synced/persisted; a transport restart
    // resets its count.
    let repBeatClock = 0;
    let lastSceneLaunch: { slot: number; n: number } | null = null;
    let repTrack: SceneRepeatTrack | null = null;
    // BOUNDARY FLOOR for the auto-advance (engine-local, set only on the peer
    // that WROTE the advance): the frozen boundary in ctx time. The write
    // deliberately lands ~one anchor step + the lookahead EARLY (so the anchor
    // lane's wrap-processing sees it) — without a floor, an IDLE target lane
    // would launch immediately (off-grid, before the boundary) and an outgoing
    // lane with a loop shorter than one anchor step would catch a wrap inside
    // the early window. The floor clamps both to the boundary. Cleared on any
    // manual interference (marker change / deviation), transport stop, and
    // expiry — manual launches must never be delayed by a stale floor.
    let advanceFloorUntil: number | null = null;
    /** The global STEP grid in steps-per-beat (frozen into a repeat unit at
     *  anchor time). */
    function stepsPerBeat(): number {
      return STEP_DIV_SPB[readParam('stepDiv', 2)] ?? 4;
    }

    function liveData(): ClipPlayerData | undefined {
      return livePatch.nodes[nodeId]?.data as ClipPlayerData | undefined;
    }
    function readParam(id: string, fallback: number): number {
      const v = livePatch.nodes[nodeId]?.params?.[id];
      return typeof v === 'number' ? v : fallback;
    }
    function writeData(mut: (d: ClipPlayerData) => void): void {
      const live = livePatch.nodes[nodeId];
      if (!live) return;
      if (!live.data) live.data = {};
      mut(live.data as ClipPlayerData);
    }

    // ── ONE-TIME clip-key SCHEMA MIGRATION (v1 stride-8 → v2 stride-64) ──
    // The migration does not hook the persistence loader (graph/persistence.ts)
    // — originally because that file was in the collab-attest basis (deleted
    // 2026-08-17), and still because the loader is not the seam that always
    // runs. Instead it runs ONCE here — the
    // engine factory is the single per-node seam that always runs, for every
    // load path (envelope load AND live-doc / rackspace restore). It re-keys the
    // `clips` map so every clip stays at its original (lane, slot), then stamps
    // `data.sv = 2`. Guarded by `sv` → runs at most once per node per client and
    // NEVER re-migrates (storm-safe: one small write, not per-tick — see
    // `cv-modulation-live-store-write-storm`). `coerceClipRecord` clones each
    // moved clip to a PLAIN object so a live syncedStore Y child is never
    // re-parented (`yjs-save-load-real-ydoc`). Stamping `sv` here for an EMPTY
    // new player (before any clip exists) is what makes "clips-present-but-no-sv"
    // unambiguously mean LEGACY for every later reader.
    writeData((d) => {
      migrateClipPlayerData(d, coerceClipRecord);
      // CONTAINER INIT (LWW-race hardening): create the `auto` + `autoAssign`
      // + `automation`/`automation.lanes` containers HERE — the deterministic
      // per-node load seam — never lazily inside the racy commit/assign/arm
      // paths, where a concurrent creation would last-writer-wins a peer's
      // whole subtree. At load both peers write an EMPTY map (harmless either
      // way); once present, no writer ever replaces the container. (The
      // commit-side shell creation remains as a fallback for clips created
      // mid-arm.)
      if (!d.auto || typeof d.auto !== 'object') d.auto = {};
      if (!d.autoAssign || typeof d.autoAssign !== 'object') d.autoAssign = {};
      if (!d.automation || typeof d.automation !== 'object') d.automation = {};
      // SCENE REPEATS container (per-key writes land in a container created at
      // this deterministic load seam, same LWW-race hardening as auto/autoAssign).
      if (!d.sceneRepeats || typeof d.sceneRepeats !== 'object') d.sceneRepeats = {};
      // SONG (arranger v2) containers — same container-LWW hardening: create
      // song + song.notes + song.auto + song.arrangerAuto.tracks + arrangerAssign
      // at this deterministic load seam so the per-lane/per-key print commits
      // never LWW a peer's subtree (clip-song.ts).
      ensureSongContainers(d);
      // Interim 81084fe9 ARRAY lanes shape → the canonical per-key RECORD
      // (one-way; per-key set/delete is what makes concurrent per-lane arms
      // merge instead of whole-array LWW).
      migrateAutomationLanesShape(d);
      if (!d.automation.lanes || typeof d.automation.lanes !== 'object') d.automation.lanes = {};
      // ZOMBIE SWEEP (clean break, made true): the retired stamped
      // `kind:'automation'` clips coerce to null on read but their RAW values
      // linger in `clips` — raw-truthiness readers (padState 'loaded', the
      // materialize gates) see ghost cells. Delete them, plus the retired
      // `automation.clip` pointer field. Idempotent + one small write only
      // when a zombie exists.
      if (d.clips) {
        for (const k of Object.keys(d.clips)) {
          const v = d.clips[k] as { kind?: unknown } | null | undefined;
          if (v && typeof v === 'object' && v.kind === 'automation') delete d.clips[k];
        }
      }
      const legacyAuto = d.automation as
        | { clip?: unknown; arm?: unknown; recorderId?: unknown }
        | undefined;
      if (legacyAuto && 'clip' in legacyAuto) delete legacyAuto.clip;
      // CLEAN BREAK (per-lane arm): the retired GLOBAL {arm, recorderId} fields
      // coerce away — per-lane state lives in automation.lanes[] only.
      if (legacyAuto && 'arm' in legacyAuto) delete legacyAuto.arm;
      if (legacyAuto && 'recorderId' in legacyAuto) delete legacyAuto.recorderId;
      // CLEAN BREAK (module-level assignment): retired param-level autoAssign
      // keys (`nodeId::paramId`) are swept so raw readers never see them
      // (coerceAutoAssign drops them anyway — this keeps the stored map clean).
      if (d.autoAssign && typeof d.autoAssign === 'object') {
        for (const k of Object.keys(d.autoAssign)) {
          if (k.includes('::')) delete d.autoAssign[k];
        }
      }
    });

    // ─────────────────────── PER-CLIP AUTOMATION ────────────────────────────
    // One AutomationController per clip-player node. It composes the pure
    // record/playback cores with the INJECTED side effects below:
    //   - readNorm  : the STORE tap (mount-independent, modulation-free) — the
    //                 resolved surface param's live value, normalized curve-aware.
    //   - curve/unitNorm: the target ParamDef's curve + one-unit size (discrete).
    //   - drive     : PLAYBACK — schedule transient ramps via engine.scheduleParam
    //                 (denormalized curve-aware); touches NO Y.Doc.
    //   - readAutoTracks: the coerce-ONCE cached read view of `auto[k]` (below).
    //   - commit    : RECORD — write ONLY the touched track keys into
    //                 `d.auto[k].tracks` in ONE transaction (never a whole-record
    //                 reassign; a peer's note edit at `clips[k]` is disjoint).
    // The per-lane arm mirror lives on the controller itself (armLane /
    // disarmLane, reconciled each tick from the synced per-lane flags on the
    // lanes THIS client is the recorder of — isLaneAutomationRecorder).

    // ── COERCE-ONCE cached read view of the sibling `auto` records ──
    // The tick reads `auto[k]` tracks per lane per tick; re-coercing (deep-clone
    // + step-SORT of every event array) each time is the historic lane-stall
    // cause (the "saw -1" scheduler regression). Cache the built views keyed by
    // clip index and invalidate on ANY Y.Doc update (cheap revision counter) +
    // on raw-reference change. Test harnesses whose mocked store/ydoc has no
    // `on` seam simply skip caching (correctness first, still coerce-per-call).
    const EMPTY_TRACKS: AutomationTrack[] = [];
    const EMPTY_KEYS: ReadonlySet<string> = new Set();
    const EMPTY_OWNERS: Map<string, number> = new Map();
    let autoRev = 0;
    const autoViewCache = new Map<
      number,
      { rev: number; src: unknown; view: AutomationTrack[]; keys: ReadonlySet<string> }
    >();
    const bumpAutoRev = (): void => {
      autoRev++;
    };
    const ydocEvents = ydoc as unknown as {
      on?: (ev: string, fn: () => void) => void;
      off?: (ev: string, fn: () => void) => void;
    };
    const autoCacheEnabled = typeof ydocEvents.on === 'function';
    if (autoCacheEnabled) ydocEvents.on!('update', bumpAutoRev);
    function readAutoCache(idx: number) {
      const raw = (liveData() as { auto?: Record<string, unknown> } | undefined)?.auto?.[
        String(idx)
      ];
      if (!raw) return null;
      if (autoCacheEnabled) {
        const hit = autoViewCache.get(idx);
        if (hit && hit.rev === autoRev && hit.src === raw) return hit;
      }
      const view = autoTrackViews(coerceAutoClipRecord(raw));
      const entry = {
        rev: autoRev,
        src: raw as unknown,
        view,
        keys: new Set(view.map((t) => automationTargetKey(t.target))) as ReadonlySet<string>,
      };
      if (autoCacheEnabled) autoViewCache.set(idx, entry);
      return entry;
    }
    /** The coerced RUNTIME track views of `auto[idx]` (cached; [] when none). */
    function autoTracksAt(idx: number): AutomationTrack[] {
      return readAutoCache(idx)?.view ?? EMPTY_TRACKS;
    }
    /** The track-KEY set of `auto[idx]` (same cache entry; empty set when none). */
    function autoKeysAt(idx: number): ReadonlySet<string> {
      return readAutoCache(idx)?.keys ?? EMPTY_KEYS;
    }

    // ── SINGLE-DRIVER playback ownership (cross-lane rule) ──
    // For a given targetKey at most ONE lane drives it per tick: the ASSIGNED
    // lane when it's an active carrier, else the lowest active carrier
    // (autoPlaybackOwners). Recomputed per tick (cheap: 8 set refs) and on
    // demand at the stop/switch seams. `excludeLane` models "after lane L
    // stops" for the hold seam (who repossesses L's keys).
    function computeAutoOwners(
      d: ClipPlayerData | undefined,
      excludeLane: number | null = null,
    ): Map<string, number> {
      const carriers: (ReadonlySet<string> | null)[] = new Array(LANES).fill(null);
      let any = false;
      for (let L = 0; L < LANES; L++) {
        if (L === excludeLane) continue;
        const ln = lanes[L];
        if (ln.active === null) continue;
        const keys = autoKeysAt(clipIndex(ln.active, L));
        if (keys.size) {
          carriers[L] = keys;
          any = true;
        }
      }
      if (!any) return EMPTY_OWNERS;
      return autoPlaybackOwners(coerceAutoAssign(d?.autoAssign), carriers);
    }

    /** The LIVE target node for an automation track's (nodeId,paramId). */
    function targetNode(target: AutomationTarget): ModuleNode | undefined {
      return livePatch.nodes[target.nodeId] as ModuleNode | undefined;
    }
    /** The resolved surface param (def + live get/set) for a target, or null. */
    function resolveTarget(target: AutomationTarget) {
      return resolveSurfaceParam(targetNode(target), target.paramId);
    }

    const controller = new AutomationController({
      // STORE tap → normalized 0..1 (curve-aware). NOT engine.readParam — that
      // double-applies live CV; recording a HAND-held control must capture the
      // store/knob value.
      readNorm(target: AutomationTarget): number | null {
        const r = resolveTarget(target);
        if (!r) return null;
        return valueToFrac(r.get(), r.def.min, r.def.max, r.def.curve);
      },
      // ENGINE-EFFECTIVE tap (base + live CV) → normalized 0..1. Used ONLY for
      // a param held exclusively by cv-bridge grips (`cv:<edgeId>` — the video
      // engine's activity detector), so RECORD captures the modulated movement
      // the user hears/sees (video: the uniform the cv bridge wrote this frame;
      // audio: intrinsic + modulator tap). Human holders keep readNorm — see
      // AutomationController.captureRead for the selection rule.
      readEffectiveNorm(target: AutomationTarget): number | null {
        const engine = getActiveEngine();
        const node = targetNode(target);
        const def = resolveTarget(target)?.def;
        if (!engine || !node || !def) return null;
        const v = engine.readParam(node, target.paramId);
        if (typeof v !== 'number' || !Number.isFinite(v)) return null;
        return valueToFrac(v, def.min, def.max, def.curve);
      },
      curve(target: AutomationTarget): string | undefined {
        return resolveTarget(target)?.def.curve;
      },
      unitNorm(target: AutomationTarget): number | undefined {
        const def = resolveTarget(target)?.def;
        if (!def) return undefined;
        return def.curve === 'discrete' ? 1 / Math.max(1, def.max - def.min) : undefined;
      },
      // PLAYBACK — transient, ZERO Yjs. Denormalize each ramp point (curve-aware)
      // and schedule it on the target param at its audio time via the engine's
      // future-time seam. No engine / no def ⇒ silently skip (nothing to drive).
      drive(target: AutomationTarget, points: RampPoint[]): void {
        const engine = getActiveEngine();
        const node = targetNode(target);
        const def = resolveTarget(target)?.def;
        if (!engine || !node || !def) return;
        for (const p of points) {
          const v = fracToValue(p.value, def.min, def.max, def.curve);
          engine.scheduleParam(node, target.paramId, v, p.at, p.ramp);
        }
      },
      // HOLD-AT-SEAM (param-jump policy) — `toValueNorm` present ⇒ pin/glide to
      // that resting value (hold-last-value on stop / the release hand-off pin);
      // `null` ⇒ truncate-only (touch punch-in / an immediate switch on a shared
      // param). `atTime` names the seam: absent ⇒ now (cancel-and-hold); a FUTURE
      // loop boundary ⇒ the engine pins there WITHOUT cancelling, so the outgoing
      // clip's tail plays to the musical boundary. Transient — zero Y.Doc.
      hold(target: AutomationTarget, toValueNorm: number | null, glideS: number, atTime?: number): void {
        const engine = getActiveEngine();
        const node = targetNode(target);
        const def = resolveTarget(target)?.def;
        if (!engine || !node || !def) return;
        const toValue =
          toValueNorm == null ? undefined : fracToValue(toValueNorm, def.min, def.max, def.curve);
        engine.holdParam(node, target.paramId, atTime ?? ctx.currentTime, toValue, glideS);
      },
      // The MERGE BASE at commit time: the cached coerced view of `auto[k]`.
      readAutoTracks(clipIdx: number): readonly AutomationTrack[] {
        return autoTracksAt(clipIdx);
      },
      // RECORD commit — write ONLY the touched track keys into
      // `d.auto[k].tracks` (plain event arrays, never a live Y child), all in
      // ONE transaction (a single sync update per take-pass). A peer's note
      // edit lives at `clips[k]` — a DISJOINT key — so a commit can NEVER
      // last-writer-wins a note change (the note-clobber the sibling storage
      // exists to prevent). New keys respect MAX_AUTOMATION_TRACKS; an existing
      // track's `interp` survives.
      //
      // NON-UNDOABLE by design: continuous overdub commits once per wrap, so
      // tracking them under LOCAL_ORIGIN would flood the undo stack (Cmd-Z
      // regressing one wrap at a time — worse than not capturing at all, and
      // take-scoped capture isn't cheap with Y.UndoManager's captureTimeout
      // merging). A bad take is removed via the explicit CLEAR affordances
      // (control-menu "Clear recorded automation" / the editor's CLR AUTO),
      // which ARE undoable.
      //
      // GHOST-GUARD (lifecycle): a pass latched to a clip that has since been
      // deleted / pasted over with a non-note value must NOT resurrect a
      // dangling auto[k] — skip the commit when clips[k] is no longer a note
      // clip.
      commit(clipIdx: number, updates: AutoTrackUpdate[]): void {
        if (updates.length === 0) return;
        if (readClip(liveData(), clipIdx)?.kind !== 'note') return; // latched clip gone
        const tx =
          typeof (ydoc as { transact?: unknown }).transact === 'function'
            ? (fn: () => void) => ydoc.transact(fn, AUTOMATION_COMMIT_ORIGIN)
            : (fn: () => void) => fn();
        tx(() => {
          writeData((d) => {
            if (!d.auto) d.auto = {};
            if (!d.auto[String(clipIdx)] || typeof d.auto[String(clipIdx)] !== 'object') {
              // CREATION is the only whole-record write (an empty shell).
              d.auto[String(clipIdx)] = { tracks: {} };
            }
            const rec = d.auto[String(clipIdx)] as AutoClipRecord;
            if (!rec.tracks || typeof rec.tracks !== 'object') rec.tracks = {};
            let count = Object.keys(rec.tracks).length;
            for (const u of updates) {
              // DEAD-MODULE GUARD: a partial pass punched out because its
              // MODULE was DELETED (not re-assigned) must not land an orphan
              // track under a dead node id — it would count toward the
              // 16-track cap forever with no control-precise clear left.
              if (!livePatch.nodes[u.target.nodeId]) continue;
              const isNew = !(u.key in rec.tracks);
              if (isNew && count >= MAX_AUTOMATION_TRACKS) {
                // The durable cap — surface it politely (client-local flag the
                // card polls; never the Y.Doc).
                controller.capHit = true;
                continue;
              }
              const prevInterp = (rec.tracks[u.key] as AutoTrack | undefined)?.interp;
              const plain: AutoTrack = {
                events: u.events.map((e) => ({ step: e.step, value: e.value })),
              };
              if (prevInterp === 'linear' || prevInterp === 'hold') plain.interp = prevInterp;
              rec.tracks[u.key] = plain; // per-KEY write — never the whole record
              if (isNew) count++;
            }
          });
        });
      },
    });
    // Register this player's controller so a live grab of any AUTOMATED control
    // (screen drag / MIDI CC / Electra) suspends its playback via the shared
    // notifyAutomationTouch seam. Dropped in dispose().
    registerAutomationController(nodeId, controller);

    // --- SONG MODE helpers ---
    function clipMode(): ClipPlayMode {
      const m = liveData()?.clipMode;
      return m === 'arrangement' || m === 'song' ? m : 'session';
    }
    function isRecording(): boolean {
      return liveData()?.recording === true;
    }
    /** Record mode, defaulting to legacy 'replace'. In 'overdub' the arm-edge
     *  KEEPS the existing log + song time (new launches merge in by song-beat);
     *  'replace' clears + restarts at bar 1. */
    function recordMode(): 'replace' | 'overdub' {
      return liveData()?.recordMode === 'overdub' ? 'overdub' : 'replace';
    }
    /** Append an applied launch to the arrangement log at the current song-beat. */
    function appendArrangeEvent(ev: ArrangeEvent): void {
      writeData((d) => {
        d.arrangement = recordEvent(coerceArrangeData(d.arrangement), ev);
      });
    }
    /** Apply one arrangement event during playback (the timeline IS the schedule,
     *  so launch directly via setLaneActive — no quantize). */
    function applyArrangeEvent(ev: ArrangeEvent): void {
      setLaneActive(ev.lane, ev.slot === 'stop' ? null : ev.slot);
    }
    /** Restart song time at the top (record-arm / arrangement (re)start). */
    function resetSongOrigin(): void {
      songBeat = 0;
      arrangeCursor = 0;
      lastBeatAt = ctx.currentTime;
    }

    // ── SONG MODE v2 — PRINT (record) + PLAYBACK (authoritative) ──

    /** Re-anchor SONG playback at the top: reset the clock + scheduler cursor,
     *  silence every lane and drop any lingering session clip (clips do NOT
     *  launch live in SONG mode). Called on entering SONG mode / play-from-top. */
    function resetSongMode(): void {
      resetSongOrigin();
      songSchedCursor = 0;
      for (let L = 0; L < LANES; L++) {
        silenceLane(L, ctx.currentTime);
        // Param-jump policy (SONG entry seam): a lane playing a SESSION clip with
        // sibling automation must HOLD-LAST-VALUE before its clip is dropped —
        // else the assigned params ride a stale ~200 ms ramp then freeze at an
        // arbitrary phase. Immediate seam (cancel + pin at now); runs BEFORE
        // `active` flips, matching the transport-stop / dispose guards.
        holdLaneAutomation(L, lanes[L].active, null, null);
        lanes[L].active = null; // song time drives the printed channels, not clips
        // An AUDIO-clip lane entering SONG mode stops its source like every
        // other path that drops `active` (leaving is the peer-adopt path,
        // which restarts through updateLaneAudio).
        haltLaneAudio(L, ctx.currentTime, true);
      }
    }

    /** COMMIT the buffered print for each lane into `song.notes[lane]` (per-lane
     *  key writes; non-undoable — the write-storm guard commits once per bar / on
     *  punch-out, never per tick). Commits WHATEVER is buffered: only the single
     *  recorder client ever fills `songNoteBuf` (the capture path gates on
     *  isSongRecorder), so a non-recorder's buffer is always empty → this is a
     *  no-op for them. Safe to call on disarm/stop/dispose where the CURRENT
     *  armed/recorder flags have already cleared.
     *
     *  PRINTED == SOUNDED: the record tee captures each step at SCHEDULE time,
     *  stamping it at its FUTURE sound-beat (up to ~LOOKAHEAD_S ahead of the
     *  current `songBeat`). Only onsets that have ALREADY sounded (`beat <=
     *  songBeat`) are committed here; the in-flight lookahead tail (`beat >
     *  songBeat`) is RETAINED in the buffer for the next commit — EXCEPT when
     *  `dropUnsounded` (a hard transport STOP / dispose), where `silenceLane`
     *  cancels that same lookahead audio, so the un-sounded tail is DROPPED and
     *  never printed (no phantom notes). */
    function flushSongNotes(dropUnsounded = false): void {
      let any = false;
      for (const b of songNoteBuf) if (b.length) { any = true; break; }
      if (!any) return;
      const soundedThrough = songBeat; // only onsets at/before now have SOUNDED
      const tx =
        typeof (ydoc as { transact?: unknown }).transact === 'function'
          ? (fn: () => void) => ydoc.transact(fn, SONG_COMMIT_ORIGIN)
          : (fn: () => void) => fn();
      tx(() => {
        writeData((d) => {
          ensureSongContainers(d); // defensive (the load seam already created them)
          const s = d.song as SongData;
          for (let L = 0; L < LANES; L++) {
            const buf = songNoteBuf[L]!;
            if (!buf.length) continue;
            // Partition at the sounded watermark: commit what SOUNDED, retain the
            // un-sounded lookahead tail (or drop it on a hard stop/teardown).
            const sounded: SongNoteEvent[] = [];
            const tail: SongNoteEvent[] = [];
            for (const e of buf) (e.beat <= soundedThrough ? sounded : tail).push(e);
            if (sounded.length) {
              const existing = songNoteChannel(s, L)?.events ?? [];
              // CAP surface: mergeSongNotes silently drops the newest past the
              // ceiling — flag it (client-local) so the card can warn.
              if (existing.length + sounded.length > MAX_SONG_NOTE_EVENTS) songCapHit = true;
              // PER-LANE key write (disjoint from other lanes + the clip maps).
              s.notes![String(L)] = { events: mergeSongNotes(existing, sounded) };
            }
            buf.length = 0;
            if (!dropUnsounded && tail.length) buf.push(...tail); // retain the lookahead
          }
        });
      });
    }

    /** SONG PLAYBACK — schedule the printed note channels straight out the 8 lane
     *  outputs, sample-accurate with the same LOOKAHEAD_S discipline the clip
     *  scheduler uses. Absolute song-beats are mapped to the loop PHASE
     *  (beat mod length) so a looping song plays forever; a one-shot song stops
     *  scheduling past its length. Clips never launch (authoritative). */
    function scheduleSongPlayback(nowAt: number): void {
      const song = (liveData()?.song ?? undefined) as SongData | undefined;
      const secPerBeat = 60 / transportBpm();
      if (secPerBeat <= 0) return;
      const octave = readParam('octave', 0);
      const len = songLengthBeats(song, 4);
      if (len <= 0) return;
      const loop = song?.loop !== false;
      const lookaheadBeats = LOOKAHEAD_S / secPerBeat;
      const target = songBeat + lookaheadBeats;
      let from = songSchedCursor;
      if (from < songBeat) from = songBeat; // never re-fire the past on (re)entry
      const to = Math.min(target, loop ? Infinity : len);
      while (from < to) {
        const loopStart = loop ? Math.floor(from / len) * len : 0;
        const segEnd = Math.min(to, loopStart + len);
        const phaseFrom = from - loopStart;
        const phaseTo = segEnd - loopStart;
        for (let L = 0; L < LANES; L++) {
          const ch = songNoteChannel(song, L);
          if (!ch) continue;
          const evs = songNotesInRange(ch, phaseFrom, phaseTo);
          // Group consecutive equal-beat onsets into a poly CHORD.
          let i = 0;
          while (i < evs.length) {
            let j = i + 1;
            while (j < evs.length && evs[j]!.beat === evs[i]!.beat) j++;
            const chord = evs.slice(i, j);
            const at = nowAt + (loopStart + chord[0]!.beat - songBeat) * secPerBeat;
            emitSongChord(L, chord, Math.max(nowAt, at), secPerBeat, octave);
            i = j;
          }
        }
        from = segEnd;
        if (!loop) break;
      }
      songSchedCursor = to;
    }

    /** Emit one printed CHORD (co-onset notes) out lane L's outputs at `at`. Gate
     *  width = the captured sounding length (`lengthBeats`, already gate-shaped at
     *  print time); OCT is applied live at the output. */
    function emitSongChord(
      L: number,
      chord: SongNoteEvent[],
      at: number,
      secPerBeat: number,
      octave: number,
    ): void {
      const ln = lanes[L];
      if (laneMuted(liveData(), L)) return; // muted lane advances silently
      const voiced = chord
        .slice(0, POLY_CHANNEL_PAIRS)
        .map((n) => ({ pitch: midiToVOct(n.midi) + octave, gate: 1 as 0 | 1 }));
      if (voiced.length === 0) return;
      let maxLen = 0;
      let vel = 0;
      for (const n of chord) {
        if ((n.lengthBeats ?? 0) > maxLen) maxLen = n.lengthBeats ?? 0;
        const v = (n.velocity ?? DEFAULT_VELOCITY) / 127;
        if (v > vel) vel = v;
      }
      const gateOff = Math.max(0.001, maxLen * secPerBeat);
      // Same sparse, allocated write as the session path — an ARRANGEMENT has
      // the identical overlap shape (a pad printed under a moving line is two
      // chords at different beats), so the positional re-pack would collapse it
      // the same way. See `assignPolyLanes`.
      for (const wv of assignPolyLanes(ln.playBook, chord, at, gateOff)) {
        const v = ln.poly.voices[wv.lane]!;
        v.pitchSrc.offset.setValueAtTime(wv.pitch + octave, wv.onAt);
        v.gateSrc.offset.setValueAtTime(1, wv.onAt);
        v.gateSrc.offset.setValueAtTime(0, wv.offAt);
      }
      ln.gateSrc.offset.setValueAtTime(1, at);
      ln.gateSrc.offset.setValueAtTime(0, at + gateOff);
      ln.velSrc.offset.setValueAtTime(vel, at);
      ln.lastVOct = voiced[0]?.pitch ?? ln.lastVOct;
      ln.lastGate = 1;
      ln.lastVel = vel;
    }

    // --- TIMELORDE transport (the rack clock we lock to) ---
    function timelorde() {
      for (const n of Object.values(livePatch.nodes)) {
        if (n && (n as { type?: string }).type === 'timelorde') return n;
      }
      return undefined;
    }
    function transportRunning(): boolean {
      const t = timelorde();
      if (!t) return true; // no TIMELORDE in rack → free-run
      const v = (t.params as Record<string, number> | undefined)?.running;
      return typeof v === 'number' ? v >= 0.5 : true;
    }
    function transportBpm(): number {
      const t = timelorde();
      const v = (t?.params as Record<string, number> | undefined)?.bpm;
      return typeof v === 'number' && v > 0 ? v : 120;
    }
    /** True when TIMELORDE is slaved to an external clock (its clock/start/stop
     *  inputs are patched) — the card hides transport in that case. */
    function transportExternallyClocked(): boolean {
      const t = timelorde();
      if (!t) return false;
      const edges = Object.values(livePatch.edges);
      return (
        isInputPortConnected(edges, t.id, 'clock') ||
        isInputPortConnected(edges, t.id, 'start_in') ||
        isInputPortConnected(edges, t.id, 'stop_in')
      );
    }

    function ensureArray<T>(v: unknown, fill: T): T[] {
      const out = new Array<T>(LANES).fill(fill);
      if (Array.isArray(v)) for (let i = 0; i < LANES; i++) if (i < v.length) out[i] = v[i] as T;
      return out;
    }

    function silenceLane(L: number, at: number): void {
      const ln = lanes[L];
      ln.gateSrc.offset.cancelScheduledValues(at);
      ln.gateSrc.offset.setValueAtTime(0, at);
      ln.velSrc.offset.cancelScheduledValues(at);
      ln.velSrc.offset.setValueAtTime(0, at);
      ln.poly.silence(at);
      // ⚠ AND THE PLAYBACK BOOK, unlike the audition allocator one line down.
      // The two differ because their ownership means different things: the KEYS
      // allocator still owns lanes for keys a human is physically holding, while
      // `poly.silence` has just cancelled every SCHEDULED gate — so no clip
      // voice is sounding any more and a book that still claimed lanes would
      // steal from itself and refuse the next chord its own free lanes.
      resetPolyLaneBook(ln.playBook);
      // A panic/stop zeroes the poly voices in hardware but KEEPS the audition
      // allocator's ownership (the KEYS keys are still physically held). Clear the
      // written-state mirror so the next audition drain RE-OPENS every still-held
      // voice (matches the pre-Phase-2a rebuild-everything recovery).
      ln.laneKey.fill(null);
      ln.lastGate = 0;
      ln.lastVel = 0;
    }

    /** Switch lane L's active slot. `switchAt` names the QUANTIZED loop-boundary
     *  time when the switch was applied at a wrap (the scheduling loop passes
     *  `nextStart`); null = an immediate switch at "now". Runs the automation
     *  hold-last-value seam FIRST — before the incoming clip is scheduled — so a
     *  stop/switch away from an automating clip pins its params without wiping
     *  the incoming clip's freshly-scheduled events (the same-tick ordering fix). */
    function setLaneActive(L: number, slot: number | null, switchAt: number | null = null): void {
      const ln = lanes[L];
      holdLaneAutomation(L, ln.active, slot, switchAt);
      ln.active = slot;
      ln.stepIndex = 0;
      ln.loopCount = 0; // fresh clip launch/switch → play-every counts from 0
      ln.autoStarted = false; // re-entry → next step-0 glides (clip-switch seam)
      // A FUTURE `switchAt` anchors the lane's grid AT that boundary (the wrap
      // path always overrode nextStepTime to the same value right after; the
      // scene-repeat boundary floor passes it for an IDLE target lane so the
      // lane STARTS on the section boundary, on-grid, instead of at an
      // arbitrary now+0.01). A past/absent switchAt keeps the immediate start.
      ln.nextStepTime =
        switchAt !== null && switchAt > ctx.currentTime ? switchAt : ctx.currentTime + 0.01;
      // SCENE REPEATS: pin the tracked scene's start to the ACTUAL audible
      // switch boundary of its (frozen) anchor lane — `switchAt` names the
      // quantized boundary (possibly in the lookahead future), so the beat
      // pin is boundary-accurate, not tick-quantized.
      if (
        repTrack &&
        !repTrack.started &&
        L === repTrack.anchorLane &&
        slot === repTrack.slot
      ) {
        const secPerBeat = 60 / transportBpm();
        repTrack.started = true;
        repTrack.startBeat =
          repBeatClock +
          (switchAt !== null && secPerBeat > 0 ? Math.max(0, switchAt - ctx.currentTime) / secPerBeat : 0);
      }
      writeData((d) => {
        const playing = ensureArray<number | null>(d.playing, null);
        playing[L] = slot;
        d.playing = playing;
      });
      // AUDIO CLIP hook — the launch/stop/switch lands at the SAME instant the
      // grid re-anchors on (`ln.nextStepTime` above), so the buffer source and
      // the step machinery agree about where loop frame 0 is.
      updateLaneAudio(L, slot, ln.nextStepTime);
      if (slot === null) silenceLane(L, ctx.currentTime);
    }

    /**
     * RESET — snap every ACTIVE lane back to step 1 (index 0) at a COMMON
     * re-anchor instant. Everything already scheduled ahead in the lookahead is
     * cancelled (clean falling edges — the re-emitted step 0 re-attacks ~10 ms
     * later, a deliberate re-strike, same invariant as an audition steal).
     * Because every lane gets the SAME nextStepTime, the per-lane clock rates
     * (clip-clock.ts) restart their counting from one shared phase origin: a
     * 1/2 lane advances on even base steps from here, a 2x lane re-lands on the
     * base grid every second advance. NOT touched: `queued` (a queued launch
     * still applies at its lane's next loop boundary), stopped lanes, and the
     * arrangement's song position (this is a clip-step reset, not a rewind).
     */
    function resetActiveLanes(): void {
      const at = ctx.currentTime;
      for (let L = 0; L < LANES; L++) {
        const ln = lanes[L];
        if (ln.active === null) continue;
        // silenceLane cancels gate/vel + zeroes the poly gates; ALSO cancel the
        // pending poly pitch writes so a cancelled step's pitch can't land
        // under the freshly re-attacked step-0 gate.
        silenceLane(L, at);
        for (const v of ln.poly.voices) v.pitchSrc.offset.cancelScheduledValues(at);
        ln.stepIndex = 0;
        ln.loopCount = 0; // RST re-anchors the shared origin → play-every restarts (all peers together)
        ln.autoStarted = false; // re-anchor → next step-0 glides (clip-switch seam)
        ln.nextStepTime = at + 0.01; // SAME instant for every lane → common origin
        // Drop the now-cancelled future entries so the playhead can't show them.
        ln.sched = ln.sched.filter((e) => e.t <= at);
      }
      // AUDIO CLIPS re-anchor with everything else: restart from loop frame 0
      // on the same shared origin instant.
      restartActiveLaneAudio(at + 0.01);
    }

    /**
     * STALE-NOTE RECONCILE (redesign §3.1) — a clip mutation on the PLAYING clip
     * of lane L just REMOVED the onsets on `erasedSteps`, so cut the erased
     * note's in-flight audio NOW and re-emit from the FRESH clip. Without this, a
     * note the user just erased keeps sounding for the whole lookahead (or, in
     * the old replace path, a full loop).
     *
     * Two cases, both PHASE-PRESERVING:
     *  - A future onset was already scheduled in the lookahead (`upIdx >= 0`):
     *    cancel from the next un-elapsed step time `upT` forward (the CURRENT
     *    step's gate-off is < upT, so a KEPT note keeps gating — N1) and re-emit
     *    the upcoming steps at their ORIGINAL times from the fresh clip (the
     *    erased onset simply schedules no gate; kept onsets re-land identically).
     *  - Nothing is scheduled ahead in the ring (`upIdx < 0`, e.g. a coarse-div
     *    lane whose next step is beyond the horizon): the pending
     *    `nextStepTime`/`stepIndex` ALREADY hold the correct next step at its
     *    original grid time (T + laneDur), so DON'T touch them (B1 — overwriting
     *    to now+0.01 re-struck `cur` and drifted the lane off-grid forever). Only
     *    reset when the lane genuinely never emitted (`cur < 0`).
     *
     * The currently-SOUNDING voice is force-cut ONLY when the audible step `cur`
     * is one of `erasedSteps` (an undefined/empty `erasedSteps` cuts it, for
     * safety): a purely-future erase must not truncate the note you're hearing.
     * No-op on a stopped lane.
     */
    function reconcileLane(L: number, erasedSteps?: number[]): void {
      const ln = lanes[L];
      if (ln.active === null) return;
      const at = ctx.currentTime;
      const cur = laneDisplayStep(L);
      // The NEXT un-elapsed scheduled step + its time — re-emitting from here
      // (not "now") preserves the grid phase across the recut.
      let upT = Infinity;
      let upIdx = -1;
      for (const e of ln.sched) {
        if (e.t > at && e.t < upT) {
          upT = e.t;
          upIdx = e.idx;
        }
      }
      // Cut the currently-sounding voice ONLY when the audible step lost an
      // onset (else a still-gating KEPT note would be truncated — N1).
      const cutNow = !erasedSteps || erasedSteps.length === 0 || (cur >= 0 && erasedSteps.includes(cur));
      if (upIdx >= 0) {
        // Cancel the in-lookahead future (from `upT` on) so an already-scheduled
        // ERASED onset can't fire; the current step's gate-off (< upT) survives,
        // so a kept note keeps gating. Then re-emit the upcoming steps at their
        // ORIGINAL grid times from the fresh clip.
        ln.gateSrc.offset.cancelScheduledValues(upT);
        ln.velSrc.offset.cancelScheduledValues(upT);
        for (const v of ln.poly.voices) {
          v.gateSrc.offset.cancelScheduledValues(upT);
          v.pitchSrc.offset.cancelScheduledValues(upT);
        }
        ln.nextStepTime = upT;
        ln.stepIndex = upIdx;
        ln.autoStarted = false;
      } else if (cur < 0) {
        // The lane genuinely never emitted — resume from scratch.
        ln.nextStepTime = at + 0.01;
        ln.stepIndex = 0;
        ln.autoStarted = false;
      }
      // else (upIdx < 0 && cur >= 0): the pending nextStepTime/stepIndex already
      // hold the correct next step at its original grid time — LEAVE THEM (B1).
      if (cutNow) {
        // Force the erased/sounding voice silent NOW (clean falling edges); a
        // KEPT chord-mate on the same step shares this step's gate, so an erase
        // of the audible step cuts the whole step (mono gate is shared — the
        // documented limit; per-pitch cut across a shared step isn't possible).
        silenceLane(L, at);
        for (const v of ln.poly.voices) v.pitchSrc.offset.cancelScheduledValues(at);
      }
      // Drop now-cancelled future entries so the visual playhead can't show them.
      ln.sched = ln.sched.filter((e) => e.t <= at);
    }

    /** Apply lane L's queued launch/stop (consuming it). Returns true if the
     *  active clip changed. `switchAt` = the loop-boundary time when applied at a
     *  wrap (threaded to the automation hold seam); null = immediate. */
    function applyLaneQueued(L: number, switchAt: number | null = null): boolean {
      const d = liveData();
      const q = d?.queued?.[L];
      if (q === undefined || q === null) return false;
      // Was this an IMMEDIATE apply (arrange-record flag)? The caller passes
      // switchAt=null for an immediate launch (QNT off / a per-lane NOW override
      // / nothing playing) and a boundary TIME for a quantized drop-in — so
      // `switchAt === null` is exactly "immediate". (An idle lane is NO LONGER
      // "always immediate": with a live reference groove it quantizes to the
      // longest playing clip's boundary, so `active === null` no longer implies
      // immediacy.)
      const wasImmediate = switchAt === null;
      writeData((dd) => {
        const queued = ensureArray<number | 'stop' | null>(dd.queued, null);
        queued[L] = null;
        dd.queued = queued;
        if (Array.isArray(dd.queuedImmediate)) {
          const qi = ensureArray<boolean>(dd.queuedImmediate, false);
          qi[L] = false;
          dd.queuedImmediate = qi;
        }
      });
      let changed = false;
      if (q === 'stop') {
        if (lanes[L].active !== null) {
          setLaneActive(L, null, switchAt);
          changed = true;
        }
      } else {
        const slot = Number(q);
        if (slot !== lanes[L].active) {
          setLaneActive(L, slot, switchAt);
          changed = true;
        }
      }
      // RECORD: capture the applied launch at the current song-beat (session
      // mode only — arrangement playback drives the lanes itself).
      if (changed && isRecording() && clipMode() === 'session') {
        const slot: ArrangeSlot = q === 'stop' ? 'stop' : Number(q);
        appendArrangeEvent({ beat: songBeat, lane: L, slot, immediate: wasImmediate });
      }
      return changed;
    }

    // Emit lane L's step + RETURN the notes that fired (won their probability
    // dice-roll) — the SAME survivors the caller feeds to the song-print buffer,
    // so the printed take equals what sounded (decision 3). Returns [] when the
    // lane emitted nothing (muted / live-audition / no note clip / empty step).
    // The roll runs HERE (once per lane-step, live Math.random) and only feeds
    // scheduled Web Audio params — NEVER written back to the Y.Doc (transient;
    // the CV-modulation write-storm lesson).
    function emitLaneStep(L: number, idx: number, atTime: number, stepDur: number): NoteEvent[] {
      const ln = lanes[L];
      if (ln.active === null) return [];
      // MUTE — the lane KEEPS advancing (push the step so laneDisplayStep + the
      // launchpad record-capture still track it, staying locked to the transport)
      // but emits NO audio. The falling edge was already scheduled when mute
      // engaged (the tick-loop edge-scan), so nothing needs to sound here.
      if (laneMuted(liveData(), L)) {
        ln.sched.push({ t: atTime, idx });
        if (ln.sched.length > 32) ln.sched.shift();
        return [];
      }
      // LIVE AUDITION owns the lane while KEYS keys are held: advance the visual
      // playhead (push to sched so the launchpad record capture still sees the
      // step move) but DON'T write the poly/gate/vel — otherwise the scheduled
      // clip playback would stomp the held keyboard note's gate open→shut. When
      // no keys are held, playback resumes normally.
      if (ln.alloc.activeCount() > 0) {
        ln.sched.push({ t: atTime, idx });
        if (ln.sched.length > 32) ln.sched.shift();
        return [];
      }
      const clip = readClip(liveData(), clipIndex(ln.active, L));
      // NOTE clips emit steps. An AUDIO clip deliberately emits NOTHING here:
      // it is not a step sequence, it is one buffer scheduled once at launch
      // and looped by the source node, so a per-step emit would be a second,
      // drifting opinion about when it sounds. This `[]` is the right answer
      // for it, not a not-yet-implemented one.
      if (!clip || clip.kind !== 'note') return [];
      // Roll the per-note probability dice ONCE for this lane-step; the survivors
      // drive BOTH the audio scheduling below AND the print buffer (via the
      // return value). A chord partially fires (per-note roll). PLAY EVERY gates
      // FIRST (deterministic from the lane's loop count → collab-safe), so a note
      // whose turn it isn't this loop is skipped before the dice — and, being
      // absent from the firing set, is neither sounded NOR printed (printed ==
      // sounded).
      const rolled = notesFiringAt(clip, idx, Math.random, ln.loopCount);
      // PITCH PROBABILITY — the survivors then draw their PITCH from a weighted
      // candidate distribution ($lib/audio/pitch-probability). Orthogonal to the
      // roll above: that decided WHETHER each note fires, this decides WHAT
      // PITCH it fires at. A no-op (same array reference, zero allocation) for
      // every note without instability, so an untouched clip is bit-identical.
      //
      // ⚠ DETERMINISTIC, unlike the firing roll one line up. The draw is seeded
      // from (nodeId, lane, slot, step, authored midi, loopCount) — all values
      // every peer already agrees on — so collaborators hear the SAME melody.
      // An unseeded Math.random() here would give each peer different NOTES, and
      // single-user testing cannot see that. It rides the SAME `ln.loopCount`
      // PLAY EVERY does, so it inherits exactly that control's convergence
      // guarantee (peers agree from the next launch onward) and no less.
      const firing = applyPitchProbability(rolled, {
        root: clip.root,
        scale: clip.scale,
        nodeId,
        lane: L,
        slot: ln.active,
        step: idx,
        loopCount: ln.loopCount,
      }) as NoteEvent[];
      const r = lanesFromFiring(firing);
      const octave = readParam('octave', 0);
      const gateFrac = readParam('gateLength', 0.9);
      // A held/tied note (lengthSteps > 1) keeps its gate HIGH the whole span
      // (legato) — the "hold a pad + tap another" gesture. A single-step note
      // uses the GATE duty cycle so it can be shortened/staccato.
      const span = r.gateSteps * stepDur;
      const gateOff =
        r.gateSteps > 1 ? Math.max(0.001, span - 0.002) : Math.max(0.001, span * gateFrac);
      const voiced = r.lanes.map((v) => ({ pitch: v.pitch + octave, gate: v.gate }));
      // Gate-sampled Sample & Hold (ONE global toggle for all 8 lanes, default
      // ON). On an EMPTY step (a rest) with S&H ON nothing is written at all, so
      // each lane's pitch CV HOLDS its last value (no external S&H needed). With
      // S&H OFF an empty step rewrites pitch=0 on the lanes that are actually
      // FREE (legacy continuous behavior, minus the part that was a bug).
      const snh = readParam('snh', 1) >= 0.5;
      // ⚠ SPARSE, PER-VOICE WRITES — never `poly.scheduleStep`, which writes ALL
      // POLY_CHANNEL_PAIRS lanes (`lanes[i] ?? { pitch: 0, gate: 0 }`) and so
      // closes every voice this step did not itself fill. Combined with the
      // positional re-pack in `lanesFromFiring`, that is the owner-reported
      // "poly lane to a poly synth isn't playing polyphony": a note starting
      // while another is held landed on the HELD note's lane, rewriting its
      // pitch under a gate that never fell, so an edge-tracking consumer
      // (MIDI-OUT-BUDDY) emitted no second Note On and went on sounding the
      // first pitch. `assignPolyLanes` gives each note a lane of its own for its
      // whole life and returns ONLY the lanes to touch. See its header for the
      // measurement.
      const writes = assignPolyLanes(ln.playBook, firing, atTime, gateOff);
      for (const wv of writes) {
        const v = ln.poly.voices[wv.lane]!;
        v.pitchSrc.offset.setValueAtTime(wv.pitch + octave, wv.onAt);
        v.gateSrc.offset.setValueAtTime(1, wv.onAt);
        v.gateSrc.offset.setValueAtTime(0, wv.offAt);
      }
      if (!r.any && !snh) {
        // A rest with S&H OFF zeroes the pitch of the lanes that hold nothing.
        // ⚠ NEVER a busy lane: rewriting a sounding voice's pitch is the other
        // half of the same defect.
        for (const lane of freePolyLanesAt(ln.playBook, atTime)) {
          ln.poly.voices[lane]!.pitchSrc.offset.setValueAtTime(0, atTime);
        }
      }
      ln.sched.push({ t: atTime, idx });
      if (ln.sched.length > 32) ln.sched.shift();
      if (r.any) {
        ln.gateSrc.offset.setValueAtTime(1, atTime);
        ln.gateSrc.offset.setValueAtTime(0, atTime + gateOff);
        ln.velSrc.offset.setValueAtTime(r.velocity, atTime);
        ln.lastVOct = voiced[0]?.pitch ?? 0;
        ln.lastGate = 1;
        ln.lastVel = r.velocity;
      } else {
        // Empty step: gate goes low. With S&H ON, ln.lastVOct is left at the
        // HELD value (we didn't rewrite pitch); with S&H OFF pitch was rewritten
        // to 0, so mirror that.
        if (!snh) ln.lastVOct = voiced[0]?.pitch ?? 0;
        ln.lastGate = 0;
      }
      return firing; // the notes that SOUNDED — fed to the print buffer
    }

    /**
     * LIVE AUDITION drain (KEYS keyboard). Applies every queued note on/off to
     * each lane's STABLE voice allocator, then reconciles the resulting ownership
     * map into the MINIMUM set of clean gate/pitch edges at `now` so a keypress
     * SOUNDS immediately. A held note keeps its OWN voice-lane for its whole life
     * (Phase 2a, gate/held-note plan §3.2): releasing a low note frees ONLY its
     * lane; the other voices are NOT re-written (the old positional repack shifted
     * them down a lane, rewriting pitch on a still-sounding voice → glitch). The
     * mono gate is high while ANY note is held. Called BEFORE the transport
     * `running` gate, so keys play with the transport stopped. A no-op when
     * nothing was queued (held gates stay high — we never re-write on an empty
     * drain).
     */
    function serviceAudition(): void {
      const events = drainAudition(nodeId);
      if (events.length === 0) return;
      const now = ctx.currentTime;
      const octave = readParam('octave', 0);
      const touched = new Set<number>();
      // Whether a lane was IDLE (no held audition voice) before this drain — the
      // first press on an idle lane must cancel any clip-playback still scheduled
      // in the lookahead so the held keys take over immediately.
      const wasEmpty = new Map<number, boolean>();
      for (const ev of events) {
        const L = ev.lane;
        if (L < 0 || L >= LANES) continue;
        const ln = lanes[L];
        if (!wasEmpty.has(L)) wasEmpty.set(L, ln.alloc.activeCount() === 0);
        if (ev.on) {
          ln.alloc.noteOn(ev.midi);
          ln.audVel = Math.max(0, Math.min(1, ev.velocity / 127));
        } else {
          // noteOff frees ONLY this note's lane (or is a no-op when its lane was
          // already stolen / it's unknown — release-after-steal, §3.2). Ownership
          // is reconciled below from the allocator, so the return value is unused.
          ln.alloc.noteOff(ev.midi);
        }
        touched.add(L);
      }
      for (const L of touched) {
        const ln = lanes[L];
        // First press on an idle lane: cancel clip-playback events still scheduled
        // ahead (~LOOKAHEAD_S) so they don't fire and cut off the held note. While
        // ANY key is held emitLaneStep goes SILENT, so nothing re-accumulates.
        if (wasEmpty.get(L) && ln.alloc.activeCount() > 0) {
          for (const v of ln.poly.voices) {
            v.pitchSrc.offset.cancelScheduledValues(now);
            v.gateSrc.offset.cancelScheduledValues(now);
          }
          ln.gateSrc.offset.cancelScheduledValues(now);
          ln.velSrc.offset.cancelScheduledValues(now);
        }
        // Reconcile per-voice ownership → minimal clean 0/1 edges. A voice whose
        // owner is UNCHANGED is skipped entirely (held voices are never touched).
        for (let i = 0; i < POLY_CHANNEL_PAIRS; i++) {
          const desired = ln.alloc.ownerOf(i); // MIDI note owning this voice, or null
          const current = ln.laneKey[i]; // what audition last WROTE to this voice
          if (desired === current) continue; // held / still-free — leave it alone
          const v = ln.poly.voices[i]!;
          if (desired === null) {
            // Freed voice — clean falling edge; pitch holds (gate=0 silences it).
            v.gateSrc.offset.setValueAtTime(0, now);
          } else if (current === null) {
            // New note on a previously-free voice — single clean rising edge.
            v.pitchSrc.offset.setValueAtTime(midiToVOct(desired) + octave, now);
            v.gateSrc.offset.setValueAtTime(1, now);
          } else {
            // Owner CHANGED (LRU-steal, or a freed lane re-taken this drain) →
            // fall→rise so the downstream envelope re-attacks at the new pitch;
            // never a silent pitch swap under a held gate (§3.2 invariant).
            v.gateSrc.offset.setValueAtTime(0, now);
            v.pitchSrc.offset.setValueAtTime(midiToVOct(desired) + octave, now + AUDITION_STEAL_GAP_S);
            v.gateSrc.offset.setValueAtTime(1, now + AUDITION_STEAL_GAP_S);
          }
          ln.laneKey[i] = desired;
        }
        // Mono gate + velocity (single CV outs; poly→mono is an OR-sum so the mono
        // gate is high while ANY voice is held). Re-affirming gate=1 while already
        // high adds no falling edge, so a downstream envelope does not re-attack.
        const anyOn = ln.alloc.activeCount() > 0;
        ln.gateSrc.offset.setValueAtTime(anyOn ? 1 : 0, now);
        ln.velSrc.offset.setValueAtTime(anyOn ? ln.audVel : 0, now);
        ln.lastGate = anyOn ? 1 : 0;
        if (anyOn) {
          ln.lastVel = ln.audVel;
          // Mono pitch display/pull mirrors the LOWEST occupied voice-lane.
          for (let i = 0; i < POLY_CHANNEL_PAIRS; i++) {
            const owner = ln.alloc.ownerOf(i);
            if (owner !== null) {
              ln.lastVOct = midiToVOct(owner) + octave;
              break;
            }
          }
        }
      }
    }

    /** The AUDIBLE fractional-step playhead of lane L (integer display step +
     *  the fraction elapsed into it, from the audio-time schedule). Feeds the
     *  automation recorder its quantized punch playhead. Returns -1 when stopped
     *  or nothing has sounded yet. `laneDur` is the lane's current step length. */
    function laneFracStep(L: number, laneDur: number): number {
      const ln = lanes[L];
      if (ln.active === null) return -1;
      let best = -1;
      let bestT = -Infinity;
      for (const e of ln.sched) {
        if (e.t <= ctx.currentTime && e.t > bestT) {
          bestT = e.t;
          best = e.idx;
        }
      }
      if (best < 0) return -1;
      const frac = laneDur > 0 ? Math.max(0, Math.min(1, (ctx.currentTime - bestT) / laneDur)) : 0;
      return best + frac;
    }

    function tick(): void {
      if (!alive) return;
      try {
        const running = transportRunning();
        const d0 = liveData();
        const mode: ClipPlayMode =
          d0?.clipMode === 'arrangement' || d0?.clipMode === 'song' ? d0.clipMode : 'session';
        const recording = d0?.recording === true;
        // SONG-REC (arranger v2): armed + THIS client is the single-writer.
        const songRecArmed = songArmed(d0);
        const iAmSongRecorder = isSongRecorder(d0, ydoc.clientID);

        // SONG-MODE origin resets (before advancing songBeat this tick):
        //  - record ARM (replace): clear the log + restart song time at 0.
        //  - record ARM (overdub): KEEP the log + song time so new launches
        //    merge into the existing timeline at their true current beat
        //    (recordEvent inserts them in beat-sorted order — §3.1).
        //  - entering arrangement mode OR pressing play in it: replay from top.
        if (recording && !prevRecording) {
          if (recordMode() === 'replace') {
            writeData((d) => {
              d.arrangement = clearArrange(coerceArrangeData(d.arrangement));
            });
            resetSongOrigin();
          }
          // overdub: keep the existing log; song time keeps running so merged
          // launches record at their true current beat.
        }
        if (mode === 'arrangement' && (prevClipMode !== 'arrangement' || (running && !prevRunning))) {
          resetSongOrigin();
        }
        prevRecording = recording;

        // SONG-REC arm edge (the recorder client only): REPLACE clears the print
        // + restarts song time at bar 1; OVERDUB keeps both (new onsets merge by
        // beat). Buffers + the commit cadence reset either way.
        if (songRecArmed && !prevSongArmed && iAmSongRecorder) {
          if (songRecMode(d0) === 'replace') {
            writeData((d) => {
              ensureSongContainers(d);
              d.song!.notes = {};
              d.song!.auto = {};
              if (d.song!.arrangerAuto) d.song!.arrangerAuto.tracks = {};
            });
            resetSongOrigin();
          }
          for (const b of songNoteBuf) b.length = 0;
          songCapHit = false; // fresh take → no cap warning yet
          songCommitAtBeat = songBeat + SONG_COMMIT_BEATS;
        }
        // SONG-REC disarm edge → punch out: commit the in-flight partial print.
        // (No recorder gate: the current `songRec`/recorder flags have already
        // cleared on disarm; flushSongNotes commits whatever THIS client buffered
        // and is a no-op for peers, whose buffers stay empty.)
        if (!songRecArmed && prevSongArmed) flushSongNotes();
        prevSongArmed = songRecArmed;

        // SONG PLAYBACK origin: entering SONG mode OR pressing play in it replays
        // from the top (silences lanes + drops lingering session clips). Leaving
        // SONG mode is AUTHORITATIVE — silence the lookahead tail; the session
        // adopt path below restores the live playing-set.
        if (mode === 'song' && (prevClipMode !== 'song' || (running && !prevRunning))) {
          resetSongMode();
        } else if (prevClipMode === 'song' && mode !== 'song') {
          for (let L = 0; L < LANES; L++) {
            silenceLane(L, ctx.currentTime);
            // Param-jump guard (SONG leave seam), matching the entry/stop/dispose
            // seams. A no-op while song playback drove the outputs directly (lanes
            // hold no `active` clip in SONG mode), but correct + defensive should
            // a future path leave a lane active on the way out.
            holdLaneAutomation(L, lanes[L].active, null, null);
          }
          songSchedCursor = 0;
        }
        prevClipMode = mode;

        if (running && !prevRunning) {
          // Transport started → align all lanes to step 0 on the downbeat.
          for (let L = 0; L < LANES; L++) {
            lanes[L].stepIndex = 0;
            lanes[L].loopCount = 0; // transport (re)start → play-every counts from 0
            lanes[L].autoStarted = false; // fresh start → step-0 glides
            lanes[L].nextStepTime = ctx.currentTime + 0.01;
          }
          // SCENE REPEATS: a transport restart re-anchors every lane to step 0,
          // so the LIVE countdown resets with it (runtime-only state — the SET
          // counts in data.sceneRepeats are untouched). started=false re-pins
          // startBeat at the restart boundary via the tracker maintenance below.
          if (repTrack) repTrack.started = false;
          // AUDIO CLIPS restart from loop frame 0 on the shared origin.
          restartActiveLaneAudio(ctx.currentTime + 0.01);
        } else if (!running && prevRunning) {
          // SONG-REC: a transport stop punches out the in-flight print. DROP the
          // un-sounded lookahead tail (`beat > songBeat`) — silenceLane below
          // cancels that same scheduled audio, so committing it would print notes
          // that never sounded (printed == sounded).
          flushSongNotes(true);
          // SCENE REPEATS: a stale ctx-time boundary floor must not gate the
          // queue after a stop/start cycle re-anchors everything.
          advanceFloorUntil = null;
          for (let L = 0; L < LANES; L++) {
            silenceLane(L, ctx.currentTime);
            // AUDIO CLIPS stop with the transport. Forgotten (not suspended):
            // the transport-start edge above re-launches active audio lanes
            // from loop frame 0 on the shared origin, like every other lane.
            haltLaneAudio(L, ctx.currentTime, true);
            // Transport stopped → hold-last-value on EVERY lane playing an
            // automation clip (an immediate seam — cancel + pin at now). Lanes
            // keep their `active` slot (they resume on transport start).
            holdLaneAutomation(L, lanes[L].active, null, null);
            // PUNCH OUT armed lanes' in-flight record passes at the stop
            // instant (the same partial-commit path a lane stop uses) — a
            // frozen pass must not sit uncommitted in controller memory until
            // restart/disarm/dispose, where a restart's playhead reset would
            // read as a spurious wrap. Cheap no-op for lanes with no record
            // state.
            controller.laneStopped(L);
          }
        }
        prevRunning = running;

        // Song-position clock: advance by real elapsed beats while running.
        // repBeatClock rides the same advance but is NEVER reset (the scene-
        // repeat countdown counts pure musical time — pauses with the transport,
        // rescales with tempo).
        const nowAt = ctx.currentTime;
        const beatAdvance = running ? Math.max(0, nowAt - lastBeatAt) / (60 / transportBpm()) : 0;
        songBeat += beatAdvance;
        repBeatClock += beatAdvance;
        lastBeatAt = nowAt;

        // SONG PRINT is captured in SESSION (you perform under the SONG-REC arm);
        // the recorder commits its buffer once per bar (write-storm guard).
        const songRecActive = songRecArmed && iAmSongRecorder && mode === 'session' && running;
        // Per-lane NOTE-record enable for this take (coerce ONCE per tick, not
        // per captured step). Default (no explicit map) = every channel enabled.
        const songNoteEnabledBuf: boolean[] = new Array(LANES).fill(false);
        if (songRecActive) {
          const rs = coerceSongRecState(d0?.songRec);
          for (let L = 0; L < LANES; L++) {
            songNoteEnabledBuf[L] = rs?.noteEnable ? rs.noteEnable[String(L)] === true : true;
          }
        }
        if (songRecActive && songBeat >= songCommitAtBeat) {
          flushSongNotes();
          songCommitAtBeat = songBeat + SONG_COMMIT_BEATS;
        }

        // stop_all — stop every lane immediately (panic; both modes).
        if (stopCounter.poll(ctx.currentTime) > 0) {
          for (let L = 0; L < LANES; L++) if (lanes[L].active !== null) setLaneActive(L, null);
        }

        // reset — CV rising edge (local) or the synced card-button nonce: snap
        // every ACTIVE lane to step 1 + re-anchor the shared rate phase origin.
        // Both modes; the counter/nonce are drained even when nothing is active.
        const resetEdges = resetCounter.poll(ctx.currentTime);
        const nonce = typeof d0?.resetNonce === 'number' ? d0.resetNonce : 0;
        const nonceFired = lastResetNonce !== null && nonce !== lastResetNonce;
        lastResetNonce = nonce;
        if (resetEdges > 0 || nonceFired) resetActiveLanes();

        // MUTE edge-scan — the instant a lane becomes muted, silence its buses at
        // currentTime (don't wait for its next scheduled step). emitLaneStep then
        // keeps the muted lane's playhead advancing but writes no further audio;
        // unmuting simply resumes emitting on the next step. An AUDIO lane's
        // source is SUSPENDED (its phase origin kept) so unmuting resumes
        // phase-locked, mirroring how a muted note lane's playhead keeps
        // advancing.
        for (let L = 0; L < LANES; L++) {
          const m = laneMuted(d0, L);
          if (m && !prevMuted[L] && lanes[L].active !== null) {
            silenceLane(L, ctx.currentTime);
            haltLaneAudio(L, ctx.currentTime, false);
          } else if (!m && prevMuted[L] && lanes[L].active !== null && running) {
            if (laneAudio[L]) {
              resumeLaneAudio(L);
            } else {
              // Launched while muted — nothing was suspended. Start now,
              // phase-locked to the lane's own grid position.
              const clip = readClip(d0, clipIndex(lanes[L].active!, L));
              if (clip?.kind === 'audio') {
                const base = 60 / transportBpm() / (STEP_DIV_SPB[readParam('stepDiv', 2)] ?? 4);
                const laneDur = laneStepDur(base, lanes[L].divIndex);
                const frac = laneFracStep(L, laneDur);
                const origin =
                  frac >= 0 ? ctx.currentTime - frac * laneDur : ctx.currentTime + 0.01;
                startLaneAudio(L, clip, origin);
              }
            }
          }
          prevMuted[L] = m;
        }

        // AUDIO CLIP normal upkeep — the lane→mixer return, re-derived from the
        // live edge set (a patched cable breaks it; unpatching restores it).
        syncLaneReturns();

        // ── SCENE REPEATS: tracker maintenance (runs BEFORE any launch applies
        // this tick, so a launch applied below pins against the fresh tracker).
        // The synced `sceneLaunch` marker is the resetNonce-style re-anchor:
        // EVERY whole-scene launch (any surface, any peer, incl. our own
        // auto-advance) bumps it → tracking re-anchors to that scene with a
        // FRESH count (manual always wins; re-launching the SAME scene resets).
        // First tick adopts without firing (a loaded patch never replays).
        {
          const sl = readSceneLaunch(d0);
          if (lastSceneLaunch === null) {
            lastSceneLaunch = sl ?? { slot: -1, n: 0 };
          } else if (sl && (sl.n !== lastSceneLaunch.n || sl.slot !== lastSceneLaunch.slot)) {
            // Compare the WHOLE {slot, n} pair: two peers launching DIFFERENT
            // scenes concurrently both write n = prev+1, and the LWW loser
            // would never see an n change — the slot compare still re-anchors
            // it to the winning launch instead of a spurious cancel.
            lastSceneLaunch = { slot: sl.slot, n: sl.n };
            // A marker we did not just write ourselves = a (possibly manual)
            // launch → any pending auto-advance boundary floor is void
            // (manual always wins; our own advance write re-sets it below).
            advanceFloorUntil = null;
            // TRANSITION GRACE from the ACTUAL synced playing state — never
            // just the prior tracker's slot: a launch made while NO tracker is
            // live (after an individual-clip cancel, an all-stopped cancel, or
            // a reload adopt) must not read its own still-playing pre-launch
            // lanes as deviations on the next tick.
            repTrack = anchorSceneRepeatTrack(d0, sl.slot, stepsPerBeat(), d0?.playing);
          }
          if (mode !== 'session') {
            repTrack = null; // arrangement playback drives the lanes itself
            advanceFloorUntil = null;
          } else if (repTrack) {
            // DELIBERATE, DETERMINISTIC CANCEL (never Deluge's silent voiding):
            //  - an individual clip launched OUTSIDE the scene cancels tracking
            //    (queued/playing deviation — synced state, so every peer agrees);
            //  - every scene lane stopped (per-lane stops / stop-all, incl.
            //    PENDING stops) cancels — a silent rack must never
            //    surprise-launch the next scene later;
            //  - per-lane STOPs of SOME lanes and MUTEs are NOT deviations
            //    (mute never voids the count — muted lanes keep advancing).
            if (
              sceneRepeatDeviates(repTrack, d0?.queued, d0?.playing) ||
              sceneAllLanesStopped(repTrack, d0?.queued, d0?.playing)
            ) {
              repTrack = null;
              advanceFloorUntil = null; // manual interference — never delay the manual queue
            } else {
              // Transition drain: grace slots nothing plays/queues any more
              // become foreign again (a later manual launch INTO them cancels).
              drainScenePrevSlots(repTrack, d0?.queued, d0?.playing);
              // Start-pin fallback for the peer-adopt path (setLaneActive pins
              // the local-apply path boundary-accurately).
              if (!repTrack.started && lanes[repTrack.anchorLane].active === repTrack.slot) {
                repTrack.started = true;
                repTrack.startBeat = repBeatClock;
              }
            }
          }
          // Floor expiry: once the boundary is comfortably past, every wrap is
          // ≥ it anyway — drop the guard so it can never gate anything stale.
          if (advanceFloorUntil !== null && ctx.currentTime > advanceFloorUntil + 1) {
            advanceFloorUntil = null;
          }
        }

        const quantize = readParam('quantize', 1) >= 0.5;

        // LAUNCH QUANTIZATION (Deluge model): a queued launch snaps to the next
        // loop boundary of the LONGEST currently-playing clip — the shared
        // reference bar. Computed ONCE per tick from the SYNCED clip lengths +
        // each lane's own audio phase; the emit loop below reuses it to floor a
        // playing lane's own-wrap switch to the same boundary. null = nothing is
        // playing (→ launches fire immediately) / not running / QNT off.
        let launchBoundary: number | null = null;

        if (mode === 'session') {
          // Adopt peer-driven playing changes (synced playing-set).
          for (let L = 0; L < LANES; L++) {
            const synced = d0?.playing?.[L] ?? null;
            const sv = typeof synced === 'number' ? synced : null;
            const hasQueued = (d0?.queued?.[L] ?? null) !== null;
            if (sv !== lanes[L].active && !hasQueued) {
              // Peer-driven switch/stop = an IMMEDIATE seam: hold the outgoing
              // automation clip's params (cancel at now) BEFORE adopting.
              holdLaneAutomation(L, lanes[L].active, sv, null);
              lanes[L].active = sv;
              lanes[L].stepIndex = 0;
              lanes[L].loopCount = 0; // peer-adopted switch → play-every counts from 0 (peers converge)
              lanes[L].autoStarted = false; // re-entry → next step-0 glides
              lanes[L].nextStepTime = ctx.currentTime + 0.01;
              // AUDIO CLIP hook — peer-driven switches take the same path a
              // local immediate switch does.
              updateLaneAudio(L, sv, lanes[L].nextStepTime);
              if (sv === null) silenceLane(L, ctx.currentTime);
            }
          }
          // The shared boundary from the LONGEST currently-playing clip. Only
          // meaningful while RUNNING with QNT on and something to launch; when
          // stopped or nothing plays there is no reference groove (→ immediate).
          const hasPendingLaunch =
            Array.isArray(d0?.queued) &&
            d0.queued.some((q) => q !== null && q !== undefined);
          if (running && quantize && hasPendingLaunch) {
            const baseStepDur =
              60 / transportBpm() / (STEP_DIV_SPB[readParam('stepDiv', 2)] ?? 4);
            launchBoundary = nextLaunchBoundary(
              collectPlayingClocks(d0, baseStepDur),
              ctx.currentTime,
            );
          }
          // Apply each lane's queued launch/stop. Three IMMEDIACY escapes stay
          // immediate (fire NOW, no boundary): QNT off, a per-lane NOW override,
          // or NOTHING playing anywhere (launchBoundary null — no reference bar,
          // so start the groove now). Otherwise it QUANTIZES:
          //   · an IDLE target lane STARTS exactly ON the shared boundary (once
          //     it's within the scheduling window; until then it stays QUEUED so
          //     the pad flashes and arrange-record captures the audible beat);
          //   · a lane ALREADY playing keeps looping — the scheduling loop below
          //     applies its switch at its first own-wrap AT/after the boundary
          //     (the `floored` gate), so short clips don't flip early.
          // A SCENE auto-advance (advanceFloorUntil set) keeps its own frozen
          // section boundary — it takes precedence over the manual boundary.
          for (let L = 0; L < LANES; L++) {
            const q = d0?.queued?.[L];
            if (q === undefined || q === null) continue; // nothing queued here
            const nowOverride = d0?.queuedImmediate?.[L] === true;
            if (!quantize || nowOverride || launchBoundary === null) {
              applyLaneQueued(L, null); // immediate (unquantized)
              continue;
            }
            if (lanes[L].active === null) {
              // IDLE lane. A queued STOP here is a NO-OP (nothing to stop) —
              // consume it immediately; only a real LAUNCH defers to the
              // boundary (a scene launch stops the empty lanes; those must not
              // linger queued — the concurrent-advance no-op invariant).
              if (q === 'stop') {
                applyLaneQueued(L, null);
                continue;
              }
              // Idle LAUNCH → start ON the boundary once it's near.
              if (advanceFloorUntil !== null && advanceFloorUntil > ctx.currentTime) {
                // SCENE auto-advance section boundary (set only when near) —
                // unchanged behaviour, on-grid idle start.
                applyLaneQueued(L, advanceFloorUntil);
              } else if (
                launchBoundary > ctx.currentTime &&
                launchBoundary <= ctx.currentTime + LOOKAHEAD_S + 0.05
              ) {
                applyLaneQueued(L, launchBoundary);
              }
              // else: leave queued — a later tick applies it as the boundary nears.
            }
            // A playing lane is handled at its wrap in the scheduling loop below.
          }
        } else if (mode === 'arrangement' && running) {
          // ARRANGEMENT playback (legacy launch-log): fire the recorded log as
          // song-time advances. The timestamps already encode the timing, so
          // launch directly.
          const arr = coerceArrangeData(d0?.arrangement);
          const len = arrangeLengthBeats(arr, 4);
          let from = arrangeCursor;
          if (arr.loop && len > 0 && songBeat >= len) {
            for (const ev of eventsInRange(arr, from, len)) applyArrangeEvent(ev);
            songBeat -= len; // wrap song time to the top
            from = 0;
          }
          for (const ev of eventsInRange(arr, from, songBeat)) applyArrangeEvent(ev);
          arrangeCursor = songBeat;
        } else if (mode === 'song' && running) {
          // SONG playback (authoritative): song time drives the PRINTED note
          // channels straight out the 8 lane outputs. Clips do NOT launch live;
          // the main clip-emit loop below no-ops because every ln.active is null
          // (reset on entering SONG mode).
          scheduleSongPlayback(nowAt);
        }

        // Publish each lane's audio-time playhead (render state — NOT synced;
        // the card editor + grid LEDs read it to draw the moving playhead).
        for (let L = 0; L < LANES; L++) setLanePlayhead(nodeId, L, laneDisplayStep(L));

        // LIVE AUDITION (KEYS keyboard) — drained BEFORE the transport gate so
        // the keys sound even with the transport STOPPED.
        serviceAudition();

        // STALE-NOTE RECONCILE (redesign §3.1) — an erase / note-removal on a
        // PLAYING clip published a reconcile; cut the lane's in-flight audio NOW
        // and re-emit from the fresh clip so the erased note stops immediately.
        // Drained before the transport gate so an erase lands even when stopped.
        for (const ev of drainReconcile(nodeId)) {
          if (ev.lane >= 0 && ev.lane < LANES) reconcileLane(ev.lane, ev.steps);
        }

        // AUTOMATION ARM reconcile (PER-LANE single-writer): mirror each lane's
        // synced arm flag onto the controller — but ONLY on that lane's
        // designated recorder client (isLaneAutomationRecorder). Non-recorder
        // peers never arm a lane, so they never record it; they still PLAY the
        // automation (playbackStep above) — and DIFFERENT peers may record
        // DIFFERENT lanes concurrently. Runs every tick, even stopped, so an
        // arm/disarm toggle is honored immediately (disarm commits that lane's
        // in-flight PARTIAL pass; other lanes keep recording).
        for (let L = 0; L < LANES; L++) {
          const wantRecord = isLaneAutomationRecorder(d0, L, ydoc.clientID);
          const haveRecord = controller.laneArmed(L);
          if (wantRecord && !haveRecord) controller.armLane(L);
          else if (!wantRecord && haveRecord) controller.disarmLane(L);
        }

        if (!running) {
          clearAutomationRender(nodeId); // no countdown while stopped
          // No capture phase while stopped — the KEYS recorder falls back to the
          // audible step (a stale phase self-invalidates, but clear it so the
          // launchpad never projects against a frozen anchor).
          for (let L = 0; L < LANES; L++) setLanePhase(nodeId, L, null);
          return;
        }

        // Base grid from TIMELORDE bpm + the global STEP param; each lane then
        // scales it by its own clock rate (clip-clock.ts — 1/8..4x, default 1).
        const stepDur = 60 / transportBpm() / (STEP_DIV_SPB[readParam('stepDiv', 2)] ?? 4);

        // ── SCENE REPEATS: the auto-advance decision. When the FROZEN boundary
        // (startBeat + N×unitBeats) falls inside this tick's scheduling window,
        // queue the next content scene NOW — before the per-lane loop below —
        // so every lane's wrap processing at/after that boundary sees it and
        // applies it through the NORMAL quantized launch path (arranger-record
        // captures it, LEDs update, peers adopt — identical to a hand-pressed
        // scene button; for equal-length clips the switch lands sample-accurate
        // on the section boundary). N is read fresh from the synced count each
        // evaluation (a mid-count edit latches to the next boundary; lowering N
        // below the elapsed count advances at the next boundary — never
        // retroactively). The write is deterministic from synced state, so a
        // concurrent peer writes IDENTICAL content (idempotent/convergent — a
        // duplicate application is a no-op in applyLaneQueued) and the marker
        // bump re-anchors every peer's count, exactly like a manual launch.
        if (repTrack && mode === 'session') {
          const nRepeats = sceneRepeatCount(d0, repTrack.slot);
          const secPerBeat = 60 / transportBpm();
          // The window must cover: the audio lookahead + a couple of scheduler
          // ticks of slack + ONE anchor step — the scheduling loop below
          // processes a wrap when the pass's LAST step enters the lookahead
          // (one step-duration before the boundary), and the queued write must
          // land before that so the anchor lane applies it AT the boundary.
          const lookaheadBeats =
            (secPerBeat > 0 ? (LOOKAHEAD_S + 0.05) / secPerBeat : 0) + repTrack.stepBeats;
          if (sceneRepeatShouldAdvance(repTrack, nRepeats, repBeatClock, lookaheadBeats)) {
            // NO one-shot latch anywhere here: when no content scene exists
            // below (the last content scene keeps looping — deliberate
            // divergence from Deluge's stop-at-end), the decision simply
            // re-evaluates next tick, so RAISING N (boundary moves out) or
            // ADDING a content scene below later re-arms the advance instead
            // of dying on a missed moment.
            const target = nextContentScene(d0, repTrack.slot);
            if (target !== null) {
              // The frozen boundary in ctx time — the LOCAL boundary floor for
              // the deliberately-early write (idle target lanes start ON it;
              // short-loop outgoing lanes can't flip before it).
              const floorAt =
                ctx.currentTime +
                Math.max(
                  0,
                  repTrack.startBeat + nRepeats * repTrack.unitBeats - repBeatClock,
                ) *
                  secPerBeat;
              let wrote = false;
              writeData((d) => {
                wrote = applySceneLaunchWrite(d, target, false);
              });
              if (wrote) {
                advanceFloorUntil = floorAt;
                // Re-anchor locally right away (peers re-anchor from the marker
                // we just bumped; mirroring the {slot,n} pair keeps this peer
                // from re-firing on its own write next tick). Grace comes from
                // the live playing set, like every other anchor.
                lastSceneLaunch = readSceneLaunch(liveData()) ?? lastSceneLaunch;
                repTrack = anchorSceneRepeatTrack(
                  liveData(),
                  target,
                  stepsPerBeat(),
                  liveData()?.playing,
                );
              }
            }
          }
        }

        // Each lane's active clip snapshot from THIS tick's scheduling pass —
        // the record/countdown block below reuses it (no re-read/re-coerce).
        const laneClips: (ClipRecord | null)[] = new Array<ClipRecord | null>(LANES).fill(null);

        // SINGLE-DRIVER ownership for this tick (cross-lane rule): a targetKey
        // carried by several lanes' clips is driven by exactly ONE of them —
        // the assigned lane when it carries it, else the lowest active carrier.
        // Recomputed once per tick from the cached key sets (cheap).
        const autoOwners = computeAutoOwners(d0);

        // STALE-NOTE FIX (redesign §3.3): the ACTIVE note-record lane schedules
        // on the SHRUNK lookahead so an erase/edit can't be out-run by audio
        // committed a full ~200 ms ago. Read once per tick from the synced
        // record state.
        const recRec = readNoteRec(d0);
        const recLane = recRec?.recording ? recRec.lane : -1;

        for (let L = 0; L < LANES; L++) {
          const ln = lanes[L];
          if (ln.active === null) {
            ln.nextStepTime = ctx.currentTime + 0.05;
            continue;
          }
          const laneLookahead = L === recLane ? RECORD_LOOKAHEAD_S : LOOKAHEAD_S;
          const swing = laneSwing(d0, L);
          // PERF: read the active clip ONCE per lane, NOT per step. coerceClipRecord
          // deep-clones a (dense) clip; doing it every step in this lookahead loop
          // made the fast-clock scheduler fall behind and STALL lanes (the "saw -1"
          // playback regression). The div-latch, loop length, and the sibling
          // automation drive all reuse this snapshot; it's re-read only when a
          // queued launch swaps ln.active mid-loop (below). The sibling `auto[k]`
          // tracks come from the coerce-ONCE cached view (autoTracksAt).
          let activeClip = readClip(d0, clipIndex(ln.active, L));
          let laneAuto = activeClip?.kind === 'note' ? autoTracksAt(clipIndex(ln.active, L)) : EMPTY_TRACKS;
          while (ln.nextStepTime < ctx.currentTime + laneLookahead) {
            // DIV LATCH: at each loop start (step 0) re-read the active clip's
            // effective divider (clip.div OVERRIDES the lane rate[]; else fall
            // back to it). Held for the whole loop, so a mid-loop edit only
            // takes effect at the NEXT clip start. (NOTE clips carry `div`;
            // audio/snapshot shells fall back to the lane rate via null.)
            if (ln.stepIndex === 0 && ln.active !== null) {
              ln.divIndex = clipDivIndex(activeClip?.kind === 'note' ? activeClip : null, d0, L);
            }
            const laneDur = laneStepDur(stepDur, ln.divIndex);
            // Loop length from the CACHED clip, KIND-AGNOSTICALLY (a note clip
            // loops over its own lengthSteps — its sibling automation is LINKED
            // to the same length; an audio clip loops over the length its take
            // was recorded to; a kind with no length reads 1).
            const len = clipLengthSteps(activeClip);
            // SWING: even steps sit on the un-swung grid, odd steps push late by
            // swing*laneDur. Swing 0 ⇒ offset 0 ⇒ the emitted times are the base
            // grid (byte-identical to the un-swung schedule). The grid recurrence
            // (nextStepTime += laneDur) is unchanged so pairs stay beat-locked.
            const emitAt = ln.nextStepTime + swingStepOffset(ln.stepIndex, swing, laneDur);
            // The notes that FIRED this lane-step (won their probability roll) —
            // emitLaneStep rolled the dice ONCE and scheduled exactly these; we
            // print the SAME survivors so the printed take == what sounded
            // (decision 3). BAKE realized hits: a probabilistic note that lost
            // its roll this pass is neither sounded nor printed.
            const firedNotes = emitLaneStep(L, ln.stepIndex, emitAt, laneDur);
            // SONG PRINT TEE — capture the FIRED notes (what SOUNDED: post
            // rate/div/swing/mono/S&H/probability) at their absolute song-beat,
            // on the recorder client only, into the per-lane buffer (committed at
            // the bar cadence above). Mirrors emitLaneStep's audible guards
            // (muted / live-audition lanes emit nothing → capture nothing) and
            // its gate math (held vs staccato) so the printed gate width == what
            // sounded. OCT is NOT baked (a live output transform, re-applied at
            // playback).
            if (
              songRecActive &&
              songNoteEnabledBuf[L] &&
              !laneMuted(d0, L) &&
              ln.alloc.activeCount() === 0 &&
              activeClip?.kind === 'note'
            ) {
              const starting = firedNotes.slice(0, POLY_CHANNEL_PAIRS);
              if (starting.length) {
                const secPerBeatCap = 60 / transportBpm();
                if (secPerBeatCap > 0) {
                  const beatAtEmit = Math.max(0, songBeat + (emitAt - ctx.currentTime) / secPerBeatCap);
                  let gateSteps = 1;
                  for (const ev of starting) gateSteps = Math.max(gateSteps, ev.lengthSteps ?? 1);
                  const spanS = gateSteps * laneDur;
                  const gateOffS =
                    gateSteps > 1
                      ? Math.max(0.001, spanS - 0.002)
                      : Math.max(0.001, laneDur * readParam('gateLength', 0.9));
                  const lengthBeats = gateOffS / secPerBeatCap;
                  const buf = songNoteBuf[L]!;
                  for (const ev of starting) {
                    buf.push({
                      beat: beatAtEmit,
                      midi: ev.midi,
                      velocity: ev.velocity ?? DEFAULT_VELOCITY,
                      lengthBeats,
                    });
                  }
                }
              }
            }
            // PER-CLIP AUTOMATION: a playing NOTE clip emits its notes AND
            // drives its sibling `auto[k]` tracks' params transiently (zero
            // Yjs) through the SAME per-lane step schedule — sample-accurate +
            // time-aligned to the notes, same emitAt/laneDur, LINKED length.
            if (laneAuto.length) {
              // DE-ZIPPER the step-0 seam (param-jump policy). Any step 0 is a
              // discontinuity: the FIRST after (re)activation is a CLIP-SWITCH INTO
              // this clip; a later one is a LOOP-WRAP. Both glide the anchor.
              const isSeam = ln.stepIndex === 0;
              if (isSeam && !ln.autoStarted) {
                // Clip-switch INTO: anchor each param at emitAt so the first-step
                // glide is a clean short ramp from where the param currently sits,
                // not a stale-ramp near-jump (its last event may be an old pin far
                // in the past — a linearRamp would back-interpolate from there).
                // engine.holdParam with a FUTURE atTime and no toValue PINS the
                // cached intrinsic (the held resting value after a stop; the
                // outgoing envelope's landing value at a boundary switch) with a
                // REAL setValueAtTime event at emitAt — identical on Chromium and
                // the Firefox fallback, and it NEVER cancels (a future cancel
                // would retro-delete the outgoing clip's final in-flight ramp).
                // Wrap seams need no anchor — the previous loop's last ramp
                // already lands exactly at emitAt. Only OWNED, un-grabbed params
                // are anchored (a shadowed lane must not stomp the owner; a hand
                // must not be fought — the same gates playbackStep applies).
                const engine = getActiveEngine();
                if (engine) {
                  for (const track of laneAuto) {
                    if (autoOwners.get(automationTargetKey(track.target)) !== L) continue;
                    if (controller.isSuspended(track.target)) continue; // a hand owns it
                    const node = targetNode(track.target);
                    if (node) engine.holdParam(node, track.target.paramId, emitAt);
                  }
                }
              }
              const seam = isSeam ? SEAM_GLIDE_S : 0;
              for (const track of laneAuto) {
                // SINGLE DRIVER: only the owning lane drives this key this tick.
                if (autoOwners.get(automationTargetKey(track.target)) !== L) continue;
                controller.playbackStep(track, ln.stepIndex, laneDur, emitAt, seam);
              }
              ln.autoStarted = true;
            }
            const nextIdx = (ln.stepIndex + 1) % len;
            const nextStart = ln.nextStepTime + laneDur;
            if (nextIdx === 0) {
              totalLoops++;
              ln.loopCount++; // a full loop of THIS clip completed → play-every counter
              // Boundary-apply queued launches — SESSION mode only (arrangement
              // is driven by the cursor above, not the manual queue). Pass the
              // boundary time so the automation hold seam pins AT the boundary
              // (not a cancel at "now" that would truncate the outgoing tail
              // ~200 ms early — the param-jump ordering fix). BOUNDARY FLOOR:
              // skip wraps clearly BEFORE the applicable boundary so this lane
              // keeps looping until it. WHICH boundary depends on the queued
              // action:
              //  · a LAUNCH/SWITCH (a slot number) → the shared boundary — the
              //    SCENE auto-advance frozen section boundary (advanceFloorUntil)
              //    when pending, else the manual Deluge launch boundary (the
              //    LONGEST playing clip's wrap) — so mixed-length clips lock to
              //    the reference bar and short clips don't flip early;
              //  · a STOP → the LANE'S OWN next wrap (NOT launchBoundary): a clip
              //    stops at the end of ITS OWN loop, never held audible for the
              //    longest OTHER lane's boundary. A SCENE stop of an empty lane
              //    still honours advanceFloorUntil (the section boundary).
              // The 25 ms epsilon (one tick) lets the boundary wrap through
              // despite beat↔ctx float drift.
              const isStopQueued = d0?.queued?.[L] === 'stop';
              const wrapFloor = isStopQueued ? advanceFloorUntil : (advanceFloorUntil ?? launchBoundary);
              const floored = wrapFloor !== null && nextStart < wrapFloor - 0.025;
              if (mode === 'session' && quantize && !floored && applyLaneQueued(L, nextStart)) {
                ln.nextStepTime = nextStart;
                // The launch swapped ln.active → refresh the cached clip + its
                // sibling automation view (or null them on a queued STOP so the
                // next iteration breaks cleanly).
                activeClip = ln.active !== null ? readClip(d0, clipIndex(ln.active, L)) : null;
                laneAuto =
                  activeClip?.kind === 'note' && ln.active !== null
                    ? autoTracksAt(clipIndex(ln.active, L))
                    : EMPTY_TRACKS;
                continue;
              }
              if (ln.active === null) break;
            }
            ln.nextStepTime = nextStart;
            ln.stepIndex = nextIdx;
          }
          laneClips[L] = ln.active !== null ? activeClip : null;
        }

        // AUDIO CLIP stale-take reconcile: the take a lane is sounding must be
        // the take its slot still HOLDS. An undo, a CLEAR, or a re-record
        // replaces/removes the record (keyed by mediaId+takeAt), and a source
        // still looping the old bytes would be audio without a clip — cut it.
        // A REPLACED take (same slot, new key) restarts from its own top.
        for (let L = 0; L < LANES; L++) {
          const st = laneAudio[L];
          if (!st) continue;
          const clip = laneClips[L];
          if (clip?.kind === 'audio' && clipAudioCacheKey(clip) === st.key) continue;
          haltLaneAudio(L, ctx.currentTime, true);
          if (clip?.kind === 'audio' && running && !laneMuted(d0, L)) {
            startLaneAudio(L, clip, ctx.currentTime + 0.01);
          }
        }

        // CAPTURE PHASE (redesign §4.1) — publish each lane's audio-clock phase
        // so the KEYS recorder can project a pad event's own timestamp onto the
        // NEAREST step (clip-lane-phase.ts / clip-record-capture.ts), instead of
        // flooring onto the 25 ms-stale audible integer step. Both `ctxTime` and
        // `perfNow` are sampled at the SAME instant so the launchpad recovers the
        // ctx↔perf offset. A stopped/silent lane publishes null (fall back to the
        // audible step). Cheap (no clone) — reuses this tick's stepDur + latched
        // divIndex + the snapshot clip length.
        {
          const perfNow = typeof performance !== 'undefined' ? performance.now() : 0;
          for (let L = 0; L < LANES; L++) {
            const ln = lanes[L];
            const clip = laneClips[L];
            // KIND-AGNOSTIC. Publish the phase for ANY playing clip that has a
            // length, not just a note one: the audio clip recorder needs this
            // lane's live phase to resolve a punch-in against the same wrap the
            // grid is showing, and re-deriving it there would be a second
            // opinion about where the playhead is. A STOPPED lane still
            // publishes null (fall back to the audible step).
            if (ln.active === null || !clip) {
              setLanePhase(nodeId, L, null);
              continue;
            }
            const a = laneAnchor(L);
            setLanePhase(nodeId, L, {
              anchorStep: a.step,
              anchorTime: a.step >= 0 ? a.time : -Infinity,
              laneDur: laneStepDur(stepDur, ln.divIndex),
              lengthSteps: clipLengthSteps(clip),
              ctxTime: ctx.currentTime,
              perfNow,
            });
          }
        }

        // PER-LANE AUTOMATION RECORD + COUNTDOWN + DISPLAY. For EACH lane with a
        // PLAYING note clip (the snapshot from the scheduling pass above):
        //  - DISPLAY (every client): visual-smooth the sibling `auto[k]` tracks'
        //    on-screen knobs with the interpolated envelope value each tick.
        //  - RECORD (per-lane arm, per-lane single-writer): feed the controller
        //    THAT lane's audible fractional playhead — each ARMED lane runs its
        //    own continuous overdub (punch-in at ITS clip's wrap, commit each
        //    wrap into the LATCHED clip, keep going) until ITS disarm. A lane
        //    records any control under a LIVE GRAB on a MODULE assigned to it
        //    (data.autoAssign, module→lane): screen / MIDI / Electra hands, and
        //    a cv-bridge whose source stream is ACTIVE (the record-CV-automation
        //    model — an IDLE/parked source fires no grab and records nothing);
        //    a lane with assigned modules but no playing clip records nothing
        //    (punched out below).
        //  - COUNTDOWN (EVERY client for each SYNCED-armed lane): publish one
        //    entry per recording lane, each with beats to ITS clip's OWN wrap,
        //    so each lane's pad/cell flashes 🟡🟡🔴🔴 on its own boundary.
        //    Clip-relative: coprime lengths drift by design; never the song bar.
        const modulesByLane = laneAssignedModules(d0);
        const laneRenders: AutomationLaneRender[] = [];
        const secPerBeat = 60 / transportBpm();
        for (let L = 0; L < LANES; L++) {
          const ln = lanes[L];
          const clip = laneClips[L];
          const armedHere = controller.laneArmed(L); // this client records L
          const armedSyncLane = laneAutomationArmed(d0, L); // any peer armed L
          const playingNote = ln.active !== null && clip?.kind === 'note';
          if (!playingNote) {
            // A lane that stopped (or switched to a non-note clip) while armed
            // punches OUT: its in-flight partial pass commits to the LATCHED
            // clip now (cheap no-op when the lane holds no record state).
            if (armedHere) controller.laneStopped(L);
            continue;
          }
          const laneDur = laneStepDur(stepDur, ln.divIndex);
          const frac = laneFracStep(L, laneDur);
          if (frac < 0) continue;
          const clipIdx = clipIndex(ln.active!, L);
          const len = Math.max(1, clip.lengthSteps); // automation length LINKED to the note clip
          const fracClamped = Math.min(frac, len);
          // VISUAL SMOOTHING (P3): refresh each PLAYING-BACK track's on-screen
          // knob with the CURRENT interpolated envelope value every tick
          // (~40fps) — display-only (no audio), so a slow envelope's knob follows
          // smoothly instead of snapping once per step. CPU-bounded to the
          // clip's tracks (≤16); skips touched tracks (their live value shows)
          // and tracks another lane OWNS (single driver — display mirrors audio).
          const tracks = autoTracksAt(clipIdx).filter(
            (t) => autoOwners.get(automationTargetKey(t.target)) === L,
          );
          if (tracks.length) {
            const engine = getActiveEngine();
            if (engine) {
              for (const { target, value } of controller.displayValues(tracks, fracClamped)) {
                const node = targetNode(target);
                const def = resolveTarget(target)?.def;
                if (node && def) {
                  engine.setDisplayParam(
                    node,
                    target.paramId,
                    fracToValue(value, def.min, def.max, def.curve),
                  );
                }
              }
            }
          }
          const assignedModules = modulesByLane[L]!;
          if (assignedModules.length === 0) {
            if (armedHere) controller.laneStopped(L); // nothing to record here
            continue;
          }
          if (armedHere) {
            controller.recordLaneTick(L, clipIdx, new Set(assignedModules), fracClamped, len);
          }
          if (armedSyncLane) {
            const beatsToLoopEnd = secPerBeat > 0 ? ((len - fracClamped) * laneDur) / secPerBeat : 0;
            laneRenders.push({
              lane: L,
              slot: ln.active!,
              recording: true,
              beatsToLoopEnd,
              beatPhase: beatsToLoopEnd - Math.floor(beatsToLoopEnd),
            });
          }
        }
        // (The automation stop/switch hold-last-value seam runs INSIDE
        // setLaneActive / the peer-adopt / the transport-stop paths — BEFORE any
        // incoming clip is scheduled — never here after the scheduling loop,
        // where a cancel-at-now would wipe freshly-scheduled incoming events.)
        setAutomationRender(nodeId, laneRenders.length ? { lanes: laneRenders } : null);
      } catch (err) {
        console.error('[clipplayer] tick error', err);
      }
    }

    unsubscribeTick = getSchedulerClock().subscribe(tick);

    const outputs = new Map<string, { node: AudioNode; output: number }>();
    for (let L = 0; L < LANES; L++) {
      outputs.set(`pitch${L + 1}`, { node: lanes[L].poly.output, output: 0 });
      outputs.set(`gate${L + 1}`, { node: lanes[L].gateSrc, output: 0 });
      outputs.set(`vel${L + 1}`, { node: lanes[L].velSrc, output: 0 });
      outputs.set(`audio${L + 1}L`, { node: audioOut[L]!.l, output: 0 });
      outputs.set(`audio${L + 1}R`, { node: audioOut[L]!.r, output: 0 });
    }

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number }>([
        ['stop_all', { node: stopGain, input: 0 }],
        ['reset', { node: resetGain, input: 0 }],
      ]),
      outputs,
      setParam() {
        /* tick reads node.params live each iteration */
      },
      readParam(paramId) {
        const v = livePatch.nodes[nodeId]?.params?.[paramId];
        return typeof v === 'number' ? v : undefined;
      },
      read(key) {
        if (key === 'totalLoops') return totalLoops;
        if (key === 'transportRunning') return transportRunning() ? 1 : 0;
        // THE RECORDER'S CLOCK — everything the clip-record registry needs to
        // resolve a take window, computed by the SAME code a launch uses so
        // the recorder and the launcher cannot disagree about the shared bar:
        //   running     — the transport gate (arm auto-starts it when false);
        //   baseStepDur — the global STEP grid in seconds (bpm + stepDiv);
        //   boundary    — `nextLaunchBoundary` over the live playing clocks
        //                 (ctx seconds), null when nothing plays / stopped;
        //   refSeconds  — the reference bar's loop length in seconds (the
        //                 longest playing clip), null when nothing plays.
        if (key === 'recClock') {
          const d = liveData();
          const running = transportRunning();
          const baseStepDur = 60 / transportBpm() / (STEP_DIV_SPB[readParam('stepDiv', 2)] ?? 4);
          const clocks = collectPlayingClocks(d, baseStepDur);
          let refSeconds: number | null = null;
          for (const c of clocks) {
            const s = c.lenSteps * c.laneStepDur;
            if (refSeconds === null || s > refSeconds) refSeconds = s;
          }
          return {
            running,
            baseStepDur,
            boundary: running ? nextLaunchBoundary(clocks, ctx.currentTime) : null,
            refSeconds,
          };
        }
        if (key === 'externallyClocked') return transportExternallyClocked() ? 1 : 0;
        // SONG MODE: the card reads these to drive the RECORD/mode UI + readout.
        if (key === 'songBeat') return songBeat;
        if (key === 'clipMode') return clipMode() === 'arrangement' ? 1 : 0;
        if (key === 'recording') return isRecording() ? 1 : 0;
        if (key === 'recordMode') return recordMode() === 'overdub' ? 1 : 0;
        if (key === 'arrangeEvents') return coerceArrangeData(liveData()?.arrangement).events.length;
        // SONG MODE v2 (arranger v2): the card reads these for the compact SONG
        // readout + the SES/SONG + SONG-REC controls.
        if (key === 'songMode') return clipMode() === 'song' ? 1 : 0;
        if (key === 'songArmed') return songArmed(liveData()) ? 1 : 0;
        if (key === 'songRecMode') return songRecMode(liveData()) === 'overdub' ? 1 : 0;
        if (key === 'songNoteCount') return songNoteCount(liveData()?.song as SongData | undefined);
        // CAP-HIT surface (client-local, CONSUME-AND-CLEAR — mirrors the
        // automation controller's capHit via consumeTrackCapHitFor): returns 1
        // once when a print commit truncated a lane's note channel at
        // MAX_SONG_NOTE_EVENTS, then clears, so the card flashes a brief warning.
        if (key === 'songCapHit') {
          const hit = songCapHit;
          songCapHit = false;
          return hit ? 1 : 0;
        }
        if (key === 'songLengthBeats') return songLengthBeats(liveData()?.song as SongData | undefined, 4);
        if (key === 'songHasContent') return songHasContent(liveData()?.song as SongData | undefined) ? 1 : 0;
        // SCENE REPEATS live countdown (runtime-only render reads — never
        // synced): the COUNTING tracked scene's slot (-1 = none), its completed
        // passes, and its CURRENT synced count. The card's flair polls these to
        // show "p/N" while counting. FLAIR HONESTY: `slot` reports only while a
        // countdown is genuinely in progress (finite N, done < N) — on the LAST
        // content scene the boundary passes with no target and done grows past
        // N, and a perpetual "N/N counting" display would promise an advance
        // that isn't scheduled; reverting to -1 lets the card fall back to the
        // resting "×N".
        if (key === 'sceneRepeat:slot') {
          if (!repTrack || !repTrack.started) return -1;
          const total = sceneRepeatCount(liveData(), repTrack.slot);
          if (total <= 0) return -1; // infinite — nothing counting down
          return sceneRepeatsDone(repTrack, repBeatClock) < total ? repTrack.slot : -1;
        }
        if (key === 'sceneRepeat:done')
          return repTrack && repTrack.started ? sceneRepeatsDone(repTrack, repBeatClock) : 0;
        if (key === 'sceneRepeat:total')
          return repTrack && repTrack.started ? sceneRepeatCount(liveData(), repTrack.slot) : 0;
        if (typeof key === 'string') {
          // per-lane reads: 'activeLane:L' 'pitchVOct:L' 'gateValue:L' 'velValue:L' 'currentStep:L'
          const m = /^(activeLane|pitchVOct|gateValue|velValue|currentStep):(\d+)$/.exec(key);
          if (m) {
            const L = Number(m[2]);
            if (L < 0 || L >= LANES) return undefined;
            const ln = lanes[L];
            switch (m[1]) {
              case 'activeLane': return ln.active === null ? -1 : ln.active;
              case 'pitchVOct': return ln.lastVOct;
              case 'gateValue': return ln.lastGate;
              case 'velValue': return ln.lastVel;
              // ⚠ GATED ON THE SAME `transportRunning()` THE SCHEDULER GATES
              // ON. A transport stop silences every lane but deliberately KEEPS
              // `ln.active` (lanes resume on restart) and leaves the elapsed
              // ring entries behind, so `laneDisplayStep` keeps answering the
              // LAST step that sounded — and both piano rolls (card + face)
              // poll this key and painted that stale answer as a full-column
              // "playhead" frozen on screen for as long as the clip stayed
              // armed. Nothing is sounding while the scheduler is not running:
              // the honest read is -1. `laneDisplayStep` itself is untouched —
              // `reconcileLane`'s cut decision needs the raw anchor.
              case 'currentStep': return transportRunning() ? laneDisplayStep(L) : -1;
            }
          }
        }
        return undefined;
      },
      dispose() {
        alive = false;
        // SONG-REC: commit any in-flight print before teardown (punch-out). Drop
        // the un-sounded lookahead tail — teardown cancels that scheduled audio,
        // so it must not be printed (printed == sounded).
        flushSongNotes(true);
        // Param-jump policy: deleting the player while automation plays must not
        // leave the target params riding a ~200 ms ghost tail then freezing at an
        // arbitrary phase — hold-last-value every lane's playing automation clip
        // (an immediate seam) BEFORE the controller unregisters.
        for (let L = 0; L < LANES; L++) holdLaneAutomation(L, lanes[L].active, null, null);
        controller.disarmAll(); // commit + drop any in-flight per-lane record passes
        unregisterAutomationController(nodeId); // drop the touch-suspend hook
        if (autoCacheEnabled) ydocEvents.off?.('update', bumpAutoRev); // drop the view-cache pump
        clearPlayheads(nodeId);
        clearLanePhases(nodeId);
        clearReconcile(nodeId);
        clearAutomationRender(nodeId);
        clearAudition(nodeId);
        if (unsubscribeTick) {
          unsubscribeTick();
          unsubscribeTick = null;
        }
        // AUDIO CLIPS: stop every source + release the duck (the mixer must
        // not stay ducked for a launcher that no longer exists), then tear
        // down the per-lane output plumbing and any live normals.
        for (let L = 0; L < LANES; L++) haltLaneAudio(L, ctx.currentTime, true);
        for (const o of audioOut) {
          try { o.split?.disconnect(); } catch { /* */ }
          try { o.l.disconnect(); } catch { /* */ }
          try { o.r.disconnect(); } catch { /* */ }
        }
        try { audioKeep?.disconnect(); } catch { /* */ }
        for (const ln of lanes) {
          try { ln.gateSrc.stop(); } catch { /* */ }
          try { ln.velSrc.stop(); } catch { /* */ }
          ln.poly.dispose();
          try { ln.gateSrc.disconnect(); } catch { /* */ }
          try { ln.velSrc.disconnect(); } catch { /* */ }
        }
        try { stopSilence.stop(); } catch { /* */ }
        stopSilence.disconnect();
        stopGain.disconnect();
        stopAnalyser.disconnect();
        try { resetSilence.stop(); } catch { /* */ }
        resetSilence.disconnect();
        resetGain.disconnect();
        resetAnalyser.disconnect();
      },
    };
  },
};

export { CLIP_COUNT, POLY_CHANNEL_PAIRS };
