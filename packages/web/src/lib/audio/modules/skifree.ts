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
// Native mouse control: when x/y are NOT patched, CLICK the slope to take the
// controls and then steer with the real mouse on the picture. Any patched CV
// input OVERRIDES the mouse (the surface stops writing the cursor and the
// factory writes the CV cursor each scheduler tick).
//
// ⚠ THE SURFACES OWN THE MOUSE, AND THE BUNDLE'S OWN `enableMouse` IS NOT USED
// BY ANYTHING. Its handlers close over the FACTORY'S canvas — which is DETACHED
// by construction (see "THE GAME ITSELF" below) — and take their rect from it,
// so `getBoundingClientRect()` returns all zeros and the cursor received raw
// VIEWPORT coordinates. That has been the shipping behaviour since #2192 moved
// the game onto the node: a click at viewport x=900 wrote cursor x=900 into a
// 320-wide coordinate space, so the skier pinned itself to the right edge and
// "steering" was a single stuck direction. Both surfaces now map their OWN
// element's rect through `pointerToCanvasCoord` below and call `setCursor`
// directly. `enableMouse`/`disableMouse` remain on the controller type because
// they are the vendored bundle's API, not ours to delete.
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
import {
  ensureSkifreeBridge,
  ensureSkifreeBundle,
  releaseSkifreeController,
  releaseSkifreeGate,
} from '../skifree-bridge';
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

/**
 * Map ONE axis of a pointer event onto the game's canvas coordinate space.
 *
 * The second half of the cursor story, and it lives beside `cvToCanvasCoord`
 * deliberately: the CV path and the MOUSE path write the SAME `setCursor`, in
 * the same units, so one file owning both is what stops the two drifting into
 * different coordinate spaces.
 *
 * `client` is `e.clientX` / `e.clientY`; `rectStart` and `rectSize` are the
 * displayed element's `getBoundingClientRect()` left/width (or top/height). The
 * displayed size is almost never `size` — the dock paints the slope at 320 CSS
 * px and the lane tile at 160 — so the map is a RATIO, never a subtraction.
 *
 * ⚠ A ZERO-SIZED RECT RETURNS THE CENTRE, AND THAT BRANCH IS THE WHOLE BUG.
 * The vendored bundle's own mouse handlers do `e.clientX - rect.left` against a
 * canvas that is DETACHED — every field of that rect is 0 — so they fed raw
 * VIEWPORT pixels into a 0..320 space and the skier parked on an edge. A ratio
 * against a zero width is a division by zero, so the honest answer for "I
 * cannot measure this element" is the resting cursor (canvas centre, the same
 * place CV 0 maps to) rather than a number in the wrong units.
 *
 * Exported (pure) for the unit test in skifree.test.ts.
 */
export function pointerToCanvasCoord(
  client: number,
  rectStart: number,
  rectSize: number,
  size: number = SKIFREE_CANVAS_SIZE,
): number {
  if (!(rectSize > 0)) return size * 0.5;
  const c = ((client - rectStart) / rectSize) * size;
  if (!Number.isFinite(c)) return size * 0.5;
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
  /**
   * Has the NODE built its game yet? True from the moment `SkiFree.create()`
   * returns, which is BEFORE the skier exists — see `gameStarted`.
   *
   * ⚠ THIS IS THE CARD'S "Loading…" CONDITION, and it is on the snapshot rather
   * than in card state because the game belongs to the node: a card that
   * mounted mid-load must show the same thing a card that mounted early shows.
   */
  gameCreated: boolean;
  /**
   * Has the skier ever actually MOVED? Latches true on the first non-zero
   * distance and never goes back.
   *
   * ⚠ IT EXISTS BECAUSE `gameCreated` IS NOT ENOUGH TO TELL TWO FAILURES APART,
   * and both look like "distance is 0". `SkiFree.create()` returns a controller
   * SYNCHRONOUSLY, but the bundle only builds the player after two sprite-sheet
   * PNGs decode (`loadImagesThen → buildGame`). So a zero distance means either
   * "still booting" or "booted and not moving", and only a flag that survives
   * the boot can separate them. Read it beside `distance` and the pair carries
   * its own control:
   *   created false                → still loading (or `bundleError` is set)
   *   created true,  started false → booted-or-booting, skier has never moved
   *   created true,  started true  → the run is real; a frozen distance now is
   *                                  a genuine stall rather than a boot gap
   */
  gameStarted: boolean;
  /**
   * Why the game could not be loaded, or null when fine.
   *
   * ⚠ THE FAILURE REPORT LIVES ON THE NODE, NOT ON THE CARD. The card used to
   * own the bundle load and render its own error overlay — but the card is not
   * guaranteed to be mounted, so a card-only message is addressed to somebody
   * who may not be there, and a `console.warn` plus a permanent "Loading…"
   * spinner is indistinguishable from a slow network to anyone actually using
   * it. Putting it on the payload the card already polls costs one field and
   * reuses the existing `read` seam.
   */
  bundleError: string | null;
}

