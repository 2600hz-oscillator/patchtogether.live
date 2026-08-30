// packages/web/src/lib/ui/modules/kria-cell-actions.ts
//
// The read/write halves of kria's faceplate BAND cells.
//
// Nine controls that the engine implements, the docs describe, and the card
// could not reach: `loopStart`, `loopLength`, `timeDivision`, `direction`,
// `muted`, `scale` and `root` were editable from ONE place — an attached monome
// grid over WebSerial — while `module-manifest.ts` told the reader the module
// was "fully usable from the card with a mouse". These cells are what makes
// that sentence true.
//
// ⚠ EVERY ROSTER AND EVERY BOUND IS IMPORTED, NEVER RE-TYPED. `kria-types.ts`
// already declares all of them (`KRIA_DIRECTIONS`, `KRIA_TIME_DIVISIONS`,
// `KRIA_SCALE_PRESETS`, `KRIA_STEPS`, `MIN_MIDI`/`MAX_MIDI`), so the face
// invents no vocabulary. This is the backdraft rule — a control's range must
// come from ONE place — and kria is a textbook candidate for breaking it: a
// hand-typed copy here would let the face offer a value `coerceTrack` silently
// clamps away, with every def-reading gate green.
//
// ⚠ EVERY CELL EXCEPT `scale`/`root` READS AND WRITES THE **SELECTED TRACK**.
// That coupling is the design's one real hazard — a cell and the grid panel
// disagreeing about which track is on screen — which is why the selection lives
// in `node.data` (a cell's `value(node)` receives only the node) and why
// `kria-face-model.test.ts` keeps "switch tracks and every cell moves with it"
// as a permanent negative control.

import type { SelectorOption } from '$lib/ui/controls';
import type { ModuleNode } from '$lib/graph/types';
import { patch } from '$lib/graph/store';
import { MAX_MIDI, MIN_MIDI, noteNameForMidi } from '$lib/audio/note-entry';
import {
  KRIA_DIRECTIONS,
  KRIA_SCALE_PRESETS,
  KRIA_STEPS,
  KRIA_TIME_DIVISIONS,
  setDirection,
  setLoopLength,
  setLoopStart,
  setMuted,
  setTimeDivision,
  type KriaData,
  type KriaDirection,
  type KriaScaleName,
} from '$lib/audio/modules/kria-types';
import {
  editKriaTrack,
  readActivePattern,
  readSelTrack,
  readSelectedTrack,
  setKriaRoot,
  setKriaScale,
} from '$lib/audio/modules/kria-writes';

function dataOf(node: ModuleNode | undefined): KriaData {
  return (node?.data ?? {}) as KriaData;
}

/** The selected track of `node`, coerced — the subject of most cells here. */
function selTrackOf(node: ModuleNode | undefined) {
  return readSelectedTrack(dataOf(node));
}

/**
 * WHICH track a write targets.
 *
 * A cell's `onchange` receives a nodeId and nothing else, but every per-track
 * write has to know which track is selected — and that is data ON the node. So
 * the write side re-reads it from the live graph rather than closing over a
 * value the cell captured at render time, which would target the wrong track
 * after a selection change.
 */
function selTrackIdx(nodeId: string): number {
  return readSelTrack(dataOf(patch.nodes[nodeId] as ModuleNode | undefined));
}

/** Which track the bands are describing (1-based, for a caption). */
export function kriaSelectedTrackNumber(node: ModuleNode | undefined): number {
  return readSelTrack(dataOf(node)) + 1;
}

// ── LOOP ────────────────────────────────────────────────────────────────────

export function kriaLoopStartOptions(): SelectorOption<string>[] {
  return Array.from({ length: KRIA_STEPS }, (_, i) => ({
    value: String(i),
    label: String(i + 1),
    title: `the selected track's loop begins at step ${i + 1}`,
  }));
}
export function kriaLoopStartValue(node: ModuleNode | undefined): string {
  return String(selTrackOf(node).loopStart);
}
export function kriaSetLoopStart(nodeId: string, v: string): void {
  const n = Number(v);
  editKriaTrack(nodeId, selTrackIdx(nodeId), (t) => setLoopStart(t, n));
}

