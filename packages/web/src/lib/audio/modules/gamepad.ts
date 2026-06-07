// packages/web/src/lib/audio/modules/gamepad.ts
//
// GAMEPAD — connected USB/Bluetooth game controller as a CV/gate
// source. Reads navigator.getGamepads() in the main thread at ~60Hz
// and pushes the stick axes, triggers, and button states into a
// per-port ConstantSourceNode (CV / gate).
//
// Target controller: standard Gamepad-API mapping (Xbox One / Series
// / 360 over USB or Bluetooth, PlayStation 4/5 DualShock, generic
// HID gamepads that report the standard layout). Browsers map all of
// these to the same axis/button indices when `mapping === 'standard'`.
//
// Browser security: the Gamepad API only exposes a controller AFTER
// the user has pressed a button on it (a "gesture" gate to prevent
// fingerprinting). The card surfaces a "press any button on your
// gamepad" prompt until navigator.getGamepads() returns a non-null
// pad.
//
// Outputs (18 total — mirrors the full Xbox standard layout so the
// user doesn't have to spawn more modules for non-stick controls):
//
//   sticks (cv, ±1 with 0.08 deadzone, Y inverted so +1 = up):
//     lx, ly, rx, ry
//   triggers (cv, 0..+1):
//     lt, rt
//   bumpers + face (gate, 0 or 1):
//     lb, rb, a, b, x, y
//   d-pad (gate):
//     du, dd, dl, dr
//   menu (gate):
//     start, back
//
// Reading other-than-the-first controller is deferred — the
// `padIndex` param is exposed so the card / a future picker UI can
// select the gamepad slot (0..3); v1 only auto-selects slot 0 of
// whichever was most-recently connected.
//
// Inputs: none.
//
// Outputs:
//   lx / ly / rx / ry (cv): left / right stick X-Y (-1..+1).
//   lt / rt (cv): left / right trigger (0..1).
//   lb / rb (gate): left / right bumper.
//   a / b / x / y (gate): face buttons.
//   du / dd / dl / dr (gate): D-pad up / down / left / right.
//   start / back (gate): the standard start + back/select buttons.
//
// Params:
//   padIndex (discrete 0..3, default 0): gamepad slot picker (multi-controller setups).

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';

/** Stick deadzone. Xbox sticks (especially older ones) have notable
 *  drift; 0.08 swallows that without losing much usable range. After
 *  the deadzone we re-normalize so values just outside dz start at
 *  0 (not at dz). */
export const STICK_DEADZONE = 0.08;

/** Pure helper — apply deadzone + re-normalize a raw axis sample. */
export function applyDeadzone(raw: number, dz = STICK_DEADZONE): number {
  if (!Number.isFinite(raw)) return 0;
  const v = Math.max(-1, Math.min(1, raw));
  const abs = Math.abs(v);
  if (abs < dz) return 0;
  return Math.sign(v) * ((abs - dz) / (1 - dz));
}

/** Pure helper — clamp + binary-threshold a value into a {0,1} gate
 *  level. Used for the trigger-as-CV path (lt/rt return the smooth
 *  0..1 value) but ALSO available so card unit tests can pin the
 *  decision boundary if a future revision exposes the trigger as a
 *  gate (e.g. lt_gate). */
export function triggerToCv(raw: number): number {
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(1, raw));
}

/** Output ports in display order. Stick axes first (most-used), then
 *  triggers, then buttons. */
const OUTPUT_DEFS = [
  { id: 'lx',    type: 'cv'   as const, label: 'L-X' },
  { id: 'ly',    type: 'cv'   as const, label: 'L-Y' },
  { id: 'rx',    type: 'cv'   as const, label: 'R-X' },
  { id: 'ry',    type: 'cv'   as const, label: 'R-Y' },
  { id: 'lt',    type: 'cv'   as const, label: 'LT'  },
  { id: 'rt',    type: 'cv'   as const, label: 'RT'  },
  { id: 'lb',    type: 'gate' as const, label: 'LB'  },
  { id: 'rb',    type: 'gate' as const, label: 'RB'  },
  { id: 'a',     type: 'gate' as const, label: 'A'   },
  { id: 'b',     type: 'gate' as const, label: 'B'   },
  { id: 'x',     type: 'gate' as const, label: 'X'   },
  { id: 'y',     type: 'gate' as const, label: 'Y'   },
  { id: 'du',    type: 'gate' as const, label: '⬆'  },
  { id: 'dd',    type: 'gate' as const, label: '⬇'  },
  { id: 'dl',    type: 'gate' as const, label: '⬅'  },
  // U+2B95 (⮕) matches the U+2B05/06/07 family used for ⬅⬆⬇ —
  // U+27A1 (➡) is a different glyph family that renders much smaller
  // in most fonts, making the right-d-pad row look broken/portless.
  { id: 'dr',    type: 'gate' as const, label: '⮕'  },
  { id: 'start', type: 'gate' as const, label: 'STA' },
  { id: 'back',  type: 'gate' as const, label: 'SEL' },
] as const;

