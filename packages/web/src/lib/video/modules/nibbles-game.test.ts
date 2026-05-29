// packages/web/src/lib/video/modules/nibbles-game.test.ts
//
// Pure-engine determinism + collision tests. No DOM / Web Audio / GL.

import { describe, it, expect } from 'vitest';
import {
  NIBBLES_BOARD_W,
  NIBBLES_BOARD_H,
  drainEvents,
  newGame,
  setDirection,
  tick,
  type NibblesState,
} from './nibbles-game';

function clone(s: NibblesState): NibblesState {
  return JSON.parse(JSON.stringify(s)) as NibblesState;
}

describe('newGame', () => {
  it('builds a 4-segment snake at the board center moving right', () => {
    const s = newGame(1);
    expect(s.width).toBe(NIBBLES_BOARD_W);
    expect(s.height).toBe(NIBBLES_BOARD_H);
    expect(s.snake.length).toBe(4);
    expect(s.score).toBe(4);
    expect(s.direction).toBe('right');
    expect(s.alive).toBe(true);
    const head = s.snake[0]!;
    expect(head.x).toBe(Math.floor(NIBBLES_BOARD_W / 2));
    expect(head.y).toBe(Math.floor(NIBBLES_BOARD_H / 2));
  });

  it('places food in a cell that is not on the snake', () => {
    const s = newGame(42);
    for (const cell of s.snake) {
      expect(cell.x === s.food.x && cell.y === s.food.y).toBe(false);
    }
    expect(s.food.x).toBeGreaterThanOrEqual(0);
    expect(s.food.x).toBeLessThan(s.width);
    expect(s.food.y).toBeGreaterThanOrEqual(0);
    expect(s.food.y).toBeLessThan(s.height);
  });
});

describe('determinism', () => {
  it('same seed → same first 10 ticks → same head positions', () => {
    const a = newGame(12345);
    const b = newGame(12345);
    const headsA: { x: number; y: number }[] = [];
    const headsB: { x: number; y: number }[] = [];
    for (let i = 0; i < 10; i++) {
      tick(a);
      tick(b);
      headsA.push({ ...a.snake[0]! });
      headsB.push({ ...b.snake[0]! });
    }
    expect(headsA).toEqual(headsB);
    expect(a.food).toEqual(b.food);
  });

  it('different seeds → different first food placement', () => {
    const a = newGame(1);
    const b = newGame(2);
    // Either food x or y differs (overwhelmingly likely on a 4000-cell board).
    expect(a.food.x === b.food.x && a.food.y === b.food.y).toBe(false);
  });
});

describe('pellet consumption', () => {
  it('head onto food → length++, new food spawns, pellet event fires', () => {
    const s = newGame(7);
    const head = s.snake[0]!;
    // Force a known pellet adjacent to the head, in front (we move right).
    s.food = { x: head.x + 1, y: head.y };
    const lenBefore = s.snake.length;
    tick(s);
    expect(s.snake.length).toBe(lenBefore + 1);
    expect(s.score).toBe(lenBefore + 1);
    expect(s.pelletsEaten).toBe(1);
    const events = drainEvents(s);
    expect(events).toContainEqual({ type: 'pellet' });
    // New food is a different cell from where the head is now.
    expect(s.food.x === head.x + 1 && s.food.y === head.y).toBe(false);
  });
});

describe('wall collision', () => {
  it('head into left edge → death', () => {
    const s = newGame(1);
    // Move snake to the left edge by warping it. Set the head to (0,y) +
    // direction left; next tick goes to (-1, y) — wall.
    const y = 25;
    s.snake = [
      { x: 0, y },
      { x: 1, y },
      { x: 2, y },
      { x: 3, y },
    ];
    s.direction = 'left';
    s.food = { x: 60, y: 0 };  // far from the action
    tick(s);
    expect(s.alive).toBe(false);
    const events = drainEvents(s);
    expect(events).toContainEqual({ type: 'death' });
  });

  it('head into right edge → death', () => {
    const s = newGame(1);
    const y = 25;
    const W = s.width;
    s.snake = [
      { x: W - 1, y },
      { x: W - 2, y },
      { x: W - 3, y },
      { x: W - 4, y },
    ];
    s.direction = 'right';
    s.food = { x: 0, y: 0 };
    tick(s);
    expect(s.alive).toBe(false);
    expect(drainEvents(s)).toContainEqual({ type: 'death' });
  });
});

describe('self collision', () => {
  it('head onto own body (non-tail cell) → death', () => {
    const s = newGame(1);
    // Coil the snake: head at (5,5) moving down. The cell (5,6) below is
    // a MIDDLE body segment (not the tail), so the head landing there is
    // a true self-collision.
    s.snake = [
      { x: 5, y: 5 },  // head
      { x: 5, y: 6 },  // immediately below — head will step into it (kill)
      { x: 4, y: 6 },
      { x: 4, y: 5 },  // tail
    ];
    s.direction = 'down';
    s.food = { x: 60, y: 0 };
    tick(s);
    expect(s.alive).toBe(false);
    expect(drainEvents(s)).toContainEqual({ type: 'death' });
  });

  it('head onto vacating tail is allowed (when not growing)', () => {
    // Construct a 4-cell snake whose head would move INTO its CURRENT tail
    // cell — that cell vacates this tick, so it's safe.
    const s = newGame(1);
    s.snake = [
      { x: 5, y: 5 },
      { x: 5, y: 6 },
      { x: 4, y: 6 },
      { x: 4, y: 5 },  // tail; head wants to step left into it
    ];
    s.direction = 'left';
    s.food = { x: 70, y: 0 };
    tick(s);
    expect(s.alive).toBe(true);
    expect(s.snake[0]!.x).toBe(4);
    expect(s.snake[0]!.y).toBe(5);
  });
});

describe('setDirection', () => {
  it('rejects 180° turn when snake length > 1', () => {
    const s = newGame(1);
    // Snake spawns moving right.
    setDirection(s, 'left');
    expect(s.pendingDirection).toBeNull();
    expect(drainEvents(s)).not.toContainEqual({ type: 'directionChange' });
  });

  it('emits directionChange ONLY when direction actually changes', () => {
    const s = newGame(1);
    drainEvents(s);
    setDirection(s, 'right');
    expect(drainEvents(s)).not.toContainEqual({ type: 'directionChange' });
    setDirection(s, 'up');
    const events = drainEvents(s);
    expect(events).toContainEqual({ type: 'directionChange' });
  });

  it('queued direction applies at the next tick', () => {
    const s = newGame(1);
    s.food = { x: 70, y: 0 };  // far from path
    setDirection(s, 'up');
    drainEvents(s);
    const headBefore = clone(s).snake[0]!;
    tick(s);
    expect(s.direction).toBe('up');
    const head = s.snake[0]!;
    expect(head.x).toBe(headBefore.x);
    expect(head.y).toBe(headBefore.y - 1);
  });
});

describe('drainEvents', () => {
  it('clears the queue after draining', () => {
    const s = newGame(1);
    s.events.push({ type: 'directionChange' });
    expect(drainEvents(s)).toHaveLength(1);
    expect(s.events).toHaveLength(0);
    expect(drainEvents(s)).toHaveLength(0);
  });
});
