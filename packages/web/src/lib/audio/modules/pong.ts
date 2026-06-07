// packages/web/src/lib/audio/modules/pong.ts
// Architectural reference: docs/design/game-modules.md
//
// PONG — interactive game module (research prototype).
//
// Single-user prototype matching the design in docs/design/game-modules.md.
// CV-in: paddle_left / paddle_right (each driving one paddle Y position).
// Gate-out: score_left / score_right (one 5 ms pulse per scoring event).
//
// Runtime shape (from the design):
//   - Pure state stepper in pong-state.ts (deterministic, tested in isolation).
//   - Two AnalyserNode taps read the paddle CVs once per scheduler-clock
//     tick (40 Hz, the same singleton sequencers + BUGGLES use).
//   - Two ConstantSourceNodes for the gate outputs; on a scoring tick we
//     schedule setValueAtTime(1, t) → setValueAtTime(0, t + 5ms) for the
//     winning side's gate. Sample-accurate via the audio thread.
//   - Live state cached on the handle; the card pulls it via
//     engine.read(node, 'snapshot') inside its own rAF.
//
// Why no audio worklet: the game logic runs at visual cadence (≤ 40 Hz),
// has no per-sample DSP, and benefits hugely from being easy to test and
// debug on the main thread. BUGGLES does this exact pattern today.
//
// Multi-user: NOT wired in this prototype. The design doc lays out the
// SyncedModuleDef wiring (peers compute identical state from shared
// epoch + params + rngSeed). Adding it is purely additive: expose a
// computeStateAt() and switch the module def's type to SyncedModuleDef.
//
// Inputs:
//   paddle_left (cv): bipolar Y position for the left paddle.
//   paddle_right (cv): bipolar Y position for the right paddle.
//
// Outputs:
//   score_left (gate): one 5 ms pulse on each left-side score event.
//   score_right (gate): one 5 ms pulse on each right-side score event.
//
// Params:
//   speed (log 0.25..4, default 1.0): ball speed multiplier.
//   paddleH (linear 0.05..0.5, default 0.2): paddle height as a fraction of screen.
//   serveAngle (linear 0..1, default 0.3): max serve-angle variance.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { getSchedulerClock, SCHEDULER_TICK_MS } from '$lib/audio/scheduler-clock';
import {
  initPongState,
  stepPongState,
  type PongParams,
  type PongState,
} from './pong-state';

export type { PongState, PongParams } from './pong-state';

/** Gate pulse width in seconds. Matches the project's BUGGLES.CLOCK_PULSE_MS
 *  convention so downstream gate consumers (envelopes, sequencers) see a
 *  pulse identical in width to every other module's gate output. */
const GATE_PULSE_S = 0.005;

/** Schedule cushion — the audio thread can be ahead of ctx.currentTime by
 *  one block (128 samples ≈ 2.7 ms at 48 kHz); a 5 ms cushion guarantees
 *  the rising edge isn't missed. */
const SCHEDULE_CUSHION_S = 0.005;