/** Indexes into the standard Gamepad mapping. Source:
 *  https://www.w3.org/TR/gamepad/#remapping
 *  Axes order: 0=lx, 1=ly, 2=rx, 3=ry (Y is +down per spec — we
 *  invert in the read loop so +1=up matches Eurorack/joystick
 *  convention).
 *  Buttons order: 0=A, 1=B, 2=X, 3=Y, 4=LB, 5=RB, 6=LT, 7=RT, 8=back,
 *  9=start, 10=ls, 11=rs, 12=du, 13=dd, 14=dl, 15=dr, 16=home. */
const STD_BTN = {
  a: 0, b: 1, x: 2, y: 3,
  lb: 4, rb: 5,
  lt: 6, rt: 7,
  back: 8, start: 9,
  du: 12, dd: 13, dl: 14, dr: 15,
} as const;

/** Public per-port snapshot — used by the card's live indicator
 *  display. Distinct from the engine's read('snapshot') so the card
 *  can poll cheaply without going through the AnalyserNode path. */
export interface GamepadSnapshot {
  /** Whether navigator.getGamepads() returned a populated pad on the
   *  most recent poll. */
  connected: boolean;
  /** Identifier reported by the OS (e.g. "Xbox Wireless Controller"). */
  id: string;
  /** Live values per output port. */
  values: Record<string, number>;
}

