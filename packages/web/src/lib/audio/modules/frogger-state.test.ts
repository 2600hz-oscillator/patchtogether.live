// packages/web/src/lib/audio/modules/frogger-state.test.ts
//
// Pure-state-stepper coverage. Mirrors modtris-state.test.ts in shape —
// no Web Audio, no React; just the deterministic stepper.

import { describe, it, expect } from 'vitest';
import {
  initFroggerState,
  startGame,
  stepFroggerState,
  detectRisingEdge,
  Direction,
  SpriteType,
  PlayerResult,
  COLS,
  ROWS,
  INITIAL_PLAYER_X,
  INITIAL_PLAYER_Y,
  INITIAL_PLAYER_LIVES,
  DEFAULT_TIME,
  type FroggerInputs,
  type FroggerParams,
  type FroggerState,
} from './frogger-state';

const DEFAULT_PARAMS: FroggerParams = { initialTime: DEFAULT_TIME };
const NO_INPUTS: FroggerInputs = { up: false, down: false, left: false, right: false, start: false };

describe('frogger-state — initial state', () => {
  it('initFroggerState has the upstream-spec player position + size', () => {
    const s = initFroggerState();
    expect(s.player.x).toBe(INITIAL_PLAYER_X);
    expect(s.player.y).toBe(INITIAL_PLAYER_Y);
    expect(s.player.lives).toBe(INITIAL_PLAYER_LIVES);
    expect(s.player.frogsHomeCount).toBe(0);
    expect(s.player.isAlive).toBe(true);
    expect(s.isGameInPlay).toBe(false); // pre-start state
    expect(s.level).toBe(1);
    expect(s.time).toBe(DEFAULT_TIME);
    expect(COLS).toBe(14);
    expect(ROWS).toBe(13);
  });

  it('sprite table loads with one home sprite per HOME_RESULT (5..9)', () => {
    const s = initFroggerState();
    const homes = s.sprites.filter((sp) => sp.type === SpriteType.HOME);
    expect(homes).toHaveLength(5);
    for (const h of homes) expect(h.visable).toBe(false);
  });

  it('there are vehicle + raft sprites populated', () => {
    const s = initFroggerState();
    const vehicles = s.sprites.filter((sp) => sp.type === SpriteType.VEHICLE);
    const rafts    = s.sprites.filter((sp) => sp.type === SpriteType.RAFT);
    expect(vehicles.length).toBeGreaterThan(5);
    expect(rafts.length).toBeGreaterThan(10);
  });
});

describe('frogger-state — start_gate semantics', () => {
  it('start input rising edge flips isGameInPlay true + resets player', () => {
    let s = initFroggerState();
    s = stepFroggerState(s, NO_INPUTS, DEFAULT_PARAMS, 0);
    expect(s.isGameInPlay).toBe(false);
    s = stepFroggerState(s, { ...NO_INPUTS, start: true }, DEFAULT_PARAMS, 0);
    expect(s.isGameInPlay).toBe(true);
    expect(s.player.x).toBe(INITIAL_PLAYER_X);
    expect(s.player.y).toBe(INITIAL_PLAYER_Y);
    expect(s.tick).toBeGreaterThan(0);
  });

  it('movement gates are IGNORED while !isGameInPlay (pre-start)', () => {
    let s = initFroggerState();
    const before = { x: s.player.x, y: s.player.y };
    s = stepFroggerState(s, { ...NO_INPUTS, up: true, left: true, right: true }, DEFAULT_PARAMS, 0);
    expect(s.player.x).toBe(before.x);
    expect(s.player.y).toBe(before.y);
    expect(s.isGameInPlay).toBe(false);
  });

  it('start_gate during play RESTARTS — score reset + homes cleared', () => {
    let s = initFroggerState();
    s = startGame(s, DEFAULT_PARAMS);
    // Manually mutate to simulate having scored a couple home-frogs.
    s.player.score = 250;
    s.player.frogsHomeCount = 2;
    s.sprites.find((sp) => sp.key === 'player-home-5')!.visable = true;
    s = stepFroggerState(s, { ...NO_INPUTS, start: true }, DEFAULT_PARAMS, 0);
    expect(s.player.score).toBe(0);
    expect(s.player.frogsHomeCount).toBe(0);
    expect(s.sprites.find((sp) => sp.key === 'player-home-5')?.visable).toBe(false);
    expect(s.isGameInPlay).toBe(true);
  });
});

