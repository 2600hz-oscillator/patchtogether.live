// packages/web/src/lib/video/modules/nibbles-game.ts
//
// NIBBLES — deterministic, pure game engine. No canvas, no audio, no DOM.
// Mirrors the QBasic Nibbles algorithm (and kpreisser's Windows port at
// https://github.com/kpreisser/Nibbles.git): snake on a fixed grid, one
// pellet at a time, body grows on eat, death on wall/self collision.
//
// Hosting:
//   - `nibbles.ts` (the video module factory) advances the state at a
//     fixed game-tick cadence (`tick_ms` param, default 80 ms) and renders
//     the grid into a 320×200 framebuffer.
//   - `nibbles-bot.ts` is the AUTO self-player: pure `chooseDirection`.
//
// Determinism: the state carries an explicit `mulberry32`-style RNG (one
// uint32 seed). Pellet placement + every other random choice flows through
// it, so a fixed seed → fixed first-N-ticks across runs / platforms — the
// foundation for both the unit tests AND the VRT seed mode.

export const NIBBLES_BOARD_W = 80;
export const NIBBLES_BOARD_H = 50;

/** Pixel block per board cell on the rendered framebuffer. 80×50 cells × 4×4 px
 *  = 320×200 px — close to the QBasic Nibbles grid feel + matches the
 *  classic VGA mode 13h dimensions. */
export const NIBBLES_PIXEL_SCALE = 4;

export type NibblesDirection = 'up' | 'down' | 'left' | 'right';

export interface NibblesCell {
  x: number;
  y: number;
}

export type NibblesEvent =
  | { type: 'pellet' }
  | { type: 'death' }
  | { type: 'directionChange' };

export interface NibblesState {
  width: number;
  height: number;
  /** Head at index 0, tail at the end. */
  snake: NibblesCell[];
  food: NibblesCell;
  direction: NibblesDirection;
  /** Pending direction queued by setDirection — applied at the next tick
   *  so two arrow presses in a single tick can't fold the snake on itself
   *  (classic Nibbles bug). */
  pendingDirection: NibblesDirection | null;
  alive: boolean;
  /** Snake length. Cosmetically equals snake.length, kept separately so
   *  the length-CV doesn't dip during the rare "growing on the same tick
   *  as a re-render" inter-state. */
  score: number;
  /** Cumulative pellets eaten this game — survives `score` increments but
   *  is reset on `newGame`. Currently unused externally but cheap. */
  pelletsEaten: number;
  /** Drained by the host after each tick. The factory drains + pulses the
   *  appropriate output gates, then clears the queue. */
  events: NibblesEvent[];
  /** mulberry32 RNG state. Drives food placement deterministically. */
  rngState: number;
}

// ---- RNG: mulberry32 (32-bit, seed-stable across platforms) ---------------

/** Advance the mulberry32 state by one step and return a uniform `[0, 1)`
 *  double. The state-mutation lives inside `NibblesState` (no module-level
 *  mutables) so two `NibblesState` values with the same seed evolve
 *  identically. */
