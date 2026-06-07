// packages/web/src/lib/video/modules/gibribbon.ts
//
// GibRibbon — a Vib-Ribbon spiritual successor rendered with DOOM
// shareware-WAD sprites, as a patchable VIDEO module.
//
// Aesthetic: a single white vector "ribbon" / ground line on black, drawn as
// line art (Vib-Ribbon's exact visual grammar — the ground dips into a pit V,
// rises into a jump hump, and twists into a loop figure-8), with the CHARACTER
// being a REAL DOOM marine sprite (PLAY*) pulled from DOOM1.WAD; imps (TROO*)
// and zombie/former-humans (POSS*) are the enemy sprites. An overhead ABXY
// prompt strip shows the button each upcoming event needs (like Vib-Ribbon
// shows the PlayStation buttons). The contrast between the cold white vector
// ribbon and the gory FPS sprites is the point.
//
// Module SHAPE mirrors NIBBLES / QBERT: a VIDEO module that CPU-rasterises a
// game frame into a source texture (uploaded each frame, drawn through a
// fullscreen-quad shader, letterboxed into the engine's 640×480 FBO) and ALSO
// publishes AudioNode gate outputs via `audioSources` for the cross-domain
// video→audio bridge.
//
// The GAMEPLAY (event generation, hit/miss judgement, health ladder, score) is
// the PURE, deterministic, unit-tested gibribbon-events.ts state machine — this
// file is the thin GL/audio/input shell around it (same split as
// nibbles-game.ts ↔ nibbles.ts). Sprite extraction is the PURE wad-sprites.ts
// decoder run at load time against the DOOM module's same DOOM1.WAD buffer.
//
// Inputs:
//   cv1..cv4  (modsignal) — the 4 modulation channels that DRIVE event
//             generation. Patch slow Synesthesia envelopes here; each channel
//             maps to one event kind (cv1→loop, cv2→jump, cv3→imp,
//             cv4→zombie by default — GIB_TUNING.cvEventMap, parent-tunable).
//   clock     (clock)     — the scroll/tempo tick (a 1× clock). Each rising
//             edge advances the ribbon one beat + runs spawn generation.
//   gate      (gate)      — the beat (e.g. a sequencer's gate out). Biases
//             which CV channel spawns on each beat (strongest-on-beat).
//   x, y      (modsignal) — joystick axes, bipolar ±1, both genuinely consumed
//             by the pure state machine each frame via setAim():
//               x → AIM: re-centres the judgement point by up to ±1 hit-window
//                   (lead the beat left / lag it right) — judgePress measures
//                   distance to (pos − aimX·hitWindow). A timing aid, not a
//                   free wider window (the half-width is unchanged).
//               y → the marine's VERTICAL position on the ribbon (push up to
//                   raise/aim high, down to crouch) — rendered via
//                   marineAimOffset(). No longer a dead port.
//   a, b, x_btn, y_btn (gate) — the ABXY player presses. A rising edge judges
//             the nearest in-window event whose required button matches.
//             (Named x_btn / y_btn to disambiguate from the x / y AXES.)
//
// Outputs:
//   out        (video) — the rasterised 640×360 game frame letterboxed to 4:3.
//   evt_hit    (gate)  — 10 ms pulse on every successful clear.
//   evt_miss   (gate)  — 10 ms pulse on every missed event (marine degrades).
//   evt_fire   (gate)  — 10 ms pulse when the marine FIRES (on an enemy clear).
//   evt_kill   (gate)  — 10 ms pulse when an enemy dies (death animation).
//   evt_gameover (gate)— 10 ms pulse when the marine hits GAME OVER.
//   health_cv  (cv)    — the marine's vitality 0..1 (super=1 … dead=0).

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoEngineContext, VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';
import { detectEdge, makeEdgeState, type EdgeState } from '$lib/doom/cv-gate-edge';
import { loadWad } from '$lib/doom/doom-runtime';
import { extractGibSprites, type GibSprites, type SpriteFrame } from '$lib/doom/wad-sprites';
import {
  newGame,
  clockTick,
  scroll,
  judgePress,
  drainOutEvents,
  healthToCv,
  autoplayCv,
  setAim,
  upcomingLane,
  EVENT_BUTTON,
  GIB_TUNING,
  type GibState,
  type GibButton,
  type GibEvent,
  type GibEventKind,
} from './gibribbon-events';

const INTERNAL_W = 640;
const INTERNAL_H = 360; // 16:9 internal canvas for the side-scroller
const GATE_PULSE_S = 0.01;

