// packages/web/src/lib/audio/modules/frogger-state.ts
//
// Pure deterministic game-state stepper for FROGGER — clean-room TypeScript
// port of Adrian Eyre's Frogger (https://github.com/adrianeyre/frogger,
// MIT-licensed, Copyright (c) 2021 Adrian Eyre). The upstream source is
// React + class-based; this port lifts the gameplay LOGIC out of the React
// component tree and re-expresses it as pure data + step functions so it can
// run inside an AudioModuleDef factory (mirrors how MODTRIS lifts its game
// logic into modtris-state.ts, see that file's header for the rationale).
//
// Upstream files vendored as inspiration (NOT copied verbatim — re-typed +
// adapted to the project's pure-stepper convention):
//   src/classes/game.ts     → step functions below
//   src/classes/player.ts   → player move/collision + reset
//   src/classes/sprite.ts   → sprite move + clash detection
//   src/classes/data/sprites.ts → INITIAL_SPRITES table (positions / images / speeds)
//   src/classes/enums/*.ts  → direction / sprite type / image / result enums
//
// Coordinate system: 14 columns × 13 rows (matching upstream — see the
// constructor's `isValidSpace` clamp: x∈[1,14], y∈[1,13]). y=1 is the home
// row (top), y=13 is the starting row (bottom). y=7 is the bank; y∈[2,6] is
// water (the player needs a raft to survive there); y∈[8,12] is road.
//
// Inputs are gate signals (rising-edge: prev<0.5 && curr≥0.5 — same
// convention used by every other gate-edge detector in the project). The
// factory does the analyser-tap edge detect and passes the booleans here.
//
// "Start gate" semantics: rising edge on the start gate (or the synthetic
// auto-start fired on the first step after init — see ModuleDef factory)
// resets the game to a fresh state with isGameInPlay=true. That's the
// equivalent of the upstream InfoBoard's "Start Game" button: in the upstream
// app, before isGameInPlay is true, key-presses are ignored; we mirror that
// by also dropping movement gates while !isGameInPlay. So "auto-start on
// boot" = synthesize one start_gate pulse on the very first step (this peer's
// module-spawn).

/** Standard Frogger well width (1-indexed in upstream — we keep the same
 *  indexing so the port reads 1:1 against the original). */
export const COLS = 14;
/** Standard Frogger well height (1-indexed). */
export const ROWS = 13;

/** Initial player position (matches upstream Player.INITIAL_PLAYER_X/Y). */
export const INITIAL_PLAYER_X = 7;
export const INITIAL_PLAYER_Y = 13;
/** Initial life count (matches upstream Player.INITIAL_PLAYER_LIVES). */
export const INITIAL_PLAYER_LIVES = 5;
/** Default seconds-per-level timer (matches upstream config.initialTime
 *  default of 60). */
export const DEFAULT_TIME = 60;

// Direction enum (upstream classes/enums/direction-enum.ts).
export enum Direction {
  UP = 0,
  DOWN = 1,
  LEFT = 2,
  RIGHT = 3,
}

// Sprite-type enum (upstream classes/enums/sprite-type-enum.ts).
export enum SpriteType {
  HOME = 0,
  VEHICLE = 1,
  RAFT = 2,
}

// Sprite image kinds. These are display-only labels; the on-card renderer
// maps them to colors/shapes (the upstream PNG sprites would be a 1-2 MB
// asset payload — overkill for a 14×13 grid).
export enum SpriteImage {
  CAR1 = 'car1',
  CAR2 = 'car2',
  CAR3 = 'car3',
  CAR4 = 'car4',
  LORRY_FRONT = 'lorryFront',
  LORRY_BACK = 'lorryBack',
  TURTLE = 'turtle',
  LOG_LEFT = 'logLeft',
  LOG_CENTRE = 'logCentre',
  LOG_RIGHT = 'logRight',
  PLAYER_HOME = 'playerHome',
}

// Player-result enum (upstream classes/enums/player-result-enum.ts). Numeric
// values match the upstream so test fixtures port over cleanly.
export enum PlayerResult {
  NO_MOVE = 0,
  SAFE = 1,
  DEAD = 2,
  HOME1 = 5,
  HOME2 = 6,
  HOME3 = 7,
  HOME4 = 8,
  HOME5 = 9,
  OVER_WATER = 10,
  LEVEL_COMPLETE = 11,
  ARROW_UP = 38,
  ARROW_DOWN = 40,
  ARROW_RIGHT = 39,
  ARROW_LEFT = 37,
}