export const gamepadDef: AudioModuleDef = {
  type: 'gamepad',
  palette: { top: 'Audio modules', sub: 'I/O' },
  domain: 'audio',
  label: 'gamepad',
  category: 'utility',
  schemaVersion: 1,
  inputs: [],
  // Inlined as literal array (not derived from OUTPUT_DEFS via .map)
  // so the docs manifest extractor in module-manifest.ts can read
  // them — it doesn't follow expressions. Keep in lockstep with
  // OUTPUT_DEFS below; the gamepad.test.ts asserts 1:1 parity.
  outputs: [
    { id: 'lx',    type: 'cv' },
    { id: 'ly',    type: 'cv' },
    { id: 'rx',    type: 'cv' },
    { id: 'ry',    type: 'cv' },
    { id: 'lt',    type: 'cv' },
    { id: 'rt',    type: 'cv' },
    { id: 'lb',    type: 'gate' },
    { id: 'rb',    type: 'gate' },
    { id: 'a',     type: 'gate' },
    { id: 'b',     type: 'gate' },
    { id: 'x',     type: 'gate' },
    { id: 'y',     type: 'gate' },
    { id: 'du',    type: 'gate' },
    { id: 'dd',    type: 'gate' },
    { id: 'dl',    type: 'gate' },
    { id: 'dr',    type: 'gate' },
    { id: 'start', type: 'gate' },
    { id: 'back',  type: 'gate' },
  ],
  params: [
    // Which slot of navigator.getGamepads() to read. 0..3 (Web spec
    // caps at 4 simultaneous pads). Default 0 = "first connected".
    { id: 'padIndex', label: 'Slot', defaultValue: 0, min: 0, max: 3, curve: 'discrete' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    // ConstantSourceNode per output. setValueAtTime() writes happen
    // on the main thread from the poll loop below; the engine layer
    // sees them like any other CV source.
    const sources: Record<string, ConstantSourceNode> = {};
    for (const o of OUTPUT_DEFS) {
      const c = ctx.createConstantSource();
      c.offset.setValueAtTime(0, ctx.currentTime);
      c.start();
      sources[o.id] = c;
    }

    // Per-tick mutable snapshot the card polls. We never re-allocate
    // the inner record — just mutate values, so a hot poll path
    // doesn't churn GC.
    const snapshot: GamepadSnapshot = {
      connected: false,
      id: '',
      values: Object.fromEntries(OUTPUT_DEFS.map((o) => [o.id, 0])),
    };

    function readPadIndex(): number {
      const v = (node.params ?? {}).padIndex;
      const n = typeof v === 'number' ? Math.round(v) : 0;
      return Math.max(0, Math.min(3, n));
    }

    /** Read the active gamepad's state + push to all sources. Skipped
     *  cleanly in environments without the Gamepad API (node tests). */
    function pollPad(): void {
      // navigator.getGamepads() is on the main-thread `navigator` —
      // this poll function runs in the AudioContext-host page, so the
      // API is available in normal browser use. We guard for non-
      // browser environments (vitest) so the factory stays callable
      // there.
      if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') {
        return;
      }
      const pads = navigator.getGamepads();
      const slot = readPadIndex();
      const pad = pads ? pads[slot] : null;
      if (!pad) {
        if (snapshot.connected) {
          // Just disconnected — zero all outputs so a downstream VCA
          // doesn't latch the last value.
          snapshot.connected = false;
          snapshot.id = '';
          for (const o of OUTPUT_DEFS) {
            sources[o.id]!.offset.setValueAtTime(0, ctx.currentTime);
            snapshot.values[o.id] = 0;
          }
        }
        return;
      }

      snapshot.connected = true;
      snapshot.id = pad.id;

      // Axes — apply deadzone, invert Y so +1 = stick UP.
      const lx = applyDeadzone(pad.axes[0] ?? 0);
      const ly = -applyDeadzone(pad.axes[1] ?? 0);
      const rx = applyDeadzone(pad.axes[2] ?? 0);
      const ry = -applyDeadzone(pad.axes[3] ?? 0);
      // Triggers — pad.buttons[6/7].value gives the smooth 0..1
      // position (NOT just the binary `pressed`).
      const ltBtn = pad.buttons[STD_BTN.lt];
      const rtBtn = pad.buttons[STD_BTN.rt];
      const lt = triggerToCv(ltBtn?.value ?? 0);
      const rt = triggerToCv(rtBtn?.value ?? 0);

      const next: Record<string, number> = {
        lx, ly, rx, ry, lt, rt,
        lb: pad.buttons[STD_BTN.lb]?.pressed ? 1 : 0,
        rb: pad.buttons[STD_BTN.rb]?.pressed ? 1 : 0,
        a:  pad.buttons[STD_BTN.a]?.pressed  ? 1 : 0,
        b:  pad.buttons[STD_BTN.b]?.pressed  ? 1 : 0,
        x:  pad.buttons[STD_BTN.x]?.pressed  ? 1 : 0,
        y:  pad.buttons[STD_BTN.y]?.pressed  ? 1 : 0,
        du: pad.buttons[STD_BTN.du]?.pressed ? 1 : 0,
        dd: pad.buttons[STD_BTN.dd]?.pressed ? 1 : 0,
        dl: pad.buttons[STD_BTN.dl]?.pressed ? 1 : 0,
        dr: pad.buttons[STD_BTN.dr]?.pressed ? 1 : 0,
        start: pad.buttons[STD_BTN.start]?.pressed ? 1 : 0,
        back:  pad.buttons[STD_BTN.back]?.pressed  ? 1 : 0,
      };

      // Push only on change to keep the audio thread's param queue
      // shallow. The if-changed compare against the cached snapshot
      // also lets the card's render loop diff cheaply.
      for (const o of OUTPUT_DEFS) {
        const v = next[o.id]!;
        if (v !== snapshot.values[o.id]) {
          sources[o.id]!.offset.setValueAtTime(v, ctx.currentTime);
          snapshot.values[o.id] = v;
        }
      }
    }

    // rAF-driven poll. requestAnimationFrame is suspended when the tab
    // is backgrounded — that's the right behaviour (no point burning
    // CPU updating gamepad state nobody can see). The Audio worklet
    // continues to receive the last-pushed values, so when the user
    // returns the rack picks up where they left off.
    let rafId: number | null = null;
    let alive = true;
    function loop(): void {
      if (!alive) return;
      try { pollPad(); } catch { /* defensive — never crash the audio */ }
      rafId = (typeof requestAnimationFrame === 'function')
        ? requestAnimationFrame(loop)
        : null;
    }
    if (typeof requestAnimationFrame === 'function') {
      rafId = requestAnimationFrame(loop);
    }

    // The browser fires gamepadconnected the first time a button is
    // pressed on a not-yet-detected pad. We don't need to listen
    // here (the rAF poll will pick it up the next frame), but the
    // event is exposed via read('snapshot') anyway so the card can
    // show a connect indicator without polling.

    const outputs = new Map<string, { node: AudioNode; output: number }>();
    for (const o of OUTPUT_DEFS) {
      outputs.set(o.id, { node: sources[o.id]!, output: 0 });
    }

    return {
      domain: 'audio',
      inputs: new Map(),
      outputs,
      setParam(_paramId, _value) {
        // padIndex is read live in pollPad — no per-call write needed.
      },
      readParam(paramId) {
        if (paramId === 'padIndex') return readPadIndex();
        // Live per-port snapshot — same value the ConstantSource is
        // currently emitting. Useful for engine.read(node, 'live'),
        // headless tests, and motorized-fader displays.
        if (paramId in snapshot.values) return snapshot.values[paramId];
        return undefined;
      },
      read(key) {
        if (key === 'snapshot') return { ...snapshot, values: { ...snapshot.values } };
        return undefined;
      },
      dispose() {
        alive = false;
        if (rafId !== null && typeof cancelAnimationFrame === 'function') {
          cancelAnimationFrame(rafId);
        }
        for (const o of OUTPUT_DEFS) {
          try { sources[o.id]!.stop(); } catch { /* */ }
          try { sources[o.id]!.disconnect(); } catch { /* */ }
        }
      },
    };
  },
};

/** Re-export for the card. */
export const GAMEPAD_OUTPUTS = OUTPUT_DEFS;