describe('frogger-state — movement', () => {
  let live: FroggerState;
  function play(inputs: Partial<FroggerInputs> = {}, dt = 0): void {
    live = stepFroggerState(live, { ...NO_INPUTS, ...inputs }, DEFAULT_PARAMS, dt);
  }

  function reset() {
    live = initFroggerState();
    live = stepFroggerState(live, { ...NO_INPUTS, start: true }, DEFAULT_PARAMS, 0);
  }

  it('UP moves the player up one cell + scores 10 for a new lowestPoint', () => {
    reset();
    const startY = live.player.y;
    const startScore = live.player.score;
    play({ up: true });
    expect(live.player.y).toBe(startY - 1);
    expect(live.player.score).toBe(startScore + 10);
    expect(live.player.direction).toBe(Direction.UP);
  });

  it('LEFT and RIGHT change x, DOWN changes y back down', () => {
    reset();
    const sx = live.player.x;
    const sy = live.player.y;
    play({ left: true });
    expect(live.player.x).toBe(sx - 1);
    expect(live.player.direction).toBe(Direction.LEFT);
    play({ right: true });
    play({ right: true });
    expect(live.player.x).toBe(sx + 1);
    play({ up: true });
    play({ down: true });
    expect(live.player.y).toBe(sy);
  });

  it('movement is clamped at the grid edges (x∈[1,14], y∈[1,13])', () => {
    reset();
    // Walk left until x=1.
    for (let i = 0; i < 20; i++) play({ left: true });
    expect(live.player.x).toBe(1);
    // Now another LEFT should NOT take us to 0.
    play({ left: true });
    expect(live.player.x).toBe(1);
    // Down at y=13 (start row) should NOT advance to 14.
    expect(live.player.y).toBe(13);
    play({ down: true });
    expect(live.player.y).toBe(13);
  });
});

describe('frogger-state — collisions', () => {
  function freshGame(): FroggerState {
    let s = initFroggerState();
    s = stepFroggerState(s, { ...NO_INPUTS, start: true }, DEFAULT_PARAMS, 0);
    return s;
  }

  it('walking into a vehicle kills (loses a life + die event fires)', () => {
    let s = freshGame();
    // Place the player at a vehicle position by directly mutating the
    // sprite table — far cheaper than dragging the player there cell by
    // cell. Pick the row=12 left-moving car at x=6 (key=car1-2).
    const car = s.sprites.find((sp) => sp.key === 'car1-2')!;
    s.player.x = car.x;
    s.player.y = car.y + 1; // one row below the car, then move UP into it
    const prevLives = s.player.lives;
    s = stepFroggerState(s, { ...NO_INPUTS, up: true }, DEFAULT_PARAMS, 0);
    expect(s.events.died).toBe(true);
    expect(s.player.lives).toBe(prevLives - 1);
    expect(s.player.x).toBe(INITIAL_PLAYER_X);
    expect(s.player.y).toBe(INITIAL_PLAYER_Y);
  });

  it('stepping into water without a raft kills', () => {
    let s = freshGame();
    // Position the player just below the water (y=7 is bank, y=6 is water).
    s.player.y = 7;
    // Find an x that has NO raft on row 6.
    let safeX = 14;
    for (let x = 1; x <= 14; x++) {
      const raftAt = s.sprites.some((sp) => sp.type === SpriteType.RAFT && sp.x === x && sp.y === 6);
      if (!raftAt) { safeX = x; break; }
    }
    s.player.x = safeX;
    const prevLives = s.player.lives;
    s = stepFroggerState(s, { ...NO_INPUTS, up: true }, DEFAULT_PARAMS, 0);
    expect(s.events.died).toBe(true);
    expect(s.player.lives).toBe(prevLives - 1);
  });

  it('stepping into water ON a raft is safe', () => {
    let s = freshGame();
    s.player.y = 7;
    // Find the first turtle at y=6 + co-locate the player above-it so we can
    // step UP onto it.
    const raft = s.sprites.find((sp) => sp.type === SpriteType.RAFT && sp.y === 6)!;
    s.player.x = raft.x;
    const prevLives = s.player.lives;
    s = stepFroggerState(s, { ...NO_INPUTS, up: true }, DEFAULT_PARAMS, 0);
    expect(s.events.died).toBe(false);
    expect(s.player.lives).toBe(prevLives);
    expect(s.player.y).toBe(6);
  });
});