export interface SpriteState {
  key: string;
  visable: boolean;     // sic: matches upstream spelling
  x: number;
  y: number;
  direction: Direction | null;
  image: SpriteImage;
  speed: number | null; // upstream "speed" is "fires every Nth iteration"; null = static
  type: SpriteType;
}

export interface PlayerState {
  x: number;
  y: number;
  direction: Direction;
  score: number;
  lives: number;
  lowestPoint: number;       // bookkeeping for the "moving up scored 10" reward
  frogsHomeCount: number;    // how many of the 5 homes are filled this level
  isAlive: boolean;
}

export interface FroggerEvents {
  /** Rising-edge: a frog reached HOME (one of the 5 slots). The factory pulses
   *  `home_gate` once per HOME landing this step. */
  homesScored: number;
  /** Rising-edge: the frog DIED this step (vehicle hit, in water without a
   *  raft, or fell off the screen). The factory pulses `dead_gate` once. */
  died: boolean;
  /** Rising-edge: all 5 homes filled THIS step (level complete). The factory
   *  pulses `level_gate` once. */
  levelComplete: boolean;
}

export interface FroggerState {
  /** Whether the game loop is active. Mirrors upstream Game.isGameInPlay.
   *  When false, movement gates are ignored. A start_gate rising edge sets it
   *  to true (re-initing the world). */
  isGameInPlay: boolean;
  player: PlayerState;
  sprites: SpriteState[];
  /** Current level (1+). */
  level: number;
  /** Seconds remaining on the level timer. */
  time: number;
  /** Default time-per-level for the current difficulty (decreases by 5 s per
   *  level, floored at LOWEST_TIME=10). Mirrors upstream Game.defaultTime. */
  defaultTime: number;
  /** Internal sprite-tick counter (upstream "iteration"). Wraps at 100. The
   *  upstream uses iteration % sprite.speed === 0 to gate sprite advances —
   *  we preserve that behavior. */
  iteration: number;
  /** Fractional seconds accumulator: every 1/60s of accumulated time
   *  produces one sprite-tick (one upstream `handleTimer` call). The upstream
   *  ran handleTimer at a 10 ms setInterval; 100 Hz is a bit aggressive for
   *  a CV-gated module on the scheduler clock (~30 Hz), so we accumulate
   *  and step the upstream tick rate from real wall-clock dt. */
  spriteAccumS: number;
  /** Internal accumulator for the per-second level-timer countdown. */
  timerAccumS: number;
  /** Events emitted on the most recent step (reset each step). */
  events: FroggerEvents;
  /** Tick counter — incremented every step. Useful for snapshot diffing. */
  tick: number;
}

export interface FroggerInputs {
  /** Rising-edge gates from the factory (already edge-detected). */
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  /** Start a new game (resets the world; auto-fired once on boot). */
  start: boolean;
}

export interface FroggerParams {
  /** Per-level initial timer seconds (matches upstream config.initialTime).
   *  Range 10..120, defaults 60. */
  initialTime: number;
}

// ---------------------------------------------------------------------------
// Initial sprite table — vertically transcribed from upstream
// src/classes/data/sprites.ts. Positions/directions/speeds preserved 1:1.
// ---------------------------------------------------------------------------

interface InitialSpriteDef {
  key: string;
  x: number;
  y: number;
  direction?: Direction;
  image: SpriteImage;
  speed?: number;
  type: SpriteType;
  visable?: boolean;
}

