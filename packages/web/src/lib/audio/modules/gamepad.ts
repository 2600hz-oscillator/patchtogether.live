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
import { patch as livePatch } from '$lib/graph/store';

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

// ---------------------------------------------------------------------------
// LEFT-STICK CALIBRATION (Gladiator NXT support — first deliverable)
//
// Prior art (analog-stick calibration; min/max normalization + deadzone):
//   * Per-axis min/max capture: the user sweeps the stick through its full
//     range; we record observed (min,max) per axis. observed-min → full-min,
//     observed-max → full-max. This is the classic SDL/evdev/DS4Windows
//     calibration: a worn or non-Xbox stick (e.g. a VKB flight stick) rarely
//     reaches a clean ±1 nor centres at 0, so a fixed mapping wastes range and
//     drifts off-centre. (See SDL_GameControllerDB / Linux evdev-joystick.)
//   * CENTER from the calibrated range midpoint, not assumed 0 — accounts for a
//     "loose centre" (a Hall stick centres ~0.002, a worn stick ~0.045).
//   * RADIAL deadzone around the calibrated centre (the modern-game standard —
//     CoD/Apex) so diagonal noise inside the circle reads 0; we ALSO keep a tiny
//     per-axis guard for sticks with uneven X/Y noise. This avoids snap-back
//     "stick drift" producing phantom CV at rest.
//   * OUTER deadzone (saturation): anything past the calibrated max pins to ±1.
//
// The calibrated result is a small plain record persisted ONCE to
// node.data.leftStickCalibration on "complete calibration" (NEVER written per
// frame — a per-frame Y.Doc write is the render/update-storm bug class). The
// factory reads it on its rAF poll and applies `applyCalibration` to lx/ly in
// place of the fixed `applyDeadzone`.
// ---------------------------------------------------------------------------

/** Default radial deadzone (fraction of the calibrated half-range) applied
 *  around the calibrated centre. 0.10 sits in the "typical" 0.05–0.12 band
 *  that masks light electrical noise without a noticeable dead spot. */
export const CALIBRATION_DEADZONE = 0.1;

/** Persisted left-stick calibration. Lives on `node.data.leftStickCalibration`
 *  (rides the Y.Doc to rack-mates). All fields raw-axis units (the Gamepad API
 *  reports ≈[-1,+1], but a real stick's *observed* extremes are usually inside
 *  that — that's the whole point of calibrating). */
export interface StickCalibration {
  /** Observed raw min/max per axis (axes[0] = X, axes[1] = Y, raw spec frame:
   *  +X = right, +Y = down). */
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  /** Radial deadzone as a fraction (0..1) of the calibrated half-range. */
  deadzone: number;
}

/** Live min/max accumulator the card mutates each frame during calibration
 *  MODE (transient render state — NOT synced; only the FINAL record is). */
export interface CalibrationSweep {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  /** Number of samples folded in — used to gate "complete" until the user has
   *  actually swept (a single frame can't define a range). */
  samples: number;
}

/** A fresh sweep accumulator. min seeded to +Inf / max to -Inf so the first
 *  finite sample sets both. */
export function newCalibrationSweep(): CalibrationSweep {
  return { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, samples: 0 };
}

/** Fold one raw (x,y) sample into the sweep, IN PLACE. Non-finite samples are
 *  ignored (a disconnected pad reports nothing useful). Returns the sweep for
 *  chaining/readability. */
export function recordCalibrationSample(
  sweep: CalibrationSweep,
  rawX: number,
  rawY: number,
): CalibrationSweep {
  if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) return sweep;
  // Clamp to the spec's legal axis range so a glitchy >|1| sample can't blow
  // the calibrated range out past full deflection.
  const x = Math.max(-1, Math.min(1, rawX));
  const y = Math.max(-1, Math.min(1, rawY));
  if (x < sweep.minX) sweep.minX = x;
  if (x > sweep.maxX) sweep.maxX = x;
  if (y < sweep.minY) sweep.minY = y;
  if (y > sweep.maxY) sweep.maxY = y;
  sweep.samples++;
  return sweep;
}

/** True once the sweep has captured a usable range on BOTH axes (a non-trivial
 *  span + at least a handful of samples). Gates the "complete calibration"
 *  button so a user can't lock in a degenerate (min==max → divide-by-zero)
 *  calibration. */
export function sweepIsUsable(sweep: CalibrationSweep, minSpan = 0.2): boolean {
  if (sweep.samples < 3) return false;
  if (!Number.isFinite(sweep.minX) || !Number.isFinite(sweep.maxX)) return false;
  if (!Number.isFinite(sweep.minY) || !Number.isFinite(sweep.maxY)) return false;
  return sweep.maxX - sweep.minX >= minSpan && sweep.maxY - sweep.minY >= minSpan;
}

/** Lock a completed sweep into a persisted StickCalibration. Pure — the caller
 *  writes the result to node.data ONCE. `deadzone` defaults to
 *  CALIBRATION_DEADZONE. Returns null when the sweep isn't usable (caller keeps
 *  the prior calibration). */
export function finalizeCalibration(
  sweep: CalibrationSweep,
  deadzone = CALIBRATION_DEADZONE,
): StickCalibration | null {
  if (!sweepIsUsable(sweep)) return null;
  return {
    minX: sweep.minX,
    maxX: sweep.maxX,
    minY: sweep.minY,
    maxY: sweep.maxY,
    deadzone: Math.max(0, Math.min(0.9, deadzone)),
  };
}

