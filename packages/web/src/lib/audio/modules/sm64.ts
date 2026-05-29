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
// No outputs. The card canvas is `data-viz-passthrough` so a containing
// GROUP can portal it across-domain — the standard FROGGER/MODTRIS/PONG/
// SCOPE mechanism. No dedicated video_out port; no audio port (upstream's
// audio is stub-only — TODO in src/index.js → "Audio TODO"; matches
// FROGGER's no-audio profile).
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
// Outputs: none (game is the output — render lives in the card).
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
  // No outputs — see the file-header rationale (vizPassthrough handles the
  // cross-domain video bridge for the card canvas; no audio in v1).
  outputs: [],
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
        };
      };
      const bridge = w.__sm64;
      if (bridge?.setPlayerInput) bridge.setPlayerInput(input);

      // start_gate rising edge → HTML #startbutton click (the bundle's
      // "Start Game" button that runs `startGame()` → `main_func()`).
      //
      // CRUCIAL: only fire this when the bundle hasn't started yet.
      // Upstream's click handler is:
      //   document.getElementById("startbutton").addEventListener('click',
      //     () => { if (gameStarted) { location.reload() } else { startGame() } })
      // Once `gameStarted` (the bundle's internal flag, set by startGame())
      // is true, ANY subsequent click triggers `location.reload()` — which
      // in our embedded card context reloads the entire patchtogether app,
      // appearing to the user as an instant crash on the title-screen →
      // gameplay transition (the user fires START to advance the title,
      // the synthetic click fires location.reload() instead → page dies).
      //
      // The Mario "Press Start" semantic (advance from title, pause, etc.)
      // is handled by `playerInput.buttonPressedStart` above (composed in
      // `btn.pressedStart` and written via `bridge.setPlayerInput`). The
      // bundle's `intro_regular` + every other in-game Start check reads
      // that flag directly, so the N64-Start path stays fully wired
      // without us ever needing to re-fire the HTML button after the first
      // boot.
      if (
        events.get('start_gate')
        && bridge?.autoStart
        && bridge.gameStarted !== true
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
      },
    };
  },
};
