// SURFACE MAP — raw cell events (WIRE coordinates) → region-attributed
// surface events (APPLICATION coordinates).
//
// The asymmetric indexing, spelled out (design.md:101):
//   wire column  = app column + 1        (wire 1..25 ↔ app 0..24)
//   note channel = app row + 1           (the raw decoder already gives row 0..7)
//   LED row      = app row               (NO +1 — WP-B's LED writer uses this)
// Never apply a blanket "subtract one from all coordinates".
//
// Regions are the profile's rectangles (DATA). A touch is owned by the region
// it BEGAN in: a slide that crosses a region boundary ends that region's
// gesture and never becomes a control press or a note in the next region
// (design.md:117, V11). Keys use the tree's `keyboardCellToMidi` — the spike's
// `keyboard-layout.ts` duplicate is not imported.
//
// PURE, explicit state in/out. ⚠ Plain `.ts`, no runes.

import { keyboardCellToMidi } from '$lib/audio/modules/keyboard-map';
import { controlAtRow, padXSpan, regionAt, semitoneWidthRaw } from './profile';
import type {
  ControlName,
  LinnProfile,
  MusicalRegion,
  RawEvent,
  Region,
  RuntimeEvent,
  TouchId,
} from './types';

export const appColToWireCol = (col: number): number => col + 1;
export const wireColToAppCol = (wire: number): number => wire - 1;
/** LED rows are app rows; exported so the asymmetry has a named home. */
export const appRowToLedRow = (row: number): number => row;
export const appRowToNoteChannel = (row: number): number => row + 1;

interface TrackedTouch {
  region: Region | null;
  control: ControlName | null;
  /** App column of the fresh press. */
  originCol: number;
  /** App column the touch is on NOW — moves with an in-region slide (the
   *  played LED mark follows it; the voice keeps its origin note). */
  col: number;
  row: number;
  note: number | null;
  /** A touch that crossed out of its region (or never mapped) is inert. */
  ended: boolean;
  x: number | null;
  y: number | null;
  z: number;
}

export interface SurfaceMapState {
  touches: ReadonlyMap<TouchId, TrackedTouch>;
}

export interface SurfaceMapResult {
  state: SurfaceMapState;
  events: RuntimeEvent[];
}

