// packages/web/src/lib/audio/modules/pong-state.ts
//
// Pure deterministic game-state stepper for PONG. Kept separate from the
// AudioModuleDef factory so it's testable without Web Audio + reusable by
// the cross-peer SyncedModuleDef wiring planned in the design doc
// (docs/design/game-modules.md §2: PONG → `computeStateAt(t, params, rng)`).
//
// Coordinate system: field is [0, 1] × [0, 1]. Ball is a point; paddles are
// vertical line segments at x = 0 (left) and x = 1 (right) with center y
// driven by the paddle CV inputs (clamped + scaled into [0, 1]).
//
// Scoring: when the ball crosses x ≤ 0 the RIGHT side scored (the left
// paddle missed); when x ≥ 1 the LEFT side scored. The reset state on a
// score serves toward the side that just LOST (classic Pong convention)
// so the loser gets the next swing.

export interface PongParams {
  /** Ball speed multiplier. 1.0 = baseline. Log-curve fader 0.25..4. */
  speed: number;
  /** Paddle height as a fraction of field height. 0.05..0.5. */
  paddleH: number;
  /** Serve angle bias [0, 1]. 0 = flat horizontal, 1 = ±45°. */
  serveAngle: number;
}

export interface PongState {
  /** Ball center, both in [0, 1]. */
  ballX: number;
  ballY: number;
  /** Ball velocity in field-units per second. Sign drives direction. */
  ballVX: number;
  ballVY: number;
  /** Cumulative score totals. */
  scoreL: number;
  scoreR: number;
  /** Set for the single step in which a score happened. The factory reads
   *  this and pulses the corresponding gate output. Cleared on the next
   *  step (so each score = exactly one gate pulse). */
  scoreEvent: 'L' | 'R' | null;
  /** Last paddle Y positions (clamped to [0, 1]). Carried in state so the
   *  card snapshot can draw paddles without re-reading CV. */
  paddleLY: number;
  paddleRY: number;
}

/** Baseline ball speed at speed=1.0 — field-widths per second. 0.55 means
 *  the ball traverses the field in ~1.8 s, which is a comfortable
 *  playable cadence for a 200 px-wide card. */
const BASE_SPEED = 0.55;

/** Initial serve direction (sign of ballVX) on first init. The first serve
 *  goes right; the loser then serves toward themselves on every reset. */
const INITIAL_SERVE_DIR: 1 | -1 = 1;

export interface InitOptions {
  /** Deterministic RNG used to pick the initial Y velocity sign + jitter.
   *  Pass `() => 0.5` from tests for fully deterministic init. */
  rng?: () => number;
}

export function initPongState(params: PongParams, opts: InitOptions = {}): PongState {
  const rng = opts.rng ?? Math.random;
  return resetState(
    { scoreL: 0, scoreR: 0, paddleLY: 0.5, paddleRY: 0.5 },
    params,
    INITIAL_SERVE_DIR,
    rng,
  );
}

interface PartialScore {
  scoreL: number;
  scoreR: number;
  paddleLY: number;
  paddleRY: number;
}

function resetState(
  carry: PartialScore,
  params: PongParams,
  serveDir: 1 | -1,
  rng: () => number,
): PongState {
  // Velocity angle: serveAngle = 0 → flat, serveAngle = 1 → up to ±45°.
  // The ± is chosen by the RNG so consecutive serves alternate
  // un-predictably (otherwise the same trajectory loops forever).
  const maxAngleRad = (Math.PI / 4) * params.serveAngle;
  const angle = (rng() - 0.5) * 2 * maxAngleRad;
  const speed = BASE_SPEED * params.speed;
  return {
    ballX: 0.5,
    ballY: 0.5,
    ballVX: serveDir * speed * Math.cos(angle),
    ballVY: speed * Math.sin(angle),
    scoreL: carry.scoreL,
    scoreR: carry.scoreR,
    scoreEvent: null,
    paddleLY: carry.paddleLY,
    paddleRY: carry.paddleRY,
  };
}

/** Map raw CV (-1..+1 nominal, but tolerate any value) into a paddle Y
 *  position in [0, 1]. Bipolar CV centered on the field. */