function rngNext(state: NibblesState): number {
  // Standard mulberry32. >>> 0 keeps math in unsigned 32-bit.
  state.rngState = (state.rngState + 0x6d2b79f5) >>> 0;
  let t = state.rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function rngInt(state: NibblesState, n: number): number {
  return Math.floor(rngNext(state) * n);
}

// ---- Construction ---------------------------------------------------------

/** Build a fresh game with the given RNG seed (any 32-bit int, including 0).
 *  Snake spawns at the center, length 4, moving right. The first pellet is
 *  placed via the RNG so a fixed seed gives a fixed opening. */
export function newGame(seed: number): NibblesState {
  // Mix the seed once so 0 isn't a special-case zero stream — without this,
  // mulberry32 needs ~3 iterations before it settles.
  const seeded = (seed | 0) >>> 0 || 1;
  const cx = Math.floor(NIBBLES_BOARD_W / 2);
  const cy = Math.floor(NIBBLES_BOARD_H / 2);
  const snake: NibblesCell[] = [
    { x: cx,     y: cy },
    { x: cx - 1, y: cy },
    { x: cx - 2, y: cy },
    { x: cx - 3, y: cy },
  ];
  const state: NibblesState = {
    width: NIBBLES_BOARD_W,
    height: NIBBLES_BOARD_H,
    snake,
    // Placeholder; spawnFood() overwrites it below.
    food: { x: 0, y: 0 },
    direction: 'right',
    pendingDirection: null,
    alive: true,
    score: snake.length,
    pelletsEaten: 0,
    events: [],
    rngState: seeded,
  };
  state.food = pickFood(state);
  return state;
}

/** Find an empty cell uniformly at random. Walks the RNG until a cell that
 *  doesn't overlap the snake body is found. Worst case is O(W×H) but the
 *  snake covers a tiny fraction of the board until very late game. */
function pickFood(state: NibblesState): NibblesCell {
  const W = state.width;
  const H = state.height;
  const occupied = new Set<number>();
  for (const cell of state.snake) occupied.add(cell.y * W + cell.x);
  // Bound the loop so an effectively-full board doesn't hang. The board is
  // 4000 cells; a snake long enough to fill it triggered death already.
  for (let tries = 0; tries < W * H * 4; tries++) {
    const idx = rngInt(state, W * H);
    if (!occupied.has(idx)) {
      return { x: idx % W, y: Math.floor(idx / W) };
    }
  }
  // Fall-back (should never hit in practice): first empty cell linearly.
  for (let i = 0; i < W * H; i++) {
    if (!occupied.has(i)) return { x: i % W, y: Math.floor(i / W) };
  }
  // Board full → snake has won. Place food on the head; the next tick
  // will collide either way.
  return state.snake[0]!;
}

// ---- Direction handling ---------------------------------------------------

const OPPOSITE: Record<NibblesDirection, NibblesDirection> = {
  up: 'down',
  down: 'up',
  left: 'right',
  right: 'left',
};

/** Queue a direction change. Rejects 180° turns when the snake is longer
 *  than 1 cell (classic Nibbles rule: you can't reverse onto your own
 *  neck). Emits a `directionChange` event ONLY when the queued direction
 *  is different from the current one — repeated presses are no-ops. */
export function setDirection(
  state: NibblesState,
  dir: NibblesDirection,
): void {
  if (!state.alive) return;
  if (state.snake.length > 1 && OPPOSITE[state.direction] === dir) return;
  if (dir === state.direction && state.pendingDirection === null) return;
  if (state.pendingDirection === dir) return;
  state.pendingDirection = dir;
  state.events.push({ type: 'directionChange' });
}

// ---- Tick -----------------------------------------------------------------

/** Advance one game tick. Returns a NEW state object (the input is not
 *  mutated for its top-level fields, but inner arrays are reused by
 *  reference for cheap rendering — callers should not retain old snake/
 *  events arrays after a `tick`). */
export function tick(state: NibblesState): NibblesState {
  if (!state.alive) return state;

  // Apply pending direction at tick boundary.
  if (state.pendingDirection && state.pendingDirection !== state.direction) {
    if (
      state.snake.length === 1 ||
      OPPOSITE[state.direction] !== state.pendingDirection
    ) {
      state.direction = state.pendingDirection;
    }
  }
  state.pendingDirection = null;

  const head = state.snake[0]!;
  let nx = head.x;
  let ny = head.y;
  switch (state.direction) {
    case 'up':    ny -= 1; break;
    case 'down':  ny += 1; break;
    case 'left':  nx -= 1; break;
    case 'right': nx += 1; break;
  }

  // Wall collision.
  if (nx < 0 || nx >= state.width || ny < 0 || ny >= state.height) {
    state.alive = false;
    state.events.push({ type: 'death' });
    return state;
  }

  const ateFood = nx === state.food.x && ny === state.food.y;

  // Self collision. We allow stepping into the OLD tail cell when not
  // growing (the tail will be popped before the head lands) — but only
  // when the tail won't be retained because we ate food on this tick.
  // Simpler rule: collision against any body cell EXCEPT the tail when
  // not growing.
  const bodyLimit = ateFood ? state.snake.length : state.snake.length - 1;
  for (let i = 0; i < bodyLimit; i++) {
    const seg = state.snake[i]!;
    if (seg.x === nx && seg.y === ny) {
      state.alive = false;
      state.events.push({ type: 'death' });
      return state;
    }
  }

  // Advance: push new head, optionally pop tail.
  state.snake.unshift({ x: nx, y: ny });
  if (ateFood) {
    state.pelletsEaten += 1;
    state.score = state.snake.length;
    state.events.push({ type: 'pellet' });
    state.food = pickFood(state);
  } else {
    state.snake.pop();
    state.score = state.snake.length;
  }
  return state;
}

/** Drain the events queue and return the drained array. Used by the host
 *  module to pulse gate outputs once per game tick. */
export function drainEvents(state: NibblesState): NibblesEvent[] {
  const drained = state.events;
  state.events = [];
  return drained;
}

/** Convenience: build the cell-occupancy set for collision queries (used
 *  by the bot for its "is this step safe?" check). */
export function snakeCells(state: NibblesState): Set<number> {
  const set = new Set<number>();
  for (const cell of state.snake) set.add(cell.y * state.width + cell.x);
  return set;
}
