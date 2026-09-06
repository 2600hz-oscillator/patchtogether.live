// packages/web/src/lib/video/modules/gibribbon.ts
//
// GIBRIBBON — an AUDIO-DRIVEN, fair-use Vib-Ribbon-spirit line-runner.
//
// ── THE OWNER RULINGS THIS FILE IMPLEMENTS (verbatim) ───────────────────────
// 2026-08-28 (the rewrite): "gibribbon has never really worked so that one
// should be done as a full rewrite, based on looking at the history of the
// module and understanding it was intended to be a cv-controlled fair-use
// approximation of the game vib ribbon, and function as a playable game in
// that respect. it also will use doom marine and monster assets, but this is
// fair use artistic parody area"
// 2026-08-29 (the audio redirect): "marine doesn't die when hit in gibribbon,
// also it should be audio responsive, events should only happen based on
// audio? i see it has 4 cv ins, unsure if that's helpful vs just having an
// audio in and doing what synesthesia does and extract spectral events to
// spawn monsters and changes in the road. should investigate what vibribbon
// actually does, but i think this should be audio in"
//
// ── WHAT THE ORIGINAL ACTUALLY DOES → WHAT THIS MODULE DOES ────────────────
// (Vib-Ribbon, NanaOn-Sha/SCE 1999; verified against the game's published
// descriptions — en.wikipedia.org/wiki/Vib-Ribbon:)
//
//   ORIGINAL                                THIS MODULE
//   the course is generated FROM MUSIC —    the course is derived from the
//   the game analyzes the soundtrack or     `audio_in` port by the module's
//   ANY music CD the player inserts         OWN analyser (no upstream DSP
//                                           calibration — the #698/#701
//                                           killer — can exist)
//   it "looks eight seconds ahead" and      a ~2-bar lookahead buffer, spawns
//   spawns obstacles from "'interesting'    picked by RELATIVE-prominence
//   frequency changes"                      peaks over each band's own rolling
//                                           baseline + a spectral-flux ONSET
//                                           bias (gibribbon-spectral.ts +
//                                           gibribbon-engine.ts)
//   four obstacles (block/loop/wave/pit)    four events on ABXY: bass→LOOP
//   each on one button (L1/R1/X/Down),      (road pit-V), low-mid→JUMP (road
//   merged forms need chords                hump), high-mid→IMP, treble→
//                                           ZOMBIE — the low end shapes the
//                                           ROAD, the highs send MONSTERS
//   hits DEGRADE Vibri through visible      hits (uncleared events reaching
//   forms rabbit→frog→insect; hits as an    the marine) degrade a VISIBLE
//   insect END THE GAME; streaks recover    DOOM ladder — the status-bar face
//   forms; a rabbit streak goes gold        grades + pain hold — down to
//   (Super Vibri)                           GAME OVER; streaks heal; a long
//                                           streak reaches SUPER
//
// The DOOM shareware sprites (marine PLAY*, imp TROO*, former-human POSS*,
// and the status-bar face STF*) are used under the owner's fair-use
// artistic-parody ruling. The WAD is the setup-fetched shareware DOOM1.WAD
// (gitignored, never committed — the same file the DOOM module runs), decoded
// at load by the PURE lib/doom/wad-sprites.ts primitives, with a line-art
// fallback when absent. ⚠ THE STANDING DOOM CARVE-OUT HOLDS: this module
// consumes the shared WAD file and the pure decoders READ-ONLY (the STF face
// decode COMPOSES the exported primitives rather than editing the decoder);
// no file under lib/doom/ is modified, and none may be without approval.
//
// This file is the thin GL/audio/input shell around the pure one-clock
// engine (gibribbon-engine.ts) and the pure spectral fold
// (gibribbon-spectral.ts): analyser → bands/onset → adaptive extractor →
// course; scheduler tick drives everything; draw() renders.
//
// Inputs (⚠ ID SURGERY 2026-08-29, owner-approved: the PR was unmerged and
// the module never worked historically, so the CV-era ports were REMOVED
// rather than carried dead — cv1..cv4/clock/gate are gone):
//   audio_in (audio)      — THE source. The module's own AnalyserNode folds
//        it into four musical bands (20-200/200-1k/1k-4k/4k-16k) that DRIVE
//        the course. Tap-only/inaudible (route the signal to AUDIO OUT
//        separately to hear it).
//   x, y (modsignal ±1)   — aim: x shifts the judgement point ±1 window,
//        y raises/crouches the marine.
//   a, b, x_btn, y_btn (gate, trigger) — the four play buttons.
//   restart (gate, trigger) — restart from game over / hard reset mid-run.
//
// Outputs (ids stable):
//   out (video), evt_hit / evt_miss / evt_fire / evt_kill / evt_gameover
//   (10 ms gate pulses), health_cv (0..1 vitality).
//
// Params: 7 CV-target params (noUserControl, writer 'cv-port') + the three
// player controls — difficulty, tempo, and `autoplay` (ATTRACT semantics,
// label Attract).

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoEngineContext, VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';
import { detectEdge, makeEdgeState, type EdgeState } from '$lib/doom/cv-gate-edge';
import { loadWad } from '$lib/doom/doom-runtime';
import {
  extractGibSprites,
  parseWadDirectory,
  readPlaypal,
  decodePicture,
  type GibSprites,
  type SpriteFrame,
} from '$lib/doom/wad-sprites';
import {
  GIB_FFT_SIZE,
  gibBandBinRanges,
  gibFoldBands,
  gibSpectralFlux,
  newOnsetState,
  pushFluxIsOnset,
  type GibOnsetState,
} from './gibribbon-spectral';
import { getSchedulerClock, SCHEDULER_TICK_MS } from '$lib/audio/scheduler-clock';
import { pulseTriggerNow } from '$lib/audio/gate-trigger';
import {
  GIB_TUNING,
  EVENT_BUTTON,
  newRun,
  step,
  judgePhase,
  effectivePos,
  upcomingLane,
  drainOutEvents,
  healthToCv,
  IDLE_INPUTS,
  isGameOver,
  type GibState,
  type GibStepInputs,
  type GibStepParams,
  type GibButton,
  type GibEvent,
  type GibEventKind,
} from './gibribbon-engine';

/** 16:9 internal canvas (unchanged from the original build so the on-card
 *  preview keeps its buffer size — putImageData does NOT scale). */
export const INTERNAL_W = 1024;
export const INTERNAL_H = 576;
const GATE_PULSE_S = 0.01;

/** Default TEMPO — BPM-equivalent of the original build's ~0.42 s beat. */
const DEFAULT_TEMPO_BPM = 143;

