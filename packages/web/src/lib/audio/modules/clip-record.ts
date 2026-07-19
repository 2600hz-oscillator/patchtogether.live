// packages/web/src/lib/audio/modules/clip-record.ts
//
// PURE note-RECORD write helpers for the dual-Launchpad KEYS/record mode
// (design: .myrobots/plans/clip-record-note-mode-2026-07-01.md, Phase 1). These
// are placement-free + engine-free: given a TARGET STEP they mutate a
// NoteClipRecord functionally (callers apply the result via the in-place Y.Doc
// discipline, one transact per discrete note-event — never per frame). Distinct
// from clip-types.ts `toggleNoteAt` (which TOGGLES on/off for the editor):
// recording only ADDS/REPLACES, it never removes on a repeat press.
//
// Semantics (owner-LOCKED, redesign 2026-07-19 — supersedes the 2026-07-01
// replace-as-you-play model):
//   - ADDITIVE LAYERING (Deluge): recording ONLY ADDS notes — both plain record
//     and overdub. There is NO per-step-crossing clear anymore; the
//     "replace-as-you-play" mode is REMOVED (it was the source of the stale-note
//     bug — the clear lagged the ~200 ms scheduler by a full loop). REMOVING /
//     replacing is a SEPARATE explicit gesture: tap a lit step off in the editor,
//     hold-to-erase, `clearClip` / `eraseRow`. `clearStep` remains as the pure
//     erase-one-step helper those gestures build on (no longer wired into live
//     record).
//   - MONO lane: first-note-priority — the first note recorded onto a step wins;
//     later presses that pass are dropped.
//   - POLY lane: up to `maxVoices` (POLY_CHANNEL_PAIRS) notes/step; duplicate
//     pitches + overflow are dropped.
//   - Held-note length is captured on note-off (`extendRecordedNote`),
//     wrap-CLAMPED to the clip end (no backwards span — review B4).

import { POLY_CHANNEL_PAIRS } from '$lib/audio/poly';
import { VEL_DEFAULT, notesStartingAt, type NoteClipRecord, type NoteEvent } from './clip-types';

/**
 * The lit cell (0..cells-1) of a `cells`-wide playhead strip for a clip of
 * `lengthSteps`, given the current sounding `step`. Floor-scaled so the WHOLE
 * clip maps onto the strip (owner spec: 16 lights = the whole clip, the playhead
 * advancing at clipLen/16 granularity — a 16-step clip lights one cell/step, a
 * 32-step clip every 2 steps, an 8-step clip every 2 cells). `floor` (not
 * `round`) keeps it monotonic (never jumps backward); wraps by `step mod len`.
 * For `len < cells` some cells are intentionally SKIPPED (sparse).
 */
export function playheadCell(step: number, lengthSteps: number, cells = 16): number {
  if (!Number.isFinite(step) || lengthSteps <= 0 || cells <= 0) return 0;
  const wrapped = ((Math.floor(step) % lengthSteps) + lengthSteps) % lengthSteps;
  const cell = Math.floor((wrapped / lengthSteps) * cells);
  return Math.max(0, Math.min(cells - 1, cell));
}

function clampVel(v: number | undefined): number {
  if (v == null || !Number.isFinite(v)) return VEL_DEFAULT;
  return Math.max(0, Math.min(127, Math.round(v)));
}

/**
 * TRUE-REPLACE punch: remove every note that STARTS on `step`. Called as the
 * record playhead enters a step (overdub OFF) so that pass's keypresses replace
 * the step's onset content. Notes that merely SPAN into `step` from an earlier
 * onset are left intact (only onsets are punched).
 */
export function clearStep(clip: NoteClipRecord, step: number): NoteClipRecord {
  if (!clip.steps.some((e) => e.step === step)) return clip;
  return { ...clip, steps: clip.steps.filter((e) => e.step !== step) };
}