export function createSurfaceMapState(): SurfaceMapState {
  return { touches: new Map() };
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

function localOf(profile: LinnProfile, region: Region, col: number, row: number): { localCol: number; localRow: number } {
  const r = profile.regions[region];
  return { localCol: col - r.left, localRow: row - r.bottom };
}

function padUV(profile: LinnProfile, t: TrackedTouch, col: number): { u: number; v: number } {
  const pad = profile.regions.pad;
  const { localCol, localRow } = localOf(profile, 'pad', col, t.row);
  let u: number;
  if (t.x === null) {
    u = (localCol + 0.5) / pad.width; // cell-centre estimate until raw X lands
  } else {
    const span = padXSpan(profile);
    u = clamp01((t.x - span.left) / (span.right - span.left));
  }
  // design.md:123 — stitched logical rows; NOT proof of continuous tracking.
  const v = t.y === null ? (localRow + 0.5) / pad.height : clamp01((localRow + t.y / 127) / pad.height);
  return { u, v };
}

/**
 * Map one raw event. Every raw event maps to zero or more runtime events; the
 * returned state tracks touch ownership so an ended touch stays inert.
 */
export function mapSurface(state: SurfaceMapState, raw: RawEvent, profile: LinnProfile): SurfaceMapResult {
  const events: RuntimeEvent[] = [];
  const { epoch, time } = raw;

  if (raw.kind === 'rejected') return { state, events };

  if (raw.kind === 'mode') {
    return {
      state: createSurfaceMapState(),
      events: [{ kind: 'session', epoch, state: 'mode_changed', userMode: raw.userMode, time }],
    };
  }

  const touches = new Map(state.touches);

  if (raw.kind === 'cell_down') {
    const col = wireColToAppCol(raw.col);
    const row = raw.row;
    const region = regionAt(profile, col, row);
    const tracked: TrackedTouch = { region, control: null, originCol: col, col, row, note: null, ended: false, x: null, y: null, z: 0 };
    if (region === 'keys' || region === 'pad') {
      const { localCol, localRow } = localOf(profile, region, col, row);
      const root = region === 'keys' ? profile.keysRoot : profile.padRoot;
      const note = keyboardCellToMidi(localCol, localRow, root, profile.semisPerCol, profile.semisPerRow);
      if (note < 0 || note > 127) {
        tracked.ended = true;
      } else {
        tracked.note = note;
        events.push({ kind: 'touch_start', epoch, touch: raw.touch, region, col, row, localCol, localRow, note, velocity: raw.velocity, time });
        if (region === 'pad') {
          const { u, v } = padUV(profile, tracked, col);
          events.push({ kind: 'pointer', epoch, touch: raw.touch, phase: 'down', u, v, pressure: 0, time });
        }
      }
    } else if (region === 'controls') {
      const control = controlAtRow(profile, row - profile.regions.controls.bottom);
      tracked.control = control;
      if (control) events.push({ kind: 'control_edge', epoch, control, down: true, time });
      else tracked.ended = true;
    } else {
      tracked.ended = true;
    }
    touches.set(raw.touch, tracked);
    return { state: { touches }, events };
  }

  const t = state.touches.get(raw.touch);
  if (!t) return { state, events };

  if (raw.kind === 'cell_up') {
    touches.delete(raw.touch);
    if (!t.ended) {
      if (t.region === 'keys' || t.region === 'pad') {
        if (t.region === 'pad') {
          const { u, v } = padUV(profile, t, wireColToAppCol(raw.col));
          events.push({ kind: 'pointer', epoch, touch: raw.touch, phase: 'up', u, v, pressure: 0, time });
        }
        events.push({
          kind: 'touch_end', epoch, touch: raw.touch, region: t.region,
          releaseVelocity: raw.releaseVelocity / 127,
          reason: raw.reason === 'session' ? 'session' : 'release', time,
        });
      } else if (t.control) {
        events.push({ kind: 'control_edge', epoch, control: t.control, down: false, time });
      }
    }
    return { state: { touches }, events };
  }

  if (t.ended) return { state, events };

  if (raw.kind === 'cell_slide') {
    const toCol = wireColToAppCol(raw.toCol);
    const destRegion = regionAt(profile, toCol, raw.row);
    if ((t.region === 'keys' || t.region === 'pad') && destRegion === t.region) {
      touches.set(raw.touch, { ...t, col: toCol });
      events.push({ kind: 'touch_slide', epoch, touch: raw.touch, region: t.region, fromCol: wireColToAppCol(raw.fromCol), toCol, row: raw.row, time });
      return { state: { touches }, events };
    }
    // Boundary crossing: clip this region's gesture; the touch is now inert.
    touches.set(raw.touch, { ...t, ended: true });
    if (t.region === 'keys' || t.region === 'pad') {
      if (t.region === 'pad') {
        const { u, v } = padUV(profile, t, wireColToAppCol(raw.fromCol));
        events.push({ kind: 'pointer', epoch, touch: raw.touch, phase: 'up', u, v, pressure: t.z / 127, time });
      }
      events.push({ kind: 'touch_end', epoch, touch: raw.touch, region: t.region, reason: 'boundary', time });
    } else if (t.control) {
      events.push({ kind: 'control_edge', epoch, control: t.control, down: false, time });
    }
    return { state: { touches }, events };
  }

  // Expression: only musical touches carry it; a control cell's X/Y/Z is noise.
  if (t.region !== 'keys' && t.region !== 'pad') return { state, events };
  const region: MusicalRegion = t.region;
  const col = wireColToAppCol(raw.col);
  let next: TrackedTouch = t;
  if (raw.kind === 'cell_x') {
    next = { ...t, x: raw.x };
    const bendSemitones = (raw.x - raw.initialX) / semitoneWidthRaw(profile);
    events.push({ kind: 'touch_expression', epoch, touch: raw.touch, region, bendSemitones, time });
  } else if (raw.kind === 'cell_y') {
    next = { ...t, y: raw.y };
    events.push({ kind: 'touch_expression', epoch, touch: raw.touch, region, timbre: raw.y / 127, time });
  } else if (raw.kind === 'cell_z') {
    next = { ...t, z: raw.z };
    events.push({ kind: 'touch_expression', epoch, touch: raw.touch, region, pressure: raw.z / 127, time });
  }
  touches.set(raw.touch, next);
  if (region === 'pad' && raw.kind !== 'cell_z') {
    const { u, v } = padUV(profile, next, col);
    events.push({ kind: 'pointer', epoch, touch: raw.touch, phase: 'move', u, v, pressure: next.z / 127, time });
  }
  return { state: { touches }, events };
}
