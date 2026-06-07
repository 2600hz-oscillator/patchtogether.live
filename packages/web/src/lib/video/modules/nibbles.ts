// packages/web/src/lib/video/modules/nibbles.ts
//
// NIBBLES — QBasic-Nibbles snake game as a patchable video module with CV
// gate outputs + a length CV + dual audio outputs.
//
// Shape mirrors `doom.ts`: a VIDEO module that ALSO publishes AudioNodes
// via `audioSources` for the cross-domain video→audio bridge.
//
// Outputs:
//   - `out`         (video)  — 320×200 CPU-rasterised game frame + a mild
//                              CRT scanline darken (every other row dimmed
//                              ~15%; the bentbox effect, gently).
//   - `pellet`      (gate)   — 10 ms pulse on pellet eat.
//   - `death`       (gate)   — 10 ms pulse on snake death.
//   - `dir_change`  (gate)   — 10 ms pulse on every direction change
//                              (human or auto).
//   - `length_cv`   (cv)     — (length - mid) / mid, mapped to ±1 with
//                              mid = NIBBLES_MAX_LENGTH/2. Smoothed at
//                              the game-tick rate (~12 Hz at default).
//   - `snake`       (audio)  — continuous square wave at a length-derived
//                              freq (length 4 = A2 = 110 Hz; +12 length
//                              ticks = +1 octave).
//   - `gated`       (audio)  — same square wave routed through an
//                              envelope (15 ms attack, 100 ms plateau,
//                              500 ms exp decay) fired on each pellet eat.
//
// Inputs: none. Auto mode + arrow-key focus drive the snake.
//
// Game state is FACTORY-INTERNAL — it never touches node.data, so the
// persistence layer naturally drops it (a fresh game seeds on every
// card mount via Date.now()).

import type { VideoModuleDef } from '$lib/video/module-registry';
import type {
  VideoEngineContext,
  VideoNodeHandle,
  VideoNodeSurface,
} from '$lib/video/engine';
import {
  drainEvents,
  newGame,
  setDirection,
  tick as gameTick,
  type NibblesDirection,
  type NibblesState,
} from './nibbles-game';
import { chooseDirection } from './nibbles-bot';

// ---- Calibration: 95th-percentile bot-game death length -------------------
//
// Derived from `nibbles-bot.test.ts` "bot calibration" — 2000 deterministic
// bot games with seeds 1..2000; the constant pinned to the 95th percentile
// of the death-length distribution. The bot has no foresight, so even on a
// 4000-cell board it paints itself into corners well before filling the
// board — this empirical cap stops the length-CV from collapsing into a
// tiny sliver of its range at the high end.
//
// Length values above this clamp to +1 on length_cv. If the bot strategy
// changes (or someone tweaks the bot to be smarter), re-run the calibration
// test and update the constant — the test will fail loudly if they drift.
//
// IMPORTANT: changing this value also rebases the length_cv mapping AND
// the snake-square-wave frequency mapping (see header).
//
// Empirical calibration (2000 bot games, seeds 1..2000 on the 80×50 board):
//   p50 = 67
//   p95 = 119
//   max = 180
// Board has 4000 cells; the bot's greedy no-foresight strategy traps itself
// on the surrounding tail well before filling the board.
export const NIBBLES_MAX_LENGTH = 119;

const INTERNAL_W = 320;
const INTERNAL_H = 200;
const CELL = 4;
const BOARD_W = INTERNAL_W / CELL; // 80
const BOARD_H = INTERNAL_H / CELL; // 50

const GATE_PULSE_S = 0.01;          // 10 ms gate pulse — same as sequencer/DOOM.
const GATED_ATTACK_S = 0.015;
const GATED_PLATEAU_S = 0.1;
const GATED_DECAY_TOTAL_S = 0.5;     // attack+plateau+decay ≤ 500 ms total
// Exponential time-constant for the decay tail. setTargetAtTime decays to
// ~37% at one time-constant — we want a clean fade to ~0 by the end of the
// 500 ms window, so a τ of ~85 ms gets us 4-5 time-constants in the
// remaining (500 - 15 - 100) = 385 ms.
const GATED_DECAY_TAU_S = 0.085;
const GATED_PEAK_AMPL = 0.2;
const SNAKE_AMPL = 0.2;