/** Normalize ONE raw axis sample against its calibrated [min,max] so
 *  observed-min → -1, observed-centre → 0, observed-max → +1, with a
 *  per-axis-half deadzone re-normalized so values just outside the dz start
 *  near 0 (no jump). Outer saturation: past the calibrated extreme pins to ±1.
 *  Pure; used by both axes (the radial guard is applied on top in
 *  applyCalibration). */
export function normalizeAxis(
  raw: number,
  min: number,
  max: number,
  dz = CALIBRATION_DEADZONE,
): number {
  if (!Number.isFinite(raw) || !Number.isFinite(min) || !Number.isFinite(max)) return 0;
  const span = max - min;
  if (span <= 1e-6) return 0; // degenerate calibration → neutral, never NaN
  const center = (min + max) / 2;
  // Map to [-1,+1] about the calibrated centre, using each side's own
  // half-span so an asymmetric stick still reaches ±1 on both ends.
  const halfPos = max - center;
  const halfNeg = center - min;
  const v = Math.max(-1, Math.min(1, raw));
  let n: number;
  if (v >= center) {
    n = halfPos > 1e-6 ? (v - center) / halfPos : 0;
  } else {
    n = halfNeg > 1e-6 ? (v - center) / halfNeg : 0;
  }
  n = Math.max(-1, Math.min(1, n));
  // Per-axis deadzone + renormalize (same shape as applyDeadzone).
  const abs = Math.abs(n);
  if (abs < dz) return 0;
  return Math.sign(n) * ((abs - dz) / (1 - dz));
}

/** Apply a full StickCalibration to a raw (x,y) pair, returning the normalized
 *  pair. A RADIAL deadzone is applied first (magnitude < dz of the unit circle
 *  → both axes 0) so diagonal rest-noise can't leak through the per-axis
 *  guards; then each axis is normalized + per-axis deadzoned. When `cal` is
 *  absent the caller should fall back to applyDeadzone (the un-calibrated
 *  path). Returns {x, y} in the raw (un-inverted) frame — the read loop still
 *  inverts Y so +1 = stick up. */
