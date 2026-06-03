// packages/web/src/lib/audio/modules/sm64.ts
//
// SM64 — Super Mario 64 (pure-JS port via upstream sm64js, WTFPL).
//
// This is a black-box wrapper around the upstream sm64js bundle (committed
// pre-built at /sm64js/sm64js.bundle.js — see packages/web/native/sm64js/
// README.md for the regeneration recipe). We do NOT vendor upstream's source
// tree or wire its webpack into our build; we load the bundle as a <script>
// tag at card-mount time, after injecting the DOM scaffold the bundle's
// module-level singletons (`WebGLInstance`, `n64GfxProcessorInstance`, the
// jQuery popover wires in player_input_manager.js, …) read at import time.
//
// IO surface (CV / gate; mirrors the N64 controller, minus L / D-pad / C-stick
// which SM64 doesn't use):
//
//   stick_x_cv     bipolar −1..+1 → playerInput.stickX in N64-native ±64
//   stick_y_cv     bipolar −1..+1 → playerInput.stickY in N64-native ±64
//   a_gate         rising edge (hysteresis) → playerInput.buttonDownA / Pressed
//   b_gate                                  → ...B
//   z_gate                                  → ...Z
//   r_gate                                  → ...Rt   (R-trigger)
//   c_up_gate                               → ...Cu
//   c_down_gate                             → ...Cd
//   c_left_gate                             → ...Cl
//   c_right_gate                            → ...Cr
//   start_gate                              → ...Start
//
// start_gate ALSO auto-fires on the first scheduler tick after spawn IFF a
// ROM is present in IDB (mirror FROGGER's BOOT NOTE). With no ROM, the card
// surfaces the upstream's ROM-extract upload UI and the auto-start is a
// no-op until extraction completes.
//
// Outputs:
//   out (video): the bundle's #gameCanvas mirrored each video frame into the
//     cross-domain bridge canvas (drawFrame readback — see factory). This
//     lets the user patch SM64 → VIDEO OUT / BENTBOX / any downstream video
//     module and see the same Mario render that the card displays. Mirrors
//     DOOM's `out` video port pattern (.../video/modules/doom.ts) at the
//     audio-domain `videoSources` layer.
//
//   The card canvas itself is also `data-viz-passthrough` so a containing
//   GROUP can portal it across-domain — the standard FROGGER/MODTRIS/PONG/
//   SCOPE mechanism. No audio port (upstream's audio is stub-only — TODO
//   in src/index.js → "Audio TODO"; matches FROGGER's no-audio profile).
//
// Singletons: per the previous viability assessment, sm64js carries module-
// level singletons (WebGLInstance, GameInstance, n64GfxProcessorInstance)
// + 39+ direct `document.getElementById` calls. Refactoring all that out is
// a 30-file diff. We instead pin maxInstances: 1 (mirror DOOM) and inject
// the singleton DOM globals (#gameCanvas, #fullCanvas, #mapSelect,
// #startbutton, #rom, #romSelect, #romFile, #romMessage, #mainContent,
// #fps, #slider, #maxFps, #timing-total) directly into the card on mount,
// cleaning them up on unmount. The card lives in src/lib/ui/modules/Sm64Card.svelte.
//
// Step extraction: we monkey-patch `playerInputUpdate` to a no-op and write
// `window.playerInput = {...}` from our CV/gate edge state each scheduler
// tick. We then call the bundle's `produce_one_frame()` once per tick
// (40 Hz, since SCHEDULER_TICK_MS=25 — close to the 30 fps upstream default).
// Both globals (`window.produceOneFrame`, `window.playerInputUpdate`) are
// exposed by a small bootstrap shim baked into the card before the bundle
// runs; if upstream removes them in a future bump, the shim's first-call
// detection will throw a clear error pointing at the README.
//
// Inputs:
//   stick_x_cv / stick_y_cv (cv): bipolar -1..+1 stick position (mapped to N64-native ±64).
//   a_gate / b_gate / z_gate / r_gate (gate): A / B / Z / R button gates (rising = press).
//   c_up_gate / c_down_gate / c_left_gate / c_right_gate (gate): C-button gates.
//   start_gate (gate): Start-button gate.
//
// Outputs: out (video) — see header. Game is also visible on the card.
//
// Params: none on the audio side. (Per-instance game state lives in
//   the loaded sm64js bundle's singletons.)

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { getSchedulerClock } from '$lib/audio/scheduler-clock';
import { detectEdge, makeEdgeState, type EdgeState } from '$lib/doom/cv-gate-edge';