/** Publication shape on `window.__skifree`.
 *
 *  ⚠ THE FACTORY OWNS EVERY FIELD. It used to own only `onGate` while the CARD
 *  owned `controller` — two owners with different lifetimes sharing one object,
 *  which is what #1590 was about. The card no longer creates, publishes or
 *  disposes anything: the game's lifetime is the NODE's, so the factory that
 *  already has exactly that lifetime owns it. See the header of
 *  `$lib/audio/skifree-bridge` for what that collapse did and did not fix. */
export interface SkifreeBridge {
  /** The bundle controller (window.SkiFree.create(...)), or null until the
   *  factory has loaded the bundle and created it. */
  controller: SkifreeController | null;
  /** The factory sets this once at materialize; the controller calls it on
   *  every crash/eaten event so the gate pulses. */
  onGate: ((evt: { type: 'crash' | 'eaten' }) => void) | null;
  /** The factory sets this true/false each tick; the card reads it to flip
   *  native mouse on/off (CV-driven → mouse off). */
  cvDriven: boolean;
}

/** The global the vendored bundle installs. Typed here because the bundle is
 *  plain JS; the FACTORY is now its only caller. */
export interface SkiFreeGlobal {
  create(opts: {
    canvas: HTMLCanvasElement;
    width: number;
    height: number;
    spriteBase?: string;
    onGate?: (evt: { type: 'crash' | 'eaten' }) => void;
  }): SkifreeController;
}

/** Where the vendored bundle and its sprite sheets live under `static/`. */
export const SKIFREE_BUNDLE_SRC = '/skifree/skifree.bundle.js';
export const SKIFREE_SPRITE_BASE = '/skifree';

/** Subset of the bundle controller's API this module relies on (the bundle
 *  is plain JS; this is the typed view). */
export interface SkifreeController {
  setCursor(x: number, y: number): void;
  enableMouse(el?: HTMLElement): void;
  disableMouse(): void;
  reset(): void;
  dispose(): void;
  getState(): {
    /**
     * ⚠ A NUMBER *OR* A STRING, AND THE TYPE SAYS SO BECAUSE THE BUNDLE DOES
     * BOTH. It is declared `0` at init and on reset, and every game tick then
     * overwrites it with
     * `parseFloat(pixels / 18).toFixed(1)` — and `.toFixed()` returns a
     * STRING. So this field is `0` before the first tick and `"12.3"` after
     * one, in the same run.
     *
     * It used to be typed `number` here, which is how `snapshot.distance`
     * became a string that every consumer silently coerced. The union is not
     * pedantry: it is what makes the `Number(...)` at the read site below
     * visibly NECESSARY rather than looking like redundant defensive code
     * somebody could tidy away.
     */
    distanceTravelled: number | string;
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
    { id: 'gate', type: 'gate', edge: 'trigger' },
    // The game canvas as a cross-domain video source (drawFrame blit).
    { id: 'out', type: 'video' },
  ],
  params: [],

  // ── THE FACEPLATE ────────────────────────────────────────────────────────
  //
  // `order: []` — and it is the FLIPPER shape, not the joystick one. The def
  // declares `params: []`, so there is nothing to rank and nothing is dropped:
  // #1974's clause is about a face that RANKS controls and then resolves to
  // zero cells at the tier the player is looking at, and its own exclusion
  // ("a face that ranks NOTHING is not in scope") names `flipper` and
  // `videoOut` as the honest shape. skifree is the third. ⚠ THE CONSEQUENCE IS
  // THAT NOTHING IN CI WATCHES THIS LANE: the clause `continue`s past an
  // `order: []` face before it measures anything, so the tile could regress to
  // a title and a jack rail with every gate green. `skifree-face-model.test.ts`
  // therefore pins the `tileBody`'s EXISTENCE itself.
  //
  // `glyph: 'none'` is FORCED, run through the resolver rather than argued from
  // the module's description: `primaryAudioOutPortId` matches `type === 'audio'`
  // and skifree declares NONE (`gate` is a gate, `out` is video), so every live
  // literal — scope, meter, envelope, waveform — resolves `{kind:'static'}` and
  // is refused by the dead-glyph clause. `hasVideoSurface` is `domain ===
  // 'video'`, and this is an audio def with a video PORT, so the shell's own
  // video thumbnail is out of reach too. The picture has to come from the
  // module, which is what the extension is for.
  //
  // TWO SLOTS, because the two surfaces are counterparts and neither is
  // optional here. `fullViewBody` is the dock's slope — the STEERABLE one, and
  // the only place a player can take the controls. `tileBody` is the lane's,
  // read-only: without it a promoted skifree's lane tile is a title bar and
  // four jacks, which is strictly worse than the placeholder it replaces on a
  // module whose entire purpose is a game you watch. See
  // $lib/ui/modules/skifree/shell-extension.ts.
  face: {
    order: [],
    glyph: 'none',
    extension: 'skifree',
  },