export function applyCalibration(
  rawX: number,
  rawY: number,
  cal: StickCalibration,
): { x: number; y: number } {
  const dz = Number.isFinite(cal.deadzone) ? Math.max(0, Math.min(0.9, cal.deadzone)) : CALIBRATION_DEADZONE;
  // First normalize WITHOUT a per-axis deadzone so we can measure the true
  // radial magnitude, then apply the radial gate, then the per-axis dz.
  const nx = normalizeAxis(rawX, cal.minX, cal.maxX, 0);
  const ny = normalizeAxis(rawY, cal.minY, cal.maxY, 0);
  const mag = Math.hypot(nx, ny);
  if (mag < dz) return { x: 0, y: 0 };
  // Radial re-normalize: scale so magnitude `dz` maps to 0 and 1 stays 1,
  // preserving the direction (the modern radial-deadzone formula).
  const scaled = (mag - dz) / (1 - dz);
  const k = mag > 1e-6 ? scaled / mag : 0;
  return {
    x: Math.max(-1, Math.min(1, nx * k)),
    y: Math.max(-1, Math.min(1, ny * k)),
  };
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

// ---------------------------------------------------------------------------
// CONTROL-REMAP DETECTION (broad button/control support — feasibility core).
//
// The Gamepad API has NO events — you can only POLL navigator.getGamepads()
// each frame. So a "remap"/"learn" affordance (right-click a UI element → arm
// "listening" → press/move the physical control you want bound) can't wait on
// an event; it must DIFF consecutive polled snapshots and pick the control that
// moved the most. This is the same arm-then-detect UX as MIDI-learn, minus the
// event — implemented as a pure diff so it's unit-testable hardware-free.
//
// `detectChangedControl` is that pure primitive: given a previous + current raw
// Gamepad reading, it returns the single physical control (an axis index or a
// button index) whose change exceeds a threshold, ranked by magnitude — exactly
// what an armed "press the control to bind" listener consumes. The card-side
// binding store + per-output UI is the follow-up slice (see the PR body); this
// ships the tested detection core the rest builds on.
// ---------------------------------------------------------------------------

/** A physical control on a gamepad: one analog axis, or one button. */
export type PhysicalControl =
  | { kind: 'axis'; index: number }
  | { kind: 'button'; index: number };

/** The minimal raw reading the detector diffs — a subset of the W3C Gamepad. */
export interface RawGamepadReading {
  axes: readonly number[];
  buttons: readonly { value: number; pressed: boolean }[];
}

/** Default movement thresholds for "this control changed enough to be the one
 *  the user is trying to bind". Axes need a big sweep (so resting drift / an
 *  un-calibrated centre doesn't capture); buttons a clear press. */
export const REMAP_AXIS_THRESHOLD = 0.5;
export const REMAP_BUTTON_THRESHOLD = 0.5;

/**
 * Pure detector for an armed remap listener: compare a previous and current raw
 * reading and return the SINGLE control that changed the most past the
 * thresholds, or null if nothing moved enough. Axes rank by absolute delta;
 * buttons by absolute value-delta. The largest-magnitude change across both
 * wins so a deliberate full-deflection / firm press is picked over incidental
 * jitter on another control. `prev === null` (first poll after arming) returns
 * null — we need a baseline to diff against.
 *
 * `opts.only` restricts detection to ONE control family — the two remap entry
 * points need different filters and the unified detector serves both:
 *   - a button/control right-click arms with `only: 'button'` so a resting
 *     stick wobble can't capture the bind,
 *   - the explicit "Remap X" / "Remap Y" buttons arm with `only: 'axis'` so the
 *     next AXIS the user moves is bound (a button press is ignored).
 * Default `'any'` ranks both families together (the original behaviour).
 */
export function detectChangedControl(
  prev: RawGamepadReading | null,
  cur: RawGamepadReading,
  opts: { axisThreshold?: number; buttonThreshold?: number; only?: 'axis' | 'button' | 'any' } = {},
): PhysicalControl | null {
  if (!prev) return null;
  const axisTh = opts.axisThreshold ?? REMAP_AXIS_THRESHOLD;
  const btnTh = opts.buttonThreshold ?? REMAP_BUTTON_THRESHOLD;
  const only = opts.only ?? 'any';
  let best: PhysicalControl | null = null;
  let bestMag = 0;
  if (only !== 'button') {
    const nAxes = Math.min(prev.axes.length, cur.axes.length);
    for (let i = 0; i < nAxes; i++) {
      const a = cur.axes[i];
      const b = prev.axes[i];
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      const d = Math.abs(a! - b!);
      if (d >= axisTh && d > bestMag) {
        bestMag = d;
        best = { kind: 'axis', index: i };
      }
    }
  }
  if (only !== 'axis') {
    const nBtns = Math.min(prev.buttons.length, cur.buttons.length);
    for (let i = 0; i < nBtns; i++) {
      const a = cur.buttons[i]?.value ?? 0;
      const b = prev.buttons[i]?.value ?? 0;
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      const d = Math.abs(a - b);
      if (d >= btnTh && d > bestMag) {
        bestMag = d;
        best = { kind: 'button', index: i };
      }
    }
  }
  return best;
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

/** Standard-mapping axis indices. */
const STD_AXIS = { lx: 0, ly: 1, rx: 2, ry: 3 } as const;

// ---------------------------------------------------------------------------
// CONTROL REMAP — per-output physical-control bindings.
//
// Each output port (lx, a, du, …) is driven by ONE physical control (an axis or
// a button) on the gamepad. By default that's the standard-mapping control of
// the same name; a "remap" overrides it so e.g. the `a` output can be driven by
// the user's physical X button, or the `lx` output by the right-stick X axis.
//
// The binding is the SINGLE source of truth the read loop consults for every
// output, so a remap takes effect the next frame and survives reload/collab.
// Bindings live on `node.data.bindings` (a single in-place Y.Doc key). Absent /
// invalid → the default control for that output. Pure helpers below so the card
// is a thin arm-and-render shell.
// ---------------------------------------------------------------------------

/** Per-output remap overrides. Key = output port id; value = the physical
 *  control that drives it. An output absent here uses its DEFAULT control. */
export type RemapBindings = Record<string, PhysicalControl>;

/** Default physical control for each output id — the standard-mapping control
 *  of the same name. CV-axis outputs map to an axis; everything else (triggers,
 *  bumpers, face, d-pad, menu) to a button. */
export const DEFAULT_GAMEPAD_BINDINGS: Readonly<RemapBindings> = {
  lx: { kind: 'axis', index: STD_AXIS.lx },
  ly: { kind: 'axis', index: STD_AXIS.ly },
  rx: { kind: 'axis', index: STD_AXIS.rx },
  ry: { kind: 'axis', index: STD_AXIS.ry },
  lt: { kind: 'button', index: STD_BTN.lt },
  rt: { kind: 'button', index: STD_BTN.rt },
  lb: { kind: 'button', index: STD_BTN.lb },
  rb: { kind: 'button', index: STD_BTN.rb },
  a:  { kind: 'button', index: STD_BTN.a },
  b:  { kind: 'button', index: STD_BTN.b },
  x:  { kind: 'button', index: STD_BTN.x },
  y:  { kind: 'button', index: STD_BTN.y },
  du: { kind: 'button', index: STD_BTN.du },
  dd: { kind: 'button', index: STD_BTN.dd },
  dl: { kind: 'button', index: STD_BTN.dl },
  dr: { kind: 'button', index: STD_BTN.dr },
  start: { kind: 'button', index: STD_BTN.start },
  back:  { kind: 'button', index: STD_BTN.back },
} as const;

/** True for a structurally valid PhysicalControl (finite non-negative integer
 *  index, known kind). Guards a corrupt/foreign node.data entry from the read
 *  loop. */
export function isPhysicalControl(c: unknown): c is PhysicalControl {
  if (!c || typeof c !== 'object') return false;
  const o = c as { kind?: unknown; index?: unknown };
  if (o.kind !== 'axis' && o.kind !== 'button') return false;
  return typeof o.index === 'number' && Number.isInteger(o.index) && o.index >= 0;
}

/** Resolve the physical control that drives `outputId`: the remap override when
 *  present + valid, else the default. Returns undefined for an unknown output.
 *  Pure — the read loop calls this per output per frame. */
export function bindingForOutput(
  outputId: string,
  bindings: RemapBindings | undefined,
): PhysicalControl | undefined {
  const override = bindings?.[outputId];
  if (isPhysicalControl(override)) return override;
  return DEFAULT_GAMEPAD_BINDINGS[outputId];
}

/** Read a physical control's raw value off a gamepad reading. Axis → the raw
 *  axis sample ([-1,1], un-deadzoned, un-inverted); button → its 0..1 analog
 *  value. Out-of-range / non-finite → 0. The caller applies the per-output
 *  shaping (deadzone / Y-invert / pressed-threshold). Pure. */
export function readControlValue(
  reading: RawGamepadReading,
  control: PhysicalControl,
): number {
  if (control.kind === 'axis') {
    const v = reading.axes[control.index];
    return Number.isFinite(v) ? (v as number) : 0;
  }
  const v = reading.buttons[control.index]?.value;
  return Number.isFinite(v) ? (v as number) : 0;
}

/** Short human label for a physical control, used by the card's "remapped"
 *  badge. Known standard-mapping indices get their canonical name (e.g.
 *  axis 2 → "R-X axis", button 0 → "A btn"); anything else falls back to the
 *  raw index. Pure. */
export function describeControl(control: PhysicalControl): string {
  if (control.kind === 'axis') {
    const named = (Object.keys(STD_AXIS) as (keyof typeof STD_AXIS)[]).find(
      (k) => STD_AXIS[k] === control.index,
    );
    const labels: Record<string, string> = { lx: 'L-X', ly: 'L-Y', rx: 'R-X', ry: 'R-Y' };
    return named ? `${labels[named]} axis` : `axis ${control.index}`;
  }
  const named = (Object.keys(STD_BTN) as (keyof typeof STD_BTN)[]).find(
    (k) => STD_BTN[k] === control.index,
  );
  return named ? `${named.toUpperCase()} btn` : `btn ${control.index}`;
}

/** Produce a new RemapBindings with `outputId` bound to `control`, leaving all
 *  other outputs untouched. When `control` equals the DEFAULT for that output
 *  the override is DROPPED (so a "remap back to default" reverts to the absent /
 *  back-compat state rather than persisting a redundant entry). Pure — the card
 *  passes the result into a single in-place node.data mutation.
 *
 *  Returns FRESH plain `{kind,index}` objects for every entry — it never reuses
 *  a value object from the input `bindings` (which, when called with the live
 *  SyncedStore proxy, would be an already-integrated Y type). That guarantee is
 *  what makes the in-place commit (`applyBindingToData`) safe: re-assigning an
 *  already-tree-resident Y object throws "reassigning object that already occurs
 *  in the tree" — the bug that killed the gamepad output after a 2nd remap. */
export function setBinding(
  bindings: RemapBindings | undefined,
  outputId: string,
  control: PhysicalControl,
): RemapBindings {
  const next: RemapBindings = {};
  // Copy each existing entry into a FRESH plain object (never alias the source's
  // value objects — see the doc comment above).
  if (bindings) {
    for (const k of Object.keys(bindings)) {
      const c = bindings[k];
      if (isPhysicalControl(c)) next[k] = { kind: c.kind, index: c.index };
    }
  }
  const def = DEFAULT_GAMEPAD_BINDINGS[outputId];
  if (def && def.kind === control.kind && def.index === control.index) {
    delete next[outputId];
  } else {
    next[outputId] = { kind: control.kind, index: control.index };
  }
  return next;
}

/** Commit a remap binding to a node's `data` object IN PLACE, safe to call
 *  against the LIVE SyncedStore proxy inside a `ydoc.transact`. This is the seam
 *  that broke: the previous card code spread the live `data.bindings` proxy and
 *  then re-assigned its own already-integrated value objects back onto it, which
 *  Yjs rejects ("reassigning object that already occurs in the tree") — the
 *  throw escaped the card's rAF poll, killing the poll loop so the module went
 *  dead after a 2nd remap.
 *
 *  `data` is mutated IN PLACE: we compute the desired bindings map with
 *  `setBinding` (which returns fresh value objects), then on the live
 *  `data.bindings` map we DELETE keys that should be gone and ASSIGN FRESH plain
 *  `{kind,index}` objects for the rest — never an object already in the tree.
 *  When `data.bindings` doesn't exist yet we assign the fresh map wholesale (the
 *  first-write path, which was never broken). Pure aside from the in-place
 *  mutation; unit-tested against a real Y.Doc. */
export function applyBindingToData(
  data: GamepadData,
  outputId: string,
  control: PhysicalControl,
): void {
  const next = setBinding(data.bindings, outputId, control);
  if (!data.bindings) {
    data.bindings = next;
    return;
  }
  const live = data.bindings;
  // Drop keys no longer present.
  for (const k of Object.keys(live)) {
    if (!(k in next)) delete live[k];
  }
  // Set ONLY the keys whose value actually changed, with FRESH plain objects.
  // Skipping unchanged keys both avoids needless Y.Doc churn AND — critically —
  // never touches an already-integrated value that would otherwise be re-assigned
  // (the throw that broke the module).
  for (const k of Object.keys(next)) {
    const c = next[k]!;
    const cur = live[k];
    if (isPhysicalControl(cur) && cur.kind === c.kind && cur.index === c.index) continue;
    live[k] = { kind: c.kind, index: c.index };
  }
}

/** Clear ONE output's remap override on a node's `data` IN PLACE (revert it to
 *  its default control). Safe against the live proxy: it only deletes a key. */
export function clearBindingOnData(data: GamepadData, outputId: string): void {
  if (data.bindings) delete data.bindings[outputId];
}

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
  /** Raw (un-calibrated, un-inverted) left-stick axes on the most recent
   *  poll — the card's calibration MODE folds these into its sweep. Distinct
   *  from `values.lx/ly` (which are post-calibration + Y-inverted). */
  rawLeftX: number;
  rawLeftY: number;
  /** Raw (un-calibrated, un-inverted) right-stick axes on the most recent poll
   *  — the card's RIGHT-stick calibration MODE folds these into its sweep.
   *  Distinct from `values.rx/ry` (post-calibration + Y-inverted). */
  rawRightX: number;
  rawRightY: number;
  /** Whether a left-stick calibration is currently active (read from
   *  node.data on each poll). The card shows a "calibrated" badge + a "clear"
   *  affordance when true. */
  calibrated: boolean;
  /** Whether a RIGHT-stick calibration is currently active (read from node.data
   *  each poll). The card shows the right-stick "calibrated" badge + clear when
   *  true. */
  rightCalibrated: boolean;
  /** Raw reading on the most recent poll — the card's armed remap listener
   *  diffs consecutive snapshots through `detectChangedControl` (the Gamepad API
   *  has no events, so the listener must poll). Empty arrays when disconnected. */
  raw: RawGamepadReading;
  /** Per-output remap overrides currently in effect (read from node.data each
   *  poll). The card renders a "remapped" badge per output + the read loop
   *  resolves each output's source through these. */
  bindings: RemapBindings;
  /** Per-axis invert flags currently in effect (read from node.data each poll).
   *  The card renders the four INVERT toggles' on/off state from this. */
  invert: StickInvert;
}

/** Per-stick-axis INVERT flags. Each true flag negates that axis's value at read
 *  time (`v → -v`), keeping the same output range + centre. Composes AFTER any
 *  remap (the possibly-remapped axis is read first, then inverted) and AFTER
 *  Y-inversion / calibration, so it flips whatever the user sees on that output.
 *  Keys are the four CV-axis output ids; absent / false → no inversion. */
export interface StickInvert {
  lx?: boolean;
  ly?: boolean;
  rx?: boolean;
  ry?: boolean;
}

/** The four invertible stick-axis output ids. */
export const INVERTIBLE_AXES = ['lx', 'ly', 'rx', 'ry'] as const;
export type InvertibleAxis = (typeof INVERTIBLE_AXES)[number];

/** True when `id` names one of the four invertible stick axes. */
export function isInvertibleAxis(id: string): id is InvertibleAxis {
  return (INVERTIBLE_AXES as readonly string[]).includes(id);
}

/** Apply the per-axis INVERT flag to a (already remapped/shaped) axis value:
 *  flips the sign when the axis's flag is set, leaving range + centre intact.
 *  Pure; the read loop calls it as the LAST step so invert composes on top of a
 *  remap, calibration, and Y-inversion. Non-axis ids pass through unchanged. */
export function applyInvert(
  outputId: string,
  value: number,
  invert: StickInvert | undefined,
): number {
  if (!invert || !isInvertibleAxis(outputId)) return value;
  return invert[outputId] ? -value : value;
}

/** Toggle ONE axis's invert flag on a node's `data` IN PLACE (safe against the
 *  live SyncedStore proxy — sets/deletes a single boolean key). A flag that
 *  toggles back to false is DELETED so the absent / back-compat state is clean
 *  (existing patches without an `invert` map stay unchanged). */
export function toggleInvertOnData(data: GamepadData, axisId: InvertibleAxis): void {
  const cur = !!data.invert?.[axisId];
  if (cur) {
    if (data.invert) {
      delete data.invert[axisId];
      // Drop an emptied invert map so a cleared module reverts to the absent state.
      if (Object.keys(data.invert).length === 0) delete data.invert;
    }
  } else {
    if (!data.invert) data.invert = {};
    data.invert[axisId] = true;
  }
}

/** Structured, synced module state on `node.data`. The calibration records, the
 *  per-output remap overrides, and the per-axis invert flags. All are one-time
 *  committed writes (never per-frame). */
export interface GamepadData {
  /** Left-stick calibration (applied to lx/ly when both are on their default
   *  axes). Absent → the fixed-deadzone path. */
  leftStickCalibration?: StickCalibration;
  /** Right-stick calibration (applied to rx/ry when both are on their default
   *  axes). Same StickCalibration shape + flow as the left stick, reading the
   *  right-stick's own axes (2,3). Absent → the fixed-deadzone path. */
  rightStickCalibration?: StickCalibration;
  /** Per-output physical-control overrides. Absent → all outputs use their
   *  default standard-mapping control (back-compat: existing patches unchanged). */
  bindings?: RemapBindings;
  /** Per-stick-axis invert flags (lx/ly/rx/ry). Absent → no inversion. */
  invert?: StickInvert;
}

// ---------------------------------------------------------------------------
// SAVE / LOAD MAPPING — the full user-configurable control state as one
// serializable bundle, plus a built-in named-preset registry.
//
// A "mapping" is everything the user can configure on GAMEPAD that should
// survive a save/load or transfer between racks: the per-output remap
// bindings, the per-axis invert flags, and BOTH stick calibrations. The live /
// raw runtime fields (snapshot values, the rAF poll state) are deliberately
// excluded — a mapping is pure configuration.
//
// `exportMapping` pulls those fields into a FRESH plain object (deep-cloned
// plain values — never an alias to a live Y type) so the result is safe to
// JSON.stringify and download. `applyMapping` writes a mapping back onto the
// LIVE node.data IN PLACE following the same applyBindingToData discipline (set
// fresh plain objects for the keys in the mapping, delete the keys it omits) so
// it never re-assigns an already-integrated Y type (the trap that killed the
// module after a 2nd remap). Both the file "Load mapping" and the "Load preset"
// menu funnel through `applyMapping`.
// ---------------------------------------------------------------------------

/** The full, serializable GAMEPAD control configuration — the persistable
 *  subset of GamepadData (everything EXCEPT live/raw runtime fields). This is
 *  exactly what "Save mapping" downloads and "Load mapping" / "Load preset"
 *  apply. Every field is optional so a partial / older mapping still loads
 *  (absent fields → the module's default for that aspect). */
export interface GamepadMapping {
  /** Per-output physical-control overrides (the remaps). */
  bindings?: RemapBindings;
  /** Per-stick-axis invert flags. */
  invert?: StickInvert;
  /** Left-stick calibration record. */
  leftStickCalibration?: StickCalibration;
  /** Right-stick calibration record. */
  rightStickCalibration?: StickCalibration;
}

/** Deep-clone a StickCalibration into a FRESH plain object, or undefined when
 *  the input isn't a structurally valid calibration. Never aliases the input
 *  (which, off the live proxy, is an integrated Y type). */
function cloneCalibration(c: unknown): StickCalibration | undefined {
  if (!c || typeof c !== 'object') return undefined;
  const o = c as Partial<StickCalibration>;
  if (
    !Number.isFinite(o.minX) || !Number.isFinite(o.maxX) ||
    !Number.isFinite(o.minY) || !Number.isFinite(o.maxY)
  ) {
    return undefined;
  }
  return {
    minX: o.minX as number,
    maxX: o.maxX as number,
    minY: o.minY as number,
    maxY: o.maxY as number,
    deadzone: Number.isFinite(o.deadzone) ? (o.deadzone as number) : CALIBRATION_DEADZONE,
  };
}

/** Deep-clone a RemapBindings into a FRESH plain map of FRESH value objects,
 *  dropping any structurally-corrupt entry. Never aliases the input's value
 *  objects (mirrors setBinding's fresh-object guarantee). */
function cloneBindings(b: RemapBindings | undefined): RemapBindings | undefined {
  if (!b || typeof b !== 'object') return undefined;
  const next: RemapBindings = {};
  for (const k of Object.keys(b)) {
    const c = b[k];
    if (isPhysicalControl(c)) next[k] = { kind: c.kind, index: c.index };
  }
  return Object.keys(next).length ? next : undefined;
}

/** Deep-clone a StickInvert into a FRESH plain map of only the set flags. */
function cloneInvert(inv: StickInvert | undefined): StickInvert | undefined {
  if (!inv || typeof inv !== 'object') return undefined;
  const next: StickInvert = {};
  for (const k of INVERTIBLE_AXES) {
    if (inv[k]) next[k] = true;
  }
  return Object.keys(next).length ? next : undefined;
}

/** Pull the persistable fields off `data` into a FRESH plain GamepadMapping —
 *  deep-cloned plain values that never alias a live Y type, so the result is
 *  safe to JSON.stringify + download. Omits a field entirely when it's absent /
 *  empty (a clean, minimal mapping). Pure (reads `data`, allocates fresh). */
export function exportMapping(data: GamepadData | undefined): GamepadMapping {
  const m: GamepadMapping = {};
  const bindings = cloneBindings(data?.bindings);
  if (bindings) m.bindings = bindings;
  const invert = cloneInvert(data?.invert);
  if (invert) m.invert = invert;
  const left = cloneCalibration(data?.leftStickCalibration);
  if (left) m.leftStickCalibration = left;
  const right = cloneCalibration(data?.rightStickCalibration);
  if (right) m.rightStickCalibration = right;
  return m;
}

/** True for a structurally plausible GamepadMapping object — used by "Load
 *  mapping" to reject garbage JSON gracefully (never throw into the rAF poll).
 *  Lenient by design: an empty object {} is a valid (no-op) mapping, and unknown
 *  extra keys are ignored. Only the SHAPE of the known fields is checked. */
export function isGamepadMapping(m: unknown): m is GamepadMapping {
  if (!m || typeof m !== 'object') return false;
  const o = m as GamepadMapping;
  if (o.bindings !== undefined && (typeof o.bindings !== 'object' || o.bindings === null)) return false;
  if (o.invert !== undefined && (typeof o.invert !== 'object' || o.invert === null)) return false;
  if (o.leftStickCalibration !== undefined && o.leftStickCalibration !== null && typeof o.leftStickCalibration !== 'object') return false;
  if (o.rightStickCalibration !== undefined && o.rightStickCalibration !== null && typeof o.rightStickCalibration !== 'object') return false;
  return true;
}

/** Apply a mapping onto the LIVE node.data IN PLACE, safe against the SyncedStore
 *  proxy inside a `ydoc.transact`. Mirrors the applyBindingToData discipline:
 *  every key the mapping SETS becomes a FRESH plain object; every key the mapping
 *  OMITS is DELETED — and we never re-assign an object already integrated into the
 *  Y.Doc tree. Garbage / out-of-shape sub-fields are sanitised (via the clone
 *  helpers) so a corrupt mapping can't throw out of the card's rAF poll.
 *
 *  Idempotent + repeat-safe: applying the same mapping twice, or one mapping over
 *  another, never throws ("reassigning object that already occurs in the tree").
 *  Unit-tested against a real Y.Doc. */
export function applyMapping(data: GamepadData, mapping: GamepadMapping): void {
  const m = isGamepadMapping(mapping) ? mapping : {};

  // --- bindings: rebuild the live map in place (delete-then-set fresh) ---
  const nextBindings = cloneBindings(m.bindings);
  if (!nextBindings) {
    if (data.bindings) delete data.bindings;
  } else if (!data.bindings) {
    // First write of the bindings map — assign the fresh map wholesale (a brand
    // new object, never integrated yet → safe).
    data.bindings = nextBindings;
  } else {
    const live = data.bindings;
    for (const k of Object.keys(live)) {
      if (!(k in nextBindings)) delete live[k];
    }
    for (const k of Object.keys(nextBindings)) {
      const c = nextBindings[k]!;
      const cur = live[k];
      if (isPhysicalControl(cur) && cur.kind === c.kind && cur.index === c.index) continue;
      live[k] = { kind: c.kind, index: c.index };
    }
  }

  // --- invert: rebuild the live map in place ---
  const nextInvert = cloneInvert(m.invert);
  if (!nextInvert) {
    if (data.invert) delete data.invert;
  } else if (!data.invert) {
    data.invert = nextInvert;
  } else {
    const live = data.invert;
    for (const k of INVERTIBLE_AXES) {
      if (!nextInvert[k] && live[k]) delete live[k];
    }
    for (const k of INVERTIBLE_AXES) {
      if (nextInvert[k] && !live[k]) live[k] = true;
    }
  }

  // --- calibrations: a calibration record is a leaf plain object; set a FRESH
  // clone or delete the key. Never alias the mapping's object (it might be a
  // shared preset record) so the live doc owns its own copy. ---
  const left = cloneCalibration(m.leftStickCalibration);
  if (left) data.leftStickCalibration = left;
  else if (data.leftStickCalibration) delete data.leftStickCalibration;

  const right = cloneCalibration(m.rightStickCalibration);
  if (right) data.rightStickCalibration = right;
  else if (data.rightStickCalibration) delete data.rightStickCalibration;
}

/** A built-in named mapping the card surfaces in its "Load preset…" menu. */
export interface GamepadPreset {
  name: string;
  mapping: GamepadMapping;
}

/** Built-in named mappings, pre-populated in the card's "Load preset…" menu.
 *  Each entry's `mapping` is applied via `applyMapping` on selection. */
export const GAMEPAD_PRESETS: readonly GamepadPreset[] = [
  {
    // NXT Gladiator — the owner's calibrated mapping for the NXT Gladiator pad,
    // captured via "Save mapping" on a real device (gamepad-mapping.json).
    // Only the controls that DIFFER from the standard mapping are listed; every
    // output not named here keeps its default standard-mapping binding (e.g.
    // lx/ly stay axes 0/1, the face buttons stay their standard indices). The
    // right stick is on axes 3/2 with Y inverted, and both sticks carry the
    // owner's measured min/max + 0.1 deadzone calibration.
    name: 'NXT Gladiator',
    mapping: {
      bindings: {
        rx: { kind: 'axis', index: 3 },
        ry: { kind: 'axis', index: 2 },
        x: { kind: 'button', index: 21 },
        du: { kind: 'button', index: 10 },
        dd: { kind: 'button', index: 12 },
        dl: { kind: 'button', index: 13 },
        dr: { kind: 'button', index: 11 },
        rb: { kind: 'button', index: 19 },
        lt: { kind: 'button', index: 25 },
        rt: { kind: 'button', index: 23 },
      },
      invert: { ry: true },
      leftStickCalibration: {
        minX: -1,
        maxX: 0.9672771692276001,
        minY: -0.9960927963256836,
        maxY: 0.8583638668060303,
        deadzone: 0.1,
      },
      rightStickCalibration: { minX: -1, maxX: 1, minY: -1, maxY: 1, deadzone: 0.1 },
    },
  },
];

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
      rawLeftX: 0,
      rawLeftY: 0,
      rawRightX: 0,
      rawRightY: 0,
      calibrated: false,
      rightCalibrated: false,
      raw: { axes: [], buttons: [] },
      bindings: {},
      invert: {},
    };

    /** Read the live (synced) calibration for one stick off node.data. Cheap —
     *  reads the live patch proxy, no write. `stick` selects which calibration
     *  record (left = lx/ly axes 0,1; right = rx/ry axes 2,3). Returns undefined
     *  when no calibration has been committed for that stick. The math + record
     *  shape are identical per stick — only the source field differs. */
    function readCalibration(stick: 'left' | 'right'): StickCalibration | undefined {
      const data = (livePatch.nodes[node.id]?.data ?? undefined) as GamepadData | undefined;
      const c = stick === 'left' ? data?.leftStickCalibration : data?.rightStickCalibration;
      if (
        c &&
        Number.isFinite(c.minX) && Number.isFinite(c.maxX) &&
        Number.isFinite(c.minY) && Number.isFinite(c.maxY)
      ) {
        return c;
      }
      return undefined;
    }

    /** Read the live (synced) per-output remap overrides off node.data. Returns
     *  an empty record when none committed (all outputs default). */
    function readBindings(): RemapBindings {
      const data = (livePatch.nodes[node.id]?.data ?? undefined) as GamepadData | undefined;
      const b = data?.bindings;
      return b && typeof b === 'object' ? b : {};
    }

    /** Read the live (synced) per-axis invert flags off node.data. Returns an
     *  empty record when none committed (no axis inverted). */
    function readInvert(): StickInvert {
      const data = (livePatch.nodes[node.id]?.data ?? undefined) as GamepadData | undefined;
      const inv = data?.invert;
      return inv && typeof inv === 'object' ? inv : {};
    }

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
          snapshot.rawLeftX = 0;
          snapshot.rawLeftY = 0;
          snapshot.rawRightX = 0;
          snapshot.rawRightY = 0;
          snapshot.raw = { axes: [], buttons: [] };
          for (const o of OUTPUT_DEFS) {
            sources[o.id]!.offset.setValueAtTime(0, ctx.currentTime);
            snapshot.values[o.id] = 0;
          }
        }
        return;
      }

      snapshot.connected = true;
      snapshot.id = pad.id;

      // A plain RawGamepadReading snapshot the card's armed remap listener
      // diffs frame-to-frame (the Gamepad API has no events). Copy out of the
      // live GamepadButton objects so the card never holds a stale browser ref.
      const reading: RawGamepadReading = {
        axes: Array.from(pad.axes, (a) => (Number.isFinite(a) ? a : 0)),
        buttons: Array.from(pad.buttons, (btn) => ({
          value: Number.isFinite(btn?.value) ? btn.value : 0,
          pressed: !!btn?.pressed,
        })),
      };
      snapshot.raw = reading;

      // Per-output remap overrides (live, synced). Each output resolves to a
      // physical control (override or default) below.
      const bindings = readBindings();
      snapshot.bindings = bindings;

      // Per-axis invert flags (live, synced). Applied as the LAST shaping step so
      // invert composes on top of a remap / calibration / Y-inversion.
      const invert = readInvert();
      snapshot.invert = invert;

      // Raw left + right stick axes (spec frame: +X = right, +Y = down) —
      // surfaced on the snapshot so each stick's calibration sweep folds them in
      // directly. Left = axes 0,1; right = axes 2,3.
      const rawLeftX = pad.axes[0] ?? 0;
      const rawLeftY = pad.axes[1] ?? 0;
      const rawRightX = pad.axes[2] ?? 0;
      const rawRightY = pad.axes[3] ?? 0;
      snapshot.rawLeftX = rawLeftX;
      snapshot.rawLeftY = rawLeftY;
      snapshot.rawRightX = rawRightX;
      snapshot.rawRightY = rawRightY;

      const cal = readCalibration('left');
      snapshot.calibrated = !!cal;
      const calR = readCalibration('right');
      snapshot.rightCalibrated = !!calR;

      // Resolve every output through its binding (override or default) and apply
      // the output's own shaping. CV-axis outputs deadzone the raw axis (with
      // Y-inversion + sign on the natural stick axes); trigger outputs map 0..1;
      // gate outputs threshold the pressed state. A stick's calibration applies
      // ONLY when that stick's two axis outputs are still bound to their default
      // axes as a PAIR — calibration is a 2D radial map that's meaningless once an
      // axis is remapped elsewhere; that case falls back to the fixed deadzone.
      const lxBind = bindingForOutput('lx', bindings)!;
      const lyBind = bindingForOutput('ly', bindings)!;
      const leftStickDefault =
        lxBind.kind === 'axis' && lxBind.index === STD_AXIS.lx &&
        lyBind.kind === 'axis' && lyBind.index === STD_AXIS.ly;
      const rxBind = bindingForOutput('rx', bindings)!;
      const ryBind = bindingForOutput('ry', bindings)!;
      const rightStickDefault =
        rxBind.kind === 'axis' && rxBind.index === STD_AXIS.rx &&
        ryBind.kind === 'axis' && ryBind.index === STD_AXIS.ry;

      let calLx: number | null = null;
      let calLy: number | null = null;
      if (cal && leftStickDefault) {
        const c = applyCalibration(rawLeftX, rawLeftY, cal);
        calLx = c.x;
        calLy = -c.y;
      }
      let calRx: number | null = null;
      let calRy: number | null = null;
      if (calR && rightStickDefault) {
        const c = applyCalibration(rawRightX, rawRightY, calR);
        calRx = c.x;
        calRy = -c.y;
      }

      const next: Record<string, number> = {};
      for (const o of OUTPUT_DEFS) {
        const control = bindingForOutput(o.id, bindings)!;
        const raw = readControlValue(reading, control);
        let v: number;
        if (o.id === 'lx' && calLx !== null) {
          v = calLx;
        } else if (o.id === 'ly' && calLy !== null) {
          v = calLy;
        } else if (o.id === 'rx' && calRx !== null) {
          v = calRx;
        } else if (o.id === 'ry' && calRy !== null) {
          v = calRy;
        } else if (o.id === 'lt' || o.id === 'rt') {
          // Trigger outputs read the analog button value (or a remapped axis,
          // rectified to 0..1) as a smooth 0..1 CV.
          v = triggerToCv(control.kind === 'axis' ? Math.abs(raw) : raw);
        } else if (o.type === 'cv') {
          // Stick-axis CV outputs: deadzone. ly/ry invert (so +1 = up) when on
          // their natural Y axis; a remapped axis keeps its raw sign.
          const isNaturalY =
            (o.id === 'ly' && control.kind === 'axis' && control.index === STD_AXIS.ly) ||
            (o.id === 'ry' && control.kind === 'axis' && control.index === STD_AXIS.ry);
          const dz = control.kind === 'axis' ? applyDeadzone(raw) : raw;
          v = isNaturalY ? -dz : dz;
        } else {
          // Gate outputs: 1 when the source crosses the pressed threshold. A
          // button source uses its pressed flag; a remapped axis crosses at half
          // deflection.
          const pressed =
            control.kind === 'button'
              ? !!reading.buttons[control.index]?.pressed
              : Math.abs(raw) >= 0.5;
          v = pressed ? 1 : 0;
        }
        // INVERT (last step) — flips the four stick-axis outputs when their flag
        // is set, composing on top of the remap / calibration / Y-inversion
        // above. A no-op for non-axis outputs + un-inverted axes.
        next[o.id] = applyInvert(o.id, v, invert);
      }

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
        if (key === 'snapshot') {
          // Fresh copies of the nested structures so a card holding the result
          // across frames isn't mutated under it (raw/bindings are reassigned
          // each poll, but values is mutated in place).
          return {
            ...snapshot,
            values: { ...snapshot.values },
            raw: snapshot.raw,
            bindings: snapshot.bindings,
            invert: snapshot.invert,
          };
        }
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