const INITIAL_SPRITES: readonly InitialSpriteDef[] = [
  // Row 12 (bottom road): cars facing LEFT (speed 50 = slow).
  { key: 'car1-1', x: 1,  y: 12, direction: Direction.LEFT,  image: SpriteImage.CAR1, speed: 50, type: SpriteType.VEHICLE },
  { key: 'car1-2', x: 6,  y: 12, direction: Direction.LEFT,  image: SpriteImage.CAR1, speed: 50, type: SpriteType.VEHICLE },
  { key: 'car1-3', x: 10, y: 12, direction: Direction.LEFT,  image: SpriteImage.CAR1, speed: 50, type: SpriteType.VEHICLE },
  // Row 11: cars facing RIGHT.
  { key: 'car2-1', x: 2,  y: 11, direction: Direction.RIGHT, image: SpriteImage.CAR2, speed: 40, type: SpriteType.VEHICLE },
  { key: 'car2-2', x: 7,  y: 11, direction: Direction.RIGHT, image: SpriteImage.CAR2, speed: 40, type: SpriteType.VEHICLE },
  { key: 'car2-3', x: 13, y: 11, direction: Direction.RIGHT, image: SpriteImage.CAR2, speed: 40, type: SpriteType.VEHICLE },
  // Row 10: cars facing LEFT (faster).
  { key: 'car3-1', x: 3,  y: 10, direction: Direction.LEFT,  image: SpriteImage.CAR3, speed: 30, type: SpriteType.VEHICLE },
  { key: 'car3-2', x: 8,  y: 10, direction: Direction.LEFT,  image: SpriteImage.CAR3, speed: 30, type: SpriteType.VEHICLE },
  { key: 'car3-3', x: 14, y: 10, direction: Direction.LEFT,  image: SpriteImage.CAR3, speed: 30, type: SpriteType.VEHICLE },
  // Row 9: solo fast car (RIGHT).
  { key: 'car4',   x: 10, y: 9,  direction: Direction.RIGHT, image: SpriteImage.CAR4, speed: 20, type: SpriteType.VEHICLE },
  // Row 8: lorries (LEFT, paired front/back).
  { key: 'lorry-front-1', x: 8,  y: 8, direction: Direction.LEFT, image: SpriteImage.LORRY_FRONT, speed: 45, type: SpriteType.VEHICLE },
  { key: 'lorry-back-1',  x: 9,  y: 8, direction: Direction.LEFT, image: SpriteImage.LORRY_BACK,  speed: 45, type: SpriteType.VEHICLE },
  { key: 'lorry-front-2', x: 13, y: 8, direction: Direction.LEFT, image: SpriteImage.LORRY_FRONT, speed: 45, type: SpriteType.VEHICLE },
  { key: 'lorry-back-2',  x: 14, y: 8, direction: Direction.LEFT, image: SpriteImage.LORRY_BACK,  speed: 45, type: SpriteType.VEHICLE },
  // y=7 is the safe bank — no sprites.
  // Row 6: turtles (LEFT).
  { key: 'turtle1-1', x: 1,  y: 6, direction: Direction.LEFT, image: SpriteImage.TURTLE, speed: 20, type: SpriteType.RAFT },
  { key: 'turtle1-2', x: 2,  y: 6, direction: Direction.LEFT, image: SpriteImage.TURTLE, speed: 20, type: SpriteType.RAFT },
  { key: 'turtle1-3', x: 5,  y: 6, direction: Direction.LEFT, image: SpriteImage.TURTLE, speed: 20, type: SpriteType.RAFT },
  { key: 'turtle1-4', x: 6,  y: 6, direction: Direction.LEFT, image: SpriteImage.TURTLE, speed: 20, type: SpriteType.RAFT },
  { key: 'turtle1-5', x: 7,  y: 6, direction: Direction.LEFT, image: SpriteImage.TURTLE, speed: 20, type: SpriteType.RAFT },
  { key: 'turtle1-6', x: 10, y: 6, direction: Direction.LEFT, image: SpriteImage.TURTLE, speed: 20, type: SpriteType.RAFT },
  { key: 'turtle1-7', x: 11, y: 6, direction: Direction.LEFT, image: SpriteImage.TURTLE, speed: 20, type: SpriteType.RAFT },
  { key: 'turtle1-8', x: 12, y: 6, direction: Direction.LEFT, image: SpriteImage.TURTLE, speed: 20, type: SpriteType.RAFT },
  // Row 5: logs (RIGHT, fast — speed 80).
  { key: 'log1-1', x: 2,  y: 5, direction: Direction.RIGHT, image: SpriteImage.LOG_LEFT,   speed: 80, type: SpriteType.RAFT },
  { key: 'log1-2', x: 3,  y: 5, direction: Direction.RIGHT, image: SpriteImage.LOG_CENTRE, speed: 80, type: SpriteType.RAFT },
  { key: 'log1-3', x: 4,  y: 5, direction: Direction.RIGHT, image: SpriteImage.LOG_RIGHT,  speed: 80, type: SpriteType.RAFT },
  { key: 'log1-4', x: 8,  y: 5, direction: Direction.RIGHT, image: SpriteImage.LOG_LEFT,   speed: 80, type: SpriteType.RAFT },
  { key: 'log1-5', x: 9,  y: 5, direction: Direction.RIGHT, image: SpriteImage.LOG_CENTRE, speed: 80, type: SpriteType.RAFT },
  { key: 'log1-6', x: 10, y: 5, direction: Direction.RIGHT, image: SpriteImage.LOG_RIGHT,  speed: 80, type: SpriteType.RAFT },
  { key: 'log1-7', x: 13, y: 5, direction: Direction.RIGHT, image: SpriteImage.LOG_LEFT,   speed: 80, type: SpriteType.RAFT },
  { key: 'log1-8', x: 14, y: 5, direction: Direction.RIGHT, image: SpriteImage.LOG_RIGHT,  speed: 80, type: SpriteType.RAFT },
  // Row 4: long logs (RIGHT, medium — speed 30). The upstream's row-4 set is
  // a long ribbon; preserved verbatim.
  { key: 'log2-1',  x: 3,  y: 4, direction: Direction.RIGHT, image: SpriteImage.LOG_LEFT,   speed: 30, type: SpriteType.RAFT },
  { key: 'log2-2',  x: 4,  y: 4, direction: Direction.RIGHT, image: SpriteImage.LOG_CENTRE, speed: 30, type: SpriteType.RAFT },
  { key: 'log2-3',  x: 5,  y: 4, direction: Direction.RIGHT, image: SpriteImage.LOG_CENTRE, speed: 30, type: SpriteType.RAFT },
  { key: 'log2-4',  x: 6,  y: 4, direction: Direction.RIGHT, image: SpriteImage.LOG_CENTRE, speed: 30, type: SpriteType.RAFT },
  { key: 'log2-5',  x: 7,  y: 4, direction: Direction.RIGHT, image: SpriteImage.LOG_CENTRE, speed: 30, type: SpriteType.RAFT },
  { key: 'log2-6',  x: 8,  y: 4, direction: Direction.RIGHT, image: SpriteImage.LOG_RIGHT,  speed: 30, type: SpriteType.RAFT },
  { key: 'log2-7',  x: 11, y: 4, direction: Direction.RIGHT, image: SpriteImage.LOG_LEFT,   speed: 30, type: SpriteType.RAFT },
  { key: 'log2-8',  x: 12, y: 4, direction: Direction.RIGHT, image: SpriteImage.LOG_CENTRE, speed: 30, type: SpriteType.RAFT },
  { key: 'log2-9',  x: 13, y: 4, direction: Direction.RIGHT, image: SpriteImage.LOG_CENTRE, speed: 30, type: SpriteType.RAFT },
  { key: 'log2-10', x: 14, y: 4, direction: Direction.RIGHT, image: SpriteImage.LOG_CENTRE, speed: 30, type: SpriteType.RAFT },
  { key: 'log2-11', x: 1,  y: 4, direction: Direction.RIGHT, image: SpriteImage.LOG_RIGHT,  speed: 30, type: SpriteType.RAFT },
  // Row 3: turtles (LEFT, medium speed 30).
  { key: 'turtle2-1', x: 3,  y: 3, direction: Direction.LEFT, image: SpriteImage.TURTLE, speed: 30, type: SpriteType.RAFT },
  { key: 'turtle2-2', x: 4,  y: 3, direction: Direction.LEFT, image: SpriteImage.TURTLE, speed: 30, type: SpriteType.RAFT },
  { key: 'turtle2-3', x: 7,  y: 3, direction: Direction.LEFT, image: SpriteImage.TURTLE, speed: 30, type: SpriteType.RAFT },
  { key: 'turtle2-4', x: 8,  y: 3, direction: Direction.LEFT, image: SpriteImage.TURTLE, speed: 30, type: SpriteType.RAFT },
  { key: 'turtle2-5', x: 11, y: 3, direction: Direction.LEFT, image: SpriteImage.TURTLE, speed: 30, type: SpriteType.RAFT },
  { key: 'turtle2-6', x: 12, y: 3, direction: Direction.LEFT, image: SpriteImage.TURTLE, speed: 30, type: SpriteType.RAFT },
  // Row 2: logs (RIGHT).
  { key: 'log3-1',  x: 2,  y: 2, direction: Direction.RIGHT, image: SpriteImage.LOG_LEFT,   speed: 30, type: SpriteType.RAFT },
  { key: 'log3-2',  x: 3,  y: 2, direction: Direction.RIGHT, image: SpriteImage.LOG_CENTRE, speed: 30, type: SpriteType.RAFT },
  { key: 'log3-3',  x: 4,  y: 2, direction: Direction.RIGHT, image: SpriteImage.LOG_CENTRE, speed: 30, type: SpriteType.RAFT },
  { key: 'log3-4',  x: 5,  y: 2, direction: Direction.RIGHT, image: SpriteImage.LOG_RIGHT,  speed: 30, type: SpriteType.RAFT },
  { key: 'log3-5',  x: 8,  y: 2, direction: Direction.RIGHT, image: SpriteImage.LOG_LEFT,   speed: 30, type: SpriteType.RAFT },
  { key: 'log3-6',  x: 9,  y: 2, direction: Direction.RIGHT, image: SpriteImage.LOG_CENTRE, speed: 30, type: SpriteType.RAFT },
  { key: 'log3-7',  x: 10, y: 2, direction: Direction.RIGHT, image: SpriteImage.LOG_CENTRE, speed: 30, type: SpriteType.RAFT },
  { key: 'log3-8',  x: 11, y: 2, direction: Direction.RIGHT, image: SpriteImage.LOG_RIGHT,  speed: 30, type: SpriteType.RAFT },
  { key: 'log3-9',  x: 13, y: 2, direction: Direction.RIGHT, image: SpriteImage.LOG_LEFT,   speed: 30, type: SpriteType.RAFT },
  { key: 'log3-10', x: 14, y: 2, direction: Direction.RIGHT, image: SpriteImage.LOG_RIGHT,  speed: 30, type: SpriteType.RAFT },
  // Row 1: HOME slots (5 of them, invisible until reached, hidden under the
  // background sprite the upstream renders).
  { key: 'player-home-5', x: 2,  y: 1, image: SpriteImage.PLAYER_HOME, type: SpriteType.HOME, visable: false },
  { key: 'player-home-6', x: 5,  y: 1, image: SpriteImage.PLAYER_HOME, type: SpriteType.HOME, visable: false },
  { key: 'player-home-7', x: 8,  y: 1, image: SpriteImage.PLAYER_HOME, type: SpriteType.HOME, visable: false },
  { key: 'player-home-8', x: 11, y: 1, image: SpriteImage.PLAYER_HOME, type: SpriteType.HOME, visable: false },
  { key: 'player-home-9', x: 14, y: 1, image: SpriteImage.PLAYER_HOME, type: SpriteType.HOME, visable: false },
];