/** N64 stick range. The HW stick reports ±80 raw, but the SM64 game logic
 *  clamps to ±64 and the upstream's keyboard mapping also rounds the
 *  −1..+1 axis × 64. We match that so unit + e2e tests are stable. */
export const SM64_STICK_MAX = 64;

/** Bipolar CV (−1..+1) → N64 stick (±64), rounded + clamped. Exported for
 *  the unit test in sm64.test.ts. */
export function cvToStickValue(cv: number): number {
  const v = Math.round(cv * SM64_STICK_MAX);
  if (v > SM64_STICK_MAX) return SM64_STICK_MAX;
  if (v < -SM64_STICK_MAX) return -SM64_STICK_MAX;
  return v;
}

/** Compose `window.playerInput` from CV-stick + per-button is-pressed state.
 *  Returns a fresh object on every call (no mutation of inputs) so it's
 *  trivially testable. The "pressed" booleans = edge events that fired
 *  during this scheduler tick; the "down" booleans = sticky state. */
export interface Sm64PlayerInput {
  stickX: number;
  stickY: number;
  stickMag: number;
  buttonDownA: boolean;
  buttonDownB: boolean;
  buttonDownZ: boolean;
  buttonDownStart: boolean;
  buttonDownCl: boolean;
  buttonDownCr: boolean;
  buttonDownCu: boolean;
  buttonDownCd: boolean;
  buttonDownRt: boolean;
  buttonPressedA: boolean;
  buttonPressedB: boolean;
  buttonPressedZ: boolean;
  buttonPressedStart: boolean;
  buttonPressedCl: boolean;
  buttonPressedCr: boolean;
  buttonPressedCu: boolean;
  buttonPressedCd: boolean;
  buttonPressedRt: boolean;
}

export interface Sm64ButtonState {
  downA: boolean; downB: boolean; downZ: boolean; downStart: boolean;
  downCl: boolean; downCr: boolean; downCu: boolean; downCd: boolean;
  downRt: boolean;
  pressedA: boolean; pressedB: boolean; pressedZ: boolean; pressedStart: boolean;
  pressedCl: boolean; pressedCr: boolean; pressedCu: boolean; pressedCd: boolean;
  pressedRt: boolean;
}

export function composeSm64PlayerInput(
  stickX: number,
  stickY: number,
  btn: Sm64ButtonState,
): Sm64PlayerInput {
  const mag = Math.sqrt(stickX * stickX + stickY * stickY);
  return {
    stickX, stickY, stickMag: mag,
    buttonDownA: btn.downA, buttonDownB: btn.downB, buttonDownZ: btn.downZ,
    buttonDownStart: btn.downStart, buttonDownCl: btn.downCl, buttonDownCr: btn.downCr,
    buttonDownCu: btn.downCu, buttonDownCd: btn.downCd, buttonDownRt: btn.downRt,
    buttonPressedA: btn.pressedA, buttonPressedB: btn.pressedB, buttonPressedZ: btn.pressedZ,
    buttonPressedStart: btn.pressedStart, buttonPressedCl: btn.pressedCl,
    buttonPressedCr: btn.pressedCr, buttonPressedCu: btn.pressedCu,
    buttonPressedCd: btn.pressedCd, buttonPressedRt: btn.pressedRt,
  };
}

/** Per-instance live snapshot returned by `read('snapshot')` — surfaces the
 *  most-recent CV-decoded playerInput + a few engine status booleans so
 *  cards + tests can observe what's driving the game without poking at the
 *  upstream globals directly. */
export interface Sm64Snapshot {
  /** Tick counter, monotonically increasing per scheduler tick. */
  tick: number;
  /** True once the bundle has reported ROM-extracted assets in IDB. */
  romPresent: boolean;
  /** True once the upstream's startGame() has been called for this
   *  instance. (After auto-start fires, or after a manual start_gate
   *  rising edge.) */
  gameStarted: boolean;
  /** The most-recent playerInput we wrote to `window.playerInput`. */
  lastInput: Sm64PlayerInput;
}

/** ROM-extracted-assets sentinel key in IndexedDB (matches upstream's
 *  romTextureLoader.js → `IDB.set('assets', ...)`). Exported so tests +
 *  the regen script can target the same key. */
export const SM64_IDB_KEY = 'assets';

/** Auto-downsample heuristic the spec calls for: mobile / low-core devices
 *  drop the WebGL canvas to a smaller backing resolution. Exposed for the
 *  unit test. */
export function shouldAutoDownsample(
  hwConcurrency: number,
  mediaQueryMatches: boolean,
): boolean {
  return mediaQueryMatches || hwConcurrency < 8;
}

