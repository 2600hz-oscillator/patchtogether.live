// packages/web/src/lib/video/modules/nibbles-bot.ts
//
// NIBBLES self-player. Pure function: state in → direction out. NO
// internal state, NO RNG (so the bot itself stays deterministic on a
// given board state — the only stochastic input is the engine's seeded
// pellet placement, which the bot reads from `state.food`).
//
// Strategy (per spec — "no foresight needed"):
//   1. Of the four candidate next-step directions, prefer ones that DON'T
//      land on the snake's own body and DON'T leave the board.
//   2. Among the safe candidates, pick the one that minimises Manhattan
//      distance to the food. Tie-break by direction order (up, down,
//      left, right) so the result is deterministic.
//   3. If NO candidate is safe — the snake painted itself into a corner —
//      step toward the food anyway. Per spec: "no foresight needed re:
//      how it lays its tail — it'll eat, grow, eventually die."
//
// 180° turns are filtered: setDirection in the engine rejects them and
// the bot must not propose them (length > 1), otherwise we'd waste a
// tick.

import {
  type NibblesDirection,
  type NibblesState,
  snakeCells,
} from './nibbles-game';

const DIRS: ReadonlyArray<NibblesDirection> = ['up', 'down', 'left', 'right'];

const OPPOSITE: Record<NibblesDirection, NibblesDirection> = {
  up: 'down',
  down: 'up',
  left: 'right',
  right: 'left',
};

function step(
  x: number,
  y: number,
  dir: NibblesDirection,
): { x: number; y: number } {
  switch (dir) {
    case 'up':    return { x, y: y - 1 };
    case 'down':  return { x, y: y + 1 };
    case 'left':  return { x: x - 1, y };
    case 'right': return { x: x + 1, y };
  }
}

function manhattan(ax: number, ay: number, bx: number, by: number): number {
  return Math.abs(ax - bx) + Math.abs(ay - by);
}

/** Pick the best direction for the next tick. Always returns a direction
 *  even when no safe option exists (death is acceptable — see header). */
export function chooseDirection(state: NibblesState): NibblesDirection {
  const head = state.snake[0]!;
  const W = state.width;
  const H = state.height;
  const body = snakeCells(state);

  // The snake CAN step onto the cell its tail is leaving this tick (as
  // long as it's not eating food). Approximate that by excluding the tail
  // cell from the body set when the candidate isn't food.
  const tail = state.snake[state.snake.length - 1]!;
  const tailIdx = tail.y * W + tail.x;

  type Candidate = {
    dir: NibblesDirection;
    safe: boolean;
    dist: number;
  };
  const candidates: Candidate[] = [];
  for (const dir of DIRS) {
    // Skip a 180° turn — the engine would reject it anyway.
    if (state.snake.length > 1 && OPPOSITE[state.direction] === dir) continue;
    const next = step(head.x, head.y, dir);
    const inBounds = next.x >= 0 && next.x < W && next.y >= 0 && next.y < H;
    let safe = inBounds;
    if (safe) {
      const idx = next.y * W + next.x;
      const isFood = next.x === state.food.x && next.y === state.food.y;
      // Tail vacates this tick unless we're eating food (which keeps it).
      const bodyHit = body.has(idx) && !(idx === tailIdx && !isFood);
      if (bodyHit) safe = false;
    }
    const dist = manhattan(next.x, next.y, state.food.x, state.food.y);
    candidates.push({ dir, safe, dist });
  }
  // Filter to safe ones if any exist; otherwise keep all so we still
  // return a direction.
  const safe = candidates.filter((c) => c.safe);
  const pool = safe.length > 0 ? safe : candidates;
  // Minimise manhattan distance; DIRS-order tie-break (stable sort).
  pool.sort((a, b) => a.dist - b.dist);
  return pool[0]?.dir ?? state.direction;
}