export function kriaLoopLengthOptions(): SelectorOption<string>[] {
  return Array.from({ length: KRIA_STEPS }, (_, i) => ({
    value: String(i + 1),
    label: String(i + 1),
    title:
      i + 1 === KRIA_STEPS
        ? 'the whole grid — the track never wraps early'
        : `the track wraps after ${i + 1} steps, so it drifts against the others`,
  }));
}
export function kriaLoopLengthValue(node: ModuleNode | undefined): string {
  return String(selTrackOf(node).loopLength);
}
export function kriaSetLoopLength(nodeId: string, v: string): void {
  const n = Number(v);
  editKriaTrack(nodeId, selTrackIdx(nodeId), (t) => setLoopLength(t, n));
}

// ── TIME ────────────────────────────────────────────────────────────────────

export function kriaTimeDivisionOptions(): SelectorOption<string>[] {
  // ⚠ A DECLARED ROSTER OF EIGHT IRREGULAR VALUES (1,2,3,4,6,8,12,16), not a
  // range. A knob would let a player land between two legal divisions and be
  // silently rounded to one of them.
  return KRIA_TIME_DIVISIONS.map((d) => ({
    value: String(d),
    label: d === 1 ? '1' : `/${d}`,
    title: d === 1 ? 'one step per clock tick' : `one step every ${d} clock ticks`,
  }));
}
export function kriaTimeDivisionValue(node: ModuleNode | undefined): string {
  return String(selTrackOf(node).timeDivision);
}
export function kriaSetTimeDivision(nodeId: string, v: string): void {
  const n = Number(v);
  editKriaTrack(nodeId, selTrackIdx(nodeId), (t) => setTimeDivision(t, n));
}

export function kriaDirectionOptions(): SelectorOption<string>[] {
  return KRIA_DIRECTIONS.map((d) => ({
    value: d,
    label: d,
    title: `the selected track walks its loop window ${d}`,
  }));
}
export function kriaDirectionValue(node: ModuleNode | undefined): string {
  return selTrackOf(node).direction;
}
export function kriaSetDirection(nodeId: string, v: string): void {
  editKriaTrack(nodeId, selTrackIdx(nodeId), (t) =>
    setDirection(t, v as KriaDirection),
  );
}

// ── MUTE ────────────────────────────────────────────────────────────────────

export function kriaMuteValue(node: ModuleNode | undefined): boolean {
  return selTrackOf(node).muted;
}
export function kriaSetMute(nodeId: string, on: boolean): void {
  editKriaTrack(nodeId, selTrackIdx(nodeId), (t) => setMuted(t, on));
}

// ── SCALE + ROOT (pattern-level, shared by all four tracks) ─────────────────

export function kriaScaleOptions(): SelectorOption<string>[] {
  return KRIA_SCALE_PRESETS.map((s) => ({
    value: s,
    label: s,
    title: `quantize every track's note lane to the ${s} scale`,
  }));
}
export function kriaScaleValue(node: ModuleNode | undefined): string {
  return readActivePattern(dataOf(node)).scale;
}
export function kriaSetScale(nodeId: string, v: string): void {
  setKriaScale(nodeId, v as KriaScaleName);
}

export function kriaRootOptions(): SelectorOption<string>[] {
  // ⚠ NOTE NAMES, NOT A RAW MIDI NUMBER. The stored value is MIDI (48 = C3) and
  // stays MIDI; a face that made a player pick `48` would be a worse instrument
  // than the hardware it models. The SPAN is imported from note-entry's own
  // bounds, so the roster cannot offer a root `coercePattern` would clamp.
  const out: SelectorOption<string>[] = [];
  for (let m = MIN_MIDI; m <= MAX_MIDI; m++) {
    out.push({ value: String(m), label: noteNameForMidi(m), title: `root note ${noteNameForMidi(m)}` });
  }
  return out;
}
export function kriaRootValue(node: ModuleNode | undefined): string {
  return String(readActivePattern(dataOf(node)).root);
}
export function kriaSetRoot(nodeId: string, v: string): void {
  setKriaRoot(nodeId, Number(v));
}