/**
 * EXPLICIT ERASE — remove EVERY note in the clip (clear-clip gesture). Returns a
 * NEW empty-steps clip (unchanged reference when already empty, so callers can
 * skip the write). Preserves length/root/scale/div — only the notes are wiped.
 */
export function clearClip(clip: NoteClipRecord): NoteClipRecord {
  if (clip.steps.length === 0) return clip;
  return { ...clip, steps: [] };
}

/**
 * EXPLICIT ERASE — remove every note of a given PITCH across the whole clip (the
 * clear-row / erase-a-key gesture). Returns a NEW clip (unchanged reference when
 * that pitch isn't present).
 */
export function eraseRow(clip: NoteClipRecord, midi: number): NoteClipRecord {
  if (!clip.steps.some((e) => e.midi === midi)) return clip;
  return { ...clip, steps: clip.steps.filter((e) => e.midi !== midi) };
}

/**
 * EXPLICIT ERASE — remove the specific onset (`step`,`midi`) (the hold-to-erase
 * per-note gesture / a tap-off on a lit step). Returns a NEW clip (unchanged
 * reference when that onset isn't present). Distinct from `toggleNoteAt`, which
 * ADDS on a miss; this only ever removes.
 */
export function eraseNoteAt(clip: NoteClipRecord, step: number, midi: number): NoteClipRecord {
  const idx = clip.steps.findIndex((e) => e.step === step && e.midi === midi);
  if (idx < 0) return clip;
  return { ...clip, steps: clip.steps.filter((_, i) => i !== idx) };
}

export interface RecordNoteOpts {
  mono?: boolean;
  velocity?: number;
  maxVoices?: number;
}

/**
 * Record (ADD) a note onto `step`. Never toggles off. Returns a NEW clip
 * (unchanged reference when the note is dropped, so callers can skip a write).
 *  - MONO: first-note-priority — if the step already has ANY onset, drop.
 *  - POLY: add up to `maxVoices` (default POLY_CHANNEL_PAIRS); drop a pitch
 *    already present on the step (dedupe) and drop overflow past the cap.
 */
export function recordNoteAt(
  clip: NoteClipRecord,
  step: number,
  midi: number,
  opts: RecordNoteOpts = {},
): NoteClipRecord {
  const here = notesStartingAt(clip, step);
  if (opts.mono) {
    if (here.length > 0) return clip; // first-note-priority
  } else {
    const max = opts.maxVoices ?? POLY_CHANNEL_PAIRS;
    if (here.some((e) => e.midi === midi)) return clip; // dedupe pitch
    if (here.length >= max) return clip; // poly cap
  }
  const ev: NoteEvent = { step, midi, velocity: clampVel(opts.velocity), lengthSteps: 1 };
  return { ...clip, steps: [...clip.steps, ev] };
}

/**
 * Capture a held note's length on note-off. `offStep` is the step the release
 * landed on. Span = offStep − onStep + 1, WRAP-CLAMPED to the clip end when the
 * release wrapped past the loop point (offStep < onStep) or would run off the
 * end (review B4 — never a backwards `min/max` span). Min 1 step. Returns a NEW
 * clip (unchanged reference when the span is already correct or the onset is
 * gone).
 */
export function extendRecordedNote(
  clip: NoteClipRecord,
  onStep: number,
  midi: number,
  offStep: number,
): NoteClipRecord {
  const idx = clip.steps.findIndex((e) => e.step === onStep && e.midi === midi);
  if (idx < 0) return clip;
  const raw = offStep < onStep ? clip.lengthSteps - onStep : offStep - onStep + 1;
  const span = Math.max(1, Math.min(raw, clip.lengthSteps - onStep));
  const cur = clip.steps[idx]!;
  if ((cur.lengthSteps ?? 1) === span) return clip;
  const steps = clip.steps.slice();
  steps[idx] = { ...cur, lengthSteps: span };
  return { ...clip, steps };
}