// 320×200 fragment shader: sample our CPU framebuffer (RGBA8) verbatim
// (the scanline darken is baked into the CPU buffer; we don't redo it in
// the shader so the on-card preview blit and the FBO output look
// identical).
const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uTex;

void main() {
  // CPU buffer is row-major TOP-DOWN; flip Y so it renders right-side-up.
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  outColor = texture(uTex, uv);
}`;

interface NibblesParams {
  auto: number;     // 0/1 — discrete AUTO toggle
  tick_ms: number;  // 40..200 — game tick period
}

const DEFAULTS: NibblesParams = {
  auto: 0,
  tick_ms: 80,
};

/** Card-facing handle. The card reads game state via `read('snapshot')`
 *  for its 2D preview blit + uses `pushDirection` for keyboard control. */
export interface NibblesHandleExtras {
  /** Card pushes a direction (translated from KeyboardEvent.key). Returns
   *  true if the direction was accepted (i.e. the card has focus AND
   *  auto-mode is OFF). */
  pushDirection(dir: NibblesDirection): boolean;
  /** Card-readable current score (snake length). */
  getScore(): number;
  /** Force-restart the current game. Used by the card's manual reset (also
   *  applied internally when AUTO is on and the snake dies). */
  reset(): void;
  /** Card snapshot — current framebuffer as ImageData (320×200) for the
   *  on-card preview. */
  snapshot(): ImageData | null;
  /** Test-only: force-pulse a CV/gate output (pellet/death/dir_change/length_cv)
   *  WITHOUT running a game tick. Used by the video→audio CV/gate e2e + VRT
   *  coverage so the bridge can be exercised deterministically without depending
   *  on the bot's stochastic snake-eats-pellet path. For length_cv the value is
   *  applied verbatim (interpreted as the CV scalar, e.g. 0.5); for the gate
   *  ports the value is ignored and a standard 10 ms HIGH pulse is emitted.
   *  No-op when the AudioContext isn't attached. */
  forcePulse(port: 'pellet' | 'death' | 'dir_change' | 'length_cv', value?: number): void;
  /** Test-only: hold a gate output HIGH (or LOW) indefinitely — no 10 ms
   *  auto-fall-back. Used by the composite VRT spec so an `audio suspend`
   *  + snapshot freezes the gate signal in a known state for the diff.
   *  Calling forcePulse() or forceHold(port, false) cancels the hold.
   *  No-op when the AudioContext isn't attached. */
  forceHold(port: 'pellet' | 'death' | 'dir_change', high: boolean): void;
}

export const nibblesDef: VideoModuleDef = {
  type: 'nibbles',
  palette: { top: 'Games', sub: 'Arcade' },
  domain: 'video',
  label: 'nibbles',
  category: 'sources',
  schemaVersion: 1,
  inputs: [],
  outputs: [
    { id: 'out',        type: 'video' },
    { id: 'pellet',     type: 'gate'  },
    { id: 'death',      type: 'gate'  },
    { id: 'dir_change', type: 'gate'  },
    { id: 'length_cv',  type: 'cv'    },
    { id: 'snake',      type: 'audio' },
    { id: 'gated',      type: 'audio' },
  ],
  params: [
    {
      id: 'auto',
      label: 'Auto',
      defaultValue: DEFAULTS.auto,
      min: 0, max: 1, curve: 'discrete',
    },
    {
      id: 'tick_ms',
      label: 'Tick',
      defaultValue: DEFAULTS.tick_ms,
      min: 40, max: 200, curve: 'linear',
    },
  ],

  factory(ctx: VideoEngineContext, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);
    const uTex = gl.getUniformLocation(program, 'uTex');
    const { fbo, texture } = ctx.createFbo();

    // Source texture: 320×200 RGBA8. We CPU-rasterise into this each game
    // tick + upload via texSubImage2D (cheap; 256 kB per frame).
    const sourceTex = gl.createTexture();
    if (!sourceTex) throw new Error('NIBBLES: createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, sourceTex);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA,
      INTERNAL_W, INTERNAL_H, 0,
      gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array(INTERNAL_W * INTERNAL_H * 4),
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // Pixel buffer — reused for GL upload AND the card-snapshot ImageData
    // so we don't allocate 256 kB on every game tick / card poll.
    const fbBytes = new Uint8ClampedArray(INTERNAL_W * INTERNAL_H * 4);
    // Prefill alpha — never changes.
    for (let i = 3; i < fbBytes.length; i += 4) fbBytes[i] = 255;
    // ImageData is only constructed when the host environment provides it
    // (browser + jsdom). Node-only test environments don't expose it, so we
    // skip the wrapping — the factory still works for GL + audio-side tests.
    const fbImage: ImageData | null =
      typeof ImageData !== 'undefined'
        ? new ImageData(fbBytes, INTERNAL_W, INTERNAL_H)
        : null;

    const params: NibblesParams & Record<string, number> = {
      ...DEFAULTS,
      ...(node.params as Partial<NibblesParams>),
    };

    // ---- Game state -------------------------------------------------------
    //
    // VRT seed mode: when globalThis.__nibblesVrtSeed is set BEFORE the
    // module is spawned, we seed with a fixed value (mirrors FOXY's
    // __foxyVrtSeed pattern) so the on-card framebuffer is pixel-identical
    // across runs. Otherwise Date.now() seeds.
    function initialSeed(): number {
      const vrtSeed = (globalThis as unknown as { __nibblesVrtSeed?: number | boolean })
        .__nibblesVrtSeed;
      if (typeof vrtSeed === 'number') return vrtSeed >>> 0;
      if (vrtSeed === true) return 0xC0DE;
      return (Date.now() & 0xFFFFFFFF) >>> 0;
    }
    let state: NibblesState = newGame(initialSeed());
    let tickAccumS = 0;
    let lastDrawTimeS = -1;
    /** Tracks the resolved direction from chooseDirection() so we only
     *  push a queue update when AUTO actually picks a new direction. */
    let lastAutoDir: NibblesDirection | null = null;
    /** VRT determinism: once the harness flag flips on, we one-shot-reset
     *  the game with a fixed seed so the on-card framebuffer is identical
     *  across runs. Re-checked each frame so it works whether the flag is
     *  set before OR after spawn. */
    let vrtSeedApplied = false;
    /** Last-seen value of `__nibblesForceLength`. We update the length CV
     *  whenever it CHANGES (including unset → set and set → unset) so the
     *  forced value lands without requiring a game event to fire. NaN means
     *  "no override has ever been observed" (sentinel for the first check). */
    let lastForcedLength = Number.NaN;
    /** Push the length CV update when the harness's `__nibblesForceLength`
     *  changes (incl. transitions to/from unset). Cheap: one global read +
     *  a value compare per draw frame. */
    function maybeApplyForcedLength(): void {
      const raw = (globalThis as unknown as { __nibblesForceLength?: number | undefined })
        .__nibblesForceLength;
      const current = typeof raw === 'number' && Number.isFinite(raw) ? raw : Number.NaN;
      // Number.NaN !== Number.NaN, so the first frame always triggers. After
      // that, the !==-compare correctly fires on any change OR transition
      // to/from unset.
      if (Number.isNaN(current) && Number.isNaN(lastForcedLength)) return;
      if (current === lastForcedLength) return;
      lastForcedLength = current;
      updateLengthCvAndFreq();
    }

    function maybeApplyVrtSeed(): void {
      if (vrtSeedApplied) return;
      const vrtSeed = (globalThis as unknown as { __nibblesVrtSeed?: number | boolean })
        .__nibblesVrtSeed;
      if (vrtSeed === undefined || vrtSeed === false || vrtSeed === null) return;
      const seed = typeof vrtSeed === 'number' ? vrtSeed >>> 0 : 0xC0DE;
      state = newGame(seed);
      lastAutoDir = null;
      vrtSeedApplied = true;
    }

    // ---- Audio outputs ----------------------------------------------------
    //
    // Persistent AudioNode identity from t=0 (same pattern as DOOM) so the
    // video→audio bridge captures stable refs at addEdge time even if a
    // cable is wired before the AudioContext fully spins up.
    const audioSources = new Map<string, { node: AudioNode; output: number }>();
    let pelletGate: ConstantSourceNode | null = null;
    let deathGate: ConstantSourceNode | null = null;
    let dirGate: ConstantSourceNode | null = null;
    let lengthCv: ConstantSourceNode | null = null;
    let snakeOsc: OscillatorNode | null = null;
    let snakeGain: GainNode | null = null;
    let gatedOsc: OscillatorNode | null = null;
    let gatedGain: GainNode | null = null;

    if (ctx.audioCtx) {
      const ac = ctx.audioCtx;
      const t0 = ac.currentTime;

      pelletGate = ac.createConstantSource();
      pelletGate.offset.setValueAtTime(0, t0);
      pelletGate.start();
      deathGate = ac.createConstantSource();
      deathGate.offset.setValueAtTime(0, t0);
      deathGate.start();
      dirGate = ac.createConstantSource();
      dirGate.offset.setValueAtTime(0, t0);
      dirGate.start();
      lengthCv = ac.createConstantSource();
      // Use the effective length here too so a pre-spawn `__nibblesForceLength`
      // hook is honoured at boot (no game tick needed to land the override).
      lengthCv.offset.setValueAtTime(lengthToCv(effectiveCvLength()), t0);
      lengthCv.start();

      // Continuous SNAKE square wave at length-derived freq.
      snakeOsc = ac.createOscillator();
      snakeOsc.type = 'square';
      snakeOsc.frequency.setValueAtTime(lengthToFreq(state.score), t0);
      snakeGain = ac.createGain();
      snakeGain.gain.setValueAtTime(SNAKE_AMPL, t0);
      snakeOsc.connect(snakeGain);
      snakeOsc.start();

      // GATED square wave — same freq, but routed through an envelope.
      gatedOsc = ac.createOscillator();
      gatedOsc.type = 'square';
      gatedOsc.frequency.setValueAtTime(lengthToFreq(state.score), t0);
      gatedGain = ac.createGain();
      gatedGain.gain.setValueAtTime(0, t0);
      gatedOsc.connect(gatedGain);
      gatedOsc.start();

      audioSources.set('pellet',     { node: pelletGate, output: 0 });
      audioSources.set('death',      { node: deathGate,  output: 0 });
      audioSources.set('dir_change', { node: dirGate,    output: 0 });
      audioSources.set('length_cv',  { node: lengthCv,   output: 0 });
      audioSources.set('snake',      { node: snakeGain,  output: 0 });
      audioSources.set('gated',      { node: gatedGain,  output: 0 });
    }

    function pulseGate(src: ConstantSourceNode): void {
      const ac = ctx.audioCtx;
      if (!ac) return;
      const t = ac.currentTime;
      src.offset.setValueAtTime(1, t);
      src.offset.setValueAtTime(0, t + GATE_PULSE_S);
    }

    /** Trigger the GATED envelope: 15 ms linear attack to peak, 100 ms
     *  plateau, then exponential decay back to ~0 within the 500 ms total
     *  window. setTargetAtTime gives the natural exp tail. */
    function pulseGatedEnvelope(): void {
      const ac = ctx.audioCtx;
      if (!ac || !gatedGain) return;
      const t = ac.currentTime;
      const g = gatedGain.gain;
      // Cancel any in-flight envelope so a fresh pellet always restarts cleanly.
      try { g.cancelScheduledValues(t); } catch { /* */ }
      g.setValueAtTime(0, t);
      g.linearRampToValueAtTime(GATED_PEAK_AMPL, t + GATED_ATTACK_S);
      g.setValueAtTime(GATED_PEAK_AMPL, t + GATED_ATTACK_S + GATED_PLATEAU_S);
      g.setTargetAtTime(0, t + GATED_ATTACK_S + GATED_PLATEAU_S, GATED_DECAY_TAU_S);
      // Hard zero at the end of the window so a slow-decaying tail doesn't
      // bleed into the next event.
      g.setValueAtTime(0, t + GATED_DECAY_TOTAL_S);
    }

    /** Map length (1..NIBBLES_MAX_LENGTH+) to a bipolar CV in [-1, +1].
     *  length = 4 (start) → just under 0 (slightly negative); length =
     *  NIBBLES_MAX_LENGTH → +1; beyond NIBBLES_MAX_LENGTH clamps to +1. */
    function lengthToCv(length: number): number {
      const mid = NIBBLES_MAX_LENGTH / 2;
      const raw = (length - mid) / mid;
      return Math.max(-1, Math.min(1, raw));
    }

    /** Resolve the length the CV path should emit. When
     *  `globalThis.__nibblesForceLength` is a number, the CV is computed
     *  from that value (clamped to [1, NIBBLES_MAX_LENGTH]) — used by VRT
     *  + e2e harnesses to deterministically pin the length_cv output to
     *  known sweep points without depending on the live game state.
     *  Otherwise the actual snake length (state.score) drives the CV. */
    function effectiveCvLength(): number {
      const forced = (globalThis as unknown as { __nibblesForceLength?: number | undefined })
        .__nibblesForceLength;
      if (typeof forced === 'number' && Number.isFinite(forced)) {
        return Math.max(1, Math.min(NIBBLES_MAX_LENGTH, forced));
      }
      return state.score;
    }

    /** Map length to a frequency: length=4 → 110 Hz (A2), every +12 length
     *  ticks = +1 octave. Per spec. */
    function lengthToFreq(length: number): number {
      return 110 * Math.pow(2, (length - 4) / 12);
    }

    function updateLengthCvAndFreq(): void {
      const ac = ctx.audioCtx;
      if (!ac) return;
      const t = ac.currentTime;
      // CV path honours the `__nibblesForceLength` test hook so harnesses
      // can pin known sweep points; the audible square-wave freq stays
      // tied to the actual game state (we don't fake the audio output).
      const cv = lengthToCv(effectiveCvLength());
      const f = lengthToFreq(state.score);
      // Linear-ramp to smooth the step so a fast-grow chain (mid-game pellet
      // chain) doesn't audibly zip the oscillator pitch + length CV.
      const RAMP = 0.02;
      if (lengthCv) {
        try { lengthCv.offset.cancelScheduledValues(t); } catch { /* */ }
        lengthCv.offset.setValueAtTime(lengthCv.offset.value, t);
        lengthCv.offset.linearRampToValueAtTime(cv, t + RAMP);
      }
      if (snakeOsc) {
        try { snakeOsc.frequency.cancelScheduledValues(t); } catch { /* */ }
        snakeOsc.frequency.setValueAtTime(snakeOsc.frequency.value, t);
        snakeOsc.frequency.linearRampToValueAtTime(f, t + RAMP);
      }
      if (gatedOsc) {
        try { gatedOsc.frequency.cancelScheduledValues(t); } catch { /* */ }
        gatedOsc.frequency.setValueAtTime(gatedOsc.frequency.value, t);
        gatedOsc.frequency.linearRampToValueAtTime(f, t + RAMP);
      }
    }

    /** Apply the queued AUTO direction (if any) — called from the game-
     *  tick loop just before `gameTick` so the bot decision lands. */
    function applyAutoDirection(): void {
      if (params.auto < 0.5) return;
      const next = chooseDirection(state);
      if (next !== lastAutoDir) {
        // chooseDirection may return the current direction; setDirection
        // already de-dups (no event emitted) so this is safe.
        setDirection(state, next);
        lastAutoDir = next;
      }
    }

    /** One game tick. Drains events + drives all the audio-side outputs. */
    function advanceGame(): void {
      applyAutoDirection();
      gameTick(state);
      const events = drainEvents(state);
      for (const e of events) {
        if (e.type === 'pellet') {
          if (pelletGate) pulseGate(pelletGate);
          pulseGatedEnvelope();
        } else if (e.type === 'death') {
          if (deathGate) pulseGate(deathGate);
        } else if (e.type === 'directionChange') {
          if (dirGate) pulseGate(dirGate);
        }
      }
      if (events.length > 0) updateLengthCvAndFreq();

      // Auto-restart on death when AUTO is on.
      if (!state.alive && params.auto >= 0.5) {
        state = newGame((Date.now() ^ state.rngState) >>> 0);
        lastAutoDir = null;
        updateLengthCvAndFreq();
      }
    }

    // ---- CPU rasteriser ---------------------------------------------------
    //
    // Palette: classic VGA-ish — dark slate background, food in bright red,
    // snake head in bright lime, snake body in a green chain. We skip the
    // full 256-color VGA table (we only need ~5 colors here); the term
    // "256-color VGA" in the spec refers to the original Nibbles BIOS mode,
    // which is honored visually but not byte-exactly.
    const COLOR_BG          = [0x10, 0x14, 0x20]; // very dark blue-grey
    const COLOR_BORDER      = [0x40, 0x40, 0x60];
    const COLOR_FOOD        = [0xFF, 0x40, 0x40];
    const COLOR_SNAKE_HEAD  = [0xC0, 0xFF, 0x80];
    const COLOR_SNAKE_BODY  = [0x40, 0xC0, 0x60];
    const COLOR_SNAKE_TAIL  = [0x20, 0x80, 0x40];

    function setPixel(buf: Uint8ClampedArray, x: number, y: number, rgb: number[]): void {
      const p = (y * INTERNAL_W + x) * 4;
      buf[p]     = rgb[0]!;
      buf[p + 1] = rgb[1]!;
      buf[p + 2] = rgb[2]!;
      // alpha pre-filled at construction; never overwritten
    }

    function fillCell(buf: Uint8ClampedArray, cx: number, cy: number, rgb: number[]): void {
      const x0 = cx * CELL;
      const y0 = cy * CELL;
      for (let dy = 0; dy < CELL; dy++) {
        const y = y0 + dy;
        if (y < 0 || y >= INTERNAL_H) continue;
        for (let dx = 0; dx < CELL; dx++) {
          const x = x0 + dx;
          if (x < 0 || x >= INTERNAL_W) continue;
          setPixel(buf, x, y, rgb);
        }
      }
    }

    function paintFrame(): void {
      // 1. Background fill.
      for (let y = 0; y < INTERNAL_H; y++) {
        for (let x = 0; x < INTERNAL_W; x++) {
          setPixel(fbBytes, x, y, COLOR_BG);
        }
      }
      // 2. Thin border ring (one pixel inside the framebuffer).
      for (let x = 0; x < INTERNAL_W; x++) {
        setPixel(fbBytes, x, 0, COLOR_BORDER);
        setPixel(fbBytes, x, INTERNAL_H - 1, COLOR_BORDER);
      }
      for (let y = 0; y < INTERNAL_H; y++) {
        setPixel(fbBytes, 0, y, COLOR_BORDER);
        setPixel(fbBytes, INTERNAL_W - 1, y, COLOR_BORDER);
      }
      // 3. Food cell.
      fillCell(fbBytes, state.food.x, state.food.y, COLOR_FOOD);
      // 4. Snake body (back-to-front so head paints on top).
      const last = state.snake.length - 1;
      for (let i = last; i >= 0; i--) {
        const cell = state.snake[i]!;
        const rgb = i === 0
          ? COLOR_SNAKE_HEAD
          : i === last && last > 0
            ? COLOR_SNAKE_TAIL
            : COLOR_SNAKE_BODY;
        fillCell(fbBytes, cell.x, cell.y, rgb);
      }
      // 5. Scanline darken: every other row -15%.
      for (let y = 1; y < INTERNAL_H; y += 2) {
        const row = y * INTERNAL_W * 4;
        for (let p = row; p < row + INTERNAL_W * 4; p += 4) {
          fbBytes[p]     = Math.max(0, Math.floor(fbBytes[p]!     * 0.85));
          fbBytes[p + 1] = Math.max(0, Math.floor(fbBytes[p + 1]! * 0.85));
          fbBytes[p + 2] = Math.max(0, Math.floor(fbBytes[p + 2]! * 0.85));
        }
      }
    }

    function uploadFramebuffer(): void {
      gl.bindTexture(gl.TEXTURE_2D, sourceTex);
      gl.texSubImage2D(
        gl.TEXTURE_2D, 0,
        0, 0,
        INTERNAL_W, INTERNAL_H,
        gl.RGBA, gl.UNSIGNED_BYTE,
        new Uint8Array(fbBytes.buffer, fbBytes.byteOffset, fbBytes.byteLength),
      );
    }

    // Paint a first frame so the FBO has SOMETHING the moment any consumer
    // peeks at it (and so the on-card preview isn't a single black frame
    // before the first tick lands).
    paintFrame();
    uploadFramebuffer();

    const surface: VideoNodeSurface = {
      fbo,
      texture,
      draw(frame) {
        // VRT determinism: pick up the harness seed on the first draw frame
        // it's set. Cheap (single property read + boolean check after the
        // first apply).
        maybeApplyVrtSeed();
        // VRT/e2e determinism: react to `__nibblesForceLength` changes so the
        // length CV pins to known values regardless of the live game state.
        // Cheap: one property read + a !==-compare.
        maybeApplyForcedLength();
        const tNow = frame.time;
        const dt = lastDrawTimeS < 0 ? 0 : Math.max(0, tNow - lastDrawTimeS);
        lastDrawTimeS = tNow;

        // Game tick at the requested cadence.
        const tickPeriodS = Math.max(0.04, Math.min(0.2, params.tick_ms / 1000));
        tickAccumS += dt;
        let ticksThisFrame = 0;
        while (tickAccumS >= tickPeriodS && ticksThisFrame < 4) {
          tickAccumS -= tickPeriodS;
          advanceGame();
          ticksThisFrame += 1;
        }
        if (ticksThisFrame > 0) {
          paintFrame();
          uploadFramebuffer();
        }

        const g = frame.gl;
        g.bindFramebuffer(g.FRAMEBUFFER, fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.useProgram(program);
        g.activeTexture(g.TEXTURE0);
        g.bindTexture(g.TEXTURE_2D, sourceTex);
        g.uniform1i(uTex, 0);
        ctx.drawFullscreenQuad();
        g.bindFramebuffer(g.FRAMEBUFFER, null);
      },
      dispose() {
        gl.deleteFramebuffer(fbo);
        gl.deleteTexture(texture);
        gl.deleteTexture(sourceTex);
        gl.deleteProgram(program);
        try { snakeOsc?.stop(); } catch { /* */ }
        try { gatedOsc?.stop(); } catch { /* */ }
        for (const src of [pelletGate, deathGate, dirGate, lengthCv]) {
          if (!src) continue;
          try { src.stop(); } catch { /* */ }
          try { src.disconnect(); } catch { /* */ }
        }
        try { snakeGain?.disconnect(); } catch { /* */ }
        try { gatedGain?.disconnect(); } catch { /* */ }
      },
    };

    function pushDirection(dir: NibblesDirection): boolean {
      if (params.auto >= 0.5) return false;
      setDirection(state, dir);
      return true;
    }

    function reset(): void {
      state = newGame((Date.now() & 0xFFFFFFFF) >>> 0);
      lastAutoDir = null;
      updateLengthCvAndFreq();
      paintFrame();
      uploadFramebuffer();
    }

    function snapshot(): ImageData | null {
      return fbImage;
    }

    function forcePulse(
      port: 'pellet' | 'death' | 'dir_change' | 'length_cv',
      value?: number,
    ): void {
      const ac = ctx.audioCtx;
      if (!ac) return;
      if (port === 'length_cv') {
        if (!lengthCv) return;
        const t = ac.currentTime;
        const cv = typeof value === 'number'
          ? Math.max(-1, Math.min(1, value))
          : 1;
        try { lengthCv.offset.cancelScheduledValues(t); } catch { /* */ }
        lengthCv.offset.setValueAtTime(lengthCv.offset.value, t);
        // Ramp over 20ms (same RAMP as updateLengthCvAndFreq) so the AudioParam
        // value crosses the threshold an analyser/getValueAtTime would see.
        lengthCv.offset.linearRampToValueAtTime(cv, t + 0.02);
        return;
      }
      const src =
        port === 'pellet' ? pelletGate
        : port === 'death' ? deathGate
        : dirGate;
      if (src) pulseGate(src);
    }

    function forceHold(port: 'pellet' | 'death' | 'dir_change', high: boolean): void {
      const ac = ctx.audioCtx;
      if (!ac) return;
      const src =
        port === 'pellet' ? pelletGate
        : port === 'death' ? deathGate
        : dirGate;
      if (!src) return;
      const t = ac.currentTime;
      try { src.offset.cancelScheduledValues(t); } catch { /* */ }
      src.offset.setValueAtTime(high ? 1 : 0, t);
    }

    const extras: NibblesHandleExtras = {
      pushDirection,
      getScore: () => state.score,
      reset,
      snapshot,
      forcePulse,
      forceHold,
    };

    return {
      domain: 'video',
      surface,
      audioSources,
      setParam(paramId, value) {
        if (paramId in params) (params as Record<string, number>)[paramId] = value;
        if (paramId === 'auto') {
          // Resetting lastAutoDir on the AUTO transition means the bot
          // re-decides the very next tick even if its choice equals the
          // current heading (so a freshly-enabled AUTO doesn't stall).
          lastAutoDir = null;
        }
      },
      readParam(paramId) {
        return (params as Record<string, number>)[paramId];
      },
      read(key) {
        if (key === 'extras') return extras;
        if (key === 'snapshot') return fbImage;
        if (key === 'score') return state.score;
        if (key === 'alive') return state.alive;
        if (key === 'auto') return params.auto >= 0.5;
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};