function cloneSprites(): SpriteState[] {
  return INITIAL_SPRITES.map((s) => ({
    key: s.key,
    visable: s.visable ?? true,
    x: s.x,
    y: s.y,
    direction: s.direction ?? null,
    image: s.image,
    speed: s.speed ?? null,
    type: s.type,
  }));
}

function emptyEvents(): FroggerEvents {
  return { homesScored: 0, died: false, levelComplete: false };
}

function freshPlayer(lives: number): PlayerState {
  return {
    x: INITIAL_PLAYER_X,
    y: INITIAL_PLAYER_Y,
    direction: Direction.UP,
    score: 0,
    lives,
    lowestPoint: INITIAL_PLAYER_Y,
    frogsHomeCount: 0,
    isAlive: true,
  };
}

/** Build the initial PRE-START state. isGameInPlay=false; the factory fires
 *  the synthetic start_gate on tick 1 which calls startGame() to flip it. */
export function initFroggerState(params: FroggerParams = { initialTime: DEFAULT_TIME }): FroggerState {
  const time = clampTime(params.initialTime);
  return {
    isGameInPlay: false,
    player: freshPlayer(INITIAL_PLAYER_LIVES),
    sprites: cloneSprites(),
    level: 1,
    time,
    defaultTime: time,
    iteration: 1,
    spriteAccumS: 0,
    timerAccumS: 0,
    events: emptyEvents(),
    tick: 0,
  };
}

