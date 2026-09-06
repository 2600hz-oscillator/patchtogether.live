// packages/web/src/lib/audio/modules/frogger.ts
//
// FROGGER — clean-room TypeScript port of Adrian Eyre's Frogger
// (github.com/adrianeyre/frogger, MIT-licensed). Lifted out of the upstream
// React UI into a pure-stepper (frogger-state.ts) wrapped here as a
// CV-gate-driven module. Mirrors the MODTRIS topology — scheduler-clock
// driven, analyser-tap gate-in edge detection, ConstantSourceNode gate-out,
// 2D canvas on the card.
//
// CV INPUTS (gate, rising-edge, all 5):
//   up_gate / down_gate / left_gate / right_gate — frog movement.
//   start_gate — start a new game (auto-fires once on first tick after
//                module-spawn so the user sees a running game by default;
//                see "BOOT NOTE" in the factory). "Boot" here = module
//                spawn, NOT page load — same node persists across page
//                reloads (Yjs-synced patch state) but re-firing the auto-
//                start on a reload would clobber an in-progress game, so
//                we tie the auto-start to the per-instance factory call.
//
// GATE OUTPUTS:
//   home_gate  — pulses once per HOME slot reached (a level fires up to 5).
//   dead_gate  — pulses once per frog death.
//   level_gate — pulses once per level cleared (all 5 homes filled).
//
// PARAMS:
//   initialTime — seconds-per-life ceiling (10..120, default 60). LIVE: it is
//                 re-resolved every scheduler tick, so a knob move reaches the
//                 running game (see resolveDefaultTime in frogger-state.ts).
//
// The board's home is the DOCK FACEPLATE BODY (see `face.extension` below).
//
// A dedicated video_out port is intentionally NOT exposed — Frogger is
// audio-domain like its game-module siblings.
//
// Inputs:
//   up_gate / down_gate / left_gate / right_gate (gate): rising-edge frog movement.
//   start_gate (gate): rising edge starts a new game (auto-fires once on factory init).
//
// Outputs:
//   home_gate (gate): one 5 ms pulse when the frog reaches a home pad.
//   dead_gate (gate): one 5 ms pulse when the frog dies.
//   level_gate (gate): one 5 ms pulse when the player completes a level.
//
// Params:
//   initialTime (linear 10..120, default DEFAULT_TIME): LIVE seconds-per-life timer ceiling.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { getSchedulerClock, SCHEDULER_TICK_MS } from '$lib/audio/scheduler-clock';
import {
  initFroggerState,
  stepFroggerState,
  detectRisingEdge,
  DEFAULT_TIME,
  type FroggerInputs,
  type FroggerParams,
  type FroggerState,
} from './frogger-state';

export type { FroggerState, FroggerParams } from './frogger-state';
export {
  COLS, ROWS, Direction, SpriteType, SpriteImage,
  INITIAL_PLAYER_X, INITIAL_PLAYER_Y,
} from './frogger-state';

/** Gate pulse width in seconds. Matches MODTRIS / PONG / BUGGLES. */
const GATE_PULSE_S = 0.005;
/** Spacer between back-to-back pulses on the same gate (the upstream game
 *  can in principle fire multiple home-events in one step if a movement
 *  triggers a cascade; we pulse-stagger so consumers see distinct edges). */
const GATE_SPACER_S = 0.005;
/** Schedule cushion — same rationale as MODTRIS. */
const SCHEDULE_CUSHION_S = 0.005;

