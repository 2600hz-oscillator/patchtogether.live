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

// ── THE PERMANENT CONTROLS FOR THE VELOCITY RENORMALISATION ─────────────────
//
// Three shipped defects were three symptoms of one omission: nothing re-derived
// the ball's SPEED from `params.speed` after the serve. Each leg below fails on
// the pre-fix stepper by construction, so none of them is decoration.
describe('pong velocity — SPEED is live, english is an angle, |v| is bounded', () => {
  /** Step a rally forward, returning the state after `n` steps. */
  function run(state: PongState, params: PongParams, n: number, paddleCv = 0): PongState {
    let s = state;
    for (let i = 0; i < n; i++) {
      s = stepPongState(
        s,
        { paddleLCv: paddleCv, paddleRCv: paddleCv, dtSeconds: 0.025, rng: FIXED_RNG },
        params,
      );
    }
    return s;
  }

  /** Paddles that FOLLOW the ball, so the rally never ends.
   *
   * ⚠ LOAD-BEARING FOR THE TWO LEGS BELOW, and measured rather than assumed. With
   * FIXED paddles the ball soon misses, scores, and `resetState` re-derives the
   * velocity from `params.speed` — so the pre-fix stepper looked bounded and both
   * legs PASSED ON THE DEFECT. The unbounded growth only accumulates inside a rally
   * that does not end, which is exactly what the shipped ART test measures
   * (perfect trackers, zero scores over 5 s). `paddleCvToY` maps -1..1 onto 0..1,
   * so 2y-1 puts a paddle on the ball. */
  function runTracking(state: PongState, params: PongParams, n: number, lag = 0.06): PongState {
    let s = state;
    for (let i = 0; i < n; i++) {
      // ⚠ THE DISPLACEMENT IS THE WHOLE POINT. PERFECT tracking puts the paddle
      // exactly on the ball, so `by - paddleY` is 0, `offset` is 0 and ENGLISH
      // NEVER FIRES — measured: 400 steps, 6 paddle hits, vy stayed 0.00000 and
      // both the pre-fix and fixed steppers reported |v| = 0.55000. A lag inside
      // the half-height keeps the rally alive (it still hits) while making every
      // hit off-centre, which is the only way the accumulating kick is exercised.
      const cv = 2 * (s.ballY + lag) - 1;
      s = stepPongState(s, { paddleLCv: cv, paddleRCv: cv, dtSeconds: 0.025, rng: FIXED_RNG }, params);
    }
    return s;
  }

  const speedOf = (s: PongState) => Math.hypot(s.ballVX, s.ballVY);

  it('THE RANK-1 DEFECT: raising SPEED mid-rally changes the ball NOW, not at the next serve', () => {
    // Pre-fix, `params.speed` was read at exactly ONE site — resetState — so this
    // assertion failed by definition: the magnitude simply did not move until the
    // ball went out. ⚠ And with tracking paddles a rally is infinite, so SPEED
    // could be inert permanently.
    const s0 = initPongState(BASE_PARAMS, { rng: FIXED_RNG });
    const mid = run(s0, BASE_PARAMS, 4);
    const before = speedOf(mid);

    const faster = run(mid, { ...BASE_PARAMS, speed: 3.0 }, 1);
    const after = speedOf(faster);

    expect(
      after,
      `SPEED did not take effect mid-rally: |v| went ${before.toFixed(4)} -> ${after.toFixed(4)}. ` +
        'The knob is ranked FIRST on this face; a rank-1 control that does nothing until the ' +
        'ball goes out is worse than not shipping the face.',
    ).toBeGreaterThan(before * 1.5);
  });

  it('lowering SPEED also takes effect immediately — the control is symmetric', () => {
    // The other direction on the same mechanism, so a fix that only ever scales
    // UP (a floor, say) fails here.
    const mid = run(initPongState(BASE_PARAMS, { rng: FIXED_RNG }), BASE_PARAMS, 4);
    const slower = run(mid, { ...BASE_PARAMS, speed: 0.25 }, 1);
    expect(speedOf(slower)).toBeLessThan(speedOf(mid) * 0.9);
  });

  it('|v| TRACKS the commanded speed rather than drifting from it', () => {
    // The bound, stated as the property rather than as a cap: after any number of
    // steps the magnitude IS the commanded speed. Pre-fix it grew monotonically
    // with every paddle hit, with no clamp anywhere in the file.
    for (const speed of [0.25, 1.0, 4.0]) {
      const s = run(initPongState(BASE_PARAMS, { rng: FIXED_RNG }), { ...BASE_PARAMS, speed }, 40);
      const expected = 0.55 * speed; // BASE_SPEED · speed
      expect(
        speedOf(s),
        `|v| drifted from the commanded speed at speed=${speed}: ` +
          `${speedOf(s).toFixed(4)} vs ${expected.toFixed(4)}`,
      ).toBeCloseTo(expected, 5);
    }
  });

  it('UNBOUNDED-GROWTH CONTROL: a long rally against tracking paddles does not accelerate', () => {
    // The measured pre-fix failure mode: `vy += offset * BASE_SPEED * 0.4` on every
    // hit, no renormalisation, no cap — |v| ran away until the ball tunnelled a
    // paddle. Tracking paddles keep the rally alive, which is exactly the case
    // that used to accelerate without limit.
    // ⚠ AN ANGLED SERVE IS LOAD-BEARING HERE. With the flat BASE_PARAMS serve the
    // ball meets a centred paddle dead-on, `offset` is 0, and english NEVER FIRES —
    // so the pre-fix stepper would show no growth and this leg would pass on the
    // defect. Measured: with serveAngle 0 it passed both before and after the fix.
    const ENGLISH = { ...BASE_PARAMS, serveAngle: 0.6 };
    const long = runTracking(initPongState(ENGLISH, { rng: FIXED_RNG }), ENGLISH, 400);
    expect(
      speedOf(long),
      `a 400-step rally accelerated to ${speedOf(long).toFixed(4)} against a commanded ` +
        `${(0.55).toFixed(4)} — velocity is unbounded again`,
    ).toBeCloseTo(0.55, 5);
  });

  // ⚠ SCOPE, STATED INSIDE THE GATE: this is the ONE leg here that CANNOT fail on
  // the pre-fix stepper, and that is correct rather than a weakness. It guards a
  // failure mode the fix itself INTRODUCES — renormalisation holds |v| constant, so
  // repeated english steals from vx instead of growing vy. The unbounded version
  // could not asymptote toward vertical because its vx stayed put while vy ran
  // away. Verified: with the renormalisation removed, the other four legs go red
  // and this one stays green. It is a regression guard on the new mechanism, not
  // evidence about the old one.
  it('the ANGLE stays off-vertical, so a rally still terminates', () => {
    // ⚠ A CONSEQUENCE OF THE FIX, controlled deliberately. Renormalising holds |v|
    // constant, so repeated english steals from vx instead of growing vy — left
    // alone the ball would asymptote toward vertical and stall between the
    // paddles, a NEW failure the unbounded version did not have. The angle clamp
    // is what prevents it, and this is the leg that would catch its removal.
    // Same reason as the leg above: english must actually fire for the angle to
    // drift at all.
    const ENGLISH2 = { ...BASE_PARAMS, serveAngle: 0.6 };
    const long = runTracking(initPongState(ENGLISH2, { rng: FIXED_RNG }), ENGLISH2, 400);
    expect(
      Math.abs(long.ballVX),
      `horizontal motion collapsed (vx=${long.ballVX.toFixed(5)}, vy=${long.ballVY.toFixed(5)}) — ` +
        'the ball is asymptoting toward vertical and the rally cannot end',
    ).toBeGreaterThan(0.05);
  });
});