function clampTime(seconds: number): number {
  if (!Number.isFinite(seconds)) return DEFAULT_TIME;
  return Math.max(10, Math.min(120, seconds));
}

/** Mirror upstream Game.startGame — spawn a fresh world + start the loop. */
export function startGame(prev: FroggerState, params: FroggerParams): FroggerState {
  const time = clampTime(params.initialTime);
  return {
    isGameInPlay: true,
    player: freshPlayer(INITIAL_PLAYER_LIVES),
    sprites: cloneSprites(),
    level: 1,
    time,
    defaultTime: time,
    iteration: 1,
    spriteAccumS: 0,
    timerAccumS: 0,
    events: emptyEvents(),
    tick: prev.tick + 1,
  };
}

/** Upstream Player.isHome — returns the HOME slot number (5..9) if (x,y)
 *  hits a home slot, or PlayerResult.DEAD if y==1 but not a home slot. */
function isHomeSlot(x: number, y: number): number {
  if (y !== 1) return 0;
  if (x === 1 || x === 2)   return PlayerResult.HOME1;
  if (x === 4 || x === 5)   return PlayerResult.HOME2;
  if (x === 7 || x === 8)   return PlayerResult.HOME3;
  if (x === 10 || x === 11) return PlayerResult.HOME4;
  if (x === 13 || x === 14) return PlayerResult.HOME5;
  return PlayerResult.DEAD;
}

