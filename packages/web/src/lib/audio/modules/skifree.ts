// packages/web/src/lib/audio/modules/skifree.ts
//
// SKIFREE — the classic SkiFree (ski downhill, dodge trees/rocks, get
// chased + EATEN by the yeti). Black-box wrapper around the upstream
// skifree.js engine (MIT — Daniel Hough 2013).
//
// Like FROGGER this is an AUDIO-domain game module (Games palette group): the
// game's own pure JS classes drive the canvas, and we expose a
// synth-native IO surface around it:
//
//   x (cv)  bipolar −1..+1 → cursor X in canvas px (0..size). Steers the
//   y (cv)  skier left/right + down. SkiFree steers the skier TOWARD the
//           mouse cursor; we synthesize that cursor from CV.
//
//   gate (gate)  rising edge (10 ms pulse) on every CRASH (tree / rock /
//           jump-fail / snowboarder) OR when the yeti EATS the skier.
//           Pulsed from the engine's hasHitObstacle callback (which
//           upstream fires for both crashes and — via isEatenBy — eats).
//
//   out (video)  the game canvas mirrored each video frame into the
//           cross-domain audio→video bridge (drawFrame), so SKIFREE can
//           drive VIDEO OUT / BENTBOX / any video module. Mirrors the
//           SM64 `out` port pattern.
//
// Native mouse control: when x/y are NOT patched AND the card has focus,
// the player steers with the real mouse directly on the canvas (the card
// calls the engine's enableMouse). Any patched CV input OVERRIDES the
// mouse (the card disables mouse + the factory writes the CV cursor each
// scheduler tick).
//
// Bundle: committed pre-built at /skifree/skifree.bundle.js (~24 KB,
// esbuild IIFE of packages/web/native/skifree/embed.js + the upstream
// js/ classes). The card loads it via a <script> tag and creates a
// controller (window.SkiFree.create) bound to the card's canvas; the
// controller + its onGate callback are published on window.__skifree for
// this factory to read/drive. See packages/web/native/skifree/README.md.
//
// No audio worklet: the gate is a ConstantSourceNode pulsed on the event
// (PONG's pattern); the game logic runs at rAF cadence inside the bundle.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { getSchedulerClock } from '$lib/audio/scheduler-clock';

/** Gate pulse width in seconds. Matches PONG / the project's gate
 *  convention so downstream gate consumers see an identical pulse. */
export const SKIFREE_GATE_PULSE_S = 0.01;

/** Schedule cushion — the audio thread can be one block ahead of
 *  ctx.currentTime; a small cushion guarantees the rising edge isn't
 *  missed. */
const SCHEDULE_CUSHION_S = 0.005;

/** The card's logical (CSS) canvas size. The CV→cursor map targets this
 *  coordinate space; the card creates the controller with the same size. */
export const SKIFREE_CANVAS_SIZE = 320;

/**
 * Map a bipolar CV value (−1..+1, the project's standard CV range) to a
 * canvas coordinate in [0, size]. CV 0 → canvas centre (where the skier
 * sits — so an unpatched-but-zero axis keeps the skier going straight
 * down), CV −1 → 0 (left/top edge), CV +1 → size (right/bottom edge).
 * Out-of-range CV is clamped to the canvas bounds.
 *
 * Exported (pure) for the unit test in skifree.test.ts.
 */
export function cvToCanvasCoord(cv: number, size: number = SKIFREE_CANVAS_SIZE): number {
  const c = (cv + 1) * 0.5 * size;
  if (c < 0) return 0;
  if (c > size) return size;
  return c;
}

/** Live snapshot the card polls via engine.read(node, 'snapshot') — mirrors
 *  PONG/SM64. Surfaces the game state + whether CV is currently driving the
 *  cursor (so the card can show a "MOUSE" vs "CV" indicator). */
