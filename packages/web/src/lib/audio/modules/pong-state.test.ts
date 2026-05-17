// packages/web/src/lib/audio/modules/pong-state.test.ts
//
// Unit tests for the pure PONG state stepper. No Web Audio, no DOM.

import { describe, it, expect } from 'vitest';
import {
  initPongState,
  stepPongState,
  paddleCvToY,
  type PongParams,
  type PongState,
} from './pong-state';

const BASE_PARAMS: PongParams = {
  speed: 1.0,
  paddleH: 0.2,
  serveAngle: 0.0, // flat horizontal serves keep tests deterministic
};

// Deterministic RNG that always returns 0.5 (no jitter). For tests we don't
// want serve-angle randomness to make scoring non-deterministic.
const FIXED_RNG = () => 0.5;

describe('paddleCvToY', () => {
  it('maps -1 → 0', () => {
    expect(paddleCvToY(-1)).toBe(0);
  });
  it('maps 0 → 0.5', () => {
    expect(paddleCvToY(0)).toBe(0.5);
  });
  it('maps +1 → 1', () => {
    expect(paddleCvToY(1)).toBe(1);
  });
  it('clamps out-of-range', () => {
    expect(paddleCvToY(-2)).toBe(0);
    expect(paddleCvToY(2)).toBe(1);
  });
});

describe('initPongState', () => {
  it('starts ball at field center', () => {
    const s = initPongState(BASE_PARAMS, { rng: FIXED_RNG });
    expect(s.ballX).toBe(0.5);
    expect(s.ballY).toBe(0.5);
  });
  it('starts paddles at field center', () => {
    const s = initPongState(BASE_PARAMS, { rng: FIXED_RNG });
    expect(s.paddleLY).toBe(0.5);
    expect(s.paddleRY).toBe(0.5);
  });
  it('starts with zero scores', () => {
    const s = initPongState(BASE_PARAMS, { rng: FIXED_RNG });
    expect(s.scoreL).toBe(0);
    expect(s.scoreR).toBe(0);
  });
  it('starts with no score event', () => {
    const s = initPongState(BASE_PARAMS, { rng: FIXED_RNG });
    expect(s.scoreEvent).toBeNull();
  });
  it('initial serve direction is rightward', () => {
    const s = initPongState(BASE_PARAMS, { rng: FIXED_RNG });
    expect(s.ballVX).toBeGreaterThan(0);
  });
  it('serveAngle=0 produces zero vertical velocity', () => {
    const s = initPongState(BASE_PARAMS, { rng: FIXED_RNG });
    expect(Math.abs(s.ballVY)).toBeLessThan(1e-9);
  });
});

describe('stepPongState — ball motion', () => {
  it('advances ball X by velocity × dt', () => {
    const s0 = initPongState(BASE_PARAMS, { rng: FIXED_RNG });
    const dt = 0.025;
    const s1 = stepPongState(
      s0,
      { paddleLCv: 0, paddleRCv: 0, dtSeconds: dt, rng: FIXED_RNG },
      BASE_PARAMS,
    );
    expect(s1.ballX).toBeCloseTo(s0.ballX + s0.ballVX * dt, 6);
  });

  it('bounces off the top wall', () => {
    // Manually craft a state with upward velocity near the top.
    const s0: PongState = {
      ballX: 0.5, ballY: 0.05,
      ballVX: 0.1, ballVY: -0.5,
      scoreL: 0, scoreR: 0, scoreEvent: null,
      paddleLY: 0.5, paddleRY: 0.5,
    };
    const s1 = stepPongState(
      s0,
      { paddleLCv: 0, paddleRCv: 0, dtSeconds: 0.1, rng: FIXED_RNG },
      BASE_PARAMS,
    );
    expect(s1.ballVY).toBeGreaterThan(0); // velocity flipped to downward
  });

  it('bounces off the bottom wall', () => {
    const s0: PongState = {
      ballX: 0.5, ballY: 0.95,
      ballVX: 0.1, ballVY: 0.5,
      scoreL: 0, scoreR: 0, scoreEvent: null,
      paddleLY: 0.5, paddleRY: 0.5,
    };
    const s1 = stepPongState(
      s0,
      { paddleLCv: 0, paddleRCv: 0, dtSeconds: 0.1, rng: FIXED_RNG },
      BASE_PARAMS,
    );
    expect(s1.ballVY).toBeLessThan(0);
  });
});