export const pongDef: AudioModuleDef = {
  type: 'pong',
  palette: { top: 'Games', sub: 'Arcade' },
  domain: 'audio',
  label: 'pong',
  category: 'games',
  schemaVersion: 1,
  vizPassthrough: true,

  inputs: [
    // paddle_* are bipolar CV in [-1, +1]; the stepper maps to [0, 1] Y.
    // No paramTarget — these are external inputs read at scheduler-tick
    // rate via AnalyserNode taps, NOT routed to an AudioParam.
    { id: 'paddle_left',  type: 'cv' },
    { id: 'paddle_right', type: 'cv' },
  ],
  outputs: [
    { id: 'score_left',  type: 'gate' },
    { id: 'score_right', type: 'gate' },
  ],
  params: [
    {
      id: 'speed', label: 'Speed',
      defaultValue: 1.0, min: 0.25, max: 4, curve: 'log',
    },
    {
      id: 'paddleH', label: 'Paddle',
      defaultValue: 0.2, min: 0.05, max: 0.5, curve: 'linear',
    },
    {
      id: 'serveAngle', label: 'Serve',
      defaultValue: 0.3, min: 0.0, max: 1.0, curve: 'linear',
    },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    // ---- CV input taps ---------------------------------------------------
    // Mirrors BUGGLES' pattern: a small-fftSize AnalyserNode tap per CV
    // input. The scheduler-tick callback reads the tail sample of each
    // and feeds it to the stepper.
    const paddleLeftAnalyser = ctx.createAnalyser();
    paddleLeftAnalyser.fftSize = 32;
    paddleLeftAnalyser.smoothingTimeConstant = 0;
    const paddleLeftBuf = new Float32Array(32);
    function readPaddleLeftCv(): number {
      paddleLeftAnalyser.getFloatTimeDomainData(paddleLeftBuf);
      return paddleLeftBuf[paddleLeftBuf.length - 1] ?? 0;
    }

    const paddleRightAnalyser = ctx.createAnalyser();
    paddleRightAnalyser.fftSize = 32;
    paddleRightAnalyser.smoothingTimeConstant = 0;
    const paddleRightBuf = new Float32Array(32);
    function readPaddleRightCv(): number {
      paddleRightAnalyser.getFloatTimeDomainData(paddleRightBuf);
      return paddleRightBuf[paddleRightBuf.length - 1] ?? 0;
    }

    // ---- Gate outputs ----------------------------------------------------
    const scoreLeftSrc = ctx.createConstantSource();
    scoreLeftSrc.offset.value = 0;
    scoreLeftSrc.start();
    const scoreRightSrc = ctx.createConstantSource();
    scoreRightSrc.offset.value = 0;
    scoreRightSrc.start();

    function pulseGate(src: ConstantSourceNode): void {
      const t = ctx.currentTime + SCHEDULE_CUSHION_S;
      // Cancel any pending schedule first so back-to-back scores within
      // GATE_PULSE_S (extremely unlikely with PONG, but the pattern
      // generalises to fast-tick games) don't leave the gate stuck high.
      try { src.offset.cancelScheduledValues(t); } catch { /* */ }
      src.offset.setValueAtTime(1, t);
      src.offset.setValueAtTime(0, t + GATE_PULSE_S);
    }

    // ---- Param cache + state --------------------------------------------
    const params: PongParams = {
      speed:      (node.params ?? {}).speed      ?? 1.0,
      paddleH:    (node.params ?? {}).paddleH    ?? 0.2,
      serveAngle: (node.params ?? {}).serveAngle ?? 0.3,
    };
    let state: PongState = initPongState(params);

    // ---- Scheduler tick subscription -----------------------------------
    // The shared singleton clock ticks every SCHEDULER_TICK_MS regardless
    // of which modules exist. Per BUGGLES + the sequencers it survives
    // main-thread jank because the tick source is a Web Worker. Each
    // tick: read CVs, step the stepper, fire any score gate.
    const dtSeconds = SCHEDULER_TICK_MS / 1000;
    const tick = () => {
      const paddleLCv = readPaddleLeftCv();
      const paddleRCv = readPaddleRightCv();
      state = stepPongState(
        state,
        { paddleLCv, paddleRCv, dtSeconds },
        params,
      );
      if (state.scoreEvent === 'L') pulseGate(scoreLeftSrc);
      else if (state.scoreEvent === 'R') pulseGate(scoreRightSrc);
    };
    const unsubscribe = getSchedulerClock().subscribe(tick);

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        // The taps are the routing target — incoming cv signals connect
        // INTO the analyser nodes; we read .getFloatTimeDomainData each
        // tick to get the tail sample.
        ['paddle_left',  { node: paddleLeftAnalyser,  input: 0 }],
        ['paddle_right', { node: paddleRightAnalyser, input: 0 }],
      ]),
      outputs: new Map([
        ['score_left',  { node: scoreLeftSrc,  output: 0 }],
        ['score_right', { node: scoreRightSrc, output: 0 }],
      ]),
      setParam(paramId, value) {
        if (paramId === 'speed' || paramId === 'paddleH' || paramId === 'serveAngle') {
          params[paramId] = value;
        }
      },
      readParam(paramId) {
        if (paramId === 'speed' || paramId === 'paddleH' || paramId === 'serveAngle') {
          return params[paramId];
        }
        return undefined;
      },
      read(key) {
        if (key === 'snapshot') return state;
        return undefined;
      },
      dispose() {
        unsubscribe();
        try { scoreLeftSrc.stop(); } catch { /* */ }
        try { scoreRightSrc.stop(); } catch { /* */ }
        scoreLeftSrc.disconnect();
        scoreRightSrc.disconnect();
        paddleLeftAnalyser.disconnect();
        paddleRightAnalyser.disconnect();
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Pure draw function — shared between the on-card 2D canvas and any future
// cross-domain video bridge. Pixel art-y: solid white-on-black, sharp
// rectangles. Pixel-perfect within the canvas backing store; the card
// uses a 2× DPR backing for crisp 16-bit-aesthetic edges.
// ---------------------------------------------------------------------------

export interface PongDrawOpts {
  /** Paddle visual width in CSS pixels. */
  paddleW?: number;
  /** Ball visual side length in CSS pixels (drawn as a square). */
  ballPx?: number;
  /** Foreground / accent color. */
  fg?: string;
  /** Background. */
  bg?: string;
}

export function drawPong(
  ctx2d: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  state: PongState,
  params: PongParams,
  w: number,
  h: number,
  opts: PongDrawOpts = {},
): void {
  const paddleW = opts.paddleW ?? 4;
  const ballPx = opts.ballPx ?? 6;
  const fg = opts.fg ?? '#dafff7';
  const bg = opts.bg ?? '#0b121a';

  // Background.
  ctx2d.fillStyle = bg;
  ctx2d.fillRect(0, 0, w, h);

  // Center dashed line (16-bit Pong vibe).
  ctx2d.fillStyle = fg;
  const dashH = 6;
  const dashGap = 6;
  const midX = Math.floor(w / 2) - 1;
  for (let y = 0; y < h; y += dashH + dashGap) {
    ctx2d.fillRect(midX, y, 2, dashH);
  }

  // Paddles.
  const paddleHpx = Math.max(8, Math.floor(params.paddleH * h));
  const leftY = Math.floor(state.paddleLY * h - paddleHpx / 2);
  const rightY = Math.floor(state.paddleRY * h - paddleHpx / 2);
  ctx2d.fillRect(2, leftY, paddleW, paddleHpx);
  ctx2d.fillRect(w - 2 - paddleW, rightY, paddleW, paddleHpx);

  // Ball.
  const bx = Math.floor(state.ballX * w - ballPx / 2);
  const by = Math.floor(state.ballY * h - ballPx / 2);
  ctx2d.fillRect(bx, by, ballPx, ballPx);

  // Scores — small monospace digits in each upper quadrant.
  ctx2d.font = '700 14px ui-monospace, monospace';
  ctx2d.textAlign = 'center';
  ctx2d.textBaseline = 'top';
  ctx2d.fillText(String(state.scoreL), Math.floor(w * 0.3), 4);
  ctx2d.fillText(String(state.scoreR), Math.floor(w * 0.7), 4);
}