// Fragment shader: sample the CPU framebuffer and letterbox into the engine's
// 640×480 (4:3) FBO. Internal canvas is 16:9 → keep full WIDTH, bars top+bottom.
const FRAG_SRC = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform vec2 uLetterbox;
void main() {
  vec2 centered = (vUv - 0.5) / uLetterbox + 0.5;
  if (centered.x < 0.0 || centered.x > 1.0 || centered.y < 0.0 || centered.y > 1.0) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  // CPU buffer is row-major TOP-DOWN; flip Y so it renders right-side-up.
  vec2 uv = vec2(centered.x, 1.0 - centered.y);
  outColor = texture(uTex, uv);
}`;

interface GibParams {
  // Synthetic CV-target params (the input ports' paramTargets). Hidden from
  // the card; setParam writes them, draw()/edge-detectors read them.
  cv1: number; cv2: number; cv3: number; cv4: number;
  clock: number; gate: number;
  axis_x: number; axis_y: number;
  btn_a: number; btn_b: number; btn_x: number; btn_y: number;
  // AUTOPLAY (default ON): run the internal clock so a bare card self-plays.
  // Set 0 to require an external clock (pure deterministic / musical control).
  autoplay: number;
}

const DEFAULTS: GibParams = {
  cv1: 0, cv2: 0, cv3: 0, cv4: 0,
  clock: 0, gate: 0,
  axis_x: 0, axis_y: 0,
  btn_a: 0, btn_b: 0, btn_x: 0, btn_y: 0,
  autoplay: 1,
};

/** Card-facing handle. The card reads the framebuffer + score via these. */
export interface GibribbonHandleExtras {
  /** Current 640×360 ImageData for the on-card 2D preview blit. */
  snapshot(): ImageData | null;
  /** Live game score. */
  getScore(): number;
  /** Live health rung as a string (for the card HUD). */
  getHealth(): string;
  /** Live combo. */
  getCombo(): number;
  /** Were the WAD sprites loaded? '' on success, else the reason (so the card
   *  can show a "no WAD → line-art fallback" badge). */
  loadError(): string;
  /** Push an ABXY press from a keyboard event (card-driven; returns true if the
   *  key mapped). */
  pushButton(button: GibButton): boolean;
  /** The fixed lookahead lane (next-N upcoming buttons, nearest first) so the
   *  card HUD + e2e can read/assert the readable queue. */
  getLane(): { button: GibButton; kind: GibEventKind; pos: number; hot: boolean }[];
  /** Whether the game is over (death overlay shown, restart available). */
  isDead(): boolean;
  /** Force-restart the game. */
  reset(): void;
  /** Test-only: force-pulse a gate output WITHOUT a game event, so the e2e +
   *  VRT can exercise the bridge deterministically. No-op without an
   *  AudioContext or for an unknown port. */
  forcePulse(port: GibGatePort): void;
}

type GibGatePort = 'evt_hit' | 'evt_miss' | 'evt_fire' | 'evt_kill' | 'evt_gameover';

// ── line-art / sprite colour constants (the Vib-Ribbon palette) ─────────────
const COL_BG = [0x00, 0x00, 0x00];           // black
const COL_RIBBON = [0xff, 0xff, 0xff];       // the white vector ground line
const COL_PROMPT = [0xa0, 0xa0, 0xa0];       // dim glyphs for upcoming prompts
const COL_PROMPT_HOT = [0xff, 0xff, 0xff];   // the imminent prompt (in-window)
const COL_LANE = [0x30, 0x30, 0x30];         // the fixed lookahead-lane frame
const COL_LANE_TICK = [0x60, 0x60, 0x60];    // the lane's "now" marker
const BTN_COLORS: Record<GibButton, number[]> = {
  a: [0x6c, 0xc0, 0x4a], // green (Vib-Ribbon-ish ABXY tints)
  b: [0xe0, 0x50, 0x50], // red
  x: [0x50, 0x90, 0xe0], // blue
  y: [0xe0, 0xc0, 0x40], // yellow
};

export const gibribbonDef: VideoModuleDef = {
  type: 'gibribbon',
  // In-house game (DOOM sprites are an asset, not an emulated engine) → Arcade,
  // alongside NIBBLES / PONG / FROGGER / MODTRIS.
  palette: { top: 'Games', sub: 'Arcade' },
  domain: 'video',
  label: 'gibribbon',
  category: 'sources',
  schemaVersion: 1,
  inputs: [
    // Event-generation modulation (cv OR audio OR gate via modsignal).
    { id: 'cv1', type: 'modsignal' as const, paramTarget: 'cv1', cvScale: { mode: 'linear' as const } },
    { id: 'cv2', type: 'modsignal' as const, paramTarget: 'cv2', cvScale: { mode: 'linear' as const } },
    { id: 'cv3', type: 'modsignal' as const, paramTarget: 'cv3', cvScale: { mode: 'linear' as const } },
    { id: 'cv4', type: 'modsignal' as const, paramTarget: 'cv4', cvScale: { mode: 'linear' as const } },
    // Transport. `clock` is a gate-typed 1× clock train (repo convention —
    // every clock input in the codebase is declared `type:'gate'`; a clock IS
    // a gate train, and the gate-family driver in the per-port sweep wires it).
    { id: 'clock', type: 'gate' as const, paramTarget: 'clock' },
    { id: 'gate', type: 'gate' as const, paramTarget: 'gate' },
    // Joystick axes (player aim / marine vertical position).
    { id: 'x', type: 'modsignal' as const, paramTarget: 'axis_x', cvScale: { mode: 'linear' as const } },
    { id: 'y', type: 'modsignal' as const, paramTarget: 'axis_y', cvScale: { mode: 'linear' as const } },
    // The four ABXY player buttons (distinct ids from the x/y axes).
    { id: 'a',     type: 'gate' as const, paramTarget: 'btn_a' },
    { id: 'b',     type: 'gate' as const, paramTarget: 'btn_b' },
    { id: 'x_btn', type: 'gate' as const, paramTarget: 'btn_x' },
    { id: 'y_btn', type: 'gate' as const, paramTarget: 'btn_y' },
  ],
  outputs: [
    { id: 'out',          type: 'video' },
    { id: 'evt_hit',      type: 'gate' },
    { id: 'evt_miss',     type: 'gate' },
    { id: 'evt_fire',     type: 'gate' },
    { id: 'evt_kill',     type: 'gate' },
    { id: 'evt_gameover', type: 'gate' },
    { id: 'health_cv',    type: 'cv' },
  ],
  params: [
    // All synthetic CV-target params (hidden from the card; the ports render as
    // jacks via the standard port row). curve='linear' so setParam values
    // arrive raw.
    { id: 'cv1', label: 'CV1', defaultValue: 0, min: 0, max: 1, curve: 'linear' as const },
    { id: 'cv2', label: 'CV2', defaultValue: 0, min: 0, max: 1, curve: 'linear' as const },
    { id: 'cv3', label: 'CV3', defaultValue: 0, min: 0, max: 1, curve: 'linear' as const },
    { id: 'cv4', label: 'CV4', defaultValue: 0, min: 0, max: 1, curve: 'linear' as const },
    { id: 'clock', label: 'CLOCK', defaultValue: 0, min: 0, max: 1, curve: 'linear' as const },
    { id: 'gate', label: 'GATE', defaultValue: 0, min: 0, max: 1, curve: 'linear' as const },
    // AUTOPLAY (default ON): the card self-plays on an internal clock when no
    // external clock is patched. Turn OFF for pure external/deterministic clock.
    { id: 'autoplay', label: 'AUTOPLAY', defaultValue: 1, min: 0, max: 1, curve: 'linear' as const },
    { id: 'axis_x', label: 'X', defaultValue: 0, min: -1, max: 1, curve: 'linear' as const },
    { id: 'axis_y', label: 'Y', defaultValue: 0, min: -1, max: 1, curve: 'linear' as const },
    { id: 'btn_a', label: 'A', defaultValue: 0, min: 0, max: 1, curve: 'linear' as const },
    { id: 'btn_b', label: 'B', defaultValue: 0, min: 0, max: 1, curve: 'linear' as const },
    { id: 'btn_x', label: 'X (btn)', defaultValue: 0, min: 0, max: 1, curve: 'linear' as const },
    { id: 'btn_y', label: 'Y (btn)', defaultValue: 0, min: 0, max: 1, curve: 'linear' as const },
  ],

  factory(ctx: VideoEngineContext, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);
    const uTex = gl.getUniformLocation(program, 'uTex');
    const uLetterbox = gl.getUniformLocation(program, 'uLetterbox');
    const { fbo, texture } = ctx.createFbo();

    // Letterbox: internal 16:9 into the engine's 4:3 FBO → full width, bars.
    const fboAspect = ctx.res.width / ctx.res.height;
    const srcAspect = INTERNAL_W / INTERNAL_H;
    const letterboxU = Math.min(1.0, srcAspect / fboAspect);
    const letterboxV = Math.min(1.0, fboAspect / srcAspect);

    const sourceTex = gl.createTexture();
    if (!sourceTex) throw new Error('GIBRIBBON: createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, sourceTex);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA, INTERNAL_W, INTERNAL_H, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(INTERNAL_W * INTERNAL_H * 4),
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // Pixel buffer reused for GL upload + the card ImageData snapshot.
    const fbBytes = new Uint8ClampedArray(INTERNAL_W * INTERNAL_H * 4);
    for (let i = 3; i < fbBytes.length; i += 4) fbBytes[i] = 255; // opaque
    const fbImage: ImageData | null =
      typeof ImageData !== 'undefined' ? new ImageData(fbBytes, INTERNAL_W, INTERNAL_H) : null;

    const params: GibParams & Record<string, number> = {
      ...DEFAULTS,
      ...(node.params as Partial<GibParams>),
    };

    // ── Game state ─────────────────────────────────────────────────────────
    function seed(): number {
      const v = (globalThis as unknown as { __gibribbonSeed?: number }).__gibribbonSeed;
      if (typeof v === 'number') return v >>> 0;
      return (Date.now() & 0xffffffff) >>> 0;
    }
    let state: GibState = newGame(seed());
    let lastDrawTimeS = -1;
    /** Animation clock (frames) for sprite-cycle stepping. */
    let animTick = 0;
    /** Hit-flash level (0..1), bumped on every HIT, decays per frame, drives the
     *  full-screen reward flash so a correct press is unmistakable. */
    let flashLevel = 0;

    // ── Sprites (loaded async from DOOM1.WAD; line-art fallback until/if not) ─
    let sprites: GibSprites | null = null;
    let loadErr = '';
    void (async () => {
      try {
        const { bytes, error } = await loadWad();
        if (!bytes) { loadErr = error ?? 'DOOM1.WAD missing — using line-art fallback'; return; }
        sprites = extractGibSprites(bytes);
      } catch (e) {
        loadErr = e instanceof Error ? e.message : String(e);
      }
    })();

    // ── Audio gate outputs ───────────────────────────────────────────────────
    const audioSources = new Map<string, { node: AudioNode; output: number }>();
    let hitGate: ConstantSourceNode | null = null;
    let missGate: ConstantSourceNode | null = null;
    let fireGate: ConstantSourceNode | null = null;
    let killGate: ConstantSourceNode | null = null;
    let gameoverGate: ConstantSourceNode | null = null;
    let healthCv: ConstantSourceNode | null = null;

    if (ctx.audioCtx) {
      const ac = ctx.audioCtx;
      const t0 = ac.currentTime;
      const mkGate = () => { const c = ac.createConstantSource(); c.offset.setValueAtTime(0, t0); c.start(); return c; };
      hitGate = mkGate();
      missGate = mkGate();
      fireGate = mkGate();
      killGate = mkGate();
      gameoverGate = mkGate();
      healthCv = ac.createConstantSource();
      healthCv.offset.setValueAtTime(healthToCv(state.health), t0);
      healthCv.start();
      audioSources.set('evt_hit', { node: hitGate, output: 0 });
      audioSources.set('evt_miss', { node: missGate, output: 0 });
      audioSources.set('evt_fire', { node: fireGate, output: 0 });
      audioSources.set('evt_kill', { node: killGate, output: 0 });
      audioSources.set('evt_gameover', { node: gameoverGate, output: 0 });
      audioSources.set('health_cv', { node: healthCv, output: 0 });
    }

    const pulseSubscribers = new Map<string, Set<() => void>>();
    function notifyPulse(port: string): void {
      const subs = pulseSubscribers.get(port);
      if (!subs) return;
      for (const cb of subs) { try { cb(); } catch { /* */ } }
    }
    function pulseGate(src: ConstantSourceNode | null, port: string): void {
      const ac = ctx.audioCtx;
      if (!ac || !src) return;
      const t = ac.currentTime;
      src.offset.setValueAtTime(1, t);
      src.offset.setValueAtTime(0, t + GATE_PULSE_S);
      notifyPulse(port);
    }
    function gateFor(port: GibGatePort): ConstantSourceNode | null {
      switch (port) {
        case 'evt_hit': return hitGate;
        case 'evt_miss': return missGate;
        case 'evt_fire': return fireGate;
        case 'evt_kill': return killGate;
        case 'evt_gameover': return gameoverGate;
      }
    }
    function updateHealthCv(): void {
      const ac = ctx.audioCtx;
      if (!ac || !healthCv) return;
      const t = ac.currentTime;
      try { healthCv.offset.cancelScheduledValues(t); } catch { /* */ }
      healthCv.offset.setValueAtTime(healthCv.offset.value, t);
      healthCv.offset.linearRampToValueAtTime(healthToCv(state.health), t + 0.02);
    }

    /** Drain the game's queued side-effects → pulse the matching gates. */
    function drainGameEvents(): void {
      const out = drainOutEvents(state);
      let healthChanged = false;
      for (const e of out) {
        if (e.type === 'hit') { pulseGate(hitGate, 'evt_hit'); flashLevel = 1; }
        else if (e.type === 'miss') pulseGate(missGate, 'evt_miss');
        else if (e.type === 'fire') pulseGate(fireGate, 'evt_fire');
        else if (e.type === 'kill') pulseGate(killGate, 'evt_kill');
        else if (e.type === 'gameover') { pulseGate(gameoverGate, 'evt_gameover'); healthChanged = true; }
        else if (e.type === 'degrade' || e.type === 'heal' || e.type === 'super') healthChanged = true;
      }
      if (healthChanged) updateHealthCv();
    }

    // ── Input edge detectors (one per discrete input) ──────────────────────
    const clockEdge: EdgeState = makeEdgeState();
    const buttonEdges: Record<GibButton, EdgeState> = {
      a: makeEdgeState(), b: makeEdgeState(), x: makeEdgeState(), y: makeEdgeState(),
    };
    // `gate` is sampled (not edge-judged) — its level just biases spawns.

    // ── Internal clock (AUTOPLAY) ──────────────────────────────────────────
    // A GibRibbon card with no external clock patched used to sit inert (marine
    // running in place, ZERO events) because clockTick only fired on an external
    // `clock` rising edge. A game must self-play on drop, so when no external
    // clock has ticked recently we run an INTERNAL clock at a default tempo and
    // synthesize the spawn CV (autoplayCv). An external clock train takes over
    // instantly (the optional "musical mode") and suppresses the internal one.
    let extClockEdges = 0; // bumped on every external clock rising edge
    let extClockEdgesSeen = 0; // last value observed in draw()
    let extClockIdleS = Infinity; // seconds since the last external clock edge
    let internalBeatAccS = 0; // autoplay beat-phase accumulator
    let autoBeat = 0; // autoplay beat counter (drives autoplayCv)
    const EXTERNAL_CLOCK_TIMEOUT_S = 1.5; // no ext clock this long → autoplay
    const INTERNAL_BEAT_S = 0.42; // autoplay tempo (~one obstacle beat)

    function judgeButton(button: GibButton): void {
      const hit = judgePress(state, button);
      if (hit) drainGameEvents();
    }

    // ── CPU rasteriser (the Vib-Ribbon line art + DOOM sprites) ────────────

    function setPx(x: number, y: number, rgb: number[], a = 255): void {
      if (x < 0 || x >= INTERNAL_W || y < 0 || y >= INTERNAL_H) return;
      const p = (y * INTERNAL_W + x) * 4;
      fbBytes[p] = rgb[0]!;
      fbBytes[p + 1] = rgb[1]!;
      fbBytes[p + 2] = rgb[2]!;
      fbBytes[p + 3] = a;
    }

    /** Bresenham line in the white ribbon colour (with a 2px thickness for a
     *  bolder vector look). */
    function drawLine(x0: number, y0: number, x1: number, y1: number, rgb: number[]): void {
      x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
      const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
      const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
      let err = dx - dy;
      // Hard cap on iterations so a degenerate (NaN/huge) segment can't hang.
      let guard = 0;
      while (guard++ < INTERNAL_W * 2) {
        setPx(x0, y0, rgb);
        setPx(x0, y0 + 1, rgb); // 2px thickness
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 > -dy) { err -= dy; x0 += sx; }
        if (e2 < dx) { err += dx; y0 += sy; }
      }
    }

    /** Blit a decoded sprite frame at (cx,cy) where cx,cy is where the sprite's
     *  HOT SPOT (DOOM's leftoffset/topoffset = feet centre) should land. Scaled
     *  by `scale` (nearest-neighbour). Transparent texels skipped. */
    function blitSprite(f: SpriteFrame, cx: number, cy: number, scale: number): void {
      const x0 = Math.round(cx - f.leftOffset * scale);
      const y0 = Math.round(cy - f.topOffset * scale);
      const w = Math.round(f.width * scale);
      const h = Math.round(f.height * scale);
      for (let dy = 0; dy < h; dy++) {
        const sy = Math.min(f.height - 1, Math.floor(dy / scale));
        for (let dx = 0; dx < w; dx++) {
          const sx = Math.min(f.width - 1, Math.floor(dx / scale));
          const sp = (sy * f.width + sx) * 4;
          if (f.rgba[sp + 3]! < 128) continue; // transparent
          setPx(x0 + dx, y0 + dy, [f.rgba[sp]!, f.rgba[sp + 1]!, f.rgba[sp + 2]!]);
        }
      }
    }

    /** Pick the active animation + frame for an event at the moment of render. */
    function spriteForEvent(ev: GibEvent): SpriteFrame | null {
      if (!sprites) return null;
      const dying = ev.resolved && ev.outcome === 'hit' && (ev.kind === 'imp' || ev.kind === 'zombie');
      if (ev.kind === 'imp') {
        const anim = dying ? sprites.impDie : sprites.impWalk;
        return pickFrame(anim, ev, dying);
      }
      if (ev.kind === 'zombie') {
        const anim = dying ? sprites.zombieDie : sprites.zombieWalk;
        return pickFrame(anim, ev, dying);
      }
      return null; // loop/jump events are drawn as ribbon line-art, not sprites
    }

    function pickFrame(anim: SpriteFrame[], ev: GibEvent, dying: boolean): SpriteFrame | null {
      if (anim.length === 0) return null;
      if (dying && ev.resolvedTick !== null) {
        // March through the death frames over time (1 frame per ~6 anim ticks).
        const elapsed = Math.max(0, Math.floor((animTick - ev.resolvedTick * 6)) / 6);
        return anim[Math.min(anim.length - 1, elapsed)]!;
      }
      // Walk cycle keyed off the global anim tick + the event id for variety.
      return anim[(Math.floor(animTick / 6) + ev.id) % anim.length]!;
    }

    // ── ribbon geometry ─────────────────────────────────────────────────────
    // The marine stands left-of-centre at MARINE_X on the baseline; events ride
    // in from the right edge (pos 1.0) to the judgement point (pos 0.0) which
    // sits at MARINE_X. We map an event's normalized pos → screen x.
    const BASELINE_Y = Math.round(INTERNAL_H * 0.72);
    const MARINE_X = Math.round(INTERNAL_W * 0.30);

    function posToX(pos: number): number {
      // pos 0 → MARINE_X; pos 1 → right edge. Linear.
      return MARINE_X + pos * (INTERNAL_W - MARINE_X - 20);
    }

    function paintFrame(): void {
      // 1. Clear to black. A bright recent HIT flashes the background dim white
      //    for one beat so a correct press is UNMISTAKABLE (the "feels good"
      //    reward feedback). flashLevel decays each frame in draw().
      const bg = flashLevel > 0.02 ? Math.round(flashLevel * 36) : 0;
      for (let i = 0; i < fbBytes.length; i += 4) {
        fbBytes[i] = bg; fbBytes[i + 1] = bg; fbBytes[i + 2] = bg;
      }

      // 2. The white ribbon ground line, deformed by nearby loop/jump events.
      //    Walk x left→right, computing the baseline y plus a per-event bump.
      let prevX = 0, prevY = ribbonY(0);
      for (let x = 0; x <= INTERNAL_W; x += 4) {
        const y = ribbonY(x);
        drawLine(prevX, prevY, x, y, COL_RIBBON);
        prevX = x; prevY = y;
      }

      // 3. Enemy sprites on the ribbon (imps/zombies). Drawn from far→near so
      //    nearer ones overlap.
      const ordered = [...state.events].sort((a, b) => b.pos - a.pos);
      for (const ev of ordered) {
        if (ev.kind !== 'imp' && ev.kind !== 'zombie') continue;
        if (ev.pos < -0.3) continue;
        const f = spriteForEvent(ev);
        const sx = posToX(ev.pos);
        const sy = ribbonY(sx);
        if (f) {
          blitSprite(f, sx, sy, 1.5);
        } else {
          // Line-art enemy placeholder (no WAD): a small wireframe diamond.
          drawDiamond(sx, sy - 14, 9, BTN_COLORS[EVENT_BUTTON[ev.kind]]);
        }
      }

      // 4. The marine (real PLAY sprite when loaded). Frame chosen by state:
      //    firing on a recent enemy clear, pain on a recent miss, else run.
      paintMarine();

      // 5. The FIXED LOOKAHEAD LANE — a stable strip across the top showing the
      //    next few buttons left-to-right in fixed slots (nearest the marine on
      //    the LEFT, like a rhythm-game note highway read-out), so the player
      //    can READ the queue instead of chasing glyphs riding each obstacle.
      paintLookaheadLane();

      // 6. Overlays: count-in "GET READY" at the start, GAME OVER on death.
      if (state.health === 'dead') {
        paintGameOver();
      } else if (state.tick <= GIB_TUNING.countInTicks) {
        paintCountIn();
      }
    }

    // ── the fixed lookahead lane (gap item #2) ──────────────────────────────
    const LANE_Y = 22;            // vertical centre of the lane strip
    const LANE_X0 = 60;           // first (nearest) slot's centre x
    const LANE_DX = 56;           // spacing between slots
    const LANE_SLOTS = 4;         // how many upcoming buttons we show

    function paintLookaheadLane(): void {
      // The lane frame: a faint horizontal guide + a "NOW" tick under slot 0 so
      // the read order is unambiguous (slot 0 = the next thing to press).
      drawLine(LANE_X0 - 26, LANE_Y + 18, LANE_X0 + (LANE_SLOTS - 1) * LANE_DX + 26, LANE_Y + 18, COL_LANE);
      drawLine(LANE_X0 - 14, LANE_Y + 18, LANE_X0 - 14, LANE_Y + 24, COL_LANE_TICK);
      drawLine(LANE_X0 + 14, LANE_Y + 18, LANE_X0 + 14, LANE_Y + 24, COL_LANE_TICK);

      const lane = upcomingLane(state, LANE_SLOTS);
      for (let i = 0; i < lane.length; i++) {
        const slot = lane[i]!;
        const cx = LANE_X0 + i * LANE_DX;
        // The nearest slot (i===0) that is HOT pulses a filled glyph; others are
        // outline. This makes the imminent press visually distinct.
        drawButtonGlyph(slot.button, cx, LANE_Y, slot.hot, /*filled*/ i === 0 && slot.hot);
        // A small approach bar under each slot encodes how soon it arrives
        // (full = right at the marine, empty = just spawned) so timing reads.
        const frac = Math.max(0, Math.min(1, 1 - slot.pos));
        const barW = Math.round(frac * 22);
        drawLine(cx - 11, LANE_Y + 16, cx - 11 + barW, LANE_Y + 16, slot.hot ? COL_PROMPT_HOT : COL_PROMPT);
      }
    }

    function paintCountIn(): void {
      // A simple shrinking countdown ring centred on the ribbon: 3 large
      // diamonds that drop one per count-in tick. Pure line-art so it works
      // with or without the WAD.
      const remaining = Math.max(0, GIB_TUNING.countInTicks - state.tick);
      const cx = Math.round(INTERNAL_W * 0.62);
      const cy = Math.round(INTERNAL_H * 0.34);
      for (let i = 0; i < remaining; i++) {
        drawDiamond(cx, cy, 16 + i * 9, COL_PROMPT);
      }
    }

    function paintGameOver(): void {
      // A bold GAME OVER banner: a framed box with a big X, drawn in the marine
      // damage-red so the death state is unmistakable on the play surface, plus
      // a restart prompt rendered as a row of marker pips ("press R / RESET").
      const cx = Math.round(INTERNAL_W * 0.5);
      const cy = Math.round(INTERNAL_H * 0.40);
      const w = 150, h = 50;
      drawBox(cx - w, cy - h, cx + w, cy + h, BTN_COLORS.b);
      drawBox(cx - w + 4, cy - h + 4, cx + w - 4, cy + h - 4, BTN_COLORS.b);
      // big X inside
      drawLine(cx - 40, cy - 22, cx + 40, cy + 22, BTN_COLORS.b);
      drawLine(cx - 40, cy + 22, cx + 40, cy - 22, BTN_COLORS.b);
      // restart prompt strip below the banner (3 pips → "press R to restart")
      const py = cy + h + 24;
      for (let i = 0; i < 3; i++) drawDiamond(cx - 20 + i * 20, py, 5, COL_PROMPT_HOT);
    }

    function drawBox(x0: number, y0: number, x1: number, y1: number, rgb: number[]): void {
      drawLine(x0, y0, x1, y0, rgb);
      drawLine(x1, y0, x1, y1, rgb);
      drawLine(x1, y1, x0, y1, rgb);
      drawLine(x0, y1, x0, y0, rgb);
    }

    /** The ribbon's y at screen-x — baseline, deformed into a pit V (jump) or a
     *  loop hump where a loop/jump event is. Pure vector line art. */
    function ribbonY(x: number): number {
      let y = BASELINE_Y;
      for (const ev of state.events) {
        if (ev.kind !== 'loop' && ev.kind !== 'jump') continue;
        if (ev.pos < -0.3 || ev.pos > 1.05) continue;
        const ex = posToX(ev.pos);
        const d = Math.abs(x - ex);
        const reach = 46;
        if (d > reach) continue;
        const t = 1 - d / reach;
        if (ev.kind === 'jump') {
          // a hump (rise) the marine must hop over.
          y -= Math.round(34 * t * t);
        } else {
          // a loop = a dip then back (the figure-8 base) — render as a pit V.
          y += Math.round(30 * t * t);
        }
      }
      return y;
    }

    /** The marine's vertical aim offset from the `y` axis input (−1..1): push
     *  the stick UP (positive) to RAISE the marine off the ribbon (aim high at
     *  flying imps), DOWN to crouch. Consumed here so the `y` port visibly
     *  moves the character — it is no longer a dead input. */
    function marineAimOffset(): number {
      return Math.round(-state.aimY * 26); // up to ±26 px
    }

    function paintMarine(): void {
      const baseY = ribbonY(MARINE_X);
      const sy = baseY + marineAimOffset();
      // recent-event-driven pose: fire on an enemy clear, a loop/jump HOP on an
      // obstacle clear, pain on a miss. The hop makes a correct loop/jump press
      // visibly rewarding (the marine jumps), not just a silent ribbon deform.
      const recentFire = state.events.some(
        (e) => e.resolved && e.outcome === 'hit' && (e.kind === 'imp' || e.kind === 'zombie')
          && e.resolvedTick !== null && state.tick - e.resolvedTick <= 1,
      );
      const recentMiss = state.events.some(
        (e) => e.resolved && e.outcome === 'miss' && e.resolvedTick !== null && state.tick - e.resolvedTick <= 1,
      );
      const recentHop = state.events.some(
        (e) => e.resolved && e.outcome === 'hit' && (e.kind === 'loop' || e.kind === 'jump')
          && e.resolvedTick !== null && state.tick - e.resolvedTick <= 1,
      );
      // A recent obstacle clear lifts the marine in a visible hop arc.
      const hopY = recentHop ? -22 : 0;
      let f: SpriteFrame | null = null;
      if (sprites) {
        if (state.health === 'dead' && sprites.marineDie.length) {
          f = sprites.marineDie[Math.min(sprites.marineDie.length - 1, Math.floor(animTick / 6))]!;
        } else if (recentFire && sprites.marineFire.length) {
          f = sprites.marineFire[Math.floor(animTick / 4) % sprites.marineFire.length]!;
        } else if (recentMiss && sprites.marinePain.length) {
          f = sprites.marinePain[0]!;
        } else if (sprites.marineRun.length) {
          f = sprites.marineRun[Math.floor(animTick / 6) % sprites.marineRun.length]!;
        }
      }
      const my = sy + hopY;
      if (f) {
        blitSprite(f, MARINE_X, my, 1.6);
        // A muzzle-flash streak when firing makes the enemy clear unmistakable.
        if (recentFire) drawLine(MARINE_X + 12, my - 30, MARINE_X + 40, my - 30, COL_PROMPT_HOT);
      } else {
        // Line-art marine placeholder: a simple stick figure on the ribbon.
        const col = state.health === 'dead' ? BTN_COLORS.b
          : recentFire ? BTN_COLORS.x
          : recentHop ? BTN_COLORS.a
          : recentMiss ? BTN_COLORS.b
          : COL_RIBBON;
        drawStickFigure(MARINE_X, my, col);
        if (recentFire) drawLine(MARINE_X + 9, my - 28, MARINE_X + 34, my - 28, COL_PROMPT_HOT);
      }
    }

    // ── line-art glyph helpers (fallbacks + the ABXY prompt strip) ──────────
    function drawDiamond(cx: number, cy: number, r: number, rgb: number[]): void {
      drawLine(cx, cy - r, cx + r, cy, rgb);
      drawLine(cx + r, cy, cx, cy + r, rgb);
      drawLine(cx, cy + r, cx - r, cy, rgb);
      drawLine(cx - r, cy, cx, cy - r, rgb);
    }
    function drawStickFigure(cx: number, baseY: number, rgb: number[]): void {
      const headR = 6;
      const top = baseY - 40;
      // head (diamond as a cheap circle)
      drawDiamond(cx, top, headR, rgb);
      // body
      drawLine(cx, top + headR, cx, baseY - 14, rgb);
      // legs
      drawLine(cx, baseY - 14, cx - 7, baseY, rgb);
      drawLine(cx, baseY - 14, cx + 7, baseY, rgb);
      // arms
      drawLine(cx, top + 14, cx - 9, top + 22, rgb);
      drawLine(cx, top + 14, cx + 9, top + 22, rgb);
    }
    /** A small wireframe ABXY prompt glyph (a coloured ring + letter-ish mark).
     *  `hot` = the event is in the timing window → brighter + a tick mark.
     *  `filled` = the imminent slot → fill the diamond with the button tint so
     *  the next-to-press button reads at a glance even at the 480px card scale. */
    function drawButtonGlyph(btn: GibButton, cx: number, cy: number, hot: boolean, filled = false): void {
      const col = hot ? COL_PROMPT_HOT : COL_PROMPT;
      const tint = BTN_COLORS[btn];
      const r = hot ? 11 : 9;
      if (filled) {
        // Scanline-fill the diamond with the button tint.
        for (let dy = -r; dy <= r; dy++) {
          const span = r - Math.abs(dy);
          for (let dx = -span; dx <= span; dx++) setPx(cx + dx, cy + dy, tint);
        }
      }
      // ring
      drawDiamond(cx, cy, r, tint);
      drawDiamond(cx, cy, r + 2, col);
      // an inner mark per button so the four are distinguishable in mono:
      const mark = filled ? COL_BG : tint;
      if (btn === 'a') drawLine(cx - 3, cy + 3, cx + 3, cy - 3, mark); // /
      else if (btn === 'b') drawLine(cx - 3, cy - 3, cx + 3, cy + 3, mark); // \
      else if (btn === 'x') { drawLine(cx - 3, cy - 3, cx + 3, cy + 3, mark); drawLine(cx - 3, cy + 3, cx + 3, cy - 3, mark); } // X
      else { drawLine(cx, cy - 3, cx, cy + 3, mark); drawLine(cx, cy, cx - 3, cy - 3, mark); drawLine(cx, cy, cx + 3, cy - 3, mark); } // Y
    }

    function uploadFramebuffer(): void {
      gl.bindTexture(gl.TEXTURE_2D, sourceTex);
      gl.texSubImage2D(
        gl.TEXTURE_2D, 0, 0, 0, INTERNAL_W, INTERNAL_H, gl.RGBA, gl.UNSIGNED_BYTE,
        new Uint8Array(fbBytes.buffer, fbBytes.byteOffset, fbBytes.byteLength),
      );
    }

    // Paint a first frame so consumers + the on-card preview have content.
    paintFrame();
    uploadFramebuffer();

    const surface: VideoNodeSurface = {
      fbo,
      texture,
      draw(frame) {
        const tNow = frame.time;
        const dt = lastDrawTimeS < 0 ? 0 : Math.max(0, tNow - lastDrawTimeS);
        lastDrawTimeS = tNow;
        animTick += 1;
        // Decay the hit-flash (dt-based so it fades the same at 30 vs 60 fps).
        if (flashLevel > 0) flashLevel = Math.max(0, flashLevel - (dt > 0 ? dt * 4 : 0.12));
        // AIM: feed the live joystick axes into the pure state every frame so
        // judgePress (aimX) + the marine render (aimY) actually consume them.
        setAim(state, params.axis_x, params.axis_y);

        // AUTOPLAY: drive an INTERNAL clock when no external clock is patched, so
        // a freshly-dropped card actually plays (spawns events) instead of just
        // scrolling an empty ribbon. An external clock train (seen within
        // EXTERNAL_CLOCK_TIMEOUT_S) owns the beat and suppresses this.
        if (extClockEdges !== extClockEdgesSeen) {
          extClockEdgesSeen = extClockEdges;
          extClockIdleS = 0;
        } else {
          extClockIdleS += dt;
        }
        const externalClockActive = extClockIdleS < EXTERNAL_CLOCK_TIMEOUT_S;
        if (params.autoplay > 0.5 && !externalClockActive && dt > 0 && state.health !== 'dead') {
          internalBeatAccS += dt;
          // Guard against a long-hidden-tab dt spike flooding ticks.
          let guard = 8;
          while (internalBeatAccS >= INTERNAL_BEAT_S && guard-- > 0) {
            internalBeatAccS -= INTERNAL_BEAT_S;
            autoBeat += 1;
            clockTick(state, autoplayCv(autoBeat), true);
          }
          drainGameEvents();
        }

        // Smooth scroll between clock beats (the clock pulse is the
        // authoritative beat; this just interpolates motion).
        if (dt > 0 && state.health !== 'dead') {
          scroll(state, GIB_TUNING.scrollPerSecond * dt);
          drainGameEvents(); // a scroll-induced miss must pulse its gate
        }

        paintFrame();
        uploadFramebuffer();

        const g = frame.gl;
        g.bindFramebuffer(g.FRAMEBUFFER, fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.useProgram(program);
        g.activeTexture(g.TEXTURE0);
        g.bindTexture(g.TEXTURE_2D, sourceTex);
        g.uniform1i(uTex, 0);
        g.uniform2f(uLetterbox, letterboxU, letterboxV);
        ctx.drawFullscreenQuad();
        g.bindFramebuffer(g.FRAMEBUFFER, null);
      },
      dispose() {
        gl.deleteFramebuffer(fbo);
        gl.deleteTexture(texture);
        gl.deleteTexture(sourceTex);
        gl.deleteProgram(program);
        for (const src of [hitGate, missGate, fireGate, killGate, gameoverGate, healthCv]) {
          if (!src) continue;
          try { src.stop(); } catch { /* */ }
          try { src.disconnect(); } catch { /* */ }
        }
      },
    };

    function reset(): void {
      state = newGame(seed());
      setAim(state, params.axis_x, params.axis_y);
      // Reset the autoplay/internal-clock bookkeeping so a fresh game's count-in
      // + first spawn time the same as on initial drop (not carried over from
      // the previous run), and clear any lingering hit-flash.
      internalBeatAccS = 0;
      autoBeat = 0;
      flashLevel = 0;
      updateHealthCv();
      paintFrame();
      uploadFramebuffer();
    }

    const extras: GibribbonHandleExtras = {
      snapshot: () => fbImage,
      getScore: () => state.score,
      getHealth: () => state.health,
      getCombo: () => state.combo,
      loadError: () => loadErr,
      pushButton(button) { judgeButton(button); return true; },
      getLane: () => upcomingLane(state).map((s) => ({ button: s.button, kind: s.kind, pos: s.pos, hot: s.hot })),
      isDead: () => state.health === 'dead',
      reset,
      forcePulse(port) { pulseGate(gateFor(port), port); },
    };

    return {
      domain: 'video',
      surface,
      audioSources,
      setParam(paramId, value) {
        if (paramId in params) (params as Record<string, number>)[paramId] = value;

        // CLOCK rising edge → one authoritative beat: tick the game with the
        // current CV levels + gate state, then drain its side-effects.
        if (paramId === 'clock') {
          const ev = detectEdge(clockEdge, value);
          if (ev && ev.pressed) {
            extClockEdges += 1; // mark MUSICAL mode → suppresses the internal clock
            const cv = [params.cv1, params.cv2, params.cv3, params.cv4];
            clockTick(state, cv, params.gate > 0.5);
            drainGameEvents();
          }
          return;
        }

        // ABXY button rising edges → judge a press.
        if (paramId === 'btn_a' || paramId === 'btn_b' || paramId === 'btn_x' || paramId === 'btn_y') {
          const btn: GibButton = paramId === 'btn_a' ? 'a' : paramId === 'btn_b' ? 'b' : paramId === 'btn_x' ? 'x' : 'y';
          const ev = detectEdge(buttonEdges[btn], value);
          if (ev && ev.pressed) judgeButton(btn);
          return;
        }
        // cv1..cv4 / gate / axes are sampled in draw()/clockTick — nothing to
        // do on the setParam write beyond storing the value (done above).
      },
      readParam(paramId) {
        return (params as Record<string, number>)[paramId];
      },
      read(key) {
        if (key === 'extras') return extras;
        if (key === 'snapshot') return fbImage;
        if (key === 'score') return state.score;
        if (key === 'health') return state.health;
        if (key === 'combo') return state.combo;
        if (key === 'loadError') return loadErr;
        if (key === 'lane') return upcomingLane(state).map((s) => ({ button: s.button, kind: s.kind, pos: s.pos, hot: s.hot }));
        if (key === 'dead') return state.health === 'dead';
        return undefined;
      },
      subscribePulse(portId, cb) {
        let set = pulseSubscribers.get(portId);
        if (!set) { set = new Set(); pulseSubscribers.set(portId, set); }
        set.add(cb);
        return () => {
          const s = pulseSubscribers.get(portId);
          if (!s) return;
          s.delete(cb);
          if (s.size === 0) pulseSubscribers.delete(portId);
        };
      },
      dispose() { surface.dispose(); },
    };
  },
};
