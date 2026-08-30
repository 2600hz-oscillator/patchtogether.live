// PTZ send planner — pure. Takes normalized targets (knob + CV already summed),
// slew-limits them, maps into the device ranges a caps handshake reported, and
// suppresses no-change writes so the MIDI wire only carries movement. The
// factory calls this on a decimated scheduler tick; the helper coalesces again
// at its own 30 Hz, so nothing here needs to be exact about timing — only
// monotone and clamped.

import type { PtzCaps, PtzControl } from './ptz-sysex';

export interface PtzTargets {
  readonly pan: number;
  readonly tilt: number;
  readonly zoom: number;
}

export interface PtzPlan {
  readonly pos: PtzTargets;
  readonly sent: PtzTargets;
}

export interface PtzSend {
  readonly control: PtzControl;
  readonly value: number;
}

/** slew 1 = instant; below that, max normalized units/sec on a square curve so
 *  the low half of the knob is fine motion. The camera's motors are slower
 *  than the top of this range for pan/tilt — the planner's slew mostly shapes
 *  zoom and keeps a CV step from commanding a slam. */
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

export function planPtzSend(
  prev: PtzPlan | null,
  targets: PtzTargets,
  caps: PtzCaps,
  dtMs: number,
  slew: number,
): { plan: PtzPlan; sends: readonly PtzSend[] } {
  const goal: PtzTargets = {
    pan: clamp(targets.pan, -1, 1),
    tilt: clamp(targets.tilt, -1, 1),
    zoom: clamp(targets.zoom, 0, 1),
  };

  let pos: PtzTargets;
  if (prev === null) {
    pos = goal;
  } else {
    const maxStep = ptzSlewRate(slew) * (Math.max(0, dtMs) / 1000);
    const toward = (from: number, to: number): number =>
      Math.abs(to - from) <= maxStep ? to : from + Math.sign(to - from) * maxStep;
    pos = {
      pan: toward(prev.pos.pan, goal.pan),
      tilt: toward(prev.pos.tilt, goal.tilt),
      zoom: toward(prev.pos.zoom, goal.zoom),
    };
  }

  const dev: PtzTargets = {
    pan: toDevice(pos.pan, caps.pan.min, caps.pan.max, caps.pan.res, false),
    tilt: toDevice(pos.tilt, caps.tilt.min, caps.tilt.max, caps.tilt.res, false),
    zoom: toDevice(pos.zoom, caps.zoom.min, caps.zoom.max, caps.zoom.res, true),
  };

  const sends: PtzSend[] = [];
  for (const control of ['pan', 'tilt', 'zoom'] as const) {
    if (prev === null || dev[control] !== prev.sent[control]) {
      sends.push({ control, value: dev[control] });
    }
  }

  return { plan: { pos, sent: dev }, sends };
}
