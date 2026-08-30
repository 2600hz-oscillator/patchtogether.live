// PTZ send planner — pure. Takes normalized targets (knob + CV already summed)
// and per-axis caps from the v2 handshake, and plans the frames for this tick.
//
// ABSOLUTE axes: slew-limit, map into the device range, quantize, suppress
// no-change writes (the NexiGo path — unchanged from v1).
//
// VELOCITY axes: the bipolar value IS a velocity — sign is direction, the
// magnitude maps into the device speed range past a deadzone, and zero is an
// explicit STOP. Two properties are load-bearing for stage safety:
//   - a nonzero velocity is RE-SENT every plan even when unchanged — the
//     stream is the helper watchdog's keepalive (helper stops motion after
//     ~250 ms without it, so a 10 Hz plan rate keeps a healthy app alive and
//     a dead one halts);
//   - the transition to zero is always emitted (an explicit stop, never
//     suppressed).
// Slew does not apply to a velocity axis: the value is already a rate, and
// delaying a commanded STOP would be exactly backwards.

import type { PtzAxisCaps, PtzCaps, PtzControl } from './ptz-sysex';

export interface PtzTargets {
  readonly pan: number;
  readonly tilt: number;
  readonly zoom: number;
}

export interface PtzPlan {
  readonly pos: PtzTargets;
  readonly sent: PtzTargets;
  readonly sentVel: PtzTargets;
}

export interface PtzSend {
  readonly control: PtzControl;
  readonly kind: 'abs' | 'vel';
  readonly value: number;
}

/** |normalized| at or below this is a STOP on a velocity axis — a resting CV
 *  or knob must never leave a head creeping. */
export const PTZ_VEL_DEADZONE = 0.05;

/** slew 1 = instant; below that, max normalized units/sec on a square curve so
 *  the low half of the knob is fine motion. Absolute axes only. */
export function ptzSlewRate(slew: number): number {
  if (!Number.isFinite(slew) || slew >= 1) return Infinity;
  return Math.max(0.02, 8 * slew * slew);
}

const clamp = (v: number, lo: number, hi: number): number =>
  Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo === -1 ? 0 : lo;

function toDevice(norm: number, min: number, max: number, res: number, unipolar: boolean): number {
  const t = unipolar ? norm : (norm + 1) / 2;
  const raw = min + t * (max - min);
  const step = res > 0 ? res : 1;
  return Math.min(max, Math.max(min, min + Math.round((raw - min) / step) * step));
}

/** Bipolar normalized → signed device speed. Exported for the unit tests:
 *  the Logitech's degenerate 1..1 range must collapse to exactly {-1, 0, +1}. */
export function velFromNorm(
  norm: number,
  caps: { speedMin: number; speedMax: number; speedRes: number },
): number {
  const n = clamp(norm, -1, 1);
  if (Math.abs(n) <= PTZ_VEL_DEADZONE) return 0;
  const t = (Math.abs(n) - PTZ_VEL_DEADZONE) / (1 - PTZ_VEL_DEADZONE);
  const lo = Math.max(1, caps.speedMin);
  const hi = Math.max(lo, caps.speedMax);
  const step = caps.speedRes > 0 ? caps.speedRes : 1;
  const raw = lo + t * (hi - lo);
  const mag = Math.min(hi, Math.max(lo, lo + Math.round((raw - lo) / step) * step));
  return n > 0 ? mag : -mag;
}

export function planPtzSend(
  prev: PtzPlan | null,
  targets: PtzTargets,
  caps: PtzCaps,
  dtMs: number,
  slew: number,
): { plan: PtzPlan; sends: readonly PtzSend[] } {
  const axes: readonly [PtzControl, PtzAxisCaps, boolean][] = [
    ['pan', caps.pan, false],
    ['tilt', caps.tilt, false],
    ['zoom', caps.zoom, true],
  ];

  const pos = { pan: 0, tilt: 0, zoom: 0 };
  const sent = { pan: 0, tilt: 0, zoom: 0 };
  const sentVel = { pan: 0, tilt: 0, zoom: 0 };
  const sends: PtzSend[] = [];
  const maxStep = ptzSlewRate(slew) * (Math.max(0, dtMs) / 1000);

  for (const [control, axis, unipolar] of axes) {
    const goal = clamp(targets[control], unipolar && axis.mode === 'abs' ? 0 : -1, 1);

    if (axis.mode === 'abs') {
      let p = goal;
      if (prev !== null) {
        const from = prev.pos[control];
        p = Math.abs(goal - from) <= maxStep ? goal : from + Math.sign(goal - from) * maxStep;
      }
      pos[control] = p;
      const dev = toDevice(p, axis.min, axis.max, axis.res, unipolar);
      sent[control] = dev;
      if (prev === null || dev !== prev.sent[control]) {
        sends.push({ control, kind: 'abs', value: dev });
      }
    } else if (axis.mode === 'vel') {
      pos[control] = goal;
      const v = velFromNorm(goal, axis);
      sentVel[control] = v;
      if (prev === null || v !== 0 || prev.sentVel[control] !== 0) {
        sends.push({ control, kind: 'vel', value: v });
      }
    }
  }

  return { plan: { pos, sent, sentVel }, sends };
}
