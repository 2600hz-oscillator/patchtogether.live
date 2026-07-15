// packages/web/src/lib/audio/modules/clip-automation.ts
//
// The clip-launcher AUTOMATION LANE orchestration layer (task #183) — PURE
// building blocks above the clip-types.ts record layer. Recording, playback, the
// card UI, and the launchpad binding compose these; keeping them pure + unit-
// tested means the Y.Doc callers only do the in-place mutate (yjs-save-load-real-
// ydoc: commit the whole clip as a plain reassign, never splice the live Y.Array).
//
// Automation is CUSTOM parameter-envelope data (0..1 in the param's own domain),
// NOT MIDI — so a track is just a (nodeId, paramId) target + its breakpoints.
// A control already mapped to MIDI/Electra is unaffected: automation records the
// resulting PARAMETER value (what the mapping produced), through the same
// convergence seam, so an Electra twist is captured exactly like a screen twist.

import {
  MAX_AUTOMATION_TRACKS,
  findAutomationTrack,
  type AutomationClipRecord,
  type AutomationTarget,
  type AutomationTrack,
} from './clip-types';

/** Result of "Assign to automation lane". `track` is null ONLY when the sanity
 *  cap (MAX_AUTOMATION_TRACKS params) is already reached; the caller surfaces
 *  "automation full" to the user. `created` is true when a NEW empty track was
 *  added (vs. an existing one reused — re-assigning an already-automated param
 *  records into its existing track = overdub). */
export interface EnsureTrackResult {
  rec: AutomationClipRecord;
  track: AutomationTrack | null;
  created: boolean;
}

/**
 * "Assign to automation lane" core: ensure a track exists for `target`.
 *  - If one already exists, REUSE it (record unchanged, created=false).
 *  - Else append a new EMPTY track, unless already at MAX_AUTOMATION_TRACKS
 *    (then track=null, record unchanged).
 *
 * PURE — returns a NEW record; the Y.Doc caller mirrors by reassigning the whole
 * clip plain (never a live-Y.Array splice).
 */
export function ensureAutomationTrack(
  rec: AutomationClipRecord,
  target: AutomationTarget,
): EnsureTrackResult {
  const existing = findAutomationTrack(rec, target);
  if (existing) return { rec, track: existing, created: false };
  if (rec.tracks.length >= MAX_AUTOMATION_TRACKS) {
    return { rec, track: null, created: false };
  }
  const track: AutomationTrack = {
    target: { nodeId: target.nodeId, paramId: target.paramId },
    events: [],
  };
  return { rec: { ...rec, tracks: [...rec.tracks, track] }, track, created: true };
}

/** How many more params can still be automated (0 = at the sanity cap). Used by
 *  the UI to show remaining capacity / disable "Assign" when full. */
export function automationCapacityRemaining(rec: AutomationClipRecord): number {
  return Math.max(0, MAX_AUTOMATION_TRACKS - rec.tracks.length);
}
