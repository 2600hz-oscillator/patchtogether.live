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
//   initialTime — seconds-per-level (10..120, default 60). Knob-only +
//                 MIDI-learnable via the shared Knob component on the card.
//
// vizPassthrough: true — the card's <canvas data-viz-passthrough> can be
// portaled into a containing GroupCard for cross-domain video output (same
// mechanism MODTRIS/PONG/SCOPE use). A dedicated video_out port is
// intentionally NOT exposed here — Frogger is audio-domain like its game-
// module siblings, and the cross-domain bridge already covers "make the
// canvas visible downstream" without inventing a one-off port type.
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
//   initialTime (linear 10..120, default DEFAULT_TIME): seconds-per-life timer ceiling.

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
  schemaVersion: 1,
  vizPassthrough: true,
  ossAttribution: { author: 'Adrian Eyre (frogger, MIT)' },

  inputs: [
    { id: 'up_gate',    type: 'gate' },
    { id: 'down_gate',  type: 'gate' },
    { id: 'left_gate',  type: 'gate' },
    { id: 'right_gate', type: 'gate' },
    // start_gate auto-fires once on first tick after module-spawn (BOOT NOTE
    // below). A rising edge re-starts the game at any time.
    { id: 'start_gate', type: 'gate' },
  ],
  outputs: [
    { id: 'home_gate',  type: 'gate' },
    { id: 'dead_gate',  type: 'gate' },
    { id: 'level_gate', type: 'gate' },
  ],
  params: [
    { id: 'initialTime', label: 'Time', defaultValue: DEFAULT_TIME, min: 10, max: 120, curve: 'linear' },
  ],

  docs: {
    explanation:
      "A playable Frogger arcade game wrapped as a CV/gate module — the gameplay IS the patch's modulation source. A frog at the bottom hops up a 13-row board (grass banks → a 5-lane road of cars/lorries → a river of logs/turtles → the five home pads at the top), avoiding traffic and drowning, before a per-life timer runs out. You DON'T touch the card to play — you patch gates into its four direction inputs (a sequencer, clock, LFO-through-comparator, or manual gate buttons drive the frog), and the game emits gate pulses on the events it produces: every home pad reached, every death, and every level cleared. So a clock pattern steering the frog becomes a generative trigger source whose rhythm depends on how the game unfolds. The game auto-starts once when the module is first placed (a synthetic START pulse) so you see it running immediately; the START input restarts it any time. The board renders on the card's 2D canvas and, because the module is vizPassthrough, that canvas can be portaled into a containing GROUP card for cross-domain video — there is no dedicated video output port. The TIME knob sets the per-life countdown ceiling.",
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
        "The per-life countdown ceiling in seconds (10..120, default 60) — how long the frog has before the timer runs out and DEAD fires. Lower it for a frantic game (faster death pulses), raise it for a relaxed run. MIDI-learnable via the on-card knob.",
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
    const tick = () => {
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