export const sm64Def: AudioModuleDef = {
  type: 'sm64',
  palette: { top: 'Hybrid', sub: 'Hybrid' },
  domain: 'audio',
  label: 'SM64',
  category: 'games',
  schemaVersion: 1,
  vizPassthrough: true,
  // Singleton-per-rack: the upstream bundle exports module-level singletons
  // (WebGLInstance, GameInstance, n64GfxProcessorInstance) + 39+ direct
  // getElementById calls that the spec explicitly cleared as "do not refactor;
  // mirror DOOM's maxInstances:1 instead". A second SM64 card would race the
  // singletons' WebGL context binding + the #gameCanvas lookup, so the
  // palette + spawn guard + engine.addNode all refuse to admit a 2nd one.
  maxInstances: 1,
  ossAttribution: { author: 'sm64js / Snuffy (WTFPL)' },

  inputs: [
    { id: 'stick_x_cv',   type: 'cv' },
    { id: 'stick_y_cv',   type: 'cv' },
    { id: 'a_gate',       type: 'gate' },
    { id: 'b_gate',       type: 'gate' },
    { id: 'z_gate',       type: 'gate' },
    { id: 'r_gate',       type: 'gate' },
    { id: 'c_up_gate',    type: 'gate' },
    { id: 'c_down_gate',  type: 'gate' },
    { id: 'c_left_gate',  type: 'gate' },
    { id: 'c_right_gate', type: 'gate' },
    { id: 'start_gate',   type: 'gate' },
  ],
  // One video output: the bundle's #gameCanvas mirrored each video frame
  // into the cross-domain bridge canvas (drawFrame readback — see factory).
  // The card's gameCanvasEl is ALSO `data-viz-passthrough` so spatial
  // GROUPs portal the same content cross-domain; the `out` port adds a
  // first-class patchable handle for VIDEO OUT / BENTBOX / chain modules.
  outputs: [
    { id: 'out', type: 'video' },
  ],
  params: [],

  async factory(_ctx, _node): Promise<AudioDomainNodeHandle> {
    // ---- CV-stick analyser taps ----------------------------------------
    // Two AnalyserNodes (one per axis) read the latest sample at scheduler-
    // tick rate. Same fftSize:32 / smoothingTimeConstant:0 pattern as
    // FROGGER's gate taps — we only need the most-recent sample.
    function makeCvTap(): { node: AnalyserNode; read(): number } {
      const a = _ctx.createAnalyser();
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
    const stickXTap = makeCvTap();
    const stickYTap = makeCvTap();

    // ---- Gate taps + edge detectors ------------------------------------
    type GateId =
      | 'a_gate' | 'b_gate' | 'z_gate' | 'r_gate'
      | 'c_up_gate' | 'c_down_gate' | 'c_left_gate' | 'c_right_gate'
      | 'start_gate';
    const GATE_IDS: GateId[] = [
      'a_gate', 'b_gate', 'z_gate', 'r_gate',
      'c_up_gate', 'c_down_gate', 'c_left_gate', 'c_right_gate',
      'start_gate',
    ];
    const gateTaps = new Map<GateId, { node: AnalyserNode; read(): number }>();
    const edgeStates = new Map<GateId, EdgeState>();
    for (const id of GATE_IDS) {
      gateTaps.set(id, makeCvTap());
      edgeStates.set(id, makeEdgeState());
    }

    // ---- Per-tick state ------------------------------------------------
    // The "down" view = the EdgeState's `pressed` field (sticky between
    // rising / falling edges). The "pressed" view = an edge-event firing
    // THIS tick (cleared after one tick). FROGGER's pattern is gates-as-
    // rising-edges only; SM64 wants both because the upstream
    // playerInput struct exposes BOTH buttonDownX and buttonPressedX
    // (some game scripts check Pressed for one-shot actions like jump
    // chains).
    const downView = (id: GateId) => edgeStates.get(id)!.pressed;
    let pendingAutoStart = true;  // armed; consumed on first eligible tick

    let tickCount = 0;
    let lastInput: Sm64PlayerInput = composeSm64PlayerInput(0, 0, {
      downA: false, downB: false, downZ: false, downStart: false,
      downCl: false, downCr: false, downCu: false, downCd: false, downRt: false,
      pressedA: false, pressedB: false, pressedZ: false, pressedStart: false,
      pressedCl: false, pressedCr: false, pressedCu: false, pressedCd: false,
      pressedRt: false,
    });

    // ---- Video-out drawFrame (cross-domain audio→video bridge) ---------
    // The card exposes the bundle's #gameCanvas as
    // `window.__sm64.gameCanvas`. Each video frame the cross-domain
    // bridge invokes `drawFrame(target)` with its own canvas (sized to
    // the engine's video resolution); we paint the latest SM64 frame
    // into it via drawImage. This is a pure DOM-canvas → canvas blit —
    // no readback through CPU pixel buffers, so it's cheap.
    //
    // If the SM64 bundle hasn't loaded yet (bridge.gameCanvas is null),
    // the target stays whatever the bridge had — typically transparent
    // black, the same idle look as an unpatched VIDEO IN. We don't
    // proactively clear because clearing-each-frame would force the bridge
    // to upload an empty texture even when SM64 hasn't started, wasting
    // GPU bandwidth.
    //
    // We also re-use a dummy AnalyserNode to satisfy the videoSources
    // contract's `analyser` field (legacy GL-renderer path; not actually
    // read when drawFrame is set — see engine.ts AudioDomainNodeHandle
    // docs).
    const vidAnalyser = _ctx.createAnalyser();
    vidAnalyser.fftSize = 32;
    function drawFrame(target: OffscreenCanvas | HTMLCanvasElement): void {
      const w = globalThis as unknown as {
        __sm64?: { gameCanvas?: HTMLCanvasElement | null };
      };
      const src = w.__sm64?.gameCanvas;
      if (!src) return;
      const c2d = target.getContext('2d') as
        | CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
      if (!c2d) return;
      // Aspect-preserve: SM64 renders at the card's backing resolution
      // (typically 640×480 = 4:3). Letterbox into the target FBO so
      // patching SM64 → VIDEO OUT keeps Mario at the right aspect.
      const tw = target.width;
      const th = target.height;
      const sw = src.width;
      const sh = src.height;
      if (sw <= 0 || sh <= 0 || tw <= 0 || th <= 0) return;
      // Black-fill the letterbox bars first so a previous frame's content
      // (or the idle attract) doesn't bleed through.
      c2d.fillStyle = '#000';
      c2d.fillRect(0, 0, tw, th);
      const srcAspect = sw / sh;
      const dstAspect = tw / th;
      let drawW: number;
      let drawH: number;
      if (srcAspect > dstAspect) {
        // Source wider than target → fit width, letterbox top/bottom.
        drawW = tw;
        drawH = Math.round(tw / srcAspect);
      } else {
        // Source taller than target → fit height, letterbox left/right.
        drawH = th;
        drawW = Math.round(th * srcAspect);
      }
      const dx = Math.floor((tw - drawW) / 2);
      const dy = Math.floor((th - drawH) / 2);
      try {
        (c2d as CanvasRenderingContext2D).drawImage(src, 0, 0, sw, sh, dx, dy, drawW, drawH);
      } catch (_e) {
        // SecurityError / InvalidStateError if the source canvas is
        // tainted or detached. Swallow per-frame; the next paint will
        // either succeed or stay black.
      }
    }

    // ---- Scheduler tick subscription -----------------------------------
    const tick = () => {
      tickCount++;

      // Stick CV → ±64.
      const stickX = cvToStickValue(stickXTap.read());
      const stickY = cvToStickValue(stickYTap.read());

      // Gate CV → edges, in a stable order so tests are deterministic.
      const events = new Map<GateId, boolean>(); // true == pressed-this-tick (rising)
      for (const id of GATE_IDS) {
        const e = detectEdge(edgeStates.get(id)!, gateTaps.get(id)!.read());
        if (e && e.pressed) events.set(id, true);
      }

      // Synthetic start_gate auto-fire (BOOT NOTE — mirrors FROGGER).
      // Only fires when the bundle reports a ROM is present in IDB; the
      // card surfaces the upload UI otherwise and a no-op here is fine —
      // we re-arm pendingAutoStart so the first eligible tick after the
      // user finishes ROM-extraction still drives the synthetic press.
      if (pendingAutoStart) {
        const w = globalThis as unknown as { __sm64?: { romPresent?: boolean } };
        if (w.__sm64?.romPresent === true) {
          events.set('start_gate', true);
          pendingAutoStart = false;
        }
      }

      const btn: Sm64ButtonState = {
        downA: downView('a_gate'),
        downB: downView('b_gate'),
        downZ: downView('z_gate'),
        downStart: downView('start_gate'),
        downCl: downView('c_left_gate'),
        downCr: downView('c_right_gate'),
        downCu: downView('c_up_gate'),
        downCd: downView('c_down_gate'),
        downRt: downView('r_gate'),
        pressedA: !!events.get('a_gate'),
        pressedB: !!events.get('b_gate'),
        pressedZ: !!events.get('z_gate'),
        pressedStart: !!events.get('start_gate'),
        pressedCl: !!events.get('c_left_gate'),
        pressedCr: !!events.get('c_right_gate'),
        pressedCu: !!events.get('c_up_gate'),
        pressedCd: !!events.get('c_down_gate'),
        pressedRt: !!events.get('r_gate'),
      };

      const input = composeSm64PlayerInput(stickX, stickY, btn);
      lastInput = input;

      // Hand the input to the bundle. The card's bootstrap shim
      // (Sm64Card.svelte → installSm64Bridge) monkey-patches
      // playerInputUpdate to a no-op and writes window.playerInput at
      // tick rate from here; the bundle's produceOneFrame consumes it.
      const w = globalThis as unknown as {
        __sm64?: {
          setPlayerInput?: (input: Sm64PlayerInput) => void;
          produceOneFrame?: () => void;
          autoStart?: () => void;
          gameStarted?: boolean;
          autoStartedOnce?: boolean;
        };
      };
      const bridge = w.__sm64;
      if (bridge?.setPlayerInput) bridge.setPlayerInput(input);

      // start_gate rising edge → HTML #startbutton click (the bundle's
      // "Start Game" button that runs `startGame()` → `main_func()`).
      //
      // CRUCIAL: only fire the click EXACTLY ONCE — for the boot transition
      // out of "Drop ROM" / loading state into the title screen. After that
      // the bundle's `gameStarted` is true and ANY subsequent #startbutton
      // click triggers `location.reload()` (the bundle's hard-coded handler).
      //
      // The Mario "Press Start" semantic (advance title-demo → file-select,
      // pause, etc.) is handled by `playerInput.buttonPressedStart` above
      // (composed in `btn.pressedStart` and written via
      // `bridge.setPlayerInput`). The bundle's `intro_regular` + every
      // other in-game Start check reads that flag directly, so a user's
      // patched START gate edge advances the title via the player-input
      // pipeline — we MUST NOT re-fire the click for it (that would
      // location.reload() the entire app).
      //
      // The previous PR-#424 guard was `bridge.gameStarted !== true`, which
      // ALSO ended up gating off post-boot START edges entirely (PR #413's
      // synthetic boot autoStart set `gameStarted = true`, so a user's
      // first manual Start edge passed the guard incorrectly → click →
      // reload). The fix is a separate one-shot flag `autoStartedOnce`
      // that ONLY the boot autoStart toggles. `gameStarted` is now purely
      // a status mirror for the UI snapshot.
      if (
        events.get('start_gate')
        && bridge?.autoStart
        && bridge.autoStartedOnce !== true
      ) {
        bridge.autoStart();
      }

      // Step the engine one frame.
      if (bridge?.produceOneFrame) {
        try { bridge.produceOneFrame(); } catch (_e) { /* engine errors are non-fatal here; the card surfaces them via the bridge */ }
      }
    };
    const unsubscribe = getSchedulerClock().subscribe(tick);

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['stick_x_cv',   { node: stickXTap.node, input: 0 }],
        ['stick_y_cv',   { node: stickYTap.node, input: 0 }],
        ...GATE_IDS.map((id) => [
          id,
          { node: gateTaps.get(id)!.node, input: 0 },
        ] as [string, { node: AudioNode; input: number }]),
      ]),
      outputs: new Map(),
      // Cross-domain audio→video bridge entry for the `out` port. The
      // video engine calls drawFrame(canvas) each video frame; we paint
      // the bundle's #gameCanvas into it (see drawFrame above). The
      // analyser field is the legacy GL-renderer requirement (ignored
      // when drawFrame is set, per AudioDomainNodeHandle.videoSources docs).
      videoSources: new Map([
        ['out', { analyser: vidAnalyser, sampleRate: _ctx.sampleRate, drawFrame }],
      ]),
      setParam(_paramId, _value) { /* no params */ },
      readParam(_paramId) { return undefined; },
      read(key) {
        if (key === 'snapshot') {
          const w = globalThis as unknown as {
            __sm64?: { romPresent?: boolean; gameStarted?: boolean };
          };
          const snap: Sm64Snapshot = {
            tick: tickCount,
            romPresent: !!w.__sm64?.romPresent,
            gameStarted: !!w.__sm64?.gameStarted,
            lastInput,
          };
          return snap;
        }
        return undefined;
      },
      dispose() {
        unsubscribe();
        stickXTap.node.disconnect();
        stickYTap.node.disconnect();
        for (const t of gateTaps.values()) t.node.disconnect();
        try { vidAnalyser.disconnect(); } catch { /* */ }
      },
    };
  },
};