  docs: {
    explanation:
      "The classic SkiFree game wrapped as a hybrid audio/video module — ski downhill, dodge trees, rocks, and snowboarders, and outrun the yeti that eventually chases and EATS you. The skier always heads down the mountain and steers toward a cursor; you supply that cursor with two CV inputs (X and Y), so an LFO, sequencer, JOYSTICK, or envelope plays the slope. (When nothing is patched you can steer by hand instead: CLICK the slope on the module's faceplate to take the controls, then move the pointer over it — the skier heads for wherever you point, and moving the pointer BELOW the skier is what sends it downhill. Any patched CV immediately overrides the mouse.) The game produces one trigger output — a gate that pulses on every crash or yeti-eat — and one VIDEO output carrying the live game canvas, so SKIFREE can drive VIDEO OUT, BENTBOX, or any video module. It has no parameters and no internal audio (the gate is the sound source you build the patch around); it's single-instance per rack (only one SKIFREE can run at a time). The slope keeps running whether or not you are looking at it — the game lives on the node, so a rack you never expand is still skiing, still crashing and still firing its gate.",
    inputs: {
      x: "Bipolar CV (−1..+1) → the cursor's X position the skier steers toward. −1 = far left, 0 = straight down the fall line, +1 = far right. Read at scheduler-tick rate (a continuous position, not a gate). Patching it overrides mouse steering on the faceplate.",
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

    // ---- The game's handle, declared HERE so `drawFrame` closes over it ----
    // Assigned asynchronously once the vendored bundle has loaded; see "THE
    // GAME ITSELF" below for why the NODE owns it rather than the card.
    let controller: SkifreeController | null = null;
    /** Set by `dispose()`. Guards the in-flight bundle load from creating a
     *  controller for a node that has already left the graph. */
    let disposed = false;
    /** Latches on the first non-zero distance — see `SkifreeSnapshot.gameStarted`. */
    let gameStarted = false;
    /** Why the bundle could not be loaded, surfaced on the snapshot so the card
     *  can SHOW it instead of spinning forever. */
    let bundleError: string | null = null;

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
      // Reads the FACTORY'S OWN controller through the closure rather than the
      // global. It used to go through `globalThis.__skifree`, which is how a
      // missing card turned this into a silent early return and the `out` port
      // into a black frame nobody could attribute.
      const src = controller?.canvas;
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
    // The controller calls bridge.onGate({type}) on every event; we pulse the
    // gate. Idempotent — re-materialize overwrites the prior fn.
    const bridge = ensureSkifreeBridge();
    bridge.onGate = (_evt) => { pulseGate(); };

    // ---- THE GAME ITSELF — owned by the NODE, created here ---------------
    //
    // ⚠ THIS USED TO LIVE ON THE CARD, AND THAT WAS THE BUG. `SkifreeCard`
    // was the only caller of `window.SkiFree.create()`, against its own
    // `bind:this` canvas — so under the shipping shell, where an un-migrated
    // module renders a PLACEHOLDER and the card exists only inside an open
    // dock pane, a rack containing SKIFREE had no game at all until someone
    // expanded it, and collapsing the pane destroyed the run.
    //
    // MEASURED on `/rack` with nothing expanded, before this change:
    //   samples 45 / 368 ms · tick 0 -> 15 · distance 0 -> 0 · controller false
    // — the scheduler tick advancing while the skier never moved, which is the
    // engine being alive and the game not existing.
    //
    // ⚠ THE CANVAS IS DETACHED AND STAYS DETACHED. It is never appended to the
    // document and the card must never re-parent it: a DOM node has exactly one
    // parent, so adopting it into a card would hand the game's surface to a
    // component that unmounts — the cameraInput trap, one seam over. The card
    // BLITS from it (`controller.canvas` → its own visible canvas), which is
    // the same canvas-to-canvas `drawImage` `drawFrame` above already does.
    // The bundle never touches `document` (verified against the vendored file),
    // so a detached canvas is fully sufficient for it to run.
    if (typeof document !== 'undefined') {
      // Guarded exactly like `spectrograph.ts` / `twotracks.ts`: an audio
      // factory may be constructed in a node-env test with no DOM, and there
      // the module is simply gameless rather than broken.
      const gameCanvas = document.createElement('canvas');
      gameCanvas.width = SKIFREE_CANVAS_SIZE;
      gameCanvas.height = SKIFREE_CANVAS_SIZE;
      void ensureSkifreeBundle()
        .then((SkiFree) => {
          // The node may have been removed while the bundle was in flight.
          // Creating a controller for a dead node would leak a rAF loop that
          // nothing ever disposes.
          if (disposed) return;
          controller = SkiFree.create({
            canvas: gameCanvas,
            width: SKIFREE_CANVAS_SIZE,
            height: SKIFREE_CANVAS_SIZE,
            spriteBase: SKIFREE_SPRITE_BASE,
            onGate: (evt) => {
              // Through the bridge, NOT straight to `pulseGate`, so a
              // re-materialized node's newer callback wins — the identity
              // discipline `releaseSkifreeGate` exists for.
              const b = ensureSkifreeBridge();
              if (b.onGate) b.onGate(evt);
            },
          });
          ensureSkifreeBridge().controller = controller;
        })
        .catch((e: unknown) => {
          // ⚠ RECORDED ON THE SNAPSHOT, NOT JUST LOGGED. A card-only overlay was
          // the old answer and it is addressed to somebody who may not be
          // mounted; a bare `console.warn` plus a permanent "Loading…" is
          // indistinguishable from a slow network to anyone actually using it.
          // The card polls this payload already, so the failure reaches
          // whichever surface happens to exist — and none, harmlessly, when
          // none does.
          bundleError = (e as Error).message;
          lastSnapshot = { ...lastSnapshot, bundleError };
          console.warn(`[skifree] the game bundle failed to load: ${bundleError}`);
        });
    }

    // ---- Per-tick state -------------------------------------------------
    let tick = 0;
    let lastSnapshot: SkifreeSnapshot = {
      tick: 0, distance: 0, lives: 5, crashes: 0, eaten: 0,
      lastEvent: null, gameOver: false, cvDriven: false,
      gameCreated: false, gameStarted: false, bundleError: null,
    };

    const tickFn = () => {
      tick++;
      const xCv = xTap.read();
      const yCv = yTap.read();
      const cvDriven = Math.abs(xCv) > CV_EPS || Math.abs(yCv) > CV_EPS;

      const b = (globalThis as unknown as { __skifree?: SkifreeBridge }).__skifree;
      if (b) {
        b.cvDriven = cvDriven;
        // The FACTORY'S OWN handle, not `b.controller` — the bridge is a
        // publication for the card and the e2e, never this node's source of
        // truth about its own game.
        const ctl = controller;
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
          // ⚠ COERCED AT THE BOUNDARY, ONCE. `distanceTravelled` is `0` before
          // the first game tick and a `.toFixed(1)` STRING after it (see the
          // type above), so `snapshot.distance` was a number-or-string that
          // every consumer coerced by accident — the HUD by interpolation, this
          // latch by `>`, and any future arithmetic by luck. One `Number()`
          // here makes the published type true for everyone downstream.
          const distance = Number(gs.distanceTravelled) || 0;
          // LATCHES, never unlatches — "has this run ever been real" is a
          // different question from "is it moving right now", and only the
          // latched form can tell a boot gap from a stall.
          if (distance > 0) gameStarted = true;
          lastSnapshot = {
            tick,
            distance,
            lives: gs.livesLeft,
            crashes: gs.crashes,
            eaten: gs.eaten,
            lastEvent: gs.lastEvent,
            gameOver: gs.gameOver,
            cvDriven,
            gameCreated: true,
            gameStarted,
            bundleError,
          };
        } else {
          lastSnapshot = { ...lastSnapshot, tick, cvDriven, gameCreated: false, bundleError };
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
        // The card reaches the game THROUGH THE NODE rather than through the
        // global, so mouse steering is scoped to the node it is drawn on and
        // does not depend on a single-instance global being the right one.
        if (key === 'controller') return controller;
        return undefined;
      },
      dispose() {
        // ⚠ THE ONLY TEARDOWN THE GAME HAS, AND IT IS KEYED TO THE GRAPH.
        // `dispose` runs when the node LEAVES the graph — deleted, cleared,
        // undone, or replaced by a patch load — and nowhere else. A card
        // unmounting is not one of those, which is the whole point: there is
        // deliberately no card-facing release, so a future `onDestroy` cannot
        // reach the controller and `tsc` refuses the attempt.
        disposed = true;
        unsubscribe();
        try { gateSrc.stop(); } catch { /* */ }
        try { gateSrc.disconnect(); } catch { /* */ }
        xTap.node.disconnect();
        yTap.node.disconnect();
        try { vidAnalyser.disconnect(); } catch { /* */ }
        try { controller?.dispose(); } catch { /* */ }
        releaseSkifreeController(controller);
        controller = null;
        releaseSkifreeGate(bridge.onGate);
      },
    };
  },
};