// Fragment shader: sample the CPU framebuffer and letterbox into the engine's
// 4:3 FBO. Internal canvas is 16:9 → full width, bars top+bottom.
const FRAG_SRC = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform vec2 uLetterbox;
void main() {
  vec2 centered = (vUv - 0.5) / uLetterbox + 0.5;
  if (centered.x < 0.0 || centered.x > 1.0 || centered.y < 0.0 || centered.y > 1.0) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  // CPU buffer is row-major TOP-DOWN; flip Y so it renders right-side-up.
  vec2 uv = vec2(centered.x, 1.0 - centered.y);
  outColor = texture(uTex, uv);
}`;

interface GibParams {
  // Synthetic CV-target params (the input ports' paramTargets — noUserControl).
  axis_x: number; axis_y: number;
  btn_a: number; btn_b: number; btn_x: number; btn_y: number;
  restart_btn: number;
  // Player-facing controls.
  autoplay: number;   // ATTRACT semantics under the persisted id (Q3).
  difficulty: number;
  tempo: number;
}

const DEFAULTS: GibParams = {
  axis_x: 0, axis_y: 0,
  btn_a: 0, btn_b: 0, btn_x: 0, btn_y: 0,
  restart_btn: 0,
  autoplay: 1,
  difficulty: 0.5,
  tempo: DEFAULT_TEMPO_BPM,
};

/** Card/face-facing handle. Both surfaces read the framebuffer + state via
 *  these; the shared GibribbonScreen component is the only consumer. */
export interface GibribbonHandleExtras {
  /** Current INTERNAL_W×INTERNAL_H ImageData for the 2D preview blit. */
  snapshot(): ImageData | null;
  getScore(): number;
  getHealth(): string;
  getCombo(): number;
  /** 'attract' while the module self-plays (labelled in-canvas), else 'play'. */
  getMode(): 'attract' | 'play';
  /** Were the WAD sprites loaded? '' on success, else the reason (the WAD
   *  lamp reads this). */
  loadError(): string;
  /** Push an ABXY press from the keyboard (surface-driven; same judge path
   *  as a patched cable). */
  pushButton(button: GibButton): boolean;
  /** Restart from the surface (R key / RESET action) — same path as the
   *  restart gate port. */
  pushRestart(): void;
  /** The lookahead lane (next-N upcoming buttons, nearest first). */
  getLane(): { button: GibButton; kind: GibEventKind; pos: number; hot: boolean }[];
  isDead(): boolean;
  /** Alias of pushRestart — the name the module's RESTART affordance uses. */
  reset(): void;
  /** Test-only: force-pulse a gate output WITHOUT a game event, so e2e/VRT
   *  can exercise the video→audio bridge deterministically. */
  forcePulse(port: GibGatePort): void;
}

type GibGatePort = 'evt_hit' | 'evt_miss' | 'evt_fire' | 'evt_kill' | 'evt_gameover';

// ── palette (the Vib-Ribbon line-art grammar) ──────────────────────────────
const COL_RIBBON = [0xff, 0xff, 0xff];
const COL_PROMPT = [0xa0, 0xa0, 0xa0];
const COL_PROMPT_HOT = [0xff, 0xff, 0xff];
const COL_LANE = [0x30, 0x30, 0x30];
const COL_LANE_TICK = [0x60, 0x60, 0x60];
const COL_HUD = [0xd8, 0xd8, 0xd8];
const COL_ATTRACT = [0x9a, 0x9a, 0x9a];
const BTN_COLORS: Record<GibButton, number[]> = {
  a: [0x6c, 0xc0, 0x4a], // green
  b: [0xe0, 0x50, 0x50], // red
  x: [0x50, 0x90, 0xe0], // blue
  y: [0xe0, 0xc0, 0x40], // yellow
};
const COL_BG_GLYPH = [0x00, 0x00, 0x00];

// ── tiny 3×5 pixel font (in-canvas HUD per GAMES.md: score/combo/state are
//    the game's own artwork, painted INTO the playfield — never DOM chrome) ─
const FONT: Record<string, number[]> = {
  '0': [0b111, 0b101, 0b101, 0b101, 0b111],
  '1': [0b010, 0b110, 0b010, 0b010, 0b111],
  '2': [0b111, 0b001, 0b111, 0b100, 0b111],
  '3': [0b111, 0b001, 0b111, 0b001, 0b111],
  '4': [0b101, 0b101, 0b111, 0b001, 0b001],
  '5': [0b111, 0b100, 0b111, 0b001, 0b111],
  '6': [0b111, 0b100, 0b111, 0b101, 0b111],
  '7': [0b111, 0b001, 0b001, 0b010, 0b010],
  '8': [0b111, 0b101, 0b111, 0b101, 0b111],
  '9': [0b111, 0b101, 0b111, 0b001, 0b111],
  A: [0b010, 0b101, 0b111, 0b101, 0b101],
  C: [0b111, 0b100, 0b100, 0b100, 0b111],
  D: [0b110, 0b101, 0b101, 0b101, 0b110],
  E: [0b111, 0b100, 0b111, 0b100, 0b111],
  G: [0b111, 0b100, 0b101, 0b101, 0b111],
  M: [0b101, 0b111, 0b111, 0b101, 0b101],
  O: [0b111, 0b101, 0b101, 0b101, 0b111],
  P: [0b111, 0b101, 0b111, 0b100, 0b100],
  R: [0b110, 0b101, 0b110, 0b101, 0b101],
  S: [0b111, 0b100, 0b111, 0b001, 0b111],
  T: [0b111, 0b010, 0b010, 0b010, 0b010],
  U: [0b101, 0b101, 0b101, 0b101, 0b111],
  V: [0b101, 0b101, 0b101, 0b101, 0b010],
  X: [0b101, 0b101, 0b010, 0b101, 0b101],
  Y: [0b101, 0b101, 0b010, 0b010, 0b010],
  ' ': [0, 0, 0, 0, 0],
};

export const gibribbonDef: VideoModuleDef = {
  type: 'gibribbon',
  palette: { top: 'Games', sub: 'Arcade' },
  domain: 'video',
  label: 'gibribbon',
  category: 'sources',
  inputs: [
    // THE SOURCE. An `audio`-typed input on a VIDEO module (the graphicEq
    // precedent): the cross-domain bridge connects the upstream signal
    // straight into the AnalyserNode this handle publishes via
    // `audioInputs`. The module folds it into four MUSICAL bands that drive
    // the whole course — "events only happen based on audio".
    { id: 'audio_in', type: 'audio' as const },
    // Aim axes.
    { id: 'x', type: 'modsignal' as const, paramTarget: 'axis_x', cvScale: { mode: 'linear' as const } },
    { id: 'y', type: 'modsignal' as const, paramTarget: 'axis_y', cvScale: { mode: 'linear' as const } },
    // The four ABXY play buttons (distinct ids from the x/y axes).
    { id: 'a',     type: 'gate' as const, edge: 'trigger' as const, paramTarget: 'btn_a' },
    { id: 'b',     type: 'gate' as const, edge: 'trigger' as const, paramTarget: 'btn_b' },
    { id: 'x_btn', type: 'gate' as const, edge: 'trigger' as const, paramTarget: 'btn_x' },
    { id: 'y_btn', type: 'gate' as const, edge: 'trigger' as const, paramTarget: 'btn_y' },
    // Restart (frogger's start_gate precedent) — game-over restart + hard reset.
    { id: 'restart', type: 'gate' as const, edge: 'trigger' as const, paramTarget: 'restart_btn' },
  ],
  outputs: [
    { id: 'out',          type: 'video' },
    { id: 'evt_hit',      type: 'gate', edge: 'trigger' },
    { id: 'evt_miss',     type: 'gate', edge: 'trigger' },
    { id: 'evt_fire',     type: 'gate', edge: 'trigger' },
    { id: 'evt_kill',     type: 'gate', edge: 'trigger' },
    { id: 'evt_gameover', type: 'gate', edge: 'trigger' },
    { id: 'health_cv',    type: 'cv' },
  ],
  params: [
    // The 7 CV-target params (all noUserControl — the jacks write them).
    { id: 'axis_x', label: 'X', defaultValue: 0, min: -1, max: 1, curve: 'linear' as const },
    { id: 'axis_y', label: 'Y', defaultValue: 0, min: -1, max: 1, curve: 'linear' as const },
    { id: 'btn_a', label: 'A', defaultValue: 0, min: 0, max: 1, curve: 'linear' as const },
    { id: 'btn_b', label: 'B', defaultValue: 0, min: 0, max: 1, curve: 'linear' as const },
    { id: 'btn_x', label: 'X (btn)', defaultValue: 0, min: 0, max: 1, curve: 'linear' as const },
    { id: 'btn_y', label: 'Y (btn)', defaultValue: 0, min: 0, max: 1, curve: 'linear' as const },
    { id: 'restart_btn', label: 'RESTART', defaultValue: 0, min: 0, max: 1, curve: 'linear' as const },
    // Player-facing controls.
    //
    // ⚠ Q3 (spec §11): the `autoplay` ID IS KEPT so persisted patches load
    // with their setting intact, but the SEMANTICS are ATTRACT mode and the
    // label says so. A clean `attract` id would silently drop every saved
    // autoplay=0 — persistence compat is worth one slightly stale id.
    { id: 'autoplay', label: 'Attract', defaultValue: 1, min: 0, max: 1, curve: 'discrete' as const },
    { id: 'difficulty', label: 'Difficulty', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' as const },
    { id: 'tempo', label: 'Tempo', defaultValue: DEFAULT_TEMPO_BPM, min: 60, max: 180, curve: 'log' as const },
  ],

  // ── THE FACEPLATE (spec §6) ──────────────────────────────────────────────
  // difficulty ranks 1: the one knob a player reaches for. tempo second
  // (matters only unclocked). The attract toggle last. The 13 noUserControl
  // entries below cover every CV-target param, so the completeness sweep is
  // satisfied without ranking a single jack-written value.
  face: {
    order: ['difficulty', 'tempo', 'autoplay'],
    // Video def with no audio-typed out: `hasVideoSurface` gives the lane the
    // free VideoTileThumb — the LIVE GAME is the tile picture — before glyph
    // resolution is ever consulted. Any other literal would be a trace that
    // can never render. (This is the fate the un-migrated placeholder tile
    // avoids: the module is finally visible in the product's default view.)
    glyph: 'none',
    // The game screen: $lib/ui/modules/gibribbon/shell-extension.ts →
    // fullViewBody (playfield + keyboard capture + RESET + WAD lamp + the
    // SCREEN and MONITOR switches).
    extension: 'gibribbon',
    monitor: {
      why:
        'the game IS the video output a rack projects; watching the ribbon without the '
        + 'controls is the performance use.',
    },
    rear: {
      groups: [
        // The music IS the voice of this module — the leading slot says so.
        { id: 'voice', label: 'music', ports: ['audio_in'] },
        { id: 'signal', label: 'play', ports: ['a', 'b', 'x_btn', 'y_btn', 'restart'] },
        {
          id: 'events', label: 'events', direction: 'output',
          ports: ['evt_hit', 'evt_miss', 'evt_fire', 'evt_kill', 'evt_gameover'],
        },
      ],
    },
  },

  // #1726 — the params a player never sets: every CV-target param is written
  // by its input jack (writer 'cv-port', anchored to the port declarations).
  noUserControl: [
    { param: 'axis_x', writer: 'cv-port', why: 'aim X — the x jack writes it, the judge re-centres the window from it each tick' },
    { param: 'axis_y', writer: 'cv-port', why: 'aim Y — the y jack writes it, the renderer raises/crouches the marine from it' },
    { param: 'btn_a', writer: 'cv-port', why: 'A button level — the a jack writes it, the module edge-detects one judged press per rise' },
    { param: 'btn_b', writer: 'cv-port', why: 'B button level — the b jack writes it, the module edge-detects one judged press per rise' },
    { param: 'btn_x', writer: 'cv-port', why: 'X button level — the x_btn jack writes it, the module edge-detects one judged press per rise' },
    { param: 'btn_y', writer: 'cv-port', why: 'Y button level — the y_btn jack writes it, the module edge-detects one judged press per rise' },
    { param: 'restart_btn', writer: 'cv-port', why: 'restart level — the restart jack writes it, the module edge-detects one run restart per rise' },
  ],

  docs: {
    explanation: `An audio-driven rhythm line-runner in the spirit of Vib-Ribbon, cast with DOOM shareware sprites as fair-use artistic parody. Like the original game — which analyses the music (any CD the player inserts), looks ahead, and builds its obstacle course from interesting frequency changes — GIBRIBBON derives its course FROM THE SIGNAL you patch into AUDIO IN: the module's own analyser folds the input into four musical bands (bass 20-200 Hz, low-mid 200-1k, high-mid 1k-4k, treble 4k-16k), and an ADAPTIVE extractor spawns events on relative peaks against each band's own recent baseline, preferring spectral-flux onsets (the beat). Because prominence is relative, ANY source at ANY level plays — a quiet field recording and a hot drum bus alike — and silence or a stuck-flat signal spawns nothing. THE BAND IS THE EVENT: the low end shapes the ROAD (bass = LOOP pit-V dips, low-mid = JUMP humps) and the highs send the MONSTERS (high-mid = imps, treble = zombies/former-humans, rendered as real DOOM sprites when DOOM1.WAD is present, wireframe line-art otherwise). Clear each event with its ABXY button (loop=A, jump=B, imp=X, zombie=Y) inside the timing window as it reaches the marine; a ~2-bar lookahead lane names the next buttons. THE DAMAGE MODEL IS VIB-RIBBON'S: an event you fail to clear HITS the marine and degrades him one visible form down a DOOM ladder (the status-bar face grades from grinning to bloodied), like Vibri degrading rabbit-to-frog-to-insect; hits at the floor are GAME OVER; clean streaks heal forms back and a long streak reaches gold SUPER. Restart from the restart gate, the R key, or the RESET action — wire evt_gameover back to restart for an endless arcade loop. TEMPO sets the ribbon's course rate (the audio decides WHAT spawns, tempo decides how fast it approaches); DIFFICULTY scales density and speed together. An idle, unpatched module self-plays in ATTRACT mode — honestly labelled IN the picture, and its demo bot fumbles now and then so you can see the damage ladder work; any input (a button, the keyboard, or MOVING audio arriving at AUDIO IN) starts a real run. Play it three ways: patch a gamepad module\'s a/b/x/y gates + lx/ly axes straight in, click the screen and use the keyboard (F/D/J/K or arrows, R = restart), or sequence the rack from the event gate outputs — the game is half a sequencer.`,
    inputs: {
      audio_in: "THE SOURCE. Patch any audio here — the whole course derives from it, like Vib-Ribbon generating stages from a music CD. The module's own AnalyserNode folds the signal into four musical bands (bass/low-mid/high-mid/treble) and spawns events on relative peaks against each band's own rolling baseline, biased toward spectral-flux onsets. Tap-only and inaudible: route the signal to AUDIO OUT separately to hear it. Moving audio also counts as player presence — it wakes the module out of ATTRACT into a live run.",
      x: "Aim X (bipolar -1..1): re-centres the judgement point by up to one hit-window (stick left = clear events slightly early, right = slightly late). Shifts the window, never widens it. Modulates the X control.",
      y: "Aim Y (bipolar -1..1): raises the marine off the ribbon (up) or crouches it (down) — a visible aim aid consumed by the renderer. Modulates the Y control.",
      a: "The A play button (rising edge): judges the nearest in-window LOOP event at the tick-anchored phase of the press. Spare presses with no matching event are ignored (no penalty). Modulates the A control.",
      b: "The B play button (rising edge): judges the nearest in-window JUMP event. Modulates the B control.",
      x_btn: "The X play button (rising edge): judges the nearest in-window IMP event. Named x_btn to disambiguate from the x AXIS port. Modulates the X (btn) control.",
      y_btn: "The Y play button (rising edge): judges the nearest in-window ZOMBIE event. Named y_btn to disambiguate from the y AXIS port. Modulates the Y (btn) control.",
      restart: "Restart gate (rising edge): starts a fresh run — from GAME OVER or as a hard reset mid-run — so a rack can loop the game (wire evt_gameover back here through a delay for an endless arcade). Same path as the R key and the RESET action. Modulates the RESTART control.",
    },
    outputs: {
      out: "The rendered game frame (video): the 16:9 ribbon scene — course, sprites, the DOOM status-bar face showing the marine's current form, and the in-canvas HUD (score, combo, ATTRACT label, count-in, GAME OVER banner) — letterboxed into the engine's 4:3 output.",
      evt_hit: "A ~10 ms gate pulse on every successful clear (any in-window button match). In ATTRACT mode the self-player keeps firing these — the sequencer half of the module stays alive while idle.",
      evt_miss: "A ~10 ms gate pulse every time an uncleared event HITS the marine (it reached him without the right press), as he degrades a visible form down the ladder.",
      evt_fire: "A ~10 ms gate pulse when the marine FIRES — emitted on a successful enemy (imp/zombie) clear.",
      evt_kill: "A ~10 ms gate pulse when an enemy DIES (its death animation), emitted alongside evt_fire on an enemy clear.",
      evt_gameover: "A ~10 ms gate pulse fired once when the marine's form degrades past the floor — GAME OVER (Vibri hit once too often as an insect).",
      health_cv: "The marine's vitality as a 0..1 CV (super=1, healthy=0.75, wounded=0.5, critical=0.25, dead=0), ramped smoothly on each form change.",
    },
    controls: {
      autoplay: "ATTRACT toggle (0/1, default 1 = ON). The id says autoplay for historical continuity; the behaviour is ATTRACT MODE: when ON, an IDLE and unpatched module self-plays a labelled attract run through the real extractor and judge (its demo bot deliberately fumbles some events so the damage ladder shows), and any real input — a button, the keyboard, or moving audio at AUDIO IN — starts a fresh live run. Set 0 and the module never self-plays; an idle ribbon stays honestly empty.",
      difficulty: "The one game knob (0..1, default 0.5): scales course density (extraction bar + spawn-rate cap) and the course rate together. Low = sparse and readable; high = dense and fast.",
      tempo: "The ribbon's course rate (60..180 BPM-equivalent, default ~143 = the classic 0.42 s beat). The audio decides WHAT spawns; TEMPO decides how fast the course approaches. One clock: judgement is anchored to this transport's tick phase.",
      axis_x: "The aim-X value (-1..1, default 0) re-centring the judgement window; written by the X axis jack.",
      axis_y: "The aim-Y value (-1..1, default 0) raising/crouching the marine; written by the Y axis jack.",
      btn_a: "The A-button level (0..1); a rising edge judges the nearest in-window loop event. Written by the A jack (or keyboard F / left-arrow).",
      btn_b: "The B-button level (0..1); a rising edge judges the nearest in-window jump event. Written by the B jack (or keyboard D / down-arrow).",
      btn_x: "The X-button level (0..1); a rising edge judges the nearest in-window imp event. Written by the x_btn jack (or keyboard J / right-arrow).",
      btn_y: "The Y-button level (0..1); a rising edge judges the nearest in-window zombie event. Written by the y_btn jack (or keyboard K / up-arrow).",
      restart_btn: "The restart level (0..1); a rising edge starts a fresh run (from game over, or hard reset mid-run). Written by the restart jack (or keyboard R / the RESET action).",
    },
  },

  factory(ctx: VideoEngineContext, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);
    const uTex = gl.getUniformLocation(program, 'uTex');
    const uLetterbox = gl.getUniformLocation(program, 'uLetterbox');
    const { fbo, texture } = ctx.createFbo();

    const fboAspect = ctx.res.width / ctx.res.height;
    const srcAspect = INTERNAL_W / INTERNAL_H;
    const letterboxU = Math.min(1.0, srcAspect / fboAspect);
    const letterboxV = Math.min(1.0, fboAspect / srcAspect);

    const sourceTex = gl.createTexture();
    if (!sourceTex) throw new Error('GIBRIBBON: createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, sourceTex);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA, INTERNAL_W, INTERNAL_H, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(INTERNAL_W * INTERNAL_H * 4),
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const fbBytes = new Uint8ClampedArray(INTERNAL_W * INTERNAL_H * 4);
    for (let i = 3; i < fbBytes.length; i += 4) fbBytes[i] = 255; // opaque
    const fbImage: ImageData | null =
      typeof ImageData !== 'undefined' ? new ImageData(fbBytes, INTERNAL_W, INTERNAL_H) : null;

    const params: GibParams & Record<string, number> = {
      ...DEFAULTS,
      ...(node.params as Partial<GibParams>),
    };

    function stepParams(): GibStepParams {
      return {
        tickMs: SCHEDULER_TICK_MS,
        tempoBpm: params.tempo,
        difficulty: params.difficulty,
        attract: params.autoplay,
      };
    }
    function initialMode(): 'attract' | 'play' {
      return params.autoplay >= 0.5 ? 'attract' : 'play';
    }

    // ── DETERMINISM SEAMS (spec §8 — designed in, not retrofitted) ─────────
    //
    // __gibribbonVrtSeed pins the xorshift stream (a number, or `true` for
    // 0xC0DE). __gibribbonVrtTicks rebuilds the run and steps it EXACTLY that
    // many scheduler ticks with idle inputs, then SUPPRESSES all further
    // stepping — the frogger/pong shape, which makes the picture
    // TIME-INVARIANT rather than frozen at an arbitrary moment. Both are read
    // at CONSTRUCTION (the face harness installs them via addInitScript
    // before boot) AND once more in the tick (the card scene's afterSpawn
    // path) — a construction-only read would leave the card scene silently
    // unpinned. __videoEngineFreezeTime — the engine-wide clock pin — is
    // honoured MODULE-SIDE too: while it is finite the subscribed tick
    // early-returns, because the scheduler clock is a Web Worker interval
    // that no audio suspend and no rAF gate can hold (GAMES.md §4.1); the
    // module's own early-return is the ONLY mechanism. Nothing in the app
    // ever sets any of the three.
    function readVrtSeed(): number | undefined {
      const v = (globalThis as unknown as { __gibribbonVrtSeed?: number | boolean }).__gibribbonVrtSeed;
      if (typeof v === 'number') return v >>> 0;
      if (v === true) return 0xc0de;
      return undefined;
    }
    function readVrtTicks(): number | undefined {
      const v = (globalThis as unknown as { __gibribbonVrtTicks?: number }).__gibribbonVrtTicks;
      return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined;
    }
    function engineFrozen(): boolean {
      const v = (globalThis as unknown as { __videoEngineFreezeTime?: unknown }).__videoEngineFreezeTime;
      return typeof v === 'number' && Number.isFinite(v);
    }
    function bootSeed(): number {
      const pinned = readVrtSeed();
      if (pinned !== undefined) return pinned;
      return (Date.now() & 0xffffffff) >>> 0;
    }

    // ── Sprites (async decode from the shared shareware WAD; read-only) ────
    //
    // ⚠ __gibribbonVrtNoWad (test-only, set via addInitScript/afterSpawn like
    // the other pins): SKIPS the WAD decode so a VRT capture is pinned to the
    // line-art fallback — the decode is async and the WAD's presence varies by
    // environment (gitignored, setup-fetched), so a baseline racing it would
    // be a function of fetch timing. The fallback is a real shipped path; the
    // sprite path is covered by the wad-sprites unit suite + the e2e. Read at
    // construction AND re-checked on the late tick-pin path (the card scene
    // installs it from afterSpawn, after this factory ran).
    let sprites: GibSprites | null = null;
    /** DOOM status-bar face pictures by damage grade 0..4 (grinning → most
     *  bloodied) + the dead face — the parody-perfect VISIBLE FORM ladder
     *  (Vibri's rabbit→frog→insect, cast as the marine's own mugshot).
     *  Decoded by COMPOSING the exported pure primitives (parseWadDirectory /
     *  readPlaypal / decodePicture) — no lib/doom file is edited. */
    let stfFaces: (SpriteFrame | null)[] = [null, null, null, null, null];
    let stfDead: SpriteFrame | null = null;
    let loadErr = '';
    function wadDisabled(): boolean {
      return (globalThis as unknown as { __gibribbonVrtNoWad?: boolean }).__gibribbonVrtNoWad === true;
    }
    function applyWadArtPin(): void {
      sprites = null;
      stfFaces = [null, null, null, null, null];
      stfDead = null;
      loadErr = 'DOOM1.WAD disabled by VRT pin — line-art fallback';
    }
    if (wadDisabled()) {
      applyWadArtPin();
    } else {
      void (async () => {
        try {
          const { bytes, error } = await loadWad();
          if (!bytes) { loadErr = error ?? 'DOOM1.WAD missing — using line-art fallback'; return; }
          if (!wadDisabled()) {
            sprites = extractGibSprites(bytes);
            // Status-bar face grades via the exported primitives (read-only).
            const lumps = parseWadDirectory(bytes);
            const byName = new Map<string, { filepos: number; size: number }>();
            for (const l of lumps) byName.set(l.name, l);
            const palette = readPlaypal(bytes, lumps);
            const pic = (name: string): SpriteFrame | null => {
              const l = byName.get(name);
              if (!l || l.size <= 0) return null;
              try { return decodePicture(bytes, l.filepos, l.size, palette); } catch { return null; }
            };
            stfFaces = [0, 1, 2, 3, 4].map((g) => pic(`STFST${g}1`) ?? pic(`STFST${g}0`));
            stfDead = pic('STFDEAD0');
          }
        } catch (e) {
          loadErr = e instanceof Error ? e.message : String(e);
        }
      })();
    }

    let state: GibState = newRun(bootSeed(), initialMode());
    let vrtPinned = false;
    function applyVrtTickPin(ticks: number): void {
      if (wadDisabled()) applyWadArtPin(); // the late-install art pin
      state = newRun(bootSeed(), initialMode());
      const sp = stepParams();
      for (let i = 0; i < ticks; i++) step(state, IDLE_INPUTS, sp);
      drainOutEvents(state); // pinned boots pulse no gates
      vrtPinned = true;
    }
    {
      const bootPin = readVrtTicks();
      if (bootPin !== undefined) applyVrtTickPin(bootPin);
    }

    // ── Audio gate outputs (persistent node identity from t=0) ─────────────
    const audioSources = new Map<string, { node: AudioNode; output: number }>();
    let hitGate: ConstantSourceNode | null = null;
    let missGate: ConstantSourceNode | null = null;
    let fireGate: ConstantSourceNode | null = null;
    let killGate: ConstantSourceNode | null = null;
    let gameoverGate: ConstantSourceNode | null = null;
    let healthCv: ConstantSourceNode | null = null;

    if (ctx.audioCtx) {
      const ac = ctx.audioCtx;
      const t0 = ac.currentTime;
      const mkGate = () => { const c = ac.createConstantSource(); c.offset.setValueAtTime(0, t0); c.start(); return c; };
      hitGate = mkGate();
      missGate = mkGate();
      fireGate = mkGate();
      killGate = mkGate();
      gameoverGate = mkGate();
      healthCv = ac.createConstantSource();
      healthCv.offset.setValueAtTime(healthToCv(state.health), t0);
      healthCv.start();
      audioSources.set('evt_hit', { node: hitGate, output: 0 });
      audioSources.set('evt_miss', { node: missGate, output: 0 });
      audioSources.set('evt_fire', { node: fireGate, output: 0 });
      audioSources.set('evt_kill', { node: killGate, output: 0 });
      audioSources.set('evt_gameover', { node: gameoverGate, output: 0 });
      audioSources.set('health_cv', { node: healthCv, output: 0 });
    }

    const pulseSubscribers = new Map<string, Set<() => void>>();
    function notifyPulse(port: string): void {
      const subs = pulseSubscribers.get(port);
      if (!subs) return;
      for (const cb of subs) { try { cb(); } catch { /* */ } }
    }
    function pulseGate(src: ConstantSourceNode | null, port: string): void {
      const ac = ctx.audioCtx;
      if (!ac || !src) return;
      // ⚠ NOT a hand-rolled setValueAtTime pair. A rise+fall scheduled at
      // `currentTime` can land wholly behind the render frontier and collapse
      // to NOTHING — on an affected boot, for EVERY pulse (run 34004453604
      // shard 8: 134 pulses / 30 s / analyser peak 0.0000 with the bridge
      // verified wired; reproduced on demand under CDP CPU throttle ×20).
      // `pulseTriggerNow` is the shared render-robust primitive — the full
      // mechanism and its measurements live on it in $lib/audio/gate-trigger.
      pulseTriggerNow(src, GATE_PULSE_S);
      notifyPulse(port);
    }
    function gateFor(port: GibGatePort): ConstantSourceNode | null {
      switch (port) {
        case 'evt_hit': return hitGate;
        case 'evt_miss': return missGate;
        case 'evt_fire': return fireGate;
        case 'evt_kill': return killGate;
        case 'evt_gameover': return gameoverGate;
      }
    }
    function updateHealthCv(): void {
      const ac = ctx.audioCtx;
      if (!ac || !healthCv) return;
      const t = ac.currentTime;
      try { healthCv.offset.cancelScheduledValues(t); } catch { /* */ }
      healthCv.offset.setValueAtTime(healthCv.offset.value, t);
      healthCv.offset.linearRampToValueAtTime(healthToCv(state.health), t + 0.02);
    }

    function drainGameEvents(): void {
      const out = drainOutEvents(state);
      let healthChanged = false;
      for (const e of out) {
        if (e.type === 'hit') pulseGate(hitGate, 'evt_hit');
        else if (e.type === 'miss') pulseGate(missGate, 'evt_miss');
        else if (e.type === 'fire') pulseGate(fireGate, 'evt_fire');
        else if (e.type === 'kill') pulseGate(killGate, 'evt_kill');
        else if (e.type === 'gameover') { pulseGate(gameoverGate, 'evt_gameover'); healthChanged = true; }
        else if (e.type === 'degrade' || e.type === 'heal' || e.type === 'super') healthChanged = true;
      }
      if (healthChanged) updateHealthCv();
    }

    // ── Input edge queues (setParam → the ONE stepper) ─────────────────────
    //
    // setParam can be called any number of times between scheduler ticks (the
    // CV bridge, a burst of e2e pulses); edges are QUEUED here and consumed
    // by the next tick, so none is ever lost to sampling. Edge DETECTION uses
    // the same pure detector the original build used (read-only reuse from
    // the doom lib — within the carve-out line).
    const restartEdge: EdgeState = makeEdgeState();
    const buttonEdges: Record<GibButton, EdgeState> = {
      a: makeEdgeState(), b: makeEdgeState(), x: makeEdgeState(), y: makeEdgeState(),
    };
    let pendingRestartEdges = 0;
    let pendingButtons: GibButton[] = [];
    let pendingActivity = false;
    const ACTIVITY_EPS = 0.01;

    function noteActivity(): void { pendingActivity = true; }

    // ── THE EAR — the module's own analyser over `audio_in` ────────────────
    //
    // The graphicEq shape: an `audio`-typed input on a video module, the
    // upstream source bridged straight into an AnalyserNode this handle
    // publishes via `audioInputs`. Each scheduler tick reads the byte
    // spectrum ONCE and folds it into the four musical bands + the flux
    // onset (gibribbon-spectral.ts, pure) — the engine never sees a bin.
    //
    // ⚠ __gibribbonTestBands (test-only, like the VRT pins — nothing in app
    // code sets it): when it holds a 4-array, the fold is bypassed and those
    // levels feed the extractor instead. The deterministic seam the e2e uses
    // to script exact courses without owning an audio graph; the real
    // analyser path is covered by the live-cable e2e leg.
    let analyser: AnalyserNode | null = null;
    let audioInputs: Map<string, { node: AudioNode; input: number }> | undefined;
    let freqBuf: Uint8Array<ArrayBuffer> | null = null;
    let bandRanges: Array<[number, number]> | null = null;
    if (ctx.audioCtx) {
      const ac = ctx.audioCtx;
      analyser = ac.createAnalyser();
      analyser.fftSize = GIB_FFT_SIZE;
      // Modest smoothing: enough to steady the fold at the 25 ms tick, low
      // enough that onsets keep their edge.
      analyser.smoothingTimeConstant = 0.5;
      freqBuf = new Uint8Array(analyser.frequencyBinCount);
      bandRanges = gibBandBinRanges(ac.sampleRate, GIB_FFT_SIZE);
      audioInputs = new Map([[ 'audio_in', { node: analyser, input: 0 } ]]);
    }
    const onsetState: GibOnsetState = newOnsetState();
    let lastBands: number[] = [0, 0, 0, 0];

    function readTestBands(): number[] | null {
      const v = (globalThis as unknown as { __gibribbonTestBands?: unknown }).__gibribbonTestBands;
      if (Array.isArray(v) && v.length === 4 && v.every((x) => typeof x === 'number')) {
        return v as number[];
      }
      return null;
    }

    /** One tick's worth of hearing: bands + onset + did-the-audio-move. */
    function hearBands(): { bands: number[]; onset: boolean; moved: boolean } {
      let bands: number[];
      const forced = readTestBands();
      if (forced) {
        bands = forced;
      } else if (analyser && freqBuf && bandRanges) {
        analyser.getByteFrequencyData(freqBuf);
        bands = gibFoldBands(freqBuf, bandRanges);
      } else {
        bands = [0, 0, 0, 0];
      }
      const flux = gibSpectralFlux(lastBands, bands);
      const onset = pushFluxIsOnset(onsetState, flux);
      let moved = false;
      for (let i = 0; i < 4; i++) {
        if (Math.abs(bands[i]! - lastBands[i]!) > ACTIVITY_EPS) { moved = true; break; }
      }
      lastBands = bands;
      return { bands, onset, moved };
    }

    // ── THE ONE CLOCK — the scheduler tick drives the pure stepper ─────────
    const tick = (): void => {
      // The pin comes first and returns: a pinned board must never advance.
      if (vrtPinned) return;
      const latePin = readVrtTicks();
      if (latePin !== undefined) { applyVrtTickPin(latePin); return; }
      // Module-side freeze: the ONLY thing that can hold a scheduler-clocked
      // game (the worker interval ignores audio suspends and rAF).
      if (engineFrozen()) return;

      // Hear this tick: the analyser fold (or the test seam) → bands/onset.
      // MOVING audio is player presence — it wakes attract into a live run,
      // the way inserting a CD is the point of the original game.
      const heard = hearBands();
      const inputs: GibStepInputs = {
        bands: heard.bands,
        onset: heard.onset,
        buttons: pendingButtons.length ? pendingButtons : IDLE_INPUTS.buttons,
        restartEdges: pendingRestartEdges,
        axisX: params.axis_x,
        axisY: params.axis_y,
        activity: pendingActivity || heard.moved,
      };
      pendingRestartEdges = 0;
      if (pendingButtons.length) pendingButtons = [];
      pendingActivity = false;

      step(state, inputs, stepParams());
      drainGameEvents();
    };
    const unsubscribe = getSchedulerClock().subscribe(tick);

    // ── CPU rasteriser (Vib-Ribbon line art + DOOM sprites + in-canvas HUD) ─

    function setPx(x: number, y: number, rgb: number[], a = 255): void {
      if (x < 0 || x >= INTERNAL_W || y < 0 || y >= INTERNAL_H) return;
      const p = (y * INTERNAL_W + x) * 4;
      fbBytes[p] = rgb[0]!;
      fbBytes[p + 1] = rgb[1]!;
      fbBytes[p + 2] = rgb[2]!;
      fbBytes[p + 3] = a;
    }

    function drawLine(x0: number, y0: number, x1: number, y1: number, rgb: number[]): void {
      x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
      const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
      const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
      let err = dx - dy;
      let guard = 0;
      while (guard++ < INTERNAL_W * 2) {
        setPx(x0, y0, rgb);
        setPx(x0, y0 + 1, rgb); // 2px thickness
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 > -dy) { err -= dy; x0 += sx; }
        if (e2 < dx) { err += dx; y0 += sy; }
      }
    }

    /** Tiny pixel-font text — the in-canvas HUD mechanism. Scale 4 → 12×20px
     *  glyphs, readable at the 480px card scale. */
    function drawText(text: string, x: number, y: number, scale: number, rgb: number[]): void {
      let cx = x;
      for (const ch of text.toUpperCase()) {
        const rows = FONT[ch];
        if (rows) {
          for (let r = 0; r < 5; r++) {
            const bits = rows[r]!;
            for (let c = 0; c < 3; c++) {
              if (bits & (1 << (2 - c))) {
                for (let dy = 0; dy < scale; dy++) {
                  for (let dx = 0; dx < scale; dx++) {
                    setPx(cx + c * scale + dx, y + r * scale + dy, rgb);
                  }
                }
              }
            }
          }
        }
        cx += 4 * scale;
      }
    }
    function textWidth(text: string, scale: number): number {
      return text.length * 4 * scale - scale;
    }

    function blitSprite(f: SpriteFrame, cx: number, cy: number, scale: number): void {
      const x0 = Math.round(cx - f.leftOffset * scale);
      const y0 = Math.round(cy - f.topOffset * scale);
      const w = Math.round(f.width * scale);
      const h = Math.round(f.height * scale);
      for (let dy = 0; dy < h; dy++) {
        const sy = Math.min(f.height - 1, Math.floor(dy / scale));
        for (let dx = 0; dx < w; dx++) {
          const sx = Math.min(f.width - 1, Math.floor(dx / scale));
          const sp = (sy * f.width + sx) * 4;
          if (f.rgba[sp + 3]! < 128) continue;
          setPx(x0 + dx, y0 + dy, [f.rgba[sp]!, f.rgba[sp + 1]!, f.rgba[sp + 2]!]);
        }
      }
    }

    /** Sprite animation clock — the SCHEDULER tick count, so the animation
     *  phase is deterministic and freezes with the game. */
    function animTick(): number {
      return state.schedTick;
    }

    function spriteForEvent(ev: GibEvent): SpriteFrame | null {
      if (!sprites) return null;
      const dying = ev.resolved && ev.outcome === 'hit' && (ev.kind === 'imp' || ev.kind === 'zombie');
      if (ev.kind === 'imp') return pickFrame(dying ? sprites.impDie : sprites.impWalk, ev, dying);
      if (ev.kind === 'zombie') return pickFrame(dying ? sprites.zombieDie : sprites.zombieWalk, ev, dying);
      return null; // loop/jump events are ribbon deformations, not sprites
    }

    function pickFrame(anim: SpriteFrame[], ev: GibEvent, dying: boolean): SpriteFrame | null {
      if (anim.length === 0) return null;
      if (dying && ev.resolvedTick !== null) {
        const elapsed = Math.max(0, state.tick - ev.resolvedTick);
        return anim[Math.min(anim.length - 1, elapsed)]!;
      }
      return anim[(Math.floor(animTick() / 6) + ev.id) % anim.length]!;
    }

    // ── ribbon geometry ────────────────────────────────────────────────────
    const BASELINE_Y = Math.round(INTERNAL_H * 0.72);
    const MARINE_X = Math.round(INTERNAL_W * 0.30);

    function posToX(pos: number): number {
      // pos 0 → the marine; pos 1 → right edge; pos > 1 (the lookahead
      // buffer) rides in from off-screen.
      return MARINE_X + pos * (INTERNAL_W - MARINE_X - 20);
    }

    function ribbonY(x: number, phase: number): number {
      let y = BASELINE_Y;
      for (const ev of state.events) {
        if (ev.kind !== 'loop' && ev.kind !== 'jump') continue;
        const p = effectivePos(ev, phase);
        if (p < -0.3 || p > 1.05) continue;
        const ex = posToX(p);
        const d = Math.abs(x - ex);
        const reach = 46;
        if (d > reach) continue;
        const t = 1 - d / reach;
        if (ev.kind === 'jump') y -= Math.round(34 * t * t); // hump
        else y += Math.round(30 * t * t); // pit-V
      }
      return y;
    }

    function marineAimOffset(): number {
      return Math.round(-state.aimY * 26);
    }

    function paintFrame(): void {
      const phase = judgePhase(state, stepParams());

      // 1. Background: black, flashed dim-white by a recent hit (engine-owned
      //    flashTicks — deterministic, decays per scheduler tick).
      const bg = state.flashTicks > 0 ? Math.round((state.flashTicks / 8) * 36) : 0;
      for (let i = 0; i < fbBytes.length; i += 4) {
        fbBytes[i] = bg; fbBytes[i + 1] = bg; fbBytes[i + 2] = bg;
      }

      // 2. The white ribbon, deformed by nearby loop/jump events.
      let prevX = 0, prevY = ribbonY(0, phase);
      for (let x = 4; x <= INTERNAL_W; x += 4) {
        const y = ribbonY(x, phase);
        drawLine(prevX, prevY, x, y, COL_RIBBON);
        prevX = x; prevY = y;
      }

      // 3. Enemy sprites, far → near.
      const ordered = [...state.events].sort((a, b) => b.pos - a.pos);
      for (const ev of ordered) {
        if (ev.kind !== 'imp' && ev.kind !== 'zombie') continue;
        const p = effectivePos(ev, phase);
        if (p < -0.3) continue;
        const f = spriteForEvent(ev);
        const sx = posToX(p);
        const sy = ribbonY(sx, phase);
        if (f) blitSprite(f, sx, sy, 1.5);
        else drawDiamond(sx, sy - 14, 9, BTN_COLORS[EVENT_BUTTON[ev.kind]]);
      }

      // 4. The marine.
      paintMarine(phase);

      // 5. The fixed lookahead lane (the readable ~2-bar queue).
      paintLookaheadLane(phase);

      // 6. In-canvas HUD (the GAMES.md-permitted shape: the game's own
      //    artwork, inside the playfield) — including the VISIBLE FORM: the
      //    DOOM status-bar face at the marine's current damage grade.
      paintHud();

      // 6b. DAMAGE VIGNETTE: while painTicks holds, the frame edges flash
      //     red — the unmistakable "you were HIT" (the owner's bug was this
      //     moment being invisible).
      if (state.painTicks > 0 && state.health !== 'dead') {
        const strength = state.painTicks / 40;
        const border = Math.round(10 + 14 * strength);
        const red = [Math.round(140 + 100 * strength), 24, 24];
        for (let d = 0; d < border; d++) {
          for (let x = 0; x < INTERNAL_W; x += 1) {
            setPx(x, d, red); setPx(x, INTERNAL_H - 1 - d, red);
          }
          for (let y = 0; y < INTERNAL_H; y += 1) {
            setPx(d, y, red); setPx(INTERNAL_W - 1 - d, y, red);
          }
        }
      }

      // 7. Overlays: count-in / ATTRACT / GAME OVER.
      if (state.health === 'dead') paintGameOver();
      else if (state.mode === 'play' && state.tick <= GIB_TUNING.countInTicks) paintCountIn();
      if (state.mode === 'attract') paintAttract();
    }

    const LANE_Y = 22;
    const LANE_X0 = 60;
    const LANE_DX = 56;
    const LANE_SLOTS = 4;

    function paintLookaheadLane(phase: number): void {
      drawLine(LANE_X0 - 26, LANE_Y + 18, LANE_X0 + (LANE_SLOTS - 1) * LANE_DX + 26, LANE_Y + 18, COL_LANE);
      drawLine(LANE_X0 - 14, LANE_Y + 18, LANE_X0 - 14, LANE_Y + 24, COL_LANE_TICK);
      drawLine(LANE_X0 + 14, LANE_Y + 18, LANE_X0 + 14, LANE_Y + 24, COL_LANE_TICK);
      const lane = upcomingLane(state, phase, LANE_SLOTS);
      for (let i = 0; i < lane.length; i++) {
        const slot = lane[i]!;
        const cx = LANE_X0 + i * LANE_DX;
        drawButtonGlyph(slot.button, cx, LANE_Y, slot.hot, i === 0 && slot.hot);
        const frac = Math.max(0, Math.min(1, 1 - slot.pos / GIB_TUNING.spawnPos));
        const barW = Math.round(frac * 22);
        drawLine(cx - 11, LANE_Y + 16, cx - 11 + barW, LANE_Y + 16, slot.hot ? COL_PROMPT_HOT : COL_PROMPT);
      }
    }

    /** Damage grade 0..4 for the face (0 = untouched, 4 = at the floor). */
    function faceGrade(): number {
      switch (state.health) {
        case 'super': return 0;
        case 'healthy': return 1;
        case 'wounded': return 2;
        case 'critical': return 3;
        case 'dead': return 4;
      }
    }

    function paintHud(): void {
      // SCORE + combo, top-right of the lane (inside the playfield, painted
      // by the game — the frogger shape, reached by design).
      const score = `SCORE ${state.score}`;
      drawText(score, INTERNAL_W - textWidth(score, 4) - 16, 10, 4, COL_HUD);
      if (state.combo >= 2) {
        const combo = `X${Math.min(GIB_TUNING.maxComboMult, state.combo)}`;
        drawText(combo, INTERNAL_W - textWidth(combo, 4) - 16, 38, 4, COL_PROMPT);
      }
      if (state.health === 'super') {
        drawText('SUPER', INTERNAL_W - textWidth('SUPER', 3) - 16, 66, 3, BTN_COLORS.y);
      }

      // THE VISIBLE FORM — the DOOM status-bar mugshot at the current damage
      // grade (super/healthy grin → wounded → critical → dead), bottom-left
      // of the playfield like the original status bar. This is the Vibri
      // form ladder, cast: the OWNER'S BUG ("marine doesn't die when hit")
      // was the ladder moving with no picture of it anywhere.
      const grade = faceGrade();
      const face = state.health === 'dead' ? stfDead : stfFaces[grade] ?? null;
      const fx = 26;
      const fy = INTERNAL_H - 12;
      if (face) {
        blitSprite(face, fx + Math.round(face.width), fy, 2.2);
      } else {
        // Line-art fallback face: a diamond head whose damage reads at a
        // glance — the mouth droops and the frame reddens per grade.
        const col = grade >= 3 ? BTN_COLORS.b : grade === 2 ? BTN_COLORS.y : COL_HUD;
        const cx = fx + 28;
        const cy = fy - 34;
        drawDiamond(cx, cy, 26, col);
        // eyes
        setPx(cx - 9, cy - 6, col); setPx(cx - 8, cy - 6, col);
        setPx(cx + 8, cy - 6, col); setPx(cx + 9, cy - 6, col);
        // mouth: flat → frown per grade; an X on death.
        if (state.health === 'dead') {
          drawLine(cx - 8, cy + 6, cx + 8, cy + 14, col);
          drawLine(cx - 8, cy + 14, cx + 8, cy + 6, col);
        } else {
          const droop = grade * 3;
          drawLine(cx - 9, cy + 8, cx, cy + 8 + droop, col);
          drawLine(cx, cy + 8 + droop, cx + 9, cy + 8, col);
        }
      }
    }

    function paintCountIn(): void {
      const remaining = Math.max(0, GIB_TUNING.countInTicks - state.tick);
      const cx = Math.round(INTERNAL_W * 0.62);
      const cy = Math.round(INTERNAL_H * 0.34);
      for (let i = 0; i < remaining; i++) drawDiamond(cx, cy, 16 + i * 9, COL_PROMPT);
      drawText('READY', cx - Math.round(textWidth('READY', 4) / 2), cy + 40, 4, COL_PROMPT_HOT);
    }

    function paintAttract(): void {
      // The HONEST label (F3): a self-playing module SAYS it is self-playing,
      // in the frame, where no DOM gate has to see it.
      const t = 'ATTRACT';
      drawText(t, Math.round((INTERNAL_W - textWidth(t, 6)) / 2), Math.round(INTERNAL_H * 0.12), 6, COL_ATTRACT);
    }

    function paintGameOver(): void {
      const cx = Math.round(INTERNAL_W * 0.5);
      const cy = Math.round(INTERNAL_H * 0.40);
      const w = 170, h = 54;
      drawBox(cx - w, cy - h, cx + w, cy + h, BTN_COLORS.b);
      drawBox(cx - w + 4, cy - h + 4, cx + w - 4, cy + h - 4, BTN_COLORS.b);
      const t = 'GAME OVER';
      drawText(t, cx - Math.round(textWidth(t, 6) / 2), cy - 15, 6, BTN_COLORS.b);
      const sub = 'RESTART TO PLAY';
      drawText(sub, cx - Math.round(textWidth(sub, 3) / 2), cy + h + 14, 3, COL_PROMPT);
    }

    function drawBox(x0: number, y0: number, x1: number, y1: number, rgb: number[]): void {
      drawLine(x0, y0, x1, y0, rgb);
      drawLine(x1, y0, x1, y1, rgb);
      drawLine(x1, y1, x0, y1, rgb);
      drawLine(x0, y1, x0, y0, rgb);
    }

    function paintMarine(phase: number): void {
      const baseY = ribbonY(MARINE_X, phase);
      const sy = baseY + marineAimOffset();
      const recentFire = state.events.some(
        (e) => e.resolved && e.outcome === 'hit' && (e.kind === 'imp' || e.kind === 'zombie')
          && e.resolvedTick !== null && state.tick - e.resolvedTick <= 1,
      );
      // Sustained pain form: held by the engine's painTicks (~1 s), not a
      // one-course-tick blink — the visible half of "he got HIT".
      const inPain = state.painTicks > 0;
      const recentHop = state.events.some(
        (e) => e.resolved && e.outcome === 'hit' && (e.kind === 'loop' || e.kind === 'jump')
          && e.resolvedTick !== null && state.tick - e.resolvedTick <= 1,
      );
      const hopY = recentHop ? -22 : 0;
      let f: SpriteFrame | null = null;
      if (sprites) {
        if (state.health === 'dead' && sprites.marineDie.length) {
          f = sprites.marineDie[sprites.marineDie.length - 1]!;
        } else if (recentFire && sprites.marineFire.length) {
          f = sprites.marineFire[Math.floor(animTick() / 4) % sprites.marineFire.length]!;
        } else if (inPain && sprites.marinePain.length) {
          f = sprites.marinePain[0]!;
        } else if (sprites.marineRun.length) {
          f = sprites.marineRun[Math.floor(animTick() / 6) % sprites.marineRun.length]!;
        }
      }
      const my = sy + hopY;
      if (f) {
        blitSprite(f, MARINE_X, my, 1.6);
        if (recentFire) drawLine(MARINE_X + 12, my - 30, MARINE_X + 40, my - 30, COL_PROMPT_HOT);
      } else {
        const col = state.health === 'dead' ? BTN_COLORS.b
          : recentFire ? BTN_COLORS.x
          : recentHop ? BTN_COLORS.a
          : inPain ? BTN_COLORS.b
          : COL_RIBBON;
        drawStickFigure(MARINE_X, my, col);
        if (recentFire) drawLine(MARINE_X + 9, my - 28, MARINE_X + 34, my - 28, COL_PROMPT_HOT);
      }
    }

    function drawDiamond(cx: number, cy: number, r: number, rgb: number[]): void {
      drawLine(cx, cy - r, cx + r, cy, rgb);
      drawLine(cx + r, cy, cx, cy + r, rgb);
      drawLine(cx, cy + r, cx - r, cy, rgb);
      drawLine(cx - r, cy, cx, cy - r, rgb);
    }
    function drawStickFigure(cx: number, baseY: number, rgb: number[]): void {
      // The LINE-ART FORM LADDER (no WAD): the figure itself degrades with
      // the marine's health — the stick-cast of Vibri's rabbit→frog→insect.
      //   super/healthy: full figure · wounded: arms gone (frog) ·
      //   critical: a crawling worm · dead: collapsed.
      const h = state.health;
      if (h === 'dead') {
        drawLine(cx - 16, baseY, cx + 16, baseY, rgb);
        drawDiamond(cx + 20, baseY - 4, 5, rgb);
        return;
      }
      if (h === 'critical') {
        // The worm: a low zig-zag crawl with a small head.
        drawLine(cx - 14, baseY, cx - 5, baseY - 8, rgb);
        drawLine(cx - 5, baseY - 8, cx + 4, baseY, rgb);
        drawLine(cx + 4, baseY, cx + 12, baseY - 6, rgb);
        drawDiamond(cx + 16, baseY - 8, 4, rgb);
        return;
      }
      const headR = 6;
      const top = baseY - (h === 'wounded' ? 30 : 40);
      drawDiamond(cx, top, headR, rgb);
      drawLine(cx, top + headR, cx, baseY - 14, rgb);
      drawLine(cx, baseY - 14, cx - 7, baseY, rgb);
      drawLine(cx, baseY - 14, cx + 7, baseY, rgb);
      if (h !== 'wounded') {
        // Arms only above wounded — the frog stage loses them.
        drawLine(cx, top + 14, cx - 9, top + 22, rgb);
        drawLine(cx, top + 14, cx + 9, top + 22, rgb);
      }
    }
    function drawButtonGlyph(btn: GibButton, cx: number, cy: number, hot: boolean, filled = false): void {
      const col = hot ? COL_PROMPT_HOT : COL_PROMPT;
      const tint = BTN_COLORS[btn];
      const r = hot ? 11 : 9;
      if (filled) {
        for (let dy = -r; dy <= r; dy++) {
          const span = r - Math.abs(dy);
          for (let dx = -span; dx <= span; dx++) setPx(cx + dx, cy + dy, tint);
        }
      }
      drawDiamond(cx, cy, r, tint);
      drawDiamond(cx, cy, r + 2, col);
      const mark = filled ? COL_BG_GLYPH : tint;
      if (btn === 'a') drawLine(cx - 3, cy + 3, cx + 3, cy - 3, mark);
      else if (btn === 'b') drawLine(cx - 3, cy - 3, cx + 3, cy + 3, mark);
      else if (btn === 'x') { drawLine(cx - 3, cy - 3, cx + 3, cy + 3, mark); drawLine(cx - 3, cy + 3, cx + 3, cy - 3, mark); }
      else { drawLine(cx, cy - 3, cx, cy + 3, mark); drawLine(cx, cy, cx - 3, cy - 3, mark); drawLine(cx, cy, cx + 3, cy - 3, mark); }
    }

    function uploadFramebuffer(): void {
      gl.bindTexture(gl.TEXTURE_2D, sourceTex);
      gl.texSubImage2D(
        gl.TEXTURE_2D, 0, 0, 0, INTERNAL_W, INTERNAL_H, gl.RGBA, gl.UNSIGNED_BYTE,
        new Uint8Array(fbBytes.buffer, fbBytes.byteOffset, fbBytes.byteLength),
      );
    }

    // First frame so consumers + previews have content immediately.
    paintFrame();
    uploadFramebuffer();

    const surface: VideoNodeSurface = {
      fbo,
      texture,
      draw(frame) {
        // ⚠ RENDER ONLY — the game advances exclusively in the scheduler
        // tick. The paint is a pure function of the engine state (positions
        // interpolate on the tick-derived phase, animation runs on the
        // scheduler tick count), so a frame rate can neither move the
        // judgement window (#635's class, unrepresentable) nor desync the
        // picture from the judge, and a frozen stepper is a frozen picture.
        paintFrame();
        uploadFramebuffer();

        const g = frame.gl;
        g.bindFramebuffer(g.FRAMEBUFFER, fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.useProgram(program);
        g.activeTexture(g.TEXTURE0);
        g.bindTexture(g.TEXTURE_2D, sourceTex);
        g.uniform1i(uTex, 0);
        g.uniform2f(uLetterbox, letterboxU, letterboxV);
        ctx.drawFullscreenQuad();
        g.bindFramebuffer(g.FRAMEBUFFER, null);
      },
      dispose() {
        gl.deleteFramebuffer(fbo);
        gl.deleteTexture(texture);
        gl.deleteTexture(sourceTex);
        gl.deleteProgram(program);
        for (const src of [hitGate, missGate, fireGate, killGate, gameoverGate, healthCv]) {
          if (!src) continue;
          try { src.stop(); } catch { /* */ }
          try { src.disconnect(); } catch { /* */ }
        }
      },
    };

    function pushRestart(): void {
      pendingRestartEdges += 1;
      noteActivity();
    }

    function laneSnapshot(): { button: GibButton; kind: GibEventKind; pos: number; hot: boolean }[] {
      const phase = judgePhase(state, stepParams());
      return upcomingLane(state, phase).map((s) => ({
        button: s.button, kind: s.kind, pos: s.pos, hot: s.hot,
      }));
    }

    const extras: GibribbonHandleExtras = {
      snapshot: () => fbImage,
      getScore: () => state.score,
      getHealth: () => state.health,
      getCombo: () => state.combo,
      getMode: () => state.mode,
      loadError: () => loadErr,
      pushButton(button) {
        if (pendingButtons.length < 16) pendingButtons.push(button);
        noteActivity();
        return true;
      },
      pushRestart,
      getLane: laneSnapshot,
      isDead: () => isGameOver(state),
      reset: pushRestart,
      forcePulse(port) { pulseGate(gateFor(port), port); },
    };

    return {
      domain: 'video',
      surface,
      audioSources,
      audioInputs,
      setParam(paramId, value) {
        const prev = (params as Record<string, number>)[paramId];
        if (paramId in params) (params as Record<string, number>)[paramId] = value;

        // Edge-detected discrete inputs → the pending queues the ONE stepper
        // drains. No state mutation happens here (the #635 lesson: setParam
        // is a sampling seam, not a second clock).
        if (paramId === 'restart_btn') {
          const ev = detectEdge(restartEdge, value);
          if (ev && ev.pressed) pushRestart();
          return;
        }
        if (paramId === 'btn_a' || paramId === 'btn_b' || paramId === 'btn_x' || paramId === 'btn_y') {
          const btn: GibButton = paramId === 'btn_a' ? 'a' : paramId === 'btn_b' ? 'b' : paramId === 'btn_x' ? 'x' : 'y';
          const ev = detectEdge(buttonEdges[btn], value);
          if (ev && ev.pressed) {
            if (pendingButtons.length < 16) pendingButtons.push(btn);
            noteActivity();
          }
          return;
        }
        // Sampled continuous inputs: a MOVING axis is player activity
        // (the attract-mode idle proxy); a still one is not. (Moving AUDIO
        // is detected at the analyser fold, in hearBands.)
        if (
          (paramId === 'axis_x' || paramId === 'axis_y')
          && typeof prev === 'number'
          && Math.abs(value - prev) > ACTIVITY_EPS
        ) {
          noteActivity();
        }
      },
      readParam(paramId) {
        return (params as Record<string, number>)[paramId];
      },
      read(key) {
        if (key === 'extras') return extras;
        if (key === 'snapshot') return fbImage;
        if (key === 'score') return state.score;
        if (key === 'health') return state.health;
        if (key === 'combo') return state.combo;
        if (key === 'mode') return state.mode;
        if (key === 'loadError') return loadErr;
        if (key === 'lane') return laneSnapshot();
        if (key === 'dead') return isGameOver(state);
        if (key === 'tick') return state.tick;
        if (key === 'schedTick') return state.schedTick;
        if (key === 'presses') return state.presses;
        if (key === 'spritesReady') return sprites !== null;
        return undefined;
      },
      subscribePulse(portId, cb) {
        let set = pulseSubscribers.get(portId);
        if (!set) { set = new Set(); pulseSubscribers.set(portId, set); }
        set.add(cb);
        return () => {
          const s = pulseSubscribers.get(portId);
          if (!s) return;
          s.delete(cb);
          if (s.size === 0) pulseSubscribers.delete(portId);
        };
      },
      dispose() {
        unsubscribe();
        surface.dispose();
      },
    };
  },
};
