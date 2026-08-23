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

/**
 * mulberry32 — a tiny deterministic PRNG, same seed ⇒ same stream.
 *
 * ⚠ LOCAL ON PURPOSE. Two copies exist under `lib/video` (mirrorpool-core,
 * toybox-random), and importing one would couple an AUDIO module to the video
 * layer for four lines of arithmetic. It is used only by the VRT seed pin below.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pongDef: AudioModuleDef = {
  type: 'pong',
  palette: { top: 'Games', sub: 'Arcade' },
  domain: 'audio',
  label: 'pong',
  category: 'games',
  vizPassthrough: true,

  inputs: [
    // paddle_* are bipolar CV in [-1, +1]; the stepper maps to [0, 1] Y.
    // No paramTarget — these are external inputs read at scheduler-tick
    // rate via AnalyserNode taps, NOT routed to an AudioParam.
    { id: 'paddle_left',  type: 'cv' },
    { id: 'paddle_right', type: 'cv' },
  ],
  outputs: [
    { id: 'score_left',  type: 'gate', edge: 'trigger' },
    { id: 'score_right', type: 'gate', edge: 'trigger' },
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
    // ⚠ A DETERMINISM HOOK, NOT A CONTROL — spelled exactly as every video def
    // spells it so `freezeFaceVideo` reaches it with no special case. It exists
    // because this face carries a LIVE COURT at the dock, and a VRT scene cannot
    // baseline a running game. See `noUserControl` directly below: without that
    // declaration this becomes a fourth turnable param and the Push card offers
    // "stop the game" under an encoder.
    { id: 'freeze', label: 'Freeze', defaultValue: 0, min: 0, max: 1, curve: 'linear' },
  ],

  // ⚠ WITHOUT THIS, `freeze` IS A FOURTH TURNABLE PARAM. Three consumers change
  // behaviour on this one declaration: the group instrument bar stops
  // auto-exposing it, the Push card stops ranking it, and module-face-lint
  // asserts it renders EXACTLY ZERO cells — an INVERTED assertion, which is what
  // makes the claim falsifiable in both directions rather than merely absent.
  //
  // ⚠ THIS IS THE DEFECT LUSHGARDEN SHIPPED WITH, avoided one module later: three
  // synthetic params on live Push encoders, one of which latched the module dead.
  // Declaring it here is the cheap half of not repeating it.
  noUserControl: [
    {
      param: 'freeze',
      writer: 'internal',
      why:
        'a VRT determinism hook — at >= 0.5 the scheduler tick returns before stepping the '
        + 'game, so the ball, the paddles and the score all hold and the surface repaints one '
        + 'frame. Nothing in the product writes it except the face scene harness, and the day '
        + 'a freeze CV input appears this entry reddens and gets re-read.',
    },
  ],

  // ── THE FACEPLATE (PF-20) ─────────────────────────────────────────────────
  //
  // ⚠ THE PROMOTION IS THE FIX, NOT A SKIN. Today on main pong is not in
  // NON_SHELL_LANE_TYPES, not in STRICT_FACES and not a CARD_PRODUCER, so
  // laneRenderKind returns 'placeholder': under the shipping shell the lane tile
  // is an empty plate — no court, no score, no faders — WHILE THE GAME RUNS,
  // scores, and pulses its gate outputs into whatever is patched. Every pong e2e
  // drives ?shell=legacy, so nothing in the suite has ever observed it.
  //
  // WHAT THE MODULE IS FOR: a CV-steered arcade game whose two gate outputs are
  // the point — the rally is a clock and the scores are its events.
  face: {
    // THE RANK.
    //
    // `speed` is rank 1 because it is the module's TEMPO, and on a module whose
    // outputs are GATES that is rank 1 by definition: everything downstream of
    // score_left/score_right is being clocked by how long a rally takes, and
    // speed is the only control that scales that directly. ⚠ It is ranked first
    // DESPITE having been inert mid-rally until this same PR fixed it — the
    // argument for ranking is what the module IS, not what a bug made it feel
    // like. Ranking around a defect you are fixing in the same diff would bake
    // the defect into the UI permanently.
    //
    // `paddleH` is the strongest runner-up: it is the ONLY param read every step
    // rather than only at resetState, so it is the only one whose effect lands on
    // the very next frame and applies to the rally in progress. On a module you
    // WATCH, "acts now" is a real claim. It loses because it changes the game's
    // DIFFICULTY, not its RATE, and a rack cares about rate.
    //
    // `serveAngle` is genuinely third: it does nothing to a rally already in
    // flight and its effect is statistical — you must watch several serves to see
    // it. A control that needs three serves to evaluate cannot earn a lane column.
    order: ['speed', 'paddleH', 'serveAngle'],

    // ⚠ ONE BAND, and that is the honest answer rather than a missing decision.
    // Three controls over one game is a single idea; two bands of one-and-two
    // would each earn a header that says nothing the grid has not said. Far below
    // DOCK_TAB_MIN_BANDS, so no rail — and padding pages to reach one is refused.

    // ⚠ NOTHING DECLARED, and every alternative was checked. `fader` is for a
    // LEVEL the player expects as a THROW; a log 0.25..4 tempo multiplier, a
    // paddle height and an angle bias are none of them. No param here is
    // discrete, so `options` does not apply, and there is no wrapping angle for
    // `hue` — serveAngle is a BIAS on a range, not a position on a circle.

    // ⚠ MANDATORY, AND COUNTER-INTUITIVE ON AN AUDIO DEF. Both outputs are
    // type: 'gate', so primaryAudioOutPortId returns null and EVERY other glyph
    // literal resolves to a dead {kind:static} that reddens the dead-glyph clause.
    //
    // ⚠ AND THE LANE TILE THEREFORE HAS NO COURT. hasVideoSurface is
    // domain === 'video' and pong is audio, so there is no VideoTileThumb either.
    // The lane gets three faders and no picture. That is a PLATFORM gap, not a
    // choice: ShellExtension.glyph renders only under binding.kind === "algorithm",
    // and that branch requires an `algorithm` param. shell-glyph-live.ts already
    // prescribes the fix in its own comment — widen THAT branch to carry a
    // layout-source id rather than adding a third glyph literal. pong is the
    // SECOND of five modules to hit it (timelorde, scope, rasterize, wavesculpt).
    glyph: 'none',

    // The court lives here (#1928): promotion stops both surfaces rendering the
    // legacy card, so the dock body is the ONLY place the game can still be seen.
    // See `$lib/ui/modules/pong/shell-extension.ts`.
    extension: 'pong',
  },
  docs: {
    explanation:
      "A playable two-paddle Pong game wrapped as a CV/gate module — the rally drives the patch. A ball bounces between a left and right paddle; you position each paddle with a CV input (so an LFO, sequencer, envelope follower, or a JOYSTICK CV plays it — wire one side to a slow LFO for an auto-rally, or two players each on their own CV), and the game emits a gate pulse whenever a side scores (the ball gets past the opposite paddle). So Pong becomes a generative trigger source whose pulse timing depends on the back-and-forth. The court renders on the card's 2D canvas; since the module is vizPassthrough, that canvas can be portaled into a containing GROUP card for cross-domain video. SPEED scales the ball velocity, PADDLE sets paddle height, and SERVE sets how wide the serve angle varies.",
    inputs: {
      paddle_left:
        "Bipolar CV (−1..+1) setting the LEFT paddle's vertical position — −1 = top, 0 = center, +1 = bottom. Read at scheduler-tick rate (it's a continuous position, not a gate). Drive it with an LFO for an auto-rally, a sequencer for stepped jumps, or a JOYSTICK/MIDI CV to play by hand.",
      paddle_right: "Bipolar CV (−1..+1) setting the RIGHT paddle's vertical position (−1 top, 0 center, +1 bottom). The opponent's paddle — drive it the same way as the left.",
    },
    outputs: {
      score_left:
        "Fires a 5 ms pulse each time the LEFT side scores (the ball passes the RIGHT paddle). A trigger you can route to a sound, counter, or scene change to sonify the rally's outcome.",
      score_right: "Fires a 5 ms pulse each time the RIGHT side scores (the ball passes the LEFT paddle).",
    },
    controls: {
      speed: "Ball speed multiplier (0.25..4, log, default 1) — scales how fast the ball travels, so faster = quicker rallies and a denser stream of SCORE pulses.",
      paddleH: "Paddle height as a fraction of the court (0.05..0.5, default 0.2) — taller paddles are easier to defend with (longer rallies, fewer scores); shorter paddles miss more often.",
      serveAngle: "Serve-angle variance (0..1, default 0.3) — how much the launch angle randomly varies on each serve. 0 = nearly flat, predictable serves; 1 = wide, steep, unpredictable serves.",
      freeze: "A determinism hold for visual regression capture, not a performance control — it is declared noUserControl, so no faceplate, Push encoder or group instrument bar offers it. At 0.5 and above the scheduler tick returns before stepping the game, so the ball, the paddles and the score all hold and the court repaints an identical frame; below 0.5 the game runs normally. Nothing in the product writes it except the VRT face-scene harness.",
    },
  },

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
    // ⚠ DELIBERATELY NOT A `PongParams` FIELD. `PongParams` is the pure stepper's
    // PHYSICS contract — speed, paddle height, serve angle. `freeze` is a harness
    // hook that decides whether the stepper RUNS AT ALL, so putting it in there
    // would hand the pure function a flag it must ignore and invite someone to
    // branch on it inside the physics. It lives beside the cache instead.
    let freeze = (node.params ?? {}).freeze ?? 0;
    // ── THE VRT SEED PIN ────────────────────────────────────────────────
    //
    // ⚠ READ AT CONSTRUCTION, WHICH IS THE `simPin` CONTRACT. The harness installs
    // its globals with `addInitScript`, i.e. before any module factory runs, so a
    // factory that reads one HERE sees it and a factory that reads it later may
    // not. Pong is main-thread (no `renderLocus`), so the page global is visible —
    // unlike acidwarp, whose factory runs in a Worker with its own global scope and
    // is therefore unreachable by simPin at all.
    //
    // ⚠ FREEZE ALONE IS NOT ENOUGH, and that is measured rather than assumed:
    // "freezeFaceVideo stops the picture; it does not choose WHICH picture" —
    // outlines measured 6724 px against a 1500 px tolerance across two ubuntu CI
    // boots with freeze and no pin. The pin is unusually cheap on this module
    // because the game is ALREADY a pure function of tick count (dtSeconds is a
    // constant, never a measurement), so `Math.random` at serve time is the only
    // nondeterminism left — and both stepper entry points already accept an
    // injectable rng.
    const vrtSeed = (globalThis as { __pongVrtSeed?: number }).__pongVrtSeed;
    const rng = typeof vrtSeed === "number" ? mulberry32(vrtSeed) : Math.random;
    let state: PongState = initPongState(params, { rng });

    // ---- Scheduler tick subscription -----------------------------------
    // The shared singleton clock ticks every SCHEDULER_TICK_MS regardless
    // of which modules exist. Per BUGGLES + the sequencers it survives
    // main-thread jank because the tick source is a Web Worker. Each
    // tick: read CVs, step the stepper, fire any score gate.
    const dtSeconds = SCHEDULER_TICK_MS / 1000;
    const tick = () => {
      // ⚠ THE FREEZE GATE, AND IT MUST COME FIRST. Returning before the step holds
      // the ball, the paddles AND the score. A freeze that ran the step and merely
      // skipped the draw would still advance the game and still fire score gates
      // into whatever is patched — which is not a freeze, it is a hidden game.
      if (freeze >= 0.5) return;
      const paddleLCv = readPaddleLeftCv();
      const paddleRCv = readPaddleRightCv();
      state = stepPongState(
        state,
        // ⚠ THE SAME STREAM, not a second one. `resetState` draws from `rng` on
        // every serve, so handing the stepper a different generator would leave
        // the capture deterministic only until the first point was scored.
        { paddleLCv, paddleRCv, dtSeconds, rng },
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
        } else if (paramId === 'freeze') {
          freeze = value;
        }
      },
      readParam(paramId) {
        if (paramId === 'speed' || paramId === 'paddleH' || paramId === 'serveAngle') {
          return params[paramId];
        }
        if (paramId === 'freeze') return freeze;
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