/** Upstream Player.isValidSpace — clamp to the 14×13 grid. */
function isValidSpace(x: number, y: number): boolean {
  return x >= 1 && x <= 14 && y >= 1 && y <= 13;
}

/** Upstream Player.isInWater — y∈[2,6] (the river). y=1 is the home row; the
 *  player only gets there via a HOME slot. */
function isInWater(_x: number, y: number): boolean {
  return y > 1 && y < 7;
}

const SCORE_MOVING_UP = 10;
const SCORE_GETTING_HOME = 50;
const SCORE_LEVEL_COMPLETE = 1000;
const LOWEST_TIME = 10;

/** Mutates `state` in place to apply a single player move attempt. Mirrors
 *  upstream Game.move + Player.move. */
function tryMove(state: FroggerState, direction: Direction): void {
  if (!state.isGameInPlay) return;
  const player = state.player;
  player.direction = direction;
  let x = player.x;
  let y = player.y;
  switch (direction) {
    case Direction.UP:    y -= 1; break;
    case Direction.DOWN:  y += 1; break;
    case Direction.LEFT:  x -= 1; break;
    case Direction.RIGHT: x += 1; break;
  }
  if (!isValidSpace(x, y)) return;

  // Home check first — y==1 lands either on a HOME or on the wall between
  // homes (which is DEAD).
  const home = isHomeSlot(x, y);
  if (home !== 0 && home !== PlayerResult.DEAD) {
    player.score += SCORE_GETTING_HOME;
    player.frogsHomeCount += 1;
    handlePlayerHome(state, home);
    if (player.frogsHomeCount >= 5) {
      player.score += SCORE_LEVEL_COMPLETE;
      handleLevelComplete(state);
    }
    return;
  }
  if (home === PlayerResult.DEAD) {
    // Walked into the wall between homes.
    handleDie(state);
    return;
  }

  // Water — survive only if a RAFT sprite is co-located at the destination.
  if (isInWater(x, y)) {
    const raftHere = state.sprites.find((s) => s.x === x && s.y === y && s.type === SpriteType.RAFT);
    if (!raftHere) {
      handleDie(state);
      return;
    }
  }

  // Commit the move.
  player.x = x;
  player.y = y;
  if (y < player.lowestPoint) {
    player.lowestPoint = y;
    player.score += SCORE_MOVING_UP;
  }

  // Mirror upstream Game.move's post-move clash sweep: any sprite sitting on
  // the destination cell fires its clash result. A vehicle on the same cell
  // is instant death; a raft sets the player's horizontal carry-over (which
  // we model as an immediate re-move in the raft's direction, same as upstream
  // handleMoveClash).
  for (const sprite of state.sprites) {
    if (sprite.y !== player.y) continue;
    if (sprite.x !== player.x) continue;
    if (sprite.type === SpriteType.VEHICLE) {
      handleDie(state);
      return;
    }
    if (sprite.type === SpriteType.RAFT) {
      // Land on a raft → safe (the player is now riding it; future sprite
      // ticks carry the player along via the raft's direction).
      break;
    }
  }
}