describe('stepPongState — paddle collisions', () => {
  it('left paddle reflects the ball when in range', () => {
    const s0: PongState = {
      ballX: 0.02, ballY: 0.5,
      ballVX: -0.3, ballVY: 0,
      scoreL: 0, scoreR: 0, scoreEvent: null,
      paddleLY: 0.5, paddleRY: 0.5,
    };
    const s1 = stepPongState(
      s0,
      { paddleLCv: 0, paddleRCv: 0, dtSeconds: 0.1, rng: FIXED_RNG },
      BASE_PARAMS,
    );
    expect(s1.ballVX).toBeGreaterThan(0); // reflected
    expect(s1.scoreEvent).toBeNull();
  });

  it('left paddle misses the ball when out of range → right scores', () => {
    const s0: PongState = {
      ballX: 0.02, ballY: 0.9, // ball is high
      ballVX: -0.3, ballVY: 0,
      scoreL: 0, scoreR: 0, scoreEvent: null,
      paddleLY: 0.1, paddleRY: 0.5, // left paddle is low — miss
    };
    const s1 = stepPongState(
      s0,
      { paddleLCv: -0.8, paddleRCv: 0, dtSeconds: 0.5, rng: FIXED_RNG },
      BASE_PARAMS,
    );
    expect(s1.scoreEvent).toBe('R');
    expect(s1.scoreR).toBe(1);
    expect(s1.scoreL).toBe(0);
  });

  it('right paddle misses → left scores', () => {
    const s0: PongState = {
      ballX: 0.98, ballY: 0.1,
      ballVX: 0.3, ballVY: 0,
      scoreL: 0, scoreR: 0, scoreEvent: null,
      paddleLY: 0.5, paddleRY: 0.9,
    };
    const s1 = stepPongState(
      s0,
      { paddleLCv: 0, paddleRCv: 0.8, dtSeconds: 0.5, rng: FIXED_RNG },
      BASE_PARAMS,
    );
    expect(s1.scoreEvent).toBe('L');
    expect(s1.scoreL).toBe(1);
  });
});

describe('stepPongState — score event semantics', () => {
  it('scoreEvent fires for exactly one tick after a score', () => {
    // Step 1: score happens.
    const s0: PongState = {
      ballX: 0.98, ballY: 0.1,
      ballVX: 0.5, ballVY: 0,
      scoreL: 0, scoreR: 0, scoreEvent: null,
      paddleLY: 0.5, paddleRY: 0.9,
    };
    const s1 = stepPongState(
      s0,
      { paddleLCv: 0, paddleRCv: 0.8, dtSeconds: 0.5, rng: FIXED_RNG },
      BASE_PARAMS,
    );
    expect(s1.scoreEvent).toBe('L');

    // Step 2: next tick, scoreEvent should be cleared back to null.
    const s2 = stepPongState(
      s1,
      { paddleLCv: 0, paddleRCv: 0, dtSeconds: 0.025, rng: FIXED_RNG },
      BASE_PARAMS,
    );
    expect(s2.scoreEvent).toBeNull();
    expect(s2.scoreL).toBe(1); // running total preserved
  });

  it('serves toward the loser after a score', () => {
    // Right paddle missed → left scored → serve goes toward the right (loser).
    const s0: PongState = {
      ballX: 0.98, ballY: 0.1,
      ballVX: 0.5, ballVY: 0,
      scoreL: 0, scoreR: 0, scoreEvent: null,
      paddleLY: 0.5, paddleRY: 0.9,
    };
    const s1 = stepPongState(
      s0,
      { paddleLCv: 0, paddleRCv: 0.8, dtSeconds: 0.5, rng: FIXED_RNG },
      BASE_PARAMS,
    );
    expect(s1.scoreEvent).toBe('L');
    expect(s1.ballVX).toBeGreaterThan(0); // serving rightward toward right-loser
    expect(s1.ballX).toBe(0.5); // re-centered
    expect(s1.ballY).toBe(0.5);
  });
});

describe('stepPongState — determinism', () => {
  it('two identical inputs produce identical states (cross-peer sync prereq)', () => {
    const params = BASE_PARAMS;
    const trajectory: StepInput[] = [];
    for (let i = 0; i < 50; i++) {
      trajectory.push({
        paddleLCv: Math.sin(i * 0.2) * 0.5,
        paddleRCv: Math.cos(i * 0.13) * 0.5,
        dtSeconds: 0.025,
        rng: FIXED_RNG,
      });
    }
    let stateA = initPongState(params, { rng: FIXED_RNG });
    let stateB = initPongState(params, { rng: FIXED_RNG });
    for (const inp of trajectory) {
      stateA = stepPongState(stateA, inp, params);
      stateB = stepPongState(stateB, inp, params);
      expect(stateA).toEqual(stateB);
    }
  });
});

interface StepInput {
  paddleLCv: number;
  paddleRCv: number;
  dtSeconds: number;
  rng: () => number;
}