export const froggerDef: AudioModuleDef = {
  type: 'frogger',
  palette: { top: 'Games', sub: 'Arcade' },
  domain: 'audio',
  label: 'frogger',
  category: 'games',
  ossAttribution: { author: 'Adrian Eyre (frogger, MIT)' },

  inputs: [
    { id: 'up_gate',    type: 'gate', edge: 'trigger' },
    { id: 'down_gate',  type: 'gate', edge: 'trigger' },
    { id: 'left_gate',  type: 'gate', edge: 'trigger' },
    { id: 'right_gate', type: 'gate', edge: 'trigger' },
    // start_gate auto-fires once on first tick after module-spawn (BOOT NOTE
    // below). A rising edge re-starts the game at any time.
    { id: 'start_gate', type: 'gate', edge: 'trigger' },
  ],
  outputs: [
    { id: 'home_gate',  type: 'gate', edge: 'trigger' },
    { id: 'dead_gate',  type: 'gate', edge: 'trigger' },
    { id: 'level_gate', type: 'gate', edge: 'trigger' },
  ],
  params: [
    { id: 'initialTime', label: 'Time', defaultValue: DEFAULT_TIME, min: 10, max: 120, curve: 'linear' },
  ],

  // ── THE FACEPLATE ────────────────────────────────────────────────────────
  //
  // THE TIER LADDER, read back as a sentence: at mini you get TIME; at compact,
  // TIME; at plate, TIME; at the dock, TIME plus THE BOARD. It is the same
  // sentence at every tier, and on a one-param module that is the correct
  // outcome rather than a defect — derived through `curatedFace` in
  // frogger-face-model.test.ts, never read off the cap constants.
  //
  // ⚠ THE RANK IS NOT A JUDGEMENT — there is one param — BUT THE ARGUMENT
  // STILL HAS TO BE MADE, because the alternative was not ranking it at all.
  // On a module whose three outputs are GATES, `initialTime` is the one control
  // that changes the OUTPUT RATE: it is the ceiling on how long a life lasts,
  // so it bounds the period of `dead_gate` in the degenerate case (nothing
  // patched into the steering inputs, the frog sits still, and DEAD fires every
  // `initialTime` seconds like a very slow LFO). That behaviour is real,
  // reachable and musically useful, and it is the strongest thing this control
  // does. ⚠ It is also only true SINCE THIS PR — the knob was inert mid-game
  // until the `resolveDefaultTime` fix in frogger-state.ts. Ranking around a
  // defect being fixed in the same diff would bake the defect into the UI.
  //
  // THE LOSER, NAMED: there is none, and saying so is the point — a reviewer
  // should be able to confirm the absence rather than infer it.
  //
  // ⚠ `glyph: 'none'` IS ALL BUT FORCED HERE, and the "all but" is measured
  // rather than hedged — the sibling faces that declare `'none'` genuinely
  // CHOSE it, and it would be easy to write the same sentence here and be
  // wrong. All three outputs are `type: 'gate'`, so `primaryAudioOutPortId` is
  // NULL and every LIVE glyph kind — scope, meter, envelope, waveform — resolves
  // `{kind:'static'}` and is refused by the dead-glyph clause. Exactly one kind
  // still resolves: `'algorithm'` binds `{layoutSource:'frogger', paramId:null}`
  // since #2160 widened it. It is refused anyway, and on its own merits: a null
  // `paramId` means the shell feeds `topologyValue: 0`, and
  // `ShellExtensionGlyphProps` is `{num, numbers?, testid?}` with NO `nodeId`,
  // so the component could not resolve a graph node and could not reach the
  // game snapshot. It would be a CONSTANT picture, identical on every frogger
  // in the rack forever — which is not a picture of this module. The lane tile
  // is therefore one knob and no board. Pinned both ways in
  // frogger-face-model.test.ts, including the counterfactual.
  face: {
    order: ['initialTime'],
    glyph: 'none',
    // ONE band, ONE control, and `order` and `pages` therefore AGREE — unusual
    // for this house style, and stated so a reader does not go hunting for the
    // disagreement. There is no second idea to page and a rail needs
    // DOCK_TAB_MIN_BANDS = 7 bands, so a tab rail is structurally out of reach.
    //
    // ⚠ THE HEADER IS A TASTE CALL AND IT IS DECLARED DELIBERATELY. The house
    // rule is that a page earns a header at >= 2 controls, or 1 that is the
    // module's identity — and `initialTime` is NOT frogger's identity, the
    // BOARD is. The one-line revert is to drop `pages` entirely and let the
    // dock render one unlabelled band (the `4plexvid` / `rasterize` shape). It
    // is kept because a single knob floating under a game board with no
    // section header reads as a stray control rather than a setting.
    pages: [{ id: 'run', label: 'run', controls: ['initialTime'] }],
    // The board. See $lib/ui/modules/frogger/shell-extension.ts.
    extension: 'frogger',
    // ⚠ AUTHORED RATHER THAN DERIVED. All five inputs are `gate` with NO
    // `paramTarget` — they are the module's real signal inputs, not CV holes
    // for a ranked param — so the input rail would get no page-derived section
    // and would be five anonymous jacks. Grouped, the rail says what the module
    // IS: four steering triggers and a restart. The OUTPUT rail takes the
    // derived default (all three are `gate`, one section).
    // ⚠ THE IDS ARE NOT FREE. An input group must claim the LEADING slot
    // ('voice'/'signal') or name a declared page, or it appends as a stray band
    // after every page and the rear totality gate cannot see it
    // (module-face-lint). So the four steering triggers take the leading
    // 'signal' slot — they ARE the module's signal inputs, the thing you play
    // it with — and START takes the 'run' page's own slot, where it sits beside
    // the TIME knob that shares that band. That is the module described in two
    // sections rather than five anonymous gates.
    rear: {
      groups: [
        { id: 'signal', label: 'steer', ports: ['up_gate', 'down_gate', 'left_gate', 'right_gate'] },
        { id: 'run', label: 'run', ports: ['start_gate'] },
      ],
    },
  },

  docs: {
    explanation:
      "A playable Frogger arcade game wrapped as a CV/gate module — the gameplay IS the patch's modulation source. A frog at the bottom hops up a 13-row board (grass banks → a 5-lane road of cars/lorries → a river of logs/turtles → the five home pads at the top), avoiding traffic and drowning, before a per-life timer runs out. you DON'T touch the faceplate to play — you patch gates into its four direction inputs (a sequencer, clock, LFO-through-comparator, or manual gate buttons drive the frog), and the game emits gate pulses on the events it produces: every home pad reached, every death, and every level cleared. So a clock pattern steering the frog becomes a generative trigger source whose rhythm depends on how the game unfolds. The game auto-starts once when the module is first placed (a synthetic START pulse) so you see it running immediately; the START input restarts it any time. The board renders on a 2D canvas at the head of the module\'s dock faceplate, and there is no video output port — FROGGER speaks in gates, and the board is how you read what it is saying. The TIME knob sets the per-life countdown ceiling: lowering it shortens the life already in progress, so it is the direct control over how often DEAD fires when nothing is steering the frog.",
    inputs: {
      up_gate:
        "Move the frog UP one row on each rising edge — one hop toward the home pads per pulse (the move only fires on the gate's leading edge, so a held-high gate hops once, not continuously).",
      down_gate: "Move the frog DOWN one row on each rising edge — one hop back toward the start bank per pulse.",
      left_gate: "Move the frog LEFT one column on each rising edge — one hop per pulse.",
      right_gate: "Move the frog RIGHT one column on each rising edge — one hop per pulse.",
      start_gate:
        "Start a fresh game on each rising edge — resets the board, lives, score and timer and begins a new run. One synthetic pulse is auto-fired the first time the module is placed (so a game is already running by default); after that, pulse this to restart at any time (e.g. wire DEAD or LEVEL back here for an endless self-restarting loop).",
    },
    outputs: {
      home_gate:
        "Fires a 5 ms pulse each time the frog reaches a home pad — if a single move scores more than one home (e.g. the last pad completing a level), it emits that many distinct staggered pulses so a downstream counter or envelope sees each one. Patch into a drum/envelope trigger to sonify successful crossings.",
      dead_gate:
        "Fires a single 5 ms pulse each time the frog dies (hit by traffic, drowned in the river, or the life timer expired). A trigger you can route to a crash sound, a sample, or back into START for auto-restart.",
      level_gate:
        "Fires a single 5 ms pulse each time a level is cleared (all five home pads filled). Use it as a progression trigger — bump a sequence, change a scene, or fire a fanfare.",
    },
    controls: {
      initialTime:
        "The per-life countdown ceiling in seconds (10..120, default 60) — how long the frog has before the timer runs out and DEAD fires. Lower it for a frantic game (faster death pulses), raise it for a relaxed run. It applies to the RUNNING game: lowering it clamps the life already in progress down to the new ceiling straight away, while raising it takes effect on the next life rather than extending a countdown under you. Clearing a level still costs 5 s of ceiling (floored at 10 s), and that difficulty ramp is measured from wherever you have since moved this knob to. MIDI-learnable.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    // ---- Gate-in analyser taps -----------------------------------------
    // Same pattern as MODTRIS — one small-fftSize AnalyserNode per gate.
    function makeGateTap() {
      const a = ctx.createAnalyser();
      a.fftSize = 32;
      a.smoothingTimeConstant = 0;
      const buf = new Float32Array(32);
      return {
        node: a,
        read(): number {
          a.getFloatTimeDomainData(buf);
          return buf[buf.length - 1] ?? 0;
        },
      };
    }
    const upTap    = makeGateTap();
    const downTap  = makeGateTap();
    const leftTap  = makeGateTap();
    const rightTap = makeGateTap();
    const startTap = makeGateTap();
    let lastUp = 0, lastDown = 0, lastLeft = 0, lastRight = 0, lastStart = 0;

    // ---- Gate outputs --------------------------------------------------
    const homeSrc = ctx.createConstantSource();  homeSrc.offset.value = 0;  homeSrc.start();
    const deadSrc = ctx.createConstantSource();  deadSrc.offset.value = 0;  deadSrc.start();
    const levelSrc = ctx.createConstantSource(); levelSrc.offset.value = 0; levelSrc.start();

    function pulseGateNTimes(src: ConstantSourceNode, n: number): void {
      if (n <= 0) return;
      const t0 = ctx.currentTime + SCHEDULE_CUSHION_S;
      try { src.offset.cancelScheduledValues(t0); } catch { /* */ }
      for (let i = 0; i < n; i++) {
        const t = t0 + i * (GATE_PULSE_S + GATE_SPACER_S);
        src.offset.setValueAtTime(1, t);
        src.offset.setValueAtTime(0, t + GATE_PULSE_S);
      }
    }
    function pulseGateOnce(src: ConstantSourceNode): void {
      pulseGateNTimes(src, 1);
    }

    // ---- Params + state ------------------------------------------------
    const params: FroggerParams = {
      initialTime: (node.params ?? {}).initialTime ?? DEFAULT_TIME,
    };
    let state: FroggerState = initFroggerState(params);

    // BOOT NOTE: auto-fire one synthetic start_gate pulse on the first
    // scheduler tick after this factory runs. Why a synthetic pulse instead
    // of just calling startGame() at construction time?
    //   * The upstream React Frogger shows an InfoBoard ("Click Start Game")
    //     before isGameInPlay=true; the user is the one who advances past
    //     the menu. The owner spec for this port says "if there's kb nav
    //     needed to get into the game state try to figure it out and have a
    //     gate that starts a new game on boot" — so start_gate IS the
    //     equivalent of clicking that button, and the auto-fire is a one-
    //     shot synthesized rising edge on the same gate.
    //   * Doing it via the same code path as a CV-driven start gate (rather
    //     than calling startGame() directly) means the boot path is tested
    //     by the same gate-rising-edge test that covers user-driven restarts
    //     — one code path, one test.
    // We arm the auto-fire here and consume it in the first scheduler tick.
    let pendingAutoStart = true;

    // ---- Scheduler tick subscription -----------------------------------
    const dtSeconds = SCHEDULER_TICK_MS / 1000;

    // ── THE VRT TICK PIN — the "deterministic-time test hook" the module's
    //    own EXEMPT_FROM_VRT entry named as its exit condition ─────────────
    //
    // `vrt-exemptions.ts` said, verbatim: "Promote to a real VRT baseline once
    // a deterministic-time test hook is added so the scene can freeze the game
    // at a known tick." This is it, and it is unusually small here for one
    // reason no sibling shares: FROGGER HAS NO RNG AT ALL. There is not one
    // `Math.random` in `frogger-state.ts` — the sprite table is a fixed clone,
    // the traffic is deterministic, and `dtSeconds` is a constant — so the
    // board is already a pure function of TICK COUNT and there is nothing to
    // seed. The only nondeterminism is HOW MANY TICKS elapsed before the
    // capture, and that is exactly what this pins.
    //
    // ⚠ IT SUPPRESSES THE SIM RATHER THAN FREEZING IT, which is strictly
    // stronger and is pong's / lushgarden's shape. A freeze holds WHICHEVER
    // frame the harness happened to catch, and "which frame" is a function of
    // boot speed — measured on pong at 72 differing pixels across two ubuntu
    // boots WITH a seed. Running a FIXED number of ticks and then never
    // ticking again makes the board TIME-INVARIANT: the same picture no matter
    // when the capture lands.
    //
    // ⚠ AND A `freeze` ParamDef WAS CONSIDERED AND REFUSED, on the roster's own
    // measured rule (`_shell-faces.ts`, 2026-08-25): a `params` edit is in the
    // WebGL attest basis AND in contract-lock, so it costs an owner-machine
    // re-attest plus a contract re-pin, and it buys only intra-boot stillness.
    // A boot-time global costs neither and buys time-invariance. Reach for a
    // ParamDef only when no boot-time global can reach the seam — a WORKER
    // `renderLocus` is that case, and frogger's factory is main-thread.
    //
    // ⚠ IT IS READ TWICE, AT CONSTRUCTION AND ONCE MORE IN THE TICK, because
    // the two capture paths install it at different moments. The FACE harness
    // uses `simPin`, i.e. `addInitScript` BEFORE `goto`, so the global is
    // already there when this factory runs. The CARD harness (`vrt-scenes.ts`)
    // sets it from `afterSpawn`, i.e. AFTER construction. A construction-only
    // read would leave the card scene silently unpinned — a dead pin that
    // produces a plausible picture and a different one per boot, which is the
    // precise failure `bootWithFace` asserts against.
    //
    // ⚠ NOTHING ABOUT THE SHIPPED GAME CHANGES: nothing in the app ever sets
    // `__froggerVrtTicks`.
    //
    // ⚠ DOOM IS EXCLUDED FROM THIS MECHANISM BY NAME. It is the one other game
    // module in the tree and it must never be re-timed: `runtime.runTic()` is
    // called inside its `surface.draw`, so DOOM's game clock IS its frame
    // clock and pinning ticks would re-specify how far the marine walks. No
    // DOOM file is touched by this change and none should be.
    let vrtPinned = false;
    function readVrtTickPin(): number | undefined {
      const v = (globalThis as { __froggerVrtTicks?: number }).__froggerVrtTicks;
      return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined;
    }
    function applyVrtTickPin(ticks: number): void {
      // Rebuild from scratch so the pin is a pure function of (ticks, params)
      // and not of however many real ticks already landed.
      state = initFroggerState(params);
      // Tick 1 carries the synthetic auto-start, exactly as a live boot does —
      // ONE code path for the pinned board and the played one.
      for (let i = 0; i < ticks; i++) {
        state = stepFroggerState(state, {
          up: false, down: false, left: false, right: false, start: i === 0,
        }, params, dtSeconds);
      }
      pendingAutoStart = false;
      vrtPinned = true;
    }
    const bootPin = readVrtTickPin();
    if (bootPin !== undefined) applyVrtTickPin(bootPin);

    const tick = () => {
      // ⚠ THE PIN COMES FIRST AND RETURNS. Letting the clock advance the board
      // even once re-introduces the boot-speed dependence the pin exists to
      // remove. This is the "suppress all further stepping" half, not a second
      // freeze.
      if (vrtPinned) return;
      // The LATE install (the card scene's `afterSpawn`). One-shot: once it
      // fires, the branch above owns every subsequent tick.
      const latePin = readVrtTickPin();
      if (latePin !== undefined) {
        applyVrtTickPin(latePin);
        return;
      }
      const u = upTap.read(),    d = downTap.read(),  l = leftTap.read();
      const r = rightTap.read(), s = startTap.read();
      // Real CV edges.
      let upEdge    = detectRisingEdge(lastUp,    u);
      let downEdge  = detectRisingEdge(lastDown,  d);
      let leftEdge  = detectRisingEdge(lastLeft,  l);
      let rightEdge = detectRisingEdge(lastRight, r);
      let startEdge = detectRisingEdge(lastStart, s);
      lastUp = u; lastDown = d; lastLeft = l; lastRight = r; lastStart = s;

      // Synthetic auto-start on the first tick. We OR it into the real
      // start-gate edge so the stepper's existing inputs.start handler does
      // the work — no special-cased boot branch in the stepper.
      if (pendingAutoStart) {
        startEdge = true;
        pendingAutoStart = false;
      }

      const inputs: FroggerInputs = {
        up: upEdge,
        down: downEdge,
        left: leftEdge,
        right: rightEdge,
        start: startEdge,
      };
      state = stepFroggerState(state, inputs, params, dtSeconds);

      if (state.events.homesScored > 0) {
        pulseGateNTimes(homeSrc, state.events.homesScored);
      }
      if (state.events.died) {
        pulseGateOnce(deadSrc);
      }
      if (state.events.levelComplete) {
        pulseGateOnce(levelSrc);
      }
    };
    const unsubscribe = getSchedulerClock().subscribe(tick);

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['up_gate',    { node: upTap.node,    input: 0 }],
        ['down_gate',  { node: downTap.node,  input: 0 }],
        ['left_gate',  { node: leftTap.node,  input: 0 }],
        ['right_gate', { node: rightTap.node, input: 0 }],
        ['start_gate', { node: startTap.node, input: 0 }],
      ]),
      outputs: new Map([
        ['home_gate',  { node: homeSrc,  output: 0 }],
        ['dead_gate',  { node: deadSrc,  output: 0 }],
        ['level_gate', { node: levelSrc, output: 0 }],
      ]),
      setParam(paramId, value) {
        if (paramId === 'initialTime') {
          params.initialTime = value;
        }
      },
      readParam(paramId) {
        if (paramId === 'initialTime') return params.initialTime;
        return undefined;
      },
      read(key) {
        if (key === 'snapshot') return state;
        return undefined;
      },
      dispose() {
        unsubscribe();
        try { homeSrc.stop();  } catch { /* */ }
        try { deadSrc.stop();  } catch { /* */ }
        try { levelSrc.stop(); } catch { /* */ }
        homeSrc.disconnect();
        deadSrc.disconnect();
        levelSrc.disconnect();
        upTap.node.disconnect();
        downTap.node.disconnect();
        leftTap.node.disconnect();
        rightTap.node.disconnect();
        startTap.node.disconnect();
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Pure draw function — shared between the on-card 2D canvas and any future
// cross-domain video bridge. Simple flat-color sprite renderer; no PNG assets
// (the upstream's 200 KB of player/car/log PNGs would balloon the bundle for
// no real gain on a 14×13 grid). Pixel-art aesthetic comes from drawing each
// grid cell as a solid color block + a small outline.
// ---------------------------------------------------------------------------

import { SpriteType as ST, Direction as Dir } from './frogger-state';

const COLOR_BG_GRASS    = '#1a4f1a';    // y=7 + y=13 safe banks
const COLOR_BG_ROAD     = '#1a1a1a';    // y∈[8,12]
const COLOR_BG_WATER    = '#0f2a55';    // y∈[2,6]
const COLOR_BG_HOMES    = '#0d2410';    // y=1 + the walls between homes
const COLOR_HOME_OPEN   = '#3b6e3b';    // y=1 home slot (frog hasn't landed)
const COLOR_HOME_FILLED = '#f0d030';    // y=1 home slot (frog landed)
const COLOR_OUTLINE     = '#000';
const COLOR_PLAYER      = '#39e639';    // bright frog green
const COLOR_PLAYER_EYE  = '#000';
const COLOR_HUD_TEXT    = '#dafff7';

const COLOR_VEHICLE: Record<string, string> = {
  car1: '#ff5050',     // red
  car2: '#5060ff',     // blue
  car3: '#ffd040',     // yellow
  car4: '#a040ff',     // purple
  lorryFront: '#d07020',
  lorryBack:  '#d07020',
};
const COLOR_RAFT: Record<string, string> = {
  turtle:    '#3aa340',
  logLeft:   '#7a4f25',
  logCentre: '#7a4f25',
  logRight:  '#7a4f25',
};

export interface FroggerDrawOpts {
  /** When true (default), draw the HUD strip (lives / level / time / score
   *  / "press start" banner) above the play area. Tests that just want the
   *  game-grid pass false. */
  hud?: boolean;
}

export function drawFrogger(
  ctx2d: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  state: FroggerState,
  w: number,
  h: number,
  opts: FroggerDrawOpts = {},
): void {
  const hud = opts.hud !== false;
  const HUD_H = hud ? 22 : 0;
  const gridH = h - HUD_H;
  // Cell size from the smaller of (w/COLS, gridH/ROWS). The grid is 14 wide
  // × 13 tall (slightly wider than 4:3), so most canvas aspect ratios land
  // height-bound.
  const cellPx = Math.floor(Math.min(w / 14, gridH / 13));
  const gridW = cellPx * 14;
  const gridYStart = HUD_H + Math.floor((gridH - cellPx * 13) / 2);
  const gridXStart = Math.floor((w - gridW) / 2);

  // Background fill (HUD area).
  ctx2d.fillStyle = '#070b12';
  ctx2d.fillRect(0, 0, w, h);

  // Per-row backgrounds (1-indexed y).
  for (let y = 1; y <= 13; y++) {
    let bg = COLOR_BG_GRASS;
    if (y === 1) bg = COLOR_BG_HOMES;
    else if (y >= 2 && y <= 6) bg = COLOR_BG_WATER;
    else if (y >= 8 && y <= 12) bg = COLOR_BG_ROAD;
    // y=7 + y=13 stay grass.
    ctx2d.fillStyle = bg;
    ctx2d.fillRect(gridXStart, gridYStart + (y - 1) * cellPx, gridW, cellPx);
  }

  // y=1 home-row: 5 open slots over a darker base. Slot centers match the
  // upstream's isHomeSlot ranges (1-2, 4-5, 7-8, 10-11, 13-14 → 2 cells wide
  // each, separated by 1-cell walls).
  const HOME_RANGES: Array<[number, number, number]> = [
    [1, 2, 5],   // x range, HOME_ID
    [4, 5, 6],
    [7, 8, 7],
    [10, 11, 8],
    [13, 14, 9],
  ];
  for (const [x0, x1, kind] of HOME_RANGES) {
    const filled = state.sprites.some((s) => s.key === `player-home-${kind}` && s.visable);
    ctx2d.fillStyle = filled ? COLOR_HOME_FILLED : COLOR_HOME_OPEN;
    ctx2d.fillRect(gridXStart + (x0 - 1) * cellPx, gridYStart, (x1 - x0 + 1) * cellPx, cellPx);
    ctx2d.strokeStyle = COLOR_OUTLINE;
    ctx2d.lineWidth = 1;
    ctx2d.strokeRect(gridXStart + (x0 - 1) * cellPx + 0.5, gridYStart + 0.5, (x1 - x0 + 1) * cellPx - 1, cellPx - 1);
  }

  // Sprites (skip HOMEs — drawn above as the row strip).
  for (const sprite of state.sprites) {
    if (sprite.type === ST.HOME) continue;
    if (!sprite.visable) continue;
    const sx = gridXStart + (sprite.x - 1) * cellPx;
    const sy = gridYStart + (sprite.y - 1) * cellPx;
    let color = '#fff';
    if (sprite.type === ST.VEHICLE) color = COLOR_VEHICLE[sprite.image] ?? '#fff';
    if (sprite.type === ST.RAFT)    color = COLOR_RAFT[sprite.image] ?? '#fff';
    ctx2d.fillStyle = color;
    ctx2d.fillRect(sx + 1, sy + 1, cellPx - 2, cellPx - 2);
    // Tiny direction arrow on the sprite (left/right).
    if (sprite.direction === Dir.LEFT || sprite.direction === Dir.RIGHT) {
      ctx2d.fillStyle = '#000';
      const cy = sy + Math.floor(cellPx / 2);
      const cx = sx + Math.floor(cellPx / 2);
      const halfArrow = Math.max(2, Math.floor(cellPx / 6));
      if (sprite.direction === Dir.LEFT) {
        ctx2d.fillRect(cx - halfArrow, cy, halfArrow * 2, 1);
        ctx2d.fillRect(cx - halfArrow, cy - 1, 1, 3);
      } else {
        ctx2d.fillRect(cx - halfArrow, cy, halfArrow * 2, 1);
        ctx2d.fillRect(cx + halfArrow - 1, cy - 1, 1, 3);
      }
    }
  }

  // Player frog.
  if (state.player.isAlive || !state.isGameInPlay) {
    const px = gridXStart + (state.player.x - 1) * cellPx;
    const py = gridYStart + (state.player.y - 1) * cellPx;
    ctx2d.fillStyle = COLOR_PLAYER;
    ctx2d.fillRect(px + 1, py + 1, cellPx - 2, cellPx - 2);
    // Eyes — two dots towards the current direction.
    ctx2d.fillStyle = COLOR_PLAYER_EYE;
    const cx = px + Math.floor(cellPx / 2);
    const cy = py + Math.floor(cellPx / 2);
    const off = Math.max(1, Math.floor(cellPx / 6));
    const dotSize = Math.max(1, Math.floor(cellPx / 8));
    let ex = cx, ey = cy;
    switch (state.player.direction) {
      case Dir.UP:    ey = py + Math.max(2, Math.floor(cellPx * 0.25)); break;
      case Dir.DOWN:  ey = py + Math.min(cellPx - 4, Math.floor(cellPx * 0.75)); break;
      case Dir.LEFT:  ex = px + Math.max(2, Math.floor(cellPx * 0.25)); break;
      case Dir.RIGHT: ex = px + Math.min(cellPx - 4, Math.floor(cellPx * 0.75)); break;
    }
    ctx2d.fillRect(ex - off - dotSize, ey - dotSize, dotSize, dotSize);
    ctx2d.fillRect(ex + off,           ey - dotSize, dotSize, dotSize);
  }

  // HUD strip.
  if (hud) {
    ctx2d.fillStyle = COLOR_HUD_TEXT;
    ctx2d.font = '700 9px ui-monospace, monospace';
    ctx2d.textBaseline = 'top';
    ctx2d.textAlign = 'left';
    ctx2d.fillText(`LIVES ${state.player.lives}  LV ${state.level}  T ${state.time}`, 4, 6);
    ctx2d.textAlign = 'right';
    ctx2d.fillText(`SCORE ${state.player.score}`, w - 4, 6);
    if (!state.isGameInPlay) {
      ctx2d.textAlign = 'center';
      ctx2d.fillStyle = '#ffd040';
      ctx2d.font = '700 11px ui-monospace, monospace';
      ctx2d.fillText(state.player.lives < 1 ? 'GAME OVER — START GATE TO RESTART' : 'PRESS START', w / 2, gridYStart + (gridH / 2) - 6);
    }
  }
}