function handlePlayerHome(state: FroggerState, homeKind: number): void {
  // Find the matching home sprite + flip its visibility. Upstream behavior:
  // if it's already visible (another frog already landed there), it's DEAD.
  const homeSprite = state.sprites.find((s) => s.key === `player-home-${homeKind}`);
  if (!homeSprite) {
    handleDie(state);
    return;
  }
  if (homeSprite.visable) {
    handleDie(state);
    return;
  }
  homeSprite.visable = true;
  state.events.homesScored += 1;
  resetPlayerToStart(state.player);
}

function handleDie(state: FroggerState): void {
  state.events.died = true;
  state.timerAccumS = 0;
  state.time = state.defaultTime;
  state.player.lives = Math.max(0, state.player.lives - 1);
  state.player.isAlive = state.player.lives > 0;
  resetPlayerToStart(state.player);
  state.isGameInPlay = state.player.isAlive;
}

function handleLevelComplete(state: FroggerState): void {
  state.events.levelComplete = true;
  state.level += 1;
  state.defaultTime = Math.max(LOWEST_TIME, state.defaultTime - 5);
  state.time = state.defaultTime;
  state.timerAccumS = 0;
  // Reset homes for the new level.
  for (const s of state.sprites) {
    if (s.type === SpriteType.HOME) s.visable = false;
  }
  state.player.frogsHomeCount = 0;
  state.player.lowestPoint = INITIAL_PLAYER_Y;
  resetPlayerToStart(state.player);
}

function resetPlayerToStart(player: PlayerState): void {
  player.x = INITIAL_PLAYER_X;
  player.y = INITIAL_PLAYER_Y;
  player.lowestPoint = INITIAL_PLAYER_Y;
}

/** Mirror upstream Sprite.move — advance one sprite by one cell in its
 *  direction. Wrapping mirrors upstream (x<1 → 14, x>14 → 1). Returns the
 *  PlayerResult clash with the player. */
function moveSpriteOnce(sprite: SpriteState, playerX: number, playerY: number): PlayerResult {
  // Upstream peculiarity: rafts check clash BEFORE moving (so the frog rides
  // them); vehicles check AFTER moving.
  let result: PlayerResult = PlayerResult.NO_MOVE;
  if (sprite.type === SpriteType.RAFT) {
    result = checkClash(sprite, playerX, playerY);
  }
  switch (sprite.direction) {
    case Direction.LEFT:  sprite.x -= 1; break;
    case Direction.RIGHT: sprite.x += 1; break;
  }
  if (sprite.x < 1)  sprite.x = 14;
  if (sprite.x > 14) sprite.x = 1;
  if (sprite.type !== SpriteType.RAFT) {
    result = checkClash(sprite, playerX, playerY);
  }
  return result;
}

function checkClash(sprite: SpriteState, playerX: number, playerY: number): PlayerResult {
  if (sprite.x !== playerX || sprite.y !== playerY) return PlayerResult.SAFE;
  if (sprite.type === SpriteType.VEHICLE) return PlayerResult.DEAD;
  if (sprite.type === SpriteType.RAFT && sprite.direction === Direction.LEFT)  return PlayerResult.ARROW_LEFT;
  if (sprite.type === SpriteType.RAFT && sprite.direction === Direction.RIGHT) return PlayerResult.ARROW_RIGHT;
  return PlayerResult.SAFE;
}

/** Apply a sprite clash result back onto the player. */
function applyClash(state: FroggerState, result: PlayerResult): void {
  if (result === PlayerResult.DEAD) {
    handleDie(state);
    return;
  }
  if (result === PlayerResult.ARROW_LEFT)  tryMove(state, Direction.LEFT);
  if (result === PlayerResult.ARROW_RIGHT) tryMove(state, Direction.RIGHT);
}