export function paddleCvToY(cv: number): number {
  const y = 0.5 + cv * 0.5; // -1 → 0, 0 → 0.5, +1 → 1
  if (y < 0) return 0;
  if (y > 1) return 1;
  return y;
}

export interface StepInput {
  paddleLCv: number;
  paddleRCv: number;
  /** Seconds elapsed since last step. At 40 Hz scheduler-clock this is
   *  ~0.025; at 60 Hz it's ~0.0167. */
  dtSeconds: number;
  /** Deterministic RNG for serve-angle jitter on score-reset. Default
   *  Math.random — tests pass a seeded one. */
  rng?: () => number;
}

const BALL_RADIUS = 0.012; // visual radius; collision uses this for paddle hits

export function stepPongState(
  prev: PongState,
  input: StepInput,
  params: PongParams,
): PongState {
  const rng = input.rng ?? Math.random;
  // 1. Paddle Y from CV.
  const paddleLY = paddleCvToY(input.paddleLCv);
  const paddleRY = paddleCvToY(input.paddleRCv);

  // 2. Integrate ball position.
  let bx = prev.ballX + prev.ballVX * input.dtSeconds;
  let by = prev.ballY + prev.ballVY * input.dtSeconds;
  let vx = prev.ballVX;
  let vy = prev.ballVY;

  // 3. Top/bottom wall bounce. Reflect velocity, clamp position.
  if (by < BALL_RADIUS) {
    by = BALL_RADIUS;
    vy = Math.abs(vy);
  } else if (by > 1 - BALL_RADIUS) {
    by = 1 - BALL_RADIUS;
    vy = -Math.abs(vy);
  }

  // 4. Paddle collision: only when the ball crosses the paddle's X plane
  //    AND its Y is within the paddle's vertical extent. We test the
  //    AFTER-integration ball position; if it's now past the paddle but
  //    within range, reflect AND clamp the ball back to the paddle face
  //    so we never report a false-positive score on the next tick.
  const halfH = params.paddleH * 0.5;
  if (bx < BALL_RADIUS && vx < 0) {
    // Left paddle plane.
    if (Math.abs(by - paddleLY) <= halfH) {
      bx = BALL_RADIUS;
      vx = Math.abs(vx);
      // Add a touch of "english" — vertical kick proportional to where
      // on the paddle the ball hit. Classic Pong feel.
      const offset = (by - paddleLY) / halfH; // -1..+1
      vy += offset * BASE_SPEED * 0.4;
    }
  } else if (bx > 1 - BALL_RADIUS && vx > 0) {
    if (Math.abs(by - paddleRY) <= halfH) {
      bx = 1 - BALL_RADIUS;
      vx = -Math.abs(vx);
      const offset = (by - paddleRY) / halfH;
      vy += offset * BASE_SPEED * 0.4;
    }
  }

  // 5. Score detection. If we're STILL out-of-bounds after the collision
  //    pass, the relevant side missed.
  let scoreEvent: 'L' | 'R' | null = null;
  let scoreL = prev.scoreL;
  let scoreR = prev.scoreR;
  let serveDirOnReset: 1 | -1 | null = null;
  if (bx < 0) {
    // Ball off the left edge → right side scored. Serve next ball
    // toward the left (the loser).
    scoreEvent = 'R';
    scoreR += 1;
    serveDirOnReset = -1;
  } else if (bx > 1) {
    scoreEvent = 'L';
    scoreL += 1;
    serveDirOnReset = 1;
  }

  if (serveDirOnReset !== null && scoreEvent !== null) {
    // On a score-tick: build the post-serve reset state, but stamp the
    // scoreEvent onto it so the factory observes the event AND the
    // ball is already re-served by the time the next tick runs.
    // (The next tick reads the returned state's scoreEvent = (cleared
    // back to null naturally because stepPongState only sets it on a
    // score-detection branch).)
    const next = resetState(
      { scoreL, scoreR, paddleLY, paddleRY },
      params,
      serveDirOnReset,
      rng,
    );
    return { ...next, scoreEvent };
  }

  return {
    ballX: bx,
    ballY: by,
    ballVX: vx,
    ballVY: vy,
    scoreL,
    scoreR,
    scoreEvent,
    paddleLY,
    paddleRY,
  };
}
