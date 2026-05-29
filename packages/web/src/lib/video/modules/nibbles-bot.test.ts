// packages/web/src/lib/video/modules/nibbles-bot.test.ts
//
// Bot strategy tests + the 95th-percentile length calibration that fixes
// NIBBLES_MAX_LENGTH (the constant used by the length-CV mapping in
// nibbles.ts).

import { describe, it, expect } from 'vitest';
import { chooseDirection } from './nibbles-bot';
import {
  NIBBLES_BOARD_W,
  NIBBLES_BOARD_H,
  newGame,
  setDirection,
  tick,
  type NibblesState,
} from './nibbles-game';
import { NIBBLES_MAX_LENGTH } from './nibbles';

describe('chooseDirection — safety', () => {
  it('rejects a direct step into the snake body', () => {
    const s = newGame(1);
    s.snake = [
      { x: 5, y: 5 },
      { x: 5, y: 6 },  // below head
      { x: 4, y: 6 },
      { x: 4, y: 5 },
    ];
    s.direction = 'right';
    // Food directly DOWN — greedy would pick 'down' but that hits the body.
    s.food = { x: 5, y: 30 };
    const dir = chooseDirection(s);
    expect(dir).not.toBe('down');
  });

  it('rejects a step into a wall', () => {
    const s = newGame(1);
    s.snake = [
      { x: 0, y: 25 },
      { x: 1, y: 25 },
      { x: 2, y: 25 },
      { x: 3, y: 25 },
    ];
    s.direction = 'left';
    // Food off to the left across the wall — bot must NOT step left.
    s.food = { x: 0, y: 0 };
    const dir = chooseDirection(s);
    expect(dir).not.toBe('left');
  });
});

describe('chooseDirection — greedy', () => {
  it('prefers the manhattan-minimising safe step', () => {
    const s = newGame(1);
    const cx = Math.floor(NIBBLES_BOARD_W / 2);
    const cy = Math.floor(NIBBLES_BOARD_H / 2);
    s.snake = [
      { x: cx,     y: cy },
      { x: cx - 1, y: cy },
      { x: cx - 2, y: cy },
      { x: cx - 3, y: cy },
    ];
    s.direction = 'right';
    // Food strictly UP from head — minimising manhattan picks 'up'.
    s.food = { x: cx, y: cy - 10 };
    expect(chooseDirection(s)).toBe('up');
  });

  it('still returns a direction when all options are unsafe (painted into corner)', () => {
    const s = newGame(1);
    // Tiny artificial corner trap. Head at (0,0), surrounded by body on
    // 'right' and 'down'; 'up' and 'left' walk off the board. Bot must
    // pick SOMETHING (caller accepts death).
    s.snake = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },  // blocks right
      { x: 1, y: 1 },
      { x: 0, y: 1 },  // blocks down
    ];
    s.direction = 'right';
    s.food = { x: 40, y: 25 };
    const dir = chooseDirection(s);
    // 'left' would be a 180° turn (which we filter), so 'up' is the legal
    // off-board step the bot returns. Either way, just confirm we got a
    // valid direction enum value rather than throwing or returning undef.
    expect(['up', 'down', 'left', 'right']).toContain(dir);
  });
});

// ---- 95th-percentile length calibration ----------------------------------
//
// Run 2000 bot-driven games with deterministic seeds; record `snake.length`
// at the moment of death; assert NIBBLES_MAX_LENGTH equals the empirical
// 95th percentile (rounded). The constant is hardcoded in nibbles.ts; this
// test PINS it so we notice if a bot-strategy change moves the distribution.
//
// Determinism: the array of seeds is fixed (1..2000) and the bot has no
// internal randomness, so a re-run on any machine produces the same lengths.

const SIM_SEEDS = Array.from({ length: 2000 }, (_, i) => i + 1);

function runBotGame(seed: number, maxTicks = 100_000): number {
  const s: NibblesState = newGame(seed);
  for (let i = 0; i < maxTicks && s.alive; i++) {
    const dir = chooseDirection(s);
    setDirection(s, dir);
    tick(s);
  }
  return s.snake.length;
}

describe('bot calibration — NIBBLES_MAX_LENGTH', () => {
  // 2000 deterministic bot games take ~7-8s; the default 5s vitest timeout
  // would fail intermittently on slower CI workers. 30s gives ample headroom.
  it('pins NIBBLES_MAX_LENGTH to the 95th-percentile death-length of 2000 bot games', { timeout: 30_000 }, () => {
    const lengths = SIM_SEEDS.map((seed) => runBotGame(seed)).sort((a, b) => a - b);
    const idx = Math.floor(lengths.length * 0.95);
    const p95 = lengths[idx]!;
    // Useful debug output if this ever drifts.
    // eslint-disable-next-line no-console
    console.log(
      `[nibbles calibration] N=${lengths.length} p50=${lengths[Math.floor(lengths.length / 2)]} ` +
        `p95=${p95} max=${lengths[lengths.length - 1]} board=${NIBBLES_BOARD_W}×${NIBBLES_BOARD_H}`,
    );
    expect(NIBBLES_MAX_LENGTH).toBe(p95);
  });
});
