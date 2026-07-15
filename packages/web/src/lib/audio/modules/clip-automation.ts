// packages/web/src/lib/audio/modules/clip-automation.ts
//
// The clip-launcher AUTOMATION LANE orchestration layer (task #183) — PURE
// building blocks above the clip-types.ts record layer. Recording, playback,
// the card UI, and the launchpad binding all compose these; keeping them pure +
// unit-tested means the Y.Doc callers only have to do the in-place mutate (per
// `yjs-save-load-real-ydoc`).
//
// MIDI IDENTITY + THE LIMIT (owner directive, documented):
//   "assign a MIDI channel to anything mapped, OR re-use it if the thing is
//    already mapped to MIDI / Electra. This may impose a limit ... the limit
//    must be KNOWN and documented."
//   Scheme (MVP): ONE MIDI CHANNEL per automated param → 16 params max
//   (MAX_AUTOMATION_TRACKS). A param already bound to MIDI/Electra REUSES its
//   existing (channel, cc) instead of consuming a fresh channel; a fresh param
//   takes the lowest free channel with the canonical automation CC. When all 16
//   channels are taken, no further param can be automated (the KNOWN limit) —
//   the caller surfaces that to the user.

import {
  MAX_AUTOMATION_TRACKS,
  clampMidiChannel,
  clampMidiCc,
  sameAutomationTarget,
  findAutomationTrack,
  type AutomationClipRecord,
  type AutomationTarget,
  type AutomationTrack,
} from './clip-types';

/** MIDI (channel, cc) identity an automation track records + replays on. */
export interface MidiIdentity {
  channel: number; // 0..15
  cc: number; // 0..127
}

/** Canonical CC an auto-assigned automation track rides (scheme A makes the
 *  CHANNEL the unique identity, so the CC is a fixed, documented default —
 *  CC 1, mod wheel). A REUSED MIDI/Electra map keeps its own cc instead. */
export const AUTOMATION_DEFAULT_CC = 1;

/** Result of trying to add/reuse a track for a target. `track` is null ONLY
 *  when the 16-param limit is hit (no free channel / cap reached); the caller
 *  should surface "automation limit reached" to the user. `created` is true
 *  when a NEW track was added (vs. an existing one reused). */
export interface EnsureTrackResult {
  rec: AutomationClipRecord;
  track: AutomationTrack | null;
  created: boolean;
}

/** The set of MIDI channels currently consumed by a record's tracks, OPTIONALLY
 *  excluding the track for `exceptTarget` (so a re-assign can keep its own
 *  channel). */
export function usedAutomationChannels(
  rec: AutomationClipRecord,
  exceptTarget?: AutomationTarget,
): Set<number> {
  const used = new Set<number>();
  for (const t of rec.tracks) {
    if (exceptTarget && sameAutomationTarget(t.target, exceptTarget)) continue;
    used.add(t.channel);
  }
  return used;
}

/**
 * Choose the MIDI identity for an automated param.
 *  - `existing` (the control's current MIDI/Electra binding, or null): when
 *    present, REUSE it verbatim (clamped) — the automation rides the existing
 *    map and does NOT consume a fresh channel.
 *  - else assign the lowest channel not in `usedChannels`, with the canonical
 *    automation CC. Returns null when every channel 0..15 is taken (the limit).
 */
export function assignAutomationIdentity(
  existing: MidiIdentity | null,
  usedChannels: ReadonlySet<number>,
): MidiIdentity | null {
  if (existing) {
    return { channel: clampMidiChannel(existing.channel), cc: clampMidiCc(existing.cc) };
  }
  for (let ch = 0; ch < MAX_AUTOMATION_TRACKS; ch++) {
    if (!usedChannels.has(ch)) return { channel: ch, cc: AUTOMATION_DEFAULT_CC };
  }
  return null; // pool exhausted → the documented 16-param limit
}

/**
 * "Assign to automation lane" core: ensure a track exists for `target`.
 *  - If one already exists, REUSE it (no-op record, created=false) — re-arming
 *    an already-automated param records into its existing track (overdub).
 *  - Else pick an identity (reusing `existingMidi` if the control is already
 *    MIDI/Electra-mapped) and append a new empty track. When the limit is hit
 *    (pool exhausted OR tracks already at MAX_AUTOMATION_TRACKS), returns
 *    track=null and the record UNCHANGED.
 *
 * PURE — returns a new record; the Y.Doc caller mirrors by pushing the returned
 * track onto the live tracks array in place.
 */
export function ensureAutomationTrack(
  rec: AutomationClipRecord,
  target: AutomationTarget,
  existingMidi: MidiIdentity | null,
): EnsureTrackResult {
  const existingTrack = findAutomationTrack(rec, target);
  if (existingTrack) return { rec, track: existingTrack, created: false };

  if (rec.tracks.length >= MAX_AUTOMATION_TRACKS) {
    return { rec, track: null, created: false };
  }
  const identity = assignAutomationIdentity(existingMidi, usedAutomationChannels(rec));
  if (!identity) return { rec, track: null, created: false };

  const track: AutomationTrack = {
    target: { nodeId: target.nodeId, paramId: target.paramId },
    channel: identity.channel,
    cc: identity.cc,
    events: [],
  };
  return { rec: { ...rec, tracks: [...rec.tracks, track] }, track, created: true };
}

/** How many more params can still be automated (0 = at the KNOWN limit). Used
 *  by the UI to show remaining capacity / disable "Assign" when full. */
export function automationCapacityRemaining(rec: AutomationClipRecord): number {
  return Math.max(0, MAX_AUTOMATION_TRACKS - rec.tracks.length);
}