describe('frogger-state — homes + level completion', () => {
  function inGame(): FroggerState {
    let s = initFroggerState();
    s = stepFroggerState(s, { ...NO_INPUTS, start: true }, DEFAULT_PARAMS, 0);
    return s;
  }

  it('reaching the first home opens it + fires home_gate event', () => {
    let s = inGame();
    s.player.x = 1;   // HOME1 range = (1, 2)
    s.player.y = 2;   // one cell below row 1
    s = stepFroggerState(s, { ...NO_INPUTS, up: true }, DEFAULT_PARAMS, 0);
    expect(s.events.homesScored).toBe(1);
    expect(s.sprites.find((sp) => sp.key === `player-home-${PlayerResult.HOME1}`)?.visable).toBe(true);
    // Player reset to start after home scored.
    expect(s.player.x).toBe(INITIAL_PLAYER_X);
    expect(s.player.y).toBe(INITIAL_PLAYER_Y);
    expect(s.player.frogsHomeCount).toBe(1);
  });

  it('all 5 homes filled fires level_gate + resets homes for next level', () => {
    let s = inGame();
    // Programatically fill all 5 homes by directly stepping the player to
    // each home's bottom cell + moving up. The simpler path: just set
    // 4 homes visible then walk into the 5th.
    s.sprites.find((sp) => sp.key === 'player-home-5')!.visable = true;
    s.sprites.find((sp) => sp.key === 'player-home-6')!.visable = true;
    s.sprites.find((sp) => sp.key === 'player-home-7')!.visable = true;
    s.sprites.find((sp) => sp.key === 'player-home-8')!.visable = true;
    s.player.frogsHomeCount = 4;
    s.player.x = 14; // HOME5 range = (13, 14)
    s.player.y = 2;
    s = stepFroggerState(s, { ...NO_INPUTS, up: true }, DEFAULT_PARAMS, 0);
    expect(s.events.levelComplete).toBe(true);
    expect(s.level).toBe(2);
    expect(s.player.frogsHomeCount).toBe(0);
    // Homes reset for the next level.
    for (let kind = 5; kind <= 9; kind++) {
      expect(s.sprites.find((sp) => sp.key === `player-home-${kind}`)?.visable).toBe(false);
    }
  });

  it('walking into a wall between homes (y=1 non-home x) kills', () => {
    let s = inGame();
    s.player.x = 3;  // gap between HOME1 (1-2) + HOME2 (4-5)
    s.player.y = 2;
    s = stepFroggerState(s, { ...NO_INPUTS, up: true }, DEFAULT_PARAMS, 0);
    expect(s.events.died).toBe(true);
  });
});

describe('frogger-state — timer', () => {
  it('timer counts down ~1 unit per second; ZERO triggers death', () => {
    const params: FroggerParams = { initialTime: 12 };
    let s = initFroggerState(params);
    // Start using the same params so the new game's defaultTime + time = 12.
    s = stepFroggerState(s, { ...NO_INPUTS, start: true }, params, 0);
    expect(s.time).toBe(12);
    // 5 seconds elapse — the per-second timer counter decrements 5 times.
    s = stepFroggerState(s, NO_INPUTS, params, 5);
    expect(s.time).toBe(7);
    // 7 more seconds — timer hits zero, player dies, world reset to
    // defaultTime (which is also 12).
    s = stepFroggerState(s, NO_INPUTS, params, 7);
    expect(s.events.died).toBe(true);
    expect(s.time).toBe(12); // reset
  });
});

describe('frogger-state — sprites advance via spriteTick', () => {
  it('sprite positions evolve with elapsed dt', () => {
    let s = initFroggerState();
    s = stepFroggerState(s, { ...NO_INPUTS, start: true }, DEFAULT_PARAMS, 0);
    const before = s.sprites.map((sp) => ({ key: sp.key, x: sp.x, y: sp.y }));
    // Advance ~3 seconds → 300 sprite-ticks (cap of 20 per step → 1 step of
    // 200ms gives 20 ticks; let's run many small steps).
    for (let i = 0; i < 30; i++) {
      s = stepFroggerState(s, NO_INPUTS, DEFAULT_PARAMS, 0.1);
    }
    const after = s.sprites.map((sp) => ({ key: sp.key, x: sp.x, y: sp.y }));
    // At least ONE non-home sprite must have moved.
    let moved = 0;
    for (let i = 0; i < before.length; i++) {
      if (before[i]!.x !== after[i]!.x || before[i]!.y !== after[i]!.y) moved++;
    }
    expect(moved).toBeGreaterThan(0);
  });
});

describe('detectRisingEdge', () => {
  it('matches the standard prev<0.5 ≤ curr threshold', () => {
    expect(detectRisingEdge(0, 1)).toBe(true);
    expect(detectRisingEdge(0.49, 0.5)).toBe(true);
    expect(detectRisingEdge(0.5, 0.6)).toBe(false); // prev not < threshold
    expect(detectRisingEdge(0.6, 1)).toBe(false);
    expect(detectRisingEdge(1, 0)).toBe(false);     // falling edge
  });
});