export interface SkifreeSnapshot {
  tick: number;
  /** Distance travelled down the mountain, metres (from the engine). */
  distance: number;
  /** Skier lives remaining (5 → 0). */
  lives: number;
  /** Total crash events since spawn. */
  crashes: number;
  /** Total eaten-by-yeti events since spawn. */
  eaten: number;
  /** 'crash' | 'eaten' | null — the most recent gate event. */
  lastEvent: 'crash' | 'eaten' | null;
  /** True once lives hit 0 (game over / paused). */
  gameOver: boolean;
  /** True when at least one of x/y is patched (CV overrides mouse). */
  cvDriven: boolean;
}

/** Bridge shape the card publishes on window.__skifree for the factory.
 *  The card owns the canvas + the loaded bundle's controller; the factory
 *  reads game state, pushes the CV cursor, and registers its gate-pulse
 *  callback. */
export interface SkifreeBridge {
  /** The bundle controller (window.SkiFree.create(...)), or null until the
   *  bundle has loaded + the card created it. */
  controller: SkifreeController | null;
  /** The factory sets this once at materialize; the card's controller calls
   *  it on every crash/eaten event so the gate pulses. */
  onGate: ((evt: { type: 'crash' | 'eaten' }) => void) | null;
  /** The factory sets this true/false each tick; the card reads it to flip
   *  native mouse on/off (CV-driven → mouse off). */
  cvDriven: boolean;
}

/** Subset of the bundle controller's API this module relies on (the bundle
 *  is plain JS; this is the typed view). */
export interface SkifreeController {
  setCursor(x: number, y: number): void;
  enableMouse(el?: HTMLElement): void;
  disableMouse(): void;
  reset(): void;
  dispose(): void;
  getState(): {
    distanceTravelled: number;
    livesLeft: number;
    crashes: number;
    eaten: number;
    lastEvent: 'crash' | 'eaten' | null;
    gameOver: boolean;
  };
  readonly canvas: HTMLCanvasElement;
  _forceCrash(): void;
  _forceEaten(): void;
}