/** Sprite tick — runs at ~100 Hz of game-time (upstream cadence). Per sprite,
 *  if iteration % sprite.speed === 0, advance it one cell. */
function spriteTick(state: FroggerState): void {
  state.iteration += 1;
  if (state.iteration > 100) state.iteration = 1;
  for (const s of state.sprites) {
    if (s.speed == null) continue;
    if (state.iteration % s.speed !== 0) continue;
    const result = moveSpriteOnce(s, state.player.x, state.player.y);
    if (result !== PlayerResult.SAFE && result !== PlayerResult.NO_MOVE) {
      applyClash(state, result);
    }
  }
  // Post-sprite-tick water check — if the player is sitting in the water row
  // without a raft (e.g. a raft just rolled out from under them), die. Mirrors
  // upstream Game.handleTimer's trailing `if (this.player.y < 7) handleOverWater()`.
  if (state.isGameInPlay && state.player.y < 7) {
    const raftHere = state.sprites.find(
      (s) => s.x === state.player.x && s.y === state.player.y && s.type === SpriteType.RAFT,
    );
    if (!raftHere) handleDie(state);
  }
}

/** Step the state forward by `dtSeconds`. */
export function stepFroggerState(
  prev: FroggerState,
  inputs: FroggerInputs,
  params: FroggerParams,
  dtSeconds: number,
): FroggerState {
  // Defensive copy — mutate the copy and return it. Most fields are primitives
  // (cheap); player + sprites are arrays we clone shallowly so the prev-state
  // snapshot remains stable for the renderer's deep-compare/tick check.
  const state: FroggerState = {
    isGameInPlay: prev.isGameInPlay,
    player: { ...prev.player },
    sprites: prev.sprites.map((s) => ({ ...s })),
    level: prev.level,
    time: prev.time,
    defaultTime: prev.defaultTime,
    iteration: prev.iteration,
    spriteAccumS: prev.spriteAccumS + Math.max(0, dtSeconds),
    timerAccumS: prev.timerAccumS,
    events: emptyEvents(),
    tick: prev.tick + 1,
  };

  // 1. start_gate rising edge → fresh game.
  if (inputs.start) {
    const fresh = startGame(state, params);
    return { ...fresh, events: emptyEvents(), tick: state.tick };
  }

  if (!state.isGameInPlay) {
    // Pre-start (or post-game-over): drop movement gates.
    return state;
  }

  // 2. Sprite ticks. Upstream ran handleTimer every 10 ms (100 Hz). We
  // accumulate dt and step that cadence; one frame at 60 fps = 16.7 ms → ~1.67
  // sprite ticks per frame. Cap at 20 ticks/step to avoid pathological catch-up
  // after a paused tab.
  const SPRITE_TICK_MS = 10;
  const SPRITE_TICK_S = SPRITE_TICK_MS / 1000;
  let ticksToRun = Math.floor(state.spriteAccumS / SPRITE_TICK_S);
  if (ticksToRun > 20) ticksToRun = 20;
  state.spriteAccumS -= ticksToRun * SPRITE_TICK_S;
  for (let i = 0; i < ticksToRun && state.isGameInPlay; i++) {
    spriteTick(state);
  }

  // 3. Movement gates (rising-edge, ignored if !isGameInPlay).
  if (state.isGameInPlay && inputs.up)    tryMove(state, Direction.UP);
  if (state.isGameInPlay && inputs.down)  tryMove(state, Direction.DOWN);
  if (state.isGameInPlay && inputs.left)  tryMove(state, Direction.LEFT);
  if (state.isGameInPlay && inputs.right) tryMove(state, Direction.RIGHT);

  // 4. Level-timer countdown (1 s per real second). When it hits 0 the player
  // loses a life.
  state.timerAccumS += dtSeconds;
  while (state.timerAccumS >= 1 && state.isGameInPlay) {
    state.timerAccumS -= 1;
    state.time -= 1;
    if (state.time <= 0) {
      handleDie(state);
      break;
    }
  }

  return state;
}

/** Rising-edge detector helper (also used by tests). */
export function detectRisingEdge(prev: number, curr: number, threshold = 0.5): boolean {
  return prev < threshold && curr >= threshold;
}