export const skifreeDef: AudioModuleDef = {
  type: 'skifree',
  palette: { top: 'Games', sub: 'Arcade' },
  domain: 'audio',
  label: 'skifree',
  category: 'games',
  vizPassthrough: true,
  // Single-instance per rack: the bundle controller binds to ONE card
  // canvas + we publish a single window.__skifree bridge. A second card
  // would race the bridge. Mirrors SM64 / DOOM maxInstances:1.
  maxInstances: 1,
  ossAttribution: { author: 'skifree.js / Daniel Hough (MIT)' },

  inputs: [
    // Bipolar CV cursor — the skier steers toward (x, y). Read at scheduler-
    // tick rate via AnalyserNode taps (PONG's pattern); NOT routed to an
    // AudioParam.
    { id: 'x', type: 'cv' },
    { id: 'y', type: 'cv' },
  ],
  outputs: [
    // Rising-edge gate on every crash / eaten event.
    { id: 'gate', type: 'gate' },
    // The game canvas as a cross-domain video source (drawFrame blit).
    { id: 'out', type: 'video' },
  ],
  params: [],

  docs: {
    explanation:
      "The classic SkiFree game wrapped as a hybrid audio/video module — ski downhill, dodge trees, rocks, and snowboarders, and outrun the yeti that eventually chases and EATS you. The skier always heads down the mountain and steers toward a cursor; you supply that cursor with two CV inputs (X and Y), so an LFO, sequencer, JOYSTICK, or envelope plays the slope. (When nothing is patched and the card has focus you can also steer with the real mouse on the canvas; any patched CV overrides the mouse.) The game produces one trigger output — a gate that pulses on every crash or yeti-eat — and one VIDEO output carrying the live game canvas, so SKIFREE can drive VIDEO OUT, BENTBOX, or any video module. It has no parameters and no internal audio (the gate is the sound source you build the patch around); it's single-instance per rack (only one SKIFREE can run at a time).",
    inputs: {
      x: "Bipolar CV (−1..+1) → the cursor's X position the skier steers toward. −1 = far left, 0 = straight down the fall line, +1 = far right. Read at scheduler-tick rate (a continuous position, not a gate). Patching it overrides on-card mouse steering.",
      y: "Bipolar CV (−1..+1) → the cursor's Y position the skier steers toward. −1 = top, 0 = center, +1 = bottom — pulling the cursor lower makes the skier point more steeply downhill (faster). Continuous position, read each tick; patching it overrides the mouse.",
    },
    outputs: {
      gate:
        "Fires a 10 ms pulse on every crash event — hitting a tree, rock, snowboarder, or a failed jump — AND when the yeti finally eats the skier. A rising-edge trigger you can route to a crash sound, a drum hit, or a sample; the rhythm of pulses tracks how cleanly (or not) the run is going.",
      out:
        "The live game canvas as a cross-domain video source — each video frame the skier/mountain image is blitted into the audio→video bridge. Patch it into VIDEO OUT, BENTBOX, or any video module to display or further process the game.",
    },
    controls: {},
  },

  async factory(ctx, _node): Promise<AudioDomainNodeHandle> {
    // ---- CV input taps (x / y) -----------------------------------------
    // AnalyserNode tap per axis, read tail-sample each scheduler tick.
    // We ALSO track whether each axis is currently carrying signal so we
    // can tell the card to disable native mouse control when CV is driving.
    function makeCvTap(): { node: AnalyserNode; read(): number } {
      const a = ctx.createAnalyser();
      a.fftSize = 32;
      a.smoothingTimeConstant = 0;
      const buf = new Float32Array(32);
      return {
        node: a,
        read(): number {
          a.getFloatTimeDomainData(buf);
          return buf[buf.length - 1] ?? 0;
        },
      };
    }
    const xTap = makeCvTap();
    const yTap = makeCvTap();

    // A CV input is "patched" if its analyser sees a non-zero connection.
    // An unpatched AnalyserNode reads exactly 0 (no upstream node feeds it);
    // a patched-but-resting-at-0 CV is indistinguishable from unpatched,
    // which is fine — at exactly 0 the cursor maps to canvas centre (skier
    // straight down) and the mouse path would do nothing different. We use
    // a tiny epsilon so floating-point noise doesn't flap the indicator.
    const CV_EPS = 1e-4;

    // ---- Gate output ----------------------------------------------------
    const gateSrc = ctx.createConstantSource();
    gateSrc.offset.value = 0;
    gateSrc.start();
    function pulseGate(): void {
      const t = ctx.currentTime + SCHEDULE_CUSHION_S;
      try { gateSrc.offset.cancelScheduledValues(t); } catch { /* */ }
      gateSrc.offset.setValueAtTime(1, t);
      gateSrc.offset.setValueAtTime(0, t + SKIFREE_GATE_PULSE_S);
    }

    // ---- Cross-domain video bridge (out) -------------------------------
    // Each video frame the bridge invokes drawFrame(target); we blit the
    // bundle's game canvas into it (canvas→canvas drawImage, no CPU
    // readback). Identical pattern to SM64's drawFrame. Black until the
    // bundle's canvas exists.
    const vidAnalyser = ctx.createAnalyser();
    vidAnalyser.fftSize = 32;
    function drawFrame(target: OffscreenCanvas | HTMLCanvasElement): void {
      const bridge = (globalThis as unknown as { __skifree?: SkifreeBridge }).__skifree;
      const src = bridge?.controller?.canvas;
      if (!src) return;
      const c2d = target.getContext('2d') as
        | CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
      if (!c2d) return;
      const tw = target.width;
      const th = target.height;
      const sw = src.width;
      const sh = src.height;
      if (sw <= 0 || sh <= 0 || tw <= 0 || th <= 0) return;
      c2d.fillStyle = '#000';
      c2d.fillRect(0, 0, tw, th);
      const srcAspect = sw / sh;
      const dstAspect = tw / th;
      let drawW: number;
      let drawH: number;
      if (srcAspect > dstAspect) {
        drawW = tw;
        drawH = Math.round(tw / srcAspect);
      } else {
        drawH = th;
        drawW = Math.round(th * srcAspect);
      }
      const dx = Math.floor((tw - drawW) / 2);
      const dy = Math.floor((th - drawH) / 2);
      try {
        (c2d as CanvasRenderingContext2D).drawImage(src, 0, 0, sw, sh, dx, dy, drawW, drawH);
      } catch (_e) { /* tainted/detached source — stay black this frame */ }
    }

    // ---- Register the gate-pulse callback on the bridge -----------------
    // The card's controller calls bridge.onGate({type}) on every event; we
    // pulse the gate. Idempotent — re-materialize overwrites the prior fn.
    function ensureBridge(): SkifreeBridge {
      const w = globalThis as unknown as { __skifree?: SkifreeBridge };
      if (!w.__skifree) {
        w.__skifree = { controller: null, onGate: null, cvDriven: false };
      }
      return w.__skifree;
    }
    const bridge = ensureBridge();
    bridge.onGate = (_evt) => { pulseGate(); };

    // ---- Per-tick state -------------------------------------------------
    let tick = 0;
    let lastSnapshot: SkifreeSnapshot = {
      tick: 0, distance: 0, lives: 5, crashes: 0, eaten: 0,
      lastEvent: null, gameOver: false, cvDriven: false,
    };

    const tickFn = () => {
      tick++;
      const xCv = xTap.read();
      const yCv = yTap.read();
      const cvDriven = Math.abs(xCv) > CV_EPS || Math.abs(yCv) > CV_EPS;

      const b = (globalThis as unknown as { __skifree?: SkifreeBridge }).__skifree;
      if (b) {
        b.cvDriven = cvDriven;
        const ctl = b.controller;
        if (ctl) {
          // CV OVERRIDES mouse: when an axis is patched, write the CV cursor.
          // When neither is patched the card's native-mouse path drives the
          // cursor, so we leave it alone.
          if (cvDriven) {
            ctl.setCursor(
              cvToCanvasCoord(xCv, SKIFREE_CANVAS_SIZE),
              cvToCanvasCoord(yCv, SKIFREE_CANVAS_SIZE),
            );
          }
          const gs = ctl.getState();
          lastSnapshot = {
            tick,
            distance: gs.distanceTravelled,
            lives: gs.livesLeft,
            crashes: gs.crashes,
            eaten: gs.eaten,
            lastEvent: gs.lastEvent,
            gameOver: gs.gameOver,
            cvDriven,
          };
        } else {
          lastSnapshot = { ...lastSnapshot, tick, cvDriven };
        }
      }
    };
    const unsubscribe = getSchedulerClock().subscribe(tickFn);

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['x', { node: xTap.node, input: 0 }],
        ['y', { node: yTap.node, input: 0 }],
      ]),
      outputs: new Map([
        ['gate', { node: gateSrc, output: 0 }],
      ]),
      videoSources: new Map([
        ['out', { analyser: vidAnalyser, sampleRate: ctx.sampleRate, drawFrame }],
      ]),
      setParam(_paramId, _value) { /* no params */ },
      readParam(_paramId) { return undefined; },
      read(key) {
        if (key === 'snapshot') return lastSnapshot;
        return undefined;
      },
      dispose() {
        unsubscribe();
        try { gateSrc.stop(); } catch { /* */ }
        try { gateSrc.disconnect(); } catch { /* */ }
        xTap.node.disconnect();
        yTap.node.disconnect();
        try { vidAnalyser.disconnect(); } catch { /* */ }
        // Detach our gate callback from the bridge (the card owns the
        // controller's lifecycle + clears window.__skifree on unmount).
        const w = globalThis as unknown as { __skifree?: SkifreeBridge };
        if (w.__skifree && w.__skifree.onGate === bridge.onGate) {
          w.__skifree.onGate = null;
        }
      },
    };
  },
};
